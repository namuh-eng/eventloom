"use client";

import { useSearchParams } from "next/navigation";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { type PortalApi, PortalApiError } from "./api";
import {
  classifyPortalProfileMutation,
  portalSelectedParticipantId,
  portalSubmissionIdsMatch,
  scopePortalContextToAuthorizedParticipants,
  scopePortalViewToAuthorizedParticipants,
} from "./model";
import { resolvePortalAssetFamily } from "./portal-assets";
import type { ParticipantSafeGuideFailure, PortalPrefetchResult } from "./portal-provider-model";
import {
  acceptedSubmissionId,
  assetBelongsToPortalContext,
  assetFamilyCommentResponseAuthorized,
  assetIdAuthorized,
  createPortalProviderApi,
  hasPortalCapability,
  isAbort,
  isPortalGenerationCurrent,
  loadPortalRosters,
  loadPortalStartup,
  messageFrom,
  normalizeCapabilities,
  participantSafeGuideFailure,
  portalContextResponseForTarget,
  portalViewAfterLoadFailure,
  portalViewMatchesSelection,
  profileAssetBelongsToPortalContext,
  submissionIdAuthorized,
  taskBelongsToPortalContext,
  taskIdAuthorized,
  taskMutationMatches,
  withUpdatedAsset,
  withUpdatedTask,
} from "./portal-provider-model";
import { PortalProviderBoundary } from "./portal-provider-sections";
import type {
  PortalAsset,
  PortalAssetComment,
  PortalAssetHistoryEntry,
  PortalCapability,
  PortalContext,
  PortalDownloadGrant,
  PortalFormAnswer,
  PortalProfile,
  PortalProfileMutationPhase,
  PortalResource,
  PortalRosterEnvelope,
  PortalRosterMember,
  PortalTask,
  PortalTaskForm,
  PortalTaskResponse,
  PortalTaskResponseEnvelope,
  PortalTaskStatus,
  PortalTravelLogistics,
  PortalView,
  PortalWikiPage,
} from "./types";

type WorkspaceReplacementTuple = {
  readonly predecessor: PortalAsset;
  readonly sessionId: string | undefined;
  readonly taskId: string | undefined;
  readonly versionFamilyId: string;
  readonly expectedLatestVersion: number;
  readonly successorVersion: number;
  readonly predecessorCurrentVersionId: string | null | undefined;
  readonly predecessorApprovedVersionId: string | null | undefined;
  readonly predecessorReleasedVersionId: string | null | undefined;
};

export function isOptionalGuideReadFailure(error: unknown): boolean {
  if (!(error instanceof PortalApiError)) return true;
  return (
    error.code !== "CONTEXT_MISMATCH" &&
    (error.status === 404 || error.status === 408 || error.status === 429 || error.status >= 500)
  );
}
export function isOptionalWorkspaceSubreadFailure(error: unknown): boolean {
  return (
    error instanceof PortalApiError &&
    error.code !== "CONTEXT_MISMATCH" &&
    (error.status === 404 || error.status === 408 || error.status === 429 || error.status >= 500)
  );
}
export function shouldIsolateWorkspaceReadFailure(
  endpoint: "authority" | "guide" | "optional",
  error: unknown,
): boolean {
  return (
    (endpoint === "guide" && isOptionalGuideReadFailure(error)) ||
    (endpoint === "optional" && isOptionalWorkspaceSubreadFailure(error))
  );
}

export function workspaceReplacementTuple(
  assets: readonly PortalAsset[],
  predecessorId: string,
): WorkspaceReplacementTuple | null {
  const predecessor = assets.find((asset) => asset.id === predecessorId);
  if (!predecessor || predecessor.versionFamilyId === undefined) return null;
  const versionFamilyId = predecessor.versionFamilyId;
  const family = assets.filter((asset) => asset.versionFamilyId === versionFamilyId);
  const resolution = resolvePortalAssetFamily(family, predecessor);
  const head = resolution.latest;
  const version = head?.version;
  if (
    (resolution.status !== "ready" && resolution.status !== "rejected") ||
    resolution.pointers.status !== "ready" ||
    resolution.pointers.latestVersionId !== predecessor.id ||
    head?.id !== predecessor.id ||
    head.versionId !== head.id ||
    head.latestVersionId !== head.id ||
    (head.state === "ready" && head.currentVersionId !== head.id) ||
    !Number.isSafeInteger(version) ||
    version === undefined ||
    version < 1
  ) {
    return null;
  }
  return {
    predecessor: head,
    sessionId: head.sessionId,
    taskId: head.taskId,
    versionFamilyId,
    expectedLatestVersion: version,
    successorVersion: version + 1,
    predecessorCurrentVersionId: head.currentVersionId,
    predecessorApprovedVersionId: head.approvedVersionId,
    predecessorReleasedVersionId: head.releasedVersionId,
  };
}

function assetMatchesWorkspaceReplacement(
  asset: PortalAsset,
  tuple: WorkspaceReplacementTuple,
  input: {
    readonly eventId: string;
    readonly participantId: string;
    readonly sessionId: string | undefined;
    readonly kind: PortalAsset["kind"];
    readonly state: PortalAsset["state"];
  },
): boolean {
  return (
    asset.id !== tuple.predecessor.id &&
    asset.eventId === input.eventId &&
    asset.participantId === input.participantId &&
    asset.sessionId === input.sessionId &&
    asset.taskId === tuple.taskId &&
    asset.kind === input.kind &&
    asset.state === input.state &&
    asset.versionFamilyId === tuple.versionFamilyId &&
    asset.supersedesAssetId === tuple.predecessor.id &&
    asset.version === tuple.successorVersion &&
    asset.versionId === asset.id &&
    asset.latestVersionId === asset.id &&
    asset.currentVersionId ===
      (asset.state === "ready" ? asset.id : tuple.predecessorCurrentVersionId) &&
    asset.approvedVersionId === tuple.predecessorApprovedVersionId &&
    asset.releasedVersionId === tuple.predecessorReleasedVersionId
  );
}
function assetMatchesInitialVersion(
  asset: PortalAsset,
  input: {
    readonly eventId: string;
    readonly participantId: string;
    readonly sessionId: string | undefined;
    readonly taskId: string | undefined;
    readonly kind: PortalAsset["kind"];
    readonly state: PortalAsset["state"];
  },
): boolean {
  return (
    asset.eventId === input.eventId &&
    asset.participantId === input.participantId &&
    asset.sessionId === input.sessionId &&
    asset.taskId === input.taskId &&
    asset.kind === input.kind &&
    asset.state === input.state &&
    asset.supersedesAssetId === undefined &&
    asset.version === 1 &&
    asset.versionId === asset.id &&
    asset.versionFamilyId === asset.id &&
    asset.latestVersionId === asset.id &&
    (asset.state !== "ready" || asset.currentVersionId === asset.id)
  );
}
export function assetMatchesPendingRetry(
  asset: PortalAsset,
  pending: PortalAsset,
  input: {
    readonly eventId: string;
    readonly participantId: string;
    readonly sessionId: string | undefined;
    readonly taskId: string | undefined;
    readonly kind: PortalAsset["kind"];
    readonly state: "pending_upload" | "ready";
  },
): boolean {
  return (
    pending.state === "pending_upload" &&
    pending.versionId === pending.id &&
    pending.latestVersionId === pending.id &&
    asset.id === pending.id &&
    asset.eventId === input.eventId &&
    asset.participantId === input.participantId &&
    asset.sessionId === input.sessionId &&
    asset.taskId === input.taskId &&
    asset.kind === input.kind &&
    asset.state === input.state &&
    asset.version === pending.version &&
    asset.versionId === pending.versionId &&
    asset.versionFamilyId === pending.versionFamilyId &&
    asset.supersedesAssetId === pending.supersedesAssetId &&
    asset.latestVersionId === pending.latestVersionId &&
    asset.currentVersionId === (input.state === "ready" ? pending.id : pending.currentVersionId) &&
    asset.approvedVersionId === pending.approvedVersionId &&
    asset.releasedVersionId === pending.releasedVersionId
  );
}

export interface PortalWorkspaceState {
  rosters: Record<string, PortalRosterEnvelope>;
  assets: PortalAsset[];
  assetHistories: Record<string, PortalAssetHistoryEntry[]>;
  assetComments: Record<string, PortalAssetComment[]>;
  taskForms: Record<string, PortalTaskForm>;
  taskResponses: Record<string, PortalTaskResponseEnvelope | null>;
  taskResponseHistories: Record<string, PortalTaskResponse[]>;
  resources: PortalResource[];
  wiki: PortalWikiPage[];
}

export interface PortalWorkspaceGuideErrors {
  resources: ParticipantSafeGuideFailure | null;
  wiki: ParticipantSafeGuideFailure | null;
}

const emptyWorkspace: PortalWorkspaceState = {
  rosters: {},
  assets: [],
  assetHistories: {},
  assetComments: {},
  taskForms: {},
  taskResponses: {},
  taskResponseHistories: {},
  resources: [],
  wiki: [],
};
type PortalScopeState = {
  contexts: PortalContext[];
  context: PortalContext | null;
  selectedParticipantId: string | null;
  authoritativeView: PortalView | null;
  capabilities: PortalCapability[];
  view: PortalView | null;
  profileRevision: number | null;
};

type PortalScopeAction =
  | { type: "contexts-set"; contexts: PortalContext[] }
  | { type: "contexts-updated"; context: PortalContext }
  | { type: "context-set"; context: PortalContext | null }
  | { type: "selected-participant-set"; participantId: string | null }
  | { type: "authoritative-view-set"; view: PortalView | null }
  | { type: "capabilities-set"; capabilities: PortalCapability[] }
  | { type: "task-updated"; task: PortalTask }
  | { type: "task-asset-updated"; task: PortalTask; asset: PortalAsset }
  | { type: "view-set"; view: PortalView | null }
  | { type: "profile-revision-set"; revision: number | null }
  | {
      type: "hydrate-succeeded";
      authoritativeView: PortalView;
      context: PortalContext;
      selectedParticipantId: string | null;
      capabilities: PortalCapability[];
      view: PortalView;
      profileRevision: number | null;
    }
  | {
      type: "hydrate-failed";
      preserveCurrentView: boolean;
    }
  | {
      type: "profile-updated";
      profile: PortalProfile;
      asset?: PortalAsset;
      revision: number;
    };

