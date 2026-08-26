import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { portalRouteAuthorized } from "./portal-shell-model";
import {
  authorizedFilesSessionOptions,
  compatibleFilesUploadTasks,
  EventGuideWorkspaceView,
  FilesWorkspaceView,
  reconcileSelectedFileSessionId,
  SessionsWorkspaceView,
} from "./portal-workspace";
import type {
  PortalAsset,
  PortalResource,
  PortalSession,
  PortalSubmission,
  PortalTask,
  PortalWikiPage,
} from "./types";

const canonicalSessionId = "session-priya";
const acceptedCfpSubmission: PortalSubmission = {
  id: "submission-priya",
  eventId: "event-1",
  title: "Reliable event operations",
  status: "accepted",
  participantIds: ["speaker-1", "speaker-2"],
  updatedAt: "2026-08-15T10:00:00.000Z",
  version: 3,
};

const session: PortalSession = {
  sessionId: canonicalSessionId,
  title: "Reliable event operations",
  status: "accepted",
  version: 7,
};

const task: PortalTask = {
  id: "task-session-1",
  eventId: "event-1",
  subject: { type: "session", sessionId: canonicalSessionId },
  sessionTitle: "Reliable event operations",
  participantId: "speaker-1",
  type: "upload",
  owner: "speaker",
  title: "Upload final slides",
  status: "in_progress",
  dependencyIds: [],
  acceptedAssetKinds: ["slides"],
  reminderOffsetsMinutes: [],
  version: 2,
  updatedAt: "2026-08-15T10:00:00.000Z",
};

const asset: PortalAsset = {
  id: "asset-v1",
  eventId: "event-1",
  sessionId: canonicalSessionId,
  participantId: "speaker-1",
  kind: "slides",
  fileName: "reliable-operations.pdf",
  contentType: "application/pdf",
  sizeBytes: 1536,
  state: "ready",
  createdAt: "2026-08-15T10:00:00.000Z",
  version: 1,
  versionId: "asset-v1",
  versionFamilyId: "family-slides",
  latestVersionId: "asset-v1",
  currentVersionId: "asset-v1",
  reviewState: "needs_changes",
  reviewNote: "Replace the draft agenda slide.",
};

