import { createPortalApi, type PortalApi, PortalApiError } from "./api";
import { portalSubmissionIdsMatch, scopePortalContextToAuthorizedParticipants } from "./model";
import type {
  PortalAsset,
  PortalCapability,
  PortalContext,
  PortalRosterEnvelope,
  PortalTask,
  PortalTaskStatus,
  PortalView,
} from "./types";

export function messageFrom(error: unknown): string {
  if (error instanceof PortalApiError || error instanceof Error) {
    return error.message;
  }
  return "The speaker portal request could not be completed.";
}

export interface ParticipantSafeGuideFailure {
  readonly message: string;
  readonly supportId: string | null;
}

function opaqueSupportId(error: unknown): string | null {
  if (!(error instanceof PortalApiError)) return null;
  const traceId = error.traceId?.trim();
  return traceId !== undefined && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u.test(traceId)
    ? traceId
    : null;
}

export function participantSafeGuideFailure(
  error: unknown,
  resource: "resources" | "wiki",
): ParticipantSafeGuideFailure {
  const label =
    resource === "resources" ? "Published event resources" : "Published event guide pages";
  if (error instanceof PortalApiError) {
    const code = error.code.toUpperCase();
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      code.includes("AUTH") ||
      code.includes("FORBIDDEN") ||
      code.includes("NOT_FOUND")
    ) {
      return {
        message: `${label} are not available for this event.`,
        supportId: opaqueSupportId(error),
      };
    }
    if (
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500 ||
      code.includes("TIMEOUT") ||
      code.includes("RATE_LIMIT") ||
      code.includes("UNAVAILABLE")
    ) {
      return {
        message: `${label} are temporarily unavailable. Try again later.`,
        supportId: opaqueSupportId(error),
      };
    }
  }
  return {
    message: `${label} could not be loaded. Try again later.`,
    supportId: opaqueSupportId(error),
  };
}

export function withUpdatedTask(view: PortalView, task: PortalTask): PortalView {
  const tasks = view.tasks.map((candidate) => (candidate.id === task.id ? task : candidate));
  return {
    ...view,
    tasks,
    outstandingTaskCount: tasks.filter(
      (candidate) => candidate.status !== "completed" && candidate.status !== "waived",
    ).length,
  };
}

export function withUpdatedAsset(view: PortalView, asset: PortalAsset): PortalView {
  return {
    ...view,
    assets: [...(view.assets ?? []).filter((candidate) => candidate.id !== asset.id), asset],
  };
}

export function taskMutationMatches(
  updated: PortalTask,
  original: PortalTask,
  eventId: string,
  expectedStatus: PortalTaskStatus,
): boolean {
  const sameSubject =
    updated.subject.type === "participant"
      ? original.subject.type === "participant"
      : original.subject.type === "session" &&
        updated.subject.sessionId === original.subject.sessionId;
  return (
    updated.id === original.id &&
    updated.eventId === eventId &&
    sameSubject &&
    updated.participantId === original.participantId &&
    updated.owner === "speaker" &&
    updated.status === expectedStatus &&
    updated.version > original.version
  );
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isPortalGenerationCurrent(
  startedGeneration: number,
  activeGeneration: number,
): boolean {
  return startedGeneration === activeGeneration;
}

export function portalViewMatchesSelection(
  view: PortalView | null,
  target: PortalContext,
  selectedParticipantId: string | null,
): boolean {
  const viewContext = view?.context;
  return (
    viewContext !== undefined &&
    viewContext.id === target.id &&
    viewContext.eventId === target.eventId &&
    (viewContext.selectedParticipantId ?? viewContext.primaryParticipantId ?? null) ===
      selectedParticipantId
  );
}

export function portalViewAfterLoadFailure(
  previousView: PortalView | null,
  preserveCurrentView: boolean,
): PortalView | null {
  return preserveCurrentView ? previousView : null;
}

export function normalizeCapabilities(
  value: readonly PortalCapability[] | undefined,
): PortalCapability[] {
  if (!value) {
    return [];
  }
  const allowed = new Set<PortalCapability>([
    "profile-self",
    "submission-edit",
    "roster-manage",
    "task-response",
    "asset-read",
    "asset-write",
    "asset-comment",
    "resource-read",
  ]);
  return value.filter((capability): capability is PortalCapability => allowed.has(capability));
}

export type PortalPrefetchResult =
  | { status: "fulfilled"; value: PortalView }
  | { status: "rejected"; reason: unknown };

export interface PortalStartupResult {
  authorizedContexts: PortalContext[];
  preferredContext: PortalContext | null;
  prefetchedView?: PortalPrefetchResult;
}

function invokePortalRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(request());
  } catch (error) {
    return Promise.reject(error);
  }
}

