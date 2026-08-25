"use client";

import type { ApiAggregate } from "./api-api-aggregate";
import type { ApiAssignment } from "./api-api-assignment";
import type { ApiDecision } from "./api-api-decision";
import type { ApiPlan } from "./api-api-plan";
import type { ApiProgress } from "./api-api-progress";
import type { ApiSubmission } from "./api-api-submission";
import type { ApiSubmittedReview } from "./api-api-submitted-review";

export interface ApiEvaluationEventMetadata {
  readonly id: string;
  readonly name: string;
  readonly timeZone: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface ApiOrganizerResultScope {
  readonly planId: string;
  readonly planVersion: number;
  readonly lineageOrdinal: number;
  readonly planName: string;
  readonly roundId: string;
  readonly roundName: string;
  readonly sequence: number;
  readonly historical: boolean;
}

export interface ApiOrganizerWorkspaceResponse {
  readonly event: ApiEvaluationEventMetadata;
  readonly plan: ApiPlan;
  readonly submissions: readonly ApiSubmission[];
  readonly assignments: readonly ApiAssignment[];
  readonly progress: ApiProgress;
  readonly resultScopes: readonly ApiOrganizerResultScope[];
  readonly aggregates: readonly ApiAggregate[];
  readonly submittedReviews: readonly ApiSubmittedReview[];
  readonly decisions: Readonly<Record<string, ApiDecision>>;
}
