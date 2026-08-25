"use client";
import type { OrganizationMember } from "../../members/api";
import { reviewerIdsForAssignmentTarget } from "./assignment-reviewer-ids-for-assignment-target";
import { normalizeCompletionPercent } from "./model-normalize-completion-percent";
import { reviewerDisplayLabel } from "./model-reviewer-display-label";
import type { AggregateRow } from "./organizer-aggregate-row";
import type { DecisionStatus } from "./organizer-decision-status";
import { formatDecisionStatus } from "./organizer-format-decision-status";
import type { ReviewPlanSeed } from "./organizer-review-plan-seed";

export function deriveOrganizerWorkspaceModel({
  seed,
  roundAggregates,
  aggregateSort,
  decisionFilter,
  decisionQuery,
  decisionRowLimit,
  selectedDecisionId,
  selectedRound,
  selectedRoundId,
  resultScopeIsActive,
  reviewerMembers,
}: {
  seed: ReviewPlanSeed;
  roundAggregates: readonly AggregateRow[];
  aggregateSort: "ascending" | "descending";
  decisionFilter: "all" | "undecided" | DecisionStatus;
  decisionQuery: string;
  decisionRowLimit: number;
  selectedDecisionId: string | null;
  selectedRound: ReviewPlanSeed["rounds"][number] | undefined;
  selectedRoundId: string;
  resultScopeIsActive: boolean;
  reviewerMembers: readonly OrganizationMember[];
}) {
  const sortedAggregates = [...roundAggregates].sort((left, right) => {
    const leftScore = Number(left.countedScore);
    const rightScore = Number(right.countedScore);
    const leftHasScore = Number.isFinite(leftScore);
    const rightHasScore = Number.isFinite(rightScore);
    if (leftHasScore !== rightHasScore) return leftHasScore ? -1 : 1;
    if (leftHasScore && rightHasScore && leftScore !== rightScore) {
      return aggregateSort === "descending" ? rightScore - leftScore : leftScore - rightScore;
    }
    return left.reference.localeCompare(right.reference);
  });
  const filteredDecisionRows = sortedAggregates.filter((aggregate) => {
    const decision = resultScopeIsActive ? seed.decisionBySubmission[aggregate.id] : undefined;
    const matchesStatus =
      decisionFilter === "all"
        ? true
        : decisionFilter === "undecided"
          ? decision === undefined
          : decision?.status === decisionFilter;
    if (!matchesStatus) return false;
    const query = decisionQuery.trim().toLocaleLowerCase();
    if (query.length === 0) return true;
    return [
      aggregate.reference,
      aggregate.title,
      ...(aggregate.participants ?? []).map(({ displayName }) => displayName),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  });
  const visibleDecisionRows = filteredDecisionRows.slice(0, decisionRowLimit);
  const selectedAggregate =
    selectedDecisionId === null
      ? undefined
      : roundAggregates.find((aggregate) => aggregate.id === selectedDecisionId);
  const overviewRows = [...roundAggregates]
    .map((aggregate) => {
      const roundId = aggregate.roundId ?? selectedRound?.id ?? selectedRoundId;
      const reviewerIds = reviewerIdsForAssignmentTarget(seed.assignments, roundId, aggregate.id);
      const expectedReviewCount = Math.max(
        seed.assignmentRule.reviewsPerSubmission,
        aggregate.expectedReviews,
      );
      const decision = resultScopeIsActive ? seed.decisionBySubmission[aggregate.id] : undefined;
      let attentionKind: "none" | "assignment" | "completion" | "conflict" | "decision" = "none";
      let attentionLabel = "Complete";
      if (aggregate.conflicts > 0) {
        attentionKind = "conflict";
        attentionLabel = `${aggregate.conflicts} conflict${aggregate.conflicts === 1 ? "" : "s"}`;
      } else if (reviewerIds.length < expectedReviewCount) {
        const missingReviewers = expectedReviewCount - reviewerIds.length;
        attentionKind = "assignment";
        attentionLabel = `${missingReviewers} reviewer slot${missingReviewers === 1 ? "" : "s"} open`;
      } else if (aggregate.countedReviews < expectedReviewCount) {
        attentionKind = "completion";
        attentionLabel = "Reviews in progress";
      } else if (decision === undefined) {
        attentionKind = "decision";
        attentionLabel = "Decision needed";
      }
      return {
        id: aggregate.id,
        reference: aggregate.reference,
        title: aggregate.title,
        roundName: selectedRound?.name ?? selectedRoundId,
        assignedReviewerCount: reviewerIds.length,
        expectedReviewerCount: expectedReviewCount,
        completedReviewCount: aggregate.countedReviews,
        expectedReviewCount,
        weightedScoreLabel:
          aggregate.possibleScore === "—"
            ? aggregate.countedScore
            : `${aggregate.countedScore} / ${aggregate.possibleScore}`,
        conflictCount: aggregate.conflicts,
        decisionLabel:
          decision === undefined ? "Not decided" : formatDecisionStatus(decision.status),
        attentionKind,
        attentionLabel,
        reviewerDisplayNames: reviewerIds.map((reviewerId) =>
          reviewerDisplayLabel(reviewerId, reviewerMembers),
        ),
        manageable: resultScopeIsActive,
        ...(resultScopeIsActive
          ? {
              attentionAction:
                attentionKind === "decision"
                  ? ({ label: "Record decision", target: "decisions" } as const)
                  : ({ label: "Manage reviewers", target: "reviewers" } as const),
            }
          : {}),
      };
    })
    .sort(
      (left, right) =>
        left.reference.localeCompare(right.reference) || left.id.localeCompare(right.id),
    );
  const overviewExpectedReviewCount = overviewRows.reduce(
    (total, row) => total + row.expectedReviewCount,
    0,
  );
  const overviewAssignedReviewerCount = overviewRows.reduce(
    (total, row) => total + row.assignedReviewerCount,
    0,
  );
  const overviewCompletedReviewCount = overviewRows.reduce(
    (total, row) => total + row.completedReviewCount,
    0,
  );
  const overviewDecisionCount = overviewRows.filter(
    (row) => row.decisionLabel !== "Not decided",
  ).length;
  const overviewAttentionCount = overviewRows.filter((row) => row.attentionKind !== "none").length;
  const overviewCompletionPercent = normalizeCompletionPercent(seed.progress.completionPercent);
  const overviewMetrics = [
    {
      label: "Review window",
      value: seed.opensAt,
      detail: `Closes ${seed.closesAt}`,
    },
    {
      label: "Reviewer coverage",
      value: `${overviewAssignedReviewerCount}/${overviewExpectedReviewCount}`,
      detail: "reviewer slots assigned",
    },
    {
      label: "Review completion",
      value: `${overviewCompletionPercent}%`,
      detail: `${overviewCompletedReviewCount} of ${overviewExpectedReviewCount} reviews submitted`,
    },
    {
      label: "Decisions",
      value: `${overviewDecisionCount}/${overviewRows.length}`,
      detail: "submissions decided",
    },
  ];
  const overviewAttentionSummary = {
    count: overviewAttentionCount,
    label:
      overviewAttentionCount === 1 ? "submission needs attention" : "submissions need attention",
    description:
      overviewAttentionCount === 0
        ? `${seed.progress.conflicts} conflicts declared. Coverage, review completion, and decisions are up to date.`
        : `${seed.progress.conflicts} conflicts declared. Use row actions to resolve coverage, review progress, conflicts, or decisions.`,
  };

  return {
    sortedAggregates,
    filteredDecisionRows,
    visibleDecisionRows,
    selectedAggregate,
    overviewRows,
    overviewCompletionPercent,
    overviewMetrics,
    overviewAttentionSummary,
  };
}
