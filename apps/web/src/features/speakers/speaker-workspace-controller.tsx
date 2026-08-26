"use client";
import { RefreshCw, UserPlus } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { StatusBadge, WorkspaceHeader } from "@/components/workspace";
import { Button } from "../../components/ui/button";
import {
  assertAdvancedSpeakerRevision,
  assertSpeakerHeadshotReplacement,
  assertSpeakerRosterScope,
  createSpeakerApi,
  ORGANIZER_HEADSHOT_ACCEPTED_TYPES,
  type SpeakerApi,
  SpeakerApiError,
  type SpeakerAsset,
  type SpeakerCreateInput,
  type SpeakerEmailPreview,
  type SpeakerEmailSend,
  type SpeakerEmailTemplate,
  type SpeakerImportPreview,
  type SpeakerInvitationPreview,
  type SpeakerInvitationResult,
  type SpeakerMutationStatus,
  type SpeakerProgressEnvelope,
  type SpeakerRecord,
  type SpeakerReminderEligibilityEnvelope,
  type SpeakerRosterEnvelope,
  type SpeakerSession,
  type SpeakerTaskEnvelope,
  type SpeakerTaskReminderOffsetsResult,
  type SpeakerUpdateInput,
} from "./api";
import {
  duplicateEmailConflicts,
  mergeProgressSummaries,
  mergeSpeaker,
  normalizeRoster,
  speakerMutationOutcomeUnknown,
  speakerProgressFor,
  speakerSecondaryLoadKey,
} from "./speaker-data-logic";
import {
  acceptedSpeakerSessions,
  type OrganizerHeadshotUploadStatus,
  organizerHeadshotPreviewPath,
  organizerHeadshotPreviewRequestKey,
  organizerHeadshotSessionId,
  validateOrganizerHeadshotFile,
} from "./speaker-headshot-logic";
import { FormMessage } from "./speaker-invitations";
import {
  editDraftFor,
  emptyCreateDraft,
  errorMessage,
  filterSpeakerRoster,
  filterSpeakersByAttention,
  type SpeakerAttentionFilter,
  speakerProgressMatches,
  withTimeout,
} from "./speaker-roster-logic";
import {
  createSpeakerTaskAssignment,
  retainInvitationHistory,
  type SpeakerOnboardingTaskDraft,
  socialLinksFor,
  speakerInvitationReady,
  speakerOnboardingTaskDefinitions,
  travelLogisticsFor,
  validateSpeakerTaskAssignment,
} from "./speaker-task-model";
import styles from "./speaker-workspace.module.css";
import { SpeakerAddDialog } from "./speaker-workspace-sections";
import {
  ASYNC_ACTION_TIMEOUT_MS,
  type CreateDraft,
  DEFAULT_STATUS_OPTIONS,
  type EditDraft,
  type ProgressFilter,
  SPEAKER_WELCOME_EMAIL_STARTER,
  type SpeakerInvitationHistoryEntry,
  type SpeakerWorkspaceProps,
} from "./speaker-workspace-types";
import { SpeakerWorkspaceViews } from "./speaker-workspace-views";

type SpeakerWorkspaceView = "roster" | "tasks" | "email";

type RosterScopeState = {
  activeView: SpeakerWorkspaceView;
  roster: SpeakerRosterEnvelope | null;
  progress: SpeakerProgressEnvelope | null;
  loading: boolean;
  error: string | null;
  progressError: string | null;
  notice: string | null;
  selectedId: string | null;
  selectedSpeakerIds: readonly string[];
  reminderEligibility: SpeakerReminderEligibilityEnvelope | null;
  secondarySectionsReady: boolean;
  visibleProgressContext: string | null;
  query: string;
  statusFilter: string;
  sessionFilter: string;
  progressFilter: ProgressFilter;
  attentionFilter: SpeakerAttentionFilter;
  filtersOpen: boolean;
  showAdd: boolean;
  showCsv: boolean;
};

type RosterScopeAction =
  | { type: "view-changed"; view: SpeakerWorkspaceView }
  | { type: "roster-scope-reset" }
  | { type: "api-error-set"; message: string }
  | { type: "notice-set"; message: string | null }
  | { type: "roster-load-started" }
  | { type: "roster-loaded"; roster: SpeakerRosterEnvelope }
  | {
      type: "roster-authoritative-applied";
      roster: SpeakerRosterEnvelope;
      message: string | undefined;
    }
  | { type: "roster-load-failed"; message: string; clearRoster: boolean }
  | { type: "loading-changed"; loading: boolean }
  | { type: "progress-load-started" }
  | { type: "progress-loaded"; progress: SpeakerProgressEnvelope }
  | {
      type: "progress-and-roster-loaded";
      roster: SpeakerRosterEnvelope;
      progress: SpeakerProgressEnvelope;
    }
  | { type: "progress-load-failed"; message: string }
  | { type: "reminder-loaded"; eligibility: SpeakerReminderEligibilityEnvelope }
  | { type: "task-reminder-version-updated"; taskId: string; version: number }
  | {
      type: "roster-details-refreshed";
      participantId: string;
      sessions: readonly SpeakerSession[];
      assets: readonly SpeakerAsset[];
      updatedAt: string;
    }
  | {
      type: "tasks-assigned";
      taskEnvelope: SpeakerTaskEnvelope;
      fallbackRows: SpeakerProgressEnvelope["rows"];
    }
  | { type: "selected-id-changed"; participantId: string | null }
  | { type: "selection-toggled"; participantId: string }
  | { type: "visible-selection-toggled"; participantIds: readonly string[] }
  | { type: "selection-set"; participantIds: readonly string[] }
  | { type: "query-changed"; query: string }
  | { type: "status-filter-changed"; status: string }
  | { type: "session-filter-changed"; session: string }
  | { type: "progress-filter-changed"; progress: ProgressFilter }
  | { type: "attention-filter-changed"; attention: SpeakerAttentionFilter }
  | { type: "filters-cleared" }
  | { type: "filters-toggled" }
  | { type: "add-dialog-changed"; open: boolean }
  | { type: "csv-dialog-changed"; open: boolean }
  | { type: "csv-dialog-toggled" }
  | { type: "secondary-ready" }
  | { type: "progress-context-changed"; context: string };

const INITIAL_ROSTER_SCOPE_STATE: RosterScopeState = {
  activeView: "roster",
  roster: null,
  progress: null,
  loading: true,
  error: null,
  progressError: null,
  notice: null,
  selectedId: null,
  selectedSpeakerIds: [],
  reminderEligibility: null,
  secondarySectionsReady: false,
  visibleProgressContext: null,
  query: "",
  statusFilter: "all",
  sessionFilter: "all",
  progressFilter: "all",
  attentionFilter: "all",
  filtersOpen: false,
  showAdd: false,
  showCsv: false,
};

function rosterSelectionFor(
  state: RosterScopeState,
  roster: SpeakerRosterEnvelope,
): Pick<RosterScopeState, "selectedId" | "selectedSpeakerIds"> {
  const participantIds = new Set(roster.speakers.map((speaker) => speaker.participantId));
  const selectedSpeakerIds = state.selectedSpeakerIds.filter((participantId) =>
    participantIds.has(participantId),
  );
  const selectedId =
    state.selectedId !== null && participantIds.has(state.selectedId) ? state.selectedId : null;
  return { selectedId, selectedSpeakerIds };
}

function rosterScopeReducer(state: RosterScopeState, action: RosterScopeAction): RosterScopeState {
  switch (action.type) {
    case "view-changed":
      return { ...state, activeView: action.view };
    case "roster-scope-reset":
      return {
        ...state,
        roster: null,
        progress: null,
        loading: true,
        error: null,
        progressError: null,
        selectedId: null,
        selectedSpeakerIds: [],
      };
    case "api-error-set":
      return { ...state, error: action.message };
    case "notice-set":
      return { ...state, notice: action.message };
    case "roster-load-started":
      return { ...state, loading: true, error: null, progressError: null, progress: null };
    case "roster-loaded":
      return {
        ...state,
        roster: action.roster,
        loading: false,
        ...rosterSelectionFor(state, action.roster),
      };
    case "roster-authoritative-applied":
      return {
        ...state,
        roster: action.roster,
        loading: false,
        error: null,
        progressError: null,
        progress: null,
        ...rosterSelectionFor(state, action.roster),
        notice: action.message ?? state.notice,
      };
    case "roster-load-failed":
      return action.clearRoster
        ? {
            ...state,
            roster: null,
            progress: null,
            selectedId: null,
            selectedSpeakerIds: [],
            error: action.message,
          }
        : { ...state, error: action.message };
    case "loading-changed":
      return { ...state, loading: action.loading };
    case "progress-load-started":
      return { ...state, progressError: null };
    case "progress-loaded":
      return {
        ...state,
        progress: action.progress,
        roster:
          state.roster === null ? null : mergeProgressSummaries(state.roster, action.progress),
      };
    case "progress-and-roster-loaded":
      return {
        ...state,
        roster: action.roster,
        progress: action.progress,
        progressError: null,
      };
    case "progress-load-failed":
      return { ...state, progress: null, progressError: action.message };
    case "reminder-loaded":
      return { ...state, reminderEligibility: action.eligibility };
    case "task-reminder-version-updated":
      return {
        ...state,
        progress:
          state.progress === null
            ? null
            : {
                ...state.progress,
                rows: state.progress.rows.map((row) => ({
                  ...row,
                  tasks: row.tasks.map((task) =>
                    task.taskId === action.taskId ? { ...task, version: action.version } : task,
                  ),
                })),
              },
      };
    case "roster-details-refreshed":
      return {
        ...state,
        roster:
          state.roster === null
            ? null
            : mergeSpeaker(state.roster, action.participantId, {
                sessions: action.sessions,
                assets: action.assets,
                updatedAt: action.updatedAt,
              }),
      };
    case "tasks-assigned": {
      const tasks = action.taskEnvelope.tasks;
      const roster =
        state.roster === null
          ? null
          : {
              ...state.roster,
              speakers: state.roster.speakers.map((speaker) => {
                const added = tasks.filter(
                  (task) => task.participantId === speaker.participantId,
                ).length;
                return added === 0
                  ? speaker
                  : {
                      ...speaker,
                      taskSummary: {
                        ...speaker.taskSummary,
                        total: speaker.taskSummary.total + added,
                      },
                    };
              }),
            };
      const rows =
        state.progress?.rows ??
        action.fallbackRows.map((row) => ({
          participantId: row.participantId,
          displayName: row.displayName,
          tasks: row.tasks,
        }));
      const progress: SpeakerProgressEnvelope = {
        organizationId: action.taskEnvelope.organizationId,
        eventId: action.taskEnvelope.eventId,
        rows: rows.map((row) => {
          const assigned = tasks.filter((task) => task.participantId === row.participantId);
          return assigned.length === 0 ? row : { ...row, tasks: [...row.tasks, ...assigned] };
        }),
      };
      return { ...state, roster, progress };
    }
    case "selected-id-changed":
      return { ...state, selectedId: action.participantId };
    case "selection-toggled":
      return {
        ...state,
        selectedSpeakerIds: state.selectedSpeakerIds.includes(action.participantId)
          ? state.selectedSpeakerIds.filter((candidate) => candidate !== action.participantId)
          : [...state.selectedSpeakerIds, action.participantId],
      };
    case "visible-selection-toggled": {
      const visibleIdSet = new Set(action.participantIds);
      const selectedSpeakerIdSet = new Set(state.selectedSpeakerIds);
      const allVisibleSelected =
        action.participantIds.length > 0 &&
        action.participantIds.every((participantId) => selectedSpeakerIdSet.has(participantId));
      return {
        ...state,
        selectedSpeakerIds: allVisibleSelected
          ? state.selectedSpeakerIds.filter((participantId) => !visibleIdSet.has(participantId))
          : [...new Set([...state.selectedSpeakerIds, ...action.participantIds])],
      };
    }
    case "selection-set":
      return { ...state, selectedSpeakerIds: action.participantIds };
    case "query-changed":
      return { ...state, query: action.query };
    case "status-filter-changed":
      return { ...state, statusFilter: action.status };
    case "session-filter-changed":
      return { ...state, sessionFilter: action.session };
    case "progress-filter-changed":
      return { ...state, progressFilter: action.progress };
    case "attention-filter-changed":
      return { ...state, attentionFilter: action.attention };
    case "filters-cleared":
      return {
        ...state,
        query: "",
        statusFilter: "all",
        sessionFilter: "all",
        progressFilter: "all",
        attentionFilter: "all",
      };
    case "filters-toggled":
      return { ...state, filtersOpen: !state.filtersOpen };
    case "add-dialog-changed":
      return { ...state, showAdd: action.open };
    case "csv-dialog-changed":
      return { ...state, showCsv: action.open };
    case "csv-dialog-toggled":
      return { ...state, showCsv: !state.showCsv };
    case "secondary-ready":
      return { ...state, secondarySectionsReady: true };
    case "progress-context-changed":
      return { ...state, visibleProgressContext: action.context };
  }
}

