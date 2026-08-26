import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { CommunicationService, InMemoryCommunicationRepository } from "../communications/service";
import type { CommunicationDeliveryAdapter } from "../communications/types";
import { InMemoryEventRoleInvitationRepository } from "../event-invitations/memory";
import { CommunicationSpeakerCommunications } from "./communications";
import {
  createSpeakerAdminRoutes,
  createSpeakerRoutes,
  createSpeakerTaskAdminRoutes,
} from "./routes";
import { SpeakerService, SpeakerServiceError } from "./service";
import { withTestSpeakerOrganizerLifecycle } from "./test-lifecycle-adapter";
import type {
  CreatePendingSpeakerAssetVersionCommand,
  CreatePrivateUploadGrantCommand,
  PrivateAssetGateway,
  PrivateDownloadGrant,
  PrivateUploadGrant,
  RepositoryResult,
  ResolveEventParticipantInput,
  SpeakerAccessScope,
  SpeakerAsset,
  SpeakerAssetComment,
  SpeakerEventResource,
  SpeakerOrganizerAccessScope,
  SpeakerOrganizerReadModel,
  SpeakerOrganizerReadResources,
  SpeakerParticipantResolution,
  SpeakerPortalContext,
  SpeakerProfile,
  SpeakerRepository,
  SpeakerRosterEntry,
  SpeakerSubmission,
  SpeakerTask,
  SpeakerTaskRepositoryCommand,
  SpeakerTaskTransition,
  SpeakerWikiPage,
  TransitionSpeakerTaskCommand,
  UpdateBiographyCommand,
  UpdateSpeakerProfileCommand,
} from "./types";

class FakeSpeakerRepository implements SpeakerRepository {
  readonly scopes = new Map<string, SpeakerAccessScope>();
  readonly submissions: SpeakerSubmission[] = [];
  readonly profiles: SpeakerProfile[] = [];
  readonly tasks: SpeakerTask[] = [];
  readonly assets: SpeakerAsset[] = [];
  readonly comments: SpeakerAssetComment[] = [];
  readonly transitions: SpeakerTaskTransition[] = [];

  getAccessScope(eventId: string, accountId: string): Promise<SpeakerAccessScope> {
    return Promise.resolve(
      this.scopes.get(`${eventId}:${accountId}`) ?? {
        submissionIds: [],
        participantIds: [],
      },
    );
  }
  listPortalCanonicalSessions() {
    return Promise.resolve([]);
  }

  listSubmissions(eventId: string, submissionIds: readonly string[]): Promise<SpeakerSubmission[]> {
    return Promise.resolve(
      this.submissions.filter(
        (submission) => submission.eventId === eventId && submissionIds.includes(submission.id),
      ),
    );
  }

  getSubmission(eventId: string, submissionId: string): Promise<SpeakerSubmission | null> {
    return Promise.resolve(
      this.submissions.find(
        (submission) => submission.eventId === eventId && submission.id === submissionId,
      ) ?? null,
    );
  }

  listProfiles(eventId: string, participantIds: readonly string[]): Promise<SpeakerProfile[]> {
    return Promise.resolve(
      this.profiles.filter(
        (profile) => profile.eventId === eventId && participantIds.includes(profile.participantId),
      ),
    );
  }

  createProfile(candidate: SpeakerProfile): Promise<RepositoryResult<SpeakerProfile>> {
    const exists = this.profiles.some(
      (profile) =>
        profile.eventId === candidate.eventId && profile.participantId === candidate.participantId,
    );
    if (exists) return Promise.resolve({ ok: false, reason: "version_conflict" });
    this.profiles.push(structuredClone(candidate));
    return Promise.resolve({ ok: true, value: structuredClone(candidate) });
  }

  getProfile(eventId: string, participantId: string): Promise<SpeakerProfile | null> {
    return Promise.resolve(
      this.profiles.find(
        (profile) => profile.eventId === eventId && profile.participantId === participantId,
      ) ?? null,
    );
  }

  updateBiography(command: UpdateBiographyCommand): Promise<RepositoryResult<SpeakerProfile>> {
    const index = this.profiles.findIndex(
      (profile) =>
        profile.eventId === command.eventId && profile.participantId === command.participantId,
    );
    const profile = this.profiles[index];
    if (!profile) {
      return Promise.resolve({ ok: false, reason: "not_found" });
    }
    if (profile.version !== command.expectedVersion) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    const updated: SpeakerProfile = {
      ...profile,
      biography: command.biography,
      version: profile.version + 1,
      updatedAt: command.updatedAt,
    };
    this.profiles[index] = updated;
    return Promise.resolve({ ok: true, value: updated });
  }

  updateProfile(command: UpdateSpeakerProfileCommand): Promise<RepositoryResult<SpeakerProfile>> {
    const index = this.profiles.findIndex(
      (profile) =>
        profile.eventId === command.eventId && profile.participantId === command.participantId,
    );
    const current = this.profiles[index];
    if (current === undefined) return Promise.resolve({ ok: false, reason: "not_found" });
    if (current.version !== command.expectedVersion) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    const {
      expectedVersion: _expectedVersion,
      actorAccountId: _actorAccountId,
      updatedAt,
      headshotAssetId,
      ...changes
    } = command;
    const updated: SpeakerProfile = {
      ...current,
      ...changes,
      ...(headshotAssetId === undefined || headshotAssetId === null ? {} : { headshotAssetId }),
      version: current.version + 1,
      updatedAt,
    };
    if (headshotAssetId === null) delete updated.headshotAssetId;
    this.profiles[index] = updated;
    return Promise.resolve({ ok: true, value: structuredClone(updated) });
  }

  listTasks(eventId: string, participantIds: readonly string[]): Promise<SpeakerTask[]> {
    return Promise.resolve(
      this.tasks.filter(
        (task) => task.eventId === eventId && participantIds.includes(task.participantId),
      ),
    );
  }

  getTask(eventId: string, taskId: string): Promise<SpeakerTask | null> {
    return Promise.resolve(
      this.tasks.find((task) => task.eventId === eventId && task.id === taskId) ?? null,
    );
  }

  getTasksByIds(eventId: string, taskIds: readonly string[]): Promise<SpeakerTask[]> {
    return Promise.resolve(
      this.tasks.filter((task) => task.eventId === eventId && taskIds.includes(task.id)),
    );
  }

  transitionTask(
    command: TransitionSpeakerTaskCommand,
  ): Promise<RepositoryResult<{ task: SpeakerTask; transition: SpeakerTaskTransition }>> {
    const index = this.tasks.findIndex(
      (task) => task.eventId === command.eventId && task.id === command.taskId,
    );
    const task = this.tasks[index];
    if (!task) {
      return Promise.resolve({ ok: false, reason: "not_found" });
    }
    if (task.version !== command.expectedVersion) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    if (task.status !== command.fromStatus) {
      return Promise.resolve({ ok: false, reason: "invalid_state" });
    }
    const updated: SpeakerTask = {
      ...task,
      status: command.toStatus,
      version: task.version + 1,
      updatedAt: command.transition.occurredAt,
    };
    this.tasks[index] = updated;
    this.transitions.push(command.transition);
    return Promise.resolve({
      ok: true,
      value: { task: updated, transition: command.transition },
    });
  }

  createPendingAsset(asset: SpeakerAsset): Promise<SpeakerAsset> {
    this.assets.push(asset);
    return Promise.resolve(asset);
  }

  createPendingAssetVersion(
    command: CreatePendingSpeakerAssetVersionCommand,
  ): Promise<RepositoryResult<SpeakerAsset>> {
    const predecessor = this.assets.find(
      (asset) =>
        asset.eventId === command.asset.eventId && asset.id === command.expectedLatestAssetId,
    );
    if (
      predecessor === undefined ||
      predecessor.version !== command.expectedLatestVersion ||
      predecessor.state !== "ready"
    ) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    this.assets.push(command.asset);
    return Promise.resolve({ ok: true, value: command.asset });
  }

  getAsset(eventId: string, assetId: string): Promise<SpeakerAsset | null> {
    return Promise.resolve(
      this.assets.find((asset) => asset.eventId === eventId && asset.id === assetId) ?? null,
    );
  }
  listAssetComments(eventId: string, assetId: string): Promise<SpeakerAssetComment[]> {
    return Promise.resolve(
      this.comments.filter((comment) => comment.eventId === eventId && comment.assetId === assetId),
    );
  }

  createAssetComment(comment: SpeakerAssetComment): Promise<SpeakerAssetComment> {
    this.comments.push(comment);
    return Promise.resolve(comment);
  }
}
class OrganizerSpeakerRepository extends FakeSpeakerRepository {
  readonly organizerScopes = new Map<string, SpeakerOrganizerAccessScope>();
  readonly verifiedEmails = new Map<string, string>();
  readonly participantResolutions = new Map<string, SpeakerParticipantResolution>();
  readonly roster: SpeakerRosterEntry[] = [];
  rosterEventReads = 0;

  getOrganizerAccessScope(
    eventId: string,
    accountId: string,
  ): Promise<SpeakerOrganizerAccessScope | null> {
    return Promise.resolve(this.organizerScopes.get(`${eventId}:${accountId}`) ?? null);
  }

  resolveVerifiedInvitationRecipient(email: string): Promise<{
    userId: string;
    normalizedEmail: string;
  } | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const participantId = [...this.verifiedEmails.entries()].find(
      ([, verifiedEmail]) => verifiedEmail.trim().toLowerCase() === normalizedEmail,
    )?.[0];
    return Promise.resolve(
      participantId === undefined ? null : { userId: `account:${participantId}`, normalizedEmail },
    );
  }

  resolveEventParticipant(
    input: ResolveEventParticipantInput,
  ): Promise<SpeakerParticipantResolution> {
    const configured = this.participantResolutions.get(`${input.sourceType}:${input.sourceId}`);
    if (configured !== undefined) return Promise.resolve(structuredClone(configured));
    const participantId = input.explicitParticipantId ?? input.createParticipantId;
    const submissionIds = this.submissions
      .filter(
        (submission) =>
          submission.eventId === input.eventId && submission.participantIds.includes(participantId),
      )
      .map((submission) => submission.id);
    return Promise.resolve({
      state: "resolved",
      participantId,
      submissionIds,
      created: input.explicitParticipantId === undefined,
    });
  }

  listRoster(eventId: string, submissionId: string): Promise<SpeakerRosterEntry[]> {
    return Promise.resolve(
      this.roster.filter(
        (entry) =>
          entry.eventId === eventId &&
          (entry.submissionId === submissionId ||
            entry.submissionId === `speaker-submission:${submissionId}` ||
            submissionId === `speaker-submission:${entry.submissionId}`),
      ),
    );
  }
  listRosterForEvent(eventId: string): Promise<SpeakerRosterEntry[]> {
    this.rosterEventReads += 1;
    return Promise.resolve(this.roster.filter((entry) => entry.eventId === eventId));
  }

  saveRoster(
    entry: SpeakerRosterEntry,
    expectedVersion: number | null,
  ): Promise<RepositoryResult<SpeakerRosterEntry>> {
    const index = this.roster.findIndex((candidate) => candidate.id === entry.id);
    if (expectedVersion === null) {
      if (index >= 0) return Promise.resolve({ ok: false, reason: "version_conflict" });
      this.roster.push(entry);
      return Promise.resolve({ ok: true, value: entry });
    }
    if (index < 0) return Promise.resolve({ ok: false, reason: "not_found" });
    const current = this.roster[index];
    if (current === undefined || current.version !== expectedVersion) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    this.roster[index] = entry;
    return Promise.resolve({ ok: true, value: entry });
  }

  createTask(command: SpeakerTaskRepositoryCommand): Promise<RepositoryResult<SpeakerTask>> {
    if (command.expectedVersion !== null) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    this.tasks.push(command.task);
    return Promise.resolve({ ok: true, value: command.task });
  }

  updateTask(command: SpeakerTaskRepositoryCommand): Promise<RepositoryResult<SpeakerTask>> {
    if (command.expectedVersion === null) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    const index = this.tasks.findIndex(
      (task) => task.eventId === command.task.eventId && task.id === command.task.id,
    );
    const current = this.tasks[index];
    if (current === undefined) return Promise.resolve({ ok: false, reason: "not_found" });
    if (current.version !== command.expectedVersion) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    this.tasks[index] = structuredClone(command.task);
    return Promise.resolve({ ok: true, value: structuredClone(command.task) });
  }
}
class CountingOrganizerReadModelRepository extends OrganizerSpeakerRepository {
  readonly readModelResources: SpeakerOrganizerReadResources[] = [];
  readModelReads = 0;
  accessScopeReads = 0;
  organizerScopeReads = 0;
  submissionReads = 0;
  rosterReads = 0;
  profileReads = 0;
  taskReads = 0;
  assetReads = 0;

  getOrganizerReadModel(
    eventId: string,
    accountId: string,
    resources: SpeakerOrganizerReadResources,
  ): Promise<SpeakerOrganizerReadModel | null> {
    this.readModelReads += 1;
    this.readModelResources.push({ ...resources });
    const scope = this.organizerScopes.get(`${eventId}:${accountId}`);
    if (scope === undefined) return Promise.resolve(null);
    return Promise.resolve({
      scope,
      submissions: this.submissions.filter((submission) => submission.eventId === eventId),
      roster: this.roster.filter((entry) => entry.eventId === eventId),
      profiles:
        resources.profiles === true
          ? this.profiles.filter((profile) => profile.eventId === eventId)
          : [],
      tasks: resources.tasks === true ? this.tasks.filter((task) => task.eventId === eventId) : [],
      assets:
        resources.assets === true ? this.assets.filter((asset) => asset.eventId === eventId) : [],
      canonicalSessions: [],
    });
  }

  override getAccessScope(eventId: string, accountId: string): Promise<SpeakerAccessScope> {
    this.accessScopeReads += 1;
    return super.getAccessScope(eventId, accountId);
  }

  override getOrganizerAccessScope(
    eventId: string,
    accountId: string,
  ): Promise<SpeakerOrganizerAccessScope | null> {
    this.organizerScopeReads += 1;
    return super.getOrganizerAccessScope(eventId, accountId);
  }

  override listSubmissions(
    eventId: string,
    submissionIds: readonly string[],
  ): Promise<SpeakerSubmission[]> {
    this.submissionReads += 1;
    return super.listSubmissions(eventId, submissionIds);
  }

  override listProfiles(
    eventId: string,
    participantIds: readonly string[],
  ): Promise<SpeakerProfile[]> {
    this.profileReads += 1;
    return super.listProfiles(eventId, participantIds);
  }

  override listTasks(eventId: string, participantIds: readonly string[]): Promise<SpeakerTask[]> {
    this.taskReads += 1;
    return super.listTasks(eventId, participantIds);
  }

  listAssets(eventId: string, participantIds: readonly string[]): Promise<SpeakerAsset[]> {
    this.assetReads += 1;
    return Promise.resolve(
      this.assets.filter(
        (asset) => asset.eventId === eventId && participantIds.includes(asset.participantId),
      ),
    );
  }

  override listRoster(eventId: string, submissionId: string): Promise<SpeakerRosterEntry[]> {
    this.rosterReads += 1;
    return super.listRoster(eventId, submissionId);
  }

  override listRosterForEvent(eventId: string): Promise<SpeakerRosterEntry[]> {
    this.rosterReads += 1;
    return super.listRosterForEvent(eventId);
  }
}
class DelayedOrganizerReadModelRepository extends CountingOrganizerReadModelRepository {
  constructor(private readonly delayMs = 700) {
    super();
  }

  override async getOrganizerReadModel(
    eventId: string,
    accountId: string,
    resources: SpeakerOrganizerReadResources,
  ): Promise<SpeakerOrganizerReadModel | null> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.getOrganizerReadModel(eventId, accountId, resources);
  }
}
class ConcurrentOrganizerRepository extends OrganizerSpeakerRepository {
  submissionReads = 0;
  readonly started = new Set<string>();
  readonly #releases = new Map<string, () => void>();

  private hold<T>(name: string, read: () => Promise<T>): Promise<T> {
    this.started.add(name);
    return new Promise<T>((resolve, reject) => {
      this.#releases.set(name, () => {
        void read().then(resolve, reject);
      });
    });
  }

  releaseReads(): void {
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
  }
  override listSubmissions(
    eventId: string,
    submissionIds: readonly string[],
  ): Promise<SpeakerSubmission[]> {
    this.submissionReads += 1;
    return super.listSubmissions(eventId, submissionIds);
  }

  override listProfiles(
    eventId: string,
    participantIds: readonly string[],
  ): Promise<SpeakerProfile[]> {
    return this.hold("profiles", () => super.listProfiles(eventId, participantIds));
  }

  listAssets(eventId: string, participantIds: readonly string[]): Promise<SpeakerAsset[]> {
    return this.hold("assets", async () =>
      this.assets.filter(
        (asset) => asset.eventId === eventId && participantIds.includes(asset.participantId),
      ),
    );
  }

  override listRosterForEvent(eventId: string): Promise<SpeakerRosterEntry[]> {
    return this.hold("roster", () => super.listRosterForEvent(eventId));
  }
}

class CountingPortalRepository extends OrganizerSpeakerRepository {
  readonly portalContexts: SpeakerPortalContext[] = [];
  readonly resources: SpeakerEventResource[] = [];
  readonly wiki: SpeakerWikiPage[] = [];
  accessScopeReads = 0;
  submissionReads = 0;
  profileReads = 0;
  taskReads = 0;
  contextReads = 0;
  assetReads = 0;
  rosterReads = 0;
  resourceReads = 0;
  wikiReads = 0;

  override getAccessScope(eventId: string, accountId: string): Promise<SpeakerAccessScope> {
    this.accessScopeReads += 1;
    return super.getAccessScope(eventId, accountId);
  }

  override listSubmissions(
    eventId: string,
    submissionIds: readonly string[],
  ): Promise<SpeakerSubmission[]> {
    this.submissionReads += 1;
    return super.listSubmissions(eventId, submissionIds);
  }

  override listProfiles(
    eventId: string,
    participantIds: readonly string[],
  ): Promise<SpeakerProfile[]> {
    this.profileReads += 1;
    return super.listProfiles(eventId, participantIds);
  }

  override listTasks(eventId: string, participantIds: readonly string[]): Promise<SpeakerTask[]> {
    this.taskReads += 1;
    return super.listTasks(eventId, participantIds);
  }

  listPortalContexts(accountId: string): Promise<SpeakerPortalContext[]> {
    this.contextReads += 1;
    return Promise.resolve(accountId === "account-1" ? this.portalContexts : []);
  }
  listPortalCanonicalSessions() {
    return Promise.resolve([]);
  }

  listAssets(eventId: string, participantIds: readonly string[]): Promise<SpeakerAsset[]> {
    this.assetReads += 1;
    return Promise.resolve(
      this.assets.filter(
        (asset) => asset.eventId === eventId && participantIds.includes(asset.participantId),
      ),
    );
  }

  listRoster(eventId: string, submissionId: string): Promise<SpeakerRosterEntry[]> {
    this.rosterReads += 1;
    return super.listRoster(eventId, submissionId);
  }

  listEventResources(eventId: string): Promise<SpeakerEventResource[]> {
    this.resourceReads += 1;
    return Promise.resolve(this.resources.filter((resource) => resource.eventId === eventId));
  }

  listWikiPages(eventId: string): Promise<SpeakerWikiPage[]> {
    this.wikiReads += 1;
    return Promise.resolve(this.wiki.filter((page) => page.eventId === eventId));
  }
}
class DelayedPortalContextRepository extends CountingPortalRepository {
  readonly started: string[] = [];

  private async delayed<T>(name: string, read: () => Promise<T>): Promise<T> {
    this.started.push(name);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return read();
  }

  override listPortalContexts(accountId: string): Promise<SpeakerPortalContext[]> {
    return this.delayed("contexts", () => super.listPortalContexts(accountId));
  }

