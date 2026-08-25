import { createMemberApi, type OrganizationMember } from "../members/api";

const SUBMISSION_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "reopened"
  | "under_review"
  | "accepted"
  | "waitlisted"
  | "declined"
  | "withdrawn";
export const submissionStatusLabels: Record<SubmissionStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  reopened: "Reopened",
  under_review: "Under review",
  accepted: "Accepted",
  waitlisted: "Waitlisted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

export type SubmissionSortKey = "title" | "status" | "updatedAt";
export type SubmissionSortDirection = "asc" | "desc";

export function submissionListHref(eventId: string, organizationId: string): string {
  return `/admin/organizations/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}/submissions`;
}

export interface SubmissionParticipant {
  id: string;
  name: string;
  email: string;
  role: string;
  organization: string;
  answers?: Readonly<Record<string, unknown>>;
  biography?: string;
}

export interface SubmissionAnswer {
  question: string;
  answer: string;
}

export interface SubmissionTimelineEntry {
  label: string;
  at: string;
  detail: string;
}

export interface ReviewAssignment {
  reviewer: string;
  status: "complete" | "in_progress" | "not_started" | "abstained";
  score?: number;
  criterionScores?: readonly { criterion: string; value: number | string }[];
  comment?: string;
  conflict?: string;
}
export type SubmittedReviewReadState =
  | { readonly status: "ready"; readonly count: number }
  | { readonly status: "error"; readonly message: string };

export interface SubmissionRecord {
  eventId: string;
  id: string;
  title: string;
  status: SubmissionStatus;
  track: string;
  format: string;
  version: number;
  submittedAt: string;
  updatedAt: string;
  participants: SubmissionParticipant[];
  participantProgress: { completed: number; total: number };
  abstract: string;
  answers: SubmissionAnswer[];
  timeline: SubmissionTimelineEntry[];
  reviewSummary: {
    completed: number;
    total: number;
    averageScore: number | null;
    maxScore: number;
    recommendation: string;
  };
  reviewAssignments: ReviewAssignment[];
  submittedReviewRead?: SubmittedReviewReadState;

  organizerNotes: string;
  reopenAudit: { at: string; organizer: string; reason: string }[];
  evaluationPlanId?: string;
  reviewData?: ReviewDataState;
  decision?: EvaluationDecisionRecord;
}
export type ReviewDataState =
  | { readonly status: "pending"; readonly message?: string }
  | { readonly status: "ready"; readonly message?: string }
  | { readonly status: "no_plan"; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string };

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export type SubmissionLoadFailure =
  | { readonly kind: "unconfigured"; readonly message: string }
  | { readonly kind: "failure"; readonly message: string };

export function submissionLoadFailure(
  status: number | undefined,
  message: string | undefined,
): SubmissionLoadFailure {
  if (status === 404) {
    return {
      kind: "unconfigured",
      message: "Submission intake is not configured for this event.",
    };
  }
  return { kind: "failure", message: message ?? "Submissions could not be loaded." };
}

export function submissionLoadErrorMessage(
  status: number | undefined,
  message: string | undefined,
): string {
  return submissionLoadFailure(status, message).message;
}

