"use client";

import { uploadMimeTypeLabels } from "@eventloom/contracts";
import { CheckCircle2, FileText, MailCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ThemeToggle } from "../../components/product-shell/theme-toggle";
import { Button } from "../../components/ui/button";
import { FileUpload } from "../../components/ui/file-upload";
import { Card } from "../../components/ui/card";
import { RichTextArea } from "../../components/ui/rich-text";
import { SearchableSelect } from "../../components/ui/searchable-select";
import { Separator } from "../../components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { WorkspaceBrandMark } from "../../components/workspace/workspace-brand-mark";
import { WorkspaceContextBar, WorkspaceShell } from "../../components/workspace/workspace-shell";
import {
  CfpApiError,
  type CfpAuthenticatedSession,
  type CfpFileUploadResult,
  type CfpFormField,
  type CfpPublishedForm,
  type PublishedCfp,
} from "./api";
import { CharacterCount, Field, Input } from "./cfp-field";
import { CfpProgress } from "./cfp-progress";
import { CfpSubmissionWindow } from "./cfp-submission-window";
import styles from "./cfp-wizard.module.css";
import {
  canSaveCfpDraftAtStep,
  cfpReviewSubmissionDetails,
  cfpSubmissionErrorKey,
  cfpSubmissionFieldValue,
} from "./cfp-wizard-model";
import { getCfpStepRoute } from "./routes";
import {
  CFP_STEP_LABELS,
  type CfpDraft,
  type CfpParticipant,
  type CfpSecondaryContact,
  type CfpStep,
  createEmptyParticipant,
} from "./types";
import { getPasswordChecks, type ValidationErrors } from "./validation";

const LOCAL_MAIL_INBOX_URL =
  process.env.NODE_ENV === "development" ? "http://127.0.0.1:8025/" : null;

const PARTICIPANT_IDENTITY_FIELDS: CfpFormField[] = [
  {
    id: "participant-first-name",
    sectionId: "participants",
    key: "firstName",
    label: "First Name",
    kind: "text",
    required: true,
    options: [],
  },
  {
    id: "participant-last-name",
    sectionId: "participants",
    key: "lastName",
    label: "Last Name",
    kind: "text",
    required: true,
    options: [],
  },
  {
    id: "participant-email",
    sectionId: "participants",
    key: "email",
    label: "Email",
    kind: "email",
    required: true,
    options: [],
  },
];

type FormFieldOption =
  | string
  | { value: string; label?: string; description?: string; disabled?: boolean };
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
type CfpAccountMode = "sign_in" | "sign_up";
type CfpVerificationState =
  | { readonly status: "waiting"; readonly email: string }
  | { readonly status: "resuming"; readonly email: string };

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

function fieldConfig(field: CfpFormField, key: string): unknown {
  if (isRecord(field.fileRequest) && key in field.fileRequest) return field.fileRequest[key];
  if (isRecord(field.config) && key in field.config) return field.config[key];
  const rawField = field as unknown as Record<string, unknown>;
  return key in rawField ? rawField[key] : undefined;
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
function mergeParticipant(
  draft: CfpDraft,
  index: number,
  patch: Partial<CfpParticipant>,
): CfpDraft {
  return {
    ...draft,
    participants: draft.participants.map((participant, participantIndex) =>
      participantIndex === index ? { ...participant, ...patch } : participant,
    ),
  };
}

function mergeSecondaryContact(
  draft: CfpDraft,
  index: number,
  patch: Partial<CfpSecondaryContact>,
): CfpDraft {
  return {
    ...draft,
    secondaryContacts: draft.secondaryContacts.map((contact, contactIndex) =>
      contactIndex === index ? { ...contact, ...patch } : contact,
    ),
  };
}

function readPersistedFileNames(
  form: CfpPublishedForm | undefined,
  answers: DynamicAnswers,
  storage: Pick<Storage, "getItem">,
): Record<string, string> {
  const fileNames: Record<string, string> = {};
  for (const field of form?.submissionFields ?? []) {
    if (field.kind !== "file_request") continue;
    const answer = answers[field.key];
    const persistedAssetId =
      typeof answer === "object" &&
      answer !== null &&
      "assetId" in answer &&
      typeof answer.assetId === "string"
        ? answer.assetId
        : undefined;
    if (persistedAssetId === undefined) continue;
    const persistedFileName = storage.getItem(fileNameStorageKey(persistedAssetId));
    if (persistedFileName !== null) fileNames[persistedAssetId] = persistedFileName;
  }
  return fileNames;
}

function formatCfpWindowDate(value: string, timeZone: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(timestamp));
  } catch {
    return value;
  }
}
function formSubmissionLimit(form?: CfpPublishedForm): number {
  const value = form?.settings.maxSubmissionsPerAccount;
  return typeof value === "number" && Number.isFinite(value) ? value : 3;
}

