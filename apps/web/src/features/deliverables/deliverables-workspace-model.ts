import type {
  DeliverableAsset,
  DeliverableAssetHistoryEntry,
  DeliverableComment,
  DeliverableContentHistoryEntry,
  DeliverableExportDownload,
  DeliverableMatrixItem,
  DeliverableMatrixStatus,
  DeliverableSession,
  DeliverableSpeakerContentHistoryEntry,
  DeliverableSpeakerProfile,
  DeliverablesApi,
  DeliverableTask,
  DeliverableTaskMatrix,
} from "./api";

export type DeliverablesWorkspaceMode = "deliverables" | "files";
export function deliverablesCoreCacheKey(
  organizationId: string,
  eventId: string,
  mode: DeliverablesWorkspaceMode,
): string {
  return `organization:${organizationId.trim()}:event:${eventId.trim()}:deliverables:${mode}:core`;
}

export function deliverablesCoreCacheTags(
  organizationId: string,
  eventId: string,
  mode: DeliverablesWorkspaceMode,
): readonly string[] {
  const normalizedOrganizationId = organizationId.trim();
  const normalizedEventId = eventId.trim();
  return [
    `organization:${normalizedOrganizationId}`,
    `event:${normalizedEventId}`,
    `deliverables:${normalizedEventId}`,
    `deliverables:${normalizedEventId}:${mode}`,
  ];
}

export function deliverablesCoreCacheInvalidationTags(
  organizationId: string,
  eventId: string,
): readonly string[] {
  const normalizedOrganizationId = organizationId.trim();
  const normalizedEventId = eventId.trim();
  return [
    `organization:${normalizedOrganizationId}`,
    `event:${normalizedEventId}`,
    `deliverables:${normalizedEventId}`,
  ];
}

export type DeliverablesExportUiStatus =
  | "idle"
  | "queued"
  | "preparing"
  | "generating"
  | "ready"
  | "download-started"
  | "failure";

export const deliverablesExportStatusLabels: Readonly<Record<DeliverablesExportUiStatus, string>> =
  {
    idle: "",
    queued: "The browser queued the authorized ZIP request.",
    preparing: "The browser is preparing the scoped export request.",
    generating:
      "The export request is generating no fabricated progress; the API exposes no server job ID.",
    ready: "The server returned a ZIP with a validated authoritative manifest.",
    "download-started": "The browser download has started.",
    failure: "The authorized ZIP request failed.",
  };
export const deliverablesExportActionLabels: Readonly<Record<DeliverablesExportUiStatus, string>> =
  {
    idle: "Download selected files ZIP",
    queued: "ZIP export queued",
    preparing: "Preparing ZIP…",
    generating: "Generating ZIP…",
    ready: "Inspect authoritative manifest",
    "download-started": "Download started",
    failure: "Retry ZIP export",
  };
export type DeliverableSpeakerContentHistoryStatus = "loading" | "empty" | "success" | "error";

export interface DeliverableSpeakerContentHistoryState {
  readonly status: DeliverableSpeakerContentHistoryStatus;
  readonly entries: readonly DeliverableSpeakerContentHistoryEntry[];
  readonly error?: string;
}

export interface DeliverablesSnapshot {
  readonly sessions: readonly DeliverableSession[];
  readonly tasks: readonly DeliverableTask[];
  readonly assets: readonly DeliverableAsset[];
  readonly profiles: readonly DeliverableSpeakerProfile[];
  readonly matrix?: DeliverableTaskMatrix;
  readonly speakerContentHistory?: Readonly<Record<string, DeliverableSpeakerContentHistoryState>>;
}

export async function authorizeContentCollectionNavigationSnapshot(
  api: Pick<DeliverablesApi, "listDeliverableMatrix">,
  snapshot: DeliverablesSnapshot,
  signal?: AbortSignal,
): Promise<DeliverablesSnapshot | undefined> {
  if (api.listDeliverableMatrix === undefined) return undefined;
  await api.listDeliverableMatrix(signal === undefined ? {} : { signal });
  return snapshot;
}