async function apiRequest<T>(
  baseUrl: string,
  prefix: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${prefix}${path}`, {
    ...init,
    credentials: "include",
    headers,
    cache: "no-store",
  });
  const body = (await response.json()) as
    | { data?: T; error?: { message?: string } }
    | T
    | undefined;
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      typeof body.error.message === "string"
        ? body.error.message
        : "The submission request could not be completed.";
    throw new ApiRequestError(message, response.status);
  }
  if (typeof body === "object" && body !== null && "data" in body && body.data !== undefined) {
    return body.data as T;
  }
  return body as T;
}

export async function evaluationRequest<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return apiRequest(baseUrl, "/api/admin/evaluations", path, init);
}

async function canonicalSubmissionRequest<T>(
  baseUrl: string,
  organizationId: string,
  eventId: string,
  init: RequestInit = {},
): Promise<T> {
  return apiRequest(
    baseUrl,
    "/api/cfp",
    `/organizations/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}/submissions`,
    init,
  );
}

export async function loadCanonicalSubmissionList(
  baseUrl: string,
  organizationId: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<readonly CanonicalSubmissionEnvelope[]> {
  return canonicalSubmissionRequest<readonly CanonicalSubmissionEnvelope[]>(
    baseUrl,
    organizationId,
    eventId,
    signal === undefined ? {} : { signal },
  );
}

interface SubmissionFieldOption {
  readonly value: string;
  readonly label?: string;
}

export interface SubmissionFieldDefinition {
  readonly id?: string;
  readonly key: string;
  readonly label?: string;
  readonly options?: readonly (string | SubmissionFieldOption)[];
}

export type EvaluationDecisionStatus = "accepted" | "waitlisted" | "rejected";

export interface EvaluationDecisionTransition {
  readonly from: EvaluationDecisionStatus | null;
  readonly to: EvaluationDecisionStatus;
  readonly reason: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly idempotencyKey: string;
}

export interface EvaluationDecisionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly planId: string;
  readonly submissionId: string;
  readonly status: EvaluationDecisionStatus;
  readonly version: number;
  readonly history: readonly EvaluationDecisionTransition[];
  readonly updatedAt: string;
  readonly notificationDelivery?: {
    readonly state: "pending" | "processing" | "delivered" | "failed";
    readonly completedAt?: string;
    readonly lastErrorCode?: string;
  };
}

export function decisionNotificationSummary(
  delivery: NonNullable<EvaluationDecisionRecord["notificationDelivery"]>,
): string {
  return [
    `Decision notification ${delivery.state}`,
    delivery.completedAt ? formatDateTime(delivery.completedAt) : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
}
export interface EvaluationDecisionAttempt {
  readonly status: EvaluationDecisionStatus;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export function decisionAttemptMatches(
  attempt: EvaluationDecisionAttempt | null | undefined,
  status: EvaluationDecisionStatus,
  reason: string,
): attempt is EvaluationDecisionAttempt {
  return attempt?.status === status && attempt.reason === reason.trim();
}

export function createEvaluationDecisionAttempt(
  status: EvaluationDecisionStatus,
  reason: string,
  current?: EvaluationDecisionAttempt | null,
): EvaluationDecisionAttempt {
  const normalizedReason = reason.trim();
  if (decisionAttemptMatches(current, status, normalizedReason)) return current;
  return {
    status,
    reason: normalizedReason,
    idempotencyKey: `web-decision-${crypto.randomUUID()}`,
  };
}

export function findDecisionTransitionForAttempt(
  decision: EvaluationDecisionRecord | undefined,
  attempt: EvaluationDecisionAttempt,
): EvaluationDecisionTransition | undefined {
  return decision?.history.find(
    (transition) =>
      transition.idempotencyKey === attempt.idempotencyKey &&
      transition.to === attempt.status &&
      transition.reason === attempt.reason,
  );
}
export const DECISION_COMMITTED_WITHOUT_DELIVERY_MESSAGE =
  "Decision committed, but notification/session delivery was not confirmed.";

export function reconcileEvaluationDecisionFailure(
  decision: EvaluationDecisionRecord | undefined,
  attempt: EvaluationDecisionAttempt,
  originalError: string,
):
  | {
      readonly status: "committed";
      readonly decision: EvaluationDecisionRecord;
      readonly message: typeof DECISION_COMMITTED_WITHOUT_DELIVERY_MESSAGE;
    }
  | { readonly status: "retry"; readonly error: string } {
  if (decision !== undefined && findDecisionTransitionForAttempt(decision, attempt) !== undefined) {
    return {
      status: "committed",
      decision,
      message: DECISION_COMMITTED_WITHOUT_DELIVERY_MESSAGE,
    };
  }
  return { status: "retry", error: originalError };
}

export interface OrganizerEvaluationWorkspace {
  readonly plan: {
    readonly id: string;
    readonly rounds: readonly { readonly id: string; readonly sequence?: number | undefined }[];
  };
  readonly resultScopes: readonly {
    readonly planId: string;
    readonly planVersion: number;
    readonly lineageOrdinal: number;
    readonly planName: string;
    readonly roundId: string;
    readonly roundName: string;
    readonly sequence: number;
    readonly historical: boolean;
  }[];
  readonly assignments: readonly {
    readonly id: string;
    readonly planId: string;
    readonly reviewerId: string;
    readonly submissionId: string;
    readonly roundId: string;
    readonly status: "assigned" | "in_progress" | "submitted" | "abstained";
  }[];
  readonly aggregates: readonly {
    readonly planId: string;
    readonly roundId: string;
    readonly submissionId: string;
    readonly submittedReviewCount: number;
    readonly expectedReviewCount: number;
    readonly averageWeightedTotal: number | null;
    readonly possibleWeightedTotal: number;
  }[];
  readonly decisions: Readonly<Record<string, EvaluationDecisionRecord>>;
}

export interface OrganizerEvaluationIndex {
  readonly plan: OrganizerEvaluationWorkspace["plan"];
  readonly round: OrganizerEvaluationWorkspace["plan"]["rounds"][number] | undefined;
  readonly sourceScopeBySubmissionId: ReadonlyMap<
    string,
    OrganizerEvaluationWorkspace["resultScopes"][number]
  >;
  readonly assignmentsBySubmissionId: ReadonlyMap<
    string,
    OrganizerEvaluationWorkspace["assignments"]
  >;
  readonly aggregateBySubmissionId: ReadonlyMap<
    string,
    OrganizerEvaluationWorkspace["aggregates"][number]
  >;
  readonly decisions: OrganizerEvaluationWorkspace["decisions"];
}

export interface AcceptedHandoffMetadata {
  readonly title: string;
  readonly track: string;
  readonly version: number;
  readonly primarySpeaker: SubmissionParticipant | null;
  readonly coSpeakers: readonly SubmissionParticipant[];
}
export interface CanonicalSubmissionParticipant {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly role: "primary" | "co_speaker";
  readonly biography: string;
  readonly answers: Readonly<Record<string, unknown>>;
}

export interface CanonicalSubmission {
  readonly id: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly formId: string;
  readonly ownerAccountId: string;
  readonly formVersion: number;
  readonly version: number;
  readonly status: "draft" | "submitted" | "reopened" | "withdrawn";
  readonly completedSteps: readonly string[];
  readonly answers: Readonly<Record<string, unknown>>;
  readonly participants: readonly CanonicalSubmissionParticipant[];
  readonly secondaryContacts: readonly {
    readonly id: string;
    readonly name: string;
    readonly email: string;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt?: string | null;
  readonly reopenedAt?: string | null;
  readonly withdrawnAt?: string | null;
  readonly finalDecisionAt?: string | null;
}

export interface CanonicalSubmissionEnvelope {
  readonly submission: CanonicalSubmission;
  readonly submissionFields: readonly SubmissionFieldDefinition[];
  readonly participantFields: readonly SubmissionFieldDefinition[];
}

export function answerText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim().length === 0 ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : serialized;
}

function optionValue(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "value" in value &&
    typeof value.value === "string"
  ) {
    return value.value;
  }
  return answerText(value);
}

function fieldAnswer(value: unknown, definition: SubmissionFieldDefinition | undefined): string {
  if (Array.isArray(value)) {
    const values: string[] = [];
    const itemCount = value.length;
    for (let index = 0; index < itemCount; index += 1) {
      if (!(index in value)) continue;
      const candidate = fieldAnswer(value[index], definition);
      if (candidate !== "—") values.push(candidate);
    }
    return values.length === 0 ? "—" : values.join(", ");
  }
  const raw = answerText(value);
  if (raw === null) return "—";
  const comparable = optionValue(value) ?? raw;
  const option = definition?.options?.find((candidate) => optionValue(candidate) === comparable);
  if (typeof option === "string") return option;
  if (
    typeof option === "object" &&
    option !== null &&
    typeof option.label === "string" &&
    option.label.trim().length > 0
  ) {
    return option.label;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "label" in value &&
    typeof value.label === "string" &&
    value.label.trim().length > 0
  ) {
    return value.label;
  }
  return raw;
}

function participantRole(role: string | undefined): string {
  const normalized = role?.trim();
  if (normalized === "primary") return "Speaker";
  if (normalized === "co_speaker") return "Co-speaker";
  return normalized || "Speaker";
}
export function getAcceptedHandoffMetadata(
  submission: Pick<SubmissionRecord, "title" | "track" | "version" | "participants">,
): AcceptedHandoffMetadata {
  const primarySpeaker =
    submission.participants.find((participant) => participant.role === "Speaker") ??
    submission.participants[0] ??
    null;
  const coSpeakers = submission.participants.filter(
    (participant) => participant.id !== primarySpeaker?.id && participant.role === "Co-speaker",
  );
  return {
    title: submission.title,
    track: submission.track,
    version: submission.version,
    primarySpeaker,
    coSpeakers,
  };
}

function canonicalFieldValue(
  answers: Readonly<Record<string, unknown>>,
  definition: SubmissionFieldDefinition,
): unknown {
  if (Object.hasOwn(answers, definition.key)) return answers[definition.key];
  if (definition.id !== undefined && Object.hasOwn(answers, definition.id)) {
    return answers[definition.id];
  }
  return undefined;
}

function participantFieldValue(
  participant: CanonicalSubmissionParticipant,
  definition: SubmissionFieldDefinition,
): unknown {
  if (definition.key === "firstName") return participant.firstName;
  if (definition.key === "lastName") return participant.lastName;
  if (definition.key === "email") return participant.email;
  if (definition.key === "biography") return participant.biography;
  return canonicalFieldValue(participant.answers, definition);
}

function participantOrganization(
  participant: CanonicalSubmissionParticipant,
  definitions: readonly SubmissionFieldDefinition[],
): string {
  const definition = definitions.find((candidate) =>
    ["organization", "company", "participantCompany"].includes(candidate.key),
  );
  if (definition === undefined) return "";
  const value = fieldAnswer(participantFieldValue(participant, definition), definition);
  return value === "—" ? "" : value;
}

export function mapCanonicalSubmission(envelope: CanonicalSubmissionEnvelope): SubmissionRecord {
  const { submission, submissionFields, participantFields } = envelope;
  const definitions = new Map(submissionFields.map((definition) => [definition.key, definition]));
  const answer = (key: string): string => {
    const definition = definitions.get(key);
    return definition === undefined
      ? fieldAnswer(submission.answers[key], undefined)
      : fieldAnswer(canonicalFieldValue(submission.answers, definition), definition);
  };
  const title = answer("title");
  const normalizedTitle = title.trim();
  const abstractAnswer = answer("abstract");
  const abstractValue = abstractAnswer === "—" ? answer("description") : abstractAnswer;
  const submittedAt = submission.submittedAt ?? null;
  const reopenedAt = submission.reopenedAt ?? null;
  const timeline: SubmissionTimelineEntry[] = [];
  if (submittedAt !== null) {
    timeline.push({
      label: "Submitted",
      at: submittedAt,
      detail: "The submission was submitted through the CFP.",
    });
  }
  if (reopenedAt !== null) {
    timeline.push({
      label: "Reopened",
      at: reopenedAt,
      detail: "An organizer reopened this submission.",
    });
  }

  return {
    eventId: submission.eventId,
    id: submission.id,
    title:
      normalizedTitle === "—" || normalizedTitle === submission.id ? "No title" : normalizedTitle,
    status: submission.status,
    track: answer("track"),
    format: answer("format"),
    version: submission.version,
    submittedAt: submittedAt ?? submission.updatedAt,
    updatedAt: submission.updatedAt,
    participants: submission.participants.map((participant) => ({
      id: participant.id,
      name: `${participant.firstName} ${participant.lastName}`.trim() || participant.email,
      email: participant.email,
      role: participantRole(participant.role),
      organization: participantOrganization(participant, participantFields),
      biography: participant.biography,
      answers: Object.fromEntries(
        participantFields.map((definition) => [
          definition.label?.trim() || definition.key,
          fieldAnswer(participantFieldValue(participant, definition), definition),
        ]),
      ),
    })),
    participantProgress: {
      completed: submission.participants.filter(
        (participant) => participant.biography.trim().length > 0,
      ).length,
      total: submission.participants.length,
    },
    abstract: abstractValue,
    answers: submissionFields.map((definition) => ({
      question: definition.label?.trim() || definition.key,
      answer: fieldAnswer(canonicalFieldValue(submission.answers, definition), definition),
    })),
    timeline,
    reviewSummary: {
      completed: 0,
      total: 0,
      averageScore: null,
      maxScore: 0,
      recommendation: "Evaluation data loads from the plan.",
    },
    reviewAssignments: [],
    organizerNotes: "Submission details are ready. Review information loads with the event.",
    reopenAudit:
      reopenedAt === null
        ? []
        : [
            {
              at: reopenedAt,
              organizer: "Organizer",
              reason: "Recorded in the server audit log.",
            },
          ],
    reviewData: { status: "pending" },
  };
}

export function reviewDataStateFromError(reason: unknown): ReviewDataState {
  const status =
    typeof reason === "object" &&
    reason !== null &&
    "status" in reason &&
    typeof reason.status === "number"
      ? reason.status
      : null;
  if (status === 404) {
    return {
      status: "no_plan",
      message: "No evaluation plan is configured for this event.",
    };
  }
  const message = reason instanceof Error ? reason.message : null;
  return {
    status: "unavailable",
    message:
      message === null ? "Review data is unavailable." : `Review data is unavailable: ${message}`,
  };
}

export function reviewDataStateForIndex(index: OrganizerEvaluationIndex): ReviewDataState {
  return index.plan.rounds.length === 0 && index.sourceScopeBySubmissionId.size === 0
    ? {
        status: "no_plan",
        message: "No evaluation plan or review round is configured for this event.",
      }
    : { status: "ready" };
}

export function reviewDataIsReady(submission: Pick<SubmissionRecord, "reviewData">): boolean {
  return submission.reviewData === undefined || submission.reviewData.status === "ready";
}

export function reviewDataMessage(
  state: ReviewDataState | undefined,
  fallback = "Review progress is unavailable.",
): string | null {
  if (state === undefined || state.status === "ready") return null;
  if (state.status === "pending") return state.message ?? "Review data is loading.";
  return state.message || fallback;
}

interface SubmittedReview {
  readonly assignmentId: string;
  readonly planId: string;
  readonly roundId: string;
  readonly submissionId: string;
  readonly comment: string;
  readonly scores: Readonly<Record<string, { readonly value: number | string }>>;
}
interface SubmittedReviewResult {
  readonly reviews: readonly SubmittedReview[];
  readonly error: string | null;
}

function rubricCriterionLabel(criterionId: string): string {
  return criterionId
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export async function loadOrganizerEvaluationWorkspace(
  baseUrl: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<OrganizerEvaluationWorkspace> {
  return evaluationRequest<OrganizerEvaluationWorkspace>(
    baseUrl,
    `/organizer/workspace?eventId=${encodeURIComponent(eventId)}`,
    signal === undefined ? {} : { signal },
  );
}

export async function loadOrganizerDecisionPlanId(
  baseUrl: string,
  eventId: string,
): Promise<string | undefined> {
  const { plans } = await evaluationRequest<{
    readonly plans: readonly {
      readonly id: string;
      readonly status: string;
      readonly updatedAt: string;
    }[];
  }>(baseUrl, `/plans?eventId=${encodeURIComponent(eventId)}`);
  return [...plans].sort(
    (left, right) =>
      (right.status === "open" ? 1 : 0) - (left.status === "open" ? 1 : 0) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.id.localeCompare(left.id),
  )[0]?.id;
}

export async function loadOrganizerEvaluationDecision(
  baseUrl: string,
  planId: string,
  submissionId: string,
): Promise<EvaluationDecisionRecord | undefined> {
  const decision = await evaluationRequest<EvaluationDecisionRecord | null>(
    baseUrl,
    `/plans/${encodeURIComponent(planId)}/submissions/${encodeURIComponent(submissionId)}/decision`,
  );
  return decision ?? undefined;
}

function evaluationScopeKey(planId: string, roundId: string): string {
  return `${planId}\u0000${roundId}`;
}

function isLaterResultScope(
  candidate: OrganizerEvaluationWorkspace["resultScopes"][number],
  current: OrganizerEvaluationWorkspace["resultScopes"][number],
): boolean {
  return (
    candidate.lineageOrdinal > current.lineageOrdinal ||
    (candidate.lineageOrdinal === current.lineageOrdinal &&
      (candidate.sequence > current.sequence ||
        (candidate.sequence === current.sequence &&
          (candidate.planId > current.planId ||
            (candidate.planId === current.planId && candidate.roundId > current.roundId)))))
  );
}

export function indexOrganizerEvaluationWorkspace(
  workspace: OrganizerEvaluationWorkspace,
): OrganizerEvaluationIndex {
  const rounds = [...workspace.plan.rounds].sort(
    (left, right) =>
      (left.sequence ?? 0) - (right.sequence ?? 0) || left.id.localeCompare(right.id),
  );
  const round = rounds[0];
  const scopeByKey = new Map(
    workspace.resultScopes.map(
      (scope) => [evaluationScopeKey(scope.planId, scope.roundId), scope] as const,
    ),
  );
  const sourceScopeBySubmissionId = new Map<
    string,
    OrganizerEvaluationWorkspace["resultScopes"][number]
  >();
  for (const assignment of workspace.assignments) {
    if (assignment.status === "abstained") continue;
    const candidate = scopeByKey.get(evaluationScopeKey(assignment.planId, assignment.roundId));
    if (candidate === undefined) continue;
    const current = sourceScopeBySubmissionId.get(assignment.submissionId);
    if (current === undefined || isLaterResultScope(candidate, current)) {
      sourceScopeBySubmissionId.set(assignment.submissionId, candidate);
    }
  }
  const activeFallbackScope =
    workspace.resultScopes.find(
      (scope) => scope.planId === workspace.plan.id && scope.roundId === round?.id,
    ) ?? workspace.resultScopes.find((scope) => scope.planId === workspace.plan.id);
  const assignmentsBySubmissionId = new Map<
    string,
    OrganizerEvaluationWorkspace["assignments"][number][]
  >();
  for (const assignment of workspace.assignments) {
    const selectedScope =
      sourceScopeBySubmissionId.get(assignment.submissionId) ?? activeFallbackScope;
    if (
      selectedScope === undefined ||
      evaluationScopeKey(selectedScope.planId, selectedScope.roundId) !==
        evaluationScopeKey(assignment.planId, assignment.roundId)
    ) {
      continue;
    }
    const current = assignmentsBySubmissionId.get(assignment.submissionId) ?? [];
    current.push(assignment);
    assignmentsBySubmissionId.set(assignment.submissionId, current);
  }
  const aggregateBySubmissionId = new Map<
    string,
    OrganizerEvaluationWorkspace["aggregates"][number]
  >();
  for (const aggregate of workspace.aggregates) {
    const selectedScope =
      sourceScopeBySubmissionId.get(aggregate.submissionId) ?? activeFallbackScope;
    if (
      selectedScope !== undefined &&
      evaluationScopeKey(selectedScope.planId, selectedScope.roundId) ===
        evaluationScopeKey(aggregate.planId, aggregate.roundId)
    ) {
      aggregateBySubmissionId.set(aggregate.submissionId, aggregate);
    }
  }
  return {
    plan: workspace.plan,
    round,
    sourceScopeBySubmissionId,
    assignmentsBySubmissionId,
    aggregateBySubmissionId,
    decisions: workspace.decisions,
  };
}

export function mergeCanonicalSubmissionEvaluation(
  envelope: CanonicalSubmissionEnvelope,
  index: OrganizerEvaluationIndex,
  submittedReviewResult: SubmittedReviewResult = { reviews: [], error: null },
  reviewerMembers: readonly OrganizationMember[] = [],
): SubmissionRecord {
  const submission = mapCanonicalSubmission(envelope);
  const plan = index.plan;
  const assignments = index.assignmentsBySubmissionId.get(submission.id) ?? [];
  const decision = index.decisions[submission.id] ?? null;
  const aggregate = index.aggregateBySubmissionId.get(submission.id) ?? null;
  const submittedReviewByAssignment = new Map<string, SubmittedReview>();
  const reviewCount = submittedReviewResult.reviews.length;
  for (let index = 0; index < reviewCount; index += 1) {
    if (!(index in submittedReviewResult.reviews)) continue;
    const review = submittedReviewResult.reviews[index];
    if (review === undefined) continue;
    if (review.submissionId === submission.id) {
      submittedReviewByAssignment.set(review.assignmentId, review);
    }
  }
  const reviewerDisplayLabel = (reviewerId: string): string => {
    const member = reviewerMembers.find((candidate) => candidate.userId === reviewerId);
    return member?.name?.trim() || member?.email || "Assigned reviewer";
  };

  const decisionTimeline =
    decision === null
      ? []
      : decision.history.map((transition) => ({
          label:
            transition.to === "accepted"
              ? "Accepted"
              : transition.to === "rejected"
                ? "Rejected"
                : "Waitlisted",
          at: transition.decidedAt,
          detail: `${transition.reason} (recorded by an organizer).`,
        }));
  return {
    ...submission,
    ...(decision === null ? {} : { decision }),
    evaluationPlanId: plan.id,
    timeline: [...submission.timeline, ...decisionTimeline],
    status:
      decision?.status === "accepted"
        ? "accepted"
        : decision?.status === "waitlisted"
          ? "waitlisted"
          : decision?.status === "rejected"
            ? "declined"
            : submission.status,
    reviewSummary: {
      completed: aggregate?.submittedReviewCount ?? 0,
      total: aggregate?.expectedReviewCount ?? assignments.length,
      averageScore: aggregate?.averageWeightedTotal ?? null,
      maxScore: aggregate?.possibleWeightedTotal ?? 0,
      recommendation: decision?.status
        ? `${decision.status[0]?.toLocaleUpperCase() ?? ""}${decision.status.slice(1)}`
        : "Awaiting human decision",
    },
    reviewData: reviewDataStateForIndex(index),
    submittedReviewRead:
      submittedReviewResult.error === null
        ? { status: "ready", count: submittedReviewByAssignment.size }
        : { status: "error", message: submittedReviewResult.error },

    reviewAssignments: assignments.map((assignment) => {
      const submittedReview = submittedReviewByAssignment.get(assignment.id);
      return {
        reviewer: reviewerDisplayLabel(assignment.reviewerId),
        status:
          assignment.status === "submitted"
            ? "complete"
            : assignment.status === "in_progress"
              ? "in_progress"
              : assignment.status === "abstained"
                ? "abstained"
                : "not_started",
        ...(submittedReview === undefined
          ? {}
          : {
              criterionScores: Object.entries(submittedReview.scores).map(
                ([criterionId, score]) => ({
                  criterion: rubricCriterionLabel(criterionId),
                  value: score.value,
                }),
              ),
              comment: submittedReview.comment,
            }),
        ...(assignment.status === "abstained"
          ? { conflict: "Reviewer declared a conflict and abstained." }
          : {}),
      };
    }),

    organizerNotes: decision?.history.at(-1)?.reason ?? submission.organizerNotes,
  };
}

export async function enrichCanonicalSubmission(
  baseUrl: string,
  envelope: CanonicalSubmissionEnvelope,
  organizationId?: string,
): Promise<SubmissionRecord> {
  const canonical = mapCanonicalSubmission(envelope);
  try {
    const workspace = await loadOrganizerEvaluationWorkspace(baseUrl, envelope.submission.eventId);
    const index = indexOrganizerEvaluationWorkspace(workspace);
    const sourceScope =
      index.sourceScopeBySubmissionId.get(envelope.submission.id) ??
      workspace.resultScopes.find(
        (scope) => scope.planId === workspace.plan.id && scope.roundId === index.round?.id,
      );
    const [submittedReviewResult, reviewerMembers] = await Promise.all([
      sourceScope === undefined
        ? Promise.resolve({ reviews: [], error: null })
        : evaluationRequest<{ reviews: readonly SubmittedReview[] }>(
            baseUrl,
            `/plans/${encodeURIComponent(sourceScope.planId)}/rounds/${encodeURIComponent(sourceScope.roundId)}/submissions/${encodeURIComponent(envelope.submission.id)}/reviews`,
          )
            .then(({ reviews }) => ({
              reviews: reviews.filter(
                (review) =>
                  review.planId === sourceScope.planId && review.roundId === sourceScope.roundId,
              ),
              error: null,
            }))
            .catch((reason: unknown) => ({
              reviews: [],
              error:
                reason instanceof Error ? reason.message : "Submitted reviews could not be loaded.",
            })),
      organizationId === undefined
        ? Promise.resolve<readonly OrganizationMember[]>([])
        : createMemberApi(baseUrl, organizationId)
            .listMembers()
            .catch(() => []),
    ]);
    return mergeCanonicalSubmissionEvaluation(
      envelope,
      index,
      submittedReviewResult,
      reviewerMembers,
    );
  } catch (reason: unknown) {
    const evaluationPlanId = await loadOrganizerDecisionPlanId(
      baseUrl,
      envelope.submission.eventId,
    ).catch(() => undefined);
    const decision =
      evaluationPlanId === undefined
        ? undefined
        : await loadOrganizerEvaluationDecision(
            baseUrl,
            evaluationPlanId,
            envelope.submission.id,
          ).catch(() => undefined);
    return {
      ...canonical,
      ...(evaluationPlanId === undefined ? {} : { evaluationPlanId }),
      ...(decision === undefined ? {} : { decision }),
      reviewData: reviewDataStateFromError(reason),
    };
  }
}

export function initialOrganizerEventName(): string {
  return "Selected event";
}

export async function loadOrganizerEventName(
  baseUrl: string,
  organizationId: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<string> {
  const event = await loadOrganizerEventIdentity(baseUrl, organizationId, eventId, signal);
  return event.name;
}

export async function loadOrganizerEventIdentity(
  baseUrl: string,
  organizationId: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<{ readonly name: string; readonly slug: string | null }> {
  const response = await fetch(
    `${baseUrl.replace(/\/+$/u, "")}/api/cfp/organizations/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}/config`,
    {
      credentials: "include",
      cache: "no-store",
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (!response.ok) throw new Error(`The event request failed (HTTP ${response.status}).`);
  const payload = (await response.json()) as {
    readonly data?: { readonly name?: unknown; readonly slug?: unknown };
  };
  const name = payload.data?.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError("The event response does not contain a name.");
  }
  const slug = payload.data?.slug;
  return {
    name: name.trim(),
    slug: typeof slug === "string" && slug.trim().length > 0 ? slug.trim() : null,
  };
}

export function formatDateTime(value: string): string {
  return SUBMISSION_DATE_TIME_FORMATTER.format(new Date(value));
}

export type SubmissionListState =
  | "loading"
  | "failure"
  | "unconfigured"
  | "empty"
  | "filtered_empty"
  | "ready";

export function submissionListState(input: {
  loading: boolean;
  loadFailure: SubmissionLoadFailure | null;
  submissionCount: number;
  visibleCount: number;
}): SubmissionListState {
  if (input.loading) return "loading";
  if (input.loadFailure !== null) return input.loadFailure.kind;
  if (input.submissionCount === 0) return "empty";
  if (input.visibleCount === 0) return "filtered_empty";
  return "ready";
}
