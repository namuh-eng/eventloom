import {
  SpeakerApiError,
  type SpeakerProgressRow,
  type SpeakerRecord,
  type SpeakerTask,
} from "./api";
import { duplicateEmailConflicts } from "./speaker-data-logic";
import { normalizeEventDateValue } from "./speaker-temporal-policy";
import {
  ASYNC_ACTION_TIMEOUT_MS,
  type CreateDraft,
  type EditDraft,
  type ProgressFilter,
} from "./speaker-workspace-types";

const SPEAKER_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const SPEAKER_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out. Try again.`));
    }, ASYNC_ACTION_TIMEOUT_MS);
  });
  let operationPromise: Promise<T>;
  try {
    operationPromise = operation(controller.signal);
  } catch (reason: unknown) {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    return Promise.reject(reason);
  }
  return Promise.race([operationPromise, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

export function emptyCreateDraft(): CreateDraft {
  return {
    displayName: "",
    email: "",
    title: "",
    company: "",
    biography: "",
    twitter: "",
    linkedin: "",
    website: "",
    status: "pending",
    travelRequired: false,
    arrivalAt: "",
    departureAt: "",
    accommodation: "",
    dietaryRequirements: "",
    accessibilityNeeds: "",
    travelNotes: "",
  };
}

export function editDraftFor(speaker: SpeakerRecord, eventTimeZone = "UTC"): EditDraft {
  return {
    displayName: speaker.displayName,
    email: speaker.email,
    title: speaker.jobTitle ?? "",
    company: speaker.company ?? "",
    biography: speaker.biography,
    twitter: speaker.socialLinks.twitter ?? "",
    linkedin: speaker.socialLinks.linkedin ?? "",
    website: speaker.socialLinks.website ?? "",
    status: speaker.status,
    travelRequired: speaker.travelLogistics?.travelRequired ?? false,
    arrivalAt: normalizeEventDateValue(speaker.travelLogistics?.arrivalAt, eventTimeZone),
    departureAt: normalizeEventDateValue(speaker.travelLogistics?.departureAt, eventTimeZone),
    accommodation: speaker.travelLogistics?.accommodation ?? "",
    dietaryRequirements: speaker.travelLogistics?.dietaryRequirements ?? "",
    accessibilityNeeds: speaker.travelLogistics?.accessibilityNeeds ?? "",
    travelNotes: speaker.travelLogistics?.travelNotes ?? "",
    headshotAssetId: speaker.headshotAssetId,
    expectedVersion: speaker.version,
  };
}

export function errorMessage(reason: unknown): string {
  if (reason instanceof SpeakerApiError) {
    if (reason.code === "CONFLICT" || reason.code === "VERSION_CONFLICT" || reason.status === 409) {
      if (
        reason.code === "VERSION_CONFLICT" &&
        /already|duplicate|verified email|canonical participant/iu.test(reason.message)
      ) {
        return reason.message;
      }
      return "This speaker changed elsewhere. Refresh the roster and try again.";
    }
    if (reason.status === 404) {
      return "The organizer speaker service is not available for this event yet.";
    }
    return reason.message;
  }
  return reason instanceof Error ? reason.message : "The speaker request could not be completed.";
}

export function statusLabel(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function dateLabel(value: string | null | undefined): string {
  if (!value) return "No due date";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return SPEAKER_DATE_FORMATTER.format(parsed);
}

export function dateTimeLabel(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return SPEAKER_DATE_TIME_FORMATTER.format(parsed);
}

export function assetSize(value: number): string {
  if (!Number.isFinite(value) || value < 1) return "Unknown size";
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 104_857.6) / 10} MB`;
}
export function taskComplete(status: string): boolean {
  return status === "completed" || status === "submitted" || status === "waived";
}

export function taskSummaryFor(tasks: readonly SpeakerTask[]): SpeakerRecord["taskSummary"] {
  return {
    total: tasks.length,
    completed: tasks.filter((task) => taskComplete(task.status)).length,
    overdue: tasks.filter((task) => task.status === "overdue").length,
  };
}
export function speakerProgressComplete(tasks: readonly SpeakerTask[]): boolean {
  return tasks.length > 0 && tasks.every((task) => taskComplete(task.status));
}

export function speakerProgressMatches(
  tasks: readonly SpeakerTask[],
  filter: ProgressFilter,
): boolean {
  if (filter === "all") return true;
  const complete = speakerProgressComplete(tasks);
  return filter === "complete" ? complete : tasks.length > 0 && !complete;
}

export interface SpeakerRosterFilterState {
  readonly query: string;
  readonly status: string;
  readonly session: string;
  readonly progress: ProgressFilter;
}

export type SpeakerAttentionFilter =
  | "all"
  | "overdue"
  | "awaiting-invite"
  | "duplicate-email"
  | "inactive";

export function filterSpeakersByAttention(
  speakers: readonly SpeakerRecord[],
  filter: SpeakerAttentionFilter,
): readonly SpeakerRecord[] {
  if (filter === "all") return speakers;
  if (filter === "overdue") {
    return speakers.filter((speaker) => speaker.taskSummary.overdue > 0);
  }
  if (filter === "awaiting-invite") {
    return speakers.filter((speaker) => speaker.status.toLowerCase() === "pending");
  }
  if (filter === "duplicate-email") {
    const duplicateEmails = new Set(
      duplicateEmailConflicts(speakers).map((conflict) => conflict.email),
    );
    return speakers.filter((speaker) => duplicateEmails.has(speaker.email.trim().toLowerCase()));
  }
  return speakers.filter((speaker) => {
    return ["declined", "revoked"].includes(speaker.status.toLowerCase());
  });
}

export function filterSpeakerRoster(
  speakers: readonly SpeakerRecord[],
  progressRows: readonly SpeakerProgressRow[],
  filters: SpeakerRosterFilterState,
): readonly SpeakerRecord[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase();
  const progressByParticipant = new Map(
    progressRows.map((row) => [row.participantId, row] as const),
  );
  return speakers.filter((speaker) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      [
        speaker.displayName,
        speaker.email,
        speaker.jobTitle ?? "",
        speaker.company ?? "",
        speaker.biography,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    const matchesStatus = filters.status === "all" || speaker.status === filters.status;
    const matchesSession =
      filters.session === "all" ||
      speaker.sessions.some((session) => session.sessionId === filters.session);
    const progressRow = progressByParticipant.get(speaker.participantId);
    const matchesProgress =
      filters.progress === "all" ||
      speakerProgressMatches(progressRow?.tasks ?? [], filters.progress);
    return matchesQuery && matchesStatus && matchesSession && matchesProgress;
  });
}