export interface DeliverableRow {
  readonly task: DeliverableTask;
  readonly session: DeliverableSession | undefined;
  readonly sessionLabel: string;
  readonly speaker: DeliverableSpeakerProfile | undefined;
  readonly speakerLabel: string;
  readonly assets: readonly DeliverableAsset[];
  readonly currentAsset: DeliverableAsset | undefined;
  readonly status: DeliverableMatrixStatus;
}

export type ContentRequestStatusFilter =
  | "all"
  | "outstanding"
  | "attention"
  | "review"
  | "complete"
  | DeliverableMatrixStatus;

export interface ContentRequestFilters {
  readonly query: string;
  readonly speakerId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly status: ContentRequestStatusFilter;
}

export interface ContentRequestMetrics {
  readonly all: number;
  readonly outstanding: number;
  readonly attention: number;
  readonly review: number;
  readonly complete: number;
}

export function isOutstanding(status: DeliverableMatrixStatus): boolean {
  return !["completed", "waived", "uploaded"].includes(status);
}

function statusMatches(status: DeliverableMatrixStatus, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "pending" || filter === "incomplete" || filter === "outstanding") {
    return isOutstanding(status);
  }
  if (filter === "attention") return status === "overdue" || status === "needs_changes";
  if (filter === "review") return status === "submitted" || status === "uploaded";
  if (filter === "complete") return status === "completed" || status === "waived";
  if (filter === "uploaded") return ["uploaded", "completed", "waived"].includes(status);
  return status === filter;
}

export function contentRequestMetrics(rows: readonly DeliverableRow[]): ContentRequestMetrics {
  return rows.reduce<ContentRequestMetrics>(
    (metrics, row) => ({
      all: metrics.all + 1,
      outstanding: metrics.outstanding + (isOutstanding(row.status) ? 1 : 0),
      attention:
        metrics.attention + (row.status === "overdue" || row.status === "needs_changes" ? 1 : 0),
      review: metrics.review + (row.status === "submitted" || row.status === "uploaded" ? 1 : 0),
      complete: metrics.complete + (row.status === "completed" || row.status === "waived" ? 1 : 0),
    }),
    { all: 0, outstanding: 0, attention: 0, review: 0, complete: 0 },
  );
}

export function filterContentRequestRows(
  rows: readonly DeliverableRow[],
  filters: ContentRequestFilters,
): readonly DeliverableRow[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    const searchable = [
      row.task.title,
      row.task.description ?? row.task.instructions ?? "",
      row.speakerLabel,
      row.sessionLabel,
      row.currentAsset?.fileName ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase();
    return (
      (query.length === 0 || searchable.includes(query)) &&
      (filters.speakerId === "all" || row.task.participantId === filters.speakerId) &&
      (filters.sessionId === "all" ||
        (row.task.subject.type === "session" ? row.task.subject.sessionId : "participant") ===
          filters.sessionId) &&
      (filters.taskId === "all" || row.task.id === filters.taskId) &&
      statusMatches(row.status, filters.status)
    );
  });
}

export function eligibleSpeakerHeadshotSessions(
  sessions: readonly DeliverableSession[],
  eventId: string,
  participantId: string,
): readonly DeliverableSession[] {
  return sessions.filter(
    (session) =>
      session.eventId === eventId &&
      session.status.trim().toLowerCase() === "accepted" &&
      session.speakerIds.includes(participantId),
  );
}

export function resolveSpeakerHeadshotSubmissionId(
  sessions: readonly DeliverableSession[],
  eventId: string,
  participantId: string,
  requestedSubmissionId: string | null | undefined,
): string | null {
  const eligibleSessions = eligibleSpeakerHeadshotSessions(sessions, eventId, participantId);
  if (eligibleSessions.length === 1) return eligibleSessions.at(0)?.id ?? null;
  return requestedSubmissionId !== null &&
    requestedSubmissionId !== undefined &&
    eligibleSessions.some((session) => session.id === requestedSubmissionId)
    ? requestedSubmissionId
    : null;
}

