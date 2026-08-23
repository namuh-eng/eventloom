import { localDateInTimeZone } from "@eventloom/contracts";
import {
  type AuditEntry,
  type CfpForm,
  cfpFormSchema,
  type EventCfp,
  eventCfpSchema,
  type FormField,
  type FormRuleAction,
  fileRequestAnswerSchema,
  type Submission,
  type SubmissionStep,
  type SubmissionVersion,
  submissionSchema,
  submissionSteps,
} from "./model";
import {
  evaluateFormRules,
  validateCfpForm,
  validateSubmissionAnswerCompatibility,
  validateSubmissionAnswers,
} from "./rules";
import { sanitizeForm, sanitizePlainText, sanitizeRichText, sanitizeSubmission } from "./sanitize";

export type CfpErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "FORM_LIMIT_REACHED"
  | "SUBMISSION_LIMIT_REACHED"
  | "CFP_NOT_OPEN"
  | "CFP_CLOSED"
  | "FORM_NOT_PUBLISHED"
  | "INVALID_TRANSITION"
  | "IDEMPOTENCY_KEY_REQUIRED";

export class CfpError extends Error {
  readonly code: CfpErrorCode;
  readonly details?: unknown;

  constructor(code: CfpErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CfpError";
    this.code = code;
    this.details = details;
  }
}

export interface CfpRepository {
  getEvent(tenantId: string, eventId: string): Promise<EventCfp | null>;
  getEventBySlug(tenantId: string, eventSlug: string): Promise<EventCfp | null>;
  saveEvent(event: EventCfp, expectedVersion: number | null): Promise<void>;
  getForm(tenantId: string, formId: string): Promise<CfpForm | null>;
  listFormsByIds?(ids: readonly string[]): Promise<readonly CfpForm[]>;
  listForms(tenantId: string, eventId: string): Promise<CfpForm[]>;
  saveForm(form: CfpForm, expectedVersion: number | null): Promise<void>;
  /**
   * Atomically persists organizer configuration. Production repositories must
   * implement this; the service fallback is only for non-D1 test adapters.
   */
  saveConfiguration?(
    event: EventCfp,
    form: CfpForm,
    expectedEventVersion: number | null,
    expectedFormVersion: number | null,
  ): Promise<void>;
  /**
   * Reusable fields are immutable tenant-owned definitions. The resolver must
   * never return a definition from another tenant or a different version.
   */
  getReusableField?(
    tenantId: string,
    fieldId: string,
    version: number,
  ): Promise<CfpReusableField | null>;
  getSubmission(tenantId: string, submissionId: string): Promise<Submission | null>;
  countOwnedSubmissions(input: {
    tenantId: string;
    eventId: string;
    formId: string;
    ownerAccountId: string;
  }): Promise<number>;
  saveSubmissionVersion(
    version: SubmissionVersion,
    expectedVersion: number | null,
    audit?: AuditEntry,
  ): Promise<void>;
  getOrganizerSubmissionsReadModel?(
    tenantId: string,
    eventId: string,
  ): Promise<CfpOrganizerSubmissionsReadModel>;
  listSubmissionsForEvent?(tenantId: string, eventId: string): Promise<Submission[]>;
}

export interface CfpReusableField {
  tenantId: string;
  id: string;
  version: number;
  field?: FormField;
}

export interface CfpFileAsset {
  assetId: string;
  tenantId: string;
  eventId: string;
  submissionId: string;
  participantId?: string;
  owner: "submission" | "participant";
  state: "pending_upload" | "ready" | "rejected";
  contentType: string;
  sizeBytes: number;
}

export interface CfpFileAssetAuthorizer {
  getAsset(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    assetId: string;
    owner: "submission" | "participant";
    participantId?: string;
  }): Promise<CfpFileAsset | null>;
}
export interface CfpFileUploadAuthorization {
  authorizationId?: string;
  asset: CfpFileAsset;
  grant: {
    method: "PUT";
    url: string;
    headers: Readonly<Record<string, string>>;
    expiresAt: string;
  };
}

export interface CfpFileAssetGateway extends CfpFileAssetAuthorizer {
  issueUpload(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    owner: "submission" | "participant";
    participantId?: string;
    fieldKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    idempotencyKey: string;
  }): Promise<CfpFileUploadAuthorization>;
  finalizeUpload(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    fieldKey: string;
    assetId: string;
    owner: "submission" | "participant";
    participantId?: string;
    state: "ready" | "rejected";
    rejectionReason?: string;
    idempotencyKey: string;
  }): Promise<CfpFileAsset>;
}

export interface CfpIdempotencyCoordinator {
  run<T>(scope: string, key: string, operation: () => Promise<T>, fingerprint?: string): Promise<T>;
}

/**
 * Enqueues are durable and deduplicated by idempotencyKey. Implementations must make retries safe.
 */
