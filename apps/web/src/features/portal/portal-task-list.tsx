"use client";

import { AlertCircle, CheckCircle2, Clock3, FileUp, ListChecks } from "lucide-react";
import { StatusBadge, type StatusTone } from "../../components/workspace/workspace-ui";
import {
  deadlineAfterEventWarning,
  type SpeakerEventTemporalContext,
} from "../speakers/speaker-temporal-policy";
import { taskSubjectPresentation } from "./portal-task-model";
import styles from "./portal-tasks.module.css";
import { formatPortalDate } from "./portal-ui-model";
import type { PortalProfile, PortalTask } from "./types";

export type TaskFilter = "all" | "attention" | "finished";

const filters: readonly { value: TaskFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs attention" },
  { value: "finished", label: "Finished" },
];

function tone(task: PortalTask): StatusTone {
  if (task.status === "completed") return "success";
  if (task.status === "needs_changes" || task.status === "overdue") return "danger";
  if (task.status === "reopened") return "warning";
  if (task.status === "in_progress" || task.status === "submitted") return "info";
  return "neutral";
}

function statusLabel(task: PortalTask): string {
  return task.status.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function icon(task: PortalTask) {
  if (task.status === "completed" || task.status === "waived")
    return <CheckCircle2 aria-hidden="true" />;
  if (task.status === "needs_changes" || task.status === "overdue")
    return <AlertCircle aria-hidden="true" />;
  if (task.type === "upload") return <FileUp aria-hidden="true" />;
  if (task.type === "form") return <ListChecks aria-hidden="true" />;
  return <Clock3 aria-hidden="true" />;
}

interface Props {
  readonly tasks: readonly PortalTask[];
  readonly profiles: readonly PortalProfile[];
  readonly selectedId: string | null;
  readonly filter: TaskFilter;
  readonly temporalContext?: SpeakerEventTemporalContext;
  readonly onFilter: (filter: TaskFilter) => void;
  readonly onSelect: (taskId: string) => void;
}

export function PortalTaskInbox({
  tasks,
  profiles,
  selectedId,
  filter,
  temporalContext,
  onFilter,
  onSelect,
}: Props) {
  return (
    <div className={styles.inbox}>
      <fieldset className={styles.filters}>
        <legend className={styles.srOnly}>Filter tasks</legend>
        {filters.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={filter === item.value}
            onClick={() => onFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
      </fieldset>
      <ol className={styles.taskList}>
        {tasks.map((task) => {
          const subject = taskSubjectPresentation(task, profiles);
          const deadlineWarning =
            temporalContext === undefined || task.dueAt === undefined
              ? null
              : deadlineAfterEventWarning(task.dueAt.slice(0, 10), temporalContext);
          return (
            <li key={task.id}>
              <button
                className={styles.taskRow}
                type="button"
                aria-current={selectedId === task.id ? "true" : undefined}
                onClick={() => onSelect(task.id)}
              >
                <span className={styles.taskIcon}>{icon(task)}</span>
                <span className={styles.taskRowCopy}>
                  <span className={styles.taskRowTopline}>
                    <strong>{task.title}</strong>
                    <StatusBadge tone={tone(task)}>{statusLabel(task)}</StatusBadge>
                  </span>
                  <span className={styles.taskSubject}>{subject.label}</span>
                  {deadlineWarning ? (
                    <span className={styles.taskSubject}>{deadlineWarning}</span>
                  ) : null}
                  <span className={styles.taskRowMeta}>
                    <span>
                      {formatPortalDate(task.dueAt)
                        ? `Due ${formatPortalDate(task.dueAt)}`
                        : "No due date"}
                    </span>
                    {task.dependencyIds.length > 0 ? (
                      <span>
                        {task.dependencyIds.length} prerequisite
                        {task.dependencyIds.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
