import { type PortalApi, PortalApiError } from "../api";
import type { PortalProfile, PortalTask, PortalTaskStatus, PortalView } from "../types";

const INITIAL_TIMESTAMP = "2026-08-08T12:00:00.000Z";
const MUTATION_TIMESTAMPS = [
  "2026-08-08T12:01:00.000Z",
  "2026-08-08T12:02:00.000Z",
  "2026-08-08T12:03:00.000Z",
  "2026-08-08T12:04:00.000Z",
  "2026-08-08T12:05:00.000Z",
] as const;

function createSeedView(eventId: string): PortalView {
  const participantId = "demo-participant-ada";
  const submissionId = "demo-submission-resilient-events";
  const sessionId = "demo-session-resilient-events";

  return {
    submissions: [
      {
        id: submissionId,
        eventId,
        title: "Building resilient event systems",
        status: "accepted",
        participantIds: [participantId],
        updatedAt: INITIAL_TIMESTAMP,
      },
      {
        id: "demo-submission-accessible-programs",
        eventId,
        title: "Practical accessibility for live programs",
        status: "under_review",
        participantIds: [participantId],
        updatedAt: INITIAL_TIMESTAMP,
      },
    ],
    sessions: [
      {
        sessionId,
        title: "Building resilient event systems",
        status: "confirmed",
        version: 1,
      },
    ],
    profiles: [
      {
        id: "demo-profile-ada",
        eventId,
        participantId,
        displayName: "Ada Lovelace",
        biography:
          "Staff engineer and educator focused on resilient systems, accessible events, and calm incident response.",
        version: 1,
        updatedAt: INITIAL_TIMESTAMP,
      },
    ],
    tasks: [
      {
        id: "demo-task-agreement",
        eventId,
        subject: { type: "session", sessionId },
        participantId,
        type: "action",
        owner: "speaker",
        title: "Confirm speaker agreement",
        description: "Review and accept the event speaker agreement.",
        status: "not_started",
        dueAt: "2026-08-20T23:59:00.000Z",
        dependencyIds: [],
        reminderOffsetsMinutes: [10080, 1440],
        version: 1,
        updatedAt: INITIAL_TIMESTAMP,
      },
      {
        id: "demo-task-headshot",
        eventId,
        subject: { type: "session", sessionId },
        participantId,
        type: "upload",
        owner: "speaker",
        title: "Upload a headshot",
        description: "Add a high-resolution headshot for the public speaker gallery.",
        status: "not_started",
        dueAt: "2026-08-22T23:59:00.000Z",
        dependencyIds: ["demo-task-agreement"],
        reminderOffsetsMinutes: [10080, 1440],
        acceptedAssetKinds: ["headshot"],
        version: 1,
        updatedAt: INITIAL_TIMESTAMP,
      },
      {
        id: "demo-task-slides",
        eventId,
        subject: { type: "session", sessionId },
        participantId,
        type: "upload",
        owner: "speaker",
        title: "Upload presentation slides",
        description: "Share the presentation deck for the event production team.",
        status: "in_progress",
        dueAt: "2026-08-28T23:59:00.000Z",
        dependencyIds: [],
        reminderOffsetsMinutes: [4320, 1440],
        acceptedAssetKinds: ["slides"],
        version: 2,
        updatedAt: INITIAL_TIMESTAMP,
      },
      {
        id: "demo-task-profile",
        eventId,
        subject: { type: "session", sessionId },
        participantId,
        type: "form",
        owner: "speaker",
        title: "Review speaker profile",
        description: "Confirm the biography shown in the public program.",
        status: "completed",
        dependencyIds: [],
        reminderOffsetsMinutes: [],
        version: 2,
        updatedAt: INITIAL_TIMESTAMP,
      },
    ],
    outstandingTaskCount: 3,
  };
}

function cloneProfile(profile: PortalProfile): PortalProfile {
  return { ...profile };
}

function cloneTask(task: PortalTask): PortalTask {
  return {
    ...task,
    dependencyIds: [...task.dependencyIds],
    reminderOffsetsMinutes: [...task.reminderOffsetsMinutes],
    ...(task.acceptedAssetKinds === undefined
      ? {}
      : { acceptedAssetKinds: [...task.acceptedAssetKinds] }),
  };
}

function cloneView(view: PortalView): PortalView {
  return {
    submissions: view.submissions.map((submission) => ({
      ...submission,
      participantIds: [...submission.participantIds],
    })),
    sessions: view.sessions.map((session) => ({ ...session })),
    profiles: view.profiles.map(cloneProfile),
    tasks: view.tasks.map(cloneTask),
    outstandingTaskCount: view.outstandingTaskCount,
  };
}