  override listSubmissions(
    eventId: string,
    submissionIds: readonly string[],
  ): Promise<SpeakerSubmission[]> {
    return this.delayed("submissions", () => super.listSubmissions(eventId, submissionIds));
  }
}
class DelayedPortalWorkspaceRepository extends CountingPortalRepository {
  private async delayed<T>(read: () => Promise<T>): Promise<T> {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return read();
  }

  override getAccessScope(eventId: string, accountId: string): Promise<SpeakerAccessScope> {
    return this.delayed(() => super.getAccessScope(eventId, accountId));
  }

  override listSubmissions(
    eventId: string,
    submissionIds: readonly string[],
  ): Promise<SpeakerSubmission[]> {
    return this.delayed(() => super.listSubmissions(eventId, submissionIds));
  }

  override listProfiles(
    eventId: string,
    participantIds: readonly string[],
  ): Promise<SpeakerProfile[]> {
    return this.delayed(() => super.listProfiles(eventId, participantIds));
  }

  override listTasks(eventId: string, participantIds: readonly string[]): Promise<SpeakerTask[]> {
    return this.delayed(() => super.listTasks(eventId, participantIds));
  }

  override listPortalContexts(accountId: string): Promise<SpeakerPortalContext[]> {
    return this.delayed(() => super.listPortalContexts(accountId));
  }

  override listAssets(eventId: string, participantIds: readonly string[]): Promise<SpeakerAsset[]> {
    return this.delayed(() => super.listAssets(eventId, participantIds));
  }

  override listRoster(eventId: string, submissionId: string): Promise<SpeakerRosterEntry[]> {
    return this.delayed(() => super.listRoster(eventId, submissionId));
  }

  override listRosterForEvent(eventId: string): Promise<SpeakerRosterEntry[]> {
    return this.delayed(() => super.listRosterForEvent(eventId));
  }
}

class FakePrivateAssetGateway implements PrivateAssetGateway {
  readonly uploads: CreatePrivateUploadGrantCommand[] = [];
  readonly downloads: {
    objectKey: string;
    fileName: string;
    expiresAt: string;
  }[] = [];

  createUploadGrant(command: CreatePrivateUploadGrantCommand): Promise<PrivateUploadGrant> {
    this.uploads.push(command);
    return Promise.resolve({
      method: "PUT",
      url: `https://private-upload.invalid/${encodeURIComponent(command.objectKey)}`,
      headers: { "content-type": command.contentType },
      expiresAt: command.expiresAt,
    });
  }

  createDownloadGrant(command: {
    objectKey: string;
    fileName: string;
    expiresAt: string;
  }): Promise<PrivateDownloadGrant> {
    this.downloads.push(command);
    return Promise.resolve({
      url: `https://private-download.invalid/${encodeURIComponent(command.objectKey)}`,
      expiresAt: command.expiresAt,
    });
  }
}

const speakerSender = "speakers@self-hosted.example";
const now = "2026-08-08T12:00:00.000Z";
const speakerEventTemporalSource = {
  getEventTemporalContext(organizationId: string, eventId: string) {
    return Promise.resolve(
      organizationId === "org-1" && eventId === "event-1"
        ? {
            organizationId,
            eventId,
            timeZone: "America/Los_Angeles",
            startsAt: "2026-08-10T16:00:00.000Z",
            endsAt: "2026-08-12T23:00:00.000Z",
          }
        : null,
    );
  },
};

function submission(
  id: string,
  participantId: string,
  status: SpeakerSubmission["status"] = "accepted",
  eventId = "event-1",
): SpeakerSubmission {
  return {
    id,
    eventId,
    title: `Submission ${id}`,
    status,
    participantIds: [participantId],
    updatedAt: now,
  };
}

function profile(participantId: string, eventId = "event-1"): SpeakerProfile {
  return {
    id: `profile-${participantId}`,
    eventId,
    participantId,
    displayName: `Speaker ${participantId}`,
    biography: "Original biography",
    version: 3,
    updatedAt: now,
  };
}

function task(
  input: (Partial<SpeakerTask> & Pick<SpeakerTask, "id" | "participantId">) & {
    sessionId?: string | null;
  },
): SpeakerTask {
  const participantId = input.participantId;
  const sessionId = input.sessionId ?? null;
  const subject =
    input.subject ??
    (sessionId === null
      ? ({ type: "participant", participantId } as const)
      : ({ type: "session", participantId, sessionId } as const));
  return {
    tenantId: "org-1",
    eventId: "event-1",
    subject,
    type: "upload",
    owner: "speaker",
    title: `Task ${input.id}`,
    status: "not_started",
    dependencyIds: [],
    reminderOffsetsMinutes: [],
    version: 0,
    updatedAt: now,
    ...input,
  };
}

function createTestSessionAuthority(
  overrides: Partial<{
    tenantId: string;
    eventId: string;
    status: string;
    speakerIds: readonly string[];
  }> = {},
) {
  return {
    getSession: async (organizationId: string, eventId: string, sessionId: string) =>
      ({
        id: sessionId,
        tenantId: overrides.tenantId ?? organizationId,
        eventId: overrides.eventId ?? eventId,
        status: overrides.status ?? (sessionId.includes("declined") ? "declined" : "accepted"),
        title: "Descriptive accepted session",
        speakerIds:
          overrides.speakerIds ??
          (sessionId.includes("primary")
            ? ["participant-primary", "participant-co"]
            : sessionId.includes("submission-co")
              ? ["participant-co"]
              : sessionId.includes("submission-2")
                ? ["participant-2"]
                : ["participant-1", "participant-2", "participant-other-event"]),
      }) as never,
  };
}
const testSessionAuthority = createTestSessionAuthority();

function createFixture() {
  const repository = new FakeSpeakerRepository();
  const gateway = new FakePrivateAssetGateway();
  repository.scopes.set("event-1:account-1", {
    tenantId: "org-1",
    submissionIds: ["submission-1", "submission-declined"],
    participantIds: ["participant-1"],
    capabilities: [
      "profile-self",
      "task-response",
      "asset-read",
      "asset-write",
      "asset-comment",
      "resource-read",
    ],
  });
  repository.scopes.set("event-1:account-2", {
    tenantId: "org-1",
    submissionIds: ["submission-2"],
    participantIds: ["participant-2"],
    capabilities: [],
  });
  repository.scopes.set("event-2:account-1", {
    submissionIds: ["submission-other-event"],
    participantIds: ["participant-other-event"],
    capabilities: [],
  });
  repository.submissions.push(
    submission("submission-1", "participant-1"),
    submission("submission-2", "participant-2"),
    submission("submission-declined", "participant-1", "declined"),
    submission("submission-other-event", "participant-other-event", "accepted", "event-2"),
  );
  repository.profiles.push(
    profile("participant-1"),
    profile("participant-2"),
    profile("participant-other-event", "event-2"),
  );
  repository.tasks.push(
    task({
      id: "dependency",
      participantId: "participant-1",
      status: "completed",
    }),
    task({
      id: "slides-task",
      participantId: "participant-1",
      dependencyIds: ["dependency"],
      acceptedAssetKinds: ["slides"],
    }),
    task({ id: "action-task", participantId: "participant-1", type: "action" }),
    task({
      id: "organizer-task",
      participantId: "participant-1",
      owner: "organizer",
      type: "action",
    }),
    task({
      id: "declined-task",
      participantId: "participant-1",
      subject: {
        type: "session",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-declined",
      },
    }),
    task({
      id: "other-speaker-task",
      participantId: "participant-2",
      subject: {
        type: "session",
        participantId: "participant-2",
        sessionId: "speaker-submission:submission-2",
      },
    }),
    task({
      id: "other-event-task",
      participantId: "participant-other-event",
      subject: {
        type: "session",
        participantId: "participant-other-event",
        sessionId: "speaker-submission:submission-other-event",
      },
      eventId: "event-2",
    }),
  );

  const acceptedTestSessionAuthority = testSessionAuthority;

  let sequence = 0;
  const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
    speakerSender,
    now: () => new Date(now),
    generateId: () => `generated-${++sequence}`,
    communications: testSpeakerCommunications().communications,
    sessionAuthority: acceptedTestSessionAuthority,
  });
  return { repository, gateway, service };
}
function testSpeakerCommunications(delivery?: CommunicationDeliveryAdapter) {
  const repository = new InMemoryCommunicationRepository({
    recipients: [
      {
        id: "participant-1",
        participantId: "participant-1",
        tenantId: "org-1",
        eventId: "event-1",
        email: "priya@example.test",
        displayName: "Priya Raman",
        audiences: ["all_participants"],
        data: {
          first_name: "Priya",
          display_name: "Priya Raman",
          email: "priya@example.test",
        },
      },
      {
        id: "participant-2",
        participantId: "participant-2",
        tenantId: "org-1",
        eventId: "event-1",
        email: "marcus@example.test",
        displayName: "Marcus Okafor",
        audiences: ["all_participants"],
        data: {
          first_name: "Marcus",
          display_name: "Marcus Okafor",
          email: "marcus@example.test",
        },
      },
    ],
    authorizedAudiences: { "org-1:event-1": ["all_participants"] },
  });
  const service = new CommunicationService(repository, delivery, {
    clock: () => new Date(now),
    senderIdentities: {
      auth: "auth@example.test",
      speakers: speakerSender,
      calendar: "calendar@example.test",
    },
  });
  return {
    repository,
    communications: new CommunicationSpeakerCommunications(service, "https://event.example.test"),
  };
}

