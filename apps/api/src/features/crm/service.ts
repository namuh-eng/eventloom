import {
  type AddContactToEventInput,
  type AddCrmNoteInput,
  type CreateCrmContactInput,
  type CreateCrmSegmentInput,
  type CrmActor,
  type CrmAnalytics,
  type CrmContact,
  type CrmContactInput,
  type CrmContactSearch,
  type CrmContactSource,
  type CrmContactStatus,
  type CrmContactTransitionAudit,
  type CrmDuplicateMatch,
  type CrmDuplicateReport,
  type CrmEventProjection,
  type CrmEventProjectionResult,
  type CrmHistoryEntry,
  type CrmImportResult,
  type CrmImportRow,
  type CrmImportRowResult,
  type CrmMergePlan,
  type CrmMergePreview,
  type CrmMergeReconciliationInput,
  type CrmMergeReconciliationResult,
  type CrmMergeResult,
  type CrmMergeScalarField,
  type CrmNote,
  type CrmOutreachBoundary,
  type CrmOutreachCommand,
  type CrmParticipantConflict,
  type CrmParticipantContactLink,
  type CrmPipelineEntry,
  type CrmPipelineStage,
  type CrmRepository,
  type CrmRepositoryFilter,
  type CrmRepositorySeed,
  type CrmSegment,
  type CrmSegmentRule,
  type CrmServiceDependencies,
  CrmServiceError,
  type CrmServiceOptions,
  type CrmValue,
  type ImportCrmContactsInput,
  type MergeCrmContactsInput,
  type SendCrmOutreachInput,
  type UpdateCrmContactInput,
  type UpdateCrmPipelineInput,
  type UpdateCrmSegmentInput,
} from "./types";

export type { CrmRepository, CrmServiceErrorCode } from "./types";
export { CrmServiceError } from "./types";

export class CrmRepositoryConflictError extends Error {
  constructor(
    message = "The CRM record already exists or changed.",
    readonly details?: unknown,
    readonly current?: CrmContact,
  ) {
    super(message);
    this.name = "CrmRepositoryConflictError";
  }
}
const MAX_ID = 200;
const MAX_TEXT = 20_000;
const MAX_TAG = 100;
const MAX_TAGS = 100;
const MAX_CUSTOM_FIELDS = 100;
const MAX_IMPORT_ROWS = 10_000;
const MAX_SEGMENT_RULES = 50;
const DEFAULT_LIMIT = 100;
const PIPELINE_STAGES: readonly CrmPipelineStage[] = [
  "new",
  "contacted",
  "qualified",
  "invited",
  "registered",
  "accepted",
  "declined",
  "won",
  "lost",
];
const CONTACT_SOURCES: readonly CrmContactSource[] = ["manual", "csv", "speaker", "import"];
const CONTACT_STATUSES: readonly CrmContactStatus[] = ["active", "merged"];
const CRM_MERGE_SCALAR_FIELDS: readonly CrmMergeScalarField[] = [
  "email",
  "phone",
  "name",
  "company",
  "title",
  "bio",
  "headshot",
];
const MERGE_PROFILE_FIELD_ALIASES: Readonly<Record<"bio" | "headshot", readonly string[]>> = {
  bio: ["bio", "biography", "profilebio"],
  headshot: ["headshoturl", "headshot", "headshotassetid", "profileimage"],
};
const EVENT_ROLES = ["speaker", "prospect", "attendee", "sponsor"] as const;
type CrmEventRole = (typeof EVENT_ROLES)[number];

function clone<T>(value: T): T {
  return structuredClone(value);
}
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function fingerprint(value: unknown): string {
  let hash = 2166136261;
  for (const character of stableJson(value)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sameRecord(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function contactComparable(contact: CrmContact): Record<string, unknown> {
  return {
    organizationId: contact.organizationId,
    firstName: contact.firstName,
    lastName: contact.lastName,
    displayName: contact.displayName,
    email: contact.email,
    phone: contact.phone,
    company: contact.company,
    title: contact.title,
    website: contact.website,
    linkedinUrl: contact.linkedinUrl,
    notes: contact.notes,
    tags: contact.tags,
    customFields: contact.customFields,
    source: contact.source,
    status: contact.status,
    mergedIntoId: contact.mergedIntoId,
    pipelineStage: contact.pipelineStage,
  };
}

function replaceContactReference(
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
      const replaced = replaceContactReference(item, retiredIds, survivorId);
      changed ||= replaced.changed;
      return replaced.value;
    });
    return { value: changed ? output : value, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const replaced = replaceContactReference(item, retiredIds, survivorId);
      changed ||= replaced.changed;
      output[key] = replaced.value;
    }
    return { value: changed ? output : value, changed };
  }
  return { value, changed: false };
}

function projectionParticipantId(projection: CrmEventProjection): string {
  return projection.participantId ?? projection.crmContactId ?? projection.contactId;
}

function projectionCrmContactId(projection: CrmEventProjection): string {
  return projection.crmContactId ?? projection.contactId;
}

function participantConflictDetails(
  projections: readonly CrmEventProjection[],
  contactIds: ReadonlySet<string>,
): readonly CrmParticipantConflict[] {
  const byEvent = new Map<string, Map<string, Set<string>>>();
  for (const projection of projections) {
    const crmContactId = projectionCrmContactId(projection);
    if (!contactIds.has(crmContactId)) continue;
    const participants = byEvent.get(projection.eventId) ?? new Map<string, Set<string>>();
    const contacts = participants.get(projectionParticipantId(projection)) ?? new Set<string>();
    contacts.add(crmContactId);
    participants.set(projectionParticipantId(projection), contacts);
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

function rewireCounts(
  projections: readonly CrmEventProjection[],
  notes: readonly CrmNote[],
  segments: readonly CrmSegment[],
  pipeline: readonly CrmPipelineEntry[],
  retiredIds: ReadonlySet<string>,
): CrmMergeReconciliationResult["rewired"] {
  let segmentCount = 0;
  for (const segment of segments) {
    const replaced = replaceContactReference(segment.rules, retiredIds, "");
    if (replaced.changed) segmentCount += 1;
  }
  return {
    participantContactLinks: projections.filter((projection) =>
      retiredIds.has(projectionCrmContactId(projection)),
    ).length,
    notes: notes.filter((note) => retiredIds.has(note.contactId)).length,
    segments: segmentCount,
    pipelineHistory: pipeline.filter((entry) => retiredIds.has(entry.contactId)).length,
  };
}

function invalid(message: string, details?: unknown): CrmServiceError {
  return new CrmServiceError("CRM_INVALID_INPUT", message, 400, details);
}

function forbidden(message = "An owner or administrator is required."): CrmServiceError {
  return new CrmServiceError("CRM_FORBIDDEN", message, 403);
}

function notFound(message = "The CRM record was not found."): CrmServiceError {
  return new CrmServiceError("CRM_NOT_FOUND", message, 404);
}

function conflict(message: string, details?: unknown): CrmServiceError {
  return new CrmServiceError("CRM_CONFLICT", message, 409, details);
}

function dependencyUnavailable(message = "The CRM repository is not configured."): CrmServiceError {
  return new CrmServiceError("CRM_DEPENDENCY_UNAVAILABLE", message, 503);
}

interface CrmRepositoryConflictLike {
  readonly name: "CrmRepositoryConflictError";
  readonly current?: CrmContact;
}

function repositoryConflict(error: unknown): error is CrmRepositoryConflictLike {
  return (
    error instanceof CrmRepositoryConflictError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "CrmRepositoryConflictError")
  );
}

function text(value: unknown, field: string, maximum = MAX_ID): string {
  if (typeof value !== "string") throw invalid(`${field} must be a string.`);
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0 || normalized.length > maximum || unsafeControl(normalized)) {
    throw invalid(`${field} must contain between 1 and ${maximum} safe characters.`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  maximum = MAX_TEXT,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw invalid(`${field} must be a string or null.`);
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length > maximum || unsafeControl(normalized)) {
    throw invalid(`${field} must contain at most ${maximum} safe characters.`);
  }
  return normalized.length === 0 ? null : normalized;
}

function identifier(value: unknown, field: string): string {
  return text(value, field, MAX_ID);
}

function concurrencyVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw invalid("expectedVersion must be a positive integer.");
  return value;
}

function normalizeMergeScalarWinners(
  value: MergeCrmContactsInput["fieldWinners"],
): Readonly<Partial<Record<CrmMergeScalarField, string>>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("fieldWinners must be an object of contact IDs.");
  }
  const normalized: Partial<Record<CrmMergeScalarField, string>> = {};
  for (const [field, winnerId] of Object.entries(value)) {
    if (!CRM_MERGE_SCALAR_FIELDS.includes(field as CrmMergeScalarField)) {
      throw invalid(`fieldWinners.${field} is not a supported merge field.`);
    }
    normalized[field as CrmMergeScalarField] = identifier(winnerId, `fieldWinners.${field}`);
  }
  return normalized;
}

function normalizeMergeCustomFieldWinners(
  value: MergeCrmContactsInput["customFieldWinners"],
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("customFieldWinners must be an object of contact IDs.");
  }
  const normalized: Record<string, string> = {};
  for (const [field, winnerId] of Object.entries(value)) {
    const normalizedField = text(field, "custom field name", 100);
    normalized[normalizedField] = identifier(winnerId, `customFieldWinners.${normalizedField}`);
  }
  return normalized;
}

function nullableEmail(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = text(value, "email", 320).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalized)) throw invalid("email must be a valid email address.");
  return normalized;
}

function unsafeControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

function stage(value: unknown, field = "pipeline stage"): CrmPipelineStage {
  if (typeof value !== "string" || !PIPELINE_STAGES.includes(value as CrmPipelineStage)) {
    throw invalid(`${field} must be one of: ${PIPELINE_STAGES.join(", ")}.`);
  }
  return value as CrmPipelineStage;
}

function source(value: unknown): CrmContactSource {
  if (value === undefined) return "manual";
  if (typeof value !== "string" || !CONTACT_SOURCES.includes(value as CrmContactSource)) {
    throw invalid(`source must be one of: ${CONTACT_SOURCES.join(", ")}.`);
  }
  return value as CrmContactSource;
}

function status(value: unknown): CrmContactStatus {
  if (value === undefined) return "active";
  if (typeof value !== "string" || !CONTACT_STATUSES.includes(value as CrmContactStatus)) {
    throw invalid(`status must be one of: ${CONTACT_STATUSES.join(", ")}.`);
  }
  return value as CrmContactStatus;
}
function eventRole(value: unknown): CrmEventRole {
  if (value === undefined) return "prospect";
  if (typeof value !== "string" || !EVENT_ROLES.includes(value as CrmEventRole)) {
    throw invalid(`role must be one of: ${EVENT_ROLES.join(", ")}.`);
  }
  return value as CrmEventRole;
}

function boundedLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 500) {
    throw invalid("limit must be between 1 and 500.");
  }
  return value as number;
}

function nowIso(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("CRM clock returned an invalid date.");
  }
  return value.toISOString();
}

