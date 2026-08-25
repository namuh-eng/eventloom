const portalSubmissionStatuses = [
  "draft",
  "submitted",
  "under_review",
  "accepted",
  "declined",
  "withdrawn",
] as const;

export type PortalSubmissionStatus = (typeof portalSubmissionStatuses)[number];

const portalTaskStatuses = [
  "not_started",
  "in_progress",
  "submitted",
  "needs_changes",
  "completed",
  "waived",
  "overdue",
  "reopened",
] as const;

export type PortalTaskStatus = (typeof portalTaskStatuses)[number];
export type PortalTaskType = "form" | "upload" | "action";
export type PortalAssetKind = "headshot" | "slides" | "supporting_file";
export type PortalAssetState = "pending_upload" | "ready" | "rejected";

/** Capabilities are an allow-list from the server; unknown values are ignored by the UI. */
const portalCapabilities = [
  "profile-self",
  "submission-edit",
  "roster-manage",
  "task-response",
  "asset-read",
  "asset-write",
  "asset-comment",
  "resource-read",
] as const;

export type PortalCapability = (typeof portalCapabilities)[number];
export type PortalProfileMutationPhase =
  | "idle"
  | "saving"
  | "pending"
  | "saved"
  | "conflict"
  | "failure";

export interface PortalTravelLogistics {
  travelRequired: boolean;
  arrivalAt: string | null;
  departureAt: string | null;
  accommodation: string;
  dietaryRequirements: string;
  accessibilityNeeds: string;
  travelNotes: string;
}

export interface PortalSubmission {
  id: string;
  eventId: string;
  title: string;
  status: PortalSubmissionStatus;
  participantIds: readonly string[];
  participants?: readonly {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    role: "primary" | "co_author";
  }[];
  updatedAt: string;
  version?: number;
  formId?: string;
  closeAt?: string;
  answers?: Readonly<Record<string, unknown>>;
}

export interface PortalProfile {
  id: string;
  eventId: string;
  participantId: string;
  displayName: string;
  biography: string;
  email?: string;
  jobTitle?: string;
  company?: string;
  status?: string;
  socialLinks?: Readonly<Record<string, string>>;
  travelLogistics?: PortalTravelLogistics;
  headshotAssetId?: string | null;
  version: number;
  updatedAt: string;
}

export type PortalTaskSubject = { type: "participant" } | { type: "session"; sessionId: string };

export interface PortalTask {
  id: string;
  eventId: string;
  participantId: string;
  subject: PortalTaskSubject;
  /** Canonical program-session title projected for session-scoped tasks. */
  sessionTitle?: string;
  type: PortalTaskType;
  owner: "speaker" | "organizer";
  title: string;
  description?: string;
  status: PortalTaskStatus;
  dueAt?: string;
  dependencyIds: readonly string[];
  reminderOffsetsMinutes: readonly number[];
  acceptedAssetKinds?: readonly PortalAssetKind[];
  version: number;
  updatedAt: string;
}

export interface PortalEventTemporalContext {
  organizationId: string;
  eventId: string;
  timeZone: string;
  startsAt: string;
  endsAt: string;
}

export interface PortalContext {
  id: string;
  /** Optional tenant identity projected by newer speaker adapters. */
  organizationId?: string;
  eventId: string;
  name: string;
  slug?: string;
  capabilities: readonly PortalCapability[];
  /** Participant IDs are explicit grants; an empty list is valid for owned submissions. */
  submissionIds: readonly string[];
  participantIds: readonly string[];
  /** Explicit participant IDs authorized by the event grant. */
  authorizedParticipantIds?: readonly string[];
  primaryParticipantId?: string;
  /** Client-only selection; never used as an authority source. */
  selectedParticipantId?: string | null;
  temporalContext?: PortalEventTemporalContext;
}

export interface PortalRosterMember {
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

export interface PortalRosterEnvelope {
  organizationId: string;
  eventId: string;
  submissionId: string;
  capabilities: {
    manage: boolean;
    invite: boolean;
  };
  members: readonly PortalRosterMember[];
}

export interface PortalAsset {
  id: string;
  eventId: string;
  sessionId?: string;
  participantId: string;
  taskId?: string;
  kind: PortalAssetKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  state: PortalAssetState;
  createdAt: string;
  version?: number;
  versionId?: string;
  versionFamilyId?: string;
  supersedesAssetId?: string;
  latestVersionId?: string | null;
  currentVersionId?: string | null;
  approvedVersionId?: string | null;
  releasedVersionId?: string | null;
  reviewState?: "approved" | "needs_changes";
  reviewNote?: string;
  reviewedAt?: string;
  reviewVersion?: number;
  commentThreadId?: string;
  rejectionReason?: string;
  finalizedAt?: string;
}

export type PortalAssetHistoryEntry = PortalAsset;

export interface PortalAssetComment {
  id: string;
  assetId: string;
  versionId?: string;
  body: string;
  authorLabel: string;
  createdAt: string;
  updatedAt?: string;
  version?: number;
}

export interface PortalDownloadGrant {
  method?: "GET";
  url: string;
  expiresAt: string;
}

export interface PortalFormOption {
  value: string;
  label: string;
}

export type PortalFormFieldType =
  | "text"
  | "textarea"
  | "rich_text"
  | "email"
  | "url"
  | "number"
  | "date"
  | "select"
  | "multiselect"
  | "checkbox"
  | "boolean"
  | "file_request";

export interface PortalFormField {
  id: string;
  label: string;
  type: PortalFormFieldType;
  required: boolean;
  options: readonly PortalFormOption[];
}

export type PortalFormAnswer = string | number | boolean | readonly string[] | null;

export type PortalTaskResponseStatus = "draft" | "submitted" | "needs_changes" | "reopened";

export interface PortalTaskResponse {
  responseId: string;
  definitionVersion: number;
  answers: Readonly<Record<string, PortalFormAnswer>>;
  submittedAt: string | null;
  status: PortalTaskResponseStatus;
  organizerFeedback: string | null;
}

export interface PortalTaskForm {
  taskId: string;
  definitionVersion: number;
  title: string;
  description: string;
  status: PortalTaskStatus;
  fields: readonly PortalFormField[];
  latestResponse: PortalTaskResponse | null;
}

export interface PortalTaskResponseEnvelope {
  organizationId: string;
  eventId: string;
  taskId: string;
  participantId: string;
  latestResponse: PortalTaskResponse | null;
  history: readonly PortalTaskResponse[];
}

export interface PortalResource {
  id: string;
  title: string;
  summary?: string;
  html?: string;
  url?: string;
  order: number;
  updatedAt: string;
}

export interface PortalWikiPage extends PortalResource {
  slug?: string;
}

export interface PortalView {
  submissions: PortalSubmission[];
  profiles: PortalProfile[];
  tasks: PortalTask[];
  outstandingTaskCount: number;
  context?: PortalContext;
  capabilities?: readonly PortalCapability[];
  roster?: PortalRosterEnvelope;
  assets?: PortalAsset[];
  resources?: PortalResource[];
  wiki?: PortalWikiPage[];
}

export interface PortalUploadAuthorization {
  asset: PortalAsset;
  grant: {
    method: "PUT";
    url: string;
    headers: Readonly<Record<string, string>>;
    expiresAt: string;
  };
}

export interface PortalErrorResponse {
  error?: {
    code?: string;
    message?: string;
    traceId?: string;
  };
}