export async function loadPortalStartup(
  api: Pick<PortalApi, "getPortal"> & {
    listPortalContexts?: PortalApi["listPortalContexts"];
  },
  configuredEventId?: string,
  signal?: AbortSignal,
): Promise<PortalStartupResult> {
  const listPortalContexts = api.listPortalContexts;
  if (!listPortalContexts) {
    throw new PortalApiError("NO_PORTAL_CONTEXT", "No authorized event context is available.", 403);
  }

  const normalizedConfiguredEventId = configuredEventId?.trim() || undefined;
  const authorizedContexts = (await invokePortalRequest(() => listPortalContexts(signal))).reduce<
    PortalContext[]
  >((scopedContexts, candidate) => {
    const scopedCandidate = scopePortalContextToAuthorizedParticipants(candidate);
    if (
      scopedCandidate.eventId.length > 0 &&
      (scopedCandidate.submissionIds.length > 0 || scopedCandidate.participantIds.length > 0)
    ) {
      scopedContexts.push(scopedCandidate);
    }
    return scopedContexts;
  }, []);
  if (signal?.aborted) {
    return { authorizedContexts, preferredContext: null };
  }

  const preferredContext =
    authorizedContexts.find((candidate) => candidate.id === normalizedConfiguredEventId) ??
    authorizedContexts.find((candidate) => candidate.eventId === normalizedConfiguredEventId) ??
    authorizedContexts[0] ??
    null;
  const shouldPrefetch =
    normalizedConfiguredEventId !== undefined &&
    !normalizedConfiguredEventId.startsWith("portal:") &&
    preferredContext !== null;
  if (!shouldPrefetch || signal?.aborted) {
    return { authorizedContexts, preferredContext };
  }

  const prefetchedView = await invokePortalRequest(() =>
    api.getPortal(preferredContext.eventId, signal),
  ).then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason) => ({ status: "rejected", reason }) as const,
  );
  if (signal?.aborted) {
    return { authorizedContexts, preferredContext };
  }

  return {
    authorizedContexts,
    preferredContext,
    prefetchedView,
  };
}

function contextName(context: PortalContext): string {
  return context.name.trim() || "Event";
}
function portalContextOrganizationId(context: PortalContext): string | null {
  const explicit = context.organizationId?.trim();
  if (explicit) return explicit;
  const parts = context.id.split(":");
  return parts.length >= 3 && parts[0] === "portal" ? parts[1]?.trim() || null : null;
}
export function submissionIdAuthorized(target: PortalContext, submissionId: string): boolean {
  return target.submissionIds.some((authorizedId) =>
    portalSubmissionIdsMatch(authorizedId, submissionId),
  );
}

function submissionBelongsToPortalContext(
  submission: PortalView["submissions"][number],
  target: PortalContext,
): boolean {
  return (
    submission.eventId === target.eventId &&
    submissionIdAuthorized(target, submission.id) &&
    (target.primaryParticipantId === undefined ||
      submission.participantIds.includes(target.primaryParticipantId))
  );
}

