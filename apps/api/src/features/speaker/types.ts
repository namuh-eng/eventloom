export const speakerTaskStatuses = [
  "not_started",
  "in_progress",
  "submitted",
  "needs_changes",
  "completed",
  "waived",
  "overdue",
  "reopened",
] as const;

export type SpeakerTaskStatus = (typeof speakerTaskStatuses)[number];

export type SpeakerTaskType = "form" | "upload" | "action";
export type SpeakerAssetKind = "headshot" | "slides" | "supporting_file";
export type SpeakerAssetState = "pending_upload" | "ready" | "rejected";
export type SpeakerAssetReviewState = "approved" | "needs_changes";
export type SpeakerParticipantSourceType = "cfp" | "manual" | "csv" | "crm";
export type SpeakerParticipantIdentityState = "resolved" | "ambiguous";

export interface ResolveEventParticipantInput {
  organizationId: string;
  eventId: string;
  sourceType: SpeakerParticipantSourceType;
  sourceId: string;
  explicitParticipantId?: string;
  normalizedEmail?: string;
  createParticipantId: string;
}

export type SpeakerParticipantResolution =
  | {
      state: "resolved";
      participantId: string;
      submissionIds: readonly string[];
      created: boolean;
    }
  | {
      state: "ambiguous";
      candidateParticipantIds: readonly string[];
    };

export type SpeakerTaskSubject =
  | { type: "participant"; participantId: string }
  | { type: "session"; participantId: string; sessionId: string };
export type SpeakerTaskAssignmentSubject =
  | { type: "participant" }
  | { type: "session"; sessionId: string };
export type SpeakerSubmissionStatus =
  | "draft"
  | "submitted"
  | "under_review"
  | "accepted"
  | "declined"
  | "withdrawn";

export const speakerPortalCapabilities = [
  "profile-self",
  "submission-edit",
  "roster-manage",
  "task-response",
  "asset-read",
  "asset-write",
  "asset-comment",
  "resource-read",
] as const;

export type SpeakerPortalCapability = (typeof speakerPortalCapabilities)[number];

export interface SpeakerEventTemporalContext {
  organizationId: string;
  eventId: string;
  timeZone: string;
  startsAt: string;
  endsAt: string;
}

export interface SpeakerPortalContext {
  id: string;
  organizationId?: string;
  eventId: string;
  name: string;
  slug?: string;
  capabilities: readonly SpeakerPortalCapability[];
  submissionIds: readonly string[];
  participantIds: readonly string[];
  primaryParticipantId?: string;
  temporalContext?: SpeakerEventTemporalContext;
}

export interface SpeakerPortalContextScopeProjection {
  readonly context: SpeakerPortalContext;
  readonly scope: SpeakerAccessScope;
  /** Authoritative speaker profile identities represented by current account grants. */
  readonly speakerProfileIds: readonly string[];
}

export interface SpeakerRosterMember {
  participantId: string;
  displayName: string;
  email: string | null;
  role: "primary" | "co_speaker";
  status: "pending" | "active" | "revoked";
  capabilities: {
    edit: boolean;
    remove: boolean;
  };
}

export interface SpeakerRosterEnvelope {
  organizationId: string;
  eventId: string;
  submissionId: string;
  capabilities: {
    manage: boolean;
    invite: boolean;
  };
  members: readonly SpeakerRosterMember[];
}

export interface SpeakerAccessScope {
  /** Airtable/D1 tenant authority; absent only for legacy in-memory fixtures. */
  tenantId?: string;
  submissionIds: readonly string[];
  participantIds: readonly string[];
  capabilities?: readonly SpeakerPortalCapability[];
  capabilitiesByParticipant?: Readonly<Record<string, readonly SpeakerPortalCapability[]>>;
  primaryParticipantId?: string;
  role?: "speaker" | "organizer" | "owner" | "admin";
  /** True only when the adapter has established event-qualified organizer authority. */
  organizer?: boolean;
}

export interface SpeakerSubmission {
  /** Authoritative organization identity when the storage adapter exposes it. */
  tenantId?: string;
  id: string;
  eventId: string;
  title: string;
  status: SpeakerSubmissionStatus;
  participantIds: readonly string[];
  participants?: readonly {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    role: "primary" | "co_author";
  }[];
  updatedAt: string;
  formId?: string;
  version?: number;
  primaryParticipantId?: string;
  closeAt?: string;
  answers?: Readonly<Record<string, unknown>>;
}

export interface SpeakerTravelLogistics {
  travelRequired: boolean;
  arrivalAt: string | null;
  departureAt: string | null;
  accommodation: string;
  dietaryRequirements: string;
  accessibilityNeeds: string;
  travelNotes: string;
}

export interface SpeakerProfile {
  socialLinks?: Readonly<Record<string, string>>;
  email?: string;
  /** Alias accepted by adapters that expose social profiles under `social`. */
  social?: Readonly<Record<string, string>>;
  sourceType?: SpeakerParticipantSourceType;
  sourceId?: string;
  id: string;
  eventId: string;
  participantId: string;
  displayName: string;
  jobTitle?: string;
  company?: string;
  status?: string;
  travelLogistics?: SpeakerTravelLogistics;
  biography: string;
  headshotAssetId?: string;
  version: number;
  updatedAt: string;
}