function normalizeTags(values: unknown, field = "tags"): readonly string[] {
  if (values === undefined || values === null) return [];
  const candidates =
    typeof values === "string" ? values.split(",") : Array.isArray(values) ? values : null;
  if (candidates === null) throw invalid(`${field} must be an array of strings.`);
  if (candidates.length > MAX_TAGS)
    throw invalid(`${field} cannot contain more than ${MAX_TAGS} values.`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of candidates) {
    const normalized = text(value, `${field} value`, MAX_TAG).toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function cloneCrmValue(value: unknown, path: string, depth = 0): CrmValue {
  if (depth > 5) throw invalid(`${path} is nested too deeply.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(`${path} must be finite.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw invalid(`${path} cannot contain more than 100 values.`);
    return value.map((item, index) => cloneCrmValue(item, `${path}[${index}]`, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, CrmValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = text(key, `${path} key`, 100);
      output[normalizedKey] = cloneCrmValue(item, `${path}.${normalizedKey}`, depth + 1);
    }
    return output;
  }
  throw invalid(`${path} contains an unsupported value.`);
}

function normalizeCustomFields(value: unknown): Readonly<Record<string, CrmValue>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalid("customFields must be an object.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_CUSTOM_FIELDS) {
    throw invalid(`customFields cannot contain more than ${MAX_CUSTOM_FIELDS} values.`);
  }
  const result: Record<string, CrmValue> = {};
  for (const [key, item] of entries) {
    const normalizedKey = text(key, "custom field name", 100);
    result[normalizedKey] = cloneCrmValue(item, `customFields.${normalizedKey}`);
  }
  return result;
}

function normalizedName(input: CrmContactInput): {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly displayName: string;
} {
  const firstName = optionalText(input.firstName, "firstName", 200) ?? null;
  const lastName = optionalText(input.lastName, "lastName", 200) ?? null;
  const explicit = optionalText(input.displayName, "displayName", 300);
  const displayName =
    explicit ?? [firstName, lastName].filter((part): part is string => part !== null).join(" ");
  if (displayName === null || displayName.length === 0) {
    throw invalid("A contact needs displayName, firstName/lastName, or email.");
  }
  return { firstName, lastName, displayName };
}
function outreachNameParts(contact: Pick<CrmContact, "firstName" | "lastName" | "displayName">): {
  readonly firstName: string;
  readonly lastName: string;
} {
  const displayParts = contact.displayName.trim().split(/\s+/u).filter(Boolean);
  const fallbackFirstName = displayParts[0] ?? "";
  const fallbackLastName = displayParts.slice(1).join(" ");
  return {
    firstName: contact.firstName?.trim() || fallbackFirstName,
    lastName: contact.lastName?.trim() || fallbackLastName,
  };
}

function contactMergeTagValues(contact: CrmContact): Readonly<Record<string, string>> {
  const displayName = contact.displayName.trim();
  const { firstName, lastName } = outreachNameParts(contact);
  return {
    first_name: firstName,
    firstName,
    last_name: lastName,
    lastName,
    display_name: displayName,
    displayName,
    email: contact.email?.trim() ?? "",
    company: contact.company?.trim() ?? "",
    title: contact.title?.trim() ?? "",
  };
}

function canonical(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function contactField(contact: CrmContact, field: string): unknown {
  if (field.startsWith("custom.")) return contact.customFields[field.slice("custom.".length)];
  if (field in contact) return (contact as unknown as Record<string, unknown>)[field];
  return contact.customFields[field];
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right))
    return left.some((value) => right.includes(value));
  if (typeof left === "string" && typeof right === "string")
    return canonical(left) === canonical(right);
  return left === right;
}

function segmentMatches(contact: CrmContact, rules: readonly CrmSegmentRule[]): boolean {
  return rules.every((rule) => {
    const actual = contactField(contact, rule.field);
    const value = rule.value;
    switch (rule.operator) {
      case "exists":
        return actual !== undefined && actual !== null && actual !== "";
      case "eq":
        return sameValue(actual, value);
      case "neq":
        return !sameValue(actual, value);
      case "contains":
        if (Array.isArray(actual)) return actual.some((item) => sameValue(item, value));
        return (
          typeof actual === "string" &&
          typeof value === "string" &&
          actual.toLowerCase().includes(value.toLowerCase())
        );
      case "startsWith":
        return (
          typeof actual === "string" &&
          typeof value === "string" &&
          actual.toLowerCase().startsWith(value.toLowerCase())
        );
      case "endsWith":
        return (
          typeof actual === "string" &&
          typeof value === "string" &&
          actual.toLowerCase().endsWith(value.toLowerCase())
        );
      case "in":
        return Array.isArray(value) && value.some((candidate) => sameValue(actual, candidate));
      case "notIn":
        return Array.isArray(value) && !value.some((candidate) => sameValue(actual, candidate));
      default:
        return false;
    }
  });
}

function parseCsv(csv: string): readonly Record<string, string>[] {
  const input = text(csv, "csv", 2_000_000);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw invalid("csv contains an unterminated quoted field.");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length < 2) throw invalid("csv must contain a header and at least one row.");
  const headers = rows[0]?.map((header) => header.trim()) ?? [];
  if (headers.length === 0 || headers.some((header) => header.length === 0)) {
    throw invalid("csv headers must not be empty.");
  }
  if (new Set(headers.map((header) => header.toLowerCase())).size !== headers.length) {
    throw invalid("csv headers must be unique.");
  }
  return rows
    .slice(1)
    .filter((values) => values.some((value) => value.trim().length > 0))
    .map((values) => {
      const result: Record<string, string> = {};
      for (let index = 0; index < headers.length; index += 1)
        result[headers[index] ?? ""] = values[index] ?? "";
      return result;
    });
}

const CSV_FIELD_TARGETS: Readonly<Record<string, string>> = {
  firstname: "firstName",
  "first name": "firstName",
  lastname: "lastName",
  "last name": "lastName",
  name: "displayName",
  displayname: "displayName",
  "display name": "displayName",
  email: "email",
  phone: "phone",
  company: "company",
  title: "title",
  jobtitle: "title",
  "job title": "title",
  website: "website",
  linkedin: "linkedinUrl",
  linkedinurl: "linkedinUrl",
  notes: "notes",
  tags: "tags",
  source: "source",
  pipelinestage: "pipelineStage",
  stage: "pipelineStage",
};

function importColumnMapping(columns: readonly string[]): CrmImportResult["mapping"] {
  const directFields = new Set([
    "firstName",
    "lastName",
    "displayName",
    "email",
    "phone",
    "company",
    "title",
    "website",
    "linkedinUrl",
    "notes",
    "tags",
    "customFields",
    "source",
    "pipelineStage",
  ]);
  return columns.map((sourceColumn) => {
    const trimmed = sourceColumn.trim();
    const direct = directFields.has(trimmed) ? trimmed : undefined;
    const target = direct ?? CSV_FIELD_TARGETS[trimmed.toLowerCase()];
    return {
      sourceColumn,
      targetField: target ?? `custom.${trimmed}`,
      custom: target === undefined,
    };
  });
}

function csvRowInput(row: Record<string, string>): CrmImportRow {
  const known: Record<string, unknown> = {};
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const trimmedKey = key.trim();
    const target = CSV_FIELD_TARGETS[trimmedKey.toLowerCase()];
    if (target === "email") known.email = value;
    else if (value.trim().length === 0) continue;
    else if (target === "tags") known.tags = value.split(",");
    else if (target !== undefined) known[target] = value;
    else if (trimmedKey.length > 0) customFields[trimmedKey] = value;
  }
  if (Object.keys(customFields).length > 0) known.customFields = customFields;
  return known as CrmImportRow;
}

function normalizeImportRow(row: CrmImportRow): CrmImportRow {
  const normalized: Record<string, unknown> = { ...row };
  for (const field of [
    "firstName",
    "lastName",
    "displayName",
    "phone",
    "company",
    "title",
    "website",
    "linkedinUrl",
    "notes",
    "source",
    "pipelineStage",
  ] as const) {
    const value = normalized[field];
    if (typeof value === "string" && value.trim().length === 0) delete normalized[field];
  }
  const jobTitle = normalized.jobTitle;
  if (
    normalized.title === undefined &&
    typeof jobTitle === "string" &&
    jobTitle.trim().length > 0
  ) {
    normalized.title = jobTitle;
  }
  return normalized as CrmImportRow;
}

function normalizeSegmentRules(value: unknown): readonly CrmSegmentRule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SEGMENT_RULES) {
    throw invalid(`rules must contain between 1 and ${MAX_SEGMENT_RULES} entries.`);
  }
  return value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw invalid(`rules[${index}] must be an object.`);
    }
    const record = candidate as Record<string, unknown>;
    const field = text(record.field, `rules[${index}].field`, 200);
    const operator = record.operator;
    if (
      operator !== "eq" &&
      operator !== "neq" &&
      operator !== "contains" &&
      operator !== "startsWith" &&
      operator !== "endsWith" &&
      operator !== "in" &&
      operator !== "notIn" &&
      operator !== "exists"
    ) {
      throw invalid(`rules[${index}].operator is invalid.`);
    }
    const normalized: CrmSegmentRule = {
      field,
      operator,
      ...(record.value === undefined
        ? {}
        : { value: cloneCrmValue(record.value, `rules[${index}].value`) }),
    };
    if (operator !== "exists" && record.value === undefined)
      throw invalid(`rules[${index}].value is required.`);
    return normalized;
  });
}

function assertActor(actor: CrmActor, organizationId: string): void {
  if (
    actor === null ||
    typeof actor !== "object" ||
    actor.kind !== "user" ||
    typeof actor.organizationId !== "string" ||
    actor.organizationId.trim() !== organizationId ||
    typeof actor.userId !== "string" ||
    actor.userId.trim().length === 0
  ) {
    throw forbidden("The authenticated organizer cannot access this organization.");
  }
  if (actor.role !== "owner" && actor.role !== "admin" && actor.role !== "organizer") {
    throw forbidden();
  }
}

function assertTenant<T extends { organizationId: string }>(record: T, organizationId: string): T {
  if (record.organizationId !== organizationId)
    throw forbidden("The CRM repository returned a cross-tenant record.");
  return record;
}

function normalizeSearch(input: CrmContactSearch | undefined): CrmContactSearch {
  if (input === undefined) return {};
  const output: CrmContactSearch = {
    ...(input.query === undefined ? {} : { query: text(input.query, "query", 500) }),
    ...(input.email === undefined ? {} : { email: text(input.email, "email", 320).toLowerCase() }),
    ...(input.eventId === undefined ? {} : { eventId: identifier(input.eventId, "eventId") }),
    ...(input.tags === undefined ? {} : { tags: normalizeTags(input.tags, "tags") }),
    ...(input.pipelineStage === undefined ? {} : { pipelineStage: stage(input.pipelineStage) }),
    ...(input.status === undefined ? {} : { status: status(input.status) }),
    ...(input.company === undefined ? {} : { company: text(input.company, "company", 300) }),
    ...(input.limit === undefined ? {} : { limit: boundedLimit(input.limit) }),
    ...(input.cursor === undefined ? {} : { cursor: text(input.cursor, "cursor", 500) }),
  };
  return output;
}