export function triggerDeliverablesDownload(download: DeliverableExportDownload): void {
  if (
    typeof document === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error("Deliverables downloads are unavailable in this environment.");
  }
  const objectUrl = URL.createObjectURL(new Blob([download.body], { type: download.contentType }));
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = download.fileName;
    link.rel = "noreferrer";
    link.style.display = "none";
    document.body?.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export interface DeliverablesCoreRequestHandles {
  readonly sessions: Promise<readonly DeliverableSession[]>;
  readonly matrix?: Promise<DeliverableTaskMatrix>;
  readonly tasks?: Promise<readonly DeliverableTask[]>;
  readonly assets?: Promise<readonly DeliverableAsset[]>;
  readonly profiles?: Promise<readonly DeliverableSpeakerProfile[]>;
}

type MutableDeliverablesCoreRequestHandles = {
  -readonly [Key in keyof DeliverablesCoreRequestHandles]: DeliverablesCoreRequestHandles[Key];
};

export function startDeliverablesRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(request());
  } catch (reason) {
    return Promise.reject(reason);
  }
}

/**
 * Start every independent core request synchronously. The workspace attaches
 * settlement handlers after this function returns so one rejection cannot
 * prevent the other resources from starting.
 */
export function startDeliverablesCoreRequests(
  api: DeliverablesApi,
  mode: DeliverablesWorkspaceMode,
  signal?: AbortSignal,
): DeliverablesCoreRequestHandles {
  const requests: MutableDeliverablesCoreRequestHandles = {
    sessions: startDeliverablesRequest(() => api.listSessions(signal)),
  };
  const listDeliverableMatrix = api.listDeliverableMatrix;
  if (listDeliverableMatrix !== undefined) {
    requests.matrix = startDeliverablesRequest(() =>
      listDeliverableMatrix(signal === undefined ? undefined : { signal }),
    );
  }

  const needsProjectionFallback = listDeliverableMatrix === undefined;
  if (needsProjectionFallback) {
    const listTasks = api.listTasks;
    if (listTasks !== undefined) {
      requests.tasks = startDeliverablesRequest(() => listTasks(signal));
    }
  }

  if (mode === "files" || needsProjectionFallback) {
    const listAssets = api.listAssets;
    if (listAssets !== undefined) {
      requests.assets = startDeliverablesRequest(() =>
        signal === undefined ? listAssets() : listAssets({ signal }),
      );
    }
    const listProfiles = api.listProfiles;
    if (listProfiles !== undefined) {
      requests.profiles = startDeliverablesRequest(() => listProfiles(signal));
    }
  }
  return requests;
}

type DeliverablesSettledResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: unknown };

