import type {
  D1Database,
  DurableObjectNamespace,
  Queue,
  R2Bucket,
} from "@cloudflare/workers-types";
import type { ApiDependencies } from "../app";
import { AgendaCatalogSynchronizer } from "../features/agenda/catalog-sync";
import { AgendaEngine } from "../features/agenda/engine";
import {
  AgendaRepositoryConflictError,
  type DurableObjectAgendaCoordinator,
} from "../features/agenda/infrastructure";
import { neutralSpeakerDisplayName } from "../features/agenda/speaker-labels";
import { localDateInTimeZone } from "../features/agenda/timezone";
import type { AgendaEntry, AgendaState, PublishedAgendaRevision } from "../features/agenda/types";
import type { RequestAuthenticator } from "../features/auth/authenticator";
import type { AuthPrincipal } from "../features/auth/types";
import type {
  AuditEntry,
  CfpForm,
  EventCfp,
  Submission,
  SubmissionParticipant,
  SubmissionVersion,
} from "../features/cfp/model";
import {
  type CfpEffects,
  CfpError,
  type CfpIdempotencyCoordinator,
  type CfpOrganizerSubmissionsReadModel,
  type CfpRepository,
  CfpService,
} from "../features/cfp/service";
import {
  CommunicationError,
  CommunicationService,
  renderTemplate,
} from "../features/communications/service";
import {
  COMMUNICATION_TEMPLATE_PURPOSES,
  type CommunicationActor,
  type CommunicationAudience,
  type CommunicationDeliveryAdapter,
  type CommunicationDeliveryRequest,
  type CommunicationPreview,
  type CommunicationRecipient,
  type CommunicationRepository,
  type CommunicationSend,
  type CommunicationSenderIdentity,
  type CommunicationTemplate,
  type CommunicationTemplatePurpose,
  type CommunicationTemplateStatus,
} from "../features/communications/types";
import { CrmRepositoryConflictError, CrmService } from "../features/crm/service";
import type {
  CrmContact,
  CrmEventProjection,
  CrmHistoryEntry,
  CrmImportResult,
  CrmMergeReconciliationInput,
  CrmMergeReconciliationResult,
  CrmNote,
  CrmOutreachBoundary,
  CrmOutreachCommand,
  CrmParticipantConflict,
  CrmParticipantContactLink,
  CrmPipelineEntry,
  CrmRepository,
  CrmRepositoryFilter,
  CrmSegment,
} from "../features/crm/types";
import { conflict } from "../features/evaluations/errors";
import type {
  EvaluationPlanScheduleState,
  EvaluationPlanScheduleSync,
  EvaluationProjectionReader,
  EvaluationReminderPlanSource,
  EvaluationRepository,
  EvaluationReviewWriteAdmission,
  OrganizerWorkspaceRecords,
  ReviewerWorkspaceRecords,
  SubmissionReviewLookup,
  SubmissionReviewSource,
  WriteEvaluationReview,
} from "../features/evaluations/repository";
import type {
  EvaluationReminderBoundary,
  EvaluationReminderDeliveryFact,
  EvaluationReviewerIdentityBoundary,
} from "../features/evaluations/routes";
import type {
  EvaluationAcceptanceHandoff,
  EvaluationAcceptanceHandoffInput,
  EvaluationDecisionProjectionInput,
  EvaluationSessionDecisionReconciliationInput,
  EvaluationSubmissionRecord,
  EvaluationSubmissionSource,
} from "../features/evaluations/service";
import { EvaluationService } from "../features/evaluations/service";
import type {
  EvaluationActor,
  EvaluationAssignment,
  EvaluationAssignmentDistributionInput,
  EvaluationAssignmentDistributionResult,
  EvaluationAssignmentReplacementInput,
  EvaluationAssignmentReplacementResult,
  EvaluationAssignmentScope,
  EvaluationConflictDeclaration,
  EvaluationDecision,
  EvaluationDecisionStatus,
  EvaluationPlan,
  EvaluationReview,
  EvaluationReviewHistory,
  EvaluationSuggestion,
  SubmissionReviewMaterial,
} from "../features/evaluations/types";
import { EventService, ProgramPublicationService } from "../features/events/service";
import {
  type Event,
  type EventAuditEntry,
  type EventRepository,
  EventRepositoryConflictError,
  type ProgramPublicationManifest,
} from "../features/events/types";
import type { OrganizationPolicy } from "../features/organizations/policy";
import { publicApiV1Contract } from "../features/public-api/contract";
import type {
  IdempotencyBeginResult,
  IdempotencyStore,
  IdempotencyStoredResponse,
} from "../features/public-api/idempotency";
import { RemixService } from "../features/remix/service";
import type {
  ContentRemixCandidate,
  ContentRevision,
  RemixAuditEntry,
  RemixCandidateFilter,
  RemixContent,
  RemixContentGateway,
  RemixField,
  RemixRecordFilter,
  RemixRepository,
  RemixSessionRecord,
  RemixSpeakerRecord,
} from "../features/remix/types";
import { ReportError, ReportService, SafeReportExporter } from "../features/reports/service";
import type {
  ReportActor,
  ReportDefinition,
  ReportProgramRecord,
  ReportRepository,
  ReportRepositoryScope,
  ReportRun,
} from "../features/reports/types";
import { SessionService } from "../features/sessions/service";
import type {
  Format,
  Level,
  Room,
  Session,
  SessionAuditEntry,
  SessionRepository,
  SessionSettings,
  SessionSpeakerReference,
  Tag,
  Track,
} from "../features/sessions/types";
import { SessionRepositoryConflictError } from "../features/sessions/types";
import { CommunicationSpeakerCommunications } from "../features/speaker/communications";
import {
  type SpeakerEmailDelivery,
  type SpeakerEmailDeliveryInput,
  type SpeakerEmailDeliveryReceipt,
  SpeakerService,
} from "../features/speaker/service";
import type {
  RepositoryResult,
  SpeakerAccountWorkloadRepository,
  SpeakerInvitationDeliveryInput,
  SpeakerInvitationDeliveryReceipt,
  SpeakerDecisionWriteFence,
  SpeakerOrganizerLifecycleRepository,
  SpeakerProfile,
  SpeakerReminderDelivery,
  SpeakerReminderDeliveryInput,
  SpeakerReminderDeliveryReceipt,
  SpeakerReminderTask,
  SpeakerRepository,
  SpeakerTask,
  UpdateBiographyCommand,
} from "../features/speaker/types";
import {
  type AirtableListOptions,
  type AirtableMapper,
  type AirtablePage,
  AirtableRepository,
  AirtableRepositoryError,
  type AirtableTransport,
  applicationIdFormula,
} from "../infrastructure/airtable";
import type { CloudflareOutboxMessage } from "../infrastructure/cloudflare/bindings";
import { R2PrivateAssetGateway } from "../infrastructure/cloudflare/private-assets";
import { D1CalendarInvitationRepository } from "../infrastructure/cloudflare/repositories/calendar-invitations";
import { D1CfpFileAssetGateway } from "../infrastructure/cloudflare/repositories/cfp-file-assets";
import { D1EventRoleInvitationRepository } from "../infrastructure/cloudflare/repositories/event-role-invitations";
import {
  D1OrganizerOverviewReadModel,
  D1PublishedProgramReadModel,
} from "../infrastructure/cloudflare/repositories/public-read-models";
import {
  D1PublishedSpeakerProjectionStore,
  type PublishedSpeakerProjectionRecord,
  publishedHeadshotContentType,
  selectReleasedSpeakerHeadshot,
} from "../infrastructure/cloudflare/repositories/published-speakers";
import type { CloudflareAiProviders } from "../integrations/ai";
import {
  type CalendarIntegrationOptions,
  CalendarInvitationLifecycle,
  type CalendarInvitationPayload,
  createCalendarUid,
} from "../integrations/calendar";
import type { OpenSendSenderAddresses } from "../integrations/opensend/client";
import { openSendSenderAddressSchema } from "../integrations/opensend/types";
import type {
  CreateWebhookDeliveryInput,
  CreateWebhookSubscriptionInput,
  DeliveryAttemptResult,
  UpdateWebhookSubscriptionInput,
  WebhookDelivery,
  WebhookRepository,
  WebhookSubscriptionRecord,
} from "../integrations/webhooks/types";
import { WebhookRepositoryError } from "../integrations/webhooks/types";
import { invalidatePublishedAgendaCache } from "../routes/agenda";
import type {
  OrganizerOverviewActionItem,
  OrganizerOverviewActivityData,
  OrganizerOverviewCoreData,
  OrganizerOverviewEvent,
  OrganizerOverviewRouteDependencies,
} from "../routes/organizer-overview";
import {
  invalidatePublishedSpeakerCache,
  publishedSpeakerPhotoPath,
} from "../routes/public-speakers";
import {
  createRuntimeEventRoleInvitationAdapters,
  type D1RuntimeDependencies,
  type RuntimeEventRoleInvitationAdapters,
} from "./d1";
import { createEvaluationActorResolver } from "./evaluation-actor";
import { resolvedOrganizationId, resolveOrganizationScope } from "./organization-scope";

const APPLICATION_ID = "Application ID";
const DEFAULT_JSON_FIELD = "Settings JSON";
const EVENT_INDEXED_FIELDS = {
  Name: "name",
  Slug: "slug",
  "Time Zone": "timeZone",
  "Starts At": "startsAt",
  "Ends At": "endsAt",
  Version: "version",
  "Created At": "createdAt",
  "Updated At": "updatedAt",
} as const satisfies Readonly<Record<string, string>>;

type JsonRecord = Record<string, unknown>;

type AirtableFields = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function publicationSourceHash(value: unknown): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function entityType(value: object): string | undefined {
  return isRecord(value) && typeof value.entityType === "string" ? value.entityType : undefined;
}

function isSpeakerSubmissionRecord(value: object): boolean {
  const kind = entityType(value);
  if (kind !== undefined) return kind === "speaker_submission";
  const id = isRecord(value) && typeof value.id === "string" ? value.id : "";
  return (
    id.startsWith("speaker-submission:") ||
    ("primaryParticipantId" in value && "participantIds" in value) ||
    !("formId" in value)
  );
}

function tagged<T extends object>(value: T, kind: string): T {
  return { ...value, entityType: kind } as T;
}
function untagged<T extends object>(value: T): T {
  if (!isRecord(value)) return value;
  const { entityType: _kind, ...rest } = value;
  const record = rest as JsonRecord;
  const scope = resolveOrganizationScope(record);
  if (scope.status === "conflict") {
    throw new TypeError("The Airtable record contains conflicting organization scope.");
  }
  if (scope.status === "resolved" && Object.hasOwn(record, "tenantId")) {
    record.tenantId = scope.organizationId;
    delete record.organizationId;
  }
  return record as T;
}

function requiredId(value: unknown, label = "id"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function recordId(value: object): string {
  const candidate = isRecord(value) ? value.id : undefined;
  return requiredId(candidate);
}

function isEvaluationAssignmentRecord(value: object): boolean {
  const kind = entityType(value);
  return (
    kind === "evaluation_assignment" ||
    (kind === undefined &&
      "reviewerId" in value &&
      !("scores" in value) &&
      !("assignmentId" in value))
  );
}

function isEvaluationReviewRecord(value: object): boolean {
  const kind = entityType(value);
  return kind === "evaluation_review" || (kind === undefined && "scores" in value);
}
function isEvaluationSuggestionRecord(value: object): value is EvaluationSuggestion & JsonRecord {
  if (!isRecord(value) || entityType(value) !== "evaluation_suggestion") return false;
  return (
    typeof value.id === "string" &&
    typeof value.tenantId === "string" &&
    typeof value.eventId === "string" &&
    typeof value.planId === "string" &&
    typeof value.roundId === "string" &&
    value.assignmentId === null &&
    typeof value.submissionId === "string" &&
    typeof value.reviewerId === "string" &&
    typeof value.version === "number"
  );
}

interface AirtableEvaluationAssignmentGenerationSnapshot {
  readonly version: number;
  readonly committedAt: string;
  readonly assignments: readonly EvaluationAssignment[];
}

interface AirtableEvaluationPlanRecord extends EvaluationPlan {
  readonly assignmentGenerationSnapshot?: AirtableEvaluationAssignmentGenerationSnapshot;
}

function publicEvaluationPlan(record: AirtableEvaluationPlanRecord): EvaluationPlan {
  const { assignmentGenerationSnapshot: _snapshot, ...plan } = untagged(record);
  return plan;
}

function latestEvaluationAssignmentRows(
  records: readonly object[],
  tenantId?: string,
  planId?: string,
): readonly EvaluationAssignment[] {
  const byId = new Map<string, EvaluationAssignment>();
  for (const record of records) {
    if (!isEvaluationAssignmentRecord(record)) continue;
    const assignment = untagged(record as EvaluationAssignment);
    if (
      (tenantId !== undefined && assignment.tenantId !== tenantId) ||
      (planId !== undefined && assignment.planId !== planId)
    ) {
      continue;
    }
    const current = byId.get(assignment.id);
    if (
      current === undefined ||
      assignment.version > current.version ||
      (assignment.version === current.version &&
        assignment.updatedAt.localeCompare(current.updatedAt) > 0)
    ) {
      byId.set(assignment.id, clone(assignment));
    }
  }
  return [...byId.values()];
}

function overlayEvaluationAssignmentSnapshot(
  plan: AirtableEvaluationPlanRecord,
  rows: readonly EvaluationAssignment[],
): readonly EvaluationAssignment[] {
  const scopedRows = rows.filter(
    (assignment) =>
      assignment.tenantId === plan.tenantId &&
      assignment.eventId === plan.eventId &&
      assignment.planId === plan.id,
  );
  const snapshot = plan.assignmentGenerationSnapshot;
  if (snapshot === undefined) return latestEvaluationAssignmentRows(scopedRows);

  const assignments = new Map<string, EvaluationAssignment>();
  for (const assignment of snapshot.assignments) {
    if (
      assignment.tenantId === plan.tenantId &&
      assignment.eventId === plan.eventId &&
      assignment.planId === plan.id
    ) {
      assignments.set(assignment.id, clone(assignment));
    }
  }
  for (const row of latestEvaluationAssignmentRows(scopedRows)) {
    const committed = assignments.get(row.id);
    if (committed !== undefined && row.version > committed.version) {
      assignments.set(row.id, clone(row));
    }
  }
  return [...assignments.values()];
}

function overlayEvaluationAssignmentSnapshots(
  plans: readonly AirtableEvaluationPlanRecord[],
  rows: readonly EvaluationAssignment[],
): readonly EvaluationAssignment[] {
  const planByKey = new Map(
    plans.map((plan) => [`${plan.tenantId}\u0000${plan.id}`, plan] as const),
  );
  const result = new Map<string, EvaluationAssignment>();
  for (const plan of plans) {
    for (const assignment of overlayEvaluationAssignmentSnapshot(plan, rows)) {
      result.set(`${assignment.tenantId}\u0000${assignment.id}`, assignment);
    }
  }
  for (const assignment of latestEvaluationAssignmentRows(rows)) {
    if (!planByKey.has(`${assignment.tenantId}\u0000${assignment.planId}`)) {
      result.set(`${assignment.tenantId}\u0000${assignment.id}`, assignment);
    }
  }
  return [...result.values()];
}

function isEvaluationDecisionRecord(value: object): value is EvaluationDecision {
  if (!isRecord(value)) return false;
  const kind = entityType(value);
  if (kind !== undefined && kind !== "evaluation_decision") return false;
  return (
    typeof value.id === "string" &&
    typeof value.tenantId === "string" &&
    typeof value.eventId === "string" &&
    typeof value.planId === "string" &&
    typeof value.submissionId === "string" &&
    (value.status === "accepted" || value.status === "waitlisted" || value.status === "rejected") &&
    typeof value.version === "number" &&
    Array.isArray(value.history) &&
    typeof value.updatedAt === "string"
  );
}

function textValue(record: JsonRecord, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}
function eventReference(record: JsonRecord): string | null {
  return textValue(record, "eventId", "eventID", "event");
}
function speakerProfileScoped(
  profile: JsonRecord | SpeakerProfile,
  tenantId: string,
  eventId: string,
  eventOrganizationId: string | undefined,
): boolean {
  const record = profile as unknown as JsonRecord;
  if (eventReference(record) !== eventId || eventOrganizationId !== tenantId) return false;
  const profileScope = resolveOrganizationScope(record);
  if (profileScope.status === "resolved") return profileScope.organizationId === tenantId;
  return profileScope.status === "missing";
}

function belongsToOrganization(
  record: JsonRecord,
  organizationId: string,
  eventIds: ReadonlySet<string>,
): boolean {
  const scope = resolveOrganizationScope(record);
  if (scope.status === "resolved") return scope.organizationId === organizationId;
  if (scope.status === "conflict") return false;
  const eventId = eventReference(record);
  return eventId !== null && eventIds.has(eventId);
}

function dueAtValue(record: JsonRecord): string | null {
  const candidate = textValue(record, "dueAt", "closesAt", "endsAt", "deadline");
  return candidate !== null && Number.isNaN(Date.parse(candidate)) === false ? candidate : null;
}

function earliestDueAt(values: readonly (string | null)[]): string | null {
  return (
    values
      .filter((value): value is string => value !== null)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null
  );
}

function hrefFor(
  organizationId: string,
  eventId: string,
  suffix: "reviews" | "speakers" | "agenda",
): string {
  return `/admin/organizations/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}/${suffix}`;
}

function actionItem(
  input: Omit<OrganizerOverviewActionItem, "dueAt"> & { dueAt?: string | null },
): OrganizerOverviewActionItem {
  return { ...input, dueAt: input.dueAt ?? null };
}

const FIELD_ALIASES: Readonly<Record<string, string>> = {
  Name: "name",
  Slug: "slug",
  Title: "title",
  Abstract: "abstract",
  Biography: "biography",
  "Display Name": "displayName",
  Status: "status",
  "Starts At": "startsAt",
  "Ends At": "endsAt",
  Version: "version",
  "Event ID": "eventId",
  "Form ID": "formId",
  "Organization ID": "organizationId",
  "Tenant ID": "tenantId",
  "Updated At": "updatedAt",
  "Created At": "createdAt",
  "Due At": "dueAt",
  "Time Zone": "timeZone",
  Timezone: "timezone",
  Type: "type",
  Owner: "owner",
  "Headshot Asset ID": "headshotAssetId",
  "Participant IDs": "participantIds",
  "Participant ID": "participantId",
  "Submission ID": "submissionId",
  "Dependency IDs": "dependencyIds",
  "Reminder Offsets Minutes": "reminderOffsetsMinutes",
  "Accepted Asset Kinds": "acceptedAssetKinds",
  Kind: "kind",
  "Object Key": "objectKey",
  "File Name": "fileName",
  "Content Type": "contentType",
  "Size Bytes": "sizeBytes",
  State: "state",
  "Version Family ID": "versionFamilyId",
  "Supersedes Asset ID": "supersedesAssetId",
  "Comment Thread ID": "commentThreadId",
  "Rejection Reason": "rejectionReason",
  "Finalized At": "finalizedAt",
  "Owner Account ID": "ownerAccountId",
  "Endpoint URL": "endpointUrl",
  Events: "events",
  Active: "active",
  "Signing Secret": "signingSecret",
  "Signing Secret Last Four": "signingSecretLastFour",
};
function encodeJson(
  value: object,
  jsonField: string,
  scopeFields: { readonly eventId?: boolean; readonly organizationId?: boolean } = {},
  indexedFields: Readonly<Record<string, string>> = {},
): AirtableFields {
  const record = value as JsonRecord;
  const id = recordId(value);
  const scope = resolveOrganizationScope(record);
  if (scope.status === "conflict") {
    throw new TypeError("The Airtable record contains conflicting organization scope.");
  }
  const organizationId = scope.status === "resolved" ? scope.organizationId : undefined;
  const indexed = Object.fromEntries(
    Object.entries(indexedFields).flatMap(([field, property]) => {
      const indexedValue = record[property];
      return typeof indexedValue === "string" ||
        typeof indexedValue === "number" ||
        typeof indexedValue === "boolean"
        ? [[field, indexedValue]]
        : [];
    }),
  );
  return {
    [APPLICATION_ID]: id,
    ...(scopeFields.organizationId && organizationId !== undefined
      ? { "Organization ID": organizationId }
      : {}),
    ...(scopeFields.eventId && typeof record.eventId === "string"
      ? { "Event ID": record.eventId }
      : {}),
    ...indexed,
    [jsonField]: JSON.stringify(value),
  };
}

function decodeJson<T extends object>(
  fields: Readonly<AirtableFields>,
  jsonField: string,
  indexedFields: Readonly<Record<string, string>> = {},
): T {
  const payloadAliases = [jsonField, "Payload", "JSON", "Data", "Record JSON"];
  const payload = payloadAliases
    .map((alias) => fields[alias])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const indexed = Object.fromEntries(
    Object.entries(indexedFields).flatMap(([field, property]) => {
      const value = fields[field];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [[property, value]]
        : [];
    }),
  );
  if (payload !== undefined) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (isRecord(parsed)) {
        const payloadScope = resolveOrganizationScope(parsed);
        if (payloadScope.status === "conflict") {
          throw new TypeError("The Airtable payload contains conflicting organization scope.");
        }
        const indexedScope = resolveOrganizationScope({
          organizationId: fields["Organization ID"],
        });
        if (
          indexedScope.status === "resolved" &&
          payloadScope.status === "resolved" &&
          indexedScope.organizationId !== payloadScope.organizationId
        ) {
          throw new TypeError(
            "The Airtable payload conflicts with its indexed organization scope.",
          );
        }
        const organizationId =
          indexedScope.status === "resolved"
            ? indexedScope.organizationId
            : payloadScope.status === "resolved"
              ? payloadScope.organizationId
              : undefined;
        const eventId =
          typeof fields["Event ID"] === "string"
            ? fields["Event ID"]
            : typeof parsed.eventId === "string"
              ? parsed.eventId
              : undefined;
        const id = typeof fields[APPLICATION_ID] === "string" ? fields[APPLICATION_ID] : parsed.id;
        requiredId(id);
        return {
          ...parsed,
          ...indexed,
          ...(id === undefined ? {} : { id }),
          ...(organizationId === undefined ? {} : { tenantId: organizationId, organizationId }),
          ...(eventId === undefined ? {} : { eventId }),
        } as T;
      }
      throw new TypeError("The Airtable payload is not valid JSON.");
    } catch {
      throw new TypeError("The Airtable payload is not valid JSON.");
    }
  }

  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(fields)) {
    if (payloadAliases.includes(key)) continue;
    if (key === APPLICATION_ID) {
      result.id = value;
    } else if (key === "Organization ID") {
      result.organizationId = value;
      result.tenantId = value;
    } else if (key === "Version") {
      result.version = value;
    } else if (key === "Updated At") {
      result.updatedAt = value;
    } else if (key === "Created At") {
      result.createdAt = value;
    } else {
      const alias = FIELD_ALIASES[key] ?? key;
      if (typeof value === "string" && (value.startsWith("[") || value.startsWith("{"))) {
        try {
          result[alias] = JSON.parse(value) as unknown;
        } catch {
          result[alias] = value;
        }
      } else {
        result[alias] = value;
      }
    }
  }
  requiredId(result.id);
  return result as T;
}

function decodeCfpSubmission(fields: Readonly<AirtableFields>): Submission {
  const submission = decodeJson<Submission>(fields, "Answers JSON") as Submission & JsonRecord;
  const title = textValue(fields as JsonRecord, "Title");
  const abstract = textValue(fields as JsonRecord, "Abstract");
  return {
    ...submission,
    ...(title === null ? {} : { title }),
    ...(abstract === null ? {} : { abstract }),
  } as Submission;
}
function jsonMapper<T extends object>(
  jsonField: string,
  decode: ((fields: Readonly<AirtableFields>) => T) | undefined = undefined,
  scopeFields: { readonly eventId?: boolean; readonly organizationId?: boolean } = {},
  indexedFields: Readonly<Record<string, string>> = {},
): AirtableMapper<T, T, Partial<T>, AirtableFields> {
  const decodeRecord =
    decode ??
    ((fields: Readonly<AirtableFields>) => decodeJson<T>(fields, jsonField, indexedFields));
  return {
    applicationIdField: APPLICATION_ID,
    applicationIdOf: (input) => recordId(input),
    encodeCreate: (input) => encodeJson(input, jsonField, scopeFields, indexedFields),
    encodeUpdate: (input) => encodeJson(input as T, jsonField, scopeFields, indexedFields),
    decode: decodeRecord,
  };
}

function applicationIdsFormula(ids: readonly string[]): string {
  const formulas = ids.map((id) => applicationIdFormula(APPLICATION_ID, id));
  if (formulas.length === 0) {
    throw new TypeError("At least one application ID is required.");
  }
  return formulas.length === 1 ? (formulas[0] as string) : `OR(${formulas.join(",")})`;
}
function eventFilterFormula(jsonField: string, eventId: string): string {
  return `FIND(${JSON.stringify(eventId)},{${jsonField}})>0`;
}
/**
 * Matches records whose JSON payload names the organization or any of the
 * organization's event ids. Plain-substring FIND needles intentionally
 * over-match (whitespace-insensitive, substring collisions); callers still
 * apply the exact parsed-JSON filter afterwards, so the formula only needs
 * to be a guaranteed superset of the client-side filter.
 */
function organizationScopeFormula(
  jsonField: string,
  organizationId: string,
  eventIds: readonly string[],
): string {
  const needles = [organizationId, ...eventIds];
  const clauses = needles.map((needle) => `FIND(${JSON.stringify(needle)},{${jsonField}})>0`);
  return clauses.length === 1 ? (clauses[0] as string) : `OR(${clauses.join(",")})`;
}
function jsonContainsAllFormula(jsonField: string, values: readonly string[]): string {
  const clauses = values.map((value) => `FIND(${JSON.stringify(value)},{${jsonField}})>0`);
  if (clauses.length === 0) {
    throw new TypeError("At least one JSON value is required.");
  }
  return clauses.length === 1 ? (clauses[0] as string) : `AND(${clauses.join(",")})`;
}

function reviewerWorkspaceFormula(
  jsonField: string,
  tenantId: string,
  reviewerId: string,
  eventIds: readonly string[],
): string {
  const eventClauses = eventIds.map(
    (eventId) => `FIND(${JSON.stringify(eventId)},{${jsonField}})>0`,
  );
  const eventFormula =
    eventClauses.length === 1 ? (eventClauses[0] as string) : `OR(${eventClauses.join(",")})`;
  return `AND(${jsonContainsAllFormula(jsonField, [tenantId, reviewerId])},${eventFormula})`;
}

/** A typed Airtable repository whose only opaque identifier is Airtable's internal record id. */
export class AirtableJsonStore<T extends object> {
  readonly #repository: AirtableRepository<T, T, Partial<T>, AirtableFields>;

  constructor(options: {
    readonly baseId: string;
    readonly table: string;
    readonly transport: AirtableTransport;
    readonly jsonField?: string;
    readonly decode?: (fields: Readonly<AirtableFields>) => T;
    readonly scopeFields?: {
      readonly eventId?: boolean;
      readonly organizationId?: boolean;
    };
    readonly indexedFields?: Readonly<Record<string, string>>;
  }) {
    const jsonField = options.jsonField ?? DEFAULT_JSON_FIELD;
    this.#repository = new AirtableRepository({
      baseId: options.baseId,
      table: options.table,
      mapper: jsonMapper<T>(jsonField, options.decode, options.scopeFields, options.indexedFields),
      transport: options.transport,
    });
  }

  find(id: string): Promise<T | undefined> {
    return this.#repository.find(requiredId(id));
  }

  findWithRecordId(
    id: string,
  ): Promise<{ readonly recordId: string; readonly entity: T } | undefined> {
    return this.#repository.findWithRecordId(requiredId(id));
  }

  get(id: string): Promise<T> {
    return this.#repository.get(requiredId(id));
  }

  create(value: T): Promise<T> {
    return this.#repository.create(clone(value));
  }

  update(id: string, value: T): Promise<T> {
    return this.#repository.update(requiredId(id), clone(value));
  }

  updateByRecordId(id: string, recordId: string, value: T): Promise<T> {
    return this.#repository.updateByRecordId(requiredId(id), recordId, clone(value));
  }

  delete(id: string): Promise<boolean> {
    return this.#repository.delete(requiredId(id));
  }

  deleteByRecordId(recordId: string): Promise<boolean> {
    return this.#repository.deleteByRecordId(recordId);
  }

  listPage(options: AirtableListOptions = {}): Promise<AirtablePage<T>> {
    return this.#repository.list(options);
  }

  async list(options: Omit<AirtableListOptions, "cursor"> = {}): Promise<T[]> {
    const values: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#repository.list({
        ...options,
        ...(cursor === undefined ? {} : { cursor }),
        pageSize: options.pageSize ?? 100,
      });
      values.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }

  async listWithRecordIds(
    options: Omit<AirtableListOptions, "cursor"> = {},
  ): Promise<Array<{ readonly recordId: string; readonly entity: T }>> {
    const values: Array<{ readonly recordId: string; readonly entity: T }> = [];
    let cursor: string | undefined;
    do {
      const page = await this.#repository.listWithRecordIds({
        ...options,
        ...(cursor === undefined ? {} : { cursor }),
        pageSize: options.pageSize ?? 100,
      });
      values.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }

  async listByIds(ids: readonly string[]): Promise<T[]> {
    const uniqueIds = [...new Set(ids.map((id) => requiredId(id)))];
    if (uniqueIds.length === 0) return [];
    return this.list({ filterByFormula: applicationIdsFormula(uniqueIds) });
  }
}
const AIRTABLE_APPLICATION_ID_BATCH_SIZE = 50;

async function listApplicationIdsInBatches<T extends object>(
  store: Pick<AirtableJsonStore<T>, "listByIds">,
  ids: readonly string[],
): Promise<readonly T[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  const batches: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += AIRTABLE_APPLICATION_ID_BATCH_SIZE) {
    batches.push(uniqueIds.slice(index, index + AIRTABLE_APPLICATION_ID_BATCH_SIZE));
  }
  const results = await Promise.all(batches.map((batch) => store.listByIds(batch)));
  return results.flat();
}
export async function listEventScopedJson<T extends object>(
  store: Pick<AirtableJsonStore<T>, "list">,
  jsonField: string,
  eventId: string,
): Promise<T[]> {
  return store.list({ filterByFormula: eventFilterFormula(jsonField, eventId) });
}
function byOrganization(value: object, organizationId: string): boolean {
  return resolvedOrganizationId(value) === organizationId;
}

