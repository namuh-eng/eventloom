import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteD1 } from "../test-support/sqlite-d1";

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), "apps/api/migrations", name), "utf8");
}

describe("review plan lineage migrations", () => {
  it("preserves unresolved plan and round lineage markers until separately repaired", async () => {
    const database = new SqliteD1(
      "eventloom-review-lineage-migration-",
      migration("0009_evaluations.sql"),
    );
    try {
      database.executeScript(`
        INSERT INTO review_plans (
          organization_id, event_id, id, name, status, blind_review, closes_at,
          reviews_per_submission, max_assignments_per_reviewer, track_filter,
          auto_distribute, reviewer_projection_field_ids_json,
          reviewer_projection_file_ids_json, grading_revision, grading_locked_at,
          version, created_at, updated_at
        ) VALUES
          (
            'org-1', 'event-1', 'plan-1', 'Main review', 'open', 0, NULL,
            1, 5, NULL, 0, '[]', '[]', 2, '2026-08-01T00:00:00.000Z',
            2, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
          ),
          (
            'org-1', 'event-1', 'plan-1-revision-2',
            substr(replace(hex(zeroblob(100)), '00', 'x'), 1, 200),
            'open', 0, NULL,
            1, 5, NULL, 0, '[]', '[]', 2, '2026-08-02T00:00:00.000Z',
            2, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
          );
        INSERT INTO review_rounds (
          id, organization_id, event_id, plan_id, name, sequence, revision,
          rubric_id, rubric_revision, opens_at, closes_at, blind_review,
          anonymization, track_filter
        ) VALUES (
          'round-1-revision-2', 'org-1', 'event-1', 'plan-1-revision-2',
          'Committee review', 1, 2, 'rubric-1-revision-2', 2, NULL, NULL, 0,
          'none', NULL
        );
      `);

      database.executeScript(migration("0035_review_plan_revision_lineage.sql"));
      database.executeScript(migration("0037_review_plan_lineage_repairs.sql"));
      database.executeScript(migration("0038_review_plan_lineage_repair_triggers.sql"));
      database.executeScript(migration("0039_review_plan_revision_sync_lock.sql"));
      database.executeScript(migration("0040_review_plan_revision_sync_token.sql"));
      database.executeScript(migration("0054_review_round_lineage_candidates.sql"));

      database.executeScript(`
        INSERT INTO review_plans (
          organization_id, event_id, id, name, status, blind_review, closes_at,
          reviews_per_submission, max_assignments_per_reviewer, track_filter,
          auto_distribute, reviewer_projection_field_ids_json,
          reviewer_projection_file_ids_json, grading_revision, grading_locked_at,
          version, created_at, updated_at
        ) VALUES (
          'org-1', 'event-1', 'plan-1-revision-3', 'Late legacy revision', 'open', 0, NULL,
          1, 5, NULL, 0, '[]', '[]', 3, '2026-08-03T00:00:00.000Z',
          3, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'
        );
        INSERT INTO review_rounds (
          id, organization_id, event_id, plan_id, name, sequence, revision,
          rubric_id, rubric_revision, opens_at, closes_at, blind_review,
          anonymization, track_filter
        ) VALUES (
          'round-1-revision-3', 'org-1', 'event-1', 'plan-1-revision-3',
          'Committee review', 1, 3, 'rubric-1-revision-3', 3, NULL, NULL, 0,
          'none', NULL
        );
      `);

      const revisions = await database
        .prepare(
          `SELECT id, predecessor_plan_id
             FROM review_plans
            WHERE id = 'plan-1-revision-2'`,
        )
        .all<{ id: string; predecessor_plan_id: string | null }>();
      expect(revisions.results).toEqual([{ id: "plan-1-revision-2", predecessor_plan_id: null }]);
      const repairs = await database
        .prepare(
          `SELECT plan_id, round_id, reason
             FROM review_plan_lineage_repairs_required
            ORDER BY plan_id, round_id`,
        )
        .all<{ plan_id: string; round_id: string; reason: string }>();
      expect(repairs.results).toEqual([
        {
          plan_id: "plan-1-revision-2",
          round_id: "",
          reason: "missing_predecessor_plan",
        },
        {
          plan_id: "plan-1-revision-2",
          round_id: "round-1-revision-2",
          reason: "missing_predecessor_round",
        },
        {
          plan_id: "plan-1-revision-3",
          round_id: "",
          reason: "missing_predecessor_plan",
        },
        {
          plan_id: "plan-1-revision-3",
          round_id: "round-1-revision-3",
          reason: "missing_predecessor_round",
        },
      ]);
      database.executeScript(`
        UPDATE review_plans
           SET predecessor_plan_id = 'plan-1'
         WHERE organization_id = 'org-1'
           AND event_id = 'event-1'
           AND id = 'plan-1-revision-2';
        DELETE FROM review_plan_lineage_repairs_required
         WHERE organization_id = 'org-1'
           AND event_id = 'event-1'
           AND plan_id = 'plan-1-revision-2'
           AND round_id = '';
      `);
      const unresolvedRound = await database
        .prepare(
          `SELECT reason
             FROM review_plan_lineage_repairs_required
            WHERE organization_id = 'org-1'
              AND event_id = 'event-1'
              AND plan_id = 'plan-1-revision-2'
              AND round_id = 'round-1-revision-2'`,
        )
        .first<{ reason: string }>();
      expect(unresolvedRound).toEqual({ reason: "missing_predecessor_round" });
    } finally {
      database.dispose();
    }
  });

  it("does not classify an independent root containing the revision word as damaged", async () => {
    const database = new SqliteD1(
      "eventloom-review-lineage-root-",
      migration("0009_evaluations.sql"),
    );
    try {
      database.executeScript(`
        INSERT INTO review_plans (
          organization_id, event_id, id, name, status, blind_review, closes_at,
          reviews_per_submission, max_assignments_per_reviewer, track_filter,
          auto_distribute, reviewer_projection_field_ids_json,
          reviewer_projection_file_ids_json, grading_revision, grading_locked_at,
          version, created_at, updated_at
        ) VALUES (
          'org-1', 'event-1', 'plan-summit-revision-planning',
          'Revision planning', 'open', 0, NULL, 1, 5, NULL, 0, '[]', '[]',
          2, '2026-08-01T00:00:00.000Z', 2,
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        );
        INSERT INTO review_rounds (
          id, organization_id, event_id, plan_id, name, sequence, revision,
          rubric_id, rubric_revision, opens_at, closes_at, blind_review,
          anonymization, track_filter
        ) VALUES (
          'round-revision-planning', 'org-1', 'event-1',
          'plan-summit-revision-planning', 'Planning', 1, 2,
          'rubric-1', 2, '2026-08-01T00:00:00.000Z',
          '2026-08-31T00:00:00.000Z', 0, 'none', NULL
        );
      `);
      database.executeScript(migration("0035_review_plan_revision_lineage.sql"));
      database.executeScript(migration("0037_review_plan_lineage_repairs.sql"));
      database.executeScript(migration("0038_review_plan_lineage_repair_triggers.sql"));
      database.executeScript(migration("0039_review_plan_revision_sync_lock.sql"));
      database.executeScript(migration("0040_review_plan_revision_sync_token.sql"));
      database.executeScript(migration("0054_review_round_lineage_candidates.sql"));

      const remainingTriggers = await database
        .prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'trigger'
              AND name IN (
                'trg_review_plan_lineage_repair_insert',
                'trg_review_round_lineage_repair_insert'
              )
            ORDER BY name`,
        )
        .all<{ name: string }>();
      expect(remainingTriggers.results).toEqual([]);

      const repairs = await database
        .prepare(
          `SELECT plan_id, round_id
             FROM review_plan_lineage_repairs_required
            ORDER BY plan_id, round_id`,
        )
        .all<{ plan_id: string; round_id: string }>();
      expect(repairs.results).toEqual([]);
    } finally {
      database.dispose();
    }
  });

  it("resolves new-round markers while preserving and reactivating plausible missing lineage", async () => {
    const database = new SqliteD1(
      "eventloom-review-lineage-round-candidates-",
      migration("0009_evaluations.sql"),
    );
    const compactAncestorRoundId = `round-${"c".repeat(94)}`;
    const compactRoundPrefix = compactAncestorRoundId.slice(0, 80);
    const compactRoundId = `${compactRoundPrefix}-revision-2-a1b2c3d4`;
    const nextCompactRoundId = `${compactRoundPrefix}-revision-3-e5f6a7b8`;
    const noDigitCompactRoundPrefix = compactAncestorRoundId.slice(0, 81);
    const noDigitCompactRoundId = `${noDigitCompactRoundPrefix}-revision--a1b2c3d4`;
    const nextNoDigitCompactRoundId = `${noDigitCompactRoundPrefix}-revision--e5f6a7b8`;
    expect(compactRoundId).toHaveLength(100);
    expect(noDigitCompactRoundId).toHaveLength(100);
    try {
      database.executeScript(migration("0035_review_plan_revision_lineage.sql"));
      database.executeScript(migration("0037_review_plan_lineage_repairs.sql"));
      database.executeScript(migration("0038_review_plan_lineage_repair_triggers.sql"));
      database.executeScript(`
        INSERT INTO review_plans (
          organization_id, event_id, id, name, status, blind_review, closes_at,
          reviews_per_submission, max_assignments_per_reviewer, track_filter,
          auto_distribute, reviewer_projection_field_ids_json,
          reviewer_projection_file_ids_json, grading_revision, grading_locked_at,
          version, created_at, updated_at, predecessor_plan_id
        ) VALUES
          (
            'org-1', 'event-1', 'plan-1', 'Original', 'open', 0, NULL,
            1, 5, NULL, 0, '[]', '[]', 1, NULL, 1,
            '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL
          ),
          (
            'org-1', 'event-1', 'plan-1-revision-2', 'Revised', 'open', 0, NULL,
            1, 5, NULL, 0, '[]', '[]', 2, NULL, 2,
            '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'plan-1'
          );
        INSERT INTO review_rounds (
          id, organization_id, event_id, plan_id, name, sequence, revision,
          rubric_id, rubric_revision, opens_at, closes_at, blind_review,
          anonymization, track_filter, predecessor_round_id
        ) VALUES
          (
            'round-1', 'org-1', 'event-1', 'plan-1', 'Original round', 1, 1,
            'rubric-1', 1, NULL, NULL, 0, 'none', NULL, NULL
          ),
          (
            '${compactAncestorRoundId}', 'org-1', 'event-1', 'plan-1', 'Long original round', 2, 1,
            'rubric-1', 1, NULL, NULL, 0, 'none', NULL, NULL
          );
        INSERT INTO review_rounds (
          id, organization_id, event_id, plan_id, name, sequence, revision,
          rubric_id, rubric_revision, opens_at, closes_at, blind_review,
          anonymization, track_filter, predecessor_round_id
        ) VALUES
          (
            'round-2', 'org-1', 'event-1', 'plan-1-revision-2', 'New round', 2, 1,
            'rubric-1', 1, NULL, NULL, 0, 'none', NULL, NULL
          ),
          (
            'round-1-revision-2', 'org-1', 'event-1', 'plan-1-revision-2',
            'Missing predecessor', 1, 2, 'rubric-1', 2, NULL, NULL, 0, 'none', NULL, NULL
          ),
          (
            '${compactRoundId}', 'org-1', 'event-1', 'plan-1-revision-2',
            'Compact missing predecessor', 2, 2, 'rubric-1', 2, NULL, NULL, 0, 'none', NULL, NULL
          ),
          (
            '${noDigitCompactRoundId}', 'org-1', 'event-1', 'plan-1-revision-2',
            'Compact new round', 3, 1, 'rubric-1', 1, NULL, NULL, 0, 'none', NULL, NULL
          );
      `);

      database.executeScript(migration("0054_review_round_lineage_candidates.sql"));
      database.executeScript(`
        INSERT INTO review_rounds (
          id, organization_id, event_id, plan_id, name, sequence, revision,
          rubric_id, rubric_revision, opens_at, closes_at, blind_review,
          anonymization, track_filter, predecessor_round_id
        ) VALUES
          (
            'round-3', 'org-1', 'event-1', 'plan-1-revision-2', 'Another new round', 4, 1,
            'rubric-1', 1, NULL, NULL, 0, 'none', NULL, NULL
          ),
          (
            'round-1-revision-3', 'org-1', 'event-1', 'plan-1-revision-2',
            'Still missing predecessor', 1, 3, 'rubric-1', 3, NULL, NULL, 0, 'none', NULL, NULL
          ),
          (
            '${nextCompactRoundId}', 'org-1', 'event-1', 'plan-1-revision-2',
            'Still compact missing predecessor', 2, 3, 'rubric-1', 3, NULL, NULL, 0, 'none', NULL, NULL
          ),
          (
            '${nextNoDigitCompactRoundId}', 'org-1', 'event-1', 'plan-1-revision-2',
            'Another compact new round', 5, 1, 'rubric-1', 1, NULL, NULL, 0, 'none', NULL, NULL
          );
        INSERT INTO review_plan_lineage_repairs_required (
          organization_id, event_id, plan_id, round_id, reason, detected_at
        ) VALUES (
          'org-1', 'event-1', 'plan-1-revision-2', 'round-1-revision-4',
          'resolved_new_round', '2000-01-01T00:00:00.000Z'
        );
        INSERT INTO review_rounds (
          id, organization_id, event_id, plan_id, name, sequence, revision,
          rubric_id, rubric_revision, opens_at, closes_at, blind_review,
          anonymization, track_filter, predecessor_round_id
        ) VALUES (
          'round-1-revision-4', 'org-1', 'event-1', 'plan-1-revision-2',
          'Reactivated missing predecessor', 1, 4, 'rubric-1', 4, NULL, NULL, 0, 'none', NULL, NULL
        );
      `);

      const repairs = await database
        .prepare(
          `SELECT plan_id, round_id, reason
             FROM review_plan_lineage_repairs_required
            ORDER BY round_id`,
        )
        .all<{ plan_id: string; round_id: string; reason: string }>();
      expect(repairs.results).toEqual([
        {
          plan_id: "plan-1-revision-2",
          round_id: "round-1-revision-2",
          reason: "missing_predecessor_round",
        },
        {
          plan_id: "plan-1-revision-2",
          round_id: "round-1-revision-3",
          reason: "missing_predecessor_round",
        },
        {
          plan_id: "plan-1-revision-2",
          round_id: "round-1-revision-4",
          reason: "missing_predecessor_round",
        },
        {
          plan_id: "plan-1-revision-2",
          round_id: "round-2",
          reason: "resolved_new_round",
        },
        {
          plan_id: "plan-1-revision-2",
          round_id: compactRoundId,
          reason: "missing_predecessor_round",
        },
        {
          plan_id: "plan-1-revision-2",
          round_id: nextCompactRoundId,
          reason: "missing_predecessor_round",
        },
        {
          plan_id: "plan-1-revision-2",
          round_id: noDigitCompactRoundId,
          reason: "resolved_new_round",
        },
      ]);
      const reactivated = await database
        .prepare(
          `SELECT reason, detected_at
             FROM review_plan_lineage_repairs_required
            WHERE organization_id = 'org-1'
              AND event_id = 'event-1'
              AND plan_id = 'plan-1-revision-2'
              AND round_id = 'round-1-revision-4'`,
        )
        .first<{ reason: string; detected_at: string }>();
      expect(reactivated).toMatchObject({ reason: "missing_predecessor_round" });
      expect(reactivated?.detected_at).not.toBe("2000-01-01T00:00:00.000Z");
    } finally {
      database.dispose();
    }
  });
  it("records max-length truncated legacy plan revisions without false round markers", async () => {
    const database = new SqliteD1(
      "eventloom-review-lineage-truncated-",
      migration("0009_evaluations.sql"),
    );
    const ancestorPlanId = `plan-${"a".repeat(95)}`;
    const childPlanId = `${ancestorPlanId.slice(0, 89)}-revision-7`;
    const ancestorRoundId = `round-${"b".repeat(94)}`;
    const childRoundId = `${ancestorRoundId.slice(0, 89)}-revision-7`;
    try {
      database.executeScript(`
        INSERT INTO review_plans (
          organization_id, event_id, id, name, status, blind_review, closes_at,
          reviews_per_submission, max_assignments_per_reviewer, track_filter,
          auto_distribute, reviewer_projection_field_ids_json,
          reviewer_projection_file_ids_json, grading_revision, grading_locked_at,
          version, created_at, updated_at
        ) VALUES
          (
            'org-1', 'event-1', '${ancestorPlanId}', 'Ancestor', 'open', 0, NULL,
            1, 5, NULL, 0, '[]', '[]', 7, '2026-08-01T00:00:00.000Z',
            7, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
          ),
          (
            'org-1', 'event-1', '${childPlanId}', 'Truncated child', 'open', 0, NULL,
            1, 5, NULL, 0, '[]', '[]', 1, '2026-08-02T00:00:00.000Z',
            1, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
          );
        INSERT INTO review_rounds (
          id, organization_id, event_id, plan_id, name, sequence, revision,
          rubric_id, rubric_revision, opens_at, closes_at, blind_review,
          anonymization, track_filter
        ) VALUES
          (
            '${ancestorRoundId}', 'org-1', 'event-1', '${ancestorPlanId}',
            'Ancestor round', 1, 7, 'rubric-ancestor', 7, NULL, NULL, 0, 'none', NULL
          ),
          (
            '${childRoundId}', 'org-1', 'event-1', '${childPlanId}',
            'Truncated child round', 1, 1, 'rubric-child', 1, NULL, NULL, 0, 'none', NULL
          );
      `);

      database.executeScript(migration("0035_review_plan_revision_lineage.sql"));
      database.executeScript(migration("0037_review_plan_lineage_repairs.sql"));
      database.executeScript(migration("0038_review_plan_lineage_repair_triggers.sql"));
      database.executeScript(migration("0039_review_plan_revision_sync_lock.sql"));
      database.executeScript(migration("0040_review_plan_revision_sync_token.sql"));
      database.executeScript(migration("0054_review_round_lineage_candidates.sql"));

      const repairs = await database
        .prepare(
          `SELECT plan_id, round_id, reason
             FROM review_plan_lineage_repairs_required
            ORDER BY plan_id, round_id`,
        )
        .all<{ plan_id: string; round_id: string; reason: string }>();
      expect(repairs.results).toEqual([
        {
          plan_id: childPlanId,
          round_id: "",
          reason: "missing_predecessor_plan",
        },
        {
          plan_id: childPlanId,
          round_id: childRoundId,
          reason: "missing_predecessor_round",
        },
      ]);
    } finally {
      database.dispose();
    }
  });
});
