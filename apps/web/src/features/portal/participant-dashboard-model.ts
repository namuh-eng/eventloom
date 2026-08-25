import {
  isTaskBlocked,
  isTaskFinished,
  portalSubmissionIdsMatch,
  taskNeedsAttention,
} from "./model";
import type { PortalContext, PortalSubmission, PortalSubmissionStatus, PortalTask } from "./types";

export interface ParticipantDashboardContextGroup {
  readonly context: PortalContext;
  readonly submissions: readonly PortalSubmission[];
}

export interface ParticipantDashboardSubmissionStateSummary {
  readonly totalCount: number;
  readonly byStatus: Readonly<Record<PortalSubmissionStatus, number>>;
}

export interface ParticipantDashboardAcceptedSessionAvailability {
  /** This only reflects accepted submissions; it makes no schedule claim. */
  readonly available: boolean;
  readonly acceptedSubmissionCount: number;
}

export type ParticipantDashboardSpeakerPreparationGate =
  | {
      readonly status: "available";
      readonly acceptedSubmissionCount: number;
      readonly href: string;
      readonly reason: null;
    }
  | {
      readonly status: "unavailable";
      readonly acceptedSubmissionCount: number;
      readonly href: null;
      readonly reason: "no-accepted-sessions" | "task-response-unavailable";
    };

export type ParticipantDashboardSubmissionPrimaryAction =
  | {
      readonly kind: "review-draft";
      readonly label: "Review draft";
      readonly href: string;
    }
  | {
      readonly kind: "view-submission";
      readonly label: "View submission";
      readonly href: string;
    }
  | {
      readonly kind: "prepare-session";
      readonly label: "Prepare for event";
      readonly href: string;
    }
  | {
      readonly kind: "view-accepted-submission";
      readonly label: "View accepted submission";
      readonly href: string;
    }
  | {
      readonly kind: "view-decision";
      readonly label: "View decision";
      readonly href: string;
    };

export type ParticipantDashboardTaskReadiness =
  | "not-assigned"
  | "action-required"
  | "awaiting-review"
  | "complete";

export interface ParticipantDashboardTaskSummary {
  readonly totalTaskCount: number;
  readonly finishedTaskCount: number;
  readonly outstandingTaskCount: number;
  readonly attentionTaskCount: number;
  readonly blockedTaskCount: number;
  /** Completion only describes assigned speaker tasks, not schedule or agreement readiness. */
  readonly completionPercent: number;
  readonly state: ParticipantDashboardTaskReadiness;
}

export interface ParticipantDashboardSubmission {
  readonly submission: PortalSubmission;
  readonly primaryAction: ParticipantDashboardSubmissionPrimaryAction;
}

export interface ParticipantDashboardEvent {
  readonly context: PortalContext;
  readonly eventQuery: string;
  readonly submissions: readonly ParticipantDashboardSubmission[];
  readonly submissionSummary: ParticipantDashboardSubmissionStateSummary;
  readonly acceptedSessions: ParticipantDashboardAcceptedSessionAvailability;
  readonly speakerPreparation: ParticipantDashboardSpeakerPreparationGate;
  readonly tasks: readonly PortalTask[];
  readonly taskSummary: ParticipantDashboardTaskSummary;
}

export interface ParticipantDashboardInput {
  readonly contexts: readonly PortalContext[];
  readonly submissions: readonly PortalSubmission[];
  readonly tasks: readonly PortalTask[];
  /** Existing query parameters from the current portal location, including an optional leading '?'. */
  readonly eventQuery?: string;
}

export interface ParticipantDashboard {
  readonly events: readonly ParticipantDashboardEvent[];
}

function hasTaskResponseCapability(context: PortalContext): boolean {
  return context.capabilities.includes("task-response");
}

function normalizedEventId(context: Pick<PortalContext, "eventId">): string | null {
  const eventId = context.eventId.trim();
  return eventId.length > 0 ? eventId : null;
}

function submissionIsAuthorizedForContext(
  context: PortalContext,
  submission: PortalSubmission,
): boolean {
  const eventId = normalizedEventId(context);
  return (
    eventId !== null &&
    submission.eventId === eventId &&
    context.submissionIds.some((submissionId) =>
      portalSubmissionIdsMatch(submissionId, submission.id),
    )
  );
}

