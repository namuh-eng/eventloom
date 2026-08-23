import { standardFileRequestMimeTypes } from "@eventloom/contracts";
import {
  type CfpFormField as ApiCfpFormField,
  type CfpApi,
  CfpApiError,
  type CfpEventConfiguration,
  type CfpFormConfiguration,
} from "../cfp/api";

export const ORGANIZER_SCROLL_CONTAINER_ID = "admin-content";
const STICKY_SECTION_GAP = 16;
const DEFAULT_FILE_REQUEST_ALLOWED_MIME_TYPES = standardFileRequestMimeTypes;
const DEFAULT_FILE_REQUEST_MAX_BYTES = 25 * 1024 * 1024;

export function cfpSectionScrollOffset(
  organizerHeaderHeight: number,
  navigationHeight: number,
): number {
  return organizerHeaderHeight + navigationHeight + STICKY_SECTION_GAP;
}

export function cfpActiveSectionThreshold(
  organizerHeaderHeight: number,
  navigationHeight: number,
): number {
  return cfpSectionScrollOffset(organizerHeaderHeight, navigationHeight) + 24;
}

export function cfpContainerScrollTop(
  containerScrollTop: number,
  targetTop: number,
  containerTop: number,
  navigationHeight: number,
): number {
  return Math.max(
    0,
    containerScrollTop + targetTop - containerTop - cfpSectionScrollOffset(0, navigationHeight),
  );
}

export type FieldType =
  | "text"
  | "email"
  | "url"
  | "textarea"
  | "select"
  | "multi_select"
  | "rich_text"
  | "boolean"
  | "number"
  | "file_request";

export interface CfpFormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  visible: boolean;
  placeholder: string;
  sectionId?: string;
  key?: string;
  kind?: string;
  options?: ApiCfpFormField["options"];
  fieldRef?: NonNullable<ApiCfpFormField["fieldRef"]>;
  fieldVersion?: number;
  fileRequest?: NonNullable<ApiCfpFormField["fileRequest"]>;
  config?: Record<string, unknown>;
  description?: string;
  /** Platform-owned fields that cannot be removed or re-keyed. */
  system?: boolean;
  keyLocked?: boolean;
}

/** Canonical submission title answer key used by submit/review/export. */
export const CANONICAL_TITLE_FIELD_KEY = "title" as const;

export function fieldStorageKey(field: Pick<CfpFormField, "id" | "key">): string {
  return field.key ?? field.id;
}

export function isCanonicalTitleField(field: Pick<CfpFormField, "id" | "key">): boolean {
  return (
    field.id === CANONICAL_TITLE_FIELD_KEY || fieldStorageKey(field) === CANONICAL_TITLE_FIELD_KEY
  );
}

export function isKeyLockedField(
  field: Pick<CfpFormField, "id" | "key" | "keyLocked" | "system">,
): boolean {
  return field.keyLocked === true || isCanonicalTitleField(field);
}

export function isSystemOwnedField(field: Pick<CfpFormField, "id" | "key" | "system">): boolean {
  return field.system === true || isCanonicalTitleField(field);
}

function looksLikeTitleField(field: Pick<CfpFormField, "id" | "key" | "label">): boolean {
  const key = fieldStorageKey(field).toLocaleLowerCase();
  const label = field.label.trim().toLocaleLowerCase();
  if (key === CANONICAL_TITLE_FIELD_KEY || field.id === CANONICAL_TITLE_FIELD_KEY) return true;
  if (key === "title1" || key.startsWith("title-") || key.endsWith("-title")) return true;
  return label === "title" || label === "session title" || label.startsWith("session title");
}

export interface CfpCondition {
  type: "condition";
  field: string;
  operator: "is" | "is not";
  value: string;
}

export interface CfpConditionGroup {
  type: "group";
  operator: "AND" | "OR";
  conditions: CfpRule[];
}

export type CfpRule = CfpCondition | CfpConditionGroup;

export interface CfpConfiguration {
  eventName: string;
  slug: string;
  timezone: string;
  eventStartsAt?: string;
  opensAt: string;
  closesAt: string;
  persistedOpensAt?: string;
  persistedClosesAt?: string;
  participantLimit: number;
  proposalLimit: number;
  reminderEmails: boolean;
  adminNotifications: boolean;
  welcomeTitle: string;
  welcomeBody: string;
  confirmationTitle: string;
  confirmationBody: string;
  successMessage: string;
  redirectUrl: string;
  tracks: string[];
  tags: string[];
  formats: string[];
  levels: string[];
  helpfulLinks: Array<{ label: string; href: string }>;
  fields: CfpFormField[];
  participantFields?: CfpFormField[];
  sections?: CfpFormConfiguration["sections"];
  rules?: CfpFormConfiguration["rules"];
  rule: CfpRule;
  ruleAction: string;
  ruleTargetField?: string | undefined;
  editorRuleId?: string | undefined;
  id?: string;
  status?: "draft" | "published" | "closed";
  eventVersion?: number;
  formVersion?: number;
}
export interface CfpEditorProps {
  eventId: string;
  organizationId: string;
  formId?: string;
  api?: CfpApi;
}

export function updateCfpShowWhenCondition(
  configuration: CfpConfiguration,
  patch: Partial<Omit<CfpCondition, "type" | "operator">>,
): CfpConfiguration {
  return {
    ...configuration,
    rule: {
      ...firstRuleCondition(configuration.rule),
      ...patch,
      operator: "is",
    },
  };
}

