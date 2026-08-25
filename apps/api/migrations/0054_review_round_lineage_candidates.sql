PRAGMA foreign_keys = ON;

DROP TRIGGER IF EXISTS trg_review_round_lineage_repair_candidate;

UPDATE review_plan_lineage_repairs_required
SET reason = 'resolved_new_round'
WHERE reason = 'missing_predecessor_round'
  AND NOT EXISTS (
    SELECT 1
    FROM review_plan_lineage_repairs_required AS plan_repair
    WHERE plan_repair.organization_id = review_plan_lineage_repairs_required.organization_id
      AND plan_repair.event_id = review_plan_lineage_repairs_required.event_id
      AND plan_repair.plan_id = review_plan_lineage_repairs_required.plan_id
      AND plan_repair.round_id = ''
      AND plan_repair.reason = 'missing_predecessor_plan'
  )
  AND EXISTS (
    SELECT 1
    FROM review_rounds AS child_round
    WHERE child_round.organization_id = review_plan_lineage_repairs_required.organization_id
      AND child_round.event_id = review_plan_lineage_repairs_required.event_id
      AND child_round.plan_id = review_plan_lineage_repairs_required.plan_id
      AND child_round.id = review_plan_lineage_repairs_required.round_id
      AND child_round.predecessor_round_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM review_rounds AS child_round
    JOIN review_plans AS child_plan
      ON child_plan.organization_id = child_round.organization_id
      AND child_plan.event_id = child_round.event_id
      AND child_plan.id = child_round.plan_id
    JOIN review_rounds AS possible_ancestor
      ON possible_ancestor.organization_id = child_round.organization_id
      AND possible_ancestor.event_id = child_round.event_id
      AND possible_ancestor.plan_id = child_plan.predecessor_plan_id
    WHERE child_round.organization_id = review_plan_lineage_repairs_required.organization_id
      AND child_round.event_id = review_plan_lineage_repairs_required.event_id
      AND child_round.plan_id = review_plan_lineage_repairs_required.plan_id
      AND child_round.id = review_plan_lineage_repairs_required.round_id
      AND child_round.predecessor_round_id IS NULL
      AND (
        (
          length(child_round.id) > length(rtrim(child_round.id, '0123456789'))
          AND substr(rtrim(child_round.id, '0123456789'), -10) = '-revision-'
          AND (
            possible_ancestor.id = substr(
              child_round.id,
              1,
              length(rtrim(child_round.id, '0123456789')) - 10
            )
            OR (
              length(child_round.id) = 100
              AND length(possible_ancestor.id) > length(rtrim(child_round.id, '0123456789')) - 10
              AND substr(
                possible_ancestor.id,
                1,
                length(rtrim(child_round.id, '0123456789')) - 10
              ) = substr(
                child_round.id,
                1,
                length(rtrim(child_round.id, '0123456789')) - 10
              )
            )
          )
        )
        OR (
          length(child_round.id) = 100
          AND substr(child_round.id, -9, 1) = '-'
          AND lower(substr(child_round.id, -8)) NOT GLOB '*[^0-9a-f]*'
          AND substr(
            rtrim(substr(child_round.id, 1, length(child_round.id) - 9), '0123456789'),
            -10
          ) = '-revision-'
          AND length(
            rtrim(substr(child_round.id, 1, length(child_round.id) - 9), '0123456789')
          ) > 10
          AND length(substr(child_round.id, 1, length(child_round.id) - 9))
            > length(rtrim(substr(child_round.id, 1, length(child_round.id) - 9), '0123456789'))
          AND length(possible_ancestor.id) > length(
            rtrim(substr(child_round.id, 1, length(child_round.id) - 9), '0123456789')
          ) - 10
          AND substr(
            possible_ancestor.id,
            1,
            length(rtrim(substr(child_round.id, 1, length(child_round.id) - 9), '0123456789')) - 10
          ) = substr(
            child_round.id,
            1,
            length(rtrim(substr(child_round.id, 1, length(child_round.id) - 9), '0123456789')) - 10
          )
        )
      )
  );