export function settleDeliverablesRequest<T>(
  request: Promise<T> | undefined,
): Promise<DeliverablesSettledResult<T> | undefined> {
  return request === undefined
    ? Promise.resolve(undefined)
    : request.then(
        (value) => ({ ok: true as const, value }),
        (reason: unknown) => ({ ok: false as const, reason }),
      );
}
function requiredDeliverablesCoreValue<T>(
  result: DeliverablesSettledResult<T> | undefined,
  resource: string,
): T {
  if (result?.ok === true) return result.value;
  throw result === undefined
    ? new Error(`The ${resource} core projection was not provisioned.`)
    : result.reason;
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

export async function loadDeliverablesCoreSnapshot(
  api: DeliverablesApi,
  mode: DeliverablesWorkspaceMode,
  signal?: AbortSignal,
): Promise<DeliverablesSnapshot> {
  const requests = startDeliverablesCoreRequests(api, mode, signal);
  const listProfiles = api.listProfiles;
  const profileRequest =
    requests.profiles ??
    (listProfiles === undefined ? undefined : startDeliverablesRequest(() => listProfiles(signal)));
  const [sessionsResult, matrixResult, tasksResult, assetsResult, profilesResult] =
    await Promise.all([
      settleDeliverablesRequest(requests.sessions),
      settleDeliverablesRequest(requests.matrix),
      settleDeliverablesRequest(requests.tasks),
      settleDeliverablesRequest(requests.assets),
      settleDeliverablesRequest(profileRequest),
    ]);

  const sessions = requiredDeliverablesCoreValue(sessionsResult, "sessions");
  const matrix =
    requests.matrix === undefined
      ? undefined
      : requiredDeliverablesCoreValue(matrixResult, "deliverables matrix");
  const tasks =
    matrix === undefined
      ? requiredDeliverablesCoreValue(tasksResult, "tasks")
      : matrix.items.map((item) => item.task);
  const assets =
    matrix === undefined || mode === "files"
      ? requiredDeliverablesCoreValue(assetsResult, "assets")
      : matrixAssets(matrix);
  const profiles = requiredDeliverablesCoreValue(profilesResult, "speaker profiles");

  return { sessions, tasks, assets, profiles, ...(matrix === undefined ? {} : { matrix }) };
}

export interface DeliverablesWorkspaceScope {
  readonly api: DeliverablesApi;
  readonly eventId: string;
  readonly organizationId: string;
  readonly mode?: DeliverablesWorkspaceMode;
  readonly epoch: number;
}

export function isDeliverablesWorkspaceScopeCurrent(
  expected: DeliverablesWorkspaceScope,
  current: DeliverablesWorkspaceScope,
): boolean {
  return (
    expected.epoch === current.epoch &&
    expected.api === current.api &&
    expected.eventId === current.eventId &&
    expected.organizationId === current.organizationId &&
    (expected.mode === undefined || current.mode === undefined || expected.mode === current.mode)
  );
}

export function deliverablesSessionHistoryKey(sessionId: string, sessionVersion: number): string {
  return `${sessionId}\u0000${sessionVersion}`;
}

export type DeliverablesSessionHistoryCacheEntry =
  | {
      readonly status: "pending";
      readonly promise: Promise<readonly DeliverableContentHistoryEntry[]>;
    }
  | {
      readonly status: "fulfilled";
      readonly value: readonly DeliverableContentHistoryEntry[];
    };

export type DeliverablesSessionHistoryCache = Map<string, DeliverablesSessionHistoryCacheEntry>;

export function loadDeliverablesSessionHistory(
  api: DeliverablesApi,
  session: DeliverableSession,
  cache: DeliverablesSessionHistoryCache,
  signal?: AbortSignal,
): Promise<readonly DeliverableContentHistoryEntry[]> {
  const key = deliverablesSessionHistoryKey(session.id, session.version);
  if (session.contentHistory !== undefined) {
    cache.set(key, { status: "fulfilled", value: session.contentHistory });
    return Promise.resolve(session.contentHistory);
  }

  const cached = cache.get(key);
  if (cached?.status === "fulfilled") return Promise.resolve(cached.value);
  if (cached?.status === "pending") return cached.promise;

  const request = startDeliverablesRequest(() => {
    if (api.listSessionContentHistory === undefined) {
      throw new Error("The session content history endpoint is not provisioned.");
    }
    return signal === undefined
      ? api.listSessionContentHistory(session.id)
      : api.listSessionContentHistory(session.id, signal);
  });
  let tracked!: Promise<readonly DeliverableContentHistoryEntry[]>;
  tracked = request.then(
    (value) => {
      const current = cache.get(key);
      if (current?.status === "pending" && current.promise === tracked) {
        cache.set(key, { status: "fulfilled", value });
      }
      return value;
    },
    (reason: unknown) => {
      const current = cache.get(key);
      if (current?.status === "pending" && current.promise === tracked) {
        cache.delete(key);
      }
      throw reason;
    },
  );
  cache.set(key, { status: "pending", promise: tracked });
  return tracked;
}

export interface DeliverablesAssetDetailSettled {
  readonly history: DeliverablesSettledResult<readonly DeliverableAssetHistoryEntry[]>;
  readonly comments: DeliverablesSettledResult<readonly DeliverableComment[]>;
}

export function settleDeliverablesAssetDetailRequests(
  historyRequest: Promise<readonly DeliverableAssetHistoryEntry[]>,
  commentsRequest: Promise<readonly DeliverableComment[]>,
): Promise<DeliverablesAssetDetailSettled> {
  return Promise.all([
    settleDeliverablesRequest(historyRequest),
    settleDeliverablesRequest(commentsRequest),
  ]).then(([history, comments]) => ({
    history: history as DeliverablesSettledResult<readonly DeliverableAssetHistoryEntry[]>,
    comments: comments as DeliverablesSettledResult<readonly DeliverableComment[]>,
  }));
}
