"use client";

import { RedirectType, redirect, useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  type CfpApi,
  CfpApiError,
  type CfpAuthenticatedSession,
  type CfpFileUploadResult,
  type CfpFormField,
  CfpMutationGate,
  type CfpMutationLease,
  type CfpPublishedForm,
  type CfpServerSubmission,
  createCfpApi,
  isCfpSchemaVersionConflict,
  type PublishedCfp,
} from "./api";
import { shouldConfirmCfpApplicantContext } from "./cfp-account-context";
import { useCfpStartupStore } from "./cfp-startup-provider";
import { CfpWizardSections, PublicCfpShell } from "./cfp-wizard-sections";

type CfpStartupStore = ReturnType<typeof useCfpStartupStore>;

import styles from "./cfp-wizard.module.css";
import {
  canResumeCfpSubmission,
  canSaveCfpDraftAtStep,
  cfpConfirmationEmailMessage,
  cfpHttpUrlIsValid,
  cfpSubmissionErrorKey,
  cfpSubmissionFieldValue,
  cfpSubmissionPayload,
  getCfpCompletionHandoffStorageKey,
  getCfpPortalHandoffHref,
  rotateCfpCompletionIdentity,
  shouldAuthenticateCfpAccount,
} from "./cfp-wizard-model";

import {
  clearCfpDraftStorage,
  getCfpActiveSubmissionStorageKey,
  getCfpSubmissionPointerStorageKey,
  getCfpNewSubmissionIntentStorageKey,
} from "./draft-persistence";
import {
  cfpStepRequiresAuthentication,
  getCfpStepRoute,
  getNextCfpStep,
  getPreviousCfpStep,
} from "./routes";
import {
  type CfpDraft,
  type CfpParticipant,
  type CfpStep,
  createEmptyDraft,
  syncPrimaryParticipant,
} from "./types";
import { getFirstInvalidStep, type ValidationErrors, validateStep } from "./validation";
import {
  clearCfpVerificationContinuation,
  createCfpVerificationCallbackUrl,
  readCfpVerificationContinuation,
  writeCfpVerificationContinuation,
} from "./verification-continuation";

type FormFieldOption =
  | string
  | {
      value: string;
      label?: string;
      description?: string;
      disabled?: boolean;
    };

type DynamicAnswers = Record<string, unknown>;
type ParticipantAnswers = Record<string, DynamicAnswers>;

interface EvaluatedFieldState {
  visible: boolean;
  required: boolean;
}

interface FileUploadState {
  status: "idle" | "pending" | "ready" | "error";
  assetId?: string;
  name?: string;
  message?: string;
}

type FileUploadStates = Record<string, FileUploadState>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionDetails(option: FormFieldOption): {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
} {
  if (typeof option === "string") return { value: option, label: option };
  return {
    value: option.value,
    label: option.label ?? option.value,
    ...(option.description === undefined ? {} : { description: option.description }),
    ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
  };
}

function fieldOptions(field: CfpFormField): Array<ReturnType<typeof optionDetails>> {
  return field.options.flatMap((option) => {
    if (typeof option === "string") return [optionDetails(option)];
    if (!isRecord(option) || typeof option.value !== "string") return [];
    return [
      optionDetails({
        value: option.value,
        ...(typeof option.label === "string" ? { label: option.label } : {}),
        ...(typeof option.description === "string" ? { description: option.description } : {}),
        ...(typeof option.disabled === "boolean" ? { disabled: option.disabled } : {}),
      }),
    ];
  });
}

function isFileField(field: CfpFormField): boolean {
  return ["file", "file_request", "upload"].includes(field.kind.toLowerCase().replaceAll("-", "_"));
}
function fieldRequired(field: CfpFormField): boolean {
  return field.required || (isFileField(field) && field.fileRequest?.required === true);
}