function datesFromSubscription(value: WebhookSubscriptionRecord): WebhookSubscriptionRecord {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    events: [...value.events],
  };
}
function datesFromDelivery(value: WebhookDelivery): WebhookDelivery {
  return {
    ...value,
    event: {
      ...value.event,
      occurredAt: value.event.occurredAt,
    },
    nextAttemptAt: value.nextAttemptAt === null ? null : new Date(value.nextAttemptAt),
    completedAt: value.completedAt === null ? null : new Date(value.completedAt),
    createdAt: new Date(value.createdAt),
    failureHistory: value.failureHistory.map((failure) => ({
      ...failure,
      attemptedAt: new Date(failure.attemptedAt),
    })),
  };
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function secretLastFour(secret: string): string {
  return secret.slice(-4).padStart(4, "•");
}

function randomResourceId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
/** Airtable-backed webhook subscriptions and durable delivery records. */
export class AirtableWebhookRepository implements WebhookRepository {
  readonly #subscriptions: AirtableJsonStore<WebhookSubscriptionRecord>;
  readonly #deliveries: AirtableJsonStore<WebhookDelivery>;

  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
  }) {
    this.#subscriptions = new AirtableJsonStore({
      baseId: options.baseId,
      table: "Publication Outbox",
      transport: options.transport,
      jsonField: "Payload JSON",
    });
    this.#deliveries = new AirtableJsonStore({
      baseId: options.baseId,
      table: "Publication Outbox",
      transport: options.transport,
      jsonField: "Payload JSON",
    });
  }

  async listSubscriptions(organizationId: string): Promise<readonly WebhookSubscriptionRecord[]> {
    return (await this.#subscriptions.list())
      .filter(
        (subscription) =>
          byOrganization(subscription, organizationId) &&
          (isRecord(subscription) && subscription.entityType !== undefined
            ? subscription.entityType === "webhook_subscription"
            : "events" in subscription),
      )
      .map(datesFromSubscription)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  async getSubscription(
    organizationId: string,
    subscriptionId: string,
  ): Promise<WebhookSubscriptionRecord | null> {
    const subscription = await this.#subscriptions.find(subscriptionId);
    return subscription !== undefined && byOrganization(subscription, organizationId)
      ? datesFromSubscription(subscription)
      : null;
  }

  async createSubscription(
    input: CreateWebhookSubscriptionInput,
  ): Promise<WebhookSubscriptionRecord> {
    const now = new Date();
    const signingSecret = input.signingSecret ?? randomSecret();
    if (signingSecret.trim().length === 0) {
      throw new WebhookRepositoryError("INVALID", "A signing secret is required.");
    }
    const subscription: WebhookSubscriptionRecord = {
      id: randomResourceId("whs"),
      organizationId: input.organizationId,
      endpointUrl: input.endpointUrl,
      events: [...input.events],
      active: input.active ?? true,
      signingSecret,
      signingSecretLastFour: secretLastFour(signingSecret),
      createdAt: now,
      updatedAt: now,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    };
    try {
      await this.#subscriptions.create(tagged(subscription, "webhook_subscription"));
    } catch {
      throw new WebhookRepositoryError(
        "CONFLICT",
        "The webhook subscription could not be created.",
      );
    }
    return datesFromSubscription(subscription);
  }

  async updateSubscription(
    organizationId: string,
    subscriptionId: string,
    input: UpdateWebhookSubscriptionInput,
  ): Promise<WebhookSubscriptionRecord | null> {
    const existing = await this.getSubscription(organizationId, subscriptionId);
    if (existing === null) return null;
    const signingSecret = input.signingSecret ?? existing.signingSecret;
    const updated: WebhookSubscriptionRecord = {
      ...existing,
      ...(input.endpointUrl === undefined ? {} : { endpointUrl: input.endpointUrl }),
      ...(input.events === undefined ? {} : { events: [...input.events] }),
      ...(input.active === undefined ? {} : { active: input.active }),
      signingSecret,
      signingSecretLastFour: secretLastFour(signingSecret),
      updatedAt: new Date(),
    };
    if (input.eventId !== undefined) {
      if (input.eventId === null) delete updated.eventId;
      else updated.eventId = input.eventId;
    }
    await this.#subscriptions.update(subscriptionId, tagged(updated, "webhook_subscription"));
    return datesFromSubscription(updated);
  }

  async deleteSubscription(organizationId: string, subscriptionId: string): Promise<boolean> {
    const existing = await this.getSubscription(organizationId, subscriptionId);
    if (existing === null) return false;
    return this.#subscriptions.delete(subscriptionId);
  }

  async createDelivery(input: CreateWebhookDeliveryInput): Promise<WebhookDelivery> {
    const subscription = await this.getSubscription(input.organizationId, input.subscriptionId);
    if (subscription === null) {
      throw new WebhookRepositoryError("NOT_FOUND", "The webhook subscription was not found.");
    }
    const existing = (await this.#deliveries.list()).find(
      (delivery) =>
        (isRecord(delivery) && delivery.entityType !== undefined
          ? delivery.entityType === "webhook_delivery"
          : "status" in delivery) &&
        delivery.subscriptionId === input.subscriptionId &&
        delivery.event.id === input.event.id,
    );
    if (existing !== undefined) return datesFromDelivery(existing);
    const delivery: WebhookDelivery = {
      id: randomResourceId("whd"),
      organizationId: input.organizationId,
      subscriptionId: subscription.id,
      event: clone(input.event),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date(input.createdAt),
      lastResponseStatus: null,
      lastError: null,
      createdAt: new Date(input.createdAt),
      completedAt: null,
      failureHistory: [],
    };
    await this.#deliveries.create(tagged(delivery, "webhook_delivery"));
    return datesFromDelivery(delivery);
  }

  async claimDueDelivery(now: Date): Promise<WebhookDelivery | null> {
    const candidate = (await this.#deliveries.list())
      .map(datesFromDelivery)
      .filter(
        (delivery) =>
          (isRecord(delivery) && delivery.entityType !== undefined
            ? delivery.entityType === "webhook_delivery"
            : "status" in delivery) &&
          (delivery.status === "pending" || delivery.status === "retrying") &&
          delivery.nextAttemptAt !== null &&
          delivery.nextAttemptAt.getTime() <= now.getTime(),
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];
    if (candidate === undefined) return null;
    const claimed = {
      ...candidate,
      status: "delivering" as const,
      nextAttemptAt: null,
    };
    await this.#deliveries.update(claimed.id, tagged(claimed, "webhook_delivery"));
    return datesFromDelivery(claimed);
  }

  async markDeliverySucceeded(
    deliveryId: string,
    result: DeliveryAttemptResult,
  ): Promise<WebhookDelivery | null> {
    return this.applyDeliveryAttempt(deliveryId, result, "succeeded", result.attemptedAt);
  }

  async markDeliveryRetry(
    deliveryId: string,
    result: DeliveryAttemptResult,
  ): Promise<WebhookDelivery | null> {
    return this.applyDeliveryAttempt(deliveryId, result, "retrying", null);
  }

  async markDeliveryFailed(
    deliveryId: string,
    result: DeliveryAttemptResult,
  ): Promise<WebhookDelivery | null> {
    return this.applyDeliveryAttempt(
      deliveryId,
      result,
      result.retryable === true ? "dead_letter" : "failed",
      result.attemptedAt,
    );
  }

  private async applyDeliveryAttempt(
    deliveryId: string,
    result: DeliveryAttemptResult,
    status: WebhookDelivery["status"],
    completedAt: Date | null,
  ): Promise<WebhookDelivery | null> {
    const stored = await this.#deliveries.find(deliveryId);
    if (stored === undefined) return null;
    const delivery = datesFromDelivery(stored);
    const updated: WebhookDelivery = {
      ...delivery,
      status,
      attemptCount: Math.max(delivery.attemptCount, result.attemptCount),
      nextAttemptAt: result.nextAttemptAt === undefined ? null : result.nextAttemptAt,
      lastResponseStatus: result.responseStatus,
      lastError: result.error,
      completedAt,
      ...(result.responseBody === undefined ? {} : { lastResponseBody: result.responseBody }),
      ...(result.error === null
        ? {}
        : {
            failureHistory: [
              ...delivery.failureHistory,
              {
                attemptedAt: new Date(result.attemptedAt),
                attempt: result.attemptCount,
                responseStatus: result.responseStatus,
                error: result.error,
                responseBody: result.responseBody ?? null,
                retryable: result.retryable ?? (status === "retrying" || status === "dead_letter"),
              },
            ],
          }),
    };
    await this.#deliveries.update(deliveryId, tagged(updated, "webhook_delivery"));
    return datesFromDelivery(updated);
  }
}
function eventInstantFromRecord(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function eventInstantOrNull(value: unknown): string | null {
  if (value === null || value === undefined || typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function eventDateOnly(value: string, timeZone: string): string | null {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en", {
      calendar: "iso8601",
      day: "2-digit",
      month: "2-digit",
      numberingSystem: "latn",
      timeZone,
      year: "numeric",
    }).formatToParts(new Date(timestamp));
    const valueFor = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const date = `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`;
    return /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : null;
  } catch {
    return null;
  }
}

function eventRecord(value: JsonRecord): Event {
  const id = requiredId(value.id);
  const organizationId = resolvedOrganizationId(value);
  if (organizationId === undefined) {
    throw new TypeError("An Airtable event record must contain an organization id.");
  }
  const name = textValue(value, "name", "title") ?? id;
  const slug = textValue(value, "slug") ?? id;
  const timeZone = textValue(value, "timeZone", "timezone") ?? "UTC";
  const startsAt = eventInstantFromRecord(
    textValue(value, "startsAt", "startAt"),
    "1970-01-01T00:00:00.000Z",
  );
  const endsFallback = new Date(Date.parse(startsAt) + 30 * 60_000).toISOString();
  const endsCandidate = eventInstantFromRecord(textValue(value, "endsAt", "endAt"), endsFallback);
  const endsAt = Date.parse(endsCandidate) > Date.parse(startsAt) ? endsCandidate : endsFallback;
  const rawCfp = isRecord(value.cfpSettings) ? value.cfpSettings : {};
  const opensAt = eventInstantOrNull(rawCfp.opensAt ?? value.opensAt);
  const closesAt = eventInstantOrNull(rawCfp.closesAt ?? value.closesAt);
  const rawCalendar = isRecord(value.defaultCalendarSettings) ? value.defaultCalendarSettings : {};
  const durationMinutes =
    typeof rawCalendar.durationMinutes === "number" &&
    Number.isSafeInteger(rawCalendar.durationMinutes) &&
    rawCalendar.durationMinutes >= 1 &&
    rawCalendar.durationMinutes <= 1_440
      ? rawCalendar.durationMinutes
      : 30;
  const calendarTimeZone =
    typeof rawCalendar.timeZone === "string" && rawCalendar.timeZone.trim().length > 0
      ? rawCalendar.timeZone.trim()
      : timeZone;
  const location =
    rawCalendar.location === null
      ? null
      : typeof rawCalendar.location === "string"
        ? rawCalendar.location
        : textValue(value, "venue");
  const version =
    typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version >= 1
      ? value.version
      : 1;
  const createdAt = eventInstantFromRecord(
    textValue(value, "createdAt"),
    eventInstantFromRecord(textValue(value, "updatedAt"), "1970-01-01T00:00:00.000Z"),
  );
  const updatedAt = eventInstantFromRecord(textValue(value, "updatedAt"), createdAt);
  return {
    id,
    organizationId,
    slug,
    name,
    timeZone,
    startsAt,
    endsAt,
    venue: textValue(value, "venue"),
    cfpSettings: {
      enabled:
        typeof rawCfp.enabled === "boolean"
          ? rawCfp.enabled
          : opensAt !== null && closesAt !== null,
      opensAt,
      closesAt,
    },
    defaultCalendarSettings: {
      durationMinutes,
      timeZone: calendarTimeZone,
      location,
    },
    embedConfigurations: Array.isArray(value.embedConfigurations)
      ? (clone(value.embedConfigurations) as readonly Event["embedConfigurations"][number][])
      : [],
    version,
    createdAt,
    updatedAt,
    createdBy: textValue(value, "createdBy") ?? "system",
    updatedBy: textValue(value, "updatedBy") ?? "system",
  };
}
function cfpEventFromRecord(value: JsonRecord): EventCfp {
  const id = requiredId(value.id);
  const tenantId = resolvedOrganizationId(value);
  if (tenantId === undefined) {
    throw new TypeError("An Airtable CFP event record must contain an organization id.");
  }
  const startsAt = eventInstantFromRecord(
    textValue(value, "startsAt", "startAt"),
    "1970-01-01T00:00:00.000Z",
  );
  const endsFallback = new Date(Date.parse(startsAt) + 30 * 60_000).toISOString();
  const rawCfp = isRecord(value.cfpSettings) ? value.cfpSettings : {};
  const opensAt = eventInstantOrNull(rawCfp.opensAt ?? value.opensAt) ?? startsAt;
  const closesAt = eventInstantOrNull(rawCfp.closesAt ?? value.closesAt) ?? endsFallback;
  return {
    id,
    tenantId,
    version:
      typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version >= 1
        ? value.version
        : 1,
    slug: textValue(value, "slug") ?? id,
    name: textValue(value, "name", "title") ?? id,
    timezone: textValue(value, "timezone", "timeZone") ?? "UTC",
    eventStartsAt: startsAt,
    opensAt,
    closesAt: Date.parse(closesAt) > Date.parse(opensAt) ? closesAt : endsFallback,
  };
}
function isCanonicalEventRecord(value: JsonRecord): boolean {
  return (
    typeof value.timeZone === "string" ||
    isRecord(value.cfpSettings) ||
    isRecord(value.defaultCalendarSettings)
  );
}

export class AirtableEventRepository implements EventRepository {
  readonly #events: AirtableJsonStore<JsonRecord>;
  readonly #audit: AirtableJsonStore<JsonRecord>;

  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
  }) {
    const shared = { baseId: options.baseId, transport: options.transport };
    this.#events = jsonStore(shared, "Events", "Settings JSON", EVENT_INDEXED_FIELDS);
    this.#audit = jsonStore(shared, "Audit Records", "Changes JSON");
  }

  async getEvent(organizationId: string, eventId: string): Promise<Event | null> {
    const raw = await this.#events.find(eventId);
    if (raw === undefined) return null;
    const event = eventRecord(raw);
    return event.organizationId === organizationId ? clone(event) : null;
  }

  async listEvents(organizationId: string): Promise<readonly Event[]> {
    return (await this.#events.list())
      .map(eventRecord)
      .filter((event) => event.organizationId === organizationId)
      .map(clone);
  }

  async findEventBySlug(organizationId: string, slug: string): Promise<Event | null> {
    const normalizedSlug = slug.trim().toLowerCase();
    const event = (await this.listEvents(organizationId)).find(
      (candidate) => candidate.slug.toLowerCase() === normalizedSlug,
    );
    return event === undefined ? null : clone(event);
  }

  async saveEvent(event: Event, expectedVersion: number | null): Promise<void> {
    const existingRaw = await this.#events.find(event.id);
    const existing = existingRaw === undefined ? undefined : eventRecord(existingRaw);
    if (
      (existing?.version ?? null) !== expectedVersion ||
      (existing !== undefined && existing.organizationId !== event.organizationId)
    ) {
      throw new EventRepositoryConflictError();
    }
    const stored = clone(event) as unknown as JsonRecord;
    if (existing === undefined) {
      await this.#events.create(stored);
    } else {
      await this.#events.update(event.id, stored);
    }
  }

  async appendAudit(entry: EventAuditEntry): Promise<void> {
    const stored = tagged(clone(entry) as unknown as JsonRecord, "event_audit");
    const existing = await this.#audit.find(entry.id);
    if (existing === undefined) await this.#audit.create(stored);
    else await this.#audit.update(entry.id, stored);
  }

  async listAudit(organizationId: string, eventId: string): Promise<readonly EventAuditEntry[]> {
    return (await this.#audit.list())
      .filter(
        (entry) =>
          entityType(entry) === "event_audit" &&
          resolvedOrganizationId(entry) === organizationId &&
          eventReference(entry) === eventId,
      )
      .map((entry) => {
        const { entityType: _kind, ...audit } = entry;
        return clone(audit as unknown as EventAuditEntry);
      });
  }
}

export class AirtableCfpRepository implements CfpRepository {
  readonly #events: AirtableJsonStore<EventCfp>;
  readonly #forms: AirtableJsonStore<CfpForm>;
  readonly #submissions: AirtableJsonStore<Submission>;
  readonly #audits: AirtableJsonStore<AuditEntry & { id: string }>;
  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
  }) {
    const shared = { baseId: options.baseId, transport: options.transport };
    this.#events = new AirtableJsonStore({
      ...shared,
      table: "Events",
      jsonField: "Settings JSON",
      indexedFields: EVENT_INDEXED_FIELDS,
    });
    this.#forms = new AirtableJsonStore({
      ...shared,
      table: "CFP Forms",
      jsonField: "Fields JSON",
    });
    this.#submissions = new AirtableJsonStore({
      ...shared,
      table: "Submissions",
      jsonField: "Answers JSON",
      decode: decodeCfpSubmission,
    });
    this.#audits = new AirtableJsonStore({
      ...shared,
      table: "Audit Records",
      jsonField: "Changes JSON",
    });
  }

  async getEvent(tenantId: string, eventId: string): Promise<EventCfp | null> {
    const raw = await this.#events.find(eventId);
    if (raw === undefined) return null;
    const event = cfpEventFromRecord(raw as unknown as JsonRecord);
    return event.tenantId === tenantId ? event : null;
  }

  async getEventBySlug(tenantId: string, eventSlug: string): Promise<EventCfp | null> {
    const records = await this.#events.list();
    const event = records
      .map((record) => cfpEventFromRecord(record as unknown as JsonRecord))
      .find((candidate) => candidate.tenantId === tenantId && candidate.slug === eventSlug);
    return event ?? null;
  }

  async saveEvent(event: EventCfp, expectedVersion: number | null): Promise<void> {
    const existingRaw = await this.#events.find(event.id);
    const existing =
      existingRaw === undefined
        ? undefined
        : cfpEventFromRecord(existingRaw as unknown as JsonRecord);
    if (existing === undefined || existingRaw === undefined) {
      throw new CfpError("NOT_FOUND", "The event was not found.");
    }
    if (existing.version !== expectedVersion || existing.tenantId !== event.tenantId) {
      throw new CfpError("CONFLICT", "The event CFP configuration has changed.");
    }
    if (isCanonicalEventRecord(existingRaw as unknown as JsonRecord)) {
      const canonical = eventRecord(existingRaw as unknown as JsonRecord);
      const updated: Event = {
        ...canonical,
        version: event.version,
        cfpSettings: {
          ...canonical.cfpSettings,
          enabled: true,
          opensAt: event.opensAt,
          closesAt: event.closesAt,
        },
      };
      await this.#events.update(event.id, updated as unknown as EventCfp);
    } else {
      await this.#events.update(event.id, {
        ...(existingRaw as unknown as JsonRecord),
        version: event.version,
        opensAt: event.opensAt,
        closesAt: event.closesAt,
      } as unknown as EventCfp);
    }
  }

  async getForm(tenantId: string, formId: string): Promise<CfpForm | null> {
    const form = await this.#forms.find(formId);
    return form !== undefined && form.tenantId === tenantId ? untagged(form) : null;
  }
  async listFormsByIds(ids: readonly string[]): Promise<readonly CfpForm[]> {
    const forms = await listApplicationIdsInBatches(this.#forms, ids);
    return forms.map((form) => untagged(form));
  }

  async listForms(tenantId: string, eventId: string): Promise<CfpForm[]> {
    return (await this.#forms.list())
      .filter((form) => form.tenantId === tenantId && form.eventId === eventId)
      .map((form) => untagged(form));
  }

  async saveForm(form: CfpForm, expectedVersion: number | null): Promise<void> {
    const existing = await this.#forms.find(form.id);
    if (
      (existing?.version ?? null) !== expectedVersion ||
      (existing && existing.tenantId !== form.tenantId)
    ) {
      throw new CfpError("CONFLICT", "The CFP form has changed.");
    }
    if (existing === undefined) await this.#forms.create(form);
    else await this.#forms.update(form.id, form);
  }

  async getSubmission(tenantId: string, submissionId: string): Promise<Submission | null> {
    const submission = await this.#submissions.find(submissionId);
    return submission !== undefined &&
      !isSpeakerSubmissionRecord(submission) &&
      submission.tenantId === tenantId
      ? untagged(submission)
      : null;
  }
  async listSubmissionsByIds(ids: readonly string[]): Promise<readonly Submission[]> {
    const submissions = await listApplicationIdsInBatches(this.#submissions, ids);
    return submissions
      .filter((submission) => !isSpeakerSubmissionRecord(submission))
      .map((submission) => untagged(submission));
  }
  async listSubmissionsForEvent(tenantId: string, eventId: string): Promise<Submission[]> {
    const byId = new Map<string, Submission>();
    for (const submission of await this.#submissions.list()) {
      if (
        submission.formId === undefined ||
        submission.tenantId !== tenantId ||
        submission.eventId !== eventId ||
        isSpeakerSubmissionRecord(submission)
      ) {
        continue;
      }
      const current = byId.get(submission.id);
      if (
        current === undefined ||
        submission.version > current.version ||
        (submission.version === current.version &&
          (submission.updatedAt ?? "").localeCompare(current.updatedAt ?? "") > 0)
      ) {
        byId.set(submission.id, submission);
      }
    }
    return [...byId.values()].map((submission) => untagged(submission));
  }
  async getOrganizerSubmissionsReadModel(
    tenantId: string,
    eventId: string,
  ): Promise<CfpOrganizerSubmissionsReadModel> {
    const [submissions, forms] = await Promise.all([
      this.listSubmissionsForEvent(tenantId, eventId),
      this.#forms.list(),
    ]);
    return {
      submissions,
      forms: forms.map((form) => untagged(form)),
    };
  }

  async countOwnedSubmissions(input: {
    tenantId: string;
    eventId: string;
    formId: string;
    ownerAccountId: string;
  }): Promise<number> {
    return (await this.#submissions.list()).filter(
      (submission) =>
        submission.tenantId === input.tenantId &&
        submission.eventId === input.eventId &&
        submission.formId === input.formId &&
        submission.ownerAccountId === input.ownerAccountId &&
        submission.status !== "withdrawn",
    ).length;
  }

  async saveSubmissionVersion(
    version: SubmissionVersion,
    expectedVersion: number | null,
    audit?: AuditEntry,
  ): Promise<void> {
    const currentRecord = await this.#submissions.findWithRecordId(version.submission.id);
    const current = currentRecord?.entity;
    if (
      (current?.version ?? null) !== expectedVersion ||
      (current !== undefined && current.tenantId !== version.submission.tenantId)
    ) {
      throw new CfpError("CONFLICT", "The CFP submission has changed.");
    }
    if (currentRecord === undefined) await this.#submissions.create(version.submission);
    else {
      await this.#submissions.updateByRecordId(
        version.submission.id,
        currentRecord.recordId,
        version.submission,
      );
    }

    if (audit !== undefined) {
      const auditRecord = {
        ...audit,
        id: `${audit.submissionId}:${audit.occurredAt}`,
      };
      const existingAudit = await this.#audits.find(auditRecord.id);
      if (existingAudit === undefined) await this.#audits.create(auditRecord);
    }
  }
}

function assertAirtableAssignmentWriteAdmission(
  plan: EvaluationPlan,
  scope: EvaluationAssignmentScope,
  authorizedAt: string,
  requireRoundOpen: boolean,
  allowClosed = false,
): void {
  if (allowClosed) return;
  const round = plan.rounds.find((candidate) => candidate.id === scope.roundId);
  const timestamp = Date.parse(authorizedAt);
  if (
    round === undefined ||
    !Number.isFinite(timestamp) ||
    plan.status !== "open" ||
    (plan.closesAt !== null && Date.parse(plan.closesAt) <= timestamp) ||
    (requireRoundOpen && round.opensAt != null && Date.parse(round.opensAt) > timestamp) ||
    (round.closesAt != null && Date.parse(round.closesAt) <= timestamp)
  ) {
    throw conflict("The evaluation plan is closed.");
  }
}

function evaluationAssignmentMatchesScope(
  assignment: EvaluationAssignment,
  scope: EvaluationAssignmentScope,
): boolean {
  return (
    assignment.tenantId === scope.tenantId &&
    assignment.eventId === scope.eventId &&
    assignment.planId === scope.planId &&
    assignment.roundId === scope.roundId &&
    (scope.submissionId === undefined || assignment.submissionId === scope.submissionId)
  );
}

function assertEvaluationVersion(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw conflict(`${label} changed since it was loaded.`);
}

function evaluationReviewHistory(
  reviews: readonly EvaluationReview[],
  assignment: EvaluationAssignment,
): readonly EvaluationReviewHistory[] {
  const review = reviews.find((candidate) => candidate.assignmentId === assignment.id);
  return review === undefined ? [] : [{ assignment: clone(assignment), review: clone(review) }];
}

class AirtableEvaluationDataStore implements EvaluationRepository {
  readonly supportsAtomicPlanRevisionSync = false;
  readonly authority = "transactional" as const;
  readonly #plans: AirtableJsonStore<AirtableEvaluationPlanRecord>;
  readonly #assignments: AirtableJsonStore<EvaluationAssignment>;
  readonly #reviews: AirtableJsonStore<EvaluationReview>;
  readonly #suggestions: AirtableJsonStore<EvaluationSuggestion>;
  readonly #evaluations: AirtableJsonStore<JsonRecord>;
  readonly #conflicts: AirtableJsonStore<EvaluationConflictDeclaration>;
  readonly #decisions: AirtableJsonStore<EvaluationDecision>;
  readonly #suggestionListsInFlight = new Map<string, Promise<readonly EvaluationSuggestion[]>>();

  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
  }) {
    const shared = { baseId: options.baseId, transport: options.transport };
    this.#plans = new AirtableJsonStore({
      ...shared,
      table: "Review Plans",
      jsonField: "Rounds JSON",
    });
    this.#assignments = new AirtableJsonStore({
      ...shared,
      table: "Evaluations",
      jsonField: "Scores JSON",
    });
    this.#evaluations = new AirtableJsonStore<JsonRecord>({
      ...shared,
      table: "Evaluations",
      jsonField: "Scores JSON",
    });
    this.#reviews = new AirtableJsonStore({
      ...shared,
      table: "Evaluations",
      jsonField: "Scores JSON",
    });
    this.#suggestions = new AirtableJsonStore({
      ...shared,
      table: "Evaluations",
      jsonField: "Scores JSON",
    });
    this.#conflicts = new AirtableJsonStore({
      ...shared,
      table: "Evaluations",
      jsonField: "Scores JSON",
    });
    this.#decisions = new AirtableJsonStore({
      ...shared,
      table: "Decisions",
      jsonField: "Metadata JSON",
    });
  }

  async getPlan(tenantId: string, planId: string): Promise<EvaluationPlan | null> {
    const plan = await this.#plans.find(planId);
    return plan !== undefined && plan.tenantId === tenantId ? publicEvaluationPlan(plan) : null;
  }

  async getPlanScheduleState(
    tenantId: string,
    planId: string,
  ): Promise<EvaluationPlanScheduleState | null> {
    const plan = await this.getPlan(tenantId, planId);
    return plan === null
      ? null
      : {
          id: plan.id,
          tenantId: plan.tenantId,
          eventId: plan.eventId,
          predecessorPlanId: plan.predecessorPlanId,
          status: plan.status,
          closesAt: plan.closesAt,
          version: plan.version,
          updatedAt: plan.updatedAt,
          rounds: plan.rounds.map((round) => ({
            id: round.id,
            predecessorRoundId: round.predecessorRoundId,
            revision: round.revision ?? 1,
            opensAt: round.opensAt ?? null,
            closesAt: round.closesAt,
          })),
        };
  }

  async getPlanSuccessor(
    tenantId: string,
    eventId: string,
    predecessorPlanId: string,
  ): Promise<EvaluationPlan | null> {
    const plans = await this.listPlans(tenantId, eventId);
    return plans.find((plan) => plan.predecessorPlanId === predecessorPlanId) ?? null;
  }

  async listPlans(tenantId: string, eventId?: string): Promise<readonly EvaluationPlan[]> {
    const plans = await this.#plans.list({
      filterByFormula: jsonContainsAllFormula(
        "Rounds JSON",
        eventId === undefined ? [tenantId] : [tenantId, eventId],
      ),
    });
    return plans
      .filter(
        (plan) => plan.tenantId === tenantId && (eventId === undefined || plan.eventId === eventId),
      )
      .map((plan) => clone(publicEvaluationPlan(plan)));
  }

  async hasPendingPlanLineageRepair(): Promise<boolean> {
    return false;
  }

  async putPlan(plan: EvaluationPlan, expectedVersion: number | null): Promise<void> {
    const existingRecord = await this.#plans.findWithRecordId(plan.id);
    const existing = existingRecord?.entity;
    if (
      (existing?.version ?? null) !== expectedVersion ||
      (existing !== undefined && existing.tenantId !== plan.tenantId)
    ) {
      throw conflict("Evaluation plan changed since it was loaded.");
    }
    const stored: AirtableEvaluationPlanRecord = {
      ...clone(plan),
      ...(existing?.assignmentGenerationSnapshot === undefined
        ? {}
        : { assignmentGenerationSnapshot: existing.assignmentGenerationSnapshot }),
    };
    if (existingRecord === undefined) await this.#plans.create(stored);
    else await this.#plans.updateByRecordId(plan.id, existingRecord.recordId, stored);
  }

  async putPlanState(
    plan: EvaluationPlan,
    expectedVersion: number,
    scheduleSyncs: readonly EvaluationPlanScheduleSync[],
    revisionSyncPending = false,
    _revisionSyncToken?: string,
  ): Promise<void> {
    if (scheduleSyncs.length > 0 || revisionSyncPending) {
      throw conflict("Atomic review plan revision synchronization requires D1.");
    }
    await this.putPlan(plan, expectedVersion);
  }

  async putPlanSchedule(
    plan: EvaluationPlan,
    expectedVersion: number,
    scheduleSyncs: readonly EvaluationPlanScheduleSync[],
    revisionSyncPending = false,
    _revisionSyncToken?: string,
  ): Promise<void> {
    if (scheduleSyncs.length > 0 || revisionSyncPending) {
      throw conflict("Atomic review plan revision synchronization requires D1.");
    }
    await this.putPlan(plan, expectedVersion);
  }

  async reconcilePlanRevisionFamily(): Promise<void> {
    throw conflict("Review plan reconciliation requires the authoritative D1 runtime.");
  }

  async completePlanRevisionSync(): Promise<void> {
    throw conflict("Review plan reconciliation requires the authoritative D1 runtime.");
  }

  async beginPlanRevisionSync(): Promise<void> {
    throw conflict("Review plan reconciliation requires the authoritative D1 runtime.");
  }

  async resumePlanRevisionSync(): Promise<void> {
    throw conflict("Review plan reconciliation requires the authoritative D1 runtime.");
  }

  async getAssignment(
    tenantId: string,
    assignmentId: string,
  ): Promise<EvaluationAssignment | null> {
    const [storedAssignment, candidatePlans] = await Promise.all([
      this.#assignments.find(assignmentId),
      this.#plans.list(),
    ]);
    const row =
      storedAssignment !== undefined &&
      isEvaluationAssignmentRecord(storedAssignment) &&
      storedAssignment.tenantId === tenantId
        ? untagged(storedAssignment)
        : null;
    const plans = candidatePlans.filter((plan) => plan.tenantId === tenantId);
    if (row !== null && !plans.some((plan) => plan.id === row.planId)) {
      const rowPlan = await this.#plans.find(row.planId);
      if (rowPlan !== undefined && rowPlan.tenantId === tenantId) plans.push(rowPlan);
    }

    const snapshotPlans = plans.filter((plan) =>
      plan.assignmentGenerationSnapshot?.assignments.some(
        (assignment) => assignment.tenantId === tenantId && assignment.id === assignmentId,
      ),
    );
    if (snapshotPlans.length > 1) {
      throw conflict("Multiple evaluation plans contain the reviewer assignment.");
    }
    const snapshotPlan = snapshotPlans[0];
    if (snapshotPlan !== undefined) {
      return (
        overlayEvaluationAssignmentSnapshot(snapshotPlan, row === null ? [] : [row]).find(
          (assignment) => assignment.id === assignmentId,
        ) ?? null
      );
    }
    if (
      row !== null &&
      plans.some(
        (plan) => plan.id === row.planId && plan.assignmentGenerationSnapshot !== undefined,
      )
    ) {
      return null;
    }
    return row === null ? null : clone(row);
  }

  async listAssignments(
    tenantId: string,
    planId: string,
  ): Promise<readonly EvaluationAssignment[]> {
    const [plan, rows] = await Promise.all([this.#plans.find(planId), this.#assignments.list()]);
    const assignments = latestEvaluationAssignmentRows(rows, tenantId, planId);
    if (plan === undefined || plan.tenantId !== tenantId) return assignments;
    return overlayEvaluationAssignmentSnapshot(plan, assignments);
  }

  async replaceAssignment(
    scope: EvaluationAssignmentScope,
    input: EvaluationAssignmentReplacementInput,
  ): Promise<EvaluationAssignmentReplacementResult> {
    const [planRecord, records] = await Promise.all([
      this.#plans.findWithRecordId(scope.planId),
      this.#evaluations.listWithRecordIds(),
    ]);
    if (
      planRecord === undefined ||
      planRecord.entity.tenantId !== scope.tenantId ||
      planRecord.entity.eventId !== scope.eventId
    ) {
      throw conflict("Reviewer assignment replacement is outside its target scope.");
    }
    assertAirtableAssignmentWriteAdmission(planRecord.entity, scope, input.authorizedAt, true);
    const assignmentRows = latestEvaluationAssignmentRows(
      records.map(({ entity }) => entity),
      scope.tenantId,
      scope.planId,
    );
    const assignments = overlayEvaluationAssignmentSnapshot(planRecord.entity, assignmentRows);
    const reviews = records
      .filter(({ entity }) => isEvaluationReviewRecord(entity))
      .map(({ entity }) => untagged(entity as unknown as EvaluationReview));
    const oldAssignment = assignments.find(
      (assignment) =>
        assignment.tenantId === scope.tenantId && assignment.id === input.oldAssignmentId,
    );
    if (oldAssignment === undefined) {
      throw conflict("The reviewer assignment to replace was not found.");
    }
    if (!evaluationAssignmentMatchesScope(oldAssignment, scope)) {
      throw conflict("Reviewer assignment replacement is outside its target scope.");
    }
    if (oldAssignment.status === "superseded") {
      throw conflict("The reviewer assignment has already been superseded.");
    }
    assertEvaluationVersion(
      oldAssignment.version,
      input.expectedAssignmentVersion,
      "Reviewer assignment",
    );

    const successor = input.successorAssignment;
    if (
      successor.id === oldAssignment.id ||
      successor.status === "abstained" ||
      successor.status === "superseded" ||
      successor.reviewerId !== input.replacementReviewerId ||
      !evaluationAssignmentMatchesScope(successor, scope)
    ) {
      throw conflict("Reviewer assignment replacement is outside its target scope.");
    }
    if (input.reason.trim().length === 0) {
      throw conflict("A replacement reason is required.");
    }
    if (records.some(({ entity }) => entity.id === successor.id)) {
      throw conflict("The successor reviewer assignment already exists.");
    }

    const supersededAt = successor.updatedAt;
    const supersededAssignment: EvaluationAssignment = {
      ...clone(oldAssignment),
      status: "superseded",
      successorAssignmentId: successor.id,
      supersededReason: input.reason,
      lineage: {
        predecessorAssignmentId: oldAssignment.predecessorAssignmentId ?? null,
        successorAssignmentId: successor.id,
        reason: input.reason,
        supersededAt,
      },
      version: oldAssignment.version + 1,
      updatedAt: supersededAt,
    };
    const successorAssignment: EvaluationAssignment = {
      ...clone(successor),
      predecessorAssignmentId: oldAssignment.id,
      successorAssignmentId: null,
      supersededReason: null,
      lineage: {
        predecessorAssignmentId: oldAssignment.id,
        successorAssignmentId: null,
        reason: input.reason,
        supersededAt,
      },
    };

    const resultScope: EvaluationAssignmentScope = {
      ...scope,
      submissionId: scope.submissionId ?? oldAssignment.submissionId,
    };
    const assignmentsById = new Map(
      assignments.map((assignment) => [assignment.id, clone(assignment)]),
    );
    assignmentsById.set(supersededAssignment.id, clone(supersededAssignment));
    assignmentsById.set(successorAssignment.id, clone(successorAssignment));
    await this.#commitAssignmentGeneration(planRecord, [...assignmentsById.values()], supersededAt);

    return {
      scope: resultScope,
      replacedAssignment: clone(supersededAssignment),
      successorAssignment: clone(successorAssignment),
      activeAssignments: [...assignmentsById.values()]
        .filter(
          (assignment) =>
            evaluationAssignmentMatchesScope(assignment, resultScope) &&
            assignment.status !== "superseded",
        )
        .sort((left, right) => left.id.localeCompare(right.id)),
      history: evaluationReviewHistory(reviews, supersededAssignment),
    };
  }

  async applyAssignmentDistribution(
    scope: EvaluationAssignmentScope,
    input: EvaluationAssignmentDistributionInput,
  ): Promise<EvaluationAssignmentDistributionResult> {
    if (input.reason.trim().length === 0) {
      throw conflict("A distribution reason is required.");
    }

    const [planRecord, records] = await Promise.all([
      this.#plans.findWithRecordId(scope.planId),
      this.#evaluations.listWithRecordIds(),
    ]);
    if (
      planRecord === undefined ||
      planRecord.entity.tenantId !== scope.tenantId ||
      planRecord.entity.eventId !== scope.eventId
    ) {
      throw conflict("Reviewer assignment distribution is outside its target scope.");
    }
    assertAirtableAssignmentWriteAdmission(
      planRecord.entity,
      scope,
      input.authorizedAt,
      false,
      input.allowClosedCleanup === true,
    );
    const assignmentRows = latestEvaluationAssignmentRows(
      records.map(({ entity }) => entity),
      scope.tenantId,
      scope.planId,
    );
    const assignments = overlayEvaluationAssignmentSnapshot(planRecord.entity, assignmentRows);
    const assignmentsByStorageKey = new Map(
      assignments.map(
        (assignment) => [`${assignment.tenantId}\u0000${assignment.id}`, assignment] as const,
      ),
    );
    const reviews = records
      .filter(({ entity }) => isEvaluationReviewRecord(entity))
      .map(({ entity }) => untagged(entity as unknown as EvaluationReview));
    const scopedAssignments = assignments.filter((assignment) =>
      evaluationAssignmentMatchesScope(assignment, scope),
    );

    const expected = new Map<string, number>();
    for (const expectedVersion of input.expectedActiveVersions) {
      if (expected.has(expectedVersion.assignmentId)) {
        throw conflict("Expected reviewer assignment versions must be unique.");
      }
      expected.set(expectedVersion.assignmentId, expectedVersion.version);
    }

    const desired = [...input.assignments];
    const targetSubmissionIds = new Set(desired.map((assignment) => assignment.submissionId));
    for (const assignmentId of expected.keys()) {
      const assignment = scopedAssignments.find((candidate) => candidate.id === assignmentId);
      if (assignment !== undefined) targetSubmissionIds.add(assignment.submissionId);
    }
    const target = scopedAssignments.filter((assignment) =>
      targetSubmissionIds.has(assignment.submissionId),
    );
    const active = target.filter(
      (assignment) => assignment.status !== "superseded" && assignment.status !== "abstained",
    );
    if (
      expected.size !== active.length ||
      active.some(
        (assignment) =>
          expected.get(assignment.id) === undefined ||
          expected.get(assignment.id) !== assignment.version,
      ) ||
      [...expected.keys()].some(
        (assignmentId) => !active.some((assignment) => assignment.id === assignmentId),
      )
    ) {
      throw conflict("Reviewer assignments changed since the distribution was previewed.");
    }

    const desiredIds = new Set<string>();
    for (const assignment of desired) {
      if (
        assignment.status === "abstained" ||
        assignment.status === "superseded" ||
        !evaluationAssignmentMatchesScope(assignment, scope)
      ) {
        throw conflict("Reviewer assignment distribution is outside its target scope.");
      }
      if (desiredIds.has(assignment.id)) {
        throw conflict("Reviewer assignment distribution contains duplicates.");
      }
      desiredIds.add(assignment.id);

      const existing = assignmentsByStorageKey.get(`${scope.tenantId}\u0000${assignment.id}`);
      const collidingRecord = records.find(({ entity }) => entity.id === assignment.id);
      if (existing === undefined && collidingRecord !== undefined) {
        throw conflict("A reviewer assignment already exists outside the distribution scope.");
      }
      if (existing !== undefined) {
        if (!evaluationAssignmentMatchesScope(existing, scope)) {
          throw conflict("A reviewer assignment already exists outside the distribution scope.");
        }
        if (existing.status === "abstained") {
          throw conflict("A reviewer who declared a conflict cannot be reassigned.");
        }
        if (existing.status === "superseded") {
          throw conflict("A superseded reviewer assignment cannot be reused.");
        }
        if (
          existing.reviewerId !== assignment.reviewerId ||
          existing.version !== assignment.version
        ) {
          throw conflict("A reviewer assignment changed since the distribution was previewed.");
        }
      }
    }

    const desiredById = new Map(desired.map((assignment) => [assignment.id, assignment]));
    const supersededAssignments = active.filter((assignment) => !desiredById.has(assignment.id));
    const supersededAt =
      desired[0]?.updatedAt ?? active[0]?.updatedAt ?? planRecord.entity.updatedAt;
    const nextSuperseded = supersededAssignments.map(
      (assignment): EvaluationAssignment => ({
        ...clone(assignment),
        status: "superseded",
        successorAssignmentId: null,
        supersededReason: input.reason,
        lineage: {
          predecessorAssignmentId: assignment.predecessorAssignmentId ?? null,
          successorAssignmentId: null,
          reason: input.reason,
          supersededAt,
        },
        version: assignment.version + 1,
        updatedAt: supersededAt,
      }),
    );
    const nextAssignments = desired.map((assignment) => {
      const existing = assignmentsByStorageKey.get(`${scope.tenantId}\u0000${assignment.id}`);
      if (existing === undefined) return clone(assignment);
      return {
        ...clone(existing),
        ...clone(assignment),
        predecessorAssignmentId:
          assignment.predecessorAssignmentId ?? existing.predecessorAssignmentId,
        successorAssignmentId: assignment.successorAssignmentId ?? existing.successorAssignmentId,
        supersededReason: assignment.supersededReason ?? existing.supersededReason,
        lineage: assignment.lineage ?? existing.lineage,
      };
    });

    const resultAssignments = new Map(
      assignments.map((assignment) => [assignment.id, clone(assignment)]),
    );
    for (const assignment of [...nextSuperseded, ...nextAssignments]) {
      resultAssignments.set(assignment.id, clone(assignment));
    }
    await this.#commitAssignmentGeneration(
      planRecord,
      [...resultAssignments.values()],
      supersededAt,
    );
    const activeAssignments = [...resultAssignments.values()]
      .filter(
        (assignment) =>
          evaluationAssignmentMatchesScope(assignment, scope) &&
          assignment.status !== "superseded" &&
          targetSubmissionIds.has(assignment.submissionId),
      )
      .sort((left, right) => left.id.localeCompare(right.id));

    return {
      scope: clone(scope),
      activeAssignments,
      supersededAssignments: nextSuperseded.map(clone),
      history: nextSuperseded.flatMap((assignment) => evaluationReviewHistory(reviews, assignment)),
    };
  }

  async getReview(tenantId: string, assignmentId: string): Promise<EvaluationReview | null> {
    const review = await this.#reviews.find(`review:${assignmentId}`);
    return review !== undefined && isEvaluationReviewRecord(review) && review.tenantId === tenantId
      ? untagged(review)
      : null;
  }

  async listReviews(tenantId: string, planId: string): Promise<readonly EvaluationReview[]> {
    return (await this.#reviews.list())
      .filter(
        (review) =>
          isEvaluationReviewRecord(review) &&
          review.tenantId === tenantId &&
          review.planId === planId,
      )
      .map((review) => untagged(review));
  }
  async getSuggestion(
    tenantId: string,
    suggestionId: string,
  ): Promise<EvaluationSuggestion | null> {
    const suggestion = await this.#suggestions.find(suggestionId);
    return suggestion !== undefined &&
      isEvaluationSuggestionRecord(suggestion) &&
      suggestion.tenantId === tenantId
      ? untagged(suggestion)
      : null;
  }
  async listSuggestions(
    tenantId: string,
    planId: string,
  ): Promise<readonly EvaluationSuggestion[]> {
    const key = `${tenantId}\u0000${planId}`;
    const existing = this.#suggestionListsInFlight.get(key);
    if (existing !== undefined) return existing;

    const load = this.#suggestions
      .list({
        filterByFormula: jsonContainsAllFormula("Scores JSON", [tenantId, planId]),
      })
      .then((suggestions) =>
        suggestions
          .filter(
            (suggestion) =>
              isEvaluationSuggestionRecord(suggestion) &&
              suggestion.tenantId === tenantId &&
              suggestion.planId === planId,
          )
          .map((suggestion) => untagged(suggestion))
          .sort((left, right) => left.id.localeCompare(right.id)),
      );
    this.#suggestionListsInFlight.set(key, load);
    try {
      return await load;
    } finally {
      if (this.#suggestionListsInFlight.get(key) === load) {
        this.#suggestionListsInFlight.delete(key);
      }
    }
  }

  async putSuggestion(
    _suggestion: EvaluationSuggestion,
    _expectedVersion: number | null,
    _expectedSubmissionRevision?: number,
    _allowClosedPlan = false,
  ): Promise<void> {
    throw conflict("Evaluation review writes require the authoritative D1 runtime.");
  }

  async listReviewerWorkspaceRecords(
    tenantId: string,
    reviewerId: string,
    eventIds: readonly string[],
  ): Promise<ReviewerWorkspaceRecords> {
    const allowedEventIds = new Set(eventIds);
    if (allowedEventIds.size === 0) return { assignments: [], reviews: [] };
    const [records, planRecords] = await Promise.all([
      this.#evaluations.list({
        filterByFormula: reviewerWorkspaceFormula("Scores JSON", tenantId, reviewerId, [
          ...allowedEventIds,
        ]),
      }),
      this.#plans.list({
        filterByFormula: organizationScopeFormula("Rounds JSON", tenantId, [...allowedEventIds]),
      }),
    ]);
    const plans = planRecords.filter(
      (plan) => plan.tenantId === tenantId && allowedEventIds.has(plan.eventId),
    );
    const assignmentRows = latestEvaluationAssignmentRows(records, tenantId);
    const assignments = overlayEvaluationAssignmentSnapshots(plans, assignmentRows).filter(
      (assignment) =>
        assignment.tenantId === tenantId &&
        assignment.reviewerId === reviewerId &&
        allowedEventIds.has(assignment.eventId) &&
        assignment.status !== "superseded",
    );
    const reviewsByAssignment = new Map<string, EvaluationReview>();
    for (const record of records) {
      if (!isEvaluationReviewRecord(record)) continue;
      const review = untagged(record as unknown as EvaluationReview);
      if (
        review.tenantId !== tenantId ||
        review.reviewerId !== reviewerId ||
        !allowedEventIds.has(review.eventId)
      ) {
        continue;
      }
      const current = reviewsByAssignment.get(review.assignmentId);
      if (
        current === undefined ||
        review.version > current.version ||
        (review.version === current.version &&
          review.updatedAt.localeCompare(current.updatedAt) > 0)
      ) {
        reviewsByAssignment.set(review.assignmentId, clone(review));
      }
    }
    const activeAssignmentIds = new Set(assignments.map((assignment) => assignment.id));
    return {
      assignments,
      reviews: [...reviewsByAssignment.values()].filter((review) =>
        activeAssignmentIds.has(review.assignmentId),
      ),
    };
  }

  async listOrganizerWorkspaceRecords(
    tenantId: string,
    eventId: string,
  ): Promise<OrganizerWorkspaceRecords> {
    const [evaluationRecords, decisionRecords, planRecords] = await Promise.all([
      this.#evaluations.list({
        filterByFormula: jsonContainsAllFormula("Scores JSON", [tenantId, eventId]),
      }),
      this.#decisions.list({
        filterByFormula: jsonContainsAllFormula("Metadata JSON", [tenantId, eventId]),
      }),
      this.#plans.list({
        filterByFormula: jsonContainsAllFormula("Rounds JSON", [tenantId, eventId]),
      }),
    ]);
    const plans = planRecords.filter(
      (plan) => plan.tenantId === tenantId && plan.eventId === eventId,
    );
    const assignmentRows = latestEvaluationAssignmentRows(evaluationRecords, tenantId);
    const assignments = overlayEvaluationAssignmentSnapshots(plans, assignmentRows).filter(
      (assignment) => assignment.tenantId === tenantId && assignment.eventId === eventId,
    );
    const reviewsByAssignment = new Map<string, EvaluationReview>();
    const decisionsBySubmission = new Map<string, EvaluationDecision>();

    for (const record of evaluationRecords) {
      if (!isEvaluationReviewRecord(record)) continue;
      const review = untagged(record as unknown as EvaluationReview);
      if (review.tenantId !== tenantId || review.eventId !== eventId) {
        continue;
      }
      const current = reviewsByAssignment.get(review.assignmentId);
      if (
        current === undefined ||
        review.version > current.version ||
        (review.version === current.version &&
          review.updatedAt.localeCompare(current.updatedAt) > 0)
      ) {
        reviewsByAssignment.set(review.assignmentId, clone(review));
      }
    }

    for (const record of decisionRecords) {
      if (
        !isEvaluationDecisionRecord(record) ||
        resolvedOrganizationId(record) !== tenantId ||
        record.eventId !== eventId
      ) {
        continue;
      }
      const decision = untagged(record);
      const key = `${decision.planId}\u0000${decision.submissionId}`;
      const current = decisionsBySubmission.get(key);
      if (
        current === undefined ||
        decision.version > current.version ||
        (decision.version === current.version &&
          decision.updatedAt.localeCompare(current.updatedAt) > 0)
      ) {
        decisionsBySubmission.set(key, clone(decision));
      }
    }

    return {
      assignments: assignments.filter((assignment) => assignment.status !== "superseded"),
      reviews: [...reviewsByAssignment.values()],
      decisions: [...decisionsBySubmission.values()],
    };
  }

  async listOrganizerExportRecords(
    tenantId: string,
    eventId: string,
    planId: string,
  ): Promise<OrganizerWorkspaceRecords> {
    const records = await this.listOrganizerWorkspaceRecords(tenantId, eventId);
    return {
      assignments: records.assignments.filter((assignment) => assignment.planId === planId),
      reviews: records.reviews.filter((review) => review.planId === planId),
      decisions: records.decisions.filter((decision) => decision.planId === planId),
    };
  }

  async putReview(
    _review: EvaluationReview,
    _expectedVersion: number | null,
    _admission: EvaluationReviewWriteAdmission,
  ): Promise<void> {
    throw conflict("Evaluation review writes require the authoritative D1 runtime.");
  }

  async saveReviewDraft(
    _assignment: EvaluationAssignment,
    _expectedAssignmentVersion: number,
    _review: EvaluationReview,
    _expectedReviewVersion: number | null,
    _authorizedAt: string,
  ): Promise<void> {
    throw conflict("Evaluation review writes require the authoritative D1 runtime.");
  }

  async getConflict(
    tenantId: string,
    assignmentId: string,
  ): Promise<EvaluationConflictDeclaration | null> {
    const declaration = await this.#conflicts.find(`conflict:${assignmentId}`);
    return declaration !== undefined && declaration.tenantId === tenantId
      ? untagged(declaration)
      : null;
  }

  async abstainAssignment(
    assignment: EvaluationAssignment,
    expectedAssignmentVersion: number,
    declaration: EvaluationConflictDeclaration,
  ): Promise<void> {
    const current = await this.getAssignment(assignment.tenantId, assignment.id);
    if (current?.version !== expectedAssignmentVersion)
      throw conflict("Assignment changed since it was loaded.");
    if (await this.getConflict(assignment.tenantId, assignment.id)) {
      throw conflict("A conflict has already been declared for this assignment.");
    }
    await this.#upsertEvaluationEntities([
      tagged(assignment, "evaluation_assignment") as unknown as JsonRecord,
      tagged(
        { ...declaration, id: `conflict:${assignment.id}` },
        "evaluation_conflict",
      ) as unknown as JsonRecord,
    ]);
  }

  async submitReview(
    _assignment: EvaluationAssignment,
    _expectedAssignmentVersion: number,
    _review: EvaluationReview,
    _expectedReviewVersion: number,
    _authorizedAt: string,
  ): Promise<void> {
    throw conflict("Evaluation review writes require the authoritative D1 runtime.");
  }

  async getDecision(
    tenantId: string,
    planId: string,
    submissionId: string,
  ): Promise<EvaluationDecision | null> {
    const id = `decision:${planId}:${submissionId}`;
    const decision = await this.#decisions.find(id);
    return decision !== undefined && decision.tenantId === tenantId ? untagged(decision) : null;
  }

  async findPlanForTenant(tenantId: string, planId: string): Promise<EvaluationPlan | null> {
    return this.getPlan(tenantId, planId);
  }
  async findAssignmentForTenant(
    tenantId: string,
    assignmentId: string,
  ): Promise<EvaluationAssignment | null> {
    return this.getAssignment(tenantId, assignmentId);
  }

  async writeReview(_input: WriteEvaluationReview): Promise<void> {
    throw conflict("Evaluation review writes require the authoritative D1 runtime.");
  }

  async putDecision(_decision: EvaluationDecision, _expectedVersion: number | null): Promise<void> {
    throw conflict("Evaluation decision writes require the authoritative D1 runtime.");
  }

  async #commitAssignmentGeneration(
    planRecord: { readonly entity: EvaluationPlan },
    assignments: readonly EvaluationAssignment[],
    _updatedAt: string,
  ): Promise<void> {
    await this.#upsertEvaluationEntities(
      assignments.map(
        (assignment) => tagged(assignment, "evaluation_assignment") as unknown as JsonRecord,
      ),
    );
    await this.#plans.update(planRecord.entity.id, planRecord.entity);
  }

  async #upsertEvaluationEntities(entities: readonly JsonRecord[]): Promise<void> {
    for (const entity of entities) {
      const id = typeof entity.id === "string" ? entity.id : null;
      if (id === null) continue;
      const existing = await this.#evaluations.findWithRecordId(id);
      if (existing === undefined) {
        await this.#evaluations.create(entity);
      } else {
        await this.#evaluations.updateByRecordId(id, existing.recordId, entity);
      }
    }
  }
}

