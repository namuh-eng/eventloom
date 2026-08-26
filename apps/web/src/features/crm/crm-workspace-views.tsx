"use client";

import Link from "next/link";
import {
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button as UiButton } from "@/components/ui/button";
import styles from "./crm-workspace.module.css";
import { createCrmApi, idempotencyKey, settleCrmOutreachRecipients } from "./crm-workspace-api";
import {
  type ContactDraft,
  CRM_MERGE_SCALAR_FIELDS,
  CRM_PIPELINE_STAGES,
  type CrmAnalytics,
  type CrmApi,
  type CrmContact,
  type CrmContactStatus,
  type CrmDuplicateReport,
  type CrmEvent,
  type CrmEventProjectionResult,
  type CrmHistoryEntry,
  type CrmImportPreviewResult,
  type CrmImportResult,
  type CrmMergePlan,
  type CrmMergePreview,
  type CrmMergeResult,
  type CrmMergeScalarField,
  type CrmNote,
  type CrmOutreachCommand,
  type CrmOutreachPreview,
  type CrmPipelineEntry,
  type CrmPipelineStage,
  type CrmSegment,
  type CrmSegmentRule,
  type CrmWorkspaceContactFilter,
  type CsvPreview,
  createCrmWorkspaceReadCoordinator,
  displayName,
  draftInput,
  focusAndScroll,
  humanErrorSummary,
  mergeCustomFieldHasConflict,
  mergeCustomFieldKeys,
  mergeFieldHasConflict,
  mergeFieldValue,
  mergePlanKey,
  mergeValuePresent,
  messageFromError,
  parseCsvPreview,
  preferNewerCrmContact,
  refreshCrmAnalyticsAfterContactSave,
  refreshCrmDuplicatesAfterContactSave,
  refreshSelectedContactAfterCollectionReload,
  renderVariablePreview,
} from "./crm-workspace-model";
import {
  CrmWorkspaceAddContactSection,
  CrmWorkspaceContactDetailSection,
  CrmWorkspaceContactOperationsSection,
  CrmWorkspaceDirectoryCard,
  CrmWorkspaceDirectoryExtras,
  CrmWorkspaceOutreachSection,
} from "./crm-workspace-sections";

const EMPTY_CONTACT_IDS: readonly string[] = [];
const EMPTY_OUTREACH_RESULTS: readonly CrmOutreachCommand[] = [];

type CrmStateUpdate<T> = T | ((current: T) => T);

function resolveCrmStateUpdate<T>(current: T, update: CrmStateUpdate<T>): T {
  return typeof update === "function" ? (update as (current: T) => T)(current) : update;
}
export function isCurrentCrmOutreachRefresh(
  expectedBusyLease: number,
  currentBusyLease: number,
  expectedSelectionGeneration: number,
  currentSelectionGeneration: number,
): boolean {
  return (
    expectedBusyLease === currentBusyLease &&
    expectedSelectionGeneration === currentSelectionGeneration
  );
}

type CrmMergeViewState = {
  readonly mergeSelection: readonly string[];
  readonly mergeReviewPlanKey: string | null;
  readonly mergeReviewOpen: boolean;
  readonly mergeConfirmed: boolean;
  readonly mergeSubmitting: boolean;
  readonly mergeCompleted: boolean;
  readonly mergeCompletedContactId: string | null;
  readonly mergeFieldWinners: Partial<Record<CrmMergeScalarField, string>>;
  readonly mergeCustomFieldWinners: Record<string, string>;
  readonly pipelineStage: CrmPipelineStage;
  readonly pipelineNote: string;
};

type CrmMergeViewAction =
  | {
      readonly type: "merge-selection-changed";
      readonly contactId: string;
      readonly checked: boolean;
    }
  | {
      readonly type: "set-merge-review-plan-key";
      readonly value: CrmStateUpdate<string | null>;
    }
  | {
      readonly type: "set-merge-review-open";
      readonly value: CrmStateUpdate<boolean>;
    }
  | {
      readonly type: "set-merge-confirmed";
      readonly value: CrmStateUpdate<boolean>;
    }
  | {
      readonly type: "set-merge-submitting";
      readonly value: CrmStateUpdate<boolean>;
    }
  | {
      readonly type: "set-merge-completed";
      readonly value: CrmStateUpdate<boolean>;
    }
  | {
      readonly type: "set-merge-completed-contact-id";
      readonly value: CrmStateUpdate<string | null>;
    }
  | {
      readonly type: "set-merge-field-winners";
      readonly value: CrmStateUpdate<Partial<Record<CrmMergeScalarField, string>>>;
    }
  | {
      readonly type: "set-merge-custom-field-winners";
      readonly value: CrmStateUpdate<Record<string, string>>;
    }
  | { readonly type: "set-pipeline-stage"; readonly value: CrmStateUpdate<CrmPipelineStage> }
  | { readonly type: "set-pipeline-note"; readonly value: CrmStateUpdate<string> }
  | { readonly type: "contact-changed"; readonly pipelineStage: CrmPipelineStage | undefined }
  | {
      readonly type: "open-merge-review";
      readonly fieldWinners: Partial<Record<CrmMergeScalarField, string>>;
      readonly customFieldWinners: Record<string, string>;
    }
  | { readonly type: "close-merge-review" }
  | { readonly type: "merge-completed"; readonly contactId: string };

function crmMergeViewReducer(
  state: CrmMergeViewState,
  action: CrmMergeViewAction,
): CrmMergeViewState {
  switch (action.type) {
    case "merge-selection-changed":
      return {
        ...state,
        mergeSelection: action.checked
          ? [...new Set([...state.mergeSelection, action.contactId])]
          : state.mergeSelection.filter((id) => id !== action.contactId),
        mergeReviewOpen: false,
        mergeConfirmed: false,
        mergeCompleted: false,
        mergeReviewPlanKey: null,
        mergeCompletedContactId: null,
      };
    case "set-merge-review-plan-key":
      return {
        ...state,
        mergeReviewPlanKey: resolveCrmStateUpdate(state.mergeReviewPlanKey, action.value),
      };
    case "set-merge-review-open":
      return {
        ...state,
        mergeReviewOpen: resolveCrmStateUpdate(state.mergeReviewOpen, action.value),
      };
    case "set-merge-confirmed":
      return {
        ...state,
        mergeConfirmed: resolveCrmStateUpdate(state.mergeConfirmed, action.value),
      };
    case "set-merge-submitting":
      return {
        ...state,
        mergeSubmitting: resolveCrmStateUpdate(state.mergeSubmitting, action.value),
      };
    case "set-merge-completed":
      return {
        ...state,
        mergeCompleted: resolveCrmStateUpdate(state.mergeCompleted, action.value),
      };
    case "set-merge-completed-contact-id":
      return {
        ...state,
        mergeCompletedContactId: resolveCrmStateUpdate(state.mergeCompletedContactId, action.value),
      };
    case "set-merge-field-winners":
      return {
        ...state,
        mergeFieldWinners: resolveCrmStateUpdate(state.mergeFieldWinners, action.value),
      };
    case "set-merge-custom-field-winners":
      return {
        ...state,
        mergeCustomFieldWinners: resolveCrmStateUpdate(state.mergeCustomFieldWinners, action.value),
      };
    case "set-pipeline-stage":
      return { ...state, pipelineStage: resolveCrmStateUpdate(state.pipelineStage, action.value) };
    case "set-pipeline-note":
      return { ...state, pipelineNote: resolveCrmStateUpdate(state.pipelineNote, action.value) };
    case "contact-changed":
      return {
        ...state,
        pipelineStage: action.pipelineStage ?? state.pipelineStage,
        mergeSelection: [],
        mergeReviewPlanKey: null,
        mergeReviewOpen: false,
        mergeConfirmed: false,
        mergeFieldWinners: {},
        mergeCustomFieldWinners: {},
      };
    case "open-merge-review":
      return {
        ...state,
        mergeFieldWinners: action.fieldWinners,
        mergeCustomFieldWinners: action.customFieldWinners,
        mergeConfirmed: false,
        mergeCompleted: false,
        mergeCompletedContactId: null,
        mergeReviewOpen: true,
      };
    case "close-merge-review":
      return { ...state, mergeReviewOpen: false, mergeConfirmed: false };
    case "merge-completed":
      return {
        ...state,
        mergeCompleted: true,
        mergeCompletedContactId: action.contactId,
      };
  }
}

type CrmDirectoryState = {
  readonly contacts: readonly CrmContact[];
  readonly segments: readonly CrmSegment[];
  readonly events: readonly CrmEvent[];
  readonly analytics: CrmAnalytics | null;
  readonly contactsLoading: boolean;
  readonly segmentsLoading: boolean;
  readonly eventsLoading: boolean;
  readonly analyticsLoading: boolean;
};

type CrmDirectoryAction =
  | {
      readonly type: "set-contacts";
      readonly value: CrmStateUpdate<readonly CrmContact[]>;
    }
  | {
      readonly type: "set-segments";
      readonly value: CrmStateUpdate<readonly CrmSegment[]>;
    }
  | {
      readonly type: "set-events";
      readonly value: CrmStateUpdate<readonly CrmEvent[]>;
    }
  | {
      readonly type: "set-analytics";
      readonly value: CrmStateUpdate<CrmAnalytics | null>;
    }
  | { readonly type: "set-contacts-loading"; readonly value: CrmStateUpdate<boolean> }
  | { readonly type: "set-segments-loading"; readonly value: CrmStateUpdate<boolean> }
  | { readonly type: "set-events-loading"; readonly value: CrmStateUpdate<boolean> }
  | { readonly type: "set-analytics-loading"; readonly value: CrmStateUpdate<boolean> }
  | {
      readonly type: "replace-contact";
      readonly contact: CrmContact;
    }
  | { readonly type: "append-segment"; readonly segment: CrmSegment }
  | { readonly type: "segment-contacts-loaded"; readonly contacts: readonly CrmContact[] };

function crmDirectoryReducer(
  state: CrmDirectoryState,
  action: CrmDirectoryAction,
): CrmDirectoryState {
  switch (action.type) {
    case "set-contacts":
      return { ...state, contacts: resolveCrmStateUpdate(state.contacts, action.value) };
    case "set-segments":
      return { ...state, segments: resolveCrmStateUpdate(state.segments, action.value) };
    case "set-events":
      return { ...state, events: resolveCrmStateUpdate(state.events, action.value) };
    case "set-analytics":
      return { ...state, analytics: resolveCrmStateUpdate(state.analytics, action.value) };
    case "set-contacts-loading":
      return {
        ...state,
        contactsLoading: resolveCrmStateUpdate(state.contactsLoading, action.value),
      };
    case "set-segments-loading":
      return {
        ...state,
        segmentsLoading: resolveCrmStateUpdate(state.segmentsLoading, action.value),
      };
    case "set-events-loading":
      return {
        ...state,
        eventsLoading: resolveCrmStateUpdate(state.eventsLoading, action.value),
      };
    case "set-analytics-loading":
      return {
        ...state,
        analyticsLoading: resolveCrmStateUpdate(state.analyticsLoading, action.value),
      };
    case "replace-contact": {
      const without = state.contacts.filter((contact) => contact.id !== action.contact.id);
      return {
        ...state,
        contacts: [...without, action.contact].sort((left, right) =>
          displayName(left).localeCompare(displayName(right)),
        ),
      };
    }
    case "append-segment":
      return { ...state, segments: [...state.segments, action.segment] };
    case "segment-contacts-loaded":
      return { ...state, contacts: action.contacts };
  }
}
type CrmContactSelectionState = {
  readonly selectedContact: CrmContact | undefined;
  readonly selectedContactIds: readonly string[];
  readonly history: readonly CrmHistoryEntry[];
  readonly pipelineHistory: readonly CrmPipelineEntry[];
  readonly notes: readonly CrmNote[];
  readonly duplicates: CrmDuplicateReport | null;
  readonly outreachRecipients: readonly CrmContact[];
  readonly outreachPreview: CrmOutreachPreview | null;
  readonly outreachResults: readonly CrmOutreachCommand[];
  readonly lastAddedEventId: string | null;
  readonly lastEventResult: CrmEventProjectionResult | null;
};

type CrmContactSelectionAction =
  | {
      readonly type: "set-selected-contact";
      readonly value: CrmStateUpdate<CrmContact | undefined>;
    }
  | {
      readonly type: "set-selected-contact-ids";
      readonly value: CrmStateUpdate<readonly string[]>;
    }
  | { readonly type: "set-history"; readonly value: CrmStateUpdate<readonly CrmHistoryEntry[]> }
  | {
      readonly type: "set-pipeline-history";
      readonly value: CrmStateUpdate<readonly CrmPipelineEntry[]>;
    }
  | { readonly type: "set-notes"; readonly value: CrmStateUpdate<readonly CrmNote[]> }
  | {
      readonly type: "set-duplicates";
      readonly value: CrmStateUpdate<CrmDuplicateReport | null>;
    }
  | {
      readonly type: "set-outreach-recipients";
      readonly value: CrmStateUpdate<readonly CrmContact[]>;
    }
  | {
      readonly type: "set-outreach-preview";
      readonly value: CrmStateUpdate<CrmOutreachPreview | null>;
    }
  | {
      readonly type: "set-outreach-results";
      readonly value: CrmStateUpdate<readonly CrmOutreachCommand[]>;
    }
  | {
      readonly type: "set-last-added-event-id";
      readonly value: CrmStateUpdate<string | null>;
    }
  | {
      readonly type: "set-last-event-result";
      readonly value: CrmStateUpdate<CrmEventProjectionResult | null>;
    }
  | {
      readonly type: "contact-loaded";
      readonly contact: CrmContact;
      readonly history: readonly CrmHistoryEntry[];
      readonly pipelineHistory: readonly CrmPipelineEntry[];
      readonly notes: readonly CrmNote[];
      readonly duplicates: CrmDuplicateReport;
    }
  | {
      readonly type: "selection-changed";
      readonly contactIds: readonly string[];
      readonly recipients: readonly CrmContact[];
    }
  | { readonly type: "start-add" }
  | { readonly type: "cancel-edit" }
  | {
      readonly type: "contact-saved";
      readonly contact: CrmContact;
    }
  | { readonly type: "contact-refreshed"; readonly contact: CrmContact }
  | { readonly type: "pipeline-contact-updated"; readonly contact: CrmContact }
  | { readonly type: "note-added"; readonly note: CrmNote }
  | {
      readonly type: "event-added";
      readonly eventId: string;
      readonly result: CrmEventProjectionResult;
    }
  | {
      readonly type: "outreach-preview-created";
      readonly recipients: readonly CrmContact[];
      readonly preview: CrmOutreachPreview;
    }
  | { readonly type: "outreach-results-set"; readonly results: readonly CrmOutreachCommand[] };