function newId(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function mutationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof CfpApiError) return error.message;
  if (error instanceof TypeError) {
    return "The CFP request could not reach the server. Check your connection and try again.";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

interface StepFormProps {
  draft: CfpDraft;
  errors: ValidationErrors;
  updateDraft: (update: (current: CfpDraft) => CfpDraft) => void;
}

interface CfpWizardSectionsProps {
  eventSlug: string;
  step: CfpStep;
  published: PublishedCfp;
  identity: { organizationId: string; eventId: string; formId: string } | null;
  errors: ValidationErrors;
  staleFormConflict: { submissionId: string | null; pinnedDraftUnavailable: boolean } | null;
  submissionsClosed: boolean;
  saveError: string | null;
  pinnedDraftAuthenticationRequired: boolean;
  saveState: "idle" | "saving" | "saved" | "error";
  mutationPending: boolean;
  formRef: React.MutableRefObject<HTMLFormElement | null>;
  draft: CfpDraft;
  dynamicAnswers: DynamicAnswers;
  participantAnswers: ParticipantAnswers;
  fileUploadStates: FileUploadStates;
  accountMode: CfpAccountMode;
  authenticatedSession: CfpAuthenticatedSession | null;
  confirmedApplicantContext: boolean;
  password: string;
  requiresApplicantContextConfirmation: boolean;
  verificationState: CfpVerificationState | null;
  onConfirmApplicantContext: () => void;
  setAccountMode: (mode: CfpAccountMode) => void;
  setPassword: (value: string) => void;
  updateDraft: (update: (current: CfpDraft) => CfpDraft) => void;
  onUseDifferentEmail: () => void;
  onSubmissionAnswer: (key: string, value: unknown) => void;
  onParticipantAnswer: (participantId: string, key: string, value: unknown) => void;
  onFileUpload: (
    field: CfpFormField,
    participantId: string | undefined,
    file: File,
  ) => Promise<CfpFileUploadResult>;
  onFileUploadStateChange: (key: string, state: FileUploadState) => void;
  onSubmit: (event: FormEvent) => void;
  onBack: () => void;
  onSaveNow: () => void;
  onRefreshPinnedDraft: () => void;
  onDiscardStaleDraft: () => void;
  onSwitchPinnedDraftAccount: () => void;
}

export function PublicCfpShell({
  children,
  organization,
  event,
  eventName,
  form,
  formName,
  step,
  className,
}: {
  children: ReactNode;
  organization?: PublishedCfp["organization"] | undefined;
  event?: PublishedCfp["event"] | undefined;
  eventName?: string | undefined;
  form?: CfpPublishedForm | undefined;
  formName?: string | undefined;
  step?: CfpStep | undefined;
  className?: string | undefined;
}) {
  const resolvedOrganizationName = organization?.name ?? "Eventloom";
  const resolvedEventName = event?.name ?? eventName ?? "Eventloom";
  const resolvedFormName = form?.name ?? formName ?? "Call for proposals";
  const resolvedStepName = step === undefined ? "Submission complete" : CFP_STEP_LABELS[step];
  const now = Date.now();
  const opensAt = event ? Date.parse(event.opensAt) : Number.NaN;
  const closesAt = event ? Date.parse(event.closesAt) : Number.NaN;
  const windowStatus =
    Number.isFinite(closesAt) && closesAt <= now
      ? "closed"
      : Number.isFinite(opensAt) && opensAt > now
        ? "upcoming"
        : "open";

  return (
    <WorkspaceShell
      className={styles.publicWorkspace ?? ""}
      contentBodyClassName={styles.publicContentBody ?? ""}
      contextBar={
        <WorkspaceContextBar
          actions={
            <div className={styles.publicThemeAction}>
              <ThemeToggle />
            </div>
          }
          className={styles.publicContextBar ?? ""}
          event={resolvedEventName}
          metadata={resolvedStepName}
          organization={resolvedOrganizationName}
        />
      }
      mainClassName={styles.publicMain ?? ""}
      mainId="cfp-main"
      navigation={
        <div className={styles.contextRail} data-cfp-context-rail>
          <div className={styles.publicBrand}>
            <WorkspaceBrandMark />
            <span className={styles.publicBrandCopy}>
              <strong>{resolvedOrganizationName}</strong>
              <span>Applicant workspace</span>
            </span>
          </div>
          <Separator className={styles.railSeparator} />
          <div className={styles.railIntro}>
            <p className={styles.railKicker}>Call for proposals</p>
            <p className={styles.railEventName}>{resolvedEventName}</p>
            <p className={styles.railFormName}>{resolvedFormName}</p>
          </div>
          {step ? <CfpProgress step={step} /> : <CfpProgress complete />}
        </div>
      }
    >
      <div className={styles.viewport}>
        <Card className={`${styles.card} ${className ?? ""}`}>
          <div className={styles.formColumn} data-cfp-main-flow>
            {event ? (
              <div className={styles.submissionWindow}>
                <CfpSubmissionWindow
                  opensAt={event.opensAt}
                  closesAt={event.closesAt}
                  {...(form ? { limit: formSubmissionLimit(form) } : {})}
                  status={windowStatus}
                  timeZone={event.timezone}
                />
              </div>
            ) : null}
            {step ? <CfpProgress mobile step={step} /> : <CfpProgress complete mobile />}
            {children}
          </div>
        </Card>
      </div>
    </WorkspaceShell>
  );
}

function ErrorSummary({ errors }: { errors: ValidationErrors }) {
  const messages = [...new Set(Object.values(errors))];
  if (messages.length === 0) return null;

  return (
    <div className={styles.errorSummary} role="alert" tabIndex={-1}>
      <strong>Check the highlighted fields.</strong>
      <ul>
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

function WelcomeStep({
  event,
  form,
  closed = false,
}: {
  event?: PublishedCfp["event"];
  form?: CfpPublishedForm;
  closed?: boolean;
}) {
  const content =
    form?.welcomeContent || "Our event welcomes leaders, practitioners, and change-makers.";
  return (
    <div className={styles.welcomeContent}>
      <p className={styles.welcomeEyebrow}>{form?.name ?? "Call for Speakers"}</p>
      <h1>{event?.name ?? "Welcome to our event!"}</h1>
      <p className={styles.welcomePurpose}>{content}</p>
      <p className={styles.welcomeNote}>
        Your speaker portal will show the status of your submission and any tasks assigned after
        acceptance.
      </p>
      <section aria-labelledby="resources-title" className={styles.welcomeResources}>
        <h2 id="resources-title">Resources</h2>
        <ul>
          <li id="speaker-agreement">
            <Link href="#speaker-agreement">Speaker Agreement Terms and Conditions</Link>
          </li>
          <li id="application-faq">
            <Link href="#application-faq">FAQs for the Speaker Application Process</Link>
          </li>
          <li id="speaker-resources">
            <Link href="#speaker-resources">Speaker Tips and Resources Guide</Link>
          </li>
        </ul>
      </section>
      {closed ? (
        <p className={styles.closedNotice} role="status">
          Submissions are closed. Existing submissions remain available in your speaker portal.
        </p>
      ) : null}
    </div>
  );
}

function AccountStep({
  accountMode,
  draft,
  errors,
  confirmedApplicantContext,
  onConfirmApplicantContext,
  password,
  pending,
  requiresApplicantContextConfirmation,
  setAccountMode,
  setPassword,
  updateDraft,
  authenticatedSession,
  verificationState,
  onUseDifferentEmail,
}: StepFormProps & {
  accountMode: CfpAccountMode;
  confirmedApplicantContext: boolean;
  onConfirmApplicantContext: () => void;
  password: string;
  pending: boolean;
  requiresApplicantContextConfirmation: boolean;
  setAccountMode: (mode: CfpAccountMode) => void;
  setPassword: (value: string) => void;
  authenticatedSession: CfpAuthenticatedSession | null;
  verificationState: CfpVerificationState | null;
  onUseDifferentEmail: () => void;
}) {
  if (verificationState !== null) {
    const resuming = verificationState.status === "resuming";
    return (
      <section aria-live="polite" className={styles.verificationPending} role="status">
        <span aria-hidden="true" className={styles.verificationIcon}>
          <MailCheck />
        </span>
        <p className={styles.verificationEyebrow}>Email verification</p>
        <h1>{resuming ? "Email verified" : "Check your inbox"}</h1>
        {resuming ? (
          <p>Verification is complete. We’re taking you to your proposal now.</p>
        ) : (
          <>
            <p>We sent a verification link to:</p>
            <strong className={styles.verificationRecipient}>{verificationState.email}</strong>
            <p>After verification, you’ll return here and continue automatically.</p>
            <p className={styles.verificationHint}>
              {LOCAL_MAIL_INBOX_URL
                ? "Local development captures this message in Mailpit instead of sending it to Gmail."
                : "Open the link in this browser. If it is not in your inbox, check spam or promotions."}
            </p>
            <div className={styles.verificationActions}>
              {LOCAL_MAIL_INBOX_URL ? (
                <Button asChild className={styles.verificationAction} variant="secondary">
                  <a data-local-mail-inbox href={LOCAL_MAIL_INBOX_URL}>
                    Open local inbox
                  </a>
                </Button>
              ) : null}
              <Button
                className={styles.verificationAction}
                onClick={onUseDifferentEmail}
                type="button"
                variant="outline"
              >
                Use a different email
              </Button>
            </div>
          </>
        )}
      </section>
    );
  }
  const checks = getPasswordChecks(password);
  return (
    <div className={styles.accountForm} data-cfp-account-form="true">
      <h1>
        {authenticatedSession
          ? `Continue as ${authenticatedSession.name}`
          : accountMode === "sign_in"
            ? "Sign in to continue"
            : "Create your account"}
      </h1>
      {authenticatedSession !== null &&
      requiresApplicantContextConfirmation &&
      !confirmedApplicantContext ? (
        <div className={styles.identityBoundary} data-cfp-applicant-context-boundary role="note">
          <strong>You are entering the applicant portal</strong>
          <p>
            This proposal will belong to {authenticatedSession.email}. Organizer and reviewer
            permissions are not used here.
          </p>
          <div className={styles.identityBoundaryActions}>
            <Button
              data-cfp-applicant-context-confirm
              onClick={onConfirmApplicantContext}
              type="button"
            >
              Continue as applicant
            </Button>
            <Button asChild type="button" variant="outline">
              <Link href="/admin">Return to organizer workspace</Link>
            </Button>
            <Button asChild type="button" variant="ghost">
              <Link href="/login?next=%2Fportal%2Fsubmissions">Use another account</Link>
            </Button>
          </div>
        </div>
      ) : null}
      {!authenticatedSession ? (
        <p>
          {accountMode === "sign_in"
            ? "Use your existing Eventloom account to continue to your proposal."
            : "Create an Eventloom account to save this proposal and receive updates."}
        </p>
      ) : null}
      {!authenticatedSession ? (
        <ToggleGroup
          aria-label="Account access"
          className={styles.accountModeSwitch}
          data-cfp-account-access="true"
          disabled={pending}
          onValueChange={(value) => {
            if (value === "sign_in" || value === "sign_up") setAccountMode(value);
          }}
          orientation="horizontal"
          spacing={0}
          type="single"
          value={accountMode}
          variant="outline"
        >
          <ToggleGroupItem data-cfp-account-mode="sign_in" value="sign_in">
            Existing account
          </ToggleGroupItem>
          <ToggleGroupItem data-cfp-account-mode="sign_up" value="sign_up">
            Create account
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}
      <div className={styles.sectionPanel}>
        <Field error={errors["account.email"]} label="Email address" name="account.email" required>
          {(controlProps) => (
            <Input
              {...controlProps}
              autoComplete="email"
              disabled={pending}
              readOnly={authenticatedSession !== null}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  account: { ...current.account, email: event.target.value },
                }))
              }
              type="email"
              value={draft.account.email}
            />
          )}
        </Field>
        {authenticatedSession ? (
          <p role="status">Signed in as {authenticatedSession.email}.</p>
        ) : (
          <>
            <Field
              error={errors["account.password"]}
              label="Password"
              name="account.password"
              required
            >
              {(controlProps) => (
                <Input
                  {...controlProps}
                  autoComplete={accountMode === "sign_up" ? "new-password" : "current-password"}
                  disabled={pending}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  value={password}
                />
              )}
            </Field>
            {accountMode === "sign_up" ? (
              <ul className={styles.passwordChecks}>
                <PasswordCheck passed={checks.minimumLength}>
                  Password includes at least 8 characters
                </PasswordCheck>
                <PasswordCheck passed={checks.specialCharacter}>
                  Password includes at least 1 special character
                </PasswordCheck>
                <PasswordCheck passed={checks.number}>
                  Password includes at least 1 number
                </PasswordCheck>
                <PasswordCheck passed={checks.capitalLetter}>
                  Password includes at least 1 capital letter
                </PasswordCheck>
              </ul>
            ) : null}
          </>
        )}
        {authenticatedSession || accountMode === "sign_up" ? (
          <>
            <div className={styles.twoColumns}>
              <Field
                error={errors["account.firstName"]}
                label="First name"
                name="account.firstName"
                required
              >
                {(controlProps) => (
                  <>
                    <Input
                      {...controlProps}
                      autoComplete="given-name"
                      disabled={pending}
                      maxLength={255}
                      onChange={(event) =>
                        updateDraft((current) => ({
                          ...current,
                          account: { ...current.account, firstName: event.target.value },
                        }))
                      }
                      value={draft.account.firstName}
                    />
                    <CharacterCount current={draft.account.firstName.length} maximum={255} />
                  </>
                )}
              </Field>
              <Field
                error={errors["account.lastName"]}
                label="Last name"
                name="account.lastName"
                required
              >
                {(controlProps) => (
                  <>
                    <Input
                      {...controlProps}
                      autoComplete="family-name"
                      disabled={pending}
                      maxLength={255}
                      onChange={(event) =>
                        updateDraft((current) => ({
                          ...current,
                          account: { ...current.account, lastName: event.target.value },
                        }))
                      }
                      value={draft.account.lastName}
                    />
                    <CharacterCount current={draft.account.lastName.length} maximum={255} />
                  </>
                )}
              </Field>
            </div>
            <label className={styles.consent} data-error-key="account.acceptedTerms">
              <input
                aria-invalid={Boolean(errors["account.acceptedTerms"])}
                checked={draft.account.acceptedTerms}
                disabled={pending}
                id="account.acceptedTerms"
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    account: { ...current.account, acceptedTerms: event.target.checked },
                  }))
                }
                type="checkbox"
              />
              <span>
                I agree to the <Link href="/terms">Terms of Service</Link> and{" "}
                <Link href="/privacy">Privacy Policy</Link>.{" "}
                <span aria-hidden="true" className={styles.required}>
                  *
                </span>
              </span>
            </label>
            {errors["account.acceptedTerms"] ? (
              <span className={styles.fieldError} role="alert">
                {errors["account.acceptedTerms"]}
              </span>
            ) : null}
          </>
        ) : null}
        {errors["account.auth"] ? (
          <p id="account.auth" className={styles.fieldError} role="alert">
            {errors["account.auth"]}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PasswordCheck({ children, passed }: { children: ReactNode; passed: boolean }) {
  return (
    <li className={passed ? styles.checkPassed : styles.checkPending}>
      <span aria-hidden="true">{passed ? "✓" : "×"}</span> {children}
    </li>
  );
}

function SubmissionStep({
  draft,
  errors,
  form,
  answers,
  fileUploadStates,
  onAnswerChange,
  onFileUpload,
  onFileUploadStateChange,
}: StepFormProps & {
  form: CfpPublishedForm;
  answers: DynamicAnswers;
  fileUploadStates: FileUploadStates;
  onAnswerChange: (key: string, value: unknown) => void;
  onFileUpload: (field: CfpFormField, file: File) => Promise<CfpFileUploadResult>;
  onFileUploadStateChange: (key: string, state: FileUploadState) => void;
}) {
  if (form.submissionFields.length === 0) {
    return (
      <section className={styles.errorSummary} role="alert">
        <h2>Submission form unavailable</h2>
        <p>The published form does not contain any proposal fields.</p>
      </section>
    );
  }
  return (
    <DynamicSubmissionFields
      answers={answers}
      draft={draft}
      errors={errors}
      fileUploadStates={fileUploadStates}
      form={form}
      onAnswerChange={onAnswerChange}
      onFileUpload={onFileUpload}
      onFileUploadStateChange={onFileUploadStateChange}
    />
  );
}

function FileRequestControl({
  field,
  state,
  value,
  id,
  onChange,
  onUpload,
  onStateChange,
}: {
  field: CfpFormField;
  state: FileUploadState | undefined;
  value: unknown;
  id: string;
  onChange: (value: unknown) => void;
  onUpload: (file: File) => Promise<CfpFileUploadResult>;
  onStateChange: (state: FileUploadState) => void;
}) {
  const configuredMimeTypes =
    fieldConfig(field, "allowedMimeTypes") ?? fieldConfig(field, "mimeTypes");
  const maxBytes = fieldConfig(field, "maxBytes");
  const acceptedTypes = Array.isArray(configuredMimeTypes)
    ? configuredMimeTypes.filter((type): type is string => typeof type === "string")
    : [];
  const maxSize = typeof maxBytes === "number" && Number.isFinite(maxBytes) ? maxBytes : undefined;
  const persistedAssetId =
    isRecord(value) && typeof value.assetId === "string" && value.assetId.trim()
      ? value.assetId
      : undefined;
  const displayState =
    state ??
    (persistedAssetId === undefined
      ? undefined
      : { status: "ready" as const, assetId: persistedAssetId });
  const uploadSequenceRef = useRef(0);
  const acceptedTypeLabels = uploadMimeTypeLabels(acceptedTypes);
  const maxSizeLabel =
    maxSize === undefined
      ? undefined
      : maxSize >= 1024 * 1024
        ? `${maxSize / (1024 * 1024)} MB`
        : `${Math.ceil(maxSize / 1024)} KB`;
  const requirementParts = [
    ...(acceptedTypeLabels.length > 0 ? [`Accepted: ${acceptedTypeLabels.join(", ")}`] : []),
    ...(maxSizeLabel ? [`Max ${maxSizeLabel}`] : []),
  ];
  const helpId = `${field.key}-file-help`;
  const errorId = `${field.key}-file-error`;
  const statusId = `${field.key}-file-status`;
  const hasUploadedFile = displayState?.status === "ready";

  function mimeTypeAllowed(contentType: string): boolean {
    const normalized = contentType.trim().toLowerCase();
    return acceptedTypes.some((allowed) => {
      const normalizedAllowed = allowed.trim().toLowerCase();
      if (normalizedAllowed === "*/*" || normalizedAllowed === "*") return true;
      if (normalizedAllowed.endsWith("/*"))
        return normalized.startsWith(normalizedAllowed.slice(0, -1));
      return normalizedAllowed === normalized;
    });
  }

  function handleSelectedFile(file: File | undefined): void {
    const sequence = ++uploadSequenceRef.current;
    if (!file) {
      onChange(undefined);
      onStateChange({ status: "idle" });
      return;
    }
    onChange(undefined);
    if (acceptedTypes.length > 0 && !mimeTypeAllowed(file.type)) {
      onStateChange({
        status: "error",
        name: file.name,
        message: `Choose a file of an allowed type (${acceptedTypes.join(", ")}).`,
      });
      return;
    }
    if (maxSize !== undefined && file.size > maxSize) {
      onStateChange({
        status: "error",
        name: file.name,
        message: `The selected file must be ${maxSize} bytes or smaller.`,
      });
      return;
    }
    onStateChange({ status: "pending", name: file.name });
    void onUpload(file)
      .then((result) => {
        if (sequence !== uploadSequenceRef.current) return;
        if (result.state !== "ready" || result.assetId.trim().length === 0) {
          throw new CfpApiError(
            "CFP_FILE_UPLOAD_REJECTED",
            "The uploaded file was rejected during finalization.",
            409,
          );
        }
        onChange({ assetId: result.assetId });
        onStateChange({ status: "ready", name: result.fileName, assetId: result.assetId });
      })
      .catch((error) => {
        if (sequence !== uploadSequenceRef.current) return;
        onStateChange({
          status: "error",
          name: file.name,
          message: mutationErrorMessage(error, "The file could not be uploaded."),
        });
      });
  }

  const selectedFiles =
    displayState === undefined || displayState.status === "idle"
      ? []
      : [
          {
            id: displayState.assetId ?? displayState.name ?? field.key,
            name: displayState.name ?? "Uploaded file",
            sizeLabel:
              displayState.status === "pending"
                ? "Uploading securely…"
                : displayState.status === "ready"
                  ? "Uploaded and ready"
                  : (displayState.message ?? "Upload failed"),
            status:
              displayState.status === "pending"
                ? ("uploading" as const)
                : displayState.status === "ready"
                  ? ("complete" as const)
                  : ("error" as const),
            removable: displayState.status !== "pending",
          },
        ];
  return (
    <div className={styles.fileRequestControl}>
      <FileUpload
        id={id}
        {...(acceptedTypes.length > 0 ? { accept: acceptedTypes.join(",") } : {})}
        disabled={displayState?.status === "pending"}
        title={
          hasUploadedFile ? "Drop a replacement file or browse" : "Drop your files here or browse"
        }
        hint={
          requirementParts.length > 0
            ? requirementParts.join(" · ")
            : hasUploadedFile
              ? "Choose a new file to replace this upload."
              : "Select a file from your device."
        }
        browseLabel={
          acceptedTypeLabels.length === 1 && acceptedTypeLabels[0] === "PDF"
            ? "Browse PDF"
            : "Browse file"
        }
        describedBy={[
          ...(requirementParts.length > 0 ? [helpId] : []),
          ...(displayState?.status === "error" ? [errorId] : []),
          ...(displayState?.status === "pending" || displayState?.status === "ready"
            ? [statusId]
            : []),
        ].join(" ")}
        invalid={displayState?.status === "error"}
        files={selectedFiles}
        onFilesSelected={(files) => handleSelectedFile(files[0])}
        onRemove={() => handleSelectedFile(undefined)}
      />
      {requirementParts.length > 0 ? (
        <p className={styles.fieldHint} hidden id={helpId}>
          {requirementParts.join(" · ")}
        </p>
      ) : null}
      {displayState?.status === "pending" || displayState?.status === "ready" ? (
        <p className={styles.srOnly} id={statusId}>
          {displayState.status === "pending" ? "Uploading securely" : "Uploaded and ready"}
        </p>
      ) : null}
      {displayState?.status === "error" ? (
        <p className={styles.fieldError} id={errorId} role="alert">
          {displayState.message}
        </p>
      ) : null}
    </div>
  );
}

function SearchableMultiField({
  field,
  value,
  id,
  describedBy,
  onChange,
}: {
  field: CfpFormField;
  value: string[];
  id: string;
  describedBy: string | undefined;
  onChange: (value: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const selectedValueSet = useMemo(() => new Set(value), [value]);
  const options = fieldOptions(field).filter(
    (option) =>
      !selectedValueSet.has(option.value) &&
      `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(normalizedQuery),
  );
  return (
    <div className={styles.multiSelect}>
      {value.length > 0 ? (
        <div className={styles.selectedTags}>
          {value.map((selectedValue) => {
            const option = fieldOptions(field).find((item) => item.value === selectedValue);
            return (
              <span className={styles.selectedTag} key={selectedValue}>
                {option?.label ?? selectedValue}
                <button
                  aria-label={`Remove ${option?.label ?? selectedValue}`}
                  onClick={() => onChange(value.filter((item) => item !== selectedValue))}
                  type="button"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      <label className={styles.srOnly} htmlFor={id}>
        Search {field.label} options
      </label>
      <Input
        aria-describedby={describedBy}
        id={id}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={value.length > 0 ? "Add another option…" : "Search options…"}
        type="search"
        value={query}
      />
      {normalizedQuery ? (
        <div aria-label={`${field.label} options`} className={styles.tagOptions} role="listbox">
          {options.length > 0 ? (
            options.map((option) => (
              <button
                aria-selected={false}
                disabled={option.disabled}
                key={option.value}
                role="option"
                type="button"
                onClick={() => {
                  onChange([...value, option.value]);
                  setQuery("");
                }}
              >
                <span>{option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </button>
            ))
          ) : (
            <span className={styles.tagEmpty}>No matching options</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PublishedFieldControl({
  field,
  value,
  error,
  onChange,
  onFileUpload,
  fileState,
  onFileStateChange,
  errorKey,
}: {
  field: CfpFormField;
  value: unknown;
  error: string | undefined;
  onFileUpload: (file: File) => Promise<CfpFileUploadResult>;
  onChange: (value: unknown) => void;
  fileState: FileUploadState | undefined;
  onFileStateChange: (state: FileUploadState) => void;
  errorKey: string;
}) {
  const kind = field.kind.toLowerCase().replaceAll("-", "_");
  const valueString = typeof value === "string" ? value : "";
  const options = fieldOptions(field);
  const maxLength = fieldConfig(field, "maxLength");
  const description = fieldConfig(field, "description");
  const configuredPlaceholder = fieldConfig(field, "placeholder");
  const placeholder =
    field.placeholder ?? (typeof configuredPlaceholder === "string" ? configuredPlaceholder : "");
  const hint = typeof description === "string" ? description : undefined;
  return (
    <Field error={error} hint={hint} label={field.label} name={errorKey} required={field.required}>
      {(controlProps) => {
        if (isFileField(field)) {
          return (
            <FileRequestControl
              field={field}
              value={value}
              id={controlProps.id}
              onChange={onChange}
              onUpload={(file) => onFileUpload(file)}
              onStateChange={onFileStateChange}
              state={fileState}
            />
          );
        }
        if (kind === "rich_text") {
          return (
            <RichTextArea
              {...controlProps}
              maxLength={typeof maxLength === "number" ? maxLength : 10000}
              onValueChange={onChange}
              placeholder={placeholder}
              rows={field.key === "abstract" ? 6 : 4}
              value={valueString}
            />
          );
        }
        if (kind === "select") {
          return (
            <SearchableSelect
              {...(controlProps["aria-describedby"]
                ? { describedBy: controlProps["aria-describedby"] }
                : {})}
              id={controlProps.id}
              invalid={Boolean(controlProps["aria-invalid"])}
              onValueChange={onChange as (value: string) => void}
              options={options}
              placeholder={placeholder || "Search or select…"}
              required={field.required}
              value={valueString}
            />
          );
        }
        if (kind === "multi_select") {
          return (
            <SearchableMultiField
              field={field}
              id={controlProps.id}
              describedBy={controlProps["aria-describedby"]}
              onChange={onChange as (value: string[]) => void}
              value={
                Array.isArray(value)
                  ? value.filter((item): item is string => typeof item === "string")
                  : []
              }
            />
          );
        }
        if (kind === "boolean") {
          return (
            <label>
              <input
                {...controlProps}
                checked={value === true}
                onChange={(event) => onChange(event.currentTarget.checked)}
                type="checkbox"
              />{" "}
              {field.label}
            </label>
          );
        }
        if (kind === "number") {
          return (
            <Input
              {...controlProps}
              onChange={(event) =>
                onChange(event.currentTarget.value === "" ? "" : Number(event.currentTarget.value))
              }
              placeholder={placeholder}
              type="number"
              value={typeof value === "number" ? value : valueString}
            />
          );
        }
        if (kind === "email" || kind === "url" || kind === "text") {
          return (
            <Input
              {...controlProps}
              onChange={(event) => onChange(event.currentTarget.value)}
              placeholder={placeholder}
              type={kind}
              value={valueString}
            />
          );
        }
        return (
          <Input
            {...controlProps}
            onChange={(event) => onChange(event.currentTarget.value)}
            placeholder={placeholder}
            value={valueString}
          />
        );
      }}
    </Field>
  );
}

function DynamicSubmissionFields({
  form,
  draft,
  answers,
  errors,
  fileUploadStates,
  onAnswerChange,
  onFileUpload,
  onFileUploadStateChange,
}: {
  form: CfpPublishedForm;
  draft: CfpDraft;
  answers: DynamicAnswers;
  errors: ValidationErrors;
  fileUploadStates: FileUploadStates;
  onFileUpload: (field: CfpFormField, file: File) => Promise<CfpFileUploadResult>;
  onAnswerChange: (key: string, value: unknown) => void;
  onFileUploadStateChange: (key: string, state: FileUploadState) => void;
}) {
  const evaluated = evaluatePublishedFields(form, {
    ...answers,
    accountEmail: draft.account.email,
    accountFirstName: draft.account.firstName,
    accountLastName: draft.account.lastName,
  });
  const sections =
    form.sections.length > 0
      ? form.sections
      : [{ id: "submission", title: "Submission", description: "" }];
  return (
    <div>
      <h1>Tell us about your submission</h1>
      <p>What do you want to present? Fill out the following information to tell us more.</p>
      {sections.map((section) => {
        if (evaluated.sections.get(section.id) === false) return null;
        const fields = form.submissionFields.filter((field) => field.sectionId === section.id);
        if (fields.length === 0) return null;
        return (
          <section
            aria-labelledby={`cfp-section-${section.id}`}
            className={styles.sectionPanel}
            key={section.id}
          >
            <h2 id={`cfp-section-${section.id}`}>{section.title}</h2>
            {section.description ? <p>{section.description}</p> : null}
            {fields.map((field) => {
              const fieldState = evaluated.fields.get(field.key) ?? {
                visible: true,
                required: fieldRequired(field),
              };
              if (!fieldState.visible) return null;
              const configuredField =
                fieldState.required === field.required
                  ? field
                  : { ...field, required: fieldState.required };
              const errorKey = cfpSubmissionErrorKey(field.key);
              return (
                <PublishedFieldControl
                  key={field.id}
                  error={errors[errorKey]}
                  errorKey={errorKey}
                  field={configuredField}
                  fileState={fileUploadStates[fileStateKey(field.key)]}
                  onChange={(value) => onAnswerChange(field.key, value)}
                  onFileUpload={(file) => onFileUpload(field, file)}
                  onFileStateChange={(state) =>
                    onFileUploadStateChange(fileStateKey(field.key), state)
                  }
                  value={cfpSubmissionFieldValue(draft, answers, field.key)}
                />
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function ParticipantsStep({
  draft,
  errors,
  form,
  answers,
  fileUploadStates,
  onAnswerChange,
  onFileUpload,
  onFileUploadStateChange,
  updateDraft,
}: StepFormProps & {
  form?: CfpPublishedForm;
  answers: ParticipantAnswers;
  fileUploadStates: FileUploadStates;
  onAnswerChange: (participantId: string, key: string, value: unknown) => void;
  onFileUpload: (
    field: CfpFormField,
    participantId: string,
    file: File,
  ) => Promise<CfpFileUploadResult>;
  onFileUploadStateChange: (key: string, state: FileUploadState) => void;
}) {
  if (form && form.participantFields.length > 0) {
    return (
      <DynamicParticipantsFields
        answers={answers}
        draft={draft}
        errors={errors}
        fileUploadStates={fileUploadStates}
        form={form}
        onAnswerChange={onAnswerChange}
        onFileUpload={onFileUpload}
        onFileUploadStateChange={onFileUploadStateChange}
        updateDraft={updateDraft}
      />
    );
  }
  function addParticipant(): void {
    if (draft.participants.length >= 15) return;
    updateDraft((current) => ({
      ...current,
      participants: [
        ...current.participants,
        createEmptyParticipant(newId("participant"), "Co-speaker"),
      ],
    }));
  }

  return (
    <div>
      <div className={styles.participantHeading}>
        <div>
          <h1>Tell us about you</h1>
          <p>
            Give us information about yourself and your credentials for presenting at our event.
          </p>
        </div>
        <Button
          className={styles.addButton}
          disabled={draft.participants.length >= 15}
          onClick={addParticipant}
          size="sm"
          type="button"
          variant="secondary"
        >
          ＋ Add participant
        </Button>
      </div>
      {errors.participants ? (
        <p className={styles.fieldError} id="participants" role="alert" tabIndex={-1}>
          {errors.participants}
        </p>
      ) : null}
      {draft.participants.map((participant, index) => (
        <section className={styles.participantCard} key={participant.id}>
          <div className={styles.participantCardHeading}>
            <h2>{index === 0 ? "Primary speaker" : `Additional speaker ${index}`}</h2>
            {index > 0 ? (
              <Button
                className={styles.removeButton}
                onClick={() =>
                  updateDraft((current) => ({
                    ...current,
                    participants: current.participants.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ),
                  }))
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                Remove
              </Button>
            ) : null}
          </div>
          <div className={styles.participantRole}>
            <span>{index === 0 ? "Primary speaker" : "Co-speaker"}</span>
            <p>
              {index === 0
                ? "This person is the main contact and presenter for the proposal."
                : "This person will be listed as an additional presenter."}
            </p>
          </div>
          <div className={styles.twoColumns}>
            <Field
              error={errors[`participants.${index}.firstName`]}
              label="First Name"
              name={`participants.${index}.firstName`}
              required
            >
              {(controlProps) => (
                <Input
                  {...controlProps}
                  maxLength={255}
                  onChange={(event) =>
                    updateDraft((current) =>
                      mergeParticipant(current, index, { firstName: event.target.value }),
                    )
                  }
                  value={participant.firstName}
                />
              )}
            </Field>
            <Field
              error={errors[`participants.${index}.lastName`]}
              label="Last Name"
              name={`participants.${index}.lastName`}
              required
            >
              {(controlProps) => (
                <Input
                  {...controlProps}
                  maxLength={255}
                  onChange={(event) =>
                    updateDraft((current) =>
                      mergeParticipant(current, index, { lastName: event.target.value }),
                    )
                  }
                  value={participant.lastName}
                />
              )}
            </Field>
          </div>
          <Field
            error={errors[`participants.${index}.email`]}
            label="Email"
            name={`participants.${index}.email`}
            required
          >
            {(controlProps) => (
              <Input
                {...controlProps}
                onChange={(event) =>
                  updateDraft((current) =>
                    mergeParticipant(current, index, { email: event.target.value }),
                  )
                }
                type="email"
                value={participant.email}
              />
            )}
          </Field>
          <Field
            error={errors[`participants.${index}.biography`]}
            label="Biography"
            name={`participants.${index}.biography`}
          >
            {(controlProps) => (
              <RichTextArea
                {...controlProps}
                maxLength={5000}
                onValueChange={(value) =>
                  updateDraft((current) => mergeParticipant(current, index, { biography: value }))
                }
                placeholder="Tell us a bit about yourself"
                rows={6}
                value={participant.biography}
              />
            )}
          </Field>
        </section>
      ))}
      <SecondaryContacts draft={draft} errors={errors} updateDraft={updateDraft} />
    </div>
  );
}

function DynamicParticipantsFields({
  form,
  draft,
  errors,
  answers,
  fileUploadStates,
  onAnswerChange,
  onFileUpload,
  onFileUploadStateChange,
  updateDraft,
}: StepFormProps & {
  form: CfpPublishedForm;
  answers: ParticipantAnswers;
  fileUploadStates: FileUploadStates;
  onFileUpload: (
    field: CfpFormField,
    participantId: string,
    file: File,
  ) => Promise<CfpFileUploadResult>;
  onAnswerChange: (participantId: string, key: string, value: unknown) => void;
  onFileUploadStateChange: (key: string, state: FileUploadState) => void;
}) {
  const configuredIdentityKeys = new Set(form.participantFields.map((field) => field.key));
  const fields = [
    ...PARTICIPANT_IDENTITY_FIELDS.filter((field) => !configuredIdentityKeys.has(field.key)),
    ...form.participantFields,
  ];

  function updateParticipantField(index: number, key: string, value: unknown): void {
    const patch: Partial<CfpParticipant> = {};
    if (key === "firstName") patch.firstName = String(value ?? "");
    if (key === "lastName") patch.lastName = String(value ?? "");
    if (key === "email") patch.email = String(value ?? "");
    if (key === "biography") patch.biography = String(value ?? "");
    if (key === "mobilePhone") patch.mobilePhone = String(value ?? "");
    if (Object.keys(patch).length > 0) {
      updateDraft((current) => mergeParticipant(current, index, patch));
    } else {
      const participant = draft.participants[index];
      if (participant) onAnswerChange(participant.id, key, value);
    }
  }

  function addParticipant(): void {
    if (draft.participants.length >= 15) return;
    const participant = createEmptyParticipant(newId("participant"), "Co-speaker");
    updateDraft((current) => ({
      ...current,
      participants: [...current.participants, participant],
    }));
  }

  return (
    <div>
      <div className={styles.participantHeading}>
        <div>
          <h1>Tell us about you</h1>
          <p>
            Give us information about yourself and your credentials for presenting at our event.
          </p>
        </div>
        <Button
          className={styles.addButton}
          disabled={draft.participants.length >= 15}
          onClick={addParticipant}
          size="sm"
          type="button"
          variant="secondary"
        >
          ＋ Add participant
        </Button>
      </div>
      {errors.participants ? (
        <p className={styles.fieldError} id="participants" role="alert" tabIndex={-1}>
          {errors.participants}
        </p>
      ) : null}
      {draft.participants.map((participant, index) => {
        const participantCustomAnswers = answers[participant.id] ?? {};
        const evaluated = evaluatePublishedFields(form, {
          ...participantCustomAnswers,
          firstName: participant.firstName,
          lastName: participant.lastName,
          email: participant.email,
          biography: participant.biography,
          mobilePhone: participant.mobilePhone,
        });
        return (
          <section
            aria-labelledby={`participant-${participant.id}-heading`}
            className={styles.participantCard}
            key={participant.id}
          >
            <div className={styles.participantCardHeading}>
              <h2 id={`participant-${participant.id}-heading`}>
                {index === 0 ? "Primary speaker" : `Additional speaker ${index}`}
              </h2>
              {index > 0 ? (
                <Button
                  className={styles.removeButton}
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      participants: current.participants.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    }))
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </Button>
              ) : null}
            </div>
            <div className={styles.participantRole}>
              <span>{index === 0 ? "Primary speaker" : "Co-speaker"}</span>
              <p>
                {index === 0
                  ? "This person is the main contact and presenter for the proposal."
                  : "This person will be listed as an additional presenter."}
              </p>
            </div>
            {fields.map((field) => {
              const state = evaluated.fields.get(field.key) ?? {
                visible: true,
                required: fieldRequired(field),
              };
              if (!state.visible) return null;
              const configuredField =
                state.required === field.required ? field : { ...field, required: state.required };
              const errorKey = `participants.${index}.${field.key}`;
              return (
                <PublishedFieldControl
                  key={field.id}
                  error={errors[errorKey]}
                  errorKey={errorKey}
                  field={configuredField}
                  fileState={fileUploadStates[fileStateKey(field.key, index)]}
                  onChange={(value) => updateParticipantField(index, field.key, value)}
                  onFileUpload={(file) => onFileUpload(field, participant.id, file)}
                  onFileStateChange={(state) =>
                    onFileUploadStateChange(fileStateKey(field.key, index), state)
                  }
                  value={participantValue(participant, participantCustomAnswers, field.key)}
                />
              );
            })}
            {!configuredIdentityKeys.has("biography") ? (
              <Field
                error={errors[`participants.${index}.biography`]}
                label="Biography"
                name={`participants.${index}.biography`}
              >
                {(controlProps) => (
                  <RichTextArea
                    {...controlProps}
                    maxLength={5000}
                    onValueChange={(value) => updateParticipantField(index, "biography", value)}
                    rows={6}
                    value={participant.biography}
                  />
                )}
              </Field>
            ) : null}
          </section>
        );
      })}
      <SecondaryContacts draft={draft} errors={errors} updateDraft={updateDraft} />
    </div>
  );
}
function SecondaryContacts({ draft, errors, updateDraft }: StepFormProps) {
  function addContact(): void {
    const contact: CfpSecondaryContact = {
      id: newId("contact"),
      firstName: "",
      lastName: "",
      email: "",
    };
    updateDraft((current) => ({
      ...current,
      secondaryContacts: [...current.secondaryContacts, contact],
    }));
  }

  return (
    <section className={styles.secondaryContacts}>
      <Button
        className={styles.textButton}
        onClick={addContact}
        size="sm"
        type="button"
        variant="ghost"
      >
        ＋ Add Secondary Contact
      </Button>
      <p>Secondary contacts can assist with tasks and communication.</p>
      {draft.secondaryContacts.map((contact, index) => (
        <div className={styles.contactCard} key={contact.id}>
          <div className={styles.participantCardHeading}>
            <h2>Secondary contact {index + 1}</h2>
            <Button
              className={styles.removeButton}
              onClick={() =>
                updateDraft((current) => ({
                  ...current,
                  secondaryContacts: current.secondaryContacts.filter(
                    (_, itemIndex) => itemIndex !== index,
                  ),
                }))
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              Remove
            </Button>
          </div>
          <div className={styles.twoColumns}>
            <Field
              error={errors[`secondaryContacts.${index}.firstName`]}
              label="First Name"
              name={`secondaryContacts.${index}.firstName`}
              required
            >
              {(controlProps) => (
                <Input
                  {...controlProps}
                  onChange={(event) =>
                    updateDraft((current) =>
                      mergeSecondaryContact(current, index, { firstName: event.target.value }),
                    )
                  }
                  value={contact.firstName}
                />
              )}
            </Field>
            <Field
              error={errors[`secondaryContacts.${index}.lastName`]}
              label="Last Name"
              name={`secondaryContacts.${index}.lastName`}
              required
            >
              {(controlProps) => (
                <Input
                  {...controlProps}
                  onChange={(event) =>
                    updateDraft((current) =>
                      mergeSecondaryContact(current, index, { lastName: event.target.value }),
                    )
                  }
                  value={contact.lastName}
                />
              )}
            </Field>
          </div>
          <Field
            error={errors[`secondaryContacts.${index}.email`]}
            label="Email"
            name={`secondaryContacts.${index}.email`}
            required
          >
            {(controlProps) => (
              <Input
                {...controlProps}
                onChange={(event) =>
                  updateDraft((current) =>
                    mergeSecondaryContact(current, index, { email: event.target.value }),
                  )
                }
                type="email"
                value={contact.email}
              />
            )}
          </Field>
        </div>
      ))}
    </section>
  );
}

function ReviewStep({
  draft,
  eventSlug,
  fileUploadStates,
  organizationId,
  form,
  answers,
}: {
  draft: CfpDraft;
  eventSlug: string;
  fileUploadStates: FileUploadStates;
  organizationId: string;
  form?: CfpPublishedForm;
  answers: DynamicAnswers;
}) {
  const router = useRouter();
  const submissionDetails = cfpReviewSubmissionDetails(form, draft, answers);
  const [persistedFileNames, setPersistedFileNames] = useState<Record<string, string>>({});
  useEffect(() => {
    setPersistedFileNames(readPersistedFileNames(form, answers, window.sessionStorage));
  }, [answers, form]);
  const uploadedFiles =
    form?.submissionFields.flatMap((field) => {
      if (field.kind !== "file_request") return [];
      const uploadState = fileUploadStates[fileStateKey(field.key)];
      const answer = answers[field.key];
      const persistedAssetId =
        typeof answer === "object" &&
        answer !== null &&
        "assetId" in answer &&
        typeof answer.assetId === "string"
          ? answer.assetId
          : undefined;
      if (uploadState?.status !== "ready" && persistedAssetId === undefined) return [];
      const persistedFileName =
        persistedAssetId === undefined ? undefined : persistedFileNames[persistedAssetId];
      return [
        {
          key: field.key,
          label: field.label,
          name:
            uploadState?.status === "ready" && uploadState.name
              ? uploadState.name
              : (persistedFileName ?? "Uploaded file"),
        },
      ];
    }) ?? [];
  return (
    <div>
      <h1>Review your submission</h1>
      <p>Check that everything looks correct. You can go back to make changes before submitting.</p>
      <section className={styles.reviewCard}>
        <div className={styles.reviewHeading}>
          <h2>Tell us about your submission</h2>
          <Button
            className={styles.textButton}
            onClick={() => router.push(getCfpStepRoute(organizationId, eventSlug, "submission"))}
            size="sm"
            type="button"
            variant="ghost"
          >
            ✎ Edit session
          </Button>
        </div>
        {submissionDetails.map((detail) => (
          <ReviewValue key={detail.key} label={detail.label} value={detail.value} />
        ))}
        {uploadedFiles.length > 0 ? (
          <div className={styles.reviewFiles}>
            <p className={styles.reviewFilesLabel}>Uploaded files</p>
            {uploadedFiles.map((file) => (
              <div className={styles.reviewFile} key={file.key}>
                <FileText aria-hidden="true" size={20} />
                <div>
                  <span>{file.label}</span>
                  <strong>{file.name}</strong>
                </div>
                <span className={styles.reviewFileStatus}>
                  <CheckCircle2 aria-hidden="true" size={16} />
                  Ready
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <section className={styles.reviewCard}>
        <div className={styles.reviewHeading}>
          <h2>Tell us about you</h2>
          <Button
            className={styles.textButton}
            onClick={() => router.push(getCfpStepRoute(organizationId, eventSlug, "participants"))}
            size="sm"
            type="button"
            variant="ghost"
          >
            ✎ Edit participants
          </Button>
        </div>
        {draft.participants.map((participant) => (
          <div className={styles.reviewParticipant} key={participant.id}>
            <h3>
              {participant.firstName} {participant.lastName} <span>{participant.role}</span>
            </h3>
            <ReviewValue label="Email" value={participant.email} />
            <ReviewValue label="Biography" value={participant.biography || "Not provided"} />
          </div>
        ))}
      </section>
    </div>
  );
}

function ReviewValue({ label, value }: { label: string; value: string }) {
  if (value.trim().length === 0) return null;
  return (
    <dl className={styles.reviewValue}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </dl>
  );
}

export function CfpWizardSections({
  eventSlug,
  step,
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
  onConfirmApplicantContext,
  setAccountMode,
  setPassword,
  updateDraft,
  onUseDifferentEmail,
  onSubmissionAnswer,
  onParticipantAnswer,
  onFileUpload,
  onFileUploadStateChange,
  onSubmit,
  onBack,
  onSaveNow,
  onRefreshPinnedDraft,
  onDiscardStaleDraft,
  pinnedDraftAuthenticationRequired,
  onSwitchPinnedDraftAccount,
}: CfpWizardSectionsProps) {
  const accountHref = getCfpStepRoute(
    identity?.organizationId ?? published.organization.id,
    eventSlug,
    "account",
  );
  return (
    <PublicCfpShell
      organization={published.organization}
      event={published.event}
      form={published.form}
      step={step}
    >
      <ErrorSummary errors={errors} />
      {staleFormConflict ? (
        <section className={styles.errorSummary} role="alert">
          <h2>This form has changed</h2>
          <p>
            The organizer updated this submission form. Reload the latest form before continuing;
            your existing server draft will not be silently migrated.
          </p>
          {staleFormConflict.pinnedDraftUnavailable ? (
            <p>
              The pinned server draft cannot be loaded with this form version. Discard it only when
              you are ready to start a new submission.
            </p>
          ) : null}
          <div className={styles.forwardActions}>
            <Button
              disabled={
                staleFormConflict.pinnedDraftUnavailable || staleFormConflict.submissionId === null
              }
              onClick={onRefreshPinnedDraft}
              type="button"
              variant="secondary"
            >
              Reload pinned draft
            </Button>
            <Button onClick={onDiscardStaleDraft} type="button" variant="destructive">
              Discard stale draft and start new
            </Button>
          </div>
        </section>
      ) : null}
      {submissionsClosed ? (
        <p className={styles.fieldError} role="status">
          CFP closed at{" "}
          {published?.event
            ? formatCfpWindowDate(published.event.closesAt, published.event.timezone)
            : "the server-recorded close instant"}{" "}
          ({published?.event?.timezone ?? "event timezone"}). New draft creation and proposal edits
          are locked after close; the server enforces this saved status.
        </p>
      ) : null}
      {!published && saveState === "error" ? (
        <p className={styles.fieldError} role="alert">
          {saveError ?? "The published CFP could not be loaded. Refresh to try again."}
        </p>
      ) : null}
      <form
        ref={formRef}
        noValidate
        onSubmit={step === "welcome" ? undefined : (event) => onSubmit(event)}
      >
        {step === "welcome" ? (
          <WelcomeStep
            {...(published === null ? {} : { event: published.event, form: published.form })}
            closed={submissionsClosed}
          />
        ) : null}
        {step === "account" ? (
          <AccountStep
            accountMode={accountMode}
            authenticatedSession={authenticatedSession}
            confirmedApplicantContext={confirmedApplicantContext}
            draft={draft}
            errors={errors}
            onConfirmApplicantContext={onConfirmApplicantContext}
            password={password}
            pending={mutationPending}
            requiresApplicantContextConfirmation={requiresApplicantContextConfirmation}
            setAccountMode={setAccountMode}
            setPassword={setPassword}
            updateDraft={updateDraft}
            verificationState={verificationState}
            onUseDifferentEmail={onUseDifferentEmail}
          />
        ) : null}
        {step === "submission" ? (
          <SubmissionStep
            draft={draft}
            errors={errors}
            form={published.form}
            answers={dynamicAnswers}
            fileUploadStates={fileUploadStates}
            onAnswerChange={onSubmissionAnswer}
            onFileUploadStateChange={onFileUploadStateChange}
            onFileUpload={(field, file) => onFileUpload(field, undefined, file)}
            updateDraft={updateDraft}
          />
        ) : null}
        {step === "participants" ? (
          <ParticipantsStep
            draft={draft}
            errors={errors}
            {...(published === null ? {} : { form: published.form })}
            answers={participantAnswers}
            fileUploadStates={fileUploadStates}
            onAnswerChange={onParticipantAnswer}
            onFileUpload={(field, participantId, file) => onFileUpload(field, participantId, file)}
            onFileUploadStateChange={onFileUploadStateChange}
            updateDraft={updateDraft}
          />
        ) : null}
        {step === "review" ? (
          <ReviewStep
            draft={draft}
            eventSlug={eventSlug}
            fileUploadStates={fileUploadStates}
            organizationId={identity?.organizationId ?? ""}
            {...(published === null ? {} : { form: published.form })}
            answers={dynamicAnswers}
          />
        ) : null}

        <div
          className={`${styles.actions} ${
            step === "account" ? `${styles.accountActions} ${styles.actionsSingleSecondary}` : ""
          }`}
          data-cfp-actions="true"
        >
          {step !== "welcome" ? (
            <Button
              className={styles.backButton}
              disabled={mutationPending}
              onClick={onBack}
              type="button"
              variant="outline"
            >
              ← Back
            </Button>
          ) : (
            <span />
          )}
          <div className={styles.forwardActions}>
            {canSaveCfpDraftAtStep(step) ? (
              <Button
                className={styles.draftButton}
                onClick={onSaveNow}
                type="button"
                variant="secondary"
                disabled={mutationPending || submissionsClosed}
              >
                Save as draft
              </Button>
            ) : null}
            {!submissionsClosed && verificationState === null ? (
              step === "welcome" ? (
                <Button asChild className={styles.primaryButton}>
                  <Link href={accountHref}>Continue →</Link>
                </Button>
              ) : (
                <Button
                  className={styles.primaryButton}
                  disabled={
                    mutationPending ||
                    (step === "account" &&
                      requiresApplicantContextConfirmation &&
                      !confirmedApplicantContext)
                  }
                  type="submit"
                >
                  {step === "account"
                    ? mutationPending
                      ? authenticatedSession
                        ? "Continuing…"
                        : accountMode === "sign_in"
                          ? "Signing in…"
                          : "Creating account…"
                      : authenticatedSession
                        ? "Continue to proposal"
                        : accountMode === "sign_in"
                          ? "Sign in and continue"
                          : "Create account and continue"
                    : null}
                  {step === "submission" ? "Next step →" : null}
                  {step === "participants" ? "Continue to review →" : null}
                  {step === "review" ? "Submit" : null}
                </Button>
              )
            ) : null}
          </div>
        </div>
      </form>
      {step !== "welcome" &&
      step !== "account" &&
      (verificationState !== null || authenticatedSession !== null) ? (
        <div className={styles.sessionFooter} data-cfp-session-footer="true">
          {verificationState?.status === "waiting"
            ? `Verification email sent to ${verificationState.email}.`
            : verificationState?.status === "resuming"
              ? `Email verified for ${verificationState.email}. Continuing to your proposal…`
              : authenticatedSession
                ? `Signed in as ${authenticatedSession.name} (${authenticatedSession.email}).`
                : null}
        </div>
      ) : null}
      {step !== "welcome" ? (
        <>
          <p
            aria-live="polite"
            className={saveState === "error" ? styles.saveError : styles.saveStatus}
          >
            {saveState === "saving" ? "Saving draft…" : null}
            {saveState === "saved" ? "Draft saved" : null}
            {saveState === "error" && staleFormConflict === null
              ? (saveError ?? "Draft could not be saved. Check your connection and try again.")
              : null}
          </p>
          {pinnedDraftAuthenticationRequired ? (
            <Button onClick={onSwitchPinnedDraftAccount} type="button" variant="secondary">
              Sign out and switch account
            </Button>
          ) : null}
        </>
      ) : null}
    </PublicCfpShell>
  );
}
