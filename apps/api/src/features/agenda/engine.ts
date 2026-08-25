import { detectAgendaConflicts, detectReleasedSpeakerCommitmentConflicts } from "./conflicts";
import { AgendaRepositoryConflictError } from "./infrastructure";
import {
  AgendaTimeZoneError,
  canonicalizeTimeZone,
  disambiguationForInstant,
  formatInstantInTimeZone,
  localDateInTimeZone,
  resolveLocalDateTime,
} from "./timezone";
import type {
  AcceptAgendaSuggestionChangeInput,
  AgendaAuditEntry,
  AgendaCatalog,
  AgendaClock,
  AgendaCompareAndSwapContext,
  AgendaCustomRule,
  AgendaDraft,
  AgendaEntry,
  AgendaEntryInput,
  AgendaIdGenerator,
  AgendaMutationLock,
  AgendaOutboxEvent,
  AgendaOutboxEventType,
  AgendaPreview,
  AgendaRepository,
  AgendaRoom,
  AgendaSession,
  AgendaState,
  AgendaSuggestionChange,
  AgendaSuggestionChangeKind,
  AgendaSuggestionCriteriaInput,
  AgendaSuggestionCriteriaSnapshot,
  AgendaSuggestionDayWindow,
  AgendaSuggestionDayWindowInput,
  AgendaSuggestionPlacement,
  AgendaSuggestionProvider,
  AgendaSuggestionProviderRequest,
  AgendaSuggestionProviderResult,
  AgendaSuggestionRun,
  AgendaTrack,
  AgendaValidationReport,
  AgendaWarningOverride,
  ApplyAgendaSuggestionInput,
  GenerateAgendaSuggestionInput,
  PublishedAgendaRevision,
  RegenerateAgendaSuggestionInput,
  RejectAgendaSuggestionInput,
} from "./types";

export type AgendaErrorCode =
  | "AGENDA_ALREADY_EXISTS"
  | "AGENDA_NOT_FOUND"
  | "CONCURRENT_MODIFICATION"
  | "INVALID_AGENDA"
  | "PUBLICATION_BLOCKED"
  | "REVISION_NOT_FOUND"
  | "SUGGESTION_NOT_FOUND"
  | "SUGGESTION_PROVIDER_UNAVAILABLE"
  | "SUGGESTION_INVALID"
  | "SUGGESTION_STATE_INVALID"
  | "WARNING_NOT_FOUND";

export class AgendaError extends Error {
  constructor(
    readonly code: AgendaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgendaError";
  }
}

export class AgendaValidationError extends AgendaError {
  constructor(
    message: string,
    readonly report: AgendaValidationReport,
  ) {
    super("PUBLICATION_BLOCKED", message);
    this.name = "AgendaValidationError";
  }
}

export type AgendaPublishedContentRefresh =
  | { readonly status: "not-published" | "stale"; readonly revision: null }
  | { readonly status: "created" | "unchanged"; readonly revision: PublishedAgendaRevision };

export type AgendaEntryTemporalIssueCode =
  | "after_event_end"
  | "ambiguous_local_time"
  | "before_event_start"
  | "date_not_allowed"
  | "invalid_local_date_time"
  | "invalid_time_zone"
  | "nonexistent_local_time";

export class AgendaEntryTemporalValidationError extends AgendaError {
  constructor(
    readonly entryIndex: number,
    readonly field: "startsAtLocal" | "endsAtLocal",
    readonly issueCode: AgendaEntryTemporalIssueCode,
    message: string,
  ) {
    super("INVALID_AGENDA", message);
    this.name = "AgendaEntryTemporalValidationError";
  }
}

export interface AgendaEventSchedule {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly scheduleDates?: readonly string[];
}

export function validateAgendaEntriesWithinEvent(
  entries: readonly {
    readonly startsAtLocal: string;
    readonly endsAtLocal: string;
    readonly startDisambiguation?: "earlier" | "later" | undefined;
    readonly endDisambiguation?: "earlier" | "later" | undefined;
  }[],
  event: AgendaEventSchedule,
): void {
  const eventStart = Date.parse(event.startsAt);
  const eventEnd = Date.parse(event.endsAt);
  if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd) || eventEnd < eventStart) {
    throw new AgendaError("INVALID_AGENDA", "The event schedule boundaries are invalid.");
  }
  const allowedDates = new Set(
    event.scheduleDates?.length
      ? event.scheduleDates
      : eventDateRange(
          localDateInTimeZone(event.startsAt, event.timeZone),
          localDateInTimeZone(event.endsAt, event.timeZone),
        ),
  );

  entries.forEach((entry, entryIndex) => {
    const start = resolveAgendaBoundary(
      entry.startsAtLocal,
      event.timeZone,
      entry.startDisambiguation,
      entryIndex,
      "startsAtLocal",
    );
    const end = resolveAgendaBoundary(
      entry.endsAtLocal,
      event.timeZone,
      entry.endDisambiguation,
      entryIndex,
      "endsAtLocal",
    );
    const startDate = start.localDateTime.slice(0, 10);
    const endDate = end.localDateTime.slice(0, 10);
    if (startDate !== endDate || !allowedDates.has(startDate)) {
      throw new AgendaEntryTemporalValidationError(
        entryIndex,
        "startsAtLocal",
        "date_not_allowed",
        "The agenda entry must start and end on an allowed event schedule date.",
      );
    }
    if (Date.parse(start.instant) < eventStart) {
      throw new AgendaEntryTemporalValidationError(
        entryIndex,
        "startsAtLocal",
        "before_event_start",
        "The agenda entry starts before the event begins.",
      );
    }
    if (Date.parse(end.instant) > eventEnd) {
      throw new AgendaEntryTemporalValidationError(
        entryIndex,
        "endsAtLocal",
        "after_event_end",
        "The agenda entry ends after the event finishes.",
      );
    }
  });
}

function validateStoredAgendaEntriesWithinEvent(
  entries: readonly Pick<AgendaEntry, "startsAt" | "endsAt" | "startsAtLocal" | "endsAtLocal">[],
  event: AgendaEventSchedule,
): void {
  const eventStart = Date.parse(event.startsAt);
  const eventEnd = Date.parse(event.endsAt);
  const allowedDates = new Set(
    event.scheduleDates?.length
      ? event.scheduleDates
      : eventDateRange(
          localDateInTimeZone(event.startsAt, event.timeZone),
          localDateInTimeZone(event.endsAt, event.timeZone),
        ),
  );
  entries.forEach((entry, entryIndex) => {
    const startDate = entry.startsAtLocal.slice(0, 10);
    if (startDate !== entry.endsAtLocal.slice(0, 10) || !allowedDates.has(startDate)) {
      throw new AgendaEntryTemporalValidationError(
        entryIndex,
        "startsAtLocal",
        "date_not_allowed",
        "The agenda entry must start and end on an allowed event schedule date.",
      );
    }
    if (Date.parse(entry.startsAt) < eventStart) {
      throw new AgendaEntryTemporalValidationError(
        entryIndex,
        "startsAtLocal",
        "before_event_start",
        "The agenda entry starts before the event begins.",
      );
    }
    if (Date.parse(entry.endsAt) > eventEnd) {
      throw new AgendaEntryTemporalValidationError(
        entryIndex,
        "endsAtLocal",
        "after_event_end",
        "The agenda entry ends after the event finishes.",
      );
    }
  });
}

function resolveAgendaBoundary(
  localDateTime: string,
  timeZone: string,
  disambiguation: "earlier" | "later" | undefined,
  entryIndex: number,
  field: "startsAtLocal" | "endsAtLocal",
) {
  try {
    return resolveLocalDateTime(localDateTime, timeZone, disambiguation);
  } catch (error) {
    if (!(error instanceof AgendaTimeZoneError)) throw error;
    const issueCode: AgendaEntryTemporalIssueCode =
      error.code === "AMBIGUOUS_LOCAL_TIME"
        ? "ambiguous_local_time"
        : error.code === "NONEXISTENT_LOCAL_TIME"
          ? "nonexistent_local_time"
          : error.code === "INVALID_TIME_ZONE"
            ? "invalid_time_zone"
            : "invalid_local_date_time";
    throw new AgendaEntryTemporalValidationError(entryIndex, field, issueCode, error.message);
  }
}

