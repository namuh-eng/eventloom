import { describe, expect, it } from "vitest";
import { FakeAirtableTransport } from "../../infrastructure/airtable";
import { AirtableEventRepository, AirtableSessionRepository } from "../../runtime/airtable";
import { InMemorySessionRepository, SessionService } from "../sessions/service";
import type { AgendaCatalogReader } from "../sessions/types";
import {
  AgendaCatalogSynchronizer,
  type AgendaCatalogSyncInput,
  AgendaEngine,
  AgendaError,
  InMemoryAgendaMutationLock,
  InMemoryAgendaRepository,
} from "./index";
import type { AgendaCatalog } from "./types";

const input: AgendaCatalogSyncInput = {
  tenantId: "tenant-a",
  eventId: "event-a",
  actorId: "organizer-a",
};

function catalog(): AgendaCatalog {
  return {
    sessions: [
      {
        id: "session-accepted",
        title: "Accepted session",
        status: "accepted",
        publicApprovalEligible: true,
        participantIds: ["speaker-a"],
        resourceIds: ["projector-a"],
        capacityRequired: 20,
        durationMinutes: 45,
      },
      {
        id: "session-draft",
        title: "Draft session",
        status: "accepted",
        publicApprovalEligible: true,
        participantIds: [],
        resourceIds: [],
        capacityRequired: 10,
        durationMinutes: 30,
      },
    ],
    rooms: [{ id: "room-a", name: "Main room", capacity: 100 }],
    tracks: [{ id: "track-a", name: "Main track" }],
  };
}

function testAgendaEngine(repository: InMemoryAgendaRepository, timeZone = "UTC"): AgendaEngine {
  return new AgendaEngine(repository, new InMemoryAgendaMutationLock(), {
    eventScheduleForEvent: async () => ({
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2028-01-01T00:00:00.000Z",
      timeZone,
    }),
  });
}

function setup(initial = catalog()) {
  let current = structuredClone(initial);
  const reader: AgendaCatalogReader = {
    getAgendaCatalog: async () => structuredClone(current),
  };
  const repository = new InMemoryAgendaRepository();
  const engine = new AgendaEngine(repository, new InMemoryAgendaMutationLock(), {
    clock: { now: () => new Date("2026-08-09T12:00:00.000Z") },
    eventScheduleForEvent: async () => ({
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2028-01-01T00:00:00.000Z",
      timeZone: "UTC",
    }),
  });
  const synchronizer = new AgendaCatalogSynchronizer({
    engine,
    catalogReader: reader,
    actorId: "organizer-a",
    minimumTravelMinutes: 10,
  });
  return {
    engine,
    repository,
    synchronizer,
    setCatalog(next: AgendaCatalog) {
      current = structuredClone(next);
    },
  };
}

