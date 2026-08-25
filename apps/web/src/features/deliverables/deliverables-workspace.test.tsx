import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createNavigationDataCache } from "@/lib/navigation-data-cache";
import {
  createDeliverablesApi,
  type DeliverableAsset,
  type DeliverableExportDownload,
  type DeliverableMatrixItem,
  type DeliverableSession,
  type DeliverableSpeakerProfile,
  type DeliverablesApi,
  type DeliverableTask,
  type DeliverableTaskMatrix,
  deliverableAssetKinds,
} from "./api";
import {
  ContentRequestInspector,
  DeliverablesWorkspaceView,
  ReminderPreview,
} from "./deliverables-workspace";
import {
  authorizeContentCollectionNavigationSnapshot,
  contentRequestMetrics,
  type DeliverableRow,
  deliverablesCoreCacheInvalidationTags,
  deliverablesCoreCacheKey,
  deliverablesCoreCacheTags,
  deliverablesExportActionLabels,
  deliverablesExportStatusLabels,
  deliverablesSessionHistoryKey,
  eligibleSpeakerHeadshotSessions,
  filterContentRequestRows,
  isDeliverablesWorkspaceScopeCurrent,
  loadDeliverablesCoreSnapshot,
  loadDeliverablesSessionHistory,
  resolveSpeakerHeadshotSubmissionId,
  settleDeliverablesAssetDetailRequests,
  startDeliverablesCoreRequests,
  triggerDeliverablesDownload,
} from "./deliverables-workspace-model";
import { projectFileFamilies } from "./file-family-model";
import { FileReviewDrawerBody } from "./file-review-drawer";

const deliverablesWorkspaceSource = readFileSync(
  fileURLToPath(new URL("./deliverables-workspace.tsx", import.meta.url)),
  "utf8",
);
const fileLibrarySource = readFileSync(
  fileURLToPath(new URL("./file-library.tsx", import.meta.url)),
  "utf8",
);
describe("deliverables workspace navigation", () => {
  it("uses client navigation for authenticated workspace destinations", () => {
    expect(deliverablesWorkspaceSource).toContain('import Link from "next/link";');
    expect(deliverablesWorkspaceSource).toContain("<Link href={href}>Open Sessions</Link>");
    expect(deliverablesWorkspaceSource).toContain("<Link href={href}>Open Speakers</Link>");
    expect(deliverablesWorkspaceSource).toContain("<Link href={deliverablesHref}");
    expect(deliverablesWorkspaceSource).toContain("<Link href={filesHref}");
    expect(deliverablesWorkspaceSource).not.toContain("<a href={deliverablesHref}");
    expect(deliverablesWorkspaceSource).not.toContain("<a href={filesHref}");
    expect(fileLibrarySource).toContain('import Link from "next/link";');
    expect(fileLibrarySource).toContain("<Link");
    expect(fileLibrarySource).toContain("Create a content request");
  });
  it("hydrates the core bundle from RAM and retries as a fresh read", () => {
    expect(deliverablesWorkspaceSource).toContain("useNavigationDataCache");
    expect(deliverablesWorkspaceSource).toContain("navigationDataCache?.peek");
    expect(deliverablesWorkspaceSource).toContain("navigationDataCache.read<DeliverablesSnapshot>");
    expect(deliverablesWorkspaceSource).toContain("fresh");
    expect(deliverablesWorkspaceSource).toContain("onRetry={() => void load(undefined, true)}");
    expect(deliverablesWorkspaceSource).toContain(
      "load: () => loadDeliverablesCoreSnapshot(api, mode),",
    );
    expect(deliverablesWorkspaceSource).toContain("invalidateDeliverablesCoreCache(scope)");
    expect(deliverablesWorkspaceSource).toContain("getDownloadGrant");
    expect(deliverablesWorkspaceSource).toContain("listAssetComments");
  });
});

