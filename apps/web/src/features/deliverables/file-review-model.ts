import type {
  DeliverableAsset,
  DeliverableAssetHistoryEntry,
  DeliverableComment,
  DeliverableSession,
  DeliverableSpeakerProfile,
  DeliverableTask,
} from "./api";
import {
  assetMatchesTaskScope,
  compareFileVersions,
  type FileFamilyProjection,
  fileFamilyId,
  taskSessionId,
} from "./file-family-model";
import type { FileReviewContext } from "./file-review-types";

export function mergeFileReviewVersions(
  family: FileFamilyProjection,
  history: readonly DeliverableAssetHistoryEntry[],
): readonly DeliverableAsset[] {
  const versions = new Map<string, DeliverableAsset>();

  for (const asset of family.versions) versions.set(asset.id, asset);
  for (const asset of history) {
    if (fileFamilyId(asset) === family.familyId) versions.set(asset.id, asset);
  }

  return [...versions.values()].sort(compareFileVersions);
}

export function buildFileReviewContext(
  family: FileFamilyProjection,
  selectedAsset: DeliverableAsset | undefined,
  history: readonly DeliverableAssetHistoryEntry[],
  sessions: readonly DeliverableSession[],
  tasks: readonly DeliverableTask[],
  profiles: readonly DeliverableSpeakerProfile[],
): FileReviewContext {
  const versions = mergeFileReviewVersions(family, history);
  const asset = selectedAsset ?? family.currentVersion ?? family.latestVersion;
  const candidateTask = tasks.find((candidate) => candidate.id === asset.taskId);
  const task =
    candidateTask !== undefined && assetMatchesTaskScope(asset, candidateTask)
      ? candidateTask
      : undefined;
  const sessionId = asset.sessionId ?? (task === undefined ? undefined : taskSessionId(task)) ?? "";
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const profile = profiles.find((candidate) => candidate.participantId === asset.participantId);

  return {
    asset,
    family,
    versions,
    speakerLabel: asset.participantName ?? profile?.displayName ?? asset.participantId,
    uploaderLabel: asset.uploaderLabel ?? "Uploader unavailable",
    sessionLabel:
      session?.title ??
      asset.sessionTitle ??
      task?.sessionTitle ??
      (asset.kind === "headshot" ? "Speaker profile" : "Session unavailable"),
    taskLabel: task?.title ?? "No linked request",
  };
}
export function fileFamilyCommentThread(
  comments: readonly DeliverableComment[],
  versions: readonly DeliverableAsset[],
): readonly DeliverableComment[] {
  const familyAssetIds = new Set(versions.map((version) => version.id));
  return comments
    .filter(
      (comment) => familyAssetIds.has(comment.assetId) && comment.versionId === comment.assetId,
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || (left.version ?? 0) - (right.version ?? 0),
    );
}

export function selectedAssetCommentVersion(
  comments: readonly DeliverableComment[],
  assetId: string,
): number {
  return comments
    .filter((comment) => comment.assetId === assetId)
    .reduce((maximum, comment) => Math.max(maximum, comment.version ?? 0), 0);
}
