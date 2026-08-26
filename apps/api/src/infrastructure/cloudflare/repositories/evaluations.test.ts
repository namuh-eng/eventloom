import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";

import type {
  EvaluationAssignment,
  EvaluationPlan,
  EvaluationReview,
  EvaluationSuggestion,
} from "../../../features/evaluations/types";
import {
  createSpeakerLifecycleFixture,
  speakerLifecycleIds,
} from "../../../test-support/speaker-lifecycle";
import { SqliteD1 } from "../../../test-support/sqlite-d1";
import { D1EvaluationRepository } from "./evaluations";

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), "apps/api/migrations", name), "utf8");
}

const fullEvaluationSchema = `
CREATE TABLE organizations (
  organization_id TEXT PRIMARY KEY NOT NULL
);
CREATE TABLE events (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ends_at TEXT,
  PRIMARY KEY (organization_id, id)
);
${migration("0009_evaluations.sql")}
`;

interface RecordedStatement {
  readonly sql: string;
  values: unknown[];
  bind(...values: unknown[]): RecordedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

class RecordingD1 {
  readonly statements: RecordedStatement[] = [];
  readonly batches: readonly RecordedStatement[][] = [];
  readonly firstRows: unknown[] = [];
  readonly allRows: unknown[][] = [];
  readonly sessionConstraints: string[] = [];

  withSession(constraint?: string) {
    this.sessionConstraints.push(constraint ?? "");
    return this;
  }

  prepare(sql: string): RecordedStatement {
    const database = this;
    const prepared: RecordedStatement = {
      sql,
      values: [],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        return (database.firstRows.shift() ?? null) as T | null;
      },
      async all<T>() {
        return { results: (database.allRows.shift() ?? []) as T[] };
      },
    };
    this.statements.push(prepared);
    return prepared;
  }

  async batch(statements: RecordedStatement[]) {
    (this.batches as RecordedStatement[][]).push(statements);
    return statements.map(() => ({
      results: this.allRows.shift() ?? [],
      meta: { changes: 1 },
    }));
  }
}

const timestamp = "2026-08-13T12:00:00.000Z";

function workspaceDatabase(reviewCount: number, scoresPerReview: number): RecordingD1 {
  const database = new RecordingD1();
  const assignmentRows = Array.from({ length: reviewCount }, (_, reviewIndex) => ({
    id: `assignment-${reviewIndex + 1}`,
    organization_id: "org-1",
    event_id: "event-1",
    plan_id: "plan-1",
    round_id: "round-1",
    submission_id: `submission-${reviewIndex + 1}`,
    reviewer_id: `reviewer-${reviewIndex + 1}`,
    status: reviewIndex === 0 ? "in_progress" : "submitted",
    predecessor_assignment_id: null,
    successor_assignment_id: null,
    superseded_reason: null,
    superseded_at: null,
    plan_version: 2,
    round_revision: 3,
    rubric_revision: 4,
    submission_revision: 5,
    version: reviewIndex + 1,
    created_at: timestamp,
    updated_at: timestamp,
  }));
  const reviewRows = Array.from({ length: reviewCount }, (_, reviewIndex) => ({
    id: `review-${reviewIndex + 1}`,
    organization_id: "org-1",
    event_id: "event-1",
    plan_id: "plan-1",
    round_id: "round-1",
    assignment_id: `assignment-${reviewIndex + 1}`,
    submission_id: `submission-${reviewIndex + 1}`,
    reviewer_id: `reviewer-${reviewIndex + 1}`,
    comment: reviewIndex === 0 ? "Draft" : "Submitted",
    submitted_at: reviewIndex === 0 ? null : timestamp,
    plan_revision: 2,
    round_revision: 3,
    rubric_revision: 4,
    submission_revision: 5,
    version: reviewIndex + 1,
    created_at: timestamp,
    updated_at: timestamp,
  }));
  const scoreRows = reviewRows.flatMap((reviewRow, reviewIndex) =>
    Array.from({ length: scoresPerReview }, (_, scoreIndex) => ({
      organization_id: "org-1",
      event_id: "event-1",
      review_id: reviewRow.id,
      criterion_id: `criterion-${scoreIndex + 1}`,
      value_number: scoreIndex === 0 ? null : scoreIndex + 3,
      value_text: scoreIndex === 0 ? "strong" : null,
      origin: "human",
      rubric_revision: 4,
      submission_revision: 5,
      updated_at: timestamp,
    })),
  );
  const evidenceRows = scoreRows.flatMap((scoreRow) => [
    { ...scoreRow, ordinal: 0, evidence: `${scoreRow.review_id}:${scoreRow.criterion_id}:first` },
    { ...scoreRow, ordinal: 1, evidence: `${scoreRow.review_id}:${scoreRow.criterion_id}:second` },
  ]);

  database.allRows.push(assignmentRows, reviewRows, [], scoreRows, evidenceRows);
  return database;
}

