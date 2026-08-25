import { formatUploadMimeTypes } from "@eventloom/contracts";
import { formatPortalFileSize } from "./portal-ui-model";
import type { PortalProfile, PortalTask, PortalTaskSubject } from "./types";

type RuntimeRecord = Record<string, unknown>;

export function asTaskRecord(value: unknown): RuntimeRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RuntimeRecord)
    : null;
}

export function taskString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export type TaskSubject = PortalTaskSubject;
export type TaskSubjectResolution =
  | { subject: TaskSubject; error: null }
  | { subject: null; error: string };

export function resolveTaskSubject(task: PortalTask): TaskSubjectResolution {
  const record = asTaskRecord(task);
  if (!taskString(record?.participantId)) {
    return { subject: null, error: "Task subject metadata is missing a participant." };
  }
  const subject = asTaskRecord(record?.subject);
  if (!subject) {
    return { subject: null, error: "Task subject metadata is missing." };
  }
  if (subject.type === "participant") {
    return { subject: { type: "participant" }, error: null };
  }
  const sessionId = taskString(subject.sessionId);
  return subject.type === "session" && sessionId
    ? { subject: { type: "session", sessionId }, error: null }
    : { subject: null, error: "Task subject metadata is invalid." };
}

export interface TaskSubjectPresentation {
  label: string;
  description: string;
  error: string | null;
}

export function taskSubjectPresentation(
  task: PortalTask,
  profiles: readonly PortalProfile[],
): TaskSubjectPresentation {
  const resolution = resolveTaskSubject(task);
  if (!resolution.subject) {
    return {
      label: "Subject unavailable",
      description: "This task cannot be safely scoped.",
      error: resolution.error,
    };
  }
  if (resolution.subject.type === "participant") {
    const profile = profiles.find(
      (candidate) =>
        candidate.eventId === task.eventId && candidate.participantId === task.participantId,
    );
    const name =
      profile?.displayName ?? taskString(asTaskRecord(task)?.participantName) ?? task.participantId;
    return {
      label: `Participant · ${name}`,
      description: "Applies to your participant profile across accepted sessions.",
      error: null,
    };
  }
  const sessionTitle = taskString(asTaskRecord(task)?.sessionTitle);
  return sessionTitle
    ? {
        label: `Session · ${sessionTitle}`,
        description: "Applies only to this accepted program session.",
        error: null,
      }
    : {
        label: "Session unavailable",
        description: "The accepted program session could not be found.",
        error: "This session-scoped task has no matching accepted program session.",
      };
}

export type TaskUploadPolicy =
  | { valid: true; allowedMimeTypes: readonly string[]; maxBytes: number; error: null }
  | { valid: false; allowedMimeTypes: readonly string[]; maxBytes: number | null; error: string };

export function getTaskUploadPolicy(task: PortalTask): TaskUploadPolicy {
  const record = asTaskRecord(task);
  const rawTypes = record?.allowedMimeTypes;
  const allowedMimeTypes = Array.isArray(rawTypes)
    ? rawTypes.flatMap((value): string[] => {
        if (typeof value !== "string") return [];
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
      })
    : [];
  if (
    !Array.isArray(rawTypes) ||
    rawTypes.length === 0 ||
    allowedMimeTypes.length !== rawTypes.length
  ) {
    return {
      valid: false,
      allowedMimeTypes,
      maxBytes: null,
      error: "Upload policy unavailable: the server did not provide a valid MIME allowlist.",
    };
  }
  const maxBytes = record?.maxBytes;
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return {
      valid: false,
      allowedMimeTypes,
      maxBytes: null,
      error: "Upload policy unavailable: the server did not provide a valid byte limit.",
    };
  }
  return { valid: true, allowedMimeTypes, maxBytes, error: null };
}

export function mimeTypeAllowed(contentType: string, allowed: readonly string[]): boolean {
  const normalized = contentType.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    allowed.some((value) => {
      const candidate = value.trim().toLowerCase();
      return (
        candidate === normalized ||
        candidate === "*/*" ||
        (candidate.endsWith("/*") && normalized.startsWith(candidate.slice(0, -1)))
      );
    })
  );
}

export function validateTaskUpload(
  file: Pick<File, "type" | "size">,
  policy: TaskUploadPolicy,
): { valid: true } | { valid: false; error: string } {
  if (!policy.valid) return { valid: false, error: policy.error };
  if (!mimeTypeAllowed(file.type, policy.allowedMimeTypes)) {
    return {
      valid: false,
      error: `This file type is not allowed. Accepted types: ${formatUploadMimeTypes(policy.allowedMimeTypes)}.`,
    };
  }
  if (!Number.isFinite(file.size) || file.size < 0 || file.size > policy.maxBytes) {
    return {
      valid: false,
      error: `This file exceeds the ${formatPortalFileSize(policy.maxBytes)} task limit.`,
    };
  }
  return { valid: true };
}

const urgency: Record<PortalTask["status"], number> = {
  needs_changes: 0,
  reopened: 1,
  overdue: 2,
  not_started: 3,
  in_progress: 4,
  submitted: 5,
  completed: 6,
  waived: 7,
};

export function sortTasksByUrgency(tasks: readonly PortalTask[]): PortalTask[] {
  return [...tasks].sort((left, right) => {
    const status = urgency[left.status] - urgency[right.status];
    if (status !== 0) return status;
    const leftDue = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY;
    const rightDue = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY;
    if (leftDue !== rightDue) return leftDue - rightDue;
    return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
}

export function actionTaskPresentation(task: PortalTask) {
  return {
    content: task.description?.trim() || "Complete the organizer-provided action for this event.",
    actionLabel: "Confirm completion",
  } as const;
}

export function portalTaskGroup(task: PortalTask): "content-requests" | "other-event-tasks" {
  return task.type === "action" ? "other-event-tasks" : "content-requests";
}