function scalarValues(value: unknown): string[] {
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

function evaluatePublishedFields(
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

function fileStateKey(fieldKey: string, participantIndex?: number): string {
  return participantIndex === undefined ? fieldKey : `participants.${participantIndex}.${fieldKey}`;
}

function fileNameStorageKey(assetId: string): string {
  return `eventloom:cfp-upload-name:v1:${assetId}`;
}
function clearCfpVerificationContinuationFromBrowser(
  identity: { organizationId: string; eventId: string; formId: string } | null,
): void {
  if (identity === null || typeof window === "undefined") return;
  clearCfpVerificationContinuation(identity, window.localStorage);
}

interface CfpWizardProps {
  eventSlug: string;
  step: CfpStep;
  organizationId?: string;
  formId?: string;
  api?: CfpApi;
}

interface CfpMutationOperation {
  lease: CfpMutationLease;
  localRevision: number;
  createIdempotencyKey: string;
  saveIdempotencyKey: string;
  reviewIdempotencyKey: string;
  submitIdempotencyKey: string;
}

class CfpVerificationRequiredError extends Error {
  constructor() {
    super("Account verification is required before the CFP can continue.");
    this.name = "CfpVerificationRequiredError";
  }
}

type CfpVerificationState =
  | {
      readonly status: "waiting";
      readonly email: string;
    }
  | {
      readonly status: "resuming";
      readonly email: string;
    };
type CfpStateUpdate<T> = T | ((current: T) => T);

function resolveCfpStateUpdate<T>(current: T, update: CfpStateUpdate<T>): T {
  return typeof update === "function" ? (update as (current: T) => T)(current) : update;
}

type CfpDraftState = {
  readonly draft: CfpDraft;
  readonly dynamicAnswers: DynamicAnswers;
  readonly participantAnswers: ParticipantAnswers;
  readonly fileUploadStates: FileUploadStates;
};

type CfpDraftAction =
  | { readonly type: "set-draft"; readonly value: CfpStateUpdate<CfpDraft> }
  | { readonly type: "set-dynamic-answers"; readonly value: CfpStateUpdate<DynamicAnswers> }
  | {
      readonly type: "set-participant-answers";
      readonly value: CfpStateUpdate<ParticipantAnswers>;
    }
  | {
      readonly type: "set-file-upload-states";
      readonly value: CfpStateUpdate<FileUploadStates>;
    }
  | {
      readonly type: "set-file-upload-state";
      readonly key: string;
      readonly state: FileUploadState;
    }
  | {
      readonly type: "hydrate-submission";
      readonly draft: CfpDraft;
      readonly dynamicAnswers: DynamicAnswers;
      readonly participantAnswers: ParticipantAnswers;
    }
  | { readonly type: "reset"; readonly draft: CfpDraft };

function cfpDraftReducer(state: CfpDraftState, action: CfpDraftAction): CfpDraftState {
  switch (action.type) {
    case "set-draft":
      return { ...state, draft: resolveCfpStateUpdate(state.draft, action.value) };
    case "set-dynamic-answers":
      return {
        ...state,
        dynamicAnswers: resolveCfpStateUpdate(state.dynamicAnswers, action.value),
      };
    case "set-participant-answers":
      return {
        ...state,
        participantAnswers: resolveCfpStateUpdate(state.participantAnswers, action.value),
      };
    case "set-file-upload-states":
      return {
        ...state,
        fileUploadStates: resolveCfpStateUpdate(state.fileUploadStates, action.value),
      };
    case "set-file-upload-state":
      return {
        ...state,
        fileUploadStates: { ...state.fileUploadStates, [action.key]: action.state },
      };
    case "hydrate-submission":
      return {
        ...state,
        draft: action.draft,
        dynamicAnswers: action.dynamicAnswers,
        participantAnswers: action.participantAnswers,
      };
    case "reset":
      return {
        draft: action.draft,
        dynamicAnswers: {},
        participantAnswers: {},
        fileUploadStates: {},
      };
  }
}

type CfpSessionState = {
  readonly published: PublishedCfp | null;
  readonly authenticatedSession: CfpAuthenticatedSession | null;
  readonly verificationState: CfpVerificationState | null;
  readonly confirmedApplicantContext: boolean;
  readonly password: string;
  readonly accountMode: CfpAccountMode;
};

type CfpSessionAction =
  | { readonly type: "set-published"; readonly value: CfpStateUpdate<PublishedCfp | null> }
  | {
      readonly type: "set-authenticated-session";
      readonly value: CfpStateUpdate<CfpAuthenticatedSession | null>;
    }
  | {
      readonly type: "set-verification-state";
      readonly value: CfpStateUpdate<CfpVerificationState | null>;
    }
  | {
      readonly type: "set-confirmed-applicant-context";
      readonly value: CfpStateUpdate<boolean>;
    }
  | { readonly type: "set-password"; readonly value: CfpStateUpdate<string> }
  | { readonly type: "set-account-mode"; readonly value: CfpStateUpdate<CfpAccountMode> }
  | {
      readonly type: "startup-loaded";
      readonly published: PublishedCfp;
      readonly authenticatedSession: CfpAuthenticatedSession | null;
    }
  | { readonly type: "reset-authentication" };

function cfpSessionReducer(state: CfpSessionState, action: CfpSessionAction): CfpSessionState {
  switch (action.type) {
    case "set-published":
      return { ...state, published: resolveCfpStateUpdate(state.published, action.value) };
    case "set-authenticated-session":
      return {
        ...state,
        authenticatedSession: resolveCfpStateUpdate(state.authenticatedSession, action.value),
      };
    case "set-verification-state":
      return {
        ...state,
        verificationState: resolveCfpStateUpdate(state.verificationState, action.value),
      };
    case "set-confirmed-applicant-context":
      return {
        ...state,
        confirmedApplicantContext: resolveCfpStateUpdate(
          state.confirmedApplicantContext,
          action.value,
        ),
      };
    case "set-password":
      return { ...state, password: resolveCfpStateUpdate(state.password, action.value) };
    case "set-account-mode":
      return { ...state, accountMode: resolveCfpStateUpdate(state.accountMode, action.value) };
    case "startup-loaded":
      return {
        ...state,
        published: action.published,
        authenticatedSession: action.authenticatedSession,
      };
    case "reset-authentication":
      return { ...state, authenticatedSession: null, verificationState: null };
  }
}

type CfpStaleFormConflict = {
  readonly submissionId: string | null;
  readonly pinnedDraftUnavailable: boolean;
};

type CfpPersistenceState = {
  readonly errors: ValidationErrors;
  readonly hydrated: boolean;
  readonly startupRevision: number;
  readonly saveState: "idle" | "saving" | "saved" | "error";
  readonly mutationPending: boolean;
  readonly saveError: string | null;
  readonly staleFormConflict: CfpStaleFormConflict | null;
};

type CfpPersistenceAction =
  | { readonly type: "set-errors"; readonly value: CfpStateUpdate<ValidationErrors> }
  | { readonly type: "set-hydrated"; readonly value: CfpStateUpdate<boolean> }
  | { readonly type: "set-startup-revision"; readonly value: CfpStateUpdate<number> }
  | {
      readonly type: "set-save-state";
      readonly value: CfpStateUpdate<CfpPersistenceState["saveState"]>;
    }
  | { readonly type: "set-mutation-pending"; readonly value: CfpStateUpdate<boolean> }
  | { readonly type: "set-save-error"; readonly value: CfpStateUpdate<string | null> }
  | {
      readonly type: "set-stale-form-conflict";
      readonly value: CfpStateUpdate<CfpStaleFormConflict | null>;
    }
  | {
      readonly type: "startup-error";
      readonly conflict: CfpStaleFormConflict | null | undefined;
      readonly error: string;
    }
  | { readonly type: "local-change"; readonly resetSaveState: boolean }
  | { readonly type: "refresh-start" };

function cfpPersistenceReducer(
  state: CfpPersistenceState,
  action: CfpPersistenceAction,
): CfpPersistenceState {
  switch (action.type) {
    case "set-errors":
      return { ...state, errors: resolveCfpStateUpdate(state.errors, action.value) };
    case "set-hydrated":
      return { ...state, hydrated: resolveCfpStateUpdate(state.hydrated, action.value) };
    case "set-startup-revision":
      return {
        ...state,
        startupRevision: resolveCfpStateUpdate(state.startupRevision, action.value),
      };
    case "set-save-state":
      return { ...state, saveState: resolveCfpStateUpdate(state.saveState, action.value) };
    case "set-mutation-pending":
      return {
        ...state,
        mutationPending: resolveCfpStateUpdate(state.mutationPending, action.value),
      };
    case "set-save-error":
      return { ...state, saveError: resolveCfpStateUpdate(state.saveError, action.value) };
    case "set-stale-form-conflict":
      return {
        ...state,
        staleFormConflict: resolveCfpStateUpdate(state.staleFormConflict, action.value),
      };
    case "startup-error":
      return {
        ...state,
        staleFormConflict:
          action.conflict === undefined ? state.staleFormConflict : action.conflict,
        saveState: "error",
        saveError: action.error,
        hydrated: true,
      };
    case "local-change":
      return {
        ...state,
        errors: {},
        saveError: null,
        ...(action.resetSaveState ? { saveState: "idle" as const } : {}),
      };
    case "refresh-start":
      return {
        ...state,
        hydrated: false,
        startupRevision: state.startupRevision + 1,
      };
  }
}

function mutationIdempotencyKey(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function mutationMayHaveCommitted(error: unknown): boolean {
  if (error instanceof CfpApiError) {
    return error.code === "CFP_REQUEST_TIMEOUT" || error.status >= 500;
  }
  return true;
}

function mutationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof CfpApiError) return error.message;
  if (error instanceof TypeError) {
    return "The CFP request could not reach the server. Check your connection and try again.";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

type CfpAccountMode = "sign_in" | "sign_up";

function configuredCfpIdentity(
  eventSlug: string,
  organizationId?: string,
  formId?: string,
): { organizationId: string; eventId: string; formId?: string } {
  const normalizedEventSlug = eventSlug.trim();
  const resolvedOrganizationId =
    organizationId?.trim() || (process.env.NODE_ENV === "test" ? "organization-1" : "");
  const resolvedFormId = formId?.trim() || undefined;
  if (!normalizedEventSlug) {
    throw new Error("CFP identity is not configured because the event slug is missing.");
  }
  if (!resolvedOrganizationId) {
    throw new Error(`CFP identity is not configured for '${normalizedEventSlug}'.`);
  }
  return {
    organizationId: resolvedOrganizationId,
    eventId: normalizedEventSlug,
    ...(resolvedFormId ? { formId: resolvedFormId } : {}),
  };
}

function answerString(answers: Record<string, unknown>, key: string): string {
  const value = answers[key];
  return typeof value === "string" ? value : "";
}
function answerBoolean(answers: Record<string, unknown>, key: string): boolean {
  return answers[key] === true;
}

function promoteCanonicalTitleAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  const currentTitle = answers.title;
  if (typeof currentTitle === "string" && currentTitle.trim().length > 0) {
    return answers;
  }
  const titleLikeKeys = Object.keys(answers).filter((key) => {
    const normalized = key.trim().toLocaleLowerCase();
    return (
      normalized === "title1" ||
      normalized.startsWith("title-") ||
      normalized.endsWith("-title") ||
      normalized.includes("session-title") ||
      normalized.includes("session_title")
    );
  });
  if (titleLikeKeys.length !== 1) return answers;
  const titleLikeKey = titleLikeKeys[0];
  if (titleLikeKey === undefined) return answers;
  const candidate = answers[titleLikeKey];
  if (typeof candidate !== "string" || candidate.trim().length === 0) return answers;
  return { ...answers, title: candidate };
}

function draftFromSubmission(eventSlug: string, submission: CfpServerSubmission): CfpDraft {
  const primary =
    submission.participants.find((participant) => participant.role === "primary") ??
    submission.participants[0];
  const answers = promoteCanonicalTitleAnswers(submission.answers);
  return {
    schemaVersion: 1,
    eventSlug,
    account: {
      email: answerString(answers, "accountEmail") || primary?.email || "",
      firstName: answerString(answers, "accountFirstName") || primary?.firstName || "",
      lastName: answerString(answers, "accountLastName") || primary?.lastName || "",
      acceptedTerms:
        answerBoolean(answers, "accountAcceptedTerms") ||
        submission.completedSteps.includes("account"),
    },
    submission: {
      title: answerString(answers, "title"),
      description: answerString(answers, "abstract") || answerString(answers, "description"),
      format: answerString(answers, "format"),
      tags: Array.isArray(answers.tags)
        ? answers.tags.filter((value): value is string => typeof value === "string")
        : [],
      track: answerString(answers, "track"),
      level: answerString(answers, "level"),
      language: answerString(answers, "language") || "English",
    },
    participants:
      submission.participants.length > 0
        ? submission.participants.map((participant) => ({
            id: participant.id,
            role: participant.role === "primary" ? "Speaker" : "Co-speaker",
            firstName: participant.firstName,
            lastName: participant.lastName,
            email: participant.email,
            mobilePhone: "",
            biography: participant.biography,
          }))
        : [
            {
              id: "primary-speaker",
              role: "Speaker",
              firstName: answerString(answers, "accountFirstName"),
              lastName: answerString(answers, "accountLastName"),
              email: answerString(answers, "accountEmail"),
              mobilePhone: "",
              biography: "",
            },
          ],
    secondaryContacts: submission.secondaryContacts.map((contact) => {
      const [firstName = "", ...lastName] = contact.name.split(" ");
      return { id: contact.id, firstName, lastName: lastName.join(" "), email: contact.email };
    }),
    updatedAt: submission.updatedAt,
    receipt:
      submission.status === "submitted" && submission.submittedAt
        ? { id: submission.id, submittedAt: submission.submittedAt }
        : null,
  };
}
function draftWithAuthenticatedSession(
  draft: CfpDraft,
  session: CfpAuthenticatedSession,
): CfpDraft {
  return {
    ...draft,
    account: {
      ...draft.account,
      email: draft.account.email || session.email,
      firstName: draft.account.firstName || session.firstName,
      lastName: draft.account.lastName || session.lastName,
    },
  };
}
function submissionAnswersFromServer(submission: CfpServerSubmission): DynamicAnswers {
  return promoteCanonicalTitleAnswers({ ...submission.answers });
}

function participantAnswersFromServer(submission: CfpServerSubmission): ParticipantAnswers {
  return Object.fromEntries(
    submission.participants.map((participant) => [participant.id, { ...participant.answers }]),
  );
}

function participantValue(
  participant: CfpParticipant,
  answers: DynamicAnswers,
  key: string,
): unknown {
  switch (key) {
    case "firstName":
      return participant.firstName;
    case "lastName":
      return participant.lastName;
    case "email":
      return participant.email;
    case "biography":
      return participant.biography;
    case "mobilePhone":
      return participant.mobilePhone;
    default:
      return answers[key];
  }
}

function fieldIsEmpty(value: unknown): boolean {
  if (typeof value === "boolean") return value === false;
  if (Array.isArray(value)) return value.length === 0;
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

function fieldValueForValidation(field: CfpFormField, value: unknown): unknown {
  if (isFileField(field)) return value;
  return value;
}

function dynamicFormErrors(
  form: CfpPublishedForm,
  draft: CfpDraft,
  answers: DynamicAnswers,
  participantAnswers: ParticipantAnswers,
  fileStates: FileUploadStates,
  step: CfpStep,
): ValidationErrors {
  const errors: ValidationErrors = {};
  if (step === "submission" || step === "review") {
    const evaluated = evaluatePublishedFields(form, {
      ...answers,
      accountEmail: draft.account.email,
      accountFirstName: draft.account.firstName,
      accountLastName: draft.account.lastName,
    });
    for (const field of form.submissionFields) {
      const state = evaluated.fields.get(field.key) ?? {
        visible: true,
        required: fieldRequired(field),
      };
      if (!state.visible) continue;
      const value = fieldValueForValidation(
        field,
        cfpSubmissionFieldValue(draft, answers, field.key),
      );
      const key = cfpSubmissionErrorKey(field.key);
      const fileState = fileStates[fileStateKey(field.key)];
      if (isFileField(field) && fileState?.status === "error") {
        errors[key] = fileState.message ?? `${field.label} could not be uploaded.`;
        continue;
      }
      if (isFileField(field) && fileState?.status === "pending") {
        errors[key] = `${field.label} is still uploading.`;
        continue;
      }
      if (state.required && fieldIsEmpty(value)) {
        errors[key] = `${field.label} is required.`;
        continue;
      }
      if (field.kind === "email" && typeof value === "string" && value.trim()) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
          errors[key] = `Enter a valid ${field.label.toLowerCase()}.`;
        }
      }
      if (field.kind === "url" && typeof value === "string" && value.trim()) {
        if (!cfpHttpUrlIsValid(value)) {
          errors[key] = `Enter a valid ${field.label.toLowerCase()} URL.`;
        }
      }
      if (["select", "multi_select"].includes(field.kind) && field.options.length > 0) {
        const allowed = new Set(fieldOptions(field).map((option) => option.value));
        const selected = scalarValues(value);
        if (selected.some((item) => !allowed.has(item))) {
          errors[key] = `Choose a valid option for ${field.label}.`;
        }
      }
    }
  }
  if (step === "participants" || step === "review") {
    for (const [index, participant] of draft.participants.entries()) {
      const customAnswers = participantAnswers[participant.id] ?? {};
      const participantFormAnswers = {
        ...answers,
        ...customAnswers,
        firstName: participant.firstName,
        lastName: participant.lastName,
        email: participant.email,
        biography: participant.biography,
        mobilePhone: participant.mobilePhone,
      };
      const evaluated = evaluatePublishedFields(form, participantFormAnswers);
      for (const field of form.participantFields) {
        const state = evaluated.fields.get(field.key) ?? {
          visible: true,
          required: fieldRequired(field),
        };
        if (!state.visible) continue;
        const value = participantValue(participant, customAnswers, field.key);
        const key = `participants.${index}.${field.key}`;
        const fileState = fileStates[fileStateKey(field.key, index)];
        if (isFileField(field) && fileState?.status === "error") {
          errors[key] = fileState.message ?? `${field.label} could not be uploaded.`;
          continue;
        }
        if (isFileField(field) && fileState?.status === "pending") {
          errors[key] = `${field.label} is still uploading.`;
          continue;
        }
        if (state.required && fieldIsEmpty(value)) {
          errors[key] = `${field.label} is required.`;
          continue;
        }
        if (field.kind === "email" && typeof value === "string" && value.trim()) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
            errors[key] = `Enter a valid ${field.label.toLowerCase()}.`;
          }
        }
        if (field.kind === "url" && typeof value === "string" && value.trim()) {
          if (!cfpHttpUrlIsValid(value)) {
            errors[key] = `Enter a valid ${field.label.toLowerCase()} URL.`;
          }
        }
      }
    }
  }
  return errors;
}

