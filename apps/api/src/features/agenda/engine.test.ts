import { describe, expect, it, vi } from "vitest";
import {
  type AgendaCatalog,
  type AgendaClock,
  AgendaEngine,
  type AgendaEntryInput,
  type AgendaError,
  type AgendaIdGenerator,
  type AgendaMutationLock,
  type AgendaSuggestionProvider,
  type AgendaTimeZoneError,
  AgendaValidationError,
  DeterministicAgendaSuggestionProvider,
  InMemoryAgendaMutationLock,
  InMemoryAgendaRepository,
  resolveLocalDateTime,
  validateAgendaEntriesWithinEvent,
} from "./index";

const catalog: AgendaCatalog = {
  sessions: [
    {
      id: "session-1",
      title: "Opening",
      status: "accepted",
      publicApprovalEligible: true,
      participantIds: ["speaker-1"],
      speakerNames: ["Ada Lovelace"],
      resourceIds: ["projector-1"],
      capacityRequired: 120,
      trackIds: ["track-a"],
    },
    {
      id: "session-2",
      title: "Panel",
      status: "accepted",
      publicApprovalEligible: true,
      participantIds: ["speaker-2"],
      resourceIds: [],
      capacityRequired: 40,
      trackIds: ["track-b"],
    },
    {
      id: "session-3",
      title: "Deep dive",
      status: "accepted",
      publicApprovalEligible: true,
      participantIds: ["speaker-1"],
      resourceIds: ["projector-1"],
      capacityRequired: 30,
    },
  ],
  rooms: [
    { id: "room-small", name: "Small room", capacity: 100 },
    { id: "room-large", name: "Large room", capacity: 200 },
  ],
  tracks: [
    { id: "track-a", name: "Track A" },
    { id: "track-b", name: "Track B" },
  ],
};

function entry(
  id: string,
  sessionId: string,
  roomId: string,
  startsAtLocal: string,
  endsAtLocal: string,
  trackIds: readonly string[] = [],
): AgendaEntryInput {
  return { id, sessionId, roomId, startsAtLocal, endsAtLocal, trackIds };
}

function createEngine(
  provider?: AgendaSuggestionProvider,
  mutationLock: AgendaMutationLock = new InMemoryAgendaMutationLock(),
): AgendaEngine {
  let nextId = 0;
  const clock: AgendaClock = { now: () => new Date("2026-08-08T18:00:00.000Z") };
  const idGenerator: AgendaIdGenerator = {
    nextId: (prefix) => {
      nextId += 1;
      return `${prefix}-${nextId}`;
    },
  };
  return new AgendaEngine(new InMemoryAgendaRepository(), mutationLock, {
    clock,
    idGenerator,
    ...(provider === undefined ? {} : { suggestionProvider: provider }),
    eventScheduleForEvent: async () => ({
      startsAt: "2026-01-01T08:00:00.000Z",
      endsAt: "2028-01-01T07:59:59.999Z",
      timeZone: "America/Los_Angeles",
    }),
  });
}

async function initialize(engine: AgendaEngine): Promise<void> {
  await engine.createAgenda({
    eventId: "event-1",
    minimumTravelMinutes: 15,
    actorId: "organizer-1",
    ...catalog,
  });
}

function suggestionInput(baseDraftVersion = 1) {
  return {
    eventId: "event-1",
    actorId: "organizer-1",
    baseDraftVersion,
    dates: ["2026-08-10"],
    eligibleStatuses: ["accepted"],
    rooms: ["room-large"],
    dayWindows: [{ date: "2026-08-10", startLocal: "09:00", endLocal: "17:00" }],
    orderedRules: ["avoid hard conflicts", "prefer larger rooms"],
    ignoreExistingTimes: false,
    ignoreExistingRooms: false,
  } as const;
}

