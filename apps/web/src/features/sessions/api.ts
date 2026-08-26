export type SessionContentStatus = "Approved" | "Needs changes";

export interface SessionSpeakerReference {
  readonly id: string;
  readonly displayName?: string;
  readonly role?: string;
}

export interface SessionSpeakerCandidate {
  readonly id: string;
  readonly displayName: string;
  readonly jobTitle?: string;
  readonly company?: string;
}
export interface SessionTaxonomyOption {
  readonly id: string;
  readonly name: string;
}
export type SessionTrackOption = SessionTaxonomyOption;
export type SessionFormatOption = SessionTaxonomyOption;

export interface SessionRecord {
  readonly id: string;
  readonly eventId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly contentStatus?: SessionContentStatus;
  readonly durationMinutes: number;
  readonly trackIds: readonly string[];
  readonly formatId?: string;
  readonly speakerIds: readonly string[];
  readonly speakerRoster: readonly SessionSpeakerReference[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface SessionHistoryEntry {
  readonly id: string;
  readonly action: "created" | "updated" | "deleted" | "restored" | "approved" | "needs_changes";
  readonly version: number;
  readonly actorId: string;
  readonly actorLabel?: string;
  readonly occurredAt: string;
  readonly title?: string;
  readonly description?: string;
  readonly contentStatus?: SessionContentStatus;
  readonly snapshot?: {
    readonly title: string;
    readonly description: string;
    readonly contentStatus?: SessionContentStatus;
  };
}

export interface SessionsApi {
  list(signal?: AbortSignal): Promise<readonly SessionRecord[]>;
  get(sessionId: string, signal?: AbortSignal): Promise<SessionRecord>;
  updateContent(input: {
    readonly sessionId: string;
    readonly expectedVersion: number;
    readonly title?: string;
    readonly description?: string;
    readonly contentStatus?: SessionContentStatus;
    readonly trackIds?: readonly string[];
    readonly formatId?: string | null;
    readonly durationMinutes?: number;
  }): Promise<SessionRecord>;
  listTracks(signal?: AbortSignal): Promise<readonly SessionTrackOption[]>;
  listFormats(signal?: AbortSignal): Promise<readonly SessionFormatOption[]>;
  listSpeakers(signal?: AbortSignal): Promise<readonly SessionSpeakerCandidate[]>;
  updateSpeakers(input: {
    readonly sessionId: string;
    readonly expectedVersion: number;
    readonly speakerIds: readonly string[];
    readonly speakerRoster: readonly SessionSpeakerReference[];
  }): Promise<SessionRecord>;
  listHistory(sessionId: string, signal?: AbortSignal): Promise<readonly SessionHistoryEntry[]>;
  restoreVersion(input: {
    readonly sessionId: string;
    readonly version: number;
    readonly expectedVersion: number;
  }): Promise<SessionRecord>;
}

export class SessionsApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly traceId: string | undefined;

  constructor(code: string, message: string, status: number, traceId?: string) {
    super(message);
    this.name = "SessionsApiError";
    this.code = code;
    this.status = status;
    this.traceId = traceId;
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && Object.hasOwn(value, "data") ? value.data : value;
}

function contentStatusFrom(value: unknown): SessionContentStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "Approved" || value === "Needs changes") return value;
  throw new TypeError("The session response contains an invalid content status.");
}

function stringArrayFrom(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`The session response contains an invalid ${field}.`);
  }
  const values = value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new TypeError(`The session response contains an invalid ${field}.`);
    }
    return item;
  });
  if (new Set(values).size !== values.length) {
    throw new TypeError(`The session response contains duplicate ${field}.`);
  }
  return values;
}

function speakerReferenceFrom(value: unknown): SessionSpeakerReference {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new TypeError("The session response contains an invalid speaker roster.");
  }
  if (
    (value.displayName !== undefined &&
      (typeof value.displayName !== "string" || value.displayName.trim().length === 0)) ||
    (value.role !== undefined && (typeof value.role !== "string" || value.role.trim().length === 0))
  ) {
    throw new TypeError("The session response contains an invalid speaker roster.");
  }
  return {
    id: value.id,
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
    ...(typeof value.role === "string" ? { role: value.role } : {}),
  };
}