function removeFixedErrorsForDynamicForm(
  errors: ValidationErrors,
  form: CfpPublishedForm | undefined,
  step: CfpStep,
): ValidationErrors {
  if (!form || form.submissionFields.length === 0 || (step !== "submission" && step !== "review")) {
    return errors;
  }
  const keys = new Set(form.submissionFields.map((field) => field.key));
  const aliases: Record<string, string[]> = {
    "submission.title": ["title"],
    "submission.abstract": ["abstract"],
    "submission.description": ["description"],
    "submission.format": ["format"],
    "submission.tags": ["tags"],
    "submission.track": ["track"],
    "submission.level": ["level"],
    "submission.language": ["language"],
  };
  return Object.fromEntries(
    Object.entries(errors).filter(
      ([key]) =>
        !key.startsWith("submission.") || (aliases[key] ?? []).some((alias) => keys.has(alias)),
    ),
  );
}
function firstInvalidPublishedStep(
  form: CfpPublishedForm,
  draft: CfpDraft,
  answers: DynamicAnswers,
  participantAnswers: ParticipantAnswers,
  fileStates: FileUploadStates,
): CfpStep | null {
  const accountErrors = validateStep("account", draft, "Aa1!aaaa");
  delete accountErrors["account.password"];
  if (Object.keys(accountErrors).length > 0) return "account";
  const submissionErrors = {
    ...removeFixedErrorsForDynamicForm(validateStep("submission", draft), form, "submission"),
    ...dynamicFormErrors(form, draft, answers, participantAnswers, fileStates, "submission"),
  };
  if (Object.keys(submissionErrors).length > 0) return "submission";
  const participantErrors = {
    ...validateStep("participants", draft),
    ...dynamicFormErrors(form, draft, answers, participantAnswers, fileStates, "participants"),
  };
  if (Object.keys(participantErrors).length > 0) return "participants";
  return null;
}
function cfpIsClosed(event: PublishedCfp["event"] | undefined): boolean {
  return event !== undefined && Date.parse(event.closesAt) <= Date.now();
}
function focusFirstError(nextErrors: ValidationErrors): void {
  const firstKey = Object.keys(nextErrors)[0];
  if (!firstKey) return;
  window.setTimeout(() => {
    document.getElementById(firstKey)?.focus();
  });
}

type CfpStartupData = {
  readonly publishedCfp: PublishedCfp;
  readonly session: CfpAuthenticatedSession | null;
  readonly canonicalIdentity: {
    readonly organizationId: string;
    readonly eventId: string;
    readonly formId: string;
  };
};

type CfpPinnedDraftResult =
  | { readonly status: "resume"; readonly saved: CfpServerSubmission }
  | { readonly status: "reset" }
  | { readonly status: "unavailable" }
  | { readonly status: "stale"; readonly submissionId: string }
  | { readonly status: "authentication-required"; readonly submissionId: string };

function throwIfCfpStartupAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

async function loadCfpStartup(
  api: CfpApi,
  startupStore: CfpStartupStore,
  routeIdentity: { organizationId: string; eventId: string; formId?: string },
  signal: AbortSignal,
): Promise<CfpStartupData> {
  const startup = startupStore.load(api, routeIdentity);
  const [publishedCfp, session] = await Promise.all([startup.published, startup.session]);
  throwIfCfpStartupAborted(signal);
  return {
    publishedCfp,
    session,
    canonicalIdentity: {
      organizationId: routeIdentity.organizationId,
      eventId: publishedCfp.event.id,
      formId: publishedCfp.form.id,
    },
  };
}

async function loadCfpPinnedDraft(
  api: CfpApi,
  identity: CfpStartupData["canonicalIdentity"],
  pointer: string,
  step: CfpStep,
  signal: AbortSignal,
): Promise<CfpPinnedDraftResult> {
  try {
    const saved = await api.loadDraft({
      organizationId: identity.organizationId,
      eventId: identity.eventId,
      submissionId: pointer,
      signal,
    });
    throwIfCfpStartupAborted(signal);
    return canResumeCfpSubmission(saved.status, step)
      ? { status: "resume", saved }
      : { status: "unavailable" };
  } catch (error) {
    if (isCfpSchemaVersionConflict(error)) {
      return { status: "stale", submissionId: pointer };
    }
    if (error instanceof CfpApiError && (error.status === 401 || error.status === 403)) {
      return { status: "authentication-required", submissionId: pointer };
    }
    if (!(error instanceof CfpApiError) || error.status !== 404) throw error;
    return { status: "reset" };
  }
}