function serializeQuery(query: URLSearchParams): string {
  return [...query.entries()]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function mergeQuery(pathQuery: string, eventQuery: string | undefined): URLSearchParams {
  const query = new URLSearchParams(pathQuery);
  const contextQuery = new URLSearchParams(eventQuery?.replace(/^\?/, "") ?? "");
  contextQuery.forEach((value, key) => {
    if (!query.has(key)) query.append(key, value);
  });
  return query;
}

/**
 * Builds an event-scoped portal href while preserving unrelated current query parameters.
 * When either event key already exists, it is retained with the authorized context's event ID.
 */
export function participantDashboardHref(
  href: string,
  context: Pick<PortalContext, "eventId">,
  eventQuery?: string,
): string {
  const hashIndex = href.indexOf("#");
  const hrefWithoutHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex);
  const queryIndex = hrefWithoutHash.indexOf("?");
  const path = queryIndex === -1 ? hrefWithoutHash : hrefWithoutHash.slice(0, queryIndex);
  const pathQuery = queryIndex === -1 ? "" : hrefWithoutHash.slice(queryIndex + 1);
  const query = mergeQuery(pathQuery, eventQuery);
  const eventId = normalizedEventId(context);

  if (eventId !== null) {
    if (query.has("eventId")) query.set("eventId", eventId);
    query.set("event", eventId);
  }

  const serialized = serializeQuery(query);
  return `${path}${serialized.length > 0 ? `?${serialized}` : ""}${hash}`;
}

export function participantDashboardEventQuery(
  context: Pick<PortalContext, "eventId">,
  eventQuery?: string,
): string {
  const href = participantDashboardHref("/portal", context, eventQuery);
  const queryIndex = href.indexOf("?");
  return queryIndex === -1 ? "" : href.slice(queryIndex);
}

/** Returns only submissions that are both event-scoped and explicitly authorized by the context. */
export function selectParticipantDashboardSubmissions(
  context: PortalContext,
  submissions: readonly PortalSubmission[],
): PortalSubmission[] {
  return submissions.filter((submission) => submissionIsAuthorizedForContext(context, submission));
}

/** Keeps every authorized context, including valid contexts that currently have no submissions. */
export function groupParticipantDashboardContexts(
  contexts: readonly PortalContext[],
  submissions: readonly PortalSubmission[],
): ParticipantDashboardContextGroup[] {
  return contexts
    .filter((context) => normalizedEventId(context) !== null)
    .map((context) => ({
      context,
      submissions: selectParticipantDashboardSubmissions(context, submissions),
    }));
}

export function summarizeSubmissionStates(
  submissions: readonly PortalSubmission[],
): ParticipantDashboardSubmissionStateSummary {
  const byStatus: Record<PortalSubmissionStatus, number> = {
    draft: 0,
    submitted: 0,
    under_review: 0,
    accepted: 0,
    declined: 0,
    withdrawn: 0,
  };
  for (const submission of submissions) {
    byStatus[submission.status] += 1;
  }
  return { totalCount: submissions.length, byStatus };
}

/** Accepted availability is intentionally limited to submission decisions, not program scheduling. */
export function acceptedSessionAvailability(
  submissions: readonly PortalSubmission[],
): ParticipantDashboardAcceptedSessionAvailability {
  const acceptedSubmissionCount = submissions.filter(
    (submission) => submission.status === "accepted",
  ).length;
  return { available: acceptedSubmissionCount > 0, acceptedSubmissionCount };
}

export function speakerPreparationGate(
  context: PortalContext,
  submissions: readonly PortalSubmission[],
  eventQuery?: string,
): ParticipantDashboardSpeakerPreparationGate {
  const acceptedSessions = acceptedSessionAvailability(
    selectParticipantDashboardSubmissions(context, submissions),
  );
  if (!acceptedSessions.available) {
    return {
      status: "unavailable",
      acceptedSubmissionCount: 0,
      href: null,
      reason: "no-accepted-sessions",
    };
  }
  if (!hasTaskResponseCapability(context)) {
    return {
      status: "unavailable",
      acceptedSubmissionCount: acceptedSessions.acceptedSubmissionCount,
      href: null,
      reason: "task-response-unavailable",
    };
  }
  return {
    status: "available",
    acceptedSubmissionCount: acceptedSessions.acceptedSubmissionCount,
    href: participantDashboardHref("/portal/tasks", context, eventQuery),
    reason: null,
  };
}

function submissionHref(
  submission: PortalSubmission,
  context: PortalContext,
  eventQuery?: string,
): string {
  return participantDashboardHref(
    `/portal/submissions/${encodeURIComponent(submission.id)}`,
    context,
    eventQuery,
  );
}

