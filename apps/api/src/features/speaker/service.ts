import {
  calendarDateDeadline,
  localDateInTimeZone,
  standardImageUploadMimeTypes,
  standardPresentationUploadMimeTypes,
  standardSupportingFileUploadMimeTypes,
  standardUploadMaximumBytes,
} from "@eventloom/contracts";
import { CommunicationError } from "../communications/service";
import type { CreateEventRoleInvitationInput } from "../event-invitations/types";
import { allSpeakerPortalCapabilities, capabilityAllows } from "./capabilities";
import type { SpeakerCommunications } from "./communications";
import type {
  FinalizeSpeakerAssetCommand,
  PrivateAssetCapabilityBinding,
  PrivateAssetGateway,
  PrivateDownloadCapabilityBinding,
  PrivateDownloadGrant,
  PrivateDownloadObject,
  PrivateUploadGrant,
  PrivateUploadReceipt,
  RepositoryResult,
  ResolveEventParticipantInput,
  SpeakerAccessScope,
  SpeakerAsset,
  SpeakerAssetAuditEntry,
  SpeakerAssetComment,
  SpeakerAssetKind,
  SpeakerAssetReviewCommand,
  SpeakerAssetReviewInput,
  SpeakerContentHistoryEntry,
  SpeakerContentRecord,
  SpeakerContentRestoreInput,
  SpeakerContentUpdateInput,
  SpeakerDeliverableRow,
  SpeakerDeliverablesExportInput,
  SpeakerDeliverablesExportManifest,
  SpeakerDeliverablesExportManifestEntry,
  SpeakerDeliverablesExportResult,
  SpeakerDeliverablesMatrix,
  SpeakerDeliverablesQuery,
  SpeakerEventResource,
  SpeakerEventTemporalContext,
  SpeakerFormAnswer,
  SpeakerImportIssue,
  SpeakerImportPreview,
  SpeakerImportRow,
  SpeakerInvitationPreview,
  SpeakerInvitationResult,
  SpeakerOrganizerLifecycleRepository,
  SpeakerOrganizerProfileInput,
  SpeakerOrganizerReadModel,
  SpeakerParticipantResolution,
  SpeakerParticipantSourceType,
  SpeakerPortalCapability,
  SpeakerPortalContext,
  SpeakerPortalView,
  SpeakerProfile,
  SpeakerReminderDelivery,
  SpeakerReminderDeliveryInput,
  SpeakerReminderDeliveryReceipt,
  SpeakerReminderPreview,
  SpeakerReminderQueueInput,
  SpeakerReminderQueueResult,
  SpeakerReminderRecord,
  SpeakerReminderTask,
  SpeakerRepository,
  SpeakerRosterEntry,
  SpeakerRosterEnvelope,
  SpeakerRosterMember,
  SpeakerSessionAuthority,
  SpeakerSubmission,
  SpeakerTask,
  SpeakerTaskAssignmentInput,
  SpeakerTaskCreateInput,
  SpeakerTaskForm,
  SpeakerTaskFormDefinition,
  SpeakerTaskRepositoryAudit,
  SpeakerTaskResponse,
  SpeakerTaskResponseEnvelope,
  SpeakerTaskResponseRecord,
  SpeakerTaskStatus,
  SpeakerTaskSubject,
  SpeakerTaskUpdateInput,
  SpeakerTravelLogistics,
  SpeakerWikiPage,
  SpeakerWorkspaceAsset,
  SpeakerWorkspaceRecord,
  SpeakerWorkspaceRoster,
  SpeakerWorkspaceSession,
  SpeakerWorkspaceTask,
  UpdateSpeakerContentCommand,
} from "./types";
import { speakerTaskStatuses } from "./types";

export type SpeakerServiceErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "VERSION_CONFLICT"
  | "IDENTITY_AMBIGUOUS"
  | "INVALID_TASK_TRANSITION"
  | "TASK_DEPENDENCY_INCOMPLETE"
  | "TASK_NOT_ACTIVE"
  | "TASK_ASSET_NOT_READY"
  | "TASK_REMINDERS_NOT_EDITABLE"
  | "UPLOAD_POLICY_VIOLATION"
  | "ASSET_UPLOAD_RETRY_INVALID"
  | "ASSET_FINALIZATION_INVALID"
  | "CAPABILITY_UNAVAILABLE"
  | "CAPABILITY_INVALID"
  | "CAPABILITY_EXPIRED"
  | "CAPABILITY_REPLAY"
  | "REMINDER_UNAVAILABLE"
  | "CONTENT_UNAVAILABLE"
  | "EMAIL_TEMPLATE_NOT_FOUND"
  | "EMAIL_PARTICIPANT_NOT_FOUND"
  | "EMAIL_RECIPIENT_EMAIL_MISSING";

export class SpeakerServiceError extends Error {
  constructor(
    readonly code: SpeakerServiceErrorCode,
    readonly status: 400 | 404 | 409 | 410 | 503,
    message: string,
  ) {
    super(message);
    this.name = "SpeakerServiceError";
  }
}
export type { SpeakerTravelLogistics } from "./types";

export interface SpeakerEmailTemplate {
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly name: string;
  readonly version: number;
  readonly status: "draft" | "approved" | "archived";
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
  readonly sender: string;
  readonly recipientIds: readonly string[];
  readonly recipients: readonly SpeakerEmailPreviewRecipient[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SpeakerEmailDeliveryInput {
  readonly organizationId: string;
  readonly eventId: string;
  readonly participantId: string;
  readonly recipientEmail: string;
  readonly displayName: string;
  readonly firstName: string;
  readonly sender: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly idempotencyKey: string;
  readonly actorAccountId: string;
}

export interface SpeakerEmailDeliveryReceipt {
  readonly status?: "queued" | "sent" | "failed";
  readonly duplicate?: boolean;
  readonly providerMessageId?: string;
  readonly reason?: string;
}

export interface SpeakerEmailDelivery {
  enqueueEmail?(input: SpeakerEmailDeliveryInput): Promise<SpeakerEmailDeliveryReceipt>;
  queueEmail?(input: SpeakerEmailDeliveryInput): Promise<SpeakerEmailDeliveryReceipt>;
}

export interface SpeakerEmailSend {
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly sender: string;
  readonly idempotencyKey: string;
  readonly status: "queued" | "sent" | "partial" | "failed";
  readonly recipientIds: readonly string[];
  readonly deliveries: readonly {
    participantId: string;
    email: string;
    status: "queued" | "sent" | "failed";
    providerMessageId: string | null;
    reason: string | null;
  }[];
  readonly history: readonly {
    occurredAt: string;
    action: "send_created" | "delivery_queued" | "delivery_sent" | "delivery_failed";
    participantId: string | null;
    details: Readonly<Record<string, string | number | null>>;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpeakerScheduledReminderInput {
  readonly organizationId: string;
  readonly eventId: string;
  readonly organizerAccountIds: readonly string[];
  readonly now?: Date;
}
export const speakerScheduledReminderActor = "system:speaker-reminder-scheduler";
export interface SpeakerReminderEligibility {
  readonly taskId: string;
  readonly participantId: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly deadlineAt: string | null;
  readonly reminderOffsetsMinutes: readonly number[];
  readonly eligible: boolean;
  readonly reason:
    | "due"
    | "window"
    | "outside_window"
    | "no_due_date"
    | "complete"
    | "no_reminder_offset";
}

export interface SpeakerEventTemporalSource {
  getEventTemporalContext(
    organizationId: string,
    eventId: string,
  ): Promise<SpeakerEventTemporalContext | null>;
}

export interface SpeakerEventInvitationCreator {
  create(input: CreateEventRoleInvitationInput): Promise<unknown>;
}

export interface SpeakerServiceOptions {
  speakerSender: string;
  sessionAuthority?: SpeakerSessionAuthority;
  eventTemporalSource?: SpeakerEventTemporalSource;
  now?: () => Date;
  generateId?: () => string;
  delivery?: SpeakerReminderDelivery;
  /** Alias retained so adapters can name the injected delivery explicitly. */
  reminderDelivery?: SpeakerReminderDelivery;
  invitationDelivery?: SpeakerReminderDelivery;
  /** Test-only compatibility; production speaker email uses communications. */
  emailDelivery?: SpeakerEmailDelivery;
  communications?: SpeakerCommunications;
  /** Creates account-bound authorization records; invitation email remains notification-only. */
  invitationCreator?: SpeakerEventInvitationCreator;
}

type EditableSpeakerProfileInput = SpeakerOrganizerProfileInput & {
  jobTitle?: string;
  company?: string;
  travelLogistics?: Partial<SpeakerTravelLogistics>;
};
export interface IssueUploadGrantInput {
  eventId: string;
  accountId: string;
  participantId: string;
  sessionId?: string;
  taskId?: string;
  kind: SpeakerAssetKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  supersedesAssetId?: string;
  expectedLatestVersion?: number;
  idempotencyKey?: string;
  organizer?: boolean;
}

export interface SpeakerUploadAuthorization {
  asset: SpeakerAsset;
  grant: PrivateUploadGrant;
}

const completedDependencyStatuses = new Set<SpeakerTaskStatus>(["completed", "waived"]);
const uploadGrantLifetimeMs = 5 * 60 * 1000;
const downloadGrantLifetimeMs = 2 * 60 * 1000;
const bulkExportMaximumAssets = 100;
const bulkExportMaximumBytes = 250 * 1024 * 1024;
const bulkExportContentType = "application/zip" as const;
const bulkExportManifestName = "manifest.json";

const uploadPolicies: Record<
  SpeakerAssetKind,
  { maximumBytes: number; contentTypes: ReadonlySet<string>; stripMetadata: boolean }
> = {
  headshot: {
    maximumBytes: standardUploadMaximumBytes.headshot,
    contentTypes: new Set(standardImageUploadMimeTypes),
    stripMetadata: true,
  },
  slides: {
    maximumBytes: standardUploadMaximumBytes.slides,
    contentTypes: new Set(standardPresentationUploadMimeTypes),
    stripMetadata: false,
  },
  supporting_file: {
    maximumBytes: standardUploadMaximumBytes.supporting_file,
    contentTypes: new Set(standardSupportingFileUploadMimeTypes),
    stripMetadata: false,
  },
};

function notFound(): SpeakerServiceError {
  return new SpeakerServiceError("NOT_FOUND", 404, "The requested speaker resource was not found.");
}

function containsDisallowedTextControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint === 0x7f || (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a))
    );
  });
}

function stripFileNameControls(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
    })
    .join("");
}

function normalizeBiography(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (normalized.length > 5_000 || containsDisallowedTextControl(normalized)) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      "The biography must be valid plain text with at most 5000 characters.",
    );
  }
  return normalized;
}
function normalizeOptionalProfileText(value: string, label: string, maximumLength: number): string {
  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (normalized.length > maximumLength || containsDisallowedTextControl(normalized)) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      `${label} must be valid plain text with at most ${maximumLength} characters.`,
    );
  }
  return normalized;
}

function normalizeTransitionNote(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 1_000 ||
    containsDisallowedTextControl(normalized)
  ) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      "The transition note must contain at most 1000 valid plain-text characters.",
    );
  }
  return normalized;
}
function normalizeRejectionReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    containsDisallowedTextControl(normalized)
  ) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      "The asset rejection reason must contain at most 500 valid plain-text characters.",
    );
  }
  return normalized;
}
function capabilityError(error: unknown, message: string): SpeakerServiceError {
  const detail = error instanceof Error ? error.message.toLowerCase() : "";
  if (detail.includes("expired")) {
    return new SpeakerServiceError("CAPABILITY_EXPIRED", 410, message);
  }
  if (detail.includes("already been used") || detail.includes("already used")) {
    return new SpeakerServiceError("CAPABILITY_REPLAY", 409, message);
  }
  if (detail.includes("metadata") || detail.includes("size")) {
    return new SpeakerServiceError("UPLOAD_POLICY_VIOLATION", 400, message);
  }
  return new SpeakerServiceError("CAPABILITY_INVALID", 404, message);
}

function normalizeFileName(value: string): string {
  const normalized = stripFileNameControls(value.normalize("NFC").replace(/[\\/]/g, "-")).trim();
  if (normalized.length === 0 || normalized.length > 120 || normalized === ".") {
    throw new SpeakerServiceError(
      "UPLOAD_POLICY_VIOLATION",
      400,
      "The upload file name is not allowed.",
    );
  }
  return normalized;
}

function assertExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      "A non-negative expected version is required.",
    );
  }
}

function isSpeakerTransitionAllowed(task: SpeakerTask, toStatus: SpeakerTaskStatus): boolean {
  if (toStatus === "in_progress") {
    return ["not_started", "needs_changes", "overdue", "reopened"].includes(task.status);
  }
  if (toStatus === "submitted") {
    return (
      task.type !== "action" &&
      ["not_started", "in_progress", "needs_changes", "overdue", "reopened"].includes(task.status)
    );
  }
  if (toStatus === "completed") {
    return (
      task.type === "action" &&
      ["not_started", "in_progress", "overdue", "reopened"].includes(task.status)
    );
  }
  return false;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const MAX_REMINDER_OFFSET_COUNT = 24;
const MAX_REMINDER_OFFSET_MINUTES = 365 * 24 * 60;

function normalizeReminderOffsets(values: readonly number[]): number[] {
  if (
    values.length > MAX_REMINDER_OFFSET_COUNT ||
    values.some(
      (value) =>
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value % 60 !== 0 ||
        value > MAX_REMINDER_OFFSET_MINUTES,
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      "Reminder offsets must be unique whole-hour increments (multiples of 60 minutes), at most 24 values, each within one year.",
    );
  }
  return [...values].sort((left, right) => left - right);
}

function reminderCadenceWindow(
  deadlineAt: string | null,
  offsets: readonly number[],
  referenceNow: Date,
): string {
  const dueTime = deadlineAt === null ? Number.NaN : Date.parse(deadlineAt);
  if (!Number.isFinite(dueTime)) return "unscheduled";
  const thresholds = [
    ...new Set([
      dueTime,
      ...offsets
        .filter((offset) => Number.isSafeInteger(offset) && offset >= 0)
        .map((offset) => dueTime - offset * 60_000),
    ]),
  ].sort((left, right) => left - right);
  const active = thresholds.filter((threshold) => threshold <= referenceNow.getTime()).at(-1);
  const firstThreshold = thresholds[0] ?? dueTime;
  return active === undefined
    ? `before:${new Date(firstThreshold).toISOString()}`
    : new Date(active).toISOString();
}

function exportArchiveComponent(value: string | undefined, fallback: string): string {
  const normalized = stripFileNameControls((value ?? "").normalize("NFC").replace(/[\\/]/gu, "-"))
    .replace(/\.\.+/gu, "-")
    .replace(/[<>:"|?*]/gu, "-")
    .trim();
  if (normalized.length === 0 || normalized === "." || normalized === "..") return fallback;
  return normalized.slice(0, 100);
}

function archivePathWithCollision(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const separator = path.lastIndexOf("/");
  const prefix = separator < 0 ? "" : path.slice(0, separator + 1);
  const name = separator < 0 ? path : path.slice(separator + 1);
  const extensionIndex = name.lastIndexOf(".");
  const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  const extension = extensionIndex > 0 ? name.slice(extensionIndex) : "";
  let suffix = 2;
  let candidate = `${prefix}${stem}-${suffix}${extension}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${prefix}${stem}-${suffix}${extension}`;
  }
  used.add(candidate);
  return candidate;
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type SpeakerAssetFamilyPointers = {
  latest: SpeakerAsset;
  current?: SpeakerAsset;
  approved?: SpeakerAsset;
  released?: SpeakerAsset;
};

function assetFamilyPointers(
  assets: readonly SpeakerAsset[],
): SpeakerAssetFamilyPointers | undefined {
  if (assets.length === 0) return undefined;
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const supersededIds = new Set(
    assets.flatMap((asset) =>
      asset.supersedesAssetId === undefined ? [] : [asset.supersedesAssetId],
    ),
  );
  const terminal = assets.filter((asset) => !supersededIds.has(asset.id));
  if (terminal.length !== 1) return undefined;
  const latest = terminal[0];
  if (latest === undefined || latest.latestVersionId !== latest.id) return undefined;
  const resolve = (id: string | undefined, requireReady = true): SpeakerAsset | undefined => {
    if (id === undefined) return undefined;
    const candidate = byId.get(id);
    if (
      candidate === undefined ||
      (candidate.versionFamilyId ?? candidate.id) !== (latest.versionFamilyId ?? latest.id) ||
      (requireReady && candidate.state !== "ready")
    ) {
      return undefined;
    }
    return candidate;
  };
  const current = resolve(latest.currentVersionId);
  const approved = resolve(latest.approvedVersionId);
  const released = resolve(latest.releasedVersionId);
  if (
    (latest.currentVersionId !== undefined && current === undefined) ||
    (latest.approvedVersionId !== undefined && approved === undefined) ||
    (latest.releasedVersionId !== undefined && released === undefined)
  ) {
    return undefined;
  }
  return {
    latest,
    ...(current === undefined ? {} : { current }),
    ...(approved === undefined ? {} : { approved }),
    ...(released === undefined ? {} : { released }),
  };
}
function assetFamilies(assets: readonly SpeakerAsset[]): Map<string, SpeakerAsset[]> {
  const families = new Map<string, SpeakerAsset[]>();
  for (const asset of assets) {
    const familyId = asset.versionFamilyId ?? asset.id;
    families.set(familyId, [...(families.get(familyId) ?? []), asset]);
  }
  return families;
}

function singleCurrentAsset(assets: readonly SpeakerAsset[]): SpeakerAsset | undefined {
  const pointers = [...assetFamilies(assets).values()]
    .map(assetFamilyPointers)
    .filter((value): value is SpeakerAssetFamilyPointers => value !== undefined);
  return pointers.length === 1 ? pointers[0]?.current : undefined;
}

function speakerTaskSubject(task: SpeakerTask): SpeakerTaskSubject | undefined {
  const subject = task.subject;
  if (subject.type === "participant") return subject;
  if (subject.type === "session" && subject.sessionId.trim().length > 0) return subject;
  return undefined;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZipUInt16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeZipUInt32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

interface StoredArchiveFile {
  path: string;
  bytes: Uint8Array;
}

function createStoredZip(files: readonly StoredArchiveFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map((file) => ({ file, name: encoder.encode(file.path) }));
  const localSize = entries.reduce(
    (total, { file, name }) => total + 30 + name.byteLength + file.bytes.byteLength,
    0,
  );
  const centralSize = entries.reduce((total, { name }) => total + 46 + name.byteLength, 0);
  const totalSize = localSize + centralSize + 22;
  if (totalSize > bulkExportMaximumBytes) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      "The deliverables export exceeds the size limit.",
    );
  }
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  const offsets: number[] = [];
  let cursor = 0;

  for (const { file, name } of entries) {
    offsets.push(cursor);
    writeZipUInt32(view, cursor, 0x04034b50);
    writeZipUInt16(view, cursor + 4, 20);
    writeZipUInt16(view, cursor + 6, 0x0800);
    writeZipUInt16(view, cursor + 8, 0);
    writeZipUInt16(view, cursor + 10, 0);
    writeZipUInt16(view, cursor + 12, 33);
    writeZipUInt32(view, cursor + 14, crc32(file.bytes));
    writeZipUInt32(view, cursor + 18, file.bytes.byteLength);
    writeZipUInt32(view, cursor + 22, file.bytes.byteLength);
    writeZipUInt16(view, cursor + 26, name.byteLength);
    writeZipUInt16(view, cursor + 28, 0);
    cursor += 30;
    output.set(name, cursor);
    cursor += name.byteLength;
    output.set(file.bytes, cursor);
    cursor += file.bytes.byteLength;
  }

  const centralOffset = cursor;
  for (const [index, { file, name }] of entries.entries()) {
    const offset = offsets[index];
    if (offset === undefined) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "The deliverables export archive is invalid.",
      );
    }
    writeZipUInt32(view, cursor, 0x02014b50);
    writeZipUInt16(view, cursor + 4, 20);
    writeZipUInt16(view, cursor + 6, 20);
    writeZipUInt16(view, cursor + 8, 0x0800);
    writeZipUInt16(view, cursor + 10, 0);
    writeZipUInt16(view, cursor + 12, 0);
    writeZipUInt16(view, cursor + 14, 33);
    writeZipUInt32(view, cursor + 16, crc32(file.bytes));
    writeZipUInt32(view, cursor + 20, file.bytes.byteLength);
    writeZipUInt32(view, cursor + 24, file.bytes.byteLength);
    writeZipUInt16(view, cursor + 28, name.byteLength);
    writeZipUInt16(view, cursor + 30, 0);
    writeZipUInt16(view, cursor + 32, 0);
    writeZipUInt16(view, cursor + 34, 0);
    writeZipUInt16(view, cursor + 36, 0);
    writeZipUInt32(view, cursor + 38, 0);
    writeZipUInt32(view, cursor + 42, offset);
    cursor += 46;
    output.set(name, cursor);
    cursor += name.byteLength;
  }

  writeZipUInt32(view, cursor, 0x06054b50);
  writeZipUInt16(view, cursor + 4, 0);
  writeZipUInt16(view, cursor + 6, 0);
  writeZipUInt16(view, cursor + 8, entries.length);
  writeZipUInt16(view, cursor + 10, entries.length);
  writeZipUInt32(view, cursor + 12, centralSize);
  writeZipUInt32(view, cursor + 16, centralOffset);
  writeZipUInt16(view, cursor + 20, 0);
  return output;
}

function normalizeExportIds(
  values: readonly string[] | undefined,
  field: string,
): string[] | undefined {
  if (values === undefined) return undefined;
  const normalized = unique(values.map((value) => value.trim()));
  if (
    normalized.length === 0 ||
    normalized.some((value) => value.length === 0) ||
    normalized.length > bulkExportMaximumAssets
  ) {
    throw new SpeakerServiceError("VALIDATION_ERROR", 400, `The ${field} selection is invalid.`);
  }
  return normalized;
}

function deliverableStatusMatches(
  filter: SpeakerDeliverablesExportInput["status"],
  deliverableStatus: SpeakerDeliverableRow["status"],
): boolean {
  if (filter === undefined || filter === "all") return true;
  if (filter === "pending" || filter === "incomplete") {
    return !["completed", "waived", "uploaded"].includes(deliverableStatus);
  }
  return filter === "uploaded"
    ? ["uploaded", "completed", "waived"].includes(deliverableStatus)
    : deliverableStatus === filter;
}
function contextCapabilityAllows(
  scope: SpeakerAccessScope,
  capability: SpeakerPortalCapability,
  participantIds: readonly string[],
): boolean {
  const participantCapabilities = scope.capabilitiesByParticipant;
  if (participantIds.length > 0 && participantCapabilities !== undefined) {
    if (
      typeof participantCapabilities !== "object" ||
      participantCapabilities === null ||
      Array.isArray(participantCapabilities)
    ) {
      return false;
    }
    return participantIds.every((participantId) =>
      capabilityAllows(scope, capability, participantId),
    );
  }
  return capabilityAllows(scope, capability);
}

function assertCapability(
  scope: SpeakerAccessScope,
  capability: SpeakerPortalCapability,
  participantId?: string,
): void {
  if (!capabilityAllows(scope, capability, participantId)) throw notFound();
}

function normalizeUserText(
  value: string,
  label: string,
  maximumLength: number,
  allowNewlines = false,
): string {
  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        (codePoint === 0x7f ||
          (codePoint < 0x20 && codePoint !== 0x09 && (!allowNewlines || codePoint !== 0x0a)))
      );
    })
  ) {
    throw new SpeakerServiceError("VALIDATION_ERROR", 400, `${label} is not valid.`);
  }
  return normalized;
}

function sanitizePublishedHtml(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let sanitized = value.normalize("NFC");
  sanitized = sanitized.replace(
    /<\s*(script|style|iframe|object|embed|form|meta|link)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu,
    "",
  );
  sanitized = sanitized.replace(
    /<\s*(script|style|iframe|object|embed|form|meta|link)[^>]*\/?\s*>/giu,
    "",
  );
  sanitized = sanitized.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "");
  sanitized = sanitized.replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "");
  sanitized = sanitized.replace(
    /\s+(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu,
    (...args: [string, string, string, string | undefined, string | undefined]) => {
      const [, attribute, quotedDouble, quotedSingle, bare] = args;
      const candidate = quotedDouble ?? quotedSingle ?? bare ?? "";
      const safe = /^(?:https?:|mailto:|\/|#)/iu.test(candidate.trim()) ? candidate : "#";
      return ` ${attribute.toLowerCase()}="${safe.replaceAll('"', "&quot;")}"`;
    },
  );
  return sanitized.slice(0, 100_000);
}

function safePublishedUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function publicResource(resource: SpeakerEventResource): SpeakerEventResource {
  const html = sanitizePublishedHtml(resource.html);
  const url = safePublishedUrl(resource.url);
  return {
    id: resource.id,
    eventId: resource.eventId,
    title: normalizeUserText(resource.title, "The resource title", 200),
    ...(resource.summary === undefined
      ? {}
      : { summary: normalizeUserText(resource.summary, "The resource summary", 10_000, true) }),
    ...(html === undefined ? {} : { html }),
    ...(url === undefined ? {} : { url }),
    order: Number.isSafeInteger(resource.order) ? resource.order : 0,
    updatedAt: resource.updatedAt,
  };
}

function publicWikiPage(page: SpeakerWikiPage): SpeakerWikiPage {
  return {
    ...publicResource(page),
    ...(page.slug === undefined
      ? {}
      : { slug: normalizeUserText(page.slug, "The wiki slug", 160) }),
  };
}

function publicRosterMember(entry: SpeakerRosterEntry, canManage: boolean): SpeakerRosterMember {
  const isPrimary = entry.role === "primary";
  return {
    participantId: entry.participantId,
    displayName: entry.displayName,
    email: entry.email ?? null,
    role: isPrimary ? "primary" : "co_speaker",
    status: entry.status,
    capabilities: {
      edit: canManage && !isPrimary && entry.status !== "revoked",
      remove: canManage && !isPrimary && entry.status !== "revoked",
    },
  };
}
function publicTaskResponse(record: SpeakerTaskResponseRecord): SpeakerTaskResponse {
  return {
    responseId: record.id,
    definitionVersion: record.definitionVersion,
    answers: structuredClone(record.answers),
    submittedAt: record.submittedAt ?? null,
    status: record.status,
    organizerFeedback: record.feedback ?? null,
  };
}

function latestTaskResponse(
  records: readonly SpeakerTaskResponseRecord[],
): SpeakerTaskResponseRecord | undefined {
  return records
    .slice()
    .sort(
      (left, right) =>
        right.version - left.version || right.updatedAt.localeCompare(left.updatedAt),
    )[0];
}

function publicTaskForm(
  definition: SpeakerTaskFormDefinition,
  task: SpeakerTask,
  latestResponse: SpeakerTaskResponse | null,
): SpeakerTaskForm {
  const fields = definition.fields.map((field) => {
    const rawType = field.type ?? field.kind ?? "text";
    const type = rawType === "multi_select" ? "multiselect" : rawType;
    const options = (field.options ?? []).map((option) =>
      typeof option === "string"
        ? {
            value: normalizeUserText(option, "The task option", 200),
            label: normalizeUserText(option, "The task option", 200),
          }
        : {
            value: normalizeUserText(option.value, "The task option value", 200),
            label: normalizeUserText(option.label, "The task option label", 200),
          },
    );
    return {
      id: field.id,
      label: normalizeUserText(field.label, "The task field label", 200),
      type,
      required: field.required ?? false,
      options,
    };
  });
  return {
    taskId: definition.taskId,
    definitionVersion: definition.version,
    title: normalizeUserText(definition.title, "The task form title", 200),
    description:
      definition.description === undefined
        ? ""
        : normalizeUserText(definition.description, "The task form description", 10_000, true),
    status: task.status,
    fields,
    latestResponse,
  };
}
function publicTaskResponseEnvelope(
  scope: SpeakerAccessScope,
  task: SpeakerTask,
  records: readonly SpeakerTaskResponseRecord[],
): SpeakerTaskResponseEnvelope {
  const ordered = records.slice().sort((left, right) => left.version - right.version);
  const latest = latestTaskResponse(ordered);
  return {
    organizationId: scope.tenantId ?? task.eventId,
    eventId: task.eventId,
    taskId: task.id,
    participantId: task.participantId,
    latestResponse: latest === undefined ? null : publicTaskResponse(latest),
    history: ordered.map(publicTaskResponse),
  };
}

function answerIsEmpty(value: SpeakerFormAnswer | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function validateTaskAnswers(
  definition: SpeakerTaskFormDefinition,
  answers: Readonly<Record<string, SpeakerFormAnswer>>,
): Readonly<Record<string, SpeakerFormAnswer>> {
  const fields = definition.fields;
  const fieldByKey = new Map(
    fields.map((field) => [field.key ?? field.name ?? field.id, field] as const),
  );
  for (const key of Object.keys(answers)) {
    if (!fieldByKey.has(key)) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "The task response contains an unknown field.",
      );
    }
  }
  for (const field of fields) {
    const key = field.key ?? field.name ?? field.id;
    const value = answers[key];
    if (field.required && answerIsEmpty(value)) {
      throw new SpeakerServiceError("VALIDATION_ERROR", 400, `The task field ${key} is required.`);
    }
    if (answerIsEmpty(value)) continue;
    const type = field.type ?? field.kind ?? "text";
    const options = new Set(
      (field.options ?? []).map((option) => (typeof option === "string" ? option : option.value)),
    );
    if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        `The task field ${key} must be a number.`,
      );
    }
    if (["boolean", "checkbox"].includes(type) && typeof value !== "boolean") {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        `The task field ${key} must be boolean.`,
      );
    }
    if (
      ["select"].includes(type) &&
      (typeof value !== "string" || (options.size > 0 && !options.has(value)))
    ) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        `The task field ${key} has an invalid option.`,
      );
    }
    if (
      ["multi_select", "multiselect"].includes(type) &&
      (!Array.isArray(value) ||
        value.some(
          (entry) => typeof entry !== "string" || (options.size > 0 && !options.has(entry)),
        ))
    ) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        `The task field ${key} has invalid options.`,
      );
    }
    if (["text", "textarea", "rich_text", "email", "url", "date", "file_request"].includes(type)) {
      if (typeof value !== "string") {
        throw new SpeakerServiceError(
          "VALIDATION_ERROR",
          400,
          `The task field ${key} must be text.`,
        );
      }
      const normalized = normalizeUserText(
        value,
        `The task field ${key}`,
        field.maxLength ?? 20_000,
        true,
      );
      if (field.minLength !== undefined && normalized.length < field.minLength) {
        throw new SpeakerServiceError(
          "VALIDATION_ERROR",
          400,
          `The task field ${key} is too short.`,
        );
      }
      if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
        throw new SpeakerServiceError(
          "VALIDATION_ERROR",
          400,
          `The task field ${key} must be an email.`,
        );
      }
      if (type === "url" && safePublishedUrl(normalized) === undefined) {
        throw new SpeakerServiceError(
          "VALIDATION_ERROR",
          400,
          `The task field ${key} must be a safe URL.`,
        );
      }
    }
    if (type === "number" && field.min !== undefined && (value as number) < field.min) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        `The task field ${key} is below its minimum.`,
      );
    }
    if (type === "number" && field.max !== undefined && (value as number) > field.max) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        `The task field ${key} exceeds its maximum.`,
      );
    }
  }
  return structuredClone(answers);
}
function normalizeMimeTypes(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      "At least one allowed MIME type is required.",
    );
  }
  const normalized = unique(
    value.map((candidate) =>
      normalizeUserText(candidate, "The allowed MIME type", 120).toLowerCase(),
    ),
  );
  if (normalized.some((candidate) => !/^[\w!#$&^.+*-]+\/[\w!#$&^.+*-]+$/u.test(candidate))) {
    throw new SpeakerServiceError("VALIDATION_ERROR", 400, "The allowed MIME type is invalid.");
  }
  return normalized;
}

function normalizeMaxBytes(value: number | undefined): number {
  if (
    !Number.isSafeInteger(value) ||
    value === undefined ||
    value <= 0 ||
    value > 5 * 1024 * 1024 * 1024
  ) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      "maxBytes must be a positive safe integer.",
    );
  }
  return value;
}

function normalizeDueAt(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return strictCalendarDate(value, "The due date");
}
const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/u;

function strictCalendarDate(value: string, label: string): string {
  const normalized = value;
  if (!calendarDatePattern.test(normalized)) {
    throw new SpeakerServiceError("VALIDATION_ERROR", 400, `${label} must use YYYY-MM-DD.`);
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const roundTrip = new Date(0);
  roundTrip.setUTCFullYear(year ?? 0, (month ?? 0) - 1, day ?? 0);
  roundTrip.setUTCHours(0, 0, 0, 0);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new SpeakerServiceError("VALIDATION_ERROR", 400, `${label} is invalid.`);
  }
  return normalized;
}

function normalizeTravelLogistics(
  value: Partial<SpeakerTravelLogistics> | undefined,
  legacyTimeZone?: string,
): SpeakerTravelLogistics {
  const source = value ?? {};
  if (source.travelRequired !== undefined && typeof source.travelRequired !== "boolean") {
    throw new SpeakerServiceError("VALIDATION_ERROR", 400, "Travel required must be a boolean.");
  }
  const dateValue = (candidate: unknown, label: string): string | null => {
    if (candidate === undefined || candidate === null) return null;
    if (typeof candidate !== "string") {
      throw new SpeakerServiceError("VALIDATION_ERROR", 400, `${label} is invalid.`);
    }
    if (candidate.trim().length === 0) return null;
    if (legacyTimeZone !== undefined && !calendarDatePattern.test(candidate.trim())) {
      if (!Number.isFinite(Date.parse(candidate))) {
        throw new SpeakerServiceError("VALIDATION_ERROR", 400, `${label} is invalid.`);
      }
      return localDateInTimeZone(candidate, legacyTimeZone);
    }
    return strictCalendarDate(candidate, label);
  };
  const bounded = (candidate: unknown, label: string, maximum: number): string => {
    if (candidate === undefined) return "";
    if (typeof candidate !== "string") {
      throw new SpeakerServiceError("VALIDATION_ERROR", 400, `${label} is invalid.`);
    }
    return normalizeOptionalProfileText(candidate, label, maximum);
  };
  const arrivalAt = dateValue(source.arrivalAt, "Arrival date");
  const departureAt = dateValue(source.departureAt, "Departure date");
  if (arrivalAt !== null && departureAt !== null && arrivalAt > departureAt) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      "Departure date must be on or after arrival date.",
    );
  }
  return {
    travelRequired: source.travelRequired ?? false,
    arrivalAt,
    departureAt,
    accommodation: bounded(source.accommodation, "Accommodation", 500),
    dietaryRequirements: bounded(source.dietaryRequirements, "Dietary requirements", 2_000),
    accessibilityNeeds: bounded(source.accessibilityNeeds, "Accessibility needs", 2_000),
    travelNotes: bounded(source.travelNotes, "Travel notes", 5_000),
  };
}

