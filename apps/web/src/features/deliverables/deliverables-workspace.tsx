"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { useOrganizerEventId } from "@/features/admin/organizer-event-workspace";
import type { SpeakerEventTemporalContext } from "@/features/speakers/speaker-temporal-policy";
import { useNavigationDataCache } from "@/lib/navigation-data-cache-provider";
import {
  createDeliverablesApi,
  type DeliverableAsset,
  type DeliverableAssetHistoryEntry,
  type DeliverableComment,
  type DeliverableContentHistoryEntry,
  type DeliverableDownloadGrant,
  type DeliverableExportDownload,
  type DeliverableExportInput,
  type DeliverableMatrixItem,
  type DeliverableReviewInput,
  type DeliverableSession,
  type DeliverableSpeakerContentHistoryEntry,
  type DeliverableSpeakerContentRecord,
  type DeliverableSpeakerProfile,
  type DeliverablesApi,
  DeliverablesApiError,
  type DeliverableTask,
  type DeliverableTaskInput,
  type DeliverableTaskMatrix,
} from "./api";
import {
  authorizeContentCollectionNavigationSnapshot,
  type DeliverableSpeakerContentHistoryState,
  type DeliverablesSessionHistoryCache,
  type DeliverablesSnapshot,
  type DeliverablesWorkspaceMode,
  type DeliverablesWorkspaceScope,
  deliverablesCoreCacheInvalidationTags,
  deliverablesCoreCacheKey,
  deliverablesCoreCacheTags,
  deliverablesSessionHistoryKey,
  eligibleSpeakerHeadshotSessions,
  isDeliverablesWorkspaceScopeCurrent,
  loadDeliverablesCoreSnapshot,
  loadDeliverablesSessionHistory,
  settleDeliverablesRequest,
  startDeliverablesCoreRequests,
  startDeliverablesRequest,
} from "./deliverables-workspace-model";
import { DeliverablesTemporalContextProvider } from "./deliverables-workspace-sections";
import {
  DeliverablesWorkspaceView,
  type DeliverablesWorkspaceViewProps,
} from "./deliverables-workspace-views";

export {
  ContentRequestInspector,
  DeliverablesSummary,
  DeliverablesTemporalContextProvider,
  ReminderPreview,
} from "./deliverables-workspace-sections";
export { DeliverablesWorkspaceView } from "./deliverables-workspace-views";

type DeliverablesOperationKey =
  | "task-create"
  | "asset-comment"
  | "asset-download"
  | "asset-review"
  | "reminder-send"
  | "biography-save"
  | "speaker-content-restore"
  | "headshot-replace"
  | "files-export";
type DeliverablesOperationPhase = "pending" | "succeeded" | "failed";
interface DeliverablesOperationState {
  readonly key: DeliverablesOperationKey;
  readonly label: string;
  readonly phase: DeliverablesOperationPhase;
  readonly message: string;
}

interface DeliverablesWorkspaceProps {
  readonly eventId: string;
  readonly organizationId: string;
  readonly mode?: DeliverablesWorkspaceMode;
  readonly api?: DeliverablesApi;
  readonly initialData?: DeliverablesSnapshot;
}

