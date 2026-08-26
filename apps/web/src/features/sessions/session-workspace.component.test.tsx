import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrganizerEventWorkspaceProvider } from "@/features/admin/organizer-event-workspace";
import { createNavigationDataCache } from "@/lib/navigation-data-cache";
import type { SessionRecord, SessionsApi } from "./api";
import { SessionsWorkspaceView, sessionContentDraftIsDirty } from "./session-workspace";
import {
  loadSessionFormats,
  loadSessionsWorkspaceBundle,
  loadSessionTracks,
  type SessionsWorkspaceCacheBundle,
  sessionsWorkspaceCacheKey,
  sessionsWorkspaceCacheTags,
} from "./session-workspace-model";

const session: SessionRecord = {
  id: "session-1",
  eventId: "event-1",
  title: "Reliable worker pools",
  description: "How to keep jobs moving.",
  status: "Accepted",
  contentStatus: "Needs changes" as const,
  durationMinutes: 45,
  trackIds: ["track-1"],
  formatId: "format-1",
  speakerIds: ["speaker-1"],
  speakerRoster: [{ id: "speaker-1", displayName: "Avery Kim", role: "primary" }],
  version: 2,
  createdAt: "2026-08-09T12:00:00.000Z",
  updatedAt: "2026-08-09T12:01:00.000Z",
  updatedBy: "organizer-1",
};
const speakers = [{ id: "speaker-1", displayName: "Avery Kim" }] as const;
const tracks = [{ id: "track-1", name: "Platform" }] as const;
const formats = [{ id: "format-1", name: "Talk" }] as const;