function initialPortalScopeState(): PortalScopeState {
  return {
    contexts: [],
    context: null,
    selectedParticipantId: null,
    authoritativeView: null,
    capabilities: [],
    view: null,
    profileRevision: null,
  };
}

function portalViewWithUpdatedProfile(
  current: PortalView | null,
  profile: PortalProfile,
  asset: PortalAsset | undefined,
): PortalView | null {
  if (!current) return current;
  const updatedView = {
    ...current,
    profiles: current.profiles.map((candidate) =>
      candidate.participantId === profile.participantId && candidate.eventId === profile.eventId
        ? profile
        : candidate,
    ),
  };
  return asset === undefined ? updatedView : withUpdatedAsset(updatedView, asset);
}
function portalScopeReducer(state: PortalScopeState, action: PortalScopeAction): PortalScopeState {
  switch (action.type) {
    case "contexts-set":
      return { ...state, contexts: action.contexts };
    case "contexts-updated":
      return {
        ...state,
        contexts: state.contexts.map((candidate) =>
          candidate.id === action.context.id ? action.context : candidate,
        ),
      };
    case "context-set":
      return { ...state, context: action.context };
    case "selected-participant-set":
      return { ...state, selectedParticipantId: action.participantId };
    case "authoritative-view-set":
      return { ...state, authoritativeView: action.view };
    case "capabilities-set":
      return { ...state, capabilities: action.capabilities };
    case "view-set":
      return { ...state, view: action.view };
    case "task-updated":
      return {
        ...state,
        view: state.view ? withUpdatedTask(state.view, action.task) : null,
      };
    case "task-asset-updated":
      return {
        ...state,
        view: state.view
          ? withUpdatedAsset(withUpdatedTask(state.view, action.task), action.asset)
          : null,
      };
    case "profile-revision-set":
      return { ...state, profileRevision: action.revision };
    case "hydrate-succeeded":
      return {
        ...state,
        authoritativeView: action.authoritativeView,
        context: action.context,
        selectedParticipantId: action.selectedParticipantId,
        contexts: state.contexts.map((candidate) =>
          candidate.id === action.context.id ? action.context : candidate,
        ),
        capabilities: action.capabilities,
        view: action.view,
        profileRevision: action.profileRevision,
      };
    case "hydrate-failed":
      return {
        ...state,
        view: portalViewAfterLoadFailure(state.view, action.preserveCurrentView),
        authoritativeView: portalViewAfterLoadFailure(
          state.authoritativeView,
          action.preserveCurrentView,
        ),
      };
    case "profile-updated":
      return {
        ...state,
        view: portalViewWithUpdatedProfile(state.view, action.profile, action.asset),
        authoritativeView: portalViewWithUpdatedProfile(
          state.authoritativeView,
          action.profile,
          action.asset,
        ),
        profileRevision: action.revision,
      };
  }
}

type PortalWorkspaceReducerState = {
  workspace: PortalWorkspaceState;
  guideErrors: PortalWorkspaceGuideErrors;
  loading: boolean;
  error: string | null;
};

type PortalWorkspaceAction =
  | { type: "reset" }
  | { type: "loading-set"; loading: boolean }
  | { type: "error-set"; error: string | null }
  | { type: "guide-errors-set"; guideErrors: PortalWorkspaceGuideErrors }
  | { type: "workspace-set"; workspace: PortalWorkspaceState }
  | { type: "roster-set"; submissionId: string; roster: PortalRosterEnvelope }
  | { type: "asset-added"; asset: PortalAsset }
  | { type: "asset-upserted"; asset: PortalAsset }
  | { type: "asset-replaced"; asset: PortalAsset }
  | { type: "asset-history-set"; assetId: string; history: PortalAssetHistoryEntry[] }
  | { type: "asset-comments-set"; assetId: string; comments: PortalAssetComment[] }
  | { type: "asset-comment-added"; comment: PortalAssetComment }
  | { type: "task-form-set"; taskId: string; form: PortalTaskForm }
  | {
      type: "task-response-set";
      taskId: string;
      response: PortalTaskResponseEnvelope;
    };

function initialPortalWorkspaceState(): PortalWorkspaceReducerState {
  return {
    workspace: emptyWorkspace,
    guideErrors: emptyWorkspaceGuideErrors,
    loading: false,
    error: null,
  };
}

function portalWorkspaceReducer(
  state: PortalWorkspaceReducerState,
  action: PortalWorkspaceAction,
): PortalWorkspaceReducerState {
  switch (action.type) {
    case "reset":
      return initialPortalWorkspaceState();
    case "loading-set":
      return { ...state, loading: action.loading };
    case "error-set":
      return { ...state, error: action.error };
    case "guide-errors-set":
      return { ...state, guideErrors: action.guideErrors };
    case "workspace-set":
      return { ...state, workspace: action.workspace };
    case "roster-set":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          rosters: { ...state.workspace.rosters, [action.submissionId]: action.roster },
        },
      };
    case "asset-added":
      return {
        ...state,
        workspace: { ...state.workspace, assets: [action.asset, ...state.workspace.assets] },
      };
    case "asset-upserted":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          assets: [
            ...state.workspace.assets.filter((asset) => asset.id !== action.asset.id),
            action.asset,
          ],
        },
      };
    case "asset-replaced":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          assets: state.workspace.assets.map((asset) =>
            asset.id === action.asset.id ? action.asset : asset,
          ),
        },
      };
    case "asset-history-set":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          assetHistories: {
            ...state.workspace.assetHistories,
            [action.assetId]: action.history,
          },
        },
      };
    case "asset-comments-set":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          assetComments: {
            ...state.workspace.assetComments,
            [action.assetId]: action.comments,
          },
        },
      };
    case "asset-comment-added":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          assetComments: {
            ...state.workspace.assetComments,
            [action.comment.assetId]: [
              ...(state.workspace.assetComments[action.comment.assetId] ?? []),
              action.comment,
            ],
          },
        },
      };
    case "task-form-set":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          taskForms: { ...state.workspace.taskForms, [action.taskId]: action.form },
        },
      };
    case "task-response-set":
      return {
        ...state,
        workspace: {
          ...state.workspace,
          taskResponses: { ...state.workspace.taskResponses, [action.taskId]: action.response },
          taskResponseHistories: {
            ...state.workspace.taskResponseHistories,
            [action.taskId]: [...action.response.history],
          },
        },
      };
  }
}

type PortalAsyncState = {
  loading: boolean;
  error: string | null;
  mutationError: string | null;
  busyTaskIds: ReadonlySet<string>;
  busyAssetIds: ReadonlySet<string>;
  busyRoster: boolean;
  savingProfile: boolean;
  profileMutationState: PortalProfileMutationPhase;
};

type PortalAsyncAction =
  | { type: "loading-set"; loading: boolean }
  | { type: "error-set"; error: string | null }
  | { type: "mutation-error-set"; error: string | null }
  | { type: "task-busy-set"; taskId: string; busy: boolean }
  | { type: "asset-busy-set"; assetId: string; busy: boolean }
  | { type: "roster-busy-set"; busy: boolean }
  | { type: "saving-profile-set"; saving: boolean }
  | { type: "profile-mutation-set"; phase: PortalProfileMutationPhase };

function initialPortalAsyncState(): PortalAsyncState {
  return {
    loading: true,
    error: null,
    mutationError: null,
    busyTaskIds: new Set(),
    busyAssetIds: new Set(),
    busyRoster: false,
    savingProfile: false,
    profileMutationState: "idle",
  };
}

function portalAsyncReducer(state: PortalAsyncState, action: PortalAsyncAction): PortalAsyncState {
  switch (action.type) {
    case "loading-set":
      return { ...state, loading: action.loading };
    case "error-set":
      return { ...state, error: action.error };
    case "mutation-error-set":
      return { ...state, mutationError: action.error };
    case "task-busy-set": {
      const busyTaskIds = new Set(state.busyTaskIds);
      if (action.busy) busyTaskIds.add(action.taskId);
      else busyTaskIds.delete(action.taskId);
      return { ...state, busyTaskIds };
    }
    case "asset-busy-set": {
      const busyAssetIds = new Set(state.busyAssetIds);
      if (action.busy) busyAssetIds.add(action.assetId);
      else busyAssetIds.delete(action.assetId);
      return { ...state, busyAssetIds };
    }
    case "roster-busy-set":
      return { ...state, busyRoster: action.busy };
    case "saving-profile-set":
      return { ...state, savingProfile: action.saving };
    case "profile-mutation-set":
      return { ...state, profileMutationState: action.phase };
  }
}
const EMPTY_PARTICIPANT_ID_LIST: readonly string[] = [];

const emptyWorkspaceGuideErrors: PortalWorkspaceGuideErrors = {
  resources: null,
  wiki: null,
};

interface PortalContextValue {
  eventId: string;
  /** The selected event query is a display/navigation hint, never an authority source. */
  eventQuery: string;
  contexts: readonly PortalContext[];
  context: PortalContext | null;
  authorizedParticipantIds: readonly string[];
  selectedParticipantId: string | null;
  switchParticipant(participantId: string): boolean;
  capabilities: readonly PortalCapability[];
  can(capability: PortalCapability): boolean;
  switchContext(contextId: string): Promise<boolean>;
  view: PortalView | null;
  workspace: PortalWorkspaceState;
  workspaceGuideErrors: PortalWorkspaceGuideErrors;
  workspaceLoading: boolean;
  workspaceError: string | null;
  loading: boolean;
  error: string | null;
  mutationError: string | null;
  busyTaskIds: ReadonlySet<string>;
  busyAssetIds: ReadonlySet<string>;
  busyRoster: boolean;
  savingProfile: boolean;
  profileMutationState: PortalProfileMutationPhase;
  profileRevision: number | null;
  reload(): Promise<void>;
  loadWorkspace(): Promise<void>;
  saveProfile(input: {
    profile: PortalProfile;
    biography: string;
    jobTitle: string;
    company: string;
    socialLinks: Readonly<Record<string, string>>;
    travelLogistics?: PortalTravelLogistics;
    status?: string;
    headshot?: File;
  }): Promise<boolean>;
  transitionTask(task: PortalTask, toStatus: PortalTaskStatus, note?: string): Promise<boolean>;
  uploadTask(task: PortalTask, file: File): Promise<boolean>;
  addRosterEntry(input: {
    submissionId: string;
    email: string;
    displayName: string;
    role: "co_speaker";
  }): Promise<boolean>;
  updateRosterEntry(input: {
    submissionId: string;
    participantId: string;
    displayName?: string;
    email?: string;
    status?: PortalRosterMember["status"];
  }): Promise<boolean>;
  removeRosterEntry(input: { submissionId: string; participantId: string }): Promise<boolean>;
  uploadWorkspaceFile(input: {
    participantId: string;
    sessionId?: string;
    taskId?: string;
    kind: "headshot" | "slides" | "supporting_file";
    file: File;
    supersedesAssetId?: string;
  }): Promise<boolean>;
  retryAssetUpload(input: { assetId: string; file: File }): Promise<boolean>;
  completeAssetUpload(input: { assetId: string }): Promise<boolean>;
  loadAssetHistory(assetId: string): Promise<PortalAssetHistoryEntry[]>;
  loadAssetComments(assetId: string): Promise<PortalAssetComment[]>;
  addAssetComment(input: {
    assetId: string;
    body: string;
    expectedVersion?: number;
  }): Promise<boolean>;
  downloadAsset(assetId: string): Promise<PortalDownloadGrant | null>;
  loadTaskForm(taskId: string): Promise<PortalTaskForm | null>;
  loadTaskResponse(taskId: string): Promise<PortalTaskResponseEnvelope | null>;
  saveTaskResponse(input: {
    taskId: string;
    definitionVersion: number;
    answers: Readonly<Record<string, PortalFormAnswer>>;
    expectedVersion: number;
  }): Promise<boolean>;
  clearMutationError(): void;
  clearWorkspaceError(): void;
}

