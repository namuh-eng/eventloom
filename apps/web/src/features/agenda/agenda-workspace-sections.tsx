"use client";

import { formatInstantInTimeZone, type TimeDisambiguation } from "@eventloom/contracts";
import { CalendarDays, CheckCircle2, Clock3, Save } from "lucide-react";
import Link from "next/link";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { TemporalPicker } from "@/components/ui/temporal-picker";
import {
  StatusBadge,
  WorkspaceBreadcrumb,
  WorkspaceHeader,
  WorkspaceMetaItem,
} from "@/components/workspace/workspace-ui";
import { useNavigationDataCache } from "@/lib/navigation-data-cache-provider";
import {
  createScopedReadFlightCoordinator,
  type ScopedReadFlightCoordinator,
} from "@/lib/scoped-read-flight";
import { AgendaDaySelector } from "./agenda-day-selector";
import { AgendaOverview } from "./agenda-overview";
import { AgendaPlacementQueue } from "./agenda-placement-queue";
import {
  AGENDA_ENTRY_DRAG_TYPE,
  AgendaTimetable,
  type AgendaTimetableMove,
  type AgendaTimetablePlacement,
} from "./agenda-timetable";
import styles from "./agenda-workspace.module.css";
import {
  AGENDA_VIEW_MODES,
  type AgendaAsyncScopeToken,
  type AgendaBoardProps,
  type AgendaBusyOperation,
  type AgendaSuggestionOptions,
  type AgendaSuggestionPanelProps,
  type AgendaSuggestionRunView,
  type AgendaWorkspaceLoadResult,
  agendaViewLabels,
  agendaWorkspaceCacheKey,
  agendaWorkspaceCacheTags,
  agendaWorkspaceDataMatchesEvent,
  canCommitAgendaAsyncCompletion,
  createCanonicalAgendaWorkspaceApi,
  deriveAgendaViewGroups,
  type EntryFormProps,
  type ExistingSessionTimesSelection,
  entryFormReducer,
  formatScheduleDate,
  loadCanonicalAgendaWorkspaceWithCache,
  messageFrom,
  type ScopedAgendaSnapshot,
  type ScopedAgendaWorkspaceProps,
  safeScheduleId,
  scheduleDate,
  serializeAgendaSuggestionOptions,
  suggestionApiFor,
} from "./agenda-workspace-model";
import { type AgendaApi, AgendaApiError } from "./api";
import {
  type AgendaDay,
  acceptedSessionCount,
  agendaDays,
  conflictsForEntry,
  eventDates,
  eventScheduleDates,
  formatLocalTime,
  formatRevisionTimestamp,
  publicationReadiness,
  resolveAgendaPlacementDate,
  warningsForEntry,
} from "./model";
import type {
  AgendaCalendarDeliveryState,
  AgendaEntry,
  AgendaEntryInput,
  AgendaPreview,
  AgendaWorkspaceData,
} from "./types";

export function previewFromPlacementFailure(error: AgendaApiError): AgendaPreview | null {
  const failure = error.candidateDiagnostics;
  if (failure?.evaluated !== true || failure.report === null) return null;
  return {
    ...failure.authoritativeSavedPreview,
    conflicts: failure.report.conflicts,
  };
}
export async function recoverPlacementFailure(
  error: AgendaApiError,
  recover: (candidatePreview: AgendaPreview | null) => Promise<void>,
  onCandidateConflicts: (conflicts: AgendaPreview["conflicts"]) => void,
  onRecoveryError: (error: unknown) => void,
): Promise<void> {
  const candidatePreview = previewFromPlacementFailure(error);
  if (error.status === 409 && candidatePreview !== null) {
    onCandidateConflicts(candidatePreview.conflicts);
  }
  try {
    await recover(candidatePreview);
  } catch (recoveryError) {
    onRecoveryError(recoveryError);
  }
}

type AgendaEntryFormProps = EntryFormProps & {
  readonly event: AgendaWorkspaceData["event"];
};
function agendaBoundaryLocal(instant: string | undefined, timeZone: string): string | undefined {
  if (instant === undefined) return undefined;
  try {
    return formatInstantInTimeZone(instant, timeZone);
  } catch {
    return undefined;
  }
}

