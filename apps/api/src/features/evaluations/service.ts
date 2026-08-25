import { localDateInTimeZone } from "@eventloom/contracts";
import { z } from "zod";
import {
  advisoryUnavailable,
  advisoryUnsupported,
  closed,
  conflict,
  EvaluationError,
  forbidden,
  invalidInput,
  notFound,
} from "./errors";
import type { EvaluationRepository, SubmissionReviewSource } from "./repository";
import { MAX_REVISION_DEPTH, revisionScheduleSnapshot } from "./revision-schedule-sync";
import {
  isEnglishSuggestionRationale,
  isMeaningfulSuggestionRationale,
  parseSubmissionExcerptReference,
  scoreableRubricCriteria,
} from "./suggestion-validation";
import type {
  EvaluationActor,
  EvaluationAggregate,
  EvaluationAiSuggestionProvider,
  EvaluationAssignment,
  EvaluationAssignmentDistributionResult,
  EvaluationAssignmentReplacementResult,
  EvaluationAssignmentScope,
  EvaluationConflictDeclaration,
  EvaluationDecision,
  EvaluationDecisionCommunicationProjection,
  EvaluationDecisionCommunicationTemplatePurpose,
  EvaluationDecisionProjectionData,
  EvaluationDecisionStatus,
  EvaluationDecisionTransition,
  EvaluationDistributionPreview,
  EvaluationGrant,
  EvaluationParticipantOutcomeProjection,
  EvaluationPlan,
  EvaluationProgress,
  EvaluationReview,
  EvaluationReviewerProjection,
  EvaluationReviewHistory,
  EvaluationSuggestion,
  EvaluationSuggestionAuditEntry,
  EvaluationSuggestionCandidate,
  EvaluationSuggestionProducer,
  EvaluationSuggestionProvenance,
  EvaluationSuggestionProviderInput,
  EvaluationSuggestionProviderResult,
  ReviewContext,
  ReviewRound,
  Rubric,
  RubricCriterion,
  RubricScore,
  RubricTotal,
  SubmissionReviewMaterial,
} from "./types";

const revisionSyncTokenSchema = z.string().uuid();

const MAX_SUBMISSION_ID_LENGTH = 128;

export interface CreateEvaluationPlanInput {
  id: string;
  eventId: string;
  name: string;
  blindReview: boolean;
  closesAt: string | null;
  assignmentRule: {
    reviewsPerSubmission: number;
    maxAssignmentsPerReviewer: number;
    readonly trackFilter?: string | null | undefined;
    readonly autoDistribute?: boolean | undefined;
  };
  rounds: readonly ReviewRound[];
  reviewerProjection?: EvaluationReviewerProjection | undefined;
  evaluatorProjection?: EvaluationReviewerProjection | undefined;
  projection?: EvaluationReviewerProjection | undefined;
}

export interface UpdateEvaluationPlanInput {
  readonly expectedVersion: number;
  readonly name?: string | undefined;
  readonly blindReview?: boolean | undefined;
  readonly closesAt?: string | null | undefined;
  readonly assignmentRule?:
    | {
        readonly reviewsPerSubmission: number;
        readonly maxAssignmentsPerReviewer: number;
        readonly trackFilter?: string | null | undefined;
        readonly autoDistribute?: boolean | undefined;
      }
    | undefined;
  readonly rounds?: readonly ReviewRound[] | undefined;
  readonly reviewerProjection?: EvaluationReviewerProjection | undefined;
  readonly evaluatorProjection?: EvaluationReviewerProjection | undefined;
  readonly projection?: EvaluationReviewerProjection | undefined;
}

export interface ReviseEvaluationPlanInput {
  readonly expectedVersion: number;
}

export interface GenerateEvaluationSuggestionsInput {
  /** Legacy caller path; when absent, planId + roundId + submissionId scope applies. */
  readonly assignmentId?: string;
  readonly planId?: string;
  readonly roundId?: string;
  readonly submissionId?: string;
  readonly regenerate?: boolean;
}

export interface OverrideAiSuggestionInput {
  readonly expectedVersion: number;
  readonly valueByCriterion: Readonly<Record<string, number | string>>;
  readonly reason?: string | undefined;
}

export interface GenerateRoundAiSuggestionsInput {
  readonly planId: string;
  readonly roundId: string;
  readonly submissionId: string;
  readonly regenerate?: boolean;
}

export interface EvaluationAcceptanceHandoffInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly planId: string;
  readonly submissionId: string;
  readonly decisionId: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly decisionVersion?: number;
  readonly isCurrentDecision?: () => Promise<boolean>;
  readonly decisionFence?: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly planId: string;
    readonly submissionId: string;
    readonly version: number;
    readonly status: "accepted";
  };
}
export interface EvaluationSessionDecisionReconciliationInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly planId: string;
  readonly submissionId: string;
  readonly decisionId: string;
  readonly status: Exclude<EvaluationDecisionStatus, "accepted">;
  readonly decisionVersion: number;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly isCurrentDecision?: () => Promise<boolean>;
  readonly decisionFence: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly planId: string;
    readonly submissionId: string;
    readonly version: number;
    readonly status: "waitlisted" | "rejected";
  };
}
export interface EvaluationDecisionProjectionInput extends EvaluationDecisionProjectionData {
  readonly tenantId: string;
  readonly eventId: string;
  readonly planId: string;
  readonly submissionId: string;
  readonly decisionId: string;
  readonly decisionVersion: number;
  readonly status: EvaluationDecisionStatus;
  readonly priorStatus: EvaluationDecisionStatus | null;
  readonly reason: string;
  readonly decidedByUserId: string;
  readonly decidedAt: string;
  readonly idempotencyKey: string;
  readonly participantProjection: EvaluationParticipantOutcomeProjection;
  readonly communication: EvaluationDecisionCommunicationProjection;
  readonly isCurrentDecision?: () => Promise<boolean>;
}

export interface EvaluationDecisionProjection {
  projectDecision(input: EvaluationDecisionProjectionInput): Promise<void>;
}

export interface EvaluationAcceptanceHandoff {
  accept(input: EvaluationAcceptanceHandoffInput): Promise<void>;
  reconcileSessionDecision?(input: EvaluationSessionDecisionReconciliationInput): Promise<void>;
}

export interface EvaluationSubmissionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly title: string;
  readonly abstract: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly participants: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly email: string;
    readonly biography: string;
  }[];
  readonly status: string;
  readonly version?: number;
  readonly revision?: number;
  readonly submittedAt: string | null;
  readonly updatedAt: string;
  readonly reopenedAt: string | null;
}

export interface EvaluationSubmissionSource {
  listSubmissionsForOrganizer?(
    tenantId: string,
    eventId: string,
  ): Promise<readonly EvaluationSubmissionRecord[]>;
  reopenSubmission?(
    tenantId: string,
    eventId: string,
    submissionId: string,
    input: {
      readonly organizerId: string;
      readonly expectedVersion: number;
      readonly reason: string;
      readonly idempotencyKey: string;
    },
  ): Promise<EvaluationSubmissionRecord>;
}
export interface EvaluationReviewerWorkspacePlan {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly name: string;
  readonly status: EvaluationPlan["status"];
  readonly blindReview: boolean;
  readonly closesAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvaluationReviewerWorkspaceAssignment extends ReviewContext {
  readonly plan: EvaluationReviewerWorkspacePlan;
}

export interface EvaluationReviewerWorkspace {
  readonly assignments: readonly EvaluationReviewerWorkspaceAssignment[];
}
export interface EvaluationOrganizerResultScope {
  readonly planId: string;
  readonly planVersion: number;
  readonly lineageOrdinal: number;
  readonly planName: string;
  readonly roundId: string;
  readonly roundName: string;
  readonly sequence: number;
  readonly historical: boolean;
}
export interface EvaluationOrganizerSubmittedReview {
  readonly id: string;
  readonly planId: string;
  readonly roundId: string;
  readonly submissionId: string;
  readonly reviewerId: string;
  readonly comment: string;
  readonly submittedAt: string;
}
export interface EvaluationOrganizerWorkspace {
  readonly event: EvaluationEventMetadata;
  readonly plan: EvaluationPlan;
  readonly submissions: readonly EvaluationSubmissionRecord[];
  readonly assignments: readonly EvaluationAssignment[];
  readonly progress: EvaluationProgress;
  readonly resultScopes: readonly EvaluationOrganizerResultScope[];
  readonly aggregates: readonly EvaluationAggregate[];
  readonly submittedReviews: readonly EvaluationOrganizerSubmittedReview[];
  readonly decisions: Readonly<Record<string, EvaluationDecision>>;
}

export interface EvaluationOrganizerReviewExportSnapshot {
  readonly plan: EvaluationPlan;
  readonly submissions: readonly EvaluationSubmissionRecord[];
  readonly assignments: readonly EvaluationAssignment[];
  readonly reviews: readonly EvaluationReview[];
  readonly aggregates: readonly EvaluationAggregate[];
  readonly decisions: Readonly<Record<string, EvaluationDecision>>;
}

export interface EvaluationEventMetadata {
  readonly id: string;
  readonly name: string;
  readonly timeZone: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface EvaluationEventMetadataSource {
  getEventMetadata(tenantId: string, eventId: string): Promise<EvaluationEventMetadata | null>;
}

export interface AssignReviewersInput {
  planId: string;
  roundId: string;
  submissionId: string;
  reviewerIds: readonly string[];
  expectedVersion?: number | undefined;
}

export interface PreviewEvaluationDistributionInput {
  readonly planId: string;
  readonly roundId: string;
  readonly submissionIds: readonly string[];
  readonly reviewerIds?: readonly string[] | undefined;
  readonly expectedVersion: number;
}

export interface ApplyEvaluationDistributionInput extends PreviewEvaluationDistributionInput {
  readonly fingerprint: string;
}

export interface ReplaceEvaluationAssignmentInput {
  readonly replacementReviewerId: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

export interface SaveScoreInput {
  criterionId: string;
  value: number | string;
  origin: "human";
  evidence?: readonly string[] | undefined;
}

export interface SaveReviewInput {
  scores: readonly SaveScoreInput[];
  comment?: string | undefined;
  expectedVersion?: number | undefined;
}

export interface RecordDecisionInput {
  planId: string;
  submissionId: string;
  status: EvaluationDecisionStatus;
  reason: string;
  idempotencyKey: string;
  expectedVersion?: number | undefined;
}

export interface EvaluationEventSource {
  getEvent(
    tenantId: string,
    eventId: string,
  ): Promise<{ readonly id: string; readonly name: string } | null>;
}

export interface EvaluationServiceOptions {
  clock?: (() => Date) | undefined;
  eventSource?: EvaluationEventSource | undefined;
  acceptanceHandoff?: EvaluationAcceptanceHandoff | undefined;
  decisionProjection?: EvaluationDecisionProjection | undefined;
  aiSuggestionProvider?: EvaluationAiSuggestionProvider | EvaluationSuggestionProducer | undefined;
  suggestionProvider?: EvaluationAiSuggestionProvider | EvaluationSuggestionProducer | undefined;
  aiSuggestionProducer?: EvaluationSuggestionProducer | undefined;
}

function requireText(value: string, field: string, maximumLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw invalidInput(`${field} must contain between 1 and ${maximumLength} characters.`);
  }
  return normalized;
}
function requireAcceptableSubmission(
  material: Readonly<{
    title: string;
    abstract: string;
    participants: readonly Readonly<{ id: string; email: string }>[];
  }>,
): void {
  if (
    material.title.trim().length === 0 ||
    material.abstract.trim().length === 0 ||
    material.participants.length === 0 ||
    material.participants.some(
      (participant) => participant.id.trim().length === 0 || participant.email.trim().length === 0,
    )
  ) {
    throw invalidInput(
      "An accepted submission must include a title, abstract, and at least one identified speaker.",
    );
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidInput(`${field} must be a positive integer.`);
  }
}

const evaluationInstantSchema = z.iso.datetime({ offset: true });

function canonicalInstant(
  value: string | null | undefined,
  field: string,
): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (!evaluationInstantSchema.safeParse(value).success) {
    throw invalidInput(`${field} must be an ISO-8601 instant with an explicit UTC offset or null.`);
  }
  return new Date(value).toISOString();
}

function validatedRevisionSyncToken(value: string): string {
  const parsed = revisionSyncTokenSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidInput("revisionSyncToken must be a UUID.");
  }
  return parsed.data;
}

function normalizeRounds(rounds: readonly ReviewRound[]): readonly ReviewRound[] {
  return rounds.map((round) => ({
    ...round,
    ...(round.opensAt === undefined
      ? {}
      : { opensAt: canonicalInstant(round.opensAt, "Round open date") }),
    closesAt: canonicalInstant(round.closesAt, "Round close date") ?? null,
  }));
}

function hasRole(actor: EvaluationActor, eventId: string, role: "organizer" | "reviewer"): boolean {
  return actor.grants.some((grant) => grant.eventId === eventId && grant.role === role);
}

function requireHumanOrganizer(actor: EvaluationActor, eventId: string): void {
  if (actor.kind !== "human" || !hasRole(actor, eventId, "organizer")) {
    throw forbidden("A human event organizer must perform this evaluation action.");
  }
}

function requireHumanReviewer(actor: EvaluationActor, assignment: EvaluationAssignment): void {
  if (
    actor.kind !== "human" ||
    assignment.status === "superseded" ||
    actor.userId !== assignment.reviewerId ||
    !hasRole(actor, assignment.eventId, "reviewer")
  ) {
    throw forbidden();
  }
}

function findRound(plan: EvaluationPlan, roundId: string): ReviewRound {
  const round = plan.rounds.find((candidate) => candidate.id === roundId);
  if (round === undefined) {
    throw notFound("The evaluation round was not found.");
  }
  return round;
}

function validateCriterion(criterion: RubricCriterion): void {
  requireText(criterion.id, "Criterion id", 100);
  requireText(criterion.label, "Criterion label", 200);
  if (criterion.description.length > 2_000) {
    throw invalidInput("Criterion descriptions cannot exceed 2000 characters.");
  }
  const inputType = criterion.inputType ?? "numeric";
  if (!Number.isFinite(criterion.minimum) || !Number.isFinite(criterion.maximum)) {
    throw invalidInput("Criterion bounds must be finite numbers.");
  }
  if (inputType === "free_text") {
    if (!Number.isFinite(criterion.weight) || criterion.weight < 0) {
      throw invalidInput("Free-text criterion weights must be finite non-negative numbers.");
    }
  } else {
    if (criterion.minimum >= criterion.maximum) {
      throw invalidInput("Scored criteria must have a minimum below their maximum.");
    }
    const invalidWeight =
      !Number.isFinite(criterion.weight) ||
      criterion.weight < 0 ||
      (inputType === "numeric" && criterion.weight === 0);
    if (invalidWeight) {
      throw invalidInput(
        inputType === "numeric"
          ? "Numeric criterion weights must be finite positive numbers."
          : "Dropdown criterion weights must be finite non-negative numbers.",
      );
    }
  }
  const options = criterion.options ?? [];
  if (inputType === "dropdown") {
    if (options.length < 1) {
      throw invalidInput("Dropdown criteria must provide at least one option.");
    }
    const optionValues = new Set<string>();
    const optionIds = new Set<string>();
    for (const option of options) {
      requireText(option.label, "Criterion option label", 200);
      requireText(option.value, "Criterion option value", 200);
      if (option.id !== undefined) {
        const optionId = requireText(option.id, "Criterion option id", 100);
        if (optionIds.has(optionId)) {
          throw invalidInput("Dropdown option ids must be unique within a criterion.");
        }
        optionIds.add(optionId);
      }
      if (optionValues.has(option.value)) {
        throw invalidInput("Dropdown option values must be unique within a criterion.");
      }
      optionValues.add(option.value);
    }
    if (options.length > criterion.maximum - criterion.minimum + 1) {
      throw invalidInput("Dropdown options cannot exceed the configured criterion range.");
    }
  } else if (options.length > 0) {
    throw invalidInput("Only dropdown criteria may define options.");
  }
}

function validateRubric(rubric: Rubric): void {
  requireText(rubric.id, "Rubric id", 100);
  requireText(rubric.name, "Rubric name", 200);
  if (rubric.criteria.length === 0) {
    throw invalidInput("Every rubric must contain at least one criterion.");
  }
  const criterionIds = new Set<string>();
  for (const criterion of rubric.criteria) {
    validateCriterion(criterion);
    if (criterionIds.has(criterion.id)) {
      throw invalidInput("Criterion ids must be unique within a rubric.");
    }
    criterionIds.add(criterion.id);
  }
}

function validateRounds(rounds: readonly ReviewRound[]): void {
  if (rounds.length === 0) {
    throw invalidInput("An evaluation plan must contain at least one round.");
  }
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const round of rounds) {
    requireText(round.id, "Round id", 100);
    requireText(round.name, "Round name", 200);
    requirePositiveInteger(round.sequence, "Round sequence");
    if (
      round.opensAt !== null &&
      round.opensAt !== undefined &&
      round.closesAt !== null &&
      round.closesAt !== undefined &&
      Date.parse(round.closesAt) <= Date.parse(round.opensAt)
    ) {
      throw invalidInput("Each round close date must be after its open date.");
    }
    const reviewerIds = round.reviewerPool?.reviewerIds ?? [];
    if (round.reviewerPool?.name !== undefined) {
      requireText(round.reviewerPool.name, "Reviewer pool name", 200);
    }
    if (new Set(reviewerIds).size !== reviewerIds.length) {
      throw invalidInput("Reviewer ids must be unique within each round pool.");
    }
    for (const reviewerId of reviewerIds) {
      requireText(reviewerId, "Reviewer id", 100);
    }
    validateRubric(round.rubric);
    if (ids.has(round.id) || sequences.has(round.sequence)) {
      throw invalidInput("Evaluation round ids and sequences must be unique.");
    }
    ids.add(round.id);
    sequences.add(round.sequence);
  }
}

function validatePlanTemporalIntegrity(input: {
  readonly currentPlan?: EvaluationPlan | undefined;
  readonly closesAt: string | null;
  readonly rounds: readonly ReviewRound[];
  readonly event: EvaluationEventMetadata;
  readonly now: Date;
}): void {
  const eventEndsAt = Date.parse(input.event.endsAt);
  if (!Number.isFinite(eventEndsAt)) {
    throw invalidInput("The event end date is invalid.");
  }
  const today = localDateInTimeZone(input.now.toISOString(), input.event.timeZone);
  const currentRounds = new Map(input.currentPlan?.rounds.map((round) => [round.id, round]) ?? []);
  const boundaries = [
    {
      label: "Plan close date",
      value: input.closesAt,
      current: input.currentPlan?.closesAt,
    },
    ...input.rounds.flatMap((round) => {
      const current = currentRounds.get(round.id);
      return [
        {
          label: `Round ${round.sequence} open date`,
          value: round.opensAt,
          current: current?.opensAt,
        },
        {
          label: `Round ${round.sequence} close date`,
          value: round.closesAt,
          current: current?.closesAt,
        },
      ];
    }),
  ];
  for (const boundary of boundaries) {
    if (boundary.value === undefined || boundary.value === null) continue;
    const boundaryTime = Date.parse(boundary.value);
    if (boundaryTime > eventEndsAt) {
      throw invalidInput(`${boundary.label} cannot be after the event ends.`);
    }
    if (
      boundary.value !== boundary.current &&
      localDateInTimeZone(boundary.value, input.event.timeZone) < today
    ) {
      throw invalidInput(`${boundary.label} cannot be before today.`);
    }
  }
  const finalRound = [...input.rounds].sort((left, right) => right.sequence - left.sequence)[0];
  if (
    input.closesAt !== null &&
    finalRound?.closesAt != null &&
    Date.parse(input.closesAt) < Date.parse(finalRound.closesAt)
  ) {
    throw invalidInput("Plan close date cannot be before the final round closes.");
  }
}