function replaceRuleField(rule: CfpRule, currentKey: string, nextKey: string): CfpRule {
  if (rule.type === "condition") {
    return rule.field === currentKey ? { ...rule, field: nextKey } : rule;
  }
  return {
    ...rule,
    conditions: rule.conditions.map((condition) =>
      replaceRuleField(condition, currentKey, nextKey),
    ),
  };
}

function replacePersistedRuleField(value: unknown, currentKey: string, nextKey: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => replacePersistedRuleField(entry, currentKey, nextKey));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "fieldKey" && entry === currentKey
        ? nextKey
        : replacePersistedRuleField(entry, currentKey, nextKey),
    ]),
  );
}

export function updateCfpEditorField(
  configuration: CfpConfiguration,
  fieldId: string,
  patch: Partial<CfpFormField>,
): CfpConfiguration {
  const field = configuration.fields.find((candidate) => candidate.id === fieldId);
  if (field === undefined) return configuration;
  const currentKey = fieldStorageKey(field);
  const requestedKey = patch.key ?? currentKey;
  const locked = isKeyLockedField(field);
  // Canonical/system keys cannot be renamed, and no other field may claim `title`.
  const nextKey = locked
    ? currentKey
    : requestedKey === CANONICAL_TITLE_FIELD_KEY
      ? currentKey
      : requestedKey;
  const nextPatch: Partial<CfpFormField> = {
    ...patch,
    key: nextKey,
    ...(locked
      ? {
          keyLocked: true,
          system: field.system === true || isCanonicalTitleField(field),
          ...(isCanonicalTitleField(field) ? { required: true } : {}),
        }
      : {}),
  };
  const keyChanged = nextKey !== currentKey;
  return {
    ...configuration,
    fields: configuration.fields.map((candidate) =>
      candidate.id === fieldId ? { ...candidate, ...nextPatch } : candidate,
    ),
    ...(keyChanged
      ? {
          rule: replaceRuleField(configuration.rule, currentKey, nextKey),
          ruleTargetField:
            configuration.ruleTargetField === currentKey ? nextKey : configuration.ruleTargetField,
          ...(configuration.rules === undefined
            ? {}
            : {
                rules: configuration.rules.map(
                  (rule) =>
                    replacePersistedRuleField(
                      rule,
                      currentKey,
                      nextKey,
                    ) as (typeof configuration.rules)[number],
                ),
              }),
        }
      : {}),
  };
}

export function removeCfpEditorField(
  configuration: CfpConfiguration,
  fieldId: string,
): CfpConfiguration {
  const field = configuration.fields.find((candidate) => candidate.id === fieldId);
  if (field === undefined || isSystemOwnedField(field)) {
    return configuration;
  }
  return {
    ...configuration,
    fields: configuration.fields.filter((candidate) => candidate.id !== fieldId),
  };
}

const CORE_PROPOSAL_FIELDS: readonly CfpFormField[] = [
  {
    id: "title",
    key: CANONICAL_TITLE_FIELD_KEY,
    label: "Session title",
    type: "text",
    required: true,
    visible: true,
    placeholder: "A clear, specific title",
    options: [],
    system: true,
    keyLocked: true,
  },
  {
    id: "abstract",
    key: "abstract",
    label: "Abstract",
    type: "textarea",
    required: false,
    visible: true,
    placeholder: "A concise summary for reviewers and attendees",
    options: [],
  },
  {
    id: "description",
    key: "description",
    label: "Description",
    type: "textarea",
    required: false,
    visible: true,
    placeholder: "Objectives, outline, and expected audience takeaways",
    options: [],
  },
];
function firstCoreProposalField(): CfpFormField {
  const field = CORE_PROPOSAL_FIELDS[0];
  if (field === undefined) {
    throw new Error("The core proposal field set must not be empty.");
  }
  return field;
}

function asCanonicalTitleField(
  field: CfpFormField,
  fallback: CfpFormField = firstCoreProposalField(),
): CfpFormField {
  return {
    ...fallback,
    ...field,
    id: field.id || fallback.id,
    key: CANONICAL_TITLE_FIELD_KEY,
    type: field.type || fallback.type,
    required: true,
    visible: field.visible ?? fallback.visible,
    label: field.label || fallback.label,
    placeholder: field.placeholder || fallback.placeholder,
    options: [...(field.options ?? fallback.options ?? [])],
    system: true,
    keyLocked: true,
  };
}

/**
 * Ensures exactly one canonical title field with key `title`, repairing common
 * mis-keys such as `title1` when the intent is unambiguous.
 */
export function repairCanonicalTitleFields(fields: CfpFormField[]): CfpFormField[] {
  const titleByKey = fields.find((field) => fieldStorageKey(field) === CANONICAL_TITLE_FIELD_KEY);
  if (titleByKey) {
    return fields.map((field) =>
      field.id === titleByKey.id || fieldStorageKey(field) === CANONICAL_TITLE_FIELD_KEY
        ? asCanonicalTitleField(field)
        : field,
    );
  }

  const titleById = fields.find((field) => field.id === CANONICAL_TITLE_FIELD_KEY);
  if (titleById) {
    return fields.map((field) =>
      field.id === titleById.id ? asCanonicalTitleField(field) : field,
    );
  }

  const titleLike = fields.filter((field) => looksLikeTitleField(field));
  if (titleLike.length === 1) {
    const target = titleLike[0];
    if (target === undefined) return [asCanonicalTitleField(firstCoreProposalField()), ...fields];
    return fields.map((field) => (field.id === target.id ? asCanonicalTitleField(field) : field));
  }

  return [asCanonicalTitleField(firstCoreProposalField()), ...fields];
}

