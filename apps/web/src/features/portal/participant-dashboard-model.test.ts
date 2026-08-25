import { describe, expect, it } from "vitest";
import {
  acceptedSessionAvailability,
  createParticipantDashboard,
  groupParticipantDashboardContexts,
  participantDashboardHref,
  participantDashboardSubmissionPrimaryAction,
  selectParticipantDashboardTasks,
  speakerPreparationGate,
  summarizeParticipantDashboardTasks,
  summarizeSubmissionStates,
} from "./participant-dashboard-model";
import type { PortalContext, PortalSubmission, PortalSubmissionStatus, PortalTask } from "./types";

function context(overrides: Partial<PortalContext> = {}): PortalContext {
  return {
    id: "portal:organization-1:event-north",
    organizationId: "organization-1",
    eventId: "event/north",
    name: "North Summit",
    capabilities: ["submission-edit", "task-response"],
    submissionIds: ["speaker-submission:accepted-1", "draft-1", "submitted-1", "declined-1"],
    participantIds: ["speaker-north"],
    primaryParticipantId: "speaker-north",
    selectedParticipantId: "speaker-north",
    ...overrides,
  };
}

function submission(
  status: PortalSubmissionStatus,
  overrides: Partial<PortalSubmission> = {},
): PortalSubmission {
  return {
    id: `${status}-1`,
    eventId: "event/north",
    title: `${status} submission`,
    status,
    participantIds: ["speaker-north"],
    updatedAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  };
}

function task(overrides: Partial<PortalTask> = {}): PortalTask {
  return {
    id: "task-1",
    eventId: "event/north",
    subject: { type: "participant" },
    participantId: "speaker-north",
    type: "form",
    owner: "speaker",
    title: "Confirm speaker details",
    status: "not_started",
    dependencyIds: [],
    reminderOffsetsMinutes: [],
    version: 1,
    updatedAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  };
}

const northContext = context();
const eventQuery = "?event=stale-event&participant=speaker%20north&filter=mine";
const northSubmissions = [
  submission("accepted", { id: "accepted-1", title: "Reliable platforms" }),
  submission("draft", { id: "draft-1" }),
  submission("submitted", { id: "submitted-1" }),
  submission("declined", { id: "declined-1" }),
] as const;

