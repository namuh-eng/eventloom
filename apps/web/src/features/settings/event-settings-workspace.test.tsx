import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createNavigationDataCache } from "@/lib/navigation-data-cache";
import { qualifiedEventContext } from "../admin/admin-shell";
import { OrganizerEventWorkspaceProvider } from "../admin/organizer-event-workspace";
import {
  agendaWorkspaceCacheKey,
  agendaWorkspaceCacheTags,
  loadCanonicalAgendaWorkspaceWithCache,
} from "../agenda/agenda-workspace-model";
import type { AgendaApi } from "../agenda/api";
import type { AgendaWorkspaceData } from "../agenda/types";
import {
  createEventSettingsApi,
  defaultAgendaEligibleStatuses,
  defaultSessionStatuses,
  type EventRoom,
  EventSettingsApiError,
  type EventSettingsAuditEntry,
  type EventSettingsData,
  type EventTaxonomyResource,
  type SessionSettingsRecord,
  validateRoomInput,
} from "./api";
import {
  createEventSettingsNavigationCache,
  EVENT_SETTINGS_NAVIGATION_CACHE_TTL_MS,
  isCompleteEventSettingsNavigationCacheSnapshot,
} from "./event-settings-navigation-cache-model";
import { eventSettingsSectionHref } from "./event-settings-sections";
import {
  EventSettingsWorkspaceView,
  eventSettingsMutationInvalidatesAgendaCatalog,
  invalidateAgendaCatalogAfterEventSettingsMutation,
} from "./event-settings-workspace";
import {
  canCommitEventSettingsAsyncCompletion,
  eventSettingsSectionNavigation,
  eventSettingsWorkspaceScopeKey,
  loadEventSettingsProgressively,
  persistEventSettingsMutation,
  validateRoomForm,
} from "./event-settings-workspace-model";

const staleAgendaCatalog = {
  event: { id: "event-a" },
  rooms: [],
  tracks: [],
} as unknown as AgendaWorkspaceData;

const freshAgendaCatalog = {
  event: { id: "event-a" },
  rooms: [{ id: "room-new", name: "New room", capacity: 120 }],
  tracks: [{ id: "track-new", name: "New track", color: "#123456" }],
} as unknown as AgendaWorkspaceData;

const settings: SessionSettingsRecord = {
  id: "settings_event-a",
  tenantId: "org_a",
  eventId: "event-a",
  statuses: [...defaultSessionStatuses],
  agendaEligibleStatuses: [...defaultAgendaEligibleStatuses],
  version: 3,
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-09T10:30:00.000Z",
  createdBy: "organizer",
  updatedBy: "organizer",
  history: [],
};

const rooms: EventRoom[] = [
  {
    id: "room-main",
    tenantId: "org_a",
    eventId: "event-a",
    name: "Main room",
    capacity: 100,
    resources: ["Projector", "Microphones"],
    version: 2,
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:30:00.000Z",
    createdBy: "organizer",
    updatedBy: "organizer",
    history: [],
  },
];

const resource = (kind: string): EventTaxonomyResource => ({
  id: `${kind}-one`,
  tenantId: "org_a",
  eventId: "event-a",
  name: `One ${kind}`,
  description: "Event value",
  version: 1,
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-09T10:00:00.000Z",
  createdBy: "organizer",
  updatedBy: "organizer",
  history: [],
});

const audit: EventSettingsAuditEntry[] = [
  {
    id: "audit-1",
    tenantId: "org_a",
    eventId: "event-a",
    entityType: "settings",
    entityId: settings.id,
    action: "settings.updated",
    version: 3,
    actorId: "organizer",
    occurredAt: "2026-08-09T10:30:00.000Z",
  },
];

const overview: EventSettingsData = {
  organizationId: "org_a",
  eventId: "event-a",
  settings,
  rooms,
  tracks: [resource("track")],
  formats: [resource("format")],
  levels: [],
  tags: [],
  audit,
};