describe("agenda catalog synchronization", () => {
  it("initializes a new event with its timezone and an empty private draft", async () => {
    const { engine, synchronizer } = setup();

    const draft = await synchronizer.ensureInitialized(input);

    expect(draft).toMatchObject({ eventId: "event-a", version: 1, timeZone: "UTC", entries: [] });
    await expect(engine.getPublishedAgenda("event-a")).resolves.toBeNull();
    await expect(engine.getOutbox("event-a")).resolves.toEqual([]);
  });

  it("re-reads the approval-gated catalog after a stale publication refresh", async () => {
    const { synchronizer } = setup();
    let attempts = 0;
    const synchronized = await synchronizer.synchronizePublishedContent(input, async () => {
      attempts += 1;
      return { status: attempts === 1 ? "stale" : "unchanged" };
    });
    expect(attempts).toBe(2);
    expect(synchronized.catalog).toEqual(catalog());
  });

  it("projects eligible sessions, room and track additions, including duration", async () => {
    const { repository, synchronizer, setCatalog } = setup();
    await synchronizer.ensureInitialized(input);
    setCatalog({
      ...catalog(),
      rooms: [...catalog().rooms, { id: "room-b", name: "Workshop room", capacity: 40 }],
      tracks: [...catalog().tracks, { id: "track-b", name: "Workshop track" }],
    });

    await synchronizer.synchronize(input);
    const state = await repository.load("event-a");

    expect(state?.rooms.map((room) => room.id)).toEqual(["room-a", "room-b"]);
    expect(state?.tracks.map((track) => track.id)).toEqual(["track-a", "track-b"]);
    expect(state?.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "session-accepted", durationMinutes: 45 }),
        expect.objectContaining({ id: "session-draft", durationMinutes: 30 }),
      ]),
    );
  });
  it("refreshes a catalog change that becomes visible while initialization commits", async () => {
    let current = catalog();
    const repository = new InMemoryAgendaRepository();
    const engine = testAgendaEngine(repository);
    const refreshed = {
      ...catalog(),
      rooms: [...catalog().rooms, { id: "room-b", name: "Workshop room", capacity: 40 }],
      tracks: [...catalog().tracks, { id: "track-b", name: "Workshop track" }],
    };
    const synchronizer = new AgendaCatalogSynchronizer({
      engine: {
        getDraft: (eventId) => engine.getDraft(eventId),
        createAgenda: async (value) => {
          const draft = await engine.createAgenda(value);
          current = refreshed;
          return draft;
        },
        updateCatalog: (value) => engine.updateCatalog(value),
      },
      catalogReader: {
        getAgendaCatalog: async () => structuredClone(current),
      },
    });

    const synchronized = await synchronizer.synchronize(input);
    const state = await repository.load("event-a");

    expect(synchronized.version).toBe(2);
    expect(state?.rooms.map((room) => room.id)).toEqual(["room-a", "room-b"]);
    expect(state?.tracks.map((track) => track.id)).toEqual(["track-a", "track-b"]);
    await expect(
      engine.updateDraft({
        eventId: "event-a",
        expectedVersion: synchronized.version,
        actorId: "organizer-a",
        entries: [
          {
            id: "entry-b",
            sessionId: "session-accepted",
            roomId: "room-b",
            trackIds: ["track-b"],
            startsAtLocal: "2026-08-09T09:00",
            endsAtLocal: "2026-08-09T09:45",
          },
        ],
      }),
    ).resolves.toMatchObject({
      entries: [{ roomId: "room-b", trackIds: ["track-b"] }],
    });
  });
  it("does not rewrite a newly created agenda when only catalog ordering changes", async () => {
    let current = catalog();
    let updateCount = 0;
    const repository = new InMemoryAgendaRepository();
    const engine = testAgendaEngine(repository);
    const synchronizer = new AgendaCatalogSynchronizer({
      engine: {
        getDraft: (eventId) => engine.getDraft(eventId),
        createAgenda: async (value) => {
          const draft = await engine.createAgenda(value);
          current = {
            sessions: [...current.sessions].reverse(),
            rooms: [...current.rooms].reverse(),
            tracks: [...current.tracks].reverse(),
          };
          return draft;
        },
        updateCatalog: async (value) => {
          updateCount += 1;
          return engine.updateCatalog(value);
        },
      },
      catalogReader: {
        getAgendaCatalog: async () => structuredClone(current),
      },
    });

    const synchronized = await synchronizer.synchronize(input);

    expect(synchronized.version).toBe(1);
    expect(updateCount).toBe(0);
  });

  it("retains deapproved scheduled sessions as ineligible while removing unscheduled omissions", async () => {
    const { engine, repository, synchronizer, setCatalog } = setup();
    await synchronizer.ensureInitialized(input);
    const initialDraft = await engine.getDraft("event-a");
    await engine.updateDraft({
      eventId: "event-a",
      expectedVersion: initialDraft.version,
      actorId: "organizer-a",
      entries: [
        {
          id: "entry-a",
          sessionId: "session-accepted",
          roomId: "room-a",
          trackIds: ["track-a"],
          startsAtLocal: "2026-08-09T09:00",
          endsAtLocal: "2026-08-09T09:45",
        },
      ],
    });

    const acceptedSession = catalog().sessions[0];
    if (acceptedSession === undefined) {
      throw new Error("Expected accepted session in catalog fixture.");
    }
    setCatalog({
      ...catalog(),
      sessions: [acceptedSession],
    });
    await synchronizer.synchronize(input);
    expect((await repository.load("event-a"))?.sessions).toEqual([
      expect.objectContaining({ id: "session-accepted", status: "accepted" }),
    ]);

    setCatalog({
      ...catalog(),
      sessions: [],
    });
    const deapproved = await synchronizer.synchronize(input);
    const deapprovedState = await repository.load("event-a");
    expect(deapproved.entries).toHaveLength(1);
    expect(deapprovedState?.sessions).toEqual([
      expect.objectContaining({ id: "session-accepted", status: "ineligible" }),
    ]);
    await expect(
      engine.validateEntries("event-a", [
        {
          id: "entry-a",
          sessionId: "session-accepted",
          roomId: "room-a",
          trackIds: ["track-a"],
          startsAtLocal: "2026-08-09T09:00",
          endsAtLocal: "2026-08-09T09:45",
        },
      ]),
    ).resolves.toEqual({ conflicts: [], warnings: [] });
    await expect(
      engine.updateDraft({
        eventId: "event-a",
        expectedVersion: deapproved.version,
        actorId: "organizer-a",
        entries: [
          {
            id: "entry-a",
            sessionId: "session-accepted",
            roomId: "room-a",
            trackIds: ["track-a"],
            startsAtLocal: "2026-08-09T09:00",
            endsAtLocal: "2026-08-09T09:45",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_AGENDA" });
    await engine.validate({
      eventId: "event-a",
      expectedVersion: deapproved.version,
      actorId: "organizer-a",
    });
    await expect(
      engine.publish({
        eventId: "event-a",
        expectedVersion: deapproved.version,
        actorId: "organizer-a",
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_BLOCKED" });

    const reapprovedSession = {
      ...acceptedSession,
      title: "Reapproved session",
      participantIds: ["speaker-reapproved"],
    };
    setCatalog({
      ...catalog(),
      sessions: [reapprovedSession],
    });
    const restored = await synchronizer.synchronize(input);
    const restoredState = await repository.load("event-a");
    expect(restoredState?.sessions).toEqual([
      expect.objectContaining({
        id: "session-accepted",
        title: "Reapproved session",
        status: "accepted",
        participantIds: ["speaker-reapproved"],
      }),
    ]);
    expect(restored.entries).toHaveLength(1);
    await engine.validate({
      eventId: "event-a",
      expectedVersion: restored.version,
      actorId: "organizer-a",
    });
    await expect(
      engine.publish({
        eventId: "event-a",
        expectedVersion: restored.version,
        actorId: "organizer-a",
      }),
    ).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          sessionId: "session-accepted",
          metadata: expect.objectContaining({ title: "Reapproved session" }),
        }),
      ],
    });
  });

  it("rejects removal of rooms and tracks used by scheduled entries", async () => {
    const { engine, synchronizer, setCatalog } = setup();
    await synchronizer.ensureInitialized(input);
    const initialDraft = await engine.getDraft("event-a");
    await engine.updateDraft({
      eventId: "event-a",
      expectedVersion: initialDraft.version,
      actorId: "organizer-a",
      entries: [
        {
          id: "entry-a",
          sessionId: "session-accepted",
          roomId: "room-a",
          trackIds: ["track-a"],
          startsAtLocal: "2026-08-09T09:00",
          endsAtLocal: "2026-08-09T09:45",
        },
      ],
    });

    setCatalog({ ...catalog(), rooms: [] });
    await expect(synchronizer.synchronize(input)).rejects.toMatchObject({
      resource: "room",
      resourceId: "room-a",
    });
    setCatalog({ ...catalog(), tracks: [] });
    await expect(synchronizer.synchronize(input)).rejects.toMatchObject({
      resource: "track",
      resourceId: "track-a",
    });
  });

  it("retries optimistic catalog updates without publishing or creating outbox work", async () => {
    const base = setup();
    let concurrent = true;
    const reader: AgendaCatalogReader = { getAgendaCatalog: async () => catalog() };
    const retrying = new AgendaCatalogSynchronizer({
      engine: {
        createAgenda: (value) => base.engine.createAgenda(value),
        getDraft: (eventId) => base.engine.getDraft(eventId),
        updateCatalog: async (value) => {
          if (concurrent) {
            concurrent = false;
            throw new AgendaError("CONCURRENT_MODIFICATION", "retry");
          }
          return base.engine.updateCatalog(value);
        },
      },
      catalogReader: reader,
    });

    await retrying.ensureInitialized(input);
    await retrying.synchronize(input);
    await expect(base.engine.getOutbox("event-a")).resolves.toEqual([]);
    await expect(base.engine.getPublishedAgenda("event-a")).resolves.toBeNull();
  });

  it("lets SessionService inject synchronization after catalog mutations", async () => {
    const repository = new InMemorySessionRepository();
    let service!: SessionService;
    const engine = testAgendaEngine(new InMemoryAgendaRepository());
    const synchronizer = new AgendaCatalogSynchronizer({
      engine,
      catalogReader: {
        getAgendaCatalog: (tenantId, eventId) => service.getAgendaCatalog(tenantId, eventId),
      },
    });
    service = new SessionService(repository, { agendaCatalogSynchronizer: synchronizer });
    const actor = { tenantId: "tenant-a", userId: "organizer-a", role: "organizer" as const };

    await service.createRoom(actor, {
      eventId: "event-a",
      id: "room-a",
      name: "Main",
      capacity: 100,
    });
    await service.createTrack(actor, { eventId: "event-a", id: "track-a", name: "Main" });
    await service.createSession(actor, {
      eventId: "event-a",
      id: "session-a",
      title: "Accepted",
      durationMinutes: 50,
      status: "Accepted",
      roomId: "room-a",
      trackId: "track-a",
      speakerIds: [],
    });

    const state = await engine.getDraft("event-a");
    expect(state.entries).toEqual([]);
    expect((await engine.getOutbox("event-a")) ?? []).toEqual([]);
    expect(await engine.getPublishedAgenda("event-a")).toBeNull();
  });
  it("initializes from production Airtable catalog rows with scalar room capacities", async () => {
    const transport = new FakeAirtableTransport();
    const baseId = "base-devflow";
    const tenantId = "ai-engineer";
    const eventId = "devflow-conf-2027";
    const json = (value: unknown) => JSON.stringify(value);

    transport.seed({
      baseId,
      table: "Events",
      fields: {
        "Application ID": eventId,
        "Organization ID": tenantId,
        "Event ID": eventId,
        "Settings JSON": json({
          id: eventId,
          tenantId,
          organizationId: tenantId,
          eventId,
          slug: eventId,
          name: "DevFlow Conf 2027",
          status: "open",
          timeZone: "America/Los_Angeles",
          startsAt: "2027-05-12T07:00:00.000Z",
          endsAt: "2027-05-14T07:00:00.000Z",
          version: 1,
        }),
        "Time Zone": "America/Los_Angeles",
      },
    });
    for (const [id, name] of [
      ["room-main", "Main Hall"],
      ["room-workshop-a", "Workshop A"],
      ["room-workshop-b", "Workshop B"],
      ["room-lounge", "Lounge"],
    ] as const) {
      transport.seed({
        baseId,
        table: "Rooms",
        fields: {
          "Application ID": id,
          "Organization ID": tenantId,
          "Event ID": eventId,
          Name: name,
          Capacity: 500,
          "Metadata JSON": json({ id, eventId, name }),
        },
      });
    }
    for (const [id, name] of [
      ["track-engineering", "Engineering"],
      ["track-product", "Product"],
      ["track-design", "Design"],
    ] as const) {
      transport.seed({
        baseId,
        table: "Tracks",
        fields: {
          "Application ID": id,
          "Organization ID": tenantId,
          "Event ID": eventId,
          "Metadata JSON": json({
            id,
            tenantId,
            organizationId: tenantId,
            eventId,
            name,
            description: "",
            version: 1,
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:00.000Z",
            createdBy: "evaluator-seed",
            updatedBy: "evaluator-seed",
            history: [],
          }),
        },
      });
    }
    const settingsId = `settings:${eventId}`;
    transport.seed({
      baseId,
      table: "Session Settings",
      fields: {
        "Application ID": settingsId,
        "Organization ID": tenantId,
        "Event ID": eventId,
        "Settings JSON": json({
          id: settingsId,
          tenantId,
          organizationId: tenantId,
          eventId,
          statuses: ["draft", "confirmed", "cancelled"],
          agendaEligibleStatuses: ["confirmed"],
          version: 1,
          createdAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T00:00:00.000Z",
          createdBy: "evaluator-seed",
          updatedBy: "evaluator-seed",
          history: [],
        }),
      },
    });

    const events = new AirtableEventRepository({ baseId, transport });
    const sessions = new AirtableSessionRepository({ baseId, transport });
    const agendaRepository = new InMemoryAgendaRepository();
    const engine = new AgendaEngine(agendaRepository, new InMemoryAgendaMutationLock(), {
      eventScheduleForEvent: async (agendaEventId) => {
        const event = await events.getEvent(tenantId, agendaEventId);
        return event === null
          ? null
          : {
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              timeZone: event.timeZone,
              ...(event.scheduleDates === undefined ? {} : { scheduleDates: event.scheduleDates }),
            };
      },
    });
    let service!: SessionService;
    const synchronizer = new AgendaCatalogSynchronizer({
      engine,
      catalogReader: {
        getAgendaCatalog: (catalogTenantId, catalogEventId) =>
          service.getAgendaCatalog(catalogTenantId, catalogEventId),
      },
    });
    service = new SessionService(sessions, { agendaCatalogSynchronizer: synchronizer });

    await expect(
      service.listSessions({ tenantId, userId: "organizer", role: "admin" }, { eventId }),
    ).resolves.toEqual([]);

    const state = await agendaRepository.load(eventId);
    expect(state).toMatchObject({
      eventId,
      timeZone: "America/Los_Angeles",
      sessions: [],
      rooms: [
        { id: "room-lounge", capacity: 500 },
        { id: "room-main", capacity: 500 },
        { id: "room-workshop-a", capacity: 500 },
        { id: "room-workshop-b", capacity: 500 },
      ],
      tracks: [{ id: "track-design" }, { id: "track-engineering" }, { id: "track-product" }],
      draft: { version: 1, entries: [] },
      revisions: [],
      currentPublishedRevisionId: null,
    });

    const actor = { tenantId, userId: "organizer", role: "admin" as const };
    const createdRoom = await service.createRoom(actor, {
      eventId,
      id: "room-runtime",
      name: "Runtime room",
      capacity: 42,
    });
    await expect(service.listRooms(actor, { eventId })).resolves.toContainEqual(createdRoom);
  });
});
