"use client";

import { useState } from "react";
import {
  WorkspaceListDetail,
  WorkspaceProgressSummary,
} from "../../components/workspace/workspace-content";
import { WorkspaceState } from "../../components/workspace/workspace-state";
import { filterTasks, summarizePortal } from "./model";
import { usePortal } from "./portal-provider";
import { PortalTaskDetail } from "./portal-task-detail";
import { PortalTaskInbox, type TaskFilter } from "./portal-task-list";
import { sortTasksByUrgency } from "./portal-task-model";
import styles from "./portal-tasks.module.css";
import { InlineMutationError, PageHeading, PortalContentState } from "./portal-ui";

export type { TaskFilter } from "./portal-task-list";

export function PortalTasks() {
  return (
    <PortalContentState>
      <PortalTasksContent />
    </PortalContentState>
  );
}

function PortalTasksContent() {
  const { context, view } = usePortal();
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!view) return null;

  const visible = sortTasksByUrgency(filterTasks(view.tasks, filter));
  const selected = visible.find((task) => task.id === selectedId) ?? visible[0] ?? null;
  const summary = summarizePortal(view);

  return (
    <div className={styles.page}>
      <PageHeading
        eyebrow="Accepted speaker checklist"
        title="Requests & tasks"
        description="Work through organizer requests in urgency order, then open one task for its complete context and action."
      />
      <InlineMutationError />
      <WorkspaceProgressSummary
        className={styles.progress}
        label="Event preparation"
        value={summary.completedTaskCount}
        max={Math.max(summary.taskCount, 1)}
        detail={
          summary.readinessState === "no-tasks"
            ? "No speaker tasks assigned"
            : `${summary.completedTaskCount} of ${summary.taskCount} finished · ${summary.outstandingTaskCount} still open`
        }
      />

      {view.tasks.length === 0 ? (
        <WorkspaceState
          variant="empty"
          title="No speaker tasks yet"
          description="Accepted-speaker requirements will appear here when organizers assign them."
        />
      ) : visible.length === 0 ? (
        <WorkspaceState
          variant="empty"
          title="No tasks in this view"
          description="Choose another filter to see your remaining event work."
        />
      ) : (
        <WorkspaceListDetail
          className={styles.workspace}
          listLabel="Task inbox"
          detailLabel={selected ? selected.title : "Task detail"}
          list={
            <PortalTaskInbox
              tasks={visible}
              profiles={view.profiles}
              selectedId={selected?.id ?? null}
              filter={filter}
              {...(context?.temporalContext === undefined
                ? {}
                : { temporalContext: context.temporalContext })}
              onFilter={setFilter}
              onSelect={setSelectedId}
            />
          }
          detail={
            selected ? (
              <PortalTaskDetail task={selected} />
            ) : (
              <WorkspaceState
                variant="empty"
                title="Select a task"
                description="Choose an inbox item to view its details."
              />
            )
          }
        />
      )}
    </div>
  );
}