function response<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("event settings mutation persistence", () => {
  it("keeps a durable write successful when its authoritative refresh fails", async () => {
    let writes = 0;
    const outcome = await persistEventSettingsMutation(
      async () => {
        writes += 1;
      },
      async () => {
        throw new Error("refresh unavailable");
      },
    );

    expect(outcome).toBe("refresh-failed");
    expect(writes).toBe(1);
  });

  it("propagates a failed write without attempting a refresh", async () => {
    let refreshed = false;
    await expect(
      persistEventSettingsMutation(
        async () => {
          throw new Error("write failed");
        },
        async () => {
          refreshed = true;
        },
      ),
    ).rejects.toThrow("write failed");
    expect(refreshed).toBe(false);
  });
});
describe("agenda catalog invalidation after event settings mutations", () => {
  it("loads a fresh room and track catalog after settings creation", async () => {
    const cache = createNavigationDataCache();
    const organizationId = "org_a";
    const eventId = "event-a";
    const key = agendaWorkspaceCacheKey(organizationId, eventId);
    const tags = agendaWorkspaceCacheTags(organizationId, eventId);
    let workspaceReads = 0;
    const agendaApi = {
      getWorkspace: async () => {
        workspaceReads += 1;
        return freshAgendaCatalog;
      },
    } as unknown as AgendaApi;

    cache.write(key, staleAgendaCatalog, tags);
    cache.write("event-navigation:event-a", { preserved: true }, ["event:event-a"]);
    invalidateAgendaCatalogAfterEventSettingsMutation(cache, eventId);
    expect(cache.peek("event-navigation:event-a")).toEqual({ preserved: true });

    await expect(
      loadCanonicalAgendaWorkspaceWithCache(agendaApi, eventId, cache, key, tags),
    ).resolves.toMatchObject({
      data: {
        rooms: [{ id: "room-new" }],
        tracks: [{ id: "track-new" }],
      },
    });
    expect(workspaceReads).toBe(1);
  });

  it("invalidates only agenda-relevant classification kinds", () => {
    expect(eventSettingsMutationInvalidatesAgendaCatalog()).toBe(true);
    expect(eventSettingsMutationInvalidatesAgendaCatalog("track")).toBe(true);
    expect(eventSettingsMutationInvalidatesAgendaCatalog("format")).toBe(true);
    expect(eventSettingsMutationInvalidatesAgendaCatalog("level")).toBe(false);
    expect(eventSettingsMutationInvalidatesAgendaCatalog("tag")).toBe(false);
  });
});
describe("event settings navigation cache", () => {
  it("normalizes scopes without allowing one organization or event to reuse another", () => {
    const cache = createEventSettingsNavigationCache({ now: () => 10 });
    const snapshot = {
      state: { status: "loaded" as const, data: overview, detailsStatus: "loaded" as const },
      eventIdentity: { id: "event-a", name: "Summit 2026", slug: "summit-2026" },
    };

    cache.set({ organizationId: " org_a ", eventId: " event-a " }, snapshot);

    expect(cache.get({ organizationId: "org_a", eventId: "event-a" })).toEqual(snapshot);
    expect(cache.get({ organizationId: "org_b", eventId: "event-a" })).toBeUndefined();
    expect(cache.get({ organizationId: "org_a", eventId: "event-b" })).toBeUndefined();
  });

  it("expires entries at the bounded navigation-cache lifetime", () => {
    let now = 100;
    const cache = createEventSettingsNavigationCache({ now: () => now });
    const snapshot = {
      state: { status: "loaded" as const, data: overview, detailsStatus: "loaded" as const },
    };

    cache.set({ organizationId: "org_a", eventId: "event-a" }, snapshot);
    expect(cache.get({ organizationId: "org_a", eventId: "event-a" })).toEqual(snapshot);

    now += EVENT_SETTINGS_NAVIGATION_CACHE_TTL_MS;
    expect(cache.get({ organizationId: "org_a", eventId: "event-a" })).toBeUndefined();
  });

  it("reuses complete entries but keeps incomplete data reloadable and supports invalidation", () => {
    const cache = createEventSettingsNavigationCache({ now: () => 1 });
    const scope = { organizationId: "org_a", eventId: "event-a" };
    const identity = { id: "event-a", name: "Summit 2026", slug: "summit-2026" };
    const partial = {
      state: { status: "loaded" as const, data: overview, detailsStatus: "error" as const },
      eventIdentity: identity,
    };
    const completeWithoutIdentity = {
      state: { status: "loaded" as const, data: overview, detailsStatus: "loaded" as const },
    };
    const complete = {
      ...completeWithoutIdentity,
      eventIdentity: identity,
    };

    cache.set(scope, partial);
    expect(isCompleteEventSettingsNavigationCacheSnapshot(cache.get(scope))).toBe(false);
    expect(cache.get(scope)).toEqual(partial);
    cache.set(scope, completeWithoutIdentity);
    expect(isCompleteEventSettingsNavigationCacheSnapshot(cache.get(scope))).toBe(false);

    cache.set(scope, complete);
    expect(isCompleteEventSettingsNavigationCacheSnapshot(cache.get(scope))).toBe(true);
    cache.invalidate(scope);
    expect(cache.get(scope)).toBeUndefined();
  });
});

