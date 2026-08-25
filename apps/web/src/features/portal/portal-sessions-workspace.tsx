"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import {
  MetadataList,
  MetadataRow,
  StatusBadge,
  WorkspaceHeader,
  WorkspaceListDetail,
  WorkspaceState,
  WorkspaceSurface,
} from "@/components/workspace";
import { PortalRosterPanel } from "./portal-roster-panel";
import styles from "./portal-workspace.module.css";
import type {
  PortalAsset,
  PortalRosterEnvelope,
  PortalRosterMember,
  PortalSubmission,
  PortalTask,
} from "./types";

function subscribeToPortalSessionDate(): () => void {
  return () => undefined;
}

function browserPortalSessionDate(value: string): string {
  return new Date(value).toLocaleDateString("en");
}

function PortalSessionDate({ value }: Readonly<{ value: string }>) {
  return useSyncExternalStore(
    subscribeToPortalSessionDate,
    () => browserPortalSessionDate(value),
    () => value,
  );
}

export interface SessionsWorkspaceViewProps {
  readonly eventName: string;
  readonly sessions: readonly PortalSubmission[];
  readonly selectedSessionId: string | null;
  readonly roster: PortalRosterEnvelope | undefined;
  readonly tasks: readonly PortalTask[];
  readonly assets: readonly PortalAsset[];
  readonly canManageRoster: boolean;
  readonly canInvite: boolean;
  readonly busyRoster: boolean;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onAddCoSpeaker: (input: {
    displayName: string;
    email: string;
  }) => Promise<boolean> | boolean;
  readonly onUpdateCoSpeaker: (
    entry: PortalRosterMember,
    displayName: string,
  ) => Promise<boolean> | boolean;
  readonly onRemoveCoSpeaker: (entry: PortalRosterMember) => Promise<boolean> | boolean;
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
  roster,
  tasks,
  assets,
  canManageRoster,
  canInvite,
  busyRoster,
  onSelectSession,
  onAddCoSpeaker,
  onUpdateCoSpeaker,
  onRemoveCoSpeaker,
}: SessionsWorkspaceViewProps) {
  const selected = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const scopedTasks = selected
    ? tasks.filter(
        (task) => task.subject.type === "session" && task.subject.sessionId === selected.id,
      )
    : [];
  const scopedAssets = selected ? assets.filter((asset) => asset.sessionId === selected.id) : [];

  return (
    <div className={styles.page}>
      <WorkspaceHeader
        eyebrow="Accepted speaker workspace"
        title="Sessions"
        description="Choose an accepted session before reviewing its identity, authorized speakers, tasks, and files."
        metadata={
          <>
            <span>{eventName}</span>
            <span>{sessions.length} accepted sessions</span>
          </>
        }
      />

      {sessions.length === 0 ? (
        <WorkspaceState
          variant="empty"
          title="No accepted sessions yet"
          description="Session operations unlock only after an organizer accepts a proposal."
        />
      ) : (
        <WorkspaceListDetail
          listLabel="Accepted sessions"
          detailLabel={selected?.title ?? "Session detail"}
          list={
            <ul className={styles.list}>
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    className={styles.listButton}
                    type="button"
                    aria-current={session.id === selected?.id ? "true" : undefined}
                    onClick={() => onSelectSession(session.id)}
                  >
                    <strong>{session.title}</strong>
                    <span>Accepted session</span>
                  </button>
                </li>
              ))}
            </ul>
          }
          detail={
            selected ? (
              <div className={styles.detail}>
                <WorkspaceSurface title={selected.title} description="Accepted session identity">
                  <div className={styles.surfaceBody}>
                    <StatusBadge tone="success">Accepted</StatusBadge>
                    <MetadataList>
                      <MetadataRow label="Session ID" value={selected.id} />
                      <MetadataRow
                        label="Session version"
                        value={selected.version ?? "Unavailable"}
                      />
                      <MetadataRow
                        label="Last updated"
                        value={<PortalSessionDate value={selected.updatedAt} />}
                      />
                    </MetadataList>
                  </div>
                </WorkspaceSurface>

                <PortalRosterPanel
                  sessionId={selected.id}
                  roster={roster}
                  canManage={canManageRoster}
                  canInvite={canInvite}
                  busy={busyRoster}
                  onAdd={onAddCoSpeaker}
                  onUpdate={onUpdateCoSpeaker}
                  onRemove={onRemoveCoSpeaker}
                />

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
                  description="Only files explicitly attributed to this accepted session are shown."
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
                description="Choose an accepted proposal to open its workspace."
              />
            )
          }
        />
      )}
    </div>
  );
}
