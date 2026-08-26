export type AgendaConflictKind = "participant" | "resource" | "room";

export type AgendaWarningKind = "capacity" | "custom" | "track" | "travel";

export type AgendaOutboxEventType =
  | "calendar.agenda-updated"
  | "embed-cache.invalidate"
  | "public-agenda.updated";

export interface AgendaSession {
  id: string;
  title: string;
  status: string;
  /** Whether this private catalog session's content may appear in a public agenda revision. */
  publicApprovalEligible: boolean;
  participantIds: readonly string[];
  resourceIds: readonly string[];
  capacityRequired: number;
  durationMinutes?: number;
  summary?: string;
  format?: string;
  speakerNames?: readonly string[];
  trackIds?: readonly string[];
}

export interface AgendaRoom {
  id: string;
  name: string;
  capacity: number;
}

export interface AgendaTrack {
  id: string;
  name: string;
}

export type TimeDisambiguation = "earlier" | "later";

export interface AgendaEntryInput {
  id: string;
  sessionId: string;
  roomId: string;
  trackIds: readonly string[];
  startsAtLocal: string;
  endsAtLocal: string;
  startDisambiguation?: TimeDisambiguation;
  endDisambiguation?: TimeDisambiguation;
}
export interface AgendaEntryPublicMetadata {
  readonly title: string;
  readonly summary: string;
  readonly format: string;
  readonly speakerNames: readonly string[];
  readonly roomName: string;
  readonly trackNames: readonly string[];
}

export interface AgendaEntry {
  id: string;
  sessionId: string;
  roomId: string;
  trackIds: readonly string[];
  startsAt: string;
  endsAt: string;
  startsAtLocal: string;
  endsAtLocal: string;
  timeZone: string;
  startDisambiguation?: TimeDisambiguation;
  endDisambiguation?: TimeDisambiguation;
  metadata?: AgendaEntryPublicMetadata;
}
export type AgendaSuggestionRunStatus = "pending" | "rejected" | "superseded" | "stale" | "applied";

export type AgendaSuggestionChangeKind = "add" | "move" | "change" | "remove";

export interface AgendaSuggestionDayWindowInput {
  date: string;
  startLocal?: string;
  endLocal?: string;
  start?: string;
  end?: string;
  startsAtLocal?: string;
  endsAtLocal?: string;
}
export interface AgendaSuggestionDayWindow {
  date: string;
  startLocal: string;
  endLocal: string;
}

export type AgendaSuggestionRule = string | Readonly<Record<string, unknown>>;

export interface AgendaSuggestionCriteriaInput {
  dates?: readonly string[];
  eligibleStatuses?: readonly string[];
  rooms?: readonly string[] | readonly AgendaRoom[];
  roomIds?: readonly string[];
  dayWindows?: readonly AgendaSuggestionDayWindowInput[];
  orderedRules?: readonly AgendaSuggestionRule[];
  rules?: readonly AgendaSuggestionRule[];
  ignoreExistingTimes?: boolean;
  ignoreExistingRooms?: boolean;
  ignoreExistingSchedule?: {
    times?: boolean;
    rooms?: boolean;
  };
}

export interface AgendaSuggestionCriteriaSnapshot {
  dates: readonly string[];
  eligibleStatuses: readonly string[];
  roomIds: readonly string[];
  rooms: readonly AgendaRoom[];
  dayWindows: readonly AgendaSuggestionDayWindow[];
  orderedRules: readonly AgendaSuggestionRule[];
  ignoreExistingTimes: boolean;
  ignoreExistingRooms: boolean;
  ignoreExistingSchedule: {
    times: boolean;
    rooms: boolean;
  };
}

export interface AgendaSuggestionPlacement {
  id?: string;
  sessionId: string;
  roomId: string;
  trackIds?: readonly string[];
  startsAtLocal: string;
  endsAtLocal: string;
  startDisambiguation?: TimeDisambiguation;
  endDisambiguation?: TimeDisambiguation;
  rationale?: string;
}