describe("event settings progressive loading", () => {
  it("starts every independent read together and exposes core settings before optional details", async () => {
    const paths = [
      "/sessions/settings",
      "/sessions/rooms",
      "/sessions/tracks",
      "/sessions/formats",
      "/sessions/levels",
      "/sessions/tags",
      "/sessions/audit",
    ] as const;
    const pending = new Map(paths.map((path) => [path, deferred<Response>()]));
    const calls: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = paths.find((candidate) => url.endsWith(candidate));
      if (!path) throw new Error(`Unexpected request ${url}`);
      calls.push(path);
      const request = pending.get(path);
      if (!request) throw new Error(`Missing deferred request ${path}`);
      return request.promise;
    };
    const api = createEventSettingsApi("", "org_a", fetcher);
    const coreRendered = deferred<EventSettingsData>();
    let settled = false;

    const completion = loadEventSettingsProgressively(api, "org_a", "event-a", (core) =>
      coreRendered.resolve(core),
    ).then((loaded) => {
      settled = true;
      return loaded;
    });

    expect(calls).toEqual(paths);
    pending.get("/sessions/settings")?.resolve(response(settings));
    pending.get("/sessions/rooms")?.resolve(response(rooms));

    const core = await coreRendered.promise;
    expect(core.settings.version).toBe(3);
    expect(core.rooms).toEqual(rooms);
    expect(core.tracks).toEqual([]);
    expect(core.audit).toEqual([]);
    expect(settled).toBe(false);

    const coreMarkup = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        section: "workflow",
        state: { status: "loaded", data: core, detailsStatus: "loading" },
      }),
    );
    expect(coreMarkup).toContain("Session workflow");
    expect(coreMarkup).toContain("Session statuses");
    expect(coreMarkup).toContain("Accepted");
    expect(coreMarkup).not.toContain("Main room");
    expect(coreMarkup).not.toContain("Loading session classification");
    expect(coreMarkup).not.toContain("Loading change history");
    expect(coreMarkup).not.toContain("One track");

    pending.get("/sessions/tracks")?.resolve(response(overview.tracks));
    pending.get("/sessions/formats")?.resolve(response(overview.formats));
    pending.get("/sessions/levels")?.resolve(response(overview.levels));
    pending.get("/sessions/tags")?.resolve(response(overview.tags));
    pending.get("/sessions/audit")?.resolve(response(audit));

    await expect(completion).resolves.toMatchObject({
      tracks: overview.tracks,
      formats: overview.formats,
      audit,
    });
  });

  it("rejects stale, aborted, and unmounted completions across event scopes", async () => {
    const scopeA = eventSettingsWorkspaceScopeKey("org_a", "event-a");
    const scopeB = eventSettingsWorkspaceScopeKey("org_a", "event-b");
    const pendingCompletion = deferred<string>();
    let currentRequestId = 1;
    let committed: string | null = null;
    const completion = pendingCompletion.promise.then((value) => {
      if (canCommitEventSettingsAsyncCompletion(1, currentRequestId, true)) committed = value;
    });

    currentRequestId = 2;
    pendingCompletion.resolve("event-a");
    await completion;

    expect(scopeA).not.toBe(scopeB);
    expect(committed).toBeNull();
    expect(canCommitEventSettingsAsyncCompletion(2, 2, true)).toBe(true);
    expect(canCommitEventSettingsAsyncCompletion(2, 2, false)).toBe(false);
    expect(canCommitEventSettingsAsyncCompletion(2, 2, true, true)).toBe(false);
  });
});