function eventDateRange(start: string, end: string): readonly string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    dates.push(
      `${String(cursor.getUTCFullYear()).padStart(4, "0")}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`,
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export interface CreateAgendaInput extends AgendaCatalog {
  eventId: string;
  minimumTravelMinutes: number;
  actorId: string;
}

export interface UpdateAgendaDraftInput {
  eventId: string;
  expectedVersion: number;
  entries: readonly AgendaEntryInput[];
  actorId: string;
}

export interface UpdateAgendaCatalogInput extends AgendaCatalog {
  eventId: string;
  expectedVersion: number;
  minimumTravelMinutes: number;
  actorId: string;
}

export interface OverrideAgendaWarningInput {
  eventId: string;
  expectedVersion: number;
  warningId: string;
  reason: string;
  actorId: string;
}

export interface ValidateAgendaInput {
  eventId: string;
  expectedVersion: number;
  actorId: string;
}

export interface PublishAgendaInput {
  eventId: string;
  expectedVersion: number;
  actorId: string;
}

export interface RollbackAgendaInput {
  eventId: string;
  expectedVersion: number;
  revisionId: string;
  actorId: string;
}

export interface AgendaEngineOptions {
  customRules?: readonly AgendaCustomRule[];
  clock?: AgendaClock;
  idGenerator?: AgendaIdGenerator;
  suggestionProvider?: AgendaSuggestionProvider;
  agendaSuggestionProvider?: AgendaSuggestionProvider;
  eventScheduleForEvent?: (eventId: string) => Promise<AgendaEventSchedule | null>;
}

const outboxTypes: readonly AgendaOutboxEventType[] = [
  "public-agenda.updated",
  "calendar.agenda-updated",
  "embed-cache.invalidate",
];
export class DeterministicAgendaSuggestionProvider implements AgendaSuggestionProvider {
  suggest(request: AgendaSuggestionProviderRequest): AgendaSuggestionProviderResult {
    const sessions = [...request.sessions].sort((left, right) => left.id.localeCompare(right.id));
    const rooms = request.criteria.rooms;
    const windows = request.criteria.dayWindows;
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const existingSessionIds = new Set(request.existingEntries.map((entry) => entry.sessionId));
    const placements: AgendaSuggestionPlacement[] = [];
    const occupied = request.existingEntries.map((entry) => ({
      sessionId: entry.sessionId,
      roomId: entry.roomId,
      startsAtLocal: entry.startsAtLocal,
      endsAtLocal: entry.endsAtLocal,
    }));

    for (const session of sessions) {
      if (existingSessionIds.has(session.id) && !request.criteria.ignoreExistingTimes) {
        continue;
      }
      const duration = Math.max(1, Math.min(session.durationMinutes ?? 60, 240));
      let placement: AgendaSuggestionPlacement | null = null;

      for (const window of windows) {
        const windowEnd = toMinutes(window.endLocal);
        for (
          let startMinutes = toMinutes(window.startLocal);
          startMinutes + duration <= windowEnd;
        ) {
          const endMinutes = startMinutes + duration;
          const startsAtLocal = `${window.date}T${formatMinutes(startMinutes)}`;
          const endsAtLocal = `${window.date}T${formatMinutes(endMinutes)}`;
          for (const room of rooms) {
            const overlaps = occupied.some((entry) => {
              if (entry.startsAtLocal.slice(0, 10) !== window.date) {
                return false;
              }
              const entryStartMinutes = toMinutes(entry.startsAtLocal.slice(11, 16));
              const entryEndMinutes = toMinutes(entry.endsAtLocal.slice(11, 16));
              if (startMinutes >= entryEndMinutes || endMinutes <= entryStartMinutes) return false;
              if (!request.criteria.ignoreExistingRooms && entry.roomId === room.id) return true;
              const existingSession = sessionsById.get(entry.sessionId);
              if (existingSession === undefined) return false;
              return (
                session.participantIds.some((id) => existingSession.participantIds.includes(id)) ||
                session.resourceIds.some((id) => existingSession.resourceIds.includes(id))
              );
            });
            if (!overlaps) {
              placement = {
                sessionId: session.id,
                roomId: room.id,
                trackIds: [],
                startsAtLocal,
                endsAtLocal,
              };
              break;
            }
          }
          if (placement !== null) break;
          startMinutes += 30;
        }
        if (placement !== null) break;
      }
      if (placement === null) continue;
      placements.push(placement);
      occupied.push(placement);
    }
    return { placements };
  }
}

export class AgendaEngine {
  readonly #customRules: readonly AgendaCustomRule[];
  readonly #clock: AgendaClock;
  readonly #idGenerator: AgendaIdGenerator;
  readonly #suggestionProvider: AgendaSuggestionProvider | null;
  readonly #eventScheduleForEvent:
    | ((eventId: string) => Promise<AgendaEventSchedule | null>)
    | null;

  constructor(
    readonly repository: AgendaRepository,
    readonly mutationLock: AgendaMutationLock,
    options: AgendaEngineOptions = {},
  ) {
    this.#customRules = options.customRules ?? [];
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#idGenerator =
      options.idGenerator ??
      ({ nextId: (prefix) => `${prefix}_${crypto.randomUUID()}` } satisfies AgendaIdGenerator);
    this.#suggestionProvider =
      options.suggestionProvider ?? options.agendaSuggestionProvider ?? null;
    this.#eventScheduleForEvent = options.eventScheduleForEvent ?? null;
  }
  private async compareAndSwap(
    eventId: string,
    expectedStateVersion: number | null,
    nextState: AgendaState,
    context: AgendaCompareAndSwapContext,
  ): Promise<void> {
    await this.repository.compareAndSwap(eventId, expectedStateVersion, nextState, context);
  }

  async createAgenda(input: CreateAgendaInput): Promise<AgendaDraft> {
    return this.mutationLock.runExclusive(input.eventId, async () => {
      requireNonEmpty(input.eventId, "eventId");
      requireNonEmpty(input.actorId, "actorId");
      validateMinimumTravelMinutes(input.minimumTravelMinutes);
      const catalog = normalizeCatalog(input);
      const eventSchedule = await this.requireEventSchedule(input.eventId);
      const timeZone = canonicalizeTimeZone(eventSchedule.timeZone);
      const existing = await this.repository.load(input.eventId);
      if (existing !== null) {
        throw new AgendaError(
          "AGENDA_ALREADY_EXISTS",
          `Agenda already exists for event ${input.eventId}`,
        );
      }

      const now = this.now();
      const draft: AgendaDraft = {
        eventId: input.eventId,
        version: 1,
        timeZone,
        entries: [],
        warningOverrides: [],
        updatedAt: now,
        updatedBy: input.actorId,
      };
      const state: AgendaState = {
        eventId: input.eventId,
        stateVersion: 1,
        timeZone,
        minimumTravelMinutes: input.minimumTravelMinutes,
        ...catalog,
        draft,
        revisions: [],
        currentPublishedRevisionId: null,
        outbox: [],
        audit: [this.audit(input.eventId, input.actorId, "agenda.created", now, {})],
        suggestionRuns: [],
      };
      await this.compareAndSwap(input.eventId, null, state, {
        priorState: existing,
      });
      return structuredClone(draft);
    });
  }

  async getDraft(eventId: string): Promise<AgendaDraft> {
    return (await this.requireState(eventId)).draft;
  }

  async getPublishedAgenda(eventId: string): Promise<PublishedAgendaRevision | null> {
    const state = await this.requireState(eventId);
    if (state.currentPublishedRevisionId === null) {
      return null;
    }
    return (
      state.revisions.find((revision) => revision.id === state.currentPublishedRevisionId) ?? null
    );
  }
  async getPublishedAgendaRevision(
    eventId: string,
    revisionNumber: number,
  ): Promise<PublishedAgendaRevision | null> {
    const state = await this.requireState(eventId);
    return state.revisions.find((revision) => revision.revisionNumber === revisionNumber) ?? null;
  }

  async getOutbox(eventId: string): Promise<readonly AgendaOutboxEvent[]> {
    return (await this.requireState(eventId)).outbox;
  }

  async getAudit(eventId: string): Promise<readonly AgendaAuditEntry[]> {
    return (await this.requireState(eventId)).audit;
  }
  async getSuggestionRuns(eventId: string): Promise<readonly AgendaSuggestionRun[]> {
    return structuredClone((await this.requireState(eventId)).suggestionRuns ?? []);
  }

  async getSuggestion(eventId: string, runId: string): Promise<AgendaSuggestionRun> {
    const run = (await this.requireState(eventId)).suggestionRuns?.find(
      (candidate) => candidate.id === runId,
    );
    if (run === undefined) {
      throw new AgendaError("SUGGESTION_NOT_FOUND", `Agenda suggestion run not found: ${runId}`);
    }
    return structuredClone(run);
  }
  async getSuggestionRun(eventId: string, runId: string): Promise<AgendaSuggestionRun> {
    return this.getSuggestion(eventId, runId);
  }

  async listSuggestionRuns(eventId: string): Promise<readonly AgendaSuggestionRun[]> {
    return this.getSuggestionRuns(eventId);
  }

  async generateSuggestion(input: GenerateAgendaSuggestionInput): Promise<AgendaSuggestionRun> {
    return this.mutate(input.eventId, async (state) => {
      requireNonEmpty(input.actorId, "actorId");
      const baseDraftVersion =
        input.baseDraftVersion ??
        input.baseRevision ??
        input.baseDraftRevision ??
        state.draft.version;
      assertDraftVersion(state, baseDraftVersion);
      const criteria = normalizeSuggestionCriteria(input.criteria ?? input, state);
      const run = await this.buildSuggestionRun(
        state,
        input.actorId,
        baseDraftVersion,
        criteria,
        null,
        1,
      );
      const now = this.now();
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          suggestionRuns: [...(state.suggestionRuns ?? []), run],
          audit: [
            ...state.audit,
            this.audit(state.eventId, input.actorId, "agenda.suggestion.generated", now, {
              runId: run.id,
              runVersion: run.version,
              baseDraftVersion,
            }),
          ],
        },
        result: run,
      };
    });
  }

  async generateAgendaSuggestion(
    input: GenerateAgendaSuggestionInput,
  ): Promise<AgendaSuggestionRun> {
    return this.generateSuggestion(input);
  }

  async rejectSuggestion(input: RejectAgendaSuggestionInput): Promise<AgendaSuggestionRun> {
    return this.mutate(input.eventId, async (state) => {
      requireNonEmpty(input.actorId, "actorId");
      const current = requireSuggestionRun(state, input.runId);
      assertSuggestionPending(current);
      const now = this.now();
      const run: AgendaSuggestionRun = {
        ...current,
        status: "rejected",
        rejectedAt: now,
        rejectedBy: input.actorId,
      };
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          suggestionRuns: replaceSuggestionRun(state, run),
          audit: [
            ...state.audit,
            this.audit(state.eventId, input.actorId, "agenda.suggestion.rejected", now, {
              runId: run.id,
              runVersion: run.version,
            }),
          ],
        },
        result: run,
      };
    });
  }

  async rejectAgendaSuggestion(input: RejectAgendaSuggestionInput): Promise<AgendaSuggestionRun> {
    return this.rejectSuggestion(input);
  }

  async regenerateSuggestion(input: RegenerateAgendaSuggestionInput): Promise<AgendaSuggestionRun> {
    return this.mutate(input.eventId, async (state) => {
      requireNonEmpty(input.actorId, "actorId");
      const previous = requireSuggestionRun(state, input.runId);
      assertSuggestionRegenerable(previous);
      const baseDraftVersion =
        input.baseDraftVersion ??
        input.baseRevision ??
        input.baseDraftRevision ??
        state.draft.version;
      assertDraftVersion(state, baseDraftVersion);
      if (input.expectedDraftVersion !== undefined) {
        assertDraftVersion(state, input.expectedDraftVersion);
      }
      const criteria =
        input.criteria === undefined
          ? previous.criteria
          : normalizeSuggestionCriteria(input.criteria, state);
      const run = await this.buildSuggestionRun(
        state,
        input.actorId,
        baseDraftVersion,
        criteria,
        previous.id,
        previous.version + 1,
      );
      const now = this.now();
      const superseded: AgendaSuggestionRun =
        previous.status === "pending"
          ? {
              ...previous,
              status: "superseded",
              supersededAt: now,
            }
          : previous;
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          suggestionRuns: [
            ...replaceSuggestionRun(state, superseded).filter(
              (candidate) => candidate.id !== run.id,
            ),
            run,
          ],
          audit: [
            ...state.audit,
            this.audit(state.eventId, input.actorId, "agenda.suggestion.regenerated", now, {
              runId: run.id,
              previousRunId: previous.id,
              runVersion: run.version,
              baseDraftVersion,
            }),
          ],
        },
        result: run,
      };
    });
  }

  async regenerateAgendaSuggestion(
    input: RegenerateAgendaSuggestionInput,
  ): Promise<AgendaSuggestionRun> {
    return this.regenerateSuggestion(input);
  }

  async applySuggestion(input: ApplyAgendaSuggestionInput): Promise<AgendaDraft> {
    return this.mutate(input.eventId, async (state) => {
      requireNonEmpty(input.actorId, "actorId");
      const run = requireSuggestionRun(state, input.runId);
      assertSuggestionPending(run);
      if (input.expectedDraftVersion !== undefined) {
        assertDraftVersion(state, input.expectedDraftVersion);
      }
      if (input.expectedBaseRevision !== undefined) {
        assertDraftVersion(state, input.expectedBaseRevision);
      }
      assertDraftVersion(state, run.baseDraftVersion);
      const selectedIds = selectedSuggestionChangeIds(input);
      if (selectedIds.length === 0) {
        throw new AgendaError(
          "SUGGESTION_INVALID",
          "Applying an agenda suggestion requires at least one selected change",
        );
      }
      const changes = selectedIds.map((changeId) => {
        const change = run.diff.changes.find(
          (candidate) =>
            candidate.id === changeId ||
            candidate.entryId === changeId ||
            candidate.after?.id === changeId,
        );
        if (change === undefined) {
          throw new AgendaError(
            "SUGGESTION_INVALID",
            `Agenda suggestion change not found: ${changeId}`,
          );
        }
        return change;
      });
      const entries = applySuggestionChanges(state.draft.entries, changes);
      validateStoredEntries(entries, state);
      const report = this.validationReport(state, entries);
      if (report.conflicts.length > 0) {
        throw new AgendaValidationError(
          "Applying the agenda suggestion has hard conflicts",
          report,
        );
      }

      const activeWarningIds = new Set(report.warnings.map((warning) => warning.id));
      const now = this.now();
      const draft: AgendaDraft = {
        ...state.draft,
        version: state.draft.version + 1,
        entries,
        warningOverrides: state.draft.warningOverrides.filter((override) =>
          activeWarningIds.has(override.warningId),
        ),
        updatedAt: now,
        updatedBy: input.actorId,
      };
      const appliedRun: AgendaSuggestionRun = {
        ...run,
        status: "applied",
        acceptedChangeIds: selectedIds,
        appliedChangeIds: selectedIds,
        appliedAt: now,
        appliedBy: input.actorId,
      };
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          draft,
          suggestionRuns: replaceSuggestionRun(state, appliedRun),
          audit: [
            ...state.audit,
            this.audit(state.eventId, input.actorId, "agenda.suggestion.applied", now, {
              runId: run.id,
              draftVersion: draft.version,
              acceptedChangeIds: selectedIds.join(","),
              baseDraftVersion: run.baseDraftVersion,
            }),
          ],
        },
        result: draft,
      };
    });
  }

  async applyAgendaSuggestion(input: ApplyAgendaSuggestionInput): Promise<AgendaDraft> {
    return this.applySuggestion(input);
  }
  async acceptSuggestionChange(input: AcceptAgendaSuggestionChangeInput): Promise<AgendaDraft> {
    return this.applySuggestion({
      eventId: input.eventId,
      runId: input.runId,
      actorId: input.actorId,
      acceptedChangeIds: [input.changeId],
      ...(input.expectedDraftVersion === undefined
        ? {}
        : { expectedDraftVersion: input.expectedDraftVersion }),
    });
  }

  async acceptAgendaSuggestionChange(
    input: AcceptAgendaSuggestionChangeInput,
  ): Promise<AgendaDraft> {
    return this.acceptSuggestionChange(input);
  }
  async generate(input: GenerateAgendaSuggestionInput): Promise<AgendaSuggestionRun> {
    return this.generateSuggestion(input);
  }

  async reject(input: RejectAgendaSuggestionInput): Promise<AgendaSuggestionRun> {
    return this.rejectSuggestion(input);
  }

  async regenerate(input: RegenerateAgendaSuggestionInput): Promise<AgendaSuggestionRun> {
    return this.regenerateSuggestion(input);
  }

  async apply(input: ApplyAgendaSuggestionInput): Promise<AgendaDraft> {
    return this.applySuggestion(input);
  }
  async validateEntries(
    eventId: string,
    entries: readonly AgendaEntryInput[],
  ): Promise<AgendaValidationReport> {
    const state = await this.requireState(eventId);
    const materialized = materializeEntries(entries, state);
    return this.validationReport(state, materialized);
  }

  async validate(
    input: ValidateAgendaInput,
  ): Promise<{ state: AgendaState; preview: AgendaPreview & { validatedAt: string } }> {
    return this.mutate(input.eventId, async (state) => {
      assertDraftVersion(state, input.expectedVersion);
      requireNonEmpty(input.actorId, "actorId");
      const previousValidatedAt =
        state.validatedDraftVersion === state.draft.version ? state.validatedAt : undefined;
      const validatedAt = previousValidatedAt ?? this.now();
      const preview = { ...this.previewState(state), validatedAt };
      const validatedState: AgendaState = {
        ...state,
        stateVersion: state.stateVersion + 1,
        validatedDraftVersion: state.draft.version,
        validatedAt,
        audit: [
          ...state.audit,
          this.audit(input.eventId, input.actorId, "draft.validated", validatedAt, {
            draftVersion: state.draft.version,
          }),
        ],
      };
      const result = {
        state: previousValidatedAt === undefined ? validatedState : state,
        preview,
      };
      if (previousValidatedAt !== undefined) return { state, result, changed: false };
      return {
        state: validatedState,
        result,
        changed: true,
      };
    });
  }

  async preview(eventId: string): Promise<AgendaPreview> {
    return (await this.inspectPreviewSnapshot(eventId)).preview;
  }

  async inspectPreviewSnapshot(
    eventId: string,
  ): Promise<{ state: AgendaState; preview: AgendaPreview }> {
    const state = await this.requireState(eventId);
    return { state, preview: this.previewState(state) };
  }

  async updateDraft(input: UpdateAgendaDraftInput): Promise<AgendaDraft> {
    return this.mutate(input.eventId, async (state) => {
      assertDraftVersion(state, input.expectedVersion);
      requireNonEmpty(input.actorId, "actorId");
      const entries = materializeEntries(input.entries, state);
      const nonAcceptedSessionId = firstNonAcceptedSessionId(state.sessions, entries);
      if (nonAcceptedSessionId !== null) {
        throw new AgendaError(
          "INVALID_AGENDA",
          `Only accepted sessions can be scheduled: ${nonAcceptedSessionId}`,
        );
      }
      const report = this.validationReport(state, entries);
      if (report.conflicts.length > 0) {
        throw new AgendaValidationError("Hard scheduling conflicts must be resolved", report);
      }
      const unchanged =
        entries.length === state.draft.entries.length &&
        entries.every((entry, index) => {
          const current = state.draft.entries[index];
          return current !== undefined && current.id === entry.id && entriesEqual(current, entry);
        });
      if (unchanged) {
        return { state, result: state.draft, changed: false };
      }

      const activeWarningIds = new Set(report.warnings.map((warning) => warning.id));
      const now = this.now();
      const draft: AgendaDraft = {
        ...state.draft,
        version: state.draft.version + 1,
        entries,
        warningOverrides: state.draft.warningOverrides.filter((override) =>
          activeWarningIds.has(override.warningId),
        ),
        updatedAt: now,
        updatedBy: input.actorId,
      };
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          draft,
          audit: [
            ...state.audit,
            this.audit(state.eventId, input.actorId, "draft.updated", now, {
              draftVersion: draft.version,
            }),
          ],
        },
        result: draft,
      };
    });
  }

  async updateCatalog(input: UpdateAgendaCatalogInput): Promise<AgendaDraft> {
    return this.mutate(input.eventId, async (state) => {
      assertDraftVersion(state, input.expectedVersion);
      requireNonEmpty(input.actorId, "actorId");
      validateMinimumTravelMinutes(input.minimumTravelMinutes);
      const catalog = normalizeCatalog(input);
      const synchronizedCatalog = retainScheduledSessionsAsIneligible(state, catalog);
      const entries = refreshPublishedEntries(synchronizedCatalog, state.draft.entries);
      validateStoredEntries(entries, synchronizedCatalog);
      const candidate = {
        ...state,
        minimumTravelMinutes: input.minimumTravelMinutes,
        ...synchronizedCatalog,
      };
      const report = this.validationReport(candidate, entries);
      if (report.conflicts.length > 0) {
        throw new AgendaValidationError("Catalog changes introduce hard conflicts", report);
      }

      const activeWarningIds = new Set(report.warnings.map((warning) => warning.id));
      const now = this.now();
      const draft: AgendaDraft = {
        ...state.draft,
        entries,
        version: state.draft.version + 1,
        warningOverrides: state.draft.warningOverrides.filter((override) =>
          activeWarningIds.has(override.warningId),
        ),
        updatedAt: now,
        updatedBy: input.actorId,
      };
      return {
        state: {
          ...candidate,
          stateVersion: state.stateVersion + 1,
          draft,
          audit: [
            ...state.audit,
            this.audit(state.eventId, input.actorId, "catalog.updated", now, {
              draftVersion: draft.version,
            }),
          ],
        },
        result: draft,
      };
    });
  }

  async overrideWarning(input: OverrideAgendaWarningInput): Promise<AgendaDraft> {
    return this.mutate(input.eventId, async (state) => {
      assertDraftVersion(state, input.expectedVersion);
      requireNonEmpty(input.actorId, "actorId");
      const reason = input.reason.trim();
      if (reason.length < 3) {
        throw new AgendaError("INVALID_AGENDA", "A warning override requires a reason");
      }

      const report = this.validationReport(state, state.draft.entries);
      if (!report.warnings.some((warning) => warning.id === input.warningId)) {
        throw new AgendaError("WARNING_NOT_FOUND", `Agenda warning not found: ${input.warningId}`);
      }

      const now = this.now();
      const override: AgendaWarningOverride = {
        warningId: input.warningId,
        reason,
        actorId: input.actorId,
        createdAt: now,
      };
      const draft: AgendaDraft = {
        ...state.draft,
        version: state.draft.version + 1,
        warningOverrides: [
          ...state.draft.warningOverrides.filter(
            (existing) => existing.warningId !== input.warningId,
          ),
          override,
        ],
        updatedAt: now,
        updatedBy: input.actorId,
      };
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          draft,
          audit: [
            ...state.audit,
            this.audit(state.eventId, input.actorId, "warning.overridden", now, {
              draftVersion: draft.version,
              warningId: input.warningId,
            }),
          ],
        },
        result: draft,
      };
    });
  }

  async publish(
    input: PublishAgendaInput & {
      afterPublish?: (revision: PublishedAgendaRevision) => Promise<void>;
    },
  ): Promise<PublishedAgendaRevision> {
    return this.mutate(input.eventId, async (state) => {
      assertDraftVersion(state, input.expectedVersion);
      requireNonEmpty(input.actorId, "actorId");
      const nonAcceptedSessionId = firstNonAcceptedSessionId(state.sessions, state.draft.entries);
      if (nonAcceptedSessionId !== null) {
        throw new AgendaError(
          "PUBLICATION_BLOCKED",
          `Only accepted sessions can be published: ${nonAcceptedSessionId}`,
        );
      }
      const unapprovedSessionId = firstPubliclyIneligibleSessionId(
        state.sessions,
        state.draft.entries,
      );
      if (unapprovedSessionId !== null) {
        throw new AgendaError(
          "PUBLICATION_BLOCKED",
          `Only approval-eligible sessions can be published: ${unapprovedSessionId}`,
        );
      }
      if (state.validatedDraftVersion !== state.draft.version || state.validatedAt === undefined) {
        throw new AgendaError(
          "PUBLICATION_BLOCKED",
          "Validate the exact current agenda draft before publishing.",
        );
      }
      const current = currentRevision(state);
      if (current?.sourceDraftVersion === state.draft.version) {
        return {
          state,
          result: current,
          changed: false,
          ...(input.afterPublish === undefined ? {} : { afterCommit: input.afterPublish }),
        };
      }

      const preview = this.previewState(state);
      if (
        preview.validation.conflicts.length > 0 ||
        preview.releaseValidation.conflicts.length > 0 ||
        preview.unoverriddenWarnings.length > 0
      ) {
        throw new AgendaValidationError(
          "Publication requires all conflicts to be resolved and warnings to be overridden",
          mergeValidationReports(preview.validation, preview.releaseValidation),
        );
      }

      const now = this.now();
      const revision = this.revision(state, input.actorId, now, null, state.draft);
      const outbox = this.outbox(state.eventId, revision.id, now);
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          revisions: [...state.revisions, revision],
          currentPublishedRevisionId: revision.id,
          outbox: [...state.outbox, ...outbox],
          audit: [
            ...state.audit,
            this.audit(state.eventId, input.actorId, "agenda.published", now, {
              draftVersion: state.draft.version,
              revisionId: revision.id,
            }),
          ],
        },
        result: revision,
        ...(input.afterPublish === undefined ? {} : { afterCommit: input.afterPublish }),
      };
    });
  }

  async refreshPublishedContent(input: {
    eventId: string;
    actorId: string;
    expectedCatalogVersion: number;
    catalog: AgendaCatalog;
    afterRefresh?: (refresh: AgendaPublishedContentRefresh) => Promise<void>;
  }): Promise<AgendaPublishedContentRefresh> {
    return this.mutate<AgendaPublishedContentRefresh>(input.eventId, async (state) => {
      requireNonEmpty(input.actorId, "actorId");
      if (state.draft.version !== input.expectedCatalogVersion) {
        return {
          state,
          result: { status: "stale" as const, revision: null },
          changed: false,
        };
      }
      const current = currentRevision(state);
      if (current === null) {
        return {
          state,
          result: { status: "not-published" as const, revision: null },
          changed: false,
        };
      }
      const catalog = normalizeCatalog(input.catalog);
      const entries = refreshPublishedEntries(catalog, current.entries);
      if (publishedEntriesEqual(entries, current.entries)) {
        const result = { status: "unchanged" as const, revision: current };
        return {
          state,
          result,
          changed: false,
          ...(input.afterRefresh === undefined ? {} : { afterCommit: input.afterRefresh }),
        };
      }

      const now = this.now();
      const revision: PublishedAgendaRevision = {
        id: this.#idGenerator.nextId("revision"),
        eventId: state.eventId,
        revisionNumber: state.revisions.length + 1,
        sourceDraftVersion: current.sourceDraftVersion,
        timeZone: state.timeZone,
        entries,
        warningOverrides: structuredClone(current.warningOverrides),
        publishedAt: now,
        publishedBy: input.actorId,
        rollbackOfRevisionId: null,
      };
      const outbox = this.outbox(state.eventId, revision.id, now);
      const result = { status: "created" as const, revision };
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          revisions: [...state.revisions, revision],
          currentPublishedRevisionId: revision.id,
          outbox: [...state.outbox, ...outbox],
          audit: [
            ...state.audit,
            this.audit(state.eventId, input.actorId, "agenda.content-refreshed", now, {
              previousRevisionId: current.id,
              revisionId: revision.id,
            }),
          ],
        },
        result,
        ...(input.afterRefresh === undefined ? {} : { afterCommit: input.afterRefresh }),
      };
    });
  }

  async rollback(
    input: RollbackAgendaInput & {
      afterRollback?: (revision: PublishedAgendaRevision) => Promise<void>;
    },
  ): Promise<PublishedAgendaRevision> {
    return this.mutate(input.eventId, async (state) => {
      assertDraftVersion(state, input.expectedVersion);
      requireNonEmpty(input.actorId, "actorId");
      const target = state.revisions.find((revision) => revision.id === input.revisionId);
      if (target === undefined) {
        throw new AgendaError(
          "REVISION_NOT_FOUND",
          `Agenda revision not found: ${input.revisionId}`,
        );
      }
      if (state.currentPublishedRevisionId === target.id) {
        return {
          state,
          result: target,
          changed: false,
          ...(input.afterRollback === undefined ? {} : { afterCommit: input.afterRollback }),
        };
      }

      validateStoredEntries(target.entries, state);
      const report = this.validationReport(state, target.entries);
      const releaseReport = this.releaseValidationReport(state, target.entries);
      if (report.conflicts.length > 0 || releaseReport.conflicts.length > 0) {
        throw new AgendaValidationError(
          "The requested rollback now has hard conflicts",
          mergeValidationReports(report, releaseReport),
        );
      }
      const warningIds = new Set(report.warnings.map((warning) => warning.id));
      const targetOverrides = target.warningOverrides.filter((override) =>
        warningIds.has(override.warningId),
      );
      const overriddenIds = new Set(targetOverrides.map((override) => override.warningId));
      if (report.warnings.some((warning) => !overriddenIds.has(warning.id))) {
        throw new AgendaValidationError(
          "The requested rollback has warnings that were not previously overridden",
          report,
        );
      }

      const now = this.now();
      const draft: AgendaDraft = {
        ...state.draft,
        version: state.draft.version + 1,
        entries: target.entries,
        warningOverrides: targetOverrides,
        updatedAt: now,
        updatedBy: input.actorId,
      };
      const revision: PublishedAgendaRevision = {
        id: this.#idGenerator.nextId("revision"),
        eventId: state.eventId,
        revisionNumber: state.revisions.length + 1,
        sourceDraftVersion: draft.version,
        timeZone: target.timeZone,
        entries: structuredClone(target.entries),
        warningOverrides: structuredClone(targetOverrides),
        publishedAt: now,
        publishedBy: input.actorId,
        rollbackOfRevisionId: target.id,
      };
      const outbox = this.outbox(state.eventId, revision.id, now);
      return {
        state: {
          ...state,
          stateVersion: state.stateVersion + 1,
          draft,
          revisions: [...state.revisions, revision],
          currentPublishedRevisionId: revision.id,
          outbox: [...state.outbox, ...outbox],
          audit: [
            ...state.audit,
            this.audit(state.eventId, input.actorId, "agenda.rolled-back", now, {
              revisionId: revision.id,
              rollbackOfRevisionId: target.id,
            }),
          ],
        },
        result: revision,
        ...(input.afterRollback === undefined ? {} : { afterCommit: input.afterRollback }),
      };
    });
  }

  private async buildSuggestionRun(
    state: AgendaState,
    actorId: string,
    baseDraftVersion: number,
    criteria: AgendaSuggestionCriteriaSnapshot,
    regenerationOfRunId: string | null,
    version: number,
  ): Promise<AgendaSuggestionRun> {
    const provider = this.#suggestionProvider;
    if (provider === null) {
      throw new AgendaError(
        "SUGGESTION_PROVIDER_UNAVAILABLE",
        "An agenda suggestion provider is not configured",
      );
    }

    const providerMethod = provider.suggest ?? provider.generate ?? provider.propose;
    if (providerMethod === undefined) {
      throw new AgendaError(
        "SUGGESTION_PROVIDER_UNAVAILABLE",
        "The agenda suggestion provider does not expose a generation method",
      );
    }

    const eligibleStatuses = new Set(criteria.eligibleStatuses);
    const sessions = state.sessions.filter((session) => eligibleStatuses.has(session.status));
    const request: AgendaSuggestionProviderRequest = {
      eventId: state.eventId,
      timeZone: state.timeZone,
      baseDraftVersion,
      baseRevision: baseDraftVersion,
      criteria: structuredClone(criteria),
      sessions: structuredClone(sessions),
      existingEntries: structuredClone(state.draft.entries),
      dates: criteria.dates,
      eligibleStatuses: criteria.eligibleStatuses,
      rooms: criteria.rooms,
      roomIds: criteria.roomIds,
      dayWindows: criteria.dayWindows,
      orderedRules: criteria.orderedRules,
      ignoreExistingTimes: criteria.ignoreExistingTimes,
      ignoreExistingRooms: criteria.ignoreExistingRooms,
      ignoreExistingSchedule: criteria.ignoreExistingSchedule,
    };
    let providerResult: AgendaSuggestionProviderResult;
    try {
      providerResult = await providerMethod.call(provider, request);
    } catch (error) {
      if (error instanceof AgendaError) {
        throw error;
      }
      throw new AgendaError(
        "SUGGESTION_INVALID",
        error instanceof Error ? error.message : "The agenda suggestion provider failed",
      );
    }

    const runId = this.#idGenerator.nextId("suggestion");
    const proposedEntries = materializeSuggestionEntries(state, criteria, providerResult, runId);
    const diff = suggestionDiff(state.draft.entries, proposedEntries, state.sessions, state.rooms);
    return {
      id: runId,
      eventId: state.eventId,
      version,
      status: "pending",
      baseDraftVersion,
      baseDraftRevision: baseDraftVersion,
      baseEntries: structuredClone(state.draft.entries),
      criteria: structuredClone(criteria),
      criteriaSnapshot: structuredClone(criteria),
      placements: structuredClone(proposedEntries),
      proposedEntries: structuredClone(proposedEntries),
      diff,
      candidateDiagnostics: this.validationReport(state, proposedEntries),
      generatedAt: this.now(),
      generatedBy: actorId,
      regenerationOfRunId,
      acceptedChangeIds: [],
      appliedChangeIds: [],
    };
  }
  private async mutate<T>(
    eventId: string,
    operation: (state: AgendaState) => Promise<{
      state: AgendaState;
      result: T;
      changed?: boolean;
      afterCommit?: (result: T) => Promise<void>;
    }>,
  ): Promise<T> {
    return this.mutationLock.runExclusive(eventId, async () => {
      const eventSchedule = await this.requireEventSchedule(eventId);
      const current = await this.requireState(eventId);
      const authoritative = alignAgendaTimeZone(current, eventSchedule.timeZone);
      const change = await operation(authoritative.state);
      if (change.changed === false && !authoritative.changed) {
        const result = structuredClone(change.result);
        await this.mutationLock.renew?.(eventId);
        await change.afterCommit?.(result);
        return result;
      }
      const nextState =
        change.changed === false
          ? { ...change.state, stateVersion: current.stateVersion + 1 }
          : change.state;
      assertAgendaTimeZone(nextState, eventSchedule.timeZone);
      validateStoredAgendaEntriesWithinEvent(nextState.draft.entries, eventSchedule);
      const published = nextState.revisions.find(
        (revision) => revision.id === nextState.currentPublishedRevisionId,
      );
      if (published !== undefined) {
        validateStoredAgendaEntriesWithinEvent(published.entries, eventSchedule);
      }
      await this.mutationLock.renew?.(eventId);
      try {
        await this.compareAndSwap(eventId, current.stateVersion, nextState, {
          priorState: current,
        });
      } catch (error) {
        if (error instanceof AgendaRepositoryConflictError) {
          throw new AgendaError(
            "CONCURRENT_MODIFICATION",
            `Agenda changed while updating event ${eventId}`,
          );
        }
        throw error;
      }
      const result = structuredClone(change.result);
      await this.mutationLock.renew?.(eventId);
      await change.afterCommit?.(result);
      return result;
    });
  }

  private async requireEventSchedule(eventId: string): Promise<AgendaEventSchedule> {
    const event = await this.#eventScheduleForEvent?.(eventId);
    if (event === null || event === undefined) {
      throw new AgendaError(
        "AGENDA_NOT_FOUND",
        `Authoritative event metadata was not found for agenda ${eventId}`,
      );
    }
    return { ...event, timeZone: canonicalizeTimeZone(event.timeZone) };
  }

  private async requireState(eventId: string): Promise<AgendaState> {
    const state = await this.repository.load(eventId);
    if (state === null) {
      throw new AgendaError("AGENDA_NOT_FOUND", `Agenda not found for event ${eventId}`);
    }
    return state;
  }

  private validationReport(
    state: Pick<AgendaState, "minimumTravelMinutes" | "rooms" | "sessions" | "tracks">,
    entries: readonly AgendaEntry[],
  ): AgendaValidationReport {
    const base = {
      entries,
      minimumTravelMinutes: state.minimumTravelMinutes,
      rooms: state.rooms,
      sessions: state.sessions,
      tracks: state.tracks,
    };
    return this.#customRules.length === 0
      ? detectAgendaConflicts(base)
      : detectAgendaConflicts({ ...base, customRules: this.#customRules });
  }
  private releaseValidationReport(
    state: Pick<AgendaState, "currentPublishedRevisionId" | "revisions" | "sessions">,
    entries: readonly AgendaEntry[],
  ): AgendaValidationReport {
    const releasedEntries = currentRevision(state)?.entries ?? [];
    return detectReleasedSpeakerCommitmentConflicts({
      entries,
      releasedEntries,
      sessions: state.sessions,
    });
  }

  private previewState(state: AgendaState): AgendaPreview {
    const validation = this.validationReport(state, state.draft.entries);
    const overriddenWarningIds = new Set(
      state.draft.warningOverrides.map((override) => override.warningId),
    );
    const publishedEntries = currentRevision(state)?.entries ?? [];
    return {
      draftVersion: state.draft.version,
      validation,
      releaseValidation: this.releaseValidationReport(state, state.draft.entries),
      unoverriddenWarnings: validation.warnings.filter(
        (warning) => !overriddenWarningIds.has(warning.id),
      ),
      diff: diffEntries(publishedEntries, state.draft.entries),
    };
  }

  private revision(
    state: AgendaState,
    actorId: string,
    now: string,
    rollbackOfRevisionId: string | null,
    draft: AgendaDraft,
  ): PublishedAgendaRevision {
    return {
      id: this.#idGenerator.nextId("revision"),
      eventId: state.eventId,
      revisionNumber: state.revisions.length + 1,
      sourceDraftVersion: draft.version,
      timeZone: state.timeZone,
      entries: draft.entries.map((entry) => {
        const session = state.sessions.find((candidate) => candidate.id === entry.sessionId);
        const room = state.rooms.find((candidate) => candidate.id === entry.roomId);
        const trackNames = entry.trackIds.flatMap((trackId) => {
          const track = state.tracks.find((candidate) => candidate.id === trackId);
          return track === undefined ? [] : [track.name];
        });
        return {
          ...structuredClone(entry),
          metadata: {
            title: session?.title ?? entry.sessionId,
            summary: session?.summary?.trim() ?? "",
            format: session?.format?.trim() || "Session",
            speakerNames: [...(session?.speakerNames ?? [])],
            roomName: room?.name ?? entry.roomId,
            trackNames,
          },
        };
      }),
      warningOverrides: structuredClone(draft.warningOverrides),
      publishedAt: now,
      publishedBy: actorId,
      rollbackOfRevisionId,
    };
  }

  private outbox(eventId: string, revisionId: string, now: string): AgendaOutboxEvent[] {
    return outboxTypes.map((type) => ({
      id: this.#idGenerator.nextId("outbox"),
      eventId,
      revisionId,
      type,
      idempotencyKey: `${eventId}:${revisionId}:${type}`,
      createdAt: now,
    }));
  }

  private audit(
    eventId: string,
    actorId: string,
    action: AgendaAuditEntry["action"],
    createdAt: string,
    details: Readonly<Record<string, string | number>>,
  ): AgendaAuditEntry {
    return {
      id: this.#idGenerator.nextId("audit"),
      eventId,
      actorId,
      action,
      createdAt,
      details,
    };
  }

  private now(): string {
    return this.#clock.now().toISOString();
  }
}

function normalizeSuggestionCriteria(
  input: AgendaSuggestionCriteriaInput,
  state: AgendaState,
): AgendaSuggestionCriteriaSnapshot {
  const providedWindows = input.dayWindows ?? [];
  const dates = uniqueNonEmpty(
    input.dates ?? providedWindows.map((window) => window.date),
    "suggestion dates",
  );
  if (dates.length === 0) {
    throw new AgendaError("SUGGESTION_INVALID", "An agenda suggestion requires at least one date");
  }
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new AgendaError("SUGGESTION_INVALID", `Invalid suggestion date: ${date}`);
    }
  }

  const eligibleStatuses = uniqueNonEmpty(
    input.eligibleStatuses ?? ["accepted"],
    "eligible session statuses",
  );
  if (eligibleStatuses.length === 0) {
    throw new AgendaError(
      "SUGGESTION_INVALID",
      "An agenda suggestion requires at least one eligible session status",
    );
  }
  const requestedRooms = input.roomIds ?? input.rooms ?? state.rooms;
  if (requestedRooms.length === 0) {
    throw new AgendaError(
      "SUGGESTION_INVALID",
      "An agenda suggestion requires at least one organizer-selected room",
    );
  }
  const roomIds = uniqueNonEmpty(
    requestedRooms.map((room) => (typeof room === "string" ? room : room.id)),
    "suggestion rooms",
  );
  const roomById = new Map(state.rooms.map((room) => [room.id, room]));
  for (const roomId of roomIds) {
    if (!roomById.has(roomId)) {
      throw new AgendaError("SUGGESTION_INVALID", `Unknown suggestion room: ${roomId}`);
    }
  }

  const dayWindows =
    providedWindows.length === 0
      ? dates.map((date) => ({ date, startLocal: "09:00", endLocal: "17:00" }))
      : providedWindows.map((window) => normalizeSuggestionWindow(window));
  for (const window of dayWindows) {
    if (!dates.includes(window.date)) {
      throw new AgendaError(
        "SUGGESTION_INVALID",
        `Suggestion day window ${window.date} is not in the selected dates`,
      );
    }
    if (toMinutes(window.startLocal) >= toMinutes(window.endLocal)) {
      throw new AgendaError(
        "SUGGESTION_INVALID",
        `Suggestion day window on ${window.date} must end after it starts`,
      );
    }
  }

  const orderedRules = input.orderedRules ?? input.rules ?? [];
  for (const rule of orderedRules) {
    if (typeof rule === "string") {
      requireNonEmpty(rule, "suggestion organizer rule");
    } else if (Object.keys(rule).length === 0) {
      throw new AgendaError("SUGGESTION_INVALID", "Suggestion organizer rules must not be empty");
    }
  }

  return {
    dates,
    eligibleStatuses,
    roomIds,
    rooms: roomIds.map((roomId) => roomById.get(roomId) as AgendaRoom),
    dayWindows: structuredClone(dayWindows),
    orderedRules: structuredClone(orderedRules),
    ignoreExistingTimes: input.ignoreExistingTimes ?? input.ignoreExistingSchedule?.times ?? false,
    ignoreExistingRooms: input.ignoreExistingRooms ?? input.ignoreExistingSchedule?.rooms ?? false,
    ignoreExistingSchedule: {
      times: input.ignoreExistingTimes ?? input.ignoreExistingSchedule?.times ?? false,
      rooms: input.ignoreExistingRooms ?? input.ignoreExistingSchedule?.rooms ?? false,
    },
  };
}

