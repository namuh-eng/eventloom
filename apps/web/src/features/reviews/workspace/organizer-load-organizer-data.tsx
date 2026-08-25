"use client";

import type { ApiOrganizerWorkspaceResponse } from "./api-api-organizer-workspace-response";
import type { ApiProgress } from "./api-api-progress";
import type { ApiSubmission } from "./api-api-submission";
import { EvaluationRequestError } from "./api-evaluation-request-error";
import { MissingEvaluationPlanError } from "./api-missing-evaluation-plan-error";
import { evaluationRequest } from "./model-evaluation-request";
import { normalizeApiSubmission } from "./model-normalize-api-submission";
import { mapPlan } from "./organizer-map-plan";
import { mapRoundAggregates } from "./organizer-map-round-aggregates";
import { normalizeApiPlan } from "./organizer-normalize-api-plan";
import type { ReviewPlanSeed } from "./organizer-review-plan-seed";
import { deriveReviewerProgress } from "./progress-derive-reviewer-progress";

export async function loadOrganizerData(
  eventId: string,
  baseUrl: string,
  preferredPlanId?: string,
): Promise<ReviewPlanSeed> {
  const planQuery =
    preferredPlanId === undefined ? "" : `&planId=${encodeURIComponent(preferredPlanId)}`;
  let workspace: ApiOrganizerWorkspaceResponse;
  try {
    workspace = await evaluationRequest<ApiOrganizerWorkspaceResponse>(
      baseUrl,
      `/organizer/workspace?eventId=${encodeURIComponent(eventId)}${planQuery}`,
    );
  } catch (reason: unknown) {
    if (reason instanceof EvaluationRequestError && reason.status === 404) {
      throw new MissingEvaluationPlanError();
    }
    throw reason;
  }
  const plan = normalizeApiPlan(workspace.plan);
  const assignments = workspace.assignments.filter((assignment) => assignment.planId === plan.id);
  const aggregates = workspace.aggregates.filter((aggregate) => aggregate.planId === plan.id);
  const mappedProgress: ApiProgress = {
    ...workspace.progress,
    reviewers: workspace.progress.reviewers ?? deriveReviewerProgress(assignments),
  };
  const uniqueSubmissions = [
    ...new Map(
      workspace.submissions
        .map(normalizeApiSubmission)
        .filter((submission): submission is ApiSubmission => submission !== null)
        .map((submission) => [submission.id, submission] as const),
    ).values(),
  ];
  const aggregateRoundId = aggregates[0]?.roundId;
  const round =
    plan.rounds.find((candidate) => candidate.id === aggregateRoundId) ??
    [...plan.rounds]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (candidate) =>
          plan.status === "open" &&
          (candidate.opensAt === null ||
            candidate.opensAt === undefined ||
            Date.parse(candidate.opensAt) <= Date.now()) &&
          (candidate.closesAt === null || Date.parse(candidate.closesAt) > Date.now()),
      ) ??
    [...plan.rounds].sort((left, right) => left.sequence - right.sequence)[0];
  const selectedRoundId = round?.id ?? aggregateRoundId ?? "";
  const aggregateEntries = mapRoundAggregates(
    uniqueSubmissions,
    assignments,
    aggregates,
    selectedRoundId,
  );
  return {
    ...mapPlan(plan, eventId, aggregateEntries, mappedProgress, workspace.decisions, assignments),
    resultScopes: workspace.resultScopes,
    submittedReviews: workspace.submittedReviews,
    eventName: workspace.event.name,
    eventTimeZone: workspace.event.timeZone,
    eventStartsAt: workspace.event.startsAt,
    eventEndsAt: workspace.event.endsAt,
  };
}
