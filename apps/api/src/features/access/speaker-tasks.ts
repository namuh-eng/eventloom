import type { UserPrincipal } from "../auth/types";
import { capabilityAllows } from "../speaker/capabilities";
import type { SpeakerAccessScope, SpeakerTaskStatus } from "../speaker/types";

export interface AccountSpeakerScope
  extends Pick<SpeakerAccessScope, "capabilities" | "capabilitiesByParticipant"> {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly participantIds: readonly string[];
  readonly submissionIds: readonly string[];
}

export interface AccountSpeakerSession {
  readonly tenantId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly speakerIds: readonly string[];
}

export interface AccountSpeakerTaskRecord {
  readonly organizationId: string;
  readonly eventId: string;
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly participantId: string;
  readonly owner: "speaker" | "organizer";
  readonly title: string;
  readonly dueAt: string | null;
  readonly status: SpeakerTaskStatus;
}

export interface SpeakerTasksBoundary {
  readonly resolveScope: (
    principal: UserPrincipal,
    organizationId: string,
    eventId: string,
  ) => Promise<AccountSpeakerScope | null>;
  readonly listSessions: (
    organizationId: string,
    eventId: string,
    sessionIds: readonly string[],
  ) => Promise<readonly AccountSpeakerSession[]>;
  readonly listTasks: (
    organizationId: string,
    eventId: string,
    participantIds: readonly string[],
  ) => Promise<readonly AccountSpeakerTaskRecord[]>;
}

export interface AccountSpeakerTasksDependencies {
  readonly speakerTasks: SpeakerTasksBoundary;
}

export interface AccountSpeakerTasks {
  readonly organizationId: string;
  readonly eventId: string;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly title: string;
    readonly dueAt: string | null;
    readonly status: SpeakerTaskStatus;
  }[];
}

export class SpeakerTasksAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeakerTasksAccessError";
  }
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

/** Session-account speaker task projection with mandatory organization qualification. */
export class AccountSpeakerTasksService {
  constructor(private readonly dependencies: AccountSpeakerTasksDependencies) {}

  async list(
    principal: UserPrincipal,
    organizationId: string | undefined,
    eventId: string | undefined,
  ): Promise<AccountSpeakerTasks> {
    const organization = organizationId?.trim() ?? "";
    const event = eventId?.trim() ?? "";
    if (organization.length === 0 || event.length === 0) {
      throw new SpeakerTasksAccessError("Organization and event are required.");
    }
    const scope = await this.dependencies.speakerTasks.resolveScope(principal, organization, event);
    if (
      scope === null ||
      scope.tenantId !== organization ||
      scope.organizationId !== organization ||
      scope.eventId !== event ||
      scope.accountId !== principal.userId
    ) {
      throw new SpeakerTasksAccessError("The requested speaker scope is not available.");
    }
    const participantIds = uniqueNonEmpty(scope.participantIds);
    if (participantIds.length === 0) {
      throw new SpeakerTasksAccessError("The requested speaker scope is not available.");
    }
    const taskParticipantIds = participantIds.filter((participantId) =>
      capabilityAllows(scope, "task-response", participantId),
    );
    if (taskParticipantIds.length === 0) {
      return { organizationId: organization, eventId: event, tasks: [] };
    }
    const tasks = await this.dependencies.speakerTasks.listTasks(
      organization,
      event,
      taskParticipantIds,
    );
    const allowedTaskParticipants = new Set(taskParticipantIds);
    for (const task of tasks) {
      if (
        task.organizationId !== organization ||
        task.eventId !== event ||
        !allowedTaskParticipants.has(task.participantId) ||
        task.owner !== "speaker" ||
        (task.sessionId !== null && typeof task.sessionId !== "string")
      ) {
        throw new SpeakerTasksAccessError("The speaker repository returned another scope.");
      }
    }
    const sessionIds = uniqueNonEmpty(
      tasks.flatMap((task) => (task.sessionId === null ? [] : [task.sessionId])),
    );
    const sessions =
      sessionIds.length === 0
        ? []
        : await this.dependencies.speakerTasks.listSessions(organization, event, sessionIds);
    const acceptedSessions = new Map<string, AccountSpeakerSession>();
    const returnedSessionIds = new Set<string>();
    for (const session of sessions) {
      if (
        session.tenantId !== organization ||
        session.eventId !== event ||
        !sessionIds.includes(session.sessionId) ||
        returnedSessionIds.has(session.sessionId)
      ) {
        throw new SpeakerTasksAccessError("The speaker repository returned another scope.");
      }
      returnedSessionIds.add(session.sessionId);
      if (session.status.toLowerCase() === "accepted") {
        acceptedSessions.set(session.sessionId, session);
      }
    }
    return {
      organizationId: organization,
      eventId: event,
      tasks: tasks
        .flatMap((task) => {
          if (
            task.organizationId !== organization ||
            task.eventId !== event ||
            !allowedTaskParticipants.has(task.participantId) ||
            task.owner !== "speaker"
          ) {
            throw new SpeakerTasksAccessError("The speaker repository returned another scope.");
          }
          if (
            task.sessionId !== null &&
            !acceptedSessions.get(task.sessionId)?.speakerIds.includes(task.participantId)
          ) {
            return [];
          }
          return [
            {
              taskId: task.taskId,
              title: task.title,
              dueAt: task.dueAt,
              status: task.status,
            },
          ];
        })
        .sort((left, right) => left.taskId.localeCompare(right.taskId)),
    };
  }
}