export function withCoreProposalFields(fields: CfpFormField[]): CfpFormField[] {
  const repaired = repairCanonicalTitleFields(fields);
  const coreKeys = new Set(CORE_PROPOSAL_FIELDS.map((field) => field.key ?? field.id));
  const fieldsByKey = new Map(repaired.map((field) => [fieldStorageKey(field), field]));
  return [
    ...CORE_PROPOSAL_FIELDS.map((field) => {
      const existing = fieldsByKey.get(field.key ?? field.id);
      if (existing === undefined) {
        return field.key === CANONICAL_TITLE_FIELD_KEY
          ? asCanonicalTitleField(field)
          : { ...field, options: [...(field.options ?? [])] };
      }
      if ((field.key ?? field.id) === CANONICAL_TITLE_FIELD_KEY) {
        return asCanonicalTitleField(existing, field);
      }
      return existing;
    }),
    ...repaired.filter((field) => !coreKeys.has(fieldStorageKey(field))),
  ];
}

export function createEmptyCfpConfiguration(eventId: string): CfpConfiguration {
  return {
    eventName: "",
    slug: "",
    timezone: "UTC",
    opensAt: "",
    closesAt: "",
    participantLimit: 1,
    proposalLimit: 20,
    reminderEmails: false,
    adminNotifications: false,
    welcomeTitle: "",
    welcomeBody: "",
    confirmationTitle: "",
    confirmationBody: "",
    successMessage: "",
    redirectUrl: "",
    tracks: [],
    tags: [],
    formats: [],
    levels: [],
    helpfulLinks: [],
    fields: withCoreProposalFields([]),
    rule: {
      type: "condition",
      field: "",
      operator: "is",
      value: "",
    },
    ruleAction: "",
    ruleTargetField: undefined,
    id: `${eventId}-cfp`,
    status: "draft",
  };
}

export const SECTION_LINKS = [
  { id: "event-details", label: "Event details" },
  { id: "messaging", label: "Messaging" },
  { id: "taxonomy", label: "Taxonomy & links" },
  { id: "fields-rules", label: "Fields & rules" },
  { id: "public-preview", label: "Public preview" },
] as const;

export function resolveCfpEditorStepIndex(input: {
  currentIndex: number;
  requestedIndex: number;
  currentStepValid: boolean;
}): number {
  const lastIndex = SECTION_LINKS.length - 1;
  const requestedIndex = Math.min(lastIndex, Math.max(0, input.requestedIndex));
  if (requestedIndex > input.currentIndex && !input.currentStepValid) {
    return input.currentIndex;
  }
  return requestedIndex;
}

export const TIMEZONE_OPTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

function validCfpTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
export function cfpMinimumDate(now = new Date(), timeZone = "UTC"): string {
  if (!Number.isFinite(now.getTime())) return "";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: validCfpTimeZone(timeZone) ? timeZone : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function localCfpDateToIso(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match || !validCfpTimeZone(timeZone)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const localMilliseconds = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(localMilliseconds)) return null;
  let candidate = localMilliseconds;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts: Record<string, string> = {};
    const formatParts = formatter.formatToParts(new Date(candidate));
    const length = formatParts.length;
    for (let index = 0; index < length; index += 1) {
      if (!(index in formatParts)) continue;
      const part = formatParts[index];
      if (part === undefined) continue;
      if (part.type !== "literal") {
        parts[part.type] = part.value;
      }
    }
    const wallMilliseconds = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    candidate = localMilliseconds - (wallMilliseconds - candidate);
  }
  const result = new Date(candidate);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}

function instantFromDate(value: string, timeZone = "UTC"): string {
  if (value.includes("T")) return value;
  return localCfpDateToIso(value, timeZone) ?? `${value}T00:00:00.000Z`;
}

function instantFromEditedDate(
  value: string,
  persistedInstant: string | undefined,
  timeZone: string,
): string {
  if (
    !value.includes("T") &&
    persistedInstant !== undefined &&
    dateFromInstant(persistedInstant, timeZone) === value
  ) {
    return persistedInstant;
  }
  return instantFromDate(value, timeZone);
}

export function dateFromInstant(value: string, timeZone = "UTC"): string {
  return (
    cfpMinimumDate(new Date(value), timeZone) || (value.length >= 10 ? value.slice(0, 10) : value)
  );
}

export function validateCfpDateRange(
  opensAt: string,
  closesAt: string,
  timeZone = "UTC",
  persistedOpensAt?: string,
  persistedClosesAt?: string,
): string | null {
  const openTime = Date.parse(instantFromEditedDate(opensAt, persistedOpensAt, timeZone));
  const closeTime = Date.parse(instantFromEditedDate(closesAt, persistedClosesAt, timeZone));
  if (!Number.isFinite(openTime) || !Number.isFinite(closeTime)) {
    return "Enter valid open and close dates.";
  }
  if (openTime >= closeTime) {
    return "The close date must be after the open date.";
  }
  return null;
}