export interface CfpEffects {
  enqueueSubmissionConfirmation(input: {
    submission: Submission;
    form: CfpForm;
    event: EventCfp;
    submissionTitle: string;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface CfpClock {
  now(): Date;
}

export interface CfpIdGenerator {
  next(prefix: "submission" | "participant" | "contact"): string;
}

export interface ReviewIssue {
  path: string;
  code: string;
  message: string;
}

export interface SubmissionReview {
  submissionId: string;
  version: number;
  canSubmit: boolean;
  issues: ReviewIssue[];
  matchedRuleIds: string[];
  routes: ReturnType<typeof evaluateFormRules>["routes"];
}

export interface CfpReceipt {
  id: string;
  submissionId: string;
  version: number;
  submittedAt: string;
}
export interface CfpOrganizerSubmission {
  submission: Submission;
  submissionFields: CfpForm["submissionFields"];
  participantFields: CfpForm["participantFields"];
}
export interface CfpOrganizerSubmissionsReadModel {
  readonly submissions: readonly Submission[];
  readonly forms: readonly CfpForm[];
}
export interface PublicCfpEvent {
  id: EventCfp["id"];
  slug: EventCfp["slug"];
  name: EventCfp["name"];
  timezone: EventCfp["timezone"];
  opensAt: EventCfp["opensAt"];
  closesAt: EventCfp["closesAt"];
}
export interface PublicCfpOrganization {
  id: string;
  slug: string;
  name: string;
}

export type PublicFormRuleAction = Exclude<FormRuleAction, { type: "route" }>;
export type PublicFormRule = Omit<CfpForm["rules"][number], "actions"> & {
  actions: PublicFormRuleAction[];
};

export type PublicCfpForm = Omit<
  CfpForm,
  "tenantId" | "eventId" | "rules" | "settings" | "status"
> & {
  status: "published";
  rules: PublicFormRule[];
  settings: Pick<
    CfpForm["settings"],
    | "speakerLimit"
    | "maxSubmissionsPerAccount"
    | "confirmationMessage"
    | "successContent"
    | "redirectUrl"
  >;
};

export interface PublishedCfp {
  organization: PublicCfpOrganization;
  event: PublicCfpEvent;
  form: PublicCfpForm;
}

export interface SubmitResult {
  submission: Submission;
  receipt?: CfpReceipt;
  confirmationQueued: boolean;
}

const requiredCompletedSteps: SubmissionStep[] = [
  "welcome",
  "account",
  "submission",
  "participant",
  "review",
];

function requireIdempotencyKey(key: string): string {
  const normalized = key.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new CfpError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "A non-empty idempotency key of at most 200 characters is required.",
    );
  }
  return normalized;
}

async function cfpFileUploadFingerprint(
  operation: "issue" | "finalize",
  input: object,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify({ version: 1, operation, input })),
    ),
  );
  return `cfp-file-upload-v1:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function ensureTenant(resourceTenantId: string, tenantId: string): void {
  if (resourceTenantId !== tenantId) {
    throw new CfpError("FORBIDDEN", "The resource does not belong to this tenant.");
  }
}

function ensureEventFormMatch(event: EventCfp, form: CfpForm): void {
  if (event.tenantId !== form.tenantId || event.id !== form.eventId) {
    throw new CfpError("FORBIDDEN", "The CFP form does not belong to this event.");
  }
}

function ensureOpen(event: EventCfp, now: Date): void {
  const timestamp = now.getTime();
  if (timestamp < Date.parse(event.opensAt)) {
    throw new CfpError("CFP_NOT_OPEN", "The CFP is not open yet.");
  }
  if (timestamp >= Date.parse(event.closesAt)) {
    throw new CfpError("CFP_CLOSED", "The CFP is closed.");
  }
}

function addCompletedStep(
  completedSteps: SubmissionStep[],
  completedStep: SubmissionStep | undefined,
): SubmissionStep[] {
  if (!completedStep || completedSteps.includes(completedStep)) {
    return completedSteps;
  }
  const targetIndex = submissionSteps.indexOf(completedStep);
  const missingPriorStep = submissionSteps
    .slice(0, targetIndex)
    .find((step) => !completedSteps.includes(step));
  if (missingPriorStep) {
    throw new CfpError(
      "VALIDATION_FAILED",
      `Step '${missingPriorStep}' must be completed before '${completedStep}'.`,
    );
  }
  return [...completedSteps, completedStep].sort(
    (left, right) => submissionSteps.indexOf(left) - submissionSteps.indexOf(right),
  );
}

function validateReview(submission: Submission, form: CfpForm): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  if (submissionTitle(submission).length === 0) {
    issues.push({
      path: "answers.title",
      code: "required",
      message: "Title is required.",
    });
  }
  if (submission.participants.length === 0) {
    issues.push({
      path: "participants",
      code: "required",
      message: "At least one participant is required.",
    });
  }
  if (submission.participants.length > form.settings.speakerLimit) {
    issues.push({
      path: "participants",
      code: "speaker_limit",
      message: `This form allows at most ${form.settings.speakerLimit} speakers.`,
    });
  }
  const primaryCount = submission.participants.filter(
    (participant) => participant.role === "primary",
  ).length;
  if (primaryCount !== 1) {
    issues.push({
      path: "participants",
      code: "primary_participant",
      message: "Exactly one primary participant is required.",
    });
  }

  const participantEmails = submission.participants
    .map((participant) => participant.email.trim().toLowerCase())
    .filter(Boolean);
  const duplicateParticipantEmail = participantEmails.find(
    (email, index) => participantEmails.indexOf(email) !== index,
  );
  if (duplicateParticipantEmail) {
    issues.push({
      path: "participants",
      code: "duplicate_email",
      message: "Participant email addresses must be unique.",
    });
  }

  for (const [index, contact] of submission.secondaryContacts.entries()) {
    if (!contact.name || !contact.email) {
      issues.push({
        path: `secondaryContacts.${index}`,
        code: "required",
        message: "Secondary contact name and email are required.",
      });
    } else if (participantEmails.includes(contact.email.toLowerCase())) {
      issues.push({
        path: `secondaryContacts.${index}.email`,
        code: "duplicate_email",
        message: "A secondary contact must not duplicate a participant email.",
      });
    }
  }

  issues.push(...validateSubmissionAnswers(form, submission.answers, submission.participants));
  for (const step of requiredCompletedSteps) {
    if (!submission.completedSteps.includes(step)) {
      issues.push({
        path: "completedSteps",
        code: "incomplete_step",
        message: `Submission step '${step}' is incomplete.`,
      });
    }
  }
  return issues;
}
function isEmptyAnswer(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}
function submissionTitle(submission: Submission): string {
  const value = submission.answers.title;
  return typeof value === "string" ? value.trim() : "";
}

function validateFileRequestShapes(
  form: CfpForm,
  submission: Submission,
  options: {
    enforceRequired: boolean;
  } = {
    enforceRequired: true,
  },
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  const inspect = (field: FormField, value: unknown, path: string): void => {
    if (field.kind !== "file_request" || field.fileRequest === undefined) {
      return;
    }
    const required = field.required || field.fileRequest.required;
    if (isEmptyAnswer(value)) {
      if (options.enforceRequired && required) {
        issues.push({
          path,
          code: "required",
          message: `${field.label} is required.`,
        });
      }
      return;
    }
    if (!fileRequestAnswerSchema.safeParse(value).success) {
      issues.push({
        path,
        code: "invalid_file",
        message: `${field.label} must reference a finalized uploaded asset.`,
      });
    }
  };

  for (const field of form.submissionFields) {
    inspect(field, submission.answers[field.key], `answers.${field.key}`);
  }
  for (const [index, participant] of submission.participants.entries()) {
    for (const field of form.participantFields) {
      inspect(field, participant.answers[field.key], `participants.${index}.answers.${field.key}`);
    }
  }
  return issues;
}

function rebaseDraftToCurrentForm(submission: Submission, form: CfpForm): Submission {
  if (submission.formVersion === form.version) return submission;
  const issues = [
    ...validateSubmissionAnswerCompatibility(form, submission.answers, submission.participants),
    ...validateFileRequestShapes(form, submission, { enforceRequired: false }),
  ];
  if (submission.formVersion > form.version || issues.length > 0) {
    throw new CfpError("CONFLICT", "The CFP form is incompatible with this historical draft.", {
      submissionFormVersion: submission.formVersion,
      currentFormVersion: form.version,
      issues,
    });
  }
  return { ...submission, formVersion: form.version };
}

function allowedMimeType(allowed: string, actual: string): boolean {
  const normalizedAllowed = allowed.trim().toLowerCase();
  const normalizedActual = actual.trim().toLowerCase();
  return (
    normalizedAllowed === normalizedActual ||
    (normalizedAllowed.endsWith("/*") &&
      normalizedActual.startsWith(normalizedAllowed.slice(0, -1)))
  );
}
function looksLikeTitleField(field: FormField): boolean {
  const key = field.key.trim().toLocaleLowerCase();
  const label = field.label.trim().toLocaleLowerCase();
  if (key === "title" || field.id === "title") return true;
  if (key === "title1" || key.startsWith("title-") || key.endsWith("-title")) return true;
  return label === "title" || label === "session title" || label.startsWith("session title");
}

/**
 * Normalize mis-keyed title fields before validation so broken organizer configs
 * can be repaired instead of permanently blocking applicants.
 */
function normalizeCanonicalTitleFields(form: CfpForm): CfpForm {
  const titleByKey = form.submissionFields.filter((field) => field.key === "title");
  if (titleByKey.length >= 1) return form;

  const titleById = form.submissionFields.find((field) => field.id === "title");
  if (titleById) {
    return {
      ...form,
      submissionFields: form.submissionFields.map((field) =>
        field.id === titleById.id ? { ...field, key: "title" } : field,
      ),
    };
  }

  const titleLike = form.submissionFields.filter((field) => looksLikeTitleField(field));
  if (titleLike.length !== 1) return form;
  const target = titleLike[0];
  if (target === undefined) return form;
  return {
    ...form,
    submissionFields: form.submissionFields.map((field) =>
      field.id === target.id ? { ...field, key: "title" } : field,
    ),
  };
}

function sanitizeDynamicForm(form: CfpForm): CfpForm {
  const sanitizeField = (field: FormField): FormField => ({
    ...field,
    ...(field.description === undefined
      ? {}
      : { description: sanitizeRichText(field.description) }),
    ...(field.placeholder === undefined
      ? {}
      : { placeholder: sanitizePlainText(field.placeholder) }),
  });
  return normalizeCanonicalTitleFields({
    ...form,
    submissionFields: form.submissionFields.map(sanitizeField),
    participantFields: form.participantFields.map(sanitizeField),
  });
}

function publicFormRules(form: CfpForm): PublicFormRule[] {
  return form.rules.flatMap((rule) => {
    const actions = rule.actions.filter(
      (action): action is PublicFormRuleAction => action.type !== "route",
    );
    return actions.length === 0 ? [] : [{ ...rule, actions }];
  });
}
function ensureSubmissionSchemaVersion(submission: Submission, form: CfpForm): void {
  if (submission.formVersion !== form.version) {
    throw new CfpError(
      "CONFLICT",
      "The CFP form schema version is no longer available for this submission.",
      {
        submissionFormVersion: submission.formVersion,
        currentFormVersion: form.version,
      },
    );
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function preserveUnchangedAnswers(
  sanitized: Record<string, unknown>,
  candidate: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sanitized).map(([key, value]) => [
      key,
      Object.hasOwn(current, key) && valuesEqual(candidate[key], current[key])
        ? current[key]
        : value,
    ]),
  );
}

function sanitizeDraftChanges(
  candidate: Submission,
  current: Submission,
  form: CfpForm,
): Submission {
  const sanitized = sanitizeSubmission(candidate, form);
  const currentParticipants = new Map(
    current.participants.map((participant) => [participant.id, participant]),
  );
  const currentContacts = new Map(
    current.secondaryContacts.map((contact) => [contact.id, contact]),
  );
  return {
    ...sanitized,
    answers: preserveUnchangedAnswers(sanitized.answers, candidate.answers, current.answers),
    participants: sanitized.participants.map((participant, index) => {
      const candidateParticipant = candidate.participants[index];
      const currentParticipant = currentParticipants.get(participant.id);
      if (candidateParticipant === undefined || currentParticipant === undefined)
        return participant;
      return {
        ...participant,
        firstName: valuesEqual(candidateParticipant.firstName, currentParticipant.firstName)
          ? currentParticipant.firstName
          : participant.firstName,
        lastName: valuesEqual(candidateParticipant.lastName, currentParticipant.lastName)
          ? currentParticipant.lastName
          : participant.lastName,
        email: valuesEqual(candidateParticipant.email, currentParticipant.email)
          ? currentParticipant.email
          : participant.email,
        biography: valuesEqual(candidateParticipant.biography, currentParticipant.biography)
          ? currentParticipant.biography
          : participant.biography,
        answers: preserveUnchangedAnswers(
          participant.answers,
          candidateParticipant.answers,
          currentParticipant.answers,
        ),
      };
    }),
    secondaryContacts: sanitized.secondaryContacts.map((contact, index) => {
      const candidateContact = candidate.secondaryContacts[index];
      const currentContact = currentContacts.get(contact.id);
      if (candidateContact === undefined || currentContact === undefined) return contact;
      return {
        ...contact,
        name: valuesEqual(candidateContact.name, currentContact.name)
          ? currentContact.name
          : contact.name,
        email: valuesEqual(candidateContact.email, currentContact.email)
          ? currentContact.email
          : contact.email,
      };
    }),
  };
}
interface CfpFileUploadContext {
  event: EventCfp;
  form: CfpForm;
  submission: Submission;
  field: FormField;
  owner: "submission" | "participant";
  participantId?: string;
}

function normalizedFileUploadMetadata(
  field: FormField,
  fileName: string,
  contentType: string,
  sizeBytes: number,
): { fileName: string; contentType: string; sizeBytes: number } {
  if (field.kind !== "file_request" || field.fileRequest === undefined) {
    throw new CfpError("VALIDATION_FAILED", "The requested field is not a file request.");
  }
  const normalizedName = fileName.trim();
  if (normalizedName.length === 0 || normalizedName.length > 255) {
    throw new CfpError(
      "VALIDATION_FAILED",
      "The upload file name must be between 1 and 255 characters.",
    );
  }
  const normalizedType = contentType.trim().toLowerCase();
  if (normalizedType.length === 0 || normalizedType.length > 127) {
    throw new CfpError("VALIDATION_FAILED", "The upload content type is invalid.");
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new CfpError("VALIDATION_FAILED", "The upload size must be a positive integer.");
  }
  if (sizeBytes > field.fileRequest.maxBytes) {
    throw new CfpError("VALIDATION_FAILED", "The upload exceeds the maximum allowed file size.");
  }
  if (
    !field.fileRequest.allowedMimeTypes.some((allowed) => allowedMimeType(allowed, normalizedType))
  ) {
    throw new CfpError(
      "VALIDATION_FAILED",
      "The upload content type is not allowed for this field.",
    );
  }
  return { fileName: normalizedName, contentType: normalizedType, sizeBytes };
}

function assertFileAssetBinding(
  asset: CfpFileAsset | null | undefined,
  expected: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    assetId?: string;
    owner: "submission" | "participant";
    participantId?: string;
  },
  message: string,
): CfpFileAsset {
  if (
    asset === null ||
    asset === undefined ||
    !fileRequestAnswerSchema.safeParse({ assetId: asset.assetId }).success ||
    (expected.assetId !== undefined && asset.assetId !== expected.assetId) ||
    asset.tenantId !== expected.tenantId ||
    asset.eventId !== expected.eventId ||
    asset.submissionId !== expected.submissionId ||
    asset.owner !== expected.owner ||
    (expected.owner === "participant"
      ? asset.participantId !== expected.participantId
      : asset.participantId !== undefined)
  ) {
    throw new CfpError("VALIDATION_FAILED", message);
  }
  return asset;
}

function assertUploadAuthorization(
  authorization: CfpFileUploadAuthorization,
  expected: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    owner: "submission" | "participant";
    participantId?: string;
    contentType: string;
    sizeBytes: number;
    now?: Date;
  },
): CfpFileAsset {
  const asset = assertFileAssetBinding(
    authorization?.asset,
    expected,
    "The private upload authorization is not owned by this submission.",
  );
  if (asset.state !== "pending_upload") {
    throw new CfpError("VALIDATION_FAILED", "The private upload authorization is not pending.");
  }
  if (
    asset.contentType.trim().toLowerCase() !== expected.contentType ||
    asset.sizeBytes !== expected.sizeBytes
  ) {
    throw new CfpError(
      "VALIDATION_FAILED",
      "The private upload authorization metadata is invalid.",
    );
  }
  const grant = authorization?.grant;
  const expiresAt = Date.parse(grant?.expiresAt ?? "");
  if (
    grant === undefined ||
    grant.method !== "PUT" ||
    typeof grant.url !== "string" ||
    grant.url.trim().length === 0 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= (expected.now?.getTime() ?? Date.now())
  ) {
    throw new CfpError(
      "VALIDATION_FAILED",
      "The private upload authorization is invalid or expired.",
    );
  }
  return asset;
}

function assetForFileField(
  form: CfpForm,
  fieldKey: string,
  participantId: string | undefined,
): FormField {
  const fields = participantId === undefined ? form.submissionFields : form.participantFields;
  const field = fields.find((candidate) => candidate.key === fieldKey);
  if (field === undefined || field.kind !== "file_request" || field.fileRequest === undefined) {
    throw new CfpError(
      "VALIDATION_FAILED",
      "The requested field is not an authorized file request.",
    );
  }
  if (field.fileRequest.owner === "participant" && participantId === undefined) {
    throw new CfpError("VALIDATION_FAILED", "A participant is required for this file request.");
  }
  if (field.fileRequest.owner === "submission" && participantId !== undefined) {
    throw new CfpError(
      "VALIDATION_FAILED",
      "This submission file request cannot target a participant.",
    );
  }
  return field;
}

export class CfpService {
  readonly #repository: CfpRepository;
  readonly #idempotency: CfpIdempotencyCoordinator;
  readonly #effects: CfpEffects;
  readonly #clock: CfpClock;
  readonly #fileAssets:
    | (CfpFileAssetAuthorizer &
        Partial<Pick<CfpFileAssetGateway, "issueUpload" | "finalizeUpload">>)
    | undefined;
  readonly #ids: CfpIdGenerator;
  readonly #organization: {
    getPublicOrganization(tenantId: string): Promise<PublicCfpOrganization>;
  };

  constructor(dependencies: {
    repository: CfpRepository;
    idempotency: CfpIdempotencyCoordinator;
    effects: CfpEffects;
    organization: {
      getPublicOrganization(tenantId: string): Promise<PublicCfpOrganization>;
    };
    clock?: CfpClock;
    ids?: CfpIdGenerator;
    fileAssets?: CfpFileAssetAuthorizer &
      Partial<Pick<CfpFileAssetGateway, "issueUpload" | "finalizeUpload">>;
  }) {
    this.#repository = dependencies.repository;
    this.#idempotency = dependencies.idempotency;
    this.#effects = dependencies.effects;
    this.#organization = dependencies.organization;
    this.#clock = dependencies.clock ?? { now: () => new Date() };
    this.#fileAssets = dependencies.fileAssets;
    this.#ids =
      dependencies.ids ??
      ({ next: (prefix) => `${prefix}_${crypto.randomUUID()}` } satisfies CfpIdGenerator);
  }
  async getEvent(input: { tenantId: string; eventId: string }): Promise<EventCfp> {
    return this.#getEvent(input.tenantId, input.eventId);
  }

  async getForm(input: { tenantId: string; formId: string }): Promise<CfpForm> {
    return this.#getForm(input.tenantId, input.formId);
  }

  async listForms(input: { tenantId: string; eventId: string }): Promise<CfpForm[]> {
    await this.#getEvent(input.tenantId, input.eventId);
    const forms = await this.#repository.listForms(input.tenantId, input.eventId);
    return forms
      .filter((form) => form.tenantId === input.tenantId && form.eventId === input.eventId)
      .sort((left, right) => {
        const statusOrder = { published: 0, draft: 1, closed: 2 } as const;
        return (
          statusOrder[left.status] - statusOrder[right.status] ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        );
      });
  }
  async listOrganizerSubmissions(input: {
    tenantId: string;
    eventId: string;
  }): Promise<CfpOrganizerSubmission[]> {
    const eventRead = this.#getEvent(input.tenantId, input.eventId);
    const readModel = this.#repository.getOrganizerSubmissionsReadModel;
    let submissions: readonly Submission[];
    let batchForms: readonly CfpForm[] | undefined;
    if (readModel !== undefined) {
      const [eventResult, readModelResult] = await Promise.allSettled([
        eventRead,
        readModel.call(this.#repository, input.tenantId, input.eventId),
      ]);
      if (eventResult.status === "rejected") {
        throw eventResult.reason;
      }
      if (readModelResult.status === "rejected") {
        throw readModelResult.reason;
      }
      submissions = readModelResult.value.submissions;
      batchForms = readModelResult.value.forms;
    } else {
      const listSubmissions = this.#repository.listSubmissionsForEvent;
      if (listSubmissions === undefined) {
        await eventRead;
        throw new CfpError("NOT_FOUND", "The CFP submissions were not found.");
      }
      const [eventResult, submissionsResult] = await Promise.allSettled([
        eventRead,
        listSubmissions.call(this.#repository, input.tenantId, input.eventId),
      ]);
      if (eventResult.status === "rejected") {
        throw eventResult.reason;
      }
      if (submissionsResult.status === "rejected") {
        throw submissionsResult.reason;
      }
      submissions = submissionsResult.value;
    }

    const scopedSubmissions = submissions.filter(
      (submission) =>
        submission.tenantId === input.tenantId && submission.eventId === input.eventId,
    );
    const formIds = [...new Set(scopedSubmissions.map((submission) => submission.formId))];
    const formsById = new Map<string, CfpForm>();
    if (formIds.length > 0) {
      if (batchForms !== undefined) {
        for (const form of batchForms) {
          if (form.tenantId === input.tenantId) {
            formsById.set(form.id, form);
          }
        }
      } else {
        const listFormsByIds = this.#repository.listFormsByIds;
        if (listFormsByIds !== undefined) {
          const forms = await listFormsByIds.call(this.#repository, formIds);
          for (const form of forms) {
            if (form.tenantId === input.tenantId) {
              formsById.set(form.id, form);
            }
          }
        } else {
          const forms = await Promise.all(
            formIds.map((formId) => this.#getForm(input.tenantId, formId)),
          );
          for (const [index, formId] of formIds.entries()) {
            const form = forms[index];
            if (form !== undefined) {
              formsById.set(formId, form);
            }
          }
        }
      }
    }

    const records: CfpOrganizerSubmission[] = [];
    for (const submission of scopedSubmissions) {
      const form = formsById.get(submission.formId);
      if (form === undefined) {
        throw new CfpError("NOT_FOUND", "The CFP form was not found.");
      }
      ensureTenant(form.tenantId, input.tenantId);
      if (form.eventId !== input.eventId) {
        continue;
      }
      records.push({
        submission,
        submissionFields: form.submissionFields,
        participantFields: form.participantFields,
      });
    }
    return records;
  }
  async getPublishedCfp(input: {
    tenantId: string;
    eventId?: string;
    eventSlug?: string;
    formId?: string;
  }): Promise<PublishedCfp> {
    const event =
      input.eventSlug === undefined
        ? await this.#getEvent(input.tenantId, input.eventId ?? "")
        : await this.#getEventBySlug(input.tenantId, input.eventSlug);
    const publishedForms = (await this.#repository.listForms(input.tenantId, event.id)).filter(
      (candidate) => candidate.status === "published",
    );
    const form =
      input.formId === undefined
        ? publishedForms.length === 1
          ? publishedForms[0]
          : undefined
        : publishedForms.find((candidate) => candidate.id === input.formId);
    if (!form) {
      throw new CfpError("NOT_FOUND", "The published CFP form was not found.");
    }
    ensureEventFormMatch(event, form);
    if (form.status !== "published") {
      throw new CfpError("FORM_NOT_PUBLISHED", "The CFP form is not published.");
    }
    await this.#validateReusableFields(form);
    const sanitizedForm = sanitizeDynamicForm(sanitizeForm(form));
    const {
      tenantId: _tenantId,
      eventId: _eventId,
      rules: _rules,
      settings,
      ...publicForm
    } = sanitizedForm;
    return {
      organization: await this.#organization.getPublicOrganization(input.tenantId),
      event: {
        id: event.id,
        slug: event.slug,
        name: event.name,
        timezone: event.timezone,
        opensAt: event.opensAt,
        closesAt: event.closesAt,
      },
      form: {
        ...publicForm,
        status: "published",
        rules: publicFormRules(sanitizedForm),
        settings: {
          speakerLimit: settings.speakerLimit,
          maxSubmissionsPerAccount: settings.maxSubmissionsPerAccount,
          confirmationMessage: settings.confirmationMessage,
          successContent: settings.successContent,
          ...(settings.redirectUrl === undefined ? {} : { redirectUrl: settings.redirectUrl }),
        },
      },
    };
  }
  async getPublishedForm(input: {
    tenantId: string;
    eventId?: string;
    eventSlug?: string;
    formId?: string;
  }): Promise<PublishedCfp> {
    return this.getPublishedCfp(input);
  }
  async getReceipt(input: {
    tenantId: string;
    eventId?: string;
    submissionId: string;
    ownerAccountId: string;
  }): Promise<CfpReceipt> {
    const submission = await this.#getOwnedSubmission(input);
    if (submission.status !== "submitted" || submission.submittedAt === undefined) {
      throw new CfpError("NOT_FOUND", "A submission receipt is not available.");
    }
    return {
      id: submission.id,
      submissionId: submission.id,
      version: submission.version,
      submittedAt: submission.submittedAt,
    };
  }

  async loadDraft(input: {
    tenantId: string;
    eventId?: string;
    submissionId: string;
    ownerAccountId: string;
  }): Promise<Submission> {
    const submission = await this.#getOwnedSubmission(input);
    const event = await this.#getEvent(input.tenantId, submission.eventId);
    const form = await this.#getForm(input.tenantId, submission.formId);
    ensureEventFormMatch(event, form);
    const rebased = rebaseDraftToCurrentForm(submission, form);
    return submission.formVersion === form.version ? sanitizeSubmission(rebased, form) : rebased;
  }

  async createForm(input: {
    tenantId: string;
    form: unknown;
    expectedVersion: number | null;
    idempotencyKey: string;
  }): Promise<CfpForm> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    return this.#idempotency.run(`${input.tenantId}:cfp:create-form`, key, () =>
      this.saveForm(input.form, input.expectedVersion),
    );
  }

  async publishForm(input: {
    tenantId: string;
    eventId: string;
    formId: string;
    organizerId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<CfpForm> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    return this.#idempotency.run(`${input.tenantId}:cfp:publish:${input.formId}`, key, async () => {
      const current = await this.#getForm(input.tenantId, input.formId);
      ensureEventFormMatch(await this.#getEvent(input.tenantId, input.eventId), current);
      if (current.version !== input.expectedVersion) {
        throw new CfpError("CONFLICT", "The CFP form has changed since it was loaded.");
      }
      if (current.status === "published") return current;
      const published = sanitizeForm({
        ...current,
        status: "published",
        version: current.version + 1,
      });
      await this.#repository.saveForm(published, current.version);
      return published;
    });
  }

  async saveEvent(input: unknown, expectedVersion: number | null): Promise<EventCfp> {
    const parsed = eventCfpSchema.safeParse(input);
    if (!parsed.success) {
      throw new CfpError("VALIDATION_FAILED", "The event CFP configuration is invalid.", {
        issues: parsed.error.issues,
      });
    }
    const requestedEvent = {
      ...parsed.data,
      name: sanitizePlainText(parsed.data.name),
    };
    const current = await this.#repository.getEvent(requestedEvent.tenantId, requestedEvent.id);
    if (current === null) {
      throw new CfpError("NOT_FOUND", "The event was not found.");
    }
    const event = {
      ...requestedEvent,
      slug: current.slug,
      name: current.name,
      timezone: current.timezone,
      eventStartsAt: current.eventStartsAt,
    };
    if (current.eventStartsAt === undefined) {
      throw new CfpError(
        "VALIDATION_FAILED",
        "The authoritative event start is unavailable for CFP schedule validation.",
      );
    }
    const today = localDateInTimeZone(this.#clock.now().toISOString(), event.timezone);
    const changedPastBoundary =
      (event.opensAt !== current.opensAt &&
        localDateInTimeZone(event.opensAt, event.timezone) < today) ||
      (event.closesAt !== current.closesAt &&
        localDateInTimeZone(event.closesAt, event.timezone) < today);
    if (changedPastBoundary) {
      throw new CfpError(
        "VALIDATION_FAILED",
        "New CFP dates cannot be before today in the event time zone.",
      );
    }
    if (
      event.eventStartsAt !== undefined &&
      (Date.parse(event.opensAt) > Date.parse(event.eventStartsAt) ||
        Date.parse(event.closesAt) > Date.parse(event.eventStartsAt))
    ) {
      throw new CfpError(
        "VALIDATION_FAILED",
        "The CFP window must finish before the event begins.",
      );
    }
    await this.#repository.saveEvent(event, expectedVersion);
    return event;
  }

  async saveConfiguration(input: {
    event: unknown;
    form: unknown;
    expectedEventVersion: number | null;
    expectedFormVersion: number | null;
    idempotencyKey: string;
  }): Promise<{ event: EventCfp; form: CfpForm }> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const parsedEvent = eventCfpSchema.safeParse(input.event);
    if (!parsedEvent.success) {
      throw new CfpError("VALIDATION_FAILED", "The event CFP configuration is invalid.", {
        issues: parsedEvent.error.issues,
      });
    }
    const prevalidated = cfpFormSchema.safeParse(input.form);
    const candidate = prevalidated.success
      ? normalizeCanonicalTitleFields(prevalidated.data)
      : input.form;
    const validation = validateCfpForm(candidate);
    if (!validation.success) {
      throw new CfpError("VALIDATION_FAILED", "The CFP form configuration is invalid.", {
        issues: validation.issues,
      });
    }
    const form = sanitizeDynamicForm(sanitizeForm(validation.form));
    const sanitizedValidation = validateCfpForm(form);
    if (!sanitizedValidation.success) {
      throw new CfpError("VALIDATION_FAILED", "Sanitized CFP form configuration is invalid.", {
        issues: sanitizedValidation.issues,
      });
    }
    return this.#idempotency.run(
      `${parsedEvent.data.tenantId}:cfp:configuration`,
      key,
      async () => {
        const currentEvent = await this.#repository.getEvent(
          parsedEvent.data.tenantId,
          parsedEvent.data.id,
        );
        if (currentEvent === null) throw new CfpError("NOT_FOUND", "The event was not found.");
        const event = {
          ...parsedEvent.data,
          slug: currentEvent.slug,
          name: currentEvent.name,
          timezone: currentEvent.timezone,
          eventStartsAt: currentEvent.eventStartsAt,
        };
        ensureEventFormMatch(currentEvent, form);
        if (currentEvent.eventStartsAt === undefined) {
          throw new CfpError(
            "VALIDATION_FAILED",
            "The authoritative event start is unavailable for CFP schedule validation.",
          );
        }
        const today = localDateInTimeZone(this.#clock.now().toISOString(), event.timezone);
        const changedPastBoundary =
          (event.opensAt !== currentEvent.opensAt &&
            localDateInTimeZone(event.opensAt, event.timezone) < today) ||
          (event.closesAt !== currentEvent.closesAt &&
            localDateInTimeZone(event.closesAt, event.timezone) < today);
        if (changedPastBoundary) {
          throw new CfpError(
            "VALIDATION_FAILED",
            "New CFP dates cannot be before today in the event time zone.",
          );
        }
        if (
          Date.parse(event.opensAt) > Date.parse(currentEvent.eventStartsAt) ||
          Date.parse(event.closesAt) > Date.parse(currentEvent.eventStartsAt)
        ) {
          throw new CfpError(
            "VALIDATION_FAILED",
            "The CFP window must finish before the event begins.",
          );
        }
        const existing = await this.#repository.getForm(form.tenantId, form.id);
        if (existing) {
          ensureEventFormMatch(currentEvent, existing);
          if (
            input.expectedFormVersion !== existing.version ||
            form.version !== existing.version + 1
          ) {
            throw new CfpError("CONFLICT", "The CFP form has changed since it was loaded.");
          }
        } else if (input.expectedFormVersion !== null || form.version !== 1) {
          throw new CfpError("CONFLICT", "A new CFP form must start at version 1.");
        }
        if (
          input.expectedEventVersion !== currentEvent.version ||
          event.version !== currentEvent.version + 1
        ) {
          throw new CfpError("CONFLICT", "The event CFP configuration has changed.");
        }
        await this.#validateReusableFields(form);
        const forms = await this.#repository.listForms(form.tenantId, form.eventId);
        if (!forms.some((candidate) => candidate.id === form.id) && forms.length >= 20) {
          throw new CfpError("FORM_LIMIT_REACHED", "An event cannot have more than 20 CFP forms.");
        }
        if (this.#repository.saveConfiguration) {
          await this.#repository.saveConfiguration(
            event,
            form,
            input.expectedEventVersion,
            input.expectedFormVersion,
          );
        } else {
          await this.#repository.saveEvent(event, input.expectedEventVersion);
          await this.#repository.saveForm(form, input.expectedFormVersion);
        }
        return { event, form };
      },
    );
  }
  async saveForm(input: unknown, expectedVersion: number | null): Promise<CfpForm> {
    // Repair unambiguous mis-keyed title fields before validation so organizers
    // can save a previously broken form without a dead-end applicant flow.
    const prevalidated = cfpFormSchema.safeParse(input);
    const candidate = prevalidated.success
      ? normalizeCanonicalTitleFields(prevalidated.data)
      : input;
    const validation = validateCfpForm(candidate);
    if (!validation.success) {
      throw new CfpError("VALIDATION_FAILED", "The CFP form configuration is invalid.", {
        issues: validation.issues,
      });
    }
    const form = sanitizeDynamicForm(sanitizeForm(validation.form));
    const sanitizedValidation = validateCfpForm(form);
    if (!sanitizedValidation.success) {
      throw new CfpError("VALIDATION_FAILED", "Sanitized CFP form configuration is invalid.", {
        issues: sanitizedValidation.issues,
      });
    }
    const event = await this.#getEvent(form.tenantId, form.eventId);
    ensureEventFormMatch(event, form);
    const existing = await this.#repository.getForm(form.tenantId, form.id);
    if (existing) {
      ensureEventFormMatch(event, existing);
      if (expectedVersion !== existing.version || form.version !== existing.version + 1) {
        throw new CfpError("CONFLICT", "The CFP form has changed since it was loaded.", {
          expectedVersion,
          currentVersion: existing.version,
          submittedVersion: form.version,
        });
      }
    } else if (expectedVersion !== null || form.version !== 1) {
      throw new CfpError("CONFLICT", "A new CFP form must start at version 1.");
    }
    await this.#validateReusableFields(form);
    const forms = await this.#repository.listForms(form.tenantId, form.eventId);
    if (!forms.some((candidate) => candidate.id === form.id) && forms.length >= 20) {
      throw new CfpError("FORM_LIMIT_REACHED", "An event cannot have more than 20 CFP forms.");
    }
    await this.#repository.saveForm(form, expectedVersion);
    return form;
  }

  async createDraft(input: {
    tenantId: string;
    eventId: string;
    formId: string;
    ownerAccountId: string;
    idempotencyKey: string;
  }): Promise<Submission> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    return this.#idempotency.run(
      `${input.tenantId}:cfp:create:${input.formId}:${input.ownerAccountId}:${key}`,
      key,
      async () => {
        const [event, form] = await Promise.all([
          this.#getEvent(input.tenantId, input.eventId),
          this.#getForm(input.tenantId, input.formId),
        ]);
        ensureEventFormMatch(event, form);
        await this.#validateReusableFields(form);
        if (form.status !== "published") {
          throw new CfpError("FORM_NOT_PUBLISHED", "The CFP form is not published.");
        }
        ensureOpen(event, this.#clock.now());
        const ownedCount = await this.#repository.countOwnedSubmissions({
          tenantId: input.tenantId,
          eventId: input.eventId,
          formId: input.formId,
          ownerAccountId: input.ownerAccountId,
        });
        if (ownedCount >= form.settings.maxSubmissionsPerAccount) {
          throw new CfpError(
            "SUBMISSION_LIMIT_REACHED",
            "The account has reached this form's submission limit.",
          );
        }

        const now = this.#clock.now().toISOString();
        const submission = submissionSchema.parse({
          id: this.#ids.next("submission"),
          tenantId: input.tenantId,
          eventId: input.eventId,
          formId: input.formId,
          ownerAccountId: input.ownerAccountId,
          formVersion: form.version,
          version: 1,
          status: "draft",
          completedSteps: ["welcome"],
          answers: {},
          participants: [],
          secondaryContacts: [],
          createdAt: now,
          updatedAt: now,
        });
        await this.#repository.saveSubmissionVersion(
          {
            submission,
            reason: "draft_created",
            actorId: input.ownerAccountId,
            idempotencyKey: key,
          },
          null,
        );
        return submission;
      },
    );
  }
  async issueFileUpload(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    ownerAccountId: string;
    fieldKey: string;
    participantId?: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    idempotencyKey: string;
  }): Promise<CfpFileUploadAuthorization> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    await this.#getFileUploadContext(input);
    const fingerprint = await cfpFileUploadFingerprint("issue", {
      ...input,
      idempotencyKey: key,
    });
    return this.#idempotency.run(
      `${input.tenantId}:cfp:file-upload:issue:${input.submissionId}:${input.fieldKey}:${key}`,
      key,
      async () => {
        const context = await this.#getFileUploadContext(input);
        const metadata = normalizedFileUploadMetadata(
          context.field,
          input.fileName,
          input.contentType,
          input.sizeBytes,
        );
        const gateway = this.#fileAssets;
        if (gateway?.issueUpload === undefined) {
          throw new CfpError("VALIDATION_FAILED", "Private file uploads are not configured.");
        }
        let authorization: CfpFileUploadAuthorization;
        try {
          authorization = await gateway.issueUpload({
            tenantId: context.submission.tenantId,
            eventId: context.submission.eventId,
            submissionId: context.submission.id,
            owner: context.owner,
            ...(context.participantId === undefined
              ? {}
              : { participantId: context.participantId }),
            fieldKey: input.fieldKey,
            fileName: metadata.fileName,
            contentType: metadata.contentType,
            sizeBytes: metadata.sizeBytes,
            idempotencyKey: key,
          });
        } catch (error) {
          if (error instanceof CfpError) throw error;
          throw new CfpError(
            "VALIDATION_FAILED",
            "The private file upload could not be authorized.",
          );
        }
        assertUploadAuthorization(authorization, {
          tenantId: context.submission.tenantId,
          eventId: context.submission.eventId,
          submissionId: context.submission.id,
          owner: context.owner,
          ...(context.participantId === undefined ? {} : { participantId: context.participantId }),
          contentType: metadata.contentType,
          sizeBytes: metadata.sizeBytes,
          now: this.#clock.now(),
        });
        return authorization;
      },
      fingerprint,
    );
  }

  async finalizeFileUpload(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    ownerAccountId: string;
    fieldKey: string;
    assetId: string;
    participantId?: string;
    state: "ready" | "rejected";
    rejectionReason?: string;
    idempotencyKey: string;
  }): Promise<CfpFileAsset> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    await this.#getFileUploadContext(input);
    const fingerprint = await cfpFileUploadFingerprint("finalize", {
      ...input,
      idempotencyKey: key,
    });
    return this.#idempotency.run(
      `${input.tenantId}:cfp:file-upload:finalize:${input.submissionId}:${input.assetId}:${key}`,
      key,
      async () => {
        const context = await this.#getFileUploadContext(input);
        const gateway = this.#fileAssets;
        if (gateway?.finalizeUpload === undefined) {
          throw new CfpError("VALIDATION_FAILED", "Private file uploads are not configured.");
        }
        let asset: CfpFileAsset | null;
        try {
          asset = await gateway.getAsset({
            tenantId: context.submission.tenantId,
            eventId: context.submission.eventId,
            submissionId: context.submission.id,
            assetId: input.assetId,
            owner: context.owner,
            ...(context.participantId === undefined
              ? {}
              : { participantId: context.participantId }),
          });
        } catch (error) {
          if (error instanceof CfpError) throw error;
          throw new CfpError("VALIDATION_FAILED", "The private file upload could not be verified.");
        }
        const currentAsset = assertFileAssetBinding(
          asset,
          {
            tenantId: context.submission.tenantId,
            eventId: context.submission.eventId,
            submissionId: context.submission.id,
            assetId: input.assetId,
            owner: context.owner,
            ...(context.participantId === undefined
              ? {}
              : { participantId: context.participantId }),
          },
          "The private upload asset is not owned by this submission.",
        );
        if (currentAsset.state === input.state) {
          if (input.state === "ready")
            this.#validateFinalizedFileAsset(context.field, currentAsset);
          return currentAsset;
        }
        if (currentAsset.state !== "pending_upload") {
          throw new CfpError(
            "VALIDATION_FAILED",
            "The private upload asset is no longer available for finalization.",
          );
        }
        const rejectionReason = input.rejectionReason?.trim();
        if (rejectionReason !== undefined && rejectionReason.length > 2000) {
          throw new CfpError("VALIDATION_FAILED", "The upload rejection reason is too long.");
        }
        let finalized: CfpFileAsset;
        try {
          finalized = await gateway.finalizeUpload({
            tenantId: context.submission.tenantId,
            eventId: context.submission.eventId,
            submissionId: context.submission.id,
            fieldKey: input.fieldKey,
            assetId: input.assetId,
            owner: context.owner,
            ...(context.participantId === undefined
              ? {}
              : { participantId: context.participantId }),
            state: input.state,
            ...(rejectionReason ? { rejectionReason } : {}),
            idempotencyKey: key,
          });
        } catch (error) {
          if (error instanceof CfpError) throw error;
          throw new CfpError(
            "VALIDATION_FAILED",
            "The private file upload could not be finalized.",
          );
        }
        const result = assertFileAssetBinding(
          finalized,
          {
            tenantId: context.submission.tenantId,
            eventId: context.submission.eventId,
            submissionId: context.submission.id,
            assetId: input.assetId,
            owner: context.owner,
            ...(context.participantId === undefined
              ? {}
              : { participantId: context.participantId }),
          },
          "The finalized private upload asset is not owned by this submission.",
        );
        if (result.state !== input.state) {
          throw new CfpError(
            "VALIDATION_FAILED",
            "The private upload finalization state is invalid.",
          );
        }
        if (result.state === "ready") this.#validateFinalizedFileAsset(context.field, result);
        return result;
      },
      fingerprint,
    );
  }

  async saveDraft(input: {
    tenantId: string;
    eventId?: string;
    submissionId: string;
    ownerAccountId: string;
    expectedVersion: number;
    formVersion?: number;
    idempotencyKey: string;
    completedStep?: SubmissionStep;
    answers?: Record<string, unknown>;
    participants?: Submission["participants"];
    secondaryContacts?: Submission["secondaryContacts"];
  }): Promise<Submission> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    return this.#idempotency.run(
      `${input.tenantId}:cfp:save:${input.submissionId}:${key}`,
      key,
      async () => {
        const current = await this.#getOwnedSubmission(input);
        if (current.version !== input.expectedVersion) {
          throw new CfpError("CONFLICT", "The submission has changed since it was loaded.");
        }
        const [event, form] = await Promise.all([
          this.#getEvent(input.tenantId, current.eventId),
          this.#getForm(input.tenantId, current.formId),
        ]);
        ensureEventFormMatch(event, form);
        const rebasedCurrent = rebaseDraftToCurrentForm(current, form);
        if (input.formVersion !== undefined && input.formVersion !== form.version) {
          throw new CfpError("CONFLICT", "The submission schema version is stale.", {
            expectedFormVersion: input.formVersion,
            currentFormVersion: form.version,
          });
        }
        this.#ensureEditable(current, event);

        const parsed = submissionSchema.parse({
          ...rebasedCurrent,
          version: current.version + 1,
          formVersion: form.version,
          completedSteps: addCompletedStep(current.completedSteps, input.completedStep),
          answers:
            input.answers === undefined
              ? rebasedCurrent.answers
              : { ...rebasedCurrent.answers, ...input.answers },
          participants: input.participants ?? rebasedCurrent.participants,
          secondaryContacts: input.secondaryContacts ?? rebasedCurrent.secondaryContacts,
          updatedAt: this.#clock.now().toISOString(),
        });
        const compatibilityIssues = [
          ...validateSubmissionAnswerCompatibility(form, parsed.answers, parsed.participants),
          ...validateFileRequestShapes(form, parsed, { enforceRequired: false }),
        ];
        if (compatibilityIssues.length > 0) {
          throw new CfpError(
            "VALIDATION_FAILED",
            "The draft answers are incompatible with the CFP form.",
            {
              issues: compatibilityIssues,
            },
          );
        }
        const next = sanitizeDraftChanges(parsed, current, form);
        if (next.participants.length > form.settings.speakerLimit) {
          throw new CfpError(
            "VALIDATION_FAILED",
            `This form allows at most ${form.settings.speakerLimit} speakers.`,
          );
        }
        const fileIssues = await this.#validateFileRequestAssets(form, next);
        if (fileIssues.length > 0) {
          throw new CfpError("VALIDATION_FAILED", "The file request payload is invalid.", {
            issues: fileIssues,
          });
        }
        await this.#repository.saveSubmissionVersion(
          {
            submission: next,
            reason: "draft_saved",
            actorId: input.ownerAccountId,
            idempotencyKey: key,
          },
          current.version,
        );
        return next;
      },
    );
  }

  async review(input: {
    tenantId: string;
    eventId?: string;
    submissionId: string;
    ownerAccountId: string;
    idempotencyKey: string;
  }): Promise<SubmissionReview> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    return this.#idempotency.run(
      `${input.tenantId}:cfp:review:${input.submissionId}:${key}`,
      key,
      async () => {
        const submission = await this.#getOwnedSubmission(input);
        if (submission.status === "withdrawn") {
          throw new CfpError("INVALID_TRANSITION", "A withdrawn submission cannot be reviewed.");
        }
        const [event, form] = await Promise.all([
          this.#getEvent(input.tenantId, submission.eventId),
          this.#getForm(input.tenantId, submission.formId),
        ]);
        ensureEventFormMatch(event, form);
        ensureSubmissionSchemaVersion(submission, form);
        if (submission.status !== "reopened") {
          ensureOpen(event, this.#clock.now());
        }
        const sanitized = sanitizeSubmission(submission, form);
        const issues = [
          ...validateReview(sanitized, form),
          ...validateFileRequestShapes(form, sanitized),
          ...(await this.#validateFileRequestAssets(form, sanitized)),
        ];
        const evaluated = evaluateFormRules(form, sanitized.answers);
        return {
          submissionId: submission.id,
          version: submission.version,
          canSubmit: issues.length === 0,
          issues,
          matchedRuleIds: evaluated.matchedRuleIds,
          routes: evaluated.routes,
        };
      },
    );
  }

  async submit(input: {
    tenantId: string;
    eventId?: string;
    submissionId: string;
    ownerAccountId: string;
    expectedVersion: number;
    formVersion?: number;
    idempotencyKey: string;
  }): Promise<SubmitResult> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    return this.#idempotency.run(
      `${input.tenantId}:cfp:submit:${input.submissionId}:${key}`,
      key,
      async () => {
        const current = await this.#getOwnedSubmission(input);
        if (current.status === "submitted") {
          const [event, form] = await Promise.all([
            this.#getEvent(input.tenantId, current.eventId),
            this.#getForm(input.tenantId, current.formId),
          ]);
          ensureEventFormMatch(event, form);
          ensureSubmissionSchemaVersion(current, form);
          await this.#effects.enqueueSubmissionConfirmation({
            submission: current,
            form,
            event,
            submissionTitle: submissionTitle(current),
            idempotencyKey: `${current.tenantId}:${current.id}:submission-confirmation`,
          });
          return {
            submission: current,
            receipt: {
              id: current.id,
              submissionId: current.id,
              version: current.version,
              submittedAt: current.submittedAt ?? current.updatedAt,
            },
            confirmationQueued: false,
          };
        }
        if (current.status !== "draft" && current.status !== "reopened") {
          throw new CfpError("INVALID_TRANSITION", "This submission cannot be submitted.");
        }
        if (current.version !== input.expectedVersion) {
          throw new CfpError("CONFLICT", "The submission has changed since it was loaded.");
        }
        const [event, form] = await Promise.all([
          this.#getEvent(input.tenantId, current.eventId),
          this.#getForm(input.tenantId, current.formId),
        ]);
        ensureEventFormMatch(event, form);
        ensureSubmissionSchemaVersion(current, form);
        if (input.formVersion !== undefined && input.formVersion !== current.formVersion) {
          throw new CfpError("CONFLICT", "The submission schema version is stale.", {
            expectedFormVersion: input.formVersion,
            currentFormVersion: current.formVersion,
          });
        }
        if (current.status !== "reopened") {
          if (form.status !== "published") {
            throw new CfpError("FORM_NOT_PUBLISHED", "The CFP form is not published.");
          }
          ensureOpen(event, this.#clock.now());
        }

        const sanitized = sanitizeSubmission(current, form);
        const issues = [
          ...validateReview(sanitized, form),
          ...validateFileRequestShapes(form, sanitized),
          ...(await this.#validateFileRequestAssets(form, sanitized)),
        ];
        if (issues.length > 0) {
          throw new CfpError("VALIDATION_FAILED", "The submission is not ready to submit.", {
            issues,
          });
        }
        const now = this.#clock.now().toISOString();
        const submitted = submissionSchema.parse({
          ...sanitized,
          version: current.version + 1,
          status: "submitted",
          submittedAt: now,
          updatedAt: now,
        });
        await this.#repository.saveSubmissionVersion(
          {
            submission: submitted,
            reason: "submitted",
            actorId: input.ownerAccountId,
            idempotencyKey: key,
          },
          current.version,
        );
        await this.#effects.enqueueSubmissionConfirmation({
          submission: submitted,
          form,
          event,
          submissionTitle: submissionTitle(submitted),
          idempotencyKey: `${submitted.tenantId}:${submitted.id}:submission-confirmation`,
        });
        return {
          submission: submitted,
          receipt: {
            id: submitted.id,
            submissionId: submitted.id,
            version: submitted.version,
            submittedAt: submitted.submittedAt ?? submitted.updatedAt,
          },
          confirmationQueued: true,
        };
      },
    );
  }

  async reopen(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    organizerId: string;
    expectedVersion: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<Submission> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    return this.#idempotency.run(
      `${input.tenantId}:cfp:reopen:${input.submissionId}:${key}`,
      key,
      async () => {
        const current = await this.#getSubmission(input.tenantId, input.submissionId);
        if (current.eventId !== input.eventId) {
          throw new CfpError("FORBIDDEN", "The submission does not belong to this event.");
        }
        if (current.status !== "submitted") {
          throw new CfpError("INVALID_TRANSITION", "Only a submitted record can be reopened.");
        }
        if (current.version !== input.expectedVersion) {
          throw new CfpError("CONFLICT", "The submission has changed since it was loaded.");
        }
        const reason = sanitizePlainText(input.reason);
        if (!reason) {
          throw new CfpError("VALIDATION_FAILED", "A reopen reason is required.");
        }
        const now = this.#clock.now().toISOString();
        const reopened = submissionSchema.parse({
          ...current,
          version: current.version + 1,
          status: "reopened",
          reopenedAt: now,
          updatedAt: now,
        });
        await this.#repository.saveSubmissionVersion(
          {
            submission: reopened,
            reason: "reopened",
            actorId: input.organizerId,
            idempotencyKey: key,
          },
          current.version,
          {
            tenantId: input.tenantId,
            eventId: current.eventId,
            submissionId: current.id,
            actorId: input.organizerId,
            action: "submission_reopened",
            reason,
            occurredAt: now,
          },
        );
        return reopened;
      },
    );
  }

  async withdraw(input: {
    tenantId: string;
    submissionId: string;
    ownerAccountId: string;
    expectedVersion: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<Submission> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    return this.#idempotency.run(
      `${input.tenantId}:cfp:withdraw:${input.submissionId}:${key}`,
      key,
      async () => {
        const current = await this.#getOwnedSubmission(input);
        if (current.status === "withdrawn") {
          return current;
        }
        if (current.finalDecisionAt) {
          throw new CfpError(
            "INVALID_TRANSITION",
            "A submission cannot be withdrawn after a final decision.",
          );
        }
        if (current.version !== input.expectedVersion) {
          throw new CfpError("CONFLICT", "The submission has changed since it was loaded.");
        }
        const reason = sanitizePlainText(input.reason);
        if (!reason) {
          throw new CfpError("VALIDATION_FAILED", "A withdrawal reason is required.");
        }
        const now = this.#clock.now().toISOString();
        const withdrawn = submissionSchema.parse({
          ...current,
          version: current.version + 1,
          status: "withdrawn",
          withdrawnAt: now,
          updatedAt: now,
        });
        await this.#repository.saveSubmissionVersion(
          {
            submission: withdrawn,
            reason: "withdrawn",
            actorId: input.ownerAccountId,
            idempotencyKey: key,
          },
          current.version,
          {
            tenantId: input.tenantId,
            eventId: current.eventId,
            submissionId: current.id,
            actorId: input.ownerAccountId,
            action: "submission_withdrawn",
            reason,
            occurredAt: now,
          },
        );
        return withdrawn;
      },
    );
  }

  async #getFileUploadContext(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    ownerAccountId: string;
    fieldKey: string;
    participantId?: string;
  }): Promise<CfpFileUploadContext> {
    const submission = await this.#getOwnedSubmission(input);
    if (submission.eventId !== input.eventId) {
      throw new CfpError("FORBIDDEN", "The submission does not belong to this event.");
    }
    const event = await this.#getEvent(input.tenantId, input.eventId);
    const form = await this.#getForm(input.tenantId, submission.formId);
    ensureEventFormMatch(event, form);
    ensureSubmissionSchemaVersion(submission, form);
    this.#ensureEditable(submission, event);
    const field = assetForFileField(form, input.fieldKey, input.participantId);
    const participantId = input.participantId;
    if (
      field.fileRequest?.owner === "participant" &&
      (participantId === undefined ||
        !submission.participants.some((participant) => participant.id === participantId))
    ) {
      throw new CfpError(
        "FORBIDDEN",
        "The file upload participant is not part of this submission.",
      );
    }
    return {
      event,
      form,
      submission,
      field,
      owner: field.fileRequest?.owner ?? "submission",
      ...(participantId === undefined ? {} : { participantId }),
    };
  }

  #validateFinalizedFileAsset(field: FormField, asset: CfpFileAsset): void {
    if (field.kind !== "file_request" || field.fileRequest === undefined) {
      throw new CfpError("VALIDATION_FAILED", "The requested field is not a file request.");
    }
    if (
      !Number.isSafeInteger(asset.sizeBytes) ||
      asset.sizeBytes <= 0 ||
      asset.sizeBytes > field.fileRequest.maxBytes
    ) {
      throw new CfpError("VALIDATION_FAILED", "The finalized upload exceeds the file size limit.");
    }
    if (
      !field.fileRequest.allowedMimeTypes.some((allowed) =>
        allowedMimeType(allowed, asset.contentType),
      )
    ) {
      throw new CfpError("VALIDATION_FAILED", "The finalized upload has an unsupported file type.");
    }
  }
  async #validateReusableFields(form: CfpForm): Promise<void> {
    const references = [...form.submissionFields, ...form.participantFields].flatMap((field) =>
      field.fieldRef === undefined ? [] : [{ field, reference: field.fieldRef }],
    );
    if (references.length === 0) {
      return;
    }
    const resolver = this.#repository.getReusableField;
    if (resolver === undefined) {
      throw new CfpError(
        "VALIDATION_FAILED",
        "Reusable field references require a tenant-scoped field resolver.",
      );
    }
    for (const { field, reference } of references) {
      const reusable = await resolver.call(
        this.#repository,
        form.tenantId,
        reference.id,
        reference.version,
      );
      if (
        reusable === null ||
        reusable.tenantId !== form.tenantId ||
        reusable.id !== reference.id ||
        reusable.version !== reference.version
      ) {
        throw new CfpError(
          "VALIDATION_FAILED",
          `Reusable field '${reference.id}' version ${reference.version} is not available in this tenant.`,
          {
            issues: [
              {
                path: `fields.${field.id}.fieldRef`,
                code: "invalid_reference",
                message: "The reusable field reference is not authorized for this tenant.",
              },
            ],
          },
        );
      }
    }
  }

  async #validateFileRequestAssets(form: CfpForm, submission: Submission): Promise<ReviewIssue[]> {
    const issues: ReviewIssue[] = [];

    const inspect = async (
      field: FormField,
      value: unknown,
      path: string,
      participantId: string | undefined,
    ): Promise<void> => {
      if (
        field.kind !== "file_request" ||
        field.fileRequest === undefined ||
        isEmptyAnswer(value)
      ) {
        return;
      }
      const parsed = fileRequestAnswerSchema.safeParse(value);
      if (!parsed.success) {
        return;
      }
      if (this.#fileAssets === undefined) {
        issues.push({
          path,
          code: "asset_unverifiable",
          message: `${field.label} must be verified by the private asset service.`,
        });
        return;
      }

      const owner = field.fileRequest.owner;
      const asset = await this.#fileAssets.getAsset({
        tenantId: submission.tenantId,
        eventId: submission.eventId,
        submissionId: submission.id,
        assetId: parsed.data.assetId,
        owner,
        ...(participantId === undefined ? {} : { participantId }),
      });
      if (asset === null || asset.assetId !== parsed.data.assetId) {
        issues.push({
          path,
          code: "invalid_file",
          message: `${field.label} does not reference an authorized asset.`,
        });
        return;
      }
      if (
        asset.tenantId !== submission.tenantId ||
        asset.eventId !== submission.eventId ||
        asset.submissionId !== submission.id ||
        asset.state !== "ready"
      ) {
        issues.push({
          path,
          code: "invalid_file",
          message: `${field.label} must reference a ready asset owned by this submission.`,
        });
        return;
      }
      if (asset.owner !== owner) {
        issues.push({
          path,
          code: "invalid_file",
          message: `${field.label} is owned by the wrong resource.`,
        });
        return;
      }
      if (
        owner === "participant" &&
        (participantId === undefined || asset.participantId !== participantId)
      ) {
        issues.push({
          path,
          code: "invalid_file",
          message: `${field.label} must reference an asset owned by this participant.`,
        });
        return;
      }
      if (owner === "submission" && asset.participantId !== undefined) {
        issues.push({
          path,
          code: "invalid_file",
          message: `${field.label} must reference an asset owned by this submission.`,
        });
        return;
      }
      if (
        !Number.isFinite(asset.sizeBytes) ||
        asset.sizeBytes < 0 ||
        asset.sizeBytes > field.fileRequest.maxBytes
      ) {
        issues.push({
          path,
          code: "file_size",
          message: `${field.label} exceeds the maximum allowed file size.`,
        });
      }
      if (
        !field.fileRequest.allowedMimeTypes.some((allowed) =>
          allowedMimeType(allowed, asset.contentType),
        )
      ) {
        issues.push({
          path,
          code: "file_type",
          message: `${field.label} has an unsupported file type.`,
        });
      }
    };

    for (const field of form.submissionFields) {
      await inspect(field, submission.answers[field.key], `answers.${field.key}`, undefined);
    }
    for (const [index, participant] of submission.participants.entries()) {
      for (const field of form.participantFields) {
        await inspect(
          field,
          participant.answers[field.key],
          `participants.${index}.answers.${field.key}`,
          participant.id,
        );
      }
    }
    return issues;
  }

  async #getEvent(tenantId: string, eventId: string): Promise<EventCfp> {
    const event = await this.#repository.getEvent(tenantId, eventId);
    if (!event) {
      throw new CfpError("NOT_FOUND", "The event was not found.");
    }
    ensureTenant(event.tenantId, tenantId);
    return event;
  }

  async #getEventBySlug(tenantId: string, eventSlug: string): Promise<EventCfp> {
    const event = await this.#repository.getEventBySlug(tenantId, eventSlug);
    if (!event) {
      throw new CfpError("NOT_FOUND", "The event was not found.");
    }
    ensureTenant(event.tenantId, tenantId);
    return event;
  }

  async #getForm(tenantId: string, formId: string): Promise<CfpForm> {
    const form = await this.#repository.getForm(tenantId, formId);
    if (!form) {
      throw new CfpError("NOT_FOUND", "The CFP form was not found.");
    }
    ensureTenant(form.tenantId, tenantId);
    return form;
  }

  async #getSubmission(tenantId: string, submissionId: string): Promise<Submission> {
    const submission = await this.#repository.getSubmission(tenantId, submissionId);
    if (!submission) {
      throw new CfpError("NOT_FOUND", "The submission was not found.");
    }
    ensureTenant(submission.tenantId, tenantId);
    return submission;
  }

  async #getOwnedSubmission(input: {
    tenantId: string;
    eventId?: string;
    submissionId: string;
    ownerAccountId: string;
  }): Promise<Submission> {
    const submission = await this.#getSubmission(input.tenantId, input.submissionId);
    if (submission.ownerAccountId !== input.ownerAccountId) {
      throw new CfpError("FORBIDDEN", "The submission is not owned by this account.");
    }
    if (input.eventId !== undefined && submission.eventId !== input.eventId) {
      throw new CfpError("FORBIDDEN", "The submission does not belong to this event.");
    }
    return submission;
  }

  #ensureEditable(submission: Submission, event: EventCfp): void {
    if (submission.status === "reopened") {
      return;
    }
    if (submission.finalDecisionAt !== undefined) {
      throw new CfpError(
        "INVALID_TRANSITION",
        "A decided submission must be explicitly reopened before it can be edited.",
      );
    }
    if (submission.status !== "draft" && submission.status !== "submitted") {
      throw new CfpError(
        "INVALID_TRANSITION",
        "Only draft, submitted, or explicitly reopened submissions can be edited.",
      );
    }
    ensureOpen(event, this.#clock.now());
  }
}
