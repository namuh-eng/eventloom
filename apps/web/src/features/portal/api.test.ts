import { describe, expect, it, vi } from "vitest";
import { createPortalApi, PortalApiError } from "./api";
import type { PortalAsset, PortalTask, PortalView } from "./types";

const emptyPortal: PortalView = {
  submissions: [],
  profiles: [],
  tasks: [],
  sessions: [],
  outstandingTaskCount: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function task(): PortalTask {
  return {
    id: "task/one",
    eventId: "event one",
    subject: { type: "session", sessionId: "session-1" },
    participantId: "participant-1",
    type: "form",
    owner: "speaker",
    title: "Confirm details",
    status: "in_progress",
    dependencyIds: [],
    reminderOffsetsMinutes: [],
    version: 2,
    updatedAt: "2026-08-08T12:00:00.000Z",
  };
}

function uploadAuthorizationResponse(url: string): Response {
  return jsonResponse({
    data: {
      asset: { id: "asset-1" },
      grant: {
        method: "PUT",
        url,
        headers: {},
        expiresAt: "2026-08-08T12:05:00.000Z",
      },
    },
  });
}

describe("speaker portal API adapter", () => {
  it("loads the event-scoped portal with authenticated credentials", async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return jsonResponse({ data: emptyPortal });
    };
    const api = createPortalApi("https://api.example.com/", fetcher);

    await expect(api.getPortal("event one")).resolves.toEqual(emptyPortal);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe(
      "https://api.example.com/api/speaker/events/event%20one/portal",
    );
    expect(calls[0]?.init).toMatchObject({ credentials: "include" });
  });

  it("uses the same-origin gateway without a browser API origin", async () => {
    let requestedUrl = "";
    let requestInit: RequestInit | undefined;
    const api = createPortalApi("", async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      return jsonResponse({ data: emptyPortal });
    });

    await expect(api.getPortal("event-1")).resolves.toEqual(emptyPortal);
    expect(requestedUrl).toBe("/api/speaker/events/event-1/portal");
    expect(requestInit).toMatchObject({ credentials: "include" });
  });

  it("sends optimistic profile versions and preserves structured API errors", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return jsonResponse(
        {
          error: {
            code: "VERSION_CONFLICT",
            message: "The speaker profile has changed. Reload it before saving.",
            traceId: "trace-1",
          },
        },
        409,
      );
    };
    const api = createPortalApi("https://api.example.com", fetcher);

    const error = await api
      .updateBiography({
        eventId: "event-1",
        participantId: "participant-1",
        biography: "Updated biography",
        expectedVersion: 4,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PortalApiError);
    expect(error).toMatchObject({ code: "VERSION_CONFLICT", status: 409, traceId: "trace-1" });
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      biography: "Updated biography",
      expectedVersion: 4,
    });
  });

  it("posts task transitions with encoded identifiers", async () => {
    const current = task();
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return jsonResponse({ data: { task: { ...current, status: "submitted", version: 3 } } });
    };
    const api = createPortalApi("https://api.example.com", fetcher);

    await expect(
      api.transitionTask({
        eventId: current.eventId,
        taskId: current.id,
        toStatus: "submitted",
        expectedVersion: current.version,
        note: "Ready for review",
      }),
    ).resolves.toMatchObject({ status: "submitted", version: 3 });
    expect(String(calls[0]?.input)).toContain("/events/event%20one/tasks/task%2Fone/transitions");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      toStatus: "submitted",
      expectedVersion: 2,
      note: "Ready for review",
    });
  });

  it("uses a private upload grant without forwarding portal credentials", async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      if (calls.length === 1) {
        return jsonResponse({
          data: {
            asset: { id: "asset-1" },
            grant: {
              method: "PUT",
              url: "https://uploads.example.com/private/object",
              headers: { "content-type": "application/pdf", "x-upload-token": "signed" },
              expiresAt: "2026-08-08T12:05:00.000Z",
            },
          },
        });
      }
      return new Response(null, { status: 204 });
    };
    const api = createPortalApi("https://api.example.com", fetcher);
    const file = new File(["slides"], "session.pdf", { type: "application/pdf" });

    await expect(
      api.uploadTaskFile({
        eventId: "event-1",
        participantId: "participant-1",
        taskId: "task-1",
        kind: "slides",
        file,
      }),
    ).resolves.toMatchObject({ id: "asset-1" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init).toMatchObject({ credentials: "include", method: "POST" });
    expect(calls[1]).toMatchObject({
      input: "https://uploads.example.com/private/object",
      init: { credentials: "omit", method: "PUT", body: file },
    });
  });
  it("uses canonical session IDs for asset upload bodies and replacement idempotency", async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const api = createPortalApi("https://api.example.com", async (input, init) => {
      calls.push({ input, init });
      return calls.length === 1
        ? uploadAuthorizationResponse("https://uploads.example.com/private/object")
        : new Response(null, { status: 204 });
    });
    const file = new File(["slides"], "session.pdf", { type: "application/pdf" });

    await api.uploadFile?.({
      eventId: "event-1",
      participantId: "participant-1",
      sessionId: "session-1",
      taskId: "task-1",
      kind: "slides",
      file,
      supersedesAssetId: "asset-previous",
      expectedLatestVersion: 2,
    });

    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      participantId: "participant-1",
      sessionId: "session-1",
      taskId: "task-1",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).not.toHaveProperty("submissionId");
    expect(calls[0]?.init?.headers).toMatchObject({
      "idempotency-key": expect.stringContaining("session-1"),
    });
  });

  it("re-authorizes and uploads an existing pending asset without sending mutable metadata", async () => {
    const pending: PortalAsset = {
      id: "asset-pending",
      eventId: "event-1",
      sessionId: "session-1",
      participantId: "participant-1",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 6,
      state: "pending_upload",
      createdAt: "2026-08-08T12:00:00.000Z",
    };
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const api = createPortalApi("https://api.example.com", async (input, init) => {
      calls.push({ input, init });
      return calls.length === 1
        ? jsonResponse({
            data: {
              asset: pending,
              grant: {
                method: "PUT",
                url: "/api/speaker/assets/capabilities/upload/asset-pending/fresh-token",
                headers: { "content-type": "application/pdf" },
                expiresAt: "2026-08-08T12:05:00.000Z",
              },
            },
          })
        : new Response(null, { status: 204 });
    });
    const file = new File(["slides"], "slides.pdf", { type: "application/pdf" });

    await expect(
      api.retryAssetUpload?.({ eventId: "event-1", assetId: pending.id, file }),
    ).resolves.toEqual(pending);
    expect(String(calls[0]?.input)).toBe(
      "https://api.example.com/api/speaker/events/event-1/assets/asset-pending/upload-authorization",
    );
    expect(calls[0]?.init).toMatchObject({ method: "POST", credentials: "include" });
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[1]?.init).toMatchObject({ method: "PUT", credentials: "omit", body: file });
  });

  it("resolves a relative upload grant against window.location.origin", async () => {
    vi.stubGlobal("window", { location: { origin: "https://portal.example.com" } });
    try {
      const calls: string[] = [];
      const api = createPortalApi("", async (input) => {
        calls.push(String(input));
        return calls.length === 1
          ? uploadAuthorizationResponse("/api/uploads/private/object")
          : new Response(null, { status: 204 });
      });

      await expect(
        api.uploadTaskFile({
          eventId: "event-1",
          participantId: "participant-1",
          taskId: "task-1",
          kind: "slides",
          file: new File(["slides"], "session.pdf", { type: "application/pdf" }),
        }),
      ).resolves.toMatchObject({ id: "asset-1" });
      expect(calls).toEqual([
        "/api/speaker/events/event-1/uploads",
        "https://portal.example.com/api/uploads/private/object",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    "http://127.0.0.1:8787/private/object",
    "http://eventloom-eval.localhost:3015/private/object",
  ])("allows the local HTTP upload grant %s", async (grantUrl) => {
    const calls: string[] = [];
    const api = createPortalApi("https://api.example.com", async (input) => {
      calls.push(String(input));
      return calls.length === 1
        ? uploadAuthorizationResponse(grantUrl)
        : new Response(null, { status: 204 });
    });

    await expect(
      api.uploadTaskFile({
        eventId: "event-1",
        participantId: "participant-1",
        taskId: "task-1",
        kind: "slides",
        file: new File(["slides"], "session.pdf", { type: "application/pdf" }),
      }),
    ).resolves.toMatchObject({ id: "asset-1" });
    expect(calls[1]).toBe(grantUrl);
  });

  it.each(["javascript:alert('upload')", "ftp://uploads.example.com/private/object"])(
    "rejects the unsafe upload grant URL %s",
    async (grantUrl) => {
      let callCount = 0;
      const api = createPortalApi("https://api.example.com", async () => {
        callCount += 1;
        return uploadAuthorizationResponse(grantUrl);
      });

      await expect(
        api.uploadTaskFile({
          eventId: "event-1",
          participantId: "participant-1",
          taskId: "task-1",
          kind: "slides",
          file: new File(["slides"], "session.pdf", { type: "application/pdf" }),
        }),
      ).rejects.toThrow("The upload grant URL must use HTTPS.");
      expect(callCount).toBe(1);
    },
  );

  it("uses relative upload capabilities through the same-origin gateway", async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const capabilityUrl = "/api/speaker/assets/capabilities/upload/capability-1/token-1";
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return calls.length === 1
        ? uploadAuthorizationResponse(capabilityUrl)
        : new Response(null, { status: 204 });
    };
    const api = createPortalApi("", fetcher);

    await expect(
      api.uploadTaskFile({
        eventId: "event-1",
        participantId: "participant-1",
        taskId: "task-1",
        kind: "slides",
        file: new File(["slides"], "session.pdf", { type: "application/pdf" }),
      }),
    ).resolves.toMatchObject({ id: "asset-1" });

    expect(calls.map(({ input }) => String(input))).toEqual([
      "/api/speaker/events/event-1/uploads",
      capabilityUrl,
    ]);
    expect(calls[1]?.init).toMatchObject({ credentials: "omit", method: "PUT" });
  });
  it("reports failed object storage uploads without submitting the task", async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount += 1;
      return callCount === 1
        ? jsonResponse({
            data: {
              asset: { id: "asset-1" },
              grant: {
                method: "PUT",
                url: "https://uploads.example.com/private/object",
                headers: {},
                expiresAt: "2026-08-08T12:05:00.000Z",
              },
            },
          })
        : new Response(null, { status: 503 });
    };
    const api = createPortalApi("https://api.example.com", fetcher);

    await expect(
      api.uploadTaskFile({
        eventId: "event-1",
        participantId: "participant-1",
        taskId: "task-1",
        kind: "slides",
        file: new File(["slides"], "session.pdf", { type: "application/pdf" }),
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_FAILED", status: 503 });
    expect(callCount).toBe(2);
  });
});