export class AirtableEvaluationProjectionStore implements EvaluationProjectionReader {
  readonly #repository: AirtableEvaluationDataStore;

  constructor(options: { readonly baseId: string; readonly transport: AirtableTransport }) {
    this.#repository = new AirtableEvaluationDataStore(options);
  }

  getPlan(tenantId: string, planId: string): Promise<EvaluationPlan | null> {
    return this.#repository.getPlan(tenantId, planId);
  }
  getPlanScheduleState(
    tenantId: string,
    planId: string,
  ): Promise<EvaluationPlanScheduleState | null> {
    return this.#repository.getPlanScheduleState(tenantId, planId);
  }
  getPlanSuccessor(
    tenantId: string,
    eventId: string,
    predecessorPlanId: string,
  ): Promise<EvaluationPlan | null> {
    return this.#repository.getPlanSuccessor(tenantId, eventId, predecessorPlanId);
  }
  listPlans(tenantId: string, eventId?: string): Promise<readonly EvaluationPlan[]> {
    return this.#repository.listPlans(tenantId, eventId);
  }
  getAssignment(tenantId: string, assignmentId: string): Promise<EvaluationAssignment | null> {
    return this.#repository.getAssignment(tenantId, assignmentId);
  }
  listAssignments(tenantId: string, planId: string): Promise<readonly EvaluationAssignment[]> {
    return this.#repository.listAssignments(tenantId, planId);
  }
  getReview(tenantId: string, assignmentId: string): Promise<EvaluationReview | null> {
    return this.#repository.getReview(tenantId, assignmentId);
  }
  listReviews(tenantId: string, planId: string): Promise<readonly EvaluationReview[]> {
    return this.#repository.listReviews(tenantId, planId);
  }
  getSuggestion(tenantId: string, suggestionId: string): Promise<EvaluationSuggestion | null> {
    return this.#repository.getSuggestion(tenantId, suggestionId);
  }
  listSuggestions(tenantId: string, planId: string): Promise<readonly EvaluationSuggestion[]> {
    return this.#repository.listSuggestions(tenantId, planId);
  }
  listReviewerWorkspaceRecords(
    tenantId: string,
    reviewerId: string,
    eventIds: readonly string[],
  ): Promise<ReviewerWorkspaceRecords> {
    return this.#repository.listReviewerWorkspaceRecords(tenantId, reviewerId, eventIds);
  }
  listOrganizerWorkspaceRecords(
    tenantId: string,
    eventId: string,
  ): Promise<OrganizerWorkspaceRecords> {
    return this.#repository.listOrganizerWorkspaceRecords(tenantId, eventId);
  }
  getConflict(
    tenantId: string,
    assignmentId: string,
  ): Promise<EvaluationConflictDeclaration | null> {
    return this.#repository.getConflict(tenantId, assignmentId);
  }
  getDecision(
    tenantId: string,
    planId: string,
    submissionId: string,
  ): Promise<EvaluationDecision | null> {
    return this.#repository.getDecision(tenantId, planId, submissionId);
  }
}

function submissionText(submission: Submission, ...keys: readonly string[]): string | null {
  const record = submission as unknown as JsonRecord;
  const answers = isRecord(record.answers) ? record.answers : {};
  for (const key of keys) {
    const answer = answers[key] ?? record[key];
    if (typeof answer === "string" && answer.trim().length > 0) return answer.trim();
  }
  return null;
}

function submissionParticipants(submission: Submission): readonly SubmissionParticipant[] {
  return Array.isArray(submission.participants) ? submission.participants : [];
}

function submissionTitle(submission: Submission): string {
  return (
    submissionText(submission, "title", "sessionTitle", "field-title", "Title") ?? submission.id
  );
}

function submissionAbstract(submission: Submission): string {
  return submissionText(submission, "abstract", "description", "field-abstract", "Abstract") ?? "";
}
export class AirtableSubmissionReviewSource
  implements SubmissionReviewSource, EvaluationSubmissionSource
{
  readonly #cfp: CfpRepository;
  readonly #cfpService: CfpService | undefined;

  constructor(cfp: CfpRepository, cfpService?: CfpService) {
    this.#cfp = cfp;
    this.#cfpService = cfpService;
  }

  async getSubmissionForReview(
    tenantId: string,
    eventId: string,
    submissionId: string,
  ): Promise<SubmissionReviewMaterial | null> {
    const submission = await this.#cfp.getSubmission(tenantId, submissionId);
    if (submission === null || submission.eventId !== eventId) return null;
    const form = await this.#cfp.getForm(tenantId, submission.formId);
    return this.toReviewMaterial(tenantId, eventId, submission, form);
  }

  async getSubmissionsForReview(
    tenantId: string,
    lookups: readonly SubmissionReviewLookup[],
  ): Promise<readonly SubmissionReviewMaterial[]> {
    const uniqueLookups = [
      ...new Map(
        lookups.map((lookup) => [`${lookup.eventId}\u0000${lookup.submissionId}`, lookup] as const),
      ).values(),
    ];
    if (uniqueLookups.length === 0) return [];
    const submissions = await Promise.all(
      uniqueLookups.map((lookup) => this.#cfp.getSubmission(tenantId, lookup.submissionId)),
    ).then((values) => values.filter((value): value is Submission => value !== null));
    const lookupKeys = new Set(
      uniqueLookups.map((lookup) => `${lookup.eventId}\u0000${lookup.submissionId}`),
    );
    const submissionsByKey = new Map<string, Submission>();
    for (const submission of submissions) {
      if (submission.tenantId !== tenantId) continue;
      const key = `${submission.eventId}\u0000${submission.id}`;
      if (!lookupKeys.has(key)) continue;
      const current = submissionsByKey.get(key);
      if (
        current === undefined ||
        submission.version > current.version ||
        (submission.version === current.version &&
          submission.updatedAt.localeCompare(current.updatedAt) > 0)
      ) {
        submissionsByKey.set(key, submission);
      }
    }
    const matchedSubmissions = [...submissionsByKey.values()];
    const formIds = [...new Set(matchedSubmissions.map((submission) => submission.formId))];
    const listFormsByIds = this.#cfp.listFormsByIds;
    const forms =
      listFormsByIds === undefined
        ? await Promise.all(formIds.map((formId) => this.#cfp.getForm(tenantId, formId))).then(
            (values) => values.filter((value): value is CfpForm => value !== null),
          )
        : await listFormsByIds.call(this.#cfp, formIds);
    const formsById = new Map<string, CfpForm>();
    for (const form of forms) {
      if (form.tenantId !== tenantId) continue;
      const current = formsById.get(form.id);
      if (current === undefined || form.version > current.version) {
        formsById.set(form.id, form);
      }
    }
    return uniqueLookups.flatMap((lookup) => {
      const submission = submissionsByKey.get(`${lookup.eventId}\u0000${lookup.submissionId}`);
      if (submission === undefined) return [];
      return [
        this.toReviewMaterial(
          tenantId,
          lookup.eventId,
          submission,
          formsById.get(submission.formId),
        ),
      ];
    });
  }

  private toReviewMaterial(
    tenantId: string,
    eventId: string,
    submission: Submission,
    form: CfpForm | undefined | null,
  ): SubmissionReviewMaterial {
    const answers = isRecord(submission.answers) ? submission.answers : {};
    const identityFieldIds =
      form?.submissionFields
        .filter((field) => field.kind === "email" || /email|name/iu.test(field.key))
        .flatMap((field) => [field.id, field.key]) ?? [];
    return {
      id: submission.id,
      tenantId,
      eventId,
      status: submission.status,
      title: submissionTitle(submission),
      abstract: submissionAbstract(submission),
      answers,
      identityFieldIds,
      participants: submissionParticipants(submission).map((participant) => ({
        id: participant.id,
        displayName: `${participant.firstName} ${participant.lastName}`.trim(),
        email: participant.email,
        biography: participant.biography,
      })),
      version: submission.version,
    };
  }

  async listSubmissionsForOrganizer(
    tenantId: string,
    eventId: string,
  ): Promise<readonly EvaluationSubmissionRecord[]> {
    const listSubmissionsForEvent = this.#cfp.listSubmissionsForEvent;
    if (listSubmissionsForEvent === undefined) return [];
    const submissions: Submission[] = await listSubmissionsForEvent.call(
      this.#cfp,
      tenantId,
      eventId,
    );
    return submissions.map((submission: Submission) => this.toAdminRecord(submission));
  }

  async reopenSubmission(
    tenantId: string,
    eventId: string,
    submissionId: string,
    input: {
      readonly organizerId: string;
      readonly expectedVersion: number;
      readonly reason: string;
      readonly idempotencyKey: string;
    },
  ): Promise<EvaluationSubmissionRecord> {
    if (this.#cfpService === undefined) {
      throw new Error("CFP reopen service is not configured.");
    }
    const submission = await this.#cfpService.reopen({
      tenantId,
      eventId,
      submissionId,
      organizerId: input.organizerId,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    return this.toAdminRecord(submission);
  }

  private toAdminRecord(submission: Submission): EvaluationSubmissionRecord {
    const answers = isRecord(submission.answers) ? submission.answers : {};
    return {
      id: submission.id,
      tenantId: submission.tenantId,
      eventId: submission.eventId,
      title: submissionTitle(submission),
      abstract: submissionAbstract(submission),
      answers,
      participants: submissionParticipants(submission).map((participant) => ({
        id: participant.id,
        displayName: `${participant.firstName} ${participant.lastName}`.trim(),
        email: participant.email,
        biography: participant.biography,
      })),
      status: submission.status,
      version: submission.version,
      submittedAt: submission.submittedAt ?? null,
      updatedAt: submission.updatedAt,
      reopenedAt: submission.reopenedAt ?? null,
    };
  }
}
function submissionAnswerValue(submission: Submission, ...keys: readonly string[]): unknown {
  const answers = isRecord(submission.answers) ? submission.answers : {};
  for (const key of keys) {
    if (answers[key] !== undefined) return answers[key];
  }
  return undefined;
}

function submissionAnswerText(submission: Submission, ...keys: readonly string[]): string {
  const value = submissionAnswerValue(submission, ...keys);
  return typeof value === "string" ? value.trim() : "";
}

function submissionAnswerIds(submission: Submission, ...keys: readonly string[]): string[] {
  const values: unknown[] = [];
  for (const key of keys) {
    const value = submissionAnswerValue(submission, key);
    if (Array.isArray(value)) values.push(...value);
    else if (value !== undefined) values.push(value);
  }
  return [
    ...new Set(
      values.flatMap((value) => {
        if (typeof value === "string") {
          const normalized = value.trim();
          return normalized.length === 0 ? [] : [normalized];
        }
        if (!isRecord(value)) return [];
        const id = value.id ?? value.value;
        return typeof id === "string" && id.trim().length > 0 ? [id.trim()] : [];
      }),
    ),
  ];
}

function taxonomyIds(
  explicitIds: readonly string[],
  labels: readonly string[],
  catalog: readonly { readonly id: string; readonly name: string }[],
): string[] {
  if (catalog.length === 0) return [...new Set(explicitIds)];
  const byId = new Map(catalog.map((item) => [item.id, item.id]));
  const byName = new Map(catalog.map((item) => [item.name.trim().toLocaleLowerCase(), item.id]));
  return [
    ...new Set([
      ...explicitIds.flatMap((value) => {
        const id = byId.get(value);
        return id === undefined ? [] : [id];
      }),
      ...labels.flatMap((value) => {
        const id = byName.get(value.trim().toLocaleLowerCase());
        return id === undefined ? [] : [id];
      }),
    ]),
  ];
}

function submissionDurationMinutes(submission: Submission): number {
  const value = submissionAnswerValue(
    submission,
    "durationMinutes",
    "duration",
    "sessionDuration",
    "length",
  );
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_440) {
    return value;
  }
  if (typeof value === "string") {
    const match = /(\d{1,4})/u.exec(value);
    const parsed = match === null ? NaN : Number(match[1]);
    if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1_440) return parsed;
  }
  return 30;
}

function sessionsDiffer(left: Session, right: Session): boolean {
  return (
    left.title !== right.title ||
    left.description !== right.description ||
    left.status !== right.status ||
    left.durationMinutes !== right.durationMinutes ||
    left.capacityRequired !== right.capacityRequired ||
    left.roomId !== right.roomId ||
    left.formatId !== right.formatId ||
    left.levelId !== right.levelId ||
    left.trackId !== right.trackId ||
    JSON.stringify(left.trackIds) !== JSON.stringify(right.trackIds) ||
    JSON.stringify(left.tagIds) !== JSON.stringify(right.tagIds) ||
    JSON.stringify(left.speakerIds) !== JSON.stringify(right.speakerIds) ||
    JSON.stringify(left.speakerRoster) !== JSON.stringify(right.speakerRoster) ||
    JSON.stringify(left.resourceIds) !== JSON.stringify(right.resourceIds)
  );
}
interface EvaluationAcceptanceSpeakerRepository extends SpeakerRepository {
  ensureProfile?(
    input: {
      readonly eventId: string;
      readonly participant: SubmissionParticipant;
      readonly updatedAt: string;
      readonly organizationId?: string;
    },
    decisionFence?: SpeakerDecisionWriteFence,
  ): Promise<SpeakerProfile>;
  ensureProfileTask?(input: {
    readonly eventId: string;
    readonly submissionId: string;
    readonly participantId: string;
    readonly updatedAt: string;
  }): Promise<SpeakerTask>;
}

export class AirtableEvaluationAcceptanceHandoff implements EvaluationAcceptanceHandoff {
  readonly #cfp: CfpRepository;
  readonly #speakers: EvaluationAcceptanceSpeakerRepository;
  readonly #database: D1Database;
  readonly #sessions: SessionRepository;
  readonly #sessionService: SessionService | undefined;
  readonly #queue: Queue<CloudflareOutboxMessage>;
  readonly #invitationCreator: RuntimeEventRoleInvitationAdapters["speakerCreator"];

  constructor(options: {
    readonly cfp: CfpRepository;
    readonly speakers: EvaluationAcceptanceSpeakerRepository;
    readonly sessions: SessionRepository;
    readonly database: D1Database;
    readonly sessionService?: SessionService;
    readonly queue: Queue<CloudflareOutboxMessage>;
    readonly invitationCreator?: RuntimeEventRoleInvitationAdapters["speakerCreator"];
  }) {
    this.#cfp = options.cfp;
    this.#speakers = options.speakers;
    this.#database = options.database;
    this.#queue = options.queue;
    this.#sessions = options.sessions;
    this.#sessionService = options.sessionService;
    this.#invitationCreator =
      options.invitationCreator ??
      createRuntimeEventRoleInvitationAdapters(
        new D1EventRoleInvitationRepository(options.database),
      ).speakerCreator;
  }

  async accept(input: EvaluationAcceptanceHandoffInput): Promise<void> {
    const idempotency = new D1IdempotencyStore(this.#database);
    const scope = `${input.tenantId}:evaluation-acceptance`;
    const transitionKey = input.idempotencyKey.trim();
    const key = `acceptance:${input.submissionId}:${transitionKey}`;
    const isCurrentDecision = input.isCurrentDecision ?? (async () => true);
    let acceptedSubmission: Submission | undefined;
    await idempotency.run(scope, key, async () => {
      if (!(await isCurrentDecision())) return { accepted: false };
      const submission = await this.#cfp.getSubmission(input.tenantId, input.submissionId);
      if (submission === null || submission.eventId !== input.eventId) {
        throw new Error("The accepted submission was not found for the event.");
      }
      if (submission.participants.length === 0) {
        throw new Error("An accepted submission must contain at least one speaker.");
      }
      acceptedSubmission = submission;
      const session = await this.#ensureCanonicalSession(input, submission).catch(
        (error: unknown) => {
          throw new Error("Accepted session projection failed.", { cause: error });
        },
      );
      if (!(await isCurrentDecision())) return { accepted: false };
      const profiles = await Promise.all(
        submission.participants.map(async (participant) => {
          const profile = await this.#ensureProfile(input, participant);
          if (!(await isCurrentDecision())) return profile.id;
          await this.#ensureProfileTask(input, participant.id);
          return profile.id;
        }),
      ).catch((error: unknown) => {
        throw new Error("Accepted speaker onboarding failed.", { cause: error });
      });
      if (!(await isCurrentDecision())) return { accepted: false };

      await Promise.all([
        this.#database
          .prepare(
            `INSERT INTO audit_events
               (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id,
                trace_id, details_json, occurred_at)
             SELECT ?, ?, 'user', ?, 'evaluation_accepted', 'submission', ?, NULL, ?, ?
             WHERE EXISTS (
               SELECT 1
               FROM evaluation_decisions
               WHERE organization_id = ?
                 AND event_id = ?
                 AND plan_id = ?
                 AND submission_id = ?
                 AND version = ?
                 AND status = 'accepted'
             )
             ON CONFLICT (id) DO NOTHING`,
          )
          .bind(
            `evaluation-accepted:${input.submissionId}:${transitionKey}`,
            input.tenantId,
            input.decidedBy,
            input.submissionId,
            JSON.stringify({
              planId: input.planId,
              decisionId: input.decisionId,
              reason: input.reason,
              idempotencyKey: input.idempotencyKey,
              profileIds: profiles,
              sessionId: session.id,
            }),
            input.decidedAt,
            input.tenantId,
            input.eventId,
            input.planId,
            input.submissionId,
            input.decisionVersion,
          )
          .run(),
        this.#enqueue(
          input,
          "cache-invalidation",
          `evaluation-projection:${input.eventId}:${input.submissionId}:${transitionKey}`,
          { eventId: input.eventId },
        ),
      ]);
      return { accepted: true };
    });

    const submission =
      acceptedSubmission ?? (await this.#cfp.getSubmission(input.tenantId, input.submissionId));
    if (submission === null || submission.eventId !== input.eventId) return;
    if (!(await isCurrentDecision())) return;
    await this.#ensureSpeakerInvitations(input, submission);
  }

  async reconcileSessionDecision(
    input: EvaluationSessionDecisionReconciliationInput,
  ): Promise<void> {
    const isCurrentDecision = async (): Promise<boolean> => {
      const current = await this.#database
        .prepare(
          `SELECT version, status
           FROM evaluation_decisions
           WHERE organization_id = ?1
             AND event_id = ?2
             AND plan_id = ?3
             AND submission_id = ?4
           LIMIT 1`,
        )
        .bind(input.tenantId, input.eventId, input.planId, input.submissionId)
        .first<{ version: number; status: string }>();
      return (
        current !== null &&
        current.version === input.decisionVersion &&
        current.status === input.status
      );
    };
    if (!(await isCurrentDecision())) return;
    const reconciliationInput = {
      tenantId: input.tenantId,
      eventId: input.eventId,
      sessionId: `session-${input.submissionId}`,
      status: input.status,
      actorId: input.decidedBy,
      isCurrentDecision,
      decisionFence: input.decisionFence,
    } as const;
    if (this.#sessionService !== undefined) {
      await this.#sessionService.reconcileDecisionSessionStatus(reconciliationInput);
      return;
    }
    const current = await this.#sessions.getSession(
      input.tenantId,
      input.eventId,
      reconciliationInput.sessionId,
    );
    if (current === null || !(await isCurrentDecision())) return;
    const next: Session = {
      ...current,
      status: input.status === "rejected" ? "Rejected" : "Waitlisted",
      version: current.version + 1,
      updatedAt: input.decidedAt,
      updatedBy: input.decidedBy,
      history: [
        ...current.history,
        {
          id: `${current.id}:v${current.version + 1}`,
          action: "updated",
          version: current.version + 1,
          actorId: input.decidedBy,
          occurredAt: input.decidedAt,
        },
      ],
    };
    await this.#sessions.putSession(next, current.version, input.decisionFence);
  }

  async #ensureProfile(
    input: EvaluationAcceptanceHandoffInput,
    participant: SubmissionParticipant,
  ): Promise<SpeakerProfile> {
    const ensureProfile = this.#speakers.ensureProfile;
    if (ensureProfile !== undefined) {
      return ensureProfile.call(
        this.#speakers,
        {
          eventId: input.eventId,
          participant,
          organizationId: input.tenantId,
          updatedAt: input.decidedAt,
        },
        input.decisionFence,
      );
    }
    const existing = await this.#speakers.getProfile(input.eventId, participant.id);
    if (existing !== null) return existing;
    const profile: SpeakerProfile = {
      id: `speaker-profile:${input.eventId}:${participant.id}`,
      eventId: input.eventId,
      participantId: participant.id,
      displayName: `${participant.firstName} ${participant.lastName}`.trim(),
      ...(participant.email.trim().length === 0
        ? {}
        : { email: participant.email.trim().toLowerCase() }),
      biography: participant.biography,
      status: "accepted",
      version: 1,
      updatedAt: input.decidedAt,
    };
    const created = await this.#speakers.createProfile?.(profile, input.decisionFence);
    if (created?.ok === true) return created.value;
    throw new Error("The accepted speaker profile could not be persisted.");
  }

  async #ensureProfileTask(
    input: EvaluationAcceptanceHandoffInput,
    participantId: string,
  ): Promise<void> {
    const ensureProfileTask = this.#speakers.ensureProfileTask;
    if (ensureProfileTask !== undefined) {
      await ensureProfileTask.call(this.#speakers, {
        eventId: input.eventId,
        submissionId: input.submissionId,
        participantId,
        updatedAt: input.decidedAt,
      });
      return;
    }
    const id = `speaker-task:${input.eventId}:${input.submissionId}:${participantId}:profile`;
    if ((await this.#speakers.getTask(input.eventId, id)) !== null) return;
    const task: SpeakerTask = {
      id,
      eventId: input.eventId,
      submissionId: input.submissionId,
      participantId,
      type: "form",
      owner: "speaker",
      title: "Complete your speaker profile",
      description: "Review your public name and biography before the program is published.",
      status: "not_started",
      dependencyIds: [],
      reminderOffsetsMinutes: [10080, 1440],
      version: 1,
      updatedAt: input.decidedAt,
    };
    const createTask = this.#speakers.createTask;
    if (createTask === undefined) {
      throw new Error("The accepted speaker profile task repository is not configured.");
    }
    const created = await createTask.call(this.#speakers, {
      task,
      expectedVersion: null,
      actorAccountId: input.decidedBy,
      ...(input.decisionFence === undefined ? {} : { decisionFence: input.decisionFence }),
    });
    if (!created.ok) throw new Error("The accepted speaker profile task was not persisted.");
  }

  async #ensureCanonicalSession(
    input: EvaluationAcceptanceHandoffInput,
    submission: Submission,
  ): Promise<Session> {
    const id = `session-${submission.id}`;
    const current = await this.#sessions.getSession(input.tenantId, input.eventId, id);
    const isCurrentDecision = input.isCurrentDecision ?? (async () => true);
    const formatIds = submissionAnswerIds(submission, "formatId");
    const formatLabels = submissionAnswerIds(submission, "format");
    const trackIdsFromAnswers = submissionAnswerIds(submission, "trackIds", "trackId");
    const trackLabels = submissionAnswerIds(submission, "tracks", "track");
    const tagIdsFromAnswers = submissionAnswerIds(submission, "tagIds");
    const tagLabels = submissionAnswerIds(submission, "tags", "tag");
    const levelIds = submissionAnswerIds(submission, "levelId");
    const levelLabels = submissionAnswerIds(submission, "level", "audience_level");
    const [tracks, formats, tags, levels] = await Promise.all([
      this.#sessions.listTracks(input.tenantId, input.eventId),
      this.#sessions.listFormats(input.tenantId, input.eventId),
      this.#sessions.listTags(input.tenantId, input.eventId),
      this.#sessions.listLevels(input.tenantId, input.eventId),
    ]);
    const resolvedTrackIds = taxonomyIds(trackIdsFromAnswers, trackLabels, tracks);
    const resolvedTagIds = taxonomyIds(tagIdsFromAnswers, tagLabels, tags);
    const resolvedFormatIds = taxonomyIds(formatIds, formatLabels, formats);
    const resolvedLevelIds = taxonomyIds(levelIds, levelLabels, levels);
    const trackIds =
      resolvedTrackIds.length > 0
        ? resolvedTrackIds
        : [...(current?.trackIds ?? (current?.trackId === undefined ? [] : [current.trackId]))];
    const tagIds = resolvedTagIds.length > 0 ? resolvedTagIds : [...(current?.tagIds ?? [])];
    const formatId = resolvedFormatIds[0] ?? current?.formatId;
    const levelId = resolvedLevelIds[0] ?? current?.levelId;
    const durationAnswer = submissionAnswerValue(
      submission,
      "durationMinutes",
      "duration",
      "sessionDuration",
      "length",
    );
    const durationMinutes =
      durationAnswer === undefined
        ? (current?.durationMinutes ?? 30)
        : submissionDurationMinutes(submission);
    const title =
      submissionText(submission, "title", "sessionTitle", "name", "field-title", "Title") ??
      current?.title ??
      id;
    const description =
      submissionAnswerText(submission, "abstract", "description", "sessionAbstract", "summary") ||
      current?.description ||
      "";
    const speakerIds = submission.participants.map((participant) => participant.id);
    const speakerRoster: readonly SessionSpeakerReference[] = submission.participants.map(
      (participant) => ({
        id: participant.id,
        displayName:
          `${participant.firstName.trim()} ${participant.lastName.trim()}`.trim() || participant.id,
        role: participant.role,
      }),
    );
    const base: Session = {
      id,
      tenantId: input.tenantId,
      eventId: input.eventId,
      title,
      description,
      status: "Accepted",
      durationMinutes,
      capacityRequired: current?.capacityRequired ?? 0,
      ...(current?.roomId === undefined ? {} : { roomId: current.roomId }),
      ...(trackIds[0] === undefined ? {} : { trackId: trackIds[0] }),
      trackIds,
      ...(formatId === undefined ? {} : { formatId }),
      ...(levelId === undefined ? {} : { levelId }),
      tagIds,
      speakerIds,
      speakerRoster,
      resourceIds: [...(current?.resourceIds ?? [])],
      version: current?.version ?? 1,
      createdAt: current?.createdAt ?? input.decidedAt,
      updatedAt: input.decidedAt,
      createdBy: current?.createdBy ?? input.decidedBy,
      updatedBy: current?.updatedBy ?? input.decidedBy,
      history: [...(current?.history ?? [])],
    };
    if (!(await isCurrentDecision())) return current ?? base;
    if (this.#sessionService !== undefined) {
      return this.#sessionService.upsertAcceptedSession({
        session: base,
        actorId: input.decidedBy,
        ...(input.isCurrentDecision === undefined
          ? {}
          : { beforePersist: input.isCurrentDecision }),
        decisionFence: input.decisionFence,
      });
    }
    if (current === null) {
      const created: Session = {
        ...base,
        version: 1,
        createdAt: input.decidedAt,
        updatedAt: input.decidedAt,
        createdBy: input.decidedBy,
        updatedBy: input.decidedBy,
        history: [
          {
            id: `${id}:v1`,
            action: "created",
            version: 1,
            actorId: input.decidedBy,
            occurredAt: input.decidedAt,
          },
        ],
      };
      await this.#sessions.putSession(created, null, input.decisionFence);
      await this.#sessions.appendAudit({
        id: `${id}:v1`,
        tenantId: input.tenantId,
        eventId: input.eventId,
        entityType: "session",
        entityId: id,
        action: "created",
        version: 1,
        actorId: input.decidedBy,
        occurredAt: input.decidedAt,
        after: clone(created),
      });
      return created;
    }
    if (!sessionsDiffer(current, base)) return current;
    const nextVersion = current.version + 1;
    const updated: Session = {
      ...base,
      version: nextVersion,
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      updatedAt: input.decidedAt,
      updatedBy: input.decidedBy,
      history: [
        ...current.history,
        {
          id: `${id}:v${nextVersion}`,
          action: "updated",
          version: nextVersion,
          actorId: input.decidedBy,
          occurredAt: input.decidedAt,
        },
      ],
    };
    await this.#sessions.putSession(updated, current.version, input.decisionFence);
    await this.#sessions.appendAudit({
      id: `${id}:v${nextVersion}`,
      tenantId: input.tenantId,
      eventId: input.eventId,
      entityType: "session",
      entityId: id,
      action: "updated",
      version: nextVersion,
      actorId: input.decidedBy,
      occurredAt: input.decidedAt,
      before: clone(current),
      after: clone(updated),
    });
    return updated;
  }

  async #ensureSpeakerInvitations(
    input: EvaluationAcceptanceHandoffInput,
    submission: Submission,
  ): Promise<void> {
    await Promise.all(
      submission.participants.map(async (participant) => {
        const email = participant.email.trim().toLowerCase();
        if (email.length === 0) return;
        const users = await this.#database
          .prepare(
            `SELECT id
               FROM auth_users
              WHERE email = ? COLLATE NOCASE AND email_verified = 1
              ORDER BY id
              LIMIT 2`,
          )
          .bind(email)
          .all<{ id: string }>();
        if ((users.results ?? []).length !== 1) return;
        const user = users.results[0];
        if (user === undefined) return;
        if (input.isCurrentDecision !== undefined && !(await input.isCurrentDecision())) return;
        await this.#invitationCreator.create({
          id: `event-role-invitation:speaker:${input.eventId}:${participant.id}`,
          organizationId: input.tenantId,
          eventId: input.eventId,
          role: "speaker",
          recipientUserId: user.id,
          normalizedEmail: email,
          participantId: participant.id,
          creationIdempotencyKey: `evaluation-acceptance:${input.submissionId}:${participant.id}`,
          invitedByActorType: "user",
          invitedByActorId: input.decidedBy,
          invitedAt: input.decidedAt,
          ...(input.decisionFence === undefined ? {} : { decisionFence: input.decisionFence }),
        });
      }),
    );
  }

  async #enqueue(
    input: EvaluationAcceptanceHandoffInput,
    topic: "communications" | "cache-invalidation",
    deduplicationKey: string,
    payload: unknown,
  ): Promise<void> {
    const jobId = `evaluation:${input.tenantId}:${topic}:${deduplicationKey}`;
    const now = input.decidedAt;
    const result = await this.#database
      .prepare(
        `INSERT INTO outbox_jobs
           (id, tenant_id, topic, deduplication_key, payload_json, state,
            attempt_count, available_at, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM evaluation_decisions
           WHERE organization_id = ?
             AND event_id = ?
             AND plan_id = ?
             AND submission_id = ?
             AND version = ?
             AND status = 'accepted'
         )
         ON CONFLICT (tenant_id, topic, deduplication_key) DO NOTHING`,
      )
      .bind(
        jobId,
        input.tenantId,
        topic,
        deduplicationKey,
        JSON.stringify(payload),
        now,
        now,
        now,
        input.tenantId,
        input.eventId,
        input.planId,
        input.submissionId,
        input.decisionVersion,
      )
      .run();
    const inserted = result.meta === undefined || result.meta.changes > 0;
    const state = inserted
      ? "pending"
      : (
          await this.#database
            .prepare("SELECT state FROM outbox_jobs WHERE id = ? LIMIT 1")
            .bind(jobId)
            .first<{ state: string }>()
        )?.state;
    if (state === "pending") {
      const current = await this.#database
        .prepare(
          `SELECT version, status
             FROM evaluation_decisions
            WHERE organization_id = ?
              AND event_id = ?
              AND plan_id = ?
              AND submission_id = ?
            LIMIT 1`,
        )
        .bind(input.tenantId, input.eventId, input.planId, input.submissionId)
        .first<{ version: number; status: EvaluationDecisionStatus }>();
      if (
        current === null ||
        current.version !== input.decisionVersion ||
        current.status !== "accepted"
      ) {
        return;
      }
      await this.#queue.send({
        version: 1,
        jobId,
        tenantId: input.tenantId,
        topic,
        enqueuedAt: now,
      });
      await this.#database
        .prepare(
          "UPDATE outbox_jobs SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'pending'",
        )
        .bind(now, jobId)
        .run();
    }
  }
}