export function isCfpCloseDatePast(
  value: string,
  now = new Date(),
  timeZone = "UTC",
  persistedInstant?: string,
): boolean {
  const closeTime = Date.parse(instantFromEditedDate(value, persistedInstant, timeZone));
  return Number.isFinite(closeTime) && closeTime < now.getTime();
}
export function closeCfpNowInstant(
  opensAt: string,
  now = new Date(),
  timeZone = "UTC",
  persistedOpensAt?: string,
): string | null {
  const openTime = Date.parse(instantFromEditedDate(opensAt, persistedOpensAt, timeZone));
  const nowTime = now.getTime();
  if (!Number.isFinite(openTime) || !Number.isFinite(nowTime)) return null;

  // The API rejects an instant before the opening instant. When an organizer
  // closes a not-yet-open CFP, use the first valid instant after opening.
  return new Date(Math.max(nowTime, openTime + 1)).toISOString();
}

export function closeCfpNowConfiguration(
  configuration: CfpConfiguration,
  now = new Date(),
): CfpConfiguration {
  const closesAt = closeCfpNowInstant(
    configuration.opensAt,
    now,
    configuration.timezone,
    configuration.persistedOpensAt,
  );
  if (closesAt === null) {
    throw new Error("The CFP cannot be closed because its opening instant is invalid.");
  }
  return { ...configuration, closesAt };
}
export function selectEditorForm(
  forms: CfpFormConfiguration[],
  organizationId: string,
  eventId: string,
): CfpFormConfiguration | undefined {
  const statusOrder = { published: 0, draft: 1, closed: 2 } as const;
  return forms
    .filter((form) => form.tenantId === organizationId && form.eventId === eventId)
    .slice()
    .sort((left, right) => {
      return (
        statusOrder[left.status] - statusOrder[right.status] ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      );
    })[0];
}

export type CfpEditorLoadResult = {
  readonly event: CfpEventConfiguration;
  readonly form: CfpFormConfiguration | undefined;
};

const inFlightCfpEditorLoads = new WeakMap<CfpApi, Map<string, Promise<CfpEditorLoadResult>>>();

export async function loadCfpEditorConfiguration(
  api: CfpApi,
  input: { readonly organizationId: string; readonly eventId: string; readonly formId?: string },
): Promise<CfpEditorLoadResult> {
  const cacheKey = `${input.organizationId}\u0000${input.eventId}\u0000${input.formId ?? ""}`;
  const apiLoads =
    inFlightCfpEditorLoads.get(api) ?? new Map<string, Promise<CfpEditorLoadResult>>();
  inFlightCfpEditorLoads.set(api, apiLoads);
  const existing = apiLoads.get(cacheKey);
  if (existing !== undefined) return existing;

  const request = (async (): Promise<CfpEditorLoadResult> => {
    const event = await api.getEvent({
      organizationId: input.organizationId,
      eventId: input.eventId,
    });
    if (input.formId !== undefined) {
      try {
        const form = await api.getForm({
          organizationId: input.organizationId,
          eventId: input.eventId,
          formId: input.formId,
        });
        return { event, form };
      } catch (error) {
        if (!(error instanceof CfpApiError) || error.status !== 404) throw error;
        return { event, form: undefined };
      }
    }
    const forms = await api.listForms({
      organizationId: input.organizationId,
      eventId: input.eventId,
    });
    return {
      event,
      form: selectEditorForm(forms, input.organizationId, input.eventId),
    };
  })();
  apiLoads.set(cacheKey, request);

  try {
    return await request;
  } finally {
    if (apiLoads.get(cacheKey) === request) apiLoads.delete(cacheKey);
  }
}

export function editorFieldType(kind: string): FieldType {
  switch (kind) {
    case "email":
      return "email";
    case "url":
      return "url";
    case "rich_text":
      return "textarea";
    case "textarea":
      return "textarea";
    case "select":
      return "select";
    case "multi_select":
      return "multi_select";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "file_request":
      return "file_request";
    default:
      return "text";
  }
}

function toEditorField(field: ApiCfpFormField): CfpFormField {
  const { config, description, fieldRef, fieldVersion, fileRequest, ...canonicalField } = field;
  return {
    ...canonicalField,
    type: editorFieldType(field.kind),
    required: field.required,
    visible: true,
    placeholder: field.placeholder ?? "",
    options: [...field.options],
    ...(description === undefined ? {} : { description }),
    ...(fieldRef === undefined ? {} : { fieldRef }),
    ...(fieldVersion === undefined ? {} : { fieldVersion }),
    ...(fileRequest === undefined ? {} : { fileRequest }),
    ...(config === undefined ? {} : { config }),
  };
}
export function fieldKeyForRuleField(field: string, fields: CfpFormField[]): string {
  const normalized = field.trim().toLocaleLowerCase();
  const matched = fields.find(
    (candidate) =>
      candidate.key?.toLocaleLowerCase() === normalized ||
      candidate.id.toLocaleLowerCase() === normalized ||
      candidate.label.toLocaleLowerCase() === normalized,
  );
  if (matched?.key) return matched.key;
  if (["format", "track", "tags", "level", "language"].includes(normalized)) return normalized;
  return field.trim();
}

function serverRuleCondition(rule: CfpRule, fields: CfpFormField[]): Record<string, unknown> {
  if (rule.type === "condition") {
    return {
      type: "predicate",
      fieldKey: fieldKeyForRuleField(rule.field, fields),
      operator: rule.operator === "is not" ? "not_equals" : "equals",
      value: rule.value,
    };
  }
  return {
    type: "group",
    operator: rule.operator === "OR" ? "any" : "all",
    conditions: rule.conditions.map((condition) => serverRuleCondition(condition, fields)),
  };
}

