import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

import { conflict } from "../../../features/evaluations/errors";
import type {
  EvaluationPlanRevisionPrecondition,
  EvaluationPlanScheduleState,
  EvaluationPlanScheduleSync,
  EvaluationRepository,
  EvaluationReviewWriteAdmission,
  OrganizerWorkspaceRecords,
  ReviewerWorkspaceRecords,
  WriteEvaluationReview,
} from "../../../features/evaluations/repository";
import type {
  EvaluationAssignment,
  EvaluationAssignmentDistributionInput,
  EvaluationAssignmentDistributionResult,
  EvaluationAssignmentReplacementInput,
  EvaluationAssignmentReplacementResult,
  EvaluationAssignmentScope,
  EvaluationConflictDeclaration,
  EvaluationDecision,
  EvaluationDecisionTransition,
  EvaluationPlan,
  EvaluationReview,
  EvaluationReviewHistory,
  EvaluationSuggestion,
  EvaluationSuggestionAuditEntry,
  EvaluationSuggestionCandidate,
  ReviewRound,
  RubricCriterion,
  RubricScore,
} from "../../../features/evaluations/types";
import type { CloudflareOutboxMessage } from "../bindings";
import {
  evaluationDecisionOutboxJobId,
  evaluationDecisionWorkKey,
  evaluationDecisionWorkPayload,
  publishEvaluationDecisionJob,
} from "../evaluation-decision-outbox";
import {
  batch,
  booleanValue,
  type D1Value,
  guard,
  insertGuard,
  json,
  parseJson,
  rows,
  stableSort,
  statement,
  updateGuard,
} from "./shared";

interface Row extends Record<string, unknown> {}
type D1ReadDatabase = Pick<D1Database, "prepare">;
const MAX_RECONCILIATION_ROUNDS_PER_BATCH = 200;

const text = (value: unknown): string => String(value);
const nullableText = (value: unknown): string | null => (value == null ? null : String(value));
const numberValue = (value: unknown): number => Number(value);
const optionalNumber = (value: unknown): number | undefined =>
  value == null ? undefined : Number(value);
const bool = (value: unknown): boolean => booleanValue(value as number | boolean);

function assignmentMatchesScope(
  assignment: EvaluationAssignment,
  scope: EvaluationAssignmentScope,
): boolean {
  return (
    assignment.tenantId === scope.tenantId &&
    assignment.eventId === scope.eventId &&
    assignment.planId === scope.planId &&
    assignment.roundId === scope.roundId &&
    (scope.submissionId === undefined || assignment.submissionId === scope.submissionId) &&
    (scope.planVersion === undefined || assignment.planVersion === scope.planVersion)
  );
}

function writeConflict(message: string): never {
  throw conflict(message);
}

async function atomic(
  database: D1Database,
  statements: readonly D1PreparedStatement[],
  message: string,
): Promise<void> {
  try {
    await batch(database, statements);
  } catch (error) {
    console.error("Evaluation repository atomic write failed.", {
      error: error instanceof Error ? error.message : String(error),
      statementCount: statements.length,
    });
    writeConflict(message);
  }
}

function sharedSuggestionGuard(
  database: D1Database,
  suggestion: EvaluationSuggestion,
  expectedSubmissionRevision: number = suggestion.submissionRevision,
): D1PreparedStatement {
  return guard(
    database,
    `EXISTS (
        SELECT 1 FROM submissions
        WHERE organization_id = ? AND event_id = ? AND id = ?
          AND status = 'submitted'
      )
      AND EXISTS (
        SELECT 1 FROM submission_versions
        WHERE organization_id = ? AND event_id = ? AND submission_id = ?
          AND version = (
            SELECT MAX(version) FROM submission_versions
            WHERE organization_id = ? AND event_id = ? AND submission_id = ?
          )
          AND version = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM evaluation_decisions
        WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND submission_id = ?
    )`,
    [
      suggestion.tenantId,
      suggestion.eventId,
      suggestion.submissionId,
      suggestion.tenantId,
      suggestion.eventId,
      suggestion.submissionId,
      suggestion.tenantId,
      suggestion.eventId,
      suggestion.submissionId,
      expectedSubmissionRevision,
      suggestion.tenantId,
      suggestion.eventId,
      suggestion.planId,
      suggestion.submissionId,
    ],
  );
}

function reviewWriteAuthorityGuard(
  database: D1Database,
  input: WriteEvaluationReview,
): D1PreparedStatement {
  const { authority } = input;
  const planVersion =
    input.authority.expectedPlanVersion ??
    input.review.planVersion ??
    input.review.planRevision ??
    1;
  const planRevision = input.review.planRevision ?? input.review.planVersion ?? 1;
  const roundRevision = input.review.roundRevision ?? input.review.rubricRevision ?? 1;
  const rubricRevision = input.review.rubricRevision ?? input.review.rubricVersion ?? 1;
  const submissionRevision = input.review.submissionRevision ?? input.review.submissionVersion ?? 1;
  const reviewTimestamp = input.review.updatedAt;
  return guard(
    database,
    `EXISTS (
      SELECT 1 FROM review_assignments
      WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND round_id = ?
        AND submission_id = ? AND id = ? AND reviewer_id = ? AND version = ?
        AND status IN ('assigned', 'in_progress')
    )
    AND NOT EXISTS (
      SELECT 1 FROM evaluation_conflicts
      WHERE organization_id = ? AND event_id = ? AND assignment_id = ?
    )
    AND EXISTS (
      SELECT 1 FROM submissions
      WHERE organization_id = ? AND event_id = ? AND id = ?
        AND status = 'submitted'
    )
    AND EXISTS (
      SELECT 1 FROM submission_versions
      WHERE organization_id = ? AND event_id = ? AND submission_id = ?
        AND version = (
          SELECT MAX(version) FROM submission_versions
          WHERE organization_id = ? AND event_id = ? AND submission_id = ?
        )
        AND version = ?
    )
    AND EXISTS (
      SELECT 1 FROM review_plans
      WHERE organization_id = ? AND event_id = ? AND id = ?
        AND status = 'open' AND version = ?
        AND COALESCE(grading_revision, version) = ?
        AND (closes_at IS NULL OR closes_at > ?)
    )
    AND EXISTS (
      SELECT 1 FROM review_rounds
      WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND id = ?
        AND revision = ? AND rubric_revision = ?
        AND (opens_at IS NULL OR opens_at <= ?)
        AND (closes_at IS NULL OR closes_at > ?)
    )
    AND NOT EXISTS (
      SELECT 1 FROM evaluation_decisions
      WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND submission_id = ?
    )`,
    [
      authority.tenantId,
      authority.eventId,
      authority.planId,
      authority.roundId,
      authority.submissionId,
      authority.assignmentId,
      authority.reviewerId,
      authority.expectedAssignmentVersion,
      authority.tenantId,
      authority.eventId,
      authority.assignmentId,
      authority.tenantId,
      authority.eventId,
      authority.submissionId,
      authority.tenantId,
      authority.eventId,
      authority.submissionId,
      authority.tenantId,
      authority.eventId,
      authority.submissionId,
      submissionRevision,
      authority.tenantId,
      authority.eventId,
      authority.planId,
      planVersion,
      planRevision,
      reviewTimestamp,
      authority.tenantId,
      authority.eventId,
      authority.planId,
      authority.roundId,
      roundRevision,
      rubricRevision,
      reviewTimestamp,
      reviewTimestamp,
      authority.tenantId,
      authority.eventId,
      authority.planId,
      authority.submissionId,
    ],
  );
}

function canonicalPlanBoundaries<T extends EvaluationPlan | EvaluationPlanScheduleState>(
  plan: T,
): T {
  const canonical = (value: string | null | undefined): string | null | undefined => {
    if (value === null || value === undefined) return value;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) writeConflict("Evaluation plan contains an invalid boundary.");
    return new Date(timestamp).toISOString();
  };
  return {
    ...plan,
    closesAt: canonical(plan.closesAt) ?? null,
    rounds: plan.rounds.map((round) => ({
      ...round,
      ...(round.opensAt === undefined ? {} : { opensAt: canonical(round.opensAt) }),
      closesAt: canonical(round.closesAt) ?? null,
    })),
  } as T;
}

function latestPlanBoundary(plan: EvaluationPlan): string | null {
  const boundaries = [
    plan.closesAt,
    ...plan.rounds.flatMap((round) => [round.opensAt, round.closesAt]),
  ].filter((value): value is string => value != null);
  return boundaries.sort((left, right) => right.localeCompare(left))[0] ?? null;
}

function planTipGuard(
  database: D1Database,
  plan: EvaluationPlan,
  expectedVersion: number,
  allowPending = false,
): D1PreparedStatement {
  return guard(
    database,
    `EXISTS (
       SELECT 1
         FROM review_plans p
        WHERE p.organization_id = ?
          AND p.event_id = ?
          AND p.id = ?
          AND p.version = ?
          ${allowPending ? "" : "AND p.revision_sync_pending = 0"}
          AND NOT EXISTS (
            SELECT 1
              FROM review_plans successor
             WHERE successor.organization_id = p.organization_id
               AND successor.event_id = p.event_id
               AND successor.predecessor_plan_id = p.id
          )
     )`,
    [plan.tenantId, plan.eventId, plan.id, expectedVersion],
  );
}

function planRevisionSyncGuard(
  database: D1Database,
  tip: EvaluationPlan,
  expectedVersion: number,
  revisionSyncToken: string,
  allowCompleted = false,
): D1PreparedStatement {
  return guard(
    database,
    `EXISTS (
       SELECT 1
         FROM review_plans p
        WHERE p.organization_id = ?
          AND p.event_id = ?
          AND p.id = ?
          AND p.version = ?
          ${allowCompleted ? "" : "AND p.revision_sync_pending = 1"}
          AND p.revision_sync_token = ?
          AND NOT EXISTS (
            SELECT 1
              FROM review_plans successor
             WHERE successor.organization_id = p.organization_id
               AND successor.event_id = p.event_id
               AND successor.predecessor_plan_id = p.id
          )
     )`,
    [tip.tenantId, tip.eventId, tip.id, expectedVersion, revisionSyncToken],
  );
}

function assignmentWriteScheduleGuard(
  database: D1Database,
  scope: EvaluationAssignmentScope,
  authorizedAt: string,
  requireRoundOpen: boolean,
): D1PreparedStatement {
  return guard(
    database,
    `EXISTS (
       SELECT 1
         FROM review_plans plan
         JOIN review_rounds round
           ON round.organization_id = plan.organization_id
          AND round.event_id = plan.event_id
          AND round.plan_id = plan.id
          AND round.id = ?
          AND round.revision = (
            SELECT MAX(current_round.revision)
              FROM review_rounds current_round
             WHERE current_round.organization_id = round.organization_id
               AND current_round.event_id = round.event_id
               AND current_round.plan_id = round.plan_id
               AND current_round.id = round.id
          )
        WHERE plan.organization_id = ?
          AND plan.event_id = ?
          AND plan.id = ?
          AND plan.status = 'open'
          AND (plan.closes_at IS NULL OR plan.closes_at > ?)
          ${requireRoundOpen ? "AND (round.opens_at IS NULL OR round.opens_at <= ?)" : ""}
          AND (round.closes_at IS NULL OR round.closes_at > ?)
     )`,
    [
      scope.roundId,
      scope.tenantId,
      scope.eventId,
      scope.planId,
      authorizedAt,
      ...(requireRoundOpen ? [authorizedAt] : []),
      authorizedAt,
    ],
  );
}

function authoritativePlanWritableGuard(
  database: D1Database,
  scope: Pick<EvaluationAssignment, "tenantId" | "eventId" | "planId">,
  allowClosed = false,
): D1PreparedStatement {
  return guard(
    database,
    `EXISTS (
       WITH RECURSIVE family(id, status, revision_sync_pending, depth) AS (
         SELECT id, status, revision_sync_pending, 0
           FROM review_plans
          WHERE organization_id = ?
            AND event_id = ?
            AND id = ?
         UNION ALL
         SELECT successor.id, successor.status, successor.revision_sync_pending, family.depth + 1
           FROM family
           JOIN review_plans successor
             ON successor.organization_id = ?
            AND successor.event_id = ?
            AND successor.predecessor_plan_id = family.id
          WHERE family.depth < 16
       )
       SELECT 1
         FROM family tip
        WHERE ${allowClosed ? "" : "tip.status = 'open' AND"}
          tip.revision_sync_pending = 0
          AND NOT EXISTS (
            SELECT 1
              FROM review_plan_lineage_repairs_required repair
             WHERE repair.organization_id = ?
               AND repair.event_id = ?
               AND repair.reason <> 'resolved_new_round'
          )
          AND NOT EXISTS (
            SELECT 1
              FROM review_plans successor
             WHERE successor.organization_id = ?
               AND successor.event_id = ?
               AND successor.predecessor_plan_id = tip.id
               AND successor.status <> 'draft'
          )
     )`,
    [
      scope.tenantId,
      scope.eventId,
      scope.planId,
      scope.tenantId,
      scope.eventId,
      scope.tenantId,
      scope.eventId,
      scope.tenantId,
      scope.eventId,
    ],
  );
}