type StoredAgendaState = AgendaState & {
  id: string;
};
interface StoredAgendaEntry {
  id: string;
  eventId: string;
  entry: AgendaEntry;
}
export class AirtableAgendaRepository {
  readonly #store: AirtableJsonStore<StoredAgendaState>;
  readonly #entries: AirtableJsonStore<StoredAgendaEntry>;
  readonly #loadedRecords = new Map<
    string,
    { readonly recordId: string | null; readonly stateVersion: number | null }
  >();

  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
  }) {
    this.#store = new AirtableJsonStore({
      baseId: options.baseId,
      table: "Agenda Versions",
      jsonField: "Conflicts JSON",
      transport: options.transport,
    });
    this.#entries = new AirtableJsonStore({
      baseId: options.baseId,
      table: "Agenda Entries",
      jsonField: "Metadata JSON",
      transport: options.transport,
    });
  }

  async load(eventId: string): Promise<AgendaState | null> {
    const stored = await this.#store.findWithRecordId(eventId);
    if (stored === undefined || stored.entity.eventId !== eventId) {
      this.#loadedRecords.set(eventId, { recordId: null, stateVersion: null });
      return null;
    }
    this.#loadedRecords.set(eventId, {
      recordId: stored.recordId,
      stateVersion: stored.entity.stateVersion,
    });
    const { id: _id, ...state } = stored.entity;
    return state;
  }

  async compareAndSwap(
    eventId: string,
    expectedStateVersion: number | null,
    nextState: AgendaState,
  ): Promise<void> {
    const cached = this.#loadedRecords.get(eventId);
    const current =
      cached?.stateVersion === expectedStateVersion
        ? cached
        : await this.#store.findWithRecordId(eventId).then((record) =>
            record === undefined
              ? { recordId: null, stateVersion: null }
              : {
                  recordId: record.recordId,
                  stateVersion: record.entity.stateVersion,
                },
          );
    if (current.stateVersion !== expectedStateVersion) {
      throw new AgendaRepositoryConflictError(eventId);
    }
    if (nextState.eventId !== eventId) {
      throw new TypeError(`Cannot save agenda ${nextState.eventId} under event ${eventId}.`);
    }
    const stored: StoredAgendaState = { ...nextState, id: eventId };
    await Promise.all([
      current.recordId === null
        ? this.#store.create(stored)
        : this.#store.updateByRecordId(eventId, current.recordId, stored),
      this.#synchronizeEntries(eventId, nextState.draft.entries),
    ]);
    if (current.recordId === null) {
      this.#loadedRecords.delete(eventId);
    } else {
      this.#loadedRecords.set(eventId, {
        recordId: current.recordId,
        stateVersion: nextState.stateVersion,
      });
    }
  }

  async #synchronizeEntries(eventId: string, entries: readonly AgendaEntry[]): Promise<void> {
    const existingEntries = (await this.#entries.listWithRecordIds()).filter(
      (entry) => entry.entity.eventId === eventId,
    );
    const nextEntries = new Map(
      entries.map((entry) => [
        `${eventId}:${entry.id}`,
        { id: `${eventId}:${entry.id}`, eventId, entry },
      ]),
    );
    const mutations: Array<Promise<unknown>> = [];

    for (const existing of existingEntries) {
      if (!nextEntries.has(existing.entity.id)) {
        mutations.push(this.#entries.deleteByRecordId(existing.recordId));
      }
    }
    for (const [id, entry] of nextEntries) {
      const existing = existingEntries.find((candidate) => candidate.entity.id === id);
      if (existing === undefined) {
        mutations.push(this.#entries.create(entry));
      } else if (JSON.stringify(existing.entity.entry) !== JSON.stringify(entry.entry)) {
        mutations.push(this.#entries.updateByRecordId(id, existing.recordId, entry));
      }
    }
    await Promise.all(mutations);
  }
}

/** Airtable-backed organization dashboard projection assembled from canonical records. */
export class AirtableOrganizerOverviewRepository implements OrganizerOverviewRouteDependencies {
  readonly #events: AirtableJsonStore<JsonRecord>;
  readonly #submissions: AirtableJsonStore<JsonRecord>;
  readonly #plans: AirtableJsonStore<JsonRecord>;
  readonly #evaluations: AirtableJsonStore<JsonRecord>;
  readonly #tasks: AirtableJsonStore<JsonRecord>;
  readonly #sessions: AirtableJsonStore<JsonRecord>;
  readonly #agendas: AirtableJsonStore<JsonRecord>;

  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
  }) {
    const shared = { baseId: options.baseId, transport: options.transport };
    this.#events = new AirtableJsonStore({
      ...shared,
      table: "Events",
      jsonField: "Settings JSON",
      indexedFields: EVENT_INDEXED_FIELDS,
    });
    this.#submissions = new AirtableJsonStore({
      ...shared,
      table: "Submissions",
      jsonField: "Answers JSON",
    });
    this.#plans = new AirtableJsonStore({
      ...shared,
      table: "Review Plans",
      jsonField: "Rounds JSON",
    });
    this.#evaluations = new AirtableJsonStore({
      ...shared,
      table: "Evaluations",
      jsonField: "Scores JSON",
    });
    this.#tasks = new AirtableJsonStore({
      ...shared,
      table: "Speaker Tasks",
      jsonField: "Owner JSON",
    });
    this.#sessions = new AirtableJsonStore({
      ...shared,
      table: "Sessions",
      jsonField: "Metadata JSON",
    });
    this.#agendas = new AirtableJsonStore({
      ...shared,
      table: "Agenda Versions",
      jsonField: "Conflicts JSON",
    });
  }

  async getOverviewCore(organizationId: string): Promise<OrganizerOverviewCoreData> {
    const { events } = await this.loadScopedEvents(organizationId);
    return {
      organizationId,
      metrics: { eventCount: events.length },
      events,
    };
  }

  async getOverviewActivity(organizationId: string): Promise<OrganizerOverviewActivityData> {
    const { events, eventIds } = await this.loadScopedEvents(organizationId);
    if (events.length === 0) {
      return {
        organizationId,
        metrics: {
          submissionCount: 0,
          pendingReviewCount: 0,
          outstandingSpeakerTaskCount: 0,
          publishedSessionCount: 0,
        },
        actionItems: [],
      };
    }

    const scoped = (jsonField: string) =>
      organizationScopeFormula(jsonField, organizationId, [...eventIds]);
    const [allSubmissions, allPlans, allEvaluations, allTasks, allSessions, agendaStates] =
      await Promise.all([
        this.#submissions.list({ filterByFormula: scoped("Answers JSON") }),
        this.#plans.list({ filterByFormula: scoped("Rounds JSON") }),
        this.#evaluations.list({ filterByFormula: scoped("Scores JSON") }),
        this.#tasks.list({ filterByFormula: scoped("Owner JSON") }),
        this.#sessions.list({ filterByFormula: scoped("Metadata JSON") }),
        this.#agendas.listByIds(events.map((event) => event.id)),
      ]);
    const submissions = allSubmissions.filter(
      (submission) =>
        belongsToOrganization(submission, organizationId, eventIds) &&
        textValue(submission, "status") !== "withdrawn",
    );
    const plans = allPlans.filter(
      (plan) =>
        belongsToOrganization(plan, organizationId, eventIds) ||
        (resolvedOrganizationId(plan) === organizationId &&
          eventIds.has(eventReference(plan) ?? "")),
    );
    const planIds = new Set(plans.map((plan) => textValue(plan, "id")).filter(isNonEmpty));
    const assignmentRows = latestEvaluationAssignmentRows(allEvaluations);
    const assignments = overlayEvaluationAssignmentSnapshots(
      plans as unknown as readonly AirtableEvaluationPlanRecord[],
      assignmentRows,
    )
      .filter(
        (assignment) =>
          assignment.tenantId === organizationId &&
          planIds.has(assignment.planId) &&
          eventIds.has(assignment.eventId),
      )
      .map((assignment) => assignment as unknown as JsonRecord);
    const pendingAssignments = assignments.filter((assignment) => {
      const status = textValue(assignment, "status");
      return status === "assigned" || status === "in_progress";
    });
    const tasks = allTasks.filter(
      (task) =>
        belongsToOrganization(task, organizationId, eventIds) &&
        eventIds.has(eventReference(task) ?? "") &&
        !["completed", "waived"].includes(textValue(task, "status") ?? ""),
    );
    const sessions = allSessions.filter(
      (session) =>
        belongsToOrganization(session, organizationId, eventIds) &&
        eventIds.has(eventReference(session) ?? "") &&
        textValue(session, "status") !== "cancelled",
    );
    const agendaByEvent = new Map<string, JsonRecord>(
      agendaStates.flatMap((state) => {
        const eventId = textValue(state, "eventId", "id");
        return eventId === null ? [] : [[eventId, state] as const];
      }),
    );
    const publishedSessionIdsByEvent = new Map<string, ReadonlySet<string>>(
      events.map(
        (event) => [event.id, this.publishedSessionIds(agendaByEvent.get(event.id))] as const,
      ),
    );

    const pendingReviewsByEvent = groupByEvent(pendingAssignments);
    const tasksByEvent = groupByEvent(tasks);
    const sessionsByEvent = groupByEvent(sessions);
    const publishedSessionCount = [...publishedSessionIdsByEvent.values()].reduce(
      (total, ids) => total + ids.size,
      0,
    );
    const actionItems: OrganizerOverviewActionItem[] = [];

    for (const event of events) {
      const pendingReviews = pendingReviewsByEvent.get(event.id) ?? [];
      if (pendingReviews.length > 0) {
        const planDueDates = pendingReviews.map((assignment) => {
          const plan = plans.find(
            (candidate) => textValue(candidate, "id") === textValue(assignment, "planId"),
          );
          return plan === undefined ? null : dueAtValue(plan);
        });
        actionItems.push(
          actionItem({
            id: `reviews:${event.id}`,
            type: "reviews",
            eventId: event.id,
            title:
              pendingReviews.length === 1
                ? "Complete a pending review"
                : "Complete pending reviews",
            description: `${pendingReviews.length} review${pendingReviews.length === 1 ? "" : "s"} still need organizer attention.`,
            count: pendingReviews.length,
            priority: 90,
            dueAt: earliestDueAt(planDueDates),
            href: hrefFor(organizationId, event.id, "reviews"),
          }),
        );
      }

      const outstandingTasks = tasksByEvent.get(event.id) ?? [];
      if (outstandingTasks.length > 0) {
        actionItems.push(
          actionItem({
            id: `speaker_tasks:${event.id}`,
            type: "speaker_tasks",
            eventId: event.id,
            title:
              outstandingTasks.length === 1 ? "Resolve a speaker task" : "Resolve speaker tasks",
            description: `${outstandingTasks.length} speaker task${outstandingTasks.length === 1 ? "" : "s"} remain open.`,
            count: outstandingTasks.length,
            priority: 70,
            dueAt: earliestDueAt(outstandingTasks.map(dueAtValue)),
            href: hrefFor(organizationId, event.id, "speakers"),
          }),
        );
      }

      const eventSessions = sessionsByEvent.get(event.id) ?? [];
      const publishedIds = publishedSessionIdsByEvent.get(event.id) ?? new Set<string>();
      const unpublishedSessionCount = eventSessions.filter(
        (session) => !publishedIds.has(textValue(session, "id") ?? ""),
      ).length;
      if (unpublishedSessionCount > 0) {
        actionItems.push(
          actionItem({
            id: `agenda:${event.id}`,
            type: "agenda",
            eventId: event.id,
            title:
              unpublishedSessionCount === 1
                ? "Publish the remaining session"
                : "Publish the remaining sessions",
            description: `${unpublishedSessionCount} session${unpublishedSessionCount === 1 ? "" : "s"} are not in the current published agenda.`,
            count: unpublishedSessionCount,
            priority: 50,
            href: hrefFor(organizationId, event.id, "agenda"),
          }),
        );
      }
    }

    actionItems.sort(
      (left, right) =>
        right.priority - left.priority ||
        compareNullableDates(left.dueAt, right.dueAt) ||
        left.id.localeCompare(right.id),
    );
    return {
      organizationId,
      metrics: {
        submissionCount: submissions.length,
        pendingReviewCount: pendingAssignments.length,
        outstandingSpeakerTaskCount: tasks.length,
        publishedSessionCount,
      },
      actionItems,
    };
  }

  private async loadScopedEvents(organizationId: string): Promise<{
    readonly events: OrganizerOverviewEvent[];
    readonly eventIds: ReadonlySet<string>;
  }> {
    const allEvents = await this.#events.list({
      filterByFormula: organizationScopeFormula("Settings JSON", organizationId, []),
    });
    const events = allEvents
      .filter((event) => resolvedOrganizationId(event) === organizationId)
      .map((event) => this.eventView(event))
      .sort((left, right) => left.id.localeCompare(right.id));
    return { events, eventIds: new Set(events.map((event) => event.id)) };
  }
  private eventView(record: JsonRecord): OrganizerOverviewEvent {
    const id = requiredId(record.id);
    return {
      id,
      name: textValue(record, "name", "title") ?? id,
      slug: textValue(record, "slug"),
      startsAt: textValue(record, "startsAt", "startsOn", "startAt"),
      endsAt: textValue(record, "endsAt", "endsOn", "endAt"),
    };
  }

  private publishedSessionIds(state: JsonRecord | undefined): ReadonlySet<string> {
    if (state === undefined) return new Set<string>();
    const revisionId = textValue(state, "currentPublishedRevisionId");
    if (revisionId === null || !Array.isArray(state.revisions)) return new Set<string>();
    const revision = state.revisions.find(
      (candidate): candidate is JsonRecord =>
        isRecord(candidate) && textValue(candidate, "id") === revisionId,
    );
    if (revision === undefined || !Array.isArray(revision.entries)) return new Set<string>();
    return new Set(
      revision.entries
        .filter(isRecord)
        .map((entry) => textValue(entry, "sessionId"))
        .filter(isNonEmpty),
    );
  }
}

function isNonEmpty(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

function groupByEvent(records: readonly JsonRecord[]): Map<string, JsonRecord[]> {
  const grouped = new Map<string, JsonRecord[]>();
  for (const record of records) {
    const eventId = eventReference(record);
    if (eventId === null) continue;
    const values = grouped.get(eventId);
    if (values === undefined) grouped.set(eventId, [record]);
    else values.push(record);
  }
  return grouped;
}

function compareNullableDates(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return Date.parse(left) - Date.parse(right);
}
/** Durable Object admission plus an in-process tail protects one event's agenda mutations. */
export class CloudflareAgendaMutationLock implements DurableObjectAgendaCoordinator {
  readonly #namespace: DurableObjectNamespace;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #activeOperations = new Map<
    string,
    { readonly operationId: string; readonly renew: () => Promise<void> }
  >();

  constructor(namespace: DurableObjectNamespace) {
    this.#namespace = namespace;
  }

  currentOperationId(eventId: string): string {
    const active = this.#activeOperations.get(eventId);
    if (active === undefined) throw new AgendaRepositoryConflictError(eventId);
    return active.operationId;
  }

  async renew(eventId: string): Promise<void> {
    const active = this.#activeOperations.get(eventId);
    if (active === undefined) throw new AgendaRepositoryConflictError(eventId);
    await active.renew();
  }

  async runExclusive<T>(eventId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(eventId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(eventId, current);
    await previous;
    try {
      const stub = this.#namespace.get(this.#namespace.idFromName(eventId));
      const operationId = `agenda:${eventId}:${crypto.randomUUID()}`;
      for (;;) {
        const revisionResponse = await stub.fetch(new Request("https://agenda/revision"));
        const revisionBody: unknown = await revisionResponse.json();
        const revision =
          isRecord(revisionBody) && typeof revisionBody.revision === "number"
            ? revisionBody.revision
            : null;
        if (!revisionResponse.ok || revision === null) {
          throw new AgendaRepositoryConflictError(eventId);
        }
        const admission = await stub.fetch(
          new Request("https://agenda/mutations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              operationId,
              expectedRevision: revision,
            }),
          }),
        );
        if (admission.ok) break;
        if (admission.status !== 409) throw new AgendaRepositoryConflictError(eventId);
      }
      const renew = async () => {
        const response = await stub.fetch(
          new Request("https://agenda/mutations", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId }),
          }),
        );
        if (!response.ok) throw new AgendaRepositoryConflictError(eventId);
      };
      this.#activeOperations.set(eventId, { operationId, renew });
      let renewalFailure: Error | null = null;
      let renewalInFlight: Promise<void> | null = null;
      const renewLease = () => {
        if (renewalInFlight !== null || renewalFailure !== null) return;
        const activeRenewal = renew()
          .catch((error: unknown) => {
            renewalFailure =
              error instanceof Error
                ? error
                : new Error(`Agenda coordinator renewal failed for ${eventId}.`);
          })
          .finally(() => {
            if (renewalInFlight === activeRenewal) renewalInFlight = null;
          });
        renewalInFlight = activeRenewal;
      };
      const renewalTimer = setInterval(renewLease, 30_000);
      const outcome = await (async () => {
        try {
          return { ok: true as const, value: await operation() };
        } catch (error) {
          return { ok: false as const, error };
        }
      })();
      clearInterval(renewalTimer);
      if (renewalInFlight !== null) await renewalInFlight;
      let releaseError: Error | null = null;
      try {
        const releaseResponse = await stub.fetch(
          new Request("https://agenda/mutations", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId }),
          }),
        );
        if (!releaseResponse.ok) releaseError = new AgendaRepositoryConflictError(eventId);
      } catch (error) {
        releaseError =
          error instanceof Error
            ? error
            : new Error(`Agenda coordinator release failed for ${eventId}.`);
      }
      this.#activeOperations.delete(eventId);
      if (renewalFailure !== null) {
        if (!outcome.ok || releaseError !== null) {
          throw new AggregateError(
            [
              renewalFailure,
              ...(!outcome.ok ? [outcome.error] : []),
              ...(releaseError === null ? [] : [releaseError]),
            ],
            `Agenda mutation lease failed for ${eventId}.`,
          );
        }
        throw renewalFailure;
      }
      if (!outcome.ok) {
        if (releaseError !== null) {
          throw new AggregateError(
            [outcome.error, releaseError],
            `Agenda mutation and coordinator release failed for ${eventId}.`,
          );
        }
        throw outcome.error;
      }
      if (releaseError !== null) throw releaseError;
      return outcome.value;
    } finally {
      release();
      if (this.#tails.get(eventId) === current) this.#tails.delete(eventId);
    }
  }
}

export class IdempotencyLeaseLostError extends Error {
  constructor() {
    super("The idempotency lease was lost before the operation completed.");
    this.name = "IdempotencyLeaseLostError";
  }
}

export class D1IdempotencyStore implements IdempotencyStore, CfpIdempotencyCoordinator {
  readonly #database: D1Database;
  readonly #leaseMs: number;

  constructor(database: D1Database, options: { readonly leaseMs?: number } = {}) {
    this.#database = database;
    this.#leaseMs = options.leaseMs ?? 30_000;
  }

