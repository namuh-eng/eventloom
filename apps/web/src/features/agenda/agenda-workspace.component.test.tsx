import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createNavigationDataCache } from "@/lib/navigation-data-cache";
import {
  AgendaBoard,
  type AgendaBusyOperation,
  AgendaSuggestionPanel,
  type AgendaSuggestionRunView,
  previewFromPlacementFailure,
} from "./agenda-workspace";
import {
  AGENDA_VIEW_MODES,
  type AgendaViewMode,
  agendaWorkspaceCacheKey,
  agendaWorkspaceCacheTags,
  agendaWorkspaceDataMatchesEvent,
  agendaWorkspaceScopeKey,
  canCommitAgendaAsyncCompletion,
  createCanonicalAgendaWorkspaceApi,
  deriveAgendaViewGroups,
  isAgendaAsyncScopeTokenCurrent,
  loadCanonicalAgendaWorkspace,
  loadCanonicalAgendaWorkspaceWithCache,
  serializeAgendaSuggestionOptions,
} from "./agenda-workspace-model";
import {
  placementConflictsFromSaveResult,
  RejectedPlacementConflicts,
  recoverPlacementFailure,
} from "./agenda-workspace-sections";
import { AgendaApiError, createAgendaApi } from "./api";
import type { AgendaPreview, AgendaWorkspaceData } from "./types";

const workspaceStyles = readFileSync(
  fileURLToPath(new URL("./agenda-workspace.module.css", import.meta.url)),
  "utf8",
);
const workspaceSource = readFileSync(
  fileURLToPath(new URL("./agenda-workspace.tsx", import.meta.url)),
  "utf8",
);

describe("agenda form track controls", () => {
  it("does not add a second circular marker beside each checkbox", () => {
    expect(workspaceStyles).not.toContain(".trackOptions label span::before");
  });
});

const data: AgendaWorkspaceData = {
  event: {
    id: "evt_open",
    name: "Open Systems Summit",
    timeZone: "America/Los_Angeles",
    startsOn: "2026-09-18",
    endsOn: "2026-09-19",
  },
  draft: {
    version: 7,
    updatedAt: "2026-08-08T12:00:00.000Z",
    updatedBy: "Avery Kim",
    entries: [
      {
        id: "entry_keynote",
        sessionId: "session_keynote",
        title: "Systems that stay understandable",
        format: "Keynote",
        speakerNames: ["Morgan Lee"],
        roomId: "room_main",
        roomName: "Main hall",
        trackIds: ["track_main"],
        trackNames: ["Main stage"],
        startsAtLocal: "2026-09-18T09:00",
        endsAtLocal: "2026-09-18T09:45",
      },
    ],
  },
  validation: null,
  rooms: [{ id: "room_main", name: "Main hall", capacity: 500 }],
  tracks: [{ id: "track_main", name: "Main stage", color: "#4f5ee8" }],
  acceptedSessionIds: ["session_keynote", "session_workshop"],
  unscheduledSessions: [
    {
      id: "session_workshop",
      title: "Practical review systems",
      format: "Workshop",
      durationMinutes: 60,
      speakerNames: ["Sam Rivera"],
      capacityRequired: 40,
      trackIds: ["track_main"],
      trackNames: ["Main stage"],
    },
  ],
  revisions: [
    {
      id: "revision_2",
      number: 2,
      publishedAt: "2026-08-07T12:00:00.000Z",
      publishedBy: "Avery Kim",
      sessionCount: 1,
      current: true,
    },
  ],
  currentPublishedRevision: {
    id: "revision_2",
    number: 2,
    publishedAt: "2026-08-07T12:00:00.000Z",
    publishedBy: "Avery Kim",
    sessionCount: 1,
    current: true,
  },
};
const baseEntry = data.draft.entries[0];
if (!baseEntry) throw new Error("Expected fixture entry.");

const preview: AgendaPreview = {
  draftVersion: 7,
  conflicts: [
    {
      id: "conflict_room",
      kind: "room",
      entryIds: ["entry_keynote"],
      message: "Main hall already has a session at this time.",
    },
  ],
  releaseConflicts: [],
  warnings: [],
  diff: { added: 0, changed: 1, removed: 0 },
  validatedAt: "2026-08-08T12:01:00.000Z",
};
const suggestionRun: AgendaSuggestionRunView = {
  id: "suggestion_1",
  version: 1,
  status: "pending",
  baseDraftVersion: 7,
  diff: {
    summary: "1 proposed agenda change: Move Systems that stay understandable",
    changes: [
      {
        id: "move:entry_keynote",
        kind: "move",
        entryId: "entry_keynote",
        sessionId: "session_keynote",
        summary: "Move Systems that stay understandable to Main hall at 10:00–10:45",
      },
    ],
  },
  candidateDiagnostics: {
    conflicts: [
      {
        id: "conflict_room",
        kind: "room",
        entryIds: ["entry_keynote"],
        message: "The proposed placement overlaps an existing session.",
      },
    ],
    warnings: [],
  },
  acceptedChangeIds: [],
};
const actionableSuggestionChange = suggestionRun.diff.changes[0];
if (!actionableSuggestionChange) throw new Error("Expected a suggestion change.");
const actionableSuggestionRun: AgendaSuggestionRunView = {
  ...suggestionRun,
  diff: {
    ...suggestionRun.diff,
    changes: [
      {
        ...actionableSuggestionChange,
        kind: "add",
        entryId: "entry_workshop",
        sessionId: "session_workshop",
        summary: "Add Practical review systems to Main hall at 10:00–11:00",
      },
    ],
  },
  candidateDiagnostics: { conflicts: [], warnings: [] },
};