function normalizeSuggestionWindow(
  window: AgendaSuggestionDayWindowInput,
): AgendaSuggestionDayWindow {
  const start = window.startLocal ?? window.start ?? window.startsAtLocal?.slice(11, 16) ?? "";
  const end = window.endLocal ?? window.end ?? window.endsAtLocal?.slice(11, 16) ?? "";
  requireNonEmpty(window.date, "suggestion day window date");
  requireNonEmpty(start, "suggestion day window start");
  requireNonEmpty(end, "suggestion day window end");
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
    throw new AgendaError(
      "SUGGESTION_INVALID",
      `Suggestion day window on ${window.date} must use HH:mm times`,
    );
  }
  toMinutes(start);
  toMinutes(end);
  return { date: window.date, startLocal: start, endLocal: end };
}

function materializeSuggestionEntries(
  state: AgendaState,
  criteria: AgendaSuggestionCriteriaSnapshot,
  providerResult: AgendaSuggestionProviderResult,
  runId: string,
): AgendaEntry[] {
  const placements =
    providerResult.placements ??
    providerResult.proposedPlacements ??
    providerResult.proposedEntries ??
    [];
  const selectedRooms = new Set(criteria.roomIds);
  const eligibleStatuses = new Set(criteria.eligibleStatuses);
  const sessionsById = new Map(state.sessions.map((session) => [session.id, session]));
  const existingById = new Map(state.draft.entries.map((entry) => [entry.id, entry]));
  const existingBySession = new Map(state.draft.entries.map((entry) => [entry.sessionId, entry]));
  const removedIds = new Set(providerResult.removeEntryIds ?? []);
  for (const entryId of removedIds) {
    if (!existingById.has(entryId)) {
      throw new AgendaError("SUGGESTION_INVALID", `Unknown entry to remove: ${entryId}`);
    }
  }

  const seenPlacementSessions = new Set<string>();
  const nextInputs = state.draft.entries
    .filter((entry) => !removedIds.has(entry.id))
    .map((entry) => toEntryInput(entry));
  const inputsBySession = new Map(nextInputs.map((entry) => [entry.sessionId, entry]));

  for (const placement of placements) {
    const session = sessionsById.get(placement.sessionId);
    if (session === undefined || !eligibleStatuses.has(session.status)) {
      throw new AgendaError(
        "SUGGESTION_INVALID",
        `Suggestion placement references an ineligible session: ${placement.sessionId}`,
      );
    }
    if (seenPlacementSessions.has(placement.sessionId)) {
      throw new AgendaError(
        "SUGGESTION_INVALID",
        `Suggestion contains multiple placements for session ${placement.sessionId}`,
      );
    }
    seenPlacementSessions.add(placement.sessionId);
    if (!selectedRooms.has(placement.roomId)) {
      throw new AgendaError(
        "SUGGESTION_INVALID",
        `Suggestion placement uses a room outside the selected rooms: ${placement.roomId}`,
      );
    }
    validateSuggestionPlacementWindow(placement, criteria);
    const existing =
      (placement.id === undefined ? undefined : existingById.get(placement.id)) ??
      existingBySession.get(placement.sessionId);
    const id = placement.id ?? existing?.id ?? `${runId}:${placement.sessionId}`;
    const nextInput: AgendaEntryInput = {
      id,
      sessionId: placement.sessionId,
      roomId: placement.roomId,
      trackIds: placement.trackIds ?? existing?.trackIds ?? [],
      startsAtLocal: placement.startsAtLocal,
      endsAtLocal: placement.endsAtLocal,
      ...(placement.startDisambiguation === undefined
        ? {}
        : { startDisambiguation: placement.startDisambiguation }),
      ...(placement.endDisambiguation === undefined
        ? {}
        : { endDisambiguation: placement.endDisambiguation }),
    };
    inputsBySession.set(placement.sessionId, nextInput);
  }

  try {
    return materializeEntries([...inputsBySession.values()], state);
  } catch (error) {
    if (error instanceof AgendaError && error.code === "INVALID_AGENDA") {
      throw new AgendaError("SUGGESTION_INVALID", error.message);
    }
    throw error;
  }
}