function reviewWriteAdmissionGuard(
  database: D1Database,
  admission: EvaluationReviewWriteAdmission,
): D1PreparedStatement {
  const assignment = admission.assignment;
  return guard(
    database,
    `EXISTS (
       SELECT 1
         FROM review_assignments assignment
         JOIN review_plans plan
           ON plan.organization_id = assignment.organization_id
          AND plan.event_id = assignment.event_id
          AND plan.id = assignment.plan_id
         JOIN review_rounds round
           ON round.organization_id = assignment.organization_id
          AND round.event_id = assignment.event_id
          AND round.plan_id = assignment.plan_id
          AND round.id = assignment.round_id
          AND round.revision = (
            SELECT MAX(current_round.revision)
              FROM review_rounds current_round
             WHERE current_round.organization_id = assignment.organization_id
               AND current_round.event_id = assignment.event_id
               AND current_round.plan_id = assignment.plan_id
               AND current_round.id = assignment.round_id
          )
        WHERE assignment.organization_id = ?
          AND assignment.event_id = ?
          AND assignment.id = ?
          AND assignment.version = ?
          AND assignment.status IN ('assigned', 'in_progress')
          AND assignment.plan_id = ?
          AND assignment.round_id = ?
          AND assignment.submission_id = ?
          AND assignment.reviewer_id = ?
           AND assignment.plan_version = ?
          AND assignment.rubric_revision = ?
          AND assignment.round_revision = ?
          AND assignment.submission_revision = ?
          AND NOT EXISTS (
            SELECT 1
              FROM evaluation_conflicts conflict
             WHERE conflict.organization_id = assignment.organization_id
               AND conflict.event_id = assignment.event_id
               AND conflict.assignment_id = assignment.id
          )
          AND plan.status = 'open'
          AND (plan.closes_at IS NULL OR plan.closes_at > ?)
          AND (round.opens_at IS NULL OR round.opens_at <= ?)
          AND (round.closes_at IS NULL OR round.closes_at > ?)
     )`,
    [
      assignment.tenantId,
      assignment.eventId,
      assignment.id,
      admission.expectedAssignmentVersion,
      assignment.planId,
      assignment.roundId,
      assignment.submissionId,
      assignment.reviewerId,
      assignment.planVersion ?? 0,
      assignment.rubricRevision ?? 0,
      assignment.roundRevision ?? 0,
      assignment.submissionRevision ?? 0,
      admission.authorizedAt,
      admission.authorizedAt,
      admission.authorizedAt,
    ],
  );
}

function planWithinEventGuard(
  database: D1Database,
  plan: Pick<EvaluationPlanScheduleState, "eventId" | "id" | "tenantId">,
): D1PreparedStatement {
  return guard(
    database,
    `EXISTS (
       SELECT 1
         FROM review_plans p
         JOIN events e
           ON e.organization_id = p.organization_id
          AND e.id = p.event_id
        WHERE p.organization_id = ?
          AND p.event_id = ?
          AND p.id = ?
          AND (p.closes_at IS NULL OR p.closes_at <= e.ends_at)
          AND NOT EXISTS (
            SELECT 1
              FROM review_rounds r
             WHERE r.organization_id = p.organization_id
               AND r.event_id = p.event_id
               AND r.plan_id = p.id
               AND (
                 (r.opens_at IS NOT NULL AND r.opens_at > e.ends_at)
                 OR (r.closes_at IS NOT NULL AND r.closes_at > e.ends_at)
               )
          )
     )`,
    [plan.tenantId, plan.eventId, plan.id],
  );
}