const noEligibleSuggestionData: AgendaWorkspaceData = {
  ...data,
  unscheduledSessions: [],
};

const actions = {
  onSaveEntry: vi.fn(async () => undefined),
  onRemoveEntry: vi.fn(async () => undefined),
  onPreview: vi.fn(async () => undefined),
  onOverrideWarning: vi.fn(async () => undefined),
  onPublish: vi.fn(async () => undefined),
  onDismissError: vi.fn(),
};
const multiDayData: AgendaWorkspaceData = {
  ...data,
  event: {
    ...data.event,
    startsOn: "2026-09-18",
    endsOn: "2026-09-19",
    timeZone: "America/Los_Angeles",
  },
  draft: {
    ...data.draft,
    entries: [
      {
        ...baseEntry,
        id: "entry_keynote",
        roomId: "room_main",
        roomName: "Main hall",
        trackIds: ["track_main"],
        trackNames: ["Main stage"],
        startsAtLocal: "2026-09-18T09:00",
        endsAtLocal: "2026-09-18T09:45",
      },
      {
        ...baseEntry,
        id: "entry_earlier",
        title: "Earlier workshop",
        roomId: "room_breakout",
        roomName: "Breakout room",
        trackIds: ["track_audience"],
        trackNames: ["Audience"],
        startsAtLocal: "2026-09-18T08:00",
        endsAtLocal: "2026-09-18T08:45",
      },
      {
        ...baseEntry,
        id: "entry_later",
        title: "Later workshop",
        roomId: "room_main",
        roomName: "Main hall",
        trackIds: ["track_main", "track_audience"],
        trackNames: ["Main stage", "Audience"],
        startsAtLocal: "2026-09-19T11:00",
        endsAtLocal: "2026-09-19T12:00",
      },
    ],
  },
  rooms: [
    ...data.rooms,
    { id: "room_breakout", name: "Breakout room", capacity: 80 },
    { id: "room_empty", name: "Empty room", capacity: 20 },
  ],
  tracks: [
    ...data.tracks,
    { id: "track_audience", name: "Audience", color: "#16a085" },
    { id: "track_empty", name: "Empty track", color: "#999999" },
  ],
};
const emptyDayData: AgendaWorkspaceData = {
  ...multiDayData,
  event: {
    ...multiDayData.event,
    startsOn: "2026-09-18",
    endsOn: "2026-09-20",
  },
  draft: {
    ...multiDayData.draft,
    entries: multiDayData.draft.entries.filter((entry) => entry.id === "entry_later"),
  },
};

function renderBoard(
  boardData: AgendaWorkspaceData = data,
  initialView?: AgendaViewMode,
  boardPreview: AgendaPreview | null = preview,
  boardBusy = false,
  boardBusyOperation?: AgendaBusyOperation,
  boardError: string | null = null,
) {
  return renderToStaticMarkup(
    createElement(AgendaBoard, {
      ...actions,
      organizationId: "organization-1",
      data: boardData,
      preview: boardPreview,
      busy: boardBusy,
      ...(boardBusyOperation === undefined ? {} : { busyOperation: boardBusyOperation }),
      statusMessage: null,
      error: boardError,
      ...(initialView ? { initialView } : {}),
    }),
  );
}