  async begin(input: {
    scope: string;
    key: string;
    fingerprint: string;
  }): Promise<IdempotencyBeginResult> {
    const tenantId = tenantFromScope(input.scope);
    const now = new Date();
    const existing = await this.#database
      .prepare(
        `SELECT request_digest, state, response_status, response_json, expires_at, lease_id
           FROM idempotency_records
          WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?`,
      )
      .bind(tenantId, input.scope, input.key)
      .first<{
        request_digest: string;
        state: string;
        response_status: number | null;
        response_json: string | null;
        expires_at: string;
        lease_id: string | null;
      }>();
    if (existing !== null && Date.parse(existing.expires_at) > now.getTime()) {
      if (existing.request_digest !== input.fingerprint) return { status: "conflict" };
      if (existing.state === "completed" && existing.response_json !== null) {
        return {
          status: "replay",
          response: {
            status: existing.response_status ?? 200,
            body: parseStoredJson(existing.response_json),
          },
        };
      }
      if (existing.state === "processing") {
        return {
          status: "pending",
          wait: () => this.waitForCompletion(tenantId, input),
        };
      }
    }
    if (existing !== null) {
      await this.#database
        .prepare(
          `DELETE FROM idempotency_records
            WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?
              AND expires_at <= ?`,
        )
        .bind(tenantId, input.scope, input.key, now.toISOString())
        .run();
    }
    const leaseId = crypto.randomUUID();
    try {
      await this.#database
        .prepare(
          `INSERT INTO idempotency_records
             (tenant_id, scope, idempotency_key, request_digest, state, lease_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
        )
        .bind(
          tenantId,
          input.scope,
          input.key,
          input.fingerprint,
          leaseId,
          now.toISOString(),
          new Date(now.getTime() + this.#leaseMs).toISOString(),
        )
        .run();
    } catch {
      const raced = await this.begin(input);
      return raced;
    }
    return { status: "acquired", leaseId };
  }

  async complete(input: {
    scope: string;
    key: string;
    fingerprint: string;
    leaseId?: string;
    response: IdempotencyStoredResponse;
  }): Promise<void> {
    const tenantId = tenantFromScope(input.scope);
    const result = await this.#database
      .prepare(
        `UPDATE idempotency_records
            SET state = 'completed', response_status = ?, response_json = ?, expires_at = ?
          WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?
            AND request_digest = ? AND lease_id = ?`,
      )
      .bind(
        input.response.status,
        JSON.stringify(input.response.body),
        new Date(Date.now() + 86_400_000).toISOString(),
        tenantId,
        input.scope,
        input.key,
        input.fingerprint,
        input.leaseId ?? "",
      )
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new IdempotencyLeaseLostError();
    }
  }

  async release(input: {
    scope: string;
    key: string;
    fingerprint: string;
    leaseId?: string;
  }): Promise<void> {
    await this.#database
      .prepare(
        `DELETE FROM idempotency_records
          WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?
            AND request_digest = ? AND lease_id = ?`,
      )
      .bind(
        tenantFromScope(input.scope),
        input.scope,
        input.key,
        input.fingerprint,
        input.leaseId ?? "",
      )
      .run();
  }

  async run<T>(
    scope: string,
    key: string,
    operation: () => Promise<T>,
    requestFingerprint?: string,
  ): Promise<T> {
    const fingerprint = requestFingerprint ?? `cfp:${scope}:${key}`;
    const claim = await this.begin({ scope, key, fingerprint });
    if (claim.status === "replay") return claim.response.body as T;
    if (claim.status === "conflict")
      throw new CfpError(
        "CONFLICT",
        "The idempotency key was already used with a different request.",
      );
    if (claim.status === "pending") return (await claim.wait()).body as T;
    try {
      const value = await operation();
      await this.complete({
        scope,
        key,
        fingerprint,
        ...(claim.leaseId === undefined ? {} : { leaseId: claim.leaseId }),
        response: { status: 200, body: value },
      });
      return value;
    } catch (error) {
      await this.release({
        scope,
        key,
        fingerprint,
        ...(claim.leaseId === undefined ? {} : { leaseId: claim.leaseId }),
      });
      throw error;
    }
  }

  private async waitForCompletion(
    tenantId: string,
    input: { scope: string; key: string; fingerprint: string },
  ): Promise<IdempotencyStoredResponse> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = await this.#database
        .prepare(
          `SELECT request_digest, state, response_status, response_json
             FROM idempotency_records
            WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?`,
        )
        .bind(tenantId, input.scope, input.key)
        .first<{
          request_digest: string;
          state: string;
          response_status: number | null;
          response_json: string | null;
        }>();
      if (row === null) throw new Error("The idempotency operation expired before completion.");
      if (row.request_digest !== input.fingerprint)
        throw new CfpError(
          "CONFLICT",
          "The idempotency key was already used with a different request.",
        );
      if (row.state === "completed" && row.response_json !== null) {
        return {
          status: row.response_status ?? 200,
          body: parseStoredJson(row.response_json),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The idempotency operation did not complete in time.");
  }
}

function tenantFromScope(scope: string): string {
  const tenant = scope.split(":", 1)[0]?.trim();
  return tenant === undefined || tenant.length === 0 ? "runtime" : tenant;
}

function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Stored idempotency response is invalid.");
  }
}
function escapeCfpReceiptHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export class CloudflareCfpEffects implements CfpEffects {
  readonly #queue: Queue<CloudflareOutboxMessage>;
  readonly #database: D1Database;
  readonly #senderAddresses: OpenSendSenderAddresses;

  constructor(
    queue: Queue<CloudflareOutboxMessage>,
    database: D1Database,
    senderAddresses: OpenSendSenderAddresses,
  ) {
    this.#queue = queue;
    this.#database = database;
    this.#senderAddresses = senderAddresses;
  }

  async enqueueSubmissionConfirmation(input: {
    submission: Submission;
    form: CfpForm;
    event: EventCfp;
    submissionTitle: string;
    idempotencyKey: string;
  }): Promise<void> {
    const recipient = await this.#database
      .prepare(
        `SELECT email
           FROM auth_users
          WHERE id = ? AND email_verified = 1
          LIMIT 1`,
      )
      .bind(input.submission.ownerAccountId)
      .first<{ email: string }>();
    const email = recipient?.email.trim();
    if (email === undefined || email.length === 0) {
      throw new Error("The CFP submitter does not have a verified account email.");
    }

    const idempotencyKey = `cfp-receipt:${input.submission.id}:v${input.submission.version}`;
    const eventName = input.event.name.trim();
    const submissionTitle = input.submissionTitle.trim();
    const escapedEventName = escapeCfpReceiptHtml(eventName);
    const escapedSubmissionTitle = escapeCfpReceiptHtml(submissionTitle);
    await enqueueCloudflareOutbox({
      database: this.#database,
      queue: this.#queue,
      tenantId: input.submission.tenantId,
      topic: "communications",
      deduplicationKey: idempotencyKey,
      payload: {
        from: this.#senderAddresses.speakers,
        senderPurpose: "speakers",
        to: [email],
        subject: `Submission received: ${submissionTitle} — ${eventName}`,
        html: `<p>Your submission <strong>${escapedSubmissionTitle}</strong> for <strong>${escapedEventName}</strong> was received.</p>`,
        text: `Your submission "${submissionTitle}" for ${eventName} was received.`,
        idempotencyKey,
      },
    });
  }
}

function scopedRecord(value: object, tenantId: string, eventId: string): boolean {
  return (
    resolvedOrganizationId(value) === tenantId &&
    eventReference(isRecord(value) ? value : {}) === eventId
  );
}

function recordTenantId(value: object): string | undefined {
  return resolvedOrganizationId(value);
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function jsonStore<T extends object>(
  shared: { readonly baseId: string; readonly transport: AirtableTransport },
  table: string,
  jsonField: string,
  indexedFields: Readonly<Record<string, string>> = {},
): AirtableJsonStore<T> {
  return new AirtableJsonStore<T>({ ...shared, table, jsonField, indexedFields });
}

function decodeRoom(fields: Readonly<AirtableFields>): Room {
  const settings = fields["Settings JSON"];
  const room =
    typeof settings === "string" && settings.trim().length > 0
      ? decodeJson<Room>(fields, "Settings JSON")
      : decodeJson<Room>(fields, "Metadata JSON");
  return Object.hasOwn(fields, "Capacity")
    ? { ...room, capacity: fields.Capacity as number }
    : room;
}
/** Session business resources are persisted in their provisioned Airtable tables. */
export class AirtableSessionRepository implements SessionRepository {
  readonly #sessions: AirtableJsonStore<Session>;
  readonly #rooms: AirtableJsonStore<Room>;
  readonly #tracks: AirtableJsonStore<Track>;
  readonly #formats: AirtableJsonStore<Format>;
  readonly #levels: AirtableJsonStore<Level>;
  readonly #tags: AirtableJsonStore<Tag>;
  readonly #settings: AirtableJsonStore<SessionSettings>;
  readonly #audits: AirtableJsonStore<SessionAuditEntry>;
  readonly #participants: AirtableJsonStore<JsonRecord>;
  readonly #submissions: AirtableJsonStore<JsonRecord>;
  private static decodeSession(fields: Readonly<AirtableFields>): Session {
    const parsed = decodeJson<Session>(fields, "Metadata JSON") as Session & JsonRecord;
    const storedMetadata = (() => {
      const raw = fields["Metadata JSON"];
      if (typeof raw !== "string" || raw.trim().length === 0) return null;
      try {
        const value = JSON.parse(raw) as unknown;
        return isRecord(value) ? value : null;
      } catch {
        return null;
      }
    })();
    const scalarText = (...keys: readonly string[]): string | undefined =>
      textValue(fields as JsonRecord, ...keys) ?? undefined;
    const jsonArray = (key: string, fallback: readonly string[]): readonly string[] => {
      const raw = fields[key];
      if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
      try {
        return asStringArray(JSON.parse(raw) as unknown);
      } catch {
        return fallback;
      }
    };
    const settings = (() => {
      const raw = fields["Settings JSON"];
      if (typeof raw !== "string" || raw.trim().length === 0) return {} as JsonRecord;
      try {
        const value = JSON.parse(raw) as unknown;
        return isRecord(value) ? value : ({} as JsonRecord);
      } catch {
        return {} as JsonRecord;
      }
    })();
    const id = scalarText(APPLICATION_ID) ?? parsed.id;
    const tenantId = scalarText("Organization ID") ?? parsed.tenantId;
    const eventId = scalarText("Event ID") ?? parsed.eventId;
    const canonicalPayload =
      typeof storedMetadata?.tenantId === "string" &&
      storedMetadata.tenantId.trim().length > 0 &&
      typeof storedMetadata.eventId === "string" &&
      storedMetadata.eventId.trim().length > 0;
    const title = canonicalPayload ? parsed.title : (scalarText("Title") ?? parsed.title);
    const description = canonicalPayload
      ? parsed.description
      : (scalarText("Description") ?? parsed.description);
    const status = canonicalPayload ? parsed.status : (scalarText("Status") ?? parsed.status);
    const version =
      canonicalPayload ||
      typeof fields.Version !== "number" ||
      !Number.isSafeInteger(fields.Version)
        ? parsed.version
        : fields.Version;
    const durationMinutes =
      canonicalPayload || typeof fields["Duration Minutes"] !== "number"
        ? parsed.durationMinutes
        : fields["Duration Minutes"];
    const capacityRequired =
      canonicalPayload || typeof fields["Capacity Required"] !== "number"
        ? parsed.capacityRequired
        : fields["Capacity Required"];
    const trackIds = canonicalPayload
      ? asStringArray(parsed.trackIds)
      : jsonArray("Track IDs JSON", asStringArray(parsed.trackIds));
    const tagIds = canonicalPayload
      ? asStringArray(parsed.tagIds)
      : jsonArray("Tag IDs JSON", asStringArray(parsed.tagIds));
    const speakerIds = canonicalPayload
      ? asStringArray(parsed.speakerIds)
      : jsonArray(
          "Speaker IDs JSON",
          asStringArray(parsed.speakerIds ?? parsed.speakerProfileIds ?? parsed.participantIds),
        );
    const resourceIds = canonicalPayload
      ? asStringArray(parsed.resourceIds)
      : jsonArray("Resource IDs JSON", asStringArray(parsed.resourceIds));
    const roomId = canonicalPayload
      ? parsed.roomId
      : (textValue(settings, "roomId") ?? parsed.roomId);
    const trackId = canonicalPayload
      ? (parsed.trackId ?? trackIds[0])
      : (textValue(settings, "trackId") ?? parsed.trackId ?? trackIds[0]);
    const formatId = canonicalPayload
      ? parsed.formatId
      : (scalarText("Format ID") ?? textValue(settings, "formatId") ?? parsed.formatId);
    const publicationStatus = textValue(settings, "publicationStatus")?.toLowerCase();
    const contentStatus =
      parsed.contentStatus ??
      (publicationStatus === "published"
        ? "Approved"
        : publicationStatus === "needs_changes"
          ? "Needs changes"
          : undefined);

    requiredId(id);
    return {
      ...parsed,
      id,
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(eventId === undefined ? {} : { eventId }),
      title,
      description,
      status,
      version,
      durationMinutes,
      capacityRequired,
      ...(roomId === undefined ? {} : { roomId }),
      ...(trackId === undefined ? {} : { trackId }),
      trackIds,
      ...(formatId === undefined ? {} : { formatId }),
      tagIds,
      speakerIds,
      resourceIds,
      ...(contentStatus === undefined ? {} : { contentStatus }),
    };
  }
  private static decodeTaxonomy<T extends Track | Format | Level | Tag>(
    fields: Readonly<AirtableFields>,
  ): T {
    const parsed = decodeJson<T>(fields, "Metadata JSON") as T & JsonRecord;
    const textField = (key: string): string | undefined => {
      const value = fields[key];
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    };
    const descriptionField = fields.Description;
    const id = textField(APPLICATION_ID) ?? (typeof parsed.id === "string" ? parsed.id : undefined);
    const organizationId = resolvedOrganizationId(parsed);
    const eventId =
      textField("Event ID") ?? (typeof parsed.eventId === "string" ? parsed.eventId : undefined);
    const name = textField("Name") ?? (typeof parsed.name === "string" ? parsed.name : undefined);
    const description =
      typeof descriptionField === "string"
        ? descriptionField
        : typeof parsed.description === "string"
          ? parsed.description
          : undefined;
    const version =
      typeof fields.Version === "number" && Number.isSafeInteger(fields.Version)
        ? fields.Version
        : typeof parsed.version === "number"
          ? parsed.version
          : undefined;
    requiredId(id);
    return {
      ...parsed,
      id,
      ...(organizationId === undefined ? {} : { organizationId, tenantId: organizationId }),
      ...(eventId === undefined ? {} : { eventId }),
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(version === undefined ? {} : { version }),
    } as T;
  }
  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
  }) {
    const shared = { baseId: options.baseId, transport: options.transport };
    this.#sessions = new AirtableJsonStore({
      ...shared,
      table: "Sessions",
      jsonField: "Metadata JSON",
      decode: AirtableSessionRepository.decodeSession,
    });
    this.#rooms = new AirtableJsonStore({
      ...shared,
      table: "Rooms",
      jsonField: "Settings JSON",
      decode: decodeRoom,
    });
    this.#tracks = new AirtableJsonStore({
      ...shared,
      table: "Tracks",
      jsonField: "Metadata JSON",
      decode: (fields) => AirtableSessionRepository.decodeTaxonomy<Track>(fields),
    });
    this.#formats = new AirtableJsonStore({
      ...shared,
      table: "Formats",
      jsonField: "Metadata JSON",
      decode: (fields) => AirtableSessionRepository.decodeTaxonomy<Format>(fields),
    });
    this.#levels = new AirtableJsonStore({
      ...shared,
      table: "Levels",
      jsonField: "Metadata JSON",
      decode: (fields) => AirtableSessionRepository.decodeTaxonomy<Level>(fields),
    });
    this.#tags = new AirtableJsonStore({
      ...shared,
      table: "Tags",
      jsonField: "Metadata JSON",
      decode: (fields) => AirtableSessionRepository.decodeTaxonomy<Tag>(fields),
    });
    this.#settings = jsonStore(shared, "Session Settings", "Settings JSON");
    this.#audits = jsonStore(shared, "Audit Records", "Changes JSON");
    this.#participants = jsonStore(shared, "Participants", "Metadata JSON");
    this.#submissions = jsonStore(shared, "Submissions", "Answers JSON");
  }

  async getSession(tenantId: string, eventId: string, sessionId: string): Promise<Session | null> {
    return this.scopedFind(this.#sessions, tenantId, eventId, sessionId);
  }

  async listSessions(tenantId: string, eventId: string): Promise<readonly Session[]> {
    return (await listEventScopedJson(this.#sessions, "Metadata JSON", eventId))
      .filter((value) => scopedRecord(value, tenantId, eventId))
      .map((value) => untagged(value));
  }

  async putSession(session: Session, expectedVersion: number | null): Promise<void> {
    await this.putVersioned(this.#sessions, session, expectedVersion);
  }

  async deleteSession(
    tenantId: string,
    eventId: string,
    sessionId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.deleteVersioned(this.#sessions, tenantId, eventId, sessionId, expectedVersion);
  }

  async getRoom(tenantId: string, eventId: string, roomId: string): Promise<Room | null> {
    return this.scopedFind(this.#rooms, tenantId, eventId, roomId);
  }

  async listRooms(tenantId: string, eventId: string): Promise<readonly Room[]> {
    return this.scopedList(this.#rooms, tenantId, eventId);
  }

  async putRoom(room: Room, expectedVersion: number | null): Promise<void> {
    await this.putVersioned(this.#rooms, room, expectedVersion);
  }

  async deleteRoom(
    tenantId: string,
    eventId: string,
    roomId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.deleteVersioned(this.#rooms, tenantId, eventId, roomId, expectedVersion);
  }

  async getTrack(tenantId: string, eventId: string, trackId: string): Promise<Track | null> {
    return this.scopedFind(this.#tracks, tenantId, eventId, trackId);
  }

  async listTracks(tenantId: string, eventId: string): Promise<readonly Track[]> {
    return this.scopedList(this.#tracks, tenantId, eventId);
  }

  async putTrack(track: Track, expectedVersion: number | null): Promise<void> {
    await this.putVersioned(this.#tracks, track, expectedVersion);
  }

  async deleteTrack(
    tenantId: string,
    eventId: string,
    trackId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.deleteVersioned(this.#tracks, tenantId, eventId, trackId, expectedVersion);
  }

  async getFormat(tenantId: string, eventId: string, formatId: string): Promise<Format | null> {
    return this.scopedFind(this.#formats, tenantId, eventId, formatId);
  }

  async listFormats(tenantId: string, eventId: string): Promise<readonly Format[]> {
    return this.scopedList(this.#formats, tenantId, eventId);
  }

  async putFormat(format: Format, expectedVersion: number | null): Promise<void> {
    await this.putVersioned(this.#formats, format, expectedVersion);
  }

  async deleteFormat(
    tenantId: string,
    eventId: string,
    formatId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.deleteVersioned(this.#formats, tenantId, eventId, formatId, expectedVersion);
  }

  async getLevel(tenantId: string, eventId: string, levelId: string): Promise<Level | null> {
    return this.scopedFind(this.#levels, tenantId, eventId, levelId);
  }

  async listLevels(tenantId: string, eventId: string): Promise<readonly Level[]> {
    return this.scopedList(this.#levels, tenantId, eventId);
  }

  async putLevel(level: Level, expectedVersion: number | null): Promise<void> {
    await this.putVersioned(this.#levels, level, expectedVersion);
  }

  async deleteLevel(
    tenantId: string,
    eventId: string,
    levelId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.deleteVersioned(this.#levels, tenantId, eventId, levelId, expectedVersion);
  }

  async getTag(tenantId: string, eventId: string, tagId: string): Promise<Tag | null> {
    return this.scopedFind(this.#tags, tenantId, eventId, tagId);
  }

  async listTags(tenantId: string, eventId: string): Promise<readonly Tag[]> {
    return this.scopedList(this.#tags, tenantId, eventId);
  }

  async putTag(tag: Tag, expectedVersion: number | null): Promise<void> {
    await this.putVersioned(this.#tags, tag, expectedVersion);
  }

  async deleteTag(
    tenantId: string,
    eventId: string,
    tagId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.deleteVersioned(this.#tags, tenantId, eventId, tagId, expectedVersion);
  }

  async getSettings(tenantId: string, eventId: string): Promise<SessionSettings | null> {
    const id = `settings:${eventId}`;
    return this.scopedFind(this.#settings, tenantId, eventId, id);
  }

  async putSettings(settings: SessionSettings, expectedVersion: number | null): Promise<void> {
    await this.putVersioned(this.#settings, settings, expectedVersion);
  }

  async appendAudit(entry: SessionAuditEntry): Promise<void> {
    const stored = tagged(entry, "session_audit");
    const existing = await this.#audits.find(entry.id);
    if (existing === undefined) await this.#audits.create(stored);
    else await this.#audits.update(entry.id, stored);
  }

  async listAudit(
    tenantId: string,
    eventId: string,
    entityId?: string,
  ): Promise<readonly SessionAuditEntry[]> {
    return (await this.#audits.list())
      .filter(
        (entry) =>
          scopedRecord(entry, tenantId, eventId) &&
          (entityType(entry) === "session_audit" || entityType(entry) === undefined) &&
          (entityId === undefined || entry.entityId === entityId),
      )
      .map((entry) => untagged(entry) as SessionAuditEntry);
  }

  async listSpeakerIds(tenantId: string, eventId: string): Promise<readonly string[] | undefined> {
    const participants = (await this.#participants.list()).filter((record) =>
      scopedRecord(record, tenantId, eventId),
    );
    const ids = new Set<string>();
    for (const participant of participants) {
      const id = typeof participant.id === "string" ? participant.id : undefined;
      if (id !== undefined) ids.add(id);
    }
    if (ids.size > 0) return [...ids];
    const submissions = (await this.#submissions.list()).filter((record) =>
      scopedRecord(record, tenantId, eventId),
    );
    for (const submission of submissions) {
      const participants = submission.participants;
      if (!Array.isArray(participants)) continue;
      for (const participant of participants) {
        if (isRecord(participant) && typeof participant.id === "string") ids.add(participant.id);
      }
    }
    return ids.size === 0 ? undefined : [...ids];
  }

  private async scopedFind<T extends object>(
    store: AirtableJsonStore<T>,
    tenantId: string,
    eventId: string,
    id: string,
  ): Promise<T | null> {
    const value = await store.find(id);
    return value !== undefined && scopedRecord(value, tenantId, eventId) ? untagged(value) : null;
  }

  private async scopedList<T extends object>(
    store: AirtableJsonStore<T>,
    tenantId: string,
    eventId: string,
  ): Promise<readonly T[]> {
    return (await store.list())
      .filter((value) => scopedRecord(value, tenantId, eventId))
      .map((value) => untagged(value));
  }

  private async putVersioned<
    T extends {
      id: string;
      tenantId: string;
      eventId: string;
      version: number;
    },
  >(store: AirtableJsonStore<T>, value: T, expectedVersion: number | null): Promise<void> {
    const existing = await store.find(value.id);
    if (
      (existing?.version ?? null) !== expectedVersion ||
      (existing !== undefined &&
        (existing.tenantId !== value.tenantId || existing.eventId !== value.eventId))
    ) {
      throw new SessionRepositoryConflictError();
    }
    if (existing === undefined) await store.create(tagged(value, `session_${value.id}`));
    else await store.update(value.id, tagged(value, `session_${value.id}`));
  }

  private async deleteVersioned<
    T extends {
      id: string;
      tenantId: string;
      eventId: string;
      version: number;
    },
  >(
    store: AirtableJsonStore<T>,
    tenantId: string,
    eventId: string,
    id: string,
    expectedVersion: number,
  ): Promise<void> {
    const existing = await store.find(id);
    if (
      existing === undefined ||
      existing.tenantId !== tenantId ||
      existing.eventId !== eventId ||
      existing.version !== expectedVersion
    ) {
      throw new SessionRepositoryConflictError();
    }
    await store.delete(id);
  }
}
function communicationEntity(value: object, kind: string): boolean {
  const tag = entityType(value);
  return tag === undefined || tag === kind;
}

function templateLogicalId(id: string): string {
  const match = /^template:(.*):v\d+$/u.exec(id);
  return match?.[1] ?? id;
}

function templatePhysicalId(id: string, version: number): string {
  return `template:${id}:v${version}`;
}

function communicationIndexedFilterFormula(
  tenantId: string,
  eventId: string,
  purpose?: CommunicationTemplatePurpose,
): string {
  const clauses = [
    applicationIdFormula("Organization ID", tenantId),
    applicationIdFormula("Event ID", eventId),
    ...(purpose === undefined ? [] : [applicationIdFormula("Purpose", purpose)]),
  ];
  return clauses.length === 1 ? (clauses[0] as string) : `AND(${clauses.join(",")})`;
}

const COMMUNICATION_TEMPLATE_STATUSES = [
  "draft",
  "approved",
  "archived",
] as const satisfies readonly CommunicationTemplateStatus[];

function isNonEmptyTemplateString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTemplateStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyTemplateString);
}

function invalidCommunicationTemplate(fields: readonly string[]): AirtableRepositoryError {
  return new AirtableRepositoryError(
    "INVALID_RESPONSE",
    `Invalid communication template record: missing or invalid fields: ${fields.join(", ")}.`,
  );
}

function normalizeTemplate(value: JsonRecord): CommunicationTemplate {
  let clean: JsonRecord;
  try {
    clean = untagged(value);
  } catch {
    throw invalidCommunicationTemplate(["organization scope"]);
  }

  const invalidFields = new Set<string>();
  const requiredString = (field: keyof CommunicationTemplate): string | undefined => {
    const candidate = clean[field];
    if (!isNonEmptyTemplateString(candidate)) {
      invalidFields.add(field);
      return undefined;
    }
    return candidate;
  };
  const nullableString = (field: "approvedBy" | "approvedAt"): string | null | undefined => {
    const candidate = clean[field];
    if (candidate === null) return null;
    if (!isNonEmptyTemplateString(candidate)) {
      invalidFields.add(field);
      return undefined;
    }
    return candidate;
  };

  const idValue = requiredString("id");
  const id = idValue === undefined ? undefined : templateLogicalId(idValue.trim());
  if (id !== undefined && id.trim().length === 0) invalidFields.add("id");

  const tenantId = requiredString("tenantId");
  const eventId = requiredString("eventId");
  const name = requiredString("name");
  const subject = requiredString("subject");
  const html = requiredString("html");
  const text = requiredString("text");
  const createdBy = requiredString("createdBy");
  const createdAt = requiredString("createdAt");
  const updatedAt = requiredString("updatedAt");

  const purpose = COMMUNICATION_TEMPLATE_PURPOSES.find((candidate) => candidate === clean.purpose);
  if (purpose === undefined) invalidFields.add("purpose");

  const status = COMMUNICATION_TEMPLATE_STATUSES.find((candidate) => candidate === clean.status);
  if (status === undefined) invalidFields.add("status");

  const senderResult = openSendSenderAddressSchema.safeParse(clean.sender);
  const sender = senderResult.success
    ? (senderResult.data.toLowerCase() as CommunicationSenderIdentity)
    : undefined;
  if (sender === undefined) invalidFields.add("sender");

  const version =
    typeof clean.version === "number" && Number.isSafeInteger(clean.version) && clean.version > 0
      ? clean.version
      : undefined;
  if (version === undefined) invalidFields.add("version");
  const variableValue = clean.variables;
  const variables = isTemplateStringArray(variableValue) ? variableValue : undefined;
  if (variables === undefined) invalidFields.add("variables");

  const approvedBy = nullableString("approvedBy");
  const approvedAt = nullableString("approvedAt");

  if (
    invalidFields.size > 0 ||
    id === undefined ||
    tenantId === undefined ||
    eventId === undefined ||
    name === undefined ||
    purpose === undefined ||
    version === undefined ||
    status === undefined ||
    sender === undefined ||
    subject === undefined ||
    html === undefined ||
    text === undefined ||
    variables === undefined ||
    createdBy === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    approvedBy === undefined ||
    approvedAt === undefined
  ) {
    const fields = new Set(invalidFields);
    if (id === undefined) fields.add("id");
    if (tenantId === undefined) fields.add("tenantId");
    if (eventId === undefined) fields.add("eventId");
    if (name === undefined) fields.add("name");
    if (purpose === undefined) fields.add("purpose");
    if (version === undefined) fields.add("version");
    if (status === undefined) fields.add("status");
    if (sender === undefined) fields.add("sender");
    if (subject === undefined) fields.add("subject");
    if (html === undefined) fields.add("html");
    if (text === undefined) fields.add("text");
    if (variables === undefined) fields.add("variables");
    if (createdBy === undefined) fields.add("createdBy");
    if (createdAt === undefined) fields.add("createdAt");
    if (updatedAt === undefined) fields.add("updatedAt");
    if (approvedBy === undefined) fields.add("approvedBy");
    if (approvedAt === undefined) fields.add("approvedAt");
    throw invalidCommunicationTemplate([...fields]);
  }

  return {
    id,
    tenantId,
    eventId,
    name,
    purpose,
    version,
    status,
    sender,
    subject,
    html,
    text,
    variables,
    createdBy,
    createdAt,
    updatedAt,
    approvedBy,
    approvedAt,
  };
}

function normalizeCommunicationAudience(value: unknown): CommunicationAudience[] {
  const known = new Set<CommunicationAudience>([
    "all_participants",
    "accepted_participants",
    "waitlisted_participants",
    "rejected_participants",
    "task_assignees",
    "scheduled_participants",
  ]);
  return asStringArray(value).filter((entry): entry is CommunicationAudience =>
    known.has(entry as CommunicationAudience),
  );
}

function participantRecipient(
  value: JsonRecord,
  tenantId: string,
  eventId: string,
  fallbackAudience: CommunicationAudience[] = ["all_participants"],
): CommunicationRecipient | null {
  const email = textValue(value, "email", "Email");
  const id = textValue(value, "id", APPLICATION_ID);
  if (email === null || id === null) return null;
  const displayName =
    textValue(value, "displayName", "name", "Name") ??
    [textValue(value, "firstName", "First Name"), textValue(value, "lastName", "Last Name")]
      .filter((part): part is string => part !== null)
      .join(" ");
  const audiences = normalizeCommunicationAudience(value.audiences ?? value.Audiences);
  return {
    id,
    participantId: textValue(value, "participantId", "Participant ID") ?? id,
    tenantId,
    eventId,
    email,
    displayName: displayName || id,
    audiences: audiences.length === 0 ? fallbackAudience : audiences,
    data: isRecord(value.data) ? clone(value.data) : {},
  };
}

/** Email templates, recipient snapshots, and sends are durable Airtable business records. */
export class AirtableCommunicationRepository implements CommunicationRepository {
  readonly #templates: AirtableJsonStore<JsonRecord>;
  readonly #snapshots: AirtableJsonStore<JsonRecord>;
  readonly #participants: AirtableJsonStore<JsonRecord>;
  readonly #submissions: AirtableJsonStore<JsonRecord>;
  readonly #decisions: AirtableJsonStore<JsonRecord>;

  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
  }) {
    const shared = { baseId: options.baseId, transport: options.transport };
    this.#templates = new AirtableJsonStore({
      ...shared,
      table: "Email Templates",
      jsonField: "Settings JSON",
      scopeFields: { eventId: true, organizationId: true },
      indexedFields: {
        Purpose: "purpose",
        Status: "status",
        Sender: "sender",
      },
    });
    this.#snapshots = new AirtableJsonStore({
      ...shared,
      table: "Email Send Snapshots",
      jsonField: "Data JSON",
      scopeFields: { eventId: true, organizationId: true },
      indexedFields: {
        Purpose: "purpose",
        Status: "status",
      },
    });
    this.#participants = jsonStore(shared, "Participants", "Metadata JSON");
    this.#submissions = jsonStore(shared, "Submissions", "Answers JSON");
    this.#decisions = jsonStore(shared, "Decisions", "Metadata JSON");
  }

  async listTemplates(
    tenantId: string,
    eventId: string,
    purpose?: CommunicationTemplatePurpose,
  ): Promise<readonly CommunicationTemplate[]> {
    return (
      await this.#templates.list({
        filterByFormula: communicationIndexedFilterFormula(tenantId, eventId, purpose),
      })
    )
      .filter(
        (value) =>
          communicationEntity(value, "communication_template") &&
          scopedRecord(value, tenantId, eventId),
      )
      .map(normalizeTemplate)
      .filter((value) => purpose === undefined || value.purpose === purpose)
      .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version);
  }

  async getTemplate(
    tenantId: string,
    eventId: string,
    templateId: string,
    version?: number,
  ): Promise<CommunicationTemplate | undefined> {
    const templates = await this.listTemplates(tenantId, eventId);
    const matches = templates.filter(
      (template) =>
        template.id === templateId && (version === undefined || template.version === version),
    );
    return matches.reduce<CommunicationTemplate | undefined>(
      (current, candidate) =>
        current === undefined || candidate.version > current.version ? candidate : current,
      undefined,
    );
  }

  async saveTemplate(template: CommunicationTemplate): Promise<CommunicationTemplate> {
    const id = templatePhysicalId(template.id, template.version);
    const stored = tagged({ ...clone(template), id }, "communication_template");
    const existing = await this.#templates.find(id);
    if (existing === undefined) await this.#templates.create(stored);
    else await this.#templates.update(id, stored);
    return clone(template);
  }

  async listRecipients(
    tenantId: string,
    eventId: string,
    audience: CommunicationAudience,
  ): Promise<readonly CommunicationRecipient[]> {
    const [decisionRecords, participantRecords, submissionRecords] = await Promise.all([
      listEventScopedJson(this.#decisions, "Metadata JSON", eventId),
      this.#participants.list({ filterByFormula: applicationIdFormula("Event", eventId) }),
      listEventScopedJson(this.#submissions, "Answers JSON", eventId),
    ]);
    const decisions = decisionRecords.filter((value) => scopedRecord(value, tenantId, eventId));
    const decisionBySubmission = new Map<string, string>();
    for (const decision of decisions) {
      const submissionId = textValue(decision, "submissionId", "Submission ID");
      const status = textValue(decision, "status", "decision", "Decision");
      if (submissionId !== null && status !== null) decisionBySubmission.set(submissionId, status);
    }
    const recipients = new Map<string, CommunicationRecipient>();
    for (const record of participantRecords) {
      const outcome = textValue(record, "outcome", "decision", "status");
      const fallback: CommunicationAudience[] =
        outcome === "accepted" || outcome === "waitlisted" || outcome === "rejected"
          ? ["all_participants", `${outcome}_participants` as CommunicationAudience]
          : ["all_participants"];
      const recipient = participantRecipient(record, tenantId, eventId, fallback);
      if (recipient !== null) recipients.set(recipient.id, recipient);
    }
    for (const submission of submissionRecords.filter((value) =>
      scopedRecord(value, tenantId, eventId),
    )) {
      const submissionId = textValue(submission, "id", APPLICATION_ID);
      const outcome = submissionId === null ? undefined : decisionBySubmission.get(submissionId);
      const fallback: CommunicationAudience[] =
        outcome === "accepted" || outcome === "waitlisted" || outcome === "rejected"
          ? ["all_participants", `${outcome}_participants` as CommunicationAudience]
          : ["all_participants"];
      const participants = submission.participants;
      if (!Array.isArray(participants)) continue;
      for (const entry of participants) {
        if (!isRecord(entry)) continue;
        const recipient = participantRecipient(entry, tenantId, eventId, fallback);
        if (recipient !== null && !recipients.has(recipient.id))
          recipients.set(recipient.id, recipient);
      }
    }
    return [...recipients.values()].filter((recipient) => recipient.audiences.includes(audience));
  }

  async getRecipientsByIds(
    tenantId: string,
    eventId: string,
    recipientIds: readonly string[],
  ): Promise<readonly CommunicationRecipient[]> {
    const all = await Promise.all(
      (
        [
          "all_participants",
          "accepted_participants",
          "waitlisted_participants",
          "rejected_participants",
          "task_assignees",
          "scheduled_participants",
        ] as const
      ).map((audience) => this.listRecipients(tenantId, eventId, audience)),
    );
    const byId = new Map<string, CommunicationRecipient>();
    for (const list of all) for (const recipient of list) byId.set(recipient.id, recipient);
    return recipientIds.flatMap((id) => {
      const recipient = byId.get(id);
      return recipient === undefined ? [] : [recipient];
    });
  }

  async isAudienceAuthorized(
    tenantId: string,
    eventId: string,
    _audience: CommunicationAudience,
  ): Promise<boolean> {
    const [submissions, participants] = await Promise.all([
      listEventScopedJson(this.#submissions, "Answers JSON", eventId),
      this.#participants.list({ filterByFormula: applicationIdFormula("Event", eventId) }),
    ]);
    return (
      submissions.some((value) => scopedRecord(value, tenantId, eventId)) || participants.length > 0
    );
  }

  async getPreview(
    tenantId: string,
    eventId: string,
    previewId: string,
  ): Promise<CommunicationPreview | undefined> {
    const value = await this.#snapshots.find(previewId);
    return value !== undefined &&
      communicationEntity(value, "communication_preview") &&
      scopedRecord(value, tenantId, eventId)
      ? (untagged(value) as unknown as CommunicationPreview)
      : undefined;
  }

  async savePreview(preview: CommunicationPreview): Promise<CommunicationPreview> {
    const stored = tagged(clone(preview) as unknown as JsonRecord, "communication_preview");
    try {
      await this.#snapshots.create(stored);
    } catch (error) {
      if (
        !(error instanceof AirtableRepositoryError) ||
        error.code !== "DUPLICATE_APPLICATION_ID"
      ) {
        throw error;
      }
      await this.#snapshots.update(preview.id, stored);
    }
    return clone(preview);
  }

  async findSendByIdempotency(
    tenantId: string,
    eventId: string,
    idempotencyKey: string,
  ): Promise<CommunicationSend | undefined> {
    const value = (
      await this.#snapshots.list({
        filterByFormula: communicationIndexedFilterFormula(tenantId, eventId),
      })
    ).find(
      (candidate) =>
        communicationEntity(candidate, "communication_send") &&
        scopedRecord(candidate, tenantId, eventId) &&
        candidate.idempotencyKey === idempotencyKey,
    );
    return value === undefined ? undefined : (untagged(value) as unknown as CommunicationSend);
  }

  async getSend(
    tenantId: string,
    eventId: string,
    sendId: string,
  ): Promise<CommunicationSend | undefined> {
    const value = await this.#snapshots.find(sendId);
    return value !== undefined &&
      communicationEntity(value, "communication_send") &&
      scopedRecord(value, tenantId, eventId)
      ? (untagged(value) as unknown as CommunicationSend)
      : undefined;
  }

  async saveSend(send: CommunicationSend): Promise<CommunicationSend> {
    const duplicate = await this.findSendByIdempotency(
      send.tenantId,
      send.eventId,
      send.idempotencyKey,
    );
    if (duplicate !== undefined && duplicate.id !== send.id) {
      throw new CommunicationError(
        "COMMUNICATION_CONFLICT",
        409,
        "The communication idempotency key is already in use.",
      );
    }
    const stored = tagged(clone(send) as unknown as JsonRecord, "communication_send");
    const existing = await this.#snapshots.find(send.id);
    if (existing === undefined) await this.#snapshots.create(stored);
    else await this.#snapshots.update(send.id, stored);
    return clone(send);
  }
}
function reportScoped(value: object, scope: ReportRepositoryScope): boolean {
  return scopedRecord(value, scope.tenantId, scope.eventId);
}

function reportConflictError(message: string): ReportError {
  return new ReportError("REPORT_CONFLICT", message, 409);
}

/** Reports persist definitions and immutable run artifacts; source rows are a narrow program projection. */
export class AirtableReportRepository implements ReportRepository {
  readonly #definitions: AirtableJsonStore<JsonRecord>;
  readonly #runs: AirtableJsonStore<JsonRecord>;
  readonly #sessions: AirtableJsonStore<Session>;
  readonly #participants: AirtableJsonStore<JsonRecord>;
  readonly #profiles: AirtableJsonStore<JsonRecord>;
  readonly #plans: AirtableJsonStore<AirtableEvaluationPlanRecord>;
  readonly #assignments: AirtableJsonStore<EvaluationAssignment>;

  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
  }) {
    const shared = { baseId: options.baseId, transport: options.transport };
    this.#definitions = jsonStore(shared, "Report Definitions", "Settings JSON");
    this.#runs = jsonStore(shared, "Report Runs", "Output JSON");
    this.#sessions = jsonStore(shared, "Sessions", "Metadata JSON");
    this.#participants = jsonStore(shared, "Participants", "Metadata JSON");
    this.#profiles = jsonStore(shared, "Speaker Profiles", "Biography");
    this.#plans = jsonStore(shared, "Review Plans", "Rounds JSON");
    this.#assignments = jsonStore(shared, "Evaluations", "Scores JSON");
  }

  async listDefinitions(scope: ReportRepositoryScope): Promise<readonly ReportDefinition[]> {
    return (await this.#definitions.list())
      .filter((value) => reportScoped(value, scope))
      .map((value) => clone(untagged(value) as unknown as ReportDefinition))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async getDefinition(
    scope: ReportRepositoryScope,
    definitionId: string,
  ): Promise<ReportDefinition | null> {
    const value = await this.#definitions.find(definitionId);
    return value !== undefined && reportScoped(value, scope)
      ? clone(untagged(value) as unknown as ReportDefinition)
      : null;
  }

  async findDefinition(tenantId: string, definitionId: string): Promise<ReportDefinition | null> {
    const values = (await this.#definitions.list()).filter(
      (value) => recordTenantId(value) === tenantId && value.id === definitionId,
    );
    if (values.length !== 1) return null;
    const [value] = values;
    if (value === undefined) return null;
    return clone(untagged(value) as unknown as ReportDefinition);
  }

  async createDefinition(definition: ReportDefinition): Promise<ReportDefinition> {
    const existing = await this.#definitions.find(definition.id);
    if (existing !== undefined) {
      throw reportConflictError("A report with this id already exists.");
    }
    await this.#definitions.create(
      tagged(clone(definition) as unknown as JsonRecord, "report_definition"),
    );
    return clone(definition);
  }

  async updateDefinition(
    scope: ReportRepositoryScope,
    definitionId: string,
    expectedVersion: number,
    definition: ReportDefinition,
  ): Promise<ReportDefinition> {
    const existing = await this.getDefinition(scope, definitionId);
    if (existing === null)
      throw new ReportError("REPORT_NOT_FOUND", "The report was not found.", 404);
    if (existing.version !== expectedVersion) {
      throw reportConflictError("The report was modified by another requester.");
    }
    await this.#definitions.update(
      definitionId,
      tagged(clone(definition) as unknown as JsonRecord, "report_definition"),
    );
    return clone(definition);
  }

  async deleteDefinition(
    scope: ReportRepositoryScope,
    definitionId: string,
    expectedVersion: number,
  ): Promise<void> {
    const existing = await this.getDefinition(scope, definitionId);
    if (existing === null)
      throw new ReportError("REPORT_NOT_FOUND", "The report was not found.", 404);
    if (existing.version !== expectedVersion) {
      throw reportConflictError("The report was modified by another requester.");
    }
    await this.#definitions.delete(definitionId);
  }

  async recordRun(run: ReportRun): Promise<ReportRun> {
    if (await this.#runs.find(run.id)) {
      throw reportConflictError("A report run with this id already exists.");
    }
    await this.#runs.create(tagged(clone(run) as unknown as JsonRecord, "report_run"));
    return clone(run);
  }

  async getRun(scope: ReportRepositoryScope, runId: string): Promise<ReportRun | null> {
    const value = await this.#runs.find(runId);
    return value !== undefined && reportScoped(value, scope)
      ? clone(untagged(value) as unknown as ReportRun)
      : null;
  }

  async listRuns(
    scope: ReportRepositoryScope,
    definitionId?: string,
  ): Promise<readonly ReportRun[]> {
    return (await this.#runs.list())
      .filter(
        (value) =>
          reportScoped(value, scope) &&
          (definitionId === undefined || value.definitionId === definitionId),
      )
      .map((value) => clone(untagged(value) as unknown as ReportRun))
      .sort(
        (left, right) =>
          left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id),
      );
  }

  async listProgramRecords(input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly requesterId: string;
    readonly relationships: readonly string[];
    readonly fields: readonly string[];
    readonly includePersonalData: boolean;
  }): Promise<readonly ReportProgramRecord[]> {
    const sessions = (await this.#sessions.list()).filter((session) =>
      scopedRecord(session, input.tenantId, input.eventId),
    );
    const participants = (await this.#participants.list()).filter((record) =>
      scopedRecord(record, input.tenantId, input.eventId),
    );
    const profiles = (await this.#profiles.list()).filter((record) =>
      scopedRecord(record, input.tenantId, input.eventId),
    );
    const plans = (await this.#plans.list()).filter((plan) =>
      scopedRecord(plan, input.tenantId, input.eventId),
    );
    const assignmentRows = latestEvaluationAssignmentRows(
      await this.#assignments.list(),
      input.tenantId,
    );
    const assignmentsByPlan = new Map(
      plans.map(
        (plan) =>
          [
            plan.id,
            overlayEvaluationAssignmentSnapshot(plan, assignmentRows).filter(
              (assignment) => assignment.status !== "superseded",
            ),
          ] as const,
      ),
    );
    const records: ReportProgramRecord[] = [];
    for (const session of sessions) {
      const sessionRecord: ReportProgramRecord["session"] = {
        id: session.id,
        title: session.title,
        description: session.description,
        status: session.status,
        ...(isRecord(session) && typeof session.startsAt === "string"
          ? { startsAt: session.startsAt }
          : {}),
        ...(isRecord(session) && typeof session.endsAt === "string"
          ? { endsAt: session.endsAt }
          : {}),
        ...(isRecord(session) && typeof session.roomId === "string"
          ? { room: session.roomId }
          : {}),
        ...(isRecord(session) && typeof session.trackId === "string"
          ? { track: session.trackId }
          : {}),
      };
      const speakerIds = new Set(session.speakerIds);
      const people = participants
        .filter((record) => {
          const id = textValue(record, "id", APPLICATION_ID);
          return id !== null && speakerIds.has(id);
        })
        .map((record) => {
          const person: {
            id: string;
            displayName?: string;
            biography?: string;
            email?: string;
            [key: string]: unknown;
          } = {
            id: textValue(record, "id", APPLICATION_ID) ?? "",
            displayName:
              textValue(record, "displayName", "name", "Name") ??
              [
                textValue(record, "firstName", "First Name"),
                textValue(record, "lastName", "Last Name"),
              ]
                .filter((part): part is string => part !== null)
                .join(" "),
          };
          const biography = textValue(record, "biography", "Biography");
          if (biography !== null) person.biography = biography;
          if (input.includePersonalData) {
            const email = textValue(record, "email", "Email");
            if (email !== null) person.email = email;
          }
          return person;
        });
      const speakers = profiles
        .filter((record) => {
          const profileId = textValue(record, "participantId", "Participant ID", "id");
          return profileId !== null && speakerIds.has(profileId);
        })
        .map((record) => {
          const person: {
            id: string;
            displayName?: string;
            biography?: string;
            email?: string;
            [key: string]: unknown;
          } = {
            id: textValue(record, "participantId", "Participant ID", "id") ?? "",
            displayName: textValue(record, "displayName", "name", "Name") ?? "",
          };
          const biography = textValue(record, "biography", "Biography");
          if (biography !== null) person.biography = biography;
          if (input.includePersonalData) {
            const email = textValue(record, "email", "Email");
            if (email !== null) person.email = email;
          }
          return person;
        });
      const progress = [];
      for (const plan of plans) {
        const assignments = assignmentsByPlan.get(plan.id) ?? [];
        const counts = {
          assigned: assignments.filter((entry) => entry.status === "assigned").length,
          inProgress: assignments.filter((entry) => entry.status === "in_progress").length,
          submitted: assignments.filter((entry) => entry.status === "submitted").length,
          abstained: assignments.filter((entry) => entry.status === "abstained").length,
        };
        const total = assignments.length;
        progress.push({
          planId: plan.id,
          planName: plan.name,
          planVersion: plan.version,
          total,
          ...counts,
          completionPercent: total === 0 ? 0 : Math.round((counts.submitted / total) * 100),
        });
      }
      records.push({
        tenantId: input.tenantId,
        eventId: input.eventId,
        session: sessionRecord,
        ...(people.length === 0 ? {} : { participants: people }),
        ...(speakers.length === 0 ? {} : { speakers }),
        ...(progress.length === 0 ? {} : { evaluationProgress: progress }),
      });
    }
    return records;
  }
}
/**
 * Legacy Airtable CRM adapter retained only for migration-source reads.
 * Production CRM authority is D1.
 */
export class AirtableCrmRepository implements CrmRepository {
  readonly #contacts: AirtableJsonStore<CrmContact>;
  readonly #segments: AirtableJsonStore<CrmSegment>;
  readonly #history: AirtableJsonStore<CrmHistoryEntry>;
  readonly #pipeline: AirtableJsonStore<CrmPipelineEntry>;
  readonly #notes: AirtableJsonStore<CrmNote>;
  readonly #projections: AirtableJsonStore<CrmEventProjection>;
  readonly #outreach: AirtableJsonStore<CrmOutreachCommand>;
  readonly #imports: AirtableJsonStore<CrmImportResult>;
  readonly #commands: AirtableJsonStore<JsonRecord>;
  readonly #events: AirtableEventRepository | undefined;

  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
    readonly events?: AirtableEventRepository;
  }) {
    const shared = { baseId: options.baseId, transport: options.transport };
    this.#contacts = jsonStore(shared, "CRM Contacts", "Contact JSON");
    this.#segments = jsonStore(shared, "CRM Segments", "Segment JSON");
    this.#history = jsonStore(shared, "CRM History", "History JSON");
    this.#pipeline = jsonStore(shared, "CRM Pipeline", "Pipeline JSON");
    this.#notes = jsonStore(shared, "CRM Notes", "Note JSON");
    this.#projections = jsonStore(shared, "CRM Event Projections", "Projection JSON");
    this.#outreach = jsonStore(shared, "CRM Outreach", "Outreach JSON");
    this.#imports = jsonStore(shared, "CRM Imports", "Import JSON");
    this.#commands = jsonStore(shared, "CRM Commands", "Result JSON");
    this.#events = options.events;
  }

  async listContacts(
    organizationId: string,
    filter: CrmRepositoryFilter = {},
  ): Promise<readonly CrmContact[]> {
    const organization = crmOrganization(organizationId);
    if (filter.organizationId !== undefined && filter.organizationId !== organization) return [];
    const query = filter.query?.trim().toLowerCase();
    const email = filter.email?.trim().toLowerCase();
    const tags = filter.tags?.map((tag) => tag.trim().toLowerCase());
    return (
      await this.#contacts.list({
        filterByFormula: crmOrganizationFormula("Contact JSON", organization),
      })
    )
      .filter((contact) => {
        if (contact.organizationId !== organization) return false;
        if (email !== undefined && contact.email?.toLowerCase() !== email) return false;
        if (filter.status !== undefined && contact.status !== filter.status) return false;
        if (filter.pipelineStage !== undefined && contact.pipelineStage !== filter.pipelineStage)
          return false;
        if (
          filter.company !== undefined &&
          !(contact.company ?? "").toLowerCase().includes(filter.company.toLowerCase())
        ) {
          return false;
        }
        if (tags !== undefined && !tags.every((tag) => contact.tags.includes(tag))) return false;
        if (
          query !== undefined &&
          ![
            contact.displayName,
            contact.email ?? "",
            contact.company ?? "",
            contact.title ?? "",
            contact.phone ?? "",
            contact.notes ?? "",
          ].some((value) => value.toLowerCase().includes(query))
        ) {
          return false;
        }
        return true;
      })
      .sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
      )
      .map(clone);
  }

  async getContact(organizationId: string, contactId: string): Promise<CrmContact | null> {
    const organization = crmOrganization(organizationId);
    const contact = await this.#contacts.find(requiredId(contactId, "contactId"));
    return contact !== undefined && contact.organizationId === organization ? clone(contact) : null;
  }

  async findContactByEmail(organizationId: string, email: string): Promise<CrmContact | null> {
    const organization = crmOrganization(organizationId);
    const normalized = email.trim().toLowerCase();
    const contacts = await this.#contacts.list({
      filterByFormula: crmOrganizationFormula("Contact JSON", organization),
    });
    return (
      contacts.find(
        (contact) =>
          contact.organizationId === organization &&
          contact.status === "active" &&
          contact.email?.trim().toLowerCase() === normalized,
      ) ?? null
    );
  }

  async saveContact(contact: CrmContact, expectedVersion: number | null): Promise<CrmContact> {
    const organization = crmOrganization(contact.organizationId);
    const existingRecord = await this.#contacts.findWithRecordId(
      requiredId(contact.id, "contactId"),
    );
    const existing = existingRecord?.entity;
    if (existing !== undefined && existing.organizationId !== organization) {
      throw new CrmRepositoryConflictError("The contact belongs to another organization.");
    }
    if (
      expectedVersion === null
        ? existing !== undefined
        : existing === undefined || existing.version !== expectedVersion
    ) {
      throw new CrmRepositoryConflictError("The contact changed before it could be saved.");
    }
    const next: CrmContact = {
      ...clone(contact),
      organizationId: organization,
      version: existing === undefined ? 1 : existing.version + 1,
      createdAt: existing?.createdAt ?? contact.createdAt,
      updatedAt: contact.updatedAt,
    };
    try {
      if (existingRecord === undefined) await this.#contacts.create(next);
      else await this.#contacts.updateByRecordId(next.id, existingRecord.recordId, next);
    } catch (error) {
      throw new CrmRepositoryConflictError(
        error instanceof Error ? error.message : "The contact could not be saved.",
      );
    }
    return clone(next);
  }

  async listSegments(organizationId: string): Promise<readonly CrmSegment[]> {
    const organization = crmOrganization(organizationId);
    return (
      await this.#segments.list({
        filterByFormula: crmOrganizationFormula("Segment JSON", organization),
      })
    )
      .filter((segment) => segment.organizationId === organization)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map(clone);
  }

  async getSegment(organizationId: string, segmentId: string): Promise<CrmSegment | null> {
    const organization = crmOrganization(organizationId);
    const segment = await this.#segments.find(requiredId(segmentId, "segmentId"));
    return segment !== undefined && segment.organizationId === organization ? clone(segment) : null;
  }

  async saveSegment(segment: CrmSegment, expectedVersion: number | null): Promise<CrmSegment> {
    const organization = crmOrganization(segment.organizationId);
    const existingRecord = await this.#segments.findWithRecordId(
      requiredId(segment.id, "segmentId"),
    );
    const existing = existingRecord?.entity;
    if (existing !== undefined && existing.organizationId !== organization) {
      throw new CrmRepositoryConflictError("The segment belongs to another organization.");
    }
    if (
      expectedVersion === null
        ? existing !== undefined
        : existing === undefined || existing.version !== expectedVersion
    ) {
      throw new CrmRepositoryConflictError("The segment changed before it could be saved.");
    }
    const next: CrmSegment = {
      ...clone(segment),
      organizationId: organization,
      version: existing === undefined ? 1 : existing.version + 1,
      createdAt: existing?.createdAt ?? segment.createdAt,
      updatedAt: segment.updatedAt,
    };
    try {
      if (existingRecord === undefined) await this.#segments.create(next);
      else await this.#segments.updateByRecordId(next.id, existingRecord.recordId, next);
    } catch (error) {
      throw new CrmRepositoryConflictError(
        error instanceof Error ? error.message : "The segment could not be saved.",
      );
    }
    return clone(next);
  }

  async deleteSegment(
    organizationId: string,
    segmentId: string,
    expectedVersion: number,
  ): Promise<void> {
    const organization = crmOrganization(organizationId);
    const existingRecord = await this.#segments.findWithRecordId(
      requiredId(segmentId, "segmentId"),
    );
    if (
      existingRecord === undefined ||
      existingRecord.entity.organizationId !== organization ||
      existingRecord.entity.version !== expectedVersion
    ) {
      throw new CrmRepositoryConflictError("The segment changed before it could be deleted.");
    }
    const deleted = await this.#segments.deleteByRecordId(existingRecord.recordId);
    if (!deleted) throw new CrmRepositoryConflictError("The segment could not be deleted.");
  }

  async listHistory(
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmHistoryEntry[]> {
    const organization = crmOrganization(organizationId);
    const contact = requiredId(contactId, "contactId");
    return (
      await this.#history.list({
        filterByFormula: jsonContainsAllFormula("History JSON", [contact]),
      })
    )
      .filter((entry) => entry.organizationId === organization && entry.contactId === contact)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .map(clone);
  }

  async appendHistory(
    entry: CrmHistoryEntry,
    validatedContact?: CrmContact,
  ): Promise<CrmHistoryEntry> {
    const organization = crmOrganization(entry.organizationId);
    if (entry.organizationId !== organization || entry.contactId.trim().length === 0) {
      throw new CrmRepositoryConflictError("History entry tenant data is invalid.");
    }
    const contactRead =
      validatedContact === undefined
        ? this.getContact(organization, entry.contactId)
        : Promise.resolve(
            validatedContact.organizationId === organization &&
              validatedContact.id === entry.contactId
              ? validatedContact
              : null,
          );
    const [contact, existing] = await Promise.all([
      contactRead,
      this.#history.find(requiredId(entry.id, "historyId")),
    ]);
    if (contact === null) {
      throw new CrmRepositoryConflictError(
        "The history contact does not belong to this organization.",
      );
    }
    if (existing !== undefined) {
      if (existing.organizationId !== organization) {
        throw new CrmRepositoryConflictError("The history entry belongs to another organization.");
      }
      return clone(existing);
    }
    try {
      await this.#history.create(clone(entry));
    } catch (error) {
      throw new CrmRepositoryConflictError(
        error instanceof Error ? error.message : "The history entry could not be saved.",
      );
    }
    return clone(entry);
  }

  async listPipelineHistory(
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmPipelineEntry[]> {
    const organization = crmOrganization(organizationId);
    const contact = requiredId(contactId, "contactId");
    return (
      await this.#pipeline.list({
        filterByFormula: jsonContainsAllFormula("Pipeline JSON", [contact]),
      })
    )
      .filter((entry) => entry.organizationId === organization && entry.contactId === contact)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async appendPipeline(entry: CrmPipelineEntry): Promise<CrmPipelineEntry> {
    const organization = crmOrganization(entry.organizationId);
    if (entry.organizationId !== organization || entry.contactId.trim().length === 0) {
      throw new CrmRepositoryConflictError("Pipeline entry tenant data is invalid.");
    }
    const [contact, existing] = await Promise.all([
      this.getContact(organization, entry.contactId),
      this.#pipeline.find(requiredId(entry.id, "pipelineId")),
    ]);
    if (contact === null) {
      throw new CrmRepositoryConflictError(
        "The pipeline contact does not belong to this organization.",
      );
    }
    if (existing !== undefined) {
      if (existing.organizationId !== organization) {
        throw new CrmRepositoryConflictError("The pipeline entry belongs to another organization.");
      }
      return clone(existing);
    }
    try {
      await this.#pipeline.create(clone(entry));
    } catch (error) {
      throw new CrmRepositoryConflictError(
        error instanceof Error ? error.message : "The pipeline entry could not be saved.",
      );
    }
    return clone(entry);
  }

  async listNotes(organizationId: string, contactId: string): Promise<readonly CrmNote[]> {
    const organization = crmOrganization(organizationId);
    const contact = requiredId(contactId, "contactId");
    return (
      await this.#notes.list({
        filterByFormula: jsonContainsAllFormula("Note JSON", [contact]),
      })
    )
      .filter((note) => note.organizationId === organization && note.contactId === contact)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async appendNote(note: CrmNote): Promise<CrmNote> {
    const organization = crmOrganization(note.organizationId);
    if (note.organizationId !== organization || note.contactId.trim().length === 0) {
      throw new CrmRepositoryConflictError("Note tenant data is invalid.");
    }
    const [contact, existing] = await Promise.all([
      this.getContact(organization, note.contactId),
      this.#notes.find(requiredId(note.id, "noteId")),
    ]);
    if (contact === null) {
      throw new CrmRepositoryConflictError(
        "The note contact does not belong to this organization.",
      );
    }
    if (existing !== undefined) {
      if (existing.organizationId !== organization) {
        throw new CrmRepositoryConflictError("The note belongs to another organization.");
      }
      return clone(existing);
    }
    try {
      await this.#notes.create(clone(note));
    } catch (error) {
      throw new CrmRepositoryConflictError(
        error instanceof Error ? error.message : "The note could not be saved.",
      );
    }
    return clone(note);
  }

  async getProjection(
    organizationId: string,
    eventId: string,
    crmContactId: string,
  ): Promise<CrmEventProjection | null> {
    const organization = crmOrganization(organizationId);
    const event = requiredId(eventId, "eventId");
    const contact = requiredId(crmContactId, "crmContactId");
    return this.#findProjection(organization, event, contact);
  }

  async saveProjection(
    projection: CrmEventProjection,
    contact: CrmContact,
  ): Promise<CrmEventProjection> {
    const organization = crmOrganization(projection.organizationId);
    const eventId = requiredId(projection.eventId, "eventId");
    const contactId = requiredId(projection.crmContactId ?? projection.contactId, "crmContactId");
    const participantId = requiredId(projection.participantId ?? contactId, "participantId");
    if (projection.organizationId !== organization) {
      throw new CrmRepositoryConflictError("The projection tenant data is invalid.");
    }
    if (contact.organizationId !== organization || contact.id !== contactId) {
      throw new CrmRepositoryConflictError(
        "The projected contact does not belong to this organization.",
      );
    }
    const eventRepository = this.#events;
    const [authoritativeContact, event, existing] = await Promise.all([
      this.getContact(organization, contactId),
      eventRepository?.getEvent(organization, eventId) ?? Promise.resolve(null),
      this.#findProjection(organization, eventId, contactId),
    ]);
    if (authoritativeContact === null) {
      throw new CrmRepositoryConflictError("The projected contact was not found.");
    }
    if (eventRepository !== undefined && event === null) {
      throw new CrmRepositoryConflictError("The event does not belong to this organization.");
    }
    if (existing !== null) return clone(existing);
    const stored: CrmEventProjection = {
      ...clone(projection),
      id: projection.id,
      organizationId: organization,
      eventId,
      participantId,
      crmContactId: contactId,
      contactId,
    };
    try {
      await this.#projections.create(stored);
    } catch (error) {
      const concurrent = await this.#findProjection(organization, eventId, contactId);
      if (concurrent !== null) return clone(concurrent);
      throw new CrmRepositoryConflictError(
        error instanceof Error ? error.message : "The event projection could not be saved.",
      );
    }
    return clone(stored);
  }

  async listProjections(organizationId: string): Promise<readonly CrmEventProjection[]> {
    const organization = crmOrganization(organizationId);
    return (
      await this.#projections.list({
        filterByFormula: crmOrganizationFormula("Projection JSON", organization),
      })
    )
      .filter((projection) => projection.organizationId === organization)
      .map((projection) => {
        const crmContactId = projection.crmContactId ?? projection.contactId;
        return {
          ...clone(projection),
          participantId: projection.participantId ?? crmContactId,
          crmContactId,
          contactId: crmContactId,
        };
      })
      .sort(
        (left, right) =>
          left.eventId.localeCompare(right.eventId) ||
          left.participantId.localeCompare(right.participantId),
      );
  }

  async listParticipantContactLinks(
    organizationId: string,
  ): Promise<readonly CrmParticipantContactLink[]> {
    return (await this.listProjections(organizationId)).map(
      ({ contactId: _contactId, ...link }) => link,
    );
  }

  async reconcileContactMerge(
    input: CrmMergeReconciliationInput,
  ): Promise<CrmMergeReconciliationResult> {
    const organizationId = crmOrganization(input.organizationId);
    const survivorId = requiredId(input.survivorId, "survivorId");
    const retiredIds = [...new Set(input.retiredIds.map((id) => requiredId(id, "retiredId")))].sort(
      (left, right) => left.localeCompare(right),
    );
    const auditId = requiredId(input.auditId, "auditId");
    if (retiredIds.length === 0 || retiredIds.includes(survivorId)) {
      throw new CrmRepositoryConflictError(
        "Retired CRM contacts must be unique and different from the survivor.",
      );
    }

    const prior = await this.getCommandResult<CrmMergeReconciliationResult>(
      organizationId,
      "reconcile-contact-merge",
      auditId,
    );
    if (prior !== null) {
      if (
        prior.survivorId !== survivorId ||
        JSON.stringify(prior.retiredIds) !== JSON.stringify(retiredIds)
      ) {
        throw new CrmRepositoryConflictError(
          "The CRM merge audit was already used for another reconciliation.",
        );
      }
      return clone(prior);
    }

    const lookupContactIds = [...retiredIds, survivorId];
    const [survivor, retiredContacts, projections, segments, notesByContact, pipelineByContact] =
      await Promise.all([
        this.getContact(organizationId, survivorId),
        Promise.all(retiredIds.map((id) => this.getContact(organizationId, id))),
        this.listProjections(organizationId),
        this.listSegments(organizationId),
        Promise.all(lookupContactIds.map((id) => this.listNotes(organizationId, id))),
        Promise.all(lookupContactIds.map((id) => this.listPipelineHistory(organizationId, id))),
      ]);
    if (survivor === null || survivor.status !== "active") {
      throw new CrmRepositoryConflictError("The CRM merge survivor is not active.");
    }
    for (const [index, retiredId] of retiredIds.entries()) {
      const retired = retiredContacts[index];
      if (
        retired === undefined ||
        retired === null ||
        retired.status !== "merged" ||
        retired.mergedIntoId !== survivorId ||
        retired.mergeAuditId !== auditId
      ) {
        throw new CrmRepositoryConflictError(
          `Retired CRM contact ${retiredId} does not match this merge audit.`,
        );
      }
    }

    const retiredSet = new Set(retiredIds);
    const participantConflicts = crmParticipantMergeConflicts(
      projections,
      new Set([survivorId, ...retiredIds]),
    );
    if (participantConflicts.length > 0) {
      throw new CrmRepositoryConflictError(
        "The merge would reconcile distinct participants in one event.",
        participantConflicts,
      );
    }

    const projectionTargets = projections
      .filter((projection) => {
        const activeContactId = crmProjectionContactId(projection);
        return (
          retiredSet.has(activeContactId) ||
          (projection.mergeAuditId === auditId &&
            projection.sourceCrmContactId !== undefined &&
            retiredSet.has(projection.sourceCrmContactId))
        );
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    const noteTargets = notesByContact
      .flat()
      .filter(
        (note, index, values) =>
          values.findIndex((candidate) => candidate.id === note.id) === index &&
          (retiredSet.has(note.contactId) ||
            (note.mergeAuditId === auditId &&
              note.sourceCrmContactId !== undefined &&
              retiredSet.has(note.sourceCrmContactId))),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const pipelineTargets = pipelineByContact
      .flat()
      .filter(
        (entry, index, values) =>
          values.findIndex((candidate) => candidate.id === entry.id) === index &&
          (retiredSet.has(entry.contactId) ||
            (entry.mergeAuditId === auditId &&
              entry.sourceCrmContactId !== undefined &&
              retiredSet.has(entry.sourceCrmContactId))),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const segmentTargets = segments
      .filter(
        (segment) =>
          segment.mergeAuditIds?.includes(auditId) === true ||
          crmReplaceContactReference(segment.rules, retiredSet, survivorId).changed,
      )
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const projection of projectionTargets) {
      const stored = await this.#projections.findWithRecordId(projection.id);
      if (stored === undefined || stored.entity.organizationId !== organizationId) {
        throw new CrmRepositoryConflictError(
          "A CRM participant link changed during reconciliation.",
        );
      }
      const activeContactId = crmProjectionContactId(stored.entity);
      if (
        activeContactId === survivorId &&
        stored.entity.mergeAuditId === auditId &&
        stored.entity.sourceCrmContactId !== undefined &&
        retiredSet.has(stored.entity.sourceCrmContactId)
      ) {
        continue;
      }
      if (!retiredSet.has(activeContactId)) {
        throw new CrmRepositoryConflictError(
          "A CRM participant link changed during reconciliation.",
        );
      }
      const participantId = crmProjectionParticipantId(stored.entity);
      const next: CrmEventProjection = {
        ...stored.entity,
        participantId,
        crmContactId: survivorId,
        contactId: survivorId,
        sourceCrmContactId: stored.entity.sourceCrmContactId ?? activeContactId,
        mergeAuditId: auditId,
      };
      await this.#projections.updateByRecordId(next.id, stored.recordId, next);
    }

    for (const note of noteTargets) {
      const stored = await this.#notes.findWithRecordId(note.id);
      if (stored === undefined || stored.entity.organizationId !== organizationId) {
        throw new CrmRepositoryConflictError("A CRM note changed during reconciliation.");
      }
      if (stored.entity.contactId === survivorId && stored.entity.mergeAuditId === auditId)
        continue;
      if (!retiredSet.has(stored.entity.contactId)) {
        throw new CrmRepositoryConflictError("A CRM note changed during reconciliation.");
      }
      const next: CrmNote = {
        ...stored.entity,
        contactId: survivorId,
        sourceCrmContactId: stored.entity.sourceCrmContactId ?? stored.entity.contactId,
        mergeAuditId: auditId,
      };
      await this.#notes.updateByRecordId(next.id, stored.recordId, next);
    }

    for (const entry of pipelineTargets) {
      const stored = await this.#pipeline.findWithRecordId(entry.id);
      if (stored === undefined || stored.entity.organizationId !== organizationId) {
        throw new CrmRepositoryConflictError("CRM pipeline history changed during reconciliation.");
      }
      if (stored.entity.contactId === survivorId && stored.entity.mergeAuditId === auditId)
        continue;
      if (!retiredSet.has(stored.entity.contactId)) {
        throw new CrmRepositoryConflictError("CRM pipeline history changed during reconciliation.");
      }
      const next: CrmPipelineEntry = {
        ...stored.entity,
        contactId: survivorId,
        sourceCrmContactId: stored.entity.sourceCrmContactId ?? stored.entity.contactId,
        mergeAuditId: auditId,
      };
      await this.#pipeline.updateByRecordId(next.id, stored.recordId, next);
    }

    for (const segment of segmentTargets) {
      const stored = await this.#segments.findWithRecordId(segment.id);
      if (stored === undefined || stored.entity.organizationId !== organizationId) {
        throw new CrmRepositoryConflictError("A CRM segment changed during reconciliation.");
      }
      if (stored.entity.mergeAuditIds?.includes(auditId) === true) continue;
      const replaced = crmReplaceContactReference(stored.entity.rules, retiredSet, survivorId);
      if (!replaced.changed) {
        throw new CrmRepositoryConflictError("A CRM segment changed during reconciliation.");
      }
      const next: CrmSegment = {
        ...stored.entity,
        rules: replaced.value as CrmSegment["rules"],
        mergeAuditIds: [...new Set([...(stored.entity.mergeAuditIds ?? []), auditId])],
        version: stored.entity.version + 1,
      };
      await this.#segments.updateByRecordId(next.id, stored.recordId, next);
    }

    const result: CrmMergeReconciliationResult = {
      survivorId,
      retiredIds,
      rewired: {
        participantContactLinks: projectionTargets.length,
        notes: noteTargets.length,
        segments: segmentTargets.length,
        pipelineHistory: pipelineTargets.length,
      },
      participantConflicts: [],
      auditId,
    };
    await this.saveCommandResult(organizationId, "reconcile-contact-merge", auditId, result);
    return clone(result);
  }
  async saveOutreach(command: CrmOutreachCommand): Promise<CrmOutreachCommand> {
    const organization = crmOrganization(command.organizationId);
    const key = requiredId(command.idempotencyKey, "idempotencyKey");
    if (command.organizationId !== organization) {
      throw new CrmRepositoryConflictError("The outreach tenant data is invalid.");
    }
    const eventRepository = this.#events;
    const [contact, event, existing] = await Promise.all([
      this.getContact(organization, command.contactId),
      command.eventId !== null && eventRepository !== undefined
        ? eventRepository.getEvent(organization, requiredId(command.eventId, "eventId"))
        : Promise.resolve(null),
      this.#findOutreach(organization, key),
    ]);
    if (contact === null) {
      throw new CrmRepositoryConflictError(
        "The outreach contact does not belong to this organization.",
      );
    }
    if (eventRepository !== undefined && command.eventId !== null && event === null) {
      throw new CrmRepositoryConflictError(
        "The outreach event does not belong to this organization.",
      );
    }
    if (existing !== undefined) {
      if (eventRepository !== undefined && existing.eventId !== null) {
        const existingEvent =
          existing.eventId === command.eventId
            ? event
            : await eventRepository.getEvent(organization, requiredId(existing.eventId, "eventId"));
        if (existingEvent === null) {
          throw new CrmRepositoryConflictError(
            "The outreach event does not belong to this organization.",
          );
        }
      }
      return clone(existing);
    }
    const stored = { ...clone(command), organizationId: organization, idempotencyKey: key };
    try {
      await this.#outreach.create(stored);
    } catch (error) {
      const concurrent = await this.#findOutreach(organization, key);
      if (concurrent !== undefined) return clone(concurrent);
      throw new CrmRepositoryConflictError(
        error instanceof Error ? error.message : "The outreach could not be saved.",
      );
    }
    return clone(stored);
  }
  async updateOutreach(command: CrmOutreachCommand): Promise<CrmOutreachCommand> {
    const organization = crmOrganization(command.organizationId);
    const key = requiredId(command.idempotencyKey, "idempotencyKey");
    const existing = await this.getOutreachByIdempotencyKey(organization, key);
    if (
      existing === null ||
      existing.id !== command.id ||
      existing.contactId !== command.contactId
    ) {
      throw new CrmRepositoryConflictError("The outreach delivery identity does not match.");
    }
    const stored = { ...clone(command), organizationId: organization, idempotencyKey: key };
    await this.#outreach.update(command.id, stored);
    return clone(stored);
  }

  async getOutreachByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<CrmOutreachCommand | null> {
    const organization = crmOrganization(organizationId);
    const key = requiredId(idempotencyKey, "idempotencyKey");
    const command = await this.#findOutreach(organization, key);
    if (command === undefined) return null;
    if (
      command.eventId !== null &&
      this.#events !== undefined &&
      (await this.#events.getEvent(organization, requiredId(command.eventId, "eventId"))) === null
    ) {
      throw new CrmRepositoryConflictError(
        "The outreach event does not belong to this organization.",
      );
    }
    return clone(command);
  }

  async listOutreach(organizationId: string): Promise<readonly CrmOutreachCommand[]> {
    const organization = crmOrganization(organizationId);
    return (
      await this.#outreach.list({
        filterByFormula: crmOrganizationFormula("Outreach JSON", organization),
      })
    )
      .filter((command) => command.organizationId === organization)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async saveImport(result: CrmImportResult): Promise<CrmImportResult> {
    const organization = crmOrganization(result.organizationId);
    if (result.organizationId !== organization) {
      throw new CrmRepositoryConflictError("The import tenant data is invalid.");
    }
    const importId = requiredId(result.id, "importId");
    const key =
      result.idempotencyKey === undefined
        ? undefined
        : requiredId(result.idempotencyKey, "idempotencyKey");
    const stored: CrmImportResult = {
      ...clone(result),
      id: importId,
      organizationId: organization,
      ...(key === undefined ? {} : { idempotencyKey: key }),
    };
    crmNestedTenant(stored, organization);
    if (key === undefined) {
      const existing = await this.#imports.find(importId);
      if (existing !== undefined && existing.organizationId !== organization) {
        throw new CrmRepositoryConflictError("The import belongs to another organization.");
      }
      if (existing !== undefined) crmNestedTenant(existing, organization);
      if (existing === undefined) await this.#imports.create(stored);
      return clone(existing ?? stored);
    }
    const existing = await this.getImportByIdempotencyKey(organization, key);
    if (existing !== null) return clone(existing);
    try {
      await this.#imports.create(stored);
    } catch (error) {
      const concurrent = await this.getImportByIdempotencyKey(organization, key);
      if (concurrent !== null) return clone(concurrent);
      throw new CrmRepositoryConflictError(
        error instanceof Error ? error.message : "The import could not be saved.",
      );
    }
    return clone(stored);
  }

  async getImportByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<CrmImportResult | null> {
    const organization = crmOrganization(organizationId);
    const key = requiredId(idempotencyKey, "idempotencyKey");
    const result = (
      await this.#imports.list({
        filterByFormula: jsonContainsAllFormula("Import JSON", [key]),
      })
    ).find(
      (candidate) => candidate.organizationId === organization && candidate.idempotencyKey === key,
    );
    if (result === undefined) return null;
    crmNestedTenant(result, organization);
    return clone(result);
  }

  async getCommandResult<T>(
    organizationId: string,
    command: string,
    key: string,
  ): Promise<T | null> {
    const organization = crmOrganization(organizationId);
    const commandValue = requiredId(command, "command");
    const keyValue = requiredId(key, "idempotencyKey");
    const id = crmCommandId(organization, commandValue, keyValue);
    const record = await this.#commands.find(id);
    if (record === undefined) return null;
    if (record.organizationId !== organization) return null;
    if (record.command !== commandValue || record.idempotencyKey !== keyValue) return null;
    crmNestedTenant(record.value, organization);
    return clone(record.value as T);
  }

  async saveCommandResult<T>(
    organizationId: string,
    command: string,
    key: string,
    value: T,
  ): Promise<void> {
    const organization = crmOrganization(organizationId);
    const commandValue = requiredId(command, "command");
    const keyValue = requiredId(key, "idempotencyKey");
    const id = crmCommandId(organization, commandValue, keyValue);
    crmNestedTenant(value, organization);
    const existing = await this.#commands.find(id);
    if (existing !== undefined) {
      if (existing.organizationId !== organization) {
        throw new CrmRepositoryConflictError("The command result belongs to another organization.");
      }
      if (existing.command !== commandValue || existing.idempotencyKey !== keyValue) {
        throw new CrmRepositoryConflictError("The command result key is inconsistent.");
      }
      crmNestedTenant(existing.value, organization);
      return;
    }
    const stored: JsonRecord = {
      id,
      organizationId: organization,
      command: commandValue,
      idempotencyKey: keyValue,
      createdAt:
        isRecord(value) && typeof value.createdAt === "string"
          ? value.createdAt
          : new Date().toISOString(),
      value: clone(value),
    };
    await this.#commands.create(stored);
  }
  async #findProjection(
    organizationId: string,
    eventId: string,
    crmContactId: string,
  ): Promise<CrmEventProjection | null> {
    const projection = (
      await this.#projections.list({
        filterByFormula: jsonContainsAllFormula("Projection JSON", [crmContactId]),
      })
    ).find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.eventId === eventId &&
        crmProjectionContactId(candidate) === crmContactId,
    );
    if (projection === undefined) return null;
    return {
      ...clone(projection),
      participantId: crmProjectionParticipantId(projection),
      crmContactId,
      contactId: crmContactId,
    };
  }

  async #findOutreach(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<CrmOutreachCommand | undefined> {
    return (
      await this.#outreach.list({
        filterByFormula: jsonContainsAllFormula("Outreach JSON", [idempotencyKey]),
      })
    ).find(
      (candidate) =>
        candidate.organizationId === organizationId && candidate.idempotencyKey === idempotencyKey,
    );
  }
}

function crmProjectionContactId(projection: CrmEventProjection): string {
  return projection.crmContactId ?? projection.contactId;
}

function crmProjectionParticipantId(projection: CrmEventProjection): string {
  return projection.participantId ?? crmProjectionContactId(projection);
}

function crmParticipantMergeConflicts(
  projections: readonly CrmEventProjection[],
  contactIds: ReadonlySet<string>,
): readonly CrmParticipantConflict[] {
  const byEvent = new Map<string, Map<string, Set<string>>>();
  for (const projection of projections) {
    const crmContactId = crmProjectionContactId(projection);
    if (!contactIds.has(crmContactId)) continue;
    const participants = byEvent.get(projection.eventId) ?? new Map<string, Set<string>>();
    const participantId = crmProjectionParticipantId(projection);
    const participantContacts = participants.get(participantId) ?? new Set<string>();
    participantContacts.add(crmContactId);
    participants.set(participantId, participantContacts);
    byEvent.set(projection.eventId, participants);
  }
  const conflicts: CrmParticipantConflict[] = [];
  for (const [eventId, participants] of byEvent) {
    if (participants.size < 2) continue;
    conflicts.push({
      eventId,
      participantIds: [...participants.keys()].sort((left, right) => left.localeCompare(right)),
      crmContactIds: [...new Set([...participants.values()].flatMap((ids) => [...ids]))].sort(
        (left, right) => left.localeCompare(right),
      ),
      reason: "distinct-participants-share-merged-contacts",
    });
  }
  return conflicts.sort((left, right) => left.eventId.localeCompare(right.eventId));
}

function crmReplaceContactReference(
  value: unknown,
  retiredIds: ReadonlySet<string>,
  survivorId: string,
): { readonly value: unknown; readonly changed: boolean } {
  if (typeof value === "string") {
    return retiredIds.has(value) ? { value: survivorId, changed: true } : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      const replaced = crmReplaceContactReference(item, retiredIds, survivorId);
      changed ||= replaced.changed;
      return replaced.value;
    });
    return { value: changed ? output : value, changed };
  }
  if (isRecord(value)) {
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const replaced = crmReplaceContactReference(item, retiredIds, survivorId);
      changed ||= replaced.changed;
      output[key] = replaced.value;
    }
    return { value: changed ? output : value, changed };
  }
  return { value, changed: false };
}
function crmOrganization(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError("organizationId must be a non-empty string.");
  return normalized;
}

function crmCommandId(organizationId: string, command: string, key: string): string {
  const organization = crmOrganization(organizationId);
  const commandValue = requiredId(command, "command");
  const keyValue = requiredId(key, "idempotencyKey");
  return `crm-command:${organization}:${commandValue}:${keyValue}`;
}

function crmOrganizationFormula(jsonField: string, organizationId: string): string {
  return organizationScopeFormula(jsonField, organizationId, []);
}

function crmNestedTenant(value: unknown, organizationId: string): void {
  const visited = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || visited.has(candidate)) return;
    visited.add(candidate);
    if (isRecord(candidate)) {
      const scope = resolveOrganizationScope(candidate);
      if (scope.status === "conflict") {
        throw new CrmRepositoryConflictError("The command result contains conflicting tenants.");
      }
      if (scope.status === "resolved" && scope.organizationId !== organizationId) {
        throw new CrmRepositoryConflictError("The command result contains another organization.");
      }
      for (const nested of Object.values(candidate)) visit(nested);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const nested of candidate) visit(nested);
    }
  };
  visit(value);
}

/** Durable CRM outreach boundary. The command is persisted in Airtable while the
 * D1-backed outbox is used solely for delivery coordination. */
export class AirtableCrmOutreachBoundary implements CrmOutreachBoundary {
  constructor(
    private readonly repository: Pick<CrmRepository, "getContact">,
    private readonly database: D1Database,
    private readonly outboxQueue: Queue<CloudflareOutboxMessage>,
    private readonly senderAddresses: OpenSendSenderAddresses,
    private readonly events?: Pick<EventRepository, "getEvent">,
  ) {}

  async send(command: CrmOutreachCommand): Promise<CrmOutreachCommand | undefined> {
    const contact = await this.repository.getContact(command.organizationId, command.contactId);
    if (
      command.eventId !== null &&
      this.events !== undefined &&
      (await this.events.getEvent(
        command.organizationId,
        requiredId(command.eventId, "eventId"),
      )) === null
    ) {
      return { ...clone(command), status: "failed" };
    }
    const recipient =
      contact?.status === "active" ? contact.email?.trim().toLowerCase() : undefined;
    if (
      recipient === undefined ||
      recipient.length === 0 ||
      speakerDeliverySenderAddress(recipient, this.senderAddresses)
    ) {
      return { ...clone(command), status: "failed" };
    }
    const idempotencyKey = `crm-outreach:${command.organizationId}:${command.idempotencyKey}`;
    const escapedBody = speakerDeliveryHtml(command.renderedBody).replaceAll("\n", "<br />");
    await enqueueCloudflareOutbox({
      database: this.database,
      queue: this.outboxQueue,
      tenantId: command.organizationId,
      topic: "communications",
      deduplicationKey: idempotencyKey,
      payload: {
        effect: "send_crm_outreach",
        outreachId: command.id,
        contactId: command.contactId,
        eventId: command.eventId,
        idempotencyKey: command.idempotencyKey,
        payload: {
          from: this.senderAddresses.speakers,
          senderPurpose: "speakers",
          to: [recipient],
          subject: command.subject,
          html: `<p>${escapedBody}</p>`,
          text: command.renderedBody,
          idempotencyKey,
        },
      },
      now: command.createdAt,
    });
    return {
      ...clone(command),
      status: "queued",
    };
  }
}
async function enqueueCloudflareOutbox(input: {
  readonly database: D1Database;
  readonly queue: Queue<CloudflareOutboxMessage>;
  readonly tenantId: string;
  readonly topic: CloudflareOutboxMessage["topic"];
  readonly deduplicationKey: string;
  readonly payload: unknown;
  readonly now?: string;
  readonly decisionFence?: {
    readonly eventId: string;
    readonly planId: string;
    readonly submissionId: string;
    readonly version: number;
    readonly status: EvaluationDecisionStatus;
  };
}): Promise<{
  readonly jobId: string;
  readonly inserted: boolean;
  readonly queued: boolean;
  readonly state: string | undefined;
}> {
  const staged = await stageCloudflareOutbox(input);
  if (staged.state !== "pending") {
    return {
      jobId: staged.jobId,
      inserted: staged.inserted,
      queued: false,
      state: staged.state,
    };
  }
  if (input.decisionFence !== undefined) {
    const current = await input.database
      .prepare(
        `SELECT version, status
           FROM evaluation_decisions
          WHERE organization_id = ?
            AND event_id = ?
            AND plan_id = ?
            AND submission_id = ?
          LIMIT 1`,
      )
      .bind(
        input.tenantId,
        input.decisionFence.eventId,
        input.decisionFence.planId,
        input.decisionFence.submissionId,
      )
      .first<{ version: number; status: EvaluationDecisionStatus }>();
    if (
      current === null ||
      current.version !== input.decisionFence.version ||
      current.status !== input.decisionFence.status
    ) {
      return {
        jobId: staged.jobId,
        inserted: false,
        queued: false,
        state: staged.state,
      };
    }
  }
  await input.queue.send({
    version: 1,
    jobId: staged.jobId,
    tenantId: input.tenantId,
    topic: input.topic,
    enqueuedAt: staged.now,
  });
  await input.database
    .prepare(
      "UPDATE outbox_jobs SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'pending'",
    )
    .bind(staged.now, staged.jobId)
    .run();
  return {
    jobId: staged.jobId,
    inserted: staged.inserted,
    queued: true,
    state: "queued",
  };
}

async function stageCloudflareOutbox(input: {
  readonly database: D1Database;
  readonly tenantId: string;
  readonly topic: CloudflareOutboxMessage["topic"];
  readonly deduplicationKey: string;
  readonly payload: unknown;
  readonly now?: string;
  readonly decisionFence?: {
    readonly eventId: string;
    readonly planId: string;
    readonly submissionId: string;
    readonly version: number;
    readonly status: EvaluationDecisionStatus;
  };
}): Promise<{
  readonly jobId: string;
  readonly inserted: boolean;
  readonly now: string;
  readonly state: string | undefined;
}> {
  const now = input.now ?? new Date().toISOString();
  const jobId = `runtime:${input.tenantId}:${input.topic}:${input.deduplicationKey}`;
  const result = await input.database
    .prepare(
      `INSERT INTO outbox_jobs
         (id, tenant_id, topic, deduplication_key, payload_json, state,
          attempt_count, available_at, created_at, updated_at)
       ${
         input.decisionFence === undefined
           ? "VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)"
           : `SELECT ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
              WHERE EXISTS (
                SELECT 1
                FROM evaluation_decisions
                WHERE organization_id = ?
                  AND event_id = ?
                  AND plan_id = ?
                  AND submission_id = ?
                  AND version = ?
                  AND status = ?
              )`
}
       ON CONFLICT (tenant_id, topic, deduplication_key) DO NOTHING`,
    )
    .bind(
      jobId,
      input.tenantId,
      input.topic,
      input.deduplicationKey,
      JSON.stringify(input.payload),
      now,
      now,
      now,
      ...(input.decisionFence === undefined
        ? []
        : [
            input.tenantId,
            input.decisionFence.eventId,
            input.decisionFence.planId,
            input.decisionFence.submissionId,
            input.decisionFence.version,
            input.decisionFence.status,
          ]),
    )
    .run();
  const changes = result.meta?.changes;
  const inserted = changes === undefined || changes > 0;
  const state = inserted
    ? "pending"
    : (
        await input.database
          .prepare("SELECT state FROM outbox_jobs WHERE id = ? LIMIT 1")
          .bind(jobId)
          .first<{ state: string }>()
      )?.state;
  return { jobId, inserted, now, state };
}

async function enqueueCommunicationDeliveryOutbox(input: {
  readonly database: D1Database;
  readonly queue: Queue<CloudflareOutboxMessage>;
  readonly request: CommunicationDeliveryRequest;
  readonly now?: string;
}): Promise<void> {
  const { request } = input;
  const now = input.now ?? new Date().toISOString();
  const fallbackJobId = `runtime:${request.tenantId}:communications:${request.idempotencyKey}`;
  await input.database
    .prepare(
      `INSERT INTO outbox_jobs
         (id, tenant_id, topic, deduplication_key, payload_json, state,
          attempt_count, available_at, created_at, updated_at)
       VALUES (?, ?, 'communications', ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT (tenant_id, topic, deduplication_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at
       WHERE outbox_jobs.state = 'pending'`,
    )
    .bind(
      fallbackJobId,
      request.tenantId,
      request.idempotencyKey,
      JSON.stringify({
        effect: "send_communication",
        sendId: request.sendId,
        recipientId: request.recipientId,
        eventId: request.eventId,
        payload: {
          from: request.from,
          senderPurpose: request.senderPurpose,
          to: [request.to],
          subject: request.subject,
          html: request.html,
          text: request.text,
          idempotencyKey: request.idempotencyKey,
        },
      }),
      now,
      now,
      now,
    )
    .run();
  const row = await input.database
    .prepare(
      "SELECT id, state FROM outbox_jobs WHERE tenant_id = ? AND topic = 'communications' AND deduplication_key = ? LIMIT 1",
    )
    .bind(request.tenantId, request.idempotencyKey)
    .first<{ id: string; state: string }>();
  if (row?.state !== "pending") return;
  await input.queue.send({
    version: 1,
    jobId: row.id,
    tenantId: request.tenantId,
    topic: "communications",
    enqueuedAt: now,
  });
  await input.database
    .prepare(
      "UPDATE outbox_jobs SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'pending'",
    )
    .bind(now, row.id)
    .run();
}

function speakerDeliverySenderAddress(
  email: string,
  senderAddresses: OpenSendSenderAddresses,
): boolean {
  const normalized = email.trim().toLowerCase();
  return Object.values(senderAddresses).some(
    (sender) => sender.trim().toLowerCase() === normalized,
  );
}

function speakerDeliveryHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function compactIdempotencyKey(prefix: string, raw: string): Promise<string> {
  if (raw.length <= 128) return raw;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
  );
  return `${prefix}:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function evaluationReminderAttemptKey(
  baseIdempotencyKey: string,
  priorJobs: readonly Readonly<{ state: string }>[],
): string {
  const terminalAttempts = priorJobs.filter(
    (job) => job.state === "failed" || job.state === "dead-letter",
  ).length;
  const hasNonterminalAttempt = priorJobs.some(
    (job) => job.state !== "failed" && job.state !== "dead-letter",
  );
  return terminalAttempts > 0 && !hasNonterminalAttempt
    ? `${baseIdempotencyKey}:retry-${terminalAttempts}`
    : baseIdempotencyKey;
}

export const EVALUATION_REMINDER_ATTEMPTS_SQL = `SELECT deduplication_key, state
             FROM outbox_jobs
            WHERE tenant_id = ?
              AND topic = 'communications'
              AND (
                deduplication_key = ?
                OR instr(deduplication_key, ? || ':retry-') = 1
              )
            ORDER BY created_at`;

async function speakerDeliveryKey(
  kind: "email" | "invitation" | "reminder",
  organizationId: string,
  eventId: string,
  idempotencyKey: string,
  participantId: string,
): Promise<string> {
  return compactIdempotencyKey(
    `speaker-${kind}`,
    `speaker-${kind}:${organizationId}:${eventId}:${idempotencyKey}:${participantId}`,
  );
}

function reminderTaskSummary(task: SpeakerReminderTask): string {
  const title = task.title.trim();
  const dueAt = task.dueAt?.trim() ?? "";
  return dueAt.length === 0 ? title : `${title} (due ${dueAt})`;
}

export class CloudflareSpeakerDeliveryAdapter
  implements SpeakerReminderDelivery, SpeakerEmailDelivery
{
  constructor(
    private readonly database: D1Database,
    private readonly outboxQueue: Queue<CloudflareOutboxMessage>,
    private readonly webOrigin: string,
    private readonly senderAddresses: OpenSendSenderAddresses,
  ) {}

  enqueue(input: SpeakerReminderDeliveryInput): Promise<SpeakerReminderDeliveryReceipt> {
    return this.enqueueReminder(input);
  }
  async enqueueEmail(input: SpeakerEmailDeliveryInput): Promise<SpeakerEmailDeliveryReceipt> {
    const recipientEmail = await this.verifiedRecipientEmail(input.recipientEmail);
    if (recipientEmail === null) {
      return { status: "failed", reason: "The speaker email recipient is unavailable." };
    }
    const deliveryKey = await speakerDeliveryKey(
      "email",
      input.organizationId,
      input.eventId,
      input.idempotencyKey,
      input.participantId,
    );
    const result = await enqueueCloudflareOutbox({
      database: this.database,
      queue: this.outboxQueue,
      tenantId: input.organizationId,
      topic: "communications",
      deduplicationKey: deliveryKey,
      payload: {
        from: input.sender,
        senderPurpose: "speakers",
        to: [recipientEmail],
        subject: input.subject,
        html: input.html,
        text: input.text,
        idempotencyKey: deliveryKey,
        eventId: input.eventId,
        participantId: input.participantId,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        actorAccountId: input.actorAccountId,
      },
    });
    return { status: "queued", duplicate: !result.inserted };
  }

  queueEmail(input: SpeakerEmailDeliveryInput): Promise<SpeakerEmailDeliveryReceipt> {
    return this.enqueueEmail(input);
  }

  queue(input: SpeakerReminderDeliveryInput): Promise<SpeakerReminderDeliveryReceipt> {
    return this.enqueueReminder(input);
  }

  enqueueReminder(input: SpeakerReminderDeliveryInput): Promise<SpeakerReminderDeliveryReceipt> {
    return this.#enqueueReminder(input);
  }

  enqueueDeliverableReminder(
    input: SpeakerReminderDeliveryInput,
  ): Promise<SpeakerReminderDeliveryReceipt> {
    return this.#enqueueReminder(input);
  }

  async enqueueInvitation(
    input: SpeakerInvitationDeliveryInput,
  ): Promise<SpeakerInvitationDeliveryReceipt> {
    const recipientEmail = await this.verifiedRecipientEmail(input.recipientEmail);
    if (recipientEmail === null) return { status: "failed" };
    const portalPath = "/portal";
    const invitationUrl = new URL("/login", this.webOrigin);
    invitationUrl.searchParams.set("next", portalPath);
    const invitationHref = invitationUrl.toString();
    const escapedInvitationHref = speakerDeliveryHtml(invitationHref);
    const deliveryKey = await speakerDeliveryKey(
      "invitation",
      input.organizationId,
      input.eventId,
      input.idempotencyKey,
      input.participantId,
    );
    const result = await enqueueCloudflareOutbox({
      database: this.database,
      queue: this.outboxQueue,
      tenantId: input.organizationId,
      topic: "communications",
      deduplicationKey: deliveryKey,
      payload: {
        from: this.senderAddresses.speakers,
        senderPurpose: "speakers",
        to: [recipientEmail],
        subject: `Speaker invitation for ${input.eventId}`,
        html: `<p>You are invited to participate as a speaker for <strong>${speakerDeliveryHtml(input.eventId)}</strong>.</p><p><a href="${escapedInvitationHref}">Sign in to the speaker portal</a></p>`,
        text: `You are invited to participate as a speaker for ${input.eventId}. Sign in to the speaker portal: ${invitationHref}`,
        idempotencyKey: deliveryKey,
        eventId: input.eventId,
        participantId: input.participantId,
        templateId: input.templateId,
        actorAccountId: input.actorAccountId,
      },
    });
    return {
      status: "queued",
      duplicate: !result.inserted,
    };
  }

  queueInvitation(
    input: SpeakerInvitationDeliveryInput,
  ): Promise<SpeakerInvitationDeliveryReceipt> {
    return this.enqueueInvitation(input);
  }

  async #enqueueReminder(
    input: SpeakerReminderDeliveryInput,
  ): Promise<SpeakerReminderDeliveryReceipt> {
    const recipientEmail = await this.verifiedRecipientEmail(input.recipient.email);
    if (recipientEmail === null) return { status: "failed", queued: false, duplicate: false };
    if (await this.matchesScheduledReminder(input, recipientEmail)) {
      return { queued: false, duplicate: true };
    }
    const deliveryKey = await speakerDeliveryKey(
      "reminder",
      input.organizationId,
      input.eventId,
      input.idempotencyKey,
      input.recipient.participantId,
    );
    const taskSummaries = input.recipient.tasks
      .map(reminderTaskSummary)
      .filter((summary) => summary.length > 0);
    const taskSummary =
      taskSummaries.length === 0 ? "your outstanding speaker tasks" : taskSummaries.join(", ");
    const escapedSummary = speakerDeliveryHtml(taskSummary);
    const result = await enqueueCloudflareOutbox({
      database: this.database,
      queue: this.outboxQueue,
      tenantId: input.organizationId,
      topic: "communications",
      deduplicationKey: deliveryKey,
      payload: {
        from: this.senderAddresses.speakers,
        senderPurpose: "speakers",
        to: [recipientEmail],
        subject: `Reminder: ${taskSummary}`,
        html: `<p>Please complete ${escapedSummary}.</p>`,
        text: `Please complete ${taskSummary}.`,
        idempotencyKey: deliveryKey,
        eventId: input.eventId,
        participantId: input.recipient.participantId,
        taskIds: [...input.recipient.taskIds],
        actorAccountId: input.actorAccountId,
      },
    });
    if (result.queued) {
      return { id: result.jobId, queued: true, duplicate: false };
    }
    if (["queued", "processing", "delivered"].includes(result.state ?? "")) {
      return { id: result.jobId, queued: false, duplicate: true };
    }
    return {
      id: result.jobId,
      status: "failed",
      queued: false,
      duplicate: false,
    };
  }

  private async matchesScheduledReminder(
    input: SpeakerReminderDeliveryInput,
    recipientEmail: string,
  ): Promise<boolean> {
    const task = input.recipient.tasks.length === 1 ? input.recipient.tasks[0] : undefined;
    const cadenceWindow = task?.cadenceWindow?.trim() ?? "";
    if (task === undefined || cadenceWindow.length === 0) return false;
    const deduplicationKey = [
      "reminder",
      input.organizationId,
      input.eventId,
      "scheduled",
      `task:${task.taskId}`,
      task.participantId,
      cadenceWindow,
    ].join(":");
    const row = await this.database
      .prepare(
        "SELECT state, payload_json FROM outbox_jobs WHERE tenant_id = ? AND topic = 'communications' AND deduplication_key = ? LIMIT 1",
      )
      .bind(input.organizationId, deduplicationKey)
      .first<{ state?: unknown; payload_json?: unknown }>();
    if (row === null || row === undefined) return false;
    const state = typeof row.state === "string" ? row.state : "";
    if (!["pending", "queued", "processing", "delivered"].includes(state)) return false;
    if (typeof row.payload_json !== "string") return false;
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("payload" in parsed) ||
        parsed.payload === null ||
        typeof parsed.payload !== "object"
      ) {
        return false;
      }
      const payload = parsed.payload as Record<string, unknown>;
      const summary = reminderTaskSummary(task);
      const recipients = payload.to;
      return (
        payload.subject === `Reminder: ${summary}` &&
        payload.text === `Please complete ${summary}.` &&
        Array.isArray(recipients) &&
        recipients.length === 1 &&
        recipients[0] === recipientEmail
      );
    } catch {
      return false;
    }
  }

  private async verifiedRecipientEmail(candidate: string | undefined): Promise<string | null> {
    const email = candidate?.trim().toLowerCase() ?? "";
    if (email.length === 0 || speakerDeliverySenderAddress(email, this.senderAddresses))
      return null;
    const row = await this.database
      .prepare(
        `SELECT email
           FROM auth_users
          WHERE LOWER(email) = LOWER(?)
            AND email_verified = 1
          LIMIT 1`,
      )
      .bind(email)
      .first<{ email?: unknown }>();
    const verifiedEmail =
      row !== null && row !== undefined && typeof row.email === "string"
        ? row.email.trim().toLowerCase()
        : "";
    return verifiedEmail.length > 0 &&
      !speakerDeliverySenderAddress(verifiedEmail, this.senderAddresses)
      ? verifiedEmail
      : null;
  }
}
export class AirtableCommunicationDeliveryAdapter implements CommunicationDeliveryAdapter {
  constructor(
    private readonly database: D1Database,
    private readonly queue: Queue<CloudflareOutboxMessage>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async send(request: CommunicationDeliveryRequest) {
    await enqueueCommunicationDeliveryOutbox({
      database: this.database,
      queue: this.queue,
      request,
      now: this.clock().toISOString(),
    });
    return { status: "queued" as const };
  }
}
function remixScoped(value: object, tenantId: string, eventId: string): boolean {
  return scopedRecord(value, tenantId, eventId);
}

function remixCandidateTag(value: object): boolean {
  return entityType(value) === undefined || entityType(value) === "remix_candidate";
}

function remixAuditTag(value: object): boolean {
  return entityType(value) === undefined || entityType(value) === "remix_audit";
}

export class AirtableRemixRepository implements RemixRepository {
  readonly #candidates: AirtableJsonStore<ContentRemixCandidate>;
  readonly #audit: AirtableJsonStore<RemixAuditEntry>;

  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
  }) {
    const shared = { baseId: options.baseId, transport: options.transport };
    this.#candidates = jsonStore(shared, "Remix Candidates", "Candidate JSON");
    this.#audit = jsonStore(shared, "Remix Audit", "Details JSON");
  }

  async getCandidateById(
    tenantId: string,
    candidateId: string,
  ): Promise<ContentRemixCandidate | null> {
    const candidate = await this.#candidates.find(candidateId);
    return candidate !== undefined &&
      candidate.tenantId === tenantId &&
      remixCandidateTag(candidate)
      ? clone(untagged(candidate))
      : null;
  }

  async getCandidate(
    tenantId: string,
    eventId: string,
    candidateId: string,
  ): Promise<ContentRemixCandidate | null> {
    const candidate = await this.getCandidateById(tenantId, candidateId);
    return candidate !== null && candidate.eventId === eventId ? candidate : null;
  }

  async listCandidates(
    tenantId: string,
    eventId: string,
    filter?: RemixCandidateFilter,
  ): Promise<readonly ContentRemixCandidate[]> {
    return (await this.#candidates.list())
      .filter(
        (candidate) =>
          remixCandidateTag(candidate) &&
          remixScoped(candidate, tenantId, eventId) &&
          (filter?.status === undefined || candidate.status === filter.status) &&
          (filter?.sourceType === undefined || candidate.sourceType === filter.sourceType) &&
          (filter?.sourceId === undefined || candidate.sourceId === filter.sourceId),
      )
      .map((candidate) => clone(untagged(candidate)));
  }

  async saveCandidate(
    candidate: ContentRemixCandidate,
    expectedVersion: number | null,
  ): Promise<void> {
    const existing = await this.#candidates.find(candidate.id);
    if (
      (existing?.version ?? null) !== expectedVersion ||
      (existing !== undefined &&
        (existing.tenantId !== candidate.tenantId || existing.eventId !== candidate.eventId))
    ) {
      throw new Error("The remix candidate changed since it was loaded.");
    }
    const stored = tagged(clone(candidate), "remix_candidate");
    if (existing === undefined) await this.#candidates.create(stored);
    else await this.#candidates.update(candidate.id, stored);
  }

  async appendAudit(entry: RemixAuditEntry): Promise<void> {
    const stored = tagged(clone(entry), "remix_audit");
    const existing = await this.#audit.find(entry.id);
    if (existing === undefined) await this.#audit.create(stored);
    else await this.#audit.update(entry.id, stored);
  }

  async listAudit(tenantId: string, eventId: string): Promise<readonly RemixAuditEntry[]> {
    return (await this.#audit.list())
      .filter((entry) => remixAuditTag(entry) && remixScoped(entry, tenantId, eventId))
      .map((entry) => untagged(entry) as RemixAuditEntry);
  }
}

interface D1RemixSessionSource {
  listSessions(tenantId: string, eventId: string): Promise<readonly Session[]>;
  getSession(tenantId: string, eventId: string, sessionId: string): Promise<Session | null>;
  putSession(session: Session, expectedVersion: number | null): Promise<void>;
}

interface D1RemixSpeakerSource {
  listProfilesForEvent(organizationId: string, eventId: string): Promise<SpeakerProfile[]>;
  getProfile(eventId: string, participantId: string): Promise<SpeakerProfile | null>;
  updateBiography(command: UpdateBiographyCommand): Promise<RepositoryResult<SpeakerProfile>>;
}

export class D1RemixContentGateway implements RemixContentGateway {
  constructor(
    private readonly options: {
      readonly sessions: D1RemixSessionSource;
      readonly speakers: D1RemixSpeakerSource;
      readonly database: D1Database;
      readonly queue: Queue<CloudflareOutboxMessage>;
    },
  ) {}

  async listSessions(input: {
    tenantId: string;
    eventId: string;
  }): Promise<readonly RemixSessionRecord[]> {
    return (await this.options.sessions.listSessions(input.tenantId, input.eventId)).map(
      (session) => remixSessionRecord(session),
    );
  }

  async listSpeakers(input: {
    tenantId: string;
    eventId: string;
  }): Promise<readonly RemixSpeakerRecord[]> {
    const profiles = await this.options.speakers.listProfilesForEvent(
      input.tenantId,
      input.eventId,
    );
    return profiles.map((profile) => remixSpeakerRecord(profile));
  }

  async getSession(input: {
    tenantId: string;
    eventId: string;
    sourceId: string;
  }): Promise<RemixSessionRecord | null> {
    const session = await this.options.sessions.getSession(
      input.tenantId,
      input.eventId,
      input.sourceId,
    );
    return session === null ? null : remixSessionRecord(session);
  }

  async getSpeaker(input: {
    tenantId: string;
    eventId: string;
    sourceId: string;
  }): Promise<RemixSpeakerRecord | null> {
    const profile = await this.options.speakers.getProfile(input.eventId, input.sourceId);
    return profile === null ? null : remixSpeakerRecord(profile);
  }

  async applyRevision(input: {
    tenantId: string;
    eventId: string;
    sourceType: "session" | "speaker";
    sourceId: string;
    expectedSourceRevision: number;
    fields: readonly RemixField[];
    content: RemixContent;
    candidateId: string;
    actorId: string;
    appliedAt: string;
  }): Promise<ContentRevision> {
    if (input.sourceType === "session") {
      const current = await this.options.sessions.getSession(
        input.tenantId,
        input.eventId,
        input.sourceId,
      );
      if (current === null || current.version !== input.expectedSourceRevision) {
        throw new Error("The session content changed since remix generation.");
      }
      const content = input.content as Extract<RemixContent, { title: string }>;
      const next: Session = {
        ...current,
        title: content.title,
        description: content.description,
        tagIds: [...(content.tags ?? [])],
        trackIds: [...(content.tracks ?? [])],
        version: current.version + 1,
        updatedAt: input.appliedAt,
        updatedBy: input.actorId,
        history: [
          ...current.history,
          {
            id: `remix:${input.candidateId}`,
            action: "updated",
            version: current.version + 1,
            actorId: input.actorId,
            occurredAt: input.appliedAt,
          },
        ],
      };
      await this.options.sessions.putSession(next, current.version);
      await this.enqueueInvalidation(input, next.version);
      return remixRevision(input, next.version, content);
    }

    const content = input.content as Extract<RemixContent, { biography: string }>;
    const result = await this.options.speakers.updateBiography({
      eventId: input.eventId,
      participantId: input.sourceId,
      biography: content.biography,
      expectedVersion: input.expectedSourceRevision,
      updatedAt: input.appliedAt,
    });
    if (!result.ok) throw new Error("The speaker content changed since remix generation.");
    await this.enqueueInvalidation(input, result.value.version);
    return remixRevision(input, result.value.version, content);
  }

  private async enqueueInvalidation(
    input: {
      tenantId: string;
      eventId: string;
      sourceType: "session" | "speaker";
      sourceId: string;
      appliedAt: string;
    },
    revision: number,
  ): Promise<void> {
    await enqueueCloudflareOutbox({
      database: this.options.database,
      queue: this.options.queue,
      tenantId: input.tenantId,
      topic: "cache-invalidation",
      deduplicationKey: `remix:${input.eventId}:${input.sourceType}:${input.sourceId}:v${revision}`,
      payload: {
        eventId: input.eventId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        revision,
      },
      now: input.appliedAt,
    });
  }
}

function remixSessionRecord(session: Session): RemixSessionRecord {
  return {
    kind: "session",
    id: session.id,
    eventId: session.eventId,
    revision: session.version,
    title: session.title,
    description: session.description,
    tags: [...session.tagIds],
    tracks: [...session.trackIds],
  };
}

function remixSpeakerRecord(profile: SpeakerProfile): RemixSpeakerRecord {
  return {
    kind: "speaker",
    id: profile.participantId,
    eventId: profile.eventId,
    revision: profile.version,
    biography: profile.biography,
  };
}

function remixRevision(
  input: {
    tenantId: string;
    eventId: string;
    sourceType: "session" | "speaker";
    sourceId: string;
    fields: readonly RemixField[];
    candidateId: string;
    actorId: string;
    appliedAt: string;
  },
  sourceRevision: number,
  content: RemixContent,
): ContentRevision {
  return {
    id: `revision:${input.candidateId}`,
    tenantId: input.tenantId,
    eventId: input.eventId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceRevision,
    fields: [...input.fields],
    content: clone(content),
    candidateId: input.candidateId,
    appliedBy: input.actorId,
    appliedAt: input.appliedAt,
  };
}

export class AirtableRemixContentGateway implements RemixContentGateway {
  readonly #sessions: AirtableJsonStore<Session>;
  readonly #events: AirtableJsonStore<JsonRecord>;
  readonly #profiles: AirtableJsonStore<JsonRecord>;
  readonly #database: D1Database;
  readonly #queue: Queue<CloudflareOutboxMessage>;

  constructor(options: {
    readonly baseId: string;
    readonly transport: AirtableTransport;
    readonly database: D1Database;
    readonly queue: Queue<CloudflareOutboxMessage>;
  }) {
    const shared = { baseId: options.baseId, transport: options.transport };
    this.#sessions = jsonStore(shared, "Sessions", "Metadata JSON");
    this.#events = new AirtableJsonStore({
      ...shared,
      table: "Events",
      jsonField: "Settings JSON",
      indexedFields: EVENT_INDEXED_FIELDS,
    });
    this.#profiles = new AirtableJsonStore({
      ...shared,
      table: "Speaker Profiles",
      jsonField: "Biography",
      decode: (fields) => decodeJson<JsonRecord>(fields, "Biography"),
      indexedFields: { Version: "version" },
    });
    this.#database = options.database;
    this.#queue = options.queue;
  }

