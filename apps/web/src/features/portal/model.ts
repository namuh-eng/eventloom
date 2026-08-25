import {
  getCfpActiveSubmissionStorageKey,
  getCfpNewSubmissionIntentStorageKey,
  getCfpSubmissionPointerStorageKey,
} from "../cfp/draft-persistence";
import { getCfpStepRoute } from "../cfp/routes";
import type {
  PortalAsset,
  PortalContext,
  PortalProfile,
  PortalSubmission,
  PortalSubmissionStatus,
  PortalTask,
  PortalTaskStatus,
  PortalView,
} from "./types";

export interface StatusPresentation {
  label: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  description: string;
}

const submissionPresentations: Record<PortalSubmissionStatus, StatusPresentation> = {
  draft: {
    label: "Draft",
    tone: "neutral",
    description: "This proposal has not been submitted yet.",
  },
  submitted: {
    label: "Submitted",
    tone: "info",
    description: "Your proposal was received and is waiting for review.",
  },
  under_review: {
    label: "Under review",
    tone: "warning",
    description: "The program committee is reviewing your proposal.",
  },
  accepted: {
    label: "Accepted",
    tone: "success",
    description: "Congratulations! Complete your speaker tasks to prepare for the event.",
  },
  declined: {
    label: "Not selected",
    tone: "danger",
    description: "This proposal was not selected for the current program.",
  },
  withdrawn: {
    label: "Withdrawn",
    tone: "neutral",
    description: "This proposal has been withdrawn.",
  },
};

const taskPresentations: Record<PortalTaskStatus, StatusPresentation> = {
  not_started: {
    label: "Not started",
    tone: "neutral",
    description: "Ready when you are.",
  },
  in_progress: {
    label: "In progress",
    tone: "info",
    description: "Your changes are in progress.",
  },
  submitted: {
    label: "Submitted",
    tone: "info",
    description: "The event team will review this task.",
  },
  needs_changes: {
    label: "Needs changes",
    tone: "danger",
    description: "The event team requested an update.",
  },
  completed: {
    label: "Completed",
    tone: "success",
    description: "No further action is required.",
  },
  waived: {
    label: "Waived",
    tone: "neutral",
    description: "The event team waived this task.",
  },
  overdue: {
    label: "Overdue",
    tone: "danger",
    description: "This task is past its due date.",
  },
  reopened: {
    label: "Reopened",
    tone: "warning",
    description: "The event team reopened this task.",
  },
};

const finishedTaskStatuses = new Set<PortalTaskStatus>(["completed", "waived"]);
const attentionTaskStatuses = new Set<PortalTaskStatus>([
  "not_started",
  "in_progress",
  "needs_changes",
  "overdue",
  "reopened",
]);
const speakerSubmissionPrefix = "speaker-submission:";
function portalSubmissionIdValue(value: string): string | null {
  const normalized = value.trim();
  const submissionId = normalized.startsWith(speakerSubmissionPrefix)
    ? normalized.slice(speakerSubmissionPrefix.length)
    : normalized;
  return submissionId.length === 0 ? null : submissionId;
}

export function portalSubmissionIdsMatch(left: string, right: string): boolean {
  const normalizedLeft = portalSubmissionIdValue(left);
  const normalizedRight = portalSubmissionIdValue(right);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft === normalizedRight;
}

export function submissionStatusPresentation(status: PortalSubmissionStatus): StatusPresentation {
  return submissionPresentations[status];
}

export function taskStatusPresentation(status: PortalTaskStatus): StatusPresentation {
  return taskPresentations[status];
}

export function isTaskFinished(task: PortalTask): boolean {
  return finishedTaskStatuses.has(task.status);
}

export function taskNeedsAttention(task: PortalTask): boolean {
  return attentionTaskStatuses.has(task.status);
}

export function isTaskBlocked(task: PortalTask, tasks: readonly PortalTask[]): boolean {
  if (task.dependencyIds.length === 0) {
    return false;
  }

  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return task.dependencyIds.some((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return !dependency || !finishedTaskStatuses.has(dependency.status);
  });
}

export function taskPrimaryAction(
  task: PortalTask,
): "start" | "upload" | "submit" | "complete" | null {
  if (["completed", "waived", "submitted"].includes(task.status)) {
    return null;
  }
  if (["not_started", "overdue", "reopened"].includes(task.status)) {
    return task.type === "action" ? "complete" : "start";
  }
  if (task.type === "upload") {
    return "upload";
  }
  if (task.type === "action") {
    return "complete";
  }
  return "submit";
}

export function filterSubmissions(
  submissions: readonly PortalSubmission[],
  search: string,
): PortalSubmission[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) {
    return [...submissions];
  }
  return submissions.filter((submission) => submission.title.toLocaleLowerCase().includes(query));
}

