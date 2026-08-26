"use client";

import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import {
  WorkspaceActionBar,
  WorkspaceFormSection,
  WorkspaceState,
} from "../../components/workspace/workspace-state";
import { StatusBadge, type StatusTone } from "../../components/workspace/workspace-ui";
import { deadlineAfterEventWarning } from "../speakers/speaker-temporal-policy";
import { isTaskBlocked, taskStatusPresentation } from "./model";
import { usePortal } from "./portal-provider";
import { PortalTaskAssetView } from "./portal-task-asset-view";
import { mergePortalAssets, resolveTaskAsset } from "./portal-task-assets";
import styles from "./portal-task-detail.module.css";
import { actionTaskPresentation, taskSubjectPresentation } from "./portal-task-model";
import { PortalTaskResponseEditor } from "./portal-task-response";
import { PortalTaskUpload } from "./portal-task-upload";
import { formatPortalDate } from "./portal-ui-model";
import type { PortalTask } from "./types";

function tone(task: PortalTask): StatusTone {
  if (task.status === "completed") return "success";
  if (task.status === "needs_changes" || task.status === "overdue") return "danger";
  if (task.status === "reopened") return "warning";
  if (task.status === "submitted" || task.status === "in_progress") return "info";
  return "neutral";
}

function finished(task: PortalTask): boolean {
  return task.status === "completed" || task.status === "waived";
}

export function PortalTaskDetail({ task }: Readonly<{ task: PortalTask }>) {
  const { busyTaskIds, context, transitionTask, view, workspace } = usePortal();
  const [note, setNote] = useState("");
  if (!view) return null;
  const subject = taskSubjectPresentation(task, view.profiles);
  const dependencies = task.dependencyIds.map((id) =>
    view.tasks.find((candidate) => candidate.id === id),
  );
  const blocked = subject.error !== null || isTaskBlocked(task, view.tasks);
  const presentation = taskStatusPresentation(task.status);
  const assets = mergePortalAssets(view.assets ?? [], workspace.assets);
  const resolution = resolveTaskAsset(task, assets);
  const busy = busyTaskIds.has(task.id);
  const actionable = !blocked && !finished(task) && task.status !== "submitted";
  const deadlineWarning =
    context?.temporalContext === undefined || task.dueAt === undefined
      ? null
      : deadlineAfterEventWarning(task.dueAt.slice(0, 10), context.temporalContext);
  const returnedUploadFeedback =
    task.status === "needs_changes" && resolution.current?.reviewState === "needs_changes"
      ? resolution.current.reviewNote?.trim() || null
      : null;

  async function confirmCompletion() {
    const succeeded = await transitionTask(task, "completed", note.trim() || undefined);
    if (succeeded) setNote("");
  }

  return (
    <article className={styles.detail} aria-labelledby={`task-detail-${task.id}`}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <span className={styles.eyebrow}>{subject.label}</span>
          <h2 id={`task-detail-${task.id}`}>{task.title}</h2>
          <p>{task.description || presentation.description}</p>
        </div>
        <StatusBadge tone={tone(task)}>{presentation.label}</StatusBadge>
      </header>

      <dl className={styles.metadata}>
        <div>
          <dt>Due</dt>
          <dd>{formatPortalDate(task.dueAt) ?? "No due date"}</dd>
        </div>
        <div>
          <dt>Work type</dt>
          <dd>
            {task.type === "upload"
              ? "File request"
              : task.type === "form"
                ? "Form response"
                : "Action task"}
          </dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{subject.description}</dd>
        </div>
      </dl>

      {deadlineWarning ? <p role="status">{deadlineWarning}</p> : null}

      {subject.error ? (
        <WorkspaceState
          variant="error"
          title="Task scope unavailable"
          description={subject.error}
        />
      ) : null}

      {dependencies.length > 0 ? (
        <WorkspaceFormSection
          title={blocked ? "Blocked by prerequisites" : "Prerequisites complete"}
          description="Dependencies are checked against their current server status."
        >
          <ul className={styles.dependencies}>
            {dependencies.map((dependency, index) => (
              <li key={dependency?.id ?? task.dependencyIds[index]}>
                <span>{dependency?.title ?? "Required task unavailable"}</span>
                <StatusBadge tone={dependency && finished(dependency) ? "success" : "warning"}>
                  {dependency ? taskStatusPresentation(dependency.status).label : "Missing"}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </WorkspaceFormSection>
      ) : null}

      {returnedUploadFeedback ? (
        <aside className={styles.feedback} aria-label="Organizer feedback">
          <strong>Returned by organizer</strong>
          <p>{returnedUploadFeedback}</p>
        </aside>
      ) : null}

      {resolution.assets.length > 0 ||
      ["missing-metadata", "conflict"].includes(resolution.status) ? (
        <PortalTaskAssetView task={task} resolution={resolution} />
      ) : null}

      {actionable && task.type === "form" ? <PortalTaskResponseEditor task={task} /> : null}
      {actionable && task.type === "upload" ? <PortalTaskUpload task={task} /> : null}

      {actionable && task.type === "action" ? (
        <WorkspaceFormSection
          title="Completion confirmation"
          description="Confirm only after completing the organizer-provided action above."
        >
          <label className={styles.noteField} htmlFor={`task-note-${task.id}`}>
            <span>Note to organizer (optional)</span>
            <Textarea
              id={`task-note-${task.id}`}
              rows={3}
              maxLength={1_000}
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </label>
          <WorkspaceActionBar
            summary={actionTaskPresentation(task).content}
            actions={
              <Button type="button" disabled={busy} onClick={() => void confirmCompletion()}>
                {busy ? "Confirming…" : actionTaskPresentation(task).actionLabel}
              </Button>
            }
          />
        </WorkspaceFormSection>
      ) : null}

      {!blocked && (finished(task) || task.status === "submitted") ? (
        <WorkspaceState
          variant="empty"
          title={finished(task) ? "This task is finished" : "Submitted for organizer review"}
          description={presentation.description}
        />
      ) : null}
    </article>
  );
}