const PortalContextValueProvider = createContext<PortalContextValue | null>(null);

interface PortalProviderProps {
  children: ReactNode;
  api?: PortalApi;
  apiBaseUrl?: string;
}

function usePortalProviderValue({
  api: providedApi,
  apiBaseUrl: providedApiBaseUrl,
}: Readonly<{
  readonly api?: PortalApi | undefined;
  readonly apiBaseUrl?: string | undefined;
}>) {
  const searchParams = useSearchParams();
  const requestedEventId =
    searchParams?.get("eventId")?.trim() || searchParams?.get("event")?.trim() || undefined;
  const configuredEventId = requestedEventId;
  const apiBaseUrl = providedApiBaseUrl?.trim() ?? "";
  const api = useMemo<PortalApi>(
    () => createPortalProviderApi(providedApi, apiBaseUrl),
    [apiBaseUrl, providedApi],
  );
  const [scopeState, scopeDispatch] = useReducer(
    portalScopeReducer,
    undefined,
    initialPortalScopeState,
  );
  const [workspaceState, workspaceDispatch] = useReducer(
    portalWorkspaceReducer,
    undefined,
    initialPortalWorkspaceState,
  );
  const [asyncState, asyncDispatch] = useReducer(
    portalAsyncReducer,
    undefined,
    initialPortalAsyncState,
  );
  const {
    contexts,
    context,
    selectedParticipantId,
    authoritativeView,
    capabilities,
    view,
    profileRevision,
  } = scopeState;
  const {
    workspace,
    guideErrors: workspaceGuideErrors,
    loading: workspaceLoading,
    error: workspaceError,
  } = workspaceState;
  const {
    loading,
    error,
    mutationError,
    busyTaskIds,
    busyAssetIds,
    busyRoster,
    savingProfile,
    profileMutationState,
  } = asyncState;
  const authoritativeViewRef = useRef<PortalView | null>(null);
  const loadGeneration = useRef(0);
  const profileMutationIdRef = useRef(0);
  const assetCommentRequestsRef = useRef(
    new Map<string, { token: number; controller: AbortController }>(),
  );

  const eventId = context?.eventId ?? "";
  const eventQuery = eventId ? `?event=${encodeURIComponent(eventId)}` : "";
  const authorizedParticipantIds =
    contexts.find((candidate) => candidate.id === context?.id)?.participantIds ??
    EMPTY_PARTICIPANT_ID_LIST;
  const can = useCallback(
    (capability: PortalCapability) => capabilities.includes(capability),
    [capabilities],
  );

  const clearWorkspace = useCallback(() => {
    workspaceDispatch({ type: "reset" });
  }, []);
  const clearMutationError = useCallback(() => {
    asyncDispatch({ type: "mutation-error-set", error: null });
  }, []);

  const clearWorkspaceError = useCallback(() => {
    workspaceDispatch({ type: "error-set", error: null });
  }, []);

  const loadWorkspaceFor = useCallback(
    async (target: PortalContext, nextView: PortalView, signal?: AbortSignal): Promise<void> => {
      const generation = ++loadGeneration.current;
      workspaceDispatch({ type: "loading-set", loading: true });
      workspaceDispatch({ type: "error-set", error: null });
      workspaceDispatch({ type: "guide-errors-set", guideErrors: emptyWorkspaceGuideErrors });
      workspaceDispatch({ type: "workspace-set", workspace: emptyWorkspace });
      try {
        const nextWorkspace: PortalWorkspaceState = {
          rosters: {},
          assets: [],
          assetHistories: {},
          assetComments: {},
          taskForms: {},
          taskResponses: {},
          taskResponseHistories: {},
          resources: [],
          wiki: [],
        };
        const nextGuideErrors: PortalWorkspaceGuideErrors = {
          resources: null,
          wiki: null,
        };
        const formTasks = nextView.tasks.filter(
          (task) => task.type === "form" && taskBelongsToPortalContext(task, target),
        );

        const safely = async <T,>(
          operation: () => Promise<T>,
          fallback: T,
          endpoint: "authority" | "guide" | "optional" = "authority",
          onFailure: (error: unknown) => void = () => undefined,
        ): Promise<T> => {
          try {
            return await operation();
          } catch (operationError) {
            if (isAbort(operationError)) return fallback;
            if (!shouldIsolateWorkspaceReadFailure(endpoint, operationError)) throw operationError;
            onFailure(operationError);
            return fallback;
          }
        };

        const rosterLoad = loadPortalRosters(api, target, nextView, signal);
        const includedAssets = nextView.assets;
        const listAssets = api.listAssets;
        const assetsLoad =
          includedAssets !== undefined
            ? safely(async () => {
                if (
                  includedAssets.some(
                    (asset) => !assetBelongsToPortalContext(asset, target, nextView.tasks),
                  )
                ) {
                  throw new PortalApiError(
                    "CONTEXT_MISMATCH",
                    "The file response belongs to a different event, speaker, or session.",
                    409,
                  );
                }
                return [...includedAssets];
              }, [] as PortalAsset[])
            : listAssets !== undefined && hasPortalCapability(target.capabilities, "asset-read")
              ? safely(async () => {
                  const assets = await listAssets(
                    target.eventId,
                    signal === undefined ? undefined : { signal },
                  );
                  if (
                    assets.some(
                      (asset) => !assetBelongsToPortalContext(asset, target, nextView.tasks),
                    )
                  ) {
                    throw new PortalApiError(
                      "CONTEXT_MISMATCH",
                      "The file response belongs to a different event, speaker, or session.",
                      409,
                    );
                  }
                  return assets;
                }, [] as PortalAsset[])
              : Promise.resolve([] as PortalAsset[]);

        const listResources = api.listResources;
        const resourcesLoad =
          nextView.resources !== undefined
            ? Promise.resolve([...nextView.resources])
            : listResources !== undefined &&
                hasPortalCapability(target.capabilities, "resource-read")
              ? safely(
                  () => listResources(target.eventId, signal),
                  [] as PortalResource[],
                  "guide",
                  (resourceError) => {
                    nextGuideErrors.resources = participantSafeGuideFailure(
                      resourceError,
                      "resources",
                    );
                  },
                )
              : Promise.resolve([] as PortalResource[]);

        const listWiki = api.listWiki;
        const wikiLoad =
          nextView.wiki !== undefined
            ? Promise.resolve([...nextView.wiki])
            : listWiki !== undefined && hasPortalCapability(target.capabilities, "resource-read")
              ? safely(
                  () => listWiki(target.eventId, signal),
                  [] as PortalWikiPage[],
                  "guide",
                  (wikiError) => {
                    nextGuideErrors.wiki = participantSafeGuideFailure(wikiError, "wiki");
                  },
                )
              : Promise.resolve([] as PortalWikiPage[]);

        const taskLoad =
          hasPortalCapability(target.capabilities, "task-response") &&
          (api.getTaskForm !== undefined || api.getTaskResponse !== undefined)
            ? Promise.all(
                formTasks.map(async (task) => {
                  const taskInput =
                    signal === undefined
                      ? { eventId: target.eventId, taskId: task.id }
                      : { eventId: target.eventId, taskId: task.id, signal };
                  const [form, response] = await Promise.all([
                    api.getTaskForm
                      ? safely(
                          async () => {
                            const result = await api.getTaskForm?.(taskInput);
                            if (result === undefined || result.taskId !== task.id) {
                              throw new PortalApiError(
                                "CONTEXT_MISMATCH",
                                "The task form belongs to a different task.",
                                409,
                              );
                            }
                            return result;
                          },
                          undefined as PortalTaskForm | undefined,
                          "optional",
                        )
                      : Promise.resolve(undefined as PortalTaskForm | undefined),
                    api.getTaskResponse
                      ? safely(
                          async () => {
                            const result = await api.getTaskResponse?.(taskInput);
                            if (
                              result === undefined ||
                              result.eventId !== target.eventId ||
                              result.taskId !== task.id ||
                              result.participantId !== target.primaryParticipantId
                            ) {
                              throw new PortalApiError(
                                "CONTEXT_MISMATCH",
                                "The task response belongs to a different event or task.",
                                409,
                              );
                            }
                            return result;
                          },
                          null as PortalTaskResponseEnvelope | null,
                          "optional",
                        )
                      : Promise.resolve(null as PortalTaskResponseEnvelope | null),
                  ]);
                  return { taskId: task.id, form, response };
                }),
              )
            : Promise.resolve(
                [] as readonly {
                  taskId: string;
                  form: PortalTaskForm | undefined;
                  response: PortalTaskResponseEnvelope | null;
                }[],
              );

        const [rosterLoadResult, assets, resources, wiki, taskResults] = await Promise.all([
          rosterLoad,
          assetsLoad,
          resourcesLoad,
          wikiLoad,
          taskLoad,
        ]);
        const fatalRosterFailure = rosterLoadResult.failures.find(
          (rosterFailure) =>
            !isAbort(rosterFailure) && !isOptionalWorkspaceSubreadFailure(rosterFailure),
        );
        if (fatalRosterFailure !== undefined) throw fatalRosterFailure;
        for (const [submissionId, roster] of rosterLoadResult.entries) {
          nextWorkspace.rosters[submissionId] = roster;
        }
        nextWorkspace.assets = assets;
        nextWorkspace.resources = resources;
        nextWorkspace.wiki = wiki;
        for (const { taskId, form, response } of taskResults) {
          if (form !== undefined) {
            nextWorkspace.taskForms[taskId] = form;
          }
          if (response !== null) {
            nextWorkspace.taskResponses[taskId] = response;
            nextWorkspace.taskResponseHistories[taskId] = [...response.history];
          }
        }

        if (signal?.aborted || generation !== loadGeneration.current) {
          return;
        }
        workspaceDispatch({ type: "workspace-set", workspace: nextWorkspace });
        workspaceDispatch({ type: "guide-errors-set", guideErrors: nextGuideErrors });
      } catch (loadError) {
        if (!isAbort(loadError) && isPortalGenerationCurrent(generation, loadGeneration.current)) {
          workspaceDispatch({ type: "error-set", error: messageFrom(loadError) });
        }
      } finally {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          workspaceDispatch({ type: "loading-set", loading: false });
        }
      }
    },
    [api],
  );

  const hydrate = useCallback(
    async (
      target: PortalContext,
      signal?: AbortSignal,
      prefetchedView?: PortalPrefetchResult,
      requestedParticipantId?: string | null,
      preserveCurrentView = false,
    ): Promise<boolean> => {
      const generation = ++loadGeneration.current;
      const requestedSelection = requestedParticipantId ?? target.primaryParticipantId ?? null;
      if (!preserveCurrentView) {
        scopeDispatch({ type: "context-set", context: target });
        scopeDispatch({
          type: "selected-participant-set",
          participantId: portalSelectedParticipantId(target, requestedSelection),
        });
        scopeDispatch({
          type: "capabilities-set",
          capabilities: normalizeCapabilities(target.capabilities),
        });
        scopeDispatch({ type: "view-set", view: null });
        clearWorkspace();
      }
      asyncDispatch({ type: "mutation-error-set", error: null });
      asyncDispatch({ type: "loading-set", loading: true });
      asyncDispatch({ type: "error-set", error: null });
      try {
        if (prefetchedView?.status === "rejected") {
          if (signal?.aborted || generation !== loadGeneration.current) {
            return false;
          }
          throw prefetchedView.reason;
        }
        const nextView =
          prefetchedView?.status === "fulfilled"
            ? prefetchedView.value
            : await api.getPortal(target.eventId, signal);
        if (signal?.aborted || generation !== loadGeneration.current) {
          return false;
        }
        const serverContext = portalContextResponseForTarget(target, nextView.context);
        const nextCapabilities = normalizeCapabilities(
          nextView.capabilities ?? serverContext.capabilities,
        );
        const authorizedContext = scopePortalContextToAuthorizedParticipants(serverContext);
        const selected = portalSelectedParticipantId(authorizedContext, requestedSelection);
        const scopedView = scopePortalViewToAuthorizedParticipants(
          { ...nextView, context: serverContext, capabilities: nextCapabilities },
          authorizedContext,
          selected,
        );
        const scopedContext =
          scopedView.context ??
          scopePortalContextToAuthorizedParticipants(authorizedContext, selected);
        const authoritative = {
          ...nextView,
          context: serverContext,
          capabilities: nextCapabilities,
        };
        authoritativeViewRef.current = authoritative;
        scopeDispatch({
          type: "hydrate-succeeded",
          authoritativeView: authoritative,
          context: scopedContext,
          selectedParticipantId: selected,
          capabilities: nextCapabilities,
          view: scopedView,
          profileRevision:
            scopedView.profiles.find(
              (profile) =>
                profile.eventId === scopedContext.eventId && profile.participantId === selected,
            )?.version ?? null,
        });
        workspaceDispatch({
          type: "workspace-set",
          workspace: { ...emptyWorkspace, assets: [...(scopedView.assets ?? [])] },
        });
        return true;
      } catch (loadError) {
        if (isAbort(loadError)) {
          return false;
        }
        if (generation === loadGeneration.current) {
          const failedAuthoritativeView = portalViewAfterLoadFailure(
            authoritativeViewRef.current,
            preserveCurrentView,
          );
          scopeDispatch({
            type: "hydrate-failed",
            preserveCurrentView,
          });
          authoritativeViewRef.current = failedAuthoritativeView;
          asyncDispatch({ type: "error-set", error: messageFrom(loadError) });
        }
        return false;
      } finally {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "loading-set", loading: false });
          workspaceDispatch({ type: "loading-set", loading: false });
        }
      }
    },
    [api, clearWorkspace],
  );

  const loadInitial = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const generation = ++loadGeneration.current;
      asyncDispatch({ type: "loading-set", loading: true });
      asyncDispatch({ type: "error-set", error: null });
      try {
        const startup = await loadPortalStartup(api, configuredEventId, signal);
        if (signal?.aborted || generation !== loadGeneration.current) {
          return;
        }
        scopeDispatch({ type: "contexts-set", contexts: startup.authorizedContexts });
        if (startup.authorizedContexts.length === 0) {
          scopeDispatch({ type: "context-set", context: null });
          scopeDispatch({ type: "selected-participant-set", participantId: null });
          scopeDispatch({ type: "capabilities-set", capabilities: [] });
          scopeDispatch({ type: "view-set", view: null });
          scopeDispatch({ type: "authoritative-view-set", view: null });
          authoritativeViewRef.current = null;
          scopeDispatch({ type: "profile-revision-set", revision: null });
          asyncDispatch({ type: "profile-mutation-set", phase: "idle" });
          clearWorkspace();
          asyncDispatch({ type: "mutation-error-set", error: null });
          asyncDispatch({ type: "error-set", error: null });
          return;
        }
        const preferred = startup.preferredContext;
        if (!preferred) {
          throw new PortalApiError(
            "NO_PORTAL_CONTEXT",
            "No authorized event context is available.",
            403,
          );
        }
        await hydrate(preferred, signal, startup.prefetchedView);
      } catch (loadError) {
        if (!isAbort(loadError) && generation === loadGeneration.current) {
          scopeDispatch({ type: "context-set", context: null });
          scopeDispatch({ type: "view-set", view: null });
          clearWorkspace();
          asyncDispatch({ type: "error-set", error: messageFrom(loadError) });
        }
      } finally {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "loading-set", loading: false });
        }
      }
    },
    [api, clearWorkspace, configuredEventId, hydrate],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadInitial(controller.signal);
    return () => {
      controller.abort();
      loadGeneration.current += 1;
      for (const request of assetCommentRequestsRef.current.values()) request.controller.abort();
      assetCommentRequestsRef.current.clear();
    };
  }, [loadInitial]);

  const reload = useCallback(async () => {
    if (context) {
      const target = contexts.find((candidate) => candidate.id === context.id) ?? context;
      await hydrate(
        target,
        undefined,
        undefined,
        selectedParticipantId,
        portalViewMatchesSelection(view, target, selectedParticipantId),
      );
    } else {
      await loadInitial();
    }
  }, [context, contexts, hydrate, loadInitial, selectedParticipantId, view]);

  const switchContext = useCallback(
    async (contextId: string): Promise<boolean> => {
      const target = contexts.find((candidate) => candidate.id === contextId);
      if (!target || target.id === context?.id) {
        return target?.id === context?.id;
      }
      scopeDispatch({ type: "view-set", view: null });
      scopeDispatch({ type: "authoritative-view-set", view: null });
      authoritativeViewRef.current = null;
      scopeDispatch({ type: "selected-participant-set", participantId: null });
      scopeDispatch({ type: "profile-revision-set", revision: null });
      asyncDispatch({ type: "profile-mutation-set", phase: "idle" });
      asyncDispatch({ type: "saving-profile-set", saving: false });
      clearWorkspace();
      asyncDispatch({ type: "mutation-error-set", error: null });
      asyncDispatch({ type: "error-set", error: null });
      asyncDispatch({ type: "loading-set", loading: true });
      return hydrate(target);
    },
    [clearWorkspace, context?.id, contexts, hydrate],
  );

  const switchParticipant = useCallback(
    (participantId: string): boolean => {
      const target =
        (context === null
          ? undefined
          : contexts.find((candidate) => candidate.id === context.id)) ?? context;
      if (!target) {
        return false;
      }
      const selected = portalSelectedParticipantId(target, participantId);
      if (selected === null) {
        return false;
      }
      const source = authoritativeViewRef.current ?? authoritativeView;
      if (!source) {
        return false;
      }
      loadGeneration.current += 1;
      const scopedContext = scopePortalContextToAuthorizedParticipants(target, selected);
      const scopedView = scopePortalViewToAuthorizedParticipants(source, target, selected);
      scopeDispatch({ type: "context-set", context: scopedContext });
      scopeDispatch({ type: "selected-participant-set", participantId: selected });
      scopeDispatch({ type: "view-set", view: scopedView });
      scopeDispatch({
        type: "profile-revision-set",
        revision:
          scopedView.profiles.find(
            (profile) =>
              profile.eventId === scopedContext.eventId && profile.participantId === selected,
          )?.version ?? null,
      });
      asyncDispatch({ type: "profile-mutation-set", phase: "idle" });
      asyncDispatch({ type: "saving-profile-set", saving: false });
      asyncDispatch({ type: "mutation-error-set", error: null });
      workspaceDispatch({
        type: "workspace-set",
        workspace: { ...emptyWorkspace, assets: [...(scopedView.assets ?? [])] },
      });
      return true;
    },
    [authoritativeView, context, contexts],
  );
  const loadWorkspace = useCallback(async () => {
    if (context && view) {
      await loadWorkspaceFor(context, view);
      return;
    }
    workspaceDispatch({ type: "loading-set", loading: false });
  }, [context, loadWorkspaceFor, view]);

  const saveProfile = useCallback(
    async (input: {
      profile: PortalProfile;
      biography: string;
      jobTitle: string;
      company: string;
      socialLinks: Readonly<Record<string, string>>;
      travelLogistics?: PortalTravelLogistics;
      status?: string;
      headshot?: File;
    }) => {
      if (!context) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "No authorized portal context is available.",
        });
        asyncDispatch({ type: "profile-mutation-set", phase: "failure" });
        return false;
      }
      if (!can("profile-self")) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to edit this profile.",
        });
        asyncDispatch({ type: "profile-mutation-set", phase: "failure" });
        return false;
      }
      const activeParticipantId = selectedParticipantId ?? context.primaryParticipantId;
      if (
        !activeParticipantId ||
        input.profile.eventId !== context.eventId ||
        input.profile.participantId !== activeParticipantId
      ) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This profile does not belong to the active speaker.",
        });
        asyncDispatch({ type: "profile-mutation-set", phase: "failure" });
        return false;
      }
      if (!api.updateProfile) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "The speaker profile API is not available yet.",
        });
        asyncDispatch({ type: "profile-mutation-set", phase: "failure" });
        return false;
      }
      if (input.headshot && (!can("asset-write") || !api.uploadFile || !api.finalizeAsset)) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "Private headshot uploads are not available for this event.",
        });
        asyncDispatch({ type: "profile-mutation-set", phase: "failure" });
        return false;
      }

      const targetContext = context;
      const generation = loadGeneration.current;
      const mutationId = profileMutationIdRef.current + 1;
      profileMutationIdRef.current = mutationId;
      asyncDispatch({ type: "saving-profile-set", saving: true });
      asyncDispatch({ type: "profile-mutation-set", phase: "saving" });
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        let finalizedHeadshot: PortalAsset | undefined;
        if (input.headshot && api.uploadFile && api.finalizeAsset) {
          const knownAssets = [
            ...new Map(
              [...workspace.assets, ...(view?.assets ?? [])].map((asset) => [asset.id, asset]),
            ).values(),
          ];
          const referenceId =
            typeof input.profile.headshotAssetId === "string"
              ? input.profile.headshotAssetId
              : undefined;
          const referenced =
            referenceId === undefined
              ? undefined
              : knownAssets.find((asset) => asset.id === referenceId);
          const headshotRows = knownAssets.filter(
            (asset) =>
              asset.eventId === targetContext.eventId &&
              asset.participantId === activeParticipantId &&
              asset.kind === "headshot" &&
              asset.sessionId === undefined &&
              asset.taskId === undefined,
          );
          const familyIds = new Set(
            headshotRows.flatMap((asset) =>
              asset.versionFamilyId === undefined ? [] : [asset.versionFamilyId],
            ),
          );
          const headshotFamilyMalformed = headshotRows.some(
            (asset) => asset.versionFamilyId === undefined,
          );
          const familySeed =
            referenced ??
            (familyIds.size === 1
              ? headshotRows.find((asset) => asset.versionFamilyId === [...familyIds][0])
              : undefined);
          const familyRows =
            familySeed?.versionFamilyId === undefined
              ? []
              : headshotRows.filter(
                  (asset) => asset.versionFamilyId === familySeed.versionFamilyId,
                );
          const familyResolution =
            familySeed === undefined ? null : resolvePortalAssetFamily(familyRows, familySeed);
          const authoritativeHead =
            familyResolution !== null &&
            (familyResolution.status === "ready" || familyResolution.status === "rejected") &&
            familyResolution.pointers.status === "ready"
              ? familyResolution.latest
              : undefined;
          const replacement =
            headshotRows.length === 0
              ? undefined
              : authoritativeHead === undefined
                ? null
                : workspaceReplacementTuple(knownAssets, authoritativeHead.id);
          if (
            (referenceId !== undefined &&
              (referenced === undefined ||
                !headshotRows.some((asset) => asset.id === referenced.id))) ||
            familyIds.size > 1 ||
            headshotFamilyMalformed ||
            (headshotRows.length > 0 && replacement === null)
          ) {
            throw new PortalApiError(
              "CONTEXT_MISMATCH",
              "The existing headshot does not have authoritative version metadata.",
              409,
            );
          }
          const replacementTuple = replacement ?? undefined;
          const headshotInput = {
            eventId: targetContext.eventId,
            participantId: activeParticipantId,
            sessionId: undefined,
            taskId: undefined,
            kind: "headshot" as const,
          };
          asyncDispatch({ type: "profile-mutation-set", phase: "pending" });
          const pending = await api.uploadFile({
            eventId: targetContext.eventId,
            participantId: activeParticipantId,
            kind: "headshot",
            file: input.headshot,
            ...(replacementTuple === undefined
              ? {}
              : {
                  supersedesAssetId: replacementTuple.predecessor.id,
                  expectedLatestVersion: replacementTuple.expectedLatestVersion,
                }),
          });
          if (
            (replacementTuple === undefined &&
              !assetMatchesInitialVersion(pending, {
                ...headshotInput,
                state: "pending_upload",
              })) ||
            (replacementTuple !== undefined &&
              !assetMatchesWorkspaceReplacement(pending, replacementTuple, {
                ...headshotInput,
                state: "pending_upload",
              }))
          ) {
            throw new PortalApiError(
              "CONTEXT_MISMATCH",
              "The headshot upload lineage is invalid.",
              409,
            );
          }
          finalizedHeadshot = await api.finalizeAsset({
            eventId: targetContext.eventId,
            assetId: pending.id,
            state: "ready",
          });
          if (
            finalizedHeadshot.id !== pending.id ||
            (replacementTuple === undefined &&
              !assetMatchesInitialVersion(finalizedHeadshot, {
                ...headshotInput,
                state: "ready",
              })) ||
            (replacementTuple !== undefined &&
              !assetMatchesWorkspaceReplacement(finalizedHeadshot, replacementTuple, {
                ...headshotInput,
                state: "ready",
              })) ||
            !profileAssetBelongsToPortalContext(finalizedHeadshot, targetContext)
          ) {
            throw new PortalApiError(
              "CONTEXT_MISMATCH",
              "The finalized headshot does not preserve its authoritative version family.",
              409,
            );
          }
        }

        asyncDispatch({ type: "profile-mutation-set", phase: "saving" });
        const updated = await api.updateProfile({
          eventId: targetContext.eventId,
          participantId: activeParticipantId,
          biography: input.biography,
          jobTitle: input.jobTitle,
          company: input.company,
          socialLinks: input.socialLinks,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.travelLogistics === undefined
            ? {}
            : { travelLogistics: input.travelLogistics }),
          ...(finalizedHeadshot === undefined ? {} : { headshotAssetId: finalizedHeadshot.id }),
          expectedVersion: input.profile.version,
        });
        const classification = classifyPortalProfileMutation(updated, {
          eventId: targetContext.eventId,
          participantId: activeParticipantId,
          version: input.profile.version,
        });
        if (classification.state !== "saved") {
          throw new PortalApiError("PROFILE_NOT_AUTHORITATIVE", classification.message, 502);
        }
        if (finalizedHeadshot !== undefined && updated.headshotAssetId !== finalizedHeadshot.id) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The saved profile does not reference the finalized headshot.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return false;
        }
        const nextAuthoritative = portalViewWithUpdatedProfile(
          authoritativeViewRef.current,
          updated,
          finalizedHeadshot,
        );
        authoritativeViewRef.current = nextAuthoritative;
        scopeDispatch({
          type: "profile-updated",
          profile: updated,
          ...(finalizedHeadshot === undefined ? {} : { asset: finalizedHeadshot }),
          revision: updated.version,
        });
        asyncDispatch({ type: "profile-mutation-set", phase: "saved" });
        if (finalizedHeadshot !== undefined) {
          workspaceDispatch({ type: "asset-upserted", asset: finalizedHeadshot });
        }
        return true;
      } catch (saveError) {
        const conflict =
          saveError instanceof PortalApiError && saveError.code === "VERSION_CONFLICT";
        if (conflict && isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "profile-mutation-set", phase: "conflict" });
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(saveError) });
          const refreshTarget =
            contexts.find((candidate) => candidate.id === targetContext.id) ?? targetContext;
          await hydrate(refreshTarget, undefined, undefined, activeParticipantId);
          if (isPortalGenerationCurrent(generation + 1, loadGeneration.current)) {
            asyncDispatch({ type: "profile-mutation-set", phase: "conflict" });
            asyncDispatch({ type: "mutation-error-set", error: messageFrom(saveError) });
          }
          return false;
        }
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "profile-mutation-set", phase: "failure" });
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(saveError) });
        }
        return false;
      } finally {
        if (mutationId === profileMutationIdRef.current) {
          asyncDispatch({ type: "saving-profile-set", saving: false });
        }
      }
    },
    [api, can, context, contexts, hydrate, selectedParticipantId, view, workspace.assets],
  );

  const transitionTask = useCallback(
    async (task: PortalTask, toStatus: PortalTaskStatus, note?: string) => {
      if (!context) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "No authorized portal context is available.",
        });
        return false;
      }
      if (!can("task-response")) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to respond to this task.",
        });
        return false;
      }
      const targetContext = context;
      if (
        !taskBelongsToPortalContext(task, context) ||
        !view?.tasks.some(
          (candidate) => candidate.id === task.id && taskBelongsToPortalContext(candidate, context),
        )
      ) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This task does not belong to the active speaker.",
        });
        return false;
      }
      const generation = loadGeneration.current;
      asyncDispatch({ type: "task-busy-set", taskId: task.id, busy: true });
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        const updated = await api.transitionTask({
          eventId: targetContext.eventId,
          taskId: task.id,
          toStatus,
          expectedVersion: task.version,
          ...(note === undefined ? {} : { note }),
        });
        if (!taskMutationMatches(updated, task, targetContext.eventId, toStatus)) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The saved task does not match the active speaker or requested status.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return false;
        }
        scopeDispatch({ type: "task-updated", task: updated });
        return true;
      } catch (transitionError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(transitionError) });
        }
        return false;
      } finally {
        asyncDispatch({ type: "task-busy-set", taskId: task.id, busy: false });
      }
    },
    [api, can, context, view],
  );

  const uploadTask = useCallback(
    async (task: PortalTask, file: File) => {
      if (!context) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "No authorized portal context is available.",
        });
        return false;
      }
      if (!can("task-response") || !can("asset-write")) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to upload this task file.",
        });
        return false;
      }
      if (!api.finalizeAsset) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "Upload completion is not available yet.",
        });
        return false;
      }
      const authoritativeTask = view?.tasks.find((candidate) => candidate.id === task.id);
      const sameSubject =
        authoritativeTask?.subject.type === task.subject.type &&
        (authoritativeTask?.subject.type === "participant" ||
          (authoritativeTask?.subject.type === "session" &&
            task.subject.type === "session" &&
            authoritativeTask.subject.sessionId === task.subject.sessionId));
      if (
        authoritativeTask === undefined ||
        !taskBelongsToPortalContext(authoritativeTask, context) ||
        authoritativeTask.type !== "upload" ||
        authoritativeTask.eventId !== task.eventId ||
        authoritativeTask.participantId !== task.participantId ||
        !sameSubject
      ) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This task does not belong to the active speaker.",
        });
        return false;
      }
      const kind = authoritativeTask.acceptedAssetKinds?.[0];
      if (!kind) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This upload task does not specify an accepted file kind.",
        });
        return false;
      }
      const taskSessionId =
        authoritativeTask.subject.type === "session"
          ? authoritativeTask.subject.sessionId
          : undefined;
      const targetContext = context;
      const generation = loadGeneration.current;
      const knownAssets = [
        ...new Map(
          [...workspace.assets, ...(view?.assets ?? [])].map((asset) => [asset.id, asset]),
        ).values(),
      ];
      const matchingRows = knownAssets.filter(
        (asset) =>
          asset.taskId === authoritativeTask.id &&
          asset.sessionId === taskSessionId &&
          asset.kind === kind,
      );
      const taskFamilyIds = matchingRows.map((asset) => asset.versionFamilyId);
      const uniqueTaskFamilyIds = new Set(
        taskFamilyIds.filter((familyId): familyId is string => familyId !== undefined),
      );
      const taskFamilyMalformed =
        matchingRows.some((asset) => asset.versionFamilyId === undefined) ||
        uniqueTaskFamilyIds.size > 1;
      const taskFamilyResolution =
        matchingRows.length === 0 || taskFamilyMalformed
          ? null
          : resolvePortalAssetFamily(matchingRows, matchingRows[0]);
      const pendingRetry =
        taskFamilyResolution?.status === "pending" &&
        taskFamilyResolution.pointers.status === "ready" &&
        taskFamilyResolution.latest !== undefined
          ? taskFamilyResolution.latest
          : undefined;
      const replacement =
        taskFamilyResolution !== null &&
        (taskFamilyResolution.status === "ready" || taskFamilyResolution.status === "rejected") &&
        taskFamilyResolution.pointers.status === "ready" &&
        taskFamilyResolution.latest !== undefined
          ? workspaceReplacementTuple(knownAssets, taskFamilyResolution.latest.id)
          : null;
      if (
        (matchingRows.length > 0 && pendingRetry === undefined && replacement === null) ||
        (pendingRetry !== undefined && api.retryAssetUpload === undefined)
      ) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This task file has conflicting or incomplete version metadata.",
        });
        return false;
      }
      const replacementTuple = replacement ?? undefined;
      const taskAssetInput = {
        eventId: targetContext.eventId,
        participantId: authoritativeTask.participantId,
        sessionId: taskSessionId,
        taskId: authoritativeTask.id,
        kind,
      };
      asyncDispatch({ type: "task-busy-set", taskId: authoritativeTask.id, busy: true });
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        const uploaded =
          pendingRetry !== undefined && api.retryAssetUpload !== undefined
            ? await api.retryAssetUpload({
                eventId: targetContext.eventId,
                assetId: pendingRetry.id,
                file,
              })
            : await api.uploadTaskFile({
                eventId: targetContext.eventId,
                participantId: authoritativeTask.participantId,
                taskId: authoritativeTask.id,
                ...(taskSessionId === undefined ? {} : { sessionId: taskSessionId }),
                kind,
                file,
                ...(replacementTuple === undefined
                  ? {}
                  : {
                      supersedesAssetId: replacementTuple.predecessor.id,
                      expectedLatestVersion: replacementTuple.expectedLatestVersion,
                    }),
              });
        if (
          (pendingRetry !== undefined &&
            !assetMatchesPendingRetry(uploaded, pendingRetry, {
              ...taskAssetInput,
              state: "pending_upload",
            })) ||
          (pendingRetry === undefined &&
            replacementTuple === undefined &&
            !assetMatchesInitialVersion(uploaded, {
              ...taskAssetInput,
              state: "pending_upload",
            })) ||
          (pendingRetry === undefined &&
            replacementTuple !== undefined &&
            !assetMatchesWorkspaceReplacement(uploaded, replacementTuple, {
              ...taskAssetInput,
              state: "pending_upload",
            }))
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The uploaded task file lineage is invalid.",
            409,
          );
        }
        const finalized = await api.finalizeAsset({
          eventId: targetContext.eventId,
          assetId: uploaded.id,
          state: "ready",
        });
        if (
          finalized.id !== uploaded.id ||
          (pendingRetry !== undefined &&
            (!assetMatchesPendingRetry(finalized, pendingRetry, {
              ...taskAssetInput,
              state: "ready",
            }) ||
              !assetBelongsToPortalContext(finalized, targetContext, view?.tasks ?? []))) ||
          (pendingRetry === undefined &&
            replacementTuple !== undefined &&
            !assetMatchesWorkspaceReplacement(finalized, replacementTuple, {
              ...taskAssetInput,
              state: "ready",
            })) ||
          (pendingRetry === undefined &&
            replacementTuple === undefined &&
            (!assetMatchesInitialVersion(finalized, { ...taskAssetInput, state: "ready" }) ||
              !assetBelongsToPortalContext(finalized, targetContext, view?.tasks ?? [])))
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The finalized task file does not preserve the authoritative session and version family.",
            409,
          );
        }
        const updated = await api.transitionTask({
          eventId: targetContext.eventId,
          taskId: authoritativeTask.id,
          toStatus: "submitted",
          expectedVersion: authoritativeTask.version,
          note: `Uploaded ${file.name}`,
        });
        if (!taskMutationMatches(updated, authoritativeTask, targetContext.eventId, "submitted")) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The saved upload task does not match the active speaker or submitted status.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return false;
        }
        scopeDispatch({ type: "task-asset-updated", task: updated, asset: finalized });
        workspaceDispatch({ type: "asset-upserted", asset: finalized });
        return true;
      } catch (uploadError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(uploadError) });
        }
        return false;
      } finally {
        asyncDispatch({ type: "task-busy-set", taskId: authoritativeTask.id, busy: false });
      }
    },
    [api, can, context, view, workspace.assets],
  );

  const addRosterEntry = useCallback(
    async (input: {
      submissionId: string;
      email: string;
      displayName: string;
      role: "co_speaker";
    }) => {
      if (!context) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "No authorized portal context is available.",
        });
        return false;
      }
      if (!can("roster-manage")) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to manage co-speakers.",
        });
        return false;
      }
      if (!api.addRosterEntry) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "Co-speaker management is not available yet.",
        });
        return false;
      }
      const targetContext = context;
      const rosterSubmissionId = acceptedSubmissionId(input.submissionId, context, view);
      if (rosterSubmissionId === null) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This roster does not belong to an active accepted session.",
        });
        return false;
      }
      const generation = loadGeneration.current;
      asyncDispatch({ type: "roster-busy-set", busy: true });
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        const roster = await api.addRosterEntry({
          eventId: targetContext.eventId,
          ...input,
          submissionId: rosterSubmissionId,
        });
        if (
          roster.eventId !== targetContext.eventId ||
          !portalSubmissionIdsMatch(roster.submissionId, rosterSubmissionId)
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The roster response belongs to a different event or session.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return false;
        }
        workspaceDispatch({
          type: "roster-set",
          submissionId: rosterSubmissionId,
          roster,
        });
        return true;
      } catch (addError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(addError) });
        }
        return false;
      } finally {
        asyncDispatch({ type: "roster-busy-set", busy: false });
      }
    },
    [api, can, context, view],
  );

  const updateRosterEntry = useCallback(
    async (input: {
      submissionId: string;
      participantId: string;
      displayName?: string;
      email?: string;
      status?: PortalRosterMember["status"];
    }) => {
      if (!context) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "No authorized portal context is available.",
        });
        return false;
      }
      if (!can("roster-manage")) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to manage co-speakers.",
        });
        return false;
      }
      if (!api.updateRosterEntry) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "Co-speaker management is not available yet.",
        });
        return false;
      }
      const targetContext = context;
      const rosterSubmissionId = acceptedSubmissionId(input.submissionId, context, view);
      if (rosterSubmissionId === null) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This roster does not belong to an active accepted session.",
        });
        return false;
      }
      const generation = loadGeneration.current;
      asyncDispatch({ type: "roster-busy-set", busy: true });
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        const roster = await api.updateRosterEntry({
          eventId: targetContext.eventId,
          ...input,
          submissionId: rosterSubmissionId,
        });
        if (
          roster.eventId !== targetContext.eventId ||
          !portalSubmissionIdsMatch(roster.submissionId, rosterSubmissionId) ||
          !submissionIdAuthorized(targetContext, roster.submissionId)
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The roster response belongs to a different event or session.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return false;
        }
        workspaceDispatch({
          type: "roster-set",
          submissionId: rosterSubmissionId,
          roster,
        });
        return true;
      } catch (updateError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(updateError) });
        }
        return false;
      } finally {
        asyncDispatch({ type: "roster-busy-set", busy: false });
      }
    },
    [api, can, context, view],
  );

  const removeRosterEntry = useCallback(
    async (input: { submissionId: string; participantId: string }) => {
      if (!context) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "No authorized portal context is available.",
        });
        return false;
      }
      if (!can("roster-manage")) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to manage co-speakers.",
        });
        return false;
      }
      if (!api.removeRosterEntry) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "Co-speaker management is not available yet.",
        });
        return false;
      }
      const targetContext = context;
      const rosterSubmissionId = acceptedSubmissionId(input.submissionId, context, view);
      if (rosterSubmissionId === null) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This roster does not belong to an active accepted session.",
        });
        return false;
      }
      const generation = loadGeneration.current;
      asyncDispatch({ type: "roster-busy-set", busy: true });
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        const roster = await api.removeRosterEntry({
          eventId: targetContext.eventId,
          ...input,
          submissionId: rosterSubmissionId,
        });
        if (
          roster.eventId !== targetContext.eventId ||
          !portalSubmissionIdsMatch(roster.submissionId, rosterSubmissionId) ||
          !submissionIdAuthorized(targetContext, roster.submissionId)
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The roster response belongs to a different event or session.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return false;
        }
        workspaceDispatch({
          type: "roster-set",
          submissionId: rosterSubmissionId,
          roster,
        });
        return true;
      } catch (removeError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(removeError) });
        }
        return false;
      } finally {
        asyncDispatch({ type: "roster-busy-set", busy: false });
      }
    },
    [api, can, context, view],
  );

  const uploadWorkspaceFile = useCallback(
    async (input: {
      participantId: string;
      sessionId?: string;
      taskId?: string;
      kind: "headshot" | "slides" | "supporting_file";
      file: File;
      supersedesAssetId?: string;
    }) => {
      if (!context) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "No authorized portal context is available.",
        });
        return false;
      }
      if (!can("asset-write") || !can("task-response")) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to upload files.",
        });
        return false;
      }
      if (!api.uploadFile || !api.finalizeAsset) {
        asyncDispatch({ type: "mutation-error-set", error: "File uploads are not available yet." });
        return false;
      }
      const targetContext = context;
      const uploadSessionId = input.sessionId;
      const knownAssets = [
        ...new Map(
          [...workspace.assets, ...(view?.assets ?? [])].map((asset) => [asset.id, asset]),
        ).values(),
      ];
      const replacement =
        input.supersedesAssetId === undefined
          ? undefined
          : (workspaceReplacementTuple(knownAssets, input.supersedesAssetId) ?? undefined);
      const taskId = input.taskId ?? replacement?.taskId;
      const inputTask =
        taskId === undefined ? undefined : view?.tasks.find((task) => task.id === taskId);
      const isTasklessReplacement =
        replacement !== undefined &&
        replacement.taskId === undefined &&
        taskId === undefined &&
        replacement.predecessor.eventId === targetContext.eventId &&
        replacement.predecessor.participantId === input.participantId &&
        replacement.predecessor.kind === input.kind &&
        replacement.sessionId === uploadSessionId &&
        assetBelongsToPortalContext(replacement.predecessor, context, view?.tasks ?? []);
      const isAuthorizedTaskUpload =
        inputTask !== undefined &&
        taskBelongsToPortalContext(inputTask, context) &&
        inputTask.type === "upload" &&
        inputTask.subject.type === "session" &&
        inputTask.subject.sessionId === uploadSessionId &&
        inputTask.acceptedAssetKinds?.includes(input.kind) &&
        (replacement === undefined || replacement.taskId === inputTask.id);
      if (
        input.participantId !== context.primaryParticipantId ||
        uploadSessionId === undefined ||
        (!isTasklessReplacement && !isAuthorizedTaskUpload)
      ) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This file does not belong to an authorized session upload task.",
        });
        return false;
      }
      const generation = loadGeneration.current;
      const busyKey = input.supersedesAssetId ?? `${input.kind}:${input.file.name}`;
      asyncDispatch({ type: "asset-busy-set", assetId: busyKey, busy: true });
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        const pendingAsset = await api.uploadFile({
          eventId: targetContext.eventId,
          ...input,
          ...(taskId === undefined ? {} : { taskId }),
          sessionId: uploadSessionId,
          ...(replacement === undefined
            ? {}
            : {
                expectedLatestVersion: replacement.expectedLatestVersion,
              }),
        });
        if (
          (replacement === undefined &&
            (!assetBelongsToPortalContext(pendingAsset, targetContext, view?.tasks ?? []) ||
              !assetMatchesInitialVersion(pendingAsset, {
                eventId: targetContext.eventId,
                participantId: input.participantId,
                sessionId: uploadSessionId,
                taskId,
                kind: input.kind,
                state: "pending_upload",
              }))) ||
          (replacement !== undefined &&
            !assetMatchesWorkspaceReplacement(pendingAsset, replacement, {
              eventId: targetContext.eventId,
              participantId: input.participantId,
              sessionId: uploadSessionId,
              kind: input.kind,
              state: "pending_upload",
            }))
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The file response does not preserve the requested version family.",
            409,
          );
        }
        const asset = await api.finalizeAsset({
          eventId: targetContext.eventId,
          assetId: pendingAsset.id,
          state: "ready",
        });
        if (
          asset.id !== pendingAsset.id ||
          (replacement === undefined &&
            (!assetBelongsToPortalContext(asset, targetContext, view?.tasks ?? []) ||
              !assetMatchesInitialVersion(asset, {
                eventId: targetContext.eventId,
                participantId: input.participantId,
                sessionId: uploadSessionId,
                taskId,
                kind: input.kind,
                state: "ready",
              }))) ||
          (replacement !== undefined &&
            !assetMatchesWorkspaceReplacement(asset, replacement, {
              eventId: targetContext.eventId,
              participantId: input.participantId,
              sessionId: uploadSessionId,
              kind: input.kind,
              state: "ready",
            }))
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The finalized file does not preserve the requested version family.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return false;
        }
        workspaceDispatch({ type: "asset-added", asset });
        return true;
      } catch (uploadError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(uploadError) });
        }
        return false;
      } finally {
        asyncDispatch({ type: "asset-busy-set", assetId: busyKey, busy: false });
      }
    },
    [api, can, context, view, workspace.assets],
  );

  const retryAssetUpload = useCallback(
    async (input: { assetId: string; file: File }) => {
      if (!context) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "No authorized portal context is available.",
        });
        return false;
      }
      if (!can("asset-write") || !api.retryAssetUpload || !api.finalizeAsset) {
        asyncDispatch({ type: "mutation-error-set", error: "Upload retry is not available yet." });
        return false;
      }
      const knownAsset =
        workspace.assets.find((candidate) => candidate.id === input.assetId) ??
        view?.assets?.find((candidate) => candidate.id === input.assetId);
      if (
        knownAsset === undefined ||
        knownAsset.state !== "pending_upload" ||
        !assetBelongsToPortalContext(knownAsset, context, view?.tasks ?? [])
      ) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This upload is no longer pending or does not belong to the active speaker.",
        });
        return false;
      }
      const targetContext = context;
      const generation = loadGeneration.current;
      asyncDispatch({ type: "asset-busy-set", assetId: input.assetId, busy: true });
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        const pendingAsset = await api.retryAssetUpload({
          eventId: targetContext.eventId,
          assetId: input.assetId,
          file: input.file,
        });
        if (
          !assetMatchesPendingRetry(pendingAsset, knownAsset, {
            eventId: targetContext.eventId,
            participantId: knownAsset.participantId,
            sessionId: knownAsset.sessionId,
            taskId: knownAsset.taskId,
            kind: knownAsset.kind,
            state: "pending_upload",
          }) ||
          pendingAsset.fileName !== knownAsset.fileName ||
          pendingAsset.contentType !== knownAsset.contentType ||
          pendingAsset.sizeBytes !== knownAsset.sizeBytes ||
          !assetBelongsToPortalContext(pendingAsset, targetContext, view?.tasks ?? [])
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The retried upload does not match the pending file.",
            409,
          );
        }
        const asset = await api.finalizeAsset({
          eventId: targetContext.eventId,
          assetId: pendingAsset.id,
          state: "ready",
        });
        if (
          !assetMatchesPendingRetry(asset, knownAsset, {
            eventId: targetContext.eventId,
            participantId: knownAsset.participantId,
            sessionId: knownAsset.sessionId,
            taskId: knownAsset.taskId,
            kind: knownAsset.kind,
            state: "ready",
          }) ||
          !assetBelongsToPortalContext(asset, targetContext, view?.tasks ?? [])
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The retried upload finalized in a different speaker context.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) return false;
        workspaceDispatch({ type: "asset-replaced", asset });
        return true;
      } catch (retryError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(retryError) });
        }
        return false;
      } finally {
        asyncDispatch({ type: "asset-busy-set", assetId: input.assetId, busy: false });
      }
    },
    [api, can, context, view, workspace.assets],
  );

  const completeAssetUpload = useCallback(
    async (input: { assetId: string }) => {
      if (!context) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "No authorized portal context is available.",
        });
        return false;
      }
      if (!can("asset-write") || !api.finalizeAsset) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to complete this upload.",
        });
        return false;
      }
      const targetContext = context;
      const knownAsset =
        workspace.assets.find((candidate) => candidate.id === input.assetId) ??
        view?.assets?.find((candidate) => candidate.id === input.assetId);
      if (
        knownAsset === undefined ||
        knownAsset.state !== "pending_upload" ||
        !assetBelongsToPortalContext(knownAsset, context, view?.tasks ?? [])
      ) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This upload is no longer pending or does not belong to the active speaker.",
        });
        return false;
      }
      const generation = loadGeneration.current;
      asyncDispatch({ type: "asset-busy-set", assetId: input.assetId, busy: true });
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        const asset = await api.finalizeAsset({
          eventId: targetContext.eventId,
          assetId: input.assetId,
          state: "ready",
        });
        if (
          !assetMatchesPendingRetry(asset, knownAsset, {
            eventId: targetContext.eventId,
            participantId: knownAsset.participantId,
            sessionId: knownAsset.sessionId,
            taskId: knownAsset.taskId,
            kind: knownAsset.kind,
            state: "ready",
          }) ||
          !assetBelongsToPortalContext(asset, targetContext, view?.tasks ?? [])
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The completed upload belongs to a different speaker or session.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return false;
        }
        workspaceDispatch({ type: "asset-replaced", asset });
        return true;
      } catch (completeError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(completeError) });
        }
        return false;
      } finally {
        asyncDispatch({ type: "asset-busy-set", assetId: input.assetId, busy: false });
      }
    },
    [api, can, context, view, workspace.assets],
  );

  const loadAssetHistory = useCallback(
    async (assetId: string) => {
      if (!api?.getAssetHistory || !context || !can("asset-read")) {
        return [];
      }
      const targetContext = context;
      if (!assetIdAuthorized(assetId, context, view, workspace.assets)) {
        return [];
      }
      const generation = loadGeneration.current;
      try {
        const history = await api.getAssetHistory(targetContext.eventId, assetId);
        if (
          history.some(
            (entry) => !assetBelongsToPortalContext(entry, targetContext, view?.tasks ?? []),
          )
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The file history belongs to a different speaker or session.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return [];
        }
        workspaceDispatch({ type: "asset-history-set", assetId, history });
        return history;
      } catch (historyError) {
        if (
          !isOptionalWorkspaceSubreadFailure(historyError) &&
          isPortalGenerationCurrent(generation, loadGeneration.current)
        ) {
          workspaceDispatch({ type: "error-set", error: messageFrom(historyError) });
        }
        return [];
      }
    },
    [api, can, context, view, workspace.assets],
  );

  const loadAssetComments = useCallback(
    async (assetId: string) => {
      if (!api?.listAssetComments || !context || !can("asset-read")) {
        return [];
      }
      const targetContext = context;
      if (!assetIdAuthorized(assetId, context, view, workspace.assets)) {
        return [];
      }
      const generation = loadGeneration.current;
      const previous = assetCommentRequestsRef.current.get(assetId);
      previous?.controller.abort();
      const request = {
        token: (previous?.token ?? 0) + 1,
        controller: new AbortController(),
      };
      assetCommentRequestsRef.current.set(assetId, request);
      try {
        const comments = await api.listAssetComments(
          targetContext.eventId,
          assetId,
          request.controller.signal,
        );
        if (
          comments.some(
            (comment) =>
              !assetFamilyCommentResponseAuthorized(
                assetId,
                comment.assetId,
                comment.versionId ?? "",
                targetContext,
                view,
                workspace.assets,
              ),
          )
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The file comments belong to a different file family.",
            409,
          );
        }
        if (
          !isPortalGenerationCurrent(generation, loadGeneration.current) ||
          assetCommentRequestsRef.current.get(assetId)?.token !== request.token
        ) {
          return [];
        }
        workspaceDispatch({ type: "asset-comments-set", assetId, comments });
        return comments;
      } catch (commentsError) {
        if (
          !isAbort(commentsError) &&
          !isOptionalWorkspaceSubreadFailure(commentsError) &&
          isPortalGenerationCurrent(generation, loadGeneration.current) &&
          assetCommentRequestsRef.current.get(assetId)?.token === request.token
        ) {
          workspaceDispatch({ type: "error-set", error: messageFrom(commentsError) });
        }
        return [];
      } finally {
        if (assetCommentRequestsRef.current.get(assetId)?.token === request.token) {
          assetCommentRequestsRef.current.delete(assetId);
        }
      }
    },
    [api, can, context, view, workspace.assets],
  );

  const addAssetComment = useCallback(
    async (input: { assetId: string; body: string; expectedVersion?: number }) => {
      if (!api?.addAssetComment || !context) {
        asyncDispatch({ type: "mutation-error-set", error: "Comments are not available yet." });
        return false;
      }
      if (!can("asset-comment")) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to comment on files.",
        });
        return false;
      }
      const targetContext = context;
      if (!assetIdAuthorized(input.assetId, context, view, workspace.assets)) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This file does not belong to the active speaker.",
        });
        return false;
      }
      const generation = loadGeneration.current;
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        const comment = await api.addAssetComment({ eventId: targetContext.eventId, ...input });
        const selectedAsset =
          workspace.assets.find((asset) => asset.id === input.assetId) ??
          view?.assets?.find((asset) => asset.id === input.assetId);
        const commentVersionId = comment.versionId;
        if (
          selectedAsset === undefined ||
          comment.assetId !== input.assetId ||
          commentVersionId === undefined ||
          commentVersionId !== (selectedAsset.versionId ?? selectedAsset.id) ||
          !assetFamilyCommentResponseAuthorized(
            input.assetId,
            comment.assetId,
            commentVersionId,
            targetContext,
            view,
            workspace.assets,
          )
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The file comment belongs to a different file.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return false;
        }
        workspaceDispatch({ type: "asset-comment-added", comment });
        return true;
      } catch (commentError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(commentError) });
        }
        return false;
      }
    },
    [api, can, context, view, workspace.assets],
  );

  const downloadAsset = useCallback(
    async (assetId: string): Promise<PortalDownloadGrant | null> => {
      if (!api?.getDownloadGrant || !context) {
        asyncDispatch({ type: "mutation-error-set", error: "Downloads are not available yet." });
        return null;
      }
      if (!can("asset-read")) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to download this file.",
        });
        return null;
      }
      const targetContext = context;
      if (!assetIdAuthorized(assetId, context, view, workspace.assets)) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This file does not belong to the active speaker.",
        });
        return null;
      }
      const generation = loadGeneration.current;
      try {
        const grant = await api.getDownloadGrant(targetContext.eventId, assetId);
        return isPortalGenerationCurrent(generation, loadGeneration.current) ? grant : null;
      } catch (downloadError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({
            type: "mutation-error-set",
            error:
              downloadError instanceof PortalApiError && downloadError.status === 410
                ? "This secure download link has expired. Request a new download."
                : messageFrom(downloadError),
          });
        }
        return null;
      }
    },
    [api, can, context, view, workspace.assets],
  );

  const loadTaskForm = useCallback(
    async (taskId: string): Promise<PortalTaskForm | null> => {
      if (!api?.getTaskForm || !context || !can("task-response")) {
        return null;
      }
      const targetContext = context;
      if (!taskIdAuthorized(taskId, context, view)) {
        return null;
      }
      const generation = loadGeneration.current;
      try {
        const form = await api.getTaskForm({ eventId: targetContext.eventId, taskId });
        if (form.taskId !== taskId) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The task form belongs to a different task.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return null;
        }
        workspaceDispatch({ type: "task-form-set", taskId, form });
        return form;
      } catch (formError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          workspaceDispatch({ type: "error-set", error: messageFrom(formError) });
        }
        return null;
      }
    },
    [api, can, context, view],
  );

  const loadTaskResponse = useCallback(
    async (taskId: string): Promise<PortalTaskResponseEnvelope | null> => {
      if (!api?.getTaskResponse || !context || !can("task-response")) {
        return null;
      }
      const targetContext = context;
      if (!taskIdAuthorized(taskId, context, view)) {
        return null;
      }
      const generation = loadGeneration.current;
      try {
        const response = await api.getTaskResponse({ eventId: targetContext.eventId, taskId });
        if (
          response.eventId !== targetContext.eventId ||
          response.taskId !== taskId ||
          response.participantId !== targetContext.primaryParticipantId
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The task response belongs to a different event or task.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return null;
        }
        workspaceDispatch({ type: "task-response-set", taskId, response });
        return response;
      } catch (responseError) {
        if (responseError instanceof PortalApiError && responseError.status === 404) {
          return null;
        }
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          workspaceDispatch({ type: "error-set", error: messageFrom(responseError) });
        }
        return null;
      }
    },
    [api, can, context, view],
  );

  const saveTaskResponse = useCallback(
    async (input: {
      taskId: string;
      definitionVersion: number;
      answers: Readonly<Record<string, PortalFormAnswer>>;
      expectedVersion: number;
    }) => {
      if (!api?.saveTaskResponse || !context) {
        asyncDispatch({ type: "mutation-error-set", error: "Task forms are not available yet." });
        return false;
      }
      if (!can("task-response")) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "You do not have permission to submit this form.",
        });
        return false;
      }
      const targetContext = context;
      if (!taskIdAuthorized(input.taskId, context, view)) {
        asyncDispatch({
          type: "mutation-error-set",
          error: "This task does not belong to the active speaker.",
        });
        return false;
      }
      const generation = loadGeneration.current;
      asyncDispatch({ type: "task-busy-set", taskId: input.taskId, busy: true });
      asyncDispatch({ type: "mutation-error-set", error: null });
      try {
        const response = await api.saveTaskResponse({ eventId: targetContext.eventId, ...input });
        if (
          response.eventId !== targetContext.eventId ||
          response.taskId !== input.taskId ||
          response.participantId !== targetContext.primaryParticipantId
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The task response belongs to a different event or task.",
            409,
          );
        }
        if (!isPortalGenerationCurrent(generation, loadGeneration.current)) {
          return false;
        }
        workspaceDispatch({ type: "task-response-set", taskId: input.taskId, response });
        return true;
      } catch (responseError) {
        if (isPortalGenerationCurrent(generation, loadGeneration.current)) {
          asyncDispatch({ type: "mutation-error-set", error: messageFrom(responseError) });
        }
        return false;
      } finally {
        asyncDispatch({ type: "task-busy-set", taskId: input.taskId, busy: false });
      }
    },
    [api, can, context, view],
  );

  const value = useMemo<PortalContextValue>(
    () => ({
      eventId,
      eventQuery,
      contexts,
      context,
      authorizedParticipantIds,
      selectedParticipantId,
      capabilities,
      can,
      switchContext,
      view,
      workspace,
      workspaceGuideErrors,
      workspaceLoading,
      workspaceError,
      loading,
      error,
      mutationError,
      busyTaskIds,
      busyAssetIds,
      busyRoster,
      savingProfile,
      profileMutationState,
      profileRevision,
      switchParticipant,
      reload,
      loadWorkspace,
      saveProfile,
      transitionTask,
      uploadTask,
      addRosterEntry,
      updateRosterEntry,
      removeRosterEntry,
      uploadWorkspaceFile,
      retryAssetUpload,
      completeAssetUpload,
      loadAssetHistory,
      loadAssetComments,
      addAssetComment,
      downloadAsset,
      loadTaskForm,
      loadTaskResponse,
      saveTaskResponse,
      clearMutationError,
      clearWorkspaceError,
    }),
    [
      addAssetComment,
      addRosterEntry,
      busyAssetIds,
      busyRoster,
      busyTaskIds,
      can,
      capabilities,
      context,
      contexts,
      authorizedParticipantIds,
      selectedParticipantId,
      error,
      eventId,
      eventQuery,
      downloadAsset,
      completeAssetUpload,
      loadAssetComments,
      loadAssetHistory,
      loadTaskForm,
      loadTaskResponse,
      loadWorkspace,
      loading,
      mutationError,
      reload,
      retryAssetUpload,
      removeRosterEntry,
      saveProfile,
      profileMutationState,
      profileRevision,
      savingProfile,
      saveTaskResponse,
      clearMutationError,
      clearWorkspaceError,
      switchContext,
      switchParticipant,
      transitionTask,
      updateRosterEntry,
      uploadTask,
      uploadWorkspaceFile,
      view,
      workspace,
      workspaceGuideErrors,
      workspaceError,
      workspaceLoading,
    ],
  );

  return value;
}

export function PortalProvider({ children, api, apiBaseUrl }: Readonly<PortalProviderProps>) {
  const value = usePortalProviderValue({ api, apiBaseUrl });
  return (
    <PortalProviderBoundary
      render={(runtimeChildren) => (
        <PortalContextValueProvider.Provider value={value}>
          {runtimeChildren}
        </PortalContextValueProvider.Provider>
      )}
    >
      {children}
    </PortalProviderBoundary>
  );
}

export function usePortal(): PortalContextValue {
  const context = useContext(PortalContextValueProvider);
  if (!context) {
    throw new Error("usePortal must be used inside PortalProvider.");
  }
  return context;
}
