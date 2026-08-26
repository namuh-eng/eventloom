"use client";

import { CalendarDays } from "lucide-react";
import Link from "next/link";
import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  StatusBadge,
  WorkspaceBreadcrumb,
  WorkspaceHeader,
  WorkspaceMetaItem,
  WorkspaceSurface,
} from "@/components/workspace/workspace-ui";
import { workspaceClassNames } from "@/components/workspace/workspace-ui-model";
import {
  useOrganizerEventId,
  useOrganizerEventWorkspace,
} from "@/features/admin/organizer-event-workspace";
import { useNavigationDataCache } from "@/lib/navigation-data-cache-provider";
import {
  createSessionsApi,
  type SessionContentStatus,
  type SessionHistoryEntry,
  type SessionRecord,
  type SessionSpeakerCandidate,
  type SessionSpeakerReference,
  type SessionsApi,
  type SessionTaxonomyOption,
} from "./api";
import styles from "./session-workspace.module.css";
import {
  loadSessionFormats,
  loadSessionsWorkspaceBundle,
  loadSessionTracks,
  type SessionsWorkspaceCacheBundle,
  sessionsWorkspaceCacheKey,
  sessionsWorkspaceCacheTags,
} from "./session-workspace-model";

export interface SessionsWorkspaceProps {
  readonly eventId: string;
  readonly organizationId: string;
  readonly api?: SessionsApi;
}

export interface SessionsWorkspaceViewProps {
  readonly eventId: string;
  readonly organizationId: string;
  readonly sessions: readonly SessionRecord[];
  readonly selectedSessionId: string | null;
  readonly history: readonly SessionHistoryEntry[];
  readonly speakers?: readonly SessionSpeakerCandidate[] | null;
  readonly tracks?: readonly SessionTaxonomyOption[] | null;
  readonly formats?: readonly SessionTaxonomyOption[] | null;
  readonly loading?: boolean;
  readonly loadingHistory?: boolean;
  readonly loadingSpeakers?: boolean;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly historyError?: string | null;
  readonly speakerError?: string | null;
  readonly trackError?: string | null;
  readonly formatError?: string | null;
  readonly statusMessage?: string | null;
  readonly onSelectSession?: (sessionId: string) => void;
  readonly onSave?: (input: {
    readonly sessionId: string;
    readonly expectedVersion: number;
    readonly title: string;
    readonly description: string;
    readonly trackIds: readonly string[];
    readonly formatId?: string | null;
    readonly durationMinutes: number;
  }) => Promise<boolean>;
  readonly onSetContentStatus?: (
    session: SessionRecord,
    contentStatus: SessionContentStatus,
  ) => Promise<void>;
  readonly onSaveSpeakers?: (input: {
    readonly sessionId: string;
    readonly expectedVersion: number;
    readonly speakerIds: readonly string[];
    readonly speakerRoster: readonly SessionSpeakerReference[];
  }) => Promise<void>;
  readonly onRestore?: (input: {
    readonly sessionId: string;
    readonly version: number;
    readonly expectedVersion: number;
  }) => Promise<void>;
  readonly onRetry?: () => void;
  readonly onRetrySpeakers?: () => void;
  readonly onRetryTracks?: () => void;
  readonly onRetryFormats?: () => void;
}
function sessionsHistoryCacheKey(
  organizationId: string,
  eventId: string,
  sessionId: string,
  version: number,
): string {
  return `sessions:history:${organizationId.trim()}:${eventId.trim()}:${sessionId.trim()}:v${version}`;
}
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortedError(): DOMException {
  return new DOMException("The session request was aborted.", "AbortError");
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The session request could not be completed.";
}

function displayStatus(status: SessionContentStatus | undefined): SessionContentStatus {
  return status ?? "Needs changes";
}

function statusTone(status: SessionContentStatus): "success" | "warning" {
  return status === "Approved" ? "success" : "warning";
}