function crmContactSelectionReducer(
  state: CrmContactSelectionState,
  action: CrmContactSelectionAction,
): CrmContactSelectionState {
  switch (action.type) {
    case "set-selected-contact":
      return {
        ...state,
        selectedContact: resolveCrmStateUpdate(state.selectedContact, action.value),
      };
    case "set-selected-contact-ids":
      return {
        ...state,
        selectedContactIds: resolveCrmStateUpdate(state.selectedContactIds, action.value),
      };
    case "set-history":
      return { ...state, history: resolveCrmStateUpdate(state.history, action.value) };
    case "set-pipeline-history":
      return {
        ...state,
        pipelineHistory: resolveCrmStateUpdate(state.pipelineHistory, action.value),
      };
    case "set-notes":
      return { ...state, notes: resolveCrmStateUpdate(state.notes, action.value) };
    case "set-duplicates":
      return { ...state, duplicates: resolveCrmStateUpdate(state.duplicates, action.value) };
    case "set-outreach-recipients":
      return {
        ...state,
        outreachRecipients: resolveCrmStateUpdate(state.outreachRecipients, action.value),
      };
    case "set-outreach-preview":
      return {
        ...state,
        outreachPreview: resolveCrmStateUpdate(state.outreachPreview, action.value),
      };
    case "set-outreach-results":
      return {
        ...state,
        outreachResults: resolveCrmStateUpdate(state.outreachResults, action.value),
      };
    case "set-last-added-event-id":
      return {
        ...state,
        lastAddedEventId: resolveCrmStateUpdate(state.lastAddedEventId, action.value),
      };
    case "set-last-event-result":
      return {
        ...state,
        lastEventResult: resolveCrmStateUpdate(state.lastEventResult, action.value),
      };
    case "contact-loaded":
      return {
        ...state,
        selectedContact: action.contact,
        history: action.history,
        pipelineHistory: action.pipelineHistory,
        notes: action.notes,
        duplicates: action.duplicates,
        outreachRecipients: [action.contact],
        outreachPreview: null,
        outreachResults: [],
        lastAddedEventId: null,
        lastEventResult: null,
      };
    case "selection-changed":
      return {
        ...state,
        selectedContactIds: action.contactIds,
        outreachRecipients: action.recipients,
        outreachPreview: null,
        outreachResults: [],
      };
    case "start-add":
      return {
        ...state,
        selectedContactIds: [],
        selectedContact: undefined,
        duplicates: null,
      };
    case "cancel-edit":
      return { ...state, selectedContact: undefined };
    case "contact-saved":
      return {
        ...state,
        selectedContact: action.contact,
        outreachRecipients: [action.contact],
      };
    case "contact-refreshed":
      if (preferNewerCrmContact(state.selectedContact, action.contact) === state.selectedContact) {
        return state;
      }
      return {
        ...state,
        selectedContact: action.contact,
        outreachRecipients: state.outreachRecipients.map((candidate) =>
          candidate.id === action.contact.id ? action.contact : candidate,
        ),
      };
    case "pipeline-contact-updated":
      return { ...state, selectedContact: action.contact };
    case "note-added":
      return { ...state, notes: [action.note, ...state.notes] };
    case "event-added":
      return {
        ...state,
        lastAddedEventId: action.eventId,
        lastEventResult: action.result,
      };
    case "outreach-preview-created":
      return {
        ...state,
        outreachRecipients: action.recipients,
        outreachPreview: action.preview,
        outreachResults: [],
      };
    case "outreach-results-set":
      return { ...state, outreachResults: action.results };
  }
}
type CrmMergeRequestState = {
  readonly preview: CrmMergePreview | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly planKey: string | null;
  readonly result: CrmMergeResult | null;
};

type CrmMergeRequestAction =
  | { readonly type: "preview-start" }
  | {
      readonly type: "preview-success";
      readonly preview: CrmMergePreview;
      readonly planKey: string;
    }
  | { readonly type: "preview-error"; readonly error: string }
  | { readonly type: "preview-finished" }
  | { readonly type: "merge-result"; readonly result: CrmMergeResult };

function crmMergeRequestReducer(
  state: CrmMergeRequestState,
  action: CrmMergeRequestAction,
): CrmMergeRequestState {
  switch (action.type) {
    case "preview-start":
      return {
        ...state,
        preview: null,
        planKey: null,
        error: null,
        loading: true,
      };
    case "preview-success":
      return {
        ...state,
        preview: action.preview,
        planKey: action.planKey,
        loading: false,
      };
    case "preview-error":
      return { ...state, error: action.error, loading: false };
    case "preview-finished":
      return { ...state, loading: false };
    case "merge-result":
      return { ...state, result: action.result };
  }
}
export interface CrmWorkspaceViewProps {
  readonly organizationId: string;
  readonly contacts: readonly CrmContact[];
  readonly selectedContact?: CrmContact | undefined;
  readonly segments: readonly CrmSegment[];
  readonly events: readonly CrmEvent[];
  readonly history: readonly CrmHistoryEntry[];
  readonly pipelineHistory: readonly CrmPipelineEntry[];
  readonly notes: readonly CrmNote[];
  readonly duplicates: CrmDuplicateReport | null;
  readonly analytics: CrmAnalytics | null;
  readonly loading?: boolean;
  readonly initialImportOpen?: boolean;
  readonly initialImportCsv?: string;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly statusMessage?: string | null;
  readonly query?: string;
  readonly companyFilter?: string;
  readonly tagsFilter?: string;
  readonly pipelineFilter?: CrmPipelineStage | "";
  readonly statusFilter?: CrmContactStatus | "";
  readonly selectedContactId?: string | null;
  readonly selectedContactIds?: readonly string[];
  readonly onQueryChange?: (value: string) => void;
  readonly onCompanyChange?: (value: string) => void;
  readonly onTagsChange?: (value: string) => void;
  readonly onPipelineFilterChange?: (value: CrmPipelineStage | "") => void;
  readonly onStatusFilterChange?: (value: CrmContactStatus | "") => void;
  readonly onRefresh?: () => void;
  readonly onSelectContact?: (contactId: string) => void;
  readonly onSelectionChange?: (contactIds: readonly string[]) => void;
  readonly onStartAdd?: () => void;
  readonly onSaveContact?: (draft: ContactDraft) => Promise<void>;
  readonly onCancelEdit?: () => void;
  readonly onPreviewImport?: (csv: string) => Promise<void>;
  readonly importPreviewResult?: CrmImportPreviewResult | null;
  readonly importPreviewLoading?: boolean;
  readonly importPreviewError?: string | null;
  readonly importPreviewSource?: string | null;
  readonly onImport?: (csv: string) => Promise<void>;
  readonly importResult?: CrmImportResult | null;
  readonly onCreateSegment?: (input: {
    name: string;
    description: string;
    rules: readonly CrmSegmentRule[];
  }) => Promise<void>;
  readonly onSelectSegment?: (segmentId: string) => void;
  readonly onFindDuplicates?: () => void;
  readonly onMerge?: (plan: CrmMergePlan) => Promise<void>;
  readonly onPreviewMerge?: (plan: CrmMergePlan) => Promise<void>;
  readonly mergePreview?: CrmMergePreview | null;
  readonly mergePreviewLoading?: boolean;
  readonly mergePreviewError?: string | null;
  readonly mergePreviewPlanKey?: string | null;
  readonly mergeResult?: CrmMergeResult | null;
  readonly onMovePipeline?: (contactId: string, stage: CrmPipelineStage) => void;
  readonly onEnrollPipeline?: (input: {
    contactId: string;
    stage: CrmPipelineStage;
    score: string;
    rationale: string;
  }) => Promise<void>;
  readonly onSavePipeline?: (stage: CrmPipelineStage, note: string) => Promise<void>;
  readonly onAddNote?: (body: string) => Promise<void>;
  readonly onAddToEvent?: (input: {
    eventId: string;
    role: "speaker" | "prospect" | "attendee" | "sponsor";
    note: string;
  }) => Promise<void>;
  readonly lastAddedEventId?: string | null;
  readonly lastEventResult?: CrmEventProjectionResult | null;
  readonly onPreviewOutreach?: (input: {
    subject: string;
    body: string;
    contactIds?: readonly string[];
    segmentId?: string;
    eventId?: string;
  }) => Promise<void>;
  readonly outreachPreview?: CrmOutreachPreview | null;
  readonly outreachRecipients?: readonly CrmContact[];
  readonly onSendOutreach?: () => Promise<void>;
  readonly outreachResults?: readonly CrmOutreachCommand[];
  readonly onAnalyticsEventDrillThrough?: (eventId: string) => void;
}

interface CrmViewFormState {
  readonly importCsv: string;
  readonly importFileName: string;
  readonly importPreview: CsvPreview | null;
  readonly readImportFile: (file: File) => Promise<void>;
  readonly updateImportCsv: (csv: string) => void;
  readonly noteBody: string;
  readonly noteError: string | null;
  readonly setNoteBody: (value: string) => void;
  readonly saveNote: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly eventId: string;
  readonly eventRole: "speaker" | "prospect" | "attendee" | "sponsor";
  readonly eventNote: string;
  readonly setEventId: (value: string) => void;
  readonly setEventRole: (value: "speaker" | "prospect" | "attendee" | "sponsor") => void;
  readonly setEventNote: (value: string) => void;
  readonly saveEvent: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly outreachSegmentId: string;
  readonly outreachContextSegmentId: string;
  readonly outreachEventId: string;
  readonly outreachSubject: string;
  readonly outreachBody: string;
  readonly setOutreachSegmentId: (value: string) => void;
  readonly setOutreachContextSegmentId: (value: string) => void;
  readonly setOutreachEventId: (value: string) => void;
  readonly setOutreachSubject: (value: string) => void;
  readonly setOutreachBody: (value: string) => void;
  readonly previewOutreach: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly effectiveOutreachSegmentId: string;
  readonly outreachComposerRef: RefObject<HTMLDivElement | null>;
}

function useCrmViewFormState({
  initialImportCsv = "",
  selectedContactIds = EMPTY_CONTACT_IDS,
  onPreviewImport,
  onAddNote,
  onAddToEvent,
  onPreviewOutreach,
}: {
  readonly initialImportCsv?: string;
  readonly selectedContactIds?: readonly string[];
  readonly onPreviewImport: ((csv: string) => Promise<void>) | undefined;
  readonly onAddNote: ((body: string) => Promise<void>) | undefined;
  readonly onAddToEvent:
    | ((input: {
        eventId: string;
        role: "speaker" | "prospect" | "attendee" | "sponsor";
        note: string;
      }) => Promise<void>)
    | undefined;
  readonly onPreviewOutreach:
    | ((input: {
        subject: string;
        body: string;
        contactIds?: readonly string[];
        segmentId?: string;
        eventId?: string;
      }) => Promise<void>)
    | undefined;
}): CrmViewFormState {
  const [importCsv, setImportCsv] = useState(initialImportCsv);
  const [importFileName, setImportFileName] = useState("");
  const [importPreview, setImportPreview] = useState<CsvPreview | null>(
    initialImportCsv.trim() ? parseCsvPreview(initialImportCsv) : null,
  );
  const [noteBody, setNoteBody] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [eventId, setEventId] = useState("");
  const [eventRole, setEventRole] = useState<"speaker" | "prospect" | "attendee" | "sponsor">(
    "prospect",
  );
  const [eventNote, setEventNote] = useState("");
  const [outreachSegmentId, setOutreachSegmentId] = useState("");
  const [outreachContextSegmentId, setOutreachContextSegmentId] = useState("");
  const [outreachEventId, setOutreachEventId] = useState("");
  const [outreachSubject, setOutreachSubject] = useState("Invitation from {{first_name}}");
  const [outreachBody, setOutreachBody] = useState(
    "Hi {{first_name}},\n\nWe would love to have you join us.",
  );
  const outreachComposerRef = useRef<HTMLDivElement>(null);
  const initialImportPreviewRequested = useRef(false);
  const effectiveOutreachSegmentId =
    outreachSegmentId === "__selected__" && selectedContactIds.length === 0
      ? ""
      : outreachSegmentId;

  useEffect(() => {
    if (
      !initialImportPreviewRequested.current &&
      initialImportCsv.trim() &&
      onPreviewImport !== undefined
    ) {
      initialImportPreviewRequested.current = true;
      void onPreviewImport(initialImportCsv);
    }
  }, [initialImportCsv, onPreviewImport]);

  async function readImportFile(file: File): Promise<void> {
    try {
      const csv = await file.text();
      setImportFileName(file.name);
      setImportCsv(csv);
      setImportPreview(parseCsvPreview(csv));
      if (csv.trim() && onPreviewImport !== undefined) void onPreviewImport(csv);
    } catch (reason) {
      setImportFileName("");
      setImportCsv("");
      setImportPreview({
        headers: [],
        rows: [],
        mapping: [],
        issues: [messageFromError(reason)],
      });
    }
  }
  function updateImportCsv(csv: string): void {
    setImportCsv(csv);
    setImportFileName("");
    setImportPreview(csv.trim() ? parseCsvPreview(csv) : null);
    if (csv.trim() && onPreviewImport !== undefined) void onPreviewImport(csv);
  }
  async function saveNote(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!noteBody.trim() || onAddNote === undefined) return;
    setNoteError(null);
    try {
      await onAddNote(noteBody.trim());
      setNoteBody("");
    } catch (reason) {
      setNoteError(messageFromError(reason));
    }
  }
  async function saveEvent(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!eventId.trim() || onAddToEvent === undefined) return;
    await onAddToEvent({ eventId: eventId.trim(), role: eventRole, note: eventNote.trim() });
    setEventNote("");
  }
  async function previewOutreach(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (onPreviewOutreach === undefined) return;
    const selectedAudience = effectiveOutreachSegmentId === "__selected__";
    const segmentId = selectedAudience ? outreachContextSegmentId : effectiveOutreachSegmentId;
    await onPreviewOutreach({
      subject: outreachSubject,
      body: outreachBody,
      ...(selectedAudience && selectedContactIds.length > 0
        ? { contactIds: selectedContactIds }
        : {}),
      ...(segmentId ? { segmentId } : {}),
      ...(outreachEventId ? { eventId: outreachEventId } : {}),
    });
  }
  return {
    importCsv,
    importFileName,
    importPreview,
    readImportFile,
    updateImportCsv,
    noteBody,
    noteError,
    setNoteBody,
    saveNote,
    eventId,
    eventRole,
    eventNote,
    setEventId,
    setEventRole,
    setEventNote,
    saveEvent,
    outreachSegmentId,
    outreachContextSegmentId,
    outreachEventId,
    outreachSubject,
    outreachBody,
    setOutreachSegmentId,
    setOutreachContextSegmentId,
    setOutreachEventId,
    setOutreachSubject,
    setOutreachBody,
    previewOutreach,
    effectiveOutreachSegmentId,
    outreachComposerRef,
  };
}

interface CrmMergeViewStateResult {
  readonly mergeCandidates: readonly CrmDuplicateReport["matches"][number][];
  readonly mergeSelection: readonly string[];
  readonly mergeSelectionSet: ReadonlySet<string>;
  readonly selectedMergeContacts: readonly CrmDuplicateReport["matches"][number][];
  readonly mergeReviewContacts: readonly CrmContact[];
  readonly mergeCustomKeys: readonly string[];
  readonly conflictingScalarFields: readonly {
    readonly key: CrmMergeScalarField;
    readonly label: string;
  }[];
  readonly conflictingCustomKeys: readonly string[];
  readonly mergeReviewOpen: boolean;
  readonly mergeReviewPlanKey: string | null;
  readonly mergeConfirmed: boolean;
  readonly mergeSubmitting: boolean;
  readonly mergeCompleted: boolean;
  readonly mergeCompletedContactId: string | null;
  readonly mergeFieldWinners: Partial<Record<CrmMergeScalarField, string>>;
  readonly mergeCustomFieldWinners: Record<string, string>;
  readonly mergePreviewCurrent: boolean;
  readonly mergePreviewHasConflicts: boolean;
  readonly mergeCommitReady: boolean;
  readonly onToggleMergeSelection: (contactId: string, checked: boolean) => void;
  readonly onOpenMergeReview: () => void;
  readonly onCloseMergeReview: () => void;
  readonly onSubmitMerge: () => Promise<void>;
  readonly onSetMergeFieldWinners: (value: Partial<Record<CrmMergeScalarField, string>>) => void;
  readonly onSetMergeCustomFieldWinners: (value: Record<string, string>) => void;
  readonly onSetMergeConfirmed: (value: boolean) => void;
  readonly onRequestMergePreview: (
    fieldWinners: Partial<Record<CrmMergeScalarField, string>>,
    customFieldWinners: Readonly<Record<string, string>>,
  ) => void;
  readonly duplicateReviewRef: RefObject<HTMLDivElement | null>;
  readonly focusDuplicateReview: () => void;
  readonly pipelineStage: CrmPipelineStage;
  readonly pipelineNote: string;
  readonly onPipelineStageChange: (value: CrmPipelineStage) => void;
  readonly onPipelineNoteChange: (value: string) => void;
}

