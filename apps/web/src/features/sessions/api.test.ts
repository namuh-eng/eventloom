import { describe, expect, it } from "vitest";
import { createSessionsApi, SessionsApiError } from "./api";

const session = {
  id: "session/1",
  eventId: "event/1",
  title: "Reliable worker pools",
  description: "How to keep jobs moving.",
  status: "Accepted",
  contentStatus: "Needs changes" as const,
  durationMinutes: 45,
  trackIds: ["track-1"],
  formatId: "format-1",
  speakerIds: ["speaker-1"],
  speakerRoster: [{ id: "speaker-1", displayName: "Avery Kim", role: "primary" }],
  version: 1,
  createdAt: "2026-08-09T12:00:00.000Z",
  updatedAt: "2026-08-09T12:00:00.000Z",
  updatedBy: "organizer-1",
};

describe("sessions API adapter", () => {
  it("uses canonical credentialed session and speaker endpoints for content and assignments", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const updated = {
      ...session,
      title: "Reliable worker pools, revised",
      trackIds: ["track-1", "track-2"],
      formatId: "format-2",
      durationMinutes: 40,
      version: 2,
    };
    const reassigned = {
      ...session,
      speakerIds: ["speaker-1", "speaker-2"],
      speakerRoster: [...session.speakerRoster, { id: "speaker-2" }],
      version: 2,
    };
    const restored = { ...session, version: 3, updatedAt: "2026-08-09T12:03:00.000Z" };

    const api = createSessionsApi(
      "https://api.example.test/",
      "org/1",
      "event/1",
      async (input, init) => {
        calls.push({ input, ...(init === undefined ? {} : { init }) });
        const path = String(input);

        if (path.endsWith("/sessions/tracks")) {
          return Response.json({
            data: [
              { id: "track-1", eventId: "event/1", name: "Engineering" },
              { id: "track-2", eventId: "event/1", name: "Operations" },
            ],
          });
        }
        if (path.endsWith("/sessions/formats")) {
          return Response.json({
            data: [
              { id: "format-1", eventId: "event/1", name: "Workshop" },
              { id: "format-2", eventId: "event/1", name: "Talk" },
            ],
          });
        }
        if (path.endsWith("/speakers")) {
          return Response.json({
            data: {
              organizationId: "org/1",
              eventId: "event/1",
              speakers: [
                {
                  participantId: "speaker-1",
                  displayName: "Avery Kim",
                  jobTitle: "Staff Engineer",
                  company: "Example Co",
                },
                { participantId: "speaker-2", displayName: "Morgan Lee" },
              ],
            },
          });
        }
        if (path.endsWith("/history")) {
          return Response.json({
            data: [
              {
                id: "history-1",
                action: "created",
                version: 1,
                actorId: "organizer-1",
                actorLabel: "organizer-1",
                occurredAt: "2026-08-09T12:00:00.000Z",
                snapshot: { title: session.title, description: session.description },
              },
            ],
          });
        }
        if (path.endsWith("/restore")) return Response.json({ data: restored });
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return Response.json({ data: "speakerIds" in body ? reassigned : updated });
        }
        return Response.json({ data: [session] });
      },
    );

    await expect(api.list()).resolves.toEqual([session]);
    await expect(
      api.updateContent({
        sessionId: session.id,
        expectedVersion: 1,
        title: updated.title,
        description: updated.description,
        trackIds: updated.trackIds,
        formatId: updated.formatId,
        durationMinutes: updated.durationMinutes,
      }),
    ).resolves.toEqual(updated);
    await expect(api.listTracks()).resolves.toEqual([
      { id: "track-1", name: "Engineering" },
      { id: "track-2", name: "Operations" },
    ]);
    await expect(api.listFormats()).resolves.toEqual([
      { id: "format-1", name: "Workshop" },
      { id: "format-2", name: "Talk" },
    ]);
    await expect(api.listSpeakers()).resolves.toEqual([
      {
        id: "speaker-1",
        displayName: "Avery Kim",
        jobTitle: "Staff Engineer",
        company: "Example Co",
      },
      { id: "speaker-2", displayName: "Morgan Lee" },
    ]);
    await expect(
      api.updateSpeakers({
        sessionId: session.id,
        expectedVersion: 1,
        speakerIds: ["speaker-1", "speaker-2"],
        speakerRoster: [
          { id: "speaker-1", displayName: "Avery Kim", role: "primary" },
          { id: "speaker-2", displayName: "Morgan Lee" },
        ],
      }),
    ).resolves.toEqual(reassigned);
    await expect(api.listHistory(session.id)).resolves.toEqual([
      {
        id: "history-1",
        action: "created",
        version: 1,
        actorId: "organizer-1",
        actorLabel: "Authorized organizer",
        occurredAt: "2026-08-09T12:00:00.000Z",
        snapshot: { title: session.title, description: session.description },
      },
    ]);
    await expect(
      api.restoreVersion({ sessionId: session.id, version: 1, expectedVersion: 2 }),
    ).resolves.toEqual(restored);

    expect(calls.map((call) => String(call.input))).toEqual([
      "https://api.example.test/api/admin/organizations/org%2F1/events/event%2F1/sessions",
      "https://api.example.test/api/admin/organizations/org%2F1/events/event%2F1/sessions/session%2F1",
      "https://api.example.test/api/admin/organizations/org%2F1/events/event%2F1/sessions/tracks",
      "https://api.example.test/api/admin/organizations/org%2F1/events/event%2F1/sessions/formats",
      "https://api.example.test/api/admin/organizations/org%2F1/events/event%2F1/speakers",
      "https://api.example.test/api/admin/organizations/org%2F1/events/event%2F1/sessions/session%2F1",
      "https://api.example.test/api/admin/organizations/org%2F1/events/event%2F1/sessions/session%2F1/history",
      "https://api.example.test/api/admin/organizations/org%2F1/events/event%2F1/sessions/session%2F1/restore",
    ]);
    expect(calls[0]?.init).toMatchObject({ credentials: "include", cache: "no-store" });
    expect(calls[1]?.init).toMatchObject({ method: "PATCH", credentials: "include" });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      expectedVersion: 1,
      title: updated.title,
      description: updated.description,
      trackIds: updated.trackIds,
      formatId: updated.formatId,
      durationMinutes: updated.durationMinutes,
    });
    expect(calls[4]?.init).toMatchObject({ credentials: "include", cache: "no-store" });
    expect(calls[5]?.init).toMatchObject({ method: "PATCH", credentials: "include" });
    expect(JSON.parse(String(calls[5]?.init?.body))).toEqual({
      expectedVersion: 1,
      speakerIds: ["speaker-1", "speaker-2"],
      speakerRoster: [
        { id: "speaker-1", displayName: "Avery Kim", role: "primary" },
        { id: "speaker-2", displayName: "Morgan Lee" },
      ],
    });
    expect(calls[7]?.init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(calls[7]?.init?.body))).toEqual({ version: 1, expectedVersion: 2 });
  });

  it("rejects malformed canonical session assignments and cross-event speaker rosters", async () => {
    const malformedSessionApi = createSessionsApi("", "org-1", "event-1", async () =>
      Response.json({ data: [{ ...session, eventId: "event-1", speakerIds: undefined }] }),
    );
    await expect(malformedSessionApi.list()).rejects.toThrow("invalid speaker IDs");

    const crossEventRosterApi = createSessionsApi("", "org-1", "event-1", async () =>
      Response.json({
        data: { organizationId: "org-1", eventId: "event-2", speakers: [] },
      }),
    );
    await expect(crossEventRosterApi.listSpeakers()).rejects.toThrow(
      "does not match the requested event",
    );
  });
  it.each([0, 1.5, 1_441, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed canonical session duration %p",
    async (durationMinutes) => {
      const api = createSessionsApi("", "org-1", "event-1", async () =>
        Response.json({ data: [{ ...session, eventId: "event-1", durationMinutes }] }),
      );

      await expect(api.list()).rejects.toThrow("does not match the requested event");
    },
  );

  it("rejects malformed and cross-event session taxonomy resources", async () => {
    const crossEventTracksApi = createSessionsApi("", "org-1", "event-1", async () =>
      Response.json({ data: [{ id: "track-1", eventId: "event-2", name: "Engineering" }] }),
    );
    await expect(crossEventTracksApi.listTracks()).rejects.toThrow(
      "does not match the requested event",
    );

    const malformedFormatsApi = createSessionsApi("", "org-1", "event-1", async () =>
      Response.json({ data: [{ id: "format-1", eventId: "event-1", name: " " }] }),
    );
    await expect(malformedFormatsApi.listFormats()).rejects.toThrow(
      "does not match the requested event",
    );
  });
  it("preserves canonical version conflicts", async () => {
    const api = createSessionsApi("", "org-1", "event-1", async () =>
      Response.json(
        {
          error: {
            code: "CONFLICT",
            message: "The session has changed.",
            traceId: "trace-1",
          },
        },
        { status: 409 },
      ),
    );

    await expect(
      api.updateSpeakers({
        sessionId: "session-1",
        expectedVersion: 2,
        speakerIds: ["speaker-1"],
        speakerRoster: [{ id: "speaker-1", displayName: "Avery Kim", role: "primary" }],
      }),
    ).rejects.toMatchObject(
      new SessionsApiError("CONFLICT", "The session has changed.", 409, "trace-1"),
    );
  });
});
