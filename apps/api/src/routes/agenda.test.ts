import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgendaCatalog,
  type AgendaDraft,
  AgendaEngine,
  type AgendaIdGenerator,
  type AgendaSuggestionProvider,
  type AgendaSuggestionRun,
  InMemoryAgendaMutationLock,
  InMemoryAgendaRepository,
} from "../features/agenda";
import type { AgendaState, PublishedAgendaRevision } from "../features/agenda/types";
import type { AuthPrincipal } from "../features/auth/types";
import type { ProgramPublicationManifest } from "../features/events/types";
import type { AgendaRouteDependencies, AgendaRouteEnvironment } from "./agenda";
import { createAgendaAdminRoutes, createPublishedAgendaRoutes } from "./agenda";

afterEach(() => {
  vi.unstubAllGlobals();
});

const traceId = "00000000-0000-4000-8000-000000000001";
const calendarUidDomain = "calendar.example.test";
const catalog: AgendaCatalog = {
  sessions: [
    {
      id: "session-1",
      title: "Opening",
      status: "accepted",
      publicApprovalEligible: true,
      participantIds: ["participant-1"],
      resourceIds: [],
      capacityRequired: 40,
    },
    {
      id: "session-2",
      title: "Panel",
      status: "accepted",
      publicApprovalEligible: true,
      participantIds: ["participant-2"],
      resourceIds: [],
      capacityRequired: 40,
    },
    {
      id: "session-3",
      title: "Deep dive",
      status: "accepted",
      publicApprovalEligible: true,
      participantIds: ["participant-3"],
      resourceIds: [],
      capacityRequired: 40,
    },
  ],
  rooms: [
    { id: "room-large", name: "Large room", capacity: 200 },
    { id: "room-small", name: "Small room", capacity: 100 },
  ],
  tracks: [],
};

const suggestionRequest = {
  baseDraftVersion: 1,
  dates: ["2026-08-10"],
  eligibleStatuses: ["accepted"],
  roomIds: ["room-large"],
  dayWindows: [{ date: "2026-08-10", startLocal: "09:00", endLocal: "17:00" }],
  orderedRules: ["avoid conflicts"],
  ignoreExistingTimes: false,
  ignoreExistingRooms: false,
};

function principal(organizationId = "org-a"): AuthPrincipal {
  return {
    kind: "user",
    sessionId: "session-auth",
    userId: "organizer-1",
    email: "organizer@example.com",
    memberships: [{ organizationId, role: "admin" }],
    speakerGrants: [],
    reviewerGrants: [],
  };
}

function createEngine(
  provider?: AgendaSuggestionProvider,
  eventSchedule: {
    startsAt: string;
    endsAt: string;
    timeZone: string;
    scheduleDates?: readonly string[];
  } = {
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2028-01-01T00:00:00.000Z",
    timeZone: "UTC",
  },
): AgendaEngine {
  let sequence = 0;
  const idGenerator: AgendaIdGenerator = {
    nextId: (prefix) => `${prefix}-${++sequence}`,
  };
  return new AgendaEngine(new InMemoryAgendaRepository(), new InMemoryAgendaMutationLock(), {
    idGenerator,
    ...(provider === undefined ? {} : { suggestionProvider: provider }),
    eventScheduleForEvent: async () => eventSchedule,
  });
}

async function initialize(
  engine: AgendaEngine,
  agendaCatalog: AgendaCatalog = catalog,
): Promise<void> {
  await engine.createAgenda({
    eventId: "event-a",
    actorId: "organizer-1",
    minimumTravelMinutes: 0,
    ...agendaCatalog,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function providerWithPlacements(
  placements = [
    {
      sessionId: "session-1",
      roomId: "room-large",
      startsAtLocal: "2026-08-10T09:00",
      endsAtLocal: "2026-08-10T10:00",
    },
    {
      sessionId: "session-2",
      roomId: "room-large",
      startsAtLocal: "2026-08-10T11:00",
      endsAtLocal: "2026-08-10T12:00",
    },
  ],
): AgendaSuggestionProvider {
  return { suggest: () => ({ placements }) };
}

function appFor(
  engine: AgendaEngine,
  authenticatedPrincipal: AuthPrincipal | null = principal(),
  eventOrganizationId = "org-a",
  afterPublish?: AgendaRouteDependencies["afterPublish"],
  eventMetadataForEvent?: AgendaRouteDependencies["eventMetadataForEvent"],
  agendaCatalogForEvent: AgendaRouteDependencies["agendaCatalogForEvent"] = async () => catalog,
): Hono<AgendaRouteEnvironment> {
  const app = new Hono<AgendaRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("authPrincipal", authenticatedPrincipal);
    context.set("traceId", traceId);
    await next();
  });
  app.route(
    "/api/admin/organizations/:organizationId/events/:eventId/agenda",
    createAgendaAdminRoutes({
      engine,
      organizationIdForEvent: async () => eventOrganizationId,
      agendaCatalogForEvent,
      ...(afterPublish === undefined ? {} : { afterPublish }),
      ...(eventMetadataForEvent === undefined ? {} : { eventMetadataForEvent }),
    }),
  );
  return app;
}

function appForReadProfile(
  engine: AgendaEngine,
  organizationIdForEvent: AgendaRouteDependencies["organizationIdForEvent"],
  authenticatedPrincipal: AuthPrincipal | null = principal(),
): Hono<AgendaRouteEnvironment> {
  const app = new Hono<AgendaRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("authPrincipal", authenticatedPrincipal);
    context.set("traceId", traceId);
    await next();
  });
  app.route(
    "/api/admin/organizations/:organizationId/events/:eventId/agenda",
    createAgendaAdminRoutes({
      engine,
      organizationIdForEvent,
      agendaCatalogForEvent: async () => catalog,
    }),
  );
  return app;
}
function appForWithPublic(
  engine: AgendaEngine,
  authenticatedPrincipal: AuthPrincipal | null = principal(),
  eventOrganizationId = "org-a",
  afterPublish?: AgendaRouteDependencies["afterPublish"],
  eventMetadataForEvent?: AgendaRouteDependencies["eventMetadataForEvent"],
): Hono<AgendaRouteEnvironment> {
  const app = appFor(engine, authenticatedPrincipal, eventOrganizationId, afterPublish);
  app.route(
    "/api/public/events/:eventSlug",
    createPublishedAgendaRoutes({
      engine,
      calendarUidDomain,
      ...(eventMetadataForEvent === undefined ? {} : { eventMetadataForEvent }),
    }),
  );
  return app;
}
function publicAppFor(
  engine: AgendaEngine,
  eventMetadataForEvent?: AgendaRouteDependencies["eventMetadataForEvent"],
  publicRevisionNumberForEventSlug?: AgendaRouteDependencies["publicRevisionNumberForEventSlug"],
  getProgramPublicationManifest?: AgendaRouteDependencies["getProgramPublicationManifest"],
  eventIdForSlug?: AgendaRouteDependencies["eventIdForSlug"],
): Hono<AgendaRouteEnvironment> {
  const app = new Hono<AgendaRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("authPrincipal", null);
    context.set("traceId", traceId);
    await next();
  });
  app.route(
    "/api/public/events/:eventSlug",
    createPublishedAgendaRoutes({
      engine,
      calendarUidDomain,
      ...(eventMetadataForEvent === undefined ? {} : { eventMetadataForEvent }),
      ...(publicRevisionNumberForEventSlug === undefined
        ? {}
        : { publicRevisionNumberForEventSlug }),
      ...(getProgramPublicationManifest === undefined ? {} : { getProgramPublicationManifest }),
      ...(eventIdForSlug === undefined ? {} : { eventIdForSlug }),
    }),
  );
  return app;
}

function publicRevision(): PublishedAgendaRevision {
  return {
    id: "revision-public-4",
    eventId: "event-public",
    revisionNumber: 4,
    sourceDraftVersion: 7,
    timeZone: "America/Los_Angeles",
    entries: [
      {
        id: "entry-public-1",
        sessionId: "session-public-1",
        roomId: "room-main",
        trackIds: ["track-main"],
        startsAt: "2026-09-18T16:00:00.000Z",
        endsAt: "2026-09-18T16:45:00.000Z",
        startsAtLocal: "2026-09-18T09:00",
        endsAtLocal: "2026-09-18T09:45",
        timeZone: "America/Los_Angeles",
        metadata: {
          title: "A session, with; punctuation \\\\",
          summary: "Description with a long speaker and room value ".repeat(8),
          speakerNames: ["Morgan Lee", "Avery Kim"],
          roomName: "Main hall, level 2",
          privateNote: "Do not publish this note.",
          participantEmails: ["private@example.test"],
        },
      },
    ],
    warningOverrides: [],
    publishedAt: "2026-08-08T12:00:00.000Z",
    publishedBy: "organizer-private",
    rollbackOfRevisionId: null,
    metadata: {
      slug: "open-systems",
      name: "Open Systems Summit",
      venueName: "Pier 27",
      organizationId: "tenant-private",
      privateNote: "Private event metadata.",
    },
  } as unknown as PublishedAgendaRevision;
}

function publicEngine(revision: PublishedAgendaRevision | null): AgendaEngine {
  return {
    getPublishedAgenda: async (eventSlug: string) =>
      eventSlug === "open-systems" ? revision : null,
  } as unknown as AgendaEngine;
}

function servedManifest(revision: PublishedAgendaRevision): ProgramPublicationManifest {
  return {
    id: "program-publication-4",
    organizationId: "tenant-private",
    eventId: revision.eventId,
    revision: 4,
    lifecycle: "served",
    agendaProjectionId: revision.id,
    agendaRevisionNumber: revision.revisionNumber,
    agendaSourceHash: "agenda-source-hash",
    speakerProjectionId: "speaker-projection-4",
    speakerRevisionNumber: 4,
    speakerSourceHash: "speaker-source-hash",
    approvedContentRevision: 4,
    approvedProfileRevision: 4,
    releasedAssetRevision: 4,
    actorId: "organizer-private",
    publishedAt: revision.publishedAt,
    parentServedRevision: null,
    rollbackTargetRevision: null,
    cacheRevision: 4,
    sourceTrigger: "initial-publication",
    failureReason: null,
  };
}