  async listSessions(input: {
    tenantId: string;
    eventId: string;
    filter?: RemixRecordFilter;
  }): Promise<readonly RemixSessionRecord[]> {
    return (await this.#sessions.list())
      .filter((session) => remixScoped(session, input.tenantId, input.eventId))
      .map((session) => ({
        kind: "session" as const,
        id: session.id,
        eventId: session.eventId,
        revision: session.version,
        title: session.title,
        description: session.description,
        tags: [...session.tagIds],
        tracks: [...session.trackIds],
      }));
  }

  async listSpeakers(input: {
    tenantId: string;
    eventId: string;
    filter?: RemixRecordFilter;
  }): Promise<readonly RemixSpeakerRecord[]> {
    const event = await this.#events.find(input.eventId);
    const eventOrganizationId = resolvedOrganizationId(event);
    return (await this.#profiles.list())
      .filter((profile) =>
        speakerProfileScoped(profile, input.tenantId, input.eventId, eventOrganizationId),
      )
      .flatMap((profile) => {
        const id = textValue(profile, "participantId", "Participant ID", "id");
        const biography = textValue(profile, "biography", "Biography");
        return id === null || biography === null
          ? []
          : [
              {
                kind: "speaker" as const,
                id,
                eventId: input.eventId,
                revision: typeof profile.version === "number" ? profile.version : 1,
                biography,
              },
            ];
      });
  }

  async getSession(input: {
    tenantId: string;
    eventId: string;
    sourceId: string;
  }): Promise<RemixSessionRecord | null> {
    const session = await this.#sessions.find(input.sourceId);
    return session !== undefined && remixScoped(session, input.tenantId, input.eventId)
      ? {
          kind: "session",
          id: session.id,
          eventId: session.eventId,
          revision: session.version,
          title: session.title,
          description: session.description,
          tags: [...session.tagIds],
          tracks: [...session.trackIds],
        }
      : null;
  }

  async getSpeaker(input: {
    tenantId: string;
    eventId: string;
    sourceId: string;
  }): Promise<RemixSpeakerRecord | null> {
    const event = await this.#events.find(input.eventId);
    const eventOrganizationId = resolvedOrganizationId(event);
    const profile = (await this.#profiles.list()).find(
      (candidate) =>
        speakerProfileScoped(candidate, input.tenantId, input.eventId, eventOrganizationId) &&
        textValue(candidate, "participantId", "Participant ID", "id") === input.sourceId,
    );
    if (profile === undefined) return null;
    const biography = textValue(profile, "biography", "Biography");
    if (biography === null) return null;
    return {
      kind: "speaker",
      id: input.sourceId,
      eventId: input.eventId,
      revision: typeof profile.version === "number" ? profile.version : 1,
      biography,
    };
  }

  async applyRevision(input: {
    tenantId: string;
    eventId: string;
    sourceType: "session" | "speaker";
    sourceId: string;
    expectedSourceRevision: number;
    fields: readonly RemixField[];
    content: RemixContent;
    candidateId: string;
    actorId: string;
    appliedAt: string;
  }): Promise<ContentRevision> {
    if (input.sourceType === "session") {
      const current = await this.#sessions.find(input.sourceId);
      if (
        current === undefined ||
        !remixScoped(current, input.tenantId, input.eventId) ||
        current.version !== input.expectedSourceRevision
      ) {
        throw new Error("The session content changed since remix generation.");
      }
      const content = input.content as Extract<RemixContent, { title: string }>;
      const next: Session = {
        ...current,
        title: content.title,
        description: content.description,
        tagIds: [...(content.tags ?? [])],
        trackIds: [...(content.tracks ?? [])],
        version: current.version + 1,
        updatedAt: input.appliedAt,
        updatedBy: input.actorId,
        history: [
          ...current.history,
          {
            id: `remix:${input.candidateId}`,
            action: "updated",
            version: current.version + 1,
            actorId: input.actorId,
            occurredAt: input.appliedAt,
          },
        ],
      };
      await this.#sessions.update(current.id, tagged(next, "session_remix_applied"));
      await enqueueCloudflareOutbox({
        database: this.#database,
        queue: this.#queue,
        tenantId: input.tenantId,
        topic: "cache-invalidation",
        deduplicationKey: `remix:${input.eventId}:session:${input.sourceId}:v${next.version}`,
        payload: {
          eventId: input.eventId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          revision: next.version,
        },
        now: input.appliedAt,
      });
      return {
        id: `revision:${input.candidateId}`,
        tenantId: input.tenantId,
        eventId: input.eventId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceRevision: next.version,
        fields: [...input.fields],
        content: clone(content),
        candidateId: input.candidateId,
        appliedBy: input.actorId,
        appliedAt: input.appliedAt,
      };
    }

    const event = await this.#events.find(input.eventId);
    const eventOrganizationId = resolvedOrganizationId(event);
    const profiles = await this.#profiles.list();
    const profile = profiles.find(
      (candidate) =>
        speakerProfileScoped(candidate, input.tenantId, input.eventId, eventOrganizationId) &&
        textValue(candidate, "participantId", "Participant ID", "id") === input.sourceId,
    );
    if (
      profile === undefined ||
      typeof profile.version !== "number" ||
      profile.version !== input.expectedSourceRevision
    ) {
      throw new Error("The speaker content changed since remix generation.");
    }
    const content = input.content as Extract<RemixContent, { biography: string }>;
    const next = {
      ...profile,
      tenantId: input.tenantId,
      biography: content.biography,
      version: profile.version + 1,
      updatedAt: input.appliedAt,
    };
    await this.#profiles.update(requiredId(profile.id), tagged(next, "speaker_remix_applied"));
    await enqueueCloudflareOutbox({
      database: this.#database,
      queue: this.#queue,
      tenantId: input.tenantId,
      topic: "cache-invalidation",
      deduplicationKey: `remix:${input.eventId}:speaker:${input.sourceId}:v${next.version}`,
      payload: {
        eventId: input.eventId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        revision: next.version,
      },
      now: input.appliedAt,
    });
    return {
      id: `revision:${input.candidateId}`,
      tenantId: input.tenantId,
      eventId: input.eventId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceRevision: next.version,
      fields: [...input.fields],
      content: clone(content),
      candidateId: input.candidateId,
      appliedBy: input.actorId,
      appliedAt: input.appliedAt,
    };
  }
}
export interface D1ApplicationRuntimeOptions {
  readonly authenticator: Pick<RequestAuthenticator, "authenticate">;
  readonly database: D1Database;
  readonly agendaCoordinator: DurableObjectNamespace;
  readonly privateFiles: R2Bucket;
  readonly outboxQueue: Queue<CloudflareOutboxMessage>;
  readonly webOrigin: string;
  readonly aiProviders?: CloudflareAiProviders;
  readonly businessRepositories: D1RuntimeDependencies;
  readonly eventRoleInvitationAdapters: RuntimeEventRoleInvitationAdapters;
  readonly senderAddresses: OpenSendSenderAddresses;
  readonly calendarIntegrationOptions: CalendarIntegrationOptions;
  readonly organizationPolicy?: OrganizationPolicy;
}

export async function reconcilePublishedAgendaCalendarInvitations(input: {
  readonly database: D1Database;
  readonly queue: Queue<CloudflareOutboxMessage>;
  readonly organizationId: string;
  readonly eventId: string;
  readonly revision: PublishedAgendaRevision;
  readonly agendaState: AgendaState;
  readonly profiles: readonly SpeakerProfile[];
  readonly integrationOptions: CalendarIntegrationOptions;
}): Promise<void> {
  const rootRepository = new D1CalendarInvitationRepository({
    database: input.database,
    queue: input.queue,
    organizationId: input.organizationId,
    eventId: input.eventId,
  });
  const persisted = await rootRepository.listForEvent();
  const persistedBySessionId = new Map(persisted.map((item) => [item.sessionId, item.record]));
  const profileByParticipantId = new Map(
    input.profiles.map((profile) => [profile.participantId, profile]),
  );
  const sessionById = new Map(input.agendaState.sessions.map((session) => [session.id, session]));
  const desiredSessionIds = new Set<string>();

  for (const entry of input.revision.entries) {
    const session = sessionById.get(entry.sessionId);
    if (session === undefined) continue;
    const attendees = [
      ...new Set(
        session.participantIds.flatMap((participantId) => {
          const email = profileByParticipantId.get(participantId)?.email?.trim().toLowerCase();
          return email !== undefined && openSendSenderAddressSchema.safeParse(email).success
            ? [email]
            : [];
        }),
      ),
    ].sort();
    if (attendees.length === 0) continue;
    desiredSessionIds.add(session.id);
    const repository = new D1CalendarInvitationRepository({
      database: input.database,
      queue: input.queue,
      organizationId: input.organizationId,
      eventId: input.eventId,
      sessionId: session.id,
    });
    const lifecycle = new CalendarInvitationLifecycle(repository, input.integrationOptions);
    const existing = persistedBySessionId.get(session.id) ?? (await repository.loadForSession());
    const idempotencyKey = await compactIdempotencyKey(
      "agenda-calendar",
      `agenda-calendar:${input.eventId}:${input.revision.id}:${session.id}`,
    );
    const method: CalendarInvitationPayload["method"] =
      existing === undefined || existing === null
        ? "REQUEST"
        : existing.payload.idempotencyKey === idempotencyKey
          ? existing.payload.method
          : "UPDATE";
    await lifecycle.publishPayload({
      method,
      uid:
        existing?.payload.uid ??
        createCalendarUid(
          {
            tenantId: input.organizationId,
            eventId: input.eventId,
            sessionId: session.id,
          },
          input.integrationOptions,
        ),
      sequence: existing?.sequence ?? 0,
      organizer: existing?.payload.organizer ?? input.integrationOptions.organizer,
      attendees,
      summary: entry.metadata?.title || session.title,
      location: entry.metadata?.roomName ?? "",
      timeZone: entry.timeZone,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      idempotencyKey,
    });
  }

  for (const { sessionId, record } of persisted) {
    if (desiredSessionIds.has(sessionId)) continue;
    const idempotencyKey = await compactIdempotencyKey(
      "agenda-calendar-cancel",
      `agenda-calendar-cancel:${input.eventId}:${input.revision.id}:${sessionId}`,
    );
    if (record.payload.method === "CANCEL" && record.payload.idempotencyKey !== idempotencyKey) {
      continue;
    }
    const repository = new D1CalendarInvitationRepository({
      database: input.database,
      queue: input.queue,
      organizationId: input.organizationId,
      eventId: input.eventId,
      sessionId,
    });
    const lifecycle = new CalendarInvitationLifecycle(repository, input.integrationOptions);
    await lifecycle.publishPayload({
      ...record.payload,
      method: "CANCEL",
      sequence: record.sequence,
      idempotencyKey,
    });
  }
}

export class AirtableEvaluationDecisionProjection {
  constructor(
    private readonly cfp: Pick<CfpRepository, "getSubmission">,
    private readonly database: D1Database,
    private readonly queue: Queue<CloudflareOutboxMessage>,
    private readonly communications: Pick<CommunicationRepository, "listTemplates"> | undefined,
    private readonly senderAddresses: OpenSendSenderAddresses,
  ) {}

  async projectDecision(input: EvaluationDecisionProjectionInput): Promise<void> {
    const submission = await this.cfp.getSubmission(input.tenantId, input.submissionId);
    if (submission === null || submission.eventId !== input.eventId) return;
    if (input.isCurrentDecision !== undefined && !(await input.isCurrentDecision())) return;
    const decidedAudience =
      input.status === "accepted"
        ? "accepted_participants"
        : input.status === "waitlisted"
          ? "waitlisted_participants"
          : "rejected_participants";
    const updatedAt = new Date().toISOString();
    const decisionFenceSql = `EXISTS (
      SELECT 1
      FROM evaluation_decisions
      WHERE organization_id = ?
        AND event_id = ?
        AND plan_id = ?
        AND submission_id = ?
        AND version = ?
        AND status = ?
    )`;
    const decisionFenceValues = [
      input.tenantId,
      input.eventId,
      input.planId,
      input.submissionId,
      input.decisionVersion,
      input.status,
    ];
    const audienceStatements: D1PreparedStatement[] = [];
    for (const participant of submission.participants) {
      const displayName =
        `${participant.firstName} ${participant.lastName}`.trim() || participant.email;
      audienceStatements.push(
        this.database
          .prepare(
            `INSERT INTO communication_recipients
               (id, organization_id, event_id, participant_id, email, display_name, data_json, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${decisionFenceSql}
             ON CONFLICT(id) DO UPDATE SET
               email = excluded.email,
               display_name = excluded.display_name,
               data_json = excluded.data_json,
               updated_at = excluded.updated_at`,
          )
          .bind(
            participant.id,
            input.tenantId,
            input.eventId,
            participant.id,
            participant.email,
            displayName,
            JSON.stringify({ submissionId: input.submissionId }),
            updatedAt,
            ...decisionFenceValues,
          ),
        ...(["accepted", "waitlisted", "rejected"] as const).map((status) => {
          const audience =
            status === "accepted"
              ? "accepted_participants"
              : status === "waitlisted"
                ? "waitlisted_participants"
                : "rejected_participants";
          return this.database
            .prepare(
              `DELETE FROM communication_recipient_audiences
                WHERE organization_id = ? AND event_id = ? AND recipient_id = ? AND audience = ?
                  AND NOT EXISTS (
                    SELECT 1
                    FROM submission_participants AS participant_submission
                    JOIN evaluation_decisions AS participant_decision
                      ON participant_decision.organization_id = participant_submission.organization_id
                     AND participant_decision.event_id = participant_submission.event_id
                     AND participant_decision.submission_id = participant_submission.submission_id
                    WHERE participant_submission.organization_id = ?
                      AND participant_submission.event_id = ?
                      AND participant_submission.participant_id = ?
                      AND participant_decision.plan_id = ?
                      AND participant_decision.status = ?
                  )
                  AND ${decisionFenceSql}`,
            )
            .bind(
              input.tenantId,
              input.eventId,
              participant.id,
              audience,
              input.tenantId,
              input.eventId,
              participant.id,
              input.planId,
              status,
              ...decisionFenceValues,
            );
        }),
        this.database
          .prepare(
            `INSERT INTO communication_recipient_audiences
               (organization_id, event_id, recipient_id, audience)
             SELECT ?, ?, ?, ?
             WHERE ${decisionFenceSql}
             ON CONFLICT(organization_id, event_id, recipient_id, audience) DO NOTHING`,
          )
          .bind(
            input.tenantId,
            input.eventId,
            participant.id,
            decidedAudience,
            ...decisionFenceValues,
          ),
      );
    }
    if (input.isCurrentDecision !== undefined && !(await input.isCurrentDecision())) return;
    if (audienceStatements.length > 0) await this.database.batch(audienceStatements);
    if (input.isCurrentDecision !== undefined && !(await input.isCurrentDecision())) return;
    const recipients = submission.participants
      .map((participant) => participant.email.trim())
      .filter((email) => email.length > 0);
    if (recipients.length === 0) return;
    const templatePurpose = input.communication.templatePurpose;
    const idempotencyKey = `decision:${input.idempotencyKey}`;
    const title = submissionTitle(submission);
    const participantNames = submissionParticipants(submission)
      .map((participant) => `${participant.firstName} ${participant.lastName}`.trim())
      .filter((name) => name.length > 0);
    const contextText = [
      `Event ID: ${input.eventId}`,
      `Submission: ${title}`,
      ...(participantNames.length > 0 ? [`Participants: ${participantNames.join(", ")}`] : []),
    ].join("\n");
    const contextHtml = contextText
      .split("\n")
      .map((line) => `<div>${escapeCfpReceiptHtml(line)}</div>`)
      .join("");
    const statusText = `Decision: ${input.status}`;
    const approvedTemplates =
      (await this.communications?.listTemplates(input.tenantId, input.eventId, "decision")) ?? [];
    const template = [...approvedTemplates]
      .filter((candidate) => candidate.status === "approved")
      .sort((left, right) => right.version - left.version)[0];
    const rendered =
      template === undefined
        ? {
            subject: `${input.eventId} — ${title} — ${input.status}`,
            html: `${contextHtml}<div>${escapeCfpReceiptHtml(statusText)}</div>`,
            text: `${contextText}\n${statusText}`,
          }
        : renderTemplate(template, {
            recipient: {
              displayName: participantNames.join(", "),
            },
            eventId: input.eventId,
            submissionId: input.submissionId,
            submissionTitle: title,
            participantNames,
            decisionStatus: input.status,
            decisionReason: input.reason,
          });
    if (input.isCurrentDecision !== undefined && !(await input.isCurrentDecision())) return;
    await enqueueCloudflareOutbox({
      database: this.database,
      queue: this.queue,
      tenantId: input.tenantId,
      topic: "communications",
      deduplicationKey: idempotencyKey,
      payload: {
        from: template?.sender ?? this.senderAddresses.speakers,
        senderPurpose: "speakers",
        to: recipients,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey,
        purpose: "decision",
        templatePurpose,
        templateId: template?.id,
        templateVersion: template?.version,
        status: input.status,
        decisionFence: {
          eventId: input.eventId,
          planId: input.planId,
          submissionId: input.submissionId,
          version: input.decisionVersion,
          status: input.status,
        },
      },
      now: input.decidedAt,
      decisionFence: {
        eventId: input.eventId,
        planId: input.planId,
        submissionId: input.submissionId,
        version: input.decisionVersion,
        status: input.status,
      },
    });
  }
}
export class D1EvaluationReviewerIdentityBoundary implements EvaluationReviewerIdentityBoundary {
  constructor(private readonly database: D1Database) {}

  async resolveReviewerIds(
    actor: EvaluationActor,
    input: {
      readonly eventId: string;
      readonly reviewerIds: readonly string[];
    },
  ): Promise<readonly string[] | null> {
    if (
      actor.kind !== "human" ||
      !actor.grants.some((grant) => grant.eventId === input.eventId && grant.role === "organizer")
    ) {
      return null;
    }

    const resolved: string[] = [];
    for (const candidate of input.reviewerIds) {
      const identifier = candidate.trim();
      if (identifier.length === 0) return null;
      const result = await this.database
        .prepare(
          `SELECT u.id
             FROM auth_users AS u
             INNER JOIN organization_memberships AS m ON m.user_id = u.id
            WHERE m.organization_id = ?
              AND u.email_verified = 1
              AND u.id = ?
            ORDER BY u.id
            LIMIT 2`,
        )
        .bind(actor.tenantId, identifier)
        .all<{ id: string }>();
      const matches = (result.results ?? []).filter(
        (row): row is { id: string } => typeof row.id === "string" && row.id.trim().length > 0,
      );
      if (matches.length !== 1) return null;
      const [match] = matches;
      if (match === undefined || resolved.includes(match.id)) return null;
      resolved.push(match.id);
    }
    return resolved;
  }
}

export class AirtableEvaluationReminderBoundary implements EvaluationReminderBoundary {
  constructor(
    private readonly plans: EvaluationReminderPlanSource,
    private readonly database: D1Database,
    private readonly queue: Queue<CloudflareOutboxMessage>,
    private readonly senderAddresses: OpenSendSenderAddresses,
  ) {}

  async listOutstandingReviewerReminderDeliveries(
    actor: EvaluationActor,
    input: { readonly planId: string },
  ): Promise<readonly EvaluationReminderDeliveryFact[]> {
    const rows = await this.database
      .prepare(
        `SELECT id, payload_json, state, created_at, updated_at, completed_at, last_error_code
           FROM outbox_jobs
          WHERE tenant_id = ?
            AND topic = 'communications'
            AND json_extract(payload_json, '$.planId') = ?
          ORDER BY created_at DESC, id DESC`,
      )
      .bind(actor.tenantId, input.planId)
      .all<{
        id: string;
        payload_json: string;
        state: EvaluationReminderDeliveryFact["status"];
        created_at: string;
        updated_at: string;
        completed_at: string | null;
        last_error_code: string | null;
      }>();
    return (rows.results ?? []).flatMap((row) => {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json) as unknown;
      } catch {
        return [];
      }
      if (!isRecord(payload) || payload.planId !== input.planId) return [];
      const reviewerId = typeof payload.reviewerId === "string" ? payload.reviewerId : null;
      const roundId =
        payload.roundId === null || typeof payload.roundId === "string" ? payload.roundId : null;
      if (reviewerId === null) return [];
      return [
        {
          outboxId: row.id,
          reviewerId,
          roundId,
          status: row.state,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          completedAt: row.completed_at,
          lastErrorCode: row.last_error_code,
        },
      ];
    });
  }

