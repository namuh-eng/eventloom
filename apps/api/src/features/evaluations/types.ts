export type EvaluationPlanStatus = "draft" | "open" | "closed";
export type AssignmentStatus =
  | "assigned"
  | "in_progress"
  | "submitted"
  | "abstained"
  | "superseded";
export type EvaluationDecisionStatus = "accepted" | "waitlisted" | "rejected";
export type EvaluationRole = "organizer" | "reviewer";
export type EvaluationSuggestionStatus = "pending" | "stale" | "overridden";
export type EvaluationCriterionInputType = "numeric" | "dropdown" | "free_text";
export type EvaluationRoundAnonymization = "none" | "single" | "double";

export interface EvaluationGrant {
  tenantId?: string | undefined;
  eventId: string;
  role: EvaluationRole;
}

export interface EvaluationActor {
  tenantId: string;
  userId: string;
  kind: "human" | "automation";
  grants: readonly EvaluationGrant[];
}

export interface EvaluationCriterionOption {
  readonly id?: string | undefined;
  readonly label: string;
  readonly value: string;
}

export interface RubricCriterion {
  id: string;
  label: string;
  description: string;
  minimum: number;
  maximum: number;
  weight: number;
  required: boolean;
  /** How a reviewer supplies this criterion's response. Defaults to numeric. */
  inputType?: EvaluationCriterionInputType | undefined;
  /** Dropdown choices in display order. */
  options?: readonly EvaluationCriterionOption[] | undefined;
}

export interface Rubric {
  id: string;
  name: string;
  criteria: readonly RubricCriterion[];
}

export interface EvaluationReviewerProjection {
  /** Submission answer field ids visible to reviewers. Empty means deny all. */
  readonly fieldIds?: readonly string[] | undefined;
  /** Uploaded file ids visible to reviewers. Empty means deny all. */
  readonly fileIds?: readonly string[] | undefined;
  readonly visibleFieldIds?: readonly string[] | undefined;
  readonly visibleFileIds?: readonly string[] | undefined;
}

export interface EvaluationReviewerPool {
  /** Reviewer ids eligible for this round only. */
  readonly reviewerIds: readonly string[];
  readonly name?: string | undefined;
}

export interface ReviewRound {
  id: string;
  predecessorRoundId?: string | null | undefined;
  name: string;
  sequence: number;
  /** When true, organizers may run AI triage for this round's submissions. Default off. */
  aiTriageEnabled?: boolean | undefined;
  /** Immutable round configuration revision used by assignments and aggregates. */
  revision?: number | undefined;
  /** Immutable rubric revision used by assignments and aggregates. */
  rubricRevision?: number | undefined;
  /** Optional per-round opening instant; omitted retains plan-created behavior. */
  opensAt?: string | null | undefined;
  closesAt: string | null;
  /** Round-level anonymization is deny-by-default when enabled. */
  blindReview?: boolean | undefined;
  anonymization?: EvaluationRoundAnonymization | undefined;
  reviewerPool?: EvaluationReviewerPool | undefined;
  trackFilter?: string | null | undefined;
  rubric: Rubric;
}

export interface EvaluationAssignmentRule {
  reviewsPerSubmission: number;
  maxAssignmentsPerReviewer: number;
  /** Optional track used by bulk/automatic assignment clients. */
  trackFilter?: string | null | undefined;
  /** Assignment orchestration mode; manual remains the default. */
  autoDistribute?: boolean | undefined;
}

