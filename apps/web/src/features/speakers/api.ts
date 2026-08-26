import {
  createDeliverablesApi,
  type DeliverableHeadshotReplacement,
  type DeliverableHeadshotReplacementInput,
} from "../deliverables/api";

export type SpeakerHeadshotReplacementInput = DeliverableHeadshotReplacementInput;
export type SpeakerHeadshotReplacement = DeliverableHeadshotReplacement;

export const ORGANIZER_HEADSHOT_ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const ORGANIZER_HEADSHOT_MAX_BYTES = 5 * 1024 * 1024;

export type SpeakerStatus =
  | "pending"
  | "invited"
  | "confirmed"
  | "accepted"
  | "declined"
  | "active"
  | "revoked"
  | string;

export interface SpeakerSocialLinks {
  readonly twitter?: string;
  readonly linkedin?: string;
  readonly website?: string;
}
export interface SpeakerEventTemporalContext {
  readonly organizationId: string;
  readonly eventId: string;
  readonly timeZone: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface SpeakerTravelLogistics {
  readonly travelRequired: boolean;
  readonly arrivalAt: string | null;
  readonly departureAt: string | null;
  readonly accommodation: string;
  readonly dietaryRequirements: string;
  readonly accessibilityNeeds: string;
  readonly travelNotes: string;
}

export interface SpeakerEmailTemplate {
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly name: string;
  readonly version: number;
  readonly status: "draft" | "approved" | "archived" | string;
  readonly sender: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly variables: readonly string[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpeakerEmailPreviewRecipient {
  readonly participantId: string;
  readonly displayName: string;
  readonly firstName: string;
  readonly email: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface SpeakerEmailPreview {
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly recipientIds: readonly string[];
  readonly recipients: readonly SpeakerEmailPreviewRecipient[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SpeakerEmailDelivery {
  readonly participantId: string;
  readonly email: string;
  readonly status: "queued" | "sent" | "failed" | string;
  readonly providerMessageId: string | null;
  readonly reason: string | null;
}

export interface SpeakerEmailHistoryEntry {
  readonly occurredAt: string;
  readonly action: string;
  readonly participantId: string | null;
  readonly details: Readonly<Record<string, string | number | null>>;
}

export interface SpeakerEmailSend {
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly idempotencyKey: string;
  readonly status: "queued" | "sent" | "partial" | "failed" | string;
  readonly recipientIds: readonly string[];
  readonly deliveries: readonly SpeakerEmailDelivery[];
  readonly history: readonly SpeakerEmailHistoryEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpeakerReminderEligibility {
  readonly taskId: string;
  readonly participantId: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly reminderOffsetsMinutes: readonly number[];
  readonly eligible: boolean;
  readonly reason: string;
}

export interface SpeakerReminderEligibilityEnvelope {
  readonly organizationId: string;
  readonly eventId: string;
  readonly items: readonly SpeakerReminderEligibility[];
  readonly eligibleTaskIds: readonly string[];
  readonly eligibleRecipientIds: readonly string[];
}

export interface SpeakerTaskReminderOffsetsResult {
  readonly organizationId: string;
  readonly eventId: string;
  readonly taskId: string;
  readonly reminderOffsetsMinutes: readonly number[];
  readonly version: number;
  readonly updatedAt: string;
}

export interface SpeakerTaskSummary {
  readonly total: number;
  readonly completed: number;
  readonly overdue: number;
}

export interface SpeakerAsset {
  readonly assetId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly status: "pending" | "ready" | "rejected" | string;
  readonly uploadedAt: string;
  readonly version?: number;
  readonly versionFamilyId?: string;
  readonly downloadUrl: string | null;
}
export interface SpeakerDownloadGrant {
  readonly method?: "GET";
  readonly url: string;
  readonly expiresAt: string;
}

export interface SpeakerSession {
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly version: number;
}

export interface SpeakerTask {
  readonly taskId: string;
  readonly definitionId: string;
  readonly participantId: string;
  readonly title: string;
  readonly description: string;
  readonly type: "general" | "action" | "file_request" | string;
  readonly dueAt: string | null;
  readonly status: "pending" | "in_progress" | "uploaded" | "completed" | "overdue" | string;
  readonly completedAt: string | null;
  readonly sessionId: string | null;
  readonly latestAssetId: string | null;
  readonly version: number;
}

export interface SpeakerRecord {
  readonly eventId: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly email: string;
  readonly jobTitle: string;
  readonly company: string;
  readonly biography: string;
  readonly socialLinks: SpeakerSocialLinks;
  readonly travelLogistics?: SpeakerTravelLogistics;
  readonly headshotAssetId: string | null;
  readonly status: SpeakerStatus;
  readonly sessions: readonly SpeakerSession[];
  readonly taskSummary: SpeakerTaskSummary;
  readonly assets: readonly SpeakerAsset[];
  readonly version: number;
  readonly updatedAt: string;
}

export interface SpeakerRosterEnvelope {
  readonly organizationId: string;
  readonly eventId: string;
  readonly temporalContext?: SpeakerEventTemporalContext;
  readonly speakers: readonly SpeakerRecord[];
}

export interface SpeakerImportRow {
  readonly rowNumber: number;
  readonly displayName: string;
  readonly email: string;
  readonly jobTitle: string;
  readonly company: string;
  readonly biography: string;
  readonly socialLinks: SpeakerSocialLinks;
  readonly status?: SpeakerStatus;
}

export interface SpeakerImportIssue {
  readonly rowNumber: number;
  readonly field?: string;
  readonly message: string;
}

export interface SpeakerImportPreview {
  readonly previewId: string;
  readonly sourceDigest: string;
  readonly validRows: readonly SpeakerImportRow[];
  readonly invalidRows: readonly SpeakerImportIssue[];
}

export interface SpeakerImportCommitInput {
  readonly previewId: string;
  readonly sourceDigest: string;
  readonly idempotencyKey: string;
}

type SpeakerImportCommitRequest =
  | SpeakerImportCommitInput
  | {
      readonly rows: SpeakerImportPreview["validRows"];
      readonly idempotencyKey: string;
    };

export interface SpeakerInvitationPreview {
  readonly participantId: string;
  readonly recipientEmail: string;
  readonly state: "ready" | "blocked" | string;
}

export type SpeakerInvitationDeliveryStatus = "queued" | "sent" | "failed" | "duplicate";

export interface SpeakerInvitationRecipientResult {
  readonly participantId: string;
  readonly recipientEmail: string;
  readonly status: SpeakerInvitationDeliveryStatus;
  readonly receiptId: string | null;
}

export interface SpeakerInvitationResult {
  readonly organizationId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly status: SpeakerInvitationDeliveryStatus;
  readonly duplicate: boolean;
  readonly recipients: readonly SpeakerInvitationRecipientResult[];
}

export interface SpeakerProgressRow {
  readonly participantId: string;
  readonly displayName: string;
  readonly tasks: readonly SpeakerTask[];
}

export interface SpeakerProgressEnvelope {
  readonly organizationId: string;
  readonly eventId: string;
  readonly rows: readonly SpeakerProgressRow[];
}

export interface SpeakerCreateInput {
  readonly idempotencyKey?: string;
  readonly displayName: string;
  readonly email: string;
  readonly jobTitle: string;
  readonly company: string;
  readonly biography: string;
  readonly socialLinks: SpeakerSocialLinks;
  readonly travelLogistics?: Partial<SpeakerTravelLogistics>;
  readonly status: SpeakerStatus;
}

export interface SpeakerUpdateInput {
  readonly expectedVersion: number;
  readonly displayName: string;
  readonly email: string;
  readonly jobTitle: string;
  readonly company: string;
  readonly biography: string;
  readonly socialLinks: SpeakerSocialLinks;
  readonly travelLogistics?: Partial<SpeakerTravelLogistics>;
  readonly status: SpeakerStatus;
}

export interface SpeakerTaskAssignmentInput {
  readonly title: string;
  readonly description: string;
  readonly dueAt: string;
  readonly participantIds: readonly string[];
}

export interface SpeakerInvitationPreviewInput {
  readonly participantIds: readonly string[];
}

export interface SpeakerInvitationSendInput {
  readonly participantIds: readonly string[];
  readonly templateId: string;
  readonly idempotencyKey: string;
}

export interface SpeakerTaskEnvelope {
  readonly organizationId: string;
  readonly eventId: string;
  readonly speakerProfileId: string;
  readonly tasks: readonly SpeakerTask[];
}

export interface SpeakerErrorResponse {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly traceId?: string;
  };
}

export class SpeakerApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly traceId: string | undefined;

  constructor(code: string, message: string, status: number, traceId?: string) {
    super(message);
    this.name = "SpeakerApiError";
    this.code = code;
    this.status = status;
    this.traceId = traceId;
  }
}

export type SpeakerMutationStatus =
  | "idle"
  | "saving"
  | "pending"
  | "saved"
  | "conflict"
  | "failure";

export class SpeakerAuthoritativeDataError extends Error {
  readonly code = "AUTHORITATIVE_DATA_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SpeakerAuthoritativeDataError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertSpeakerRosterScope(
  value: SpeakerRosterEnvelope,
  organizationId: string,
  eventId: string,
): SpeakerRosterEnvelope {
  if (
    !isRecord(value) ||
    value.organizationId !== organizationId ||
    value.eventId !== eventId ||
    !Array.isArray(value.speakers)
  ) {
    throw new SpeakerAuthoritativeDataError(
      "The speaker roster response belongs to a different organization or event.",
    );
  }
  const participantIds = new Set<string>();
  for (const speaker of value.speakers) {
    if (
      !isRecord(speaker) ||
      speaker.eventId !== eventId ||
      typeof speaker.participantId !== "string" ||
      speaker.participantId.trim().length === 0 ||
      participantIds.has(speaker.participantId)
    ) {
      throw new SpeakerAuthoritativeDataError(
        "The speaker roster response contains an invalid or duplicate participant.",
      );
    }
    participantIds.add(speaker.participantId);
  }
  return { ...value, speakers: [...value.speakers] };
}

export function assertSpeakerParticipant(
  value: SpeakerRecord,
  participantId: string,
  eventId?: string,
): SpeakerRecord {
  if (
    !isRecord(value) ||
    value.participantId !== participantId ||
    (eventId !== undefined && value.eventId !== eventId) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  ) {
    throw new SpeakerAuthoritativeDataError(
      "The speaker response does not match the selected participant or event.",
    );
  }
  return value;
}

export function assertAdvancedSpeakerRevision(
  value: SpeakerRecord,
  participantId: string,
  expectedVersion: number,
  eventId?: string,
): SpeakerRecord {
  const record = assertSpeakerParticipant(value, participantId, eventId);
  if (record.version <= expectedVersion) {
    throw new SpeakerAuthoritativeDataError(
      "The speaker response did not include an advanced authoritative revision.",
    );
  }
  return record;
}

export function assertSpeakerHeadshotReplacement(
  replacement: SpeakerHeadshotReplacement,
  eventId: string,
  participantId: string,
  expectedVersion: number,
): SpeakerHeadshotReplacement {
  const asset = replacement?.asset;
  const profile = replacement?.profile;
  if (
    !isRecord(asset) ||
    !isRecord(profile) ||
    asset.eventId !== eventId ||
    asset.participantId !== participantId ||
    asset.state !== "ready" ||
    typeof asset.id !== "string" ||
    asset.id.trim().length === 0 ||
    profile.eventId !== eventId ||
    profile.participantId !== participantId ||
    profile.headshotAssetId !== asset.id ||
    typeof profile.version !== "number" ||
    !Number.isSafeInteger(profile.version) ||
    profile.version <= expectedVersion
  ) {
    throw new SpeakerAuthoritativeDataError(
      "The headshot replacement response did not match the selected participant, event, pointer, or revision.",
    );
  }
  return replacement;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function baseWithoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function parseSpeakerInvitationResult(value: unknown): SpeakerInvitationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("The invitation result is invalid.");
  }
  const record = value as Record<string, unknown>;
  const statuses = new Set<SpeakerInvitationDeliveryStatus>([
    "queued",
    "sent",
    "failed",
    "duplicate",
  ]);
  if (
    typeof record.organizationId !== "string" ||
    record.organizationId.trim().length === 0 ||
    typeof record.eventId !== "string" ||
    record.eventId.trim().length === 0 ||
    typeof record.idempotencyKey !== "string" ||
    record.idempotencyKey.trim().length === 0 ||
    typeof record.status !== "string" ||
    !statuses.has(record.status as SpeakerInvitationDeliveryStatus) ||
    typeof record.duplicate !== "boolean" ||
    !Array.isArray(record.recipients) ||
    record.recipients.length === 0
  ) {
    throw new TypeError("The invitation result is invalid.");
  }
  const recipients = record.recipients.map((value): SpeakerInvitationRecipientResult => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("The invitation recipient result is invalid.");
    }
    const recipient = value as Record<string, unknown>;
    if (
      typeof recipient.participantId !== "string" ||
      recipient.participantId.trim().length === 0 ||
      typeof recipient.recipientEmail !== "string" ||
      recipient.recipientEmail.trim().length === 0 ||
      typeof recipient.status !== "string" ||
      !statuses.has(recipient.status as SpeakerInvitationDeliveryStatus) ||
      (recipient.receiptId !== null && typeof recipient.receiptId !== "string")
    ) {
      throw new TypeError("The invitation recipient result is invalid.");
    }
    return {
      participantId: recipient.participantId,
      recipientEmail: recipient.recipientEmail,
      status: recipient.status as SpeakerInvitationDeliveryStatus,
      receiptId: recipient.receiptId,
    };
  });
  return {
    organizationId: record.organizationId,
    eventId: record.eventId,
    idempotencyKey: record.idempotencyKey,
    status: record.status as SpeakerInvitationDeliveryStatus,
    duplicate: record.duplicate,
    recipients,
  };
}

const SPEAKER_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function safeSpeakerErrorCode(value: unknown): string {
  return typeof value === "string" && SPEAKER_ERROR_CODE_PATTERN.test(value)
    ? value
    : "SPEAKER_REQUEST_FAILED";
}

function safeSpeakerTraceId(value: unknown): string | undefined {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : undefined;
}

function parseSpeakerImportPreview(value: unknown): SpeakerImportPreview {
  if (!isRecord(value)) {
    throw new SpeakerAuthoritativeDataError("The speaker import preview is invalid.");
  }
  if (
    typeof value.previewId !== "string" ||
    value.previewId.trim().length === 0 ||
    typeof value.sourceDigest !== "string" ||
    value.sourceDigest.trim().length === 0 ||
    !Array.isArray(value.validRows) ||
    !Array.isArray(value.invalidRows)
  ) {
    throw new SpeakerAuthoritativeDataError(
      "The speaker import preview is missing its durable preview artifact.",
    );
  }
  return {
    previewId: value.previewId,
    sourceDigest: value.sourceDigest,
    validRows: value.validRows as readonly SpeakerImportRow[],
    invalidRows: value.invalidRows as readonly SpeakerImportIssue[],
  };
}

async function errorFrom(response: Response): Promise<SpeakerApiError> {
  const body = (await response.json().catch(() => undefined)) as unknown;
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  return new SpeakerApiError(
    safeSpeakerErrorCode(error?.code),
    typeof error?.message === "string" && error.message.trim().length > 0
      ? error.message
      : "The speaker request could not be completed.",
    Number.isSafeInteger(response.status) && response.status >= 400 && response.status <= 599
      ? response.status
      : 500,
    safeSpeakerTraceId(error?.traceId),
  );
}

export interface SpeakerApi {
  list(signal?: AbortSignal): Promise<SpeakerRosterEnvelope>;
  get(participantId: string, signal?: AbortSignal): Promise<SpeakerRecord>;
  create(input: SpeakerCreateInput, signal?: AbortSignal): Promise<SpeakerRosterEnvelope>;
  update(participantId: string, input: SpeakerUpdateInput): Promise<SpeakerRosterEnvelope>;
  getSessions(participantId: string, signal?: AbortSignal): Promise<readonly SpeakerSession[]>;
  getAssets(participantId: string, signal?: AbortSignal): Promise<readonly SpeakerAsset[]>;
  getDownloadGrant(assetId: string, signal?: AbortSignal): Promise<SpeakerDownloadGrant>;
  replaceHeadshot(input: SpeakerHeadshotReplacementInput): Promise<SpeakerHeadshotReplacement>;
  previewImport(file: File, signal?: AbortSignal): Promise<SpeakerImportPreview>;
  commitImport(
    input: SpeakerImportCommitRequest,
    signal?: AbortSignal,
  ): Promise<SpeakerRosterEnvelope>;
  listTasks(signal?: AbortSignal): Promise<SpeakerTaskEnvelope>;
  assignTasks(input: SpeakerTaskAssignmentInput): Promise<SpeakerTaskEnvelope>;
  updateTaskReminderOffsets(input: {
    taskId: string;
    expectedVersion: number;
    reminderOffsetsMinutes: readonly number[];
  }): Promise<SpeakerTaskReminderOffsetsResult>;
  previewInvitations(
    input: SpeakerInvitationPreviewInput,
  ): Promise<readonly SpeakerInvitationPreview[]>;
  sendInvitations(input: SpeakerInvitationSendInput): Promise<SpeakerInvitationResult>;
  listEmailTemplates(signal?: AbortSignal): Promise<readonly SpeakerEmailTemplate[]>;
  createEmailTemplate(
    input: {
      templateId?: string;
      name: string;
      subject: string;
      text: string;
      status?: "draft" | "approved";
    },
    signal?: AbortSignal,
  ): Promise<SpeakerEmailTemplate>;
  createEmailTemplateVersion(
    input: {
      templateId: string;
      subject: string;
      text: string;
      status?: "draft" | "approved";
    },
    signal?: AbortSignal,
  ): Promise<SpeakerEmailTemplate>;
  previewEmails(
    input: {
      participantIds: readonly string[];
      templateId: string;
      templateVersion?: number;
    },
    signal?: AbortSignal,
  ): Promise<SpeakerEmailPreview>;
  sendEmails(
    input: { previewId: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<SpeakerEmailSend>;
  listEmailHistory(signal?: AbortSignal): Promise<readonly SpeakerEmailSend[]>;
  getReminderEligibility(
    input?: {
      taskIds?: readonly string[];
      recipientIds?: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<SpeakerReminderEligibilityEnvelope>;
}

export function createSpeakerApi(
  baseUrl: string,
  organizationId: string,
  eventId: string,
  fetcher: Fetcher = fetch,
): SpeakerApi {
  const normalizedBaseUrl = baseWithoutTrailingSlash(baseUrl.trim());
  const normalizedOrganizationId = organizationId.trim();
  const normalizedEventId = eventId.trim();
  let latestImportPreview: SpeakerImportPreview | null = null;
  if (normalizedOrganizationId.length === 0) {
    throw new TypeError("An organization ID is required for speaker requests.");
  }
  if (normalizedEventId.length === 0) {
    throw new TypeError("An event ID is required for speaker requests.");
  }

  const eventApiBase = `${normalizedBaseUrl}/api/admin/organizations/${pathSegment(normalizedOrganizationId)}/events/${pathSegment(normalizedEventId)}`;
  const apiBase = `${eventApiBase}/speakers`;
  const organizerHeadshotBaseUrl =
    normalizedBaseUrl.length > 0
      ? normalizedBaseUrl
      : typeof window === "undefined"
        ? "http://localhost"
        : window.location.origin;
  const organizerHeadshotOrigin = new URL(organizerHeadshotBaseUrl).origin;
  const organizerHeadshotFetcher = (input: RequestInfo | URL, init?: RequestInit) => {
    const resolved = new URL(String(input), `${organizerHeadshotBaseUrl}/`);
    if (resolved.origin !== organizerHeadshotOrigin || !resolved.pathname.startsWith("/api/")) {
      throw new TypeError("Organizer headshot requests must use a same-origin /api/* path.");
    }
    return fetcher(`${resolved.pathname}${resolved.search}`, init);
  };
  const organizerHeadshotApi = createDeliverablesApi(
    organizerHeadshotBaseUrl,
    normalizedOrganizationId,
    normalizedEventId,
    organizerHeadshotFetcher,
  );
  const rawReplaceHeadshot = organizerHeadshotApi.replaceHeadshot;
  if (rawReplaceHeadshot === undefined) {
    throw new TypeError("The organizer headshot replacement adapter is unavailable.");
  }

  const replaceHeadshot = async (
    input: SpeakerHeadshotReplacementInput,
  ): Promise<SpeakerHeadshotReplacement> =>
    assertSpeakerHeadshotReplacement(
      await rawReplaceHeadshot(input),
      normalizedEventId,
      input.participantId,
      input.expectedVersion,
    );

  async function requestAt<T>(base: string, path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      cache: "no-store",
      credentials: "include",
      headers: {
        accept: "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) throw await errorFrom(response);
    if (response.status === 204) return undefined as T;
    const body = (await response.json()) as unknown;
    return typeof body === "object" && body !== null && "data" in body
      ? (body as { data: T }).data
      : (body as T);
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    return requestAt<T>(apiBase, path, init);
  }

  async function eventRequest<T>(path: string, init?: RequestInit): Promise<T> {
    return requestAt<T>(eventApiBase, path, init);
  }

  function jsonRequest<T>(
    path: string,
    method: "POST" | "PUT" | "PATCH",
    value: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return request<T>(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  function eventJsonRequest<T>(
    path: string,
    method: "POST" | "PUT" | "PATCH",
    value: unknown,
  ): Promise<T> {
    return eventRequest<T>(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  }

  return {
    list(signal) {
      return request<SpeakerRosterEnvelope>("", signal === undefined ? undefined : { signal }).then(
        (value) => assertSpeakerRosterScope(value, normalizedOrganizationId, normalizedEventId),
      );
    },
    get(participantId, signal) {
      return request<SpeakerRecord>(
        `/${pathSegment(participantId)}`,
        signal === undefined ? undefined : { signal },
      ).then((value) => assertSpeakerParticipant(value, participantId, normalizedEventId));
    },
    create(input, signal) {
      return jsonRequest<SpeakerRosterEnvelope>("", "POST", input, signal).then((value) =>
        assertSpeakerRosterScope(value, normalizedOrganizationId, normalizedEventId),
      );
    },
    update(participantId, input) {
      return jsonRequest<SpeakerRosterEnvelope>(
        `/${pathSegment(participantId)}`,
        "PATCH",
        input,
      ).then((value) =>
        assertSpeakerRosterScope(value, normalizedOrganizationId, normalizedEventId),
      );
    },
    getSessions(participantId, signal) {
      return request<readonly SpeakerSession[]>(
        `/${pathSegment(participantId)}/sessions`,
        signal === undefined ? undefined : { signal },
      );
    },
    getAssets(participantId, signal) {
      return request<readonly SpeakerAsset[]>(
        `/${pathSegment(participantId)}/assets`,
        signal === undefined ? undefined : { signal },
      ).then((assets) => {
        for (const asset of assets) {
          if (
            isRecord(asset) &&
            ((typeof asset.eventId === "string" && asset.eventId !== normalizedEventId) ||
              (typeof asset.participantId === "string" && asset.participantId !== participantId))
          ) {
            throw new SpeakerAuthoritativeDataError(
              "The speaker asset response belongs to a different event or participant.",
            );
          }
        }
        return assets.map((asset) => ({
          ...asset,
          // The list endpoint may include a short-lived grant for legacy callers. Keep it out of
          // the browser-facing workspace until the organizer explicitly requests a download.
          downloadUrl: null,
        }));
      });
    },
    getDownloadGrant(assetId, signal) {
      return requestAt<SpeakerDownloadGrant>(
        normalizedBaseUrl,
        `/api/speaker/events/${pathSegment(normalizedEventId)}/organizer/assets/${pathSegment(assetId)}/download`,
        {
          method: "POST",
          ...(signal === undefined ? {} : { signal }),
        },
      );
    },
    replaceHeadshot,
    previewImport(file, signal) {
      const body = new FormData();
      body.append("file", file);
      return request<unknown>("/imports/preview", {
        method: "POST",
        body,
        ...(signal === undefined ? {} : { signal }),
      }).then((value) => {
        const preview = parseSpeakerImportPreview(value);
        latestImportPreview = preview;
        return preview;
      });
    },
    commitImport(input, signal) {
      const canonicalInput =
        "previewId" in input
          ? input
          : latestImportPreview === null
            ? null
            : {
                previewId: latestImportPreview.previewId,
                sourceDigest: latestImportPreview.sourceDigest,
                idempotencyKey: input.idempotencyKey,
              };
      if (canonicalInput === null) {
        throw new TypeError("A durable speaker import preview is required before commit.");
      }
      return jsonRequest<SpeakerRosterEnvelope>("/imports", "POST", canonicalInput, signal).then(
        (value) => assertSpeakerRosterScope(value, normalizedOrganizationId, normalizedEventId),
      );
    },
    listTasks(signal) {
      return eventRequest<SpeakerTaskEnvelope>(
        "/speaker-tasks",
        signal === undefined ? undefined : { signal },
      ).then((value) => {
        if (
          !isRecord(value) ||
          value.organizationId !== normalizedOrganizationId ||
          value.eventId !== normalizedEventId ||
          !Array.isArray(value.tasks)
        ) {
          throw new SpeakerAuthoritativeDataError(
            "The speaker task response belongs to a different organization or event.",
          );
        }
        return value;
      });
    },
    assignTasks(input) {
      return eventJsonRequest<SpeakerTaskEnvelope>("/speaker-tasks", "POST", {
        title: input.title,
        description: input.description,
        dueAt: input.dueAt,
        assignments: input.participantIds.map((participantId) => ({
          participantId,
          submissionId: null,
        })),
      });
    },
    updateTaskReminderOffsets(input) {
      return eventJsonRequest<SpeakerTaskReminderOffsetsResult>(
        `/speaker-tasks/${pathSegment(input.taskId)}/reminder-offsets`,
        "PUT",
        {
          expectedVersion: input.expectedVersion,
          reminderOffsetsMinutes: input.reminderOffsetsMinutes,
        },
      ).then((result) => {
        if (
          result.organizationId !== normalizedOrganizationId ||
          result.eventId !== normalizedEventId ||
          result.taskId !== input.taskId ||
          !Array.isArray(result.reminderOffsetsMinutes) ||
          result.reminderOffsetsMinutes.some(
            (offset, index) =>
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              (index > 0 && (result.reminderOffsetsMinutes[index - 1] ?? offset) >= offset),
          ) ||
          !Number.isSafeInteger(result.version) ||
          result.version !== input.expectedVersion + 1 ||
          typeof result.updatedAt !== "string"
        ) {
          throw new SpeakerAuthoritativeDataError(
            "The reminder schedule response did not match the requested task revision.",
          );
        }
        return result;
      });
    },
    previewInvitations(input) {
      return jsonRequest<readonly SpeakerInvitationPreview[]>(
        "/invitations/preview",
        "POST",
        input,
      );
    },
    sendInvitations(input) {
      return jsonRequest<unknown>("/invitations/send", "POST", input).then(
        parseSpeakerInvitationResult,
      );
    },
    listEmailTemplates(signal) {
      return request<readonly SpeakerEmailTemplate[]>(
        "/email/templates",
        signal === undefined ? undefined : { signal },
      );
    },
    createEmailTemplate(input, signal) {
      return jsonRequest<SpeakerEmailTemplate>("/email/templates", "POST", input, signal);
    },
    createEmailTemplateVersion(input, signal) {
      return jsonRequest<SpeakerEmailTemplate>(
        `/email/templates/${pathSegment(input.templateId)}/versions`,
        "POST",
        input,
        signal,
      );
    },
    previewEmails(input, signal) {
      return jsonRequest<SpeakerEmailPreview>("/email/preview", "POST", input, signal);
    },
    sendEmails(input, signal) {
      return jsonRequest<SpeakerEmailSend>("/email/send", "POST", input, signal);
    },
    listEmailHistory(signal) {
      return request<readonly SpeakerEmailSend[]>(
        "/email/history",
        signal === undefined ? undefined : { signal },
      );
    },
    getReminderEligibility(input = {}, signal) {
      const query = new URLSearchParams();
      if (input.taskIds !== undefined && input.taskIds.length > 0) {
        query.set("taskIds", input.taskIds.join(","));
      }
      if (input.recipientIds !== undefined && input.recipientIds.length > 0) {
        query.set("recipientIds", input.recipientIds.join(","));
      }
      const suffix = query.toString().length === 0 ? "" : `?${query.toString()}`;
      return request<SpeakerReminderEligibilityEnvelope>(
        `/reminders/eligibility${suffix}`,
        signal === undefined ? undefined : { signal },
      );
    },
  };
}