export type TaskFilter = "all" | "attention" | "finished";

export function filterTasks(tasks: readonly PortalTask[], filter: TaskFilter): PortalTask[] {
  if (filter === "attention") {
    return tasks.filter(taskNeedsAttention);
  }
  if (filter === "finished") {
    return tasks.filter(isTaskFinished);
  }
  return [...tasks];
}

function normalizedIds(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.reduce<string[]>((normalized, value) => {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
    return normalized;
  }, []);
}

function authorizedSubmissionIds(
  context: PortalContext,
  requestedSubmissionIds?: readonly string[],
): string[] {
  const authorized = normalizedIds(context.submissionIds);
  const requested = normalizedIds(requestedSubmissionIds ?? authorized);
  return requested.filter((submissionId) =>
    authorized.some((authorizedId) => portalSubmissionIdsMatch(authorizedId, submissionId)),
  );
}

function participantIsAuthorized(context: PortalContext, participantId: string): boolean {
  const normalizedParticipantId = participantId.trim();
  const authorizedParticipantIds = context.authorizedParticipantIds ?? context.participantIds;
  return (
    context.eventId.trim().length > 0 &&
    normalizedParticipantId.length > 0 &&
    authorizedParticipantIds.some((authorizedId) => authorizedId === normalizedParticipantId)
  );
}

export function portalSelectedParticipantId(
  context: PortalContext | null | undefined,
  requestedParticipantId?: string | null,
): string | null {
  if (context === null || context === undefined || context.eventId.trim().length === 0) {
    return null;
  }
  const requested = requestedParticipantId?.trim();
  if (requested !== undefined && requested.length > 0) {
    return participantIsAuthorized(context, requested) ? requested : null;
  }
  const primary = context.primaryParticipantId?.trim();
  return primary !== undefined && participantIsAuthorized(context, primary) ? primary : null;
}

export function scopePortalContextToAuthorizedParticipants(
  context: PortalContext,
  selectedParticipantId?: string | null,
  submissionIds?: readonly string[],
): PortalContext {
  const participantIds = normalizedIds(context.authorizedParticipantIds ?? context.participantIds);
  const selected = portalSelectedParticipantId(
    { ...context, participantIds, authorizedParticipantIds: participantIds },
    selectedParticipantId ?? context.selectedParticipantId,
  );
  const primary = selected ?? portalSelectedParticipantId({ ...context, participantIds });
  const scopedSubmissionIds = authorizedSubmissionIds(context, submissionIds);
  return {
    ...context,
    eventId: context.eventId.trim(),
    participantIds,
    authorizedParticipantIds: participantIds,
    submissionIds: scopedSubmissionIds,
    ...(primary === null
      ? { selectedParticipantId: null }
      : { primaryParticipantId: primary, selectedParticipantId: primary }),
  };
}

/** Legacy primary-only projection retained for callers that intentionally request one participant. */
export function scopePortalContextToPrimaryParticipant(
  context: PortalContext,
  submissionIds?: readonly string[],
): PortalContext {
  const primary = context.primaryParticipantId?.trim();
  if (!primary || !participantIsAuthorized(context, primary)) {
    return {
      ...context,
      participantIds: [],
      authorizedParticipantIds: [],
      submissionIds: [],
      selectedParticipantId: null,
    };
  }
  const scoped = scopePortalContextToAuthorizedParticipants(context, primary, submissionIds);
  return {
    ...scoped,
    participantIds: [primary],
    authorizedParticipantIds: [primary],
    primaryParticipantId: primary,
    selectedParticipantId: primary,
  };
}

function emptyScopedPortalView(
  view: PortalView | null | undefined,
  _context: PortalContext | null | undefined,
  scopedContext: PortalContext | undefined,
): PortalView {
  const capabilities = view?.capabilities === undefined ? undefined : [...view.capabilities];
  return {
    submissions: [],
    profiles: [],
    tasks: [],
    outstandingTaskCount: 0,
    assets: [],
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(scopedContext === undefined ? {} : { context: scopedContext }),
  };
}

