import { describe, expect, it, vi } from "vitest";
import { type ApiBindings, createApp } from "../../app";
import { AuthAccessError, type AuthPrincipal, type UserPrincipal } from "../auth/types";
import type { AccessRouteDependencies } from "./routes";

const environment: ApiBindings = { APP_ENV: "local", WEB_ORIGIN: "http://localhost:3015" };
const user: UserPrincipal = {
  kind: "user",
  sessionId: "session-1",
  userId: "speaker-1",
  email: "speaker@example.test",
  memberships: [],
  speakerGrants: [
    { organizationId: "org-a", speakerProfileId: "profile:shared-event:participant-1" },
  ],
  reviewerGrants: [],
};
const apiKey: AuthPrincipal = {
  kind: "apiKey",
  apiKeyId: "key-1",
  organizationId: "org-a",
  scopes: ["events:read"],
};

function dependencies(overrides: Partial<AccessRouteDependencies> = {}): AccessRouteDependencies {
  return {
    listOrganizationsForUser: async () => [{ organizationId: "org-a", name: "Alpha" }],
    listEvents: async (organizationId) => [
      { organizationId, eventId: "shared-event", name: `${organizationId} event` },
    ],
    listEvaluationPlans: async () => [],
    listSpeakerContextScopes: async () => [],
    reviewerWorkspace: { listReviewerWorkspace: async () => ({ assignments: [] }) },
    speakerTasks: {
      resolveScope: async (principal, organizationId, eventId) => ({
        tenantId: organizationId,
        organizationId,
        eventId,
        accountId: principal.userId,
        participantIds: ["participant-1"],
        submissionIds: [],
        capabilities: ["task-response"],
        capabilitiesByParticipant: { "participant-1": ["task-response"] },
      }),
      listSessions: async (organizationId, eventId, sessionIds) =>
        sessionIds.map((sessionId) => ({
          tenantId: organizationId,
          eventId,
          sessionId,
          status: "accepted",
          speakerIds: ["participant-1"],
        })),
      listTasks: async (organizationId, eventId) => [
        {
          organizationId,
          eventId,
          taskId: "task-1",
          sessionId: "session-1",
          participantId: "participant-1",
          owner: "speaker",
          title: `${organizationId} slides`,
          dueAt: "2026-08-20T12:00:00.000Z",
          status: "not_started",
        },
      ],
    },
    ...overrides,
  };
}
function appFor(principal: AuthPrincipal | null, access = dependencies()) {
  return createApp({
    authenticator: {
      authenticate: async () => {
        if (principal === null)
          throw new AuthAccessError("UNAUTHENTICATED", "Authentication is required.");
        return principal;
      },
    },
    access,
  });
}

