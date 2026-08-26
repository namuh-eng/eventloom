import { describe, expect, it, vi } from "vitest";
import { type PortalApi, PortalApiError } from "../api";
import type { PortalView } from "../types";
import { createLocalPortalDemoApi } from "./api";
import {
  isLocalApiEnvironment,
  isPortalDemoFallbackError,
  loadPortalWithLocalDemo,
} from "./fallback";

const eventId = "demo-event";

function apiWithPortal(loader: PortalApi["getPortal"]): PortalApi {
  return {
    getPortal: loader,
    async updateBiography() {
      throw new Error("Unexpected profile mutation.");
    },
    async transitionTask() {
      throw new Error("Unexpected task mutation.");
    },
    async uploadTaskFile() {
      throw new Error("Unexpected upload.");
    },
  };
}

function emptyPortal(): PortalView {
  return { submissions: [], sessions: [], profiles: [], tasks: [], outstandingTaskCount: 0 };
}

describe("local speaker portal demo adapter", () => {
  it("provides useful deterministic data without exposing mutable internal state", async () => {
    const api = createLocalPortalDemoApi(eventId);
    const first = await api.getPortal(eventId);

    expect(first).toMatchObject({
      outstandingTaskCount: 3,
      profiles: [{ displayName: "Ada Lovelace", version: 1 }],
      submissions: [{ status: "accepted" }, { status: "under_review" }],
      sessions: [
        {
          sessionId: "demo-session-resilient-events",
          title: "Building resilient event systems",
          status: "confirmed",
          version: 1,
        },
      ],
    });
    expect(first.tasks.map((task) => task.type)).toEqual(["action", "upload", "upload", "form"]);

    const profile = first.profiles[0];
    expect(profile).toBeDefined();
    if (profile) {
      profile.biography = "Changed outside the adapter";
    }
    await expect(api.getPortal(eventId)).resolves.toMatchObject({
      profiles: [{ biography: expect.stringContaining("resilient systems") }],
    });
    await expect(api.getPortal("another-event")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("persists biography edits with deterministic optimistic versions", async () => {
    const api = createLocalPortalDemoApi(eventId);
    const profile = (await api.getPortal(eventId)).profiles[0];
    expect(profile).toBeDefined();
    if (!profile) {
      throw new Error("Expected the seeded demo profile.");
    }

    const updated = await api.updateBiography({
      eventId,
      participantId: profile.participantId,
      biography: "Updated local biography",
      expectedVersion: profile.version,
    });

    expect(updated).toMatchObject({
      biography: "Updated local biography",
      version: 2,
      updatedAt: "2026-08-08T12:01:00.000Z",
    });
    await expect(
      api.updateBiography({
        eventId,
        participantId: profile.participantId,
        biography: "Stale edit",
        expectedVersion: profile.version,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });

  it("enforces dependencies and supports the action and upload task flow", async () => {
    const api = createLocalPortalDemoApi(eventId);
    const initial = await api.getPortal(eventId);
    const agreement = initial.tasks.find((task) => task.id === "demo-task-agreement");
    const headshot = initial.tasks.find((task) => task.id === "demo-task-headshot");
    expect(agreement).toBeDefined();
    expect(headshot).toBeDefined();
    if (!agreement || !headshot) {
      throw new Error("Expected the seeded demo tasks.");
    }

    await expect(
      api.transitionTask({
        eventId,
        taskId: headshot.id,
        toStatus: "in_progress",
        expectedVersion: headshot.version,
      }),
    ).rejects.toMatchObject({ code: "TASK_DEPENDENCY_INCOMPLETE", status: 409 });

    await api.transitionTask({
      eventId,
      taskId: agreement.id,
      toStatus: "completed",
      expectedVersion: agreement.version,
    });
    const startedHeadshot = await api.transitionTask({
      eventId,
      taskId: headshot.id,
      toStatus: "in_progress",
      expectedVersion: headshot.version,
    });
    await expect(
      api.uploadTaskFile({
        eventId,
        participantId: headshot.participantId,
        taskId: headshot.id,
        kind: "headshot",
        file: new File(["demo image"], "ada.png", { type: "image/png" }),
      }),
    ).resolves.toMatchObject({ id: "demo-asset-demo-task-headshot-headshot" });
    await api.transitionTask({
      eventId,
      taskId: headshot.id,
      toStatus: "submitted",
      expectedVersion: startedHeadshot.version,
      note: "Uploaded ada.png",
    });

    const finalView = await api.getPortal(eventId);
    expect(finalView.outstandingTaskCount).toBe(2);
    expect(finalView.tasks.find((task) => task.id === agreement.id)?.status).toBe("completed");
    expect(finalView.tasks.find((task) => task.id === headshot.id)?.status).toBe("submitted");
  });
});

describe("local speaker portal fallback", () => {
  it("requires the explicit fixture profile without sending portal credentials", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ environment: "local", runtimeProfile: "fixture" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(isLocalApiEnvironment("http://127.0.0.1:8787/", undefined, fetcher)).resolves.toBe(
      true,
    );
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8787/api/health", {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  });

  it("uses the demo only after an eligible API error in the local environment", async () => {
    const unavailable = new PortalApiError(
      "INTEGRATION_UNAVAILABLE",
      "Speaker storage is unavailable.",
      503,
    );
    const api = apiWithPortal(async () => {
      throw unavailable;
    });
    const checkEnvironment = vi.fn(async () => true);

    await expect(
      loadPortalWithLocalDemo({
        api,
        demoApi: createLocalPortalDemoApi(eventId),
        apiBaseUrl: "http://127.0.0.1:8787",
        eventId,
        checkEnvironment,
      }),
    ).resolves.toMatchObject({
      source: "demo",
      view: { profiles: [{ displayName: "Ada Lovelace" }] },
    });
    expect(checkEnvironment).toHaveBeenCalledOnce();
  });

  it("preserves API success and fail-closed production or authorization errors", async () => {
    const success = emptyPortal();
    const checkEnvironment = vi.fn(async () => true);
    await expect(
      loadPortalWithLocalDemo({
        api: apiWithPortal(async () => success),
        demoApi: createLocalPortalDemoApi(eventId),
        apiBaseUrl: "https://api.example.com",
        eventId,
        checkEnvironment,
      }),
    ).resolves.toEqual({ source: "api", view: success });
    expect(checkEnvironment).not.toHaveBeenCalled();

    const unauthorized = new PortalApiError("AUTH_REQUIRED", "Sign in required.", 401);
    expect(isPortalDemoFallbackError(unauthorized)).toBe(false);
    await expect(
      loadPortalWithLocalDemo({
        api: apiWithPortal(async () => {
          throw unauthorized;
        }),
        demoApi: createLocalPortalDemoApi(eventId),
        apiBaseUrl: "http://127.0.0.1:8787",
        eventId,
        checkEnvironment,
      }),
    ).rejects.toBe(unauthorized);
    expect(checkEnvironment).not.toHaveBeenCalled();

    const notFound = new PortalApiError("NOT_FOUND", "Portal not found.", 404);
    await expect(
      loadPortalWithLocalDemo({
        api: apiWithPortal(async () => {
          throw notFound;
        }),
        demoApi: createLocalPortalDemoApi(eventId),
        apiBaseUrl: "https://api.example.com",
        eventId,
        checkEnvironment: async () => false,
      }),
    ).rejects.toBe(notFound);
  });
});
