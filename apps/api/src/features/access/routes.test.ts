import { describe, expect, it } from "vitest";
import { type ApiBindings, createApp } from "../../app";
import { AuthAccessError, type AuthPrincipal, type UserPrincipal } from "../auth/types";
import type { AccessRouteDependencies } from "./routes";

const environment: ApiBindings = {
  APP_ENV: "local",
  WEB_ORIGIN: "http://localhost:3015",
};

const user: UserPrincipal = {
  kind: "user",
  sessionId: "session-1",
  userId: "user-1",
  email: "user@example.test",
  memberships: [
    { organizationId: "org-a", role: "owner" },
    { organizationId: "org-empty", role: "reviewer" },
  ],
  speakerGrants: [],
  reviewerGrants: [],
};

const apiKey: AuthPrincipal = {
  kind: "apiKey",
  apiKeyId: "key-1",
  organizationId: "org-a",
  scopes: ["events:read"],
};

function dependencies(): AccessRouteDependencies {
  return {
    listOrganizationsForUser: async () => [
      { organizationId: "org-empty", name: "Empty organization" },
      { organizationId: "org-a", name: "Alpha organization" },
    ],
    listEvents: async (organizationId) =>
      organizationId === "org-a"
        ? [{ organizationId, eventId: "event-a", name: "Alpha event" }]
        : [],
    listEvaluationPlans: async (organizationId) =>
      organizationId === "org-a" ? [{ organizationId, eventId: "event-a" }] : [],
    listSpeakerContextScopes: async () => [],
    speakerTasks: {
      resolveScope: async () => null,
      listSessions: async () => [],
      listTasks: async () => [],
    },
    reviewerWorkspace: {
      listReviewerWorkspace: async () => ({ assignments: [] }),
    },
  };
}

function appFor(principal: AuthPrincipal | null) {
  return createApp({
    authenticator: {
      authenticate: async () => {
        if (principal === null) {
          throw new AuthAccessError("UNAUTHENTICATED", "Authentication is required.");
        }
        return principal;
      },
    },
    access: dependencies(),
  });
}

describe("GET /api/account/access-contexts", () => {
  it("lists combined event contexts with deterministic ordering and private no-store caching", async () => {
    const response = await appFor(user).request("/api/account/access-contexts", {}, environment);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      data: [
        {
          scope: "organization",
          organization: { id: "org-a", name: "Alpha organization" },
          membershipRole: "owner",
          roles: ["organizer"],
          capabilities: ["organizer.overview.read"],
        },
        {
          scope: "event",
          organization: { id: "org-a", name: "Alpha organization" },
          event: { id: "event-a", name: "Alpha event" },
          membershipRole: "owner",
          roles: ["organizer"],
          capabilities: ["organizer.overview.read"],
        },
        {
          scope: "organization",
          organization: { id: "org-empty", name: "Empty organization" },
          membershipRole: "reviewer",
          roles: [],
          capabilities: [],
        },
      ],
    });
  });

  it.each([
    ["an unauthenticated caller", null, 401, "AUTHENTICATION_REQUIRED"],
    ["an API-key caller", apiKey, 403, "ACCESS_DENIED"],
  ] as const)("denies %s", async (_label, principal, status, code) => {
    const response = await appFor(principal).request(
      "/api/account/access-contexts",
      {},
      environment,
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code } });
  });
});