function useCrmMergeViewState({
  organizationId,
  selectedContact,
  duplicates,
  mergePreview = null,
  mergePreviewLoading,
  mergePreviewError,
  mergePreviewPlanKey,
  onPreviewMerge,
  onMerge,
}: {
  readonly organizationId: string;
  readonly selectedContact: CrmContact | undefined;
  readonly duplicates: CrmDuplicateReport | null;
  readonly mergePreview: CrmMergePreview | null;
  readonly mergePreviewLoading?: boolean;
  readonly mergePreviewError: string | null;
  readonly mergePreviewPlanKey: string | null;
  readonly onPreviewMerge: ((plan: CrmMergePlan) => Promise<void>) | undefined;
  readonly onMerge: ((plan: CrmMergePlan) => Promise<void>) | undefined;
}): CrmMergeViewStateResult {
  const [mergeViewState, dispatchMergeView] = useReducer(crmMergeViewReducer, {
    mergeSelection: [],
    mergeReviewPlanKey: null,
    mergeReviewOpen: false,
    mergeConfirmed: false,
    mergeSubmitting: false,
    mergeCompleted: false,
    mergeCompletedContactId: null,
    mergeFieldWinners: {},
    mergeCustomFieldWinners: {},
    pipelineStage: selectedContact?.pipelineStage ?? "new",
    pipelineNote: "",
  });
  const mergeSubmitRef = useRef(false);
  const duplicateReviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dispatchMergeView({ type: "contact-changed", pipelineStage: selectedContact?.pipelineStage });
  }, [selectedContact]);
  const mergeCandidates =
    selectedContact && duplicates?.contactId === selectedContact.id
      ? duplicates.matches.filter(
          (match) =>
            match.contact.id !== selectedContact.id &&
            match.contact.organizationId === organizationId &&
            match.contact.status === "active",
        )
      : [];
  const mergeSelectionSet = useMemo(
    () => new Set(mergeViewState.mergeSelection),
    [mergeViewState.mergeSelection],
  );
  const selectedMergeContacts = mergeCandidates.filter((match) =>
    mergeSelectionSet.has(match.contact.id),
  );
  const mergeReviewContacts = selectedContact
    ? [selectedContact, ...selectedMergeContacts.map((match) => match.contact)]
    : [];
  const mergeCustomKeys = mergeCustomFieldKeys(mergeReviewContacts);
  const conflictingScalarFields = CRM_MERGE_SCALAR_FIELDS.filter(({ key }) =>
    mergeFieldHasConflict(mergeReviewContacts, key),
  );
  const conflictingCustomKeys = mergeCustomKeys.filter((key) =>
    mergeCustomFieldHasConflict(mergeReviewContacts, key),
  );
  const mergePreviewCurrent =
    mergePreview !== null &&
    mergePreview.preview === true &&
    mergePreviewPlanKey !== null &&
    mergePreviewPlanKey === mergeViewState.mergeReviewPlanKey;
  const mergePreviewHasConflicts = (mergePreview?.participantConflicts.length ?? 0) > 0;
  const mergeCommitReady =
    mergePreviewCurrent &&
    mergePreview?.canCommit === true &&
    !mergePreviewHasConflicts &&
    !mergePreviewLoading &&
    mergePreviewError === null;

  function setMergeReviewPlanKey(value: CrmStateUpdate<string | null>): void {
    dispatchMergeView({ type: "set-merge-review-plan-key", value });
  }
  function requestMergePreview(
    fieldWinners: Partial<Record<CrmMergeScalarField, string>>,
    customFieldWinners: Readonly<Record<string, string>>,
  ): void {
    if (!selectedContact || selectedMergeContacts.length === 0 || onPreviewMerge === undefined) {
      setMergeReviewPlanKey(null);
      return;
    }
    const plan: CrmMergePlan = {
      duplicateContactIds: selectedMergeContacts.map((match) => match.contact.id),
      fieldWinners: Object.fromEntries(
        CRM_MERGE_SCALAR_FIELDS.map(({ key }) => [key, fieldWinners[key] ?? selectedContact.id]),
      ) as Record<CrmMergeScalarField, string>,
      customFieldWinners: { ...customFieldWinners },
    };
    setMergeReviewPlanKey(mergePlanKey(plan));
    void onPreviewMerge(plan);
  }
  function openMergeReview(): void {
    if (!selectedContact || selectedMergeContacts.length === 0) return;
    const nextFieldWinners: Partial<Record<CrmMergeScalarField, string>> = {};
    for (const { key: field } of CRM_MERGE_SCALAR_FIELDS) {
      const primaryValue = mergeFieldValue(selectedContact, field);
      const fallback = selectedMergeContacts.find((match) =>
        mergeValuePresent(mergeFieldValue(match.contact, field)),
      );
      nextFieldWinners[field] =
        mergeFieldHasConflict(mergeReviewContacts, field) && !mergeValuePresent(primaryValue)
          ? (fallback?.contact.id ?? selectedContact.id)
          : selectedContact.id;
    }
    const nextCustomFieldWinners: Record<string, string> = {};
    for (const key of mergeCustomKeys) {
      const primaryValue = Object.hasOwn(selectedContact.customFields, key)
        ? selectedContact.customFields[key]
        : "";
      const fallback = selectedMergeContacts.find((match) =>
        mergeValuePresent(match.contact.customFields[key]),
      );
      nextCustomFieldWinners[key] =
        mergeCustomFieldHasConflict(mergeReviewContacts, key) && !mergeValuePresent(primaryValue)
          ? (fallback?.contact.id ?? selectedContact.id)
          : selectedContact.id;
    }
    dispatchMergeView({
      type: "open-merge-review",
      fieldWinners: nextFieldWinners,
      customFieldWinners: nextCustomFieldWinners,
    });
    requestMergePreview(nextFieldWinners, nextCustomFieldWinners);
  }
  function closeMergeReview(): void {
    if (mergeViewState.mergeSubmitting) return;
    dispatchMergeView({ type: "close-merge-review" });
  }
  async function submitMerge(): Promise<void> {
    if (
      mergeSubmitRef.current ||
      mergeViewState.mergeSubmitting ||
      !selectedContact ||
      selectedMergeContacts.length === 0 ||
      !mergeViewState.mergeConfirmed ||
      !mergeCommitReady ||
      onMerge === undefined
    ) {
      return;
    }
    const primaryContact = selectedContact;
    mergeSubmitRef.current = true;
    dispatchMergeView({ type: "set-merge-submitting", value: true });
    const fieldWinners = {} as Record<CrmMergeScalarField, string>;
    for (const { key: field } of CRM_MERGE_SCALAR_FIELDS) {
      fieldWinners[field] = mergeViewState.mergeFieldWinners[field] ?? primaryContact.id;
    }
    try {
      await onMerge({
        duplicateContactIds: selectedMergeContacts.map((match) => match.contact.id),
        fieldWinners,
        customFieldWinners: { ...mergeViewState.mergeCustomFieldWinners },
      });
      dispatchMergeView({ type: "merge-completed", contactId: primaryContact.id });
    } catch {
      // The owning workspace presents the API error; keep the review open for a retry.
    } finally {
      mergeSubmitRef.current = false;
      dispatchMergeView({ type: "set-merge-submitting", value: false });
    }
  }
  return {
    mergeCandidates,
    mergeSelection: mergeViewState.mergeSelection,
    mergeSelectionSet,
    selectedMergeContacts,
    mergeReviewContacts,
    mergeCustomKeys,
    conflictingScalarFields,
    conflictingCustomKeys,
    mergeReviewOpen: mergeViewState.mergeReviewOpen,
    mergeReviewPlanKey: mergeViewState.mergeReviewPlanKey,
    mergeConfirmed: mergeViewState.mergeConfirmed,
    mergeSubmitting: mergeViewState.mergeSubmitting,
    mergeCompleted: mergeViewState.mergeCompleted,
    mergeCompletedContactId: mergeViewState.mergeCompletedContactId,
    mergeFieldWinners: mergeViewState.mergeFieldWinners,
    mergeCustomFieldWinners: mergeViewState.mergeCustomFieldWinners,
    mergePreviewCurrent,
    mergePreviewHasConflicts,
    mergeCommitReady,
    onToggleMergeSelection: (contactId, checked) =>
      dispatchMergeView({ type: "merge-selection-changed", contactId, checked }),
    onOpenMergeReview: openMergeReview,
    onCloseMergeReview: closeMergeReview,
    onSubmitMerge: submitMerge,
    onSetMergeFieldWinners: (value) =>
      dispatchMergeView({ type: "set-merge-field-winners", value }),
    onSetMergeCustomFieldWinners: (value) =>
      dispatchMergeView({ type: "set-merge-custom-field-winners", value }),
    onSetMergeConfirmed: (value) => dispatchMergeView({ type: "set-merge-confirmed", value }),
    onRequestMergePreview: requestMergePreview,
    duplicateReviewRef,
    focusDuplicateReview: () => focusAndScroll(duplicateReviewRef.current),
    pipelineStage: mergeViewState.pipelineStage,
    pipelineNote: mergeViewState.pipelineNote,
    onPipelineStageChange: (value) => dispatchMergeView({ type: "set-pipeline-stage", value }),
    onPipelineNoteChange: (value) => dispatchMergeView({ type: "set-pipeline-note", value }),
  };
}

function crmCurrentFilterRules(
  query: string,
  companyFilter: string,
  tagsFilter: string,
  pipelineFilter: CrmPipelineStage | "",
  statusFilter: CrmContactStatus | "",
): readonly CrmSegmentRule[] {
  const rules: CrmSegmentRule[] = [];
  if (query.trim()) rules.push({ field: "displayName", operator: "contains", value: query.trim() });
  if (companyFilter.trim())
    rules.push({ field: "company", operator: "contains", value: companyFilter.trim() });
  for (const tag of tagsFilter
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    rules.push({ field: "tags", operator: "contains", value: tag });
  }
  if (pipelineFilter) rules.push({ field: "pipelineStage", operator: "eq", value: pipelineFilter });
  if (statusFilter) rules.push({ field: "status", operator: "eq", value: statusFilter });
  return rules;
}

interface CrmWorkspaceIntroProps {
  readonly organizationId: string;
  readonly busy: boolean;
  readonly onRefresh: (() => void) | undefined;
}

function CrmWorkspaceIntro({ organizationId, busy, onRefresh }: CrmWorkspaceIntroProps) {
  return (
    <>
      <a className={styles.skipLink} href="#crm-content">
        Skip to CRM content
      </a>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Organization workspace · {organizationId}</p>
          <h1>Organization CRM</h1>
          <p className={styles.heroText}>
            One authoritative directory for speaker identity, event relationships, pipeline
            follow-up, and personalized outreach.
          </p>
        </div>
        <div className={styles.heroActions}>
          <Link
            className={styles.secondaryButton}
            href={`/admin/organizations/${encodeURIComponent(organizationId)}/members`}
          >
            Members
          </Link>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={onRefresh}
            disabled={busy}
          >
            Refresh
          </button>
        </div>
      </header>
    </>
  );
}

interface CrmWorkspaceStatusProps {
  readonly contacts: readonly CrmContact[];
  readonly analytics: CrmAnalytics | null;
  readonly error: string | null;
  readonly statusMessage: string | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly onRefresh: (() => void) | undefined;
}