function primaryActionForAuthorizedSubmission(
  submission: PortalSubmission,
  context: PortalContext,
  eventQuery?: string,
): ParticipantDashboardSubmissionPrimaryAction {
  const href = submissionHref(submission, context, eventQuery);
  switch (submission.status) {
    case "draft":
      return { kind: "review-draft", label: "Review draft", href };
    case "submitted":
    case "under_review":
    case "withdrawn":
      return { kind: "view-submission", label: "View submission", href };
    case "accepted":
      return hasTaskResponseCapability(context)
        ? {
            kind: "prepare-session",
            label: "Prepare for event",
            href: participantDashboardHref("/portal/tasks", context, eventQuery),
          }
        : { kind: "view-accepted-submission", label: "View accepted submission", href };
    case "declined":
      return { kind: "view-decision", label: "View decision", href };
  }
}

/**
 * Picks an action only for an authorized submission. Drafts and decisions point to their persisted
 * portal detail because the portal contract does not guarantee a CFP editor for either state.
 */
export function participantDashboardSubmissionPrimaryAction(
  submission: PortalSubmission,
  context: PortalContext,
  eventQuery?: string,
): ParticipantDashboardSubmissionPrimaryAction | null {
  if (!submissionIsAuthorizedForContext(context, submission)) return null;
  return primaryActionForAuthorizedSubmission(submission, context, eventQuery);
}

function selectedAuthorizedParticipantId(context: PortalContext): string | null {
  const selectedParticipantId =
    context.selectedParticipantId?.trim() || context.primaryParticipantId?.trim() || "";
  if (!selectedParticipantId) return null;
  const authorizedParticipantIds = context.authorizedParticipantIds ?? context.participantIds;
  return authorizedParticipantIds.some(
    (participantId) => participantId.trim() === selectedParticipantId,
  )
    ? selectedParticipantId
    : null;
}

/**
 * Scopes tasks to the selected, authorized speaker. Tasks are already account- and capability-
 * authorized by the server; their optional session subjects are program identity, not CFP authority.
 */
export function selectParticipantDashboardTasks(
  context: PortalContext,
  tasks: readonly PortalTask[],
): PortalTask[] {
  const eventId = normalizedEventId(context);
  const participantId = selectedAuthorizedParticipantId(context);
  if (eventId === null || participantId === null || !hasTaskResponseCapability(context)) return [];

  return tasks.filter(
    (task) =>
      task.eventId === eventId && task.owner === "speaker" && task.participantId === participantId,
  );
}

/**
 * Summarizes only assigned speaker-task progress. It deliberately has no schedule or agreement
 * status because neither is exposed by PortalTask.
 */
export function summarizeParticipantDashboardTasks(
  tasks: readonly PortalTask[],
): ParticipantDashboardTaskSummary {
  const finishedTaskCount = tasks.filter(isTaskFinished).length;
  const outstandingTasks = tasks.filter((task) => !isTaskFinished(task));
  const attentionTaskCount = outstandingTasks.filter(taskNeedsAttention).length;
  const blockedTaskCount = outstandingTasks.filter((task) => isTaskBlocked(task, tasks)).length;
  const outstandingTaskCount = outstandingTasks.length;
  const totalTaskCount = tasks.length;
  const state: ParticipantDashboardTaskReadiness =
    totalTaskCount === 0
      ? "not-assigned"
      : attentionTaskCount > 0
        ? "action-required"
        : outstandingTaskCount > 0
          ? "awaiting-review"
          : "complete";

  return {
    totalTaskCount,
    finishedTaskCount,
    outstandingTaskCount,
    attentionTaskCount,
    blockedTaskCount,
    completionPercent:
      totalTaskCount === 0 ? 100 : Math.round((finishedTaskCount / totalTaskCount) * 100),
    state,
  };
}

/** Builds event-first rows from the same authorization, decision, and task selectors. */
export function createParticipantDashboard(input: ParticipantDashboardInput): ParticipantDashboard {
  const events = groupParticipantDashboardContexts(input.contexts, input.submissions).map(
    (group) => {
      const tasks = selectParticipantDashboardTasks(group.context, input.tasks);
      return {
        context: group.context,
        eventQuery: participantDashboardEventQuery(group.context, input.eventQuery),
        submissions: group.submissions.map((submission) => ({
          submission,
          primaryAction: primaryActionForAuthorizedSubmission(
            submission,
            group.context,
            input.eventQuery,
          ),
        })),
        submissionSummary: summarizeSubmissionStates(group.submissions),
        acceptedSessions: acceptedSessionAvailability(group.submissions),
        speakerPreparation: speakerPreparationGate(
          group.context,
          group.submissions,
          input.eventQuery,
        ),
        tasks,
        taskSummary: summarizeParticipantDashboardTasks(tasks),
      } satisfies ParticipantDashboardEvent;
    },
  );

  return { events };
}