function editorConditionalRule(
  configuration: CfpConfiguration,
  fields: CfpFormField[],
): Record<string, unknown> | null {
  if (validateCfpEditorConditionalRule(configuration) !== null) return null;
  const targetField = configuration.ruleTargetField?.trim();
  if (!targetField) return null;
  const target = fields.find(
    (field) => field.key === targetField || field.id === targetField || field.label === targetField,
  );
  if (!target?.key) return null;
  const existingRule = configuration.rules?.find(
    (rule) => rule.id === (configuration.editorRuleId ?? "editor-conditional-rule"),
  );
  const serverRule = serverRuleCondition(configuration.rule, fields);
  return {
    ...existingRule,
    id: configuration.editorRuleId ?? "editor-conditional-rule",
    priority:
      existingRule !== undefined && typeof existingRule.priority === "number"
        ? existingRule.priority
        : 100,
    when:
      serverRule.type === "group"
        ? serverRule
        : {
            type: "group",
            operator: "all",
            conditions: [serverRule],
          },
    actions: [{ type: "show_field", fieldKey: target.key }],
  };
}
export function cfpRuleFields(configuration: CfpConfiguration): CfpFormField[] {
  const taxonomyFields: CfpFormField[] = [
    {
      id: "server-format",
      key: "format",
      label: "Format",
      type: "select",
      required: false,
      visible: true,
      placeholder: "",
      options: configuration.formats,
    },
    {
      id: "server-tags",
      key: "tags",
      label: "Tags",
      type: "multi_select",
      required: false,
      visible: true,
      placeholder: "",
      options: configuration.tags,
    },
    {
      id: "server-track",
      key: "track",
      label: "Track",
      type: "select",
      required: false,
      visible: true,
      placeholder: "",
      options: configuration.tracks,
    },
    {
      id: "server-level",
      key: "level",
      label: "Level",
      type: "select",
      required: false,
      visible: true,
      placeholder: "",
      options: configuration.levels,
    },
    {
      id: "server-language",
      key: "language",
      label: "Language",
      type: "select",
      required: false,
      visible: true,
      placeholder: "",
      options: ["English"],
    },
  ];
  return [
    ...configuration.fields.map((field) => {
      const taxonomyField = taxonomyFields.find(
        (candidate) => fieldStorageKey(candidate) === fieldStorageKey(field),
      );
      return taxonomyField === undefined
        ? field
        : { ...field, options: taxonomyField.options ?? [] };
    }),
    ...taxonomyFields.filter(
      (taxonomyField) =>
        !configuration.fields.some(
          (field) => fieldStorageKey(field) === fieldStorageKey(taxonomyField),
        ),
    ),
  ];
}

function ruleConditions(rule: CfpRule): CfpCondition[] {
  return rule.type === "condition" ? [rule] : rule.conditions.flatMap(ruleConditions);
}

export function validateCfpEditorConditionalRule(configuration: CfpConfiguration): string | null {
  const conditions = ruleConditions(configuration.rule);
  const sourceIsEmpty = conditions.every(
    (condition) => !condition.field.trim() && !condition.value.trim(),
  );
  const target = configuration.ruleTargetField?.trim() ?? "";

  if (sourceIsEmpty && !target) return null;
  if (sourceIsEmpty) return "Conditional rule source field is required.";
  if (!target) return "Conditional rule target field is required.";

  const fields = cfpRuleFields(configuration);
  const resolvedTarget = configuration.fields.find((field) => fieldStorageKey(field) === target);
  if (resolvedTarget === undefined) {
    return "Conditional rule target field must be a current form field.";
  }

  for (const condition of conditions) {
    const source = condition.field.trim();
    const value = condition.value.trim();
    if (!source) return "Conditional rule source field is required.";
    if (!value) return "Conditional rule source value is required.";

    const resolvedSource = fields.find((field) => fieldStorageKey(field) === source);
    if (resolvedSource === undefined) {
      return "Conditional rule source field must be a current field.";
    }
    if (fieldStorageKey(resolvedSource) === fieldStorageKey(resolvedTarget)) {
      return "Conditional rule target field must differ from the source field.";
    }
    if (!fieldOptionValues(resolvedSource).includes(value)) {
      return "Conditional rule source value must be one of the selected field's options.";
    }
  }
  return null;
}

function toEventConfiguration(
  configuration: CfpConfiguration,
  organizationId: string,
  eventId: string,
): CfpEventConfiguration {
  return {
    id: eventId,
    tenantId: organizationId,
    version: configuration.eventVersion ?? 1,
    slug: configuration.slug,
    name: configuration.eventName,
    timezone: configuration.timezone,
    opensAt: instantFromEditedDate(
      configuration.opensAt,
      configuration.persistedOpensAt,
      configuration.timezone,
    ),
    closesAt: instantFromEditedDate(
      configuration.closesAt,
      configuration.persistedClosesAt,
      configuration.timezone,
    ),
  };
}

