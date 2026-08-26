"use client";

import { FileText, ListTodo, Mail, UserPlus, Users } from "lucide-react";
import type { FormEvent, RefObject } from "react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import type {
  SpeakerAsset,
  SpeakerEmailPreview,
  SpeakerEmailSend,
  SpeakerEmailTemplate,
  SpeakerImportPreview,
  SpeakerInvitationPreview,
  SpeakerInvitationResult,
  SpeakerMutationStatus,
  SpeakerProgressEnvelope,
  SpeakerRecord,
  SpeakerReminderEligibilityEnvelope,
  SpeakerRosterEnvelope,
  SpeakerSession,
  SpeakerTask,
  SpeakerTaskReminderOffsetsResult,
} from "./api";
import type { DuplicateEmailConflict } from "./speaker-data-logic";
import type { SpeakerAttentionFilter } from "./speaker-roster-logic";
import styles from "./speaker-workspace.module.css";
import {
  SpeakerDetailSection,
  SpeakerEmailSection,
  SpeakerImportSection,
  SpeakerProgressSection,
  SpeakerReminderSection,
  SpeakerRosterSection,
  SpeakerTaskAssignmentSection,
} from "./speaker-workspace-sections";
import type {
  CreateDraft,
  EditDraft,
  ProgressFilter,
  SpeakerInvitationHistoryEntry,
  SpeakerOnboardingTaskDefinition,
} from "./speaker-workspace-types";

