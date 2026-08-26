import { describe, expect, it } from "vitest";
import { type ApiBindings, createApp } from "../../apps/api/src/app";
import { AgendaEngine } from "../../apps/api/src/features/agenda/engine";
import {
  InMemoryAgendaMutationLock,
  InMemoryAgendaRepository,
} from "../../apps/api/src/features/agenda/infrastructure";
import { RequestAuthenticator } from "../../apps/api/src/features/auth/authenticator";
import type {
  AuthSession,
  BetterAuthGateway,
  D1ApiKeyGateway,
  StoredApiKey,
} from "../../apps/api/src/features/auth/types";
import { apiErrorSchema } from "../../packages/contracts/src";

const environment: ApiBindings = {
  APP_ENV: "local",
  WEB_ORIGIN: "https://app.example.test",
};
const traceId = "eb833e79-5df0-4efa-8505-8fa9f293974a";
const adminPath = "/api/admin/organizations/org-1/events/event-1/agenda";
const publicPath = "/api/public/events/event-1/agenda";
const ownerHeaders = {
  cookie: "better-auth.session_token=owner-session",
  "x-request-id": traceId,
};

const catalog = {
  minimumTravelMinutes: 10,
  sessions: [
    {
      id: "session-a",
      title: "Session A",
      status: "accepted" as const,
      publicApprovalEligible: true,
      participantIds: ["participant-shared"],
      resourceIds: [],
      capacityRequired: 10,
    },
    {
      id: "session-b",
      title: "Session B",
      status: "accepted" as const,
      publicApprovalEligible: true,
      participantIds: ["participant-shared"],
      resourceIds: [],
      capacityRequired: 10,
    },
  ],
  rooms: [{ id: "room-main", name: "Main", capacity: 100 }],
  tracks: [{ id: "track-api", name: "API" }],
};

const entryA = {
  id: "entry-a",
  sessionId: "session-a",
  roomId: "room-main",
  trackIds: ["track-api"],
  startsAtLocal: "2026-11-10T09:00:00",
  endsAtLocal: "2026-11-10T10:00:00",
};

function authenticatorFixture() {
  const sessions = new Map<string, AuthSession>([
    [
      "owner-session",
      {
        sessionId: "owner-session-id",
        userId: "owner-user",
        email: "owner@example.test",
        emailVerified: true,
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        memberships: [{ organizationId: "org-1", role: "owner" }],
        speakerGrants: [],
        reviewerGrants: [],
      },
    ],
    [
      "other-owner-session",
      {
        sessionId: "other-owner-session-id",
        userId: "other-owner-user",
        email: "other@example.test",
        emailVerified: true,
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        memberships: [{ organizationId: "org-2", role: "owner" }],
        speakerGrants: [],
        reviewerGrants: [],
      },
    ],
  ]);
  const apiKey: StoredApiKey = {
    id: "agenda-key",
    organizationId: "org-1",
    label: "Agenda automation",
    scopes: ["agenda:read", "agenda:write"],
    expiresAt: null,
    revokedAt: null,
  };
  const betterAuth: BetterAuthGateway = {
    resolveSession: async (token) => sessions.get(token) ?? null,
    requestMagicLink: async () => undefined,
    consumeMagicLink: async () => null,
  };
  const apiKeys: D1ApiKeyGateway = {
    findByPresentedKey: async (token) => (token === "agenda-api-key" ? apiKey : null),
    recordSuccessfulUse: async () => undefined,
  };
  return new RequestAuthenticator(betterAuth, apiKeys, {
    clock: { now: () => new Date("2026-08-08T12:00:00.000Z") },
  });
}

function fixture() {
  let id = 0;
  const engine = new AgendaEngine(
    new InMemoryAgendaRepository(),
    new InMemoryAgendaMutationLock(),
    {
      clock: { now: () => new Date("2026-08-08T12:00:00.000Z") },
      idGenerator: { nextId: (prefix) => `${prefix}-${++id}` },
      eventScheduleForEvent: async () => ({
        startsAt: "2026-01-01T05:00:00.000Z",
        endsAt: "2027-01-01T04:59:59.999Z",
        timeZone: "America/New_York",
      }),
    },
  );
  const app = createApp({
    authenticator: authenticatorFixture(),
    agenda: {
      engine,
      organizationIdForEvent: async (eventId) => (eventId === "event-1" ? "org-1" : null),
      agendaCatalogForEvent: async (eventId) =>
        eventId === "event-1" ? catalog : { sessions: [], rooms: [], tracks: [] },
      calendarUidDomain: "calendar.example.test",
    },
  });
  return { app, engine };
}

async function createAgenda(app: ReturnType<typeof fixture>["app"]) {
  return app.request(
    adminPath,
    {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ minimumTravelMinutes: catalog.minimumTravelMinutes }),
    },
    environment,
  );
}

async function contractError(response: Response, status: number, code: string) {
  const body = apiErrorSchema.parse(await response.json());
  expect(response.status).toBe(status);
  expect(body.error.code).toBe(code);
  expect(body.error.traceId).toBe(traceId);
  return body;
}

