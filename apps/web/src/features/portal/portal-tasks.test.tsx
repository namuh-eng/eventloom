import { describe, expect, it } from "vitest";
import { assetPointerLabels, resolveAssetPointers } from "./portal-assets";
import {
  commentsForAsset,
  commentsForAssetVersion,
  commentThreadExpectedVersion,
  resolveTaskAsset,
} from "./portal-task-assets";
import {
  actionTaskPresentation,
  getTaskUploadPolicy,
  portalTaskGroup,
  resolveTaskSubject,
  sortTasksByUrgency,
  taskSubjectPresentation,
  validateTaskUpload,
} from "./portal-task-model";
import type { PortalAsset, PortalTask } from "./types";

function task(overrides: Record<string, unknown> = {}): PortalTask {
  return {
    id: "task-1",
    eventId: "event-1",
    subject: { type: "session", sessionId: "session-1" },
    participantId: "participant-1",
    type: "upload",
    owner: "speaker",
    title: "Upload slides",
    status: "in_progress",
    dependencyIds: [],
    reminderOffsetsMinutes: [],
    acceptedAssetKinds: ["slides"],
    version: 1,
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  } as PortalTask;
}

function asset(id: string, overrides: Record<string, unknown> = {}): PortalAsset {
  return {
    id,
    eventId: "event-1",
    sessionId: "session-1",
    participantId: "participant-1",
    taskId: "task-1",
    kind: "slides",
    fileName: `${id}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 100,
    state: "ready",
    createdAt: "2026-08-12T12:00:00.000Z",
    version: 1,
    ...overrides,
  } as PortalAsset;
}

describe("portal task deliverable helpers", () => {
  it("orders attention work by returned, overdue, due date, then stable title", () => {
    const ordered = sortTasksByUrgency([
      task({ id: "later", title: "Later", dueAt: "2026-08-20T00:00:00.000Z" }),
      task({ id: "finished", title: "Finished", status: "completed" }),
      task({ id: "overdue", title: "Overdue", status: "overdue" }),
      task({ id: "returned", title: "Returned", status: "needs_changes" }),
      task({ id: "sooner", title: "Sooner", dueAt: "2026-08-16T00:00:00.000Z" }),
    ]);
    expect(ordered.map((value) => value.id)).toEqual([
      "returned",
      "overdue",
      "sooner",
      "later",
      "finished",
    ]);
  });

  it("describes action tasks as completion confirmations without legal assent claims", () => {
    const presentation = actionTaskPresentation(
      task({
        type: "action",
        title: "Review event instructions",
        description: "Read the organizer-provided arrival instructions.",
        dueAt: "2026-08-20T00:00:00.000Z",
      }),
    );
    expect(presentation.actionLabel).toBe("Confirm completion");
    expect(presentation.content).toContain("arrival instructions");
    expect(JSON.stringify(presentation)).not.toMatch(/sign|agreement|acceptance|assent|version/iu);
  });

  it("groups content requests separately from other event tasks", () => {
    expect(portalTaskGroup(task({ type: "upload" }))).toBe("content-requests");
    expect(portalTaskGroup(task({ type: "form" }))).toBe("content-requests");
    expect(portalTaskGroup(task({ type: "action" }))).toBe("other-event-tasks");
  });

  it("fails closed when the server upload policy is absent or incomplete", () => {
    const missing = getTaskUploadPolicy(task());
    expect(missing.valid).toBe(false);
    expect(missing.error).toContain("MIME allowlist");

    const missingLimit = getTaskUploadPolicy(task({ allowedMimeTypes: ["application/pdf"] }));
    expect(missingLimit.valid).toBe(false);
    expect(missingLimit.error).toContain("byte limit");

    const valid = getTaskUploadPolicy(
      task({ allowedMimeTypes: [" application/pdf "], maxBytes: 1_000 }),
    );
    expect(valid).toMatchObject({
      valid: true,
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 1_000,
    });
  });

  it("validates MIME and size before upload", () => {
    const policy = getTaskUploadPolicy(
      task({ allowedMimeTypes: ["application/pdf", "image/*"], maxBytes: 100 }),
    );
    expect(validateTaskUpload({ type: "application/pdf", size: 100 }, policy)).toEqual({
      valid: true,
    });
    expect(validateTaskUpload({ type: "text/plain", size: 1 }, policy)).toMatchObject({
      valid: false,
    });
    expect(validateTaskUpload({ type: "image/png", size: 101 }, policy)).toMatchObject({
      valid: false,
      error: expect.stringContaining("limit"),
    });

    const friendlyPolicy = getTaskUploadPolicy(
      task({
        allowedMimeTypes: [
          "application/pdf",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-powerpoint",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "image/*",
        ],
        maxBytes: 1_000,
      }),
    );
    expect(validateTaskUpload({ type: "text/html", size: 100 }, friendlyPolicy)).toEqual({
      valid: false,
      error: "This file type is not allowed. Accepted types: PDF, Word, PowerPoint, Images.",
    });
  });

  it("distinguishes participant tasks from session tasks and reports missing accepted sessions", () => {
    const participantTask = task({
      subject: { type: "participant" },
    });
    expect(resolveTaskSubject(participantTask)).toEqual({
      subject: { type: "participant" },
      error: null,
    });
    expect(
      taskSubjectPresentation(participantTask, [
        {
          id: "profile-1",
          eventId: "event-1",
          participantId: "participant-1",
          displayName: "Ada Speaker",
          biography: "",
          version: 1,
          updatedAt: "2026-08-12T12:00:00.000Z",
        },
      ]).label,
    ).toContain("Ada Speaker");

    const sessionTask = task({
      subject: { type: "session", sessionId: "session-1" },
      sessionTitle: "Canonical program session",
    });
    expect(taskSubjectPresentation(sessionTask, [])).toMatchObject({
      label: "Session · Canonical program session",
      error: null,
    });
    expect(
      taskSubjectPresentation(
        task({ subject: { type: "session", sessionId: "missing-session" } }),
        [],
      ),
    ).toMatchObject({
      label: "Session unavailable",
      error: "This session-scoped task has no matching accepted program session.",
    });
  });
  it("rejects legacy submission-scoped task subjects", () => {
    const legacy = {
      ...task(),
      subject: undefined,
      submissionId: "proposal-1",
    } as unknown as PortalTask;

    expect(resolveTaskSubject(legacy)).toMatchObject({
      subject: null,
      error: "Task subject metadata is missing.",
    });
  });
  it("matches task assets by exact canonical session ID", () => {
    const taskValue = task({ subject: { type: "session", sessionId: "session-1" } });

    expect(
      resolveTaskAsset(taskValue, [asset("asset-other", { sessionId: "proposal-1" })]).status,
    ).toBe("empty");
    expect(
      resolveTaskAsset(taskValue, [asset("asset-session", { sessionId: "session-1" })]).status,
    ).toBe("missing-metadata");
  });

  it("uses pointer IDs rather than array order for version state", () => {
    const old = asset("asset-old", {
      version: 1,
      latestVersionId: "asset-current",
      currentVersionId: "asset-current",
      approvedVersionId: "asset-old",
    });
    const current = asset("asset-current", {
      version: 2,
      latestVersionId: "asset-current",
      currentVersionId: "asset-current",
      approvedVersionId: "asset-old",
      releasedVersionId: "asset-current",
    });
    const taskValue = task({
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 10_000,
    });
    const resolution = resolveTaskAsset(taskValue, [current, old]);
    expect(resolution.status).toBe("ready");
    expect(resolution.latest?.id).toBe("asset-current");
    expect(assetPointerLabels(current, resolution.pointers)).toEqual([
      "Latest upload",
      "Current",
      "Released",
    ]);
    expect(resolveAssetPointers([old, current]).status).toBe("ready");

    const conflict = resolveAssetPointers([
      asset("asset-a", { latestVersionId: "asset-a" }),
      asset("asset-b", { latestVersionId: "asset-b" }),
    ]);
    expect(conflict.status).toBe("conflict");
  });

  it("renders family comments while keeping CAS scoped to the selected immutable version", () => {
    const selected = asset("asset-v1", { versionId: "version-v1", version: 1 });
    const comments = commentsForAsset(selected, [
      {
        id: "comment-v2",
        assetId: "asset-v2",
        versionId: "version-v2",
        body: "Use the updated deck.",
        authorLabel: "Organizer",
        createdAt: "2026-08-12T12:00:00.000Z",
        version: 4,
      } as never,
      {
        id: "comment-v1",
        assetId: "asset-v1",
        versionId: "version-v1",
        body: "Old version note.",
        authorLabel: "Organizer",
        createdAt: "2026-08-12T12:00:00.000Z",
        version: 2,
      } as never,
      {
        id: "comment-family",
        assetId: "asset-v1",
        versionId: "version-v2",
        body: "Family thread.",
        authorLabel: "Organizer",
        createdAt: "2026-08-12T12:00:00.000Z",
        version: 3,
      } as never,
    ]);
    const threadComments = commentsForAssetVersion(selected, comments);
    expect(comments.map((comment) => comment.id)).toEqual([
      "comment-v2",
      "comment-v1",
      "comment-family",
    ]);
    expect(threadComments.map((comment) => comment.id)).toEqual(["comment-v1"]);
    expect(commentThreadExpectedVersion(threadComments)).toBe(2);
    const emptyV1Thread = commentsForAssetVersion(selected, []);
    expect(commentThreadExpectedVersion(emptyV1Thread)).toBe(0);
  });
});