export interface SpeakerTask {
  /** Stable identity shared by every per-speaker row created from one task assignment request. */
  definitionId?: string;
  /** Authoritative organization identity when the storage adapter exposes it. */
  tenantId?: string;
  /** Optional MIME policy for organizer-created file requests. */
  allowedMimeTypes?: readonly string[];
  /** Canonical byte limit for organizer-created file requests. */
  maxBytes?: number;
  /** UI-compatible alias for maxBytes. */
  maxSizeBytes?: number;
  /** Explicit participant or accepted program-session subject. */
  subject: SpeakerTaskSubject;
  participantName?: string;
  /** Accepted program-session title used as the event-scoped session label in organizer projections. */
  sessionTitle?: string;
  id: string;
  eventId: string;
  participantId: string;
  type: SpeakerTaskType;
  owner: "speaker" | "organizer";
  title: string;
  description?: string;
  instructions?: string;
  status: SpeakerTaskStatus;
  dueAt?: string;
  dueDate?: string;
  dependencyIds: readonly string[];
  reminderOffsetsMinutes: readonly number[];
  acceptedAssetKinds?: readonly SpeakerAssetKind[];
  replacementBaselineAssetId?: string;
  version: number;
  updatedAt: string;
}

export interface SpeakerTaskTransition {
  id: string;
  eventId: string;
  taskId: string;
  participantId: string;
  actorAccountId: string;
  fromStatus: SpeakerTaskStatus;
  toStatus: SpeakerTaskStatus;
  note?: string;
  occurredAt: string;
}

export interface SpeakerAsset {
  reviewState?: SpeakerAssetReviewState;
  reviewNote?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewVersion?: number;
  /** Explicit family pointers; selection must never depend on timestamps or row order. */
  latestVersionId?: string;
  currentVersionId?: string;
  approvedVersionId?: string;
  releasedVersionId?: string;
  id: string;
  /** Server-owned tenant binding. Legacy records may not have this field. */
  tenantId?: string;
  eventId: string;
  sessionId?: string;
  participantId: string;
  /** Organizer-only display label projected from the accepted event roster. */
  participantName?: string;
  /** Internal authenticated account that created this immutable asset version. */
  uploaderAccountId?: string;
  /** Upload-time display label snapshot safe for authorized organizer projection. */
  uploaderLabel?: string;
  /** Accepted program-session title projected for organizer file-library grouping. */
  sessionTitle?: string;
  taskId?: string;
  kind: SpeakerAssetKind;
  /** Internal R2 key. API responses must remove this field before serialization. */
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  state: SpeakerAssetState;
  createdAt: string;
  /** Immutable version lineage metadata. */
  version?: number;
  versionFamilyId?: string;
  supersedesAssetId?: string;
  /** Stable identifier reserved for future asset comments. */
  commentThreadId?: string;
  /** Stable version identifier used by version-specific comments. */
  versionId?: string;
  rejectionReason?: string;
  finalizedAt?: string;
}
export interface SpeakerRosterEntry {
  id: string;
  eventId: string;
  /** Accepted CFP submission identity; absent for organizer-created profile-only speakers. */
  submissionId?: string;
  participantId: string;
  displayName: string;
  email?: string;
  jobTitle?: string;
  company?: string;
  biography?: string;
  socialLinks?: Readonly<Record<string, string>>;
  travelLogistics?: SpeakerTravelLogistics;
  headshotAssetId?: string;
  sourceType?: SpeakerParticipantSourceType;
  sourceId?: string;
  role: "primary" | "co_speaker";
  status: "pending" | "active" | "revoked";
  workflowStatus?: string;
  /** Organizer workflow value; `workflowStatus` remains the server admission discriminator. */
  organizerStatus?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Server-only actor binding used for audit projection. */
  authorAccountId?: string;
}
export interface SpeakerWorkspaceSession {
  sessionId: string;
  title: string;
  status: string;
  version: number;
}

export interface SpeakerCanonicalSession extends SpeakerWorkspaceSession {
  participantId: string;
}

export interface SpeakerWorkspaceAsset {
  assetId: string;
  eventId: string;
  participantId: string;
  sessionId: string | null;
  taskId: string | null;
  kind: SpeakerAssetKind;
  fileName: string;
  contentType: string;
  byteSize: number;
  status: "pending" | "ready" | "rejected";
  uploadedAt: string;
  finalizedAt: string | null;
  version: number;
  versionFamilyId: string;
  supersedesAssetId: string | null;
  commentThreadId: string;
  reviewState: SpeakerAssetReviewState | null;
  reviewNote: string | null;
  latestVersionId: string | null;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  releasedVersionId: string | null;
  downloadUrl: string | null;
}

export interface SpeakerWorkspaceTask {
  taskId: string;
  definitionId: string;
  participantId: string;
  title: string;
  description: string;
  type: "general" | "action" | "file_request";
  dueAt: string | null;
  status: string;
  version: number;
  completedAt: string | null;
  sessionId: string | null;
  latestAssetId: string | null;
}

export interface SpeakerWorkspaceTaskSummary {
  total: number;
  completed: number;
  overdue: number;
}

export interface SpeakerWorkspaceRecord {
  eventId: string;
  participantId: string;
  displayName: string;
  email: string;
  jobTitle: string;
  company: string;
  biography: string;
  socialLinks: Readonly<Record<string, string>>;
  travelLogistics: SpeakerTravelLogistics;
  headshotAssetId: string | null;
  status: string;
  sessions: readonly SpeakerWorkspaceSession[];
  taskSummary: SpeakerWorkspaceTaskSummary;
  assets: readonly SpeakerWorkspaceAsset[];
  version: number;
  updatedAt: string;
}

