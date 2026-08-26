import type {
  DeliverableAsset,
  DeliverableSession,
  DeliverableSpeakerProfile,
  DeliverableTask,
} from "./api";
import {
  assetMatchesTaskScope,
  type FileFamilyProjection,
  fileFamilyPointers,
  taskSessionId,
} from "./file-family-model";
import type { FileLibraryFilters, FileLibraryRow } from "./file-library-types";

export function formatFileStatus(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function formatFileTime(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return "Not recorded";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1_024) return `${bytes.toLocaleString()} bytes`;
  if (bytes < 1_048_576) return `${Number((bytes / 1_024).toFixed(1))} KiB`;
  return `${Number((bytes / 1_048_576).toFixed(1))} MiB`;
}

export function fileReviewPresentation(asset: DeliverableAsset): {
  readonly value: string;
  readonly label: string;
} {
  if (asset.reviewState !== undefined) {
    return {
      value: asset.reviewState,
      label: formatFileStatus(asset.reviewState),
    };
  }
  return asset.state === "ready"
    ? { value: "pending", label: "Pending review" }
    : { value: asset.state, label: formatFileStatus(asset.state) };
}

export function filePointerLabels(
  asset: DeliverableAsset,
  versions: readonly DeliverableAsset[],
): readonly string[] {
  const pointers = fileFamilyPointers(versions);
  return [
    ...(pointers.latest === asset.id ? ["Latest"] : []),
    ...(pointers.current === asset.id ? ["Current"] : []),
    ...(pointers.approved === asset.id ? ["Approved"] : []),
    ...(pointers.released === asset.id ? ["Released"] : []),
  ];
}

export function buildFileLibraryRows(
  families: readonly FileFamilyProjection[],
  sessions: readonly DeliverableSession[],
  tasks: readonly DeliverableTask[],
  profiles: readonly DeliverableSpeakerProfile[],
): readonly FileLibraryRow[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const profilesById = new Map(profiles.map((profile) => [profile.participantId, profile]));

  return families.map((family) => {
    const asset = family.displayVersion;
    const candidateTask = tasksById.get(asset.taskId ?? "");
    const task =
      candidateTask !== undefined && assetMatchesTaskScope(asset, candidateTask)
        ? candidateTask
        : undefined;
    const sessionId =
      asset.sessionId ?? (task === undefined ? undefined : taskSessionId(task)) ?? "";
    const review = fileReviewPresentation(asset);

    return {
      family,
      asset,
      participantId: asset.participantId,
      speakerLabel:
        asset.participantName ??
        profilesById.get(asset.participantId)?.displayName ??
        asset.participantId,
      sessionId,
      sessionLabel:
        sessionsById.get(sessionId)?.title ??
        asset.sessionTitle ??
        task?.sessionTitle ??
        (asset.kind === "headshot" ? "Speaker profile" : "Session unavailable"),
      taskLabel: task?.title ?? "No linked request",
      reviewValue: review.value,
      reviewLabel: review.label,
    };
  });
}

export function filterFileLibraryRows(
  rows: readonly FileLibraryRow[],
  filters: FileLibraryFilters,
): readonly FileLibraryRow[] {
  const query = filters.query.trim().toLocaleLowerCase();

  return rows.filter((row) => {
    const searchable = [row.asset.fileName, row.speakerLabel, row.sessionLabel, row.taskLabel]
      .join(" ")
      .toLocaleLowerCase();

    return (
      (query.length === 0 || searchable.includes(query)) &&
      (filters.participantId === "all" || row.participantId === filters.participantId) &&
      (filters.sessionId === "all" || row.sessionId === filters.sessionId) &&
      (filters.reviewState === "all" || row.reviewValue === filters.reviewState)
    );
  });
}
