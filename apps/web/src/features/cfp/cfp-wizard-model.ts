import type {
  CfpAuthenticatedSession,
  CfpFormField,
  CfpPublishedForm,
  CfpServerSubmission,
} from "./api";
import {
  getCfpActiveSubmissionStorageKey,
  getCfpSubmissionPointerStorageKey,
} from "./draft-persistence";
import type { CfpDraft, CfpStep } from "./types";

export type DynamicAnswers = Record<string, unknown>;
export type ParticipantAnswers = Record<string, DynamicAnswers>;

interface EvaluatedFieldState {
  visible: boolean;
  required: boolean;
}

const CFP_COMPLETION_HANDOFF_PREFIX = "eventloom:cfp-completion:v1";

export function getCfpCompletionHandoffStorageKey(
  organizationId: string,
  eventId: string,
  formId: string,
): string {
  return `${CFP_COMPLETION_HANDOFF_PREFIX}:${encodeURIComponent(
    organizationId,
  )}:${encodeURIComponent(eventId)}:${encodeURIComponent(formId)}`;
}

export function getCfpPortalHandoffHref(
  path: "/portal" | "/portal/submissions",
  eventId?: string,
): string {
  const normalizedEventId = eventId?.trim();
  return normalizedEventId ? `${path}?event=${encodeURIComponent(normalizedEventId)}` : path;
}

export function canResumeCfpSubmission(
  status: CfpServerSubmission["status"],
  _step: CfpStep,
): boolean {
  return status === "draft" || status === "reopened" || status === "submitted";
}

export function rotateCfpCompletionIdentity(
  identity: { organizationId: string; eventId: string; formId: string },
  submissionId: string,
  localStorage: Pick<Storage, "getItem" | "removeItem">,
  sessionStorage: Pick<Storage, "removeItem" | "setItem">,
): void {
  const normalizedSubmissionId = submissionId.trim();
  const pointerKey = getCfpSubmissionPointerStorageKey(
    identity.organizationId,
    identity.eventId,
    identity.formId,
  );
  if (localStorage.getItem(pointerKey) === normalizedSubmissionId) {
    localStorage.removeItem(pointerKey);
  }
  sessionStorage.removeItem(
    getCfpActiveSubmissionStorageKey(identity.organizationId, identity.eventId, identity.formId),
  );
  sessionStorage.setItem(
    getCfpCompletionHandoffStorageKey(identity.organizationId, identity.eventId, identity.formId),
    normalizedSubmissionId,
  );
}

export function shouldAuthenticateCfpAccount(
  step: CfpStep,
  session: CfpAuthenticatedSession | null,
): boolean {
  return step === "account" && session === null;
}

export function canSaveCfpDraftAtStep(step: CfpStep | "complete"): boolean {
  return step === "submission" || step === "participants" || step === "review";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isFileField(field: CfpFormField): boolean {
  return ["file", "file_request", "upload"].includes(field.kind.toLowerCase().replaceAll("-", "_"));
}

export function fieldRequired(field: CfpFormField): boolean {
  return field.required || (isFileField(field) && field.fileRequest?.required === true);
}

export function scalarValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [];
}

function valuesEqual(left: unknown, right: unknown): boolean {
  const leftValues = scalarValues(left);
  const rightValues = scalarValues(right);
  if (leftValues.length === 0 || rightValues.length === 0) return Object.is(left, right);
  const rightValueSet = new Set(rightValues);
  return leftValues.some((value) => rightValueSet.has(value));
}

function evaluateCondition(condition: unknown, answers: DynamicAnswers): boolean {
  if (!isRecord(condition)) return false;
  if (condition.type === "group") {
    const children = Array.isArray(condition.conditions) ? condition.conditions : [];
    const results = children.map((child) => evaluateCondition(child, answers));
    return condition.operator === "any" || condition.operator === "OR"
      ? results.some(Boolean)
      : results.length > 0 && results.every(Boolean);
  }
  if (condition.type !== "predicate" && condition.type !== "condition") return false;
  const fieldKey =
    typeof condition.fieldKey === "string"
      ? condition.fieldKey
      : typeof condition.field === "string"
        ? condition.field
        : "";
  if (!fieldKey) return false;
  const current = answers[fieldKey];
  const expected = condition.value;
  switch (condition.operator) {
    case "is_empty":
    case "empty":
      return scalarValues(current).length === 0;
    case "is_not_empty":
    case "not_empty":
      return scalarValues(current).length > 0;
    case "not_equals":
    case "is not":
    case "neq":
      return !valuesEqual(current, expected);
    case "in":
      return Array.isArray(expected) && expected.some((item) => valuesEqual(current, item));
    case "not_in":
      return Array.isArray(expected) && !expected.some((item) => valuesEqual(current, item));
    case "contains":
      return scalarValues(current).some((value) =>
        scalarValues(expected).some((candidate) => value.includes(candidate)),
      );
    default:
      return valuesEqual(current, expected);
  }
}

