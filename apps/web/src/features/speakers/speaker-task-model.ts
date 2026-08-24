import type {
  SpeakerInvitationPreview,
  SpeakerInvitationResult,
  SpeakerProgressRow,
  SpeakerRecord,
  SpeakerTask,
  SpeakerTaskAssignmentInput,
  SpeakerTravelLogistics,
} from "./api";
import { normalizedEmail } from "./speaker-data-logic";
import { statusLabel, taskComplete } from "./speaker-roster-logic";
import {
  type CreateDraft,
  type EditDraft,
  MAX_ORGANIZER_ONBOARDING_TASKS,
  ORGANIZER_ONBOARDING_TASK_DESCRIPTION,
  type SpeakerInvitationHistoryEntry,
  type SpeakerOnboardingTaskDefinition,
} from "./speaker-workspace-types";

export interface SpeakerOnboardingTaskDraft {
  readonly title: string;
  readonly dueAt: string;
  readonly participantIds: readonly string[];
}

export function createSpeakerTaskAssignment(
  draft: SpeakerOnboardingTaskDraft,
): SpeakerTaskAssignmentInput {
  const title = draft.title.trim();
  const dueAt = draft.dueAt.trim();
  const participantIds = new Set<string>();
  const source = draft.participantIds;
  const length = source.length;
  for (let index = 0; index < length; index += 1) {
    if (!(index in source)) continue;
    const participantId = source[index];
    if (participantId === undefined) continue;
    const trimmed = participantId.trim();
    if (trimmed) participantIds.add(trimmed);
  }
  return {
    title,
    description: ORGANIZER_ONBOARDING_TASK_DESCRIPTION,
    dueAt,
    participantIds: [...participantIds],
  };
}

export function speakerTaskDefinitionId(task: SpeakerTask): string {
  return task.definitionId;
}

export function speakerOnboardingTaskDefinitions(
  rows: readonly SpeakerProgressRow[],
): readonly SpeakerOnboardingTaskDefinition[] {
  const definitions = new Map<string, SpeakerOnboardingTaskDefinition>();
  for (const row of rows) {
    for (const task of row.tasks) {
      if (task.type !== "general" || task.description !== ORGANIZER_ONBOARDING_TASK_DESCRIPTION) {
        continue;
      }
      const definitionId = speakerTaskDefinitionId(task);
      const current = definitions.get(definitionId);
      definitions.set(definitionId, {
        definitionId,
        title: current?.title ?? task.title,
        dueAt: current?.dueAt ?? task.dueAt,
        participantIds: [...new Set([...(current?.participantIds ?? []), task.participantId])],
      });
    }
  }
  return [...definitions.values()].sort((left, right) =>
    left.definitionId.localeCompare(right.definitionId),
  );
}
export function speakerTaskAssigneeLabels(
  participantIds: readonly string[],
  speakers: readonly Pick<SpeakerRecord, "participantId" | "displayName">[],
): readonly string[] {
  const names = new Map(speakers.map((speaker) => [speaker.participantId, speaker.displayName]));
  return participantIds.map(
    (participantId) => names.get(participantId)?.trim() || "Unavailable speaker",
  );
}

export function validateSpeakerTaskAssignment(
  draft: SpeakerOnboardingTaskDraft,
  existingTaskCount: number,
): string | null {
  if (existingTaskCount >= MAX_ORGANIZER_ONBOARDING_TASKS) {
    return `Exactly ${MAX_ORGANIZER_ONBOARDING_TASKS} organizer onboarding tasks are supported.`;
  }
  const input = createSpeakerTaskAssignment(draft);
  if (input.title.length === 0 || input.dueAt.length === 0 || input.participantIds.length === 0) {
    return "Enter a task title, due date, and select at least one speaker.";
  }
  return null;
}

export function retainInvitationHistory(
  current: readonly SpeakerInvitationHistoryEntry[],
  preview: readonly SpeakerInvitationPreview[],
  result: SpeakerInvitationResult,
  occurredAt = new Date().toISOString(),
): readonly SpeakerInvitationHistoryEntry[] {
  return [{ preview: [...preview], result, occurredAt }, ...current];
}

export function speakerInvitationReady(
  previews: readonly SpeakerInvitationPreview[],
  speaker: Pick<SpeakerRecord, "participantId" | "email" | "status">,
): boolean {
  const matching = previews.filter((preview) => preview.participantId === speaker.participantId);
  return (
    speaker.status !== "revoked" &&
    matching.length === 1 &&
    matching[0]?.state === "ready" &&
    normalizedEmail(matching[0].recipientEmail) === normalizedEmail(speaker.email)
  );
}

export type SpeakerTaskStatusTone = "neutral" | "info" | "warning" | "success";

export function taskStatusTone(status: string): SpeakerTaskStatusTone {
  if (taskComplete(status)) return "success";
  if (status === "overdue") return "warning";
  if (status === "in_progress") return "info";
  return "neutral";
}

export function taskStatusLabel(status: string): string {
  if (status === "not_started") return "Not started";
  return statusLabel(status);
}

export function socialLinksFor(draft: CreateDraft | EditDraft) {
  return {
    ...(draft.twitter.trim() ? { twitter: draft.twitter.trim() } : {}),
    ...(draft.linkedin.trim() ? { linkedin: draft.linkedin.trim() } : {}),
    ...(draft.website.trim() ? { website: draft.website.trim() } : {}),
  };
}

export function travelLogisticsFor(
  draft: CreateDraft | EditDraft,
): Partial<SpeakerTravelLogistics> {
  return {
    travelRequired: draft.travelRequired === true,
    arrivalAt: draft.arrivalAt.trim() || null,
    departureAt: draft.departureAt.trim() || null,
    accommodation: draft.accommodation.trim(),
    dietaryRequirements: draft.dietaryRequirements.trim(),
    accessibilityNeeds: draft.accessibilityNeeds.trim(),
    travelNotes: draft.travelNotes.trim(),
  };
}
