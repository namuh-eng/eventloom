import { describe, expect, it } from "vitest";
import {
  filterSubmissions,
  filterTasks,
  isTaskBlocked,
  portalIdentityProfile,
  portalProfileHeadshot,
  portalSubmissionEditTarget,
  portalSubmissionIdsMatch,
  portalTaskAsset,
  scopePortalContextToPrimaryParticipant,
  scopePortalViewToAuthorizedParticipants,
  scopePortalViewToPrimaryParticipant,
  submissionStatusPresentation,
  summarizePortal,
  taskPrimaryAction,
  validateBiography,
} from "./model";
import { portalSubmissionActionTargets } from "./portal-submissions";
import type { PortalAsset, PortalTask, PortalView } from "./types";

function task(overrides: Partial<PortalTask> = {}): PortalTask {
  return {
    id: "task-1",
    eventId: "event-1",
    subject: { type: "participant" },
    participantId: "participant-1",
    type: "form",
    owner: "speaker",
    title: "Confirm details",
    status: "not_started",
    dependencyIds: [],
    reminderOffsetsMinutes: [],
    version: 1,
    updatedAt: "2026-08-08T12:00:00.000Z",
    ...overrides,
  };
}

const portal: PortalView = {
  submissions: [
    {
      id: "submission-1",
      eventId: "event-1",
      title: "Designing resilient queues",
      status: "accepted",
      participantIds: ["participant-1"],
      updatedAt: "2026-08-08T12:00:00.000Z",
    },
    {
      id: "submission-2",
      eventId: "event-1",
      title: "Practical accessibility",
      status: "under_review",
      participantIds: ["participant-1"],
      updatedAt: "2026-08-07T12:00:00.000Z",
    },
  ],
  sessions: [
    {
      sessionId: "session-1",
      title: "Designing resilient queues",
      status: "confirmed",
      version: 1,
    },
  ],
  profiles: [],
  tasks: [task({ id: "task-1", status: "completed" }), task({ id: "task-2" })],
  outstandingTaskCount: 1,
};