describe("agenda organizer workspace", () => {
  it("invalidates stale, aborted, and unmounted deferred work", async () => {
    const scopeA = agendaWorkspaceScopeKey("organization-1", "event-a");
    const scopeB = agendaWorkspaceScopeKey("organization-1", "event-b");
    const token = { scopeKey: scopeA, generation: 1 };
    let currentScope = scopeA;
    let currentGeneration = 1;
    let commit: string | null = null;
    let resolveDeferred: ((value: string) => void) | undefined;
    const deferred = new Promise<string>((resolve) => {
      resolveDeferred = resolve;
    });
    const completion = deferred.then((value) => {
      if (canCommitAgendaAsyncCompletion(token, currentScope, currentGeneration, true)) {
        commit = value;
      }
    });

    currentScope = scopeB;
    currentGeneration += 1;
    resolveDeferred?.("event-a");
    await completion;

    expect(scopeA).not.toBe(scopeB);
    expect(commit).toBeNull();
    expect(isAgendaAsyncScopeTokenCurrent(token, currentScope, currentGeneration)).toBe(false);
    expect(canCommitAgendaAsyncCompletion(token, scopeA, 1, true)).toBe(true);
    expect(canCommitAgendaAsyncCompletion(token, scopeA, 1, false)).toBe(false);
    expect(canCommitAgendaAsyncCompletion(token, scopeA, 1, true, true)).toBe(false);
    expect(agendaWorkspaceDataMatchesEvent(data, data.event.id)).toBe(true);
    expect(agendaWorkspaceDataMatchesEvent(data, "event-b")).toBe(false);
  });
  it("uses the same-origin canonical API in fixture profile and does not synthesize an unavailable agenda", async () => {
    const previousRuntimeProfile = process.env.NEXT_PUBLIC_RUNTIME_PROFILE;
    process.env.NEXT_PUBLIC_RUNTIME_PROFILE = "fixture";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data }));

    try {
      const api = createCanonicalAgendaWorkspaceApi("organization-1");
      await expect(loadCanonicalAgendaWorkspace(api, data.event.id)).resolves.toEqual({
        api,
        data,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/organizations/organization-1/events/evt_open/agenda",
        expect.objectContaining({ credentials: "include", cache: "no-store" }),
      );

      const unavailableApi = createAgendaApi("", "organization-1", async () =>
        Response.json(
          { error: { code: "DEPENDENCY_UNAVAILABLE", message: "Agenda unavailable" } },
          { status: 503 },
        ),
      );
      await expect(
        loadCanonicalAgendaWorkspace(unavailableApi, data.event.id),
      ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
    } finally {
      fetchMock.mockRestore();
      if (previousRuntimeProfile === undefined) {
        delete process.env.NEXT_PUBLIC_RUNTIME_PROFILE;
      } else {
        process.env.NEXT_PUBLIC_RUNTIME_PROFILE = previousRuntimeProfile;
      }
    }
  });

  it("presents private draft context and structured conflicts", () => {
    const markup = renderToStaticMarkup(
      createElement(AgendaBoard, {
        ...actions,
        organizationId: "organization-1",
        data,
        preview,
        busy: false,
        statusMessage: null,
        error: null,
      }),
    );

    expect(markup).toContain(">Agenda<");
    expect(markup).toContain("Place accepted sessions into rooms and times");
    expect(markup).toContain("Schedule at a glance");
    expect(markup).toContain("Draft v7");
    expect(markup).toContain("private draft");
    expect(markup).toContain("1 hard conflict");
    expect(markup).toContain("Main hall already has a session at this time.");
    expect(markup).toContain("Hard conflict:");
  });

  it("retains exact-revision validation when the workspace reloads without a preview", () => {
    const validatedData = {
      ...data,
      validation: {
        draftVersion: data.draft.version,
        validatedAt: "2026-08-08T18:00:00.000Z",
      },
    } as AgendaWorkspaceData;
    const markup = renderToStaticMarkup(
      createElement(AgendaBoard, {
        ...actions,
        organizationId: "organization-1",
        data: validatedData,
        preview: null,
        busy: false,
        statusMessage: null,
        error: null,
      }),
    );

    expect(markup).toContain(">Validated<");
    expect(markup).not.toContain(">Needs validation<");
  });

  it("keeps rejected room and speaker conflicts visible without replacing saved draft data", () => {
    const participantConflict = {
      id: "conflict_participant",
      kind: "participant" as const,
      entryIds: ["entry_keynote", "entry_workshop"],
      message: 'Speaker "Morgan Lee" is scheduled in overlapping sessions.',
    };
    const authoritativeSavedPreview: AgendaPreview = {
      ...preview,
      conflicts: [],
      diff: { added: 0, changed: 0, removed: 0 },
    };
    const error = new AgendaApiError(
      "CONFLICT",
      "The agenda contains unresolved scheduling conflicts.",
      409,
      "trace-conflict",
      undefined,
      {
        evaluated: true,
        report: {
          conflicts: [...preview.conflicts, participantConflict],
          warnings: [
            {
              id: "candidate-warning",
              kind: "capacity",
              entryIds: ["entry_keynote"],
              message: "Rejected candidate warning",
              overridden: false,
            },
          ],
        },
        authoritativeSavedPreview,
      },
    );

    expect(previewFromPlacementFailure(error)).toEqual({
      ...authoritativeSavedPreview,
      conflicts: [...preview.conflicts, participantConflict],
    });
  });
  it("keeps a rejected placement's Priya and room conflicts inside the active editor", () => {
    const savedEntries = data.draft.entries;
    const candidateConflicts: AgendaPreview["conflicts"] = [
      {
        id: "conflict_room",
        kind: "room",
        entryIds: ["entry_keynote", "candidate_priya"],
        message: "Room Main hall overlaps Systems that stay understandable.",
      },
      {
        id: "conflict_participant",
        kind: "participant",
        entryIds: ["entry_keynote", "candidate_priya"],
        message: "Speaker Priya Shah overlaps Systems that stay understandable in Main hall.",
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(RejectedPlacementConflicts, { conflicts: candidateConflicts }),
    );

    expect(markup).toContain('aria-label="Rejected placement conflicts"');
    expect(markup).toContain("Placement was not saved");
    expect(markup).toContain("Priya Shah");
    expect(markup).toContain("Main hall");
    expect(markup).toContain("The private draft has not changed.");
    expect(data.draft.entries).toBe(savedEntries);
    expect(data.draft.entries).toEqual([baseEntry]);
  });
  it("does not reuse global preview conflicts for an unrelated failed placement", () => {
    const candidateConflicts: AgendaPreview["conflicts"] = [
      {
        id: "candidate-409",
        kind: "participant",
        entryIds: ["entry_keynote", "candidate_priya"],
        message: "Speaker Priya Shah overlaps in Main hall.",
      },
    ];

    expect(placementConflictsFromSaveResult({ saved: false, candidateConflicts })).toEqual(
      candidateConflicts,
    );
    expect(placementConflictsFromSaveResult(false)).toEqual([]);
    expect(placementConflictsFromSaveResult(undefined)).toEqual([]);
  });
  it("retains candidate conflict diagnostics when authoritative recovery fails", async () => {
    const candidateConflicts: AgendaPreview["conflicts"] = [
      {
        id: "candidate-409",
        kind: "participant",
        entryIds: ["entry_keynote", "candidate_priya"],
        message: "Speaker Priya Shah overlaps in Main hall.",
      },
    ];
    const error = new AgendaApiError("CONFLICT", "Placement rejected.", 409, undefined, undefined, {
      evaluated: true,
      report: { conflicts: candidateConflicts, warnings: [] },
      authoritativeSavedPreview: { ...preview, conflicts: [] },
    });
    let returnedConflicts: AgendaPreview["conflicts"] = [];
    let recoveryError: unknown;
    const recover = vi.fn(async () => {
      throw new Error("Authoritative agenda recovery failed.");
    });

    await recoverPlacementFailure(
      error,
      recover,
      (conflicts) => {
        returnedConflicts = conflicts;
      },
      (failure) => {
        recoveryError = failure;
      },
    );

    expect(recover).toHaveBeenCalledOnce();
    expect(returnedConflicts).toEqual(candidateConflicts);
    expect(recoveryError).toMatchObject({ message: "Authoritative agenda recovery failed." });
    expect(
      renderToStaticMarkup(
        createElement(RejectedPlacementConflicts, { conflicts: returnedConflicts }),
      ),
    ).toContain("Priya Shah");
  });

  it("links the agenda back to the organization-scoped event overview", () => {
    const markup = renderBoard();

    expect(markup).toContain('href="/admin/organizations/organization-1/events/evt_open"');
    expect(markup).not.toContain('href="/admin/events/evt_open"');
  });
  it("uses Next Link for private organizer destinations while retaining the skip anchor", () => {
    expect(workspaceSource).toContain('import Link from "next/link";');
    expect(workspaceSource).toContain("encodeURIComponent(data.event.id)");
    expect(workspaceSource).toContain("<Link href={settingsHref}>Rooms and tracks</Link>");
    expect(workspaceSource).toContain(
      "<Link href={settingsHref}>Create a room in Rooms and tracks settings</Link>",
    );
    expect(workspaceSource).toContain("<Link href={sessionsHref}>Open sessions</Link>");
    expect(workspaceSource).not.toContain("<a href={settingsHref}>");
    expect(workspaceSource).not.toContain("<a href={sessionsHref}>");
    expect(workspaceSource).toContain('<a className={styles.skipLink} href="#agenda-content">');
  });

  it("exposes accessible scheduling and disabled publication controls", () => {
    const markup = renderToStaticMarkup(
      createElement(AgendaBoard, {
        ...actions,
        organizationId: "organization-1",
        data,
        preview,
        busy: false,
        statusMessage: null,
        error: null,
      }),
    );

    expect(markup).toContain('href="#agenda-content"');
    expect(markup).toContain('aria-label="Agenda release center"');
    expect(markup).toContain("America/Los_Angeles");
    expect(markup).toContain("Release center");
    expect(markup).toContain("Draft v7");
    expect(markup).toContain("Suggestions");
    expect(markup).toContain("Optional");
    expect(markup).toContain("Publish agenda");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Publish agenda<\/button>/);
    expect(markup).toContain("Revision history");
    expect(markup).toContain('data-state="closed"');
    expect(markup).not.toContain("From draft to public agenda");
    expect(markup).not.toMatch(/class="[^"]*actionRail/u);
  });
  it("routes organizers to durable room settings before scheduling without a room", () => {
    const markup = renderBoard({ ...data, rooms: [] }, undefined, null);

    expect(markup).toContain('href="/admin/organizations/organization-1/events/evt_open/settings"');
    expect(markup).toContain("Scheduling is unavailable until you create a room.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Schedule session<\/button>/);
    expect(markup).not.toContain("Generate private suggestions");
  });
  it("keeps suggestion configuration collapsed until an organizer requests it", () => {
    const markup = renderToStaticMarkup(
      createElement(AgendaSuggestionPanel, {
        run: null,
        currentDraftVersion: data.draft.version,
        busy: false,
        busyOperation: null,
        eligibleUnscheduledCount: data.unscheduledSessions.length,
        selectedChangeIds: [],
        onSelectionChange: vi.fn(),
        onGenerate: vi.fn(async () => undefined),
        onRegenerate: undefined,
        onReject: undefined,
        onApply: undefined,
      }),
    );

    expect(markup).toContain("Optional advisory");
    expect(markup).toContain("Configure suggestions");
    expect(markup).toContain('data-state="closed"');
    expect(markup).not.toContain("Existing session times");
    expect(serializeAgendaSuggestionOptions("keep", false)).toEqual({
      ignoreExistingTimes: false,
      ignoreExistingRooms: false,
    });
    expect(serializeAgendaSuggestionOptions("move", false)).toEqual({
      ignoreExistingTimes: true,
      ignoreExistingRooms: false,
    });
    expect(serializeAgendaSuggestionOptions("keep", true)).toEqual({
      ignoreExistingTimes: false,
      ignoreExistingRooms: true,
    });
    expect(workspaceSource).toContain("Existing session times");
    expect(workspaceSource).toContain("Keep scheduled sessions fixed");
    expect(workspaceSource).toContain("serializeAgendaSuggestionOptions(");
    expect(workspaceStyles).toMatch(/\.scheduleOptionSelected/u);
    expect(workspaceStyles).toMatch(/input:focus-visible/u);
    expect(workspaceStyles).toMatch(/input:disabled/u);
    expect(workspaceStyles).toMatch(/aria-invalid/u);
  });
  it("renders the unavailable suggestion capability without a clickable generator", () => {
    const markup = renderToStaticMarkup(
      createElement(AgendaSuggestionPanel, {
        run: null,
        currentDraftVersion: data.draft.version,
        busy: false,
        busyOperation: null,
        eligibleUnscheduledCount: data.unscheduledSessions.length,
        selectedChangeIds: [],
        onSelectionChange: vi.fn(),
        onGenerate: undefined,
        onRegenerate: undefined,
        onReject: undefined,
        onApply: undefined,
      }),
    );

    expect(markup).toContain("Configure suggestions");
    expect(markup).not.toContain("Generate private suggestions");
    expect(workspaceSource).toContain(
      "Suggestion generation is unavailable until an approved provider is connected.",
    );
  });
  it("keeps organizer actions in the release center and preserves draft context after a failed request", () => {
    const markup = renderBoard(data, undefined, preview, true, "validate", "Validation failed.");
    expect(markup).toContain("Agenda request failed");
    expect(markup).toContain("authoritative private draft remains visible as Draft v7");
    expect(markup).toContain("Checking...");
    expect(markup).toContain("Publish agenda");
    expect(markup).not.toContain("Publishing...");
    expect(markup).toMatch(/releaseCenter/u);
    expect(workspaceStyles).toMatch(/\.releaseCenter[\s\S]*grid-template-columns/u);
    expect(workspaceStyles).not.toMatch(/\.actionRail[\s\S]*position:\s*sticky/u);
    expect(workspaceSource).toContain("endOperation(token)");
    expect(workspaceSource).toContain("expectedVersion: current.draft.version");
    expect(workspaceSource).toContain("acceptedChangeIds: changeIds");
    expect(workspaceSource).toContain("key={scopeKey}");
    expect(workspaceSource).toContain("agendaWorkspaceDataMatchesEvent(nextData, eventId)");
  });

  it("renders an honest empty state when no eligible sessions are available for suggestions", () => {
    const markup = renderToStaticMarkup(
      createElement(AgendaBoard, {
        ...actions,
        organizationId: "organization-1",
        data: noEligibleSuggestionData,
        preview: null,
        busy: false,
        statusMessage: null,
        error: null,
        onGenerateSuggestion: vi.fn(async () => undefined),
      }),
    );
    expect(markup).toContain("Configure suggestions");
    expect(markup).not.toContain("Generate private suggestions");
    expect(workspaceSource).toContain("No eligible unscheduled sessions");
    expect(workspaceSource).toContain(
      "No eligible unscheduled accepted sessions are currently available.",
    );
  });

  it("enables apply after a human selects a conflict-free proposal", () => {
    const changeId = actionableSuggestionRun.diff.changes[0]?.id;
    if (!changeId) throw new Error("Expected an actionable suggestion change.");
    const markup = renderToStaticMarkup(
      createElement(AgendaSuggestionPanel, {
        run: actionableSuggestionRun,
        currentDraftVersion: data.draft.version,
        busy: false,
        busyOperation: null,
        eligibleUnscheduledCount: data.unscheduledSessions.length,
        selectedChangeIds: [changeId],
        onSelectionChange: vi.fn(),
        onGenerate: vi.fn(async () => undefined),
        onRegenerate: vi.fn(async () => undefined),
        onReject: vi.fn(async () => undefined),
        onApply: vi.fn(async () => undefined),
      }),
    );
    expect(markup).toContain("Choose changes for human application");
    expect(markup).toContain('type="checkbox"');
    expect(markup).toMatch(/<button[^>]*>Apply selected changes<\/button>/u);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Apply selected changes<\/button>/u);
  });
  it("shows the accepted-session pool with explicit session metadata in the default day view", () => {
    const markup = renderBoard(multiDayData);
    expect(markup).toContain("Sessions to place");
    expect(markup).toContain("Accepted sessions waiting for a time and room.");
    expect(markup).toContain("Practical review systems");
    expect(markup).toContain("Workshop");
    expect(markup).toContain("Sam Rivera");
    expect(markup).toContain("Tracks: Main stage");
    expect(markup).toContain("Schedule session");
    expect(markup).toContain('aria-label="Schedule canvas"');
    expect(markup).not.toContain("Drag an unscheduled session here to open placement.");
  });

  it("keeps a hundred-session placement queue bounded above the timetable", () => {
    const unscheduledSessions = Array.from({ length: 100 }, (_, index) => ({
      id: `session-${index + 1}`,
      title: `Session ${String(index + 1).padStart(3, "0")}`,
      format: index % 2 === 0 ? "Workshop" : "Talk",
      durationMinutes: index % 3 === 0 ? 60 : 30,
      speakerNames: [`Speaker ${index + 1}`],
      capacityRequired: 40 + index,
      trackIds: [index % 2 === 0 ? "track-1" : "track-2"],
      trackNames: [index % 2 === 0 ? "Main stage" : "In practice"],
    }));

    const markup = renderBoard({
      ...data,
      unscheduledSessions,
    });

    expect(markup).toContain('data-queue-total="100"');
    expect(markup).toContain('data-queue-visible="6"');
    expect(markup.match(/data-queue-session=/gu)).toHaveLength(6);
    expect(markup).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Browse all/u);
  });

  it("renders a room-by-time grid as the primary planning surface", () => {
    const markup = renderBoard(multiDayData);

    expect(markup).toContain('data-agenda-region="planner"');
    expect(markup).toContain('data-agenda-order="1"');
    expect(markup).toContain('data-agenda-region="release"');
    expect(markup).toContain('data-agenda-order="2"');
    expect(markup).toContain('aria-label="Timetable by room and time"');
    expect(markup).toContain('data-agenda-grid="true"');
    expect(markup).toContain('data-room-id="room_main"');
    expect(markup).toContain('data-room-id="room_breakout"');
    expect(markup).toContain('data-slot-minute="480"');
    expect(markup).toContain('data-slot-minute="510"');
    expect(markup).toContain('data-agenda-drop-target="placement-queue"');
    expect(markup).toMatch(/data-entry-id="entry_keynote"[^>]*draggable="true"/u);
  });

  it("presents an empty placement queue as complete instead of a broken action", () => {
    const markup = renderBoard({ ...data, unscheduledSessions: [] });

    expect(markup).toContain('data-agenda-drop-target="placement-queue"');
    expect(markup).toContain('data-empty="true"');
    expect(markup).not.toContain("Choose time and room");
  });
  it("navigates every event day, including empty days, without crossing event boundaries", () => {
    const groups = deriveAgendaViewGroups(emptyDayData, "day");
    expect(groups.map((group) => group.id)).toEqual(["2026-09-18", "2026-09-19", "2026-09-20"]);
    expect(groups[0]?.entries).toEqual([]);
    expect(groups[2]?.entries).toEqual([]);

    const firstDayMarkup = renderBoard(emptyDayData);
    expect(firstDayMarkup).toContain('aria-label="Event day navigation"');
    expect(firstDayMarkup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Previous day"/u);
    expect(firstDayMarkup).toContain('aria-label="Next day, Saturday, September 19"');
    expect(firstDayMarkup).toContain("No sessions scheduled on this day.");

    const lastDayMarkup = renderBoard({
      ...emptyDayData,
      event: {
        ...emptyDayData.event,
        startsOn: "2026-09-20",
        endsOn: "2026-09-20",
      },
    });
    expect(lastDayMarkup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Previous day"/u);
    expect(lastDayMarkup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Next day"/u);
  });
  it("keeps advisory suggestions private and blocks applying hard-conflicting candidates", () => {
    const markup = renderToStaticMarkup(
      createElement(AgendaBoard, {
        ...actions,
        organizationId: "organization-1",
        data,
        preview,
        suggestionRun,
        onGenerateSuggestion: vi.fn(async () => undefined),
        onRegenerateSuggestion: vi.fn(async () => undefined),
        onRejectSuggestion: vi.fn(async () => undefined),
        onApplySuggestion: vi.fn(async () => undefined),
        busy: false,
        statusMessage: null,
        error: null,
      }),
    );

    expect(markup).toContain("Suggestions");
    expect(markup).toContain("never change this draft or publish anything");
    expect(markup).toContain("Choose changes for human application");
    expect(markup).toContain("hard blocker");
    expect(markup).toContain("They cannot be overridden by AI.");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply selected changes<\/button>/);
  });
  it("exposes all five accessible schedule tabs with Timetable selected by default", () => {
    const markup = renderBoard(multiDayData);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-labelledby="agenda-view-label"');
    for (const mode of AGENDA_VIEW_MODES) {
      expect(markup).toContain(`id="agenda-view-${mode}"`);
      expect(markup).toContain('role="tab"');
      expect(markup).toContain('aria-controls="agenda-view-panel"');
    }
    expect(markup).toMatch(/id="agenda-view-day"[^>]*aria-selected="true"/);
    expect(markup).toMatch(/id="agenda-view-list"[^>]*aria-selected="false"/);
    expect(markup).toContain("Schedule view");
  });

  it("derives chronological, timezone-local, and deterministic grouped views", () => {
    const list = deriveAgendaViewGroups(multiDayData, "list")[0];
    if (!list) throw new Error("Expected list view group.");
    expect(list.entries.map((entry) => entry.id)).toEqual([
      "entry_earlier",
      "entry_keynote",
      "entry_later",
    ]);

    const week = deriveAgendaViewGroups(multiDayData, "week");
    expect(week.map((group) => group.label)).toEqual([
      "Friday, September 18",
      "Saturday, September 19",
    ]);
    expect(week.map((group) => group.entries.map((entry) => entry.id))).toEqual([
      ["entry_earlier", "entry_keynote"],
      ["entry_later"],
    ]);

    const tracks = deriveAgendaViewGroups(multiDayData, "track");
    expect(tracks.map((group) => group.label)).toEqual(["Audience", "Empty track", "Main stage"]);
    expect(tracks[1]?.entries).toHaveLength(0);

    const rooms = deriveAgendaViewGroups(multiDayData, "room");
    expect(rooms.map((group) => group.label)).toEqual(["Breakout room", "Empty room", "Main hall"]);
    expect(rooms[1]?.entries).toHaveLength(0);
  });

  it("renders direct date navigation for every day in a multi-day event", () => {
    const markup = renderBoard(multiDayData, "day");

    expect(markup).toContain('aria-label="Choose an event day"');
    const selectorIndex = markup.indexOf('data-agenda-day-selector="true"');
    const queueIndex = markup.indexOf('data-agenda-drop-target="placement-queue"');
    expect(selectorIndex).toBeGreaterThan(-1);
    expect(queueIndex).toBeGreaterThan(selectorIndex);
    expect(markup).toContain("Day 1");
    expect(markup).toContain("Fri, Sep 18");
    expect(markup).toContain("2 sessions");
    expect(markup).toContain("Day 2");
    expect(markup).toContain("Sat, Sep 19");
    expect(markup).toContain("1 session");
  });

  it("does not expose raw audit actor identifiers in organizer-facing markup", () => {
    const rawActorId = "internal-actor-id-should-not-render";
    const rawTimestampToken = "2099-12-31T23:59:59.000Z";
    const markup = renderBoard({
      ...data,
      draft: {
        ...data.draft,
        updatedAt: rawTimestampToken,
        updatedBy: rawActorId,
      },
    });

    expect(markup).not.toContain(rawActorId);
    expect(markup).not.toContain(rawTimestampToken);
  });

  it("treats zero accepted sessions as an empty collection rather than completion", () => {
    const markup = renderBoard({
      ...data,
      acceptedSessionIds: [],
      draft: {
        ...data.draft,
        entries: [],
      },
      unscheduledSessions: [],
    });

    expect(markup).toContain('data-agenda-empty-state="no-accepted-sessions"');
    expect(markup).not.toContain('data-placement-complete="true"');
  });

  it("keeps conflict and edit controls available in every rendered mode without mutating the draft", () => {
    const before = JSON.stringify(multiDayData.draft.entries);
    for (const mode of AGENDA_VIEW_MODES) {
      const markup = renderBoard(multiDayData, mode);
      expect(markup).toContain("Edit");
      if (mode === "day") {
        expect(markup).toContain("Main hall already has a session at this time.");
      } else {
        expect(markup).toContain("Hard conflict:");
      }
      expect(markup).toContain(`id="agenda-view-${mode}"`);
      expect(markup).toMatch(new RegExp(`id="agenda-view-${mode}"[^>]*aria-selected="true"`));
    }
    expect(JSON.stringify(multiDayData.draft.entries)).toBe(before);
  });

  it("renders deterministic empty and unscheduled states for Track and Room views", () => {
    const trackMarkup = renderBoard(multiDayData, "track", null);
    expect(trackMarkup).toContain("Empty track");
    expect(trackMarkup).toContain("No sessions scheduled in this track.");
    expect(trackMarkup).toContain("Sessions to place");
    expect(trackMarkup).toContain("Practical review systems");

    const roomMarkup = renderBoard(multiDayData, "room", null);
    expect(roomMarkup).toContain("Empty room");
    expect(roomMarkup).toContain("No sessions scheduled in this room.");
    expect(roomMarkup).toContain("Sessions to place");
  });

  it("does not claim the schedule is complete when the event has zero accepted sessions", () => {
    const markup = renderBoard(
      {
        ...data,
        draft: { ...data.draft, entries: [] },
        acceptedSessionIds: [],
        unscheduledSessions: [],
      },
      undefined,
      null,
    );

    expect(markup).not.toContain("Schedule complete");
    expect(markup).not.toContain("All accepted sessions placed");
    expect(markup).not.toContain("All accepted sessions are placed");
    expect(markup).toContain('data-agenda-empty-state="no-accepted-sessions"');
    expect(markup).toContain("Open sessions");
  });

  it("keeps the completion state once at least one accepted session exists and all are placed", () => {
    const markup = renderBoard(
      { ...data, acceptedSessionIds: ["session_keynote"], unscheduledSessions: [] },
      undefined,
      null,
    );

    expect(markup).toContain('data-placement-complete="true"');
    expect(markup).toContain("Queue clear");
    expect(markup).not.toContain('data-agenda-empty-state="no-accepted-sessions"');
  });
});