export function scopePortalViewToAuthorizedParticipants(
  view: PortalView | null | undefined,
  context: PortalContext | null | undefined,
  selectedParticipantId?: string | null,
): PortalView {
  const scopedContext =
    context === null || context === undefined
      ? undefined
      : scopePortalContextToAuthorizedParticipants(context, selectedParticipantId);
  if (view === null || view === undefined || scopedContext === undefined) {
    return emptyScopedPortalView(view, context, scopedContext);
  }

  const eventId = scopedContext.eventId;
  const selectedParticipant = scopedContext.selectedParticipantId ?? null;
  const authorizedIds = scopedContext.submissionIds;
  const participantIds = new Set(scopedContext.participantIds);
  const submissionMatches = (submissionId: string): boolean =>
    authorizedIds.some((authorizedId) => portalSubmissionIdsMatch(authorizedId, submissionId));
  const submissions = view.submissions.reduce<PortalSubmission[]>((filtered, submission) => {
    if (submission.eventId !== eventId || !submissionMatches(submission.id)) {
      return filtered;
    }
    filtered.push({
      ...submission,
      participantIds: submission.participantIds.filter((participantId) =>
        participantIds.has(participantId),
      ),
    });
    return filtered;
  }, []);
  const tasks =
    selectedParticipant === null || !scopedContext.capabilities.includes("task-response")
      ? []
      : view.tasks.filter(
          (task) =>
            task.eventId === eventId &&
            task.owner === "speaker" &&
            task.participantId === selectedParticipant,
        );
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const assets =
    selectedParticipant === null
      ? []
      : (view.assets ?? []).filter((asset) => {
          if (asset.eventId !== eventId || asset.participantId !== selectedParticipant) {
            return false;
          }
          if (asset.taskId === undefined) {
            return true;
          }
          const task = taskById.get(asset.taskId);
          return (
            task !== undefined &&
            (task.subject.type === "participant"
              ? asset.sessionId === undefined
              : asset.sessionId === task.subject.sessionId)
          );
        });

  return {
    submissions,
    profiles:
      selectedParticipant === null
        ? []
        : view.profiles.filter(
            (profile) =>
              profile.eventId === eventId && profile.participantId === selectedParticipant,
          ),
    tasks,
    outstandingTaskCount: tasks.filter((task) => !isTaskFinished(task)).length,
    assets,
    ...(view.roster !== undefined &&
    view.roster.eventId === eventId &&
    submissionMatches(view.roster.submissionId)
      ? {
          roster: {
            ...view.roster,
            capabilities: { ...view.roster.capabilities },
            members: view.roster.members.map((member) => ({
              ...member,
              capabilities: { ...member.capabilities },
            })),
          },
        }
      : {}),
    ...(view.resources === undefined
      ? {}
      : { resources: view.resources.map((resource) => ({ ...resource })) }),
    ...(view.wiki === undefined ? {} : { wiki: view.wiki.map((page) => ({ ...page })) }),
    ...(view.capabilities === undefined ? {} : { capabilities: [...view.capabilities] }),
    context: scopedContext,
  };
}

/** Legacy primary-only projection retained for existing task/file callers. */
export function scopePortalViewToPrimaryParticipant(
  view: PortalView | null | undefined,
  context: PortalContext | null | undefined,
): PortalView {
  const scopedContext =
    context === null || context === undefined
      ? undefined
      : scopePortalContextToPrimaryParticipant(context);
  const scoped = scopePortalViewToAuthorizedParticipants(
    view,
    scopedContext,
    scopedContext?.primaryParticipantId,
  );
  if (scopedContext === undefined || scopedContext.primaryParticipantId === undefined) {
    return scoped;
  }
  const primaryParticipantId = scopedContext.primaryParticipantId;
  const submissions = scoped.submissions.filter((submission) =>
    submission.participantIds.includes(primaryParticipantId),
  );
  const submissionIds = submissions.map((submission) => submission.id);
  const tasks = scoped.tasks;
  return {
    ...scoped,
    submissions,
    tasks,
    outstandingTaskCount: tasks.filter((task) => !isTaskFinished(task)).length,
    context: scopePortalContextToPrimaryParticipant(scopedContext, submissionIds),
  };
}

export function profileRevisionIsStrictlyIncreasing(
  previousVersion: number,
  returnedProfile: PortalProfile | null | undefined,
): boolean {
  return (
    returnedProfile !== null &&
    returnedProfile !== undefined &&
    Number.isInteger(returnedProfile.version) &&
    returnedProfile.version > previousVersion
  );
}

export type PortalProfileMutationClassification =
  | { state: "saved"; revision: number }
  | { state: "failure"; message: string };

export function classifyPortalProfileMutation(
  returnedProfile: PortalProfile | null | undefined,
  expected: { eventId: string; participantId: string; version: number },
): PortalProfileMutationClassification {
  if (returnedProfile === null || returnedProfile === undefined) {
    return {
      state: "failure",
      message: "The profile response did not include an authoritative profile.",
    };
  }
  if (
    returnedProfile.eventId !== expected.eventId ||
    returnedProfile.participantId !== expected.participantId
  ) {
    return {
      state: "failure",
      message: "The saved profile does not match the active speaker.",
    };
  }
  if (!profileRevisionIsStrictlyIncreasing(expected.version, returnedProfile)) {
    return {
      state: "failure",
      message: "The saved profile revision did not advance authoritatively.",
    };
  }
  return { state: "saved", revision: returnedProfile.version };
}