describe("event settings API", () => {
  it("resolves the human event identity from the organizer event collection", async () => {
    const calls: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return response([
        {
          id: "event-a",
          organizationId: "org_a",
          name: "Summit 2026",
          slug: "summit-2026",
        },
      ]);
    };

    const api = createEventSettingsApi("", "org_a", fetcher);

    await expect(api.getEventIdentity("event-a")).resolves.toEqual({
      id: "event-a",
      name: "Summit 2026",
      slug: "summit-2026",
    });
    expect(calls).toEqual(["/api/admin/organizations/org_a/events"]);
  });

  it("reads organization/event-qualified settings and library resources", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/sessions/settings")) return response(settings);
      if (url.endsWith("/sessions/rooms")) return response(rooms);
      if (url.endsWith("/sessions/tracks")) return response(overview.tracks);
      if (url.endsWith("/sessions/formats")) return response(overview.formats);
      if (url.endsWith("/sessions/levels")) return response(overview.levels);
      if (url.endsWith("/sessions/tags")) return response(overview.tags);
      if (url.endsWith("/sessions/audit")) return response(audit);
      throw new Error(`Unexpected request ${url}`);
    };

    const api = createEventSettingsApi("https://api.example.test/", "org/a", fetcher);
    await expect(api.getOverview("event/a")).resolves.toMatchObject({
      organizationId: "org/a",
      eventId: "event/a",
    });
    expect(
      calls.every((call) =>
        call.url.includes("/api/admin/organizations/org%2Fa/events/event%2Fa/"),
      ),
    ).toBe(true);
    expect(calls.every((call) => call.init?.credentials === "include")).toBe(true);
  });

  it("uses the same-origin gateway for durable room and track creation", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/sessions/rooms")) return response(rooms[0]);
      if (url.endsWith("/sessions/tracks")) return response(resource("track"));
      throw new Error(`Unexpected request ${url}`);
    };
    const api = createEventSettingsApi("", " org/a ", fetcher);

    await api.createRoom(" event/a ", {
      id: " room-side ",
      name: " Side room ",
      capacity: 25,
      resources: [" Whiteboard ", "Microphones "],
    });
    await api.createTrack(" event/a ", {
      name: " Web ",
      description: " Durable description ",
    });

    expect(
      calls.map((call) => ({
        url: call.url,
        method: call.init?.method,
        credentials: call.init?.credentials,
        body: JSON.parse(String(call.init?.body)),
      })),
    ).toEqual([
      {
        url: "/api/admin/organizations/org%2Fa/events/event%2Fa/sessions/rooms",
        method: "POST",
        credentials: "include",
        body: {
          id: "room-side",
          name: "Side room",
          capacity: 25,
          resources: ["Whiteboard", "Microphones"],
        },
      },
      {
        url: "/api/admin/organizations/org%2Fa/events/event%2Fa/sessions/tracks",
        method: "POST",
        credentials: "include",
        body: { name: "Web", description: "Durable description" },
      },
    ]);
  });

  it("creates and edits rooms with optimistic versions", async () => {
    const bodies: unknown[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return response(rooms[0]);
    };
    const api = createEventSettingsApi("https://api.example.test", "org_a", fetcher);

    await api.createRoom("event-a", {
      id: "room-side",
      name: "Side room",
      capacity: 25,
      resources: ["Whiteboard"],
    });
    await api.updateRoom("event-a", {
      roomId: "room-main",
      expectedVersion: 2,
      name: "Main room",
      capacity: 120,
      resources: ["Projector"],
    });
    expect(bodies).toEqual([
      { id: "room-side", name: "Side room", capacity: 25, resources: ["Whiteboard"] },
      { expectedVersion: 2, name: "Main room", capacity: 120, resources: ["Projector"] },
    ]);
  });

  it("preserves a version conflict as a structured API error", async () => {
    const api = createEventSettingsApi(
      "https://api.example.test",
      "org_a",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "VERSION_CONFLICT",
              message: "Reload the settings.",
              traceId: "trace-1",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    const error = await api
      .updateSettings("event-a", {
        expectedVersion: settings.version,
        statuses: settings.statuses,
        agendaEligibleStatuses: settings.agendaEligibleStatuses,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EventSettingsApiError);
    expect(error).toMatchObject({ code: "VERSION_CONFLICT", status: 409, traceId: "trace-1" });
  });

  it("sends an audited agenda eligibility update and keeps Accepted as the default", async () => {
    let body: unknown;
    const updated = { ...settings, version: 4, agendaEligibleStatuses: ["Accepted", "Waitlisted"] };
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      return response(updated);
    };
    const api = createEventSettingsApi("https://api.example.test", "org_a", fetcher);
    await api.updateSettings("event-a", {
      expectedVersion: settings.version,
      statuses: settings.statuses,
      agendaEligibleStatuses: updated.agendaEligibleStatuses,
    });
    expect(defaultAgendaEligibleStatuses).toEqual(["Accepted"]);
    expect(body).toMatchObject({
      expectedVersion: 3,
      agendaEligibleStatuses: ["Accepted", "Waitlisted"],
    });
  });

  it("rejects invalid room capacity and duplicate/blank resources before a request", () => {
    expect(() => validateRoomInput({ name: "Room", capacity: 0 })).toThrow("positive integer");
    expect(() =>
      validateRoomInput({ name: "Room", capacity: 20, resources: ["Projector", "Projector"] }),
    ).toThrow("duplicates");
    expect(validateRoomForm("Room", "20", "Projector, microphones")).toMatchObject({
      input: { capacity: 20 },
    });
    expect(validateRoomForm("Room", "20", "Projector,, microphones")).toMatchObject({
      error: "Resource names cannot be empty.",
    });
  });
});

