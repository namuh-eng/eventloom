import { type AssetPointerSnapshot, resolveAssetPointers } from "./portal-assets";
import { asTaskRecord, resolveTaskSubject, taskString } from "./portal-task-model";
import type { PortalAsset, PortalAssetComment, PortalTask } from "./types";

function assetVersionId(asset: PortalAsset): string {
  return taskString(asTaskRecord(asset)?.versionId) ?? asset.id;
}

function assetMatchesPointer(asset: PortalAsset, pointerId: string): boolean {
  return asset.id === pointerId || assetVersionId(asset) === pointerId;
}

function assetsForTask(task: PortalTask, assets: readonly PortalAsset[]): PortalAsset[] {
  const subject = resolveTaskSubject(task).subject;
  return assets.filter((asset) => {
    if (
      asset.eventId !== task.eventId ||
      asset.taskId !== task.id ||
      asset.participantId !== task.participantId ||
      subject === null
    ) {
      return false;
    }
    if (subject.type === "participant") return asset.sessionId === undefined;
    return asset.sessionId === subject.sessionId;
  });
}

export type TaskAssetResolution = {
  readonly status: "empty" | "ready" | "pending" | "rejected" | "missing-metadata" | "conflict";
  readonly assets: readonly PortalAsset[];
  readonly pointers: AssetPointerSnapshot;
  readonly latest: PortalAsset | undefined;
  readonly current: PortalAsset | undefined;
  readonly approved: PortalAsset | undefined;
  readonly released: PortalAsset | undefined;
  readonly error: string | null;
};

export function resolveTaskAsset(
  task: PortalTask,
  assets: readonly PortalAsset[],
): TaskAssetResolution {
  const matching = assetsForTask(task, assets);
  const pointers = resolveAssetPointers(matching, task);
  if (matching.length === 0) {
    return {
      status: "empty",
      assets: matching,
      pointers,
      latest: undefined,
      current: undefined,
      approved: undefined,
      released: undefined,
      error: null,
    };
  }
  if (pointers.status !== "ready") {
    return {
      status: pointers.status,
      assets: matching,
      pointers,
      latest: matching.length === 1 ? matching[0] : undefined,
      current: undefined,
      approved: undefined,
      released: undefined,
      error: pointers.error,
    };
  }
  const find = (pointerId: string | null): PortalAsset | undefined => {
    if (pointerId === null) return undefined;
    const matches = matching.filter((asset) => assetMatchesPointer(asset, pointerId));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const latest = find(pointers.latestVersionId);
  const current = find(pointers.currentVersionId);
  const approved = find(pointers.approvedVersionId);
  const released = find(pointers.releasedVersionId);
  if (
    !latest ||
    (pointers.currentVersionId !== null && !current) ||
    (pointers.approvedVersionId !== null && !approved) ||
    (pointers.releasedVersionId !== null && !released)
  ) {
    return {
      status: "conflict",
      assets: matching,
      pointers,
      latest,
      current,
      approved,
      released,
      error: "The server asset pointers reference a version that is not available.",
    };
  }
  const status =
    latest.state === "pending_upload"
      ? "pending"
      : latest.state === "rejected"
        ? "rejected"
        : "ready";
  return { status, assets: matching, pointers, latest, current, approved, released, error: null };
}

export function commentsForAsset(
  _asset: PortalAsset,
  comments: readonly PortalAssetComment[],
): PortalAssetComment[] {
  return [...comments];
}

export function commentsForAssetVersion(
  asset: PortalAsset,
  comments: readonly PortalAssetComment[],
): PortalAssetComment[] {
  const versionId = assetVersionId(asset);
  return comments.filter(
    (comment) => comment.assetId === asset.id && comment.versionId === versionId,
  );
}

export function commentThreadExpectedVersion(comments: readonly PortalAssetComment[]): number {
  return comments.reduce(
    (expectedVersion, comment) => Math.max(expectedVersion, comment.version ?? 0),
    0,
  );
}

export function mergePortalAssets(
  viewAssets: readonly PortalAsset[],
  workspaceAssets: readonly PortalAsset[],
): PortalAsset[] {
  const byId = new Map(viewAssets.map((asset) => [asset.id, asset]));
  for (const asset of workspaceAssets) if (!byId.has(asset.id)) byId.set(asset.id, asset);
  return [...byId.values()];
}

export { assetVersionId };