type EmailState = {
  emailTemplates: readonly SpeakerEmailTemplate[];
  emailTemplateId: string;
  emailTemplateVersion: number | undefined;
  emailTemplateName: string;
  emailSubject: string;
  emailHtml: string;
  emailText: string;
  emailPreview: SpeakerEmailPreview | null;
  emailEditorMode: "visual" | "html" | "text";
  emailConfirmOpen: boolean;
  emailSends: readonly SpeakerEmailSend[];
  emailSaveBusy: boolean;
  emailPreviewBusy: boolean;
  emailSendBusy: boolean;
  emailHistoryBusy: boolean;
  emailNotice: string | null;
};

type EmailAction =
  | { type: "email-templates-loaded"; templates: readonly SpeakerEmailTemplate[] }
  | {
      type: "email-template-selected";
      id: string;
      version: number | undefined;
      template: SpeakerEmailTemplate | null;
    }
  | { type: "email-template-created"; template: SpeakerEmailTemplate }
  | { type: "email-template-saved"; template: SpeakerEmailTemplate }
  | { type: "email-template-name-changed"; name: string }
  | { type: "email-subject-changed"; subject: string }
  | { type: "email-html-changed"; html: string }
  | { type: "email-text-changed"; text: string }
  | { type: "email-editor-mode-changed"; mode: "visual" | "html" | "text" }
  | { type: "email-preview-invalidated" }
  | { type: "email-preview-started" }
  | { type: "email-preview-set"; preview: SpeakerEmailPreview }
  | { type: "email-sends-loaded"; sends: readonly SpeakerEmailSend[] }
  | { type: "email-send-recorded"; send: SpeakerEmailSend }
  | { type: "email-save-busy-changed"; busy: boolean }
  | { type: "email-preview-busy-changed"; busy: boolean }
  | { type: "email-send-busy-changed"; busy: boolean }
  | { type: "email-history-busy-changed"; busy: boolean }
  | { type: "email-notice-set"; message: string | null }
  | { type: "email-confirm-changed"; open: boolean };

const INITIAL_EMAIL_STATE: EmailState = {
  emailTemplates: [],
  emailTemplateId: "",
  emailTemplateVersion: undefined,
  emailTemplateName: "New speaker message",
  emailSubject: "",
  emailHtml: "",
  emailText: "",
  emailPreview: null,
  emailEditorMode: "visual",
  emailConfirmOpen: false,
  emailSends: [],
  emailSaveBusy: false,
  emailPreviewBusy: false,
  emailSendBusy: false,
  emailHistoryBusy: false,
  emailNotice: null,
};

function emailReducer(state: EmailState, action: EmailAction): EmailState {
  switch (action.type) {
    case "email-templates-loaded": {
      const templates = action.templates;
      const latest = templates
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      return latest === undefined
        ? { ...state, emailTemplates: templates }
        : {
            ...state,
            emailTemplates: templates,
            emailTemplateId: latest.id,
            emailTemplateVersion: latest.version,
            emailTemplateName: latest.name,
            emailSubject: latest.subject,
            emailHtml: latest.html,
            emailText: latest.text,
          };
    }
    case "email-template-selected":
      return action.template === null
        ? {
            ...state,
            emailTemplateId: action.id,
            emailTemplateVersion: action.version,
          }
        : {
            ...state,
            emailTemplateId: action.id,
            emailTemplateVersion: action.version,
            emailTemplateName: action.template.name,
            emailSubject: action.template.subject,
            emailHtml: action.template.html,
            emailText: action.template.text,
          };
    case "email-template-created":
    case "email-template-saved":
      return {
        ...state,
        emailTemplates: [
          ...state.emailTemplates.filter(
            (candidate) =>
              !(
                candidate.id === action.template.id && candidate.version === action.template.version
              ),
          ),
          action.template,
        ],
        emailTemplateId: action.template.id,
        emailTemplateVersion: action.template.version,
        emailTemplateName: action.template.name,
        emailSubject: action.template.subject,
        emailHtml: action.template.html,
        emailText: action.template.text,
      };
    case "email-template-name-changed":
      return { ...state, emailTemplateName: action.name };
    case "email-subject-changed":
      return { ...state, emailSubject: action.subject };
    case "email-html-changed":
      return { ...state, emailHtml: action.html };
    case "email-text-changed":
      return { ...state, emailText: action.text };
    case "email-editor-mode-changed":
      return { ...state, emailEditorMode: action.mode };
    case "email-preview-invalidated":
      return { ...state, emailPreview: null, emailConfirmOpen: false, emailPreviewBusy: false };
    case "email-preview-started":
      return { ...state, emailPreviewBusy: true };
    case "email-preview-set":
      return { ...state, emailPreview: action.preview };
    case "email-sends-loaded":
      return { ...state, emailSends: action.sends };
    case "email-send-recorded":
      return {
        ...state,
        emailSends: [
          action.send,
          ...state.emailSends.filter((candidate) => candidate.id !== action.send.id),
        ],
      };
    case "email-save-busy-changed":
      return { ...state, emailSaveBusy: action.busy };
    case "email-preview-busy-changed":
      return { ...state, emailPreviewBusy: action.busy };
    case "email-send-busy-changed":
      return { ...state, emailSendBusy: action.busy };
    case "email-history-busy-changed":
      return { ...state, emailHistoryBusy: action.busy };
    case "email-notice-set":
      return { ...state, emailNotice: action.message };
    case "email-confirm-changed":
      return { ...state, emailConfirmOpen: action.open };
  }
}

type ImportTaskInvitationState = {
  importPreview: SpeakerImportPreview | null;
  importFileName: string | null;
  taskTitle: string;
  taskDueAt: string;
  taskAssignees: readonly string[];
  invitationPreview: readonly SpeakerInvitationPreview[] | null;
  invitationResult: SpeakerInvitationResult | null;
  invitationResultParticipantId: string | null;
  invitationError: string | null;
  invitationHistory: readonly SpeakerInvitationHistoryEntry[];
  invitationPreviewBusy: boolean;
  invitationSendBusy: boolean;
  importPreviewBusy: boolean;
  importCommitBusy: boolean;
  taskBusy: boolean;
};

type ImportTaskInvitationAction =
  | { type: "invitation-cleared" }
  | { type: "invitation-preview-started" }
  | { type: "invitation-preview-loaded"; preview: readonly SpeakerInvitationPreview[] }
  | { type: "invitation-preview-failed"; message: string }
  | { type: "invitation-preview-busy-changed"; busy: boolean }
  | { type: "invitation-send-started" }
  | { type: "invitation-result-recorded"; participantId: string; result: SpeakerInvitationResult }
  | {
      type: "invitation-history-retained";
      preview: readonly SpeakerInvitationPreview[];
      result: SpeakerInvitationResult;
    }
  | { type: "invitation-send-busy-changed"; busy: boolean }
  | { type: "invitation-error-set"; message: string | null }
  | { type: "import-preview-started"; fileName: string }
  | { type: "import-preview-loaded"; preview: SpeakerImportPreview }
  | { type: "import-preview-cleared" }
  | { type: "import-preview-busy-changed"; busy: boolean }
  | { type: "import-committed" }
  | { type: "import-commit-busy-changed"; busy: boolean }
  | { type: "task-title-changed"; title: string }
  | { type: "task-due-changed"; dueAt: string }
  | { type: "task-assignee-toggled"; participantId: string }
  | { type: "task-fields-cleared" }
  | { type: "task-busy-changed"; busy: boolean };

const INITIAL_IMPORT_TASK_INVITATION_STATE: ImportTaskInvitationState = {
  importPreview: null,
  importFileName: null,
  taskTitle: "",
  taskDueAt: "",
  taskAssignees: [],
  invitationPreview: null,
  invitationResult: null,
  invitationResultParticipantId: null,
  invitationError: null,
  invitationHistory: [],
  invitationPreviewBusy: false,
  invitationSendBusy: false,
  importPreviewBusy: false,
  importCommitBusy: false,
  taskBusy: false,
};

function importTaskInvitationReducer(
  state: ImportTaskInvitationState,
  action: ImportTaskInvitationAction,
): ImportTaskInvitationState {
  switch (action.type) {
    case "invitation-cleared":
      return {
        ...state,
        invitationPreview: null,
        invitationResult: null,
        invitationResultParticipantId: null,
        invitationError: null,
      };
    case "invitation-preview-started":
      return {
        ...state,
        invitationPreview: null,
        invitationResult: null,
        invitationResultParticipantId: null,
        invitationError: null,
        invitationPreviewBusy: true,
      };
    case "invitation-preview-loaded":
      return { ...state, invitationPreview: action.preview };
    case "invitation-preview-failed":
      return { ...state, invitationError: action.message };
    case "invitation-preview-busy-changed":
      return { ...state, invitationPreviewBusy: action.busy };
    case "invitation-send-started":
      return {
        ...state,
        invitationResult: null,
        invitationResultParticipantId: null,
        invitationError: null,
        invitationSendBusy: true,
      };
    case "invitation-result-recorded":
      return {
        ...state,
        invitationResult: action.result,
        invitationResultParticipantId: action.participantId,
      };
    case "invitation-history-retained":
      return {
        ...state,
        invitationHistory: retainInvitationHistory(
          state.invitationHistory,
          action.preview,
          action.result,
        ),
      };
    case "invitation-send-busy-changed":
      return { ...state, invitationSendBusy: action.busy };
    case "invitation-error-set":
      return { ...state, invitationError: action.message };
    case "import-preview-started":
      return {
        ...state,
        importFileName: action.fileName,
        importPreview: null,
        importPreviewBusy: true,
      };
    case "import-preview-loaded":
      return { ...state, importPreview: action.preview };
    case "import-preview-cleared":
      return { ...state, importPreview: null, importFileName: null };
    case "import-preview-busy-changed":
      return { ...state, importPreviewBusy: action.busy };
    case "import-committed":
      return { ...state, importPreview: null, importFileName: null };
    case "import-commit-busy-changed":
      return { ...state, importCommitBusy: action.busy };
    case "task-title-changed":
      return { ...state, taskTitle: action.title };
    case "task-due-changed":
      return { ...state, taskDueAt: action.dueAt };
    case "task-assignee-toggled":
      return {
        ...state,
        taskAssignees: state.taskAssignees.includes(action.participantId)
          ? state.taskAssignees.filter((candidate) => candidate !== action.participantId)
          : [...state.taskAssignees, action.participantId],
      };
    case "task-fields-cleared":
      return { ...state, taskTitle: "", taskDueAt: "", taskAssignees: [] };
    case "task-busy-changed":
      return { ...state, taskBusy: action.busy };
  }
}

type ProfileHeadshotDetailsState = {
  createDraft: CreateDraft;
  editDraft: EditDraft | null;
  editError: string | null;
  detailBusy: boolean;
  detailNotice: string | null;
  headshotUploadStatus: OrganizerHeadshotUploadStatus;
  headshotUploadMessage: string | null;
  headshotSessionId: string | null;
  headshotPreviewUrl: string | null;
  headshotPreviewError: string | null;
  headshotPreviewLoading: boolean;
  headshotPreviewRevision: number;
  headshotPreviewRetry: number;
  headshotAssetsByParticipant: Readonly<Record<string, SpeakerAsset>>;
  downloadErrors: Readonly<Record<string, string>>;
  downloadBusyAssetId: string | null;
  saveBusy: boolean;
  profileMutationStatus: SpeakerMutationStatus;
  profileMutationMessage: string | null;
  headshotMutationStatus: SpeakerMutationStatus;
  headshotMutationMessage: string | null;
};

