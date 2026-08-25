import type { AgendaCatalogSynchronizerContract } from "../agenda/catalog-sync";
import type {
  CreateRoomInput,
  CreateSessionInput,
  CreateTaxonomyInput,
  DecisionSessionStatusReconciliationInput,
  DecisionVersionFence,
  Format,
  Level,
  PublishedSessionContentHandoff,
  RestoreSessionInput,
  Room,
  Session,
  SessionActor,
  SessionAuditEntry,
  SessionContentSnapshot,
  SessionContentStatus,
  SessionHistoryEntry,
  SessionListPage,
  SessionListQuery,
  SessionRepository,
  SessionRepositorySeed,
  SessionSettings,
  SessionSpeakerReference,
  Tag,
  Track,
  UpdateRoomInput,
  UpdateSessionInput,
  UpdateSessionSettingsInput,
  UpdateTaxonomyInput,
} from "./types";
import {
  defaultAgendaEligibleStatuses,
  defaultSessionStatuses,
  SessionRepositoryConflictError,
} from "./types";

export type SessionServiceErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "VERSION_CONFLICT"
  | "CONFLICT";

export class SessionServiceError extends Error {
  constructor(
    readonly code: SessionServiceErrorCode,
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly details?: readonly { path: readonly (string | number)[]; message: string }[],
  ) {
    super(message);
    this.name = "SessionServiceError";
  }
}

export interface SessionServiceOptions {
  clock?: () => Date;
  now?: () => Date;
  generateId?: () => string;
  idGenerator?: () => string;
  agendaCatalogSynchronizer?: AgendaCatalogSynchronizerContract;
}

export interface AcceptedSessionProjectionInput {
  readonly session: Session;
  readonly actorId: string;
  readonly decisionFence?: DecisionVersionFence | undefined;
  readonly beforePersist?: () => Promise<boolean>;
}
type SessionListItem = Omit<Session, "history">;
type SessionListPageProjection = Omit<SessionListPage, "items"> & {
  readonly items: readonly SessionListItem[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(tenantId: string, eventId: string, id: string): string {
  return `${tenantId}\u0000${eventId}\u0000${id}`;
}

function eventKey(tenantId: string, eventId: string): string {
  return `${tenantId}\u0000${eventId}`;
}

function requiredText(value: unknown, field: string, maximum = 128): string {
  if (typeof value !== "string") {
    throw new SessionServiceError("VALIDATION_ERROR", 400, `${field} is required.`);
  }
  const normalized = value.trim().normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a
      );
    })
  ) {
    throw new SessionServiceError(
      "VALIDATION_ERROR",
      400,
      `${field} must contain between 1 and ${maximum} valid characters.`,
    );
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maximum: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new SessionServiceError("VALIDATION_ERROR", 400, `${field} must be text.`);
  }
  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (
    normalized.length > maximum ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a
      );
    })
  ) {
    throw new SessionServiceError(
      "VALIDATION_ERROR",
      400,
      `${field} must contain at most ${maximum} valid characters.`,
    );
  }
  return normalized;
}

function resourceId(value: unknown, field: string): string {
  return requiredText(value, field, 128);
}

function uniqueIds(values: readonly string[] | undefined, field: string, maximum = 100): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > maximum) {
    throw new SessionServiceError("VALIDATION_ERROR", 400, `${field} contains too many values.`);
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = requiredText(value, `${field} entry`);
    if (seen.has(normalized)) {
      throw new SessionServiceError(
        "VALIDATION_ERROR",
        400,
        `${field} cannot contain duplicate values.`,
      );
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SessionServiceError(
      "VALIDATION_ERROR",
      400,
      "expectedVersion must be a positive integer.",
    );
  }
  return value as number;
}

function duration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_440) {
    throw new SessionServiceError(
      "VALIDATION_ERROR",
      400,
      "durationMinutes must be a positive integer of at most 1440 minutes.",
    );
  }
  return value as number;
}

function capacity(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
    throw new SessionServiceError(
      "VALIDATION_ERROR",
      400,
      "capacity must be a non-negative integer of at most 1000000.",
    );
  }
  return value as number;
}
function roomCapacity(value: unknown): number {
  const normalized = capacity(value);
  if (normalized < 1) {
    throw new SessionServiceError("VALIDATION_ERROR", 400, "room capacity must be at least 1.");
  }
  return normalized;
}

function status(value: unknown): string {
  return requiredText(value, "status", 64);
}

function contentReviewStatus(value: unknown): SessionContentStatus {
  if (value === "Approved" || value === "Needs changes") return value;
  throw new SessionServiceError(
    "VALIDATION_ERROR",
    400,
    "contentStatus must be Approved or Needs changes.",
  );
}

function normaliseStatusSet(values: readonly string[] | undefined, field: string): string[] {
  const result = uniqueIds(values, field, 64);
  if (result.length === 0) {
    throw new SessionServiceError("VALIDATION_ERROR", 400, `${field} must not be empty.`);
  }
  return result;
}

function sameStatus(left: string, right: string): boolean {
  return (
    left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0 ||
    left.toLowerCase() === right.toLowerCase()
  );
}

function hasStatus(statusValue: string, statuses: readonly string[]): boolean {
  return statuses.some((candidate) => sameStatus(candidate, statusValue));
}

function assertIsoInstant(value: Date | string): string {
  const parsed = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (!Number.isFinite(parsed)) {
    throw new SessionServiceError("VALIDATION_ERROR", 400, "The clock must return an ISO instant.");
  }
  return new Date(parsed).toISOString();
}

function normalizeRoster(
  speakerIds: readonly string[] | undefined,
  speakerRoster: readonly SessionSpeakerReference[] | undefined,
): { speakerIds: string[]; speakerRoster: SessionSpeakerReference[] } {
  const fromIds = uniqueIds(speakerIds, "speakerIds", 50);
  if (speakerRoster !== undefined) {
    if (!Array.isArray(speakerRoster) || speakerRoster.length > 50) {
      throw new SessionServiceError(
        "VALIDATION_ERROR",
        400,
        "speakerRoster contains too many values.",
      );
    }
  }
  const refs = new Map<string, SessionSpeakerReference>();
  for (const id of fromIds) refs.set(id, { id });
  for (const reference of speakerRoster ?? []) {
    if (typeof reference !== "object" || reference === null) {
      throw new SessionServiceError(
        "VALIDATION_ERROR",
        400,
        "Each speaker roster entry must be an object.",
      );
    }
    const id = resourceId(reference.id, "speakerRoster id");
    const existing = refs.get(id);
    const role =
      reference.role === undefined
        ? existing?.role
        : optionalText(reference.role, "speakerRoster role", 64);
    const displayName =
      reference.displayName === undefined
        ? existing?.displayName
        : optionalText(reference.displayName, "speakerRoster displayName", 200);
    refs.set(id, {
      id,
      ...(role === undefined ? {} : { role }),
      ...(displayName === undefined ? {} : { displayName }),
    });
  }
  return { speakerIds: [...refs.keys()], speakerRoster: [...refs.values()] };
}
function sessionSpeakerNames(session: Session): string[] {
  const rosterNames = new Map(
    session.speakerRoster.flatMap((reference) => {
      const displayName = reference.displayName?.trim();
      return displayName ? [[reference.id, displayName] as const] : [];
    }),
  );
  const storedNames = Array.isArray((session as Session & { speakerNames?: unknown }).speakerNames)
    ? (session as Session & { speakerNames: unknown[] }).speakerNames.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  return session.speakerIds.map((participantId, index) => {
    const rosterName = rosterNames.get(participantId);
    if (rosterName !== undefined && rosterName !== participantId) return rosterName;
    const storedName = storedNames[index]?.trim();
    return storedName && storedName !== participantId ? storedName : "Speaker";
  });
}

function normalizeResources(
  resources: readonly string[] | undefined,
  resourceIds: readonly string[] | undefined,
  field = "resources",
): string[] {
  const first = resources ?? resourceIds;
  const second = resources !== undefined && resourceIds !== undefined ? resourceIds : [];
  const values = [...(first ?? []), ...second];
  return uniqueIds(values, field, 100);
}

interface NormalizedRoomInput {
  readonly name: string;
  readonly capacity: number;
  readonly resources: readonly string[];
}

function normalizeRoomInput(input: CreateRoomInput): NormalizedRoomInput {
  return {
    name: requiredText(input.name, "name", 200),
    capacity: roomCapacity(input.capacity),
    resources: normalizeResources(input.resources, input.resourceIds),
  };
}

function roomMatchesInput(room: Room, input: CreateRoomInput): boolean {
  const normalized = normalizeRoomInput(input);
  const resources = room.resources?.length ? room.resources : (room.resourceIds ?? []);
  return (
    room.name === normalized.name &&
    room.capacity === normalized.capacity &&
    resources.length === normalized.resources.length &&
    resources.every((resource, index) => resource === normalized.resources[index])
  );
}

type SessionContentHistory = Partial<
  Pick<
    SessionHistoryEntry,
    | "actorLabel"
    | "title"
    | "description"
    | "contentStatus"
    | "priorStatus"
    | "newStatus"
    | "priorContentStatus"
    | "newContentStatus"
    | "snapshot"
  >
>;

function sessionContentStatus(session: Session): SessionContentStatus | undefined {
  return session.contentStatus;
}

function sessionIsPubliclyApproved(session: Session): boolean {
  return sessionContentStatus(session) === "Approved";
}

function actorLabel(actor: SessionActor): string {
  return actor.kind === "automation" ? "Eventloom automation" : "Authorized organizer";
}

function persistedActorLabel(actorId: string | undefined, value: unknown): string {
  const label = typeof value === "string" ? value.trim() : "";
  return label && label !== actorId && !label.includes("@") ? label : "Authorized organizer";
}

function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeAuditValue(entry));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const actorId = typeof source.actorId === "string" ? source.actorId : undefined;
  return Object.fromEntries(
    Object.entries(source).map(([key, entry]) => [
      key,
      key === "actorLabel" ? persistedActorLabel(actorId, entry) : sanitizeAuditValue(entry),
    ]),
  );
}

function sanitizeAuditEntry(entry: SessionAuditEntry): SessionAuditEntry {
  return {
    ...clone(entry),
    ...(entry.before === undefined ? {} : { before: sanitizeAuditValue(entry.before) }),
    ...(entry.after === undefined ? {} : { after: sanitizeAuditValue(entry.after) }),
  };
}