function roundsRequireBlind(rounds: readonly ReviewRound[]): boolean {
  return rounds.some(
    (round) =>
      round.blindReview === true ||
      (round.anonymization !== undefined && round.anonymization !== "none"),
  );
}

function assertPlanIsWritable(plan: EvaluationPlan, round: ReviewRound, now: Date): void {
  if (plan.status !== "open") {
    throw closed("The evaluation plan is not open for reviews.");
  }
  const timestamp = now.getTime();
  if (
    (round.opensAt !== null &&
      round.opensAt !== undefined &&
      Number.isFinite(Date.parse(round.opensAt)) &&
      Date.parse(round.opensAt) > timestamp) ||
    (plan.closesAt !== null && Date.parse(plan.closesAt) <= timestamp) ||
    (round.closesAt !== null && Date.parse(round.closesAt) <= timestamp)
  ) {
    throw closed(
      round.opensAt !== null && round.opensAt !== undefined && Date.parse(round.opensAt) > timestamp
        ? "The review round has not opened yet."
        : "The review close date has passed.",
    );
  }
}

function isNumericCriterion(criterion: RubricCriterion): boolean {
  return (criterion.inputType ?? "numeric") !== "free_text";
}

function normalizeDropdownValue(criterion: RubricCriterion, value: number | string): number {
  const options = criterion.options ?? [];
  if (typeof value === "string") {
    const optionIndex = options.findIndex((option) => option.value === value);
    if (optionIndex < 0) {
      throw invalidInput(`Score ${criterion.id} must use one of the configured dropdown options.`);
    }
    return criterion.minimum + optionIndex;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw invalidInput(`Score ${criterion.id} must be a whole-number dropdown option.`);
  }
  const optionIndex = value - criterion.minimum;
  if (optionIndex < 0 || optionIndex >= options.length) {
    throw invalidInput(`Score ${criterion.id} must use one of the configured dropdown options.`);
  }
  return value;
}

function possibleWeightedTotal(rubric: Rubric): number {
  return rubric.criteria.reduce(
    (total, criterion) =>
      isNumericCriterion(criterion) ? total + criterion.maximum * criterion.weight : total,
    0,
  );
}

export function isHumanConfirmedScore(score: RubricScore | undefined): score is RubricScore {
  return score?.origin === "human";
}

export function calculateRubricTotal(
  rubric: Rubric,
  scores: Readonly<Record<string, RubricScore>>,
): RubricTotal {
  let weightedTotal = 0;
  let countedCriteria = 0;
  for (const criterion of rubric.criteria) {
    const score = scores[criterion.id];
    if (
      !isNumericCriterion(criterion) ||
      score === undefined ||
      !isHumanConfirmedScore(score) ||
      typeof score.value !== "number"
    ) {
      continue;
    }
    weightedTotal += score.value * criterion.weight;
    countedCriteria += 1;
  }
  return {
    weightedTotal,
    possibleWeightedTotal: possibleWeightedTotal(rubric),
    countedCriteria,
  };
}

function aggregateForSubmission(
  plan: EvaluationPlan,
  round: ReviewRound,
  submissionId: string,
  assignments: readonly EvaluationAssignment[],
  reviews: readonly EvaluationReview[],
  immutableHistory = false,
): EvaluationAggregate {
  const historicalAssignments = assignments.filter(
    (assignment) =>
      assignment.planId === plan.id &&
      assignment.eventId === plan.eventId &&
      assignment.roundId === round.id &&
      assignment.submissionId === submissionId &&
      isActionableAssignment(assignment),
  );
  const submissionAssignments = immutableHistory
    ? historicalAssignments
    : assignments.filter((assignment) =>
        isCountedAssignmentForRound(plan, round, submissionId, assignment),
      );
  const reviewByAssignment = new Map(
    reviews
      .filter((review) => review.planId === plan.id && review.roundId === round.id)
      .map((review) => [review.assignmentId, review]),
  );
  const submittedReviews = submissionAssignments.flatMap((assignment) => {
    const review = reviewByAssignment.get(assignment.id);
    if (
      review === undefined ||
      review.submittedAt === null ||
      (!immutableHistory
        ? !isReviewForRoundRevision(plan, round, review)
        : !isReviewForAssignmentSnapshot(assignment, review))
    ) {
      return [];
    }
    return [review];
  });
  const historicalRoundRevisions = new Set(
    submissionAssignments.map(
      (assignment) =>
        assignment.roundRevision ?? assignment.rubricRevision ?? assignment.planVersion,
    ),
  );
  const historicalRubricRevisions = new Set(
    submissionAssignments.map((assignment) => assignment.rubricRevision ?? assignment.planVersion),
  );
  const roundRevision =
    immutableHistory && historicalRoundRevisions.size === 1
      ? ([...historicalRoundRevisions][0] ?? round.revision ?? gradingRevision(plan))
      : (round.revision ?? gradingRevision(plan));
  const rubricRevision =
    immutableHistory && historicalRubricRevisions.size === 1
      ? ([...historicalRubricRevisions][0] ?? round.rubricRevision ?? gradingRevision(plan))
      : (round.rubricRevision ?? gradingRevision(plan));
  const totals = submittedReviews.map((review) =>
    calculateRubricTotal(round.rubric, review.scores),
  );
  const averageWeightedTotal =
    totals.length === 0
      ? null
      : totals.reduce((total, score) => total + score.weightedTotal, 0) / totals.length;
  const criteria = round.rubric.criteria.map((criterion) => {
    const values = submittedReviews
      .map((review) => review.scores[criterion.id])
      .filter(
        (score): score is RubricScore =>
          isNumericCriterion(criterion) &&
          isHumanConfirmedScore(score) &&
          typeof score.value === "number",
      )
      .map((score) => score.value)
      .filter((value): value is number => typeof value === "number");
    return {
      criterionId: criterion.id,
      average:
        values.length === 0
          ? null
          : values.reduce((total, value) => total + value, 0) / values.length,
      count: values.length,
      weight: criterion.weight,
    };
  });
  return {
    planId: plan.id,
    roundId: round.id,
    roundRevision,
    rubricRevision,
    submissionId,
    submittedReviewCount: submittedReviews.length,
    expectedReviewCount: plan.assignmentRule.reviewsPerSubmission,
    averageWeightedTotal,
    possibleWeightedTotal: possibleWeightedTotal(round.rubric),
    criteria,
  };
}
function effectiveAssignment(
  assignment: EvaluationAssignment,
  review: EvaluationReview | undefined,
): EvaluationAssignment {
  if (assignment.status === "abstained" || assignment.status === "superseded") return assignment;
  if (review !== undefined && review.submittedAt !== null) {
    return { ...assignment, status: "submitted" as const };
  }
  if (assignment.status === "submitted") {
    return { ...assignment, status: "assigned" as const };
  }
  return assignment;
}

function effectiveAssignmentsForPlan(
  plan: EvaluationPlan,
  assignments: readonly EvaluationAssignment[],
  reviews: readonly EvaluationReview[],
): readonly EvaluationAssignment[] {
  const reviewByAssignment = new Map<string, EvaluationReview>();
  for (const review of reviews) {
    if (
      review.tenantId !== plan.tenantId ||
      review.eventId !== plan.eventId ||
      review.planId !== plan.id
    ) {
      continue;
    }
    const current = reviewByAssignment.get(review.assignmentId);
    if (
      current === undefined ||
      (current.submittedAt === null && review.submittedAt !== null) ||
      (current.submittedAt === review.submittedAt && review.version > current.version)
    ) {
      reviewByAssignment.set(review.assignmentId, review);
    }
  }
  return assignments
    .filter(
      (assignment) =>
        assignment.tenantId === plan.tenantId &&
        assignment.eventId === plan.eventId &&
        assignment.planId === plan.id &&
        isCurrentAssignment(assignment),
    )
    .map((assignment) => effectiveAssignment(assignment, reviewByAssignment.get(assignment.id)));
}
function resolveOrganizerPlanFamily(
  selectedPlan: EvaluationPlan,
  plans: readonly EvaluationPlan[],
): readonly EvaluationPlan[] {
  const planById = new Map<string, EvaluationPlan>();
  const childrenByPredecessor = new Map<string, readonly EvaluationPlan[]>();
  for (const candidate of plans) {
    if (planById.has(candidate.id)) {
      throw conflict("Review plan revision lineage is invalid.");
    }
    planById.set(candidate.id, candidate);
    if (candidate.predecessorPlanId != null) {
      const children = childrenByPredecessor.get(candidate.predecessorPlanId) ?? [];
      childrenByPredecessor.set(candidate.predecessorPlanId, [...children, candidate]);
    }
  }

  const family: EvaluationPlan[] = [];
  const visited = new Set<string>();
  let current = selectedPlan;
  for (let depth = 0; depth <= MAX_REVISION_DEPTH; depth += 1) {
    if (
      current.tenantId !== selectedPlan.tenantId ||
      current.eventId !== selectedPlan.eventId ||
      visited.has(current.id)
    ) {
      throw conflict("Review plan revision lineage is invalid.");
    }
    visited.add(current.id);
    family.unshift(current);
    if ((childrenByPredecessor.get(current.id)?.length ?? 0) > 1) {
      throw conflict("Review plan revision lineage must remain linear.");
    }
    const predecessorPlanId = current.predecessorPlanId;
    if (predecessorPlanId == null) return family;
    const children = childrenByPredecessor.get(predecessorPlanId);
    if (children === undefined || children.length !== 1) {
      throw conflict("Review plan revision lineage must remain linear.");
    }
    const predecessor = planById.get(predecessorPlanId);
    if (predecessor === undefined) {
      throw conflict("Review plan revision lineage is invalid.");
    }
    current = predecessor;
  }
  throw conflict("Review plan revision depth exceeds the synchronization limit.");
}

function effectiveAssignmentsForPlanFamily(
  plans: readonly EvaluationPlan[],
  assignments: readonly EvaluationAssignment[],
  reviews: readonly EvaluationReview[],
): readonly EvaluationAssignment[] {
  const assignmentById = new Map<string, EvaluationAssignment>();
  for (const plan of plans) {
    for (const assignment of effectiveAssignmentsForPlan(plan, assignments, reviews)) {
      if (!assignmentById.has(assignment.id)) assignmentById.set(assignment.id, assignment);
    }
  }
  return [...assignmentById.values()];
}

function displayCompletionPercent(completed: number, total: number): number {
  if (total <= 0) return 0;
  const percentage = Math.round((completed / total) * 100);
  return Number.isFinite(percentage) ? Math.min(100, Math.max(0, percentage)) : 0;
}
function progressForAssignments(
  plan: EvaluationPlan,
  assignments: readonly EvaluationAssignment[],
): EvaluationProgress {
  const relevantAssignments = assignments.filter(
    (assignment) =>
      assignment.tenantId === plan.tenantId &&
      assignment.eventId === plan.eventId &&
      assignment.planId === plan.id &&
      isCurrentAssignment(assignment),
  );
  const count = (status: EvaluationAssignment["status"]) =>
    relevantAssignments.filter((assignment) => assignment.status === status).length;
  const submitted = count("submitted");
  const abstained = count("abstained");
  const actionable = relevantAssignments.length - abstained;
  const reviewerProgress = new Map<
    string,
    {
      reviewerId: string;
      planId: string;
      roundId: string;
      assigned: number;
      inProgress: number;
      submitted: number;
      abstained: number;
      completionPercent: number;
      outstanding: number;
    }
  >();
  for (const assignment of relevantAssignments) {
    const status = assignment.status;
    const key = `${assignment.reviewerId}\u0000${assignment.planId}\u0000${assignment.roundId}`;
    const current = reviewerProgress.get(key) ?? {
      reviewerId: assignment.reviewerId,
      planId: assignment.planId,
      roundId: assignment.roundId,
      assigned: 0,
      inProgress: 0,
      submitted: 0,
      abstained: 0,
      completionPercent: 0,
      outstanding: 0,
    };
    if (status === "abstained") {
      current.abstained += 1;
    } else {
      current.assigned += 1;
      if (status === "in_progress") current.inProgress += 1;
      if (status === "submitted") current.submitted += 1;
    }
    current.outstanding = Math.max(0, current.assigned - current.submitted);
    current.completionPercent = displayCompletionPercent(current.submitted, current.assigned);
    reviewerProgress.set(key, current);
  }
  return {
    planId: plan.id,
    total: relevantAssignments.length,
    assigned: count("assigned"),
    inProgress: count("in_progress"),
    submitted,
    abstained,
    completionPercent: displayCompletionPercent(submitted, actionable),
    reviewers: [...reviewerProgress.values()].sort(
      (left, right) =>
        left.reviewerId.localeCompare(right.reviewerId) ||
        left.planId.localeCompare(right.planId) ||
        left.roundId.localeCompare(right.roundId),
    ),
  };
}
function organizerRound(plan: EvaluationPlan, now: Date): ReviewRound | undefined {
  const openRound = [...plan.rounds]
    .sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id))
    .find(
      (round) =>
        plan.status === "open" &&
        (round.opensAt === null ||
          round.opensAt === undefined ||
          Date.parse(round.opensAt) <= now.getTime()) &&
        (round.closesAt === null || Date.parse(round.closesAt) > now.getTime()),
    );
  return (
    openRound ??
    [...plan.rounds].sort(
      (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
    )[0]
  );
}

function normalizeProjection(
  projection: EvaluationReviewerProjection | undefined,
): EvaluationReviewerProjection {
  const fieldIds = (projection?.fieldIds ?? projection?.visibleFieldIds ?? []).map((fieldId) =>
    requireText(fieldId, "Projection field id", 100),
  );
  const fileIds = (projection?.fileIds ?? projection?.visibleFileIds ?? []).map((fileId) =>
    requireText(fileId, "Projection file id", 100),
  );
  if (new Set(fieldIds).size !== fieldIds.length || new Set(fileIds).size !== fileIds.length) {
    throw invalidInput("Reviewer projection ids must be unique.");
  }
  return { fieldIds, fileIds };
}

function providerFunction(
  provider: EvaluationAiSuggestionProvider | EvaluationSuggestionProducer | undefined,
  direct: EvaluationSuggestionProducer | undefined,
): EvaluationSuggestionProducer | undefined {
  if (typeof provider === "function") return provider;
  return (
    direct ??
    provider?.generate ??
    provider?.suggest ??
    provider?.produce ??
    provider?.generateSuggestions
  );
}
function decisionProjectionIdempotencyKey(
  planId: string,
  submissionId: string,
  decisionVersion: number,
): string {
  return `evaluation-decision:${planId}:${submissionId}:v${decisionVersion}`;
}

function decisionTemplatePurpose(
  status: EvaluationDecisionStatus,
): EvaluationDecisionCommunicationTemplatePurpose {
  if (status === "accepted") return "decision_accepted";
  if (status === "waitlisted") return "decision_waitlisted";
  return "decision_rejected";
}

function isCurrentAssignment(assignment: EvaluationAssignment): boolean {
  return assignment.status !== "superseded";
}

function isActionableAssignment(assignment: EvaluationAssignment): boolean {
  return assignment.status !== "abstained" && assignment.status !== "superseded";
}

function isCountedAssignmentForRound(
  plan: EvaluationPlan,
  round: ReviewRound,
  submissionId: string,
  assignment: EvaluationAssignment,
): boolean {
  const roundRevision = round.revision ?? gradingRevision(plan);
  const rubricRevision = round.rubricRevision ?? gradingRevision(plan);
  return (
    assignment.planId === plan.id &&
    assignment.eventId === plan.eventId &&
    assignment.roundId === round.id &&
    assignment.submissionId === submissionId &&
    isActionableAssignment(assignment) &&
    (assignment.rubricRevision ?? assignment.planVersion) === rubricRevision &&
    (assignment.roundRevision ?? assignment.rubricRevision ?? assignment.planVersion) ===
      roundRevision
  );
}

function isReviewForRoundRevision(
  plan: EvaluationPlan,
  round: ReviewRound,
  review: EvaluationReview,
): boolean {
  const roundRevision = round.revision ?? gradingRevision(plan);
  const rubricRevision = round.rubricRevision ?? gradingRevision(plan);
  return (
    review.planId === plan.id &&
    review.roundId === round.id &&
    (review.rubricRevision ?? review.rubricVersion ?? review.planRevision ?? review.planVersion) ===
      rubricRevision &&
    (review.roundRevision ??
      review.rubricRevision ??
      review.rubricVersion ??
      review.planRevision ??
      review.planVersion) === roundRevision
  );
}

function isReviewForAssignmentSnapshot(
  assignment: EvaluationAssignment,
  review: EvaluationReview,
): boolean {
  const assignmentRubricRevision = assignment.rubricRevision ?? assignment.planVersion;
  const assignmentRoundRevision =
    assignment.roundRevision ?? assignment.rubricRevision ?? assignment.planVersion;
  const reviewRubricRevision =
    review.rubricRevision ?? review.rubricVersion ?? review.planRevision ?? review.planVersion;
  const reviewRoundRevision =
    review.roundRevision ??
    review.rubricRevision ??
    review.rubricVersion ??
    review.planRevision ??
    review.planVersion;
  return (
    review.planId === assignment.planId &&
    review.roundId === assignment.roundId &&
    review.submissionId === assignment.submissionId &&
    review.assignmentId === assignment.id &&
    reviewRubricRevision === assignmentRubricRevision &&
    reviewRoundRevision === assignmentRoundRevision
  );
}

function isOrganizerWorkspaceSubmission(
  submission: Readonly<{ status?: string | undefined }>,
): boolean {
  return submission.status === "submitted" || submission.status === "under_review";
}

function isActiveReviewSubmission(submission: Readonly<{ status?: string | undefined }>): boolean {
  return submission.status === "submitted";
}

function isReviewableSubmission(submission: Readonly<{ status?: string | undefined }>): boolean {
  return submission.status === "submitted" || submission.status === "reopened";
}

function gradingRevision(plan: EvaluationPlan): number {
  return plan.gradingRevision ?? plan.version;
}

function revisionEntityId(id: string, revision: number): string {
  const simpleSuffix = `-revision-${revision}`;
  if (id.length + simpleSuffix.length <= 100) return `${id}${simpleSuffix}`;
  const fingerprint = distributionFingerprint(`${id}:${revision}`).slice(-8);
  const compactSuffix = `${simpleSuffix}-${fingerprint}`;
  return `${id.slice(0, 100 - compactSuffix.length)}${compactSuffix}`;
}

function revisionPlanId(plan: EvaluationPlan): string {
  return revisionEntityId(plan.id, plan.version);
}

function revisionRoundId(roundId: string, planVersion: number): string {
  return revisionEntityId(roundId, planVersion);
}