export interface AgendaSuggestionProviderRequest {
  eventId: string;
  timeZone: string;
  baseDraftVersion: number;
  baseRevision: number;
  criteria: AgendaSuggestionCriteriaSnapshot;
  sessions: readonly AgendaSession[];
  existingEntries: readonly AgendaEntry[];
  dates: readonly string[];
  eligibleStatuses: readonly string[];
  rooms: readonly AgendaRoom[];
  roomIds: readonly string[];
  dayWindows: readonly AgendaSuggestionDayWindow[];
  orderedRules: readonly AgendaSuggestionRule[];
  ignoreExistingTimes: boolean;
  ignoreExistingRooms: boolean;
  ignoreExistingSchedule: {
    times: boolean;
    rooms: boolean;
  };
}

export interface AgendaSuggestionProviderResult {
  placements?: readonly AgendaSuggestionPlacement[];
  proposedPlacements?: readonly AgendaSuggestionPlacement[];
  proposedEntries?: readonly AgendaSuggestionPlacement[];
  removeEntryIds?: readonly string[];
}

export interface AgendaSuggestionProvider {
  suggest?: (
    request: AgendaSuggestionProviderRequest,
  ) => Promise<AgendaSuggestionProviderResult> | AgendaSuggestionProviderResult;
  generate?: (
    request: AgendaSuggestionProviderRequest,
  ) => Promise<AgendaSuggestionProviderResult> | AgendaSuggestionProviderResult;
  propose?: (
    request: AgendaSuggestionProviderRequest,
  ) => Promise<AgendaSuggestionProviderResult> | AgendaSuggestionProviderResult;
}

export interface AgendaSuggestionChange {
  id: string;
  kind: AgendaSuggestionChangeKind;
  entryId: string;
  sessionId: string;
  before: AgendaEntry | null;
  after: AgendaEntry | null;
  summary: string;
  rationale?: string;
}

export interface AgendaSuggestionDiff {
  summary: string;
  description: string;
  changes: readonly AgendaSuggestionChange[];
  addedEntryIds: readonly string[];
  removedEntryIds: readonly string[];
  changedEntryIds: readonly string[];
}

export interface AgendaSuggestionRun {
  id: string;
  eventId: string;
  version: number;
  status: AgendaSuggestionRunStatus;
  baseDraftVersion: number;
  baseDraftRevision: number;
  baseEntries: readonly AgendaEntry[];
  criteria: AgendaSuggestionCriteriaSnapshot;
  criteriaSnapshot: AgendaSuggestionCriteriaSnapshot;
  placements: readonly AgendaEntry[];
  proposedEntries: readonly AgendaEntry[];
  diff: AgendaSuggestionDiff;
  candidateDiagnostics: AgendaValidationReport;
  generatedAt: string;
  generatedBy: string;
  regenerationOfRunId: string | null;
  acceptedChangeIds: readonly string[];
  appliedChangeIds: readonly string[];
  rejectedAt?: string;
  rejectedBy?: string;
  supersededAt?: string;
  appliedAt?: string;
  appliedBy?: string;
}

export interface AgendaConflict {
  id: string;
  kind: AgendaConflictKind;
  entryIds: readonly string[];
  message: string;
}

export interface AgendaWarning {
  id: string;
  kind: AgendaWarningKind;
  entryIds: readonly string[];
  message: string;
}

export interface AgendaValidationReport {
  conflicts: readonly AgendaConflict[];
  warnings: readonly AgendaWarning[];
}

export interface AgendaWarningOverride {
  warningId: string;
  reason: string;
  actorId: string;
  createdAt: string;
}

export interface AgendaDraft {
  eventId: string;
  version: number;
  timeZone: string;
  entries: readonly AgendaEntry[];
  warningOverrides: readonly AgendaWarningOverride[];
  updatedAt: string;
  updatedBy: string;
}

export interface PublishedAgendaRevision {
  id: string;
  eventId: string;
  revisionNumber: number;
  sourceDraftVersion: number;
  timeZone: string;
  entries: readonly AgendaEntry[];
  warningOverrides: readonly AgendaWarningOverride[];
  publishedAt: string;
  publishedBy: string;
  rollbackOfRevisionId: string | null;
}

export interface AgendaOutboxEvent {
  id: string;
  eventId: string;
  revisionId: string;
  type: AgendaOutboxEventType;
  idempotencyKey: string;
  createdAt: string;
}

