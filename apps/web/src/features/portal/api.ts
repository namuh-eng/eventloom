import type {
  PortalAsset,
  PortalAssetComment,
  PortalAssetHistoryEntry,
  PortalContext,
  PortalDownloadGrant,
  PortalErrorResponse,
  PortalFormAnswer,
  PortalProfile,
  PortalResource,
  PortalRosterEnvelope,
  PortalRosterMember,
  PortalTask,
  PortalTaskForm,
  PortalTaskResponseEnvelope,
  PortalTaskStatus,
  PortalTravelLogistics,
  PortalUploadAuthorization,
  PortalView,
  PortalWikiPage,
} from "./types";

export class PortalApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly traceId: string | undefined;

  constructor(code: string, message: string, status: number, traceId?: string) {
    super(message);
    this.name = "PortalApiError";
    this.code = code;
    this.status = status;
    this.traceId = traceId;
  }
}

export interface PortalProfileDetails {
  email?: string;
  jobTitle?: string;
  company?: string;
  status?: string;
  socialLinks?: Readonly<Record<string, string>>;
  travelLogistics?: PortalTravelLogistics;
}

export type PortalProfileDto = Omit<PortalProfile, "headshotAssetId"> & {
  headshotAssetId?: string | null;
};
export type PortalSocialNetwork = "twitter" | "linkedin";