function sessionFrom(value: unknown, eventId: string): SessionRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    value.eventId !== eventId ||
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    typeof value.status !== "string" ||
    typeof value.durationMinutes !== "number" ||
    !Number.isSafeInteger(value.durationMinutes) ||
    value.durationMinutes < 1 ||
    value.durationMinutes > 1_440 ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.updatedBy !== "string"
  ) {
    throw new TypeError("The session response does not match the requested event.");
  }

  const contentStatus = contentStatusFrom(value.contentStatus);
  const trackIds = stringArrayFrom(value.trackIds, "track IDs");
  const formatId =
    value.formatId === undefined
      ? undefined
      : typeof value.formatId === "string" && value.formatId.trim().length > 0
        ? value.formatId
        : (() => {
            throw new TypeError("The session response contains an invalid format ID.");
          })();
  const speakerIds = stringArrayFrom(value.speakerIds, "speaker IDs");
  const speakerIdSet = new Set(speakerIds);
  if (!Array.isArray(value.speakerRoster)) {
    throw new TypeError("The session response contains an invalid speaker roster.");
  }
  const speakerRoster = value.speakerRoster.map(speakerReferenceFrom);
  if (new Set(speakerRoster.map((reference) => reference.id)).size !== speakerRoster.length) {
    throw new TypeError("The session response contains duplicate speaker roster entries.");
  }
  if (speakerRoster.some((reference) => !speakerIdSet.has(reference.id))) {
    throw new TypeError("The session response contains a speaker roster outside its speaker IDs.");
  }
  return {
    id: value.id,
    eventId,
    title: value.title,
    description: value.description,
    status: value.status,
    ...(contentStatus === undefined ? {} : { contentStatus }),
    durationMinutes: value.durationMinutes,
    trackIds,
    ...(formatId === undefined ? {} : { formatId }),
    speakerIds,
    speakerRoster,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy,
  };
}

function historyFrom(value: unknown): SessionHistoryEntry {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.action !== "string" ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.actorId !== "string" ||
    typeof value.occurredAt !== "string"
  ) {
    throw new TypeError("The session history response is invalid.");
  }

  const actions = new Set<SessionHistoryEntry["action"]>([
    "created",
    "updated",
    "deleted",
    "restored",
    "approved",
    "needs_changes",
  ]);
  if (!actions.has(value.action as SessionHistoryEntry["action"])) {
    throw new TypeError("The session history response contains an invalid action.");
  }
  const actorLabel =
    typeof value.actorLabel === "string" &&
    value.actorLabel.trim().length > 0 &&
    value.actorLabel.trim() !== value.actorId &&
    !value.actorLabel.includes("@")
      ? value.actorLabel.trim()
      : "Authorized organizer";

  const contentStatus = contentStatusFrom(value.contentStatus);
  let snapshot: SessionHistoryEntry["snapshot"];
  if (
    isRecord(value.snapshot) &&
    typeof value.snapshot.title === "string" &&
    typeof value.snapshot.description === "string"
  ) {
    const snapshotContentStatus = contentStatusFrom(value.snapshot.contentStatus);
    snapshot = {
      title: value.snapshot.title,
      description: value.snapshot.description,
      ...(snapshotContentStatus === undefined ? {} : { contentStatus: snapshotContentStatus }),
    };
  }

  return {
    id: value.id,
    action: value.action as SessionHistoryEntry["action"],
    version: value.version,
    actorId: value.actorId,
    actorLabel,
    occurredAt: value.occurredAt,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(contentStatus === undefined ? {} : { contentStatus }),
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}

function speakerCandidateFrom(value: unknown): SessionSpeakerCandidate {
  if (
    !isRecord(value) ||
    typeof value.participantId !== "string" ||
    value.participantId.trim().length === 0 ||
    typeof value.displayName !== "string" ||
    value.displayName.trim().length === 0 ||
    (value.jobTitle !== undefined && typeof value.jobTitle !== "string") ||
    (value.company !== undefined && typeof value.company !== "string")
  ) {
    throw new TypeError("The speaker roster response contains an invalid speaker.");
  }
  return {
    id: value.participantId,
    displayName: value.displayName,
    ...(typeof value.jobTitle === "string" && value.jobTitle.trim().length > 0
      ? { jobTitle: value.jobTitle }
      : {}),
    ...(typeof value.company === "string" && value.company.trim().length > 0
      ? { company: value.company }
      : {}),
  };
}
function taxonomyOptionFrom(value: unknown, eventId: string): SessionTaxonomyOption {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    value.eventId !== eventId ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0
  ) {
    throw new TypeError("The session taxonomy response does not match the requested event.");
  }
  return { id: value.id, name: value.name };
}

function taxonomyOptionsFrom(value: unknown, eventId: string): readonly SessionTaxonomyOption[] {
  if (!Array.isArray(value)) throw new TypeError("The session taxonomy response is invalid.");
  const options = value.map((item) => taxonomyOptionFrom(item, eventId));
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new TypeError("The session taxonomy response contains duplicate resources.");
  }
  return options;
}