export function toFormConfiguration(
  configuration: CfpConfiguration,
  organizationId: string,
  eventId: string,
): CfpFormConfiguration {
  const toServerField = (
    field: CfpFormField,
    fallbackSectionId: string,
    fileOwner: "submission" | "participant",
  ): ApiCfpFormField => {
    const kind =
      field.kind ??
      (field.type === "textarea" ? "rich_text" : field.type === "email" ? "email" : field.type);
    const fileRequest =
      kind === "file_request"
        ? {
            allowedMimeTypes: field.fileRequest?.allowedMimeTypes ?? [
              ...DEFAULT_FILE_REQUEST_ALLOWED_MIME_TYPES,
            ],
            maxBytes: field.fileRequest?.maxBytes ?? DEFAULT_FILE_REQUEST_MAX_BYTES,
            required: field.required,
            owner: fileOwner,
          }
        : undefined;
    return {
      id: field.id,
      sectionId: field.sectionId ?? fallbackSectionId,
      key: field.key ?? field.id,
      label: field.label,
      kind,
      ...(field.description === undefined ? {} : { description: field.description }),
      ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
      required: field.required,
      options: field.options ?? [],
      ...(field.fieldRef === undefined ? {} : { fieldRef: field.fieldRef }),
      ...(field.fieldVersion === undefined ? {} : { fieldVersion: field.fieldVersion }),
      ...(fileRequest === undefined ? {} : { fileRequest }),
      ...(field.config === undefined ? {} : { config: field.config }),
    };
  };
  const defaultSectionId = configuration.sections?.[0]?.id ?? "session";
  const taxonomyOptions: Record<string, string[]> = {
    format: configuration.formats,
    tags: configuration.tags,
    track: configuration.tracks,
    level: configuration.levels,
    language: ["English"],
  };
  const fields = configuration.fields.map((field) => {
    const options = field.key === undefined ? undefined : taxonomyOptions[field.key];
    return toServerField(
      options === undefined ? field : { ...field, options },
      defaultSectionId,
      "submission",
    );
  });
  const existingFieldKeys = new Set(fields.map((field) => field.key));
  const taxonomyFields = [
    { key: "format", label: "Format", kind: "select", options: configuration.formats },
    { key: "tags", label: "Tags", kind: "multi_select", options: configuration.tags },
    { key: "track", label: "Track", kind: "select", options: configuration.tracks },
    { key: "level", label: "Level", kind: "select", options: configuration.levels },
    { key: "language", label: "Language", kind: "select", options: ["English"] },
  ]
    .filter((field) => field.options.length > 0)
    .map((field) =>
      toServerField(
        {
          id: `server-${field.key}`,
          key: field.key,
          label: field.label,
          type: editorFieldType(field.kind),
          kind: field.kind,
          required: false,
          visible: true,
          placeholder: "",
          options: field.options,
        },
        defaultSectionId,
        "submission",
      ),
    );
  const editorRuleId = configuration.editorRuleId;
  const ruleRecords =
    editorRuleId === undefined
      ? [...(configuration.rules ?? [])]
      : [...(configuration.rules ?? [])].filter(
          (rule) => !(typeof rule === "object" && rule !== null && rule.id === editorRuleId),
        );
  const editorFields = [...fields, ...taxonomyFields].map(toEditorField);
  const generatedRule = editorConditionalRule(configuration, editorFields);
  const sections =
    configuration.sections && configuration.sections.length > 0
      ? configuration.sections.map((section) => ({ ...section }))
      : [{ id: defaultSectionId, title: "Proposal", description: configuration.welcomeBody }];
  const participantFields =
    configuration.participantFields && configuration.participantFields.length > 0
      ? [
          ...configuration.participantFields.map((field) =>
            toServerField(field, defaultSectionId, "participant"),
          ),
          ...(configuration.participantFields.some(
            (field) => (field.key ?? field.id) === "biography",
          )
            ? []
            : [
                {
                  id: "participant-bio",
                  sectionId: defaultSectionId,
                  key: "biography",
                  label: "Speaker bio",
                  kind: "rich_text" as const,
                  required: false,
                  options: [] as string[],
                },
              ]),
        ]
      : [
          {
            id: "participant-first-name",
            sectionId: defaultSectionId,
            key: "firstName",
            label: "First name",
            kind: "text" as const,
            required: true,
            options: [] as string[],
          },
          {
            id: "participant-last-name",
            sectionId: defaultSectionId,
            key: "lastName",
            label: "Last name",
            kind: "text" as const,
            required: true,
            options: [] as string[],
          },
          {
            id: "participant-email",
            sectionId: defaultSectionId,
            key: "email",
            label: "Email",
            kind: "email" as const,
            required: true,
            options: [] as string[],
          },
          {
            id: "participant-bio",
            sectionId: defaultSectionId,
            key: "biography",
            label: "Speaker bio",
            kind: "rich_text" as const,
            required: false,
            options: [] as string[],
          },
        ];
  return {
    id: configuration.id ?? `${eventId}-cfp`,
    tenantId: organizationId,
    eventId,
    name:
      configuration.welcomeTitle.trim() || configuration.eventName.trim() || "Call for proposals",
    version: configuration.formVersion ?? 1,
    status: configuration.status ?? "draft",
    welcomeContent: `${configuration.welcomeTitle}\n${configuration.welcomeBody}`,
    settings: {
      speakerLimit: configuration.participantLimit,
      maxSubmissionsPerAccount: configuration.proposalLimit,
      remindersEnabled: configuration.reminderEmails,
      adminNotificationsEnabled: configuration.adminNotifications,
      confirmationMessage: `${configuration.confirmationTitle}\n${configuration.confirmationBody}`,
      successContent: configuration.successMessage,
      ...(configuration.redirectUrl ? { redirectUrl: configuration.redirectUrl } : {}),
    },
    sections,
    submissionFields: [
      ...fields,
      ...taxonomyFields.filter((field) => !existingFieldKeys.has(field.key)),
    ],
    rules: [...ruleRecords, ...(generatedRule === null ? [] : [generatedRule])],
    participantFields,
  };
}
export interface PersistCfpConfigurationInput {
  configuration: CfpConfiguration;
  organizationId: string;
  eventId: string;
  formId: string;
}