function SpeakerRosterView({
  rosterEmpty,
  attentionFilter,
  attentionCounts,
  onAttentionFilterChange,
  scopedRoster,
  loading,
  speakers,
  filteredSpeakers,
  selectedId,
  selectedSpeakerIdSet,
  duplicateEmailWarnings,
  statusOptions,
  sessionOptions,
  query,
  filtersOpen,
  statusFilter,
  sessionFilter,
  progressFilter,
  hasActiveRosterFilters,
  hasAnyFilters,
  selectedSpeakerIds,
  allVisibleSelected,
  selectedSpeaker,
  detailTriggerRef,
  onCloseDetail,
  detailProps,
  showCsv,
  importProps,
  onQueryChange,
  onToggleFilters,
  onStatusFilterChange,
  onSessionFilterChange,
  onProgressFilterChange,
  onClearFilters,
  onOpenSelectedEmail,
  onToggleVisibleSelection,
  onClearSelection,
  onToggleSelection,
  onBeginEdit,
  onAddSpeaker,
  onImportCsv,
}: Readonly<{
  rosterEmpty: boolean;
  attentionFilter: SpeakerAttentionFilter;
  attentionCounts: Readonly<Record<SpeakerAttentionFilter, number>>;
  onAttentionFilterChange: (attention: SpeakerAttentionFilter) => void;
  scopedRoster: SpeakerRosterEnvelope | null;
  loading: boolean;
  speakers: readonly SpeakerRecord[];
  filteredSpeakers: readonly SpeakerRecord[];
  selectedId: string | null;
  selectedSpeakerIdSet: ReadonlySet<string>;
  duplicateEmailWarnings: readonly DuplicateEmailConflict[];
  statusOptions: readonly string[];
  sessionOptions: readonly (readonly [string, string])[];
  query: string;
  filtersOpen: boolean;
  statusFilter: string;
  sessionFilter: string;
  progressFilter: ProgressFilter;
  hasActiveRosterFilters: boolean;
  hasAnyFilters: boolean;
  selectedSpeakerIds: readonly string[];
  allVisibleSelected: boolean;
  selectedSpeaker: SpeakerRecord | null;
  detailTriggerRef: RefObject<HTMLButtonElement | null>;
  onCloseDetail: () => void;
  detailProps: Readonly<{
    organizationId: string;
    eventId: string;
    apiAvailable: boolean;
    detailBusy: boolean;
    onRefreshDetails: () => void;
    invitation: Readonly<{
      previewBusy: boolean;
      sendBusy: boolean;
      canSend: boolean;
      selectedPreview: readonly SpeakerInvitationPreview[];
      result: SpeakerInvitationResult | null;
      resultParticipantId: string | null;
      selectedResultRecipient: SpeakerInvitationResult["recipients"][number] | null;
      error: string | null;
      history: readonly SpeakerInvitationHistoryEntry[];
      onPreview: () => void;
      onSend: () => void;
    }>;
    headshot: Readonly<{
      asset: SpeakerAsset | null;
      imageUrl: string | null;
      loading: boolean;
      error: string | null;
      revision: number;
      eligibleSessions: readonly SpeakerSession[];
      selectedSessionId: string | null;
      uploadStatus: string;
      uploadMessage: string | null;
      replacementAvailable: boolean;
      onRetry: () => void;
      onImageError: () => void;
      onSessionChange: (sessionId: string) => void;
      onUpload: (file: File) => void;
      mutationStatus: SpeakerMutationStatus;
      mutationMessage: string | null;
    }>;
    editDraft: EditDraft | null;
    statusOptions: readonly string[];
    profileMutationStatus: SpeakerMutationStatus;
    profileMutationMessage: string | null;
    detailNotice: string | null;
    editError: string | null;
    saveBusy: boolean;
    downloadErrors: Readonly<Record<string, string>>;
    downloadBusyAssetId: string | null;
    onEditDraftChange: (field: keyof CreateDraft, value: string | boolean) => void;
    onSave: (event: FormEvent<HTMLFormElement>) => void;
    onBeginEdit: (speaker: SpeakerRecord) => void;
    onAssetDownload: (asset: SpeakerAsset) => Promise<string | null>;
  }>;
  showCsv: boolean;
  importProps: Readonly<{
    busy: boolean;
    previewBusy: boolean;
    commitBusy: boolean;
    apiAvailable: boolean;
    fileName: string | null;
    preview: SpeakerImportPreview | null;
    onOpenChange: (open: boolean) => void;
    onPreview: (file: File) => void;
    onCommit: () => void;
  }>;
  onQueryChange: (query: string) => void;
  onToggleFilters: () => void;
  onStatusFilterChange: (status: string) => void;
  onSessionFilterChange: (session: string) => void;
  onProgressFilterChange: (progress: ProgressFilter) => void;
  onClearFilters: () => void;
  onOpenSelectedEmail: () => void;
  onToggleVisibleSelection: () => void;
  onClearSelection: () => void;
  onToggleSelection: (participantId: string) => void;
  onBeginEdit: (speaker: SpeakerRecord) => void;
  onAddSpeaker: () => void;
  onImportCsv: () => void;
}>) {
  const detail = selectedSpeaker ? (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onCloseDetail();
      }}
    >
      <SheetContent
        side="right"
        className={styles.detailSheet}
        overlayClassName="bg-foreground/10 backdrop-blur-none supports-[backdrop-filter]:backdrop-blur-none"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          detailTriggerRef.current?.focus();
        }}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{selectedSpeaker.displayName}</SheetTitle>
          <SheetDescription>
            Edit this speaker&apos;s profile, logistics, assignments, tasks, invitations, and files.
          </SheetDescription>
        </SheetHeader>
        <SpeakerDetailSection selectedSpeaker={selectedSpeaker} {...detailProps} />
      </SheetContent>
    </Sheet>
  ) : null;

  return (
    <>
      {rosterEmpty ? (
        <Card className={styles.firstRunCard}>
          <CardHeader>
            <CardTitle id="roster-empty-heading">Start your speaker roster</CardTitle>
            <CardDescription>
              Add speakers one at a time or import a CSV to give this event a clear home for
              profiles, sessions, and delivery details.
            </CardDescription>
          </CardHeader>
          <CardContent className={styles.actionsStack}>
            <Empty className={styles.empty}>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Users />
                </EmptyMedia>
                <EmptyTitle>No speakers added yet</EmptyTitle>
                <EmptyDescription>
                  Start with a speaker profile or bring in your existing roster. You can invite
                  speakers to their portal and assign onboarding after people are here.
                </EmptyDescription>
              </EmptyHeader>
              <div className={styles.actions}>
                <Button variant="default" type="button" onClick={onAddSpeaker}>
                  <UserPlus data-icon="inline-start" />
                  Add speaker
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  onClick={onImportCsv}
                  aria-expanded={showCsv}
                  aria-controls="speaker-csv-import"
                >
                  <FileText data-icon="inline-start" />
                  {showCsv ? "Hide CSV import" : "Import CSV"}
                </Button>
              </div>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        <SpeakerRosterSection
          scopedRoster={scopedRoster}
          loading={loading}
          speakers={speakers}
          filteredSpeakers={filteredSpeakers}
          selectedId={selectedId}
          selectedSpeakerIdSet={selectedSpeakerIdSet}
          duplicateEmailWarnings={duplicateEmailWarnings}
          statusOptions={statusOptions}
          sessionOptions={sessionOptions}
          query={query}
          filtersOpen={filtersOpen}
          statusFilter={statusFilter}
          sessionFilter={sessionFilter}
          progressFilter={progressFilter}
          attentionFilter={attentionFilter}
          attentionCounts={attentionCounts}
          hasActiveRosterFilters={hasActiveRosterFilters}
          hasAnyFilters={hasAnyFilters}
          selectedSpeakerIds={selectedSpeakerIds}
          allVisibleSelected={allVisibleSelected}
          detail={detail}
          onQueryChange={onQueryChange}
          onToggleFilters={onToggleFilters}
          onStatusFilterChange={onStatusFilterChange}
          onSessionFilterChange={onSessionFilterChange}
          onProgressFilterChange={onProgressFilterChange}
          onAttentionFilterChange={onAttentionFilterChange}
          onClearFilters={onClearFilters}
          onOpenSelectedEmail={onOpenSelectedEmail}
          onToggleVisibleSelection={onToggleVisibleSelection}
          onClearSelection={onClearSelection}
          onToggleSelection={onToggleSelection}
          onBeginEdit={onBeginEdit}
          detailTriggerRef={detailTriggerRef}
        />
      )}
      <SpeakerImportSection open={showCsv} showTrigger={!rosterEmpty} {...importProps} />
    </>
  );
}