describe("D1EvaluationRepository organizer workspace hydration", () => {
  it("uses one plan-scoped session batch for export records", async () => {
    const database = workspaceDatabase(4, 3);

    const records = await new D1EvaluationRepository(
      database as unknown as D1Database,
    ).listOrganizerExportRecords("org-1", "event-1", "plan-1");

    expect(database.sessionConstraints).toEqual(["first-primary"]);
    expect(database.batches).toHaveLength(1);
    expect(database.batches[0]).toHaveLength(6);
    for (const prepared of database.batches[0] ?? []) {
      expect(prepared.values.slice(0, 3)).toEqual(["org-1", "event-1", "plan-1"]);
    }
    expect(records.assignments).toHaveLength(4);
    expect(records.reviews).toHaveLength(4);
    expect(Object.keys(records.reviews[3]?.scores ?? {})).toEqual([
      "criterion-1",
      "criterion-2",
      "criterion-3",
    ]);
  });

  it("uses a fixed five statements while preserving complete human review score hydration", async () => {
    const smallDatabase = workspaceDatabase(1, 1);
    const largeDatabase = workspaceDatabase(4, 3);

    const [small, large] = await Promise.all([
      new D1EvaluationRepository(
        smallDatabase as unknown as D1Database,
      ).listOrganizerWorkspaceRecords("org-1", "event-1"),
      new D1EvaluationRepository(
        largeDatabase as unknown as D1Database,
      ).listOrganizerWorkspaceRecords("org-1", "event-1"),
    ]);

    expect(smallDatabase.statements).toHaveLength(5);
    expect(largeDatabase.statements).toHaveLength(5);
    expect(large.assignments.map((item) => item.submissionId)).toEqual([
      "submission-1",
      "submission-2",
      "submission-3",
      "submission-4",
    ]);
    expect(large.reviews.map((item) => item.id)).toEqual([
      "review-1",
      "review-2",
      "review-3",
      "review-4",
    ]);
    expect(Object.keys(large.reviews[3]?.scores ?? {})).toEqual([
      "criterion-1",
      "criterion-2",
      "criterion-3",
    ]);
    expect(small.reviews[0]).toMatchObject({
      id: "review-1",
      comment: "Draft",
      submittedAt: null,
      scores: {
        "criterion-1": {
          value: "strong",
          origin: "human",
          evidence: ["review-1:criterion-1:first", "review-1:criterion-1:second"],
          rubricRevision: 4,
          submissionRevision: 5,
        },
      },
    });
    expect(large.reviews[1]).toMatchObject({ submittedAt: timestamp });

    for (const prepared of largeDatabase.statements) {
      expect(prepared.sql).toContain("organization_id = ?");
      expect(prepared.sql).toContain("event_id = ?");
      expect(prepared.values.slice(0, 2)).toEqual(["org-1", "event-1"]);
    }
    expect(largeDatabase.statements.map((prepared) => prepared.sql)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/evaluation_reviews[\s\S]*ORDER BY id/),
        expect.stringMatching(/evaluation_scores[\s\S]*ORDER BY review_id, criterion_id/),
        expect.stringMatching(
          /evaluation_score_evidence[\s\S]*ORDER BY review_id, criterion_id, ordinal/,
        ),
      ]),
    );
  });
});