  async sendOutstandingReviewerReminders(
    actor: EvaluationActor,
    input: {
      readonly planId: string;
      readonly roundId?: string | undefined;
      readonly reviewerIds: readonly string[];
      readonly assignmentIds: readonly string[];
    },
  ): Promise<{
    readonly queued: number;
    readonly reviewerIds: readonly string[];
    readonly facts: readonly EvaluationReminderDeliveryFact[];
  }> {
    const plan = await this.plans.getPlan(actor.tenantId, input.planId);
    if (plan === null) return { queued: 0, reviewerIds: [], facts: [] };
    const requestedAssignmentIds = [...new Set(input.assignmentIds)].sort();
    const storedAssignments = await this.plans.listAssignments(actor.tenantId, plan.id);
    const matchingAssignments = storedAssignments.filter(
      (assignment) =>
        requestedAssignmentIds.includes(assignment.id) &&
        input.reviewerIds.includes(assignment.reviewerId) &&
        (input.roundId === undefined || assignment.roundId === input.roundId) &&
        (assignment.status === "assigned" || assignment.status === "in_progress"),
    );
    const assignmentIdsByReviewer = new Map<string, string[]>();
    for (const assignment of matchingAssignments) {
      const ids = assignmentIdsByReviewer.get(assignment.reviewerId) ?? [];
      ids.push(assignment.id);
      assignmentIdsByReviewer.set(assignment.reviewerId, ids);
    }
    const reviewerIds =
      storedAssignments.length === 0
        ? [...new Set(input.reviewerIds)].sort()
        : [...assignmentIdsByReviewer.keys()].sort();
    if (storedAssignments.length > 0 && assignmentIdsByReviewer.size === 0) {
      return { queued: 0, reviewerIds: [], facts: [] };
    }
    let queued = 0;
    for (const reviewerId of reviewerIds) {
      const assignmentIds =
        storedAssignments.length === 0
          ? requestedAssignmentIds
          : (assignmentIdsByReviewer.get(reviewerId) ?? []).sort();
      if (assignmentIds.length === 0) continue;
      const recipient = await this.database
        .prepare(
          `SELECT email
             FROM auth_users
            WHERE id = ? AND email_verified = 1
            LIMIT 1`,
        )
        .bind(reviewerId)
        .first<{ email: string }>();
      const email = recipient?.email.trim();
      if (email === undefined || email.length === 0) continue;
      const round = input.roundId === undefined ? "all rounds" : `round ${input.roundId}`;
      const baseIdempotencyKey = `evaluation-reminder:${input.planId}:${input.roundId ?? "all"}:${reviewerId}`;
      const priorJobs = await this.database
        .prepare(EVALUATION_REMINDER_ATTEMPTS_SQL)
        .bind(actor.tenantId, baseIdempotencyKey, baseIdempotencyKey)
        .all<{ deduplication_key: string; state: string }>();
      const idempotencyKey = evaluationReminderAttemptKey(
        baseIdempotencyKey,
        priorJobs.results ?? [],
      );
      const emailIdempotencyKey = await compactIdempotencyKey(
        "evaluation-reminder",
        idempotencyKey,
      );
      const result = await enqueueCloudflareOutbox({
        database: this.database,
        queue: this.queue,
        tenantId: actor.tenantId,
        topic: "communications",
        deduplicationKey: idempotencyKey,
        payload: {
          effect: "send_email",
          planId: input.planId,
          eventId: plan.eventId,
          reviewerId,
          roundId: input.roundId ?? null,
          assignmentIds,
          payload: {
            from: this.senderAddresses.speakers,
            senderPurpose: "speakers",
            to: [email],
            subject: `Review reminder: ${plan.name}`,
            html: `<p>You have outstanding reviews for <strong>${plan.name}</strong> (${round}).</p>`,
            text: `You have outstanding reviews for ${plan.name} (${round}).`,
            idempotencyKey: emailIdempotencyKey,
          },
        },
      });
      if (result.queued) queued += assignmentIds.length;
    }
    return {
      queued,
      reviewerIds,
      facts: await this.listOutstandingReviewerReminderDeliveries(actor, {
        planId: input.planId,
      }),
    };
  }
}
export async function listProductionOrganizationsForUser(
  database: D1Database,
  userId: string,
): Promise<readonly { organizationId: string; name: string }[]> {
  const rows = await database
    .prepare(
      `SELECT organizations.organization_id, organizations.name
         FROM organizations
        WHERE organizations.organization_id IN (
          SELECT organization_id
            FROM organization_memberships
           WHERE user_id = ?
          UNION
          SELECT grant.organization_id
            FROM participant_grants grant
            JOIN event_role_invitations invitation
              ON invitation.organization_id = grant.organization_id
             AND invitation.event_id = grant.event_id
             AND invitation.role = 'speaker'
             AND invitation.recipient_user_id = grant.user_id
             AND invitation.participant_id = grant.participant_id
             AND invitation.status = 'accepted'
            JOIN speaker_profiles profile
              ON profile.organization_id = grant.organization_id
             AND profile.event_id = grant.event_id
             AND profile.participant_id = grant.participant_id
             AND profile.status <> 'revoked'
           WHERE grant.user_id = ? AND grant.revoked_at IS NULL
          UNION
          SELECT invitation.organization_id
            FROM event_role_invitations AS invitation
            JOIN auth_users AS account ON account.id = invitation.recipient_user_id
           WHERE invitation.recipient_user_id = ?
             AND invitation.role = 'reviewer'
             AND invitation.status = 'accepted'
             AND account.email_verified = 1
        )
        ORDER BY organizations.name, organizations.organization_id`,
    )
    .bind(userId, userId, userId)
    .all<{ organization_id?: unknown; name?: unknown }>();
  return rows.results.flatMap((row) =>
    typeof row.organization_id === "string" &&
    row.organization_id.trim().length > 0 &&
    typeof row.name === "string" &&
    row.name.trim().length > 0
      ? [{ organizationId: row.organization_id, name: row.name }]
      : [],
  );
}