function validateSuggestionPlacementWindow(
  placement: AgendaSuggestionPlacement,
  criteria: AgendaSuggestionCriteriaSnapshot,
): void {
  const date = placement.startsAtLocal.slice(0, 10);
  const endDate = placement.endsAtLocal.slice(0, 10);
  if (date !== endDate || !criteria.dates.includes(date)) {
    throw new AgendaError(
      "SUGGESTION_INVALID",
      `Suggestion placement for ${placement.sessionId} is outside the selected dates`,
    );
  }
  const windows = criteria.dayWindows.filter((window) => window.date === date);
  const start = placement.startsAtLocal.slice(11, 16);
  const end = placement.endsAtLocal.slice(11, 16);
  if (
    windows.length === 0 ||
    windows.every(
      (window) =>
        toMinutes(start) < toMinutes(window.startLocal) ||
        toMinutes(end) > toMinutes(window.endLocal),
    )
  ) {
    throw new AgendaError(
      "SUGGESTION_INVALID",
      `Suggestion placement for ${placement.sessionId} is outside the day window`,
    );
  }
}

function suggestionDiff(
  base: readonly AgendaEntry[],
  proposed: readonly AgendaEntry[],
  sessions: readonly AgendaSession[],
  rooms: readonly AgendaRoom[],
): import("./types").AgendaSuggestionDiff {
  const baseById = new Map(base.map((entry) => [entry.id, entry]));
  const proposedById = new Map(proposed.map((entry) => [entry.id, entry]));
  const sessionNames = new Map(sessions.map((session) => [session.id, session.title]));
  const roomNames = new Map(rooms.map((room) => [room.id, room.name]));
  const changes: AgendaSuggestionChange[] = [];
  const addedEntryIds: string[] = [];
  const removedEntryIds: string[] = [];
  const changedEntryIds: string[] = [];

  for (const id of [...new Set([...baseById.keys(), ...proposedById.keys()])].sort()) {
    const before = baseById.get(id) ?? null;
    const after = proposedById.get(id) ?? null;
    if (before === null && after !== null) {
      addedEntryIds.push(id);
      changes.push({
        id: `add:${id}`,
        kind: "add",
        entryId: id,
        sessionId: after.sessionId,
        before: null,
        after: structuredClone(after),
        summary: describeSuggestionChange("add", after, null, sessionNames, roomNames),
      });
    } else if (before !== null && after === null) {
      removedEntryIds.push(id);
      changes.push({
        id: `remove:${id}`,
        kind: "remove",
        entryId: id,
        sessionId: before.sessionId,
        before: structuredClone(before),
        after: null,
        summary: describeSuggestionChange("remove", null, before, sessionNames, roomNames),
      });
    } else if (before !== null && after !== null && !entriesEqual(before, after)) {
      changedEntryIds.push(id);
      changes.push({
        id: `move:${id}`,
        kind: "move",
        entryId: id,
        sessionId: after.sessionId,
        before: structuredClone(before),
        after: structuredClone(after),
        summary: describeSuggestionChange("move", after, before, sessionNames, roomNames),
      });
    }
  }

  const summary =
    changes.length === 0
      ? "No agenda changes were proposed."
      : `${changes.length} proposed agenda change${changes.length === 1 ? "" : "s"}: ${changes
          .map((change) => change.summary)
          .join("; ")}`;
  return {
    summary,
    description: summary,
    changes,
    addedEntryIds,
    removedEntryIds,
    changedEntryIds,
  };
}

