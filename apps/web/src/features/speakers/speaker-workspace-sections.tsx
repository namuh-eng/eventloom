"use client";

import {
  CheckCircle2,
  Eye,
  FileText,
  ListFilter,
  ListTodo,
  Mail,
  RefreshCw,
  Search,
  Send,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, type ReactNode, type RefObject, useState } from "react";
import { StatusBadge, WorkspaceListDetail } from "@/components/workspace";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../components/ui/field";
import { FileUpload } from "../../components/ui/file-upload";
import { Input } from "../../components/ui/input";
import { Progress } from "../../components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { TemporalPicker } from "../../components/ui/temporal-picker";
import { Textarea } from "../../components/ui/textarea";
import adminStyles from "../admin/admin-shell.module.css";
import {
  ORGANIZER_HEADSHOT_ACCEPTED_TYPES,
  type SpeakerAsset,
  type SpeakerEmailPreview,
  type SpeakerEmailSend,
  type SpeakerEmailTemplate,
  type SpeakerInvitationPreview,
  type SpeakerInvitationResult,
  type SpeakerMutationStatus,
  type SpeakerProgressEnvelope,
  type SpeakerRecord,
  type SpeakerReminderEligibilityEnvelope,
  type SpeakerRosterEnvelope,
  type SpeakerSession,
  type SpeakerTask,
  type SpeakerTaskReminderOffsetsResult,
} from "./api";
import {
  SpeakerAssetDownload,
  SpeakerAssetMetadata,
  SpeakerHeadshot,
  SpeakerStatusBadge,
} from "./speaker-assets";
import type { DuplicateEmailConflict } from "./speaker-data-logic";
import {
  FormMessage,
  MutationStatusMessage,
  SpeakerInvitationControls,
} from "./speaker-invitations";
import {
  dateLabel,
  dateTimeLabel,
  type SpeakerAttentionFilter,
  statusLabel,
  taskComplete,
} from "./speaker-roster-logic";
import { speakerTaskAssigneeLabels, taskStatusLabel, taskStatusTone } from "./speaker-task-model";
import {
  deadlineAfterEventWarning,
  deadlineTemporalPolicy,
  type SpeakerEventTemporalContext,
  travelDateWarnings,
} from "./speaker-temporal-policy";
import styles from "./speaker-workspace.module.css";
import type {
  CreateDraft,
  EditDraft,
  ProgressFilter,
  SpeakerInvitationHistoryEntry,
} from "./speaker-workspace-types";
import {
  SPEAKER_CUSTOM_FIELDS_CONTRACT_GAP,
  SPEAKER_ROSTER_COLUMNS,
  type SpeakerOnboardingTaskDefinition,
} from "./speaker-workspace-types";

function SpeakerTaskStatusBadge({ status }: Readonly<{ status: string }>) {
  return <StatusBadge tone={taskStatusTone(status)}>{taskStatusLabel(status)}</StatusBadge>;
}

function ProfileFields({
  draft,
  onChange,
  disabled,
  temporalContext,
}: Readonly<{
  draft: CreateDraft | EditDraft;
  onChange: (field: keyof CreateDraft, value: string | boolean) => void;
  disabled: boolean;
  temporalContext?: SpeakerEventTemporalContext;
}>) {
  const travelWarnings =
    temporalContext === undefined
      ? []
      : travelDateWarnings(draft.arrivalAt, draft.departureAt, temporalContext);
  return (
    <FieldGroup className={styles.actionsStack}>
      <div className={styles.fieldGrid}>
        <Field>
          <FieldLabel htmlFor="speaker-display-name">Name</FieldLabel>
          <Input
            id="speaker-display-name"
            value={draft.displayName}
            onChange={(event) => onChange("displayName", event.target.value)}
            required
            maxLength={200}
            disabled={disabled}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="speaker-email">Email</FieldLabel>
          <Input
            id="speaker-email"
            type="email"
            value={draft.email}
            onChange={(event) => onChange("email", event.target.value)}
            required
            maxLength={320}
            disabled={disabled}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="speaker-title">Title</FieldLabel>
          <Input
            id="speaker-title"
            value={draft.title}
            onChange={(event) => onChange("title", event.target.value)}
            placeholder="Principal Engineer"
            maxLength={160}
            disabled={disabled}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="speaker-company">Company</FieldLabel>
          <Input
            id="speaker-company"
            value={draft.company}
            onChange={(event) => onChange("company", event.target.value)}
            placeholder="Organization"
            maxLength={200}
            disabled={disabled}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="speaker-biography">Biography</FieldLabel>
        <Textarea
          id="speaker-biography"
          value={draft.biography}
          onChange={(event) => onChange("biography", event.target.value)}
          maxLength={20_000}
          disabled={disabled}
        />
      </Field>
      <div className={styles.fieldGrid}>
        <Field>
          <FieldLabel htmlFor="speaker-twitter">Twitter / X</FieldLabel>
          <Input
            id="speaker-twitter"
            value={draft.twitter}
            onChange={(event) => onChange("twitter", event.target.value)}
            placeholder="https://x.com/…"
            maxLength={500}
            disabled={disabled}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="speaker-linkedin">LinkedIn</FieldLabel>
          <Input
            id="speaker-linkedin"
            value={draft.linkedin}
            onChange={(event) => onChange("linkedin", event.target.value)}
            placeholder="https://linkedin.com/in/…"
            maxLength={500}
            disabled={disabled}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="speaker-website">Website</FieldLabel>
          <Input
            id="speaker-website"
            value={draft.website}
            onChange={(event) => onChange("website", event.target.value)}
            placeholder="https://…"
            maxLength={500}
            disabled={disabled}
          />
        </Field>
      </div>
      <FieldSet className={styles.detailBlock}>
        <FieldLegend variant="label">Travel and logistics</FieldLegend>
        <Field orientation="horizontal" className={styles.checkboxField}>
          <Checkbox
            id="speaker-travel-required"
            checked={draft.travelRequired}
            onCheckedChange={(checked) => onChange("travelRequired", checked === true)}
            disabled={disabled}
          />
          <FieldLabel htmlFor="speaker-travel-required">
            Speaker requires travel coordination
          </FieldLabel>
        </Field>
        <div className={styles.fieldGrid}>
          <Field style={{ gridColumn: "1 / -1" }}>
            <TemporalPicker
              id="speaker-travel-window"
              mode="range"
              precision="date"
              startValue={draft.arrivalAt}
              endValue={draft.departureAt}
              startLabel="Arrival date"
              endLabel="Departure date"
              eyebrow="Travel window"
              description="Choose the speaker's arrival and departure dates."
              clearable
              disabled={disabled}
              onChange={({ start, end }) => {
                onChange("arrivalAt", start);
                onChange("departureAt", end);
              }}
            />
            {travelWarnings.map((warning) => (
              <p key={warning} className={styles.muted} role="status">
                {warning}
              </p>
            ))}
          </Field>
          <Field>
            <FieldLabel htmlFor="speaker-accommodation">Accommodation</FieldLabel>
            <Input
              id="speaker-accommodation"
              value={draft.accommodation}
              onChange={(event) => onChange("accommodation", event.target.value)}
              maxLength={500}
              disabled={disabled}
            />
          </Field>
        </div>
        <div className={styles.fieldGrid}>
          <Field>
            <FieldLabel htmlFor="speaker-dietary">Dietary requirements</FieldLabel>
            <Input
              id="speaker-dietary"
              value={draft.dietaryRequirements}
              onChange={(event) => onChange("dietaryRequirements", event.target.value)}
              maxLength={2_000}
              disabled={disabled}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="speaker-accessibility">Accessibility needs</FieldLabel>
            <Input
              id="speaker-accessibility"
              value={draft.accessibilityNeeds}
              onChange={(event) => onChange("accessibilityNeeds", event.target.value)}
              maxLength={2_000}
              disabled={disabled}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="speaker-travel-notes">Travel notes</FieldLabel>
          <Textarea
            id="speaker-travel-notes"
            value={draft.travelNotes}
            onChange={(event) => onChange("travelNotes", event.target.value)}
            maxLength={5_000}
            disabled={disabled}
          />
        </Field>
      </FieldSet>
    </FieldGroup>
  );
}