async function errorFrom(response: Response): Promise<SessionsApiError> {
  const body = await response.json().catch(() => undefined);
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  return new SessionsApiError(
    typeof error?.code === "string" ? error.code : "SESSION_REQUEST_FAILED",
    typeof error?.message === "string"
      ? error.message
      : "The session request could not be completed.",
    response.status,
    typeof error?.traceId === "string" ? error.traceId : undefined,
  );
}

export function createSessionsApi(
  baseUrl: string,
  organizationId: string,
  eventId: string,
  fetcher: Fetcher = fetch,
): SessionsApi {
  const organizationScope = organizationId.trim();
  const eventScope = eventId.trim();
  if (organizationScope.length === 0) {
    throw new TypeError("An organization ID is required for session requests.");
  }
  if (eventScope.length === 0) {
    throw new TypeError("An event ID is required for session requests.");
  }

  const eventApiBase = `${baseUrl.trim().replace(/\/+$/u, "")}/api/admin/organizations/${segment(organizationScope)}/events/${segment(eventScope)}`;
  const apiBase = `${eventApiBase}/sessions`;

  async function requestAt<T>(base: string, path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      cache: "no-store",
      credentials: "include",
      headers: { accept: "application/json", ...init?.headers },
    });
    if (!response.ok) throw await errorFrom(response);
    return unwrapData(await response.json()) as T;
  }

  function request<T>(path: string, init?: RequestInit): Promise<T> {
    return requestAt<T>(apiBase, path, init);
  }

  return {
    async list(signal) {
      const value = await request<unknown>("", signal === undefined ? undefined : { signal });
      if (!Array.isArray(value)) throw new TypeError("The sessions list response is invalid.");
      return value.map((session) => sessionFrom(session, eventScope));
    },

    async get(sessionId, signal) {
      return sessionFrom(
        await request<unknown>(
          `/${segment(sessionId)}`,
          signal === undefined ? undefined : { signal },
        ),
        eventScope,
      );
    },

    async updateContent(input) {
      const payload: Record<string, unknown> = { expectedVersion: input.expectedVersion };
      if (input.title !== undefined) payload.title = input.title;
      if (input.description !== undefined) payload.description = input.description;
      if (input.contentStatus !== undefined) payload.contentStatus = input.contentStatus;
      if (input.trackIds !== undefined) payload.trackIds = input.trackIds;
      if (input.formatId !== undefined) payload.formatId = input.formatId;
      if (input.durationMinutes !== undefined) payload.durationMinutes = input.durationMinutes;

      return sessionFrom(
        await request<unknown>(`/${segment(input.sessionId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        eventScope,
      );
    },

    async listSpeakers(signal) {
      const value = await requestAt<unknown>(
        eventApiBase,
        "/speakers",
        signal === undefined ? undefined : { signal },
      );
      if (
        !isRecord(value) ||
        value.organizationId !== organizationScope ||
        value.eventId !== eventScope ||
        !Array.isArray(value.speakers)
      ) {
        throw new TypeError("The speaker roster response does not match the requested event.");
      }
      const speakers = value.speakers.map(speakerCandidateFrom);
      if (new Set(speakers.map((speaker) => speaker.id)).size !== speakers.length) {
        throw new TypeError("The speaker roster response contains duplicate speakers.");
      }
      return speakers;
    },
    async listTracks(signal) {
      return taxonomyOptionsFrom(
        await requestAt<unknown>(
          eventApiBase,
          "/sessions/tracks",
          signal === undefined ? undefined : { signal },
        ),
        eventScope,
      );
    },

    async listFormats(signal) {
      return taxonomyOptionsFrom(
        await requestAt<unknown>(
          eventApiBase,
          "/sessions/formats",
          signal === undefined ? undefined : { signal },
        ),
        eventScope,
      );
    },

    async updateSpeakers(input) {
      return sessionFrom(
        await request<unknown>(`/${segment(input.sessionId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: input.expectedVersion,
            speakerIds: input.speakerIds,
            speakerRoster: input.speakerRoster,
          }),
        }),
        eventScope,
      );
    },

    async listHistory(sessionId, signal) {
      const value = await request<unknown>(
        `/${segment(sessionId)}/history`,
        signal === undefined ? undefined : { signal },
      );
      if (!Array.isArray(value)) throw new TypeError("The session history response is invalid.");
      return value.map(historyFrom);
    },

    async restoreVersion(input) {
      return sessionFrom(
        await request<unknown>(`/${segment(input.sessionId)}/restore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: input.version,
            expectedVersion: input.expectedVersion,
          }),
        }),
        eventScope,
      );
    },
  };
}