function describeSuggestionChange(
  kind: AgendaSuggestionChangeKind,
  next: AgendaEntry | null,
  previous: AgendaEntry | null,
  sessionNames: ReadonlyMap<string, string>,
  roomNames: ReadonlyMap<string, string>,
): string {
  const entry = next ?? previous;
  if (entry === null) return "Unknown agenda change";
  const session = sessionNames.get(entry.sessionId) ?? entry.sessionId;
  const room = roomNames.get(entry.roomId) ?? entry.roomId;
  const destination = `${session} in ${room} at ${entry.startsAtLocal.slice(11, 16)}–${entry.endsAtLocal.slice(11, 16)}`;
  if (kind === "add") return `Add ${destination}`;
  if (kind === "remove") return `Remove ${destination}`;
  return `Move ${destination}`;
}

function applySuggestionChanges(
  currentEntries: readonly AgendaEntry[],
  changes: readonly AgendaSuggestionChange[],
): AgendaEntry[] {
  const entries = [...currentEntries];
  for (const change of changes) {
    const currentIndex = entries.findIndex((entry) => entry.id === change.entryId);
    if (change.before === null) {
      if (currentIndex !== -1) {
        throw new AgendaError(
          "CONCURRENT_MODIFICATION",
          `Agenda entry ${change.entryId} changed since suggestion generation`,
        );
      }
      if (change.after === null) {
        throw new AgendaError("SUGGESTION_INVALID", `Suggestion change ${change.id} has no result`);
      }
      entries.push(structuredClone(change.after));
      continue;
    }
    const currentEntry = currentIndex === -1 ? undefined : entries[currentIndex];
    if (currentEntry === undefined || !entriesEqual(currentEntry, change.before)) {
      throw new AgendaError(
        "CONCURRENT_MODIFICATION",
        `Agenda entry ${change.entryId} changed since suggestion generation`,
      );
    }
    if (change.after === null) {
      entries.splice(currentIndex, 1);
    } else {
      entries[currentIndex] = structuredClone(change.after);
    }
  }
  return entries;
}