function formatAction(action: SessionHistoryEntry["action"]): string {
  return action.replace(/_/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function historyActorLabel(entry: SessionHistoryEntry): string {
  const label = entry.actorLabel?.trim();
  return label && label !== entry.actorId && !label.includes("@") ? label : "Authorized organizer";
}

function historyTimestampLabel(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(timestamp);
}

function restoreAccessibleName(
  entry: SessionHistoryEntry,
  position: number,
  total: number,
): string {
  return `Restore ${formatAction(entry.action)} revision from ${historyTimestampLabel(entry.occurredAt)}, history item ${position} of ${total}`;
}

function subscribeToSessionTimestamp(): () => void {
  return () => undefined;
}

function browserSessionTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toLocaleString() : value;
}

function SessionHistoryTimestamp({ value }: Readonly<{ value: string }>) {
  return useSyncExternalStore(
    subscribeToSessionTimestamp,
    () => browserSessionTimestamp(value),
    () => value,
  );
}

function formatSpeakerRole(role: string | undefined): string {
  return role === undefined
    ? "Role not specified"
    : role.replace(/_/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function assignmentReferences(session: SessionRecord): readonly SessionSpeakerReference[] {
  const references = new Map(session.speakerRoster.map((reference) => [reference.id, reference]));
  return session.speakerIds.map((id) => references.get(id) ?? { id });
}

interface SessionEditorDraft {
  readonly ownerKey: string;
  readonly baseVersion: number;
  readonly title?: string;
  readonly description?: string;
  readonly trackIds?: readonly string[];
  readonly formatId?: string;
  readonly durationMinutes?: string;
}

interface SpeakerAssignmentsDraft {
  readonly ownerKey: string;
  readonly speakerIds: readonly string[];
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
export function sessionContentDraftIsDirty(
  session: SessionRecord,
  draft: Readonly<{
    title: string;
    description: string;
    trackIds: readonly string[];
    formatId: string;
    durationMinutes: number;
    baseVersion: number;
  }>,
): boolean {
  return (
    draft.baseVersion !== session.version ||
    draft.title !== session.title ||
    draft.description !== session.description ||
    !sameIds(draft.trackIds, session.trackIds) ||
    draft.formatId !== (session.formatId ?? "") ||
    draft.durationMinutes !== session.durationMinutes
  );
}

function SessionEditor({
  eventId,
  session,
  busy,
  onSave,
  onSetContentStatus,
  tracks,
  formats,
  trackError,
  formatError,
  onRetryTracks,
  onRetryFormats,
}: Readonly<{
  eventId: string;
  session: SessionRecord;
  busy: boolean;
  onSave?: SessionsWorkspaceViewProps["onSave"];
  onSetContentStatus?: SessionsWorkspaceViewProps["onSetContentStatus"];
  tracks: readonly SessionTaxonomyOption[] | null;
  formats: readonly SessionTaxonomyOption[] | null;
  trackError: string | null;
  formatError: string | null;
  onRetryTracks?: SessionsWorkspaceViewProps["onRetryTracks"];
  onRetryFormats?: SessionsWorkspaceViewProps["onRetryFormats"];
}>) {
  const ownerKey = `${eventId}\u0000${session.id}`;
  const [draft, setDraft] = useState<SessionEditorDraft | null>(null);
  const ownedDraft = draft?.ownerKey === ownerKey ? draft : null;
  const title = ownedDraft?.title ?? session.title;
  const description = ownedDraft?.description ?? session.description;
  const trackIds = ownedDraft?.trackIds ?? session.trackIds;
  const formatId = ownedDraft?.formatId ?? session.formatId ?? "";
  const durationMinutes = ownedDraft?.durationMinutes ?? String(session.durationMinutes);
  const parsedDurationMinutes = Number(durationMinutes);
  const rebasing = ownedDraft !== null && ownedDraft.baseVersion !== session.version;
  const changed =
    ownedDraft !== null &&
    sessionContentDraftIsDirty(session, {
      title,
      description,
      trackIds,
      formatId,
      durationMinutes: parsedDurationMinutes,
      baseVersion: ownedDraft.baseVersion,
    });
  const currentStatus = displayStatus(session.contentStatus);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !onSave ||
      !changed ||
      rebasing ||
      title.trim().length === 0 ||
      !Number.isSafeInteger(parsedDurationMinutes) ||
      parsedDurationMinutes < 1 ||
      parsedDurationMinutes > 1_440
    ) {
      return;
    }
    const saved = await onSave({
      sessionId: session.id,
      expectedVersion: session.version,
      title: title.trim(),
      description,
      trackIds,
      formatId: formatId.length === 0 ? null : formatId,
      durationMinutes: parsedDurationMinutes,
    });
    if (saved) setDraft(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Session content</CardTitle>
        <CardDescription>
          Changes create a new revision and require a fresh public-content review.
        </CardDescription>
      </CardHeader>
      <CardContent className={styles.stack}>
        <form className={styles.editorForm} onSubmit={(event) => void submit(event)}>
          <label className={styles.field} htmlFor={`session-title-${session.id}`}>
            Title
            <Input
              disabled={busy || onSave === undefined}
              id={`session-title-${session.id}`}
              required
              value={title}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => {
                  const base =
                    current?.ownerKey === ownerKey
                      ? current
                      : { ownerKey, baseVersion: session.version };
                  return { ...base, title: value };
                });
              }}
            />
          </label>
          <label className={styles.field} htmlFor={`session-description-${session.id}`}>
            Abstract
            <Textarea
              disabled={busy || onSave === undefined}
              id={`session-description-${session.id}`}
              rows={8}
              value={description}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => {
                  const base =
                    current?.ownerKey === ownerKey
                      ? current
                      : { ownerKey, baseVersion: session.version };
                  return { ...base, description: value };
                });
              }}
            />
          </label>
          <label className={styles.field} htmlFor={`session-format-${session.id}`}>
            Format
            <select
              disabled={busy || onSave === undefined || formats === null || formatError !== null}
              id={`session-format-${session.id}`}
              value={formatId}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => {
                  const base =
                    current?.ownerKey === ownerKey
                      ? current
                      : { ownerKey, baseVersion: session.version };
                  return { ...base, formatId: value };
                });
              }}
            >
              <option value="">No format</option>
              {(formats ?? []).map((format) => (
                <option key={format.id} value={format.id}>
                  {format.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field} htmlFor={`session-duration-${session.id}`}>
            Duration (minutes)
            <Input
              disabled={busy || onSave === undefined}
              id={`session-duration-${session.id}`}
              min={1}
              max={1_440}
              required
              type="number"
              value={durationMinutes}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => {
                  const base =
                    current?.ownerKey === ownerKey
                      ? current
                      : { ownerKey, baseVersion: session.version };
                  return { ...base, durationMinutes: value };
                });
              }}
            />
          </label>
          <fieldset
            className={styles.field}
            disabled={busy || onSave === undefined || tracks === null || trackError !== null}
          >
            <legend>Tracks</legend>
            {(tracks ?? []).map((track) => (
              <label htmlFor={`session-track-${session.id}-${track.id}`} key={track.id}>
                <Checkbox
                  id={`session-track-${session.id}-${track.id}`}
                  checked={trackIds.includes(track.id)}
                  onCheckedChange={(checked) => {
                    setDraft((current) => {
                      const base =
                        current?.ownerKey === ownerKey
                          ? current
                          : { ownerKey, baseVersion: session.version };
                      const currentTrackIds = base.trackIds ?? session.trackIds;
                      return {
                        ...base,
                        trackIds:
                          checked === true
                            ? [...currentTrackIds, track.id]
                            : currentTrackIds.filter((id) => id !== track.id),
                      };
                    });
                  }}
                />
                {track.name}
              </label>
            ))}
          </fieldset>
          {trackError === null ? null : (
            <Alert variant="destructive">
              <AlertTitle>Session tracks unavailable</AlertTitle>
              <AlertDescription>
                {trackError} Current track assignments are preserved while tracks are unavailable.
              </AlertDescription>
              {!onRetryTracks ? null : (
                <Button size="sm" type="button" variant="outline" onClick={onRetryTracks}>
                  Retry tracks
                </Button>
              )}
            </Alert>
          )}
          {formatError === null ? null : (
            <Alert variant="destructive">
              <AlertTitle>Session formats unavailable</AlertTitle>
              <AlertDescription>
                {formatError} The current format is preserved while formats are unavailable.
              </AlertDescription>
              {!onRetryFormats ? null : (
                <Button size="sm" type="button" variant="outline" onClick={onRetryFormats}>
                  Retry formats
                </Button>
              )}
            </Alert>
          )}
          <Button
            disabled={
              busy ||
              !changed ||
              title.trim().length === 0 ||
              !Number.isSafeInteger(parsedDurationMinutes) ||
              parsedDurationMinutes < 1 ||
              parsedDurationMinutes > 1_440 ||
              !onSave ||
              rebasing
            }
            type="submit"
          >
            {busy ? "Saving..." : "Save content"}
          </Button>
        </form>

        <section className={styles.approval} aria-labelledby={`content-approval-${session.id}`}>
          <div className={styles.approvalHeader}>
            <h3 id={`content-approval-${session.id}`}>Content approval</h3>
            <StatusBadge tone={statusTone(currentStatus)}>{currentStatus}</StatusBadge>
          </div>
          <p className={styles.muted}>
            Only approved content is eligible for public session and agenda projections.
          </p>
          <div className={styles.actions}>
            <Button
              disabled={
                busy || changed || rebasing || currentStatus === "Approved" || !onSetContentStatus
              }
              type="button"
              onClick={() => void onSetContentStatus?.(session, "Approved")}
            >
              Approve content
            </Button>
            <Button
              disabled={
                busy ||
                changed ||
                rebasing ||
                currentStatus === "Needs changes" ||
                !onSetContentStatus
              }
              type="button"
              variant="outline"
              onClick={() => void onSetContentStatus?.(session, "Needs changes")}
            >
              Mark needs changes
            </Button>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function SpeakerAssignments({
  eventId,
  organizationId,
  session,
  speakers,
  loading,
  error,
  busy,
  onSave,
  onRetry,
}: Readonly<{
  eventId: string;
  organizationId: string;
  session: SessionRecord;
  speakers: readonly SessionSpeakerCandidate[] | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onSave?: SessionsWorkspaceViewProps["onSaveSpeakers"];
  onRetry?: SessionsWorkspaceViewProps["onRetrySpeakers"];
}>) {
  const ownerKey = `${eventId}\u0000${session.id}`;
  const currentReferences = assignmentReferences(session);
  const sessionSpeakerIds = new Set(session.speakerIds);
  const candidatesById = new Map((speakers ?? []).map((speaker) => [speaker.id, speaker]));
  const options = [
    ...currentReferences.map((reference) => ({
      id: reference.id,
      displayName:
        reference.displayName ??
        candidatesById.get(reference.id)?.displayName ??
        "Speaker unavailable",
      ...(candidatesById.get(reference.id)?.jobTitle === undefined
        ? {}
        : { jobTitle: candidatesById.get(reference.id)?.jobTitle }),
      ...(candidatesById.get(reference.id)?.company === undefined
        ? {}
        : { company: candidatesById.get(reference.id)?.company }),
    })),
    ...(speakers ?? []).filter((speaker) => !sessionSpeakerIds.has(speaker.id)),
  ];
  const [draft, setDraft] = useState<SpeakerAssignmentsDraft | null>(null);
  const selectedIds = draft?.ownerKey === ownerKey ? draft.speakerIds : session.speakerIds;
  const selected = new Set(selectedIds);
  const changed =
    selectedIds.length !== session.speakerIds.length ||
    selectedIds.some((id) => !sessionSpeakerIds.has(id));

  function toggle(speakerId: string, checked: boolean) {
    setDraft((current) => {
      const base =
        current?.ownerKey === ownerKey ? current : { ownerKey, speakerIds: session.speakerIds };
      const speakerIds = checked
        ? base.speakerIds.includes(speakerId)
          ? base.speakerIds
          : [...base.speakerIds, speakerId]
        : base.speakerIds.filter((id) => id !== speakerId);
      return { ...base, speakerIds };
    });
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || !onSave) return;
    await onSave({
      sessionId: session.id,
      expectedVersion: session.version,
      speakerIds: selectedIds,
      speakerRoster: selectedIds.map((id) => {
        const candidate = candidatesById.get(id);
        const current = currentReferences.find((reference) => reference.id === id);
        return {
          id,
          ...(candidate?.displayName === undefined
            ? current?.displayName === undefined
              ? {}
              : { displayName: current.displayName }
            : { displayName: candidate.displayName }),
          ...(current?.role === undefined ? {} : { role: current.role }),
        };
      }),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Speaker assignments</CardTitle>
        <CardDescription>
          Review the assigned speakers, then add or remove people from the event roster.
        </CardDescription>
        <Button asChild size="sm" variant="outline">
          <Link
            href={`/admin/organizations/${encodeURIComponent(
              organizationId,
            )}/events/${encodeURIComponent(eventId)}/speakers`}
          >
            Add or edit speakers
          </Link>
        </Button>
      </CardHeader>
      <CardContent className={styles.stack}>
        <section
          aria-labelledby={`current-speakers-${session.id}`}
          className={styles.assignmentBlock}
        >
          <h3 id={`current-speakers-${session.id}`}>Current assignments</h3>
          {currentReferences.length === 0 ? (
            <p className={styles.muted}>No speakers are currently assigned to this session.</p>
          ) : (
            <ul className={styles.currentAssignments}>
              {currentReferences.map((reference) => {
                const candidate = candidatesById.get(reference.id);
                return (
                  <li className={styles.currentAssignment} key={reference.id}>
                    <strong>
                      {reference.displayName ?? candidate?.displayName ?? "Speaker unavailable"}
                    </strong>
                    <span className={styles.muted}>{formatSpeakerRole(reference.role)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <form className={styles.assignmentForm} onSubmit={(event) => void submit(event)}>
          <fieldset className={styles.assignmentFieldset} disabled={busy || onSave === undefined}>
            <legend>Event speaker roster</legend>
            {loading ? <p className={styles.muted}>Loading event speakers...</p> : null}
            {error === null ? null : (
              <Alert variant="destructive">
                <AlertTitle>Speaker roster unavailable</AlertTitle>
                <AlertDescription>
                  {error} Current assignments are preserved while the roster is unavailable.
                </AlertDescription>
                {!onRetry ? null : (
                  <Button size="sm" type="button" variant="outline" onClick={onRetry}>
                    Retry speaker roster
                  </Button>
                )}
              </Alert>
            )}
            {!loading && error === null && speakers !== null && speakers.length === 0 ? (
              <p className={styles.muted}>No speakers are available in this event roster.</p>
            ) : null}
            {options.length === 0 ? null : (
              <div className={styles.candidateList}>
                {options.map((speaker) => {
                  const checkboxId = `session-speaker-${session.id}-${speaker.id}`;
                  const details = [speaker.jobTitle, speaker.company].filter(Boolean).join(" at ");
                  return (
                    <div className={styles.candidateRow} key={speaker.id}>
                      <Checkbox
                        checked={selected.has(speaker.id)}
                        id={checkboxId}
                        onCheckedChange={(checked) => toggle(speaker.id, checked === true)}
                      />
                      <Label className={styles.candidateLabel} htmlFor={checkboxId}>
                        <span>{speaker.displayName}</span>
                        {details.length === 0 ? null : (
                          <span className={styles.muted}>{details}</span>
                        )}
                      </Label>
                    </div>
                  );
                })}
              </div>
            )}
          </fieldset>
          <div className={styles.assignmentActions}>
            <span className={styles.muted} aria-live="polite">
              {selectedIds.length} speaker{selectedIds.length === 1 ? "" : "s"} selected
            </span>
            <Button disabled={busy || !changed || !onSave} type="submit">
              {busy ? "Saving..." : "Save speaker assignments"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SessionHistory({
  session,
  entries,
  busy,
  loading,
  error,
  onRestore,
}: Readonly<{
  session: SessionRecord;
  entries: readonly SessionHistoryEntry[];
  busy: boolean;
  loading: boolean;
  error: string | null;
  onRestore?: SessionsWorkspaceViewProps["onRestore"];
}>) {
  return (
    <WorkspaceSurface
      title="Change history"
      description="Every saved revision remains available for review and restoration."
    >
      {loading ? <p className={styles.muted}>Loading session history...</p> : null}
      {error === null ? null : <Alert variant="destructive">{error}</Alert>}
      {!loading && error === null && entries.length === 0 ? (
        <p className={styles.muted}>No session history was returned.</p>
      ) : null}

      <ol className={styles.historyList}>
        {entries.map((entry, index) => {
          const current = entry.version === session.version;
          const restorable = entry.snapshot !== undefined && entry.version < session.version;
          return (
            <li className={styles.historyItem} key={entry.id}>
              <div className={styles.historyHeader}>
                <div className={styles.historyCopy}>
                  <strong>{formatAction(entry.action)}</strong>
                  <span className={styles.muted}>
                    {historyActorLabel(entry)} -{" "}
                    <SessionHistoryTimestamp value={entry.occurredAt} />
                  </span>
                </div>
                {current ? <StatusBadge tone="info">Current</StatusBadge> : null}
                {!restorable ? null : (
                  <Button
                    aria-label={restoreAccessibleName(entry, index + 1, entries.length)}
                    disabled={busy || !onRestore}
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void onRestore?.({
                        sessionId: session.id,
                        version: entry.version,
                        expectedVersion: session.version,
                      })
                    }
                  >
                    Restore this revision
                  </Button>
                )}
              </div>

              {entry.snapshot === undefined ? null : (
                <div className={styles.snapshot}>
                  <span>
                    <strong>Title: </strong>
                    {entry.snapshot.title}
                  </span>
                  <span className={styles.snapshotDescription}>{entry.snapshot.description}</span>
                </div>
              )}
              <details className={styles.auditDetails}>
                <summary>Advanced audit details</summary>
                <dl>
                  <div>
                    <dt>Actor reference</dt>
                    <dd>
                      <code>{entry.actorId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Stored revision</dt>
                    <dd>{entry.version}</dd>
                  </div>
                </dl>
              </details>
            </li>
          );
        })}
      </ol>
    </WorkspaceSurface>
  );
}

export function SessionsWorkspaceView({
  eventId,
  organizationId,
  sessions,
  selectedSessionId,
  history,
  speakers = null,
  tracks = null,
  formats = null,
  loading = false,
  loadingHistory = false,
  loadingSpeakers = false,
  busy = false,
  error = null,
  historyError = null,
  speakerError = null,
  trackError = null,
  formatError = null,
  statusMessage = null,
  onSelectSession,
  onSave,
  onSetContentStatus,
  onSaveSpeakers,
  onRestore,
  onRetry,
  onRetrySpeakers,
  onRetryTracks,
  onRetryFormats,
}: Readonly<SessionsWorkspaceViewProps>) {
  const event = useOrganizerEventWorkspace();
  const eventName = event?.id === eventId ? event.name : undefined;
  const selected = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const empty = !loading && error === null && sessions.length === 0;

  return (
    <main className={`${workspaceClassNames.page} ${styles.workspace}`}>
      <WorkspaceHeader
        breadcrumb={
          <WorkspaceBreadcrumb>
            <span>Event content</span>
            <span aria-hidden="true">/</span>
            <span>Sessions</span>
          </WorkspaceBreadcrumb>
        }
        description="Edit canonical session copy, review public-content readiness, and restore prior revisions."
        metadata={
          <>
            <WorkspaceMetaItem>{sessions.length} sessions</WorkspaceMetaItem>
            {eventName === undefined ? null : (
              <WorkspaceMetaItem>Event {eventName}</WorkspaceMetaItem>
            )}
          </>
        }
        title="Sessions"
      />

      <div className={styles.body}>
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertTitle>Sessions unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            {!onRetry ? null : (
              <Button className="mt-3" size="sm" type="button" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            )}
          </Alert>
        )}
        {statusMessage === null ? null : (
          <Alert aria-live="polite" role="status">
            {statusMessage}
          </Alert>
        )}

        {empty ? (
          <WorkspaceSurface className={styles.emptySurface}>
            <Empty
              aria-live="polite"
              className={styles.emptyState}
              data-sessions-state="empty"
              role="status"
            >
              <EmptyHeader className={styles.emptyHeader}>
                <EmptyMedia className={styles.emptyMedia} variant="icon">
                  <CalendarDays aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle aria-level={2} className={styles.emptyTitle} role="heading">
                  No sessions yet
                </EmptyTitle>
                <EmptyDescription className={styles.emptyDescription}>
                  {eventName === undefined
                    ? "This event does not have any sessions yet."
                    : `${eventName} does not have any sessions yet.`}{" "}
                  Add sessions to the event program first, then return here to manage public copy,
                  speakers, and revision history.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </WorkspaceSurface>
        ) : (
          <div className={styles.contentGrid} data-sessions-layout="split">
            <WorkspaceSurface
              title="Session list"
              description="Choose a session to edit its canonical content and history."
            >
              {loading ? <p className={styles.muted}>Loading sessions...</p> : null}

              <ul className={styles.sessionList}>
                {sessions.map((session) => {
                  const selectedItem = session.id === selectedSessionId;
                  return (
                    <li key={session.id}>
                      <Button
                        aria-pressed={selectedItem}
                        className={styles.sessionButton}
                        type="button"
                        variant={selectedItem ? "secondary" : "ghost"}
                        onClick={() => onSelectSession?.(session.id)}
                      >
                        <span className={styles.sessionButtonCopy}>
                          <span>{session.title}</span>
                          <span className={styles.sessionButtonMeta}>
                            {session.status} - {displayStatus(session.contentStatus)}
                          </span>
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </WorkspaceSurface>

            <div className={styles.stack}>
              {selected === null ? (
                <WorkspaceSurface title="Select a session">
                  <p className={styles.muted}>
                    Choose a session to edit its content and inspect its revision history.
                  </p>
                </WorkspaceSurface>
              ) : (
                <>
                  <SessionEditor
                    eventId={eventId}
                    busy={busy}
                    key={`${eventId}\u0000${selected.id}`}
                    session={selected}
                    tracks={tracks}
                    formats={formats}
                    trackError={trackError}
                    formatError={formatError}
                    onRetryTracks={onRetryTracks}
                    onRetryFormats={onRetryFormats}
                    onSave={onSave}
                    onSetContentStatus={onSetContentStatus}
                  />
                  <SpeakerAssignments
                    eventId={eventId}
                    busy={busy}
                    error={speakerError}
                    key={`${eventId}\u0000${selected.id}`}
                    loading={loadingSpeakers}
                    organizationId={organizationId}
                    session={selected}
                    speakers={speakers}
                    onRetry={onRetrySpeakers}
                    onSave={onSaveSpeakers}
                  />
                  <SessionHistory
                    busy={busy}
                    entries={history}
                    error={historyError}
                    loading={loadingHistory}
                    session={selected}
                    onRestore={onRestore}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function ScopedSessionsWorkspace({
  eventId,
  organizationId,
  api: providedApi,
}: Readonly<SessionsWorkspaceProps>) {
  const cache = useNavigationDataCache();
  const normalizedOrganizationId = organizationId.trim();
  const normalizedEventId = eventId.trim();
  const api = useMemo(
    () => providedApi ?? createSessionsApi("", normalizedOrganizationId, normalizedEventId),
    [normalizedEventId, normalizedOrganizationId, providedApi],
  );
  const workspaceCacheKey = useMemo(
    () => sessionsWorkspaceCacheKey(normalizedOrganizationId, normalizedEventId),
    [normalizedEventId, normalizedOrganizationId],
  );
  const workspaceCacheTags = useMemo(
    () => sessionsWorkspaceCacheTags(normalizedOrganizationId, normalizedEventId),
    [normalizedEventId, normalizedOrganizationId],
  );
  const workspaceInvalidationTags = useMemo(
    () => [`event:${normalizedEventId}`, `sessions:${normalizedEventId}`],
    [normalizedEventId],
  );
  const cachedBundle = cache?.peek<SessionsWorkspaceCacheBundle>(workspaceCacheKey);
  const initialSession = cachedBundle?.sessions[0];
  const initialHistoryKey =
    initialSession !== undefined &&
    initialSession.eventId.trim() === normalizedEventId &&
    initialSession.id.trim().length > 0 &&
    Number.isSafeInteger(initialSession.version) &&
    initialSession.version >= 1
      ? sessionsHistoryCacheKey(
          normalizedOrganizationId,
          normalizedEventId,
          initialSession.id,
          initialSession.version,
        )
      : null;
  const initialHistory =
    cache === null || initialHistoryKey === null
      ? undefined
      : cache.peek<readonly SessionHistoryEntry[]>(initialHistoryKey);
  const [sessions, setSessions] = useState<readonly SessionRecord[]>(
    () => cachedBundle?.sessions ?? [],
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => initialSession?.id ?? null,
  );
  const [history, setHistory] = useState<readonly SessionHistoryEntry[]>(
    () => initialHistory ?? [],
  );
  const [loading, setLoading] = useState(cachedBundle === undefined);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [speakers, setSpeakers] = useState<readonly SessionSpeakerCandidate[] | null>(
    () => cachedBundle?.speakers ?? null,
  );
  const [tracks, setTracks] = useState<readonly SessionTaxonomyOption[] | null>(
    () => cachedBundle?.tracks ?? null,
  );
  const [formats, setFormats] = useState<readonly SessionTaxonomyOption[] | null>(
    () => cachedBundle?.formats ?? null,
  );
  const [trackError, setTrackError] = useState<string | null>(
    () => cachedBundle?.trackError ?? null,
  );
  const [formatError, setFormatError] = useState<string | null>(
    () => cachedBundle?.formatError ?? null,
  );
  const [loadingSpeakers, setLoadingSpeakers] = useState(cachedBundle === undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [speakerError, setSpeakerError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const historyGeneration = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal, fresh = false) => {
      const generation = loadGeneration.current + 1;
      loadGeneration.current = generation;
      const isCurrent = () => generation === loadGeneration.current && !signal?.aborted;
      setLoading(true);
      setLoadingSpeakers(true);
      setError(null);
      setSpeakerError(null);
      try {
        const next = await loadSessionsWorkspaceBundle(
          api,
          cache,
          workspaceCacheKey,
          workspaceCacheTags,
          signal,
          fresh,
        );
        if (!isCurrent()) return;
        setSessions(next.sessions);
        setSelectedSessionId((current) =>
          current !== null && next.sessions.some((session) => session.id === current)
            ? current
            : (next.sessions[0]?.id ?? null),
        );
        setSpeakers(next.speakers);
        if (next.trackError === null) setTracks(next.tracks);
        if (next.formatError === null) setFormats(next.formats);
        setTrackError(next.trackError);
        setFormatError(next.formatError);
      } catch (loadError) {
        if (isCurrent() && !isAbortError(loadError)) {
          const message = messageFrom(loadError);
          setError(message);
          setSpeakerError(message);
        }
      } finally {
        setLoading((current) =>
          generation === loadGeneration.current && !signal?.aborted ? false : current,
        );
        setLoadingSpeakers((current) =>
          generation === loadGeneration.current && !signal?.aborted ? false : current,
        );
      }
    },
    [api, cache, workspaceCacheKey, workspaceCacheTags],
  );

  const loadHistory = useCallback(
    async (session: SessionRecord, signal?: AbortSignal, fresh = false) => {
      const generation = historyGeneration.current + 1;
      historyGeneration.current = generation;
      const isCurrent = () => generation === historyGeneration.current && !signal?.aborted;
      const safeHistoryKey =
        session.eventId.trim() === normalizedEventId &&
        session.id.trim().length > 0 &&
        Number.isSafeInteger(session.version) &&
        session.version >= 1
          ? sessionsHistoryCacheKey(
              normalizedOrganizationId,
              normalizedEventId,
              session.id,
              session.version,
            )
          : null;
      const load = async (): Promise<readonly SessionHistoryEntry[]> => {
        const next = await api.listHistory(session.id, signal);
        if (signal?.aborted) throw abortedError();
        return next;
      };
      setLoadingHistory(true);
      setHistoryError(null);
      try {
        if (cache !== null && safeHistoryKey !== null && !fresh) {
          const cached = cache.peek<readonly SessionHistoryEntry[]>(safeHistoryKey);
          if (cached !== undefined) {
            if (isCurrent()) {
              setHistory(cached);
            }
            return;
          }
        }
        const next =
          cache !== null && safeHistoryKey !== null
            ? await cache.read({
                key: safeHistoryKey,
                tags: workspaceCacheTags,
                load,
                fresh,
              })
            : await load();
        if (isCurrent()) setHistory(next);
      } catch (loadError) {
        if (isCurrent() && !isAbortError(loadError)) {
          setHistory([]);
          setHistoryError(messageFrom(loadError));
        }
      } finally {
        setLoadingHistory((current) =>
          generation === historyGeneration.current ? false : current,
        );
      }
    },
    [api, cache, normalizedEventId, normalizedOrganizationId, workspaceCacheTags],
  );

  useEffect(() => {
    if (cache?.peek<SessionsWorkspaceCacheBundle>(workspaceCacheKey) !== undefined) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [cache, load, workspaceCacheKey]);

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  useEffect(() => {
    if (selectedSession === null) {
      const generation = historyGeneration.current + 1;
      historyGeneration.current = generation;
      try {
        setHistory([]);
        setHistoryError(null);
      } finally {
        setLoadingHistory((current) =>
          historyGeneration.current === generation ? false : current,
        );
      }
      return;
    }
    const controller = new AbortController();
    void loadHistory(selectedSession, controller.signal);
    return () => controller.abort();
  }, [loadHistory, selectedSession]);

  async function mutate(
    sessionId: string,
    request: () => Promise<SessionRecord>,
    successMessage: string,
  ): Promise<boolean> {
    if (busy) return false;
    loadGeneration.current += 1;
    historyGeneration.current += 1;
    cache?.invalidate(workspaceInvalidationTags);
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const next = await request();
      const nextSessions = sessions.map((session) => (session.id === sessionId ? next : session));
      setSessions(nextSessions);
      setSelectedSessionId(next.id);
      if (cache !== null && speakers !== null && tracks !== null && formats !== null) {
        cache.write(
          workspaceCacheKey,
          {
            sessions: nextSessions,
            speakers,
            tracks,
            formats,
            trackError,
            formatError,
          },
          workspaceCacheTags,
        );
      }
      setStatusMessage(successMessage);
      void loadHistory(next, undefined, true);
      return true;
    } catch (mutationError) {
      setError(messageFrom(mutationError));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const retryTracks = useCallback(async () => {
    const next = await loadSessionTracks(api);
    if (next.error === null) setTracks(next.options);
    setTrackError(next.error);
    const current = cache?.peek<SessionsWorkspaceCacheBundle>(workspaceCacheKey);
    if (current !== undefined) {
      cache?.write(
        workspaceCacheKey,
        {
          ...current,
          tracks: next.error === null ? next.options : current.tracks,
          trackError: next.error,
        },
        workspaceCacheTags,
      );
    }
  }, [api, cache, workspaceCacheKey, workspaceCacheTags]);

  const retryFormats = useCallback(async () => {
    const next = await loadSessionFormats(api);
    if (next.error === null) setFormats(next.options);
    setFormatError(next.error);
    const current = cache?.peek<SessionsWorkspaceCacheBundle>(workspaceCacheKey);
    if (current !== undefined) {
      cache?.write(
        workspaceCacheKey,
        {
          ...current,
          formats: next.error === null ? next.options : current.formats,
          formatError: next.error,
        },
        workspaceCacheTags,
      );
    }
  }, [api, cache, workspaceCacheKey, workspaceCacheTags]);

  return (
    <SessionsWorkspaceView
      busy={busy}
      error={error}
      eventId={eventId}
      history={history}
      historyError={historyError}
      loading={loading}
      loadingHistory={loadingHistory}
      loadingSpeakers={loadingSpeakers}
      organizationId={organizationId}
      selectedSessionId={selectedSessionId}
      sessions={sessions}
      speakerError={speakerError}
      speakers={speakers}
      tracks={tracks}
      formats={formats}
      trackError={trackError}
      formatError={formatError}
      statusMessage={statusMessage}
      onRestore={async (input) => {
        await mutate(
          input.sessionId,
          () => api.restoreVersion(input),
          "Session content restored from the selected revision.",
        );
      }}
      onRetry={() => {
        cache?.invalidate(workspaceInvalidationTags);
        void load(undefined, true);
      }}
      onRetrySpeakers={() => {
        cache?.invalidate(workspaceInvalidationTags);
        void load(undefined, true);
      }}
      onRetryTracks={() => {
        void retryTracks();
      }}
      onRetryFormats={() => {
        void retryFormats();
      }}
      onSave={(input) =>
        mutate(input.sessionId, () => api.updateContent(input), "Session content saved.")
      }
      onSaveSpeakers={async (input) => {
        await mutate(
          input.sessionId,
          () => api.updateSpeakers(input),
          "Speaker assignments saved.",
        );
      }}
      onSelectSession={(sessionId) => {
        if (sessionId !== selectedSessionId) historyGeneration.current += 1;
        setSelectedSessionId(sessionId);
      }}
      onSetContentStatus={async (session, contentStatus) => {
        await mutate(
          session.id,
          () =>
            api.updateContent({
              sessionId: session.id,
              expectedVersion: session.version,
              contentStatus,
            }),
          `Session content marked ${contentStatus}.`,
        );
      }}
    />
  );
}

export function SessionsWorkspace(props: Readonly<SessionsWorkspaceProps>) {
  const eventId = useOrganizerEventId(props.eventId);
  return (
    <ScopedSessionsWorkspace
      key={`${props.organizationId.trim()}\u0000${eventId.trim()}`}
      {...props}
      eventId={eventId}
    />
  );
}