export interface SpeakerWorkspaceRoster {
  organizationId: string;
  eventId: string;
  temporalContext?: SpeakerEventTemporalContext;
  speakers: readonly SpeakerWorkspaceRecord[];
}

export interface SpeakerImportRow {
  rowNumber: number;
  displayName: string;
  email: string;
  jobTitle: string;
  company: string;
  biography: string;
  socialLinks: Readonly<Record<string, string>>;
  status?: string;
}

export interface SpeakerImportIssue {
  rowNumber: number;
  field?: string;
  message: string;
}

export interface SpeakerImportPreview {
  /** Durable server-issued preview identity. Required by the canonical D1 commit path. */
  previewId?: string;
  /** Digest of the exact validated source payload. */
  sourceDigest?: string;
  /** Canonical profile-set revision observed when the preview was issued. */
  rosterRevision?: number;
  validRows: readonly SpeakerImportRow[];
  invalidRows: readonly SpeakerImportIssue[];
}

export interface SaveOrganizerSpeakerImportPreviewCommand {
  organizationId: string;
  eventId: string;
  accountId: string;
  previewId: string;
  sourceDigest: string;
  rows: readonly SpeakerImportRow[];
  createdAt: string;
}

export interface CommitOrganizerSpeakerImportCommand {
  organizationId: string;
  eventId: string;
  accountId: string;
  previewId: string;
  sourceDigest?: string;
  idempotencyKey: string;
  participantIds?: readonly string[];
  committedAt: string;
}

export interface OrganizerSpeakerAggregateResult {
  participantIds: readonly string[];
  replayed: boolean;
}

export interface UpsertOrganizerSpeakerAggregateCommand {
  organizationId: string;
  eventId: string;
  accountId: string;
  participantId: string;
  profileId: string;
  displayName: string;
  email: string;
  jobTitle: string;
  company: string;
  biography: string;
  socialLinks: Readonly<Record<string, string>>;
  travelLogistics: SpeakerTravelLogistics;
  status: string;
  sourceType: SpeakerParticipantSourceType;
  sourceId: string;
  expectedVersion: number | null;
  idempotencyKey?: string;
  sourceDigest?: string;
  updatedAt: string;
}

export interface SpeakerInvitationPreview {
  participantId: string;
  recipientEmail: string;
  state: "ready" | "blocked";
}

export interface SpeakerInvitationDeliveryInput {
  organizationId: string;
  eventId: string;
  participantId: string;
  recipientEmail: string;
  templateId: string;
  idempotencyKey: string;
  actorAccountId: string;
}

export interface SpeakerInvitationDeliveryReceipt {
  id?: string;
  status?: "queued" | "sent" | "failed";
  queued?: boolean;
  duplicate?: boolean;
}

export interface SpeakerInvitationRecipientResult {
  participantId: string;
  recipientEmail: string;
  status: "queued" | "sent" | "failed" | "duplicate";
  receiptId: string | null;
}

export interface SpeakerInvitationResult {
  organizationId: string;
  eventId: string;
  idempotencyKey: string;
  status: "queued" | "sent" | "failed" | "duplicate";
  duplicate: boolean;
  recipients: readonly SpeakerInvitationRecipientResult[];
}

export interface SpeakerTaskAssignmentInput {
  organizationId: string;
  eventId: string;
  accountId: string;
  title: string;
  description: string;
  dueAt: string;
  assignments: readonly {
    participantId: string;
    subject: SpeakerTaskAssignmentSubject;
  }[];
}

export interface SpeakerAssetComment {
  id: string;
  eventId: string;
  assetId: string;
  versionId: string;
  body: string;
  authorLabel: string;
  createdAt: string;
  updatedAt?: string;
  version?: number;
  /** Never serialize this server-only field. */
  authorAccountId?: string;
}
export interface SpeakerTaskCreateInput {
  eventId: string;
  accountId: string;
  type: SpeakerTaskType;
  title: string;
  description?: string;
  instructions?: string;
  dueAt?: string;
  dueDate?: string;
  allowedMimeTypes?: readonly string[];
  maxBytes?: number;
  maxSizeBytes?: number;
  acceptedAssetKinds?: readonly SpeakerAssetKind[];
  dependencyIds?: readonly string[];
  reminderOffsetsMinutes?: readonly number[];
  decisionFence?: SpeakerDecisionWriteFence;
  assignments: readonly {
    participantId: string;
    subject: SpeakerTaskAssignmentSubject;
  }[];
}

export interface SpeakerTaskUpdateInput {
  eventId: string;
  accountId: string;
  taskId: string;
  expectedVersion: number;
  title?: string;
  description?: string;
  instructions?: string;
  dueAt?: string;
  dueDate?: string;
  allowedMimeTypes?: readonly string[];
  maxBytes?: number;
  maxSizeBytes?: number;
  acceptedAssetKinds?: readonly SpeakerAssetKind[];
  dependencyIds?: readonly string[];
  reminderOffsetsMinutes?: readonly number[];
  status?: SpeakerTaskStatus;
}

export interface SpeakerTaskRepositoryAudit {
  id: string;
  action: "speaker_task.reminder_offsets_updated";
  previousReminderOffsetsMinutes: readonly number[];
}

export interface SpeakerTaskRepositoryCommand {
  task: SpeakerTask;
  expectedVersion: number | null;
  actorAccountId: string;
  audit?: SpeakerTaskRepositoryAudit;
  decisionFence?: SpeakerDecisionWriteFence;
}