function selectedSuggestionChangeIds(input: ApplyAgendaSuggestionInput): string[] {
  const selected =
    input.acceptedChangeIds ??
    input.selectedChangeIds ??
    input.selectedChanges ??
    input.changeIds ??
    [];
  const ids = [...selected];
  if (new Set(ids).size !== ids.length) {
    throw new AgendaError(
      "SUGGESTION_INVALID",
      "An agenda suggestion change cannot be selected twice",
    );
  }
  return ids;
}

function formatMinutes(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
function requireSuggestionRun(state: AgendaState, runId: string): AgendaSuggestionRun {
  const run = (state.suggestionRuns ?? []).find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new AgendaError("SUGGESTION_NOT_FOUND", `Agenda suggestion run not found: ${runId}`);
  }
  return run;
}

function replaceSuggestionRun(
  state: AgendaState,
  replacement: AgendaSuggestionRun,
): AgendaSuggestionRun[] {
  const runs = state.suggestionRuns ?? [];
  if (!runs.some((run) => run.id === replacement.id)) {
    throw new AgendaError(
      "SUGGESTION_NOT_FOUND",
      `Agenda suggestion run not found: ${replacement.id}`,
    );
  }
  return runs.map((run) => (run.id === replacement.id ? replacement : run));
}

function assertSuggestionPending(run: AgendaSuggestionRun): void {
  if (run.status !== "pending") {
    throw new AgendaError(
      "SUGGESTION_STATE_INVALID",
      `Agenda suggestion run ${run.id} is already ${run.status}`,
    );
  }
}
function assertSuggestionRegenerable(run: AgendaSuggestionRun): void {
  if (run.status === "applied" || run.status === "superseded") {
    throw new AgendaError(
      "SUGGESTION_STATE_INVALID",
      `Agenda suggestion run ${run.id} is already ${run.status}`,
    );
  }
}

