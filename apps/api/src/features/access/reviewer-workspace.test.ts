import { describe, expect, it, vi } from "vitest";
import { type ApiBindings, createApp } from "../../app";
import { AuthAccessError, type AuthPrincipal, type UserPrincipal } from "../auth/types";
import type {
  EvaluationReviewerWorkspace,
  EvaluationReviewerWorkspaceAssignment,
} from "../evaluations/service";
import type { EvaluationActor } from "../evaluations/types";
import type { AccessRouteDependencies } from "./routes";

const environment: ApiBindings = {
  APP_ENV: "local",
  WEB_ORIGIN: "http://localhost:3015",
};

const user: UserPrincipal = {
  kind: "user",
  sessionId: "session-1",
  userId: "reviewer-1",
  email: "reviewer@example.test",
  memberships: [
    { organizationId: "org-a", role: "reviewer" },
    { organizationId: "org-b", role: "reviewer" },
  ],
  reviewerGrants: [
    { organizationId: "org-a", eventId: "shared-event" },
    { organizationId: "org-b", eventId: "shared-event" },
  ],
  speakerGrants: [],
};

const apiKey: AuthPrincipal = {
  kind: "apiKey",
  apiKeyId: "key-1",
  organizationId: "org-a",
  scopes: ["events:read"],
};