export class CrmService {
  readonly #repository: CrmRepository | undefined;
  readonly #outreach: CrmOutreachBoundary | undefined;
  readonly #clock: () => Date;
  readonly #generateId: (prefix: string) => string;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(
    dependencies: CrmServiceDependencies | CrmRepository | undefined = undefined,
    options: CrmServiceOptions = {},
  ) {
    if (dependencies !== undefined && "repository" in dependencies) {
      this.#repository = dependencies.repository;
      this.#outreach = dependencies.outreach;
    } else {
      this.#repository = dependencies as CrmRepository | undefined;
      this.#outreach = undefined;
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#generateId = options.generateId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
  }

  async listContacts(actor: CrmActor, input?: CrmRepositoryFilter): Promise<readonly CrmContact[]>;
  async listContacts(
    actor: CrmActor,
    organizationId: string,
    input?: CrmContactSearch,
  ): Promise<readonly CrmContact[]>;
  async listContacts(
    actor: CrmActor,
    organizationOrInput: string | CrmRepositoryFilter = actor.organizationId,
    search?: CrmContactSearch,
  ): Promise<readonly CrmContact[]> {
    const organizationId =
      typeof organizationOrInput === "string"
        ? identifier(organizationOrInput, "organizationId")
        : identifier(organizationOrInput.organizationId ?? actor.organizationId, "organizationId");
    assertActor(actor, organizationId);
    const filter = normalizeSearch(
      typeof organizationOrInput === "string" ? search : organizationOrInput,
    );
    const repository = this.requireRepository();
    const records = await repository.listContacts(organizationId, {
      ...filter,
      organizationId,
    });
    const visible = records.filter((record) => record.organizationId === organizationId).map(clone);
    const limit = filter.limit ?? DEFAULT_LIMIT;
    const offset =
      filter.cursor === undefined ? 0 : Math.max(0, Number.parseInt(filter.cursor, 10) || 0);
    return visible.slice(offset, offset + limit);
  }

  async searchContacts(
    actor: CrmActor,
    input?: CrmRepositoryFilter,
  ): Promise<readonly CrmContact[]>;
  async searchContacts(
    actor: CrmActor,
    organizationId: string,
    search?: CrmContactSearch,
  ): Promise<readonly CrmContact[]>;
  async searchContacts(
    actor: CrmActor,
    organizationOrInput: string | CrmRepositoryFilter = actor.organizationId,
    search?: CrmContactSearch,
  ): Promise<readonly CrmContact[]> {
    return typeof organizationOrInput === "string"
      ? this.listContacts(actor, organizationOrInput, search)
      : this.listContacts(actor, organizationOrInput);
  }

  async getContact(
    actor: CrmActor,
    organizationId: string,
    contactId: string,
  ): Promise<CrmContact> {
    const organization = identifier(organizationId, "organizationId");
    const id = identifier(contactId, "contactId");
    assertActor(actor, organization);
    const contact = await this.requireRepository().getContact(organization, id);
    if (contact === null || contact.organizationId !== organization)
      throw notFound("The contact was not found.");
    return clone(contact);
  }

  async createContact(actor: CrmActor, input: CreateCrmContactInput): Promise<CrmContact> {
    const organizationId = identifier(input.organizationId, "organizationId");
    assertActor(actor, organizationId);
    const idempotencyKey =
      input.idempotencyKey === undefined
        ? undefined
        : text(input.idempotencyKey, "idempotencyKey", 512);
    const operation = async () => this.#createContact(actor, input, idempotencyKey);
    return this.runIdempotent(`create:${organizationId}:${idempotencyKey ?? ""}`, operation);
  }

  async #createContact(
    actor: CrmActor,
    input: CreateCrmContactInput,
    idempotencyKey: string | undefined,
  ): Promise<CrmContact> {
    const organizationId = identifier(input.organizationId, "organizationId");
    assertActor(actor, organizationId);
    const repository = this.requireRepository();
    if (idempotencyKey !== undefined) {
      const prior = await repository.getCommandResult<CrmContact>(
        organizationId,
        "create-contact",
        idempotencyKey,
      );
      if (prior !== null) return clone(assertTenant(prior, organizationId));
    }
    const contact = this.buildContact(organizationId, input, undefined, "manual");
    if (contact.email !== null) {
      const existing = await repository.findContactByEmail(organizationId, contact.email);
      if (existing !== null) throw conflict("A contact with this email already exists.");
    }
    let saved: CrmContact;
    try {
      saved = await repository.saveContact(contact, null);
    } catch (error) {
      if (repositoryConflict(error)) throw conflict("The contact already exists or changed.");
      throw error;
    }
    assertTenant(saved, organizationId);
    if (idempotencyKey !== undefined)
      await repository.saveCommandResult(organizationId, "create-contact", idempotencyKey, saved);
    return clone(saved);
  }

  async updateContact(actor: CrmActor, input: UpdateCrmContactInput): Promise<CrmContact> {
    const organizationId = identifier(input.organizationId, "organizationId");
    const contactId = identifier(input.contactId, "contactId");
    assertActor(actor, organizationId);
    const repository = this.requireRepository();
    const current = await this.getContact(actor, organizationId, contactId);
    const contact = this.buildContact(organizationId, input, current, current.source);
    const expectedVersion = concurrencyVersion(input.expectedVersion);
    if (expectedVersion !== current.version)
      throw conflict("The contact changed. Reload it before saving.", { current: clone(current) });
    if (contact.email !== null && contact.email !== current.email) {
      const duplicate = await repository.findContactByEmail(organizationId, contact.email);
      if (duplicate !== null && duplicate.id !== current.id)
        throw conflict("A contact with this email already exists.");
    }
    const transitionAudit =
      contact.pipelineStage === current.pipelineStage
        ? undefined
        : this.pipelineTransitionAudit(
            actor,
            current,
            contact.pipelineStage,
            contact.updatedAt,
            optionalText(input.pipelineNote, "pipelineNote", 2_000) ?? null,
          );
    let saved: CrmContact;
    try {
      saved = await repository.saveContact(contact, expectedVersion, transitionAudit);
    } catch (error) {
      if (repositoryConflict(error)) {
        const conflictCurrent =
          error.current?.organizationId === organizationId && error.current.id === contactId
            ? error.current
            : undefined;
        const authoritative =
          conflictCurrent ?? (await repository.getContact(organizationId, contactId)) ?? current;
        throw conflict(
          "The contact changed. Reload it before saving.",
          authoritative === null ? undefined : { current: clone(authoritative) },
        );
      }
      throw error;
    }
    assertTenant(saved, organizationId);
    return clone(saved);
  }

  async addTag(
    actor: CrmActor,
    input: { readonly organizationId: string; readonly contactId: string; readonly tag: string },
  ): Promise<CrmContact> {
    const contact = await this.getContact(actor, input.organizationId, input.contactId);
    const tag = text(input.tag, "tag", MAX_TAG).toLowerCase();
    return this.updateContact(actor, {
      organizationId: input.organizationId,
      contactId: input.contactId,
      tags: [...contact.tags, tag],
      expectedVersion: contact.version,
    });
  }

  async removeTag(
    actor: CrmActor,
    input: { readonly organizationId: string; readonly contactId: string; readonly tag: string },
  ): Promise<CrmContact> {
    const contact = await this.getContact(actor, input.organizationId, input.contactId);
    const tag = text(input.tag, "tag", MAX_TAG).toLowerCase();
    return this.updateContact(actor, {
      organizationId: input.organizationId,
      contactId: input.contactId,
      tags: contact.tags.filter((candidate) => candidate !== tag),
      expectedVersion: contact.version,
    });
  }

  async previewImport(actor: CrmActor, input: ImportCrmContactsInput): Promise<CrmImportResult> {
    const prepared = await this.prepareImport(actor, input);
    const previewKey =
      input.idempotencyKey === undefined
        ? undefined
        : text(input.idempotencyKey, "idempotencyKey", 512);
    return {
      id: `preview-${prepared.planFingerprint}`,
      organizationId: prepared.organizationId,
      created: prepared.counts.created,
      updated: prepared.counts.updated,
      skipped: prepared.counts.skipped,
      errors: prepared.counts.errors,
      contacts: prepared.previewContacts,
      mapping: prepared.mapping,
      rows: prepared.rows.map(({ result }) => result),
      idempotent: false,
      createdAt: nowIso(this.#clock),
      ...(previewKey === undefined ? {} : { idempotencyKey: previewKey }),
      planFingerprint: prepared.planFingerprint,
      preview: true,
    };
  }

  async previewImportContacts(
    actor: CrmActor,
    input: ImportCrmContactsInput,
  ): Promise<CrmImportResult> {
    return this.previewImport(actor, input);
  }

  async previewCsvImport(actor: CrmActor, input: ImportCrmContactsInput): Promise<CrmImportResult> {
    return this.previewImport(actor, input);
  }

  async importContacts(actor: CrmActor, input: ImportCrmContactsInput): Promise<CrmImportResult> {
    const organizationId = identifier(input.organizationId, "organizationId");
    assertActor(actor, organizationId);
    if (input.idempotencyKey === undefined)
      throw invalid("An idempotency key is required for an import commit.");
    const key = text(input.idempotencyKey, "idempotencyKey", 512);
    return this.runIdempotent(`import:${organizationId}:${key}`, async () => {
      const repository = this.requireRepository();
      const prepared = await this.prepareImport(actor, { ...input, idempotencyKey: key });
      const prior = await repository.getImportByIdempotencyKey(organizationId, key);
      const commandPrior = await repository.getCommandResult<CrmImportResult>(
        organizationId,
        "import-contacts",
        key,
      );
      const persisted = prior ?? commandPrior;
      if (persisted !== null) {
        if (
          persisted.planFingerprint !== undefined &&
          persisted.planFingerprint !== prepared.planFingerprint
        ) {
          throw conflict(
            "The import idempotency key was already used for a different normalized input.",
            {
              idempotencyKey: key,
              priorPlanFingerprint: persisted.planFingerprint,
              planFingerprint: prepared.planFingerprint,
            },
          );
        }
        return { ...clone(persisted), idempotent: true, preview: false };
      }

      const contactsById = new Map<string, CrmContact>();
      const rows: CrmImportRowResult[] = [];
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let errors = 0;
      for (const preparedRow of prepared.rows) {
        const result = preparedRow.result;
        if (result.status === "error") {
          errors += 1;
          rows.push(result);
          continue;
        }
        if (result.status === "skipped") {
          if (result.contactId !== null) {
            const authoritative = await repository.getContact(organizationId, result.contactId);
            if (authoritative !== null) contactsById.set(authoritative.id, clone(authoritative));
          }
          skipped += 1;
          rows.push(result);
          continue;
        }
        try {
          if (preparedRow.candidate === undefined)
            throw invalid("The import row did not produce a contact candidate.");
          const saved = await repository.saveContact(
            preparedRow.candidate,
            preparedRow.existing?.version ?? null,
          );
          assertTenant(saved, organizationId);
          const authoritative = await repository.getContact(organizationId, saved.id);
          if (authoritative === null)
            throw dependencyUnavailable("The saved contact could not be re-read.");
          contactsById.set(authoritative.id, clone(authoritative));
          if (result.status === "created") created += 1;
          else updated += 1;
          rows.push({ ...result, contactId: authoritative.id });
        } catch (error) {
          if (!repositoryConflict(error) && !(error instanceof CrmServiceError)) throw error;
          errors += 1;
          rows.push({
            ...result,
            status: "error",
            contactId: null,
            reason: error instanceof Error ? error.message : "The contact could not be saved.",
          });
        }
      }

      const result: CrmImportResult = {
        id: this.#generateId("import"),
        organizationId,
        created,
        updated,
        skipped,
        errors,
        contacts: [...contactsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
        mapping: prepared.mapping,
        rows,
        idempotent: false,
        createdAt: nowIso(this.#clock),
        idempotencyKey: key,
        planFingerprint: prepared.planFingerprint,
        preview: false,
      };
      await repository.saveImport(result);
      await repository.saveCommandResult(organizationId, "import-contacts", key, result);
      return clone(result);
    });
  }

  async commitImport(actor: CrmActor, input: ImportCrmContactsInput): Promise<CrmImportResult> {
    return this.importContacts(actor, input);
  }

  async importCsv(actor: CrmActor, input: ImportCrmContactsInput): Promise<CrmImportResult> {
    return this.importContacts(actor, input);
  }

  private async prepareImport(
    actor: CrmActor,
    input: ImportCrmContactsInput,
  ): Promise<{
    readonly organizationId: string;
    readonly mapping: CrmImportResult["mapping"];
    readonly rows: readonly {
      readonly result: CrmImportRowResult;
      readonly candidate?: CrmContact;
      readonly existing?: CrmContact;
    }[];
    readonly counts: {
      readonly created: number;
      readonly updated: number;
      readonly skipped: number;
      readonly errors: number;
    };
    readonly previewContacts: readonly CrmContact[];
    readonly planFingerprint: string;
  }> {
    const organizationId = identifier(input.organizationId, "organizationId");
    assertActor(actor, organizationId);
    if (input.csv !== undefined && input.rows !== undefined)
      throw invalid("Provide csv or rows, not both.");
    const parsedCsv = input.csv === undefined ? undefined : parseCsv(input.csv);
    const rawRows =
      input.rows !== undefined
        ? input.rows
        : parsedCsv === undefined
          ? []
          : parsedCsv.map(csvRowInput);
    if (rawRows.length === 0 || rawRows.length > MAX_IMPORT_ROWS)
      throw invalid(`Import must contain between 1 and ${MAX_IMPORT_ROWS} rows.`);
    const mode = input.mode ?? "upsert";
    if (mode !== "upsert" && mode !== "create") throw invalid("mode must be upsert or create.");
    const columns = Object.keys(
      (input.rows?.[0] ?? parsedCsv?.[0] ?? {}) as Record<string, unknown>,
    );
    const mapping = importColumnMapping(columns);
    const planFingerprint = fingerprint({
      organizationId,
      mode,
      mapping,
      rows: rawRows.map((row) => normalizeImportRow(row)),
    });
    const repository = this.requireRepository();
    const existingContacts = await repository.listContacts(organizationId, { organizationId });
    const byEmail = new Map<string, CrmContact>();
    for (const contact of existingContacts) {
      if (
        contact.organizationId === organizationId &&
        contact.status === "active" &&
        contact.email
      ) {
        byEmail.set(contact.email.toLowerCase(), clone(contact));
      }
    }
    const rows: {
      result: CrmImportRowResult;
      candidate?: CrmContact;
      existing?: CrmContact;
    }[] = [];
    const contacts = new Map<string, CrmContact>();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    for (const [index, raw] of rawRows.entries()) {
      const rowNumber = index + 1;
      const row = normalizeImportRow(raw);
      let identity: string | null = null;
      try {
        identity = nullableEmail(row.email) ?? null;
        if (identity === null) throw invalid("Email is required as the canonical import identity.");
        const existing = byEmail.get(identity);
        if (existing !== undefined && mode === "create") {
          skipped += 1;
          rows.push({
            result: {
              rowNumber,
              identity,
              status: "skipped",
              contactId: existing.id,
              reason: "A contact with this canonical email already exists.",
            },
            existing,
          });
          continue;
        }
        const candidate = this.buildContact(
          organizationId,
          {
            ...row,
            email: identity,
            ...(row.source === undefined ? {} : { source: row.source }),
          },
          existing,
          existing?.source ?? "csv",
        );
        if (
          existing !== undefined &&
          sameRecord(contactComparable(existing), contactComparable(candidate))
        ) {
          skipped += 1;
          rows.push({
            result: {
              rowNumber,
              identity,
              status: "skipped",
              contactId: existing.id,
              reason: "The existing contact already has these values.",
            },
            existing,
          });
          continue;
        }
        const status = existing === undefined ? "created" : "updated";
        if (status === "created") created += 1;
        else updated += 1;
        rows.push({
          result: { rowNumber, identity, status, contactId: candidate.id, reason: null },
          candidate,
          ...(existing === undefined ? {} : { existing }),
        });
        byEmail.set(identity, candidate);
        contacts.set(candidate.id, candidate);
      } catch (error) {
        if (!(error instanceof CrmServiceError)) throw error;
        errors += 1;
        rows.push({
          result: {
            rowNumber,
            identity,
            status: "error",
            contactId: null,
            reason: error.message,
          },
        });
      }
    }
    return {
      organizationId,
      mapping,
      rows,
      counts: { created, updated, skipped, errors },
      previewContacts: [...contacts.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      planFingerprint,
    };
  }

  async createSegment(actor: CrmActor, input: CreateCrmSegmentInput): Promise<CrmSegment> {
    const organizationId = identifier(input.organizationId, "organizationId");
    assertActor(actor, organizationId);
    const segment: CrmSegment = {
      id: this.#generateId("segment"),
      organizationId,
      name: text(input.name, "name", 200),
      description: optionalText(input.description, "description", 2_000) ?? null,
      rules: normalizeSegmentRules(input.rules),
      createdBy: identifier(actor.userId, "actor userId"),
      version: 1,
      createdAt: nowIso(this.#clock),
      updatedAt: nowIso(this.#clock),
    };
    const saved = await this.requireRepository().saveSegment(segment, null);
    assertTenant(saved, organizationId);
    return clone(saved);
  }

  async listSegments(
    actor: CrmActor,
    organizationId = actor.organizationId,
  ): Promise<readonly CrmSegment[]> {
    const organization = identifier(organizationId, "organizationId");
    assertActor(actor, organization);
    return (await this.requireRepository().listSegments(organization))
      .filter((segment) => segment.organizationId === organization)
      .map(clone);
  }

  async getSegment(
    actor: CrmActor,
    organizationId: string,
    segmentId: string,
  ): Promise<CrmSegment> {
    const organization = identifier(organizationId, "organizationId");
    const id = identifier(segmentId, "segmentId");
    assertActor(actor, organization);
    const segment = await this.requireRepository().getSegment(organization, id);
    if (segment === null || segment.organizationId !== organization)
      throw notFound("The segment was not found.");
    return clone(segment);
  }

  async updateSegment(actor: CrmActor, input: UpdateCrmSegmentInput): Promise<CrmSegment> {
    const organizationId = identifier(input.organizationId, "organizationId");
    const segmentId = identifier(input.segmentId, "segmentId");
    assertActor(actor, organizationId);
    const current = await this.getSegment(actor, organizationId, segmentId);
    const expectedVersion =
      input.expectedVersion === undefined
        ? current.version
        : concurrencyVersion(input.expectedVersion);
    if (expectedVersion !== current.version)
      throw conflict("The segment changed. Reload it before saving.");
    const next: CrmSegment = {
      ...current,
      ...(input.name === undefined ? {} : { name: text(input.name, "name", 200) }),
      ...(input.description === undefined
        ? {}
        : { description: optionalText(input.description, "description", 2_000) ?? null }),
      ...(input.rules === undefined ? {} : { rules: normalizeSegmentRules(input.rules) }),
      version: current.version + 1,
      updatedAt: nowIso(this.#clock),
    };
    try {
      const saved = await this.requireRepository().saveSegment(next, expectedVersion);
      assertTenant(saved, organizationId);
      return clone(saved);
    } catch (error) {
      if (repositoryConflict(error))
        throw conflict("The segment changed. Reload it before saving.");
      throw error;
    }
  }

  async deleteSegment(
    actor: CrmActor,
    organizationId: string,
    segmentId: string,
    expectedVersion?: number,
  ): Promise<void> {
    const organization = identifier(organizationId, "organizationId");
    const id = identifier(segmentId, "segmentId");
    assertActor(actor, organization);
    const current = await this.getSegment(actor, organization, id);
    const expected = expectedVersion ?? current.version;
    if (expected !== current.version)
      throw conflict("The segment changed. Reload it before deleting.");
    try {
      await this.requireRepository().deleteSegment(organization, id, expected);
    } catch (error) {
      if (repositoryConflict(error))
        throw conflict("The segment changed. Reload it before deleting.");
      throw error;
    }
  }

  async listSegmentContacts(
    actor: CrmActor,
    organizationId: string,
    segmentId: string,
  ): Promise<readonly CrmContact[]> {
    const segment = await this.getSegment(actor, organizationId, segmentId);
    const contacts = await this.listContacts(actor, organizationId, { limit: 500 });
    return contacts.filter((contact) => segmentMatches(contact, segment.rules));
  }

  async findDuplicates(
    actor: CrmActor,
    organizationId: string,
    contactId: string,
  ): Promise<CrmDuplicateReport> {
    const organization = identifier(organizationId, "organizationId");
    const contact = await this.getContact(actor, organization, contactId);
    const contacts = await this.listContacts(actor, organization, { limit: 500 });
    const matches: CrmDuplicateMatch[] = [];
    for (const candidate of contacts) {
      if (candidate.id === contact.id || candidate.status === "merged") continue;
      const matchedFields: ("email" | "phone" | "name" | "company")[] = [];
      let score = 0;
      if (
        contact.email !== null &&
        candidate.email !== null &&
        canonical(contact.email) === canonical(candidate.email)
      ) {
        matchedFields.push("email");
        score = 1;
      }
      if (
        contact.phone !== null &&
        candidate.phone !== null &&
        canonical(contact.phone) === canonical(candidate.phone)
      ) {
        matchedFields.push("phone");
        score = Math.max(score, 0.9);
      }
      if (
        canonical(contact.displayName) !== "" &&
        canonical(contact.displayName) === canonical(candidate.displayName)
      ) {
        matchedFields.push("name");
        score = Math.max(score, 0.75);
      }
      if (
        contact.company !== null &&
        candidate.company !== null &&
        canonical(contact.company) === canonical(candidate.company)
      ) {
        matchedFields.push("company");
        score = Math.max(score, matchedFields.includes("name") ? 0.75 : 0.55);
      }
      if (score >= 0.5) matches.push({ contact: clone(candidate), score, matchedFields });
    }
    matches.sort(
      (left, right) => right.score - left.score || left.contact.id.localeCompare(right.contact.id),
    );
    return { contactId: contact.id, matches };
  }

  async detectDuplicates(
    actor: CrmActor,
    organizationId: string,
    contactId: string,
  ): Promise<CrmDuplicateReport> {
    return this.findDuplicates(actor, organizationId, contactId);
  }

  async previewMergeContacts(
    actor: CrmActor,
    input: MergeCrmContactsInput,
  ): Promise<CrmMergePreview> {
    const normalized = this.normalizeMergeInput(input, false);
    const plan = await this.buildMergePlan(actor, normalized);
    return {
      ...plan,
      preview: true,
      canCommit: plan.participantConflicts.length === 0,
    };
  }

  async previewMerge(actor: CrmActor, input: MergeCrmContactsInput): Promise<CrmMergePreview> {
    return this.previewMergeContacts(actor, input);
  }
  async previewContactMerge(
    actor: CrmActor,
    input: MergeCrmContactsInput,
  ): Promise<CrmMergePreview> {
    return this.previewMergeContacts(actor, input);
  }

  async planMergeContacts(actor: CrmActor, input: MergeCrmContactsInput): Promise<CrmMergePreview> {
    return this.previewMergeContacts(actor, input);
  }

  async mergeContacts(actor: CrmActor, input: MergeCrmContactsInput): Promise<CrmMergeResult> {
    const normalized = this.normalizeMergeInput(input, true);
    const key = normalized.idempotencyKey;
    if (key === undefined) throw invalid("An idempotency key is required for a merge commit.");
    return this.runIdempotent(`merge:${normalized.organizationId}:${key}`, async () => {
      const repository = this.requireRepository();
      const prior = await repository.getCommandResult<CrmMergeResult>(
        normalized.organizationId,
        "merge-contacts",
        key,
      );
      if (prior !== null) {
        if (
          prior.planFingerprint !== undefined &&
          prior.planFingerprint !== normalized.planFingerprint
        ) {
          throw conflict(
            "The merge idempotency key was already used for a different normalized plan.",
            {
              idempotencyKey: key,
              priorPlanFingerprint: prior.planFingerprint,
              planFingerprint: normalized.planFingerprint,
            },
          );
        }
        return { ...clone(prior), idempotent: true };
      }
      const plan = await this.buildMergePlan(actor, normalized);
      if (plan.participantConflicts.length > 0) {
        throw conflict("The merge would reconcile two distinct participants in the same event.", {
          participantConflicts: plan.participantConflicts,
          plan: clone(plan),
        });
      }

      const tombstones: CrmContact[] = [];
      const mergedAt = nowIso(this.#clock);
      for (const plannedTombstone of plan.tombstones) {
        const current = await repository.getContact(normalized.organizationId, plannedTombstone.id);
        if (current === null) throw notFound("A requested duplicate contact was not found.");
        if (current.status === "merged" && current.mergedIntoId === plan.survivorId) {
          tombstones.push(clone(current));
          continue;
        }
        if (current.status !== "active")
          throw invalid(
            "Every duplicate contact must be active or already merged into this survivor.",
          );
        const retired: CrmContact = {
          ...current,
          status: "merged",
          mergedIntoId: plan.survivorId,
          mergeAuditId: plan.auditId,
          mergedAt,
          mergeSourceIds: [...plan.retiredIds],
          version: current.version + 1,
          updatedAt: mergedAt,
        };
        const saved = await repository.saveContact(retired, current.version);
        assertTenant(saved, normalized.organizationId);
        tombstones.push(clone(saved));
      }

      const currentSurvivor = await repository.getContact(
        normalized.organizationId,
        plan.survivorId,
      );
      if (currentSurvivor === null) throw notFound("The survivor contact was not found.");
      let _savedPrimary: CrmContact;
      if (
        currentSurvivor.status === "active" &&
        sameRecord(contactComparable(currentSurvivor), contactComparable(plan.survivor))
      ) {
        _savedPrimary = clone(currentSurvivor);
      } else if (currentSurvivor.status === "active") {
        const saved = await repository.saveContact(plan.survivor, currentSurvivor.version);
        _savedPrimary = assertTenant(saved, normalized.organizationId);
      } else {
        throw invalid("The survivor contact must be active.");
      }

      const reconciliationInput: CrmMergeReconciliationInput = {
        organizationId: normalized.organizationId,
        survivorId: plan.survivorId,
        retiredIds: plan.retiredIds,
        auditId: plan.auditId,
      };
      let reconciliation: CrmMergeReconciliationResult;
      try {
        reconciliation = await repository.reconcileContactMerge(reconciliationInput);
      } catch (error) {
        if (repositoryConflict(error)) {
          const details = error instanceof CrmRepositoryConflictError ? error.details : undefined;
          throw conflict(
            "The merge would reconcile two distinct participants in the same event.",
            details === undefined ? undefined : { participantConflicts: details },
          );
        }
        throw error;
      }
      if (reconciliation.participantConflicts.length > 0) {
        throw conflict("The merge would reconcile two distinct participants in the same event.", {
          participantConflicts: reconciliation.participantConflicts,
        });
      }

      const history = await repository.listHistory(normalized.organizationId, plan.survivorId);
      const audited = history.some(
        (entry) => (entry.metadata.auditId as string | undefined) === plan.auditId,
      );
      if (!audited) {
        await repository.appendHistory({
          id: this.#generateId("history"),
          organizationId: normalized.organizationId,
          contactId: plan.survivorId,
          kind: "note",
          eventId: null,
          sessionId: null,
          title: "Contacts merged",
          detail: `Merged ${plan.retiredIds.length} duplicate contact(s).`,
          occurredAt: nowIso(this.#clock),
          metadata: {
            auditId: plan.auditId,
            survivorId: plan.survivorId,
            retiredIds: plan.retiredIds,
          },
        });
      }

      const authoritativePrimary = await repository.getContact(
        normalized.organizationId,
        plan.survivorId,
      );
      if (authoritativePrimary === null)
        throw dependencyUnavailable("The merged survivor could not be re-read.");
      const authoritativeTombstones: CrmContact[] = [];
      for (const retiredId of plan.retiredIds) {
        const authoritative = await repository.getContact(normalized.organizationId, retiredId);
        if (authoritative !== null) authoritativeTombstones.push(clone(authoritative));
      }
      const result: CrmMergeResult = {
        survivorId: plan.survivorId,
        retiredIds: [...plan.retiredIds],
        rewired: reconciliation.rewired,
        participantConflicts: [],
        auditId: plan.auditId,
        primary: clone(authoritativePrimary),
        merged: authoritativeTombstones,
        survivor: clone(authoritativePrimary),
        tombstones: authoritativeTombstones,
        idempotent: false,
        planFingerprint: normalized.planFingerprint,
      };
      await repository.saveCommandResult(normalized.organizationId, "merge-contacts", key, result);
      return clone(result);
    });
  }

  private normalizeMergeInput(
    input: MergeCrmContactsInput,
    requireIdempotencyKey: boolean,
  ): {
    readonly organizationId: string;
    readonly survivorId: string;
    readonly retiredIds: readonly string[];
    readonly fieldWinners: Readonly<Partial<Record<CrmMergeScalarField, string>>>;
    readonly customFieldWinners: Readonly<Record<string, string>>;
    readonly idempotencyKey?: string;
    readonly planFingerprint: string;
  } {
    const organizationId = identifier(input.organizationId, "organizationId");
    const survivorId = identifier(input.primaryContactId, "primaryContactId");
    if (!Array.isArray(input.duplicateContactIds))
      throw invalid("duplicateContactIds must be an array.");
    const retiredIds = [
      ...new Set(input.duplicateContactIds.map((id) => identifier(id, "duplicateContactId"))),
    ].sort((left, right) => left.localeCompare(right));
    if (retiredIds.length === 0 || retiredIds.includes(survivorId))
      throw invalid(
        "duplicateContactIds must contain unique contacts other than the primary contact.",
      );
    if (new Set(input.duplicateContactIds).size !== input.duplicateContactIds.length)
      throw invalid(
        "duplicateContactIds must contain unique contacts other than the primary contact.",
      );
    const fieldWinners = normalizeMergeScalarWinners(input.fieldWinners);
    const customFieldWinners = normalizeMergeCustomFieldWinners(input.customFieldWinners);
    const idempotencyKey =
      input.idempotencyKey === undefined
        ? undefined
        : text(input.idempotencyKey, "idempotencyKey", 512);
    if (requireIdempotencyKey && idempotencyKey === undefined)
      throw invalid("An idempotency key is required for a merge commit.");
    const planFingerprint = fingerprint({
      organizationId,
      survivorId,
      retiredIds,
      fieldWinners,
      customFieldWinners,
    });
    return {
      organizationId,
      survivorId,
      retiredIds,
      fieldWinners,
      customFieldWinners,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      planFingerprint,
    };
  }

  private async buildMergePlan(
    actor: CrmActor,
    normalized: ReturnType<CrmService["normalizeMergeInput"]>,
  ): Promise<CrmMergePlan> {
    const repository = this.requireRepository();
    assertActor(actor, normalized.organizationId);
    const primary = await this.getContact(actor, normalized.organizationId, normalized.survivorId);
    if (primary.status !== "active") throw invalid("The survivor contact must be active.");
    const duplicates: CrmContact[] = [];
    for (const id of normalized.retiredIds)
      duplicates.push(await this.getContact(actor, normalized.organizationId, id));
    for (const duplicate of duplicates) {
      if (duplicate.status === "active") continue;
      if (duplicate.status === "merged" && duplicate.mergedIntoId === primary.id) continue;
      throw invalid("Every duplicate contact must be active or already merged into this survivor.");
    }

    const allowedWinnerIds = new Set([primary.id, ...duplicates.map((contact) => contact.id)]);
    for (const winnerId of [
      ...Object.values(normalized.fieldWinners),
      ...Object.values(normalized.customFieldWinners),
    ]) {
      if (typeof winnerId !== "string" || !allowedWinnerIds.has(winnerId))
        throw invalid("Every merge winner must be the survivor or a requested duplicate.");
    }
    const contactsById = new Map<string, CrmContact>([
      [primary.id, primary],
      ...duplicates.map((contact) => [contact.id, contact] as const),
    ]);
    const mergedTags = normalizeTags([
      ...primary.tags,
      ...duplicates.flatMap((contact) => contact.tags),
    ]);
    const mergedFields: Record<string, CrmValue> = { ...primary.customFields };
    for (const duplicate of duplicates)
      for (const [field, value] of Object.entries(duplicate.customFields))
        if (mergedFields[field] === undefined) mergedFields[field] = clone(value);

    let firstName =
      primary.firstName ??
      duplicates.find((contact) => contact.firstName !== null)?.firstName ??
      null;
    let lastName =
      primary.lastName ?? duplicates.find((contact) => contact.lastName !== null)?.lastName ?? null;
    let displayName =
      primary.displayName ||
      duplicates.find((contact) => contact.displayName)?.displayName ||
      "Unnamed contact";
    let email =
      primary.email ?? duplicates.find((contact) => contact.email !== null)?.email ?? null;
    let phone =
      primary.phone ?? duplicates.find((contact) => contact.phone !== null)?.phone ?? null;
    let company =
      primary.company ?? duplicates.find((contact) => contact.company !== null)?.company ?? null;
    let title =
      primary.title ?? duplicates.find((contact) => contact.title !== null)?.title ?? null;
    const website =
      primary.website ?? duplicates.find((contact) => contact.website !== null)?.website ?? null;
    const linkedinUrl =
      primary.linkedinUrl ??
      duplicates.find((contact) => contact.linkedinUrl !== null)?.linkedinUrl ??
      null;
    const survivorNotes =
      primary.notes ?? duplicates.find((contact) => contact.notes !== null)?.notes ?? null;

    for (const [field, winnerId] of Object.entries(normalized.fieldWinners)) {
      const winner = contactsById.get(winnerId);
      if (winner === undefined) throw invalid(`fieldWinners.${field} is not valid.`);
      if (winner.id === primary.id) continue;
      switch (field as CrmMergeScalarField) {
        case "email":
          email = winner.email;
          break;
        case "phone":
          phone = winner.phone;
          break;
        case "name":
          firstName = winner.firstName;
          lastName = winner.lastName;
          displayName = winner.displayName;
          break;
        case "company":
          company = winner.company;
          break;
        case "title":
          title = winner.title;
          break;
        case "bio":
        case "headshot": {
          const aliases = new Set(MERGE_PROFILE_FIELD_ALIASES[field as "bio" | "headshot"]);
          let hasValue = false;
          let value: CrmValue | null = null;
          for (const [customField, candidate] of Object.entries(winner.customFields)) {
            if (aliases.has(customField.toLowerCase())) {
              hasValue = true;
              value = candidate;
              break;
            }
          }
          for (const customField of Object.keys(mergedFields))
            if (aliases.has(customField.toLowerCase())) delete mergedFields[customField];
          if (hasValue) mergedFields[field === "bio" ? "bio" : "headshotUrl"] = clone(value);
          break;
        }
      }
    }
    for (const [field, winnerId] of Object.entries(normalized.customFieldWinners)) {
      const winner = contactsById.get(winnerId);
      if (winner === undefined) throw invalid(`customFieldWinners.${field} is not valid.`);
      if (winner.id === primary.id) continue;
      const winnerValue = winner.customFields[field];
      if (Object.hasOwn(winner.customFields, field) && winnerValue !== undefined)
        mergedFields[field] = clone(winnerValue);
      else delete mergedFields[field];
    }
    if (email !== null) {
      const existing = await repository.findContactByEmail(normalized.organizationId, email);
      if (existing !== null) {
        assertTenant(existing, normalized.organizationId);
        if (existing.id !== primary.id && !allowedWinnerIds.has(existing.id))
          throw conflict("A contact with this email already exists.");
      }
    }
    const survivor: CrmContact = {
      ...primary,
      firstName,
      lastName,
      displayName,
      email,
      phone,
      company,
      title,
      website,
      linkedinUrl,
      notes: survivorNotes,
      tags: mergedTags,
      customFields: mergedFields,
      version: primary.version + 1,
      updatedAt: nowIso(this.#clock),
    };
    const projections = await repository.listProjections(normalized.organizationId);
    const links = projections.filter(
      (projection) =>
        normalized.retiredIds.includes(projectionCrmContactId(projection)) ||
        projectionCrmContactId(projection) === normalized.survivorId,
    );
    const participantConflicts = participantConflictDetails(
      projections,
      new Set([normalized.survivorId, ...normalized.retiredIds]),
    );
    const [segments, notesByContact, pipelineByContact] = await Promise.all([
      repository.listSegments(normalized.organizationId),
      Promise.all(
        normalized.retiredIds.map((id) => repository.listNotes(normalized.organizationId, id)),
      ),
      Promise.all(
        normalized.retiredIds.map((id) =>
          repository.listPipelineHistory(normalized.organizationId, id),
        ),
      ),
    ]);
    const notes = notesByContact.flat();
    const pipeline = pipelineByContact.flat();
    const retiredSet = new Set(normalized.retiredIds);
    return {
      organizationId: normalized.organizationId,
      survivorId: normalized.survivorId,
      retiredIds: normalized.retiredIds,
      rewired: rewireCounts(links, notes, segments, pipeline, retiredSet),
      participantConflicts,
      auditId: `audit-crm-${normalized.planFingerprint}`,
      planFingerprint: normalized.planFingerprint,
      survivor: clone(survivor),
      tombstones: duplicates.map(clone),
      primary: clone(survivor),
      merged: duplicates.map(clone),
    };
  }

  async getContactHistory(
    actor: CrmActor,
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmHistoryEntry[]> {
    const organization = identifier(organizationId, "organizationId");
    const id = identifier(contactId, "contactId");
    await this.getContact(actor, organization, id);
    return (await this.requireRepository().listHistory(organization, id))
      .filter((entry) => entry.organizationId === organization && entry.contactId === id)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .map(clone);
  }

  async listHistory(
    actor: CrmActor,
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmHistoryEntry[]> {
    return this.getContactHistory(actor, organizationId, contactId);
  }
  async listEventHistory(
    actor: CrmActor,
    organizationId: string,
    eventId: string,
    contactId?: string,
  ): Promise<readonly CrmHistoryEntry[]> {
    const organization = identifier(organizationId, "organizationId");
    const event = identifier(eventId, "eventId");
    assertActor(actor, organization);
    const contacts =
      contactId === undefined
        ? await this.listContacts(actor, organization, { limit: 500 })
        : [await this.getContact(actor, organization, contactId)];
    const entries: CrmHistoryEntry[] = [];
    for (const contact of contacts) {
      const history = await this.requireRepository().listHistory(organization, contact.id);
      entries.push(
        ...history.filter(
          (entry) =>
            entry.organizationId === organization &&
            entry.contactId === contact.id &&
            entry.eventId === event,
        ),
      );
    }
    return entries
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .map(clone);
  }
  async getContactEventHistory(
    actor: CrmActor,
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmHistoryEntry[]> {
    return this.getContactHistory(actor, organizationId, contactId);
  }

  async setPipelineStage(actor: CrmActor, input: UpdateCrmPipelineInput): Promise<CrmContact> {
    const organizationId = identifier(input.organizationId, "organizationId");
    const contactId = identifier(input.contactId, "contactId");
    const nextStage = stage(input.stage);
    assertActor(actor, organizationId);
    const current = await this.getContact(actor, organizationId, contactId);
    const expectedVersion = concurrencyVersion(input.expectedVersion);
    if (expectedVersion !== current.version)
      throw conflict("The contact changed. Reload it before saving.", { current: clone(current) });
    const note = optionalText(input.note, "note", 2_000) ?? null;
    const score =
      input.score === undefined || input.score === null
        ? input.score
        : Number.isFinite(input.score) && input.score >= 0 && input.score <= 100
          ? input.score
          : (() => {
              throw invalid("score must be between 0 and 100.");
            })();
    const rationale =
      input.rationale === undefined
        ? undefined
        : (optionalText(input.rationale, "rationale", 2_000) ?? null);
    const hasScoring = score !== undefined || rationale !== undefined;
    if (current.pipelineStage === nextStage && !hasScoring) return current;
    const saved = await this.updateContact(actor, {
      organizationId,
      contactId,
      pipelineStage: nextStage,
      expectedVersion,
      pipelineNote: note,
      ...(hasScoring
        ? {
            customFields: {
              ...current.customFields,
              ...(score === undefined ? {} : { pipelineScore: score }),
              ...(rationale === undefined ? {} : { pipelineRationale: rationale }),
            },
          }
        : {}),
    });
    return saved;
  }

  async updatePipeline(actor: CrmActor, input: UpdateCrmPipelineInput): Promise<CrmContact> {
    return this.setPipelineStage(actor, input);
  }
  async updateProspectStage(actor: CrmActor, input: UpdateCrmPipelineInput): Promise<CrmContact> {
    return this.setPipelineStage(actor, input);
  }

  async listPipelineHistory(
    actor: CrmActor,
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmPipelineEntry[]> {
    const organization = identifier(organizationId, "organizationId");
    const id = identifier(contactId, "contactId");
    await this.getContact(actor, organization, id);
    return (await this.requireRepository().listPipelineHistory(organization, id))
      .filter((entry) => entry.organizationId === organization && entry.contactId === id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async addNote(actor: CrmActor, input: AddCrmNoteInput): Promise<CrmNote> {
    const organizationId = identifier(input.organizationId, "organizationId");
    const contactId = identifier(input.contactId, "contactId");
    assertActor(actor, organizationId);
    await this.getContact(actor, organizationId, contactId);
    const note: CrmNote = {
      id: this.#generateId("note"),
      organizationId,
      contactId,
      body: text(input.body, "body", 10_000),
      authorId: identifier(actor.userId, "actor userId"),
      createdAt: nowIso(this.#clock),
    };
    const saved = await this.requireRepository().appendNote(note);
    assertTenant(saved, organizationId);
    await this.requireRepository().appendHistory({
      id: this.#generateId("history"),
      organizationId,
      contactId,
      kind: "note",
      eventId: null,
      sessionId: null,
      title: "Note added",
      detail: note.body,
      occurredAt: note.createdAt,
      metadata: { noteId: note.id },
    });
    return clone(saved);
  }
  async addProspectNote(actor: CrmActor, input: AddCrmNoteInput): Promise<CrmNote> {
    return this.addNote(actor, input);
  }

  async listNotes(
    actor: CrmActor,
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmNote[]> {
    const organization = identifier(organizationId, "organizationId");
    const id = identifier(contactId, "contactId");
    await this.getContact(actor, organization, id);
    return (await this.requireRepository().listNotes(organization, id))
      .filter((note) => note.organizationId === organization && note.contactId === id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async addContactToEvent(
    actor: CrmActor,
    input: AddContactToEventInput,
  ): Promise<CrmEventProjectionResult> {
    const organizationId = identifier(input.organizationId, "organizationId");
    const crmContactId = identifier(input.crmContactId ?? input.contactId, "crmContactId");
    const eventId = identifier(input.eventId, "eventId");
    const participantId = identifier(
      input.participantId ?? `crm-participant:${eventId}:${crmContactId}`,
      "participantId",
    );
    const key = text(input.idempotencyKey, "idempotencyKey", 512);
    const role = eventRole(input.role);
    const sessionId =
      input.sessionId === undefined || input.sessionId === null
        ? null
        : identifier(input.sessionId, "sessionId");
    const note = optionalText(input.note, "note", 2_000) ?? null;
    assertActor(actor, organizationId);
    return this.runIdempotent(`event:${organizationId}:${key}`, async () => {
      const repository = this.requireRepository();
      const prior = await repository.getCommandResult<CrmEventProjectionResult>(
        organizationId,
        "add-to-event",
        key,
      );
      if (prior !== null) {
        if (
          prior.projection.crmContactId !== crmContactId ||
          prior.projection.participantId !== participantId ||
          prior.projection.eventId !== eventId ||
          prior.projection.role !== role ||
          prior.projection.sessionId !== sessionId ||
          prior.projection.note !== note
        ) {
          throw conflict(
            "The add-to-event idempotency key was already used for another relationship.",
          );
        }
        return { ...clone(prior), idempotent: true };
      }
      const contact = await this.getContact(actor, organizationId, crmContactId);
      const createdAt = nowIso(this.#clock);
      const projection: CrmEventProjection = {
        id: this.#generateId("event-contact"),
        organizationId,
        eventId,
        participantId,
        crmContactId,
        contactId: crmContactId,
        sessionId,
        role,
        note,
        createdBy: identifier(actor.userId, "actor userId"),
        createdAt,
        updatedAt: createdAt,
      };
      const saved = await repository.saveProjection(projection, contact);
      assertTenant(saved, organizationId);
      if (saved.id !== projection.id) {
        const result: CrmEventProjectionResult = {
          projection: clone(saved),
          idempotent: true,
          outcome: "existing",
        };
        await repository.saveCommandResult(organizationId, "add-to-event", key, result);
        return result;
      }
      await repository.appendHistory(
        {
          id: this.#generateId("history"),
          organizationId,
          contactId: crmContactId,
          kind: "event",
          eventId,
          sessionId: saved.sessionId,
          title: "Added to event",
          detail: saved.note,
          occurredAt: createdAt,
          metadata: { role: saved.role, projectionId: saved.id },
        },
        contact,
      );
      const result: CrmEventProjectionResult = {
        projection: clone(saved),
        idempotent: false,
        outcome: "created",
      };
      await repository.saveCommandResult(organizationId, "add-to-event", key, result);
      return result;
    });
  }

  async addToEvent(actor: CrmActor, input: AddContactToEventInput): Promise<CrmEventProjection> {
    return (await this.addContactToEvent(actor, input)).projection;
  }
  async addToEventProjection(
    actor: CrmActor,
    input: AddContactToEventInput,
  ): Promise<CrmEventProjection> {
    return this.addToEvent(actor, input);
  }

  async sendPersonalizedOutreach(
    actor: CrmActor,
    input: SendCrmOutreachInput,
  ): Promise<CrmOutreachCommand> {
    const organizationId = identifier(input.organizationId, "organizationId");
    const contactId = identifier(input.contactId, "contactId");
    const key = text(input.idempotencyKey, "idempotencyKey", 512);
    assertActor(actor, organizationId);
    const contact = await this.getContact(actor, organizationId, contactId);
    if (input.eventId !== undefined && input.eventId !== null) identifier(input.eventId, "eventId");
    if (input.segmentId !== undefined && input.segmentId !== null)
      await this.getSegment(actor, organizationId, input.segmentId);
    const templateSubject = text(input.subject, "subject", 500);
    const body = text(input.body, "body", 20_000);
    const recipientEmail = contact.email;
    if (recipientEmail === null) throw invalid("The outreach recipient needs an email address.");
    return this.runIdempotent(`outreach:${organizationId}:${key}`, async () => {
      const repository = this.requireRepository();
      const prior = await repository.getOutreachByIdempotencyKey(organizationId, key);
      if (prior !== null) {
        if (
          prior.contactId !== contactId ||
          prior.templateSubject !== templateSubject ||
          prior.body !== body
        ) {
          throw conflict("The outreach idempotency key was already used for another message.");
        }
        return clone(prior);
      }
      const subject = this.render(templateSubject, contact, input.variables);
      const renderedBody = this.render(body, contact, input.variables);
      let command: CrmOutreachCommand = {
        id: this.#generateId("outreach"),
        organizationId,
        contactId,
        eventId: input.eventId ?? null,
        recipientEmail,
        templateSubject,
        subject,
        body,
        renderedBody,
        status: "queued",
        queuedCount: 1,
        sentCount: 0,
        failedCount: 0,
        terminal: false,
        failureReason: null,
        providerMessageId: null,
        completedAt: null,
        idempotencyKey: key,
        createdBy: identifier(actor.userId, "actor userId"),
        createdAt: nowIso(this.#clock),
      };
      if (this.#outreach === undefined) {
        command = {
          ...command,
          status: "failed",
          queuedCount: 0,
          failedCount: 1,
          terminal: true,
          failureReason: "Operational outreach delivery is not configured.",
        };
      } else {
        try {
          const sent = await this.#outreach.send(clone(command));
          if (sent !== undefined) {
            assertTenant(sent, organizationId);
            if (
              sent.id !== command.id ||
              sent.contactId !== contactId ||
              sent.idempotencyKey !== key
            ) {
              throw conflict("The outreach boundary returned a mismatched send receipt.");
            }
            const status = sent.status;
            command = {
              ...command,
              status,
              queuedCount: status === "queued" ? 1 : 0,
              sentCount: status === "sent" ? 1 : 0,
              failedCount: status === "failed" ? 1 : 0,
              terminal: status !== "queued",
              failureReason:
                status === "failed"
                  ? (sent.failureReason ?? "The delivery boundary rejected the recipient.")
                  : null,
            };
          } else {
            command = {
              ...command,
              status: "failed",
              queuedCount: 0,
              failedCount: 1,
              terminal: true,
              failureReason: "The delivery boundary returned no send receipt.",
            };
          }
        } catch (error) {
          if (error instanceof CrmServiceError) throw error;
          command = {
            ...command,
            status: "failed",
            queuedCount: 0,
            failedCount: 1,
            terminal: true,
            failureReason: error instanceof Error ? error.message : "The delivery boundary failed.",
          };
        }
      }
      const saved = await repository.saveOutreach(command);
      assertTenant(saved, organizationId);
      const historyEntry: CrmHistoryEntry = {
        id: this.#generateId("history"),
        organizationId,
        contactId,
        kind: "communication",
        eventId: command.eventId,
        sessionId: null,
        title: `Outreach ${command.status}`,
        detail: command.failureReason,
        occurredAt: command.createdAt,
        metadata: {
          sendId: command.id,
          recipientEmail: command.recipientEmail,
          status: command.status,
          queuedCount: command.queuedCount,
          sentCount: command.sentCount,
          failedCount: command.failedCount,
          terminal: command.terminal,
        },
      };
      await repository.appendHistory(historyEntry);
      await repository.saveCommandResult(organizationId, "outreach", key, saved);
      return clone(saved);
    });
  }
  async recordOutreachDeliveryStatus(input: {
    readonly organizationId: string;
    readonly outreachId: string;
    readonly idempotencyKey: string;
    readonly status: "delivered" | "failed" | "bounced" | "complained";
    readonly providerMessageId?: string;
    readonly reason?: string;
    readonly occurredAt?: string;
  }): Promise<CrmOutreachCommand> {
    const organizationId = identifier(input.organizationId, "organizationId");
    const outreachId = identifier(input.outreachId, "outreachId");
    const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 512);
    const providerMessageId = optionalText(input.providerMessageId, "providerMessageId", 512);
    const reason = optionalText(input.reason, "reason", 2_000);
    const occurredAt =
      input.occurredAt === undefined
        ? nowIso(this.#clock)
        : (() => {
            const parsed = new Date(input.occurredAt);
            if (!Number.isFinite(parsed.getTime()))
              throw invalid("occurredAt must be an ISO instant.");
            return parsed.toISOString();
          })();
    const repository = this.requireRepository();
    const current = await repository.getOutreachByIdempotencyKey(organizationId, idempotencyKey);
    if (current === null || current.id !== outreachId)
      throw notFound("The outreach was not found.");
    if (current.terminal) {
      if (
        current.status === input.status &&
        (providerMessageId === undefined || providerMessageId === current.providerMessageId) &&
        (reason === undefined || reason === current.failureReason)
      ) {
        return clone(current);
      }
      throw conflict("A terminal outreach delivery cannot move to another state.");
    }

    const failed = input.status !== "delivered";
    const next: CrmOutreachCommand = {
      ...current,
      status: input.status,
      queuedCount: 0,
      sentCount: failed ? 0 : 1,
      failedCount: failed ? 1 : 0,
      terminal: true,
      failureReason: failed ? (reason ?? "The delivery failed.") : null,
      providerMessageId: providerMessageId ?? current.providerMessageId ?? null,
      completedAt: occurredAt,
    };
    const saved = await repository.updateOutreach(next);
    assertTenant(saved, organizationId);
    await repository.appendHistory({
      id: this.#generateId("history"),
      organizationId,
      contactId: saved.contactId,
      kind: "communication",
      eventId: saved.eventId,
      sessionId: null,
      title: `Outreach ${saved.status}`,
      detail: saved.failureReason,
      occurredAt,
      metadata: {
        sendId: saved.id,
        recipientEmail: saved.recipientEmail,
        status: saved.status,
        providerMessageId: saved.providerMessageId ?? null,
        queuedCount: saved.queuedCount,
        sentCount: saved.sentCount,
        failedCount: saved.failedCount,
        terminal: saved.terminal,
      },
    });
    return clone(saved);
  }

  async outreach(actor: CrmActor, input: SendCrmOutreachInput): Promise<CrmOutreachCommand> {
    return this.sendPersonalizedOutreach(actor, input);
  }
  async sendOutreach(actor: CrmActor, input: SendCrmOutreachInput): Promise<CrmOutreachCommand> {
    return this.sendPersonalizedOutreach(actor, input);
  }

  async analytics(actor: CrmActor, organizationId = actor.organizationId): Promise<CrmAnalytics> {
    const organization = identifier(organizationId, "organizationId");
    assertActor(actor, organization);
    const repository = this.requireRepository();
    const [contacts, rawProjections, outreach] = await Promise.all([
      this.listContacts(actor, organization, { limit: 500 }),
      repository.listProjections(organization),
      repository.listOutreach === undefined
        ? Promise.resolve([])
        : repository.listOutreach(organization),
    ]);
    const projections = rawProjections.filter(
      (projection) => projection.organizationId === organization,
    );
    const stageCounts = Object.fromEntries(
      PIPELINE_STAGES.map((candidate) => [candidate, 0]),
    ) as Record<CrmPipelineStage, number>;
    const sourceCounts = Object.fromEntries(
      CONTACT_SOURCES.map((candidate) => [candidate, 0]),
    ) as Record<CrmContactSource, number>;
    for (const contact of contacts) {
      stageCounts[contact.pipelineStage] += 1;
      sourceCounts[contact.source] += 1;
    }
    const eventCounts = new Map<string, number>();
    for (const projection of projections)
      eventCounts.set(projection.eventId, (eventCounts.get(projection.eventId) ?? 0) + 1);
    const outreachCounts = { queued: 0, sent: 0, failed: 0 };
    for (const command of outreach.filter(
      (candidate) => candidate.organizationId === organization,
    )) {
      if (command.status === "queued") outreachCounts.queued += 1;
      else if (command.status === "sent" || command.status === "delivered")
        outreachCounts.sent += 1;
      else outreachCounts.failed += 1;
    }
    return {
      organizationId: organization,
      totalContacts: contacts.length,
      activeContacts: contacts.filter((contact) => contact.status === "active").length,
      contactsByPipelineStage: stageCounts,
      contactsByEvent: [...eventCounts.entries()]
        .map(([eventId, count]) => ({ eventId, count }))
        .sort((left, right) => left.eventId.localeCompare(right.eventId)),
      contactsBySource: sourceCounts,
      outreach: outreachCounts,
      generatedAt: nowIso(this.#clock),
    };
  }

  async getAnalytics(
    actor: CrmActor,
    organizationId = actor.organizationId,
  ): Promise<CrmAnalytics> {
    return this.analytics(actor, organizationId);
  }
  async aggregateAnalytics(
    actor: CrmActor,
    organizationId = actor.organizationId,
  ): Promise<CrmAnalytics> {
    return this.analytics(actor, organizationId);
  }

  private buildContact(
    organizationId: string,
    input: CrmContactInput,
    current: CrmContact | undefined,
    fallbackSource: CrmContactSource,
  ): CrmContact {
    const firstName = input.firstName === undefined ? current?.firstName : input.firstName;
    const lastName = input.lastName === undefined ? current?.lastName : input.lastName;
    const displayName = input.displayName === undefined ? current?.displayName : input.displayName;
    const nameInput: CrmContactInput = {
      ...(firstName === undefined ? {} : { firstName }),
      ...(lastName === undefined ? {} : { lastName }),
      ...(displayName === undefined ? {} : { displayName }),
    };
    let name: {
      readonly firstName: string | null;
      readonly lastName: string | null;
      readonly displayName: string;
    };
    try {
      name = normalizedName(nameInput);
    } catch (error) {
      if (input.email === undefined && current === undefined) throw error;
      const email = input.email === undefined ? current?.email : input.email;
      const fallback = nullableEmail(email);
      if (fallback === undefined || fallback === null) throw error;
      name = { firstName: null, lastName: null, displayName: fallback };
    }
    const contact: CrmContact = {
      id: current?.id ?? this.#generateId("contact"),
      organizationId,
      firstName: name.firstName,
      lastName: name.lastName,
      displayName: name.displayName,
      email:
        input.email === undefined ? (current?.email ?? null) : (nullableEmail(input.email) ?? null),
      phone:
        input.phone === undefined
          ? (current?.phone ?? null)
          : (optionalText(input.phone, "phone", 100) ?? null),
      company:
        input.company === undefined
          ? (current?.company ?? null)
          : (optionalText(input.company, "company", 300) ?? null),
      title:
        input.title === undefined
          ? (current?.title ?? null)
          : (optionalText(input.title, "title", 300) ?? null),
      website:
        input.website === undefined
          ? (current?.website ?? null)
          : (optionalText(input.website, "website", 500) ?? null),
      linkedinUrl:
        input.linkedinUrl === undefined
          ? (current?.linkedinUrl ?? null)
          : (optionalText(input.linkedinUrl, "linkedinUrl", 500) ?? null),
      notes:
        input.notes === undefined
          ? (current?.notes ?? null)
          : (optionalText(input.notes, "notes", 10_000) ?? null),
      tags: input.tags === undefined ? (current?.tags ?? []) : normalizeTags(input.tags),
      customFields:
        input.customFields === undefined
          ? (current?.customFields ?? {})
          : normalizeCustomFields(input.customFields),
      source:
        input.source === undefined ? (current?.source ?? fallbackSource) : source(input.source),
      status: current?.status ?? "active",
      mergedIntoId: current?.mergedIntoId ?? null,
      pipelineStage:
        input.pipelineStage === undefined
          ? (current?.pipelineStage ?? "new")
          : stage(input.pipelineStage),
      version: current === undefined ? 1 : current.version + 1,
      createdAt: current?.createdAt ?? nowIso(this.#clock),
      updatedAt: nowIso(this.#clock),
    };
    if (contact.email === null && contact.displayName.length === 0)
      throw invalid("A contact needs an email or name.");
    return contact;
  }

  private pipelineTransitionAudit(
    actor: CrmActor,
    current: CrmContact,
    nextStage: CrmPipelineStage,
    createdAt: string,
    note: string | null,
  ): CrmContactTransitionAudit {
    return {
      pipeline: {
        id: this.#generateId("pipeline"),
        organizationId: current.organizationId,
        contactId: current.id,
        fromStage: current.pipelineStage,
        toStage: nextStage,
        note,
        actorId: identifier(actor.userId, "actor userId"),
        actorName: text(actor.actorName ?? actor.userId, "actor name", 320),
        createdAt,
      },
      history: {
        id: this.#generateId("history"),
        organizationId: current.organizationId,
        contactId: current.id,
        kind: "pipeline",
        eventId: null,
        sessionId: null,
        title: `Pipeline stage changed to ${nextStage}`,
        detail: note,
        occurredAt: createdAt,
        metadata: { fromStage: current.pipelineStage, toStage: nextStage },
      },
    };
  }

  private render(
    content: string,
    contact: CrmContact,
    variables: Readonly<Record<string, string>> | undefined,
  ): string {
    const values: Record<string, string> = {
      ...(variables ?? {}),
      ...contactMergeTagValues(contact),
    };
    const unknown = new Set<string>();
    const rendered = content.replace(
      /\{\{\s*([A-Za-z][A-Za-z0-9_.-]{0,99})\s*\}\}/gu,
      (_match, key: string) => {
        if (!Object.hasOwn(values, key)) {
          unknown.add(key);
          return "";
        }
        return values[key] ?? "";
      },
    );
    if (unknown.size > 0) {
      throw invalid(`Unknown outreach merge tags: ${[...unknown].sort().join(", ")}.`);
    }
    return rendered;
  }

  private requireRepository(): CrmRepository {
    if (this.#repository === undefined) throw dependencyUnavailable();
    return this.#repository;
  }

  private async runIdempotent<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const active = this.#locks.get(key) as Promise<T> | undefined;
    if (active !== undefined) return clone(await active);
    const running = operation();
    this.#locks.set(key, running);
    try {
      return clone(await running);
    } finally {
      if (this.#locks.get(key) === running) this.#locks.delete(key);
    }
  }
}

/** Deterministic repository used by unit tests. It enforces organization on every read/write. */
export class InMemoryCrmRepository implements CrmRepository {
  readonly #contacts = new Map<string, CrmContact>();
  readonly #segments = new Map<string, CrmSegment>();
  readonly #history: CrmHistoryEntry[] = [];
  readonly #pipeline: CrmPipelineEntry[] = [];
  readonly #notes: CrmNote[] = [];
  readonly #projections = new Map<string, CrmEventProjection>();
  readonly #outreach = new Map<string, CrmOutreachCommand>();
  readonly #imports = new Map<string, CrmImportResult>();
  readonly #commands = new Map<string, unknown>();
  readonly #mergeReceipts = new Map<string, CrmMergeReconciliationResult>();

  constructor(seed: CrmRepositorySeed = {}) {
    for (const contact of seed.contacts ?? [])
      this.#contacts.set(this.contactKey(contact.organizationId, contact.id), clone(contact));
    for (const segment of seed.segments ?? [])
      this.#segments.set(this.segmentKey(segment.organizationId, segment.id), clone(segment));
    this.#history.push(...(seed.history ?? []).map(clone));
    this.#pipeline.push(...(seed.pipeline ?? []).map(clone));
    this.#notes.push(...(seed.notes ?? []).map(clone));
    const projections = [
      ...(seed.projections ?? []),
      ...(seed.participantContactLinks ?? []).map((link) => ({
        ...link,
        contactId: link.crmContactId,
      })),
    ];
    for (const projection of projections) {
      const participantId = projection.participantId ?? projection.contactId;
      const crmContactId = projection.crmContactId ?? projection.contactId;
      const normalizedProjection: CrmEventProjection = {
        ...projection,
        participantId,
        crmContactId,
        contactId: crmContactId,
      };
      this.#projections.set(
        this.projectionKey(
          normalizedProjection.organizationId,
          normalizedProjection.eventId,
          participantId,
        ),
        clone(normalizedProjection),
      );
    }
    for (const command of seed.outreach ?? [])
      this.#outreach.set(
        this.commandKey(command.organizationId, command.idempotencyKey),
        clone(command),
      );
    for (const result of seed.imports ?? [])
      if (result.idempotencyKey !== undefined)
        this.#imports.set(
          this.commandKey(result.organizationId, result.idempotencyKey),
          clone(result),
        );
  }

  async listContacts(
    organizationId: string,
    filter: CrmRepositoryFilter = {},
  ): Promise<readonly CrmContact[]> {
    const normalizedQuery = filter.query?.toLowerCase();
    return [...this.#contacts.values()]
      .filter((contact) => {
        if (contact.organizationId !== organizationId) return false;
        if (filter.email !== undefined && contact.email !== filter.email) return false;
        if (
          filter.eventId !== undefined &&
          ![...this.#projections.values()].some(
            (projection) =>
              projection.organizationId === organizationId &&
              projection.eventId === filter.eventId &&
              projection.crmContactId === contact.id,
          )
        )
          return false;
        if (filter.status !== undefined && contact.status !== filter.status) return false;
        if (filter.pipelineStage !== undefined && contact.pipelineStage !== filter.pipelineStage)
          return false;
        if (
          filter.company !== undefined &&
          !(contact.company ?? "").toLowerCase().includes(filter.company.toLowerCase())
        )
          return false;
        if (filter.tags !== undefined && !filter.tags.every((tag) => contact.tags.includes(tag)))
          return false;
        if (
          normalizedQuery !== undefined &&
          ![
            contact.displayName,
            contact.email ?? "",
            contact.company ?? "",
            contact.title ?? "",
            contact.phone ?? "",
          ].some((value) => value.toLowerCase().includes(normalizedQuery))
        )
          return false;
        return true;
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map(clone);
  }

  async getContact(organizationId: string, contactId: string): Promise<CrmContact | null> {
    const contact = this.#contacts.get(this.contactKey(organizationId, contactId));
    return contact === undefined ? null : clone(contact);
  }

  async findContactByEmail(organizationId: string, email: string): Promise<CrmContact | null> {
    const normalized = email.toLowerCase();
    const found = [...this.#contacts.values()].find(
      (contact) =>
        contact.organizationId === organizationId &&
        contact.email?.toLowerCase() === normalized &&
        contact.status === "active",
    );
    return found === undefined ? null : clone(found);
  }

  async saveContact(
    contact: CrmContact,
    expectedVersion: number | null,
    transitionAudit?: CrmContactTransitionAudit,
  ): Promise<CrmContact> {
    if (contact.version !== (expectedVersion ?? 0) + 1)
      throw new CrmRepositoryConflictError("The contact version is invalid.");
    const key = this.contactKey(contact.organizationId, contact.id);
    const existing = this.#contacts.get(key);
    if (expectedVersion === null ? existing !== undefined : existing?.version !== expectedVersion)
      throw new CrmRepositoryConflictError(
        "The CRM record already exists or changed.",
        undefined,
        existing === undefined ? undefined : clone(existing),
      );
    if (
      transitionAudit !== undefined &&
      (transitionAudit.pipeline.organizationId !== contact.organizationId ||
        transitionAudit.pipeline.contactId !== contact.id ||
        transitionAudit.history.organizationId !== contact.organizationId ||
        transitionAudit.history.contactId !== contact.id)
    ) {
      throw new CrmRepositoryConflictError("The pipeline audit does not match the contact.");
    }
    this.#contacts.set(key, clone(contact));
    if (transitionAudit !== undefined) {
      this.#pipeline.push(clone(transitionAudit.pipeline));
      this.#history.push(clone(transitionAudit.history));
    }
    return clone(contact);
  }

  async listSegments(organizationId: string): Promise<readonly CrmSegment[]> {
    return [...this.#segments.values()]
      .filter((segment) => segment.organizationId === organizationId)
      .map(clone);
  }

  async getSegment(organizationId: string, segmentId: string): Promise<CrmSegment | null> {
    const segment = this.#segments.get(this.segmentKey(organizationId, segmentId));
    return segment === undefined ? null : clone(segment);
  }

  async saveSegment(segment: CrmSegment, expectedVersion: number | null): Promise<CrmSegment> {
    const key = this.segmentKey(segment.organizationId, segment.id);
    const existing = this.#segments.get(key);
    if (expectedVersion === null ? existing !== undefined : existing?.version !== expectedVersion)
      throw new CrmRepositoryConflictError();
    this.#segments.set(key, clone(segment));
    return clone(segment);
  }

  async deleteSegment(
    organizationId: string,
    segmentId: string,
    expectedVersion: number,
  ): Promise<void> {
    const key = this.segmentKey(organizationId, segmentId);
    const existing = this.#segments.get(key);
    if (existing?.version !== expectedVersion) throw new CrmRepositoryConflictError();
    this.#segments.delete(key);
  }

  async listHistory(
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmHistoryEntry[]> {
    return this.#history
      .filter((entry) => entry.organizationId === organizationId && entry.contactId === contactId)
      .map(clone);
  }

  async appendHistory(entry: CrmHistoryEntry): Promise<CrmHistoryEntry> {
    this.#history.push(clone(entry));
    return clone(entry);
  }

  async listPipelineHistory(
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmPipelineEntry[]> {
    return this.#pipeline
      .filter((entry) => entry.organizationId === organizationId && entry.contactId === contactId)
      .map(clone);
  }

  async appendPipeline(entry: CrmPipelineEntry): Promise<CrmPipelineEntry> {
    this.#pipeline.push(clone(entry));
    return clone(entry);
  }

  async listNotes(organizationId: string, contactId: string): Promise<readonly CrmNote[]> {
    return this.#notes
      .filter((note) => note.organizationId === organizationId && note.contactId === contactId)
      .map(clone);
  }

  async appendNote(note: CrmNote): Promise<CrmNote> {
    this.#notes.push(clone(note));
    return clone(note);
  }

  async getProjection(
    organizationId: string,
    eventId: string,
    crmContactId: string,
  ): Promise<CrmEventProjection | null> {
    const projection = [...this.#projections.values()].find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.eventId === eventId &&
        candidate.crmContactId === crmContactId,
    );
    return projection === undefined ? null : clone(projection);
  }

  async saveProjection(
    projection: CrmEventProjection,
    contact: CrmContact,
  ): Promise<CrmEventProjection> {
    const crmContactId = projection.crmContactId ?? projection.contactId;
    const participantId = projection.participantId ?? crmContactId;
    const normalizedProjection: CrmEventProjection = {
      ...projection,
      participantId,
      crmContactId,
      contactId: crmContactId,
    };
    const key = this.projectionKey(
      normalizedProjection.organizationId,
      normalizedProjection.eventId,
      normalizedProjection.participantId,
    );
    const storedContact = this.#contacts.get(
      this.contactKey(normalizedProjection.organizationId, normalizedProjection.crmContactId),
    );
    if (
      contact.organizationId !== normalizedProjection.organizationId ||
      contact.id !== normalizedProjection.crmContactId ||
      storedContact === undefined
    ) {
      throw new CrmRepositoryConflictError("The projected contact was not found.");
    }
    const existing = this.#projections.get(key);
    if (existing !== undefined) return clone(existing);
    this.#projections.set(key, clone(normalizedProjection));
    return clone(normalizedProjection);
  }

  async listProjections(organizationId: string): Promise<readonly CrmEventProjection[]> {
    return [...this.#projections.values()]
      .filter((projection) => projection.organizationId === organizationId)
      .map(clone);
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
    const organizationId = identifier(input.organizationId, "organizationId");
    const survivorId = identifier(input.survivorId, "survivorId");
    const retiredIds = [...new Set(input.retiredIds.map((id) => identifier(id, "retiredId")))].sort(
      (left, right) => left.localeCompare(right),
    );
    const auditId = identifier(input.auditId, "auditId");
    const receiptKey = this.commandKey(organizationId, `merge-reconcile:${auditId}`);
    const prior = this.#mergeReceipts.get(receiptKey);
    if (prior !== undefined) return clone(prior);
    const retiredSet = new Set(retiredIds);
    const projections = await this.listProjections(organizationId);
    const participantConflicts = participantConflictDetails(
      projections,
      new Set([survivorId, ...retiredIds]),
    );
    if (participantConflicts.length > 0) {
      throw new CrmRepositoryConflictError(
        "The merge would reconcile distinct participants in one event.",
        participantConflicts,
      );
    }
    const survivor = this.#contacts.get(this.contactKey(organizationId, survivorId));
    if (survivor === undefined || survivor.status !== "active")
      throw new CrmRepositoryConflictError("The merge survivor is not active.");
    for (const retiredId of retiredIds) {
      const retired = this.#contacts.get(this.contactKey(organizationId, retiredId));
      if (
        retired === undefined ||
        retired.status !== "merged" ||
        retired.mergedIntoId !== survivorId ||
        retired.mergeAuditId !== auditId
      ) {
        throw new CrmRepositoryConflictError(
          "The retired CRM contact does not match this merge audit.",
        );
      }
    }

    let participantContactLinks = 0;
    const orderedProjections = [...projections].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    for (const projection of orderedProjections) {
      if (!retiredSet.has(projectionCrmContactId(projection))) continue;
      const oldKey = this.projectionKey(
        projection.organizationId,
        projection.eventId,
        projection.participantId,
      );
      const next: CrmEventProjection = {
        ...projection,
        crmContactId: survivorId,
        contactId: survivorId,
        sourceCrmContactId: projection.sourceCrmContactId ?? projectionCrmContactId(projection),
        mergeAuditId: auditId,
        updatedAt: projection.updatedAt,
      };
      const nextKey = this.projectionKey(next.organizationId, next.eventId, next.participantId);
      this.#projections.delete(oldKey);
      const existing = this.#projections.get(nextKey);
      if (existing === undefined || existing.id === projection.id) {
        this.#projections.set(nextKey, clone(next));
      }
      participantContactLinks += 1;
    }

    let notes = 0;
    for (let index = 0; index < this.#notes.length; index += 1) {
      const note = this.#notes[index];
      if (note === undefined || !retiredSet.has(note.contactId)) continue;
      this.#notes[index] = {
        ...note,
        contactId: survivorId,
        sourceCrmContactId: note.sourceCrmContactId ?? note.contactId,
        mergeAuditId: auditId,
      };
      notes += 1;
    }

    let pipelineHistory = 0;
    for (let index = 0; index < this.#pipeline.length; index += 1) {
      const entry = this.#pipeline[index];
      if (entry === undefined || !retiredSet.has(entry.contactId)) continue;
      this.#pipeline[index] = {
        ...entry,
        contactId: survivorId,
        sourceCrmContactId: entry.sourceCrmContactId ?? entry.contactId,
        mergeAuditId: auditId,
      };
      pipelineHistory += 1;
    }

    let segments = 0;
    const orderedSegments = [...this.#segments.values()]
      .filter((segment) => segment.organizationId === organizationId)
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const segment of orderedSegments) {
      const replaced = replaceContactReference(segment.rules, retiredSet, survivorId);
      if (!replaced.changed) continue;
      const updatedSegment: CrmSegment = {
        ...segment,
        rules: replaced.value as CrmSegment["rules"],
        mergeAuditIds: [...new Set([...(segment.mergeAuditIds ?? []), auditId])],
        version: segment.version + 1,
        updatedAt: segment.updatedAt,
      };
      this.#segments.set(this.segmentKey(organizationId, segment.id), clone(updatedSegment));
      segments += 1;
    }

    const result: CrmMergeReconciliationResult = {
      survivorId,
      retiredIds,
      rewired: { participantContactLinks, notes, segments, pipelineHistory },
      participantConflicts: [],
      auditId,
    };
    this.#mergeReceipts.set(receiptKey, clone(result));
    return clone(result);
  }

  async saveOutreach(command: CrmOutreachCommand): Promise<CrmOutreachCommand> {
    const key = this.commandKey(command.organizationId, command.idempotencyKey);
    const existing = this.#outreach.get(key);
    if (existing !== undefined) return clone(existing);
    this.#outreach.set(key, clone(command));
    return clone(command);
  }
  async updateOutreach(command: CrmOutreachCommand): Promise<CrmOutreachCommand> {
    const key = this.commandKey(command.organizationId, command.idempotencyKey);
    const existing = this.#outreach.get(key);
    if (
      existing === undefined ||
      existing.id !== command.id ||
      existing.contactId !== command.contactId
    ) {
      throw new CrmRepositoryConflictError("The outreach delivery identity does not match.");
    }
    this.#outreach.set(key, clone(command));
    return clone(command);
  }

  async getOutreachByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<CrmOutreachCommand | null> {
    const command = this.#outreach.get(this.commandKey(organizationId, idempotencyKey));
    return command === undefined ? null : clone(command);
  }

  async listOutreach(organizationId: string): Promise<readonly CrmOutreachCommand[]> {
    return [...this.#outreach.values()]
      .filter((command) => command.organizationId === organizationId)
      .map(clone);
  }

  async saveImport(result: CrmImportResult): Promise<CrmImportResult> {
    if (result.idempotencyKey !== undefined)
      this.#imports.set(
        this.commandKey(result.organizationId, result.idempotencyKey),
        clone(result),
      );
    return clone(result);
  }

  async getImportByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<CrmImportResult | null> {
    const result = this.#imports.get(this.commandKey(organizationId, idempotencyKey));
    return result === undefined ? null : clone(result);
  }

  async getCommandResult<T>(
    organizationId: string,
    command: string,
    key: string,
  ): Promise<T | null> {
    const value = this.#commands.get(this.commandKey(organizationId, `${command}:${key}`));
    return value === undefined ? null : clone(value as T);
  }

  async saveCommandResult<T>(
    organizationId: string,
    command: string,
    key: string,
    value: T,
  ): Promise<void> {
    this.#commands.set(this.commandKey(organizationId, `${command}:${key}`), clone(value));
  }

  private contactKey(organizationId: string, contactId: string): string {
    return `${organizationId}\u0000${contactId}`;
  }
  private segmentKey(organizationId: string, segmentId: string): string {
    return `${organizationId}\u0000${segmentId}`;
  }
  private projectionKey(organizationId: string, eventId: string, contactId: string): string {
    return `${organizationId}\u0000${eventId}\u0000${contactId}`;
  }
  private commandKey(organizationId: string, key: string): string {
    return `${organizationId}\u0000${key}`;
  }
}