describe("event settings view", () => {
  it("renders accessible grouped navigation and explicit audit state", () => {
    const output = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        eventIdentity: {
          id: "event-a",
          name: "Summit 2026",
          slug: "summit-2026",
        },
        section: "history",
        state: { status: "loaded", data: overview },
      }),
    );
    expect(output).toContain('aria-label="Program settings sections"');
    expect(output).toContain("Configure this event");
    expect(output).toContain("Event setup");
    expect(output).toContain("Governance");
    expect(output).toContain("Session classification");
    expect(output).toContain("Change history");
    expect(output).toContain("Session statuses");
    expect(output).toContain("Updated");
    expect(output).toContain('data-change-kind="updated"');
    expect(output).toContain("Summit 2026");
    expect(output).toContain("Organization org_a · Public slug summit-2026");
    expect(output).toContain("Edit event dates");
    expect(output).toContain("/admin/organizations/org_a/events?edit=event-a");
    expect(output).not.toContain("Organization org_a · Event event-a");
  });
  it("keeps section links on the canonical event ID when the public slug differs", () => {
    const organizationId = "org_a";
    const eventId = "87aadc17-ec67-4f29-8b0f-8fc6733da05d";
    const eventSlug = "test-summit-local";
    const output = renderToStaticMarkup(
      createElement(
        OrganizerEventWorkspaceProvider,
        {
          event: {
            id: eventId,
            name: "Test Summit",
            slug: eventSlug,
          },
          organizationId,
        },
        createElement(EventSettingsWorkspaceView, {
          organizationId,
          eventId,
          eventIdentity: {
            id: eventId,
            name: "Test Summit",
            slug: eventSlug,
          },
          state: { status: "loaded", data: { ...overview, eventId, organizationId } },
        }),
      ),
    );

    for (const section of eventSettingsSectionNavigation) {
      expect(output).toContain(
        `href="${eventSettingsSectionHref(organizationId, eventId, section.id)}"`,
      );
      expect(output).not.toContain(
        `href="${eventSettingsSectionHref(organizationId, eventSlug, section.id)}"`,
      );
    }
  });

  it("explains how session classification values affect the program", () => {
    const output = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        section: "classification",
        state: {
          status: "loaded",
          data: {
            ...overview,
            tracks: [],
            formats: [],
            levels: [],
            tags: [],
          },
        },
        actions: {
          createResource: async () => undefined,
          updateResource: async () => undefined,
          deleteResource: async () => undefined,
        },
      }),
    );
    expect(output).toContain("Define how sessions are organized and discovered.");
    expect(output).toContain("Primary topic or program stream");
    expect(output).toContain("How the session is delivered");
    expect(output).toContain("Recommended");
    expect(output).toContain("Optional");
    expect(output).toContain("Add your first track");
    expect(output).not.toContain("event-scoped value");
  });

  it("renders loading, empty, and error states without inventing records", () => {
    const loading = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        state: { status: "loading" },
      }),
    );
    expect(loading).toContain("Loading event settings");
    const emptyData = {
      ...overview,
      rooms: [],
      tracks: [],
      formats: [],
      levels: [],
      tags: [],
      audit: [],
    };
    const emptyRooms = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        section: "rooms",
        state: { status: "loaded", data: emptyData },
      }),
    );
    const emptyHistory = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        section: "history",
        state: { status: "loaded", data: emptyData },
      }),
    );
    expect(emptyRooms).toContain("No rooms configured yet.");
    expect(emptyHistory).toContain("No configuration changes have been audited");
    const notice = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        state: { status: "loaded", data: overview },
        notice: "Unable to complete this change. Retry the request.",
      }),
    );
    expect(notice).toContain('role="status"');
    expect(notice).toContain("Retry the request.");
    const error = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        state: { status: "error", message: "The settings API is unavailable." },
      }),
    );
    expect(error).toContain("The settings API is unavailable.");
  });
  it("exposes the shared section metadata as qualified routed destinations", () => {
    const output = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        state: { status: "loaded", data: overview },
      }),
    );
    for (const section of eventSettingsSectionNavigation) {
      expect(output).toContain(eventSettingsSectionHref("org_a", "event-a", section.id));
      expect(output).toContain(section.label);
    }
    expect(output).toContain('data-slot="collapsible"');
    expect(output).toContain('id="workflow"');
    expect(output).not.toContain('href="#workflow"');
    expect(output).not.toContain("Open Communications");
    expect(output).not.toContain("Open Agenda &amp; Calendar");
  });

  it("keeps core failures full width and free of dead section anchors", () => {
    const output = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        state: { status: "error", message: "Core settings failed." },
        onRetry: () => undefined,
      }),
    );
    expect(output).toContain("Core settings failed.");
    expect(output).toContain("Try again");
    expect(output).not.toContain("Event settings sections");
    expect(output).not.toContain('href="#session-settings"');
    expect(output).not.toContain('href="#rooms"');
  });

  it("keeps progressive details failure separate from loaded core settings", () => {
    const classification = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        section: "classification",
        state: {
          status: "loaded",
          data: overview,
          detailsStatus: "error",
          detailsMessage: "Library reads timed out.",
        },
      }),
    );
    const history = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        section: "history",
        state: {
          status: "loaded",
          data: overview,
          detailsStatus: "error",
          detailsMessage: "Library reads timed out.",
        },
      }),
    );
    expect(classification).toContain("Library reads timed out.");
    expect(classification).toContain("Session classification unavailable.");
    expect(history).toContain("Library reads timed out.");
    expect(history).toContain("Change history unavailable.");
  });

  it("renders compact status rows with labelled eligibility and honest disabled actions", () => {
    const output = renderToStaticMarkup(
      createElement(EventSettingsWorkspaceView, {
        organizationId: "org_a",
        eventId: "event-a",
        state: { status: "loaded", data: overview },
        actions: {},
      }),
    );
    expect(output).toContain("Configured session statuses and agenda eligibility");
    expect(output).toContain("Can Accepted appear on the private agenda");
    expect(output).toContain("More actions for Accepted");
    expect(output).toContain("Session settings are read-only.");
    expect(output).toMatch(/data-slot="button"[^>]*disabled/);
  });
  it("adds settings navigation context only for qualified event routes", () => {
    expect(qualifiedEventContext("/admin/organizations/org_a/events/event-a/settings")).toEqual({
      organizationId: "org_a",
      eventId: "event-a",
    });
    expect(qualifiedEventContext("/admin/events")).toBeNull();
    expect(qualifiedEventContext("/admin/organizations//events/event-a/settings")).toBeNull();
  });
});