export type SpeakerDeliverableStatus = SpeakerTaskStatus | "pending" | "uploaded";

export interface SpeakerDeliverableRow {
  organizationId: string;
  eventId: string;
  task: SpeakerTask;
  participantId: string;
  participantName?: string;
  assets: readonly SpeakerAsset[];
  currentAsset?: SpeakerAsset;
  status: SpeakerDeliverableStatus;
}

export interface SpeakerDeliverablesQuery {
  participantId?: string;
  taskId?: string;
  status?: SpeakerDeliverableStatus | "incomplete" | "pending" | "all";
}

export interface SpeakerDeliverablesMatrix {
  organizationId: string;
  eventId: string;
  temporalContext?: SpeakerEventTemporalContext;
  items: readonly SpeakerDeliverableRow[];
  total: number;
  filters: SpeakerDeliverablesQuery;
}
export interface SpeakerDeliverablesExportInput {
  eventId: string;
  accountId: string;
  assetIds?: readonly string[];
  taskIds?: readonly string[];
  participantIds?: readonly string[];
  status?: SpeakerDeliverableStatus | "incomplete" | "all";
}

export interface SpeakerDeliverablesExportManifestEntry {
  assetId: string;
  participantId: string;
  participantName: string | null;
  sessionId: string | null;
  sessionTitle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  status: SpeakerDeliverableStatus;
  version: number;
  taskVersion: number | null;
  fileName: string;
  path: string;
  contentType: string;
  sizeBytes: number;
}

export interface SpeakerDeliverablesExportManifest {
  format: "speaker-deliverables-export";
  version: 1;
  organizationId: string;
  eventId: string;
  entries: readonly SpeakerDeliverablesExportManifestEntry[];
}

export interface SpeakerDeliverablesExportResult {
  fileName: string;
  contentType: "application/zip";
  sizeBytes: number;
  body: Uint8Array;
  manifest: SpeakerDeliverablesExportManifest;
}

export interface SpeakerAssetReviewInput {
  eventId: string;
  accountId: string;
  assetId: string;
  state: SpeakerAssetReviewState;
  note?: string;
  expectedVersion?: number;
  release?: boolean;
}

export interface ReviewLinkedUploadTaskCommand {
  eventId: string;
  taskId: string;
  expectedVersion: number;
  fromStatus: SpeakerTaskStatus;
  toStatus: "needs_changes";
  baselineAssetId: string;
  transition?: SpeakerTaskTransition;
}

export interface SpeakerAssetReviewCommand {
  eventId: string;
  assetId: string;
  state: SpeakerAssetReviewState;
  note?: string;
  expectedVersion: number;
  reviewedAt: string;
  reviewedBy: string;
  release: boolean;
  /** Persisted atomically with the review by repositories that support transactional audit. */
  audit?: SpeakerAssetAuditEntry;
  /** Optional task return persisted atomically with the exact-version review. */
  returnTask?: ReviewLinkedUploadTaskCommand;
}

export interface CreatePendingSpeakerAssetVersionCommand {
  asset: SpeakerAsset;
  expectedLatestAssetId: string;
  expectedLatestVersion: number;
  idempotencyKey: string;
  requestDigest: string;
}

export interface SpeakerAssetAuditEntry {
  id: string;
  organizationId: string;
  eventId: string;
  assetId: string;
  action:
    | "approved"
    | "needs_changes"
    | "commented"
    | "download_authorized"
    | "downloaded"
    | "exported";
  actorAccountId: string;
  note?: string;
  occurredAt: string;
  version: number;
  requesterKind?: PrivateDownloadRequesterKind;
  capabilityId?: string;
  attributionBasis?: "authenticated_requester" | "issuance_principal";
}

export interface SpeakerOrganizerProfileInput {
  eventId: string;
  accountId: string;
  participantId: string;
  biography?: string;
  socialLinks?: Readonly<Record<string, string>>;
  social?: Readonly<Record<string, string>>;
  headshotAssetId?: string | null;
  expectedVersion: number;
}