export interface EvaluationPlan {
  id: string;
  predecessorPlanId?: string | null | undefined;
  tenantId: string;
  eventId: string;
  name: string;
  status: EvaluationPlanStatus;
  blindReview: boolean;
  closesAt: string | null;
  assignmentRule: EvaluationAssignmentRule;
  rounds: readonly ReviewRound[];
  /** Explicit reviewer projection. Omitted retains the legacy safe projection. */
  reviewerProjection?: EvaluationReviewerProjection | undefined;
  evaluatorProjection?: EvaluationReviewerProjection | undefined;
  projection?: EvaluationReviewerProjection | undefined;
  /** Immutable grading-policy revision frozen when the plan opens. */
  gradingRevision?: number | undefined;
  /** Set when grading configuration becomes immutable. */
  gradingLockedAt?: string | null | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationAssignmentScope {
  readonly tenantId: string;
  readonly eventId: string;
  readonly planId: string;
  readonly roundId: string;
  /** Optional for a round-wide distribution; required when replacing one assignment. */
  readonly submissionId?: string | undefined;
  /** Plan revision used to build a distribution preview. */
  readonly planVersion?: number | undefined;
}

export interface EvaluationAssignmentLineage {
  readonly predecessorAssignmentId: string | null;
  readonly successorAssignmentId: string | null;
  readonly reason: string;
  readonly supersededAt?: string | undefined;
}

export interface EvaluationDistributionScope extends EvaluationAssignmentScope {
  readonly planVersion: number;
}

export interface EvaluationDistributionDesiredAssignment {
  readonly submissionId: string;
  readonly reviewerId: string;
  readonly existingAssignmentId?: string | undefined;
}

export interface EvaluationDistributionDeficit {
  readonly submissionId: string;
  readonly missingReviewCount: number;
  readonly reason: string;
}

export type EvaluationDistributionExclusionReason =
  | "outside_track"
  | "outside_pool"
  | "reviewer_cap"
  | "declared_conflict"
  | "already_assigned";

export interface EvaluationDistributionExclusion {
  readonly submissionId: string;
  readonly reviewerId: string;
  readonly reason: EvaluationDistributionExclusionReason;
}

export interface EvaluationDistributionExpectedVersion {
  readonly assignmentId: string;
  readonly version: number;
}

export interface EvaluationDistributionPreview {
  readonly scope: EvaluationDistributionScope;
  readonly desiredAssignments: readonly EvaluationDistributionDesiredAssignment[];
  readonly deficits: readonly EvaluationDistributionDeficit[];
  readonly exclusions: readonly EvaluationDistributionExclusion[];
  readonly expectedActiveVersions: readonly EvaluationDistributionExpectedVersion[];
  readonly submissionRevisions: readonly {
    readonly submissionId: string;
    readonly revision: number;
  }[];
  readonly fingerprint: string;
}

export interface EvaluationAssignmentReplacementInput {
  readonly oldAssignmentId: string;
  readonly replacementReviewerId: string;
  readonly successorAssignment: EvaluationAssignment;
  readonly expectedAssignmentVersion: number;
  readonly reason: string;
  readonly authorizedAt: string;
}

export interface EvaluationReviewHistory {
  readonly assignment: EvaluationAssignment;
  readonly review: EvaluationReview;
}

export interface EvaluationAssignmentReplacementResult {
  readonly scope: EvaluationAssignmentScope;
  readonly replacedAssignment: EvaluationAssignment;
  readonly successorAssignment: EvaluationAssignment;
  readonly activeAssignments: readonly EvaluationAssignment[];
  readonly history: readonly EvaluationReviewHistory[];
}

export interface EvaluationAssignmentDistributionInput {
  readonly assignments: readonly EvaluationAssignment[];
  readonly expectedActiveVersions: readonly EvaluationDistributionExpectedVersion[];
  readonly reason: string;
  readonly authorizedAt: string;
  readonly allowClosedCleanup?: boolean | undefined;
}

export interface EvaluationAssignmentDistributionResult {
  readonly scope: EvaluationAssignmentScope;
  readonly activeAssignments: readonly EvaluationAssignment[];
  readonly supersededAssignments: readonly EvaluationAssignment[];
  readonly history: readonly EvaluationReviewHistory[];
}
export interface EvaluationAssignment {
  id: string;
  tenantId: string;
  eventId: string;
  planId: string;
  roundId: string;
  submissionId: string;
  reviewerId: string;
  status: AssignmentStatus;
  /** Assignment lineage is retained when a reviewer is replaced. */
  predecessorAssignmentId?: string | null | undefined;
  successorAssignmentId?: string | null | undefined;
  supersededReason?: string | null | undefined;
  lineage?: EvaluationAssignmentLineage | undefined;
  /** Snapshot used to keep assignment/review history reproducible. */
  planVersion?: number;
  rubricRevision?: number;
  roundRevision?: number | undefined;
  submissionRevision?: number | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RubricScore {
  criterionId: string;
  value: number | string;
  origin: "human";
  evidence: readonly string[];
  rubricRevision?: number;
  submissionRevision?: number;
  rubricVersion?: number | undefined;
  submissionVersion?: number | undefined;
  updatedAt: string;
}

export interface EvaluationReview {
  id: string;
  tenantId: string;
  eventId: string;
  planId: string;
  roundId: string;
  assignmentId: string;
  submissionId: string;
  reviewerId: string;
  scores: Readonly<Record<string, RubricScore>>;
  comment: string;
  submittedAt: string | null;
  version: number;
  /** Immutable source revisions used to author this review. */
  planRevision?: number;
  rubricRevision?: number;
  roundRevision?: number | undefined;
  submissionRevision?: number;
  planVersion?: number | undefined;
  rubricVersion?: number | undefined;
  submissionVersion?: number | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationConflictDeclaration {
  id: string;
  tenantId: string;
  eventId: string;
  planId: string;
  assignmentId: string;
  submissionId: string;
  reviewerId: string;
  reason: string;
  declaredAt: string;
}

export interface EvaluationDecisionTransition {
  from: EvaluationDecisionStatus | null;
  to: EvaluationDecisionStatus;
  reason: string;
  decidedBy: string;
  decidedAt: string;
  idempotencyKey: string;
}

export interface EvaluationDecision {
  id: string;
  tenantId: string;
  eventId: string;
  planId: string;
  submissionId: string;
  status: EvaluationDecisionStatus;
  version: number;
  history: readonly EvaluationDecisionTransition[];
  updatedAt: string;
  notificationDelivery?: {
    readonly state: "pending" | "processing" | "delivered" | "failed";
    readonly completedAt?: string;
    readonly lastErrorCode?: string;
  };
}
export type EvaluationDecisionCommunicationTemplatePurpose =
  | "decision_accepted"
  | "decision_waitlisted"
  | "decision_rejected";

export interface EvaluationParticipantOutcomeProjection {
  readonly status: EvaluationDecisionStatus;
  readonly reason: string;
  readonly decisionVersion: number;
  readonly decidedAt: string;
}

export interface EvaluationDecisionCommunicationProjection {
  readonly templatePurpose: EvaluationDecisionCommunicationTemplatePurpose;
}

export interface EvaluationDecisionProjectionData {
  readonly participantProjection: EvaluationParticipantOutcomeProjection;
  readonly communication: EvaluationDecisionCommunicationProjection;
}

export interface SubmissionParticipantForReview {
  id: string;
  displayName: string;
  email: string;
  biography: string;
  /** Role supplied by the submitter, such as author, co-author, presenter, or panelist. */
  role?: string | undefined;
}

export interface SubmissionFileForReview {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly url?: string;
}

export interface SubmissionReviewMaterial {
  id: string;
  tenantId: string;
  eventId: string;
  /** Authoritative CFP lifecycle status when the source exposes it. */
  status?: string | undefined;
  title: string;
  abstract: string;
  answers: Readonly<Record<string, unknown>>;
  identityFieldIds: readonly string[];
  participants: readonly SubmissionParticipantForReview[];
  readonly trackIds?: readonly string[] | undefined;
  /** Source revision for exact suggestion/review provenance. */
  version?: number | undefined;
  revision?: number | undefined;
  files?: readonly SubmissionFileForReview[] | undefined;
}

export interface VisibleSubmissionReviewMaterial {
  id: string;
  title: string;
  abstract: string;
  answers: Readonly<Record<string, unknown>>;
  participants: readonly SubmissionParticipantForReview[];
  files?: readonly SubmissionFileForReview[] | undefined;
  identityRedacted: boolean;
}

export interface ReviewContext {
  assignment: EvaluationAssignment;
  round: ReviewRound;
  submission: VisibleSubmissionReviewMaterial;
  review: EvaluationReview | null;
  rubricRevision?: number;
  submissionRevision?: number;
}

export interface RubricTotal {
  weightedTotal: number;
  possibleWeightedTotal: number;
  countedCriteria: number;
}

export interface CriterionAggregate {
  criterionId: string;
  average: number | null;
  count: number;
  weight: number;
}

export interface EvaluationAggregate {
  planId: string;
  roundId: string;
  /** Aggregate key for the exact round configuration snapshot. */
  roundRevision: number;
  /** Aggregate key for the exact rubric snapshot. */
  rubricRevision: number;
  submissionId: string;
  submittedReviewCount: number;
  expectedReviewCount: number;
  averageWeightedTotal: number | null;
  possibleWeightedTotal: number;
  criteria: readonly CriterionAggregate[];
}

export interface EvaluationProgress {
  planId: string;
  total: number;
  assigned: number;
  inProgress: number;
  submitted: number;
  abstained: number;
  completionPercent: number;
  readonly reviewers?: readonly EvaluationReviewerProgress[] | undefined;
}
export interface EvaluationReviewerProgress {
  readonly reviewerId: string;
  readonly planId?: string | undefined;
  readonly roundId?: string | undefined;
  readonly assigned: number;
  readonly inProgress: number;
  readonly submitted: number;
  readonly abstained: number;
  readonly completionPercent: number;
  readonly outstanding: number;
}

export interface EvaluationSuggestionProvenance {
  readonly provider: string;
  readonly model: string;
  readonly generatedAt: string;
  readonly sourceReferences: readonly string[];
  readonly promptVersion?: string;
  readonly traceId?: string;
}

export interface EvaluationSuggestionCandidate {
  readonly id: string;
  readonly criterionId: string;
  readonly value: number;
  readonly evidence: readonly string[];
  readonly provenance: EvaluationSuggestionProvenance;
}
export interface EvaluationSuggestionProviderCandidate {
  readonly id?: string;
  readonly criterionId?: string;
  readonly value: number;
  readonly evidence: readonly string[];
  readonly provenance?: Partial<EvaluationSuggestionProvenance>;
}

export interface EvaluationSuggestionAuditEntry {
  readonly action: "generate" | "stale" | "override";
  readonly actorId: string | null;
  readonly at: string;
  readonly reason?: string;
  readonly valueByCriterion?: Readonly<Record<string, number | string>>;
}

export interface EvaluationSuggestionOverride {
  readonly valueByCriterion: Readonly<Record<string, number | string>>;
  readonly overriddenBy: string;
  readonly overriddenAt: string;
  readonly reason?: string | undefined;
}

export interface EvaluationSuggestion {
  readonly id: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly planId: string;
  readonly roundId: string;
  /** Shared organizer triage is never assigned to an individual reviewer. */
  readonly assignmentId: null;
  readonly submissionId: string;
  /** Generating actor (organizer for shared round suggestions). */
  readonly reviewerId: string;
  /** Exact plan/rubric revision used for generation. */
  readonly rubricRevision: number;
  /** Exact submission revision used for generation. */
  readonly submissionRevision: number;
  readonly planRevision?: number | undefined;
  readonly rubricId?: string | undefined;
  readonly submissionVersion?: number | undefined;
  readonly candidates: Readonly<Record<string, readonly EvaluationSuggestionCandidate[]>>;
  readonly criterionCandidates: readonly EvaluationSuggestionCandidate[];
  readonly provenance: EvaluationSuggestionProvenance;
  readonly status: EvaluationSuggestionStatus;
  /** Organizer override applied on top of AI values; visible in organizer results. */
  readonly override?: EvaluationSuggestionOverride | null | undefined;
  readonly version: number;
  readonly history: readonly EvaluationSuggestionAuditEntry[];
  readonly audit: readonly EvaluationSuggestionAuditEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvaluationSuggestionProviderInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly planId: string;
  readonly roundId: string;
  readonly submissionId: string;
  readonly rubricRevision: number;
  readonly submissionRevision: number;
  readonly round: ReviewRound;
  readonly submission: VisibleSubmissionReviewMaterial;
  readonly planRevision?: number | undefined;
  readonly rubricId?: string | undefined;
  readonly submissionVersion?: number | undefined;
}

export interface EvaluationSuggestionProviderResult {
  readonly candidates:
    | readonly EvaluationSuggestionProviderCandidate[]
    | Readonly<Record<string, readonly EvaluationSuggestionProviderCandidate[]>>;
  readonly provenance?: Partial<EvaluationSuggestionProvenance>;
}

export type EvaluationSuggestionProducer = (
  input: EvaluationSuggestionProviderInput,
) => Promise<EvaluationSuggestionProviderResult>;

export interface EvaluationAiSuggestionProvider {
  readonly generate?: EvaluationSuggestionProducer;
  readonly suggest?: EvaluationSuggestionProducer;
  readonly produce?: EvaluationSuggestionProducer;
  readonly generateSuggestions?: EvaluationSuggestionProducer;
}

/** Compatibility aliases for integrations that use the shorter AI names. */
export type EvaluationAiSuggestion = EvaluationSuggestion;
export type EvaluationSuggestionProvider = EvaluationAiSuggestionProvider;