function uniqueNonEmpty(values: readonly string[], label: string): string[] {
  for (const value of values) {
    if (value.trim().length === 0) {
      throw new AgendaError("SUGGESTION_INVALID", `${label} must not be empty`);
    }
  }
  if (new Set(values).size !== values.length) {
    throw new AgendaError("SUGGESTION_INVALID", `Duplicate value in ${label}`);
  }
  return [...values];
}

function toMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (match === null || hour > 23 || minute > 59) {
    throw new AgendaError("SUGGESTION_INVALID", `Invalid local time: ${value}`);
  }
  return hour * 60 + minute;
}

function toEntryInput(entry: AgendaEntry): AgendaEntryInput {
  const startDisambiguation =
    entry.startDisambiguation ??
    disambiguationForInstant(entry.startsAtLocal, entry.timeZone, entry.startsAt);
  const endDisambiguation =
    entry.endDisambiguation ??
    disambiguationForInstant(entry.endsAtLocal, entry.timeZone, entry.endsAt);
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    roomId: entry.roomId,
    trackIds: entry.trackIds,
    startsAtLocal: entry.startsAtLocal,
    endsAtLocal: entry.endsAtLocal,
    ...(startDisambiguation === undefined ? {} : { startDisambiguation }),
    ...(endDisambiguation === undefined ? {} : { endDisambiguation }),
  };
}
function agendaEntries(state: AgendaState): readonly AgendaEntry[] {
  return [
    ...state.draft.entries,
    ...state.revisions.flatMap((revision) => revision.entries),
    ...state.suggestionRuns.flatMap((run) => [
      ...run.baseEntries,
      ...run.proposedEntries,
      ...run.diff.changes.flatMap((change) => [
        ...(change.before === null ? [] : [change.before]),
        ...(change.after === null ? [] : [change.after]),
      ]),
    ]),
  ];
}

function assertAgendaTimeZone(state: AgendaState, authoritativeTimeZone: string): void {
  const timeZone = canonicalizeTimeZone(authoritativeTimeZone);
  const mismatched =
    state.timeZone !== timeZone ||
    state.draft.timeZone !== timeZone ||
    state.revisions.some((revision) => revision.timeZone !== timeZone) ||
    agendaEntries(state).some((entry) => entry.timeZone !== timeZone);
  if (mismatched) {
    throw new AgendaError(
      "CONCURRENT_MODIFICATION",
      `Agenda timezone must match the authoritative event timezone ${timeZone}`,
    );
  }
}

function alignAgendaTimeZone(
  state: AgendaState,
  authoritativeTimeZone: string,
): { readonly state: AgendaState; readonly changed: boolean } {
  const timeZone = canonicalizeTimeZone(authoritativeTimeZone);
  try {
    assertAgendaTimeZone(state, timeZone);
    return { state, changed: false };
  } catch (error) {
    if (!(error instanceof AgendaError) || error.code !== "CONCURRENT_MODIFICATION") throw error;
  }
  if (agendaEntries(state).length > 0) {
    throw new AgendaError(
      "CONCURRENT_MODIFICATION",
      "The event timezone changed while the agenda contained temporal state",
    );
  }
  return {
    changed: true,
    state: {
      ...state,
      timeZone,
      draft: { ...state.draft, timeZone },
      revisions: state.revisions.map((revision) => ({ ...revision, timeZone })),
    },
  };
}

function normalizeCatalog(catalog: AgendaCatalog): AgendaCatalog {
  validateUniqueIds(catalog.sessions, "session");
  validateUniqueIds(catalog.rooms, "room");
  validateUniqueIds(catalog.tracks, "track");

  const sessions: AgendaSession[] = catalog.sessions.map((session) => {
    requireNonEmpty(session.title, `session ${session.id} title`);
    validateUniqueStrings(session.participantIds, `session ${session.id} participants`);
    validateUniqueStrings(session.resourceIds, `session ${session.id} resources`);
    if (!Number.isInteger(session.capacityRequired) || session.capacityRequired < 0) {
      throw new AgendaError(
        "INVALID_AGENDA",
        `Session ${session.id} capacityRequired must be a non-negative integer`,
      );
    }
    if (
      session.durationMinutes !== undefined &&
      (!Number.isInteger(session.durationMinutes) || session.durationMinutes < 1)
    ) {
      throw new AgendaError(
        "INVALID_AGENDA",
        `Session ${session.id} durationMinutes must be a positive integer`,
      );
    }
    const trackIds = [...(session.trackIds ?? [])];
    validateUniqueStrings(trackIds, `session ${session.id} tracks`);
    return {
      ...session,
      participantIds: [...session.participantIds],
      resourceIds: [...session.resourceIds],
      trackIds,
    };
  });
  const rooms: AgendaRoom[] = catalog.rooms.map((room) => {
    requireNonEmpty(room.name, `room ${room.id} name`);
    if (!Number.isInteger(room.capacity) || room.capacity < 1) {
      throw new AgendaError(
        "INVALID_AGENDA",
        `Room ${room.id} capacity must be a positive integer`,
      );
    }
    return { ...room };
  });
  const tracks: AgendaTrack[] = catalog.tracks.map((track) => {
    requireNonEmpty(track.name, `track ${track.id} name`);
    return { ...track };
  });
  return { sessions, rooms, tracks };
}

function materializeEntries(
  inputs: readonly AgendaEntryInput[],
  state: Pick<AgendaState, "rooms" | "sessions" | "timeZone" | "tracks">,
): AgendaEntry[] {
  validateUniqueIds(inputs, "agenda entry");
  validateUniqueValues(
    inputs.map((entry) => entry.sessionId),
    "A session can only appear once in an agenda draft",
  );
  const sessions = new Set(state.sessions.map((session) => session.id));
  const rooms = new Set(state.rooms.map((room) => room.id));
  const tracks = new Set(state.tracks.map((track) => track.id));

  return inputs.map((input) => {
    requireNonEmpty(input.sessionId, `entry ${input.id} sessionId`);
    requireNonEmpty(input.roomId, `entry ${input.id} roomId`);
    if (!sessions.has(input.sessionId)) {
      throw new AgendaError("INVALID_AGENDA", `Unknown session: ${input.sessionId}`);
    }
    if (!rooms.has(input.roomId)) {
      throw new AgendaError("INVALID_AGENDA", `Unknown room: ${input.roomId}`);
    }
    validateUniqueStrings(input.trackIds, `entry ${input.id} tracks`);
    for (const trackId of input.trackIds) {
      if (!tracks.has(trackId)) {
        throw new AgendaError("INVALID_AGENDA", `Unknown track: ${trackId}`);
      }
    }

    const start = resolveLocalDateTime(
      input.startsAtLocal,
      state.timeZone,
      input.startDisambiguation,
    );
    const end = resolveLocalDateTime(input.endsAtLocal, state.timeZone, input.endDisambiguation);
    if (Date.parse(end.instant) <= Date.parse(start.instant)) {
      throw new AgendaError("INVALID_AGENDA", `Entry ${input.id} must end after it starts`);
    }
    return {
      id: input.id,
      sessionId: input.sessionId,
      roomId: input.roomId,
      trackIds: [...input.trackIds],
      startsAt: start.instant,
      endsAt: end.instant,
      startsAtLocal: start.localDateTime,
      endsAtLocal: end.localDateTime,
      timeZone: state.timeZone,
      ...(input.startDisambiguation === undefined
        ? {}
        : { startDisambiguation: input.startDisambiguation }),
      ...(input.endDisambiguation === undefined
        ? {}
        : { endDisambiguation: input.endDisambiguation }),
    };
  });
}

