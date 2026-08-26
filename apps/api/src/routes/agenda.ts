import { apiErrorSchema } from "@eventloom/contracts";
import { type Context, Hono } from "hono";
import { ZodError, z } from "zod";
import {
  type AgendaEngine,
  AgendaEntryTemporalValidationError,
  AgendaError,
  AgendaValidationError,
  validateAgendaEntriesWithinEvent,
} from "../features/agenda/engine";
import { localDateInTimeZone } from "../features/agenda/timezone";
import type {
  AgendaCatalog,
  PublishedAgendaRevision as AgendaPublishedRevision,
  AgendaState,
} from "../features/agenda/types";
import type { AuthPrincipal, UserPrincipal } from "../features/auth/types";
import { AuthAccessError } from "../features/auth/types";
import type { ProgramPublicationManifest } from "../features/events/types";
import { escapeIcalText, foldIcalLine } from "../integrations/calendar/ical";

export interface AgendaRouteEnvironment {
  Variables: {
    authPrincipal: AuthPrincipal | null;
    traceId: string;
  };
}
export interface AgendaEventMetadata {
  readonly slug: string;
  readonly name: string;
  readonly timeZone: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly scheduleDates?: readonly string[];
  readonly venueName: string | null;
}
export interface AgendaRouteDependencies {
  readonly engine: AgendaEngine;
  readonly organizationIdForEvent: (eventId: string) => Promise<string | null>;
  readonly agendaCatalogForEvent: (eventId: string) => Promise<AgendaCatalog>;
  readonly afterPublish?: (eventId: string, revision: AgendaPublishedRevision) => Promise<void>;
  readonly eventMetadataForEvent?: (eventId: string) => Promise<AgendaEventMetadata | null>;
  readonly eventIdForSlug?: (eventSlug: string) => Promise<string | null>;
  readonly getProgramPublicationManifest?: (
    eventSlug: string,
  ) => Promise<ProgramPublicationManifest | null>;
  /** Legacy projection selector retained for isolated route adapters. Runtime composition uses manifests. */
  readonly publicRevisionNumberForEventSlug?: (eventSlug: string) => Promise<number | null>;
}
export interface PublishedAgendaRouteOptions {
  readonly calendarUidDomain: string;
}

const calendarUidDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
const identifierSchema = z.string().trim().min(1).max(200);
const expectedVersionSchema = z.number().int().positive();
const createAgendaSchema = z
  .object({ minimumTravelMinutes: z.number().int().nonnegative().max(1_440) })
  .strict();
const entrySchema = z
  .object({
    id: identifierSchema,
    sessionId: identifierSchema,
    roomId: identifierSchema,
    trackIds: z.array(identifierSchema).max(100),
    startsAtLocal: z.string().trim().min(1).max(64),
    endsAtLocal: z.string().trim().min(1).max(64),
    startDisambiguation: z.enum(["earlier", "later"]).optional(),
    endDisambiguation: z.enum(["earlier", "later"]).optional(),
  })
  .strict();
const updateDraftSchema = z
  .object({ expectedVersion: expectedVersionSchema, entries: z.array(entrySchema).max(2_000) })
  .strict();
const versionSchema = z.object({ expectedVersion: expectedVersionSchema }).strict();
const overrideSchema = versionSchema
  .extend({ reason: z.string().trim().min(3).max(2_000) })
  .strict();
const rollbackSchema = versionSchema.extend({ revisionId: identifierSchema }).strict();
const suggestionRuleSchema = z.union([
  z.string().trim().min(1).max(2_000),
  z.record(z.string(), z.unknown()),
]);
const suggestionDayWindowSchema = z
  .object({
    date: z.string().trim().min(1).max(32),
    startLocal: z.string().trim().min(1).max(16),
    endLocal: z.string().trim().min(1).max(16),
  })
  .strict();
const generateSuggestionSchema = z
  .object({
    baseDraftVersion: expectedVersionSchema,
    dates: z.array(z.string().trim().min(1).max(32)).min(1).max(366),
    eligibleStatuses: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
    roomIds: z.array(identifierSchema).min(1).max(500),
    dayWindows: z.array(suggestionDayWindowSchema).min(1).max(366),
    orderedRules: z.array(suggestionRuleSchema).max(100),
    ignoreExistingTimes: z.boolean(),
    ignoreExistingRooms: z.boolean(),
  })
  .strict();
const regenerateSuggestionSchema = z.object({ baseDraftVersion: expectedVersionSchema }).strict();
const applySuggestionSchema = z
  .object({ acceptedChangeIds: z.array(identifierSchema).max(2_000) })
  .strict();
type AgendaContext = Context<AgendaRouteEnvironment>;

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 412 | 500 | 503;
interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}
class AgendaPublicationProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgendaPublicationProjectionError";
  }
}

function publicationProjectionFailure(error: unknown): AgendaPublicationProjectionError {
  const detail =
    error instanceof Error
      ? error.message
      : "The public projection could not be confirmed after publication.";
  return new AgendaPublicationProjectionError(
    `Agenda publication was persisted, but its public projection could not be confirmed: ${detail}`,
  );
}

async function completePublicationHandoff(
  dependencies: Pick<AgendaRouteDependencies, "afterPublish" | "engine">,
  eventId: string,
  revision: AgendaPublishedRevision,
): Promise<void> {
  try {
    await dependencies.afterPublish?.(eventId, revision);
    await invalidatePublishedAgendaCache(dependencies.engine, eventId, revision);
  } catch (error) {
    throw publicationProjectionFailure(error);
  }
}

function traceId(context: AgendaContext): string {
  return context.get("traceId") ?? crypto.randomUUID();
}

function errorResponse(
  context: AgendaContext,
  status: ErrorStatus,
  code:
    | "AUTHENTICATION_REQUIRED"
    | "ACCESS_DENIED"
    | "NOT_FOUND"
    | "VALIDATION_FAILED"
    | "CONFLICT"
    | "PRECONDITION_FAILED"
    | "INTEGRATION_UNAVAILABLE"
    | "INTERNAL_ERROR",
  message: string,
  details?: readonly ValidationIssue[],
): Response {
  const body = apiErrorSchema.parse({
    error: {
      code,
      message,
      traceId: traceId(context),
      ...(details === undefined ? {} : { details }),
    },
  });
  return context.json(body, status);
}

function zodDetails(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    ),
    code: issue.code,
    message: issue.message,
  }));
}

function conflictDetails(error: AgendaValidationError): ValidationIssue[] {
  return error.report.conflicts.map((conflict) => ({
    path: ["entries", ...conflict.entryIds],
    code: `agenda.${conflict.kind}`,
    message: conflict.message,
  }));
}
function staleRevisionDetails(
  message: string,
  field: "baseDraftVersion" | "expectedVersion",
): ValidationIssue[] {
  const match = /^Expected draft version (\d+), current version is (\d+)$/u.exec(message);
  if (match === null) {
    return [{ path: [field], code: "stale", message }];
  }
  return [
    {
      path: [field],
      code: "stale",
      message: `Expected draft version ${match[1]}; current draft version is ${match[2]}.`,
    },
  ];
}