describe("agenda API authorization and publication safety", () => {
  it("returns 401 without a session and forbids cross-tenant and API-key organizer access", async () => {
    const { app } = fixture();
    const unauthenticated = await app.request(
      `${adminPath}/draft`,
      { headers: { "x-request-id": traceId } },
      environment,
    );
    const crossTenant = await app.request(
      `${adminPath}/draft`,
      {
        headers: {
          cookie: "better-auth.session_token=other-owner-session",
          "x-request-id": traceId,
        },
      },
      environment,
    );
    const apiKey = await app.request(
      `${adminPath}/draft`,
      {
        headers: {
          authorization: "Bearer agenda-api-key",
          "x-request-id": traceId,
        },
      },
      environment,
    );

    await contractError(unauthenticated, 401, "AUTHENTICATION_REQUIRED");
    await contractError(crossTenant, 403, "ACCESS_DENIED");
    await contractError(apiKey, 403, "ACCESS_DENIED");
  });

  it("conceals an event when an authorized path tenant does not own it", async () => {
    const { app } = fixture();
    const response = await app.request(
      "/api/admin/organizations/org-2/events/event-1/agenda",
      {
        headers: {
          cookie: "better-auth.session_token=other-owner-session",
          "x-request-id": traceId,
        },
      },
      environment,
    );

    await contractError(response, 404, "NOT_FOUND");
  });

  it("returns structured validation errors for malformed JSON", async () => {
    const { app } = fixture();
    const response = await app.request(
      adminPath,
      {
        method: "POST",
        headers: { ...ownerHeaders, "content-type": "application/json" },
        body: "{not-json",
      },
      environment,
    );
    const body = await contractError(response, 400, "VALIDATION_FAILED");

    expect(body.error.details?.length).toBeGreaterThan(0);
  });

  it("blocks room and participant overlaps without persisting the rejected draft", async () => {
    const { app } = fixture();
    expect((await createAgenda(app)).status).toBe(201);
    const response = await app.request(
      `${adminPath}/draft`,
      {
        method: "PUT",
        headers: { ...ownerHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: 1,
          entries: [
            entryA,
            {
              ...entryA,
              id: "entry-b",
              sessionId: "session-b",
              startsAtLocal: "2026-11-10T09:30:00",
              endsAtLocal: "2026-11-10T10:30:00",
            },
          ],
        }),
      },
      environment,
    );
    const error = await contractError(response, 409, "CONFLICT");
    const draft = await app.request(`${adminPath}/draft`, { headers: ownerHeaders }, environment);
    const draftBody = (await draft.json()) as { data: { entries: unknown[]; version: number } };

    expect(error.error.details?.map((detail) => detail.code)).toEqual(
      expect.arrayContaining(["agenda.room", "agenda.participant"]),
    );
    expect(draftBody.data.entries).toEqual([]);
    expect(draftBody.data.version).toBe(1);
  });

  it("maps stale draft writes to a safe optimistic-concurrency conflict", async () => {
    const { app } = fixture();
    expect((await createAgenda(app)).status).toBe(201);
    const first = await app.request(
      `${adminPath}/draft`,
      {
        method: "PUT",
        headers: { ...ownerHeaders, "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 1, entries: [entryA] }),
      },
      environment,
    );
    const stale = await app.request(
      `${adminPath}/draft`,
      {
        method: "PUT",
        headers: { ...ownerHeaders, "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 1, entries: [] }),
      },
      environment,
    );

    expect(first.status).toBe(200);
    await contractError(stale, 409, "CONFLICT");
  });

  it("exposes only the immutable publication and never leaks draft or actor state", async () => {
    const { app } = fixture();
    expect((await createAgenda(app)).status).toBe(201);
    expect(
      (
        await app.request(
          `${adminPath}/draft`,
          {
            method: "PUT",
            headers: { ...ownerHeaders, "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 1, entries: [entryA] }),
          },
          environment,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `${adminPath}/validate`,
          {
            method: "POST",
            headers: { ...ownerHeaders, "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 2 }),
          },
          environment,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `${adminPath}/publish`,
          {
            method: "POST",
            headers: { ...ownerHeaders, "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 2 }),
          },
          environment,
        )
      ).status,
    ).toBe(200);

    const publishedBefore = await app.request(publicPath, {}, environment);
    const publishedBeforeBody = (await publishedBefore.json()) as {
      data: {
        revision: { number: number };
        entries: { startsAt: string }[];
      };
    };
    const changedDraft = await app.request(
      `${adminPath}/draft`,
      {
        method: "PUT",
        headers: { ...ownerHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: 2,
          entries: [
            {
              ...entryA,
              startsAtLocal: "2026-11-10T11:00:00",
              endsAtLocal: "2026-11-10T12:00:00",
            },
          ],
        }),
      },
      environment,
    );
    const publishedAfter = await app.request(publicPath, {}, environment);
    const publishedAfterBody = await publishedAfter.json();

    expect(changedDraft.status).toBe(200);
    expect(publishedBefore.status).toBe(200);
    expect(publishedBefore.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=30, must-revalidate",
    );
    expect(publishedBeforeBody.data.revision.number).toBe(1);
    expect(publishedBeforeBody.data.entries[0]?.startsAt).toBe("2026-11-10T14:00:00.000Z");
    expect(publishedAfterBody).toEqual(publishedBeforeBody);
    expect(JSON.stringify(publishedAfterBody)).not.toContain("sourceDraftVersion");
    expect(JSON.stringify(publishedAfterBody)).not.toContain("startsAtLocal");
    expect(JSON.stringify(publishedAfterBody)).not.toContain("owner-user");
    expect(JSON.stringify(publishedAfterBody)).not.toContain("publishedBy");
    expect(JSON.stringify(publishedAfterBody)).not.toContain("warningOverrides");
  });
});