describe("agenda time zones", () => {
  it("derives timezone from event authority, migrates empty state, and rejects stale temporal state", async () => {
    let timeZone = "America/New_York";
    const repository = new InMemoryAgendaRepository();
    const engine = new AgendaEngine(repository, new InMemoryAgendaMutationLock(), {
      eventScheduleForEvent: async () => ({
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2027-01-01T00:00:00.000Z",
        timeZone,
      }),
    });
    const created = await engine.createAgenda({
      eventId: "event-authority",
      minimumTravelMinutes: 0,
      actorId: "organizer-1",
      ...catalog,
    });
    expect(created.timeZone).toBe("America/New_York");

    timeZone = "UTC";
    const migrated = await engine.updateCatalog({
      eventId: "event-authority",
      expectedVersion: created.version,
      minimumTravelMinutes: 0,
      actorId: "organizer-1",
      ...catalog,
    });
    expect(migrated.timeZone).toBe("UTC");
    expect(await repository.load("event-authority")).toMatchObject({
      timeZone: "UTC",
      draft: { timeZone: "UTC" },
    });

    await engine.updateDraft({
      eventId: "event-authority",
      expectedVersion: migrated.version,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    timeZone = "America/Los_Angeles";
    await expect(
      engine.updateCatalog({
        eventId: "event-authority",
        expectedVersion: migrated.version + 1,
        minimumTravelMinutes: 0,
        actorId: "organizer-1",
        ...catalog,
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("rejects nonexistent DST wall times and requires fall-back disambiguation", () => {
    expect(() => resolveLocalDateTime("2026-03-08T02:30", "America/Los_Angeles")).toThrowError(
      expect.objectContaining<Partial<AgendaTimeZoneError>>({ code: "NONEXISTENT_LOCAL_TIME" }),
    );
    expect(() => resolveLocalDateTime("2026-11-01T01:30", "America/Los_Angeles")).toThrowError(
      expect.objectContaining<Partial<AgendaTimeZoneError>>({ code: "AMBIGUOUS_LOCAL_TIME" }),
    );

    const earlier = resolveLocalDateTime("2026-11-01T01:30", "America/Los_Angeles", "earlier");
    const later = resolveLocalDateTime("2026-11-01T01:30", "America/Los_Angeles", "later");
    expect(Date.parse(later.instant) - Date.parse(earlier.instant)).toBe(60 * 60 * 1000);
  });
});

describe("agenda validation", () => {
  it("enforces exact event instants, sparse local dates, and explicit DST resolution", () => {
    const event = {
      startsAt: "2026-11-01T05:30:00.000Z",
      endsAt: "2026-11-03T02:00:00.000Z",
      timeZone: "America/New_York",
      scheduleDates: ["2026-11-01", "2026-11-02"],
    };
    const input = (
      startsAtLocal: string,
      endsAtLocal: string,
      startDisambiguation?: "earlier" | "later",
    ) => ({
      ...entry("entry-1", "session-1", "room-large", startsAtLocal, endsAtLocal),
      ...(startDisambiguation === undefined ? {} : { startDisambiguation }),
    });

    expect(() =>
      validateAgendaEntriesWithinEvent(
        [input("2026-11-01T01:30", "2026-11-01T02:15", "earlier")],
        event,
      ),
    ).not.toThrow();
    expect(() =>
      validateAgendaEntriesWithinEvent([input("2026-11-01T01:30", "2026-11-01T02:15", "later")], {
        ...event,
        endsAt: "2026-11-01T06:45:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ field: "endsAtLocal", issueCode: "after_event_end" }));
    expect(() =>
      validateAgendaEntriesWithinEvent([input("2026-11-01T01:30", "2026-11-01T02:15")], event),
    ).toThrowError(
      expect.objectContaining({
        field: "startsAtLocal",
        issueCode: "ambiguous_local_time",
      }),
    );
    expect(() =>
      validateAgendaEntriesWithinEvent([input("2026-11-03T10:00", "2026-11-03T11:00")], {
        ...event,
        endsAt: "2026-11-04T02:00:00.000Z",
      }),
    ).toThrowError(
      expect.objectContaining({ field: "startsAtLocal", issueCode: "date_not_allowed" }),
    );
  });

  it("enforces event boundaries for direct engine mutations, including non-route callers", async () => {
    const engine = new AgendaEngine(
      new InMemoryAgendaRepository(),
      new InMemoryAgendaMutationLock(),
      {
        eventScheduleForEvent: async () => ({
          startsAt: "2026-08-10T16:00:00.000Z",
          endsAt: "2026-08-10T18:00:00.000Z",
          timeZone: "America/Los_Angeles",
          scheduleDates: ["2026-08-10"],
        }),
      },
    );
    await initialize(engine);

    await expect(
      engine.updateDraft({
        eventId: "event-1",
        expectedVersion: 1,
        actorId: "organizer-1",
        entries: [
          entry("entry-1", "session-1", "room-large", "2026-08-10T08:30", "2026-08-10T09:30"),
        ],
      }),
    ).rejects.toMatchObject({ field: "startsAtLocal", issueCode: "before_event_start" });
  });

  it("detects room, participant, and resource overlaps as hard blockers", async () => {
    const engine = createEngine();
    await initialize(engine);

    const report = await engine.validateEntries("event-1", [
      entry("entry-1", "session-1", "room-small", "2026-08-10T09:00", "2026-08-10T10:00"),
      entry("entry-2", "session-2", "room-small", "2026-08-10T09:30", "2026-08-10T10:30"),
      entry("entry-3", "session-3", "room-large", "2026-08-10T09:15", "2026-08-10T09:45"),
    ]);

    expect(new Set(report.conflicts.map((conflict) => conflict.kind))).toEqual(
      new Set(["room", "participant", "resource"]),
    );
    expect(report.conflicts.map((conflict) => conflict.message)).toEqual(
      expect.arrayContaining([
        'Sessions "Opening" and "Panel" overlap in room "Small room"',
        'Speaker "Ada Lovelace" is scheduled in overlapping sessions "Opening" and "Deep dive"',
      ]),
    );
    await expect(
      engine.updateDraft({
        eventId: "event-1",
        expectedVersion: 1,
        actorId: "organizer-1",
        entries: [
          entry("entry-1", "session-1", "room-small", "2026-08-10T09:00", "2026-08-10T10:00"),
          entry("entry-2", "session-2", "room-small", "2026-08-10T09:30", "2026-08-10T10:30"),
        ],
      }),
    ).rejects.toBeInstanceOf(AgendaValidationError);
  });

  it("reports track, capacity, and travel constraints as overridable warnings", async () => {
    const engine = createEngine();
    await initialize(engine);

    const trackReport = await engine.validateEntries("event-1", [
      entry("entry-1", "session-1", "room-small", "2026-08-10T09:00", "2026-08-10T10:00", [
        "track-a",
      ]),
      entry("entry-2", "session-2", "room-large", "2026-08-10T09:30", "2026-08-10T10:30", [
        "track-a",
      ]),
    ]);
    const travelReport = await engine.validateEntries("event-1", [
      entry("entry-1", "session-1", "room-small", "2026-08-10T09:00", "2026-08-10T10:00"),
      entry("entry-3", "session-3", "room-large", "2026-08-10T10:05", "2026-08-10T11:00"),
    ]);

    expect(new Set(trackReport.warnings.map((warning) => warning.kind))).toEqual(
      new Set(["capacity", "track"]),
    );
    expect(new Set(travelReport.warnings.map((warning) => warning.kind))).toEqual(
      new Set(["capacity", "travel"]),
    );
    expect(trackReport.conflicts).toEqual([]);
    expect(travelReport.conflicts).toEqual([]);
    expect(trackReport.warnings.find((warning) => warning.kind === "track")).toEqual({
      id: "track:entry-1:entry-2:track-a",
      kind: "track",
      entryIds: ["entry-1", "entry-2"],
      message: 'Track "Track A" contains overlapping sessions',
    });
    expect(travelReport.warnings.find((warning) => warning.kind === "travel")).toEqual({
      id: "travel:entry-1:entry-3:speaker-1",
      kind: "travel",
      entryIds: ["entry-1", "entry-3"],
      message: 'Speaker "Ada Lovelace" has 5 minutes to change rooms; 15 required',
    });
  });
  it("blocks initial publication of a scheduled unapproved session", async () => {
    const engine = createEngine();
    await engine.createAgenda({
      eventId: "event-1",
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...catalog,
      sessions: catalog.sessions.map((session) =>
        session.id === "session-2" ? { ...session, publicApprovalEligible: false } : session,
      ),
    });
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-2", "session-2", "room-small", "2026-08-10T10:00", "2026-08-10T11:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });

    await expect(
      engine.publish({
        eventId: "event-1",
        expectedVersion: draft.version,
        actorId: "organizer-1",
      }),
    ).rejects.toMatchObject({
      code: "PUBLICATION_BLOCKED",
      message: "Only approval-eligible sessions can be published: session-2",
    });
  });
  it("fails closed when a scheduled session omits approval eligibility", async () => {
    const engine = createEngine();
    const missingEligibilityCatalog = {
      ...catalog,
      sessions: catalog.sessions.map((session) => {
        if (session.id !== "session-2") return session;
        const { publicApprovalEligible: _publicApprovalEligible, ...withoutEligibility } = session;
        return withoutEligibility;
      }),
    } as unknown as AgendaCatalog;
    await engine.createAgenda({
      eventId: "event-1",
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...missingEligibilityCatalog,
    });
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-2", "session-2", "room-small", "2026-08-10T10:00", "2026-08-10T11:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });

    await expect(
      engine.publish({
        eventId: "event-1",
        expectedVersion: draft.version,
        actorId: "organizer-1",
      }),
    ).rejects.toMatchObject({
      code: "PUBLICATION_BLOCKED",
      message: "Only approval-eligible sessions can be published: session-2",
    });
  });
  it("requires reasoned warning overrides before atomic publication", async () => {
    const engine = createEngine();
    await initialize(engine);
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-small", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });

    expect(await engine.getPublishedAgenda("event-1")).toBeNull();
    const preview = await engine.preview("event-1");
    expect(preview.validation.warnings.map((warning) => warning.kind)).toEqual(["capacity"]);
    await engine.validate({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });
    await expect(
      engine.publish({
        eventId: "event-1",
        expectedVersion: draft.version,
        actorId: "organizer-1",
      }),
    ).rejects.toBeInstanceOf(AgendaValidationError);

    const overridden = await engine.overrideWarning({
      eventId: "event-1",
      expectedVersion: draft.version,
      warningId: preview.validation.warnings[0]?.id ?? "missing",
      reason: "Overflow room is reserved and audited",
      actorId: "organizer-1",
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: overridden.version,
      actorId: "organizer-1",
    });
    const revision = await engine.publish({
      eventId: "event-1",
      expectedVersion: overridden.version,
      actorId: "organizer-1",
    });
    const retry = await engine.publish({
      eventId: "event-1",
      expectedVersion: overridden.version,
      actorId: "organizer-1",
    });

    expect(retry.id).toBe(revision.id);
    expect(revision.revisionNumber).toBe(1);
    expect(await engine.getPublishedAgenda("event-1")).toEqual(revision);
    const outbox = await engine.getOutbox("event-1");
    expect(outbox).toHaveLength(3);
    expect(new Set(outbox.map((event) => event.idempotencyKey))).toHaveLength(3);
    expect((await engine.getAudit("event-1")).map((audit) => audit.action)).toContain(
      "warning.overridden",
    );
  });
});
it("loads the authoritative aggregate once per mutation", async () => {
  const repository = new InMemoryAgendaRepository();
  const loadSpy = vi.spyOn(repository, "load");
  const engine = new AgendaEngine(repository, new InMemoryAgendaMutationLock(), {
    eventScheduleForEvent: async () => ({
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2028-01-01T00:00:00.000Z",
      timeZone: "UTC",
    }),
  });
  await engine.createAgenda({
    eventId: "event-1",
    minimumTravelMinutes: 0,
    actorId: "organizer-1",
    ...catalog,
  });
  loadSpy.mockClear();

  await engine.updateDraft({
    eventId: "event-1",
    expectedVersion: 1,
    actorId: "organizer-1",
    entries: [entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00")],
  });

  expect(loadSpy).toHaveBeenCalledTimes(1);
});

it("accepts a valid trackless placement when the room and times are known", async () => {
  const engine = createEngine();
  await initialize(engine);

  const draft = await engine.updateDraft({
    eventId: "event-1",
    expectedVersion: 1,
    actorId: "organizer-1",
    entries: [
      entry("entry-trackless", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
    ],
  });

  expect(draft.entries).toHaveLength(1);
  expect(draft.entries[0]?.trackIds).toEqual([]);
});

describe("agenda concurrency and revisions", () => {
  it("serializes concurrent mutations and rejects the stale draft version", async () => {
    const engine = createEngine();
    await initialize(engine);

    const updates = await Promise.allSettled([
      engine.updateDraft({
        eventId: "event-1",
        expectedVersion: 1,
        actorId: "organizer-1",
        entries: [
          entry("entry-2", "session-2", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
        ],
      }),
      engine.updateDraft({
        eventId: "event-1",
        expectedVersion: 1,
        actorId: "organizer-2",
        entries: [
          entry("entry-3", "session-3", "room-large", "2026-08-10T11:00", "2026-08-10T12:00"),
        ],
      }),
    ]);

    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = updates.find((result) => result.status === "rejected");
    expect(rejection).toEqual(
      expect.objectContaining({
        reason: expect.objectContaining<Partial<AgendaError>>({
          code: "CONCURRENT_MODIFICATION",
        }),
      }),
    );
    expect((await engine.getDraft("event-1")).version).toBe(2);
  });

  it("records validation for the exact draft revision and preserves it through publish", async () => {
    const engine = createEngine();
    await initialize(engine);

    await engine.validate({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
    });
    const firstValidatedState = await engine.repository.load("event-1");
    expect(firstValidatedState).toMatchObject({
      validatedDraftVersion: 1,
      validatedAt: "2026-08-08T18:00:00.000Z",
      draft: { version: 1 },
    });
    expect(firstValidatedState?.audit.at(-1)).toMatchObject({
      actorId: "organizer-1",
      action: "draft.validated",
      details: { draftVersion: 1 },
    });

    const updated = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-2", "session-2", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    expect(await engine.repository.load("event-1")).toMatchObject({
      validatedDraftVersion: 1,
      draft: { version: 2 },
    });

    await expect(
      engine.publish({
        eventId: "event-1",
        expectedVersion: updated.version,
        actorId: "organizer-1",
      }),
    ).rejects.toMatchObject({
      code: "PUBLICATION_BLOCKED",
      message: "Validate the exact current agenda draft before publishing.",
    });
    await expect(
      engine.validate({
        eventId: "event-1",
        expectedVersion: 1,
        actorId: "organizer-1",
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: updated.version,
      actorId: "organizer-1",
    });
    await engine.publish({
      eventId: "event-1",
      expectedVersion: updated.version,
      actorId: "organizer-1",
    });
    const publishedState = await engine.repository.load("event-1");
    expect(publishedState).toMatchObject({
      validatedDraftVersion: 2,
      validatedAt: "2026-08-08T18:00:00.000Z",
      draft: { version: 2 },
    });
    if (publishedState === null) throw new Error("Expected published agenda state.");
    const {
      validatedDraftVersion: _validatedDraftVersion,
      validatedAt: _validatedAt,
      ...withoutValidation
    } = publishedState;
    await engine.repository.compareAndSwap("event-1", publishedState.stateVersion, {
      ...withoutValidation,
      stateVersion: publishedState.stateVersion + 1,
    });
    await expect(
      engine.publish({
        eventId: "event-1",
        expectedVersion: updated.version,
        actorId: "organizer-1",
      }),
    ).rejects.toMatchObject({
      code: "PUBLICATION_BLOCKED",
      message: "Validate the exact current agenda draft before publishing.",
    });
  });

  it("publishes immutable revisions and rolls back through a corrective revision", async () => {
    const engine = createEngine();
    await initialize(engine);
    const firstDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-2", "session-2", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: firstDraft.version,
      actorId: "organizer-1",
    });
    const first = await engine.publish({
      eventId: "event-1",
      expectedVersion: firstDraft.version,
      actorId: "organizer-1",
    });
    const secondDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: firstDraft.version,
      actorId: "organizer-1",
      entries: [
        entry("entry-2", "session-2", "room-large", "2026-08-10T11:00", "2026-08-10T12:00"),
      ],
    });

    expect((await engine.getPublishedAgenda("event-1"))?.entries[0]?.startsAt).toBe(
      first.entries[0]?.startsAt,
    );
    await engine.validate({
      eventId: "event-1",
      expectedVersion: secondDraft.version,
      actorId: "organizer-1",
    });
    const second = await engine.publish({
      eventId: "event-1",
      expectedVersion: secondDraft.version,
      actorId: "organizer-1",
    });
    const metadataDraft = await engine.updateCatalog({
      eventId: "event-1",
      expectedVersion: secondDraft.version,
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...{
        ...catalog,
        sessions: catalog.sessions.map((session) =>
          session.id === "session-2" ? { ...session, title: "Current replacement title" } : session,
        ),
      },
    });
    const rollback = await engine.rollback({
      eventId: "event-1",
      expectedVersion: metadataDraft.version,
      revisionId: first.id,
      actorId: "organizer-1",
    });

    expect(second.revisionNumber).toBe(2);
    expect(rollback.revisionNumber).toBe(3);
    expect(rollback.rollbackOfRevisionId).toBe(first.id);
    expect(rollback.entries).toEqual(first.entries);
    expect(await engine.getPublishedAgenda("event-1")).toEqual(rollback);
    expect(await engine.getOutbox("event-1")).toHaveLength(9);
  });

  it("refreshes approved public metadata without publishing dirty layout state", async () => {
    const engine = createEngine();
    await initialize(engine);
    const publishedDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00", [
          "track-a",
        ]),
        entry("entry-2", "session-2", "room-small", "2026-08-10T10:00", "2026-08-10T11:00", [
          "track-b",
        ]),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: publishedDraft.version,
      actorId: "organizer-1",
    });
    const first = await engine.publish({
      eventId: "event-1",
      expectedVersion: publishedDraft.version,
      actorId: "organizer-1",
    });
    const dirtyDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: publishedDraft.version,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T12:00", "2026-08-10T13:00", [
          "track-a",
        ]),
      ],
    });
    const firstCatalogSession = catalog.sessions[0];
    if (firstCatalogSession === undefined) throw new Error("Expected the opening session.");
    const approvedCatalog: AgendaCatalog = {
      sessions: [
        {
          ...firstCatalogSession,
          title: "Opening refreshed",
          summary: "Approved abstract",
          format: "Keynote",
          speakerNames: ["Ada Lovelace"],
          durationMinutes: 40,
        },
      ],
      rooms: catalog.rooms.map((room) =>
        room.id === "room-large" ? { ...room, name: "Grand hall" } : room,
      ),
      tracks: catalog.tracks.map((track) =>
        track.id === "track-a" ? { ...track, name: "Main stage" } : track,
      ),
    };
    const synchronizedDraft = await engine.updateCatalog({
      eventId: "event-1",
      expectedVersion: dirtyDraft.version,
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...approvedCatalog,
    });
    expect(synchronizedDraft.entries[0]?.metadata).toMatchObject({
      title: "Opening refreshed",
      summary: "Approved abstract",
      format: "Keynote",
      roomName: "Grand hall",
      trackNames: ["Main stage"],
    });
    expect(synchronizedDraft.entries[0]?.endsAtLocal).toBe("2026-08-10T12:40");
    expect(
      Date.parse(synchronizedDraft.entries[0]?.endsAt ?? "") -
        Date.parse(synchronizedDraft.entries[0]?.startsAt ?? ""),
    ).toBe(40 * 60_000);

    const refreshed = await engine.refreshPublishedContent({
      eventId: "event-1",
      actorId: "organizer-1",
      expectedCatalogVersion: synchronizedDraft.version,
      catalog: approvedCatalog,
    });
    expect(refreshed.status).toBe("created");
    expect(refreshed.revision?.revisionNumber).toBe(2);
    expect(refreshed.revision?.sourceDraftVersion).toBe(first.sourceDraftVersion);
    expect(
      refreshed.revision?.entries.map(({ id, roomId, startsAt }) => ({ id, roomId, startsAt })),
    ).toEqual(first.entries.map(({ id, roomId, startsAt }) => ({ id, roomId, startsAt })));
    expect(refreshed.revision?.entries[0]?.metadata).toMatchObject({
      title: "Opening refreshed",
      summary: "Approved abstract",
      format: "Keynote",
      roomName: "Grand hall",
      trackNames: ["Main stage"],
    });
    expect(refreshed.revision?.entries[0]?.endsAtLocal).toBe("2026-08-10T09:40");
    expect(
      Date.parse(refreshed.revision?.entries[0]?.endsAt ?? "") -
        Date.parse(refreshed.revision?.entries[0]?.startsAt ?? ""),
    ).toBe(40 * 60_000);
    expect(refreshed.revision?.entries[1]?.metadata?.title).toBe(first.entries[1]?.metadata?.title);
    expect(await engine.getOutbox("event-1")).toHaveLength(6);

    const repeated = await engine.refreshPublishedContent({
      eventId: "event-1",
      actorId: "organizer-1",
      expectedCatalogVersion: synchronizedDraft.version,
      catalog: approvedCatalog,
    });
    expect(repeated).toMatchObject({
      status: "unchanged",
      revision: { id: refreshed.revision?.id },
    });
    expect(await engine.getOutbox("event-1")).toHaveLength(6);
    await expect(
      engine.refreshPublishedContent({
        eventId: "event-1",
        actorId: "organizer-1",
        expectedCatalogVersion: synchronizedDraft.version - 1,
        catalog: approvedCatalog,
      }),
    ).resolves.toEqual({ status: "stale", revision: null });

    await engine.validate({
      eventId: "event-1",
      expectedVersion: synchronizedDraft.version,
      actorId: "organizer-1",
    });
    const schedulePublication = await engine.publish({
      eventId: "event-1",
      expectedVersion: synchronizedDraft.version,
      actorId: "organizer-1",
    });
    expect(schedulePublication.revisionNumber).toBe(3);
    expect(schedulePublication.entries[0]?.roomId).toBe("room-large");
    expect(schedulePublication.entries[0]?.startsAt).not.toBe(first.entries[0]?.startsAt);
    expect(schedulePublication.entries[0]?.metadata).toMatchObject({
      title: "Opening refreshed",
      summary: "Approved abstract",
      format: "Keynote",
      roomName: "Grand hall",
      trackNames: ["Main stage"],
    });

    const revertedCatalog: AgendaCatalog = {
      ...approvedCatalog,
      sessions: [{ ...firstCatalogSession, title: "Opening" }],
    };
    const revertedDraft = await engine.updateCatalog({
      eventId: "event-1",
      expectedVersion: synchronizedDraft.version,
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...revertedCatalog,
    });
    const corrective = await engine.refreshPublishedContent({
      eventId: "event-1",
      actorId: "organizer-1",
      expectedCatalogVersion: revertedDraft.version,
      catalog: revertedCatalog,
    });
    expect(corrective).toMatchObject({
      status: "created",
      revision: { revisionNumber: 4 },
    });
    expect(corrective.revision?.entries[0]?.metadata?.title).toBe("Opening");
  });

  it("retains published metadata when a scheduled session becomes unapproved", async () => {
    const engine = createEngine();
    await initialize(engine);
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-2", "session-2", "room-small", "2026-08-10T10:00", "2026-08-10T11:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });
    const published = await engine.publish({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });

    const unapprovedCatalog: AgendaCatalog = {
      ...catalog,
      sessions: catalog.sessions.map((session) =>
        session.id === "session-2"
          ? {
              ...session,
              title: "Unapproved replacement title",
              summary: "Unapproved replacement summary",
              trackIds: ["track-a"],
              publicApprovalEligible: false,
            }
          : session,
      ),
    };
    const synchronized = await engine.updateCatalog({
      eventId: "event-1",
      expectedVersion: draft.version,
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...unapprovedCatalog,
    });
    const refreshed = await engine.refreshPublishedContent({
      eventId: "event-1",
      actorId: "organizer-1",
      expectedCatalogVersion: synchronized.version,
      catalog: unapprovedCatalog,
    });

    expect(refreshed).toMatchObject({
      status: "unchanged",
      revision: { id: published.id, revisionNumber: 1 },
    });
    expect(refreshed.revision?.entries[0]?.metadata?.title).toBe(
      published.entries[0]?.metadata?.title,
    );
    expect(refreshed.revision?.entries[0]?.trackIds).toEqual(published.entries[0]?.trackIds);
    await expect(engine.getPublishedAgenda("event-1")).resolves.toMatchObject({
      revisionNumber: 1,
      entries: [
        expect.objectContaining({
          metadata: expect.objectContaining({ title: published.entries[0]?.metadata?.title }),
        }),
      ],
    });
  });
  it("replaces and removes scheduled tracks only from approved catalog content", async () => {
    const engine = createEngine();
    await initialize(engine);
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00", [
          "track-a",
        ]),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });
    await engine.publish({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });
    const replacementCatalog: AgendaCatalog = {
      ...catalog,
      sessions: catalog.sessions.map((session) =>
        session.id === "session-1" ? { ...session, trackIds: ["track-b"] } : session,
      ),
    };
    const replacedDraft = await engine.updateCatalog({
      eventId: "event-1",
      expectedVersion: draft.version,
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...replacementCatalog,
    });
    expect(replacedDraft.entries[0]).toMatchObject({
      trackIds: ["track-b"],
      metadata: { trackNames: ["Track B"] },
    });
    const replaced = await engine.refreshPublishedContent({
      eventId: "event-1",
      actorId: "organizer-1",
      expectedCatalogVersion: replacedDraft.version,
      catalog: replacementCatalog,
    });
    expect(replaced.revision?.entries[0]).toMatchObject({
      trackIds: ["track-b"],
      metadata: { trackNames: ["Track B"] },
    });

    const removalCatalog: AgendaCatalog = {
      ...replacementCatalog,
      sessions: replacementCatalog.sessions.map((session) =>
        session.id === "session-1" ? { ...session, trackIds: [] } : session,
      ),
    };
    const removedDraft = await engine.updateCatalog({
      eventId: "event-1",
      expectedVersion: replacedDraft.version,
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...removalCatalog,
    });
    expect(removedDraft.entries[0]).toMatchObject({
      trackIds: [],
      metadata: { trackNames: [] },
    });
  });
  it("refreshes approved durations across DST transitions", async () => {
    const refresh = async (
      startsAtLocal: string,
      endsAtLocal: string,
      startDisambiguation: "earlier" | "later" | undefined,
      durationMinutes: number,
    ) => {
      const engine = createEngine();
      await initialize(engine);
      const draft = await engine.updateDraft({
        eventId: "event-1",
        expectedVersion: 1,
        actorId: "organizer-1",
        entries: [
          {
            ...entry("entry-1", "session-1", "room-large", startsAtLocal, endsAtLocal, ["track-a"]),
            ...(startDisambiguation === undefined ? {} : { startDisambiguation }),
          },
        ],
      });
      await engine.validate({
        eventId: "event-1",
        expectedVersion: draft.version,
        actorId: "organizer-1",
      });
      await engine.publish({
        eventId: "event-1",
        expectedVersion: draft.version,
        actorId: "organizer-1",
      });
      const refreshedCatalog: AgendaCatalog = {
        ...catalog,
        sessions: catalog.sessions.map((session) =>
          session.id === "session-1" ? { ...session, durationMinutes } : session,
        ),
      };
      const synchronized = await engine.updateCatalog({
        eventId: "event-1",
        expectedVersion: draft.version,
        minimumTravelMinutes: 15,
        actorId: "organizer-1",
        ...refreshedCatalog,
      });
      const refreshed = await engine.refreshPublishedContent({
        eventId: "event-1",
        actorId: "organizer-1",
        expectedCatalogVersion: synchronized.version,
        catalog: refreshedCatalog,
      });
      return refreshed.revision?.entries[0];
    };

    await expect(
      refresh("2026-03-08T01:30", "2026-03-08T03:00", undefined, 90),
    ).resolves.toMatchObject({
      endsAt: "2026-03-08T11:00:00.000Z",
      endsAtLocal: "2026-03-08T04:00",
    });
    await expect(
      refresh("2026-11-01T01:30", "2026-11-01T02:00", "earlier", 60),
    ).resolves.toMatchObject({
      endsAt: "2026-11-01T09:30:00.000Z",
      endsAtLocal: "2026-11-01T01:30",
      endDisambiguation: "later",
    });
    await expect(
      refresh("2026-11-01T01:30", "2026-11-01T02:00", "later", 60),
    ).resolves.toMatchObject({
      endsAt: "2026-11-01T10:30:00.000Z",
      endsAtLocal: "2026-11-01T02:30",
    });
  });
  it("keeps approved-content handoffs inside the event mutation lock", async () => {
    let lockHeld = false;
    const mutationLock: AgendaMutationLock = {
      async runExclusive(_eventId, operation) {
        expect(lockHeld).toBe(false);
        lockHeld = true;
        try {
          return await operation();
        } finally {
          lockHeld = false;
        }
      },
    };
    const engine = createEngine(undefined, mutationLock);
    await initialize(engine);
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });
    await engine.publish({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });
    const refreshedCatalog: AgendaCatalog = {
      ...catalog,
      sessions: catalog.sessions.map((session) =>
        session.id === "session-1" ? { ...session, title: "Locked refresh" } : session,
      ),
    };
    const synchronized = await engine.updateCatalog({
      eventId: "event-1",
      expectedVersion: draft.version,
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...refreshedCatalog,
    });
    let handoffObserved = false;
    await engine.refreshPublishedContent({
      eventId: "event-1",
      actorId: "organizer-1",
      expectedCatalogVersion: synchronized.version,
      catalog: refreshedCatalog,
      async afterRefresh(refresh) {
        expect(lockHeld).toBe(true);
        expect(refresh.status).toBe("created");
        handoffObserved = true;
      },
    });
    expect(handoffObserved).toBe(true);
    expect(lockHeld).toBe(false);
  });

  it("keeps schedule publication handoffs inside the event mutation lock", async () => {
    let lockHeld = false;
    const mutationLock: AgendaMutationLock = {
      async runExclusive(_eventId, operation) {
        expect(lockHeld).toBe(false);
        lockHeld = true;
        try {
          return await operation();
        } finally {
          lockHeld = false;
        }
      },
    };
    const engine = createEngine(undefined, mutationLock);
    await initialize(engine);
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });
    let handoffObserved = false;
    await engine.publish({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
      async afterPublish(revision) {
        expect(lockHeld).toBe(true);
        expect(revision.revisionNumber).toBe(1);
        handoffObserved = true;
      },
    });
    expect(handoffObserved).toBe(true);
    expect(lockHeld).toBe(false);
  });

  it("does not commit or hand off a publication after losing the mutation lease", async () => {
    let rejectRenewal = false;
    const mutationLock: AgendaMutationLock = {
      async runExclusive(_eventId, operation) {
        return operation();
      },
      async renew() {
        if (rejectRenewal) throw new Error("lease lost");
      },
    };
    const engine = createEngine(undefined, mutationLock);
    await initialize(engine);
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });
    let handoffObserved = false;
    rejectRenewal = true;
    await expect(
      engine.publish({
        eventId: "event-1",
        expectedVersion: draft.version,
        actorId: "organizer-1",
        async afterPublish() {
          handoffObserved = true;
        },
      }),
    ).rejects.toThrow("lease lost");
    await expect(engine.getPublishedAgenda("event-1")).resolves.toBeNull();
    expect(handoffObserved).toBe(false);
  });

  it("keeps rollback handoffs inside the event mutation lock", async () => {
    let lockHeld = false;
    const mutationLock: AgendaMutationLock = {
      async runExclusive(_eventId, operation) {
        expect(lockHeld).toBe(false);
        lockHeld = true;
        try {
          return await operation();
        } finally {
          lockHeld = false;
        }
      },
    };
    const engine = createEngine(undefined, mutationLock);
    await initialize(engine);
    const firstDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: firstDraft.version,
      actorId: "organizer-1",
    });
    const firstRevision = await engine.publish({
      eventId: "event-1",
      expectedVersion: firstDraft.version,
      actorId: "organizer-1",
    });
    const secondDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: firstDraft.version,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T10:00", "2026-08-10T11:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: secondDraft.version,
      actorId: "organizer-1",
    });
    await engine.publish({
      eventId: "event-1",
      expectedVersion: secondDraft.version,
      actorId: "organizer-1",
    });
    let handoffObserved = false;
    await engine.rollback({
      eventId: "event-1",
      expectedVersion: secondDraft.version,
      actorId: "organizer-1",
      revisionId: firstRevision.id,
      async afterRollback(revision) {
        expect(lockHeld).toBe(true);
        expect(revision.rollbackOfRevisionId).toBe(firstRevision.id);
        handoffObserved = true;
      },
    });
    expect(handoffObserved).toBe(true);
    expect(lockHeld).toBe(false);
  });

  it("refreshes the latest synchronized catalog after an interleaved catalog mutation", async () => {
    const engine = createEngine();
    await initialize(engine);
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });
    await engine.publish({
      eventId: "event-1",
      expectedVersion: draft.version,
      actorId: "organizer-1",
    });
    const firstCatalog: AgendaCatalog = {
      ...catalog,
      sessions: catalog.sessions.map((session) =>
        session.id === "session-1" ? { ...session, title: "First approved title" } : session,
      ),
    };
    const firstSynchronization = await engine.updateCatalog({
      eventId: "event-1",
      expectedVersion: draft.version,
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...firstCatalog,
    });
    const latestCatalog: AgendaCatalog = {
      ...firstCatalog,
      sessions: firstCatalog.sessions.map((session) =>
        session.id === "session-1" ? { ...session, title: "Latest approved title" } : session,
      ),
    };
    const latestSynchronization = await engine.updateCatalog({
      eventId: "event-1",
      expectedVersion: firstSynchronization.version,
      minimumTravelMinutes: 15,
      actorId: "organizer-1",
      ...latestCatalog,
    });
    const stale = await engine.refreshPublishedContent({
      eventId: "event-1",
      actorId: "organizer-1",
      expectedCatalogVersion: firstSynchronization.version,
      catalog: firstCatalog,
    });
    expect(stale).toEqual({ status: "stale", revision: null });
    const refreshed = await engine.refreshPublishedContent({
      eventId: "event-1",
      actorId: "organizer-1",
      expectedCatalogVersion: latestSynchronization.version,
      catalog: latestCatalog,
    });
    expect(refreshed).toMatchObject({
      status: "created",
      revision: {
        entries: [
          {
            metadata: { title: "Latest approved title" },
          },
        ],
      },
    });
  });

  it("blocks a new session on another session's active released speaker commitment", async () => {
    const engine = createEngine();
    await initialize(engine);
    const releasedDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: releasedDraft.version,
      actorId: "organizer-1",
    });
    const released = await engine.publish({
      eventId: "event-1",
      expectedVersion: releasedDraft.version,
      actorId: "organizer-1",
    });
    const candidateDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: releasedDraft.version,
      actorId: "organizer-1",
      entries: [
        entry("entry-3", "session-3", "room-large", "2026-08-10T09:15", "2026-08-10T09:45"),
      ],
    });

    const preview = await engine.preview("event-1");
    expect(preview.validation.conflicts).toEqual([]);
    expect(preview.releaseValidation.conflicts).toEqual([
      expect.objectContaining({
        kind: "participant",
        entryIds: ["entry-3", "entry-1"],
        message: expect.stringContaining('active released commitment for "Opening"'),
      }),
    ]);
    await engine.validate({
      eventId: "event-1",
      expectedVersion: candidateDraft.version,
      actorId: "organizer-1",
    });
    await expect(
      engine.publish({
        eventId: "event-1",
        expectedVersion: candidateDraft.version,
        actorId: "organizer-1",
      }),
    ).rejects.toBeInstanceOf(AgendaValidationError);
    expect(await engine.getPublishedAgenda("event-1")).toEqual(released);
  });

  it("excludes a session's own released slot when publishing its update", async () => {
    const engine = createEngine();
    await initialize(engine);
    const releasedDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    await engine.validate({
      eventId: "event-1",
      expectedVersion: releasedDraft.version,
      actorId: "organizer-1",
    });
    await engine.publish({
      eventId: "event-1",
      expectedVersion: releasedDraft.version,
      actorId: "organizer-1",
    });
    const updatedDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: releasedDraft.version,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:30", "2026-08-10T10:30"),
      ],
    });

    expect((await engine.preview("event-1")).releaseValidation.conflicts).toEqual([]);
    await engine.validate({
      eventId: "event-1",
      expectedVersion: updatedDraft.version,
      actorId: "organizer-1",
    });
    await expect(
      engine.publish({
        eventId: "event-1",
        expectedVersion: updatedDraft.version,
        actorId: "organizer-1",
      }),
    ).resolves.toMatchObject({
      revisionNumber: 2,
      entries: [expect.objectContaining({ sessionId: "session-1" })],
    });
  });

  it("executes a Durable Object lock contract one mutation at a time", async () => {
    const lock = new InMemoryAgendaMutationLock();
    let active = 0;
    let maximumActive = 0;
    const operation = async (): Promise<void> => {
      await lock.runExclusive("event-1", async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });
    };

    await Promise.all([operation(), operation(), operation()]);
    expect(maximumActive).toBe(1);
  });
});
describe("advisory agenda suggestions", () => {
  it("fails closed when no suggestion provider is injected", async () => {
    const engine = createEngine();
    await initialize(engine);

    await expect(engine.generateSuggestion(suggestionInput())).rejects.toMatchObject({
      code: "SUGGESTION_PROVIDER_UNAVAILABLE",
    });
    expect(await engine.getSuggestionRuns("event-1")).toEqual([]);
  });
  it("captures criteria and leaves the private draft unchanged during generation", async () => {
    const engine = createEngine(new DeterministicAgendaSuggestionProvider());
    await initialize(engine);
    const before = await engine.getDraft("event-1");

    const run = await engine.generateSuggestion(suggestionInput());
    const after = await engine.getDraft("event-1");

    expect(after).toEqual(before);
    expect(run.status).toBe("pending");
    expect(run.baseDraftVersion).toBe(before.version);
    expect(run.baseDraftRevision).toBe(before.version);
    expect(run.criteria.dates).toEqual(["2026-08-10"]);
    expect(run.criteria.eligibleStatuses).toEqual(["accepted"]);
    expect(run.criteria.roomIds).toEqual(["room-large"]);
    expect(run.criteria.dayWindows[0]).toEqual({
      date: "2026-08-10",
      startLocal: "09:00",
      endLocal: "17:00",
    });
    expect(run.criteria.orderedRules).toEqual(["avoid hard conflicts", "prefer larger rooms"]);
    expect(run.diff.summary).toContain("proposed agenda change");
  });

  it("places one eligible unscheduled session after existing room occupancy", async () => {
    const engine = createEngine(new DeterministicAgendaSuggestionProvider());
    await initialize(engine);
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });

    const run = await engine.generateSuggestion(suggestionInput(draft.version));
    expect(run.candidateDiagnostics.conflicts).toEqual([]);
    expect(run.proposedEntries).toContainEqual(
      expect.objectContaining({
        sessionId: "session-2",
        roomId: "room-large",
        startsAtLocal: "2026-08-10T10:00:00",
      }),
    );
  });

  it("keeps scheduled sessions fixed when room occupancy is ignored", async () => {
    const engine = createEngine(new DeterministicAgendaSuggestionProvider());
    await initialize(engine);
    const draft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });

    const run = await engine.generateSuggestion({
      ...suggestionInput(draft.version),
      ignoreExistingRooms: true,
    });

    expect(run.proposedEntries).toContainEqual(
      expect.objectContaining({
        sessionId: "session-1",
        roomId: "room-large",
        startsAtLocal: "2026-08-10T09:00:00",
      }),
    );
    expect(run.diff.changes.find((change) => change.sessionId === "session-1")).toBeUndefined();
  });

  it("returns candidate diagnostics without polluting the authoritative saved preview", async () => {
    const provider: AgendaSuggestionProvider = {
      suggest: () => ({
        placements: [
          {
            sessionId: "session-2",
            roomId: "room-large",
            startsAtLocal: "2026-08-10T09:30",
            endsAtLocal: "2026-08-10T10:30",
          },
        ],
      }),
    };
    const engine = createEngine(provider);
    await initialize(engine);
    const savedDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-large", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });

    const run = await engine.generateSuggestion(suggestionInput(savedDraft.version));
    const savedPreview = await engine.preview("event-1");

    expect(run.candidateDiagnostics.conflicts).toEqual([expect.objectContaining({ kind: "room" })]);
    expect(run).not.toHaveProperty("validation");
    expect(savedPreview.validation.conflicts).toEqual([]);
    expect(await engine.getDraft("event-1")).toEqual(savedDraft);
  });

  it("rejects applying a run after its base draft revision becomes stale", async () => {
    const provider: AgendaSuggestionProvider = {
      suggest: () => ({
        placements: [
          {
            sessionId: "session-2",
            roomId: "room-large",
            startsAtLocal: "2026-08-10T09:00",
            endsAtLocal: "2026-08-10T10:00",
          },
        ],
      }),
    };
    const engine = createEngine(provider);
    await initialize(engine);
    const run = await engine.generateSuggestion(suggestionInput());

    const changedDraft = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-3", "session-3", "room-large", "2026-08-10T11:00", "2026-08-10T12:00"),
      ],
    });
    const changeId = run.diff.changes[0]?.id ?? "missing";

    await expect(
      engine.applySuggestion({
        eventId: "event-1",
        runId: run.id,
        actorId: "organizer-1",
        expectedDraftVersion: changedDraft.version,
        acceptedChangeIds: [changeId],
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect((await engine.getDraft("event-1")).entries).toEqual(changedDraft.entries);
    expect((await engine.getSuggestion("event-1", run.id)).status).toBe("pending");
  });

  it("re-runs hard-conflict validation and never publishes while applying", async () => {
    const provider: AgendaSuggestionProvider = {
      suggest: () => ({
        placements: [
          {
            sessionId: "session-2",
            roomId: "room-small",
            startsAtLocal: "2026-08-10T09:30",
            endsAtLocal: "2026-08-10T10:30",
          },
        ],
      }),
    };
    const engine = createEngine(provider);
    await initialize(engine);
    const existing = await engine.updateDraft({
      eventId: "event-1",
      expectedVersion: 1,
      actorId: "organizer-1",
      entries: [
        entry("entry-1", "session-1", "room-small", "2026-08-10T09:00", "2026-08-10T10:00"),
      ],
    });
    const run = await engine.generateSuggestion({
      ...suggestionInput(existing.version),
      rooms: ["room-small"],
    });
    const changeId = run.diff.changes[0]?.id ?? "missing";

    await expect(
      engine.applySuggestion({
        eventId: "event-1",
        runId: run.id,
        actorId: "organizer-1",
        acceptedChangeIds: [changeId],
      }),
    ).rejects.toBeInstanceOf(AgendaValidationError);
    expect((await engine.getDraft("event-1")).entries).toEqual(existing.entries);
    expect(await engine.getPublishedAgenda("event-1")).toBeNull();
    expect(await engine.getOutbox("event-1")).toEqual([]);
  });

  it("applies only selected changes and records the human acceptance audit", async () => {
    const provider: AgendaSuggestionProvider = {
      suggest: () => ({
        placements: [
          {
            sessionId: "session-2",
            roomId: "room-large",
            startsAtLocal: "2026-08-10T09:00",
            endsAtLocal: "2026-08-10T10:00",
          },
          {
            sessionId: "session-3",
            roomId: "room-large",
            startsAtLocal: "2026-08-10T11:00",
            endsAtLocal: "2026-08-10T12:00",
          },
        ],
      }),
    };
    const engine = createEngine(provider);
    await initialize(engine);
    const run = await engine.generateSuggestion(suggestionInput());
    const selected = run.diff.changes.find((change) => change.sessionId === "session-2");
    const unselected = run.diff.changes.find((change) => change.sessionId === "session-3");
    expect(selected).toBeDefined();
    expect(unselected).toBeDefined();

    const draft = await engine.applySuggestion({
      eventId: "event-1",
      runId: run.id,
      actorId: "organizer-1",
      acceptedChangeIds: [selected?.id ?? "missing"],
    });

    expect(draft.entries.map((candidate) => candidate.sessionId)).toEqual(["session-2"]);
    const appliedRun = await engine.getSuggestion("event-1", run.id);
    expect(appliedRun.status).toBe("applied");
    expect(appliedRun.acceptedChangeIds).toEqual([selected?.id]);
    expect((await engine.getAudit("event-1")).at(-1)?.details).toMatchObject({
      runId: run.id,
      acceptedChangeIds: selected?.id,
    });
    expect(await engine.getPublishedAgenda("event-1")).toBeNull();
    expect(await engine.getOutbox("event-1")).toEqual([]);
  });

  it("regenerates a pending run as a new version and supersedes the prior run", async () => {
    let generation = 0;
    const provider: AgendaSuggestionProvider = {
      suggest: () => {
        generation += 1;
        const start = generation === 1 ? "09:00" : "10:00";
        return {
          placements: [
            {
              sessionId: "session-2",
              roomId: "room-large",
              startsAtLocal: `2026-08-10T${start}`,
              endsAtLocal: `2026-08-10T${generation === 1 ? "10:00" : "11:00"}`,
            },
          ],
        };
      },
    };
    const engine = createEngine(provider);
    await initialize(engine);
    const first = await engine.generateSuggestion(suggestionInput());
    const second = await engine.regenerateSuggestion({
      eventId: "event-1",
      runId: first.id,
      actorId: "organizer-1",
    });

    expect(generation).toBe(2);
    expect(second.version).toBe(first.version + 1);
    expect(second.regenerationOfRunId).toBe(first.id);
    expect((await engine.getSuggestion("event-1", first.id)).status).toBe("superseded");
    expect((await engine.getSuggestionRuns("event-1")).map((run) => run.version)).toEqual([1, 2]);
    expect(second.diff.summary).toContain("Add");
  });
});