export function createD1ApplicationDependencies(
  options: D1ApplicationRuntimeOptions,
): ApiDependencies {
  const cfpRepository = options.businessRepositories.cfp;
  const eventRepository = options.businessRepositories.events;
  const eventService = new EventService(
    eventRepository,
    {
      async reviewBoundaries(organizationId, eventId) {
        const plans = await options.businessRepositories.evaluations.listPlans(
          organizationId,
          eventId,
        );
        return plans.flatMap((plan) => [
          ...(plan.closesAt === null
            ? []
            : [{ label: "Review deadline", occursAt: plan.closesAt }]),
          ...plan.rounds.flatMap((round) => [
            ...(round.opensAt == null
              ? []
              : [{ label: `Review round ${round.sequence} opening`, occursAt: round.opensAt }]),
            ...(round.closesAt == null
              ? []
              : [{ label: `Review round ${round.sequence} deadline`, occursAt: round.closesAt }]),
          ]),
        ]);
      },
      async agendaState(_organizationId, eventId) {
        const state = await options.businessRepositories.agenda.load(eventId);
        return state === null ? null : { timeZone: state.timeZone };
      },
      async agendaEntries(_organizationId, eventId) {
        const state = await options.businessRepositories.agenda.load(eventId);
        if (state === null) return [];
        const published = state.revisions.find(
          (revision) => revision.id === state.currentPublishedRevisionId,
        );
        return [...state.draft.entries, ...(published?.entries ?? [])].map((entry) => ({
          label: `Agenda entry ${entry.id}`,
          startsAt: entry.startsAt,
          endsAt: entry.endsAt,
          startsAtLocal: entry.startsAtLocal,
          endsAtLocal: entry.endsAtLocal,
        }));
      },
    },
    options.organizationPolicy === undefined
      ? {}
      : { organizationPolicy: options.organizationPolicy },
  );
  const publicationRepository = options.businessRepositories.programPublication;
  let publicationService!: ProgramPublicationService;
  publicationService = new ProgramPublicationService(publicationRepository, {
    eventRepository,
    enqueue: {
      async enqueue(input) {
        const state = await publicationRepository.getState(input.organizationId, input.eventId);
        if (state === null) throw new Error("The pending program publication was not stored.");
        const reservationOwnerId = state.releases.find(
          (release) => release.id === input.releaseId && release.revision === input.revision,
        )?.reservationOwnerId;
        if (reservationOwnerId === null || reservationOwnerId === undefined) {
          throw new Error("The pending program publication is missing reservation ownership.");
        }
        await publicationService.completeRebuild({
          ...input,
          expectedPublicationVersion: state.version,
          reservationOwnerId,
        });
        return { id: input.releaseId };
      },
    },
    cacheInvalidation: {
      async invalidate(input) {
        const [event, state] = await Promise.all([
          eventRepository.getEvent(input.organizationId, input.eventId),
          publicationRepository.getState(input.organizationId, input.eventId),
        ]);
        const pendingRelease = state?.releases.find(
          (release) =>
            release.revision === input.revision &&
            release.cacheRevision === input.cacheRevision &&
            release.lifecycle === "pending",
        );
        if (event === null || pendingRelease === undefined) {
          throw new Error("The pending publication cache invalidation could not be resolved.");
        }
        await stageCloudflareOutbox({
          database: options.database,
          tenantId: input.organizationId,
          topic: "cache-invalidation",
          deduplicationKey: `program-publication:${input.eventId}:release:${pendingRelease.id}`,
          payload: {
            eventId: event.slug,
            revisionId: pendingRelease.agendaProjectionId,
            revisionNumber: pendingRelease.agendaRevisionNumber,
            programRevision: pendingRelease.revision,
          },
          now: pendingRelease.publishedAt,
        });
      },
    },
  });
  const cfpIdempotency = new D1IdempotencyStore(options.database);
  const crmRepository = options.businessRepositories.crm;
  const crmService = new CrmService({
    repository: crmRepository,
    outreach: new AirtableCrmOutreachBoundary(
      crmRepository,
      options.database,
      options.outboxQueue,
      options.senderAddresses,
      eventRepository,
    ),
  });
  const communicationRepository = options.businessRepositories.communications;
  const communicationService = new CommunicationService(
    communicationRepository,
    new AirtableCommunicationDeliveryAdapter(options.database, options.outboxQueue),
    { senderIdentities: options.senderAddresses },
  );
  const speakerRepository = options.businessRepositories.speaker;
  speakerRepository satisfies SpeakerRepository &
    SpeakerOrganizerLifecycleRepository &
    SpeakerAccountWorkloadRepository;
  const privateAssets = new R2PrivateAssetGateway(
    options.privateFiles,
    options.webOrigin,
    options.database,
  );
  const speakerDelivery = new CloudflareSpeakerDeliveryAdapter(
    options.database,
    options.outboxQueue,
    options.webOrigin,
    options.senderAddresses,
  );
  const speakerService = new SpeakerService(speakerRepository, privateAssets, {
    delivery: speakerDelivery,
    communications: new CommunicationSpeakerCommunications(communicationService, options.webOrigin),
    invitationCreator: options.eventRoleInvitationAdapters.speakerCreator,
    speakerSender: options.senderAddresses.speakers,
    eventTemporalSource: {
      async getEventTemporalContext(organizationId, eventId) {
        const event = await eventRepository.getEvent(organizationId, eventId);
        return event === null
          ? null
          : {
              organizationId: event.organizationId,
              eventId: event.id,
              timeZone: event.timeZone,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
            };
      },
    },
  });
  const cfpService = new CfpService({
    repository: cfpRepository,
    idempotency: cfpIdempotency,
    effects: new CloudflareCfpEffects(
      options.outboxQueue,
      options.database,
      options.senderAddresses,
    ),
    organization: {
      async getPublicOrganization(tenantId) {
        const row = await options.database
          .prepare(
            `SELECT organization_id, slug, name
               FROM organizations
              WHERE organization_id = ?
              LIMIT 1`,
          )
          .bind(tenantId)
          .first<{ organization_id: string; slug: string; name: string }>();
        if (row === null) {
          throw new CfpError("NOT_FOUND", "The organization was not found.");
        }
        return {
          id: row.organization_id,
          slug: row.slug,
          name: row.name,
        };
      },
    },
    fileAssets: new D1CfpFileAssetGateway({
      database: options.database,
      cfp: cfpRepository,
      privateAssets,
    }),
  });
  const sessionRepository = options.businessRepositories.sessions;
  let sessionService!: SessionService;
  const agendaRepository = options.businessRepositories.agenda;
  const agendaMutationLock = new CloudflareAgendaMutationLock(options.agendaCoordinator);
  const agendaEngine = new AgendaEngine(agendaRepository, agendaMutationLock, {
    ...(options.aiProviders?.agenda === undefined
      ? {}
      : { suggestionProvider: options.aiProviders.agenda }),
    async eventScheduleForEvent(eventId) {
      const row = await options.database
        .prepare("SELECT organization_id FROM events WHERE id = ? LIMIT 2")
        .bind(eventId)
        .first<{ organization_id: string }>();
      if (row === null) return null;
      const event = await eventRepository.getEvent(row.organization_id, eventId);
      return event === null
        ? null
        : {
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            timeZone: event.timeZone,
            ...(event.scheduleDates === undefined ? {} : { scheduleDates: event.scheduleDates }),
          };
    },
  });
  const agendaCatalogSynchronizer = new AgendaCatalogSynchronizer({
    engine: agendaEngine,
    catalogReader: {
      getAgendaCatalog: (tenantId, eventId) => sessionService.getAgendaCatalog(tenantId, eventId),
    },
  });
  let completeApprovedRevision:
    | ((eventId: string, revision: PublishedAgendaRevision) => Promise<void>)
    | undefined;
  const cacheInvalidatingAgendaCatalogSynchronizer = {
    ensureInitialized: agendaCatalogSynchronizer.ensureInitialized.bind(agendaCatalogSynchronizer),
    async synchronize(input: {
      readonly tenantId: string;
      readonly eventId: string;
      readonly actorId?: string;
      readonly timeZone?: string;
      readonly minimumTravelMinutes?: number;
    }) {
      const synchronized = await agendaCatalogSynchronizer.synchronizePublishedContent(
        input,
        async (current) => {
          const refresh = await agendaEngine.refreshPublishedContent({
            eventId: input.eventId,
            actorId: input.actorId ?? "system:agenda-catalog-sync",
            expectedCatalogVersion: current.draft.version,
            catalog: current.catalog,
            async afterRefresh(result) {
              if (result.revision === null) return;
              if (completeApprovedRevision === undefined) {
                throw new Error("Approved public revision handoff is not initialized.");
              }
              await completeApprovedRevision(input.eventId, result.revision);
            },
          });
          if (refresh.status === "stale") return refresh;
          if (refresh.revision === null) {
            await enqueueCloudflareOutbox({
              database: options.database,
              queue: options.outboxQueue,
              tenantId: input.tenantId,
              topic: "cache-invalidation",
              deduplicationKey: `agenda-catalog:${input.eventId}:draft:${current.draft.version}`,
              payload: {
                eventId: input.eventId,
                draftVersion: current.draft.version,
              },
              now: current.draft.updatedAt,
            });
          }
          return refresh;
        },
      );
      return synchronized.draft;
    },
  };
  sessionService = new SessionService(sessionRepository, {
    agendaCatalogSynchronizer: cacheInvalidatingAgendaCatalogSynchronizer,
  });
  const reportRepository = options.businessRepositories.reports;
  const reportService = new ReportService(
    reportRepository,
    reportRepository,
    new SafeReportExporter(),
  );
  const remixRepository = options.businessRepositories.remix;
  const remixContentGateway = new D1RemixContentGateway({
    sessions: sessionRepository,
    speakers: speakerRepository,
    database: options.database,
    queue: options.outboxQueue,
  });
  const remixService = new RemixService(
    remixRepository,
    remixContentGateway,
    options.aiProviders?.remix,
  );
  const evaluationRepository = options.businessRepositories.evaluations;
  const evaluationSource = new AirtableSubmissionReviewSource(cfpRepository, cfpService);
  const acceptanceHandoff = new AirtableEvaluationAcceptanceHandoff({
    cfp: cfpRepository,
    speakers: speakerRepository,
    sessions: sessionRepository,
    sessionService,
    database: options.database,
    queue: options.outboxQueue,
    invitationCreator: options.eventRoleInvitationAdapters.speakerCreator,
  });
  const evaluationService = new EvaluationService(
    evaluationRepository,
    evaluationSource,
    {
      async getEventMetadata(tenantId, eventId) {
        const event = await eventRepository.getEvent(tenantId, eventId);
        return event === null
          ? null
          : {
              id: event.id,
              name: event.name,
              timeZone: event.timeZone,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
            };
      },
    },
    {
      eventSource: eventRepository,
      acceptanceHandoff,
      decisionProjection: new AirtableEvaluationDecisionProjection(
        cfpRepository,
        options.database,
        options.outboxQueue,
        communicationRepository,
        options.senderAddresses,
      ),
      ...(options.aiProviders?.evaluations === undefined
        ? {}
        : { aiSuggestionProvider: options.aiProviders.evaluations }),
    },
  );
  const evaluationDependencies = {
    service: evaluationService,
    reminders: new AirtableEvaluationReminderBoundary(
      evaluationRepository,
      options.database,
      options.outboxQueue,
      options.senderAddresses,
    ),
    reviewerIdentity: new D1EvaluationReviewerIdentityBoundary(options.database),
    actorFor: createEvaluationActorResolver({
      cfpRepository,
      evaluationRepository,
    }),
  };
  const authenticator = options.authenticator;

  const webhooks = options.businessRepositories.webhooks;
  const publishedSpeakerProjections = new D1PublishedSpeakerProjectionStore(
    options.database,
    eventRepository,
    publicationRepository,
    speakerRepository,
    options.privateFiles,
  );
  const publicProgramReadModel = new D1PublishedProgramReadModel(
    options.database,
    options.privateFiles,
  );
  const organizerOverview = new D1OrganizerOverviewReadModel(options.database);

  const organizerMembership = async (
    principal: AuthPrincipal,
    organizationId: string,
    eventId: string,
  ) => {
    if (principal.kind !== "user") return null;
    const membership = principal.memberships.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        (candidate.role === "owner" || candidate.role === "admin"),
    );
    if (membership === undefined) return null;
    const event = await cfpRepository.getEvent(organizationId, eventId);
    return event === null ? null : membership;
  };
  const communicationActorFor = async (
    principal: AuthPrincipal,
    organizationId: string,
    eventId: string,
  ): Promise<CommunicationActor | null> => {
    const membership = await organizerMembership(principal, organizationId, eventId);
    return membership === null
      ? null
      : {
          tenantId: organizationId,
          userId: principal.kind === "user" ? principal.userId : "",
          kind: "human",
          grants: [{ eventId, role: "organizer" }],
        };
  };
  const reportActorFor = async (
    principal: AuthPrincipal,
    organizationId: string,
    eventId: string,
  ): Promise<ReportActor | null> => {
    const membership = await organizerMembership(principal, organizationId, eventId);
    return membership === null
      ? null
      : {
          tenantId: organizationId,
          userId: principal.kind === "user" ? principal.userId : "",
          kind: "human",
          grants: [{ eventId, role: "organizer", canViewPersonalData: false }],
        };
  };
  const remixActorFor = async (
    principal: AuthPrincipal,
    organizationId: string,
    eventId: string,
  ) => {
    const membership = await organizerMembership(principal, organizationId, eventId);
    return membership === null
      ? null
      : {
          tenantId: organizationId,
          userId: principal.kind === "user" ? principal.userId : "",
          kind: "human" as const,
          grants: [{ eventId, role: "organizer" as const }],
        };
  };

  const dependencies = {
    access: {
      async listOrganizationsForUser(principal) {
        return listProductionOrganizationsForUser(options.database, principal.userId);
      },
      async listEvents(organizationId) {
        return (await eventRepository.listEvents(organizationId)).map((event) => ({
          organizationId: event.organizationId,
          eventId: event.id,
          name: event.name,
        }));
      },
      async listEvaluationPlans(organizationId) {
        return (await evaluationRepository.listPlans(organizationId)).map((plan) => ({
          organizationId: plan.tenantId,
          eventId: plan.eventId,
          planId: plan.id,
          closesAt: plan.closesAt,
        }));
      },
      async listSpeakerContextScopes(userId) {
        if (speakerRepository.listPortalContextScopes === undefined) return [];
        return (await speakerRepository.listPortalContextScopes(userId)).map(
          ({ context, scope, speakerProfileIds }) => ({
            organizationId: scope.tenantId ?? "",
            resolvedOrganizationIds: scope.tenantId === undefined ? [] : [scope.tenantId],
            eventId: context.eventId,
            accountId: userId,
            speakerProfileIds: [...speakerProfileIds],
            participantIds: [...scope.participantIds],
            ...(scope.capabilities === undefined ? {} : { capabilities: [...scope.capabilities] }),
            ...(scope.capabilitiesByParticipant === undefined
              ? {}
              : { capabilitiesByParticipant: scope.capabilitiesByParticipant }),
          }),
        );
      },
      speakerTasks: {
        async resolveScope(principal, organizationId, eventId) {
          const scope = await speakerRepository.getAccessScopeForOrganization(
            organizationId,
            eventId,
            principal.userId,
          );
          if (scope.tenantId !== organizationId) return null;
          return {
            tenantId: scope.tenantId,
            organizationId: scope.tenantId,
            eventId,
            accountId: principal.userId,
            participantIds: scope.participantIds,
            submissionIds: scope.submissionIds,
            ...(scope.capabilities === undefined ? {} : { capabilities: scope.capabilities }),
            ...(scope.capabilitiesByParticipant === undefined
              ? {}
              : { capabilitiesByParticipant: scope.capabilitiesByParticipant }),
          };
        },
        async listSubmissions(organizationId, eventId, submissionIds) {
          const submissions = await speakerRepository.listSubmissionsForOrganization(
            organizationId,
            eventId,
            submissionIds,
          );
          return submissions.map((submission) => ({
            organizationId: submission.tenantId,
            eventId: submission.eventId,
            submissionId: submission.id,
            participantIds: submission.participantIds,
          }));
        },
        async listTasks(organizationId, eventId, participantIds) {
          const tasks = await speakerRepository.listTasksForOrganization(
            organizationId,
            eventId,
            participantIds,
          );
          return tasks.map((task) => ({
            organizationId: task.tenantId,
            eventId: task.eventId,
            taskId: task.id,
            submissionId: task.submissionId,
            participantId: task.participantId,
            owner: task.owner,
            title: task.title,
            dueAt: task.dueAt ?? task.dueDate ?? null,
            status: task.status,
          }));
        },
      },
      reviewerWorkspace: {
        listReviewerWorkspace: evaluationService.listReviewerWorkspace.bind(evaluationService),
      },
    },
    events: { service: eventService, publication: publicationService },
    eventInvitations: { service: options.eventRoleInvitationAdapters.service },
    authenticator,
    speaker: {
      service: speakerService,
      async authenticate(request: Request) {
        const principal = await authenticator.authenticate(request).catch(() => null);
        return principal?.kind === "user" ? { accountId: principal.userId } : null;
      },
    },
    evaluations: evaluationDependencies,
    sessions: { service: sessionService },
    crm: { service: crmService },
    communications: {
      service: communicationService,
      actorFor: communicationActorFor,
    },
    reports: {
      service: reportService,
      actorFor: reportActorFor,
    },
    remix: {
      service: remixService,
      actorFor: remixActorFor,
    },
    agenda: {
      engine: agendaEngine,
      calendarUidDomain: options.calendarIntegrationOptions.uidDomain,
      async organizationIdForEvent(eventId: string) {
        const rows = await options.database
          .prepare("SELECT organization_id FROM events WHERE id = ? LIMIT 2")
          .bind(eventId)
          .all<{ organization_id: string }>();
        const matches = rows.results ?? [];
        return matches.length === 1 ? (matches[0]?.organization_id ?? null) : null;
      },
      async eventMetadataForEvent(eventId: string) {
        const rows = await options.database
          .prepare("SELECT organization_id FROM events WHERE id = ? LIMIT 2")
          .bind(eventId)
          .all<{ organization_id: string }>();
        const matches = rows.results ?? [];
        const organizationId = matches.length === 1 ? matches[0]?.organization_id : undefined;
        if (organizationId === undefined) return null;
        const event = await eventRepository.getEvent(organizationId, eventId);
        if (event === null) return null;
        const startsOn = eventDateOnly(event.startsAt, event.timeZone);
        const endsOn = eventDateOnly(event.endsAt, event.timeZone);
        if (startsOn === null || endsOn === null) return null;
        return {
          slug: event.slug,
          name: event.name,
          timeZone: event.timeZone,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          startsOn,
          endsOn,
          ...(event.scheduleDates === undefined ? {} : { scheduleDates: event.scheduleDates }),
          venueName: event.venue,
        };
      },
      async eventIdForSlug(eventSlug: string) {
        const rows = await options.database
          .prepare("SELECT id FROM events WHERE lower(slug) = ? LIMIT 2")
          .bind(eventSlug.trim().toLowerCase())
          .all<{ id: string }>();
        const matches = rows.results ?? [];
        return matches.length === 1 ? (matches[0]?.id ?? null) : null;
      },
      getProgramPublicationManifest: publishedSpeakerProjections.getProgramPublicationManifest.bind(
        publishedSpeakerProjections,
      ),
      async afterPublish(
        eventId: string,
        revision: PublishedAgendaRevision,
        sourceTrigger:
          | "approved-content-change"
          | "released-schedule-change" = "released-schedule-change",
      ) {
        const currentAgenda = await agendaEngine.getPublishedAgenda(eventId);
        if (currentAgenda === null || currentAgenda.id !== revision.id) return;
        const organizationRows = await options.database
          .prepare("SELECT organization_id FROM events WHERE id = ? LIMIT 2")
          .bind(eventId)
          .all<{ organization_id: string }>();
        const organizationMatches = organizationRows.results ?? [];
        const organizationId =
          organizationMatches.length === 1 ? organizationMatches[0]?.organization_id : undefined;
        if (organizationId === undefined) {
          throw new Error("The published event organization could not be resolved.");
        }
        const [event, agendaState] = await Promise.all([
          eventRepository.getEvent(organizationId, eventId),
          agendaRepository.load(eventId),
        ]);
        if (event === null || agendaState === null) {
          throw new Error("The published event projection could not be loaded.");
        }
        const currentPublication = await publicationService.getState(
          {
            organizationId,
            userId: revision.publishedBy,
            role: "owner",
            kind: "human",
          },
          { organizationId, eventId },
        );
        const enqueuePublicationCacheInvalidation = (manifest: ProgramPublicationManifest) =>
          enqueueCloudflareOutbox({
            database: options.database,
            queue: options.outboxQueue,
            tenantId: organizationId,
            topic: "cache-invalidation",
            deduplicationKey: `program-publication:${eventId}:release:${manifest.id}`,
            payload: {
              eventId: event.slug,
              revisionId: manifest.agendaProjectionId,
              revisionNumber: manifest.agendaRevisionNumber,
              programRevision: manifest.revision,
            },
            now: manifest.publishedAt,
          });
        const servedAgendaRevision = currentPublication?.servedManifest?.agendaRevisionNumber;
        if (servedAgendaRevision !== undefined && servedAgendaRevision > revision.revisionNumber)
          return;
        const alreadyServed = servedAgendaRevision === revision.revisionNumber;
        const servedSpeakerSnapshot =
          sourceTrigger === "approved-content-change"
            ? await Promise.all([
                publishedSpeakerProjections.getPublishedSpeakers(event.slug),
                publishedSpeakerProjections.getPublishedSpeakerHeadshots(event.slug),
              ])
            : null;
        const servedSpeakerProjection = servedSpeakerSnapshot?.[0] ?? null;
        const servedSpeakerHeadshots = servedSpeakerSnapshot?.[1] ?? null;
        if (
          sourceTrigger === "approved-content-change" &&
          (servedSpeakerProjection === null || servedSpeakerHeadshots === null)
        ) {
          throw new Error("The served speaker projection could not be loaded.");
        }

        const trackNameById = new Map(agendaState.tracks.map((track) => [track.id, track.name]));
        const publishedSessionIds = new Set(revision.entries.map((entry) => entry.sessionId));
        const sessions = agendaState.sessions.filter((session) =>
          publishedSessionIds.has(session.id),
        );
        const participantIds = [...new Set(sessions.flatMap((session) => session.participantIds))];
        const [profiles, assets] = await Promise.all([
          speakerRepository.listProfiles(eventId, participantIds),
          speakerRepository.listAssets(eventId, participantIds),
        ]);
        const entriesBySessionId = new Map(
          revision.entries.map((entry) => [entry.sessionId, entry]),
        );
        const sessionsByParticipantId = new Map<
          string,
          Array<{ id: string; title: string; trackNames: readonly string[] }>
        >();
        const approvedSpeakerNameById = new Map<string, string>();
        for (const session of sessions) {
          const entry = entriesBySessionId.get(session.id);
          if (entry === undefined) continue;
          const trackNames = entry.trackIds.flatMap((trackId) => {
            const name = trackNameById.get(trackId);
            return name === undefined ? [] : [name];
          });
          for (const [speakerIndex, participantId] of session.participantIds.entries()) {
            const values = sessionsByParticipantId.get(participantId) ?? [];
            values.push({ id: session.id, title: session.title, trackNames });
            sessionsByParticipantId.set(participantId, values);
            const approvedSpeakerName = entry.metadata?.speakerNames[speakerIndex];
            if (typeof approvedSpeakerName === "string" && approvedSpeakerName.trim().length > 0) {
              approvedSpeakerNameById.set(participantId, approvedSpeakerName);
            }
          }
        }

        const publishedHeadshots = new Map<
          string,
          {
            assetId: string;
            objectKey: string;
            contentType: "image/jpeg" | "image/png" | "image/webp";
            sizeBytes: number;
          }
        >();
        for (const profile of profiles) {
          const asset = selectReleasedSpeakerHeadshot(assets, {
            tenantId: organizationId,
            eventId,
            participantId: profile.participantId,
            ...(profile.headshotAssetId === undefined
              ? {}
              : { selectedAssetId: profile.headshotAssetId }),
          });
          if (asset === undefined) continue;
          const contentType = publishedHeadshotContentType(asset.contentType);
          if (
            contentType === null ||
            asset.sizeBytes <= 0 ||
            !Number.isSafeInteger(asset.sizeBytes)
          ) {
            continue;
          }
          publishedHeadshots.set(profile.participantId, {
            assetId: asset.id,
            objectKey: asset.objectKey,
            contentType,
            sizeBytes: asset.sizeBytes,
          });
        }

        const servedSpeakerById = new Map(
          (servedSpeakerProjection?.speakers ?? []).map((speaker) => [speaker.id, speaker]),
        );
        const profileById = new Map(profiles.map((profile) => [profile.participantId, profile]));
        const speakers = [...sessionsByParticipantId.entries()]
          .map(([participantId, speakerSessions]) => {
            const sessionIds = speakerSessions.map((session) => session.id);
            const sessionTitles = speakerSessions.map((session) => session.title);
            const trackNames = [
              ...new Set(speakerSessions.flatMap((session) => session.trackNames)),
            ].sort();
            const servedSpeaker = servedSpeakerById.get(participantId);
            if (sourceTrigger === "approved-content-change") {
              return servedSpeaker === undefined
                ? {
                    id: participantId,
                    displayName: neutralSpeakerDisplayName(
                      participantId,
                      approvedSpeakerNameById.get(participantId),
                    ),
                    pronouns: null,
                    jobTitle: null,
                    organization: null,
                    biography: "",
                    photoUrl: null,
                    sessionIds,
                    sessionTitles,
                    trackNames,
                  }
                : {
                    ...servedSpeaker,
                    sessionIds,
                    sessionTitles,
                    trackNames,
                  };
            }
            const profile = profileById.get(participantId);
            return {
              id: participantId,
              displayName: neutralSpeakerDisplayName(
                participantId,
                profile?.displayName,
                approvedSpeakerNameById.get(participantId),
              ),
              pronouns: null,
              jobTitle: profile?.jobTitle ?? null,
              organization: profile?.company ?? null,
              biography: profile?.biography ?? "",
              photoUrl: publishedHeadshots.has(participantId)
                ? publishedSpeakerPhotoPath(event.slug, participantId)
                : null,
              sessionIds,
              sessionTitles,
              trackNames,
            };
          })
          .sort((left, right) => left.displayName.localeCompare(right.displayName));
        const agendaHash = await publicationSourceHash(revision);
        const headshots =
          sourceTrigger === "approved-content-change" && servedSpeakerHeadshots !== null
            ? Object.fromEntries(
                Object.entries(servedSpeakerHeadshots).filter(([participantId]) =>
                  sessionsByParticipantId.has(participantId),
                ),
              )
            : Object.fromEntries(publishedHeadshots);
        const speakerHash = await publicationSourceHash({ speakers, headshots });
        const speakerProjectionId = `${revision.id}:${speakerHash}`;
        const publishedSpeakerProjection: PublishedSpeakerProjectionRecord = {
          id: speakerProjectionId,
          organizationId,
          eventId,
          event: {
            slug: event.slug,
            name: event.name,
            timeZone: event.timeZone,
            startsOn: localDateInTimeZone(event.startsAt, event.timeZone),
            endsOn: localDateInTimeZone(event.endsAt, event.timeZone),
            venueName: event.venue,
          },
          revision: {
            id: revision.id,
            number: revision.revisionNumber,
            publishedAt: revision.publishedAt,
          },
          speakers,
          headshots,
          sourceHash: speakerHash,
        };
        const actor = {
          organizationId,
          userId: revision.publishedBy,
          role: "owner" as const,
          kind: "human" as const,
        };
        await agendaMutationLock.renew(eventId);
        const latestAgenda = await agendaEngine.getPublishedAgenda(eventId);
        if (latestAgenda === null || latestAgenda.id !== revision.id) return;
        if (alreadyServed) {
          await reconcilePublishedAgendaCalendarInvitations({
            database: options.database,
            queue: options.outboxQueue,
            organizationId,
            eventId,
            revision,
            agendaState,
            profiles,
            integrationOptions: options.calendarIntegrationOptions,
          });
          const servedManifest = currentPublication?.servedManifest;
          if (servedManifest !== null && servedManifest !== undefined) {
            await enqueuePublicationCacheInvalidation(servedManifest);
          }
          return;
        }
        await agendaMutationLock.renew(eventId);
        await publishedSpeakerProjections.putPublishedSpeakers(
          publishedSpeakerProjection,
          revision,
          agendaHash,
        );
        const pending = await publicationService.reserveRebuild(actor, {
          organizationId,
          eventId,
          trigger:
            currentPublication?.servedManifest === null || currentPublication === null
              ? "initial-publication"
              : sourceTrigger,
          agendaProjectionId: revision.id,
          agendaRevisionNumber: revision.revisionNumber,
          agendaSourceHash: agendaHash,
          speakerProjectionId: publishedSpeakerProjection.id,
          speakerRevisionNumber: publishedSpeakerProjection.revision.number,
          speakerSourceHash: publishedSpeakerProjection.sourceHash ?? publishedSpeakerProjection.id,
          approvedContentRevision: revision.revisionNumber,
          approvedProfileRevision:
            sourceTrigger === "approved-content-change"
              ? (currentPublication?.servedManifest?.approvedProfileRevision ??
                revision.revisionNumber)
              : revision.revisionNumber,
          releasedAssetRevision:
            sourceTrigger === "approved-content-change"
              ? (currentPublication?.servedManifest?.releasedAssetRevision ??
                revision.revisionNumber)
              : revision.revisionNumber,
          parentServedRevision: currentPublication?.servedRevision ?? null,
          reservationOwnerId: agendaMutationLock.currentOperationId(eventId),
        });
        const reservationOwnerId = agendaMutationLock.currentOperationId(eventId);
        const releaseId = pending.pendingReleaseId;
        const pendingRevision = pending.pendingRevision;
        if (releaseId === null || pendingRevision === null) {
          throw new Error("The reserved D1 publication is missing pending release metadata.");
        }
        const pendingManifest = pending.releases.find(
          (release) => release.id === releaseId && release.revision === pendingRevision,
        );
        try {
          await agendaMutationLock.renew(eventId);
          if (pendingManifest === undefined) {
            throw new Error("The reserved D1 publication manifest could not be resolved.");
          }
          await agendaMutationLock.renew(eventId);
          await publicationService.completeRebuild({
            organizationId,
            eventId,
            releaseId,
            revision: pendingRevision,
            expectedPublicationVersion: pending.version,
            reservationOwnerId,
          });
        } catch (error) {
          try {
            await publicationService.failRebuild({
              organizationId,
              eventId,
              releaseId,
              revision: pendingRevision,
              expectedPublicationVersion: pending.version,
              reservationOwnerId,
              reason: error instanceof Error ? error.message : "D1 publication handoff failed.",
            });
          } catch (failure) {
            throw new AggregateError([error, failure], "D1 publication handoff cleanup failed.");
          }
          throw error;
        }
        try {
          await invalidatePublishedSpeakerCache(
            publishedSpeakerProjections,
            event.slug,
            pendingRevision,
            pendingManifest.cacheRevision,
          );
          await invalidatePublishedAgendaCache(
            agendaEngine,
            eventId,
            revision,
            pendingManifest.cacheRevision,
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              level: "error",
              event: "program_publication_cache_invalidation_failed",
              eventId,
              releaseId,
              errorName: error instanceof Error ? error.name : "UnknownError",
            }),
          );
        }
        await agendaMutationLock.renew(eventId);
        const served = await publicationRepository.getState(organizationId, eventId);
        const servedManifest = served?.servedManifest;
        if (servedManifest === null || servedManifest === undefined) {
          throw new Error("The served D1 publication manifest could not be resolved.");
        }
        try {
          await enqueuePublicationCacheInvalidation(servedManifest);
        } catch (error) {
          console.error(
            JSON.stringify({
              level: "error",
              event: "program_publication_cache_dispatch_failed",
              eventId,
              releaseId: servedManifest.id,
              errorName: error instanceof Error ? error.name : "UnknownError",
            }),
          );
        }
        await agendaMutationLock.renew(eventId);
        await reconcilePublishedAgendaCalendarInvitations({
          database: options.database,
          queue: options.outboxQueue,
          organizationId,
          eventId,
          revision,
          agendaState,
          profiles,
          integrationOptions: options.calendarIntegrationOptions,
        });
      },
    },
    publishedSpeakers: publishedSpeakerProjections,
    publishedEvents: {
      async listPublishedEvents() {
        return publicProgramReadModel.listPublicEventDirectory();
      },
    },
    organizerOverview,
    publicApi: {
      contract: publicApiV1Contract,
      resources: [],
    },
    webhooks,
    cfp: { service: cfpService },
  } satisfies ApiDependencies;
  completeApprovedRevision = async (eventId, revision) => {
    await dependencies.agenda.afterPublish(eventId, revision, "approved-content-change");
  };
  return dependencies;
}
