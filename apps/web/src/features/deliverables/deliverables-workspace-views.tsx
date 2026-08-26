"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type {
  DeliverableAsset,
  DeliverableAssetHistoryEntry,
  DeliverableComment,
  DeliverableContentHistoryEntry,
  DeliverableExportDownload,
  DeliverableExportInput,
  DeliverableMatrixItem,
  DeliverableReviewInput,
  DeliverableReviewState,
  DeliverableSession,
  DeliverableSpeakerProfile,
  DeliverableTask,
  DeliverableTaskInput,
} from "./api";
import styles from "./deliverables-workspace.module.css";
import {
  type ContentRequestFilters,
  type ContentRequestStatusFilter,
  type DeliverableRow,
  type DeliverableSpeakerContentHistoryState,
  type DeliverablesWorkspaceMode,
  filterContentRequestRows,
  isOutstanding,
  triggerDeliverablesDownload,
} from "./deliverables-workspace-model";
import {
  ContentRequestInspector,
  DeliverablesSummary,
  DeliverablesTable,
  ReminderPreview,
  SessionEditor,
  SpeakerEditor,
} from "./deliverables-workspace-sections";
import { type FileFamilyProjection, projectFileFamilies } from "./file-family-model";
import { FileLibrary } from "./file-library";
import { FileReviewDrawer } from "./file-review-drawer";

const pageClass = styles.workspace;
const sectionClass = styles.section;
const mutedClass = styles.muted;
const stackClass = styles.stack;
const clusterClass = styles.cluster;
const dangerClass = styles.danger;
const statusClass = styles.status;
const EMPTY_ASSET_HISTORY: readonly DeliverableAssetHistoryEntry[] = [];
const EMPTY_COMMENTS: readonly DeliverableComment[] = [];
const EMPTY_TASK_IDS: readonly string[] = [];
const DEFAULT_CONTENT_REQUEST_FILTERS: ContentRequestFilters = {
  query: "",
  speakerId: "all",
  sessionId: "all",
  taskId: "all",
  status: "all",
};

interface DeliverablesViewOverrides {
  readonly ownerKey: string;
  readonly filters: ContentRequestFilters;
  readonly selectedTaskIds: readonly string[];
  readonly selectedAssignmentId: string | null;
}

function initialDeliverablesViewOverrides(ownerKey: string): DeliverablesViewOverrides {
  return {
    ownerKey,
    filters: DEFAULT_CONTENT_REQUEST_FILTERS,
    selectedTaskIds: EMPTY_TASK_IDS,
    selectedAssignmentId: null,
  };
}

interface DeliverablesOperationState {
  readonly key: string;
  readonly label: string;
  readonly phase: "pending" | "succeeded" | "failed";
  readonly message: string;
}

export interface DeliverablesWorkspaceViewProps {
  readonly eventId: string;
  readonly organizationId: string;
  readonly mode?: DeliverablesWorkspaceMode;
  readonly sessions: readonly DeliverableSession[];
  readonly tasks: readonly DeliverableTask[];
  readonly assets: readonly DeliverableAsset[];
  readonly profiles: readonly DeliverableSpeakerProfile[];
  readonly speakerContentHistory?: Readonly<Record<string, DeliverableSpeakerContentHistoryState>>;
  readonly matrixItems?: readonly DeliverableMatrixItem[];
  readonly loading?: boolean;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly statusMessage?: string | null;
  readonly capabilityMessages?: readonly string[];
  readonly operationStates?: readonly DeliverablesOperationState[];
  readonly selectedSessionId?: string;
  readonly sessionHistory?: readonly DeliverableContentHistoryEntry[];
  readonly sessionHistoryError?: string | null;
  readonly onSelectSession?: (sessionId: string) => void;
  readonly onCreateTask?: (input: DeliverableTaskInput) => Promise<void>;
  readonly onInspectAsset?: (assetId: string) => void;
  readonly onCloseAsset?: () => void;
  readonly selectedAssetId?: string | null;
  readonly assetHistory?: readonly DeliverableAssetHistoryEntry[];
  readonly comments?: readonly DeliverableComment[];
  readonly loadingAssetDetails?: boolean;
  readonly assetHistoryError?: string | null;
  readonly commentsError?: string | null;
  readonly loadingSessionHistories?: boolean;
  readonly onAddComment?: (input: {
    readonly assetId: string;
    readonly body: string;
    readonly expectedVersion: number;
  }) => Promise<void>;
  readonly onDownloadVersion?: (assetId: string) => Promise<void>;
  readonly onExportFiles?: (
    input: DeliverableExportInput,
  ) => Promise<DeliverableExportDownload | undefined>;
  readonly onReviewAsset?: (input: DeliverableReviewInput) => Promise<void>;
  readonly onSendBulkReminder?: (input: {
    readonly taskIds: readonly string[];
    readonly recipientIds: readonly string[];
  }) => Promise<void>;
  readonly onSaveSession?: (input: {
    readonly sessionId: string;
    readonly expectedVersion: number;
    readonly title: string;
    readonly description: string;
  }) => Promise<void>;
  readonly onApproveSession?: (
    session: DeliverableSession,
    contentStatus: "Approved" | "Needs changes",
  ) => Promise<void>;
  readonly onRestoreSessionVersion?: (input: {
    readonly sessionId: string;
    readonly version: number;
    readonly expectedVersion: number;
  }) => Promise<void>;
  readonly onRestoreSpeakerContentVersion?: (input: {
    readonly participantId: string;
    readonly version: number;
    readonly expectedVersion: number;
  }) => Promise<void>;
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
  readonly onRetry?: () => void;
}