export function evaluatePublishedFields(
  form: CfpPublishedForm,
  answers: DynamicAnswers,
): {
  fields: Map<string, EvaluatedFieldState>;
  sections: Map<string, boolean>;
} {
  const rules = [...(form.rules ?? [])].sort((left, right) => {
    const leftPriority = typeof left.priority === "number" ? left.priority : 0;
    const rightPriority = typeof right.priority === "number" ? right.priority : 0;
    return leftPriority - rightPriority;
  });
  const conditionalFieldKeys = new Set(
    rules.flatMap((rule) =>
      isRecord(rule) && Array.isArray(rule.actions)
        ? rule.actions.flatMap((action) =>
            isRecord(action) && action.type === "show_field" && typeof action.fieldKey === "string"
              ? [action.fieldKey]
              : [],
          )
        : [],
    ),
  );
  const fields = new Map(
    form.submissionFields
      .concat(form.participantFields)
      .map((field) => [
        field.key,
        { visible: !conditionalFieldKeys.has(field.key), required: fieldRequired(field) },
      ]),
  );
  const sections = new Map(form.sections.map((section) => [section.id, true]));
  for (const rule of rules) {
    const when = isRecord(rule) ? (rule.when ?? rule.condition) : undefined;
    if (!evaluateCondition(when, answers)) continue;
    const actions = isRecord(rule) && Array.isArray(rule.actions) ? rule.actions : [];
    for (const action of actions) {
      if (!isRecord(action) || typeof action.type !== "string") continue;
      const fieldKey = typeof action.fieldKey === "string" ? action.fieldKey : undefined;
      const sectionId = typeof action.sectionId === "string" ? action.sectionId : undefined;
      if (fieldKey && fields.has(fieldKey)) {
        const current = fields.get(fieldKey);
        if (!current) continue;
        if (action.type === "show_field") current.visible = true;
        if (action.type === "hide_field" || action.type === "skip_field") current.visible = false;
        if (action.type === "require_field") current.required = true;
      }
      if (sectionId && sections.has(sectionId)) {
        if (action.type === "show_section") sections.set(sectionId, true);
        if (action.type === "hide_section" || action.type === "skip_section") {
          sections.set(sectionId, false);
        }
      }
    }
  }
  return { fields, sections };
}

export function cfpPublishedFieldIsVisible(
  form: CfpPublishedForm,
  answers: DynamicAnswers,
  fieldKey: string,
): boolean {
  return evaluatePublishedFields(form, answers).fields.get(fieldKey)?.visible ?? false;
}

export function cfpHttpUrlIsValid(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function reviewValueString(value: unknown): string {
  if (Array.isArray(value)) {
    const items: string[] = [];
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      if (!(index in value)) continue;
      const item = reviewValueString(value[index]);
      if (item !== "Not specified") items.push(item);
    }
    return items.length > 0 ? items.join(", ") : "Not specified";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim().length > 0) return value;
  return "Not specified";
}

export function cfpReviewAudienceLevel(
  form: CfpPublishedForm | undefined,
  answers: DynamicAnswers,
  legacyLevel: string,
): { label: string; value: string } {
  const customField = form?.submissionFields.find((field) => field.id === "field-audience-level");
  if (customField !== undefined) {
    return {
      label: customField.label,
      value: reviewValueString(answers[customField.key]),
    };
  }
  return { label: "Level", value: reviewValueString(legacyLevel) };
}