export type AgendaAuditAction =
  | "agenda.created"
  | "agenda.content-refreshed"
  | "agenda.published"
  | "agenda.rolled-back"
  | "agenda.suggestion.generated"
  | "agenda.suggestion.rejected"
  | "agenda.suggestion.regenerated"
  | "agenda.suggestion.applied"
  | "catalog.updated"
  | "draft.updated"
  | "draft.validated"
  | "warning.overridden";

export interface AgendaAuditEntry {
  id: string;
  eventId: string;
  actorId: string;
  action: AgendaAuditAction;
  createdAt: string;
  details: Readonly<Record<string, string | number>>;
}

interface AgendaStateCore {
  eventId: string;
  stateVersion: number;
  timeZone: string;
  minimumTravelMinutes: number;
  sessions: readonly AgendaSession[];
  rooms: readonly AgendaRoom[];
  tracks: readonly AgendaTrack[];
  draft: AgendaDraft;
  revisions: readonly PublishedAgendaRevision[];
  currentPublishedRevisionId: string | null;
  outbox: readonly AgendaOutboxEvent[];
  audit: readonly AgendaAuditEntry[];
  suggestionRuns: readonly AgendaSuggestionRun[];
}

export type AgendaValidationMarker =
  | {
      validatedDraftVersion?: never;
      validatedAt?: never;
    }
  | {
      validatedDraftVersion: number;
      validatedAt: string;
    };

export type AgendaState = AgendaStateCore & AgendaValidationMarker;

export interface AgendaCatalog {
  sessions: readonly AgendaSession[];
  rooms: readonly AgendaRoom[];
  tracks: readonly AgendaTrack[];
}

export interface AgendaRuleContext extends AgendaCatalog {
  entries: readonly AgendaEntry[];
}

export type AgendaCustomRule = (context: AgendaRuleContext) => readonly AgendaWarning[];

export interface AgendaPreview {
  draftVersion: number;
  validation: AgendaValidationReport;
  releaseValidation: AgendaValidationReport;
  unoverriddenWarnings: readonly AgendaWarning[];
  diff: {
    addedEntryIds: readonly string[];
    removedEntryIds: readonly string[];
    changedEntryIds: readonly string[];
  };
}

export interface GenerateAgendaSuggestionInput extends AgendaSuggestionCriteriaInput {
  eventId: string;
  actorId: string;
  baseDraftVersion?: number;
  baseRevision?: number;
  baseDraftRevision?: number;
  criteria?: AgendaSuggestionCriteriaInput;
}

export interface RejectAgendaSuggestionInput {
  eventId: string;
  runId: string;
  actorId: string;
}

export interface RegenerateAgendaSuggestionInput {
  eventId: string;
  runId: string;
  actorId: string;
  baseDraftVersion?: number;
  baseRevision?: number;
  baseDraftRevision?: number;
  criteria?: AgendaSuggestionCriteriaInput;
  expectedDraftVersion?: number;
}

export interface ApplyAgendaSuggestionInput {
  eventId: string;
  runId: string;
  actorId: string;
  acceptedChangeIds?: readonly string[];
  selectedChangeIds?: readonly string[];
  selectedChanges?: readonly string[];
  changeIds?: readonly string[];
  expectedDraftVersion?: number;
  expectedBaseRevision?: number;
}
export interface AcceptAgendaSuggestionChangeInput {
  eventId: string;
  runId: string;
  actorId: string;
  changeId: string;
  expectedDraftVersion?: number;
}
export interface AgendaCompareAndSwapContext {
  readonly priorState?: AgendaState | null;
}

export interface AgendaRepository {
  load(eventId: string): Promise<AgendaState | null>;
  compareAndSwap(
    eventId: string,
    expectedStateVersion: number | null,
    nextState: AgendaState,
    context?: AgendaCompareAndSwapContext,
  ): Promise<void>;
}

export interface AgendaMutationLock {
  runExclusive<T>(eventId: string, operation: () => Promise<T>): Promise<T>;
  renew?(eventId: string): Promise<void>;
}

export interface AgendaClock {
  now(): Date;
}

export interface AgendaIdGenerator {
  nextId(prefix: "audit" | "outbox" | "revision" | "suggestion"): string;
}