export interface SpeakerContentRecord {
  id: string;
  eventId: string;
  tenantId?: string;
  entityType: "session" | "speaker";
  entityId: string;
  title?: string;
  description?: string;
  abstract?: string;
  biography?: string;
  socialLinks?: Readonly<Record<string, string>>;
  headshotAssetId?: string;
  status?: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface SpeakerContentHistoryEntry {
  id: string;
  eventId: string;
  entityType: "session" | "speaker";
  entityId: string;
  action: "created" | "updated" | "restored" | "approved" | "needs_changes";
  version: number;
  actorAccountId: string;
  actorLabel?: string;
  occurredAt: string;
  snapshot: SpeakerContentRecord;
}

export interface SpeakerContentUpdateInput {
  eventId: string;
  accountId: string;
  entityType: "session" | "speaker";
  entityId: string;
  expectedVersion: number;
  title?: string;
  description?: string;
  abstract?: string;
  biography?: string;
  socialLinks?: Readonly<Record<string, string>>;
  headshotAssetId?: string | null;
  status?: string;
}

export interface SpeakerContentRestoreInput {
  eventId: string;
  accountId: string;
  entityType: "session" | "speaker";
  entityId: string;
  version: number;
  expectedVersion?: number;
}

export interface SpeakerReminderTask {
  taskId: string;
  title: string;
  dueAt?: string;
  participantId: string;
  /**
   * The scheduler cadence window captured when the organizer preview was
   * reserved. It lets transactional reminders share the scheduler's
   * idempotency identity without recomputing mutable task state on retry.
   */
  cadenceWindow?: string;
}

export interface SpeakerReminderRecipient {
  participantId: string;
  displayName: string;
  email?: string;
  taskIds: readonly string[];
  tasks: readonly SpeakerReminderTask[];
}

export interface SpeakerReminderPreview {
  organizationId: string;
  eventId: string;
  recipients: readonly SpeakerReminderRecipient[];
  recipientIds: readonly string[];
  taskIds: readonly string[];
}

export interface SpeakerReminderQueueInput {
  eventId: string;
  accountId: string;
  taskIds?: readonly string[];
  recipientIds?: readonly string[];
  idempotencyKey?: string;
}

export interface SpeakerReminderRecipientResult {
  participantId: string;
  status: "queued" | "failed" | "duplicate";
  receiptId: string | null;
}

export interface SpeakerReminderQueueResult {
  organizationId: string;
  eventId: string;
  idempotencyKey: string;
  queued: boolean;
  duplicate: boolean;
  sentCount: number;
  failedCount: number;
  duplicateCount: number;
  recipientIds: readonly string[];
  receipts: readonly SpeakerReminderRecipientResult[];
}

export interface SpeakerReminderDeliveryInput {
  organizationId: string;
  eventId: string;
  recipient: SpeakerReminderRecipient;
  idempotencyKey: string;
  actorAccountId: string;
}

export interface SpeakerReminderDeliveryReceipt {
  id?: string;
  status?: "queued" | "failed";
  queued?: boolean;
  duplicate?: boolean;
}

export interface SpeakerReminderDelivery {
  enqueue?(input: SpeakerReminderDeliveryInput): Promise<SpeakerReminderDeliveryReceipt>;
  queue?(input: SpeakerReminderDeliveryInput): Promise<SpeakerReminderDeliveryReceipt>;
  enqueueReminder?(input: SpeakerReminderDeliveryInput): Promise<SpeakerReminderDeliveryReceipt>;
  enqueueDeliverableReminder?(
    input: SpeakerReminderDeliveryInput,
  ): Promise<SpeakerReminderDeliveryReceipt>;
  enqueueInvitation?(
    input: SpeakerInvitationDeliveryInput,
  ): Promise<SpeakerInvitationDeliveryReceipt>;
  queueInvitation?(
    input: SpeakerInvitationDeliveryInput,
  ): Promise<SpeakerInvitationDeliveryReceipt>;
}

export type SpeakerTaskFormFieldType =
  | "text"
  | "textarea"
  | "rich_text"
  | "email"
  | "url"
  | "number"
  | "date"
  | "select"
  | "multiselect"
  | "multi_select"
  | "checkbox"
  | "boolean"
  | "file_request";

export interface SpeakerTaskFormField {
  id: string;
  key?: string;
  name?: string;
  label: string;
  type?: SpeakerTaskFormFieldType;
  kind?: SpeakerTaskFormFieldType;
  required?: boolean;
  description?: string;
  helpText?: string;
  placeholder?: string;
  options?: readonly (string | { value: string; label: string })[];
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
}

export interface SpeakerTaskFormDefinition {
  id: string;
  eventId: string;
  taskId: string;
  title: string;
  description?: string;
  fields: readonly SpeakerTaskFormField[];
  version: number;
  published: boolean;
  updatedAt: string;
}

export interface SpeakerTaskForm {
  taskId: string;
  definitionVersion: number;
  title: string;
  description: string;
  status: SpeakerTaskStatus;
  fields: readonly {
    id: string;
    label: string;
    type: Exclude<SpeakerTaskFormFieldType, "multi_select">;
    required: boolean;
    options: readonly { value: string; label: string }[];
  }[];
  latestResponse: SpeakerTaskResponse | null;
}

export type SpeakerFormAnswer = string | number | boolean | readonly string[] | null;

export type SpeakerTaskResponseStatus = "draft" | "submitted" | "needs_changes" | "reopened";

export interface SpeakerTaskResponseRecord {
  id: string;
  eventId: string;
  taskId: string;
  participantId: string;
  definitionVersion: number;
  answers: Readonly<Record<string, SpeakerFormAnswer>>;
  status: SpeakerTaskResponseStatus;
  version: number;
  updatedAt: string;
  feedback?: string;
  submittedAt?: string;
}

export interface SpeakerTaskResponse {
  responseId: string;
  definitionVersion: number;
  answers: Readonly<Record<string, SpeakerFormAnswer>>;
  submittedAt: string | null;
  status: SpeakerTaskResponseStatus;
  organizerFeedback: string | null;
}

export interface SpeakerTaskResponseEnvelope {
  organizationId: string;
  eventId: string;
  taskId: string;
  participantId: string;
  latestResponse: SpeakerTaskResponse | null;
  history: readonly SpeakerTaskResponse[];
}

export interface SpeakerEventResource {
  id: string;
  eventId: string;
  title: string;
  summary?: string;
  html?: string;
  url?: string;
  order: number;
  updatedAt: string;
}

export interface SpeakerWikiPage extends SpeakerEventResource {
  slug?: string;
}

export interface RepositoryMutationResult<T> {
  ok: true;
  value: T;
}

export interface RepositoryMutationFailure {
  ok: false;
  reason: "not_found" | "version_conflict" | "invalid_state";
}

export type RepositoryResult<T> = RepositoryMutationResult<T> | RepositoryMutationFailure;

export interface UpdateBiographyCommand {
  eventId: string;
  participantId: string;
  biography: string;
  expectedVersion: number;
  updatedAt: string;
}

export interface TransitionSpeakerTaskCommand {
  eventId: string;
  taskId: string;
  expectedVersion: number;
  fromStatus: SpeakerTaskStatus;
  toStatus: SpeakerTaskStatus;
  /** Repository-only requirement for a returned upload replacement. */
  replacementBaselineAssetId?: string;
  transition: SpeakerTaskTransition;
}

export interface FinalizeSpeakerAssetCommand {
  eventId: string;
  assetId: string;
  state: Extract<SpeakerAssetState, "ready" | "rejected">;
  finalizedAt: string;
  rejectionReason?: string;
  latestVersionId: string;
  currentVersionId?: string;
}
export interface SpeakerOrganizerAccessScope {
  tenantId: string;
  eventId: string;
  role: "owner" | "admin";
  submissionIds: readonly string[];
  participantIds: readonly string[];
}
export interface SpeakerSessionAuthority {
  getSession(
    organizationId: string,
    eventId: string,
    sessionId: string,
  ): Promise<import("../sessions/types").Session | null>;
}

export interface UpdateSpeakerProfileCommand {
  eventId: string;
  participantId: string;
  displayName?: string;
  email?: string;
  jobTitle?: string;
  company?: string;
  status?: string;
  biography?: string;
  socialLinks?: Readonly<Record<string, string>>;
  headshotAssetId?: string | null;
  travelLogistics?: SpeakerTravelLogistics;
  expectedVersion: number;
  updatedAt: string;
  actorAccountId: string;
}

export interface UpdateSpeakerContentCommand extends SpeakerContentUpdateInput {
  updatedAt: string;
}

export interface RestoreSpeakerContentVersionCommand extends SpeakerContentRestoreInput {
  updatedAt: string;
}

export interface SpeakerReminderRecord {
  id: string;
  organizationId: string;
  eventId: string;
  idempotencyKey: string;
  taskIds: readonly string[];
  recipientIds: readonly string[];
  receipts: readonly SpeakerReminderRecipientResult[];
  createdAt: string;
  actorAccountId: string;
}

export interface SpeakerOrganizerReadResources {
  profiles?: boolean;
  tasks?: boolean;
  assets?: boolean;
}

export interface SpeakerOrganizerReadModel {
  scope: SpeakerOrganizerAccessScope;
  submissions: readonly SpeakerSubmission[];
  roster: readonly SpeakerRosterEntry[];
  profiles: readonly SpeakerProfile[];
  tasks: readonly SpeakerTask[];
  assets: readonly SpeakerAsset[];
  canonicalSessions: readonly SpeakerCanonicalSession[];
}

export interface OrganizationQualifiedSpeakerSubmission extends SpeakerSubmission {
  /** Authoritative organization identity read from the repository record. */
  tenantId: string;
}

export interface OrganizationQualifiedSpeakerTask extends SpeakerTask {
  /** Authoritative organization identity read from the repository record. */
  tenantId: string;
}

export interface SpeakerRepository {
  getAccessScope(eventId: string, accountId: string): Promise<SpeakerAccessScope>;
  /** Resolves one verified account for an account-bound event invitation. */
  resolveVerifiedInvitationRecipient?(email: string): Promise<{
    userId: string;
    normalizedEmail: string;
  } | null>;
  /** Organizer authority is event-qualified and must never be inferred from a participant grant. */
  getOrganizerAccessScope?(
    eventId: string,
    accountId: string,
  ): Promise<SpeakerOrganizerAccessScope | null>;
  getAccountDisplayName?(accountId: string): Promise<string | null>;
  listSubmissions(eventId: string, submissionIds: readonly string[]): Promise<SpeakerSubmission[]>;
  getOrganizerReadModel?(
    eventId: string,
    accountId: string,
    resources: SpeakerOrganizerReadResources,
  ): Promise<SpeakerOrganizerReadModel | null>;
  getSubmission(eventId: string, submissionId: string): Promise<SpeakerSubmission | null>;
  listProfiles(eventId: string, participantIds: readonly string[]): Promise<SpeakerProfile[]>;
  createProfile?(
    profile: SpeakerProfile,
    decisionFence?: SpeakerDecisionWriteFence,
  ): Promise<RepositoryResult<SpeakerProfile>>;
  getProfile(eventId: string, participantId: string): Promise<SpeakerProfile | null>;
  updateBiography(command: UpdateBiographyCommand): Promise<RepositoryResult<SpeakerProfile>>;
  updateProfile?(command: UpdateSpeakerProfileCommand): Promise<RepositoryResult<SpeakerProfile>>;
  resolveEventParticipant?(
    input: ResolveEventParticipantInput,
  ): Promise<SpeakerParticipantResolution>;
  ensureOrganizerSpeakerProfile?(input: {
    organizationId: string;
    eventId: string;
    participantId: string;
    displayName: string;
    email: string;
    jobTitle: string;
    company: string;
    biography: string;
    socialLinks: Readonly<Record<string, string>>;
    travelLogistics?: SpeakerTravelLogistics;
    status: string;
    updatedAt: string;
    sourceType?: SpeakerParticipantSourceType;
    sourceId?: string;
  }): Promise<SpeakerProfile>;
  listTasks(eventId: string, participantIds: readonly string[]): Promise<SpeakerTask[]>;
  createTask?(command: SpeakerTaskRepositoryCommand): Promise<RepositoryResult<SpeakerTask>>;
  createSpeakerTask?(command: SpeakerTaskRepositoryCommand): Promise<RepositoryResult<SpeakerTask>>;
  updateTask?(command: SpeakerTaskRepositoryCommand): Promise<RepositoryResult<SpeakerTask>>;
  updateSpeakerTask?(command: SpeakerTaskRepositoryCommand): Promise<RepositoryResult<SpeakerTask>>;
  getTask(eventId: string, taskId: string): Promise<SpeakerTask | null>;
  getTasksByIds(eventId: string, taskIds: readonly string[]): Promise<SpeakerTask[]>;
  transitionTask(
    command: TransitionSpeakerTaskCommand,
  ): Promise<RepositoryResult<{ task: SpeakerTask; transition: SpeakerTaskTransition }>>;
  createPendingAsset(asset: SpeakerAsset): Promise<SpeakerAsset>;
  createPendingAssetVersion?(
    command: CreatePendingSpeakerAssetVersionCommand,
  ): Promise<RepositoryResult<SpeakerAsset>>;
  getAsset(eventId: string, assetId: string): Promise<SpeakerAsset | null>;
  /** Optional while legacy/local repositories are migrated. */
  listAssets?(eventId: string, participantIds: readonly string[]): Promise<SpeakerAsset[]>;
  /** Finalization is a state transition; metadata remains immutable. */
  finalizeAsset?(command: FinalizeSpeakerAssetCommand): Promise<RepositoryResult<SpeakerAsset>>;
  reviewAsset?(command: SpeakerAssetReviewCommand): Promise<RepositoryResult<SpeakerAsset>>;
  updateAssetReview?(command: SpeakerAssetReviewCommand): Promise<RepositoryResult<SpeakerAsset>>;
  appendAssetAudit?(entry: SpeakerAssetAuditEntry): Promise<void>;
  listAssetAudit?(eventId: string, assetId: string): Promise<SpeakerAssetAuditEntry[]>;
  listPortalContexts?(accountId: string): Promise<SpeakerPortalContext[]>;
  listPortalContextScopes?(
    accountId: string,
  ): Promise<readonly SpeakerPortalContextScopeProjection[]>;
  listPortalCanonicalSessions(
    eventId: string,
    accountId: string,
  ): Promise<readonly SpeakerCanonicalSession[]>;
  listRoster?(eventId: string, submissionId: string): Promise<SpeakerRosterEntry[]>;
  /** Efficient event-wide roster projection used by organizer workspaces. */
  listRosterForEvent?(eventId: string): Promise<SpeakerRosterEntry[]>;
  saveRoster?(
    entry: SpeakerRosterEntry,
    expectedVersion: number | null,
  ): Promise<RepositoryResult<SpeakerRosterEntry>>;
  revokeRoster?(
    eventId: string,
    submissionId: string,
    participantId: string,
    expectedVersion: number,
    updatedAt: string,
  ): Promise<RepositoryResult<SpeakerRosterEntry>>;
  getTaskForm?(eventId: string, taskId: string): Promise<SpeakerTaskFormDefinition | null>;
  listTaskResponses?(
    eventId: string,
    taskId: string,
    participantId: string,
  ): Promise<SpeakerTaskResponseRecord[]>;
  saveTaskResponse?(
    response: SpeakerTaskResponseRecord,
    expectedVersion: number | null,
  ): Promise<RepositoryResult<SpeakerTaskResponseRecord>>;
  listAssetHistory?(eventId: string, versionFamilyId: string): Promise<SpeakerAsset[]>;
  listAssetComments?(eventId: string, assetId: string): Promise<SpeakerAssetComment[]>;
  createAssetComment?(comment: SpeakerAssetComment): Promise<SpeakerAssetComment>;
  listEventResources?(eventId: string): Promise<SpeakerEventResource[]>;
  listWikiPages?(eventId: string): Promise<SpeakerWikiPage[]>;
  getContent?(
    eventId: string,
    entityType: "session" | "speaker",
    entityId: string,
  ): Promise<SpeakerContentRecord | null>;
  listContentHistory?(
    eventId: string,
    entityType: "session" | "speaker",
    entityId: string,
  ): Promise<SpeakerContentHistoryEntry[]>;
  updateContent?(
    command: UpdateSpeakerContentCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>>;
  restoreContentVersion?(
    command: RestoreSpeakerContentVersionCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>>;
  getSessionContent?(eventId: string, sessionId: string): Promise<SpeakerContentRecord | null>;
  getSpeakerContent?(eventId: string, participantId: string): Promise<SpeakerContentRecord | null>;
  listSessionContentHistory?(
    eventId: string,
    sessionId: string,
  ): Promise<SpeakerContentHistoryEntry[]>;
  listSpeakerContentHistory?(
    eventId: string,
    participantId: string,
  ): Promise<SpeakerContentHistoryEntry[]>;
  updateSessionContent?(
    command: UpdateSpeakerContentCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>>;
  updateSpeakerContent?(
    command: UpdateSpeakerContentCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>>;
  restoreSessionContentVersion?(
    command: RestoreSpeakerContentVersionCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>>;
  restoreSpeakerContentVersion?(
    command: RestoreSpeakerContentVersionCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>>;
  getReminder?(eventId: string, idempotencyKey: string): Promise<SpeakerReminderRecord | null>;
  saveReminder?(record: SpeakerReminderRecord): Promise<SpeakerReminderRecord>;
}

export interface SpeakerDecisionWriteFence {
  readonly tenantId: string;
  readonly eventId: string;
  readonly planId: string;
  readonly submissionId: string;
  readonly version: number;
  readonly status: "accepted";
}

/**
 * Mandatory canonical boundary for organizer speaker identity, create/update, and import lifecycle.
 * Production composition must provide this alongside the portal/workload repository.
 */
export interface SpeakerOrganizerLifecycleRepository {
  getOrganizerAccessScope(
    eventId: string,
    accountId: string,
  ): Promise<SpeakerOrganizerAccessScope | null>;
  getOrganizerReadModel(
    eventId: string,
    accountId: string,
    resources: SpeakerOrganizerReadResources,
  ): Promise<SpeakerOrganizerReadModel | null>;
  resolveEventParticipant(
    input: ResolveEventParticipantInput,
  ): Promise<SpeakerParticipantResolution>;
  saveOrganizerSpeakerImportPreview(
    command: SaveOrganizerSpeakerImportPreviewCommand,
  ): Promise<SpeakerImportPreview>;
  commitOrganizerSpeakerImport(
    command: CommitOrganizerSpeakerImportCommand,
  ): Promise<OrganizerSpeakerAggregateResult>;
  upsertOrganizerSpeakerAggregate(
    command: UpsertOrganizerSpeakerAggregateCommand,
  ): Promise<RepositoryResult<SpeakerProfile>>;
}

/** Mandatory repository boundary for organization-qualified account speaker workload reads. */
export interface SpeakerAccountWorkloadRepository extends SpeakerRepository {
  getAccessScopeForOrganization(
    organizationId: string,
    eventId: string,
    accountId: string,
  ): Promise<SpeakerAccessScope>;
  listSubmissionsForOrganization(
    organizationId: string,
    eventId: string,
    submissionIds: readonly string[],
  ): Promise<OrganizationQualifiedSpeakerSubmission[]>;
  listTasksForOrganization(
    organizationId: string,
    eventId: string,
    participantIds: readonly string[],
  ): Promise<OrganizationQualifiedSpeakerTask[]>;
}

export interface CreatePrivateUploadGrantCommand {
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  expiresAt: string;
  private: true;
  requireMalwareScan: true;
  stripMetadata: boolean;
}

/** Server-only binding persisted with an opaque capability. */
export type PrivateAssetCapabilitySubject =
  | { kind: "cfp_submission"; submissionId: string }
  | { kind: "speaker_session"; sessionId: string }
  | { kind: "participant" };

export interface PrivateAssetCapabilityBinding {
  capabilityId: string;
  tenantId: string;
  eventId: string;
  subject: PrivateAssetCapabilitySubject;
  participantId: string;
  taskId?: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  fileName: string;
  expiresAt: string;
}

export type PrivateDownloadRequesterKind = "speaker" | "organizer";

export interface PrivateDownloadCapabilityBinding extends PrivateAssetCapabilityBinding {
  requesterAccountId: string;
  requesterKind: PrivateDownloadRequesterKind;
  assetVersion: number;
}

export interface PrivateUploadGrant {
  method: "PUT";
  url: string;
  headers: Readonly<Record<string, string>>;
  expiresAt: string;
}

export interface PrivateDownloadGrant {
  method?: "GET";
  url: string;
  expiresAt: string;
}

export interface PrivateAssetObjectMetadata {
  contentType: string;
  sizeBytes: number;
}

export interface PrivateUploadReceipt extends PrivateAssetObjectMetadata {
  uploadedAt: string;
}

export interface PrivateDownloadObject {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  sizeBytes: number;
  fileName: string;
}

export interface PrivateAssetGateway {
  /** Legacy provider adapter; production uses registerUploadCapability. */
  createUploadGrant(command: CreatePrivateUploadGrantCommand): Promise<PrivateUploadGrant>;
  /** Legacy provider adapter; production uses registerDownloadCapability. */
  createDownloadGrant(command: {
    objectKey: string;
    fileName: string;
    expiresAt: string;
  }): Promise<PrivateDownloadGrant>;
  registerUploadCapability?(command: PrivateAssetCapabilityBinding): Promise<PrivateUploadGrant>;
  registerDownloadCapability?(
    command: PrivateDownloadCapabilityBinding,
  ): Promise<PrivateDownloadGrant>;
  consumeUploadCapability?(
    capabilityId: string,
    token: string,
    request: Request,
  ): Promise<PrivateUploadReceipt>;
  consumeDownloadCapability?(capabilityId: string, token: string): Promise<PrivateDownloadObject>;
  inspectObject?(
    command: Pick<PrivateAssetCapabilityBinding, "objectKey" | "contentType" | "sizeBytes">,
  ): Promise<PrivateAssetObjectMetadata | null>;
  verifyUploadCapability?(command: PrivateAssetCapabilityBinding): Promise<boolean>;
  invalidateUploadCapability?(command: PrivateAssetCapabilityBinding): Promise<void>;
  readObject?(command: PrivateAssetCapabilityBinding): Promise<PrivateDownloadObject | null>;
}

export interface SpeakerPortalView {
  submissions: SpeakerSubmission[];
  profiles: SpeakerProfile[];
  tasks: SpeakerTask[];
  sessions: SpeakerWorkspaceSession[];
  outstandingTaskCount: number;
  context?: SpeakerPortalContext;
  capabilities?: readonly SpeakerPortalCapability[];
  roster?: SpeakerRosterEnvelope;
  assets?: SpeakerAsset[];
  resources?: SpeakerEventResource[];
  wiki?: SpeakerWikiPage[];
}