export function cfpSubmissionFieldValue(
  draft: CfpDraft,
  answers: DynamicAnswers,
  key: string,
): unknown {
  switch (key) {
    case "title":
      return draft.submission.title;
    case "abstract":
      return answers.abstract ?? draft.submission.description;
    case "description":
      return (
        answers.description ?? (answers.abstract === undefined ? draft.submission.description : "")
      );
    case "format":
      return draft.submission.format;
    case "tags":
      return draft.submission.tags;
    case "track":
      return draft.submission.track;
    case "level":
      return draft.submission.level;
    case "language":
      return draft.submission.language;
    case "accountEmail":
      return draft.account.email;
    case "accountFirstName":
      return draft.account.firstName;
    case "accountLastName":
      return draft.account.lastName;
    case "accountAcceptedTerms":
      return draft.account.acceptedTerms;
    default:
      return answers[key];
  }
}

export function cfpReviewSubmissionDetails(
  form: CfpPublishedForm | undefined,
  draft: CfpDraft,
  answers: DynamicAnswers,
): readonly { key: string; label: string; value: string }[] {
  if (form && form.submissionFields.length > 0) {
    const resolvedAnswers = Object.fromEntries(
      form.submissionFields.map((field) => [
        field.key,
        cfpSubmissionFieldValue(draft, answers, field.key),
      ]),
    );
    const evaluated = evaluatePublishedFields(form, {
      ...answers,
      ...resolvedAnswers,
      accountEmail: draft.account.email,
      accountFirstName: draft.account.firstName,
      accountLastName: draft.account.lastName,
    });
    return form.submissionFields.flatMap((field) => {
      if (isFileField(field) || evaluated.fields.get(field.key)?.visible === false) return [];
      const value = reviewValueString(cfpSubmissionFieldValue(draft, answers, field.key));
      return value === "Not specified" ? [] : [{ key: field.key, label: field.label, value }];
    });
  }

  return [
    { key: "title", label: "Title", value: reviewValueString(draft.submission.title) },
    {
      key: "description",
      label: "Description",
      value: reviewValueString(draft.submission.description),
    },
    { key: "format", label: "Format", value: reviewValueString(draft.submission.format) },
    { key: "tags", label: "Tags", value: reviewValueString(draft.submission.tags) },
    { key: "track", label: "Track", value: reviewValueString(draft.submission.track) },
    { key: "level", label: "Level", value: reviewValueString(draft.submission.level) },
    { key: "language", label: "Language", value: reviewValueString(draft.submission.language) },
  ].filter((item) => item.value !== "Not specified");
}

export function cfpConfirmationEmailMessage(recipient: string): string {
  const delivery =
    recipient.trim().length > 0 ? ` is queued for ${recipient.trim()}` : " is queued";
  return `A confirmation email${delivery} and will include the event name and talk title.`;
}

export function cfpSubmissionPayload(
  draft: CfpDraft,
  dynamicAnswers: DynamicAnswers,
  participantAnswers: ParticipantAnswers,
): {
  answers: Record<string, unknown>;
  participants: CfpServerSubmission["participants"];
  secondaryContacts: CfpServerSubmission["secondaryContacts"];
} {
  const answers = { ...dynamicAnswers };
  return {
    answers: {
      ...answers,
      title: draft.submission.title,
      abstract: dynamicAnswers.abstract ?? draft.submission.description,
      description:
        dynamicAnswers.description ??
        (dynamicAnswers.abstract === undefined ? draft.submission.description : ""),
      format: draft.submission.format,
      tags: draft.submission.tags,
      track: draft.submission.track,
      level: draft.submission.level,
      language: draft.submission.language,
      accountEmail: draft.account.email,
      accountFirstName: draft.account.firstName,
      accountLastName: draft.account.lastName,
      accountAcceptedTerms: draft.account.acceptedTerms,
    },
    participants: draft.participants.map((participant) => {
      const customAnswers = participantAnswers[participant.id] ?? {};
      return {
        id: participant.id,
        firstName: participant.firstName,
        lastName: participant.lastName,
        email: participant.email,
        role: participant.role === "Speaker" ? "primary" : "co_speaker",
        biography: participant.biography,
        answers: { ...customAnswers },
      };
    }),
    secondaryContacts: draft.secondaryContacts.map((contact) => ({
      id: contact.id,
      name: `${contact.firstName} ${contact.lastName}`.trim(),
      email: contact.email,
    })),
  };
}

export function cfpSubmissionErrorKey(key: string): string {
  if (key === "title") return "submission.title";
  if (key === "abstract") return "submission.abstract";
  if (key === "description") return "submission.description";
  return `submission.${key}`;
}