function agendaErrorResponse(context: AgendaContext, error: AgendaError): Response {
  if (error instanceof AgendaEntryTemporalValidationError) {
    return errorResponse(context, 400, "VALIDATION_FAILED", error.message, [
      {
        path: ["entries", error.entryIndex, error.field],
        code: `agenda.${error.issueCode}`,
        message: error.message,
      },
    ]);
  }
  if (error instanceof AgendaValidationError) {
    return errorResponse(
      context,
      409,
      "CONFLICT",
      "The agenda contains unresolved scheduling conflicts.",
      conflictDetails(error),
    );
  }
  switch (error.code) {
    case "AGENDA_NOT_FOUND":
    case "REVISION_NOT_FOUND":
    case "WARNING_NOT_FOUND":
      return errorResponse(
        context,
        404,
        "NOT_FOUND",
        "The requested agenda resource was not found.",
      );
    case "AGENDA_ALREADY_EXISTS":
      return errorResponse(context, 409, "CONFLICT", error.message);
    case "CONCURRENT_MODIFICATION": {
      const suggestionRoute = context.req.path.includes("/suggestions");
      return errorResponse(
        context,
        suggestionRoute ? 412 : 409,
        suggestionRoute ? "PRECONDITION_FAILED" : "CONFLICT",
        suggestionRoute
          ? "The agenda suggestion base draft revision is stale."
          : "The agenda draft revision is stale.",
        staleRevisionDetails(
          error.message,
          suggestionRoute ? "baseDraftVersion" : "expectedVersion",
        ),
      );
    }
    case "PUBLICATION_BLOCKED":
      return errorResponse(context, 409, "CONFLICT", error.message);
    case "SUGGESTION_NOT_FOUND":
      return errorResponse(
        context,
        404,
        "NOT_FOUND",
        "The requested agenda suggestion run was not found.",
      );
    case "SUGGESTION_PROVIDER_UNAVAILABLE":
      return errorResponse(
        context,
        503,
        "INTEGRATION_UNAVAILABLE",
        "Agenda suggestions are temporarily unavailable.",
      );
    case "SUGGESTION_INVALID":
      return errorResponse(context, 400, "VALIDATION_FAILED", error.message);
    case "SUGGESTION_STATE_INVALID":
      return errorResponse(context, 409, "CONFLICT", error.message);
    case "INVALID_AGENDA":
      return errorResponse(context, 400, "VALIDATION_FAILED", error.message);
  }
}

function requireOrganizerPrincipal(context: AgendaContext, organizationId: string): UserPrincipal {
  const principal = context.get("authPrincipal");
  if (!principal) {
    throw new AuthAccessError("UNAUTHENTICATED", "Authentication is required.");
  }
  if (principal.kind !== "user") {
    throw new AuthAccessError("FORBIDDEN", "Organizer access requires a user session.");
  }
  const membership = principal.memberships.find(
    (candidate) => candidate.organizationId === organizationId,
  );
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    throw new AuthAccessError("FORBIDDEN", "Organizer access is required for this organization.");
  }
  return principal;
}
function routeParam(context: AgendaContext, name: string): string {
  const value = context.req.param(name);
  if (value === undefined || value.trim().length === 0) {
    throw new AgendaError("INVALID_AGENDA", `The ${name} path parameter is required.`);
  }
  return value;
}

async function requireEventOrganization(
  dependencies: AgendaRouteDependencies,
  organizationId: string,
  eventId: string,
): Promise<void> {
  const eventOrganizationId = await dependencies.organizationIdForEvent(eventId);
  if (eventOrganizationId === null || eventOrganizationId !== organizationId) {
    throw new AgendaError("AGENDA_NOT_FOUND", "The event agenda was not found.");
  }
}

async function organizerForEvent(
  context: AgendaContext,
  dependencies: AgendaRouteDependencies,
): Promise<UserPrincipal> {
  const organizationId = routeParam(context, "organizationId");
  const eventId = routeParam(context, "eventId");
  const principal = requireOrganizerPrincipal(context, organizationId);
  await requireEventOrganization(dependencies, organizationId, eventId);
  return principal;
}

async function body<T>(context: AgendaContext, schema: z.ZodType<T>): Promise<T> {
  const payload = await context.req.json().catch(() => undefined);
  return schema.parse(payload);
}
type AgendaLocalEntry = Readonly<{
  id: string;
  startsAtLocal: string;
  endsAtLocal: string;
  startDisambiguation?: "earlier" | "later" | undefined;
  endDisambiguation?: "earlier" | "later" | undefined;
}>;

function agendaDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day)
    ? value
    : null;
}

function agendaDateRange(metadata: AgendaEventMetadata): ReadonlySet<string> {
  if (metadata.scheduleDates !== undefined && metadata.scheduleDates.length > 0) {
    const dates = metadata.scheduleDates.map(agendaDate);
    if (dates.some((date) => date === null)) {
      throw new AgendaError("INVALID_AGENDA", "The event schedule dates are invalid.");
    }
    return new Set(dates as string[]);
  }
  const start = agendaDate(metadata.startsOn);
  const end = agendaDate(metadata.endsOn);
  if (start === null || end === null || start > end) {
    throw new AgendaError("INVALID_AGENDA", "The event date range is invalid.");
  }
  const dates = new Set<string>();
  for (
    let current = Date.parse(`${start}T00:00:00.000Z`);
    current <= Date.parse(`${end}T00:00:00.000Z`);
    current += 86_400_000
  ) {
    dates.add(new Date(current).toISOString().slice(0, 10));
  }
  return dates;
}

function validateAgendaEntryDates(
  metadata: AgendaEventMetadata | null,
  entries: readonly AgendaLocalEntry[],
): void {
  if (metadata === null) return;
  if (metadata.startsAt !== undefined && metadata.endsAt !== undefined) {
    validateAgendaEntriesWithinEvent(entries, {
      startsAt: metadata.startsAt,
      endsAt: metadata.endsAt,
      timeZone: metadata.timeZone,
      ...(metadata.scheduleDates === undefined ? {} : { scheduleDates: metadata.scheduleDates }),
    });
    return;
  }
  const allowedDates = agendaDateRange(metadata);
  for (const entry of entries) {
    const start = agendaDate(entry.startsAtLocal.slice(0, 10));
    const end = agendaDate(entry.endsAtLocal.slice(0, 10));
    if (start === null || end === null || start !== end) {
      throw new AgendaError(
        "INVALID_AGENDA",
        `Agenda entry ${entry.id} must start and end on the same valid calendar date.`,
      );
    }
    if (!allowedDates.has(start)) {
      throw new AgendaError(
        "INVALID_AGENDA",
        `Agenda entry ${entry.id} must fall within event dates ${metadata.startsOn} through ${metadata.endsOn}.`,
      );
    }
  }
}