function createOrganizerFixture(
  repository: OrganizerSpeakerRepository = new OrganizerSpeakerRepository(),
) {
  repository.organizerScopes.set("event-1:account-1", {
    tenantId: "org-1",
    eventId: "event-1",
    role: "owner",
    submissionIds: ["submission-1", "submission-2"],
    participantIds: ["participant-1", "participant-2"],
  });
  repository.submissions.push(
    submission("submission-1", "participant-1"),
    submission("submission-2", "participant-2"),
  );
  repository.verifiedEmails.set("participant-1", "priya@example.test");
  repository.verifiedEmails.set("participant-2", "marcus@example.test");
  let sequence = 0;
  const gateway = new FakePrivateAssetGateway();
  const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
    speakerSender,
    now: () => new Date(now),
    generateId: () => `generated-${++sequence}`,
    communications: testSpeakerCommunications().communications,
    sessionAuthority: testSessionAuthority,
  });
  return { repository, gateway, service };
}
function createConcurrentOrganizerFixture() {
  const repository = new ConcurrentOrganizerRepository();
  repository.organizerScopes.set("event-1:account-1", {
    tenantId: "org-1",
    eventId: "event-1",
    role: "owner",
    submissionIds: ["submission-1", "submission-declined"],
    participantIds: ["participant-1"],
  });
  repository.submissions.push(
    {
      ...submission("submission-1", "participant-1"),
      title: "Canonical session",
    },
    submission("submission-declined", "participant-1", "declined"),
  );
  repository.profiles.push({
    ...profile("participant-1"),
    displayName: "Profile name",
  });
  repository.roster.push({
    id: "roster:event-1:speaker-submission:submission-1:participant-1",
    eventId: "event-1",
    submissionId: "speaker-submission:submission-1",
    participantId: "participant-1",
    displayName: "Roster name",
    role: "primary",
    status: "active",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  repository.assets.push({
    id: "asset-concurrent",
    tenantId: "org-1",
    eventId: "event-1",
    sessionId: "speaker-submission:submission-1",
    participantId: "participant-1",
    kind: "slides",
    objectKey: "events/event-1/participants/participant-1/slides/asset-concurrent",
    fileName: "slides.pdf",
    contentType: "application/pdf",
    sizeBytes: 1_024,
    state: "ready",
    createdAt: now,
  });
  const service = new SpeakerService(
    withTestSpeakerOrganizerLifecycle(repository),
    new FakePrivateAssetGateway(),
    {
      speakerSender,
      now: () => new Date(now),
      sessionAuthority: testSessionAuthority,
    },
  );
  return { repository, service };
}
function createDualRoleFixture() {
  const { repository, service } = createOrganizerFixture();
  repository.scopes.set("event-1:account-1", {
    tenantId: "org-1",
    submissionIds: ["submission-1"],
    participantIds: ["participant-1"],
    capabilities: ["asset-read", "task-response"],
  });
  repository.profiles.push(profile("participant-1"), profile("participant-2"));
  repository.tasks.push(
    task({ id: "dual-role-task-1", participantId: "participant-1" }),
    task({
      id: "dual-role-task-2",
      participantId: "participant-2",
      sessionId: "speaker-submission:submission-2",
    }),
  );
  repository.assets.push(
    {
      id: "dual-role-asset-1",
      tenantId: "org-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      versionFamilyId: "dual-role-family",
      kind: "slides",
      objectKey: "events/event-1/participants/participant-1/slides/dual-role-asset-1",
      fileName: "participant-1.pdf",
      contentType: "application/pdf",
      sizeBytes: 1_024,
      state: "ready",
      createdAt: now,
    },
    {
      id: "dual-role-asset-2",
      tenantId: "org-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-2",
      participantId: "participant-2",
      kind: "slides",
      objectKey: "events/event-1/participants/participant-2/slides/dual-role-asset-2",
      fileName: "participant-2.pdf",
      contentType: "application/pdf",
      sizeBytes: 1_024,
      state: "ready",
      createdAt: now,
    },
  );
  repository.comments.push(
    {
      id: "dual-role-comment-1",
      eventId: "event-1",
      assetId: "dual-role-asset-1",
      versionId: "dual-role-asset-1",
      body: "Participant one comment",
      authorLabel: "Speaker",
      createdAt: now,
      version: 1,
    },
    {
      id: "dual-role-comment-2",
      eventId: "event-1",
      assetId: "dual-role-asset-2",
      versionId: "dual-role-asset-2",
      body: "Participant two comment",
      authorLabel: "Speaker",
      createdAt: now,
      version: 1,
    },
  );
  return { repository, service };
}
describe("SpeakerService organizer aggregate reads", () => {
  it("uses one authorized read model for the deliverables matrix and selector-specific reads", async () => {
    const repository = new CountingOrganizerReadModelRepository();
    repository.organizerScopes.set("event-1:account-1", {
      tenantId: "org-1",
      eventId: "event-1",
      role: "owner",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
    });
    repository.submissions.push(
      submission("submission-1", "participant-1"),
      submission("submission-declined", "participant-1", "declined"),
      submission("submission-other-event", "participant-2", "accepted", "event-2"),
    );
    repository.profiles.push(profile("participant-1"), profile("participant-2"), {
      ...profile("participant-manual"),
      displayName: "Manual Speaker",
    });
    repository.roster.push({
      id: "manual-roster",
      eventId: "event-1",
      participantId: "participant-manual",
      displayName: "Manual Speaker",
      sourceType: "manual",
      sourceId: "manual",
      workflowStatus: "pending",
      organizerStatus: "pending",
      role: "primary",
      status: "pending",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    repository.tasks.push(
      task({
        id: "accepted-task",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-1",
      }),
      task({
        id: "action-task",
        participantId: "participant-1",
        type: "action",
      }),
      task({
        id: "manual-task",
        participantId: "participant-manual",
        sessionId: null,
      }),
      task({
        id: "declined-task",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-declined",
      }),
      task({
        id: "other-participant-task",
        participantId: "participant-2",
        sessionId: "speaker-submission:submission-other-event",
      }),
    );
    repository.assets.push(
      {
        id: "accepted-asset",
        tenantId: "org-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "accepted-task",
        kind: "slides",
        objectKey: "events/event-1/accepted",
        fileName: "accepted.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        state: "ready",
        createdAt: now,
      },
      {
        id: "manual-asset",
        tenantId: "org-1",
        eventId: "event-1",
        participantId: "participant-manual",
        taskId: "manual-task",
        kind: "slides",
        objectKey: "events/event-1/manual",
        fileName: "manual.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        state: "ready",
        createdAt: now,
      },
      {
        id: "declined-asset",
        tenantId: "org-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-declined",
        participantId: "participant-1",
        taskId: "declined-task",
        kind: "slides",
        objectKey: "events/event-1/declined",
        fileName: "declined.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        state: "ready",
        createdAt: now,
      },
      {
        id: "other-tenant-asset",
        tenantId: "org-2",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "accepted-task",
        kind: "slides",
        objectKey: "events/event-1/other-tenant",
        fileName: "other.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        state: "ready",
        createdAt: now,
      },
    );
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
        sessionAuthority: testSessionAuthority,
      },
    );

    const matrix = await service.listDeliverables("event-1", "account-1");
    expect(matrix.items.map((item) => item.task.id)).toEqual(["accepted-task", "manual-task"]);
    expect(matrix.items.some((item) => item.task.type !== "upload")).toBe(false);
    expect(matrix.items.flatMap((item) => item.assets.map((asset) => asset.id))).toEqual([
      "accepted-asset",
      "manual-asset",
    ]);
    expect(repository.readModelReads).toBe(1);
    expect(repository.readModelResources).toEqual([{ profiles: true, tasks: true, assets: true }]);
    expect(repository.organizerScopeReads).toBe(0);
    expect(repository.accessScopeReads).toBe(0);
    expect(repository.submissionReads).toBe(0);
    expect(repository.rosterReads).toBe(0);
    expect(repository.profileReads).toBe(0);
    expect(repository.taskReads).toBe(0);
    expect(repository.assetReads).toBe(0);

    await expect(service.listOrganizerProfiles("event-1", "account-1")).resolves.toEqual([
      expect.objectContaining({ participantId: "participant-1" }),
      expect.objectContaining({ participantId: "participant-manual" }),
    ]);
    await expect(service.listOrganizerAssets("event-1", "account-1")).resolves.toEqual([
      expect.objectContaining({
        id: "accepted-asset",
        sessionId: "speaker-submission:submission-1",
        sessionTitle: "Descriptive accepted session",
      }),
      expect.objectContaining({
        id: "manual-asset",
        participantName: "Manual Speaker",
      }),
    ]);
    expect(repository.readModelResources).toEqual([
      { profiles: true, tasks: true, assets: true },
      { profiles: true },
      { profiles: true, assets: true },
    ]);
    expect(repository.readModelReads).toBe(3);
    expect(repository.organizerScopeReads).toBe(0);
    expect(repository.submissionReads).toBe(0);
    expect(repository.rosterReads).toBe(0);
    expect(repository.profileReads).toBe(0);
    expect(repository.taskReads).toBe(0);
    expect(repository.assetReads).toBe(0);
  });
});
describe("SpeakerService organizer roster read model", () => {
  it("uses one delayed read-model wave for the complete authorized roster", async () => {
    const repository = new DelayedOrganizerReadModelRepository();
    repository.organizerScopes.set("event-1:account-1", {
      tenantId: "org-1",
      eventId: "event-1",
      role: "owner",
      submissionIds: ["submission-1", "submission-2", "submission-declined"],
      participantIds: ["participant-1", "participant-2"],
    });
    repository.submissions.push(
      {
        ...submission("submission-1", "participant-1"),
        title: "Shared session",
      },
      {
        ...submission("submission-2", "participant-2"),
        title: "Shared session",
      },
      submission("submission-declined", "participant-1", "declined"),
    );
    repository.profiles.push(
      {
        ...profile("participant-1"),
        displayName: "Shared Speaker",
        email: "shared@example.test",
      },
      {
        ...profile("participant-2"),
        displayName: "Shared Speaker",
        email: "SHARED@example.test",
      },
      { ...profile("participant-manual"), displayName: "Manual Speaker" },
    );
    repository.roster.push(
      {
        id: "roster-1",
        eventId: "event-1",
        submissionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        displayName: "Shared Speaker",
        email: "shared@example.test",
        role: "primary",
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "roster-2",
        eventId: "event-1",
        submissionId: "speaker-submission:submission-2",
        participantId: "participant-2",
        displayName: "Shared Speaker",
        email: "SHARED@example.test",
        role: "primary",
        status: "active",
        version: 2,
        createdAt: now,
        updatedAt: "2026-08-08T12:01:00.000Z",
      },
      {
        id: "roster-manual",
        eventId: "event-1",
        participantId: "participant-manual",
        displayName: "Manual Speaker",
        sourceType: "manual",
        sourceId: "manual",
        workflowStatus: "pending",
        organizerStatus: "pending",
        role: "primary",
        status: "pending",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    );
    repository.tasks.push(
      task({
        id: "task-complete",
        participantId: "participant-1",
        type: "action",
        status: "completed",
      }),
      task({
        id: "task-pending",
        participantId: "participant-1",
        type: "action",
      }),
      task({
        id: "task-second",
        participantId: "participant-2",
        sessionId: "speaker-submission:submission-2",
        type: "action",
      }),
      task({
        id: "task-upload",
        participantId: "participant-1",
      }),
      task({
        id: "task-manual",
        participantId: "participant-manual",
        sessionId: null,
        type: "action",
      }),
      task({
        id: "task-organizer-owned",
        participantId: "participant-1",
        owner: "organizer",
        type: "action",
      }),
      task({
        id: "task-declined",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-declined",
      }),
      task({
        id: "task-other-event",
        participantId: "participant-1",
        eventId: "event-2",
      }),
    );
    repository.assets.push(
      {
        id: "asset-accepted",
        tenantId: "org-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "task-upload",
        kind: "slides",
        objectKey: "events/event-1/accepted",
        fileName: "accepted.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        state: "ready",
        createdAt: now,
      },
      {
        id: "asset-manual",
        tenantId: "org-1",
        eventId: "event-1",
        participantId: "participant-manual",
        taskId: "task-manual",
        kind: "slides",
        objectKey: "events/event-1/manual",
        fileName: "manual.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        state: "ready",
        createdAt: now,
      },
      {
        id: "asset-foreign-tenant",
        tenantId: "org-2",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        kind: "slides",
        objectKey: "events/event-1/foreign",
        fileName: "foreign.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        state: "ready",
        createdAt: now,
      },
      {
        id: "asset-declined",
        tenantId: "org-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-declined",
        participantId: "participant-1",
        kind: "slides",
        objectKey: "events/event-1/declined",
        fileName: "declined.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        state: "ready",
        createdAt: now,
      },
    );
    const fallbackRepository = new OrganizerSpeakerRepository();
    const organizerScope = repository.organizerScopes.get("event-1:account-1");
    if (organizerScope === undefined) throw new Error("Expected an organizer scope fixture.");
    fallbackRepository.organizerScopes.set("event-1:account-1", structuredClone(organizerScope));
    fallbackRepository.submissions.push(...structuredClone(repository.submissions));
    fallbackRepository.profiles.push(...structuredClone(repository.profiles));
    fallbackRepository.roster.push(...structuredClone(repository.roster));
    fallbackRepository.tasks.push(...structuredClone(repository.tasks));
    fallbackRepository.assets.push(...structuredClone(repository.assets));
    const fallbackService = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(fallbackRepository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
        sessionAuthority: testSessionAuthority,
      },
    );
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
        sessionAuthority: testSessionAuthority,
      },
    );

    const startedAt = Date.now();
    const roster = await service.listOrganizerSpeakerRoster("org-1", "event-1", "account-1");

    expect(Date.now() - startedAt).toBeLessThan(1_300);
    expect(repository.readModelReads).toBe(1);
    expect(repository.readModelResources).toEqual([{ profiles: true, tasks: true, assets: true }]);
    expect(repository.organizerScopeReads).toBe(0);
    expect(repository.submissionReads).toBe(0);
    expect(repository.rosterReads).toBe(0);
    expect(repository.profileReads).toBe(0);
    expect(repository.taskReads).toBe(0);
    expect(repository.assetReads).toBe(0);
    expect(roster.organizationId).toBe("org-1");
    expect(roster.speakers).toHaveLength(3);
    expect(roster.speakers.map((speaker) => speaker.participantId)).toEqual([
      "participant-manual",
      "participant-1",
      "participant-2",
    ]);
    const shared = roster.speakers.find((speaker) => speaker.participantId === "participant-1");
    expect(shared).toMatchObject({
      displayName: "Shared Speaker",
      sessions: [],
      taskSummary: { total: 2, completed: 1, overdue: 0 },
      assets: [expect.objectContaining({ assetId: "asset-accepted" })],
    });
    expect(shared?.assets.map((asset) => asset.assetId)).toEqual(["asset-accepted"]);
    const manual = roster.speakers.find(
      (speaker) => speaker.participantId === "participant-manual",
    );
    expect(manual).toMatchObject({
      status: "pending",
      sessions: [],
      taskSummary: { total: 1, completed: 0, overdue: 0 },
      assets: [expect.objectContaining({ assetId: "asset-manual" })],
    });
    await expect(
      fallbackService.listOrganizerSpeakerRoster("org-1", "event-1", "account-1"),
    ).resolves.toEqual(roster);
  });

  it("denies a wrong-tenant or reviewer read-model scope without fallback reads", async () => {
    const repository = new DelayedOrganizerReadModelRepository(1);
    repository.organizerScopes.set("event-1:account-1", {
      tenantId: "other-org",
      eventId: "event-1",
      role: "owner",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
    });
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
      },
    );
    await expect(
      service.listOrganizerSpeakerRoster("org-1", "event-1", "account-1"),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
    expect(repository.readModelReads).toBe(1);
    expect(repository.organizerScopeReads).toBe(0);
    expect(repository.submissionReads).toBe(0);
    expect(repository.rosterReads).toBe(0);
    expect(repository.profileReads).toBe(0);
    expect(repository.taskReads).toBe(0);
    expect(repository.assetReads).toBe(0);

    const reviewerRepository = new DelayedOrganizerReadModelRepository(1);
    reviewerRepository.organizerScopes.set("event-1:account-1", {
      tenantId: "org-1",
      eventId: "event-1",
      role: "reviewer" as unknown as "owner",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
    });
    const reviewerService = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(reviewerRepository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
      },
    );
    await expect(
      reviewerService.listOrganizerSpeakerRoster("org-1", "event-1", "account-1"),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
    expect(reviewerRepository.readModelReads).toBe(1);
    expect(reviewerRepository.organizerScopeReads).toBe(0);
    expect(reviewerRepository.submissionReads).toBe(0);
    expect(reviewerRepository.rosterReads).toBe(0);
    expect(reviewerRepository.profileReads).toBe(0);
    expect(reviewerRepository.taskReads).toBe(0);
    expect(reviewerRepository.assetReads).toBe(0);
  });
});
describe("SpeakerService organizer asset reads", () => {
  it("derives the same event-scoped organizer-managed visibility and roster-fallback names for read-model and fallback paths", async () => {
    const configure = (repository: OrganizerSpeakerRepository): void => {
      repository.organizerScopes.set("event-1:account-1", {
        tenantId: "org-1",
        eventId: "event-1",
        role: "owner",
        submissionIds: ["submission-1"],
        participantIds: ["participant-1"],
      });
      repository.submissions.push(submission("submission-1", "participant-1"));
      repository.profiles.push(profile("participant-1"));
      repository.roster.push(
        {
          id: "manual-event-1",
          eventId: "event-1",
          participantId: "participant-manual",
          displayName: "Roster Fallback Name",
          sourceType: "manual",
          sourceId: "manual-event-1",
          organizerStatus: "pending",
          role: "primary",
          status: "pending",
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "manual-event-2",
          eventId: "event-2",
          participantId: "participant-cross-event",
          displayName: "Cross Event Speaker",
          sourceType: "manual",
          sourceId: "manual-event-2",
          organizerStatus: "pending",
          role: "primary",
          status: "pending",
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      );
      repository.assets.push(
        {
          id: "asset-manual",
          tenantId: "org-1",
          eventId: "event-1",
          participantId: "participant-manual",
          kind: "slides",
          objectKey: "events/event-1/manual",
          fileName: "manual.pdf",
          contentType: "application/pdf",
          sizeBytes: 10,
          state: "ready",
          createdAt: now,
        },
        {
          id: "asset-cross-event-roster",
          tenantId: "org-1",
          eventId: "event-1",
          participantId: "participant-cross-event",
          kind: "slides",
          objectKey: "events/event-1/cross-event",
          fileName: "cross-event.pdf",
          contentType: "application/pdf",
          sizeBytes: 10,
          state: "ready",
          createdAt: now,
        },
      );
    };
    const readModelRepository = new CountingOrganizerReadModelRepository();
    configure(readModelRepository);
    readModelRepository.getOrganizerReadModel = async (eventId, accountId, resources) => ({
      scope: readModelRepository.organizerScopes.get(
        `${eventId}:${accountId}`,
      ) as SpeakerOrganizerAccessScope,
      submissions: readModelRepository.submissions,
      roster: readModelRepository.roster,
      profiles: resources.profiles === true ? readModelRepository.profiles : [],
      tasks: [],
      assets: resources.assets === true ? readModelRepository.assets : [],
      canonicalSessions: [],
    });
    const fallbackRepository = new OrganizerSpeakerRepository();
    configure(fallbackRepository);
    fallbackRepository.listRosterForEvent = () => Promise.resolve(fallbackRepository.roster);
    const readModelService = new SpeakerService(
      readModelRepository,
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
      },
    );
    const fallbackService = new SpeakerService(fallbackRepository, new FakePrivateAssetGateway(), {
      speakerSender,
      now: () => new Date(now),
    });

    const readModelAssets = await readModelService.listOrganizerAssets("event-1", "account-1");
    const fallbackAssets = await fallbackService.listOrganizerAssets("event-1", "account-1");

    expect(readModelAssets).toEqual(fallbackAssets);
    expect(readModelAssets).toEqual([
      expect.objectContaining({
        id: "asset-manual",
        participantName: "Roster Fallback Name",
      }),
    ]);
  });

  it("keeps organizer assets bounded to accepted submissions and the authorized tenant", async () => {
    const { repository, service } = createConcurrentOrganizerFixture();
    repository.assets.push(
      {
        id: "asset-other-tenant",
        tenantId: "other-org",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        kind: "slides",
        objectKey: "events/event-1/other/asset-other-tenant",
        fileName: "other.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        state: "ready",
        createdAt: now,
      },
      {
        id: "asset-other-event",
        tenantId: "org-1",
        eventId: "event-2",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        kind: "slides",
        objectKey: "events/event-2/asset-other-event",
        fileName: "other-event.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        state: "ready",
        createdAt: now,
      },
      {
        id: "asset-declined",
        tenantId: "org-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-declined",
        participantId: "participant-1",
        kind: "slides",
        objectKey: "events/event-1/asset-declined",
        fileName: "declined.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        state: "ready",
        createdAt: now,
      },
    );

    const pending = service.listOrganizerAssets("event-1", "account-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    repository.releaseReads();
    await expect(pending).resolves.toEqual([expect.objectContaining({ id: "asset-concurrent" })]);
  });
  it("authorizes manual-speaker asset metadata, history, comments, and explicit downloads", async () => {
    const { repository, gateway, service } = createOrganizerFixture();
    await service.createOrganizerSpeaker({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      displayName: "Avery Chen",
      email: "avery@example.test",
      jobTitle: "Staff Engineer",
      company: "Newco",
      biography: "Builds distributed systems.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "manual-asset-speaker",
    });
    const manual = repository.roster[0];
    if (manual === undefined) throw new Error("Expected a persisted manual speaker.");
    repository.assets.push(
      {
        id: "manual-slides-v1",
        tenantId: "org-1",
        eventId: "event-1",
        ...(manual.submissionId === undefined ? {} : { sessionId: manual.submissionId }),
        participantId: manual.participantId,
        taskId: "manual-slides-task",
        versionFamilyId: "manual-slides",
        version: 1,
        commentThreadId: "manual-slides",
        kind: "slides",
        objectKey: "events/event-1/manual/slides-v1",
        fileName: "slides-v1.pdf",
        contentType: "application/pdf",
        sizeBytes: 1_024,
        state: "ready",
        finalizedAt: now,
        createdAt: now,
      },
      {
        id: "manual-slides-v2",
        tenantId: "org-1",
        eventId: "event-1",
        ...(manual.submissionId === undefined ? {} : { sessionId: manual.submissionId }),
        participantId: manual.participantId,
        taskId: "manual-slides-task",
        versionFamilyId: "manual-slides",
        supersedesAssetId: "manual-slides-v1",
        version: 2,
        commentThreadId: "manual-slides",
        reviewState: "needs_changes",
        reviewNote: "Update the closing slide.",
        kind: "slides",
        objectKey: "events/event-1/manual/slides-v2",
        fileName: "slides-v2.pdf",
        contentType: "application/pdf",
        sizeBytes: 2_048,
        state: "ready",
        finalizedAt: now,
        createdAt: now,
      },
    );

    const metadata = await service.listOrganizerSpeakerAssets(
      "org-1",
      "event-1",
      "account-1",
      manual.participantId,
    );
    expect(metadata).toEqual([
      expect.objectContaining({
        assetId: "manual-slides-v1",
        eventId: "event-1",
        participantId: manual.participantId,
        taskId: "manual-slides-task",
        kind: "slides",
        version: 1,
        versionFamilyId: "manual-slides",
        commentThreadId: "manual-slides",
        downloadUrl: null,
      }),
      expect.objectContaining({
        assetId: "manual-slides-v2",
        version: 2,
        supersedesAssetId: "manual-slides-v1",
        reviewState: "needs_changes",
        reviewNote: "Update the closing slide.",
        downloadUrl: null,
      }),
    ]);
    const versionTwo = repository.assets.find((asset) => asset.id === "manual-slides-v2");
    if (versionTwo === undefined) throw new Error("Expected the second asset version.");
    repository.assets.push(
      { ...versionTwo, id: "manual-slides-cross-task", taskId: "other-task", version: 3 },
      {
        ...versionTwo,
        id: "manual-slides-cross-session",
        sessionId: "another-session",
        version: 3,
      },
    );

    const history = await service.listOrganizerAssetHistory(
      "event-1",
      "account-1",
      "manual-slides-v2",
    );
    expect(history.map((asset) => asset.id)).toEqual(["manual-slides-v1", "manual-slides-v2"]);

    const comment = await service.addOrganizerAssetComment({
      eventId: "event-1",
      accountId: "account-1",
      assetId: "manual-slides-v2",
      body: "The closing slide is ready for another review.",
    });
    expect(comment).toMatchObject({
      eventId: "event-1",
      assetId: "manual-slides-v2",
      version: 1,
    });
    await expect(
      service.listOrganizerAssetComments("event-1", "account-1", "manual-slides-v2"),
    ).resolves.toEqual([expect.objectContaining({ id: comment.id })]);

    const grant = await service.issueOrganizerDownloadGrant({
      eventId: "event-1",
      accountId: "account-1",
      assetId: "manual-slides-v2",
    });
    expect(grant.url).toContain("private-download.invalid");
    expect(gateway.downloads).toHaveLength(1);
  });
});
describe("SpeakerService organizer speaker writes", () => {
  it.each(["manual", "cfp", "csv", "crm"] as const)(
    "uses the authoritative %s source relationship for canonical participant identity",
    async (sourceType) => {
      const { repository, service } = createOrganizerFixture();
      repository.participantResolutions.set(`${sourceType}:external-${sourceType}`, {
        state: "resolved",
        participantId: "participant-1",
        submissionIds: ["submission-1"],
        created: false,
      });

      const roster = await service.createOrganizerSpeaker({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        displayName: `Candidate ${sourceType}`,
        email: `${sourceType}@example.test`,
        jobTitle: "Speaker",
        company: "Example",
        biography: "Candidate metadata does not select the identity.",
        socialLinks: {},
        status: "pending",
        idempotencyKey: `identity-${sourceType}`,
        sourceType,
        sourceId: `external-${sourceType}`,
      });

      expect(roster.speakers).toEqual([
        expect.objectContaining({
          eventId: "event-1",
          participantId: "participant-1",
        }),
      ]);
    },
  );
  it("replays canonical saves by accepted identity and returns one task per assignee", async () => {
    const { repository, service } = createOrganizerFixture();
    const baseInput = {
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      jobTitle: "Principal Engineer",
      company: "Latticework Systems",
      biography: "Builds reliable developer platforms.",
      socialLinks: {},
      status: "pending",
      sourceType: "cfp",
    } as const;
    const first = await service.createOrganizerSpeaker({
      ...baseInput,
      displayName: "Priya Raman",
      email: "PRIYA@example.test",
      idempotencyKey: "manual-priya",
      sourceId: "submission-1:participant-1",
      explicitParticipantId: "participant-1",
    });
    const replay = await service.createOrganizerSpeaker({
      ...baseInput,
      displayName: "Priya Raman",
      email: "priya@example.test",
      idempotencyKey: "manual-priya",
      sourceId: "submission-1:participant-1",
      explicitParticipantId: "participant-1",
    });
    const second = await service.createOrganizerSpeaker({
      ...baseInput,
      displayName: "Marcus Okafor",
      email: "marcus@example.test",
      idempotencyKey: "manual-marcus",
      sourceId: "submission-2:participant-2",
      explicitParticipantId: "participant-2",
    });
    expect(first.speakers.map((speaker) => speaker.participantId)).toEqual(["participant-1"]);
    expect(replay.speakers.map((speaker) => speaker.participantId)).toEqual(["participant-1"]);
    expect(new Set(second.speakers.map((speaker) => speaker.participantId))).toEqual(
      new Set(["participant-1", "participant-2"]),
    );
    expect(repository.roster).toHaveLength(2);
    expect(repository.roster.map((entry) => entry.submissionId)).toEqual([
      "submission-1",
      "submission-2",
    ]);

    const taskEnvelope = await service.assignOrganizerSpeakerTask({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      title: "Confirm participation",
      description: "General speaker onboarding task.",
      dueAt: "2027-04-01",
      assignments: [
        { participantId: "participant-1", subject: { type: "participant" } },
        { participantId: "participant-2", subject: { type: "participant" } },
      ],
    });
    expect(taskEnvelope.tasks.map((task) => task.participantId)).toEqual([
      "participant-1",
      "participant-2",
    ]);
    expect(new Set(taskEnvelope.tasks.map((task) => task.definitionId))).toEqual(
      new Set([taskEnvelope.tasks[0]?.definitionId]),
    );
    expect(taskEnvelope.tasks[0]?.definitionId).toBeTruthy();
    expect(taskEnvelope.organizationId).toBe("org-1");
    expect(taskEnvelope.eventId).toBe("event-1");
  });

  it("updates from one organizer projection and returns the persisted profile", async () => {
    const repository = new CountingOrganizerReadModelRepository();
    repository.organizerScopes.set("event-1:account-1", {
      tenantId: "org-1",
      eventId: "event-1",
      role: "owner",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
    });
    repository.submissions.push(submission("submission-1", "participant-1"));
    repository.profiles.push({
      ...profile("participant-1"),
      displayName: "Old Name",
      email: "old@example.test",
      jobTitle: "Old Title",
      company: "Old Company",
      biography: "Old biography",
      version: 4,
    });
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
      },
    );

    const updated = await service.updateOrganizerSpeaker({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      expectedVersion: 4,
      displayName: "Persisted Name",
      email: "persisted@example.test",
      jobTitle: "Persisted Title",
      company: "Persisted Company",
      biography: "Persisted biography",
      socialLinks: { website: "https://persisted.example.test" },
      status: "confirmed",
    });

    expect(updated.speakers).toEqual([
      expect.objectContaining({
        participantId: "participant-1",
        displayName: "Persisted Name",
        email: "persisted@example.test",
        jobTitle: "Persisted Title",
        company: "Persisted Company",
        biography: "Persisted biography",
        status: "confirmed",
        version: 5,
      }),
    ]);
    expect(repository.roster).toEqual([
      expect.objectContaining({ participantId: "participant-1", version: 5 }),
    ]);
    expect(repository.readModelReads).toBe(2);
    expect(repository.readModelResources).toEqual([
      { profiles: true, tasks: true, assets: true },
      { profiles: true, tasks: true, assets: true },
    ]);
    expect(repository.rosterReads).toBe(0);
    expect(repository.profileReads).toBe(0);
  });
  it("reloads organizer profile and travel edits from the canonical event-scoped profile", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.profiles.push({
      ...profile("participant-1"),
      displayName: "Priya Raman",
      email: "priya@example.test",
      biography: "Old biography",
      version: 1,
    });
    repository.roster.push({
      id: "roster:event-1:speaker-submission:submission-1:participant-1",
      eventId: "event-1",
      submissionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      displayName: "Stale roster name",
      biography: "Stale roster biography",
      organizerStatus: "accepted",
      role: "primary",
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    await service.updateOrganizerProfile({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      biography: "SBEK-ORG-EDIT-01",
      travelLogistics: {
        travelRequired: true,
        arrivalAt: "2027-05-01",
        dietaryRequirements: "Vegan",
        travelNotes: "Arrive before check-in.",
      },
      expectedVersion: 1,
    });

    const reloaded = await service.listOrganizerSpeakerRoster("org-1", "event-1", "account-1");
    expect(reloaded.speakers).toEqual([
      expect.objectContaining({
        participantId: "participant-1",
        biography: "SBEK-ORG-EDIT-01",
        travelLogistics: expect.objectContaining({
          travelRequired: true,
          arrivalAt: "2027-05-01",
          dietaryRequirements: "Vegan",
          travelNotes: "Arrive before check-in.",
        }),
        version: 1,
      }),
    ]);
  });
  it("rejects an aggregate organizer write when the profile revision is stale", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.roster.push({
      id: "roster:event-1:speaker-submission:submission-1:participant-1",
      eventId: "event-1",
      submissionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      displayName: "Priya Raman",
      email: "priya@example.test",
      role: "primary",
      status: "active",
      version: 2,
      createdAt: now,
      updatedAt: now,
    });
    repository.profiles.push({
      ...profile("participant-1"),
      email: "priya@example.test",
      version: 3,
    });

    await expect(
      service.updateOrganizerSpeaker({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        expectedVersion: 2,
        displayName: "Priya Raman",
        email: "priya@example.test",
        jobTitle: "Principal Engineer",
        company: "Latticework Systems",
        biography: "Must not be persisted.",
        socialLinks: {},
        status: "confirmed",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "VERSION_CONFLICT");
      return true;
    });
    expect(repository.roster[0]?.version).toBe(2);
    expect(repository.profiles[0]?.version).toBe(3);
  });
  it("persists manual speakers, profile changes, and single-assignee task changes across services", async () => {
    const { repository, gateway, service } = createOrganizerFixture();
    const created = await service.createOrganizerSpeaker({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      displayName: "Avery Chen",
      email: "avery@example.test",
      jobTitle: "Staff Engineer",
      company: "Newco",
      biography: "Builds distributed systems.",
      socialLinks: { website: "https://avery.example.test" },
      status: "pending",
      idempotencyKey: "manual-avery",
    });
    const manual = created.speakers.find((speaker) => speaker.email === "avery@example.test");
    expect(manual).toMatchObject({
      participantId: "participant:generated-1",
      status: "pending",
      version: 1,
    });
    expect(repository.roster[0]).toMatchObject({
      participantId: "participant:generated-1",
      sourceType: "manual",
      workflowStatus: "pending",
      organizerStatus: "pending",
    });
    expect(repository.roster[0]?.submissionId).toBeUndefined();
    expect(repository.profiles[0]).toMatchObject({
      participantId: "participant:generated-1",
      email: "avery@example.test",
      version: 1,
    });

    const updated = await service.updateOrganizerSpeaker({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant:generated-1",
      expectedVersion: 1,
      displayName: "Avery Chen",
      email: "avery@example.test",
      jobTitle: "Principal Engineer",
      company: "Newco",
      biography: "Builds durable distributed systems.",
      socialLinks: { website: "https://avery.example.test" },
      travelLogistics: { travelRequired: true, dietaryRequirements: "Vegan" },
      status: "confirmed",
    });
    expect(updated.speakers[0]).toMatchObject({
      participantId: "participant:generated-1",
      status: "confirmed",
      version: 2,
      travelLogistics: { travelRequired: true, dietaryRequirements: "Vegan" },
    });
    expect(repository.profiles[0]).toMatchObject({
      jobTitle: "Principal Engineer",
      status: "confirmed",
      version: 2,
      travelLogistics: { travelRequired: true, dietaryRequirements: "Vegan" },
    });

    const assignment = await service.assignOrganizerSpeakerTask({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      title: "Confirm travel",
      description: "Confirm the travel plan.",
      dueAt: "2027-04-01",
      assignments: [
        {
          participantId: "participant:generated-1",
          subject: { type: "participant" },
        },
      ],
    });
    const assignedTask = assignment.tasks[0];
    expect(assignedTask).toMatchObject({
      participantId: "participant:generated-1",
      title: "Confirm travel",
      status: "not_started",
      version: 1,
    });
    expect(repository.tasks[0]?.subject).toEqual({
      type: "participant",
      participantId: "participant:generated-1",
    });

    const changedTask = await service.updateOrganizerSpeakerTask({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      taskId: assignedTask?.taskId ?? "",
      expectedVersion: 1,
      title: "Confirm final travel",
      status: "completed",
    });
    expect(changedTask.tasks[0]).toMatchObject({
      participantId: "participant:generated-1",
      title: "Confirm final travel",
      status: "completed",
      version: 2,
    });

    const restarted = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      now: () => new Date(now),
      generateId: () => "restarted",
    });
    const persistedRoster = await restarted.listOrganizerSpeakerRoster(
      "org-1",
      "event-1",
      "account-1",
    );
    expect(persistedRoster.speakers[0]).toMatchObject({
      participantId: "participant:generated-1",
      status: "confirmed",
      version: 2,
    });
    const persistedTasks = await restarted.listOrganizerSpeakerTasks(
      "org-1",
      "event-1",
      "account-1",
      "participant:generated-1",
    );
    expect(persistedTasks.tasks).toEqual([
      expect.objectContaining({
        participantId: "participant:generated-1",
        title: "Confirm final travel",
        status: "completed",
        version: 2,
      }),
    ]);
    await expect(
      restarted.listOrganizerSpeakerSessions(
        "org-1",
        "event-1",
        "account-1",
        "participant:generated-1",
      ),
    ).resolves.toEqual([]);
  });
  it("imports new manual speakers once and replays the import without duplicates", async () => {
    const { repository, service } = createOrganizerFixture();
    const preview = await service.previewSpeakerImport({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      csv: [
        "displayName,email,jobTitle,company,biography,status",
        "Jordan Lee,jordan@example.test,Developer Advocate,Example Co,Builds developer communities,confirmed",
        "Sam Rivera,sam@example.test,Staff Engineer,Example Co,Builds reliable APIs,pending",
      ].join("\n"),
    });
    expect(preview.invalidRows).toEqual([]);
    expect(preview.validRows).toHaveLength(2);
    if (preview.previewId === undefined || preview.sourceDigest === undefined) {
      throw new Error("Expected a durable speaker import preview.");
    }

    const first = await service.commitSpeakerImport({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      previewId: preview.previewId,
      sourceDigest: preview.sourceDigest,
      idempotencyKey: "manual-import-once",
    });
    const replay = await service.commitSpeakerImport({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      previewId: preview.previewId,
      sourceDigest: preview.sourceDigest,
      idempotencyKey: "manual-import-once",
    });

    expect(first.speakers.map((speaker) => speaker.email)).toEqual([
      "jordan@example.test",
      "sam@example.test",
    ]);
    expect(replay).toEqual(first);
    expect(repository.roster).toHaveLength(2);
    expect(repository.profiles).toHaveLength(2);
    expect(new Set(repository.roster.map((entry) => entry.participantId)).size).toBe(2);
  });
  it("does not create organizer tasks from stale profile projections", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.organizerScopes.set("event-1:account-1", {
      tenantId: "org-1",
      eventId: "event-1",
      role: "owner",
      submissionIds: ["submission-1", "submission-2", "stale-submission"],
      participantIds: ["participant-1", "participant-2", "participant-stale"],
    });
    repository.profiles.push(profile("participant-stale"));
    const legacySubmission = repository.submissions.find(
      (candidate) => candidate.id === "submission-1",
    );
    if (legacySubmission === undefined) throw new Error("Expected the legacy submission fixture.");
    legacySubmission.title = legacySubmission.id;
    repository.submissions.push({
      ...submission("speaker-submission:submission-1", "participant-1"),
      title: "Descriptive accepted session",
    });

    expect(
      (await service.listOrganizerProfiles("event-1", "account-1")).map(
        (candidate) => candidate.participantId,
      ),
    ).toEqual([]);

    await expect(
      service.createOrganizerTask({
        eventId: "event-1",
        accountId: "account-1",
        type: "action",
        title: "Stale assignment",
        description: "Must not be assigned.",
        dueAt: "2027-04-01",
        assignments: [
          {
            participantId: "participant-stale",
            subject: {
              type: "session",
              sessionId: "speaker-submission:session-stale",
            },
          },
        ],
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });

    const [task] = await service.createOrganizerTask({
      eventId: "event-1",
      accountId: "account-1",
      type: "action",
      title: "Canonical assignment",
      description: "Use the accepted submission.",
      dueAt: "2027-04-01",
      assignments: [
        {
          participantId: "participant-1",
          subject: {
            type: "session",
            sessionId: "speaker-submission:submission-1",
          },
        },
      ],
    });
    expect(task?.subject).toEqual({
      type: "session",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
    });
    expect(
      (await service.listOrganizerTasks("event-1", "account-1")).find(
        (candidate) => candidate.id === task?.id,
      )?.sessionTitle,
    ).toBe("Descriptive accepted session");
  });
  it("persists one explicit task mapping for each affected session", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.submissions.push(submission("submission-1-breakout", "participant-1"));
    const scope = repository.organizerScopes.get("event-1:account-1");
    if (scope === undefined) throw new Error("Expected organizer scope.");
    repository.organizerScopes.set("event-1:account-1", {
      ...scope,
      submissionIds: [...scope.submissionIds, "submission-1-breakout"],
    });

    const tasks = await service.createOrganizerTask({
      eventId: "event-1",
      accountId: "account-1",
      type: "action",
      title: "Confirm session details",
      assignments: [
        {
          participantId: "participant-1",
          subject: {
            type: "session",
            sessionId: "speaker-submission:submission-1",
          },
        },
        {
          participantId: "participant-1",
          subject: {
            type: "session",
            sessionId: "speaker-submission:submission-1-breakout",
          },
        },
      ],
    });

    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.subject)).toEqual([
      {
        type: "session",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-1",
      },
      {
        type: "session",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-1-breakout",
      },
    ]);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(2);
  });

  it("filters organizer task contamination by canonical submission participant", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.tasks.push(
      task({
        id: "wrong-submission-assignee",
        participantId: "participant-1",
        subject: {
          type: "session",
          participantId: "participant-1",
          sessionId: "speaker-submission:submission-2",
        },
        type: "action",
      }),
    );

    const tasks = await service.listOrganizerTasks("event-1", "account-1");
    expect(tasks.some((candidate) => candidate.id === "wrong-submission-assignee")).toBe(false);
  });
  it("keeps duplicate verified-email projections isolated and counts only general action tasks", async () => {
    const { repository, service } = createOrganizerFixture();
    const firstSubmission = repository.submissions[0];
    const secondSubmission = repository.submissions[1];
    if (firstSubmission === undefined || secondSubmission === undefined) {
      throw new Error("The organizer fixture requires two accepted submissions.");
    }
    repository.submissions.splice(
      0,
      2,
      { ...firstSubmission, title: "Shared accepted session" },
      { ...secondSubmission, title: "Shared accepted session" },
    );
    repository.profiles.push(
      {
        ...profile("participant-1"),
        displayName: "Priya Raman",
        email: "priya@example.test",
        version: 1,
      },
      {
        ...profile("participant-2"),
        displayName: "Priya Raman",
        email: "PRIYA@example.test",
        version: 4,
        updatedAt: "2026-08-09T12:00:00.000Z",
      },
    );
    repository.tasks.push(
      task({
        id: "general-complete-1",
        participantId: "participant-1",
        type: "action",
        status: "completed",
      }),
      task({
        id: "general-complete-2",
        participantId: "participant-1",
        type: "action",
        status: "completed",
      }),
      task({
        id: "general-pending",
        participantId: "participant-1",
        type: "action",
      }),
      task({
        id: "file-request",
        participantId: "participant-1",
        type: "upload",
      }),
      task({
        id: "profile-form",
        participantId: "participant-2",
        sessionId: "speaker-submission:submission-2",
        type: "form",
        status: "submitted",
      }),
    );

    const roster = await service.listOrganizerSpeakerRoster("org-1", "event-1", "account-1");

    expect(roster.speakers).toHaveLength(2);
    expect(roster.speakers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: "participant-1",
          displayName: "Priya Raman",
          taskSummary: { total: 3, completed: 2, overdue: 0 },
          sessions: expect.any(Array),
        }),
        expect.objectContaining({
          participantId: "participant-2",
          displayName: "Priya Raman",
          taskSummary: { total: 0, completed: 0, overdue: 0 },
          sessions: expect.any(Array),
        }),
      ]),
    );
    expect(roster.speakers.every((speaker) => speaker.sessions.length === 0)).toBe(true);
    expect(repository.rosterEventReads).toBe(0);
  });
  it("does not issue download grants while constructing the organizer roster", async () => {
    const { repository, gateway, service } = createOrganizerFixture();
    repository.profiles.push(profile("participant-1"));
    repository.assets.push(
      {
        id: "roster-ready-asset",
        tenantId: "org-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        kind: "slides",
        objectKey: "events/event-1/participants/participant-1/slides/roster-ready-asset",
        fileName: "slides.pdf",
        contentType: "application/pdf",
        sizeBytes: 1_024,
        state: "ready",
        createdAt: now,
      },
      {
        id: "roster-pending-asset",
        tenantId: "org-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        kind: "supporting_file",
        objectKey: "events/event-1/participants/participant-1/supporting_file/roster-pending-asset",
        fileName: "notes.txt",
        contentType: "text/plain",
        sizeBytes: 128,
        state: "pending_upload",
        createdAt: now,
      },
    );

    const roster = await service.listOrganizerSpeakerRoster("org-1", "event-1", "account-1");
    const speaker = roster.speakers.find(
      (candidate) => candidate.participantId === "participant-1",
    );

    expect(speaker?.assets).toEqual([
      expect.objectContaining({
        assetId: "roster-ready-asset",
        status: "ready",
        downloadUrl: null,
      }),
      expect.objectContaining({
        assetId: "roster-pending-asset",
        status: "pending",
        downloadUrl: null,
      }),
    ]);
    expect(gateway.downloads).toHaveLength(0);
  });
  it("fails closed when verified email resolves to multiple accepted participants", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.participantResolutions.set("manual:duplicate-priya", {
      state: "ambiguous",
      candidateParticipantIds: ["p", "participant-with-a-much-longer-id"],
    });
    await expect(
      service.createOrganizerSpeaker({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        displayName: "Priya Raman",
        email: "priya@example.test",
        jobTitle: "Principal Engineer",
        company: "Latticework Systems",
        biography: "Builds reliable developer platforms.",
        socialLinks: {},
        status: "pending",
        idempotencyKey: "duplicate-priya",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "IDENTITY_AMBIGUOUS");
      return true;
    });
  });
  it("rejects a roster projection that associates one participant with another participant's canonical email", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.roster.push({
      id: "roster:event-1:speaker-submission:submission-2:participant-2",
      eventId: "event-1",
      submissionId: "speaker-submission:submission-2",
      participantId: "participant-2",
      displayName: "Stale Marcus",
      email: "priya@example.test",
      role: "primary",
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      service.createOrganizerSpeaker({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        displayName: "Priya Raman",
        email: "PRIYA@example.test",
        jobTitle: "Principal Engineer",
        company: "Latticework Systems",
        biography: "Builds reliable developer platforms.",
        socialLinks: {},
        status: "pending",
        idempotencyKey: "canonical-email-mismatch",
        explicitParticipantId: "participant-1",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "IDENTITY_AMBIGUOUS");
      return true;
    });
    expect(repository.roster).toHaveLength(1);
  });

  it("synchronizes an existing canonical speaker profile from authoritative organizer metadata", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.profiles.push({
      ...profile("participant-1"),
      displayName: "Old Priya",
      email: "priya@example.test",
      jobTitle: "Old title",
      company: "Old company",
      biography: "Old biography",
      socialLinks: { website: "https://old.example.test" },
      status: "accepted",
      version: 3,
    });

    const roster = await service.createOrganizerSpeaker({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      displayName: "Priya Raman",
      email: "PRIYA@example.test",
      jobTitle: "Principal Engineer",
      company: "Latticework Systems",
      biography: "Builds reliable developer platforms.",
      socialLinks: { linkedin: "https://linkedin.com/in/priya" },
      status: "confirmed",
      idempotencyKey: "canonical-profile-sync",
      sourceType: "cfp",
      sourceId: "submission-1:participant-1",
      explicitParticipantId: "participant-1",
    });

    expect(repository.profiles).toHaveLength(1);
    expect(repository.profiles[0]).toMatchObject({
      participantId: "participant-1",
      displayName: "Priya Raman",
      email: "priya@example.test",
      jobTitle: "Principal Engineer",
      company: "Latticework Systems",
      biography: "Builds reliable developer platforms.",
      socialLinks: { linkedin: "https://linkedin.com/in/priya" },
      status: "confirmed",
      version: 4,
    });
    expect(roster.speakers).toEqual([
      expect.objectContaining({
        participantId: "participant-1",
        email: "priya@example.test",
        jobTitle: "Principal Engineer",
        company: "Latticework Systems",
      }),
    ]);
  });
});