function SpeakerTasksView({
  rosterEmpty,
  taskProps,
  progressProps,
  reminderProps,
  reminderSectionRef,
}: Readonly<{
  rosterEmpty: boolean;
  taskProps: Readonly<{
    apiAvailable: boolean;
    speakers: readonly SpeakerRecord[];
    taskTitle: string;
    taskDueAt: string;
    taskAssigneeIdSet: ReadonlySet<string>;
    taskBusy: boolean;
    loading: boolean;
    rosterLoaded: boolean;
    progress: SpeakerProgressEnvelope | null;
    progressError: string | null;
    progressSectionVisible: boolean;
    taskDefinitions: readonly SpeakerOnboardingTaskDefinition[];
    onLoadProgress: () => void;
    onTaskTitleChange: (title: string) => void;
    onTaskDueChange: (dueAt: string) => void;
    onToggleAssignee: (participantId: string) => void;
    onAssign: (event: FormEvent<HTMLFormElement>) => void;
    onAddSpeaker: () => void;
    onImportCsv: () => void;
  }>;
  progressProps: Readonly<{
    progress: SpeakerProgressEnvelope | null;
    progressError: string | null;
    progressRows: readonly SpeakerProgressEnvelope["rows"][number][];
    progressFilter: ProgressFilter;
    onProgressFilterChange: (progress: ProgressFilter) => void;
  }>;
  reminderProps: Readonly<{
    reminderEligibility: SpeakerReminderEligibilityEnvelope | null;
    eligibleItems: readonly SpeakerReminderEligibilityEnvelope["items"][number][];
    ineligibleItems: readonly SpeakerReminderEligibilityEnvelope["items"][number][];
    tasks: readonly SpeakerTask[];
    onSaveOffsets: (
      taskId: string,
      expectedVersion: number,
      reminderOffsetsMinutes: readonly number[],
    ) => Promise<SpeakerTaskReminderOffsetsResult>;
  }>;
  reminderSectionRef: RefObject<HTMLDivElement | null>;
}>) {
  return (
    <>
      <SpeakerTaskAssignmentSection rosterEmpty={rosterEmpty} {...taskProps} />
      {!rosterEmpty ? (
        <>
          <SpeakerProgressSection {...progressProps} />
          <div ref={reminderSectionRef}>
            <SpeakerReminderSection {...reminderProps} />
          </div>
        </>
      ) : null}
    </>
  );
}

