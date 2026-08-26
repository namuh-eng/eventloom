"use client";

import { uploadMimeTypeLabels } from "@eventloom/contracts";
import Link from "next/link";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TemporalPicker } from "@/components/ui/temporal-picker";
import { Textarea } from "@/components/ui/textarea";
import {
  deadlineAfterEventWarning,
  deadlineTemporalPolicy,
  type SpeakerEventTemporalContext,
} from "@/features/speakers/speaker-temporal-policy";
import {
  type DeliverableAsset,
  type DeliverableAssetKind,
  type DeliverableContentHistoryEntry,
  type DeliverableSession,
  type DeliverableSpeakerProfile,
  DeliverablesApiError,
  type DeliverableTaskAssignment,
  type DeliverableTaskInput,
  deliverableAssetKinds,
} from "./api";
import styles from "./deliverables-workspace.module.css";
import {
  type ContentRequestFilters,
  type ContentRequestStatusFilter,
  contentRequestMetrics,
  type DeliverableRow,
  type DeliverableSpeakerContentHistoryState,
  filterContentRequestRows,
  isOutstanding,
} from "./deliverables-workspace-model";
import {
  type RequestFileFormat,
  requestFilePolicyFor,
  requestFilePolicyMimeTypes,
} from "./request-file-policy";

const bytesPerMegabyte = 1024 * 1024;
const sectionClass = styles.section;
const fieldClass = styles.field;
const mutedClass = styles.muted;
const stackClass = styles.stack;
const clusterClass = styles.cluster;
const gridClass = styles.grid;
const tableWrapClass = styles.tableWrap;
const DeliverablesTemporalContext = createContext<SpeakerEventTemporalContext | undefined>(
  undefined,
);

export function DeliverablesTemporalContextProvider({
  value,
  children,
}: Readonly<{ value?: SpeakerEventTemporalContext; children: ReactNode }>) {
  return (
    <DeliverablesTemporalContext.Provider value={value}>
      {children}
    </DeliverablesTemporalContext.Provider>
  );
}

