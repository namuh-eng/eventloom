"use client";

import Link from "next/link";
import {
  MetadataList,
  MetadataRow,
  StatusBadge,
  WorkspaceHeader,
  WorkspaceListDetail,
  WorkspaceState,
  WorkspaceSurface,
} from "@/components/workspace";
import styles from "./portal-workspace.module.css";
import type { PortalAsset, PortalSession, PortalTask } from "./types";

export interface SessionsWorkspaceViewProps {
  readonly eventName: string;
  readonly sessions: readonly PortalSession[];
  readonly selectedSessionId: string | null;
  readonly tasks: readonly PortalTask[];
  readonly assets: readonly PortalAsset[];
  readonly onSelectSession: (sessionId: string) => void;
}

function taskTone(status: PortalTask["status"]): "neutral" | "info" | "success" | "warning" {
  if (status === "completed" || status === "waived") return "success";
  if (status === "needs_changes" || status === "overdue") return "warning";
  if (status === "submitted") return "info";
  return "neutral";
}

export function SessionsWorkspaceView({
  eventName,
  sessions,
  selectedSessionId,
  tasks,
  assets,
  onSelectSession,
}: SessionsWorkspaceViewProps) {
  const selected = sessions.find((session) => session.sessionId === selectedSessionId) ?? null;
  const scopedTasks = selected
    ? tasks.filter(
        (task) => task.subject.type === "session" && task.subject.sessionId === selected.sessionId,
      )
    : [];
  const scopedAssets = selected
    ? assets.filter((asset) => asset.sessionId === selected.sessionId)
    : [];

  return (
    <div className={styles.page}>
      <WorkspaceHeader
        eyebrow="Speaker workspace"
        title="Sessions"
        description="Program sessions are managed independently from CFP proposal outcomes. Choose one to review its identity, tasks, and files."
        metadata={
          <>
            <span>{eventName}</span>
            <span>{sessions.length} sessions</span>
          </>
        }
      />

      {sessions.length === 0 ? (
        <WorkspaceState
          variant="empty"
          title="No sessions yet"
          description="Sessions appear here after the event team grants your speaker access."
        />
      ) : (
        <WorkspaceListDetail
          listLabel="Sessions"
          detailLabel={selected?.title ?? "Session detail"}
          list={
            <ul className={styles.list}>
              {sessions.map((session) => (
                <li key={session.sessionId}>
                  <button
                    className={styles.listButton}
                    type="button"
                    aria-current={session.sessionId === selected?.sessionId ? "true" : undefined}
                    onClick={() => onSelectSession(session.sessionId)}
                  >
                    <strong>{session.title}</strong>
                    <span>{session.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          }
          detail={
            selected ? (
              <div className={styles.detail}>
                <WorkspaceSurface title={selected.title} description="Session identity">
                  <div className={styles.surfaceBody}>
                    <StatusBadge tone={selected.status === "accepted" ? "success" : "neutral"}>
                      {selected.status}
                    </StatusBadge>
                    <MetadataList>
                      <MetadataRow label="Session ID" value={selected.sessionId} />
                      <MetadataRow label="Session version" value={selected.version} />
                    </MetadataList>
                  </div>
                </WorkspaceSurface>

                <WorkspaceSurface
                  title="Session work"
                  description="Task actions remain authoritative in Requests & tasks."
                >
                  <div className={styles.surfaceBody}>
                    {scopedTasks.length === 0 ? (
                      <p className={styles.muted}>No tasks are attributed to this session.</p>
                    ) : (
                      <ul className={styles.compactList}>
                        {scopedTasks.map((task) => (
                          <li key={task.id}>
                            <div className={styles.row}>
                              <span>{task.title}</span>
                              <StatusBadge tone={taskTone(task.status)}>
                                {task.status.replaceAll("_", " ")}
                              </StatusBadge>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Link href="/portal/tasks">Open Requests & tasks</Link>
                  </div>
                </WorkspaceSurface>

                <WorkspaceSurface
                  title="Session files"
                  description="Only files explicitly attributed to this session are shown."
                >
                  <div className={styles.surfaceBody}>
                    {scopedAssets.length === 0 ? (
                      <p className={styles.muted}>No files are attributed to this session.</p>
                    ) : (
                      <ul className={styles.compactList}>
                        {scopedAssets.map((asset) => (
                          <li key={asset.id}>{asset.fileName}</li>
                        ))}
                      </ul>
                    )}
                    <Link href="/portal?workspace=files">Manage session files</Link>
                  </div>
                </WorkspaceSurface>
              </div>
            ) : (
              <WorkspaceState
                variant="empty"
                title="Select a session"
                description="Choose a session to open its workspace."
              />
            )
          }
        />
      )}
    </div>
  );
}