function expectServiceError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(SpeakerServiceError);
  expect((error as SpeakerServiceError).code).toBe(code);
}

describe("SpeakerService portal access", () => {
  it("exposes an owned submission context before participant acceptance", async () => {
    const repository = new CountingPortalRepository();
    repository.scopes.set("event-1:account-1", {
      tenantId: "org-1",
      submissionIds: ["submission-draft"],
      participantIds: [],
      capabilities: ["submission-edit"],
    });
    repository.submissions.push({
      id: "submission-draft",
      eventId: "event-1",
      title: "Draft proposal",
      status: "submitted",
      participantIds: [],
      updatedAt: now,
    });
    repository.portalContexts.push({
      id: "portal:org-1:event-1",
      eventId: "event-1",
      name: "Draft event",
      capabilities: ["submission-edit"],
      submissionIds: ["submission-draft"],
      participantIds: [],
    });
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
      },
    );

    await expect(service.listPortalContexts("account-1")).resolves.toEqual([
      expect.objectContaining({
        submissionIds: ["submission-draft"],
        participantIds: [],
        capabilities: ["submission-edit"],
      }),
    ]);
    await expect(service.getPortal("event-1", "account-1")).resolves.toMatchObject({
      submissions: [
        expect.objectContaining({
          id: "submission-draft",
          status: "submitted",
        }),
      ],
      profiles: [],
      tasks: [],
      context: {
        submissionIds: ["submission-draft"],
        participantIds: [],
      },
    });
  });
  it("preserves a participant-only portal context for a manual speaker", async () => {
    const repository = new CountingPortalRepository();
    repository.scopes.set("event-1:account-1", {
      tenantId: "org-1",
      submissionIds: [],
      participantIds: ["participant-manual"],
      primaryParticipantId: "participant-manual",
      capabilities: ["profile-self", "task-response"],
    });
    repository.profiles.push(profile("participant-manual"));
    repository.portalContexts.push({
      id: "portal:org-1:event-1",
      eventId: "event-1",
      name: "Manual speaker event",
      capabilities: ["profile-self", "task-response"],
      submissionIds: [],
      participantIds: ["participant-manual"],
      primaryParticipantId: "participant-manual",
    });
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
      },
    );

    await expect(service.listPortalContexts("account-1")).resolves.toEqual([
      expect.objectContaining({
        submissionIds: [],
        participantIds: ["participant-manual"],
        primaryParticipantId: "participant-manual",
      }),
    ]);
    await expect(service.getPortalContext("event-1", "account-1")).resolves.toEqual(
      expect.objectContaining({
        submissionIds: [],
        participantIds: ["participant-manual"],
      }),
    );
    await expect(service.getPortal("event-1", "account-1")).resolves.toMatchObject({
      submissions: [],
      profiles: [expect.objectContaining({ participantId: "participant-manual" })],
      tasks: [],
      context: {
        submissionIds: [],
        participantIds: ["participant-manual"],
        primaryParticipantId: "participant-manual",
      },
    });
  });
  it("fails closed when an event has multiple viable portal contexts", async () => {
    const repository = new CountingPortalRepository();
    repository.scopes.set("event-1:account-1", {
      tenantId: "org-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
      capabilities: ["profile-self", "task-response"],
    });
    repository.submissions.push(submission("submission-1", "participant-1"));
    repository.portalContexts.push(
      {
        id: "portal:org-1:event-1:a",
        eventId: "event-1",
        name: "Context A",
        capabilities: ["profile-self", "task-response"],
        submissionIds: ["submission-1"],
        participantIds: ["participant-1"],
        primaryParticipantId: "participant-1",
      },
      {
        id: "portal:org-1:event-1:b",
        eventId: "event-1",
        name: "Context B",
        capabilities: ["profile-self", "task-response"],
        submissionIds: ["submission-1"],
        participantIds: ["participant-1"],
        primaryParticipantId: "participant-1",
      },
    );
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
      },
    );

    await expect(service.getPortalContext("event-1", "account-1")).rejects.toSatisfy(
      (error: unknown) => {
        expectServiceError(error, "NOT_FOUND");
        return true;
      },
    );
    await expect(service.getPortal("event-1", "account-1")).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
  });
  it("projects authorized portal contexts in one parallel submission wave", async () => {
    const repository = new DelayedPortalContextRepository();
    repository.scopes.set("event-1:account-1", {
      tenantId: "org-1",
      submissionIds: ["submission-primary", "submission-co"],
      participantIds: ["participant-primary"],
      primaryParticipantId: "participant-primary",
      capabilities: ["profile-self", "roster-manage", "task-response"],
    });
    repository.submissions.push(
      {
        ...submission("submission-primary", "participant-primary"),
        participantIds: ["participant-primary", "participant-co"],
        primaryParticipantId: "participant-primary",
      },
      submission("submission-co", "participant-co"),
    );
    repository.portalContexts.push(
      {
        id: "portal:org-1:event-1",
        eventId: "event-1",
        name: "Primary event",
        capabilities: ["profile-self", "roster-manage", "task-response"],
        submissionIds: ["submission-primary", "submission-co"],
        participantIds: ["participant-primary", "participant-co"],
        primaryParticipantId: "participant-primary",
      },
      {
        id: "portal:org-1:event-1:co",
        eventId: "event-1",
        name: "Co-only projection",
        capabilities: ["profile-self"],
        submissionIds: ["submission-co"],
        participantIds: ["participant-primary", "participant-co"],
        primaryParticipantId: "participant-primary",
      },
    );
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
      },
    );

    const startedAt = Date.now();
    const contexts = await service.listPortalContexts("account-1");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(repository.started).toEqual(["contexts", "submissions"]);
    expect({
      accessScope: repository.accessScopeReads,
      contexts: repository.contextReads,
      submissions: repository.submissionReads,
    }).toEqual({
      accessScope: 1,
      contexts: 1,
      submissions: 1,
    });
    expect(contexts).toEqual([
      expect.objectContaining({
        id: "portal:org-1:event-1",
        submissionIds: ["submission-primary"],
        participantIds: ["participant-primary"],
        primaryParticipantId: "participant-primary",
        capabilities: expect.arrayContaining(["profile-self", "roster-manage"]),
      }),
    ]);
    expect(JSON.stringify(contexts)).not.toContain("participant-co");
  });
  it("rejects a discovered co-speaker context when canonical scope resolves another primary", async () => {
    const repository = new CountingPortalRepository();
    repository.scopes.set("event-1:account-1", {
      tenantId: "org-1",
      submissionIds: ["speaker-submission:submission-1"],
      participantIds: ["participant-co"],
      primaryParticipantId: "participant-primary",
      capabilities: ["profile-self", "task-response"],
    });
    repository.portalContexts.push({
      id: "portal:org-1:event-1",
      eventId: "event-1",
      name: "Mismatched co-speaker context",
      capabilities: ["profile-self", "task-response"],
      submissionIds: ["speaker-submission:submission-1"],
      participantIds: ["participant-co"],
      primaryParticipantId: "participant-co",
    });

    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
      },
    );
    await expect(service.listPortalContexts("account-1")).resolves.toEqual([]);
    expect({
      accessScope: repository.accessScopeReads,
      contexts: repository.contextReads,
      submissions: repository.submissionReads,
    }).toEqual({ accessScope: 1, contexts: 1, submissions: 1 });
  });
  it("keeps raw and canonical submission aliases scoped to their discovered contexts", async () => {
    const repository = new CountingPortalRepository();
    repository.scopes.set("event-1:account-1", {
      tenantId: "org-1",
      submissionIds: ["submission-1", "speaker-submission:submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
      capabilities: ["profile-self", "task-response"],
    });
    repository.submissions.push(
      submission("submission-1", "participant-1"),
      submission("speaker-submission:submission-1", "participant-1"),
    );
    repository.portalContexts.push(
      {
        id: "portal:raw",
        eventId: "event-1",
        name: "Raw context",
        capabilities: ["profile-self", "task-response"],
        submissionIds: ["submission-1"],
        participantIds: ["participant-1"],
        primaryParticipantId: "participant-1",
      },
      {
        id: "portal:canonical",
        eventId: "event-1",
        name: "Canonical context",
        capabilities: ["profile-self", "task-response"],
        submissionIds: ["speaker-submission:submission-1"],
        participantIds: ["participant-1"],
        primaryParticipantId: "participant-1",
      },
    );
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
      },
    );

    const contexts = await service.listPortalContexts("account-1");

    expect(contexts).toEqual([
      expect.objectContaining({
        id: "portal:canonical",
        submissionIds: ["speaker-submission:submission-1"],
      }),
      expect.objectContaining({
        id: "portal:raw",
        submissionIds: ["submission-1"],
      }),
    ]);
    expect(repository.accessScopeReads).toBe(1);
    expect(repository.submissionReads).toBe(1);
  });
  it("hydrates the delayed portal workspace in two parallel waves", async () => {
    const repository = new DelayedPortalWorkspaceRepository();
    repository.scopes.set("event-1:account-1", {
      tenantId: "org-1",
      submissionIds: ["speaker-submission:submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
      capabilities: ["profile-self", "task-response", "asset-read"],
    });
    repository.submissions.push(submission("speaker-submission:submission-1", "participant-1"));
    repository.profiles.push(profile("participant-1"));
    repository.tasks.push(task({ id: "portal-task", participantId: "participant-1" }));
    repository.assets.push({
      id: "portal-asset",
      tenantId: "org-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      kind: "slides",
      objectKey: "events/event-1/participants/participant-1/slides/portal-asset",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 1_024,
      state: "ready",
      createdAt: now,
    });
    repository.portalContexts.push({
      id: "portal:org-1:event-1",
      eventId: "event-1",
      name: "Portal event",
      capabilities: ["profile-self", "task-response", "asset-read"],
      submissionIds: ["speaker-submission:submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
    });
    repository.roster.push({
      id: "roster:event-1:speaker-submission:submission-1:participant-1",
      eventId: "event-1",
      submissionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      displayName: "Speaker participant-1",
      role: "primary",
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        sessionAuthority: testSessionAuthority,
        now: () => new Date(now),
      },
    );

    const startedAt = performance.now();
    const portal = await service.getPortal("event-1", "account-1");

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect({
      accessScope: repository.accessScopeReads,
      submissions: repository.submissionReads,
      profiles: repository.profileReads,
      tasks: repository.taskReads,
      contexts: repository.contextReads,
      assets: repository.assetReads,
      roster: repository.rosterReads,
      rosterEvent: repository.rosterEventReads,
    }).toEqual({
      accessScope: 1,
      submissions: 1,
      profiles: 1,
      tasks: 1,
      contexts: 1,
      assets: 1,
      roster: 0,
      rosterEvent: 1,
    });
    expect(portal).toMatchObject({
      tasks: [expect.objectContaining({ id: "portal-task" })],
      assets: [expect.objectContaining({ id: "portal-asset" })],
      roster: {
        members: [expect.objectContaining({ participantId: "participant-1" })],
      },
    });
  });

  it("does not read or expose tasks without task-response capability", async () => {
    const repository = new CountingPortalRepository();
    repository.scopes.set("event-1:account-1", {
      tenantId: "org-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
      capabilities: ["asset-read", "asset-write"],
    });
    repository.portalContexts.push({
      id: "portal:org-1:event-1:participant-1",
      organizationId: "org-1",
      eventId: "event-1",
      name: "Asset-only event",
      capabilities: ["asset-read", "asset-write"],
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
    });
    repository.submissions.push(submission("submission-1", "participant-1"));
    repository.tasks.push(task({ id: "private-task", participantId: "participant-1" }));

    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
      },
    );
    const portal = await service.getPortal("event-1", "account-1");

    expect(portal.tasks).toEqual([]);
    expect(repository.taskReads).toBe(0);
  });

  it("hydrates the portal with one scope and one parallel read per projection", async () => {
    const repository = new CountingPortalRepository();
    repository.scopes.set("event-1:account-1", {
      tenantId: "org-1",
      submissionIds: ["submission-1", "speaker-submission:submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
      capabilities: [
        "profile-self",
        "roster-manage",
        "task-response",
        "asset-read",
        "resource-read",
      ],
    });
    repository.submissions.push(
      { ...submission("submission-1", "participant-1"), title: "Legacy title" },
      {
        ...submission("speaker-submission:submission-1", "participant-1"),
        title: "Canonical title",
      },
    );
    repository.profiles.push(profile("participant-1"));
    repository.tasks.push(task({ id: "portal-task", participantId: "participant-1" }));
    repository.assets.push({
      id: "portal-asset",
      tenantId: "org-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      kind: "slides",
      objectKey: "events/event-1/participants/participant-1/slides/portal-asset",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 1_024,
      state: "ready",
      createdAt: now,
    });
    repository.portalContexts.push({
      id: "portal:org-1:event-1",
      eventId: "event-1",
      name: "Portal event",
      capabilities: [
        "profile-self",
        "roster-manage",
        "task-response",
        "asset-read",
        "resource-read",
      ],
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
    });
    repository.roster.push({
      id: "roster:event-1:speaker-submission:submission-1:participant-1",
      eventId: "event-1",
      submissionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      displayName: "Speaker participant-1",
      role: "primary",
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    repository.resources.push({
      id: "resource-1",
      eventId: "event-1",
      title: "Resource",
      order: 1,
      updatedAt: now,
    });
    repository.wiki.push({
      id: "wiki-1",
      eventId: "event-1",
      title: "Wiki",
      order: 1,
      updatedAt: now,
      slug: "wiki",
    });
    const gateway = new FakePrivateAssetGateway();
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: testSessionAuthority,
      now: () => new Date(now),
    });

    const portal = await service.getPortal("event-1", "account-1");

    expect({
      accessScope: repository.accessScopeReads,
      submissions: repository.submissionReads,
      profiles: repository.profileReads,
      tasks: repository.taskReads,
      contexts: repository.contextReads,
      assets: repository.assetReads,
      roster: repository.rosterReads,
      rosterEvent: repository.rosterEventReads,
      resources: repository.resourceReads,
      wiki: repository.wikiReads,
    }).toEqual({
      accessScope: 1,
      submissions: 1,
      profiles: 1,
      tasks: 1,
      contexts: 1,
      assets: 1,
      roster: 0,
      rosterEvent: 1,
      resources: 1,
      wiki: 1,
    });
    expect(portal.submissions).toEqual([
      expect.objectContaining({
        id: "speaker-submission:submission-1",
        title: "Canonical title",
      }),
    ]);
    expect(portal.tasks).toEqual([expect.objectContaining({ id: "portal-task" })]);
    expect(portal.assets).toEqual([expect.objectContaining({ id: "portal-asset" })]);
    expect(portal.roster?.members).toEqual([
      expect.objectContaining({
        participantId: "participant-1",
        role: "primary",
      }),
    ]);
    expect(portal.resources).toEqual([expect.objectContaining({ id: "resource-1" })]);
    expect(portal.wiki).toEqual([expect.objectContaining({ id: "wiki-1" })]);
    expect(gateway.downloads).toHaveLength(0);
  });
  it("isolates portal projections and ready grants to the authenticated primary speaker", async () => {
    const repository = new CountingPortalRepository();
    repository.scopes.set("event-1:account-1", {
      tenantId: "org-1",
      submissionIds: ["submission-primary", "submission-co"],
      participantIds: ["participant-primary", "participant-co"],
      primaryParticipantId: "participant-primary",
      capabilities: ["profile-self", "roster-manage", "task-response", "asset-read"],
    });
    repository.submissions.push(
      {
        ...submission("submission-primary", "participant-primary"),
        participantIds: ["participant-primary", "participant-co"],
        primaryParticipantId: "participant-primary",
      },
      submission("submission-co", "participant-co"),
    );
    repository.profiles.push(profile("participant-primary"), {
      ...profile("participant-co"),
      displayName: "Co Speaker",
    });
    repository.tasks.push(
      task({
        id: "task-primary",
        participantId: "participant-primary",
        sessionId: "speaker-submission:submission-primary",
      }),
      task({
        id: "task-co",
        participantId: "participant-co",
        sessionId: "speaker-submission:submission-co",
      }),
    );
    repository.assets.push(
      {
        id: "asset-primary-ready",
        tenantId: "org-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-primary",
        participantId: "participant-primary",
        kind: "slides",
        objectKey: "events/event-1/participants/participant-primary/slides/ready",
        fileName: "primary.pdf",
        contentType: "application/pdf",
        sizeBytes: 1_024,
        state: "ready",
        createdAt: now,
      },
      {
        id: "asset-primary-pending",
        tenantId: "org-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-primary",
        participantId: "participant-primary",
        kind: "supporting_file",
        objectKey: "events/event-1/participants/participant-primary/supporting/pending",
        fileName: "pending.txt",
        contentType: "text/plain",
        sizeBytes: 128,
        state: "pending_upload",
        createdAt: now,
      },
      {
        id: "asset-co-ready",
        tenantId: "org-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-co",
        participantId: "participant-co",
        kind: "slides",
        objectKey: "events/event-1/participants/participant-co/slides/ready",
        fileName: "co.pdf",
        contentType: "application/pdf",
        sizeBytes: 2_048,
        state: "ready",
        createdAt: now,
      },
    );
    repository.portalContexts.push({
      id: "portal:org-1:event-1",
      eventId: "event-1",
      name: "Portal event",
      capabilities: ["profile-self", "roster-manage", "task-response", "asset-read"],
      submissionIds: ["submission-primary", "submission-co"],
      participantIds: ["participant-primary", "participant-co"],
      primaryParticipantId: "participant-primary",
    });
    repository.roster.push(
      {
        id: "roster-primary",
        eventId: "event-1",
        submissionId: "speaker-submission:submission-primary",
        participantId: "participant-primary",
        displayName: "Primary Speaker",
        email: "primary@example.test",
        role: "primary",
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "roster-co",
        eventId: "event-1",
        submissionId: "speaker-submission:submission-primary",
        participantId: "participant-co",
        displayName: "Co Speaker",
        email: "co@example.test",
        role: "co_speaker",
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    );
    const gateway = new FakePrivateAssetGateway();
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: testSessionAuthority,
      now: () => new Date(now),
    });

    const contexts = await service.listPortalContexts("account-1");
    const portal = await service.getPortal("event-1", "account-1");

    expect(contexts).toEqual([
      expect.objectContaining({
        submissionIds: ["submission-primary"],
        participantIds: ["participant-primary"],
        primaryParticipantId: "participant-primary",
      }),
    ]);
    expect(portal.submissions).toEqual([
      expect.objectContaining({
        id: "submission-primary",
        participantIds: ["participant-primary"],
        primaryParticipantId: "participant-primary",
      }),
    ]);
    expect(portal.profiles.map((candidate) => candidate.participantId)).toEqual([
      "participant-primary",
    ]);
    expect(portal.tasks.map((candidate) => candidate.id)).toEqual(["task-primary"]);
    expect(portal.assets?.map((candidate) => candidate.id)).toEqual([
      "asset-primary-ready",
      "asset-primary-pending",
    ]);
    expect(portal.roster?.members.map((member) => member.participantId)).toEqual([
      "participant-primary",
    ]);
    expect(JSON.stringify({ contexts, portal })).not.toContain("participant-co");
    expect(JSON.stringify({ contexts, portal })).not.toContain("co@example.test");

    await expect(
      service.issueDownloadGrant({
        eventId: "event-1",
        accountId: "account-1",
        assetId: "asset-co-ready",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.issueDownloadGrant({
        eventId: "event-1",
        accountId: "account-1",
        assetId: "asset-primary-pending",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.issueDownloadGrant({
        eventId: "event-1",
        accountId: "account-1",
        assetId: "asset-primary-ready",
      }),
    ).resolves.toMatchObject({
      url: expect.stringContaining("primary"),
    });
    expect(gateway.downloads).toHaveLength(1);
  });
  it("returns only event-scoped submissions, profiles, accepted tasks, and status counts", async () => {
    const { service } = createFixture();

    const portal = await service.getPortal("event-1", "account-1");

    expect(portal.submissions.map(({ id }) => id)).toEqual(["submission-1", "submission-declined"]);
    expect(portal.profiles.map(({ participantId }) => participantId)).toEqual(["participant-1"]);
    expect(portal.tasks.map(({ id }) => id)).toEqual(["dependency", "slides-task", "action-task"]);
    expect(portal.outstandingTaskCount).toBe(2);
    expect(JSON.stringify(portal)).not.toContain("organizer-task");
    expect(JSON.stringify(portal)).not.toContain("participant-2");
    expect(JSON.stringify(portal)).not.toContain("participant-other-event");
  });
  it("fails closed when roster submission candidates remain ambiguous", async () => {
    const repository = new CountingPortalRepository();
    repository.scopes.set("event-1:account-1", {
      submissionIds: [" submission-1 ", "  speaker-submission:submission-1  "],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
      capabilities: ["profile-self", "roster-manage"],
    });
    repository.submissions.push(
      submission(" submission-1 ", "participant-1"),
      submission("  speaker-submission:submission-1  ", "participant-1"),
    );
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(now),
      },
    );

    await expect(service.getRoster("event-1", "account-1", "submission-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("loads canonical accepted rosters for the owning speaker and versions roster mutations", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.scopes.set("event-1:account-1", {
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
      capabilities: ["profile-self", "task-response", "roster-manage"],
    });
    repository.roster.push({
      id: "roster:event-1:speaker-submission:submission-1:participant-1",
      eventId: "event-1",
      submissionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      displayName: "Priya Raman",
      email: "priya@example.test",
      role: "primary",
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    const portal = await service.getPortal("event-1", "account-1");
    expect(portal.capabilities).toContain("roster-manage");
    expect(portal.roster?.members).toEqual([
      expect.objectContaining({
        participantId: "participant-1",
        role: "primary",
      }),
    ]);
    const initial = await service.getRoster("event-1", "account-1", "submission-1");
    expect(initial.submissionId).toBe("submission-1");
    expect(initial.capabilities).toEqual({ manage: true, invite: true });
    expect(initial.members).toEqual([
      expect.objectContaining({
        participantId: "participant-1",
        role: "primary",
        capabilities: { edit: false, remove: false },
      }),
    ]);

    const added = await service.addRosterEntry({
      eventId: "event-1",
      accountId: "account-1",
      submissionId: "submission-1",
      participantId: "participant-co",
      email: "co@example.test",
      displayName: "Co Speaker",
      role: "co_speaker",
    });
    expect(added.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: "participant-co",
          role: "co_speaker",
        }),
      ]),
    );
    const stored = repository.roster.find((entry) => entry.participantId === "participant-co");
    expect(stored).toEqual(
      expect.objectContaining({
        submissionId: "speaker-submission:submission-1",
        version: 1,
      }),
    );

    const updated = await service.updateRosterEntry({
      eventId: "event-1",
      accountId: "account-1",
      submissionId: "submission-1",
      participantId: "participant-co",
      displayName: "Renamed Co Speaker",
      role: "co_speaker",
      expectedVersion: 1,
    });
    expect(updated.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: "participant-co",
          displayName: "Renamed Co Speaker",
          role: "co_speaker",
        }),
      ]),
    );
    expect(
      repository.roster.find((entry) => entry.participantId === "participant-co")?.version,
    ).toBe(2);

    await expect(
      service.updateRosterEntry({
        eventId: "event-1",
        accountId: "account-1",
        submissionId: "submission-1",
        participantId: "participant-co",
        displayName: "Stale",
        expectedVersion: 1,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "VERSION_CONFLICT");
      return true;
    });

    const removed = await service.removeRosterEntry({
      eventId: "event-1",
      accountId: "account-1",
      submissionId: "submission-1",
      participantId: "participant-co",
      expectedVersion: 2,
    });
    expect(removed.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: "participant-co",
          status: "revoked",
        }),
      ]),
    );

    await expect(service.getRoster("event-1", "account-2", "submission-1")).rejects.toSatisfy(
      (error: unknown) => {
        expectServiceError(error, "NOT_FOUND");
        return true;
      },
    );
  });

  it("does not grant profile or task authority from another account or event", async () => {
    const { service } = createFixture();

    await expect(
      service.updateBiography({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-2",
        biography: "Stolen biography",
        expectedVersion: 3,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "other-speaker-task",
        toStatus: "in_progress",
        expectedVersion: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
    await expect(
      service.transitionTask({
        eventId: "event-2",
        accountId: "account-2",
        taskId: "other-event-task",
        toStatus: "in_progress",
        expectedVersion: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
  });
  it("keeps dual-role portal reads at speaker-grant scope while organizer reads stay explicit", async () => {
    const { repository, service } = createDualRoleFixture();

    expect((await service.listSubmissions("event-1", "account-1")).map(({ id }) => id)).toEqual([
      "submission-1",
    ]);
    expect(
      (await service.listProfiles("event-1", "account-1")).map(
        ({ participantId }) => participantId,
      ),
    ).toEqual(["participant-1"]);
    expect((await service.listTasks("event-1", "account-1")).map(({ id }) => id)).toEqual([
      "dual-role-task-1",
    ]);
    expect((await service.listAssets("event-1", "account-1")).map(({ id }) => id)).toEqual([
      "dual-role-asset-1",
    ]);
    const existingAsset = repository.assets[0];
    if (existingAsset === undefined) throw new Error("Expected the dual-role asset fixture.");
    repository.assets.push({
      ...existingAsset,
      id: "dual-role-cross-task",
      taskId: "other-task",
      objectKey: "events/event-1/participants/participant-1/slides/dual-role-cross-task",
    });
    repository.comments.push({
      id: "dual-role-cross-task-comment",
      eventId: "event-1",
      assetId: "dual-role-cross-task",
      versionId: "dual-role-cross-task",
      body: "Other task comment",
      authorLabel: "Speaker",
      createdAt: now,
      version: 1,
    });
    expect(
      (await service.listAssetComments("event-1", "account-1", "dual-role-asset-1")).map(
        ({ id }) => id,
      ),
    ).toEqual(["dual-role-comment-1"]);

    await expect(
      service.listAssetComments("event-1", "account-1", "dual-role-asset-2"),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
    repository.assets.splice(
      repository.assets.findIndex(({ id }) => id === "dual-role-cross-task"),
      1,
    );
    repository.comments.splice(
      repository.comments.findIndex(({ id }) => id === "dual-role-cross-task-comment"),
      1,
    );

    expect(
      (await service.listOrganizerProfiles("event-1", "account-1")).map(
        ({ participantId }) => participantId,
      ),
    ).toEqual(["participant-1", "participant-2"]);
    expect((await service.listOrganizerTasks("event-1", "account-1")).map(({ id }) => id)).toEqual([
      "dual-role-task-1",
      "dual-role-task-2",
    ]);
    expect((await service.listOrganizerAssets("event-1", "account-1")).map(({ id }) => id)).toEqual(
      ["dual-role-asset-1", "dual-role-asset-2"],
    );
    expect(
      (await service.listOrganizerAssetComments("event-1", "account-1", "dual-role-asset-2")).map(
        ({ id }) => id,
      ),
    ).toEqual(["dual-role-comment-2"]);
  });
});

describe("SpeakerService capability and canonical task scope", () => {
  it("fails closed when capabilities are absent or malformed", async () => {
    const { repository, service } = createFixture();
    repository.scopes.set("event-1:account-1", {
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
    });

    expect(await service.listTasks("event-1", "account-1")).toEqual([]);
    expect((await service.getPortalContext("event-1", "account-1")).capabilities).toEqual([]);
    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "action-task",
        toStatus: "completed",
        expectedVersion: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });

    repository.scopes.set("event-1:account-1", {
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      capabilities: "task-response" as unknown as NonNullable<SpeakerAccessScope["capabilities"]>,
    });
    expect(await service.listTasks("event-1", "account-1")).toEqual([]);
  });
  it("requires an explicit roster grant even for the accepted submission owner", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.scopes.set("event-1:account-1", {
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
      capabilities: ["profile-self", "task-response"],
    });

    await expect(
      service.addRosterEntry({
        eventId: "event-1",
        accountId: "account-1",
        submissionId: "submission-1",
        participantId: "participant-co",
        email: "co@example.test",
        displayName: "Co Speaker",
        role: "co_speaker",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
  });

  it("allows explicit task grants while enforcing canonical submission scope for reused participants", async () => {
    const { repository, service } = createFixture();
    repository.scopes.set("event-1:account-1", {
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      capabilities: ["task-response"],
      capabilitiesByParticipant: {
        "participant-1": ["task-response"],
      },
    });
    repository.tasks.push(
      task({
        id: "reused-participant-cross-submission-task",
        participantId: "participant-1",
        subject: {
          type: "session",
          participantId: "participant-1",
          sessionId: "speaker-submission:submission-2",
        },
      }),
    );

    expect((await service.listTasks("event-1", "account-1")).map(({ id }) => id)).toEqual([
      "dependency",
      "slides-task",
      "action-task",
    ]);
    const transitioned = await service.transitionTask({
      eventId: "event-1",
      accountId: "account-1",
      taskId: "action-task",
      toStatus: "completed",
      expectedVersion: 0,
    });
    expect(transitioned.task.status).toBe("completed");
    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "reused-participant-cross-submission-task",
        toStatus: "in_progress",
        expectedVersion: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
    const crossSubmissionTask = repository.tasks.find(
      ({ id }) => id === "reused-participant-cross-submission-task",
    );
    expect(crossSubmissionTask?.status).toBe("not_started");
  });
});
describe("SpeakerService profile updates", () => {
  it("normalizes an authorized biography and uses optimistic concurrency", async () => {
    const { service } = createFixture();

    const updated = await service.updateBiography({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      biography: "  A speaker biography.\r\nSecond line.  ",
      expectedVersion: 3,
    });

    expect(updated.biography).toBe("A speaker biography.\nSecond line.");
    expect(updated.version).toBe(4);
    expect(updated.updatedAt).toBe(now);
    await expect(
      service.updateBiography({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        biography: "Stale write",
        expectedVersion: 3,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "VERSION_CONFLICT");
      return true;
    });
  });

  it("rejects control characters instead of persisting unsafe biography content", async () => {
    const { service } = createFixture();

    await expect(
      service.updateBiography({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        biography: "Biography\u0000payload",
        expectedVersion: 3,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "VALIDATION_ERROR");
      return true;
    });
  });
});

describe("SpeakerService task workflow", () => {
  it("enforces dependencies and records the speaker transition atomically", async () => {
    const { repository, service } = createFixture();
    const dependency = repository.tasks.find(({ id }) => id === "dependency");
    if (!dependency) {
      throw new Error("Missing dependency fixture");
    }
    dependency.status = "in_progress";

    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "slides-task",
        toStatus: "in_progress",
        expectedVersion: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "TASK_DEPENDENCY_INCOMPLETE");
      return true;
    });

    dependency.status = "completed";
    const result = await service.transitionTask({
      eventId: "event-1",
      accountId: "account-1",
      taskId: "slides-task",
      toStatus: "in_progress",
      expectedVersion: 0,
      note: "  Preparing final slides.  ",
    });

    expect(result.task).toMatchObject({ status: "in_progress", version: 1 });
    expect(result.transitionId).toBe("generated-1");
    expect(repository.transitions).toEqual([
      expect.objectContaining({
        actorAccountId: "account-1",
        participantId: "participant-1",
        fromStatus: "not_started",
        toStatus: "in_progress",
        note: "Preparing final slides.",
        occurredAt: now,
      }),
    ]);
  });
  it("preserves the canonical program-session title in task transition responses", async () => {
    const { repository, service } = createFixture();
    repository.tasks.push(
      task({
        id: "session-title-task",
        participantId: "participant-1",
        subject: {
          type: "session",
          participantId: "participant-1",
          sessionId: "session-title",
        },
      }),
    );

    const result = await service.transitionTask({
      eventId: "event-1",
      accountId: "account-1",
      taskId: "session-title-task",
      toStatus: "in_progress",
      expectedVersion: 0,
    });

    expect(result.task).toMatchObject({
      status: "in_progress",
      version: 1,
      sessionTitle: "Descriptive accepted session",
    });
  });

  it("allows action completion but prevents speakers from forcing organizer-owned states", async () => {
    const { repository, service } = createFixture();

    const completed = await service.transitionTask({
      eventId: "event-1",
      accountId: "account-1",
      taskId: "action-task",
      toStatus: "completed",
      expectedVersion: 0,
    });
    expect(completed.task.status).toBe("completed");

    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "slides-task",
        toStatus: "waived",
        expectedVersion: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "INVALID_TASK_TRANSITION");
      return true;
    });
    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "organizer-task",
        toStatus: "completed",
        expectedVersion: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
    expect(repository.transitions).toHaveLength(1);
  });

  it("does not expose tasks until their program session is accepted", async () => {
    const { service } = createFixture();

    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "declined-task",
        toStatus: "in_progress",
        expectedVersion: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
  });
});

