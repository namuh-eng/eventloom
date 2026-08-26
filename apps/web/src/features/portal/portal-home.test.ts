import { describe, expect, it } from "vitest";
import {
  portalHomeReadinessPresentation,
  selectNextOutstandingPortalTask,
} from "./portal-home-model";
import type { PortalTask } from "./types";

function task(overrides: Partial<PortalTask> = {}): PortalTask {
  return {
    id: "task-1",
    eventId: "event-1",
    subject: { type: "session", sessionId: "session-1" },
    participantId: "participant-1",
    type: "action",
    owner: "speaker",
    title: "Complete profile",
    status: "not_started",
    dependencyIds: [],
    reminderOffsetsMinutes: [],
    version: 1,
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("portal home readiness", () => {
  it("keeps zero tasks neutral and reserves Ready for completed non-empty work", () => {
    expect(portalHomeReadinessPresentation("no-tasks")).toEqual({
      label: "No tasks",
      tone: "neutral",
      nextHeading: "No speaker tasks assigned",
      nextDescription: "The event team has not assigned any speaker tasks yet.",
    });
    expect(portalHomeReadinessPresentation("in-progress").label).toBe("In progress");
    expect(portalHomeReadinessPresentation("ready")).toMatchObject({
      label: "Ready",
      tone: "success",
      nextHeading: "You are ready for the event",
    });
  });
});

describe("selectNextOutstandingPortalTask", () => {
  it("prefers an actionable task over an earlier dependency-blocked task", () => {
    const blocked = task({ id: "blocked", dependencyIds: ["required"] });
    const actionable = task({ id: "actionable" });
    const required = task({ id: "required", status: "in_progress" });

    expect(selectNextOutstandingPortalTask([blocked, actionable, required])?.id).toBe("actionable");
  });

  it("returns an outstanding blocked task when no task is actionable", () => {
    const blocked = task({ id: "blocked", dependencyIds: ["required"] });

    expect(selectNextOutstandingPortalTask([blocked])?.id).toBe("blocked");
  });

  it("returns no task after every task is complete or waived", () => {
    expect(
      selectNextOutstandingPortalTask([
        task({ status: "completed" }),
        task({ id: "waived", status: "waived" }),
      ]),
    ).toBeUndefined();
  });
});