function validateStoredEntries(entries: readonly AgendaEntry[], catalog: AgendaCatalog): void {
  const sessions = new Set(catalog.sessions.map((session) => session.id));
  const rooms = new Set(catalog.rooms.map((room) => room.id));
  const tracks = new Set(catalog.tracks.map((track) => track.id));
  for (const entry of entries) {
    if (!sessions.has(entry.sessionId)) {
      throw new AgendaError("INVALID_AGENDA", `Unknown session: ${entry.sessionId}`);
    }
    if (!rooms.has(entry.roomId)) {
      throw new AgendaError("INVALID_AGENDA", `Unknown room: ${entry.roomId}`);
    }
    if (entry.trackIds.some((trackId) => !tracks.has(trackId))) {
      throw new AgendaError("INVALID_AGENDA", `Entry ${entry.id} references an unknown track`);
    }
  }
}
function retainScheduledSessionsAsIneligible(
  state: Pick<AgendaState, "draft" | "sessions">,
  catalog: AgendaCatalog,
): AgendaCatalog {
  const catalogSessionIds = new Set(catalog.sessions.map((session) => session.id));
  const retainedSessions = state.sessions
    .filter(
      (session) =>
        !catalogSessionIds.has(session.id) &&
        state.draft.entries.some((entry) => entry.sessionId === session.id),
    )
    .map((session) => ({
      id: session.id,
      title: session.title,
      status: "ineligible",
      publicApprovalEligible: false,
      participantIds: [],
      resourceIds: [],
      capacityRequired: 0,
    }));
  return {
    ...catalog,
    sessions: [...catalog.sessions, ...retainedSessions],
  };
}

function firstNonAcceptedSessionId(
  sessions: readonly AgendaSession[],
  entries: readonly AgendaEntry[],
): string | null {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  for (const entry of entries) {
    const session = sessionsById.get(entry.sessionId);
    if (session === undefined || session.status.trim().toLowerCase() !== "accepted") {
      return entry.sessionId;
    }
  }
  return null;
}

function firstPubliclyIneligibleSessionId(
  sessions: readonly AgendaSession[],
  entries: readonly AgendaEntry[],
): string | null {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  for (const entry of entries) {
    if (sessionsById.get(entry.sessionId)?.publicApprovalEligible !== true) {
      return entry.sessionId;
    }
  }
  return null;
}

function validateUniqueIds(values: readonly { id: string }[], label: string): void {
  for (const value of values) {
    requireNonEmpty(value.id, `${label} id`);
  }
  validateUniqueValues(
    values.map((value) => value.id),
    `Duplicate ${label} id`,
  );
}

function validateUniqueStrings(values: readonly string[], label: string): void {
  for (const value of values) {
    requireNonEmpty(value, label);
  }
  validateUniqueValues(values, `Duplicate value in ${label}`);
}

function validateUniqueValues(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) {
    throw new AgendaError("INVALID_AGENDA", message);
  }
}

function validateMinimumTravelMinutes(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new AgendaError("INVALID_AGENDA", "minimumTravelMinutes must be a non-negative integer");
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new AgendaError("INVALID_AGENDA", `${label} must not be empty`);
  }
}

function assertDraftVersion(state: AgendaState, expectedVersion: number): void {
  if (state.draft.version !== expectedVersion) {
    throw new AgendaError(
      "CONCURRENT_MODIFICATION",
      `Expected draft version ${expectedVersion}, current version is ${state.draft.version}`,
    );
  }
}

function currentRevision(
  state: Pick<AgendaState, "currentPublishedRevisionId" | "revisions">,
): PublishedAgendaRevision | null {
  if (state.currentPublishedRevisionId === null) {
    return null;
  }
  return (
    state.revisions.find((revision) => revision.id === state.currentPublishedRevisionId) ?? null
  );
}

interface PublishedEntryMetadata {
  readonly title: string;
  readonly summary: string;
  readonly format: string;
  readonly speakerNames: readonly string[];
  readonly roomName: string;
  readonly trackNames: readonly string[];
}

function publishedEntryMetadata(entry: AgendaEntry): PublishedEntryMetadata {
  const metadata = entry.metadata;
  return {
    title: metadata?.title ?? entry.sessionId,
    summary: metadata?.summary ?? "",
    format: metadata?.format ?? "Session",
    speakerNames: metadata?.speakerNames ?? [],
    roomName: metadata?.roomName ?? entry.roomId,
    trackNames: metadata?.trackNames ?? [],
  };
}

function refreshPublishedEntries(
  catalog: AgendaCatalog,
  entries: readonly AgendaEntry[],
): readonly AgendaEntry[] {
  const sessions = new Map(catalog.sessions.map((session) => [session.id, session]));
  const rooms = new Map(catalog.rooms.map((room) => [room.id, room]));
  const tracks = new Map(catalog.tracks.map((track) => [track.id, track]));
  return entries.map((entry) => {
    const current = publishedEntryMetadata(entry);
    const session = sessions.get(entry.sessionId);
    const approvedSession = session?.publicApprovalEligible === true ? session : undefined;
    const approvedDuration = approvedSession?.durationMinutes;
    const trackIds =
      approvedSession === undefined ? [...entry.trackIds] : [...(approvedSession.trackIds ?? [])];
    const resolvedTrackNames = trackIds.flatMap((trackId) => {
      const track = tracks.get(trackId);
      return track === undefined ? [] : [track.name];
    });
    const { endDisambiguation: _previousEndDisambiguation, ...entryWithoutEndDisambiguation } =
      structuredClone(entry);
    const refreshedDuration =
      approvedSession === undefined || approvedDuration === undefined
        ? {
            endsAt: entry.endsAt,
            endsAtLocal: entry.endsAtLocal,
            ...(entry.endDisambiguation === undefined
              ? {}
              : { endDisambiguation: entry.endDisambiguation }),
          }
        : (() => {
            const endsAt = new Date(
              Date.parse(entry.startsAt) + approvedDuration * 60_000,
            ).toISOString();
            const endsAtLocal = formatInstantInTimeZone(endsAt, entry.timeZone).slice(0, 16);
            const endDisambiguation = disambiguationForInstant(endsAtLocal, entry.timeZone, endsAt);
            return {
              endsAt,
              endsAtLocal,
              ...(endDisambiguation === undefined ? {} : { endDisambiguation }),
            };
          })();
    return {
      ...entryWithoutEndDisambiguation,
      trackIds,
      ...refreshedDuration,
      metadata: {
        title: approvedSession?.title ?? current.title,
        summary:
          approvedSession === undefined ? current.summary : (approvedSession.summary?.trim() ?? ""),
        format:
          approvedSession === undefined
            ? current.format
            : approvedSession.format?.trim() || "Session",
        speakerNames:
          approvedSession === undefined
            ? [...current.speakerNames]
            : [...(approvedSession.speakerNames ?? [])],
        roomName: rooms.get(entry.roomId)?.name ?? current.roomName,
        trackNames:
          resolvedTrackNames.length === trackIds.length
            ? resolvedTrackNames
            : [...current.trackNames],
      },
    };
  });
}

function publishedEntriesEqual(
  left: readonly AgendaEntry[],
  right: readonly AgendaEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    if (other === undefined || entry.id !== other.id || !entriesEqual(entry, other)) return false;
    const leftMetadata = publishedEntryMetadata(entry);
    const rightMetadata = publishedEntryMetadata(other);
    return (
      leftMetadata.title === rightMetadata.title &&
      leftMetadata.summary === rightMetadata.summary &&
      leftMetadata.format === rightMetadata.format &&
      leftMetadata.speakerNames.join("\u0000") === rightMetadata.speakerNames.join("\u0000") &&
      leftMetadata.roomName === rightMetadata.roomName &&
      leftMetadata.trackNames.join("\u0000") === rightMetadata.trackNames.join("\u0000")
    );
  });
}

function diffEntries(
  published: readonly AgendaEntry[],
  draft: readonly AgendaEntry[],
): AgendaPreview["diff"] {
  const publishedById = new Map(published.map((entry) => [entry.id, entry]));
  const draftById = new Map(draft.map((entry) => [entry.id, entry]));
  return {
    addedEntryIds: [...draftById.keys()].filter((id) => !publishedById.has(id)).sort(),
    removedEntryIds: [...publishedById.keys()].filter((id) => !draftById.has(id)).sort(),
    changedEntryIds: [...draftById.entries()]
      .filter(([id, entry]) => {
        const existing = publishedById.get(id);
        return existing !== undefined && !entriesEqual(existing, entry);
      })
      .map(([id]) => id)
      .sort(),
  };
}

function entriesEqual(left: AgendaEntry, right: AgendaEntry): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.roomId === right.roomId &&
    left.startsAt === right.startsAt &&
    left.endsAt === right.endsAt &&
    left.trackIds.join("\u0000") === right.trackIds.join("\u0000")
  );
}
function mergeValidationReports(
  left: AgendaValidationReport,
  right: AgendaValidationReport,
): AgendaValidationReport {
  return {
    conflicts: [...left.conflicts, ...right.conflicts],
    warnings: [...left.warnings, ...right.warnings],
  };
}
