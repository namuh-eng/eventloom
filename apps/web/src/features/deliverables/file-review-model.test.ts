import { describe, expect, it } from "vitest";
import type {
  DeliverableAsset,
  DeliverableComment,
  DeliverableSession,
  DeliverableTask,
} from "./api";
import type { FileFamilyProjection } from "./file-family-model";
import {
  buildFileReviewContext,
  fileFamilyCommentThread,
  selectedAssetCommentVersion,
} from "./file-review-model";

describe("buildFileReviewContext", () => {
  it("keeps the authenticated uploader distinct from the asset speaker", () => {
    const asset = {
      id: "asset-1",
      eventId: "event-1",
      participantId: "participant-1",
      participantName: "Alex Rivera",
      uploaderLabel: "Local Organizer",
      kind: "headshot",
      fileName: "headshot.jpg",
      contentType: "image/jpeg",
      sizeBytes: 3,
      state: "ready",
      createdAt: "2026-08-16T00:00:00.000Z",
      version: 1,
      versionFamilyId: "family-1",
      latestVersionId: "asset-1",
      currentVersionId: "asset-1",
    } as DeliverableAsset & { readonly uploaderLabel: string };
    const family: FileFamilyProjection = {
      familyId: "family-1",
      participantId: "participant-1",
      versions: [asset],
      latestVersion: asset,
      currentVersion: asset,
      displayVersion: asset,
      exportAssetId: "asset-1",
      authoritative: true,
    };

    const context = buildFileReviewContext(family, asset, [], [], [], []);

    expect(context.speakerLabel).toBe("Alex Rivera");
    expect((context as unknown as { readonly uploaderLabel: string }).uploaderLabel).toBe(
      "Local Organizer",
    );
  });
  it("uses canonical asset and task-subject session identities", () => {
    const asset: DeliverableAsset = {
      id: "asset-1",
      eventId: "event-1",
      sessionId: "session-1",
      participantId: "participant-1",
      taskId: "task-1",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      state: "ready",
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const family: FileFamilyProjection = {
      familyId: "family-1",
      participantId: asset.participantId,
      taskId: "task-1",
      versions: [asset],
      latestVersion: asset,
      displayVersion: asset,
      authoritative: false,
    };
    const task: DeliverableTask = {
      id: "task-1",
      eventId: "event-1",
      participantId: "participant-1",
      subject: { type: "session", sessionId: "session-1" },
      type: "upload",
      owner: "speaker",
      title: "Upload slides",
      status: "submitted",
      dependencyIds: [],
      reminderOffsetsMinutes: [],
      version: 1,
      updatedAt: "2026-08-16T00:00:00.000Z",
    };
    const session: DeliverableSession = {
      id: "session-1",
      eventId: "event-1",
      title: "Canonical session",
      description: "",
      status: "accepted",
      durationMinutes: 30,
      speakerIds: ["participant-1"],
      speakerRoster: [{ id: "participant-1" }],
      version: 1,
    };

    const context = buildFileReviewContext(family, asset, [], [session], [task], []);

    expect(context.sessionLabel).toBe("Canonical session");
    expect(context.taskLabel).toBe("Upload slides");
  });

  it("does not bind a task from another session", () => {
    const asset = {
      id: "asset-1",
      eventId: "event-1",
      sessionId: "session-1",
      participantId: "participant-1",
      taskId: "task-1",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      state: "ready",
      createdAt: "2026-08-16T00:00:00.000Z",
    } satisfies DeliverableAsset;
    const family: FileFamilyProjection = {
      familyId: "family-1",
      participantId: asset.participantId,
      taskId: asset.taskId,
      versions: [asset],
      latestVersion: asset,
      displayVersion: asset,
      authoritative: false,
    };
    const task: DeliverableTask = {
      id: "task-1",
      eventId: "event-1",
      participantId: "participant-1",
      subject: { type: "session", sessionId: "session-2" },
      type: "upload",
      owner: "speaker",
      title: "Wrong task",
      status: "submitted",
      dependencyIds: [],
      reminderOffsetsMinutes: [],
      version: 1,
      updatedAt: "2026-08-16T00:00:00.000Z",
    };

    const context = buildFileReviewContext(family, asset, [], [], [task], []);

    expect(context.taskLabel).toBe("No linked request");
  });
});
describe("file family comments", () => {
  it("shows comments from every immutable version while fencing reply CAS to the selected asset", () => {
    const versions = [
      {
        id: "asset-v1",
        eventId: "event-1",
        participantId: "participant-1",
        kind: "slides",
        fileName: "slides.pdf",
        contentType: "application/pdf",
        sizeBytes: 608,
        state: "ready",
        createdAt: "2026-08-25T10:00:00.000Z",
      },
      {
        id: "asset-v2",
        eventId: "event-1",
        participantId: "participant-1",
        kind: "slides",
        fileName: "slides.pdf",
        contentType: "application/pdf",
        sizeBytes: 608,
        state: "ready",
        createdAt: "2026-08-25T10:05:00.000Z",
      },
    ] satisfies DeliverableAsset[];
    const comments = [
      {
        id: "comment-v1",
        eventId: "event-1",
        assetId: "asset-v1",
        versionId: "asset-v1",
        authorLabel: "Priya Raman",
        body: "Draft deck - final version coming Friday.",
        createdAt: "2026-08-25T10:06:00.000Z",
        version: 1,
      },
      {
        id: "comment-v2",
        eventId: "event-1",
        assetId: "asset-v2",
        versionId: "asset-v2",
        authorLabel: "Organizer",
        body: "Thanks - please confirm the final version by Tuesday.",
        createdAt: "2026-08-25T10:07:00.000Z",
        version: 1,
      },
    ] satisfies DeliverableComment[];

    const thread = fileFamilyCommentThread(comments, versions);

    expect(thread.map((comment) => comment.id)).toEqual(["comment-v1", "comment-v2"]);
    expect(selectedAssetCommentVersion(thread, "asset-v2")).toBe(1);
  });
});