function storedManifestZip(manifest: unknown): Uint8Array {
  const payload = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
  const name = new TextEncoder().encode("manifest.json");
  const localSize = 30 + name.byteLength + payload.byteLength;
  const centralSize = 46 + name.byteLength;
  const body = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(body.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
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
  return body;
}
const session: DeliverableSession = {
  id: "session-1",
  eventId: "event-1",
  title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
  description: "A practical talk about reliable build pipelines.",
  status: "Accepted",
  durationMinutes: 40,
  speakerIds: ["speaker-1"],
  speakerRoster: [{ id: "speaker-1", role: "primary" }],
  version: 3,
  contentStatus: "Needs changes",
  updatedAt: "2026-08-09T12:00:00.000Z",
  history: [
    {
      id: "history-1",
      action: "updated",
      version: 2,
      actorId: "Jordan Alvarez",
      occurredAt: "2026-08-08T12:00:00.000Z",
    },
    {
      id: "history-2",
      action: "updated",
      version: 3,
      actorId: "Jordan Alvarez",
      occurredAt: "2026-08-09T12:00:00.000Z",
    },
  ],
};

const profile: DeliverableSpeakerProfile = {
  id: "profile-1",
  eventId: "event-1",
  participantId: "speaker-1",
  displayName: "Priya Raman",
  biography: "Build systems engineer.",
  jobTitle: "Principal Build Engineer",
  company: "Monorepo Labs",
  status: "confirmed",
  email: "priya@example.test",
  socialLinks: { linkedin: "https://example.test/priya" },
  travelLogistics: {
    travelRequired: true,
    arrivalAt: "2027-05-01T10:00:00.000Z",
    departureAt: "2027-05-04T16:00:00.000Z",
  },
  headshotAssetId: "asset-headshot",
  version: 2,
  updatedAt: "2026-08-09T12:00:00.000Z",
};

const task: DeliverableTask = {
  id: "task-1",
  eventId: "event-1",
  participantId: "speaker-1",
  sessionTitle: session.title,
  subject: {
    type: "session",
    sessionId: session.id,
  },
  type: "upload",
  owner: "speaker",
  title: "Upload Session Presentation",
  description: "Final slide deck as a PDF, 16:9 aspect ratio.",
  status: "submitted",
  dueAt: "2027-05-01",
  dependencyIds: [],
  reminderOffsetsMinutes: [10080, 1440],
  acceptedAssetKinds: ["slides"],
  allowedMimeTypes: ["application/pdf"],
  maxBytes: 5_000_000,
  version: 2,
  updatedAt: "2026-08-09T12:00:00.000Z",
};

const assetV1: DeliverableAsset = {
  id: "asset-1",
  eventId: "event-1",
  sessionId: "session-priya",
  participantId: "speaker-1",
  taskId: "task-1",
  kind: "slides",
  fileName: "slides.pdf",
  contentType: "application/pdf",
  sizeBytes: 1024,
  state: "ready",
  createdAt: "2026-08-08T12:00:00.000Z",
  version: 1,
  versionFamilyId: "family-1",
  versionId: "asset-1",
  latestVersionId: "asset-2",
  currentVersionId: "asset-1",
};

const assetV2: DeliverableAsset = {
  ...assetV1,
  id: "asset-2",
  createdAt: "2026-08-09T12:00:00.000Z",
  version: 2,
  supersedesAssetId: "asset-1",
  versionId: "asset-2",
  latestVersionId: "asset-2",
  currentVersionId: "asset-1",
};

const matrixItem: DeliverableMatrixItem = {
  task,
  participantId: "speaker-1",
  participantName: "Priya Raman",
  assets: [assetV1, assetV2],
  currentAsset: assetV1,
  status: "overdue",
};
describe("organizer headshot session scope", () => {
  it("automatically uses the sole accepted session owned by the speaker", () => {
    const sessions = [
      session,
      { ...session, id: "declined", status: "Declined" },
      { ...session, id: "other-event", eventId: "event-2" },
      { ...session, id: "other-speaker", speakerIds: ["speaker-2"] },
    ];
    expect(eligibleSpeakerHeadshotSessions(sessions, "event-1", "speaker-1")).toEqual([session]);
    expect(resolveSpeakerHeadshotSubmissionId(sessions, "event-1", "speaker-1", null)).toBe(
      "session-1",
    );
  });

  it("requires an explicit accepted submission and rejects cross-event choices", () => {
    const sessions = [
      session,
      { ...session, id: "session-2", title: "Second accepted session" },
      { ...session, id: "other-event", eventId: "event-2" },
    ];
    expect(resolveSpeakerHeadshotSubmissionId(sessions, "event-1", "speaker-1", null)).toBeNull();
    expect(resolveSpeakerHeadshotSubmissionId(sessions, "event-1", "speaker-1", "session-2")).toBe(
      "session-2",
    );
    expect(
      resolveSpeakerHeadshotSubmissionId(sessions, "event-1", "speaker-1", "other-event"),
    ).toBeNull();
  });
});

describe("deliverables API adapter", () => {
  it("uses organization/event-qualified session and organizer asset routes", async () => {
    const calls: Array<{
      input: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.endsWith("/sessions"))
        return new Response(
          JSON.stringify({
            data: { items: [session], total: 1, limit: 50, offset: 0 },
          }),
          { status: 200 },
        );
      if (url.endsWith("/tasks"))
        return new Response(JSON.stringify({ data: [task] }), { status: 200 });
      if (url.includes("/assets?") || url.endsWith("/assets"))
        return new Response(
          JSON.stringify({
            data: [
              {
                ...assetV2,
                objectKey: "must-not-cross-boundary",
                tenantId: "tenant-secret",
              },
            ],
          }),
          { status: 200 },
        );
      if (url.endsWith("/download"))
        return new Response(
          JSON.stringify({
            data: {
              url: "https://private.example/download",
              expiresAt: "2026-08-09T12:02:00.000Z",
            },
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const api = createDeliverablesApi("https://api.example.test/", "org/1", "event/1", fetcher);
    await expect(api.listSessions()).resolves.toEqual([session]);
    await expect(api.listTasks?.()).resolves.toEqual([task]);
    const assets = await api.listAssets?.({ participantId: "speaker/1" });
    expect(assets?.[0]).not.toHaveProperty("objectKey");
    expect(assets?.[0]).not.toHaveProperty("tenantId");
    await api.getDownloadGrant?.("asset/2");
    expect(String(calls[0]?.input)).toBe(
      "https://api.example.test/api/admin/organizations/org%2F1/events/event%2F1/sessions",
    );
    expect(String(calls[1]?.input)).toContain("/api/speaker/events/event%2F1/organizer/tasks");
    expect(String(calls[2]?.input)).toContain(
      "/api/speaker/events/event%2F1/organizer/assets?participantId=speaker%2F1",
    );
    expect(String(calls[3]?.input)).toContain(
      "/api/speaker/events/event%2F1/organizer/assets/asset%2F2/download",
    );
    expect(calls.every((call) => call.init?.credentials === "include")).toBe(true);
  });
  it("provisions organizer task, reminder, and asset-review capabilities", async () => {
    const calls: Array<{
      input: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.endsWith("/organizer/tasks")) {
        return Response.json({ data: task }, { status: 201 });
      }
      if (url.endsWith("/organizer/reminders/queue")) {
        return Response.json({
          data: { sentCount: 1, recipientIds: ["speaker-1"] },
        });
      }
      if (url.endsWith("/organizer/assets/asset-2/review")) {
        return Response.json({ data: { ...assetV2, state: "approved" } });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const api = createDeliverablesApi("https://api.example.test", "org-1", "event-1", fetcher);

    await expect(
      api.createTask?.({
        title: "Upload slides",
        description: "PDF only",
        dueAt: "2027-05-01",
        allowedMimeTypes: ["application/pdf"],
        maxSizeBytes: 5_000_000,
        assignments: [
          {
            participantId: "speaker-1",
            subject: { type: "session", sessionId: "session-priya" },
          },
        ],
        acceptedAssetKinds: ["slides"],
      }),
    ).resolves.toMatchObject({ id: task.id });
    await expect(
      api.sendBulkReminder?.({
        taskIds: ["task-1"],
        recipientIds: ["speaker-1"],
      }),
    ).resolves.toEqual({ sentCount: 1, recipientIds: ["speaker-1"] });
    await expect(
      api.reviewAsset?.({
        assetId: "asset-2",
        state: "approved",
        note: "Ready",
        expectedVersion: 0,
        release: false,
      }),
    ).resolves.toMatchObject({ id: "asset-2", state: "approved" });

    expect(String(calls[0]?.input)).toContain("/api/speaker/events/event-1/organizer/tasks");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      type: "upload",
      title: "Upload slides",
      instructions: "PDF only",
      description: "PDF only",
      dueAt: "2027-05-01",
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 5_000_000,
      acceptedAssetKinds: ["slides"],
      assignments: [
        {
          participantId: "speaker-1",
          subject: { type: "session", sessionId: "session-priya" },
        },
      ],
    });
    expect(String(calls[1]?.input)).toContain("/organizer/reminders/queue");
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      taskIds: ["task-1"],
      recipientIds: ["speaker-1"],
      idempotencyKey: expect.any(String),
    });
    expect(String(calls[2]?.input)).toContain("/organizer/assets/asset-2/review");
  });
  it("posts an exact event-scoped export selection and validates the binary ZIP response", async () => {
    const calls: Array<{
      input: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    const bytes = storedManifestZip({
      format: "speaker-deliverables-export",
      version: 1,
      organizationId: "org-1",
      eventId: "event-1",
      entries: [],
    });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(bytes.buffer as ArrayBuffer, {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-length": String(bytes.byteLength),
          "content-disposition":
            "attachment; filename=\"event-1-deliverables.zip\"; filename*=UTF-8''event-1-deliverables.zip",
        },
      });
    };
    const api = createDeliverablesApi("https://api.example.test", "org-1", "event-1", fetcher);
    const download = await api.exportDeliverables?.({
      assetIds: ["asset-2"],
      taskIds: ["task-1"],
      participantIds: ["speaker-1"],
      status: "uploaded",
    });
    expect(String(calls[0]?.input)).toBe(
      "https://api.example.test/api/speaker/events/event-1/organizer/deliverables/export",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      assetIds: ["asset-2"],
      taskIds: ["task-1"],
      participantIds: ["speaker-1"],
      status: "uploaded",
    });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("accept")).toBe("application/zip");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(download?.contentType).toBe("application/zip");
    expect(download?.fileName).toBe("event-1-deliverables.zip");
    expect(download?.sizeBytes).toBe(bytes.byteLength);
    expect([...new Uint8Array(download?.body ?? new ArrayBuffer(0))]).toEqual([...bytes]);
  });

  it("surfaces export errors and rejects unsafe binary headers", async () => {
    const errorApi = createDeliverablesApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "FORBIDDEN",
              message: "Organizer access is required.",
            },
          }),
          { status: 403 },
        ),
    );
    await expect(errorApi.exportDeliverables?.({ taskIds: ["task-1"] })).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });

    const invalidApi = createDeliverablesApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="bad.zip"',
          },
        }),
    );
    await expect(invalidApi.exportDeliverables?.({ taskIds: ["task-1"] })).rejects.toThrow(
      "ZIP archive",
    );
  });

  it("rejects missing organization or event scope rather than guessing a route", () => {
    expect(() => createDeliverablesApi("https://api.example.test", " ", "event-1")).toThrow(
      "organization ID is required",
    );
    expect(() => createDeliverablesApi("https://api.example.test", "org-1", " ")).toThrow(
      "event ID is required",
    );
  });
  it("uses speaker history and restore routes with normalized organizer content", async () => {
    const calls: Array<{
      readonly input: RequestInfo | URL;
      readonly init: RequestInit | undefined;
    }> = [];
    const historyEntry = {
      id: "speaker-history-1",
      action: "updated",
      version: 1,
      actorAccountId: "organizer-1",
      actorLabel: "Jordan Alvarez",
      occurredAt: "2026-08-08T12:00:00.000Z",
      snapshot: {
        biography: "Earlier biography.",
        socialLinks: { linkedin: "https://example.test/jordan" },
        headshotAssetId: "headshot-v1",
      },
    };
    const restored = {
      id: "speaker-content-1",
      eventId: "event-1",
      entityType: "speaker",
      entityId: "speaker-1",
      biography: "Earlier biography.",
      socialLinks: { linkedin: "https://example.test/jordan" },
      headshotAssetId: "headshot-v1",
      version: 3,
      updatedAt: "2026-08-10T12:00:00.000Z",
      updatedBy: "organizer-1",
    };
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input).endsWith("/history")) return Response.json({ data: [historyEntry] });
      if (String(input).endsWith("/restore"))
        return Response.json({ data: restored }, { status: 200 });
      throw new Error(`Unexpected request ${String(input)}`);
    };
    const api = createDeliverablesApi("https://api.example.test", "org-1", "event-1", fetcher);

    await expect(api.listSpeakerContentHistory?.("speaker/1")).resolves.toEqual([
      {
        id: "speaker-history-1",
        action: "updated",
        version: 1,
        actorId: "organizer-1",
        actorLabel: "Jordan Alvarez",
        occurredAt: "2026-08-08T12:00:00.000Z",
        snapshot: {
          biography: "Earlier biography.",
          socialLinks: { linkedin: "https://example.test/jordan" },
          headshotAssetId: "headshot-v1",
        },
      },
    ]);
    await expect(
      api.restoreSpeakerContentVersion?.({
        participantId: "speaker/1",
        version: 1,
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({
      entityType: "speaker",
      entityId: "speaker-1",
      biography: "Earlier biography.",
      version: 3,
    });
    expect(String(calls[0]?.input)).toBe(
      "https://api.example.test/api/speaker/events/event-1/organizer/content/speaker/speaker%2F1/history",
    );
    expect(String(calls[1]?.input)).toBe(
      "https://api.example.test/api/speaker/events/event-1/organizer/content/speaker/speaker%2F1/restore",
    );
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      version: 1,
      expectedVersion: 2,
    });
  });
});
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("deliverables core request starter", () => {
  it("revalidates cached snapshots through the privileged deliverables endpoint", async () => {
    const listDeliverableMatrix = vi.fn().mockResolvedValue({
      organizationId: "org-1",
      eventId: "event-1",
      total: 0,
      filters: {},
      items: [],
    });
    const cachedSnapshot = {
      sessions: [session],
      tasks: [task],
      assets: [],
      profiles: [],
    };

    await expect(
      authorizeContentCollectionNavigationSnapshot({ listDeliverableMatrix }, cachedSnapshot),
    ).resolves.toBe(cachedSnapshot);
    expect(listDeliverableMatrix).toHaveBeenCalledOnce();
  });

  it("rejects cached snapshots when the authorization probe fails", async () => {
    const authorizationError = new Error("Organizer access was revoked.");
    const listDeliverableMatrix = vi.fn().mockRejectedValue(authorizationError);

    await expect(
      authorizeContentCollectionNavigationSnapshot(
        { listDeliverableMatrix },
        {
          sessions: [session],
          tasks: [task],
          assets: [],
          profiles: [],
        },
      ),
    ).rejects.toBe(authorizationError);
  });

  it("falls back to a full load when the privileged authorization endpoint is unavailable", async () => {
    await expect(
      authorizeContentCollectionNavigationSnapshot(
        {},
        {
          sessions: [session],
          tasks: [task],
          assets: [],
          profiles: [],
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("starts the sessions and matrix requests before either deferred response settles", async () => {
    const signal = new AbortController().signal;
    const calls: string[] = [];
    const sessions = deferred<readonly DeliverableSession[]>();
    const matrix = deferred<DeliverableTaskMatrix>();
    const matrixValue: DeliverableTaskMatrix = {
      organizationId: "org-1",
      eventId: "event-1",
      total: 0,
      filters: {},
      items: [],
    };
    const api = {
      listSessions: vi.fn((receivedSignal?: AbortSignal) => {
        calls.push("sessions");
        expect(receivedSignal).toBe(signal);
        return sessions.promise;
      }),
      listDeliverableMatrix: vi.fn((options?: { readonly signal?: AbortSignal }) => {
        calls.push("matrix");
        expect(options?.signal).toBe(signal);
        return matrix.promise;
      }),
      listTasks: vi.fn(() => {
        calls.push("tasks");
        throw new Error("Task projection should not be requested.");
      }),
      listAssets: vi.fn(() => {
        calls.push("assets");
        throw new Error("Asset projection should not be requested.");
      }),
      listProfiles: vi.fn(() => {
        calls.push("profiles");
        throw new Error("Profile projection should not be requested.");
      }),
    } as unknown as DeliverablesApi;

    const requests = startDeliverablesCoreRequests(api, "deliverables", signal);

    expect(calls).toEqual(["sessions", "matrix"]);
    expect(requests.tasks).toBeUndefined();
    expect(requests.assets).toBeUndefined();
    expect(requests.profiles).toBeUndefined();
    sessions.resolve([session]);
    matrix.resolve(matrixValue);
    await Promise.all([requests.sessions, requests.matrix ?? Promise.resolve(matrixValue)]);
  });
  it("keeps files mode loading its complete asset and profile projections", async () => {
    const calls: string[] = [];
    const matrixValue: DeliverableTaskMatrix = {
      organizationId: "org-1",
      eventId: "event-1",
      total: 0,
      filters: {},
      items: [],
    };
    const api = {
      listSessions: vi.fn(() => {
        calls.push("sessions");
        return Promise.resolve<readonly DeliverableSession[]>([]);
      }),
      listDeliverableMatrix: vi.fn(() => {
        calls.push("matrix");
        return Promise.resolve(matrixValue);
      }),
      listAssets: vi.fn(() => {
        calls.push("assets");
        return Promise.resolve<readonly DeliverableAsset[]>([]);
      }),
      listProfiles: vi.fn(() => {
        calls.push("profiles");
        return Promise.resolve<readonly DeliverableSpeakerProfile[]>([]);
      }),
    } as unknown as DeliverablesApi;

    const requests = startDeliverablesCoreRequests(api, "files");

    expect(calls).toEqual(["sessions", "matrix", "assets", "profiles"]);
    await Promise.all([
      requests.sessions,
      requests.matrix ?? Promise.resolve(matrixValue),
      requests.assets ?? Promise.resolve([]),
      requests.profiles ?? Promise.resolve([]),
    ]);
  });

  it("starts explicit projection fallback requests when the matrix capability is missing", () => {
    const calls: string[] = [];
    const api = {
      listSessions: vi.fn(() => {
        calls.push("sessions");
        return Promise.resolve<readonly DeliverableSession[]>([]);
      }),
      listTasks: vi.fn(() => {
        calls.push("tasks");
        return Promise.resolve<readonly DeliverableTask[]>([]);
      }),
      listAssets: vi.fn(() => {
        calls.push("assets");
        return Promise.resolve<readonly DeliverableAsset[]>([]);
      }),
      listProfiles: vi.fn(() => {
        calls.push("profiles");
        return Promise.resolve<readonly DeliverableSpeakerProfile[]>([]);
      }),
    } as unknown as DeliverablesApi;

    const requests = startDeliverablesCoreRequests(api, "deliverables");

    expect(calls).toEqual(["sessions", "tasks", "assets", "profiles"]);
    expect(requests.matrix).toBeUndefined();
  });
  it("keeps an authoritative matrix failure observable", async () => {
    const matrixFailure = new Error("Matrix service unavailable.");
    const api = {
      listSessions: vi.fn(() => Promise.resolve<readonly DeliverableSession[]>([])),
      listDeliverableMatrix: vi.fn().mockRejectedValue(matrixFailure),
    } as unknown as DeliverablesApi;

    const requests = startDeliverablesCoreRequests(api, "deliverables");

    await expect(requests.matrix).rejects.toBe(matrixFailure);
  });

  it("keeps a sessions HTTP 500 as a failed request rather than empty success data", async () => {
    const api = createDeliverablesApi("https://api.example.test", "org-1", "event-1", async () =>
      Response.json(
        {
          error: {
            code: "SESSIONS_REQUEST_FAILED",
            message: "The sessions service failed.",
          },
        },
        { status: 500 },
      ),
    );

    await expect(api.listSessions()).rejects.toMatchObject({
      code: "SESSIONS_REQUEST_FAILED",
      status: 500,
      message: "The sessions service failed.",
    });
  });
  it("does not eagerly start any dedicated session-history request", async () => {
    const listSessionContentHistory = vi.fn();
    const api = {
      listSessions: vi.fn().mockResolvedValue([session]),
      listSessionContentHistory,
    } as unknown as DeliverablesApi;

    const requests = startDeliverablesCoreRequests(api, "deliverables");
    await requests.sessions;

    expect(listSessionContentHistory).not.toHaveBeenCalled();
  });

  it("loads selected history once per session version and serves a cache hit", async () => {
    const first =
      deferred<
        readonly {
          readonly id: string;
          readonly version: number;
          readonly actorId: string;
          readonly occurredAt: string;
        }[]
      >();
    const second =
      deferred<
        readonly {
          readonly id: string;
          readonly version: number;
          readonly actorId: string;
          readonly occurredAt: string;
        }[]
      >();
    const listSessionContentHistory = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const api = { listSessionContentHistory } as unknown as DeliverablesApi;
    const cache = new Map();
    const missing = { ...session };
    const firstRequest = loadDeliverablesSessionHistory(api, missing, cache);
    const duplicateRequest = loadDeliverablesSessionHistory(api, missing, cache);

    expect(deliverablesSessionHistoryKey(session.id, session.version)).toContain(session.id);
    expect(duplicateRequest).toBe(firstRequest);
    expect(listSessionContentHistory).toHaveBeenCalledTimes(1);

    const firstHistory = [
      {
        id: "content-history-3",
        version: session.version,
        actorId: "organizer-1",
        occurredAt: "2026-08-09T12:00:00.000Z",
      },
    ] as const;
    first.resolve(firstHistory);
    await expect(firstRequest).resolves.toEqual(firstHistory);
    await expect(loadDeliverablesSessionHistory(api, missing, cache)).resolves.toEqual(
      firstHistory,
    );
    expect(listSessionContentHistory).toHaveBeenCalledTimes(1);

    const nextVersion = { ...missing, version: session.version + 1 };
    const nextRequest = loadDeliverablesSessionHistory(api, nextVersion, cache);
    expect(listSessionContentHistory).toHaveBeenCalledTimes(2);
    second.resolve([
      {
        id: "content-history-4",
        version: nextVersion.version,
        actorId: "organizer-1",
        occurredAt: "2026-08-10T12:00:00.000Z",
      },
    ]);
    await nextRequest;
    await expect(
      loadDeliverablesSessionHistory(api, { ...nextVersion, contentHistory: [] }, cache),
    ).resolves.toEqual([]);
  });

  it("does not request canonical content history and rejects old workspace scope results", async () => {
    const listSessionContentHistory = vi.fn();
    const api = { listSessionContentHistory } as unknown as DeliverablesApi;
    const cache = new Map();
    await expect(
      loadDeliverablesSessionHistory(api, { ...session, contentHistory: [] }, cache),
    ).resolves.toEqual([]);
    expect(listSessionContentHistory).not.toHaveBeenCalled();

    const nextApi = {} as DeliverablesApi;
    const current = {
      api,
      eventId: "event-1",
      organizationId: "org-1",
      epoch: 2,
    };
    expect(isDeliverablesWorkspaceScopeCurrent(current, current)).toBe(true);
    expect(
      isDeliverablesWorkspaceScopeCurrent(current, {
        ...current,
        api: nextApi,
        epoch: 3,
      }),
    ).toBe(false);
  });

  it("renders matrix-derived rows, versions, and participant labels without projection props", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [session],
        tasks: [],
        assets: [],
        profiles: [],
        matrixItems: [matrixItem],
        selectedAssetId: assetV1.id,
        onInspectAsset: () => undefined,
      }),
    );

    expect(markup).toContain("Priya Raman");
    expect(markup).toContain(session.title);
    expect(markup).toContain(task.title);
    expect(markup).toContain("2 versions");
    expect(markup).toContain("slides.pdf");
    expect(markup).toContain("Current");
  });
  it("derives request metrics, filters assignments, and inspects the no-upload state", () => {
    const row: DeliverableRow = {
      task,
      session,
      sessionLabel: session.title,
      speaker: profile,
      speakerLabel: profile.displayName,
      assets: [assetV1],
      currentAsset: assetV1,
      status: "overdue",
    };
    const waitingRow: DeliverableRow = {
      task: {
        ...task,
        id: "task-2",
        title: "Upload headshot",
        status: "not_started",
        subject: { type: "participant" },
      },
      session: undefined,
      sessionLabel: "Participant profile",
      speaker: profile,
      speakerLabel: profile.displayName,
      assets: [],
      currentAsset: undefined,
      status: "not_started",
    };

    expect(contentRequestMetrics([row, waitingRow])).toEqual({
      all: 2,
      outstanding: 2,
      attention: 1,
      review: 0,
      complete: 0,
    });
    expect(
      filterContentRequestRows([row, waitingRow], {
        query: "headshot",
        speakerId: "all",
        sessionId: "all",
        taskId: "all",
        status: "outstanding",
      }).map((candidate) => candidate.task.id),
    ).toEqual(["task-2"]);
    expect(
      filterContentRequestRows([row, waitingRow], {
        query: "",
        speakerId: "all",
        sessionId: session.id,
        taskId: "all",
        status: "all",
      }).map((candidate) => candidate.task.id),
    ).toEqual(["task-1"]);

    const markup = renderToStaticMarkup(
      createElement(ContentRequestInspector, { row: waitingRow }),
    );
    expect(markup).toContain("Waiting for upload");
    expect(markup).toContain("The speaker has not submitted a current file for this assignment.");
    expect(markup).toContain("PDF");
    expect(markup).not.toContain("application/pdf");
    expect(markup).toContain("Maximum 5 MB");
  });

  it("retains a successful asset-detail sibling when the other request fails", async () => {
    const settled = await settleDeliverablesAssetDetailRequests(
      Promise.resolve([assetV2]),
      Promise.reject(new Error("Comments service unavailable.")),
    );

    expect(settled.history).toEqual({ ok: true, value: [assetV2] });
    expect(settled.comments.ok).toBe(false);
    if (!settled.comments.ok) {
      expect(settled.comments.reason).toEqual(new Error("Comments service unavailable."));
    }
  });
});

describe("deliverables core navigation cache", () => {
  it("normalizes canonical scope keys and keeps modes and events isolated", () => {
    expect(deliverablesCoreCacheKey(" org-1 ", " event-1 ", "files")).toBe(
      "organization:org-1:event:event-1:deliverables:files:core",
    );
    expect(deliverablesCoreCacheKey("org-1", "event-1", "files")).not.toBe(
      deliverablesCoreCacheKey("org-1", "event-1", "deliverables"),
    );
    expect(deliverablesCoreCacheKey("org-1", "event-1", "files")).not.toBe(
      deliverablesCoreCacheKey("org-1", "event-2", "files"),
    );
    expect(deliverablesCoreCacheTags("org-1", "event-1", "files")).toEqual([
      "organization:org-1",
      "event:event-1",
      "deliverables:event-1",
      "deliverables:event-1:files",
    ]);
    expect(deliverablesCoreCacheInvalidationTags("org-1", "event-1")).toEqual([
      "organization:org-1",
      "event:event-1",
      "deliverables:event-1",
    ]);
  });

  it("coalesces complete core reads, hydrates hits without another read, and refreshes explicitly", async () => {
    const matrix: DeliverableTaskMatrix = {
      organizationId: "org-1",
      eventId: "event-1",
      total: 1,
      filters: {},
      items: [matrixItem],
    };
    const api = {
      listSessions: vi.fn().mockResolvedValue([session]),
      listDeliverableMatrix: vi.fn().mockResolvedValue(matrix),
      listAssets: vi.fn().mockResolvedValue([assetV2]),
      listProfiles: vi.fn().mockResolvedValue([profile]),
    } as unknown as DeliverablesApi;
    const cache = createNavigationDataCache();
    const key = deliverablesCoreCacheKey("org-1", "event-1", "files");
    const tags = deliverablesCoreCacheTags("org-1", "event-1", "files");
    const load = () => loadDeliverablesCoreSnapshot(api, "files");
    const firstRead = cache.read({ key, tags, load });
    const duplicateRead = cache.read({ key, tags, load });
    const snapshot = await firstRead;

    expect(duplicateRead).toBe(firstRead);
    expect(snapshot).toMatchObject({
      sessions: [session],
      tasks: [task],
      assets: [assetV2],
      profiles: [profile],
      matrix,
    });
    expect(api.listSessions).toHaveBeenCalledTimes(1);
    expect(api.listDeliverableMatrix).toHaveBeenCalledTimes(1);
    expect(api.listAssets).toHaveBeenCalledTimes(1);
    expect(api.listProfiles).toHaveBeenCalledTimes(1);
    expect(cache.peek(key)).toBe(snapshot);

    const noRead = vi.fn();
    await expect(cache.read({ key, tags, load: noRead })).resolves.toBe(snapshot);
    expect(noRead).not.toHaveBeenCalled();

    const freshSnapshot = { ...snapshot, sessions: [] };
    await expect(
      cache.read({ key, tags, fresh: true, load: async () => freshSnapshot }),
    ).resolves.toBe(freshSnapshot);
    expect(cache.peek(key)).toBe(freshSnapshot);

    cache.invalidate(deliverablesCoreCacheInvalidationTags("org-1", "event-1"));
    expect(cache.peek(key)).toBeUndefined();
    expect(deliverablesCoreCacheKey("org-1", "event-2", "files")).not.toBe(key);
  });

  it("loads task fallback data before caching a Files snapshot", async () => {
    const api = {
      listSessions: vi.fn().mockResolvedValue([session]),
      listTasks: vi.fn().mockResolvedValue([task]),
      listAssets: vi.fn().mockResolvedValue([assetV2]),
      listProfiles: vi.fn().mockResolvedValue([profile]),
    } as unknown as DeliverablesApi;

    await expect(loadDeliverablesCoreSnapshot(api, "files")).resolves.toEqual({
      sessions: [session],
      tasks: [task],
      assets: [assetV2],
      profiles: [profile],
    });
    expect(api.listSessions).toHaveBeenCalledTimes(1);
    expect(api.listTasks).toHaveBeenCalledTimes(1);
    expect(api.listAssets).toHaveBeenCalledTimes(1);
    expect(api.listProfiles).toHaveBeenCalledTimes(1);
  });
});
describe("deliverables workspace", () => {
  it("routes session content work to the canonical Sessions workspace", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [session],
        tasks: [],
        assets: [],
        profiles: [],
        loadingSessionHistories: true,
      }),
    );

    expect(markup).toContain("Session content lives in Sessions");
    expect(markup).toContain("Open Sessions");
    expect(markup).not.toContain("Session title and abstract");
    expect(markup).not.toContain("Loading session change history");
  });
  it("uses Next Link for private organizer destinations while retaining skip anchors", () => {
    expect(deliverablesWorkspaceSource).toContain('import Link from "next/link";');
    expect(deliverablesWorkspaceSource).toContain("<Link href={href}>Open Sessions</Link>");
    expect(deliverablesWorkspaceSource).toContain("<Link href={href}>Open Speakers</Link>");
    expect(deliverablesWorkspaceSource).not.toContain("<a href={href}>");
    expect(deliverablesWorkspaceSource).toContain(
      '<a href={filesMode ? "#files-content" : "#deliverables-content"} className={styles.skipLink}>',
    );

    expect(fileLibrarySource).toContain('import Link from "next/link";');
    expect(fileLibrarySource).toContain(
      "<Link\n                href={`/admin/organizations/" +
        "$" +
        "{encodeURIComponent(\n                  organizationId,\n                )}/events/" +
        "$" +
        "{encodeURIComponent(eventId)}/deliverables`}\n              >",
    );
    expect(fileLibrarySource).not.toContain("<a");
  });
  it("shows a detail-resource error without replacing a successful sibling", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [session],
        tasks: [task],
        assets: [assetV1, assetV2],
        profiles: [profile],
        selectedAssetId: assetV2.id,
        assetHistory: [],
        assetHistoryError: "History service unavailable.",
        comments: [
          {
            id: "comment-1",
            eventId: "event-1",
            assetId: assetV2.id,
            versionId: assetV2.id,
            body: "Sibling comments remain visible.",
            authorLabel: "Priya Raman",
            createdAt: "2026-08-09T12:01:00.000Z",
          },
        ],
      }),
    );

    expect(markup).toContain("Version history unavailable: History service unavailable.");
    expect(markup).toContain("Sibling comments remain visible.");
    expect(markup).not.toContain("No version history was returned.");
  });
  it("renders task setup, filters, immutable versions, comments, approval, and content editors", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [session],
        tasks: [task],
        assets: [assetV1, assetV2],
        profiles: [profile],
        matrixItems: [matrixItem],
        operationStates: [
          {
            key: "asset-comment",
            label: "Reply to asset thread",
            phase: "succeeded",
            message: "Organizer reply added to asset version asset-2.",
          },
        ],
        selectedAssetId: "asset-2",
        assetHistory: [assetV1, assetV2],
        comments: [
          {
            id: "comment-1",
            eventId: "event-1",
            assetId: "asset-2",
            versionId: "asset-2",
            body: "Draft deck - final version coming Friday.",
            authorLabel: "Priya Raman",
            createdAt: "2026-08-09T12:01:00.000Z",
          },
        ],
        onCreateTask: async () => undefined,
        onInspectAsset: () => undefined,
        onAddComment: async () => undefined,
        onDownloadVersion: async () => undefined,
        onSendBulkReminder: async () => undefined,
        onSaveSession: async () => undefined,
        onApproveSession: async () => undefined,
        onSaveBiography: async () => undefined,
        onReplaceHeadshot: async () => undefined,
        onRestoreSessionVersion: async () => undefined,
      }),
    );
    expect(markup).toContain("Content requests");
    expect(markup).toContain("All requests");
    expect(markup).toContain("Needs attention");
    expect(markup).toContain("Outstanding");
    expect(markup).toContain("Ready for review");
    expect(markup).toContain("Complete");
    expect(markup).toContain("Assignments");
    expect(markup).toContain("Related records");
    expect(markup).toContain("Session content");
    expect(markup).toContain("Speaker profiles");
    expect(markup).toContain("New content request");
    expect(markup).toContain('data-slot="dialog-trigger"');
    expect(markup).not.toContain('data-slot="dialog-content"');
    expect(deliverableAssetKinds).toContain("slides");
    expect(markup).not.toContain("The replacement is staged through a");
    expect(markup).not.toContain("organizer headshot replacement");
    expect(markup).toContain("Filter by speaker");
    expect(markup).toContain("Filter by request");
    expect(markup).toContain("Filter by session");
    expect(markup).toContain("Remind all outstanding");
    expect(markup).toContain("Search assignments");
    expect(markup).toContain("slides.pdf");
    expect(markup).toContain("Current");
    expect(markup).toContain("Draft deck - final version coming Friday.");
    expect(markup).toContain("Selected asset comment evidence");
    expect(markup).toContain("Open Sessions");
    expect(markup).toContain("Session content lives in Sessions");
    expect(markup).toContain("Open Sessions");
    expect(markup).toContain("Canonical content and profiles stay");
    expect(markup).not.toContain("Prior version to restore");
    expect(markup).not.toContain("Restore selected prior version");
    expect(markup).toContain("Speaker profiles live in Speakers");
    expect(markup).toContain("Open Speakers");
    expect(markup).not.toContain("Monorepo Labs");
    expect(markup).not.toContain("priya@example.test");
    expect(markup).toContain("Organizer operation status");
    expect(markup).toContain("Organizer reply added to asset version asset-2.");
    expect(markup).not.toContain("must-not-cross-boundary");
    expect(markup).toContain("Select outstanding assignment");
  });
  it("keeps speaker profile history out of Content requests", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [session],
        tasks: [task],
        assets: [assetV2],
        profiles: [profile],
        speakerContentHistory: {
          [profile.participantId]: {
            status: "loading",
            entries: [],
          },
        },
      }),
    );

    expect(markup).toContain("Speaker profiles live in Speakers");
    expect(markup).toContain("Open Speakers");
    expect(markup).not.toContain("Loading speaker content history");
    expect(markup).not.toContain("Restore speaker profile history");
  });
  it("keeps Files and Deliverables route modes separate", () => {
    const filesMarkup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        mode: "files",
        sessions: [session],
        tasks: [task],
        assets: [assetV1, assetV2],
        profiles: [profile],
        onInspectAsset: () => undefined,
      }),
    );
    expect(filesMarkup).toContain("Review and download");
    expect(filesMarkup).toContain("Select approved files from a session");
    expect(filesMarkup).toContain("Download selected files ZIP");
    expect(filesMarkup).not.toContain("New file request");
    expect(filesMarkup).toContain('data-workspace-mode="files"');
    const deliverablesMarkup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        mode: "deliverables",
        sessions: [session],
        tasks: [task],
        assets: [assetV1, assetV2],
        profiles: [profile],
      }),
    );
    expect(deliverablesMarkup).toContain("Assign &amp; track");
    expect(deliverablesMarkup).not.toContain("Organizer-side authorized uploaded-asset library");
  });

  it("groups slides.pdf by its authoritative latest version and shows two versions", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        mode: "files",
        sessions: [session],
        tasks: [task],
        assets: [assetV1, assetV2],
        profiles: [profile],
        matrixItems: [{ ...matrixItem, currentAsset: assetV2, status: "uploaded" }],
        onInspectAsset: () => undefined,
      }),
    );
    expect(markup).toContain("slides.pdf");
    expect(markup).toContain("Current v2 · 2 versions");
    expect(markup).toContain("Review state");
    expect(markup).toContain("Review file");
  });

  it("opens one tabbed review drawer for the selected file family", () => {
    const [family] = projectFileFamilies(
      [assetV1, assetV2],
      [{ ...matrixItem, currentAsset: assetV2, status: "uploaded" }],
    );
    if (family === undefined) throw new Error("Expected one file family.");

    const markup = renderToStaticMarkup(
      createElement(FileReviewDrawerBody, {
        family,
        asset: assetV2,
        sessions: [session],
        tasks: [task],
        profiles: [profile],
        history: [assetV1, assetV2],
        comments: [
          {
            id: "comment-1",
            eventId: "event-1",
            assetId: assetV2.id,
            versionId: assetV2.id,
            body: "Please tighten the final slide.",
            authorLabel: "Organizer",
            createdAt: "2026-08-09T12:01:00.000Z",
          },
        ],
        loading: false,
        busy: false,
        assetHistoryError: null,
        commentsError: null,
        reviewAvailable: false,
      }),
    );

    expect(markup).toContain("Overview");
    expect(markup).toContain("Comments");
    expect(markup).toContain("Versions");
    expect(markup).not.toContain("Selected asset evidence");
  });

  it("exposes file filtering and latest asset/session selection controls", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        mode: "files",
        sessions: [session],
        tasks: [task],
        assets: [assetV1, assetV2],
        profiles: [profile],
      }),
    );
    expect(markup).toContain("Search files");
    expect(markup).toContain("Filter uploaded files");
    expect(markup).toContain("Select approved files from a session");
    expect(markup).toContain("Download rules");
    expect(markup).toContain('aria-label="Select ready current file slides.pdf"');
  });

  it("selects only the server-authoritative current ready version", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        mode: "files",
        sessions: [session],
        tasks: [task],
        assets: [assetV1, assetV2],
        profiles: [profile],
        matrixItems: [matrixItem],
        onExportFiles: async () => undefined,
      }),
    );

    expect(markup).toContain('data-current-version="asset-1"');
    expect(markup).toContain("Current v1 · 2 versions");
    expect(markup).toContain("Slides · application/pdf · 1 KiB");
    expect(markup).not.toContain('data-current-version="asset-2"');
  });

  it("does not infer a ZIP-selectable current version when the matrix omits one", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        mode: "files",
        sessions: [session],
        tasks: [task],
        assets: [assetV1, assetV2],
        profiles: [profile],
        matrixItems: [
          {
            task,
            participantId: "speaker-1",
            participantName: "Priya Raman",
            assets: [assetV1, assetV2],
            status: "submitted",
          },
        ],
        onExportFiles: async () => undefined,
      }),
    );

    expect(markup).toContain("current file");
    expect(markup).not.toContain('data-current-version="asset-2"');
    expect(markup).toContain("Only confirmed current files can be downloaded.");
  });

  it("requires explicit confirmation of the exact outstanding reminder snapshot", () => {
    const row: DeliverableRow = {
      task,
      session,
      sessionLabel: session.title,
      speaker: profile,
      speakerLabel: profile.displayName,
      assets: [assetV1],
      currentAsset: assetV1,
      status: "overdue",
    };
    const markup = renderToStaticMarkup(
      createElement(ReminderPreview, {
        rows: [row],
        busy: false,
        sendAvailable: true,
        onSend: () => undefined,
      }),
    );

    expect(markup).toContain("Recipient and assignment snapshot");
    expect(markup).toContain("I confirm this exact outstanding recipient and assignment snapshot.");
    expect(markup).toContain("Confirm and send reminders");
    expect(markup).toContain('disabled=""');
  });

  it("makes mode purpose, selection intent, and confirmation gates explicit", () => {
    const deliverablesMarkup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [session],
        tasks: [task],
        assets: [assetV1],
        profiles: [profile],
        onCreateTask: async () => undefined,
        onSendBulkReminder: async () => undefined,
        onApproveSession: async () => undefined,
      }),
    );
    expect((deliverablesMarkup.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(deliverablesMarkup).toContain('data-workspace-mode="deliverables"');
    expect(deliverablesMarkup).toContain("Select outstanding assignment");
    expect(deliverablesMarkup).toContain("Canonical content and profiles stay");
    expect(deliverablesMarkup).toContain("Canonical content and profiles stay");

    const filesMarkup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        mode: "files",
        sessions: [session],
        tasks: [task],
        assets: [assetV1],
        profiles: [profile],
        matrixItems: [{ ...matrixItem, currentAsset: assetV1 }],
      }),
    );
    expect((filesMarkup.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(filesMarkup).toContain("Review and download");
    expect(filesMarkup).toContain("Download rules");
    expect(filesMarkup).toContain("ready");
    expect(filesMarkup).toContain("Select approved files from a session");
  });

  it("keeps every ZIP response state explicit and non-fabricated", () => {
    expect(Object.keys(deliverablesExportStatusLabels)).toEqual([
      "idle",
      "queued",
      "preparing",
      "generating",
      "ready",
      "download-started",
      "failure",
    ]);
    expect(deliverablesExportStatusLabels.queued).toContain("queued");
    expect(deliverablesExportStatusLabels.generating).toContain("generating");
    expect(deliverablesExportStatusLabels.ready).toContain("validated authoritative manifest");
    expect(deliverablesExportActionLabels.queued).toBe("ZIP export queued");
    expect(deliverablesExportActionLabels.ready).toBe("Inspect authoritative manifest");
    expect(deliverablesExportActionLabels.failure).toBe("Retry ZIP export");
    expect(deliverablesExportStatusLabels["download-started"]).toContain("download");
    expect(deliverablesExportStatusLabels.failure).toContain("failed");
  });
  it("renders explicit subject controls and authoritative version pointer badges", () => {
    const pointerAsset: DeliverableAsset = {
      ...assetV2,
      latestVersionId: assetV2.id,
      currentVersionId: assetV2.id,
      approvedVersionId: assetV1.id,
      releasedVersionId: assetV1.id,
      versionId: assetV2.id,
    };
    const pointerV1: DeliverableAsset = {
      ...assetV1,
      versionId: assetV1.id,
      latestVersionId: assetV2.id,
      currentVersionId: assetV2.id,
      approvedVersionId: assetV1.id,
      releasedVersionId: assetV1.id,
    };
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [session],
        tasks: [task],
        assets: [pointerV1, pointerAsset],
        profiles: [profile],
        matrixItems: [
          { ...matrixItem, assets: [pointerV1, pointerAsset], currentAsset: pointerAsset },
        ],
        selectedAssetId: pointerAsset.id,
        assetHistory: [pointerV1, pointerAsset],
        comments: [],
        onCreateTask: async () => undefined,
        onReviewAsset: async () => undefined,
      }),
    );

    expect(markup).toContain("New content request");
    expect(markup).toContain("Current · 2 versions");
  });

  it("renders honest disabled capability states rather than fabricated success", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliverablesWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        error: "This content changed elsewhere. Reload before trying again.",
        sessions: [],
        tasks: [],
        assets: [],
        profiles: [],
        capabilityMessages: ["Task tracking unavailable", "Bulk reminder sending is unavailable"],
      }),
    );
    expect(markup).toContain("This content changed elsewhere. Reload before trying again.");
    expect(markup).toContain("Task tracking unavailable");
    expect(markup).toContain("Bulk reminder sending is unavailable");
    expect(markup).toContain("Task creation unavailable");
    expect(markup).toContain("Session content lives in Sessions");
    expect(markup).not.toContain("objectKey");
    expect(markup).toContain("Remind all outstanding (0)");
    expect(markup).toContain('disabled=""');
  });
  it("revokes the transient object URL after starting a ZIP download", () => {
    const createObjectURL = vi.fn(() => "blob:deliverables");
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    vi.stubGlobal("document", {
      createElement: () => ({
        href: "",
        download: "",
        rel: "",
        style: {},
        click,
        remove,
      }),
      body: { appendChild },
    });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const download: DeliverableExportDownload = {
      body: new Uint8Array([80, 75, 3, 4]).buffer,
      fileName: "event-1-deliverables.zip",
      contentType: "application/zip",
      sizeBytes: 4,
      manifest: {
        format: "speaker-deliverables-export",
        version: 1,
        organizationId: "org-1",
        eventId: "event-1",
        entries: [],
      },
      response: {
        kind: "synchronous_zip",
        status: 200,
        contentType: "application/zip",
        contentLength: 4,
      },
    };
    try {
      triggerDeliverablesDownload(download);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(appendChild).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:deliverables");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
