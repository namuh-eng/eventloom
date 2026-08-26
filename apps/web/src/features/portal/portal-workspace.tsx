"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui";
import { WorkspaceState } from "@/components/workspace";
import { participantDashboardHref } from "./participant-dashboard-model";
import { AssetDetails } from "./portal-asset-details";
import { EventGuideWorkspaceView } from "./portal-event-guide";
import {
  type FilesSessionOption,
  type FilesWorkspaceUpload,
  FilesWorkspaceView,
} from "./portal-files-workspace";
import { usePortal } from "./portal-provider";
import { portalContextLabel } from "./portal-provider-model";
import { safePublishedUrl } from "./portal-published-content-model";
import { SessionsWorkspaceView } from "./portal-sessions-workspace";
import styles from "./portal-workspace.module.css";
import type { PortalTask } from "./types";

export type { PortalAssetVersionFamily } from "./portal-assets";
export type { EventGuideWorkspaceViewProps } from "./portal-event-guide";
export { EventGuideWorkspaceView } from "./portal-event-guide";
export type {
  FilesSessionOption,
  FilesWorkspaceUpload,
  FilesWorkspaceViewProps,
} from "./portal-files-workspace";
export { compatibleFilesUploadTasks, FilesWorkspaceView } from "./portal-files-workspace";
export type { SessionsWorkspaceViewProps } from "./portal-sessions-workspace";
export { SessionsWorkspaceView } from "./portal-sessions-workspace";
export { AssetDetails };

export type PortalWorkspaceSection = "co-speakers" | "files" | "resources" | "wiki";
export type PortalWorkspaceSurface = "sessions" | "files" | "event-guide";

function surfaceFor(section: PortalWorkspaceSection): PortalWorkspaceSurface {
  if (section === "co-speakers") return "sessions";
  if (section === "files") return "files";
  return "event-guide";
}
export function authorizedFilesSessionOptions(
  tasks: readonly PortalTask[],
): readonly FilesSessionOption[] {
  const sessionsById = new Map<string, FilesSessionOption>();
  for (const task of tasks) {
    if (
      task.subject.type !== "session" ||
      task.type !== "upload" ||
      task.owner !== "speaker" ||
      !task.sessionTitle?.trim() ||
      !task.acceptedAssetKinds?.length
    ) {
      continue;
    }
    const existing = sessionsById.get(task.subject.sessionId);
    sessionsById.set(task.subject.sessionId, {
      id: task.subject.sessionId,
      eventId: task.eventId,
      title: task.sessionTitle,
      uploadTasks: [...(existing?.uploadTasks ?? []), task],
    });
  }
  return [...sessionsById.values()];
}
export function reconcileSelectedFileSessionId(
  selectedSessionId: string | null,
  sessions: readonly FilesSessionOption[],
): string | null {
  return selectedSessionId !== null && sessions.some((session) => session.id === selectedSessionId)
    ? selectedSessionId
    : (sessions[0]?.id ?? null);
}

const navigation: readonly { surface: PortalWorkspaceSurface; label: string; href: string }[] = [
  { surface: "sessions", label: "Sessions", href: "/portal?workspace=co-speakers" },
  { surface: "files", label: "Files", href: "/portal?workspace=files" },
  { surface: "event-guide", label: "Event guide", href: "/portal?workspace=resources" },
];