function assignment(
  tenantId: string,
  eventId: string,
  reviewerId = user.userId,
): EvaluationReviewerWorkspaceAssignment {
  const timestamp = "2026-08-10T12:00:00.000Z";
  return {
    assignment: {
      id: "shared-assignment",
      tenantId,
      eventId,
      planId: "shared-plan",
      roundId: "shared-round",
      submissionId: "shared-submission",
      reviewerId,
      status: "assigned",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    round: {
      id: "shared-round",
      name: "Round one",
      sequence: 1,
      closesAt: tenantId === "org-a" ? "2026-08-20T12:00:00.000Z" : null,
      rubric: { id: "rubric-1", name: "Rubric", criteria: [] },
    },
    submission: {
      id: "shared-submission",
      title: `${tenantId} blind proposal`,
      abstract: "Blind-safe abstract",
      answers: { topic: "Visible" },
      participants: [],
      identityRedacted: true,
    },
    review: null,
    plan: {
      id: "shared-plan",
      organizationId: tenantId,
      organizationName: `${tenantId} organization`,
      eventId,
      eventName: `${tenantId} event`,
      name: `${tenantId} plan`,
      status: "open",
      blindReview: true,
      closesAt: tenantId === "org-a" ? "2026-08-20T12:00:00.000Z" : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function dependencies(overrides: Partial<AccessRouteDependencies> = {}): AccessRouteDependencies {
  return {
    listOrganizationsForUser: async () => [
      { organizationId: "org-a", name: "Alpha organization" },
      { organizationId: "org-b", name: "Beta organization" },
    ],
    listEvents: async (organizationId) => [
      { organizationId, eventId: "shared-event", name: `${organizationId} event` },
    ],
    listEvaluationPlans: async (organizationId) => [
      {
        organizationId,
        eventId: "shared-event",
        planId: "shared-plan",
        closesAt: organizationId === "org-b" ? "2026-08-22T12:00:00.000Z" : null,
      },
    ],
    listSpeakerContextScopes: async () => [],
    speakerTasks: {
      resolveScope: async () => null,
      listSessions: async () => [],
      listTasks: async () => [],
    },
    reviewerWorkspace: {
      listReviewerWorkspace: async (actor, eventId): Promise<EvaluationReviewerWorkspace> => ({
        assignments: [assignment(actor.tenantId, eventId ?? "shared-event")],
      }),
    },
    ...overrides,
  };
}

function appFor(principal: AuthPrincipal | null, access = dependencies()) {
  return createApp({
    authenticator: {
      authenticate: async () => {
        if (principal === null) {
          throw new AuthAccessError("UNAUTHENTICATED", "Authentication is required.");
        }
        return principal;
      },
    },
    access,
  });
}

describe("GET /api/account/reviewer-workspace", () => {
  it("does not expose assignments for a pending reviewer event invitation", async () => {
    const listReviewerWorkspace = vi.fn();
    const pendingReviewerInvitee: UserPrincipal = {
      ...user,
      reviewerGrants: [],
    };

    const response = await appFor(
      pendingReviewerInvitee,
      dependencies({ reviewerWorkspace: { listReviewerWorkspace } }),
    ).request("/api/account/reviewer-workspace", {}, environment);

    expect(response.status).toBe(200);
    expect(listReviewerWorkspace).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      data: { organizations: [], warnings: [] },
    });
  });

  it("exposes preserved assignments only for the accepted reviewer event invitation", async () => {
    const eventA = "event-a";
    const eventB = "event-b";
    const acceptedEventAReviewer: UserPrincipal = {
      ...user,
      memberships: [{ organizationId: "org-a", role: "reviewer" }],
      reviewerGrants: [{ organizationId: "org-a", eventId: eventA }],
    };
    const listReviewerWorkspace = vi.fn(async (actor: EvaluationActor) => ({
      assignments: [assignment("org-a", eventA), assignment("org-a", eventB)].filter((entry) =>
        actor.grants.some(
          (grant) => grant.role === "reviewer" && grant.eventId === entry.assignment.eventId,
        ),
      ),
    }));

    const response = await appFor(
      acceptedEventAReviewer,
      dependencies({
        listEvents: async (organizationId) =>
          organizationId === "org-a"
            ? [
                { organizationId, eventId: eventA, name: "Event A" },
                { organizationId, eventId: eventB, name: "Event B" },
              ]
            : [],
        listEvaluationPlans: async (organizationId) => [
          {
            organizationId,
            eventId: eventA,
            planId: "shared-plan",
            closesAt: null,
          },
          {
            organizationId,
            eventId: eventB,
            planId: "shared-plan",
            closesAt: null,
          },
        ],
        reviewerWorkspace: { listReviewerWorkspace },
      }),
    ).request("/api/account/reviewer-workspace", {}, environment);
    const body = (await response.json()) as {
      data: {
        organizations: Array<{
          organization: { id: string };
          assignments: Array<{ assignment: { eventId: string } }>;
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(listReviewerWorkspace).toHaveBeenCalledWith(
      {
        tenantId: "org-a",
        userId: user.userId,
        kind: "human",
        grants: [{ eventId: eventA, role: "reviewer" }],
      },
      undefined,
    );
    expect(
      body.data.organizations.map(({ organization, assignments }) => ({
        organizationId: organization.id,
        eventIds: assignments.map((entry) => entry.assignment.eventId),
      })),
    ).toEqual([{ organizationId: "org-a", eventIds: [eventA] }]);
  });

  it("denies the same organization's unaccepted reviewer event", async () => {
    const listReviewerWorkspace = vi.fn();
    const acceptedEventAReviewer: UserPrincipal = {
      ...user,
      memberships: [{ organizationId: "org-a", role: "reviewer" }],
      reviewerGrants: [{ organizationId: "org-a", eventId: "event-a" }],
    };

    const response = await appFor(
      acceptedEventAReviewer,
      dependencies({ reviewerWorkspace: { listReviewerWorkspace } }),
    ).request(
      "/api/account/reviewer-workspace?organizationId=org-a&eventId=event-b",
      {},
      environment,
    );

    expect(response.status).toBe(403);
    expect(listReviewerWorkspace).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ACCESS_DENIED" } });
  });

  it("aggregates one actor per organization while preserving duplicate identifiers and deadlines", async () => {
    const calls: Array<{ actor: EvaluationActor; eventId?: string }> = [];
    const access = dependencies({
      reviewerWorkspace: {
        listReviewerWorkspace: async (actor, eventId) => {
          calls.push({ actor, ...(eventId === undefined ? {} : { eventId }) });
          return { assignments: [assignment(actor.tenantId, eventId ?? "shared-event")] };
        },
      },
    });

    const response = await appFor(user, access).request(
      "/api/account/reviewer-workspace",
      {},
      environment,
    );
    const body = (await response.json()) as {
      data: {
        organizations: Array<{
          organization: { id: string; name: string };
          assignments: Array<{
            assignment: { id: string; tenantId: string; reviewerId: string };
            plan: { id: string; closesAt: string | null };
            round: { id: string; closesAt: string | null };
          }>;
        }>;
        warnings: unknown[];
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(calls).toEqual([
      {
        actor: {
          tenantId: "org-a",
          userId: user.userId,
          kind: "human",
          grants: [{ eventId: "shared-event", role: "reviewer" }],
        },
      },
      {
        actor: {
          tenantId: "org-b",
          userId: user.userId,
          kind: "human",
          grants: [{ eventId: "shared-event", role: "reviewer" }],
        },
      },
    ]);
    expect(body.data.warnings).toEqual([]);
    expect(body.data.organizations.map((entry) => entry.organization.id)).toEqual([
      "org-a",
      "org-b",
    ]);
    expect(body.data.organizations.map((entry) => entry.assignments[0])).toEqual([
      expect.objectContaining({
        assignment: expect.objectContaining({
          id: "shared-assignment",
          tenantId: "org-a",
          reviewerId: user.userId,
        }),
        plan: expect.objectContaining({ id: "shared-plan", closesAt: null }),
        round: expect.objectContaining({
          id: "shared-round",
          closesAt: "2026-08-20T12:00:00.000Z",
        }),
      }),
      expect.objectContaining({
        assignment: expect.objectContaining({
          id: "shared-assignment",
          tenantId: "org-b",
          reviewerId: user.userId,
        }),
        plan: expect.objectContaining({
          id: "shared-plan",
          closesAt: "2026-08-22T12:00:00.000Z",
        }),
        round: expect.objectContaining({ id: "shared-round", closesAt: null }),
      }),
    ]);
  });

  it("intersects explicit organization and event filters with a non-first reviewer membership", async () => {
    const listReviewerWorkspace = vi.fn(async (actor: EvaluationActor, eventId?: string) => ({
      assignments: [assignment(actor.tenantId, eventId ?? "shared-event")],
    }));
    const response = await appFor(
      user,
      dependencies({ reviewerWorkspace: { listReviewerWorkspace } }),
    ).request(
      "/api/account/reviewer-workspace?organizationId=org-b&eventId=shared-event",
      {},
      environment,
    );

    expect(response.status).toBe(200);
    expect(listReviewerWorkspace).toHaveBeenCalledOnce();
    expect(listReviewerWorkspace).toHaveBeenCalledWith(
      {
        tenantId: "org-b",
        userId: user.userId,
        kind: "human",
        grants: [{ eventId: "shared-event", role: "reviewer" }],
      },
      "shared-event",
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { organizations: [{ organization: { id: "org-b" } }] },
    });
  });

  it("keeps another reviewer's assignments hidden and isolates one organization failure", async () => {
    const response = await appFor(
      user,
      dependencies({
        reviewerWorkspace: {
          listReviewerWorkspace: async (actor) => {
            if (actor.tenantId === "org-a") throw new Error("org-a unavailable");
            return {
              assignments: [
                assignment(actor.tenantId, "shared-event", "another-reviewer"),
                assignment(actor.tenantId, "shared-event"),
              ],
            };
          },
        },
      }),
    ).request("/api/account/reviewer-workspace", {}, environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        organizations: [
          {
            organization: { id: "org-b" },
            assignments: [{ assignment: { tenantId: "org-b", reviewerId: user.userId } }],
          },
        ],
        warnings: [{ organization: { id: "org-a" }, code: "WORKSPACE_UNAVAILABLE" }],
      },
    });
  });

  it("treats cross-tenant records as only that organization's failure", async () => {
    const response = await appFor(
      user,
      dependencies({
        reviewerWorkspace: {
          listReviewerWorkspace: async (actor) => ({
            assignments: [
              assignment(actor.tenantId === "org-a" ? "org-b" : actor.tenantId, "shared-event"),
            ],
          }),
        },
      }),
    ).request("/api/account/reviewer-workspace", {}, environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        organizations: [{ organization: { id: "org-b" } }],
        warnings: [{ organization: { id: "org-a" }, code: "WORKSPACE_UNAVAILABLE" }],
      },
    });
  });

  it("rejects an unauthorized explicit filter without calling the workspace service", async () => {
    const listReviewerWorkspace = vi.fn();
    const response = await appFor(
      user,
      dependencies({ reviewerWorkspace: { listReviewerWorkspace } }),
    ).request(
      "/api/account/reviewer-workspace?organizationId=org-missing&eventId=shared-event",
      {},
      environment,
    );

    expect(response.status).toBe(403);
    expect(listReviewerWorkspace).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ACCESS_DENIED" } });
  });

  it.each([
    ["an unauthenticated caller", null, 401, "AUTHENTICATION_REQUIRED"],
    ["an API-key caller", apiKey, 403, "ACCESS_DENIED"],
  ] as const)("denies %s", async (_label, principal, status, code) => {
    const response = await appFor(principal).request(
      "/api/account/reviewer-workspace",
      {},
      environment,
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });
});