describe("speaker portal view model", () => {
  it("matches canonical CFP submission identities", () => {
    expect(portalSubmissionIdsMatch("submission-1", "submission-1")).toBe(true);
    expect(portalSubmissionIdsMatch("submission-1", "speaker-submission:submission-1")).toBe(true);
    expect(portalSubmissionIdsMatch("submission-1", "submission-2")).toBe(false);
    expect(portalSubmissionIdsMatch("", "")).toBe(false);
  });
  it("retains sessions only for the selected primary participant", () => {
    const context = {
      id: "portal:event-1",
      eventId: "event-1",
      name: "DevFlow Conf 2027",
      capabilities: ["task-response"],
      submissionIds: ["submission-1"],
      participantIds: ["participant-1", "participant-2"],
      primaryParticipantId: "participant-1",
    } as const;

    expect(
      scopePortalViewToAuthorizedParticipants(portal, context, "participant-1").sessions,
    ).toEqual(portal.sessions);
    expect(
      scopePortalViewToAuthorizedParticipants(portal, context, "participant-2").sessions,
    ).toEqual([]);
  });
  it("matches task assets by exact task and session identity", () => {
    const linkedTask = task({
      eventId: "event-1",
      subject: { type: "session", sessionId: "session-1" },
      participantId: "participant-1",
    });
    expect(
      portalTaskAsset(linkedTask, [
        {
          id: "asset-1",
          eventId: "event-1",
          participantId: "participant-1",
          sessionId: "session-1",
          taskId: linkedTask.id,
          kind: "slides",
          fileName: "slides.pdf",
          contentType: "application/pdf",
          sizeBytes: 10,
          state: "ready",
          createdAt: "2026-08-08T12:00:00.000Z",
        },
        {
          id: "asset-wrong-session",
          eventId: "event-1",
          participantId: "participant-1",
          sessionId: "session-2",
          taskId: linkedTask.id,
          kind: "slides",
          fileName: "wrong.pdf",
          contentType: "application/pdf",
          sizeBytes: 10,
          state: "ready",
          createdAt: "2026-08-09T12:00:00.000Z",
        },
      ]),
    ).toMatchObject({ id: "asset-1" });
  });
  it("presents human-readable submission decisions", () => {
    expect(submissionStatusPresentation("accepted")).toMatchObject({
      label: "Accepted",
      tone: "success",
    });
    expect(submissionStatusPresentation("declined").description).toContain("not selected");
  });

  it("blocks tasks until every dependency is finished", () => {
    const dependent = task({ id: "dependent", dependencyIds: ["required", "waived"] });
    expect(
      isTaskBlocked(dependent, [
        dependent,
        task({ id: "required", status: "in_progress" }),
        task({ id: "waived", status: "waived" }),
      ]),
    ).toBe(true);
    expect(
      isTaskBlocked(dependent, [
        dependent,
        task({ id: "required", status: "completed" }),
        task({ id: "waived", status: "waived" }),
      ]),
    ).toBe(false);
    expect(isTaskBlocked(task({ dependencyIds: ["missing"] }), [])).toBe(true);
  });

  it("selects actions that match the speaker task transition contract", () => {
    expect(taskPrimaryAction(task({ type: "form", status: "not_started" }))).toBe("start");
    expect(taskPrimaryAction(task({ type: "form", status: "in_progress" }))).toBe("submit");
    expect(taskPrimaryAction(task({ type: "upload", status: "needs_changes" }))).toBe("upload");
    expect(taskPrimaryAction(task({ type: "action", status: "not_started" }))).toBe("complete");
    expect(taskPrimaryAction(task({ status: "submitted" }))).toBeNull();
    expect(taskPrimaryAction(task({ status: "completed" }))).toBeNull();
  });

  it("filters submissions and tasks without mutating source data", () => {
    expect(filterSubmissions(portal.submissions, "ACCESS").map(({ id }) => id)).toEqual([
      "submission-2",
    ]);
    expect(filterSubmissions(portal.submissions, "")).not.toBe(portal.submissions);
    expect(filterTasks(portal.tasks, "attention").map(({ id }) => id)).toEqual(["task-2"]);
    expect(filterTasks(portal.tasks, "finished").map(({ id }) => id)).toEqual(["task-1"]);
  });

  it("distinguishes no tasks, in-progress work, and non-empty readiness", () => {
    expect(summarizePortal(portal)).toEqual({
      submissionCount: 2,
      acceptedCount: 1,
      taskCount: 2,
      outstandingTaskCount: 1,
      completedTaskCount: 1,
      completionPercent: 50,
      readinessState: "in-progress",
    });

    expect(summarizePortal({ ...portal, tasks: [], outstandingTaskCount: 0 })).toMatchObject({
      taskCount: 0,
      outstandingTaskCount: 0,
      completedTaskCount: 0,
      completionPercent: null,
      readinessState: "no-tasks",
    });

    expect(
      summarizePortal({
        ...portal,
        tasks: portal.tasks.map((candidate) => ({ ...candidate, status: "completed" as const })),
        outstandingTaskCount: 0,
      }),
    ).toMatchObject({
      taskCount: 2,
      outstandingTaskCount: 0,
      completedTaskCount: 2,
      completionPercent: 100,
      readinessState: "ready",
    });
  });
  it("uses the server-selected primary participant for account identity", () => {
    const priya = {
      id: "profile-priya",
      eventId: "event-1",
      participantId: "participant-priya",
      displayName: "Priya Raman",
      biography: "",
      version: 1,
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    const marcus = {
      ...priya,
      id: "profile-marcus",
      participantId: "participant-marcus",
      displayName: "Marcus Okafor",
    };
    const context = {
      id: "portal:event-1",
      eventId: "event-1",
      name: "DevFlow Conf 2027",
      capabilities: [],
      submissionIds: [],
      participantIds: [marcus.participantId, priya.participantId],
      primaryParticipantId: priya.participantId,
    } as const;

    expect(
      portalIdentityProfile({ ...portal, profiles: [marcus, priya], context }, context)
        ?.displayName,
    ).toBe("Priya Raman");
  });

  it("keeps only the primary speaker's sessions, profile, tasks, and assets", () => {
    const priyaParticipantId = "participant-priya";
    const marcusParticipantId = "participant-marcus";
    const context = {
      id: "portal:event-1",
      eventId: "event-1",
      name: "DevFlow Conf 2027",
      capabilities: ["profile-self", "task-response", "asset-read"],
      submissionIds: ["session-priya", "session-marcus"],
      participantIds: [marcusParticipantId, priyaParticipantId],
      primaryParticipantId: priyaParticipantId,
    } as const;
    expect(scopePortalContextToPrimaryParticipant(context).submissionIds).toEqual(
      context.submissionIds,
    );
    const priyaProfile = {
      id: "profile-priya",
      eventId: "event-1",
      participantId: priyaParticipantId,
      displayName: "Priya Raman",
      biography: "Builds reliable platforms.",
      headshotAssetId: "asset-headshot",
      version: 2,
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    const marcusProfile = {
      ...priyaProfile,
      id: "profile-marcus",
      participantId: marcusParticipantId,
      displayName: "Marcus Okafor",
      headshotAssetId: "asset-marcus",
    };
    const priyaTask = task({
      id: "task-priya",
      subject: { type: "session", sessionId: "session-priya" },
      participantId: priyaParticipantId,
      type: "upload",
      status: "submitted",
      acceptedAssetKinds: ["slides"],
    });
    const marcusTask = task({
      id: "task-marcus",
      subject: { type: "session", sessionId: "session-marcus" },
      participantId: marcusParticipantId,
    });
    const assets: PortalAsset[] = [
      {
        id: "asset-headshot",
        eventId: "event-1",
        participantId: priyaParticipantId,
        kind: "headshot",
        fileName: "priya.webp",
        contentType: "image/webp",
        sizeBytes: 2_048,
        state: "ready",
        createdAt: "2026-08-09T00:00:00.000Z",
      },
      {
        id: "asset-slides-v1",
        eventId: "event-1",
        participantId: priyaParticipantId,
        sessionId: "session-priya",
        taskId: priyaTask.id,
        kind: "slides",
        fileName: "slides-v1.pdf",
        contentType: "application/pdf",
        sizeBytes: 4_096,
        state: "ready",
        createdAt: "2026-08-09T01:00:00.000Z",
        version: 1,
      },
      {
        id: "asset-slides-v2",
        eventId: "event-1",
        participantId: priyaParticipantId,
        sessionId: "session-priya",
        taskId: priyaTask.id,
        kind: "slides",
        fileName: "slides-v2.pdf",
        contentType: "application/pdf",
        sizeBytes: 8_192,
        state: "ready",
        createdAt: "2026-08-09T02:00:00.000Z",
        version: 2,
      },
      {
        id: "asset-marcus",
        eventId: "event-1",
        participantId: marcusParticipantId,
        taskId: marcusTask.id,
        kind: "headshot",
        fileName: "marcus.png",
        contentType: "image/png",
        sizeBytes: 1_024,
        state: "ready",
        createdAt: "2026-08-09T00:00:00.000Z",
      },
    ];
    const scoped = scopePortalViewToPrimaryParticipant(
      {
        submissions: [
          {
            id: "session-priya",
            eventId: "event-1",
            title: "Reliable systems",
            status: "accepted",
            participantIds: [priyaParticipantId, marcusParticipantId],
            updatedAt: "2026-08-09T00:00:00.000Z",
          },
          {
            id: "session-marcus",
            eventId: "event-1",
            title: "Community programs",
            status: "accepted",
            participantIds: [marcusParticipantId],
            updatedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
        sessions: [
          {
            sessionId: "session-priya",
            title: "Reliable systems",
            status: "confirmed",
            version: 1,
          },
        ],
        profiles: [marcusProfile, priyaProfile],
        tasks: [marcusTask, priyaTask],
        outstandingTaskCount: 2,
        context,
        assets,
        roster: {
          organizationId: "organization-1",
          eventId: "event-1",
          submissionId: "session-priya",
          capabilities: { manage: true, invite: true },
          members: [
            {
              participantId: priyaParticipantId,
              displayName: "Priya Shah",
              email: "priya@example.test",
              role: "primary",
              status: "active",
              capabilities: { edit: true, remove: false },
            },
            {
              participantId: marcusParticipantId,
              displayName: "Marcus Okafor",
              email: "marcus@example.test",
              role: "co_speaker",
              status: "active",
              capabilities: { edit: true, remove: true },
            },
          ],
        },
        resources: [
          {
            id: "resource-1",
            title: "Speaker guide",
            order: 1,
            updatedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
        wiki: [
          {
            id: "wiki-1",
            title: "Travel",
            slug: "travel",
            order: 1,
            updatedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      },
      context,
    );

    expect(scoped.submissions).toEqual([
      expect.objectContaining({
        id: "session-priya",
        participantIds: [priyaParticipantId],
      }),
    ]);
    expect(scoped.sessions).toEqual([
      {
        sessionId: "session-priya",
        title: "Reliable systems",
        status: "confirmed",
        version: 1,
      },
    ]);
    expect(scoped.profiles.map(({ participantId }) => participantId)).toEqual([priyaParticipantId]);
    expect(scoped.tasks.map(({ id }) => id)).toEqual([priyaTask.id]);
    expect(scoped.assets?.map(({ id }) => id)).toEqual([
      "asset-headshot",
      "asset-slides-v1",
      "asset-slides-v2",
    ]);
    expect(scoped.context).toMatchObject({
      participantIds: [priyaParticipantId],
      submissionIds: ["session-priya"],
      primaryParticipantId: priyaParticipantId,
    });
    expect(scoped.outstandingTaskCount).toBe(1);
    expect(scoped.roster).toMatchObject({
      eventId: "event-1",
      submissionId: "session-priya",
      members: [
        { participantId: priyaParticipantId, role: "primary" },
        { participantId: marcusParticipantId, role: "co_speaker" },
      ],
    });
    expect(scoped.resources).toEqual([expect.objectContaining({ id: "resource-1" })]);
    expect(scoped.wiki).toEqual([expect.objectContaining({ id: "wiki-1" })]);
    expect(portalProfileHeadshot(priyaProfile, scoped.assets ?? [])?.id).toBe("asset-headshot");
    expect(portalTaskAsset(priyaTask, scoped.assets ?? [])?.id).toBe("asset-slides-v2");
  });
  it("retains an admitted participant's direct session task without CFP submission authority", () => {
    const context = {
      id: "portal:event-1",
      eventId: "event-1",
      name: "DevFlow Conf 2027",
      capabilities: ["task-response"],
      submissionIds: [],
      participantIds: ["participant-priya"],
      primaryParticipantId: "participant-priya",
    } as const;
    const directSessionTask = task({
      id: "task-session",
      subject: { type: "session", sessionId: "program-session-1" },
      participantId: "participant-priya",
    });
    const view: PortalView = {
      submissions: [],
      sessions: [],
      profiles: [],
      tasks: [
        directSessionTask,
        task({ id: "task-other-event", eventId: "event-2" }),
        task({ id: "task-other-participant", participantId: "participant-marcus" }),
      ],
      outstandingTaskCount: 3,
      assets: [
        {
          id: "asset-session",
          eventId: "event-1",
          participantId: "participant-priya",
          taskId: directSessionTask.id,
          sessionId: "program-session-1",
          kind: "slides",
          fileName: "slides.pdf",
          contentType: "application/pdf",
          sizeBytes: 10,
          state: "ready",
          createdAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    };

    expect(scopePortalContextToPrimaryParticipant(context).submissionIds).toEqual([]);
    expect(scopePortalViewToPrimaryParticipant(view, context)).toMatchObject({
      submissions: [],
      tasks: [expect.objectContaining({ id: directSessionTask.id })],
      assets: [expect.objectContaining({ id: "asset-session" })],
      outstandingTaskCount: 1,
    });
  });

  it("fails closed when the server-selected participant is not authorized", () => {
    const context = {
      id: "portal:event-1",
      eventId: "event-1",
      name: "DevFlow Conf 2027",
      capabilities: [],
      submissionIds: ["submission-1"],
      participantIds: ["participant-priya"],
      primaryParticipantId: "participant-marcus",
    } as const;

    expect(scopePortalContextToPrimaryParticipant(context)).toMatchObject({
      participantIds: [],
      submissionIds: [],
    });
    expect(scopePortalViewToPrimaryParticipant(portal, context)).toMatchObject({
      submissions: [],
      profiles: [],
      tasks: [],
      assets: [],
      outstandingTaskCount: 0,
    });
  });
  it("builds edit and submit-another routes only for an open editable proposal", () => {
    const context = {
      id: "portal:ai-engineer:devflow-conf-2027",
      eventId: "devflow-conf-2027",
      slug: "devflow-conf-2027",
      name: "DevFlow Conf 2027",
      capabilities: ["submission-edit"],
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
    } as const;
    const baseSubmission = portal.submissions[0];
    expect(baseSubmission).toBeDefined();
    if (baseSubmission === undefined) throw new Error("Expected a portal submission fixture.");
    const submission = {
      ...baseSubmission,
      id: "submission-1",
      eventId: context.eventId,
      status: "submitted",
      formId: "devflow-conf-2027-cfp",
    } as const;

    expect(portalSubmissionEditTarget(context, submission)).toEqual({
      href: "/cfp/organizations/ai-engineer/events/devflow-conf-2027/submission",
      pointerKey: "eventloom:cfp-submission:v1:ai-engineer:devflow-conf-2027:devflow-conf-2027-cfp",
      activePointerKey:
        "eventloom:cfp-active-submission:v1:ai-engineer:devflow-conf-2027:devflow-conf-2027-cfp",
      newSubmissionIntentKey:
        "eventloom:cfp-new-submission:v1:ai-engineer:devflow-conf-2027:devflow-conf-2027-cfp",
    });
    expect(portalSubmissionActionTargets(context, submission)).toEqual({
      editHref: "/cfp/organizations/ai-engineer/events/devflow-conf-2027/submission",
      newProposalHref: "/cfp/organizations/ai-engineer/events/devflow-conf-2027",
      pointerKey: "eventloom:cfp-submission:v1:ai-engineer:devflow-conf-2027:devflow-conf-2027-cfp",
      activePointerKey:
        "eventloom:cfp-active-submission:v1:ai-engineer:devflow-conf-2027:devflow-conf-2027-cfp",
      newSubmissionIntentKey:
        "eventloom:cfp-new-submission:v1:ai-engineer:devflow-conf-2027:devflow-conf-2027-cfp",
      identity: {
        organizationId: "ai-engineer",
        eventId: "devflow-conf-2027",
        formId: "devflow-conf-2027-cfp",
      },
    });
    expect(
      portalSubmissionActionTargets(context, { ...submission, status: "accepted" }),
    ).toBeNull();
    expect(
      portalSubmissionActionTargets(context, {
        ...submission,
        closeAt: "2000-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
    expect(portalSubmissionActionTargets(context, { ...submission, formId: " " })).toBeNull();
    expect(portalSubmissionEditTarget(context, { ...submission, status: "accepted" })).toBeNull();
    expect(
      portalSubmissionEditTarget(context, { ...submission, status: "submitted" }),
    ).not.toBeNull();
    expect(
      portalSubmissionEditTarget(context, { ...submission, status: "under_review" }),
    ).not.toBeNull();
    expect(portalSubmissionEditTarget(context, { ...submission, status: "declined" })).toBeNull();
    expect(portalSubmissionEditTarget(context, { ...submission, status: "withdrawn" })).toBeNull();
  });

  it("normalizes biographies and enforces the API text policy", () => {
    expect(validateBiography("  First line\r\nSecond line  ")).toEqual({
      success: true,
      biography: "First line\nSecond line",
    });
    expect(validateBiography("a".repeat(5_001))).toEqual({
      success: false,
      message: "Biography must be 5,000 characters or fewer.",
    });
    expect(validateBiography("hello\u0000world")).toEqual({
      success: false,
      message: "Biography contains an unsupported control character.",
    });
  });
});