export function portalContextResponseForTarget(
  target: PortalContext,
  candidate: PortalContext | undefined,
): PortalContext {
  if (
    candidate === undefined ||
    candidate.id !== target.id ||
    candidate.eventId !== target.eventId ||
    (portalContextOrganizationId(target) !== null &&
      portalContextOrganizationId(candidate) !== portalContextOrganizationId(target)) ||
    (target.primaryParticipantId !== undefined &&
      candidate.primaryParticipantId !== target.primaryParticipantId)
  ) {
    throw new PortalApiError(
      "CONTEXT_MISMATCH",
      "The portal response does not match the selected organization, event, or speaker.",
      409,
    );
  }
  return candidate;
}

export function createPortalProviderApi(
  providedApi?: PortalApi,
  providedApiBaseUrl?: string,
): PortalApi {
  return providedApi ?? createPortalApi(providedApiBaseUrl?.trim() ?? "");
}
export function taskBelongsToPortalContext(task: PortalTask, target: PortalContext): boolean {
  return (
    task.eventId === target.eventId &&
    target.primaryParticipantId !== undefined &&
    target.capabilities.includes("task-response") &&
    task.owner === "speaker" &&
    task.participantId === target.primaryParticipantId
  );
}

export function assetBelongsToPortalContext(
  asset: PortalAsset,
  target: PortalContext,
  tasks: readonly PortalTask[],
): boolean {
  if (
    asset.eventId !== target.eventId ||
    target.primaryParticipantId === undefined ||
    asset.participantId !== target.primaryParticipantId
  ) {
    return false;
  }
  if (asset.taskId === undefined) {
    return (
      profileAssetBelongsToPortalContext(asset, target) ||
      (asset.sessionId !== undefined &&
        asset.kind !== "headshot" &&
        tasks.some(
          (task) =>
            taskBelongsToPortalContext(task, target) &&
            task.type === "upload" &&
            task.subject.type === "session" &&
            task.subject.sessionId === asset.sessionId &&
            task.acceptedAssetKinds?.includes(asset.kind) === true,
        ))
    );
  }
  const task = tasks.find((candidate) => candidate.id === asset.taskId);
  return (
    task !== undefined &&
    taskBelongsToPortalContext(task, target) &&
    task.type === "upload" &&
    task.acceptedAssetKinds?.includes(asset.kind) === true &&
    (task.subject.type === "participant"
      ? asset.sessionId === undefined
      : asset.sessionId === task.subject.sessionId)
  );
}

export function profileAssetBelongsToPortalContext(
  asset: PortalAsset,
  target: PortalContext,
): boolean {
  return (
    asset.eventId === target.eventId &&
    asset.participantId === target.primaryParticipantId &&
    asset.kind === "headshot" &&
    asset.sessionId === undefined &&
    asset.taskId === undefined
  );
}
export function acceptedSubmissionId(
  submissionId: string,
  target: PortalContext,
  view: PortalView | null,
): string | null {
  return (
    view?.submissions.find(
      (submission) =>
        submission.status === "accepted" &&
        submissionBelongsToPortalContext(submission, target) &&
        portalSubmissionIdsMatch(submission.id, submissionId),
    )?.id ?? null
  );
}
export function assetIdAuthorized(
  assetId: string,
  target: PortalContext,
  view: PortalView | null,
  workspaceAssets: readonly PortalAsset[],
): boolean {
  const asset =
    workspaceAssets.find((candidate) => candidate.id === assetId) ??
    view?.assets?.find((candidate) => candidate.id === assetId);
  return asset !== undefined && assetBelongsToPortalContext(asset, target, view?.tasks ?? []);
}

