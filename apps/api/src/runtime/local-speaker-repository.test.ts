import { describe, expect, it } from "vitest";
import type { SpeakerAsset, SpeakerTask } from "../features/speaker/types";
import { LocalSpeakerRepository } from "./local";

describe("LocalSpeakerRepository review atomicity", () => {
  it("leaves asset, task, transition, and audit unchanged when task CAS loses", async () => {
    const eventId = "local-review-event";
    const participantId = "local-review-participant";
    const asset: SpeakerAsset = {
      id: "local-review-asset",
      tenantId: "local-review-org",
      eventId,
      participantId,
      kind: "slides",
      objectKey: "events/local-review-event/local-review-asset",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      state: "ready",
      latestVersionId: "local-review-asset",
      currentVersionId: "local-review-asset",
      version: 1,
      versionFamilyId: "local-review-family",
      versionId: "local-review-asset",
      commentThreadId: "local-review-comments",
      createdAt: "2099-08-15T04:00:00.000Z",
    };
    const task: SpeakerTask = {
      id: "local-review-task",
      eventId,
      subject: { type: "participant", participantId },
      participantId,
      type: "upload",
      owner: "speaker",
      title: "Upload slides",
      dependencyIds: [],
      reminderOffsetsMinutes: [],
      acceptedAssetKinds: ["slides"],
      status: "submitted",
      version: 2,
      updatedAt: "2099-08-15T04:00:00.000Z",
    };
    const repository = new LocalSpeakerRepository(
      () => null,
      (tasks) => {
        const current = tasks.get(eventId)?.[0];
        if (current !== undefined) {
          tasks.set(eventId, [
            {
              ...current,
              version: current.version + 1,
              updatedAt: "2099-08-15T05:00:00.000Z",
            },
          ]);
        }
      },
    );
    await repository.createPendingAsset(asset);
    await repository.createTask?.({
      task,
      expectedVersion: null,
      actorAccountId: "local-organizer",
    });

    await expect(
      repository.reviewAsset?.({
        eventId,
        assetId: asset.id,
        state: "needs_changes",
        expectedVersion: 0,
        reviewedAt: "2099-08-15T05:01:00.000Z",
        reviewedBy: "local-organizer",
        release: false,
        audit: {
          id: "local-review-audit",
          organizationId: "local-review-org",
          eventId,
          assetId: asset.id,
          action: "needs_changes",
          actorAccountId: "local-organizer",
          occurredAt: "2099-08-15T05:01:00.000Z",
          version: 1,
        },
        returnTask: {
          eventId,
          taskId: task.id,
          expectedVersion: task.version,
          fromStatus: "submitted",
          toStatus: "needs_changes",
          baselineAssetId: asset.id,
          transition: {
            id: "local-review-transition",
            eventId,
            taskId: task.id,
            participantId,
            actorAccountId: "local-organizer",
            fromStatus: "submitted",
            toStatus: "needs_changes",
            occurredAt: "2099-08-15T05:01:00.000Z",
          },
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "version_conflict" });

    const persistedAsset = await repository.getAsset(eventId, asset.id);
    const persistedTask = await repository.getTask(eventId, task.id);
    expect(persistedAsset).toMatchObject({
      id: asset.id,
      state: "ready",
    });
    expect(persistedTask).toMatchObject({
      status: "submitted",
      version: task.version + 1,
    });
  });
});
