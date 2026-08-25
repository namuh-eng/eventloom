import { describe, expect, it } from "vitest";
import { createDeliverablesApi, resolveDeliverablesUploadGrantUrl } from "./api";

const restoredSession = {
  id: "session-1",
  eventId: "event-1",
  title: "Restored title",
  description: "Restored abstract",
  status: "confirmed",
  durationMinutes: 30,
  speakerIds: ["participant-1"],
  speakerRoster: [{ id: "participant-1", role: "primary" }],
  version: 4,
};
function storedManifestZip(manifest: unknown): ArrayBuffer {
  const payload = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
  const name = new TextEncoder().encode("manifest.json");
  const localSize = 30 + name.byteLength + payload.byteLength;
  const centralSize = 46 + name.byteLength;
  const body = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(body.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint32(18, payload.byteLength, true);
  view.setUint32(22, payload.byteLength, true);
  view.setUint16(26, name.byteLength, true);
  body.set(name, 30);
  body.set(payload, 30 + name.byteLength);
  const centralOffset = localSize;
  view.setUint32(centralOffset, 0x02014b50, true);
  view.setUint16(centralOffset + 4, 20, true);
  view.setUint16(centralOffset + 6, 20, true);
  view.setUint16(centralOffset + 8, 0x0800, true);
  view.setUint32(centralOffset + 20, payload.byteLength, true);
  view.setUint32(centralOffset + 24, payload.byteLength, true);
  view.setUint16(centralOffset + 28, name.byteLength, true);
  view.setUint32(centralOffset + 42, 0, true);
  body.set(name, centralOffset + 46);
  const endOffset = centralOffset + centralSize;
  view.setUint32(endOffset, 0x06054b50, true);
  view.setUint16(endOffset + 8, 1, true);
  view.setUint16(endOffset + 10, 1, true);
  view.setUint32(endOffset + 12, centralSize, true);
  view.setUint32(endOffset + 16, centralOffset, true);
  return body.buffer;
}

describe("deliverables API", () => {
  it("keeps relative private-upload grants on the browser same origin", () => {
    expect(resolveDeliverablesUploadGrantUrl("/api/private-assets/grant-1", "")).toBe(
      "/api/private-assets/grant-1",
    );
    expect(
      resolveDeliverablesUploadGrantUrl("/api/private-assets/grant-1", "https://eventloom.example"),
    ).toBe("https://eventloom.example/api/private-assets/grant-1");
  });
  it("restores immutable session content through the canonical admin mutation envelope", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const api = createDeliverablesApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return Response.json({ data: restoredSession });
      },
    );

    await expect(
      api.restoreSessionVersion?.({
        sessionId: "session-1",
        version: 2,
        expectedVersion: 3,
      }),
    ).resolves.toEqual(restoredSession);
    expect(requests).toEqual([
      {
        url: "https://api.example.test/api/admin/organizations/org-1/events/event-1/sessions/session-1/restore",
        method: "POST",
        body: { version: 2, expectedVersion: 3 },
      },
    ]);
  });
  it("serializes an explicit non-empty upload asset policy and rejects missing policy", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const api = createDeliverablesApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return Response.json({
          data: {
            id: "task-1",
            eventId: "event-1",
            participantId: "participant-1",
            subject: {
              type: "session",
              sessionId: "session-marcus",
            },
            type: "upload",
            owner: "speaker",
            title: "Upload slides",
            description: "PDF only",
            instructions: "PDF only",
            status: "not_started",
            dueAt: "2026-08-22",
            dependencyIds: [],
            reminderOffsetsMinutes: [],
            allowedMimeTypes: ["application/pdf"],
            maxBytes: 5_000_000,
            acceptedAssetKinds: ["slides", "supporting_file"],
            version: 1,
            updatedAt: "2026-08-12T00:00:00.000Z",
          },
        });
      },
    );

    if (api.createTask === undefined) throw new Error("Expected organizer task adapter.");
    const created = await api.createTask({
      title: "Upload slides",
      description: "PDF only",
      dueAt: "2026-08-22",
      allowedMimeTypes: ["Application/PDF"],
      maxSizeBytes: 5_000_000,
      acceptedAssetKinds: ["slides", "supporting_file"],
      assignments: [
        {
          participantId: "participant-1",
          subject: { type: "session", sessionId: "session-marcus" },
        },
      ],
    });
    expect(created).toMatchObject({
      subject: {
        type: "session",
        sessionId: "session-marcus",
      },
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 5_000_000,
    });

    expect(requests[0]).toEqual({
      url: "https://api.example.test/api/speaker/events/event-1/organizer/tasks",
      method: "POST",
      body: {
        type: "upload",
        title: "Upload slides",
        instructions: "PDF only",
        description: "PDF only",
        dueAt: "2026-08-22",
        allowedMimeTypes: ["application/pdf"],
        maxBytes: 5_000_000,
        acceptedAssetKinds: ["slides", "supporting_file"],
        assignments: [
          {
            participantId: "participant-1",
            subject: { type: "session", sessionId: "session-marcus" },
          },
        ],
      },
    });
    await expect(
      api.createTask({
        title: "Missing policy",
        description: "No asset kind",
        dueAt: "2026-08-22",
        allowedMimeTypes: ["application/pdf"],
        maxSizeBytes: 5_000_000,
        acceptedAssetKinds: [],
        assignments: [{ participantId: "participant-1", subject: { type: "participant" } }],
      }),
    ).rejects.toThrow("accepted asset kind");
    await expect(
      api.createTask({
        title: "Missing assignment",
        description: "No subject",
        dueAt: "2026-08-22",
        allowedMimeTypes: ["application/pdf"],
        maxSizeBytes: 5_000_000,
        acceptedAssetKinds: ["slides"],
        assignments: [{ participantId: "", subject: { type: "participant" } }],
      }),
    ).rejects.toThrow("assignment");
    expect(requests).toHaveLength(1);
  });

  it("retains authoritative asset lineage pointers without exposing private storage fields", async () => {
    const api = createDeliverablesApi("https://api.example.test", "org-1", "event-1", async () =>
      Response.json({
        data: [
          {
            id: "asset-v2",
            eventId: "event-1",
            participantId: "participant-1",
            kind: "slides",
            fileName: "slides.pdf",
            contentType: "application/pdf",
            sizeBytes: 10,
            state: "ready",
            createdAt: "2026-08-12T00:00:00.000Z",
            version: 2,
            versionFamilyId: "family-1",
            versionId: "version-2",
            latestVersionId: "asset-v2",
            currentVersionId: "asset-v2",
            approvedVersionId: "asset-v1",
            releasedVersionId: "asset-v1",
            uploaderLabel: "Local Organizer",
            uploaderAccountId: "organizer-account",
            reviewedBy: "reviewer-account",
            objectKey: "private/object",
            tenantId: "private-tenant",
          },
        ],
      }),
    );
    const assets = await api.listAssets?.();
    expect(assets?.[0]).toMatchObject({
      versionId: "version-2",
      latestVersionId: "asset-v2",
      currentVersionId: "asset-v2",
      approvedVersionId: "asset-v1",
      releasedVersionId: "asset-v1",
      uploaderLabel: "Local Organizer",
      reviewedBy: "reviewer-account",
    });
    expect(assets?.[0]).not.toHaveProperty("uploaderAccountId");
    expect(assets?.[0]).not.toHaveProperty("objectKey");
    expect(assets?.[0]).not.toHaveProperty("tenantId");
  });
  it("exposes synchronous ZIP response and authoritative manifest facts only", async () => {
    const manifest = {
      format: "speaker-deliverables-export",
      version: 1,
      organizationId: "org-1",
      eventId: "event-1",
      entries: [],
    };
    const api = createDeliverablesApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async () =>
        new Response(storedManifestZip(manifest), {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="event-1-deliverables.zip"',
          },
        }),
    );
    const result = await api.exportDeliverables?.({ status: "all" });
    expect(result).toMatchObject({
      fileName: "event-1-deliverables.zip",
      contentType: "application/zip",
      sizeBytes: expect.any(Number),
      manifest,
      response: {
        kind: "synchronous_zip",
        status: 200,
        contentType: "application/zip",
      },
    });
    expect(result).not.toHaveProperty("jobId");
    expect(result).not.toHaveProperty("status");
  });
  it("replaces a headshot through the organizer grant, private upload, finalization, and profile relink", async () => {
    const pendingAsset = {
      id: "asset-headshot-v2",
      eventId: "event-1",
      participantId: "participant-1",
      kind: "headshot",
      fileName: "speaker.png",
      contentType: "image/png",
      sizeBytes: 11,
      state: "pending_upload",
      createdAt: "2026-08-10T00:00:00.000Z",
      version: 2,
      versionFamilyId: "family-headshot",
      supersedesAssetId: "asset-headshot-v1",
    };
    const finalizedAsset = {
      ...pendingAsset,
      state: "ready",
      finalizedAt: "2026-08-10T00:01:00.000Z",
    };
    const profile = {
      id: "profile-1",
      eventId: "event-1",
      participantId: "participant-1",
      displayName: "Priya Raman",
      biography: "Build systems engineer.",
      headshotAssetId: finalizedAsset.id,
      version: 3,
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const api = createDeliverablesApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async (input, init) => {
        calls.push({ url: String(input), init });
        switch (calls.length) {
          case 1:
            return Response.json({
              data: {
                asset: pendingAsset,
                grant: {
                  method: "PUT",
                  url: "https://uploads.example.test/events/event-1/headshots/v2",
                  headers: { "content-type": "image/png" },
                  expiresAt: "2026-08-10T00:05:00.000Z",
                },
              },
            });
          case 2:
            return new Response(null, { status: 204 });
          case 3:
            return Response.json({ data: finalizedAsset });
          default:
            return Response.json({ data: profile });
        }
      },
    );

    if (api.replaceHeadshot === undefined) throw new Error("Expected organizer headshot adapter.");
    const result = await api.replaceHeadshot({
      participantId: "participant-1",
      file: new File(["headshot-v2"], "speaker.png", { type: "image/png" }),
      supersedesAssetId: "asset-headshot-v1",
      expectedLatestVersion: 1,
      idempotencyKey: "headshot-replacement-1",
      expectedVersion: 2,
    });

    expect(result).toEqual({ asset: finalizedAsset, profile });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.test/api/speaker/events/event-1/organizer/profiles/participant-1/headshot",
      "https://uploads.example.test/events/event-1/headshots/v2",
      "https://api.example.test/api/speaker/events/event-1/organizer/assets/asset-headshot-v2/finalize",
      "https://api.example.test/api/speaker/events/event-1/organizer/profiles/participant-1",
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      participantId: "participant-1",
      kind: "headshot",
      fileName: "speaker.png",
      contentType: "image/png",
      sizeBytes: 11,
      supersedesAssetId: "asset-headshot-v1",
      expectedLatestVersion: 1,
    });
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe(
      "headshot-replacement-1",
    );
    expect(calls[1]?.init?.credentials).toBe("omit");
    expect(calls[1]?.init?.body).toBeInstanceOf(File);
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ state: "ready" });
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({
      headshotAssetId: "asset-headshot-v2",
      expectedVersion: 2,
    });
  });

  it("returns authoritative edit and approval responses and preserves optimistic versions", async () => {
    const responses = [
      {
        ...restoredSession,
        title: "Prefixed title",
        description: "Original abstract",
        version: 2,
        updatedBy: "organizer-1",
      },
      {
        ...restoredSession,
        title: "Prefixed title",
        description: "Original abstract with appended detail",
        version: 3,
        updatedBy: "organizer-1",
      },
      {
        ...restoredSession,
        title: "Prefixed title",
        description: "Original abstract with appended detail",
        status: "Accepted",
        contentStatus: "Approved",
        version: 4,
        updatedBy: "organizer-1",
      },
    ];
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const api = createDeliverablesApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return Response.json({ data: responses[requests.length - 1] });
      },
    );

    const first = await api.updateSession({
      sessionId: "session-1",
      expectedVersion: 1,
      title: "Prefixed title",
      description: "Original abstract",
    });
    const second = await api.updateSession({
      sessionId: first.id,
      expectedVersion: first.version,
      title: first.title,
      description: `${first.description} with appended detail`,
    });
    const approved = await api.updateSession({
      sessionId: second.id,
      expectedVersion: second.version,
      contentStatus: "Approved",
    });

    expect(first).toMatchObject({ title: "Prefixed title", version: 2, updatedBy: "organizer-1" });
    expect(second).toMatchObject({
      description: "Original abstract with appended detail",
      version: 3,
    });
    expect(approved).toMatchObject({ contentStatus: "Approved", version: 4 });
    expect(requests.map((request) => request.body)).toEqual([
      {
        expectedVersion: 1,
        title: "Prefixed title",
        description: "Original abstract",
      },
      {
        expectedVersion: 2,
        title: "Prefixed title",
        description: "Original abstract with appended detail",
      },
      { expectedVersion: 3, contentStatus: "Approved" },
    ]);
  });

  it("normalizes authenticated organizer attribution and immutable content snapshots", async () => {
    const requests: string[] = [];
    const api = createDeliverablesApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async (input) => {
        requests.push(String(input));
        return Response.json({
          data: [
            {
              id: "content-history-1",
              action: "updated",
              version: 2,
              actorAccountId: "organizer-1",
              actorLabel: "Jordan Alvarez",
              occurredAt: "2026-08-09T12:00:00.000Z",
              snapshot: {
                title: "Prefixed title",
                abstract: "Original abstract",
              },
            },
          ],
        });
      },
    );

    await expect(api.listSessionContentHistory?.("session-1")).resolves.toEqual([
      {
        id: "content-history-1",
        action: "updated",
        version: 2,
        actorId: "organizer-1",
        actorLabel: "Jordan Alvarez",
        occurredAt: "2026-08-09T12:00:00.000Z",
        title: "Prefixed title",
        description: "Original abstract",
      },
    ]);
    expect(requests).toEqual([
      "https://api.example.test/api/admin/organizations/org-1/events/event-1/sessions/session-1/history",
    ]);
  });

  it("uses the exact organizer matrix query and keeps server status/current asset authoritative", async () => {
    const requests: string[] = [];
    const currentAsset = {
      id: "asset-2",
      eventId: "event-1",
      sessionId: "session-priya",
      participantId: "participant-1",
      taskId: "task-1",
      kind: "slides",
      fileName: "current.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
      state: "ready",
      createdAt: "2026-08-11T12:00:00.000Z",
      version: 2,
      versionFamilyId: "family-1",
      objectKey: "private/object-key",
      tenantId: "private-tenant",
      capabilityToken: "private-capability",
      signedDownloadUrl: "https://private.example.test/file",
    };
    const task = {
      id: "task-1",
      eventId: "event-1",
      participantId: "participant-1",
      subject: {
        type: "session",
        sessionId: "session-priya",
      },
      type: "upload",
      owner: "speaker",
      title: "Upload slides",
      description: "Upload slides",
      instructions: "Upload slides",
      status: "submitted",
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 5_000_000,
      dependencyIds: [],
      reminderOffsetsMinutes: [],
      version: 1,
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
    const api = createDeliverablesApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async (input) => {
        requests.push(String(input));
        return Response.json({
          data: {
            organizationId: "org-1",
            eventId: "event-1",
            total: 1,
            filters: {
              participantId: "participant-1",
              taskId: "task-1",
              status: "incomplete",
              objectKey: "must-not-cross-boundary",
            },
            items: [
              {
                task,
                participantId: "participant-1",
                participantName: "Priya Raman",
                assets: [currentAsset],
                currentAsset,
                status: "needs_changes",
              },
            ],
          },
        });
      },
    );

    const matrix = await api.listDeliverableMatrix?.({
      participantId: "participant-1",
      taskId: "task-1",
      status: "incomplete",
    });

    expect(requests).toEqual([
      "https://api.example.test/api/speaker/events/event-1/organizer/deliverables?participantId=participant-1&taskId=task-1&status=incomplete",
    ]);
    expect(matrix?.filters).toEqual({
      participantId: "participant-1",
      taskId: "task-1",
      status: "incomplete",
    });
    expect(matrix?.items[0]).toMatchObject({
      status: "needs_changes",
      task: { subject: { type: "session", sessionId: "session-priya" } },
      currentAsset: { id: "asset-2", sessionId: "session-priya", version: 2 },
    });
    expect(matrix?.items[0]?.currentAsset).not.toHaveProperty("objectKey");
    expect(matrix?.items[0]?.currentAsset).not.toHaveProperty("tenantId");
    expect(matrix?.items[0]?.currentAsset).not.toHaveProperty("capabilityToken");
    expect(matrix?.items[0]?.currentAsset).not.toHaveProperty("signedDownloadUrl");
  });
  it("surfaces optimistic concurrency conflicts without hiding the server error", async () => {
    const api = createDeliverablesApi("https://api.example.test", "org-1", "event-1", async () =>
      Response.json(
        { error: { code: "CONFLICT", message: "Session version 3 is current." } },
        { status: 409 },
      ),
    );

    await expect(
      api.updateSession({ sessionId: "session-1", expectedVersion: 2, title: "stale" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "Session version 3 is current.",
    });
  });
  it("routes an empty base URL through the same-origin deliverables gateway", async () => {
    let requestedUrl = "";
    let requestInit: RequestInit | undefined;
    const api = createDeliverablesApi("", "org/one", "event/one", async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      return Response.json({ data: { items: [] } });
    });

    await expect(api.listSessions()).resolves.toEqual([]);

    expect(requestedUrl).toBe("/api/admin/organizations/org%2Fone/events/event%2Fone/sessions");
    expect(requestedUrl.startsWith("/api/")).toBe(true);
    expect(requestedUrl).not.toMatch(/^\/\//);
    expect(requestedUrl).not.toMatch(/^https?:\/\//);
    expect(requestInit?.credentials).toBe("include");
  });
  it("accepts self-consistent comments from every authorized immutable family version", async () => {
    const api = createDeliverablesApi("https://api.example.test", "org-1", "event-1", async () =>
      Response.json({
        data: [
          {
            id: "comment-v1",
            eventId: "event-1",
            assetId: "asset-v1",
            versionId: "asset-v1",
            body: "Draft deck - final version coming Friday.",
            authorLabel: "Priya Raman",
            createdAt: "2026-08-25T10:06:00.000Z",
            version: 1,
          },
          {
            id: "comment-v2",
            eventId: "event-1",
            assetId: "asset-v2",
            versionId: "asset-v2",
            body: "Thanks - please confirm the final version by Tuesday.",
            authorLabel: "Organizer",
            createdAt: "2026-08-25T10:07:00.000Z",
            version: 1,
          },
        ],
      }),
    );

    await expect(api.listAssetComments?.("asset-v2")).resolves.toEqual([
      expect.objectContaining({ id: "comment-v1", assetId: "asset-v1" }),
      expect.objectContaining({ id: "comment-v2", assetId: "asset-v2" }),
    ]);
  });
});
