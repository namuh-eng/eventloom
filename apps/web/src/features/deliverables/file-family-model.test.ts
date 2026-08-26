import { describe, expect, it } from "vitest";
import type { DeliverableAsset, DeliverableMatrixItem, DeliverableTask } from "./api";
import {
  assetMatchesTaskScope,
  exportAssetIdsForFamilies,
  fileFamilyId,
  fileFamilyPointers,
  projectFileFamilies,
  taskSessionId,
} from "./file-family-model";
import { filePointerLabels } from "./file-library-model";

const task: DeliverableTask = {
  id: "task-1",
  eventId: "event-1",
  subject: { type: "session", sessionId: "session-1" },
  participantId: "speaker-1",
  type: "upload",
  owner: "speaker",
  title: "Upload slides",
  status: "submitted",
  dependencyIds: [],
  reminderOffsetsMinutes: [],
  version: 1,
  updatedAt: "2026-08-12T00:00:00.000Z",
};

function asset(id: string, overrides: Partial<DeliverableAsset> = {}): DeliverableAsset {
  return {
    id,
    eventId: "event-1",
    sessionId: "session-1",
    participantId: "speaker-1",
    taskId: task.id,
    kind: "slides",
    fileName: `${id}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 1_024,
    state: "ready",
    createdAt: "2026-08-12T00:00:00.000Z",
    version: 1,
    versionFamilyId: "family-1",
    ...overrides,
  };
}
function unlinkedAsset(
  id: string,
  overrides: Omit<Partial<DeliverableAsset>, "taskId"> = {},
): DeliverableAsset {
  const { taskId: _taskId, ...unlinked } = asset(id, overrides);
  return unlinked;
}

function matrixItem(
  assets: readonly DeliverableAsset[],
  currentAsset?: DeliverableAsset,
): DeliverableMatrixItem {
  return {
    task,
    participantId: "speaker-1",
    assets,
    ...(currentAsset === undefined ? {} : { currentAsset }),
    status: "uploaded",
  };
}

describe("file family projection", () => {
  it("projects two immutable versions as one family row with both versions retained", () => {
    const first = asset("asset-v1", {
      version: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      latestVersionId: "asset-v2",
      currentVersionId: "asset-v2",
    });
    const second = asset("asset-v2", {
      version: 2,
      createdAt: "2026-08-12T00:00:00.000Z",
      supersedesAssetId: first.id,
      latestVersionId: "asset-v2",
      currentVersionId: "asset-v2",
    });

    const families = projectFileFamilies([first, second]);

    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({
      familyId: fileFamilyId(first),
      latestVersion: { id: second.id },
      currentVersion: { id: second.id },
      displayVersion: { id: second.id },
      authoritative: true,
      exportAssetId: second.id,
    });
    expect(families[0]?.versions.map(({ id }) => id)).toEqual([second.id, first.id]);
  });
  it("uses task-first binding and session scope for unlinked assets", () => {
    const sameTaskDifferentSession = asset("asset-other-session", {
      sessionId: "session-2",
      versionFamilyId: "family-1",
    });
    const noTaskSessionOne = unlinkedAsset("asset-no-task-session-1", {
      versionFamilyId: "family-1",
    });
    const noTaskSessionTwo = unlinkedAsset("asset-no-task-session-2", {
      sessionId: "session-2",
      versionFamilyId: "family-1",
    });
    const sameTaskDifferentParticipant = asset("asset-other-participant", {
      participantId: "speaker-2",
      versionFamilyId: "family-1",
    });

    expect(projectFileFamilies([asset("asset-1"), sameTaskDifferentSession])).toHaveLength(1);
    expect(projectFileFamilies([noTaskSessionOne, noTaskSessionTwo])).toHaveLength(2);
    expect(projectFileFamilies([asset("asset-1"), sameTaskDifferentParticipant])).toHaveLength(2);
  });

  it("derives a session only from a session task subject", () => {
    expect(taskSessionId(task)).toBe("session-1");
    expect(
      taskSessionId({
        ...task,
        subject: { type: "participant" },
      }),
    ).toBeUndefined();
  });
  it("requires matching participant and session scopes for task-linked assets", () => {
    expect(assetMatchesTaskScope(asset("asset-1"), task)).toBe(true);
    expect(
      assetMatchesTaskScope(asset("asset-1"), {
        ...task,
        participantId: "speaker-2",
      }),
    ).toBe(false);
    expect(
      assetMatchesTaskScope(asset("asset-1"), {
        ...task,
        subject: { type: "session", sessionId: "session-2" },
      }),
    ).toBe(false);
  });

  it("prefers the matrix current version over newer version ordering and pointer metadata", () => {
    const current = asset("asset-current", {
      version: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      latestVersionId: "asset-newer",
      currentVersionId: "asset-newer",
    });
    const newer = asset("asset-newer", {
      version: 2,
      createdAt: "2026-08-12T00:00:00.000Z",
      latestVersionId: "asset-newer",
      currentVersionId: "asset-newer",
    });

    const family = projectFileFamilies(
      [current, newer],
      [matrixItem([current, newer], current)],
    )[0];

    expect(family?.latestVersion.id).toBe(newer.id);
    expect(family?.currentVersion?.id).toBe(current.id);
    expect(family?.displayVersion.id).toBe(current.id);
    expect(family?.exportAssetId).toBe(current.id);
  });

  it("uses a unique current pointer when the matrix projection is unavailable", () => {
    const first = asset("asset-v1", {
      version: 1,
      currentVersionId: "asset-v1",
      latestVersionId: "asset-v2",
    });
    const second = asset("asset-v2", {
      version: 2,
      currentVersionId: "asset-v1",
      latestVersionId: "asset-v2",
    });

    const family = projectFileFamilies([first, second])[0];

    expect(family?.currentVersion?.id).toBe(first.id);
    expect(family?.latestVersion.id).toBe(second.id);
    expect(family?.exportAssetId).toBe(first.id);
  });

  it("uses only the newest self-identifying pointer source when historical rows are stale", () => {
    const first = asset("asset-v1", {
      version: 1,
      currentVersionId: "asset-v1",
      latestVersionId: "asset-v1",
    });
    const second = asset("asset-v2", {
      version: 2,
      currentVersionId: "asset-v2",
      latestVersionId: "asset-v2",
    });

    const family = projectFileFamilies([first, second])[0];

    expect(family).toBeDefined();
    expect(family?.latestVersion.id).toBe(second.id);
    expect(family?.currentVersion?.id).toBe(second.id);
    expect(family?.displayVersion.id).toBe(second.id);
    expect(family?.authoritative).toBe(true);
    expect(family?.exportAssetId).toBe(second.id);
    expect(filePointerLabels(first, [first, second])).toEqual([]);
    expect(filePointerLabels(second, [first, second])).toEqual(["Latest", "Current"]);
  });

  it("uses one deterministic pointer source and latest fallback for every consumer", () => {
    const oldest = asset("asset-oldest", {
      version: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      latestVersionId: "missing-version",
      currentVersionId: "asset-oldest",
    });
    const newest = asset("asset-newest", {
      version: 3,
      createdAt: "2026-08-12T00:00:00.000Z",
      approvedVersionId: "asset-newest",
    });
    const middle = asset("asset-middle", {
      version: 2,
      createdAt: "2026-08-11T00:00:00.000Z",
    });

    expect(fileFamilyPointers([middle, oldest, newest])).toEqual({
      latest: newest.id,
      approved: newest.id,
    });
    expect(projectFileFamilies([middle, oldest, newest])[0]?.latestVersion.id).toBe(newest.id);
    expect(filePointerLabels(newest, [middle, oldest, newest])).toEqual(["Latest", "Approved"]);
  });

  it("deduplicates assets merged from list and matrix projections", () => {
    const current = asset("asset-current", {
      currentVersionId: "asset-current",
      latestVersionId: "asset-current",
    });

    const family = projectFileFamilies([current], [matrixItem([current, current], current)])[0];

    expect(family?.versions).toHaveLength(1);
    expect(family?.versions[0]?.id).toBe(current.id);
  });

  it("maps selected families only to ready authoritative current asset IDs", () => {
    const ready = asset("asset-ready", {
      versionFamilyId: "family-ready",
      currentVersionId: "asset-ready",
      latestVersionId: "asset-ready",
    });
    const pending = asset("asset-pending", {
      versionFamilyId: "family-pending",
      state: "pending_upload",
      currentVersionId: "asset-pending",
      latestVersionId: "asset-pending",
    });
    const unconfirmed = asset("asset-unconfirmed", {
      versionFamilyId: "family-unconfirmed",
    });
    const families = projectFileFamilies([ready, pending, unconfirmed]);

    expect(
      exportAssetIdsForFamilies(families, [
        fileFamilyId(ready),
        fileFamilyId(pending),
        fileFamilyId(unconfirmed),
        "missing-family",
      ]),
    ).toEqual([ready.id]);
  });

  it("keeps a ready server-current revision exportable when a newer upload is pending", () => {
    const ready = asset("asset-v1-ready", {
      version: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      currentVersionId: "asset-v1-ready",
      latestVersionId: "asset-v2-pending",
    });
    const pending = asset("asset-v2-pending", {
      version: 2,
      state: "pending_upload",
      createdAt: "2026-08-12T00:00:00.000Z",
      supersedesAssetId: ready.id,
      currentVersionId: "asset-v1-ready",
      latestVersionId: "asset-v2-pending",
    });

    const family = projectFileFamilies([ready, pending])[0];

    expect(family?.latestVersion.id).toBe(pending.id);
    expect(family?.currentVersion?.id).toBe(ready.id);
    expect(family?.displayVersion.id).toBe(ready.id);
    expect(family?.exportAssetId).toBe(ready.id);
  });
});