function assignmentFromRow(row: Row): EvaluationAssignment {
  const predecessorAssignmentId = nullableText(row.predecessor_assignment_id);
  const successorAssignmentId = nullableText(row.successor_assignment_id);
  const supersededReason = nullableText(row.superseded_reason);
  const supersededAt = nullableText(row.superseded_at);
  return {
    id: text(row.id),
    tenantId: text(row.organization_id),
    eventId: text(row.event_id),
    planId: text(row.plan_id),
    roundId: text(row.round_id),
    submissionId: text(row.submission_id),
    reviewerId: text(row.reviewer_id),
    status: row.status as EvaluationAssignment["status"],
    predecessorAssignmentId,
    successorAssignmentId,
    supersededReason,
    ...(supersededReason === null
      ? {}
      : {
          lineage: {
            predecessorAssignmentId,
            successorAssignmentId,
            reason: supersededReason,
            ...(supersededAt === null ? {} : { supersededAt }),
          },
        }),
    planVersion: numberValue(row.plan_version),
    rubricRevision: numberValue(row.rubric_revision),
    roundRevision: numberValue(row.round_revision),
    submissionRevision: numberValue(row.submission_revision),
    version: numberValue(row.version),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function assignmentValues(assignment: EvaluationAssignment): readonly D1Value[] {
  return [
    assignment.id,
    assignment.tenantId,
    assignment.eventId,
    assignment.planId,
    assignment.roundId,
    assignment.roundRevision ?? assignment.rubricRevision ?? 1,
    assignment.submissionId,
    assignment.reviewerId,
    assignment.status,
    assignment.predecessorAssignmentId ?? null,
    assignment.successorAssignmentId ?? null,
    assignment.supersededReason ?? null,
    assignment.lineage?.supersededAt ?? null,
    assignment.planVersion ?? 1,
    assignment.rubricRevision ?? 1,
    assignment.submissionRevision ?? 1,
    assignment.version,
    assignment.createdAt,
    assignment.updatedAt,
  ];
}

function insertAssignment(database: D1Database, assignment: EvaluationAssignment) {
  return statement(
    database,
    `INSERT INTO review_assignments
       (id, organization_id, event_id, plan_id, round_id, round_revision,
        submission_id, reviewer_id, status, predecessor_assignment_id,
        successor_assignment_id, superseded_reason, superseded_at, plan_version,
        rubric_revision, submission_revision, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    assignmentValues(assignment),
  );
}

function updateAssignment(database: D1Database, assignment: EvaluationAssignment) {
  return statement(
    database,
    `UPDATE review_assignments
        SET status = ?, predecessor_assignment_id = ?, successor_assignment_id = ?,
            superseded_reason = ?, superseded_at = ?, plan_version = ?,
            rubric_revision = ?, round_revision = ?, submission_revision = ?,
            version = ?, updated_at = ?
      WHERE organization_id = ? AND event_id = ? AND id = ?`,
    [
      assignment.status,
      assignment.predecessorAssignmentId ?? null,
      assignment.successorAssignmentId ?? null,
      assignment.supersededReason ?? null,
      assignment.lineage?.supersededAt ?? null,
      assignment.planVersion ?? 1,
      assignment.rubricRevision ?? 1,
      assignment.roundRevision ?? assignment.rubricRevision ?? 1,
      assignment.submissionRevision ?? 1,
      assignment.version,
      assignment.updatedAt,
      assignment.tenantId,
      assignment.eventId,
      assignment.id,
    ],
  );
}

export class D1EvaluationRepository implements EvaluationRepository {
  readonly authority = "transactional" as const;
  readonly supportsAtomicPlanRevisionSync = true;
  get usesDurableDecisionOutbox(): boolean {
    return this.deferDecisionWork;
  }
  constructor(
    private readonly database: D1Database,
    private readonly decisionOutboxQueue?: Queue<CloudflareOutboxMessage>,
    private readonly deferDecisionWork = decisionOutboxQueue !== undefined,
  ) {}

  async getPlan(tenantId: string, planId: string): Promise<EvaluationPlan | null> {
    const session = this.database.withSession("first-primary");
    const row = await session
      .prepare("SELECT * FROM review_plans WHERE organization_id = ? AND id = ?")
      .bind(tenantId, planId)
      .first<Row>();
    return row === null ? null : this.hydratePlan(row, session);
  }

  async getPlanScheduleState(
    tenantId: string,
    planId: string,
  ): Promise<EvaluationPlanScheduleState | null> {
    const session = this.database.withSession("first-primary");
    const plan = await session
      .prepare(
        `SELECT id, organization_id, event_id, predecessor_plan_id, status,
                closes_at, version, updated_at
           FROM review_plans
          WHERE organization_id = ? AND id = ?`,
      )
      .bind(tenantId, planId)
      .first<Row>();
    if (plan === null) return null;
    const roundRows = await session
      .prepare(
        `SELECT round.id, round.predecessor_round_id, round.revision,
                round.opens_at, round.closes_at
           FROM review_rounds round
          WHERE round.organization_id = ?
            AND round.event_id = ?
            AND round.plan_id = ?
            AND round.revision = (
              SELECT MAX(current_round.revision)
                FROM review_rounds current_round
               WHERE current_round.organization_id = round.organization_id
                 AND current_round.event_id = round.event_id
                 AND current_round.plan_id = round.plan_id
                 AND current_round.id = round.id
            )
          ORDER BY round.sequence, round.id`,
      )
      .bind(tenantId, text(plan.event_id), planId)
      .all<Row>();
    return {
      id: text(plan.id),
      tenantId: text(plan.organization_id),
      eventId: text(plan.event_id),
      predecessorPlanId: nullableText(plan.predecessor_plan_id),
      status: text(plan.status) as EvaluationPlan["status"],
      closesAt: nullableText(plan.closes_at),
      version: numberValue(plan.version),
      updatedAt: text(plan.updated_at),
      rounds: rows(roundRows).map((round) => ({
        id: text(round.id),
        predecessorRoundId: nullableText(round.predecessor_round_id),
        revision: numberValue(round.revision),
        opensAt: nullableText(round.opens_at),
        closesAt: nullableText(round.closes_at),
      })),
    };
  }

  async getPlanSuccessor(
    tenantId: string,
    eventId: string,
    predecessorPlanId: string,
  ): Promise<EvaluationPlan | null> {
    const session = this.database.withSession("first-primary");
    const row = await session
      .prepare(
        `SELECT * FROM review_plans
          WHERE organization_id = ? AND event_id = ? AND predecessor_plan_id = ?`,
      )
      .bind(tenantId, eventId, predecessorPlanId)
      .first<Row>();
    return row === null ? null : this.hydratePlan(row, session);
  }

  async listPlans(tenantId: string, eventId?: string): Promise<readonly EvaluationPlan[]> {
    const result = await statement(
      this.database,
      `SELECT * FROM review_plans
        WHERE organization_id = ?${eventId === undefined ? "" : " AND event_id = ?"}
        ORDER BY event_id, id`,
      eventId === undefined ? [tenantId] : [tenantId, eventId],
    ).all<Row>();
    return Promise.all(rows(result).map((row) => this.hydratePlan(row)));
  }

  async hasPendingPlanLineageRepair(tenantId: string, eventId: string): Promise<boolean> {
    const row = await this.database
      .withSession("first-primary")
      .prepare(
        `SELECT 1
           FROM review_plan_lineage_repairs_required
          WHERE organization_id = ? AND event_id = ?
            AND reason <> 'resolved_new_round'
          LIMIT 1`,
      )
      .bind(tenantId, eventId)
      .first<Row>();
    return row !== null;
  }

  async putPlan(
    plan: EvaluationPlan,
    expectedVersion: number | null,
    revisionPrecondition?: EvaluationPlanRevisionPrecondition,
  ): Promise<void> {
    plan = canonicalPlanBoundaries(plan);
    if (
      revisionPrecondition !== undefined &&
      (expectedVersion !== null ||
        plan.predecessorPlanId !== revisionPrecondition.predecessorPlanId)
    ) {
      writeConflict("Evaluation plan revision precondition does not match the new plan.");
    }
    const projection = plan.reviewerProjection ?? plan.evaluatorProjection ?? plan.projection;
    const commands: D1PreparedStatement[] = [
      expectedVersion === null
        ? insertGuard(this.database, "review_plans", "organization_id = ? AND id = ?", [
            plan.tenantId,
            plan.id,
          ])
        : updateGuard(
            this.database,
            "review_plans",
            "organization_id = ? AND event_id = ? AND id = ? AND version = ?",
            [plan.tenantId, plan.eventId, plan.id, expectedVersion],
          ),
    ];
    if (revisionPrecondition !== undefined) {
      commands.push(
        guard(
          this.database,
          `EXISTS (
             SELECT 1
               FROM review_plans predecessor
              WHERE predecessor.organization_id = ?
                AND predecessor.event_id = ?
                AND predecessor.id = ?
                AND predecessor.version = ?
                AND predecessor.status IN ('open', 'closed')
                AND predecessor.grading_locked_at IS NOT NULL
                AND predecessor.revision_sync_pending = 0
                AND NOT EXISTS (
                  SELECT 1
                    FROM review_plans successor
                   WHERE successor.organization_id = predecessor.organization_id
                     AND successor.event_id = predecessor.event_id
                     AND successor.predecessor_plan_id = predecessor.id
                )
           )`,
          [
            plan.tenantId,
            plan.eventId,
            revisionPrecondition.predecessorPlanId,
            revisionPrecondition.expectedVersion,
          ],
        ),
      );
      for (const lineageVersion of revisionPrecondition.lineageVersions) {
        commands.push(
          guard(
            this.database,
            `EXISTS (
               SELECT 1
                 FROM review_plans
                WHERE organization_id = ?
                  AND event_id = ?
                  AND id = ?
                  AND version = ?
             )`,
            [plan.tenantId, plan.eventId, lineageVersion.planId, lineageVersion.expectedVersion],
          ),
        );
      }
    }
    if (expectedVersion === null) {
      commands.push(
        statement(
          this.database,
          `INSERT INTO review_plans
             (id, organization_id, event_id, predecessor_plan_id, name, status, blind_review, closes_at,
              reviews_per_submission, max_assignments_per_reviewer, track_filter,
              auto_distribute, reviewer_projection_field_ids_json,
              reviewer_projection_file_ids_json, grading_revision, grading_locked_at,
              version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            plan.id,
            plan.tenantId,
            plan.eventId,
            plan.predecessorPlanId ?? null,
            plan.name,
            plan.status,
            plan.blindReview ? 1 : 0,
            plan.closesAt,
            plan.assignmentRule.reviewsPerSubmission,
            plan.assignmentRule.maxAssignmentsPerReviewer,
            plan.assignmentRule.trackFilter ?? null,
            plan.assignmentRule.autoDistribute === true ? 1 : 0,
            json(projection?.fieldIds ?? projection?.visibleFieldIds ?? []),
            json(projection?.fileIds ?? projection?.visibleFileIds ?? []),
            plan.gradingRevision ?? null,
            plan.gradingLockedAt ?? null,
            plan.version,
            plan.createdAt,
            plan.updatedAt,
          ],
        ),
      );
    } else {
      commands.push(
        statement(
          this.database,
          `UPDATE review_plans
              SET predecessor_plan_id = ?, name = ?, status = ?, blind_review = ?, closes_at = ?,
                  reviews_per_submission = ?, max_assignments_per_reviewer = ?,
                  track_filter = ?, auto_distribute = ?,
                  reviewer_projection_field_ids_json = ?, reviewer_projection_file_ids_json = ?,
                  grading_revision = ?, grading_locked_at = ?, version = ?, updated_at = ?
            WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ?`,
          [
            plan.predecessorPlanId ?? null,
            plan.name,
            plan.status,
            plan.blindReview ? 1 : 0,
            plan.closesAt,
            plan.assignmentRule.reviewsPerSubmission,
            plan.assignmentRule.maxAssignmentsPerReviewer,
            plan.assignmentRule.trackFilter ?? null,
            plan.assignmentRule.autoDistribute === true ? 1 : 0,
            json(projection?.fieldIds ?? projection?.visibleFieldIds ?? []),
            json(projection?.fileIds ?? projection?.visibleFileIds ?? []),
            plan.gradingRevision ?? null,
            plan.gradingLockedAt ?? null,
            plan.version,
            plan.updatedAt,
            plan.tenantId,
            plan.eventId,
            plan.id,
            expectedVersion,
          ],
        ),
      );
      commands.push(
        statement(
          this.database,
          `DELETE FROM reviewer_pool_members
            WHERE organization_id = ? AND event_id = ?
              AND pool_id IN (
                SELECT id FROM reviewer_pools
                 WHERE organization_id = ? AND event_id = ?
                   AND round_id IN (
                     SELECT id FROM review_rounds
                      WHERE organization_id = ? AND event_id = ? AND plan_id = ?
                   )
              )`,
          [
            plan.tenantId,
            plan.eventId,
            plan.tenantId,
            plan.eventId,
            plan.tenantId,
            plan.eventId,
            plan.id,
          ],
        ),
        statement(
          this.database,
          `DELETE FROM reviewer_pools
            WHERE organization_id = ? AND event_id = ?
              AND round_id IN (
                SELECT id FROM review_rounds
                 WHERE organization_id = ? AND event_id = ? AND plan_id = ?
              )`,
          [plan.tenantId, plan.eventId, plan.tenantId, plan.eventId, plan.id],
        ),
        statement(
          this.database,
          "DELETE FROM review_rounds WHERE organization_id = ? AND event_id = ? AND plan_id = ?",
          [plan.tenantId, plan.eventId, plan.id],
        ),
        statement(
          this.database,
          "DELETE FROM review_rubrics WHERE organization_id = ? AND event_id = ? AND plan_id = ?",
          [plan.tenantId, plan.eventId, plan.id],
        ),
      );
    }
    const latestBoundary = latestPlanBoundary(plan);
    commands.push(
      guard(
        this.database,
        `EXISTS (
           SELECT 1
             FROM events
            WHERE organization_id = ?
              AND id = ?
              AND (? IS NULL OR ends_at >= ?)
         )`,
        [plan.tenantId, plan.eventId, latestBoundary, latestBoundary],
      ),
    );
    for (const round of plan.rounds) this.addRoundStatements(commands, plan, round);
    await atomic(this.database, commands, "Evaluation plan changed since it was loaded.");
  }

  async putPlanState(
    plan: EvaluationPlan,
    expectedVersion: number,
    scheduleSyncs: readonly EvaluationPlanScheduleSync[],
    revisionSyncPending = false,
    revisionSyncToken?: string,
  ): Promise<void> {
    if (revisionSyncPending && revisionSyncToken === undefined) {
      writeConflict("Evaluation plan revision synchronization token is required.");
    }
    plan = canonicalPlanBoundaries(plan);
    const commands = [
      planTipGuard(this.database, plan, expectedVersion),
      statement(
        this.database,
        `UPDATE review_plans
            SET status = ?, grading_revision = ?, grading_locked_at = ?,
                revision_sync_pending = ?, revision_sync_token = ?, version = ?, updated_at = ?
          WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ?`,
        [
          plan.status,
          plan.gradingRevision ?? null,
          plan.gradingLockedAt ?? null,
          revisionSyncPending ? 1 : 0,
          revisionSyncToken ?? null,
          plan.version,
          plan.updatedAt,
          plan.tenantId,
          plan.eventId,
          plan.id,
          expectedVersion,
        ],
      ),
    ];
    for (const round of plan.rounds) {
      this.addRoundStatements(commands, plan, round, true);
    }
    for (const scheduleSync of scheduleSyncs) {
      this.addScheduleStatements(commands, scheduleSync);
    }
    commands.push(
      guard(
        this.database,
        `EXISTS (
           SELECT 1
             FROM review_plans p
             JOIN events e
               ON e.organization_id = p.organization_id
              AND e.id = p.event_id
            WHERE p.organization_id = ?
              AND p.event_id = ?
              AND p.id = ?
              AND (p.closes_at IS NULL OR p.closes_at <= e.ends_at)
              AND NOT EXISTS (
                SELECT 1
                  FROM review_rounds r
                 WHERE r.organization_id = p.organization_id
                   AND r.event_id = p.event_id
                   AND r.plan_id = p.id
                   AND (
                     (r.opens_at IS NOT NULL AND r.opens_at > e.ends_at)
                     OR (r.closes_at IS NOT NULL AND r.closes_at > e.ends_at)
                   )
              )
         )`,
        [plan.tenantId, plan.eventId, plan.id],
      ),
    );
    for (const scheduleSync of scheduleSyncs) {
      commands.push(planWithinEventGuard(this.database, scheduleSync.plan));
    }
    await atomic(this.database, commands, "Evaluation plan changed since it was loaded.");
  }

  async putPlanSchedule(
    plan: EvaluationPlan,
    expectedVersion: number,
    scheduleSyncs: readonly EvaluationPlanScheduleSync[],
    revisionSyncPending = false,
    revisionSyncToken?: string,
  ): Promise<void> {
    if (revisionSyncPending && revisionSyncToken === undefined) {
      writeConflict("Evaluation plan revision synchronization token is required.");
    }
    plan = canonicalPlanBoundaries(plan);
    const commands: D1PreparedStatement[] = [planTipGuard(this.database, plan, expectedVersion)];
    this.addScheduleStatements(
      commands,
      { plan, expectedVersion },
      revisionSyncPending,
      revisionSyncToken,
    );
    for (const scheduleSync of scheduleSyncs) {
      this.addScheduleStatements(commands, scheduleSync);
    }
    commands.push(planWithinEventGuard(this.database, plan));
    for (const scheduleSync of scheduleSyncs) {
      commands.push(planWithinEventGuard(this.database, scheduleSync.plan));
    }
    await atomic(this.database, commands, "Evaluation plan changed since it was loaded.");
  }

  async reconcilePlanRevisionFamily(
    tip: EvaluationPlan,
    expectedVersion: number,
    scheduleSyncs: readonly EvaluationPlanScheduleSync[],
    revisionSyncToken: string,
  ): Promise<void> {
    const oversizedSync = scheduleSyncs.length === 1 ? scheduleSyncs[0] : undefined;
    if (
      oversizedSync !== undefined &&
      oversizedSync.plan.rounds.length > MAX_RECONCILIATION_ROUNDS_PER_BATCH
    ) {
      const plan = canonicalPlanBoundaries(oversizedSync.plan);
      for (
        let offset = 0;
        offset < plan.rounds.length;
        offset += MAX_RECONCILIATION_ROUNDS_PER_BATCH
      ) {
        const rounds = plan.rounds.slice(offset, offset + MAX_RECONCILIATION_ROUNDS_PER_BATCH);
        const finalBatch = offset + rounds.length === plan.rounds.length;
        const commands: D1PreparedStatement[] = [
          planRevisionSyncGuard(this.database, tip, expectedVersion, revisionSyncToken),
        ];
        if (finalBatch) {
          this.addSchedulePlanStatements(commands, plan, oversizedSync.expectedVersion);
        } else {
          commands.push(
            updateGuard(
              this.database,
              "review_plans",
              "organization_id = ? AND event_id = ? AND id = ? AND version = ?",
              [plan.tenantId, plan.eventId, plan.id, oversizedSync.expectedVersion],
            ),
          );
        }
        this.addScheduleRoundStatements(commands, plan, rounds);
        commands.push(planWithinEventGuard(this.database, plan));
        await atomic(this.database, commands, "Evaluation plan changed since it was loaded.");
      }
      return;
    }
    const commands: D1PreparedStatement[] = [
      planRevisionSyncGuard(this.database, tip, expectedVersion, revisionSyncToken),
    ];
    for (const scheduleSync of scheduleSyncs) {
      this.addScheduleStatements(commands, scheduleSync);
    }
    for (const scheduleSync of scheduleSyncs) {
      commands.push(planWithinEventGuard(this.database, scheduleSync.plan));
    }
    await atomic(this.database, commands, "Evaluation plan changed since it was loaded.");
  }

  async completePlanRevisionSync(
    tip: EvaluationPlan,
    expectedVersion: number,
    revisionSyncToken: string,
  ): Promise<void> {
    await atomic(
      this.database,
      [
        planRevisionSyncGuard(this.database, tip, expectedVersion, revisionSyncToken, true),
        statement(
          this.database,
          `UPDATE review_plans
              SET revision_sync_pending = 0, revision_sync_token = ?
            WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ?`,
          [revisionSyncToken, tip.tenantId, tip.eventId, tip.id, expectedVersion],
        ),
      ],
      "Evaluation plan changed since it was loaded.",
    );
  }

  async beginPlanRevisionSync(
    tip: EvaluationPlan,
    expectedVersion: number,
    revisionSyncToken: string,
  ): Promise<void> {
    await atomic(
      this.database,
      [
        guard(
          this.database,
          `EXISTS (
             SELECT 1
               FROM review_plans p
              WHERE p.organization_id = ?
                AND p.event_id = ?
                AND p.id = ?
                AND p.version = ?
                AND (
                  p.revision_sync_pending = 0
                  OR (
                    p.revision_sync_pending = 1
                    AND p.revision_sync_token = ?
                  )
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM review_plans successor
                   WHERE successor.organization_id = p.organization_id
                     AND successor.event_id = p.event_id
                     AND successor.predecessor_plan_id = p.id
                )
           )`,
          [tip.tenantId, tip.eventId, tip.id, expectedVersion, revisionSyncToken],
        ),
        statement(
          this.database,
          `UPDATE review_plans
              SET revision_sync_pending = 1, revision_sync_token = ?
            WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ?`,
          [revisionSyncToken, tip.tenantId, tip.eventId, tip.id, expectedVersion],
        ),
      ],
      "Evaluation plan changed since it was loaded.",
    );
  }

  async resumePlanRevisionSync(
    tip: EvaluationPlan,
    expectedVersion: number,
    revisionSyncToken: string,
  ): Promise<void> {
    await atomic(
      this.database,
      [planRevisionSyncGuard(this.database, tip, expectedVersion, revisionSyncToken, true)],
      "Evaluation plan revision synchronization ownership changed.",
    );
  }

  async getAssignment(tenantId: string, assignmentId: string) {
    const row = await this.database
      .withSession("first-primary")
      .prepare("SELECT * FROM review_assignments WHERE organization_id = ? AND id = ?")
      .bind(tenantId, assignmentId)
      .first<Row>();
    return row === null ? null : assignmentFromRow(row);
  }

  async listAssignments(tenantId: string, planId: string) {
    const result = await this.database
      .withSession("first-primary")
      .prepare(
        "SELECT * FROM review_assignments WHERE organization_id = ? AND plan_id = ? ORDER BY id",
      )
      .bind(tenantId, planId)
      .all<Row>();
    return rows(result).map(assignmentFromRow);
  }

  async replaceAssignment(
    scope: EvaluationAssignmentScope,
    input: EvaluationAssignmentReplacementInput,
  ): Promise<EvaluationAssignmentReplacementResult> {
    const current = await this.getAssignment(scope.tenantId, input.oldAssignmentId);
    if (
      current === null ||
      !assignmentMatchesScope(current, scope) ||
      current.status === "superseded" ||
      current.version !== input.expectedAssignmentVersion ||
      input.reason.trim().length === 0
    ) {
      writeConflict("Reviewer assignment changed since it was loaded.");
    }
    const successor = input.successorAssignment;
    if (
      successor.id === current.id ||
      successor.reviewerId !== input.replacementReviewerId ||
      successor.status === "abstained" ||
      successor.status === "superseded" ||
      !assignmentMatchesScope(successor, scope)
    ) {
      writeConflict("Reviewer assignment replacement is outside its target scope.");
    }
    const supersededAt = successor.updatedAt;
    const replaced: EvaluationAssignment = {
      ...current,
      status: "superseded",
      successorAssignmentId: successor.id,
      supersededReason: input.reason,
      lineage: {
        predecessorAssignmentId: current.predecessorAssignmentId ?? null,
        successorAssignmentId: successor.id,
        reason: input.reason,
        supersededAt,
      },
      version: current.version + 1,
      updatedAt: supersededAt,
    };
    const next: EvaluationAssignment = {
      ...successor,
      predecessorAssignmentId: current.id,
      successorAssignmentId: null,
      supersededReason: null,
      lineage: {
        predecessorAssignmentId: current.id,
        successorAssignmentId: null,
        reason: input.reason,
        supersededAt,
      },
    };
    await atomic(
      this.database,
      [
        authoritativePlanWritableGuard(this.database, scope),
        assignmentWriteScheduleGuard(this.database, scope, input.authorizedAt, true),
        guard(
          this.database,
          `EXISTS (SELECT 1 FROM review_assignments
                    WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND round_id = ?
                      AND submission_id = ? AND id = ? AND version = ? AND status <> 'superseded')
           AND NOT EXISTS (SELECT 1 FROM review_assignments WHERE organization_id = ? AND id = ?)`,
          [
            scope.tenantId,
            scope.eventId,
            scope.planId,
            scope.roundId,
            current.submissionId,
            current.id,
            input.expectedAssignmentVersion,
            scope.tenantId,
            next.id,
          ],
        ),
        insertAssignment(this.database, next),
        updateAssignment(this.database, replaced),
      ],
      "Reviewer assignment changed since it was loaded.",
    );
    const resultScope = { ...scope, submissionId: scope.submissionId ?? current.submissionId };
    const [activeAssignments, history] = await Promise.all([
      this.activeAssignments(resultScope),
      this.reviewHistory([replaced]),
    ]);
    return {
      scope: resultScope,
      replacedAssignment: replaced,
      successorAssignment: next,
      activeAssignments,
      history,
    };
  }

  async applyAssignmentDistribution(
    scope: EvaluationAssignmentScope,
    input: EvaluationAssignmentDistributionInput,
  ): Promise<EvaluationAssignmentDistributionResult> {
    if (input.reason.trim().length === 0) writeConflict("A distribution reason is required.");
    const expected = new Map<string, number>();
    for (const item of input.expectedActiveVersions) {
      if (expected.has(item.assignmentId))
        writeConflict("Expected reviewer assignment versions must be unique.");
      expected.set(item.assignmentId, item.version);
    }
    const desiredIds = new Set<string>();
    for (const assignment of input.assignments) {
      if (
        desiredIds.has(assignment.id) ||
        !assignmentMatchesScope(assignment, scope) ||
        assignment.status === "abstained" ||
        assignment.status === "superseded"
      ) {
        writeConflict("Reviewer assignment distribution is outside its target scope.");
      }
      desiredIds.add(assignment.id);
    }
    const allScoped = await this.assignmentQuery(
      `organization_id = ? AND event_id = ? AND plan_id = ? AND round_id = ?${
        scope.planVersion === undefined ? "" : " AND plan_version = ?"
      } ORDER BY id`,
      scope.planVersion === undefined
        ? [scope.tenantId, scope.eventId, scope.planId, scope.roundId]
        : [scope.tenantId, scope.eventId, scope.planId, scope.roundId, scope.planVersion],
    );
    const targetSubmissionIds = new Set(input.assignments.map((item) => item.submissionId));
    for (const id of expected.keys()) {
      const found = allScoped.find((item) => item.id === id);
      if (found !== undefined) targetSubmissionIds.add(found.submissionId);
    }
    const active = allScoped.filter(
      (item) =>
        targetSubmissionIds.has(item.submissionId) &&
        item.status !== "superseded" &&
        item.status !== "abstained",
    );
    if (
      active.length !== expected.size ||
      active.some((item) => expected.get(item.id) !== item.version)
    ) {
      writeConflict("Reviewer assignments changed since the distribution was previewed.");
    }
    const existingById = new Map(allScoped.map((item) => [item.id, item]));
    for (const desired of input.assignments) {
      const existing = await this.getAssignment(scope.tenantId, desired.id);
      if (
        existing !== null &&
        (!assignmentMatchesScope(existing, scope) ||
          existing.status === "abstained" ||
          existing.status === "superseded" ||
          existing.reviewerId !== desired.reviewerId ||
          existing.version !== desired.version)
      ) {
        writeConflict("A reviewer assignment changed since the distribution was previewed.");
      }
      if (existing !== null) existingById.set(existing.id, existing);
    }
    const supersededAt = input.assignments[0]?.updatedAt ?? active[0]?.updatedAt ?? "";
    const supersededAssignments = active
      .filter((item) => !desiredIds.has(item.id))
      .map(
        (item): EvaluationAssignment => ({
          ...item,
          status: "superseded",
          successorAssignmentId: null,
          supersededReason: input.reason,
          lineage: {
            predecessorAssignmentId: item.predecessorAssignmentId ?? null,
            successorAssignmentId: null,
            reason: input.reason,
            supersededAt,
          },
          version: item.version + 1,
          updatedAt: supersededAt,
        }),
      );
    const nextAssignments = input.assignments.map((item) => ({
      ...existingById.get(item.id),
      ...item,
      predecessorAssignmentId:
        item.predecessorAssignmentId ?? existingById.get(item.id)?.predecessorAssignmentId ?? null,
      successorAssignmentId:
        item.successorAssignmentId ?? existingById.get(item.id)?.successorAssignmentId ?? null,
      supersededReason:
        item.supersededReason ?? existingById.get(item.id)?.supersededReason ?? null,
      lineage: item.lineage ?? existingById.get(item.id)?.lineage,
    }));
    const expectedPredicate =
      input.expectedActiveVersions.length === 0
        ? "0"
        : input.expectedActiveVersions.map(() => "(id = ? AND version = ?)").join(" OR ");
    const targetPredicate =
      targetSubmissionIds.size === 0 ? "0" : [...targetSubmissionIds].map(() => "?").join(", ");
    const commands: D1PreparedStatement[] = [
      authoritativePlanWritableGuard(this.database, scope, input.allowClosedCleanup === true),
    ];
    if (input.allowClosedCleanup !== true) {
      commands.push(assignmentWriteScheduleGuard(this.database, scope, input.authorizedAt, false));
    }
    commands.push(
      guard(
        this.database,
        `(SELECT COUNT(*) FROM review_assignments
           WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND round_id = ?
             ${scope.planVersion === undefined ? "" : "AND plan_version = ?"}
             AND submission_id IN (${targetPredicate})
             AND status NOT IN ('superseded', 'abstained')) = ?
         AND (SELECT COUNT(*) FROM review_assignments
           WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND round_id = ?
             AND (${expectedPredicate}) AND status NOT IN ('superseded', 'abstained')) = ?`,
        [
          scope.tenantId,
          scope.eventId,
          scope.planId,
          scope.roundId,
          ...(scope.planVersion === undefined ? [] : [scope.planVersion]),
          ...targetSubmissionIds,
          expected.size,
          scope.tenantId,
          scope.eventId,
          scope.planId,
          scope.roundId,
          ...input.expectedActiveVersions.flatMap((item) => [item.assignmentId, item.version]),
          expected.size,
        ],
      ),
    );
    for (const item of supersededAssignments) commands.push(updateAssignment(this.database, item));
    for (const item of nextAssignments) {
      commands.push(
        existingById.has(item.id)
          ? updateAssignment(this.database, item)
          : insertAssignment(this.database, item),
      );
    }
    await atomic(
      this.database,
      commands,
      "Reviewer assignments changed since the distribution was previewed.",
    );
    const activeAssignments = (await this.activeAssignments(scope)).filter((item) =>
      targetSubmissionIds.has(item.submissionId),
    );
    return {
      scope,
      activeAssignments,
      supersededAssignments,
      history: await this.reviewHistory(supersededAssignments),
    };
  }

  async getReview(tenantId: string, assignmentId: string) {
    const row = await this.database
      .withSession("first-primary")
      .prepare("SELECT * FROM evaluation_reviews WHERE organization_id = ? AND assignment_id = ?")
      .bind(tenantId, assignmentId)
      .first<Row>();
    return row === null ? null : this.hydrateReview(row);
  }

  async listReviews(tenantId: string, planId: string) {
    return this.reviewQuery("organization_id = ? AND plan_id = ? ORDER BY id", [tenantId, planId]);
  }

  async getSuggestion(tenantId: string, suggestionId: string) {
    const row = await statement(
      this.database,
      "SELECT * FROM evaluation_suggestions WHERE organization_id = ? AND id = ? AND assignment_id IS NULL",
      [tenantId, suggestionId],
    ).first<Row>();
    return row === null ? null : this.hydrateSuggestion(row);
  }
  async listSuggestions(tenantId: string, planId: string) {
    const result = await statement(
      this.database,
      "SELECT * FROM evaluation_suggestions WHERE organization_id = ? AND plan_id = ? AND assignment_id IS NULL ORDER BY id",
      [tenantId, planId],
    ).all<Row>();
    return Promise.all(rows(result).map((row) => this.hydrateSuggestion(row)));
  }

  async putSuggestion(
    suggestion: EvaluationSuggestion,
    expectedVersion: number | null,
    expectedSubmissionRevision = suggestion.submissionRevision,
    allowClosedPlan = false,
  ) {
    const commands = [
      sharedSuggestionGuard(this.database, suggestion, expectedSubmissionRevision),
      ...this.suggestionStatements(suggestion, expectedVersion),
    ];
    if (!allowClosedPlan) {
      commands.unshift(
        authoritativePlanWritableGuard(this.database, {
          tenantId: suggestion.tenantId,
          eventId: suggestion.eventId,
          planId: suggestion.planId,
        }),
      );
    }
    await atomic(this.database, commands, "Suggestion changed since it was loaded.");
  }

  async listReviewerWorkspaceRecords(
    tenantId: string,
    reviewerId: string,
    eventIds: readonly string[],
  ): Promise<ReviewerWorkspaceRecords> {
    if (eventIds.length === 0) return { assignments: [], reviews: [] };
    const placeholders = eventIds.map(() => "?").join(", ");
    const assignments = await this.assignmentQuery(
      `organization_id = ? AND reviewer_id = ? AND event_id IN (${placeholders}) AND status <> 'superseded' ORDER BY id`,
      [tenantId, reviewerId, ...eventIds],
    );
    if (assignments.length === 0) return { assignments, reviews: [] };
    const ids = assignments.map((item) => item.id);
    const reviews = await this.reviewQuery(
      `organization_id = ? AND reviewer_id = ? AND event_id IN (${placeholders}) AND assignment_id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`,
      [tenantId, reviewerId, ...eventIds, ...ids],
    );
    return { assignments, reviews };
  }

  async listOrganizerWorkspaceRecords(
    tenantId: string,
    eventId: string,
  ): Promise<OrganizerWorkspaceRecords> {
    const [assignments, reviewResult, decisions, scoreResult, evidenceResult] = await Promise.all([
      this.assignmentQuery(
        "organization_id = ? AND event_id = ? AND status <> 'superseded' ORDER BY id",
        [tenantId, eventId],
      ),
      statement(
        this.database,
        "SELECT * FROM evaluation_reviews WHERE organization_id = ? AND event_id = ? ORDER BY id",
        [tenantId, eventId],
      ).all<Row>(),
      this.decisionQuery("organization_id = ? AND event_id = ? ORDER BY id", [tenantId, eventId]),
      statement(
        this.database,
        `SELECT * FROM evaluation_scores
          WHERE organization_id = ? AND event_id = ?
          ORDER BY review_id, criterion_id`,
        [tenantId, eventId],
      ).all<Row>(),
      statement(
        this.database,
        `SELECT * FROM evaluation_score_evidence
          WHERE organization_id = ? AND event_id = ?
          ORDER BY review_id, criterion_id, ordinal`,
        [tenantId, eventId],
      ).all<Row>(),
    ]);

    const evidenceByReview = new Map<string, Map<string, string[]>>();
    for (const evidence of rows(evidenceResult)) {
      const reviewId = text(evidence.review_id);
      const criterionId = text(evidence.criterion_id);
      let byCriterion = evidenceByReview.get(reviewId);
      if (byCriterion === undefined) {
        byCriterion = new Map();
        evidenceByReview.set(reviewId, byCriterion);
      }
      const values = byCriterion.get(criterionId);
      if (values === undefined) byCriterion.set(criterionId, [text(evidence.evidence)]);
      else values.push(text(evidence.evidence));
    }

    const scoresByReview = new Map<string, Record<string, RubricScore>>();
    for (const score of rows(scoreResult)) {
      const reviewId = text(score.review_id);
      const criterionId = text(score.criterion_id);
      let reviewScores = scoresByReview.get(reviewId);
      if (reviewScores === undefined) {
        reviewScores = {};
        scoresByReview.set(reviewId, reviewScores);
      }
      reviewScores[criterionId] = this.scoreFromRow(
        score,
        evidenceByReview.get(reviewId)?.get(criterionId) ?? [],
      );
    }

    const reviews = rows(reviewResult).map((row) =>
      this.reviewFromRow(row, scoresByReview.get(text(row.id)) ?? {}),
    );
    return { assignments, reviews, decisions };
  }

  async listOrganizerExportRecords(
    tenantId: string,
    eventId: string,
    planId: string,
  ): Promise<OrganizerWorkspaceRecords> {
    const session = this.database.withSession("first-primary");
    const bindings = [tenantId, eventId, planId] as const;
    const results = await session.batch([
      session
        .prepare(
          `SELECT * FROM review_assignments
            WHERE organization_id = ? AND event_id = ? AND plan_id = ?
              AND status <> 'superseded'
            ORDER BY id`,
        )
        .bind(...bindings),
      session
        .prepare(
          `SELECT * FROM evaluation_reviews
            WHERE organization_id = ? AND event_id = ? AND plan_id = ?
            ORDER BY id`,
        )
        .bind(...bindings),
      session
        .prepare(
          `SELECT * FROM evaluation_decisions
            WHERE organization_id = ? AND event_id = ? AND plan_id = ?
            ORDER BY id`,
        )
        .bind(...bindings),
      session
        .prepare(
          `SELECT scores.*
             FROM evaluation_scores AS scores
             JOIN evaluation_reviews AS reviews
               ON reviews.organization_id = scores.organization_id
              AND reviews.event_id = scores.event_id
              AND reviews.id = scores.review_id
            WHERE reviews.organization_id = ?
              AND reviews.event_id = ?
              AND reviews.plan_id = ?
            ORDER BY scores.review_id, scores.criterion_id`,
        )
        .bind(...bindings),
      session
        .prepare(
          `SELECT evidence.*
             FROM evaluation_score_evidence AS evidence
             JOIN evaluation_reviews AS reviews
               ON reviews.organization_id = evidence.organization_id
              AND reviews.event_id = evidence.event_id
              AND reviews.id = evidence.review_id
            WHERE reviews.organization_id = ?
              AND reviews.event_id = ?
              AND reviews.plan_id = ?
            ORDER BY evidence.review_id, evidence.criterion_id, evidence.ordinal`,
        )
        .bind(...bindings),
      session
        .prepare(
          `SELECT transitions.*
             FROM evaluation_decision_transitions AS transitions
             JOIN evaluation_decisions AS decisions
               ON decisions.organization_id = transitions.organization_id
              AND decisions.event_id = transitions.event_id
              AND decisions.id = transitions.decision_id
            WHERE decisions.organization_id = ?
              AND decisions.event_id = ?
              AND decisions.plan_id = ?
            ORDER BY transitions.decision_id, transitions.ordinal`,
        )
        .bind(...bindings),
    ]);
    const [
      assignmentResult,
      reviewResult,
      decisionResult,
      scoreResult,
      evidenceResult,
      transitionResult,
    ] = results as unknown as [
      D1Result<Row>,
      D1Result<Row>,
      D1Result<Row>,
      D1Result<Row>,
      D1Result<Row>,
      D1Result<Row>,
    ];
    if (
      assignmentResult === undefined ||
      reviewResult === undefined ||
      decisionResult === undefined ||
      scoreResult === undefined ||
      evidenceResult === undefined ||
      transitionResult === undefined
    ) {
      throw new Error("Evaluation export snapshot batch returned incomplete D1 results.");
    }

    const evidenceByReview = new Map<string, Map<string, string[]>>();
    for (const evidence of rows(evidenceResult)) {
      const reviewId = text(evidence.review_id);
      const criterionId = text(evidence.criterion_id);
      const byCriterion = evidenceByReview.get(reviewId) ?? new Map<string, string[]>();
      evidenceByReview.set(reviewId, byCriterion);
      const values = byCriterion.get(criterionId) ?? [];
      byCriterion.set(criterionId, values);
      values.push(text(evidence.evidence));
    }
    const scoresByReview = new Map<string, Record<string, RubricScore>>();
    for (const score of rows(scoreResult)) {
      const reviewId = text(score.review_id);
      const criterionId = text(score.criterion_id);
      const reviewScores = scoresByReview.get(reviewId) ?? {};
      scoresByReview.set(reviewId, reviewScores);
      reviewScores[criterionId] = this.scoreFromRow(
        score,
        evidenceByReview.get(reviewId)?.get(criterionId) ?? [],
      );
    }
    const transitionsByDecision = new Map<string, EvaluationDecisionTransition[]>();
    for (const item of rows(transitionResult)) {
      const decisionId = text(item.decision_id);
      const transitions = transitionsByDecision.get(decisionId) ?? [];
      transitionsByDecision.set(decisionId, transitions);
      transitions.push({
        from:
          item.from_status == null
            ? null
            : (item.from_status as EvaluationDecisionTransition["from"]),
        to: item.to_status as EvaluationDecisionTransition["to"],
        reason: text(item.reason),
        decidedBy: text(item.decided_by),
        decidedAt: text(item.decided_at),
        idempotencyKey: text(item.idempotency_key),
      });
    }
    return {
      assignments: rows(assignmentResult).map(assignmentFromRow),
      reviews: rows(reviewResult).map((row) =>
        this.reviewFromRow(row, scoresByReview.get(text(row.id)) ?? {}),
      ),
      decisions: rows(decisionResult).map((row) => ({
        id: text(row.id),
        tenantId: text(row.organization_id),
        eventId: text(row.event_id),
        planId: text(row.plan_id),
        submissionId: text(row.submission_id),
        status: row.status as EvaluationDecision["status"],
        version: numberValue(row.version),
        history: transitionsByDecision.get(text(row.id)) ?? [],
        updatedAt: text(row.updated_at),
      })),
    };
  }

  async putReview(
    review: EvaluationReview,
    expectedVersion: number | null,
    admission: EvaluationReviewWriteAdmission,
  ) {
    await atomic(
      this.database,
      [
        authoritativePlanWritableGuard(this.database, admission.assignment),
        reviewWriteAdmissionGuard(this.database, admission),
        ...this.reviewStatements(review, expectedVersion),
      ],
      "Review changed since it was loaded.",
    );
  }

  async writeReview(input: WriteEvaluationReview) {
    const { authority, review, assignmentUpdate } = input;
    if (
      review.tenantId !== authority.tenantId ||
      review.eventId !== authority.eventId ||
      review.planId !== authority.planId ||
      review.roundId !== authority.roundId ||
      review.assignmentId !== authority.assignmentId ||
      review.submissionId !== authority.submissionId ||
      review.reviewerId !== authority.reviewerId
    ) {
      writeConflict("Review write targeted another assignment.");
    }
    if (assignmentUpdate !== undefined) {
      if (
        assignmentUpdate.id !== authority.assignmentId ||
        assignmentUpdate.tenantId !== authority.tenantId ||
        assignmentUpdate.eventId !== authority.eventId ||
        assignmentUpdate.planId !== authority.planId ||
        assignmentUpdate.roundId !== authority.roundId ||
        assignmentUpdate.submissionId !== authority.submissionId ||
        assignmentUpdate.reviewerId !== authority.reviewerId ||
        assignmentUpdate.version !== authority.expectedAssignmentVersion + 1
      ) {
        writeConflict("Assignment transition targeted another revision.");
      }
    }
    await atomic(
      this.database,
      [
        reviewWriteAuthorityGuard(this.database, input),
        ...this.reviewStatements(review, input.expectedReviewVersion),
        ...(assignmentUpdate === undefined
          ? []
          : [updateAssignment(this.database, assignmentUpdate)]),
      ],
      "Assignment, submission, conflict, decision, or review state changed.",
    );
  }

  async saveReviewDraft(
    assignment: EvaluationAssignment,
    expectedAssignmentVersion: number,
    review: EvaluationReview,
    expectedReviewVersion: number | null,
    authorizedAt: string,
  ) {
    this.assertReviewAssignment(assignment, review);
    await atomic(
      this.database,
      [
        authoritativePlanWritableGuard(this.database, assignment),
        reviewWriteAdmissionGuard(this.database, {
          assignment,
          expectedAssignmentVersion,
          authorizedAt,
        }),
        updateGuard(
          this.database,
          "review_assignments",
          "organization_id = ? AND event_id = ? AND id = ? AND version = ?",
          [assignment.tenantId, assignment.eventId, assignment.id, expectedAssignmentVersion],
        ),
        ...this.reviewStatements(review, expectedReviewVersion),
        updateAssignment(this.database, assignment),
      ],
      "Assignment or review changed since it was loaded.",
    );
  }

  async getConflict(tenantId: string, assignmentId: string) {
    const row = await statement(
      this.database,
      "SELECT * FROM evaluation_conflicts WHERE organization_id = ? AND assignment_id = ?",
      [tenantId, assignmentId],
    ).first<Row>();
    return row === null ? null : this.conflictFromRow(row);
  }

  async abstainAssignment(
    assignment: EvaluationAssignment,
    expectedAssignmentVersion: number,
    declaration: EvaluationConflictDeclaration,
  ) {
    if (
      declaration.tenantId !== assignment.tenantId ||
      declaration.eventId !== assignment.eventId ||
      declaration.assignmentId !== assignment.id ||
      declaration.planId !== assignment.planId ||
      declaration.submissionId !== assignment.submissionId ||
      declaration.reviewerId !== assignment.reviewerId
    )
      writeConflict("Conflict declaration targeted another assignment.");
    await atomic(
      this.database,
      [
        guard(
          this.database,
          `EXISTS (
            SELECT 1 FROM review_assignments
            WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ?
              AND status IN ('assigned', 'in_progress', 'submitted')
          )
          AND NOT EXISTS (
            SELECT 1 FROM evaluation_conflicts
            WHERE organization_id = ? AND event_id = ? AND assignment_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM submissions
            WHERE organization_id = ? AND event_id = ? AND id = ? AND status = 'submitted'
          )
          AND NOT EXISTS (
            SELECT 1 FROM evaluation_decisions
            WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND submission_id = ?
          )`,
          [
            assignment.tenantId,
            assignment.eventId,
            assignment.id,
            expectedAssignmentVersion,
            declaration.tenantId,
            declaration.eventId,
            declaration.assignmentId,
            assignment.tenantId,
            assignment.eventId,
            assignment.submissionId,
            assignment.tenantId,
            assignment.eventId,
            assignment.planId,
            assignment.submissionId,
          ],
        ),
        updateAssignment(this.database, assignment),
        statement(
          this.database,
          `INSERT INTO evaluation_conflicts
          (id, organization_id, event_id, plan_id, assignment_id, submission_id, reviewer_id, reason, declared_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            declaration.id,
            declaration.tenantId,
            declaration.eventId,
            declaration.planId,
            declaration.assignmentId,
            declaration.submissionId,
            declaration.reviewerId,
            declaration.reason,
            declaration.declaredAt,
          ],
        ),
      ],
      "Assignment changed or a conflict was already declared.",
    );
  }

  async submitReview(
    assignment: EvaluationAssignment,
    expectedAssignmentVersion: number,
    review: EvaluationReview,
    expectedReviewVersion: number,
    authorizedAt: string,
  ) {
    this.assertReviewAssignment(assignment, review);
    await atomic(
      this.database,
      [
        authoritativePlanWritableGuard(this.database, assignment),
        reviewWriteAdmissionGuard(this.database, {
          assignment,
          expectedAssignmentVersion,
          authorizedAt,
        }),
        updateGuard(
          this.database,
          "review_assignments",
          "organization_id = ? AND event_id = ? AND id = ? AND version = ?",
          [assignment.tenantId, assignment.eventId, assignment.id, expectedAssignmentVersion],
        ),
        ...this.reviewStatements(review, expectedReviewVersion),
        updateAssignment(this.database, assignment),
      ],
      "Assignment or review changed since it was loaded.",
    );
  }

  async getDecision(tenantId: string, planId: string, submissionId: string) {
    const decisions = await this.decisionQuery(
      "organization_id = ? AND plan_id = ? AND submission_id = ?",
      [tenantId, planId, submissionId],
    );
    const decision = decisions[0];
    if (decision === undefined) return null;
    const delivery = await this.database
      .withSession("first-primary")
      .prepare(
        `SELECT state, completed_at, last_error_code
           FROM outbox_jobs
          WHERE tenant_id = ? AND topic = 'communications' AND deduplication_key = ?
          LIMIT 1`,
      )
      .bind(tenantId, `decision:evaluation-decision:${planId}:${submissionId}:v${decision.version}`)
      .first<{
        state: "pending" | "processing" | "delivered" | "failed";
        completed_at: string | null;
        last_error_code: string | null;
      }>();
    if (delivery === null) return decision;
    return {
      ...decision,
      notificationDelivery: {
        state: delivery.state,
        ...(delivery.completed_at === null ? {} : { completedAt: delivery.completed_at }),
        ...(delivery.last_error_code === null ? {} : { lastErrorCode: delivery.last_error_code }),
      },
    };
  }

  async putDecision(decision: EvaluationDecision, expectedVersion: number | null) {
    const commands: D1PreparedStatement[] = [
      guard(
        this.database,
        `EXISTS (
          SELECT 1 FROM submissions
          WHERE organization_id = ? AND event_id = ? AND id = ? AND status = 'submitted'
        )`,
        [decision.tenantId, decision.eventId, decision.submissionId],
      ),
      expectedVersion === null
        ? insertGuard(
            this.database,
            "evaluation_decisions",
            "organization_id = ? AND plan_id = ? AND submission_id = ?",
            [decision.tenantId, decision.planId, decision.submissionId],
          )
        : updateGuard(
            this.database,
            "evaluation_decisions",
            "organization_id = ? AND event_id = ? AND plan_id = ? AND submission_id = ? AND version = ?",
            [
              decision.tenantId,
              decision.eventId,
              decision.planId,
              decision.submissionId,
              expectedVersion,
            ],
          ),
    ];
    if (expectedVersion === null) {
      commands.push(
        statement(
          this.database,
          `INSERT INTO evaluation_decisions
        (id, organization_id, event_id, plan_id, submission_id, status, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            decision.id,
            decision.tenantId,
            decision.eventId,
            decision.planId,
            decision.submissionId,
            decision.status,
            decision.version,
            decision.updatedAt,
          ],
        ),
      );
    } else {
      commands.push(
        statement(
          this.database,
          `UPDATE evaluation_decisions SET status = ?, version = ?, updated_at = ?
        WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND submission_id = ? AND version = ?`,
          [
            decision.status,
            decision.version,
            decision.updatedAt,
            decision.tenantId,
            decision.eventId,
            decision.planId,
            decision.submissionId,
            expectedVersion,
          ],
        ),
      );
    }
    commands.push(
      statement(
        this.database,
        "DELETE FROM evaluation_decision_transitions WHERE organization_id = ? AND event_id = ? AND decision_id = ?",
        [decision.tenantId, decision.eventId, decision.id],
      ),
    );
    decision.history.forEach((item, index) => {
      commands.push(
        statement(
          this.database,
          `INSERT INTO evaluation_decision_transitions
          (organization_id, event_id, decision_id, ordinal, from_status, to_status, reason, decided_by, decided_at, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            decision.tenantId,
            decision.eventId,
            decision.id,
            index,
            item.from,
            item.to,
            item.reason,
            item.decidedBy,
            item.decidedAt,
            item.idempotencyKey,
          ],
        ),
      );
    });
    const outboxJobId = evaluationDecisionOutboxJobId(decision.id, decision.version);
    commands.push(
      statement(
        this.database,
        `INSERT INTO outbox_jobs
          (id, tenant_id, topic, deduplication_key, payload_json, state,
           attempt_count, available_at, created_at, updated_at)
         VALUES (?, ?, 'evaluation-decisions', ?, ?, 'pending', 0, ?, ?, ?)
         ON CONFLICT (tenant_id, topic, deduplication_key) DO NOTHING`,
        [
          outboxJobId,
          decision.tenantId,
          evaluationDecisionWorkKey(decision.planId, decision.submissionId, decision.version),
          json(evaluationDecisionWorkPayload(decision)),
          decision.updatedAt,
          decision.updatedAt,
          decision.updatedAt,
        ],
      ),
    );
    await atomic(this.database, commands, "Decision changed since it was loaded.");
    if (this.decisionOutboxQueue !== undefined) {
      try {
        await publishEvaluationDecisionJob(
          this.database,
          this.decisionOutboxQueue,
          outboxJobId,
          decision.tenantId,
        );
      } catch (error) {
        console.error("Evaluation decision outbox publication was deferred for recovery.", {
          jobId: outboxJobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async hydratePlan(
    row: Row,
    database: D1ReadDatabase = this.database,
  ): Promise<EvaluationPlan> {
    const tenantId = text(row.organization_id);
    const eventId = text(row.event_id);
    const planId = text(row.id);
    const roundResult = await statement(
      database,
      `SELECT * FROM review_rounds
      WHERE organization_id = ? AND event_id = ? AND plan_id = ? ORDER BY sequence, revision`,
      [tenantId, eventId, planId],
    ).all<Row>();
    const latest = new Map<string, Row>();
    for (const round of rows(roundResult)) latest.set(text(round.id), round);
    const rounds = await Promise.all(
      [...latest.values()].map((round) => this.hydrateRound(round, database)),
    );
    const fieldIds = parseJson<string[]>(text(row.reviewer_projection_field_ids_json), []);
    const fileIds = parseJson<string[]>(text(row.reviewer_projection_file_ids_json), []);
    return {
      id: planId,
      predecessorPlanId: nullableText(row.predecessor_plan_id),
      tenantId,
      eventId,
      name: text(row.name),
      status: row.status as EvaluationPlan["status"],
      blindReview: bool(row.blind_review),
      closesAt: nullableText(row.closes_at),
      assignmentRule: {
        reviewsPerSubmission: numberValue(row.reviews_per_submission),
        maxAssignmentsPerReviewer: numberValue(row.max_assignments_per_reviewer),
        ...(row.track_filter == null ? {} : { trackFilter: text(row.track_filter) }),
        autoDistribute: bool(row.auto_distribute),
      },
      rounds: rounds.sort((left, right) => left.sequence - right.sequence),
      reviewerProjection: { fieldIds, fileIds },
      gradingRevision: optionalNumber(row.grading_revision),
      gradingLockedAt: nullableText(row.grading_locked_at),
      version: numberValue(row.version),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    };
  }

  private async hydrateRound(row: Row, database: D1ReadDatabase): Promise<ReviewRound> {
    const keys = [
      text(row.organization_id),
      text(row.event_id),
      text(row.plan_id),
      text(row.rubric_id),
      numberValue(row.rubric_revision),
    ] as const;
    const [rubricRow, criteriaResult, poolRow] = await Promise.all([
      statement(
        database,
        `SELECT * FROM review_rubrics WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND id = ? AND revision = ?`,
        keys,
      ).first<Row>(),
      statement(
        database,
        `SELECT * FROM review_criteria WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND rubric_id = ? AND rubric_revision = ? ORDER BY sort_order`,
        keys,
      ).all<Row>(),
      statement(
        database,
        `SELECT * FROM reviewer_pools WHERE organization_id = ? AND event_id = ? AND round_id = ? AND round_revision = ?`,
        [text(row.organization_id), text(row.event_id), text(row.id), numberValue(row.revision)],
      ).first<Row>(),
    ]);
    const criteria = await Promise.all(
      rows(criteriaResult).map((criterion) => this.hydrateCriterion(criterion, database)),
    );
    let reviewerPool: ReviewRound["reviewerPool"];
    if (poolRow !== null) {
      const members = await statement(
        database,
        `SELECT reviewer_id FROM reviewer_pool_members WHERE organization_id = ? AND event_id = ? AND pool_id = ? ORDER BY reviewer_id`,
        [text(poolRow.organization_id), text(poolRow.event_id), text(poolRow.id)],
      ).all<Row>();
      reviewerPool = {
        reviewerIds: rows(members).map((member) => text(member.reviewer_id)),
        ...(poolRow.name == null ? {} : { name: text(poolRow.name) }),
      };
    }
    return {
      id: text(row.id),
      predecessorRoundId: nullableText(row.predecessor_round_id),
      name: text(row.name),
      sequence: numberValue(row.sequence),
      revision: numberValue(row.revision),
      rubricRevision: numberValue(row.rubric_revision),
      opensAt: nullableText(row.opens_at),
      closesAt: nullableText(row.closes_at),
      blindReview: bool(row.blind_review),
      anonymization: row.anonymization as ReviewRound["anonymization"],
      aiTriageEnabled: row.ai_triage_enabled != null ? Boolean(row.ai_triage_enabled) : false,
      ...(row.track_filter == null ? {} : { trackFilter: text(row.track_filter) }),
      ...(reviewerPool === undefined ? {} : { reviewerPool }),
      rubric: {
        id: text(row.rubric_id),
        name: rubricRow === null ? text(row.rubric_id) : text(rubricRow.name),
        criteria,
      },
    };
  }

  private async hydrateCriterion(row: Row, database: D1ReadDatabase): Promise<RubricCriterion> {
    const options = await statement(
      database,
      `SELECT * FROM review_criterion_options
      WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND rubric_id = ? AND rubric_revision = ? AND criterion_id = ? ORDER BY sort_order`,
      [
        text(row.organization_id),
        text(row.event_id),
        text(row.plan_id),
        text(row.rubric_id),
        numberValue(row.rubric_revision),
        text(row.id),
      ],
    ).all<Row>();
    return {
      id: text(row.id),
      label: text(row.label),
      description: text(row.description),
      minimum: numberValue(row.minimum),
      maximum: numberValue(row.maximum),
      weight: numberValue(row.weight),
      required: bool(row.required),
      inputType: row.input_type as RubricCriterion["inputType"],
      options: rows(options).map((option) => ({
        id: text(option.id),
        label: text(option.label),
        value: text(option.value),
      })),
    };
  }

  private addRoundStatements(
    commands: D1PreparedStatement[],
    plan: EvaluationPlan,
    round: ReviewRound,
    ignoreExisting = false,
  ) {
    const roundRevision = round.revision ?? 1;
    const rubricRevision = round.rubricRevision ?? roundRevision;
    const insert = ignoreExisting ? "INSERT OR IGNORE" : "INSERT";
    commands.push(
      statement(
        this.database,
        `${insert} INTO review_rubrics (id, organization_id, event_id, plan_id, revision, name) VALUES (?, ?, ?, ?, ?, ?)`,
        [round.rubric.id, plan.tenantId, plan.eventId, plan.id, rubricRevision, round.rubric.name],
      ),
      statement(
        this.database,
        `${insert} INTO review_rounds
        (id, organization_id, event_id, plan_id, predecessor_round_id, name, sequence, revision, rubric_id, rubric_revision, opens_at, closes_at, blind_review, anonymization, ai_triage_enabled, track_filter)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          round.id,
          plan.tenantId,
          plan.eventId,
          plan.id,
          round.predecessorRoundId ?? null,
          round.name,
          round.sequence,
          roundRevision,
          round.rubric.id,
          rubricRevision,
          round.opensAt ?? null,
          round.closesAt,
          (round.blindReview ?? plan.blindReview) ? 1 : 0,
          round.anonymization ?? ((round.blindReview ?? plan.blindReview) ? "single" : "none"),
          (round.aiTriageEnabled ?? false) ? 1 : 0,
          round.trackFilter ?? null,
        ],
      ),
    );
    round.rubric.criteria.forEach((criterion, criterionIndex) => {
      commands.push(
        statement(
          this.database,
          `${insert} INTO review_criteria
        (organization_id, event_id, plan_id, rubric_id, rubric_revision, id, label, description, minimum, maximum, weight, required, input_type, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            plan.tenantId,
            plan.eventId,
            plan.id,
            round.rubric.id,
            rubricRevision,
            criterion.id,
            criterion.label,
            criterion.description,
            criterion.minimum,
            criterion.maximum,
            criterion.weight,
            criterion.required ? 1 : 0,
            criterion.inputType ?? "numeric",
            criterionIndex,
          ],
        ),
      );
      criterion.options?.forEach((option, optionIndex) => {
        commands.push(
          statement(
            this.database,
            `${insert} INTO review_criterion_options
        (organization_id, event_id, plan_id, rubric_id, rubric_revision, criterion_id, id, label, value, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              plan.tenantId,
              plan.eventId,
              plan.id,
              round.rubric.id,
              rubricRevision,
              criterion.id,
              option.id ?? `${criterion.id}-option-${optionIndex + 1}`,
              option.label,
              option.value,
              optionIndex,
            ],
          ),
        );
      });
    });
    if (round.reviewerPool !== undefined) {
      const poolId = `${plan.id}:${round.id}:r${roundRevision}`;
      commands.push(
        statement(
          this.database,
          `${insert} INTO reviewer_pools
        (id, organization_id, event_id, round_id, round_revision, name, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            poolId,
            plan.tenantId,
            plan.eventId,
            round.id,
            roundRevision,
            round.reviewerPool.name ?? null,
            plan.updatedAt,
            plan.updatedAt,
          ],
        ),
      );
      for (const reviewerId of stableSort(round.reviewerPool.reviewerIds, (value) => value))
        commands.push(
          statement(
            this.database,
            `${insert} INTO reviewer_pool_members (organization_id, event_id, pool_id, reviewer_id) VALUES (?, ?, ?, ?)`,
            [plan.tenantId, plan.eventId, poolId, reviewerId],
          ),
        );
    }
  }

  private addScheduleStatements(
    commands: D1PreparedStatement[],
    scheduleSync: EvaluationPlanScheduleSync,
    revisionSyncPending = false,
    revisionSyncToken?: string,
  ): void {
    const plan = canonicalPlanBoundaries(scheduleSync.plan);
    const { expectedVersion } = scheduleSync;
    this.addSchedulePlanStatements(
      commands,
      plan,
      expectedVersion,
      revisionSyncPending,
      revisionSyncToken,
    );
    this.addScheduleRoundStatements(commands, plan, plan.rounds);
  }

  private addSchedulePlanStatements(
    commands: D1PreparedStatement[],
    plan: EvaluationPlanScheduleState,
    expectedVersion: number,
    revisionSyncPending = false,
    revisionSyncToken?: string,
  ): void {
    commands.push(
      updateGuard(
        this.database,
        "review_plans",
        "organization_id = ? AND event_id = ? AND id = ? AND version = ?",
        [plan.tenantId, plan.eventId, plan.id, expectedVersion],
      ),
      statement(
        this.database,
        `UPDATE review_plans
            SET status = ?, closes_at = ?, revision_sync_pending = ?,
                revision_sync_token = ?, version = ?, updated_at = ?
          WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ?`,
        [
          plan.status,
          plan.closesAt ?? null,
          revisionSyncPending ? 1 : 0,
          revisionSyncToken ?? null,
          plan.version,
          plan.updatedAt,
          plan.tenantId,
          plan.eventId,
          plan.id,
          expectedVersion,
        ],
      ),
    );
  }

  private addScheduleRoundStatements(
    commands: D1PreparedStatement[],
    plan: EvaluationPlanScheduleState,
    rounds: EvaluationPlanScheduleState["rounds"],
  ): void {
    for (const round of rounds) {
      commands.push(
        guard(
          this.database,
          `EXISTS (
             SELECT 1 FROM review_rounds
              WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND id = ?
                AND revision = ?
           )`,
          [plan.tenantId, plan.eventId, plan.id, round.id, round.revision ?? 1],
        ),
        statement(
          this.database,
          `UPDATE review_rounds
              SET opens_at = ?, closes_at = ?
            WHERE organization_id = ? AND event_id = ? AND plan_id = ? AND id = ?
              AND revision = ?`,
          [
            round.opensAt ?? null,
            round.closesAt ?? null,
            plan.tenantId,
            plan.eventId,
            plan.id,
            round.id,
            round.revision ?? 1,
          ],
        ),
      );
    }
  }

  private async assignmentQuery(where: string, values: readonly D1Value[]) {
    const result = await statement(
      this.database,
      `SELECT * FROM review_assignments WHERE ${where}`,
      values,
    ).all<Row>();
    return rows(result).map(assignmentFromRow);
  }

  private async activeAssignments(scope: EvaluationAssignmentScope) {
    return this.assignmentQuery(
      `organization_id = ? AND event_id = ? AND plan_id = ? AND round_id = ?${scope.submissionId === undefined ? "" : " AND submission_id = ?"}${scope.planVersion === undefined ? "" : " AND plan_version = ?"} AND status <> 'superseded' ORDER BY id`,
      [
        scope.tenantId,
        scope.eventId,
        scope.planId,
        scope.roundId,
        ...(scope.submissionId === undefined ? [] : [scope.submissionId]),
        ...(scope.planVersion === undefined ? [] : [scope.planVersion]),
      ],
    );
  }

  private reviewStatements(
    review: EvaluationReview,
    expectedVersion: number | null,
  ): D1PreparedStatement[] {
    const commands: D1PreparedStatement[] = [
      expectedVersion === null
        ? insertGuard(
            this.database,
            "evaluation_reviews",
            "organization_id = ? AND assignment_id = ?",
            [review.tenantId, review.assignmentId],
          )
        : updateGuard(
            this.database,
            "evaluation_reviews",
            "organization_id = ? AND event_id = ? AND assignment_id = ? AND version = ?",
            [review.tenantId, review.eventId, review.assignmentId, expectedVersion],
          ),
    ];
    const revisions = [
      review.planRevision ?? review.planVersion ?? 1,
      review.roundRevision ?? review.rubricRevision ?? review.rubricVersion ?? 1,
      review.rubricRevision ?? review.rubricVersion ?? 1,
      review.submissionRevision ?? review.submissionVersion ?? 1,
    ];
    if (expectedVersion === null)
      commands.push(
        statement(
          this.database,
          `INSERT INTO evaluation_reviews
      (id, organization_id, event_id, plan_id, round_id, assignment_id, submission_id, reviewer_id, comment, submitted_at, plan_revision, round_revision, rubric_revision, submission_revision, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            review.id,
            review.tenantId,
            review.eventId,
            review.planId,
            review.roundId,
            review.assignmentId,
            review.submissionId,
            review.reviewerId,
            review.comment,
            review.submittedAt,
            ...revisions,
            review.version,
            review.createdAt,
            review.updatedAt,
          ],
        ),
      );
    else
      commands.push(
        statement(
          this.database,
          `UPDATE evaluation_reviews SET comment = ?, submitted_at = ?, plan_revision = ?, round_revision = ?, rubric_revision = ?, submission_revision = ?, version = ?, updated_at = ?
      WHERE organization_id = ? AND event_id = ? AND assignment_id = ? AND version = ?`,
          [
            review.comment,
            review.submittedAt,
            ...revisions,
            review.version,
            review.updatedAt,
            review.tenantId,
            review.eventId,
            review.assignmentId,
            expectedVersion,
          ],
        ),
      );
    commands.push(
      statement(
        this.database,
        "DELETE FROM evaluation_scores WHERE organization_id = ? AND event_id = ? AND review_id = ?",
        [review.tenantId, review.eventId, review.id],
      ),
    );
    for (const [criterionId, score] of Object.entries(review.scores).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      commands.push(
        statement(
          this.database,
          `INSERT INTO evaluation_scores
        (organization_id, event_id, review_id, criterion_id, value_number, value_text, origin, rubric_revision, submission_revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            review.tenantId,
            review.eventId,
            review.id,
            criterionId,
            typeof score.value === "number" ? score.value : null,
            typeof score.value === "string" ? score.value : null,
            score.origin,
            score.rubricRevision ?? score.rubricVersion ?? revisions[2] ?? 1,
            score.submissionRevision ?? score.submissionVersion ?? revisions[3] ?? 1,
            score.updatedAt,
          ],
        ),
      );
      score.evidence.forEach((evidence, index) => {
        commands.push(
          statement(
            this.database,
            `INSERT INTO evaluation_score_evidence (organization_id, event_id, review_id, criterion_id, ordinal, evidence) VALUES (?, ?, ?, ?, ?, ?)`,
            [review.tenantId, review.eventId, review.id, criterionId, index, evidence],
          ),
        );
      });
    }
    return commands;
  }

  private async hydrateReview(row: Row): Promise<EvaluationReview> {
    const scoreResult = await statement(
      this.database,
      `SELECT * FROM evaluation_scores WHERE organization_id = ? AND event_id = ? AND review_id = ? AND origin = 'human' ORDER BY criterion_id`,
      [text(row.organization_id), text(row.event_id), text(row.id)],
    ).all<Row>();
    const scores: Record<string, RubricScore> = {};
    for (const score of rows(scoreResult)) {
      const evidenceResult = await statement(
        this.database,
        `SELECT evidence FROM evaluation_score_evidence WHERE organization_id = ? AND event_id = ? AND review_id = ? AND criterion_id = ? ORDER BY ordinal`,
        [text(row.organization_id), text(row.event_id), text(row.id), text(score.criterion_id)],
      ).all<Row>();
      scores[text(score.criterion_id)] = this.scoreFromRow(
        score,
        rows(evidenceResult).map((item) => text(item.evidence)),
      );
    }
    return this.reviewFromRow(row, scores);
  }

  private scoreFromRow(score: Row, evidence: readonly string[]): RubricScore {
    return {
      criterionId: text(score.criterion_id),
      value: score.value_number == null ? text(score.value_text) : numberValue(score.value_number),
      origin: "human",
      evidence,
      rubricRevision: numberValue(score.rubric_revision),
      submissionRevision: numberValue(score.submission_revision),
      updatedAt: text(score.updated_at),
    };
  }

  private reviewFromRow(row: Row, scores: Record<string, RubricScore>): EvaluationReview {
    return {
      id: text(row.id),
      tenantId: text(row.organization_id),
      eventId: text(row.event_id),
      planId: text(row.plan_id),
      roundId: text(row.round_id),
      assignmentId: text(row.assignment_id),
      submissionId: text(row.submission_id),
      reviewerId: text(row.reviewer_id),
      scores,
      comment: text(row.comment),
      submittedAt: nullableText(row.submitted_at),
      version: numberValue(row.version),
      planRevision: numberValue(row.plan_revision),
      roundRevision: numberValue(row.round_revision),
      rubricRevision: numberValue(row.rubric_revision),
      submissionRevision: numberValue(row.submission_revision),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    };
  }

  private async reviewQuery(where: string, values: readonly D1Value[]) {
    const result = await statement(
      this.database,
      `SELECT * FROM evaluation_reviews WHERE ${where}`,
      values,
    ).all<Row>();
    return Promise.all(rows(result).map((row) => this.hydrateReview(row)));
  }

  private suggestionStatements(
    suggestion: EvaluationSuggestion,
    expectedVersion: number | null,
  ): D1PreparedStatement[] {
    const commands: D1PreparedStatement[] = [
      expectedVersion === null
        ? insertGuard(this.database, "evaluation_suggestions", "organization_id = ? AND id = ?", [
            suggestion.tenantId,
            suggestion.id,
          ])
        : updateGuard(
            this.database,
            "evaluation_suggestions",
            "organization_id = ? AND event_id = ? AND id = ? AND version = ?",
            [suggestion.tenantId, suggestion.eventId, suggestion.id, expectedVersion],
          ),
    ];
    const provenanceJson = json(suggestion.provenance);
    if (expectedVersion === null)
      commands.push(
        statement(
          this.database,
          `INSERT INTO evaluation_suggestions
      (id, organization_id, event_id, plan_id, round_id, assignment_id, submission_id, reviewer_id, plan_revision, rubric_revision, submission_revision, rubric_id, provider, model, prompt_version, generated_at, source_references_json, provenance_json, override_json, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            suggestion.id,
            suggestion.tenantId,
            suggestion.eventId,
            suggestion.planId,
            suggestion.roundId,
            suggestion.assignmentId,
            suggestion.submissionId,
            suggestion.reviewerId,
            suggestion.planRevision ?? suggestion.rubricRevision,
            suggestion.rubricRevision,
            suggestion.submissionRevision,
            suggestion.rubricId ?? null,
            suggestion.provenance.provider,
            suggestion.provenance.model,
            suggestion.provenance.promptVersion ?? "unknown",
            suggestion.provenance.generatedAt,
            json(suggestion.provenance.sourceReferences),
            provenanceJson,
            suggestion.override === null || suggestion.override === undefined
              ? null
              : json(suggestion.override),
            suggestion.status,
            suggestion.version,
            suggestion.createdAt,
            suggestion.updatedAt,
          ],
        ),
      );
    else
      commands.push(
        statement(
          this.database,
          `UPDATE evaluation_suggestions SET status = ?, version = ?, provenance_json = ?, override_json = ?, updated_at = ? WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ?`,
          [
            suggestion.status,
            suggestion.version,
            provenanceJson,
            suggestion.override === null || suggestion.override === undefined
              ? null
              : json(suggestion.override),
            suggestion.updatedAt,
            suggestion.tenantId,
            suggestion.eventId,
            suggestion.id,
            expectedVersion,
          ],
        ),
      );
    commands.push(
      statement(
        this.database,
        "DELETE FROM evaluation_suggestion_candidates WHERE organization_id = ? AND event_id = ? AND suggestion_id = ?",
        [suggestion.tenantId, suggestion.eventId, suggestion.id],
      ),
      statement(
        this.database,
        "DELETE FROM evaluation_suggestion_history WHERE organization_id = ? AND event_id = ? AND suggestion_id = ?",
        [suggestion.tenantId, suggestion.eventId, suggestion.id],
      ),
    );
    suggestion.criterionCandidates.forEach((candidate, index) => {
      commands.push(
        statement(
          this.database,
          `INSERT INTO evaluation_suggestion_candidates
          (organization_id, event_id, suggestion_id, id, criterion_id, value, evidence_json, provenance_json, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            suggestion.tenantId,
            suggestion.eventId,
            suggestion.id,
            candidate.id,
            candidate.criterionId,
            candidate.value,
            json(candidate.evidence),
            json(candidate.provenance),
            index,
          ],
        ),
      );
    });
    suggestion.history.forEach((item, index) => {
      commands.push(
        statement(
          this.database,
          `INSERT INTO evaluation_suggestion_history
          (organization_id, event_id, suggestion_id, ordinal, action, actor_id, at, reason, values_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            suggestion.tenantId,
            suggestion.eventId,
            suggestion.id,
            index,
            item.action,
            item.actorId,
            item.at,
            item.reason ?? null,
            item.valueByCriterion === undefined ? null : json(item.valueByCriterion),
          ],
        ),
      );
    });
    return commands;
  }

  private async hydrateSuggestion(row: Row): Promise<EvaluationSuggestion> {
    const [candidateResult, historyResult] = await Promise.all([
      statement(
        this.database,
        `SELECT * FROM evaluation_suggestion_candidates WHERE organization_id = ? AND event_id = ? AND suggestion_id = ? ORDER BY ordinal`,
        [text(row.organization_id), text(row.event_id), text(row.id)],
      ).all<Row>(),
      statement(
        this.database,
        `SELECT * FROM evaluation_suggestion_history WHERE organization_id = ? AND event_id = ? AND suggestion_id = ? ORDER BY ordinal`,
        [text(row.organization_id), text(row.event_id), text(row.id)],
      ).all<Row>(),
    ]);
    const candidates: EvaluationSuggestionCandidate[] = rows(candidateResult).map((item) => ({
      id: text(item.id),
      criterionId: text(item.criterion_id),
      value: numberValue(item.value),
      evidence: parseJson<string[]>(text(item.evidence_json), []),
      provenance: parseJson(text(item.provenance_json), {
        provider: text(row.provider),
        model: text(row.model),
        generatedAt: text(row.generated_at),
        sourceReferences: [],
      }),
    }));
    const history: EvaluationSuggestionAuditEntry[] = rows(historyResult).map((item) => {
      const values =
        item.values_json == null
          ? null
          : parseJson<Record<string, unknown>>(text(item.values_json), {});
      const valueByCriterion: Record<string, number | string> = {};
      if (values !== null) {
        for (const [key, value] of Object.entries(values)) {
          if (typeof value === "number" || typeof value === "string") {
            valueByCriterion[key] = value;
          }
        }
      }
      return {
        action: item.action as EvaluationSuggestionAuditEntry["action"],
        actorId: nullableText(item.actor_id),
        at: text(item.at),
        ...(item.reason == null ? {} : { reason: text(item.reason) }),
        ...(Object.keys(valueByCriterion).length === 0 ? {} : { valueByCriterion }),
      };
    });
    const byCriterion: Record<string, EvaluationSuggestionCandidate[]> = {};
    for (const candidate of candidates) {
      const existing = byCriterion[candidate.criterionId];
      if (existing === undefined) {
        byCriterion[candidate.criterionId] = [candidate];
      } else {
        existing.push(candidate);
      }
    }
    const provenance = parseJson(row.provenance_json == null ? "" : text(row.provenance_json), {
      provider: text(row.provider),
      model: text(row.model),
      generatedAt: text(row.generated_at),
      sourceReferences: parseJson<string[]>(text(row.source_references_json), []),
    });
    return {
      id: text(row.id),
      tenantId: text(row.organization_id),
      eventId: text(row.event_id),
      planId: text(row.plan_id),
      roundId: text(row.round_id),
      assignmentId: null,
      submissionId: text(row.submission_id),
      reviewerId: text(row.reviewer_id),
      planRevision: numberValue(row.plan_revision),
      rubricRevision: numberValue(row.rubric_revision),
      submissionRevision: numberValue(row.submission_revision),
      ...(row.rubric_id == null ? {} : { rubricId: text(row.rubric_id) }),
      candidates: byCriterion,
      criterionCandidates: candidates,
      provenance,
      status: row.status as EvaluationSuggestion["status"],
      override:
        row.override_json == null
          ? null
          : (parseJson(text(row.override_json), null) as EvaluationSuggestion["override"] | null),
      version: numberValue(row.version),
      history,
      audit: history,
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    };
  }

  private conflictFromRow(row: Row): EvaluationConflictDeclaration {
    return {
      id: text(row.id),
      tenantId: text(row.organization_id),
      eventId: text(row.event_id),
      planId: text(row.plan_id),
      assignmentId: text(row.assignment_id),
      submissionId: text(row.submission_id),
      reviewerId: text(row.reviewer_id),
      reason: text(row.reason),
      declaredAt: text(row.declared_at),
    };
  }

  private async reviewHistory(
    assignments: readonly EvaluationAssignment[],
  ): Promise<readonly EvaluationReviewHistory[]> {
    const history: EvaluationReviewHistory[] = [];
    for (const assignment of assignments) {
      const review = await this.getReview(assignment.tenantId, assignment.id);
      if (review !== null) history.push({ assignment, review });
    }
    return history;
  }

  private assertReviewAssignment(assignment: EvaluationAssignment, review: EvaluationReview) {
    if (
      assignment.tenantId !== review.tenantId ||
      assignment.eventId !== review.eventId ||
      assignment.planId !== review.planId ||
      assignment.roundId !== review.roundId ||
      assignment.id !== review.assignmentId ||
      assignment.submissionId !== review.submissionId ||
      assignment.reviewerId !== review.reviewerId
    )
      writeConflict("Review targeted another assignment.");
  }

  private async decisionQuery(
    where: string,
    values: readonly D1Value[],
  ): Promise<readonly EvaluationDecision[]> {
    const session = this.database.withSession("first-primary");
    const result = await session
      .prepare(`SELECT * FROM evaluation_decisions WHERE ${where}`)
      .bind(...values)
      .all<Row>();
    return Promise.all(
      rows(result).map(async (row) => {
        const transitions = await session
          .prepare(
            `SELECT * FROM evaluation_decision_transitions WHERE organization_id = ? AND event_id = ? AND decision_id = ? ORDER BY ordinal`,
          )
          .bind(text(row.organization_id), text(row.event_id), text(row.id))
          .all<Row>();
        const history: EvaluationDecisionTransition[] = rows(transitions).map((item) => ({
          from:
            item.from_status == null
              ? null
              : (item.from_status as EvaluationDecisionTransition["from"]),
          to: item.to_status as EvaluationDecisionTransition["to"],
          reason: text(item.reason),
          decidedBy: text(item.decided_by),
          decidedAt: text(item.decided_at),
          idempotencyKey: text(item.idempotency_key),
        }));
        return {
          id: text(row.id),
          tenantId: text(row.organization_id),
          eventId: text(row.event_id),
          planId: text(row.plan_id),
          submissionId: text(row.submission_id),
          status: row.status as EvaluationDecision["status"],
          version: numberValue(row.version),
          history,
          updatedAt: text(row.updated_at),
        };
      }),
    );
  }
}

export { D1EvaluationRepository as CloudflareEvaluationRepository };