async function postSuggestion(
  app: Hono<AgendaRouteEnvironment>,
  path: string,
  payload: unknown,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
async function responseData<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

async function responseError(response: Response): Promise<{
  code: string;
  details?: readonly {
    path?: readonly (string | number)[];
    code?: string;
    message: string;
  }[];
}> {
  return (
    (await response.json()) as {
      error: {
        code: string;
        details?: readonly {
          path?: readonly (string | number)[];
          code?: string;
          message: string;
        }[];
      };
    }
  ).error;
}

describe("canonical agenda draft routes", () => {
  it("overlaps the successful ownership and agenda reads exactly once", async () => {
    const sourceEngine = createEngine();
    await initialize(sourceEngine);
    const state = await sourceEngine.repository.load("event-a");
    if (state === null) throw new Error("Expected agenda state.");

    const ownershipRead = deferred<string | null>();
    const agendaRead = deferred<AgendaState | null>();
    const started: string[] = [];
    const organizationIdForEvent = vi.fn(() => {
      started.push("event-ownership");
      return ownershipRead.promise;
    });
    const load = vi.fn(() => {
      started.push("agenda-state");
      return agendaRead.promise;
    });
    const engine = { repository: { load } } as unknown as AgendaEngine;
    const app = appForReadProfile(engine, organizationIdForEvent);
    let settled = false;
    const responsePromise = Promise.resolve(
      app.request("/api/admin/organizations/org-a/events/event-a/agenda"),
    ).then((response) => {
      settled = true;
      return response;
    });

    await vi.waitFor(() => expect(started).toEqual(["event-ownership", "agenda-state"]));
    expect(organizationIdForEvent).toHaveBeenCalledTimes(1);
    expect(organizationIdForEvent).toHaveBeenCalledWith("event-a");
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("event-a");

    agendaRead.resolve(state);
    await Promise.resolve();
    expect(settled).toBe(false);

    ownershipRead.resolve("org-a");
    const response = await responsePromise;
    expect(response.status).toBe(200);
  });

  it("does not start workspace reads before organization membership is authorized", async () => {
    const organizationIdForEvent = vi.fn(async () => "org-a");
    const load = vi.fn(async () => null);
    const engine = { repository: { load } } as unknown as AgendaEngine;
    const app = appForReadProfile(engine, organizationIdForEvent, principal("org-b"));

    const response = await app.request("/api/admin/organizations/org-a/events/event-a/agenda");

    expect(response.status).toBe(403);
    expect(organizationIdForEvent).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("preserves event-tenant not-found precedence over a failed agenda read", async () => {
    const organizationIdForEvent = vi.fn(async () => "org-b");
    const load = vi.fn(async () => {
      throw new Error("Airtable agenda read failed");
    });
    const engine = { repository: { load } } as unknown as AgendaEngine;
    const app = appForReadProfile(engine, organizationIdForEvent);

    const response = await app.request("/api/admin/organizations/org-a/events/event-a/agenda");

    expect(response.status).toBe(404);
    expect(await responseError(response)).toMatchObject({ code: "NOT_FOUND" });
    expect(organizationIdForEvent).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("rejects caller-supplied catalogs and uses the authoritative catalog when creating an agenda", async () => {
    const eventSchedule = {
      startsAt: "2026-08-10T16:00:00.000Z",
      endsAt: "2026-08-10T23:00:00.000Z",
      timeZone: "America/Los_Angeles",
    };
    const authoritativeCatalog: AgendaCatalog = {
      ...catalog,
      sessions: catalog.sessions.map((session) =>
        session.id === "session-1"
          ? { ...session, title: "Authoritative opening", publicApprovalEligible: false }
          : session,
      ),
    };
    const agendaCatalogForEvent = vi.fn(async () => authoritativeCatalog);
    const engine = createEngine(undefined, eventSchedule);
    const app = appFor(engine, principal(), "org-a", undefined, undefined, agendaCatalogForEvent);
    const root = "/api/admin/organizations/org-a/events/event-a/agenda";

    const tampered = await app.request(root, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...catalog,
        sessions: catalog.sessions.map((session) => ({
          ...session,
          publicApprovalEligible: true,
        })),
        minimumTravelMinutes: 0,
      }),
    });
    expect(tampered.status).toBe(400);
    expect(agendaCatalogForEvent).not.toHaveBeenCalled();

    const created = await app.request(root, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ minimumTravelMinutes: 0 }),
    });
    expect(created.status).toBe(201);
    expect(await responseData<AgendaDraft>(created)).toMatchObject({
      timeZone: "America/Los_Angeles",
    });
    expect(agendaCatalogForEvent).toHaveBeenCalledWith("event-a");
    expect((await engine.repository.load("event-a"))?.sessions[0]).toMatchObject({
      id: "session-1",
      title: "Authoritative opening",
      publicApprovalEligible: false,
    });
  });

  it("uses authoritative event metadata for an empty organizer workspace", async () => {
    const eventMetadata = {
      slug: "devflow-conf-2027",
      name: "DevFlow Conf 2027",
      timeZone: "America/Los_Angeles",
      startsAt: "2027-05-12T16:30:00.000Z",
      endsAt: "2027-05-15T00:30:00.000Z",
      startsOn: "2027-05-12",
      endsOn: "2027-05-14",
      scheduleDates: ["2027-05-12", "2027-05-14"],
      venueName: "DevFlow venue",
    } as const;
    const engine = createEngine(undefined, eventMetadata);
    await initialize(engine);
    const eventMetadataForEvent = vi.fn(async () => eventMetadata);
    const app = appFor(engine, principal(), "org-a", undefined, eventMetadataForEvent);

    const response = await app.request("/api/admin/organizations/org-a/events/event-a/agenda");

    expect(response.status).toBe(200);
    const data = await responseData<{
      event: {
        id: string;
        name: string;
        timeZone: string;
        startsAt: string;
        endsAt: string;
        startsOn: string;
        endsOn: string;
        scheduleDates: readonly string[];
      };
      draft: { entries: readonly unknown[] };
    }>(response);
    expect(data.event).toEqual({
      id: "event-a",
      name: "DevFlow Conf 2027",
      timeZone: "America/Los_Angeles",
      startsAt: "2027-05-12T16:30:00.000Z",
      endsAt: "2027-05-15T00:30:00.000Z",
      startsOn: "2027-05-12",
      endsOn: "2027-05-14",
      scheduleDates: ["2027-05-12", "2027-05-14"],
    });
    expect(data.draft.entries).toHaveLength(0);
    expect(eventMetadataForEvent).toHaveBeenCalledTimes(1);
    expect(eventMetadataForEvent).toHaveBeenCalledWith("event-a");
  });

  it("falls back to draft dates when event metadata is unavailable", async () => {
    const engine = createEngine();
    await initialize(engine);
    const eventMetadataForEvent = vi.fn(async () => null);
    const app = appFor(engine, principal(), "org-a", undefined, eventMetadataForEvent);
    const response = await app.request(
      "/api/admin/organizations/org-a/events/event-a/agenda/draft",
      { method: "GET" },
    );
    expect(response.status).toBe(200);

    const draft = await responseData<AgendaDraft>(response);
    const updated = await app.request(
      "/api/admin/organizations/org-a/events/event-a/agenda/draft",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: draft.version,
          entries: [
            {
              id: "entry-fallback",
              sessionId: "session-1",
              roomId: "room-large",
              trackIds: [],
              startsAtLocal: "2026-08-10T09:00",
              endsAtLocal: "2026-08-10T10:00",
            },
          ],
        }),
      },
    );
    expect(updated.status).toBe(200);

    const workspace = await app.request("/api/admin/organizations/org-a/events/event-a/agenda");
    expect(workspace.status).toBe(200);
    const data = await responseData<{
      event: { startsOn: string; endsOn: string; timeZone: string };
    }>(workspace);
    expect(data.event).toMatchObject({
      startsOn: "2026-08-10",
      endsOn: "2026-08-10",
      timeZone: "UTC",
    });
    expect(eventMetadataForEvent).toHaveBeenCalledTimes(2);
  });
  it("enforces authoritative event instants and sparse dates with field-level DST errors", async () => {
    const metadata = async () => ({
      slug: "devflow-conf-2027",
      name: "DevFlow Conf 2027",
      timeZone: "America/Los_Angeles",
      startsAt: "2027-05-12T16:30:00.000Z",
      endsAt: "2027-05-15T00:30:00.000Z",
      startsOn: "2027-05-12",
      endsOn: "2027-05-14",
      scheduleDates: ["2027-05-12", "2027-05-14"],
      venueName: "DevFlow venue",
    });
    const root = "/api/admin/organizations/org-a/events/event-a/agenda";
    const entry = (startsAtLocal: string, endsAtLocal: string) => ({
      id: "entry-date-range",
      sessionId: "session-1",
      roomId: "room-large",
      trackIds: [],
      startsAtLocal,
      endsAtLocal,
    });

    const engine = createEngine(undefined, await metadata());
    await initialize(engine);
    const app = appFor(engine, principal(), "org-a", undefined, metadata);
    const valid = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        entries: [entry("2027-05-14T09:00", "2027-05-14T10:00")],
      }),
    });
    expect(valid.status).toBe(200);

    for (const invalidEntry of [
      entry("2026-08-12T09:00", "2026-08-12T10:00"),
      entry("2027-05-12T09:00", "2027-05-12T10:00"),
      entry("2027-05-13T09:00", "2027-05-13T10:00"),
      entry("2027-05-14T17:00", "2027-05-14T18:00"),
      entry("2027-05-12T23:30", "2027-05-13T00:30"),
    ]) {
      const response = await app.request(`${root}/draft`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2, entries: [invalidEntry] }),
      });
      expect(response.status).toBe(400);
      expect(await responseError(response)).toMatchObject({ code: "VALIDATION_FAILED" });
    }

    const legacyEngine = createEngine();
    await initialize(legacyEngine);
    const legacyApp = appFor(legacyEngine);
    const legacyWrite = await legacyApp.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        entries: [entry("2026-08-12T09:00", "2026-08-12T10:00")],
      }),
    });
    expect(legacyWrite.status).toBe(200);

    const guardedApp = appFor(legacyEngine, principal(), "org-a", undefined, metadata);
    await engine.validate({
      eventId: "event-a",
      expectedVersion: 2,
      actorId: "organizer-a",
    });
    const publish = await guardedApp.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(publish.status).toBe(400);
    expect(await responseError(publish)).toMatchObject({ code: "VALIDATION_FAILED" });

    const foldMetadata = async () => ({
      slug: "fall-back",
      name: "Fall Back",
      timeZone: "America/Los_Angeles",
      startsAt: "2026-11-01T07:00:00.000Z",
      endsAt: "2026-11-01T12:00:00.000Z",
      startsOn: "2026-11-01",
      endsOn: "2026-11-01",
      scheduleDates: ["2026-11-01"],
      venueName: null,
    });
    const foldEngine = createEngine(undefined, await foldMetadata());
    await initialize(foldEngine);
    const foldApp = appFor(foldEngine, principal(), "org-a", undefined, foldMetadata);
    const ambiguous = await foldApp.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        entries: [entry("2026-11-01T01:30", "2026-11-01T02:15")],
      }),
    });
    expect(ambiguous.status).toBe(400);
    expect(await responseError(ambiguous)).toMatchObject({
      code: "VALIDATION_FAILED",
      details: [
        {
          path: ["entries", 0, "startsAtLocal"],
          code: "agenda.ambiguous_local_time",
        },
      ],
    });

    const resolved = await foldApp.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        entries: [
          {
            ...entry("2026-11-01T01:30", "2026-11-01T02:15"),
            startDisambiguation: "later",
          },
        ],
      }),
    });
    expect(resolved.status).toBe(200);
    const foldWorkspace = await foldApp.request(root);
    expect(foldWorkspace.status).toBe(200);
    expect(
      await responseData<{ draft: { entries: readonly Record<string, unknown>[] } }>(foldWorkspace),
    ).toMatchObject({
      draft: { entries: [{ startDisambiguation: "later" }] },
    });
  });
  it("projects the root workspace and supports full-draft create/update/remove, preview, and publish", async () => {
    const engine = createEngine();
    await initialize(engine);
    const afterPublish = vi.fn(async () => undefined);
    const app = appFor(engine, principal(), "org-a", afterPublish);
    const root = "/api/admin/organizations/org-a/events/event-a/agenda";
    const entry = {
      id: "entry-1",
      sessionId: "session-1",
      roomId: "room-large",
      trackIds: [],
      startsAtLocal: "2026-08-10T09:00",
      endsAtLocal: "2026-08-10T10:00",
    };
    const updatedEntry = {
      ...entry,
      roomId: "room-small",
      startsAtLocal: "2026-08-10T11:00",
      endsAtLocal: "2026-08-10T12:00",
    };

    const created = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, entries: [entry] }),
    });
    expect(created.status).toBe(200);
    expect(await responseData<AgendaDraft>(created)).toMatchObject({
      version: 2,
      entries: [{ id: "entry-1", sessionId: "session-1" }],
    });

    const projected = await app.request(root);
    expect(projected.status).toBe(200);
    expect(
      await responseData<{
        event: { id: string; timeZone: string };
        draft: { version: number; entries: readonly Record<string, unknown>[] };
        unscheduledSessions: readonly { id: string }[];
      }>(projected),
    ).toMatchObject({
      event: { id: "event-a", timeZone: "UTC" },
      draft: {
        version: 2,
        entries: [
          {
            id: "entry-1",
            sessionId: "session-1",
            title: "Opening",
            roomName: "Large room",
            startsAtLocal: "2026-08-10T09:00:00",
          },
        ],
      },
      unscheduledSessions: [{ id: "session-2" }, { id: "session-3" }],
    });

    const preview = await app.request(`${root}/preview`);
    expect(preview.status).toBe(200);
    expect(
      await responseData<{
        draftVersion: number;
        conflicts: readonly unknown[];
        warnings: readonly unknown[];
        diff: { added: number; changed: number; removed: number };
        validatedAt: string | null;
      }>(preview),
    ).toMatchObject({
      draftVersion: 2,
      conflicts: [],
      warnings: [],
      diff: { added: 1, changed: 0, removed: 0 },
      validatedAt: null,
    });
    const previewedWorkspace = await app.request(root);
    expect(previewedWorkspace.status).toBe(200);
    expect(
      await responseData<{
        draft: { version: number };
        validation: { draftVersion: number; validatedAt: string } | null;
      }>(previewedWorkspace),
    ).toMatchObject({
      draft: { version: 2 },
      validation: null,
    });
    const validation = await app.request(`${root}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(validation.status).toBe(200);
    expect(
      await responseData<{ draftVersion: number; validatedAt: string | null }>(validation),
    ).toMatchObject({
      draftVersion: 2,
      validatedAt: expect.any(String),
    });
    const validatedWorkspace = await app.request(root);
    expect(validatedWorkspace.status).toBe(200);
    expect(
      await responseData<{
        draft: { version: number };
        validation: { draftVersion: number; validatedAt: string } | null;
      }>(validatedWorkspace),
    ).toMatchObject({
      draft: { version: 2 },
      validation: { draftVersion: 2, validatedAt: expect.any(String) },
    });
    const previewAlias = await app.request(`${root}/preview`, { method: "POST" });
    expect(previewAlias.status).toBe(404);

    const updated = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, entries: [updatedEntry] }),
    });
    expect(updated.status).toBe(200);
    expect(await responseData<AgendaDraft>(updated)).toMatchObject({
      version: 3,
      entries: [{ roomId: "room-small", startsAtLocal: "2026-08-10T11:00:00" }],
    });
    const invalidatedWorkspace = await app.request(root);
    expect(invalidatedWorkspace.status).toBe(200);
    expect(
      await responseData<{
        draft: { version: number };
        validation: { draftVersion: number; validatedAt: string } | null;
      }>(invalidatedWorkspace),
    ).toMatchObject({
      draft: { version: 3 },
      validation: { draftVersion: 2, validatedAt: expect.any(String) },
    });
    const unchanged = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3, entries: [updatedEntry] }),
    });
    expect(unchanged.status).toBe(200);
    expect(await responseData<AgendaDraft>(unchanged)).toMatchObject({
      version: 3,
      entries: [{ roomId: "room-small", startsAtLocal: "2026-08-10T11:00:00" }],
    });

    const unvalidatedPublish = await app.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3 }),
    });
    expect(unvalidatedPublish.status).toBe(409);
    expect(await responseError(unvalidatedPublish)).toMatchObject({
      code: "CONFLICT",
      message: "Validate the exact current agenda draft before publishing.",
    });
    const staleValidation = await app.request(`${root}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(staleValidation.status).toBe(409);
    const revalidated = await app.request(`${root}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3 }),
    });
    expect(revalidated.status).toBe(200);
    const published = await app.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3 }),
    });
    expect(published.status).toBe(200);
    expect(await responseData<{ eventId: string }>(published)).toMatchObject({
      eventId: "event-a",
    });
    expect(afterPublish).toHaveBeenCalledWith(
      "event-a",
      expect.objectContaining({ eventId: "event-a", revisionNumber: 1 }),
    );
    const publishedWorkspace = await app.request(root);
    expect(publishedWorkspace.status).toBe(200);
    expect(
      await responseData<{
        draft: { version: number };
        validation: { draftVersion: number; validatedAt: string } | null;
      }>(publishedWorkspace),
    ).toMatchObject({
      draft: { version: 3 },
      validation: { draftVersion: 3, validatedAt: expect.any(String) },
    });

    const removed = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3, entries: [] }),
    });
    expect(removed.status).toBe(200);
    expect(await responseData<AgendaDraft>(removed)).toMatchObject({
      version: 4,
      entries: [],
    });

    const stale = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, entries: [] }),
    });
    expect(stale.status).toBe(409);
    expect(await responseError(stale)).toMatchObject({
      code: "CONFLICT",
      details: [
        {
          path: ["expectedVersion"],
          code: "stale",
          message: "Expected draft version 1; current draft version is 4.",
        },
      ],
    });

    const publicationAlias = await app.request(`${root}/publications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 4 }),
    });
    expect(publicationAlias.status).toBe(404);
    const entryAlias = await app.request(`${root}/draft/entries`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 4, entries: [] }),
    });
    expect(entryAlias.status).toBe(404);
  });
  it("invalidates the cached public projection before publish settles", async () => {
    const engine = createEngine();
    await initialize(engine);
    const app = appForWithPublic(engine);
    const root = "/api/admin/organizations/org-a/events/event-a/agenda";
    const publicPath = "/api/public/events/event-a/agenda.json";
    const firstEntry = {
      id: "entry-1",
      sessionId: "session-1",
      roomId: "room-large",
      trackIds: [],
      startsAtLocal: "2026-08-10T09:00",
      endsAtLocal: "2026-08-10T10:00",
    };
    const secondEntry = {
      ...firstEntry,
      roomId: "room-small",
      startsAtLocal: "2026-08-10T11:00",
      endsAtLocal: "2026-08-10T12:00",
    };
    const update = (expectedVersion: number, entries: readonly object[]) =>
      app.request(`${root}/draft`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion, entries }),
      });

    expect((await update(1, [firstEntry])).status).toBe(200);
    await engine.validate({
      eventId: "event-a",
      expectedVersion: 2,
      actorId: "organizer-a",
    });
    const firstPublish = await app.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(firstPublish.status).toBe(200);
    const firstPublic = await app.request(publicPath);
    expect(firstPublic.status).toBe(200);
    expect(
      (await responseData<{ revision: { number: number } }>(firstPublic)).revision.number,
    ).toBe(1);

    expect((await update(2, [secondEntry])).status).toBe(200);
    const cachedOldPublic = await app.request(publicPath);
    expect(
      (await responseData<{ revision: { number: number } }>(cachedOldPublic)).revision.number,
    ).toBe(1);

    await engine.validate({
      eventId: "event-a",
      expectedVersion: 3,
      actorId: "organizer-a",
    });
    const secondPublish = await app.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3 }),
    });
    expect(secondPublish.status).toBe(200);
    const freshPublic = await app.request(publicPath);
    expect(freshPublic.status).toBe(200);
    expect(
      await responseData<{
        revision: { number: number };
        entries: readonly { startsAt: string }[];
      }>(freshPublic),
    ).toMatchObject({
      revision: { number: 2 },
      entries: [{ startsAt: "2026-08-10T11:00:00.000Z" }],
    });
  });
  it("keeps the published revision immutable when a session later becomes ineligible", async () => {
    const engine = createEngine();
    await initialize(engine);
    const app = appForWithPublic(engine);
    const root = "/api/admin/organizations/org-a/events/event-a/agenda";
    const draft = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        entries: [
          {
            id: "entry-1",
            sessionId: "session-1",
            roomId: "room-large",
            trackIds: [],
            startsAtLocal: "2026-08-10T09:00",
            endsAtLocal: "2026-08-10T10:00",
          },
        ],
      }),
    });
    expect(draft.status).toBe(200);
    await engine.validate({
      eventId: "event-a",
      expectedVersion: 2,
      actorId: "organizer-a",
    });
    const published = await app.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(published.status).toBe(200);

    const state = await engine.repository.load("event-a");
    if (state === null) throw new Error("Expected agenda state.");
    await engine.repository.compareAndSwap("event-a", state.stateVersion, {
      ...state,
      stateVersion: state.stateVersion + 1,
      sessions: state.sessions.map((session) =>
        session.id === "session-1"
          ? { ...session, status: "ineligible", title: "Mutable replacement title" }
          : session,
      ),
      rooms: state.rooms.map((room) =>
        room.id === "room-large" ? { ...room, name: "Mutable replacement room" } : room,
      ),
    });

    const publicResponse = await app.request("/api/public/events/event-a/agenda.json");
    expect(publicResponse.status).toBe(200);
    expect(
      await responseData<{
        entries: readonly { sessionId?: string; title: string; roomName: string }[];
        revision: { number: number };
      }>(publicResponse),
    ).toMatchObject({
      entries: [{ sessionId: "session-1", title: "Opening", roomName: "Large room" }],
      revision: { number: 1 },
    });
  });
  it("reports projection failures and retries the handoff without duplicating publication", async () => {
    const engine = createEngine();
    await initialize(engine);
    let failHandoff = true;
    const afterPublish = vi.fn(async () => {
      if (failHandoff) {
        failHandoff = false;
        throw new Error("speaker projection write failed");
      }
    });
    const app = appFor(engine, principal(), "org-a", afterPublish);
    const root = "/api/admin/organizations/org-a/events/event-a/agenda";
    const entry = {
      id: "entry-1",
      sessionId: "session-1",
      roomId: "room-large",
      trackIds: [],
      startsAtLocal: "2026-08-10T09:00",
      endsAtLocal: "2026-08-10T10:00",
    };
    const updated = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, entries: [entry] }),
    });
    expect(updated.status).toBe(200);

    await engine.validate({
      eventId: "event-a",
      expectedVersion: 2,
      actorId: "organizer-a",
    });
    const published = await app.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(published.status).toBe(503);
    expect(await responseError(published)).toMatchObject({
      code: "INTEGRATION_UNAVAILABLE",
    });
    expect((await engine.getPublishedAgenda("event-a"))?.revisionNumber).toBe(1);
    const persisted = await engine.repository.load("event-a");
    if (persisted === null) throw new Error("Expected persisted agenda state.");
    const {
      validatedDraftVersion: _validatedDraftVersion,
      validatedAt: _validatedAt,
      ...withoutValidation
    } = persisted;
    await engine.repository.compareAndSwap("event-a", persisted.stateVersion, {
      ...withoutValidation,
      stateVersion: persisted.stateVersion + 1,
    });
    const blockedRetry = await app.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(blockedRetry.status).toBe(409);
    expect(afterPublish).toHaveBeenCalledTimes(1);
    await engine.validate({
      eventId: "event-a",
      expectedVersion: 2,
      actorId: "organizer-a",
    });
    const retried = await app.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(retried.status).toBe(200);
    expect(afterPublish).toHaveBeenCalledTimes(2);
    expect((await engine.repository.load("event-a"))?.revisions).toHaveLength(1);
  });

  it("returns active released speaker commitments separately and blocks publication", async () => {
    const engine = createEngine();
    await initialize(engine, {
      ...catalog,
      sessions: catalog.sessions.map((session) =>
        session.id === "session-3" ? { ...session, participantIds: ["participant-1"] } : session,
      ),
    });
    const app = appFor(engine);
    const root = "/api/admin/organizations/org-a/events/event-a/agenda";
    const releasedEntry = {
      id: "entry-1",
      sessionId: "session-1",
      roomId: "room-large",
      trackIds: [],
      startsAtLocal: "2026-08-10T09:00",
      endsAtLocal: "2026-08-10T10:00",
    };
    expect(
      (
        await app.request(`${root}/draft`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: 1, entries: [releasedEntry] }),
        })
      ).status,
    ).toBe(200);
    await engine.validate({
      eventId: "event-a",
      expectedVersion: 2,
      actorId: "organizer-a",
    });
    expect(
      (
        await app.request(`${root}/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: 2 }),
        })
      ).status,
    ).toBe(200);

    const candidate = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 2,
        entries: [
          {
            ...releasedEntry,
            id: "entry-3",
            sessionId: "session-3",
            startsAtLocal: "2026-08-10T09:15",
            endsAtLocal: "2026-08-10T09:45",
          },
        ],
      }),
    });
    expect(candidate.status).toBe(200);

    const preview = await app.request(`${root}/preview`);
    expect(
      await responseData<{
        conflicts: readonly unknown[];
        releaseConflicts: readonly { kind: string; entryIds: readonly string[] }[];
      }>(preview),
    ).toMatchObject({
      conflicts: [],
      releaseConflicts: [{ kind: "participant", entryIds: ["entry-3", "entry-1"] }],
    });
    await engine.validate({
      eventId: "event-a",
      expectedVersion: 3,
      actorId: "organizer-a",
    });
    const blocked = await app.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 3 }),
    });
    expect(blocked.status).toBe(409);
    expect((await engine.getPublishedAgenda("event-a"))?.entries[0]?.sessionId).toBe("session-1");
  });
  it("maps full-draft hard conflicts to 409 without changing the version", async () => {
    const engine = createEngine();
    await initialize(engine);
    const app = appFor(engine);
    const response = await app.request(
      "/api/admin/organizations/org-a/events/event-a/agenda/draft",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: 1,
          entries: [
            {
              id: "entry-1",
              sessionId: "session-1",
              roomId: "room-large",
              trackIds: [],
              startsAtLocal: "2026-08-10T09:00",
              endsAtLocal: "2026-08-10T10:00",
            },
            {
              id: "entry-2",
              sessionId: "session-2",
              roomId: "room-large",
              trackIds: [],
              startsAtLocal: "2026-08-10T09:30",
              endsAtLocal: "2026-08-10T10:30",
            },
          ],
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        details: [{ message: expect.stringContaining("overlap") }],
      },
      data: {
        candidateDiagnostics: {
          evaluated: true,
          report: {
            conflicts: [
              expect.objectContaining({
                kind: "room",
                entryIds: ["entry-1", "entry-2"],
              }),
            ],
          },
        },
        authoritativeSavedPreview: {
          draftVersion: 1,
          conflicts: [],
        },
      },
    });
    expect((await engine.getDraft("event-a")).version).toBe(1);
  });
  it("detects room and speaker overlaps, clears them after a move, and keeps only accepted sessions unscheduled", async () => {
    const conflictCatalog: AgendaCatalog = {
      ...catalog,
      sessions: [
        ...catalog.sessions.map((session) =>
          session.id === "session-2"
            ? {
                ...session,
                participantIds: ["participant-1"],
                speakerNames: ["Grace Hopper"],
              }
            : session,
        ),
        {
          id: "session-rejected",
          title: "Not accepted",
          status: "rejected",
          publicApprovalEligible: false,
          participantIds: ["participant-4"],
          resourceIds: [],
          capacityRequired: 20,
        },
      ],
    };
    const engine = createEngine();
    await initialize(engine, conflictCatalog);
    const app = appFor(engine);
    const root = "/api/admin/organizations/org-a/events/event-a/agenda";
    const first = {
      id: "entry-1",
      sessionId: "session-1",
      roomId: "room-large",
      trackIds: [],
      startsAtLocal: "2026-08-10T09:00",
      endsAtLocal: "2026-08-10T10:00",
    };
    const colliding = {
      id: "entry-2",
      sessionId: "session-2",
      roomId: "room-large",
      trackIds: [],
      startsAtLocal: "2026-08-10T09:30",
      endsAtLocal: "2026-08-10T10:30",
    };
    const rejected = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, entries: [first, colliding] }),
    });
    expect(rejected.status).toBe(409);
    expect((await responseError(rejected)).details?.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        'Sessions "Opening" and "Panel" overlap in room "Large room"',
        'Speaker "Grace Hopper" is scheduled in overlapping sessions "Opening" and "Panel"',
      ]),
    );
    expect((await engine.getDraft("event-a")).version).toBe(1);

    const moved = await app.request(`${root}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        entries: [
          first,
          {
            ...colliding,
            roomId: "room-small",
            startsAtLocal: "2026-08-10T10:00",
            endsAtLocal: "2026-08-10T11:00",
          },
        ],
      }),
    });
    expect(moved.status).toBe(200);
    expect((await responseData<AgendaDraft>(moved)).version).toBe(2);
    const staleSpeakerState = await engine.repository.load("event-a");
    if (staleSpeakerState === null) throw new Error("Expected agenda state.");
    await engine.repository.compareAndSwap("event-a", staleSpeakerState.stateVersion, {
      ...staleSpeakerState,
      stateVersion: staleSpeakerState.stateVersion + 1,
      draft: {
        ...staleSpeakerState.draft,
        entries: staleSpeakerState.draft.entries.map((entry) =>
          entry.id === "entry-2"
            ? ({ ...entry, speakerNames: ["participant-1"] } as typeof entry)
            : entry,
        ),
      },
    });

    const preview = await app.request(`${root}/preview`);
    expect(preview.status).toBe(200);
    expect(await responseData<{ conflicts: readonly unknown[] }>(preview)).toMatchObject({
      conflicts: [],
    });
    const workspace = await app.request(root);
    const workspaceData = await responseData<{
      draft: {
        entries: readonly {
          id: string;
          speakerNames: readonly string[];
        }[];
      };
      unscheduledSessions: readonly {
        id: string;
        title: string;
        durationMinutes: number;
        format: string;
        speakerNames: readonly string[];
        capacityRequired: number;
        trackIds: readonly string[];
        trackNames: readonly string[];
      }[];
    }>(workspace);
    expect(workspaceData.draft.entries.find((entry) => entry.id === "entry-2")).toMatchObject({
      speakerNames: ["Grace Hopper"],
    });
    expect(workspaceData.unscheduledSessions).toEqual([
      {
        id: "session-3",
        title: "Deep dive",
        durationMinutes: 30,
        format: "Session",
        speakerNames: ["Speaker"],
        capacityRequired: 40,
        trackIds: [],
        trackNames: [],
      },
    ]);
    const state = await engine.repository.load("event-a");
    if (state === null) throw new Error("Expected agenda state.");
    await engine.repository.compareAndSwap("event-a", state.stateVersion, {
      ...state,
      stateVersion: state.stateVersion + 1,
      sessions: state.sessions.map((session) =>
        session.id === "session-1" ? { ...session, status: "ineligible" } : session,
      ),
    });
    await engine.validate({
      eventId: "event-a",
      expectedVersion: 2,
      actorId: "organizer-a",
    });
    const blockedPublish = await app.request(`${root}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(blockedPublish.status).toBe(409);
    expect(await responseError(blockedPublish)).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("Only accepted sessions can be published"),
    });
    await expect(engine.getPublishedAgenda("event-a")).resolves.toBeNull();
  });
});
describe("agenda suggestion admin routes", () => {
  it("uses the canonical mount, keeps generation private, and supports regenerate/reject/get", async () => {
    const engine = createEngine(providerWithPlacements());
    await initialize(engine);
    const app = appFor(engine);
    const before = await engine.getDraft("event-a");
    const workspace = await app.request("/api/admin/organizations/org-a/events/event-a/agenda");
    expect(workspace.status).toBe(200);
    expect(
      await responseData<{
        event: { id: string };
        draft: { version: number };
        rooms: readonly unknown[];
        tracks: readonly unknown[];
      }>(workspace),
    ).toMatchObject({
      event: { id: "event-a" },
      draft: { version: before.version },
      rooms: expect.any(Array),
      tracks: expect.any(Array),
    });

    const generated = await postSuggestion(
      app,
      "/api/admin/organizations/org-a/events/event-a/agenda/suggestions",
      suggestionRequest,
    );
    expect(generated.status).toBe(201);
    const run = await responseData<AgendaSuggestionRun>(generated);
    expect(run).toMatchObject({
      status: "pending",
      baseDraftVersion: before.version,
      criteria: {
        dates: suggestionRequest.dates,
        eligibleStatuses: suggestionRequest.eligibleStatuses,
        roomIds: suggestionRequest.roomIds,
        orderedRules: suggestionRequest.orderedRules,
      },
    });
    expect(run.candidateDiagnostics).toEqual({ conflicts: [], warnings: [] });
    expect(run).not.toHaveProperty("validation");
    expect(await engine.getDraft("event-a")).toEqual(before);
    expect(await engine.getPublishedAgenda("event-a")).toBeNull();

    const regenerated = await postSuggestion(
      app,
      `/api/admin/organizations/org-a/events/event-a/agenda/suggestions/${run.id}/regenerate`,
      { baseDraftVersion: before.version },
    );
    expect(regenerated.status).toBe(200);
    const regeneratedRun = await responseData<AgendaSuggestionRun>(regenerated);
    expect(regeneratedRun).toMatchObject({
      status: "pending",
      regenerationOfRunId: run.id,
      version: run.version + 1,
    });

    const rejected = await postSuggestion(
      app,
      `/api/admin/organizations/org-a/events/event-a/agenda/suggestions/${regeneratedRun.id}/reject`,
      {},
    );
    expect(rejected.status).toBe(200);
    expect(await responseData<AgendaSuggestionRun>(rejected)).toMatchObject({
      id: regeneratedRun.id,
      status: "rejected",
    });

    const fetched = await app.request(
      `/api/admin/organizations/org-a/events/event-a/agenda/suggestions/${regeneratedRun.id}`,
    );
    expect(fetched.status).toBe(200);
    expect(await responseData<AgendaSuggestionRun>(fetched)).toMatchObject({
      id: regeneratedRun.id,
      status: "rejected",
    });
  });

  it("applies only accepted changes and never publishes the private agenda", async () => {
    const engine = createEngine(providerWithPlacements());
    await initialize(engine);
    const app = appFor(engine);
    const generated = await postSuggestion(
      app,
      "/api/admin/organizations/org-a/events/event-a/agenda/suggestions",
      suggestionRequest,
    );
    const run = await responseData<AgendaSuggestionRun>(generated);
    const selectedChangeId = run.diff.changes[0]?.id;
    if (!selectedChangeId) throw new Error("Expected a suggested agenda change.");

    const applied = await postSuggestion(
      app,
      `/api/admin/organizations/org-a/events/event-a/agenda/suggestions/${run.id}/apply`,
      { acceptedChangeIds: [selectedChangeId] },
    );
    expect(applied.status).toBe(200);
    expect((await responseData<AgendaDraft>(applied)).entries).toHaveLength(1);
    expect((await engine.getDraft("event-a")).entries.map((entry) => entry.sessionId)).toEqual([
      "session-1",
    ]);
    expect((await engine.getSuggestion("event-a", run.id)).acceptedChangeIds).toEqual([
      selectedChangeId,
    ]);
    expect(await engine.getPublishedAgenda("event-a")).toBeNull();
    expect(await engine.getOutbox("event-a")).toEqual([]);
  });

  it("maps provider, stale-base, hard-conflict, invalid-change, and missing-run errors", async () => {
    const unavailableEngine = createEngine();
    await initialize(unavailableEngine);
    const unavailable = await postSuggestion(
      appFor(unavailableEngine),
      "/api/admin/organizations/org-a/events/event-a/agenda/suggestions",
      suggestionRequest,
    );
    expect(unavailable.status).toBe(503);
    expect(await responseError(unavailable)).toMatchObject({ code: "INTEGRATION_UNAVAILABLE" });

    const staleEngine = createEngine(providerWithPlacements());
    await initialize(staleEngine);
    const staleApp = appFor(staleEngine);
    const staleGenerated = await postSuggestion(
      staleApp,
      "/api/admin/organizations/org-a/events/event-a/agenda/suggestions",
      suggestionRequest,
    );
    const staleRun = await responseData<AgendaSuggestionRun>(staleGenerated);
    await staleEngine.updateDraft({
      eventId: "event-a",
      actorId: "organizer-1",
      expectedVersion: 1,
      entries: [
        {
          id: "entry-3",
          sessionId: "session-3",
          roomId: "room-large",
          trackIds: [],
          startsAtLocal: "2026-08-10T13:00",
          endsAtLocal: "2026-08-10T14:00",
        },
      ],
    });
    const stale = await postSuggestion(
      staleApp,
      `/api/admin/organizations/org-a/events/event-a/agenda/suggestions/${staleRun.id}/apply`,
      { acceptedChangeIds: [staleRun.diff.changes[0]?.id ?? "missing-change"] },
    );
    expect(stale.status).toBe(412);
    expect(await responseError(stale)).toMatchObject({
      code: "PRECONDITION_FAILED",
      details: [{ message: expect.stringContaining("current draft version is 2") }],
    });

    const conflictEngine = createEngine(
      providerWithPlacements([
        {
          sessionId: "session-2",
          roomId: "room-small",
          startsAtLocal: "2026-08-10T09:30",
          endsAtLocal: "2026-08-10T10:30",
        },
      ]),
    );
    await initialize(conflictEngine);
    await conflictEngine.updateDraft({
      eventId: "event-a",
      actorId: "organizer-1",
      expectedVersion: 1,
      entries: [
        {
          id: "entry-1",
          sessionId: "session-1",
          roomId: "room-small",
          trackIds: [],
          startsAtLocal: "2026-08-10T09:00",
          endsAtLocal: "2026-08-10T10:00",
        },
      ],
    });
    const conflictApp = appFor(conflictEngine);
    const conflictGenerated = await postSuggestion(
      conflictApp,
      "/api/admin/organizations/org-a/events/event-a/agenda/suggestions",
      { ...suggestionRequest, baseDraftVersion: 2, roomIds: ["room-small"] },
    );
    const conflictRun = await responseData<AgendaSuggestionRun>(conflictGenerated);
    expect(conflictRun.candidateDiagnostics.conflicts).toEqual([
      expect.objectContaining({ kind: "room" }),
    ]);
    const savedPreview = await conflictApp.request(
      "/api/admin/organizations/org-a/events/event-a/agenda/preview",
    );
    expect(savedPreview.status).toBe(200);
    expect(
      await responseData<{ conflicts: readonly unknown[]; releaseConflicts: readonly unknown[] }>(
        savedPreview,
      ),
    ).toMatchObject({ conflicts: [], releaseConflicts: [] });
    const conflict = await postSuggestion(
      conflictApp,
      `/api/admin/organizations/org-a/events/event-a/agenda/suggestions/${conflictRun.id}/apply`,
      { acceptedChangeIds: [conflictRun.diff.changes[0]?.id ?? "missing-change"] },
    );
    expect(conflict.status).toBe(409);
    expect(await responseError(conflict)).toMatchObject({ code: "CONFLICT" });

    const invalid = await postSuggestion(
      conflictApp,
      `/api/admin/organizations/org-a/events/event-a/agenda/suggestions/${conflictRun.id}/apply`,
      { acceptedChangeIds: ["unknown-change"] },
    );
    expect(invalid.status).toBe(400);
    expect(await responseError(invalid)).toMatchObject({ code: "VALIDATION_FAILED" });

    const missing = await appFor(conflictEngine).request(
      "/api/admin/organizations/org-a/events/event-a/agenda/suggestions/missing",
    );
    expect(missing.status).toBe(404);
    expect(await responseError(missing)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires an organizer in the event tenant", async () => {
    const engine = createEngine(providerWithPlacements());
    await initialize(engine);
    const denied = await postSuggestion(
      appFor(engine, principal("org-b")),
      "/api/admin/organizations/org-a/events/event-a/agenda/suggestions",
      suggestionRequest,
    );
    expect(denied.status).toBe(403);
    expect(await responseError(denied)).toMatchObject({ code: "ACCESS_DENIED" });

    const wrongEventTenant = await postSuggestion(
      appFor(engine, principal("org-a"), "org-b"),
      "/api/admin/organizations/org-a/events/event-a/agenda/suggestions",
      suggestionRequest,
    );
    expect(wrongEventTenant.status).toBe(404);
    expect(await responseError(wrongEventTenant)).toMatchObject({ code: "NOT_FOUND" });
  });
});
describe("anonymous published agenda feeds", () => {
  it("rejects an invalid configured calendar UID domain", () => {
    expect(() =>
      createPublishedAgendaRoutes({
        engine: publicEngine(publicRevision()),
        calendarUidDomain: "https://calendar.example.test/path",
      }),
    ).toThrow();
  });

  it("serves the public JSON projection with cache validators and excludes private fields", async () => {
    const app = publicAppFor(publicEngine(publicRevision()));
    const response = await app.request("/api/public/events/open-systems/agenda.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/u);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=30, must-revalidate",
    );
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/u);
    const body = (await response.json()) as {
      data: {
        event: Record<string, unknown>;
        revision: Record<string, unknown>;
        entries: readonly Record<string, unknown>[];
      };
    };
    expect(body.data.event).toMatchObject({
      slug: "open-systems",
      name: "Open Systems Summit",
      timeZone: "America/Los_Angeles",
    });
    expect(body.data.entries[0]).toMatchObject({
      title: "A session, with; punctuation \\\\",
      summary: expect.stringContaining("Description with a long speaker"),
      roomName: "Main hall, level 2",
      speakerNames: ["Morgan Lee", "Avery Kim"],
    });
    expect(body.data.entries[0]?.trackIds).toEqual(publicRevision().entries[0]?.trackIds);
    expect(body.data.event).not.toHaveProperty("organizationId");
    expect(body.data.event).not.toHaveProperty("privateNote");
    expect(body.data.revision).not.toHaveProperty("publishedBy");
    expect(body.data.entries[0]).not.toHaveProperty("metadata");
    expect(body.data.entries[0]).not.toHaveProperty("participantEmails");

    const cached = await app.request("/api/public/events/open-systems/agenda", {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
  });
  it("re-reads the authoritative projection across public feed formats", async () => {
    const revision = publicRevision();
    const getPublishedAgenda = vi.fn(async (eventSlug: string) =>
      eventSlug === "open-systems" ? revision : null,
    );
    const app = publicAppFor({ getPublishedAgenda } as unknown as AgendaEngine);

    expect((await app.request("/api/public/events/open-systems/agenda")).status).toBe(200);
    expect((await app.request("/api/public/events/open-systems/agenda.ics")).status).toBe(200);
    expect(getPublishedAgenda).toHaveBeenCalledTimes(2);
  });
  it("serves the agenda revision matching the authoritative public speaker projection", async () => {
    const publicRevisionFour = publicRevision();
    const publicRevisionFive = {
      ...publicRevisionFour,
      id: "revision-public-5",
      revisionNumber: 5,
      entries: publicRevisionFour.entries.map((entry) => ({
        ...entry,
        metadata: {
          ...entry.metadata,
          title: "A newer agenda that is not public yet",
        },
      })),
    } as PublishedAgendaRevision;
    const getPublishedAgenda = vi.fn(async () => publicRevisionFive);
    const getPublishedAgendaRevision = vi.fn(async (_eventSlug: string, revisionNumber: number) =>
      revisionNumber === 4 ? publicRevisionFour : null,
    );
    const publicRevisionNumberForEventSlug = vi.fn(async () => 4);
    const app = publicAppFor(
      { getPublishedAgenda, getPublishedAgendaRevision } as unknown as AgendaEngine,
      undefined,
      publicRevisionNumberForEventSlug,
    );

    const response = await app.request("/api/public/events/open-systems/agenda.json");

    expect(response.status).toBe(200);
    await expect(responseData(response)).resolves.toMatchObject({
      revision: { number: 4 },
      entries: [{ title: "A session, with; punctuation \\\\" }],
    });
    expect(getPublishedAgendaRevision).toHaveBeenCalledWith("open-systems", 4);
  });
  it("withholds the agenda when no authoritative public speaker revision exists", async () => {
    const getPublishedAgendaRevision = vi.fn();
    const app = publicAppFor(
      {
        getPublishedAgenda: async () => publicRevision(),
        getPublishedAgendaRevision,
      } as unknown as AgendaEngine,
      undefined,
      async () => null,
    );

    const response = await app.request("/api/public/events/open-systems/agenda.json");

    expect(response.status).toBe(404);
    expect(getPublishedAgendaRevision).not.toHaveBeenCalled();
  });
  it("never reads mutable agenda state while serving the published projection", async () => {
    const revision = publicRevision();
    const load = vi.fn(async () => {
      throw new Error("draft state must not be read");
    });
    const getPublishedAgenda = vi.fn(async () => revision);
    const engine = {
      repository: { load },
      getPublishedAgenda,
    } as unknown as AgendaEngine;

    const response = await publicAppFor(engine).request(
      "/api/public/events/open-systems/agenda.json",
    );

    expect(response.status).toBe(200);
    expect(load).not.toHaveBeenCalled();
    expect(getPublishedAgenda).toHaveBeenCalledWith("open-systems");
  });
  it("avoids repeated repository reads for the same anonymous format and slug", async () => {
    const revision = publicRevision();
    const getPublishedAgenda = vi.fn(async (eventSlug: string) =>
      eventSlug === "open-systems" ? revision : null,
    );
    const app = publicAppFor({ getPublishedAgenda } as unknown as AgendaEngine);

    const first = await app.request("/api/public/events/open-systems/agenda.json");
    const second = await app.request("/api/public/events/open-systems/agenda.json");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(getPublishedAgenda).toHaveBeenCalledTimes(1);
  });
  it.each(["agenda", "agenda.json", "agenda.ics"])(
    "denies a primed isolate-memory %s entry after event retirement",
    async (suffix) => {
      const revision = publicRevision();
      const manifest = servedManifest(revision);
      let retired = false;
      let agendaReads = 0;
      const manifestLookup = vi.fn(async () => (retired ? null : manifest));
      const app = publicAppFor(
        {
          async getPublishedAgendaRevision() {
            agendaReads += 1;
            return revision;
          },
        } as unknown as AgendaEngine,
        async () => ({
          slug: "open-systems",
          name: "Open Systems Summit",
          timeZone: revision.timeZone,
          startsAt: "2026-09-18T16:00:00.000Z",
          endsAt: "2026-09-18T23:00:00.000Z",
          startsOn: "2026-09-18",
          endsOn: "2026-09-18",
          scheduleDates: ["2026-09-18"],
          venueName: "Pier 27",
        }),
        undefined,
        manifestLookup,
        async () => revision.eventId,
      );

      const first = await app.request(`/api/public/events/open-systems/${suffix}`);
      expect(first.status).toBe(200);
      retired = true;

      const second = await app.request(`/api/public/events/open-systems/${suffix}`);
      expect(second.status).toBe(404);
      expect(second.headers.get("cache-control")).toBe("no-store");
      expect(agendaReads).toBe(1);
      expect(manifestLookup).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["agenda", "agenda.json", "agenda.ics"])(
    "denies a primed Cache API %s entry in a new isolate after event retirement",
    async (suffix) => {
      const revision = publicRevision();
      const manifest = servedManifest(revision);
      const cacheEntries = new Map<string, Response>();
      const cachePut = deferred<void>();
      const match = vi.fn(async (request: Request) => cacheEntries.get(request.url)?.clone());
      const put = vi.fn(async (request: Request, response: Response) => {
        cacheEntries.set(request.url, response.clone());
        cachePut.resolve();
      });
      const deleteCache = vi.fn(async () => true);
      vi.stubGlobal("caches", { default: { match, put, delete: deleteCache } });
      const eventMetadata = async () =>
        Promise.resolve({
          slug: "open-systems",
          name: "Open Systems Summit",
          timeZone: revision.timeZone,
          startsAt: "2026-09-18T16:00:00.000Z",
          endsAt: "2026-09-18T23:00:00.000Z",
          startsOn: "2026-09-18",
          endsOn: "2026-09-18",
          scheduleDates: ["2026-09-18"],
          venueName: "Pier 27",
        });

      const firstRoute = publicAppFor(
        {
          async getPublishedAgendaRevision() {
            return revision;
          },
        } as unknown as AgendaEngine,
        eventMetadata,
        undefined,
        async () => manifest,
        async () => revision.eventId,
      );
      const first = await firstRoute.request(`/api/public/events/open-systems/${suffix}`);
      expect(first.status).toBe(200);
      await cachePut.promise;
      expect(cacheEntries.size).toBe(1);

      const manifestLookup = vi.fn(async () => null);
      const retiredRoute = publicAppFor(
        {
          async getPublishedAgendaRevision() {
            throw new Error("Retired cache reads must not load an agenda revision.");
          },
        } as unknown as AgendaEngine,
        eventMetadata,
        undefined,
        manifestLookup,
        async () => revision.eventId,
      );
      const retired = await retiredRoute.request(`/api/public/events/open-systems/${suffix}`);

      expect(retired.status).toBe(404);
      expect(retired.headers.get("cache-control")).toBe("no-store");
      expect(manifestLookup).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["agenda", "agenda.json", "agenda.ics"])(
    "rejects a primed isolate-memory %s entry after the served manifest advances",
    async (suffix) => {
      const revisionFour = publicRevision();
      const revisionFive = {
        ...revisionFour,
        id: "revision-public-5",
        revisionNumber: 5,
        publishedAt: "2026-08-09T12:00:00.000Z",
      };
      let manifest = servedManifest(revisionFour);
      const getPublishedAgendaRevision = vi.fn(async (_eventId: string, revisionNumber: number) =>
        revisionNumber === revisionFive.revisionNumber ? revisionFive : revisionFour,
      );
      const app = publicAppFor(
        { getPublishedAgendaRevision } as unknown as AgendaEngine,
        async () => ({
          slug: "open-systems",
          name: "Open Systems Summit",
          timeZone: revisionFour.timeZone,
          startsAt: "2026-09-18T16:00:00.000Z",
          endsAt: "2026-09-18T23:00:00.000Z",
          startsOn: "2026-09-18",
          endsOn: "2026-09-18",
          scheduleDates: ["2026-09-18"],
          venueName: "Pier 27",
        }),
        undefined,
        async () => manifest,
        async () => revisionFour.eventId,
      );

      const first = await app.request(`/api/public/events/open-systems/${suffix}`);
      expect(first.status).toBe(200);
      const firstEtag = first.headers.get("etag");
      manifest = {
        ...servedManifest(revisionFive),
        id: "program-publication-5",
        revision: 5,
        cacheRevision: 5,
      };

      const second = await app.request(`/api/public/events/open-systems/${suffix}`);
      expect(second.status).toBe(200);
      expect(second.headers.get("etag")).not.toBe(firstEtag);
      expect(getPublishedAgendaRevision).toHaveBeenCalledTimes(2);
    },
  );
  it("repopulates agenda cache after rollback selects a lower child revision", async () => {
    const revisionFour = publicRevision();
    const revisionFive = {
      ...revisionFour,
      id: "revision-public-5",
      revisionNumber: 5,
      publishedAt: "2026-08-09T12:00:00.000Z",
    };
    let manifest = {
      ...servedManifest(revisionFive),
      id: "program-publication-5",
      revision: 5,
      cacheRevision: 5,
    };
    const getPublishedAgendaRevision = vi.fn(async (_eventId: string, revisionNumber: number) =>
      revisionNumber === revisionFive.revisionNumber ? revisionFive : revisionFour,
    );
    const app = publicAppFor(
      { getPublishedAgendaRevision } as unknown as AgendaEngine,
      async () => ({
        slug: "open-systems",
        name: "Open Systems Summit",
        timeZone: revisionFour.timeZone,
        startsAt: "2026-09-18T16:00:00.000Z",
        endsAt: "2026-09-18T23:00:00.000Z",
        startsOn: "2026-09-18",
        endsOn: "2026-09-18",
        scheduleDates: ["2026-09-18"],
        venueName: "Pier 27",
      }),
      undefined,
      async () => manifest,
      async () => revisionFour.eventId,
    );

    const first = await app.request("/api/public/events/open-systems/agenda.json");
    expect(first.status).toBe(200);
    manifest = {
      ...servedManifest(revisionFour),
      id: "program-publication-6",
      revision: 6,
      cacheRevision: 6,
    };

    const rollback = await app.request("/api/public/events/open-systems/agenda.json");
    expect(rollback.status).toBe(200);
    const cachedRollback = await app.request("/api/public/events/open-systems/agenda.json");
    expect(cachedRollback.status).toBe(200);
    expect(getPublishedAgendaRevision).toHaveBeenCalledTimes(2);
  });
  it.each(["agenda", "agenda.json", "agenda.ics"])(
    "rejects a primed Cache API %s entry in a new isolate after the served manifest advances",
    async (suffix) => {
      const revisionFour = publicRevision();
      const revisionFive = {
        ...revisionFour,
        id: "revision-public-5",
        revisionNumber: 5,
        publishedAt: "2026-08-09T12:00:00.000Z",
      };
      const manifestFour = servedManifest(revisionFour);
      const manifestFive = {
        ...servedManifest(revisionFive),
        id: "program-publication-5",
        revision: 5,
        cacheRevision: 5,
      };
      const cacheEntries = new Map<string, Response>();
      const cachePut = deferred<void>();
      vi.stubGlobal("caches", {
        default: {
          match: vi.fn(async (request: Request) => cacheEntries.get(request.url)?.clone()),
          put: vi.fn(async (request: Request, response: Response) => {
            cacheEntries.set(request.url, response.clone());
            cachePut.resolve();
          }),
          delete: vi.fn(async () => true),
        },
      });
      const eventMetadata = async () =>
        Promise.resolve({
          slug: "open-systems",
          name: "Open Systems Summit",
          timeZone: revisionFour.timeZone,
          startsAt: "2026-09-18T16:00:00.000Z",
          endsAt: "2026-09-18T23:00:00.000Z",
          startsOn: "2026-09-18",
          endsOn: "2026-09-18",
          scheduleDates: ["2026-09-18"],
          venueName: "Pier 27",
        });

      const firstRoute = publicAppFor(
        {
          async getPublishedAgendaRevision() {
            return revisionFour;
          },
        } as unknown as AgendaEngine,
        eventMetadata,
        undefined,
        async () => manifestFour,
        async () => revisionFour.eventId,
      );
      const first = await firstRoute.request(`/api/public/events/open-systems/${suffix}`);
      expect(first.status).toBe(200);
      const firstEtag = first.headers.get("etag");
      await cachePut.promise;
      expect(cacheEntries.size).toBe(1);

      const getPublishedAgendaRevision = vi.fn(async () => revisionFive);
      const secondRoute = publicAppFor(
        { getPublishedAgendaRevision } as unknown as AgendaEngine,
        eventMetadata,
        undefined,
        async () => manifestFive,
        async () => revisionFive.eventId,
      );
      const second = await secondRoute.request(`/api/public/events/open-systems/${suffix}`);

      expect(second.status).toBe(200);
      expect(second.headers.get("etag")).not.toBe(firstEtag);
      expect(getPublishedAgendaRevision).toHaveBeenCalledTimes(1);
    },
  );
  it("prefers an unexpired isolate-memory agenda entry before consulting Cache API", async () => {
    const match = vi.fn(async () => undefined as Response | undefined);
    const put = vi.fn(async () => undefined);
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", { default: { match, put, delete: deleteCache } });
    let releaseMatch: ((value: Response | undefined) => void) | undefined;
    const blockedMatch = new Promise<Response | undefined>((resolve) => {
      releaseMatch = resolve;
    });

    try {
      const getPublishedAgenda = vi.fn(async () => publicRevision());
      const app = publicAppFor({ getPublishedAgenda } as unknown as AgendaEngine);
      const path = "/api/public/events/open-systems/agenda.json";

      const first = await app.request(path);
      expect(first.status).toBe(200);

      match.mockImplementation(() => blockedMatch);
      const second = await Promise.race([
        app.request(path),
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 100);
        }),
      ]);

      expect(second).not.toBe("timed-out");
      if (second !== "timed-out") expect(second.status).toBe(200);
      expect(match).toHaveBeenCalledTimes(1);
      expect(getPublishedAgenda).toHaveBeenCalledTimes(1);
    } finally {
      releaseMatch?.(undefined);
      vi.unstubAllGlobals();
    }
  });

  it("does not wait for a pending agenda Cache API put before responding", async () => {
    const putDeferred = deferred<void>();
    const match = vi.fn(async () => undefined as Response | undefined);
    const put = vi.fn(() => putDeferred.promise);
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", { default: { match, put, delete: deleteCache } });

    try {
      const app = publicAppFor(publicEngine(publicRevision()));
      const response = await Promise.race([
        app.request("/api/public/events/open-systems/agenda.json"),
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 100);
        }),
      ]);

      expect(response).not.toBe("timed-out");
      if (response !== "timed-out") expect(response.status).toBe(200);
      await Promise.resolve();
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      putDeferred.resolve();
      vi.unstubAllGlobals();
    }
  });
  it("removes a deferred old agenda put that completes after publication invalidation", async () => {
    const oldPut = deferred<void>();
    let cachedResponse: Response | undefined;
    let putCount = 0;
    const match = vi.fn(async () => cachedResponse?.clone());
    const put = vi.fn(async (_request: Request, response: Response) => {
      putCount += 1;
      if (putCount === 1) await oldPut.promise;
      cachedResponse = response.clone();
    });
    const deleteCache = vi.fn(async () => {
      cachedResponse = undefined;
      return true;
    });
    vi.stubGlobal("caches", { default: { match, put, delete: deleteCache } });

    try {
      const engine = createEngine();
      await initialize(engine);
      const adminApp = appFor(engine);
      const publicApp = publicAppFor(engine);
      const root = "/api/admin/organizations/org-a/events/event-a/agenda";
      const publicPath = "/api/public/events/event-a/agenda.json";
      const entry = {
        id: "entry-1",
        sessionId: "session-1",
        roomId: "room-large",
        trackIds: [],
        startsAtLocal: "2026-08-10T09:00",
        endsAtLocal: "2026-08-10T10:00",
      };
      const update = (expectedVersion: number, roomId: string) =>
        adminApp.request(`${root}/draft`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion, entries: [{ ...entry, roomId }] }),
        });
      const publish = (expectedVersion: number) =>
        adminApp.request(`${root}/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion }),
        });

      expect((await update(1, "room-large")).status).toBe(200);
      await engine.validate({
        eventId: "event-a",
        expectedVersion: 2,
        actorId: "organizer-a",
      });
      expect((await publish(2)).status).toBe(200);
      expect((await publicApp.request(publicPath)).status).toBe(200);
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));

      expect((await update(2, "room-small")).status).toBe(200);
      await engine.validate({
        eventId: "event-a",
        expectedVersion: 3,
        actorId: "organizer-a",
      });
      expect((await publish(3)).status).toBe(200);
      expect(cachedResponse).toBeUndefined();
      const deletesBeforeOldPutSettles = deleteCache.mock.calls.length;

      oldPut.resolve();
      await vi.waitFor(() =>
        expect(deleteCache.mock.calls.length).toBeGreaterThan(deletesBeforeOldPutSettles),
      );
      expect(cachedResponse).toBeUndefined();
    } finally {
      oldPut.resolve();
      vi.unstubAllGlobals();
    }
  });
  it("keeps different public agenda slugs isolated", async () => {
    const first = publicRevision();
    const second = {
      ...first,
      eventId: "event-other",
      metadata: { slug: "other-systems", name: "Other Systems" },
    } as unknown as PublishedAgendaRevision;
    const getPublishedAgenda = vi.fn(async (eventSlug: string) => {
      if (eventSlug === "open-systems") return first;
      if (eventSlug === "other-systems") return second;
      return null;
    });
    const app = publicAppFor({ getPublishedAgenda } as unknown as AgendaEngine);

    const firstResponse = await app.request("/api/public/events/open-systems/agenda.json");
    const secondResponse = await app.request("/api/public/events/other-systems/agenda.json");

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      data: { event: { slug: "other-systems", name: "Other Systems" } },
    });
    expect(getPublishedAgenda).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed public agenda reads", async () => {
    const getPublishedAgenda = vi.fn(async () => {
      throw new Error("agenda read failed");
    });
    const app = publicAppFor({ getPublishedAgenda } as unknown as AgendaEngine);

    expect((await app.request("/api/public/events/open-systems/agenda.json")).status).toBe(500);
    expect((await app.request("/api/public/events/open-systems/agenda.json")).status).toBe(500);
    expect(getPublishedAgenda).toHaveBeenCalledTimes(2);
  });

  it("serializes every published session as stable, escaped, folded iCalendar", async () => {
    const app = publicAppFor(publicEngine(publicRevision()));
    const first = await app.request("/api/public/events/open-systems/agenda.ics");
    const second = await app.request("/api/public/events/open-systems/agenda.ics");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toMatch(/^text\/calendar/u);
    expect(first.headers.get("cache-control")).toContain("public");
    expect(first.headers.get("etag")).toBe(second.headers.get("etag"));

    const ical = await first.text();
    expect(ical).toContain("BEGIN:VCALENDAR\r\n");
    expect(ical).toContain("DTSTART;TZID=America/Los_Angeles:20260918T090000");
    expect(ical).toContain("DTEND;TZID=America/Los_Angeles:20260918T094500");
    expect(ical).toContain("SUMMARY:A session\\, with\\; punctuation \\\\\\\\");
    expect(ical).toContain("DESCRIPTION:Description with a long speaker");
    expect(ical).toContain("LOCATION:Main hall\\, level 2");
    expect(ical).toContain("Morgan Lee");
    expect(ical).toContain(`@${calendarUidDomain}`);
    expect(ical).toContain(`UID:open-systems.session-public-1@${calendarUidDomain}`);
    expect(ical).not.toContain("open-systems.entry-public-1@");
    expect(ical).not.toContain("private@example.test");
    expect(ical).not.toContain("Private event metadata.");
    expect(ical).not.toMatch(/(^|\r\n)(participantEmails|privateNote):/u);

    const lines = ical.split("\r\n").slice(0, -1);
    expect(lines.every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
    expect(ical).toMatch(/END:VCALENDAR\r\n$/u);
    const uid = lines.find((line) => line.startsWith("UID:"));
    expect(uid).toBeDefined();
    const repeatUid = (await second.text()).split("\r\n").find((line) => line.startsWith("UID:"));
    expect(repeatUid).toBe(uid);
  });

  it("keeps every published day and metadata available in the public projection", async () => {
    const base = publicRevision();
    const first = base.entries[0];
    if (!first) throw new Error("Expected a published agenda entry.");
    const revision = {
      ...base,
      entries: [
        ...base.entries,
        {
          ...first,
          id: "entry-public-2",
          sessionId: "session-public-2",
          startsAt: "2026-09-19T16:00:00.000Z",
          endsAt: "2026-09-19T16:45:00.000Z",
          startsAtLocal: "2026-09-19T09:00",
          endsAtLocal: "2026-09-19T09:45",
          metadata: {
            title: "Second-day session",
            summary: "Second-day summary",
            format: "Workshop",
            speakerNames: ["Zoe Adams"],
            roomName: "Workshop room",
            trackNames: ["Operations"],
          },
        },
      ],
    } as PublishedAgendaRevision;
    const response = await publicAppFor(publicEngine(revision)).request(
      "/api/public/events/open-systems/agenda.json",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        event: { startsOn: string; endsOn: string };
        entries: readonly {
          title: string;
          speakerNames: readonly string[];
          roomName: string;
          trackNames: readonly string[];
          startsAt: string;
        }[];
      };
    };
    expect(body.data.event).toMatchObject({ startsOn: "2026-09-18", endsOn: "2026-09-19" });
    expect(body.data.entries).toHaveLength(2);
    expect(body.data.entries[1]).toMatchObject({
      title: "Second-day session",
      speakerNames: ["Zoe Adams"],
      roomName: "Workshop room",
      trackNames: ["Operations"],
      startsAt: "2026-09-19T16:00:00.000Z",
    });
  });
  it("uses authoritative event boundaries for cached and uncached public projections", async () => {
    const base = publicRevision();
    const first = base.entries[0];
    if (!first) throw new Error("Expected a published agenda entry.");
    const revision = {
      ...base,
      entries: [
        {
          ...first,
          startsAt: "2027-05-12T16:00:00.000Z",
          endsAt: "2027-05-12T16:30:00.000Z",
          startsAtLocal: "2027-05-12T09:00",
          endsAtLocal: "2027-05-12T09:30",
        },
        {
          ...first,
          id: "entry-public-2",
          sessionId: "session-public-2",
          startsAt: "2027-05-13T18:00:00.000Z",
          endsAt: "2027-05-13T18:10:00.000Z",
          startsAtLocal: "2027-05-13T11:00",
          endsAtLocal: "2027-05-13T11:10",
        },
      ],
    } as PublishedAgendaRevision;
    const getPublishedAgenda = vi.fn(async (eventSlug: string) =>
      eventSlug === "open-systems" ? revision : null,
    );
    const eventMetadataForEvent = vi.fn(async () => ({
      slug: "open-systems",
      name: "DevFlow Conf 2027",
      timeZone: "America/Los_Angeles",
      startsOn: "2027-05-12",
      endsOn: "2027-05-14",
      venueName: "DevFlow venue",
    }));
    const app = publicAppFor(
      { getPublishedAgenda } as unknown as AgendaEngine,
      eventMetadataForEvent,
    );
    const originalEntries = revision.entries.map((entry) => ({ ...entry }));

    const uncached = await app.request("/api/public/events/open-systems/agenda.json");
    expect(uncached.status).toBe(200);
    const uncachedData = await responseData<{
      event: {
        slug: string;
        name: string;
        timeZone: string;
        startsOn: string;
        endsOn: string;
        venueName: string | null;
      };
      revision: { id: string; number: number };
      entries: readonly { id: string; startsAt: string; endsAt: string }[];
    }>(uncached);
    expect(uncachedData).toMatchObject({
      event: {
        slug: "open-systems",
        name: "DevFlow Conf 2027",
        timeZone: "America/Los_Angeles",
        startsOn: "2027-05-12",
        endsOn: "2027-05-14",
        venueName: "DevFlow venue",
      },
      revision: { id: base.id, number: base.revisionNumber },
      entries: [
        {
          id: "entry-public-1",
          startsAt: "2027-05-12T16:00:00.000Z",
          endsAt: "2027-05-12T16:30:00.000Z",
        },
        {
          id: "entry-public-2",
          startsAt: "2027-05-13T18:00:00.000Z",
          endsAt: "2027-05-13T18:10:00.000Z",
        },
      ],
    });

    const cached = await app.request("/api/public/events/open-systems/agenda.json");
    expect(cached.status).toBe(200);
    await expect(responseData(cached)).resolves.toMatchObject({
      event: { startsOn: "2027-05-12", endsOn: "2027-05-14" },
      revision: { id: base.id, number: base.revisionNumber },
      entries: uncachedData.entries,
    });
    expect(getPublishedAgenda).toHaveBeenCalledTimes(1);
    expect(eventMetadataForEvent).toHaveBeenCalledTimes(1);
    expect(revision.entries).toEqual(originalEntries);
  });

  it("does not cache a partial projection when the event metadata resolver fails", async () => {
    const revision = publicRevision();
    const getPublishedAgenda = vi.fn(async () => revision);
    const eventMetadataForEvent = vi.fn(async () => {
      throw new Error("event metadata unavailable");
    });
    const app = publicAppFor(
      { getPublishedAgenda } as unknown as AgendaEngine,
      eventMetadataForEvent,
    );

    expect((await app.request("/api/public/events/open-systems/agenda.json")).status).toBe(500);
    expect((await app.request("/api/public/events/open-systems/agenda.json")).status).toBe(500);
    expect(getPublishedAgenda).toHaveBeenCalledTimes(2);
    expect(eventMetadataForEvent).toHaveBeenCalledTimes(2);
  });
  it("returns 404 for an unpublished or mismatched public slug", async () => {
    const unpublished = await publicAppFor(publicEngine(null)).request(
      "/api/public/events/open-systems/agenda.json",
    );
    expect(unpublished.status).toBe(404);

    const mismatched = await publicAppFor(publicEngine(publicRevision())).request(
      "/api/public/events/other-event/agenda.ics",
    );
    expect(mismatched.status).toBe(404);
  });
});