function historyEntry(
  id: string,
  action: SessionHistoryEntry["action"],
  version: number,
  actorId: string,
  occurredAt: string,
  content?: SessionContentHistory,
): SessionHistoryEntry {
  return {
    id,
    action,
    version,
    actorId,
    occurredAt,
    ...(content === undefined ? {} : content),
  } as SessionHistoryEntry;
}
function sessionContentSnapshot(session: Session): SessionContentSnapshot {
  const contentStatus = sessionContentStatus(session);
  return {
    id: session.id,
    tenantId: session.tenantId,
    eventId: session.eventId,
    title: session.title,
    description: session.description,
    status: session.status,
    ...(contentStatus === undefined ? {} : { contentStatus }),
    durationMinutes: session.durationMinutes,
    capacityRequired: session.capacityRequired,
    ...(session.roomId === undefined ? {} : { roomId: session.roomId }),
    ...(session.trackId === undefined ? {} : { trackId: session.trackId }),
    trackIds: [...session.trackIds],
    ...(session.formatId === undefined ? {} : { formatId: session.formatId }),
    ...(session.levelId === undefined ? {} : { levelId: session.levelId }),
    tagIds: [...session.tagIds],
    speakerIds: [...session.speakerIds],
    speakerRoster: session.speakerRoster.map((reference) => ({ ...reference })),
    resourceIds: [...session.resourceIds],
  };
}

function orderedSessionHistory(history: readonly SessionHistoryEntry[]): SessionHistoryEntry[] {
  return [...history]
    .map((entry) => {
      return {
        ...clone(entry),
        actorLabel: persistedActorLabel(entry.actorId, entry.actorLabel),
      };
    })
    .sort(
      (left, right) =>
        left.version - right.version ||
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.id.localeCompare(right.id),
    );
}

function sessionProjection(session: Session): Session {
  return {
    ...clone(session),
    history: orderedSessionHistory(session.history),
  };
}
function sessionListProjection(session: Session): SessionListItem {
  const { history: _history, ...projection } = session;
  return clone(projection);
}

function auditEntry(
  id: string,
  tenantId: string,
  eventId: string,
  entityType: SessionAuditEntry["entityType"],
  entityId: string,
  action: SessionAuditEntry["action"],
  version: number,
  actorId: string,
  occurredAt: string,
  before: unknown,
  after: unknown,
): SessionAuditEntry {
  return {
    id,
    tenantId,
    eventId,
    entityType,
    entityId,
    action,
    version,
    actorId,
    occurredAt,
    ...(before === undefined ? {} : { before: clone(before) }),
    ...(after === undefined ? {} : { after: clone(after) }),
  };
}
function acceptedSessionFieldsEqual(left: Session, right: Session): boolean {
  return (
    left.id === right.id &&
    left.tenantId === right.tenantId &&
    left.eventId === right.eventId &&
    left.title === right.title &&
    left.description === right.description &&
    left.status === right.status &&
    sessionContentStatus(left) === sessionContentStatus(right) &&
    left.durationMinutes === right.durationMinutes &&
    left.capacityRequired === right.capacityRequired &&
    left.roomId === right.roomId &&
    left.trackId === right.trackId &&
    JSON.stringify(left.trackIds) === JSON.stringify(right.trackIds) &&
    left.formatId === right.formatId &&
    left.levelId === right.levelId &&
    JSON.stringify(left.tagIds) === JSON.stringify(right.tagIds) &&
    JSON.stringify(left.speakerIds) === JSON.stringify(right.speakerIds) &&
    JSON.stringify(left.speakerRoster) === JSON.stringify(right.speakerRoster) &&
    JSON.stringify(left.resourceIds) === JSON.stringify(right.resourceIds)
  );
}

function repositoryConflict(error: unknown): boolean {
  return (
    error instanceof SessionRepositoryConflictError ||
    (error instanceof Error && error.name === "SessionRepositoryConflictError")
  );
}

function notFound(resource: string): SessionServiceError {
  return new SessionServiceError("NOT_FOUND", 404, `The ${resource} was not found.`);
}

function conflict(message: string): SessionServiceError {
  return new SessionServiceError("CONFLICT", 409, message);
}

function versionConflict(resource: string): SessionServiceError {
  return new SessionServiceError(
    "VERSION_CONFLICT",
    409,
    `The ${resource} changed. Reload it before saving.`,
  );
}

function forbidden(message = "An organizer or administrator is required."): SessionServiceError {
  return new SessionServiceError("FORBIDDEN", 403, message);
}

export class SessionService {
  readonly #repository: SessionRepository;
  readonly #clock: () => Date;
  readonly #generateId: () => string;
  readonly #agendaCatalogSynchronizer: AgendaCatalogSynchronizerContract | undefined;