describe("SpeakerService private asset authorization", () => {
  it("issues short-lived private, scanned upload access without using the file name as a key", async () => {
    const { gateway, repository, service } = createFixture();

    const result = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      kind: "headshot",
      fileName: "../speaker.jpg",
      contentType: "image/jpeg",
      sizeBytes: 512_000,
    });

    expect(result.asset).toMatchObject({
      id: "generated-1",
      eventId: "event-1",
      participantId: "participant-1",
      fileName: "..-speaker.jpg",
      state: "pending_upload",
    });
    expect(result.asset.objectKey).toBe(
      "events/event-1/participants/participant-1/headshot/generated-1",
    );
    expect(repository.assets).toHaveLength(1);
    expect(gateway.uploads).toEqual([
      {
        objectKey: result.asset.objectKey,
        contentType: "image/jpeg",
        sizeBytes: 512_000,
        expiresAt: "2026-08-08T12:05:00.000Z",
        private: true,
        requireMalwareScan: true,
        stripMetadata: true,
      },
    ]);
  });
  it("inherits task ownership when issuing a successor asset version", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.tasks.push(task({ id: "slides-task", participantId: "participant-1" }));

    const first = await service.issueOrganizerUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      taskId: "slides-task",
      kind: "slides",
      fileName: "slides-v1.pdf",
      contentType: "application/pdf",
      sizeBytes: 2_000_000,
    });
    const firstStored = repository.assets.find((asset) => asset.id === first.asset.id);
    if (firstStored === undefined) throw new Error("Expected the first asset to be stored.");
    firstStored.state = "ready";
    firstStored.currentVersionId = firstStored.id;

    const second = await service.issueOrganizerUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      supersedesAssetId: first.asset.id,
      expectedLatestVersion: 1,
      idempotencyKey: "speaker-test-successor-v2",
      kind: "slides",
      fileName: "slides-v2.pdf",
      contentType: "application/pdf",
      sizeBytes: 2_000_000,
    });
    expect(second.asset).toMatchObject({
      taskId: "slides-task",
      supersedesAssetId: first.asset.id,
      version: 2,
      versionFamilyId: first.asset.versionFamilyId,
    });
    const secondStored = repository.assets.find((asset) => asset.id === second.asset.id);
    if (secondStored === undefined) throw new Error("Expected the successor asset to be stored.");
    secondStored.state = "ready";
    secondStored.currentVersionId = secondStored.id;

    const deliverables = await service.listDeliverables("event-1", "account-1");
    expect(deliverables.items).toHaveLength(1);
    expect(deliverables.items[0]?.currentAsset?.id).toBe(second.asset.id);

    await expect(
      service.issueOrganizerUploadGrant({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        taskId: "different-task",
        supersedesAssetId: first.asset.id,
        expectedLatestVersion: 1,
        idempotencyKey: "speaker-test-invalid-task",
        kind: "slides",
        fileName: "slides-conflict.pdf",
        contentType: "application/pdf",
        sizeBytes: 2_000_000,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });

    const { supersedesAssetId: _supersededAssetId, ...foreignAsset } = first.asset;
    repository.assets.push({
      ...foreignAsset,
      id: "foreign-asset",
      tenantId: "other-org",
    });
    await expect(
      service.issueOrganizerUploadGrant({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        supersedesAssetId: "foreign-asset",
        expectedLatestVersion: 1,
        idempotencyKey: "speaker-test-foreign-asset",
        kind: "slides",
        fileName: "slides-foreign.pdf",
        contentType: "application/pdf",
        sizeBytes: 2_000_000,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
  });

  it("binds task uploads to the authorized task and its configured asset kinds", async () => {
    const { gateway, service } = createFixture();

    const result = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      taskId: "slides-task",
      kind: "slides",
      fileName: "conference-slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 2_000_000,
    });

    expect(result.asset).toMatchObject({
      taskId: "slides-task",
      kind: "slides",
      state: "pending_upload",
    });
    expect(gateway.uploads[0]).toMatchObject({
      private: true,
      requireMalwareScan: true,
      stripMetadata: false,
    });
  });

  it("accepts standard headshot, presentation, and supporting-document formats", async () => {
    const { service } = createFixture();

    const headshot = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      kind: "headshot",
      fileName: "speaker.webp",
      contentType: "image/webp",
      sizeBytes: 100,
    });
    const slides = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      taskId: "slides-task",
      sessionId: "speaker-submission:submission-1",
      kind: "slides",
      fileName: "conference-slides.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sizeBytes: 100,
    });
    const supportingDocument = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      kind: "supporting_file",
      fileName: "speaker-notes.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 100,
    });

    expect([headshot.asset, slides.asset, supportingDocument.asset]).toMatchObject([
      { kind: "headshot", contentType: "image/webp" },
      {
        kind: "slides",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
      {
        kind: "supporting_file",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ]);
  });

  it("enforces participant, task, media-type, and size policies before issuing access", async () => {
    const { gateway, service } = createFixture();

    const attempts = [
      service.issueUploadGrant({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-2",
        kind: "headshot",
        fileName: "speaker.jpg",
        contentType: "image/jpeg",
        sizeBytes: 100,
      }),
      service.issueUploadGrant({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        kind: "headshot",
        fileName: "speaker.svg",
        contentType: "image/svg+xml",
        sizeBytes: 100,
      }),
      service.issueUploadGrant({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        taskId: "slides-task",
        kind: "headshot",
        fileName: "speaker.jpg",
        contentType: "image/jpeg",
        sizeBytes: 100,
      }),
    ];

    const results = await Promise.allSettled(attempts);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(gateway.uploads).toHaveLength(0);
  });

  it("allows downloads only for ready assets owned in the current event", async () => {
    const { gateway, repository, service } = createFixture();
    repository.assets.push({
      id: "asset-1",
      eventId: "event-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      kind: "slides",
      objectKey: "events/event-1/participants/participant-1/slides/asset-1",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 1_024,
      state: "ready",
      createdAt: now,
    });

    const grant = await service.issueDownloadGrant({
      eventId: "event-1",
      accountId: "account-1",
      assetId: "asset-1",
    });
    expect(grant.expiresAt).toBe("2026-08-08T12:02:00.000Z");
    expect(gateway.downloads).toHaveLength(1);

    await expect(
      service.issueDownloadGrant({
        eventId: "event-1",
        accountId: "account-2",
        assetId: "asset-1",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectServiceError(error, "NOT_FOUND");
      return true;
    });
    expect(gateway.downloads).toHaveLength(1);
  });
});