describe("focused participant workspaces", () => {
  it("renders canonical sessions without treating CFP submissions as session IDs", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionsWorkspaceView, {
        eventName: "North Summit",
        sessions: [session],
        selectedSessionId: canonicalSessionId,
        tasks: [],
        assets: [],
        onSelectSession: vi.fn(),
      }),
    );

    expect(canonicalSessionId).not.toBe(acceptedCfpSubmission.id);
    expect(markup).toContain("Reliable event operations");
    expect(markup).toContain(`>${canonicalSessionId}<`);
    expect(markup).toContain("Session version");
    expect(markup).toContain(">7<");
  });
  it("admits invitation-backed profile access to Sessions but denies an ungranted shell", () => {
    const profileSelf = (capability: string) => capability === "profile-self";
    const noGrant = () => false;

    expect(
      portalRouteAuthorized({
        pathname: "/portal",
        workspace: "co-speakers",
        submissionCount: 0,
        can: profileSelf,
      }),
    ).toBe(true);
    expect(
      portalRouteAuthorized({
        pathname: "/portal",
        workspace: "co-speakers",
        submissionCount: 1,
        can: noGrant,
      }),
    ).toBe(false);
    expect(
      portalRouteAuthorized({
        pathname: "/portal",
        workspace: "co-speakers",
        submissionCount: 0,
        can: (capability) => capability === "roster-manage",
      }),
    ).toBe(false);
  });

  it("derives Files sessions from canonical task subjects and shows their task-bound family", () => {
    const fileSessions = authorizedFilesSessionOptions([
      task,
      { ...task, id: "participant-task", subject: { type: "participant" } },
    ]);
    const markup = renderToStaticMarkup(
      createElement(FilesWorkspaceView, {
        eventName: "North Summit",
        sessions: fileSessions,
        selectedSessionId: canonicalSessionId,
        assets: [{ ...asset, taskId: task.id }],
        participantId: "speaker-1",
        canWrite: true,
        busyAssetIds: new Set<string>(),
        onSelectSession: vi.fn(),
        onUpload: vi.fn(),
        onRetryUpload: vi.fn(),
        onCompleteUpload: vi.fn(),
        onDownload: vi.fn(),
      }),
    );

    expect(fileSessions).toEqual([
      {
        id: canonicalSessionId,
        eventId: "event-1",
        title: "Reliable event operations",
        uploadTasks: [task],
      },
    ]);
    expect(acceptedCfpSubmission.id).not.toBe(canonicalSessionId);
    expect(markup).toContain("Files for Reliable event operations");
    expect(markup).toContain(`value="${canonicalSessionId}"`);
    expect(markup).toContain("reliable-operations.pdf");
    expect(markup).toContain("Needs changes");
    expect(markup).toContain("Replace the draft agenda slide.");
    expect(markup).toContain("Download current version");
    expect(markup).toContain("application/pdf");
    expect(markup).toContain("1.5 KiB");
    expect(markup).toContain(
      'accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/jpeg,image/png,image/webp"',
    );
    expect(markup).not.toMatch(/comments|activity history|uploaded by/iu);
  });
  it("reconciles a removed File session against the complete current option set", () => {
    const options = authorizedFilesSessionOptions([
      task,
      {
        ...task,
        id: "task-session-2",
        subject: { type: "session", sessionId: "session-2" },
        sessionTitle: "Second session",
      },
    ]);

    expect(reconcileSelectedFileSessionId("session-removed", options)).toBe(canonicalSessionId);
    expect(
      reconcileSelectedFileSessionId(
        "session-2",
        options.filter((session) => session.id !== "session-2"),
      ),
    ).toBe(canonicalSessionId);
  });
  it("excludes an incompatible task when the selected file kind changes", () => {
    const sessions = authorizedFilesSessionOptions([
      { ...task, acceptedAssetKinds: ["slides"] },
      {
        ...task,
        id: "supporting-task",
        acceptedAssetKinds: ["supporting_file"],
      },
    ]);

    expect(compatibleFilesUploadTasks(sessions[0] ?? null, "supporting_file")).toEqual([
      expect.objectContaining({ id: "supporting-task" }),
    ]);
  });

  it("keeps event-guide unavailable distinct from empty and retains safe published rendering", () => {
    const unavailable = renderToStaticMarkup(
      createElement(EventGuideWorkspaceView, {
        eventName: "North Summit",
        available: false,
        resources: [],
        wiki: [],
      }),
    );
    const empty = renderToStaticMarkup(
      createElement(EventGuideWorkspaceView, {
        eventName: "North Summit",
        available: true,
        resources: [],
        wiki: [],
      }),
    );
    const resource: PortalResource = {
      id: "resource-1",
      title: "Speaker handbook",
      html: '<p>Read <strong>carefully</strong>.</p><script>alert(1)</script><a href="javascript:alert(2)">unsafe</a>',
      url: "https://example.test/handbook",
      order: 2,
      updatedAt: "2026-08-15T10:00:00.000Z",
    };
    const wiki: PortalWikiPage = {
      id: "wiki-1",
      title: "Arrival guide",
      summary: "Where to check in.",
      order: 1,
      updatedAt: "2026-08-15T09:00:00.000Z",
    };
    const published = renderToStaticMarkup(
      createElement(EventGuideWorkspaceView, {
        eventName: "North Summit",
        available: true,
        resources: [resource],
        wiki: [wiki],
      }),
    );

    expect(unavailable).toContain("Event guide unavailable");
    expect(empty).toContain("Nothing published yet");
    expect(published).toContain("Speaker handbook");
    expect(published).toContain("Arrival guide");
    expect(published).toContain("<strong>carefully</strong>");
    expect(published).toContain('href="https://example.test/handbook"');
    expect(published).not.toContain("<script");
    expect(published).not.toContain('href="javascript:');
  });

  it("keeps /portal/tasks authoritative and removes the duplicate task implementation", () => {
    const workspaceSource = readFileSync(
      fileURLToPath(new URL("portal-workspace.tsx", import.meta.url)),
      "utf8",
    );
    const routeSource = readFileSync(
      fileURLToPath(new URL("../../app/portal/page.tsx", import.meta.url)),
      "utf8",
    );

    expect(workspaceSource).not.toMatch(
      /function TasksWorkspace|function FormTaskCard|function FormField/,
    );
    expect(workspaceSource).not.toContain('section === "tasks"');
    expect(routeSource).toContain("redirect(event ? `/portal/tasks?event=");
    expect(routeSource).not.toMatch(/<PortalWorkspace section=["'{]tasks/);
  });
  it("uses Next Link for same-origin workspace destinations", () => {
    const workspaceSource = readFileSync(
      fileURLToPath(new URL("portal-workspace.tsx", import.meta.url)),
      "utf8",
    );
    const sessionsSource = readFileSync(
      fileURLToPath(new URL("portal-sessions-workspace.tsx", import.meta.url)),
      "utf8",
    );

    expect(workspaceSource).toContain('import Link from "next/link";');
    expect(workspaceSource).toContain("<Link");
    expect(workspaceSource).toContain("href={item.href}");
    expect(workspaceSource).toContain(
      '<Link href="/portal/submissions">View my submissions</Link>',
    );
    expect(workspaceSource).not.toContain('<a href="/portal/submissions">');
    expect(sessionsSource).toContain('import Link from "next/link";');
    expect(sessionsSource).toContain('<Link href="/portal/tasks">Open Requests & tasks</Link>');
    expect(sessionsSource).toContain(
      '<Link href="/portal?workspace=files">Manage session files</Link>',
    );
    expect(sessionsSource).not.toContain('<a href="/portal/tasks">');
    expect(sessionsSource).not.toContain('<a href="/portal?workspace=files">');
  });
});