CREATE TRIGGER trg_review_round_lineage_repair_candidate
AFTER INSERT ON review_rounds
WHEN NEW.predecessor_round_id IS NULL
  AND (
    EXISTS (
      SELECT 1
      FROM review_plans AS child_plan
      JOIN review_rounds AS possible_ancestor
        ON possible_ancestor.organization_id = NEW.organization_id
        AND possible_ancestor.event_id = NEW.event_id
        AND possible_ancestor.plan_id = child_plan.predecessor_plan_id
      WHERE child_plan.organization_id = NEW.organization_id
        AND child_plan.event_id = NEW.event_id
        AND child_plan.id = NEW.plan_id
        AND child_plan.predecessor_plan_id IS NOT NULL
        AND (
          (
            length(NEW.id) > length(rtrim(NEW.id, '0123456789'))
            AND substr(rtrim(NEW.id, '0123456789'), -10) = '-revision-'
            AND (
              possible_ancestor.id = substr(
                NEW.id,
                1,
                length(rtrim(NEW.id, '0123456789')) - 10
              )
              OR (
                length(NEW.id) = 100
                AND length(possible_ancestor.id) > length(rtrim(NEW.id, '0123456789')) - 10
                AND substr(
                  possible_ancestor.id,
                  1,
                  length(rtrim(NEW.id, '0123456789')) - 10
                ) = substr(
                  NEW.id,
                  1,
                  length(rtrim(NEW.id, '0123456789')) - 10
                )
              )
            )
          )
          OR (
            length(NEW.id) = 100
            AND substr(NEW.id, -9, 1) = '-'
            AND lower(substr(NEW.id, -8)) NOT GLOB '*[^0-9a-f]*'
            AND substr(
              rtrim(substr(NEW.id, 1, length(NEW.id) - 9), '0123456789'),
              -10
            ) = '-revision-'
            AND length(
              rtrim(substr(NEW.id, 1, length(NEW.id) - 9), '0123456789')
            ) > 10
            AND length(substr(NEW.id, 1, length(NEW.id) - 9))
              > length(rtrim(substr(NEW.id, 1, length(NEW.id) - 9), '0123456789'))
            AND length(possible_ancestor.id) > length(
              rtrim(substr(NEW.id, 1, length(NEW.id) - 9), '0123456789')
            ) - 10
            AND substr(
              possible_ancestor.id,
              1,
              length(rtrim(substr(NEW.id, 1, length(NEW.id) - 9), '0123456789')) - 10
            ) = substr(
              NEW.id,
              1,
              length(rtrim(substr(NEW.id, 1, length(NEW.id) - 9), '0123456789')) - 10
            )
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM review_plans AS child_plan
      JOIN review_plan_lineage_repairs_required AS plan_repair
        ON plan_repair.organization_id = child_plan.organization_id
        AND plan_repair.event_id = child_plan.event_id
        AND plan_repair.plan_id = child_plan.id
        AND plan_repair.round_id = ''
        AND plan_repair.reason = 'missing_predecessor_plan'
      WHERE child_plan.organization_id = NEW.organization_id
        AND child_plan.event_id = NEW.event_id
        AND child_plan.id = NEW.plan_id
        AND child_plan.predecessor_plan_id IS NULL
        AND (
          (
            length(NEW.id) > length(rtrim(NEW.id, '0123456789'))
            AND substr(rtrim(NEW.id, '0123456789'), -10) = '-revision-'
          )
          OR (
            length(NEW.id) = 100
            AND substr(NEW.id, -9, 1) = '-'
            AND lower(substr(NEW.id, -8)) NOT GLOB '*[^0-9a-f]*'
            AND substr(
              rtrim(substr(NEW.id, 1, length(NEW.id) - 9), '0123456789'),
              -10
            ) = '-revision-'
            AND length(
              rtrim(substr(NEW.id, 1, length(NEW.id) - 9), '0123456789')
            ) > 10
            AND length(substr(NEW.id, 1, length(NEW.id) - 9))
              > length(rtrim(substr(NEW.id, 1, length(NEW.id) - 9), '0123456789'))
          )
        )
    )
  )
BEGIN
  INSERT INTO review_plan_lineage_repairs_required (
    organization_id, event_id, plan_id, round_id, reason
  )
  VALUES (
    NEW.organization_id,
    NEW.event_id,
    NEW.plan_id,
    NEW.id,
    'missing_predecessor_round'
  )
  ON CONFLICT (organization_id, event_id, plan_id, round_id) DO UPDATE SET
    reason = 'missing_predecessor_round',
    detected_at = CURRENT_TIMESTAMP
  WHERE review_plan_lineage_repairs_required.reason = 'resolved_new_round';
END;