function isComplete(status: PortalTaskStatus): boolean {
  return status === "completed" || status === "waived";
}

function isTransitionAllowed(task: PortalTask, toStatus: PortalTaskStatus): boolean {
  if (toStatus === "in_progress") {
    return ["not_started", "needs_changes", "overdue", "reopened"].includes(task.status);
  }
  if (toStatus === "submitted") {
    return (
      task.type !== "action" &&
      ["in_progress", "needs_changes", "overdue", "reopened"].includes(task.status)
    );
  }
  if (toStatus === "completed") {
    return (
      task.type === "action" &&
      ["not_started", "in_progress", "overdue", "reopened"].includes(task.status)
    );
  }
  return false;
}

function notFound(): PortalApiError {
  return new PortalApiError("NOT_FOUND", "The requested speaker resource was not found.", 404);
}

function versionConflict(message: string): PortalApiError {
  return new PortalApiError("VERSION_CONFLICT", message, 409);
}

export function createLocalPortalDemoApi(eventId: string): PortalApi {
  let view = createSeedView(eventId);
  let mutationIndex = 0;

  function mutationTimestamp(): string {
    const timestamp = MUTATION_TIMESTAMPS[mutationIndex] ?? MUTATION_TIMESTAMPS.at(-1);
    mutationIndex += 1;
    return timestamp ?? INITIAL_TIMESTAMP;
  }

  function requireEvent(requestedEventId: string): void {
    if (requestedEventId !== eventId) {
      throw notFound();
    }
  }

  function requireTask(taskId: string): PortalTask {
    const task = view.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw notFound();
    }
    return task;
  }

  return {
    async getPortal(requestedEventId) {
      requireEvent(requestedEventId);
      return cloneView(view);
    },

    async updateBiography(input) {
      requireEvent(input.eventId);
      const profile = view.profiles.find(
        (candidate) => candidate.participantId === input.participantId,
      );
      if (!profile) {
        throw notFound();
      }
      if (profile.version !== input.expectedVersion) {
        throw versionConflict("The speaker profile has changed. Reload it before saving.");
      }
      const updated: PortalProfile = {
        ...profile,
        biography: input.biography,
        version: profile.version + 1,
        updatedAt: mutationTimestamp(),
      };
      view = {
        ...view,
        profiles: view.profiles.map((candidate) =>
          candidate.participantId === updated.participantId ? updated : candidate,
        ),
      };
      return cloneProfile(updated);
    },

    async transitionTask(input) {
      requireEvent(input.eventId);
      const task = requireTask(input.taskId);
      if (task.version !== input.expectedVersion) {
        throw versionConflict("The speaker task has changed. Reload it before saving.");
      }
      const dependenciesComplete = task.dependencyIds.every((dependencyId) => {
        const dependency = view.tasks.find((candidate) => candidate.id === dependencyId);
        return dependency !== undefined && isComplete(dependency.status);
      });
      if (!dependenciesComplete) {
        throw new PortalApiError(
          "TASK_DEPENDENCY_INCOMPLETE",
          "Complete the prerequisite task before updating this task.",
          409,
        );
      }
      if (!isTransitionAllowed(task, input.toStatus)) {
        throw new PortalApiError(
          "INVALID_TASK_TRANSITION",
          "This task transition is not available to the speaker.",
          409,
        );
      }
      const updated: PortalTask = {
        ...task,
        status: input.toStatus,
        version: task.version + 1,
        updatedAt: mutationTimestamp(),
      };
      const tasks = view.tasks.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      );
      view = {
        ...view,
        tasks,
        outstandingTaskCount: tasks.filter((candidate) => !isComplete(candidate.status)).length,
      };
      return cloneTask(updated);
    },

    async uploadTaskFile(input) {
      requireEvent(input.eventId);
      const task = requireTask(input.taskId);
      if (
        task.participantId !== input.participantId ||
        task.type !== "upload" ||
        !task.acceptedAssetKinds?.includes(input.kind)
      ) {
        throw new PortalApiError(
          "UPLOAD_POLICY_VIOLATION",
          "This file is not accepted for the selected speaker task.",
          400,
        );
      }
      const assetId = `demo-asset-${task.id}-${input.kind}`;
      return {
        id: assetId,
        eventId: input.eventId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        participantId: input.participantId,
        taskId: input.taskId,
        kind: input.kind,
        fileName: input.file.name,
        contentType: input.file.type || "application/octet-stream",
        sizeBytes: input.file.size,
        state: "pending_upload",
        createdAt: mutationTimestamp(),
        version: 1,
        versionFamilyId: assetId,
        versionId: assetId,
        latestVersionId: assetId,
      };
    },
  };
}
