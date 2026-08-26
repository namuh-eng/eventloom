"use client";

import type { ApiOrganizerResultScope } from "./api-api-organizer-workspace-response";
import type { ApiPlan } from "./api-api-plan";
import type { ApiSubmittedReview } from "./api-api-submitted-review";
import type { ReviewPlanAssignment } from "./assignment-review-plan-assignment";
import type { AggregateRow } from "./organizer-aggregate-row";
import type { DecisionStatus } from "./organizer-decision-status";
import type { PlanStatus } from "./organizer-plan-status";
import type { ReviewRound } from "./organizer-review-round";
import type { ReviewerProgressSummary } from "./progress-reviewer-progress-summary";

export interface ReviewPlanSeed {
  planId: string;
  version: number;
  decisionBySubmission: Readonly<
    Record<
      string,
      {
        readonly status: DecisionStatus;
        readonly reason: string;
        readonly version: number;
      }
    >
  >;
  eventId: string;
  eventName: string;
  eventTimeZone?: string | undefined;
  eventStartsAt?: string | undefined;
  eventEndsAt?: string | undefined;
  planName: string;
  status: PlanStatus;
  opensAt: string;
  closesAt: string;
  blindReview: boolean;
  assignmentRule: {
    reviewsPerSubmission: number;
    maxAssignmentsPerReviewer: number;
    trackFilter?: string | null | undefined;
    autoDistribute?: boolean | undefined;
  };
  rounds: readonly ReviewRound[];
  reviewerProjection?: {
    readonly fieldIds: readonly string[];
    readonly fileIds: readonly string[];
  };
  sourceRounds?: ApiPlan["rounds"];
  sourceClosesAt?: string | null;
  aggregates: readonly AggregateRow[];
  submittedReviews: readonly ApiSubmittedReview[];
  resultScopes?: readonly ApiOrganizerResultScope[];
  assignments: readonly ReviewPlanAssignment[];
  progress: {
    totalAssignments: number;
    assigned: number;
    inProgress: number;
    submitted: number;
    abstained: number;
    conflicts: number;
    completionPercent: number;
    reviewers: readonly ReviewerProgressSummary[];
  };
}
