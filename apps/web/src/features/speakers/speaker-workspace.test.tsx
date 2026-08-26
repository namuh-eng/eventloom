import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createSpeakerApi,
  ORGANIZER_HEADSHOT_ACCEPTED_TYPES,
  ORGANIZER_HEADSHOT_MAX_BYTES,
  type SpeakerApi,
  SpeakerApiError,
  type SpeakerAsset,
  type SpeakerRecord,
  type SpeakerRosterEnvelope,
  type SpeakerTask,
} from "./api";
import { SpeakerAssetDownload, SpeakerAssetMetadata, SpeakerHeadshot } from "./speaker-assets";
import {
  duplicateEmailConflicts,
  speakerErrorDiagnostic,
  speakerMutationOutcomeUnknown,
  speakerProgressFor,
  speakerSecondaryLoadKey,
} from "./speaker-data-logic";
import {
  acceptedSpeakerSessions,
  organizerHeadshotPreviewKey,
  organizerHeadshotPreviewPath,
  organizerHeadshotPreviewRequestKey,
  organizerHeadshotSessionId,
  validateOrganizerHeadshotFile,
} from "./speaker-headshot-logic";
import { SpeakerInvitationControls } from "./speaker-invitations";
import {
  filterSpeakerRoster,
  filterSpeakersByAttention,
  type SpeakerAttentionFilter,
  speakerProgressMatches,
} from "./speaker-roster-logic";
import {
  createSpeakerTaskAssignment,
  retainInvitationHistory,
  speakerInvitationReady,
  speakerOnboardingTaskDefinitions,
  speakerTaskAssigneeLabels,
  taskStatusTone,
  travelLogisticsFor,
  validateSpeakerTaskAssignment,
} from "./speaker-task-model";
import { SpeakerWorkspace } from "./speaker-workspace";
import {
  parseReminderOffsetDraft,
  SpeakerReminderOffsetEditor,
} from "./speaker-workspace-sections";
import { SPEAKER_WELCOME_EMAIL_STARTER } from "./speaker-workspace-types";

const speaker: SpeakerRecord = {
  eventId: "event-1",
  participantId: "participant-1",
  displayName: "Priya Raman",
  email: "priya@example.test",
  jobTitle: "Principal Engineer",
  company: "Latticework Systems",
  biography: "Builds reliable developer platforms.",
  socialLinks: { twitter: "https://x.com/priya", linkedin: "https://linkedin.com/in/priya" },
  headshotAssetId: null,
  status: "confirmed",
  sessions: [
    { sessionId: "session-1", title: "Incremental builds", status: "accepted", version: 1 },
  ],
  taskSummary: { total: 3, completed: 2, overdue: 0 },
  assets: [],
  version: 3,
  updatedAt: "2026-08-09T00:00:00.000Z",
};

const roster: SpeakerRosterEnvelope = {
  organizationId: "org-1",
  eventId: "event-1",
  speakers: [speaker],
};
const readyAsset: SpeakerAsset = {
  assetId: "asset-ready",
  fileName: "slides.pdf",
  contentType: "application/pdf",
  byteSize: 1_024,
  status: "ready",
  uploadedAt: "2026-08-09T00:00:00.000Z",
  downloadUrl: null,
};
const headshotAsset: SpeakerAsset = {
  assetId: "asset-headshot",
  fileName: "priya.webp",
  contentType: "image/webp",
  byteSize: 2_048,
  status: "ready",
  uploadedAt: "2026-08-09T00:00:00.000Z",
  downloadUrl: null,
};

const pendingAsset: SpeakerAsset = {
  ...readyAsset,
  assetId: "asset-pending",
  fileName: "draft.pdf",
  status: "pending",
};

const task = {
  taskId: "task-1",
  definitionId: "task-1",
  participantId: "participant-1",
  title: "Confirm participation",
  description: "General speaker onboarding task.",
  type: "general" as const,
  dueAt: "2027-04-01",
  status: "pending" as const,
  completedAt: null,
  sessionId: null,
  latestAssetId: null,
  version: 2,
};
describe("organizer reminder offset controls", () => {
  it("parses an empty schedule and canonicalizes valid offsets", () => {
    expect(parseReminderOffsetDraft(" ")).toEqual({ ok: true, offsets: [] });
    expect(parseReminderOffsetDraft("10080, 0, 1440")).toEqual({
      ok: true,
      offsets: [0, 1_440, 10_080],
    });
  });

  it.each(["60, 60", "-1", "1", "30", "1.5", "not-a-number", "9007199254740992"])(
    "rejects an invalid reminder offset draft: %s",
    (draft) => {
      expect(parseReminderOffsetDraft(draft)).toEqual({
        ok: false,
        message: expect.any(String),
      });
    },
  );

  it("renders an accessible reminder schedule editor without server diagnostics", () => {
    const markup = renderToStaticMarkup(
      createElement(SpeakerReminderOffsetEditor, {
        task: { ...task, type: "file_request", status: "in_progress" },
        item: {
          taskId: task.taskId,
          participantId: task.participantId,
          title: task.title,
          dueAt: task.dueAt,
          reminderOffsetsMinutes: [1_440],
          eligible: false,
          reason: "outside_window",
        },
        onSave: async () => ({
          organizationId: "org-1",
          eventId: "event-1",
          taskId: task.taskId,
          reminderOffsetsMinutes: [1_440],
          version: 3,
          updatedAt: "2026-08-10T00:00:00.000Z",
        }),
      }),
    );

    expect(markup).toContain(`aria-label="Reminder offsets in minutes for ${task.title}"`);
    expect(markup).toContain("Save reminder schedule");
    expect(markup).toContain(
      "Use whole-hour increments in minutes. Clear the field to disable scheduled reminders.",
    );
    expect(markup).not.toContain("outside_window");
  });
});