type ProfileHeadshotDetailsAction =
  | { type: "profile-scope-reset" }
  | { type: "create-draft-updated"; field: keyof CreateDraft; value: string | boolean }
  | { type: "create-draft-reset" }
  | { type: "edit-started"; draft: EditDraft }
  | { type: "edit-draft-set"; draft: EditDraft }
  | { type: "edit-draft-updated"; field: keyof CreateDraft; value: string | boolean }
  | { type: "edit-error-set"; message: string | null }
  | { type: "detail-busy-changed"; busy: boolean }
  | { type: "detail-notice-set"; message: string | null }
  | { type: "headshot-session-selected"; sessionId: string | null }
  | {
      type: "headshot-upload-state-changed";
      status: OrganizerHeadshotUploadStatus;
      message: string | null;
    }
  | {
      type: "headshot-mutation-state-changed";
      status: SpeakerMutationStatus;
      message: string | null;
    }
  | {
      type: "profile-mutation-state-changed";
      status: SpeakerMutationStatus;
      message: string | null;
    }
  | { type: "headshot-preview-cleared" }
  | { type: "headshot-preview-started" }
  | { type: "headshot-preview-ready"; url: string }
  | { type: "headshot-preview-error"; message: string }
  | { type: "headshot-preview-finished" }
  | { type: "headshot-preview-retried" }
  | { type: "headshot-preview-marked-failed" }
  | { type: "headshot-asset-linked"; participantId: string; asset: SpeakerAsset }
  | { type: "download-started"; assetId: string }
  | { type: "download-failed"; assetId: string; message: string }
  | { type: "download-finished"; assetId: string }
  | { type: "save-busy-changed"; busy: boolean }
  | { type: "profile-validation-failed"; message: string }
  | { type: "profile-save-started" }
  | { type: "profile-write-accepted" }
  | { type: "profile-saved"; speaker: SpeakerRecord; eventTimeZone?: string }
  | { type: "profile-conflict" }
  | { type: "profile-failed"; message: string }
  | { type: "headshot-validation-failed"; message: string }
  | { type: "headshot-unavailable"; message: string }
  | { type: "headshot-session-required"; message: string }
  | { type: "headshot-upload-started"; fileName: string }
  | { type: "headshot-write-accepted" }
  | { type: "headshot-upload-succeeded"; speaker: SpeakerRecord; eventTimeZone?: string }
  | { type: "headshot-conflict" }
  | { type: "headshot-failed"; message: string };

const INITIAL_PROFILE_HEADSHOT_DETAILS_STATE: ProfileHeadshotDetailsState = {
  createDraft: emptyCreateDraft(),
  editDraft: null,
  editError: null,
  detailBusy: false,
  detailNotice: null,
  headshotUploadStatus: "idle",
  headshotUploadMessage: null,
  headshotSessionId: null,
  headshotPreviewUrl: null,
  headshotPreviewError: null,
  headshotPreviewLoading: false,
  headshotPreviewRevision: 0,
  headshotPreviewRetry: 0,
  headshotAssetsByParticipant: {},
  downloadErrors: {},
  downloadBusyAssetId: null,
  saveBusy: false,
  profileMutationStatus: "idle",
  profileMutationMessage: null,
  headshotMutationStatus: "idle",
  headshotMutationMessage: null,
};

function profileHeadshotDetailsReducer(
  state: ProfileHeadshotDetailsState,
  action: ProfileHeadshotDetailsAction,
): ProfileHeadshotDetailsState {
  switch (action.type) {
    case "profile-scope-reset":
      return {
        ...state,
        editDraft: null,
        editError: null,
        detailNotice: null,
        headshotAssetsByParticipant: {},
        downloadErrors: {},
        profileMutationStatus: "idle",
        profileMutationMessage: null,
        headshotMutationStatus: "idle",
        headshotMutationMessage: null,
        headshotUploadStatus: "idle",
        headshotUploadMessage: null,
      };
    case "create-draft-updated":
      return {
        ...state,
        createDraft: { ...state.createDraft, [action.field]: action.value } as CreateDraft,
      };
    case "create-draft-reset":
      return { ...state, createDraft: emptyCreateDraft() };
    case "edit-started":
      return {
        ...state,
        editDraft: action.draft,
        editError: null,
        profileMutationStatus: "idle",
        profileMutationMessage: null,
        detailNotice: null,
      };
    case "edit-draft-set":
      return { ...state, editDraft: action.draft };
    case "edit-draft-updated":
      return {
        ...state,
        editDraft:
          state.editDraft === null
            ? null
            : ({ ...state.editDraft, [action.field]: action.value } as EditDraft),
      };
    case "edit-error-set":
      return { ...state, editError: action.message };
    case "detail-busy-changed":
      return { ...state, detailBusy: action.busy };
    case "detail-notice-set":
      return { ...state, detailNotice: action.message };
    case "headshot-session-selected":
      return {
        ...state,
        headshotSessionId: action.sessionId,
        headshotUploadStatus: "idle",
        headshotUploadMessage: null,
      };
    case "headshot-upload-state-changed":
      return {
        ...state,
        headshotUploadStatus: action.status,
        headshotUploadMessage: action.message,
      };
    case "headshot-mutation-state-changed":
      return {
        ...state,
        headshotMutationStatus: action.status,
        headshotMutationMessage: action.message,
      };
    case "profile-mutation-state-changed":
      return {
        ...state,
        profileMutationStatus: action.status,
        profileMutationMessage: action.message,
      };
    case "headshot-preview-cleared":
      return {
        ...state,
        headshotPreviewUrl: null,
        headshotPreviewError: null,
        headshotPreviewLoading: false,
      };
    case "headshot-preview-started":
      return {
        ...state,
        headshotPreviewUrl: null,
        headshotPreviewError: null,
        headshotPreviewLoading: true,
      };
    case "headshot-preview-ready":
      return {
        ...state,
        headshotPreviewUrl: action.url,
        headshotPreviewRevision: state.headshotPreviewRevision + 1,
      };
    case "headshot-preview-error":
      return { ...state, headshotPreviewError: action.message };
    case "headshot-preview-finished":
      return { ...state, headshotPreviewLoading: false };
    case "headshot-preview-retried":
      return { ...state, headshotPreviewRetry: state.headshotPreviewRetry + 1 };
    case "headshot-preview-marked-failed":
      return {
        ...state,
        headshotPreviewUrl: null,
        headshotPreviewLoading: false,
        headshotPreviewError: "The secure headshot preview could not be rendered.",
      };
    case "headshot-asset-linked":
      return {
        ...state,
        headshotAssetsByParticipant: {
          ...state.headshotAssetsByParticipant,
          [action.participantId]: action.asset,
        },
      };
    case "download-started": {
      const { [action.assetId]: _previousError, ...remaining } = state.downloadErrors;
      return { ...state, downloadBusyAssetId: action.assetId, downloadErrors: remaining };
    }
    case "download-failed":
      return {
        ...state,
        downloadErrors: { ...state.downloadErrors, [action.assetId]: action.message },
      };
    case "download-finished":
      return {
        ...state,
        downloadBusyAssetId:
          state.downloadBusyAssetId === action.assetId ? null : state.downloadBusyAssetId,
      };
    case "save-busy-changed":
      return { ...state, saveBusy: action.busy };
    case "profile-validation-failed":
      return {
        ...state,
        editError: action.message,
        profileMutationStatus: "failure",
        profileMutationMessage: action.message,
      };
    case "profile-save-started":
      return {
        ...state,
        saveBusy: true,
        profileMutationStatus: "saving",
        profileMutationMessage: "Saving speaker profile…",
        editError: null,
      };
    case "profile-write-accepted":
      return {
        ...state,
        profileMutationStatus: "pending",
        profileMutationMessage: "Profile write accepted. Applying authoritative speaker data…",
      };
    case "profile-saved":
      return {
        ...state,
        editDraft: editDraftFor(action.speaker, action.eventTimeZone),
        profileMutationStatus: "saved",
        profileMutationMessage: `Saved at revision ${action.speaker.version}.`,
      };
    case "profile-conflict":
      return {
        ...state,
        profileMutationStatus: "conflict",
        profileMutationMessage: "Conflict detected. Authoritative speaker data was reloaded.",
      };
    case "profile-failed":
      return {
        ...state,
        profileMutationStatus: "failure",
        profileMutationMessage: action.message,
        editError: action.message,
      };
    case "headshot-validation-failed":
    case "headshot-unavailable":
      return {
        ...state,
        headshotUploadStatus: "error",
        headshotUploadMessage: action.message,
        headshotMutationStatus: "failure",
        headshotMutationMessage: action.message,
      };
    case "headshot-session-required":
      return { ...state, headshotUploadStatus: "error", headshotUploadMessage: action.message };
    case "headshot-upload-started":
      return {
        ...state,
        headshotUploadStatus: "busy",
        headshotMutationStatus: "saving",
        headshotMutationMessage: `Uploading ${action.fileName}…`,
        headshotUploadMessage: `Uploading ${action.fileName}…`,
      };
    case "headshot-write-accepted":
      return {
        ...state,
        headshotMutationStatus: "pending",
        headshotMutationMessage: "Headshot write accepted. Reloading authoritative speaker data…",
        headshotUploadMessage: "Upload accepted. Reloading speaker data…",
      };
    case "headshot-upload-succeeded":
      return {
        ...state,
        editDraft: editDraftFor(action.speaker, action.eventTimeZone),
        headshotPreviewUrl: null,
        headshotPreviewError: null,
        headshotPreviewRevision: state.headshotPreviewRevision + 1,
        headshotUploadStatus: "success",
        headshotMutationStatus: "saved",
        headshotMutationMessage: `Saved at revision ${action.speaker.version}.`,
        headshotUploadMessage: `Headshot uploaded for ${action.speaker.displayName}.`,
      };
    case "headshot-conflict":
      return {
        ...state,
        headshotMutationStatus: "conflict",
        headshotMutationMessage: "Conflict detected. Authoritative speaker data was reloaded.",
        headshotUploadStatus: "error",
        headshotUploadMessage: "Headshot upload conflicted; review the reloaded speaker data.",
      };
    case "headshot-failed":
      return {
        ...state,
        headshotMutationStatus: "failure",
        headshotMutationMessage: action.message,
        headshotUploadStatus: "error",
        headshotUploadMessage: action.message,
      };
  }
}