async function agendaEventMetadata(
  dependencies: AgendaRouteDependencies,
  eventId: string,
): Promise<AgendaEventMetadata | null> {
  return dependencies.eventMetadataForEvent === undefined
    ? null
    : dependencies.eventMetadataForEvent(eventId);
}
function agendaRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function agendaText(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function agendaStrings(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function agendaSessionSpeakerNames(session: unknown): readonly string[] {
  const record = agendaRecord(session);
  const names = agendaStrings(record, "speakerNames").filter((name) => name.trim().length > 0);
  if (names.length > 0) return names;
  return agendaStrings(record, "participantIds").map(() => "Speaker");
}
function agendaEntrySpeakerNames(entry: unknown, session: unknown): readonly string[] {
  const stored = agendaStrings(agendaRecord(entry), "speakerNames").filter(
    (name) => name.trim().length > 0,
  );
  const current = agendaSessionSpeakerNames(session);
  const participantIds = agendaStrings(agendaRecord(session), "participantIds");
  const storedAreParticipantIds =
    stored.length > 0 &&
    stored.length === participantIds.length &&
    stored.every((name, index) => name === participantIds[index]);
  return storedAreParticipantIds && current.some((name, index) => name !== participantIds[index])
    ? current
    : stored.length > 0
      ? stored
      : current;
}

function agendaSessionFormat(session: unknown): string {
  const record = agendaRecord(session);
  return agendaText(record, "format", agendaText(record, "formatId", "Session"));
}
function isAcceptedAgendaSession(session: AgendaState["sessions"][number]): boolean {
  return session.status.trim().toLowerCase() === "accepted";
}

function adminAgendaPreviewView(
  preview: Awaited<ReturnType<AgendaEngine["preview"]>>,
  warningOverrides: ReadonlyMap<string, string>,
  validatedAt: string | null,
) {
  const unoverriddenWarningIds = new Set(preview.unoverriddenWarnings.map((warning) => warning.id));
  return {
    draftVersion: preview.draftVersion,
    conflicts: preview.validation.conflicts,
    releaseConflicts: preview.releaseValidation.conflicts,
    warnings: preview.validation.warnings.map((warning) => {
      const overrideReason = warningOverrides.get(warning.id);
      return {
        ...warning,
        overridden: !unoverriddenWarningIds.has(warning.id),
        ...(overrideReason === undefined ? {} : { overrideReason }),
      };
    }),
    diff: {
      added: preview.diff.addedEntryIds.length,
      changed: preview.diff.changedEntryIds.length,
      removed: preview.diff.removedEntryIds.length,
    },
    validatedAt,
  };
}
function adminAgendaWorkspaceView(
  state: AgendaState,
  published: PublishedAgendaRevision | null,
  eventMetadata: AgendaEventMetadata | null = null,
) {
  const publicEvent = published === null ? null : publishedAgendaView(published).event;
  const sessionById = new Map(state.sessions.map((session) => [session.id, session]));
  const roomById = new Map(state.rooms.map((room) => [room.id, room]));
  const trackById = new Map(state.tracks.map((track) => [track.id, track]));
  const scheduledSessionIds = new Set(state.draft.entries.map((entry) => entry.sessionId));
  const localDates = state.draft.entries
    .map((entry) => entry.startsAtLocal.slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date))
    .sort();
  const startsOn =
    eventMetadata?.startsOn ??
    publicEvent?.startsOn ??
    localDates[0] ??
    localDateInTimeZone(new Date().toISOString(), state.timeZone);
  const endsOn = eventMetadata?.endsOn ?? publicEvent?.endsOn ?? localDates.at(-1) ?? startsOn;
  const trackColors = ["#4f46e5", "#0f766e", "#b45309", "#be123c", "#6d28d9"];

  return {
    event: {
      id: state.eventId,
      name: eventMetadata?.name ?? publicEvent?.name ?? state.eventId,
      timeZone: eventMetadata?.timeZone ?? state.timeZone,
      ...(eventMetadata?.startsAt === undefined ? {} : { startsAt: eventMetadata.startsAt }),
      ...(eventMetadata?.endsAt === undefined ? {} : { endsAt: eventMetadata.endsAt }),
      startsOn,
      endsOn,
      ...(eventMetadata?.scheduleDates === undefined
        ? {}
        : { scheduleDates: eventMetadata.scheduleDates }),
    },
    draft: {
      version: state.draft.version,
      updatedAt: state.draft.updatedAt,
      updatedBy: state.draft.updatedBy,
      entries: state.draft.entries.map((entry) => {
        const stored = agendaRecord(entry);
        const session = sessionById.get(entry.sessionId);
        return {
          id: entry.id,
          sessionId: entry.sessionId,
          title: agendaText(stored, "title", session?.title ?? entry.sessionId),
          format: agendaText(stored, "format", agendaSessionFormat(session)),
          speakerNames: agendaEntrySpeakerNames(stored, session),
          roomId: entry.roomId,
          roomName: agendaText(
            stored,
            "roomName",
            roomById.get(entry.roomId)?.name ?? entry.roomId,
          ),
          trackIds: entry.trackIds,
          trackNames:
            agendaStrings(stored, "trackNames").length > 0
              ? agendaStrings(stored, "trackNames")
              : entry.trackIds.map((trackId) => trackById.get(trackId)?.name ?? trackId),
          startsAtLocal: entry.startsAtLocal,
          endsAtLocal: entry.endsAtLocal,
          ...(entry.startDisambiguation === undefined
            ? {}
            : { startDisambiguation: entry.startDisambiguation }),
          ...(entry.endDisambiguation === undefined
            ? {}
            : { endDisambiguation: entry.endDisambiguation }),
        };
      }),
    },
    validation:
      state.validatedDraftVersion === undefined || state.validatedAt === undefined
        ? null
        : {
            draftVersion: state.validatedDraftVersion,
            validatedAt: state.validatedAt,
          },
    rooms: state.rooms.map((room) => ({ id: room.id, name: room.name, capacity: room.capacity })),
    tracks: state.tracks.map((track, index) => ({
      id: track.id,
      name: track.name,
      color: trackColors[index % trackColors.length],
    })),
    acceptedSessionIds: state.sessions
      .filter((session) => isAcceptedAgendaSession(session))
      .map((session) => session.id),
    unscheduledSessions: state.sessions
      .filter((session) => isAcceptedAgendaSession(session) && !scheduledSessionIds.has(session.id))
      .map((session) => {
        const record = agendaRecord(session);
        const trackIds = agendaStrings(record, "trackIds");
        return {
          id: session.id,
          title: session.title,
          format: agendaText(record, "format", agendaSessionFormat(session)),
          durationMinutes:
            typeof session.durationMinutes === "number" ? session.durationMinutes : 30,
          speakerNames: agendaSessionSpeakerNames(session),
          capacityRequired: session.capacityRequired,
          trackIds,
          trackNames: trackIds.map((trackId) => trackById.get(trackId)?.name ?? trackId),
        };
      }),
    revisions: state.revisions.map((revision) => ({
      id: revision.id,
      number: revision.revisionNumber,
      publishedAt: revision.publishedAt,
      publishedBy: revision.publishedBy,
      sessionCount: revision.entries.length,
      current: revision.id === state.currentPublishedRevisionId,
    })),
    currentPublishedRevision:
      state.revisions
        .filter((revision) => revision.id === state.currentPublishedRevisionId)
        .map((revision) => ({
          id: revision.id,
          number: revision.revisionNumber,
          publishedAt: revision.publishedAt,
          publishedBy: revision.publishedBy,
          sessionCount: revision.entries.length,
          current: true,
        }))[0] ?? null,
  };
}

/** Organizer-only routes mounted below an organization and event path. */
export function createAgendaAdminRoutes(
  dependencies: AgendaRouteDependencies,
): Hono<AgendaRouteEnvironment> {
  const routes = new Hono<AgendaRouteEnvironment>();

  routes.use("*", async (context, next) => {
    context.header("cache-control", "private, no-store");
    await next();
  });
  routes.get("/", async (context) => {
    const organizationId = routeParam(context, "organizationId");
    const eventId = routeParam(context, "eventId");
    requireOrganizerPrincipal(context, organizationId);
    const eventAuthorization = requireEventOrganization(dependencies, organizationId, eventId);
    // Capture the state outcome without letting it outrank event-tenant authorization failures.
    const stateResultPromise = dependencies.engine.repository.load(eventId).then(
      (state) => ({ status: "loaded" as const, state }),
      (error: unknown) => ({ status: "error" as const, error }),
    );
    await eventAuthorization;
    const stateResult = await stateResultPromise;
    if (stateResult.status === "error") throw stateResult.error;
    const { state } = stateResult;
    if (state === null) {
      return errorResponse(context, 404, "NOT_FOUND", "The event agenda was not found.");
    }
    const eventMetadata =
      dependencies.eventMetadataForEvent === undefined
        ? null
        : await dependencies.eventMetadataForEvent(eventId);
    const published =
      state.currentPublishedRevisionId === null
        ? null
        : (state.revisions.find((revision) => revision.id === state.currentPublishedRevisionId) ??
          null);
    return context.json({ data: adminAgendaWorkspaceView(state, published, eventMetadata) });
  });

  routes.post("/", async (context) => {
    const principal = await organizerForEvent(context, dependencies);
    const input = await body(context, createAgendaSchema);
    const eventId = routeParam(context, "eventId");
    const catalog = await dependencies.agendaCatalogForEvent(eventId);
    const data = await dependencies.engine.createAgenda({
      eventId,
      actorId: principal.userId,
      ...catalog,
      ...input,
    });
    return context.json({ data }, 201);
  });

  routes.get("/draft", async (context) => {
    await organizerForEvent(context, dependencies);
    return context.json({
      data: await dependencies.engine.getDraft(routeParam(context, "eventId")),
    });
  });

  routes.get("/preview", async (context) => {
    await organizerForEvent(context, dependencies);
    const eventId = routeParam(context, "eventId");
    const { state, preview } = await dependencies.engine.inspectPreviewSnapshot(eventId);
    const warningOverrides = new Map(
      state.draft.warningOverrides.map((override) => [override.warningId, override.reason]),
    );
    const validatedAt =
      state.validatedDraftVersion === state.draft.version ? (state.validatedAt ?? null) : null;
    return context.json({ data: adminAgendaPreviewView(preview, warningOverrides, validatedAt) });
  });

  routes.post("/validate", async (context) => {
    const principal = await organizerForEvent(context, dependencies);
    const eventId = routeParam(context, "eventId");
    const input = await body(context, versionSchema);
    const { state, preview } = await dependencies.engine.validate({
      eventId,
      expectedVersion: input.expectedVersion,
      actorId: principal.userId,
    });
    const warningOverrides = new Map(
      state.draft.warningOverrides.map((override) => [override.warningId, override.reason]),
    );
    return context.json({
      data: adminAgendaPreviewView(preview, warningOverrides, preview.validatedAt),
    });
  });
  routes.post("/suggestions", async (context) => {
    const principal = await organizerForEvent(context, dependencies);
    const input = await body(context, generateSuggestionSchema);
    if (input.eligibleStatuses.some((status) => status.trim().toLowerCase() !== "accepted")) {
      throw new AgendaError(
        "SUGGESTION_INVALID",
        "Agenda suggestions can only place accepted sessions.",
      );
    }
    const data = await dependencies.engine.generateSuggestion({
      eventId: routeParam(context, "eventId"),
      actorId: principal.userId,
      baseDraftVersion: input.baseDraftVersion,
      dates: input.dates,
      eligibleStatuses: input.eligibleStatuses,
      roomIds: input.roomIds,
      dayWindows: input.dayWindows,
      orderedRules: input.orderedRules,
      ignoreExistingTimes: input.ignoreExistingTimes,
      ignoreExistingRooms: input.ignoreExistingRooms,
    });
    return context.json({ data }, 201);
  });

  routes.post("/suggestions/:runId/regenerate", async (context) => {
    const principal = await organizerForEvent(context, dependencies);
    const input = await body(context, regenerateSuggestionSchema);
    const data = await dependencies.engine.regenerateSuggestion({
      eventId: routeParam(context, "eventId"),
      runId: routeParam(context, "runId"),
      actorId: principal.userId,
      baseDraftVersion: input.baseDraftVersion,
    });
    return context.json({ data });
  });

  routes.post("/suggestions/:runId/reject", async (context) => {
    const principal = await organizerForEvent(context, dependencies);
    const data = await dependencies.engine.rejectSuggestion({
      eventId: routeParam(context, "eventId"),
      runId: routeParam(context, "runId"),
      actorId: principal.userId,
    });
    return context.json({ data });
  });

  routes.post("/suggestions/:runId/apply", async (context) => {
    const principal = await organizerForEvent(context, dependencies);
    const input = await body(context, applySuggestionSchema);
    const data = await dependencies.engine.applySuggestion({
      eventId: routeParam(context, "eventId"),
      runId: routeParam(context, "runId"),
      actorId: principal.userId,
      acceptedChangeIds: input.acceptedChangeIds,
    });
    return context.json({ data });
  });

  routes.get("/suggestions/:runId", async (context) => {
    await organizerForEvent(context, dependencies);
    const data = await dependencies.engine.getSuggestion(
      routeParam(context, "eventId"),
      routeParam(context, "runId"),
    );
    return context.json({ data });
  });

  routes.put("/draft", async (context) => {
    const principal = await organizerForEvent(context, dependencies);
    const input = await body(context, updateDraftSchema);
    const eventId = routeParam(context, "eventId");
    validateAgendaEntryDates(await agendaEventMetadata(dependencies, eventId), input.entries);
    try {
      const data = await dependencies.engine.updateDraft({
        eventId,
        actorId: principal.userId,
        expectedVersion: input.expectedVersion,
        entries: input.entries.map((entry) => ({
          id: entry.id,
          sessionId: entry.sessionId,
          roomId: entry.roomId,
          trackIds: entry.trackIds,
          startsAtLocal: entry.startsAtLocal,
          endsAtLocal: entry.endsAtLocal,
          ...(entry.startDisambiguation === undefined
            ? {}
            : { startDisambiguation: entry.startDisambiguation }),
          ...(entry.endDisambiguation === undefined
            ? {}
            : { endDisambiguation: entry.endDisambiguation }),
        })),
      });
      return context.json({ data });
    } catch (error) {
      if (!(error instanceof AgendaValidationError)) throw error;
      const { state, preview: savedPreview } =
        await dependencies.engine.inspectPreviewSnapshot(eventId);
      const validatedAt =
        state.validatedDraftVersion === state.draft.version ? (state.validatedAt ?? null) : null;
      return context.json(
        {
          error: {
            code: "CONFLICT",
            message: "The agenda contains unresolved scheduling conflicts.",
            traceId: traceId(context),
            details: conflictDetails(error),
          },
          data: {
            candidateDiagnostics: {
              evaluated: true,
              report: {
                ...error.report,
                warnings: error.report.warnings.map((warning) => ({
                  ...warning,
                  overridden: false,
                })),
              },
            },
            authoritativeSavedPreview: adminAgendaPreviewView(
              savedPreview,
              new Map(
                state.draft.warningOverrides.map((override) => [
                  override.warningId,
                  override.reason,
                ]),
              ),
              validatedAt,
            ),
          },
        },
        409,
      );
    }
  });

  routes.post("/warnings/:warningId/override", async (context) => {
    const principal = await organizerForEvent(context, dependencies);
    const input = await body(context, overrideSchema);
    const data = await dependencies.engine.overrideWarning({
      eventId: routeParam(context, "eventId"),
      actorId: principal.userId,
      warningId: routeParam(context, "warningId"),
      ...input,
    });
    return context.json({ data });
  });

  routes.post("/publish", async (context) => {
    const principal = await organizerForEvent(context, dependencies);
    const input = await body(context, versionSchema);
    const eventId = routeParam(context, "eventId");
    const state = await dependencies.engine.repository.load(eventId);
    validateAgendaEntryDates(
      await agendaEventMetadata(dependencies, eventId),
      state?.draft.entries ?? [],
    );
    const data = await dependencies.engine.publish({
      eventId,
      actorId: principal.userId,
      ...input,
      afterPublish: (revision) => completePublicationHandoff(dependencies, eventId, revision),
    });
    return context.json({ data });
  });

  routes.get("/published", async (context) => {
    await organizerForEvent(context, dependencies);
    const data = await dependencies.engine.getPublishedAgenda(routeParam(context, "eventId"));
    if (data === null) {
      return errorResponse(context, 404, "NOT_FOUND", "A published agenda was not found.");
    }
    return context.json({ data });
  });

  routes.post("/rollback", async (context) => {
    const principal = await organizerForEvent(context, dependencies);
    const input = await body(context, rollbackSchema);
    const eventId = routeParam(context, "eventId");
    const data = await dependencies.engine.rollback({
      eventId,
      actorId: principal.userId,
      ...input,
      afterRollback: (revision) => completePublicationHandoff(dependencies, eventId, revision),
    });
    return context.json({ data });
  });

  routes.onError((error, context) => {
    if (error instanceof ZodError) {
      return errorResponse(
        context,
        400,
        "VALIDATION_FAILED",
        "The agenda request is invalid.",
        zodDetails(error),
      );
    }
    if (error instanceof AuthAccessError) {
      return errorResponse(
        context,
        error.status,
        error.code === "UNAUTHENTICATED" ? "AUTHENTICATION_REQUIRED" : "ACCESS_DENIED",
        error.message,
      );
    }
    if (error instanceof AgendaPublicationProjectionError) {
      return errorResponse(context, 503, "INTEGRATION_UNAVAILABLE", error.message);
    }
    if (error instanceof AgendaError) {
      return agendaErrorResponse(context, error);
    }
    throw error;
  });

  return routes;
}
type PublishedAgendaRevision = NonNullable<Awaited<ReturnType<AgendaEngine["getPublishedAgenda"]>>>;
type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function firstTextValue(
  sources: readonly (JsonRecord | null)[],
  keys: readonly string[],
): string | null {
  for (const source of sources) {
    if (source === null) continue;
    for (const key of keys) {
      const value = textValue(source[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function stringArrayValue(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const item of value) {
    const normalized = textValue(item);
    if (normalized === null) return null;
    values.push(normalized);
  }
  return values;
}

function firstStringArrayValue(
  sources: readonly (JsonRecord | null)[],
  keys: readonly string[],
): readonly string[] | null {
  for (const source of sources) {
    if (source === null) continue;
    for (const key of keys) {
      const value = stringArrayValue(source[key]);
      if (value !== null && value.length > 0) return value;
    }
  }
  return null;
}
function speakerArrayValue(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const name = textValue(item);
      if (name === null) return null;
      names.push(name);
      continue;
    }
    const record = asRecord(item);
    const name =
      record === null ? null : firstTextValue([record], ["name", "displayName", "fullName"]);
    if (name === null) return null;
    names.push(name);
  }
  return names;
}

function firstSpeakerNamesValue(
  sources: readonly (JsonRecord | null)[],
  keys: readonly string[],
): readonly string[] | null {
  for (const source of sources) {
    if (source === null) continue;
    for (const key of keys) {
      const value = speakerArrayValue(source[key]);
      if (value !== null && value.length > 0) return value;
    }
  }
  return null;
}

function humanizeIdentifier(value: string): string {
  const words = value
    .trim()
    .split(/[-_.\s]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return "Unknown";
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

function dateValue(value: unknown): string | null {
  const normalized = textValue(value);
  if (normalized === null) return null;
  const datePrefix = /^(\d{4}-\d{2}-\d{2})/u.exec(normalized)?.[1];
  if (datePrefix !== undefined) {
    const [year, month, day] = datePrefix.split("-").map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === (month ?? 1) - 1 &&
      date.getUTCDate() === day
    ) {
      return datePrefix;
    }
    return null;
  }
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString().slice(0, 10);
}

function entryDate(
  entries: readonly { readonly startsAt: unknown; readonly endsAt: unknown }[],
  field: "startsAt" | "endsAt",
  direction: "first" | "last",
  timeZone = "UTC",
): string | null {
  const dates = entries
    .map((entry) => {
      const timestamp = Date.parse(String(entry[field]));
      if (Number.isNaN(timestamp)) return dateValue(entry[field]);
      const parts = new Intl.DateTimeFormat("en", {
        calendar: "iso8601",
        day: "2-digit",
        month: "2-digit",
        numberingSystem: "latn",
        timeZone,
        year: "numeric",
      }).formatToParts(new Date(timestamp));
      const valueFor = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((part) => part.type === type)?.value ?? "";
      const date = `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`;
      return /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : dateValue(entry[field]);
    })
    .filter((date): date is string => date !== null)
    .sort((left, right) => left.localeCompare(right));
  return direction === "first" ? (dates[0] ?? null) : (dates.at(-1) ?? null);
}

function entryMetadataSources(entry: PublishedAgendaRevision["entries"][number]): JsonRecord[] {
  const metadata = asRecord(entry.metadata);
  return metadata === null ? [] : [metadata];
}

function isRecord(value: JsonRecord | null): value is JsonRecord {
  return value !== null;
}

function eventMetadataSources(revision: PublishedAgendaRevision): JsonRecord[] {
  const record = asRecord(revision);
  if (record === null) return [];
  const metadata = asRecord(record.metadata);
  return [
    asRecord(record.event),
    asRecord(record.eventMetadata),
    asRecord(record.publicEvent),
    asRecord(metadata?.event),
    asRecord(metadata?.eventMetadata),
    asRecord(metadata?.publicEvent),
    metadata,
    record,
  ].filter(isRecord);
}

function publishedEntryView(entry: PublishedAgendaRevision["entries"][number]) {
  const metadata = entryMetadataSources(entry);
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    title: firstTextValue(metadata, ["title"]) ?? "",
    summary: firstTextValue(metadata, ["summary"]) ?? "",
    format: firstTextValue(metadata, ["format"]) ?? "Session",
    speakerNames: firstSpeakerNamesValue(metadata, ["speakerNames"]) ?? [],
    roomName: firstTextValue(metadata, ["roomName"]) ?? "",
    trackIds: [...entry.trackIds],
    trackNames: firstStringArrayValue(metadata, ["trackNames"]) ?? [],
    startsAt: entry.startsAt,
    endsAt: entry.endsAt,
  };
}

function publishedAgendaView(revision: PublishedAgendaRevision) {
  const eventMetadata = eventMetadataSources(revision);
  const entries = revision.entries.map((entry) => publishedEntryView(entry));
  const publishedDate = dateValue(revision.publishedAt);
  const timeZone =
    firstTextValue(eventMetadata, ["timeZone", "eventTimeZone"]) ??
    textValue(revision.timeZone) ??
    "UTC";
  return {
    event: {
      slug: firstTextValue(eventMetadata, ["slug", "eventSlug"]) ?? revision.eventId,
      name:
        firstTextValue(eventMetadata, ["name", "eventName"]) ??
        humanizeIdentifier(revision.eventId),
      timeZone,
      startsOn:
        dateValue(firstTextValue(eventMetadata, ["startsOn", "eventStartsOn"])) ??
        entryDate(entries, "startsAt", "first", timeZone) ??
        publishedDate ??
        "",
      endsOn:
        dateValue(firstTextValue(eventMetadata, ["endsOn", "eventEndsOn"])) ??
        entryDate(entries, "endsAt", "last", timeZone) ??
        publishedDate ??
        "",
      venueName: firstTextValue(eventMetadata, ["venueName", "eventVenueName"]),
    },
    revision: {
      id: revision.id,
      number: revision.revisionNumber,
      publishedAt: revision.publishedAt,
    },
    entries,
  };
}

const PUBLIC_AGENDA_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=30, must-revalidate";
const publicEventSlugSchema = z.string().trim().min(1).max(200);
type PublishedAgendaProjection = ReturnType<typeof publishedAgendaView>;
type PublishedAgendaProjectionValue = {
  readonly eventId: string;
  readonly eventSlug: string;
  readonly revisionNumber: number;
  readonly projection: PublishedAgendaProjection;
};
const PUBLIC_CACHE_ORIGIN = "https://eventloom-public-cache.invalid";
const PUBLIC_AGENDA_CACHE_TTL_MS = 60_000;
const PUBLIC_AGENDA_CACHE_MAX_ENTRIES = 128;
const PUBLIC_AGENDA_CACHE_MAX_BYPASS_ENTRIES = 256;
const PUBLIC_AGENDA_CACHE_PATH_PREFIX = "/api/public/events/";
const PUBLIC_AGENDA_REVISION_HEADER = "x-sessionboard-agenda-revision";
const PUBLIC_PROGRAM_REVISION_HEADER = "x-sessionboard-program-revision";
const PUBLIC_CACHE_REVISION_HEADER = "x-sessionboard-cache-revision";

interface PublicResponseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

interface AgendaCachedResponse {
  readonly body: string;
  readonly contentType: string;
  readonly etag: string;
  readonly revisionNumber: number;
  readonly programRevision: number;
  readonly cacheRevision: number;
}

interface AgendaCacheEntry extends AgendaCachedResponse {
  readonly eventId: string;
  readonly eventSlug: string;
  readonly expiresAt: number;
}

interface AgendaCacheState {
  readonly entries: Map<string, AgendaCacheEntry>;
  readonly bypassed: Set<string>;
  readonly generations: Map<string, number>;
  readonly persistence: Map<string, Promise<void>>;
  readonly minimumCacheRevisions: Map<string, number>;
  readonly latestCacheRevisions: Map<string, number>;
}

const agendaCacheStates = new WeakMap<object, AgendaCacheState>();
const agendaCacheIndex = new Map<
  string,
  { readonly eventId: string; readonly expiresAt: number }
>();

function workerResponseCache(): PublicResponseCache | null {
  const workerCaches = (
    globalThis as unknown as {
      caches?: { readonly default?: PublicResponseCache };
    }
  ).caches;
  return workerCaches?.default ?? null;
}

function agendaCacheState(engine: AgendaEngine): AgendaCacheState {
  const key = engine as unknown as object;
  const existing = agendaCacheStates.get(key);
  if (existing !== undefined) return existing;
  const created: AgendaCacheState = {
    entries: new Map(),
    bypassed: new Set(),
    generations: new Map(),
    persistence: new Map(),
    minimumCacheRevisions: new Map(),
    latestCacheRevisions: new Map(),
  };
  agendaCacheStates.set(key, created);
  return created;
}

function publicCachePath(context: AgendaContext): string {
  return new URL(context.req.url).pathname;
}

function publicCacheRequest(pathname: string): Request {
  return new Request(`${PUBLIC_CACHE_ORIGIN}${pathname}`, { method: "GET" });
}

function anonymousAgendaRequest(context: AgendaContext): boolean {
  const principal = context.get("authPrincipal");
  return principal === null || principal === undefined;
}

function publicAgendaPath(eventSlug: string, suffix: "" | ".json" | ".ics"): string {
  return `${PUBLIC_AGENDA_CACHE_PATH_PREFIX}${encodeURIComponent(eventSlug)}/agenda${suffix}`;
}

function agendaCacheResponseHeaders(entry: AgendaCachedResponse): Headers {
  return new Headers({
    "cache-control": PUBLIC_AGENDA_CACHE_CONTROL,
    "content-type": entry.contentType,
    etag: entry.etag,
    [PUBLIC_AGENDA_REVISION_HEADER]: String(entry.revisionNumber),
    [PUBLIC_PROGRAM_REVISION_HEADER]: String(entry.programRevision),
    [PUBLIC_CACHE_REVISION_HEADER]: String(entry.cacheRevision),
  });
}

function agendaCacheResponse(entry: AgendaCachedResponse): Response {
  return new Response(entry.body, { status: 200, headers: agendaCacheResponseHeaders(entry) });
}

function removeExpiredAgendaEntries(state: AgendaCacheState, now = Date.now()): void {
  for (const [path, entry] of state.entries) {
    if (entry.expiresAt > now) continue;
    state.entries.delete(path);
    agendaCacheIndex.delete(path);
  }
}

function rememberAgendaCacheEntry(
  state: AgendaCacheState,
  path: string,
  entry: AgendaCacheEntry,
): void {
  for (const [indexedPath, indexed] of agendaCacheIndex) {
    if (indexed.expiresAt <= Date.now()) agendaCacheIndex.delete(indexedPath);
  }
  removeExpiredAgendaEntries(state);
  state.entries.set(path, entry);
  agendaCacheIndex.set(path, { eventId: entry.eventId, expiresAt: entry.expiresAt });
  while (state.entries.size > PUBLIC_AGENDA_CACHE_MAX_ENTRIES) {
    const oldestPath = state.entries.keys().next().value;
    if (typeof oldestPath !== "string") break;
    state.entries.delete(oldestPath);
    agendaCacheIndex.delete(oldestPath);
  }
}

function agendaCacheRevision(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const revision = Number(raw);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function agendaCacheMatchesManifest(
  entry: AgendaCachedResponse,
  manifest: ProgramPublicationManifest,
): boolean {
  return (
    entry.revisionNumber === manifest.agendaRevisionNumber &&
    entry.programRevision === manifest.revision &&
    entry.cacheRevision === manifest.cacheRevision
  );
}

async function readAgendaCacheResponse(
  state: AgendaCacheState,
  path: string,
  servedManifest?: ProgramPublicationManifest,
): Promise<AgendaCachedResponse | null> {
  if (state.bypassed.has(path)) {
    removeExpiredAgendaEntries(state);
    return null;
  }
  removeExpiredAgendaEntries(state);
  const memoryEntry = state.entries.get(path);
  if (memoryEntry !== undefined) {
    if (servedManifest === undefined || agendaCacheMatchesManifest(memoryEntry, servedManifest)) {
      return memoryEntry;
    }
    state.entries.delete(path);
    agendaCacheIndex.delete(path);
  }
  const workerCache = workerResponseCache();
  if (workerCache !== null) {
    try {
      const cacheRequest = publicCacheRequest(path);
      const cached = await workerCache.match(cacheRequest);
      if (cached !== undefined && cached.status === 200) {
        const etag = cached.headers.get("etag");
        const contentType = cached.headers.get("content-type");
        const revisionNumber = agendaCacheRevision(cached.headers, PUBLIC_AGENDA_REVISION_HEADER);
        const programRevision = agendaCacheRevision(cached.headers, PUBLIC_PROGRAM_REVISION_HEADER);
        const cacheRevision = agendaCacheRevision(cached.headers, PUBLIC_CACHE_REVISION_HEADER);
        if (
          etag !== null &&
          contentType !== null &&
          revisionNumber !== null &&
          programRevision !== null &&
          cacheRevision !== null
        ) {
          const entry: AgendaCachedResponse = {
            body: await cached.clone().text(),
            contentType,
            etag,
            revisionNumber,
            programRevision,
            cacheRevision,
          };
          if (servedManifest === undefined || agendaCacheMatchesManifest(entry, servedManifest)) {
            return entry;
          }
        }
        await workerCache.delete(cacheRequest);
      }
    } catch {
      // Cache API failures must never turn a public read into an error.
    }
  }
  return null;
}

function nextAgendaCacheGeneration(state: AgendaCacheState, path: string): number {
  const generation = (state.generations.get(path) ?? 0) + 1;
  state.generations.set(path, generation);
  return generation;
}

function enqueueAgendaCacheOperation(
  state: AgendaCacheState,
  path: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = state.persistence.get(path) ?? Promise.resolve();
  const persistence = previous
    .catch(() => undefined)
    .then(operation)
    .catch(() => undefined);
  state.persistence.set(path, persistence);
  void persistence.finally(() => {
    if (state.persistence.get(path) === persistence) state.persistence.delete(path);
  });
  return persistence;
}

function scheduleAgendaCachePut(
  context: AgendaContext,
  state: AgendaCacheState,
  workerCache: PublicResponseCache,
  path: string,
  entry: AgendaCacheEntry,
  generation: number,
): void {
  const persistence = enqueueAgendaCacheOperation(state, path, async () => {
    if (state.generations.get(path) !== generation) return;
    await workerCache.put(publicCacheRequest(path), agendaCacheResponse(entry));
    if (state.generations.get(path) !== generation && state.bypassed.has(path)) {
      await workerCache.delete(publicCacheRequest(path));
    }
  });
  try {
    context.executionCtx.waitUntil(persistence);
  } catch {
    // Hono tests and local invocations may not attach an execution context.
  }
}

function writeAgendaCacheResponse(
  context: AgendaContext,
  state: AgendaCacheState,
  path: string,
  entry: AgendaCacheEntry,
): void {
  if ((state.minimumCacheRevisions.get(path) ?? 0) > entry.cacheRevision) return;
  if ((state.latestCacheRevisions.get(path) ?? 0) > entry.cacheRevision) return;
  state.latestCacheRevisions.set(path, entry.cacheRevision);
  const generation = nextAgendaCacheGeneration(state, path);
  state.bypassed.delete(path);
  rememberAgendaCacheEntry(state, path, entry);
  const workerCache = workerResponseCache();
  if (workerCache === null) return;
  scheduleAgendaCachePut(context, state, workerCache, path, entry, generation);
}

export async function invalidatePublishedAgendaCache(
  engine: AgendaEngine,
  eventId: string,
  revision: PublishedAgendaRevision,
  cacheRevision?: number,
): Promise<void> {
  const state = agendaCacheStates.get(engine as unknown as object);
  const paths = new Set<string>();
  if (state !== undefined) {
    for (const [path, entry] of state.entries) {
      if (entry.eventId !== eventId) continue;
      paths.add(path);
      state.entries.delete(path);
      agendaCacheIndex.delete(path);
    }
  }
  const candidateSlugs = new Set([eventId]);
  try {
    candidateSlugs.add(publishedAgendaView(revision).event.slug);
  } catch {
    // Cache invalidation is best effort and must not make publication fail.
  }
  for (const slug of candidateSlugs) {
    for (const suffix of ["", ".json", ".ics"] as const) {
      paths.add(publicAgendaPath(slug, suffix));
    }
  }
  for (const [path, indexed] of agendaCacheIndex) {
    if (indexed.eventId !== eventId) continue;
    paths.add(path);
    agendaCacheIndex.delete(path);
  }
  if (state !== undefined) {
    for (const path of paths) {
      state.bypassed.add(path);
      nextAgendaCacheGeneration(state, path);
      state.minimumCacheRevisions.set(
        path,
        Math.max(
          state.minimumCacheRevisions.get(path) ?? 0,
          cacheRevision ?? revision.revisionNumber,
        ),
      );
    }
    while (state.bypassed.size > PUBLIC_AGENDA_CACHE_MAX_BYPASS_ENTRIES) {
      const oldestPath = state.bypassed.values().next().value;
      if (typeof oldestPath !== "string") break;
      state.bypassed.delete(oldestPath);
    }
  }
  const workerCache = workerResponseCache();
  if (workerCache === null) return;
  await Promise.all(
    [...paths].map(async (path) => {
      try {
        await workerCache.delete(publicCacheRequest(path));
      } catch {
        // Cache API failures must not make publication fail.
      }
    }),
  );
}

function publicEventSlug(context: AgendaContext): string | null {
  const parsed = publicEventSlugSchema.safeParse(context.req.param("eventSlug"));
  return parsed.success ? parsed.data : null;
}

function publishedAgendaWithEventMetadata(
  projection: PublishedAgendaProjection,
  eventMetadata: AgendaEventMetadata,
): PublishedAgendaProjection {
  return {
    ...projection,
    event: {
      ...projection.event,
      slug: eventMetadata.slug,
      name: eventMetadata.name,
      timeZone: eventMetadata.timeZone,
      startsOn: eventMetadata.startsOn,
      endsOn: eventMetadata.endsOn,
      venueName: eventMetadata.venueName,
    },
  };
}

function publicProjectionForSlug(
  revision: PublishedAgendaRevision,
  eventSlug: string,
  eventMetadata?: AgendaEventMetadata,
): PublishedAgendaProjection | null {
  const baseProjection = publishedAgendaView(revision);
  const projection =
    eventMetadata === undefined
      ? baseProjection
      : publishedAgendaWithEventMetadata(baseProjection, eventMetadata);
  return projection.event.slug.toLowerCase() === eventSlug.toLowerCase() ? projection : null;
}

async function feedEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `"${hash}"`;
}

function ifNoneMatchMatches(context: AgendaContext, etag: string): boolean {
  const header = context.req.header("if-none-match");
  if (header === undefined) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => {
      if (candidate === "*") return true;
      const normalized = candidate.replace(/^W\//u, "");
      return normalized === etag;
    });
}

function feedResponse(
  context: AgendaContext,
  body: string,
  contentType: string,
  etag: string,
): Response {
  const headers = new Headers({
    "cache-control": PUBLIC_AGENDA_CACHE_CONTROL,
    "content-type": contentType,
    etag,
  });
  if (ifNoneMatchMatches(context, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

function encodeCalendarUidPart(value: string): string {
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

function publicCalendarUid(
  eventSlug: string,
  sessionId: string,
  calendarUidDomain: string,
): string {
  return `${encodeCalendarUidPart(eventSlug)}.${encodeCalendarUidPart(
    sessionId,
  )}@${calendarUidDomain}`;
}

interface IcalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function publicCalendarTimeZone(value: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: value });
    const resolved = formatter.resolvedOptions().timeZone;
    return resolved === undefined || /[\r\n]/u.test(resolved) ? "UTC" : resolved;
  } catch {
    return "UTC";
  }
}

function calendarDateTimeParts(value: string, timeZone: string): IcalDateTimeParts {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    calendar: "iso8601",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    numberingSystem: "latn",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });
  const values = new Map<string, number>();
  for (const part of formatter.formatToParts(new Date(timestamp))) {
    if (part.type !== "literal") values.set(part.type, Number(part.value));
  }
  return {
    year: values.get("year") ?? 1970,
    month: values.get("month") ?? 1,
    day: values.get("day") ?? 1,
    hour: values.get("hour") ?? 0,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
  };
}

function formatCalendarDateTime(parts: IcalDateTimeParts): string {
  return `${String(parts.year).padStart(4, "0")}${String(parts.month).padStart(
    2,
    "0",
  )}${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(
    2,
    "0",
  )}${String(parts.minute).padStart(2, "0")}${String(parts.second).padStart(2, "0")}`;
}

function formatCalendarUtcDateTime(value: string): string {
  const timestamp = Date.parse(value);
  const date = Number.isNaN(timestamp) ? new Date(0) : new Date(timestamp);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}${String(
    date.getUTCMonth() + 1,
  ).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}T${String(
    date.getUTCHours(),
  ).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}${String(
    date.getUTCSeconds(),
  ).padStart(2, "0")}Z`;
}

function publicAgendaCalendar(
  projection: PublishedAgendaProjection,
  eventSlug: string,
  calendarUidDomain: string,
): string {
  const timeZone = publicCalendarTimeZone(projection.event.timeZone);
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Eventloom//Public Agenda//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcalText(projection.event.name)}`,
    `X-WR-TIMEZONE:${escapeIcalText(timeZone)}`,
  ];
  for (const entry of projection.entries) {
    const description = [
      entry.summary,
      entry.speakerNames.length === 0 ? "" : `Speakers: ${entry.speakerNames.join(", ")}`,
    ]
      .filter((value) => value.length > 0)
      .join("\n\n");
    const location = entry.roomName || projection.event.venueName || "";
    const startsAt = formatCalendarDateTime(calendarDateTimeParts(entry.startsAt, timeZone));
    const endsAt = formatCalendarDateTime(calendarDateTimeParts(entry.endsAt, timeZone));
    lines.push(
      "BEGIN:VEVENT",
      `UID:${publicCalendarUid(eventSlug, entry.sessionId, calendarUidDomain)}`,
      `DTSTAMP:${formatCalendarUtcDateTime(projection.revision.publishedAt)}`,
      `DTSTART;TZID=${timeZone}:${startsAt}`,
      `DTEND;TZID=${timeZone}:${endsAt}`,
      `SUMMARY:${escapeIcalText(entry.title)}`,
      `DESCRIPTION:${escapeIcalText(description)}`,
      `LOCATION:${escapeIcalText(location)}`,
      ...(entry.speakerNames.length === 0
        ? []
        : [`X-EVENTLOOM-SPEAKERS:${escapeIcalText(entry.speakerNames.join(", "))}`]),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.flatMap((line) => foldIcalLine(line)).join("\r\n")}\r\n`;
}

async function publishedProjection(
  context: AgendaContext,
  dependencies: Pick<
    AgendaRouteDependencies,
    | "engine"
    | "eventMetadataForEvent"
    | "eventIdForSlug"
    | "getProgramPublicationManifest"
    | "publicRevisionNumberForEventSlug"
  >,
  servedManifest?: ProgramPublicationManifest,
): Promise<PublishedAgendaProjectionValue | null> {
  const eventSlug = publicEventSlug(context);
  if (eventSlug === null) return null;
  let revision: PublishedAgendaRevision | null;
  if (dependencies.getProgramPublicationManifest !== undefined) {
    const manifest =
      servedManifest ?? (await dependencies.getProgramPublicationManifest(eventSlug));
    if (manifest === null || manifest.lifecycle !== "served") return null;
    const eventId =
      dependencies.eventIdForSlug === undefined
        ? manifest.eventId
        : await dependencies.eventIdForSlug(eventSlug);
    if (eventId === null || eventId !== manifest.eventId) return null;
    revision = await dependencies.engine.getPublishedAgendaRevision(
      eventId,
      manifest.agendaRevisionNumber,
    );
    if (revision === null || revision.id !== manifest.agendaProjectionId) return null;
  } else {
    revision = await dependencies.engine.getPublishedAgenda(eventSlug);
    if (revision === null) return null;
    if (dependencies.publicRevisionNumberForEventSlug !== undefined) {
      const publicRevisionNumber = await dependencies.publicRevisionNumberForEventSlug(eventSlug);
      if (publicRevisionNumber === null) return null;
      if (publicRevisionNumber !== revision.revisionNumber) {
        revision = await dependencies.engine.getPublishedAgendaRevision(
          eventSlug,
          publicRevisionNumber,
        );
        if (revision === null) return null;
      }
    }
  }
  let eventMetadata: AgendaEventMetadata | undefined;
  if (dependencies.eventMetadataForEvent !== undefined) {
    const resolved = await dependencies.eventMetadataForEvent(revision.eventId);
    if (resolved === null || resolved === undefined) return null;
    eventMetadata = resolved;
  }
  const projection = publicProjectionForSlug(revision, eventSlug, eventMetadata);
  return projection === null
    ? null
    : { eventId: revision.eventId, eventSlug, revisionNumber: revision.revisionNumber, projection };
}

/** Anonymous routes expose only the immutable current publication, never a draft. */
export function createPublishedAgendaRoutes(
  dependencies: Pick<
    AgendaRouteDependencies,
    | "engine"
    | "eventMetadataForEvent"
    | "eventIdForSlug"
    | "getProgramPublicationManifest"
    | "publicRevisionNumberForEventSlug"
  > &
    PublishedAgendaRouteOptions,
): Hono<AgendaRouteEnvironment> {
  const routes = new Hono<AgendaRouteEnvironment>();
  const calendarUidDomain = calendarUidDomainSchema.parse(dependencies.calendarUidDomain);
  const cacheState = agendaCacheState(dependencies.engine);
  const projectionForRequest = (
    context: AgendaContext,
    servedManifest?: ProgramPublicationManifest,
  ): Promise<PublishedAgendaProjectionValue | null> =>
    publishedProjection(context, dependencies, servedManifest);
  const publicNotFound = (context: AgendaContext): Response => {
    const response = errorResponse(context, 404, "NOT_FOUND", "A published agenda was not found.");
    response.headers.set("cache-control", "no-store");
    return response;
  };

  const cachedFeed = async (
    context: AgendaContext,
    contentType: string,
    render: (result: PublishedAgendaProjectionValue) => string,
  ): Promise<Response> => {
    const cacheable = anonymousAgendaRequest(context);
    const path = publicCachePath(context);
    let servedManifest: ProgramPublicationManifest | undefined;
    if (dependencies.getProgramPublicationManifest !== undefined) {
      const eventSlug = publicEventSlug(context);
      if (eventSlug === null) {
        return publicNotFound(context);
      }
      const manifest = await dependencies.getProgramPublicationManifest(eventSlug);
      if (manifest === null || manifest.lifecycle !== "served") {
        return publicNotFound(context);
      }
      servedManifest = manifest;
    }
    if (cacheable) {
      const cached = await readAgendaCacheResponse(cacheState, path, servedManifest);
      if (cached !== null)
        return feedResponse(context, cached.body, cached.contentType, cached.etag);
    }
    const result = await projectionForRequest(context, servedManifest);
    if (result === null) {
      return publicNotFound(context);
    }
    const body = render(result);
    const etag = await feedEtag(body);
    if (cacheable) {
      writeAgendaCacheResponse(context, cacheState, path, {
        body,
        contentType,
        etag,
        eventId: result.eventId,
        eventSlug: result.eventSlug,
        revisionNumber: result.revisionNumber,
        programRevision: servedManifest?.revision ?? result.revisionNumber,
        cacheRevision: servedManifest?.cacheRevision ?? result.revisionNumber,
        expiresAt: Date.now() + PUBLIC_AGENDA_CACHE_TTL_MS,
      });
    }
    return feedResponse(context, body, contentType, etag);
  };

  const jsonRoute = (context: AgendaContext): Promise<Response> =>
    cachedFeed(context, "application/json; charset=utf-8", (result) =>
      JSON.stringify({ data: result.projection }),
    );
  const icsRoute = (context: AgendaContext): Promise<Response> =>
    cachedFeed(context, "text/calendar; charset=utf-8", (result) =>
      publicAgendaCalendar(result.projection, result.eventSlug, calendarUidDomain),
    );
  routes.get("/agenda", jsonRoute);
  routes.get("/agenda.json", jsonRoute);
  routes.get("/agenda.ics", icsRoute);
  routes.onError((error, context) => {
    if (error instanceof AgendaError) {
      return agendaErrorResponse(context, error);
    }
    throw error;
  });
  return routes;
}