function travelLogisticsFrom(value: unknown, legacyTimeZone?: string): SpeakerTravelLogistics {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return normalizeTravelLogistics(undefined, legacyTimeZone);
  }
  return normalizeTravelLogistics(
    value as Partial<SpeakerTravelLogistics>,
    legacyTimeZone ?? "UTC",
  );
}

const speakerSenderEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function requireSpeakerSender(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 320 ||
    value !== value.trim() ||
    /[\r\n]/u.test(value) ||
    !speakerSenderEmailPattern.test(value)
  ) {
    throw new TypeError("Speaker sender must be a valid email address.");
  }
  return value;
}

async function speakerSourceDigest(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeSocialLinks(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 20) {
    throw new SpeakerServiceError("VALIDATION_ERROR", 400, "Too many social links.");
  }
  const result: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    const normalizedKey = normalizeUserText(key, "The social link name", 80);
    const normalizedValue = normalizeUserText(rawValue, "The social link URL", 2_000);
    if (
      safePublishedUrl(normalizedValue) === undefined &&
      !/^@?[A-Za-z0-9._-]{1,200}$/u.test(normalizedValue)
    ) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "Social links must use HTTP(S) URLs or safe handles.",
      );
    }
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

function taskDeadlineEpoch(
  task: Pick<SpeakerTask, "dueAt" | "dueDate">,
  eventTimeZone: string | undefined,
): number | null {
  const dueDate = task.dueAt ?? task.dueDate;
  return dueDate === undefined || eventTimeZone === undefined
    ? null
    : calendarDateDeadline(dueDate, eventTimeZone).epochMilliseconds;
}

function taskIsOverdue(
  task: Pick<SpeakerTask, "dueAt" | "dueDate">,
  now: Date,
  eventTimeZone: string | undefined,
): boolean {
  const deadlineEpoch = taskDeadlineEpoch(task, eventTimeZone);
  return deadlineEpoch !== null && now.getTime() >= deadlineEpoch;
}

function taskStatusForAssets(
  task: SpeakerTask,
  assets: readonly SpeakerAsset[],
  now: Date,
  eventTimeZone: string | undefined,
): SpeakerDeliverableRow["status"] {
  const latest = assets
    .slice()
    .sort(
      (left, right) =>
        (right.version ?? 0) - (left.version ?? 0) || right.createdAt.localeCompare(left.createdAt),
    )[0];
  if (latest?.state === "ready") {
    if (latest.reviewState === "needs_changes") return "needs_changes";
    if (task.status === "completed" || task.status === "waived") return task.status;
    return "uploaded";
  }
  if (taskIsOverdue(task, now, eventTimeZone) && !["completed", "waived"].includes(task.status)) {
    return "overdue";
  }
  return task.status;
}
type SpeakerReminderRecipientBuilder = {
  participantId: string;
  displayName: string;
  email?: string;
  taskIds: string[];
  tasks: SpeakerReminderTask[];
};
const speakerImportMaximumBytes = 1_048_576;
const speakerImportMaximumRows = 500;
const speakerImportHeaderAliases: Readonly<Record<string, string>> = {
  displayname: "displayName",
  "display name": "displayName",
  name: "displayName",
  email: "email",
  jobtitle: "jobTitle",
  "job title": "jobTitle",
  title: "jobTitle",
  company: "company",
  biography: "biography",
  bio: "biography",
  twitter: "twitter",
  linkedin: "linkedin",
  website: "website",
  status: "status",
};

function parseCsvRows(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let sawQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
        sawQuote = true;
      }
      continue;
    }
    if (!quoted && character === ",") {
      row.push(field);
      field = "";
      sawQuote = false;
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((part) => part.trim().length > 0) || sawQuote) rows.push(row);
      row = [];
      field = "";
      sawQuote = false;
      continue;
    }
    if (!quoted && sawQuote) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "The CSV contains an invalid quoted field.",
      );
    }
    field += character;
  }
  if (quoted) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      "The CSV contains an unterminated quoted field.",
    );
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((part) => part.trim().length > 0) || sawQuote) rows.push(row);
  }
  return rows;
}

function importText(value: string, field: string, maximumLength: number): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length > maximumLength || containsDisallowedTextControl(normalized)) {
    throw new SpeakerServiceError("VALIDATION_ERROR", 400, `${field} is not valid.`);
  }
  return normalized;
}

function importEmail(value: string): string {
  const email = importText(value, "The speaker email", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new SpeakerServiceError("VALIDATION_ERROR", 400, "The speaker email is invalid.");
  }
  return email;
}
function canonicalSpeakerSubmissionId(value: string): string {
  const normalized = value.trim();
  return normalized.startsWith("speaker-submission:")
    ? normalized
    : `speaker-submission:${normalized}`;
}

function sameSpeakerSubmission(left: string, right: string): boolean {
  return canonicalSpeakerSubmissionId(left) === canonicalSpeakerSubmissionId(right);
}
function isOrganizerManagedRosterEntry(entry: SpeakerRosterEntry): boolean {
  return (
    entry.organizerStatus !== undefined &&
    (entry.sourceType === "manual" || entry.sourceType === "csv" || entry.sourceType === "crm")
  );
}
function organizerRecordTenantMatches(value: unknown, tenantId: string): boolean {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { tenantId?: unknown; organizationId?: unknown };
  return (
    (candidate.tenantId === undefined || candidate.tenantId === tenantId) &&
    (candidate.organizationId === undefined || candidate.organizationId === tenantId)
  );
}
function submissionIsVisibleToSpeaker(
  scope: SpeakerAccessScope,
  submission: SpeakerSubmission,
): boolean {
  return (
    submission.eventId.trim().length > 0 &&
    submission.status === "accepted" &&
    scope.submissionIds.some((allowed) => sameSpeakerSubmission(allowed, submission.id)) &&
    submission.participantIds.some((participantId) => scope.participantIds.includes(participantId))
  );
}
function authoritativeSubmissionPrimaryParticipantId(
  submission: SpeakerSubmission,
): string | undefined {
  if (
    submission.primaryParticipantId !== undefined &&
    submission.participantIds.includes(submission.primaryParticipantId)
  ) {
    return submission.primaryParticipantId;
  }
  return submission.participantIds.length === 1 ? submission.participantIds[0] : undefined;
}

function speakerOwnsAcceptedSubmission(
  scope: SpeakerAccessScope,
  submission: SpeakerSubmission,
): boolean {
  if (!submissionIsVisibleToSpeaker(scope, submission)) return false;
  const primaryParticipantId = authoritativeSubmissionPrimaryParticipantId(submission);
  if (primaryParticipantId === undefined) return false;
  return scope.primaryParticipantId === primaryParticipantId;
}

function rosterManagementAllowed(
  scope: SpeakerAccessScope,
  submission: SpeakerSubmission,
): boolean {
  const primaryParticipantId = authoritativeSubmissionPrimaryParticipantId(submission);
  if (
    primaryParticipantId === undefined ||
    !capabilityAllows(scope, "roster-manage", primaryParticipantId)
  ) {
    return false;
  }
  if (scope.organizer === true) {
    return submissionIsVisibleToSpeaker(scope, submission);
  }
  return speakerOwnsAcceptedSubmission(scope, submission);
}
function rosterManagementAllowedForParticipants(
  scope: SpeakerAccessScope,
  submission: SpeakerSubmission,
  participantIds: readonly string[],
): boolean {
  if (!rosterManagementAllowed(scope, submission)) return false;
  const primaryParticipantId = authoritativeSubmissionPrimaryParticipantId(submission);
  return primaryParticipantId !== undefined && participantIds.includes(primaryParticipantId);
}

function portalCapabilitiesForSubmissions(
  scope: SpeakerAccessScope,
  capabilities: readonly SpeakerPortalCapability[],
  participantIds: readonly string[],
  submissions: readonly SpeakerSubmission[],
): SpeakerPortalCapability[] {
  const projectedCapabilities =
    Array.isArray(capabilities) &&
    capabilities.every(
      (entry) =>
        typeof entry === "string" &&
        allSpeakerPortalCapabilities.includes(entry as SpeakerPortalCapability),
    )
      ? capabilities
      : [];
  const projected = projectedCapabilities.filter(
    (capability): capability is SpeakerPortalCapability =>
      allSpeakerPortalCapabilities.includes(capability) &&
      (capability !== "roster-manage" ||
        submissions.some((submission) =>
          rosterManagementAllowedForParticipants(scope, submission, participantIds),
        )) &&
      contextCapabilityAllows(scope, capability, participantIds),
  );
  if (
    submissions.some((submission) =>
      rosterManagementAllowedForParticipants(scope, submission, participantIds),
    ) &&
    !projected.includes("roster-manage")
  ) {
    projected.push("roster-manage");
  }
  return projected;
}
function portalPrimaryParticipantId(
  scope: SpeakerAccessScope,
  fallback?: string,
): string | undefined {
  const candidate =
    scope.primaryParticipantId?.trim() ||
    fallback?.trim() ||
    (scope.participantIds.length === 1 ? scope.participantIds[0] : undefined);
  return candidate !== undefined && candidate.length > 0 && scope.participantIds.includes(candidate)
    ? candidate
    : undefined;
}

function portalSubmissionBelongsToParticipant(
  submission: SpeakerSubmission,
  participantId: string,
): boolean {
  return (
    submission.participantIds.includes(participantId) ||
    submission.primaryParticipantId === participantId
  );
}

function portalScopeForPrimary(
  scope: SpeakerAccessScope,
  participantId: string,
  submissionIds: readonly string[],
): SpeakerAccessScope {
  const participantCapabilities = scope.capabilitiesByParticipant?.[participantId];
  return {
    ...scope,
    submissionIds: unique(submissionIds),
    participantIds: [participantId],
    primaryParticipantId: participantId,
    ...(scope.capabilitiesByParticipant === undefined
      ? {}
      : {
          capabilitiesByParticipant:
            participantCapabilities === undefined
              ? {}
              : { [participantId]: [...participantCapabilities] },
        }),
  };
}
type OrganizerSpeakerMutationProjection = {
  scope: SpeakerAccessScope & { tenantId: string; organizer: true };
  acceptedSubmissions: readonly SpeakerSubmission[];
  entries: SpeakerRosterEntry[];
  profiles: SpeakerProfile[];
  tasks: readonly SpeakerTask[];
  assets: readonly SpeakerAsset[];
  participantResolutions: Map<string, SpeakerParticipantResolution>;
};

export class SpeakerService {
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly assetCache = new Map<string, SpeakerAsset>();
  private readonly assetAuditCache = new Map<string, SpeakerAssetAuditEntry[]>();
  private readonly delivery: SpeakerReminderDelivery | undefined;
  private readonly speakerSender: string;
  private readonly communications: SpeakerCommunications | undefined;
  private readonly eventTemporalSource: SpeakerEventTemporalSource | undefined;
  private readonly sessionAuthority: SpeakerSessionAuthority | undefined;
  private readonly invitationCreator: SpeakerEventInvitationCreator | undefined;
  private readonly reminderCache = new Map<string, SpeakerReminderQueueResult>();

  constructor(
    private readonly repository: SpeakerRepository & Partial<SpeakerOrganizerLifecycleRepository>,
    private readonly assetGateway: PrivateAssetGateway,
    options: SpeakerServiceOptions,
  ) {
    this.speakerSender = requireSpeakerSender(options.speakerSender);
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
    this.delivery = options.delivery ?? options.invitationDelivery ?? options.reminderDelivery;
    this.communications = options.communications;
    this.eventTemporalSource = options.eventTemporalSource;
    this.sessionAuthority = options.sessionAuthority;
    this.invitationCreator = options.invitationCreator;
  }
  private async acceptedSession(
    organizationId: string,
    eventId: string,
    participantId: string,
    sessionId: string,
  ) {
    const session = await this.sessionAuthority?.getSession(organizationId, eventId, sessionId);
    if (
      session === null ||
      session === undefined ||
      session.tenantId !== organizationId ||
      session.eventId !== eventId ||
      session.status.toLowerCase() !== "accepted" ||
      !session.speakerIds.includes(participantId)
    ) {
      throw notFound();
    }
    return session;
  }

  private async eventTemporalContext(
    organizationId: string,
    eventId: string,
  ): Promise<SpeakerEventTemporalContext | undefined> {
    const context = await this.eventTemporalSource?.getEventTemporalContext(
      organizationId,
      eventId,
    );
    if (context === null || context === undefined) return undefined;
    if (context.organizationId !== organizationId || context.eventId !== eventId) throw notFound();
    localDateInTimeZone(this.now().toISOString(), context.timeZone);
    localDateInTimeZone(context.startsAt, context.timeZone);
    localDateInTimeZone(context.endsAt, context.timeZone);
    return context;
  }