export function PortalWorkspace({ section }: Readonly<{ section: PortalWorkspaceSection }>) {
  const portal = usePortal();
  const searchParams = useSearchParams();
  const {
    context,
    view,
    workspace,
    workspaceGuideErrors,
    loading,
    error,
    workspaceLoading,
    workspaceError,
    mutationError,
    busyAssetIds,
  } = portal;
  const sessions = view?.sessions ?? [];
  const firstSessionId = sessions[0]?.sessionId ?? null;
  const fileSessions = useMemo(() => authorizedFilesSessionOptions(view?.tasks ?? []), [view]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedFileSessionId, setSelectedFileSessionId] = useState<string | null>(null);
  const surface = surfaceFor(section);

  useEffect(() => {
    if (context && view) void portal.loadWorkspace();
  }, [context, portal.loadWorkspace, view]);

  useEffect(() => {
    setSelectedSessionId(firstSessionId);
  }, [firstSessionId]);

  useEffect(() => {
    setSelectedFileSessionId((current) => reconcileSelectedFileSessionId(current, fileSessions));
  }, [fileSessions]);

  if (loading && !view) {
    return (
      <WorkspaceState
        variant="empty"
        title="Loading your participant workspace"
        description="Retrieving sessions, private files, and published event guidance."
      />
    );
  }
  if (error && !view) {
    return (
      <WorkspaceState
        variant="error"
        title="We could not load your workspace"
        description={error}
        action={
          <Button type="button" onClick={() => void portal.reload()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!context || !view) {
    return (
      <WorkspaceState
        variant="empty"
        title="Your speaker workspace is not open yet"
        description="Track your proposal in My submissions. Sessions appear after the event team grants your speaker access."
        action={
          <Button asChild>
            <Link href="/portal/submissions">View my submissions</Link>
          </Button>
        }
      />
    );
  }

  const participantId = context.primaryParticipantId ?? view.profiles[0]?.participantId ?? null;
  const workspaceQuery = new URLSearchParams(searchParams.toString());
  workspaceQuery.set("event", context.eventId);
  if (participantId) workspaceQuery.set("participant", participantId);
  const workspaceNavigation = navigation.map((item) => ({
    ...item,
    href: participantDashboardHref(item.href, context, `?${workspaceQuery.toString()}`),
  }));

  async function upload(input: FilesWorkspaceUpload): Promise<boolean> {
    return portal.uploadWorkspaceFile(input);
  }

  async function download(assetId: string): Promise<void> {
    const grant = await portal.downloadAsset(assetId);
    const url = safePublishedUrl(grant?.url);
    if (url && typeof window !== "undefined") window.location.assign(url);
  }

  return (
    <div className={styles.page}>
      <nav className={styles.navigation} aria-label="Speaker workspace tools">
        {workspaceNavigation.map((item) => (
          <Link
            key={item.surface}
            href={item.href}
            aria-current={item.surface === surface ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {workspaceError ? (
        <WorkspaceState
          variant="error"
          title="Workspace data unavailable"
          description={workspaceError}
          action={
            <div className={styles.actions}>
              <Button type="button" onClick={() => void portal.loadWorkspace()}>
                Retry
              </Button>
              <Button type="button" variant="ghost" onClick={portal.clearWorkspaceError}>
                Dismiss
              </Button>
            </div>
          }
        />
      ) : null}
      {mutationError ? (
        <WorkspaceState
          variant="error"
          title="Workspace action failed"
          description={mutationError}
          action={
            <Button type="button" variant="ghost" onClick={portal.clearMutationError}>
              Dismiss
            </Button>
          }
        />
      ) : null}
      {workspaceLoading ? (
        <p className={styles.loading} role="status">
          Refreshing workspace...
        </p>
      ) : null}

      {surface === "sessions" ? (
        <SessionsWorkspaceView
          eventName={portalContextLabel(context)}
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          tasks={view.tasks}
          assets={workspace.assets}
          onSelectSession={setSelectedSessionId}
        />
      ) : null}

      {surface === "files" ? (
        portal.can("asset-read") ? (
          <FilesWorkspaceView
            eventName={portalContextLabel(context)}
            sessions={fileSessions}
            selectedSessionId={selectedFileSessionId}
            assets={workspace.assets}
            participantId={participantId}
            canWrite={portal.can("asset-write")}
            busyAssetIds={busyAssetIds}
            onSelectSession={setSelectedFileSessionId}
            onUpload={upload}
            onRetryUpload={(assetId, file) => void portal.retryAssetUpload({ assetId, file })}
            onCompleteUpload={(assetId) => void portal.completeAssetUpload({ assetId })}
            onDownload={(asset) => void download(asset.id)}
          />
        ) : (
          <WorkspaceState
            variant="error"
            title="Files unavailable"
            description="This event context did not grant access to private files."
          />
        )
      ) : null}

      {surface === "event-guide" ? (
        <EventGuideWorkspaceView
          eventName={portalContextLabel(context)}
          available={portal.can("resource-read")}
          resources={workspace.resources}
          resourceError={workspaceGuideErrors.resources}
          wiki={workspace.wiki}
          wikiError={workspaceGuideErrors.wiki}
        />
      ) : null}
    </div>
  );
}