describe("speaker routes", () => {
  it("uses an injected authentication boundary and safe event-scoped errors", async () => {
    const { service } = createFixture();
    const app = createSpeakerRoutes({
      service,
      authenticate: async (request) =>
        request.headers.get("authorization") === "Bearer account-1"
          ? { accountId: "account-1" }
          : null,
    });
    const requestId = "65f8d9b5-6862-4bbc-973c-f728e9185c22";

    const unauthenticated = await app.request("/events/event-1/portal");
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });

    const portal = await app.request("/events/event-1/portal", {
      headers: { authorization: "Bearer account-1", "x-request-id": requestId },
    });
    expect(portal.status).toBe(200);
    expect(portal.headers.get("cache-control")).toBe("private, no-store");
    expect(portal.headers.get("x-request-id")).toBe(requestId);
    expect(await portal.json()).toMatchObject({
      data: { outstandingTaskCount: 2 },
    });

    const crossUser = await app.request("/events/event-1/profiles/participant-2", {
      method: "PATCH",
      headers: {
        authorization: "Bearer account-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ biography: "Unauthorized", expectedVersion: 3 }),
    });
    const error = await crossUser.json();
    expect(crossUser.status).toBe(404);
    expect(error).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(JSON.stringify(error)).not.toContain("participant-2");
  });
  it("keeps private object keys out of the organizer asset envelope", async () => {
    const { repository, service } = createOrganizerFixture();
    repository.assets.push({
      id: "route-private-asset",
      tenantId: "org-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      kind: "slides",
      objectKey: "private/r2/secret-route-private-asset",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 1_024,
      state: "ready",
      createdAt: now,
    });
    const app = createSpeakerRoutes({
      service,
      authenticate: async (request) =>
        request.headers.get("authorization") === "Bearer account-1"
          ? { accountId: "account-1" }
          : null,
    });

    const response = await app.request("/events/event-1/organizer/assets", {
      headers: { authorization: "Bearer account-1" },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(payload.data).toEqual([
      expect.objectContaining({
        id: "route-private-asset",
        eventId: "event-1",
        participantId: "participant-1",
      }),
    ]);
    expect(payload.data[0]).not.toHaveProperty("objectKey");
    expect(payload.data[0]).not.toHaveProperty("tenantId");
    expect(JSON.stringify(payload)).not.toContain("secret-route-private-asset");
  });
});
describe("organizer task reminder offsets", () => {
  it("replaces reminder offsets in canonical order on an incomplete upload task", async () => {
    const { repository, service } = createOrganizerFixture();
    const current = task({
      id: "reminder-task",
      participantId: "participant-1",
      dueAt: "2027-04-01",
      reminderOffsetsMinutes: [60],
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 5_000_000,
      version: 3,
    });
    repository.tasks.push(current);

    const updated = await service.updateOrganizerTaskReminderOffsets({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      taskId: current.id,
      expectedVersion: current.version,
      reminderOffsetsMinutes: [10_080, 0, 1_440],
    });

    expect(updated).toEqual({
      organizationId: "org-1",
      eventId: "event-1",
      taskId: current.id,
      reminderOffsetsMinutes: [0, 1_440, 10_080],
      version: 4,
      updatedAt: now,
    });
    expect(repository.tasks.find((candidate) => candidate.id === current.id)).toMatchObject({
      reminderOffsetsMinutes: [0, 1_440, 10_080],
      version: 4,
    });
  });

  it("allows an empty reminder offset set and rejects duplicate or unsafe offsets", async () => {
    const { repository, service } = createOrganizerFixture();
    const current = task({
      id: "reminder-validation-task",
      participantId: "participant-1",
      dueAt: "2027-04-01",
      reminderOffsetsMinutes: [60],
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 5_000_000,
      version: 2,
    });
    repository.tasks.push(current);

    await expect(
      service.updateOrganizerTaskReminderOffsets({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        taskId: current.id,
        expectedVersion: current.version,
        reminderOffsetsMinutes: [60, 60],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(
      service.updateOrganizerTaskReminderOffsets({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        taskId: current.id,
        expectedVersion: current.version,
        reminderOffsetsMinutes: [Number.MAX_SAFE_INTEGER + 1],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(
      service.updateOrganizerTaskReminderOffsets({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        taskId: current.id,
        expectedVersion: current.version,
        reminderOffsetsMinutes: [30],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(repository.tasks.find((candidate) => candidate.id === current.id)?.version).toBe(2);

    await expect(
      service.updateOrganizerTaskReminderOffsets({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        taskId: current.id,
        expectedVersion: current.version,
        reminderOffsetsMinutes: [],
      }),
    ).resolves.toMatchObject({ reminderOffsetsMinutes: [], version: 3 });
  });

  it("preserves optimistic concurrency for reminder schedule updates", async () => {
    const { repository, service } = createOrganizerFixture();
    const current = task({
      id: "stale-reminder-task",
      participantId: "participant-1",
      dueAt: "2027-04-01",
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 5_000_000,
      reminderOffsetsMinutes: [60],
      version: 4,
    });
    repository.tasks.push(current);

    await expect(
      service.updateOrganizerTaskReminderOffsets({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        taskId: current.id,
        expectedVersion: 3,
        reminderOffsetsMinutes: [1_440],
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    expect(repository.tasks.find((candidate) => candidate.id === current.id)).toMatchObject({
      reminderOffsetsMinutes: [60],
      version: 4,
    });
  });

  it.each(["completed", "submitted", "waived"] as const)(
    "rejects reminder changes for %s tasks",
    async (status) => {
      const { repository, service } = createOrganizerFixture();
      const current = task({
        id: `reminder-${status}`,
        participantId: "participant-1",
        dueAt: "2027-04-01",
        status,
        version: 2,
      });
      repository.tasks.push(current);

      await expect(
        service.updateOrganizerTaskReminderOffsets({
          organizationId: "org-1",
          eventId: "event-1",
          accountId: "account-1",
          taskId: current.id,
          expectedVersion: current.version,
          reminderOffsetsMinutes: [1_440],
        }),
      ).rejects.toMatchObject({
        code: "TASK_REMINDERS_NOT_EDITABLE",
        status: 409,
      });
      expect(repository.tasks.find((candidate) => candidate.id === current.id)?.version).toBe(2);
    },
  );

  it.each([
    { label: "form task", changes: { type: "form" as const } },
    { label: "action task", changes: { type: "action" as const } },
    { label: "organizer-owned task", changes: { owner: "organizer" as const } },
  ])("rejects an unsupported $label", async ({ changes }) => {
    const { repository, service } = createOrganizerFixture();
    const current = task({
      id: `unsupported-${changes.type ?? changes.owner ?? "due-date"}`,
      participantId: "participant-1",
      dueAt: "2027-04-01",
      version: 2,
      ...changes,
    });
    repository.tasks.push(current);

    await expect(
      service.updateOrganizerTaskReminderOffsets({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        taskId: current.id,
        expectedVersion: current.version,
        reminderOffsetsMinutes: [1_440],
      }),
    ).rejects.toMatchObject({
      code: "TASK_REMINDERS_NOT_EDITABLE",
      status: 409,
    });
  });

  it("rejects a task without a due date", async () => {
    const { repository, service } = createOrganizerFixture();
    const current = task({
      id: "unsupported-due-date",
      participantId: "participant-1",
      version: 2,
    });
    repository.tasks.push(current);

    await expect(
      service.updateOrganizerTaskReminderOffsets({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        taskId: current.id,
        expectedVersion: current.version,
        reminderOffsetsMinutes: [1_440],
      }),
    ).rejects.toMatchObject({
      code: "TASK_REMINDERS_NOT_EDITABLE",
      status: 409,
    });
  });
});

describe("canonical speaker admin routes", () => {
  it("accepts only the strict reminder-offset command wire shape", async () => {
    const { service } = createOrganizerFixture();
    const update = vi.spyOn(service, "updateOrganizerTaskReminderOffsets").mockResolvedValue({
      organizationId: "org-1",
      eventId: "event-1",
      taskId: "task-1",
      reminderOffsetsMinutes: [0, 1_440],
      version: 3,
      updatedAt: now,
    });
    const app = new Hono();
    app.route(
      "/api/admin/organizations/:organizationId/events/:eventId/speaker-tasks",
      createSpeakerTaskAdminRoutes({
        service,
        authenticate: async () => ({ accountId: "account-1" }),
      }),
    );
    const endpoint =
      "/api/admin/organizations/org-1/events/event-1/speaker-tasks/task-1/reminder-offsets";
    const headers = { "content-type": "application/json" };

    const response = await app.request(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expectedVersion: 2,
        reminderOffsetsMinutes: [1_440, 0],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        organizationId: "org-1",
        eventId: "event-1",
        taskId: "task-1",
        reminderOffsetsMinutes: [0, 1_440],
        version: 3,
        updatedAt: now,
      },
    });
    expect(update).toHaveBeenCalledWith({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      taskId: "task-1",
      expectedVersion: 2,
      reminderOffsetsMinutes: [1_440, 0],
    });

    for (const body of [
      { reminderOffsetsMinutes: [60] },
      { expectedVersion: 2, reminderOffsetsMinutes: [60, 60] },
      { expectedVersion: 2, reminderOffsetsMinutes: [-1] },
      { expectedVersion: 2, reminderOffsetsMinutes: [30] },
      {
        expectedVersion: 2,
        reminderOffsetsMinutes: [60],
        title: "Not allowed",
      },
    ]) {
      const invalid = await app.request(endpoint, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
    }
    expect(update).toHaveBeenCalledTimes(1);
  });
  it.each(["2027-02-30", "2027-04-01T12:00:00", "2027-04-01T12:00:00.000Z"])(
    "rejects non-calendar task deadlines before calling the service: %s",
    async (dueAt) => {
      const { service } = createOrganizerFixture();
      const assign = vi.spyOn(service, "assignOrganizerSpeakerTask");
      const app = new Hono();
      app.route(
        "/api/admin/organizations/:organizationId/events/:eventId/speaker-tasks",
        createSpeakerTaskAdminRoutes({
          service,
          authenticate: async () => ({ accountId: "account-1" }),
        }),
      );

      const response = await app.request(
        "/api/admin/organizations/org-1/events/event-1/speaker-tasks",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Invalid deadline task",
            description: "Must not reach the service.",
            dueAt,
            assignments: [
              {
                participantId: "participant-1",
                subject: {
                  type: "session",
                  participantId: "participant-1",
                  sessionId: "speaker-submission:submission-1",
                },
              },
            ],
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it("commits a server-issued import preview instead of accepting client-owned rows", async () => {
    const { service } = createOrganizerFixture();
    const commit = vi.spyOn(service, "commitSpeakerImport").mockResolvedValue({
      organizationId: "org-1",
      eventId: "event-1",
      speakers: [],
    });
    const app = new Hono();
    app.route(
      "/api/admin/organizations/:organizationId/events/:eventId/speakers",
      createSpeakerAdminRoutes({
        service,
        authenticate: async () => ({ accountId: "account-1" }),
      }),
    );
    const endpoint = "/api/admin/organizations/org-1/events/event-1/speakers/imports";
    const headers = { "content-type": "application/json" };

    const response = await app.request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        previewId: "speaker-import-preview:route-1",
        sourceDigest: "digest-1",
        idempotencyKey: "route-import-1",
      }),
    });

    expect(response.status).toBe(201);
    expect(commit).toHaveBeenCalledWith({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      previewId: "speaker-import-preview:route-1",
      sourceDigest: "digest-1",
      idempotencyKey: "route-import-1",
    });

    const clientOwnedRows = await app.request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        rows: [
          {
            rowNumber: 2,
            displayName: "Client-owned row",
            email: "speaker@example.test",
            jobTitle: "Engineer",
            company: "Example",
            biography: "Must not be authoritative.",
            socialLinks: {},
          },
        ],
        idempotencyKey: "route-import-2",
      }),
    });
    expect(clientOwnedRows.status).toBe(400);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("requires canonical identity, task subject, and revision wire shapes", async () => {
    const { service } = createOrganizerFixture();
    const authenticate = async (request: Request) =>
      request.headers.get("authorization") === "Bearer account-1"
        ? { accountId: "account-1" }
        : null;
    const app = new Hono();
    app.route(
      "/api/admin/organizations/:organizationId/events/:eventId/speakers",
      createSpeakerAdminRoutes({ service, authenticate }),
    );
    app.route(
      "/api/admin/organizations/:organizationId/events/:eventId/speaker-tasks",
      createSpeakerTaskAdminRoutes({ service, authenticate }),
    );
    const headers = {
      authorization: "Bearer account-1",
      "content-type": "application/json",
    };

    const speaker = await app.request("/api/admin/organizations/org-1/events/event-1/speakers", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: "route-cfp-participant-1",
        sourceType: "cfp",
        sourceId: "submission-1:participant-1",
        participantId: "participant-1",
        displayName: "Priya Raman",
        email: "priya@example.test",
        jobTitle: "Principal Engineer",
        company: "Latticework Systems",
        biography: "Builds reliable platforms.",
        socialLinks: {},
        status: "confirmed",
      }),
    });
    expect(speaker.status).toBe(201);
    expect(await speaker.json()).toMatchObject({
      data: {
        speakers: [expect.objectContaining({ participantId: "participant-1" })],
      },
    });

    const task = await app.request("/api/admin/organizations/org-1/events/event-1/speaker-tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Confirm session",
        description: "Confirm the session details.",
        dueAt: "2027-04-01",
        assignments: [
          {
            participantId: "participant-1",
            subject: {
              type: "session",
              participantId: "participant-1",
              sessionId: "speaker-submission:submission-1",
            },
          },
        ],
      }),
    });
    expect(task.status).toBe(201);
    expect(await task.json()).toMatchObject({
      data: {
        tasks: [
          expect.objectContaining({
            participantId: "participant-1",
            sessionId: "speaker-submission:submission-1",
          }),
        ],
      },
    });

    const legacyTask = await app.request(
      "/api/admin/organizations/org-1/events/event-1/speaker-tasks",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Legacy task",
          description: "Must fail.",
          dueAt: "2027-04-01",
          participantIds: ["participant-1"],
        }),
      },
    );
    expect(legacyTask.status).toBe(400);
    expect(await legacyTask.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });
});
describe("SpeakerService organizer email previews", () => {
  it.each(["", "not-an-email", "speaker@example.test\r\nBcc: attacker@example.test"])(
    "rejects an invalid runtime speaker sender identity: %j",
    (invalidSender) => {
      expect(
        () =>
          new SpeakerService(
            withTestSpeakerOrganizerLifecycle(new OrganizerSpeakerRepository()),
            new FakePrivateAssetGateway(),
            {
              speakerSender: invalidSender,
            },
          ),
      ).toThrow(new TypeError("Speaker sender must be a valid email address."));
    },
  );

  it("preserves durable communication availability failures as a stable 503", async () => {
    const { repository, gateway } = createOrganizerFixture();
    const unavailable = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      communications: new CommunicationSpeakerCommunications(
        new CommunicationService(new InMemoryCommunicationRepository()),
        "https://event.example.test",
      ),
    });
    await expect(
      unavailable.createOrganizerSpeakerEmailTemplate({
        organizationId: "org-1",
        eventId: "event-1",
        accountId: "account-1",
        name: "Unavailable",
        subject: "Hello",
        html: "<p>Hello</p>",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "REMINDER_UNAVAILABLE",
      status: 503,
      message: "Durable speaker communications are unavailable.",
    });
  });

  const createTemplate = (service: SpeakerService) =>
    service.createOrganizerSpeakerEmailTemplate({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      templateId: "speaker-email",
      name: "Speaker update",
      subject: "Hello {{first_name}}",
      html: "<p>Hello {{first_name}}</p>",
      text: "Hello {{first_name}}",
    });
  const preview = (
    service: SpeakerService,
    template: { id: string; version: number },
    participantIds: readonly string[],
    templateVersion = template.version,
  ) =>
    service.previewOrganizerSpeakerEmails({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      participantIds,
      templateId: template.id,
      templateVersion,
    });
  const addRosterEntry = (repository: OrganizerSpeakerRepository, email?: string): void => {
    repository.roster.push({
      id: "roster:event-1:speaker-submission:submission-1:participant-1",
      eventId: "event-1",
      submissionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      displayName: "Priya Raman",
      ...(email === undefined ? {} : { email }),
      role: "primary",
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  };
  const expectEmailError = (
    error: unknown,
    code: string,
    status: 400 | 409,
    message: string,
  ): boolean => {
    expectServiceError(error, code);
    expect((error as SpeakerServiceError).status).toBe(status);
    expect((error as SpeakerServiceError).message).toBe(message);
    return true;
  };

  it("reports an unavailable approved template version", async () => {
    const { service } = createOrganizerFixture();
    const template = await createTemplate(service);

    await expect(
      preview(service, template, ["participant-1"], template.version + 1),
    ).rejects.toSatisfy((error: unknown) =>
      expectEmailError(
        error,
        "EMAIL_TEMPLATE_NOT_FOUND",
        409,
        "The approved speaker email template or requested version was not found.",
      ),
    );
  });

  it("reports a participant absent from the scoped roster", async () => {
    const { service } = createOrganizerFixture();
    const template = await createTemplate(service);

    await expect(preview(service, template, ["participant-missing"])).rejects.toSatisfy(
      (error: unknown) =>
        expectEmailError(
          error,
          "EMAIL_PARTICIPANT_NOT_FOUND",
          409,
          "The selected speaker participant was not found in this event roster.",
        ),
    );
  });

  it("uses the canonical communication recipient instead of a legacy roster email fallback", async () => {
    const { repository, service } = createOrganizerFixture();
    addRosterEntry(repository);
    const template = await createTemplate(service);

    await expect(preview(service, template, ["participant-1"])).resolves.toMatchObject({
      recipientIds: ["participant-1"],
      recipients: [{ email: "priya@example.test" }],
    });
  });
});

describe("speaker temporal integrity", () => {
  const temporalContext = {
    organizationId: "org-1",
    eventId: "event-1",
    timeZone: "America/Los_Angeles",
    startsAt: "2026-08-10T16:00:00.000Z",
    endsAt: "2026-08-12T23:00:00.000Z",
  };

  function temporalService(
    repository: OrganizerSpeakerRepository,
    referenceNow = now,
    context = temporalContext,
  ) {
    return new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new FakePrivateAssetGateway(),
      {
        speakerSender,
        now: () => new Date(referenceNow),
        generateId: () => "temporal-generated",
        eventTemporalSource: {
          getEventTemporalContext(organizationId, eventId) {
            return Promise.resolve(
              organizationId === context.organizationId && eventId === context.eventId
                ? context
                : null,
            );
          },
        },
      },
    );
  }

  it.each(["2027-02-30", "2027-04-01T12:00:00", "2027-04-01T12:00:00.000Z"])(
    "rejects non-calendar organizer deadlines without persisting them: %s",
    async (dueAt) => {
      const { repository } = createOrganizerFixture();
      repository.profiles.push(profile("participant-1"));
      const service = temporalService(repository);

      await expect(
        service.createOrganizerTask({
          eventId: "event-1",
          accountId: "account-1",
          type: "action",
          title: "Invalid deadline task",
          dueAt,
          assignments: [
            {
              participantId: "participant-1",
              subject: { type: "participant" },
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(repository.tasks).toEqual([]);
    },
  );

  it("rejects newly selected past deadlines, preserves an exact historical value, and allows dates after event end", async () => {
    const { repository } = createOrganizerFixture();
    repository.profiles.push(profile("participant-1"), profile("participant-2"));
    const service = temporalService(repository);

    await expect(
      service.createOrganizerTask({
        eventId: "event-1",
        accountId: "account-1",
        type: "action",
        title: "Past task",
        dueAt: "2026-08-07",
        assignments: [{ participantId: "participant-1", subject: { type: "participant" } }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const created = await service.createOrganizerTask({
      eventId: "event-1",
      accountId: "account-1",
      type: "action",
      title: "After event task",
      dueAt: "2026-08-20",
      assignments: [{ participantId: "participant-1", subject: { type: "participant" } }],
    });
    expect(created[0]?.dueAt).toBe("2026-08-20");
    await expect(
      service.listOrganizerSpeakerRoster("org-1", "event-1", "account-1"),
    ).resolves.toMatchObject({ temporalContext });

    const historical = task({
      id: "historical-task",
      participantId: "participant-1",
      type: "action",
      dueAt: "2026-08-07",
      version: 4,
    });
    repository.tasks.push(historical);
    await expect(
      service.updateOrganizerTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: historical.id,
        expectedVersion: historical.version,
        title: "Historical task renamed",
        dueAt: "2026-08-07",
      }),
    ).resolves.toMatchObject({
      dueAt: "2026-08-07",
      title: "Historical task renamed",
    });

    await expect(
      service.updateOrganizerTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: historical.id,
        expectedVersion: historical.version + 1,
        dueAt: "2026-08-06",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("changes overdue and zero-offset reminder eligibility only at the event-local day boundary", async () => {
    const { repository } = createOrganizerFixture();
    repository.profiles.push(profile("participant-1"));
    const beforeBoundary = temporalService(repository, "2026-08-09T06:59:59.999Z");
    await beforeBoundary.createOrganizerTask({
      eventId: "event-1",
      accountId: "account-1",
      type: "upload",
      title: "Boundary upload",
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 5_000_000,
      dueAt: "2026-08-08",
      reminderOffsetsMinutes: [0],
      assignments: [{ participantId: "participant-1", subject: { type: "participant" } }],
    });
    repository.tasks.push(
      task({
        id: "boundary-action",
        participantId: "participant-1",
        subject: { type: "participant", participantId: "participant-1" },
        type: "action",
        dueAt: "2026-08-08",
      }),
    );

    await expect(beforeBoundary.listDeliverables("event-1", "account-1")).resolves.toMatchObject({
      items: [{ status: "not_started" }],
    });
    await expect(
      beforeBoundary.previewReminderEligibility({
        eventId: "event-1",
        accountId: "account-1",
      }),
    ).resolves.toMatchObject({
      items: [
        {
          dueAt: "2026-08-08",
          deadlineAt: "2026-08-09T07:00:00.000Z",
          eligible: false,
          reason: "outside_window",
        },
      ],
    });
    await expect(
      beforeBoundary.listOrganizerSpeakerRoster("org-1", "event-1", "account-1"),
    ).resolves.toMatchObject({ speakers: [{ taskSummary: { overdue: 0 } }] });

    const atBoundary = temporalService(repository, "2026-08-09T07:00:00.000Z");
    await expect(atBoundary.listDeliverables("event-1", "account-1")).resolves.toMatchObject({
      items: [{ status: "overdue" }],
    });
    await expect(
      atBoundary.previewReminderEligibility({
        eventId: "event-1",
        accountId: "account-1",
      }),
    ).resolves.toMatchObject({
      items: [
        {
          deadlineAt: "2026-08-09T07:00:00.000Z",
          eligible: true,
          reason: "due",
        },
      ],
    });
    await expect(
      atBoundary.listOrganizerSpeakerRoster("org-1", "event-1", "account-1"),
    ).resolves.toMatchObject({ speakers: [{ taskSummary: { overdue: 1 } }] });
  });

  it.each([
    {
      dueAt: "2019-09-07",
      timeZone: "America/Santiago",
      deadlineAt: "2019-09-08T04:00:00.000Z",
    },
    {
      dueAt: "2011-12-29",
      timeZone: "Pacific/Apia",
      deadlineAt: "2011-12-30T10:00:00.000Z",
    },
  ])(
    "keeps $dueAt inclusive for speaker status and reminders across the $timeZone transition",
    async ({ dueAt, timeZone, deadlineAt }) => {
      const { repository } = createOrganizerFixture();
      repository.profiles.push(profile("participant-1"));
      repository.tasks.push(
        task({
          id: "transition-upload",
          participantId: "participant-1",
          subject: { type: "participant", participantId: "participant-1" },
          type: "upload",
          dueAt,
          reminderOffsetsMinutes: [0],
        }),
      );
      const context = {
        ...temporalContext,
        timeZone,
        startsAt: deadlineAt,
        endsAt: new Date(new Date(deadlineAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
      const beforeDeadline = temporalService(
        repository,
        new Date(new Date(deadlineAt).getTime() - 1).toISOString(),
        context,
      );

      await expect(beforeDeadline.listDeliverables("event-1", "account-1")).resolves.toMatchObject({
        items: [{ status: "not_started" }],
      });
      await expect(
        beforeDeadline.previewReminderEligibility({
          eventId: "event-1",
          accountId: "account-1",
        }),
      ).resolves.toMatchObject({
        items: [{ deadlineAt, eligible: false, reason: "outside_window" }],
      });

      const atDeadline = temporalService(repository, deadlineAt, context);
      await expect(atDeadline.listDeliverables("event-1", "account-1")).resolves.toMatchObject({
        items: [{ status: "overdue" }],
      });
      await expect(
        atDeadline.previewReminderEligibility({
          eventId: "event-1",
          accountId: "account-1",
        }),
      ).resolves.toMatchObject({
        items: [{ deadlineAt, eligible: true, reason: "due" }],
      });
    },
  );

  it("requires strict travel dates, enforces ordering, and converts stored timestamps in the event timezone", async () => {
    const { repository } = createOrganizerFixture();
    repository.profiles.push({
      ...profile("participant-1"),
      version: 3,
      travelLogistics: {
        travelRequired: true,
        arrivalAt: "2026-08-10T06:30:00.000Z",
        departureAt: "2026-08-13T06:30:00.000Z",
        accommodation: "",
        dietaryRequirements: "",
        accessibilityNeeds: "",
        travelNotes: "",
      },
    });
    const service = temporalService(repository);

    await expect(
      service.updateOrganizerProfile({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        expectedVersion: 3,
        travelLogistics: { arrivalAt: "2026-08-10T12:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(
      service.updateOrganizerProfile({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        expectedVersion: 3,
        travelLogistics: { arrivalAt: "2026-08-14", departureAt: "2026-08-13" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const updated = await service.updateOrganizerProfile({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      expectedVersion: 3,
      company: "Updated company",
      travelLogistics: {},
    });
    expect(updated.travelLogistics).toMatchObject({
      arrivalAt: "2026-08-09",
      departureAt: "2026-08-12",
    });
  });
});

it("persists logistics, exposes reminder eligibility, and queues a versioned bulk email", async () => {
  const { repository } = createOrganizerFixture();
  const deliveries: Array<{
    participantId: string;
    sender: string;
    subject: string;
    html: string;
  }> = [];
  const communicationFixture = testSpeakerCommunications({
    send(input) {
      deliveries.push({
        participantId: input.recipientId,
        sender: input.from,
        subject: input.subject,
        html: input.html,
      });
      return Promise.resolve({ status: "queued" as const });
    },
  });
  const service = new SpeakerService(
    withTestSpeakerOrganizerLifecycle(repository),
    new FakePrivateAssetGateway(),
    {
      speakerSender,
      now: () => new Date(now),
      generateId: (() => {
        let sequence = 0;
        return () => `email-generated-${++sequence}`;
      })(),
      communications: communicationFixture.communications,
      eventTemporalSource: speakerEventTemporalSource,
    },
  );

  await service.createOrganizerSpeaker({
    organizationId: "org-1",
    eventId: "event-1",
    accountId: "account-1",
    displayName: "Priya Raman",
    email: "priya@example.test",
    jobTitle: "Principal Engineer",
    company: "Latticework Systems",
    biography: "Builds reliable developer platforms.",
    socialLinks: {},
    status: "confirmed",
    travelLogistics: {
      travelRequired: true,
      arrivalAt: "2026-08-07",
      departureAt: "2026-08-10",
      accommodation: "Hotel near venue",
      dietaryRequirements: "Vegetarian",
      accessibilityNeeds: "Quiet room",
      travelNotes: "Arrange airport transfer",
    },
    idempotencyKey: "speaker-priya",
    sourceType: "cfp",
    sourceId: "submission-1:participant-1",
    explicitParticipantId: "participant-1",
  });
  const roster = await service.createOrganizerSpeaker({
    organizationId: "org-1",
    eventId: "event-1",
    accountId: "account-1",
    displayName: "Marcus Okafor",
    email: "marcus@example.test",
    jobTitle: "Community Lead",
    company: "Northstar",
    biography: "Builds community programs.",
    socialLinks: {},
    status: "confirmed",
    idempotencyKey: "speaker-marcus",
    sourceType: "cfp",
    sourceId: "submission-2:participant-2",
    explicitParticipantId: "participant-2",
  });
  const priya = roster.speakers.find((speaker) => speaker.participantId === "participant-1");
  expect(
    (priya as (typeof priya & { travelLogistics?: Record<string, unknown> }) | undefined)
      ?.travelLogistics,
  ).toMatchObject({
    travelRequired: true,
    accommodation: "Hotel near venue",
    dietaryRequirements: "Vegetarian",
  });

  const task = await service.createOrganizerTask({
    eventId: "event-1",
    accountId: "account-1",
    type: "upload",
    title: "Upload arrival details",
    description: "Share the confirmed arrival plan.",
    allowedMimeTypes: ["application/pdf"],
    maxBytes: 5_000_000,
    dueAt: "2026-08-08",
    reminderOffsetsMinutes: [1_440],
    assignments: [
      { participantId: "participant-1", subject: { type: "participant" } },
      { participantId: "participant-2", subject: { type: "participant" } },
    ],
  });
  expect(task).toHaveLength(2);
  expect(new Set(task.map((item) => item.participantId))).toEqual(
    new Set(["participant-1", "participant-2"]),
  );
  expect(task.map((item) => item.subject?.type)).toEqual(["participant", "participant"]);
  expect(task.every((item) => item.dueAt === "2026-08-08")).toBe(true);

  const actionTask = task[0];
  if (actionTask === undefined) {
    throw new Error("Expected an upload task fixture.");
  }
  repository.tasks.push({
    ...actionTask,
    id: "action-reminder-contamination",
    type: "action",
  });

  const eligibility = await service.getReminderEligibility({
    eventId: "event-1",
    accountId: "account-1",
  });
  expect(eligibility.eligibleTaskIds).toEqual(expect.arrayContaining(task.map((item) => item.id)));
  expect(eligibility.items.some((item) => item.taskId === "action-reminder-contamination")).toBe(
    false,
  );

  const template = await service.createOrganizerSpeakerEmailTemplate({
    organizationId: "org-1",
    eventId: "event-1",
    accountId: "account-1",
    name: "Speaker update",
    subject: "Hello {{first_name}} at {{email}}",
    html: "<p>Hello {{first_name}} ({{display_name}}) at {{email}}</p>",
    text: "Hello {{first_name}}, {{display_name}} ({{email}})",
  });
  expect(template.sender).toBe(speakerSender);
  const preview = await service.previewOrganizerSpeakerEmails({
    organizationId: "org-1",
    eventId: "event-1",
    accountId: "account-1",
    participantIds: ["participant-1", "participant-2"],
    templateId: template.id,
    templateVersion: template.version,
  });
  expect(preview.sender).toBe(speakerSender);
  expect(preview.recipients[0]).toMatchObject({
    displayName: "Priya Raman",
    firstName: "Priya",
    email: "priya@example.test",
    subject: "Hello Priya at priya@example.test",
    html: "<p>Hello Priya, Priya Raman (priya@example.test)</p>",
    text: "Hello Priya, Priya Raman (priya@example.test)",
  });
  const reloadedService = new SpeakerService(
    withTestSpeakerOrganizerLifecycle(repository),
    new FakePrivateAssetGateway(),
    {
      speakerSender: "changed@example.test",
      now: () => new Date(now),
      communications: communicationFixture.communications,
    },
  );
  const send = await reloadedService.sendOrganizerSpeakerEmails({
    organizationId: "org-1",
    eventId: "event-1",
    accountId: "account-1",
    previewId: preview.id,
    idempotencyKey: "bulk-email-once",
  });
  expect(send).toMatchObject({ status: "queued", sender: speakerSender });
  expect(deliveries).toHaveLength(2);
  expect(deliveries.every((delivery) => delivery.sender === speakerSender)).toBe(true);
  expect(send.history.some((entry) => entry.action === "delivery_queued")).toBe(true);
  const replay = await reloadedService.sendOrganizerSpeakerEmails({
    organizationId: "org-1",
    eventId: "event-1",
    accountId: "account-1",
    previewId: preview.id,
    idempotencyKey: "bulk-email-once",
  });
  expect(replay.id).toBe(send.id);
  expect(deliveries).toHaveLength(2);
});

it("does not send invitation email when pending persistence fails for a verified account", async () => {
  const { repository } = createOrganizerFixture();
  const deliveries: Array<{ participantId: string; text: string }> = [];
  const communicationFixture = testSpeakerCommunications({
    send(input) {
      deliveries.push({ participantId: input.recipientId, text: input.text });
      return Promise.resolve({
        status: "queued",
        providerMessageId: "unexpected-delivery",
      });
    },
  });
  const sendInvitations = vi.spyOn(communicationFixture.communications, "sendInvitations");
  const persistenceError = new Error("pending invitation persistence failed");
  const invitationCreator = {
    create: vi.fn().mockRejectedValue(persistenceError),
  };
  const invitationService = new SpeakerService(
    withTestSpeakerOrganizerLifecycle(repository),
    new FakePrivateAssetGateway(),
    {
      speakerSender,
      now: () => new Date(now),
      communications: communicationFixture.communications,
      invitationCreator,
    },
  );

  await expect(
    invitationService.sendOrganizerSpeakerInvitations({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      participantIds: ["participant-1"],
      templateId: "client-template-is-not-authoritative",
      idempotencyKey: "invite-persistence-failure",
    }),
  ).rejects.toBe(persistenceError);
  expect(invitationCreator.create).toHaveBeenCalledWith(
    expect.objectContaining({
      recipientUserId: "account:participant-1",
      normalizedEmail: "priya@example.test",
      participantId: "participant-1",
      creationIdempotencyKey: "invite-persistence-failure:participant-1",
    }),
  );
  expect(sendInvitations).not.toHaveBeenCalled();
  expect(deliveries).toEqual([]);
});

it("still sends a non-authoritative work-hub invitation when no verified account exists", async () => {
  const { repository } = createOrganizerFixture();
  repository.verifiedEmails.delete("participant-1");
  const deliveries: Array<{ participantId: string; text: string }> = [];
  const communicationFixture = testSpeakerCommunications({
    send(input) {
      deliveries.push({ participantId: input.recipientId, text: input.text });
      return Promise.resolve({
        status: "queued",
        providerMessageId: "invite-receipt",
      });
    },
  });
  const invitationCreator = { create: vi.fn().mockResolvedValue(undefined) };
  const invitationService = new SpeakerService(
    withTestSpeakerOrganizerLifecycle(repository),
    new FakePrivateAssetGateway(),
    {
      speakerSender,
      now: () => new Date(now),
      communications: communicationFixture.communications,
      invitationCreator,
    },
  );

  await expect(
    invitationService.sendOrganizerSpeakerInvitations({
      organizationId: "org-1",
      eventId: "event-1",
      accountId: "account-1",
      participantIds: ["participant-1"],
      templateId: "client-template-is-not-authoritative",
      idempotencyKey: "invite-before-account",
    }),
  ).resolves.toMatchObject({ status: "queued", duplicate: false });
  expect(invitationCreator.create).not.toHaveBeenCalled();
  expect(deliveries).toEqual([
    {
      participantId: "participant-1",
      text: expect.stringContaining("review and accept your speaker invitation"),
    },
  ]);
  expect(deliveries[0]?.text).toContain("/login?next=/work");
  expect(JSON.stringify(deliveries)).not.toMatch(/grant|token|secret/iu);
});

it("uses the approved welcome template and reports durable invitation replays", async () => {
  const { repository } = createOrganizerFixture();
  const deliveries: Array<{ participantId: string; text: string }> = [];
  const communicationFixture = testSpeakerCommunications({
    send(input) {
      deliveries.push({ participantId: input.recipientId, text: input.text });
      return Promise.resolve(
        input.recipientId === "participant-1"
          ? { status: "queued" as const, providerMessageId: "invite-receipt-1" }
          : {
              status: "failed" as const,
              providerMessageId: "invite-receipt-2",
              reason: "provider rejected message",
            },
      );
    },
  });
  const invitationRepository = new InMemoryEventRoleInvitationRepository();
  const invitationService = new SpeakerService(
    withTestSpeakerOrganizerLifecycle(repository),
    new FakePrivateAssetGateway(),
    {
      speakerSender,
      now: () => new Date(now),
      communications: communicationFixture.communications,
      invitationCreator: invitationRepository,
    },
  );

  const first = await invitationService.sendOrganizerSpeakerInvitations({
    organizationId: "org-1",
    eventId: "event-1",
    accountId: "account-1",
    participantIds: ["participant-1", "participant-2", "participant-1"],
    templateId: "client-template-is-not-authoritative",
    idempotencyKey: "invite-once",
  });
  expect(first).toMatchObject({
    organizationId: "org-1",
    eventId: "event-1",
    idempotencyKey: "invite-once",
    status: "failed",
    duplicate: false,
    recipients: [
      {
        participantId: "participant-1",
        recipientEmail: "priya@example.test",
        status: "queued",
        receiptId: "invite-receipt-1",
      },
      {
        participantId: "participant-2",
        recipientEmail: "marcus@example.test",
        status: "failed",
        receiptId: "invite-receipt-2",
      },
    ],
  });
  expect(deliveries).toHaveLength(2);
  expect(
    deliveries.every(
      (delivery) =>
        delivery.text.includes("review and accept your speaker invitation") &&
        delivery.text.includes("/login?next=/work"),
    ),
  ).toBe(true);
  expect(JSON.stringify(deliveries)).not.toMatch(/grant|token|secret/iu);
  await expect(
    invitationRepository.listForVerifiedAccount("account:participant-1", "priya@example.test"),
  ).resolves.toHaveLength(1);
  await expect(
    invitationRepository.listForVerifiedAccount("account:participant-2", "marcus@example.test"),
  ).resolves.toHaveLength(1);

  const replay = await invitationService.sendOrganizerSpeakerInvitations({
    organizationId: "org-1",
    eventId: "event-1",
    accountId: "account-1",
    participantIds: ["participant-1", "participant-2"],
    templateId: "another-client-template",
    idempotencyKey: "invite-once",
  });
  expect(replay).toMatchObject({
    status: "failed",
    duplicate: false,
    recipients: [
      { participantId: "participant-1", status: "duplicate" },
      { participantId: "participant-2", status: "failed" },
    ],
  });
  expect(deliveries).toHaveLength(2);
  await expect(
    invitationRepository.listForVerifiedAccount("account:participant-1", "priya@example.test"),
  ).resolves.toHaveLength(1);
  await expect(
    invitationRepository.listForVerifiedAccount("account:participant-2", "marcus@example.test"),
  ).resolves.toHaveLength(1);
});
it("queues due scheduled reminders idempotently without sending ineligible tasks", async () => {
  const { repository } = createOrganizerFixture();
  repository.tasks.push(
    task({
      id: "scheduled-due",
      participantId: "participant-1",
      dueAt: "2026-08-07",
      reminderOffsetsMinutes: [60],
    }),
    task({
      id: "scheduled-complete",
      participantId: "participant-1",
      status: "completed",
      dueAt: "2026-08-07",
      reminderOffsetsMinutes: [60],
    }),
    task({
      id: "scheduled-no-due",
      participantId: "participant-1",
      reminderOffsetsMinutes: [60],
    }),
    task({
      id: "scheduled-future",
      participantId: "participant-1",
      dueAt: "2026-09-01",
      reminderOffsetsMinutes: [60],
    }),
  );
  const deliveries: Array<{
    readonly actorAccountId: string;
    readonly idempotencyKey: string;
    readonly participantId: string;
    readonly taskIds: readonly string[];
  }> = [];
  const scheduledService = new SpeakerService(
    withTestSpeakerOrganizerLifecycle(repository),
    new FakePrivateAssetGateway(),
    {
      speakerSender,
      now: () => new Date(now),
      eventTemporalSource: speakerEventTemporalSource,
      delivery: {
        enqueue(input) {
          deliveries.push({
            actorAccountId: input.actorAccountId,
            idempotencyKey: input.idempotencyKey,
            participantId: input.recipient.participantId,
            taskIds: input.recipient.taskIds,
          });
          return Promise.resolve({
            id: "reminder-receipt-1",
            queued: true,
            duplicate: false,
          });
        },
      },
    },
  );

  const first = await scheduledService.queueScheduledReminders({
    organizationId: "org-1",
    eventId: "event-1",
    organizerAccountIds: ["account-1"],
  });
  const second = await scheduledService.queueScheduledReminders({
    organizationId: "org-1",
    eventId: "event-1",
    organizerAccountIds: ["account-1"],
  });

  expect(first).toMatchObject({
    queued: true,
    duplicate: false,
    sentCount: 1,
    recipientIds: ["participant-1"],
    failedCount: 0,
    duplicateCount: 0,
    receipts: [
      {
        participantId: "participant-1",
        status: "queued",
        receiptId: "reminder-receipt-1",
      },
    ],
  });
  expect(second).toMatchObject({
    queued: false,
    duplicate: true,
    sentCount: 0,
    idempotencyKey: first.idempotencyKey,
    failedCount: 0,
    duplicateCount: 1,
    receipts: [
      {
        participantId: "participant-1",
        status: "duplicate",
        receiptId: "reminder-receipt-1",
      },
    ],
  });
  expect(deliveries).toEqual([
    {
      actorAccountId: "system:speaker-reminder-scheduler",
      idempotencyKey: `${first.idempotencyKey}:participant-1`,
      participantId: "participant-1",
      taskIds: ["scheduled-due"],
    },
  ]);
});