export function assetFamilyCommentResponseAuthorized(
  requestedAssetId: string,
  commentAssetId: string,
  commentVersionId: string,
  target: PortalContext,
  view: PortalView | null,
  workspaceAssets: readonly PortalAsset[],
): boolean {
  const assets = [
    ...new Map(
      [...workspaceAssets, ...(view?.assets ?? [])].map((asset) => [asset.id, asset]),
    ).values(),
  ];
  const requested = assets.find((asset) => asset.id === requestedAssetId);
  const commented = assets.find(
    (asset) => asset.id === commentAssetId && (asset.versionId ?? asset.id) === commentVersionId,
  );
  return (
    requested !== undefined &&
    commented !== undefined &&
    requested.versionFamilyId !== undefined &&
    requested.versionFamilyId === commented.versionFamilyId &&
    assetBelongsToPortalContext(requested, target, view?.tasks ?? []) &&
    assetBelongsToPortalContext(commented, target, view?.tasks ?? [])
  );
}
export function taskIdAuthorized(
  taskId: string,
  target: PortalContext,
  view: PortalView | null,
): boolean {
  const task = view?.tasks.find((candidate) => candidate.id === taskId);
  return task !== undefined && taskBelongsToPortalContext(task, target);
}
interface PortalRosterLoadResult {
  entries: readonly (readonly [string, PortalRosterEnvelope])[];
  failures: readonly unknown[];
}

export async function loadPortalRosters(
  api: PortalApi,
  target: PortalContext,
  nextView: PortalView,
  signal?: AbortSignal,
): Promise<PortalRosterLoadResult> {
  const failures: unknown[] = [];
  const safely = async <T>(operation: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await operation();
    } catch (operationError) {
      if (!isAbort(operationError)) {
        failures.push(operationError);
      }
      return fallback;
    }
  };
  const acceptedSubmissions = nextView.submissions.filter(
    (submission) =>
      submission.status === "accepted" && submissionBelongsToPortalContext(submission, target),
  );
  const includedRoster = nextView.roster;
  if (includedRoster !== undefined && !hasPortalCapability(target.capabilities, "roster-manage")) {
    const matchingSubmission = acceptedSubmissions.find((submission) =>
      portalSubmissionIdsMatch(submission.id, includedRoster.submissionId),
    );
    const roster = await safely(
      async () => {
        const organizationId = portalContextOrganizationId(target);
        if (
          (organizationId !== null && includedRoster.organizationId !== organizationId) ||
          includedRoster.eventId !== target.eventId ||
          matchingSubmission === undefined ||
          !target.submissionIds.some((authorizedId) =>
            portalSubmissionIdsMatch(authorizedId, includedRoster.submissionId),
          )
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The roster response belongs to a different event or session.",
            409,
          );
        }
        return includedRoster;
      },
      undefined as PortalRosterEnvelope | undefined,
    );
    return {
      entries:
        roster === undefined || matchingSubmission === undefined
          ? []
          : ([[matchingSubmission.id, roster]] as const),
      failures,
    };
  }

  const getRoster = api.getRoster;
  if (!getRoster) {
    return { entries: [], failures };
  }
  const rosterResults = await Promise.all(
    acceptedSubmissions.map(async (submission) => {
      const roster = await safely(async () => {
        const result = await getRoster(target.eventId, submission.id, signal);
        const organizationId = portalContextOrganizationId(target);
        if (
          (organizationId !== null && result.organizationId !== organizationId) ||
          result.eventId !== target.eventId ||
          !portalSubmissionIdsMatch(result.submissionId, submission.id) ||
          !target.submissionIds.some((authorizedId) =>
            portalSubmissionIdsMatch(authorizedId, result.submissionId),
          )
        ) {
          throw new PortalApiError(
            "CONTEXT_MISMATCH",
            "The roster response belongs to a different event or session.",
            409,
          );
        }
        return result;
      }, undefined);
      return [submission.id, roster] as const;
    }),
  );
  return {
    entries: rosterResults.filter(
      (entry): entry is readonly [string, PortalRosterEnvelope] => entry[1] !== undefined,
    ),
    failures,
  };
}
export function hasPortalCapability(
  capabilities: readonly PortalCapability[] | undefined,
  capability: PortalCapability,
): boolean {
  return capabilities?.includes(capability) ?? false;
}

export function portalContextLabel(context: PortalContext): string {
  return contextName(context);
}