describe("organizer headshot preview stability", () => {
  it("keeps the secure preview key stable across roster and detail refreshes", () => {
    const initial = organizerHeadshotPreviewKey("participant-1", "asset-headshot", headshotAsset);
    const refreshed = organizerHeadshotPreviewKey("participant-1", "asset-headshot", {
      ...headshotAsset,
    });

    expect(initial).not.toBeNull();
    expect(refreshed).toBe(initial);
    expect(
      organizerHeadshotPreviewKey("participant-1", "asset-headshot", {
        ...headshotAsset,
        contentType: " IMAGE/WEBP ",
      }),
    ).toBe(initial);
  });

  it("keeps an in-flight preview request subscribed across equivalent asset refreshes", () => {
    const initial = organizerHeadshotPreviewRequestKey(
      0,
      0,
      "participant-1",
      "asset-headshot",
      headshotAsset,
    );
    const refreshed = organizerHeadshotPreviewRequestKey(0, 0, "participant-1", "asset-headshot", {
      ...headshotAsset,
    });

    expect(refreshed).toBe(initial);
    expect(
      organizerHeadshotPreviewRequestKey(0, 1, "participant-1", "asset-headshot", headshotAsset),
    ).not.toBe(initial);
    expect(
      organizerHeadshotPreviewRequestKey(1, 0, "participant-1", "asset-headshot", headshotAsset),
    ).not.toBe(initial);
  });

  it("changes the preview key only when the headshot identity or readiness changes", () => {
    const initial = organizerHeadshotPreviewKey("participant-1", "asset-headshot", headshotAsset);

    expect(
      organizerHeadshotPreviewKey("participant-1", "asset-headshot-v2", headshotAsset),
    ).not.toBe(initial);
    expect(
      organizerHeadshotPreviewKey("participant-1", "asset-headshot", {
        ...headshotAsset,
        status: "pending",
      }),
    ).not.toBe(initial);
    expect(
      organizerHeadshotPreviewKey("participant-1", "asset-headshot", {
        ...headshotAsset,
        contentType: "image/png",
      }),
    ).not.toBe(initial);
    expect(organizerHeadshotPreviewKey("participant-2", "asset-headshot", headshotAsset)).not.toBe(
      initial,
    );
    expect(organizerHeadshotPreviewKey("participant-1", "asset-headshot", null)).not.toBe(initial);
  });

  it("drops the preview key when no speaker or headshot is selected", () => {
    expect(organizerHeadshotPreviewKey(null, "asset-headshot", headshotAsset)).toBeNull();
    expect(organizerHeadshotPreviewKey("participant-1", null, headshotAsset)).toBeNull();
    expect(organizerHeadshotPreviewKey("participant-1", undefined, headshotAsset)).toBeNull();
    expect(organizerHeadshotPreviewKey(undefined, "asset-headshot", headshotAsset)).toBeNull();
  });
});

describe("organizer headshot session scope", () => {
  it("automatically uses the sole accepted session and excludes other statuses", () => {
    const sessions = [
      ...speaker.sessions,
      { sessionId: "session-declined", title: "Declined", status: "declined", version: 2 },
    ];
    expect(acceptedSpeakerSessions(sessions)).toEqual([speaker.sessions[0]]);
    expect(organizerHeadshotSessionId(sessions, null)).toBe("session-1");
  });

  it("requires an explicit eligible session when multiple accepted sessions exist", () => {
    const sessions = [
      ...speaker.sessions,
      { sessionId: "session-2", title: "Second session", status: "Accepted", version: 3 },
    ];
    expect(organizerHeadshotSessionId(sessions, null)).toBeNull();
    expect(organizerHeadshotSessionId(sessions, "session-2")).toBe("session-2");
    expect(organizerHeadshotSessionId(sessions, "session-declined")).toBeNull();
  });
});