describe("GET /api/account/speaker-tasks", () => {
  it("carries organization and event through scope, canonical session, and task reads", async () => {
    const base = dependencies();
    const resolveScope = vi.fn(base.speakerTasks.resolveScope);
    const listSessions = vi.fn(base.speakerTasks.listSessions);
    const listTasks = vi.fn(base.speakerTasks.listTasks);
    const response = await appFor(
      user,
      dependencies({ speakerTasks: { resolveScope, listSessions, listTasks } }),
    ).request(
      "/api/account/speaker-tasks?organizationId=org-a&eventId=shared-event",
      {},
      environment,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(resolveScope).toHaveBeenCalledWith(user, "org-a", "shared-event");
    expect(listSessions).toHaveBeenCalledWith("org-a", "shared-event", ["session-1"]);
    expect(listTasks).toHaveBeenCalledWith("org-a", "shared-event", ["participant-1"]);
    await expect(response.json()).resolves.toEqual({
      data: {
        organizationId: "org-a",
        eventId: "shared-event",
        tasks: [
          {
            taskId: "task-1",
            title: "org-a slides",
            dueAt: "2026-08-20T12:00:00.000Z",
            status: "not_started",
          },
        ],
      },
    });
  });
  it("keeps participant-only tasks under invitation grants without CFP submissions", async () => {
    const base = dependencies();
    const listSessions = vi.fn(base.speakerTasks.listSessions);
    const response = await appFor(
      user,
      dependencies({
        speakerTasks: {
          ...base.speakerTasks,
          listSessions,
          listTasks: async (organizationId, eventId) => [
            {
              organizationId,
              eventId,
              taskId: "participant-task",
              sessionId: null,
              participantId: "participant-1",
              owner: "speaker",
              title: "Biography",
              dueAt: null,
              status: "not_started",
            },
          ],
        },
      }),
    ).request(
      "/api/account/speaker-tasks?organizationId=org-a&eventId=shared-event",
      {},
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { tasks: [{ taskId: "participant-task" }] },
    });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it.each([
    ["stale", "draft", ["participant-1"]],
    ["declined", "declined", ["participant-1"]],
    ["removed member", "accepted", []],
  ])("omits %s session tasks", async (_label, status, speakerIds) => {
    const base = dependencies();
    const response = await appFor(
      user,
      dependencies({
        speakerTasks: {
          ...base.speakerTasks,
          listSessions: async (_organizationId, eventId, sessionIds) =>
            sessionIds.map((sessionId) => ({
              tenantId: "org-a",
              eventId,
              sessionId,
              status,
              speakerIds,
            })),
        },
      }),
    ).request(
      "/api/account/speaker-tasks?organizationId=org-a&eventId=shared-event",
      {},
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { tasks: [] } });
  });

  it("returns no tasks and skips workload reads for submission-edit-only scope", async () => {
    const base = dependencies();
    const listSessions = vi.fn(base.speakerTasks.listSessions);
    const listTasks = vi.fn(base.speakerTasks.listTasks);
    const response = await appFor(
      user,
      dependencies({
        speakerTasks: {
          ...base.speakerTasks,
          resolveScope: async (principal, organizationId, eventId) => ({
            tenantId: organizationId,
            organizationId,
            eventId,
            accountId: principal.userId,
            participantIds: ["participant-1"],
            submissionIds: ["submission-1"],
            capabilities: ["submission-edit"],
            capabilitiesByParticipant: { "participant-1": ["submission-edit"] },
          }),
          listSessions,
          listTasks,
        },
      }),
    ).request(
      "/api/account/speaker-tasks?organizationId=org-a&eventId=shared-event",
      {},
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { organizationId: "org-a", eventId: "shared-event", tasks: [] },
    });
    expect(listSessions).not.toHaveBeenCalled();
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("filters mixed participant scope to task-response-authorized tasks", async () => {
    const base = dependencies();
    const listTasks = vi.fn(async (organizationId: string, eventId: string) => [
      {
        organizationId,
        eventId,
        taskId: "task-authorized",
        sessionId: "session-1",
        participantId: "participant-1",
        owner: "speaker" as const,
        title: "Authorized",
        dueAt: null,
        status: "not_started" as const,
      },
    ]);
    const response = await appFor(
      user,
      dependencies({
        speakerTasks: {
          ...base.speakerTasks,
          resolveScope: async (principal, organizationId, eventId) => ({
            tenantId: organizationId,
            organizationId,
            eventId,
            accountId: principal.userId,
            participantIds: ["participant-1", "participant-2"],
            submissionIds: ["submission-1"],
            capabilities: ["task-response"],
            capabilitiesByParticipant: {
              "participant-1": ["task-response"],
              "participant-2": ["submission-edit"],
            },
          }),
          listSessions: async (organizationId, eventId, sessionIds) =>
            sessionIds.map((sessionId) => ({
              tenantId: organizationId,
              eventId,
              sessionId,
              status: "accepted",
              speakerIds: ["participant-1"],
            })),
          listTasks,
        },
      }),
    ).request(
      "/api/account/speaker-tasks?organizationId=org-a&eventId=shared-event",
      {},
      environment,
    );

    expect(response.status).toBe(200);
    expect(listTasks).toHaveBeenCalledWith("org-a", "shared-event", ["participant-1"]);
    await expect(response.json()).resolves.toEqual({
      data: {
        organizationId: "org-a",
        eventId: "shared-event",
        tasks: [
          { taskId: "task-authorized", title: "Authorized", dueAt: null, status: "not_started" },
        ],
      },
    });
  });

  it("keeps identical task, participant, and submission IDs tenant-correct", async () => {
    const response = await appFor(user).request(
      "/api/account/speaker-tasks?organizationId=org-a&eventId=shared-event",
      {},
      environment,
    );
    expect(response.status).toBe(200);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("org-a slides");
    expect(serialized).not.toContain("org-b slides");
  });

  it.each([
    [
      "missing tenant",
      {
        resolveScope: async () => ({
          organizationId: "org-a",
          eventId: "shared-event",
          accountId: user.userId,
          participantIds: ["participant-1"],
          submissionIds: ["submission-1"],
        }),
      },
    ],
    [
      "mismatched tenant",
      {
        resolveScope: async () => ({
          tenantId: "org-b",
          organizationId: "org-b",
          eventId: "shared-event",
          accountId: user.userId,
          participantIds: ["participant-1"],
          submissionIds: ["submission-1"],
        }),
      },
    ],
    ["revoked grant", { resolveScope: async () => null }],
    [
      "cross-organization canonical session",
      {
        listSessions: async () => [
          {
            tenantId: "org-b",
            eventId: "shared-event",
            sessionId: "session-1",
            status: "accepted",
            speakerIds: ["participant-1"],
          },
        ],
      },
    ],
    [
      "cross-organization task",
      {
        listTasks: async () => [
          {
            organizationId: "org-b",
            eventId: "shared-event",
            taskId: "task-1",
            submissionId: "submission-1",
            participantId: "participant-1",
            owner: "speaker",
            title: "org-b slides",
            dueAt: null,
            status: "not_started",
          },
        ],
      },
    ],
  ])("denies %s without retrying a legacy route", async (_label, speakerOverrides) => {
    const base = dependencies();
    const response = await appFor(
      user,
      dependencies({
        speakerTasks: {
          ...base.speakerTasks,
          ...speakerOverrides,
        } as AccessRouteDependencies["speakerTasks"],
      }),
    ).request(
      "/api/account/speaker-tasks?organizationId=org-a&eventId=shared-event",
      {},
      environment,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ACCESS_DENIED" } });
  });

  it.each([
    ["missing organization", "/api/account/speaker-tasks?eventId=shared-event"],
    ["missing event", "/api/account/speaker-tasks?organizationId=org-a"],
  ])("denies %s", async (_label, path) => {
    expect((await appFor(user).request(path, {}, environment)).status).toBe(403);
  });

  it("denies a mismatched organization/event resolved by the dependency", async () => {
    const base = dependencies();
    const response = await appFor(
      user,
      dependencies({
        speakerTasks: {
          ...base.speakerTasks,
          resolveScope: async () => ({
            tenantId: "org-a",
            organizationId: "org-a",
            eventId: "shared-event",
            accountId: user.userId,
            participantIds: ["participant-1"],
            submissionIds: ["submission-1"],
            capabilities: ["task-response"],
          }),
        },
      }),
    ).request(
      "/api/account/speaker-tasks?organizationId=org-a&eventId=other-event",
      {},
      environment,
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ["anonymous", null, 401],
    ["API key", apiKey, 403],
  ] as const)("denies %s", async (_label, principal, status) => {
    expect(
      (
        await appFor(principal).request(
          "/api/account/speaker-tasks?organizationId=org-a&eventId=shared-event",
          {},
          environment,
        )
      ).status,
    ).toBe(status);
  });
});