function useCfpWizardController({
  eventSlug,
  step,
  organizationId,
  formId,
  api: providedApi,
}: CfpWizardProps) {
  const router = useRouter();
  const initialDraft = useMemo(() => createEmptyDraft(eventSlug), [eventSlug]);
  const routeIdentity = useMemo(() => {
    try {
      return configuredCfpIdentity(eventSlug, organizationId, formId);
    } catch {
      return null;
    }
  }, [eventSlug, organizationId, formId]);
  const api = useMemo(() => providedApi ?? createCfpApi(""), [providedApi]);
  const startupStore = useCfpStartupStore();
  const [draftState, dispatchDraft] = useReducer(cfpDraftReducer, {
    draft: initialDraft,
    dynamicAnswers: {},
    participantAnswers: {},
    fileUploadStates: {},
  });
  const { draft, dynamicAnswers, participantAnswers, fileUploadStates } = draftState;
  const [sessionState, dispatchSession] = useReducer(cfpSessionReducer, {
    published: null,
    authenticatedSession: null,
    verificationState: null,
    confirmedApplicantContext: false,
    password: "",
    accountMode: "sign_in" as CfpAccountMode,
  });
  const {
    published,
    authenticatedSession,
    verificationState,
    confirmedApplicantContext,
    password,
    accountMode,
  } = sessionState;
  const identity = useMemo(() => {
    if (routeIdentity === null || published === null) return null;
    return {
      organizationId: routeIdentity.organizationId,
      eventId: published.event.id,
      formId: published.form.id,
    };
  }, [published, routeIdentity]);
  const requiresApplicantContextConfirmation =
    authenticatedSession !== null &&
    identity !== null &&
    shouldConfirmCfpApplicantContext(authenticatedSession, identity.organizationId);
  const [persistenceState, dispatchPersistence] = useReducer(cfpPersistenceReducer, {
    errors: {},
    hydrated: false,
    startupRevision: 0,
    saveState: "idle",
    mutationPending: false,
    saveError: null,
    staleFormConflict: null,
  });
  const {
    errors,
    hydrated,
    startupRevision,
    saveState,
    mutationPending,
    saveError,
    staleFormConflict,
  } = persistenceState;
  const setDraft = (value: CfpStateUpdate<CfpDraft>): void =>
    dispatchDraft({ type: "set-draft", value });
  const setDynamicAnswers = (value: CfpStateUpdate<DynamicAnswers>): void =>
    dispatchDraft({ type: "set-dynamic-answers", value });
  const setParticipantAnswers = (value: CfpStateUpdate<ParticipantAnswers>): void =>
    dispatchDraft({ type: "set-participant-answers", value });
  const setFileUploadStates = (value: CfpStateUpdate<FileUploadStates>): void =>
    dispatchDraft({ type: "set-file-upload-states", value });
  const setAuthenticatedSession = (value: CfpStateUpdate<CfpAuthenticatedSession | null>): void =>
    dispatchSession({ type: "set-authenticated-session", value });
  const setVerificationState = (value: CfpStateUpdate<CfpVerificationState | null>): void =>
    dispatchSession({ type: "set-verification-state", value });
  const setConfirmedApplicantContext = (value: CfpStateUpdate<boolean>): void =>
    dispatchSession({ type: "set-confirmed-applicant-context", value });
  const setPassword = (value: CfpStateUpdate<string>): void =>
    dispatchSession({ type: "set-password", value });
  const setAccountMode = (value: CfpStateUpdate<CfpAccountMode>): void =>
    dispatchSession({ type: "set-account-mode", value });
  const setErrors = (value: CfpStateUpdate<ValidationErrors>): void =>
    dispatchPersistence({ type: "set-errors", value });
  const setSaveState = (value: CfpStateUpdate<CfpPersistenceState["saveState"]>): void =>
    dispatchPersistence({ type: "set-save-state", value });
  const setMutationPending = (value: CfpStateUpdate<boolean>): void =>
    dispatchPersistence({ type: "set-mutation-pending", value });
  const setSaveError = (value: CfpStateUpdate<string | null>): void =>
    dispatchPersistence({ type: "set-save-error", value });
  const setStaleFormConflict = (value: CfpStateUpdate<CfpStaleFormConflict | null>): void =>
    dispatchPersistence({ type: "set-stale-form-conflict", value });
  const submissionIdRef = useRef<string | null>(null);
  const unresolvedPinnedDraftRef = useRef<string | null>(null);
  const newSubmissionIntentRef = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const verificationResumeRequestedRef = useRef(false);
  const fileDraftCreationRef = useRef<Promise<CfpServerSubmission> | null>(null);
  const versionRef = useRef(1);
  const formVersionRef = useRef<number | null>(null);
  const draftRevisionRef = useRef(0);
  const mutationGateRef = useRef<CfpMutationGate | null>(null);
  const mutationOperationRef = useRef<CfpMutationOperation | null>(null);
  if (mutationGateRef.current === null) mutationGateRef.current = new CfpMutationGate();
  const submissionsClosed = cfpIsClosed(published?.event);
  function noteLocalChange(): void {
    draftRevisionRef.current += 1;
    const resetSaveState = !mutationGateRef.current?.isActive();
    if (resetSaveState) {
      mutationOperationRef.current = null;
    }
    dispatchPersistence({ type: "local-change", resetSaveState });
  }

  function beginMutation(): CfpMutationOperation | null {
    const lease = mutationGateRef.current?.begin();
    if (!lease) return null;
    const operation = mutationOperationRef.current ?? {
      lease,
      localRevision: draftRevisionRef.current,
      createIdempotencyKey: mutationIdempotencyKey("cfp-draft"),
      saveIdempotencyKey: mutationIdempotencyKey("cfp-save"),
      reviewIdempotencyKey: mutationIdempotencyKey("cfp-review"),
      submitIdempotencyKey: mutationIdempotencyKey("cfp-submit"),
    };
    operation.lease = lease;
    mutationOperationRef.current = operation;
    setMutationPending(true);
    setSaveError(null);
    return operation;
  }

  function finishMutation(operation: CfpMutationOperation, keepForRetry: boolean): void {
    mutationGateRef.current?.finish(operation.lease);
    if (!mutationGateRef.current?.isActive()) setMutationPending(false);
    if (!keepForRetry && mutationOperationRef.current === operation) {
      mutationOperationRef.current = null;
    }
  }

  function markAuthoritativeSubmission(
    saved: CfpServerSubmission,
    localRevision: number,
    nextDraft: CfpDraft,
    completedStep: "account" | "submission" | "participant" | "review" | undefined,
    operation: CfpMutationOperation | undefined,
  ): void {
    if (operation && !mutationGateRef.current?.isCurrent(operation.lease)) return;
    versionRef.current = saved.version;
    formVersionRef.current = saved.formVersion;
    if (draftRevisionRef.current !== localRevision) return;
    const mappedDraft = draftFromSubmission(eventSlug, saved);
    dispatchDraft({
      type: "hydrate-submission",
      dynamicAnswers: submissionAnswersFromServer(saved),
      participantAnswers: participantAnswersFromServer(saved),
      draft:
        completedStep === "participant"
          ? mappedDraft
          : {
              ...mappedDraft,
              account: nextDraft.account,
              submission: nextDraft.submission,
              participants: nextDraft.participants,
              secondaryContacts: nextDraft.secondaryContacts,
            },
    });
  }

  async function reconcileAuthoritativeVersion(): Promise<void> {
    if (!identity || !submissionIdRef.current) return;
    const saved = await api.loadDraft({
      organizationId: identity.organizationId,
      eventId: identity.eventId,
      submissionId: submissionIdRef.current,
    });
    if (!mutationGateRef.current?.isActive()) return;
    submissionIdRef.current = saved.id;
    versionRef.current = saved.version;
    formVersionRef.current = saved.formVersion;
  }

  useEffect(() => {
    dispatchSession({ type: "reset-authentication" });
    verificationResumeRequestedRef.current = false;
    const controller = new AbortController();
    const scope = { active: true, revision: startupRevision };
    const ownsScope = () =>
      scope.active && scope.revision === startupRevision && !controller.signal.aborted;
    const handleStartupError = (error: unknown): void => {
      if (!ownsScope()) return;
      const schemaConflict = isCfpSchemaVersionConflict(error);
      if (schemaConflict) formVersionRef.current = null;
      dispatchPersistence({
        type: "startup-error",
        conflict: schemaConflict
          ? {
              submissionId: submissionIdRef.current,
              pinnedDraftUnavailable: submissionIdRef.current === null,
            }
          : undefined,
        error: mutationErrorMessage(
          error,
          "The published CFP could not be loaded. Refresh to try again.",
        ),
      });
    };
    const applyVerificationContinuation = (
      canonicalIdentity: CfpStartupData["canonicalIdentity"],
      session: CfpAuthenticatedSession | null,
      verificationContinuation: Awaited<ReturnType<typeof readCfpVerificationContinuation>> | null,
    ): void => {
      if (verificationContinuation === null) return;
      const continuationEmail = verificationContinuation.account.email.trim().toLowerCase();
      if (session === null) {
        dispatchDraft({
          type: "set-draft",
          value: (current) => ({
            ...current,
            account: verificationContinuation.account,
          }),
        });
        dispatchSession({
          type: "set-verification-state",
          value: {
            status: "waiting",
            email: verificationContinuation.account.email,
          },
        });
      } else if (session.email === continuationEmail) {
        dispatchDraft({
          type: "set-draft",
          value: (current) =>
            syncPrimaryParticipant(
              draftWithAuthenticatedSession(
                {
                  ...current,
                  account: verificationContinuation.account,
                },
                session,
              ),
            ),
        });
        dispatchSession({
          type: "set-verification-state",
          value: { status: "resuming", email: session.email },
        });
      } else {
        clearCfpVerificationContinuation(canonicalIdentity, window.localStorage);
      }
    };
    const applyReset = (
      publishedCfp: PublishedCfp,
      session: CfpAuthenticatedSession | null,
      initialDraftForScope: CfpDraft,
      pointerKey: string,
      clearPointer: boolean,
      expectedPointer: string | null,
    ): void => {
      if (clearPointer && window.localStorage.getItem(pointerKey) === expectedPointer) {
        window.localStorage.removeItem(pointerKey);
      }
      submissionIdRef.current = null;
      versionRef.current = 1;
      formVersionRef.current = publishedCfp.form.version;
      dispatchPersistence({
        type: "set-stale-form-conflict",
        value: null,
      });
      dispatchDraft({
        type: "reset",
        draft: session
          ? draftWithAuthenticatedSession(initialDraftForScope, session)
          : initialDraftForScope,
      });
      dispatchPersistence({ type: "set-errors", value: {} });
      dispatchSession({ type: "set-password", value: "" });
      dispatchPersistence({ type: "set-save-state", value: "idle" });
      dispatchPersistence({ type: "set-save-error", value: null });
    };
    if (!routeIdentity) {
      dispatchPersistence({ type: "set-save-state", value: "error" });
      dispatchPersistence({ type: "set-hydrated", value: true });
      return () => {
        scope.active = false;
        fileDraftCreationRef.current = null;
        controller.abort();
        mutationGateRef.current?.invalidate();
      };
    }

    void loadCfpStartup(api, startupStore, routeIdentity, controller.signal).then(
      ({ publishedCfp, session, canonicalIdentity }) => {
        if (!ownsScope()) return;
        try {
          dispatchSession({
            type: "startup-loaded",
            published: publishedCfp,
            authenticatedSession: session,
          });
          const verificationContinuation =
            step === "account"
              ? readCfpVerificationContinuation(canonicalIdentity, window.localStorage)
              : null;
          const pointerKey = getCfpSubmissionPointerStorageKey(
            canonicalIdentity.organizationId,
            canonicalIdentity.eventId,
            canonicalIdentity.formId,
          );
          const activePointerKey = getCfpActiveSubmissionStorageKey(
            canonicalIdentity.organizationId,
            canonicalIdentity.eventId,
            canonicalIdentity.formId,
          );
          const newSubmissionIntentKey = getCfpNewSubmissionIntentStorageKey(
            canonicalIdentity.organizationId,
            canonicalIdentity.eventId,
            canonicalIdentity.formId,
          );
          if (step === "welcome" || step === "account") {
            window.sessionStorage.removeItem(
              getCfpCompletionHandoffStorageKey(
                canonicalIdentity.organizationId,
                canonicalIdentity.eventId,
                canonicalIdentity.formId,
              ),
            );
          }
          const startsNewSubmission = window.sessionStorage.getItem(newSubmissionIntentKey) === "1";
          newSubmissionIntentRef.current = startsNewSubmission;
          if (startsNewSubmission) window.sessionStorage.removeItem(activePointerKey);
          const pointer = startsNewSubmission
            ? null
            : (window.sessionStorage.getItem(activePointerKey) ??
              window.localStorage.getItem(pointerKey));
          if (pointer) window.sessionStorage.setItem(activePointerKey, pointer);
          unresolvedPinnedDraftRef.current = pointer;
          if (pointer) {
            void loadCfpPinnedDraft(api, canonicalIdentity, pointer, step, controller.signal).then(
              (pinnedDraft) => {
                if (!ownsScope()) return;
                try {
                  if (window.sessionStorage.getItem(activePointerKey) !== pointer) {
                    applyReset(publishedCfp, session, initialDraft, pointerKey, false, pointer);
                    unresolvedPinnedDraftRef.current =
                      window.sessionStorage.getItem(activePointerKey) ??
                      window.localStorage.getItem(pointerKey);
                    dispatchPersistence({
                      type: "set-save-error",
                      value: "Another saved draft became active. Reload before continuing.",
                    });
                    dispatchPersistence({ type: "set-save-state", value: "error" });
                    dispatchPersistence({ type: "set-hydrated", value: true });
                    return;
                  }
                  if (pinnedDraft.status === "stale") {
                    unresolvedPinnedDraftRef.current = null;
                    formVersionRef.current = null;
                    dispatchPersistence({
                      type: "set-stale-form-conflict",
                      value: {
                        submissionId: pinnedDraft.submissionId,
                        pinnedDraftUnavailable: true,
                      },
                    });
                    dispatchPersistence({ type: "set-hydrated", value: true });
                    return;
                  }
                  if (pinnedDraft.status === "resume") {
                    unresolvedPinnedDraftRef.current = null;
                    const saved = pinnedDraft.saved;
                    submissionIdRef.current = saved.id;
                    versionRef.current = saved.version;
                    formVersionRef.current = saved.formVersion;
                    dispatchPersistence({
                      type: "set-stale-form-conflict",
                      value: null,
                    });
                    dispatchDraft({
                      type: "hydrate-submission",
                      dynamicAnswers: submissionAnswersFromServer(saved),
                      participantAnswers: participantAnswersFromServer(saved),
                      draft: session
                        ? draftWithAuthenticatedSession(
                            draftFromSubmission(eventSlug, saved),
                            session,
                          )
                        : draftFromSubmission(eventSlug, saved),
                    });
                  } else {
                    applyReset(
                      publishedCfp,
                      session,
                      initialDraft,
                      pointerKey,
                      pinnedDraft.status === "reset",
                      pointer,
                    );
                    if (pinnedDraft.status === "reset") {
                      if (window.sessionStorage.getItem(activePointerKey) === pointer) {
                        window.sessionStorage.removeItem(activePointerKey);
                      }
                      const fallbackPointer = window.localStorage.getItem(pointerKey);
                      unresolvedPinnedDraftRef.current = fallbackPointer;
                      if (fallbackPointer !== null) {
                        window.sessionStorage.setItem(activePointerKey, fallbackPointer);
                        dispatchPersistence({
                          type: "set-startup-revision",
                          value: (current) => current + 1,
                        });
                        return;
                      }
                    } else {
                      unresolvedPinnedDraftRef.current = pointer;
                      dispatchPersistence({
                        type: "set-save-error",
                        value:
                          pinnedDraft.status === "authentication-required"
                            ? "Sign in with the account that owns this saved draft."
                            : "This saved submission cannot be resumed.",
                      });
                      dispatchPersistence({ type: "set-save-state", value: "error" });
                    }
                  }
                  applyVerificationContinuation(
                    canonicalIdentity,
                    session,
                    verificationContinuation,
                  );
                  dispatchPersistence({ type: "set-hydrated", value: true });
                } catch (error) {
                  handleStartupError(error);
                }
              },
              handleStartupError,
            );
            return;
          }
          formVersionRef.current = publishedCfp.form.version;
          submissionIdRef.current = null;
          versionRef.current = 1;
          dispatchPersistence({
            type: "set-stale-form-conflict",
            value: null,
          });
          dispatchDraft({
            type: "reset",
            draft: session ? draftWithAuthenticatedSession(initialDraft, session) : initialDraft,
          });
          dispatchPersistence({ type: "set-errors", value: {} });
          dispatchSession({ type: "set-password", value: "" });
          dispatchPersistence({ type: "set-save-state", value: "idle" });
          dispatchPersistence({ type: "set-save-error", value: null });
          applyVerificationContinuation(canonicalIdentity, session, verificationContinuation);
          dispatchPersistence({ type: "set-hydrated", value: true });
        } catch (error) {
          handleStartupError(error);
        }
      },
      handleStartupError,
    );

    return () => {
      scope.active = false;
      fileDraftCreationRef.current = null;
      controller.abort();
      mutationGateRef.current?.invalidate();
    };
  }, [api, eventSlug, initialDraft, routeIdentity, startupRevision, startupStore, step]);

  function updateDraft(update: (current: CfpDraft) => CfpDraft): void {
    setDraft((current) => ({ ...update(current), updatedAt: new Date().toISOString() }));
    noteLocalChange();
    setErrors({});
  }
  function setSubmissionAnswer(key: string, value: unknown): void {
    setDynamicAnswers((current) => ({ ...current, [key]: value }));
    if (
      ["title", "abstract", "description", "format", "tags", "track", "level", "language"].includes(
        key,
      )
    ) {
      updateDraft((current) => {
        if (key === "title") {
          return { ...current, submission: { ...current.submission, title: String(value ?? "") } };
        }
        if (key === "abstract" || key === "description") {
          const hasPublishedAbstract =
            published?.form.submissionFields.some((field) => field.key === "abstract") ?? false;
          if (key === "abstract" || !hasPublishedAbstract) {
            return {
              ...current,
              submission: { ...current.submission, description: String(value ?? "") },
            };
          }
          return current;
        }
        if (key === "tags") {
          return {
            ...current,
            submission: {
              ...current.submission,
              tags: Array.isArray(value)
                ? value.filter((item): item is string => typeof item === "string")
                : [],
            },
          };
        }
        return {
          ...current,
          submission: {
            ...current.submission,
            [key]: String(value ?? ""),
          },
        };
      });
      return;
    }
    noteLocalChange();
    setErrors({});
  }

  function setParticipantAnswer(participantId: string, key: string, value: unknown): void {
    setParticipantAnswers((current) => ({
      ...current,
      [participantId]: { ...(current[participantId] ?? {}), [key]: value },
    }));
    noteLocalChange();
    setErrors({});
  }

  function setFileUploadState(key: string, state: FileUploadState): void {
    setFileUploadStates((current) => ({ ...current, [key]: state }));
    if (state.status === "ready" && state.assetId && state.name) {
      window.sessionStorage.setItem(fileNameStorageKey(state.assetId), state.name);
    }
    noteLocalChange();
    setErrors({});
  }
  function draftPointerKey(activeFormId: string): string {
    if (!identity) throw new Error("The CFP identity is not configured.");
    return getCfpSubmissionPointerStorageKey(
      identity.organizationId,
      identity.eventId,
      activeFormId,
    );
  }

  function assertDraftCreationAvailable(pointerKey: string): void {
    if (newSubmissionIntentRef.current) return;
    const unresolvedPointer =
      unresolvedPinnedDraftRef.current ?? window.localStorage.getItem(pointerKey);
    if (!unresolvedPointer) return;
    unresolvedPinnedDraftRef.current = unresolvedPointer;
    throw new CfpApiError(
      "CFP_DRAFT_AUTHENTICATION_REQUIRED",
      "Resolve the existing saved draft before creating another one.",
      409,
    );
  }

  function claimCreatedDraft(
    created: CfpServerSubmission,
    pointerKey: string,
    activeFormId: string,
  ): void {
    const currentPointer = window.localStorage.getItem(pointerKey);
    if (currentPointer === null || currentPointer === created.id) {
      window.localStorage.setItem(pointerKey, created.id);
    }
    if (!identity) throw new Error("The CFP identity is not configured.");
    window.sessionStorage.setItem(
      getCfpActiveSubmissionStorageKey(identity.organizationId, identity.eventId, activeFormId),
      created.id,
    );
    window.sessionStorage.removeItem(
      getCfpNewSubmissionIntentStorageKey(identity.organizationId, identity.eventId, activeFormId),
    );
    newSubmissionIntentRef.current = false;
    unresolvedPinnedDraftRef.current = null;
    submissionIdRef.current = created.id;
    versionRef.current = created.version;
    formVersionRef.current = created.formVersion;
  }
  async function handleFileUpload(
    field: CfpFormField,
    participantId: string | undefined,
    file: File,
  ): Promise<CfpFileUploadResult> {
    if (staleFormConflict !== null || submissionsClosed) {
      throw new CfpApiError(
        "CFP_DRAFT_UNAVAILABLE",
        staleFormConflict !== null
          ? "Resolve the saved draft conflict before uploading files."
          : "Submissions are closed.",
        409,
      );
    }
    if (!identity) throw new Error("CFP identity is not configured.");
    const uploadFile = api.uploadFile;
    if (uploadFile === undefined) {
      throw new CfpApiError(
        "CFP_FILE_UPLOAD_UNAVAILABLE",
        "Private file uploads are not configured.",
        400,
      );
    }
    const activeFormId = identity.formId ?? published?.form.id;
    if (!activeFormId) throw new Error("The published CFP form is unavailable.");
    const pointerKey = draftPointerKey(activeFormId);
    let submissionId = submissionIdRef.current;
    if (!submissionId) {
      assertDraftCreationAvailable(pointerKey);
      let creation = fileDraftCreationRef.current;
      if (creation === null) {
        creation = api.createDraft({
          organizationId: identity.organizationId,
          eventId: identity.eventId,
          formId: activeFormId,
          idempotencyKey: mutationIdempotencyKey("cfp-file-draft"),
        });
        fileDraftCreationRef.current = creation;
      }
      let created: CfpServerSubmission;
      try {
        created = await creation;
      } finally {
        if (fileDraftCreationRef.current === creation) fileDraftCreationRef.current = null;
      }
      claimCreatedDraft(created, pointerKey, activeFormId);
      submissionId = created.id;
    }
    const result = await uploadFile({
      organizationId: identity.organizationId,
      eventId: identity.eventId,
      submissionId,
      fieldKey: field.key,
      ...(participantId === undefined ? {} : { participantId }),
      file,
      idempotencyKey: mutationIdempotencyKey("cfp-file-upload"),
    });
    if (result.state !== "ready" || result.assetId.trim().length === 0) {
      throw new CfpApiError(
        "CFP_FILE_UPLOAD_REJECTED",
        "The uploaded file was rejected during finalization.",
        409,
      );
    }
    return result;
  }

  async function persistServerDraft(
    nextDraft: CfpDraft,
    completedStep?: "account" | "submission" | "participant" | "review",
    operation?: CfpMutationOperation,
  ): Promise<CfpServerSubmission> {
    if (!identity) throw new Error("CFP identity is not configured.");
    const activeFormId = identity.formId ?? published?.form.id;
    if (!activeFormId) throw new Error("The published CFP form is unavailable.");
    const pointerKey = draftPointerKey(activeFormId);
    const localRevision = draftRevisionRef.current;
    let submissionId = submissionIdRef.current;
    let version = versionRef.current;
    let formVersion = formVersionRef.current;
    if (!submissionId) assertDraftCreationAvailable(pointerKey);
    if (!submissionId) {
      const created = await api.createDraft({
        organizationId: identity.organizationId,
        eventId: identity.eventId,
        formId: activeFormId,
        ...(operation === undefined ? {} : { idempotencyKey: operation.createIdempotencyKey }),
      });
      if (operation && !mutationGateRef.current?.isCurrent(operation.lease)) return created;
      claimCreatedDraft(created, pointerKey, activeFormId);
      submissionId = created.id;
      version = created.version;
      formVersion = created.formVersion;
      if (!created.completedSteps.includes("welcome")) {
        throw new Error("The CFP draft did not record the completed welcome step.");
      }
    }
    if (formVersion === null) throw new Error("The CFP form version is unavailable.");
    const payload = cfpSubmissionPayload(nextDraft, dynamicAnswers, participantAnswers);
    const saved = await api.saveDraft({
      organizationId: identity.organizationId,
      eventId: identity.eventId,
      submissionId,
      expectedVersion: version,
      formVersion,
      ...(operation === undefined ? {} : { idempotencyKey: operation.saveIdempotencyKey }),
      answers: payload.answers,
      ...(completedStep === undefined ? {} : { completedStep }),
      ...(completedStep === "participant"
        ? {
            participants: payload.participants,
            secondaryContacts: payload.secondaryContacts,
          }
        : {}),
    });
    if (saved.formVersion !== formVersion) {
      throw new CfpApiError("CONFLICT", "The submission schema version is stale.", 409);
    }
    markAuthoritativeSubmission(saved, localRevision, nextDraft, completedStep, operation);
    return saved;
  }

  async function saveAndNavigate(
    nextDraft: CfpDraft,
    targetStep: CfpStep | "complete",
    beforePersist?: (draft: CfpDraft) => Promise<CfpDraft | undefined>,
  ): Promise<void> {
    if (staleFormConflict) return;
    if (step === "welcome") {
      if (submissionsClosed) setSaveState("idle");
      return;
    }
    const operation = beginMutation();
    if (!operation) return;
    setDraft(nextDraft);
    draftRevisionRef.current += 1;
    operation.localRevision = draftRevisionRef.current;
    let draftToPersist = nextDraft;
    let keepForRetry = false;
    try {
      setSaveState("saving");
      const preparedDraft = await beforePersist?.(draftToPersist);
      if (preparedDraft !== undefined) {
        draftToPersist = preparedDraft;
        setDraft(preparedDraft);
      }
      if (!mutationGateRef.current?.isCurrent(operation.lease)) return;
      if (targetStep === "complete") {
        const saved = await persistServerDraft(draftToPersist, "review", operation);
        if (!mutationGateRef.current?.isCurrent(operation.lease)) return;
        if (draftRevisionRef.current !== operation.localRevision) {
          setSaveError(
            "The draft changed while it was saving. Save again to keep the latest edits.",
          );
          setSaveState("error");
          return;
        }
        if (!identity || !submissionIdRef.current) {
          throw new Error("The CFP draft is unavailable.");
        }
        const review = await api.review({
          organizationId: identity.organizationId,
          eventId: identity.eventId,
          submissionId: submissionIdRef.current,
          idempotencyKey: operation.reviewIdempotencyKey,
        });
        if (!mutationGateRef.current?.isCurrent(operation.lease)) return;
        if (!review.canSubmit) {
          const issueEntries = review.issues.map((issue) => [issue.path, issue.message] as const);
          setErrors(Object.fromEntries(issueEntries));
          // Validation failures are field errors, not transport failures.
          setSaveError(issueEntries[0]?.[1] ?? "Check the highlighted fields before submitting.");
          setSaveState("error");
          return;
        }
        const formVersion = formVersionRef.current;
        if (formVersion === null) throw new Error("The CFP form version is unavailable.");
        const submitRevision = draftRevisionRef.current;
        const result = await api.submit({
          organizationId: identity.organizationId,
          eventId: identity.eventId,
          submissionId: submissionIdRef.current,
          expectedVersion: saved.version,
          formVersion,
          idempotencyKey: operation.submitIdempotencyKey,
        });
        if (!mutationGateRef.current?.isCurrent(operation.lease)) return;
        if (result.submission.formVersion !== formVersion) {
          throw new CfpApiError("CONFLICT", "The submission schema version is stale.", 409);
        }
        const activeFormId = identity.formId ?? published?.form.id;
        if (!activeFormId) throw new Error("The published CFP form is unavailable.");
        rotateCfpCompletionIdentity(
          {
            organizationId: identity.organizationId,
            eventId: identity.eventId,
            formId: activeFormId,
          },
          result.submission.id,
          window.localStorage,
          window.sessionStorage,
        );
        versionRef.current = result.submission.version;
        if (draftRevisionRef.current === submitRevision) {
          const submittedDraft = draftFromSubmission(eventSlug, result.submission);
          dispatchDraft({
            type: "hydrate-submission",
            dynamicAnswers: submissionAnswersFromServer(result.submission),
            participantAnswers: participantAnswersFromServer(result.submission),
            draft: {
              ...submittedDraft,
              receipt: {
                id: result.receipt.id,
                submittedAt: result.receipt.submittedAt,
              },
            },
          });
        }
      } else if (!(draftToPersist.receipt && !canSaveCfpDraftAtStep(step))) {
        const completedStep =
          step === "account"
            ? "account"
            : step === "submission"
              ? "submission"
              : step === "participants"
                ? "participant"
                : undefined;
        await persistServerDraft(draftToPersist, completedStep, operation);
      }
      if (!mutationGateRef.current?.isCurrent(operation.lease)) return;
      if (draftRevisionRef.current !== operation.localRevision) {
        setSaveError("The draft changed while it was saving. Save again to keep the latest edits.");
        setSaveState("error");
        return;
      }
      setSaveState("saved");
      if (!identity) throw new Error("The CFP identity is not configured.");
      if (step === "account") {
        clearCfpVerificationContinuation(identity, window.localStorage);
        setVerificationState(null);
      }
      router.push(getCfpStepRoute(identity.organizationId, eventSlug, targetStep));
    } catch (error) {
      if (!mutationGateRef.current?.isCurrent(operation.lease)) return;
      if (error instanceof CfpVerificationRequiredError) {
        setErrors({});
        setSaveState("idle");
        setSaveError(null);
        return;
      }
      if (isCfpSchemaVersionConflict(error)) {
        const unresolvedPointer = unresolvedPinnedDraftRef.current;
        setStaleFormConflict({
          submissionId: unresolvedPointer ?? submissionIdRef.current,
          pinnedDraftUnavailable: unresolvedPointer !== null,
        });
      }
      keepForRetry = mutationMayHaveCommitted(error);
      const shouldReconcile =
        keepForRetry || (error instanceof CfpApiError && error.status === 409);
      if (shouldReconcile) {
        try {
          await reconcileAuthoritativeVersion();
        } catch {
          // Keep the original mutation error visible; retrying uses the same idempotency keys.
        }
      }
      setSaveError(
        mutationErrorMessage(
          error,
          "The draft could not be saved. Check your connection and try again.",
        ),
      );
      setSaveState("error");
    } finally {
      finishMutation(operation, keepForRetry);
    }
  }

  async function resumePinnedDraftAfterAuthentication(
    candidateDraft: CfpDraft,
    session: CfpAuthenticatedSession,
  ): Promise<CfpDraft> {
    const pointer = unresolvedPinnedDraftRef.current;
    if (!pointer) {
      return syncPrimaryParticipant(draftWithAuthenticatedSession(candidateDraft, session));
    }
    if (!identity) throw new Error("The CFP identity is not configured.");
    const activeFormId = identity.formId ?? published?.form.id;
    if (!activeFormId) throw new Error("The published CFP form is unavailable.");
    const pointerKey = draftPointerKey(activeFormId);
    const activePointerKey = getCfpActiveSubmissionStorageKey(
      identity.organizationId,
      identity.eventId,
      activeFormId,
    );
    let saved: CfpServerSubmission;
    try {
      saved = await api.loadDraft({
        organizationId: identity.organizationId,
        eventId: identity.eventId,
        submissionId: pointer,
      });
    } catch (error) {
      if (isCfpSchemaVersionConflict(error)) {
        unresolvedPinnedDraftRef.current = pointer;
        formVersionRef.current = null;
        setStaleFormConflict({ submissionId: pointer, pinnedDraftUnavailable: true });
        throw error;
      }
      if (!(error instanceof CfpApiError) || error.status !== 404) throw error;
      const currentActivePointer = window.sessionStorage.getItem(activePointerKey);
      if (currentActivePointer !== pointer) {
        unresolvedPinnedDraftRef.current = currentActivePointer;
        throw new CfpApiError(
          "CFP_DRAFT_POINTER_CHANGED",
          "Another saved draft became active. Reload before continuing.",
          409,
        );
      }
      window.sessionStorage.removeItem(activePointerKey);
      if (window.localStorage.getItem(pointerKey) === pointer) {
        window.localStorage.removeItem(pointerKey);
      }
      const fallbackPointer = window.localStorage.getItem(pointerKey);
      if (fallbackPointer !== null) {
        window.sessionStorage.setItem(activePointerKey, fallbackPointer);
        unresolvedPinnedDraftRef.current = fallbackPointer;
        throw new CfpApiError(
          "CFP_DRAFT_POINTER_CHANGED",
          "Another saved draft became active. Reload before continuing.",
          409,
        );
      }
      unresolvedPinnedDraftRef.current = null;
      return syncPrimaryParticipant(draftWithAuthenticatedSession(candidateDraft, session));
    }
    const currentPointer = window.sessionStorage.getItem(activePointerKey);
    if (currentPointer !== pointer) {
      unresolvedPinnedDraftRef.current = currentPointer;
      throw new CfpApiError(
        "CFP_DRAFT_POINTER_CHANGED",
        "Another saved draft became active. Reload before continuing.",
        409,
      );
    }
    if (!canResumeCfpSubmission(saved.status, step)) {
      throw new CfpApiError(
        "CFP_DRAFT_UNAVAILABLE",
        "This saved submission cannot be resumed.",
        409,
      );
    }
    unresolvedPinnedDraftRef.current = null;
    submissionIdRef.current = saved.id;
    versionRef.current = saved.version;
    formVersionRef.current = saved.formVersion;
    const resumedDraft = syncPrimaryParticipant(
      draftWithAuthenticatedSession(draftFromSubmission(eventSlug, saved), session),
    );
    dispatchDraft({
      type: "hydrate-submission",
      dynamicAnswers: submissionAnswersFromServer(saved),
      participantAnswers: participantAnswersFromServer(saved),
      draft: resumedDraft,
    });
    return resumedDraft;
  }
  async function continueFlow(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (step === "welcome" && submissionsClosed) {
      setSaveState("idle");
      return;
    }
    const nextErrors = published
      ? {
          ...removeFixedErrorsForDynamicForm(
            validateStep(step, draft, password),
            published.form,
            step,
          ),
          ...dynamicFormErrors(
            published.form,
            draft,
            dynamicAnswers,
            participantAnswers,
            fileUploadStates,
            step,
          ),
        }
      : validateStep(step, draft, password);
    if (step === "account" && authenticatedSession) {
      delete nextErrors["account.password"];
    }
    if (step === "account" && !authenticatedSession && accountMode === "sign_in") {
      for (const key of Object.keys(nextErrors)) {
        if (key !== "account.email" && key !== "account.password") {
          delete nextErrors[key];
        }
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstError(nextErrors);
      return;
    }

    let nextDraft = draft;
    if (step === "account") nextDraft = syncPrimaryParticipant(draft);
    const authenticateBeforePersist = shouldAuthenticateCfpAccount(step, authenticatedSession)
      ? async (candidateDraft: CfpDraft) => {
          const authentication = await api.authenticateAccount({
            email: candidateDraft.account.email,
            mode: accountMode,
            password,
            name: `${candidateDraft.account.firstName} ${candidateDraft.account.lastName}`.trim(),
            ...(typeof window === "undefined"
              ? {}
              : {
                  verificationCallbackUrl: createCfpVerificationCallbackUrl(window.location.href),
                }),
          });
          if (authentication.status === "verification_required") {
            if (!identity) throw new Error("The CFP identity is not configured.");
            writeCfpVerificationContinuation(identity, candidateDraft.account, window.localStorage);
            setVerificationState({
              status: "waiting",
              email: candidateDraft.account.email.trim().toLowerCase(),
            });
            throw new CfpVerificationRequiredError();
          }
          setAuthenticatedSession(authentication.session);
          if (routeIdentity !== null) {
            startupStore.updateSession(routeIdentity, authentication.session);
          }
          return resumePinnedDraftAfterAuthentication(candidateDraft, authentication.session);
        }
      : undefined;
    if (step === "review") {
      const invalidStep = published
        ? firstInvalidPublishedStep(
            published.form,
            draft,
            dynamicAnswers,
            participantAnswers,
            fileUploadStates,
          )
        : getFirstInvalidStep(draft);
      if (invalidStep) {
        router.push(
          getCfpStepRoute(
            identity?.organizationId ?? organizationId?.trim() ?? "",
            eventSlug,
            invalidStep,
          ),
        );
        return;
      }
    }

    await saveAndNavigate(nextDraft, getNextCfpStep(step), authenticateBeforePersist);
  }

  async function saveNow(): Promise<void> {
    if (staleFormConflict) return;
    const operation = beginMutation();
    if (!operation) return;
    let keepForRetry = false;
    try {
      setSaveState("saving");
      const completedStep =
        step === "account"
          ? "account"
          : step === "submission"
            ? "submission"
            : step === "participants"
              ? "participant"
              : undefined;
      await persistServerDraft(draft, completedStep, operation);
      if (!mutationGateRef.current?.isCurrent(operation.lease)) return;
      if (draftRevisionRef.current !== operation.localRevision) {
        setSaveError("The draft changed while it was saving. Save again to keep the latest edits.");
        setSaveState("error");
        return;
      }
      setSaveState("saved");
    } catch (error) {
      if (!mutationGateRef.current?.isCurrent(operation.lease)) return;
      if (isCfpSchemaVersionConflict(error)) {
        const unresolvedPointer = unresolvedPinnedDraftRef.current;
        setStaleFormConflict({
          submissionId: unresolvedPointer ?? submissionIdRef.current,
          pinnedDraftUnavailable: unresolvedPointer !== null,
        });
      }
      keepForRetry = mutationMayHaveCommitted(error);
      const shouldReconcile =
        keepForRetry || (error instanceof CfpApiError && error.status === 409);
      if (shouldReconcile) {
        try {
          await reconcileAuthoritativeVersion();
        } catch {
          // Keep the original mutation error visible; retrying uses the same idempotency keys.
        }
      }
      setSaveError(
        mutationErrorMessage(
          error,
          "The draft could not be saved. Check your connection and try again.",
        ),
      );
      setSaveState("error");
    } finally {
      finishMutation(operation, keepForRetry);
    }
  }

  function goBack(): void {
    if (mutationGateRef.current?.isActive()) return;
    const previous = getPreviousCfpStep(step);
    if (previous) {
      router.push(
        getCfpStepRoute(
          identity?.organizationId ?? organizationId?.trim() ?? "",
          eventSlug,
          previous,
        ),
      );
    }
  }
  function refreshPinnedDraft(): void {
    dispatchPersistence({ type: "refresh-start" });
    router.refresh();
  }

  function discardStaleDraftAndStartNew(): void {
    if (!identity) return;
    const activeFormId = identity.formId ?? published?.form.id;
    if (!activeFormId) return;
    const pointerKey = getCfpSubmissionPointerStorageKey(
      identity.organizationId,
      identity.eventId,
      activeFormId,
    );
    const activePointerKey = getCfpActiveSubmissionStorageKey(
      identity.organizationId,
      identity.eventId,
      activeFormId,
    );
    const currentPointer = window.localStorage.getItem(pointerKey);
    const expectedPointer =
      staleFormConflict?.submissionId ??
      unresolvedPinnedDraftRef.current ??
      submissionIdRef.current;
    if (currentPointer !== null && currentPointer !== expectedPointer) {
      if (window.sessionStorage.getItem(activePointerKey) === expectedPointer) {
        window.sessionStorage.removeItem(activePointerKey);
      }
      unresolvedPinnedDraftRef.current = currentPointer;
      refreshPinnedDraft();
      return;
    }
    if (currentPointer === expectedPointer) window.localStorage.removeItem(pointerKey);
    if (window.sessionStorage.getItem(activePointerKey) === expectedPointer) {
      window.sessionStorage.removeItem(activePointerKey);
    }
    submissionIdRef.current = null;
    formVersionRef.current = null;
    versionRef.current = 1;
    setStaleFormConflict(null);
    setSaveError(null);
    setSaveState("idle");
    refreshPinnedDraft();
  }

  function useDifferentVerificationEmail(): void {
    if (identity) clearCfpVerificationContinuationFromBrowser(identity);
    setVerificationState(null);
    setPassword("");
    updateDraft((current) => ({
      ...current,
      account: { ...current.account, email: "" },
    }));
  }

  function changeAccountMode(nextMode: CfpAccountMode): void {
    setAccountMode(nextMode);
    setSaveError(null);
    setSaveState("idle");
    setErrors((current) => {
      if (nextMode === "sign_up") return current;

      const next = { ...current };
      delete next["account.firstName"];
      delete next["account.lastName"];
      delete next["account.acceptedTerms"];
      return next;
    });
  }

  useEffect(() => {
    if (
      step !== "account" ||
      !hydrated ||
      authenticatedSession === null ||
      verificationState?.status !== "resuming" ||
      verificationResumeRequestedRef.current
    ) {
      return;
    }
    verificationResumeRequestedRef.current = true;
    formRef.current?.requestSubmit();
  }, [authenticatedSession, hydrated, step, verificationState]);

  if (
    hydrated &&
    cfpStepRequiresAuthentication(step) &&
    authenticatedSession === null &&
    routeIdentity !== null
  ) {
    redirect(
      getCfpStepRoute(routeIdentity.organizationId, eventSlug, "account"),
      RedirectType.replace,
    );
  }

  return {
    eventSlug,
    step,
    routeIdentity,
    hydrated,
    published,
    identity,
    errors,
    staleFormConflict,
    submissionsClosed,
    saveError,
    saveState,
    mutationPending,
    formRef,
    draft,
    dynamicAnswers,
    participantAnswers,
    fileUploadStates,
    accountMode,
    authenticatedSession,
    confirmedApplicantContext,
    password,
    requiresApplicantContextConfirmation,
    verificationState,
    setAccountMode: changeAccountMode,
    setPassword,
    updateDraft,
    setConfirmedApplicantContext,
    useDifferentVerificationEmail,
    setSubmissionAnswer,
    setParticipantAnswer,
    handleFileUpload,
    setFileUploadState,
    continueFlow,
    goBack,
    saveNow,
    refreshPinnedDraft,
    discardStaleDraftAndStartNew,
  };
}

export function CfpWizard(props: CfpWizardProps) {
  const controller = useCfpWizardController(props);
  const { eventSlug, step, hydrated, authenticatedSession, published, saveError } = controller;
  if (cfpStepRequiresAuthentication(step) && (!hydrated || authenticatedSession === null)) {
    return <span aria-hidden="true" data-cfp-route-state="checking-session" hidden />;
  }
  if (!hydrated) {
    return (
      <PublicCfpShell step={step}>
        <div aria-busy="true" aria-live="polite" className={styles.loading}>
          Loading your submission draft…
        </div>
      </PublicCfpShell>
    );
  }
  if (published === null) {
    return (
      <PublicCfpShell step={step}>
        <section className={styles.errorSummary} role="alert">
          <h2>Submission form unavailable</h2>
          <p>{saveError ?? "The published submission form could not be loaded."}</p>
        </section>
      </PublicCfpShell>
    );
  }
  return (
    <CfpWizardSections
      eventSlug={eventSlug}
      step={step}
      published={published}
      identity={controller.identity}
      errors={controller.errors}
      staleFormConflict={controller.staleFormConflict}
      submissionsClosed={controller.submissionsClosed}
      saveError={controller.saveError}
      saveState={controller.saveState}
      mutationPending={controller.mutationPending}
      formRef={controller.formRef}
      draft={controller.draft}
      dynamicAnswers={controller.dynamicAnswers}
      participantAnswers={controller.participantAnswers}
      fileUploadStates={controller.fileUploadStates}
      accountMode={controller.accountMode}
      authenticatedSession={controller.authenticatedSession}
      confirmedApplicantContext={controller.confirmedApplicantContext}
      password={controller.password}
      requiresApplicantContextConfirmation={controller.requiresApplicantContextConfirmation}
      verificationState={controller.verificationState}
      onConfirmApplicantContext={() => controller.setConfirmedApplicantContext(true)}
      setAccountMode={controller.setAccountMode}
      setPassword={controller.setPassword}
      updateDraft={controller.updateDraft}
      onUseDifferentEmail={controller.useDifferentVerificationEmail}
      onSubmissionAnswer={controller.setSubmissionAnswer}
      onParticipantAnswer={controller.setParticipantAnswer}
      onFileUpload={controller.handleFileUpload}
      onFileUploadStateChange={controller.setFileUploadState}
      onSubmit={(event) => void controller.continueFlow(event)}
      onBack={controller.goBack}
      onSaveNow={() => void controller.saveNow()}
      onRefreshPinnedDraft={controller.refreshPinnedDraft}
      onDiscardStaleDraft={controller.discardStaleDraftAndStartNew}
    />
  );
}

export function CfpComplete({
  eventSlug,
  organizationId,
  formId,
  api: providedApi,
}: {
  eventSlug: string;
  organizationId?: string;
  formId?: string;
  api?: CfpApi;
}) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [confirmationDetails, setConfirmationDetails] = useState<{
    eventName: string;
    submissionTitle: string;
    recipient: string;
    confirmationMessage: string;
    successContent: string;
  } | null>(null);
  const [completionIdentity, setCompletionIdentity] = useState<{
    organizationId: string;
    eventId: string;
    formId: string;
    submissionId: string;
    canEdit: boolean;
  } | null>(null);
  const [publishedCfp, setPublishedCfp] = useState<PublishedCfp | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const api = useMemo(() => providedApi ?? createCfpApi(""), [providedApi]);
  const startupStore = useCfpStartupStore();
  const routeIdentity = useMemo(() => {
    try {
      return configuredCfpIdentity(eventSlug, organizationId, formId);
    } catch {
      return null;
    }
  }, [eventSlug, formId, organizationId]);
  const scopedOrganizationId = organizationId?.trim() ?? "";
  const routeScopeKey =
    routeIdentity === null
      ? null
      : `${routeIdentity.organizationId}\u0000${routeIdentity.eventId}\u0000${routeIdentity.formId ?? ""}`;
  const [redirectToReviewScope, requestReviewRedirect] = useReducer(
    (current: string | null, scopeKey: string | null) =>
      scopeKey === null || current === scopeKey ? current : scopeKey,
    null,
  );
  const reviewRedirectHref =
    (routeIdentity === null && scopedOrganizationId.length > 0) ||
    (routeScopeKey !== null && redirectToReviewScope === routeScopeKey)
      ? getCfpStepRoute(routeIdentity?.organizationId ?? scopedOrganizationId, eventSlug, "review")
      : null;

  useEffect(() => {
    if (routeIdentity === null) return;
    let active = true;
    const ownsScope = (): boolean => active;
    void (async () => {
      try {
        const published = await startupStore.load(api, routeIdentity).published;
        if (!ownsScope()) return;
        setPublishedCfp(published);
        const canonicalEventId = published.event.id;
        const activeFormId = published.form.id;
        const handoff = window.sessionStorage.getItem(
          getCfpCompletionHandoffStorageKey(
            routeIdentity.organizationId,
            canonicalEventId,
            activeFormId,
          ),
        );
        const submissionId = handoff?.trim() ?? "";
        if (!submissionId) {
          if (ownsScope()) requestReviewRedirect(routeScopeKey);
          return;
        }
        const receipt = await api.getReceipt({
          organizationId: routeIdentity.organizationId,
          eventId: canonicalEventId,
          submissionId,
        });
        if (!ownsScope()) return;
        if (!receipt.submissionId || !receipt.submittedAt) {
          requestReviewRedirect(routeScopeKey);
          return;
        }
        let submissionTitle = "";
        let recipient = "";
        try {
          const submission = await api.loadDraft({
            organizationId: routeIdentity.organizationId,
            eventId: canonicalEventId,
            submissionId,
          });
          const title = submission.answers.title;
          submissionTitle = typeof title === "string" ? title : "";
          const primary = submission.participants.find(
            (participant) => participant.role === "primary",
          );
          recipient =
            primary?.email ??
            (typeof submission.answers.accountEmail === "string"
              ? submission.answers.accountEmail
              : "");
        } catch {
          // The receipt remains sufficient to confirm submission when the draft view is unavailable.
        }
        if (!ownsScope()) return;
        setCompletionIdentity({
          organizationId: routeIdentity.organizationId,
          eventId: canonicalEventId,
          formId: activeFormId,
          submissionId,
          canEdit: !cfpIsClosed(published.event),
        });
        setConfirmationDetails({
          eventName: published.event.name,
          confirmationMessage:
            published.form.settings.confirmationMessage || "Your proposal has been received.",
          successContent:
            published.form.settings.successContent || "Thank you for contributing to the program.",
          submissionTitle,
          recipient,
        });
        setConfirmed(true);
      } catch {
        if (ownsScope()) requestReviewRedirect(routeScopeKey);
      }
    })();

    return () => {
      active = false;
    };
  }, [api, routeIdentity, routeScopeKey, startupStore]);
  if (reviewRedirectHref !== null) {
    redirect(reviewRedirectHref, RedirectType.replace);
  }
  function editSubmission(): void {
    if (completionIdentity === null || !completionIdentity.canEdit) return;
    const pointerKey = getCfpSubmissionPointerStorageKey(
      completionIdentity.organizationId,
      completionIdentity.eventId,
      completionIdentity.formId,
    );
    const activePointerKey = getCfpActiveSubmissionStorageKey(
      completionIdentity.organizationId,
      completionIdentity.eventId,
      completionIdentity.formId,
    );
    const currentPointer = window.localStorage.getItem(pointerKey);
    if (currentPointer !== null && currentPointer !== completionIdentity.submissionId) {
      setNavigationError(
        "Another saved draft is active. Open the submissions dashboard to choose which proposal to edit.",
      );
      return;
    }
    window.localStorage.setItem(pointerKey, completionIdentity.submissionId);
    window.sessionStorage.setItem(activePointerKey, completionIdentity.submissionId);
    window.sessionStorage.removeItem(
      getCfpNewSubmissionIntentStorageKey(
        completionIdentity.organizationId,
        completionIdentity.eventId,
        completionIdentity.formId,
      ),
    );
    setNavigationError(null);
    router.push(getCfpStepRoute(completionIdentity.organizationId, eventSlug, "submission"));
  }
  function submitAnotherSession(): void {
    if (completionIdentity === null) return;
    const pointerKey = getCfpSubmissionPointerStorageKey(
      completionIdentity.organizationId,
      completionIdentity.eventId,
      completionIdentity.formId,
    );
    const activePointerKey = getCfpActiveSubmissionStorageKey(
      completionIdentity.organizationId,
      completionIdentity.eventId,
      completionIdentity.formId,
    );
    if (window.localStorage.getItem(pointerKey) === completionIdentity.submissionId) {
      window.localStorage.removeItem(pointerKey);
    }
    clearCfpDraftStorage(eventSlug, window.localStorage);
    window.sessionStorage.removeItem(activePointerKey);
    window.sessionStorage.setItem(
      getCfpNewSubmissionIntentStorageKey(
        completionIdentity.organizationId,
        completionIdentity.eventId,
        completionIdentity.formId,
      ),
      "1",
    );
    window.sessionStorage.removeItem(
      getCfpCompletionHandoffStorageKey(
        completionIdentity.organizationId,
        completionIdentity.eventId,
        completionIdentity.formId,
      ),
    );
    setNavigationError(null);
    router.push(getCfpStepRoute(completionIdentity.organizationId, eventSlug, "welcome"));
  }

  if (!confirmed) {
    return (
      <PublicCfpShell
        event={publishedCfp?.event}
        form={publishedCfp?.form}
        organization={publishedCfp?.organization}
      >
        <div aria-busy="true" aria-live="polite" className={styles.loading}>
          Confirming your submission…
        </div>
      </PublicCfpShell>
    );
  }

  return (
    <PublicCfpShell
      className={styles.completeCard}
      event={publishedCfp?.event}
      form={publishedCfp?.form}
      organization={publishedCfp?.organization}
    >
      <div className={styles.completeContent}>
        <div aria-hidden="true" className={styles.successMarker}>
          ✓
        </div>
        <h1>
          {confirmationDetails?.submissionTitle
            ? `Submission received: ${confirmationDetails.submissionTitle}`
            : "Submission received"}
        </h1>
        <p>
          {confirmationDetails?.eventName ?? "Your event"} received your proposal.{" "}
          {cfpConfirmationEmailMessage(confirmationDetails?.recipient ?? "")}
        </p>
        <p>{confirmationDetails?.confirmationMessage ?? "Your proposal has been received."}</p>
        <p>{confirmationDetails?.successContent ?? "Thank you for contributing to the program."}</p>
        <p>
          Check your speaker status dashboard for the submission and any tasks that need to be
          completed.
        </p>
        {navigationError ? (
          <p className={styles.saveError} role="alert">
            {navigationError}
          </p>
        ) : null}
        <div className={styles.completionActions}>
          {completionIdentity?.canEdit ? (
            <Button onClick={editSubmission} type="button" variant="outline">
              Edit submission
            </Button>
          ) : null}
          <Button onClick={submitAnotherSession} type="button" variant="outline">
            Submit another session
          </Button>
        </div>
        <Button
          className={styles.primaryButton}
          onClick={() =>
            router.push(getCfpPortalHandoffHref("/portal/submissions", completionIdentity?.eventId))
          }
          type="button"
        >
          View submission
        </Button>
      </div>
    </PublicCfpShell>
  );
}