function subscribeToDeliverableTime(): () => void {
  return () => undefined;
}
function browserDeliverableTime(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return "Not recorded";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}
function deliverableTimeFallback(value: string | undefined): string {
  return value === undefined || value.trim().length === 0 ? "Not recorded" : value;
}
function ClientFormattedTime({ value }: Readonly<{ value: string | undefined }>) {
  return useSyncExternalStore(
    subscribeToDeliverableTime,
    () => browserDeliverableTime(value),
    () => deliverableTimeFallback(value),
  );
}
function browserDeliverableDate(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return "No due date";
  const parsed = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString() : value;
}
function deliverableDateFallback(value: string | undefined): string {
  return value === undefined || value.trim().length === 0 ? "No due date" : value;
}
function ClientFormattedDate({ value }: Readonly<{ value: string | undefined }>) {
  return useSyncExternalStore(
    subscribeToDeliverableTime,
    () => browserDeliverableDate(value),
    () => deliverableDateFallback(value),
  );
}
function formatStatus(status: string): string {
  return status.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
function assetFamily(asset: DeliverableAsset): string {
  return `${asset.participantId}\u0000${asset.taskId ?? ""}\u0000${asset.versionFamilyId ?? asset.id}`;
}
function reviewStateForAsset(asset: DeliverableAsset): string {
  if (asset.reviewState !== undefined) return formatStatus(asset.reviewState);
  return asset.state === "ready" ? "Pending review" : formatStatus(asset.state);
}
function messageFromError(error: unknown): string {
  if (error instanceof DeliverablesApiError) {
    if (error.status === 401 || error.status === 403) return `Access denied: ${error.message}`;
    if (error.status === 409 || error.code === "CONFLICT" || error.code === "VERSION_CONFLICT")
      return `This content changed elsewhere. Reload before trying again. ${error.message}`;
    if (error.status === 404) return `Deliverables resource not found: ${error.message}`;
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : "The deliverables request could not be completed.";
}

interface DeliverableSubjectParticipant {
  readonly id: string;
  readonly label: string;
  readonly sessions: readonly { readonly id: string; readonly label: string }[];
}
export function DeliverablesSummary({
  rows,
  activeFilter,
  onFilter,
  participants,
  busy,
  temporalContext,
  onCreateTask,
}: {
  readonly rows: readonly DeliverableRow[];
  readonly activeFilter: ContentRequestStatusFilter;
  readonly onFilter: (filter: ContentRequestStatusFilter) => void;
  readonly participants: readonly DeliverableSubjectParticipant[];
  readonly busy: boolean;
  readonly temporalContext?: SpeakerEventTemporalContext;
  readonly onCreateTask?: (input: DeliverableTaskInput) => Promise<void>;
}) {
  const metrics = contentRequestMetrics(rows);
  const items = [
    ["All requests", metrics.all, "all"],
    ["Outstanding", metrics.outstanding, "outstanding"],
    ["Needs attention", metrics.attention, "attention"],
    ["Ready for review", metrics.review, "review"],
    ["Complete", metrics.complete, "complete"],
  ] as const;

  return (
    <section className={styles.overviewPanel} aria-labelledby="content-requests-overview-heading">
      <div className={styles.overviewHeader}>
        <div>
          <p className={styles.eyebrow}>Collection pulse</p>
          <h2 id="content-requests-overview-heading">Request status</h2>
          <p className={mutedClass}>Use a metric to focus the assignment collection.</p>
        </div>
        <TaskComposer
          participants={participants}
          busy={busy}
          {...(temporalContext === undefined ? {} : { temporalContext })}
          {...(onCreateTask === undefined ? {} : { onCreateTask })}
        />
      </div>
      <div className={styles.summaryGrid}>
        {items.map(([label, value, filter]) => (
          <button
            key={filter}
            type="button"
            className={styles.summaryMetric}
            aria-pressed={activeFilter === filter}
            onClick={() => onFilter(activeFilter === filter && filter !== "all" ? "all" : filter)}
          >
            <strong>{value}</strong>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
type TaskComposerState = {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly dueAt: string;
  readonly acceptedAssetKind: DeliverableAssetKind;
  readonly allowedMimeTypes: readonly string[];
  readonly maxSizeMb: string;
  readonly subjectType: "participant" | "session";
  readonly assigneeIds: readonly string[];
  readonly sessionByParticipant: Readonly<Record<string, string>>;
  readonly formError: string | null;
};

type TaskComposerAction =
  | { readonly type: "set-open"; readonly value: boolean }
  | { readonly type: "set-title"; readonly value: string }
  | { readonly type: "set-description"; readonly value: string }
  | { readonly type: "set-due-at"; readonly value: string }
  | { readonly type: "select-asset-kind"; readonly kind: DeliverableAssetKind }
  | {
      readonly type: "toggle-file-format";
      readonly format: RequestFileFormat;
      readonly checked: boolean;
    }
  | { readonly type: "set-max-size-mb"; readonly value: string }
  | { readonly type: "set-subject-type"; readonly value: "participant" | "session" }
  | { readonly type: "toggle-assignee"; readonly participantId: string }
  | {
      readonly type: "set-session";
      readonly participantId: string;
      readonly sessionId: string;
    }
  | { readonly type: "set-form-error"; readonly value: string | null }
  | { readonly type: "reset" };

function taskComposerInitialState(): TaskComposerState {
  const policy = requestFilePolicyFor("slides");
  return {
    open: false,
    title: "",
    description: "",
    dueAt: "",
    acceptedAssetKind: policy.kind,
    allowedMimeTypes: requestFilePolicyMimeTypes(policy),
    maxSizeMb: String(policy.maxBytes / bytesPerMegabyte),
    subjectType: "session",
    assigneeIds: [],
    sessionByParticipant: {},
    formError: null,
  };
}

function taskComposerReducer(
  state: TaskComposerState,
  action: TaskComposerAction,
): TaskComposerState {
  switch (action.type) {
    case "set-open":
      return { ...state, open: action.value };
    case "set-title":
      return { ...state, title: action.value };
    case "set-description":
      return { ...state, description: action.value };
    case "set-due-at":
      return { ...state, dueAt: action.value };
    case "select-asset-kind": {
      const policy = requestFilePolicyFor(action.kind);
      return {
        ...state,
        acceptedAssetKind: action.kind,
        allowedMimeTypes: requestFilePolicyMimeTypes(policy),
        maxSizeMb: String(policy.maxBytes / bytesPerMegabyte),
      };
    }
    case "toggle-file-format": {
      const selected = new Set(state.allowedMimeTypes);
      for (const mimeType of action.format.mimeTypes) {
        if (action.checked) selected.add(mimeType);
        else selected.delete(mimeType);
      }
      const policy = requestFilePolicyFor(state.acceptedAssetKind);
      return {
        ...state,
        allowedMimeTypes: requestFilePolicyMimeTypes(policy).filter((mimeType) =>
          selected.has(mimeType),
        ),
      };
    }
    case "set-max-size-mb":
      return { ...state, maxSizeMb: action.value };
    case "set-subject-type":
      return { ...state, subjectType: action.value };
    case "toggle-assignee": {
      const assigneeIds = state.assigneeIds.includes(action.participantId)
        ? state.assigneeIds.filter((id) => id !== action.participantId)
        : [...state.assigneeIds, action.participantId];
      return { ...state, assigneeIds };
    }
    case "set-session":
      return {
        ...state,
        sessionByParticipant: {
          ...state.sessionByParticipant,
          [action.participantId]: action.sessionId,
        },
      };
    case "set-form-error":
      return { ...state, formError: action.value };
    case "reset":
      return taskComposerInitialState();
  }
  return state;
}

interface TaskComposerRequestSectionProps {
  readonly title: string;
  readonly description: string;
  readonly dueAt: string;
  readonly temporalContext?: SpeakerEventTemporalContext;
  readonly onTitleChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onDueAtChange: (value: string) => void;
}
function TaskComposerRequestSection({
  title,
  description,
  dueAt,
  temporalContext,
  onTitleChange,
  onDescriptionChange,
  onDueAtChange,
}: Readonly<TaskComposerRequestSectionProps>) {
  const inheritedTemporalContext = useContext(DeliverablesTemporalContext);
  const effectiveTemporalContext = temporalContext ?? inheritedTemporalContext;
  const deadlinePolicy =
    effectiveTemporalContext === undefined
      ? null
      : deadlineTemporalPolicy(effectiveTemporalContext);
  const deadlineWarning =
    effectiveTemporalContext === undefined
      ? null
      : deadlineAfterEventWarning(dueAt, effectiveTemporalContext);
  return (
    <section className={styles.composerSection} aria-labelledby="request-section-heading">
      <div className={styles.composerSectionHeading}>
        <span>1</span>
        <div>
          <h3 id="request-section-heading">Request</h3>
          <p>Give speakers clear instructions and a deadline.</p>
        </div>
      </div>
      <div className={gridClass}>
        <div className={fieldClass}>
          <Label htmlFor="task-name">Task name</Label>
          <Input
            id="task-name"
            value={title}
            onChange={(event) => onTitleChange(event.currentTarget.value)}
            placeholder="Upload Session Presentation"
            required
          />
        </div>
        <div className={fieldClass} style={{ gridColumn: "1 / -1" }}>
          <TemporalPicker
            id="task-due-date"
            mode="single"
            precision="date"
            value={dueAt}
            label="Due date"
            eyebrow="Request deadline"
            description="Choose the exact day this content is due."
            minimumDateTime={deadlinePolicy?.minimumDate}
            onChange={onDueAtChange}
          />
          {deadlineWarning ? (
            <p className={mutedClass} role="status">
              {deadlineWarning}
            </p>
          ) : null}
        </div>
      </div>
      <div className={fieldClass}>
        <Label htmlFor="task-instructions">Instructions</Label>
        <Textarea
          id="task-instructions"
          rows={3}
          value={description}
          onChange={(event) => onDescriptionChange(event.currentTarget.value)}
          placeholder="Final slide deck as a PDF or PowerPoint file, 16:9 aspect ratio."
          required
        />
      </div>
    </section>
  );
}

interface TaskComposerFileSectionProps {
  readonly acceptedAssetKind: DeliverableAssetKind;
  readonly allowedMimeTypes: readonly string[];
  readonly maxSizeMb: string;
  readonly selectedFilePolicy: ReturnType<typeof requestFilePolicyFor>;
  readonly onAssetKindChange: (value: string) => void;
  readonly onFormatToggle: (format: RequestFileFormat, checked: boolean) => void;
  readonly onMaxSizeChange: (value: string) => void;
}
function TaskComposerFileSection({
  acceptedAssetKind,
  allowedMimeTypes,
  maxSizeMb,
  selectedFilePolicy,
  onAssetKindChange,
  onFormatToggle,
  onMaxSizeChange,
}: Readonly<TaskComposerFileSectionProps>) {
  const allowedMimeTypeSet = useMemo(() => new Set(allowedMimeTypes), [allowedMimeTypes]);
  const formatIsSelected = (format: RequestFileFormat): boolean =>
    format.mimeTypes.every((mimeType) => allowedMimeTypeSet.has(mimeType));
  return (
    <section className={styles.composerSection} aria-labelledby="files-section-heading">
      <div className={styles.composerSectionHeading}>
        <span>2</span>
        <div>
          <h3 id="files-section-heading">Files</h3>
          <p>Choose one deliverable type, then set its formats and size limit.</p>
        </div>
      </div>
      <div className={fieldClass}>
        <Label htmlFor="task-asset-kind">File type</Label>
        <Select value={acceptedAssetKind} onValueChange={onAssetKindChange}>
          <SelectTrigger id="task-asset-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {deliverableAssetKinds.map((kind) => {
              const policy = requestFilePolicyFor(kind);
              return (
                <SelectItem key={kind} value={kind}>
                  {policy.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <small className={mutedClass}>
          {selectedFilePolicy.description} Create a separate request when you need a different file
          type or due date.
        </small>
      </div>
      <div className={gridClass}>
        <fieldset className={styles.fieldset} aria-describedby="file-format-help">
          <legend>File formats (required)</legend>
          <div className={styles.optionGrid}>
            {selectedFilePolicy.formats.map((format) => (
              <div key={format.id} className={styles.optionRow}>
                <Checkbox
                  id={`task-file-format-${acceptedAssetKind}-${format.id}`}
                  checked={formatIsSelected(format)}
                  onCheckedChange={(checked) => onFormatToggle(format, checked === true)}
                />
                <Label htmlFor={`task-file-format-${acceptedAssetKind}-${format.id}`}>
                  {format.label}
                </Label>
              </div>
            ))}
          </div>
          <small id="file-format-help" className={mutedClass}>
            Speakers will only be able to upload the selected formats.
          </small>
        </fieldset>
        <div className={fieldClass}>
          <Label htmlFor="task-max-size-mb">Maximum file size (MB)</Label>
          <Input
            id="task-max-size-mb"
            type="number"
            min={1}
            max={selectedFilePolicy.maxBytes / bytesPerMegabyte}
            step={1}
            value={maxSizeMb}
            onChange={(event) => onMaxSizeChange(event.currentTarget.value)}
          />
          <small className={mutedClass}>
            Platform limit for {selectedFilePolicy.label.toLowerCase()}:{" "}
            {selectedFilePolicy.maxBytes / bytesPerMegabyte} MB.
          </small>
        </div>
      </div>
    </section>
  );
}

interface TaskComposerAssignmentSectionProps {
  readonly participants: readonly DeliverableSubjectParticipant[];
  readonly subjectType: "participant" | "session";
  readonly assigneeIds: readonly string[];
  readonly sessionByParticipant: Readonly<Record<string, string>>;
  readonly assignmentCount: number;
  readonly onSubjectTypeChange: (value: "participant" | "session") => void;
  readonly onAssigneeToggle: (participantId: string) => void;
  readonly onSessionChange: (participantId: string, sessionId: string) => void;
}
function TaskComposerAssignmentSection({
  participants,
  subjectType,
  assigneeIds,
  sessionByParticipant,
  assignmentCount,
  onSubjectTypeChange,
  onAssigneeToggle,
  onSessionChange,
}: Readonly<TaskComposerAssignmentSectionProps>) {
  const assigneeIdSet = useMemo(() => new Set(assigneeIds), [assigneeIds]);
  return (
    <section className={styles.composerSection} aria-labelledby="assignments-section-heading">
      <div className={styles.composerSectionHeading}>
        <span>3</span>
        <div>
          <h3 id="assignments-section-heading">Assignments</h3>
          <p>Choose the speakers and the exact subject for each request.</p>
        </div>
      </div>
      <div className={fieldClass}>
        <Label htmlFor="task-subject-type">Request subject</Label>
        <Select
          value={subjectType}
          onValueChange={(value) => onSubjectTypeChange(value as "participant" | "session")}
        >
          <SelectTrigger id="task-subject-type" aria-describedby="task-subject-help">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="session">One accepted session per speaker</SelectItem>
            <SelectItem value="participant">Participant profile (all sessions)</SelectItem>
          </SelectContent>
        </Select>
        <small id="task-subject-help" className={mutedClass}>
          Session requests require an explicit accepted session for every assignee.
        </small>
      </div>
      <fieldset className={styles.fieldset}>
        <legend>Assignees and subjects</legend>
        {participants.length === 0 ? (
          <p className={mutedClass}>
            No authorized speaker records were returned. Task creation cannot be assigned safely.
          </p>
        ) : (
          <div className={styles.assigneeList}>
            {participants.map((participant) => {
              const selected = assigneeIdSet.has(participant.id);
              return (
                <div key={participant.id} className={styles.assigneeRow}>
                  <div className={styles.optionRow}>
                    <Checkbox
                      id={`task-assignee-${participant.id}`}
                      checked={selected}
                      onCheckedChange={() => onAssigneeToggle(participant.id)}
                    />
                    <Label htmlFor={`task-assignee-${participant.id}`}>{participant.label}</Label>
                    {participant.sessions.length > 1 ? (
                      <Badge variant="outline">
                        {participant.sessions.length} accepted sessions
                      </Badge>
                    ) : null}
                  </div>
                  {selected && subjectType === "session" ? (
                    participant.sessions.length === 0 ? (
                      <Alert variant="destructive">
                        <AlertDescription>
                          No accepted session is available for this participant.
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <div className={fieldClass}>
                        <Label htmlFor={`task-session-${participant.id}`}>
                          Accepted session for {participant.label}
                        </Label>
                        <Select
                          {...(sessionByParticipant[participant.id] === undefined
                            ? {}
                            : { value: sessionByParticipant[participant.id] })}
                          onValueChange={(sessionId) => onSessionChange(participant.id, sessionId)}
                        >
                          <SelectTrigger id={`task-session-${participant.id}`}>
                            <SelectValue placeholder="Choose an accepted session" />
                          </SelectTrigger>
                          <SelectContent>
                            {participant.sessions.map((session) => (
                              <SelectItem key={session.id} value={session.id}>
                                {session.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </fieldset>
      <div className={styles.assignmentCount} role="status" aria-live="polite">
        <strong>{assignmentCount}</strong> assignment{assignmentCount === 1 ? "" : "s"} will be
        created.
      </div>
    </section>
  );
}
function TaskComposer({
  participants,
  busy,
  temporalContext,
  onCreateTask,
}: Readonly<{
  participants: readonly DeliverableSubjectParticipant[];
  busy: boolean;
  temporalContext?: SpeakerEventTemporalContext;
  onCreateTask?: (input: DeliverableTaskInput) => Promise<void>;
}>) {
  const [state, dispatch] = useReducer(taskComposerReducer, undefined, taskComposerInitialState);
  const {
    open,
    title,
    description,
    dueAt,
    acceptedAssetKind,
    allowedMimeTypes,
    maxSizeMb,
    subjectType,
    assigneeIds,
    sessionByParticipant,
    formError,
  } = state;
  const assignmentCount = assigneeIds.length;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedTitle = title.trim();
    const normalizedDescription = description.trim();
    const normalizedDueAt = dueAt.trim();
    const maxSize = Number(maxSizeMb);
    if (
      normalizedTitle.length === 0 ||
      normalizedDescription.length === 0 ||
      normalizedDueAt.length === 0
    ) {
      dispatch({
        type: "set-form-error",
        value: "Task name, instructions, and due date are required.",
      });
      return;
    }
    if (allowedMimeTypes.length === 0 || !Number.isSafeInteger(maxSize) || maxSize <= 0) {
      dispatch({
        type: "set-form-error",
        value: "Choose at least one file format and a positive maximum size in MB.",
      });
      return;
    }
    if (assigneeIds.length === 0) {
      dispatch({ type: "set-form-error", value: "Choose at least one speaker assignee." });
      return;
    }
    if (
      subjectType === "session" &&
      assigneeIds.some((participantId) => !sessionByParticipant[participantId])
    ) {
      dispatch({
        type: "set-form-error",
        value: "Choose an explicit accepted session for every selected speaker.",
      });
      return;
    }
    if (onCreateTask === undefined) {
      dispatch({
        type: "set-form-error",
        value: "Task creation is unavailable because no organizer task endpoint is provisioned.",
      });
      return;
    }
    dispatch({ type: "set-form-error", value: null });
    try {
      await onCreateTask({
        title: normalizedTitle,
        description: normalizedDescription,
        dueAt: normalizedDueAt,
        allowedMimeTypes,
        maxSizeBytes: maxSize * bytesPerMegabyte,
        assignments: assigneeIds.map(
          (participantId): DeliverableTaskAssignment =>
            subjectType === "participant"
              ? { participantId, subject: { type: "participant" } }
              : {
                  participantId,
                  subject: {
                    type: "session",
                    sessionId: sessionByParticipant[participantId] ?? "",
                  },
                },
        ),
        acceptedAssetKinds: [acceptedAssetKind],
      });
    } catch (reason) {
      dispatch({ type: "set-form-error", value: messageFromError(reason) });
      return;
    }
    dispatch({ type: "reset" });
  }

  return (
    <div className={styles.createTaskAction}>
      <Dialog open={open} onOpenChange={(value) => dispatch({ type: "set-open", value })}>
        <DialogTrigger asChild>
          <Button type="button" disabled={onCreateTask === undefined}>
            {onCreateTask === undefined ? "Task creation unavailable" : "New content request"}
          </Button>
        </DialogTrigger>
        <DialogContent className={styles.composerDialog}>
          <DialogHeader>
            <DialogTitle>New content request</DialogTitle>
            <DialogDescription>
              Define the request, file policy, and exact speaker assignments.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submit(event)} className={styles.composerForm}>
            <TaskComposerRequestSection
              title={title}
              description={description}
              dueAt={dueAt}
              onTitleChange={(value) => dispatch({ type: "set-title", value })}
              onDescriptionChange={(value) => dispatch({ type: "set-description", value })}
              onDueAtChange={(value) => dispatch({ type: "set-due-at", value })}
              {...(temporalContext === undefined ? {} : { temporalContext })}
            />
            <TaskComposerFileSection
              acceptedAssetKind={acceptedAssetKind}
              allowedMimeTypes={allowedMimeTypes}
              maxSizeMb={maxSizeMb}
              selectedFilePolicy={requestFilePolicyFor(acceptedAssetKind)}
              onAssetKindChange={(value) => {
                const kind = deliverableAssetKinds.find((candidate) => candidate === value);
                if (kind !== undefined) dispatch({ type: "select-asset-kind", kind });
              }}
              onFormatToggle={(format, checked) =>
                dispatch({ type: "toggle-file-format", format, checked })
              }
              onMaxSizeChange={(value) => dispatch({ type: "set-max-size-mb", value })}
            />
            <TaskComposerAssignmentSection
              participants={participants}
              subjectType={subjectType}
              assigneeIds={assigneeIds}
              sessionByParticipant={sessionByParticipant}
              assignmentCount={assignmentCount}
              onSubjectTypeChange={(value) => dispatch({ type: "set-subject-type", value })}
              onAssigneeToggle={(participantId) =>
                dispatch({ type: "toggle-assignee", participantId })
              }
              onSessionChange={(participantId, sessionId) =>
                dispatch({ type: "set-session", participantId, sessionId })
              }
            />
            {formError !== null ? (
              <Alert variant="destructive">
                <AlertTitle>Request not saved</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => dispatch({ type: "set-open", value: false })}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || onCreateTask === undefined}>
                {busy
                  ? "Saving request…"
                  : onCreateTask === undefined
                    ? "Task creation unavailable"
                    : `Create ${assignmentCount} assignment${assignmentCount === 1 ? "" : "s"}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface DeliverablesTableFiltersProps {
  readonly filters: ContentRequestFilters;
  readonly speakers: readonly (readonly [string, string])[];
  readonly sessions: readonly (readonly [string, string])[];
  readonly tasks: readonly (readonly [string, string])[];
  readonly onFiltersChange: (filters: ContentRequestFilters) => void;
}
function DeliverablesTableFilters({
  filters,
  speakers,
  sessions,
  tasks,
  onFiltersChange,
}: Readonly<DeliverablesTableFiltersProps>) {
  const hasActiveFilters =
    filters.query.length > 0 ||
    filters.speakerId !== "all" ||
    filters.sessionId !== "all" ||
    filters.taskId !== "all" ||
    filters.status !== "all";
  return (
    <fieldset className={styles.collectionToolbar}>
      <legend className="sr-only">Content request filters</legend>
      <div className={styles.searchField}>
        <Label className="sr-only" htmlFor="content-requests-search">
          Search assignments
        </Label>
        <Input
          id="content-requests-search"
          type="search"
          value={filters.query}
          onChange={(event) => onFiltersChange({ ...filters, query: event.currentTarget.value })}
          placeholder="Search request, speaker, session, or file"
        />
      </div>
      <Select
        value={filters.status}
        onValueChange={(status) =>
          onFiltersChange({ ...filters, status: status as ContentRequestStatusFilter })
        }
      >
        <SelectTrigger aria-label="Filter by status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="outstanding">Outstanding</SelectItem>
          <SelectItem value="attention">Needs attention</SelectItem>
          <SelectItem value="review">Ready for review</SelectItem>
          <SelectItem value="complete">Complete</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={filters.speakerId}
        onValueChange={(speakerId) => onFiltersChange({ ...filters, speakerId })}
      >
        <SelectTrigger aria-label="Filter by speaker">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All speakers</SelectItem>
          {speakers.map(([id, label]) => (
            <SelectItem key={id} value={id}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.sessionId}
        onValueChange={(sessionId) => onFiltersChange({ ...filters, sessionId })}
      >
        <SelectTrigger aria-label="Filter by session">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All sessions</SelectItem>
          {sessions.map(([id, label]) => (
            <SelectItem key={id} value={id}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.taskId}
        onValueChange={(taskId) => onFiltersChange({ ...filters, taskId })}
      >
        <SelectTrigger aria-label="Filter by request">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All requests</SelectItem>
          {tasks.map(([id, label]) => (
            <SelectItem key={id} value={id}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasActiveFilters ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            onFiltersChange({
              query: "",
              speakerId: "all",
              sessionId: "all",
              taskId: "all",
              status: "all",
            })
          }
        >
          Clear filters
        </Button>
      ) : null}
    </fieldset>
  );
}

interface DeliverablesTableBulkActionsProps {
  readonly selectedOutstandingIds: readonly string[];
  readonly allOutstandingIds: readonly string[];
  readonly busy: boolean;
  readonly onPreviewSelectedReminders: () => void;
  readonly onPreviewAllReminders: () => void;
  readonly onClearSelection: () => void;
}
function DeliverablesTableBulkActions({
  selectedOutstandingIds,
  allOutstandingIds,
  busy,
  onPreviewSelectedReminders,
  onPreviewAllReminders,
  onClearSelection,
}: Readonly<DeliverablesTableBulkActionsProps>) {
  return (
    <>
      {selectedOutstandingIds.length > 0 ? (
        <div className={styles.bulkBar} role="status">
          <strong>
            {selectedOutstandingIds.length} outstanding assignment
            {selectedOutstandingIds.length === 1 ? "" : "s"} selected
          </strong>
          <div className={styles.bulkActions}>
            <Button type="button" onClick={onPreviewSelectedReminders} disabled={busy}>
              Send reminders
            </Button>
            <Button type="button" variant="ghost" onClick={onClearSelection}>
              Clear selection
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.collectionActions}>
          <span className={mutedClass}>
            {allOutstandingIds.length} outstanding assignment
            {allOutstandingIds.length === 1 ? "" : "s"}
          </span>
          <Button
            variant="outline"
            type="button"
            onClick={onPreviewAllReminders}
            disabled={allOutstandingIds.length === 0 || busy}
          >
            Remind all outstanding ({allOutstandingIds.length})
          </Button>
        </div>
      )}
    </>
  );
}

interface DeliverablesTableRowsProps {
  readonly visibleRows: readonly DeliverableRow[];
  readonly selectedTaskIdSet: ReadonlySet<string>;
  readonly selectedAssignmentId: string | null;
  readonly visibleOutstandingIds: readonly string[];
  readonly allVisibleSelected: boolean;
  readonly someVisibleSelected: boolean;
  readonly onToggleTask: (taskId: string) => void;
  readonly onSetVisibleSelection: (taskIds: readonly string[]) => void;
  readonly onOpenAssignment: (taskId: string) => void;
}
function DeliverablesTableRows({
  visibleRows,
  selectedTaskIdSet,
  selectedAssignmentId,
  visibleOutstandingIds,
  allVisibleSelected,
  someVisibleSelected,
  onToggleTask,
  onSetVisibleSelection,
  onOpenAssignment,
}: Readonly<DeliverablesTableRowsProps>) {
  return (
    <>
      {visibleRows.length === 0 ? (
        <p className={mutedClass}>No assignments match these filters.</p>
      ) : (
        <div className={`${tableWrapClass} ${styles.assignmentTable}`}>
          <Table>
            <TableCaption>Per-speaker content request assignments and due dates</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">
                  <Checkbox
                    aria-label="Select all visible outstanding assignments"
                    checked={
                      allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false
                    }
                    disabled={visibleOutstandingIds.length === 0}
                    onCheckedChange={(checked) =>
                      onSetVisibleSelection(checked === true ? visibleOutstandingIds : [])
                    }
                  />
                </TableHead>
                <TableHead scope="col">Request</TableHead>
                <TableHead scope="col">Speaker</TableHead>
                <TableHead scope="col">Session</TableHead>
                <TableHead scope="col">Due</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Current file</TableHead>
                <TableHead scope="col">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => {
                const outstanding = isOutstanding(row.status);
                const versionCount =
                  row.currentAsset === undefined
                    ? 0
                    : row.assets.filter(
                        (asset) =>
                          assetFamily(asset) === assetFamily(row.currentAsset as DeliverableAsset),
                      ).length;
                return (
                  <TableRow
                    key={row.task.id}
                    data-selected={selectedAssignmentId === row.task.id || undefined}
                  >
                    <TableCell>
                      <Checkbox
                        id={`content-request-reminder-${row.task.id}`}
                        checked={selectedTaskIdSet.has(row.task.id)}
                        disabled={!outstanding}
                        onCheckedChange={() => onToggleTask(row.task.id)}
                      />
                      <Label
                        className="sr-only"
                        htmlFor={`content-request-reminder-${row.task.id}`}
                      >
                        {`Select outstanding assignment: ${row.speakerLabel} ${row.task.title}`}
                      </Label>
                    </TableCell>
                    <TableHead scope="row">
                      <strong>{row.task.title}</strong>
                      <small className={mutedClass}>
                        {row.task.description ??
                          row.task.instructions ??
                          "No instructions returned"}
                      </small>
                    </TableHead>
                    <TableCell>{row.speakerLabel}</TableCell>
                    <TableCell>{row.sessionLabel}</TableCell>
                    <TableCell>
                      <ClientFormattedDate value={row.task.dueAt} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={outstanding ? "secondary" : "outline"}>
                        {formatStatus(row.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {row.currentAsset === undefined ? (
                        <span className={mutedClass}>Waiting for upload</span>
                      ) : (
                        <span>
                          {row.currentAsset.fileName}
                          <small className={mutedClass}>
                            v{row.currentAsset.version ?? 1} · {versionCount} version
                            {versionCount === 1 ? "" : "s"}
                          </small>
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => onOpenAssignment(row.task.id)}
                      >
                        Open request
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

export function DeliverablesTable({
  rows,
  selectedTaskIds,
  selectedAssignmentId,
  onToggleTask,
  onSetVisibleSelection,
  onOpenAssignment,
  onPreviewSelectedReminders,
  onPreviewAllReminders,
  filters,
  onFiltersChange,
  busy,
}: Readonly<{
  rows: readonly DeliverableRow[];
  selectedTaskIds: readonly string[];
  selectedAssignmentId: string | null;
  onToggleTask: (taskId: string) => void;
  onSetVisibleSelection: (taskIds: readonly string[]) => void;
  onOpenAssignment: (taskId: string) => void;
  onPreviewSelectedReminders: () => void;
  onPreviewAllReminders: () => void;
  filters: ContentRequestFilters;
  onFiltersChange: (filters: ContentRequestFilters) => void;
  busy: boolean;
}>) {
  const selectedTaskIdSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds]);
  const speakers = [
    ...new Map(rows.map((row) => [row.task.participantId, row.speakerLabel])).entries(),
  ].sort((left, right) => left[1].localeCompare(right[1]));
  const sessions = [
    ...new Map(
      rows.map((row) => [
        row.task.subject.type === "session" ? row.task.subject.sessionId : "participant",
        row.sessionLabel,
      ]),
    ).entries(),
  ].sort((left, right) => left[1].localeCompare(right[1]));
  const tasks = [...new Map(rows.map((row) => [row.task.id, row.task.title])).entries()].sort(
    (left, right) => left[1].localeCompare(right[1]),
  );
  const visibleRows = filterContentRequestRows(rows, filters);
  const visibleOutstandingIds: string[] = [];
  for (const row of visibleRows) {
    if (isOutstanding(row.status)) visibleOutstandingIds.push(row.task.id);
  }
  const allOutstandingIds: string[] = [];
  for (const row of rows) {
    if (isOutstanding(row.status)) allOutstandingIds.push(row.task.id);
  }
  const allOutstandingIdSet = new Set(allOutstandingIds);
  const selectedOutstandingIds = selectedTaskIds.filter((taskId) =>
    allOutstandingIdSet.has(taskId),
  );
  const allVisibleSelected =
    visibleOutstandingIds.length > 0 &&
    visibleOutstandingIds.every((taskId) => selectedTaskIdSet.has(taskId));
  const someVisibleSelected = visibleOutstandingIds.some((taskId) => selectedTaskIdSet.has(taskId));
  return (
    <Card className={sectionClass} aria-labelledby="tracking-heading">
      <CardHeader className={clusterClass}>
        <div>
          <p className={mutedClass}>Speaker follow-up</p>
          <CardTitle id="tracking-heading">Assignments</CardTitle>
          <CardDescription>
            One row per speaker request. Select outstanding rows for reminders or open any
            assignment for detail.
          </CardDescription>
        </div>
        <Badge variant="outline">
          {visibleRows.length} of {rows.length}
        </Badge>
      </CardHeader>
      <CardContent className={stackClass}>
        <DeliverablesTableFilters
          filters={filters}
          speakers={speakers}
          sessions={sessions}
          tasks={tasks}
          onFiltersChange={onFiltersChange}
        />
        <DeliverablesTableBulkActions
          selectedOutstandingIds={selectedOutstandingIds}
          allOutstandingIds={allOutstandingIds}
          busy={busy}
          onPreviewSelectedReminders={onPreviewSelectedReminders}
          onPreviewAllReminders={onPreviewAllReminders}
          onClearSelection={() => onSetVisibleSelection([])}
        />
        <DeliverablesTableRows
          visibleRows={visibleRows}
          selectedTaskIdSet={selectedTaskIdSet}
          selectedAssignmentId={selectedAssignmentId}
          visibleOutstandingIds={visibleOutstandingIds}
          allVisibleSelected={allVisibleSelected}
          someVisibleSelected={someVisibleSelected}
          onToggleTask={onToggleTask}
          onSetVisibleSelection={onSetVisibleSelection}
          onOpenAssignment={onOpenAssignment}
        />
      </CardContent>
    </Card>
  );
}

export function ContentRequestInspector({
  row,
  onInspectAsset,
}: Readonly<{
  row: DeliverableRow;
  onInspectAsset?: (assetId: string) => void;
}>) {
  const task = row.task;
  const policy = [
    ...(task.acceptedAssetKinds ?? []).map(formatStatus),
    ...uploadMimeTypeLabels(task.allowedMimeTypes ?? []),
    ...(task.maxBytes === undefined
      ? []
      : [`Maximum ${Math.ceil(task.maxBytes / 1024 / 1024)} MB`]),
  ];
  return (
    <div className={styles.assignmentInspector}>
      <section>
        <div className={styles.inspectorHeading}>
          <div>
            <p className={styles.eyebrow}>Content request</p>
            <h2>{task.title}</h2>
          </div>
          <Badge variant={isOutstanding(row.status) ? "secondary" : "outline"}>
            {formatStatus(row.status)}
          </Badge>
        </div>
        <dl className={styles.inspectorFacts}>
          <div>
            <dt>Speaker</dt>
            <dd>{row.speakerLabel}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>{row.sessionLabel}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>
              <ClientFormattedDate value={task.dueAt} />
            </dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>
              {task.subject?.type === "participant" ? "Participant profile" : "Accepted session"}
            </dd>
          </div>
        </dl>
      </section>
      <section>
        <h3>Instructions</h3>
        <p>{task.description ?? task.instructions ?? "No instructions were returned."}</p>
      </section>
      <section>
        <h3>File policy</h3>
        {policy.length === 0 ? (
          <p className={mutedClass}>No upload policy was returned.</p>
        ) : (
          <div className={styles.policyList}>
            {policy.map((item) => (
              <Badge key={item} variant="outline">
                {item}
              </Badge>
            ))}
          </div>
        )}
      </section>
      <section>
        <h3>Submission</h3>
        {row.currentAsset === undefined ? (
          <div className={styles.noUploadState}>
            <strong>Waiting for upload</strong>
            <p>The speaker has not submitted a current file for this assignment.</p>
          </div>
        ) : (
          <div className={styles.currentSubmission}>
            <div>
              <strong>{row.currentAsset.fileName}</strong>
              <p>
                Version {row.currentAsset.version ?? 1} · uploaded{" "}
                <ClientFormattedTime value={row.currentAsset.createdAt} /> ·{" "}
                {reviewStateForAsset(row.currentAsset)}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => onInspectAsset?.(row.currentAsset?.id ?? "")}
              disabled={onInspectAsset === undefined}
            >
              Inspect file versions
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

export function ReminderPreview({
  rows,
  busy,
  onSend,
  sendAvailable,
}: Readonly<{
  rows: readonly DeliverableRow[];
  busy: boolean;
  onSend: () => void;
  sendAvailable: boolean;
}>) {
  const effective = rows.filter((row) => isOutstanding(row.status));
  const recipients = [
    ...new Map(effective.map((row) => [row.task.participantId, row.speakerLabel])).entries(),
  ];
  const snapshotKey = effective
    .map(
      (row) =>
        `${row.task.id}\u0000${row.task.version}\u0000${row.task.participantId}\u0000${row.task.dueAt ?? ""}\u0000${row.status}`,
    )
    .join("\u0001");
  const [confirmedSnapshotKey, setConfirmedSnapshotKey] = useState<string | null>(null);
  const confirmed = confirmedSnapshotKey === snapshotKey;
  return (
    <Card className={sectionClass} aria-labelledby="reminder-preview-heading">
      <CardHeader className={clusterClass}>
        <div>
          <p className={mutedClass}>Human review required</p>
          <CardTitle id="reminder-preview-heading">Reminder recipient preview</CardTitle>
          <CardDescription>
            Only the outstanding assignment snapshot below will be sent. No email is sent until you
            confirm this recipient list.
          </CardDescription>
        </div>
        <div className={styles.previewCounts}>
          <Badge variant="outline">
            {effective.length} assignment{effective.length === 1 ? "" : "s"}
          </Badge>
          <Badge variant="outline">
            {recipients.length} recipient{recipients.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className={stackClass}>
        {recipients.length === 0 ? (
          <p className={mutedClass}>No outstanding assignments are available for a reminder.</p>
        ) : (
          <div className={tableWrapClass}>
            <Table>
              <TableCaption>Recipient and assignment snapshot</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Recipient</TableHead>
                  <TableHead scope="col">Outstanding assignment</TableHead>
                  <TableHead scope="col">Due date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {effective.map((row) => (
                  <TableRow key={`preview-${row.task.id}`}>
                    <TableHead scope="row">{row.speakerLabel}</TableHead>
                    <TableCell>{row.task.title}</TableCell>
                    <TableCell>
                      <ClientFormattedDate value={row.task.dueAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className={clusterClass}>
          <Checkbox
            id="reminder-confirm"
            checked={confirmed}
            disabled={effective.length === 0 || !sendAvailable || busy}
            onCheckedChange={(checked) =>
              setConfirmedSnapshotKey(checked === true ? snapshotKey : null)
            }
          />
          <Label htmlFor="reminder-confirm">
            I confirm this exact outstanding recipient and assignment snapshot.
          </Label>
        </div>
        <div className={clusterClass}>
          <Button
            type="button"
            disabled={busy || !sendAvailable || effective.length === 0 || !confirmed}
            onClick={() => {
              onSend();
              setConfirmedSnapshotKey(null);
            }}
          >
            {busy
              ? "Sending reminders…"
              : sendAvailable
                ? "Confirm and send reminders"
                : "Reminder sending unavailable"}
          </Button>
          {!sendAvailable ? (
            <span className={mutedClass}>
              The transactional reminder endpoint is not provisioned; no send was attempted.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function SessionEditor(
  props: Readonly<{
    readonly organizationId: string;
    readonly eventId: string;
    readonly sessions: readonly DeliverableSession[];
    readonly loadingHistory: boolean;
    readonly busy: boolean;
    readonly onSave?: (input: {
      readonly sessionId: string;
      readonly expectedVersion: number;
      readonly title: string;
      readonly description: string;
    }) => Promise<void>;
    readonly selectedSessionId?: string;
    readonly sessionHistory?: readonly DeliverableContentHistoryEntry[];
    readonly sessionHistoryError?: string | null;
    readonly onSelectSession?: (sessionId: string) => void;
    readonly onApprove?: (
      session: DeliverableSession,
      contentStatus: "Approved" | "Needs changes",
    ) => Promise<void>;
    readonly onRestore?: (input: {
      readonly sessionId: string;
      readonly version: number;
      readonly expectedVersion: number;
    }) => Promise<void>;
  }>,
) {
  const selectedSessionId = props.selectedSessionId ?? props.sessions[0]?.id;
  const href = `/admin/organizations/${encodeURIComponent(
    props.organizationId,
  )}/events/${encodeURIComponent(props.eventId)}/sessions${
    selectedSessionId === undefined ? "" : `?session=${encodeURIComponent(selectedSessionId)}`
  }`;

  return (
    <Card className={styles.contentCard} aria-labelledby="session-content-heading">
      <CardHeader>
        <CardTitle id="session-content-heading">Session content lives in Sessions</CardTitle>
        <CardDescription>
          Edit titles and abstracts, review attributed history, restore prior versions, and approve
          public content from the canonical session record.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link href={href}>Open Sessions</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export function SpeakerEditor(
  props: Readonly<{
    readonly organizationId: string;
    readonly eventId: string;
    readonly sessions: readonly DeliverableSession[];
    readonly profiles: readonly DeliverableSpeakerProfile[];
    readonly assets: readonly DeliverableAsset[];
    readonly busy: boolean;
    readonly speakerContentHistory?: Readonly<
      Record<string, DeliverableSpeakerContentHistoryState>
    >;
    readonly onSaveBiography?: (input: {
      readonly participantId: string;
      readonly biography: string;
      readonly expectedVersion: number;
    }) => Promise<void>;
    readonly onReplaceHeadshot?: (input: {
      readonly submissionId: string;
      readonly participantId: string;
      readonly file: File;
      readonly supersedesAssetId?: string;
    }) => Promise<void>;
    readonly onRestoreSpeakerContentVersion?: (input: {
      readonly participantId: string;
      readonly version: number;
      readonly expectedVersion: number;
    }) => Promise<void>;
  }>,
) {
  const href = `/admin/organizations/${encodeURIComponent(
    props.organizationId,
  )}/events/${encodeURIComponent(props.eventId)}/speakers`;

  return (
    <Card className={styles.contentCard} aria-labelledby="speaker-content-heading">
      <CardHeader>
        <CardTitle id="speaker-content-heading">Speaker profiles live in Speakers</CardTitle>
        <CardDescription>
          Manage event biographies, selected headshots, onboarding, and speaker-specific
          communication from the canonical speaker record.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link href={href}>Open Speakers</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