function EntryForm({
  entry,
  sessions,
  rooms,
  tracks,
  event,
  eventStart,
  busy,
  initialPlacement,
  initialSessionId,
  onSubmit,
  onCancel,
  onCreateRoom,
  onCreateTrack,
}: AgendaEntryFormProps) {
  const firstSession = entry?.sessionId ?? initialSessionId ?? sessions[0]?.id ?? "";
  const [formState, dispatchForm] = useReducer(entryFormReducer, {
    sessionId: firstSession,
    roomId: entry?.roomId ?? initialPlacement?.roomId ?? rooms[0]?.id ?? "",
    trackIds: entry?.trackIds ?? [],
    startsAtLocal: entry?.startsAtLocal ?? initialPlacement?.startsAtLocal ?? `${eventStart}T09:00`,
    endsAtLocal: entry?.endsAtLocal ?? initialPlacement?.endsAtLocal ?? `${eventStart}T10:00`,
  });
  const [startDisambiguation, setStartDisambiguation] = useState<TimeDisambiguation | undefined>(
    entry?.startDisambiguation,
  );
  const [endDisambiguation, setEndDisambiguation] = useState<TimeDisambiguation | undefined>(
    entry?.endDisambiguation,
  );
  const { sessionId, roomId, trackIds, startsAtLocal, endsAtLocal } = formState;
  const submitDisabledReason = busy
    ? "Saving…"
    : !sessionId
      ? "Choose an accepted session before adding it to the draft."
      : !roomId
        ? "Choose a room before adding it to the draft."
        : endsAtLocal <= startsAtLocal
          ? "Choose an end time after the start time."
          : null;
  const trackIdSet = useMemo(() => new Set(trackIds), [trackIds]);
  const [formError, setFormError] = useState<string | null>(null);
  const [roomCreatorOpen, setRoomCreatorOpen] = useState(false);
  const [trackCreatorOpen, setTrackCreatorOpen] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [roomCapacity, setRoomCapacity] = useState("");
  const [trackName, setTrackName] = useState("");
  useEffect(() => {
    if (!entry && initialSessionId) {
      dispatchForm({ type: "session-changed", sessionId: initialSessionId });
    }
  }, [entry, initialSessionId]);

  function toggleTrack(trackId: string) {
    dispatchForm({ type: "track-toggled", trackId });
  }

  async function createRoom() {
    if (!onCreateRoom) return;
    const name = roomName.trim();
    const capacity = Number(roomCapacity);
    if (!name || !Number.isFinite(capacity) || capacity < 1) {
      setFormError("Enter a room name and capacity of at least 1.");
      return;
    }
    const room = await onCreateRoom({ name, capacity });
    if (room) {
      dispatchForm({ type: "room-changed", roomId: room.id });
      setRoomName("");
      setRoomCapacity("");
      setRoomCreatorOpen(false);
      setFormError(null);
    }
  }

  async function createTrack() {
    if (!onCreateTrack) return;
    const name = trackName.trim();
    if (!name) {
      setFormError("Enter a track name.");
      return;
    }
    const track = await onCreateTrack({ name });
    if (track) {
      dispatchForm({ type: "track-added", trackId: track.id });
      setTrackName("");
      setTrackCreatorOpen(false);
      setFormError(null);
    }
  }
  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!sessionId || !roomId) {
      setFormError("Choose an accepted session and room.");
      return;
    }
    if (endsAtLocal <= startsAtLocal) {
      setFormError("End time must be after start time.");
      return;
    }
    setFormError(null);
    await onSubmit({
      ...(entry ? { id: entry.id } : {}),
      sessionId,
      roomId,
      trackIds,
      startsAtLocal,
      endsAtLocal,
      ...(startDisambiguation === undefined ? {} : { startDisambiguation }),
      ...(endDisambiguation === undefined ? {} : { endDisambiguation }),
    });
  }

  return (
    <form className={styles.entryForm} onSubmit={(event) => void submit(event)}>
      {entry ? (
        <div className={styles.fixedSession}>
          <span>Session</span>
          <strong>{entry.title}</strong>
        </div>
      ) : (
        <label>
          <span>Accepted session</span>
          <select
            value={sessionId}
            onChange={(event) =>
              dispatchForm({ type: "session-changed", sessionId: event.target.value })
            }
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title} · {session.format} ·{" "}
                {session.speakerNames.length > 0
                  ? session.speakerNames.join(", ")
                  : "No speakers listed"}{" "}
                ({session.durationMinutes} min)
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>Room</span>
        <select
          value={roomId}
          onChange={(event) => dispatchForm({ type: "room-changed", roomId: event.target.value })}
        >
          {rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.name} ({room.capacity} seats)
            </option>
          ))}
        </select>
      </label>
      {onCreateRoom ? (
        <div className={styles.inlineCreate}>
          <button
            className={styles.textButton}
            type="button"
            onClick={() => setRoomCreatorOpen((open) => !open)}
            aria-expanded={roomCreatorOpen}
          >
            {roomCreatorOpen ? "Cancel new room" : "Create room"}
          </button>
          {roomCreatorOpen ? (
            <div className={styles.inlineCreateFields}>
              <label>
                <span>Room name</span>
                <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
              </label>
              <label>
                <span>Capacity</span>
                <input
                  type="number"
                  min={1}
                  value={roomCapacity}
                  onChange={(event) => setRoomCapacity(event.target.value)}
                />
              </label>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => void createRoom()}
              >
                Save room
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <fieldset className={styles.trackOptions}>
        <legend>Tracks (optional)</legend>
        <small>
          Tracks are optional; a known room and valid times are enough to schedule a session.
        </small>
        {tracks.map((track) => (
          <label key={track.id}>
            <input
              type="checkbox"
              checked={trackIdSet.has(track.id)}
              onChange={() => toggleTrack(track.id)}
            />
            <span style={{ "--track-color": track.color } as CSSProperties}>{track.name}</span>
          </label>
        ))}
      </fieldset>
      {onCreateTrack ? (
        <div className={styles.inlineCreate}>
          <button
            className={styles.textButton}
            type="button"
            onClick={() => setTrackCreatorOpen((open) => !open)}
            aria-expanded={trackCreatorOpen}
          >
            {trackCreatorOpen ? "Cancel new track" : "Create track"}
          </button>
          {trackCreatorOpen ? (
            <div className={styles.inlineCreateFields}>
              <label>
                <span>Track name</span>
                <input value={trackName} onChange={(event) => setTrackName(event.target.value)} />
              </label>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => void createTrack()}
              >
                Save track
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={styles.timeFields}>
        <TemporalPicker
          id={`agenda-entry-${entry?.id ?? "new"}-schedule`}
          mode="range"
          precision="date-time"
          startValue={startsAtLocal}
          endValue={endsAtLocal}
          startLabel="Starts"
          endLabel="Ends"
          eyebrow="Session schedule"
          description="Choose the session window on the calendar, then confirm the local times."
          minimumDateTime={agendaBoundaryLocal(event.startsAt, event.timeZone)}
          maximumDateTime={agendaBoundaryLocal(event.endsAt, event.timeZone)}
          allowedDates={
            event.scheduleDates?.length
              ? event.scheduleDates
              : eventDates(event.startsOn, event.endsOn)
          }
          timeZone={event.timeZone}
          startDisambiguation={startDisambiguation}
          endDisambiguation={endDisambiguation}
          onStartDisambiguationChange={setStartDisambiguation}
          onEndDisambiguationChange={setEndDisambiguation}
          clearable
          onChange={({ start, end }) => {
            dispatchForm({ type: "starts-at-changed", startsAtLocal: start });
            dispatchForm({ type: "ends-at-changed", endsAtLocal: end });
          }}
        />
      </div>
      {formError ? (
        <p className={styles.formError} role="alert">
          {formError}
        </p>
      ) : submitDisabledReason ? (
        <p className={styles.formError} role="status">
          {submitDisabledReason}
        </p>
      ) : null}
      <div className={styles.formActions}>
        {onCancel ? (
          <button className={styles.secondaryButton} type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={submitDisabledReason !== null}
        >
          {busy ? "Saving…" : entry ? "Save changes" : "Add to draft"}
        </button>
      </div>
    </form>
  );
}

type PlacementSaveResult =
  | boolean
  | undefined
  | {
      readonly saved: false;
      readonly candidateConflicts: AgendaPreview["conflicts"];
    };

type AgendaBoardWithPlacementResultProps = Omit<AgendaBoardProps, "onSaveEntry"> & {
  onSaveEntry(entry: AgendaEntryInput): Promise<PlacementSaveResult>;
};
export function placementConflictsFromSaveResult(
  result: PlacementSaveResult,
): AgendaPreview["conflicts"] {
  return typeof result === "object" ? result.candidateConflicts : [];
}

export function AgendaBoard({
  organizationId,
  data,
  preview,
  busy,
  busyOperation = null,
  statusMessage,
  error,
  initialView = "day",
  suggestionRun,
  onSaveEntry,
  onRemoveEntry,
  onPreview,
  onOverrideWarning,
  onPublish,
  onDismissError,
  onGenerateSuggestion,
  onRegenerateSuggestion,
  onRejectSuggestion,
  onApplySuggestion,
  onCreateRoom,
  onCreateTrack,
  calendarDelivery,
  onRetryCalendarDelivery,
}: AgendaBoardWithPlacementResultProps) {
  const readiness = publicationReadiness(data, preview);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [placementDraft, setPlacementDraft] = useState<AgendaTimetablePlacement | undefined>();
  const [placementSessionId, setPlacementSessionId] = useState<string | null>(null);
  const [placementConflicts, setPlacementConflicts] = useState<AgendaPreview["conflicts"]>([]);
  const [viewMode, setViewMode] = useState(initialView);
  const eventDays = useMemo(
    () =>
      agendaDays(data.draft.entries, { startsOn: data.event.startsOn, endsOn: data.event.endsOn }),
    [data.draft.entries, data.event.endsOn, data.event.startsOn],
  );
  const [selectedDay, setSelectedDay] = useState(() => eventDays[0]?.date ?? "");
  const [queueDropActive, setQueueDropActive] = useState(false);
  const [selectedSuggestionChangesByRun, setSelectedSuggestionChangesByRun] = useState<
    Record<string, readonly string[]>
  >({});
  const suggestionOwnerKey = suggestionRun?.id ?? null;
  const selectedSuggestionChanges =
    suggestionOwnerKey === null ? [] : (selectedSuggestionChangesByRun[suggestionOwnerKey] ?? []);
  const viewTabRefs = useRef<Partial<Record<typeof viewMode, HTMLButtonElement | null>>>({});
  const currentRevision = data.currentPublishedRevision;
  const editingEntry =
    editingEntryId === null
      ? null
      : (data.draft.entries.find((entry) => entry.id === editingEntryId) ?? null);
  const hasRooms = data.rooms.length > 0;
  const acceptedCount = acceptedSessionCount(data);
  const scheduledCount = data.draft.entries.length;
  const toPlaceCount = data.unscheduledSessions.length;
  const hasScheduleInventory = acceptedCount > 0 || scheduledCount > 0;
  const placementComplete = acceptedCount > 0 && toPlaceCount === 0;
  const hardConflictCount =
    preview === null ? null : preview.conflicts.length + preview.releaseConflicts.length;
  const settingsHref = `/admin/organizations/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(data.event.id)}/settings`;
  const sessionsHref = `/admin/organizations/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(data.event.id)}/sessions`;
  const isBusyFor = (operation: AgendaBusyOperation): boolean =>
    busy && (busyOperation === null || busyOperation === operation);

  useEffect(() => {
    if (!eventDays.some((day) => day.date === selectedDay))
      setSelectedDay(eventDays[0]?.date ?? "");
  }, [eventDays, selectedDay]);

  function updateSuggestionSelection(changeIds: readonly string[]) {
    if (suggestionOwnerKey === null) return;
    setSelectedSuggestionChangesByRun((current) => ({
      ...current,
      [suggestionOwnerKey]: changeIds,
    }));
  }

  function openPlacement(sessionId: string | null, placement?: AgendaTimetablePlacement) {
    setEditingEntryId(null);
    setPlacementSessionId(sessionId);
    setPlacementDraft(placement);
    setShowAddForm(true);
    setPlacementConflicts([]);
  }

  function closeEditor() {
    setShowAddForm(false);
    setPlacementSessionId(null);
    setPlacementDraft(undefined);
    setEditingEntryId(null);
    setPlacementConflicts([]);
  }

  function onScheduleSession() {
    setEditingEntryId(null);
    setPlacementSessionId(null);
    setPlacementDraft(undefined);
    setShowAddForm((current) => !current);
    setPlacementConflicts([]);
  }

  function onChooseQueuedSession(sessionId: string) {
    openPlacement(sessionId);
  }

  function onEditEntry(entryId: string) {
    setShowAddForm(false);
    setEditingEntryId(entryId);
    setPlacementConflicts([]);
  }

  function onEditCard(entryId: string) {
    const entry = data.draft.entries.find((candidate) => candidate.id === entryId);
    if (entry && viewMode !== "day") {
      setViewMode("day");
      const entryDay = eventDays.find((day) => day.date === scheduleDate(entry));
      if (entryDay) setSelectedDay(entryDay.date);
    }
    onEditEntry(entryId);
  }

  return (
    <div className={styles.workspaceRoot}>
      <a className={styles.skipLink} href="#agenda-content">
        Skip to agenda workspace
      </a>
      <div id="agenda-content" className={styles.workspace} tabIndex={-1}>
        <WorkspaceHeader
          breadcrumb={
            <WorkspaceBreadcrumb>
              <Link
                href={`/admin/organizations/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(data.event.id)}`}
              >
                {data.event.name}
              </Link>
              <span>/</span>
              <strong>Agenda</strong>
            </WorkspaceBreadcrumb>
          }
          title="Agenda"
          status={
            <StatusBadge tone={readiness.ready ? "info" : "warning"}>
              Draft v{data.draft.version}
            </StatusBadge>
          }
          description="Place accepted sessions into rooms and times, resolve conflicts, then publish."
          metadata={
            <>
              <WorkspaceMetaItem icon={<CalendarDays aria-hidden="true" />}>
                {formatScheduleDate(data.event.startsOn)}
                {data.event.endsOn === data.event.startsOn
                  ? ""
                  : ` – ${formatScheduleDate(data.event.endsOn)}`}
              </WorkspaceMetaItem>
              <WorkspaceMetaItem icon={<Clock3 aria-hidden="true" />}>
                {data.event.timeZone}
              </WorkspaceMetaItem>
              <WorkspaceMetaItem icon={<Save aria-hidden="true" />}>
                Last saved {formatRevisionTimestamp(data.draft.updatedAt)}
              </WorkspaceMetaItem>
            </>
          }
          actions={
            <Button asChild size="sm" variant="outline">
              <Link href={settingsHref}>Rooms and tracks</Link>
            </Button>
          }
        />
        {error ? (
          <div className={styles.errorBanner} role="alert">
            <div>
              <strong>Agenda request failed</strong>
              <p>{error}</p>
              <small>
                The authoritative private draft remains visible as Draft v{data.draft.version}.
              </small>
            </div>
            <button type="button" onClick={onDismissError} aria-label="Dismiss error">
              Close
            </button>
          </div>
        ) : null}
        <div className={styles.srOnly} role="status" aria-live="polite">
          {statusMessage}
        </div>
        <div className={styles.overviewBand}>
          <AgendaOverview
            acceptedCount={acceptedCount}
            scheduledCount={scheduledCount}
            toPlaceCount={toPlaceCount}
            hardConflictCount={hardConflictCount}
            publishedRevisionNumber={currentRevision?.number ?? null}
          />
        </div>
        <AgendaReleaseCenter
          data={data}
          preview={preview}
          readiness={readiness}
          busy={busy}
          busyOperation={busyOperation}
          currentRevision={currentRevision}
          calendarDelivery={calendarDelivery ?? null}
          onPreview={onPreview}
          onPublish={onPublish}
          onOverrideWarning={onOverrideWarning}
          onRetryCalendarDelivery={onRetryCalendarDelivery}
          suggestionRun={suggestionRun ?? null}
          selectedSuggestionChanges={selectedSuggestionChanges}
          onSuggestionSelectionChange={updateSuggestionSelection}
          onGenerateSuggestion={onGenerateSuggestion}
          onRegenerateSuggestion={onRegenerateSuggestion}
          onRejectSuggestion={onRejectSuggestion}
          onApplySuggestion={onApplySuggestion}
          isBusyFor={isBusyFor}
        />
        <AgendaScheduleBuilder
          preview={preview}
          sessionsHref={sessionsHref}
          showAddForm={showAddForm}
          data={data}
          hasRooms={hasRooms}
          hasScheduleInventory={hasScheduleInventory}
          placementComplete={placementComplete}
          toPlaceCount={toPlaceCount}
          busy={busy}
          viewMode={viewMode}
          eventDays={eventDays}
          selectedDay={selectedDay}
          queueDropActive={queueDropActive}
          viewTabRefs={viewTabRefs}
          onQueueDropActiveChange={setQueueDropActive}
          onScheduleSession={onScheduleSession}
          onChooseQueuedSession={onChooseQueuedSession}
          onRemoveEntry={onRemoveEntry}
          onSelectDay={setSelectedDay}
          onSelectView={setViewMode}
          onEditEntry={onEditCard}
          onMoveEntry={async (placement) => {
            const entry = data.draft.entries.find(
              (candidate) => candidate.id === placement.entryId,
            );
            if (!entry) return;
            await onSaveEntry({
              id: entry.id,
              sessionId: entry.sessionId,
              roomId: placement.roomId,
              trackIds: entry.trackIds,
              startsAtLocal: placement.startsAtLocal,
              endsAtLocal: placement.endsAtLocal,
            });
          }}
          onRequestPlacement={(placement) => openPlacement(placement.sessionId, placement)}
          onRequestSessionPlacement={(sessionId) => openPlacement(sessionId)}
        />
        <AgendaEditorDialog
          open={showAddForm || editingEntry !== null}
          showAddForm={showAddForm}
          editingEntry={editingEntry}
          {...(placementDraft === undefined ? {} : { placementDraft })}
          placementSessionId={placementSessionId}
          selectedDay={selectedDay}
          data={data}
          previewConflicts={placementConflicts}
          busy={busy}
          onClose={closeEditor}
          onCancelPlacement={() => {
            setShowAddForm(false);
            setPlacementSessionId(null);
            setPlacementDraft(undefined);
            setPlacementConflicts([]);
          }}
          onCancelEdit={() => {
            setEditingEntryId(null);
            setPlacementConflicts([]);
          }}
          onSaveEntry={async (entry) => {
            setPlacementConflicts([]);
            const saved = await onSaveEntry(entry);
            const candidateConflicts = placementConflictsFromSaveResult(saved);
            if (candidateConflicts.length > 0) setPlacementConflicts(candidateConflicts);
            return saved === false ? false : typeof saved === "object" ? false : saved;
          }}
          onRemoveEntry={onRemoveEntry}
          onCreateRoom={onCreateRoom}
          onCreateTrack={onCreateTrack}
        />
      </div>
    </div>
  );
}
interface AgendaReleaseCenterProps {
  data: AgendaWorkspaceData;
  preview: AgendaPreview | null;
  readiness: ReturnType<typeof publicationReadiness>;
  busy: boolean;
  busyOperation: AgendaBusyOperation | null;
  currentRevision: AgendaWorkspaceData["currentPublishedRevision"];
  calendarDelivery: AgendaCalendarDeliveryState | null;
  onPreview(): Promise<void>;
  onPublish(): Promise<boolean | undefined>;
  onOverrideWarning(warningId: string, reason: string): Promise<boolean | undefined>;
  onRetryCalendarDelivery: AgendaBoardProps["onRetryCalendarDelivery"];
  suggestionRun: AgendaSuggestionRunView | null;
  selectedSuggestionChanges: readonly string[];
  onSuggestionSelectionChange(changeIds: readonly string[]): void;
  onGenerateSuggestion: AgendaBoardProps["onGenerateSuggestion"];
  onRegenerateSuggestion: AgendaBoardProps["onRegenerateSuggestion"];
  onRejectSuggestion: AgendaBoardProps["onRejectSuggestion"];
  onApplySuggestion: AgendaBoardProps["onApplySuggestion"];
  isBusyFor(operation: AgendaBusyOperation): boolean;
}

function AgendaReleaseCenter({
  data,
  preview,
  readiness,
  busy,
  busyOperation,
  currentRevision,
  calendarDelivery,
  onPreview,
  onPublish,
  onOverrideWarning,
  onRetryCalendarDelivery,
  suggestionRun,
  selectedSuggestionChanges,
  onSuggestionSelectionChange,
  onGenerateSuggestion,
  onRegenerateSuggestion,
  onRejectSuggestion,
  onApplySuggestion,
  isBusyFor,
}: AgendaReleaseCenterProps) {
  const hasRooms = data.rooms.length > 0;
  const validationIsCurrent = data.validation?.draftVersion === data.draft.version;
  return (
    <section
      className={styles.releaseCenter}
      aria-label="Agenda release center"
      data-agenda-region="release"
      data-agenda-order="2"
    >
      <header className={styles.releaseCenterHeader}>
        <div>
          <p className={styles.eyebrow}>Release center</p>
          <h2>Prepare the public agenda</h2>
          <p>Validate the private draft, then publish when every requirement is clear.</p>
        </div>
        <div className={styles.releaseStatus}>
          <StatusBadge tone={readiness.ready ? "info" : "warning"}>
            Draft v{data.draft.version}
          </StatusBadge>
          <span>
            {readiness.ready
              ? "Ready to publish"
              : `${readiness.reasons.length} requirement${readiness.reasons.length === 1 ? "" : "s"} remaining`}
          </span>
        </div>
      </header>
      <div className={styles.releaseCenterGrid}>
        <section className={styles.releaseAction} aria-labelledby="validation-heading">
          <div className={styles.inspectorHeading}>
            <div>
              <p className={styles.eyebrow}>Required check</p>
              <h3 id="validation-heading">Validate draft</h3>
            </div>
            <span className={validationIsCurrent ? styles.validatedBadge : styles.draftBadge}>
              {validationIsCurrent ? "Validated" : "Needs validation"}
            </span>
          </div>
          <p>Check conflicts and release rules for draft v{data.draft.version}.</p>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={busy || data.draft.entries.length === 0}
            onClick={() => void onPreview()}
          >
            {isBusyFor("validate") ? "Checking..." : "Preview and validate"}
          </button>
          {preview ? (
            <fieldset className={styles.diffSummary}>
              <legend className={styles.srOnly}>Changes from published revision</legend>
              <span>
                <strong>{preview.diff.added}</strong> added
              </span>
              <span>
                <strong>{preview.diff.changed}</strong> changed
              </span>
              <span>
                <strong>{preview.diff.removed}</strong> removed
              </span>
            </fieldset>
          ) : null}
        </section>
        {hasRooms ? (
          <AgendaSuggestionPanel
            key={`${data.event.id}:${suggestionRun?.id ?? "none"}`}
            run={suggestionRun}
            currentDraftVersion={data.draft.version}
            busy={busy}
            busyOperation={busyOperation}
            eligibleUnscheduledCount={data.unscheduledSessions.length}
            selectedChangeIds={selectedSuggestionChanges}
            onSelectionChange={onSuggestionSelectionChange}
            onGenerate={onGenerateSuggestion}
            onRegenerate={onRegenerateSuggestion}
            onReject={onRejectSuggestion}
            onApply={onApplySuggestion}
          />
        ) : null}
        <Card className={styles.publishCard} size="sm">
          <div className={styles.inspectorHeading}>
            <div>
              <p className={styles.eyebrow}>Public release</p>
              <h3 id="publish-heading">Publish agenda</h3>
            </div>
            {currentRevision ? (
              <Badge variant="outline">Revision {currentRevision.number} live</Badge>
            ) : (
              <Badge variant="outline">Not published</Badge>
            )}
          </div>
          {!readiness.ready ? (
            <ul className={styles.readinessList} aria-label="Publication requirements">
              {readiness.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.readyMessage}>Draft v{data.draft.version} is ready to publish.</p>
          )}
          <Button
            className={styles.publishButton}
            type="button"
            disabled={busy || !readiness.ready}
            onClick={() => void onPublish()}
          >
            {isBusyFor("publish") ? "Publishing..." : "Publish agenda"}
          </Button>
          <small>
            {currentRevision
              ? `Current public revision: ${currentRevision.sessionCount} sessions, published ${formatRevisionTimestamp(currentRevision.publishedAt)}.`
              : "Publishing creates the first immutable public revision."}
          </small>
        </Card>
      </div>
      {preview?.conflicts.length ? (
        <Alert variant="destructive" className={styles.conflictPanel}>
          <AlertTitle>
            {preview.conflicts.length} hard conflict{preview.conflicts.length === 1 ? "" : "s"}
          </AlertTitle>
          <AlertDescription>
            <p>Hard conflicts block publication and cannot be overridden.</p>
            <ul>
              {preview.conflicts.map((conflict) => (
                <li key={conflict.id}>
                  <strong>{conflict.kind.replace("_", " ")}</strong>
                  <span>{conflict.message}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {preview?.releaseConflicts.length ? (
        <Alert variant="destructive" className={styles.conflictPanel}>
          <AlertTitle>
            {preview.releaseConflicts.length} released commitment conflict
            {preview.releaseConflicts.length === 1 ? "" : "s"}
          </AlertTitle>
          <AlertDescription>
            <p>Released commitment conflicts block publication until resolved.</p>
            <ul>
              {preview.releaseConflicts.map((conflict) => (
                <li key={conflict.id}>
                  <strong>{conflict.kind.replace("_", " ")}</strong>
                  <span>{conflict.message}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {preview?.warnings.length ? (
        <section className={styles.warningPanel} aria-labelledby="warnings-heading">
          <h2 id="warnings-heading">
            {preview.warnings.length} warning{preview.warnings.length === 1 ? "" : "s"}
          </h2>
          <p>Warnings require a recorded organizer reason before publication.</p>
          <ul>
            {preview.warnings.map((warning) => (
              <li key={warning.id}>
                <strong>{warning.kind}</strong>
                <span>{warning.message}</span>
                {warning.overridden ? (
                  <p className={styles.overrideRecorded}>
                    Override recorded: {warning.overrideReason}
                  </p>
                ) : (
                  <WarningOverrideForm
                    busy={busy}
                    onSubmit={(reason) =>
                      onOverrideWarning(warning.id, reason).then(() => undefined)
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {calendarDelivery ? (
        <CalendarDeliveryPanel
          calendarDelivery={calendarDelivery}
          busy={busy}
          isBusyFor={isBusyFor}
          onRetry={onRetryCalendarDelivery}
        />
      ) : null}
      {data.revisions.length > 0 ? (
        <Collapsible>
          <div className={styles.historyDisclosure}>
            <div>
              <strong>Revision history</strong>
              <small>
                {data.revisions.length} published revision{data.revisions.length === 1 ? "" : "s"}
              </small>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" type="button">
                View history
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className={styles.historyContent}>
            <ol>
              {data.revisions.map((revision) => (
                <li key={revision.id}>
                  <div>
                    <strong>Revision {revision.number}</strong>
                    {revision.current ? <Badge variant="outline">Current</Badge> : null}
                  </div>
                  <small>
                    {revision.sessionCount} sessions,{" "}
                    {formatRevisionTimestamp(revision.publishedAt)}
                  </small>
                </li>
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  );
}

function CalendarDeliveryPanel({
  calendarDelivery,
  busy,
  isBusyFor,
  onRetry,
}: {
  calendarDelivery: AgendaCalendarDeliveryState;
  busy: boolean;
  isBusyFor(operation: AgendaBusyOperation): boolean;
  onRetry: AgendaBoardProps["onRetryCalendarDelivery"];
}) {
  return (
    <div className={styles.calendarDelivery} aria-live="polite">
      <strong>Released commitment calendar delivery</strong>
      <span>Calendar: {calendarDelivery.state.replace("_", " ")}</span>
      <span>Sent last 24 hours: {calendarDelivery.sentLast24Hours}</span>
      <span>Failed last 24 hours: {calendarDelivery.failedLast24Hours}</span>
      <span>
        Last invitation:{" "}
        {calendarDelivery.lastInvitationAt
          ? formatRevisionTimestamp(calendarDelivery.lastInvitationAt)
          : "None"}
      </span>
      {calendarDelivery.lastFailure ? (
        <div role="alert">
          <span>Last failure: {calendarDelivery.lastFailure.summary}</span>
          <small>
            Committed UID and sequence are retained for repair; this does not claim delivery
            success.
          </small>
          {calendarDelivery.lastFailure.retryable && onRetry ? (
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={busy}
              onClick={() => void onRetry()}
            >
              {isBusyFor("retry-calendar-delivery") ? "Retrying..." : "Retry calendar delivery"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
interface AgendaScheduleBuilderProps {
  data: AgendaWorkspaceData;
  preview: AgendaPreview | null;
  sessionsHref: string;
  hasRooms: boolean;
  hasScheduleInventory: boolean;
  placementComplete: boolean;
  toPlaceCount: number;
  busy: boolean;
  viewMode: AgendaBoardViewMode;
  showAddForm: boolean;
  eventDays: readonly AgendaDay[];
  selectedDay: string;
  queueDropActive: boolean;
  viewTabRefs: MutableRefObject<Partial<Record<AgendaBoardViewMode, HTMLButtonElement | null>>>;
  onQueueDropActiveChange(active: boolean): void;
  onScheduleSession(): void;
  onChooseQueuedSession(sessionId: string): void;
  onRemoveEntry(entryId: string): Promise<boolean | undefined>;
  onSelectDay(date: string): void;
  onSelectView(view: AgendaBoardViewMode): void;
  onEditEntry(entryId: string): void;
  onMoveEntry(placement: AgendaTimetableMove): Promise<void>;
  onRequestPlacement(placement: AgendaTimetablePlacement): void;
  onRequestSessionPlacement(sessionId: string): void;
}

type AgendaBoardViewMode = NonNullable<AgendaBoardProps["initialView"]>;

function AgendaScheduleBuilder({
  data,
  preview,
  sessionsHref,
  hasRooms,
  hasScheduleInventory,
  placementComplete,
  toPlaceCount,
  busy,
  viewMode,
  showAddForm,
  eventDays,
  selectedDay,
  queueDropActive,
  viewTabRefs,
  onQueueDropActiveChange,
  onScheduleSession,
  onChooseQueuedSession,
  onRemoveEntry,
  onSelectDay,
  onSelectView,
  onEditEntry,
  onMoveEntry,
  onRequestPlacement,
  onRequestSessionPlacement,
}: AgendaScheduleBuilderProps) {
  return (
    <div className={styles.workspaceGrid} data-agenda-region="planner" data-agenda-order="1">
      <section className={styles.boardColumn} aria-labelledby="schedule-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Schedule builder</p>
            <h2 id="schedule-heading">Build the agenda</h2>
            <p>Choose an event day, then place accepted sessions into a room and time.</p>
          </div>
          {!hasScheduleInventory ? null : placementComplete ? (
            <div className={styles.placementComplete} data-placement-complete="true" role="status">
              <CheckCircle2 aria-hidden="true" />
              <span>
                <strong>Queue clear</strong>No sessions waiting to be placed
              </span>
            </div>
          ) : toPlaceCount > 0 ? (
            <button
              className={styles.primaryButton}
              type="button"
              disabled={busy || !hasRooms}
              onClick={onScheduleSession}
              aria-expanded={showAddForm}
              aria-controls="add-session-panel"
            >
              {showAddForm ? "Close form" : "Schedule session"}
            </button>
          ) : null}
        </div>
        {toPlaceCount > 0 && !hasRooms ? (
          <p className={styles.formError} role="status">
            Scheduling is unavailable until you create a room. Create a room before scheduling
            accepted sessions.
          </p>
        ) : null}
        {!hasScheduleInventory ? (
          <Empty className={styles.agendaEmpty} data-agenda-empty-state="no-accepted-sessions">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CalendarDays aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No accepted sessions to schedule</EmptyTitle>
              <EmptyDescription>
                Accept sessions before assigning rooms and times. Accepted sessions will appear here
                automatically.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <Link href={sessionsHref}>Open sessions</Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            {viewMode === "day" ? (
              <AgendaDaySelector
                days={eventDays.map((day) => ({
                  date: day.date,
                  label: day.label,
                  sessionCount: day.entries.length,
                }))}
                selectedDate={selectedDay}
                onSelectDate={onSelectDay}
              />
            ) : null}
            <section
              className={styles.placementDock}
              aria-label="Placement queue drop zone"
              data-agenda-drop-target="placement-queue"
              data-empty={data.unscheduledSessions.length === 0 ? "true" : undefined}
              data-active={queueDropActive ? "true" : undefined}
              onDragEnter={(event) => {
                if (event.dataTransfer.types.includes(AGENDA_ENTRY_DRAG_TYPE))
                  onQueueDropActiveChange(true);
              }}
              onDragLeave={() => onQueueDropActiveChange(false)}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(AGENDA_ENTRY_DRAG_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                onQueueDropActiveChange(false);
                const entryId = event.dataTransfer.getData(AGENDA_ENTRY_DRAG_TYPE);
                if (entryId !== "") void onRemoveEntry(entryId);
              }}
            >
              {data.unscheduledSessions.length > 0 ? (
                <AgendaPlacementQueue
                  sessions={data.unscheduledSessions}
                  busy={busy}
                  onChooseSession={onChooseQueuedSession}
                />
              ) : (
                <div className={styles.placementDockEmpty} role="status">
                  <strong>No sessions waiting to be placed</strong>
                  <span>Drag a scheduled session here to return it to the queue.</span>
                </div>
              )}
            </section>
            <AgendaScheduleView
              data={data}
              preview={preview}
              viewMode={viewMode}
              selectedDay={selectedDay}
              viewTabRefs={viewTabRefs}
              onSelectView={onSelectView}
              onEditEntry={onEditEntry}
              onMoveEntry={onMoveEntry}
              onRequestPlacement={onRequestPlacement}
              onRequestSessionPlacement={onRequestSessionPlacement}
            />
          </>
        )}
      </section>
    </div>
  );
}

interface AgendaScheduleViewProps {
  data: AgendaWorkspaceData;
  preview: AgendaPreview | null;
  viewMode: AgendaBoardViewMode;
  selectedDay: string;
  viewTabRefs: MutableRefObject<Partial<Record<AgendaBoardViewMode, HTMLButtonElement | null>>>;
  onSelectView(view: AgendaBoardViewMode): void;
  onEditEntry(entryId: string): void;
  onMoveEntry(placement: AgendaTimetableMove): Promise<void>;
  onRequestPlacement(placement: AgendaTimetablePlacement): void;
  onRequestSessionPlacement(sessionId: string): void;
}

function AgendaScheduleView({
  data,
  preview,
  viewMode,
  selectedDay,
  viewTabRefs,
  onSelectView,
  onEditEntry,
  onMoveEntry,
  onRequestPlacement,
  onRequestSessionPlacement,
}: AgendaScheduleViewProps) {
  const groups = deriveAgendaViewGroups(data, viewMode);
  function renderEntryCard(entry: AgendaEntry, key: string, showDate = false): ReactNode {
    const entryConflicts = conflictsForEntry(entry.id, preview?.conflicts ?? []);
    const entryReleaseConflicts = conflictsForEntry(entry.id, preview?.releaseConflicts ?? []);
    const entryWarnings = warningsForEntry(entry.id, preview?.warnings ?? []);
    const entryTrackIds = new Set(entry.trackIds);
    const hasIssues =
      entryConflicts.length + entryReleaseConflicts.length + entryWarnings.length > 0;
    return (
      <li key={key}>
        <article
          className={`${styles.sessionCard} ${hasIssues ? styles.sessionIssue : ""}`}
          style={
            {
              "--session-accent":
                data.tracks.find((track) => entryTrackIds.has(track.id))?.color ??
                "var(--color-border-strong)",
            } as CSSProperties
          }
        >
          <div className={styles.sessionTime}>
            {showDate ? (
              <time className={styles.entryDate} dateTime={scheduleDate(entry)}>
                {formatScheduleDate(scheduleDate(entry))}
              </time>
            ) : null}
            <time dateTime={entry.startsAtLocal}>{formatLocalTime(entry.startsAtLocal)}</time>
            <span aria-hidden="true">–</span>
            <time dateTime={entry.endsAtLocal}>{formatLocalTime(entry.endsAtLocal)}</time>
          </div>
          <div className={styles.sessionDetails}>
            <div className={styles.sessionMeta}>
              <span>{entry.format}</span>
              {entry.trackNames.map((track) => (
                <span key={track}>{track}</span>
              ))}
            </div>
            <h4>{entry.title}</h4>
            <p>{entry.speakerNames.join(", ")}</p>
            <p className={styles.roomName}>{entry.roomName}</p>
            {entryConflicts.map((conflict) => (
              <p className={styles.inlineConflict} key={conflict.id}>
                Hard conflict: {conflict.message}
              </p>
            ))}
            {entryReleaseConflicts.map((conflict) => (
              <p className={styles.inlineConflict} key={conflict.id}>
                Released commitment conflict: {conflict.message}
              </p>
            ))}
            {entryWarnings.map((warning) => (
              <p className={styles.inlineWarning} key={warning.id}>
                Warning: {warning.message}
              </p>
            ))}
          </div>
          <div className={styles.cardActions}>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => onEditEntry(entry.id)}
              aria-haspopup="dialog"
            >
              Edit
            </button>
          </div>
        </article>
      </li>
    );
  }
  function renderGroup(group: ReturnType<typeof deriveAgendaViewGroups>[number], showDate = false) {
    const headingId = `agenda-group-${safeScheduleId(group.id)}`;
    return (
      <section
        key={group.id}
        className={`${styles.day} ${styles.viewGroup}`}
        aria-labelledby={headingId}
      >
        <header className={styles.viewGroupHeader}>
          <h3 id={headingId}>{group.label}</h3>
          <span>
            {group.entries.length} session{group.entries.length === 1 ? "" : "s"}
          </span>
        </header>
        {group.entries.length === 0 ? (
          <p className={styles.viewGroupEmpty}>{group.emptyMessage}</p>
        ) : (
          <ol className={styles.sessionList}>
            {group.entries.map((entry) =>
              renderEntryCard(entry, `${group.id}-${entry.id}`, showDate),
            )}
          </ol>
        )}
      </section>
    );
  }
  function renderScheduleView() {
    if (viewMode === "list") {
      const entries = groups[0]?.entries ?? [];
      return (
        <>
          {entries.length === 0 ? (
            <div className={styles.emptySchedule}>
              <strong>No sessions scheduled yet</strong>
              <p>Add an accepted session to begin the private agenda draft.</p>
            </div>
          ) : (
            <section aria-labelledby="agenda-list-heading">
              <header className={styles.viewGroupHeader}>
                <h3 id="agenda-list-heading">All scheduled sessions</h3>
                <span>
                  {entries.length} session{entries.length === 1 ? "" : "s"}
                </span>
              </header>
              <ol className={styles.sessionList}>
                {entries.map((entry) => renderEntryCard(entry, `list-${entry.id}`, true))}
              </ol>
            </section>
          )}
        </>
      );
    }
    if (viewMode === "day") {
      const currentIndex = groups.findIndex((group) => group.id === selectedDay);
      const currentGroup = groups[currentIndex >= 0 ? currentIndex : 0];
      const conflictEntryIds = new Set(
        [...(preview?.conflicts ?? []), ...(preview?.releaseConflicts ?? [])].flatMap(
          (conflict) => conflict.entryIds,
        ),
      );
      const warningEntryIds = new Set(
        (preview?.warnings ?? []).flatMap((warning) => warning.entryIds),
      );
      return (
        <>
          {currentGroup ? (
            <AgendaTimetable
              date={currentGroup.id}
              entries={currentGroup.entries}
              rooms={data.rooms}
              sessions={data.unscheduledSessions}
              tracks={data.tracks}
              conflictEntryIds={conflictEntryIds}
              warningEntryIds={warningEntryIds}
              onEditEntry={onEditEntry}
              onMoveEntry={onMoveEntry}
              onRequestPlacement={onRequestPlacement}
            />
          ) : (
            <div className={styles.emptySchedule}>
              <strong>No event days are available</strong>
              <p>The event start and end dates do not define a navigable calendar range.</p>
            </div>
          )}
        </>
      );
    }
    if (viewMode === "week") {
      const firstDate = groups[0]?.label;
      const lastDate = groups.at(-1)?.label;
      return (
        <div className={styles.weekView}>
          <p className={styles.viewContext}>
            {firstDate && lastDate && firstDate !== lastDate
              ? `Week: ${firstDate} – ${lastDate}`
              : "Week schedule"}
          </p>
          <div className={styles.weekGroups}>{groups.map((group) => renderGroup(group))}</div>
        </div>
      );
    }
    return <div className={styles.groupedView}>{groups.map((group) => renderGroup(group))}</div>;
  }
  function moveView(event: KeyboardEvent<HTMLButtonElement>, currentView: AgendaBoardViewMode) {
    const currentIndex = AGENDA_VIEW_MODES.indexOf(currentView);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      nextIndex = (currentIndex + 1) % AGENDA_VIEW_MODES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      nextIndex = (currentIndex - 1 + AGENDA_VIEW_MODES.length) % AGENDA_VIEW_MODES.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = AGENDA_VIEW_MODES.length - 1;
    else return;
    event.preventDefault();
    const nextView = AGENDA_VIEW_MODES[nextIndex];
    if (!nextView) return;
    onSelectView(nextView);
    viewTabRefs.current[nextView]?.focus();
  }
  return (
    <>
      <div className={styles.scheduleToolbar}>
        <span id="agenda-view-label" className={styles.viewLabel}>
          Schedule view
        </span>
        <div
          className={styles.viewTablist}
          role="tablist"
          aria-labelledby="agenda-view-label"
          aria-orientation="horizontal"
        >
          {AGENDA_VIEW_MODES.map((mode) => (
            <button
              key={mode}
              id={`agenda-view-${mode}`}
              className={styles.viewTab}
              type="button"
              role="tab"
              aria-selected={viewMode === mode}
              aria-controls="agenda-view-panel"
              tabIndex={viewMode === mode ? 0 : -1}
              ref={(node) => {
                viewTabRefs.current[mode] = node;
              }}
              onClick={() => onSelectView(mode)}
              onKeyDown={(event) => moveView(event, mode)}
            >
              {agendaViewLabels[mode]}
            </button>
          ))}
        </div>
      </div>
      <div
        id="agenda-view-panel"
        className={styles.viewPanel}
        role="tabpanel"
        aria-labelledby={`agenda-view-${viewMode}`}
        aria-label="Schedule canvas"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const sessionId = event.dataTransfer.getData("text/plain");
          if (data.unscheduledSessions.some((session) => session.id === sessionId))
            onRequestSessionPlacement(sessionId);
        }}
      >
        {renderScheduleView()}
      </div>
    </>
  );
}
interface AgendaEditorDialogProps {
  open: boolean;
  showAddForm: boolean;
  editingEntry: AgendaEntry | null;
  placementDraft?: AgendaTimetablePlacement;
  placementSessionId: string | null;
  selectedDay: string;
  data: AgendaWorkspaceData;
  previewConflicts: AgendaPreview["conflicts"];
  busy: boolean;
  onClose(): void;
  onCancelPlacement(): void;
  onCancelEdit(): void;
  onSaveEntry(entry: AgendaEntryInput): Promise<boolean | undefined>;
  onRemoveEntry(entryId: string): Promise<boolean | undefined>;
  onCreateRoom: EntryFormProps["onCreateRoom"];
  onCreateTrack: EntryFormProps["onCreateTrack"];
}
export function RejectedPlacementConflicts({
  conflicts,
}: Readonly<{ conflicts: AgendaPreview["conflicts"] }>) {
  if (conflicts.length === 0) return null;
  return (
    <Alert
      variant="destructive"
      className={styles.agendaEditorConflictPanel}
      role="alert"
      aria-label="Rejected placement conflicts"
    >
      <AlertTitle>
        Placement was not saved: {conflicts.length} hard conflict
        {conflicts.length === 1 ? "" : "s"}
      </AlertTitle>
      <AlertDescription>
        <p>
          The private draft has not changed. Adjust the session, room, or time, or cancel this
          placement.
        </p>
        <ul>
          {conflicts.map((conflict) => (
            <li key={conflict.id}>
              <strong>{conflict.kind.replace("_", " ")}</strong>
              <span>{conflict.message}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export function AgendaEditorDialog({
  open,
  showAddForm,
  editingEntry,
  placementDraft,
  placementSessionId,
  selectedDay,
  data,
  previewConflicts,
  busy,
  onClose,
  onCancelPlacement,
  onCancelEdit,
  onSaveEntry,
  onRemoveEntry,
  onCreateRoom,
  onCreateTrack,
}: AgendaEditorDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className={styles.agendaEditorDialog}>
        <DialogHeader className={styles.agendaEditorHeader}>
          <div className={styles.agendaEditorHeading}>
            <div>
              <p className={styles.eyebrow}>
                {showAddForm ? "Schedule placement" : "Session placement"}
              </p>
              <DialogTitle>{showAddForm ? "Schedule a session" : "Edit placement"}</DialogTitle>
            </div>
            <Badge variant="outline">
              {showAddForm ? "Accepted session" : "Scheduled session"}
            </Badge>
          </div>
          <DialogDescription>
            {showAddForm
              ? "Choose a room and exact local time before adding this session to the private draft. Tracks are optional."
              : "Adjust this session without leaving the timetable. Changes remain private until the agenda is published."}
          </DialogDescription>
        </DialogHeader>
        <RejectedPlacementConflicts conflicts={previewConflicts} />
        <div className={styles.agendaEditorBody}>
          {showAddForm ? (
            <EntryForm
              key={
                placementDraft === undefined
                  ? (placementSessionId ?? "new-placement")
                  : `${placementDraft.sessionId}-${placementDraft.roomId}-${placementDraft.startsAtLocal}`
              }
              sessions={data.unscheduledSessions}
              rooms={data.rooms}
              tracks={data.tracks}
              event={data.event}
              eventStart={resolveAgendaPlacementDate(selectedDay, data.event.startsOn)}
              busy={busy}
              onCancel={onCancelPlacement}
              {...(placementSessionId === null ? {} : { initialSessionId: placementSessionId })}
              {...(placementDraft === undefined ? {} : { initialPlacement: placementDraft })}
              {...(onCreateRoom === undefined ? {} : { onCreateRoom })}
              {...(onCreateTrack === undefined ? {} : { onCreateTrack })}
              onSubmit={async (entry) => {
                const saved = await onSaveEntry(entry);
                if (saved !== false) onCancelPlacement();
              }}
            />
          ) : editingEntry !== null ? (
            <>
              <EntryForm
                entry={editingEntry}
                sessions={[]}
                rooms={data.rooms}
                tracks={data.tracks}
                event={data.event}
                eventStart={resolveAgendaPlacementDate(selectedDay, data.event.startsOn)}
                busy={busy}
                onCancel={onCancelEdit}
                {...(onCreateRoom === undefined ? {} : { onCreateRoom })}
                {...(onCreateTrack === undefined ? {} : { onCreateTrack })}
                onSubmit={async (entry) => {
                  const saved = await onSaveEntry(entry);
                  if (saved !== false) onCancelEdit();
                }}
              />
              <div className={styles.agendaEditorDangerZone}>
                <div>
                  <strong>Remove from this agenda draft</strong>
                  <p>The accepted session returns to the placement queue.</p>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    const removed = await onRemoveEntry(editingEntry.id);
                    if (removed !== false) onCancelEdit();
                  }}
                >
                  Remove placement
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function AgendaSuggestionPanel({
  run,
  currentDraftVersion,
  busy,
  busyOperation,
  eligibleUnscheduledCount,
  selectedChangeIds,
  onSelectionChange,
  onGenerate,
  onRegenerate,
  onReject,
  onApply,
}: AgendaSuggestionPanelProps) {
  const blockers = run?.candidateDiagnostics?.conflicts ?? [];
  const stale = run !== null && run.baseDraftVersion !== currentDraftVersion;
  const selectedChangeIdSet = useMemo(() => new Set(selectedChangeIds), [selectedChangeIds]);
  const selectedAvailableChangeIds =
    run?.diff.changes.reduce<string[]>((availableIds, change) => {
      if (selectedChangeIdSet.has(change.id)) {
        availableIds.push(change.id);
      }
      return availableIds;
    }, []) ?? [];
  const canApply =
    run?.status === "pending" &&
    !busy &&
    !stale &&
    selectedAvailableChangeIds.length > 0 &&
    blockers.length === 0 &&
    onApply !== undefined;
  const isBusyFor = (operation: AgendaBusyOperation): boolean =>
    busy && (busyOperation === undefined || busyOperation === null || busyOperation === operation);
  const [existingSessionTimes, setExistingSessionTimes] =
    useState<ExistingSessionTimesSelection>("keep");
  const [ignoreExistingRooms, setIgnoreExistingRooms] = useState(false);
  const suggestionOptionsDisabled = busy || onGenerate === undefined;
  const suggestionOwnerKey = run?.id ?? "__no-suggestion-run__";
  const [suggestionsOpenByRun, setSuggestionsOpenByRun] = useState<Record<string, boolean>>({});
  const suggestionsOpen = suggestionsOpenByRun[suggestionOwnerKey] ?? run !== null;
  function updateSuggestionsOpen(open: boolean) {
    setSuggestionsOpenByRun((current) => ({
      ...current,
      [suggestionOwnerKey]: open,
    }));
  }

  function toggleChange(changeId: string) {
    onSelectionChange(
      selectedChangeIds.includes(changeId)
        ? selectedChangeIds.filter((current) => current !== changeId)
        : [...selectedChangeIds, changeId],
    );
  }

  return (
    <Card className={styles.suggestionCard} size="sm">
      <Collapsible open={suggestionsOpen} onOpenChange={updateSuggestionsOpen}>
        <div className={styles.inspectorHeading}>
          <div>
            <p className={styles.eyebrow}>Optional advisory</p>
            <h2 id="suggestion-heading">Suggestions</h2>
          </div>
          {run ? <Badge variant="outline">Run v{run.version}</Badge> : null}
        </div>
        <CollapsibleTrigger asChild>
          <Button className={styles.suggestionToggle} variant="outline" type="button">
            {suggestionsOpen
              ? "Hide suggestions"
              : run
                ? "Review suggestions"
                : "Configure suggestions"}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className={styles.suggestionContent}>
          <p>
            Suggestions are private candidates only. They never change this draft or publish
            anything until an organizer explicitly selects and applies individual changes.
          </p>
          {run === null ? (
            <div className={styles.suggestionSetup}>
              {eligibleUnscheduledCount === 0 ? (
                <div className={styles.suggestionEmpty} role="status">
                  <strong>No eligible unscheduled sessions</strong>
                  <p>
                    No eligible unscheduled accepted sessions are currently available. Accept a
                    session before generating private placement suggestions. The current draft
                    already contains every accepted session available to this assistant.
                  </p>
                </div>
              ) : (
                <>
                  <p role="status">No advisory suggestion run has been generated.</p>
                  <div className={styles.suggestionOptions}>
                    <fieldset className={styles.scheduleOptions}>
                      <legend>Existing session times</legend>
                      <label
                        className={`${styles.scheduleOption} ${
                          existingSessionTimes === "keep" ? styles.scheduleOptionSelected : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="existing-session-times"
                          value="keep"
                          checked={existingSessionTimes === "keep"}
                          disabled={suggestionOptionsDisabled}
                          onChange={() => setExistingSessionTimes("keep")}
                        />
                        <span className={styles.scheduleOptionCopy}>
                          <strong>Keep scheduled sessions fixed</strong>
                          <small>The generator preserves their current times.</small>
                        </span>
                      </label>
                      <label
                        className={`${styles.scheduleOption} ${
                          existingSessionTimes === "move" ? styles.scheduleOptionSelected : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="existing-session-times"
                          value="move"
                          checked={existingSessionTimes === "move"}
                          disabled={suggestionOptionsDisabled}
                          onChange={() => setExistingSessionTimes("move")}
                        />
                        <span className={styles.scheduleOptionCopy}>
                          <strong>Allow scheduled sessions to move</strong>
                          <small>The generator may assign them different times.</small>
                        </span>
                      </label>
                    </fieldset>
                    <fieldset className={styles.roomOptions}>
                      <legend>Existing room occupancy</legend>
                      <label className={styles.roomOption}>
                        <input
                          type="checkbox"
                          checked={ignoreExistingRooms}
                          disabled={suggestionOptionsDisabled}
                          onChange={(event) => setIgnoreExistingRooms(event.target.checked)}
                        />
                        <span className={styles.scheduleOptionCopy}>
                          <strong>Ignore existing room occupancy when generating</strong>
                          <small>
                            The generator may place sessions in rooms that already have a scheduled
                            session.
                          </small>
                        </span>
                      </label>
                    </fieldset>
                  </div>
                  <Button
                    variant="outline"
                    type="button"
                    disabled={suggestionOptionsDisabled}
                    onClick={() =>
                      onGenerate
                        ? void onGenerate(
                            serializeAgendaSuggestionOptions(
                              existingSessionTimes,
                              ignoreExistingRooms,
                            ),
                          )
                        : undefined
                    }
                  >
                    {isBusyFor("generate-suggestion")
                      ? "Generating..."
                      : "Generate private suggestions"}
                  </Button>
                  {onGenerate === undefined ? (
                    <small>
                      Suggestion generation is unavailable until an approved provider is connected.
                    </small>
                  ) : null}
                </>
              )}
            </div>
          ) : (
            <>
              <p role="status" aria-live="polite">
                Suggestion run v{run.version} is {run.status}. Base draft revision: v
                {run.baseDraftVersion}.
              </p>
              {stale ? (
                <p className={styles.inlineConflict} role="alert">
                  The draft has changed since this run was generated. Regenerate before applying.
                </p>
              ) : null}
              <p>{run.diff.summary}</p>
              {run.status === "pending" && run.diff.changes.length === 0 ? (
                <p className={styles.suggestionEmpty} role="status">
                  No eligible unscheduled sessions produced a proposal. Accept another session or
                  regenerate after changing the schedule context.
                </p>
              ) : null}
              {run.status === "pending" && run.diff.changes.length > 0 ? (
                <fieldset className={styles.overrideForm}>
                  <legend>Choose changes for human application</legend>
                  {run.diff.changes.map((change) => (
                    <label key={change.id}>
                      <input
                        type="checkbox"
                        checked={selectedChangeIdSet.has(change.id)}
                        onChange={() => toggleChange(change.id)}
                      />
                      <span>
                        <strong>{change.kind}</strong> {change.summary}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {blockers.length > 0 ? (
                <div className={styles.conflictPanel} role="alert">
                  <strong>
                    {blockers.length} hard blocker{blockers.length === 1 ? "" : "s"} prevent
                    application
                  </strong>
                  <p>
                    Resolve blockers in the draft and regenerate. They cannot be overridden by AI.
                  </p>
                  <ul>
                    {blockers.map((blocker) => (
                      <li key={blocker.id}>{blocker.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {run.candidateDiagnostics?.warnings.length ? (
                <div className={styles.warningPanel}>
                  <strong>
                    {run.candidateDiagnostics.warnings.length} candidate warning
                    {run.candidateDiagnostics.warnings.length === 1 ? "" : "s"}
                  </strong>
                  <p>Review these private diagnostics before applying selected changes.</p>
                  <ul>
                    {run.candidateDiagnostics.warnings.map((warning) => (
                      <li key={warning.id}>{warning.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {run.status === "pending" ? (
                <div className={styles.formActions}>
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy || onRegenerate === undefined}
                    onClick={() => (onRegenerate ? void onRegenerate() : undefined)}
                  >
                    {isBusyFor("regenerate-suggestion") ? "Regenerating..." : "Regenerate"}
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy || onReject === undefined}
                    onClick={() => (onReject ? void onReject() : undefined)}
                  >
                    Reject run
                  </Button>
                  <Button
                    type="button"
                    disabled={!canApply}
                    onClick={() => (onApply ? void onApply(selectedAvailableChangeIds) : undefined)}
                  >
                    {isBusyFor("apply-suggestion") ? "Applying..." : "Apply selected changes"}
                  </Button>
                </div>
              ) : (
                <small>
                  This run is closed. Generate or regenerate a new private candidate to continue.
                </small>
              )}
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
function WarningOverrideForm({
  busy,
  onSubmit,
}: Readonly<{ busy: boolean; onSubmit(reason: string): Promise<void> }>) {
  const [reason, setReason] = useState("");
  return (
    <form
      className={styles.overrideForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim().length >= 3) {
          void onSubmit(reason.trim());
        }
      }}
    >
      <label>
        <span>Organizer override reason</span>
        <textarea
          value={reason}
          minLength={3}
          required
          rows={2}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <button
        type="submit"
        className={styles.textButton}
        disabled={busy || reason.trim().length < 3}
      >
        Record override
      </button>
    </form>
  );
}

function useScopedAgendaWorkspace({
  eventId,
  organizationId,
  scopeKey,
  api: providedApi,
}: Readonly<ScopedAgendaWorkspaceProps>) {
  const cache = useNavigationDataCache();
  const normalizedOrganizationId = organizationId.trim();
  const normalizedEventId = eventId.trim();
  const agendaApi = useMemo(
    () => createCanonicalAgendaWorkspaceApi(normalizedOrganizationId, providedApi),
    [normalizedOrganizationId, providedApi],
  );
  const workspaceCacheKey = useMemo(
    () => agendaWorkspaceCacheKey(normalizedOrganizationId, normalizedEventId),
    [normalizedEventId, normalizedOrganizationId],
  );
  const workspaceCacheTags = useMemo(
    () => agendaWorkspaceCacheTags(normalizedOrganizationId, normalizedEventId),
    [normalizedEventId, normalizedOrganizationId],
  );
  const workspaceInvalidationTags = useMemo(
    () => [`event:${normalizedEventId}`, `agenda:${normalizedEventId}`],
    [normalizedEventId],
  );
  const cachedData = cache?.peek<AgendaWorkspaceData>(workspaceCacheKey);
  const initialCachedData =
    cachedData !== undefined && agendaWorkspaceDataMatchesEvent(cachedData, normalizedEventId)
      ? cachedData
      : undefined;
  const initialSnapshot: ScopedAgendaSnapshot | null =
    initialCachedData === undefined ? null : { scopeKey, api: agendaApi, data: initialCachedData };
  const initialReadKey = useMemo(() => ({ api: agendaApi, scopeKey }), [agendaApi, scopeKey]);
  const [snapshot, setSnapshot] = useState<ScopedAgendaSnapshot | null>(() => initialSnapshot);
  const [preview, setPreview] = useState<AgendaPreview | null>(null);
  const [loading, setLoading] = useState(initialSnapshot === null);
  const [busyOperation, setBusyOperation] = useState<AgendaBusyOperation | null>(null);
  const busyOperationRef = useRef<AgendaBusyOperation | null>(null);
  const loadGenerationRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const initialReadCoordinatorRef = useRef<ScopedReadFlightCoordinator<
    object,
    AgendaWorkspaceLoadResult
  > | null>(null);
  if (initialReadCoordinatorRef.current === null) {
    initialReadCoordinatorRef.current = createScopedReadFlightCoordinator();
  }
  const initialReadCoordinator = initialReadCoordinatorRef.current;
  const busy = busyOperation !== null;
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [suggestionRun, setSuggestionRun] = useState<AgendaSuggestionRunView | null>(null);
  const activeApi = snapshot?.api ?? null;
  const data = snapshot?.data ?? null;
  const suggestionApi = suggestionApiFor(activeApi);

  function operationIsCurrent(token: AgendaAsyncScopeToken): boolean {
    return canCommitAgendaAsyncCompletion(
      token,
      scopeKey,
      operationGenerationRef.current,
      mountedRef.current,
    );
  }

  function beginOperation(operation: AgendaBusyOperation): AgendaAsyncScopeToken | null {
    if (!mountedRef.current || busyOperationRef.current !== null) return null;
    const token = { scopeKey, generation: operationGenerationRef.current + 1 };
    operationGenerationRef.current = token.generation;
    busyOperationRef.current = operation;
    setBusyOperation(operation);
    setError(null);
    setStatusMessage(null);
    return token;
  }

  function endOperation(token: AgendaAsyncScopeToken): void {
    if (!operationIsCurrent(token)) return;
    busyOperationRef.current = null;
    setBusyOperation(null);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      operationGenerationRef.current += 1;
      busyOperationRef.current = null;
    };
  }, []);
  const readWorkspace = useCallback(
    (signal?: AbortSignal, fresh = false) =>
      loadCanonicalAgendaWorkspaceWithCache(
        agendaApi,
        normalizedEventId,
        cache,
        workspaceCacheKey,
        workspaceCacheTags,
        signal,
        fresh,
      ),
    [agendaApi, cache, normalizedEventId, workspaceCacheKey, workspaceCacheTags],
  );

  const load = useCallback(
    async (
      signal?: AbortSignal,
      initialRead?: Promise<AgendaWorkspaceLoadResult>,
      fresh = false,
    ) => {
      const token = { scopeKey, generation: loadGenerationRef.current + 1 };
      loadGenerationRef.current = token.generation;
      const loadIsCurrent = () =>
        canCommitAgendaAsyncCompletion(
          token,
          scopeKey,
          loadGenerationRef.current,
          mountedRef.current,
          signal?.aborted ?? false,
        );

      if (loadIsCurrent()) {
        setLoading(true);
        setError(null);
        setStatusMessage(null);
      }
      try {
        const loaded = await (initialRead ?? readWorkspace(signal, fresh));
        if (!agendaWorkspaceDataMatchesEvent(loaded.data, eventId)) {
          throw new Error("The agenda response belongs to another event.");
        }
        const loadedPreview =
          loaded.data.validation?.draftVersion === loaded.data.draft.version
            ? await loaded.api.preview(eventId)
            : null;
        if (!loadIsCurrent()) return;
        setSnapshot({ scopeKey, api: loaded.api, data: loaded.data });
        setPreview(loadedPreview);
        setSuggestionRun(null);
        setStatusMessage(null);
      } catch (loadError) {
        if (
          loadIsCurrent() &&
          !(loadError instanceof DOMException && loadError.name === "AbortError")
        ) {
          setError(messageFrom(loadError));
        }
      } finally {
        setLoading((current) => (loadIsCurrent() ? false : current));
      }
    },
    [eventId, readWorkspace, scopeKey],
  );

  useEffect(() => {
    const cached = cache?.peek<AgendaWorkspaceData>(workspaceCacheKey);
    if (cached !== undefined && agendaWorkspaceDataMatchesEvent(cached, normalizedEventId)) return;
    const lease = initialReadCoordinator.acquire(initialReadKey, (signal) => readWorkspace(signal));
    void load(lease.signal, lease.promise);
    return () => lease.release();
  }, [
    cache,
    initialReadCoordinator,
    initialReadKey,
    load,
    normalizedEventId,
    readWorkspace,
    workspaceCacheKey,
  ]);

  async function mutate(
    operation: (activeApi: AgendaApi, current: AgendaWorkspaceData) => Promise<AgendaWorkspaceData>,
    successMessage: string,
    refreshPreview = false,
    busyKind: AgendaBusyOperation = "save",
    onPlacementCandidateConflict?: (conflicts: AgendaPreview["conflicts"]) => void,
  ): Promise<boolean> {
    const currentSnapshot = snapshot;
    if (
      currentSnapshot === null ||
      currentSnapshot.scopeKey !== scopeKey ||
      !agendaWorkspaceDataMatchesEvent(currentSnapshot.data, eventId)
    ) {
      return false;
    }
    const token = beginOperation(busyKind);
    if (token === null) return false;
    loadGenerationRef.current += 1;
    cache?.invalidate(workspaceInvalidationTags);
    try {
      const nextData = await operation(currentSnapshot.api, currentSnapshot.data);
      if (!agendaWorkspaceDataMatchesEvent(nextData, eventId)) {
        throw new Error("The agenda mutation returned data for another event.");
      }
      if (!operationIsCurrent(token)) return false;
      setSnapshot({ ...currentSnapshot, data: nextData });
      cache?.write(workspaceCacheKey, nextData, workspaceCacheTags);
      if (refreshPreview) {
        const nextPreview = await currentSnapshot.api.preview(eventId);
        if (!operationIsCurrent(token)) return false;
        setPreview(nextPreview);
      } else {
        setPreview(null);
      }
      setStatusMessage(successMessage);
      return true;
    } catch (mutationError) {
      if (!operationIsCurrent(token)) return false;
      setError(messageFrom(mutationError));
      if (mutationError instanceof AgendaApiError) {
        setSuggestionRun((current) =>
          current
            ? {
                ...current,
                candidateDiagnostics: mutationError.candidateDiagnostics?.report ?? {
                  conflicts: [],
                  warnings: [],
                },
              }
            : current,
        );
        await recoverPlacementFailure(
          mutationError,
          async (candidatePreview) => {
            const recoveredData = await currentSnapshot.api.getWorkspace(eventId);
            const recoveredPreview =
              candidatePreview ??
              (recoveredData.validation?.draftVersion === recoveredData.draft.version
                ? await currentSnapshot.api.preview(eventId)
                : null);
            if (
              operationIsCurrent(token) &&
              agendaWorkspaceDataMatchesEvent(recoveredData, eventId)
            ) {
              setSnapshot({ ...currentSnapshot, data: recoveredData });
              setPreview(recoveredPreview);
              cache?.write(workspaceCacheKey, recoveredData, workspaceCacheTags);
            }
          },
          (conflicts) => onPlacementCandidateConflict?.(conflicts),
          (recoveryError) => {
            if (operationIsCurrent(token)) setError(messageFrom(recoveryError));
          },
        );
      }
      return false;
    } finally {
      endOperation(token);
    }
  }

  async function generateSuggestion(options: AgendaSuggestionOptions) {
    const currentSnapshot = snapshot;
    if (
      currentSnapshot === null ||
      currentSnapshot.scopeKey !== scopeKey ||
      !agendaWorkspaceDataMatchesEvent(currentSnapshot.data, eventId)
    ) {
      return;
    }
    const token = beginOperation("generate-suggestion");
    if (token === null) return;
    try {
      const currentSuggestionApi = suggestionApiFor(currentSnapshot.api);
      if (!currentSuggestionApi) {
        throw new Error("Private suggestion generation is unavailable for this agenda.");
      }
      const dates = eventScheduleDates(currentSnapshot.data.event);
      const run = await currentSuggestionApi.generateSuggestion({
        eventId,
        baseDraftVersion: currentSnapshot.data.draft.version,
        dates,
        eligibleStatuses: ["accepted"],
        roomIds: currentSnapshot.data.rooms.map((room) => room.id),
        dayWindows: dates.map((date) => ({
          date,
          startLocal: "09:00",
          endLocal: "17:00",
        })),
        orderedRules: [],
        ignoreExistingTimes: options.ignoreExistingTimes,
        ignoreExistingRooms: options.ignoreExistingRooms,
      });
      if (!operationIsCurrent(token)) return;
      setSuggestionRun(run);
      setStatusMessage(
        `Private advisory suggestion run v${run.version} is ready for human review.`,
      );
    } catch (suggestionError) {
      if (operationIsCurrent(token)) setError(messageFrom(suggestionError));
    } finally {
      endOperation(token);
    }
  }

  async function regenerateSuggestion() {
    const currentSnapshot = snapshot;
    const currentRun = suggestionRun;
    if (
      currentSnapshot === null ||
      currentRun === null ||
      currentSnapshot.scopeKey !== scopeKey ||
      !agendaWorkspaceDataMatchesEvent(currentSnapshot.data, eventId)
    ) {
      return;
    }
    const token = beginOperation("regenerate-suggestion");
    if (token === null) return;
    try {
      const currentSuggestionApi = suggestionApiFor(currentSnapshot.api);
      if (!currentSuggestionApi) {
        throw new Error("Private suggestion regeneration is unavailable for this agenda.");
      }
      const run = await currentSuggestionApi.regenerateSuggestion({
        eventId,
        runId: currentRun.id,
        baseDraftVersion: currentSnapshot.data.draft.version,
      });
      if (!operationIsCurrent(token)) return;
      setSuggestionRun(run);
      setStatusMessage(`Private advisory suggestion regenerated as run v${run.version}.`);
    } catch (suggestionError) {
      if (operationIsCurrent(token)) setError(messageFrom(suggestionError));
    } finally {
      endOperation(token);
    }
  }

  async function rejectSuggestion() {
    const currentSnapshot = snapshot;
    const currentRun = suggestionRun;
    if (
      currentSnapshot === null ||
      currentRun === null ||
      currentSnapshot.scopeKey !== scopeKey ||
      !agendaWorkspaceDataMatchesEvent(currentSnapshot.data, eventId)
    ) {
      return;
    }
    const token = beginOperation("reject-suggestion");
    if (token === null) return;
    try {
      const currentSuggestionApi = suggestionApiFor(currentSnapshot.api);
      if (!currentSuggestionApi) {
        throw new Error("Private suggestion rejection is unavailable for this agenda.");
      }
      const run = await currentSuggestionApi.rejectSuggestion({
        eventId,
        runId: currentRun.id,
      });
      if (!operationIsCurrent(token)) return;
      setSuggestionRun(run);
      setStatusMessage("Advisory suggestion rejected. The private draft was not changed.");
    } catch (suggestionError) {
      if (operationIsCurrent(token)) setError(messageFrom(suggestionError));
    } finally {
      endOperation(token);
    }
  }

  async function applySuggestion(changeIds: readonly string[]) {
    const currentSnapshot = snapshot;
    const currentRun = suggestionRun;
    if (
      currentSnapshot === null ||
      currentRun === null ||
      currentSnapshot.scopeKey !== scopeKey ||
      !agendaWorkspaceDataMatchesEvent(currentSnapshot.data, eventId)
    ) {
      return;
    }
    const token = beginOperation("apply-suggestion");
    if (token === null) return;
    loadGenerationRef.current += 1;
    cache?.invalidate(workspaceInvalidationTags);
    try {
      const currentSuggestionApi = suggestionApiFor(currentSnapshot.api);
      if (!currentSuggestionApi) {
        throw new Error("Private suggestion application is unavailable for this agenda.");
      }
      const nextData = await currentSuggestionApi.applySuggestion({
        eventId,
        runId: currentRun.id,
        acceptedChangeIds: changeIds,
      });
      if (!agendaWorkspaceDataMatchesEvent(nextData, eventId)) {
        throw new Error("The agenda suggestion returned data for another event.");
      }
      if (!operationIsCurrent(token)) return;
      setSnapshot({ ...currentSnapshot, data: nextData });
      cache?.write(workspaceCacheKey, nextData, workspaceCacheTags);
      setPreview(null);
      setSuggestionRun({
        ...currentRun,
        status: "applied",
        acceptedChangeIds: [...changeIds],
      });
      setStatusMessage(
        "Selected advisory changes were applied to the private draft. Nothing was published.",
      );
    } catch (suggestionError) {
      if (operationIsCurrent(token)) setError(messageFrom(suggestionError));
    } finally {
      endOperation(token);
    }
  }

  async function previewAgenda() {
    const currentSnapshot = snapshot;
    if (
      currentSnapshot === null ||
      currentSnapshot.scopeKey !== scopeKey ||
      !agendaWorkspaceDataMatchesEvent(currentSnapshot.data, eventId)
    ) {
      return;
    }
    const token = beginOperation("validate");
    if (token === null) return;
    try {
      const result = await currentSnapshot.api.validate({
        eventId,
        expectedVersion: currentSnapshot.data.draft.version,
      });
      if (!operationIsCurrent(token)) return;
      if (result.validatedAt === null) {
        throw new Error("Agenda validation did not return an authoritative timestamp.");
      }
      const nextData: AgendaWorkspaceData = {
        ...currentSnapshot.data,
        validation: {
          draftVersion: result.draftVersion,
          validatedAt: result.validatedAt,
        },
      };
      setSnapshot({ ...currentSnapshot, data: nextData });
      cache?.write(workspaceCacheKey, nextData, workspaceCacheTags);
      setPreview(result);
      setStatusMessage(
        result.conflicts.length === 0
          ? "Agenda validation completed."
          : "Agenda validation found hard conflicts.",
      );
    } catch (previewError) {
      if (!operationIsCurrent(token)) return;
      setError(messageFrom(previewError));
    } finally {
      endOperation(token);
    }
  }

  return {
    eventId,
    organizationId,
    data,
    preview,
    loading,
    busy,
    busyOperation,
    statusMessage,
    error,
    suggestionRun,
    suggestionApi,
    load,
    mutate,
    generateSuggestion,
    regenerateSuggestion,
    rejectSuggestion,
    applySuggestion,
    previewAgenda,
    dismissError: () => setError(null),
  };
}

export function ScopedAgendaWorkspace(props: Readonly<ScopedAgendaWorkspaceProps>) {
  const {
    eventId,
    organizationId,
    data,
    preview,
    loading,
    busy,
    busyOperation,
    statusMessage,
    error,
    suggestionRun,
    suggestionApi,
    load,
    mutate,
    generateSuggestion,
    regenerateSuggestion,
    rejectSuggestion,
    applySuggestion,
    previewAgenda,
    dismissError,
  } = useScopedAgendaWorkspace(props);
  if (loading && !data) {
    return (
      <div className={styles.loadingState} aria-live="polite">
        <span className={styles.loadingBar} aria-hidden="true" />
        <h1>Loading agenda workspace</h1>
        <p>Retrieving the private draft and published revision.</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={styles.loadingState}>
        <h1>Agenda workspace unavailable</h1>
        <p role="alert">{error ?? "The agenda could not be loaded."}</p>
        <button
          className={styles.primaryButton}
          type="button"
          onClick={() => void load(undefined, undefined, true)}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <AgendaBoard
      organizationId={organizationId}
      data={data}
      preview={preview}
      busy={busy}
      busyOperation={busyOperation}
      statusMessage={statusMessage}
      error={error}
      suggestionRun={suggestionRun}
      {...(suggestionApi === null
        ? {}
        : {
            onGenerateSuggestion: generateSuggestion,
            onRegenerateSuggestion: regenerateSuggestion,
            onRejectSuggestion: rejectSuggestion,
            onApplySuggestion: applySuggestion,
          })}
      onDismissError={dismissError}
      onSaveEntry={async (entry) => {
        let candidateConflicts: AgendaPreview["conflicts"] | undefined;
        const saved = await mutate(
          (activeApi, current) =>
            activeApi.saveEntry({
              eventId,
              expectedVersion: current.draft.version,
              entry,
            }),
          "Session saved to the private agenda draft.",
          false,
          "save",
          (conflicts) => {
            candidateConflicts = conflicts;
          },
        );
        return candidateConflicts === undefined ? saved : { saved: false, candidateConflicts };
      }}
      onRemoveEntry={(entryId) =>
        mutate(
          (activeApi, current) =>
            activeApi.removeEntry({
              eventId,
              entryId,
              expectedVersion: current.draft.version,
            }),
          "Session removed from the private agenda draft.",
          false,
          "remove",
        )
      }
      onPreview={previewAgenda}
      onOverrideWarning={(warningId, reason) =>
        mutate(
          (activeApi, current) =>
            activeApi.overrideWarning({
              eventId,
              expectedVersion: current.draft.version,
              warningId,
              reason,
            }),
          "Warning override recorded in the agenda audit history.",
          true,
          "override-warning",
        )
      }
      onPublish={() =>
        mutate(
          (activeApi, current) =>
            activeApi.publish({ eventId, expectedVersion: current.draft.version }),
          "Agenda revision published. Public projections are being refreshed.",
          true,
          "publish",
        )
      }
    />
  );
}