describe("participant dashboard model", () => {
  it("groups every authorized context with only its authorized event submissions", () => {
    const southContext: PortalContext = {
      id: "portal:organization-1:event-south",
      organizationId: "organization-1",
      eventId: "event/south",
      name: "South Summit",
      capabilities: [],
      submissionIds: [],
      participantIds: [],
    };
    const groups = groupParticipantDashboardContexts(
      [northContext, southContext],
      [
        ...northSubmissions,
        submission("accepted", { id: "not-authorized", title: "Private proposal" }),
        submission("accepted", {
          id: "accepted-1",
          eventId: "event/south",
          title: "Wrong event",
        }),
      ],
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ context: northContext });
    expect(groups[0]?.submissions.map(({ id }) => id)).toEqual([
      "accepted-1",
      "draft-1",
      "submitted-1",
      "declined-1",
    ]);
    expect(groups[1]).toMatchObject({ context: southContext, submissions: [] });
  });

  it("derives exhaustive submission states and accepted-session availability without schedule claims", () => {
    const submissions = [
      ...northSubmissions,
      submission("under_review", { id: "under-review-1" }),
      submission("withdrawn", { id: "withdrawn-1" }),
    ];

    expect(summarizeSubmissionStates(submissions)).toEqual({
      totalCount: 6,
      byStatus: {
        draft: 1,
        submitted: 1,
        under_review: 1,
        accepted: 1,
        declined: 1,
        withdrawn: 1,
      },
    });
    expect(acceptedSessionAvailability(submissions)).toEqual({
      available: true,
      acceptedSubmissionCount: 1,
    });
    expect(acceptedSessionAvailability([submission("submitted")])).toEqual({
      available: false,
      acceptedSubmissionCount: 0,
    });
  });

  it("preserves context parameters while forcing links to the authorized event", () => {
    expect(participantDashboardHref("/portal?workspace=sessions", northContext, eventQuery)).toBe(
      "/portal?workspace=sessions&event=event%2Fnorth&participant=speaker%20north&filter=mine",
    );
    expect(
      participantDashboardHref(
        "/portal/tasks",
        northContext,
        "?eventId=stale-event&participant=speaker%20north",
      ),
    ).toBe("/portal/tasks?eventId=event%2Fnorth&participant=speaker%20north&event=event%2Fnorth");
  });

  it("chooses state-specific actions without promising an editor, schedule, or agreement", () => {
    expect(
      participantDashboardSubmissionPrimaryAction(
        submission("draft", { id: "draft-1" }),
        northContext,
        eventQuery,
      ),
    ).toEqual({
      kind: "review-draft",
      label: "Review draft",
      href: "/portal/submissions/draft-1?event=event%2Fnorth&participant=speaker%20north&filter=mine",
    });
    expect(
      participantDashboardSubmissionPrimaryAction(
        submission("submitted", { id: "submitted-1" }),
        northContext,
        eventQuery,
      ),
    ).toMatchObject({
      kind: "view-submission",
      label: "View submission",
    });
    expect(
      participantDashboardSubmissionPrimaryAction(
        submission("accepted", { id: "accepted-1" }),
        northContext,
        eventQuery,
      ),
    ).toEqual({
      kind: "prepare-session",
      label: "Prepare for event",
      href: "/portal/tasks?event=event%2Fnorth&participant=speaker%20north&filter=mine",
    });
    expect(
      participantDashboardSubmissionPrimaryAction(
        submission("declined", { id: "declined-1" }),
        northContext,
        eventQuery,
      ),
    ).toMatchObject({ kind: "view-decision", label: "View decision" });
    expect(
      participantDashboardSubmissionPrimaryAction(
        submission("accepted", { id: "not-authorized" }),
        northContext,
        eventQuery,
      ),
    ).toBeNull();
    expect(
      participantDashboardSubmissionPrimaryAction(
        submission("accepted", { id: "accepted-1" }),
        context({ capabilities: ["submission-edit"] }),
        eventQuery,
      ),
    ).toMatchObject({ kind: "view-accepted-submission", label: "View accepted submission" });
  });

  it("opens speaker preparation only for an authorized accepted session with task access", () => {
    expect(speakerPreparationGate(northContext, northSubmissions, eventQuery)).toEqual({
      status: "available",
      acceptedSubmissionCount: 1,
      href: "/portal/tasks?event=event%2Fnorth&participant=speaker%20north&filter=mine",
      reason: null,
    });
    expect(
      speakerPreparationGate(
        context({ capabilities: ["submission-edit"] }),
        northSubmissions,
        eventQuery,
      ),
    ).toEqual({
      status: "unavailable",
      acceptedSubmissionCount: 1,
      href: null,
      reason: "task-response-unavailable",
    });
    expect(
      speakerPreparationGate(
        northContext,
        [submission("accepted", { id: "not-authorized" })],
        eventQuery,
      ),
    ).toEqual({
      status: "unavailable",
      acceptedSubmissionCount: 0,
      href: null,
      reason: "no-accepted-sessions",
    });
  });

  it("scopes direct session and participant tasks to an admitted, capable speaker", () => {
    const sessionTask = task({
      id: "session-task",
      subject: { type: "session", sessionId: "program-session-1" },
    });
    const tasks = [
      task({ id: "completed", status: "completed" }),
      task({ id: "waived", status: "waived" }),
      task({ id: "awaiting-review", status: "submitted" }),
      task({ id: "blocked", status: "needs_changes", dependencyIds: ["awaiting-review"] }),
      sessionTask,
      task({ id: "different-event", eventId: "event/south" }),
      task({ id: "different-speaker", participantId: "speaker-south" }),
    ];
    const scoped = selectParticipantDashboardTasks(
      context({ submissionIds: ["unrelated-cfp-submission"] }),
      tasks,
    );

    expect(scoped.map(({ id }) => id)).toEqual([
      "completed",
      "waived",
      "awaiting-review",
      "blocked",
      "session-task",
    ]);
    expect(selectParticipantDashboardTasks(context({ capabilities: [] }), tasks)).toEqual([]);
    expect(
      selectParticipantDashboardTasks(
        context({ participantIds: ["speaker-south"], authorizedParticipantIds: ["speaker-south"] }),
        tasks,
      ),
    ).toEqual([]);
    expect(summarizeParticipantDashboardTasks(scoped)).toEqual({
      totalTaskCount: 5,
      finishedTaskCount: 2,
      outstandingTaskCount: 3,
      attentionTaskCount: 2,
      blockedTaskCount: 1,
      completionPercent: 40,
      state: "action-required",
    });
    expect(summarizeParticipantDashboardTasks([])).toEqual({
      totalTaskCount: 0,
      finishedTaskCount: 0,
      outstandingTaskCount: 0,
      attentionTaskCount: 0,
      blockedTaskCount: 0,
      completionPercent: 100,
      state: "not-assigned",
    });
    expect(summarizeParticipantDashboardTasks([task({ status: "submitted" })]).state).toBe(
      "awaiting-review",
    );
  });

  it("composes event-first dashboard rows from the same scoped selectors", () => {
    const dashboard = createParticipantDashboard({
      contexts: [northContext],
      submissions: northSubmissions,
      tasks: [task({ id: "finish", status: "completed" }), task({ id: "start" })],
      eventQuery,
    });

    expect(dashboard.events).toHaveLength(1);
    expect(dashboard.events[0]).toMatchObject({
      eventQuery: "?event=event%2Fnorth&participant=speaker%20north&filter=mine",
      acceptedSessions: { available: true, acceptedSubmissionCount: 1 },
      speakerPreparation: { status: "available" },
      taskSummary: {
        totalTaskCount: 2,
        outstandingTaskCount: 1,
        completionPercent: 50,
        state: "action-required",
      },
    });
    expect(dashboard.events[0]?.submissions.map(({ primaryAction }) => primaryAction.kind)).toEqual(
      ["prepare-session", "review-draft", "view-submission", "view-decision"],
    );
  });
});