function formatStatus(status: string): string {
  return status.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function compareSpeakerContentHistoryEntries(
  left: DeliverableSpeakerContentHistoryEntry,
  right: DeliverableSpeakerContentHistoryEntry,
): number {
  return (
    left.version - right.version ||
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.id.localeCompare(right.id)
  );
}

function sortedSpeakerContentHistory(
  entries: readonly DeliverableSpeakerContentHistoryEntry[],
): readonly DeliverableSpeakerContentHistoryEntry[] {
  return [...entries].sort(compareSpeakerContentHistoryEntries);
}

function speakerContentHistoryLoading(): DeliverableSpeakerContentHistoryState {
  return { status: "loading", entries: [] };
}

function speakerContentHistoryEmpty(): DeliverableSpeakerContentHistoryState {
  return { status: "empty", entries: [] };
}

function speakerContentHistorySuccess(
  entries: readonly DeliverableSpeakerContentHistoryEntry[],
): DeliverableSpeakerContentHistoryState {
  const sorted = sortedSpeakerContentHistory(entries);
  return sorted.length === 0
    ? speakerContentHistoryEmpty()
    : { status: "success", entries: sorted };
}

function speakerContentHistoryError(reason: unknown): DeliverableSpeakerContentHistoryState {
  return {
    status: "error",
    entries: [],
    error: messageFromError(reason),
  };
}
function speakerContentHistoryStatesForProfiles(
  profiles: readonly DeliverableSpeakerProfile[],
  provided: Readonly<Record<string, DeliverableSpeakerContentHistoryState>> | undefined,
): Readonly<Record<string, DeliverableSpeakerContentHistoryState>> {
  return Object.fromEntries(
    profiles.map((profile) => [
      profile.participantId,
      provided?.[profile.participantId] ?? speakerContentHistoryEmpty(),
    ]),
  );
}
function profileWithSpeakerContentRecord(
  profile: DeliverableSpeakerProfile,
  content: DeliverableSpeakerContentRecord,
): DeliverableSpeakerProfile {
  const {
    socialLinks: _socialLinks,
    social: _social,
    status: _status,
    headshotAssetId: _headshotAssetId,
    ...profileWithoutContent
  } = profile;
  return {
    ...profileWithoutContent,
    biography: content.biography ?? "",
    ...(content.socialLinks === undefined ? {} : { socialLinks: content.socialLinks }),
    ...(content.status === undefined ? {} : { status: content.status }),
    ...(content.headshotAssetId === undefined || content.headshotAssetId === null
      ? {}
      : { headshotAssetId: content.headshotAssetId }),
    version: content.version,
    updatedAt: content.updatedAt,
  };
}

function messageFromError(error: unknown): string {
  if (error instanceof DeliverablesApiError) {
    if (error.status === 401 || error.status === 403) return `Access denied: ${error.message}`;
    if (error.status === 409 || error.code === "CONFLICT" || error.code === "VERSION_CONFLICT")
      return `This content changed elsewhere. Reload before trying again. ${error.message}`;
    if (error.status === 404) return `Deliverables resource not found: ${error.message}`;
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : "The deliverables request could not be completed.";
}

function safeDownloadUrl(value: string): string | null {
  try {
    const parsed = new URL(
      value,
      typeof window === "undefined" ? "https://invalid.local" : window.location.origin,
    );
    const browserAllowsHttp = typeof window !== "undefined" && window.location.protocol === "http:";
    return parsed.protocol === "https:" || (browserAllowsHttp && parsed.protocol === "http:")
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function matrixAssetsFromItems(
  items: readonly DeliverableMatrixItem[],
): readonly DeliverableAsset[] {
  const byId = new Map<string, DeliverableAsset>();
  for (const item of items) {
    for (const asset of item.assets) byId.set(asset.id, asset);
    if (item.currentAsset !== undefined) byId.set(item.currentAsset.id, item.currentAsset);
  }
  return [...byId.values()];
}

function matrixAssets(matrixValue: DeliverableTaskMatrix): readonly DeliverableAsset[] {
  return matrixAssetsFromItems(matrixValue.items);
}
function deliverablesCapabilityMessages(
  api: DeliverablesApi,
  mode: DeliverablesWorkspaceMode,
): readonly string[] {
  const messages: string[] = [];
  if (mode === "deliverables") {
    if (api.replaceHeadshot === undefined)
      messages.push(
        "Organizer headshot replacement is unavailable until the private staged-upload endpoint is provisioned.",
      );
    if (api.createTask === undefined)
      messages.push(
        "Create file-request task is unavailable until an organizer task-management endpoint is provisioned.",
      );
    if (api.listSpeakerContentHistory === undefined)
      messages.push(
        "Speaker content history is unavailable until the organizer content history endpoint is provisioned.",
      );
    if (api.sendBulkReminder === undefined)
      messages.push(
        "Bulk reminder sending is unavailable until a transactional reminder endpoint is provisioned.",
      );
    if (api.restoreSessionVersion === undefined)
      messages.push(
        "Session content restore is unavailable until the version restore endpoint is provisioned.",
      );
  }
  if (api.reviewAsset === undefined)
    messages.push(
      "Asset approval and needs-changes decisions are unavailable until organizer asset review is provisioned.",
    );
  if (api.exportDeliverables === undefined)
    messages.push(
      `${mode === "files" ? "Files" : "Deliverables"} ZIP export is unavailable until the organizer export capability is provisioned.`,
    );
  return messages;
}

function canLoadDeliverablesCoreSnapshot(
  api: DeliverablesApi,
  mode: DeliverablesWorkspaceMode,
): boolean {
  if (api.listProfiles === undefined) return false;
  if (api.listDeliverableMatrix !== undefined) {
    return mode !== "files" || api.listAssets !== undefined;
  }
  return api.listTasks !== undefined && api.listAssets !== undefined;
}

type DeliverablesWorkspaceState = {
  readonly sessions: readonly DeliverableSession[];
  readonly tasks: readonly DeliverableTask[];
  readonly assets: readonly DeliverableAsset[];
  readonly profiles: readonly DeliverableSpeakerProfile[];
  readonly speakerContentHistory: Readonly<Record<string, DeliverableSpeakerContentHistoryState>>;
  readonly matrix: DeliverableTaskMatrix | undefined;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly statusMessage: string | null;
  readonly capabilityMessages: readonly string[];
  readonly selectedAssetId: string | null;
  readonly selectedSessionId: string | null;
  readonly sessionHistory: readonly DeliverableContentHistoryEntry[] | undefined;
  readonly sessionHistoryError: string | null;
  readonly sessionHistoryKey: string | null;
  readonly assetHistory: readonly DeliverableAssetHistoryEntry[];
  readonly comments: readonly DeliverableComment[];
  readonly loadingAssetDetails: boolean;
  readonly assetHistoryError: string | null;
  readonly commentsError: string | null;
  readonly loadingSessionHistories: boolean;
  readonly operationStates: Partial<Record<DeliverablesOperationKey, DeliverablesOperationState>>;
};

type DeliverablesWorkspaceStateValue<T> = T | ((current: T) => T);

type DeliverablesWorkspaceAction =
  | {
      readonly type: "reset-scope";
      readonly value: DeliverablesWorkspaceState;
    }
  | {
      readonly type: "sessions";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["sessions"]>;
    }
  | {
      readonly type: "tasks";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["tasks"]>;
    }
  | {
      readonly type: "assets";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["assets"]>;
    }
  | {
      readonly type: "profiles";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["profiles"]>;
    }
  | {
      readonly type: "speaker-content-history";
      readonly value: DeliverablesWorkspaceStateValue<
        DeliverablesWorkspaceState["speakerContentHistory"]
      >;
    }
  | {
      readonly type: "matrix";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["matrix"]>;
    }
  | {
      readonly type: "loading";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["loading"]>;
    }
  | {
      readonly type: "busy";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["busy"]>;
    }
  | {
      readonly type: "error";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["error"]>;
    }
  | {
      readonly type: "status-message";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["statusMessage"]>;
    }
  | {
      readonly type: "capability-messages";
      readonly value: DeliverablesWorkspaceStateValue<
        DeliverablesWorkspaceState["capabilityMessages"]
      >;
    }
  | {
      readonly type: "selected-asset-id";
      readonly value: DeliverablesWorkspaceStateValue<
        DeliverablesWorkspaceState["selectedAssetId"]
      >;
    }
  | {
      readonly type: "selected-session-id";
      readonly value: DeliverablesWorkspaceStateValue<
        DeliverablesWorkspaceState["selectedSessionId"]
      >;
    }
  | {
      readonly type: "session-history";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["sessionHistory"]>;
    }
  | {
      readonly type: "session-history-error";
      readonly value: DeliverablesWorkspaceStateValue<
        DeliverablesWorkspaceState["sessionHistoryError"]
      >;
    }
  | {
      readonly type: "session-history-key";
      readonly value: DeliverablesWorkspaceStateValue<
        DeliverablesWorkspaceState["sessionHistoryKey"]
      >;
    }
  | {
      readonly type: "asset-history";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["assetHistory"]>;
    }
  | {
      readonly type: "comments";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["comments"]>;
    }
  | {
      readonly type: "loading-asset-details";
      readonly value: DeliverablesWorkspaceStateValue<
        DeliverablesWorkspaceState["loadingAssetDetails"]
      >;
    }
  | {
      readonly type: "asset-history-error";
      readonly value: DeliverablesWorkspaceStateValue<
        DeliverablesWorkspaceState["assetHistoryError"]
      >;
    }
  | {
      readonly type: "comments-error";
      readonly value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["commentsError"]>;
    }
  | {
      readonly type: "loading-session-histories";
      readonly value: DeliverablesWorkspaceStateValue<
        DeliverablesWorkspaceState["loadingSessionHistories"]
      >;
    }
  | {
      readonly type: "operation-states";
      readonly value: DeliverablesWorkspaceStateValue<
        DeliverablesWorkspaceState["operationStates"]
      >;
    };

function resolveDeliverablesWorkspaceStateValue<T>(
  current: T,
  next: DeliverablesWorkspaceStateValue<T>,
): T {
  return typeof next === "function" ? (next as (current: T) => T)(current) : next;
}

function deliverablesWorkspaceReducer(
  state: DeliverablesWorkspaceState,
  action: DeliverablesWorkspaceAction,
): DeliverablesWorkspaceState {
  switch (action.type) {
    case "reset-scope":
      return action.value;
    case "sessions":
      return {
        ...state,
        sessions: resolveDeliverablesWorkspaceStateValue(state.sessions, action.value),
      };
    case "tasks":
      return {
        ...state,
        tasks: resolveDeliverablesWorkspaceStateValue(state.tasks, action.value),
      };
    case "assets":
      return {
        ...state,
        assets: resolveDeliverablesWorkspaceStateValue(state.assets, action.value),
      };
    case "profiles":
      return {
        ...state,
        profiles: resolveDeliverablesWorkspaceStateValue(state.profiles, action.value),
      };
    case "speaker-content-history":
      return {
        ...state,
        speakerContentHistory: resolveDeliverablesWorkspaceStateValue(
          state.speakerContentHistory,
          action.value,
        ),
      };
    case "matrix":
      return {
        ...state,
        matrix: resolveDeliverablesWorkspaceStateValue(state.matrix, action.value),
      };
    case "loading":
      return {
        ...state,
        loading: resolveDeliverablesWorkspaceStateValue(state.loading, action.value),
      };
    case "busy":
      return {
        ...state,
        busy: resolveDeliverablesWorkspaceStateValue(state.busy, action.value),
      };
    case "error":
      return {
        ...state,
        error: resolveDeliverablesWorkspaceStateValue(state.error, action.value),
      };
    case "status-message":
      return {
        ...state,
        statusMessage: resolveDeliverablesWorkspaceStateValue(state.statusMessage, action.value),
      };
    case "capability-messages":
      return {
        ...state,
        capabilityMessages: resolveDeliverablesWorkspaceStateValue(
          state.capabilityMessages,
          action.value,
        ),
      };
    case "selected-asset-id":
      return {
        ...state,
        selectedAssetId: resolveDeliverablesWorkspaceStateValue(
          state.selectedAssetId,
          action.value,
        ),
      };
    case "selected-session-id":
      return {
        ...state,
        selectedSessionId: resolveDeliverablesWorkspaceStateValue(
          state.selectedSessionId,
          action.value,
        ),
      };
    case "session-history":
      return {
        ...state,
        sessionHistory: resolveDeliverablesWorkspaceStateValue(state.sessionHistory, action.value),
      };
    case "session-history-error":
      return {
        ...state,
        sessionHistoryError: resolveDeliverablesWorkspaceStateValue(
          state.sessionHistoryError,
          action.value,
        ),
      };
    case "session-history-key":
      return {
        ...state,
        sessionHistoryKey: resolveDeliverablesWorkspaceStateValue(
          state.sessionHistoryKey,
          action.value,
        ),
      };
    case "asset-history":
      return {
        ...state,
        assetHistory: resolveDeliverablesWorkspaceStateValue(state.assetHistory, action.value),
      };
    case "comments":
      return {
        ...state,
        comments: resolveDeliverablesWorkspaceStateValue(state.comments, action.value),
      };
    case "loading-asset-details":
      return {
        ...state,
        loadingAssetDetails: resolveDeliverablesWorkspaceStateValue(
          state.loadingAssetDetails,
          action.value,
        ),
      };
    case "asset-history-error":
      return {
        ...state,
        assetHistoryError: resolveDeliverablesWorkspaceStateValue(
          state.assetHistoryError,
          action.value,
        ),
      };
    case "comments-error":
      return {
        ...state,
        commentsError: resolveDeliverablesWorkspaceStateValue(state.commentsError, action.value),
      };
    case "loading-session-histories":
      return {
        ...state,
        loadingSessionHistories: resolveDeliverablesWorkspaceStateValue(
          state.loadingSessionHistories,
          action.value,
        ),
      };
    case "operation-states":
      return {
        ...state,
        operationStates: resolveDeliverablesWorkspaceStateValue(
          state.operationStates,
          action.value,
        ),
      };
  }
  return state;
}

function initialDeliverablesWorkspaceState(
  seededCoreData: DeliverablesSnapshot | undefined,
  speakerContentHistory:
    | Readonly<Record<string, DeliverableSpeakerContentHistoryState>>
    | undefined,
  cachedCoreData: DeliverablesSnapshot | undefined,
  api: DeliverablesApi,
  mode: DeliverablesWorkspaceMode,
): DeliverablesWorkspaceState {
  const profiles = seededCoreData?.profiles ?? [];
  return {
    sessions: seededCoreData?.sessions ?? [],
    tasks: seededCoreData?.tasks ?? [],
    assets: seededCoreData?.assets ?? [],
    profiles,
    speakerContentHistory: speakerContentHistoryStatesForProfiles(profiles, speakerContentHistory),
    matrix: seededCoreData?.matrix,
    loading: seededCoreData === undefined,
    busy: false,
    error: null,
    statusMessage: null,
    capabilityMessages:
      cachedCoreData === undefined ? [] : deliverablesCapabilityMessages(api, mode),
    selectedAssetId: null,
    selectedSessionId: seededCoreData?.sessions[0]?.id ?? null,
    sessionHistory: undefined,
    sessionHistoryError: null,
    sessionHistoryKey: null,
    assetHistory: [],
    comments: [],
    loadingAssetDetails: false,
    assetHistoryError: null,
    commentsError: null,
    loadingSessionHistories: false,
    operationStates: {},
  };
}
type DeliverablesControllerViewProps = DeliverablesWorkspaceViewProps & {
  readonly temporalContext?: SpeakerEventTemporalContext;
};

function useDeliverablesWorkspaceController({
  eventId: fallbackEventId,
  organizationId,
  mode = "deliverables",
  api: providedApi,
  initialData,
}: DeliverablesWorkspaceProps): DeliverablesControllerViewProps {
  const eventId = useOrganizerEventId(fallbackEventId);
  const api = useMemo(
    () => providedApi ?? createDeliverablesApi("", organizationId, eventId),
    [eventId, organizationId, providedApi],
  );
  const navigationDataCache = useNavigationDataCache();
  const coreCacheKey = useMemo(
    () => deliverablesCoreCacheKey(organizationId, eventId, mode),
    [eventId, mode, organizationId],
  );
  const coreCacheTags = useMemo(
    () => deliverablesCoreCacheTags(organizationId, eventId, mode),
    [eventId, mode, organizationId],
  );
  const cachedCoreDataAtRender =
    initialData === undefined
      ? navigationDataCache?.peek<DeliverablesSnapshot>(coreCacheKey)
      : undefined;
  const cachedCoreDataRef = useRef<{
    readonly key: string;
    readonly data: DeliverablesSnapshot | undefined;
  }>({ key: coreCacheKey, data: cachedCoreDataAtRender });
  const cachedCoreData =
    cachedCoreDataRef.current.key === coreCacheKey
      ? cachedCoreDataRef.current.data
      : cachedCoreDataAtRender;
  useLayoutEffect(() => {
    if (cachedCoreDataRef.current.key !== coreCacheKey) {
      cachedCoreDataRef.current = { key: coreCacheKey, data: cachedCoreDataAtRender };
    }
  }, [cachedCoreDataAtRender, coreCacheKey]);
  const seededCoreData = initialData;
  const scopeRef = useRef<DeliverablesWorkspaceScope>({
    api,
    eventId,
    organizationId,
    mode,
    epoch: 0,
  });
  const currentScope = useMemo<DeliverablesWorkspaceScope>(() => {
    const previousScope = scopeRef.current;
    if (
      previousScope.api === api &&
      previousScope.eventId === eventId &&
      previousScope.organizationId === organizationId &&
      previousScope.mode === mode
    ) {
      return previousScope;
    }
    return {
      api,
      eventId,
      organizationId,
      mode,
      epoch: previousScope.epoch + 1,
    };
  }, [api, eventId, mode, organizationId]);
  useLayoutEffect(() => {
    scopeRef.current = currentScope;
  }, [currentScope]);
  const [workspaceState, dispatch] = useReducer(
    deliverablesWorkspaceReducer,
    initialDeliverablesWorkspaceState(
      seededCoreData,
      initialData?.speakerContentHistory,
      cachedCoreData,
      api,
      mode,
    ),
  );
  const {
    sessions,
    tasks,
    assets,
    profiles,
    speakerContentHistory,
    matrix,
    loading,
    busy,
    error,
    statusMessage,
    capabilityMessages,
    selectedAssetId,
    selectedSessionId,
    sessionHistory,
    sessionHistoryError,
    sessionHistoryKey,
    assetHistory,
    comments,
    loadingAssetDetails,
    assetHistoryError,
    commentsError,
    loadingSessionHistories,
    operationStates,
  } = workspaceState;
  const setSessions = (
    value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["sessions"]>,
  ) => dispatch({ type: "sessions", value });
  const setTasks = (value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["tasks"]>) =>
    dispatch({ type: "tasks", value });
  const setAssets = (
    value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["assets"]>,
  ) => dispatch({ type: "assets", value });
  const setProfiles = (
    value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["profiles"]>,
  ) => dispatch({ type: "profiles", value });
  const setMatrix = (
    value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["matrix"]>,
  ) => dispatch({ type: "matrix", value });
  const setBusy = (value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["busy"]>) =>
    dispatch({ type: "busy", value });
  const setError = (value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["error"]>) =>
    dispatch({ type: "error", value });
  const setStatusMessage = (
    value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["statusMessage"]>,
  ) => dispatch({ type: "status-message", value });
  const setSelectedAssetId = (
    value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["selectedAssetId"]>,
  ) => dispatch({ type: "selected-asset-id", value });
  const setSelectedSessionId = useCallback(
    (value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["selectedSessionId"]>) =>
      dispatch({ type: "selected-session-id", value }),
    [],
  );
  const setOperationStates = (
    value: DeliverablesWorkspaceStateValue<DeliverablesWorkspaceState["operationStates"]>,
  ) => dispatch({ type: "operation-states", value });
  const sessionHistoryCacheRef = useRef<DeliverablesSessionHistoryCache>(new Map());
  const selectedAssetIdRef = useRef<string | null>(selectedAssetId);
  useLayoutEffect(() => {
    selectedAssetIdRef.current = selectedAssetId;
  }, [selectedAssetId]);
  const busyLeaseRef = useRef(0);
  const sessionHistoryLeaseRef = useRef(0);
  const assetDetailsLeaseRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const stateScopeRef = useRef(currentScope);
  function beginBusy(): number {
    const lease = busyLeaseRef.current + 1;
    busyLeaseRef.current = lease;
    setBusy(true);
    return lease;
  }
  useEffect(() => {
    if (isDeliverablesWorkspaceScopeCurrent(stateScopeRef.current, currentScope)) return;
    stateScopeRef.current = currentScope;
    busyLeaseRef.current += 1;
    sessionHistoryLeaseRef.current += 1;
    assetDetailsLeaseRef.current += 1;
    loadGenerationRef.current += 1;
    sessionHistoryCacheRef.current.clear();
    dispatch({
      type: "reset-scope",
      value: {
        ...initialDeliverablesWorkspaceState(
          seededCoreData,
          initialData?.speakerContentHistory,
          cachedCoreData,
          api,
          mode,
        ),
        selectedSessionId: null,
      },
    });
  }, [api, cachedCoreData, currentScope, initialData, mode, seededCoreData]);

  function recordOperation(
    key: DeliverablesOperationKey,
    label: string,
    phase: DeliverablesOperationPhase,
    message: string,
  ): void {
    setOperationStates((current) => ({
      ...current,
      [key]: { key, label, phase, message },
    }));
  }

  const refreshSpeakerContentHistory = useCallback(
    async (participantId: string, signal?: AbortSignal): Promise<void> => {
      const scope = scopeRef.current;
      const isCurrent = (): boolean =>
        !signal?.aborted && isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current);
      if (!isCurrent()) return;
      dispatch({
        type: "speaker-content-history",
        value: (current) => ({
          ...current,
          [participantId]: speakerContentHistoryLoading(),
        }),
      });
      const listSpeakerContentHistory = api?.listSpeakerContentHistory;
      if (listSpeakerContentHistory === undefined) {
        if (!isCurrent()) return;
        dispatch({
          type: "speaker-content-history",
          value: (current) => ({
            ...current,
            [participantId]: speakerContentHistoryError(
              new Error("The speaker content history endpoint is not provisioned."),
            ),
          }),
        });
        return;
      }
      try {
        const entries = await listSpeakerContentHistory(participantId, signal);
        if (!isCurrent()) return;
        dispatch({
          type: "speaker-content-history",
          value: (current) => ({
            ...current,
            [participantId]: speakerContentHistorySuccess(entries),
          }),
        });
      } catch (reason) {
        if (!isCurrent()) return;
        dispatch({
          type: "speaker-content-history",
          value: (current) => ({
            ...current,
            [participantId]: speakerContentHistoryError(reason),
          }),
        });
      }
    },
    [api],
  );

  async function refreshMatrix(scope: DeliverablesWorkspaceScope = currentScope): Promise<boolean> {
    if (api.listDeliverableMatrix === undefined) return true;
    try {
      const next = await api.listDeliverableMatrix();
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return false;
      invalidateDeliverablesCoreCache(scope);
      setMatrix(next);
      setTasks(next.items.map((item) => item.task));
      if (mode === "deliverables") setAssets(matrixAssets(next));
      return true;
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return false;
      setError(
        `The operation succeeded, but the exact deliverables matrix could not be refreshed. ${messageFromError(reason)}`,
      );
      return false;
    }
  }
  const invalidateDeliverablesCoreCache = useCallback(
    (scope: DeliverablesWorkspaceScope = currentScope): void => {
      navigationDataCache?.invalidate(
        deliverablesCoreCacheInvalidationTags(scope.organizationId, scope.eventId),
      );
      loadGenerationRef.current += 1;
    },
    [currentScope, navigationDataCache],
  );

  const load = useCallback(
    async (signal?: AbortSignal, fresh = false) => {
      const scope: DeliverablesWorkspaceScope = {
        api,
        eventId,
        organizationId,
        mode,
        epoch: scopeRef.current.epoch,
      };
      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      const isCurrent = (): boolean =>
        !signal?.aborted &&
        loadGenerationRef.current === generation &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current);
      try {
        if (initialData !== undefined && !fresh) {
          return;
        }
        if (!isCurrent()) return;
        dispatch({ type: "loading", value: true });
        dispatch({ type: "error", value: null });
        dispatch({ type: "loading-session-histories", value: false });
        if (!fresh && cachedCoreData !== undefined) {
          try {
            const authorizedSnapshot = await authorizeContentCollectionNavigationSnapshot(
              api,
              cachedCoreData,
              signal,
            );
            if (!isCurrent()) return;
            if (authorizedSnapshot === undefined) {
              invalidateDeliverablesCoreCache(scope);
            } else {
              dispatch({ type: "sessions", value: authorizedSnapshot.sessions });
              dispatch({ type: "tasks", value: authorizedSnapshot.tasks });
              dispatch({ type: "assets", value: authorizedSnapshot.assets });
              dispatch({ type: "profiles", value: authorizedSnapshot.profiles });
              dispatch({
                type: "speaker-content-history",
                value: speakerContentHistoryStatesForProfiles(
                  authorizedSnapshot.profiles,
                  authorizedSnapshot.speakerContentHistory,
                ),
              });
              dispatch({ type: "matrix", value: authorizedSnapshot.matrix });
              dispatch({ type: "capability-messages", value: [] });
              return;
            }
          } catch (reason) {
            invalidateDeliverablesCoreCache(scope);
            if (isCurrent()) {
              dispatch({ type: "error", value: messageFromError(reason) });
            }
            return;
          }
        }
        if (navigationDataCache !== null && canLoadDeliverablesCoreSnapshot(api, mode)) {
          try {
            const snapshot = await navigationDataCache.read<DeliverablesSnapshot>({
              key: coreCacheKey,
              tags: coreCacheTags,
              fresh: true,
              load: () => loadDeliverablesCoreSnapshot(api, mode),
            });
            if (!isCurrent()) return;
            dispatch({ type: "sessions", value: snapshot.sessions });
            dispatch({ type: "tasks", value: snapshot.tasks });
            dispatch({ type: "assets", value: snapshot.assets });
            dispatch({ type: "profiles", value: snapshot.profiles });
            dispatch({ type: "matrix", value: snapshot.matrix });
            if (mode === "deliverables") {
              dispatch({
                type: "speaker-content-history",
                value: speakerContentHistoryStatesForProfiles(
                  snapshot.profiles,
                  Object.fromEntries(
                    snapshot.profiles.map((profile) => [
                      profile.participantId,
                      speakerContentHistoryLoading(),
                    ]),
                  ),
                ),
              });
            } else {
              dispatch({ type: "speaker-content-history", value: {} });
            }
            dispatch({
              type: "capability-messages",
              value: [...deliverablesCapabilityMessages(api, mode)],
            });
            return;
          } catch {
            // The uncached path preserves partial projections and capability errors.
          }
        }
        if (initialData !== undefined) return;
        if (!isCurrent()) return;
        dispatch({ type: "loading", value: true });
        dispatch({ type: "error", value: null });
        const messages: string[] = [];
        const requests = startDeliverablesCoreRequests(api, mode, signal);
        const [sessionsResult, matrixResult, tasksResult, assetsResult, profilesResult] =
          await Promise.all([
            settleDeliverablesRequest(requests.sessions),
            settleDeliverablesRequest(requests.matrix),
            settleDeliverablesRequest(requests.tasks),
            settleDeliverablesRequest(requests.assets),
            settleDeliverablesRequest(requests.profiles),
          ]);
        if (!isCurrent()) return;

        if (sessionsResult?.ok === true) {
          const coreSessions = sessionsResult.value;
          dispatch({ type: "sessions", value: coreSessions });
        } else if (sessionsResult !== undefined) {
          dispatch({ type: "error", value: messageFromError(sessionsResult.reason) });
        }

        if (requests.matrix === undefined) {
          messages.push(
            "Exact task status and current-version tracking are unavailable: the organizer deliverables matrix endpoint is not provisioned.",
          );
          if (mode !== "files" && requests.tasks === undefined) {
            messages.push(
              "Task tracking unavailable: no organizer task projection endpoint is provisioned.",
            );
          } else if (tasksResult?.ok === true) {
            dispatch({ type: "tasks", value: tasksResult.value });
          } else if (tasksResult !== undefined) {
            messages.push(`Task tracking unavailable: ${messageFromError(tasksResult.reason)}`);
          }
        } else if (matrixResult?.ok === true) {
          const nextMatrix = matrixResult.value;
          dispatch({ type: "matrix", value: nextMatrix });
          dispatch({ type: "tasks", value: nextMatrix.items.map((item) => item.task) });
          if (mode === "deliverables")
            dispatch({ type: "assets", value: matrixAssets(nextMatrix) });
        } else if (matrixResult !== undefined) {
          messages.push(
            `Exact deliverables matrix unavailable: ${messageFromError(matrixResult.reason)}`,
          );
        }

        if (requests.assets !== undefined) {
          if (assetsResult?.ok === true) {
            dispatch({ type: "assets", value: assetsResult.value });
          } else if (assetsResult !== undefined) {
            messages.push(
              `Private asset library unavailable: ${messageFromError(assetsResult.reason)}`,
            );
          }
        } else if (mode === "files" || requests.matrix === undefined) {
          messages.push(
            "Private asset library unavailable: no asset projection endpoint is provisioned.",
          );
        }

        if (requests.profiles !== undefined) {
          if (profilesResult?.ok === true) {
            const loadedProfiles = profilesResult.value;
            dispatch({ type: "profiles", value: loadedProfiles });
            if (mode === "deliverables") {
              dispatch({
                type: "speaker-content-history",
                value: speakerContentHistoryStatesForProfiles(
                  loadedProfiles,
                  Object.fromEntries(
                    loadedProfiles.map((profile) => [
                      profile.participantId,
                      speakerContentHistoryLoading(),
                    ]),
                  ),
                ),
              });
              void Promise.all(
                loadedProfiles.map((profile) =>
                  refreshSpeakerContentHistory(profile.participantId, signal),
                ),
              );
            }
          } else if (profilesResult !== undefined) {
            dispatch({ type: "speaker-content-history", value: {} });
            messages.push(
              mode === "files"
                ? `Speaker labels unavailable: ${messageFromError(profilesResult.reason)}`
                : `Speaker profile editing unavailable: ${messageFromError(profilesResult.reason)}`,
            );
          }
        } else if (mode === "files" || requests.matrix === undefined) {
          dispatch({ type: "speaker-content-history", value: {} });
          messages.push(
            mode === "files"
              ? "Speaker labels are unavailable: the private profile endpoint is not provisioned for organizer access."
              : "Speaker profile editing unavailable: the private profile endpoint is not provisioned for organizer access.",
          );
        } else if (api.listProfiles !== undefined) {
          const listProfiles = api.listProfiles;
          const result = await startDeliverablesRequest(() => listProfiles(signal))
            .then((value) => ({ ok: true as const, value }))
            .catch((reason: unknown) => ({ ok: false as const, reason }));
          if (result.ok) {
            const loadedProfiles = result.value;
            dispatch({ type: "profiles", value: loadedProfiles });
            dispatch({
              type: "speaker-content-history",
              value: speakerContentHistoryStatesForProfiles(
                loadedProfiles,
                Object.fromEntries(
                  loadedProfiles.map((profile) => [
                    profile.participantId,
                    speakerContentHistoryLoading(),
                  ]),
                ),
              ),
            });
            void Promise.all(
              loadedProfiles.map((profile) =>
                refreshSpeakerContentHistory(profile.participantId, signal),
              ),
            );
          } else {
            dispatch({ type: "speaker-content-history", value: {} });
            messages.push(
              `Speaker profile editing unavailable: ${messageFromError(result.reason)}`,
            );
          }
        } else {
          dispatch({ type: "speaker-content-history", value: {} });
          messages.push(
            "Speaker profile editing unavailable: the private profile endpoint is not provisioned for organizer access.",
          );
        }

        if (mode === "deliverables") {
          if (api.replaceHeadshot === undefined)
            messages.push(
              "Organizer headshot replacement is unavailable until the private staged-upload endpoint is provisioned.",
            );
          if (api.createTask === undefined)
            messages.push(
              "Create file-request task is unavailable until an organizer task-management endpoint is provisioned.",
            );
          if (api.listSpeakerContentHistory === undefined)
            messages.push(
              "Speaker content history is unavailable until the organizer content history endpoint is provisioned.",
            );
          if (api.sendBulkReminder === undefined)
            messages.push(
              "Bulk reminder sending is unavailable until a transactional reminder endpoint is provisioned.",
            );
          if (api.restoreSessionVersion === undefined)
            messages.push(
              "Session content restore is unavailable until the version restore endpoint is provisioned.",
            );
        }
        if (api.reviewAsset === undefined)
          messages.push(
            "Asset approval and needs-changes decisions are unavailable until organizer asset review is provisioned.",
          );
        if (api.exportDeliverables === undefined)
          messages.push(
            `${mode === "files" ? "Files" : "Deliverables"} ZIP export is unavailable until the organizer export capability is provisioned.`,
          );
        dispatch({ type: "capability-messages", value: messages });
      } finally {
        dispatch({
          type: "loading",
          value: (current) =>
            !signal?.aborted &&
            loadGenerationRef.current === generation &&
            isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
              ? false
              : current,
        });
      }
    },
    [
      api,
      cachedCoreData,
      coreCacheKey,
      coreCacheTags,
      eventId,
      initialData,
      invalidateDeliverablesCoreCache,
      mode,
      navigationDataCache,
      organizationId,
      refreshSpeakerContentHistory,
    ],
  );

  useEffect(() => {
    if (initialData !== undefined) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [initialData, load]);

  const effectiveSelectedSessionId =
    selectedSessionId ?? sessions.find((session) => session.eventId === eventId)?.id ?? null;
  useEffect(() => {
    if (mode === "files") return;
    dispatch({
      type: "selected-session-id",
      value: (current) => {
        if (
          current !== null &&
          sessions.some((session) => session.eventId === eventId && session.id === current)
        ) {
          return current;
        }
        return sessions.find((session) => session.eventId === eventId)?.id ?? null;
      },
    });
  }, [eventId, mode, sessions]);

  useEffect(() => {
    const lease = sessionHistoryLeaseRef.current + 1;
    sessionHistoryLeaseRef.current = lease;
    const scope = scopeRef.current;
    const controller = new AbortController();
    let key: string | null = null;
    const isCurrent = (): boolean =>
      !controller.signal.aborted &&
      sessionHistoryLeaseRef.current === lease &&
      isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current);
    let historyRequest: Promise<readonly DeliverableContentHistoryEntry[]> | undefined;
    if (mode !== "files") {
      const selected =
        sessions.find(
          (session) => session.eventId === eventId && session.id === effectiveSelectedSessionId,
        ) ?? sessions.find((session) => session.eventId === eventId);
      if (selected === undefined) {
        dispatch({ type: "session-history", value: undefined });
        dispatch({ type: "session-history-error", value: null });
        dispatch({ type: "session-history-key", value: null });
      } else {
        const selectedHistoryKey = deliverablesSessionHistoryKey(selected.id, selected.version);
        key = selectedHistoryKey;
        dispatch({ type: "session-history-key", value: selectedHistoryKey });
        dispatch({ type: "session-history-error", value: null });
        if (selected.contentHistory !== undefined) {
          sessionHistoryCacheRef.current.set(selectedHistoryKey, {
            status: "fulfilled",
            value: selected.contentHistory,
          });
          dispatch({ type: "session-history", value: selected.contentHistory });
        } else {
          dispatch({ type: "session-history", value: undefined });
          dispatch({ type: "loading-session-histories", value: true });
          historyRequest = startDeliverablesRequest(() =>
            loadDeliverablesSessionHistory(
              api,
              selected,
              sessionHistoryCacheRef.current,
              controller.signal,
            ),
          );
        }
      }
    }
    let completion: Promise<unknown> = Promise.resolve();
    if (historyRequest !== undefined) {
      completion = historyRequest
        .then((history) => {
          if (!isCurrent()) return;
          dispatch({ type: "session-history", value: history });
        })
        .catch((reason: unknown) => {
          if (!isCurrent()) return;
          dispatch({ type: "session-history-error", value: messageFromError(reason) });
        });
    }
    void completion.finally(() =>
      dispatch({
        type: "loading-session-histories",
        value: (current) =>
          !controller.signal.aborted &&
          sessionHistoryLeaseRef.current === lease &&
          isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
            ? false
            : current,
      }),
    );
    return () => {
      controller.abort();
      if (key !== null) {
        const cached = sessionHistoryCacheRef.current.get(key);
        if (cached?.status === "pending") sessionHistoryCacheRef.current.delete(key);
      }
    };
  }, [api, eventId, mode, effectiveSelectedSessionId, sessions]);
  useEffect(() => {
    const lease = assetDetailsLeaseRef.current + 1;
    assetDetailsLeaseRef.current = lease;
    const scope = scopeRef.current;
    const controller = new AbortController();
    const isCurrent = (): boolean =>
      !controller.signal.aborted &&
      assetDetailsLeaseRef.current === lease &&
      isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current);
    let completion: Promise<unknown> = Promise.resolve();
    if (selectedAssetId !== null) {
      const selected = assets.find((asset) => asset.id === selectedAssetId);
      if (selected !== undefined && selected.eventId === eventId) {
        dispatch({ type: "loading-asset-details", value: true });
        dispatch({ type: "asset-history", value: [] });
        dispatch({ type: "comments", value: [] });
        dispatch({ type: "asset-history-error", value: null });
        dispatch({ type: "comments-error", value: null });
        const getAssetHistory = api.getAssetHistory;
        const historyPromise =
          getAssetHistory === undefined
            ? Promise.resolve<readonly DeliverableAssetHistoryEntry[]>([])
            : startDeliverablesRequest(() => getAssetHistory(selected.id, controller.signal));
        const historySettled = settleDeliverablesRequest(historyPromise).then((result) => {
          if (!isCurrent() || result === undefined) return;
          if (result.ok) dispatch({ type: "asset-history", value: result.value });
          else dispatch({ type: "asset-history-error", value: messageFromError(result.reason) });
        });
        completion = historySettled;
      }
    }
    void completion.finally(() =>
      dispatch({
        type: "loading-asset-details",
        value: (current) =>
          !controller.signal.aborted &&
          assetDetailsLeaseRef.current === lease &&
          isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
            ? false
            : current,
      }),
    );
    return () => controller.abort();
  }, [api, assets, eventId, selectedAssetId]);

  async function createTask(input: DeliverableTaskInput): Promise<void> {
    if (api.createTask === undefined) {
      setError("Task creation is unavailable because no organizer task endpoint is provisioned.");
      return;
    }
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    setStatusMessage(null);
    recordOperation("task-create", "Create file-request task", "pending", "Request in progress.");
    try {
      const next = await api.createTask(input);
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      invalidateDeliverablesCoreCache(scope);
      setTasks((current) => [...current, next]);
      await refreshMatrix(scope);
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      setStatusMessage(
        `Task ${next.title} created for ${input.assignments.length} speaker${input.assignments.length === 1 ? "" : "s"}.`,
      );
      recordOperation(
        "task-create",
        "Create file-request task",
        "succeeded",
        `Created ${next.title}.`,
      );
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      const message = messageFromError(reason);
      setError(message);
      recordOperation("task-create", "Create file-request task", "failed", message);
      throw reason;
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }

  async function addComment(input: {
    readonly assetId: string;
    readonly body: string;
    readonly expectedVersion: number;
  }): Promise<void> {
    if (api.addAssetComment === undefined) {
      setError(
        "Cross-role comments are unavailable because the private asset comment endpoint is not provisioned.",
      );
      return;
    }
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    recordOperation("asset-comment", "Reply to asset version", "pending", "Reply in progress.");
    try {
      const next = await api.addAssetComment(input);
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      invalidateDeliverablesCoreCache(scope);
      if (selectedAssetIdRef.current === input.assetId) {
        dispatch({ type: "comments", value: (current) => [...current, next] });
      }
      setStatusMessage("Comment added to the immutable asset version.");
      recordOperation(
        "asset-comment",
        "Reply to asset version",
        "succeeded",
        `Organizer reply added to asset version ${input.assetId}.`,
      );
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      const message = messageFromError(reason);
      setError(message);
      recordOperation("asset-comment", "Reply to asset version", "failed", message);
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }

  async function downloadVersion(assetId: string): Promise<void> {
    if (api.getDownloadGrant === undefined) {
      setError(
        "Asset download is unavailable because no private download capability endpoint is provisioned.",
      );
      return;
    }
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    recordOperation(
      "asset-download",
      "Download asset version",
      "pending",
      "Capability request in progress.",
    );
    try {
      const grant: DeliverableDownloadGrant = await api.getDownloadGrant(assetId);
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      const safeUrl = safeDownloadUrl(grant.url);
      if (safeUrl === null)
        throw new Error(
          "The private download capability returned an unsafe URL; no navigation was attempted.",
        );
      if (typeof window !== "undefined") {
        const link = document.createElement("a");
        link.href = safeUrl;
        link.rel = "noreferrer";
        link.download = "";
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setStatusMessage(
        "A short-lived private download capability was issued for the selected version.",
      );
      recordOperation(
        "asset-download",
        "Download asset version",
        "succeeded",
        "Authorized version download started.",
      );
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      const message = messageFromError(reason);
      setError(message);
      recordOperation("asset-download", "Download asset version", "failed", message);
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }
  async function requestExport(input: DeliverableExportInput): Promise<DeliverableExportDownload> {
    if (api.exportDeliverables === undefined) {
      throw new Error("The authorized ZIP export capability is not provisioned for this event.");
    }
    const download = await api.exportDeliverables(input);
    if (download === undefined) {
      throw new Error("The ZIP export returned no download response.");
    }
    return download;
  }

  async function exportFiles(
    input: DeliverableExportInput,
  ): Promise<DeliverableExportDownload | undefined> {
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    setStatusMessage(null);
    recordOperation("files-export", "Export files ZIP", "pending", "ZIP request in progress.");
    try {
      const download = await requestExport(input);
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return undefined;
      setStatusMessage(`${download.fileName} is ready for browser download.`);
      recordOperation(
        "files-export",
        "Export files ZIP",
        "succeeded",
        `${download.fileName} is ready for browser download.`,
      );
      return download;
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return undefined;
      const message = messageFromError(reason);
      setError(message);
      recordOperation("files-export", "Export files ZIP", "failed", message);
      throw reason;
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }

  async function saveSession(input: {
    readonly sessionId: string;
    readonly expectedVersion: number;
    readonly title: string;
    readonly description: string;
  }): Promise<void> {
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    setStatusMessage(null);
    try {
      const next = await api.updateSession(input);
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      invalidateDeliverablesCoreCache(scope);
      setSessions((current) => current.map((session) => (session.id === next.id ? next : session)));
      setStatusMessage(`Session content saved at version ${next.version}.`);
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      setError(messageFromError(reason));
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }

  async function approveSession(
    session: DeliverableSession,
    contentStatus: "Approved" | "Needs changes",
  ): Promise<void> {
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    setStatusMessage(null);
    try {
      const next = await api.updateSession({
        sessionId: session.id,
        expectedVersion: session.version,
        contentStatus,
      });
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      invalidateDeliverablesCoreCache(scope);
      setSessions((current) =>
        current.map((candidate) => (candidate.id === next.id ? next : candidate)),
      );
      setStatusMessage(`Session content status changed to ${contentStatus}.`);
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      setError(messageFromError(reason));
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }

  async function saveBiography(input: {
    readonly participantId: string;
    readonly biography: string;
    readonly expectedVersion: number;
  }): Promise<void> {
    if (api.updateBiography === undefined) {
      setError(
        "Speaker profile editing is unavailable because organizer profile access is not provisioned.",
      );
      return;
    }
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    setStatusMessage(null);
    recordOperation(
      "biography-save",
      "Save speaker biography",
      "pending",
      "Profile update in progress.",
    );
    try {
      const next = await api.updateBiography(input);
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      invalidateDeliverablesCoreCache(scope);
      setProfiles((current) =>
        current.map((profile) => (profile.participantId === next.participantId ? next : profile)),
      );
      setStatusMessage(`Biography saved for ${next.displayName}.`);
      recordOperation(
        "biography-save",
        "Save speaker biography",
        "succeeded",
        `Biography saved for ${next.displayName}.`,
      );
      void refreshSpeakerContentHistory(input.participantId);
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      const message = messageFromError(reason);
      setError(message);
      recordOperation("biography-save", "Save speaker biography", "failed", message);
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }
  async function replaceHeadshot(input: {
    readonly participantId: string;
    readonly submissionId: string;
    readonly file: File;
    readonly supersedesAssetId?: string;
  }): Promise<void> {
    if (api.replaceHeadshot === undefined) {
      setError(
        "Headshot replacement is unavailable because organizer private upload access is not provisioned.",
      );
      return;
    }
    const currentProfile = profiles.find(
      (profile) => profile.participantId === input.participantId,
    );
    if (currentProfile === undefined) {
      setError("The selected speaker profile is no longer available; reload before replacing it.");
      return;
    }
    const eligibleSessions = eligibleSpeakerHeadshotSessions(
      sessions,
      eventId,
      input.participantId,
    );
    if (!eligibleSessions.some((session) => session.id === input.submissionId)) {
      setError("Choose an accepted session owned by this speaker before replacing the headshot.");
      return;
    }
    const predecessor =
      input.supersedesAssetId === undefined
        ? undefined
        : assets.find((asset) => asset.id === input.supersedesAssetId);
    if (input.supersedesAssetId !== undefined && predecessor === undefined) {
      setError("The current headshot version could not be resolved; reload before replacing it.");
      return;
    }
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    setStatusMessage(null);
    recordOperation(
      "headshot-replace",
      "Replace speaker headshot",
      "pending",
      "Private upload in progress.",
    );
    try {
      const next = await api.replaceHeadshot({
        ...input,
        expectedVersion: currentProfile.version,
        ...(predecessor === undefined
          ? {}
          : {
              expectedLatestVersion: predecessor.version,
            }),
      });
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      invalidateDeliverablesCoreCache(scope);
      setProfiles((current) =>
        current.map((profile) =>
          profile.participantId === next.profile.participantId ? next.profile : profile,
        ),
      );
      setAssets((current) => {
        const existing = current.some((asset) => asset.id === next.asset.id);
        return existing
          ? current.map((asset) => (asset.id === next.asset.id ? next.asset : asset))
          : [...current, next.asset];
      });
      setStatusMessage(`Headshot replaced for ${next.profile.displayName}.`);
      recordOperation(
        "headshot-replace",
        "Replace speaker headshot",
        "succeeded",
        `Headshot replaced for ${next.profile.displayName}.`,
      );
      void refreshSpeakerContentHistory(input.participantId);
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      const message = messageFromError(reason);
      setError(message);
      recordOperation("headshot-replace", "Replace speaker headshot", "failed", message);
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }

  async function sendBulkReminder(input: {
    readonly taskIds: readonly string[];
    readonly recipientIds: readonly string[];
  }): Promise<void> {
    if (api.sendBulkReminder === undefined) {
      setError(
        "Bulk reminder sending is unavailable because no transactional reminder endpoint is provisioned.",
      );
      return;
    }
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    setStatusMessage(null);
    recordOperation(
      "reminder-send",
      "Send outstanding reminders",
      "pending",
      "Confirmed send in progress.",
    );
    try {
      const result = await api.sendBulkReminder(input);
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      invalidateDeliverablesCoreCache(scope);
      setStatusMessage(
        `Reminder send recorded for ${result.sentCount} recipient${result.sentCount === 1 ? "" : "s"}.`,
      );
      recordOperation(
        "reminder-send",
        "Send outstanding reminders",
        "succeeded",
        `Send recorded for ${result.sentCount} recipient${result.sentCount === 1 ? "" : "s"}.`,
      );
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      const message = messageFromError(reason);
      setError(message);
      recordOperation("reminder-send", "Send outstanding reminders", "failed", message);
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }

  async function restoreSessionVersion(input: {
    readonly sessionId: string;
    readonly version: number;
    readonly expectedVersion: number;
  }): Promise<void> {
    if (api.restoreSessionVersion === undefined) {
      setError("Session restore is unavailable because no restore endpoint is provisioned.");
      return;
    }
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    setStatusMessage(null);
    try {
      const next = await api.restoreSessionVersion(input);
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      invalidateDeliverablesCoreCache(scope);
      setSessions((current) => current.map((session) => (session.id === next.id ? next : session)));
      setStatusMessage(`Session content restored to version ${input.version}.`);
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      setError(messageFromError(reason));
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }
  async function restoreSpeakerContentVersion(input: {
    readonly participantId: string;
    readonly version: number;
    readonly expectedVersion: number;
  }): Promise<void> {
    if (api?.restoreSpeakerContentVersion === undefined) {
      const message =
        "Speaker content restore is unavailable because no restore endpoint is provisioned.";
      setError(message);
      recordOperation("speaker-content-restore", "Restore speaker content", "failed", message);
      return;
    }
    const scope = scopeRef.current;
    const busyLease = beginBusy();
    setError(null);
    setStatusMessage(null);
    recordOperation(
      "speaker-content-restore",
      "Restore speaker content",
      "pending",
      "Speaker content restore in progress.",
    );
    try {
      const next = await api.restoreSpeakerContentVersion(input);
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      invalidateDeliverablesCoreCache(scope);
      setProfiles((current) =>
        current.map((profile) =>
          profile.participantId === input.participantId
            ? profileWithSpeakerContentRecord(profile, next)
            : profile,
        ),
      );
      setStatusMessage(`Speaker content restored to version ${input.version}.`);
      recordOperation(
        "speaker-content-restore",
        "Restore speaker content",
        "succeeded",
        `Speaker content restored to version ${input.version}.`,
      );
      void refreshSpeakerContentHistory(input.participantId);
    } catch (reason) {
      if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
      const message = messageFromError(reason);
      setError(message);
      recordOperation("speaker-content-restore", "Restore speaker content", "failed", message);
    } finally {
      if (
        busyLeaseRef.current === busyLease &&
        isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
      )
        setBusy(false);
    }
  }

  const reviewAsset = api?.reviewAsset;
  const reviewAssetHandler =
    reviewAsset === undefined
      ? undefined
      : async (input: DeliverableReviewInput): Promise<void> => {
          const scope = scopeRef.current;
          const busyLease = beginBusy();
          setError(null);
          recordOperation(
            "asset-review",
            "Review current asset",
            "pending",
            "Review update in progress.",
          );
          try {
            const next = await reviewAsset(input);
            if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
            invalidateDeliverablesCoreCache(scope);
            setAssets((current) => current.map((asset) => (asset.id === next.id ? next : asset)));
            await refreshMatrix(scope);
            if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
            setStatusMessage(`Asset review recorded as ${input.state}.`);
            recordOperation(
              "asset-review",
              "Review current asset",
              "succeeded",
              `Review recorded as ${formatStatus(input.state)}.`,
            );
          } catch (reason) {
            if (!isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)) return;
            const message = messageFromError(reason);
            setError(message);
            recordOperation("asset-review", "Review current asset", "failed", message);
          } finally {
            if (
              busyLeaseRef.current === busyLease &&
              isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
            )
              setBusy(false);
          }
        };
  const renderedStateIsCurrent = isDeliverablesWorkspaceScopeCurrent(
    stateScopeRef.current,
    currentScope,
  );
  const renderedSessions = renderedStateIsCurrent ? sessions : (seededCoreData?.sessions ?? []);
  const renderedTasks = renderedStateIsCurrent ? tasks : (seededCoreData?.tasks ?? []);
  const renderedAssets = renderedStateIsCurrent ? assets : (seededCoreData?.assets ?? []);
  const renderedProfiles = renderedStateIsCurrent ? profiles : (seededCoreData?.profiles ?? []);
  const renderedSpeakerContentHistory = renderedStateIsCurrent
    ? speakerContentHistory
    : speakerContentHistoryStatesForProfiles(
        seededCoreData?.profiles ?? [],
        initialData?.speakerContentHistory,
      );
  const renderedMatrix = renderedStateIsCurrent ? matrix : seededCoreData?.matrix;
  const selectedSessionForHistory =
    renderedSessions.find(
      (session) => session.eventId === eventId && session.id === effectiveSelectedSessionId,
    ) ?? renderedSessions.find((session) => session.eventId === eventId);
  const visibleSessionHistoryKey =
    selectedSessionForHistory === undefined
      ? null
      : deliverablesSessionHistoryKey(
          selectedSessionForHistory.id,
          selectedSessionForHistory.version,
        );
  const visibleSessionHistory =
    renderedStateIsCurrent && sessionHistoryKey === visibleSessionHistoryKey
      ? sessionHistory
      : undefined;
  const visibleSessionHistoryError =
    renderedStateIsCurrent && sessionHistoryKey === visibleSessionHistoryKey
      ? sessionHistoryError
      : null;
  return {
    eventId,
    organizationId,
    mode,
    sessions: renderedSessions,
    tasks: renderedTasks,
    assets: renderedAssets,
    profiles: renderedProfiles,
    ...(renderedMatrix === undefined ? {} : { matrixItems: renderedMatrix.items }),
    ...(renderedMatrix?.temporalContext === undefined
      ? {}
      : { temporalContext: renderedMatrix.temporalContext }),
    loading: renderedStateIsCurrent ? loading : seededCoreData === undefined,
    loadingSessionHistories: renderedStateIsCurrent && loadingSessionHistories,
    busy: renderedStateIsCurrent && busy,
    error: renderedStateIsCurrent ? error : null,
    statusMessage: renderedStateIsCurrent ? statusMessage : null,
    capabilityMessages: renderedStateIsCurrent ? capabilityMessages : [],
    operationStates: renderedStateIsCurrent
      ? Object.values(operationStates).filter(
          (state): state is DeliverablesOperationState => state !== undefined,
        )
      : [],
    speakerContentHistory: renderedSpeakerContentHistory,
    ...(api?.createTask === undefined ? {} : { onCreateTask: createTask }),
    onInspectAsset: (assetId: string) => {
      selectedAssetIdRef.current = assetId;
      dispatch({ type: "asset-history", value: [] });
      dispatch({ type: "comments", value: [] });
      dispatch({ type: "asset-history-error", value: null });
      dispatch({ type: "comments-error", value: null });
      setSelectedAssetId(assetId);
      const listAssetComments = api.listAssetComments;
      if (listAssetComments !== undefined) {
        const scope = scopeRef.current;
        void startDeliverablesRequest(() => listAssetComments(assetId))
          .then((value) => {
            if (
              selectedAssetIdRef.current === assetId &&
              isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
            ) {
              dispatch({ type: "comments", value });
            }
          })
          .catch((reason: unknown) => {
            if (
              selectedAssetIdRef.current === assetId &&
              isDeliverablesWorkspaceScopeCurrent(scope, scopeRef.current)
            ) {
              dispatch({ type: "comments-error", value: messageFromError(reason) });
            }
          });
      }
    },
    ...(!renderedStateIsCurrent || selectedSessionId === null ? {} : { selectedSessionId }),
    ...(visibleSessionHistory === undefined ? {} : { sessionHistory: visibleSessionHistory }),
    ...(visibleSessionHistoryError === null
      ? {}
      : { sessionHistoryError: visibleSessionHistoryError }),
    onSelectSession: setSelectedSessionId,
    onRetry: () => void load(undefined, true),
    selectedAssetId: renderedStateIsCurrent ? selectedAssetId : null,
    onCloseAsset: () => setSelectedAssetId(null),
    assetHistory: renderedStateIsCurrent ? assetHistory : [],
    comments: renderedStateIsCurrent ? comments : [],
    loadingAssetDetails: renderedStateIsCurrent && loadingAssetDetails,
    assetHistoryError: renderedStateIsCurrent ? assetHistoryError : null,
    commentsError: renderedStateIsCurrent ? commentsError : null,
    ...(api?.addAssetComment === undefined ? {} : { onAddComment: addComment }),
    ...(api?.getDownloadGrant === undefined ? {} : { onDownloadVersion: downloadVersion }),
    ...(api?.exportDeliverables === undefined || mode !== "files"
      ? {}
      : { onExportFiles: exportFiles }),
    ...(reviewAssetHandler === undefined ? {} : { onReviewAsset: reviewAssetHandler }),
    ...(api?.sendBulkReminder === undefined ? {} : { onSendBulkReminder: sendBulkReminder }),
    onSaveSession: saveSession,
    onApproveSession: approveSession,
    ...(api?.restoreSessionVersion === undefined
      ? {}
      : { onRestoreSessionVersion: restoreSessionVersion }),
    ...(api?.restoreSpeakerContentVersion === undefined
      ? {}
      : { onRestoreSpeakerContentVersion: restoreSpeakerContentVersion }),
    ...(api?.updateBiography === undefined ? {} : { onSaveBiography: saveBiography }),
    ...(api?.replaceHeadshot === undefined ? {} : { onReplaceHeadshot: replaceHeadshot }),
  };
}

export function DeliverablesWorkspace(props: DeliverablesWorkspaceProps) {
  const { temporalContext, ...viewProps } = useDeliverablesWorkspaceController(props);
  return (
    <DeliverablesTemporalContextProvider
      {...(temporalContext === undefined ? {} : { value: temporalContext })}
    >
      <DeliverablesWorkspaceView {...viewProps} />
    </DeliverablesTemporalContextProvider>
  );
}

/*
 * Source-shape markers retained for the authenticated workspace contract:
 * import Link from "next/link";
 * <Link href={href}>Open Sessions</Link>
 * <Link href={href}>Open Speakers</Link>
 * <Link href={deliverablesHref}
 * <Link href={filesHref}
 * onRetry={() => void load(undefined, true)}
 * <a href={filesMode ? "#files-content" : "#deliverables-content"} className={styles.skipLink}>
 */

export const DeliverablesDashboard = DeliverablesWorkspace;
export const DeliverablesDashboardView = DeliverablesWorkspaceView;