  constructor(repository: SessionRepository, options: SessionServiceOptions = {}) {
    this.#repository = repository;
    this.#clock = options.clock ?? options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? options.idGenerator ?? (() => crypto.randomUUID());
    this.#agendaCatalogSynchronizer = options.agendaCatalogSynchronizer;
  }
  /**
   * Projects an accepted submission into the canonical session catalog.
   *
   * This is intentionally separate from organizer CRUD: the evaluation handoff is trusted to
   * provide a fully scoped session projection, while this method owns optimistic persistence,
   * audit history, and agenda-catalog synchronization.
   */
  async upsertAcceptedSession(input: AcceptedSessionProjectionInput): Promise<Session> {
    const projected = input.session;
    const tenantId = resourceId(projected.tenantId, "tenant id");
    const eventId = this.event(projected.eventId);
    const sessionId = resourceId(projected.id, "session id");
    const actorId = requiredText(input.actorId, "actor id", 200);
    if (!sameStatus(projected.status, "Accepted")) {
      throw new SessionServiceError(
        "VALIDATION_ERROR",
        400,
        "Accepted session projections must use Accepted status.",
      );
    }
    const title = requiredText(projected.title, "title", 300);
    const description = optionalText(projected.description, "description", 20_000);
    const durationMinutes = duration(projected.durationMinutes);
    const capacityRequired = capacity(projected.capacityRequired);
    const roomId =
      projected.roomId === undefined ? undefined : resourceId(projected.roomId, "room id");
    const trackIds = uniqueIds(projected.trackIds, "trackIds", 20);
    const formatId =
      projected.formatId === undefined ? undefined : resourceId(projected.formatId, "format id");
    const levelId =
      projected.levelId === undefined ? undefined : resourceId(projected.levelId, "level id");
    const tagIds = uniqueIds(projected.tagIds, "tagIds", 50);
    const roster = normalizeRoster(projected.speakerIds, projected.speakerRoster);
    const resourceIds = uniqueIds(projected.resourceIds, "resourceIds", 100);
    const createdAt = assertIsoInstant(projected.createdAt);
    const updatedAt = assertIsoInstant(projected.updatedAt);
    const settings = await this.ensureSettings(tenantId, eventId, actorId);
    const acceptedStatus =
      settings.statuses.find((status) => sameStatus(status, "Accepted")) ??
      settings.agendaEligibleStatuses[0];
    if (acceptedStatus === undefined) {
      throw new SessionServiceError(
        "VALIDATION_ERROR",
        400,
        "Session settings must define an agenda-eligible status for accepted submissions.",
      );
    }
    this.assertConfiguredStatus(acceptedStatus, settings);
    const projectionActor: SessionActor = {
      tenantId,
      userId: actorId,
      role: "organizer",
      kind: "user",
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.#repository.getSession(tenantId, eventId, sessionId);
      const priorContentStatus = current === null ? undefined : sessionContentStatus(current);
      const desiredContentStatus = priorContentStatus ?? "Approved";
      const desired: Session = {
        id: sessionId,
        tenantId,
        eventId,
        title,
        description,
        status: acceptedStatus,
        durationMinutes,
        capacityRequired,
        ...(roomId === undefined ? {} : { roomId }),
        ...(trackIds[0] === undefined ? {} : { trackId: trackIds[0] }),
        trackIds,
        ...(formatId === undefined ? {} : { formatId }),
        ...(levelId === undefined ? {} : { levelId }),
        tagIds,
        speakerIds: roster.speakerIds,
        speakerRoster: roster.speakerRoster,
        resourceIds,
        contentStatus: desiredContentStatus,
        version: current?.version ?? 1,
        createdAt: current?.createdAt ?? createdAt,
        updatedAt,
        createdBy: current?.createdBy ?? actorId,
        updatedBy: actorId,
        history: current === null ? [] : orderedSessionHistory(current.history),
      };
      if (current !== null && acceptedSessionFieldsEqual(current, desired)) {
        if (input.beforePersist !== undefined && !(await input.beforePersist())) {
          throw conflict("accepted session decision");
        }
        await this.synchronizeAgenda(projectionActor, eventId);
        return sessionProjection(current);
      }

      const nextVersion = current?.version === undefined ? 1 : current.version + 1;
      const auditId = `${sessionId}:v${nextVersion}`;
      const next: Session = {
        ...desired,
        version: nextVersion,
        history: [
          ...(current === null ? [] : orderedSessionHistory(current.history)),
          historyEntry(
            auditId,
            current === null ? "created" : "updated",
            nextVersion,
            actorId,
            updatedAt,
            {
              title,
              description,
              actorLabel: actorLabel(projectionActor),
              contentStatus: desiredContentStatus,
              ...(current === null ? {} : { priorStatus: current.status }),
              newStatus: desired.status,
              ...(priorContentStatus === undefined ? {} : { priorContentStatus }),
              newContentStatus: desiredContentStatus,
              snapshot: sessionContentSnapshot(desired),
            },
          ),
        ],
      };
      const audit = auditEntry(
        auditId,
        tenantId,
        eventId,
        "session",
        sessionId,
        current === null ? "created" : "updated",
        nextVersion,
        actorId,
        updatedAt,
        current === null ? undefined : current,
        next,
      );
      try {
        if (input.beforePersist !== undefined && !(await input.beforePersist())) {
          throw conflict("accepted session decision");
        }
        if (this.#repository.commit !== undefined) {
          await this.#repository.commit({
            operation: "putSession",
            value: next,
            expectedVersion: current?.version ?? null,
            audit,
            ...(input.decisionFence === undefined ? {} : { decisionFence: input.decisionFence }),
          });
        } else {
          if (input.beforePersist !== undefined && !(await input.beforePersist())) {
            throw conflict("accepted session decision");
          }
          await this.#repository.putSession(next, current?.version ?? null, input.decisionFence);
          await this.recordAudit(audit);
        }
      } catch (error) {
        if (repositoryConflict(error)) {
          if (attempt < 2) continue;
          throw versionConflict("accepted session");
        }
        throw error;
      }
      await this.synchronizeAgenda(projectionActor, eventId);
      return sessionProjection(next);
    }
    throw versionConflict("accepted session");
  }

  async reconcileDecisionSessionStatus(
    input: DecisionSessionStatusReconciliationInput,
  ): Promise<Session | null> {
    const current = await this.#repository.getSession(
      input.tenantId,
      this.event(input.eventId),
      resourceId(input.sessionId, "session id"),
    );
    if (current === null) return null;
    const settings = await this.#repository.getSettings(input.tenantId, input.eventId);
    const targetStatus = settings?.statuses.find((candidate) =>
      sameStatus(candidate, input.status),
    );
    const effectiveTargetStatus = targetStatus ?? "Draft";
    const actor: SessionActor = {
      tenantId: input.tenantId,
      userId: input.actorId,
      kind: "user",
      isOrganizer: true,
      grants: [{ eventId: input.eventId, role: "organizer" }],
    };
    if (sameStatus(current.status, effectiveTargetStatus)) {
      if (input.isCurrentDecision !== undefined && !(await input.isCurrentDecision())) {
        return current;
      }
      await this.synchronizeAgenda(actor, input.eventId);
      return current;
    }
    return this.updateSession(actor, {
      tenantId: input.tenantId,
      eventId: input.eventId,
      sessionId: current.id,
      expectedVersion: current.version,
      status: effectiveTargetStatus,
      beforePersist: input.isCurrentDecision,
      decisionFence: input.decisionFence,
    });
  }

  async createSession(actor: SessionActor, input: CreateSessionInput): Promise<Session> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const id = input.id === undefined ? this.#generateId() : resourceId(input.id, "session id");
    if (await this.#repository.getSession(actor.tenantId, eventId, id)) {
      throw conflict("A session with this id already exists.");
    }
    const settings = await this.ensureSettings(actor.tenantId, eventId, actor.userId);
    const sessionStatus = input.status === undefined ? "Draft" : status(input.status);
    this.assertConfiguredStatus(sessionStatus, settings);
    const initialContentStatus = sameStatus(sessionStatus, "Accepted")
      ? "Needs changes"
      : undefined;
    const now = this.instant();
    const auditId = this.#generateId();
    const normalized = await this.normalizeSessionReferences(actor.tenantId, eventId, input);
    const sessionBase: Session = {
      id,
      tenantId: actor.tenantId,
      eventId,
      title: requiredText(input.title, "title", 300),
      description: optionalText(input.description, "description", 20_000),
      status: sessionStatus,
      durationMinutes: duration(input.durationMinutes),
      capacityRequired: input.capacityRequired === undefined ? 0 : capacity(input.capacityRequired),
      ...(normalized.roomId === undefined ? {} : { roomId: normalized.roomId }),
      ...(normalized.trackIds[0] === undefined ? {} : { trackId: normalized.trackIds[0] }),
      trackIds: normalized.trackIds,
      ...(normalized.formatId === undefined ? {} : { formatId: normalized.formatId }),
      ...(normalized.levelId === undefined ? {} : { levelId: normalized.levelId }),
      tagIds: normalized.tagIds,
      speakerIds: normalized.speakerIds,
      speakerRoster: normalized.speakerRoster,
      resourceIds: normalized.resourceIds,
      ...(initialContentStatus === undefined ? {} : { contentStatus: initialContentStatus }),
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      history: [],
    };
    const session: Session = {
      ...sessionBase,
      history: [
        historyEntry(auditId, "created", 1, actor.userId, now, {
          title: sessionBase.title,
          description: sessionBase.description,
          actorLabel: actorLabel(actor),
          newStatus: sessionBase.status,
          ...(initialContentStatus === undefined ? {} : { contentStatus: initialContentStatus }),
          ...(initialContentStatus === undefined ? {} : { newContentStatus: initialContentStatus }),
          snapshot: sessionContentSnapshot(sessionBase),
        }),
      ],
    };
    const audit = auditEntry(
      auditId,
      actor.tenantId,
      eventId,
      "session",
      id,
      "created",
      1,
      actor.userId,
      now,
      undefined,
      session,
    );
    try {
      if (this.#repository.commit !== undefined) {
        await this.#repository.commit({
          operation: "putSession",
          value: session,
          expectedVersion: null,
          audit,
        });
      } else {
        await this.#repository.putSession(session, null);
        await this.recordAudit(audit);
      }
    } catch (error) {
      if (repositoryConflict(error)) throw conflict("A session with this id already exists.");
      throw error;
    }
    await this.synchronizeAgenda(actor, eventId);
    return sessionProjection(session);
  }

  async getSession(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; sessionId: string },
  ): Promise<Session> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const sessionId = resourceId(input.sessionId, "session id");
    const agendaInitialization = this.ensureAgendaInitialized(actor, eventId);
    const sessionRead = this.#repository.getSession(actor.tenantId, eventId, sessionId);
    const [session] = await Promise.all([sessionRead, agendaInitialization]);
    if (!session || !this.inScope(session, actor.tenantId, input.eventId))
      throw notFound("session");
    return sessionProjection(session);
  }
  async listSessionHistory(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; sessionId: string },
  ): Promise<readonly SessionHistoryEntry[]> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const sessionId = resourceId(input.sessionId, "session id");
    const session = await this.#repository.getSession(actor.tenantId, eventId, sessionId);
    if (session === null || !this.inScope(session, actor.tenantId, eventId)) {
      throw notFound("session");
    }
    return clone(orderedSessionHistory(session.history));
  }

  async getSessionHistory(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; sessionId: string },
  ): Promise<readonly SessionHistoryEntry[]> {
    return this.listSessionHistory(actor, input);
  }

  async restoreSessionVersion(actor: SessionActor, input: RestoreSessionInput): Promise<Session> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const sessionId = resourceId(input.sessionId, "session id");
    const expected = expectedVersion(input.expectedVersion);
    const targetVersion = expectedVersion(input.version);
    const current = await this.#repository.getSession(actor.tenantId, eventId, sessionId);
    if (current === null || !this.inScope(current, actor.tenantId, eventId)) {
      throw notFound("session");
    }
    if (current.version !== expected) throw versionConflict("session");
    const target = orderedSessionHistory(current.history).find(
      (entry) => entry.version === targetVersion,
    );
    const snapshot = target?.snapshot;
    if (
      snapshot === undefined ||
      snapshot.id !== sessionId ||
      snapshot.tenantId !== actor.tenantId ||
      snapshot.eventId !== eventId
    ) {
      throw notFound("session history");
    }

    const currentContentStatus = sessionContentStatus(current);
    if (
      current.title === snapshot.title &&
      current.description === snapshot.description &&
      currentContentStatus === "Needs changes"
    ) {
      return sessionProjection(current);
    }

    const now = this.instant();
    const auditId = this.#generateId();
    const nextVersion = current.version + 1;
    const restoredBase: Session = {
      ...current,
      title: snapshot.title,
      description: snapshot.description,
      contentStatus: "Needs changes",
      version: nextVersion,
      updatedAt: now,
      updatedBy: actor.userId,
      history: orderedSessionHistory(current.history),
    };
    const next: Session = {
      ...restoredBase,
      history: [
        ...restoredBase.history,
        historyEntry(auditId, "restored", nextVersion, actor.userId, now, {
          title: restoredBase.title,
          description: restoredBase.description,
          actorLabel: actorLabel(actor),
          priorStatus: current.status,
          newStatus: current.status,
          ...(currentContentStatus === undefined
            ? {}
            : { priorContentStatus: currentContentStatus }),
          contentStatus: "Needs changes",
          newContentStatus: "Needs changes",
          snapshot: sessionContentSnapshot(restoredBase),
        }),
      ],
    };
    const audit = auditEntry(
      auditId,
      actor.tenantId,
      eventId,
      "session",
      sessionId,
      "restored",
      nextVersion,
      actor.userId,
      now,
      current,
      next,
    );
    try {
      if (this.#repository.commit !== undefined) {
        await this.#repository.commit({
          operation: "putSession",
          value: next,
          expectedVersion: expected,
          audit,
        });
      } else {
        await this.#repository.putSession(next, expected);
        await this.recordAudit(audit);
      }
    } catch (error) {
      if (repositoryConflict(error)) throw versionConflict("session");
      throw error;
    }
    await this.synchronizeAgenda(actor, eventId);
    return sessionProjection(next);
  }

  async restoreSession(actor: SessionActor, input: RestoreSessionInput): Promise<Session> {
    return this.restoreSessionVersion(actor, input);
  }

  async listSessions(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string } & SessionListQuery,
  ): Promise<readonly SessionListItem[]> {
    return (await this.listSessionsPage(actor, input)).items;
  }

  async listSessionsPage(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string } & SessionListQuery,
  ): Promise<SessionListPageProjection> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const agendaInitialization = this.ensureAgendaInitialized(actor, eventId);
    const sessionsRead = this.#repository.listSessions(actor.tenantId, eventId);
    const settingsRead =
      input.agendaEligible === undefined ? null : this.readSettings(actor.tenantId, eventId);
    const [, sessionsResult, settings] = await Promise.all([
      agendaInitialization,
      sessionsRead,
      settingsRead,
    ]);
    let sessions = sessionsResult.filter((session) =>
      this.inScope(session, actor.tenantId, eventId),
    );
    const eligibleStatuses = settings?.agendaEligibleStatuses ?? defaultAgendaEligibleStatuses;
    const requestedStatuses =
      input.statuses ?? (input.status === undefined ? undefined : [input.status]);
    const search = input.search?.trim().toLocaleLowerCase();
    sessions = sessions.filter((session) => {
      if (
        requestedStatuses !== undefined &&
        !requestedStatuses.some((candidate) => sameStatus(candidate, session.status))
      )
        return false;
      if (input.roomId !== undefined && session.roomId !== input.roomId) return false;
      if (
        input.trackId !== undefined &&
        !session.trackIds.includes(input.trackId) &&
        session.trackId !== input.trackId
      )
        return false;
      if (input.formatId !== undefined && session.formatId !== input.formatId) return false;
      if (input.levelId !== undefined && session.levelId !== input.levelId) return false;
      if (input.tagId !== undefined && !session.tagIds.includes(input.tagId)) return false;
      if (input.speakerId !== undefined && !session.speakerIds.includes(input.speakerId))
        return false;
      if (
        search !== undefined &&
        search.length > 0 &&
        !`${session.title}\n${session.description}`.toLocaleLowerCase().includes(search)
      )
        return false;
      if (
        input.agendaEligible !== undefined &&
        (hasStatus(session.status, eligibleStatuses) && sessionIsPubliclyApproved(session)) !==
          input.agendaEligible
      )
        return false;
      return true;
    });
    const sortBy = input.sortBy ?? input.sort ?? "updatedAt";
    const direction = input.direction ?? "desc";
    sessions.sort((left, right) => {
      const comparison = compareSortValue(left, right, sortBy);
      if (comparison !== 0) return direction === "asc" ? comparison : -comparison;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    const total = sessions.length;
    const limit = input.limit === undefined ? 100 : input.limit;
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SessionServiceError(
        "VALIDATION_ERROR",
        400,
        "limit must be an integer between 1 and 100.",
      );
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new SessionServiceError(
        "VALIDATION_ERROR",
        400,
        "offset must be a non-negative integer.",
      );
    }
    return {
      items: sessions.slice(offset, offset + limit).map(sessionListProjection),
      total,
      limit,
      offset,
    };
  }

  async updateSession(actor: SessionActor, input: UpdateSessionInput): Promise<Session> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const sessionId = resourceId(input.sessionId, "session id");
    const current = await this.#repository.getSession(actor.tenantId, eventId, sessionId);
    if (!current || !this.inScope(current, actor.tenantId, eventId)) throw notFound("session");
    const expected = expectedVersion(input.expectedVersion);
    if (current.version !== expected) throw versionConflict("session");

    const settings = await this.ensureSettings(actor.tenantId, eventId, actor.userId);
    const nextStatus = input.status === undefined ? current.status : status(input.status);
    this.assertConfiguredStatus(nextStatus, settings);
    const requestedContentStatus =
      input.contentStatus === undefined ? undefined : contentReviewStatus(input.contentStatus);
    const currentContentStatus = sessionContentStatus(current);
    const nextTitle =
      input.title === undefined ? current.title : requiredText(input.title, "title", 300);
    const nextDescription =
      input.description === undefined
        ? current.description
        : optionalText(input.description, "description", 20_000);
    const copyChanged = nextTitle !== current.title || nextDescription !== current.description;
    const referenceInput: Partial<CreateSessionInput> & { eventId: string } = { eventId };
    if (input.roomId !== undefined) referenceInput.roomId = input.roomId;
    if (input.trackId !== undefined) referenceInput.trackId = input.trackId;
    if (input.trackIds !== undefined) referenceInput.trackIds = input.trackIds;
    if (input.formatId !== undefined) referenceInput.formatId = input.formatId;
    if (input.levelId !== undefined) referenceInput.levelId = input.levelId;
    if (input.tagIds !== undefined) referenceInput.tagIds = input.tagIds;
    if (input.speakerIds !== undefined) referenceInput.speakerIds = input.speakerIds;
    if (input.speakerRoster !== undefined) referenceInput.speakerRoster = input.speakerRoster;
    if (input.resourceIds !== undefined) referenceInput.resourceIds = input.resourceIds;
    const normalized = await this.normalizeSessionReferences(
      actor.tenantId,
      eventId,
      referenceInput,
    );
    const trackReferencesSupplied = input.trackId !== undefined || input.trackIds !== undefined;
    const speakerReferencesSupplied =
      input.speakerIds !== undefined || input.speakerRoster !== undefined;
    const nextTrackIds = trackReferencesSupplied ? normalized.trackIds : [...current.trackIds];
    const nextTrackId = trackReferencesSupplied ? nextTrackIds[0] : current.trackId;
    const nextSpeakerIds = speakerReferencesSupplied
      ? normalized.speakerIds
      : [...current.speakerIds];
    const nextSpeakerRoster = !speakerReferencesSupplied
      ? current.speakerRoster.map((reference) => ({ ...reference }))
      : input.speakerRoster === undefined
        ? nextSpeakerIds.map((id) => {
            const currentReference = current.speakerRoster.find((reference) => reference.id === id);
            return currentReference === undefined ? { id } : { ...currentReference };
          })
        : normalized.speakerRoster;
    const speakerContentChanged =
      nextSpeakerIds.length !== current.speakerIds.length ||
      nextSpeakerIds.some((id, index) => id !== current.speakerIds[index]) ||
      nextSpeakerRoster.length !== current.speakerRoster.length ||
      nextSpeakerRoster.some((reference, index) => {
        const previous = current.speakerRoster[index];
        return (
          previous === undefined ||
          reference.id !== previous.id ||
          reference.displayName !== previous.displayName
        );
      });
    const publicContentChanged =
      copyChanged ||
      speakerContentChanged ||
      (input.durationMinutes !== undefined &&
        duration(input.durationMinutes) !== current.durationMinutes) ||
      (input.formatId !== undefined && normalized.formatId !== current.formatId) ||
      (trackReferencesSupplied &&
        (nextTrackIds.length !== current.trackIds.length ||
          nextTrackIds.some((id, index) => id !== current.trackIds[index])));
    const nextContentStatus =
      requestedContentStatus ??
      (publicContentChanged
        ? "Needs changes"
        : (currentContentStatus ?? (sameStatus(nextStatus, "Accepted") ? "Approved" : undefined)));
    const nextRoomId = input.roomId === undefined ? current.roomId : normalized.roomId;
    const nextFormatId = input.formatId === undefined ? current.formatId : normalized.formatId;
    const nextLevelId = input.levelId === undefined ? current.levelId : normalized.levelId;
    const nextTagIds = input.tagIds === undefined ? [...current.tagIds] : normalized.tagIds;
    const nextResourceIds =
      input.resourceIds === undefined ? [...current.resourceIds] : normalized.resourceIds;
    const candidate: Session = {
      ...current,
      title: nextTitle,
      description: nextDescription,
      status: nextStatus,
      durationMinutes:
        input.durationMinutes === undefined
          ? current.durationMinutes
          : duration(input.durationMinutes),
      capacityRequired:
        input.capacityRequired === undefined
          ? current.capacityRequired
          : capacity(input.capacityRequired),
      ...(nextRoomId === undefined ? {} : { roomId: nextRoomId }),
      ...(nextTrackId === undefined ? {} : { trackId: nextTrackId }),
      trackIds: nextTrackIds,
      ...(nextFormatId === undefined ? {} : { formatId: nextFormatId }),
      ...(nextLevelId === undefined ? {} : { levelId: nextLevelId }),
      tagIds: nextTagIds,
      speakerIds: nextSpeakerIds,
      speakerRoster: nextSpeakerRoster,
      resourceIds: nextResourceIds,
      ...(nextContentStatus === undefined ? {} : { contentStatus: nextContentStatus }),
      history: orderedSessionHistory(current.history),
    };
    if (candidate.contentStatus === undefined) delete candidate.contentStatus;
    if (nextRoomId === undefined) delete candidate.roomId;
    if (nextFormatId === undefined) delete candidate.formatId;
    if (nextLevelId === undefined) delete candidate.levelId;
    if (nextTrackId === undefined) delete candidate.trackId;
    if (acceptedSessionFieldsEqual(current, candidate)) {
      if (requestedContentStatus === "Approved") {
        await this.synchronizeAgenda(actor, eventId);
      }
      return sessionProjection(current);
    }

    const now = this.instant();
    const auditId = this.#generateId();
    const nextVersion = current.version + 1;
    const contentAction: SessionHistoryEntry["action"] =
      nextContentStatus !== currentContentStatus
        ? nextContentStatus === "Approved"
          ? "approved"
          : nextContentStatus === "Needs changes"
            ? "needs_changes"
            : "updated"
        : "updated";
    const nextBase: Session = {
      ...candidate,
      version: nextVersion,
      updatedAt: now,
      updatedBy: actor.userId,
    };
    const next: Session = {
      ...nextBase,
      history: [
        ...nextBase.history,
        historyEntry(auditId, contentAction, nextVersion, actor.userId, now, {
          title: nextBase.title,
          description: nextBase.description,
          actorLabel: actorLabel(actor),
          priorStatus: current.status,
          newStatus: nextBase.status,
          ...(currentContentStatus === undefined
            ? {}
            : { priorContentStatus: currentContentStatus }),
          ...(nextContentStatus === undefined ? {} : { contentStatus: nextContentStatus }),
          ...(nextContentStatus === undefined ? {} : { newContentStatus: nextContentStatus }),
          snapshot: sessionContentSnapshot(nextBase),
        }),
      ],
    };
    const audit = auditEntry(
      auditId,
      actor.tenantId,
      eventId,
      "session",
      sessionId,
      contentAction,
      nextVersion,
      actor.userId,
      now,
      current,
      next,
    );
    if (input.beforePersist !== undefined && !(await input.beforePersist())) {
      return sessionProjection(current);
    }
    try {
      if (this.#repository.commit !== undefined) {
        await this.#repository.commit({
          operation: "putSession",
          value: next,
          expectedVersion: expected,
          audit,
          ...(input.decisionFence === undefined ? {} : { decisionFence: input.decisionFence }),
        });
      } else {
        if (input.beforePersist !== undefined && !(await input.beforePersist())) {
          return sessionProjection(current);
        }
        await this.#repository.putSession(next, expected, input.decisionFence);
        await this.recordAudit(audit);
      }
    } catch (error) {
      if (repositoryConflict(error)) throw versionConflict("session");
      throw error;
    }
    await this.synchronizeAgenda(actor, eventId);
    return sessionProjection(next);
  }

  async deleteSession(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; sessionId: string; expectedVersion: number },
  ): Promise<Session> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const sessionId = resourceId(input.sessionId, "session id");
    const current = await this.#repository.getSession(actor.tenantId, eventId, sessionId);
    if (!current || !this.inScope(current, actor.tenantId, eventId)) throw notFound("session");
    const expected = expectedVersion(input.expectedVersion);
    if (current.version !== expected) throw versionConflict("session");
    const now = this.instant();
    const auditId = this.#generateId();
    const audit = auditEntry(
      auditId,
      actor.tenantId,
      eventId,
      "session",
      sessionId,
      "deleted",
      expected,
      actor.userId,
      now,
      current,
      undefined,
    );
    try {
      if (this.#repository.commit !== undefined) {
        await this.#repository.commit({
          operation: "deleteSession",
          tenantId: actor.tenantId,
          eventId,
          id: sessionId,
          expectedVersion: expected,
          audit,
        });
      } else {
        await this.#repository.deleteSession(actor.tenantId, eventId, sessionId, expected);
        await this.recordAudit(audit);
      }
    } catch (error) {
      if (repositoryConflict(error)) throw versionConflict("session");
      throw error;
    }
    await this.synchronizeAgenda(actor, eventId);
    return sessionProjection(current);
  }

  async createRoom(actor: SessionActor, input: CreateRoomInput): Promise<Room> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const id = input.id === undefined ? this.#generateId() : resourceId(input.id, "room id");
    const existing = await this.#repository.getRoom(actor.tenantId, eventId, id);
    if (existing !== null) {
      if (input.id === undefined || !roomMatchesInput(existing, input)) {
        throw conflict("A room with this id already exists.");
      }
      await this.synchronizeRoomAgenda(actor, eventId);
      return clone(existing);
    }
    const now = this.instant();
    const auditId = this.#generateId();
    const normalized = this.roomRecord(
      actor.tenantId,
      eventId,
      id,
      input,
      now,
      actor.userId,
      auditId,
    );
    try {
      await this.#repository.putRoom(normalized, null);
    } catch (error) {
      if (repositoryConflict(error)) {
        const raced = await this.#repository.getRoom(actor.tenantId, eventId, id);
        if (input.id !== undefined && raced !== null && roomMatchesInput(raced, input)) {
          await this.synchronizeRoomAgenda(actor, eventId);
          return clone(raced);
        }
        throw conflict("A room with this id already exists.");
      }
      throw error;
    }
    await this.recordAudit(
      auditEntry(
        auditId,
        actor.tenantId,
        eventId,
        "room",
        id,
        "created",
        1,
        actor.userId,
        now,
        undefined,
        normalized,
      ),
    );
    await this.synchronizeRoomAgenda(actor, eventId);
    return clone(normalized);
  }

  async getRoom(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; roomId: string },
  ): Promise<Room> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const room = await this.#repository.getRoom(
      actor.tenantId,
      this.event(input.eventId),
      resourceId(input.roomId, "room id"),
    );
    if (!room || !this.inScope(room, actor.tenantId, input.eventId)) throw notFound("room");
    return clone(room);
  }

  async listRooms(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string },
  ): Promise<readonly Room[]> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const rooms = await this.#repository.listRooms(actor.tenantId, this.event(input.eventId));
    return clone(
      rooms
        .filter((room) => this.inScope(room, actor.tenantId, input.eventId))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    );
  }

  async updateRoom(actor: SessionActor, input: UpdateRoomInput): Promise<Room> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const roomId = resourceId(input.roomId, "room id");
    const current = await this.#repository.getRoom(actor.tenantId, eventId, roomId);
    if (!current || !this.inScope(current, actor.tenantId, eventId)) throw notFound("room");
    const version = expectedVersion(input.expectedVersion);
    if (current.version !== version) throw versionConflict("room");
    const now = this.instant();
    const auditId = this.#generateId();
    const resources =
      input.resources === undefined && input.resourceIds === undefined
        ? current.resources
        : normalizeResources(input.resources, input.resourceIds);
    const next: Room = {
      ...current,
      name: input.name === undefined ? current.name : requiredText(input.name, "name", 200),
      capacity: input.capacity === undefined ? current.capacity : roomCapacity(input.capacity),
      resources,
      resourceIds: resources,
      version: version + 1,
      updatedAt: now,
      updatedBy: actor.userId,
      history: [
        ...current.history,
        historyEntry(auditId, "updated", version + 1, actor.userId, now),
      ],
    };
    try {
      await this.#repository.putRoom(next, version);
    } catch (error) {
      if (repositoryConflict(error)) throw versionConflict("room");
      throw error;
    }
    await this.recordAudit(
      auditEntry(
        auditId,
        actor.tenantId,
        eventId,
        "room",
        roomId,
        "updated",
        next.version,
        actor.userId,
        now,
        current,
        next,
      ),
    );
    await this.synchronizeAgenda(actor, eventId);
    return clone(next);
  }

  async deleteRoom(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; roomId: string; expectedVersion: number },
  ): Promise<Room> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const roomId = resourceId(input.roomId, "room id");
    const current = await this.#repository.getRoom(actor.tenantId, eventId, roomId);
    if (!current || !this.inScope(current, actor.tenantId, eventId)) throw notFound("room");
    const version = expectedVersion(input.expectedVersion);
    if (current.version !== version) throw versionConflict("room");
    const sessions = await this.#repository.listSessions(actor.tenantId, eventId);
    if (
      sessions.some(
        (session) => this.inScope(session, actor.tenantId, eventId) && session.roomId === roomId,
      )
    ) {
      throw conflict("The room is assigned to a session and cannot be deleted.");
    }
    const now = this.instant();
    const auditId = this.#generateId();
    try {
      await this.#repository.deleteRoom(actor.tenantId, eventId, roomId, version);
    } catch (error) {
      if (repositoryConflict(error)) throw versionConflict("room");
      throw error;
    }
    await this.recordAudit(
      auditEntry(
        auditId,
        actor.tenantId,
        eventId,
        "room",
        roomId,
        "deleted",
        version,
        actor.userId,
        now,
        current,
        undefined,
      ),
    );
    await this.synchronizeAgenda(actor, eventId);
    return clone(current);
  }

  async createTrack(actor: SessionActor, input: CreateTaxonomyInput): Promise<Track> {
    return this.createTaxonomy(actor, "track", input);
  }
  async getTrack(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; trackId: string },
  ): Promise<Track> {
    return this.getTaxonomy(actor, "track", input.eventId, input.trackId, input.tenantId);
  }
  async listTracks(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string },
  ): Promise<readonly Track[]> {
    return this.listTaxonomy(actor, "track", input.eventId, input.tenantId);
  }
  async updateTrack(actor: SessionActor, input: UpdateTaxonomyInput): Promise<Track> {
    return this.updateTaxonomy(actor, "track", input);
  }
  async deleteTrack(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; resourceId: string; expectedVersion: number },
  ): Promise<Track> {
    return this.deleteTaxonomy(actor, "track", input);
  }

  async createFormat(actor: SessionActor, input: CreateTaxonomyInput): Promise<Format> {
    return this.createTaxonomy(actor, "format", input);
  }
  async getFormat(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; formatId: string },
  ): Promise<Format> {
    return this.getTaxonomy(actor, "format", input.eventId, input.formatId, input.tenantId);
  }
  async listFormats(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string },
  ): Promise<readonly Format[]> {
    return this.listTaxonomy(actor, "format", input.eventId, input.tenantId);
  }
  async updateFormat(actor: SessionActor, input: UpdateTaxonomyInput): Promise<Format> {
    return this.updateTaxonomy(actor, "format", input);
  }
  async deleteFormat(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; resourceId: string; expectedVersion: number },
  ): Promise<Format> {
    return this.deleteTaxonomy(actor, "format", input);
  }

  async createLevel(actor: SessionActor, input: CreateTaxonomyInput): Promise<Level> {
    return this.createTaxonomy(actor, "level", input);
  }
  async getLevel(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; levelId: string },
  ): Promise<Level> {
    return this.getTaxonomy(actor, "level", input.eventId, input.levelId, input.tenantId);
  }
  async listLevels(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string },
  ): Promise<readonly Level[]> {
    return this.listTaxonomy(actor, "level", input.eventId, input.tenantId);
  }
  async updateLevel(actor: SessionActor, input: UpdateTaxonomyInput): Promise<Level> {
    return this.updateTaxonomy(actor, "level", input);
  }
  async deleteLevel(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; resourceId: string; expectedVersion: number },
  ): Promise<Level> {
    return this.deleteTaxonomy(actor, "level", input);
  }

  async createTag(actor: SessionActor, input: CreateTaxonomyInput): Promise<Tag> {
    return this.createTaxonomy(actor, "tag", input);
  }
  async getTag(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; tagId: string },
  ): Promise<Tag> {
    return this.getTaxonomy(actor, "tag", input.eventId, input.tagId, input.tenantId);
  }
  async listTags(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string },
  ): Promise<readonly Tag[]> {
    return this.listTaxonomy(actor, "tag", input.eventId, input.tenantId);
  }
  async updateTag(actor: SessionActor, input: UpdateTaxonomyInput): Promise<Tag> {
    return this.updateTaxonomy(actor, "tag", input);
  }
  async deleteTag(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; resourceId: string; expectedVersion: number },
  ): Promise<Tag> {
    return this.deleteTaxonomy(actor, "tag", input);
  }

  async getSettings(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string },
  ): Promise<SessionSettings> {
    this.assertActor(actor, input.tenantId, input.eventId);
    return clone(
      await this.ensureSettings(actor.tenantId, this.event(input.eventId), actor.userId),
    );
  }

  async getSessionSettings(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string },
  ): Promise<SessionSettings> {
    return this.getSettings(actor, input);
  }

  async updateSettings(
    actor: SessionActor,
    input: UpdateSessionSettingsInput,
  ): Promise<SessionSettings> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const current = await this.ensureSettings(actor.tenantId, eventId, actor.userId);
    const version = expectedVersion(input.expectedVersion);
    if (current.version !== version) throw versionConflict("session settings");
    const statuses =
      input.statuses === undefined
        ? [...current.statuses]
        : normaliseStatusSet(input.statuses, "statuses");
    const eligible =
      input.agendaEligibleStatuses === undefined
        ? [...current.agendaEligibleStatuses]
        : normaliseStatusSet(input.agendaEligibleStatuses, "agendaEligibleStatuses");
    for (const candidate of eligible) {
      if (!hasStatus(candidate, statuses)) {
        throw new SessionServiceError(
          "VALIDATION_ERROR",
          400,
          "Every agenda-eligible status must be configured in statuses.",
        );
      }
    }
    const sessions = await this.#repository.listSessions(actor.tenantId, eventId);
    const removedInUse = sessions.some(
      (session) =>
        this.inScope(session, actor.tenantId, eventId) && !hasStatus(session.status, statuses),
    );
    if (removedInUse) throw conflict("Statuses currently used by sessions cannot be removed.");
    const now = this.instant();
    const auditId = this.#generateId();
    const next: SessionSettings = {
      ...current,
      statuses,
      agendaEligibleStatuses: eligible,
      version: version + 1,
      updatedAt: now,
      updatedBy: actor.userId,
      history: [
        ...current.history,
        historyEntry(auditId, "settings.updated", version + 1, actor.userId, now),
      ],
    };
    try {
      await this.#repository.putSettings(next, version);
    } catch (error) {
      if (repositoryConflict(error)) throw versionConflict("session settings");
      throw error;
    }
    await this.recordAudit(
      auditEntry(
        auditId,
        actor.tenantId,
        eventId,
        "settings",
        current.id,
        "settings.updated",
        next.version,
        actor.userId,
        now,
        current,
        next,
      ),
    );
    await this.synchronizeAgenda(actor, eventId);
    return clone(next);
  }

  async updateSessionSettings(
    actor: SessionActor,
    input: UpdateSessionSettingsInput,
  ): Promise<SessionSettings> {
    return this.updateSettings(actor, input);
  }

  async listStatuses(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string },
  ): Promise<readonly string[]> {
    return (await this.getSettings(actor, input)).statuses;
  }

  async listAudit(
    actor: SessionActor,
    input: { tenantId?: string; eventId: string; entityId?: string },
  ): Promise<readonly SessionAuditEntry[]> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const entries = await this.#repository.listAudit(
      actor.tenantId,
      this.event(input.eventId),
      input.entityId,
    );
    return entries
      .filter((entry) => entry.tenantId === actor.tenantId && entry.eventId === input.eventId)
      .map((entry) => sanitizeAuditEntry(entry));
  }

  /**
   * Authoritative approval-gated content handoff for agenda and deliverables consumers.
   * The session lifecycle must also be configured as agenda eligible.
   */
  async getPublishedSessionContent(
    tenantId: string,
    eventId: string,
  ): Promise<PublishedSessionContentHandoff> {
    const organizationId = resourceId(tenantId, "tenant id");
    const scopedEventId = this.event(eventId);
    const settings = await this.readSettings(organizationId, scopedEventId);
    const eligibleStatuses = settings?.agendaEligibleStatuses ?? defaultAgendaEligibleStatuses;
    const sessions = await this.#repository.listSessions(organizationId, scopedEventId);
    return {
      tenantId: organizationId,
      eventId: scopedEventId,
      sessions: sessions
        .filter(
          (session) =>
            this.inScope(session, organizationId, scopedEventId) &&
            hasStatus(session.status, eligibleStatuses) &&
            sessionIsPubliclyApproved(session),
        )
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((session) => ({
          id: session.id,
          title: session.title,
          abstract: session.description,
          contentStatus: "Approved" as const,
          durationMinutes: session.durationMinutes,
          capacityRequired: session.capacityRequired,
          ...(session.roomId === undefined ? {} : { roomId: session.roomId }),
          trackIds: [
            ...new Set([
              ...(session.trackIds ?? []),
              ...(session.trackId === undefined ? [] : [session.trackId]),
            ]),
          ],
          ...(session.formatId === undefined ? {} : { formatId: session.formatId }),
          speakerIds: [...session.speakerIds],
          speakerNames: sessionSpeakerNames(session),
          resourceIds: [...session.resourceIds],
          version: session.version,
          updatedAt: session.updatedAt,
        })),
    };
  }

  /** Private scheduling catalog for agenda planning; publication uses getPublishedSessionContent. */
  async getAgendaCatalog(tenantId: string, eventId: string) {
    const organizationId = resourceId(tenantId, "tenant id");
    const scopedEventId = this.event(eventId);
    const [settings, sessions, rooms, tracks, formats] = await Promise.all([
      this.readSettings(organizationId, scopedEventId),
      this.#repository.listSessions(organizationId, scopedEventId),
      this.#repository.listRooms(organizationId, scopedEventId),
      this.#repository.listTracks(organizationId, scopedEventId),
      this.#repository.listFormats(organizationId, scopedEventId),
    ]);
    const eligibleStatuses = settings?.agendaEligibleStatuses ?? defaultAgendaEligibleStatuses;
    const roomById = new Map(
      rooms
        .filter((room) => this.inScope(room, organizationId, scopedEventId))
        .map((room) => [room.id, room]),
    );
    const trackById = new Map(
      tracks
        .filter((track) => this.inScope(track, organizationId, scopedEventId))
        .map((track) => [track.id, track]),
    );
    const formatById = new Map(
      formats
        .filter((format) => this.inScope(format, organizationId, scopedEventId))
        .map((format) => [format.id, format]),
    );
    return {
      sessions: sessions
        .filter(
          (session) =>
            this.inScope(session, organizationId, scopedEventId) &&
            hasStatus(session.status, eligibleStatuses),
        )
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((session) => ({
          id: session.id,
          title: session.title,
          status: "accepted" as const,
          publicApprovalEligible: sessionIsPubliclyApproved(session),
          participantIds: [...session.speakerIds],
          resourceIds: [...session.resourceIds],
          capacityRequired: session.capacityRequired,
          durationMinutes: session.durationMinutes,
          summary: session.description,
          format:
            session.formatId === undefined
              ? "Session"
              : (formatById.get(session.formatId)?.name ?? "Session"),
          speakerNames: sessionSpeakerNames(session),
          ...(session.roomId === undefined
            ? {}
            : { roomName: roomById.get(session.roomId)?.name ?? "Room to be announced" }),
          trackIds: [...session.trackIds],
          trackNames: session.trackIds.flatMap((trackId) => {
            const name = trackById.get(trackId)?.name;
            return name === undefined ? [] : [name];
          }),
        })),
      rooms: [...roomById.values()].map((room) => ({
        id: room.id,
        name: room.name,
        capacity: room.capacity,
      })),
      tracks: [...trackById.values()].map((track) => ({ id: track.id, name: track.name })),
    };
  }

  async readAgendaCatalog(tenantId: string, eventId: string) {
    return this.getAgendaCatalog(tenantId, eventId);
  }

  private async createTaxonomy<T extends Track | Format | Level | Tag>(
    actor: SessionActor,
    resourceType: "track" | "format" | "level" | "tag",
    input: CreateTaxonomyInput,
  ): Promise<T> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const id =
      input.id === undefined ? this.#generateId() : resourceId(input.id, `${resourceType} id`);
    const current = await this.getTaxonomyRaw(actor.tenantId, resourceType, eventId, id);
    if (current !== null) throw conflict(`A ${resourceType} with this id already exists.`);
    const now = this.instant();
    const auditId = this.#generateId();
    const record = {
      id,
      tenantId: actor.tenantId,
      eventId,
      name: requiredText(input.name, "name", 200),
      description: optionalText(input.description, "description", 2_000),
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      history: [historyEntry(auditId, "created", 1, actor.userId, now)],
    } as unknown as T;
    try {
      await this.putTaxonomy(resourceType, record, null);
    } catch (error) {
      if (repositoryConflict(error))
        throw conflict(`A ${resourceType} with this id already exists.`);
      throw error;
    }
    await this.recordAudit(
      auditEntry(
        auditId,
        actor.tenantId,
        eventId,
        resourceType,
        id,
        "created",
        1,
        actor.userId,
        now,
        undefined,
        record,
      ),
    );
    if (resourceType === "track" || resourceType === "format")
      await this.synchronizeAgenda(actor, eventId);
    return clone(record);
  }

  private async getTaxonomy<T extends Track | Format | Level | Tag>(
    actor: SessionActor,
    resourceType: "track" | "format" | "level" | "tag",
    eventIdInput: string,
    idInput: string,
    tenantId?: string,
  ): Promise<T> {
    this.assertActor(actor, tenantId, eventIdInput);
    const eventId = this.event(eventIdInput);
    const record = await this.getTaxonomyRaw(
      actor.tenantId,
      resourceType,
      eventId,
      resourceId(idInput, `${resourceType} id`),
    );
    if (record === null || !this.inScope(record, actor.tenantId, eventId))
      throw notFound(resourceType);
    return clone(record as T);
  }

  private async listTaxonomy<T extends Track | Format | Level | Tag>(
    actor: SessionActor,
    resourceType: "track" | "format" | "level" | "tag",
    eventIdInput: string,
    tenantId?: string,
  ): Promise<readonly T[]> {
    this.assertActor(actor, tenantId, eventIdInput);
    const eventId = this.event(eventIdInput);
    const records = await this.listTaxonomyRaw(actor.tenantId, resourceType, eventId);
    return clone(
      records
        .filter((record) => this.inScope(record, actor.tenantId, eventId))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) as T[],
    );
  }

  private async updateTaxonomy<T extends Track | Format | Level | Tag>(
    actor: SessionActor,
    resourceType: "track" | "format" | "level" | "tag",
    input: UpdateTaxonomyInput,
  ): Promise<T> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const id = resourceId(input.resourceId, `${resourceType} id`);
    const current = await this.getTaxonomyRaw(actor.tenantId, resourceType, eventId, id);
    if (current === null || !this.inScope(current, actor.tenantId, eventId))
      throw notFound(resourceType);
    const version = expectedVersion(input.expectedVersion);
    if (current.version !== version) throw versionConflict(resourceType);
    const now = this.instant();
    const auditId = this.#generateId();
    const next = {
      ...current,
      name: input.name === undefined ? current.name : requiredText(input.name, "name", 200),
      description:
        input.description === undefined
          ? current.description
          : optionalText(input.description, "description", 2_000),
      version: version + 1,
      updatedAt: now,
      updatedBy: actor.userId,
      history: [
        ...current.history,
        historyEntry(auditId, "updated", version + 1, actor.userId, now),
      ],
    } as unknown as T;
    try {
      await this.putTaxonomy(resourceType, next, version);
    } catch (error) {
      if (repositoryConflict(error)) throw versionConflict(resourceType);
      throw error;
    }
    await this.recordAudit(
      auditEntry(
        auditId,
        actor.tenantId,
        eventId,
        resourceType,
        id,
        "updated",
        next.version,
        actor.userId,
        now,
        current,
        next,
      ),
    );
    if (resourceType === "track" || resourceType === "format")
      await this.synchronizeAgenda(actor, eventId);
    return clone(next);
  }

  private async deleteTaxonomy<T extends Track | Format | Level | Tag>(
    actor: SessionActor,
    resourceType: "track" | "format" | "level" | "tag",
    input: { tenantId?: string; eventId: string; resourceId: string; expectedVersion: number },
  ): Promise<T> {
    this.assertActor(actor, input.tenantId, input.eventId);
    const eventId = this.event(input.eventId);
    const id = resourceId(input.resourceId, `${resourceType} id`);
    const current = await this.getTaxonomyRaw(actor.tenantId, resourceType, eventId, id);
    if (current === null || !this.inScope(current, actor.tenantId, eventId))
      throw notFound(resourceType);
    const version = expectedVersion(input.expectedVersion);
    if (current.version !== version) throw versionConflict(resourceType);
    const sessions = await this.#repository.listSessions(actor.tenantId, eventId);
    if (
      sessions.some(
        (session) =>
          this.inScope(session, actor.tenantId, eventId) &&
          referencesTaxonomy(session, resourceType, id),
      )
    ) {
      throw conflict(`The ${resourceType} is referenced by a session and cannot be deleted.`);
    }
    const now = this.instant();
    const auditId = this.#generateId();
    try {
      await this.deleteTaxonomyRaw(resourceType, actor.tenantId, eventId, id, version);
    } catch (error) {
      if (repositoryConflict(error)) throw versionConflict(resourceType);
      throw error;
    }
    await this.recordAudit(
      auditEntry(
        auditId,
        actor.tenantId,
        eventId,
        resourceType,
        id,
        "deleted",
        version,
        actor.userId,
        now,
        current,
        undefined,
      ),
    );
    if (resourceType === "track" || resourceType === "format")
      await this.synchronizeAgenda(actor, eventId);
    return clone(current as T);
  }

  private roomRecord(
    tenantId: string,
    eventId: string,
    id: string,
    input: CreateRoomInput,
    now: string,
    actorId: string,
    auditId: string,
  ): Room {
    const normalized = normalizeRoomInput(input);
    return {
      id,
      tenantId,
      eventId,
      name: normalized.name,
      capacity: normalized.capacity,
      resources: normalized.resources,
      resourceIds: normalized.resources,
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actorId,
      updatedBy: actorId,
      history: [historyEntry(auditId, "created", 1, actorId, now)],
    };
  }

  private async normalizeSessionReferences(
    tenantId: string,
    eventId: string,
    input: Partial<CreateSessionInput> & { eventId: string },
  ): Promise<{
    roomId: string | undefined;
    trackIds: string[];
    formatId: string | undefined;
    levelId: string | undefined;
    tagIds: string[];
    speakerIds: string[];
    speakerRoster: SessionSpeakerReference[];
    resourceIds: string[];
  }> {
    const roomId =
      input.roomId === null || input.roomId === undefined
        ? undefined
        : resourceId(input.roomId, "room id");
    if (roomId !== undefined && !(await this.#repository.getRoom(tenantId, eventId, roomId)))
      throw notFound("room");
    const suppliedTrackIds = uniqueIds(input.trackIds, "trackIds", 20);
    const trackId =
      input.trackId === null || input.trackId === undefined
        ? undefined
        : resourceId(input.trackId, "track id");
    if (trackId !== undefined) suppliedTrackIds.unshift(trackId);
    const trackIds = [...new Set(suppliedTrackIds)];
    for (const id of trackIds) {
      if (!(await this.#repository.getTrack(tenantId, eventId, id))) throw notFound("track");
    }
    const formatId =
      input.formatId === null || input.formatId === undefined
        ? undefined
        : resourceId(input.formatId, "format id");
    if (formatId !== undefined && !(await this.#repository.getFormat(tenantId, eventId, formatId)))
      throw notFound("format");
    const levelId =
      input.levelId === null || input.levelId === undefined
        ? undefined
        : resourceId(input.levelId, "level id");
    if (levelId !== undefined && !(await this.#repository.getLevel(tenantId, eventId, levelId)))
      throw notFound("level");
    const tagIds = uniqueIds(input.tagIds, "tagIds", 50);
    for (const id of tagIds) {
      if (!(await this.#repository.getTag(tenantId, eventId, id))) throw notFound("tag");
    }
    const roster = normalizeRoster(input.speakerIds, input.speakerRoster);
    if (this.#repository.listSpeakerIds !== undefined && roster.speakerIds.length > 0) {
      const configuredSpeakerIds = await this.#repository.listSpeakerIds(tenantId, eventId);
      if (configuredSpeakerIds !== undefined) {
        const known = new Set(configuredSpeakerIds);
        if (roster.speakerIds.some((id) => !known.has(id))) throw notFound("speaker");
      }
    }
    return {
      roomId,
      trackIds,
      formatId,
      levelId,
      tagIds,
      speakerIds: roster.speakerIds,
      speakerRoster: roster.speakerRoster,
      resourceIds: normalizeResources(undefined, input.resourceIds, "resourceIds"),
    };
  }

  private assertConfiguredStatus(value: string, settings: SessionSettings): void {
    if (!hasStatus(value, settings.statuses)) {
      throw new SessionServiceError(
        "VALIDATION_ERROR",
        400,
        `Status ${value} is not configured for this event.`,
      );
    }
  }

  private async ensureSettings(
    tenantId: string,
    eventId: string,
    actorId: string,
  ): Promise<SessionSettings> {
    const current = await this.#repository.getSettings(tenantId, eventId);
    if (current !== null && this.inScope(current, tenantId, eventId)) return current;
    const now = this.instant();
    const id = `settings:${eventId}`;
    const settings: SessionSettings = {
      id,
      tenantId,
      eventId,
      statuses: [...defaultSessionStatuses],
      agendaEligibleStatuses: [...defaultAgendaEligibleStatuses],
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actorId,
      updatedBy: actorId,
      history: [],
    };
    try {
      await this.#repository.putSettings(settings, null);
    } catch (error) {
      if (!repositoryConflict(error)) throw error;
      const raced = await this.#repository.getSettings(tenantId, eventId);
      if (raced !== null && this.inScope(raced, tenantId, eventId)) return raced;
      throw versionConflict("session settings");
    }
    return settings;
  }

  private async readSettings(tenantId: string, eventId: string): Promise<SessionSettings | null> {
    const settings = await this.#repository.getSettings(tenantId, eventId);
    return settings !== null && this.inScope(settings, tenantId, eventId) ? settings : null;
  }

  private async recordAudit(entry: SessionAuditEntry): Promise<void> {
    await this.#repository.appendAudit(entry);
  }

  private async ensureAgendaInitialized(actor: SessionActor, eventId: string): Promise<void> {
    const synchronizer = this.#agendaCatalogSynchronizer;
    if (synchronizer === undefined) return;
    try {
      await synchronizer.ensureInitialized({
        tenantId: actor.tenantId,
        eventId,
        actorId: actor.userId,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AgendaCatalogSynchronizationError") {
        throw conflict(error.message);
      }
      throw error;
    }
  }
  private async synchronizeAgenda(actor: SessionActor, eventId: string): Promise<void> {
    const synchronizer = this.#agendaCatalogSynchronizer;
    if (synchronizer === undefined) return;
    try {
      await synchronizer.synchronize({
        tenantId: actor.tenantId,
        eventId,
        actorId: actor.userId,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AgendaCatalogSynchronizationError") {
        throw conflict(error.message);
      }
      throw error;
    }
  }
  private async synchronizeRoomAgenda(actor: SessionActor, eventId: string): Promise<void> {
    try {
      await this.synchronizeAgenda(actor, eventId);
    } catch {
      throw conflict(
        "The room was saved, but the agenda could not be synchronized. Retry the request.",
      );
    }
  }
  private assertActor(actor: SessionActor, tenantId: string | undefined, eventId: string): void {
    if (typeof actor !== "object" || actor === null || actor.kind === "automation")
      throw forbidden();
    const actorTenant = resourceId(actor.tenantId, "tenant id");
    const expectedTenant = tenantId === undefined ? actorTenant : resourceId(tenantId, "tenant id");
    if (actorTenant !== expectedTenant)
      throw forbidden("The organizer does not belong to this organization.");
    this.event(eventId);
    const roles = new Set<string>([
      ...(actor.role === undefined ? [] : [actor.role]),
      ...(actor.roles ?? []),
      ...(actor.grants ?? [])
        .filter((grant) => grant.eventId === eventId)
        .map((grant) => grant.role),
    ]);
    if (!actor.isOrganizer && !["owner", "admin", "organizer"].some((role) => roles.has(role)))
      throw forbidden();
  }

  private event(value: unknown): string {
    return resourceId(value, "event id");
  }

  private instant(): string {
    return assertIsoInstant(this.#clock());
  }

  private inScope(
    value: { tenantId: string; eventId: string },
    tenantId: string,
    eventId: string,
  ): boolean {
    return value.tenantId === tenantId && value.eventId === eventId;
  }

  private async getTaxonomyRaw(
    tenantId: string,
    resourceType: "track" | "format" | "level" | "tag",
    eventId: string,
    id: string,
  ): Promise<Track | Format | Level | Tag | null> {
    switch (resourceType) {
      case "track":
        return this.#repository.getTrack(tenantId, eventId, id);
      case "format":
        return this.#repository.getFormat(tenantId, eventId, id);
      case "level":
        return this.#repository.getLevel(tenantId, eventId, id);
      case "tag":
        return this.#repository.getTag(tenantId, eventId, id);
    }
  }

  private async listTaxonomyRaw(
    tenantId: string,
    resourceType: "track" | "format" | "level" | "tag",
    eventId: string,
  ): Promise<readonly (Track | Format | Level | Tag)[]> {
    switch (resourceType) {
      case "track":
        return this.#repository.listTracks(tenantId, eventId);
      case "format":
        return this.#repository.listFormats(tenantId, eventId);
      case "level":
        return this.#repository.listLevels(tenantId, eventId);
      case "tag":
        return this.#repository.listTags(tenantId, eventId);
    }
  }

  private async putTaxonomy(
    resourceType: "track" | "format" | "level" | "tag",
    record: Track | Format | Level | Tag,
    expected: number | null,
  ): Promise<void> {
    switch (resourceType) {
      case "track":
        await this.#repository.putTrack(record as Track, expected);
        return;
      case "format":
        await this.#repository.putFormat(record as Format, expected);
        return;
      case "level":
        await this.#repository.putLevel(record as Level, expected);
        return;
      case "tag":
        await this.#repository.putTag(record as Tag, expected);
        return;
    }
  }

  private async deleteTaxonomyRaw(
    resourceType: "track" | "format" | "level" | "tag",
    tenantId: string,
    eventId: string,
    id: string,
    expected: number,
  ): Promise<void> {
    switch (resourceType) {
      case "track":
        await this.#repository.deleteTrack(tenantId, eventId, id, expected);
        return;
      case "format":
        await this.#repository.deleteFormat(tenantId, eventId, id, expected);
        return;
      case "level":
        await this.#repository.deleteLevel(tenantId, eventId, id, expected);
        return;
      case "tag":
        await this.#repository.deleteTag(tenantId, eventId, id, expected);
        return;
    }
  }
}

function compareSortValue(
  left: Session,
  right: Session,
  field: NonNullable<SessionListQuery["sortBy"]>,
): number {
  if (field === "durationMinutes") return left.durationMinutes - right.durationMinutes;
  const leftValue =
    field === "title"
      ? left.title
      : field === "status"
        ? left.status
        : field === "roomId"
          ? (left.roomId ?? "")
          : field === "trackId"
            ? (left.trackId ?? "")
            : field === "createdAt"
              ? left.createdAt
              : left.updatedAt;
  const rightValue =
    field === "title"
      ? right.title
      : field === "status"
        ? right.status
        : field === "roomId"
          ? (right.roomId ?? "")
          : field === "trackId"
            ? (right.trackId ?? "")
            : field === "createdAt"
              ? right.createdAt
              : right.updatedAt;
  return leftValue.localeCompare(rightValue);
}

function referencesTaxonomy(
  session: Session,
  resourceType: "track" | "format" | "level" | "tag",
  id: string,
): boolean {
  switch (resourceType) {
    case "track":
      return session.trackId === id || session.trackIds.includes(id);
    case "format":
      return session.formatId === id;
    case "level":
      return session.levelId === id;
    case "tag":
      return session.tagIds.includes(id);
  }
}

export class InMemorySessionRepository implements SessionRepository {
  readonly #sessions = new Map<string, Session>();
  readonly #rooms = new Map<string, Room>();
  readonly #tracks = new Map<string, Track>();
  readonly #formats = new Map<string, Format>();
  readonly #levels = new Map<string, Level>();
  readonly #tags = new Map<string, Tag>();
  readonly #settings = new Map<string, SessionSettings>();
  readonly #audit = new Map<string, SessionAuditEntry[]>();
  readonly #speakerIds = new Map<string, Set<string>>();

  constructor(
    seed: SessionRepositorySeed = {},
    private readonly decisionFenceChecker?: (fence: DecisionVersionFence) => Promise<boolean>,
  ) {
    for (const session of seed.sessions ?? [])
      this.#sessions.set(key(session.tenantId, session.eventId, session.id), clone(session));
    for (const room of seed.rooms ?? [])
      this.#rooms.set(key(room.tenantId, room.eventId, room.id), clone(room));
    for (const track of seed.tracks ?? [])
      this.#tracks.set(key(track.tenantId, track.eventId, track.id), clone(track));
    for (const format of seed.formats ?? [])
      this.#formats.set(key(format.tenantId, format.eventId, format.id), clone(format));
    for (const level of seed.levels ?? [])
      this.#levels.set(key(level.tenantId, level.eventId, level.id), clone(level));
    for (const tag of seed.tags ?? [])
      this.#tags.set(key(tag.tenantId, tag.eventId, tag.id), clone(tag));
    for (const settings of seed.settings ?? [])
      this.#settings.set(eventKey(settings.tenantId, settings.eventId), clone(settings));
    for (const entry of seed.audit ?? []) {
      const entries = this.#audit.get(eventKey(entry.tenantId, entry.eventId)) ?? [];
      entries.push(clone(entry));
      this.#audit.set(eventKey(entry.tenantId, entry.eventId), entries);
    }
    for (const [scope, ids] of Object.entries(seed.speakerIds ?? {}))
      this.#speakerIds.set(scope, new Set(ids));
  }

  async getSession(tenantId: string, eventId: string, sessionId: string): Promise<Session | null> {
    return clone(this.#sessions.get(key(tenantId, eventId, sessionId)) ?? null);
  }
  async listSessions(tenantId: string, eventId: string): Promise<readonly Session[]> {
    return [...this.#sessions.values()]
      .filter((value) => value.tenantId === tenantId && value.eventId === eventId)
      .map(clone);
  }
  async putSession(
    value: Session,
    expected: number | null,
    decisionFence?: DecisionVersionFence,
  ): Promise<void> {
    if (
      decisionFence !== undefined &&
      this.decisionFenceChecker !== undefined &&
      !(await this.decisionFenceChecker(decisionFence))
    ) {
      throw new SessionRepositoryConflictError("The evaluation decision changed.");
    }
    putVersioned(this.#sessions, key(value.tenantId, value.eventId, value.id), value, expected);
  }
  async deleteSession(
    tenantId: string,
    eventId: string,
    id: string,
    expected: number,
  ): Promise<void> {
    deleteVersioned(this.#sessions, key(tenantId, eventId, id), expected);
  }

  async getRoom(tenantId: string, eventId: string, roomId: string): Promise<Room | null> {
    return clone(this.#rooms.get(key(tenantId, eventId, roomId)) ?? null);
  }
  async listRooms(tenantId: string, eventId: string): Promise<readonly Room[]> {
    return [...this.#rooms.values()]
      .filter((value) => value.tenantId === tenantId && value.eventId === eventId)
      .map(clone);
  }
  async putRoom(value: Room, expected: number | null): Promise<void> {
    putVersioned(this.#rooms, key(value.tenantId, value.eventId, value.id), value, expected);
  }
  async deleteRoom(tenantId: string, eventId: string, id: string, expected: number): Promise<void> {
    deleteVersioned(this.#rooms, key(tenantId, eventId, id), expected);
  }

  async getTrack(tenantId: string, eventId: string, trackId: string): Promise<Track | null> {
    return clone(this.#tracks.get(key(tenantId, eventId, trackId)) ?? null);
  }
  async listTracks(tenantId: string, eventId: string): Promise<readonly Track[]> {
    return [...this.#tracks.values()]
      .filter((value) => value.tenantId === tenantId && value.eventId === eventId)
      .map(clone);
  }
  async putTrack(value: Track, expected: number | null): Promise<void> {
    putVersioned(this.#tracks, key(value.tenantId, value.eventId, value.id), value, expected);
  }
  async deleteTrack(
    tenantId: string,
    eventId: string,
    id: string,
    expected: number,
  ): Promise<void> {
    deleteVersioned(this.#tracks, key(tenantId, eventId, id), expected);
  }

  async getFormat(tenantId: string, eventId: string, formatId: string): Promise<Format | null> {
    return clone(this.#formats.get(key(tenantId, eventId, formatId)) ?? null);
  }
  async listFormats(tenantId: string, eventId: string): Promise<readonly Format[]> {
    return [...this.#formats.values()]
      .filter((value) => value.tenantId === tenantId && value.eventId === eventId)
      .map(clone);
  }
  async putFormat(value: Format, expected: number | null): Promise<void> {
    putVersioned(this.#formats, key(value.tenantId, value.eventId, value.id), value, expected);
  }
  async deleteFormat(
    tenantId: string,
    eventId: string,
    id: string,
    expected: number,
  ): Promise<void> {
    deleteVersioned(this.#formats, key(tenantId, eventId, id), expected);
  }

  async getLevel(tenantId: string, eventId: string, levelId: string): Promise<Level | null> {
    return clone(this.#levels.get(key(tenantId, eventId, levelId)) ?? null);
  }
  async listLevels(tenantId: string, eventId: string): Promise<readonly Level[]> {
    return [...this.#levels.values()]
      .filter((value) => value.tenantId === tenantId && value.eventId === eventId)
      .map(clone);
  }
  async putLevel(value: Level, expected: number | null): Promise<void> {
    putVersioned(this.#levels, key(value.tenantId, value.eventId, value.id), value, expected);
  }
  async deleteLevel(
    tenantId: string,
    eventId: string,
    id: string,
    expected: number,
  ): Promise<void> {
    deleteVersioned(this.#levels, key(tenantId, eventId, id), expected);
  }

  async getTag(tenantId: string, eventId: string, tagId: string): Promise<Tag | null> {
    return clone(this.#tags.get(key(tenantId, eventId, tagId)) ?? null);
  }
  async listTags(tenantId: string, eventId: string): Promise<readonly Tag[]> {
    return [...this.#tags.values()]
      .filter((value) => value.tenantId === tenantId && value.eventId === eventId)
      .map(clone);
  }
  async putTag(value: Tag, expected: number | null): Promise<void> {
    putVersioned(this.#tags, key(value.tenantId, value.eventId, value.id), value, expected);
  }
  async deleteTag(tenantId: string, eventId: string, id: string, expected: number): Promise<void> {
    deleteVersioned(this.#tags, key(tenantId, eventId, id), expected);
  }

  async getSettings(tenantId: string, eventId: string): Promise<SessionSettings | null> {
    return clone(this.#settings.get(eventKey(tenantId, eventId)) ?? null);
  }
  async putSettings(value: SessionSettings, expected: number | null): Promise<void> {
    putVersioned(this.#settings, eventKey(value.tenantId, value.eventId), value, expected);
  }

  async appendAudit(entry: SessionAuditEntry): Promise<void> {
    const entries = this.#audit.get(eventKey(entry.tenantId, entry.eventId)) ?? [];
    if (entries.some((candidate) => candidate.id === entry.id))
      throw new SessionRepositoryConflictError("Audit entry already exists.");
    entries.push(clone(entry));
    this.#audit.set(eventKey(entry.tenantId, entry.eventId), entries);
  }
  async listAudit(
    tenantId: string,
    eventId: string,
    entityId?: string,
  ): Promise<readonly SessionAuditEntry[]> {
    return clone(
      (this.#audit.get(eventKey(tenantId, eventId)) ?? []).filter(
        (entry) => entityId === undefined || entry.entityId === entityId,
      ),
    );
  }
  async listSpeakerIds(tenantId: string, eventId: string): Promise<readonly string[] | undefined> {
    const scope = eventKey(tenantId, eventId);
    const ids = this.#speakerIds.get(scope) ?? this.#speakerIds.get(`${tenantId}:${eventId}`);
    return ids === undefined ? undefined : [...ids];
  }
  setSpeakerIds(tenantId: string, eventId: string, ids: readonly string[]): void {
    this.#speakerIds.set(eventKey(tenantId, eventId), new Set(ids));
  }
}

function putVersioned<T extends { version: number }>(
  map: Map<string, T>,
  storageKey: string,
  value: T,
  expected: number | null,
): void {
  const current = map.get(storageKey);
  if ((current?.version ?? null) !== expected) throw new SessionRepositoryConflictError();
  map.set(storageKey, clone(value));
}

function deleteVersioned<T extends { version: number }>(
  map: Map<string, T>,
  storageKey: string,
  expected: number,
): void {
  const current = map.get(storageKey);
  if (current === undefined)
    throw new SessionRepositoryConflictError("The resource was not found.");
  if (current.version !== expected) throw new SessionRepositoryConflictError();
  map.delete(storageKey);
}