describe("agenda workspace navigation cache", () => {
  it("normalizes the organization and canonical event in isolated cache scopes", () => {
    expect(agendaWorkspaceCacheKey(" org-1 ", " evt_open ")).toBe(
      "agenda:workspace:org-1:evt_open",
    );
    expect(agendaWorkspaceCacheKey("org-2", "evt_open")).not.toBe(
      agendaWorkspaceCacheKey("org-1", "evt_open"),
    );
    expect(agendaWorkspaceCacheTags(" org-1 ", " evt_open ")).toEqual([
      "organization:org-1",
      "event:evt_open",
      "agenda:evt_open",
    ]);
  });

  it("loads the aggregate workspace once on a cache miss", async () => {
    const fetcher = vi.fn(async () => Response.json({ data }));
    const api = createAgendaApi("", "org-1", fetcher);
    const cache = createNavigationDataCache();
    const key = agendaWorkspaceCacheKey("org-1", "evt_open");
    const tags = agendaWorkspaceCacheTags("org-1", "evt_open");

    await expect(
      loadCanonicalAgendaWorkspaceWithCache(api, "evt_open", cache, key, tags),
    ).resolves.toEqual({ api, data });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("hydrates the snapshot synchronously and does not duplicate an initial loader on a cache hit", async () => {
    const fetcher = vi.fn(async () => Response.json({ data }));
    const api = createAgendaApi("", "org-1", fetcher);
    const cache = createNavigationDataCache();
    const key = agendaWorkspaceCacheKey("org-1", "evt_open");
    const tags = agendaWorkspaceCacheTags("org-1", "evt_open");

    await loadCanonicalAgendaWorkspaceWithCache(api, "evt_open", cache, key, tags);
    await expect(
      loadCanonicalAgendaWorkspaceWithCache(api, "evt_open", cache, key, tags),
    ).resolves.toEqual({ api, data });

    expect(cache.peek(key)).toEqual(data);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(workspaceSource).toContain(
      "const cachedData = cache?.peek<AgendaWorkspaceData>(workspaceCacheKey)",
    );
    expect(workspaceSource).toContain(
      "const [snapshot, setSnapshot] = useState<ScopedAgendaSnapshot | null>(() => initialSnapshot);",
    );
  });

  it("uses a fresh cache read for explicit retry", async () => {
    const fetcher = vi.fn(async () => Response.json({ data }));
    const api = createAgendaApi("", "org-1", fetcher);
    const cache = createNavigationDataCache();
    const key = agendaWorkspaceCacheKey("org-1", "evt_open");
    const tags = agendaWorkspaceCacheTags("org-1", "evt_open");

    await loadCanonicalAgendaWorkspaceWithCache(api, "evt_open", cache, key, tags);
    await loadCanonicalAgendaWorkspaceWithCache(api, "evt_open", cache, key, tags, undefined, true);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(workspaceSource).toContain("load(undefined, undefined, true)");
  });

  it("fences pending reads when event and agenda mutations invalidate the scope", async () => {
    const cache = createNavigationDataCache();
    const key = agendaWorkspaceCacheKey("org-1", "evt_open");
    const tags = agendaWorkspaceCacheTags("org-1", "evt_open");
    let resolveLoad!: (value: AgendaWorkspaceData) => void;
    const pending = cache.read({
      key,
      tags,
      load: () =>
        new Promise<AgendaWorkspaceData>((resolve) => {
          resolveLoad = resolve;
        }),
    });

    cache.invalidate(["event:evt_open", "agenda:evt_open"]);
    resolveLoad(data);
    await expect(pending).resolves.toEqual(data);
    expect(cache.peek(key)).toBeUndefined();
    expect(workspaceSource).toContain("cache?.invalidate(workspaceInvalidationTags)");
    expect(workspaceSource).toContain(
      "cache?.write(workspaceCacheKey, nextData, workspaceCacheTags)",
    );
  });
});