function CrmWorkspaceStatus({
  contacts,
  analytics,
  error,
  statusMessage,
  loading,
  busy,
  onRefresh,
}: CrmWorkspaceStatusProps) {
  return (
    <>
      {analytics && contacts.length > 0 ? (
        <section className={styles.summaryBar} aria-labelledby="crm-analytics-summary-title">
          <div>
            <p className={styles.eyebrow}>CRM analytics</p>
            <h2 id="crm-analytics-summary-title">Contact snapshot</h2>
            <p className={styles.resultCount}>
              {analytics.totalContacts} total contacts · {analytics.activeContacts} active
            </p>
            <p className={styles.muted}>
              Pipeline:{" "}
              {CRM_PIPELINE_STAGES.map(
                (stage) => `${stage}: ${analytics.contactsByPipelineStage[stage] ?? 0}`,
              ).join(" · ")}
            </p>
          </div>
          <a className={styles.secondaryButton} href="#crm-analytics" aria-controls="crm-analytics">
            Open CRM analytics
          </a>
        </section>
      ) : null}
      {error ? (
        <Alert className={styles.alert} variant="destructive">
          <AlertTitle>We couldn't complete that CRM action.</AlertTitle>
          <AlertDescription>
            <p>{humanErrorSummary(error)}</p>
            {onRefresh ? (
              <UiButton
                className={styles.alertAction}
                type="button"
                onClick={onRefresh}
                disabled={busy}
              >
                Try again
              </UiButton>
            ) : null}
            {error.includes("\n") ? (
              <details className={styles.errorDetails}>
                <summary>Show technical details</summary>
                <pre>{error}</pre>
              </details>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className={styles.status} role="status" aria-live="polite">
        {statusMessage}
      </div>
      {loading ? (
        <div
          className={styles.loading}
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="Loading organization CRM data"
        >
          Loading organization CRM data…
        </div>
      ) : null}
    </>
  );
}

interface CrmWorkspaceDirectoryAreaProps {
  readonly organizationId: string;
  readonly contacts: readonly CrmContact[];
  readonly selectedContactId: string | null;
  readonly selectedContactIds: readonly string[];
  readonly loading: boolean;
  readonly busy: boolean;
  readonly query: string;
  readonly companyFilter: string;
  readonly tagsFilter: string;
  readonly pipelineFilter: CrmPipelineStage | "";
  readonly statusFilter: CrmContactStatus | "";
  readonly onQueryChange: ((value: string) => void) | undefined;
  readonly onCompanyChange: ((value: string) => void) | undefined;
  readonly onTagsChange: ((value: string) => void) | undefined;
  readonly onPipelineFilterChange: ((value: CrmPipelineStage | "") => void) | undefined;
  readonly onStatusFilterChange: ((value: CrmContactStatus | "") => void) | undefined;
  readonly onStartAdd: (() => void) | undefined;
  readonly onSaveContact: ((draft: ContactDraft) => Promise<void>) | undefined;
  readonly onSelectionChange: ((contactIds: readonly string[]) => void) | undefined;
  readonly onImport: ((csv: string) => Promise<void>) | undefined;
  readonly initialImportOpen: boolean;
  readonly onCommunicateWithSelected: () => void;
  readonly onSelectionContactOpened: (contactId: string) => void;
  readonly importCsv: string;
  readonly updateImportCsv: (csv: string) => void;
  readonly readImportFile: (file: File) => Promise<void>;
  readonly importFileName: string;
  readonly importPreview: CsvPreview | null;
  readonly importPreviewResult: CrmImportPreviewResult | null;
  readonly importPreviewLoading: boolean;
  readonly importPreviewError: string | null;
  readonly importPreviewCurrent: boolean;
  readonly importPreviewHasErrors: boolean;
  readonly importResult: CrmImportResult | null;
}

function CrmWorkspaceDirectoryArea({
  organizationId,
  contacts,
  selectedContactId,
  selectedContactIds,
  loading,
  busy,
  query,
  companyFilter,
  tagsFilter,
  pipelineFilter,
  statusFilter,
  onQueryChange,
  onCompanyChange,
  onTagsChange,
  onPipelineFilterChange,
  onStatusFilterChange,
  onStartAdd,
  onSaveContact,
  onSelectionChange,
  onImport,
  initialImportOpen,
  onCommunicateWithSelected,
  onSelectionContactOpened,
  importCsv,
  updateImportCsv,
  readImportFile,
  importFileName,
  importPreview,
  importPreviewResult,
  importPreviewLoading,
  importPreviewError,
  importPreviewCurrent,
  importPreviewHasErrors,
  importResult,
}: CrmWorkspaceDirectoryAreaProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImport, setShowImport] = useState(initialImportOpen);
  return (
    <>
      <CrmWorkspaceDirectoryCard
        contacts={contacts}
        selectedContactId={selectedContactId}
        selectedContactIds={selectedContactIds}
        loading={loading}
        busy={busy}
        query={query}
        companyFilter={companyFilter}
        tagsFilter={tagsFilter}
        pipelineFilter={pipelineFilter}
        statusFilter={statusFilter}
        onQueryChange={onQueryChange ?? (() => undefined)}
        onCompanyChange={onCompanyChange ?? (() => undefined)}
        onTagsChange={onTagsChange ?? (() => undefined)}
        onPipelineFilterChange={onPipelineFilterChange ?? (() => undefined)}
        onStatusFilterChange={onStatusFilterChange ?? (() => undefined)}
        onStartAdd={() => {
          setShowAddForm(true);
          onStartAdd?.();
        }}
        showImport={showImport}
        onToggleImport={() => setShowImport((current) => !current)}
        onOpenImport={() => setShowImport(true)}
        onCommunicateWithSelected={onCommunicateWithSelected}
        onSelectionChange={(ids) => onSelectionChange?.(ids)}
        onSelectDirectoryContact={(id) => {
          setShowAddForm(false);
          onSelectionContactOpened(id);
        }}
        readImportFile={readImportFile}
        importCsv={importCsv}
        updateImportCsv={updateImportCsv}
        importFileName={importFileName}
        importPreview={importPreview}
        importPreviewResult={importPreviewResult}
        importPreviewLoading={importPreviewLoading}
        importPreviewError={importPreviewError}
        importPreviewCurrent={importPreviewCurrent}
        importPreviewHasErrors={importPreviewHasErrors}
        onImport={onImport}
        importResult={importResult}
      />
      {showAddForm ? (
        <CrmWorkspaceAddContactSection
          organizationId={organizationId}
          busy={busy}
          onSaveContact={async (draft) => {
            await onSaveContact?.(draft);
            setShowAddForm(false);
          }}
          onClose={() => setShowAddForm(false)}
        />
      ) : null}
    </>
  );
}

interface CrmWorkspaceContactDetailAreaProps {
  readonly organizationId: string;
  readonly selectedContact: CrmContact;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly onSaveContact: ((draft: ContactDraft) => Promise<void>) | undefined;
  readonly onCancelEdit: (() => void) | undefined;
  readonly onOpenOutreach: () => void;
  readonly onFindDuplicates: (() => void) | undefined;
  readonly onToggleMergeSelection: (contactId: string, checked: boolean) => void;
  readonly mergeCandidates: readonly CrmDuplicateReport["matches"][number][];
  readonly duplicates: CrmDuplicateReport | null;
  readonly mergeSelectionSet: ReadonlySet<string>;
  readonly selectedMergeContacts: readonly CrmDuplicateReport["matches"][number][];
  readonly mergeReviewContacts: readonly CrmContact[];
  readonly mergeCustomKeys: readonly string[];
  readonly conflictingScalarFields: readonly {
    readonly key: CrmMergeScalarField;
    readonly label: string;
  }[];
  readonly conflictingCustomKeys: readonly string[];
  readonly mergeReviewOpen: boolean;
  readonly mergePreview: CrmMergePreview | null;
  readonly mergePreviewLoading: boolean;
  readonly mergePreviewError: string | null;
  readonly mergePreviewCurrent: boolean;
  readonly mergePreviewHasConflicts: boolean;
  readonly mergeResult: CrmMergeResult | null;
  readonly mergeCommitReady: boolean;
  readonly mergeCompleted: boolean;
  readonly mergeCompletedContactId: string | null;
  readonly mergeFieldWinners: Partial<Record<CrmMergeScalarField, string>>;
  readonly mergeCustomFieldWinners: Record<string, string>;
  readonly mergeConfirmed: boolean;
  readonly mergeSubmitting: boolean;
  readonly onOpenMergeReview: () => void;
  readonly onCloseMergeReview: () => void;
  readonly onSubmitMerge: () => Promise<void>;
  readonly onSetMergeFieldWinners: (value: Partial<Record<CrmMergeScalarField, string>>) => void;
  readonly onSetMergeCustomFieldWinners: (value: Record<string, string>) => void;
  readonly onSetMergeConfirmed: (value: boolean) => void;
  readonly onRequestMergePreview: (
    fieldWinners: Partial<Record<CrmMergeScalarField, string>>,
    customFieldWinners: Readonly<Record<string, string>>,
  ) => void;
}

function CrmWorkspaceContactDetailArea(props: CrmWorkspaceContactDetailAreaProps) {
  return (
    <CrmWorkspaceContactDetailSection
      organizationId={props.organizationId}
      selectedContact={props.selectedContact}
      busy={props.busy}
      loading={props.loading}
      onSaveContact={props.onSaveContact}
      onCancelEdit={props.onCancelEdit}
      onOpenOutreach={props.onOpenOutreach}
      onFindDuplicates={props.onFindDuplicates}
      onToggleMergeSelection={props.onToggleMergeSelection}
      mergeCandidates={props.mergeCandidates}
      duplicates={props.duplicates}
      mergeSelectionSet={props.mergeSelectionSet}
      selectedMergeContacts={props.selectedMergeContacts}
      mergeReviewContacts={props.mergeReviewContacts}
      mergeCustomKeys={props.mergeCustomKeys}
      conflictingScalarFields={props.conflictingScalarFields}
      conflictingCustomKeys={props.conflictingCustomKeys}
      mergeReviewOpen={props.mergeReviewOpen}
      mergePreview={props.mergePreview}
      mergePreviewLoading={props.mergePreviewLoading}
      mergePreviewError={props.mergePreviewError}
      mergePreviewCurrent={props.mergePreviewCurrent}
      mergePreviewHasConflicts={props.mergePreviewHasConflicts}
      mergeResult={props.mergeResult}
      mergeCommitReady={props.mergeCommitReady}
      mergeCompleted={props.mergeCompleted}
      mergeCompletedContactId={props.mergeCompletedContactId}
      mergeFieldWinners={props.mergeFieldWinners}
      mergeCustomFieldWinners={props.mergeCustomFieldWinners}
      mergeConfirmed={props.mergeConfirmed}
      mergeSubmitting={props.mergeSubmitting}
      onOpenMergeReview={props.onOpenMergeReview}
      onCloseMergeReview={props.onCloseMergeReview}
      onSubmitMerge={props.onSubmitMerge}
      onSetMergeFieldWinners={props.onSetMergeFieldWinners}
      onSetMergeCustomFieldWinners={props.onSetMergeCustomFieldWinners}
      onSetMergeConfirmed={props.onSetMergeConfirmed}
      onRequestMergePreview={props.onRequestMergePreview}
    />
  );
}

interface CrmWorkspaceMainContentProps {
  readonly organizationId: string;
  readonly contacts: readonly CrmContact[];
  readonly analytics: CrmAnalytics | null;
  readonly selectedContact: CrmContact | undefined;
  readonly selectedContactId: string | null;
  readonly selectedContactIds: readonly string[];
  readonly segments: readonly CrmSegment[];
  readonly events: readonly CrmEvent[];
  readonly pipelineHistory: readonly CrmPipelineEntry[];
  readonly notes: readonly CrmNote[];
  readonly timelineHistory: readonly CrmHistoryEntry[];
  readonly duplicates: CrmDuplicateReport | null;
  readonly currentRules: readonly CrmSegmentRule[];
  readonly loading: boolean;
  readonly busy: boolean;
  readonly query: string;
  readonly companyFilter: string;
  readonly tagsFilter: string;
  readonly pipelineFilter: CrmPipelineStage | "";
  readonly statusFilter: CrmContactStatus | "";
  readonly onQueryChange: ((value: string) => void) | undefined;
  readonly onCompanyChange: ((value: string) => void) | undefined;
  readonly onTagsChange: ((value: string) => void) | undefined;
  readonly onPipelineFilterChange: ((value: CrmPipelineStage | "") => void) | undefined;
  readonly onStatusFilterChange: ((value: CrmContactStatus | "") => void) | undefined;
  readonly onStartAdd: (() => void) | undefined;
  readonly onSaveContact: ((draft: ContactDraft) => Promise<void>) | undefined;
  readonly onSelectContact: ((contactId: string) => void) | undefined;
  readonly onSelectionChange: ((contactIds: readonly string[]) => void) | undefined;
  readonly onCancelEdit: (() => void) | undefined;
  readonly onImport: ((csv: string) => Promise<void>) | undefined;
  readonly initialImportOpen: boolean;
  readonly importCsv: string;
  readonly importFileName: string;
  readonly importPreview: CsvPreview | null;
  readonly updateImportCsv: (csv: string) => void;
  readonly readImportFile: (file: File) => Promise<void>;
  readonly importPreviewResult: CrmImportPreviewResult | null;
  readonly importPreviewLoading: boolean;
  readonly importPreviewError: string | null;
  readonly importPreviewCurrent: boolean;
  readonly importPreviewHasErrors: boolean;
  readonly importResult: CrmImportResult | null;
  readonly onFindDuplicates: (() => void) | undefined;
  readonly mergeCandidates: readonly CrmDuplicateReport["matches"][number][];
  readonly mergeSelectionSet: ReadonlySet<string>;
  readonly selectedMergeContacts: readonly CrmDuplicateReport["matches"][number][];
  readonly mergeReviewContacts: readonly CrmContact[];
  readonly mergeCustomKeys: readonly string[];
  readonly conflictingScalarFields: readonly {
    readonly key: CrmMergeScalarField;
    readonly label: string;
  }[];
  readonly conflictingCustomKeys: readonly string[];
  readonly mergeReviewOpen: boolean;
  readonly mergePreview: CrmMergePreview | null;
  readonly mergePreviewLoading: boolean;
  readonly mergePreviewError: string | null;
  readonly mergePreviewCurrent: boolean;
  readonly mergePreviewHasConflicts: boolean;
  readonly mergeResult: CrmMergeResult | null;
  readonly mergeCommitReady: boolean;
  readonly mergeCompleted: boolean;
  readonly mergeCompletedContactId: string | null;
  readonly mergeFieldWinners: Partial<Record<CrmMergeScalarField, string>>;
  readonly mergeCustomFieldWinners: Record<string, string>;
  readonly mergeConfirmed: boolean;
  readonly mergeSubmitting: boolean;
  readonly onToggleMergeSelection: (contactId: string, checked: boolean) => void;
  readonly onOpenMergeReview: () => void;
  readonly onCloseMergeReview: () => void;
  readonly onSubmitMerge: () => Promise<void>;
  readonly onSetMergeFieldWinners: (value: Partial<Record<CrmMergeScalarField, string>>) => void;
  readonly onSetMergeCustomFieldWinners: (value: Record<string, string>) => void;
  readonly onSetMergeConfirmed: (value: boolean) => void;
  readonly onRequestMergePreview: (
    fieldWinners: Partial<Record<CrmMergeScalarField, string>>,
    customFieldWinners: Readonly<Record<string, string>>,
  ) => void;
  readonly pipelineStage: CrmPipelineStage;
  readonly pipelineNote: string;
  readonly onPipelineStageChange: (value: CrmPipelineStage) => void;
  readonly onPipelineNoteChange: (value: string) => void;
  readonly selectedEvent: CrmEvent | undefined;
  readonly eventId: string;
  readonly eventRole: "speaker" | "prospect" | "attendee" | "sponsor";
  readonly eventNote: string;
  readonly setEventId: (value: string) => void;
  readonly setEventRole: (value: "speaker" | "prospect" | "attendee" | "sponsor") => void;
  readonly setEventNote: (value: string) => void;
  readonly lastAddedEventId: string | null;
  readonly lastEventResult: CrmEventProjectionResult | null;
  readonly noteBody: string;
  readonly noteError: string | null;
  readonly setNoteBody: (value: string) => void;
  readonly saveEvent: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly saveNote: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onSavePipeline: ((stage: CrmPipelineStage, note: string) => Promise<void>) | undefined;
  readonly effectiveOutreachSegmentId: string;
  readonly outreachContextSegmentId: string;
  readonly outreachEventId: string;
  readonly outreachSubject: string;
  readonly outreachBody: string;
  readonly setOutreachSegmentId: (value: string) => void;
  readonly setOutreachContextSegmentId: (value: string) => void;
  readonly setOutreachEventId: (value: string) => void;
  readonly setOutreachSubject: (value: string) => void;
  readonly setOutreachBody: (value: string) => void;
  readonly previewOutreach: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly outreachPreview: CrmOutreachPreview | null;
  readonly outreachHasUnknownTags: boolean;
  readonly outreachResults: readonly CrmOutreachCommand[];
  readonly onSendOutreach: (() => Promise<void>) | undefined;
  readonly outreachComposerRef: RefObject<HTMLDivElement | null>;
  readonly onCreateSegment:
    | ((input: {
        name: string;
        description: string;
        rules: readonly CrmSegmentRule[];
      }) => Promise<void>)
    | undefined;
  readonly onSelectSegment: ((segmentId: string) => void) | undefined;
  readonly onMovePipeline: ((contactId: string, stage: CrmPipelineStage) => void) | undefined;
  readonly onEnrollPipeline:
    | ((input: {
        contactId: string;
        stage: CrmPipelineStage;
        score: string;
        rationale: string;
      }) => Promise<void>)
    | undefined;
  readonly onAnalyticsEventDrillThrough: ((eventId: string) => void) | undefined;
}

function CrmWorkspaceMainContent(props: CrmWorkspaceMainContentProps) {
  const {
    organizationId,
    contacts,
    analytics,
    selectedContact,
    selectedContactId,
    selectedContactIds,
    segments,
    events,
    pipelineHistory,
    notes,
    timelineHistory,
    duplicates,
    currentRules,
    loading,
    busy,
    query,
    companyFilter,
    tagsFilter,
    pipelineFilter,
    statusFilter,
    onQueryChange,
    onCompanyChange,
    onTagsChange,
    onPipelineFilterChange,
    onStatusFilterChange,
    onStartAdd,
    onSaveContact,
    onSelectContact,
    onSelectionChange,
    onCancelEdit,
    onImport,
    initialImportOpen,
    importCsv,
    importFileName,
    importPreview,
    updateImportCsv,
    readImportFile,
    importPreviewResult,
    importPreviewLoading,
    importPreviewError,
    importPreviewCurrent,
    importPreviewHasErrors,
    importResult,
    onFindDuplicates,
    mergeCandidates,
    mergeSelectionSet,
    selectedMergeContacts,
    mergeReviewContacts,
    mergeCustomKeys,
    conflictingScalarFields,
    conflictingCustomKeys,
    mergeReviewOpen,
    mergePreview,
    mergePreviewLoading,
    mergePreviewError,
    mergePreviewCurrent,
    mergePreviewHasConflicts,
    mergeResult,
    mergeCommitReady,
    mergeCompleted,
    mergeCompletedContactId,
    mergeFieldWinners,
    mergeCustomFieldWinners,
    mergeConfirmed,
    mergeSubmitting,
    onToggleMergeSelection,
    onOpenMergeReview,
    onCloseMergeReview,
    onSubmitMerge,
    onSetMergeFieldWinners,
    onSetMergeCustomFieldWinners,
    onSetMergeConfirmed,
    onRequestMergePreview,
    pipelineStage,
    pipelineNote,
    onPipelineStageChange,
    onPipelineNoteChange,
    selectedEvent,
    eventId,
    eventRole,
    eventNote,
    setEventId,
    setEventRole,
    setEventNote,
    lastAddedEventId,
    lastEventResult,
    noteBody,
    noteError,
    setNoteBody,
    saveEvent,
    saveNote,
    onSavePipeline,
    effectiveOutreachSegmentId,
    outreachContextSegmentId,
    outreachEventId,
    outreachSubject,
    outreachBody,
    setOutreachSegmentId,
    setOutreachContextSegmentId,
    setOutreachEventId,
    setOutreachSubject,
    setOutreachBody,
    previewOutreach,
    outreachPreview,
    outreachHasUnknownTags,
    outreachResults,
    onSendOutreach,
    outreachComposerRef,
    onCreateSegment,
    onSelectSegment,
    onMovePipeline,
    onEnrollPipeline,
    onAnalyticsEventDrillThrough,
  } = props;
  return (
    <>
      <CrmWorkspaceDirectoryArea
        organizationId={organizationId}
        contacts={contacts}
        selectedContactId={selectedContactId}
        selectedContactIds={selectedContactIds}
        loading={loading}
        busy={busy}
        query={query}
        companyFilter={companyFilter}
        tagsFilter={tagsFilter}
        pipelineFilter={pipelineFilter}
        statusFilter={statusFilter}
        onQueryChange={onQueryChange}
        onCompanyChange={onCompanyChange}
        onTagsChange={onTagsChange}
        onPipelineFilterChange={onPipelineFilterChange}
        onStatusFilterChange={onStatusFilterChange}
        onStartAdd={onStartAdd}
        onSaveContact={onSaveContact}
        onSelectionChange={onSelectionChange}
        onImport={onImport}
        initialImportOpen={initialImportOpen}
        onCommunicateWithSelected={() => {
          setOutreachSegmentId("__selected__");
          focusAndScroll(outreachComposerRef.current);
        }}
        onSelectionContactOpened={(id) => {
          onSelectContact?.(id);
          onSetMergeConfirmed(false);
        }}
        importCsv={importCsv}
        updateImportCsv={updateImportCsv}
        readImportFile={readImportFile}
        importFileName={importFileName}
        importPreview={importPreview}
        importPreviewResult={importPreviewResult}
        importPreviewLoading={importPreviewLoading}
        importPreviewError={importPreviewError}
        importPreviewCurrent={importPreviewCurrent}
        importPreviewHasErrors={importPreviewHasErrors}
        importResult={importResult}
      />
      {selectedContact ? (
        <CrmWorkspaceContactDetailArea
          organizationId={organizationId}
          selectedContact={selectedContact}
          busy={busy}
          loading={loading}
          onSaveContact={onSaveContact}
          onCancelEdit={onCancelEdit}
          onOpenOutreach={() => {
            setOutreachSegmentId("");
            focusAndScroll(outreachComposerRef.current);
          }}
          onFindDuplicates={onFindDuplicates}
          onToggleMergeSelection={onToggleMergeSelection}
          mergeCandidates={mergeCandidates}
          duplicates={duplicates}
          mergeSelectionSet={mergeSelectionSet}
          selectedMergeContacts={selectedMergeContacts}
          mergeReviewContacts={mergeReviewContacts}
          mergeCustomKeys={mergeCustomKeys}
          conflictingScalarFields={conflictingScalarFields}
          conflictingCustomKeys={conflictingCustomKeys}
          mergeReviewOpen={mergeReviewOpen}
          mergePreview={mergePreview}
          mergePreviewLoading={mergePreviewLoading}
          mergePreviewError={mergePreviewError}
          mergePreviewCurrent={mergePreviewCurrent}
          mergePreviewHasConflicts={mergePreviewHasConflicts}
          mergeResult={mergeResult}
          mergeCommitReady={mergeCommitReady}
          mergeCompleted={mergeCompleted}
          mergeCompletedContactId={mergeCompletedContactId}
          mergeFieldWinners={mergeFieldWinners}
          mergeCustomFieldWinners={mergeCustomFieldWinners}
          mergeConfirmed={mergeConfirmed}
          mergeSubmitting={mergeSubmitting}
          onOpenMergeReview={onOpenMergeReview}
          onCloseMergeReview={onCloseMergeReview}
          onSubmitMerge={onSubmitMerge}
          onSetMergeFieldWinners={onSetMergeFieldWinners}
          onSetMergeCustomFieldWinners={onSetMergeCustomFieldWinners}
          onSetMergeConfirmed={onSetMergeConfirmed}
          onRequestMergePreview={onRequestMergePreview}
        />
      ) : null}
      {selectedContact ? (
        <CrmWorkspaceContactOperationsSection
          organizationId={organizationId}
          selectedContact={selectedContact}
          busy={busy}
          pipelineStage={pipelineStage}
          pipelineNote={pipelineNote}
          onPipelineStageChange={onPipelineStageChange}
          onPipelineNoteChange={onPipelineNoteChange}
          pipelineHistory={pipelineHistory}
          events={events}
          eventId={eventId}
          eventRole={eventRole}
          eventNote={eventNote}
          onEventIdChange={setEventId}
          onEventRoleChange={setEventRole}
          onEventNoteChange={setEventNote}
          selectedEvent={selectedEvent}
          lastAddedEventId={lastAddedEventId}
          lastEventResult={lastEventResult}
          notes={notes}
          timelineHistory={timelineHistory}
          noteBody={noteBody}
          noteError={noteError}
          onNoteBodyChange={setNoteBody}
          saveEvent={saveEvent}
          saveNote={saveNote}
          onSavePipeline={onSavePipeline}
        />
      ) : contacts.length > 0 ? (
        <div className={styles.callout}>
          Select a contact to view identity, history, pipeline, event relationships, and outreach
          controls.
        </div>
      ) : null}
      {selectedContact || selectedContactIds.length > 0 ? (
        <CrmWorkspaceOutreachSection
          selectedContactIds={selectedContactIds}
          segments={segments}
          events={events}
          busy={busy}
          outreachSegmentId={effectiveOutreachSegmentId}
          outreachContextSegmentId={outreachContextSegmentId}
          outreachEventId={outreachEventId}
          outreachSubject={outreachSubject}
          outreachBody={outreachBody}
          outreachPreview={outreachPreview}
          outreachHasUnknownTags={outreachHasUnknownTags}
          outreachResults={outreachResults}
          onSegmentChange={setOutreachSegmentId}
          onContextSegmentChange={setOutreachContextSegmentId}
          onEventChange={setOutreachEventId}
          onSubjectChange={setOutreachSubject}
          onBodyChange={setOutreachBody}
          previewOutreach={previewOutreach}
          onSendOutreach={onSendOutreach}
          outreachComposerRef={outreachComposerRef}
        />
      ) : null}
      {contacts.length > 0 ? (
        <CrmWorkspaceDirectoryExtras
          contacts={contacts}
          segments={segments}
          events={events}
          analytics={analytics}
          busy={busy}
          currentRules={currentRules}
          onCreateSegment={onCreateSegment}
          onSelectSegment={onSelectSegment}
          onMovePipeline={onMovePipeline}
          onSelectContact={(id) => onSelectContact?.(id)}
          onEnrollPipeline={onEnrollPipeline}
          onAnalyticsEventDrillThrough={onAnalyticsEventDrillThrough}
        />
      ) : null}
    </>
  );
}

export function CrmWorkspaceView({
  organizationId,
  contacts,
  selectedContact,
  segments,
  events,
  history,
  pipelineHistory,
  notes,
  duplicates,
  analytics,
  loading = false,
  initialImportOpen = false,
  initialImportCsv = "",
  busy = false,
  error = null,
  statusMessage = null,
  query = "",
  companyFilter = "",
  tagsFilter = "",
  pipelineFilter = "",
  statusFilter = "",
  selectedContactId = null,
  selectedContactIds = EMPTY_CONTACT_IDS,
  onQueryChange,
  onCompanyChange,
  onTagsChange,
  onPipelineFilterChange,
  onStatusFilterChange,
  onRefresh,
  onSelectContact,
  onSelectionChange,
  onStartAdd,
  onSaveContact,
  onCancelEdit,
  onImport,
  onPreviewImport,
  importPreviewResult = null,
  importPreviewLoading = false,
  importPreviewError = null,
  importPreviewSource = null,
  importResult = null,
  onCreateSegment,
  onSelectSegment,
  onFindDuplicates,
  onMerge,
  onPreviewMerge,
  mergePreview = null,
  mergePreviewLoading = false,
  mergePreviewError = null,
  mergePreviewPlanKey = null,
  mergeResult = null,
  onMovePipeline,
  onEnrollPipeline,
  onSavePipeline,
  onAddNote,
  onAddToEvent,
  lastAddedEventId = null,
  lastEventResult = null,
  onPreviewOutreach,
  outreachPreview = null,
  onSendOutreach,
  outreachResults = EMPTY_OUTREACH_RESULTS,
  onAnalyticsEventDrillThrough,
}: CrmWorkspaceViewProps) {
  const formState = useCrmViewFormState({
    initialImportCsv,
    selectedContactIds,
    onPreviewImport,
    onAddNote,
    onAddToEvent,
    onPreviewOutreach,
  });
  const mergeState = useCrmMergeViewState({
    organizationId,
    selectedContact,
    duplicates,
    mergePreview,
    mergePreviewLoading,
    mergePreviewError,
    mergePreviewPlanKey,
    onPreviewMerge,
    onMerge,
  });
  const currentRules = useMemo(
    () => crmCurrentFilterRules(query, companyFilter, tagsFilter, pipelineFilter, statusFilter),
    [companyFilter, pipelineFilter, query, statusFilter, tagsFilter],
  );
  const selectedEvent = events.find((event) => event.id === formState.eventId);
  const noteIds = useMemo(() => new Set(notes.map((note) => note.id)), [notes]);
  const timelineHistory = useMemo(
    () =>
      history.filter((entry) => {
        if (entry.kind !== "note") return true;
        const noteId = entry.metadata.noteId;
        return typeof noteId !== "string" || !noteIds.has(noteId);
      }),
    [history, noteIds],
  );
  const importPreviewCurrent =
    importPreviewResult !== null &&
    importPreviewResult.preview === true &&
    importPreviewSource === formState.importCsv;
  const importPreviewHasErrors =
    (importPreviewResult?.errors ?? 0) > 0 ||
    (importPreviewResult?.rows.some((row) => row.status === "error") ?? false);
  const outreachHasUnknownTags =
    outreachPreview?.recipients.some((recipient) => recipient.unknownTags.length > 0) ?? false;

  return (
    <div className={styles.page}>
      <CrmWorkspaceIntro organizationId={organizationId} busy={busy} onRefresh={onRefresh} />
      <main id="crm-content" className={styles.content} tabIndex={-1}>
        <CrmWorkspaceStatus
          contacts={contacts}
          analytics={analytics}
          error={error}
          statusMessage={statusMessage}
          loading={loading}
          busy={busy}
          onRefresh={onRefresh}
        />
        <CrmWorkspaceMainContent
          organizationId={organizationId}
          contacts={contacts}
          analytics={analytics}
          selectedContact={selectedContact}
          selectedContactId={selectedContactId}
          selectedContactIds={selectedContactIds}
          segments={segments}
          events={events}
          pipelineHistory={pipelineHistory}
          notes={notes}
          timelineHistory={timelineHistory}
          duplicates={duplicates}
          currentRules={currentRules}
          loading={loading}
          busy={busy}
          query={query}
          companyFilter={companyFilter}
          tagsFilter={tagsFilter}
          pipelineFilter={pipelineFilter}
          statusFilter={statusFilter}
          onQueryChange={onQueryChange}
          onCompanyChange={onCompanyChange}
          onTagsChange={onTagsChange}
          onPipelineFilterChange={onPipelineFilterChange}
          onStatusFilterChange={onStatusFilterChange}
          onStartAdd={onStartAdd}
          onSaveContact={onSaveContact}
          onSelectContact={onSelectContact}
          onSelectionChange={onSelectionChange}
          onCancelEdit={onCancelEdit}
          onImport={onImport}
          initialImportOpen={initialImportOpen}
          importCsv={formState.importCsv}
          importFileName={formState.importFileName}
          importPreview={formState.importPreview}
          updateImportCsv={formState.updateImportCsv}
          readImportFile={formState.readImportFile}
          importPreviewResult={importPreviewResult}
          importPreviewLoading={importPreviewLoading}
          importPreviewError={importPreviewError}
          importPreviewCurrent={importPreviewCurrent}
          importPreviewHasErrors={importPreviewHasErrors}
          importResult={importResult}
          onFindDuplicates={onFindDuplicates}
          mergeCandidates={mergeState.mergeCandidates}
          mergeSelectionSet={mergeState.mergeSelectionSet}
          selectedMergeContacts={mergeState.selectedMergeContacts}
          mergeReviewContacts={mergeState.mergeReviewContacts}
          mergeCustomKeys={mergeState.mergeCustomKeys}
          conflictingScalarFields={mergeState.conflictingScalarFields}
          conflictingCustomKeys={mergeState.conflictingCustomKeys}
          mergeReviewOpen={mergeState.mergeReviewOpen}
          mergePreview={mergePreview}
          mergePreviewLoading={mergePreviewLoading}
          mergePreviewError={mergePreviewError}
          mergePreviewCurrent={mergeState.mergePreviewCurrent}
          mergePreviewHasConflicts={mergeState.mergePreviewHasConflicts}
          mergeResult={mergeResult}
          mergeCommitReady={mergeState.mergeCommitReady}
          mergeCompleted={mergeState.mergeCompleted}
          mergeCompletedContactId={mergeState.mergeCompletedContactId}
          mergeFieldWinners={mergeState.mergeFieldWinners}
          mergeCustomFieldWinners={mergeState.mergeCustomFieldWinners}
          mergeConfirmed={mergeState.mergeConfirmed}
          mergeSubmitting={mergeState.mergeSubmitting}
          onToggleMergeSelection={mergeState.onToggleMergeSelection}
          onOpenMergeReview={mergeState.onOpenMergeReview}
          onCloseMergeReview={mergeState.onCloseMergeReview}
          onSubmitMerge={mergeState.onSubmitMerge}
          onSetMergeFieldWinners={mergeState.onSetMergeFieldWinners}
          onSetMergeCustomFieldWinners={mergeState.onSetMergeCustomFieldWinners}
          onSetMergeConfirmed={mergeState.onSetMergeConfirmed}
          onRequestMergePreview={mergeState.onRequestMergePreview}
          pipelineStage={mergeState.pipelineStage}
          pipelineNote={mergeState.pipelineNote}
          onPipelineStageChange={mergeState.onPipelineStageChange}
          onPipelineNoteChange={mergeState.onPipelineNoteChange}
          selectedEvent={selectedEvent}
          eventId={formState.eventId}
          eventRole={formState.eventRole}
          eventNote={formState.eventNote}
          setEventId={formState.setEventId}
          setEventRole={formState.setEventRole}
          setEventNote={formState.setEventNote}
          lastAddedEventId={lastAddedEventId}
          lastEventResult={lastEventResult}
          noteBody={formState.noteBody}
          noteError={formState.noteError}
          setNoteBody={formState.setNoteBody}
          saveEvent={formState.saveEvent}
          saveNote={formState.saveNote}
          onSavePipeline={onSavePipeline}
          effectiveOutreachSegmentId={formState.effectiveOutreachSegmentId}
          outreachContextSegmentId={formState.outreachContextSegmentId}
          outreachEventId={formState.outreachEventId}
          outreachSubject={formState.outreachSubject}
          outreachBody={formState.outreachBody}
          setOutreachSegmentId={formState.setOutreachSegmentId}
          setOutreachContextSegmentId={formState.setOutreachContextSegmentId}
          setOutreachEventId={formState.setOutreachEventId}
          setOutreachSubject={formState.setOutreachSubject}
          setOutreachBody={formState.setOutreachBody}
          previewOutreach={formState.previewOutreach}
          outreachPreview={outreachPreview}
          outreachHasUnknownTags={outreachHasUnknownTags}
          outreachResults={outreachResults}
          onSendOutreach={onSendOutreach}
          outreachComposerRef={formState.outreachComposerRef}
          onCreateSegment={onCreateSegment}
          onSelectSegment={onSelectSegment}
          onMovePipeline={onMovePipeline}
          onEnrollPipeline={onEnrollPipeline}
          onAnalyticsEventDrillThrough={onAnalyticsEventDrillThrough}
        />
      </main>
    </div>
  );
}

export interface CrmWorkspaceControllerProps {
  readonly organizationId: string;
  readonly api?: CrmApi;
  readonly initialContacts?: readonly CrmContact[];
  readonly initialSegments?: readonly CrmSegment[];
  readonly initialEvents?: readonly CrmEvent[];
  readonly initialAnalytics?: CrmAnalytics | null;
}

type CrmBusySetter = (value: boolean | ((current: boolean) => boolean)) => void;

interface CrmDirectoryControllerState {
  readonly api: CrmApi;
  readonly contacts: readonly CrmContact[];
  readonly segments: readonly CrmSegment[];
  readonly events: readonly CrmEvent[];
  readonly analytics: CrmAnalytics | null;
  readonly contactsLoading: boolean;
  readonly segmentsLoading: boolean;
  readonly eventsLoading: boolean;
  readonly analyticsLoading: boolean;
  readonly loading: boolean;
  readonly query: string;
  readonly eventFilter: string;
  readonly companyFilter: string;
  readonly tagsFilter: string;
  readonly pipelineFilter: CrmPipelineStage | "";
  readonly statusFilter: CrmContactStatus | "";
  readonly setQuery: (value: string) => void;
  readonly setEventFilter: (value: string) => void;
  readonly setCompanyFilter: (value: string) => void;
  readonly setTagsFilter: (value: string) => void;
  readonly setPipelineFilter: (value: CrmPipelineStage | "") => void;
  readonly setStatusFilter: (value: CrmContactStatus | "") => void;
  readonly dispatchDirectory: Dispatch<CrmDirectoryAction>;
  readonly loadContacts: () => Promise<void>;
  readonly loadSegments: () => Promise<void>;
  readonly loadEvents: () => Promise<void>;
  readonly loadAnalytics: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly markContactMutation: () => void;
}

function useCrmDirectoryController({
  organizationId,
  api: providedApi,
  initialContacts,
  initialSegments,
  initialEvents,
  initialAnalytics,
  setError,
}: CrmWorkspaceControllerProps & {
  readonly setError: (message: string | null) => void;
}): CrmDirectoryControllerState {
  const api = useMemo(
    () => providedApi ?? createCrmApi("", organizationId),
    [organizationId, providedApi],
  );
  const [directoryState, dispatchDirectory] = useReducer(crmDirectoryReducer, {
    contacts: initialContacts ?? [],
    segments: initialSegments ?? [],
    events: initialEvents ?? [],
    analytics: initialAnalytics ?? null,
    contactsLoading: initialContacts === undefined,
    segmentsLoading: initialSegments === undefined,
    eventsLoading: initialEvents === undefined,
    analyticsLoading: initialAnalytics === undefined,
  });
  const [query, setQuery] = useState("");
  const [eventFilter, setEventFilter] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [tagsFilter, setTagsFilter] = useState("");
  const [pipelineFilter, setPipelineFilter] = useState<CrmPipelineStage | "">("");
  const [statusFilter, setStatusFilter] = useState<CrmContactStatus | "">("active");
  const contactFilter = useMemo<CrmWorkspaceContactFilter>(
    () => ({
      query,
      eventId: eventFilter,
      company: companyFilter,
      tags: tagsFilter,
      pipelineStage: pipelineFilter,
      status: statusFilter,
    }),
    [companyFilter, eventFilter, pipelineFilter, query, statusFilter, tagsFilter],
  );
  const contactFilterKey = useMemo(
    () =>
      JSON.stringify([query, eventFilter, companyFilter, tagsFilter, pipelineFilter, statusFilter]),
    [companyFilter, eventFilter, pipelineFilter, query, statusFilter, tagsFilter],
  );
  const initialContactsRead = useRef<{ api: CrmApi; filterKey: string } | null>(
    initialContacts === undefined
      ? null
      : {
          api,
          filterKey: JSON.stringify([
            query,
            eventFilter,
            companyFilter,
            tagsFilter,
            pipelineFilter,
            statusFilter,
          ]),
        },
  );
  const initialSegmentsRead = useRef<CrmApi | null>(initialSegments === undefined ? null : api);
  const initialEventsRead = useRef<CrmApi | null>(initialEvents === undefined ? null : api);
  const initialAnalyticsRead = useRef<CrmApi | null>(initialAnalytics === undefined ? null : api);
  const workspaceReadCoordinator = useMemo(
    () =>
      createCrmWorkspaceReadCoordinator(api, {
        setContacts: (value) => dispatchDirectory({ type: "set-contacts", value }),
        setSegments: (value) => dispatchDirectory({ type: "set-segments", value }),
        setEvents: (value) => dispatchDirectory({ type: "set-events", value }),
        setAnalytics: (value) => dispatchDirectory({ type: "set-analytics", value }),
        setContactsLoading: (value) => dispatchDirectory({ type: "set-contacts-loading", value }),
        setSegmentsLoading: (value) => dispatchDirectory({ type: "set-segments-loading", value }),
        setEventsLoading: (value) => dispatchDirectory({ type: "set-events-loading", value }),
        setAnalyticsLoading: (value) => dispatchDirectory({ type: "set-analytics-loading", value }),
        setError,
      }),
    [api, setError],
  );
  const loadContacts = useCallback(
    () => workspaceReadCoordinator.loadContacts(contactFilter),
    [contactFilter, workspaceReadCoordinator],
  );
  const loadSegments = useCallback(
    () => workspaceReadCoordinator.loadSegments(),
    [workspaceReadCoordinator],
  );
  const loadEvents = useCallback(
    () => workspaceReadCoordinator.loadEvents(),
    [workspaceReadCoordinator],
  );
  const loadAnalytics = useCallback(
    () => workspaceReadCoordinator.loadAnalytics(),
    [workspaceReadCoordinator],
  );
  useEffect(() => {
    workspaceReadCoordinator.activate();
    return () => workspaceReadCoordinator.dispose();
  }, [workspaceReadCoordinator]);
  useEffect(() => {
    const previous = initialContactsRead.current;
    if (previous !== null && previous.api === api && previous.filterKey === contactFilterKey)
      return;
    initialContactsRead.current = { api, filterKey: contactFilterKey };
    void loadContacts();
  }, [api, contactFilterKey, loadContacts]);
  useEffect(() => {
    if (initialSegmentsRead.current === api) return;
    initialSegmentsRead.current = api;
    void loadSegments();
  }, [api, loadSegments]);
  useEffect(() => {
    if (initialEventsRead.current === api) return;
    initialEventsRead.current = api;
    void loadEvents();
  }, [api, loadEvents]);
  useEffect(() => {
    if (initialAnalyticsRead.current === api) return;
    initialAnalyticsRead.current = api;
    void loadAnalytics();
  }, [api, loadAnalytics]);
  const refresh = useCallback(async () => {
    await workspaceReadCoordinator.refresh(contactFilter);
  }, [contactFilter, workspaceReadCoordinator]);
  return {
    api,
    ...directoryState,
    loading:
      directoryState.contactsLoading ||
      directoryState.segmentsLoading ||
      directoryState.eventsLoading ||
      directoryState.analyticsLoading,
    query,
    eventFilter,
    companyFilter,
    tagsFilter,
    pipelineFilter,
    statusFilter,
    setQuery,
    setEventFilter,
    setCompanyFilter,
    setTagsFilter,
    setPipelineFilter,
    setStatusFilter,
    dispatchDirectory,
    loadContacts,
    loadSegments,
    loadEvents,
    loadAnalytics,
    refresh,
    markContactMutation: workspaceReadCoordinator.markContactMutation,
  };
}

interface CrmSelectionControllerState {
  readonly selectedContact: CrmContact | undefined;
  readonly selectedContactIds: readonly string[];
  readonly history: readonly CrmHistoryEntry[];
  readonly pipelineHistory: readonly CrmPipelineEntry[];
  readonly notes: readonly CrmNote[];
  readonly duplicates: CrmDuplicateReport | null;
  readonly outreachRecipients: readonly CrmContact[];
  readonly outreachPreview: CrmOutreachPreview | null;
  readonly outreachResults: readonly CrmOutreachCommand[];
  readonly lastAddedEventId: string | null;
  readonly lastEventResult: CrmEventProjectionResult | null;
  readonly setHistory: (value: CrmStateUpdate<readonly CrmHistoryEntry[]>) => void;
  readonly setPipelineHistory: (value: CrmStateUpdate<readonly CrmPipelineEntry[]>) => void;
  readonly setDuplicates: (value: CrmStateUpdate<CrmDuplicateReport | null>) => void;
  readonly setOutreachRecipients: (value: CrmStateUpdate<readonly CrmContact[]>) => void;
  readonly dispatchContactSelection: Dispatch<CrmContactSelectionAction>;
  readonly selectContact: (contactId: string, manageBusy?: boolean) => Promise<void>;
  readonly refreshSelectedContact: (
    contactId: string | undefined,
    expectedSelectionGeneration: number,
  ) => Promise<void>;
}

function useCrmSelectionController({
  api,
  setBusy,
  setError,
  setStatusMessage,
  busyLeaseRef,
  selectionGeneration,
}: {
  readonly api: CrmApi;
  readonly setBusy: CrmBusySetter;
  readonly setError: (message: string | null) => void;
  readonly setStatusMessage: (message: string | null) => void;
  readonly busyLeaseRef: MutableRefObject<number>;
  readonly selectionGeneration: MutableRefObject<number>;
}): CrmSelectionControllerState {
  const [contactSelectionState, dispatchContactSelection] = useReducer(crmContactSelectionReducer, {
    selectedContact: undefined,
    selectedContactIds: [],
    history: [],
    pipelineHistory: [],
    notes: [],
    duplicates: null,
    outreachRecipients: [],
    outreachPreview: null,
    outreachResults: [],
    lastAddedEventId: null,
    lastEventResult: null,
  });
  const selectContact = useCallback(
    async (contactId: string, manageBusy = true): Promise<void> => {
      const generation = ++selectionGeneration.current;
      let busyLease: number | null = null;
      if (manageBusy) {
        busyLease = ++busyLeaseRef.current;
        setBusy(true);
        setError(null);
        setStatusMessage(null);
      }
      try {
        const [contact, nextHistory, nextPipelineHistory, nextNotes, nextDuplicates] =
          await Promise.all([
            api.getContact(contactId),
            api.getContactHistory(contactId),
            api.getPipelineHistory(contactId),
            api.listNotes(contactId),
            api.findDuplicates(contactId),
          ]);
        if (generation !== selectionGeneration.current) return;
        dispatchContactSelection({
          type: "contact-loaded",
          contact,
          history: nextHistory,
          pipelineHistory: nextPipelineHistory,
          notes: nextNotes,
          duplicates: nextDuplicates,
        });
      } catch (reason) {
        if (generation === selectionGeneration.current) setError(messageFromError(reason));
      } finally {
        setBusy((current) =>
          manageBusy && busyLease !== null && busyLease === busyLeaseRef.current ? false : current,
        );
      }
    },
    [api, busyLeaseRef, selectionGeneration, setBusy, setError, setStatusMessage],
  );
  const refreshSelectedContact = useCallback(
    (contactId: string | undefined, expectedSelectionGeneration: number) =>
      refreshSelectedContactAfterCollectionReload({
        contactId,
        expectedSelectionGeneration,
        currentSelectionGeneration: () => selectionGeneration.current,
        getContact: (selectedContactId) => api.getContact(selectedContactId),
        applyContact: (contact) => dispatchContactSelection({ type: "contact-refreshed", contact }),
      }),
    [api, selectionGeneration],
  );
  return {
    ...contactSelectionState,
    setHistory: (value) => dispatchContactSelection({ type: "set-history", value }),
    setPipelineHistory: (value) =>
      dispatchContactSelection({ type: "set-pipeline-history", value }),
    setDuplicates: (value) => dispatchContactSelection({ type: "set-duplicates", value }),
    setOutreachRecipients: (value) =>
      dispatchContactSelection({ type: "set-outreach-recipients", value }),
    dispatchContactSelection,
    selectContact,
    refreshSelectedContact,
  };
}

interface CrmImportControllerState {
  readonly importResult: CrmImportResult | null;
  readonly importPreviewResult: CrmImportPreviewResult | null;
  readonly importPreviewLoading: boolean;
  readonly importPreviewError: string | null;
  readonly importPreviewSource: string | null;
  readonly previewImport: (csv: string) => Promise<void>;
  readonly importContacts: (csv: string) => Promise<void>;
}

function useCrmImportController({
  api,
  setBusy,
  setError,
  setStatusMessage,
  busyLeaseRef,
  loadContacts,
  loadAnalytics,
  selectedContactId,
  selectionGeneration,
  refreshSelectedContact,
}: {
  readonly api: CrmApi;
  readonly setBusy: CrmBusySetter;
  readonly setError: (message: string | null) => void;
  readonly setStatusMessage: (message: string | null) => void;
  readonly busyLeaseRef: MutableRefObject<number>;
  readonly loadContacts: () => Promise<void>;
  readonly loadAnalytics: () => Promise<void>;
  readonly selectedContactId: string | undefined;
  readonly selectionGeneration: MutableRefObject<number>;
  readonly refreshSelectedContact: (
    contactId: string | undefined,
    expectedSelectionGeneration: number,
  ) => Promise<void>;
}): CrmImportControllerState {
  const [importResult, setImportResult] = useState<CrmImportResult | null>(null);
  const [importPreviewResult, setImportPreviewResult] = useState<CrmImportPreviewResult | null>(
    null,
  );
  const [importPreviewLoading, setImportPreviewLoading] = useState(false);
  const [importPreviewError, setImportPreviewError] = useState<string | null>(null);
  const [importPreviewSource, setImportPreviewSource] = useState<string | null>(null);
  const importIdentityRef = useRef<{ csv: string; key: string } | null>(null);
  const importPreviewRequestRef = useRef<string | null>(null);
  const importPreviewLeaseRef = useRef(0);
  async function previewImport(csv: string): Promise<void> {
    const requestLease = ++importPreviewLeaseRef.current;
    importPreviewRequestRef.current = csv;
    const requestIsCurrent = () =>
      importPreviewRequestRef.current === csv && importPreviewLeaseRef.current === requestLease;
    setImportPreviewResult(null);
    setImportPreviewSource(null);
    setImportPreviewError(null);
    setImportPreviewLoading(true);
    try {
      const result = await api.previewImport(csv);
      if (!requestIsCurrent()) return;
      setImportPreviewResult(result);
      setImportPreviewSource(csv);
    } catch (reason) {
      if (requestIsCurrent()) setImportPreviewError(messageFromError(reason));
    } finally {
      setImportPreviewLoading((current) => (requestIsCurrent() ? false : current));
    }
  }
  async function importContacts(csv: string): Promise<void> {
    const authoritativePreview =
      importPreviewRequestRef.current === csv &&
      importPreviewSource === csv &&
      importPreviewResult?.preview === true
        ? importPreviewResult
        : null;
    if (authoritativePreview === null) {
      setError("Import commit is blocked until a current authoritative CSV preview is ready.");
      return;
    }
    if (authoritativePreview.errors > 0) {
      setError("Import commit is blocked because the authoritative preview contains row errors.");
      return;
    }
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    setError(null);
    const existingIdentity = importIdentityRef.current;
    const key = existingIdentity?.csv === csv ? existingIdentity.key : idempotencyKey("crm-import");
    importIdentityRef.current = { csv, key };
    const selectionIntent = selectionGeneration.current;
    try {
      const result = await api.importContacts(csv, key);
      setImportResult(result);
      setStatusMessage(
        `Import ${result.id}: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.errors} errors${result.idempotent ? " (idempotent replay)" : ""}.`,
      );
      await Promise.all([
        loadContacts(),
        loadAnalytics(),
        refreshSelectedContact(selectedContactId, selectionIntent),
      ]);
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  useEffect(
    () => () => {
      importPreviewLeaseRef.current += 1;
    },
    [],
  );
  return {
    importResult,
    importPreviewResult,
    importPreviewLoading,
    importPreviewError,
    importPreviewSource,
    previewImport,
    importContacts,
  };
}

interface CrmMergeControllerState {
  readonly mergePreview: CrmMergePreview | null;
  readonly mergePreviewLoading: boolean;
  readonly mergePreviewError: string | null;
  readonly mergePreviewPlanKey: string | null;
  readonly mergeResult: CrmMergeResult | null;
  readonly previewMerge: (plan: CrmMergePlan) => Promise<void>;
  readonly mergeContacts: (plan: CrmMergePlan) => Promise<void>;
}

function useCrmMergeController({
  api,
  organizationId,
  selectedContact,
  duplicates,
  setBusy,
  setError,
  setStatusMessage,
  busyLeaseRef,
  selectionGeneration,
  selectContact,
  loadContacts,
  loadAnalytics,
}: {
  readonly api: CrmApi;
  readonly organizationId: string;
  readonly selectedContact: CrmContact | undefined;
  readonly duplicates: CrmDuplicateReport | null;
  readonly setBusy: CrmBusySetter;
  readonly setError: (message: string | null) => void;
  readonly setStatusMessage: (message: string | null) => void;
  readonly busyLeaseRef: MutableRefObject<number>;
  readonly selectionGeneration: MutableRefObject<number>;
  readonly selectContact: (contactId: string, manageBusy?: boolean) => Promise<void>;
  readonly loadContacts: () => Promise<void>;
  readonly loadAnalytics: () => Promise<void>;
}): CrmMergeControllerState {
  const [mergeRequestState, dispatchMergeRequest] = useReducer(crmMergeRequestReducer, {
    preview: null,
    loading: false,
    error: null,
    planKey: null,
    result: null,
  });
  const mergePreviewRequestRef = useRef<string | null>(null);
  const mergePreviewLeaseRef = useRef(0);
  async function previewMerge(plan: CrmMergePlan): Promise<void> {
    if (!selectedContact || plan.duplicateContactIds.length === 0) return;
    const key = mergePlanKey(plan);
    const requestLease = ++mergePreviewLeaseRef.current;
    mergePreviewRequestRef.current = key;
    const requestIsCurrent = () =>
      mergePreviewRequestRef.current === key && mergePreviewLeaseRef.current === requestLease;
    dispatchMergeRequest({ type: "preview-start" });
    try {
      const result = await api.previewMerge(selectedContact.id, plan.duplicateContactIds, {
        fieldWinners: plan.fieldWinners,
        customFieldWinners: plan.customFieldWinners,
      });
      if (!requestIsCurrent()) return;
      dispatchMergeRequest({ type: "preview-success", preview: result, planKey: key });
    } catch (reason) {
      if (requestIsCurrent())
        dispatchMergeRequest({ type: "preview-error", error: messageFromError(reason) });
    } finally {
      if (requestIsCurrent()) dispatchMergeRequest({ type: "preview-finished" });
    }
  }
  async function mergeContacts(plan: CrmMergePlan): Promise<void> {
    if (!selectedContact || plan.duplicateContactIds.length === 0) return;
    if (selectedContact.organizationId !== organizationId || selectedContact.status !== "active") {
      const reason = new Error(
        "The selected primary contact is not an active organization contact.",
      );
      setError(reason.message);
      throw reason;
    }
    const allowedMatches =
      duplicates?.contactId === selectedContact.id
        ? duplicates.matches.filter(
            (match) =>
              match.contact.organizationId === organizationId &&
              match.contact.status === "active" &&
              match.contact.id !== selectedContact.id,
          )
        : [];
    const allowedIds = new Set(allowedMatches.map((match) => match.contact.id));
    const duplicateIds = [...new Set(plan.duplicateContactIds)].filter((id) => allowedIds.has(id));
    if (duplicateIds.length === 0) {
      const reason = new Error("Select an eligible duplicate from the current comparison.");
      setError(reason.message);
      throw reason;
    }
    const planKey = mergePlanKey(plan);
    if (
      mergeRequestState.preview === null ||
      mergeRequestState.planKey !== planKey ||
      !mergeRequestState.preview.canCommit ||
      mergeRequestState.preview.participantConflicts.length > 0 ||
      mergeRequestState.preview.planFingerprint.length === 0
    ) {
      const reason = new Error(
        "Merge commit is blocked until a current authoritative relationship preview is ready.",
      );
      setError(reason.message);
      throw reason;
    }
    const primaryContactId = selectedContact.id;
    const selectionIntent = selectionGeneration.current;
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.mergeContacts(
        primaryContactId,
        duplicateIds,
        idempotencyKey("crm-merge"),
        { fieldWinners: plan.fieldWinners, customFieldWinners: plan.customFieldWinners },
      );
      dispatchMergeRequest({ type: "merge-result", result });
      setStatusMessage(
        `Merge committed: survivor ${result.survivorId}; audit ${result.auditId}${result.idempotent ? " (idempotent replay)" : ""}.`,
      );
      await Promise.all([
        loadContacts(),
        loadAnalytics(),
        selectionGeneration.current === selectionIntent
          ? selectContact(primaryContactId, false)
          : Promise.resolve(),
      ]);
    } catch (reason) {
      setError(messageFromError(reason));
      throw reason;
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  useEffect(
    () => () => {
      mergePreviewLeaseRef.current += 1;
    },
    [],
  );
  return {
    mergePreview: mergeRequestState.preview,
    mergePreviewLoading: mergeRequestState.loading,
    mergePreviewError: mergeRequestState.error,
    mergePreviewPlanKey: mergeRequestState.planKey,
    mergeResult: mergeRequestState.result,
    previewMerge,
    mergeContacts,
  };
}

function useCrmSegmentActions({
  api,
  setBusy,
  setError,
  setStatusMessage,
  busyLeaseRef,
  dispatchDirectory,
  setOutreachRecipients,
  selectedContact,
  setDuplicates,
}: {
  readonly api: CrmApi;
  readonly setBusy: CrmBusySetter;
  readonly setError: (message: string | null) => void;
  readonly setStatusMessage: (message: string | null) => void;
  readonly busyLeaseRef: MutableRefObject<number>;
  readonly dispatchDirectory: Dispatch<CrmDirectoryAction>;
  readonly setOutreachRecipients: (value: CrmStateUpdate<readonly CrmContact[]>) => void;
  readonly selectedContact: CrmContact | undefined;
  readonly setDuplicates: (value: CrmStateUpdate<CrmDuplicateReport | null>) => void;
}): {
  readonly createSegment: (input: {
    name: string;
    description: string;
    rules: readonly CrmSegmentRule[];
  }) => Promise<void>;
  readonly selectSegment: (segmentId: string) => Promise<void>;
  readonly findDuplicates: () => Promise<void>;
} {
  async function createSegment(input: {
    name: string;
    description: string;
    rules: readonly CrmSegmentRule[];
  }): Promise<void> {
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.createSegment(input);
      dispatchDirectory({ type: "append-segment", segment: next });
      setStatusMessage(`Saved dynamic segment “${next.name}”.`);
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  async function selectSegment(segmentId: string): Promise<void> {
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    setError(null);
    try {
      const segmentContacts = await api.listSegmentContacts(segmentId);
      dispatchDirectory({ type: "segment-contacts-loaded", contacts: segmentContacts });
      setStatusMessage(
        `Showing ${segmentContacts.length} contact${segmentContacts.length === 1 ? "" : "s"} in this segment.`,
      );
      setOutreachRecipients(segmentContacts);
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  async function findDuplicates(): Promise<void> {
    if (!selectedContact) return;
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    try {
      setDuplicates(await api.findDuplicates(selectedContact.id));
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  return { createSegment, selectSegment, findDuplicates };
}

function useCrmPipelineActions({
  api,
  contacts,
  selectedContact,
  setBusy,
  setError,
  setStatusMessage,
  busyLeaseRef,
  dispatchDirectory,
  dispatchContactSelection,
  loadAnalytics,
  loadContacts,
  setPipelineHistory,
  markContactMutation,
}: {
  readonly api: CrmApi;
  readonly contacts: readonly CrmContact[];
  readonly selectedContact: CrmContact | undefined;
  readonly setBusy: CrmBusySetter;
  readonly setError: (message: string | null) => void;
  readonly setStatusMessage: (message: string | null) => void;
  readonly busyLeaseRef: MutableRefObject<number>;
  readonly dispatchDirectory: Dispatch<CrmDirectoryAction>;
  readonly dispatchContactSelection: Dispatch<CrmContactSelectionAction>;
  readonly loadAnalytics: () => Promise<void>;
  readonly loadContacts: () => Promise<void>;
  readonly setPipelineHistory: (value: CrmStateUpdate<readonly CrmPipelineEntry[]>) => void;
  readonly markContactMutation: () => void;
}): {
  readonly movePipeline: (contactId: string, stage: CrmPipelineStage) => Promise<void>;
  readonly enrollPipeline: (input: {
    contactId: string;
    stage: CrmPipelineStage;
    score: string;
    rationale: string;
  }) => Promise<void>;
  readonly savePipeline: (stage: CrmPipelineStage, note: string) => Promise<void>;
} {
  async function movePipeline(contactId: string, stage: CrmPipelineStage): Promise<void> {
    const contact = contacts.find((candidate) => candidate.id === contactId);
    if (!contact || contact.pipelineStage === stage) return;
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    try {
      const next = await api.updatePipeline(contactId, {
        stage,
        expectedVersion: contact.version,
      });
      markContactMutation();
      dispatchDirectory({ type: "replace-contact", contact: next });
      if (selectedContact?.id === next.id)
        dispatchContactSelection({ type: "pipeline-contact-updated", contact: next });
      setStatusMessage(`${displayName(next)} moved to ${stage}.`);
      void Promise.allSettled([
        loadAnalytics(),
        loadContacts(),
        selectedContact?.id === next.id ? api.getPipelineHistory(next.id) : Promise.resolve(null),
      ]).then(([, , historyResult]) => {
        if (historyResult.status === "fulfilled" && historyResult.value !== null) {
          setPipelineHistory(historyResult.value);
        }
      });
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  async function enrollPipeline(input: {
    contactId: string;
    stage: CrmPipelineStage;
    score: string;
    rationale: string;
  }): Promise<void> {
    const contact = contacts.find((candidate) => candidate.id === input.contactId);
    if (!contact) return;
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    setError(null);
    const enrollmentNote = [
      input.score.trim() ? `Score: ${input.score.trim()}` : "",
      input.rationale.trim() ? `Rationale: ${input.rationale.trim()}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    try {
      const next = await api.updatePipeline(input.contactId, {
        stage: input.stage,
        expectedVersion: contact.version,
        ...(input.score.trim() ? { score: Number(input.score.trim()) } : {}),
        ...(input.rationale.trim() ? { rationale: input.rationale.trim() } : {}),
        ...(enrollmentNote ? { note: enrollmentNote } : {}),
      });
      markContactMutation();
      dispatchDirectory({ type: "replace-contact", contact: next });
      if (selectedContact?.id === next.id)
        dispatchContactSelection({ type: "pipeline-contact-updated", contact: next });
      const stageChanged = contact.pipelineStage !== next.pipelineStage;
      setStatusMessage(`${displayName(next)} enrolled in the ${input.stage} pipeline stage.`);
      void Promise.allSettled([
        stageChanged ? loadAnalytics() : Promise.resolve(),
        loadContacts(),
        selectedContact?.id === next.id ? api.getPipelineHistory(next.id) : Promise.resolve(null),
      ]).then(([, , historyResult]) => {
        if (historyResult.status === "fulfilled" && historyResult.value !== null) {
          setPipelineHistory(historyResult.value);
        }
      });
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  async function savePipeline(stage: CrmPipelineStage, note: string): Promise<void> {
    if (!selectedContact) return;
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.updatePipeline(selectedContact.id, {
        stage,
        expectedVersion: selectedContact.version,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      markContactMutation();
      dispatchContactSelection({ type: "pipeline-contact-updated", contact: next });
      dispatchDirectory({ type: "replace-contact", contact: next });
      setStatusMessage(`Pipeline stage saved as ${stage}.`);
      void Promise.allSettled([
        selectedContact.pipelineStage === next.pipelineStage ? Promise.resolve() : loadAnalytics(),
        loadContacts(),
        api.getPipelineHistory(next.id),
      ]).then(([, , historyResult]) => {
        if (historyResult.status === "fulfilled") setPipelineHistory(historyResult.value);
      });
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  return { movePipeline, enrollPipeline, savePipeline };
}

function useCrmContactActions({
  api,
  selectedContact,
  setBusy,
  setError,
  setStatusMessage,
  busyLeaseRef,
  dispatchContactSelection,
  loadAnalytics,
  loadContacts,
  markContactMutation,
  setHistory,
}: {
  readonly api: CrmApi;
  readonly selectedContact: CrmContact | undefined;
  readonly setBusy: CrmBusySetter;
  readonly setError: (message: string | null) => void;
  readonly setStatusMessage: (message: string | null) => void;
  readonly busyLeaseRef: MutableRefObject<number>;
  readonly dispatchContactSelection: Dispatch<CrmContactSelectionAction>;
  readonly loadAnalytics: () => Promise<void>;
  readonly loadContacts: () => Promise<void>;
  readonly markContactMutation: () => void;
  readonly setHistory: (value: CrmStateUpdate<readonly CrmHistoryEntry[]>) => void;
}): {
  readonly addNote: (body: string) => Promise<void>;
  readonly addToEvent: (input: {
    eventId: string;
    role: "speaker" | "prospect" | "attendee" | "sponsor";
    note: string;
  }) => Promise<void>;
} {
  const eventIdentityRef = useRef<{ fingerprint: string; key: string } | null>(null);
  async function addNote(body: string): Promise<void> {
    if (!selectedContact) return;
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    setError(null);
    try {
      const note = await api.addNote(selectedContact.id, body);
      dispatchContactSelection({ type: "note-added", note });
      setStatusMessage("Note saved to the contact timeline.");
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  async function addToEvent(input: {
    eventId: string;
    role: "speaker" | "prospect" | "attendee" | "sponsor";
    note: string;
  }): Promise<void> {
    if (!selectedContact) return;
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    setError(null);
    const fingerprint = JSON.stringify({ contactId: selectedContact.id, ...input });
    const existingIdentity = eventIdentityRef.current;
    const key =
      existingIdentity?.fingerprint === fingerprint
        ? existingIdentity.key
        : idempotencyKey("crm-event");
    eventIdentityRef.current = { fingerprint, key };
    try {
      const result = await api.addContactToEvent(selectedContact.id, input, key);
      dispatchContactSelection({ type: "event-added", eventId: input.eventId, result });
      setStatusMessage(
        result.outcome === "created"
          ? "Canonical event relationship created."
          : "The canonical event relationship already existed; no duplicate was created.",
      );
      markContactMutation();
      void Promise.allSettled([
        loadAnalytics(),
        loadContacts(),
        api.getContactHistory(selectedContact.id),
      ]).then(([, , historyResult]) => {
        if (historyResult.status === "fulfilled") setHistory(historyResult.value);
      });
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  return { addNote, addToEvent };
}

function useCrmOutreachActions({
  api,
  contacts,
  selectedContact,
  outreachPreview,
  outreachRecipients,
  setOutreachRecipients,
  dispatchContactSelection,
  setBusy,
  setError,
  setStatusMessage,
  busyLeaseRef,
  selectionGeneration,
  loadAnalytics,
  setHistory,
}: {
  readonly api: CrmApi;
  readonly contacts: readonly CrmContact[];
  readonly selectedContact: CrmContact | undefined;
  readonly outreachPreview: CrmOutreachPreview | null;
  readonly outreachRecipients: readonly CrmContact[];
  readonly setOutreachRecipients: (value: CrmStateUpdate<readonly CrmContact[]>) => void;
  readonly dispatchContactSelection: Dispatch<CrmContactSelectionAction>;
  readonly setBusy: CrmBusySetter;
  readonly setError: (message: string | null) => void;
  readonly setStatusMessage: (message: string | null) => void;
  readonly busyLeaseRef: MutableRefObject<number>;
  readonly selectionGeneration: MutableRefObject<number>;
  readonly loadAnalytics: () => Promise<void>;
  readonly setHistory: (value: CrmStateUpdate<readonly CrmHistoryEntry[]>) => void;
}): {
  readonly previewOutreach: (input: {
    subject: string;
    body: string;
    contactIds?: readonly string[];
    segmentId?: string;
    eventId?: string;
  }) => Promise<void>;
  readonly sendOutreach: () => Promise<void>;
} {
  async function previewOutreach(input: {
    subject: string;
    body: string;
    contactIds?: readonly string[];
    segmentId?: string;
    eventId?: string;
  }): Promise<void> {
    let recipients = outreachRecipients;
    if (input.contactIds && input.contactIds.length > 0) {
      const selected = new Set(input.contactIds);
      recipients = contacts.filter((contact) => selected.has(contact.id));
      setOutreachRecipients(recipients);
    } else if (input.segmentId) {
      try {
        recipients = await api.listSegmentContacts(input.segmentId);
        setOutreachRecipients(recipients);
      } catch (reason) {
        setError(messageFromError(reason));
        return;
      }
    }
    if (recipients.length === 0) {
      setError("Choose a contact or a segment with at least one active contact.");
      return;
    }
    const recipientPreviews = recipients.map((contact) => {
      const subject = renderVariablePreview(input.subject, contact);
      const body = renderVariablePreview(input.body, contact);
      return {
        contactId: contact.id,
        email: contact.email ?? "Missing recipient email",
        displayName: displayName(contact),
        subject: subject.value,
        body: body.value,
        unknownTags: [
          ...new Set([
            ...subject.unknownTags,
            ...body.unknownTags,
            ...(contact.email === null ? ["recipient_email"] : []),
          ]),
        ].sort(),
        idempotencyKey: idempotencyKey("crm-outreach"),
      };
    });
    const nextOutreachPreview: CrmOutreachPreview = {
      subject: input.subject,
      body: input.body,
      count: recipientPreviews.length,
      recipients: recipientPreviews,
      ...(input.segmentId ? { segmentId: input.segmentId } : {}),
      ...(input.eventId ? { eventId: input.eventId } : {}),
    };
    dispatchContactSelection({
      type: "outreach-preview-created",
      recipients,
      preview: nextOutreachPreview,
    });
    const issueCount = recipientPreviews.filter(
      (recipient) => recipient.unknownTags.length > 0,
    ).length;
    setStatusMessage(
      issueCount === 0
        ? `Preview ready for ${recipients.length} personalized recipient${recipients.length === 1 ? "" : "s"}.`
        : `Preview found merge-tag or recipient issues for ${issueCount} recipient${issueCount === 1 ? "" : "s"}; queueing is blocked.`,
    );
  }
  async function sendOutreach(): Promise<void> {
    if (
      !outreachPreview ||
      outreachPreview.recipients.length === 0 ||
      outreachPreview.recipients.some((recipient) => recipient.unknownTags.length > 0)
    ) {
      return;
    }
    const busyLease = ++busyLeaseRef.current;
    const selectionIntent = selectionGeneration.current;
    const selectedContactId = selectedContact?.id;
    let busyReleased = false;
    setBusy(true);
    setError(null);
    try {
      const contactsById = new Map(outreachRecipients.map((contact) => [contact.id, contact]));
      const settlements = await settleCrmOutreachRecipients(
        outreachPreview.recipients,
        async (recipient) => {
          const contact = contactsById.get(recipient.contactId);
          if (contact === undefined) {
            throw new Error(`Preview recipient ${recipient.contactId} is no longer selected.`);
          }
          const nameParts = contact.displayName.trim().split(/\s+/u).filter(Boolean);
          const firstName = contact.firstName?.trim() || nameParts[0] || contact.displayName.trim();
          const lastName = contact.lastName?.trim() || nameParts.slice(1).join(" ");
          return api.sendOutreach(
            {
              contactId: contact.id,
              subject: outreachPreview.subject,
              body: outreachPreview.body,
              ...(outreachPreview.eventId ? { eventId: outreachPreview.eventId } : {}),
              ...(outreachPreview.segmentId ? { segmentId: outreachPreview.segmentId } : {}),
              variables: { first_name: firstName, firstName, last_name: lastName, lastName },
            },
            recipient.idempotencyKey,
          );
        },
      );
      if (
        !isCurrentCrmOutreachRefresh(
          busyLease,
          busyLeaseRef.current,
          selectionIntent,
          selectionGeneration.current,
        )
      ) {
        return;
      }
      const results = settlements.flatMap((settlement) =>
        settlement.status === "fulfilled" ? [settlement.receipt] : [],
      );
      const unknownCount = settlements.length - results.length;
      dispatchContactSelection({ type: "outreach-results-set", results });
      const queuedCount = results.reduce((count, result) => count + result.queuedCount, 0);
      const sentCount = results.reduce((count, result) => count + result.sentCount, 0);
      const failedCount = results.reduce((count, result) => count + result.failedCount, 0);
      const terminal = results.length > 0 && results.every((result) => result.terminal);
      const outcome =
        unknownCount > 0
          ? `${unknownCount} request outcome${unknownCount === 1 ? "" : "s"} unknown; retry is safe`
          : failedCount > 0 && sentCount + queuedCount > 0
            ? "mixed outcomes"
            : terminal
              ? "terminal"
              : "delivery still in progress";
      setStatusMessage(
        `Outreach queue result: ${sentCount} sent, ${queuedCount} queued, ${failedCount} failed; ${outcome}.`,
      );
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
      busyReleased = true;
      const analyticsRefresh = Promise.resolve().then(() => loadAnalytics());
      const historyRefresh =
        selectedContactId === undefined
          ? Promise.resolve<readonly CrmHistoryEntry[] | null>(null)
          : Promise.resolve().then(() => api.getContactHistory(selectedContactId));
      void Promise.allSettled([analyticsRefresh, historyRefresh] as const).then(
        ([analyticsResult, historyResult]) => {
          if (
            !isCurrentCrmOutreachRefresh(
              busyLease,
              busyLeaseRef.current,
              selectionIntent,
              selectionGeneration.current,
            )
          ) {
            return;
          }
          if (analyticsResult.status === "rejected") {
            setError(messageFromError(analyticsResult.reason));
          }
          if (historyResult.status === "fulfilled" && historyResult.value !== null) {
            setHistory(historyResult.value);
          } else if (historyResult.status === "rejected") {
            setError(messageFromError(historyResult.reason));
          }
        },
      );
    } catch (reason) {
      if (
        isCurrentCrmOutreachRefresh(
          busyLease,
          busyLeaseRef.current,
          selectionIntent,
          selectionGeneration.current,
        )
      ) {
        setError(messageFromError(reason));
      }
    } finally {
      if (!busyReleased) {
        setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
      }
    }
  }
  return { previewOutreach, sendOutreach };
}

export function useCrmWorkspaceController(
  props: CrmWorkspaceControllerProps,
): CrmWorkspaceViewProps {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const busyLeaseRef = useRef(0);
  const selectionGeneration = useRef(0);
  useEffect(
    () => () => {
      selectionGeneration.current += 1;
      busyLeaseRef.current += 1;
    },
    [],
  );
  const directory = useCrmDirectoryController({ ...props, setError });
  const selection = useCrmSelectionController({
    api: directory.api,
    setBusy,
    setError,
    setStatusMessage,
    busyLeaseRef,
    selectionGeneration,
  });
  const imports = useCrmImportController({
    api: directory.api,
    setBusy,
    setError,
    setStatusMessage,
    busyLeaseRef,
    loadContacts: directory.loadContacts,
    loadAnalytics: directory.loadAnalytics,
    selectedContactId: selection.selectedContact?.id,
    selectionGeneration,
    refreshSelectedContact: selection.refreshSelectedContact,
  });
  const merge = useCrmMergeController({
    api: directory.api,
    organizationId: props.organizationId,
    selectedContact: selection.selectedContact,
    duplicates: selection.duplicates,
    setBusy,
    setError,
    setStatusMessage,
    busyLeaseRef,
    selectionGeneration,
    selectContact: selection.selectContact,
    loadContacts: directory.loadContacts,
    loadAnalytics: directory.loadAnalytics,
  });
  const segments = useCrmSegmentActions({
    api: directory.api,
    setBusy,
    setError,
    setStatusMessage,
    busyLeaseRef,
    dispatchDirectory: directory.dispatchDirectory,
    setOutreachRecipients: selection.setOutreachRecipients,
    selectedContact: selection.selectedContact,
    setDuplicates: selection.setDuplicates,
  });
  const pipeline = useCrmPipelineActions({
    api: directory.api,
    contacts: directory.contacts,
    selectedContact: selection.selectedContact,
    setBusy,
    setError,
    setStatusMessage,
    busyLeaseRef,
    dispatchDirectory: directory.dispatchDirectory,
    dispatchContactSelection: selection.dispatchContactSelection,
    loadAnalytics: directory.loadAnalytics,
    loadContacts: directory.loadContacts,
    setPipelineHistory: selection.setPipelineHistory,
    markContactMutation: directory.markContactMutation,
  });
  const contactActions = useCrmContactActions({
    api: directory.api,
    selectedContact: selection.selectedContact,
    setBusy,
    setError,
    setStatusMessage,
    busyLeaseRef,
    dispatchContactSelection: selection.dispatchContactSelection,
    loadAnalytics: directory.loadAnalytics,
    loadContacts: directory.loadContacts,
    markContactMutation: directory.markContactMutation,
    setHistory: selection.setHistory,
  });
  const outreach = useCrmOutreachActions({
    api: directory.api,
    contacts: directory.contacts,
    selectedContact: selection.selectedContact,
    outreachPreview: selection.outreachPreview,
    outreachRecipients: selection.outreachRecipients,
    setOutreachRecipients: selection.setOutreachRecipients,
    dispatchContactSelection: selection.dispatchContactSelection,
    setBusy,
    setError,
    setStatusMessage,
    busyLeaseRef,
    selectionGeneration,
    loadAnalytics: directory.loadAnalytics,
    setHistory: selection.setHistory,
  });
  async function saveContact(draft: ContactDraft): Promise<void> {
    const busyLease = ++busyLeaseRef.current;
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const input = draftInput(draft);
      const next = selection.selectedContact
        ? await directory.api.updateContact(selection.selectedContact.id, {
            ...input,
            expectedVersion: selection.selectedContact.version,
          })
        : await directory.api.createContact(input);
      directory.markContactMutation();
      selection.dispatchContactSelection({ type: "contact-saved", contact: next });
      directory.dispatchDirectory({ type: "replace-contact", contact: next });
      setStatusMessage(
        selection.selectedContact
          ? "Contact changes saved."
          : "Contact added to the organization directory.",
      );
      void Promise.allSettled([
        refreshCrmDuplicatesAfterContactSave(selection.selectedContact, next, (contactId) =>
          directory.api.findDuplicates(contactId),
        ),
        refreshCrmAnalyticsAfterContactSave(selection.selectedContact, directory.loadAnalytics),
        directory.loadContacts(),
      ]).then(([duplicatesResult]) => {
        if (duplicatesResult.status === "fulfilled" && duplicatesResult.value !== null) {
          selection.setDuplicates(duplicatesResult.value);
        }
      });
    } catch (reason) {
      setError(messageFromError(reason));
    } finally {
      setBusy((current) => (busyLease === busyLeaseRef.current ? false : current));
    }
  }
  async function selectContactAndReset(contactId: string): Promise<void> {
    await selection.selectContact(contactId);
  }
  async function refreshWorkspace(): Promise<void> {
    const selectedContactId = selection.selectedContact?.id;
    const selectionIntent = selectionGeneration.current;
    try {
      await Promise.all([
        directory.refresh(),
        selection.refreshSelectedContact(selectedContactId, selectionIntent),
      ]);
    } catch (reason) {
      if (selectionGeneration.current === selectionIntent) setError(messageFromError(reason));
    }
  }
  return {
    organizationId: props.organizationId,
    contacts: directory.contacts,
    selectedContact: selection.selectedContact,
    segments: directory.segments,
    events: directory.events,
    history: selection.history,
    pipelineHistory: selection.pipelineHistory,
    notes: selection.notes,
    duplicates: selection.duplicates,
    analytics: directory.analytics,
    loading: directory.loading,
    busy,
    error,
    statusMessage,
    query: directory.query,
    companyFilter: directory.companyFilter,
    tagsFilter: directory.tagsFilter,
    pipelineFilter: directory.pipelineFilter,
    statusFilter: directory.statusFilter,
    selectedContactId: selection.selectedContact?.id ?? null,
    selectedContactIds: selection.selectedContactIds,
    onQueryChange: (query) => {
      directory.setQuery(query);
      directory.setEventFilter("");
    },
    onCompanyChange: directory.setCompanyFilter,
    onTagsChange: directory.setTagsFilter,
    onPipelineFilterChange: directory.setPipelineFilter,
    onStatusFilterChange: directory.setStatusFilter,
    onRefresh: () => void refreshWorkspace(),
    onSelectContact: (contactId) => void selectContactAndReset(contactId),
    onSelectionChange: (contactIds) => {
      const selected = new Set(contactIds);
      selection.dispatchContactSelection({
        type: "selection-changed",
        contactIds,
        recipients: directory.contacts.filter((contact) => selected.has(contact.id)),
      });
    },
    onStartAdd: () => {
      selectionGeneration.current += 1;
      selection.dispatchContactSelection({ type: "start-add" });
    },
    onSaveContact: saveContact,
    onCancelEdit: () => {
      selectionGeneration.current += 1;
      selection.dispatchContactSelection({ type: "cancel-edit" });
    },
    onImport: imports.importContacts,
    onPreviewImport: imports.previewImport,
    importPreviewResult: imports.importPreviewResult,
    importPreviewLoading: imports.importPreviewLoading,
    importPreviewError: imports.importPreviewError,
    importPreviewSource: imports.importPreviewSource,
    importResult: imports.importResult,
    onCreateSegment: segments.createSegment,
    onSelectSegment: (segmentId) => void segments.selectSegment(segmentId),
    onFindDuplicates: () => void segments.findDuplicates(),
    onPreviewMerge: merge.previewMerge,
    mergePreview: merge.mergePreview,
    mergePreviewLoading: merge.mergePreviewLoading,
    mergePreviewError: merge.mergePreviewError,
    mergePreviewPlanKey: merge.mergePreviewPlanKey,
    mergeResult: merge.mergeResult,
    onMerge: merge.mergeContacts,
    onMovePipeline: (contactId, stage) => void pipeline.movePipeline(contactId, stage),
    onEnrollPipeline: pipeline.enrollPipeline,
    onSavePipeline: pipeline.savePipeline,
    onAddNote: contactActions.addNote,
    onAddToEvent: contactActions.addToEvent,
    lastAddedEventId: selection.lastAddedEventId,
    lastEventResult: selection.lastEventResult,
    onPreviewOutreach: outreach.previewOutreach,
    outreachPreview: selection.outreachPreview,
    outreachRecipients: selection.outreachRecipients,
    onSendOutreach: outreach.sendOutreach,
    outreachResults: selection.outreachResults,
    onAnalyticsEventDrillThrough: (eventId) => {
      directory.setQuery("");
      directory.setEventFilter(eventId);
      setStatusMessage(`Directory filter set to event ${eventId}.`);
    },
  };
}