export async function persistCfpConfiguration(
  api: CfpApi,
  input: PersistCfpConfigurationInput,
): Promise<{ event: CfpEventConfiguration; form: CfpFormConfiguration }> {
  const dateError = validateCfpDateRange(
    input.configuration.opensAt,
    input.configuration.closesAt,
    input.configuration.timezone,
    input.configuration.persistedOpensAt,
    input.configuration.persistedClosesAt,
  );
  if (dateError !== null) throw new Error(dateError);

  const conditionalRuleError = validateCfpEditorConditionalRule(input.configuration);
  if (conditionalRuleError !== null) throw new Error(conditionalRuleError);

  return api.saveConfiguration({
    organizationId: input.organizationId,
    eventId: input.eventId,
    event: toEventConfiguration(
      {
        ...input.configuration,
        eventVersion:
          input.configuration.eventVersion === undefined ? 1 : input.configuration.eventVersion + 1,
      },
      input.organizationId,
      input.eventId,
    ),
    form: toFormConfiguration(
      {
        ...input.configuration,
        id: input.formId,
        formVersion:
          input.configuration.formVersion === undefined ? 1 : input.configuration.formVersion + 1,
      },
      input.organizationId,
      input.eventId,
    ),
    expectedEventVersion: input.configuration.eventVersion ?? null,
    expectedFormVersion: input.configuration.formVersion ?? null,
  });
}

function emptyEditorRule(): CfpCondition {
  return { type: "condition", field: "", operator: "is", value: "" };
}

function canonicalEditorRule(
  rule: Record<string, unknown>,
  submissionFields: CfpFormConfiguration["submissionFields"],
): { id: string; condition: CfpRule; target: string } | null {
  if (typeof rule.id !== "string" || !Array.isArray(rule.actions) || rule.actions.length !== 1) {
    return null;
  }
  const action = rule.actions[0];
  if (
    typeof action !== "object" ||
    action === null ||
    Array.isArray(action) ||
    !hasExactKeys(action as Record<string, unknown>, ["type", "fieldKey"]) ||
    action.type !== "show_field" ||
    typeof action.fieldKey !== "string" ||
    !submissionFields.some((field) => field.key === action.fieldKey)
  ) {
    return null;
  }
  if (!("when" in rule)) return null;
  const condition = editorRuleCondition(rule.when);
  return condition === null ? null : { id: rule.id, condition, target: action.fieldKey };
}