describe("speaker API adapter", () => {
  it("qualifies roster, multipart preview, and canonical commit requests by organization and event", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      const path = String(input);
      if (path.endsWith("/imports/preview")) {
        return new Response(
          JSON.stringify({
            data: {
              previewId: "preview-1",
              sourceDigest: "sha256:source-1",
              validRows: [],
              invalidRows: [],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            ...roster,
            organizationId: "org/1",
            eventId: "event/1",
            speakers: roster.speakers.map((record) => ({ ...record, eventId: "event/1" })),
          },
        }),
        { status: 200 },
      );
    };
    const api = createSpeakerApi("https://api.example.test/", "org/1", "event/1", fetcher);

    await api.list();
    await api.previewImport(
      new File(["displayName,email\nPriya,priya@example.test"], "speakers.csv", {
        type: "text/csv",
      }),
    );
    await api.commitImport({
      previewId: "preview-1",
      sourceDigest: "sha256:source-1",
      idempotencyKey: "import-once",
    });

    expect(String(calls[0]?.input)).toBe(
      "https://api.example.test/api/admin/organizations/org%2F1/events/event%2F1/speakers",
    );
    expect(String(calls[1]?.input)).toContain("/speakers/imports/preview");
    expect(calls[1]?.init?.body).toBeInstanceOf(FormData);
    expect(String(calls[2]?.input)).toContain("/speakers/imports");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      previewId: "preview-1",
      sourceDigest: "sha256:source-1",
      idempotencyKey: "import-once",
    });
    expect(calls[0]?.init).toMatchObject({ credentials: "include", cache: "no-store" });
  });
  it("rejects legacy client-owned import previews without a durable artifact", async () => {
    const api = createSpeakerApi("", "org-1", "event-1", async () =>
      Response.json({ data: { validRows: [], invalidRows: [] } }),
    );

    await expect(
      api.previewImport(new File(["displayName,email"], "speakers.csv", { type: "text/csv" })),
    ).rejects.toThrow("durable preview artifact");
  });

  it("keeps only validated error diagnostics from speaker responses", async () => {
    const api = createSpeakerApi("", "org-1", "event-1", async () =>
      Response.json(
        {
          error: {
            code: "<script>",
            message: "Import failed.",
            traceId: "not-a-trace-id",
          },
        },
        { status: 503 },
      ),
    );

    await expect(api.list()).rejects.toMatchObject({
      code: "SPEAKER_REQUEST_FAILED",
      status: 503,
      traceId: undefined,
    });
  });

  it("keeps default speaker requests on the same-origin API gateway", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createSpeakerApi("", "org-1", "event-1", async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({ data: roster }), { status: 200 });
    });

    await expect(api.list()).resolves.toEqual(roster);

    expect(String(calls[0]?.input)).toBe("/api/admin/organizations/org-1/events/event-1/speakers");
    expect(calls[0]?.init).toMatchObject({ credentials: "include", cache: "no-store" });
  });
  it("replaces and relinks a headshot entirely through same-origin API paths", async () => {
    const pendingAsset = {
      id: "asset-headshot-v2",
      eventId: "event-1",
      participantId: "participant-1",
      kind: "headshot" as const,
      fileName: "speaker.png",
      contentType: "image/png",
      sizeBytes: 2,
      state: "pending_upload" as const,
      createdAt: "2026-08-10T00:00:00.000Z",
    };
    const finalizedAsset = { ...pendingAsset, state: "ready" as const };
    const profile = {
      id: "profile-1",
      eventId: "event-1",
      participantId: "participant-1",
      displayName: "Priya Raman",
      biography: "Build systems engineer.",
      headshotAssetId: finalizedAsset.id,
      version: 4,
      updatedAt: "2026-08-10T00:01:00.000Z",
    };
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createSpeakerApi("", "org-1", "event-1", async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      switch (calls.length) {
        case 1:
          return Response.json({
            data: {
              asset: pendingAsset,
              grant: {
                method: "PUT",
                url: "/api/speaker/assets/capabilities/upload/asset-headshot-v2/opaque-token",
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
    });
    if (api.replaceHeadshot === undefined)
      throw new Error("Expected organizer headshot replacement.");

    const replacement = await api.replaceHeadshot({
      participantId: "participant-1",
      file: new File(["ok"], "speaker.png", { type: "image/png" }),
      expectedVersion: 3,
    });

    expect(replacement).toEqual({ asset: finalizedAsset, profile });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      participantId: "participant-1",
      kind: "headshot",
    });
    expect(calls.map(({ input }) => String(input))).toEqual([
      "/api/speaker/events/event-1/organizer/profiles/participant-1/headshot",
      "/api/speaker/assets/capabilities/upload/asset-headshot-v2/opaque-token",
      "/api/speaker/events/event-1/organizer/assets/asset-headshot-v2/finalize",
      "/api/speaker/events/event-1/organizer/profiles/participant-1",
    ]);
    expect(calls[1]?.init).toMatchObject({ method: "PUT", credentials: "omit" });
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({
      headshotAssetId: "asset-headshot-v2",
      expectedVersion: 3,
    });
  });
  it("rejects provider upload URLs outside the same-origin API gateway", async () => {
    const api = createSpeakerApi("", "org-1", "event-1", async () =>
      Response.json({
        data: {
          asset: {
            id: "asset-headshot-v2",
            eventId: "event-1",
            participantId: "participant-1",
            kind: "headshot",
            fileName: "speaker.png",
            contentType: "image/png",
            sizeBytes: 2,
            state: "pending_upload",
            createdAt: "2026-08-10T00:00:00.000Z",
          },
          grant: {
            method: "PUT",
            url: "https://uploads.example.test/headshot",
            headers: { "content-type": "image/png" },
            expiresAt: "2026-08-10T00:05:00.000Z",
          },
        },
      }),
    );
    if (api.replaceHeadshot === undefined)
      throw new Error("Expected organizer headshot replacement.");

    await expect(
      api.replaceHeadshot({
        participantId: "participant-1",
        file: new File(["ok"], "speaker.png", { type: "image/png" }),
        expectedVersion: 3,
      }),
    ).rejects.toThrow("same-origin /api/* path");
  });
  it("posts an idempotent manual speaker with status and logistics metadata", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createSpeakerApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async (input, init) => {
        calls.push({ input, ...(init === undefined ? {} : { init }) });
        return new Response(JSON.stringify({ data: roster }), { status: 201 });
      },
    );

    await api.create({
      idempotencyKey: "manual-speaker-once",
      displayName: "Priya Raman",
      email: "priya@example.test",
      jobTitle: "Principal Engineer",
      company: "Latticework Systems",
      biography: "Bio",
      socialLinks: {},
      travelLogistics: {
        travelRequired: true,
        arrivalAt: "2027-03-30",
        departureAt: "2027-04-03",
        accommodation: "Conference hotel",
      },
      status: "confirmed",
    });

    expect(String(calls[0]?.input)).toBe(
      "https://api.example.test/api/admin/organizations/org-1/events/event-1/speakers",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      idempotencyKey: "manual-speaker-once",
      displayName: "Priya Raman",
      status: "confirmed",
      travelLogistics: {
        travelRequired: true,
        arrivalAt: "2027-03-30",
        departureAt: "2027-04-03",
        accommodation: "Conference hotel",
      },
    });
  });
  it("posts the canonical organizer download route and returns its grant URL", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createSpeakerApi(
      "https://api.example.test",
      "org/1",
      "event/1",
      async (input, init) => {
        calls.push({ input, ...(init === undefined ? {} : { init }) });
        return new Response(
          JSON.stringify({
            data: {
              url: "https://downloads.example.test/grant",
              expiresAt: "2026-08-10T12:02:00.000Z",
            },
          }),
          { status: 200 },
        );
      },
    );

    const grant = await api.getDownloadGrant("asset/1");

    expect(grant.url).toBe("https://downloads.example.test/grant");
    expect(String(calls[0]?.input)).toBe(
      "https://api.example.test/api/speaker/events/event%2F1/organizer/assets/asset%2F1/download",
    );
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
    expect(calls[0]?.init?.body).toBeUndefined();
  });
  it("redacts list-returned asset grants until an organizer explicitly requests one", async () => {
    const api = createSpeakerApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                ...readyAsset,
                downloadUrl: "https://downloads.example.test/legacy-grant",
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(api.getAssets("participant-1")).resolves.toEqual([
      { ...readyAsset, downloadUrl: null },
    ]);
  });

  it("sends versioned profile edits, multi-speaker tasks, progress reads, and invitations", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      const path = String(input);
      if (path.includes("/speaker-tasks")) {
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({
              data: {
                organizationId: "org-1",
                eventId: "event-1",
                speakerProfileId: "",
                tasks: [
                  task,
                  {
                    ...task,
                    taskId: "task-1:participant-2",
                    participantId: "participant-2",
                  },
                ],
              },
            }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              organizationId: "org-1",
              eventId: "event-1",
              speakerProfileId: "",
              tasks: [task],
            },
          }),
          { status: 200 },
        );
      }
      if (path.endsWith("/invitations/preview")) {
        return new Response(
          JSON.stringify({
            data: [
              { participantId: "participant-1", recipientEmail: speaker.email, state: "ready" },
            ],
          }),
          { status: 200 },
        );
      }
      if (path.endsWith("/invitations/send")) {
        return new Response(
          JSON.stringify({
            data: {
              organizationId: "org-1",
              eventId: "event-1",
              idempotencyKey: "invite-once",
              status: "queued",
              duplicate: false,
              recipients: [
                {
                  participantId: "participant-1",
                  recipientEmail: speaker.email,
                  status: "queued",
                  receiptId: null,
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (path.endsWith("/speakers/participant-1")) {
        return new Response(JSON.stringify({ data: roster }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: speaker }), { status: 200 });
    };
    const api = createSpeakerApi("https://api.example.test", "org-1", "event-1", fetcher);

    await api.update("participant-1", {
      expectedVersion: 3,
      displayName: speaker.displayName,
      email: speaker.email,
      jobTitle: speaker.jobTitle ?? "",
      company: speaker.company ?? "",
      biography: speaker.biography,
      socialLinks: speaker.socialLinks,
      travelLogistics: {
        travelRequired: true,
        arrivalAt: "2027-03-30",
        departureAt: "2027-04-03",
        accommodation: "Conference hotel",
        dietaryRequirements: "Vegan",
        accessibilityNeeds: "Step-free access",
        travelNotes: "Arrives after 18:00",
      },
      status: "confirmed",
    });
    await api.assignTasks({
      title: task.title,
      description: task.description,
      dueAt: task.dueAt ?? "",
      participantIds: ["participant-1", "participant-2"],
    });
    await api.listTasks();
    await api.previewInvitations({ participantIds: ["participant-1"] });
    await api.sendInvitations({
      participantIds: ["participant-1"],
      templateId: "speaker-welcome",
      idempotencyKey: "invite-once",
    });

    expect(String(calls[0]?.input)).toContain("/speakers/participant-1");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      expectedVersion: 3,
      jobTitle: "Principal Engineer",
      travelLogistics: {
        travelRequired: true,
        arrivalAt: "2027-03-30",
        departureAt: "2027-04-03",
        accommodation: "Conference hotel",
      },
    });
    expect(String(calls[1]?.input)).toContain("/speaker-tasks");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      title: task.title,
      description: task.description,
      dueAt: task.dueAt,
      assignments: [
        { participantId: "participant-1", submissionId: null },
        { participantId: "participant-2", submissionId: null },
      ],
    });
    expect(String(calls[2]?.input)).toBe(
      "https://api.example.test/api/admin/organizations/org-1/events/event-1/speaker-tasks",
    );
    expect(String(calls[3]?.input)).toContain("/speakers/invitations/preview");
    expect(JSON.parse(String(calls[4]?.init?.body))).toMatchObject({
      templateId: "speaker-welcome",
      idempotencyKey: "invite-once",
    });
  });
  it("updates one task reminder schedule through the canonical organizer command", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const api = createSpeakerApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async (input, init) => {
        calls.push({ input, ...(init === undefined ? {} : { init }) });
        return Response.json({
          data: {
            organizationId: "org-1",
            eventId: "event-1",
            taskId: "task-1",
            reminderOffsetsMinutes: [0, 1_440],
            version: 3,
            updatedAt: "2026-08-10T00:00:00.000Z",
          },
        });
      },
    );

    await expect(
      api.updateTaskReminderOffsets({
        taskId: "task-1",
        expectedVersion: 2,
        reminderOffsetsMinutes: [1_440, 0],
      }),
    ).resolves.toEqual({
      organizationId: "org-1",
      eventId: "event-1",
      taskId: "task-1",
      reminderOffsetsMinutes: [0, 1_440],
      version: 3,
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(String(calls[0]?.input)).toBe(
      "https://api.example.test/api/admin/organizations/org-1/events/event-1/speaker-tasks/task-1/reminder-offsets",
    );
    expect(calls[0]?.init).toMatchObject({ method: "PUT", credentials: "include" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedVersion: 2,
      reminderOffsetsMinutes: [1_440, 0],
    });
  });

  it("loads multi-speaker progress with one batch task request and groups tasks in roster order", async () => {
    const multiSpeakerRoster: SpeakerRosterEnvelope = {
      ...roster,
      speakers: [
        speaker,
        {
          ...speaker,
          participantId: "participant-2",
          displayName: "Marcus Chen",
          email: "marcus@example.test",
        },
        {
          ...speaker,
          participantId: "participant-3",
          displayName: "Amina Yusuf",
          email: "amina@example.test",
        },
      ],
    };
    const tasks: SpeakerTask[] = [
      task,
      { ...task, taskId: "task-2", participantId: "participant-2" },
      { ...task, taskId: "task-3", participantId: "participant-3" },
    ];
    const requests: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path.endsWith("/speakers")) {
        return new Response(JSON.stringify({ data: multiSpeakerRoster }), { status: 200 });
      }
      if (path.endsWith("/speaker-tasks")) {
        return new Response(
          JSON.stringify({
            data: {
              organizationId: "org-1",
              eventId: "event-1",
              speakerProfileId: "",
              tasks,
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const api = createSpeakerApi("https://api.example.test", "org-1", "event-1", fetcher);
    const loadedRoster = await api.list();
    const progress = await speakerProgressFor(
      api,
      loadedRoster.speakers,
      loadedRoster.organizationId,
      loadedRoster.eventId,
    );

    expect(requests.filter((path) => path.endsWith("/speakers"))).toHaveLength(1);
    expect(requests.filter((path) => path.endsWith("/speaker-tasks"))).toHaveLength(1);
    expect(requests[1]).toBe(
      "https://api.example.test/api/admin/organizations/org-1/events/event-1/speaker-tasks",
    );
    expect(requests[1]).not.toContain("participantId=");
    expect(
      progress.rows.map((row) => ({
        participantId: row.participantId,
        taskIds: row.tasks.map((candidate) => candidate.taskId),
      })),
    ).toEqual([
      { participantId: "participant-1", taskIds: ["task-1"] },
      { participantId: "participant-2", taskIds: ["task-2"] },
      { participantId: "participant-3", taskIds: ["task-3"] },
    ]);
  });

  it("rejects invitation receipts without recipient delivery results", async () => {
    const api = createSpeakerApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async () =>
        new Response(
          JSON.stringify({
            data: {
              organizationId: "org-1",
              eventId: "event-1",
              idempotencyKey: "invite-invalid",
              status: "queued",
              duplicate: false,
            },
          }),
          { status: 200 },
        ),
    );

    await expect(
      api.sendInvitations({
        participantIds: ["participant-1"],
        templateId: "speaker-welcome",
        idempotencyKey: "invite-invalid",
      }),
    ).rejects.toThrow("The invitation result is invalid.");
  });
  it("surfaces server conflicts and rejects missing tenant scope", async () => {
    const api = createSpeakerApi(
      "https://api.example.test",
      "org-1",
      "event-1",
      async () =>
        new Response(JSON.stringify({ error: { code: "CONFLICT", message: "stale profile" } }), {
          status: 409,
        }),
    );
    await expect(
      api.update("participant-1", {
        expectedVersion: 3,
        displayName: "Priya Raman",
        email: "priya@example.test",
        jobTitle: "Principal Engineer",
        company: "Latticework Systems",
        biography: "Bio",
        socialLinks: {},
        status: "confirmed",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(() => createSpeakerApi("https://api.example.test", " ", "event-1")).toThrow(
      "organization ID is required",
    );
    expect(() => createSpeakerApi("https://api.example.test", "org-1", " ")).toThrow(
      "event ID is required",
    );
  });
});

describe("speaker workspace contracts", () => {
  it("classifies ambiguous failures and exposes only safe diagnostics", () => {
    const traceId = "123e4567-e89b-42d3-a456-426614174000";
    const unavailable = new SpeakerApiError("SERVICE_UNAVAILABLE", "Unavailable", 503, traceId);
    const validation = new SpeakerApiError("VALIDATION_ERROR", "Invalid", 400);
    const unsafe = new SpeakerApiError("<script>", "Invalid", 999, "trace-1");

    expect(speakerMutationOutcomeUnknown(unavailable)).toBe(true);
    expect(speakerMutationOutcomeUnknown(new TypeError("Failed to fetch"))).toBe(true);
    expect(speakerMutationOutcomeUnknown(validation)).toBe(false);
    expect(speakerErrorDiagnostic(unavailable)).toBe(
      `SERVICE_UNAVAILABLE · HTTP 503 · trace ${traceId}`,
    );
    expect(speakerErrorDiagnostic(unsafe)).toBeNull();
  });

  it("uses restrained semantic tones for each task status", () => {
    expect(taskStatusTone("not_started")).toBe("neutral");
    expect(taskStatusTone("in_progress")).toBe("info");
    expect(taskStatusTone("overdue")).toBe("warning");
    expect(taskStatusTone("completed")).toBe("success");
    expect(taskStatusTone("submitted")).toBe("success");
    expect(taskStatusTone("unknown")).toBe("neutral");
  });
  it("skips the batch task request for an empty roster", async () => {
    let taskCalls = 0;
    const progress = await speakerProgressFor(
      {
        listTasks: async () => {
          taskCalls += 1;
          throw new Error("An empty roster must not request tasks.");
        },
      },
      [],
      "org-1",
      "event-1",
    );

    expect(taskCalls).toBe(0);
    expect(progress).toEqual({
      organizationId: "org-1",
      eventId: "event-1",
      rows: [],
    });
  });
  it("resolves a delayed multi-speaker batch without serial N+1 waits", async () => {
    const speakers = Array.from({ length: 6 }, (_, index) => ({
      ...speaker,
      participantId: `participant-${index + 1}`,
      displayName: `Speaker ${index + 1}`,
      email: `speaker-${index + 1}@example.test`,
    }));
    const tasks: SpeakerTask[] = speakers.map((candidate, index) => ({
      ...task,
      taskId: `task-${index + 1}`,
      participantId: candidate.participantId,
    }));
    let taskCalls = 0;
    const startedAt = performance.now();
    const progressPromise = speakerProgressFor(
      {
        listTasks: async () => {
          taskCalls += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          return {
            organizationId: "org-1",
            eventId: "event-1",
            speakerProfileId: "",
            tasks,
          };
        },
      },
      speakers,
      "org-1",
      "event-1",
    );

    expect(taskCalls).toBe(1);
    const progress = await progressPromise;

    expect(taskCalls).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(progress.rows.map((row) => row.tasks.length)).toEqual([1, 1, 1, 1, 1, 1]);
  });
  it("rejects a profile-scoped task envelope on the batch path", async () => {
    await expect(
      speakerProgressFor(
        {
          listTasks: async () => ({
            organizationId: "org-1",
            eventId: "event-1",
            speakerProfileId: "participant-1",
            tasks: [task],
          }),
        },
        roster.speakers,
        roster.organizationId,
        roster.eventId,
      ),
    ).rejects.toThrow("different organization, event, or profile");
  });
  it("falls back to authoritative task summaries when progress rows have no tasks", () => {
    const secondSpeaker: SpeakerRecord = {
      ...speaker,
      participantId: "participant-2",
      displayName: "Marcus Chen",
      email: "marcus@example.test",
      status: "invited",
      sessions: [
        { sessionId: "session-2", title: "Reliable queues", status: "accepted", version: 1 },
      ],
      taskSummary: { total: 3, completed: 0, overdue: 0 },
    };
    const completedTask: SpeakerTask = {
      ...task,
      status: "completed",
      completedAt: "2026-08-10T00:00:00.000Z",
    };
    const rows = [
      {
        participantId: speaker.participantId,
        displayName: speaker.displayName,
        tasks: [completedTask],
      },
      {
        participantId: secondSpeaker.participantId,
        displayName: secondSpeaker.displayName,
        tasks: [],
      },
    ];

    expect(speakerProgressMatches([completedTask], "complete")).toBe(true);
    expect(speakerProgressMatches([], "complete")).toBe(false);
    expect(speakerProgressMatches([], "incomplete")).toBe(false);
    expect(
      filterSpeakerRoster([speaker, secondSpeaker], rows, {
        query: " marcus ",
        status: "invited",
        session: "session-2",
        progress: "incomplete",
      }).map((candidate) => candidate.participantId),
    ).toEqual(["participant-2"]);
    expect(
      filterSpeakerRoster([speaker, secondSpeaker], rows, {
        query: "",
        status: "all",
        session: "all",
        progress: "complete",
      }).map((candidate) => candidate.participantId),
    ).toEqual(["participant-1"]);
  });

  it("filters factual speaker attention segments without inventing readiness", () => {
    const speakers: SpeakerRecord[] = [
      speaker,
      {
        ...speaker,
        participantId: "participant-2",
        displayName: "Marcus Chen",
        email: "marcus@example.test",
        status: "pending",
        taskSummary: { total: 2, completed: 1, overdue: 1 },
      },
      {
        ...speaker,
        participantId: "participant-3",
        displayName: "Dana Scott",
        email: "marcus@example.test",
        status: "revoked",
        taskSummary: { total: 1, completed: 1, overdue: 0 },
      },
    ];
    const filters: readonly SpeakerAttentionFilter[] = [
      "all",
      "overdue",
      "awaiting-invite",
      "duplicate-email",
      "inactive",
    ];

    expect(
      Object.fromEntries(
        filters.map((filter) => [
          filter,
          filterSpeakersByAttention(speakers, filter).map((candidate) => candidate.participantId),
        ]),
      ),
    ).toEqual({
      all: ["participant-1", "participant-2", "participant-3"],
      overdue: ["participant-2"],
      "awaiting-invite": ["participant-2"],
      "duplicate-email": ["participant-2", "participant-3"],
      inactive: ["participant-3"],
    });
  });

  it("groups API-loaded onboarding assignments by the server task definition identity", () => {
    const tasks: SpeakerTask[] = [
      {
        ...task,
        taskId: "definition-1:1",
        definitionId: "definition-1",
        participantId: "participant-1",
      },
      {
        ...task,
        taskId: "definition-1:2",
        definitionId: "definition-1",
        participantId: "participant-2",
      },
      {
        ...task,
        taskId: "definition-2:1",
        definitionId: "definition-2",
        title: "Review biography",
        dueAt: "2027-04-05",
      },
      {
        ...task,
        taskId: "definition-2:2",
        definitionId: "definition-2",
        participantId: "participant-2",
        title: "Review biography",
        dueAt: "2027-04-05",
      },
      {
        ...task,
        taskId: "file-request-1",
        definitionId: "file-request-1",
        title: "Upload slides",
        description: "A deliverable task.",
        type: "file_request",
      },
    ];
    const definitions = speakerOnboardingTaskDefinitions([
      {
        participantId: "participant-1",
        displayName: "Priya Raman",
        tasks: tasks.filter((candidate) => candidate.participantId === "participant-1"),
      },
      {
        participantId: "participant-2",
        displayName: "Marcus Chen",
        tasks: tasks.filter((candidate) => candidate.participantId === "participant-2"),
      },
    ]);

    expect(definitions).toEqual([
      {
        definitionId: "definition-1",
        title: "Confirm participation",
        dueAt: "2027-04-01",
        participantIds: ["participant-1", "participant-2"],
      },
      {
        definitionId: "definition-2",
        title: "Review biography",
        dueAt: "2027-04-05",
        participantIds: ["participant-1", "participant-2"],
      },
    ]);
    expect(
      validateSpeakerTaskAssignment(
        { title: "Third", dueAt: "2027-04-10", participantIds: ["participant-1"] },
        definitions.length,
      ),
    ).toBeNull();
    expect(
      createSpeakerTaskAssignment({
        title: " Confirm logistics ",
        dueAt: " 2027-04-09 ",
        participantIds: ["participant-1", "participant-1", " participant-2 "],
      }),
    ).toMatchObject({
      title: "Confirm logistics",
      dueAt: "2027-04-09",
      participantIds: ["participant-1", "participant-2"],
    });
  });

  it("uses speaker names instead of internal IDs for onboarding assignees", () => {
    expect(
      speakerTaskAssigneeLabels(
        ["participant-1", "missing-participant"],
        [{ participantId: "participant-1", displayName: "Priya Raman" }],
      ),
    ).toEqual(["Priya Raman", "Unavailable speaker"]);
  });

  it("maps logistics fields and retains terminal invitation results without replacing history", () => {
    expect(
      travelLogisticsFor({
        displayName: "Priya Raman",
        email: "priya@example.test",
        title: "Principal Engineer",
        company: "Latticework Systems",
        biography: "Bio",
        twitter: "",
        linkedin: "",
        website: "",
        status: "confirmed",
        travelRequired: true,
        arrivalAt: " 2027-03-30 ",
        departureAt: "2027-04-03",
        accommodation: " Conference hotel ",
        dietaryRequirements: " Vegan ",
        accessibilityNeeds: " Step-free access ",
        travelNotes: " Arrives after 18:00 ",
      }),
    ).toEqual({
      travelRequired: true,
      arrivalAt: "2027-03-30",
      departureAt: "2027-04-03",
      accommodation: "Conference hotel",
      dietaryRequirements: "Vegan",
      accessibilityNeeds: "Step-free access",
      travelNotes: "Arrives after 18:00",
    });

    const preview = [
      {
        participantId: "participant-1",
        recipientEmail: "priya@example.test",
        state: "ready" as const,
      },
    ];
    const firstPreview = preview[0];
    if (!firstPreview) {
      throw new Error("Expected the first invitation preview record fixture.");
    }
    expect(speakerInvitationReady(preview, speaker)).toBe(true);
    expect(speakerInvitationReady(preview, { ...speaker, email: "changed@example.test" })).toBe(
      false,
    );
    expect(speakerInvitationReady([{ ...firstPreview, state: "blocked" }], speaker)).toBe(false);
    expect(speakerInvitationReady(preview, { ...speaker, status: "revoked" })).toBe(false);
    const first = retainInvitationHistory(
      [],
      preview,
      {
        organizationId: "org-1",
        eventId: "event-1",
        idempotencyKey: "invite-1",
        status: "sent",
        duplicate: false,
        recipients: [
          {
            participantId: "participant-1",
            recipientEmail: "priya@example.test",
            status: "sent",
            receiptId: "receipt-1",
          },
        ],
      },
      "2026-08-11T10:00:00.000Z",
    );
    const second = retainInvitationHistory(
      first,
      preview,
      {
        organizationId: "org-1",
        eventId: "event-1",
        idempotencyKey: "invite-2",
        status: "failed",
        duplicate: false,
        recipients: [
          {
            participantId: "participant-1",
            recipientEmail: "priya@example.test",
            status: "failed",
            receiptId: null,
          },
        ],
      },
      "2026-08-11T11:00:00.000Z",
    );

    expect(second.map((entry) => entry.result.status)).toEqual(["failed", "sent"]);
    expect(second[1]?.occurredAt).toBe("2026-08-11T10:00:00.000Z");
  });
});

describe("speaker workspace", () => {
  it("validates organizer headshots at the browser boundary", () => {
    expect(
      validateOrganizerHeadshotFile(new File(["ok"], "headshot.jpg", { type: "image/jpeg" })),
    ).toBe(null);
    expect(
      validateOrganizerHeadshotFile(new File(["ok"], "headshot.png", { type: "IMAGE/PNG" })),
    ).toBeNull();
    expect(
      validateOrganizerHeadshotFile(new File(["bad"], "headshot.gif", { type: "image/gif" })),
    ).toContain("JPEG, PNG, or WebP");
    expect(
      validateOrganizerHeadshotFile(
        new File([new Uint8Array(ORGANIZER_HEADSHOT_MAX_BYTES + 1)], "large.webp", {
          type: ORGANIZER_HEADSHOT_ACCEPTED_TYPES[2],
        }),
      ),
    ).toContain("5 MB");
  });

  it("accepts only relative same-origin API paths for headshot previews", () => {
    expect(
      organizerHeadshotPreviewPath(
        "/api/speaker/assets/capabilities/download/asset-headshot/opaque-token",
      ),
    ).toBe("/api/speaker/assets/capabilities/download/asset-headshot/opaque-token");
    expect(organizerHeadshotPreviewPath("https://downloads.example.test/headshot")).toBeNull();
    expect(organizerHeadshotPreviewPath("//downloads.example.test/headshot")).toBeNull();
    expect(organizerHeadshotPreviewPath("/api/../private/headshot")).toBeNull();
  });

  it("renders a secure headshot preview and a graceful unavailable fallback", () => {
    const imageMarkup = renderToStaticMarkup(
      createElement(SpeakerHeadshot, {
        speakerName: speaker.displayName,
        asset: headshotAsset,
        imageUrl: "/api/speaker/events/event-1/organizer/assets/asset-headshot/download",
        loading: false,
        error: null,
        revision: 2,
      }),
    );
    const externalMarkup = renderToStaticMarkup(
      createElement(SpeakerHeadshot, {
        speakerName: speaker.displayName,
        asset: headshotAsset,
        imageUrl: "https://downloads.example.test/headshot",
        loading: false,
        error: null,
        revision: 2,
      }),
    );
    const fallbackMarkup = renderToStaticMarkup(
      createElement(SpeakerHeadshot, {
        speakerName: speaker.displayName,
        asset: null,
        imageUrl: null,
        loading: false,
        error: null,
        revision: 0,
      }),
    );

    expect(imageMarkup).toContain('alt="Priya Raman headshot"');
    expect(imageMarkup).toContain(
      "/api/speaker/events/event-1/organizer/assets/asset-headshot/download",
    );
    expect(fallbackMarkup).toContain("No headshot uploaded");
    expect(fallbackMarkup).not.toContain("<img");
    expect(externalMarkup).toContain("Headshot preview unavailable");
    expect(externalMarkup).not.toContain("<img");
  });
  it("does not request a grant on initial asset render and keeps non-ready assets unavailable", () => {
    const requests: SpeakerAsset[] = [];
    const readyMarkup = renderToStaticMarkup(
      createElement(SpeakerAssetDownload, {
        asset: readyAsset,
        busy: false,
        disabled: false,
        error: null,
        onRequest: async (asset: SpeakerAsset) => {
          requests.push(asset);
          return null;
        },
      }),
    );
    const pendingMarkup = renderToStaticMarkup(
      createElement(SpeakerAssetDownload, {
        asset: pendingAsset,
        busy: false,
        disabled: false,
        error: null,
        onRequest: async (asset: SpeakerAsset) => {
          requests.push(asset);
          return null;
        },
      }),
    );

    expect(requests).toHaveLength(0);
    expect(readyMarkup).toContain("Download / view");
    expect(readyMarkup).toContain("<button");
    expect(pendingMarkup).toContain("Download is not available for this asset.");
    expect(pendingMarkup).not.toContain("<button");
  });
  it("renders organizer asset metadata and keeps preview separate from invitation send", () => {
    const metadata = renderToStaticMarkup(
      createElement(SpeakerAssetMetadata, { asset: readyAsset }),
    );
    const controls = renderToStaticMarkup(
      createElement(SpeakerInvitationControls, {
        previewBusy: false,
        sendBusy: false,
        disabled: false,
        canSend: false,
        onPreview: () => undefined,
        onSend: () => undefined,
      }),
    );

    expect(metadata).toContain("application/pdf");
    expect(metadata).toContain("1 KB");
    expect(metadata).toContain("Ready");
    expect(metadata).toContain("Aug 9, 2026");
    expect(controls).toContain("Preview portal invite");
    expect(controls).toContain("Send portal invite");
    expect(controls.match(/<button/g)).toHaveLength(2);
    expect(controls.match(/disabled=""/g)).toHaveLength(1);
  });

  it("requests a fresh grant and navigates from the same click without rendering its URL", async () => {
    const freshGrant = {
      url: "/api/speaker/assets/capabilities/download/asset-1/fresh-capability",
      expiresAt: "2026-08-10T12:02:00.000Z",
    };
    const requestGrant = vi.fn(async (_asset: SpeakerAsset) => freshGrant.url);
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });

    try {
      const rendered = SpeakerAssetDownload({
        asset: readyAsset,
        busy: false,
        disabled: false,
        error: null,
        onRequest: requestGrant,
      });
      const fragment = rendered as {
        props?: {
          children?: unknown;
        };
      };
      const children = Array.isArray(fragment.props?.children)
        ? fragment.props.children
        : [fragment.props?.children];
      const button = children.find(
        (
          child,
        ): child is {
          props: {
            onClick?: () => void | Promise<void>;
            type?: string;
          };
        } =>
          typeof child === "object" &&
          child !== null &&
          "props" in child &&
          (child as { props?: { type?: string } }).props?.type === "button",
      );
      const onClick = button?.props.onClick;
      if (onClick === undefined) throw new Error("Expected a ready-asset download button.");

      await onClick();

      expect(requestGrant).toHaveBeenCalledTimes(1);
      expect(requestGrant).toHaveBeenCalledWith(readyAsset);
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith(freshGrant.url);

      const postGrantMarkup = renderToStaticMarkup(
        createElement(SpeakerAssetDownload, {
          asset: readyAsset,
          busy: false,
          disabled: false,
          error: null,
          onRequest: requestGrant,
        }),
      );
      expect(postGrantMarkup).not.toContain(freshGrant.url);
      expect(postGrantMarkup).not.toContain("<a");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("renders the roster controls and keeps private storage fields out of the UI", () => {
    const markup = renderToStaticMarkup(
      createElement(SpeakerWorkspace, {
        organizationId: "org-1",
        eventId: "event-1",
      }),
    );

    expect(markup).toContain("Speaker operations");
    expect(markup).toContain("Search speakers");
    expect(markup).toContain('aria-controls="speaker-roster-filters"');
    expect(markup).toContain('data-speaker-collection="true"');
    expect(markup).toContain("Add speaker");
    expect(markup).toContain("Import CSV");
    expect(markup).toContain('id="tasks-tab"');
    expect(markup).toContain('id="email-tab"');
    expect(markup).not.toContain("General speaker tasks");
    expect(markup).not.toContain("Bulk speaker email");
    expect(markup).not.toContain("objectKey");
  });
  it("starts secondary speaker reads only after the current roster renders", () => {
    expect(speakerSecondaryLoadKey(null, "org-1", "event-1", false)).toBeNull();
    expect(speakerSecondaryLoadKey(roster, "org-1", "event-1", true)).toBeNull();
    expect(speakerSecondaryLoadKey(roster, "org-2", "event-1", false)).toBeNull();
    expect(speakerSecondaryLoadKey(roster, "org-1", "event-2", false)).toBeNull();
    expect(speakerSecondaryLoadKey(roster, "org-1", "event-1", false, false)).toBeNull();
    expect(speakerSecondaryLoadKey(roster, "org-1", "event-1", false)).toBe("org-1:event-1");
  });

  it("keeps duplicate authoritative speakers visible to conflict presentation", () => {
    const duplicate = {
      ...speaker,
      participantId: "participant-2",
      displayName: "Marcus Chen",
      email: " PRIYA@EXAMPLE.TEST ",
    };
    const conflicts = duplicateEmailConflicts([speaker, duplicate]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.email).toBe("priya@example.test");
    expect(conflicts[0]?.speakers.map((candidate) => candidate.participantId)).toEqual([
      "participant-1",
      "participant-2",
    ]);
  });

  it("renders the email workflow controls without unsafe HTML execution", () => {
    const markup = renderToStaticMarkup(
      createElement(SpeakerWorkspace, {
        organizationId: "org-1",
        eventId: "event-1",
        api: {} as SpeakerApi,
      }),
    );

    expect(markup).toContain("Import CSV");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('id="email-tab"');
    expect(markup).toContain('aria-controls="email-view"');
    expect(markup).not.toContain("dangerouslySetInnerHTML");
    expect(markup).not.toContain("srcDoc");
    expect(markup).not.toContain("iframe");
  });

  it("provides a complete editable welcome email starter", () => {
    expect(SPEAKER_WELCOME_EMAIL_STARTER.name).toBe("Speaker welcome");
    expect(SPEAKER_WELCOME_EMAIL_STARTER.subject).toContain("Welcome");
    expect(SPEAKER_WELCOME_EMAIL_STARTER.html).toContain("speaker program");
    expect(SPEAKER_WELCOME_EMAIL_STARTER.text).toContain("speaker portal");
    expect(SPEAKER_WELCOME_EMAIL_STARTER.text).not.toBe("Hello {{first_name}},");
  });
});