function formatStatus(status: string): string {
  return status.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
function assetFamily(asset: DeliverableAsset): string {
  return `${asset.participantId}\u0000${asset.taskId ?? ""}\u0000${asset.versionFamilyId ?? asset.id}`;
}
function compareAssetVersions(left: DeliverableAsset, right: DeliverableAsset): number {
  return (
    (right.version ?? 0) - (left.version ?? 0) ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
function latestAsset(assets: readonly DeliverableAsset[]): DeliverableAsset | undefined {
  return assets.reduce<DeliverableAsset | undefined>(
    (current, candidate) =>
      current === undefined || compareAssetVersions(candidate, current) < 0 ? candidate : current,
    undefined,
  );
}
function isCurrentAsset(asset: DeliverableAsset, assets: readonly DeliverableAsset[]): boolean {
  const family = assetFamily(asset);
  return (
    latestAsset(assets.filter((candidate) => assetFamily(candidate) === family))?.id === asset.id
  );
}
function statusForTask(
  task: DeliverableTask,
  assets: readonly DeliverableAsset[],
): DeliverableRow["status"] {
  const latest = assets.find((asset) => isCurrentAsset(asset, assets));
  if (latest?.reviewState === "needs_changes") return "needs_changes";
  if (latest?.state === "ready") {
    return task.status === "completed" || task.status === "waived" ? task.status : "uploaded";
  }
  return task.status;
}
function taskRows(
  tasks: readonly DeliverableTask[],
  sessions: readonly DeliverableSession[],
  assets: readonly DeliverableAsset[],
  profiles: readonly DeliverableSpeakerProfile[],
): readonly DeliverableRow[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const profileById = new Map(profiles.map((profile) => [profile.participantId, profile]));
  return tasks.map((task) => {
    const sessionId = task.subject.type === "session" ? task.subject.sessionId : undefined;
    const session = sessionId === undefined ? undefined : sessionById.get(sessionId);
    const speaker = profileById.get(task.participantId);
    const relatedAssets = assets.filter(
      (asset) => asset.participantId === task.participantId && asset.taskId === task.id,
    );
    return {
      task,
      session,
      sessionLabel: session?.title ?? task.sessionTitle ?? "Session unavailable",
      speaker,
      speakerLabel: task.participantName ?? speaker?.displayName ?? "Speaker",
      assets: relatedAssets,
      currentAsset: relatedAssets.find((asset) => isCurrentAsset(asset, relatedAssets)),
      status: statusForTask(task, relatedAssets),
    };
  });
}
function matrixRows(
  items: readonly DeliverableMatrixItem[],
  sessions: readonly DeliverableSession[],
  profiles: readonly DeliverableSpeakerProfile[],
): readonly DeliverableRow[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const profileById = new Map(profiles.map((profile) => [profile.participantId, profile]));
  return items.map((item) => {
    const task = item.task;
    const sessionId = task.subject.type === "session" ? task.subject.sessionId : undefined;
    const session = sessionId === undefined ? undefined : sessionById.get(sessionId);
    const speaker = profileById.get(item.participantId);
    return {
      task,
      session,
      sessionLabel: session?.title ?? task.sessionTitle ?? "Session unavailable",
      speaker,
      speakerLabel:
        item.participantName ?? task.participantName ?? speaker?.displayName ?? "Speaker",
      assets: item.assets,
      currentAsset: item.currentAsset,
      status: item.status,
    };
  });
}
function matrixAssetsFromItems(
  items: readonly DeliverableMatrixItem[],
): readonly DeliverableAsset[] {
  const byId = new Map<string, DeliverableAsset>();
  for (const item of items) {
    for (const asset of item.assets) byId.set(asset.id, asset);
    if (item.currentAsset !== undefined) byId.set(item.currentAsset.id, item.currentAsset);
  }
  return [...byId.values()];
}
function authoritativeCurrentAssetFor(
  selectedAsset: DeliverableAsset | undefined,
  matrixItems: readonly DeliverableMatrixItem[] | undefined,
): DeliverableAsset | undefined {
  if (selectedAsset === undefined || matrixItems === undefined) return undefined;
  for (const item of matrixItems) {
    if (item.assets.some((candidate) => assetFamily(candidate) === assetFamily(selectedAsset))) {
      if (item.currentAsset !== undefined) return item.currentAsset;
    }
  }
  return undefined;
}

interface DeliverableSubjectParticipant {
  readonly id: string;
  readonly label: string;
  readonly sessions: readonly { readonly id: string; readonly label: string }[];
}
function subjectParticipants(
  profiles: readonly DeliverableSpeakerProfile[],
  rows: readonly DeliverableRow[],
  sessions: readonly DeliverableSession[],
): readonly DeliverableSubjectParticipant[] {
  const byId = new Map<string, string>();
  for (const profile of profiles) byId.set(profile.participantId, profile.displayName);
  for (const row of rows) byId.set(row.task.participantId, row.speakerLabel);
  const participants = [...byId.entries()].map(([id, label]) => {
    const participantSessions: { id: string; label: string }[] = [];
    for (const session of sessions) {
      if (
        session.status.toLocaleLowerCase() === "accepted" &&
        (session.speakerIds.includes(id) ||
          session.speakerRoster.some((member) => member.id === id))
      ) {
        participantSessions.push({ id: session.id, label: session.title });
      }
    }
    participantSessions.sort((left, right) => left.label.localeCompare(right.label));
    return { id, label, sessions: participantSessions };
  });
  participants.sort((left, right) => left.label.localeCompare(right.label));
  return participants;
}

interface WorkspaceHeaderProps {
  readonly organizationId: string;
  readonly eventId: string;
  readonly filesMode: boolean;
  readonly assignmentCount: number;
  readonly fileCount: number;
}
function WorkspaceHeader({
  organizationId,
  eventId,
  filesMode,
  assignmentCount,
  fileCount,
}: Readonly<WorkspaceHeaderProps>) {
  const organization = encodeURIComponent(organizationId);
  const event = encodeURIComponent(eventId);
  const deliverablesHref = `/admin/organizations/${organization}/events/${event}/deliverables`;
  const filesHref = `/admin/organizations/${organization}/events/${event}/files`;
  return (
    <Card className={styles.header}>
      <CardHeader className={clusterClass}>
        <div>
          <p className={styles.eyebrow}>
            Speaker operations · {filesMode ? "Files library" : "Requests"}
          </p>
          <h1>Content collection</h1>
          <p className={styles.lede}>
            {filesMode
              ? "Review submitted files, manage versions, and download approved material."
              : "Define what speakers owe, assign recipients, and follow up."}
          </p>
        </div>
        <Badge variant="outline">
          {filesMode
            ? `${fileCount} uploaded file${fileCount === 1 ? "" : "s"}`
            : `${assignmentCount} assignment${assignmentCount === 1 ? "" : "s"}`}
        </Badge>
      </CardHeader>
      <CardContent className={styles.switcherWrap}>
        <nav className={styles.modeNav} aria-label="Content collection sections" data-mode-switcher>
          <Link href={deliverablesHref} aria-current={!filesMode ? "page" : undefined}>
            Requests <span>Assign &amp; track</span>
          </Link>
          <Link href={filesHref} aria-current={filesMode ? "page" : undefined}>
            Files <span>Review &amp; download</span>
          </Link>
        </nav>
        <details className={styles.mobileSwitcher}>
          <summary>Switch section: {filesMode ? "Files" : "Requests"}</summary>
          <nav aria-label="Mobile section switcher">
            <Link href={deliverablesHref}>Requests — Assign &amp; track</Link>
            <Link href={filesHref}>Files — Review &amp; download</Link>
          </nav>
        </details>
      </CardContent>
    </Card>
  );
}

interface WorkspaceStatusProps {
  readonly filesMode: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly statusMessage: string | null;
  readonly capabilityMessages: readonly string[];
  readonly operationStates: readonly DeliverablesOperationState[];
  readonly onRetry?: () => void;
}
function WorkspaceStatus({
  filesMode,
  loading,
  error,
  statusMessage,
  capabilityMessages,
  operationStates,
  onRetry,
}: Readonly<WorkspaceStatusProps>) {
  return (
    <>
      {error !== null ? (
        <Alert variant="destructive" role="alert" className={dangerClass}>
          <AlertTitle>
            {filesMode
              ? "Files action was not completed."
              : "Content requests action was not completed."}
          </AlertTitle>
          <AlertDescription>
            {error}
            {onRetry === undefined ? null : (
              <Button variant="outline" type="button" onClick={onRetry}>
                Retry
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {capabilityMessages.length > 0 && !filesMode ? (
        <Card className={sectionClass} aria-labelledby="capability-heading">
          <CardHeader>
            <CardTitle id="capability-heading">Capability status</CardTitle>
          </CardHeader>
          <CardContent>
            <ul>
              {capabilityMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {statusMessage !== null ? (
        <div role="status" aria-live="polite" className={statusClass}>
          {statusMessage}
        </div>
      ) : null}
      {operationStates.length > 0 ? (
        <Card className={sectionClass} aria-labelledby="operation-status-heading">
          <CardHeader>
            <CardTitle id="operation-status-heading">Organizer operation status</CardTitle>
          </CardHeader>
          <CardContent>
            <ul aria-live="polite">
              {operationStates.map((operation) => (
                <li key={operation.key} data-operation-phase={operation.phase}>
                  <strong>{operation.label}</strong>: {formatStatus(operation.phase)} —{" "}
                  {operation.message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {loading ? (
        <Card className={sectionClass} role="status">
          <CardHeader>
            <CardTitle>
              {filesMode ? "Loading Files library" : "Loading content requests"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              {filesMode
                ? "Retrieving authorized event sessions, private asset projections, and speaker records."
                : "Retrieving organization- and event-qualified sessions plus the authoritative deliverables matrix."}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

interface RequestsSectionProps {
  readonly viewOwnerKey: string;
  readonly rows: readonly DeliverableRow[];
  readonly filters: ContentRequestFilters;
  readonly participants: readonly DeliverableSubjectParticipant[];
  readonly selectedTaskIds: readonly string[];
  readonly selectedAssignmentId: string | null;
  readonly selectedAssignment: DeliverableRow | undefined;
  readonly reminderPreviewRows: readonly DeliverableRow[];
  readonly reminderPreviewMode: "selected" | "all" | null;
  readonly busy: boolean;
  readonly onCreateTask?: (input: DeliverableTaskInput) => Promise<void>;
  readonly onFilter: (status: ContentRequestStatusFilter) => void;
  readonly onToggleTask: (taskId: string) => void;
  readonly onSetVisibleSelection: (taskIds: readonly string[]) => void;
  readonly onOpenAssignment: (taskId: string) => void;
  readonly onFiltersChange: (filters: ContentRequestFilters) => void;
  readonly onPreviewSelectedReminders: () => void;
  readonly onPreviewAllReminders: () => void;
  readonly onReminderOpenChange: (open: boolean) => void;
  readonly onSendBulkReminder?: (input: {
    readonly taskIds: readonly string[];
    readonly recipientIds: readonly string[];
  }) => Promise<void>;
  readonly onAssignmentOpenChange: (open: boolean) => void;
  readonly onInspectAsset?: (assetId: string) => void;
}
function RequestsSection({
  viewOwnerKey,
  rows,
  filters,
  participants,
  selectedTaskIds,
  selectedAssignmentId,
  selectedAssignment,
  reminderPreviewRows,
  reminderPreviewMode,
  busy,
  onCreateTask,
  onFilter,
  onToggleTask,
  onSetVisibleSelection,
  onOpenAssignment,
  onFiltersChange,
  onPreviewSelectedReminders,
  onPreviewAllReminders,
  onReminderOpenChange,
  onSendBulkReminder,
  onAssignmentOpenChange,
  onInspectAsset,
}: Readonly<RequestsSectionProps>) {
  const reminderSend = useCallback(() => {
    const recipientIds = [...new Set(reminderPreviewRows.map((row) => row.task.participantId))];
    void onSendBulkReminder?.({
      taskIds: reminderPreviewRows.map((row) => row.task.id),
      recipientIds,
    });
    onSetVisibleSelection([]);
    onReminderOpenChange(false);
  }, [onReminderOpenChange, onSendBulkReminder, onSetVisibleSelection, reminderPreviewRows]);
  return (
    <>
      <DeliverablesSummary
        key={viewOwnerKey}
        rows={rows}
        activeFilter={filters.status}
        onFilter={onFilter}
        participants={participants}
        busy={busy}
        {...(onCreateTask === undefined ? {} : { onCreateTask })}
      />
      <DeliverablesTable
        rows={rows}
        selectedTaskIds={selectedTaskIds}
        selectedAssignmentId={selectedAssignmentId}
        onToggleTask={onToggleTask}
        onSetVisibleSelection={onSetVisibleSelection}
        onOpenAssignment={onOpenAssignment}
        onPreviewSelectedReminders={onPreviewSelectedReminders}
        onPreviewAllReminders={onPreviewAllReminders}
        filters={filters}
        onFiltersChange={onFiltersChange}
        busy={busy}
      />
      <Dialog open={reminderPreviewMode !== null} onOpenChange={onReminderOpenChange}>
        <DialogContent className={styles.dialogContent}>
          <DialogHeader>
            <DialogTitle>Reminder recipient preview</DialogTitle>
            <DialogDescription>
              Review the exact outstanding assignment snapshot before sending.
            </DialogDescription>
          </DialogHeader>
          <ReminderPreview
            rows={reminderPreviewRows}
            busy={busy}
            sendAvailable={onSendBulkReminder !== undefined}
            onSend={reminderSend}
          />
        </DialogContent>
      </Dialog>
      <Sheet open={selectedAssignment !== undefined} onOpenChange={onAssignmentOpenChange}>
        <SheetContent className={styles.assignmentSheet}>
          <SheetHeader>
            <SheetTitle>Request detail</SheetTitle>
            <SheetDescription>
              Assignment context, upload policy, and current submission state.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className={styles.assetScroll}>
            {selectedAssignment === undefined ? null : (
              <ContentRequestInspector
                row={selectedAssignment}
                {...(onInspectAsset === undefined
                  ? {}
                  : {
                      onInspectAsset: (assetId) => {
                        onAssignmentOpenChange(false);
                        onInspectAsset(assetId);
                      },
                    })}
              />
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  );
}

interface FilesSectionProps {
  readonly organizationId: string;
  readonly eventId: string;
  readonly families: readonly FileFamilyProjection[];
  readonly activeFamily: FileFamilyProjection | undefined;
  readonly sessions: readonly DeliverableSession[];
  readonly tasks: readonly DeliverableTask[];
  readonly profiles: readonly DeliverableSpeakerProfile[];
  readonly busy: boolean;
  readonly loadFailed: boolean;
  readonly onRetry?: () => void;
  readonly onInspectAsset?: (assetId: string) => void;
  readonly onExportFiles?: (
    input: DeliverableExportInput,
  ) => Promise<DeliverableExportDownload | undefined>;
}
function FilesSection({
  organizationId,
  eventId,
  families,
  activeFamily,
  sessions,
  tasks,
  profiles,
  busy,
  loadFailed,
  onRetry,
  onInspectAsset,
  onExportFiles,
}: Readonly<FilesSectionProps>) {
  return (
    <FileLibrary
      organizationId={organizationId}
      eventId={eventId}
      families={families}
      sessions={sessions}
      tasks={tasks}
      profiles={profiles}
      busy={busy}
      loadFailed={loadFailed}
      onStartDownload={triggerDeliverablesDownload}
      {...(activeFamily === undefined ? {} : { activeFamilyId: activeFamily.familyId })}
      {...(onInspectAsset === undefined ? {} : { onInspectAsset })}
      {...(onExportFiles === undefined ? {} : { onExport: onExportFiles })}
      {...(onRetry === undefined ? {} : { onRetry })}
    />
  );
}

interface SelectedAssetEvidenceProps {
  readonly selectedAssetId: string | null;
  readonly selectedAsset: DeliverableAsset | undefined;
  readonly selectedAssetCurrentLabel: string | null;
  readonly selectedAssetVersions: readonly DeliverableAsset[];
  readonly assetHistoryError: string | null;
  readonly comments: readonly DeliverableComment[];
}
function SelectedAssetEvidence({
  selectedAssetId,
  selectedAsset,
  selectedAssetCurrentLabel,
  selectedAssetVersions,
  assetHistoryError,
  comments,
}: Readonly<SelectedAssetEvidenceProps>) {
  if (selectedAssetId === null) return null;
  return (
    <Card className={sectionClass} aria-label="Selected asset evidence">
      <CardHeader>
        <CardTitle>Selected file: {selectedAsset?.fileName ?? "Unavailable"}</CardTitle>
        <CardDescription>Asset detail is open in the focus-managed detail sheet.</CardDescription>
      </CardHeader>
      <CardContent className={stackClass}>
        {selectedAsset === undefined ? (
          <Alert role="status">
            <AlertDescription>
              Refreshing the selected private asset from the authoritative event projection.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <p className={mutedClass}>
              {selectedAssetCurrentLabel} · {selectedAssetVersions.length} version
              {selectedAssetVersions.length === 1 ? "" : "s"}
            </p>
            {assetHistoryError !== null ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Version history unavailable</AlertTitle>
                <AlertDescription>
                  Version history unavailable: {assetHistoryError}
                </AlertDescription>
              </Alert>
            ) : null}
            {comments.length > 0 ? (
              <ul aria-label="Selected asset comment evidence">
                {comments.map((comment) => (
                  <li key={comment.id}>{comment.body}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface RelatedRecordsProps {
  readonly organizationId: string;
  readonly eventId: string;
  readonly sessions: readonly DeliverableSession[];
  readonly profiles: readonly DeliverableSpeakerProfile[];
  readonly assets: readonly DeliverableAsset[];
  readonly busy: boolean;
  readonly speakerContentHistory?: Readonly<Record<string, DeliverableSpeakerContentHistoryState>>;
  readonly selectedSessionId?: string;
  readonly sessionHistory?: readonly DeliverableContentHistoryEntry[];
  readonly sessionHistoryError?: string | null;
  readonly loadingSessionHistories: boolean;
  readonly onSelectSession?: (sessionId: string) => void;
  readonly onSaveSession?: DeliverablesWorkspaceViewProps["onSaveSession"];
  readonly onApproveSession?: DeliverablesWorkspaceViewProps["onApproveSession"];
  readonly onRestoreSessionVersion?: DeliverablesWorkspaceViewProps["onRestoreSessionVersion"];
  readonly onSaveBiography?: DeliverablesWorkspaceViewProps["onSaveBiography"];
  readonly onReplaceHeadshot?: DeliverablesWorkspaceViewProps["onReplaceHeadshot"];
  readonly onRestoreSpeakerContentVersion?: DeliverablesWorkspaceViewProps["onRestoreSpeakerContentVersion"];
}
function RelatedRecords({
  organizationId,
  eventId,
  sessions,
  profiles,
  assets,
  busy,
  speakerContentHistory,
  selectedSessionId,
  sessionHistory,
  sessionHistoryError,
  loadingSessionHistories,
  onSelectSession,
  onSaveSession,
  onApproveSession,
  onRestoreSessionVersion,
  onSaveBiography,
  onReplaceHeadshot,
  onRestoreSpeakerContentVersion,
}: Readonly<RelatedRecordsProps>) {
  return (
    <section className={styles.contentSection} aria-labelledby="secondary-content-heading">
      <div className={styles.contentSectionHeader}>
        <div>
          <p className={styles.eyebrow}>Related records</p>
          <h2 id="secondary-content-heading">Continue in Sessions or Speakers</h2>
        </div>
        <p className={mutedClass}>
          Requests tracks what speakers owe. Canonical content and profiles stay with their source
          records.
        </p>
      </div>
      <div>
        <SessionEditor
          organizationId={organizationId}
          eventId={eventId}
          {...(selectedSessionId === undefined ? {} : { selectedSessionId })}
          {...(sessionHistory === undefined ? {} : { sessionHistory })}
          {...(sessionHistoryError === undefined ? {} : { sessionHistoryError })}
          {...(onSelectSession === undefined ? {} : { onSelectSession })}
          sessions={sessions}
          loadingHistory={loadingSessionHistories}
          busy={busy}
          {...(onSaveSession === undefined ? {} : { onSave: onSaveSession })}
          {...(onApproveSession === undefined ? {} : { onApprove: onApproveSession })}
          {...(onRestoreSessionVersion === undefined ? {} : { onRestore: onRestoreSessionVersion })}
        />
      </div>
      <div>
        <SpeakerEditor
          organizationId={organizationId}
          eventId={eventId}
          sessions={sessions}
          profiles={profiles}
          assets={assets}
          busy={busy}
          {...(speakerContentHistory === undefined ? {} : { speakerContentHistory })}
          {...(onSaveBiography === undefined ? {} : { onSaveBiography })}
          {...(onReplaceHeadshot === undefined ? {} : { onReplaceHeadshot })}
          {...(onRestoreSpeakerContentVersion === undefined
            ? {}
            : { onRestoreSpeakerContentVersion })}
        />
      </div>
    </section>
  );
}

interface WorkspaceCanvasProps {
  readonly eventId: string;
  readonly organizationId: string;
  readonly mode: DeliverablesWorkspaceMode;
  readonly filesMode: boolean;
  readonly rows: readonly DeliverableRow[];
  readonly sessions: readonly DeliverableSession[];
  readonly tasks: readonly DeliverableTask[];
  readonly profiles: readonly DeliverableSpeakerProfile[];
  readonly participants: readonly DeliverableSubjectParticipant[];
  readonly matrixAssetsForView: readonly DeliverableAsset[];
  readonly fileFamilies: readonly FileFamilyProjection[];
  readonly activeFileFamily?: FileFamilyProjection;
  readonly selectedAsset?: DeliverableAsset;
  readonly selectedAssetId: string | null;
  readonly selectedAssetVersions: readonly DeliverableAsset[];
  readonly selectedAssetCurrentLabel: string | null;
  readonly filters: ContentRequestFilters;
  readonly selectedTaskIds: readonly string[];
  readonly selectedAssignmentId: string | null;
  readonly selectedAssignment?: DeliverableRow;
  readonly reminderPreviewRows: readonly DeliverableRow[];
  readonly reminderPreviewMode: "selected" | "all" | null;
  readonly loading: boolean;
  readonly loadingSessionHistories: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly statusMessage: string | null;
  readonly capabilityMessages: readonly string[];
  readonly operationStates: readonly DeliverablesOperationState[];
  readonly assetHistory: readonly DeliverableAssetHistoryEntry[];
  readonly comments: readonly DeliverableComment[];
  readonly loadingAssetDetails: boolean;
  readonly assetHistoryError: string | null;
  readonly commentsError: string | null;
  readonly speakerContentHistory?: Readonly<Record<string, DeliverableSpeakerContentHistoryState>>;
  readonly selectedSessionId?: string;
  readonly sessionHistory?: readonly DeliverableContentHistoryEntry[];
  readonly sessionHistoryError?: string | null;
  readonly onRetry?: () => void;
  readonly onCreateTask?: (input: DeliverableTaskInput) => Promise<void>;
  readonly onInspectAsset?: (assetId: string) => void;
  readonly onCloseAsset?: () => void;
  readonly onSelectSession?: (sessionId: string) => void;
  readonly onFilter: (status: ContentRequestStatusFilter) => void;
  readonly onToggleTask: (taskId: string) => void;
  readonly onSetVisibleSelection: (taskIds: readonly string[]) => void;
  readonly onOpenAssignment: (taskId: string) => void;
  readonly onFiltersChange: (filters: ContentRequestFilters) => void;
  readonly onPreviewSelectedReminders: () => void;
  readonly onPreviewAllReminders: () => void;
  readonly onReminderOpenChange: (open: boolean) => void;
  readonly onSendBulkReminder?: DeliverablesWorkspaceViewProps["onSendBulkReminder"];
  readonly onAssignmentOpenChange: (open: boolean) => void;
  readonly onAddComment?: DeliverablesWorkspaceViewProps["onAddComment"];
  readonly onDownloadVersion?: (assetId: string) => Promise<void>;
  readonly onExportFiles?: (
    input: DeliverableExportInput,
  ) => Promise<DeliverableExportDownload | undefined>;
  readonly onReviewAsset?: DeliverablesWorkspaceViewProps["onReviewAsset"];
  readonly onSaveSession?: DeliverablesWorkspaceViewProps["onSaveSession"];
  readonly onApproveSession?: DeliverablesWorkspaceViewProps["onApproveSession"];
  readonly onRestoreSessionVersion?: DeliverablesWorkspaceViewProps["onRestoreSessionVersion"];
  readonly onSaveBiography?: DeliverablesWorkspaceViewProps["onSaveBiography"];
  readonly onReplaceHeadshot?: DeliverablesWorkspaceViewProps["onReplaceHeadshot"];
  readonly onRestoreSpeakerContentVersion?: DeliverablesWorkspaceViewProps["onRestoreSpeakerContentVersion"];
}
function WorkspaceCanvas({
  eventId,
  organizationId,
  mode,
  filesMode,
  rows,
  sessions,
  tasks,
  profiles,
  participants,
  matrixAssetsForView,
  fileFamilies,
  activeFileFamily,
  selectedAsset,
  selectedAssetId,
  selectedAssetVersions,
  selectedAssetCurrentLabel,
  filters,
  selectedTaskIds,
  selectedAssignmentId,
  selectedAssignment,
  reminderPreviewRows,
  reminderPreviewMode,
  loading,
  loadingSessionHistories,
  busy,
  error,
  statusMessage,
  capabilityMessages,
  operationStates,
  assetHistory,
  comments,
  loadingAssetDetails,
  assetHistoryError,
  commentsError,
  speakerContentHistory,
  selectedSessionId,
  sessionHistory,
  sessionHistoryError,
  onRetry,
  onCreateTask,
  onInspectAsset,
  onCloseAsset,
  onSelectSession,
  onFilter,
  onToggleTask,
  onSetVisibleSelection,
  onOpenAssignment,
  onFiltersChange,
  onPreviewSelectedReminders,
  onPreviewAllReminders,
  onReminderOpenChange,
  onSendBulkReminder,
  onAssignmentOpenChange,
  onAddComment,
  onDownloadVersion,
  onExportFiles,
  onReviewAsset,
  onSaveSession,
  onApproveSession,
  onRestoreSessionVersion,
  onSaveBiography,
  onReplaceHeadshot,
  onRestoreSpeakerContentVersion,
}: Readonly<WorkspaceCanvasProps>) {
  return (
    <div className={pageClass} data-workspace-mode={mode}>
      <a href={filesMode ? "#files-content" : "#deliverables-content"} className={styles.skipLink}>
        Skip to {filesMode ? "Files library" : "Content requests"}
      </a>
      <div className={styles.content}>
        <WorkspaceHeader
          organizationId={organizationId}
          eventId={eventId}
          filesMode={filesMode}
          assignmentCount={rows.length}
          fileCount={fileFamilies.length}
        />
        <main
          id={filesMode ? "files-content" : "deliverables-content"}
          tabIndex={-1}
          className={styles.main}
        >
          <WorkspaceStatus
            filesMode={filesMode}
            loading={loading}
            error={error}
            statusMessage={statusMessage}
            capabilityMessages={capabilityMessages}
            operationStates={operationStates}
            {...(onRetry === undefined ? {} : { onRetry })}
          />
          {!filesMode ? (
            <RequestsSection
              viewOwnerKey={`${organizationId.trim()}\u0000${eventId.trim()}\u0000${mode}`}
              rows={rows}
              filters={filters}
              participants={participants}
              selectedTaskIds={selectedTaskIds}
              selectedAssignmentId={selectedAssignmentId}
              selectedAssignment={selectedAssignment}
              reminderPreviewRows={reminderPreviewRows}
              reminderPreviewMode={reminderPreviewMode}
              busy={busy}
              {...(onCreateTask === undefined ? {} : { onCreateTask })}
              onFilter={onFilter}
              onToggleTask={onToggleTask}
              onSetVisibleSelection={onSetVisibleSelection}
              onOpenAssignment={onOpenAssignment}
              onFiltersChange={onFiltersChange}
              onPreviewSelectedReminders={onPreviewSelectedReminders}
              onPreviewAllReminders={onPreviewAllReminders}
              onReminderOpenChange={onReminderOpenChange}
              {...(onSendBulkReminder === undefined ? {} : { onSendBulkReminder })}
              onAssignmentOpenChange={onAssignmentOpenChange}
              {...(onInspectAsset === undefined ? {} : { onInspectAsset })}
            />
          ) : (
            <FilesSection
              organizationId={organizationId}
              eventId={eventId}
              families={fileFamilies}
              activeFamily={activeFileFamily}
              sessions={sessions}
              tasks={tasks}
              profiles={profiles}
              busy={busy}
              loadFailed={error !== null}
              {...(onRetry === undefined ? {} : { onRetry })}
              {...(onInspectAsset === undefined ? {} : { onInspectAsset })}
              {...(onExportFiles === undefined ? {} : { onExportFiles })}
            />
          )}
          <FileReviewDrawer
            open={selectedAssetId !== null}
            family={activeFileFamily}
            asset={selectedAsset}
            sessions={sessions}
            tasks={tasks}
            profiles={profiles}
            history={assetHistory}
            comments={comments}
            loading={loadingAssetDetails}
            busy={busy}
            assetHistoryError={assetHistoryError}
            commentsError={commentsError}
            reviewAvailable={onReviewAsset !== undefined}
            onOpenChange={(open) => {
              if (!open) onCloseAsset?.();
            }}
            {...(onInspectAsset === undefined ? {} : { onSelectVersion: onInspectAsset })}
            {...(onDownloadVersion === undefined ? {} : { onDownload: onDownloadVersion })}
            {...(onAddComment === undefined || selectedAsset === undefined
              ? {}
              : {
                  onAddComment: (body: string, expectedVersion: number) =>
                    onAddComment({
                      assetId: selectedAsset.id,
                      body,
                      expectedVersion,
                    }),
                })}
            {...(onReviewAsset === undefined || selectedAsset === undefined
              ? {}
              : {
                  onReview: (
                    state: DeliverableReviewState,
                    note: string | undefined,
                    release: boolean,
                  ) =>
                    onReviewAsset({
                      assetId: selectedAsset.id,
                      state,
                      expectedVersion: selectedAsset.reviewVersion ?? 0,
                      release,
                      ...(note === undefined ? {} : { note }),
                    }),
                })}
          />
          {!filesMode ? (
            <>
              <SelectedAssetEvidence
                selectedAssetId={selectedAssetId}
                selectedAsset={selectedAsset}
                selectedAssetCurrentLabel={selectedAssetCurrentLabel}
                selectedAssetVersions={selectedAssetVersions}
                assetHistoryError={assetHistoryError}
                comments={comments}
              />
              <RelatedRecords
                organizationId={organizationId}
                eventId={eventId}
                sessions={sessions}
                profiles={profiles}
                assets={matrixAssetsForView}
                busy={busy}
                {...(speakerContentHistory === undefined ? {} : { speakerContentHistory })}
                {...(selectedSessionId === undefined ? {} : { selectedSessionId })}
                {...(sessionHistory === undefined ? {} : { sessionHistory })}
                {...(sessionHistoryError === undefined ? {} : { sessionHistoryError })}
                loadingSessionHistories={loadingSessionHistories}
                {...(onSelectSession === undefined ? {} : { onSelectSession })}
                {...(onSaveSession === undefined ? {} : { onSaveSession })}
                {...(onApproveSession === undefined ? {} : { onApproveSession })}
                {...(onRestoreSessionVersion === undefined ? {} : { onRestoreSessionVersion })}
                {...(onSaveBiography === undefined ? {} : { onSaveBiography })}
                {...(onReplaceHeadshot === undefined ? {} : { onReplaceHeadshot })}
                {...(onRestoreSpeakerContentVersion === undefined
                  ? {}
                  : { onRestoreSpeakerContentVersion })}
              />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

export function DeliverablesWorkspaceView({
  eventId,
  organizationId,
  mode = "deliverables",
  sessions,
  tasks,
  assets,
  profiles,
  speakerContentHistory,
  matrixItems,
  loading = false,
  busy = false,
  error = null,
  statusMessage = null,
  capabilityMessages = [],
  operationStates = [],
  selectedSessionId,
  sessionHistory,
  sessionHistoryError,
  onSelectSession,
  onCreateTask,
  onInspectAsset,
  onCloseAsset,
  selectedAssetId = null,
  assetHistory = EMPTY_ASSET_HISTORY,
  comments = EMPTY_COMMENTS,
  loadingAssetDetails = false,
  assetHistoryError,
  commentsError,
  loadingSessionHistories = false,
  onAddComment,
  onDownloadVersion,
  onExportFiles,
  onReviewAsset,
  onSendBulkReminder,
  onSaveSession,
  onApproveSession,
  onRestoreSessionVersion,
  onRestoreSpeakerContentVersion,
  onSaveBiography,
  onReplaceHeadshot,
  onRetry,
}: DeliverablesWorkspaceViewProps) {
  const filesMode = mode === "files";
  const matrixAssetsForView = useMemo(
    () =>
      filesMode || matrixItems === undefined
        ? [...assets, ...(matrixItems === undefined ? [] : matrixAssetsFromItems(matrixItems))]
        : matrixAssetsFromItems(matrixItems),
    [assets, filesMode, matrixItems],
  );
  const rows = useMemo(
    () =>
      matrixItems === undefined
        ? taskRows(tasks, sessions, assets, profiles)
        : matrixRows(matrixItems, sessions, profiles),
    [assets, matrixItems, profiles, sessions, tasks],
  );
  const participants = useMemo(
    () => subjectParticipants(profiles, rows, sessions),
    [profiles, rows, sessions],
  );
  const viewOwnerKey = `${organizationId.trim()}\u0000${eventId.trim()}\u0000${mode}`;
  const [viewOverrides, setViewOverrides] = useState<DeliverablesViewOverrides | null>(null);
  const owned = viewOverrides?.ownerKey === viewOwnerKey ? viewOverrides : undefined;
  const filters = owned?.filters ?? DEFAULT_CONTENT_REQUEST_FILTERS;
  const selectedTaskIds = owned?.selectedTaskIds ?? EMPTY_TASK_IDS;
  const selectedAssignmentId = owned?.selectedAssignmentId ?? null;
  const [reminderPreviewMode, setReminderPreviewMode] = useState<"selected" | "all" | null>(null);
  const updateViewOverrides = useCallback(
    (update: (current: DeliverablesViewOverrides) => DeliverablesViewOverrides) => {
      setViewOverrides((current) =>
        update(
          current?.ownerKey === viewOwnerKey
            ? current
            : initialDeliverablesViewOverrides(viewOwnerKey),
        ),
      );
    },
    [viewOwnerKey],
  );
  const validFilters = useMemo(
    () => ({
      ...filters,
      speakerId:
        filters.speakerId !== "all" &&
        rows.some((row) => row.task.participantId === filters.speakerId)
          ? filters.speakerId
          : "all",
      sessionId:
        filters.sessionId !== "all" &&
        rows.some(
          (row) =>
            (row.task.subject.type === "session" ? row.task.subject.sessionId : "participant") ===
            filters.sessionId,
        )
          ? filters.sessionId
          : "all",
      taskId:
        filters.taskId !== "all" && rows.some((row) => row.task.id === filters.taskId)
          ? filters.taskId
          : "all",
    }),
    [filters, rows],
  );
  const validSelectedTaskIds = useMemo(() => {
    const visible = new Set<string>();
    for (const row of filterContentRequestRows(rows, validFilters)) {
      if (isOutstanding(row.status)) visible.add(row.task.id);
    }
    return selectedTaskIds.filter((taskId) => visible.has(taskId));
  }, [rows, selectedTaskIds, validFilters]);
  const validSelectedAssignmentId =
    selectedAssignmentId !== null && rows.some((row) => row.task.id === selectedAssignmentId)
      ? selectedAssignmentId
      : null;
  const selectedAssignment =
    validSelectedAssignmentId === null
      ? undefined
      : rows.find((row) => row.task.id === validSelectedAssignmentId);
  const selectedTaskIdSet = useMemo(() => new Set(validSelectedTaskIds), [validSelectedTaskIds]);
  const reminderPreviewRows = rows.filter(
    (row) =>
      isOutstanding(row.status) &&
      (reminderPreviewMode === "all" || selectedTaskIdSet.has(row.task.id)),
  );
  const selectedAsset =
    selectedAssetId === null
      ? undefined
      : matrixAssetsForView.find((asset) => asset.id === selectedAssetId);
  const fileFamilies = useMemo(
    () => projectFileFamilies([...matrixAssetsForView, ...assetHistory], matrixItems ?? []),
    [assetHistory, matrixAssetsForView, matrixItems],
  );
  const activeFileFamily =
    selectedAsset === undefined
      ? undefined
      : fileFamilies.find((family) =>
          family.versions.some((version) => version.id === selectedAsset.id),
        );
  const authoritativeCurrentAsset = authoritativeCurrentAssetFor(selectedAsset, matrixItems);
  const selectedAssetVersions =
    selectedAsset === undefined
      ? []
      : matrixAssetsForView.filter(
          (candidate) => assetFamily(candidate) === assetFamily(selectedAsset),
        );
  const selectedAssetCurrentLabel =
    selectedAsset === undefined
      ? null
      : authoritativeCurrentAsset === undefined
        ? isCurrentAsset(selectedAsset, selectedAssetVersions)
          ? "Current"
          : "Previous"
        : authoritativeCurrentAsset.id === selectedAsset.id
          ? "Current"
          : "Not current";
  return (
    <WorkspaceCanvas
      eventId={eventId}
      organizationId={organizationId}
      mode={mode}
      filesMode={filesMode}
      rows={rows}
      sessions={sessions}
      tasks={tasks}
      profiles={profiles}
      participants={participants}
      matrixAssetsForView={matrixAssetsForView}
      fileFamilies={fileFamilies}
      {...(activeFileFamily === undefined ? {} : { activeFileFamily })}
      {...(selectedAsset === undefined ? {} : { selectedAsset })}
      selectedAssetId={selectedAssetId}
      selectedAssetVersions={selectedAssetVersions}
      selectedAssetCurrentLabel={selectedAssetCurrentLabel}
      filters={validFilters}
      selectedTaskIds={validSelectedTaskIds}
      selectedAssignmentId={validSelectedAssignmentId}
      {...(selectedAssignment === undefined ? {} : { selectedAssignment })}
      reminderPreviewRows={reminderPreviewRows}
      reminderPreviewMode={reminderPreviewMode}
      loading={loading}
      loadingSessionHistories={loadingSessionHistories}
      busy={busy}
      error={error}
      statusMessage={statusMessage}
      capabilityMessages={capabilityMessages}
      operationStates={operationStates}
      assetHistory={assetHistory}
      comments={comments}
      loadingAssetDetails={loadingAssetDetails}
      assetHistoryError={assetHistoryError ?? null}
      commentsError={commentsError ?? null}
      {...(speakerContentHistory === undefined ? {} : { speakerContentHistory })}
      {...(selectedSessionId === undefined ? {} : { selectedSessionId })}
      {...(sessionHistory === undefined ? {} : { sessionHistory })}
      {...(sessionHistoryError === undefined ? {} : { sessionHistoryError })}
      {...(onRetry === undefined ? {} : { onRetry })}
      {...(onCreateTask === undefined ? {} : { onCreateTask })}
      {...(onInspectAsset === undefined ? {} : { onInspectAsset })}
      {...(onCloseAsset === undefined ? {} : { onCloseAsset })}
      {...(onSelectSession === undefined ? {} : { onSelectSession })}
      onFilter={(status) =>
        updateViewOverrides((current) => ({ ...current, filters: { ...current.filters, status } }))
      }
      onToggleTask={(taskId) =>
        updateViewOverrides((current) => ({
          ...current,
          selectedTaskIds: current.selectedTaskIds.includes(taskId)
            ? current.selectedTaskIds.filter((candidate) => candidate !== taskId)
            : [...current.selectedTaskIds, taskId],
        }))
      }
      onSetVisibleSelection={(taskIds) =>
        updateViewOverrides((current) => ({ ...current, selectedTaskIds: [...taskIds] }))
      }
      onOpenAssignment={(taskId) =>
        updateViewOverrides((current) => ({ ...current, selectedAssignmentId: taskId }))
      }
      onFiltersChange={(nextFilters) =>
        updateViewOverrides((current) => ({ ...current, filters: nextFilters }))
      }
      onPreviewSelectedReminders={() => setReminderPreviewMode("selected")}
      onPreviewAllReminders={() => setReminderPreviewMode("all")}
      onReminderOpenChange={(open) => {
        if (!open) setReminderPreviewMode(null);
      }}
      {...(onSendBulkReminder === undefined ? {} : { onSendBulkReminder })}
      onAssignmentOpenChange={(open) => {
        if (!open) updateViewOverrides((current) => ({ ...current, selectedAssignmentId: null }));
      }}
      {...(onAddComment === undefined ? {} : { onAddComment })}
      {...(onDownloadVersion === undefined ? {} : { onDownloadVersion })}
      {...(onExportFiles === undefined ? {} : { onExportFiles })}
      {...(onReviewAsset === undefined ? {} : { onReviewAsset })}
      {...(onSaveSession === undefined ? {} : { onSaveSession })}
      {...(onApproveSession === undefined ? {} : { onApproveSession })}
      {...(onRestoreSessionVersion === undefined ? {} : { onRestoreSessionVersion })}
      {...(onSaveBiography === undefined ? {} : { onSaveBiography })}
      {...(onReplaceHeadshot === undefined ? {} : { onReplaceHeadshot })}
      {...(onRestoreSpeakerContentVersion === undefined ? {} : { onRestoreSpeakerContentVersion })}
    />
  );
}