function SpeakerEmailView({
  rosterEmpty,
  selectedSpeakerIds,
  onAddSpeaker,
  onImportCsv,
  onChooseRecipients,
  emailProps,
  emailSectionRef,
}: Readonly<{
  rosterEmpty: boolean;
  selectedSpeakerIds: readonly string[];
  onAddSpeaker: () => void;
  onImportCsv: () => void;
  onChooseRecipients: () => void;
  emailProps: Readonly<{
    templates: readonly SpeakerEmailTemplate[];
    templateId: string;
    templateVersion: number | undefined;
    apiAvailable: boolean;
    templateName: string;
    subject: string;
    html: string;
    text: string;
    editorMode: "visual" | "html" | "text";
    preview: SpeakerEmailPreview | null;
    previewCurrent: boolean;
    sends: readonly SpeakerEmailSend[];
    notice: string | null;
    confirmOpen: boolean;
    saveBusy: boolean;
    previewBusy: boolean;
    sendBusy: boolean;
    historyBusy: boolean;
    onTemplateChange: (value: string) => void;
    onUseStarter: () => void;
    onTemplateNameChange: (name: string) => void;
    onSubjectChange: (subject: string) => void;
    onHtmlChange: (html: string) => void;
    onTextChange: (text: string) => void;
    onEditorModeChange: (mode: "visual" | "html" | "text") => void;
    onSave: () => void;
    onPreview: () => void;
    onConfirmOpenChange: (open: boolean) => void;
    onSend: () => void;
    onRefreshHistory: () => void;
  }>;
  emailSectionRef: RefObject<HTMLDivElement | null>;
}>) {
  return (
    <div ref={emailSectionRef}>
      {rosterEmpty ? (
        <Empty className={styles.empty}>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Mail />
            </EmptyMedia>
            <EmptyTitle>Add speakers before emailing</EmptyTitle>
            <EmptyDescription>
              Add or import speakers before sending speaker-only outreach for this event.
            </EmptyDescription>
          </EmptyHeader>
          <div className={styles.actions}>
            <Button variant="default" type="button" onClick={onAddSpeaker}>
              <UserPlus data-icon="inline-start" />
              Add speaker
            </Button>
            <Button variant="outline" type="button" onClick={onImportCsv}>
              <FileText data-icon="inline-start" />
              Import CSV
            </Button>
          </div>
        </Empty>
      ) : selectedSpeakerIds.length === 0 ? (
        <Empty className={styles.empty}>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users />
            </EmptyMedia>
            <EmptyTitle>Choose recipients</EmptyTitle>
            <EmptyDescription>
              Select speakers in Roster before composing speaker-only outreach. Broader
              announcements belong in Communications.
            </EmptyDescription>
          </EmptyHeader>
          <Button variant="default" type="button" onClick={onChooseRecipients}>
            <Users data-icon="inline-start" />
            Choose recipients
          </Button>
        </Empty>
      ) : (
        <SpeakerEmailSection selectedCount={selectedSpeakerIds.length} {...emailProps} />
      )}
    </div>
  );
}

export function SpeakerWorkspaceViews({
  activeView,
  onViewChange,
  roster,
  tasks,
  email,
}: Readonly<{
  activeView: "roster" | "tasks" | "email";
  onViewChange: (view: "roster" | "tasks" | "email") => void;
  roster: Parameters<typeof SpeakerRosterView>[0];
  tasks: Parameters<typeof SpeakerTasksView>[0];
  email: Parameters<typeof SpeakerEmailView>[0];
}>) {
  return (
    <Tabs
      value={activeView}
      onValueChange={(value) => onViewChange(value as "roster" | "tasks" | "email")}
      className={styles.tabs}
    >
      <TabsList variant="line" aria-label="Speaker workspace views">
        <TabsTrigger id="roster-tab" aria-controls="roster-view" value="roster">
          <Users data-icon="inline-start" />
          Roster
        </TabsTrigger>
        <TabsTrigger id="tasks-tab" aria-controls="tasks-view" value="tasks">
          <ListTodo data-icon="inline-start" />
          Onboarding
        </TabsTrigger>
        <TabsTrigger id="email-tab" aria-controls="email-view" value="email">
          <Mail data-icon="inline-start" />
          Email
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="roster"
        id="roster-view"
        aria-labelledby="roster-tab"
        className={styles.view}
      >
        <SpeakerRosterView {...roster} />
      </TabsContent>
      <TabsContent
        value="tasks"
        id="tasks-view"
        aria-labelledby="tasks-tab"
        className={styles.view}
      >
        <SpeakerTasksView {...tasks} />
      </TabsContent>
      <TabsContent
        value="email"
        id="email-view"
        aria-labelledby="email-tab"
        className={styles.view}
      >
        <SpeakerEmailView {...email} />
      </TabsContent>
    </Tabs>
  );
}