describe("D1EvaluationRepository consistency", () => {
  it("reads evaluation plans from the primary for optimistic transitions", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);

    await repository.getPlan("org-1", "plan-1");

    expect(database.sessionConstraints).toEqual(["first-primary"]);
  });

  it("loads revision schedules in two primary-consistent queries without rubric hydration", async () => {
    const database = new RecordingD1();
    database.firstRows.push({
      id: "plan-1",
      organization_id: "org-1",
      event_id: "event-1",
      predecessor_plan_id: "plan-0",
      status: "open",
      closes_at: null,
      version: 3,
      updated_at: timestamp,
    });
    database.allRows.push([
      {
        id: "round-1",
        predecessor_round_id: "round-0",
        revision: 2,
        opens_at: "2026-08-10T00:00:00.000Z",
        closes_at: "2026-08-20T00:00:00.000Z",
      },
    ]);
    const repository = new D1EvaluationRepository(database as unknown as D1Database);

    await expect(repository.getPlanScheduleState("org-1", "plan-1")).resolves.toMatchObject({
      id: "plan-1",
      rounds: [{ id: "round-1", revision: 2 }],
    });
    expect(database.sessionConstraints).toEqual(["first-primary"]);
    expect(database.statements).toHaveLength(2);
    expect(database.statements.map((statement) => statement.sql).join("\n")).not.toContain(
      "rubric_criteria",
    );
  });

  it("reads assignments and reviews from the primary for reviewer writes", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);

    await repository.getAssignment("org-1", "assignment-1");
    await repository.getReview("org-1", "assignment-1");

    expect(database.sessionConstraints).toEqual(["first-primary", "first-primary"]);
  });

  it("lists assignments from the primary after distribution writes", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);

    await repository.listAssignments("org-1", "plan-1");

    expect(database.sessionConstraints).toEqual(["first-primary"]);
  });

  it("does not treat resolved new-round audit records as pending lineage repairs", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);

    database.firstRows.push(null);
    await expect(repository.hasPendingPlanLineageRepair("org-1", "event-1")).resolves.toBe(false);
    expect(database.statements[0]?.sql).toContain("reason <> 'resolved_new_round'");

    database.firstRows.push({ organization_id: "org-1" });
    await expect(repository.hasPendingPlanLineageRepair("org-1", "event-1")).resolves.toBe(true);
  });

  it("counts every non-resolved lineage marker as pending", async () => {
    const database = new SqliteD1("eventloom-pending-lineage-repairs-", fullEvaluationSchema);
    try {
      database.executeScript(migration("0035_review_plan_revision_lineage.sql"));
      database.executeScript(migration("0037_review_plan_lineage_repairs.sql"));
      database.executeScript(`
        INSERT INTO review_plan_lineage_repairs_required (
          organization_id, event_id, plan_id, round_id, reason
        ) VALUES (
          'org-1', 'event-1', 'plan-1', 'round-new', 'resolved_new_round'
        );
      `);
      const repository = new D1EvaluationRepository(database as unknown as D1Database);

      await expect(repository.hasPendingPlanLineageRepair("org-1", "event-1")).resolves.toBe(false);

      database.executeScript(`
        INSERT INTO review_plan_lineage_repairs_required (
          organization_id, event_id, plan_id, round_id, reason
        ) VALUES ('org-1', 'event-1', 'plan-1', '', 'missing_predecessor_plan');
      `);
      await expect(repository.hasPendingPlanLineageRepair("org-1", "event-1")).resolves.toBe(true);

      database.executeScript(`
        DELETE FROM review_plan_lineage_repairs_required
         WHERE organization_id = 'org-1'
           AND event_id = 'event-1'
           AND plan_id = 'plan-1'
           AND round_id = '';
        INSERT INTO review_plan_lineage_repairs_required (
          organization_id, event_id, plan_id, round_id, reason
        ) VALUES ('org-1', 'event-1', 'plan-1', 'round-1', 'missing_predecessor_round');
      `);
      await expect(repository.hasPendingPlanLineageRepair("org-1", "event-1")).resolves.toBe(true);
    } finally {
      database.dispose();
    }
  });

  it("atomically guards assignment distribution with the authoritative tip and schedule", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);

    await repository.applyAssignmentDistribution(
      {
        tenantId: "org-1",
        eventId: "event-1",
        planId: "plan-1",
        roundId: "round-1",
        planVersion: 1,
      },
      {
        assignments: [],
        expectedActiveVersions: [],
        reason: "Organizer updated reviewer assignments.",
        authorizedAt: timestamp,
      },
    );

    const sql = database.statements.map((recorded) => recorded.sql).join("\n");
    expect(sql).toContain("WITH RECURSIVE family");
    expect(sql).toContain("review_plan_lineage_repairs_required");
    expect(sql).toContain("repair.reason <> 'resolved_new_round'");
    expect(sql).toContain("round.closes_at");

    database.statements.length = 0;
    await repository.applyAssignmentDistribution(
      {
        tenantId: "org-1",
        eventId: "event-1",
        planId: "plan-1",
        roundId: "round-1",
        planVersion: 1,
      },
      {
        assignments: [],
        expectedActiveVersions: [],
        reason: "Organizer removed reviewer assignment.",
        authorizedAt: timestamp,
        allowClosedCleanup: true,
      },
    );

    const cleanupSql = database.statements.map((recorded) => recorded.sql).join("\n");
    expect(cleanupSql).toContain("WITH RECURSIVE family");
    expect(cleanupSql).toContain("review_plan_lineage_repairs_required");
    expect(cleanupSql).toContain("repair.reason <> 'resolved_new_round'");
    expect(cleanupSql).not.toContain("round.closes_at");
  });

  it("reads decisions from the primary for organizer transitions", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);

    await repository.getDecision("org-1", "plan-1", "submission-1");

    expect(database.sessionConstraints).toEqual(["first-primary"]);
  });

  it("updates plan state without rebuilding referenced rounds", async () => {
    const database = new RecordingD1();
    database.firstRows.push({
      id: "plan-1",
      organization_id: "org-1",
      event_id: "event-1",
      name: "Review",
      status: "draft",
      blind_review: 0,
      closes_at: null,
      reviews_per_submission: 1,
      max_assignments_per_reviewer: 5,
      track_filter: null,
      auto_distribute: 0,
      reviewer_projection_field_ids_json: "[]",
      reviewer_projection_file_ids_json: "[]",
      grading_revision: null,
      grading_locked_at: null,
      version: 2,
      created_at: timestamp,
      updated_at: timestamp,
    });
    database.allRows.push([]);
    const repository = new D1EvaluationRepository(database as unknown as D1Database);
    const plan = {
      id: "plan-1",
      tenantId: "org-1",
      eventId: "event-1",
      name: "Review",
      status: "open" as const,
      blindReview: false,
      closesAt: null,
      assignmentRule: {
        reviewsPerSubmission: 1,
        maxAssignmentsPerReviewer: 5,
        autoDistribute: false,
      },
      rounds: [],
      version: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await repository.putPlanState(plan, 2, []);

    const sql = database.batches[0]?.map((statement) => statement.sql).join("\n") ?? "";
    expect(sql).toContain("UPDATE review_plans");
    expect(sql).toContain("successor.predecessor_plan_id = p.id");
    expect(sql).not.toContain("DELETE FROM review_rounds");
    expect(sql).not.toContain("DELETE FROM review_rubrics");
    expect(sql).not.toContain("INSERT INTO review_rounds");
  });

  it("materializes a new immutable round revision before scheduling it", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);
    const plan = operationalPlan("plan-1", 3, "round-1", 2);

    await repository.putPlanState(plan, 2, [], false, "11111111-1111-4111-8111-111111111111");

    const sql = batchSql(database);
    expect(sql).toContain("INSERT OR IGNORE INTO review_rubrics");
    expect(sql).toContain("INSERT OR IGNORE INTO review_rounds");
  });

  it("deletes reviewer pool children before rebuilding draft rounds", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);

    await repository.putPlan(
      {
        id: "plan-1",
        tenantId: "org-1",
        eventId: "event-1",
        name: "Review",
        status: "draft",
        blindReview: false,
        closesAt: null,
        assignmentRule: {
          reviewsPerSubmission: 1,
          maxAssignmentsPerReviewer: 5,
          autoDistribute: false,
        },
        rounds: [],
        version: 2,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      1,
    );

    const sql = database.batches[0]?.map((statement) => statement.sql) ?? [];
    const memberDelete = sql.findIndex((value) =>
      value.includes("DELETE FROM reviewer_pool_members"),
    );
    const poolDelete = sql.findIndex((value) => value.includes("DELETE FROM reviewer_pools"));
    const roundDelete = sql.findIndex((value) => value.includes("DELETE FROM review_rounds"));

    expect(memberDelete).toBeGreaterThan(-1);
    expect(poolDelete).toBeGreaterThan(memberDelete);
    expect(roundDelete).toBeGreaterThan(poolDelete);
  });

  it("guards revision insertion against a concurrent predecessor successor", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);

    await repository.putPlan(
      {
        id: "plan-2",
        tenantId: "org-1",
        eventId: "event-1",
        predecessorPlanId: "plan-1",
        name: "Review revision",
        status: "draft",
        blindReview: false,
        closesAt: null,
        assignmentRule: {
          reviewsPerSubmission: 1,
          maxAssignmentsPerReviewer: 5,
          autoDistribute: false,
        },
        rounds: [],
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      null,
      {
        predecessorPlanId: "plan-1",
        expectedVersion: 3,
        lineageVersions: [
          { planId: "plan-1", expectedVersion: 3 },
          { planId: "plan-0", expectedVersion: 8 },
        ],
      },
    );

    const sql = database.batches[0]?.map((statement) => statement.sql).join("\n") ?? "";
    expect(sql).toContain("predecessor.status IN ('open', 'closed')");
    expect(sql).toContain("successor.predecessor_plan_id = predecessor.id");
    expect(database.statements.flatMap((entry) => entry.values)).toContain("plan-0");
  });
});
const assignment: EvaluationAssignment = {
  id: "assignment-1",
  tenantId: "org-1",
  eventId: "event-1",
  planId: "plan-1",
  roundId: "round-1",
  submissionId: "submission-1",
  reviewerId: "reviewer-1",
  status: "in_progress",
  planVersion: 2,
  roundRevision: 3,
  rubricRevision: 4,
  submissionRevision: 5,
  version: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const review: EvaluationReview = {
  id: "review-1",
  tenantId: "org-1",
  eventId: "event-1",
  planId: "plan-1",
  roundId: "round-1",
  assignmentId: "assignment-1",
  submissionId: "submission-1",
  reviewerId: "reviewer-1",
  scores: {
    criterion: {
      criterionId: "criterion",
      value: 4,
      origin: "human",
      evidence: ["Specific evidence"],
      rubricRevision: 4,
      submissionRevision: 5,
      updatedAt: timestamp,
    },
  },
  comment: "Draft",
  submittedAt: null,
  planRevision: 2,
  roundRevision: 3,
  rubricRevision: 4,
  submissionRevision: 5,
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function database() {
  return new RecordingD1();
}

function batchSql(db: RecordingD1, batchIndex = 0): string {
  return db.batches[batchIndex]?.map((item) => item.sql).join("\n") ?? "";
}

const operationalScheduleSchema = `
CREATE TABLE events (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  PRIMARY KEY (organization_id, id)
);
CREATE TABLE review_plans (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  predecessor_plan_id TEXT,
  revision_sync_pending INTEGER NOT NULL DEFAULT 0,
  revision_sync_token TEXT,
  status TEXT NOT NULL,
  closes_at TEXT,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE review_rounds (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  opens_at TEXT,
  closes_at TEXT,
  PRIMARY KEY (organization_id, event_id, plan_id, id, revision)
);
`;

function operationalPlan(
  id: string,
  version: number,
  roundId: string,
  roundRevision: number,
): EvaluationPlan {
  return {
    id,
    tenantId: "org-1",
    eventId: "event-1",
    name: "Review",
    status: "open",
    blindReview: false,
    closesAt: "2026-08-31T20:00:00-04:00",
    assignmentRule: {
      reviewsPerSubmission: 1,
      maxAssignmentsPerReviewer: 5,
      autoDistribute: false,
    },
    rounds: [
      {
        id: roundId,
        revision: roundRevision,
        name: "Initial",
        sequence: 1,
        opensAt: "2026-08-20T00:00:00.000Z",
        closesAt: "2026-08-31T00:00:00.000Z",
        rubric: { id: "rubric-1", name: "Initial", criteria: [] },
      },
    ],
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("D1EvaluationRepository compound CAS", () => {
  it("updates plan schedule without rebuilding preserved review state", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);
    const timestamp = "2026-08-13T00:00:00.000Z";
    await repository.putPlanSchedule(
      {
        id: "plan-1",
        tenantId: "org-1",
        eventId: "event-1",
        name: "Review",
        status: "open",
        blindReview: false,
        closesAt: "2026-08-31T20:00:00-04:00",
        assignmentRule: {
          reviewsPerSubmission: 1,
          maxAssignmentsPerReviewer: 5,
          autoDistribute: false,
        },
        rounds: [
          {
            id: "round-1",
            revision: 2,
            name: "Initial",
            sequence: 1,
            opensAt: "2026-08-20T00:00:00.000Z",
            closesAt: "2026-08-31T00:00:00.000Z",
            rubric: { id: "rubric-1", name: "Initial", criteria: [] },
          },
        ],
        version: 4,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      3,
      [
        {
          expectedVersion: 6,
          plan: {
            id: "plan-0",
            tenantId: "org-1",
            eventId: "event-1",
            status: "open",
            closesAt: "2026-08-31T20:00:00-04:00",
            rounds: [
              {
                id: "round-0",
                revision: 3,
                opensAt: "2026-08-20T00:00:00.000Z",
                closesAt: "2026-08-31T00:00:00.000Z",
              },
            ],
            version: 7,
            updatedAt: timestamp,
          },
        },
      ],
    );
    const sql = database.statements.map((entry) => entry.sql).join("\n");
    const values = database.statements.flatMap((entry) => entry.values);
    expect(database.batches).toHaveLength(1);
    expect(sql).toContain("UPDATE review_plans");
    expect(sql).toContain("successor.predecessor_plan_id = p.id");
    expect(sql).toContain("closes_at");
    expect(database.statements.find((entry) => entry.sql.includes("SET status"))?.values[1]).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(sql).toContain("UPDATE review_rounds");
    expect(sql).toContain("opens_at");
    expect(sql).toContain("revision = ?");
    expect(values).toContain("plan-1");
    expect(values).toContain("plan-0");
    expect(sql).not.toContain("DELETE FROM review_rounds");
    expect(sql).not.toContain("review_rubrics");
    expect(sql).not.toContain("review_assignments");
  });

  it("reconciles mapped ancestors without mutating the authoritative tip", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);
    const tip = {
      ...operationalPlan("plan-1", 4, "round-1", 2),
      predecessorPlanId: "plan-0",
      status: "closed" as const,
    };
    const ancestor = {
      ...operationalPlan("plan-0", 7, "round-0", 3),
      status: "closed" as const,
    };

    await repository.reconcilePlanRevisionFamily(
      tip,
      4,
      [{ plan: ancestor, expectedVersion: 6 }],
      "11111111-1111-4111-8111-111111111111",
    );

    const sql = database.statements.map((entry) => entry.sql).join("\n");
    const planUpdates = database.statements.filter((entry) =>
      entry.sql.includes("UPDATE review_plans"),
    );
    expect(database.batches).toHaveLength(1);
    expect(sql).toContain("successor.predecessor_plan_id = p.id");
    expect(planUpdates).toHaveLength(1);
    expect(planUpdates[0]?.values).toContain("plan-0");
    expect(planUpdates[0]?.values).not.toContain("plan-1");
  });

  it("chunks one oversized legacy ancestor under the authoritative tip guard", async () => {
    const database = new RecordingD1();
    const repository = new D1EvaluationRepository(database as unknown as D1Database);
    const tip = {
      ...operationalPlan("plan-1", 4, "round-1", 2),
      predecessorPlanId: "plan-0",
    };
    const ancestorBase = operationalPlan("plan-0", 7, "round-0", 3);
    const ancestorRound = ancestorBase.rounds[0];
    if (ancestorRound === undefined) throw new Error("Expected an ancestor round fixture.");
    const ancestor = {
      ...ancestorBase,
      rounds: Array.from({ length: 201 }, (_, index) => ({
        ...ancestorRound,
        id: `round-${index}`,
      })),
    };

    await repository.reconcilePlanRevisionFamily(
      tip,
      4,
      [{ plan: ancestor, expectedVersion: 6 }],
      "22222222-2222-4222-8222-222222222222",
    );

    expect(database.batches).toHaveLength(2);
    expect(
      database.batches[0]?.filter((entry) => entry.sql.includes("UPDATE review_rounds")),
    ).toHaveLength(200);
    expect(
      database.batches[1]?.filter((entry) => entry.sql.includes("UPDATE review_rounds")),
    ).toHaveLength(1);
    expect(database.batches[0]?.map((entry) => entry.sql).join("\n")).toContain(
      "successor.predecessor_plan_id = p.id",
    );
    expect(database.batches[1]?.map((entry) => entry.sql).join("\n")).toContain(
      "UPDATE review_plans",
    );
  });

  it("blocks successor insertion between oversized reconciliation batches", async () => {
    const database = new SqliteD1("eventloom-review-sync-lock-", fullEvaluationSchema);
    try {
      database.executeScript(migration("0035_review_plan_revision_lineage.sql"));
      database.executeScript(migration("0039_review_plan_revision_sync_lock.sql"));
      database.executeScript(migration("0040_review_plan_revision_sync_token.sql"));
      database.executeScript(`
        INSERT INTO organizations (organization_id) VALUES ('org-1');
        INSERT INTO events (organization_id, id, ends_at)
        VALUES ('org-1', 'event-1', '2026-09-30T23:59:00.000Z');
      `);
      const repository = new D1EvaluationRepository(database as unknown as D1Database);
      const rootBase = operationalPlan("plan-0", 2, "round-0", 2);
      const rootRound = rootBase.rounds[0];
      if (rootRound === undefined) throw new Error("Expected a root round fixture.");
      const root: EvaluationPlan = {
        ...rootBase,
        gradingRevision: 2,
        gradingLockedAt: timestamp,
        rounds: Array.from({ length: 201 }, (_, index) => ({
          ...rootRound,
          id: `root-round-${index}`,
          sequence: index + 1,
          rubric: {
            ...rootRound.rubric,
            id: `root-rubric-${index}`,
          },
        })),
      };
      const tip: EvaluationPlan = {
        ...root,
        id: "plan-1",
        predecessorPlanId: root.id,
        status: "closed",
        version: 4,
        rounds: root.rounds.map((round, index) => ({
          ...round,
          id: `tip-round-${index}`,
          predecessorRoundId: round.id,
          opensAt: "2026-08-21T00:00:00.000Z",
          closesAt: "2026-08-31T00:00:00.000Z",
          rubric: {
            ...round.rubric,
            id: `tip-rubric-${index}`,
          },
        })),
      };
      const roundRows = [...root.rounds, ...tip.rounds]
        .map(
          (round) =>
            `('${round.id}', 'org-1', 'event-1', '${
              round.predecessorRoundId === null || round.predecessorRoundId === undefined
                ? root.id
                : tip.id
            }', '${round.name}', ${round.sequence}, ${round.revision}, '${round.rubric.id}', ${
              round.rubricRevision ?? round.revision
            }, '${round.opensAt}', '${round.closesAt}', 0, 'none', NULL, ${
              round.predecessorRoundId === null || round.predecessorRoundId === undefined
                ? "NULL"
                : `'${round.predecessorRoundId}'`
            })`,
        )
        .join(",\n");
      database.executeScript(`
        INSERT INTO review_plans (
          organization_id, event_id, id, predecessor_plan_id, name, status,
          revision_sync_pending, blind_review, closes_at, reviews_per_submission,
          max_assignments_per_reviewer, track_filter, auto_distribute,
          reviewer_projection_field_ids_json, reviewer_projection_file_ids_json,
          grading_revision, grading_locked_at, version, created_at, updated_at
        ) VALUES
          (
            'org-1', 'event-1', '${root.id}', NULL, '${root.name}', 'open',
            0, 0, NULL, 1, 5, NULL, 0, '[]', '[]', 2, '${timestamp}',
            ${root.version}, '${timestamp}', '${timestamp}'
          ),
          (
            'org-1', 'event-1', '${tip.id}', '${root.id}', '${tip.name}', 'closed',
            0, 0, NULL, 1, 5, NULL, 0, '[]', '[]', 2, '${timestamp}',
            ${tip.version}, '${timestamp}', '${timestamp}'
          );
        INSERT INTO review_rounds (
          id, organization_id, event_id, plan_id, name, sequence, revision,
          rubric_id, rubric_revision, opens_at, closes_at, blind_review,
          anonymization, track_filter, predecessor_round_id
        ) VALUES ${roundRows};
      `);
      const closingTip = tip;
      const revisionSyncToken = "11111111-1111-4111-8111-111111111111";
      await repository.beginPlanRevisionSync(closingTip, closingTip.version, revisionSyncToken);
      await repository.beginPlanRevisionSync(closingTip, closingTip.version, revisionSyncToken);
      await expect(
        repository.beginPlanRevisionSync(
          closingTip,
          closingTip.version,
          "22222222-2222-4222-8222-222222222222",
        ),
      ).rejects.toThrow("Evaluation plan changed since it was loaded.");
      const reconciledRoot: EvaluationPlan = {
        ...root,
        status: "closed",
        rounds: root.rounds.map((round) => ({
          ...round,
          opensAt: "2026-08-21T00:00:00.000Z",
          closesAt: "2026-08-31T00:00:00.000Z",
        })),
        version: root.version + 1,
      };
      const successor: EvaluationPlan = {
        ...closingTip,
        id: "plan-2",
        predecessorPlanId: closingTip.id,
        status: "draft",
        gradingRevision: undefined,
        gradingLockedAt: null,
        version: 1,
        rounds: closingTip.rounds.map((round, index) => ({
          ...round,
          id: `successor-round-${index}`,
          predecessorRoundId: round.id,
          rubric: {
            ...round.rubric,
            id: `successor-rubric-${index}`,
          },
        })),
      };
      let insertion: Promise<void> | undefined;
      database.beforeNextBatch(() => {
        database.beforeNextBatch(() => {
          insertion = repository.putPlan(successor, null, {
            predecessorPlanId: closingTip.id,
            expectedVersion: closingTip.version,
            lineageVersions: [
              { planId: closingTip.id, expectedVersion: closingTip.version },
              { planId: root.id, expectedVersion: root.version },
            ],
          });
        });
      });

      await repository.reconcilePlanRevisionFamily(
        closingTip,
        closingTip.version,
        [{ plan: reconciledRoot, expectedVersion: root.version }],
        revisionSyncToken,
      );
      if (insertion === undefined) throw new Error("Expected an interleaved successor insertion.");
      await expect(insertion).rejects.toThrow("Evaluation plan changed since it was loaded.");
      await repository.completePlanRevisionSync(closingTip, closingTip.version, revisionSyncToken);

      const plans = await database
        .prepare(
          `SELECT id, status, version, revision_sync_pending
             FROM review_plans
            WHERE organization_id = 'org-1'
              AND id IN ('${root.id}', '${tip.id}', '${successor.id}')
            ORDER BY id`,
        )
        .all<{
          id: string;
          status: string;
          version: number;
          revision_sync_pending: number;
        }>();
      expect(plans.results).toEqual([
        {
          id: root.id,
          status: "closed",
          version: root.version + 1,
          revision_sync_pending: 0,
        },
        {
          id: tip.id,
          status: "closed",
          version: tip.version,
          revision_sync_pending: 0,
        },
      ]);
    } finally {
      database.dispose();
    }
  });

  it("updates only the current immutable round revision", async () => {
    const database = new SqliteD1("eventloom-review-schedule-", operationalScheduleSchema);
    try {
      database.executeScript(`
        INSERT INTO events VALUES (
          'org-1', 'event-1', 'Event', '2026-08-01T00:00:00.000Z',
          '2026-09-30T23:59:00.000Z', 'America/New_York'
        );
        INSERT INTO review_plans VALUES (
          'plan-1', 'org-1', 'event-1', NULL, 0, NULL, 'open', '2026-08-30T00:00:00.000Z', 3,
          '${timestamp}'
        );
        INSERT INTO review_rounds VALUES (
          'round-1', 1, 'org-1', 'event-1', 'plan-1',
          '2026-08-10T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
        );
        INSERT INTO review_rounds VALUES (
          'round-1', 2, 'org-1', 'event-1', 'plan-1',
          '2026-08-11T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
        );
      `);
      await new D1EvaluationRepository(database as unknown as D1Database).putPlanSchedule(
        operationalPlan("plan-1", 4, "round-1", 2),
        3,
        [],
      );

      const rounds = await database
        .prepare("SELECT revision, opens_at, closes_at FROM review_rounds ORDER BY revision")
        .all<{
          revision: number;
          opens_at: string;
          closes_at: string;
        }>();
      expect(rounds.results).toEqual([
        {
          revision: 1,
          opens_at: "2026-08-10T00:00:00.000Z",
          closes_at: "2026-08-20T00:00:00.000Z",
        },
        {
          revision: 2,
          opens_at: "2026-08-20T00:00:00.000Z",
          closes_at: "2026-08-31T00:00:00.000Z",
        },
      ]);
    } finally {
      database.dispose();
    }
  });

  it("batches tenant/event-scoped assignment and review guards before saving a draft", async () => {
    const db = database();
    await new D1EvaluationRepository(db as unknown as D1Database).saveReviewDraft(
      assignment,
      1,
      review,
      null,
      timestamp,
    );

    expect(db.batches).toHaveLength(1);
    expect(batchSql(db)).toContain(
      "organization_id = ? AND event_id = ? AND id = ? AND version = ?",
    );
    expect(batchSql(db)).toContain("WITH RECURSIVE family");
    expect(batchSql(db)).toContain("tip.revision_sync_pending = 0");
    expect(batchSql(db)).toContain("review_plan_lineage_repairs_required");
    expect(batchSql(db)).toContain("assignment.status IN ('assigned', 'in_progress')");
    expect(batchSql(db)).toContain("round.opens_at IS NULL OR round.opens_at <= ?");
    expect(batchSql(db)).toContain("round.closes_at IS NULL OR round.closes_at > ?");
    expect(batchSql(db)).toContain("organization_id = ? AND assignment_id = ?");
    expect(batchSql(db)).toContain("INSERT INTO evaluation_reviews");
    expect(batchSql(db)).toContain("INSERT INTO evaluation_scores");
    expect(batchSql(db)).toContain("INSERT INTO evaluation_score_evidence");
    const assignmentGuard = db.batches[0]?.find((entry) =>
      entry.sql.includes("review_assignments"),
    );
    expect(assignmentGuard?.values.slice(0, 4)).toEqual(["org-1", "event-1", "assignment-1", 1]);
  });

  it("batches the compound review authority guard before every review write", async () => {
    const db = database();
    await new D1EvaluationRepository(db as unknown as D1Database).writeReview({
      authority: {
        tenantId: assignment.tenantId,
        eventId: assignment.eventId,
        planId: assignment.planId,
        roundId: assignment.roundId,
        assignmentId: assignment.id,
        submissionId: assignment.submissionId,
        reviewerId: assignment.reviewerId,
        expectedAssignmentVersion: assignment.version,
      },
      review,
      expectedReviewVersion: null,
      assignmentUpdate: {
        ...assignment,
        status: "in_progress",
        version: assignment.version + 1,
      },
    });

    expect(db.batches).toHaveLength(1);
    const guard = db.batches[0]?.[0];
    expect(guard?.sql).toContain("D1_CAS_CONFLICT");
    expect(batchSql(db)).toContain("status IN ('assigned', 'in_progress')");
    expect(batchSql(db)).toContain("FROM evaluation_conflicts");
    expect(batchSql(db)).toContain("FROM submissions");
    expect(batchSql(db)).toContain("status = 'submitted'");
    expect(batchSql(db)).toContain("FROM submission_versions");
    expect(batchSql(db)).toContain("FROM review_plans");
    expect(batchSql(db)).toContain("FROM review_rounds");
    expect(batchSql(db)).toContain("FROM evaluation_decisions");
    expect(batchSql(db)).toContain("INSERT INTO evaluation_reviews");
    expect(batchSql(db)).toContain("UPDATE review_assignments");
    expect(guard?.values).toEqual([
      "org-1",
      "event-1",
      "plan-1",
      "round-1",
      "submission-1",
      "assignment-1",
      "reviewer-1",
      2,
      "org-1",
      "event-1",
      "assignment-1",
      "org-1",
      "event-1",
      "submission-1",
      "org-1",
      "event-1",
      "submission-1",
      "org-1",
      "event-1",
      "submission-1",
      5,
      "org-1",
      "event-1",
      "plan-1",
      2,
      2,
      timestamp,
      "org-1",
      "event-1",
      "plan-1",
      "round-1",
      3,
      4,
      timestamp,
      timestamp,
      "org-1",
      "event-1",
      "plan-1",
      "submission-1",
    ]);
  });

  it("uses one tenant-scoped guard for assignment abstention and conflict insertion", async () => {
    const db = database();
    await new D1EvaluationRepository(db as unknown as D1Database).abstainAssignment(
      { ...assignment, status: "abstained" },
      1,
      {
        id: "conflict-1",
        tenantId: "org-1",
        eventId: "event-1",
        planId: "plan-1",
        assignmentId: "assignment-1",
        submissionId: "submission-1",
        reviewerId: "reviewer-1",
        reason: "Prior collaboration",
        declaredAt: timestamp,
      },
    );

    expect(db.batches).toHaveLength(1);
    expect(batchSql(db)).toMatch(/EXISTS \(\s*SELECT 1 FROM review_assignments/u);
    expect(batchSql(db)).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM evaluation_conflicts/u);
    expect(batchSql(db)).toContain("INSERT INTO evaluation_conflicts");
  });

  it("tenant-scopes plan, assignment, review, suggestion, conflict, and decision reads", async () => {
    const db = database();
    const repository = new D1EvaluationRepository(db as unknown as D1Database);
    await repository.getPlan("org-1", "plan-1");
    await repository.getAssignment("org-1", "assignment-1");
    await repository.getReview("org-1", "assignment-1");
    await repository.getSuggestion("org-1", "suggestion-1");
    await repository.getConflict("org-1", "assignment-1");
    await repository.getDecision("org-1", "plan-1", "submission-1");

    for (const prepared of db.statements) {
      expect(prepared.sql).toContain("organization_id = ?");
      expect(prepared.values[0]).toBe("org-1");
    }
  });
});

const migratedSuggestion: EvaluationSuggestion = {
  id: "suggestion-migrated-1",
  tenantId: speakerLifecycleIds.organizationId,
  eventId: speakerLifecycleIds.eventId,
  planId: "plan-migrated-1",
  roundId: "round-migrated-1",
  assignmentId: null,
  submissionId: speakerLifecycleIds.acceptedSubmissionId,
  reviewerId: "organizer-migrated-1",
  rubricRevision: 1,
  submissionRevision: 1,
  criterionCandidates: [],
  candidates: {},
  provenance: {
    provider: "provider",
    model: "model",
    generatedAt: timestamp,
    sourceReferences: [],
  },
  status: "pending",
  version: 1,
  history: [],
  audit: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};

const migratedReview: EvaluationReview = {
  ...review,
  id: "review-migrated-1",
  tenantId: speakerLifecycleIds.organizationId,
  eventId: speakerLifecycleIds.eventId,
  planId: "plan-migrated-1",
  roundId: "round-migrated-1",
  assignmentId: "assignment-migrated-1",
  submissionId: speakerLifecycleIds.acceptedSubmissionId,
  reviewerId: "reviewer-migrated-1",
  planRevision: 1,
  roundRevision: 1,
  rubricRevision: 1,
  submissionRevision: 1,
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function seedMigratedEvaluationAssignment(
  database: ReturnType<typeof createSpeakerLifecycleFixture>["database"],
): void {
  database.executeScript(`
    INSERT INTO review_plans (
      id, organization_id, event_id, name, status, blind_review,
      reviews_per_submission, max_assignments_per_reviewer, auto_distribute,
      reviewer_projection_field_ids_json, reviewer_projection_file_ids_json,
      version, revision_sync_pending, created_at, updated_at
    ) VALUES (
      '${migratedSuggestion.planId}', '${migratedSuggestion.tenantId}',
      '${migratedSuggestion.eventId}', 'Migrated review', 'open', 0,
      1, 5, 0, '[]', '[]', 1, 0, '${timestamp}', '${timestamp}'
    );
    INSERT INTO review_rounds (
      id, organization_id, event_id, plan_id, name, sequence, revision,
      rubric_id, rubric_revision, blind_review, anonymization
    ) VALUES (
      '${migratedSuggestion.roundId}', '${migratedSuggestion.tenantId}',
      '${migratedSuggestion.eventId}', '${migratedSuggestion.planId}',
      'Migrated round', 0, 1, 'rubric-migrated-1', 1, 0, 'none'
    );
    INSERT INTO submission_versions (
      organization_id, event_id, submission_id, version, reason,
      actor_id, idempotency_key, snapshot_json, created_at
    ) VALUES (
      '${migratedSuggestion.tenantId}', '${migratedSuggestion.eventId}',
      '${migratedSuggestion.submissionId}', 1, 'draft_created',
      'reviewer-migrated-1', NULL, '{}', '${timestamp}'
    );
    INSERT INTO review_assignments (
      id, organization_id, event_id, plan_id, round_id, round_revision,
      submission_id, reviewer_id, status, plan_version, rubric_revision,
      submission_revision, version, created_at, updated_at
    ) VALUES (
      '${migratedSuggestion.assignmentId}', '${migratedSuggestion.tenantId}',
      '${migratedSuggestion.eventId}', '${migratedSuggestion.planId}',
      '${migratedSuggestion.roundId}', 1, '${migratedSuggestion.submissionId}',
      '${migratedSuggestion.reviewerId}', 'in_progress', 1, 1, 1, 1,
      '${timestamp}', '${timestamp}'
    );
  `);
}

describe("D1EvaluationRepository migrated lifecycle CAS", () => {
  it("persists a suggestion through the migrated submissions.id guard", async () => {
    const fixture = createSpeakerLifecycleFixture();
    try {
      seedMigratedEvaluationAssignment(fixture.database);
      const repository = new D1EvaluationRepository(fixture.database as unknown as D1Database);
      await repository.putSuggestion(migratedSuggestion, null, 1);

      await expect(
        repository.getSuggestion(migratedSuggestion.tenantId, migratedSuggestion.id),
      ).resolves.toMatchObject({
        id: migratedSuggestion.id,
        status: "pending",
      });
    } finally {
      fixture.dispose();
    }
  });

  it("allows a fresh shared suggestion after the previous one becomes stale", async () => {
    const fixture = createSpeakerLifecycleFixture();
    try {
      seedMigratedEvaluationAssignment(fixture.database);
      const repository = new D1EvaluationRepository(fixture.database as unknown as D1Database);
      await repository.putSuggestion(migratedSuggestion, null, 1);
      const staled: EvaluationSuggestion = {
        ...migratedSuggestion,
        status: "stale",
        version: migratedSuggestion.version + 1,
        updatedAt: timestamp,
      };
      await repository.putSuggestion(staled, migratedSuggestion.version, 1, true);
      const replacement: EvaluationSuggestion = {
        ...migratedSuggestion,
        id: "suggestion-migrated-replacement",
        status: "pending",
      };

      await expect(repository.putSuggestion(replacement, null, 1)).resolves.toBeUndefined();
      await expect(
        repository.getSuggestion(migratedSuggestion.tenantId, replacement.id),
      ).resolves.toMatchObject({ id: replacement.id, status: "pending" });
    } finally {
      fixture.dispose();
    }
  });

  it("rejects a second active shared suggestion for the same triage scope", async () => {
    const fixture = createSpeakerLifecycleFixture();
    try {
      seedMigratedEvaluationAssignment(fixture.database);
      const repository = new D1EvaluationRepository(fixture.database as unknown as D1Database);
      await repository.putSuggestion(migratedSuggestion, null, 1);
      const duplicate = { ...migratedSuggestion, id: "suggestion-migrated-2" };

      await expect(repository.putSuggestion(duplicate, null, 1)).rejects.toThrow();
      await expect(
        repository.getSuggestion(migratedSuggestion.tenantId, duplicate.id),
      ).resolves.toBeNull();
    } finally {
      fixture.dispose();
    }
  });

  it("persists no suggestion when withdrawal commits immediately before the D1 batch", async () => {
    const fixture = createSpeakerLifecycleFixture();
    try {
      seedMigratedEvaluationAssignment(fixture.database);
      const repository = new D1EvaluationRepository(fixture.database as unknown as D1Database);
      fixture.database.beforeNextBatch(() => {
        fixture.database.run(
          `UPDATE submissions
           SET status = 'withdrawn', version = version + 1, updated_at = '${timestamp}'
           WHERE organization_id = '${migratedSuggestion.tenantId}'
             AND event_id = '${migratedSuggestion.eventId}'
             AND id = '${migratedSuggestion.submissionId}'`,
        );
      });

      await expect(repository.putSuggestion(migratedSuggestion, null, 1)).rejects.toThrow();
      await expect(
        repository.getSuggestion(migratedSuggestion.tenantId, migratedSuggestion.id),
      ).resolves.toBeNull();
    } finally {
      fixture.dispose();
    }
  });

  it("persists no review when withdrawal commits immediately before the D1 batch", async () => {
    const fixture = createSpeakerLifecycleFixture();
    try {
      seedMigratedEvaluationAssignment(fixture.database);
      const repository = new D1EvaluationRepository(fixture.database as unknown as D1Database);
      fixture.database.beforeNextBatch(() => {
        fixture.database.run(
          `UPDATE submissions
           SET status = 'withdrawn', version = version + 1, updated_at = '${timestamp}'
           WHERE organization_id = '${migratedReview.tenantId}'
             AND event_id = '${migratedReview.eventId}'
             AND id = '${migratedReview.submissionId}'`,
        );
      });

      await expect(
        repository.writeReview({
          authority: {
            tenantId: migratedReview.tenantId,
            eventId: migratedReview.eventId,
            planId: migratedReview.planId,
            roundId: migratedReview.roundId,
            assignmentId: migratedReview.assignmentId,
            submissionId: migratedReview.submissionId,
            reviewerId: migratedReview.reviewerId,
            expectedAssignmentVersion: 1,
          },
          review: migratedReview,
          expectedReviewVersion: null,
          assignmentUpdate: {
            ...assignment,
            id: migratedReview.assignmentId,
            tenantId: migratedReview.tenantId,
            eventId: migratedReview.eventId,
            planId: migratedReview.planId,
            roundId: migratedReview.roundId,
            submissionId: migratedReview.submissionId,
            reviewerId: migratedReview.reviewerId,
            status: "in_progress",
            version: 2,
          },
        }),
      ).rejects.toThrow();
      await expect(
        repository.getReview(migratedReview.tenantId, migratedReview.assignmentId),
      ).resolves.toBeNull();
    } finally {
      fixture.dispose();
    }
  });
});