function ordinaryVisibleText(markup: string): string {
  return markup
    .replace(/<details[\s\S]*?<\/details>/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sessionsApi(): SessionsApi {
  return {
    list: vi.fn(async () => [session]),
    get: vi.fn(async () => session),
    updateContent: vi.fn(async () => session),
    listTracks: vi.fn(async () => [{ id: "track-1", name: "Platform" }]),
    listFormats: vi.fn(async () => [{ id: "format-1", name: "Talk" }]),
    listSpeakers: vi.fn(async () => speakers),
    updateSpeakers: vi.fn(async () => session),
    listHistory: vi.fn(async () => []),
    restoreVersion: vi.fn(async () => session),
  };
}

describe("sessions workspace presentation", () => {
  it("renders one accessible empty workspace with the event name", () => {
    const markup = renderToStaticMarkup(
      createElement(
        OrganizerEventWorkspaceProvider,
        {
          organizationId: "org-1",
          event: {
            id: "87aadc17-5e75-4732-9085-65df6b8e9a9b",
            name: "Test Summit Local",
            slug: "test-summit-local",
          },
        },
        createElement(SessionsWorkspaceView, {
          organizationId: "org-1",
          eventId: "87aadc17-5e75-4732-9085-65df6b8e9a9b",
          sessions: [],
          selectedSessionId: null,
          history: [],
        }),
      ),
    );

    expect(markup).toContain('data-sessions-state="empty"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Test Summit Local");
    expect(markup).not.toContain("Event 87aadc17-5e75-4732-9085-65df6b8e9a9b");
    expect(markup).not.toContain('data-sessions-layout="split"');
  });

  it("presents canonical editing, approval, attributed history, and restore controls", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionsWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [{ ...session, version: 3 }],
        selectedSessionId: session.id,
        history: [
          {
            id: "history-1",
            action: "updated",
            version: 1,
            actorId: "organizer-legacy",
            actorLabel: "organizer-legacy",
            occurredAt: "2026-08-09T12:01:00.000Z",
            snapshot: {
              title: "Original worker pools",
              description: "The first abstract.",
              contentStatus: "Needs changes",
            },
          },
          {
            id: "history-2",
            action: "updated",
            version: 2,
            actorId: "organizer-second",
            actorLabel: "Avery Kim",
            occurredAt: "2026-08-09T12:01:00.000Z",
            snapshot: {
              title: session.title,
              description: session.description,
              contentStatus: "Needs changes",
            },
          },
          {
            id: "history-3",
            action: "approved",
            version: 3,
            actorId: "organizer-second",
            actorLabel: "Avery Kim",
            occurredAt: "2026-08-09T12:02:00.000Z",
            snapshot: {
              title: session.title,
              description: session.description,
              contentStatus: "Approved",
            },
          },
        ],
        speakers: [
          {
            id: "speaker-1",
            displayName: "Avery Kim",
            jobTitle: "Staff Engineer",
            company: "Example Co",
          },
          { id: "speaker-2", displayName: "Morgan Lee" },
        ],
        onSave: async () => true,
        onSaveSpeakers: async () => undefined,
        onSetContentStatus: async () => undefined,
        onRestore: async () => undefined,
      }),
    );
    const ordinaryText = ordinaryVisibleText(markup);

    expect(markup).toContain('data-sessions-layout="split"');
    expect(markup).toContain("Sessions");
    expect(markup).toContain("Reliable worker pools");
    expect(markup).toContain("Session content");
    expect(markup).toContain("Content approval");
    expect(markup).toContain("Approve content");
    expect(markup).toContain("Speaker assignments");
    expect(markup).toContain("Current assignments");
    expect(markup).toContain("Avery Kim");
    expect(markup).toContain("Primary");
    expect(markup).toContain("Morgan Lee");
    expect(markup).toContain("Add or edit speakers");
    expect(markup).toContain('href="/admin/organizations/org-1/events/event-1/speakers"');
    expect(markup).toContain("Save speaker assignments");
    expect(markup).toContain('role="checkbox"');
    expect(markup).toContain("Change history");
    expect(markup).toContain("Avery Kim");
    expect(ordinaryText).toContain("Authorized organizer");
    expect(ordinaryText).not.toContain("organizer-legacy");
    expect(ordinaryText).not.toContain("organizer-second");
    expect(markup).toContain("<strong>Updated</strong>");
    expect(ordinaryText).not.toContain("Version 1");
    expect(ordinaryText).not.toContain("Version 2");
    expect(markup).toContain("Restore this revision");
    expect(markup).not.toContain("Restore version");
    const restoreLabels = [...markup.matchAll(/aria-label="(Restore [^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(restoreLabels).toHaveLength(2);
    expect(new Set(restoreLabels).size).toBe(2);
    expect(restoreLabels[0]).toMatch(
      /^Restore Updated revision from .+2026.+12:01.+history item 1 of 3$/u,
    );
    expect(restoreLabels[1]).toMatch(
      /^Restore Updated revision from .+2026.+12:01.+history item 2 of 3$/u,
    );
    expect(markup).toContain("<summary>Advanced audit details</summary>");
    expect(markup).toContain("<code>organizer-legacy</code>");
    expect(markup).toContain("<code>organizer-second</code>");
    expect(markup).toContain("Current");
  });

  it("encodes reserved organization and event route characters", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionsWorkspaceView, {
        organizationId: "organization one/#%",
        eventId: "event one/#%",
        sessions: [session],
        selectedSessionId: session.id,
        history: [],
        speakers: [],
      }),
    );

    expect(markup).toContain(
      'href="/admin/organizations/organization%20one%2F%23%25/events/event%20one%2F%23%25/speakers"',
    );
  });

  it("uses nontechnical labels when session speaker and organization names are unavailable", () => {
    const missingLabels = {
      ...session,
      speakerIds: ["speaker-internal-42"],
      speakerRoster: [],
    };
    const markup = renderToStaticMarkup(
      createElement(SessionsWorkspaceView, {
        organizationId: "organization-internal-42",
        eventId: "event-1",
        sessions: [missingLabels],
        selectedSessionId: missingLabels.id,
        history: [],
        speakers: [],
        onSaveSpeakers: async () => undefined,
      }),
    );
    const text = ordinaryVisibleText(markup);

    expect(text).toContain("Speaker unavailable");
    expect(text).not.toContain("speaker-internal-42");
    expect(text).not.toContain("organization-internal-42");
  });

  it("distinguishes an empty roster from an unavailable roster and announces success politely", () => {
    const emptyMarkup = renderToStaticMarkup(
      createElement(SessionsWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [{ ...session, speakerIds: [], speakerRoster: [] }],
        selectedSessionId: session.id,
        history: [],
        speakers: [],
        statusMessage: "Speaker assignments saved.",
        onSaveSpeakers: async () => undefined,
      }),
    );
    expect(emptyMarkup).toContain("No speakers are available in this event roster.");
    expect(emptyMarkup).not.toContain("Speaker roster unavailable");
    expect(emptyMarkup).toContain('role="status"');
    expect(emptyMarkup).toContain('aria-live="polite"');
    expect(emptyMarkup).toContain("Speaker assignments saved.");

    const unavailableMarkup = renderToStaticMarkup(
      createElement(SessionsWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [session],
        selectedSessionId: session.id,
        history: [],
        speakers: null,
        speakerError: "The roster request failed.",
        onRetrySpeakers: () => undefined,
        onSaveSpeakers: async () => undefined,
      }),
    );
    expect(unavailableMarkup).toContain("Speaker roster unavailable");
    expect(unavailableMarkup).toContain("Current assignments are preserved");
    expect(unavailableMarkup).toContain("Avery Kim");
    expect(unavailableMarkup).toContain("Primary");
    expect(unavailableMarkup).toContain("Retry speaker roster");
    expect(unavailableMarkup).not.toContain("No speakers are available in this event roster.");
  });
  it("isolates taxonomy failures, preserves canonical values, and offers affected retries", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionsWorkspaceView, {
        organizationId: "org-1",
        eventId: "event-1",
        sessions: [session],
        selectedSessionId: session.id,
        history: [],
        tracks,
        formats,
        trackError: "Track service unavailable.",
        onRetryTracks: () => undefined,
        onSave: async () => true,
      }),
    );

    expect(markup).toContain("Session tracks unavailable");
    expect(markup).toContain("Current track assignments are preserved");
    expect(markup).toContain("Retry tracks");
    expect(markup).not.toContain("Session formats unavailable");
    expect(markup).toContain('id="session-format-session-1"');
    expect(markup).toContain('id="session-track-session-1-track-1"');
    expect(markup).toContain('disabled=""');
  });
  it("marks unsaved or rebased content drafts dirty before approval", () => {
    expect(
      sessionContentDraftIsDirty(session, {
        title: "Revised worker pools",
        description: session.description,
        trackIds: session.trackIds,
        formatId: session.formatId ?? "",
        durationMinutes: session.durationMinutes,
        baseVersion: session.version,
      }),
    ).toBe(true);
    expect(
      sessionContentDraftIsDirty(session, {
        title: session.title,
        description: session.description,
        trackIds: session.trackIds,
        formatId: session.formatId ?? "",
        durationMinutes: session.durationMinutes,
        baseVersion: session.version - 1,
      }),
    ).toBe(true);
    const saved = { ...session, title: "Revised worker pools", version: session.version + 1 };
    expect(
      sessionContentDraftIsDirty(saved, {
        title: saved.title,
        description: saved.description,
        trackIds: saved.trackIds,
        formatId: saved.formatId ?? "",
        durationMinutes: saved.durationMinutes,
        baseVersion: saved.version,
      }),
    ).toBe(false);
  });
});
describe("sessions workspace navigation cache", () => {
  it("isolates normalized organization and canonical event scopes", () => {
    const firstKey = sessionsWorkspaceCacheKey(" org-1 ", " event-1 ");
    const secondKey = sessionsWorkspaceCacheKey("org-2", "event-1");

    expect(firstKey).toBe("sessions:workspace:org-1:event-1");
    expect(secondKey).not.toBe(firstKey);
    expect(sessionsWorkspaceCacheTags(" org-1 ", " event-1 ")).toEqual([
      "organization:org-1",
      "event:event-1",
      "sessions:event-1",
    ]);
  });

  it("loads one initial bundle on a cache miss", async () => {
    const api = sessionsApi();
    const cache = createNavigationDataCache();
    const key = sessionsWorkspaceCacheKey("org-1", "event-1");
    const tags = sessionsWorkspaceCacheTags("org-1", "event-1");

    await expect(loadSessionsWorkspaceBundle(api, cache, key, tags)).resolves.toEqual({
      sessions: [session],
      speakers,
      tracks,
      formats,
      trackError: null,
      formatError: null,
    });
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.listSpeakers).toHaveBeenCalledTimes(1);
  });

  it("hydrates cache hits without loading or issuing duplicate initial reads", async () => {
    const api = sessionsApi();
    const cache = createNavigationDataCache();
    const key = sessionsWorkspaceCacheKey("org-1", "event-1");
    const tags = sessionsWorkspaceCacheTags("org-1", "event-1");

    await loadSessionsWorkspaceBundle(api, cache, key, tags);
    await expect(loadSessionsWorkspaceBundle(api, cache, key, tags)).resolves.toEqual({
      sessions: [session],
      speakers,
      tracks,
      formats,
      trackError: null,
      formatError: null,
    });

    expect(cache.peek(key)).toEqual({
      sessions: [session],
      speakers,
      tracks,
      formats,
      trackError: null,
      formatError: null,
    });
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.listSpeakers).toHaveBeenCalledTimes(1);
  });

  it("bypasses the completed bundle on an explicit fresh reload", async () => {
    const api = sessionsApi();
    const cache = createNavigationDataCache();
    const key = sessionsWorkspaceCacheKey("org-1", "event-1");
    const tags = sessionsWorkspaceCacheTags("org-1", "event-1");

    await loadSessionsWorkspaceBundle(api, cache, key, tags);
    await loadSessionsWorkspaceBundle(api, cache, key, tags, undefined, true);

    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.listSpeakers).toHaveBeenCalledTimes(2);
  });
  it("isolates taxonomy failures, preserves prior values, and recovers on retry", async () => {
    const api = sessionsApi();
    const cache = createNavigationDataCache();
    const key = sessionsWorkspaceCacheKey("org-1", "event-1");
    const tags = sessionsWorkspaceCacheTags("org-1", "event-1");

    await loadSessionsWorkspaceBundle(api, cache, key, tags);
    vi.mocked(api.listTracks).mockRejectedValueOnce(new Error("Tracks are unavailable."));
    vi.mocked(api.listFormats).mockResolvedValueOnce([{ id: "format-2", name: "Workshop" }]);

    await expect(
      loadSessionsWorkspaceBundle(api, cache, key, tags, undefined, true),
    ).resolves.toEqual({
      sessions: [session],
      speakers,
      tracks,
      formats: [{ id: "format-2", name: "Workshop" }],
      trackError: "Tracks are unavailable.",
      formatError: null,
    });

    vi.mocked(api.listTracks).mockResolvedValueOnce([{ id: "track-2", name: "Operations" }]);
    await expect(
      loadSessionsWorkspaceBundle(api, cache, key, tags, undefined, true),
    ).resolves.toEqual({
      sessions: [session],
      speakers,
      tracks: [{ id: "track-2", name: "Operations" }],
      formats: [{ id: "format-1", name: "Talk" }],
      trackError: null,
      formatError: null,
    });
  });
  it("retries only the requested taxonomy when another workspace endpoint rejects", async () => {
    const api = sessionsApi();
    vi.mocked(api.list).mockRejectedValue(new Error("Sessions are unavailable."));
    vi.mocked(api.listTracks).mockResolvedValueOnce([{ id: "track-2", name: "Operations" }]);
    vi.mocked(api.listFormats).mockRejectedValueOnce(new Error("Formats are unavailable."));

    await expect(loadSessionTracks(api)).resolves.toEqual({
      options: [{ id: "track-2", name: "Operations" }],
      error: null,
    });
    await expect(loadSessionFormats(api)).resolves.toEqual({
      options: [],
      error: "Formats are unavailable.",
    });
    expect(api.list).not.toHaveBeenCalled();
    expect(api.listSpeakers).not.toHaveBeenCalled();
    expect(api.listTracks).toHaveBeenCalledTimes(1);
    expect(api.listFormats).toHaveBeenCalledTimes(1);
  });

  it("fences pending reads when event and sessions mutations invalidate the scope", async () => {
    const cache = createNavigationDataCache();
    const key = sessionsWorkspaceCacheKey("org-1", "event-1");
    const tags = sessionsWorkspaceCacheTags("org-1", "event-1");
    let resolveLoad!: (value: SessionsWorkspaceCacheBundle) => void;
    const pending = cache.read({
      key,
      tags,
      load: () =>
        new Promise<SessionsWorkspaceCacheBundle>((resolve) => {
          resolveLoad = resolve;
        }),
    });

    cache.invalidate(["event:event-1", "sessions:event-1"]);
    const bundle = {
      sessions: [session],
      speakers,
      tracks: [{ id: "track-1", name: "Platform" }],
      formats: [{ id: "format-1", name: "Talk" }],
      trackError: null,
      formatError: null,
    } as const;
    resolveLoad(bundle);
    await expect(pending).resolves.toEqual(bundle);
    expect(cache.peek(key)).toBeUndefined();
  });
});