function isLocalHostname(value: string): boolean {
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "127.0.0.1" ||
    value === "[::1]"
  );
}
function isSafeSocialHandle(value: string): boolean {
  return /^@?[A-Za-z0-9._-]{1,200}$/u.test(value);
}
export function validatePortalSocialUrl(
  value: string,
  network: PortalSocialNetwork,
): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (isSafeSocialHandle(normalized)) return null;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return `${network === "twitter" ? "Twitter/X" : "LinkedIn"} must be a valid URL or safe handle.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `${network === "twitter" ? "Twitter/X" : "LinkedIn"} must use an HTTP or HTTPS URL.`;
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHostname(hostname))) {
    return `${network === "twitter" ? "Twitter/X" : "LinkedIn"} must use an HTTPS URL.`;
  }
  const validHost =
    isLocalHostname(hostname) ||
    (network === "twitter"
      ? hostname === "x.com" ||
        hostname.endsWith(".x.com") ||
        hostname === "twitter.com" ||
        hostname.endsWith(".twitter.com")
      : hostname === "linkedin.com" || hostname.endsWith(".linkedin.com"));
  if (!validHost) {
    return `${network === "twitter" ? "Twitter/X" : "LinkedIn"} must link to the matching profile network.`;
  }
  return null;
}

export interface PortalApi {
  getPortal(eventId: string, signal?: AbortSignal): Promise<PortalView>;
  /** Server-authorized contexts. The event query string is never used for authority. */
  listPortalContexts?(signal?: AbortSignal): Promise<PortalContext[]>;
  getPortalContext?(eventId: string, signal?: AbortSignal): Promise<PortalContext>;
  updateProfile?(input: {
    eventId: string;
    participantId: string;
    biography?: string;
    jobTitle?: string;
    company?: string;
    status?: string;
    socialLinks?: Readonly<Record<string, string>>;
    travelLogistics?: PortalTravelLogistics;
    headshotAssetId?: string | null;
    expectedVersion: number;
  }): Promise<PortalProfileDto>;
  updateBiography(input: {
    eventId: string;
    participantId: string;
    biography: string;
    expectedVersion: number;
  }): Promise<PortalProfile>;
  transitionTask(input: {
    eventId: string;
    taskId: string;
    toStatus: PortalTaskStatus;
    expectedVersion: number;
    note?: string;
  }): Promise<PortalTask>;
  uploadTaskFile(input: {
    eventId: string;
    participantId: string;
    taskId: string;
    sessionId?: string;
    kind: "headshot" | "slides" | "supporting_file";
    file: File;
    supersedesAssetId?: string;
    expectedLatestVersion?: number;
    idempotencyKey?: string;
  }): Promise<PortalAsset>;

  getRoster?(
    eventId: string,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<PortalRosterEnvelope>;
  addRosterEntry?(input: {
    eventId: string;
    submissionId: string;
    email: string;
    displayName: string;
    role: "co_speaker";
  }): Promise<PortalRosterEnvelope>;
  updateRosterEntry?(input: {
    eventId: string;
    submissionId: string;
    participantId: string;
    displayName?: string;
    email?: string;
    status?: PortalRosterMember["status"];
  }): Promise<PortalRosterEnvelope>;
  removeRosterEntry?(input: {
    eventId: string;
    submissionId: string;
    participantId: string;
  }): Promise<PortalRosterEnvelope>;

  listAssets?(
    eventId: string,
    options?: { participantId?: string; versionFamilyId?: string; signal?: AbortSignal },
  ): Promise<PortalAsset[]>;
  getAssetHistory?(
    eventId: string,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<PortalAssetHistoryEntry[]>;
  listAssetComments?(
    eventId: string,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<PortalAssetComment[]>;
  addAssetComment?(input: {
    eventId: string;
    assetId: string;
    body: string;
    expectedVersion?: number;
  }): Promise<PortalAssetComment>;
  uploadFile?(input: {
    eventId: string;
    participantId: string;
    sessionId?: string;
    taskId?: string;
    kind: "headshot" | "slides" | "supporting_file";
    file: File;
    supersedesAssetId?: string;
    expectedLatestVersion?: number;
    idempotencyKey?: string;
  }): Promise<PortalAsset>;
  retryAssetUpload?(input: { eventId: string; assetId: string; file: File }): Promise<PortalAsset>;
  finalizeAsset?(input: {
    eventId: string;
    assetId: string;
    state: Extract<PortalAsset["state"], "ready" | "rejected">;
    rejectionReason?: string;
  }): Promise<PortalAsset>;
  getDownloadGrant?(eventId: string, assetId: string): Promise<PortalDownloadGrant>;

  getTaskForm?(input: {
    eventId: string;
    taskId: string;
    signal?: AbortSignal;
  }): Promise<PortalTaskForm>;
  getTaskResponse?(input: {
    eventId: string;
    taskId: string;
    signal?: AbortSignal;
  }): Promise<PortalTaskResponseEnvelope>;
  saveTaskResponse?(input: {
    eventId: string;
    taskId: string;
    definitionVersion: number;
    expectedVersion: number;
    answers: Readonly<Record<string, PortalFormAnswer>>;
  }): Promise<PortalTaskResponseEnvelope>;

  listResources?(eventId: string, signal?: AbortSignal): Promise<PortalResource[]>;
  listWiki?(eventId: string, signal?: AbortSignal): Promise<PortalWikiPage[]>;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type RequestOptions = RequestInit & { signal?: AbortSignal };
const PORTAL_REQUEST_TIMEOUT_MS = 20_000;

function removeTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveGrantUrl(value: string, origin: string): string {
  const fallbackOrigin =
    removeTrailingSlash(origin) ||
    (typeof window === "undefined" ? "" : removeTrailingSlash(window.location.origin));
  let url: URL;
  try {
    url = fallbackOrigin ? new URL(value, `${fallbackOrigin}/`) : new URL(value);
  } catch {
    if (fallbackOrigin.length === 0) return value;
    throw new TypeError("The upload grant URL is invalid.");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHostname(hostname))) {
    throw new TypeError("The upload grant URL must use HTTPS.");
  }
  return url.toString();
}

function routeSegment(value: string): string {
  return encodeURIComponent(value);
}

async function errorFrom(
  response: Response,
  fallbackCode = "PORTAL_REQUEST_FAILED",
  fallbackMessage = "The speaker portal request could not be completed.",
): Promise<PortalApiError> {
  const body = (await response.json().catch(() => undefined)) as PortalErrorResponse | undefined;
  return new PortalApiError(
    body?.error?.code ?? fallbackCode,
    body?.error?.message ?? fallbackMessage,
    response.status,
    body?.error?.traceId,
  );
}

function taskRoute(input: { eventId: string; taskId: string }): string {
  return `/events/${routeSegment(input.eventId)}/tasks/${routeSegment(input.taskId)}`;
}

export function createPortalApi(baseUrl: string, fetcher: Fetcher = fetch): PortalApi {
  const speakerBaseUrl = `${removeTrailingSlash(baseUrl)}/api/speaker`;

  async function request<T>(path: string, init?: RequestOptions): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let timeout!: ReturnType<typeof setTimeout>;
    const timeoutError = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(
          new PortalApiError(
            "PORTAL_REQUEST_TIMEOUT",
            "The speaker portal request timed out. Try again.",
            504,
          ),
        );
      }, PORTAL_REQUEST_TIMEOUT_MS);
    });
    const callerSignal = init?.signal;
    const abortCaller = () => controller.abort();
    if (callerSignal?.aborted) {
      controller.abort();
    } else {
      callerSignal?.addEventListener("abort", abortCaller, { once: true });
    }
    try {
      const response = await Promise.race([
        fetcher(`${speakerBaseUrl}${path}`, {
          ...init,
          cache: "no-store",
          credentials: "include",
          headers: {
            accept: "application/json",
            ...init?.headers,
          },
          signal: controller.signal,
        }),
        timeoutError,
      ]);
      if (!response.ok) {
        throw await errorFrom(response);
      }
      if (response.status === 204) {
        return undefined as T;
      }
      const body = (await response.json()) as { data: T };
      return body.data;
    } catch (error) {
      if (timedOut) {
        throw new PortalApiError(
          "PORTAL_REQUEST_TIMEOUT",
          "The speaker portal request timed out. Try again.",
          504,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortCaller);
    }
  }

  async function listContexts(signal?: AbortSignal): Promise<PortalContext[]> {
    return request<PortalContext[]>(
      "/portal/contexts",
      signal === undefined ? undefined : { signal },
    );
  }

  async function createUpload(input: {
    eventId: string;
    participantId: string;
    sessionId?: string;
    taskId?: string;
    kind: "headshot" | "slides" | "supporting_file";
    file: File;
    supersedesAssetId?: string;
    expectedLatestVersion?: number;
    idempotencyKey?: string;
  }): Promise<PortalAsset> {
    const idempotencyKey =
      input.supersedesAssetId === undefined
        ? undefined
        : (input.idempotencyKey ??
          [
            "replacement",
            input.eventId,
            input.participantId,
            input.sessionId ?? "",
            input.taskId ?? "",
            input.kind,
            input.supersedesAssetId,
            input.expectedLatestVersion ?? "",
            input.file.name,
            input.file.type,
            input.file.size,
            input.file.lastModified,
          ]
            .map((part) => encodeURIComponent(String(part)))
            .join(":")
            .slice(0, 128));
    const authorization = await request<PortalUploadAuthorization>(
      `/events/${routeSegment(input.eventId)}/uploads`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
        },
        body: JSON.stringify({
          participantId: input.participantId,
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          kind: input.kind,
          fileName: input.file.name,
          contentType: input.file.type || "application/octet-stream",
          sizeBytes: input.file.size,
          ...(input.supersedesAssetId === undefined
            ? {}
            : {
                supersedesAssetId: input.supersedesAssetId,
                ...(input.expectedLatestVersion === undefined
                  ? {}
                  : { expectedLatestVersion: input.expectedLatestVersion }),
              }),
        }),
      },
    );
    await uploadAuthorizedFile(input.file, authorization);
    return authorization.asset;
  }

  async function uploadAuthorizedFile(
    file: File,
    authorization: PortalUploadAuthorization,
    requireMetadataMatch = false,
  ): Promise<void> {
    if (
      (requireMetadataMatch && authorization.asset.fileName !== file.name) ||
      (requireMetadataMatch && authorization.asset.sizeBytes !== file.size) ||
      (requireMetadataMatch &&
        authorization.asset.contentType !== (file.type || "application/octet-stream"))
    ) {
      throw new PortalApiError(
        "UPLOAD_METADATA_MISMATCH",
        "Choose the same file that was originally authorized for this upload.",
        400,
      );
    }
    const uploadController = new AbortController();
    let uploadTimedOut = false;
    let uploadTimeout!: ReturnType<typeof setTimeout>;
    const uploadTimeoutError = new Promise<never>((_, reject) => {
      uploadTimeout = setTimeout(() => {
        uploadTimedOut = true;
        uploadController.abort();
        reject(new PortalApiError("UPLOAD_TIMEOUT", "The file upload timed out. Try again.", 504));
      }, PORTAL_REQUEST_TIMEOUT_MS);
    });
    try {
      const upload = await Promise.race([
        fetcher(resolveGrantUrl(authorization.grant.url, baseUrl), {
          method: authorization.grant.method,
          credentials: "omit",
          headers: authorization.grant.headers,
          body: file,
          signal: uploadController.signal,
        }),
        uploadTimeoutError,
      ]);
      if (!upload.ok) {
        throw await errorFrom(
          upload,
          "UPLOAD_FAILED",
          "The file could not be uploaded. Try again.",
        );
      }
    } catch (error) {
      if (uploadTimedOut) {
        throw new PortalApiError("UPLOAD_TIMEOUT", "The file upload timed out. Try again.", 504);
      }
      throw error;
    } finally {
      clearTimeout(uploadTimeout);
    }
  }

  const api: PortalApi = {
    getPortal(eventId, signal) {
      return request<PortalView>(
        `/events/${routeSegment(eventId)}/portal`,
        signal === undefined ? undefined : { signal },
      );
    },

    listPortalContexts: listContexts,

    getPortalContext(eventId, signal) {
      return request<PortalContext>(
        `/events/${routeSegment(eventId)}/portal/context`,
        signal === undefined ? undefined : { signal },
      );
    },

    updateProfile(input) {
      return request<PortalProfileDto>(
        `/events/${routeSegment(input.eventId)}/profiles/${routeSegment(input.participantId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(input.biography === undefined ? {} : { biography: input.biography }),
            ...(input.jobTitle === undefined ? {} : { jobTitle: input.jobTitle }),
            ...(input.company === undefined ? {} : { company: input.company }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.travelLogistics === undefined
              ? {}
              : { travelLogistics: input.travelLogistics }),
            ...(input.socialLinks === undefined ? {} : { socialLinks: input.socialLinks }),
            ...(input.headshotAssetId === undefined
              ? {}
              : { headshotAssetId: input.headshotAssetId }),
            expectedVersion: input.expectedVersion,
          }),
        },
      );
    },
    updateBiography(input) {
      return request<PortalProfile>(
        `/events/${routeSegment(input.eventId)}/profiles/${routeSegment(input.participantId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            biography: input.biography,
            expectedVersion: input.expectedVersion,
          }),
        },
      );
    },

    async transitionTask(input) {
      const data = await request<{ task: PortalTask }>(`${taskRoute(input)}/transitions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toStatus: input.toStatus,
          expectedVersion: input.expectedVersion,
          ...(input.note === undefined ? {} : { note: input.note }),
        }),
      });
      return data.task;
    },

    async uploadTaskFile(input) {
      return createUpload(input);
    },

    async getRoster(eventId, submissionId, signal) {
      return request<PortalRosterEnvelope>(
        `/events/${routeSegment(eventId)}/submissions/${routeSegment(submissionId)}/roster`,
        signal === undefined ? undefined : { signal },
      );
    },

    async addRosterEntry(input) {
      return request<PortalRosterEnvelope>(
        `/events/${routeSegment(input.eventId)}/submissions/${routeSegment(input.submissionId)}/roster`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: input.email,
            displayName: input.displayName,
            role: input.role,
          }),
        },
      );
    },

    async updateRosterEntry(input) {
      return request<PortalRosterEnvelope>(
        `/events/${routeSegment(input.eventId)}/submissions/${routeSegment(input.submissionId)}/roster/${routeSegment(input.participantId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.email === undefined ? {} : { email: input.email }),
            ...(input.status === undefined ? {} : { status: input.status }),
          }),
        },
      );
    },

    async removeRosterEntry(input) {
      return request<PortalRosterEnvelope>(
        `/events/${routeSegment(input.eventId)}/submissions/${routeSegment(input.submissionId)}/roster/${routeSegment(input.participantId)}`,
        { method: "DELETE" },
      );
    },

    async listAssets(eventId, options) {
      const query = new URLSearchParams();
      if (options?.participantId) query.set("participantId", options.participantId);
      if (options?.versionFamilyId) query.set("versionFamilyId", options.versionFamilyId);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      const data = await request<PortalAsset[]>(
        `/events/${routeSegment(eventId)}/assets${suffix}`,
        options?.signal === undefined ? undefined : { signal: options.signal },
      );
      return data;
    },

    async getAssetHistory(eventId, assetId, signal) {
      return request<PortalAssetHistoryEntry[]>(
        `/events/${routeSegment(eventId)}/assets/${routeSegment(assetId)}/history`,
        signal === undefined ? undefined : { signal },
      );
    },

    async listAssetComments(eventId, assetId, signal) {
      return request<PortalAssetComment[]>(
        `/events/${routeSegment(eventId)}/assets/${routeSegment(assetId)}/comments`,
        signal === undefined ? undefined : { signal },
      );
    },

    async addAssetComment(input) {
      return request<PortalAssetComment>(
        `/events/${routeSegment(input.eventId)}/assets/${routeSegment(input.assetId)}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: input.body,
            ...(input.expectedVersion === undefined
              ? {}
              : { expectedVersion: input.expectedVersion }),
          }),
        },
      );
    },

    uploadFile: createUpload,

    async retryAssetUpload(input) {
      const authorization = await request<PortalUploadAuthorization>(
        `/events/${routeSegment(input.eventId)}/assets/${routeSegment(input.assetId)}/upload-authorization`,
        { method: "POST" },
      );
      if (
        authorization.asset.id !== input.assetId ||
        authorization.asset.state !== "pending_upload"
      ) {
        throw new PortalApiError(
          "CONTEXT_MISMATCH",
          "The upload authorization does not match the pending asset.",
          409,
        );
      }
      await uploadAuthorizedFile(input.file, authorization, true);
      return authorization.asset;
    },

    async finalizeAsset(input) {
      return request<PortalAsset>(
        `/events/${routeSegment(input.eventId)}/assets/${routeSegment(input.assetId)}/finalize`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            state: input.state,
            ...(input.rejectionReason === undefined
              ? {}
              : { rejectionReason: input.rejectionReason }),
          }),
        },
      );
    },

    async getDownloadGrant(eventId, assetId) {
      return request<PortalDownloadGrant>(
        `/events/${routeSegment(eventId)}/assets/${routeSegment(assetId)}/download`,
        { method: "POST" },
      );
    },

    async getTaskForm(input) {
      return request<PortalTaskForm>(
        `${taskRoute(input)}/form`,
        input.signal === undefined ? undefined : { signal: input.signal },
      );
    },

    async getTaskResponse(input) {
      return request<PortalTaskResponseEnvelope>(
        `${taskRoute(input)}/responses`,
        input.signal === undefined ? undefined : { signal: input.signal },
      );
    },

    async saveTaskResponse(input) {
      return request<PortalTaskResponseEnvelope>(`${taskRoute(input)}/responses`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          definitionVersion: input.definitionVersion,
          expectedVersion: input.expectedVersion,
          answers: input.answers,
        }),
      });
    },

    async listResources(eventId, signal) {
      return request<PortalResource[]>(
        `/events/${routeSegment(eventId)}/resources`,
        signal === undefined ? undefined : { signal },
      );
    },

    async listWiki(eventId, signal) {
      return request<PortalWikiPage[]>(
        `/events/${routeSegment(eventId)}/wiki`,
        signal === undefined ? undefined : { signal },
      );
    },
  };

  return api;
}