function SpeakerAddDialog({
  open,
  draft,
  statusOptions,
  saveBusy,
  apiAvailable,
  temporalContext,
  onOpenChange,
  onSubmit,
  onChange,
}: Readonly<{
  open: boolean;
  draft: CreateDraft;
  statusOptions: readonly string[];
  saveBusy: boolean;
  apiAvailable: boolean;
  temporalContext?: SpeakerEventTemporalContext;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChange: (field: keyof CreateDraft, value: string | boolean) => void;
}>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialogContent}>
        <DialogHeader>
          <DialogTitle>Add speaker</DialogTitle>
          <DialogDescription>
            Capture identity and profile details before sending an optional portal invitation.
          </DialogDescription>
        </DialogHeader>
        <form className={styles.actionsStack} onSubmit={onSubmit}>
          <ProfileFields
            draft={draft}
            onChange={onChange}
            disabled={saveBusy}
            {...(temporalContext === undefined ? {} : { temporalContext })}
          />
          <Field>
            <FieldLabel htmlFor="create-speaker-status">Workflow status</FieldLabel>
            <Select
              value={draft.status}
              onValueChange={(value) => onChange("status", value)}
              disabled={saveBusy}
            >
              <SelectTrigger id="create-speaker-status" className={styles.control}>
                <SelectValue placeholder="Select workflow status" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {statusOptions.map((status) => (
                    <SelectItem key={status} value={status}>
                      {statusLabel(status)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Button variant="default" type="submit" disabled={saveBusy || !apiAvailable}>
            <CheckCircle2 data-icon="inline-start" />
            {saveBusy ? "Saving…" : "Save speaker"}
          </Button>
          <p className={styles.muted} role="note">
            Headshot upload is completed by the speaker in their portal.{" "}
            {SPEAKER_CUSTOM_FIELDS_CONTRACT_GAP}
          </p>
        </form>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SpeakerInvitationSection({
  canSend,
  selectedPreview,
  result,
  resultParticipantId,
  selectedResultRecipient,
  error,
  history,
}: Readonly<{
  canSend: boolean;
  selectedPreview: readonly SpeakerInvitationPreview[];
  result: SpeakerInvitationResult | null;
  resultParticipantId: string | null;
  selectedResultRecipient: SpeakerInvitationResult["recipients"][number] | null;
  error: string | null;
  history: readonly SpeakerInvitationHistoryEntry[];
}>) {
  return (
    <>
      {selectedPreview.length > 0 ? (
        <Alert>
          <Mail />
          <AlertTitle>Invitation preview ready</AlertTitle>
          <AlertDescription>
            {selectedPreview.length} speaker previewed.{" "}
            {canSend ? "Eligible to send." : "Sending is blocked."} Sending remains a separate
            explicit action.
            <ul className={styles.list} aria-label="Portal invitation preview">
              {selectedPreview.map((preview) => (
                <li key={preview.participantId}>
                  <strong>{statusLabel(preview.state)}</strong> ·{" "}
                  {preview.recipientEmail || "No deliverable email"}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {result && selectedResultRecipient && resultParticipantId ? (
        <FormMessage
          message={`Invitation ${selectedResultRecipient.status} for ${selectedResultRecipient.recipientEmail}.`}
          error={selectedResultRecipient.status === "failed"}
        />
      ) : null}
      {error ? <FormMessage message={error} error /> : null}
      {history.length > 0 ? (
        <div className={styles.detailBlock}>
          <h3 className={styles.subheading}>Portal invitation send history</h3>
          <ul className={styles.list} aria-label="Portal invitation send history">
            {history.map((entry) => (
              <li key={`${entry.result.idempotencyKey}:${entry.occurredAt}`}>
                <strong>{statusLabel(entry.result.status)}</strong> ·{" "}
                {entry.preview
                  .map((preview) => preview.recipientEmail || preview.participantId)
                  .join(", ")}{" "}
                · {dateTimeLabel(entry.occurredAt)} UTC
              </li>
            ))}
          </ul>
          <p className={styles.muted}>
            Sent invitations persist in the durable server email history; use Refresh history in the
            Email view to reload the authoritative record.
          </p>
        </div>
      ) : null}
    </>
  );
}

function SpeakerHeadshotSection({
  speakerName,
  asset,
  imageUrl,
  loading,
  error,
  revision,
  eligibleSessions,
  selectedSessionId,
  uploadStatus,
  uploadMessage,
  apiAvailable,
  replacementAvailable,
  onRetry,
  onImageError,
  onSessionChange,
  onUpload,
  mutationStatus,
  mutationMessage,
}: Readonly<{
  speakerName: string;
  asset: SpeakerAsset | null;
  imageUrl: string | null;
  loading: boolean;
  error: string | null;
  revision: number;
  eligibleSessions: readonly SpeakerSession[];
  selectedSessionId: string | null;
  uploadStatus: string;
  uploadMessage: string | null;
  apiAvailable: boolean;
  replacementAvailable: boolean;
  onRetry: () => void;
  onImageError: () => void;
  onSessionChange: (sessionId: string) => void;
  onUpload: (file: File) => void;
  mutationStatus: SpeakerMutationStatus;
  mutationMessage: string | null;
}>) {
  return (
    <Card className={styles.uploadPanel}>
      <CardHeader>
        <CardTitle className={styles.subheading}>Headshot</CardTitle>
        <CardDescription>Secure event-scoped preview and organizer replacement.</CardDescription>
      </CardHeader>
      <CardContent className={styles.actionsStack}>
        <SpeakerHeadshot
          speakerName={speakerName}
          asset={asset}
          imageUrl={imageUrl}
          loading={loading}
          error={error}
          revision={revision}
          onRetry={onRetry}
          onImageError={onImageError}
        />
        {eligibleSessions.length > 1 ? (
          <Field>
            <FieldLabel htmlFor="speaker-headshot-session">
              Session for headshot replacement
            </FieldLabel>
            <Select value={selectedSessionId ?? ""} onValueChange={onSessionChange}>
              <SelectTrigger id="speaker-headshot-session">
                <SelectValue placeholder="Choose an accepted session" />
              </SelectTrigger>
              <SelectContent>
                {eligibleSessions.map((session) => (
                  <SelectItem key={session.sessionId} value={session.sessionId}>
                    {session.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : eligibleSessions.length === 0 ? (
          <p className={styles.muted} role="status">
            Headshot replacement requires an accepted session owned by this speaker.
          </p>
        ) : null}
        <Field>
          <FieldLabel htmlFor="speaker-headshot-upload">Upload or replace headshot</FieldLabel>
          <FileUpload
            id="speaker-headshot-upload"
            ariaLabel="Upload or replace headshot"
            accept={ORGANIZER_HEADSHOT_ACCEPTED_TYPES.join(",")}
            disabled={
              uploadStatus === "busy" ||
              !apiAvailable ||
              !replacementAvailable ||
              selectedSessionId === null
            }
            title="Drop a headshot here or browse"
            hint="JPEG, PNG, or WebP; maximum 5 MB. Uploads use the event-scoped organizer private upload flow."
            onFilesSelected={(files) => {
              const file = files[0];
              if (file) onUpload(file);
            }}
          />
        </Field>
        <p className={styles.muted}>
          Accepted headshot types: JPEG, PNG, or WebP; maximum size 5 MB. Uploads use the
          event-scoped organizer private upload flow.
        </p>
        {uploadMessage ? (
          <FormMessage message={uploadMessage} error={uploadStatus === "error"} />
        ) : null}
        <MutationStatusMessage label="Headshot" status={mutationStatus} message={mutationMessage} />
      </CardContent>
    </Card>
  );
}

function SpeakerDetailSection({
  selectedSpeaker,
  organizationId,
  eventId,
  apiAvailable,
  detailBusy,
  onRefreshDetails,
  invitation,
  headshot,
  temporalContext,
  editDraft,
  statusOptions,
  profileMutationStatus,
  profileMutationMessage,
  editError,
  detailNotice,
  saveBusy,
  downloadErrors,
  downloadBusyAssetId,
  onEditDraftChange,
  onSave,
  onBeginEdit,
  onAssetDownload,
}: Readonly<{
  selectedSpeaker: SpeakerRecord;
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
  temporalContext?: SpeakerEventTemporalContext;
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
}>) {
  return (
    <Card className={styles.detail} aria-labelledby="speaker-detail-heading">
      <CardHeader className={styles.detailHeader}>
        <div>
          <p className={styles.eyebrow}>Speaker record</p>
          <CardTitle id="speaker-detail-heading">{selectedSpeaker.displayName}</CardTitle>
          <CardDescription>
            {selectedSpeaker.email} <SpeakerStatusBadge status={selectedSpeaker.status} />
          </CardDescription>
        </div>
        <div className={styles.actions}>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={onRefreshDetails}
            disabled={detailBusy || !apiAvailable}
          >
            <RefreshCw data-icon="inline-start" />
            {detailBusy ? "Refreshing details…" : "Refresh details"}
          </Button>
          <SpeakerInvitationControls
            previewBusy={invitation.previewBusy}
            sendBusy={invitation.sendBusy}
            disabled={!apiAvailable}
            canSend={invitation.canSend}
            onPreview={invitation.onPreview}
            onSend={invitation.onSend}
          />
        </div>
      </CardHeader>
      <CardContent className={styles.actionsStack}>
        {detailNotice ? (
          <FormMessage
            message={detailNotice}
            error={detailNotice.includes("unavailable") || detailNotice.includes("could")}
          />
        ) : null}
        <SpeakerInvitationSection {...invitation} />
        <SpeakerHeadshotSection
          speakerName={selectedSpeaker.displayName}
          {...headshot}
          apiAvailable={apiAvailable}
        />
        {editDraft ? (
          <form className={styles.detailBlock} onSubmit={onSave}>
            <ProfileFields
              draft={editDraft}
              onChange={onEditDraftChange}
              disabled={saveBusy}
              {...(temporalContext === undefined ? {} : { temporalContext })}
            />
            <Field>
              <FieldLabel htmlFor="edit-speaker-status">Workflow status</FieldLabel>
              <Select
                value={editDraft.status}
                onValueChange={(value) => onEditDraftChange("status", value)}
                disabled={saveBusy}
              >
                <SelectTrigger id="edit-speaker-status">
                  <SelectValue placeholder="Select workflow status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {statusOptions.map((status) => (
                      <SelectItem key={status} value={status}>
                        {statusLabel(status)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <MutationStatusMessage
              label="Profile"
              status={profileMutationStatus}
              message={profileMutationMessage}
            />
            {editError ? <FormMessage message={editError} error /> : null}
            <div className={styles.actions}>
              <Button variant="default" type="submit" disabled={saveBusy || !apiAvailable}>
                <CheckCircle2 data-icon="inline-start" />
                {profileMutationStatus === "pending"
                  ? "Pending…"
                  : saveBusy
                    ? "Saving…"
                    : "Save profile changes"}
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="outline" type="button" onClick={() => onBeginEdit(selectedSpeaker)}>
            Edit profile
          </Button>
        )}
        <div className={styles.detailGrid}>
          <Card size="sm">
            <CardHeader>
              <CardTitle className={styles.subheading}>Session assignments</CardTitle>
              <CardDescription>Authoritative agenda links.</CardDescription>
            </CardHeader>
            <CardContent className={styles.actionsStack}>
              {selectedSpeaker.sessions.length === 0 ? (
                <Empty>
                  <EmptyTitle>No sessions linked</EmptyTitle>
                  <EmptyDescription>No sessions are linked to this speaker yet.</EmptyDescription>
                </Empty>
              ) : (
                <ul className={styles.list}>
                  {selectedSpeaker.sessions.map((session: SpeakerSession) => (
                    <li key={session.sessionId} className={styles.preview}>
                      <strong>{session.title}</strong>
                      <Badge variant="outline">{statusLabel(session.status)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.actions}>
                <Button
                  variant="outline"
                  type="button"
                  disabled
                  title="Session linking is managed by the agenda service."
                >
                  Assign a session
                </Button>
                <Button variant="outline" asChild>
                  <Link
                    href={`/admin/organizations/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}/agenda`}
                  >
                    Open Agenda
                  </Link>
                </Button>
              </div>
              <p className={styles.muted}>
                Session linking is managed in Agenda; this workspace shows the authoritative
                assignments.
              </p>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle className={styles.subheading}>Uploaded deliverables</CardTitle>
              <CardDescription>Private event files and headshots.</CardDescription>
            </CardHeader>
            <CardContent>
              {selectedSpeaker.assets.length === 0 ? (
                <Empty>
                  <EmptyTitle>No deliverables</EmptyTitle>
                  <EmptyDescription>
                    No uploaded headshot or deliverables are available.
                  </EmptyDescription>
                </Empty>
              ) : (
                <ul className={styles.list}>
                  {selectedSpeaker.assets.map((asset: SpeakerAsset) => (
                    <li key={asset.assetId} className={styles.preview}>
                      <strong>{asset.fileName}</strong>
                      <SpeakerAssetMetadata asset={asset} />
                      <SpeakerAssetDownload
                        asset={asset}
                        busy={downloadBusyAssetId === asset.assetId}
                        disabled={!apiAvailable || downloadBusyAssetId !== null}
                        error={downloadErrors[asset.assetId] ?? null}
                        onRequest={onAssetDownload}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </CardContent>
    </Card>
  );
}

function SpeakerRosterList({
  scopedRoster,
  loading,
  speakers,
  filteredSpeakers,
  selectedId,
  selectedSpeakerIdSet,
  onToggleSelection,
  onBeginEdit,
  detailTriggerRef,
}: Readonly<{
  scopedRoster: SpeakerRosterEnvelope | null;
  loading: boolean;
  speakers: readonly SpeakerRecord[];
  filteredSpeakers: readonly SpeakerRecord[];
  selectedId: string | null;
  selectedSpeakerIdSet: ReadonlySet<string>;
  onToggleSelection: (participantId: string) => void;
  onBeginEdit: (speaker: SpeakerRecord) => void;
  detailTriggerRef: RefObject<HTMLButtonElement | null>;
}>) {
  return (
    <div className={styles.rosterList}>
      {!loading && scopedRoster && speakers.length === 0 ? (
        <Empty className={styles.empty}>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users />
            </EmptyMedia>
            <EmptyTitle>No speakers yet</EmptyTitle>
            <EmptyDescription>
              Add a speaker or use the Import CSV control below to start this event roster.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!loading && scopedRoster && speakers.length > 0 && filteredSpeakers.length === 0 ? (
        <Empty className={styles.empty}>
          <EmptyHeader>
            <EmptyTitle>No matching speakers</EmptyTitle>
            <EmptyDescription>
              No speakers match the current search and filters. Clear them to restore the roster.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {filteredSpeakers.length > 0 ? (
        <div className={styles.speakerTableViewport}>
          <Table className={styles.speakerTable}>
            <TableCaption className={styles.srOnly}>Event speaker roster</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className={styles.srOnly}>Select</span>
                </TableHead>
                {SPEAKER_ROSTER_COLUMNS.map((column) => (
                  <TableHead key={column}>{column}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSpeakers.map((speaker) => (
                <TableRow
                  className={styles.speakerRow}
                  key={speaker.participantId}
                  aria-current={selectedId === speaker.participantId ? "true" : undefined}
                  data-state={selectedId === speaker.participantId ? "selected" : undefined}
                >
                  <TableCell className={styles.checkboxCell}>
                    <Checkbox
                      id={`roster-selection-${speaker.participantId}`}
                      aria-label={`Select ${speaker.displayName}`}
                      checked={selectedSpeakerIdSet.has(speaker.participantId)}
                      onCheckedChange={() => onToggleSelection(speaker.participantId)}
                    />
                  </TableCell>
                  <TableHead scope="row" className={styles.speakerIdentityCell}>
                    <div className={styles.speakerCopy}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={styles.speakerName}
                        type="button"
                        onClick={(event) => {
                          detailTriggerRef.current = event.currentTarget;
                          onBeginEdit(speaker);
                        }}
                      >
                        {speaker.displayName}
                      </Button>
                      <span className={styles.speakerMeta}>{speaker.email}</span>
                      <span className={styles.speakerMeta}>
                        {speaker.jobTitle || speaker.company
                          ? `${speaker.jobTitle ?? ""}${speaker.jobTitle && speaker.company ? " · " : ""}${speaker.company ?? ""}`
                          : "Profile details pending"}
                      </span>
                    </div>
                  </TableHead>
                  <TableCell>
                    <SpeakerStatusBadge status={speaker.status} />
                  </TableCell>
                  <TableCell className={styles.numericCell}>
                    {speaker.sessions.length} session
                    {speaker.sessions.length === 1 ? "" : "s"}
                  </TableCell>
                  <TableCell className={styles.taskCell}>
                    {speaker.taskSummary.completed} / {speaker.taskSummary.total} tasks
                    {speaker.taskSummary.overdue > 0
                      ? ` · ${speaker.taskSummary.overdue} overdue`
                      : ""}
                  </TableCell>
                  <TableCell className={styles.actionCell}>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={(event) => {
                        detailTriggerRef.current = event.currentTarget;
                        onBeginEdit(speaker);
                      }}
                    >
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
function SpeakerRosterSection({
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
  attentionFilter,
  attentionCounts,
  hasActiveRosterFilters,
  hasAnyFilters,
  selectedSpeakerIds,
  allVisibleSelected,
  detail,
  onQueryChange,
  onToggleFilters,
  onStatusFilterChange,
  onSessionFilterChange,
  onProgressFilterChange,
  onAttentionFilterChange,
  onClearFilters,
  onOpenSelectedEmail,
  onToggleVisibleSelection,
  onClearSelection,
  onToggleSelection,
  onBeginEdit,
  detailTriggerRef,
}: Readonly<{
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
  attentionFilter: SpeakerAttentionFilter;
  attentionCounts: Readonly<Record<SpeakerAttentionFilter, number>>;
  hasActiveRosterFilters: boolean;
  hasAnyFilters: boolean;
  selectedSpeakerIds: readonly string[];
  allVisibleSelected: boolean;
  detail: ReactNode;
  onQueryChange: (query: string) => void;
  onToggleFilters: () => void;
  onStatusFilterChange: (status: string) => void;
  onSessionFilterChange: (session: string) => void;
  onProgressFilterChange: (progress: ProgressFilter) => void;
  onAttentionFilterChange: (attention: SpeakerAttentionFilter) => void;
  onClearFilters: () => void;
  onOpenSelectedEmail: () => void;
  onToggleVisibleSelection: () => void;
  onClearSelection: () => void;
  onToggleSelection: (participantId: string) => void;
  onBeginEdit: (speaker: SpeakerRecord) => void;
  detailTriggerRef: RefObject<HTMLButtonElement | null>;
}>) {
  return (
    <Card className={styles.panel} aria-busy={loading}>
      <CardHeader className={styles.panelHeader}>
        <div>
          <CardTitle id="roster-heading">Roster</CardTitle>
          <CardDescription>
            Manage people and profile/delivery records for this event, then open a speaker for
            details.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className={styles.actionsStack}>
        <div className={styles.rosterToolbar}>
          <Field className={styles.searchField}>
            <FieldLabel className={adminStyles.srOnly} htmlFor="speaker-search">
              Search speakers
            </FieldLabel>
            <div className={styles.inputWithIcon}>
              <Search aria-hidden="true" />
              <Input
                id="speaker-search"
                aria-label="Search speakers"
                placeholder="Search speakers"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </div>
          </Field>
          <Button
            className={styles.filterTrigger}
            variant="outline"
            type="button"
            aria-label="Filter speakers"
            aria-controls="speaker-roster-filters"
            aria-expanded={filtersOpen}
            onClick={onToggleFilters}
          >
            <ListFilter />
            <span className={styles.filterLabel}>Filters</span>
            {[
              attentionFilter !== "all",
              statusFilter !== "all",
              sessionFilter !== "all",
              progressFilter !== "all",
            ].filter(Boolean).length > 0 ? (
              <Badge variant="secondary">
                {
                  [
                    attentionFilter !== "all",
                    statusFilter !== "all",
                    sessionFilter !== "all",
                    progressFilter !== "all",
                  ].filter(Boolean).length
                }
              </Badge>
            ) : null}
          </Button>
          {hasAnyFilters ? (
            <Button variant="ghost" type="button" onClick={onClearFilters}>
              Clear
            </Button>
          ) : null}
        </div>
        {filtersOpen ? (
          <div id="speaker-roster-filters" className={styles.filterPanel}>
            <section className={styles.attentionStrip} aria-label="Speaker attention filters">
              {(["all", "overdue", "awaiting-invite", "duplicate-email", "inactive"] as const).map(
                (value) => {
                  const labels = {
                    all: "All speakers",
                    overdue: "Overdue tasks",
                    "awaiting-invite": "Awaiting invite",
                    "duplicate-email": "Duplicate emails",
                    inactive: "Inactive",
                  } as const;
                  return (
                    <button
                      key={value}
                      className={styles.attentionFilter}
                      type="button"
                      aria-pressed={attentionFilter === value}
                      onClick={() => onAttentionFilterChange(value)}
                    >
                      <span>{labels[value]}</span>
                      <strong>{attentionCounts[value]}</strong>
                    </button>
                  );
                },
              )}
            </section>
            <Field>
              <FieldLabel className={adminStyles.srOnly} htmlFor="speaker-status-filter">
                Filter by status
              </FieldLabel>
              <Select value={statusFilter} onValueChange={onStatusFilterChange}>
                <SelectTrigger id="speaker-status-filter" aria-label="Filter by status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All statuses</SelectItem>
                    {statusOptions.map((status) => (
                      <SelectItem key={status} value={status}>
                        {statusLabel(status)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel className={adminStyles.srOnly} htmlFor="speaker-session-filter">
                Filter by session
              </FieldLabel>
              <Select value={sessionFilter} onValueChange={onSessionFilterChange}>
                <SelectTrigger id="speaker-session-filter" aria-label="Filter by session">
                  <SelectValue placeholder="All sessions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All sessions</SelectItem>
                    {sessionOptions.map(([sessionId, title]) => (
                      <SelectItem key={sessionId} value={sessionId}>
                        {title}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel className={adminStyles.srOnly} htmlFor="speaker-progress-filter">
                Filter by task progress
              </FieldLabel>
              <Select
                value={progressFilter}
                onValueChange={(value) => onProgressFilterChange(value as ProgressFilter)}
              >
                <SelectTrigger id="speaker-progress-filter" aria-label="Filter by task progress">
                  <SelectValue placeholder="All task progress" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All task progress</SelectItem>
                    <SelectItem value="complete">Complete</SelectItem>
                    <SelectItem value="incomplete">Incomplete</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
        ) : null}
        {hasActiveRosterFilters ? (
          <p className={styles.muted} role="status" aria-live="polite">
            Showing {filteredSpeakers.length} of {speakers.length} speakers after filters.
          </p>
        ) : null}
        {selectedSpeakerIds.length > 0 ? (
          <div className={styles.selectionBar} role="status">
            <span>
              <strong>{selectedSpeakerIds.length}</strong> selected for email
            </span>
            <div className={styles.actions}>
              <Button size="sm" type="button" onClick={onOpenSelectedEmail}>
                <Mail data-icon="inline-start" />
                Compose email
              </Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={onToggleVisibleSelection}
                disabled={filteredSpeakers.length === 0}
              >
                {allVisibleSelected ? "Deselect visible" : "Select visible"}
              </Button>
              <Button variant="ghost" size="sm" type="button" onClick={onClearSelection}>
                Clear
              </Button>
            </div>
          </div>
        ) : null}
        {loading ? (
          <FormMessage
            message={scopedRoster ? "Refreshing speaker roster…" : "Loading speaker roster…"}
          />
        ) : null}
        {duplicateEmailWarnings.length > 0 ? (
          <FormMessage
            error
            message={`Duplicate speaker email conflict: ${duplicateEmailWarnings.map((conflict) => `${conflict.email} (${conflict.speakers.map((speaker) => speaker.displayName).join(", ")})`).join("; ")}. Each authoritative speaker remains visible.`}
          />
        ) : null}
        <WorkspaceListDetail
          data-speaker-collection="true"
          className={styles.rosterGrid}
          listLabel="Speaker roster"
          detailLabel="Selected speaker record"
          list={
            <SpeakerRosterList
              scopedRoster={scopedRoster}
              loading={loading}
              speakers={speakers}
              filteredSpeakers={filteredSpeakers}
              selectedId={selectedId}
              selectedSpeakerIdSet={selectedSpeakerIdSet}
              onToggleSelection={onToggleSelection}
              onBeginEdit={onBeginEdit}
              detailTriggerRef={detailTriggerRef}
            />
          }
          detail={detail}
        />
      </CardContent>
    </Card>
  );
}

function SpeakerImportSection({
  open,
  showTrigger,
  busy,
  previewBusy,
  commitBusy,
  apiAvailable,
  fileName,
  preview,
  onOpenChange,
  onPreview,
  onCommit,
}: Readonly<{
  open: boolean;
  showTrigger: boolean;
  busy: boolean;
  previewBusy: boolean;
  commitBusy: boolean;
  apiAvailable: boolean;
  fileName: string | null;
  preview: import("./api").SpeakerImportPreview | null;
  onOpenChange: (open: boolean) => void;
  onPreview: (file: File) => void;
  onCommit: () => void;
}>) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={styles.importDetails}>
      {showTrigger ? (
        <CollapsibleTrigger asChild>
          <Button variant="outline" type="button">
            <FileText data-icon="inline-start" />
            {open ? "Hide CSV import" : "Import CSV"}
          </Button>
        </CollapsibleTrigger>
      ) : null}
      <CollapsibleContent id="speaker-csv-import" className={styles.importBody}>
        <Card aria-busy={busy}>
          <CardHeader>
            <CardTitle>Import speaker roster</CardTitle>
            <CardDescription>
              Preview validation before committing rows. Invalid rows are never written to this
              event.
            </CardDescription>
          </CardHeader>
          <CardContent className={styles.actionsStack}>
            <Field>
              <FieldLabel htmlFor="speaker-csv">Speakers CSV</FieldLabel>
              <FileUpload
                id="speaker-csv"
                ariaLabel="Speakers CSV"
                accept=".csv,text/csv"
                disabled={commitBusy || !apiAvailable}
                title="Drop a speakers CSV here or browse"
                hint="Preview validation before committing rows. Invalid rows are never written to this event."
                files={
                  fileName
                    ? [
                        {
                          id: fileName,
                          name: fileName,
                          sizeLabel: previewBusy ? "Validating CSV…" : "Selected CSV",
                          status: previewBusy ? "uploading" : "selected",
                          removable: false,
                        },
                      ]
                    : []
                }
                onFilesSelected={(files) => {
                  const file = files[0];
                  if (file) onPreview(file);
                }}
              />
            </Field>
            {previewBusy ? <FormMessage message="Validating CSV…" /> : null}
            {preview ? (
              <div className={styles.actionsStack}>
                <div className={styles.actions}>
                  <Badge variant="secondary">{preview.validRows.length} valid</Badge>
                  <Badge variant="destructive">{preview.invalidRows.length} invalid</Badge>
                </div>
                {preview.invalidRows.length > 0 ? (
                  <ul className={styles.list} aria-label="CSV validation errors">
                    {preview.invalidRows.map((issue) => (
                      <li key={`${issue.rowNumber}-${issue.field ?? "row"}-${issue.message}`}>
                        Row {issue.rowNumber}
                        {issue.field ? ` · ${issue.field}` : ""}: {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.muted}>
                    All previewed rows passed required identity validation.
                  </p>
                )}
                <Button
                  variant="default"
                  type="button"
                  onClick={onCommit}
                  disabled={
                    commitBusy || previewBusy || preview.validRows.length === 0 || !apiAvailable
                  }
                >
                  <Upload data-icon="inline-start" />
                  {commitBusy
                    ? "Importing…"
                    : `Commit ${preview.validRows.length} valid row${preview.validRows.length === 1 ? "" : "s"}`}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SpeakerTaskAssignmentSection({
  rosterEmpty,
  apiAvailable,
  speakers,
  taskTitle,
  taskDueAt,
  taskAssigneeIdSet,
  taskBusy,
  progress,
  progressError,
  progressSectionVisible,
  loading,
  rosterLoaded,
  taskDefinitions,
  temporalContext,
  onLoadProgress,
  onTaskTitleChange,
  onTaskDueChange,
  onToggleAssignee,
  onAssign,
  onAddSpeaker,
  onImportCsv,
}: Readonly<{
  rosterEmpty: boolean;
  apiAvailable: boolean;
  speakers: readonly SpeakerRecord[];
  taskTitle: string;
  taskDueAt: string;
  taskAssigneeIdSet: ReadonlySet<string>;
  taskBusy: boolean;
  progress: SpeakerProgressEnvelope | null;
  progressError: string | null;
  progressSectionVisible: boolean;
  loading: boolean;
  rosterLoaded: boolean;
  taskDefinitions: readonly SpeakerOnboardingTaskDefinition[];
  temporalContext?: SpeakerEventTemporalContext;
  onLoadProgress: () => void;
  onTaskTitleChange: (title: string) => void;
  onTaskDueChange: (dueAt: string) => void;
  onToggleAssignee: (participantId: string) => void;
  onAssign: (event: FormEvent<HTMLFormElement>) => void;
  onAddSpeaker: () => void;
  onImportCsv: () => void;
}>) {
  const taskDeadlinePolicy =
    temporalContext === undefined ? null : deadlineTemporalPolicy(temporalContext);
  const taskDeadlineWarning =
    temporalContext === undefined ? null : deadlineAfterEventWarning(taskDueAt, temporalContext);
  return (
    <Card className={styles.panel}>
      <CardHeader className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>Assign a new action</p>
          <CardTitle id="tasks-heading">Speaker onboarding</CardTitle>
          <CardDescription>
            Organizers assign action items that speakers complete in their portal. Email is for
            messages that do not require task completion.
          </CardDescription>
        </div>
        <Badge variant="outline">{taskDefinitions.length} / 3 task definitions</Badge>
      </CardHeader>
      <CardContent className={styles.actionsStack}>
        {rosterEmpty ? (
          <Empty className={styles.empty}>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ListTodo />
              </EmptyMedia>
              <EmptyTitle>Add speakers to start onboarding</EmptyTitle>
              <EmptyDescription>
                Add or import speakers before assigning action items they can complete in their
                portal.
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
        ) : (
          <>
            {!progressSectionVisible ? (
              <Button
                variant="outline"
                type="button"
                onClick={onLoadProgress}
                disabled={!apiAvailable || loading || !rosterLoaded}
              >
                <RefreshCw data-icon="inline-start" />
                Load task progress
              </Button>
            ) : progress === null && progressError === null ? (
              <FormMessage message="Loading task progress…" />
            ) : null}
            <form className={styles.actionsStack} onSubmit={onAssign}>
              <div className={styles.fieldGrid}>
                <Field>
                  <FieldLabel htmlFor="task-title">Task title</FieldLabel>
                  <Input
                    id="task-title"
                    value={taskTitle}
                    onChange={(event) => onTaskTitleChange(event.target.value)}
                    placeholder="Confirm participation"
                    required
                    disabled={taskBusy}
                  />
                </Field>
                <Field style={{ gridColumn: "1 / -1" }}>
                  <TemporalPicker
                    id="task-due-date"
                    mode="single"
                    precision="date"
                    value={taskDueAt}
                    label="Due date"
                    eyebrow="Task deadline"
                    description="Choose a deadline on or after today in the event timezone."
                    minimumDateTime={taskDeadlinePolicy?.minimumDate}
                    onChange={onTaskDueChange}
                    disabled={taskBusy}
                  />
                  {taskDeadlineWarning ? (
                    <p className={styles.muted} role="status">
                      {taskDeadlineWarning}
                    </p>
                  ) : null}
                </Field>
              </div>
              <FieldSet className={styles.detailBlock}>
                <FieldLegend variant="label">Assign to speakers</FieldLegend>
                {speakers.length === 0 ? (
                  <Empty>
                    <EmptyTitle>Add speakers first</EmptyTitle>
                    <EmptyDescription>Add speakers before assigning a task.</EmptyDescription>
                  </Empty>
                ) : (
                  <div className={styles.checkboxGrid}>
                    {speakers.map((speaker) => (
                      <Field
                        key={speaker.participantId}
                        orientation="horizontal"
                        className={styles.checkboxField}
                      >
                        <Checkbox
                          id={`task-assignee-${speaker.participantId}`}
                          aria-label={`Assign task to ${speaker.displayName}`}
                          checked={taskAssigneeIdSet.has(speaker.participantId)}
                          onCheckedChange={() => onToggleAssignee(speaker.participantId)}
                          disabled={taskBusy}
                        />
                        <FieldLabel htmlFor={`task-assignee-${speaker.participantId}`}>
                          Assign task to {speaker.displayName}
                        </FieldLabel>
                      </Field>
                    ))}
                  </div>
                )}
              </FieldSet>
              <div className={styles.actions}>
                <Button
                  variant="default"
                  type="submit"
                  disabled={
                    taskBusy ||
                    !apiAvailable ||
                    speakers.length === 0 ||
                    progress === null ||
                    progressError !== null ||
                    taskDefinitions.length >= 3
                  }
                >
                  <ListTodo data-icon="inline-start" />
                  {taskBusy
                    ? "Assigning…"
                    : taskDefinitions.length >= 3
                      ? "Three onboarding tasks configured"
                      : "Assign onboarding task"}
                </Button>
                <Badge variant="outline">Task type: action / mark complete</Badge>
              </div>
            </form>
            {taskDefinitions.length > 0 ? (
              <Table>
                <TableCaption className={adminStyles.srOnly}>
                  API-loaded organizer onboarding task definitions
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Task</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Assignees</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {taskDefinitions.map((definition) => (
                    <TableRow key={definition.definitionId}>
                      <TableHead scope="row">{definition.title}</TableHead>
                      <TableCell>{dateLabel(definition.dueAt)}</TableCell>
                      <TableCell>
                        {speakerTaskAssigneeLabels(definition.participantIds, speakers).join(", ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SpeakerProgressSection({
  progress,
  progressError,
  progressRows,
  progressFilter,
  onProgressFilterChange,
}: Readonly<{
  progress: SpeakerProgressEnvelope | null;
  progressError: string | null;
  progressRows: readonly SpeakerProgressEnvelope["rows"][number][];
  progressFilter: ProgressFilter;
  onProgressFilterChange: (progress: ProgressFilter) => void;
}>) {
  return (
    <Card className={styles.panel}>
      <CardHeader className={styles.panelHeader}>
        <div>
          <CardTitle id="progress-heading">Onboarding progress</CardTitle>
          <CardDescription>
            List-level general-task completion, including changes speakers make in their portal.
          </CardDescription>
        </div>
        <Field>
          <FieldLabel className={adminStyles.srOnly} htmlFor="task-progress-filter">
            Filter task progress
          </FieldLabel>
          <Select
            value={progressFilter}
            onValueChange={(value) => onProgressFilterChange(value as ProgressFilter)}
          >
            <SelectTrigger id="task-progress-filter" aria-label="Filter task progress">
              <SelectValue placeholder="All progress" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All progress</SelectItem>
                <SelectItem value="complete">Complete</SelectItem>
                <SelectItem value="incomplete">Incomplete</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </CardHeader>
      <CardContent>
        {progressError ? (
          <FormMessage message={`Progress unavailable: ${progressError}`} error />
        ) : null}
        {!progressError && progress && progressRows.length === 0 ? (
          <Empty>
            <EmptyTitle>No progress matches</EmptyTitle>
            <EmptyDescription>No speakers match this progress filter.</EmptyDescription>
          </Empty>
        ) : null}
        {!progressError && progress && progressRows.length > 0 ? (
          <Table>
            <TableCaption className={adminStyles.srOnly}>
              Speaker task completion progress
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Speaker</TableHead>
                <TableHead>Tasks and due dates</TableHead>
                <TableHead>Progress</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {progressRows.map((row) => {
                const completed = row.tasks.filter((task: SpeakerTask) =>
                  taskComplete(task.status),
                ).length;
                const progressValue =
                  row.tasks.length === 0 ? 0 : (completed / row.tasks.length) * 100;
                return (
                  <TableRow key={row.participantId}>
                    <TableHead scope="row">{row.displayName}</TableHead>
                    <TableCell>
                      <ul className={styles.list}>
                        {row.tasks.length === 0 ? (
                          <li className={styles.muted}>No general tasks assigned.</li>
                        ) : (
                          row.tasks.map((task: SpeakerTask) => (
                            <li key={task.taskId}>
                              <strong>{task.title}</strong> · {dateLabel(task.dueAt)} ·{" "}
                              <SpeakerTaskStatusBadge status={task.status} />
                            </li>
                          ))
                        )}
                      </ul>
                    </TableCell>
                    <TableCell>
                      <div className={styles.progressCell}>
                        <Progress
                          value={progressValue}
                          aria-label={`${completed} of ${row.tasks.length} tasks complete`}
                        />
                        <span>
                          {completed} / {row.tasks.length} complete
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function parseReminderOffsetDraft(
  value: string,
): { ok: true; offsets: number[] } | { ok: false; message: string } {
  if (value.trim().length === 0) return { ok: true, offsets: [] };
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => !/^\d+$/u.test(part))) {
    return { ok: false, message: "Enter minute values separated by commas." };
  }
  const offsets = parts.map(Number);
  if (offsets.some((offset) => !Number.isSafeInteger(offset) || offset < 0 || offset % 60 !== 0)) {
    return {
      ok: false,
      message: "Each reminder offset must be a non-negative whole-hour increment in minutes.",
    };
  }
  if (new Set(offsets).size !== offsets.length) {
    return { ok: false, message: "Remove duplicate reminder offsets before saving." };
  }
  return { ok: true, offsets: offsets.sort((left, right) => left - right) };
}

function reminderReasonLabel(reason: string): string {
  switch (reason) {
    case "complete":
      return "This task is already complete.";
    case "no_due_date":
      return "Add a due date before scheduling reminders.";
    case "no_reminder_offset":
      return "Scheduled reminders are disabled.";
    case "outside_window":
      return "The next delivery window has not opened yet.";
    default:
      return "This reminder is not currently ready for delivery.";
  }
}

export function SpeakerReminderOffsetEditor({
  task,
  item,
  onSave,
}: Readonly<{
  task: SpeakerTask;
  item: SpeakerReminderEligibilityEnvelope["items"][number];
  onSave: (
    taskId: string,
    expectedVersion: number,
    reminderOffsetsMinutes: readonly number[],
  ) => Promise<SpeakerTaskReminderOffsetsResult>;
}>) {
  const [draft, setDraft] = useState(item.reminderOffsetsMinutes.join(", "));
  const [version, setVersion] = useState(task.version);
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const editable =
    task.type === "file_request" &&
    task.dueAt !== null &&
    !["completed", "submitted", "waived"].includes(task.status);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = parseReminderOffsetDraft(draft);
    if (!parsed.ok) {
      setStatus("error");
      setMessage(parsed.message);
      return;
    }
    setStatus("pending");
    setMessage("Saving reminder schedule…");
    try {
      const result = await onSave(task.taskId, version, parsed.offsets);
      setVersion(result.version);
      setDraft(result.reminderOffsetsMinutes.join(", "));
      setStatus("success");
      setMessage(
        result.reminderOffsetsMinutes.length === 0
          ? "Scheduled reminders disabled."
          : "Reminder schedule saved.",
      );
    } catch {
      setStatus("error");
      setMessage("The reminder schedule could not be saved. Reload tasks and try again.");
    }
  }

  if (!editable) return null;
  return (
    <form className={styles.reminderEditor} onSubmit={(event) => void submit(event)}>
      <Field>
        <FieldLabel>Reminder offsets in minutes</FieldLabel>
        <Input
          aria-label={`Reminder offsets in minutes for ${item.title}`}
          inputMode="numeric"
          value={draft}
          disabled={status === "pending"}
          onChange={(event) => {
            setDraft(event.target.value);
            if (status !== "idle") {
              setStatus("idle");
              setMessage(null);
            }
          }}
          placeholder="10080, 1440"
        />
        <p className={styles.muted}>
          Use whole-hour increments in minutes. Clear the field to disable scheduled reminders.
        </p>
      </Field>
      <div className={styles.actions}>
        <Button type="submit" size="sm" disabled={status === "pending"}>
          {status === "pending" ? "Saving…" : "Save reminder schedule"}
        </Button>
        {message === null ? null : (
          <span
            role={status === "error" ? "alert" : "status"}
            aria-live={status === "error" ? "assertive" : "polite"}
          >
            {message}
          </span>
        )}
      </div>
    </form>
  );
}

function SpeakerReminderSection({
  reminderEligibility,
  eligibleItems,
  ineligibleItems,
  tasks,
  onSaveOffsets,
}: Readonly<{
  reminderEligibility: SpeakerReminderEligibilityEnvelope | null;
  eligibleItems: readonly SpeakerReminderEligibilityEnvelope["items"][number][];
  ineligibleItems: readonly SpeakerReminderEligibilityEnvelope["items"][number][];
  tasks: readonly SpeakerTask[];
  onSaveOffsets: (
    taskId: string,
    expectedVersion: number,
    reminderOffsetsMinutes: readonly number[],
  ) => Promise<SpeakerTaskReminderOffsetsResult>;
}>) {
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  return (
    <Card className={styles.panel}>
      <CardHeader className={styles.panelHeader}>
        <div>
          <CardTitle id="upcoming-reminders-heading">Upcoming reminders</CardTitle>
          <CardDescription>
            Only reminders that are currently eligible for delivery are shown here.
          </CardDescription>
        </div>
        <Badge variant="outline">
          {reminderEligibility === null ? "Loading" : `${eligibleItems.length} due`}
        </Badge>
      </CardHeader>
      <CardContent className={styles.actionsStack}>
        {reminderEligibility === null ? (
          <FormMessage message="Checking upcoming reminders…" />
        ) : eligibleItems.length === 0 ? (
          <Empty>
            <EmptyTitle>No eligible reminders</EmptyTitle>
            <EmptyDescription>
              Eligible reminders will appear here when their delivery window opens.
            </EmptyDescription>
          </Empty>
        ) : (
          <ul className={styles.list} aria-label="Upcoming reminders">
            {eligibleItems.map((item) => (
              <li className={styles.reminderItem} key={item.taskId}>
                <strong>{item.title}</strong>
                <span>{dateLabel(item.dueAt)}</span>
                <Badge variant="secondary">Ready to send</Badge>
                {taskById.get(item.taskId) === undefined ? null : (
                  <SpeakerReminderOffsetEditor
                    task={taskById.get(item.taskId) as SpeakerTask}
                    item={item}
                    onSave={onSaveOffsets}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {ineligibleItems.length > 0 ? (
          <Accordion type="single" collapsible defaultValue="">
            <AccordionItem value="diagnostics">
              <AccordionTrigger>Reminder diagnostics</AccordionTrigger>
              <AccordionContent>
                <p className={styles.muted}>
                  Internal eligibility reasons are available for operators who need to investigate a
                  reminder schedule.
                </p>
                <ul className={styles.list}>
                  {ineligibleItems.map((item) => (
                    <li className={styles.reminderDiagnostic} key={item.taskId}>
                      <span>
                        <strong>{item.title}</strong> · {reminderReasonLabel(item.reason)}
                      </span>
                      {taskById.get(item.taskId) === undefined ? null : (
                        <SpeakerReminderOffsetEditor
                          task={taskById.get(item.taskId) as SpeakerTask}
                          item={item}
                          onSave={onSaveOffsets}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SpeakerEmailHistorySection({ sends }: Readonly<{ sends: readonly SpeakerEmailSend[] }>) {
  return (
    <Card size="sm" className={styles.emailHistory}>
      <CardHeader>
        <CardTitle>Email send history</CardTitle>
        <CardDescription>
          Completed send records stay here when you start a new draft or preview.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sends.length === 0 ? (
          <p className={styles.muted} role="status">
            No email sends recorded for this event.
          </p>
        ) : (
          <Table>
            <TableCaption className={adminStyles.srOnly}>Speaker email send history</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Recipients</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sends.map((send) => (
                <TableRow key={send.id}>
                  <TableCell>
                    <Badge variant="outline">{send.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {send.templateId} · v{send.templateVersion}
                  </TableCell>
                  <TableCell>{send.recipientIds.length}</TableCell>
                  <TableCell>{dateLabel(send.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SpeakerEmailPreviewPanel({
  preview,
  previewCurrent,
}: Readonly<{
  preview: SpeakerEmailPreview | null;
  previewCurrent: boolean;
}>) {
  return (
    <Card
      size="sm"
      className={styles.emailPreviewPanel}
      aria-label="Selected speaker email preview"
    >
      <CardHeader>
        <CardTitle>Preview selected recipients</CardTitle>
        <CardDescription>
          Exact server result; this panel never executes template HTML.
        </CardDescription>
      </CardHeader>
      <CardContent className={styles.actionsStack}>
        {previewCurrent && preview ? (
          <>
            <p className={styles.muted}>
              {preview.recipientIds.length} recipient
              {preview.recipientIds.length === 1 ? "" : "s"} · exact template {preview.templateId} ·
              version {preview.templateVersion}
            </p>
            <p>
              <strong>Subject:</strong> {preview.subject}
            </p>
            <ul className={styles.list} aria-label="Speaker email preview recipient names">
              {preview.recipients.map((recipient) => (
                <li key={recipient.participantId}>
                  <strong>{recipient.displayName}</strong> · {recipient.email}
                </li>
              ))}
            </ul>
            <div className={styles.emailPreviewOutput}>
              <p className={styles.muted}>Server-rendered text</p>
              <pre>{preview.text}</pre>
              <p className={styles.muted}>Escaped HTML output</p>
              <pre>{preview.html}</pre>
            </div>
          </>
        ) : (
          <p className={styles.muted} role="status">
            No current preview. Select recipients and preview before confirming a send.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
function SpeakerEmailComposer({
  templates,
  templateId,
  templateVersion,
  templateName,
  subject,
  html,
  text,
  editorMode,
  preview,
  previewCurrent,
  apiAvailable,
  saveBusy,
  previewBusy,
  sendBusy,
  historyBusy,
  onTemplateChange,
  onUseStarter,
  onTemplateNameChange,
  onSubjectChange,
  onHtmlChange,
  onTextChange,
  onEditorModeChange,
  onSave,
  onPreview,
  onConfirm,
  onRefreshHistory,
  selectedCount,
}: Readonly<{
  templates: readonly SpeakerEmailTemplate[];
  templateId: string;
  templateVersion: number | undefined;
  templateName: string;
  subject: string;
  html: string;
  text: string;
  editorMode: "visual" | "html" | "text";
  preview: SpeakerEmailPreview | null;
  previewCurrent: boolean;
  apiAvailable: boolean;
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
  onConfirm: () => void;
  onRefreshHistory: () => void;
  selectedCount: number;
}>) {
  const selectedTemplate = templates.find(
    (template) => template.id === templateId && template.version === templateVersion,
  );
  return (
    <Card className={styles.panel} aria-busy={saveBusy || previewBusy || sendBusy || historyBusy}>
      <CardHeader className={styles.panelHeader}>
        <div>
          <CardTitle id="bulk-email-heading">Speaker email</CardTitle>
          <CardDescription>
            Use this event-scoped Email workspace for speaker-only outreach; broader announcements
            belong in Communications. Compose a message for {selectedCount} selected speaker
            {selectedCount === 1 ? "" : "s"}, save a draft, preview selected recipients, then
            confirm the send. Start with a blank message or apply an editable starter.
          </CardDescription>
        </div>
        <Badge variant="outline">Preview required before send</Badge>
      </CardHeader>
      <CardContent className={styles.actionsStack}>
        <div className={styles.emailFlowGrid}>
          <div className={styles.emailEditor}>
            <div className={styles.emailTemplateRow}>
              <Field>
                <FieldLabel htmlFor="email-template">Template version</FieldLabel>
                <Select
                  value={templateId ? `${templateId}:${templateVersion ?? ""}` : "new"}
                  onValueChange={onTemplateChange}
                  disabled={saveBusy}
                >
                  <SelectTrigger id="email-template">
                    <SelectValue placeholder="New template version" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="new">New template version</SelectItem>
                      {templates.map((template) => (
                        <SelectItem
                          key={`${template.id}:${template.version}`}
                          value={`${template.id}:${template.version}`}
                        >
                          {template.name} · v{template.version} · {template.status}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <div className={styles.emailTemplateMeta} aria-live="polite">
                <strong>{selectedTemplate?.name ?? templateName}</strong>
                <span className={styles.muted}>
                  {templateId
                    ? `Exact template ${templateId} · version ${templateVersion ?? "unsaved"}`
                    : "New draft · save to create an exact server version"}
                </span>
                {selectedTemplate ? (
                  <span className={styles.muted}>
                    {statusLabel(selectedTemplate.status)} · Sender {selectedTemplate.sender}
                  </span>
                ) : null}
              </div>
            </div>
            <Field>
              <div className={styles.actions}>
                <FieldLabel htmlFor="email-template-name">Template name</FieldLabel>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saveBusy}
                  onClick={onUseStarter}
                >
                  Use welcome starter
                </Button>
              </div>
              <Input
                id="email-template-name"
                value={templateName}
                onChange={(event) => onTemplateNameChange(event.target.value)}
                maxLength={200}
                disabled={saveBusy}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email-subject">Subject</FieldLabel>
              <Input
                id="email-subject"
                value={subject}
                onChange={(event) => onSubjectChange(event.target.value)}
                placeholder="Add a clear subject for {{first_name}}"
                maxLength={500}
                disabled={saveBusy}
              />
            </Field>
            <Tabs
              value={editorMode}
              onValueChange={(value) => onEditorModeChange(value as "visual" | "html" | "text")}
              className={styles.emailEditorTabs}
            >
              <TabsList
                variant="line"
                className={styles.emailEditorTabsList}
                aria-label="Email editor mode"
              >
                <TabsTrigger value="visual">Visual preview</TabsTrigger>
                <TabsTrigger value="html">HTML source</TabsTrigger>
                <TabsTrigger value="text">Plain text</TabsTrigger>
              </TabsList>
              <TabsContent value="visual" className={styles.actionsStack}>
                <p className={styles.muted}>
                  Visual mode uses the safe server preview. Raw HTML is never executed in this
                  workspace.
                </p>
                {previewCurrent && preview ? (
                  <div className={styles.emailPreviewOutput}>
                    <p className={styles.muted}>Server-rendered text</p>
                    <pre>{preview.text}</pre>
                    <p className={styles.muted}>Escaped HTML output</p>
                    <pre>{preview.html}</pre>
                  </div>
                ) : (
                  <p className={styles.muted} role="status">
                    Preview selected recipients to see the server-rendered result.
                  </p>
                )}
              </TabsContent>
              <TabsContent value="html">
                <Field>
                  <FieldLabel htmlFor="email-html">HTML source</FieldLabel>
                  <Textarea
                    id="email-html"
                    value={html}
                    onChange={(event) => onHtmlChange(event.target.value)}
                    placeholder="<p>Hello {{first_name}},</p><p>Add your message here.</p>"
                    maxLength={100_000}
                    disabled={saveBusy}
                    readOnly
                  />
                  <p className={styles.muted}>
                    Generated from the plain text body when you save or preview.
                  </p>
                </Field>
              </TabsContent>
              <TabsContent value="text">
                <Field>
                  <FieldLabel htmlFor="email-text">Plain text body</FieldLabel>
                  <Textarea
                    id="email-text"
                    value={text}
                    onChange={(event) => onTextChange(event.target.value)}
                    placeholder={"Hello {{first_name}},\n\nAdd your message here."}
                    maxLength={100_000}
                    disabled={saveBusy}
                  />
                </Field>
              </TabsContent>
            </Tabs>
            <p className={styles.muted}>
              Merge variables are resolved by the server:{" "}
              <code className={styles.code}>{"{{first_name}}"}</code>,{" "}
              <code className={styles.code}>{"{{display_name}}"}</code>,{" "}
              <code className={styles.code}>{"{{email}}"}</code>.
            </p>
          </div>
          <SpeakerEmailPreviewPanel preview={preview} previewCurrent={previewCurrent} />
        </div>
      </CardContent>
      <CardFooter className={styles.actions}>
        <Button
          variant="outline"
          type="button"
          onClick={onSave}
          disabled={saveBusy || !apiAvailable}
        >
          <CheckCircle2 data-icon="inline-start" />
          {saveBusy ? "Saving…" : "Save draft"}
        </Button>
        <Button
          variant="secondary"
          type="button"
          onClick={onPreview}
          disabled={previewBusy || !apiAvailable || selectedCount === 0}
        >
          <Eye data-icon="inline-start" />
          {previewBusy ? "Preparing…" : "Preview selected recipients"}
        </Button>
        <Button
          variant="default"
          type="button"
          onClick={onConfirm}
          disabled={sendBusy || !apiAvailable || !previewCurrent}
        >
          <Send data-icon="inline-start" />
          {sendBusy ? "Queueing…" : "Confirm send"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={onRefreshHistory}
          disabled={historyBusy || !apiAvailable}
          aria-label="Refresh speaker email history"
        >
          <RefreshCw data-icon="inline-start" />
          {historyBusy ? "Refreshing history…" : "Refresh history"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function SpeakerEmailSection({
  templates,
  templateId,
  templateVersion,
  templateName,
  subject,
  html,
  text,
  editorMode,
  preview,
  previewCurrent,
  sends,
  notice,
  apiAvailable,
  confirmOpen,
  saveBusy,
  previewBusy,
  sendBusy,
  historyBusy,
  selectedCount,
  onTemplateChange,
  onUseStarter,
  onTemplateNameChange,
  onSubjectChange,
  onHtmlChange,
  onTextChange,
  onEditorModeChange,
  onSave,
  onPreview,
  onConfirmOpenChange,
  onSend,
  onRefreshHistory,
}: Readonly<{
  templates: readonly SpeakerEmailTemplate[];
  templateId: string;
  templateVersion: number | undefined;
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
  apiAvailable: boolean;
  saveBusy: boolean;
  previewBusy: boolean;
  sendBusy: boolean;
  historyBusy: boolean;
  selectedCount: number;
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
}>) {
  return (
    <>
      <SpeakerEmailComposer
        apiAvailable={apiAvailable}
        templates={templates}
        templateId={templateId}
        templateVersion={templateVersion}
        templateName={templateName}
        subject={subject}
        html={html}
        text={text}
        editorMode={editorMode}
        preview={preview}
        previewCurrent={previewCurrent}
        saveBusy={saveBusy}
        previewBusy={previewBusy}
        sendBusy={sendBusy}
        historyBusy={historyBusy}
        onTemplateChange={onTemplateChange}
        onUseStarter={onUseStarter}
        onTemplateNameChange={onTemplateNameChange}
        onSubjectChange={onSubjectChange}
        onHtmlChange={onHtmlChange}
        onTextChange={onTextChange}
        onEditorModeChange={onEditorModeChange}
        onSave={onSave}
        onPreview={onPreview}
        onConfirm={() => onConfirmOpenChange(true)}
        onRefreshHistory={onRefreshHistory}
        selectedCount={selectedCount}
      />
      <div className={styles.actionsStack}>
        {notice ? (
          <FormMessage
            message={notice}
            error={notice.includes("unavailable") || notice.includes("could")}
          />
        ) : null}
        <SpeakerEmailHistorySection sends={sends} />
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={onConfirmOpenChange}>
        <AlertDialogContent className={styles.dialogContent}>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm speaker email send</AlertDialogTitle>
            <AlertDialogDescription>
              Queue the current server preview for {preview?.recipientIds.length ?? 0} selected
              recipient{(preview?.recipientIds.length ?? 0) === 1 ? "" : "s"} using exact template
              version {preview?.templateVersion ?? "unavailable"}. This action uses the current
              idempotency key and cannot be edited after queueing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sendBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={sendBusy || !apiAvailable || !previewCurrent}
              onClick={onSend}
            >
              {sendBusy ? "Queueing…" : "Confirm send"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export {
  ProfileFields,
  SpeakerAddDialog,
  SpeakerDetailSection,
  SpeakerEmailSection,
  SpeakerHeadshotSection,
  SpeakerImportSection,
  SpeakerProgressSection,
  SpeakerReminderSection,
  SpeakerRosterSection,
  SpeakerTaskAssignmentSection,
};