function distributionFingerprint(value: unknown): string {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `evaluation-distribution-v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export class EvaluationService {
  readonly #acceptanceHandoff: EvaluationAcceptanceHandoff | undefined;
  readonly #decisionProjection: EvaluationDecisionProjection | undefined;
  readonly #projectedDecisionKeys = new Set<string>();
  readonly #acceptedHandoffKeys = new Set<string>();
  readonly #reconciledSessionDecisionKeys = new Set<string>();
  readonly #decisionProjectionInFlight = new Map<string, Promise<void>>();
  readonly #acceptanceHandoffInFlight = new Map<string, Promise<void>>();
  readonly #sessionDecisionReconciliationInFlight = new Map<string, Promise<void>>();
  readonly #repository: EvaluationRepository;
  readonly #submissions: SubmissionReviewSource;
  readonly #eventMetadataSource: EvaluationEventMetadataSource;
  readonly #eventSource: EvaluationEventSource | undefined;
  readonly #clock: () => Date;
  readonly #aiSuggestionProvider:
    | EvaluationAiSuggestionProvider
    | EvaluationSuggestionProducer
    | undefined;
  readonly #aiSuggestionProducer: EvaluationSuggestionProducer | undefined;

  constructor(
    repository: EvaluationRepository,
    submissions: SubmissionReviewSource,
    eventSource: EvaluationEventMetadataSource,
    options: EvaluationServiceOptions = {},
  ) {
    this.#repository = repository;
    this.#submissions = submissions;
    this.#eventMetadataSource = eventSource;
    this.#eventSource = options.eventSource;
    this.#clock = options.clock ?? (() => new Date());
    this.#acceptanceHandoff = options.acceptanceHandoff;
    this.#decisionProjection = options.decisionProjection;
    this.#aiSuggestionProvider = options.aiSuggestionProvider ?? options.suggestionProvider;
    this.#aiSuggestionProducer = providerFunction(
      this.#aiSuggestionProvider,
      options.aiSuggestionProducer,
    );
  }

  async #eventMetadata(tenantId: string, eventId: string): Promise<EvaluationEventMetadata> {
    const event = await this.#eventMetadataSource.getEventMetadata(tenantId, eventId);
    if (event === null) throw notFound("The event could not be found.");
    return event;
  }

  async listPlans(actor: EvaluationActor, eventId?: string): Promise<readonly EvaluationPlan[]> {
    if (actor.kind !== "human") throw forbidden();
    const plans = await this.#repository.listPlans(actor.tenantId, eventId);
    return plans
      .filter((plan) => eventId === undefined || plan.eventId === eventId)
      .filter(
        (plan) =>
          hasRole(actor, plan.eventId, "organizer") || hasRole(actor, plan.eventId, "reviewer"),
      )
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      );
  }

  async getPlan(actor: EvaluationActor, planId: string): Promise<EvaluationPlan> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    if (
      actor.kind !== "human" ||
      (!hasRole(actor, plan.eventId, "organizer") && !hasRole(actor, plan.eventId, "reviewer"))
    ) {
      throw forbidden();
    }
    return plan;
  }

  async getOrganizerPlan(actor: EvaluationActor, planId: string): Promise<EvaluationPlan> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    return plan;
  }

  async replayPersistedDecisionWork(input: {
    readonly tenantId: string;
    readonly planId: string;
    readonly submissionId: string;
    readonly decisionVersion: number;
    readonly status: EvaluationDecisionStatus;
    readonly transitionIdempotencyKey: string;
  }): Promise<void> {
    const decision = await this.#repository.getDecision(
      input.tenantId,
      input.planId,
      input.submissionId,
    );
    if (
      decision === null ||
      decision.version !== input.decisionVersion ||
      decision.status !== input.status
    ) {
      return;
    }
    const transition = decision.history.find(
      (candidate) =>
        candidate.idempotencyKey === input.transitionIdempotencyKey &&
        candidate.to === input.status,
    );
    if (transition === undefined) return;
    await this.#runDecisionWork({
      decision,
      transition,
      decisionVersion: input.decisionVersion,
    });
  }

  async getDecision(
    actor: EvaluationActor,
    planId: string,
    submissionId: string,
  ): Promise<EvaluationDecision | null> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    await this.#requireReviewableSubmission(
      plan,
      requireText(submissionId, "Submission id", MAX_SUBMISSION_ID_LENGTH),
    );
    return this.#repository.getDecision(
      actor.tenantId,
      plan.id,
      requireText(submissionId, "Submission id", MAX_SUBMISSION_ID_LENGTH),
    );
  }

  async listOrganizerSubmissions(
    actor: EvaluationActor,
    eventId: string,
  ): Promise<readonly EvaluationSubmissionRecord[]> {
    requireHumanOrganizer(actor, requireText(eventId, "Event id", 100));
    const source = this.#submissions as SubmissionReviewSource & EvaluationSubmissionSource;
    if (source.listSubmissionsForOrganizer === undefined) return [];
    return (await source.listSubmissionsForOrganizer(actor.tenantId, eventId)).filter(
      isReviewableSubmission,
    );
  }
  async getOrganizerReviewExportSnapshot(
    actor: EvaluationActor,
    planId: string,
  ): Promise<EvaluationOrganizerReviewExportSnapshot> {
    const plan = await this.#getPlan(actor.tenantId, requireText(planId, "Plan id", 100));
    requireHumanOrganizer(actor, plan.eventId);
    const source = this.#submissions as SubmissionReviewSource & EvaluationSubmissionSource;
    const [listedSubmissions, workspaceRecords] = await Promise.all([
      source.listSubmissionsForOrganizer?.(actor.tenantId, plan.eventId) ?? Promise.resolve([]),
      this.#repository.listOrganizerExportRecords(actor.tenantId, plan.eventId, plan.id),
    ]);
    const currentPlan = await this.#getPlan(actor.tenantId, plan.id);
    const submissions = [
      ...new Map(
        listedSubmissions
          .filter(
            (submission) =>
              submission.tenantId === actor.tenantId &&
              submission.eventId === plan.eventId &&
              isOrganizerWorkspaceSubmission(submission),
          )
          .map((submission) => [submission.id, submission] as const),
      ).values(),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const assignments = workspaceRecords.assignments.filter(
      (assignment) =>
        assignment.tenantId === actor.tenantId &&
        assignment.eventId === plan.eventId &&
        assignment.planId === plan.id,
    );
    const reviews = workspaceRecords.reviews.filter(
      (review) =>
        review.tenantId === actor.tenantId &&
        review.eventId === plan.eventId &&
        review.planId === plan.id &&
        review.submittedAt !== null,
    );
    const effectiveAssignments = [...effectiveAssignmentsForPlan(plan, assignments, reviews)].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    const decisions = Object.fromEntries(
      workspaceRecords.decisions
        .filter(
          (decision) =>
            decision.tenantId === actor.tenantId &&
            decision.eventId === plan.eventId &&
            decision.planId === plan.id,
        )
        .map((decision) => [decision.submissionId, decision] as const),
    );
    return {
      plan: currentPlan,
      submissions,
      assignments: effectiveAssignments,
      reviews,
      aggregates: plan.rounds.flatMap((round) =>
        submissions.map((submission) =>
          aggregateForSubmission(plan, round, submission.id, assignments, reviews),
        ),
      ),
      decisions,
    };
  }

  async getOrganizerWorkspace(
    actor: EvaluationActor,
    eventId: string,
    preferredPlanId?: string,
  ): Promise<EvaluationOrganizerWorkspace> {
    const normalizedEventId = requireText(eventId, "Event id", 100);
    requireHumanOrganizer(actor, normalizedEventId);
    const event = await this.#eventMetadata(actor.tenantId, normalizedEventId);
    const normalizedPreferredPlanId =
      preferredPlanId === undefined ? undefined : requireText(preferredPlanId, "Plan id", 100);
    const listedPlansPromise = this.#repository.listPlans(actor.tenantId, normalizedEventId);
    const listedSubmissionsPromise = this.listOrganizerSubmissions(actor, normalizedEventId);
    const batchedWorkspaceRecordsPromise = this.#repository.listOrganizerWorkspaceRecords(
      actor.tenantId,
      normalizedEventId,
    );
    const hydrationPromise = Promise.allSettled([
      listedSubmissionsPromise,
      batchedWorkspaceRecordsPromise,
    ]);
    const listedPlans = await listedPlansPromise;
    const plans = listedPlans.filter(
      (plan) => plan.tenantId === actor.tenantId && plan.eventId === normalizedEventId,
    );
    const preferredPlan =
      normalizedPreferredPlanId === undefined
        ? undefined
        : plans.find((plan) => plan.id === normalizedPreferredPlanId);
    const planIdsWithSuccessor = new Set(
      plans
        .map((candidate) => candidate.predecessorPlanId)
        .filter((planId): planId is string => planId != null),
    );
    const resumableDraft =
      normalizedPreferredPlanId === undefined
        ? [...plans]
            .filter(
              (candidate) =>
                candidate.status === "draft" &&
                candidate.predecessorPlanId != null &&
                !planIdsWithSuccessor.has(candidate.id),
            )
            .sort(
              (left, right) =>
                right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
            )[0]
        : undefined;
    const plan =
      preferredPlan ??
      resumableDraft ??
      [...plans].sort(
        (left, right) =>
          (right.status === "open" ? 1 : 0) - (left.status === "open" ? 1 : 0) ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.id.localeCompare(left.id),
      )[0];
    if (plan === undefined) {
      throw notFound("No evaluation plan was found for this event.");
    }
    const planFamily = resolveOrganizerPlanFamily(plan, plans);
    const familyPlanIds = new Set(planFamily.map((candidate) => candidate.id));
    const [listedSubmissionsResult, batchedWorkspaceRecordsResult] = await hydrationPromise;
    if (listedSubmissionsResult.status === "rejected") {
      throw listedSubmissionsResult.reason;
    }
    if (batchedWorkspaceRecordsResult.status === "rejected") {
      throw batchedWorkspaceRecordsResult.reason;
    }
    const listedSubmissions = listedSubmissionsResult.value;
    const workspaceRecords = batchedWorkspaceRecordsResult.value;
    const submissions = [
      ...new Map(
        listedSubmissions
          .filter(
            (submission) =>
              submission.tenantId === actor.tenantId &&
              submission.eventId === normalizedEventId &&
              isOrganizerWorkspaceSubmission(submission),
          )
          .map((submission) => [submission.id, submission] as const),
      ).values(),
    ];
    const assignments = [
      ...new Map(
        workspaceRecords.assignments
          .filter(
            (assignment) =>
              assignment.tenantId === actor.tenantId &&
              assignment.eventId === normalizedEventId &&
              familyPlanIds.has(assignment.planId),
          )
          .map((assignment) => [assignment.id, assignment] as const),
      ).values(),
    ];
    const reviews = [
      ...new Map(
        workspaceRecords.reviews
          .filter(
            (review) =>
              review.tenantId === actor.tenantId &&
              review.eventId === normalizedEventId &&
              familyPlanIds.has(review.planId),
          )
          .map((review) => [review.id, review] as const),
      ).values(),
    ];
    const planDecisions = workspaceRecords.decisions.filter(
      (decision) =>
        decision.tenantId === actor.tenantId &&
        decision.eventId === normalizedEventId &&
        decision.planId === plan.id,
    );
    const activeSubmissions = [...submissions].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const activeSubmissionIdSet = new Set(activeSubmissions.map((submission) => submission.id));
    const effectiveAssignments = effectiveAssignmentsForPlanFamily(
      planFamily,
      assignments,
      reviews,
    ).filter((assignment) => activeSubmissionIdSet.has(assignment.submissionId));
    const planById = new Map(planFamily.map((candidate) => [candidate.id, candidate] as const));
    const resultScopes = planFamily.flatMap((sourcePlan, lineageOrdinal) =>
      [...sourcePlan.rounds]
        .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
        .map((sourceRound) => ({
          planId: sourcePlan.id,
          planVersion: sourcePlan.version,
          lineageOrdinal,
          planName: sourcePlan.name,
          roundId: sourceRound.id,
          roundName: sourceRound.name,
          sequence: sourceRound.sequence,
          historical: sourcePlan.id !== plan.id,
        })),
    );
    const roundByScope = new Map(
      planFamily.flatMap((sourcePlan) =>
        sourcePlan.rounds.map(
          (sourceRound) => [`${sourcePlan.id}\u0000${sourceRound.id}`, sourceRound] as const,
        ),
      ),
    );
    const aggregateInputs = new Map<
      string,
      { plan: EvaluationPlan; round: ReviewRound; submissionId: string }
    >();
    const addAggregate = (
      sourcePlan: EvaluationPlan,
      sourceRound: ReviewRound,
      submissionId: string,
    ) => {
      aggregateInputs.set(`${sourcePlan.id}\u0000${sourceRound.id}\u0000${submissionId}`, {
        plan: sourcePlan,
        round: sourceRound,
        submissionId,
      });
    };
    for (const assignment of effectiveAssignments) {
      const sourcePlan = planById.get(assignment.planId);
      const sourceRound = roundByScope.get(`${assignment.planId}\u0000${assignment.roundId}`);
      if (sourcePlan !== undefined && sourceRound !== undefined) {
        addAggregate(sourcePlan, sourceRound, assignment.submissionId);
      }
    }
    const organizerActiveRound = organizerRound(plan, this.#clock());
    if (organizerActiveRound !== undefined) {
      for (const activeSubmission of activeSubmissions) {
        addAggregate(plan, organizerActiveRound, activeSubmission.id);
      }
    }
    const aggregates = [...aggregateInputs.values()].map(
      ({ plan: sourcePlan, round, submissionId }) =>
        aggregateForSubmission(
          sourcePlan,
          round,
          submissionId,
          assignments,
          reviews,
          sourcePlan.id !== plan.id,
        ),
    );
    const decisions = Object.fromEntries(
      planDecisions
        .filter((decision) => activeSubmissionIdSet.has(decision.submissionId))
        .map((decision) => [decision.submissionId, decision] as const),
    );
    const effectiveAssignmentById = new Map(
      effectiveAssignments.map((assignment) => [assignment.id, assignment] as const),
    );
    const submittedReviewByAssignmentId = new Map<string, EvaluationOrganizerSubmittedReview>();
    const submittedReviewIds = new Set<string>();
    for (const review of [...reviews].sort(
      (left, right) =>
        right.version - left.version ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    )) {
      const assignment = effectiveAssignmentById.get(review.assignmentId);
      const sourcePlan = planById.get(review.planId);
      const reviewRound = roundByScope.get(`${review.planId}\u0000${review.roundId}`);
      if (
        review.submittedAt === null ||
        assignment === undefined ||
        sourcePlan === undefined ||
        reviewRound === undefined ||
        review.planId !== assignment.planId ||
        review.roundId !== assignment.roundId ||
        (sourcePlan.id === plan.id
          ? !isCountedAssignmentForRound(
              sourcePlan,
              reviewRound,
              review.submissionId,
              assignment,
            ) || !isReviewForRoundRevision(sourcePlan, reviewRound, review)
          : !isReviewForAssignmentSnapshot(assignment, review)) ||
        submittedReviewIds.has(review.id) ||
        submittedReviewByAssignmentId.has(review.assignmentId)
      ) {
        continue;
      }
      submittedReviewIds.add(review.id);
      submittedReviewByAssignmentId.set(review.assignmentId, {
        id: review.id,
        planId: review.planId,
        roundId: review.roundId,
        submissionId: review.submissionId,
        reviewerId: review.reviewerId,
        comment: review.comment,
        submittedAt: review.submittedAt,
      });
    }
    const submittedReviews = [...submittedReviewByAssignmentId.values()].sort(
      (left, right) =>
        left.submissionId.localeCompare(right.submissionId) ||
        left.planId.localeCompare(right.planId) ||
        left.roundId.localeCompare(right.roundId) ||
        left.submittedAt.localeCompare(right.submittedAt) ||
        left.reviewerId.localeCompare(right.reviewerId),
    );
    return {
      event,
      plan,
      submissions,
      assignments: effectiveAssignments,
      progress: progressForAssignments(plan, effectiveAssignments),
      resultScopes,
      aggregates,
      submittedReviews,
      decisions,
    };
  }

  async reopenSubmission(
    actor: EvaluationActor,
    eventId: string,
    submissionId: string,
    input: {
      readonly expectedVersion: number;
      readonly reason: string;
      readonly idempotencyKey: string;
    },
  ): Promise<EvaluationSubmissionRecord> {
    const normalizedEventId = requireText(eventId, "Event id", 100);
    requireHumanOrganizer(actor, normalizedEventId);
    const source = this.#submissions as SubmissionReviewSource & EvaluationSubmissionSource;
    if (source.reopenSubmission === undefined) {
      throw notFound("Submission reopen is not configured.");
    }
    return source.reopenSubmission(
      actor.tenantId,
      normalizedEventId,
      requireText(submissionId, "Submission id", MAX_SUBMISSION_ID_LENGTH),
      {
        organizerId: actor.userId,
        expectedVersion: input.expectedVersion,
        reason: input.reason,
        idempotencyKey: requireText(input.idempotencyKey, "Idempotency key", 200),
      },
    );
  }

  async createPlan(
    actor: EvaluationActor,
    input: CreateEvaluationPlanInput,
  ): Promise<EvaluationPlan> {
    requireHumanOrganizer(actor, input.eventId);
    const id = requireText(input.id, "Plan id", 100);
    const eventId = requireText(input.eventId, "Event id", 100);
    const name = requireText(input.name, "Plan name", 200);
    const closesAt = canonicalInstant(input.closesAt, "Plan close date") ?? null;
    const rounds = normalizeRounds(input.rounds);
    requirePositiveInteger(input.assignmentRule.reviewsPerSubmission, "Reviews per submission");
    requirePositiveInteger(
      input.assignmentRule.maxAssignmentsPerReviewer,
      "Maximum assignments per reviewer",
    );
    validateRounds(rounds);
    const reviewerProjection = normalizeProjection(
      input.reviewerProjection ?? input.evaluatorProjection ?? input.projection,
    );
    if (await this.#repository.getPlan(actor.tenantId, id)) {
      throw conflict("An evaluation plan with this id already exists.");
    }

    const now = this.#clock();
    const event = await this.#eventMetadata(actor.tenantId, eventId);
    validatePlanTemporalIntegrity({
      closesAt,
      rounds,
      event,
      now,
    });
    const nowIso = now.toISOString();
    const plan: EvaluationPlan = {
      id,
      tenantId: actor.tenantId,
      eventId,
      name,
      status: "draft",
      blindReview: input.blindReview || roundsRequireBlind(input.rounds),
      closesAt,
      assignmentRule: { ...input.assignmentRule },
      rounds: structuredClone(rounds),
      reviewerProjection,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.#repository.putPlan(plan, null);
    return plan;
  }
  async updatePlan(
    actor: EvaluationActor,
    planId: string,
    input: UpdateEvaluationPlanInput,
  ): Promise<EvaluationPlan> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    if (
      plan.status !== "draft" ||
      (plan.gradingLockedAt !== undefined && plan.gradingLockedAt !== null)
    ) {
      throw conflict("An evaluation plan is locked after it opens.");
    }
    if (plan.version !== input.expectedVersion) {
      throw conflict("Evaluation plan changed since it was loaded.");
    }
    const name = input.name === undefined ? plan.name : requireText(input.name, "Plan name", 200);
    const closesAt =
      input.closesAt === undefined
        ? plan.closesAt
        : (canonicalInstant(input.closesAt, "Plan close date") ?? null);
    const assignmentRule = input.assignmentRule ?? plan.assignmentRule;
    requirePositiveInteger(assignmentRule.reviewsPerSubmission, "Reviews per submission");
    requirePositiveInteger(
      assignmentRule.maxAssignmentsPerReviewer,
      "Maximum assignments per reviewer",
    );
    const predecessorRoundIdById = new Map(
      plan.rounds.map((round) => [round.id, round.predecessorRoundId ?? null] as const),
    );
    const rounds = (input.rounds === undefined ? plan.rounds : normalizeRounds(input.rounds)).map(
      (round) => ({
        ...round,
        predecessorRoundId: predecessorRoundIdById.get(round.id) ?? null,
      }),
    );
    validateRounds(rounds);
    const nowDate = this.#clock();
    const event = await this.#eventMetadata(actor.tenantId, plan.eventId);
    validatePlanTemporalIntegrity({
      currentPlan: plan,
      closesAt,
      rounds,
      event,
      now: nowDate,
    });
    const reviewerProjectionInput =
      input.reviewerProjection ?? input.evaluatorProjection ?? input.projection;
    const reviewerProjection = normalizeProjection(
      reviewerProjectionInput ??
        plan.reviewerProjection ??
        plan.evaluatorProjection ??
        plan.projection,
    );
    const now = nowDate.toISOString();
    const updated: EvaluationPlan = {
      ...plan,
      name,
      blindReview: roundsRequireBlind(rounds) || (input.blindReview ?? plan.blindReview),
      closesAt,
      assignmentRule: { ...assignmentRule },
      rounds: structuredClone(rounds),
      reviewerProjection,
      version: plan.version + 1,
      updatedAt: now,
    };
    await this.#repository.putPlan(updated, plan.version);
    await this.#markSuggestionsStaleForPlan(actor.tenantId, plan.id, now, actor.userId);
    return updated;
  }

  async updateEvaluationPlan(
    actor: EvaluationActor,
    planId: string,
    input: UpdateEvaluationPlanInput,
  ): Promise<EvaluationPlan> {
    return this.updatePlan(actor, planId, input);
  }

  async revisePlanToDraft(
    actor: EvaluationActor,
    planId: string,
    input: ReviseEvaluationPlanInput,
  ): Promise<EvaluationPlan> {
    const source = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, source.eventId);
    if (source.status === "draft" || source.gradingLockedAt == null) {
      throw conflict("Only a grading-locked evaluation plan can be revised to a new draft.");
    }
    if (source.version !== input.expectedVersion) {
      throw conflict("Evaluation plan changed since it was loaded.");
    }
    if (!this.#repository.supportsAtomicPlanRevisionSync) {
      throw conflict("Review plan revisions require the authoritative D1 runtime.");
    }
    await this.#requirePlanTip(source);
    const event = await this.#eventMetadata(actor.tenantId, source.eventId);
    validatePlanTemporalIntegrity({
      currentPlan: source,
      closesAt: source.closesAt,
      rounds: source.rounds,
      event,
      now: this.#clock(),
    });
    const now = this.#clock().toISOString();
    const revision: EvaluationPlan = {
      ...structuredClone(source),
      id: revisionPlanId(source),
      predecessorPlanId: source.id,
      name: `${source.name} revision`.slice(0, 200),
      status: "draft",
      rounds: source.rounds.map(
        ({ revision: _roundRevision, rubricRevision: _rubricRevision, ...round }) => ({
          ...round,
          id: revisionRoundId(round.id, source.version),
          predecessorRoundId: round.id,
        }),
      ),
      gradingRevision: undefined,
      gradingLockedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const lineageSnapshot = await revisionScheduleSnapshot(
      this.#repository,
      { ...revision, status: "open" },
      revision.updatedAt,
      { allowOversizedPlans: true, ignoreRoundLimit: true },
    );
    await this.#repository.putPlan(revision, null, {
      predecessorPlanId: source.id,
      expectedVersion: source.version,
      lineageVersions: lineageSnapshot.lineageVersions,
    });
    return revision;
  }

  async openPlan(
    actor: EvaluationActor,
    planId: string,
    expectedVersion: number,
    revisionSyncToken: string,
  ): Promise<EvaluationPlan> {
    revisionSyncToken = validatedRevisionSyncToken(revisionSyncToken);
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    if (plan.status === "open" && plan.version === expectedVersion + 1) {
      await this.#repository.resumePlanRevisionSync(plan, plan.version, revisionSyncToken);
      await this.#reconcilePlanRevisionFamilyState(plan, plan.version, revisionSyncToken);
      return plan;
    }
    const isReopening = plan.status === "closed";
    if (plan.status !== "draft" && !isReopening) {
      throw conflict("Only a draft or closed evaluation plan can be opened.");
    }
    if (plan.version !== expectedVersion) {
      throw conflict("Evaluation plan changed since it was loaded.");
    }
    await this.#requirePlanTip(plan);
    const now = this.#clock();
    const event = await this.#eventMetadata(actor.tenantId, plan.eventId);
    validatePlanTemporalIntegrity({
      currentPlan: plan,
      closesAt: plan.closesAt,
      rounds: plan.rounds,
      event,
      now,
    });
    const gradingLockedAt = plan.gradingLockedAt ?? now.toISOString();
    const nextVersion = plan.version + 1;
    if (plan.closesAt !== null && Date.parse(plan.closesAt) <= now.getTime()) {
      throw closed("The evaluation plan close date has passed.");
    }
    const updated: EvaluationPlan = {
      ...plan,
      status: "open",
      gradingLockedAt,
      gradingRevision: nextVersion,
      rounds: plan.rounds.map((round) => ({
        ...round,
        revision: nextVersion,
        rubricRevision: nextVersion,
      })),
      version: nextVersion,
      updatedAt: now.toISOString(),
    };
    await this.#putPlanStateWithRevisionSync(updated, plan.version, revisionSyncToken);
    return updated;
  }

  async closePlan(
    actor: EvaluationActor,
    planId: string,
    expectedVersion: number,
    revisionSyncToken: string,
  ): Promise<EvaluationPlan> {
    revisionSyncToken = validatedRevisionSyncToken(revisionSyncToken);
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    if (plan.status === "closed" && plan.version === expectedVersion + 1) {
      await this.#repository.resumePlanRevisionSync(plan, plan.version, revisionSyncToken);
      await this.#reconcilePlanRevisionFamilyState(plan, plan.version, revisionSyncToken);
      return plan;
    }
    if (plan.status !== "open") {
      throw conflict("Only an open evaluation plan can be closed.");
    }
    if (plan.version !== expectedVersion) {
      throw conflict("Evaluation plan changed since it was loaded.");
    }
    await this.#requirePlanTip(plan);
    const updated: EvaluationPlan = {
      ...plan,
      status: "closed",
      version: plan.version + 1,
      updatedAt: this.#clock().toISOString(),
    };
    await this.#putPlanStateWithRevisionSync(updated, plan.version, revisionSyncToken);
    return updated;
  }

  async updatePlanSchedule(
    actor: EvaluationActor,
    planId: string,
    input: {
      readonly expectedVersion: number;
      readonly closesAt: string | null;
      readonly revisionSyncToken: string;
    },
  ): Promise<EvaluationPlan> {
    const revisionSyncToken = validatedRevisionSyncToken(input.revisionSyncToken);
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    const closesAt = canonicalInstant(input.closesAt, "closesAt") ?? null;
    if (
      plan.status === "open" &&
      plan.version === input.expectedVersion + 1 &&
      plan.closesAt === closesAt
    ) {
      await this.#repository.resumePlanRevisionSync(plan, plan.version, revisionSyncToken);
      await this.#reconcilePlanRevisionFamilyState(plan, plan.version, revisionSyncToken);
      return plan;
    }
    if (plan.status !== "open") {
      throw conflict("Only an open evaluation plan schedule can be changed.");
    }
    if (plan.version !== input.expectedVersion) {
      throw conflict("Evaluation plan changed since it was loaded.");
    }
    await this.#requirePlanTip(plan);
    const now = this.#clock();
    if (closesAt !== null && Date.parse(closesAt) <= now.getTime()) {
      throw invalidInput("closesAt must be in the future.");
    }
    const event = await this.#eventMetadata(actor.tenantId, plan.eventId);
    validatePlanTemporalIntegrity({
      currentPlan: plan,
      closesAt,
      rounds: plan.rounds,
      event,
      now,
    });
    const updated: EvaluationPlan = {
      ...plan,
      closesAt,
      version: plan.version + 1,
      updatedAt: now.toISOString(),
    };
    await this.#putPlanScheduleWithRevisionSync(updated, plan.version, revisionSyncToken);
    return updated;
  }

  async #putPlanStateWithRevisionSync(
    updated: EvaluationPlan,
    expectedVersion: number,
    revisionSyncToken: string,
  ): Promise<void> {
    await this.#assertPlanRevisionReconciliationWithinLimit(updated);
    const snapshot = await revisionScheduleSnapshot(this.#repository, updated, updated.updatedAt, {
      allowOversizedPlans: true,
      truncateAtRoundLimit: true,
    });
    if (!snapshot.truncated) {
      await this.#repository.putPlanState(
        updated,
        expectedVersion,
        snapshot.syncs,
        false,
        revisionSyncToken,
      );
      return;
    }
    if (!this.#repository.supportsAtomicPlanRevisionSync) {
      throw conflict("Review plan reconciliation requires the authoritative D1 runtime.");
    }
    await this.#repository.putPlanState(updated, expectedVersion, [], true, revisionSyncToken);
    await this.#reconcilePlanRevisionFamilyState(updated, updated.version, revisionSyncToken);
  }

  async #putPlanScheduleWithRevisionSync(
    updated: EvaluationPlan,
    expectedVersion: number,
    revisionSyncToken: string,
  ): Promise<void> {
    await this.#assertPlanRevisionReconciliationWithinLimit(updated);
    const snapshot = await revisionScheduleSnapshot(this.#repository, updated, updated.updatedAt, {
      allowOversizedPlans: true,
      truncateAtRoundLimit: true,
    });
    if (!snapshot.truncated) {
      await this.#repository.putPlanSchedule(
        updated,
        expectedVersion,
        snapshot.syncs,
        false,
        revisionSyncToken,
      );
      return;
    }
    if (!this.#repository.supportsAtomicPlanRevisionSync) {
      throw conflict("Review plan reconciliation requires the authoritative D1 runtime.");
    }
    await this.#repository.putPlanSchedule(updated, expectedVersion, [], true, revisionSyncToken);
    await this.#reconcilePlanRevisionFamilyState(updated, updated.version, revisionSyncToken);
  }

  async reconcilePlanRevisionFamily(
    actor: EvaluationActor,
    planId: string,
    expectedVersion: number,
    revisionSyncToken: string,
  ): Promise<EvaluationPlan> {
    revisionSyncToken = validatedRevisionSyncToken(revisionSyncToken);
    const tip = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, tip.eventId);
    if (tip.status === "draft" || tip.gradingLockedAt === null) {
      throw conflict("Only an opened or closed review plan revision can be reconciled.");
    }
    if (tip.version !== expectedVersion) {
      throw conflict("Evaluation plan changed since it was loaded.");
    }
    if (!this.#repository.supportsAtomicPlanRevisionSync) {
      throw conflict("Review plan reconciliation requires the authoritative D1 runtime.");
    }
    await this.#requirePlanTip(tip);
    await this.#assertPlanRevisionReconciliationWithinLimit(tip);
    await this.#repository.beginPlanRevisionSync(tip, expectedVersion, revisionSyncToken);
    await this.#reconcilePlanRevisionFamilyState(tip, expectedVersion, revisionSyncToken);
    return tip;
  }

  async #assertPlanRevisionReconciliationWithinLimit(plan: EvaluationPlan): Promise<void> {
    await revisionScheduleSnapshot(this.#repository, plan, this.#clock().toISOString(), {
      allowOversizedPlans: true,
      ignoreRoundLimit: true,
    });
  }

  async #reconcilePlanRevisionFamilyState(
    tip: EvaluationPlan,
    expectedVersion: number,
    revisionSyncToken: string,
  ): Promise<void> {
    await this.#assertPlanRevisionReconciliationWithinLimit(tip);
    let remainingPlanIds: readonly string[] = [];
    for (let pass = 0; pass <= MAX_REVISION_DEPTH; pass += 1) {
      const snapshot = await revisionScheduleSnapshot(
        this.#repository,
        tip,
        this.#clock().toISOString(),
        { allowOversizedPlans: true, truncateAtRoundLimit: true },
      );
      if (snapshot.syncs.length === 0) {
        await this.#repository.completePlanRevisionSync(tip, expectedVersion, revisionSyncToken);
        return;
      }
      remainingPlanIds = snapshot.syncs.map((sync) => sync.plan.id);
      if (pass === MAX_REVISION_DEPTH) break;
      await this.#repository.reconcilePlanRevisionFamily(
        tip,
        expectedVersion,
        snapshot.syncs,
        revisionSyncToken,
      );
    }
    throw conflict(
      `Review plan revision reconciliation did not converge: ${remainingPlanIds.join(", ")}.`,
    );
  }

  async assignReviewers(
    actor: EvaluationActor,
    input: AssignReviewersInput,
  ): Promise<readonly EvaluationAssignment[]> {
    const plan = await this.#getPlan(actor.tenantId, input.planId);
    requireHumanOrganizer(actor, plan.eventId);
    const round = findRound(plan, input.roundId);
    if (input.expectedVersion !== undefined && plan.version !== input.expectedVersion) {
      throw conflict("Evaluation plan changed since it was loaded.");
    }
    if (plan.status !== "open") {
      throw closed("Assignments require an open evaluation plan.");
    }
    const submissionId = requireText(input.submissionId, "Submission id", MAX_SUBMISSION_ID_LENGTH);
    const assignedSubmission = await this.#submissions.getSubmissionForReview(
      actor.tenantId,
      plan.eventId,
      submissionId,
    );
    if (assignedSubmission === null) {
      throw notFound("The submission to assign was not found.");
    }
    await this.#requireReviewableSubmission(plan, assignedSubmission);
    if (
      (await this.#repository.getDecision(plan.tenantId, plan.id, assignedSubmission.id)) !== null
    ) {
      throw conflict("This submission is no longer active for review.");
    }
    const submissionRevision = await this.#submissionRevision(
      actor.tenantId,
      plan.eventId,
      submissionId,
      assignedSubmission.version ?? assignedSubmission.revision,
    );
    const reviewerIds = input.reviewerIds.map((reviewerId) =>
      requireText(reviewerId, "Reviewer id", 100),
    );
    if (new Set(reviewerIds).size !== reviewerIds.length) {
      throw invalidInput("Reviewer ids must be unique.");
    }
    const reviewerPool = round.reviewerPool?.reviewerIds;
    if (
      reviewerPool !== undefined &&
      reviewerIds.some((reviewerId) => !reviewerPool.includes(reviewerId))
    ) {
      throw forbidden("Every assigned reviewer must belong to this round's reviewer pool.");
    }

    const allAssignments = (await this.#repository.listAssignments(actor.tenantId, plan.id)).filter(
      (assignment) => assignment.eventId === plan.eventId,
    );
    const planRevision = gradingRevision(plan);
    const rubricRevision = round.rubricRevision ?? planRevision;
    const roundRevision = round.revision ?? planRevision;
    const targetAssignments = allAssignments.filter(
      (assignment) =>
        assignment.roundId === input.roundId &&
        assignment.submissionId === submissionId &&
        isActionableAssignment(assignment),
    );
    const existingByReviewer = new Map(
      targetAssignments.map((assignment) => [assignment.reviewerId, assignment]),
    );
    const abstainedReviewerIds = new Set(
      allAssignments
        .filter(
          (assignment) =>
            assignment.roundId === input.roundId &&
            assignment.submissionId === submissionId &&
            assignment.status === "abstained",
        )
        .map((assignment) => assignment.reviewerId),
    );
    if (reviewerIds.some((reviewerId) => abstainedReviewerIds.has(reviewerId))) {
      throw conflict("A reviewer who declared a conflict cannot be reassigned.");
    }
    if (reviewerIds.length > plan.assignmentRule.reviewsPerSubmission) {
      throw conflict("The plan review limit for this submission would be exceeded.");
    }

    const outsideAssignments = allAssignments.filter(
      (assignment) =>
        isActionableAssignment(assignment) &&
        !(assignment.roundId === input.roundId && assignment.submissionId === submissionId),
    );
    const now = this.#clock().toISOString();
    const desired: EvaluationAssignment[] = [];
    for (const reviewerId of reviewerIds) {
      const existing = existingByReviewer.get(reviewerId);
      const reviewerLoad =
        outsideAssignments.filter((assignment) => assignment.reviewerId === reviewerId).length + 1;
      if (reviewerLoad > plan.assignmentRule.maxAssignmentsPerReviewer) {
        throw conflict(`Reviewer ${reviewerId} has reached the plan assignment limit.`);
      }
      if (existing !== undefined) {
        desired.push(existing);
        continue;
      }
      const baseAssignmentId = `${plan.id}:${input.roundId}:${submissionId}:${reviewerId}`;
      const matchingIdCount = allAssignments.filter(
        (assignment) =>
          assignment.id === baseAssignmentId || assignment.id.startsWith(`${baseAssignmentId}:v`),
      ).length;
      desired.push({
        id:
          matchingIdCount === 0 ? baseAssignmentId : `${baseAssignmentId}:v${matchingIdCount + 1}`,
        tenantId: actor.tenantId,
        eventId: plan.eventId,
        planId: plan.id,
        roundId: input.roundId,
        submissionId,
        reviewerId,
        status: "assigned",
        planVersion: planRevision,
        rubricRevision,
        roundRevision,
        submissionRevision,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    await this.#repository.applyAssignmentDistribution(
      {
        tenantId: actor.tenantId,
        eventId: plan.eventId,
        planId: plan.id,
        roundId: input.roundId,
        submissionId,
        planVersion: planRevision,
      },
      {
        assignments: desired,
        expectedActiveVersions: targetAssignments.map((assignment) => ({
          assignmentId: assignment.id,
          version: assignment.version,
        })),
        reason: "Organizer updated reviewer assignments.",
        authorizedAt: now,
      },
    );
    return desired;
  }

  async previewDistribution(
    actor: EvaluationActor,
    input: PreviewEvaluationDistributionInput,
  ): Promise<EvaluationDistributionPreview> {
    return (await this.#buildDistributionPreview(actor, input)).preview;
  }

  async applyDistribution(
    actor: EvaluationActor,
    input: ApplyEvaluationDistributionInput,
  ): Promise<EvaluationAssignmentDistributionResult> {
    const built = await this.#buildDistributionPreview(actor, input);
    if (
      built.preview.fingerprint !== requireText(input.fingerprint, "Distribution fingerprint", 200)
    ) {
      throw conflict("Reviewer assignments changed since the distribution was previewed.");
    }
    return this.#repository.applyAssignmentDistribution(built.preview.scope, {
      assignments: built.assignments,
      expectedActiveVersions: built.preview.expectedActiveVersions,
      reason: "Organizer applied reviewer distribution.",
      authorizedAt: this.#clock().toISOString(),
    });
  }

  async replaceAssignment(
    actor: EvaluationActor,
    assignmentId: string,
    input: ReplaceEvaluationAssignmentInput,
  ): Promise<EvaluationAssignmentReplacementResult> {
    const assignment = await this.#getAssignment(actor.tenantId, assignmentId);
    if (await this.#repository.hasPendingPlanLineageRepair(actor.tenantId, assignment.eventId)) {
      throw conflict("Review plan lineage requires operator repair.");
    }
    const plan = await this.#reviewerOperationalPlan(
      await this.#getPlan(actor.tenantId, assignment.planId),
    );
    requireHumanOrganizer(actor, plan.eventId);
    if (
      assignment.eventId !== plan.eventId ||
      assignment.status === "abstained" ||
      assignment.status === "superseded"
    ) {
      throw conflict("Only a current reviewer assignment can be replaced.");
    }
    if (assignment.version !== input.expectedVersion) {
      throw conflict("Reviewer assignment changed since it was loaded.");
    }
    const round = findRound(plan, assignment.roundId);
    assertPlanIsWritable(plan, round, this.#clock());
    const replacementReviewerId = requireText(
      input.replacementReviewerId,
      "Replacement reviewer id",
      100,
    );
    const reason = requireText(input.reason, "Replacement reason", 2_000);
    if (replacementReviewerId === assignment.reviewerId) {
      throw invalidInput("The replacement reviewer must be different.");
    }
    if (
      round.reviewerPool !== undefined &&
      !round.reviewerPool.reviewerIds.includes(replacementReviewerId)
    ) {
      throw forbidden("The replacement reviewer must belong to this round's reviewer pool.");
    }

    await this.#requireActiveSubmission(plan, assignment.submissionId);
    const assignments = await this.#repository.listAssignments(actor.tenantId, plan.id);
    if (
      assignments.some(
        (candidate) =>
          candidate.roundId === assignment.roundId &&
          candidate.submissionId === assignment.submissionId &&
          candidate.reviewerId === replacementReviewerId &&
          candidate.status === "abstained",
      )
    ) {
      throw conflict("A reviewer who declared a conflict cannot be assigned as a replacement.");
    }
    const replacementLoad =
      assignments.filter(
        (candidate) =>
          isActionableAssignment(candidate) &&
          candidate.id !== assignment.id &&
          candidate.reviewerId === replacementReviewerId,
      ).length + 1;
    if (replacementLoad > plan.assignmentRule.maxAssignmentsPerReviewer) {
      throw conflict(`Reviewer ${replacementReviewerId} has reached the plan assignment limit.`);
    }

    const now = this.#clock().toISOString();
    const baseAssignmentId = `${plan.id}:${round.id}:${assignment.submissionId}:${replacementReviewerId}`;
    const matchingIdCount = assignments.filter(
      (candidate) =>
        candidate.id === baseAssignmentId || candidate.id.startsWith(`${baseAssignmentId}:v`),
    ).length;
    const successorAssignment: EvaluationAssignment = {
      id: matchingIdCount === 0 ? baseAssignmentId : `${baseAssignmentId}:v${matchingIdCount + 1}`,
      tenantId: actor.tenantId,
      eventId: plan.eventId,
      planId: plan.id,
      roundId: round.id,
      submissionId: assignment.submissionId,
      reviewerId: replacementReviewerId,
      status: "assigned",
      predecessorAssignmentId: assignment.id,
      successorAssignmentId: null,
      supersededReason: null,
      planVersion: assignment.planVersion ?? gradingRevision(plan),
      rubricRevision: assignment.rubricRevision ?? gradingRevision(plan),
      roundRevision: assignment.roundRevision ?? round.revision ?? gradingRevision(plan),
      submissionRevision: assignment.submissionRevision,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const scope: EvaluationAssignmentScope = {
      tenantId: actor.tenantId,
      eventId: plan.eventId,
      planId: plan.id,
      roundId: round.id,
      submissionId: assignment.submissionId,
      planVersion: assignment.planVersion,
    };
    return this.#repository.replaceAssignment(scope, {
      oldAssignmentId: assignment.id,
      replacementReviewerId,
      successorAssignment,
      expectedAssignmentVersion: input.expectedVersion,
      reason,
      authorizedAt: now,
    });
  }

  async listAssignmentHistory(
    actor: EvaluationActor,
    planId: string,
    input: {
      readonly roundId?: string | undefined;
      readonly submissionId?: string | undefined;
    } = {},
  ): Promise<readonly EvaluationReviewHistory[]> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    const [assignments, reviews] = await Promise.all([
      this.#repository.listAssignments(actor.tenantId, plan.id),
      this.#repository.listReviews(actor.tenantId, plan.id),
    ]);
    const reviewByAssignmentId = new Map(
      reviews
        .filter(
          (review) =>
            review.tenantId === actor.tenantId &&
            review.eventId === plan.eventId &&
            review.planId === plan.id,
        )
        .map((review) => [review.assignmentId, review] as const),
    );
    return assignments
      .filter(
        (assignment) =>
          assignment.tenantId === actor.tenantId &&
          assignment.eventId === plan.eventId &&
          assignment.planId === plan.id &&
          assignment.status === "superseded" &&
          (input.roundId === undefined || assignment.roundId === input.roundId) &&
          (input.submissionId === undefined || assignment.submissionId === input.submissionId) &&
          reviewByAssignmentId.has(assignment.id),
      )
      .map((assignment) => ({
        assignment,
        review: reviewByAssignmentId.get(assignment.id) as EvaluationReview,
      }))
      .sort(
        (left, right) =>
          left.assignment.updatedAt.localeCompare(right.assignment.updatedAt) ||
          left.assignment.id.localeCompare(right.assignment.id),
      );
  }

  async listReviewerAssignments(
    actor: EvaluationActor,
    planId: string,
  ): Promise<readonly EvaluationAssignment[]> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    if (actor.kind !== "human" || !hasRole(actor, plan.eventId, "reviewer")) {
      throw forbidden();
    }
    const [assignments, reviews] = await Promise.all([
      this.#repository.listAssignments(actor.tenantId, plan.id),
      this.#repository.listReviews(actor.tenantId, plan.id),
    ]);
    const currentSubmissionIds = await this.#activeSubmissionIds(plan, assignments);
    return effectiveAssignmentsForPlan(plan, assignments, reviews)
      .filter(
        (assignment) =>
          assignment.reviewerId === actor.userId &&
          isActionableAssignment(assignment) &&
          currentSubmissionIds.has(assignment.submissionId),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
  }
  async listReviewerWorkspace(
    actor: EvaluationActor,
    eventId?: string,
    organizationId?: string,
  ): Promise<EvaluationReviewerWorkspace> {
    if (actor.kind !== "human") throw forbidden();
    const normalizedEventId =
      eventId === undefined ? undefined : requireText(eventId, "Event id", 100);
    const normalizedOrganizationId =
      organizationId === undefined
        ? undefined
        : requireText(organizationId, "Organization id", 100);
    const grantsByTenant = new Map<string, EvaluationGrant[]>();
    for (const grant of actor.grants) {
      if (
        grant.role !== "reviewer" ||
        (normalizedEventId !== undefined && grant.eventId !== normalizedEventId)
      ) {
        continue;
      }
      const tenantId = grant.tenantId ?? actor.tenantId;
      if (normalizedOrganizationId !== undefined && tenantId !== normalizedOrganizationId) {
        continue;
      }
      const grants = grantsByTenant.get(tenantId) ?? [];
      grants.push(grant);
      grantsByTenant.set(tenantId, grants);
    }
    if (grantsByTenant.size === 0) throw forbidden();
    const workspaces = await Promise.all(
      [...grantsByTenant].map(([tenantId, grants]) =>
        this.#listReviewerWorkspaceForTenant({ ...actor, tenantId, grants }, normalizedEventId),
      ),
    );
    return {
      assignments: workspaces
        .flatMap((workspace) => workspace.assignments)
        .sort(
          (left, right) =>
            left.assignment.eventId.localeCompare(right.assignment.eventId) ||
            left.plan.name.localeCompare(right.plan.name) ||
            left.round.name.localeCompare(right.round.name) ||
            left.submission.title.localeCompare(right.submission.title) ||
            left.assignment.id.localeCompare(right.assignment.id),
        ),
    };
  }
  async #listReviewerWorkspaceForTenant(
    actor: EvaluationActor,
    normalizedEventId?: string,
  ): Promise<EvaluationReviewerWorkspace> {
    if (normalizedEventId !== undefined && !hasRole(actor, normalizedEventId, "reviewer")) {
      throw forbidden();
    }
    const reviewerEventIds = [
      ...new Set(
        actor.grants.filter((grant) => grant.role === "reviewer").map((grant) => grant.eventId),
      ),
    ];
    if (normalizedEventId === undefined && reviewerEventIds.length === 0) {
      throw forbidden();
    }
    const allowedEventIds =
      normalizedEventId === undefined ? reviewerEventIds : [normalizedEventId];
    const [pendingRepairs, listedPlans, workspaceRecords] = await Promise.all([
      Promise.all(
        allowedEventIds.map(
          async (eventId) =>
            [
              eventId,
              await this.#repository.hasPendingPlanLineageRepair(actor.tenantId, eventId),
            ] as const,
        ),
      ),
      this.#repository.listPlans(actor.tenantId, normalizedEventId),
      this.#repository.listReviewerWorkspaceRecords(actor.tenantId, actor.userId, allowedEventIds),
    ]);
    const pendingRepairByEvent = new Map(pendingRepairs);
    if (normalizedEventId !== undefined && pendingRepairByEvent.get(normalizedEventId) === true) {
      throw conflict("Review plan lineage requires operator repair.");
    }
    const safeEventIds = allowedEventIds.filter(
      (eventId) => pendingRepairByEvent.get(eventId) !== true,
    );
    if (safeEventIds.length === 0) return { assignments: [] };
    const planKey = (eventId: string, planId: string) => `${eventId}\u0000${planId}`;
    const listedPlanByKey = new Map(
      listedPlans.map((plan) => [planKey(plan.eventId, plan.id), plan] as const),
    );
    const successorByPredecessor = new Map<string, EvaluationPlan>();
    for (const candidate of listedPlans) {
      const predecessorPlanId = candidate.predecessorPlanId;
      if (predecessorPlanId == null) continue;
      const predecessorKey = planKey(candidate.eventId, predecessorPlanId);
      if (successorByPredecessor.has(predecessorKey)) {
        throw conflict("Review plan revision lineage must remain linear.");
      }
      successorByPredecessor.set(predecessorKey, candidate);
    }
    const assignedPlanKeys = new Set(
      workspaceRecords.assignments.map((assignment) =>
        planKey(assignment.eventId, assignment.planId),
      ),
    );
    const reviewerPlans = listedPlans
      .filter((plan) => assignedPlanKeys.has(planKey(plan.eventId, plan.id)))
      .map((plan) =>
        this.#reviewerOperationalPlanFromListedPlans(plan, listedPlanByKey, successorByPredecessor),
      )
      .filter(
        (plan) =>
          safeEventIds.includes(plan.eventId) &&
          (normalizedEventId === undefined || plan.eventId === normalizedEventId) &&
          hasRole(actor, plan.eventId, "reviewer"),
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
      );
    if (reviewerPlans.length === 0) return { assignments: [] };

    const openPlans = reviewerPlans.filter((plan) => plan.status === "open");
    const plans = openPlans.length > 0 ? openPlans : reviewerPlans;
    const planRecords = plans.map((plan) => {
      const assignments = workspaceRecords.assignments.filter(
        (assignment) =>
          assignment.tenantId === actor.tenantId &&
          assignment.planId === plan.id &&
          assignment.eventId === plan.eventId &&
          assignment.reviewerId === actor.userId &&
          isActionableAssignment(assignment),
      );
      const ownAssignmentIds = new Set(assignments.map((assignment) => assignment.id));
      const reviewsByAssignment = new Map(
        workspaceRecords.reviews
          .filter(
            (review) =>
              review.tenantId === actor.tenantId &&
              ownAssignmentIds.has(review.assignmentId) &&
              review.planId === plan.id &&
              review.eventId === plan.eventId &&
              review.reviewerId === actor.userId,
          )
          .map((review) => [review.assignmentId, review] as const),
      );
      return {
        plan,
        assignments: assignments.map((assignment) => ({
          assignment: effectiveAssignment(assignment, reviewsByAssignment.get(assignment.id)),
          review: reviewsByAssignment.get(assignment.id),
        })),
      };
    });
    const candidates = planRecords.flatMap(({ plan, assignments }) =>
      assignments.map(({ assignment, review }) => ({ plan, assignment, review })),
    );
    if (candidates.length === 0) return { assignments: [] };

    const lookupByKey = new Map<
      string,
      { readonly eventId: string; readonly submissionId: string }
    >();
    for (const { assignment } of candidates) {
      const key = `${assignment.eventId}\u0000${assignment.submissionId}`;
      if (!lookupByKey.has(key)) {
        lookupByKey.set(key, {
          eventId: assignment.eventId,
          submissionId: assignment.submissionId,
        });
      }
    }
    const materials = await this.#submissions.getSubmissionsForReview(actor.tenantId, [
      ...lookupByKey.values(),
    ]);
    const materialByKey = new Map<string, SubmissionReviewMaterial>(
      materials.map((material) => [`${material.eventId}\u0000${material.id}`, material]),
    );
    const decisions = await Promise.all(
      candidates.map(({ plan, assignment }) =>
        this.#repository.getDecision(actor.tenantId, plan.id, assignment.submissionId),
      ),
    );
    const currentCandidates = candidates.filter(({ assignment }, index) => {
      const material = materialByKey.get(`${assignment.eventId}\u0000${assignment.submissionId}`);
      return (
        material === undefined || (isActiveReviewSubmission(material) && decisions[index] === null)
      );
    });

    const eventNames = new Map<string, string>();
    if (this.#eventSource !== undefined) {
      await Promise.all(
        [...new Set(currentCandidates.map(({ plan }) => plan.eventId))].map(async (eventId) => {
          const event = await this.#eventSource?.getEvent(actor.tenantId, eventId);
          if (event === null || event === undefined || event.id !== eventId) {
            throw notFound("The assigned event was not found.");
          }
          eventNames.set(eventId, requireText(event.name, "Event name", 200));
        }),
      );
    }

    const contexts = await Promise.all(
      currentCandidates.map(async ({ plan, assignment, review }) => {
        const materialKey = `${assignment.eventId}\u0000${assignment.submissionId}`;
        const material = materialByKey.get(materialKey);
        if (
          material === undefined ||
          material.tenantId !== actor.tenantId ||
          material.eventId !== plan.eventId
        ) {
          throw notFound("The assigned submission was not found.");
        }
        const materialRevision = material.version ?? material.revision;
        const submissionRevision =
          materialRevision !== undefined &&
          Number.isSafeInteger(materialRevision) &&
          materialRevision > 0
            ? materialRevision
            : 1;
        const round = findRound(plan, assignment.roundId);
        return {
          assignment,
          round,
          submission: this.#visibleSubmission(plan, round, material),
          review: review ?? null,
          rubricRevision: round.rubricRevision ?? gradingRevision(plan),
          submissionRevision,
          plan: {
            id: plan.id,
            organizationId: actor.tenantId,
            organizationName: actor.tenantId,
            eventId: plan.eventId,
            eventName: eventNames.get(plan.eventId) ?? plan.eventId,
            name: plan.name,
            status: plan.status,
            blindReview: plan.blindReview,
            closesAt: plan.closesAt,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
          },
        };
      }),
    );
    return {
      assignments: contexts.sort(
        (left, right) =>
          left.assignment.eventId.localeCompare(right.assignment.eventId) ||
          left.plan.name.localeCompare(right.plan.name) ||
          left.round.name.localeCompare(right.round.name) ||
          left.submission.title.localeCompare(right.submission.title) ||
          left.assignment.id.localeCompare(right.assignment.id),
      ),
    };
  }
  async listOrganizerAssignments(
    actor: EvaluationActor,
    planId: string,
  ): Promise<readonly EvaluationAssignment[]> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    const [assignments, reviews] = await Promise.all([
      this.#repository.listAssignments(actor.tenantId, plan.id),
      this.#repository.listReviews(actor.tenantId, plan.id),
    ]);
    const currentSubmissionIds = await this.#activeSubmissionIds(plan, assignments);
    return [...effectiveAssignmentsForPlan(plan, assignments, reviews)]
      .filter((assignment) => currentSubmissionIds.has(assignment.submissionId))
      .sort(
        (left: EvaluationAssignment, right: EvaluationAssignment) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
  }
  async unassignAssignment(
    actor: EvaluationActor,
    planId: string,
    assignmentId: string,
  ): Promise<void> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    const assignment = await this.#getAssignment(actor.tenantId, assignmentId);
    if (
      assignment.tenantId !== actor.tenantId ||
      assignment.planId !== plan.id ||
      assignment.eventId !== plan.eventId
    ) {
      throw notFound("The evaluation assignment was not found.");
    }
    if (assignment.status === "abstained" || assignment.status === "superseded") {
      throw conflict("Only a current reviewer assignment can be unassigned.");
    }
    const assignments = await this.#repository.listAssignments(actor.tenantId, plan.id);
    const desiredByReviewer = new Map(
      assignments
        .filter(
          (candidate) =>
            candidate.eventId === plan.eventId &&
            candidate.roundId === assignment.roundId &&
            candidate.submissionId === assignment.submissionId &&
            isActionableAssignment(candidate) &&
            candidate.reviewerId !== assignment.reviewerId,
        )
        .map((candidate) => [candidate.reviewerId, candidate] as const),
    );
    const activeTargetAssignments = assignments.filter(
      (candidate) =>
        candidate.eventId === plan.eventId &&
        candidate.roundId === assignment.roundId &&
        candidate.submissionId === assignment.submissionId &&
        isActionableAssignment(candidate),
    );
    await this.#repository.applyAssignmentDistribution(
      {
        tenantId: actor.tenantId,
        eventId: plan.eventId,
        planId: plan.id,
        roundId: assignment.roundId,
        submissionId: assignment.submissionId,
        planVersion: assignment.planVersion,
      },
      {
        assignments: [...desiredByReviewer.values()],
        expectedActiveVersions: activeTargetAssignments.map((candidate) => ({
          assignmentId: candidate.id,
          version: candidate.version,
        })),
        reason: "Organizer removed reviewer assignment.",
        authorizedAt: this.#clock().toISOString(),
        allowClosedCleanup: true,
      },
    );
  }
  async getReviewContext(actor: EvaluationActor, assignmentId: string): Promise<ReviewContext> {
    const assignment = await this.#getAssignment(actor.tenantId, assignmentId);
    requireHumanReviewer(actor, assignment);
    if (await this.#repository.getConflict(actor.tenantId, assignment.id)) {
      throw forbidden("A conflict declaration removes access to this submission.");
    }
    if (await this.#repository.hasPendingPlanLineageRepair(actor.tenantId, assignment.eventId)) {
      throw conflict("Review plan lineage requires operator repair.");
    }
    const plan = await this.#reviewerOperationalPlan(
      await this.#getPlan(actor.tenantId, assignment.planId),
    );
    const round = findRound(plan, assignment.roundId);
    const material = await this.#submissions.getSubmissionForReview(
      actor.tenantId,
      assignment.eventId,
      assignment.submissionId,
    );
    if (material === null) {
      throw notFound("The assigned submission was not found.");
    }
    const reviewableMaterial = await this.#requireReviewableSubmission(plan, material);
    if (
      !isActiveReviewSubmission(reviewableMaterial) ||
      (await this.#repository.getDecision(plan.tenantId, plan.id, reviewableMaterial.id)) !== null
    ) {
      throw notFound("The assigned submission was not found.");
    }
    const review = await this.#repository.getReview(actor.tenantId, assignment.id);
    const submissionRevision = await this.#submissionRevision(
      actor.tenantId,
      assignment.eventId,
      assignment.submissionId,
      reviewableMaterial.version ?? reviewableMaterial.revision,
    );
    const finalAuthority = await this.#getWritableAssignment(actor, assignment.id);
    if (finalAuthority.assignment.version !== assignment.version) {
      throw conflict("The review assignment changed while its context was loading.");
    }
    return {
      assignment: effectiveAssignment(assignment, review ?? undefined),
      round,
      submission: this.#visibleSubmission(plan, round, reviewableMaterial),
      review,
      rubricRevision: round.rubricRevision ?? gradingRevision(plan),
      submissionRevision,
    };
  }

  async saveReview(
    actor: EvaluationActor,
    assignmentId: string,
    input: SaveReviewInput,
  ): Promise<EvaluationReview> {
    const { assignment, plan, round } = await this.#getWritableAssignment(actor, assignmentId);
    if (assignment.status === "submitted") {
      throw conflict("A submitted review cannot be edited.");
    }
    const current = await this.#repository.getReview(actor.tenantId, assignment.id);
    const submission = await this.#submissions.getSubmissionForReview(
      actor.tenantId,
      assignment.eventId,
      assignment.submissionId,
    );
    const submissionRevision = await this.#submissionRevision(
      actor.tenantId,
      assignment.eventId,
      assignment.submissionId,
      submission?.version ?? submission?.revision,
    );
    const rubricRevision = round.rubricRevision ?? gradingRevision(plan);
    const roundRevision = round.revision ?? gradingRevision(plan);
    this.#assertExpectedReviewVersion(current, input.expectedVersion);
    if (input.scores.length === 0 && input.comment === undefined) {
      throw invalidInput("An autosave must contain a score or comment change.");
    }

    const now = this.#clock().toISOString();
    const scores: Record<string, RubricScore> = { ...(current?.scores ?? {}) };
    const criterionById = new Map(
      round.rubric.criteria.map((criterion) => [criterion.id, criterion]),
    );
    const changedCriterionIds = new Set<string>();
    for (const inputScore of input.scores) {
      if (changedCriterionIds.has(inputScore.criterionId)) {
        throw invalidInput("Each criterion can be changed only once per autosave.");
      }
      changedCriterionIds.add(inputScore.criterionId);
      const criterion = criterionById.get(inputScore.criterionId);
      if (criterion === undefined) {
        throw invalidInput("A score references a criterion outside this review round.");
      }
      const inputType = criterion.inputType ?? "numeric";
      let value: number | string;
      if (inputType === "free_text") {
        if (inputScore.origin !== "human" || typeof inputScore.value !== "string") {
          throw invalidInput("Free-text criteria require a human text response.");
        }
        value = requireText(inputScore.value, `Response ${criterion.id}`, 10_000);
      } else if (inputType === "dropdown") {
        value = normalizeDropdownValue(criterion, inputScore.value);
      } else {
        if (
          typeof inputScore.value !== "number" ||
          !Number.isFinite(inputScore.value) ||
          inputScore.value < criterion.minimum ||
          inputScore.value > criterion.maximum
        ) {
          throw invalidInput(
            `Score ${criterion.id} must be between ${criterion.minimum} and ${criterion.maximum}.`,
          );
        }
        value = inputScore.value;
      }
      const evidence = (inputScore.evidence ?? []).map((citation) =>
        requireText(citation, "Score evidence", 2_000),
      );
      scores[criterion.id] = {
        criterionId: criterion.id,
        value,
        origin: inputScore.origin,
        evidence,
        rubricRevision,
        submissionRevision,
        rubricVersion: rubricRevision,
        submissionVersion: submissionRevision,
        updatedAt: now,
      };
    }

    const comment = input.comment === undefined ? (current?.comment ?? "") : input.comment.trim();
    if (comment.length > 10_000) {
      throw invalidInput("Review comments cannot exceed 10000 characters.");
    }
    const existingVersion = current?.version ?? 0;
    const review: EvaluationReview = {
      id: current?.id ?? `review:${assignment.id}`,
      tenantId: actor.tenantId,
      eventId: assignment.eventId,
      planId: plan.id,
      roundId: round.id,
      assignmentId: assignment.id,
      submissionId: assignment.submissionId,
      reviewerId: actor.userId,
      scores,
      comment,
      submittedAt: null,
      version: existingVersion + 1,
      planRevision: gradingRevision(plan),
      rubricRevision,
      roundRevision,
      submissionRevision,
      planVersion: gradingRevision(plan),
      rubricVersion: rubricRevision,
      submissionVersion: submissionRevision,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#requireActiveSubmission(plan, assignment.submissionId);
    const assignmentUpdate =
      assignment.status === "assigned"
        ? {
            ...assignment,
            status: "in_progress" as const,
            version: assignment.version + 1,
            updatedAt: now,
          }
        : undefined;
    await this.#repository.writeReview({
      authority: {
        tenantId: assignment.tenantId,
        eventId: assignment.eventId,
        planId: assignment.planId,
        roundId: assignment.roundId,
        assignmentId: assignment.id,
        submissionId: assignment.submissionId,
        reviewerId: assignment.reviewerId,
        expectedAssignmentVersion: assignment.version,
        expectedPlanVersion: plan.version,
      },
      review,
      expectedReviewVersion: current?.version ?? null,
      assignmentUpdate,
    });
    return review;
  }

  /**
   * Organizer-driven AI triage for one (plan, round, submission). Shared per round,
   * cached on (rubricRevision, submissionRevision); reviewers never see these values
   * through reviewer-facing reads.
   */
  async generateRoundAiSuggestions(
    actor: EvaluationActor,
    input: GenerateRoundAiSuggestionsInput,
  ): Promise<EvaluationSuggestion> {
    const plan = await this.#getPlan(actor.tenantId, input.planId);
    requireHumanOrganizer(actor, plan.eventId);
    const round = findRound(plan, input.roundId);
    if (round.aiTriageEnabled !== true) {
      throw forbidden("AI triage is not enabled for this round.");
    }
    assertPlanIsWritable(plan, round, this.#clock());
    if (scoreableRubricCriteria(round).length === 0) throw advisoryUnsupported();
    const material = await this.#requireActiveSubmission(plan, input.submissionId);
    const producer = this.#aiSuggestionProducer;
    if (producer === undefined) {
      throw advisoryUnavailable(
        "Advisory evaluation is not configured. Manual review remains available.",
      );
    }
    const submissionRevision = await this.#submissionRevision(
      actor.tenantId,
      plan.eventId,
      material.id,
      material.version ?? material.revision,
    );
    const planRevision = gradingRevision(plan);
    const rubricRevision = round.rubricRevision ?? planRevision;
    const existing = (await this.#repository.listSuggestions(actor.tenantId, plan.id)).filter(
      (suggestion) =>
        suggestion.roundId === round.id &&
        suggestion.submissionId === material.id &&
        suggestion.assignmentId === null,
    );
    const reusable = existing.find(
      (suggestion) =>
        suggestion.status !== "stale" &&
        suggestion.rubricRevision === rubricRevision &&
        suggestion.submissionRevision === submissionRevision,
    );
    const now = this.#clock().toISOString();
    const staleSuggestions = existing.filter(
      (suggestion) =>
        suggestion.status !== "stale" &&
        (suggestion.rubricRevision !== rubricRevision ||
          suggestion.submissionRevision !== submissionRevision ||
          (suggestion.id === reusable?.id && input.regenerate === true)),
    );
    await Promise.all(
      staleSuggestions.map(async (suggestion) => {
        const stale = this.#markSuggestionStale(suggestion, actor.userId, now);
        await this.#repository.putSuggestion(stale, suggestion.version, submissionRevision);
      }),
    );
    if (reusable !== undefined && input.regenerate !== true) {
      return reusable;
    }
    const visibleSubmission = this.#visibleSubmission(plan, round, material);
    const providerInput: EvaluationSuggestionProviderInput = {
      tenantId: actor.tenantId,
      eventId: plan.eventId,
      planId: plan.id,
      roundId: round.id,
      submissionId: material.id,
      rubricRevision,
      submissionRevision,
      planRevision,
      rubricId: round.rubric.id,
      submissionVersion: submissionRevision,
      round,
      submission: visibleSubmission.identityRedacted
        ? {
            ...visibleSubmission,
            answers: {},
            files: (visibleSubmission.files ?? []).map(({ mimeType, sizeBytes }) => ({
              id: "redacted",
              name: "attachment",
              mimeType,
              sizeBytes,
            })),
          }
        : visibleSubmission,
    };
    let result: EvaluationSuggestionProviderResult;
    try {
      result = await producer(providerInput);
    } catch {
      throw advisoryUnavailable();
    }
    const latestMaterial = await this.#submissions.getSubmissionForReview(
      actor.tenantId,
      plan.eventId,
      material.id,
    );
    if (latestMaterial === null) throw notFound("The submission was not found.");
    await this.#requireActiveSubmission(plan, latestMaterial);
    const latestRevision = await this.#submissionRevision(
      actor.tenantId,
      plan.eventId,
      material.id,
      latestMaterial.version ?? latestMaterial.revision,
    );
    if (latestRevision !== submissionRevision) {
      throw conflict("The submission changed while AI triage was generated.");
    }
    const candidates = this.#normalizeProviderCandidates(result, round, providerInput);
    const provenance: EvaluationSuggestionProvenance = {
      provider: result.provenance?.provider ?? "injected",
      model: result.provenance?.model ?? "unspecified",
      generatedAt: result.provenance?.generatedAt ?? now,
      sourceReferences: candidates.flatMap((candidate) => candidate.provenance.sourceReferences),
      ...(result.provenance?.promptVersion === undefined
        ? {}
        : { promptVersion: result.provenance.promptVersion }),
      ...(result.provenance?.traceId === undefined ? {} : { traceId: result.provenance.traceId }),
    };
    const finalizedCandidates = candidates.map((candidate) => ({
      ...candidate,
      provenance: candidate.provenance ?? provenance,
    }));
    const byCriterion: Record<string, EvaluationSuggestionCandidate[]> = {};
    for (const candidate of finalizedCandidates) {
      const criterionCandidates = byCriterion[candidate.criterionId];
      if (criterionCandidates === undefined) {
        byCriterion[candidate.criterionId] = [candidate];
      } else {
        criterionCandidates.push(candidate);
      }
    }
    const auditEntry: EvaluationSuggestionAuditEntry = {
      action: "generate",
      actorId: actor.userId,
      at: now,
    };
    const suggestion: EvaluationSuggestion = {
      id: `suggestion:${round.id}:${material.id}:${crypto.randomUUID()}`,
      tenantId: actor.tenantId,
      eventId: plan.eventId,
      planId: plan.id,
      roundId: round.id,
      assignmentId: null,
      submissionId: material.id,
      reviewerId: actor.userId,
      rubricRevision,
      submissionRevision,
      planRevision,
      rubricId: round.rubric.id,
      submissionVersion: submissionRevision,
      candidates: byCriterion,
      criterionCandidates: finalizedCandidates,
      provenance,
      status: "pending",
      version: 1,
      history: [auditEntry],
      audit: [auditEntry],
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.#repository.putSuggestion(suggestion, null, submissionRevision);
      return suggestion;
    } catch (error) {
      if (!(error instanceof EvaluationError) || error.code !== "EVALUATION_CONFLICT") throw error;
      const concurrent = (await this.#repository.listSuggestions(actor.tenantId, plan.id)).find(
        (candidate) =>
          candidate.roundId === round.id &&
          candidate.submissionId === material.id &&
          candidate.assignmentId === null &&
          candidate.status !== "stale" &&
          candidate.rubricRevision === rubricRevision &&
          candidate.submissionRevision === submissionRevision,
      );
      if (concurrent === undefined) throw error;
      return concurrent;
    }
  }

  /** Organizer-only: list shared round suggestions (one per submission per generation). */
  async listRoundAiSuggestions(
    actor: EvaluationActor,
    planId: string,
    roundId: string,
  ): Promise<readonly EvaluationSuggestion[]> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    const round = findRound(plan, roundId);
    const rubricRevision = round.rubricRevision ?? gradingRevision(plan);
    const now = this.#clock().toISOString();
    const suggestions = (await this.#repository.listSuggestions(actor.tenantId, plan.id)).filter(
      (suggestion) => suggestion.roundId === roundId && suggestion.assignmentId === null,
    );
    const currentSuggestions = await Promise.all(
      suggestions.map(async (suggestion) => {
        if (suggestion.status === "stale") return suggestion;
        const material = await this.#submissions.getSubmissionForReview(
          actor.tenantId,
          plan.eventId,
          suggestion.submissionId,
        );
        if (material?.status !== "submitted") return suggestion;
        const submissionRevision = await this.#submissionRevision(
          actor.tenantId,
          plan.eventId,
          material.id,
          material.version ?? material.revision,
        );
        if (
          suggestion.rubricRevision === rubricRevision &&
          suggestion.submissionRevision === submissionRevision
        ) {
          return suggestion;
        }
        const stale = this.#markSuggestionStale(suggestion, actor.userId, now);
        await this.#repository.putSuggestion(stale, suggestion.version, submissionRevision, true);
        return stale;
      }),
    );
    return currentSuggestions.sort(
      (left, right) =>
        left.submissionId.localeCompare(right.submissionId) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }

  /** Organizer-only: apply a persisted override on top of AI values. */
  async overrideAiSuggestion(
    actor: EvaluationActor,
    suggestionId: string,
    input: OverrideAiSuggestionInput,
  ): Promise<EvaluationSuggestion> {
    const suggestion = await this.#repository.getSuggestion(actor.tenantId, suggestionId);
    if (suggestion === null || suggestion.assignmentId !== null) {
      throw notFound("The AI evaluation suggestion was not found.");
    }
    const plan = await this.#getPlan(actor.tenantId, suggestion.planId);
    requireHumanOrganizer(actor, plan.eventId);
    const round = findRound(plan, suggestion.roundId);
    if (suggestion.status === "stale") {
      throw conflict("The AI evaluation suggestion is stale and must be regenerated.");
    }
    if (input.expectedVersion !== suggestion.version) {
      throw conflict("The AI evaluation suggestion changed since it was loaded.");
    }
    const scoreable = new Map(
      scoreableRubricCriteria(round).map((criterion) => [criterion.id, criterion]),
    );
    const auditValues: Record<string, number | string> = {};
    for (const [criterionId, value] of Object.entries(input.valueByCriterion)) {
      const criterion = scoreable.get(criterionId);
      if (criterion === undefined) {
        throw invalidInput("The override targets a criterion outside this round's rubric.");
      }
      if ((criterion.inputType ?? "numeric") === "dropdown") {
        const valid = (criterion.options ?? []).some(
          (option, index) =>
            option.value === String(value) ||
            (typeof value === "number" && criterion.minimum + index === value),
        );
        if (!valid) throw invalidInput("The override value is outside the configured options.");
        auditValues[criterionId] = value;
      } else if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < criterion.minimum ||
        value > criterion.maximum
      ) {
        throw invalidInput("The override value is outside the current rubric.");
      } else {
        auditValues[criterionId] = value;
      }
    }
    if (Object.keys(input.valueByCriterion).length === 0) {
      throw invalidInput("Provide at least one override value.");
    }
    await this.#requireActiveSubmission(plan, suggestion.submissionId);
    const now = this.#clock().toISOString();
    const override = {
      valueByCriterion: input.valueByCriterion,
      overriddenBy: actor.userId,
      overriddenAt: now,
      ...(input.reason !== undefined && input.reason.trim().length > 0
        ? { reason: input.reason.trim() }
        : {}),
    };
    const auditEntry: EvaluationSuggestionAuditEntry = {
      action: "override",
      actorId: actor.userId,
      at: now,
      ...(input.reason !== undefined && input.reason.trim().length > 0
        ? { reason: input.reason.trim() }
        : {}),
      valueByCriterion: auditValues,
    };
    const updated: EvaluationSuggestion = {
      ...suggestion,
      status: "overridden",
      override,
      version: suggestion.version + 1,
      history: [...suggestion.history, auditEntry],
      audit: [...suggestion.audit, auditEntry],
      updatedAt: now,
    };
    await this.#repository.putSuggestion(
      updated,
      suggestion.version,
      suggestion.submissionRevision,
    );
    return updated;
  }

  async submitReview(
    actor: EvaluationActor,
    assignmentId: string,
    expectedReviewVersion: number,
  ): Promise<EvaluationReview> {
    const assignment = await this.#getAssignment(actor.tenantId, assignmentId);
    requireHumanReviewer(actor, assignment);
    if (await this.#repository.getConflict(actor.tenantId, assignment.id)) {
      throw forbidden("A conflict declaration removes access to this submission.");
    }
    const current = await this.#repository.getReview(actor.tenantId, assignment.id);
    if (current !== null && current.submittedAt !== null) {
      return current;
    }
    const plan = await this.#getPlan(actor.tenantId, assignment.planId);
    const round = findRound(plan, assignment.roundId);
    assertPlanIsWritable(plan, round, this.#clock());
    await this.#requireActiveSubmission(plan, assignment.submissionId);
    if (current === null) {
      throw invalidInput("Create a review draft before submitting it.");
    }
    if (current.version !== expectedReviewVersion) {
      throw conflict("Review changed since it was loaded.");
    }
    for (const criterion of round.rubric.criteria) {
      const score = current.scores[criterion.id];
      const missingValue =
        score === undefined
          ? true
          : (criterion.inputType ?? "numeric") === "free_text"
            ? typeof score.value !== "string" || score.value.trim().length === 0
            : typeof score.value !== "number";
      if (criterion.required && (missingValue || !isHumanConfirmedScore(score))) {
        throw invalidInput("Every required rubric score needs human confirmation.");
      }
    }
    const now = this.#clock().toISOString();
    const review: EvaluationReview = {
      ...current,
      submittedAt: now,
      version: current.version + 1,
      updatedAt: now,
    };
    const submittedAssignment: EvaluationAssignment = {
      ...assignment,
      status: "submitted",
      version: assignment.version + 1,
      updatedAt: now,
    };
    await this.#requireActiveSubmission(plan, assignment.submissionId);
    await this.#repository.writeReview({
      authority: {
        tenantId: assignment.tenantId,
        eventId: assignment.eventId,
        planId: assignment.planId,
        roundId: assignment.roundId,
        assignmentId: assignment.id,
        submissionId: assignment.submissionId,
        reviewerId: assignment.reviewerId,
        expectedAssignmentVersion: assignment.version,
        expectedPlanVersion: plan.version,
      },
      review,
      expectedReviewVersion: current.version,
      assignmentUpdate: submittedAssignment,
    });
    return review;
  }

  async declareConflict(
    actor: EvaluationActor,
    assignmentId: string,
    reason: string,
  ): Promise<EvaluationConflictDeclaration> {
    const assignment = await this.#getAssignment(actor.tenantId, assignmentId);
    requireHumanReviewer(actor, assignment);
    const plan = await this.#getPlan(actor.tenantId, assignment.planId);
    await this.#requireActiveSubmission(plan, assignment.submissionId);
    const existing = await this.#repository.getConflict(actor.tenantId, assignment.id);
    if (existing !== null) {
      return existing;
    }
    const now = this.#clock().toISOString();
    const declaration: EvaluationConflictDeclaration = {
      id: `conflict:${assignment.id}`,
      tenantId: actor.tenantId,
      eventId: assignment.eventId,
      planId: assignment.planId,
      assignmentId: assignment.id,
      submissionId: assignment.submissionId,
      reviewerId: actor.userId,
      reason: requireText(reason, "Conflict reason", 2_000),
      declaredAt: now,
    };
    await this.#requireActiveSubmission(plan, assignment.submissionId);
    await this.#repository.abstainAssignment(
      {
        ...assignment,
        status: "abstained",
        version: assignment.version + 1,
        updatedAt: now,
      },
      assignment.version,
      declaration,
    );
    return declaration;
  }

  async listSubmittedReviews(
    actor: EvaluationActor,
    planId: string,
    roundId: string,
    submissionId: string,
  ): Promise<readonly EvaluationReview[]> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    const round = findRound(plan, roundId);
    await this.#requireReviewableSubmission(plan, submissionId);
    const assignments = await this.#repository.listAssignments(actor.tenantId, plan.id);
    const assignmentIds = new Set(
      assignments
        .filter((assignment) => isCountedAssignmentForRound(plan, round, submissionId, assignment))
        .map((assignment) => assignment.id),
    );
    return (await this.#repository.listReviews(actor.tenantId, plan.id))
      .filter(
        (review) =>
          assignmentIds.has(review.assignmentId) &&
          review.submittedAt !== null &&
          isReviewForRoundRevision(plan, round, review),
      )
      .map((review) => ({
        ...review,
        scores: Object.fromEntries(
          Object.entries(review.scores).filter(([, score]) => isHumanConfirmedScore(score)),
        ),
      }));
  }
  async getAggregate(
    actor: EvaluationActor,
    planId: string,
    roundId: string,
    submissionId: string,
  ): Promise<EvaluationAggregate> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    const round = findRound(plan, roundId);
    const [material, assignments, reviews] = await Promise.all([
      this.#submissions.getSubmissionForReview(actor.tenantId, plan.eventId, submissionId),
      this.#repository.listAssignments(actor.tenantId, plan.id),
      this.#repository.listReviews(actor.tenantId, plan.id),
    ]);
    await this.#requireReviewableSubmission(plan, material ?? submissionId);
    return aggregateForSubmission(plan, round, submissionId, assignments, reviews);
  }

  async listAggregates(
    actor: EvaluationActor,
    planId: string,
    roundId: string,
  ): Promise<readonly EvaluationAggregate[]> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    const round = findRound(plan, roundId);
    const source = this.#submissions as SubmissionReviewSource & EvaluationSubmissionSource;
    if (source.listSubmissionsForOrganizer === undefined) return [];
    const [submissions, assignments, reviews] = await Promise.all([
      source.listSubmissionsForOrganizer(actor.tenantId, plan.eventId),
      this.#repository.listAssignments(actor.tenantId, plan.id),
      this.#repository.listReviews(actor.tenantId, plan.id),
    ]);
    return submissions
      .filter(isReviewableSubmission)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((submission) =>
        aggregateForSubmission(plan, round, submission.id, assignments, reviews),
      );
  }

  async getProgress(actor: EvaluationActor, planId: string): Promise<EvaluationProgress> {
    const plan = await this.#getPlan(actor.tenantId, planId);
    requireHumanOrganizer(actor, plan.eventId);
    const [allAssignments, reviews] = await Promise.all([
      this.#repository.listAssignments(actor.tenantId, plan.id),
      this.#repository.listReviews(actor.tenantId, plan.id),
    ]);
    const currentSubmissionIds = await this.#reviewableSubmissionIds(plan, allAssignments);
    return progressForAssignments(
      plan,
      effectiveAssignmentsForPlan(plan, allAssignments, reviews).filter((assignment) =>
        currentSubmissionIds.has(assignment.submissionId),
      ),
    );
  }

  async recordDecision(
    actor: EvaluationActor,
    input: RecordDecisionInput,
  ): Promise<EvaluationDecision> {
    const plan = await this.#getPlan(actor.tenantId, input.planId);
    requireHumanOrganizer(actor, plan.eventId);
    const reason = requireText(input.reason, "Decision reason", 5_000);
    const idempotencyKey = requireText(input.idempotencyKey, "Idempotency key", 200);
    const submissionId = requireText(input.submissionId, "Submission id", MAX_SUBMISSION_ID_LENGTH);
    const material = await this.#requireReviewableSubmission(plan, submissionId);
    if (input.status === "accepted") {
      requireAcceptableSubmission(material);
    }
    const current = await this.#repository.getDecision(actor.tenantId, plan.id, submissionId);
    const repeatedTransition = current?.history.find(
      (transition) => transition.idempotencyKey === idempotencyKey,
    );
    if (current !== null && repeatedTransition !== undefined) {
      if (repeatedTransition.to !== input.status || repeatedTransition.reason !== reason) {
        throw conflict("The decision idempotency key was already used with a different request.");
      }
      const repeatedVersion =
        current.history.findIndex((transition) => transition.idempotencyKey === idempotencyKey) + 1;
      if (
        this.#repository.usesDurableDecisionOutbox !== true &&
        repeatedVersion === current.version
      ) {
        await this.#runDecisionWork({
          decision: current,
          transition: repeatedTransition,
          decisionVersion: repeatedVersion,
        });
      }
      return current;
    }
    if (current === null && input.expectedVersion !== undefined) {
      throw conflict("The decision does not exist at the expected version.");
    }
    if (current !== null && current.version !== input.expectedVersion) {
      throw conflict("Decision changed since it was loaded.");
    }
    const now = this.#clock().toISOString();
    const transition = {
      from: current?.status ?? null,
      to: input.status,
      reason,
      decidedBy: actor.userId,
      decidedAt: now,
      idempotencyKey,
    };
    const decision: EvaluationDecision = {
      id: current?.id ?? `decision:${plan.id}:${submissionId}`,
      tenantId: actor.tenantId,
      eventId: plan.eventId,
      planId: plan.id,
      submissionId,
      status: input.status,
      version: (current?.version ?? 0) + 1,
      history: [...(current?.history ?? []), transition],
      updatedAt: now,
    };
    await this.#requireReviewableSubmission(plan, submissionId);
    await this.#repository.putDecision(decision, current?.version ?? null);
    if (this.#repository.usesDurableDecisionOutbox !== true) {
      await this.#runDecisionWork({
        decision,
        transition,
        decisionVersion: decision.version,
      });
    }
    return decision;
  }
  async #runDecisionWork(input: {
    readonly decision: EvaluationDecision;
    readonly transition: EvaluationDecisionTransition;
    readonly decisionVersion: number;
  }): Promise<void> {
    await this.#runDecisionProjection(input);
    if (input.transition.to !== "accepted") {
      await this.#runSessionDecisionReconciliation(input);
      return;
    }
    const acceptance = this.#runAcceptanceHandoff(input);
    await acceptance;
  }
  async #buildDistributionPreview(
    actor: EvaluationActor,
    input: PreviewEvaluationDistributionInput,
  ): Promise<{
    readonly preview: EvaluationDistributionPreview;
    readonly assignments: readonly EvaluationAssignment[];
  }> {
    const plan = await this.#getPlan(actor.tenantId, input.planId);
    requireHumanOrganizer(actor, plan.eventId);
    if (plan.status !== "open") {
      throw closed("Reviewer distribution requires an open evaluation plan.");
    }
    if (plan.version !== input.expectedVersion) {
      throw conflict("Evaluation plan changed since the distribution was requested.");
    }
    const round = findRound(plan, input.roundId);
    const submissionIds = input.submissionIds.map((submissionId) =>
      requireText(submissionId, "Submission id", MAX_SUBMISSION_ID_LENGTH),
    );
    if (submissionIds.length === 0 || new Set(submissionIds).size !== submissionIds.length) {
      throw invalidInput("Provide one or more unique submission ids.");
    }
    submissionIds.sort((left, right) => left.localeCompare(right));

    const requestedReviewerIds = (input.reviewerIds ?? round.reviewerPool?.reviewerIds ?? []).map(
      (reviewerId) => requireText(reviewerId, "Reviewer id", 100),
    );
    if (
      requestedReviewerIds.length === 0 ||
      new Set(requestedReviewerIds).size !== requestedReviewerIds.length
    ) {
      throw invalidInput("Provide one or more unique reviewer ids.");
    }
    requestedReviewerIds.sort((left, right) => left.localeCompare(right));

    const [materials, decisions] = await Promise.all([
      this.#submissions.getSubmissionsForReview(
        actor.tenantId,
        submissionIds.map((submissionId) => ({ eventId: plan.eventId, submissionId })),
      ),
      Promise.all(
        submissionIds.map((submissionId) =>
          this.#repository.getDecision(actor.tenantId, plan.id, submissionId),
        ),
      ),
    ]);
    const materialById = new Map(
      materials
        .filter(
          (material) => material.tenantId === actor.tenantId && material.eventId === plan.eventId,
        )
        .map((material) => [material.id, material] as const),
    );
    for (const [index, submissionId] of submissionIds.entries()) {
      const material = materialById.get(submissionId);
      if (material === undefined) {
        throw notFound(`Submission ${submissionId} was not found for reviewer distribution.`);
      }
      if (!isActiveReviewSubmission(material) || decisions[index] !== null) {
        throw conflict(`Submission ${submissionId} is no longer active for reviewer distribution.`);
      }
    }

    const allAssignments = (await this.#repository.listAssignments(actor.tenantId, plan.id)).filter(
      (assignment) => assignment.eventId === plan.eventId,
    );
    const actionableAssignments = allAssignments.filter(isActionableAssignment);
    const targetSubmissionIds = new Set(submissionIds);
    const targetAssignments = actionableAssignments.filter(
      (assignment) =>
        assignment.roundId === round.id && targetSubmissionIds.has(assignment.submissionId),
    );
    const abstentions = allAssignments.filter(
      (assignment) =>
        assignment.roundId === round.id &&
        targetSubmissionIds.has(assignment.submissionId) &&
        assignment.status === "abstained",
    );
    const reviewerLoad = new Map<string, number>();
    for (const assignment of actionableAssignments) {
      reviewerLoad.set(assignment.reviewerId, (reviewerLoad.get(assignment.reviewerId) ?? 0) + 1);
    }

    const pool = round.reviewerPool?.reviewerIds;
    const poolSet = pool === undefined ? null : new Set(pool);
    const eligibleReviewerIds = requestedReviewerIds.filter(
      (reviewerId) => poolSet === null || poolSet.has(reviewerId),
    );
    const exclusions: Array<EvaluationDistributionPreview["exclusions"][number]> = [];
    const desired: EvaluationAssignment[] = [];
    const desiredAssignments: Array<EvaluationDistributionPreview["desiredAssignments"][number]> =
      [];
    const deficits: Array<EvaluationDistributionPreview["deficits"][number]> = [];
    const submissionRevisions: Array<EvaluationDistributionPreview["submissionRevisions"][number]> =
      [];
    const now = this.#clock().toISOString();
    const planRevision = gradingRevision(plan);
    const rubricRevision = round.rubricRevision ?? planRevision;
    const roundRevision = round.revision ?? planRevision;
    const trackFilter = round.trackFilter ?? plan.assignmentRule.trackFilter ?? null;

    for (const submissionId of submissionIds) {
      const material = materialById.get(submissionId);
      if (material === undefined) continue;
      const submissionRevision = await this.#submissionRevision(
        actor.tenantId,
        plan.eventId,
        submissionId,
        material.version ?? material.revision,
      );
      submissionRevisions.push({ submissionId, revision: submissionRevision });
      const existing = targetAssignments
        .filter((assignment) => assignment.submissionId === submissionId)
        .sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
      for (const assignment of existing) {
        desired.push(assignment);
        desiredAssignments.push({
          submissionId,
          reviewerId: assignment.reviewerId,
          existingAssignmentId: assignment.id,
        });
      }

      const outsideTrack = trackFilter !== null && !(material.trackIds ?? []).includes(trackFilter);
      for (const reviewerId of requestedReviewerIds) {
        if (poolSet !== null && !poolSet.has(reviewerId)) {
          exclusions.push({ submissionId, reviewerId, reason: "outside_pool" });
        } else if (outsideTrack) {
          exclusions.push({ submissionId, reviewerId, reason: "outside_track" });
        } else if (existing.some((assignment) => assignment.reviewerId === reviewerId)) {
          exclusions.push({ submissionId, reviewerId, reason: "already_assigned" });
        }
      }

      let missing = Math.max(0, plan.assignmentRule.reviewsPerSubmission - existing.length);
      if (!outsideTrack) {
        const candidates = eligibleReviewerIds
          .filter(
            (reviewerId) => !existing.some((assignment) => assignment.reviewerId === reviewerId),
          )
          .sort(
            (left, right) =>
              (reviewerLoad.get(left) ?? 0) - (reviewerLoad.get(right) ?? 0) ||
              left.localeCompare(right),
          );
        for (const reviewerId of candidates) {
          if (
            abstentions.some(
              (assignment) =>
                assignment.submissionId === submissionId && assignment.reviewerId === reviewerId,
            )
          ) {
            exclusions.push({ submissionId, reviewerId, reason: "declared_conflict" });
            continue;
          }
          if (
            (reviewerLoad.get(reviewerId) ?? 0) >= plan.assignmentRule.maxAssignmentsPerReviewer
          ) {
            exclusions.push({ submissionId, reviewerId, reason: "reviewer_cap" });
            continue;
          }
          if (missing === 0) break;
          const baseAssignmentId = `${plan.id}:${round.id}:${submissionId}:${reviewerId}`;
          const matchingIdCount = allAssignments.filter(
            (assignment) =>
              assignment.id === baseAssignmentId ||
              assignment.id.startsWith(`${baseAssignmentId}:v`),
          ).length;
          const assignment: EvaluationAssignment = {
            id:
              matchingIdCount === 0
                ? baseAssignmentId
                : `${baseAssignmentId}:v${matchingIdCount + 1}`,
            tenantId: actor.tenantId,
            eventId: plan.eventId,
            planId: plan.id,
            roundId: round.id,
            submissionId,
            reviewerId,
            status: "assigned",
            planVersion: planRevision,
            rubricRevision,
            roundRevision,
            submissionRevision,
            version: 1,
            createdAt: now,
            updatedAt: now,
          };
          desired.push(assignment);
          desiredAssignments.push({ submissionId, reviewerId });
          reviewerLoad.set(reviewerId, (reviewerLoad.get(reviewerId) ?? 0) + 1);
          missing -= 1;
        }
      }
      if (missing > 0) {
        deficits.push({
          submissionId,
          missingReviewCount: missing,
          reason: outsideTrack ? "submission_outside_track" : "insufficient_eligible_reviewers",
        });
      }
    }

    desired.sort(
      (left, right) =>
        left.submissionId.localeCompare(right.submissionId) ||
        left.reviewerId.localeCompare(right.reviewerId) ||
        left.id.localeCompare(right.id),
    );
    desiredAssignments.sort(
      (left, right) =>
        left.submissionId.localeCompare(right.submissionId) ||
        left.reviewerId.localeCompare(right.reviewerId),
    );
    exclusions.sort(
      (left, right) =>
        left.submissionId.localeCompare(right.submissionId) ||
        left.reviewerId.localeCompare(right.reviewerId) ||
        left.reason.localeCompare(right.reason),
    );
    const expectedActiveVersions = targetAssignments
      .map((assignment) => ({ assignmentId: assignment.id, version: assignment.version }))
      .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId));
    const scope = {
      tenantId: actor.tenantId,
      eventId: plan.eventId,
      planId: plan.id,
      roundId: round.id,
      planVersion: planRevision,
    } as const;
    const fingerprint = distributionFingerprint({
      scope,
      reviewsPerSubmission: plan.assignmentRule.reviewsPerSubmission,
      maxAssignmentsPerReviewer: plan.assignmentRule.maxAssignmentsPerReviewer,
      trackFilter,
      submissionIds,
      requestedReviewerIds,
      submissionRevisions,
      assignmentVersions: actionableAssignments
        .map((assignment) => ({
          id: assignment.id,
          status: assignment.status,
          version: assignment.version,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      desiredAssignments,
      deficits,
      exclusions,
    });
    return {
      preview: {
        scope,
        desiredAssignments,
        deficits,
        exclusions,
        expectedActiveVersions,
        submissionRevisions,
        fingerprint,
      },
      assignments: desired,
    };
  }

  async #submissionRevision(
    tenantId: string,
    eventId: string,
    submissionId: string,
    materialVersion?: number,
  ): Promise<number> {
    if (
      materialVersion !== undefined &&
      Number.isSafeInteger(materialVersion) &&
      materialVersion > 0
    ) {
      return materialVersion;
    }
    const source = this.#submissions as SubmissionReviewSource & EvaluationSubmissionSource;
    if (source.listSubmissionsForOrganizer !== undefined) {
      const submission = (await source.listSubmissionsForOrganizer(tenantId, eventId)).find(
        (candidate) => candidate.id === submissionId,
      );
      if (submission !== undefined) {
        const version = submission.version ?? submission.revision;
        if (version !== undefined && version > 0) return version;
      }
    }
    return 1;
  }

  #visibleSubmission(
    plan: EvaluationPlan,
    round: ReviewRound,
    material: Awaited<ReturnType<SubmissionReviewSource["getSubmissionForReview"]>> extends infer T
      ? NonNullable<T>
      : never,
  ): ReviewContext["submission"] {
    const projection = normalizeProjection(
      plan.reviewerProjection ?? plan.evaluatorProjection ?? plan.projection,
    );
    const blindReview =
      plan.blindReview ||
      round.blindReview === true ||
      (round.anonymization !== undefined && round.anonymization !== "none");
    const identityFields = blindReview ? new Set(material.identityFieldIds) : new Set<string>();
    const selectedFields = projection.fieldIds ?? projection.visibleFieldIds;
    const answers = Object.fromEntries(
      Object.entries(material.answers).filter(
        ([fieldId]) =>
          !identityFields.has(fieldId) &&
          (selectedFields === undefined || selectedFields.includes(fieldId)),
      ),
    );
    const selectedFiles = projection.fileIds ?? projection.visibleFileIds;
    const files = (material.files ?? []).filter((file) => selectedFiles?.includes(file.id));
    return {
      id: material.id,
      title: material.title,
      abstract: material.abstract,
      answers,
      participants: blindReview ? [] : material.participants,
      files,
      identityRedacted: blindReview,
    };
  }

  #markSuggestionStale(
    suggestion: EvaluationSuggestion,
    actorId: string | null,
    at: string,
  ): EvaluationSuggestion {
    if (suggestion.status === "stale") return suggestion;
    const entry: EvaluationSuggestionAuditEntry = {
      action: "stale",
      actorId,
      at,
      reason: "The rubric or submission revision changed.",
    };
    return {
      ...suggestion,
      status: "stale",
      version: suggestion.version + 1,
      history: [...suggestion.history, entry],
      audit: [...suggestion.audit, entry],
      updatedAt: at,
    };
  }

  async #markSuggestionsStaleForPlan(
    tenantId: string,
    planId: string,
    at: string,
    actorId: string,
  ): Promise<void> {
    const suggestions = await this.#repository.listSuggestions(tenantId, planId);
    await Promise.all(
      suggestions
        .filter((suggestion) => suggestion.status === "pending")
        .map(async (suggestion) => {
          const updated = this.#markSuggestionStale(suggestion, actorId, at);
          await this.#repository.putSuggestion(
            updated,
            suggestion.version,
            suggestion.submissionRevision,
            true,
          );
        }),
    );
  }

  #normalizeProviderCandidates(
    result: EvaluationSuggestionProviderResult,
    round: ReviewRound,
    input: EvaluationSuggestionProviderInput,
  ): EvaluationSuggestionCandidate[] {
    const providerCandidates: unknown = result.candidates;
    const criteria = new Map(
      scoreableRubricCriteria(round).map((criterion) => [criterion.id, criterion]),
    );
    const rawCandidates: Array<{ raw: unknown; criterionIdHint?: string }> = [];
    if (Array.isArray(providerCandidates)) {
      rawCandidates.push(...providerCandidates.map((raw) => ({ raw })));
    } else if (typeof providerCandidates === "object" && providerCandidates !== null) {
      const candidateBuckets = Object.entries(providerCandidates);
      if (
        candidateBuckets.length !== criteria.size ||
        candidateBuckets.some(
          ([criterionId, values]) => !criteria.has(criterionId) || !Array.isArray(values),
        )
      ) {
        throw invalidInput(
          "The AI suggestion provider must return exactly one candidate for every scoreable criterion.",
        );
      }
      for (const [criterionIdHint, values] of candidateBuckets) {
        if (!Array.isArray(values) || values.length !== 1) {
          throw invalidInput(
            "The AI suggestion provider must return exactly one candidate for every scoreable criterion.",
          );
        }
        rawCandidates.push(...values.map((raw) => ({ raw, criterionIdHint })));
      }
    } else {
      throw invalidInput(
        "The AI suggestion provider must return exactly one candidate for every scoreable criterion.",
      );
    }
    if (rawCandidates.length !== criteria.size) {
      throw invalidInput(
        "The AI suggestion provider must return exactly one candidate for every scoreable criterion.",
      );
    }
    const seenCriterionIds = new Set<string>();
    const candidates = rawCandidates.map(({ raw, criterionIdHint }, index) => {
      if (typeof raw !== "object" || raw === null) {
        throw invalidInput("The AI suggestion provider returned an invalid candidate.");
      }
      const candidate = raw as {
        criterionId?: unknown;
        value?: unknown;
        evidence?: unknown;
        id?: unknown;
        provenance?: Partial<EvaluationSuggestionProvenance>;
      };
      const criterionId =
        typeof candidate.criterionId === "string" ? candidate.criterionId : (criterionIdHint ?? "");
      if (
        criterionIdHint !== undefined &&
        typeof candidate.criterionId === "string" &&
        candidate.criterionId !== criterionIdHint
      ) {
        throw invalidInput(
          "The AI suggestion provider must return exactly one candidate for every scoreable criterion.",
        );
      }
      const criterion = criteria.get(criterionId);
      if (criterion === undefined || seenCriterionIds.has(criterionId)) {
        throw invalidInput(
          "The AI suggestion provider must return exactly one candidate for every scoreable criterion.",
        );
      }
      seenCriterionIds.add(criterionId);
      if (
        typeof candidate.value !== "number" ||
        !Number.isFinite(candidate.value) ||
        candidate.value < criterion.minimum ||
        candidate.value > criterion.maximum
      ) {
        throw invalidInput(`AI candidate ${criterion.id} is outside its rubric bounds.`);
      }
      if ((criterion.inputType ?? "numeric") === "dropdown") {
        normalizeDropdownValue(criterion, candidate.value);
      }
      if (
        !Array.isArray(candidate.evidence) ||
        candidate.evidence.length === 0 ||
        candidate.evidence.length > 3
      ) {
        throw invalidInput("Every AI candidate must include a submission-specific rationale.");
      }
      const sourceReferences = candidate.provenance?.sourceReferences;
      if (
        !Array.isArray(sourceReferences) ||
        sourceReferences.length !== candidate.evidence.length ||
        sourceReferences.some((reference) => typeof reference !== "string")
      ) {
        throw invalidInput("Every AI candidate must include an exact submission excerpt.");
      }
      const parsedReferences = sourceReferences.map((reference) =>
        parseSubmissionExcerptReference(reference, input.submission),
      );
      const exactReferences = parsedReferences.filter(
        (reference): reference is NonNullable<typeof reference> => reference !== null,
      );
      if (exactReferences.length !== parsedReferences.length) {
        throw invalidInput("Every AI candidate must include an exact submission excerpt.");
      }
      const evidence = candidate.evidence.map((citation, index) => {
        if (typeof citation !== "string") {
          throw invalidInput("Every AI candidate must include a submission-specific rationale.");
        }
        const rationale = requireText(citation, "AI evidence", 2_000);
        if (!isEnglishSuggestionRationale(rationale)) {
          throw invalidInput("Every AI candidate rationale must be written in English.");
        }
        if (!isMeaningfulSuggestionRationale(rationale, exactReferences[index]?.excerpt ?? "")) {
          throw invalidInput("Every AI candidate must include a submission-specific rationale.");
        }
        return rationale;
      });
      const provenance: EvaluationSuggestionProvenance = {
        provider: candidate.provenance?.provider ?? "injected",
        model: candidate.provenance?.model ?? "unspecified",
        generatedAt: candidate.provenance?.generatedAt ?? this.#clock().toISOString(),
        sourceReferences,
        ...(candidate.provenance?.promptVersion === undefined
          ? {}
          : { promptVersion: candidate.provenance.promptVersion }),
        ...(candidate.provenance?.traceId === undefined
          ? {}
          : { traceId: candidate.provenance.traceId }),
      };
      return {
        id:
          typeof candidate.id === "string" && candidate.id.trim().length > 0
            ? candidate.id
            : `${input.submissionId}:${criterionId}:${index + 1}`,
        criterionId,
        value: candidate.value,
        evidence,
        provenance,
      };
    });
    if (seenCriterionIds.size !== criteria.size) {
      throw invalidInput(
        "The AI suggestion provider must return exactly one candidate for every scoreable criterion.",
      );
    }
    return candidates;
  }

  async #reviewableSubmissionIds(
    plan: EvaluationPlan,
    assignments: readonly EvaluationAssignment[],
  ): Promise<ReadonlySet<string>> {
    const submissionIds = [
      ...new Set(
        assignments
          .filter(
            (assignment) =>
              assignment.tenantId === plan.tenantId &&
              assignment.eventId === plan.eventId &&
              assignment.planId === plan.id,
          )
          .map((assignment) => assignment.submissionId),
      ),
    ];
    if (submissionIds.length === 0) return new Set();
    const materials = await this.#submissions.getSubmissionsForReview(
      plan.tenantId,
      submissionIds.map((submissionId) => ({ eventId: plan.eventId, submissionId })),
    );
    const materialById = new Map(materials.map((material) => [material.id, material] as const));
    return new Set(
      submissionIds.filter((submissionId) => {
        const material = materialById.get(submissionId);
        return material !== undefined && isReviewableSubmission(material);
      }),
    );
  }

  async #activeSubmissionIds(
    plan: EvaluationPlan,
    assignments: readonly EvaluationAssignment[],
  ): Promise<ReadonlySet<string>> {
    const reviewableSubmissionIds = await this.#reviewableSubmissionIds(plan, assignments);
    const decisions = await Promise.all(
      [...reviewableSubmissionIds].map((submissionId) =>
        this.#repository.getDecision(plan.tenantId, plan.id, submissionId),
      ),
    );
    return new Set([...reviewableSubmissionIds].filter((_, index) => decisions[index] === null));
  }

  async #requireReviewableSubmission(
    plan: EvaluationPlan,
    submission: string | SubmissionReviewMaterial,
  ): Promise<SubmissionReviewMaterial> {
    const material =
      typeof submission === "string"
        ? await this.#submissions.getSubmissionForReview(plan.tenantId, plan.eventId, submission)
        : submission;
    if (
      material === null ||
      material.tenantId !== plan.tenantId ||
      material.eventId !== plan.eventId ||
      !isReviewableSubmission(material)
    ) {
      throw notFound("Submission not found.");
    }
    return material;
  }

  async #requireActiveSubmission(
    plan: EvaluationPlan,
    submission: string | SubmissionReviewMaterial,
  ): Promise<SubmissionReviewMaterial> {
    const material =
      typeof submission === "string"
        ? await this.#submissions.getSubmissionForReview(plan.tenantId, plan.eventId, submission)
        : submission;
    if (
      material === null ||
      material.tenantId !== plan.tenantId ||
      material.eventId !== plan.eventId
    ) {
      throw notFound("Submission not found.");
    }
    const decision = await this.#repository.getDecision(plan.tenantId, plan.id, material.id);
    if (!isActiveReviewSubmission(material) || decision !== null) {
      throw conflict("This submission is no longer active for review.");
    }
    return material;
  }

  async #getWritableAssignment(
    actor: EvaluationActor,
    assignmentId: string,
  ): Promise<{ assignment: EvaluationAssignment; plan: EvaluationPlan; round: ReviewRound }> {
    const assignment = await this.#getAssignment(actor.tenantId, assignmentId);
    requireHumanReviewer(actor, assignment);
    await this.#requireNoAssignmentConflict(actor.tenantId, assignment.id);
    if (await this.#repository.hasPendingPlanLineageRepair(actor.tenantId, assignment.eventId)) {
      throw conflict("Review plan lineage requires operator repair.");
    }
    const plan = await this.#reviewerOperationalPlan(
      await this.#getPlan(actor.tenantId, assignment.planId),
    );
    const round = findRound(plan, assignment.roundId);
    assertPlanIsWritable(plan, round, this.#clock());
    await this.#requireActiveSubmission(plan, assignment.submissionId);
    return { assignment, plan, round };
  }

  async #requireNoAssignmentConflict(tenantId: string, assignmentId: string): Promise<void> {
    if (await this.#repository.getConflict(tenantId, assignmentId)) {
      throw forbidden("A conflict declaration removes access to this submission.");
    }
  }

  async #getPlan(tenantId: string, planId: string): Promise<EvaluationPlan> {
    const plan = await this.#repository.getPlan(tenantId, planId);
    if (plan === null) {
      throw notFound("The evaluation plan was not found.");
    }
    return plan;
  }

  async #requirePlanTip(plan: EvaluationPlan): Promise<void> {
    const successor = await this.#repository.getPlanSuccessor(plan.tenantId, plan.eventId, plan.id);
    if (successor !== null) {
      throw conflict("Only the latest review plan revision can change lifecycle or schedule.");
    }
  }

  async #reviewerOperationalPlan(plan: EvaluationPlan): Promise<EvaluationPlan> {
    if (plan.status === "draft") return plan;
    let tip = plan;
    const visited = new Set([plan.id]);
    for (let depth = 0; depth < MAX_REVISION_DEPTH; depth += 1) {
      const successor = await this.#repository.getPlanSuccessor(
        plan.tenantId,
        plan.eventId,
        tip.id,
      );
      if (successor === null || successor.status === "draft") break;
      if (visited.has(successor.id)) {
        throw conflict("Review plan revision lineage contains a cycle.");
      }
      visited.add(successor.id);
      tip = successor;
    }
    const overflow = await this.#repository.getPlanSuccessor(plan.tenantId, plan.eventId, tip.id);
    if (overflow !== null && overflow.status !== "draft") {
      throw conflict("Review plan revision depth exceeds the synchronization limit.");
    }
    if (tip.id === plan.id) return plan;
    const snapshot = await revisionScheduleSnapshot(
      this.#repository,
      tip,
      this.#clock().toISOString(),
      { allowOversizedPlans: true, ignoreRoundLimit: true },
    );
    const projection = snapshot.syncs.find((sync) => sync.plan.id === plan.id)?.plan;
    if (projection === undefined) return plan;
    const roundSchedules = new Map(projection.rounds.map((round) => [round.id, round]));
    return {
      ...plan,
      status: projection.status,
      closesAt: projection.closesAt ?? null,
      version: projection.version,
      updatedAt: projection.updatedAt,
      rounds: plan.rounds.map((round) => {
        const schedule = roundSchedules.get(round.id);
        return schedule === undefined
          ? round
          : {
              ...round,
              opensAt: schedule.opensAt ?? null,
              closesAt: schedule.closesAt ?? null,
            };
      }),
    };
  }

  #reviewerOperationalPlanFromListedPlans(
    plan: EvaluationPlan,
    planByKey: ReadonlyMap<string, EvaluationPlan>,
    successorByPredecessor: ReadonlyMap<string, EvaluationPlan>,
  ): EvaluationPlan {
    const planKey = (eventId: string, planId: string) => `${eventId}\u0000${planId}`;
    const visited = new Set([plan.id]);
    let tip = plan;
    for (let depth = 0; depth < MAX_REVISION_DEPTH; depth += 1) {
      const successor = successorByPredecessor.get(planKey(plan.eventId, tip.id));
      if (successor === undefined || successor.status === "draft") break;
      if (
        successor.tenantId !== plan.tenantId ||
        successor.eventId !== plan.eventId ||
        successor.predecessorPlanId !== tip.id ||
        visited.has(successor.id)
      ) {
        throw conflict("Review plan revision lineage is invalid.");
      }
      visited.add(successor.id);
      tip = successor;
      if (depth === MAX_REVISION_DEPTH - 1) {
        const overflow = successorByPredecessor.get(planKey(plan.eventId, tip.id));
        if (overflow !== undefined && overflow.status !== "draft") {
          throw conflict("Review plan revision depth exceeds the synchronization limit.");
        }
      }
    }
    if (tip.id === plan.id) return plan;

    const projectedAt = this.#clock().toISOString();
    const authoritativeStatus = tip.status;
    let child = tip;
    while (child.id !== plan.id) {
      const predecessorPlanId = child.predecessorPlanId;
      if (predecessorPlanId == null) {
        throw conflict("Review plan revision lineage is invalid.");
      }
      const parent = planByKey.get(planKey(plan.eventId, predecessorPlanId));
      if (parent === undefined) {
        throw conflict("Review plan revision lineage is invalid.");
      }
      const childRoundByPredecessor = new Map(
        child.rounds
          .filter((round) => round.predecessorRoundId !== null)
          .map((round) => [round.predecessorRoundId as string, round] as const),
      );
      const rounds = parent.rounds.map((round) => {
        const successorRound = childRoundByPredecessor.get(round.id);
        if (successorRound === undefined) {
          throw conflict("Review plan revision cannot remove a predecessor round.");
        }
        return {
          ...round,
          opensAt: successorRound.opensAt,
          closesAt: successorRound.closesAt,
        };
      });
      const changed =
        parent.status !== authoritativeStatus ||
        parent.closesAt !== child.closesAt ||
        rounds.some(
          (round, index) =>
            round.opensAt !== parent.rounds[index]?.opensAt ||
            round.closesAt !== parent.rounds[index]?.closesAt,
        );
      child = {
        ...parent,
        status: authoritativeStatus,
        closesAt: child.closesAt,
        rounds,
        version: changed ? parent.version + 1 : parent.version,
        updatedAt: changed ? projectedAt : parent.updatedAt,
      };
    }
    return child;
  }

  async #runDecisionProjection(input: {
    readonly decision: EvaluationDecision;
    readonly transition: EvaluationDecisionTransition;
    readonly decisionVersion: number;
  }): Promise<void> {
    const projection = this.#decisionProjection;
    if (projection === undefined) return;
    const deliveryKey = [
      input.decision.tenantId,
      input.decision.planId,
      input.decision.submissionId,
      input.decisionVersion,
    ].join("\u0000");
    if (this.#projectedDecisionKeys.has(deliveryKey)) return;
    const pending = this.#decisionProjectionInFlight.get(deliveryKey);
    if (pending !== undefined) {
      await pending;
      return;
    }
    const idempotencyKey = decisionProjectionIdempotencyKey(
      input.decision.planId,
      input.decision.submissionId,
      input.decisionVersion,
    );
    const isCurrentDecision = async (): Promise<boolean> => {
      const current = await this.#repository.getDecision(
        input.decision.tenantId,
        input.decision.planId,
        input.decision.submissionId,
      );
      return (
        current !== null &&
        current.version === input.decisionVersion &&
        current.status === input.transition.to &&
        current.history.some(
          (transition) =>
            transition.idempotencyKey === input.transition.idempotencyKey &&
            transition.to === input.transition.to,
        )
      );
    };
    const handoff = (async () => {
      if (!(await isCurrentDecision())) return;
      await projection.projectDecision({
        tenantId: input.decision.tenantId,
        eventId: input.decision.eventId,
        planId: input.decision.planId,
        submissionId: input.decision.submissionId,
        decisionId: input.decision.id,
        decisionVersion: input.decisionVersion,
        status: input.transition.to,
        priorStatus: input.transition.from,
        reason: input.transition.reason,
        decidedByUserId: input.transition.decidedBy,
        decidedAt: input.transition.decidedAt,
        idempotencyKey,
        participantProjection: {
          status: input.transition.to,
          reason: input.transition.reason,
          decisionVersion: input.decisionVersion,
          decidedAt: input.transition.decidedAt,
        },
        communication: {
          templatePurpose: decisionTemplatePurpose(input.transition.to),
        },
        isCurrentDecision,
      });
      this.#projectedDecisionKeys.add(deliveryKey);
    })();
    this.#decisionProjectionInFlight.set(deliveryKey, handoff);
    try {
      await handoff;
    } finally {
      if (this.#decisionProjectionInFlight.get(deliveryKey) === handoff) {
        this.#decisionProjectionInFlight.delete(deliveryKey);
      }
    }
  }

  async #runSessionDecisionReconciliation(input: {
    readonly decision: EvaluationDecision;
    readonly transition: EvaluationDecisionTransition;
    readonly decisionVersion: number;
  }): Promise<void> {
    const status = input.transition.to;
    if (status === "accepted") return;
    const reconciliation = this.#acceptanceHandoff?.reconcileSessionDecision;
    if (reconciliation === undefined) return;
    const deliveryKey = [
      input.decision.tenantId,
      input.decision.planId,
      input.decision.submissionId,
      input.decisionVersion,
    ].join("\u0000");
    if (this.#reconciledSessionDecisionKeys.has(deliveryKey)) return;
    const pending = this.#sessionDecisionReconciliationInFlight.get(deliveryKey);
    if (pending !== undefined) {
      await pending;
      return;
    }
    const handoff = (async () => {
      const isCurrentDecision = async (): Promise<boolean> => {
        const current = await this.#repository.getDecision(
          input.decision.tenantId,
          input.decision.planId,
          input.decision.submissionId,
        );
        return (
          current !== null &&
          current.version === input.decisionVersion &&
          current.status === status &&
          current.history.some(
            (transition) =>
              transition.idempotencyKey === input.transition.idempotencyKey &&
              transition.to === status,
          )
        );
      };
      await reconciliation({
        tenantId: input.decision.tenantId,
        eventId: input.decision.eventId,
        planId: input.decision.planId,
        submissionId: input.decision.submissionId,
        decisionId: input.decision.id,
        status,
        decisionVersion: input.decisionVersion,
        decidedBy: input.transition.decidedBy,
        decidedAt: input.transition.decidedAt,
        reason: input.transition.reason,
        idempotencyKey: input.transition.idempotencyKey,
        isCurrentDecision,
        decisionFence: {
          tenantId: input.decision.tenantId,
          eventId: input.decision.eventId,
          planId: input.decision.planId,
          submissionId: input.decision.submissionId,
          version: input.decisionVersion,
          status,
        },
      });
      this.#reconciledSessionDecisionKeys.add(deliveryKey);
    })();
    this.#sessionDecisionReconciliationInFlight.set(deliveryKey, handoff);
    try {
      await handoff;
    } finally {
      if (this.#sessionDecisionReconciliationInFlight.get(deliveryKey) === handoff) {
        this.#sessionDecisionReconciliationInFlight.delete(deliveryKey);
      }
    }
  }

  async #runAcceptanceHandoff(input: {
    readonly decision: EvaluationDecision;
    readonly transition: EvaluationDecisionTransition;
    readonly decisionVersion: number;
  }): Promise<void> {
    const acceptanceHandoff = this.#acceptanceHandoff;
    if (acceptanceHandoff === undefined) return;
    const deliveryKey = [
      input.decision.tenantId,
      input.decision.planId,
      input.decision.submissionId,
      input.decisionVersion,
    ].join("\u0000");
    if (this.#acceptedHandoffKeys.has(deliveryKey)) return;
    const pending = this.#acceptanceHandoffInFlight.get(deliveryKey);
    if (pending !== undefined) {
      await pending;
      return;
    }
    const handoff = (async () => {
      const isCurrentDecision = async (): Promise<boolean> => {
        const current = await this.#repository.getDecision(
          input.decision.tenantId,
          input.decision.planId,
          input.decision.submissionId,
        );
        return (
          current !== null &&
          current.version === input.decisionVersion &&
          current.status === "accepted" &&
          current.history.some(
            (transition) =>
              transition.idempotencyKey === input.transition.idempotencyKey &&
              transition.to === "accepted",
          )
        );
      };
      await acceptanceHandoff.accept({
        tenantId: input.decision.tenantId,
        eventId: input.decision.eventId,
        planId: input.decision.planId,
        submissionId: input.decision.submissionId,
        decisionId: input.decision.id,
        decidedBy: input.transition.decidedBy,
        decidedAt: input.transition.decidedAt,
        reason: input.transition.reason,
        idempotencyKey: input.transition.idempotencyKey,
        decisionVersion: input.decisionVersion,
        isCurrentDecision,
        decisionFence: {
          tenantId: input.decision.tenantId,
          eventId: input.decision.eventId,
          planId: input.decision.planId,
          submissionId: input.decision.submissionId,
          version: input.decisionVersion,
          status: "accepted",
        },
      });
      this.#acceptedHandoffKeys.add(deliveryKey);
    })();
    this.#acceptanceHandoffInFlight.set(deliveryKey, handoff);
    try {
      await handoff;
    } finally {
      if (this.#acceptanceHandoffInFlight.get(deliveryKey) === handoff) {
        this.#acceptanceHandoffInFlight.delete(deliveryKey);
      }
    }
  }

  async #getAssignment(tenantId: string, assignmentId: string): Promise<EvaluationAssignment> {
    const assignment = await this.#repository.getAssignment(tenantId, assignmentId);
    if (assignment === null) {
      throw notFound("The evaluation assignment was not found.");
    }
    return assignment;
  }

  #assertExpectedReviewVersion(
    current: EvaluationReview | null,
    expectedVersion: number | undefined,
  ): void {
    if (
      (current === null && expectedVersion !== undefined) ||
      (current !== null && current.version !== expectedVersion)
    ) {
      throw conflict("Review changed since it was loaded.");
    }
  }
}