export function portalProfileHeadshot(
  profile: PortalProfile,
  assets: readonly PortalAsset[],
): PortalAsset | undefined {
  const linkedAssetId = profile.headshotAssetId;
  if (linkedAssetId === undefined || linkedAssetId === null) {
    return undefined;
  }
  return assets.find(
    (asset) =>
      asset.id === linkedAssetId &&
      asset.eventId === profile.eventId &&
      asset.participantId === profile.participantId &&
      asset.kind === "headshot",
  );
}

export function portalTaskAsset(
  task: PortalTask,
  assets: readonly PortalAsset[],
): PortalAsset | undefined {
  const candidates = assets.filter(
    (asset) =>
      asset.taskId === task.id &&
      asset.eventId === task.eventId &&
      asset.participantId === task.participantId &&
      (task.subject.type === "participant"
        ? asset.sessionId === undefined
        : asset.sessionId === task.subject.sessionId),
  );
  return candidates.reduce<PortalAsset | undefined>((latest, candidate) => {
    if (latest === undefined) {
      return candidate;
    }
    const versionDifference = (candidate.version ?? 0) - (latest.version ?? 0);
    if (versionDifference !== 0) {
      return versionDifference > 0 ? candidate : latest;
    }
    if (candidate.createdAt !== latest.createdAt) {
      return candidate.createdAt > latest.createdAt ? candidate : latest;
    }
    return candidate.id > latest.id ? candidate : latest;
  }, undefined);
}

export function portalIdentityProfile(
  view: PortalView | null | undefined,
  context: PortalContext | null,
): PortalProfile | undefined {
  const primaryParticipantId = context?.primaryParticipantId;
  if (!primaryParticipantId) {
    return undefined;
  }
  return view?.profiles.find(
    (candidate) =>
      candidate.participantId === primaryParticipantId && candidate.eventId === context.eventId,
  );
}
export function portalSubmissionEditTarget(
  context: PortalContext | null,
  submission: PortalSubmission,
): {
  href: string;
  pointerKey: string;
  activePointerKey: string;
  newSubmissionIntentKey: string;
} | null {
  if (
    context === null ||
    submission.formId === undefined ||
    !["draft", "submitted", "under_review"].includes(submission.status) ||
    submission.eventId !== context.eventId ||
    !context.submissionIds.some((authorizedId) =>
      portalSubmissionIdsMatch(authorizedId, submission.id),
    )
  ) {
    return null;
  }
  const participantIds = new Set(context.participantIds);
  if (!submission.participantIds.some((participantId) => participantIds.has(participantId))) {
    return null;
  }
  const eventSlug = context.slug?.trim() || context.eventId;
  const organizationId = context.organizationId?.trim() || context.id.split(":")[1]?.trim();
  if (!organizationId) return null;
  return {
    href: getCfpStepRoute(organizationId, eventSlug, "submission"),
    pointerKey: getCfpSubmissionPointerStorageKey(
      organizationId,
      context.eventId,
      submission.formId,
    ),
    activePointerKey: getCfpActiveSubmissionStorageKey(
      organizationId,
      context.eventId,
      submission.formId,
    ),
    newSubmissionIntentKey: getCfpNewSubmissionIntentStorageKey(
      organizationId,
      context.eventId,
      submission.formId,
    ),
  };
}

export type PortalReadinessState = "no-tasks" | "in-progress" | "ready";

export interface PortalSummary {
  submissionCount: number;
  acceptedCount: number;
  taskCount: number;
  outstandingTaskCount: number;
  completedTaskCount: number;
  completionPercent: number | null;
  readinessState: PortalReadinessState;
}

export function summarizePortal(view: PortalView): PortalSummary {
  const taskCount = view.tasks.length;
  const completedTaskCount = view.tasks.filter(isTaskFinished).length;
  const outstandingTaskCount = taskCount - completedTaskCount;
  return {
    submissionCount: view.submissions.length,
    acceptedCount: view.submissions.filter((submission) => submission.status === "accepted").length,
    taskCount,
    outstandingTaskCount,
    completedTaskCount,
    completionPercent: taskCount === 0 ? null : Math.round((completedTaskCount / taskCount) * 100),
    readinessState:
      taskCount === 0 ? "no-tasks" : outstandingTaskCount === 0 ? "ready" : "in-progress",
  };
}

export type BiographyValidation =
  | { success: true; biography: string }
  | { success: false; message: string };

export function validateBiography(value: string): BiographyValidation {
  const biography = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  const hasDisallowedControl = [...biography].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint === 0x7f || (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a))
    );
  });

  if (biography.length > 5_000) {
    return { success: false, message: "Biography must be 5,000 characters or fewer." };
  }
  if (hasDisallowedControl) {
    return { success: false, message: "Biography contains an unsupported control character." };
  }
  return { success: true, biography };
}