function recognizedEditorRule(
  form: CfpFormConfiguration,
  current: CfpConfiguration,
): { id: string; condition: CfpRule; target: string } | null {
  const canonicalRules = form.rules.flatMap((rule) => {
    const candidate = canonicalEditorRule(rule, form.submissionFields);
    return candidate === null ? [] : [candidate];
  });
  const knownIds = new Set(
    ["editor-conditional-rule", current.editorRuleId].filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const known = canonicalRules.find((rule) => knownIds.has(rule.id));
  if (known !== undefined) return known;
  return canonicalRules.length === 1 ? (canonicalRules[0] ?? null) : null;
}
export function configurationFromServer(
  current: CfpConfiguration,
  event: CfpEventConfiguration,
  form: CfpFormConfiguration,
): CfpConfiguration {
  const settings = form.settings;
  const readString = (key: string, fallback: string): string => {
    const value = settings[key];
    return typeof value === "string" ? value : fallback;
  };
  const readBoolean = (key: string, fallback: boolean): boolean => {
    const value = settings[key];
    return typeof value === "boolean" ? value : fallback;
  };
  const readNumber = (key: string, fallback: number): number => {
    const value = settings[key];
    return typeof value === "number" ? value : fallback;
  };
  const optionsFor = (key: string, fallback: string[]): string[] => {
    const field = form.submissionFields.find((candidate) => candidate.key === key);
    const fieldOptions = field?.options;
    const options: string[] = [];
    if (fieldOptions !== undefined) {
      const length = fieldOptions.length;
      for (let index = 0; index < length; index += 1) {
        if (!(index in fieldOptions)) continue;
        const option = fieldOptions[index];
        if (typeof option !== "string") continue;
        const trimmed = option.trim();
        if (trimmed) options.push(trimmed);
      }
    }
    return options.length > 0 ? options : fallback;
  };
  const editorRule = recognizedEditorRule(form, current);
  const persistedRuleTarget = editorRule?.target;
  const persistedEditorCondition = editorRule?.condition;
  const persistedRuleTargetLabel =
    persistedRuleTarget === undefined
      ? undefined
      : form.submissionFields.find((field) => field.key === persistedRuleTarget)?.label;
  const [welcomeTitle = current.welcomeTitle, ...welcomeBody] = form.welcomeContent.split("\n");
  return {
    ...current,
    id: form.id,
    status: form.status,
    eventVersion: event.version,
    formVersion: form.version,
    eventName: event.name,
    slug: event.slug,
    timezone: event.timezone,
    ...(event.eventStartsAt === undefined ? {} : { eventStartsAt: event.eventStartsAt }),
    opensAt: dateFromInstant(event.opensAt, event.timezone),
    closesAt: dateFromInstant(event.closesAt, event.timezone),
    persistedOpensAt: event.opensAt,
    persistedClosesAt: event.closesAt,
    participantLimit: readNumber("speakerLimit", current.participantLimit),
    proposalLimit: readNumber("maxSubmissionsPerAccount", current.proposalLimit),
    tracks: optionsFor("track", current.tracks),
    tags: optionsFor("tags", current.tags),
    formats: optionsFor("format", current.formats),
    levels: optionsFor("level", current.levels),
    reminderEmails: readBoolean("remindersEnabled", current.reminderEmails),
    adminNotifications: readBoolean("adminNotificationsEnabled", current.adminNotifications),
    welcomeTitle,
    welcomeBody: welcomeBody.join("\n") || current.welcomeBody,
    confirmationTitle:
      readString("confirmationMessage", current.confirmationTitle).split("\n")[0] ?? "",
    confirmationBody: readString("confirmationMessage", current.confirmationBody)
      .split("\n")
      .slice(1)
      .join("\n"),
    successMessage: readString("successContent", current.successMessage),
    redirectUrl: readString("redirectUrl", current.redirectUrl),
    fields: withCoreProposalFields(form.submissionFields.map(toEditorField)),
    participantFields: form.participantFields.map(toEditorField),
    sections: form.sections.map((section) => ({ ...section })),
    rules: [...form.rules],
    editorRuleId: editorRule?.id,
    rule: persistedEditorCondition ?? emptyEditorRule(),
    ruleAction: persistedRuleTargetLabel === undefined ? "" : `show ${persistedRuleTargetLabel}`,
    ruleTargetField: persistedRuleTarget,
  };
}

export function summarizeRule(rule: CfpRule): string {
  if (rule.type === "condition") {
    return `${rule.field} ${rule.operator} ${rule.value}`;
  }

  const joiner = ` ${rule.operator} `;
  return `(${rule.conditions.map(summarizeRule).join(joiner)})`;
}

export function ruleKey(rule: CfpRule): string {
  if (rule.type === "condition") {
    return `condition:${rule.field}:${rule.operator}:${rule.value}`;
  }

  return `group:${rule.operator}:${rule.conditions.map(ruleKey).join("|")}`;
}
export function firstRuleCondition(rule: CfpRule): CfpCondition {
  if (rule.type === "condition") return rule;
  const nested = rule.conditions[0];
  return nested === undefined
    ? { type: "condition", field: "format", operator: "is", value: "" }
    : firstRuleCondition(nested);
}

function hasExactKeys(candidate: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(candidate).every((key) => allowed.has(key));
}

function editorRuleCondition(value: unknown, root = true): CfpRule | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "predicate") {
    if (
      !hasExactKeys(candidate, ["type", "fieldKey", "operator", "value"]) ||
      typeof candidate.fieldKey !== "string" ||
      (candidate.operator !== "equals" && candidate.operator !== "not_equals") ||
      typeof candidate.value !== "string"
    ) {
      return null;
    }
    return {
      type: "condition",
      field: candidate.fieldKey,
      operator: candidate.operator === "not_equals" ? "is not" : "is",
      value: candidate.value,
    };
  }
  if (
    candidate.type !== "group" ||
    (candidate.operator !== "all" && candidate.operator !== "any") ||
    !Array.isArray(candidate.conditions) ||
    candidate.conditions.length === 0 ||
    !hasExactKeys(candidate, ["type", "operator", "conditions"])
  ) {
    return null;
  }
  const conditions = candidate.conditions.map((condition) => editorRuleCondition(condition, false));
  if (conditions.some((condition) => condition === null)) return null;
  if (root && candidate.operator === "all" && conditions.length === 1) {
    return conditions[0] as CfpRule;
  }
  return {
    type: "group",
    operator: candidate.operator === "any" ? "OR" : "AND",
    conditions: conditions as CfpRule[],
  };
}
export function fieldOptionValues(field: CfpFormField | undefined): string[] {
  return (field?.options ?? []).flatMap((option) => {
    if (typeof option === "string") return [option];
    if (typeof option === "object" && option !== null && "value" in option) {
      return typeof option.value === "string" ? [option.value] : [];
    }
    return [];
  });
}

export function fieldKeyFromLabel(label: string): string {
  const normalized = label
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-");
  return normalized.replace(/^-+|-+$/gu, "") || "custom-field";
}
export function ruleMatches(rule: CfpRule, answers: Record<string, string>): boolean {
  if (rule.type === "condition") {
    const fieldKey = rule.field.trim().toLocaleLowerCase();
    const current = answers[fieldKey] ?? answers[fieldKey.replaceAll(" ", "-")];
    return rule.operator === "is not" ? current !== rule.value : current === rule.value;
  }
  const results = rule.conditions.map((condition) => ruleMatches(condition, answers));
  return rule.operator === "OR" ? results.some(Boolean) : results.every(Boolean);
}

export function fieldTypeLabel(type: FieldType): string {
  switch (type) {
    case "email":
      return "Email";
    case "url":
      return "URL";
    case "textarea":
    case "rich_text":
      return "Long text";
    case "select":
      return "Select";
    case "multi_select":
      return "Multi-select";
    case "boolean":
      return "Checkbox";
    case "number":
      return "Number";
    case "file_request":
      return "File request";
    default:
      return "Short text";
  }
}
export function fieldReferenceLabel(reference: CfpFormField["fieldRef"]): string {
  if (reference === undefined) return "";
  if (typeof reference === "string") return reference;
  return `${reference.id} v${reference.version}`;
}