function useSpeakerWorkspaceController({
  organizationId,
  eventId,
  api: providedApi,
}: SpeakerWorkspaceProps) {
  const apiResolution = useMemo(() => {
    if (providedApi !== undefined) return { api: providedApi, error: null };
    try {
      return { api: createSpeakerApi("", organizationId, eventId), error: null };
    } catch (reason: unknown) {
      return { api: null, error: errorMessage(reason) };
    }
  }, [eventId, organizationId, providedApi]);
  const api = apiResolution.api;
  const [rosterState, dispatchRoster] = useReducer(rosterScopeReducer, INITIAL_ROSTER_SCOPE_STATE);
  const {
    activeView,
    roster,
    progress,
    loading,
    error,
    progressError,
    notice,
    selectedId,
    selectedSpeakerIds,
    reminderEligibility,
    secondarySectionsReady,
    visibleProgressContext,
    query,
    statusFilter,
    sessionFilter,
    progressFilter,
    attentionFilter,
    filtersOpen,
    showAdd,
    showCsv,
  } = rosterState;
  const [emailState, dispatchEmail] = useReducer(emailReducer, INITIAL_EMAIL_STATE);
  const {
    emailTemplates,
    emailTemplateId,
    emailTemplateVersion,
    emailTemplateName,
    emailSubject,
    emailHtml,
    emailText,
    emailPreview,
    emailEditorMode,
    emailConfirmOpen,
    emailSends,
    emailSaveBusy,
    emailPreviewBusy,
    emailSendBusy,
    emailHistoryBusy,
    emailNotice,
  } = emailState;
  const [importTaskInvitationState, dispatchImportTaskInvitation] = useReducer(
    importTaskInvitationReducer,
    INITIAL_IMPORT_TASK_INVITATION_STATE,
  );
  const {
    importPreview,
    importFileName,
    taskTitle,
    taskDueAt,
    taskAssignees,
    invitationPreview,
    invitationResult,
    invitationResultParticipantId,
    invitationError,
    invitationHistory,
    invitationPreviewBusy,
    invitationSendBusy,
    importPreviewBusy,
    importCommitBusy,
    taskBusy,
  } = importTaskInvitationState;
  const [profileHeadshotDetailsState, dispatchProfileHeadshotDetails] = useReducer(
    profileHeadshotDetailsReducer,
    INITIAL_PROFILE_HEADSHOT_DETAILS_STATE,
  );
  const {
    createDraft,
    editDraft,
    editError,
    detailBusy,
    detailNotice,
    headshotUploadStatus,
    headshotUploadMessage,
    headshotSessionId,
    headshotPreviewUrl,
    headshotPreviewError,
    headshotPreviewLoading,
    headshotPreviewRevision,
    headshotPreviewRetry,
    headshotAssetsByParticipant,
    downloadErrors,
    downloadBusyAssetId,
    saveBusy,
    profileMutationStatus,
    profileMutationMessage,
    headshotMutationStatus,
    headshotMutationMessage,
  } = profileHeadshotDetailsState;
  const emailSendIdempotencyKeyRef = useRef<string | null>(null);
  const emailCreateTemplateIdRef = useRef<string | null>(null);
  const createIdempotencyKeyRef = useRef<string | null>(null);
  const importIdempotencyKeyRef = useRef<string | null>(null);
  const invitationSendIdempotencyKeyRef = useRef<string | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const rosterRequestRef = useRef(0);
  const headshotRequestRef = useRef(0);
  const headshotPreviewKeyRef = useRef<string | null>(null);
  const headshotPreviewApiRef = useRef<SpeakerApi | null>(null);
  const headshotPreviewRequestDataRef = useRef<{
    participantId: string | undefined;
    assetId: string | null | undefined;
    asset: SpeakerAsset | null;
  }>({ participantId: undefined, assetId: undefined, asset: null });
  const secondarySectionsReadyKeyRef = useRef<string | null>(null);
  const importRequestRef = useRef(0);
  const emailSelectionSnapshotRef = useRef<string | null>(null);
  useEffect(() => {
    if (organizationId.length === 0 || eventId.length === 0) return;
    rosterRequestRef.current += 1;
    dispatchRoster({ type: "roster-scope-reset" });
    dispatchProfileHeadshotDetails({ type: "profile-scope-reset" });
    secondaryLoadRef.current = null;
    progressLoadRef.current = null;
  }, [eventId, organizationId]);
  const emailPreviewRequestRef = useRef(0);
  const secondaryLoadRef = useRef<{ api: SpeakerApi; key: string } | null>(null);
  const progressLoadRef = useRef<{ api: SpeakerApi; key: string; requestId: number } | null>(null);
  const emailSectionRef = useRef<HTMLDivElement | null>(null);
  const reminderSectionRef = useRef<HTMLDivElement | null>(null);
  const importBusy = importPreviewBusy || importCommitBusy;
  useEffect(() => {
    if (apiResolution.error !== null) {
      dispatchRoster({ type: "api-error-set", message: apiResolution.error });
    }
  }, [apiResolution.error]);
  useEffect(() => {
    if (api === null) {
      dispatchRoster({ type: "loading-changed", loading: false });
      return;
    }
    const requestId = rosterRequestRef.current + 1;
    rosterRequestRef.current = requestId;
    const controller = new AbortController();
    let active = true;
    let rosterTimedOut = false;
    const rosterTimeout = setTimeout(() => {
      rosterTimedOut = true;
      controller.abort();
    }, ASYNC_ACTION_TIMEOUT_MS);
    dispatchRoster({ type: "roster-load-started" });
    dispatchImportTaskInvitation({ type: "invitation-cleared" });
    invitationSendIdempotencyKeyRef.current = null;
    void api
      .list(controller.signal)
      .then((nextRoster) => {
        const normalizedRoster = normalizeRoster(nextRoster, organizationId, eventId);
        if (!active || requestId !== rosterRequestRef.current) return;
        dispatchRoster({ type: "roster-loaded", roster: normalizedRoster });
      })
      .catch((reason: unknown) => {
        if (!active || requestId !== rosterRequestRef.current) return;
        dispatchRoster({
          type: "roster-load-failed",
          message: rosterTimedOut
            ? "Speaker roster refresh timed out. Try again."
            : errorMessage(reason),
          clearRoster: true,
        });
      })
      .finally(() => {
        clearTimeout(rosterTimeout);
        if (active && requestId === rosterRequestRef.current) {
          dispatchRoster({ type: "loading-changed", loading: false });
        }
      });
    return () => {
      active = false;
      controller.abort();
      clearTimeout(rosterTimeout);
    };
  }, [api, eventId, organizationId]);
  const secondaryContextKey = `${organizationId}:${eventId}`;
  const progressSectionVisible =
    activeView === "tasks" || visibleProgressContext === secondaryContextKey;
  useEffect(() => {
    if (
      api === null ||
      roster === null ||
      loading ||
      roster.speakers.length === 0 ||
      !progressSectionVisible ||
      roster.organizationId !== organizationId ||
      roster.eventId !== eventId
    ) {
      return;
    }
    const requestId = rosterRequestRef.current;
    const currentRequest = progressLoadRef.current;
    if (
      currentRequest?.api === api &&
      currentRequest.key === secondaryContextKey &&
      currentRequest.requestId === requestId
    ) {
      return;
    }
    const request = { api, key: secondaryContextKey, requestId };
    progressLoadRef.current = request;
    const controller = new AbortController();
    let active = true;
    let settled = false;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ASYNC_ACTION_TIMEOUT_MS);
    dispatchRoster({ type: "progress-load-started" });
    void speakerProgressFor(api, roster.speakers, organizationId, eventId, controller.signal)
      .then((nextProgress) => {
        settled = true;
        if (!active || requestId !== rosterRequestRef.current) return;
        dispatchRoster({ type: "progress-loaded", progress: nextProgress });
      })
      .catch((reason: unknown) => {
        settled = true;
        if (!active || requestId !== rosterRequestRef.current) return;
        dispatchRoster({
          type: "progress-load-failed",
          message: timedOut
            ? "Speaker progress refresh timed out. Try again."
            : errorMessage(reason),
        });
      })
      .finally(() => {
        settled = true;
        clearTimeout(timeoutId);
      });
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeoutId);
      if (!settled && progressLoadRef.current === request) progressLoadRef.current = null;
    };
  }, [api, eventId, loading, organizationId, progressSectionVisible, roster, secondaryContextKey]);
  const secondarySectionsVisible =
    activeView === "tasks" ||
    activeView === "email" ||
    (secondarySectionsReady && secondarySectionsReadyKeyRef.current === secondaryContextKey);
  useEffect(() => {
    if (secondarySectionsVisible) return;
    const sections = [emailSectionRef.current, reminderSectionRef.current].filter(
      (section): section is HTMLDivElement => section !== null,
    );
    if (sections.length === 0) return;
    if (typeof IntersectionObserver === "undefined") {
      secondarySectionsReadyKeyRef.current = secondaryContextKey;
      dispatchRoster({ type: "secondary-ready" });
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        secondarySectionsReadyKeyRef.current = secondaryContextKey;
        dispatchRoster({ type: "secondary-ready" });
        observer.disconnect();
      },
      { rootMargin: "240px" },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [secondaryContextKey, secondarySectionsVisible]);
  const currentSecondaryLoadKey = speakerSecondaryLoadKey(
    roster,
    organizationId,
    eventId,
    loading,
    secondarySectionsVisible,
  );
  useEffect(() => {
    const loadKey = currentSecondaryLoadKey;
    if (api === null || loadKey === null) return;
    if (secondaryLoadRef.current?.api === api && secondaryLoadRef.current.key === loadKey) return;
    secondaryLoadRef.current = { api, key: loadKey };
    let active = true;
    void withTimeout((signal) => api.listEmailTemplates(signal), "Email template load")
      .then((templates) => {
        if (!active) return;
        dispatchEmail({ type: "email-templates-loaded", templates });
      })
      .catch(() => undefined);
    void withTimeout((signal) => api.listEmailHistory(signal), "Email history load")
      .then((history) => {
        if (active) dispatchEmail({ type: "email-sends-loaded", sends: history });
      })
      .catch(() => undefined);
    void withTimeout(
      (signal) => api.getReminderEligibility({}, signal),
      "Reminder eligibility load",
    )
      .then((eligibility) => {
        if (active) dispatchRoster({ type: "reminder-loaded", eligibility });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, currentSecondaryLoadKey]);
  const scopedRoster =
    roster !== null && roster.organizationId === organizationId && roster.eventId === eventId
      ? roster
      : null;
  const eventTemporalContext = scopedRoster?.temporalContext;
  const scopedProgress =
    progress !== null && progress.organizationId === organizationId && progress.eventId === eventId
      ? progress
      : null;
  const speakers = useMemo(() => scopedRoster?.speakers ?? [], [scopedRoster]);
  const rosterEmpty = !loading && scopedRoster !== null && speakers.length === 0;
  const selectedSpeakerIdSet = useMemo(() => new Set(selectedSpeakerIds), [selectedSpeakerIds]);
  const emailPreviewRecipientIdSet = useMemo(
    () => new Set(emailPreview?.recipientIds ?? []),
    [emailPreview?.recipientIds],
  );
  const taskAssigneeIdSet = useMemo(() => new Set(taskAssignees), [taskAssignees]);
  const selectedSpeaker = speakers.find((speaker) => speaker.participantId === selectedId) ?? null;
  const eligibleHeadshotSessions = useMemo(
    () => (selectedSpeaker === null ? [] : acceptedSpeakerSessions(selectedSpeaker.sessions)),
    [selectedSpeaker],
  );
  const selectedHeadshotSessionId = organizerHeadshotSessionId(
    selectedSpeaker?.sessions ?? [],
    headshotSessionId,
  );
  const cachedHeadshotAsset =
    selectedSpeaker === null
      ? null
      : (headshotAssetsByParticipant[selectedSpeaker.participantId] ?? null);
  const selectedHeadshotAsset =
    selectedSpeaker === null || selectedSpeaker.headshotAssetId === null
      ? null
      : (selectedSpeaker.assets.find(
          (asset) => asset.assetId === selectedSpeaker.headshotAssetId,
        ) ??
        (cachedHeadshotAsset?.assetId === selectedSpeaker.headshotAssetId
          ? cachedHeadshotAsset
          : null));
  const duplicateEmailWarnings = useMemo(() => duplicateEmailConflicts(speakers), [speakers]);
  const statusOptions = useMemo(() => {
    const values = new Set<string>([
      ...DEFAULT_STATUS_OPTIONS,
      ...speakers.map((speaker) => speaker.status),
    ]);
    return [...values];
  }, [speakers]);
  const sessionOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const speaker of speakers) {
      for (const session of speaker.sessions) {
        values.set(session.sessionId, session.title);
      }
    }
    return [...values.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [speakers]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredSpeakers = useMemo(
    () =>
      filterSpeakerRoster(
        filterSpeakersByAttention(speakers, attentionFilter),
        scopedProgress?.rows ?? [],
        { query, status: statusFilter, session: sessionFilter, progress: progressFilter },
      ),
    [
      attentionFilter,
      progressFilter,
      query,
      scopedProgress?.rows,
      sessionFilter,
      speakers,
      statusFilter,
    ],
  );
  const attentionCounts = useMemo(
    () => ({
      all: speakers.length,
      overdue: filterSpeakersByAttention(speakers, "overdue").length,
      "awaiting-invite": filterSpeakersByAttention(speakers, "awaiting-invite").length,
      "duplicate-email": filterSpeakersByAttention(speakers, "duplicate-email").length,
      inactive: filterSpeakersByAttention(speakers, "inactive").length,
    }),
    [speakers],
  );
  const progressRows = useMemo(
    () =>
      (scopedProgress?.rows ?? []).filter((row) =>
        speakerProgressMatches(row.tasks, progressFilter),
      ),
    [scopedProgress?.rows, progressFilter],
  );
  const onboardingTaskDefinitions = useMemo(
    () => speakerOnboardingTaskDefinitions(scopedProgress?.rows ?? []),
    [scopedProgress?.rows],
  );
  const eligibleReminderItems = useMemo(
    () => reminderEligibility?.items.filter((item) => item.eligible) ?? [],
    [reminderEligibility],
  );
  const ineligibleReminderItems = useMemo(
    () => reminderEligibility?.items.filter((item) => !item.eligible) ?? [],
    [reminderEligibility],
  );
  const reminderTasks = useMemo(
    () => scopedProgress?.rows.flatMap((row) => row.tasks) ?? [],
    [scopedProgress?.rows],
  );
  const selectedInvitationPreview =
    selectedSpeaker === null
      ? []
      : (invitationPreview ?? []).filter(
          (preview) => preview.participantId === selectedSpeaker.participantId,
        );
  const invitationReady =
    selectedSpeaker !== null && speakerInvitationReady(invitationPreview ?? [], selectedSpeaker);
  const selectedInvitationResultRecipient =
    selectedSpeaker === null ||
    invitationResult === null ||
    invitationResultParticipantId !== selectedSpeaker.participantId
      ? null
      : (invitationResult.recipients.find(
          (recipient) => recipient.participantId === selectedSpeaker.participantId,
        ) ?? null);
  const hasActiveRosterFilters =
    normalizedQuery.length > 0 ||
    statusFilter !== "all" ||
    sessionFilter !== "all" ||
    progressFilter !== "all";
  const selectedVisibleSpeakerIds = filteredSpeakers.reduce<string[]>((selected, speaker) => {
    if (selectedSpeakerIdSet.has(speaker.participantId)) selected.push(speaker.participantId);
    return selected;
  }, []);
  const allVisibleSelected =
    filteredSpeakers.length > 0 && selectedVisibleSpeakerIds.length === filteredSpeakers.length;
  const selectedEmailTemplate =
    emailTemplates.find(
      (template) => template.id === emailTemplateId && template.version === emailTemplateVersion,
    ) ?? null;
  const emailDraftDirty =
    selectedEmailTemplate === null ||
    selectedEmailTemplate.subject !== emailSubject ||
    selectedEmailTemplate.text !== emailText;
  const emailPreviewCurrent =
    emailPreview !== null &&
    emailPreview.organizationId === organizationId &&
    emailPreview.eventId === eventId &&
    emailPreview.templateId === emailTemplateId &&
    emailPreview.templateVersion === emailTemplateVersion &&
    emailPreview.recipientIds.length === selectedSpeakerIds.length &&
    selectedSpeakerIds.every((participantId) => emailPreviewRecipientIdSet.has(participantId));
  const invalidateEmailPreview = useCallback(() => {
    emailPreviewRequestRef.current += 1;
    dispatchEmail({ type: "email-preview-invalidated" });
  }, []);
  useEffect(() => {
    const snapshot = [...selectedSpeakerIds].sort().join("\u0000");
    const previous = emailSelectionSnapshotRef.current;
    if (previous !== null && previous !== snapshot) invalidateEmailPreview();
    emailSelectionSnapshotRef.current = snapshot;
  }, [invalidateEmailPreview, selectedSpeakerIds]);
  useEffect(() => {
    if (headshotPreviewApiRef.current === api) return;
    headshotPreviewApiRef.current = api;
    headshotPreviewKeyRef.current = null;
  }, [api]);
  const headshotPreviewRequestKey = organizerHeadshotPreviewRequestKey(
    0,
    headshotPreviewRetry,
    selectedSpeaker?.participantId,
    selectedSpeaker?.headshotAssetId,
    selectedHeadshotAsset,
  );
  useLayoutEffect(() => {
    headshotPreviewRequestDataRef.current = {
      participantId: selectedSpeaker?.participantId,
      assetId: selectedSpeaker?.headshotAssetId,
      asset: selectedHeadshotAsset,
    };
  }, [selectedHeadshotAsset, selectedSpeaker?.headshotAssetId, selectedSpeaker?.participantId]);
  useEffect(() => {
    const {
      participantId,
      assetId,
      asset: selectedHeadshotAsset,
    } = headshotPreviewRequestDataRef.current;
    const requestKey = headshotPreviewRequestKey;
    const requestId = headshotRequestRef.current + 1;
    headshotRequestRef.current = requestId;
    let active = true;
    if (api === null || participantId === undefined || assetId === undefined || assetId === null) {
      headshotPreviewKeyRef.current = null;
      dispatchProfileHeadshotDetails({ type: "headshot-preview-cleared" });
      return () => {
        active = false;
      };
    }
    if (requestKey !== null && requestKey === headshotPreviewKeyRef.current) {
      return () => {
        active = false;
      };
    }
    headshotPreviewKeyRef.current = requestKey;
    dispatchProfileHeadshotDetails({ type: "headshot-preview-started" });
    void (async () => {
      try {
        if (selectedHeadshotAsset === null) {
          const assets = await withTimeout(
            (signal) => api.getAssets(participantId, signal),
            "Headshot metadata load",
          );
          if (!active || requestId !== headshotRequestRef.current) return;
          const linked = assets.find((asset) => asset.assetId === assetId);
          if (linked === undefined) {
            dispatchProfileHeadshotDetails({
              type: "headshot-preview-error",
              message: "The linked headshot file is unavailable.",
            });
            return;
          }
          dispatchProfileHeadshotDetails({
            type: "headshot-asset-linked",
            participantId,
            asset: linked,
          });
          return;
        }
        if (selectedHeadshotAsset.status !== "ready") {
          throw new Error("The linked headshot is not ready yet.");
        }
        const contentType = selectedHeadshotAsset.contentType.trim().toLowerCase();
        if (
          !ORGANIZER_HEADSHOT_ACCEPTED_TYPES.includes(
            contentType as (typeof ORGANIZER_HEADSHOT_ACCEPTED_TYPES)[number],
          )
        ) {
          throw new Error("The linked asset is not a supported headshot image.");
        }
        const grant = await withTimeout(
          (signal) => api.getDownloadGrant(selectedHeadshotAsset.assetId, signal),
          "Headshot preview",
        );
        const previewPath = organizerHeadshotPreviewPath(grant.url);
        if (previewPath === null) {
          throw new Error("The private headshot preview did not return a same-origin API path.");
        }
        if (!active || requestId !== headshotRequestRef.current) return;
        dispatchProfileHeadshotDetails({ type: "headshot-preview-ready", url: previewPath });
      } catch (reason: unknown) {
        if (active && requestId === headshotRequestRef.current) {
          dispatchProfileHeadshotDetails({
            type: "headshot-preview-error",
            message: errorMessage(reason),
          });
        }
      } finally {
        if (active && requestId === headshotRequestRef.current) {
          dispatchProfileHeadshotDetails({ type: "headshot-preview-finished" });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [api, headshotPreviewRequestKey]);
  function clearRosterFilters(): void {
    dispatchRoster({ type: "filters-cleared" });
  }
  function openSelectedEmail(): void {
    dispatchRoster({ type: "view-changed", view: "email" });
  }
  function toggleSpeakerSelection(participantId: string): void {
    dispatchRoster({ type: "selection-toggled", participantId });
    invalidateEmailPreview();
    dispatchEmail({ type: "email-notice-set", message: null });
  }
  function toggleVisibleSpeakerSelection(): void {
    const visibleIds = filteredSpeakers.map((speaker) => speaker.participantId);
    dispatchRoster({ type: "visible-selection-toggled", participantIds: visibleIds });
    invalidateEmailPreview();
    dispatchEmail({ type: "email-notice-set", message: null });
  }
  function clearSpeakerSelection(): void {
    dispatchRoster({ type: "selection-set", participantIds: [] });
    invalidateEmailPreview();
    dispatchEmail({ type: "email-notice-set", message: null });
  }
  function updateCreate(field: keyof CreateDraft, value: string | boolean): void {
    dispatchProfileHeadshotDetails({ type: "create-draft-updated", field, value });
    createIdempotencyKeyRef.current = null;
    dispatchRoster({ type: "notice-set", message: null });
  }
  function updateEdit(field: keyof CreateDraft, value: string | boolean): void {
    dispatchProfileHeadshotDetails({ type: "edit-draft-updated", field, value });
    dispatchProfileHeadshotDetails({ type: "edit-error-set", message: null });
    dispatchProfileHeadshotDetails({
      type: "profile-mutation-state-changed",
      status: "idle",
      message: null,
    });
    dispatchRoster({ type: "notice-set", message: null });
    dispatchImportTaskInvitation({ type: "invitation-cleared" });
    invitationSendIdempotencyKeyRef.current = null;
  }
  function applyAuthoritativeRoster(nextRoster: SpeakerRosterEnvelope, message?: string): void {
    try {
      const normalizedRoster = normalizeRoster(nextRoster, organizationId, eventId);
      const requestId = rosterRequestRef.current + 1;
      rosterRequestRef.current = requestId;
      dispatchRoster({ type: "roster-authoritative-applied", roster: normalizedRoster, message });
      dispatchImportTaskInvitation({ type: "invitation-cleared" });
    } catch (reason: unknown) {
      dispatchRoster({
        type: "roster-load-failed",
        message: errorMessage(reason),
        clearRoster: true,
      });
    }
  }
  async function reload(message?: string): Promise<SpeakerRosterEnvelope | null> {
    if (api === null) {
      dispatchRoster({ type: "api-error-set", message: "The speaker API is unavailable." });
      return null;
    }
    const requestId = rosterRequestRef.current + 1;
    rosterRequestRef.current = requestId;
    const controller = new AbortController();
    let rosterTimedOut = false;
    const rosterTimeout = setTimeout(() => {
      rosterTimedOut = true;
      controller.abort();
    }, ASYNC_ACTION_TIMEOUT_MS);
    dispatchRoster({ type: "roster-load-started" });
    dispatchImportTaskInvitation({ type: "invitation-cleared" });
    invitationSendIdempotencyKeyRef.current = null;
    try {
      const nextRoster = normalizeRoster(
        await api.list(controller.signal),
        organizationId,
        eventId,
      );
      if (requestId !== rosterRequestRef.current) return null;
      dispatchRoster({ type: "roster-loaded", roster: nextRoster });
      if (message) dispatchRoster({ type: "notice-set", message });
      return nextRoster;
    } catch (reason: unknown) {
      if (requestId === rosterRequestRef.current) {
        if (
          reason instanceof Error &&
          /different organization|different event|invalid|duplicate participant/iu.test(
            reason.message,
          )
        ) {
          dispatchRoster({
            type: "roster-load-failed",
            message: rosterTimedOut
              ? "Speaker roster refresh timed out. Try again."
              : errorMessage(reason),
            clearRoster:
              reason instanceof Error &&
              /different organization|different event|invalid|duplicate participant/iu.test(
                reason.message,
              ),
          });
        }
      }
      return null;
    } finally {
      clearTimeout(rosterTimeout);
      if (requestId === rosterRequestRef.current) {
        dispatchRoster({ type: "loading-changed", loading: false });
      }
    }
  }
  async function createSpeaker(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (api === null) {
      dispatchRoster({
        type: "notice-set",
        message: "Speaker creation is unavailable until the organizer speaker API is configured.",
      });
      return;
    }
    const idempotencyKey = createIdempotencyKeyRef.current ?? crypto.randomUUID();
    createIdempotencyKeyRef.current = idempotencyKey;
    const input: SpeakerCreateInput = {
      idempotencyKey,
      displayName: createDraft.displayName.trim(),
      email: createDraft.email.trim(),
      jobTitle: createDraft.title.trim(),
      company: createDraft.company.trim(),
      biography: createDraft.biography.trim(),
      socialLinks: socialLinksFor(createDraft),
      travelLogistics: travelLogisticsFor(createDraft),
      status: createDraft.status,
    };
    if (!input.displayName || !input.email) {
      dispatchRoster({ type: "notice-set", message: "Name and email are required." });
      return;
    }
    dispatchProfileHeadshotDetails({ type: "save-busy-changed", busy: true });
    dispatchRoster({ type: "notice-set", message: null });
    try {
      const created = await api.create(input);
      dispatchProfileHeadshotDetails({ type: "create-draft-reset" });
      createIdempotencyKeyRef.current = null;
      dispatchRoster({ type: "add-dialog-changed", open: false });
      applyAuthoritativeRoster(created, "Speaker added to the roster.");
    } catch (reason: unknown) {
      dispatchRoster({ type: "notice-set", message: errorMessage(reason) });
    } finally {
      dispatchProfileHeadshotDetails({ type: "save-busy-changed", busy: false });
    }
  }
  function beginEdit(speaker: SpeakerRecord): void {
    dispatchRoster({ type: "selected-id-changed", participantId: speaker.participantId });
    dispatchProfileHeadshotDetails({ type: "headshot-session-selected", sessionId: null });
    dispatchProfileHeadshotDetails({
      type: "headshot-upload-state-changed",
      status: "idle",
      message: null,
    });
    dispatchProfileHeadshotDetails({
      type: "headshot-mutation-state-changed",
      status: "idle",
      message: null,
    });
    dispatchProfileHeadshotDetails({
      type: "edit-started",
      draft: editDraftFor(speaker, eventTemporalContext?.timeZone),
    });
    dispatchImportTaskInvitation({ type: "invitation-cleared" });
    invitationSendIdempotencyKeyRef.current = null;
  }
  async function saveSpeaker(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (api === null || editDraft === null || selectedSpeaker === null) return;
    const participantId = selectedSpeaker.participantId;
    const expectedVersion = editDraft.expectedVersion;
    const input: SpeakerUpdateInput = {
      expectedVersion,
      displayName: editDraft.displayName.trim(),
      email: editDraft.email.trim(),
      jobTitle: editDraft.title.trim(),
      company: editDraft.company.trim(),
      biography: editDraft.biography.trim(),
      socialLinks: socialLinksFor(editDraft),
      travelLogistics: travelLogisticsFor(editDraft),
      status: editDraft.status,
    };
    if (!input.displayName || !input.email) {
      dispatchProfileHeadshotDetails({
        type: "profile-validation-failed",
        message: "Name and email are required.",
      });
      return;
    }
    dispatchImportTaskInvitation({ type: "invitation-cleared" });
    invitationSendIdempotencyKeyRef.current = null;
    dispatchProfileHeadshotDetails({ type: "profile-save-started" });
    try {
      const updatedRoster = assertSpeakerRosterScope(
        await api.update(participantId, input),
        organizationId,
        eventId,
      );
      const updated = updatedRoster.speakers.find(
        (speaker) => speaker.participantId === participantId,
      );
      if (updated === undefined) {
        throw new TypeError("The saved speaker is missing from the roster.");
      }
      assertAdvancedSpeakerRevision(updated, participantId, expectedVersion, eventId);
      dispatchProfileHeadshotDetails({ type: "profile-write-accepted" });
      applyAuthoritativeRoster(updatedRoster);
      dispatchProfileHeadshotDetails({
        type: "profile-saved",
        speaker: updated,
        ...(eventTemporalContext === undefined
          ? {}
          : { eventTimeZone: eventTemporalContext.timeZone }),
      });
      dispatchRoster({
        type: "notice-set",
        message: "Speaker profile saved from the server.",
      });
    } catch (reason: unknown) {
      const conflict =
        reason instanceof SpeakerApiError &&
        (reason.status === 409 || reason.code === "CONFLICT" || reason.code === "VERSION_CONFLICT");
      const outcomeUnknown = speakerMutationOutcomeUnknown(reason);
      if (conflict || outcomeUnknown) {
        dispatchProfileHeadshotDetails({ type: "profile-conflict" });
        const reloaded = await reload();
        const current = reloaded?.speakers.find(
          (speaker) => speaker.participantId === participantId,
        );
        if (current !== undefined) {
          dispatchProfileHeadshotDetails({
            type: "edit-draft-set",
            draft: editDraftFor(current, eventTemporalContext?.timeZone),
          });
        }
        dispatchProfileHeadshotDetails({
          type: "edit-error-set",
          message: "This speaker changed elsewhere. Review the reloaded values before saving.",
        });
      } else {
        dispatchProfileHeadshotDetails({ type: "profile-failed", message: errorMessage(reason) });
      }
    } finally {
      dispatchProfileHeadshotDetails({ type: "save-busy-changed", busy: false });
    }
  }
  async function previewCsv(file: File, input?: HTMLInputElement): Promise<void> {
    const requestId = importRequestRef.current + 1;
    importRequestRef.current = requestId;
    dispatchImportTaskInvitation({ type: "import-preview-started", fileName: file.name });
    importIdempotencyKeyRef.current = null;
    dispatchRoster({ type: "notice-set", message: null });
    try {
      if (api === null) {
        throw new Error("CSV import is unavailable until the organizer speaker API is configured.");
      }
      const preview = await withTimeout(
        (signal) => api.previewImport(file, signal),
        "CSV validation",
      );
      if (requestId !== importRequestRef.current) return;
      dispatchImportTaskInvitation({ type: "import-preview-loaded", preview });
      importIdempotencyKeyRef.current = crypto.randomUUID();
      dispatchRoster({
        type: "notice-set",
        message: `CSV preview ready: ${preview.validRows.length} valid row${preview.validRows.length === 1 ? "" : "s"}.`,
      });
    } catch (reason: unknown) {
      if (requestId === importRequestRef.current) {
        dispatchRoster({ type: "notice-set", message: errorMessage(reason) });
      }
    } finally {
      if (requestId === importRequestRef.current) {
        dispatchImportTaskInvitation({ type: "import-preview-busy-changed", busy: false });
      }
      if (requestId === importRequestRef.current && input !== undefined) input.value = "";
    }
  }
  async function commitCsv(): Promise<void> {
    if (api === null || importPreview === null || importPreview.validRows.length === 0) return;
    const idempotencyKey = importIdempotencyKeyRef.current ?? crypto.randomUUID();
    importIdempotencyKeyRef.current = idempotencyKey;
    dispatchImportTaskInvitation({ type: "import-commit-busy-changed", busy: true });
    dispatchRoster({ type: "notice-set", message: null });
    try {
      const rowCount = importPreview.validRows.length;
      const imported = await withTimeout(
        (signal) => api.commitImport({ rows: importPreview.validRows, idempotencyKey }, signal),
        "CSV import",
      );
      dispatchImportTaskInvitation({ type: "import-committed" });
      importIdempotencyKeyRef.current = null;
      applyAuthoritativeRoster(
        imported,
        `CSV import committed: ${rowCount} valid row${rowCount === 1 ? "" : "s"}.`,
      );
    } catch (reason: unknown) {
      dispatchRoster({ type: "notice-set", message: errorMessage(reason) });
    } finally {
      dispatchImportTaskInvitation({ type: "import-commit-busy-changed", busy: false });
    }
  }
  function toggleAssignee(participantId: string): void {
    dispatchImportTaskInvitation({ type: "task-assignee-toggled", participantId });
  }
  async function assignTask(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (api === null) {
      dispatchRoster({
        type: "notice-set",
        message: "Task assignment is unavailable until the organizer speaker API is configured.",
      });
      return;
    }
    if (progress === null || progressError !== null) {
      dispatchRoster({
        type: "notice-set",
        message: "Wait for API-backed onboarding progress to load before assigning another task.",
      });
      return;
    }
    const draft = {
      title: taskTitle,
      dueAt: taskDueAt,
      participantIds: taskAssignees,
    } satisfies SpeakerOnboardingTaskDraft;
    const validationError = validateSpeakerTaskAssignment(draft, onboardingTaskDefinitions.length);
    if (validationError !== null) {
      dispatchRoster({ type: "notice-set", message: validationError });
      return;
    }
    const input = createSpeakerTaskAssignment(draft);
    dispatchImportTaskInvitation({ type: "task-busy-changed", busy: true });
    dispatchRoster({ type: "notice-set", message: null });
    try {
      const latest = await withTimeout(async (signal) => {
        const latestRoster = normalizeRoster(await api.list(signal), organizationId, eventId);
        const latestProgress = await speakerProgressFor(
          api,
          latestRoster.speakers,
          organizationId,
          eventId,
          signal,
        );
        return { latestRoster, latestProgress };
      }, "Onboarding task preflight");
      dispatchRoster({
        type: "progress-and-roster-loaded",
        roster: mergeProgressSummaries(latest.latestRoster, latest.latestProgress),
        progress: latest.latestProgress,
      });
      dispatchImportTaskInvitation({ type: "invitation-cleared" });
      invitationSendIdempotencyKeyRef.current = null;
      const latestValidationError = validateSpeakerTaskAssignment(
        draft,
        speakerOnboardingTaskDefinitions(latest.latestProgress.rows).length,
      );
      if (latestValidationError !== null) {
        dispatchRoster({ type: "notice-set", message: latestValidationError });
        return;
      }
      const taskEnvelope = await api.assignTasks(input);
      if (taskEnvelope.organizationId !== organizationId || taskEnvelope.eventId !== eventId) {
        throw new TypeError(
          "The speaker task response belongs to a different organization or event.",
        );
      }
      const returnedAssignees = new Set(taskEnvelope.tasks.map((task) => task.participantId));
      if (
        taskEnvelope.tasks.length !== input.participantIds.length ||
        returnedAssignees.size !== input.participantIds.length ||
        input.participantIds.some((participantId) => !returnedAssignees.has(participantId)) ||
        taskEnvelope.tasks.some(
          (task) =>
            task.title !== input.title ||
            task.description !== input.description ||
            task.dueAt !== input.dueAt ||
            task.type !== "general",
        )
      ) {
        throw new TypeError("The speaker task response does not match the selected assignees.");
      }
      dispatchRoster({
        type: "tasks-assigned",
        taskEnvelope,
        fallbackRows: latest.latestProgress.rows,
      });
      dispatchImportTaskInvitation({ type: "task-fields-cleared" });
      void api
        .getReminderEligibility()
        .then((eligibility) => dispatchRoster({ type: "reminder-loaded", eligibility }))
        .catch(() => undefined);
      dispatchRoster({
        type: "notice-set",
        message: "General action task assigned to selected speakers.",
      });
    } catch (reason: unknown) {
      dispatchRoster({ type: "notice-set", message: errorMessage(reason) });
    } finally {
      dispatchImportTaskInvitation({ type: "task-busy-changed", busy: false });
    }
  }
  async function updateTaskReminderOffsets(
    taskId: string,
    expectedVersion: number,
    reminderOffsetsMinutes: readonly number[],
  ): Promise<SpeakerTaskReminderOffsetsResult> {
    if (api === null) throw new Error("The organizer speaker API is unavailable.");
    const result = await api.updateTaskReminderOffsets({
      taskId,
      expectedVersion,
      reminderOffsetsMinutes,
    });
    dispatchRoster({
      type: "task-reminder-version-updated",
      taskId: result.taskId,
      version: result.version,
    });
    void api
      .getReminderEligibility()
      .then((eligibility) => dispatchRoster({ type: "reminder-loaded", eligibility }))
      .catch(() => undefined);
    return result;
  }

  async function refreshEmailHistory(): Promise<void> {
    if (api === null) {
      dispatchEmail({
        type: "email-notice-set",
        message: "Email history is unavailable until the organizer speaker API is configured.",
      });
      return;
    }
    dispatchEmail({ type: "email-history-busy-changed", busy: true });
    dispatchEmail({ type: "email-notice-set", message: null });
    try {
      const history = await withTimeout(
        (signal) => api.listEmailHistory(signal),
        "Email history refresh",
      );
      dispatchEmail({ type: "email-sends-loaded", sends: history });
      dispatchEmail({
        type: "email-notice-set",
        message: `Email history refreshed: ${history.length} send${history.length === 1 ? "" : "s"}.`,
      });
    } catch (reason: unknown) {
      dispatchEmail({ type: "email-notice-set", message: errorMessage(reason) });
    } finally {
      dispatchEmail({ type: "email-history-busy-changed", busy: false });
    }
  }
  async function saveEmailTemplate(): Promise<SpeakerEmailTemplate | null> {
    if (api === null) {
      dispatchEmail({
        type: "email-notice-set",
        message: "Email templates are unavailable until the organizer speaker API is configured.",
      });
      return null;
    }
    invalidateEmailPreview();
    dispatchEmail({ type: "email-save-busy-changed", busy: true });
    dispatchEmail({ type: "email-notice-set", message: null });
    try {
      const newTemplateId =
        emailCreateTemplateIdRef.current ?? `speaker-email-draft:${crypto.randomUUID()}`;
      if (emailTemplateId.length === 0) emailCreateTemplateIdRef.current = newTemplateId;
      const template = emailTemplateId
        ? await withTimeout(
            (signal) =>
              api.createEmailTemplateVersion(
                {
                  templateId: emailTemplateId,
                  subject: emailSubject,
                  text: emailText,
                },
                signal,
              ),
            "Email template save",
          )
        : await withTimeout(
            (signal) =>
              api.createEmailTemplate(
                {
                  templateId: newTemplateId,
                  name: emailTemplateName,
                  subject: emailSubject,
                  text: emailText,
                },
                signal,
              ),
            "Email template save",
          );
      dispatchEmail({ type: "email-template-saved", template });
      dispatchEmail({
        type: "email-notice-set",
        message: `Template version ${template.version} saved.`,
      });
      emailSendIdempotencyKeyRef.current = null;
      return template;
    } catch (reason: unknown) {
      dispatchEmail({ type: "email-notice-set", message: errorMessage(reason) });
      return null;
    } finally {
      dispatchEmail({ type: "email-save-busy-changed", busy: false });
    }
  }
  async function previewBulkEmail(): Promise<void> {
    if (api === null) {
      dispatchEmail({
        type: "email-notice-set",
        message: "Bulk email is unavailable until the organizer speaker API is configured.",
      });
      return;
    }
    if (selectedSpeakerIds.length === 0) {
      dispatchEmail({
        type: "email-notice-set",
        message: "Select at least one speaker before previewing an email.",
      });
      return;
    }
    let templateId = emailTemplateId;
    let templateVersion = emailTemplateVersion;
    if (emailDraftDirty) {
      const saved = await saveEmailTemplate();
      if (saved === null) return;
      templateId = saved.id;
      templateVersion = saved.version;
    }
    invalidateEmailPreview();
    const requestId = emailPreviewRequestRef.current;
    dispatchEmail({ type: "email-preview-started" });
    dispatchEmail({ type: "email-notice-set", message: null });
    try {
      const recipientIds = [...selectedSpeakerIds];
      const preview = await withTimeout(
        (signal) =>
          api.previewEmails(
            {
              participantIds: recipientIds,
              templateId,
              ...(templateVersion === undefined ? {} : { templateVersion }),
            },
            signal,
          ),
        "Email merge preview",
      );
      if (requestId !== emailPreviewRequestRef.current) return;
      if (preview.organizationId !== organizationId || preview.eventId !== eventId) {
        throw new Error("The email preview belongs to a different event. Create a new preview.");
      }
      dispatchEmail({ type: "email-preview-set", preview });
      dispatchEmail({
        type: "email-template-selected",
        id: preview.templateId,
        version: preview.templateVersion,
        template: null,
      });
      emailCreateTemplateIdRef.current = null;
      emailSendIdempotencyKeyRef.current = null;
      dispatchEmail({
        type: "email-notice-set",
        message: `Merge preview ready for ${preview.recipientIds.length} selected speaker${preview.recipientIds.length === 1 ? "" : "s"}.`,
      });
    } catch (reason: unknown) {
      if (requestId === emailPreviewRequestRef.current) {
        dispatchEmail({ type: "email-notice-set", message: errorMessage(reason) });
      }
    } finally {
      if (requestId === emailPreviewRequestRef.current) {
        dispatchEmail({ type: "email-preview-busy-changed", busy: false });
      }
    }
  }
  async function sendBulkEmail(): Promise<void> {
    if (api === null || !emailPreviewCurrent || emailPreview === null) {
      dispatchEmail({
        type: "email-notice-set",
        message: "Create a current merge preview before queueing the email.",
      });
      dispatchEmail({ type: "email-confirm-changed", open: false });
      return;
    }
    const preview = emailPreview;
    const idempotencyKey = emailSendIdempotencyKeyRef.current ?? crypto.randomUUID();
    emailSendIdempotencyKeyRef.current = idempotencyKey;
    dispatchEmail({ type: "email-send-busy-changed", busy: true });
    dispatchEmail({ type: "email-notice-set", message: null });
    try {
      const send = await withTimeout(
        (signal) => api.sendEmails({ previewId: preview.id, idempotencyKey }, signal),
        "Speaker email queue",
      );
      dispatchEmail({ type: "email-send-recorded", send });
      dispatchEmail({
        type: "email-notice-set",
        message: `Speaker email ${send.status} for ${send.recipientIds.length} recipient${send.recipientIds.length === 1 ? "" : "s"}. Queue history is retained below.`,
      });
    } catch (reason: unknown) {
      dispatchEmail({ type: "email-notice-set", message: errorMessage(reason) });
    } finally {
      dispatchEmail({ type: "email-send-busy-changed", busy: false });
    }
  }
  async function previewSelectedSpeakerInvitation(): Promise<void> {
    if (api === null || selectedSpeaker === null) {
      dispatchImportTaskInvitation({
        type: "invitation-error-set",
        message:
          "Portal invitations are unavailable until the organizer speaker API is configured.",
      });
      return;
    }
    const participantId = selectedSpeaker.participantId;
    dispatchImportTaskInvitation({ type: "invitation-preview-started" });
    invitationSendIdempotencyKeyRef.current = null;
    try {
      const preview = await withTimeout(
        () => api.previewInvitations({ participantIds: [participantId] }),
        "Portal invitation preview",
      );
      if (preview.length !== 1 || preview[0]?.participantId !== participantId) {
        throw new TypeError("The invitation preview does not match the selected speaker.");
      }
      dispatchImportTaskInvitation({ type: "invitation-preview-loaded", preview });
    } catch (reason: unknown) {
      dispatchImportTaskInvitation({
        type: "invitation-preview-failed",
        message: errorMessage(reason),
      });
    } finally {
      dispatchImportTaskInvitation({ type: "invitation-preview-busy-changed", busy: false });
    }
  }
  async function sendSelectedSpeakerInvitation(): Promise<void> {
    if (api === null || selectedSpeaker === null || !invitationReady) {
      dispatchImportTaskInvitation({
        type: "invitation-error-set",
        message: "Preview an eligible portal invitation before sending it.",
      });
      return;
    }
    const participantId = selectedSpeaker.participantId;
    const preview = selectedInvitationPreview;
    const idempotencyKey = invitationSendIdempotencyKeyRef.current ?? crypto.randomUUID();
    invitationSendIdempotencyKeyRef.current = idempotencyKey;
    dispatchImportTaskInvitation({ type: "invitation-send-started" });
    try {
      const result = await withTimeout(
        () =>
          api.sendInvitations({
            participantIds: [participantId],
            templateId: "speaker-welcome",
            idempotencyKey,
          }),
        "Portal invitation send",
      );
      const selectedRecipient = result.recipients.find(
        (recipient) => recipient.participantId === participantId,
      );
      if (selectedRecipient === undefined) {
        throw new TypeError("The invitation result does not include the selected speaker.");
      }
      dispatchImportTaskInvitation({ type: "invitation-result-recorded", participantId, result });
      dispatchImportTaskInvitation({
        type: "invitation-history-retained",
        preview,
        result,
      });
      invitationSendIdempotencyKeyRef.current = null;
    } catch (reason: unknown) {
      dispatchImportTaskInvitation({ type: "invitation-error-set", message: errorMessage(reason) });
    } finally {
      dispatchImportTaskInvitation({ type: "invitation-send-busy-changed", busy: false });
    }
  }
  async function refreshDetails(): Promise<void> {
    if (api === null || selectedSpeaker === null) {
      dispatchProfileHeadshotDetails({
        type: "detail-notice-set",
        message:
          "Session and deliverable details are unavailable until the organizer speaker API is configured.",
      });
      return;
    }
    dispatchProfileHeadshotDetails({ type: "detail-busy-changed", busy: true });
    dispatchProfileHeadshotDetails({ type: "detail-notice-set", message: null });
    try {
      const [sessions, assets] = await Promise.all([
        api.getSessions(selectedSpeaker.participantId),
        api.getAssets(selectedSpeaker.participantId),
      ]);
      dispatchRoster({
        type: "roster-details-refreshed",
        participantId: selectedSpeaker.participantId,
        sessions,
        assets,
        updatedAt: new Date().toISOString(),
      });
      dispatchProfileHeadshotDetails({
        type: "detail-notice-set",
        message: "Session assignments and deliverables refreshed.",
      });
    } catch (reason: unknown) {
      dispatchProfileHeadshotDetails({ type: "detail-notice-set", message: errorMessage(reason) });
    } finally {
      dispatchProfileHeadshotDetails({ type: "detail-busy-changed", busy: false });
    }
  }
  async function requestAssetDownload(asset: SpeakerAsset): Promise<string | null> {
    if (api === null || asset.status !== "ready" || downloadBusyAssetId !== null) return null;
    const assetId = asset.assetId;
    dispatchProfileHeadshotDetails({ type: "download-started", assetId });
    try {
      const grant = await withTimeout(
        (signal) => api.getDownloadGrant(assetId, signal),
        "Asset download",
      );
      const downloadPath = organizerHeadshotPreviewPath(grant.url);
      if (downloadPath === null) {
        throw new Error("The private download capability returned an unsafe URL.");
      }
      return downloadPath;
    } catch (reason: unknown) {
      dispatchProfileHeadshotDetails({
        type: "download-failed",
        assetId,
        message: errorMessage(reason),
      });
      return null;
    } finally {
      dispatchProfileHeadshotDetails({ type: "download-finished", assetId });
    }
  }
  function retryHeadshotPreview(): void {
    dispatchProfileHeadshotDetails({ type: "headshot-preview-retried" });
  }
  function markHeadshotPreviewFailed(): void {
    dispatchProfileHeadshotDetails({ type: "headshot-preview-marked-failed" });
  }
  async function uploadOrganizerHeadshot(file: File): Promise<void> {
    const validationError = validateOrganizerHeadshotFile(file);
    if (validationError !== null) {
      dispatchProfileHeadshotDetails({
        type: "headshot-validation-failed",
        message: validationError,
      });
      return;
    }
    if (api === null || selectedSpeaker === null || api.replaceHeadshot === undefined) {
      const message =
        "Organizer headshot upload is unavailable until the private upload API is provisioned.";
      dispatchProfileHeadshotDetails({ type: "headshot-unavailable", message });
      return;
    }
    if (selectedHeadshotSessionId === null) {
      dispatchProfileHeadshotDetails({
        type: "headshot-session-required",
        message:
          eligibleHeadshotSessions.length > 1
            ? "Choose an accepted session before replacing this headshot."
            : "Headshot replacement requires an accepted session owned by this speaker.",
      });
      return;
    }
    const participantId = selectedSpeaker.participantId;
    const expectedVersion = selectedSpeaker.version;
    let supersedesAssetId = selectedSpeaker.headshotAssetId ?? undefined;
    let expectedLatestVersion: number | undefined;
    if (supersedesAssetId !== undefined) {
      const assets = await api.getAssets(participantId);
      const referenced = assets.find((asset) => asset.assetId === supersedesAssetId);
      const predecessor =
        referenced === undefined
          ? undefined
          : assets
              .filter(
                (asset) =>
                  (asset.versionFamilyId ?? asset.assetId) ===
                    (referenced.versionFamilyId ?? referenced.assetId) &&
                  (asset.status === "ready" || asset.status === "rejected") &&
                  typeof asset.version === "number" &&
                  asset.version > 0,
              )
              .sort((left, right) => (right.version ?? 1) - (left.version ?? 1))[0];
      if (predecessor === undefined) {
        dispatchProfileHeadshotDetails({
          type: "headshot-failed",
          message:
            "The current headshot version could not be resolved; reload before replacing it.",
        });
        return;
      }
      const predecessorVersion = predecessor.version;
      if (
        typeof predecessorVersion !== "number" ||
        !Number.isSafeInteger(predecessorVersion) ||
        predecessorVersion <= 0
      ) {
        dispatchProfileHeadshotDetails({
          type: "headshot-failed",
          message:
            "The current headshot version could not be resolved; reload before replacing it.",
        });
        return;
      }
      supersedesAssetId = predecessor.assetId;
      expectedLatestVersion = predecessorVersion;
    }
    dispatchProfileHeadshotDetails({ type: "headshot-upload-started", fileName: file.name });
    try {
      const replacement = assertSpeakerHeadshotReplacement(
        await api.replaceHeadshot({
          participantId,
          file,
          expectedVersion,
          ...(supersedesAssetId === undefined
            ? {}
            : {
                supersedesAssetId,
                expectedLatestVersion: expectedLatestVersion as number,
              }),
        }),
        eventId,
        participantId,
        expectedVersion,
      );
      dispatchProfileHeadshotDetails({ type: "headshot-write-accepted" });
      const reloaded = await reload();
      const persisted = reloaded?.speakers.find(
        (speaker) => speaker.participantId === participantId,
      );
      if (persisted === undefined) {
        throw new TypeError("The reloaded speaker is missing from the roster.");
      }
      assertAdvancedSpeakerRevision(persisted, participantId, expectedVersion, eventId);
      if (persisted.headshotAssetId !== replacement.asset.id) {
        throw new TypeError("The reloaded speaker does not point to the uploaded headshot.");
      }
      dispatchProfileHeadshotDetails({
        type: "headshot-upload-succeeded",
        speaker: persisted,
        ...(eventTemporalContext === undefined
          ? {}
          : { eventTimeZone: eventTemporalContext.timeZone }),
      });
    } catch (reason: unknown) {
      const conflict =
        reason instanceof SpeakerApiError &&
        (reason.status === 409 || reason.code === "CONFLICT" || reason.code === "VERSION_CONFLICT");
      if (conflict) {
        dispatchProfileHeadshotDetails({ type: "headshot-conflict" });
        await reload();
      } else {
        const message = errorMessage(reason);
        dispatchProfileHeadshotDetails({ type: "headshot-failed", message });
      }
    }
  }
  return (
    <div className={styles.workspace}>
      <WorkspaceHeader
        eyebrow="Event operations / Speakers"
        title="Speaker operations"
        description="Manage people and profiles in Roster, assign onboarding action items for speakers to complete in their portal, and use Email for speaker-only outreach; broader announcements belong in Communications."
        status={
          <StatusBadge tone="neutral">
            {speakers.length} {speakers.length === 1 ? "speaker" : "speakers"}
          </StatusBadge>
        }
        actions={
          <>
            <Button
              variant="outline"
              type="button"
              onClick={() => void reload()}
              disabled={loading}
            >
              <RefreshCw data-icon="inline-start" />
              {loading ? "Refreshing…" : "Refresh roster"}
            </Button>
            {!rosterEmpty ? (
              <Button
                variant="default"
                type="button"
                onClick={() => dispatchRoster({ type: "add-dialog-changed", open: true })}
              >
                <UserPlus data-icon="inline-start" />
                Add speaker
              </Button>
            ) : null}
          </>
        }
      />
      {error ? <FormMessage message={error} error /> : null}
      {notice ? <FormMessage message={notice} /> : null}
      <SpeakerAddDialog
        open={showAdd}
        draft={createDraft}
        statusOptions={statusOptions}
        saveBusy={saveBusy}
        apiAvailable={api !== null}
        {...(eventTemporalContext === undefined ? {} : { temporalContext: eventTemporalContext })}
        onOpenChange={(open) => dispatchRoster({ type: "add-dialog-changed", open })}
        onSubmit={(event) => void createSpeaker(event)}
        onChange={updateCreate}
      />
      <SpeakerWorkspaceViews
        activeView={activeView}
        onViewChange={(view) => dispatchRoster({ type: "view-changed", view })}
        roster={{
          rosterEmpty,
          attentionFilter,
          attentionCounts,
          onAttentionFilterChange: (attention) =>
            dispatchRoster({ type: "attention-filter-changed", attention }),
          scopedRoster,
          loading,
          speakers,
          filteredSpeakers,
          selectedId,
          selectedSpeakerIdSet,
          duplicateEmailWarnings,
          statusOptions,
          sessionOptions,
          query,
          filtersOpen,
          statusFilter,
          sessionFilter,
          progressFilter,
          hasActiveRosterFilters,
          hasAnyFilters: hasActiveRosterFilters || attentionFilter !== "all",
          selectedSpeakerIds,
          allVisibleSelected,
          selectedSpeaker,
          detailTriggerRef,
          onCloseDetail: () => dispatchRoster({ type: "selected-id-changed", participantId: null }),
          detailProps: {
            organizationId,
            eventId,
            apiAvailable: api !== null,
            detailBusy,
            onRefreshDetails: () => void refreshDetails(),
            detailNotice,
            invitation: {
              previewBusy: invitationPreviewBusy,
              sendBusy: invitationSendBusy,
              canSend: invitationReady,
              selectedPreview: selectedInvitationPreview,
              result: invitationResult,
              resultParticipantId: invitationResultParticipantId,
              selectedResultRecipient: selectedInvitationResultRecipient,
              error: invitationError,
              history: invitationHistory,
              onPreview: () => void previewSelectedSpeakerInvitation(),
              onSend: () => void sendSelectedSpeakerInvitation(),
            },
            headshot: {
              asset: selectedHeadshotAsset,
              imageUrl: headshotPreviewUrl,
              loading: headshotPreviewLoading,
              error: headshotPreviewError,
              revision: headshotPreviewRevision,
              eligibleSessions: eligibleHeadshotSessions,
              selectedSessionId: selectedHeadshotSessionId,
              uploadStatus: headshotUploadStatus,
              uploadMessage: headshotUploadMessage,
              replacementAvailable: api?.replaceHeadshot !== undefined,
              onRetry: retryHeadshotPreview,
              onImageError: markHeadshotPreviewFailed,
              onSessionChange: (sessionId) =>
                dispatchProfileHeadshotDetails({
                  type: "headshot-session-selected",
                  sessionId,
                }),
              onUpload: (file) => void uploadOrganizerHeadshot(file),
              mutationStatus: headshotMutationStatus,
              mutationMessage: headshotMutationMessage,
            },
            ...(eventTemporalContext === undefined
              ? {}
              : { temporalContext: eventTemporalContext }),
            editDraft,
            statusOptions,
            profileMutationStatus,
            profileMutationMessage,
            editError,
            saveBusy,
            downloadErrors,
            downloadBusyAssetId,
            onEditDraftChange: updateEdit,
            onSave: (event) => void saveSpeaker(event),
            onBeginEdit: beginEdit,
            onAssetDownload: requestAssetDownload,
          },
          showCsv,
          importProps: {
            busy: importBusy,
            previewBusy: importPreviewBusy,
            commitBusy: importCommitBusy,
            apiAvailable: api !== null,
            fileName: importFileName,
            preview: importPreview,
            onOpenChange: (open) => dispatchRoster({ type: "csv-dialog-changed", open }),
            onPreview: (file: File) => void previewCsv(file),
            onCommit: () => void commitCsv(),
          },
          onQueryChange: (nextQuery) => dispatchRoster({ type: "query-changed", query: nextQuery }),
          onToggleFilters: () => dispatchRoster({ type: "filters-toggled" }),
          onStatusFilterChange: (status) =>
            dispatchRoster({ type: "status-filter-changed", status }),
          onSessionFilterChange: (session) =>
            dispatchRoster({ type: "session-filter-changed", session }),
          onProgressFilterChange: (progress) =>
            dispatchRoster({ type: "progress-filter-changed", progress }),
          onClearFilters: clearRosterFilters,
          onOpenSelectedEmail: openSelectedEmail,
          onToggleVisibleSelection: toggleVisibleSpeakerSelection,
          onClearSelection: clearSpeakerSelection,
          onToggleSelection: toggleSpeakerSelection,
          onBeginEdit: beginEdit,
          onAddSpeaker: () => dispatchRoster({ type: "add-dialog-changed", open: true }),
          onImportCsv: () => dispatchRoster({ type: "csv-dialog-toggled" }),
        }}
        tasks={{
          rosterEmpty,
          reminderSectionRef,
          taskProps: {
            apiAvailable: api !== null,
            loading,
            rosterLoaded: roster !== null,
            speakers,
            taskTitle,
            taskDueAt,
            taskAssigneeIdSet,
            taskBusy,
            progress,
            progressError,
            progressSectionVisible,
            taskDefinitions: onboardingTaskDefinitions,
            ...(eventTemporalContext === undefined
              ? {}
              : { temporalContext: eventTemporalContext }),
            onLoadProgress: () =>
              dispatchRoster({ type: "progress-context-changed", context: secondaryContextKey }),
            onTaskTitleChange: (title) =>
              dispatchImportTaskInvitation({ type: "task-title-changed", title }),
            onTaskDueChange: (dueAt) =>
              dispatchImportTaskInvitation({ type: "task-due-changed", dueAt }),
            onToggleAssignee: toggleAssignee,
            onAssign: (event) => void assignTask(event),
            onAddSpeaker: () => {
              dispatchRoster({ type: "view-changed", view: "roster" });
              dispatchRoster({ type: "add-dialog-changed", open: true });
            },
            onImportCsv: () => {
              dispatchRoster({ type: "view-changed", view: "roster" });
              dispatchRoster({ type: "csv-dialog-changed", open: true });
            },
          },
          progressProps: {
            progress,
            progressError,
            progressRows,
            progressFilter,
            onProgressFilterChange: (nextProgress) =>
              dispatchRoster({ type: "progress-filter-changed", progress: nextProgress }),
          },
          reminderProps: {
            reminderEligibility,
            eligibleItems: eligibleReminderItems,
            ineligibleItems: ineligibleReminderItems,
            tasks: reminderTasks,
            onSaveOffsets: updateTaskReminderOffsets,
          },
        }}
        email={{
          rosterEmpty,
          selectedSpeakerIds,
          emailSectionRef,
          onAddSpeaker: () => {
            dispatchRoster({ type: "view-changed", view: "roster" });
            dispatchRoster({ type: "add-dialog-changed", open: true });
          },
          onImportCsv: () => {
            dispatchRoster({ type: "view-changed", view: "roster" });
            dispatchRoster({ type: "csv-dialog-changed", open: true });
          },
          onChooseRecipients: () => dispatchRoster({ type: "view-changed", view: "roster" }),
          emailProps: {
            templates: emailTemplates,
            apiAvailable: api !== null,
            templateId: emailTemplateId,
            templateVersion: emailTemplateVersion,
            templateName: emailTemplateName,
            subject: emailSubject,
            html: emailHtml,
            text: emailText,
            editorMode: emailEditorMode,
            preview: emailPreview,
            previewCurrent: emailPreviewCurrent,
            sends: emailSends,
            notice: emailNotice,
            confirmOpen: emailConfirmOpen,
            saveBusy: emailSaveBusy,
            previewBusy: emailPreviewBusy,
            sendBusy: emailSendBusy,
            historyBusy: emailHistoryBusy,
            onTemplateChange: (value) => {
              invalidateEmailPreview();
              if (value === "new") {
                dispatchEmail({
                  type: "email-template-selected",
                  id: "",
                  version: undefined,
                  template: null,
                });
                emailCreateTemplateIdRef.current = null;
                return;
              }
              const separator = value.lastIndexOf(":");
              const nextId = separator < 0 ? value : value.slice(0, separator);
              const rawVersion = separator < 0 ? "" : value.slice(separator + 1);
              const nextVersion = Number(rawVersion);
              const template = emailTemplates.find(
                (candidate) => candidate.id === nextId && candidate.version === nextVersion,
              );
              dispatchEmail({
                type: "email-template-selected",
                id: nextId,
                version: Number.isFinite(nextVersion) ? nextVersion : undefined,
                template: template ?? null,
              });
              emailCreateTemplateIdRef.current = null;
            },
            onUseStarter: () => {
              dispatchEmail({
                type: "email-template-selected",
                id: "",
                version: undefined,
                template: null,
              });
              emailCreateTemplateIdRef.current = null;
              dispatchEmail({
                type: "email-template-name-changed",
                name: SPEAKER_WELCOME_EMAIL_STARTER.name,
              });
              dispatchEmail({
                type: "email-subject-changed",
                subject: SPEAKER_WELCOME_EMAIL_STARTER.subject,
              });
              dispatchEmail({
                type: "email-html-changed",
                html: SPEAKER_WELCOME_EMAIL_STARTER.html,
              });
              dispatchEmail({
                type: "email-text-changed",
                text: SPEAKER_WELCOME_EMAIL_STARTER.text,
              });
              dispatchEmail({ type: "email-editor-mode-changed", mode: "visual" });
              invalidateEmailPreview();
            },
            onTemplateNameChange: (name) => {
              dispatchEmail({ type: "email-template-name-changed", name });
              invalidateEmailPreview();
            },
            onSubjectChange: (subject) => {
              dispatchEmail({ type: "email-subject-changed", subject });
              invalidateEmailPreview();
            },
            onHtmlChange: (html) => {
              dispatchEmail({ type: "email-html-changed", html });
              invalidateEmailPreview();
            },
            onTextChange: (text) => {
              dispatchEmail({ type: "email-text-changed", text });
              invalidateEmailPreview();
            },
            onEditorModeChange: (mode) =>
              dispatchEmail({ type: "email-editor-mode-changed", mode }),
            onSave: () => void saveEmailTemplate(),
            onPreview: () => void previewBulkEmail(),
            onConfirmOpenChange: (open) => dispatchEmail({ type: "email-confirm-changed", open }),
            onSend: () => void sendBulkEmail(),
            onRefreshHistory: () => void refreshEmailHistory(),
          },
        }}
      />
    </div>
  );
}
export function SpeakerWorkspaceController(props: SpeakerWorkspaceProps) {
  return useSpeakerWorkspaceController(props);
}