  private async validateSelectedDeadline(
    organizationId: string,
    eventId: string,
    dueAt: string | undefined,
    unchangedValue?: string,
  ): Promise<void> {
    if (dueAt === undefined || dueAt === unchangedValue) return;
    const context = await this.eventTemporalContext(organizationId, eventId);
    if (context === undefined) return;
    const selectedDate = dueAt.length === 10 ? dueAt : localDateInTimeZone(dueAt, context.timeZone);
    const today = localDateInTimeZone(this.now().toISOString(), context.timeZone);
    if (selectedDate < today) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        `The due date must be on or after ${today} in ${context.timeZone}.`,
      );
    }
  }

  async resolveEventParticipant(
    input: Omit<ResolveEventParticipantInput, "createParticipantId">,
  ): Promise<SpeakerParticipantResolution> {
    const organizationId = normalizeUserText(input.organizationId, "The organization ID", 200);
    const eventId = normalizeUserText(input.eventId, "The event ID", 200);
    const sourceId = normalizeUserText(input.sourceId, "The participant source ID", 300);
    const explicitParticipantId =
      input.explicitParticipantId === undefined
        ? undefined
        : normalizeUserText(input.explicitParticipantId, "The participant ID", 300);
    const normalizedEmail =
      input.normalizedEmail === undefined ? undefined : importEmail(input.normalizedEmail);
    const createParticipantId = `participant:${this.generateId()}`;
    const resolution = await this.organizerLifecycle().resolveEventParticipant({
      organizationId,
      eventId,
      sourceType: input.sourceType,
      sourceId,
      ...(explicitParticipantId === undefined ? {} : { explicitParticipantId }),
      ...(normalizedEmail === undefined ? {} : { normalizedEmail }),
      createParticipantId,
    });
    if (resolution.state === "ambiguous") {
      return {
        state: "ambiguous",
        candidateParticipantIds: unique(
          resolution.candidateParticipantIds.map((participantId) => participantId.trim()),
        ).filter((participantId) => participantId.length > 0),
      };
    }
    const participantId = resolution.participantId.trim();
    if (participantId.length === 0) {
      throw new SpeakerServiceError("VALIDATION_ERROR", 400, "The speaker identity is invalid.");
    }
    return {
      state: "resolved",
      participantId,
      submissionIds: unique(resolution.submissionIds.map(canonicalSpeakerSubmissionId)),
      created: resolution.created,
    };
  }
  async listPortalContexts(accountId: string): Promise<SpeakerPortalContext[]> {
    if (accountId.trim().length === 0) throw notFound();
    const listContextScopes = this.repository.listPortalContextScopes;
    let contextScopes: readonly {
      context: SpeakerPortalContext;
      scope: SpeakerAccessScope;
    }[];
    if (listContextScopes !== undefined) {
      contextScopes = await listContextScopes.call(this.repository, accountId);
    } else {
      const listContexts = this.repository.listPortalContexts;
      if (listContexts === undefined) return [];
      const contexts = await listContexts.call(this.repository, accountId);
      const scopesByEvent = new Map<string, Promise<SpeakerAccessScope>>();
      for (const context of contexts) {
        if (context.eventId.trim().length === 0 || scopesByEvent.has(context.eventId)) continue;
        scopesByEvent.set(context.eventId, this.getScope(context.eventId, accountId));
      }
      contextScopes = await Promise.all(
        contexts.map(async (context) => ({
          context,
          scope: (await scopesByEvent.get(context.eventId)) ?? {
            submissionIds: [],
            participantIds: [],
          },
        })),
      );
    }
    const candidates = contextScopes.flatMap(({ context, scope }) => {
      const participantIds = unique(
        context.participantIds.filter((participantId) =>
          scope.participantIds.includes(participantId),
        ),
      );
      const contextSubmissionIds = unique(
        (context.submissionIds.length === 0 ? scope.submissionIds : context.submissionIds).filter(
          (submissionId) =>
            scope.submissionIds.some((allowed) => sameSpeakerSubmission(allowed, submissionId)),
        ),
      );
      if (
        context.eventId.trim().length === 0 ||
        (contextSubmissionIds.length === 0 && participantIds.length === 0)
      ) {
        return [];
      }
      const contextScope: SpeakerAccessScope = {
        ...scope,
        submissionIds: contextSubmissionIds,
        participantIds,
      };
      const primaryParticipantId = portalPrimaryParticipantId(
        contextScope,
        context.primaryParticipantId,
      );
      return [
        {
          context,
          contextSubmissionIds,
          contextScope,
          primaryParticipantId,
        },
      ];
    });
    const portalEventTenantKey = (eventId: string, organizationId: string | undefined): string =>
      JSON.stringify([organizationId ?? null, eventId]);
    const submissionIdsByEventTenant = new Map<
      string,
      { eventId: string; submissionIds: Set<string> }
    >();
    for (const { context, contextSubmissionIds, contextScope } of candidates) {
      const organizationId = contextScope.tenantId ?? context.organizationId;
      const key = portalEventTenantKey(context.eventId, organizationId);
      const batch = submissionIdsByEventTenant.get(key) ?? {
        eventId: context.eventId,
        submissionIds: new Set<string>(),
      };
      for (const submissionId of contextSubmissionIds) {
        batch.submissionIds.add(submissionId);
      }
      submissionIdsByEventTenant.set(key, batch);
    }
    const submissionsByEventTenant = new Map<string, Promise<readonly SpeakerSubmission[]>>();
    for (const [key, { eventId, submissionIds }] of submissionIdsByEventTenant) {
      submissionsByEventTenant.set(
        key,
        this.repository.listSubmissions(eventId, [...submissionIds]),
      );
    }
    const temporalByEventTenant = new Map<
      string,
      Promise<SpeakerEventTemporalContext | undefined>
    >();
    for (const { context, contextScope } of candidates) {
      const organizationId = contextScope.tenantId ?? context.organizationId;
      if (organizationId === undefined) continue;
      const key = portalEventTenantKey(context.eventId, organizationId);
      if (!temporalByEventTenant.has(key)) {
        temporalByEventTenant.set(key, this.eventTemporalContext(organizationId, context.eventId));
      }
    }
    const visibleSubmissionsByContext = new Map<string, Map<string, SpeakerSubmission[]>>();
    const projected = await Promise.all(
      candidates.map(
        async ({
          context,
          contextSubmissionIds,
          contextScope,
          primaryParticipantId,
        }): Promise<SpeakerPortalContext | undefined> => {
          const organizationId = contextScope.tenantId ?? context.organizationId;
          const eventTenantKey = portalEventTenantKey(context.eventId, organizationId);
          const submissions = (await submissionsByEventTenant.get(eventTenantKey)) ?? [];
          const submissionIndexKey = JSON.stringify([eventTenantKey, primaryParticipantId ?? null]);
          let submissionsByCanonicalId = visibleSubmissionsByContext.get(submissionIndexKey);
          if (submissionsByCanonicalId === undefined) {
            submissionsByCanonicalId = new Map<string, SpeakerSubmission[]>();
            for (const submission of submissions) {
              if (
                submission.eventId !== context.eventId ||
                (primaryParticipantId !== undefined &&
                  !portalSubmissionBelongsToParticipant(submission, primaryParticipantId))
              ) {
                continue;
              }
              const canonicalId = canonicalSpeakerSubmissionId(submission.id);
              const matches = submissionsByCanonicalId.get(canonicalId);
              if (matches === undefined) {
                submissionsByCanonicalId.set(canonicalId, [submission]);
              } else {
                matches.push(submission);
              }
            }
            visibleSubmissionsByContext.set(submissionIndexKey, submissionsByCanonicalId);
          }
          const visibleById = new Map<string, SpeakerSubmission>();
          for (const requestedId of contextSubmissionIds) {
            const matches =
              submissionsByCanonicalId.get(canonicalSpeakerSubmissionId(requestedId)) ?? [];
            const selected =
              matches.find((submission) => submission.id === requestedId) ??
              matches.find(
                (submission) => submission.id === canonicalSpeakerSubmissionId(requestedId),
              ) ??
              (matches.length === 1 ? matches[0] : undefined);
            if (selected !== undefined) visibleById.set(selected.id, selected);
          }
          const visibleSubmissions = [...visibleById.values()];
          const submissionIds = unique(visibleSubmissions.map((submission) => submission.id));
          if (submissionIds.length === 0 && primaryParticipantId === undefined) return undefined;
          const projectedScope =
            primaryParticipantId === undefined
              ? { ...contextScope, submissionIds, participantIds: [] }
              : portalScopeForPrimary(contextScope, primaryParticipantId, submissionIds);
          const capabilities = portalCapabilitiesForSubmissions(
            projectedScope,
            context.capabilities,
            primaryParticipantId === undefined ? [] : [primaryParticipantId],
            visibleSubmissions,
          );
          const temporalContext =
            organizationId === undefined
              ? undefined
              : await temporalByEventTenant.get(eventTenantKey);
          return {
            id: context.id,
            eventId: context.eventId,
            name: context.name,
            ...(context.slug === undefined ? {} : { slug: context.slug }),
            capabilities,
            submissionIds,
            participantIds: primaryParticipantId === undefined ? [] : [primaryParticipantId],
            ...(primaryParticipantId === undefined ? {} : { primaryParticipantId }),
            ...(temporalContext === undefined ? {} : { temporalContext }),
          };
        },
      ),
    );
    const projectedContexts = projected.flatMap((context) =>
      context === undefined ? [] : [context],
    );
    return projectedContexts
      .filter(
        (context) =>
          context.submissionIds.length > 0 ||
          !projectedContexts.some(
            (candidate) =>
              candidate.id !== context.id &&
              candidate.eventId === context.eventId &&
              candidate.submissionIds.length > 0 &&
              candidate.participantIds.some((participantId) =>
                context.participantIds.includes(participantId),
              ),
          ),
      )
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) || left.eventId.localeCompare(right.eventId),
      );
  }

  async getPortalContext(eventId: string, accountId: string): Promise<SpeakerPortalContext> {
    const scope = await this.getScope(eventId, accountId);
    if (scope.submissionIds.length === 0 && scope.participantIds.length === 0) throw notFound();
    const discoveredContexts = (await this.listPortalContexts(accountId)).filter(
      (context) => context.eventId === eventId,
    );
    if (discoveredContexts.length > 1) throw notFound();
    const discovered = discoveredContexts[0];
    if (discovered !== undefined) return discovered;

    const primaryParticipantId = portalPrimaryParticipantId(scope);
    const submissions = this.projectSubmissions(
      eventId,
      scope,
      await this.repository.listSubmissions(eventId, scope.submissionIds),
    ).filter(
      (submission) =>
        primaryParticipantId === undefined ||
        portalSubmissionBelongsToParticipant(submission, primaryParticipantId),
    );
    if (submissions.length === 0 && primaryParticipantId === undefined) throw notFound();
    const submissionIds = submissions.map((submission) => submission.id);
    const projectedScope =
      primaryParticipantId === undefined
        ? { ...scope, submissionIds, participantIds: [] }
        : portalScopeForPrimary(scope, primaryParticipantId, submissionIds);
    const capabilities = portalCapabilitiesForSubmissions(
      projectedScope,
      Array.isArray(scope.capabilities) ? scope.capabilities : [],
      primaryParticipantId === undefined ? [] : [primaryParticipantId],
      submissions,
    );
    const temporalContext =
      scope.tenantId === undefined
        ? undefined
        : await this.eventTemporalContext(scope.tenantId, eventId);
    return {
      id: `portal:${eventId}`,
      eventId,
      name: eventId,
      capabilities,
      ...(temporalContext === undefined ? {} : { temporalContext }),
      submissionIds: unique(submissionIds),
      participantIds: primaryParticipantId === undefined ? [] : [primaryParticipantId],
      ...(primaryParticipantId === undefined ? {} : { primaryParticipantId }),
    };
  }

  async getPortal(eventId: string, accountId: string): Promise<SpeakerPortalView> {
    const scope = await this.getScope(eventId, accountId);
    if (scope.submissionIds.length === 0 && scope.participantIds.length === 0) throw notFound();
    const primaryParticipantId = portalPrimaryParticipantId(scope);
    const temporalContextPromise: Promise<SpeakerEventTemporalContext | undefined> =
      scope.tenantId === undefined
        ? Promise.resolve(undefined)
        : this.eventTemporalContext(scope.tenantId, eventId);
    const listRosterForEvent = this.repository.listRosterForEvent;
    const prefetchedRosterPromise: Promise<readonly SpeakerRosterEntry[] | undefined> =
      primaryParticipantId === undefined || listRosterForEvent === undefined
        ? Promise.resolve(undefined)
        : listRosterForEvent.call(this.repository, eventId).then(
            (value) => value,
            () => undefined,
          );

    const rawSubmissionsPromise = this.repository.listSubmissions(eventId, scope.submissionIds);
    const rawProfilesPromise =
      primaryParticipantId === undefined
        ? Promise.resolve([])
        : this.repository.listProfiles(eventId, [primaryParticipantId]);
    const rawTasksPromise =
      primaryParticipantId === undefined ||
      !contextCapabilityAllows(scope, "task-response", [primaryParticipantId])
        ? Promise.resolve([])
        : this.repository.listTasks(eventId, [primaryParticipantId]);
    const contextsPromise: Promise<readonly SpeakerPortalContext[]> =
      this.repository.listPortalContexts === undefined
        ? Promise.resolve([])
        : this.repository.listPortalContexts(accountId);
    const assetsPromise: Promise<readonly SpeakerAsset[] | undefined> =
      primaryParticipantId !== undefined &&
      contextCapabilityAllows(scope, "asset-read", [primaryParticipantId]) &&
      this.repository.listAssets !== undefined
        ? this.repository.listAssets(eventId, [primaryParticipantId])
        : Promise.resolve(undefined);
    const resourceParticipants = primaryParticipantId === undefined ? [] : [primaryParticipantId];
    const resourcesPromise: Promise<readonly SpeakerEventResource[] | undefined> =
      this.repository.listEventResources === undefined
        ? Promise.resolve(undefined)
        : contextCapabilityAllows(scope, "resource-read", resourceParticipants)
          ? this.repository.listEventResources(eventId).then(
              (value) => value,
              () => undefined,
            )
          : Promise.resolve(undefined);
    const wikiPromise: Promise<readonly SpeakerWikiPage[] | undefined> =
      this.repository.listWikiPages === undefined
        ? Promise.resolve(undefined)
        : contextCapabilityAllows(scope, "resource-read", resourceParticipants)
          ? this.repository.listWikiPages(eventId).then(
              (value) => value,
              () => undefined,
            )
          : Promise.resolve(undefined);

    const [
      rawSubmissions,
      rawProfiles,
      rawTasks,
      contexts,
      rawAssets,
      rawResources,
      rawWiki,
      prefetchedRoster,
      temporalContext,
    ] = await Promise.all([
      rawSubmissionsPromise,
      rawProfilesPromise,
      rawTasksPromise,
      contextsPromise,
      assetsPromise,
      resourcesPromise,
      wikiPromise,
      prefetchedRosterPromise,
      temporalContextPromise,
    ]);
    const submissions = this.projectSubmissions(eventId, scope, rawSubmissions)
      .filter(
        (submission) =>
          primaryParticipantId === undefined ||
          portalSubmissionBelongsToParticipant(submission, primaryParticipantId),
      )
      .map((submission) =>
        primaryParticipantId === undefined
          ? structuredClone(submission)
          : {
              ...structuredClone(submission),
              participantIds: [primaryParticipantId],
              primaryParticipantId,
            },
      );
    if (submissions.length === 0 && primaryParticipantId === undefined) throw notFound();
    const projectedScope =
      primaryParticipantId === undefined
        ? {
            ...scope,
            submissionIds: submissions.map((submission) => submission.id),
            participantIds: [],
          }
        : portalScopeForPrimary(
            scope,
            primaryParticipantId,
            submissions.map((submission) => submission.id),
          );
    const profiles = this.projectProfiles(eventId, projectedScope, rawProfiles);
    const tasks = await this.projectTasks(eventId, projectedScope, rawTasks, submissions);
    const projectedContext = this.projectPortalContext(
      eventId,
      projectedScope,
      submissions,
      contexts,
    );
    const context = {
      ...projectedContext,
      ...(temporalContext === undefined ? {} : { temporalContext }),
    };
    const rosterSubmission = submissions.find((submission) => submission.status === "accepted");
    const rawRoster =
      primaryParticipantId === undefined ||
      rosterSubmission === undefined ||
      !submissionIsVisibleToSpeaker(projectedScope, rosterSubmission) ||
      (prefetchedRoster === undefined && this.repository.listRoster === undefined)
        ? undefined
        : await this.rosterForScope(
            eventId,
            projectedScope,
            rosterSubmission,
            profiles,
            prefetchedRoster,
          );
    const roster =
      rawRoster === undefined
        ? undefined
        : {
            ...rawRoster,
            members: rawRoster.members.filter(
              (member) => member.participantId === primaryParticipantId,
            ),
          };
    const portalCapabilities = portalCapabilitiesForSubmissions(
      projectedScope,
      context.capabilities,
      primaryParticipantId === undefined ? [] : [primaryParticipantId],
      submissions,
    );
    const assets =
      rawAssets === undefined
        ? undefined
        : (
            await Promise.all(
              rawAssets.map(async (asset) =>
                asset.eventId === eventId &&
                primaryParticipantId !== undefined &&
                asset.participantId === primaryParticipantId &&
                (asset.tenantId === undefined ||
                  projectedScope.tenantId === undefined ||
                  asset.tenantId === projectedScope.tenantId) &&
                (await this.speakerAssetAllowedByScope(projectedScope, eventId, asset))
                  ? { ...asset }
                  : undefined,
              ),
            )
          ).filter((asset): asset is SpeakerAsset => asset !== undefined);
    const resources =
      rawResources === undefined
        ? undefined
        : rawResources
            .filter((resource) => resource.eventId === eventId)
            .map(publicResource)
            .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    const wiki =
      rawWiki === undefined
        ? undefined
        : rawWiki
            .filter((page) => page.eventId === eventId)
            .map(publicWikiPage)
            .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

    return {
      submissions,
      profiles,
      tasks,
      outstandingTaskCount: tasks.filter(
        (task) => task.status !== "completed" && task.status !== "waived",
      ).length,
      context: {
        ...context,
        submissionIds: unique(submissions.map((submission) => submission.id)),
        participantIds: primaryParticipantId === undefined ? [] : [primaryParticipantId],
        ...(primaryParticipantId === undefined ? {} : { primaryParticipantId }),
      },
      capabilities: portalCapabilities,
      ...(roster === undefined ? {} : { roster }),
      ...(assets === undefined ? {} : { assets }),
      ...(resources === undefined ? {} : { resources }),
      ...(wiki === undefined ? {} : { wiki }),
    };
  }

  async listSubmissions(eventId: string, accountId: string): Promise<SpeakerSubmission[]> {
    const scope = await this.getScope(eventId, accountId);
    return this.projectSubmissions(
      eventId,
      scope,
      await this.repository.listSubmissions(eventId, scope.submissionIds),
    );
  }

  async listProfiles(eventId: string, accountId: string): Promise<SpeakerProfile[]> {
    const scope = await this.getScope(eventId, accountId);
    return this.projectProfiles(
      eventId,
      scope,
      await this.repository.listProfiles(eventId, scope.participantIds),
    );
  }

  async listTasks(eventId: string, accountId: string): Promise<SpeakerTask[]> {
    const scope = await this.getScope(eventId, accountId);
    const [rawTasks, submissions] = await Promise.all([
      this.repository.listTasks(eventId, scope.participantIds),
      this.repository.listSubmissions(eventId, scope.submissionIds),
    ]);
    return await this.projectTasks(eventId, scope, rawTasks, submissions);
  }
  private projectSubmissions(
    eventId: string,
    scope: SpeakerAccessScope,
    submissions: readonly SpeakerSubmission[],
  ): SpeakerSubmission[] {
    const byCanonicalId = new Map<string, SpeakerSubmission>();
    for (const submission of submissions) {
      if (
        submission.eventId !== eventId ||
        !scope.submissionIds.some((allowed) => sameSpeakerSubmission(allowed, submission.id))
      ) {
        continue;
      }
      const canonicalId = canonicalSpeakerSubmissionId(submission.id);
      const existing = byCanonicalId.get(canonicalId);
      if (
        existing === undefined ||
        (submission.id === canonicalId && existing.id !== canonicalId) ||
        (submission.status === "accepted" && existing.status !== "accepted")
      ) {
        byCanonicalId.set(canonicalId, submission);
      }
    }
    return [...byCanonicalId.values()];
  }

  private projectProfiles(
    eventId: string,
    scope: SpeakerAccessScope,
    profiles: readonly SpeakerProfile[],
  ): SpeakerProfile[] {
    const allowedIds = new Set(scope.participantIds);
    return profiles.filter(
      (profile) => profile.eventId === eventId && allowedIds.has(profile.participantId),
    );
  }

  private async projectTask(
    eventId: string,
    scope: SpeakerAccessScope,
    task: SpeakerTask,
  ): Promise<SpeakerTask | undefined> {
    const subject = speakerTaskSubject(task);
    if (
      subject === undefined ||
      task.eventId !== eventId ||
      task.owner !== "speaker" ||
      !scope.participantIds.includes(task.participantId) ||
      !capabilityAllows(scope, "task-response", task.participantId)
    ) {
      return undefined;
    }
    if (subject.type === "participant") return structuredClone(task);
    if (scope.tenantId === undefined) return undefined;
    try {
      const session = await this.acceptedSession(
        scope.tenantId,
        eventId,
        task.participantId,
        subject.sessionId,
      );
      return { ...structuredClone(task), sessionTitle: session.title };
    } catch {
      return undefined;
    }
  }

  private async projectTasks(
    eventId: string,
    scope: SpeakerAccessScope,
    tasks: readonly SpeakerTask[],
    _submissions: readonly SpeakerSubmission[],
  ): Promise<SpeakerTask[]> {
    return (await Promise.all(tasks.map((task) => this.projectTask(eventId, scope, task)))).filter(
      (task): task is SpeakerTask => task !== undefined,
    );
  }

  private projectPortalContext(
    eventId: string,
    scope: SpeakerAccessScope,
    submissions: readonly SpeakerSubmission[],
    contexts: readonly SpeakerPortalContext[],
  ): SpeakerPortalContext {
    const discoveredContexts = contexts.filter(
      (context) =>
        context.eventId === eventId &&
        (context.submissionIds.length === 0 ||
          context.submissionIds.some((submissionId) =>
            scope.submissionIds.some((allowed) => sameSpeakerSubmission(allowed, submissionId)),
          )) &&
        (context.participantIds.length === 0 ||
          context.participantIds.some((participantId) =>
            scope.participantIds.includes(participantId),
          )),
    );
    if (discoveredContexts.length > 1) throw notFound();
    const discovered = discoveredContexts[0];
    if (discovered !== undefined) {
      const submissionIds = unique(
        discovered.submissionIds.length === 0
          ? scope.submissionIds
          : discovered.submissionIds.filter((id) =>
              scope.submissionIds.some((allowed) => sameSpeakerSubmission(allowed, id)),
            ),
      );
      const participantIds = unique(
        discovered.participantIds.length === 0
          ? scope.participantIds
          : discovered.participantIds.filter((id) => scope.participantIds.includes(id)),
      );
      const visibleSubmissions = submissions.filter(
        (submission) =>
          submission.eventId === eventId &&
          (submissionIds.length === 0 ||
            submissionIds.some((allowed) => sameSpeakerSubmission(allowed, submission.id))),
      );
      const resolvedSubmissionIds = unique([
        ...submissionIds,
        ...visibleSubmissions.map((submission) => submission.id),
      ]);
      const capabilities = portalCapabilitiesForSubmissions(
        scope,
        discovered.capabilities,
        participantIds,
        visibleSubmissions,
      );
      const primaryParticipantId =
        discovered.primaryParticipantId !== undefined &&
        participantIds.includes(discovered.primaryParticipantId)
          ? discovered.primaryParticipantId
          : scope.primaryParticipantId !== undefined &&
              participantIds.includes(scope.primaryParticipantId)
            ? scope.primaryParticipantId
            : undefined;
      return {
        ...discovered,
        submissionIds: resolvedSubmissionIds,
        participantIds,
        capabilities,
        ...(primaryParticipantId === undefined ? {} : { primaryParticipantId }),
      };
    }

    if (!submissions.some((submission) => submission.eventId === eventId)) throw notFound();
    const capabilities = portalCapabilitiesForSubmissions(
      scope,
      Array.isArray(scope.capabilities) ? scope.capabilities : [],
      scope.participantIds,
      submissions,
    );
    return {
      id: `portal:${eventId}`,
      eventId,
      name: eventId,
      capabilities,
      submissionIds: unique([
        ...scope.submissionIds,
        ...submissions.map((submission) => submission.id),
      ]),
      participantIds: unique(scope.participantIds),
      ...(scope.primaryParticipantId === undefined
        ? {}
        : { primaryParticipantId: scope.primaryParticipantId }),
    };
  }

  private async rosterForScope(
    eventId: string,
    scope: SpeakerAccessScope,
    submission: SpeakerSubmission,
    profiles: readonly SpeakerProfile[],
    prefetchedRoster?: readonly SpeakerRosterEntry[],
  ): Promise<SpeakerRosterEnvelope> {
    if (!submissionIsVisibleToSpeaker(scope, submission)) {
      throw notFound();
    }
    const canonicalSubmissionId = canonicalSpeakerSubmissionId(submission.id);
    let rosterEntries: readonly SpeakerRosterEntry[];
    if (prefetchedRoster !== undefined) {
      rosterEntries = prefetchedRoster;
    } else {
      const listRoster = this.repository.listRoster;
      if (listRoster === undefined) throw notFound();
      rosterEntries = await listRoster.call(this.repository, eventId, canonicalSubmissionId);
    }
    const stored = rosterEntries.filter(
      (entry) =>
        entry.eventId === eventId &&
        entry.submissionId !== undefined &&
        sameSpeakerSubmission(entry.submissionId, canonicalSubmissionId),
    );
    const byParticipant = new Map<string, SpeakerRosterEntry>();
    for (const entry of stored) {
      const existing = byParticipant.get(entry.participantId);
      if (
        existing === undefined ||
        entry.version > existing.version ||
        (entry.version === existing.version && entry.updatedAt > existing.updatedAt)
      ) {
        byParticipant.set(entry.participantId, entry);
      }
    }
    const missingParticipantIds = submission.participantIds.filter(
      (participantId) => !byParticipant.has(participantId),
    );
    const profileByParticipant = new Map(
      profiles.map((profile) => [profile.participantId, profile]),
    );
    const primaryParticipantId = authoritativeSubmissionPrimaryParticipantId(submission);
    for (const participantId of missingParticipantIds) {
      const profile = profileByParticipant.get(participantId);
      const createdAt = submission.updatedAt;
      byParticipant.set(participantId, {
        id: `roster:${eventId}:${canonicalSubmissionId}:${participantId}`,
        eventId,
        submissionId: canonicalSubmissionId,
        participantId,
        displayName: profile?.displayName ?? participantId,
        role: participantId === primaryParticipantId ? "primary" : "co_speaker",
        status: "active",
        version: 1,
        createdAt,
        updatedAt: createdAt,
      });
    }
    const canManage = rosterManagementAllowed(scope, submission);
    return {
      organizationId: scope.tenantId ?? eventId,
      eventId,
      submissionId: submission.id,
      capabilities: {
        manage: canManage,
        invite: canManage,
      },
      members: [...byParticipant.values()]
        .sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
        )
        .map((entry) => publicRosterMember(entry, canManage)),
    };
  }

  async listOrganizerTasks(eventId: string, accountId: string): Promise<SpeakerTask[]> {
    const getOrganizerReadModel = this.repository.getOrganizerReadModel;
    if (getOrganizerReadModel !== undefined) {
      const model = await getOrganizerReadModel.call(this.repository, eventId, accountId, {
        profiles: true,
        tasks: true,
      });
      if (model === null) throw notFound();
      const scope = this.readModelScope(model, eventId);
      const acceptedSubmissions = this.acceptedOrganizerSubmissionsFrom(
        eventId,
        scope,
        model.submissions,
      );
      const roster = this.organizerRosterEntriesFromReadModel(
        eventId,
        scope,
        model.roster,
        model.profiles,
      );
      return await this.organizerTasksFromSources(
        eventId,
        scope,
        acceptedSubmissions,
        roster,
        model.tasks,
      );
    }

    const scope = await this.requireOrganizerScope(eventId, accountId);
    const [acceptedSubmissions, roster] = await Promise.all([
      this.acceptedOrganizerSubmissions(eventId, scope),
      this.organizerRosterEntries(scope.tenantId, eventId, scope, accountId),
    ]);
    const participantIds = unique([
      ...acceptedSubmissions.flatMap((submission) =>
        submission.participantIds.filter((participantId) =>
          scope.participantIds.includes(participantId),
        ),
      ),
      ...roster.filter(isOrganizerManagedRosterEntry).map((entry) => entry.participantId),
    ]);
    const tasks = await this.repository.listTasks(eventId, participantIds);
    return await this.organizerTasksFromSources(eventId, scope, acceptedSubmissions, roster, tasks);
  }

  private async organizerTasksFromSources(
    eventId: string,
    scope: SpeakerAccessScope,
    acceptedSubmissions: readonly SpeakerSubmission[],
    roster: readonly SpeakerRosterEntry[],
    tasks: readonly SpeakerTask[],
  ): Promise<SpeakerTask[]> {
    const manualByParticipant = new Map(
      roster.filter(isOrganizerManagedRosterEntry).map((entry) => [entry.participantId, entry]),
    );
    const acceptedParticipantIds = new Set(
      acceptedSubmissions.flatMap((submission) =>
        submission.participantIds.filter((participantId) =>
          scope.participantIds.includes(participantId),
        ),
      ),
    );
    const participantIds = new Set([...acceptedParticipantIds, ...manualByParticipant.keys()]);
    const participantNames = new Map(
      roster.map((entry) => [entry.participantId, entry.displayName]),
    );
    const visible = await Promise.all(
      tasks.map(async (task) => {
        const subject = speakerTaskSubject(task);
        if (
          subject === undefined ||
          task.eventId !== eventId ||
          !participantIds.has(task.participantId)
        ) {
          return undefined;
        }
        if (subject.type === "participant") {
          return { task, sessionTitle: undefined };
        }
        try {
          const session = await this.acceptedSession(
            scope.tenantId ?? task.tenantId ?? "",
            eventId,
            task.participantId,
            subject.sessionId,
          );
          return { task, sessionTitle: session.title };
        } catch {
          return undefined;
        }
      }),
    );
    return visible
      .filter(
        (value): value is { task: SpeakerTask; sessionTitle: string | undefined } =>
          value !== undefined,
      )
      .map(({ task, sessionTitle }) => {
        const participantName = participantNames.get(task.participantId);
        return {
          ...structuredClone(task),
          ...(participantName === undefined ? {} : { participantName }),
          sessionTitle: sessionTitle ?? "General",
        };
      })
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      );
  }

  async createOrganizerTask(input: SpeakerTaskCreateInput): Promise<SpeakerTask[]> {
    const scope = await this.requireOrganizerScope(input.eventId, input.accountId);
    const assignments = input.assignments.map(({ participantId, subject }) => ({
      participantId: participantId.trim(),
      subject:
        subject.type === "participant"
          ? { type: "participant" as const, participantId: participantId.trim() }
          : {
              type: "session" as const,
              participantId: participantId.trim(),
              sessionId: subject.sessionId.trim(),
            },
    }));
    const assignmentKeys = assignments.map(
      (assignment) =>
        `${assignment.participantId}\u0000${
          assignment.subject.type === "session" ? assignment.subject.sessionId : ""
        }`,
    );
    if (
      assignments.length === 0 ||
      assignments.some(
        (assignment) =>
          assignment.participantId.length === 0 ||
          (assignment.subject.type === "session" && assignment.subject.sessionId.length === 0),
      ) ||
      new Set(assignmentKeys).size !== assignmentKeys.length
    ) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "Task assignments must contain unique participant and session pairs.",
      );
    }
    const organizerRoster = await this.organizerRosterEntries(
      scope.tenantId,
      input.eventId,
      scope,
      input.accountId,
    );
    const manualParticipantIds = new Set(
      organizerRoster
        .filter((entry) => isOrganizerManagedRosterEntry(entry) && entry.status !== "revoked")
        .map((entry) => entry.participantId),
    );
    for (const assignment of assignments) {
      if (
        !scope.participantIds.includes(assignment.participantId) &&
        !manualParticipantIds.has(assignment.participantId)
      ) {
        throw notFound();
      }
      if (assignment.subject.type === "session") {
        await this.acceptedSession(
          scope.tenantId,
          input.eventId,
          assignment.participantId,
          assignment.subject.sessionId,
        );
      }
    }
    const title = normalizeUserText(input.title, "The task title", 200);
    const description =
      input.description === undefined
        ? input.instructions === undefined
          ? undefined
          : normalizeUserText(input.instructions, "The task instructions", 10_000, true)
        : normalizeUserText(input.description, "The task description", 10_000, true);
    const instructions =
      input.instructions === undefined
        ? description
        : normalizeUserText(input.instructions, "The task instructions", 10_000, true);
    const dueAt = normalizeDueAt(input.dueAt ?? input.dueDate);
    await this.validateSelectedDeadline(scope.tenantId, input.eventId, dueAt);
    const allowedMimeTypes = normalizeMimeTypes(input.allowedMimeTypes);
    const maxBytes =
      input.maxBytes === undefined && input.maxSizeBytes === undefined
        ? undefined
        : normalizeMaxBytes(input.maxBytes ?? input.maxSizeBytes);
    if (input.type === "upload" && (allowedMimeTypes.length === 0 || maxBytes === undefined)) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "Upload tasks require allowed MIME types and maxBytes.",
      );
    }

    const tasks: SpeakerTask[] = [];
    const baseId = this.generateId();
    for (const [index, assignment] of assignments.entries()) {
      const subject = assignment.subject;
      const task: SpeakerTask = {
        id: assignments.length === 1 ? baseId : `${baseId}:assignment:${index + 1}`,
        definitionId: baseId,
        eventId: input.eventId,
        participantId: assignment.participantId,
        subject,
        type: input.type,
        owner: "speaker",
        title,
        ...(description === undefined
          ? instructions === undefined
            ? {}
            : { instructions }
          : instructions === undefined
            ? { description }
            : { description, instructions }),
        status: "not_started",
        ...(dueAt === undefined ? {} : { dueAt, dueDate: dueAt }),
        dependencyIds: unique(input.dependencyIds ?? []),
        reminderOffsetsMinutes: [...(input.reminderOffsetsMinutes ?? [])],
        ...(input.acceptedAssetKinds === undefined
          ? {}
          : { acceptedAssetKinds: unique(input.acceptedAssetKinds) as SpeakerAssetKind[] }),
        ...(allowedMimeTypes.length === 0 ? {} : { allowedMimeTypes }),
        ...(maxBytes === undefined ? {} : { maxBytes, maxSizeBytes: maxBytes }),
        version: 1,
        updatedAt: this.now().toISOString(),
      };
      const createTask = this.repository.createTask ?? this.repository.createSpeakerTask;
      if (createTask === undefined) throw notFound();
      const result = await createTask.call(this.repository, {
        task,
        expectedVersion: null,
        actorAccountId: input.accountId,
        ...(input.decisionFence === undefined ? {} : { decisionFence: input.decisionFence }),
      });
      if (!result.ok) {
        if (result.reason === "version_conflict" || result.reason === "invalid_state") {
          throw new SpeakerServiceError(
            "VERSION_CONFLICT",
            409,
            "The task already exists or changed.",
          );
        }
        throw notFound();
      }
      const persisted = await this.repository.getTask(input.eventId, task.id);
      if (
        persisted === null ||
        persisted.version !== 1 ||
        speakerTaskSubject(persisted) === undefined
      ) {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The task could not be verified after saving.",
        );
      }
      tasks.push(persisted);
    }
    return tasks;
  }

  async createTask(input: SpeakerTaskCreateInput): Promise<SpeakerTask> {
    const tasks = await this.createOrganizerTask(input);
    const first = tasks[0];
    if (first === undefined) throw notFound();
    return first;
  }

  async updateTask(input: SpeakerTaskUpdateInput): Promise<SpeakerTask> {
    return this.updateOrganizerTask(input);
  }

  async updateOrganizerTask(
    input: SpeakerTaskUpdateInput,
    audit?: SpeakerTaskRepositoryAudit,
  ): Promise<SpeakerTask> {
    const scope = await this.requireOrganizerScope(input.eventId, input.accountId);
    assertExpectedVersion(input.expectedVersion);
    const current = await this.repository.getTask(input.eventId, input.taskId);
    const roster = await this.organizerRosterEntries(
      scope.tenantId,
      input.eventId,
      scope,
      input.accountId,
    );
    const subject = current === null ? undefined : speakerTaskSubject(current);
    const manual =
      current === null
        ? undefined
        : roster.find(
            (entry) =>
              entry.participantId === current.participantId && isOrganizerManagedRosterEntry(entry),
          );
    const participantAllowed =
      current !== null &&
      (scope.participantIds.includes(current.participantId) || manual !== undefined);
    let sessionAllowed = subject?.type !== "session";
    if (
      !sessionAllowed &&
      scope.tenantId !== undefined &&
      current !== null &&
      subject?.type === "session"
    ) {
      try {
        await this.acceptedSession(
          scope.tenantId,
          input.eventId,
          current.participantId,
          subject.sessionId,
        );
        sessionAllowed = true;
      } catch {
        sessionAllowed = false;
      }
    }
    if (
      current === null ||
      subject === undefined ||
      current.eventId !== input.eventId ||
      !participantAllowed ||
      !sessionAllowed
    ) {
      throw notFound();
    }
    if (current.version !== input.expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The speaker task has changed. Reload it before saving.",
      );
    }
    const allowedMimeTypes =
      input.allowedMimeTypes === undefined
        ? current.allowedMimeTypes
        : normalizeMimeTypes(input.allowedMimeTypes);
    const maxBytes =
      input.maxBytes === undefined && input.maxSizeBytes === undefined
        ? (current.maxBytes ?? current.maxSizeBytes)
        : normalizeMaxBytes(input.maxBytes ?? input.maxSizeBytes);
    if (current.type === "upload" && (allowedMimeTypes?.length ?? 0) === 0) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "Upload tasks require allowed MIME types.",
      );
    }
    const updatedDueAt = normalizeDueAt(input.dueAt ?? input.dueDate);
    await this.validateSelectedDeadline(
      scope.tenantId,
      input.eventId,
      updatedDueAt,
      current.dueAt ?? current.dueDate,
    );
    const updatedDescription =
      input.description === undefined
        ? input.instructions === undefined
          ? undefined
          : normalizeUserText(input.instructions, "The task instructions", 10_000, true)
        : normalizeUserText(input.description, "The task description", 10_000, true);
    const updatedInstructions =
      input.instructions === undefined
        ? updatedDescription
        : normalizeUserText(input.instructions, "The task instructions", 10_000, true);
    const updated: SpeakerTask = {
      ...current,
      ...(input.title === undefined
        ? {}
        : { title: normalizeUserText(input.title, "The task title", 200) }),
      ...(updatedDescription === undefined && updatedInstructions === undefined
        ? {}
        : {
            ...(updatedDescription === undefined ? {} : { description: updatedDescription }),
            ...(updatedInstructions === undefined ? {} : { instructions: updatedInstructions }),
          }),
      ...(updatedDueAt === undefined
        ? {}
        : {
            dueAt: updatedDueAt,
            dueDate: updatedDueAt,
          }),
      ...(allowedMimeTypes === undefined || allowedMimeTypes.length === 0
        ? {}
        : { allowedMimeTypes }),
      ...(maxBytes === undefined ? {} : { maxBytes, maxSizeBytes: maxBytes }),
      ...(input.acceptedAssetKinds === undefined
        ? {}
        : { acceptedAssetKinds: unique(input.acceptedAssetKinds) as SpeakerAssetKind[] }),
      ...(input.dependencyIds === undefined ? {} : { dependencyIds: unique(input.dependencyIds) }),
      ...(input.reminderOffsetsMinutes === undefined
        ? {}
        : { reminderOffsetsMinutes: [...input.reminderOffsetsMinutes] }),
      ...(input.status === undefined ? {} : { status: input.status }),
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    const updateTask = this.repository.updateTask ?? this.repository.updateSpeakerTask;
    if (updateTask === undefined) throw notFound();
    const result = await updateTask.call(this.repository, {
      task: updated,
      expectedVersion: input.expectedVersion,
      actorAccountId: input.accountId,
      ...(audit === undefined ? {} : { audit }),
    });
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The speaker task has changed. Reload it before saving.",
        );
      }
      throw notFound();
    }
    const persisted = await this.repository.getTask(input.eventId, input.taskId);
    if (
      persisted === null ||
      persisted.version !== input.expectedVersion + 1 ||
      speakerTaskSubject(persisted) === undefined
    ) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The task could not be verified after saving.",
      );
    }
    return persisted;
  }

  async updateOrganizerTaskReminderOffsets(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    taskId: string;
    expectedVersion: number;
    reminderOffsetsMinutes: readonly number[];
  }): Promise<{
    organizationId: string;
    eventId: string;
    taskId: string;
    reminderOffsetsMinutes: readonly number[];
    version: number;
    updatedAt: string;
  }> {
    await this.requireOrganizerOrganizationScope(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    assertExpectedVersion(input.expectedVersion);
    const reminderOffsetsMinutes = normalizeReminderOffsets(input.reminderOffsetsMinutes);
    const current = (await this.listOrganizerTasks(input.eventId, input.accountId)).find(
      (task) => task.id === input.taskId,
    );
    if (current === undefined) throw notFound();
    if (
      current.owner !== "speaker" ||
      current.type !== "upload" ||
      (current.dueAt ?? current.dueDate) === undefined ||
      ["completed", "submitted", "waived"].includes(current.status)
    ) {
      throw new SpeakerServiceError(
        "TASK_REMINDERS_NOT_EDITABLE",
        409,
        "Reminder schedules can be changed only for incomplete speaker upload tasks with a due date.",
      );
    }
    const updated = await this.updateOrganizerTask(
      {
        eventId: input.eventId,
        accountId: input.accountId,
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        reminderOffsetsMinutes,
      },
      {
        id: `audit:speaker-task-reminder-offsets:${input.taskId}:${input.expectedVersion + 1}`,
        action: "speaker_task.reminder_offsets_updated",
        previousReminderOffsetsMinutes: [...current.reminderOffsetsMinutes],
      },
    );
    return {
      organizationId: input.organizationId,
      eventId: input.eventId,
      taskId: input.taskId,
      reminderOffsetsMinutes: [...updated.reminderOffsetsMinutes],
      version: updated.version,
      updatedAt: updated.updatedAt,
    };
  }

  async listDeliverables(
    eventId: string,
    accountId: string,
    filters: SpeakerDeliverablesQuery = {},
  ): Promise<SpeakerDeliverablesMatrix> {
    const statusFilter = filters.status ?? "all";
    const assertStatusFilter = (): void => {
      const allowedStatuses = new Set<string>([
        "all",
        "incomplete",
        "pending",
        "uploaded",
        ...speakerTaskStatuses,
      ]);
      if (!allowedStatuses.has(statusFilter)) {
        throw new SpeakerServiceError(
          "VALIDATION_ERROR",
          400,
          "The deliverable status filter is invalid.",
        );
      }
    };
    const getOrganizerReadModel = this.repository.getOrganizerReadModel;
    let scope: SpeakerAccessScope & { tenantId: string; organizer: true };
    let tasks: SpeakerTask[];
    let profiles: SpeakerProfile[];
    let assets: SpeakerAsset[];
    if (getOrganizerReadModel !== undefined) {
      const model = await getOrganizerReadModel.call(this.repository, eventId, accountId, {
        profiles: true,
        tasks: true,
        assets: true,
      });
      if (model === null) throw notFound();
      scope = this.readModelScope(model, eventId);
      assertStatusFilter();
      const acceptedSubmissions = this.acceptedOrganizerSubmissionsFrom(
        eventId,
        scope,
        model.submissions,
      );
      const roster = this.organizerRosterEntriesFromReadModel(
        eventId,
        scope,
        model.roster,
        model.profiles,
      );
      tasks = (
        await this.organizerTasksFromSources(
          eventId,
          scope,
          acceptedSubmissions,
          roster,
          model.tasks,
        )
      ).filter((task) => task.type === "upload");
      const participantIds = unique(tasks.map((task) => task.participantId));
      profiles = model.profiles.filter(
        (profile) => profile.eventId === eventId && participantIds.includes(profile.participantId),
      );
      assets = model.assets.filter(
        (asset) =>
          asset.eventId === eventId &&
          participantIds.includes(asset.participantId) &&
          (asset.tenantId === undefined || asset.tenantId === scope.tenantId),
      );
    } else {
      scope = await this.requireOrganizerScope(eventId, accountId);
      assertStatusFilter();
      const [acceptedSubmissions, roster] = await Promise.all([
        this.acceptedOrganizerSubmissions(eventId, scope),
        this.organizerRosterEntries(scope.tenantId, eventId, scope, accountId),
      ]);
      const participantIds = unique([
        ...acceptedSubmissions.flatMap((submission) =>
          submission.participantIds.filter((participantId) =>
            scope.participantIds.includes(participantId),
          ),
        ),
        ...roster.filter(isOrganizerManagedRosterEntry).map((entry) => entry.participantId),
      ]);
      const storedTasks = await this.repository.listTasks(eventId, participantIds);
      tasks = (
        await this.organizerTasksFromSources(
          eventId,
          scope,
          acceptedSubmissions,
          roster,
          storedTasks,
        )
      ).filter((task) => task.type === "upload");
      const taskParticipantIds = unique(tasks.map((task) => task.participantId));
      const [storedProfiles, storedAssets] = await Promise.all([
        this.repository.listProfiles(eventId, taskParticipantIds),
        this.assetsForParticipants(eventId, taskParticipantIds),
      ]);
      profiles = storedProfiles;
      assets = storedAssets.filter(
        (asset) =>
          asset.eventId === eventId &&
          (asset.tenantId === undefined || asset.tenantId === scope.tenantId),
      );
    }
    const profileByParticipant = new Map(
      profiles.map((profile) => [profile.participantId, profile]),
    );
    const assetsByParticipantAndTask = new Map<string, Map<string, SpeakerAsset[]>>();
    for (const asset of assets) {
      if (asset.taskId === undefined) continue;
      let byTask = assetsByParticipantAndTask.get(asset.participantId);
      if (byTask === undefined) {
        byTask = new Map();
        assetsByParticipantAndTask.set(asset.participantId, byTask);
      }
      const taskAssets = byTask.get(asset.taskId);
      if (taskAssets === undefined) byTask.set(asset.taskId, [asset]);
      else taskAssets.push(asset);
    }
    const temporalContext = await this.eventTemporalContext(scope.tenantId, eventId);
    const rows: SpeakerDeliverableRow[] = [];
    for (const task of tasks) {
      if (filters.participantId !== undefined && task.participantId !== filters.participantId)
        continue;
      if (filters.taskId !== undefined && task.id !== filters.taskId) continue;
      const taskAssets = (
        assetsByParticipantAndTask.get(task.participantId)?.get(task.id) ?? []
      ).filter(
        (asset) =>
          (task.subject.type === "participant" && asset.sessionId === undefined) ||
          (task.subject.type === "session" && asset.sessionId === task.subject.sessionId),
      );
      const currentAsset = singleCurrentAsset(taskAssets);
      const status = taskStatusForAssets(task, taskAssets, this.now(), temporalContext?.timeZone);
      const incomplete = !["completed", "waived", "uploaded"].includes(status);
      if (
        statusFilter !== "all" &&
        statusFilter !== status &&
        !((statusFilter === "pending" || statusFilter === "incomplete") && incomplete)
      ) {
        continue;
      }
      const profile = profileByParticipant.get(task.participantId);
      rows.push({
        organizationId: scope.tenantId,
        eventId,
        task: structuredClone(task),
        participantId: task.participantId,
        ...(profile?.displayName === undefined ? {} : { participantName: profile.displayName }),
        assets: taskAssets.map((asset) => structuredClone(asset)),
        ...(currentAsset === undefined ? {} : { currentAsset: structuredClone(currentAsset) }),
        status,
      });
    }
    return {
      organizationId: scope.tenantId,
      eventId,
      ...(temporalContext === undefined ? {} : { temporalContext }),
      items: rows,
      total: rows.length,
      filters: { ...filters },
    };
  }
  async exportDeliverables(
    input: SpeakerDeliverablesExportInput,
  ): Promise<SpeakerDeliverablesExportResult> {
    const scope = await this.requireOrganizerScope(input.eventId, input.accountId);
    const assetIds = normalizeExportIds(input.assetIds, "asset");
    const taskIds = normalizeExportIds(input.taskIds, "task");
    const participantIds = normalizeExportIds(input.participantIds, "participant");
    const allowedStatuses = new Set<string>([
      "all",
      "incomplete",
      "pending",
      "uploaded",
      ...speakerTaskStatuses,
    ]);
    if (input.status !== undefined && !allowedStatuses.has(input.status)) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "The deliverable status filter is invalid.",
      );
    }
    if (
      assetIds === undefined &&
      taskIds === undefined &&
      participantIds === undefined &&
      input.status === undefined
    ) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "Select deliverable asset IDs or task filters before exporting.",
      );
    }
    const acceptedSubmissions = await this.acceptedOrganizerSubmissions(input.eventId, scope);
    const roster =
      this.repository.listRosterForEvent === undefined
        ? []
        : await this.repository.listRosterForEvent(input.eventId);
    const initialRosterView = this.organizerRosterVisibility(
      input.eventId,
      scope,
      acceptedSubmissions,
      [],
      roster,
    );
    const profiles = await this.repository.listProfiles(
      input.eventId,
      initialRosterView.participantIds,
    );
    const { participantIds: visibleParticipantIds, participantNames } =
      this.organizerRosterVisibility(input.eventId, scope, acceptedSubmissions, profiles, roster);
    const allowedParticipantIds = new Set(visibleParticipantIds);
    if (participantIds?.some((participantId) => !allowedParticipantIds.has(participantId))) {
      throw notFound();
    }

    const tasks = (
      await Promise.all(
        (
          await this.repository.listTasks(input.eventId, [...allowedParticipantIds])
        ).map(async (task) => {
          const subject = speakerTaskSubject(task);
          if (
            subject === undefined ||
            task.eventId !== input.eventId ||
            !allowedParticipantIds.has(task.participantId)
          ) {
            return undefined;
          }
          if (subject.type === "participant") return task;
          try {
            await this.acceptedSession(
              scope.tenantId,
              input.eventId,
              task.participantId,
              subject.sessionId,
            );
            return task;
          } catch {
            return undefined;
          }
        }),
      )
    )
      .filter((task): task is SpeakerTask => task !== undefined)
      .sort((left, right) => compareStable(left.id, right.id));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    if (taskIds?.some((taskId) => !taskById.has(taskId))) throw notFound();

    const assets = (
      await Promise.all(
        (
          await this.assetsForParticipants(input.eventId, [...allowedParticipantIds])
        ).map(async (asset) => {
          if (
            asset.eventId !== input.eventId ||
            !allowedParticipantIds.has(asset.participantId) ||
            (asset.tenantId !== undefined && asset.tenantId !== scope.tenantId)
          ) {
            return undefined;
          }
          if (asset.sessionId === undefined) return asset;
          try {
            await this.acceptedSession(
              scope.tenantId,
              input.eventId,
              asset.participantId,
              asset.sessionId,
            );
            return asset;
          } catch {
            return undefined;
          }
        }),
      )
    )
      .filter((asset): asset is SpeakerAsset => asset !== undefined)
      .sort((left, right) => compareStable(left.id, right.id));
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    if (
      assetIds?.some((assetId) => {
        const asset = assetById.get(assetId);
        return asset?.taskId !== undefined && !taskById.has(asset.taskId);
      })
    ) {
      throw notFound();
    }
    if (assetIds?.some((assetId) => !assetById.has(assetId))) throw notFound();

    const assetsByTask = new Map<string, SpeakerAsset[]>();
    for (const asset of assets) {
      if (asset.taskId === undefined) continue;
      const taskAssets = assetsByTask.get(asset.taskId) ?? [];
      taskAssets.push(asset);
      assetsByTask.set(asset.taskId, taskAssets);
    }
    const familyKey = (asset: SpeakerAsset): string =>
      `${asset.participantId}\u0000${asset.taskId ?? ""}\u0000${asset.versionFamilyId ?? asset.id}`;
    const familyMembers = new Map<string, SpeakerAsset[]>();
    for (const asset of assets) {
      const key = familyKey(asset);
      familyMembers.set(key, [...(familyMembers.get(key) ?? []), asset]);
    }
    const selectedFamilyKeys =
      assetIds === undefined
        ? undefined
        : new Set(
            assetIds.flatMap((assetId) => {
              const selected = assetById.get(assetId);
              return selected === undefined ? [] : [familyKey(selected)];
            }),
          );
    const selectedAssets = [...familyMembers.entries()].flatMap(([key, family]) => {
      const pointers = assetFamilyPointers(family);
      if (pointers === undefined) return [];
      if (selectedFamilyKeys !== undefined) {
        return selectedFamilyKeys.has(key) && pointers.current !== undefined
          ? [pointers.current]
          : [];
      }
      return pointers.released === undefined ? [] : [pointers.released];
    });
    const participantFilter = participantIds === undefined ? undefined : new Set(participantIds);
    const taskFilter = taskIds === undefined ? undefined : new Set(taskIds);
    const now = this.now();
    const temporalContext = await this.eventTemporalContext(scope.tenantId, input.eventId);
    const candidates: {
      asset: SpeakerAsset;
      task: SpeakerTask | undefined;
      status: SpeakerDeliverableRow["status"];
      participantName: string | null;
      sessionId: string | null;
      sessionTitle: string | null;
      basePath: string;
    }[] = [];

    for (const asset of selectedAssets) {
      if (participantFilter !== undefined && !participantFilter.has(asset.participantId)) continue;
      const task = asset.taskId === undefined ? undefined : taskById.get(asset.taskId);
      if (asset.taskId !== undefined && task === undefined) continue;
      if (taskFilter !== undefined && (task === undefined || !taskFilter.has(task.id))) continue;
      const taskAssets = task === undefined ? [] : (assetsByTask.get(task.id) ?? []);
      const status =
        task === undefined
          ? "uploaded"
          : taskStatusForAssets(task, taskAssets, now, temporalContext?.timeZone);
      if (!deliverableStatusMatches(input.status, status)) continue;
      const rawSessionId =
        asset.sessionId ??
        (task?.subject.type === "session" ? task.subject.sessionId : null) ??
        null;
      const session =
        rawSessionId === null
          ? undefined
          : await this.acceptedSession(
              scope.tenantId,
              input.eventId,
              asset.participantId,
              rawSessionId,
            );
      const sessionId = session?.id ?? null;
      const participantName = participantNames.get(asset.participantId) ?? null;
      const sessionName = session?.title ?? sessionId;
      const taskName = task?.title ?? asset.kind;
      const basePath = [
        "files",
        exportArchiveComponent(participantName ?? asset.participantId, asset.participantId),
        exportArchiveComponent(sessionName ?? "session", sessionId ?? "session"),
        exportArchiveComponent(taskName, task?.id ?? asset.kind),
        exportArchiveComponent(asset.fileName, asset.id),
      ].join("/");
      candidates.push({
        asset,
        task,
        status,
        participantName,
        sessionId,
        sessionTitle: session?.title ?? null,
        basePath,
      });
    }
    if (candidates.length > bulkExportMaximumAssets) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "The deliverables export contains too many assets.",
      );
    }

    const readObject = this.assetGateway.readObject;
    if (readObject === undefined) {
      throw new SpeakerServiceError(
        "CAPABILITY_UNAVAILABLE",
        409,
        "Private asset reads are not configured for deliverables exports.",
      );
    }
    const readExportValue = async <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return await read();
      } catch {
        throw new SpeakerServiceError(
          "CAPABILITY_UNAVAILABLE",
          409,
          "A private deliverable could not be read.",
        );
      }
    };
    const declaredBytes = candidates.reduce(
      (total, candidate) => total + candidate.asset.sizeBytes,
      0,
    );
    if (
      candidates.some(
        (candidate) =>
          !Number.isSafeInteger(candidate.asset.sizeBytes) || candidate.asset.sizeBytes < 0,
      )
    ) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "The deliverables export asset size is invalid.",
      );
    }
    if (declaredBytes > bulkExportMaximumBytes) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "The deliverables export exceeds the size limit.",
      );
    }

    candidates.sort(
      (left, right) =>
        compareStable(left.basePath, right.basePath) ||
        compareStable(left.asset.id, right.asset.id),
    );
    const usedPaths = new Set<string>();
    const files: StoredArchiveFile[] = [];
    const entries: SpeakerDeliverablesExportManifestEntry[] = [];
    let totalBytes = 0;

    for (const candidate of candidates) {
      const { asset, task } = candidate;
      const sessionId = candidate.sessionId;
      const binding: PrivateAssetCapabilityBinding = {
        capabilityId: asset.id,
        tenantId: asset.tenantId ?? scope.tenantId,
        eventId: input.eventId,
        subject:
          sessionId === undefined || sessionId === null
            ? { kind: "participant" }
            : { kind: "speaker_session", sessionId },
        participantId: asset.participantId,
        ...(asset.taskId === undefined ? {} : { taskId: asset.taskId }),
        objectKey: asset.objectKey,
        contentType: asset.contentType,
        sizeBytes: asset.sizeBytes,
        fileName: asset.fileName,
        expiresAt: new Date(now.getTime() + downloadGrantLifetimeMs).toISOString(),
      };
      const object = await readExportValue(() => readObject.call(this.assetGateway, binding));
      if (object === null) continue;
      if (
        object.sizeBytes !== asset.sizeBytes ||
        object.contentType.trim().toLowerCase() !== asset.contentType.trim().toLowerCase()
      ) {
        throw new SpeakerServiceError(
          "CAPABILITY_UNAVAILABLE",
          409,
          "A private deliverable no longer matches its immutable metadata.",
        );
      }
      const bytes = await readExportValue(async () => {
        return new Uint8Array(await new Response(object.body).arrayBuffer());
      });
      if (bytes.byteLength !== asset.sizeBytes) {
        throw new SpeakerServiceError(
          "CAPABILITY_UNAVAILABLE",
          409,
          "A private deliverable no longer matches its immutable metadata.",
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > bulkExportMaximumBytes) {
        throw new SpeakerServiceError(
          "VALIDATION_ERROR",
          400,
          "The deliverables export exceeds the size limit.",
        );
      }
      const path = archivePathWithCollision(candidate.basePath, usedPaths);
      files.push({ path, bytes });
      entries.push({
        assetId: asset.id,
        participantId: asset.participantId,
        participantName: candidate.participantName,
        sessionId,
        sessionTitle: candidate.sessionTitle,
        taskId: task?.id ?? null,
        taskTitle: task?.title ?? null,
        status: candidate.status,
        version: asset.version ?? 0,
        taskVersion: task?.version ?? null,
        fileName: exportArchiveComponent(asset.fileName, asset.id),
        path,
        contentType: asset.contentType,
        sizeBytes: bytes.byteLength,
      });
    }

    const manifest: SpeakerDeliverablesExportManifest = {
      format: "speaker-deliverables-export",
      version: 1,
      organizationId: scope.tenantId,
      eventId: input.eventId,
      entries,
    };
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const body = createStoredZip([
      { path: bulkExportManifestName, bytes: manifestBytes },
      ...files,
    ]);
    const occurredAt = this.now().toISOString();
    for (const entry of entries) {
      const audit: SpeakerAssetAuditEntry = {
        id: this.generateId(),
        organizationId: scope.tenantId,
        eventId: input.eventId,
        assetId: entry.assetId,
        action: "exported",
        actorAccountId: input.accountId,
        note: "deliverables_export",
        occurredAt,
        version: entry.version,
      };
      const cachedAudit = this.assetAuditCache.get(`${input.eventId}:${entry.assetId}`) ?? [];
      this.assetAuditCache.set(`${input.eventId}:${entry.assetId}`, [...cachedAudit, audit]);
      if (this.repository.appendAssetAudit !== undefined)
        await this.repository.appendAssetAudit(audit);
    }
    return {
      fileName: `${exportArchiveComponent(input.eventId, "event")}-deliverables.zip`,
      contentType: bulkExportContentType,
      sizeBytes: body.byteLength,
      body,
      manifest,
    };
  }
  async listOrganizerAssets(
    eventId: string,
    accountId: string,
    participantId?: string,
    versionFamilyId?: string,
  ): Promise<SpeakerAsset[]> {
    const getOrganizerReadModel = this.repository.getOrganizerReadModel;
    if (getOrganizerReadModel !== undefined) {
      const model = await getOrganizerReadModel.call(this.repository, eventId, accountId, {
        profiles: true,
        assets: true,
      });
      if (model === null) throw notFound();
      const scope = this.readModelScope(model, eventId);
      const acceptedSubmissions = this.acceptedOrganizerSubmissionsFrom(
        eventId,
        scope,
        model.submissions,
      );
      const { participantIds, participantNames } = this.organizerRosterVisibility(
        eventId,
        scope,
        acceptedSubmissions,
        model.profiles,
        model.roster,
      );
      return await this.organizerAssetsFromSources(
        eventId,
        scope,
        model.assets,
        participantIds,
        participantNames,
        participantId,
        versionFamilyId,
      );
    }

    const scope = await this.requireOrganizerScope(eventId, accountId);
    const acceptedSubmissions = await this.acceptedOrganizerSubmissions(eventId, scope);
    const roster =
      this.repository.listRosterForEvent === undefined
        ? []
        : await this.repository.listRosterForEvent(eventId);
    const initialRosterView = this.organizerRosterVisibility(
      eventId,
      scope,
      acceptedSubmissions,
      [],
      roster,
    );
    if (initialRosterView.participantIds.length === 0) return [];
    const [assets, profiles] = await Promise.all([
      this.assetsForParticipants(eventId, initialRosterView.participantIds),
      this.repository.listProfiles(eventId, initialRosterView.participantIds),
    ]);
    const { participantIds, participantNames } = this.organizerRosterVisibility(
      eventId,
      scope,
      acceptedSubmissions,
      profiles,
      roster,
    );
    return await this.organizerAssetsFromSources(
      eventId,
      scope,
      assets,
      participantIds,
      participantNames,
      participantId,
      versionFamilyId,
    );
  }

  private async organizerAssetsFromSources(
    eventId: string,
    scope: SpeakerAccessScope & { tenantId: string },
    assets: readonly SpeakerAsset[],
    visibleParticipantIds: readonly string[],
    participantNames: ReadonlyMap<string, string>,
    participantId: string | undefined,
    versionFamilyId: string | undefined,
  ): Promise<SpeakerAsset[]> {
    const visibleParticipantIdSet = new Set(visibleParticipantIds);
    if (participantId !== undefined && !visibleParticipantIdSet.has(participantId)) {
      throw notFound();
    }
    if (visibleParticipantIdSet.size === 0) return [];
    const participantIds = participantId === undefined ? visibleParticipantIds : [participantId];
    return (
      await Promise.all(
        assets.map(async (asset) => {
          if (
            asset.eventId !== eventId ||
            !participantIds.includes(asset.participantId) ||
            !visibleParticipantIdSet.has(asset.participantId) ||
            (versionFamilyId !== undefined &&
              (asset.versionFamilyId ?? asset.id) !== versionFamilyId) ||
            (asset.tenantId !== undefined && asset.tenantId !== scope.tenantId)
          ) {
            return undefined;
          }
          if (asset.sessionId === undefined) {
            const name = participantNames.get(asset.participantId);
            return {
              ...structuredClone(asset),
              ...(name === undefined ? {} : { participantName: name }),
            };
          }
          try {
            const session = await this.acceptedSession(
              scope.tenantId,
              eventId,
              asset.participantId,
              asset.sessionId,
            );
            const name = participantNames.get(asset.participantId);
            return {
              ...structuredClone(asset),
              ...(name === undefined ? {} : { participantName: name }),
              sessionTitle: session.title,
            };
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((asset): asset is SpeakerAsset => asset !== undefined);
  }

  async listOrganizerAssetHistory(
    eventId: string,
    accountId: string,
    assetId: string,
  ): Promise<SpeakerAsset[]> {
    const scope = await this.requireOrganizerScope(eventId, accountId);
    const asset = await this.repository.getAsset(eventId, assetId);
    if (asset === null) throw notFound();
    await this.assertOrganizerAssetAccess(scope, eventId, accountId, asset);
    const familyId = asset.versionFamilyId ?? asset.id;
    const history =
      this.repository.listAssetHistory === undefined
        ? await this.assetsForParticipants(eventId, [asset.participantId])
        : await this.repository.listAssetHistory(eventId, familyId);
    return history
      .filter(
        (candidate) =>
          candidate.eventId === eventId &&
          candidate.participantId === asset.participantId &&
          (candidate.versionFamilyId ?? candidate.id) === familyId &&
          (candidate.tenantId === undefined || candidate.tenantId === scope.tenantId) &&
          candidate.sessionId === asset.sessionId &&
          candidate.taskId === asset.taskId,
      )
      .sort(
        (left, right) =>
          (left.version ?? 0) - (right.version ?? 0) ||
          left.createdAt.localeCompare(right.createdAt),
      );
  }

  private async listAssetThreadComments(
    eventId: string,
    asset: SpeakerAsset,
  ): Promise<SpeakerAssetComment[]> {
    if (this.repository.listAssetComments === undefined) return [];
    return (await this.repository.listAssetComments(eventId, asset.id))
      .filter(
        (comment) =>
          comment.eventId === eventId &&
          comment.assetId === asset.id &&
          comment.versionId === asset.id,
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          (left.version ?? 0) - (right.version ?? 0) ||
          left.id.localeCompare(right.id),
      );
  }
  private async listAssetFamilyComments(
    eventId: string,
    assets: readonly SpeakerAsset[],
  ): Promise<SpeakerAssetComment[]> {
    const comments = await Promise.all(
      assets.map((asset) => this.listAssetThreadComments(eventId, asset)),
    );
    return [
      ...new Map(comments.flat().map((comment) => [comment.id, comment] as const)).values(),
    ].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        (left.version ?? 0) - (right.version ?? 0) ||
        left.id.localeCompare(right.id),
    );
  }
  async listOrganizerAssetComments(
    eventId: string,
    accountId: string,
    assetId: string,
  ): Promise<SpeakerAssetComment[]> {
    const scope = await this.requireOrganizerScope(eventId, accountId);
    const asset = await this.repository.getAsset(eventId, assetId);
    if (asset === null) throw notFound();
    await this.assertOrganizerAssetAccess(scope, eventId, accountId, asset);
    if (this.repository.listAssetComments === undefined) throw notFound();
    const history = await this.listOrganizerAssetHistory(eventId, accountId, assetId);
    return (await this.listAssetFamilyComments(eventId, history)).map((comment) => ({
      id: comment.id,
      eventId,
      assetId: comment.assetId,
      versionId: comment.versionId,
      body: comment.body,
      authorLabel: comment.authorLabel,
      createdAt: comment.createdAt,
      ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
      ...(comment.version === undefined ? {} : { version: comment.version }),
    }));
  }

  async addOrganizerAssetComment(input: {
    eventId: string;
    accountId: string;
    assetId: string;
    body: string;
    expectedVersion?: number;
  }): Promise<SpeakerAssetComment> {
    const scope = await this.requireOrganizerScope(input.eventId, input.accountId);
    const asset = await this.repository.getAsset(input.eventId, input.assetId);
    if (asset === null) throw notFound();
    await this.assertOrganizerAssetAccess(scope, input.eventId, input.accountId, asset);
    if (this.repository.createAssetComment === undefined) throw notFound();
    const comments =
      this.repository.listAssetComments === undefined
        ? []
        : await this.listAssetThreadComments(input.eventId, asset);
    const latestVersion = comments.reduce((max, comment) => Math.max(max, comment.version ?? 0), 0);
    if (input.expectedVersion !== undefined && input.expectedVersion !== latestVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The comment thread changed. Reload it before posting.",
      );
    }
    const now = this.now().toISOString();
    const comment: SpeakerAssetComment = {
      id: this.generateId(),
      eventId: input.eventId,
      assetId: input.assetId,
      versionId: input.assetId,
      body: normalizeUserText(input.body, "The asset comment", 10_000, true),
      authorLabel: "Organizer",
      createdAt: now,
      updatedAt: now,
      version: latestVersion + 1,
      authorAccountId: input.accountId,
    };
    const stored = await this.repository.createAssetComment(comment);
    const audit: SpeakerAssetAuditEntry = {
      id: this.generateId(),
      organizationId: scope.tenantId,
      eventId: input.eventId,
      assetId: input.assetId,
      action: "commented",
      actorAccountId: input.accountId,
      note: stored.body,
      occurredAt: stored.createdAt,
      version: stored.version ?? latestVersion + 1,
    };
    const cachedAudit = this.assetAuditCache.get(`${input.eventId}:${input.assetId}`) ?? [];
    this.assetAuditCache.set(`${input.eventId}:${input.assetId}`, [...cachedAudit, audit]);
    if (this.repository.appendAssetAudit !== undefined)
      await this.repository.appendAssetAudit(audit);
    return {
      id: stored.id,
      eventId: input.eventId,
      assetId: input.assetId,
      versionId: stored.versionId,
      body: stored.body,
      authorLabel: stored.authorLabel,
      createdAt: stored.createdAt,
      ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }),
      ...(stored.version === undefined ? {} : { version: stored.version }),
    };
  }

  async issueOrganizerDownloadGrant(input: {
    eventId: string;
    accountId: string;
    assetId: string;
  }): Promise<PrivateDownloadGrant> {
    const scope = await this.requireOrganizerScope(input.eventId, input.accountId);
    const asset = await this.repository.getAsset(input.eventId, input.assetId);
    if (asset === null || asset.state !== "ready") throw notFound();
    await this.assertOrganizerAssetAccess(scope, input.eventId, input.accountId, asset);
    const sessionId = asset.sessionId;
    const expiresAt = new Date(this.now().getTime() + downloadGrantLifetimeMs).toISOString();
    const binding: PrivateDownloadCapabilityBinding = {
      capabilityId: asset.id,
      tenantId: asset.tenantId ?? scope.tenantId,
      eventId: input.eventId,
      subject:
        sessionId === undefined || sessionId === null
          ? { kind: "participant" }
          : { kind: "speaker_session", sessionId },
      participantId: asset.participantId,
      ...(asset.taskId === undefined ? {} : { taskId: asset.taskId }),
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      fileName: asset.fileName,
      expiresAt,
      requesterAccountId: input.accountId,
      requesterKind: "organizer",
      assetVersion: asset.version ?? 1,
    };
    return this.assetGateway.registerDownloadCapability === undefined
      ? await this.assetGateway.createDownloadGrant({
          objectKey: asset.objectKey,
          fileName: asset.fileName,
          expiresAt,
        })
      : await this.assetGateway.registerDownloadCapability(binding);
  }

  async reviewAsset(input: SpeakerAssetReviewInput): Promise<SpeakerAsset> {
    const scope = await this.requireOrganizerScope(input.eventId, input.accountId);
    const asset = await this.repository.getAsset(input.eventId, input.assetId);
    if (asset === null || asset.state !== "ready") throw notFound();
    await this.assertOrganizerAssetAccess(scope, input.eventId, input.accountId, asset);
    const history =
      this.repository.listAssetHistory === undefined
        ? await this.assetsForParticipants(input.eventId, [asset.participantId])
        : await this.repository.listAssetHistory(input.eventId, asset.versionFamilyId ?? asset.id);
    const pointers = assetFamilyPointers(
      history.filter(
        (candidate) =>
          (candidate.versionFamilyId ?? candidate.id) === (asset.versionFamilyId ?? asset.id),
      ),
    );
    if (pointers?.current?.id !== asset.id) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "Only the authoritative current asset version can be reviewed.",
      );
    }
    if (input.release === true && input.state !== "approved") {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "Only an approved asset version can be released.",
      );
    }
    const expectedVersion = input.expectedVersion ?? asset.reviewVersion ?? 0;
    assertExpectedVersion(expectedVersion);
    if ((asset.reviewVersion ?? 0) !== expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The asset review changed. Reload it before deciding.",
      );
    }
    const note =
      input.note === undefined
        ? undefined
        : normalizeUserText(input.note, "The review note", 2_000, true);
    const reviewedAt = this.now().toISOString();
    const audit: SpeakerAssetAuditEntry = {
      id: this.generateId(),
      organizationId: scope.tenantId,
      eventId: input.eventId,
      assetId: input.assetId,
      action: input.state,
      actorAccountId: input.accountId,
      ...(note === undefined ? {} : { note }),
      occurredAt: reviewedAt,
      version: expectedVersion + 1,
    };
    let returnTask: SpeakerAssetReviewCommand["returnTask"];
    let returnTaskExpectation: { readonly id: string; readonly version: number } | undefined;
    if (input.state === "needs_changes" && asset.taskId !== undefined) {
      const task = await this.repository.getTask(input.eventId, asset.taskId);
      const subject = task === null ? undefined : speakerTaskSubject(task);
      const subjectMatchesAsset =
        subject?.type === "participant"
          ? asset.sessionId === undefined
          : subject?.type === "session" && asset.sessionId === subject.sessionId;
      if (
        task === null ||
        subject === undefined ||
        task.type !== "upload" ||
        task.owner !== "speaker" ||
        task.participantId !== asset.participantId ||
        !subjectMatchesAsset
      ) {
        throw new SpeakerServiceError(
          "VALIDATION_ERROR",
          400,
          "The reviewed asset is not linked to a valid speaker upload task.",
        );
      }
      if (task !== null) {
        returnTaskExpectation = { id: task.id, version: task.version + 1 };
        returnTask = {
          eventId: input.eventId,
          taskId: task.id,
          expectedVersion: task.version,
          fromStatus: task.status,
          toStatus: "needs_changes",
          baselineAssetId: asset.id,
          ...(task.status === "needs_changes"
            ? {}
            : {
                transition: {
                  id: this.generateId(),
                  eventId: input.eventId,
                  taskId: task.id,
                  participantId: task.participantId,
                  actorAccountId: input.accountId,
                  fromStatus: task.status,
                  toStatus: "needs_changes",
                  ...(note === undefined ? {} : { note }),
                  occurredAt: reviewedAt,
                },
              }),
        };
      }
    }
    const command: SpeakerAssetReviewCommand = {
      eventId: input.eventId,
      assetId: input.assetId,
      state: input.state,
      ...(note === undefined ? {} : { note }),
      expectedVersion,
      reviewedAt,
      reviewedBy: input.accountId,
      release: input.release === true,
      audit,
      ...(returnTask === undefined ? {} : { returnTask }),
    };
    const reviewAsset =
      this.repository.reviewAsset ??
      (returnTask === undefined ? this.repository.updateAssetReview : undefined);
    if (reviewAsset === undefined) throw notFound();
    const result = await reviewAsset.call(this.repository, command);
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The asset review changed. Reload it before deciding.",
        );
      }
      throw notFound();
    }
    const cachedAudit = this.assetAuditCache.get(`${input.eventId}:${input.assetId}`) ?? [];
    this.assetAuditCache.set(`${input.eventId}:${input.assetId}`, [...cachedAudit, audit]);
    if (this.repository.appendAssetAudit !== undefined)
      await this.repository.appendAssetAudit(audit);
    const persisted = await this.repository.getAsset(input.eventId, input.assetId);
    const persistedHistory =
      this.repository.listAssetHistory === undefined
        ? await this.assetsForParticipants(input.eventId, [asset.participantId])
        : await this.repository.listAssetHistory(input.eventId, asset.versionFamilyId ?? asset.id);
    const persistedPointers = assetFamilyPointers(persistedHistory);
    if (
      persisted === null ||
      persisted.reviewVersion !== expectedVersion + 1 ||
      (input.state === "approved" && persistedPointers?.approved?.id !== asset.id) ||
      (input.release === true && persistedPointers?.released?.id !== asset.id)
    ) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The asset review could not be verified after saving.",
      );
    }
    if (returnTaskExpectation !== undefined) {
      const returnedTask = await this.repository.getTask(input.eventId, returnTaskExpectation.id);
      if (
        returnedTask === null ||
        returnedTask.status !== "needs_changes" ||
        returnedTask.version !== returnTaskExpectation.version
      ) {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The speaker task could not be verified after returning the file for updates.",
        );
      }
    }
    return persisted;
  }

  async listAssetAudit(
    eventId: string,
    accountId: string,
    assetId: string,
  ): Promise<readonly SpeakerAssetAuditEntry[]> {
    const scope = await this.requireOrganizerScope(eventId, accountId);
    const asset = await this.repository.getAsset(eventId, assetId);
    if (asset === null) throw notFound();
    await this.assertOrganizerAssetAccess(scope, eventId, accountId, asset);
    if (this.repository.listAssetAudit !== undefined) {
      return this.repository.listAssetAudit(eventId, assetId);
    }
    return this.assetAuditCache.get(`${eventId}:${assetId}`) ?? [];
  }
  private async acceptedOrganizerSubmissions(
    eventId: string,
    scope: SpeakerAccessScope,
  ): Promise<readonly SpeakerSubmission[]> {
    const submissionIds = unique(
      scope.submissionIds.flatMap((submissionId) => {
        const canonicalId = canonicalSpeakerSubmissionId(submissionId);
        return [submissionId, canonicalId, canonicalId.slice("speaker-submission:".length)];
      }),
    );
    return this.acceptedOrganizerSubmissionsFrom(
      eventId,
      scope,
      await this.repository.listSubmissions(eventId, submissionIds),
    );
  }

  private acceptedOrganizerSubmissionsFrom(
    eventId: string,
    scope: Pick<SpeakerAccessScope, "submissionIds">,
    submissions: readonly SpeakerSubmission[],
  ): SpeakerSubmission[] {
    const allowedSubmissionIds = new Set(scope.submissionIds.map(canonicalSpeakerSubmissionId));
    const byCanonicalId = new Map<string, SpeakerSubmission>();
    for (const submission of submissions) {
      if (
        submission.eventId !== eventId ||
        submission.status !== "accepted" ||
        !allowedSubmissionIds.has(canonicalSpeakerSubmissionId(submission.id))
      ) {
        continue;
      }
      const canonicalId = canonicalSpeakerSubmissionId(submission.id);
      const current = byCanonicalId.get(canonicalId);
      const hasDescriptiveTitle = canonicalSpeakerSubmissionId(submission.title) !== canonicalId;
      const currentHasDescriptiveTitle =
        current !== undefined && canonicalSpeakerSubmissionId(current.title) !== canonicalId;
      if (current === undefined || (!currentHasDescriptiveTitle && hasDescriptiveTitle)) {
        byCanonicalId.set(canonicalId, { ...submission, id: canonicalId });
      }
    }
    return [...byCanonicalId.values()];
  }

  private organizerRosterVisibility(
    eventId: string,
    scope: SpeakerAccessScope & { tenantId: string },
    submissions: readonly SpeakerSubmission[],
    profiles: readonly SpeakerProfile[],
    roster: readonly SpeakerRosterEntry[],
  ): {
    participantIds: string[];
    participantNames: ReadonlyMap<string, string>;
  } {
    const scopeParticipantIds = new Set(scope.participantIds);
    const acceptedParticipantIds = submissions.flatMap((submission) =>
      submission.eventId === eventId
        ? submission.participantIds.filter((participantId) =>
            scopeParticipantIds.has(participantId),
          )
        : [],
    );
    const scopedRoster = roster
      .filter(
        (entry) =>
          entry.eventId === eventId &&
          entry.status !== "revoked" &&
          organizerRecordTenantMatches(entry, scope.tenantId),
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      );
    const participantIds = unique([
      ...acceptedParticipantIds,
      ...scopedRoster.filter(isOrganizerManagedRosterEntry).map((entry) => entry.participantId),
    ]);
    const visible = new Set(participantIds);
    const participantNames = new Map<string, string>();
    for (const profile of profiles) {
      if (
        profile.eventId === eventId &&
        organizerRecordTenantMatches(profile, scope.tenantId) &&
        visible.has(profile.participantId) &&
        profile.displayName.trim().length > 0
      ) {
        participantNames.set(profile.participantId, profile.displayName);
      }
    }
    for (const entry of scopedRoster) {
      if (
        visible.has(entry.participantId) &&
        !participantNames.has(entry.participantId) &&
        entry.displayName.trim().length > 0
      ) {
        participantNames.set(entry.participantId, entry.displayName);
      }
    }
    return { participantIds, participantNames };
  }

  private async acceptedOrganizerParticipantIds(
    eventId: string,
    scope: SpeakerAccessScope,
  ): Promise<ReadonlySet<string>> {
    const submissions = await this.acceptedOrganizerSubmissions(eventId, scope);
    return new Set(
      submissions.flatMap((submission) =>
        submission.participantIds.filter((participantId) =>
          scope.participantIds.includes(participantId),
        ),
      ),
    );
  }

  async listOrganizerProfiles(eventId: string, accountId: string): Promise<SpeakerProfile[]> {
    const getOrganizerReadModel = this.repository.getOrganizerReadModel;
    if (getOrganizerReadModel !== undefined) {
      const model = await getOrganizerReadModel.call(this.repository, eventId, accountId, {
        profiles: true,
      });
      if (model === null) throw notFound();
      const scope = this.readModelScope(model, eventId);
      const listedParticipantIds = new Set(
        this.acceptedOrganizerSubmissionsFrom(eventId, scope, model.submissions).flatMap(
          (submission) =>
            submission.participantIds.filter((participantId) =>
              scope.participantIds.includes(participantId),
            ),
        ),
      );
      for (const entry of this.organizerRosterEntriesFromReadModel(
        eventId,
        scope,
        model.roster,
        model.profiles,
      )) {
        if (isOrganizerManagedRosterEntry(entry)) listedParticipantIds.add(entry.participantId);
      }
      return model.profiles.filter(
        (profile) => profile.eventId === eventId && listedParticipantIds.has(profile.participantId),
      );
    }

    const scope = await this.requireOrganizerScope(eventId, accountId);
    const listedParticipantIds = new Set(
      await this.acceptedOrganizerParticipantIds(eventId, scope),
    );
    const entries = await this.organizerRosterEntries(scope.tenantId, eventId, scope, accountId);
    for (const entry of entries) {
      if (isOrganizerManagedRosterEntry(entry)) listedParticipantIds.add(entry.participantId);
    }
    const profiles = await this.repository.listProfiles(eventId, [...listedParticipantIds]);
    return profiles.filter(
      (profile) => profile.eventId === eventId && listedParticipantIds.has(profile.participantId),
    );
  }

  async updateOrganizerProfile(input: EditableSpeakerProfileInput): Promise<SpeakerProfile> {
    const scope = await this.requireOrganizerScope(input.eventId, input.accountId);
    assertExpectedVersion(input.expectedVersion);
    if (!scope.participantIds.includes(input.participantId)) throw notFound();
    const current = await this.repository.getProfile(input.eventId, input.participantId);
    if (current === null || current.eventId !== input.eventId) throw notFound();
    if (current.version !== input.expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The speaker profile has changed. Reload it before saving.",
      );
    }
    const socialLinks = normalizeSocialLinks(input.socialLinks ?? input.social);
    const temporalContext = await this.eventTemporalContext(scope.tenantId, input.eventId);
    const currentTravelLogistics =
      current.travelLogistics === undefined
        ? undefined
        : travelLogisticsFrom(current.travelLogistics, temporalContext?.timeZone);
    const travelLogistics =
      input.travelLogistics === undefined
        ? undefined
        : normalizeTravelLogistics({
            ...(currentTravelLogistics ?? {}),
            ...input.travelLogistics,
          });
    const jobTitle =
      input.jobTitle === undefined
        ? undefined
        : normalizeOptionalProfileText(input.jobTitle, "The speaker job title", 160);
    const company =
      input.company === undefined
        ? undefined
        : normalizeOptionalProfileText(input.company, "The speaker company", 200);
    const headshotAssetId = input.headshotAssetId;
    if (headshotAssetId !== undefined && headshotAssetId !== null) {
      const asset = await this.repository.getAsset(input.eventId, headshotAssetId);
      if (
        asset === null ||
        asset.eventId !== input.eventId ||
        asset.participantId !== input.participantId ||
        asset.kind !== "headshot" ||
        asset.state !== "ready" ||
        (asset.tenantId !== undefined && asset.tenantId !== scope.tenantId)
      ) {
        throw notFound();
      }
    }
    const command = {
      eventId: input.eventId,
      participantId: input.participantId,
      ...(jobTitle === undefined ? {} : { jobTitle }),
      ...(company === undefined ? {} : { company }),
      ...(input.biography === undefined ? {} : { biography: normalizeBiography(input.biography) }),
      ...(socialLinks === undefined ? {} : { socialLinks }),
      ...(travelLogistics === undefined ? {} : { travelLogistics }),
      ...(headshotAssetId === undefined ? {} : { headshotAssetId }),
      expectedVersion: input.expectedVersion,
      updatedAt: this.now().toISOString(),
      actorAccountId: input.accountId,
    };
    if (this.repository.updateProfile === undefined) {
      throw notFound();
    }
    const result = await this.repository.updateProfile(command);
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The speaker profile has changed. Reload it before saving.",
        );
      }
      throw notFound();
    }
    const persisted = await this.repository.getProfile(input.eventId, input.participantId);
    if (persisted === null || persisted.version !== input.expectedVersion + 1) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The speaker profile could not be verified after saving.",
      );
    }
    return persisted;
  }

  async updateProfile(input: EditableSpeakerProfileInput): Promise<SpeakerProfile> {
    assertExpectedVersion(input.expectedVersion);
    const scope = await this.getScope(input.eventId, input.accountId);
    assertCapability(scope, "profile-self", input.participantId);
    const profile = await this.speakerProfileForScope(input.eventId, input.participantId, scope);
    if (profile.version !== input.expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The speaker profile has changed. Reload it before saving.",
      );
    }

    const biography =
      input.biography === undefined ? undefined : normalizeBiography(input.biography);
    const jobTitle =
      input.jobTitle === undefined
        ? undefined
        : normalizeOptionalProfileText(input.jobTitle, "The speaker job title", 160);
    const company =
      input.company === undefined
        ? undefined
        : normalizeOptionalProfileText(input.company, "The speaker company", 200);
    const socialLinks = normalizeSocialLinks(input.socialLinks ?? input.social);
    const temporalContext =
      scope.tenantId === undefined
        ? undefined
        : await this.eventTemporalContext(scope.tenantId, input.eventId);
    const currentTravelLogistics =
      profile.travelLogistics === undefined
        ? undefined
        : travelLogisticsFrom(profile.travelLogistics, temporalContext?.timeZone);
    const travelLogistics =
      input.travelLogistics === undefined
        ? undefined
        : normalizeTravelLogistics({
            ...(currentTravelLogistics ?? {}),
            ...input.travelLogistics,
          });
    const headshotAssetId = input.headshotAssetId;
    if (headshotAssetId !== undefined && headshotAssetId !== null) {
      const asset = await this.repository.getAsset(input.eventId, headshotAssetId);
      if (
        asset === null ||
        asset.eventId !== input.eventId ||
        asset.participantId !== input.participantId ||
        asset.kind !== "headshot" ||
        asset.state !== "ready" ||
        (scope.tenantId !== undefined &&
          asset.tenantId !== undefined &&
          asset.tenantId !== scope.tenantId)
      ) {
        throw notFound();
      }
    }
    if (
      biography === undefined &&
      jobTitle === undefined &&
      company === undefined &&
      socialLinks === undefined &&
      travelLogistics === undefined &&
      headshotAssetId === undefined
    ) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "At least one speaker profile field is required.",
      );
    }

    const updatedAt = this.now().toISOString();
    const command = {
      eventId: input.eventId,
      participantId: input.participantId,
      ...(biography === undefined ? {} : { biography }),
      ...(jobTitle === undefined ? {} : { jobTitle }),
      ...(company === undefined ? {} : { company }),
      ...(socialLinks === undefined ? {} : { socialLinks }),
      ...(travelLogistics === undefined ? {} : { travelLogistics }),
      ...(headshotAssetId === undefined ? {} : { headshotAssetId }),
      expectedVersion: input.expectedVersion,
      updatedAt,
      actorAccountId: input.accountId,
    };
    if (this.repository.updateProfile === undefined) {
      throw notFound();
    }
    const result = await this.repository.updateProfile(command);
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The speaker profile has changed. Reload it before saving.",
        );
      }
      throw notFound();
    }
    const persisted = await this.repository.getProfile(input.eventId, input.participantId);
    if (persisted === null || persisted.version !== input.expectedVersion + 1) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The speaker profile could not be verified after saving.",
      );
    }
    return persisted;
  }
  async updateBiography(input: {
    eventId: string;
    accountId: string;
    participantId: string;
    biography: string;
    expectedVersion: number;
  }): Promise<SpeakerProfile> {
    assertExpectedVersion(input.expectedVersion);
    const scope = await this.getScope(input.eventId, input.accountId);
    assertCapability(scope, "profile-self", input.participantId);
    const profile = await this.speakerProfileForScope(input.eventId, input.participantId, scope);
    if (profile.version !== input.expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The speaker profile has changed. Reload it before saving.",
      );
    }

    const result = await this.repository.updateBiography({
      eventId: input.eventId,
      participantId: input.participantId,
      biography: normalizeBiography(input.biography),
      expectedVersion: input.expectedVersion,
      updatedAt: this.now().toISOString(),
    });
    if (!result.ok) {
      if (result.reason === "version_conflict") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The speaker profile has changed. Reload it before saving.",
        );
      }
      throw notFound();
    }
    const persisted = await this.repository.getProfile(input.eventId, input.participantId);
    if (persisted === null || persisted.version !== input.expectedVersion + 1) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The speaker profile could not be verified after saving.",
      );
    }
    return persisted;
  }

  async previewOutstandingReminders(input: {
    eventId: string;
    accountId: string;
    taskIds?: readonly string[];
    recipientIds?: readonly string[];
  }): Promise<SpeakerReminderPreview> {
    const previewNow = this.now();
    const eligibility = await this.previewReminderEligibility({
      eventId: input.eventId,
      accountId: input.accountId,
      ...(input.taskIds === undefined ? {} : { taskIds: input.taskIds }),
      ...(input.recipientIds === undefined ? {} : { recipientIds: input.recipientIds }),
      now: previewNow,
    });
    const eligibilityByTask = new Map(
      eligibility.items.map((item) => [item.taskId, item] as const),
    );
    const matrix = await this.listDeliverables(input.eventId, input.accountId, {
      status: "incomplete",
    });
    const allowedTasks = input.taskIds === undefined ? undefined : new Set(input.taskIds);
    const allowedRecipients =
      input.recipientIds === undefined ? undefined : new Set(input.recipientIds);
    const profiles = await this.repository.listProfiles(
      input.eventId,
      (await this.requireOrganizerScope(input.eventId, input.accountId)).participantIds,
    );
    const profileByParticipant = new Map(
      profiles.map((profile) => [profile.participantId, profile]),
    );
    const byRecipient = new Map<string, SpeakerReminderRecipientBuilder>();
    for (const row of matrix.items) {
      if (row.task.owner !== "speaker") continue;
      if (allowedTasks !== undefined && !allowedTasks.has(row.task.id)) continue;
      if (allowedRecipients !== undefined && !allowedRecipients.has(row.participantId)) continue;
      const existing = byRecipient.get(row.participantId);
      const profile = profileByParticipant.get(row.participantId);
      const task = {
        taskId: row.task.id,
        title: row.task.title,
        ...(row.task.dueAt === undefined ? {} : { dueAt: row.task.dueAt }),
        participantId: row.participantId,
        ...(eligibilityByTask.get(row.task.id) === undefined
          ? {}
          : {
              cadenceWindow: reminderCadenceWindow(
                eligibilityByTask.get(row.task.id)?.deadlineAt ?? null,
                eligibilityByTask.get(row.task.id)?.reminderOffsetsMinutes ?? [],
                previewNow,
              ),
            }),
      };
      if (existing === undefined) {
        byRecipient.set(row.participantId, {
          participantId: row.participantId,
          displayName: profile?.displayName ?? row.participantId,
          ...(profile?.email === undefined ? {} : { email: profile.email }),
          taskIds: [row.task.id],
          tasks: [task],
        });
      } else {
        existing.taskIds.push(row.task.id);
        existing.tasks.push(task);
      }
    }
    const recipients = [...byRecipient.values()]
      .map((recipient) => ({
        ...recipient,
        taskIds: [...recipient.taskIds],
        tasks: [...recipient.tasks],
      }))
      .sort((left, right) => left.participantId.localeCompare(right.participantId));
    return {
      organizationId: matrix.organizationId,
      eventId: input.eventId,
      recipients,
      recipientIds: recipients.map((recipient) => recipient.participantId),
      taskIds: unique(recipients.flatMap((recipient) => recipient.taskIds)),
    };
  }

  async previewReminderEligibility(input: {
    eventId: string;
    accountId: string;
    taskIds?: readonly string[];
    recipientIds?: readonly string[];
    now?: Date;
  }): Promise<{
    organizationId: string;
    eventId: string;
    items: readonly SpeakerReminderEligibility[];
    eligibleTaskIds: readonly string[];
    eligibleRecipientIds: readonly string[];
  }> {
    const scope = await this.requireOrganizerScope(input.eventId, input.accountId);
    const requestedTasks = input.taskIds === undefined ? undefined : new Set(input.taskIds);
    const requestedRecipients =
      input.recipientIds === undefined ? undefined : new Set(input.recipientIds);
    const referenceNow = input.now ?? this.now();
    const temporalContext = await this.eventTemporalContext(scope.tenantId, input.eventId);
    const tasks = await this.repository.listTasks(input.eventId, scope.participantIds);
    const eligibleTasks = (
      await Promise.all(
        tasks.map(async (task) => {
          const subject = speakerTaskSubject(task);
          if (
            subject === undefined ||
            task.eventId !== input.eventId ||
            task.type !== "upload" ||
            task.owner !== "speaker" ||
            !scope.participantIds.includes(task.participantId) ||
            (requestedTasks !== undefined && !requestedTasks.has(task.id)) ||
            (requestedRecipients !== undefined && !requestedRecipients.has(task.participantId))
          ) {
            return undefined;
          }
          if (subject.type === "participant") return task;
          try {
            await this.acceptedSession(
              scope.tenantId,
              input.eventId,
              task.participantId,
              subject.sessionId,
            );
            return task;
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((task): task is SpeakerTask => task !== undefined);
    const items = eligibleTasks
      .map((task) => {
        const dueAt = task.dueAt ?? task.dueDate ?? null;
        const offsets = [...(task.reminderOffsetsMinutes ?? [])].filter(
          (offset) => Number.isSafeInteger(offset) && offset >= 0,
        );
        const complete = ["completed", "submitted", "waived"].includes(task.status);
        const deadline =
          dueAt === null || temporalContext === undefined
            ? null
            : calendarDateDeadline(dueAt, temporalContext.timeZone);
        const dueTime = deadline?.epochMilliseconds ?? Number.NaN;
        const due = Number.isFinite(dueTime) && dueTime <= referenceNow.getTime();
        const inWindow =
          Number.isFinite(dueTime) &&
          offsets.some((offset) => referenceNow.getTime() >= dueTime - offset * 60_000);
        const reason: SpeakerReminderEligibility["reason"] = complete
          ? "complete"
          : dueAt === null
            ? "no_due_date"
            : offsets.length === 0
              ? "no_reminder_offset"
              : due
                ? "due"
                : inWindow
                  ? "window"
                  : "outside_window";
        return {
          taskId: task.id,
          participantId: task.participantId,
          title: task.title,
          dueAt,
          deadlineAt: deadline?.instant ?? null,
          reminderOffsetsMinutes: offsets,
          eligible:
            !complete && offsets.length > 0 && Number.isFinite(dueTime) && (due || inWindow),
          reason,
        };
      })
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
    return {
      organizationId: scope.tenantId,
      eventId: input.eventId,
      items,
      eligibleTaskIds: items.filter((item) => item.eligible).map((item) => item.taskId),
      eligibleRecipientIds: unique(
        items.filter((item) => item.eligible).map((item) => item.participantId),
      ),
    };
  }

  async listReminderEligibility(input: {
    eventId: string;
    accountId: string;
    taskIds?: readonly string[];
    recipientIds?: readonly string[];
  }): Promise<{
    organizationId: string;
    eventId: string;
    items: readonly SpeakerReminderEligibility[];
    eligibleTaskIds: readonly string[];
    eligibleRecipientIds: readonly string[];
  }> {
    return this.previewReminderEligibility(input);
  }

  async getReminderEligibility(input: {
    eventId: string;
    accountId: string;
    taskIds?: readonly string[];
    recipientIds?: readonly string[];
  }): Promise<{
    organizationId: string;
    eventId: string;
    items: readonly SpeakerReminderEligibility[];
    eligibleTaskIds: readonly string[];
    eligibleRecipientIds: readonly string[];
  }> {
    return this.previewReminderEligibility(input);
  }
  async listOrganizerSpeakerEmailTemplates(
    organizationId: string,
    eventId: string,
    accountId: string,
  ): Promise<readonly SpeakerEmailTemplate[]> {
    await this.requireOrganizerOrganizationScope(organizationId, eventId, accountId);
    try {
      return await this.requireCommunications().listTemplates(organizationId, eventId, accountId);
    } catch (error) {
      return this.communicationFailure(error, "EMAIL_TEMPLATE_NOT_FOUND");
    }
  }

  async createOrganizerSpeakerEmailTemplate(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    templateId?: string;
    name: string;
    subject: string;
    html?: string;
    text: string;
    status?: "draft" | "approved";
  }): Promise<SpeakerEmailTemplate> {
    await this.requireOrganizerOrganizationScope(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    try {
      return await this.requireCommunications().createTemplate({
        ...input,
        status: input.status ?? "approved",
      });
    } catch (error) {
      return this.communicationFailure(error, "VERSION_CONFLICT");
    }
  }

  async createOrganizerSpeakerEmailTemplateVersion(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    templateId: string;
    subject: string;
    html?: string;
    text: string;
    status?: "draft" | "approved";
  }): Promise<SpeakerEmailTemplate> {
    await this.requireOrganizerOrganizationScope(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    try {
      return await this.requireCommunications().createTemplateVersion({
        ...input,
        status: input.status ?? "approved",
      });
    } catch (error) {
      return this.communicationFailure(error, "VERSION_CONFLICT");
    }
  }

  async previewOrganizerSpeakerEmails(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    participantIds: readonly string[];
    templateId: string;
    templateVersion?: number;
  }): Promise<SpeakerEmailPreview> {
    await this.requireOrganizerOrganizationScope(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    try {
      return await this.requireCommunications().preview(input);
    } catch (error) {
      return this.communicationFailure(
        error,
        error instanceof CommunicationError && error.message.includes("template")
          ? "EMAIL_TEMPLATE_NOT_FOUND"
          : "EMAIL_PARTICIPANT_NOT_FOUND",
      );
    }
  }

  async sendOrganizerSpeakerEmails(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    previewId: string;
    idempotencyKey: string;
  }): Promise<SpeakerEmailSend> {
    await this.requireOrganizerOrganizationScope(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    try {
      return await this.requireCommunications().send(input);
    } catch (error) {
      return this.communicationFailure(error, "VERSION_CONFLICT");
    }
  }

  async listOrganizerSpeakerEmailHistory(
    organizationId: string,
    eventId: string,
    accountId: string,
  ): Promise<readonly SpeakerEmailSend[]> {
    await this.requireOrganizerOrganizationScope(organizationId, eventId, accountId);
    try {
      return await this.requireCommunications().listHistory(organizationId, eventId, accountId);
    } catch (error) {
      return this.communicationFailure(error, "VERSION_CONFLICT");
    }
  }

  async listSpeakerEmailHistory(
    organizationId: string,
    eventId: string,
    accountId: string,
  ): Promise<readonly SpeakerEmailSend[]> {
    return this.listOrganizerSpeakerEmailHistory(organizationId, eventId, accountId);
  }
  async queueReminders(input: SpeakerReminderQueueInput): Promise<SpeakerReminderQueueResult> {
    const preview = await this.previewOutstandingReminders(input);
    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `deliverables-reminder:${preview.organizationId}:${input.eventId}:${preview.taskIds.slice().sort().join(",")}:${preview.recipientIds.slice().sort().join(",")}`;
    return this.queueReminderPreview({
      preview,
      eventId: input.eventId,
      idempotencyKey,
      actorAccountId: input.accountId,
    });
  }

  async queueScheduledReminders(
    input: SpeakerScheduledReminderInput,
  ): Promise<SpeakerReminderQueueResult> {
    const organizationId = input.organizationId.trim();
    const eventId = input.eventId.trim();
    if (organizationId.length === 0 || eventId.length === 0) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "Scheduled reminder organization and event are required.",
      );
    }

    const candidates = (
      await Promise.all(
        unique(input.organizerAccountIds)
          .filter((accountId) => accountId.trim().length > 0)
          .map(async (accountId) => ({
            accountId,
            scope: await this.organizerScopeOrNull(eventId, accountId),
          })),
      )
    ).filter(
      (
        candidate,
      ): candidate is {
        readonly accountId: string;
        readonly scope: SpeakerAccessScope & { tenantId: string; organizer: true };
      } => candidate.scope?.tenantId === organizationId,
    );
    const organizer = candidates.sort(
      (left, right) =>
        right.scope.participantIds.length - left.scope.participantIds.length ||
        right.scope.submissionIds.length - left.scope.submissionIds.length ||
        left.accountId.localeCompare(right.accountId),
    )[0];
    if (organizer === undefined) {
      return {
        organizationId,
        eventId,
        idempotencyKey: `scheduled-deliverables-reminder:${organizationId}:${eventId}:`,
        queued: false,
        duplicate: false,
        sentCount: 0,
        recipientIds: [],
        failedCount: 0,
        duplicateCount: 0,
        receipts: [],
      };
    }

    const eligibility = await this.previewReminderEligibility({
      eventId,
      accountId: organizer.accountId,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const preview = await this.previewOutstandingReminders({
      eventId,
      accountId: organizer.accountId,
      taskIds: eligibility.eligibleTaskIds,
      recipientIds: eligibility.eligibleRecipientIds,
    });
    if (preview.organizationId !== organizationId) {
      return {
        organizationId,
        eventId,
        idempotencyKey: `scheduled-deliverables-reminder:${organizationId}:${eventId}:`,
        queued: false,
        duplicate: false,
        sentCount: 0,
        recipientIds: [],
        failedCount: 0,
        duplicateCount: 0,
        receipts: [],
      };
    }
    const idempotencyKey = `scheduled-deliverables-reminder:${organizationId}:${eventId}:${preview.taskIds.slice().sort().join(",")}:${preview.recipientIds.slice().sort().join(",")}`;
    return this.queueReminderPreview({
      preview,
      eventId,
      idempotencyKey,
      actorAccountId: speakerScheduledReminderActor,
    });
  }

  private async queueReminderPreview(input: {
    readonly preview: SpeakerReminderPreview;
    readonly eventId: string;
    readonly idempotencyKey: string;
    readonly actorAccountId: string;
  }): Promise<SpeakerReminderQueueResult> {
    const { preview, eventId, idempotencyKey, actorAccountId } = input;
    const cacheKey = `${preview.organizationId}:${eventId}:${idempotencyKey}`;
    const cached = this.reminderCache.get(cacheKey);
    if (cached !== undefined) {
      const receipts = cached.receipts.map((receipt) =>
        receipt.status === "failed"
          ? structuredClone(receipt)
          : { ...receipt, status: "duplicate" as const },
      );
      return {
        ...structuredClone(cached),
        queued: false,
        duplicate:
          receipts.length > 0 && receipts.every((receipt) => receipt.status === "duplicate"),
        sentCount: 0,
        failedCount: receipts.filter((receipt) => receipt.status === "failed").length,
        duplicateCount: receipts.filter((receipt) => receipt.status === "duplicate").length,
        receipts,
      };
    }
    const stored =
      this.repository.getReminder === undefined
        ? null
        : await this.repository.getReminder(eventId, idempotencyKey);
    if (
      stored !== null &&
      stored.organizationId === preview.organizationId &&
      stored.eventId === eventId
    ) {
      const receipts = stored.receipts.map((receipt) =>
        receipt.status === "failed"
          ? structuredClone(receipt)
          : { ...structuredClone(receipt), status: "duplicate" as const },
      );
      const failedCount = receipts.filter((receipt) => receipt.status === "failed").length;
      const duplicateCount = receipts.filter((receipt) => receipt.status === "duplicate").length;
      const duplicate: SpeakerReminderQueueResult = {
        organizationId: stored.organizationId,
        eventId: stored.eventId,
        idempotencyKey,
        queued: false,
        duplicate: duplicateCount > 0 && failedCount === 0,
        sentCount: 0,
        failedCount,
        duplicateCount,
        recipientIds: [...stored.recipientIds],
        receipts,
      };
      this.reminderCache.set(cacheKey, duplicate);
      return duplicate;
    }
    if (preview.recipients.length === 0) {
      const empty: SpeakerReminderQueueResult = {
        organizationId: preview.organizationId,
        eventId,
        idempotencyKey,
        queued: false,
        duplicate: false,
        sentCount: 0,
        recipientIds: [],
        failedCount: 0,
        duplicateCount: 0,
        receipts: [],
      };
      this.reminderCache.set(cacheKey, empty);
      return empty;
    }
    const delivery = this.delivery;
    if (
      delivery === undefined ||
      (delivery.enqueue === undefined &&
        delivery.queue === undefined &&
        delivery.enqueueReminder === undefined &&
        delivery.enqueueDeliverableReminder === undefined)
    ) {
      throw new SpeakerServiceError(
        "REMINDER_UNAVAILABLE",
        409,
        "Transactional reminder delivery is not configured.",
      );
    }
    const receipts = await Promise.all(
      preview.recipients.map(async (recipient) => {
        const command: SpeakerReminderDeliveryInput = {
          organizationId: preview.organizationId,
          eventId,
          recipient,
          idempotencyKey: `${idempotencyKey}:${recipient.participantId}`,
          actorAccountId,
        };
        try {
          let deliveryReceipt: SpeakerReminderDeliveryReceipt;
          if (delivery.enqueue !== undefined) {
            deliveryReceipt = await delivery.enqueue(command);
          } else if (delivery.queue !== undefined) {
            deliveryReceipt = await delivery.queue(command);
          } else if (delivery.enqueueReminder !== undefined) {
            deliveryReceipt = await delivery.enqueueReminder(command);
          } else if (delivery.enqueueDeliverableReminder !== undefined) {
            deliveryReceipt = await delivery.enqueueDeliverableReminder(command);
          } else {
            throw new SpeakerServiceError(
              "REMINDER_UNAVAILABLE",
              409,
              "Transactional reminder delivery is not configured.",
            );
          }
          return {
            participantId: recipient.participantId,
            status:
              deliveryReceipt.status === "failed"
                ? ("failed" as const)
                : deliveryReceipt.duplicate === true
                  ? ("duplicate" as const)
                  : deliveryReceipt.queued === false
                    ? ("failed" as const)
                    : ("queued" as const),
            receiptId: deliveryReceipt.id ?? null,
          };
        } catch {
          return {
            participantId: recipient.participantId,
            status: "failed" as const,
            receiptId: null,
          };
        }
      }),
    );
    const sentCount = receipts.filter((receipt) => receipt.status === "queued").length;
    const failedCount = receipts.filter((receipt) => receipt.status === "failed").length;
    const duplicateCount = receipts.filter((receipt) => receipt.status === "duplicate").length;
    const result: SpeakerReminderQueueResult = {
      organizationId: preview.organizationId,
      eventId,
      idempotencyKey,
      queued: sentCount > 0,
      duplicate: duplicateCount > 0 && failedCount === 0 && sentCount === 0,
      sentCount,
      failedCount,
      duplicateCount,
      recipientIds: preview.recipientIds,
      receipts,
    };
    this.reminderCache.set(cacheKey, result);
    if (this.repository.saveReminder !== undefined) {
      const record: SpeakerReminderRecord = {
        id: this.generateId(),
        organizationId: preview.organizationId,
        eventId,
        idempotencyKey,
        taskIds: preview.taskIds,
        recipientIds: preview.recipientIds,
        receipts: structuredClone(receipts),
        createdAt: this.now().toISOString(),
        actorAccountId,
      };
      await this.repository.saveReminder(record);
    }
    return result;
  }

  async getContent(
    eventId: string,
    accountId: string,
    entityType: "session" | "speaker",
    entityId: string,
  ): Promise<SpeakerContentRecord> {
    const scope = await this.requireOrganizerScope(eventId, accountId);
    return this.contentForOrganizerScope(scope, eventId, entityType, entityId);
  }

  async listContentHistory(
    eventId: string,
    accountId: string,
    entityType: "session" | "speaker",
    entityId: string,
  ): Promise<SpeakerContentHistoryEntry[]> {
    const scope = await this.requireOrganizerScope(eventId, accountId);
    const history = await this.readContentHistory(eventId, entityType, entityId);
    return history
      .filter(
        (entry) =>
          entry.eventId === eventId &&
          entry.entityType === entityType &&
          entry.entityId === entityId &&
          Number.isSafeInteger(entry.version) &&
          entry.version > 0 &&
          entry.snapshot.tenantId === scope.tenantId &&
          entry.snapshot.eventId === eventId &&
          entry.snapshot.entityType === entityType &&
          entry.snapshot.entityId === entityId &&
          entry.snapshot.version === entry.version,
      )
      .sort(
        (left, right) =>
          left.version - right.version || left.occurredAt.localeCompare(right.occurredAt),
      );
  }

  async updateContent(input: SpeakerContentUpdateInput): Promise<SpeakerContentRecord> {
    const scope = await this.requireOrganizerScope(input.eventId, input.accountId);
    assertExpectedVersion(input.expectedVersion);
    const current = await this.contentForOrganizerScope(
      scope,
      input.eventId,
      input.entityType,
      input.entityId,
    );
    if (current.version !== input.expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The content has changed. Reload it before saving.",
      );
    }
    const socialLinks = normalizeSocialLinks(input.socialLinks);
    const patch: UpdateSpeakerContentCommand = {
      eventId: input.eventId,
      accountId: input.accountId,
      entityType: input.entityType,
      entityId: input.entityId,
      expectedVersion: input.expectedVersion,
      ...(input.title === undefined
        ? {}
        : { title: normalizeUserText(input.title, "The content title", 300) }),
      ...(input.description === undefined
        ? {}
        : {
            description: normalizeUserText(
              input.description,
              "The content description",
              100_000,
              true,
            ),
          }),
      ...(input.abstract === undefined
        ? {}
        : { abstract: normalizeUserText(input.abstract, "The content abstract", 100_000, true) }),
      ...(input.biography === undefined ? {} : { biography: normalizeBiography(input.biography) }),
      ...(socialLinks === undefined ? {} : { socialLinks }),
      ...(input.headshotAssetId === undefined ? {} : { headshotAssetId: input.headshotAssetId }),
      ...(input.status === undefined
        ? {}
        : { status: normalizeUserText(input.status, "The content status", 80) }),
      updatedAt: this.now().toISOString(),
    };
    if (
      patch.title === undefined &&
      patch.description === undefined &&
      patch.abstract === undefined &&
      patch.biography === undefined &&
      patch.socialLinks === undefined &&
      patch.headshotAssetId === undefined &&
      patch.status === undefined
    ) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "At least one content field must change.",
      );
    }
    const result = await this.callUpdateContent(patch);
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The content has changed. Reload it before saving.",
        );
      }
      throw notFound();
    }
    return result.value;
  }

  async restoreContentVersion(input: SpeakerContentRestoreInput): Promise<SpeakerContentRecord> {
    const scope = await this.requireOrganizerScope(input.eventId, input.accountId);
    if (!Number.isSafeInteger(input.version) || input.version <= 0) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "A positive content history version is required.",
      );
    }
    const current = await this.contentForOrganizerScope(
      scope,
      input.eventId,
      input.entityType,
      input.entityId,
    );
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The content has changed. Reload it before restoring.",
      );
    }
    const history = await this.readContentHistory(input.eventId, input.entityType, input.entityId);
    const target = history.find(
      (entry) =>
        entry.version === input.version &&
        entry.eventId === input.eventId &&
        entry.entityType === input.entityType &&
        entry.entityId === input.entityId &&
        entry.snapshot.tenantId === scope.tenantId &&
        entry.snapshot.eventId === input.eventId &&
        entry.snapshot.entityType === input.entityType &&
        entry.snapshot.entityId === input.entityId &&
        entry.snapshot.version === input.version,
    );
    if (target === undefined) throw notFound();
    const command = {
      ...input,
      expectedVersion: input.expectedVersion ?? current.version,
      updatedAt: this.now().toISOString(),
    };
    let result: RepositoryResult<SpeakerContentRecord>;
    if (this.repository.restoreContentVersion !== undefined) {
      result = await this.repository.restoreContentVersion(command);
    } else if (
      input.entityType === "session" &&
      this.repository.restoreSessionContentVersion !== undefined
    ) {
      result = await this.repository.restoreSessionContentVersion(command);
    } else if (
      input.entityType === "speaker" &&
      this.repository.restoreSpeakerContentVersion !== undefined
    ) {
      result = await this.repository.restoreSpeakerContentVersion(command);
    } else {
      result = await this.callUpdateContent({
        eventId: input.eventId,
        accountId: input.accountId,
        entityType: input.entityType,
        entityId: input.entityId,
        expectedVersion: current.version,
        ...(target.snapshot.title === undefined ? {} : { title: target.snapshot.title }),
        ...(target.snapshot.description === undefined
          ? {}
          : { description: target.snapshot.description }),
        ...(target.snapshot.abstract === undefined ? {} : { abstract: target.snapshot.abstract }),
        ...(target.snapshot.biography === undefined
          ? {}
          : { biography: target.snapshot.biography }),
        ...(target.snapshot.socialLinks === undefined
          ? {}
          : { socialLinks: target.snapshot.socialLinks }),
        ...(target.snapshot.headshotAssetId === undefined
          ? { headshotAssetId: null }
          : { headshotAssetId: target.snapshot.headshotAssetId }),
        ...(target.snapshot.status === undefined ? {} : { status: target.snapshot.status }),
        updatedAt: command.updatedAt,
      });
    }
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The content has changed. Reload it before restoring.",
        );
      }
      throw notFound();
    }
    return result.value;
  }

  async getSessionContent(
    eventId: string,
    accountId: string,
    sessionId: string,
  ): Promise<SpeakerContentRecord> {
    return this.getContent(eventId, accountId, "session", sessionId);
  }

  async getSpeakerContent(
    eventId: string,
    accountId: string,
    participantId: string,
  ): Promise<SpeakerContentRecord> {
    return this.getContent(eventId, accountId, "speaker", participantId);
  }

  async listSessionContentHistory(
    eventId: string,
    accountId: string,
    sessionId: string,
  ): Promise<SpeakerContentHistoryEntry[]> {
    return this.listContentHistory(eventId, accountId, "session", sessionId);
  }

  async listSpeakerContentHistory(
    eventId: string,
    accountId: string,
    participantId: string,
  ): Promise<SpeakerContentHistoryEntry[]> {
    return this.listContentHistory(eventId, accountId, "speaker", participantId);
  }
  async listDeliverablesMatrix(
    eventId: string,
    accountId: string,
    filters: SpeakerDeliverablesQuery = {},
  ): Promise<SpeakerDeliverablesMatrix> {
    return this.listDeliverables(eventId, accountId, filters);
  }

  async getDeliverablesMatrix(
    eventId: string,
    accountId: string,
    filters: SpeakerDeliverablesQuery = {},
  ): Promise<SpeakerDeliverablesMatrix> {
    return this.listDeliverables(eventId, accountId, filters);
  }

  async previewReminders(input: {
    eventId: string;
    accountId: string;
    taskIds?: readonly string[];
    recipientIds?: readonly string[];
  }): Promise<SpeakerReminderPreview> {
    return this.previewOutstandingReminders(input);
  }

  async queueReminderEmails(input: SpeakerReminderQueueInput): Promise<SpeakerReminderQueueResult> {
    return this.queueReminders(input);
  }

  async sendBulkReminder(input: SpeakerReminderQueueInput): Promise<SpeakerReminderQueueResult> {
    return this.queueReminders(input);
  }

  async updateSpeakerProfile(input: SpeakerOrganizerProfileInput): Promise<SpeakerProfile> {
    return this.updateOrganizerProfile(input);
  }

  async restoreContent(input: SpeakerContentRestoreInput): Promise<SpeakerContentRecord> {
    return this.restoreContentVersion(input);
  }
  async transitionTask(input: {
    eventId: string;
    accountId: string;
    taskId: string;
    toStatus: SpeakerTaskStatus;
    expectedVersion: number;
    note?: string;
  }): Promise<{ task: SpeakerTask; transitionId: string }> {
    assertExpectedVersion(input.expectedVersion);
    const scope = await this.getScope(input.eventId, input.accountId);
    const task = await this.repository.getTask(input.eventId, input.taskId);
    if (task === null) throw notFound();
    const projectedTask = await this.projectTask(input.eventId, scope, task);
    if (projectedTask === undefined) throw notFound();
    assertCapability(scope, "task-response", task.participantId);
    if (task.version !== input.expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The speaker task has changed. Reload it before saving.",
      );
    }

    await this.assertTaskIsActive(task);
    await this.assertDependenciesComplete(task);
    if (input.toStatus === "submitted" && task.status === "submitted") {
      await this.assertTaskAssetsReady(task);
      return {
        task: projectedTask,
        transitionId: this.generateId(),
      };
    }
    if (input.toStatus === "submitted") {
      await this.assertTaskAssetsReady(task);
    }
    if (!isSpeakerTransitionAllowed(task, input.toStatus)) {
      throw new SpeakerServiceError(
        "INVALID_TASK_TRANSITION",
        409,
        "This task transition is not available to the speaker.",
      );
    }

    const transitionId = this.generateId();
    const occurredAt = this.now().toISOString();
    const transitionNote = normalizeTransitionNote(input.note);
    const result = await this.repository.transitionTask({
      eventId: input.eventId,
      taskId: task.id,
      expectedVersion: input.expectedVersion,
      fromStatus: task.status,
      toStatus: input.toStatus,
      ...(input.toStatus === "submitted" && task.replacementBaselineAssetId !== undefined
        ? { replacementBaselineAssetId: task.replacementBaselineAssetId }
        : {}),
      transition: {
        id: transitionId,
        eventId: input.eventId,
        taskId: task.id,
        participantId: task.participantId,
        actorAccountId: input.accountId,
        fromStatus: task.status,
        toStatus: input.toStatus,
        ...(transitionNote === undefined ? {} : { note: transitionNote }),
        occurredAt,
      },
    });
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The speaker task has changed. Reload it before saving.",
        );
      }
      throw notFound();
    }

    const persisted = await this.repository.getTask(input.eventId, input.taskId);
    if (persisted === null || persisted.version !== input.expectedVersion + 1) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The task could not be verified after saving.",
      );
    }
    const projectedPersisted = await this.projectTask(input.eventId, scope, persisted);
    if (projectedPersisted === undefined) throw notFound();
    return {
      task: projectedPersisted,
      transitionId: result.value.transition.id,
    };
  }

  async issueUploadGrant(input: IssueUploadGrantInput): Promise<SpeakerUploadAuthorization> {
    const organizerScope = input.organizer
      ? await this.requireOrganizerScope(input.eventId, input.accountId)
      : null;
    const scope = organizerScope ?? (await this.getScope(input.eventId, input.accountId));
    this.assertParticipantAccess(scope, input.participantId);
    if (organizerScope === null) assertCapability(scope, "asset-write", input.participantId);
    const policy = uploadPolicies[input.kind];
    const contentType = input.contentType.trim().toLowerCase();
    if (
      !policy ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > policy.maximumBytes ||
      !policy.contentTypes.has(contentType)
    ) {
      throw new SpeakerServiceError(
        "UPLOAD_POLICY_VIOLATION",
        400,
        "The upload type or size is not allowed.",
      );
    }

    let task: SpeakerTask | null = null;
    const replacementIdempotencyKey = input.idempotencyKey?.trim();
    if (
      input.supersedesAssetId === undefined
        ? input.expectedLatestVersion !== undefined || input.idempotencyKey !== undefined
        : !Number.isSafeInteger(input.expectedLatestVersion) ||
          (input.expectedLatestVersion ?? 0) <= 0 ||
          replacementIdempotencyKey === undefined ||
          replacementIdempotencyKey.length === 0 ||
          replacementIdempotencyKey.length > 300
    ) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "Replacement uploads require an expected asset version and idempotency key.",
      );
    }
    const existing = input.supersedesAssetId
      ? await this.repository.getAsset(input.eventId, input.supersedesAssetId)
      : null;
    if (input.supersedesAssetId !== undefined && existing === null) {
      throw notFound();
    }
    if (
      input.supersedesAssetId !== undefined &&
      input.taskId !== undefined &&
      existing?.taskId !== input.taskId
    ) {
      throw notFound();
    }
    const taskId = input.taskId ?? existing?.taskId;
    let taskSubject: SpeakerTaskSubject | undefined;
    if (taskId !== undefined) {
      task = await this.repository.getTask(input.eventId, taskId);
      taskSubject = task === null ? undefined : speakerTaskSubject(task);
      if (
        !task ||
        taskSubject === undefined ||
        task.eventId !== input.eventId ||
        task.participantId !== input.participantId ||
        task.owner !== "speaker" ||
        task.type !== "upload"
      ) {
        throw notFound();
      }
      if (taskSubject.type === "session") {
        if (input.sessionId !== undefined && input.sessionId !== taskSubject.sessionId) {
          throw notFound();
        }
        if (scope.tenantId === undefined) throw notFound();
        await this.acceptedSession(
          scope.tenantId,
          input.eventId,
          task.participantId,
          taskSubject.sessionId,
        );
      }
      await this.assertTaskIsActive(task);
      if (
        ["completed", "waived"].includes(task.status) ||
        (task.acceptedAssetKinds && !task.acceptedAssetKinds.includes(input.kind))
      ) {
        throw new SpeakerServiceError(
          "UPLOAD_POLICY_VIOLATION",
          400,
          "This file is not allowed for the selected speaker task.",
        );
      }
      const allowedMimeTypes = task.allowedMimeTypes ?? [];
      const maxBytes = task.maxBytes ?? task.maxSizeBytes;
      const mimeAllowed = allowedMimeTypes.some(
        (allowed) =>
          allowed === contentType ||
          (allowed.endsWith("/*") && contentType.startsWith(`${allowed.slice(0, -1)}`)),
      );
      if (
        (allowedMimeTypes.length > 0 && !mimeAllowed) ||
        (maxBytes !== undefined && input.sizeBytes > maxBytes)
      ) {
        throw new SpeakerServiceError(
          "UPLOAD_POLICY_VIOLATION",
          400,
          "The file does not satisfy the speaker task's MIME or size policy.",
        );
      }
    }

    const requestedSessionId =
      taskSubject?.type === "session" ? taskSubject.sessionId : input.sessionId;
    const sessionId =
      taskSubject?.type === "participant" || (taskId === undefined && input.kind === "headshot")
        ? undefined
        : requestedSessionId;
    if (sessionId !== undefined) {
      await this.acceptedSession(
        scope.tenantId ?? input.eventId,
        input.eventId,
        input.participantId,
        sessionId,
      );
    } else if (taskSubject?.type !== "participant" && input.kind !== "headshot") {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "Session-scoped file uploads require an accepted program session.",
      );
    }
    const now = this.now();
    const assetId = this.generateId();
    const fileName = normalizeFileName(input.fileName);
    if (task?.status === "submitted" && existing === null) {
      throw new SpeakerServiceError(
        "UPLOAD_POLICY_VIOLATION",
        400,
        "Submitted tasks may only receive a new version of an existing file.",
      );
    }
    if (
      input.supersedesAssetId !== undefined &&
      (!existing ||
        existing.eventId !== input.eventId ||
        existing.participantId !== input.participantId ||
        (existing.tenantId !== undefined &&
          scope.tenantId !== undefined &&
          existing.tenantId !== scope.tenantId) ||
        existing.sessionId !== sessionId ||
        existing.kind !== input.kind ||
        (taskId !== undefined && existing.taskId !== taskId) ||
        !["ready", "rejected"].includes(existing.state))
    ) {
      throw notFound();
    }
    if (existing !== null && !["ready", "rejected"].includes(existing.state)) {
      throw new SpeakerServiceError(
        "UPLOAD_POLICY_VIOLATION",
        409,
        "Only a finalized asset can be superseded by a new immutable version.",
      );
    }
    if (existing !== null && (existing.version ?? 1) !== input.expectedLatestVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The selected asset version is stale. Reload the file before uploading.",
      );
    }
    let previousPointers: SpeakerAssetFamilyPointers | undefined;
    if (existing !== null) {
      const familyAssets = (
        await this.assetsForParticipants(input.eventId, [input.participantId])
      ).filter(
        (candidate) =>
          (candidate.versionFamilyId ?? candidate.id) ===
            (existing?.versionFamilyId ?? existing.id) &&
          (candidate.tenantId === undefined ||
            scope.tenantId === undefined ||
            candidate.tenantId === scope.tenantId),
      );
      previousPointers = assetFamilyPointers(familyAssets);
    }
    const resolvedUploaderLabel = await this.repository.getAccountDisplayName?.(input.accountId);
    const uploaderLabel =
      resolvedUploaderLabel?.trim() ||
      (organizerScope === null ? "Participant uploader" : "Organizer uploader");
    const successorVersion = input.expectedLatestVersion;
    let assetVersion = 1;
    if (existing !== null) {
      if (successorVersion === undefined) {
        throw new SpeakerServiceError(
          "VALIDATION_ERROR",
          400,
          "Replacement uploads require an expected asset version.",
        );
      }
      assetVersion = successorVersion + 1;
    }
    const versionFamilyId = existing?.versionFamilyId ?? existing?.id ?? `asset-family:${assetId}`;
    const asset: SpeakerAsset = {
      id: assetId,
      tenantId: scope.tenantId ?? input.eventId,
      eventId: input.eventId,
      ...(sessionId === undefined ? {} : { sessionId }),
      participantId: input.participantId,
      uploaderAccountId: input.accountId,
      uploaderLabel,
      ...(taskId === undefined ? {} : { taskId }),
      kind: input.kind,
      objectKey: [
        "events",
        encodeURIComponent(input.eventId),
        "participants",
        encodeURIComponent(input.participantId),
        input.kind,
        assetId,
      ].join("/"),
      fileName,
      contentType,
      sizeBytes: input.sizeBytes,
      state: "pending_upload",
      latestVersionId: assetId,
      ...(previousPointers?.current === undefined
        ? {}
        : { currentVersionId: previousPointers.current.id }),
      ...(previousPointers?.approved === undefined
        ? {}
        : { approvedVersionId: previousPointers.approved.id }),
      ...(previousPointers?.released === undefined
        ? {}
        : { releasedVersionId: previousPointers.released.id }),
      createdAt: now.toISOString(),
      version: assetVersion,
      versionFamilyId,
      ...(existing === null ? {} : { supersedesAssetId: existing.id }),
      commentThreadId: `asset-comments:${versionFamilyId}`,
      versionId: assetId,
    };
    let storedAsset: SpeakerAsset | null;
    if (existing === null) {
      await this.repository.createPendingAsset(asset);
      storedAsset = await this.repository.getAsset(input.eventId, assetId);
    } else {
      if (
        this.repository.createPendingAssetVersion === undefined ||
        replacementIdempotencyKey === undefined ||
        input.expectedLatestVersion === undefined
      ) {
        throw new Error("The speaker repository does not support atomic replacement creation.");
      }
      const requestDigest = await speakerSourceDigest(
        JSON.stringify({
          accountId: input.accountId,
          eventId: input.eventId,
          participantId: input.participantId,
          sessionId: sessionId ?? null,
          taskId: taskId ?? null,
          kind: input.kind,
          fileName,
          contentType,
          sizeBytes: input.sizeBytes,
          expectedLatestAssetId: existing.id,
          expectedLatestVersion: input.expectedLatestVersion,
        }),
      );
      const result = await this.repository.createPendingAssetVersion({
        asset,
        expectedLatestAssetId: existing.id,
        expectedLatestVersion: input.expectedLatestVersion,
        idempotencyKey: replacementIdempotencyKey,
        requestDigest,
      });
      if (!result.ok) {
        if (result.reason === "version_conflict" || result.reason === "invalid_state") {
          throw new SpeakerServiceError(
            "VERSION_CONFLICT",
            409,
            "The selected asset version is stale. Reload the file before uploading.",
          );
        }
        throw notFound();
      }
      storedAsset = result.value;
    }
    if (
      storedAsset === null ||
      storedAsset.state !== "pending_upload" ||
      storedAsset.latestVersionId !== storedAsset.id ||
      storedAsset.versionId !== storedAsset.id
    ) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The asset could not be verified after saving.",
      );
    }
    this.assetCache.set(`${input.eventId}:${storedAsset.id}`, storedAsset);
    const expiresAt = new Date(now.getTime() + uploadGrantLifetimeMs).toISOString();
    const binding: PrivateAssetCapabilityBinding = {
      capabilityId: storedAsset.id,
      tenantId: storedAsset.tenantId ?? input.eventId,
      eventId: input.eventId,
      subject:
        storedAsset.sessionId === undefined || storedAsset.sessionId === null
          ? { kind: "participant" }
          : { kind: "speaker_session", sessionId: storedAsset.sessionId },
      participantId: storedAsset.participantId,
      ...(storedAsset.taskId === undefined ? {} : { taskId: storedAsset.taskId }),
      objectKey: storedAsset.objectKey,
      contentType: storedAsset.contentType,
      sizeBytes: storedAsset.sizeBytes,
      fileName: storedAsset.fileName,
      expiresAt,
    };
    const grant =
      this.assetGateway.registerUploadCapability === undefined
        ? await this.assetGateway.createUploadGrant({
            objectKey: storedAsset.objectKey,
            contentType: storedAsset.contentType,
            sizeBytes: storedAsset.sizeBytes,
            expiresAt,
            private: true,
            requireMalwareScan: true,
            stripMetadata: policy.stripMetadata,
          })
        : await this.assetGateway.registerUploadCapability(binding);

    return { asset: storedAsset, grant };
  }

  async issueOrganizerUploadGrant(
    input: Omit<IssueUploadGrantInput, "organizer">,
  ): Promise<SpeakerUploadAuthorization> {
    return this.issueUploadGrant({ ...input, organizer: true });
  }

  async reauthorizePendingUpload(input: {
    eventId: string;
    accountId: string;
    assetId: string;
  }): Promise<SpeakerUploadAuthorization> {
    const scope = await this.getScope(input.eventId, input.accountId);
    const asset = await this.repository.getAsset(input.eventId, input.assetId);
    const assetSessionAllowed =
      asset !== null && (await this.speakerAssetAllowedByScope(scope, input.eventId, asset));
    if (
      asset === null ||
      asset.eventId !== input.eventId ||
      !scope.participantIds.includes(asset.participantId) ||
      (asset.tenantId !== undefined &&
        scope.tenantId !== undefined &&
        asset.tenantId !== scope.tenantId) ||
      !assetSessionAllowed
    ) {
      throw notFound();
    }
    assertCapability(scope, "asset-write", asset.participantId);
    if (asset.state !== "pending_upload") {
      throw new SpeakerServiceError(
        "ASSET_UPLOAD_RETRY_INVALID",
        409,
        "Only a pending upload can be re-authorized.",
      );
    }
    const policy = uploadPolicies[asset.kind];
    const expiresAt = new Date(this.now().getTime() + uploadGrantLifetimeMs).toISOString();
    const binding: PrivateAssetCapabilityBinding = {
      capabilityId: asset.id,
      tenantId: asset.tenantId ?? scope.tenantId ?? input.eventId,
      eventId: asset.eventId,
      subject:
        asset.sessionId === undefined || asset.sessionId === null
          ? { kind: "participant" }
          : { kind: "speaker_session", sessionId: asset.sessionId },
      participantId: asset.participantId,
      ...(asset.taskId === undefined ? {} : { taskId: asset.taskId }),
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      fileName: asset.fileName,
      expiresAt,
    };
    const grant =
      this.assetGateway.registerUploadCapability === undefined
        ? await this.assetGateway.createUploadGrant({
            objectKey: asset.objectKey,
            contentType: asset.contentType,
            sizeBytes: asset.sizeBytes,
            expiresAt,
            private: true,
            requireMalwareScan: true,
            stripMetadata: policy.stripMetadata,
          })
        : await this.assetGateway.registerUploadCapability(binding);
    return { asset, grant };
  }

  async issueDownloadGrant(input: {
    eventId: string;
    accountId: string;
    assetId: string;
  }): Promise<PrivateDownloadGrant> {
    const scope = await this.getScope(input.eventId, input.accountId);
    const primaryParticipantId = portalPrimaryParticipantId(scope);
    const asset = await this.repository.getAsset(input.eventId, input.assetId);
    const assetSessionAllowed =
      asset !== null && (await this.speakerAssetAllowedByScope(scope, input.eventId, asset));
    if (
      primaryParticipantId === undefined ||
      !asset ||
      asset.eventId !== input.eventId ||
      asset.state !== "ready" ||
      asset.participantId !== primaryParticipantId ||
      (asset.tenantId !== undefined &&
        scope.tenantId !== undefined &&
        asset.tenantId !== scope.tenantId) ||
      !assetSessionAllowed
    ) {
      throw notFound();
    }
    assertCapability(scope, "asset-read", primaryParticipantId);

    const expiresAt = new Date(this.now().getTime() + downloadGrantLifetimeMs).toISOString();
    const sessionId = asset.sessionId;
    const binding: PrivateDownloadCapabilityBinding = {
      capabilityId: asset.id,
      tenantId: asset.tenantId ?? scope.tenantId ?? input.eventId,
      eventId: input.eventId,
      subject:
        sessionId === undefined || sessionId === null
          ? { kind: "participant" }
          : { kind: "speaker_session", sessionId },
      participantId: primaryParticipantId,
      ...(asset.taskId === undefined ? {} : { taskId: asset.taskId }),
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      fileName: asset.fileName,
      expiresAt,
      requesterAccountId: input.accountId,
      requesterKind: "speaker",
      assetVersion: asset.version ?? 1,
    };
    return this.assetGateway.registerDownloadCapability === undefined
      ? await this.assetGateway.createDownloadGrant({
          objectKey: asset.objectKey,
          fileName: asset.fileName,
          expiresAt,
        })
      : await this.assetGateway.registerDownloadCapability(binding);
  }

  async listAssets(
    eventId: string,
    accountId: string,
    participantId?: string,
    versionFamilyId?: string,
  ): Promise<SpeakerAsset[]> {
    const scope = await this.getScope(eventId, accountId);
    const primaryParticipantId = portalPrimaryParticipantId(scope);
    if (
      primaryParticipantId === undefined ||
      (participantId !== undefined && participantId !== primaryParticipantId)
    ) {
      throw notFound();
    }
    assertCapability(scope, "asset-read", primaryParticipantId);
    const assets = await this.assetsForParticipants(eventId, [primaryParticipantId]);
    return (
      await Promise.all(
        assets.map(async (asset) =>
          asset.eventId === eventId &&
          asset.participantId === primaryParticipantId &&
          (versionFamilyId === undefined || asset.versionFamilyId === versionFamilyId) &&
          (asset.tenantId === undefined ||
            scope.tenantId === undefined ||
            asset.tenantId === scope.tenantId) &&
          (await this.speakerAssetAllowedByScope(scope, eventId, asset))
            ? asset
            : undefined,
        ),
      )
    ).filter((asset): asset is SpeakerAsset => asset !== undefined);
  }
  private async rosterSubmissionFor(
    eventId: string,
    accountId: string,
    requestedSubmissionId: string,
  ): Promise<{
    scope: SpeakerAccessScope;
    submission: SpeakerSubmission;
    requestedSubmissionId: string;
    canonicalSubmissionId: string;
    canManage: boolean;
  }> {
    const normalizedRequestedId = requestedSubmissionId.trim();
    if (normalizedRequestedId.length === 0) throw notFound();
    const scope = await this.getScope(eventId, accountId);
    const direct = await this.repository.getSubmission(eventId, normalizedRequestedId);
    const listed = await this.repository.listSubmissions(eventId, scope.submissionIds);
    const candidatesById = new Map<string, SpeakerSubmission>();
    for (const candidate of [direct, ...listed]) {
      if (
        candidate !== null &&
        candidate.eventId === eventId &&
        sameSpeakerSubmission(candidate.id, normalizedRequestedId) &&
        submissionIsVisibleToSpeaker(scope, candidate)
      ) {
        candidatesById.set(candidate.id, candidate);
      }
    }
    const candidates = [...candidatesById.values()];
    const canonicalRequestedId = canonicalSpeakerSubmissionId(normalizedRequestedId);
    const exact = candidates.filter((candidate) => candidate.id === normalizedRequestedId);
    const canonical = candidates.filter((candidate) => candidate.id === canonicalRequestedId);
    const preferred = exact.length > 0 ? exact : canonical.length > 0 ? canonical : candidates;
    if (preferred.length !== 1) throw notFound();
    const submission = preferred[0];
    if (submission === undefined) throw notFound();
    const canonicalSubmissionId = canonicalSpeakerSubmissionId(submission.id);
    return {
      scope,
      submission,
      requestedSubmissionId: normalizedRequestedId,
      canonicalSubmissionId,
      canManage: rosterManagementAllowed(scope, submission),
    };
  }
  async getRoster(
    eventId: string,
    accountId: string,
    submissionId: string,
  ): Promise<SpeakerRosterEnvelope> {
    const target = await this.rosterSubmissionFor(eventId, accountId, submissionId);
    if (this.repository.listRoster === undefined) throw notFound();
    const stored = (await this.repository.listRoster(eventId, target.canonicalSubmissionId)).filter(
      (entry) =>
        entry.eventId === eventId &&
        entry.submissionId !== undefined &&
        sameSpeakerSubmission(entry.submissionId, target.canonicalSubmissionId),
    );
    const byParticipant = new Map<string, SpeakerRosterEntry>();
    for (const entry of stored) {
      const existing = byParticipant.get(entry.participantId);
      if (
        existing === undefined ||
        entry.version > existing.version ||
        (entry.version === existing.version && entry.updatedAt > existing.updatedAt)
      ) {
        byParticipant.set(entry.participantId, entry);
      }
    }
    const missingParticipantIds = target.submission.participantIds.filter(
      (participantId) => !byParticipant.has(participantId),
    );
    if (missingParticipantIds.length > 0) {
      const profiles = await this.repository.listProfiles(eventId, missingParticipantIds);
      const profileByParticipant = new Map(
        profiles.map((profile) => [profile.participantId, profile]),
      );
      const primaryParticipantId = authoritativeSubmissionPrimaryParticipantId(target.submission);
      for (const participantId of missingParticipantIds) {
        const profile = profileByParticipant.get(participantId);
        const createdAt = target.submission.updatedAt;
        byParticipant.set(participantId, {
          id: `roster:${eventId}:${target.canonicalSubmissionId}:${participantId}`,
          eventId,
          submissionId: target.canonicalSubmissionId,
          participantId,
          displayName: profile?.displayName ?? participantId,
          role: participantId === primaryParticipantId ? "primary" : "co_speaker",
          status: "active",
          version: 1,
          createdAt,
          updatedAt: createdAt,
        });
      }
    }
    const members = [...byParticipant.values()]
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .map((entry) => publicRosterMember(entry, target.canManage));
    return {
      organizationId: target.scope.tenantId ?? eventId,
      eventId,
      submissionId: target.requestedSubmissionId,
      capabilities: {
        manage: target.canManage,
        invite: target.canManage,
      },
      members,
    };
  }

  async addRosterEntry(input: {
    eventId: string;
    accountId: string;
    submissionId: string;
    participantId?: string;
    email: string;
    displayName: string;
    role?: "co_speaker";
  }): Promise<SpeakerRosterEnvelope> {
    const target = await this.rosterSubmissionFor(
      input.eventId,
      input.accountId,
      input.submissionId,
    );
    if (!target.canManage) throw notFound();
    const current = await this.getRoster(
      input.eventId,
      input.accountId,
      target.requestedSubmissionId,
    );
    if (this.repository.saveRoster === undefined) throw notFound();
    const email = normalizeUserText(input.email, "The co-speaker email", 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      throw new SpeakerServiceError("VALIDATION_ERROR", 400, "The co-speaker email is invalid.");
    }
    const displayName = normalizeUserText(input.displayName, "The co-speaker name", 200);
    const participantId = input.participantId?.trim() || `participant:${this.generateId()}`;
    if (
      current.members.some(
        (member) =>
          member.status !== "revoked" &&
          (member.participantId === participantId || member.email?.toLowerCase() === email),
      )
    ) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "That co-speaker is already on the roster.",
      );
    }
    const now = this.now().toISOString();
    const entry: SpeakerRosterEntry = {
      id: `roster:${input.eventId}:${target.canonicalSubmissionId}:${participantId}`,
      eventId: input.eventId,
      submissionId: target.canonicalSubmissionId,
      participantId,
      displayName,
      email,
      role: input.role ?? "co_speaker",
      status: "pending",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.repository.saveRoster(entry, null);
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The roster changed. Reload it before inviting.",
        );
      }
      throw notFound();
    }
    return this.getRoster(input.eventId, input.accountId, input.submissionId);
  }

  async updateRosterEntry(input: {
    eventId: string;
    accountId: string;
    submissionId: string;
    participantId: string;
    displayName?: string;
    email?: string;
    role?: "co_speaker";
    status?: "pending" | "active" | "revoked";
    expectedVersion?: number;
  }): Promise<SpeakerRosterEnvelope> {
    const target = await this.rosterSubmissionFor(
      input.eventId,
      input.accountId,
      input.submissionId,
    );
    if (!target.canManage) throw notFound();
    const current = await this.getRoster(
      input.eventId,
      input.accountId,
      target.requestedSubmissionId,
    );
    const member = current.members.find(
      (candidate) => candidate.participantId === input.participantId,
    );
    if (member === undefined || member.role === "primary" || member.status === "revoked") {
      throw notFound();
    }
    if (this.repository.saveRoster === undefined) throw notFound();
    const existingEntries = await this.repository.listRoster?.(
      input.eventId,
      target.canonicalSubmissionId,
    );
    const existing = existingEntries?.find(
      (entry) =>
        entry.participantId === input.participantId &&
        entry.submissionId !== undefined &&
        sameSpeakerSubmission(entry.submissionId, target.canonicalSubmissionId),
    );
    if (existing === undefined) throw notFound();
    const expectedVersion = input.expectedVersion ?? existing.version;
    assertExpectedVersion(expectedVersion);
    if (existing.version !== expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The roster changed. Reload it before saving.",
      );
    }
    const email =
      input.email === undefined
        ? existing.email
        : normalizeUserText(input.email, "The co-speaker email", 320).toLowerCase();
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      throw new SpeakerServiceError("VALIDATION_ERROR", 400, "The co-speaker email is invalid.");
    }
    const updated: SpeakerRosterEntry = {
      ...existing,
      ...(input.displayName === undefined
        ? {}
        : { displayName: normalizeUserText(input.displayName, "The co-speaker name", 200) }),
      ...(email === undefined ? {} : { email }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.role === undefined ? {} : { role: input.role }),
      updatedAt: this.now().toISOString(),
      version: existing.version + 1,
    };
    const result = await this.repository.saveRoster(updated, expectedVersion);
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The roster changed. Reload it before saving.",
        );
      }
      throw notFound();
    }
    return this.getRoster(input.eventId, input.accountId, input.submissionId);
  }

  async removeRosterEntry(input: {
    eventId: string;
    accountId: string;
    submissionId: string;
    participantId: string;
    expectedVersion?: number;
  }): Promise<SpeakerRosterEnvelope> {
    const target = await this.rosterSubmissionFor(
      input.eventId,
      input.accountId,
      input.submissionId,
    );
    if (!target.canManage) throw notFound();
    const current = await this.getRoster(
      input.eventId,
      input.accountId,
      target.requestedSubmissionId,
    );
    const member = current.members.find(
      (candidate) => candidate.participantId === input.participantId,
    );
    if (member === undefined || member.role === "primary" || member.status === "revoked") {
      throw notFound();
    }
    const entries = await this.repository.listRoster?.(input.eventId, target.canonicalSubmissionId);
    const existing = entries?.find(
      (entry) =>
        entry.participantId === input.participantId &&
        entry.submissionId !== undefined &&
        sameSpeakerSubmission(entry.submissionId, target.canonicalSubmissionId),
    );
    if (existing === undefined) throw notFound();
    const expectedVersion = input.expectedVersion ?? existing.version;
    assertExpectedVersion(expectedVersion);
    if (existing.version !== expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The roster changed. Reload it before removing.",
      );
    }
    let result: RepositoryResult<SpeakerRosterEntry>;
    if (this.repository.revokeRoster !== undefined) {
      result = await this.repository.revokeRoster(
        input.eventId,
        target.canonicalSubmissionId,
        input.participantId,
        expectedVersion,
        this.now().toISOString(),
      );
    } else if (this.repository.saveRoster !== undefined) {
      result = await this.repository.saveRoster(
        {
          ...existing,
          status: "revoked",
          version: existing.version + 1,
          updatedAt: this.now().toISOString(),
        },
        expectedVersion,
      );
    } else {
      throw notFound();
    }
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The roster changed. Reload it before removing.",
        );
      }
      throw notFound();
    }
    return this.getRoster(input.eventId, input.accountId, input.submissionId);
  }
  private async speakerAssetAllowedByScope(
    scope: SpeakerAccessScope,
    eventId: string,
    asset: SpeakerAsset,
  ): Promise<boolean> {
    if (!scope.participantIds.includes(asset.participantId)) return false;
    if (asset.taskId === undefined) {
      if (asset.sessionId === undefined) return asset.kind === "headshot";
      if (scope.tenantId === undefined || asset.kind === "headshot") return false;
      try {
        await this.acceptedSession(scope.tenantId, eventId, asset.participantId, asset.sessionId);
        return true;
      } catch {
        return false;
      }
    }
    const task = await this.repository.getTask(eventId, asset.taskId);
    const subject = task === null ? undefined : speakerTaskSubject(task);
    if (
      subject === undefined ||
      task?.eventId !== eventId ||
      task.owner !== "speaker" ||
      task.type !== "upload" ||
      task.participantId !== asset.participantId
    ) {
      return false;
    }
    if (subject.type === "participant") return asset.sessionId === undefined;
    if (scope.tenantId === undefined || asset.sessionId !== subject.sessionId) return false;
    try {
      await this.acceptedSession(scope.tenantId, eventId, asset.participantId, subject.sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async listAssetHistory(
    eventId: string,
    accountId: string,
    assetId: string,
  ): Promise<SpeakerAsset[]> {
    const scope = await this.getScope(eventId, accountId);
    const asset = await this.repository.getAsset(eventId, assetId);
    const assetSessionAllowed =
      asset !== null && (await this.speakerAssetAllowedByScope(scope, eventId, asset));
    if (
      asset === null ||
      asset.eventId !== eventId ||
      !scope.participantIds.includes(asset.participantId) ||
      (asset.tenantId !== undefined &&
        scope.tenantId !== undefined &&
        asset.tenantId !== scope.tenantId) ||
      !assetSessionAllowed
    ) {
      throw notFound();
    }
    assertCapability(scope, "asset-read", asset.participantId);
    const familyId = asset.versionFamilyId ?? asset.id;
    const history =
      this.repository.listAssetHistory === undefined
        ? await this.assetsForParticipants(eventId, [asset.participantId])
        : await this.repository.listAssetHistory(eventId, familyId);
    return history
      .filter(
        (candidate) =>
          candidate.eventId === eventId &&
          candidate.participantId === asset.participantId &&
          (candidate.versionFamilyId ?? candidate.id) === familyId &&
          (candidate.tenantId === undefined ||
            scope.tenantId === undefined ||
            candidate.tenantId === scope.tenantId) &&
          candidate.sessionId === asset.sessionId &&
          candidate.taskId === asset.taskId,
      )
      .sort(
        (left, right) =>
          (left.version ?? 0) - (right.version ?? 0) ||
          left.createdAt.localeCompare(right.createdAt),
      );
  }

  async listAssetComments(
    eventId: string,
    accountId: string,
    assetId: string,
  ): Promise<SpeakerAssetComment[]> {
    const scope = await this.getScope(eventId, accountId);
    const asset = await this.repository.getAsset(eventId, assetId);
    const allowedByScope =
      asset === null ? false : await this.speakerAssetAllowedByScope(scope, eventId, asset);
    if (
      asset === null ||
      asset.eventId !== eventId ||
      !scope.participantIds.includes(asset.participantId) ||
      (asset.tenantId !== undefined &&
        scope.tenantId !== undefined &&
        asset.tenantId !== scope.tenantId) ||
      !allowedByScope
    ) {
      throw notFound();
    }
    assertCapability(scope, "asset-read", asset.participantId);
    if (this.repository.listAssetComments === undefined) throw notFound();
    const history = await this.listAssetHistory(eventId, accountId, assetId);
    return (await this.listAssetFamilyComments(eventId, history)).map((comment) => ({
      id: comment.id,
      eventId,
      assetId: comment.assetId,
      versionId: comment.versionId,
      body: comment.body,
      authorLabel: comment.authorLabel,
      createdAt: comment.createdAt,
      ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
      ...(comment.version === undefined ? {} : { version: comment.version }),
    }));
  }

  async addAssetComment(input: {
    eventId: string;
    accountId: string;
    assetId: string;
    body: string;
    expectedVersion?: number;
  }): Promise<SpeakerAssetComment> {
    const scope = await this.getScope(input.eventId, input.accountId);
    const asset = await this.repository.getAsset(input.eventId, input.assetId);
    const allowedByScope =
      asset === null ? false : await this.speakerAssetAllowedByScope(scope, input.eventId, asset);
    if (
      asset === null ||
      asset.eventId !== input.eventId ||
      !scope.participantIds.includes(asset.participantId) ||
      (asset.tenantId !== undefined &&
        scope.tenantId !== undefined &&
        asset.tenantId !== scope.tenantId) ||
      !allowedByScope
    ) {
      throw notFound();
    }
    assertCapability(scope, "asset-comment", asset.participantId);
    if (this.repository.createAssetComment === undefined) throw notFound();
    const comments =
      this.repository.listAssetComments === undefined
        ? []
        : await this.listAssetThreadComments(input.eventId, asset);
    const latestVersion = comments.reduce((max, comment) => Math.max(max, comment.version ?? 0), 0);
    if (input.expectedVersion !== undefined && input.expectedVersion !== latestVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The comment thread changed. Reload it before posting.",
      );
    }
    const profile = await this.repository.getProfile(input.eventId, asset.participantId);
    const authorLabel =
      profile?.eventId === input.eventId &&
      profile.participantId === asset.participantId &&
      profile.displayName.trim().length > 0
        ? profile.displayName
        : "Speaker";
    const now = this.now().toISOString();
    const comment: SpeakerAssetComment = {
      id: this.generateId(),
      eventId: input.eventId,
      assetId: input.assetId,
      versionId: input.assetId,
      body: normalizeUserText(input.body, "The asset comment", 10_000, true),
      authorLabel,
      createdAt: now,
      updatedAt: now,
      version: latestVersion + 1,
      authorAccountId: input.accountId,
    };
    const stored = await this.repository.createAssetComment(comment);
    const audit: SpeakerAssetAuditEntry = {
      id: this.generateId(),
      organizationId: scope.tenantId ?? input.eventId,
      eventId: input.eventId,
      assetId: input.assetId,
      action: "commented",
      actorAccountId: input.accountId,
      note: stored.body,
      occurredAt: stored.createdAt,
      version: stored.version ?? latestVersion + 1,
    };
    const cachedAudit = this.assetAuditCache.get(`${input.eventId}:${input.assetId}`) ?? [];
    this.assetAuditCache.set(`${input.eventId}:${input.assetId}`, [...cachedAudit, audit]);
    if (this.repository.appendAssetAudit !== undefined)
      await this.repository.appendAssetAudit(audit);
    return {
      id: stored.id,
      eventId: input.eventId,
      assetId: input.assetId,
      versionId: stored.versionId,
      body: stored.body,
      authorLabel: stored.authorLabel,
      createdAt: stored.createdAt,
      ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }),
      ...(stored.version === undefined ? {} : { version: stored.version }),
    };
  }

  async getTaskForm(eventId: string, accountId: string, taskId: string): Promise<SpeakerTaskForm> {
    const scope = await this.getScope(eventId, accountId);
    const task = await this.repository.getTask(eventId, taskId);
    const subject = task === null ? undefined : speakerTaskSubject(task);
    if (
      task === null ||
      subject === undefined ||
      task.eventId !== eventId ||
      task.owner !== "speaker" ||
      !scope.participantIds.includes(task.participantId)
    ) {
      throw notFound();
    }
    if (subject.type === "session") {
      if (scope.tenantId === undefined) throw notFound();
      await this.acceptedSession(scope.tenantId, eventId, task.participantId, subject.sessionId);
    }
    assertCapability(scope, "task-response", task.participantId);
    await this.assertTaskIsActive(task);
    if (this.repository.getTaskForm === undefined) throw notFound();
    const definition = await this.repository.getTaskForm(eventId, taskId);
    if (
      definition === null ||
      definition.eventId !== eventId ||
      definition.taskId !== taskId ||
      definition.published !== true
    ) {
      throw notFound();
    }
    const records =
      this.repository.listTaskResponses === undefined
        ? []
        : await this.repository.listTaskResponses(eventId, taskId, task.participantId);
    const latest = latestTaskResponse(records);
    return publicTaskForm(
      definition,
      task,
      latest === undefined ? null : publicTaskResponse(latest),
    );
  }

  async getTaskResponse(
    eventId: string,
    accountId: string,
    taskId: string,
  ): Promise<SpeakerTaskResponseEnvelope> {
    const scope = await this.getScope(eventId, accountId);
    const task = await this.repository.getTask(eventId, taskId);
    if (task === null) throw notFound();
    await this.getTaskForm(eventId, accountId, taskId);
    const records =
      this.repository.listTaskResponses === undefined
        ? []
        : await this.repository.listTaskResponses(eventId, taskId, task.participantId);
    return publicTaskResponseEnvelope(scope, task, records);
  }

  async saveTaskResponse(input: {
    eventId: string;
    accountId: string;
    taskId: string;
    definitionVersion: number;
    answers: Readonly<Record<string, SpeakerFormAnswer>>;
    expectedVersion?: number;
  }): Promise<SpeakerTaskResponseEnvelope> {
    const form = await this.getTaskForm(input.eventId, input.accountId, input.taskId);
    if (input.definitionVersion !== form.definitionVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The task form changed. Reload it before saving.",
      );
    }
    const scope = await this.getScope(input.eventId, input.accountId);
    const task = await this.repository.getTask(input.eventId, input.taskId);
    if (task === null) throw notFound();
    if (
      this.repository.saveTaskResponse === undefined ||
      this.repository.listTaskResponses === undefined
    ) {
      throw notFound();
    }
    const definition = await this.repository.getTaskForm?.(input.eventId, input.taskId);
    if (definition === null || definition === undefined || definition.published !== true)
      throw notFound();
    const existingResponses = await this.repository.listTaskResponses(
      input.eventId,
      input.taskId,
      task.participantId,
    );
    const current = latestTaskResponse(existingResponses);
    const currentVersion = current?.version ?? 0;
    const expectedVersion = input.expectedVersion ?? currentVersion;
    assertExpectedVersion(expectedVersion);
    if (expectedVersion !== currentVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The task response changed. Reload it before saving.",
      );
    }
    const nextVersion = currentVersion + 1;
    const updatedAt = this.now().toISOString();
    const response: SpeakerTaskResponseRecord = {
      id: `response:${input.eventId}:${input.taskId}:${task.participantId}:v${nextVersion}`,
      eventId: input.eventId,
      taskId: input.taskId,
      participantId: task.participantId,
      definitionVersion: definition.version,
      answers: validateTaskAnswers(definition, input.answers),
      status: "draft",
      version: nextVersion,
      updatedAt,
    };
    const result = await this.repository.saveTaskResponse(
      response,
      current === undefined ? null : currentVersion,
    );
    if (!result.ok) {
      if (result.reason === "version_conflict" || result.reason === "invalid_state") {
        throw new SpeakerServiceError(
          "VERSION_CONFLICT",
          409,
          "The task response changed. Reload it before saving.",
        );
      }
      throw notFound();
    }
    return publicTaskResponseEnvelope(
      scope,
      task,
      await this.repository.listTaskResponses(input.eventId, input.taskId, task.participantId),
    );
  }

  async listResources(eventId: string, accountId: string): Promise<SpeakerEventResource[]> {
    const scope = await this.getScope(eventId, accountId);
    assertCapability(scope, "resource-read");
    if (this.repository.listEventResources === undefined) throw notFound();
    return (await this.repository.listEventResources(eventId))
      .filter((resource) => resource.eventId === eventId)
      .map(publicResource)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  async listWikiPages(eventId: string, accountId: string): Promise<SpeakerWikiPage[]> {
    const scope = await this.getScope(eventId, accountId);
    assertCapability(scope, "resource-read");
    if (this.repository.listWikiPages === undefined) throw notFound();
    return (await this.repository.listWikiPages(eventId))
      .filter((page) => page.eventId === eventId)
      .map(publicWikiPage)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  async finalizeAsset(input: {
    eventId: string;
    accountId: string;
    assetId: string;
    state: Extract<SpeakerAsset["state"], "ready" | "rejected">;
    rejectionReason?: string;
    organizer?: boolean;
  }): Promise<SpeakerAsset> {
    const scope =
      input.organizer === true
        ? await this.requireOrganizerScope(input.eventId, input.accountId)
        : await this.getScope(input.eventId, input.accountId);
    const asset = await this.repository.getAsset(input.eventId, input.assetId);
    const assetSessionAllowed =
      asset !== null && (await this.speakerAssetAllowedByScope(scope, input.eventId, asset));
    if (
      !asset ||
      asset.eventId !== input.eventId ||
      !scope.participantIds.includes(asset.participantId) ||
      (asset.tenantId !== undefined &&
        scope.tenantId !== undefined &&
        asset.tenantId !== scope.tenantId) ||
      !assetSessionAllowed
    ) {
      throw notFound();
    }
    if (input.organizer !== true) assertCapability(scope, "asset-write", asset.participantId);
    if (asset.state !== "pending_upload") {
      throw new SpeakerServiceError(
        "ASSET_FINALIZATION_INVALID",
        409,
        "This asset has already been finalized.",
      );
    }
    if (input.state === "ready" && input.rejectionReason !== undefined) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "A rejection reason is allowed only when rejecting an asset.",
      );
    }
    const rejectionReason = normalizeRejectionReason(input.rejectionReason);
    const capabilityBinding: PrivateAssetCapabilityBinding = {
      capabilityId: asset.id,
      tenantId: asset.tenantId ?? scope.tenantId ?? input.eventId,
      eventId: asset.eventId,
      subject:
        asset.sessionId === undefined || asset.sessionId === null
          ? { kind: "participant" }
          : { kind: "speaker_session", sessionId: asset.sessionId },
      participantId: asset.participantId,
      ...(asset.taskId === undefined ? {} : { taskId: asset.taskId }),
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      fileName: asset.fileName,
      expiresAt: asset.createdAt,
    };
    if (input.state === "ready") {
      const inspectObject = this.assetGateway.inspectObject;
      const verifyUploadCapability = this.assetGateway.verifyUploadCapability;
      if (inspectObject === undefined || verifyUploadCapability === undefined) {
        throw new SpeakerServiceError(
          "CAPABILITY_UNAVAILABLE",
          409,
          "Uploaded object verification is not configured for asset finalization.",
        );
      }
      let verified = false;
      let metadata: Awaited<ReturnType<NonNullable<PrivateAssetGateway["inspectObject"]>>>;
      try {
        verified = await verifyUploadCapability.call(this.assetGateway, capabilityBinding);
        metadata = await inspectObject.call(this.assetGateway, {
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          sizeBytes: asset.sizeBytes,
        });
      } catch {
        throw new SpeakerServiceError(
          "CAPABILITY_UNAVAILABLE",
          409,
          "The uploaded object could not be inspected.",
        );
      }
      if (
        !verified ||
        metadata === null ||
        metadata.sizeBytes !== asset.sizeBytes ||
        metadata.contentType.trim().toLowerCase() !== asset.contentType.trim().toLowerCase()
      ) {
        throw new SpeakerServiceError(
          "ASSET_FINALIZATION_INVALID",
          409,
          "The uploaded object does not match the authorized asset.",
        );
      }
    }
    const invalidateUploadCapability = this.assetGateway.invalidateUploadCapability;
    if (invalidateUploadCapability === undefined) {
      throw new SpeakerServiceError(
        "CAPABILITY_UNAVAILABLE",
        409,
        "Upload capability invalidation is not configured for asset finalization.",
      );
    }
    try {
      await invalidateUploadCapability.call(this.assetGateway, capabilityBinding);
    } catch {
      throw new SpeakerServiceError(
        "ASSET_FINALIZATION_INVALID",
        409,
        "The upload capability is no longer valid for this asset.",
      );
    }
    const command: FinalizeSpeakerAssetCommand = {
      eventId: input.eventId,
      assetId: input.assetId,
      state: input.state,
      finalizedAt: this.now().toISOString(),
      ...(rejectionReason === undefined ? {} : { rejectionReason }),
      latestVersionId: asset.id,
      ...(input.state === "ready"
        ? { currentVersionId: asset.id }
        : asset.currentVersionId === undefined
          ? {}
          : { currentVersionId: asset.currentVersionId }),
    };
    const result =
      this.repository.finalizeAsset === undefined
        ? { ok: true as const, value: this.updateCachedAsset(asset, command) }
        : await this.repository.finalizeAsset(command);
    if (!result.ok) {
      if (result.reason === "invalid_state" || result.reason === "version_conflict") {
        throw new SpeakerServiceError(
          "ASSET_FINALIZATION_INVALID",
          409,
          "This asset has already been finalized.",
        );
      }
      throw notFound();
    }
    const persisted = await this.repository.getAsset(input.eventId, input.assetId);
    if (
      persisted === null ||
      persisted.state !== input.state ||
      persisted.latestVersionId !== asset.id ||
      (input.state === "ready" && persisted.currentVersionId !== asset.id)
    ) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The asset could not be verified after finalizing.",
      );
    }
    this.assetCache.set(`${input.eventId}:${persisted.id}`, persisted);
    return persisted;
  }

  async consumeUploadCapability(
    capabilityId: string,
    token: string,
    request: Request,
  ): Promise<PrivateUploadReceipt> {
    if (this.assetGateway.consumeUploadCapability === undefined) {
      throw new SpeakerServiceError(
        "CAPABILITY_UNAVAILABLE",
        409,
        "Private upload capabilities are not configured.",
      );
    }
    try {
      return await this.assetGateway.consumeUploadCapability(capabilityId, token, request);
    } catch (error) {
      if (error instanceof SpeakerServiceError) throw error;
      throw capabilityError(error, "The upload capability is invalid or has expired.");
    }
  }

  async consumeDownloadCapability(
    capabilityId: string,
    token: string,
  ): Promise<PrivateDownloadObject> {
    if (this.assetGateway.consumeDownloadCapability === undefined) {
      throw new SpeakerServiceError(
        "CAPABILITY_UNAVAILABLE",
        409,
        "Private download capabilities are not configured.",
      );
    }
    try {
      return await this.assetGateway.consumeDownloadCapability(capabilityId, token);
    } catch (error) {
      if (error instanceof SpeakerServiceError) throw error;
      throw capabilityError(error, "The download capability is invalid or has expired.");
    }
  }

  async finalizeUpload(input: {
    eventId: string;
    accountId: string;
    assetId: string;
    state: Extract<SpeakerAsset["state"], "ready" | "rejected">;
    rejectionReason?: string;
  }): Promise<SpeakerAsset> {
    return this.finalizeAsset(input);
  }
  private async assertTaskAssetsReady(task: SpeakerTask): Promise<void> {
    if (task.type !== "upload") return;
    const assets = await this.assetsForParticipants(task.eventId, [task.participantId]);
    const assetsByFamily = new Map<string, SpeakerAsset[]>();
    for (const asset of assets) {
      if (asset.taskId !== task.id) continue;
      const familyId = asset.versionFamilyId ?? asset.id;
      const family = assetsByFamily.get(familyId);
      if (family === undefined) assetsByFamily.set(familyId, [asset]);
      else family.push(asset);
    }
    if (task.replacementBaselineAssetId !== undefined) {
      const baseline = assets.find((asset) => asset.id === task.replacementBaselineAssetId);
      const baselineFamilyId =
        baseline === undefined ? undefined : (baseline.versionFamilyId ?? baseline.id);
      const replacementReady =
        baseline === undefined || baselineFamilyId === undefined
          ? false
          : [...assetsByFamily.values()]
              .filter((family) =>
                family.some((asset) => (asset.versionFamilyId ?? asset.id) === baselineFamilyId),
              )
              .map((family) => ({
                baseline,
                current: assetFamilyPointers(family)?.current,
              }))
              .some(
                ({ baseline: returned, current }) =>
                  current !== undefined &&
                  current.state === "ready" &&
                  current.id !== returned.id &&
                  (current.version ?? 0) > (returned.version ?? 0) &&
                  (task.acceptedAssetKinds === undefined ||
                    task.acceptedAssetKinds.includes(current.kind)),
              );
      if (!replacementReady) {
        throw new SpeakerServiceError(
          "TASK_ASSET_NOT_READY",
          409,
          "Finalize a newer accepted replacement before submitting this task.",
        );
      }
      return;
    }
    const ready = [...assetsByFamily.values()]
      .map((family) => assetFamilyPointers(family)?.current)
      .some(
        (asset) =>
          asset !== undefined &&
          (task.acceptedAssetKinds === undefined || task.acceptedAssetKinds.includes(asset.kind)),
      );
    if (!ready) {
      throw new SpeakerServiceError(
        "TASK_ASSET_NOT_READY",
        409,
        "Upload and finalize at least one accepted asset before submitting this task.",
      );
    }
  }

  private async assetsForParticipants(
    eventId: string,
    participantIds: readonly string[],
  ): Promise<SpeakerAsset[]> {
    if (participantIds.length === 0) return [];
    const assets =
      this.repository.listAssets === undefined
        ? Array.isArray((this.repository as SpeakerRepository & { assets?: unknown }).assets)
          ? ((this.repository as SpeakerRepository & { assets: SpeakerAsset[] }).assets ?? [])
          : [...this.assetCache.values()]
        : await this.repository.listAssets(eventId, participantIds);
    return assets.filter(
      (asset) => asset.eventId === eventId && participantIds.includes(asset.participantId),
    );
  }

  private updateCachedAsset(
    asset: SpeakerAsset,
    command: FinalizeSpeakerAssetCommand,
  ): SpeakerAsset {
    asset.state = command.state;
    asset.finalizedAt = command.finalizedAt;
    asset.latestVersionId = command.latestVersionId;
    if (command.currentVersionId === undefined) delete asset.currentVersionId;
    else asset.currentVersionId = command.currentVersionId;
    if (command.rejectionReason === undefined) delete asset.rejectionReason;
    else asset.rejectionReason = command.rejectionReason;
    this.assetCache.set(`${asset.eventId}:${asset.id}`, asset);
    return asset;
  }
  async listOrganizerSpeakerRoster(
    organizationId: string,
    eventId: string,
    accountId: string,
  ): Promise<SpeakerWorkspaceRoster> {
    const projection = await this.organizerSpeakerMutationProjection(
      organizationId,
      eventId,
      accountId,
    );
    return this.materializeOrganizerSpeakerMutationProjection(organizationId, eventId, projection);
  }

  async getOrganizerSpeaker(
    organizationId: string,
    eventId: string,
    accountId: string,
    participantId: string,
  ): Promise<SpeakerWorkspaceRecord> {
    const roster = await this.listOrganizerSpeakerRoster(organizationId, eventId, accountId);
    const speaker = roster.speakers.find((candidate) => candidate.participantId === participantId);
    if (speaker === undefined) throw notFound();
    return speaker;
  }

  async createOrganizerSpeaker(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    displayName: string;
    email: string;
    jobTitle: string;
    company: string;
    biography: string;
    socialLinks: Readonly<Record<string, string>>;
    status: string;
    travelLogistics?: Partial<SpeakerTravelLogistics>;
    idempotencyKey: string;
    sourceType?: SpeakerParticipantSourceType;
    sourceId?: string;
    explicitParticipantId?: string;
  }): Promise<SpeakerWorkspaceRoster> {
    const projection = await this.organizerSpeakerMutationProjection(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    const roster = await this.createOrganizerSpeakerWithProjection(input, projection);
    if (roster === undefined) throw notFound();
    return roster;
  }

  private async createOrganizerSpeakerWithProjection(
    input: Parameters<SpeakerService["createOrganizerSpeaker"]>[0],
    projection: OrganizerSpeakerMutationProjection,
    materializeResponse = true,
  ): Promise<SpeakerWorkspaceRoster | undefined> {
    const displayName = importText(input.displayName, "The speaker name", 200);
    const email = importEmail(input.email);
    const jobTitle = importText(input.jobTitle, "The speaker job title", 160);
    const company = importText(input.company, "The speaker company", 200);
    const biography = importText(input.biography, "The speaker biography", 20_000);
    const status = importText(input.status, "The speaker status", 80);
    const socialLinks = normalizeSocialLinks(input.socialLinks) ?? {};
    const travelLogistics = normalizeTravelLogistics(input.travelLogistics);
    const idempotencyKey = normalizeUserText(input.idempotencyKey, "The idempotency key", 300);
    const sourceType = input.sourceType ?? "manual";
    const sourceId = input.sourceId?.trim() || idempotencyKey;
    const resolutionKey = `${sourceType}\u0000${sourceId}`;
    const fingerprint = JSON.stringify({
      displayName,
      email,
      jobTitle,
      company,
      biography,
      socialLinks,
      status,
      travelLogistics,
      sourceType,
      sourceId,
      explicitParticipantId: input.explicitParticipantId,
    });
    const matchingEmailEntries = projection.entries.filter(
      (entry) => entry.email?.trim().toLowerCase() === email,
    );
    if (matchingEmailEntries.length > 1) {
      throw new SpeakerServiceError(
        "IDENTITY_AMBIGUOUS",
        409,
        "The event roster contains duplicate verified speaker emails.",
      );
    }
    const resolution =
      projection.participantResolutions.get(resolutionKey) ??
      (await this.resolveEventParticipant({
        organizationId: input.organizationId,
        eventId: input.eventId,
        sourceType,
        sourceId,
        ...(input.explicitParticipantId === undefined
          ? {}
          : { explicitParticipantId: input.explicitParticipantId }),
        normalizedEmail: email,
      }));
    projection.participantResolutions.set(resolutionKey, resolution);
    if (resolution.state === "ambiguous") {
      throw new SpeakerServiceError(
        "IDENTITY_AMBIGUOUS",
        409,
        "Multiple event participants match this source relationship.",
      );
    }
    const participantId = resolution.participantId;
    const existingIdentity = projection.entries.find(
      (entry) => entry.participantId === participantId,
    );
    if (
      matchingEmailEntries.some((entry) => entry.participantId !== participantId) ||
      (existingIdentity?.email !== undefined &&
        existingIdentity.email.trim().toLowerCase() !== email)
    ) {
      throw new SpeakerServiceError(
        "IDENTITY_AMBIGUOUS",
        409,
        "The speaker email is already associated with another participant.",
      );
    }
    const submissionId =
      existingIdentity?.submissionId ??
      (resolution.submissionIds.length === 1
        ? (resolution.submissionIds[0] as string)
        : resolution.submissionIds.length === 0
          ? undefined
          : (() => {
              throw new SpeakerServiceError(
                "IDENTITY_AMBIGUOUS",
                409,
                "Select the participant source relationship explicitly.",
              );
            })());
    const currentProfile = projection.profiles.find(
      (profile) => profile.eventId === input.eventId && profile.participantId === participantId,
    );
    if (
      currentProfile !== undefined &&
      currentProfile.displayName === displayName &&
      currentProfile.email?.trim().toLowerCase() === email &&
      currentProfile.jobTitle === jobTitle &&
      currentProfile.company === company &&
      currentProfile.biography === biography &&
      JSON.stringify(currentProfile.socialLinks ?? currentProfile.social ?? {}) ===
        JSON.stringify(socialLinks) &&
      JSON.stringify(currentProfile.travelLogistics) === JSON.stringify(travelLogistics) &&
      currentProfile.status === status
    ) {
      this.overlayOrganizerSpeakerMutationProjection(projection, undefined, currentProfile);
      if (!materializeResponse) return;
      return this.materializeOrganizerSpeakerMutationProjection(
        input.organizationId,
        input.eventId,
        projection,
      );
    }
    const aggregateResult = await this.organizerLifecycle().upsertOrganizerSpeakerAggregate({
      organizationId: input.organizationId,
      eventId: input.eventId,
      accountId: input.accountId,
      participantId,
      profileId: currentProfile?.id ?? `profile:${input.eventId}:${participantId}`,
      displayName,
      email,
      jobTitle,
      company,
      biography,
      socialLinks,
      travelLogistics,
      status,
      sourceType,
      sourceId,
      expectedVersion: currentProfile?.version ?? null,
      ...(currentProfile === undefined ? { idempotencyKey } : {}),
      sourceDigest: fingerprint,
      updatedAt: this.now().toISOString(),
    });
    if (!aggregateResult.ok) {
      throw new SpeakerServiceError(
        aggregateResult.reason === "not_found" ? "NOT_FOUND" : "VERSION_CONFLICT",
        aggregateResult.reason === "not_found" ? 404 : 409,
        "The speaker aggregate changed. Reload it before saving.",
      );
    }
    const writtenProfile = aggregateResult.value;
    this.overlayOrganizerSpeakerMutationProjection(
      projection,
      {
        id: writtenProfile.id,
        eventId: input.eventId,
        ...(submissionId === undefined ? {} : { submissionId }),
        participantId,
        displayName,
        email,
        jobTitle,
        company,
        biography,
        socialLinks,
        travelLogistics,
        sourceType,
        sourceId,
        role: "primary",
        status: status === "revoked" ? "revoked" : status === "active" ? "active" : "pending",
        workflowStatus: status,
        organizerStatus: status,
        version: writtenProfile.version,
        createdAt: writtenProfile.updatedAt,
        updatedAt: writtenProfile.updatedAt,
        authorAccountId: input.accountId,
      },
      writtenProfile,
    );
    if (!materializeResponse) return;
    return this.materializeOrganizerSpeakerMutationProjection(
      input.organizationId,
      input.eventId,
      projection,
    );
  }

  async updateOrganizerSpeaker(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    participantId: string;
    expectedVersion: number;
    displayName: string;
    email: string;
    jobTitle: string;
    company: string;
    biography: string;
    socialLinks: Readonly<Record<string, string>>;
    travelLogistics?: Partial<SpeakerTravelLogistics>;
    status: string;
  }): Promise<SpeakerWorkspaceRoster> {
    const projection = await this.organizerSpeakerMutationProjection(
      input.organizationId,
      input.eventId,
      input.accountId,
      input.participantId,
    );
    assertExpectedVersion(input.expectedVersion);
    const existing = projection.entries.find(
      (entry) => entry.participantId === input.participantId,
    );
    const currentProfile =
      projection.profiles.find(
        (profile) =>
          profile.eventId === input.eventId && profile.participantId === input.participantId,
      ) ?? (await this.repository.getProfile(input.eventId, input.participantId));
    if (currentProfile === null || currentProfile.version !== input.expectedVersion) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "The speaker has changed. Reload it before saving.",
      );
    }
    const displayName = importText(input.displayName, "The speaker name", 200);
    const email = importEmail(input.email);
    const jobTitle = importText(input.jobTitle, "The speaker job title", 160);
    const company = importText(input.company, "The speaker company", 200);
    const biography = importText(input.biography, "The speaker biography", 20_000);
    const status = importText(input.status, "The speaker status", 80);
    const socialLinks = normalizeSocialLinks(input.socialLinks) ?? {};
    const temporalContext = await this.eventTemporalContext(input.organizationId, input.eventId);
    const currentTravelLogistics = travelLogisticsFrom(
      currentProfile.travelLogistics,
      temporalContext?.timeZone,
    );
    const travelLogistics = normalizeTravelLogistics({
      ...currentTravelLogistics,
      ...(input.travelLogistics ?? {}),
    });
    const duplicate = projection.entries.find(
      (entry) =>
        entry.participantId !== input.participantId && entry.email?.trim().toLowerCase() === email,
    );
    if (duplicate !== undefined) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        "A speaker with that email already exists.",
      );
    }
    const sourceType = currentProfile.sourceType ?? existing?.sourceType ?? "manual";
    const sourceId = currentProfile.sourceId ?? existing?.sourceId ?? input.participantId;
    const aggregateResult = await this.organizerLifecycle().upsertOrganizerSpeakerAggregate({
      organizationId: input.organizationId,
      eventId: input.eventId,
      accountId: input.accountId,
      participantId: input.participantId,
      profileId: currentProfile.id,
      displayName,
      email,
      jobTitle,
      company,
      biography,
      socialLinks,
      travelLogistics,
      status,
      sourceType,
      sourceId,
      expectedVersion: input.expectedVersion,
      sourceDigest: JSON.stringify({
        displayName,
        email,
        jobTitle,
        company,
        biography,
        socialLinks,
        travelLogistics,
        status,
        expectedVersion: input.expectedVersion,
      }),
      updatedAt: this.now().toISOString(),
    });
    if (!aggregateResult.ok) {
      throw new SpeakerServiceError(
        aggregateResult.reason === "not_found" ? "NOT_FOUND" : "VERSION_CONFLICT",
        aggregateResult.reason === "not_found" ? 404 : 409,
        "The speaker has changed. Reload it before saving.",
      );
    }
    const refreshedProjection = await this.organizerSpeakerMutationProjection(
      input.organizationId,
      input.eventId,
      input.accountId,
      input.participantId,
    );
    return this.materializeOrganizerSpeakerMutationProjection(
      input.organizationId,
      input.eventId,
      refreshedProjection,
    );
  }

  async previewSpeakerImport(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    csv: string;
  }): Promise<SpeakerImportPreview> {
    const scope = await this.requireOrganizerOrganizationScope(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    const bytes = new TextEncoder().encode(input.csv).byteLength;
    if (input.csv.includes("\uFFFD")) {
      throw new SpeakerServiceError("VALIDATION_ERROR", 400, "The CSV is not valid UTF-8.");
    }
    if (bytes === 0 || bytes > speakerImportMaximumBytes) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "The CSV file is empty or exceeds the size limit.",
      );
    }
    const rows = parseCsvRows(input.csv);
    if (rows.length < 2) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "The CSV must include a header and at least one row.",
      );
    }
    const headerRow = rows[0];
    if (headerRow === undefined) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "The CSV must include a header and at least one row.",
      );
    }
    const header = headerRow.map((value) => value.trim().toLowerCase());
    const headerAliases = header.map((value) => speakerImportHeaderAliases[value]);
    const canonicalHeader = headerAliases.filter((value): value is string => value !== undefined);
    const requiredHeaders = ["displayName", "email", "jobTitle", "company", "biography"];
    if (
      canonicalHeader.length !== headerAliases.length ||
      new Set(canonicalHeader).size !== canonicalHeader.length ||
      requiredHeaders.some((required) => !canonicalHeader.includes(required))
    ) {
      throw new SpeakerServiceError("VALIDATION_ERROR", 400, "The CSV header is invalid.");
    }
    if (rows.length - 1 > speakerImportMaximumRows) {
      throw new SpeakerServiceError("VALIDATION_ERROR", 400, "The CSV contains too many rows.");
    }
    const entries = await this.organizerRosterEntries(
      input.organizationId,
      input.eventId,
      scope,
      input.accountId,
    );
    const existingEmails = new Set(
      entries
        .map((entry) => entry.email?.trim().toLowerCase())
        .filter((value): value is string => value !== undefined),
    );
    const validRows: SpeakerImportRow[] = [];
    const invalidRows: SpeakerImportIssue[] = [];
    const seenEmails = new Set(existingEmails);
    for (let index = 1; index < rows.length; index += 1) {
      const values = rows[index];
      if (values === undefined) {
        throw new SpeakerServiceError("VALIDATION_ERROR", 400, "The CSV row is missing.");
      }
      const rowNumber = index + 1;
      if (values.length !== canonicalHeader.length) {
        invalidRows.push({
          rowNumber,
          message: "The row has a different number of columns than the header.",
        });
        continue;
      }
      const byField = new Map<string, string>();
      canonicalHeader.forEach((name, column) => {
        byField.set(name, values[column] ?? "");
      });
      try {
        const displayName = importText(byField.get("displayName") ?? "", "The speaker name", 200);
        const email = importEmail(byField.get("email") ?? "");
        const jobTitle = importText(byField.get("jobTitle") ?? "", "The speaker job title", 160);
        const company = importText(byField.get("company") ?? "", "The speaker company", 200);
        const biography = importText(
          byField.get("biography") ?? "",
          "The speaker biography",
          20_000,
        );
        if (seenEmails.has(email)) {
          invalidRows.push({
            rowNumber,
            field: "email",
            message: "This email is already present in the roster or import.",
          });
          continue;
        }
        seenEmails.add(email);
        const socialLinkValues: Record<string, string> = {};
        for (const key of ["twitter", "linkedin", "website"]) {
          const value = byField.get(key)?.trim();
          if (value !== undefined && value.length > 0) socialLinkValues[key] = value;
        }
        const socialLinks = normalizeSocialLinks(socialLinkValues) ?? {};
        const statusValue = byField.get("status")?.trim();
        const status =
          statusValue === undefined || statusValue.length === 0
            ? undefined
            : importText(statusValue, "The speaker status", 80);
        validRows.push({
          rowNumber,
          displayName,
          email,
          jobTitle,
          company,
          biography,
          socialLinks,
          ...(status === undefined ? {} : { status }),
        });
      } catch (error) {
        invalidRows.push({
          rowNumber,
          message: error instanceof SpeakerServiceError ? error.message : "The row is invalid.",
        });
      }
    }
    const previewId = `speaker-import-preview:${this.generateId()}`;
    const sourceDigest = await speakerSourceDigest(input.csv);
    const persisted = await this.organizerLifecycle().saveOrganizerSpeakerImportPreview({
      organizationId: input.organizationId,
      eventId: input.eventId,
      accountId: input.accountId,
      previewId,
      sourceDigest,
      rows: validRows,
      createdAt: this.now().toISOString(),
    });
    return { ...persisted, invalidRows };
  }

  async commitSpeakerImport(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    previewId?: string;
    sourceDigest?: string;
    rows?: readonly SpeakerImportRow[];
    idempotencyKey: string;
  }): Promise<SpeakerWorkspaceRoster> {
    const idempotencyKey = normalizeUserText(
      input.idempotencyKey,
      "The import idempotency key",
      300,
    );
    const previewId = input.previewId?.trim();
    if (previewId === undefined || previewId.length === 0) {
      throw new SpeakerServiceError(
        "VALIDATION_ERROR",
        400,
        "A server-issued speaker import preview is required.",
      );
    }
    try {
      await this.organizerLifecycle().commitOrganizerSpeakerImport({
        organizationId: input.organizationId,
        eventId: input.eventId,
        accountId: input.accountId,
        previewId,
        ...(input.sourceDigest === undefined ? {} : { sourceDigest: input.sourceDigest }),
        idempotencyKey,
        committedAt: this.now().toISOString(),
      });
    } catch (error) {
      throw new SpeakerServiceError(
        "VERSION_CONFLICT",
        409,
        error instanceof Error ? error.message : "The speaker import could not be committed.",
      );
    }
    const persisted = await this.organizerSpeakerMutationProjection(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    return this.materializeOrganizerSpeakerMutationProjection(
      input.organizationId,
      input.eventId,
      persisted,
    );
  }

  async listOrganizerSpeakerTasks(
    organizationId: string,
    eventId: string,
    accountId: string,
    participantId?: string,
  ): Promise<{
    organizationId: string;
    eventId: string;
    speakerProfileId: string;
    tasks: SpeakerWorkspaceTask[];
  }> {
    const scope = await this.requireOrganizerOrganizationScope(organizationId, eventId, accountId);
    const roster = await this.organizerRosterEntries(organizationId, eventId, scope, accountId);
    const manualByParticipant = new Map(
      roster.filter(isOrganizerManagedRosterEntry).map((entry) => [entry.participantId, entry]),
    );
    if (
      participantId !== undefined &&
      !scope.participantIds.includes(participantId) &&
      !manualByParticipant.has(participantId)
    ) {
      throw notFound();
    }
    const requested =
      participantId === undefined
        ? unique([...scope.participantIds, ...manualByParticipant.keys()])
        : [participantId];
    const [tasks, rawAssets] = await Promise.all([
      this.repository.listTasks(eventId, requested),
      this.assetsForParticipants(eventId, requested),
    ]);
    const visibleTasks = (
      await Promise.all(
        tasks.map(async (task) => {
          const subject = speakerTaskSubject(task);
          if (
            subject === undefined ||
            task.eventId !== eventId ||
            task.owner !== "speaker" ||
            !requested.includes(task.participantId)
          ) {
            return undefined;
          }
          if (subject.type === "participant") return task;
          try {
            await this.acceptedSession(
              scope.tenantId,
              eventId,
              task.participantId,
              subject.sessionId,
            );
            return task;
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((task): task is SpeakerTask => task !== undefined);
    const assets = (
      await Promise.all(
        rawAssets.map(async (asset) => {
          if (
            asset.eventId !== eventId ||
            !requested.includes(asset.participantId) ||
            (asset.tenantId !== undefined && asset.tenantId !== scope.tenantId)
          ) {
            return undefined;
          }
          if (asset.sessionId === undefined) {
            return scope.participantIds.includes(asset.participantId) ||
              manualByParticipant.has(asset.participantId)
              ? asset
              : undefined;
          }
          try {
            await this.acceptedSession(
              scope.tenantId,
              eventId,
              asset.participantId,
              asset.sessionId,
            );
            return asset;
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((asset): asset is SpeakerAsset => asset !== undefined);
    return {
      organizationId,
      eventId,
      speakerProfileId: participantId ?? "",
      tasks: visibleTasks
        .filter((task) => participantId === undefined || task.participantId === participantId)
        .map((task) => {
          const latestAsset = singleCurrentAsset(
            assets.filter(
              (asset) => asset.taskId === task.id && asset.participantId === task.participantId,
            ),
          );
          return {
            ...this.workspaceTask(task),
            latestAssetId: latestAsset?.id ?? null,
          };
        }),
    };
  }

  async assignOrganizerSpeakerTask(input: SpeakerTaskAssignmentInput): Promise<{
    organizationId: string;
    eventId: string;
    speakerProfileId: string;
    tasks: SpeakerWorkspaceTask[];
  }> {
    const scope = await this.requireOrganizerOrganizationScope(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    const roster = await this.organizerRosterEntries(
      input.organizationId,
      input.eventId,
      scope,
      input.accountId,
    );
    const manualParticipantIds = new Set(
      roster.filter(isOrganizerManagedRosterEntry).map((entry) => entry.participantId),
    );
    const participantIds = unique(input.assignments.map((assignment) => assignment.participantId));
    if (
      participantIds.length === 0 ||
      participantIds.some(
        (participantId) =>
          !scope.participantIds.includes(participantId) && !manualParticipantIds.has(participantId),
      )
    ) {
      throw notFound();
    }
    const title = importText(input.title, "The task title", 200);
    const description = importText(input.description, "The task description", 10_000);
    const dueAt = normalizeDueAt(input.dueAt);
    if (dueAt === undefined)
      throw new SpeakerServiceError("VALIDATION_ERROR", 400, "A task due date is required.");
    const tasks = await this.createOrganizerTask({
      eventId: input.eventId,
      accountId: input.accountId,
      type: "action",
      title,
      description,
      dueAt,
      assignments: input.assignments,
    });
    return {
      organizationId: input.organizationId,
      eventId: input.eventId,
      speakerProfileId: participantIds.length === 1 ? (participantIds[0] ?? "") : "",
      tasks: tasks.map((task) => this.workspaceTask(task)),
    };
  }
  async updateOrganizerSpeakerTask(
    input: SpeakerTaskUpdateInput & { organizationId: string },
  ): Promise<{
    organizationId: string;
    eventId: string;
    speakerProfileId: string;
    tasks: SpeakerWorkspaceTask[];
  }> {
    await this.requireOrganizerOrganizationScope(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    const task = await this.updateOrganizerTask(input);
    return {
      organizationId: input.organizationId,
      eventId: input.eventId,
      speakerProfileId: task.participantId,
      tasks: [this.workspaceTask(task)],
    };
  }

  async listOrganizerSpeakerSessions(
    organizationId: string,
    eventId: string,
    accountId: string,
    participantId: string,
  ): Promise<SpeakerWorkspaceSession[]> {
    const scope = await this.requireOrganizerOrganizationScope(organizationId, eventId, accountId);
    const roster = await this.organizerRosterEntries(organizationId, eventId, scope, accountId);
    const manual = roster.some(
      (entry) => entry.participantId === participantId && isOrganizerManagedRosterEntry(entry),
    );
    if (!scope.participantIds.includes(participantId) && !manual) throw notFound();
    const submissions = await this.repository.listSubmissions(eventId, scope.submissionIds);
    return submissions
      .filter(
        (submission) =>
          submission.eventId === eventId &&
          submission.status === "accepted" &&
          submission.participantIds.includes(participantId),
      )
      .map((submission) => ({
        submissionId: canonicalSpeakerSubmissionId(submission.id),
        title: submission.title,
        status: submission.status,
      }));
  }

  async listOrganizerSpeakerAssets(
    organizationId: string,
    eventId: string,
    accountId: string,
    participantId: string,
  ): Promise<SpeakerWorkspaceAsset[]> {
    const scope = await this.requireOrganizerOrganizationScope(organizationId, eventId, accountId);
    const entries = await this.organizerRosterEntries(organizationId, eventId, scope, accountId);
    const rosterEntry = entries.find(
      (entry) => entry.participantId === participantId && isOrganizerManagedRosterEntry(entry),
    );
    if (!scope.participantIds.includes(participantId) && rosterEntry === undefined) {
      throw notFound();
    }
    const assets = (
      await Promise.all(
        (
          await this.assetsForParticipants(eventId, [participantId])
        ).map(async (asset) => {
          if (asset.tenantId !== undefined && asset.tenantId !== scope.tenantId) {
            return undefined;
          }
          if (asset.sessionId === undefined) {
            return scope.participantIds.includes(asset.participantId) || rosterEntry !== undefined
              ? asset
              : undefined;
          }
          try {
            await this.acceptedSession(
              scope.tenantId,
              eventId,
              asset.participantId,
              asset.sessionId,
            );
            return asset;
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((asset): asset is SpeakerAsset => asset !== undefined);
    return assets.map((asset) => this.workspaceAsset(asset, null));
  }

  async previewOrganizerSpeakerInvitations(
    organizationId: string,
    eventId: string,
    accountId: string,
    participantIds: readonly string[],
  ): Promise<readonly SpeakerInvitationPreview[]> {
    await this.requireOrganizerOrganizationScope(organizationId, eventId, accountId);
    try {
      return await this.requireCommunications().previewInvitations({
        organizationId,
        eventId,
        accountId,
        participantIds: unique(participantIds),
      });
    } catch (error) {
      return this.communicationFailure(error, "EMAIL_PARTICIPANT_NOT_FOUND");
    }
  }

  async sendOrganizerSpeakerInvitations(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    participantIds: readonly string[];
    templateId: string;
    idempotencyKey: string;
  }): Promise<SpeakerInvitationResult> {
    await this.requireOrganizerOrganizationScope(
      input.organizationId,
      input.eventId,
      input.accountId,
    );
    try {
      const communications = this.requireCommunications();
      const participantIds = unique(input.participantIds);
      const idempotencyKey = importText(
        input.idempotencyKey,
        "The invitation idempotency key",
        300,
      );
      const replay = await communications.findInvitationReplay({
        organizationId: input.organizationId,
        eventId: input.eventId,
        accountId: input.accountId,
        participantIds,
        idempotencyKey,
      });
      if (replay !== null) return replay;

      const recipients = await communications.previewInvitations({
        organizationId: input.organizationId,
        eventId: input.eventId,
        accountId: input.accountId,
        participantIds,
      });
      await this.createPendingSpeakerInvitations({
        organizationId: input.organizationId,
        eventId: input.eventId,
        accountId: input.accountId,
        idempotencyKey,
        recipients,
      });
      return await communications.sendInvitations({
        organizationId: input.organizationId,
        eventId: input.eventId,
        accountId: input.accountId,
        participantIds,
        idempotencyKey,
      });
    } catch (error) {
      return this.communicationFailure(error, "VERSION_CONFLICT");
    }
  }

  private async createPendingSpeakerInvitations(input: {
    organizationId: string;
    eventId: string;
    accountId: string;
    idempotencyKey: string;
    recipients: readonly SpeakerInvitationPreview[];
  }): Promise<void> {
    const creator = this.invitationCreator;
    const resolveRecipient = this.repository.resolveVerifiedInvitationRecipient;
    if (creator === undefined || resolveRecipient === undefined) return;
    const invitedAt = this.now().toISOString();
    for (const recipient of input.recipients) {
      const account = await resolveRecipient.call(this.repository, recipient.recipientEmail);
      if (account === null) continue;
      await creator.create({
        id: `event-role-invitation:${this.generateId()}`,
        organizationId: input.organizationId,
        eventId: input.eventId,
        role: "speaker",
        recipientUserId: account.userId,
        normalizedEmail: account.normalizedEmail,
        participantId: recipient.participantId,
        creationIdempotencyKey: `${input.idempotencyKey}:${recipient.participantId}`,
        invitedByActorType: "user",
        invitedByActorId: input.accountId,
        invitedAt,
      });
    }
  }

  private communicationFailure(error: unknown, fallbackCode: SpeakerServiceErrorCode): never {
    if (error instanceof CommunicationError) {
      if (error.status === 503) {
        throw new SpeakerServiceError(
          "REMINDER_UNAVAILABLE",
          503,
          "Durable speaker communications are unavailable.",
        );
      }
      const status: 400 | 404 | 409 =
        error.status === 403 ? 404 : error.status === 404 ? 409 : error.status;
      const message =
        fallbackCode === "EMAIL_TEMPLATE_NOT_FOUND"
          ? "The approved speaker email template or requested version was not found."
          : fallbackCode === "EMAIL_PARTICIPANT_NOT_FOUND"
            ? "The selected speaker participant was not found in this event roster."
            : error.message;
      throw new SpeakerServiceError(fallbackCode, status, message);
    }
    throw error;
  }

  private requireCommunications(): SpeakerCommunications {
    if (this.communications === undefined) {
      throw new SpeakerServiceError(
        "REMINDER_UNAVAILABLE",
        409,
        "Durable speaker communications are not configured.",
      );
    }
    return this.communications;
  }

  private organizerLifecycle(): SpeakerOrganizerLifecycleRepository {
    const repository = this.repository;
    if (
      repository.getOrganizerAccessScope === undefined ||
      repository.getOrganizerReadModel === undefined ||
      repository.resolveEventParticipant === undefined ||
      repository.saveOrganizerSpeakerImportPreview === undefined ||
      repository.commitOrganizerSpeakerImport === undefined ||
      repository.upsertOrganizerSpeakerAggregate === undefined
    ) {
      throw new SpeakerServiceError(
        "NOT_FOUND",
        404,
        "The canonical organizer speaker lifecycle is unavailable.",
      );
    }
    return repository as SpeakerRepository & SpeakerOrganizerLifecycleRepository;
  }

  private async organizerSpeakerMutationProjection(
    organizationId: string,
    eventId: string,
    accountId: string,
    includeProfileParticipantId?: string,
  ): Promise<OrganizerSpeakerMutationProjection> {
    const readModel = await this.organizerLifecycle().getOrganizerReadModel(eventId, accountId, {
      profiles: true,
      tasks: true,
      assets: true,
    });
    const isReadModelCollection = (value: unknown): value is readonly object[] =>
      Array.isArray(value) &&
      value.every((candidate) => candidate !== null && typeof candidate === "object");
    if (
      readModel === null ||
      typeof readModel !== "object" ||
      !isReadModelCollection(readModel.submissions) ||
      !isReadModelCollection(readModel.roster) ||
      !isReadModelCollection(readModel.profiles) ||
      !isReadModelCollection(readModel.tasks) ||
      !isReadModelCollection(readModel.assets)
    ) {
      throw notFound();
    }
    const scope = this.readModelScope(readModel, eventId);
    if (scope.tenantId !== organizationId) throw notFound();
    const submissions = readModel.submissions.filter((candidate) =>
      organizerRecordTenantMatches(candidate, scope.tenantId),
    );
    const roster = readModel.roster.filter((candidate) =>
      organizerRecordTenantMatches(candidate, scope.tenantId),
    );
    const profileParticipantIds = new Set([
      ...scope.participantIds,
      ...(includeProfileParticipantId === undefined ? [] : [includeProfileParticipantId]),
    ]);
    const profiles = readModel.profiles.filter(
      (candidate) =>
        organizerRecordTenantMatches(candidate, scope.tenantId) &&
        candidate.eventId === eventId &&
        profileParticipantIds.has(candidate.participantId),
    );
    const scopeParticipantIds = new Set(scope.participantIds);
    const acceptedSubmissions = this.acceptedOrganizerSubmissionsFrom(eventId, scope, submissions);
    const rosterProjection = {
      entries: this.organizerRosterEntriesFromReadModel(eventId, scope, roster, profiles),
      profiles: [...profiles],
    };

    const acceptedParticipantIds = new Set(
      acceptedSubmissions.flatMap((submission) =>
        submission.participantIds.filter((participantId) => scopeParticipantIds.has(participantId)),
      ),
    );
    const entries = rosterProjection.entries.filter(
      (entry) =>
        acceptedParticipantIds.has(entry.participantId) || isOrganizerManagedRosterEntry(entry),
    );
    const organizerParticipantIds = entries
      .filter(isOrganizerManagedRosterEntry)
      .map((entry) => entry.participantId);
    const participantIds = unique([...acceptedParticipantIds, ...organizerParticipantIds]);
    const participantIdSet = new Set(participantIds);
    const manualByParticipant = new Map(
      entries.filter(isOrganizerManagedRosterEntry).map((entry) => [entry.participantId, entry]),
    );

    const taskCandidates = readModel.tasks.filter((candidate) =>
      organizerRecordTenantMatches(candidate, scope.tenantId),
    );
    const assetCandidates = readModel.assets.filter((candidate) =>
      organizerRecordTenantMatches(candidate, scope.tenantId),
    );
    const tasks = (
      await Promise.all(
        taskCandidates.map(async (task) => {
          const subject = speakerTaskSubject(task);
          if (
            subject === undefined ||
            task.eventId !== eventId ||
            !participantIdSet.has(task.participantId) ||
            task.owner !== "speaker"
          ) {
            return undefined;
          }
          if (subject.type === "participant") return task;
          try {
            await this.acceptedSession(
              scope.tenantId,
              eventId,
              task.participantId,
              subject.sessionId,
            );
            return task;
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((task): task is SpeakerTask => task !== undefined);
    const assets = (
      await Promise.all(
        assetCandidates.map(async (asset) => {
          if (
            asset.eventId !== eventId ||
            !participantIdSet.has(asset.participantId) ||
            (asset.tenantId !== undefined && asset.tenantId !== scope.tenantId)
          ) {
            return undefined;
          }
          if (asset.sessionId === undefined) {
            return scopeParticipantIds.has(asset.participantId) ||
              manualByParticipant.has(asset.participantId)
              ? asset
              : undefined;
          }
          try {
            await this.acceptedSession(
              scope.tenantId,
              eventId,
              asset.participantId,
              asset.sessionId,
            );
            return asset;
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((asset): asset is SpeakerAsset => asset !== undefined);
    return {
      scope,
      acceptedSubmissions,
      entries,
      profiles: rosterProjection.profiles,
      tasks,
      assets,
      participantResolutions: new Map(),
    };
  }

  private async materializeOrganizerSpeakerMutationProjection(
    organizationId: string,
    eventId: string,
    projection: OrganizerSpeakerMutationProjection,
  ): Promise<SpeakerWorkspaceRoster> {
    const temporalContext = await this.eventTemporalContext(organizationId, eventId);
    const entryParticipantIds = new Set(projection.entries.map((entry) => entry.participantId));
    const profileByParticipant = new Map<string, SpeakerProfile>();
    for (const profile of projection.profiles) {
      if (profile.eventId === eventId && entryParticipantIds.has(profile.participantId)) {
        profileByParticipant.set(profile.participantId, profile);
      }
    }
    const submissionsByParticipant = new Map<string, SpeakerSubmission[]>();
    for (const submission of projection.acceptedSubmissions) {
      for (const participantId of new Set(submission.participantIds)) {
        const participantSubmissions = submissionsByParticipant.get(participantId);
        if (participantSubmissions === undefined) {
          submissionsByParticipant.set(participantId, [submission]);
        } else {
          participantSubmissions.push(submission);
        }
      }
    }
    const tasksByParticipant = new Map<string, SpeakerTask[]>();
    for (const task of projection.tasks) {
      if (task.eventId !== eventId || task.type !== "action") continue;
      const participantTasks = tasksByParticipant.get(task.participantId);
      if (participantTasks === undefined) {
        tasksByParticipant.set(task.participantId, [task]);
      } else {
        participantTasks.push(task);
      }
    }
    const assetsByParticipant = new Map<string, SpeakerAsset[]>();
    for (const asset of projection.assets) {
      const participantAssets = assetsByParticipant.get(asset.participantId);
      if (participantAssets === undefined) {
        assetsByParticipant.set(asset.participantId, [asset]);
      } else {
        participantAssets.push(asset);
      }
    }
    const records = projection.entries.map((entry) =>
      this.organizerSpeakerRecord(
        eventId,
        entry.participantId,
        entry,
        profileByParticipant.get(entry.participantId),
        submissionsByParticipant.get(entry.participantId) ?? [],
        tasksByParticipant.get(entry.participantId) ?? [],
        assetsByParticipant.get(entry.participantId) ?? [],
        temporalContext?.timeZone,
      ),
    );
    const recordsByIdentity = new Map<string, SpeakerWorkspaceRecord>();
    for (const record of records) {
      const current = recordsByIdentity.get(record.participantId);
      if (
        current === undefined ||
        record.version > current.version ||
        (record.version === current.version &&
          record.updatedAt.localeCompare(current.updatedAt) > 0)
      ) {
        recordsByIdentity.set(record.participantId, record);
      }
    }
    return {
      organizationId,
      eventId,
      ...(temporalContext === undefined ? {} : { temporalContext }),
      speakers: [...recordsByIdentity.values()].sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) ||
          left.participantId.localeCompare(right.participantId),
      ),
    };
  }

  private overlayOrganizerSpeakerMutationProjection(
    projection: OrganizerSpeakerMutationProjection,
    entry: SpeakerRosterEntry | undefined,
    profile: SpeakerProfile | undefined,
  ): void {
    if (entry !== undefined) {
      const index = projection.entries.findIndex(
        (candidate) => candidate.participantId === entry.participantId,
      );
      if (index < 0) projection.entries.push(entry);
      else projection.entries[index] = entry;
    }
    if (profile === undefined) return;
    const profileIndex = projection.profiles.findIndex(
      (candidate) =>
        candidate.eventId === profile.eventId && candidate.participantId === profile.participantId,
    );
    if (profileIndex < 0) projection.profiles.push(profile);
    else projection.profiles[profileIndex] = profile;
    const entryIndex = projection.entries.findIndex(
      (candidate) => candidate.participantId === profile.participantId,
    );
    const currentEntry = projection.entries[entryIndex];
    if (entryIndex < 0 || currentEntry === undefined) return;
    const profileSocialLinks = profile.socialLinks ?? profile.social;
    const updatedEntry: SpeakerRosterEntry = {
      ...currentEntry,
      displayName: profile.displayName,
      ...(profile.email === undefined ? {} : { email: profile.email }),
      ...(profile.jobTitle === undefined ? {} : { jobTitle: profile.jobTitle }),
      ...(profile.company === undefined ? {} : { company: profile.company }),
      ...(profile.biography === undefined ? {} : { biography: profile.biography }),
      ...(profileSocialLinks === undefined ? {} : { socialLinks: profileSocialLinks }),
      ...(profile.headshotAssetId === undefined
        ? {}
        : { headshotAssetId: profile.headshotAssetId }),
      ...(profile.travelLogistics === undefined
        ? {}
        : { travelLogistics: profile.travelLogistics }),
      ...(profile.status === undefined
        ? {}
        : {
            workflowStatus: profile.status,
            organizerStatus: profile.status,
            status:
              profile.status === "revoked"
                ? "revoked"
                : profile.status === "active"
                  ? "active"
                  : currentEntry.status,
          }),
      version: Math.max(currentEntry.version, profile.version),
      updatedAt:
        profile.updatedAt.localeCompare(currentEntry.updatedAt) > 0
          ? profile.updatedAt
          : currentEntry.updatedAt,
    };
    projection.entries[entryIndex] = updatedEntry;
  }

  private async assertOrganizerAssetAccess(
    scope: SpeakerAccessScope & { tenantId: string },
    eventId: string,
    accountId: string,
    asset: SpeakerAsset,
  ): Promise<void> {
    if (
      asset.eventId !== eventId ||
      (asset.tenantId !== undefined && asset.tenantId !== scope.tenantId)
    ) {
      throw notFound();
    }
    if (asset.sessionId !== undefined) {
      try {
        await this.acceptedSession(scope.tenantId, eventId, asset.participantId, asset.sessionId);
        return;
      } catch {
        throw notFound();
      }
    }
    if (scope.participantIds.includes(asset.participantId)) return;
    const roster = await this.organizerRosterEntries(scope.tenantId, eventId, scope, accountId);
    const manual = roster.find(
      (entry) =>
        entry.participantId === asset.participantId && isOrganizerManagedRosterEntry(entry),
    );
    if (manual === undefined) throw notFound();
  }
  private organizerRosterEntriesFromReadModel(
    eventId: string,
    scope: SpeakerAccessScope & { tenantId: string },
    roster: readonly SpeakerRosterEntry[],
    profiles: readonly SpeakerProfile[],
  ): SpeakerRosterEntry[] {
    const allowedSubmissions = new Set(scope.submissionIds.map(canonicalSpeakerSubmissionId));
    const scopeParticipantIds = new Set(scope.participantIds);
    const isAllowedSubmission = (submissionId: string | undefined): boolean =>
      submissionId !== undefined &&
      allowedSubmissions.has(canonicalSpeakerSubmissionId(submissionId));
    const entries = roster.filter(
      (entry) =>
        entry.eventId === eventId &&
        (isAllowedSubmission(entry.submissionId) || isOrganizerManagedRosterEntry(entry)) &&
        (scopeParticipantIds.has(entry.participantId) || isOrganizerManagedRosterEntry(entry)),
    );
    const entryParticipantIds = new Set(entries.map((entry) => entry.participantId));
    for (const profile of profiles) {
      if (
        profile.eventId !== eventId ||
        !scopeParticipantIds.has(profile.participantId) ||
        entryParticipantIds.has(profile.participantId)
      ) {
        continue;
      }
      const submissionId = scope.submissionIds[0];
      entries.push({
        id: profile.id,
        eventId,
        ...(submissionId === undefined
          ? {}
          : { submissionId: canonicalSpeakerSubmissionId(submissionId) }),
        participantId: profile.participantId,
        displayName: profile.displayName,
        ...(profile.email === undefined ? {} : { email: profile.email }),
        ...(profile.jobTitle === undefined ? {} : { jobTitle: profile.jobTitle }),
        ...(profile.company === undefined ? {} : { company: profile.company }),
        ...(profile.biography === undefined ? {} : { biography: profile.biography }),
        ...(profile.socialLinks === undefined
          ? profile.social === undefined
            ? {}
            : { socialLinks: profile.social }
          : { socialLinks: profile.socialLinks }),
        ...(profile.headshotAssetId === undefined
          ? {}
          : { headshotAssetId: profile.headshotAssetId }),
        ...(profile.travelLogistics === undefined
          ? {}
          : { travelLogistics: profile.travelLogistics }),
        role: "primary",
        status: profile.status === "revoked" ? "revoked" : "active",
        ...(profile.status === undefined ? {} : { workflowStatus: profile.status }),
        version: profile.version,
        createdAt: profile.updatedAt,
        updatedAt: profile.updatedAt,
      });
      entryParticipantIds.add(profile.participantId);
    }
    const byParticipant = new Map<string, SpeakerRosterEntry>();
    for (const entry of entries) {
      const current = byParticipant.get(entry.participantId);
      if (
        current === undefined ||
        entry.updatedAt.localeCompare(current.updatedAt) > 0 ||
        (entry.updatedAt === current.updatedAt && entry.id < current.id)
      ) {
        byParticipant.set(entry.participantId, entry);
      }
    }
    return [...byParticipant.values()];
  }
  private async organizerRosterEntries(
    organizationId: string,
    eventId: string,
    scope: SpeakerAccessScope,
    accountId: string,
  ): Promise<SpeakerRosterEntry[]> {
    const readModel = await this.organizerLifecycle().getOrganizerReadModel(eventId, accountId, {
      profiles: true,
    });
    if (readModel === null || readModel.scope.tenantId !== organizationId) throw notFound();
    const canonicalScope = this.readModelScope(readModel, eventId);
    if (scope.tenantId !== canonicalScope.tenantId) throw notFound();
    return this.organizerRosterEntriesFromReadModel(
      eventId,
      canonicalScope,
      readModel.roster,
      readModel.profiles,
    );
  }

  private organizerSpeakerRecord(
    eventId: string,
    participantId: string,
    entry: SpeakerRosterEntry,
    profile: SpeakerProfile | undefined,
    submissions: readonly SpeakerSubmission[],
    tasks: readonly SpeakerTask[],
    assets: readonly SpeakerAsset[],
    eventTimeZone?: string,
  ): SpeakerWorkspaceRecord {
    const participantAssets = assets.filter((asset) => asset.participantId === participantId);
    const canonicalAssets = participantAssets.map((asset) => this.workspaceAsset(asset, null));
    const participantTasks = tasks.filter(
      (task) =>
        task.eventId === eventId && task.participantId === participantId && task.type === "action",
    );
    const completed = participantTasks.filter((task) =>
      ["completed", "submitted", "waived"].includes(task.status),
    ).length;
    const overdue = participantTasks.filter((task) => {
      if (task.status === "overdue") return true;
      return (
        taskIsOverdue(task, this.now(), eventTimeZone) &&
        !["completed", "submitted", "waived"].includes(task.status)
      );
    }).length;
    return {
      eventId,
      participantId,
      displayName: profile?.displayName ?? entry.displayName ?? participantId,
      email: profile?.email ?? entry.email ?? "",
      jobTitle: profile?.jobTitle ?? entry.jobTitle ?? "",
      company: profile?.company ?? entry.company ?? "",
      biography: profile?.biography ?? entry.biography ?? "",
      socialLinks: profile?.socialLinks ?? profile?.social ?? entry.socialLinks ?? {},
      travelLogistics: travelLogisticsFrom(
        profile?.travelLogistics ?? entry.travelLogistics,
        eventTimeZone,
      ),
      headshotAssetId: profile?.headshotAssetId ?? entry.headshotAssetId ?? null,
      status: profile?.status ?? entry.organizerStatus ?? entry.workflowStatus ?? entry.status,
      sessions: submissions
        .filter((submission) => submission.participantIds.includes(participantId))
        .map((submission) => ({
          submissionId: canonicalSpeakerSubmissionId(submission.id),
          title: submission.title,
          status: submission.status,
        })),
      taskSummary: {
        total: participantTasks.length,
        completed,
        overdue,
      },
      assets: canonicalAssets,
      version: entry.version,
      updatedAt: [entry.updatedAt, profile?.updatedAt ?? ""].sort().at(-1) ?? entry.updatedAt,
    };
  }

  private workspaceAsset(asset: SpeakerAsset, downloadUrl: string | null): SpeakerWorkspaceAsset {
    const versionFamilyId = asset.versionFamilyId ?? asset.id;
    return {
      assetId: asset.id,
      eventId: asset.eventId,
      participantId: asset.participantId,
      sessionId: asset.sessionId ?? null,
      taskId: asset.taskId ?? null,
      kind: asset.kind,
      fileName: asset.fileName,
      contentType: asset.contentType,
      byteSize: asset.sizeBytes,
      status: asset.state === "pending_upload" ? "pending" : asset.state,
      uploadedAt: asset.createdAt,
      finalizedAt: asset.finalizedAt ?? null,
      version: asset.version ?? 1,
      versionFamilyId,
      supersedesAssetId: asset.supersedesAssetId ?? null,
      commentThreadId: asset.commentThreadId ?? versionFamilyId,
      reviewState: asset.reviewState ?? null,
      reviewNote: asset.reviewNote ?? null,
      latestVersionId: asset.latestVersionId ?? null,
      currentVersionId: asset.currentVersionId ?? null,
      approvedVersionId: asset.approvedVersionId ?? null,
      releasedVersionId: asset.releasedVersionId ?? null,
      downloadUrl,
    };
  }

  private workspaceTask(task: SpeakerTask): SpeakerWorkspaceTask {
    return {
      taskId: task.id,
      definitionId: task.definitionId ?? task.id.replace(/:assignment:\d+$/u, ""),
      participantId: task.participantId,
      title: task.title,
      description: task.description ?? task.instructions ?? "",
      type: task.type === "upload" ? "file_request" : task.type === "action" ? "general" : "action",
      dueAt: task.dueAt ?? task.dueDate ?? null,
      status: task.status,
      version: task.version,
      completedAt: ["completed", "submitted", "waived"].includes(task.status)
        ? task.updatedAt
        : null,
      sessionId: task.subject.type === "session" ? task.subject.sessionId : null,
      latestAssetId: null,
    };
  }

  private async requireOrganizerOrganizationScope(
    organizationId: string,
    eventId: string,
    accountId: string,
  ): Promise<SpeakerAccessScope & { tenantId: string; organizer: true }> {
    const scope = await this.requireOrganizerScope(eventId, accountId);
    if (scope.tenantId !== organizationId) throw notFound();
    return scope;
  }
  private async organizerScopeOrNull(
    eventId: string,
    accountId: string,
  ): Promise<SpeakerAccessScope | null> {
    if (eventId.trim().length === 0 || accountId.trim().length === 0) return null;
    const getOrganizerAccessScope = this.repository.getOrganizerAccessScope;
    if (getOrganizerAccessScope === undefined) return null;
    const organizer = await getOrganizerAccessScope.call(this.repository, eventId, accountId);
    if (
      organizer === null ||
      organizer.eventId !== eventId ||
      (organizer.role !== "owner" && organizer.role !== "admin") ||
      typeof organizer.tenantId !== "string" ||
      organizer.tenantId.trim().length === 0 ||
      !Array.isArray(organizer.submissionIds) ||
      !Array.isArray(organizer.participantIds)
    ) {
      return null;
    }
    return {
      tenantId: organizer.tenantId,
      submissionIds: unique(organizer.submissionIds),
      participantIds: unique(organizer.participantIds),
      role: organizer.role,
      organizer: true,
    };
  }

  private readModelScope(
    model: SpeakerOrganizerReadModel,
    eventId: string,
  ): SpeakerAccessScope & { tenantId: string; organizer: true } {
    if (model === null || typeof model !== "object") throw notFound();
    const scope = model.scope;
    if (
      scope === null ||
      typeof scope !== "object" ||
      typeof scope.eventId !== "string" ||
      scope.eventId !== eventId ||
      (scope.role !== "owner" && scope.role !== "admin") ||
      typeof scope.tenantId !== "string" ||
      scope.tenantId.trim().length === 0 ||
      !Array.isArray(scope.submissionIds) ||
      !scope.submissionIds.every((submissionId) => typeof submissionId === "string") ||
      !Array.isArray(scope.participantIds) ||
      !scope.participantIds.every((participantId) => typeof participantId === "string")
    ) {
      throw notFound();
    }
    return {
      tenantId: scope.tenantId,
      submissionIds: unique(scope.submissionIds),
      participantIds: unique(scope.participantIds),
      role: scope.role,
      organizer: true,
    };
  }
  private async requireOrganizerScope(
    eventId: string,
    accountId: string,
  ): Promise<SpeakerAccessScope & { tenantId: string; organizer: true }> {
    const scope = await this.organizerScopeOrNull(eventId, accountId);
    if (scope === null || scope.tenantId === undefined) {
      throw notFound();
    }
    return { ...scope, tenantId: scope.tenantId, organizer: true };
  }

  private async contentForOrganizerScope(
    scope: SpeakerAccessScope & { tenantId: string },
    eventId: string,
    entityType: "session" | "speaker",
    entityId: string,
  ): Promise<SpeakerContentRecord> {
    const content = await this.readContent(eventId, entityType, entityId);
    if (
      content === null ||
      content.eventId !== eventId ||
      content.entityType !== entityType ||
      content.entityId !== entityId ||
      content.tenantId !== scope.tenantId
    ) {
      throw notFound();
    }
    return structuredClone(content);
  }
  private async readContent(
    eventId: string,
    entityType: "session" | "speaker",
    entityId: string,
  ): Promise<SpeakerContentRecord | null> {
    if (this.repository.getContent !== undefined) {
      return this.repository.getContent(eventId, entityType, entityId);
    }
    if (entityType === "session" && this.repository.getSessionContent !== undefined) {
      return this.repository.getSessionContent(eventId, entityId);
    }
    if (entityType === "speaker" && this.repository.getSpeakerContent !== undefined) {
      return this.repository.getSpeakerContent(eventId, entityId);
    }
    throw new SpeakerServiceError("CONTENT_UNAVAILABLE", 404, "Content history is not configured.");
  }

  private async readContentHistory(
    eventId: string,
    entityType: "session" | "speaker",
    entityId: string,
  ): Promise<SpeakerContentHistoryEntry[]> {
    if (this.repository.listContentHistory !== undefined) {
      return this.repository.listContentHistory(eventId, entityType, entityId);
    }
    if (entityType === "session" && this.repository.listSessionContentHistory !== undefined) {
      return this.repository.listSessionContentHistory(eventId, entityId);
    }
    if (entityType === "speaker" && this.repository.listSpeakerContentHistory !== undefined) {
      return this.repository.listSpeakerContentHistory(eventId, entityId);
    }
    throw new SpeakerServiceError("CONTENT_UNAVAILABLE", 404, "Content history is not configured.");
  }

  private async callUpdateContent(
    command: UpdateSpeakerContentCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>> {
    if (this.repository.updateContent !== undefined) {
      return this.repository.updateContent(command);
    }
    if (command.entityType === "session" && this.repository.updateSessionContent !== undefined) {
      return this.repository.updateSessionContent(command);
    }
    if (command.entityType === "speaker" && this.repository.updateSpeakerContent !== undefined) {
      return this.repository.updateSpeakerContent(command);
    }
    throw new SpeakerServiceError("CONTENT_UNAVAILABLE", 404, "Content editing is not configured.");
  }
  private async speakerProfileForScope(
    eventId: string,
    participantId: string,
    scope: SpeakerAccessScope,
  ): Promise<SpeakerProfile> {
    this.assertParticipantAccess(scope, participantId);
    const profile = await this.repository.getProfile(eventId, participantId);
    if (
      profile === null ||
      profile.eventId !== eventId ||
      profile.participantId !== participantId
    ) {
      throw notFound();
    }
    return profile;
  }
  private async getScope(eventId: string, accountId: string): Promise<SpeakerAccessScope> {
    if (!eventId || !accountId) {
      throw notFound();
    }
    const scope = await this.repository.getAccessScope(eventId, accountId);
    const capabilities =
      scope.capabilities === undefined
        ? undefined
        : Array.isArray(scope.capabilities)
          ? [...scope.capabilities]
          : [];
    const capabilitiesByParticipant =
      scope.capabilitiesByParticipant === undefined
        ? undefined
        : typeof scope.capabilitiesByParticipant === "object" &&
            scope.capabilitiesByParticipant !== null &&
            !Array.isArray(scope.capabilitiesByParticipant)
          ? scope.capabilitiesByParticipant
          : {};
    return {
      ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }),
      submissionIds: unique(scope.submissionIds),
      participantIds: unique(scope.participantIds),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(capabilitiesByParticipant === undefined ? {} : { capabilitiesByParticipant }),
      ...(scope.primaryParticipantId === undefined
        ? {}
        : { primaryParticipantId: scope.primaryParticipantId }),
      ...(scope.role === undefined ? {} : { role: scope.role }),
      ...(scope.organizer === undefined ? {} : { organizer: scope.organizer }),
    };
  }

  private assertParticipantAccess(scope: SpeakerAccessScope, participantId: string): void {
    if (!scope.participantIds.includes(participantId)) {
      throw notFound();
    }
  }

  private async assertTaskIsActive(task: SpeakerTask): Promise<void> {
    const subject = speakerTaskSubject(task);
    if (subject === undefined) {
      throw new SpeakerServiceError("TASK_NOT_ACTIVE", 409, "The speaker task subject is invalid.");
    }
    if (subject.type === "participant") return;
    if (task.tenantId === undefined) {
      throw new SpeakerServiceError(
        "TASK_NOT_ACTIVE",
        409,
        "The speaker task has no tenant authority.",
      );
    }
    try {
      await this.acceptedSession(
        task.tenantId,
        task.eventId,
        task.participantId,
        subject.sessionId,
      );
    } catch {
      throw new SpeakerServiceError(
        "TASK_NOT_ACTIVE",
        409,
        "Speaker session tasks are available only while the program session is accepted.",
      );
    }
  }

  private async assertDependenciesComplete(task: SpeakerTask): Promise<void> {
    if (task.dependencyIds.length === 0) {
      return;
    }
    const dependencies = await this.repository.getTasksByIds(task.eventId, task.dependencyIds);
    const dependencyById = new Map(dependencies.map((dependency) => [dependency.id, dependency]));
    const incomplete = task.dependencyIds.some((dependencyId) => {
      const dependency = dependencyById.get(dependencyId);
      return (
        !dependency ||
        dependency.eventId !== task.eventId ||
        !completedDependencyStatuses.has(dependency.status)
      );
    });
    if (incomplete) {
      throw new SpeakerServiceError(
        "TASK_DEPENDENCY_INCOMPLETE",
        409,
        "Complete the required earlier speaker tasks first.",
      );
    }
  }
}
