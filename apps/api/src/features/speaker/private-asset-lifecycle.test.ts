import { describe, expect, it, vi } from "vitest";
import { R2PrivateAssetGateway } from "../../infrastructure/cloudflare/private-assets";
import { createSpeakerRoutes } from "./routes";
import { SpeakerService } from "./service";
import { withTestSpeakerOrganizerLifecycle } from "./test-lifecycle-adapter";
import type {
  CreatePendingSpeakerAssetVersionCommand,
  PrivateAssetCapabilityBinding,
  PrivateAssetGateway,
  PrivateDownloadCapabilityBinding,
  PrivateDownloadGrant,
  PrivateDownloadObject,
  PrivateUploadGrant,
  PrivateUploadReceipt,
  RepositoryResult,
  RestoreSpeakerContentVersionCommand,
  SpeakerAccessScope,
  SpeakerAsset,
  SpeakerAssetAuditEntry,
  SpeakerAssetComment,
  SpeakerAssetReviewCommand,
  SpeakerContentHistoryEntry,
  SpeakerContentRecord,
  SpeakerDeliverablesExportManifest,
  SpeakerEventResource,
  SpeakerOrganizerAccessScope,
  SpeakerPortalContext,
  SpeakerProfile,
  SpeakerRepository,
  SpeakerRosterEntry,
  SpeakerSubmission,
  SpeakerTask,
  SpeakerTaskFormDefinition,
  SpeakerTaskRepositoryCommand,
  SpeakerTaskResponseRecord,
  SpeakerTaskTransition,
  SpeakerWikiPage,
  TransitionSpeakerTaskCommand,
  UpdateSpeakerContentCommand,
  UpdateSpeakerProfileCommand,
} from "./types";

const speakerSender = "speakers@self-hosted.example";
const now = "2026-08-09T00:00:00.000Z";

class LifecycleRepository implements SpeakerRepository {
  readonly scopes = new Map<string, SpeakerAccessScope>();
  readonly organizerScopes = new Map<string, SpeakerOrganizerAccessScope>();
  readonly submissions: SpeakerSubmission[] = [
    {
      id: "submission-1",
      eventId: "event-1",
      title: "Session",
      status: "accepted",
      participantIds: ["participant-1"],
      updatedAt: now,
    },
  ];
  readonly profiles: SpeakerProfile[] = [];
  readonly tasks: SpeakerTask[] = [
    {
      id: "upload-task",
      tenantId: "tenant-1",
      eventId: "event-1",
      participantId: "participant-1",
      subject: {
        type: "session",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-1",
      },
      type: "upload",
      owner: "speaker",
      title: "Upload slides",
      status: "in_progress",
      dependencyIds: [],
      reminderOffsetsMinutes: [],
      acceptedAssetKinds: ["slides"],
      version: 1,
      updatedAt: now,
    },
  ];
  readonly assets: SpeakerAsset[] = [];
  readonly assetVersionCreations = new Map<string, { requestDigest: string; assetId: string }>();
  readonly roster: SpeakerRosterEntry[] = [];
  readonly forms: SpeakerTaskFormDefinition[] = [
    {
      id: "form-upload-task",
      eventId: "event-1",
      taskId: "upload-task",
      title: "Speaker details",
      description: "Tell us about your session.",
      fields: [
        {
          id: "bio",
          key: "bio",
          label: "Biography",
          type: "textarea",
          required: true,
          minLength: 3,
        },
        {
          id: "track",
          key: "track",
          label: "Track",
          type: "select",
          required: true,
          options: [{ value: "web", label: "Web" }],
        },
      ],
      version: 2,
      published: true,
      updatedAt: now,
    },
  ];
  readonly responses: SpeakerTaskResponseRecord[] = [];
  readonly taskTransitions: SpeakerTaskTransition[] = [];
  readonly comments: SpeakerAssetComment[] = [];
  readonly contexts: SpeakerPortalContext[] = [
    {
      id: "portal:tenant-1:event-1",
      eventId: "event-1",
      name: "Event One",
      slug: "event-one",
      capabilities: [
        "profile-self",
        "submission-edit",
        "roster-manage",
        "task-response",
        "asset-read",
        "asset-write",
        "asset-comment",
        "resource-read",
      ],
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      primaryParticipantId: "participant-1",
    },
  ];
  readonly resources: SpeakerEventResource[] = [
    {
      id: "resource-2",
      eventId: "event-1",
      title: "Second",
      order: 2,
      updatedAt: now,
      html: "<p>safe</p><script>alert(1)</script>",
      url: "javascript:alert(1)",
    },
    {
      id: "resource-1",
      eventId: "event-1",
      title: "First",
      order: 1,
      updatedAt: now,
      url: "https://docs.example.test/guide",
    },
    {
      id: "resource-other",
      eventId: "event-2",
      title: "Other event",
      order: 0,
      updatedAt: now,
    },
  ];
  readonly wiki: SpeakerWikiPage[] = [
    {
      id: "wiki-1",
      eventId: "event-1",
      title: "Welcome",
      order: 1,
      updatedAt: now,
      slug: "welcome",
      html: '<a href="https://example.test">Read</a>',
    },
  ];

  constructor() {
    this.scopes.set("event-1:account-1", {
      tenantId: "tenant-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      capabilities: [
        "profile-self",
        "submission-edit",
        "roster-manage",
        "task-response",
        "asset-read",
        "asset-write",
        "asset-comment",
        "resource-read",
      ],
      capabilitiesByParticipant: {
        "participant-1": [
          "profile-self",
          "submission-edit",
          "roster-manage",
          "task-response",
          "asset-read",
          "asset-write",
          "asset-comment",
          "resource-read",
        ],
      },
      primaryParticipantId: "participant-1",
    });
    this.scopes.set("event-1:account-2", {
      tenantId: "tenant-2",
      submissionIds: [],
      participantIds: [],
    });
  }

  getAccessScope(eventId: string, accountId: string): Promise<SpeakerAccessScope> {
    return Promise.resolve(
      this.scopes.get(`${eventId}:${accountId}`) ?? {
        submissionIds: [],
        participantIds: [],
      },
    );
  }
  getAccountDisplayName(accountId: string): Promise<string | null> {
    return Promise.resolve(
      accountId === "account-1"
        ? "Alex Rivera"
        : accountId === "organizer"
          ? "Local Organizer"
          : null,
    );
  }
  getOrganizerAccessScope(
    eventId: string,
    accountId: string,
  ): Promise<SpeakerOrganizerAccessScope | null> {
    return Promise.resolve(this.organizerScopes.get(`${eventId}:${accountId}`) ?? null);
  }
  listSubmissions(eventId: string, ids: readonly string[]): Promise<SpeakerSubmission[]> {
    return Promise.resolve(
      this.submissions.filter(
        (submission) => submission.eventId === eventId && ids.includes(submission.id),
      ),
    );
  }
  getSubmission(eventId: string, id: string): Promise<SpeakerSubmission | null> {
    return Promise.resolve(
      this.submissions.find(
        (submission) => submission.eventId === eventId && submission.id === id,
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
  getProfile(eventId: string, participantId: string): Promise<SpeakerProfile | null> {
    return Promise.resolve(
      this.profiles.find(
        (profile) => profile.eventId === eventId && profile.participantId === participantId,
      ) ?? null,
    );
  }
  updateBiography(): Promise<RepositoryResult<SpeakerProfile>> {
    return Promise.resolve({ ok: false, reason: "not_found" });
  }
  createTask(command: SpeakerTaskRepositoryCommand): Promise<RepositoryResult<SpeakerTask>> {
    if (this.tasks.some((task) => task.id === command.task.id)) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    this.tasks.push(command.task);
    return Promise.resolve({ ok: true, value: command.task });
  }
  updateTask(command: SpeakerTaskRepositoryCommand): Promise<RepositoryResult<SpeakerTask>> {
    const index = this.tasks.findIndex((task) => task.id === command.task.id);
    if (index < 0) return Promise.resolve({ ok: false, reason: "not_found" });
    const task = this.tasks[index];
    if (task === undefined || task.version !== command.expectedVersion) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    this.tasks[index] = command.task;
    return Promise.resolve({ ok: true, value: command.task });
  }
  reviewAsset(command: SpeakerAssetReviewCommand): Promise<RepositoryResult<SpeakerAsset>> {
    const asset = this.assets.find(
      (candidate) => candidate.eventId === command.eventId && candidate.id === command.assetId,
    );
    if (asset === undefined) return Promise.resolve({ ok: false, reason: "not_found" });
    if ((asset.reviewVersion ?? 0) !== command.expectedVersion) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    const returnTask =
      command.returnTask === undefined
        ? undefined
        : this.tasks.find((candidate) => candidate.id === command.returnTask?.taskId);
    if (command.returnTask !== undefined) {
      if (returnTask === undefined) return Promise.resolve({ ok: false, reason: "not_found" });
      if (
        command.returnTask.eventId !== command.eventId ||
        command.returnTask.baselineAssetId !== command.assetId ||
        (command.returnTask.transition !== undefined &&
          (command.returnTask.transition.eventId !== command.eventId ||
            command.returnTask.transition.taskId !== command.returnTask.taskId ||
            command.returnTask.transition.participantId !== returnTask.participantId))
      ) {
        return Promise.resolve({ ok: false, reason: "invalid_state" });
      }
      if (
        returnTask.version !== command.returnTask.expectedVersion ||
        returnTask.status !== command.returnTask.fromStatus
      ) {
        return Promise.resolve({ ok: false, reason: "version_conflict" });
      }
    }
    asset.reviewState = command.state;
    if (command.note === undefined) delete asset.reviewNote;
    else asset.reviewNote = command.note;
    asset.reviewedAt = command.reviewedAt;
    asset.reviewedBy = command.reviewedBy;
    asset.reviewVersion = command.expectedVersion + 1;
    if (command.state === "approved") asset.approvedVersionId = asset.id;
    if (command.release) asset.releasedVersionId = asset.id;
    if (command.returnTask !== undefined && returnTask !== undefined) {
      returnTask.status = command.returnTask.toStatus;
      returnTask.replacementBaselineAssetId = command.returnTask.baselineAssetId;
      returnTask.version = command.returnTask.expectedVersion + 1;
      returnTask.updatedAt = command.returnTask.transition?.occurredAt ?? command.reviewedAt;
      if (command.returnTask.transition !== undefined) {
        this.taskTransitions.push(command.returnTask.transition);
      }
    }
    return Promise.resolve({ ok: true, value: asset });
  }
  appendAssetAudit(_entry: SpeakerAssetAuditEntry): Promise<void> {
    return Promise.resolve();
  }
  updateProfile(_command: UpdateSpeakerProfileCommand): Promise<RepositoryResult<SpeakerProfile>> {
    return Promise.resolve({ ok: false, reason: "not_found" });
  }
  listTasks(eventId: string, ids: readonly string[]): Promise<SpeakerTask[]> {
    return Promise.resolve(
      this.tasks.filter((task) => task.eventId === eventId && ids.includes(task.participantId)),
    );
  }
  getTask(eventId: string, id: string): Promise<SpeakerTask | null> {
    return Promise.resolve(
      this.tasks.find((task) => task.eventId === eventId && task.id === id) ?? null,
    );
  }
  getTasksByIds(eventId: string, ids: readonly string[]): Promise<SpeakerTask[]> {
    return Promise.resolve(
      this.tasks.filter((task) => task.eventId === eventId && ids.includes(task.id)),
    );
  }
  transitionTask(
    command: TransitionSpeakerTaskCommand,
  ): Promise<RepositoryResult<{ task: SpeakerTask; transition: SpeakerTaskTransition }>> {
    const task = this.tasks.find((candidate) => candidate.id === command.taskId);
    if (task === undefined) return Promise.resolve({ ok: false, reason: "not_found" });
    if (task.version !== command.expectedVersion)
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    task.status = command.toStatus;
    if (command.toStatus === "submitted") delete task.replacementBaselineAssetId;
    task.version += 1;
    this.taskTransitions.push(command.transition);
    return Promise.resolve({
      ok: true,
      value: { task, transition: command.transition },
    });
  }
  createPendingAsset(asset: SpeakerAsset): Promise<SpeakerAsset> {
    this.assets.push(asset);
    return Promise.resolve(asset);
  }
  createPendingAssetVersion(
    command: CreatePendingSpeakerAssetVersionCommand,
  ): Promise<RepositoryResult<SpeakerAsset>> {
    const key = `${command.asset.eventId}:${command.idempotencyKey}`;
    const replay = this.assetVersionCreations.get(key);
    if (replay !== undefined) {
      const asset = this.assets.find((candidate) => candidate.id === replay.assetId);
      return Promise.resolve(
        replay.requestDigest === command.requestDigest &&
          asset !== undefined &&
          asset.supersedesAssetId === command.expectedLatestAssetId
          ? { ok: true, value: asset }
          : { ok: false, reason: "version_conflict" },
      );
    }
    const familyId = command.asset.versionFamilyId ?? command.asset.id;
    const family = this.assets.filter(
      (candidate) => (candidate.versionFamilyId ?? candidate.id) === familyId,
    );
    const expected = family.find(
      (candidate) =>
        candidate.id === command.expectedLatestAssetId &&
        candidate.version === command.expectedLatestVersion &&
        (candidate.state === "ready" || candidate.state === "rejected"),
    );
    const hasNewerVersion = family.some(
      (candidate) => (candidate.version ?? 1) > command.expectedLatestVersion,
    );
    if (expected === undefined || hasNewerVersion) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    this.assets.push(command.asset);
    this.assetVersionCreations.set(key, {
      requestDigest: command.requestDigest,
      assetId: command.asset.id,
    });
    return Promise.resolve({ ok: true, value: command.asset });
  }
  getAsset(eventId: string, id: string): Promise<SpeakerAsset | null> {
    return Promise.resolve(
      this.assets.find((asset) => asset.eventId === eventId && asset.id === id) ?? null,
    );
  }
  listAssets(eventId: string, participantIds: readonly string[]): Promise<SpeakerAsset[]> {
    return Promise.resolve(
      this.assets.filter(
        (asset) => asset.eventId === eventId && participantIds.includes(asset.participantId),
      ),
    );
  }
  finalizeAsset(command: {
    eventId: string;
    assetId: string;
    state: "ready" | "rejected";
    finalizedAt: string;
    rejectionReason?: string;
    latestVersionId: string;
    currentVersionId?: string;
  }): Promise<RepositoryResult<SpeakerAsset>> {
    const asset = this.assets.find(
      (candidate) => candidate.eventId === command.eventId && candidate.id === command.assetId,
    );
    if (asset === undefined) return Promise.resolve({ ok: false, reason: "not_found" });
    if (asset.state !== "pending_upload")
      return Promise.resolve({ ok: false, reason: "invalid_state" });
    asset.state = command.state;
    asset.finalizedAt = command.finalizedAt;
    asset.latestVersionId = command.latestVersionId;
    if (command.currentVersionId === undefined) delete asset.currentVersionId;
    else asset.currentVersionId = command.currentVersionId;
    if (command.rejectionReason !== undefined) asset.rejectionReason = command.rejectionReason;
    return Promise.resolve({ ok: true, value: asset });
  }
  listPortalContexts(accountId: string): Promise<SpeakerPortalContext[]> {
    return Promise.resolve(accountId === "account-1" ? this.contexts : []);
  }

  listRoster(eventId: string, submissionId: string): Promise<SpeakerRosterEntry[]> {
    return Promise.resolve(
      this.roster.filter(
        (entry) => entry.eventId === eventId && entry.submissionId === submissionId,
      ),
    );
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
    const rosterEntry = this.roster[index];
    if (rosterEntry === undefined || rosterEntry.version !== expectedVersion) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    this.roster[index] = entry;
    return Promise.resolve({ ok: true, value: entry });
  }

  revokeRoster(
    eventId: string,
    submissionId: string,
    participantId: string,
    expectedVersion: number,
    updatedAt: string,
  ): Promise<RepositoryResult<SpeakerRosterEntry>> {
    const entry = this.roster.find(
      (candidate) =>
        candidate.eventId === eventId &&
        candidate.submissionId === submissionId &&
        candidate.participantId === participantId,
    );
    if (entry === undefined) return Promise.resolve({ ok: false, reason: "not_found" });
    return this.saveRoster(
      { ...entry, status: "revoked", version: entry.version + 1, updatedAt },
      expectedVersion,
    );
  }

  getTaskForm(eventId: string, taskId: string): Promise<SpeakerTaskFormDefinition | null> {
    return Promise.resolve(
      this.forms.find(
        (definition) => definition.eventId === eventId && definition.taskId === taskId,
      ) ?? null,
    );
  }

  listTaskResponses(
    eventId: string,
    taskId: string,
    participantId: string,
  ): Promise<SpeakerTaskResponseRecord[]> {
    return Promise.resolve(
      this.responses.filter(
        (response) =>
          response.eventId === eventId &&
          response.taskId === taskId &&
          response.participantId === participantId,
      ),
    );
  }

  saveTaskResponse(
    response: SpeakerTaskResponseRecord,
    expectedVersion: number | null,
  ): Promise<RepositoryResult<SpeakerTaskResponseRecord>> {
    if (this.responses.some((candidate) => candidate.id === response.id)) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    const currentVersion = this.responses
      .filter(
        (candidate) =>
          candidate.eventId === response.eventId &&
          candidate.taskId === response.taskId &&
          candidate.participantId === response.participantId,
      )
      .reduce((maximum, candidate) => Math.max(maximum, candidate.version), 0);
    if (expectedVersion === null ? currentVersion !== 0 : currentVersion !== expectedVersion) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    this.responses.push(response);
    return Promise.resolve({ ok: true, value: response });
  }

  listAssetHistory(eventId: string, versionFamilyId: string): Promise<SpeakerAsset[]> {
    return Promise.resolve(
      this.assets.filter(
        (asset) =>
          asset.eventId === eventId && (asset.versionFamilyId ?? asset.id) === versionFamilyId,
      ),
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

  listEventResources(eventId: string): Promise<SpeakerEventResource[]> {
    return Promise.resolve(this.resources.filter((resource) => resource.eventId === eventId));
  }

  listWikiPages(eventId: string): Promise<SpeakerWikiPage[]> {
    return Promise.resolve(this.wiki.filter((page) => page.eventId === eventId));
  }
  getContent(): Promise<SpeakerContentRecord | null> {
    return Promise.resolve(null);
  }
  listContentHistory(): Promise<SpeakerContentHistoryEntry[]> {
    return Promise.resolve([]);
  }
  updateContent(
    _command: UpdateSpeakerContentCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>> {
    return Promise.resolve({ ok: false, reason: "not_found" });
  }
  restoreContentVersion(
    _command: RestoreSpeakerContentVersionCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>> {
    return Promise.resolve({ ok: false, reason: "not_found" });
  }
}

class CapabilityGateway implements PrivateAssetGateway {
  readonly uploadBindings: PrivateAssetCapabilityBinding[] = [];
  readonly downloadBindings: PrivateAssetCapabilityBinding[] = [];
  readonly invalidatedUploadBindings: PrivateAssetCapabilityBinding[] = [];
  readonly uploaded = new Set<string>();
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  createUploadGrant(): Promise<PrivateUploadGrant> {
    return Promise.resolve({
      method: "PUT",
      url: "/legacy",
      headers: {},
      expiresAt: now,
    });
  }
  createDownloadGrant(): Promise<PrivateDownloadGrant> {
    return Promise.resolve({ url: "/legacy", expiresAt: now });
  }
  registerUploadCapability(binding: PrivateAssetCapabilityBinding): Promise<PrivateUploadGrant> {
    this.uploadBindings.push(binding);
    return Promise.resolve({
      method: "PUT",
      url: `/api/speaker/assets/capabilities/upload/${binding.capabilityId}/opaque-token`,
      headers: { "content-type": binding.contentType },
      expiresAt: binding.expiresAt,
    });
  }
  verifyUploadCapability(binding: PrivateAssetCapabilityBinding): Promise<boolean> {
    return Promise.resolve(
      this.uploaded.has(binding.objectKey) &&
        this.uploadBindings.filter((candidate) => candidate.capabilityId === binding.capabilityId)
          .length <= 1,
    );
  }
  invalidateUploadCapability(binding: PrivateAssetCapabilityBinding): Promise<void> {
    this.invalidatedUploadBindings.push(binding);
    return Promise.resolve();
  }
  registerDownloadCapability(
    binding: PrivateAssetCapabilityBinding,
  ): Promise<PrivateDownloadGrant> {
    this.downloadBindings.push(binding);
    return Promise.resolve({
      method: "GET",
      url: `/api/speaker/assets/capabilities/download/${binding.capabilityId}/opaque-token-${this.downloadBindings.length}`,
      expiresAt: binding.expiresAt,
    });
  }
  inspectObject(
    command: PrivateAssetCapabilityBinding,
  ): Promise<{ contentType: string; sizeBytes: number } | null> {
    return Promise.resolve(
      this.uploaded.has(command.objectKey)
        ? { contentType: command.contentType, sizeBytes: command.sizeBytes }
        : null,
    );
  }
  readObject(binding: PrivateAssetCapabilityBinding): Promise<PrivateDownloadObject | null> {
    const object = this.objects.get(binding.objectKey);
    if (object === undefined) return Promise.resolve(null);
    return Promise.resolve({
      body: responseBody(new Response(object.body)),
      contentType: object.contentType,
      sizeBytes: object.body.byteLength,
      fileName: binding.fileName,
    });
  }
  consumeUploadCapability(): Promise<PrivateUploadReceipt> {
    return Promise.resolve({
      contentType: "application/pdf",
      sizeBytes: 1,
      uploadedAt: now,
    });
  }
  consumeDownloadCapability(): Promise<PrivateDownloadObject> {
    return Promise.resolve({
      body: responseBody(new Response("x")),
      contentType: "text/plain",
      sizeBytes: 1,
      fileName: "x.txt",
    });
  }
}

function binding(
  overrides: Partial<PrivateAssetCapabilityBinding> = {},
): PrivateAssetCapabilityBinding {
  return {
    capabilityId: "asset-1",
    tenantId: "tenant-1",
    eventId: "event-1",
    subject: { kind: "participant" },
    participantId: "participant-1",
    objectKey: "events/event-1/participants/participant-1/slides/asset-1",
    contentType: "application/pdf",
    sizeBytes: 3,
    fileName: "slides.pdf",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function downloadBinding(
  overrides: Partial<PrivateDownloadCapabilityBinding> = {},
): PrivateDownloadCapabilityBinding {
  return {
    ...binding(),
    requesterAccountId: "account-1",
    requesterKind: "speaker",
    assetVersion: 1,
    ...overrides,
  };
}
function responseBody(response: Response): ReadableStream<Uint8Array> {
  const body = response.body;
  if (body === null) throw new Error("Expected a response body.");
  return body;
}

function opaqueToken(url: string): string {
  const token = new URL(`https://api.invalid${url}`).pathname.split("/").at(-1);
  if (token === undefined) throw new Error("Expected an opaque capability token.");
  return token;
}

function downloadCapabilityParts(url: string): {
  readonly capabilityId: string;
  readonly token: string;
} {
  const parts = new URL(`https://api.invalid${url}`).pathname.split("/");
  const capabilityId = parts.at(-2);
  const token = parts.at(-1);
  if (capabilityId === undefined || token === undefined) {
    throw new Error("Expected a download capability identifier and token.");
  }
  return { capabilityId: decodeURIComponent(capabilityId), token };
}

class MemoryBucket {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  beforePut?: () => Promise<void>;
  async put(key: string, body: ArrayBuffer, options: { httpMetadata: { contentType: string } }) {
    await this.beforePut?.();
    this.objects.set(key, {
      body: new Uint8Array(body),
      contentType: options.httpMetadata.contentType,
    });
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object === undefined
      ? null
      : {
          size: object.body.byteLength,
          httpMetadata: { contentType: object.contentType },
        };
  }
  async get(key: string) {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    return {
      size: object.body.byteLength,
      httpMetadata: { contentType: object.contentType },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(object.body);
          controller.close();
        },
      }),
    };
  }
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
        title: "Session",
        speakerIds: overrides.speakerIds ?? ["participant-1", "participant-2"],
      }) as never,
  };
}
const acceptedTestSessionAuthority = createTestSessionAuthority();
describe("private speaker asset lifecycle", () => {
  it("registers an opaque upload, validates transfer, rejects replay, and finalizes ready assets", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => "asset-1",
    });
    const authorization = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: "upload-task",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    expect(authorization.grant.url).toContain("opaque-token");
    expect(authorization.asset).toMatchObject({
      tenantId: "tenant-1",
      sessionId: "speaker-submission:submission-1",
      uploaderAccountId: "account-1",
      uploaderLabel: "Alex Rivera",
      version: 1,
      versionFamilyId: "asset-family:asset-1",
      commentThreadId: "asset-comments:asset-family:asset-1",
      state: "pending_upload",
    });
    expect(gateway.uploadBindings[0]).toMatchObject({
      tenantId: "tenant-1",
      eventId: "event-1",
      subject: { kind: "speaker_session", sessionId: "speaker-submission:submission-1" },
      participantId: "participant-1",
      taskId: "upload-task",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    gateway.uploaded.add(authorization.asset.objectKey);
    const finalized = await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: "asset-1",
      state: "ready",
    });
    expect(finalized.state).toBe("ready");
    expect(gateway.invalidatedUploadBindings).toEqual([
      expect.objectContaining({ capabilityId: authorization.asset.id }),
    ]);
  });

  it("records the authenticated organizer separately from the asset participant", async () => {
    const repository = new LifecycleRepository();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "owner",
    });
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new CapabilityGateway(),
      {
        speakerSender,
        sessionAuthority: acceptedTestSessionAuthority,
        now: () => new Date(now),
        generateId: () => "organizer-headshot",
      },
    );

    const authorization = await service.issueOrganizerUploadGrant({
      eventId: "event-1",
      accountId: "organizer",
      participantId: "participant-1",
      kind: "headshot",
      fileName: "headshot.jpg",
      contentType: "image/jpeg",
      sizeBytes: 3,
    });

    expect(authorization.asset).toMatchObject({
      participantId: "participant-1",
      uploaderAccountId: "organizer",
      uploaderLabel: "Local Organizer",
    });
  });

  it("re-authorizes the same pending asset from immutable persisted metadata", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => "asset-retry",
    });
    const original = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: "upload-task",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });

    const retried = await service.reauthorizePendingUpload({
      eventId: "event-1",
      accountId: "account-1",
      assetId: original.asset.id,
    });

    expect(retried.asset).toEqual(original.asset);
    expect(gateway.uploadBindings).toHaveLength(2);
    expect(gateway.uploadBindings[1]).toEqual(gateway.uploadBindings[0]);
    expect(repository.assets).toHaveLength(1);

    const stored = repository.assets[0];
    if (stored === undefined) throw new Error("Expected the pending asset to be stored.");
    stored.state = "ready";
    await expect(
      service.reauthorizePendingUpload({
        eventId: "event-1",
        accountId: "account-1",
        assetId: original.asset.id,
      }),
    ).rejects.toMatchObject({ code: "ASSET_UPLOAD_RETRY_INVALID" });
  });

  it("rejects finalization while the latest upload capability remains pending", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => "asset-pending-retry",
    });
    const original = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: "upload-task",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    gateway.uploaded.add(original.asset.objectKey);
    await service.reauthorizePendingUpload({
      eventId: "event-1",
      accountId: "account-1",
      assetId: original.asset.id,
    });

    await expect(
      service.finalizeAsset({
        eventId: "event-1",
        accountId: "account-1",
        assetId: original.asset.id,
        state: "ready",
      }),
    ).rejects.toMatchObject({ code: "ASSET_FINALIZATION_INVALID" });
    expect(gateway.invalidatedUploadBindings).toHaveLength(0);
  });

  it("does not finalize a ready asset without persisted object metadata", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    const missingInspection = gateway as unknown as { inspectObject?: unknown };
    missingInspection.inspectObject = undefined;
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => "asset-no-inspect",
    });
    const authorization = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: "upload-task",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    await expect(
      service.finalizeAsset({
        eventId: "event-1",
        accountId: "account-1",
        assetId: authorization.asset.id,
        state: "ready",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(repository.getAsset("event-1", authorization.asset.id)).resolves.toMatchObject({
      state: "pending_upload",
    });
  });
  it("keeps upload tasks blocked until a ready asset exists and denies another tenant", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => "asset-1",
    });
    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "upload-task",
        toStatus: "submitted",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "TASK_ASSET_NOT_READY" });
    await expect(service.listAssets("event-1", "account-2")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      service.issueUploadGrant({
        eventId: "event-1",
        accountId: "account-2",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-1",
        kind: "slides",
        fileName: "slides.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("creates immutable version lineage and issues fresh download capabilities", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    const ids = ["asset-1", "asset-2"];
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => ids.shift() ?? "asset-3",
    });
    const first = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    gateway.uploaded.add(first.asset.objectKey);
    await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: first.asset.id,
      state: "ready",
    });
    const second = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      supersedesAssetId: first.asset.id,
      expectedLatestVersion: 1,
      idempotencyKey: "immutable-lineage-replacement",
      kind: "slides",
      fileName: "slides-v2.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    expect(second.asset).toMatchObject({
      version: 2,
      versionFamilyId: first.asset.versionFamilyId,
      supersedesAssetId: first.asset.id,
    });
    const firstDownload = await service.issueDownloadGrant({
      eventId: "event-1",
      accountId: "account-1",
      assetId: first.asset.id,
    });
    const secondDownload = await service.issueDownloadGrant({
      eventId: "event-1",
      accountId: "account-1",
      assetId: first.asset.id,
    });
    expect(firstDownload.url).not.toBe(secondDownload.url);
    expect(gateway.downloadBindings).toHaveLength(2);
  });
  it("authorizes exactly one concurrent replacement for an expected family head", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    const ids = ["asset-v1", "asset-v2-a", "asset-v2-b", "asset-v2-replay", "asset-v2-mismatch"];
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => ids.shift() ?? "unexpected-asset",
    });
    const first = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    gateway.uploaded.add(first.asset.objectKey);
    await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: first.asset.id,
      state: "ready",
    });

    const outcomes = await Promise.allSettled([
      service.issueUploadGrant({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-1",
        kind: "slides",
        fileName: "slides-v2-a.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
        supersedesAssetId: first.asset.id,
        expectedLatestVersion: 1,
        idempotencyKey: "replacement-a",
      }),
      service.issueUploadGrant({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-1",
        kind: "slides",
        fileName: "slides-v2-b.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
        supersedesAssetId: first.asset.id,
        expectedLatestVersion: 1,
        idempotencyKey: "replacement-b",
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: "VERSION_CONFLICT",
          status: 409,
        }),
      }),
    ]);
    expect(repository.assets.filter((asset) => asset.version === 2)).toHaveLength(1);
    expect(gateway.uploadBindings).toHaveLength(2);

    const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("Expected one replacement winner.");
    const winningRequest =
      winner.value.asset.fileName === "slides-v2-a.pdf"
        ? {
            fileName: "slides-v2-a.pdf",
            idempotencyKey: "replacement-a",
          }
        : {
            fileName: "slides-v2-b.pdf",
            idempotencyKey: "replacement-b",
          };
    const replay = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      kind: "slides",
      fileName: winningRequest.fileName,
      contentType: "application/pdf",
      sizeBytes: 3,
      supersedesAssetId: first.asset.id,
      expectedLatestVersion: 1,
      idempotencyKey: winningRequest.idempotencyKey,
    });
    expect(replay.asset.id).toBe(winner.value.asset.id);
    await expect(
      service.issueUploadGrant({
        eventId: "event-1",
        accountId: "account-1",
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-1",
        kind: "slides",
        fileName: "changed-on-replay.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
        supersedesAssetId: first.asset.id,
        expectedLatestVersion: 1,
        idempotencyKey: winningRequest.idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    expect(repository.assets.filter((asset) => asset.version === 2)).toHaveLength(1);
    expect(gateway.uploadBindings).toHaveLength(3);
  });
  it("submits a newly assigned upload task after its first file is finalized", async () => {
    const repository = new LifecycleRepository();
    const uploadTask = repository.tasks.find((task) => task.id === "upload-task");
    if (uploadTask === undefined) throw new Error("Expected the upload task fixture.");
    uploadTask.status = "not_started";
    const gateway = new CapabilityGateway();
    const ids = ["first-upload", "first-transition"];
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => ids.shift() ?? "generated-id",
    });
    const authorization = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: uploadTask.id,
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    gateway.uploaded.add(authorization.asset.objectKey);
    await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: authorization.asset.id,
      state: "ready",
    });

    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: uploadTask.id,
        toStatus: "submitted",
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ task: { status: "submitted", version: 2 } });
  });

  it("returns a reviewed upload task for speaker changes", async () => {
    const repository = new LifecycleRepository();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "owner",
    });
    const uploadTask = repository.tasks.find((task) => task.id === "upload-task");
    if (uploadTask === undefined) throw new Error("Expected the upload task fixture.");
    uploadTask.status = "not_started";
    const gateway = new CapabilityGateway();
    const ids = ["review-upload", "submit-transition", "review-audit", "changes-transition"];
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => ids.shift() ?? "generated-id",
    });
    const authorization = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: uploadTask.id,
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    gateway.uploaded.add(authorization.asset.objectKey);
    await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: authorization.asset.id,
      state: "ready",
    });
    await service.transitionTask({
      eventId: "event-1",
      accountId: "account-1",
      taskId: uploadTask.id,
      toStatus: "submitted",
      expectedVersion: 1,
    });

    await service.reviewAsset({
      eventId: "event-1",
      accountId: "organizer",
      assetId: authorization.asset.id,
      state: "needs_changes",
      note: "Please replace the session deck.",
    });

    await expect(service.listTasks("event-1", "account-1")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: uploadTask.id,
          status: "needs_changes",
          version: 3,
        }),
      ]),
    );
  });

  it.each([
    "not_started",
    "in_progress",
    "submitted",
    "needs_changes",
    "completed",
    "waived",
    "overdue",
    "reopened",
  ] as const)("returns every linked upload task state to needs_changes: %s", async (status) => {
    const repository = new LifecycleRepository();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "owner",
    });
    const uploadTask = repository.tasks.find((task) => task.id === "upload-task");
    if (uploadTask === undefined) throw new Error("Expected the upload task fixture.");
    uploadTask.status = "in_progress";
    uploadTask.version = 1;
    const gateway = new CapabilityGateway();
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => "linked-state-id",
    });
    const authorization = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: uploadTask.id,
      kind: "slides",
      fileName: "linked-state.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    gateway.uploaded.add(authorization.asset.objectKey);
    await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: authorization.asset.id,
      state: "ready",
    });
    uploadTask.status = status;
    uploadTask.version = 1;

    await service.reviewAsset({
      eventId: "event-1",
      accountId: "organizer",
      assetId: authorization.asset.id,
      state: "needs_changes",
      note: "The linked task must become actionable.",
    });

    expect(repository.tasks.find((task) => task.id === uploadTask.id)).toMatchObject({
      status: "needs_changes",
      replacementBaselineAssetId: authorization.asset.id,
      version: 2,
    });
    expect(
      repository.taskTransitions.filter((transition) => transition.taskId === uploadTask.id),
    ).toHaveLength(status === "needs_changes" ? 0 : 1);
  });

  it("does not persist a needs-changes review when the linked task CAS conflicts", async () => {
    class ConflictingLifecycleRepository extends LifecycleRepository {
      override reviewAsset(
        command: SpeakerAssetReviewCommand,
      ): Promise<RepositoryResult<SpeakerAsset>> {
        if (command.returnTask !== undefined) {
          const task = this.tasks.find(({ id }) => id === command.returnTask?.taskId);
          if (task !== undefined) task.version += 1;
        }
        return super.reviewAsset(command);
      }
    }

    const repository = new ConflictingLifecycleRepository();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "owner",
    });
    const uploadTask = repository.tasks.find((task) => task.id === "upload-task");
    if (uploadTask === undefined) throw new Error("Expected the upload task fixture.");
    uploadTask.status = "submitted";
    uploadTask.version = 2;
    const readyAsset: SpeakerAsset = {
      id: "asset-review-conflict",
      tenantId: "tenant-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      taskId: uploadTask.id,
      kind: "slides",
      objectKey: "opaque/review-conflict",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      state: "ready",
      createdAt: now,
      version: 1,
      versionFamilyId: "asset-family:review-conflict",
      latestVersionId: "asset-review-conflict",
      currentVersionId: "asset-review-conflict",
    };
    repository.assets.push(readyAsset);
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new CapabilityGateway(),
      {
        speakerSender,
        sessionAuthority: acceptedTestSessionAuthority,
        now: () => new Date(now),
        generateId: () => "review-conflict-id",
      },
    );

    await expect(
      service.reviewAsset({
        eventId: "event-1",
        accountId: "organizer",
        assetId: readyAsset.id,
        state: "needs_changes",
        note: "Please replace the deck.",
      }),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409,
    });
    expect(readyAsset).not.toHaveProperty("reviewState");
    expect(readyAsset).not.toHaveProperty("reviewVersion");
    expect(uploadTask).toMatchObject({ status: "submitted", version: 3 });
  });

  it("derives immutable task re-uploads and keeps the submitted status authoritative", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    const ids = ["task-asset-1", "task-transition-1", "task-asset-2", "task-transition-2"];
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => ids.shift() ?? "generated-id",
    });
    const first = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: "upload-task",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    gateway.uploaded.add(first.asset.objectKey);
    await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: first.asset.id,
      state: "ready",
    });
    const submitted = await service.transitionTask({
      eventId: "event-1",
      accountId: "account-1",
      taskId: "upload-task",
      toStatus: "submitted",
      expectedVersion: 1,
    });
    expect(submitted.task.status).toBe("submitted");
    const second = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: "upload-task",
      kind: "slides",
      fileName: "slides-v2.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      supersedesAssetId: first.asset.id,
      expectedLatestVersion: 1,
      idempotencyKey: "task-reupload-v2",
    });
    expect(second.asset).toMatchObject({
      version: 2,
      versionFamilyId: first.asset.versionFamilyId,
      supersedesAssetId: first.asset.id,
    });
    gateway.uploaded.add(second.asset.objectKey);
    await expect(
      service.finalizeAsset({
        eventId: "event-1",
        accountId: "account-1",
        assetId: second.asset.id,
        state: "ready",
      }),
    ).resolves.toMatchObject({ version: 2, state: "ready" });
    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "upload-task",
        toStatus: "submitted",
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({ task: { status: "submitted", version: 2 } });
    await expect(
      service.listAssetHistory("event-1", "account-1", second.asset.id),
    ).resolves.toEqual([
      expect.objectContaining({ id: first.asset.id, state: "ready" }),
      expect.objectContaining({ id: second.asset.id, state: "ready" }),
    ]);
  });

  it("requires a newer ready family version after a needs-changes review", async () => {
    const repository = new LifecycleRepository();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "owner",
    });
    const gateway = new CapabilityGateway();
    let idCounter = 0;
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => `baseline-${++idCounter}`,
    });
    const first = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: "upload-task",
      kind: "slides",
      fileName: "baseline-v1.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    gateway.uploaded.add(first.asset.objectKey);
    await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: first.asset.id,
      state: "ready",
    });
    await service.transitionTask({
      eventId: "event-1",
      accountId: "account-1",
      taskId: "upload-task",
      toStatus: "submitted",
      expectedVersion: 1,
    });
    const reviewed = await service.reviewAsset({
      eventId: "event-1",
      accountId: "organizer",
      assetId: first.asset.id,
      state: "needs_changes",
      expectedVersion: 0,
    });
    expect(reviewed.reviewState).toBe("needs_changes");
    const returnedTask = repository.tasks.find((task) => task.id === "upload-task");
    expect(returnedTask).toMatchObject({
      status: "needs_changes",
      replacementBaselineAssetId: first.asset.id,
      version: 3,
    });
    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "upload-task",
        toStatus: "submitted",
        expectedVersion: returnedTask?.version ?? -1,
      }),
    ).rejects.toMatchObject({ code: "TASK_ASSET_NOT_READY", status: 409 });

    const rejectedReplacement = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: "upload-task",
      kind: "slides",
      fileName: "baseline-v2-rejected.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      supersedesAssetId: first.asset.id,
      expectedLatestVersion: 1,
      idempotencyKey: "baseline-v2",
    });
    expect(rejectedReplacement.asset).toMatchObject({
      version: 2,
      state: "pending_upload",
      supersedesAssetId: first.asset.id,
    });
    gateway.uploaded.add(rejectedReplacement.asset.objectKey);
    await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: rejectedReplacement.asset.id,
      state: "rejected",
    });
    const replacement = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      taskId: "upload-task",
      kind: "slides",
      fileName: "baseline-v3.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      supersedesAssetId: rejectedReplacement.asset.id,
      expectedLatestVersion: 2,
      idempotencyKey: "baseline-v3",
    });
    expect(replacement.asset).toMatchObject({
      version: 3,
      state: "pending_upload",
      supersedesAssetId: rejectedReplacement.asset.id,
    });
    gateway.uploaded.add(replacement.asset.objectKey);
    await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: replacement.asset.id,
      state: "ready",
    });
    await expect(
      service.transitionTask({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "upload-task",
        toStatus: "submitted",
        expectedVersion: returnedTask?.version ?? -1,
      }),
    ).resolves.toMatchObject({ task: { status: "submitted" } });
    expect(repository.tasks.find((task) => task.id === "upload-task")).not.toHaveProperty(
      "replacementBaselineAssetId",
    );
  });

  it("persists private bytes and enforces MIME, size, expiry, and replay at the R2 boundary", async () => {
    const bucket = new MemoryBucket();
    const gateway = new R2PrivateAssetGateway(bucket as never, "https://api.invalid");
    const upload = await gateway.registerUploadCapability(binding());
    const token = opaqueToken(upload.url);
    await expect(
      gateway.consumeUploadCapability(
        "asset-1",
        token,
        new Request("https://api.invalid", {
          method: "PUT",
          headers: { "content-type": "image/png" },
          body: "abc",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      gateway.consumeUploadCapability(
        "asset-1",
        token,
        new Request("https://api.invalid", {
          method: "PUT",
          headers: { "content-type": "application/pdf" },
          body: "abcd",
        }),
      ),
    ).rejects.toThrow();
    await gateway.consumeUploadCapability(
      "asset-1",
      token,
      new Request("https://api.invalid", {
        method: "PUT",
        headers: { "content-type": "application/pdf", "content-length": "3" },
        body: "abc",
      }),
    );
    await expect(
      gateway.consumeUploadCapability(
        "asset-1",
        token,
        new Request("https://api.invalid", {
          method: "PUT",
          headers: { "content-type": "application/pdf" },
          body: "abc",
        }),
      ),
    ).rejects.toThrow();
    expect(await bucket.head(binding().objectKey)).toMatchObject({ size: 3 });
    expect(
      await gateway.verifyUploadCapability(
        binding({ subject: { kind: "speaker_session", sessionId: "session-1" } }),
      ),
    ).toBe(false);

    const firstDownload = await gateway.registerDownloadCapability(downloadBinding());
    const secondDownload = await gateway.registerDownloadCapability(downloadBinding());
    expect(firstDownload.url).not.toBe(secondDownload.url);

    const firstDownloadCapability = downloadCapabilityParts(firstDownload.url);
    const secondDownloadCapability = downloadCapabilityParts(secondDownload.url);
    expect(firstDownloadCapability.capabilityId).not.toBe(secondDownloadCapability.capabilityId);
    const firstObject = await gateway.consumeDownloadCapability(
      firstDownloadCapability.capabilityId,
      firstDownloadCapability.token,
    );
    expect(await new Response(firstObject.body).text()).toBe("abc");
    const secondObject = await gateway.consumeDownloadCapability(
      secondDownloadCapability.capabilityId,
      secondDownloadCapability.token,
    );
    expect(await new Response(secondObject.body).text()).toBe("abc");
    await expect(
      gateway.consumeDownloadCapability(
        firstDownloadCapability.capabilityId,
        firstDownloadCapability.token,
      ),
    ).rejects.toThrow();
    await expect(
      gateway.consumeDownloadCapability(
        secondDownloadCapability.capabilityId,
        secondDownloadCapability.token,
      ),
    ).rejects.toThrow();

    const recentlyExpiredDownload = await gateway.registerDownloadCapability(
      downloadBinding({
        capabilityId: "recently-expired-download",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    const recentlyExpiredCapability = downloadCapabilityParts(recentlyExpiredDownload.url);
    await gateway.registerDownloadCapability(
      downloadBinding({ capabilityId: "download-after-recent-expiry" }),
    );
    await expect(
      gateway.consumeDownloadCapability(
        recentlyExpiredCapability.capabilityId,
        recentlyExpiredCapability.token,
      ),
    ).rejects.toThrow("expired");

    const expired = await gateway.registerUploadCapability(
      binding({
        capabilityId: "expired",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    const expiredToken = opaqueToken(expired.url);
    await expect(
      gateway.consumeUploadCapability(
        "expired",
        expiredToken,
        new Request("https://api.invalid", {
          method: "PUT",
          headers: { "content-type": "application/pdf" },
          body: "abc",
        }),
      ),
    ).rejects.toThrow();
  });

  it("does not verify an upload until the replacement object write completes", async () => {
    const bucket = new MemoryBucket();
    const gateway = new R2PrivateAssetGateway(bucket as never, "https://api.invalid");
    const uploadBinding = binding();
    bucket.objects.set(uploadBinding.objectKey, {
      body: new TextEncoder().encode("old"),
      contentType: uploadBinding.contentType,
    });
    const upload = await gateway.registerUploadCapability(uploadBinding);
    let signalPutStarted: (() => void) | undefined;
    let releasePut: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      signalPutStarted = resolve;
    });
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    bucket.beforePut = async () => {
      signalPutStarted?.();
      await putReleased;
    };

    const consuming = gateway.consumeUploadCapability(
      uploadBinding.capabilityId,
      opaqueToken(upload.url),
      new Request("https://api.invalid", {
        method: "PUT",
        headers: {
          "content-type": uploadBinding.contentType,
          "content-length": String(uploadBinding.sizeBytes),
        },
        body: new Uint8Array(uploadBinding.sizeBytes),
      }),
    );
    await putStarted;

    await expect(gateway.verifyUploadCapability(uploadBinding)).resolves.toBe(false);
    await expect(gateway.invalidateUploadCapability(uploadBinding)).rejects.toThrow(
      /cannot be invalidated/u,
    );
    await expect(gateway.registerUploadCapability(uploadBinding)).rejects.toThrow(
      /cannot be reauthorized/u,
    );
    releasePut?.();
    await consuming;
    await expect(gateway.verifyUploadCapability(uploadBinding)).resolves.toBe(true);
  });

  it("does not finalize an uploaded capability after its expiry", async () => {
    const bucket = new MemoryBucket();
    const gateway = new R2PrivateAssetGateway(bucket as never, "https://api.invalid");
    const clock = Date.now();
    const uploadBinding = binding({
      capabilityId: "expired-after-upload",
      expiresAt: new Date(clock + 1_000).toISOString(),
    });
    const upload = await gateway.registerUploadCapability(uploadBinding);
    await gateway.consumeUploadCapability(
      uploadBinding.capabilityId,
      opaqueToken(upload.url),
      new Request("https://api.invalid", {
        method: "PUT",
        headers: {
          "content-type": uploadBinding.contentType,
          "content-length": String(uploadBinding.sizeBytes),
        },
        body: new Uint8Array(uploadBinding.sizeBytes),
      }),
    );

    vi.setSystemTime(clock + 2_000);
    try {
      await expect(gateway.verifyUploadCapability(uploadBinding)).resolves.toBe(false);
      await expect(gateway.invalidateUploadCapability(uploadBinding)).rejects.toThrow(
        /cannot be invalidated/u,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts participant-scoped capabilities without a session binding", async () => {
    const bucket = new MemoryBucket();
    const gateway = new R2PrivateAssetGateway(bucket as never, "https://api.invalid");
    const participantBinding = binding({
      capabilityId: "participant-asset",
      objectKey: "events/event-1/participants/participant-1/headshot/participant-asset",
      contentType: "image/png",
      fileName: "headshot.png",
    });
    const upload = await gateway.registerUploadCapability(participantBinding);

    await expect(
      gateway.consumeUploadCapability(
        participantBinding.capabilityId,
        opaqueToken(upload.url),
        new Request("https://api.invalid", {
          method: "PUT",
          headers: { "content-type": participantBinding.contentType },
          body: "abc",
        }),
      ),
    ).resolves.toMatchObject({ contentType: "image/png", sizeBytes: 3 });
    await expect(gateway.registerUploadCapability(participantBinding)).rejects.toThrow(
      /cannot be reauthorized/u,
    );
    await expect(gateway.verifyUploadCapability(participantBinding)).resolves.toBe(true);
    await expect(gateway.invalidateUploadCapability(participantBinding)).resolves.toBeUndefined();
    await expect(gateway.verifyUploadCapability(participantBinding)).resolves.toBe(false);
    await expect(gateway.registerUploadCapability(participantBinding)).rejects.toThrow(
      /cannot be reauthorized/u,
    );
  });

  it("redacts private and reviewer fields from every speaker asset response", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    const generatedIds = ["headshot-asset", "slides-asset"];
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => generatedIds.shift() ?? "unexpected-asset",
    });
    const routes = createSpeakerRoutes({
      service,
      authenticate: async () => ({ accountId: "account-1" }),
    });

    const headshotResponse = await routes.request(
      "/events/event-1/profiles/participant-1/headshot",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId: "participant-1",
          kind: "headshot",
          fileName: "headshot.png",
          contentType: "image/png",
          sizeBytes: 3,
        }),
      },
    );
    const headshotBody = (await headshotResponse.json()) as {
      data: { asset: Record<string, unknown> };
    };
    expect(headshotResponse.status).toBe(201);

    const uploadResponse = await routes.request("/events/event-1/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participantId: "participant-1",
        sessionId: "speaker-submission:submission-1",
        kind: "slides",
        fileName: "x.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
      }),
    });
    const uploadBody = (await uploadResponse.json()) as {
      data: { asset: Record<string, unknown> };
    };
    expect(uploadResponse.status).toBe(201);

    for (const asset of repository.assets) asset.reviewedBy = "organizer";

    const retryResponse = await routes.request(
      `/events/event-1/assets/${uploadBody.data.asset.id as string}/upload-authorization`,
      { method: "POST" },
    );
    const retryBody = (await retryResponse.json()) as {
      data: { asset: Record<string, unknown> };
    };
    expect(retryResponse.status).toBe(200);

    const finalizeBody = { data: retryBody.data.asset };

    const listResponse = await routes.request("/events/event-1/assets");
    const listBody = (await listResponse.json()) as {
      data: Record<string, unknown>[];
    };
    expect(listResponse.status).toBe(200);

    const historyResponse = await routes.request(
      `/events/event-1/assets/${uploadBody.data.asset.id as string}/history`,
    );
    const historyBody = (await historyResponse.json()) as {
      data: Record<string, unknown>[];
    };
    expect(historyResponse.status).toBe(200);

    const portalResponse = await routes.request("/events/event-1/portal");
    const portalBody = (await portalResponse.json()) as {
      data: { assets?: Record<string, unknown>[] };
    };
    expect(portalResponse.status).toBe(200);

    const returnedAssets = [
      headshotBody.data.asset,
      uploadBody.data.asset,
      retryBody.data.asset,
      finalizeBody.data,
      ...listBody.data,
      ...historyBody.data,
      ...(portalBody.data.assets ?? []),
    ];
    expect(returnedAssets.length).toBeGreaterThanOrEqual(7);
    for (const asset of returnedAssets) {
      expect(asset).not.toHaveProperty("objectKey");
      expect(asset).not.toHaveProperty("tenantId");
      expect(asset).not.toHaveProperty("uploaderAccountId");
      expect(asset).not.toHaveProperty("reviewedBy");
    }
  });

  it("routes pending-upload re-authorization without accepting replacement metadata", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => "asset-retry-route",
    });
    const original = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    const routes = createSpeakerRoutes({
      service,
      authenticate: async () => ({ accountId: "account-1" }),
    });

    const response = await routes.request(
      `/events/event-1/assets/${original.asset.id}/upload-authorization`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: "evil.exe", sizeBytes: 99 }),
      },
    );
    const body = (await response.json()) as { data: { asset: SpeakerAsset } };

    expect(response.status).toBe(200);
    expect(body.data.asset).toMatchObject({
      id: original.asset.id,
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      state: "pending_upload",
    });
    expect(JSON.stringify(body)).not.toContain("objectKey");
    expect(repository.assets).toHaveLength(1);
  });
});
describe("speaker participant workspace authorization and projections", () => {
  it("lists authorized contexts and rejects a revoked context without stale event data", async () => {
    const repository = new LifecycleRepository();
    repository.scopes.set("event-2:account-1", {
      tenantId: "tenant-1",
      submissionIds: ["submission-2"],
      participantIds: ["participant-2"],
      capabilities: ["resource-read"],
    });
    repository.submissions.push({
      id: "submission-2",
      eventId: "event-2",
      title: "Second session",
      status: "accepted",
      participantIds: ["participant-2"],
      updatedAt: now,
    });
    repository.contexts.push({
      id: "portal:tenant-1:event-2",
      eventId: "event-2",
      name: "Event Two",
      capabilities: ["resource-read"],
      submissionIds: ["submission-2"],
      participantIds: ["participant-2"],
    });
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new CapabilityGateway(),
      {
        speakerSender,
        sessionAuthority: acceptedTestSessionAuthority,
        now: () => new Date(now),
      },
    );
    await expect(service.listPortalContexts("account-1")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventId: "event-1", name: "Event One" }),
        expect.objectContaining({ eventId: "event-2", name: "Event Two" }),
      ]),
    );
    repository.scopes.delete("event-1:account-1");
    await expect(service.getPortalContext("event-1", "account-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("allows only roster managers to invite and revoke delegated co-speakers", async () => {
    const repository = new LifecycleRepository();
    repository.scopes.set("event-1:account-3", {
      tenantId: "tenant-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      capabilities: ["asset-read"],
    });
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new CapabilityGateway(),
      {
        speakerSender,
        sessionAuthority: acceptedTestSessionAuthority,
        now: () => new Date(now),
        generateId: () => "generated-participant",
      },
    );
    await expect(
      service.addRosterEntry({
        eventId: "event-1",
        accountId: "account-3",
        submissionId: "submission-1",
        email: "delegate@example.test",
        displayName: "Delegate",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const invited = await service.addRosterEntry({
      eventId: "event-1",
      accountId: "account-1",
      submissionId: "submission-1",
      participantId: "participant-2",
      email: "delegate@example.test",
      displayName: "Delegate",
    });
    expect(invited.capabilities).toEqual({ manage: true, invite: true });
    expect(invited.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: "participant-1",
          role: "primary",
          status: "active",
        }),
        expect.objectContaining({
          participantId: "participant-2",
          role: "co_speaker",
          status: "pending",
        }),
      ]),
    );

    const revoked = await service.removeRosterEntry({
      eventId: "event-1",
      accountId: "account-1",
      submissionId: "submission-1",
      participantId: "participant-2",
    });
    expect(revoked.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: "participant-2",
          status: "revoked",
        }),
      ]),
    );
  });

  it("projects asset history and comments only to authorized participants", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "owner",
    });
    repository.profiles.push({
      id: "profile-participant-1",
      eventId: "event-1",
      participantId: "participant-1",
      displayName: "Priya Raman",
      biography: "",
      version: 1,
      updatedAt: now,
    });
    const ids = ["asset-history-1", "asset-history-2", "comment-1"];
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: () => ids.shift() ?? "generated-id",
    });
    const first = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
    });
    gateway.uploaded.add(first.asset.objectKey);
    await service.finalizeAsset({
      eventId: "event-1",
      accountId: "account-1",
      assetId: first.asset.id,
      state: "ready",
    });
    const second = await service.issueUploadGrant({
      eventId: "event-1",
      accountId: "account-1",
      participantId: "participant-1",
      sessionId: "speaker-submission:submission-1",
      kind: "slides",
      fileName: "slides-v2.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      supersedesAssetId: first.asset.id,
      expectedLatestVersion: 1,
      idempotencyKey: "history-replacement-v2",
    });
    await expect(
      service.listAssetHistory("event-1", "account-1", second.asset.id),
    ).resolves.toEqual([
      expect.objectContaining({ id: first.asset.id }),
      expect.objectContaining({ id: second.asset.id }),
    ]);
    await expect(
      service.addAssetComment({
        eventId: "event-1",
        accountId: "account-1",
        assetId: first.asset.id,
        body: "Please use this version.",
      }),
    ).resolves.toMatchObject({ body: "Please use this version.", version: 1 });
    await expect(
      service.listAssetComments("event-1", "account-1", first.asset.id),
    ).resolves.toHaveLength(1);
    await expect(
      service.addOrganizerAssetComment({
        eventId: "event-1",
        accountId: "organizer",
        assetId: second.asset.id,
        body: "Priya, the updated deck is ready for review.",
        expectedVersion: 0,
      }),
    ).resolves.toMatchObject({ authorLabel: "Organizer", version: 1 });
    await expect(
      service.listAssetComments("event-1", "account-1", first.asset.id),
    ).resolves.toEqual([
      expect.objectContaining({
        authorLabel: "Priya Raman",
        body: "Please use this version.",
        createdAt: now,
      }),
      expect.objectContaining({
        authorLabel: "Organizer",
        body: "Priya, the updated deck is ready for review.",
        createdAt: now,
      }),
    ]);
    await expect(
      service.listAssetComments("event-1", "account-1", second.asset.id),
    ).resolves.toEqual([
      expect.objectContaining({
        authorLabel: "Priya Raman",
        body: "Please use this version.",
        createdAt: now,
      }),
      expect.objectContaining({
        authorLabel: "Organizer",
        body: "Priya, the updated deck is ready for review.",
        createdAt: now,
      }),
    ]);
    await expect(
      service.listOrganizerAssetComments("event-1", "organizer", first.asset.id),
    ).resolves.toEqual([
      expect.objectContaining({
        authorLabel: "Priya Raman",
        body: "Please use this version.",
      }),
      expect.objectContaining({
        authorLabel: "Organizer",
        body: "Priya, the updated deck is ready for review.",
      }),
    ]);
    const { sessionId: _sessionId, ...unboundAsset } = first.asset;
    repository.assets.push({
      ...unboundAsset,
      id: "legacy-unbound-version",
      objectKey: "opaque/legacy-unbound-version",
      latestVersionId: "legacy-unbound-version",
      versionId: "legacy-unbound-version",
    });
    await expect(
      service.listAssetComments("event-1", "account-1", "legacy-unbound-version"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.addAssetComment({
        eventId: "event-1",
        accountId: "account-1",
        assetId: "legacy-unbound-version",
        body: "Must not cross the session boundary.",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const uploadTask = repository.tasks[0];
    if (uploadTask === undefined) throw new Error("Expected upload task fixture.");
    const { ...participantTask } = uploadTask;
    repository.tasks.push({
      ...participantTask,
      id: "participant-upload-task",
      subject: { type: "participant", participantId: "participant-1" },
    });
    repository.assets.push({
      ...unboundAsset,
      id: "participant-task-version",
      taskId: "participant-upload-task",
      objectKey: "opaque/participant-task-version",
      latestVersionId: "participant-task-version",
      versionId: "participant-task-version",
    });
    await expect(
      service.addAssetComment({
        eventId: "event-1",
        accountId: "account-1",
        assetId: "participant-task-version",
        body: "This participant-scoped upload remains accessible.",
      }),
    ).resolves.toMatchObject({
      body: "This participant-scoped upload remains accessible.",
    });

    repository.tasks.push({
      ...participantTask,
      id: "organizer-action-task",
      owner: "organizer",
      type: "action",
      subject: { type: "participant", participantId: "participant-1" },
    });
    repository.assets.push({
      ...unboundAsset,
      id: "invalid-task-version",
      taskId: "organizer-action-task",
      objectKey: "opaque/invalid-task-version",
      latestVersionId: "invalid-task-version",
      versionId: "invalid-task-version",
    });
    await expect(
      service.listAssetComments("event-1", "account-1", "invalid-task-version"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.listAssetHistory("event-1", "account-2", first.asset.id),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("validates versioned task responses and keeps immutable response history", async () => {
    const repository = new LifecycleRepository();
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new CapabilityGateway(),
      {
        speakerSender,
        sessionAuthority: acceptedTestSessionAuthority,
        now: () => new Date(now),
      },
    );
    const form = await service.getTaskForm("event-1", "account-1", "upload-task");
    expect(form).toMatchObject({
      taskId: "upload-task",
      definitionVersion: 2,
      title: "Speaker details",
      description: "Tell us about your session.",
      status: "in_progress",
      fields: [
        expect.objectContaining({
          id: "bio",
          type: "textarea",
          required: true,
        }),
        expect.objectContaining({
          id: "track",
          options: [{ value: "web", label: "Web" }],
        }),
      ],
      latestResponse: null,
    });
    await expect(
      service.saveTaskResponse({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "upload-task",
        definitionVersion: 2,
        expectedVersion: 0,
        answers: { track: "web" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const first = await service.saveTaskResponse({
      eventId: "event-1",
      accountId: "account-1",
      taskId: "upload-task",
      definitionVersion: 2,
      expectedVersion: 0,
      answers: { bio: "A speaker", track: "web" },
    });
    expect(first.history).toHaveLength(1);
    expect(first.latestResponse).toMatchObject({
      status: "draft",
      definitionVersion: 2,
    });
    const second = await service.saveTaskResponse({
      eventId: "event-1",
      accountId: "account-1",
      taskId: "upload-task",
      definitionVersion: 2,
      expectedVersion: 1,
      answers: { bio: "A better speaker", track: "web" },
    });
    expect(second.history).toHaveLength(2);
    expect(second.history[0]?.responseId).not.toBe(second.latestResponse?.responseId);
    await expect(
      service.saveTaskResponse({
        eventId: "event-1",
        accountId: "account-1",
        taskId: "upload-task",
        definitionVersion: 2,
        expectedVersion: 1,
        answers: { bio: "stale", track: "web" },
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("orders published resources and strips unsafe HTML and URLs", async () => {
    const repository = new LifecycleRepository();
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new CapabilityGateway(),
      {
        speakerSender,
        sessionAuthority: acceptedTestSessionAuthority,
        now: () => new Date(now),
      },
    );
    const resources = await service.listResources("event-1", "account-1");
    expect(resources).toEqual([
      expect.objectContaining({
        id: "resource-1",
        url: "https://docs.example.test/guide",
      }),
      expect.objectContaining({ id: "resource-2", html: "<p>safe</p>" }),
    ]);
    expect(resources[1]).not.toHaveProperty("url");
    await expect(service.listWikiPages("event-1", "account-1")).resolves.toEqual([
      expect.objectContaining({ id: "wiki-1", slug: "welcome" }),
    ]);
    const serialized = JSON.stringify(await service.listResources("event-1", "account-1"));
    expect(serialized).not.toContain("resource-other");
    expect(serialized).not.toContain("javascript:");
  });
});
describe("organizer content-management contracts", () => {
  it("creates assigned tasks, projects the matrix, queues idempotent reminders, reviews assets, and keeps keys private", async () => {
    const repository = new LifecycleRepository();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1", "submission-2"],
      participantIds: ["participant-1", "participant-2"],
      role: "owner",
    });
    repository.submissions.push({
      id: "submission-2",
      eventId: "event-1",
      title: "Second session",
      status: "accepted",
      participantIds: ["participant-2"],
      updatedAt: now,
    });
    repository.tasks.push({
      id: "participant-2-upload-task",
      eventId: "event-1",
      participantId: "participant-2",
      subject: {
        type: "session",
        participantId: "participant-2",
        sessionId: "speaker-submission:submission-2",
      },
      type: "upload",
      owner: "speaker",
      title: "Upload second deck",
      status: "not_started",
      dependencyIds: [],
      reminderOffsetsMinutes: [],
      acceptedAssetKinds: ["slides"],
      version: 1,
      updatedAt: now,
    });
    const tasks = repository.tasks;
    const audits: unknown[] = [];
    const deliveryCalls: string[] = [];
    const extension = repository;
    extension.getProfile = async (eventId, participantId) =>
      repository.profiles.find(
        (profile) => profile.eventId === eventId && profile.participantId === participantId,
      ) ?? null;
    extension.createTask = async ({ task }) => {
      tasks.push(task);
      return { ok: true, value: task };
    };
    extension.updateTask = async ({ task, expectedVersion }) => {
      const index = tasks.findIndex((candidate) => candidate.id === task.id);
      if (index < 0) return { ok: false, reason: "not_found" };
      const currentTask = tasks[index];
      if (currentTask === undefined || currentTask.version !== expectedVersion)
        return { ok: false, reason: "version_conflict" };
      tasks[index] = task;
      return { ok: true, value: task };
    };
    extension.reviewAsset = async ({
      assetId,
      state,
      note,
      reviewedAt,
      reviewedBy,
      expectedVersion,
      release,
    }) => {
      const asset = repository.assets.find((candidate) => candidate.id === assetId);
      if (asset === undefined) return { ok: false, reason: "not_found" };
      if ((asset.reviewVersion ?? 0) !== expectedVersion)
        return { ok: false, reason: "version_conflict" };
      const updated = {
        ...asset,
        reviewState: state,
        ...(note === undefined ? {} : { reviewNote: note }),
        reviewedAt,
        reviewedBy,
        reviewVersion: expectedVersion + 1,
        ...(state === "approved" ? { approvedVersionId: asset.id } : {}),
        ...(release ? { releasedVersionId: asset.id } : {}),
      };
      repository.assets[repository.assets.indexOf(asset)] = updated;
      return { ok: true, value: updated };
    };
    extension.appendAssetAudit = async (entry) => {
      audits.push(entry);
    };
    extension.updateProfile = async ({
      biography,
      socialLinks,
      headshotAssetId,
      expectedVersion,
      updatedAt,
    }) => {
      const profile = repository.profiles[0];
      if (profile === undefined || profile.version !== expectedVersion)
        return { ok: false, reason: "version_conflict" };
      const updated: SpeakerProfile = {
        ...profile,
        ...(biography === undefined ? {} : { biography }),
        ...(socialLinks === undefined ? {} : { socialLinks }),
        version: expectedVersion + 1,
        updatedAt,
      };
      if (headshotAssetId === null) delete updated.headshotAssetId;
      else if (headshotAssetId !== undefined) updated.headshotAssetId = headshotAssetId;
      repository.profiles[0] = updated;
      return { ok: true, value: updated };
    };
    repository.profiles.push(
      {
        id: "profile-1",
        eventId: "event-1",
        participantId: "participant-1",
        displayName: "Priya Raman",
        email: "priya@example.test",
        biography: "Original",
        version: 1,
        updatedAt: now,
      },
      {
        id: "profile-2",
        eventId: "event-1",
        participantId: "participant-2",
        displayName: "Marcus Okafor",
        email: "marcus@example.test",
        biography: "Original",
        version: 1,
        updatedAt: now,
      },
    );
    repository.assets.push({
      id: "asset-ready",
      tenantId: "tenant-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      taskId: "upload-task",
      kind: "slides",
      objectKey: "opaque/r2/key",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      state: "ready",
      createdAt: now,
      version: 1,
      versionFamilyId: "family-1",
      latestVersionId: "asset-ready",
      currentVersionId: "asset-ready",
    });
    repository.assets.push({
      id: "asset-pending",
      tenantId: "tenant-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      taskId: "upload-task",
      kind: "headshot",
      objectKey: "opaque/r2/pending-headshot",
      fileName: "headshot.png",
      contentType: "image/png",
      sizeBytes: 3,
      state: "pending_upload",
      createdAt: now,
      version: 1,
      versionFamilyId: "family-headshot",
    });
    const gateway = new CapabilityGateway();
    gateway.uploaded.add("opaque/r2/pending-headshot");
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
      generateId: (() => {
        let sequence = 0;
        return () => `organizer-${++sequence}`;
      })(),
      delivery: {
        enqueue: async (input) => {
          deliveryCalls.push(input.idempotencyKey);
          return { queued: true };
        },
      },
    });
    const created = await service.createOrganizerTask({
      eventId: "event-1",
      accountId: "organizer",
      type: "upload",
      title: "Upload Session Presentation",
      description: "Final slide deck as a PDF.",
      dueAt: "2027-05-01",
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 10_000,
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
    expect(created[0]).toMatchObject({
      title: "Upload Session Presentation",
      dueAt: "2027-05-01",
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 10_000,
    });
    await expect(
      service.createOrganizerTask({
        eventId: "event-1",
        accountId: "account-1",
        type: "upload",
        title: "Unauthorized",
        allowedMimeTypes: ["application/pdf"],
        maxBytes: 10_000,
        assignments: [
          {
            participantId: "participant-1",
            subject: {
              type: "session",
              sessionId: "speaker-submission:submission-1",
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const matrix = await service.listDeliverables("event-1", "organizer");
    expect(matrix.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: "participant-1",
          status: "not_started",
        }),
      ]),
    );
    const preview = await service.previewOutstandingReminders({
      eventId: "event-1",
      accountId: "organizer",
    });
    expect(preview.recipientIds).toEqual(["participant-1", "participant-2"]);
    const singleReminder = await service.queueReminders({
      eventId: "event-1",
      accountId: "organizer",
      recipientIds: ["participant-1"],
      idempotencyKey: "single-reminder",
    });
    expect(singleReminder.recipientIds).toEqual(["participant-1"]);
    const firstReminder = await service.queueReminders({
      eventId: "event-1",
      accountId: "organizer",
      idempotencyKey: "reminder-1",
    });
    const secondReminder = await service.queueReminders({
      eventId: "event-1",
      accountId: "organizer",
      idempotencyKey: "reminder-1",
    });
    expect(firstReminder).toMatchObject({
      queued: true,
      duplicate: false,
      sentCount: 2,
    });
    expect(firstReminder.recipientIds).toEqual(preview.recipientIds);
    expect(secondReminder).toMatchObject({ queued: false, duplicate: true });
    expect(deliveryCalls).toEqual([
      "single-reminder:participant-1",
      "reminder-1:participant-1",
      "reminder-1:participant-2",
    ]);
    const reviewed = await service.reviewAsset({
      eventId: "event-1",
      accountId: "organizer",
      assetId: "asset-ready",
      state: "approved",
    });
    expect(reviewed).toMatchObject({
      reviewState: "approved",
      reviewVersion: 1,
    });
    expect(audits).toHaveLength(1);
    const profile = await service.updateOrganizerProfile({
      eventId: "event-1",
      accountId: "organizer",
      participantId: "participant-1",
      biography: "Updated biography",
      socialLinks: { website: "https://example.test/priya" },
      expectedVersion: 1,
    });
    expect(profile).toMatchObject({
      biography: "Updated biography",
      socialLinks: { website: "https://example.test/priya" },
      version: 2,
    });
    const app = createSpeakerRoutes({
      service,
      authenticate: async () => ({ accountId: "organizer" }),
    });
    const response = await app.request("/events/event-1/organizer/assets");
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain("objectKey");
    expect(responseText).toContain('"sessionTitle":"Session"');
    expect(responseText).toContain('"participantName":"Priya Raman"');
    const finalizedResponse = await app.request(
      "/events/event-1/organizer/assets/asset-pending/finalize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "ready" }),
      },
    );
    expect(finalizedResponse.status).toBe(200);
    expect(await finalizedResponse.text()).not.toContain("objectKey");
    expect(repository.assets.find((asset) => asset.id === "asset-pending")?.state).toBe("ready");
  });
});
it("projects exactly one latest ready asset as the organizer current version", async () => {
  const repository = new LifecycleRepository();
  repository.organizerScopes.set("event-1:organizer", {
    tenantId: "tenant-1",
    eventId: "event-1",
    submissionIds: ["submission-1"],
    participantIds: ["participant-1"],
    role: "owner",
  });
  repository.assets.push(
    {
      id: "family-v1",
      tenantId: "tenant-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      taskId: "upload-task",
      kind: "slides",
      objectKey: "opaque/family-v1",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      state: "ready",
      createdAt: "2026-08-09T00:00:00.000Z",
      version: 1,
      versionFamilyId: "family-slides",
    },
    {
      id: "family-v2",
      tenantId: "tenant-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      taskId: "upload-task",
      kind: "slides",
      objectKey: "opaque/family-v2",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      state: "ready",
      createdAt: "2026-08-09T01:00:00.000Z",
      version: 2,
      versionFamilyId: "family-slides",
      supersedesAssetId: "family-v1",
    },
    {
      id: "family-v3-pending",
      tenantId: "tenant-1",
      eventId: "event-1",
      sessionId: "speaker-submission:submission-1",
      participantId: "participant-1",
      taskId: "upload-task",
      kind: "slides",
      objectKey: "opaque/family-v3-pending",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      state: "pending_upload",
      createdAt: "2026-08-09T02:00:00.000Z",
      version: 3,
      versionFamilyId: "family-slides",
      supersedesAssetId: "family-v2",
      latestVersionId: "family-v3-pending",
      currentVersionId: "family-v2",
    },
  );
  const service = new SpeakerService(
    withTestSpeakerOrganizerLifecycle(repository),
    new CapabilityGateway(),
    {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
    },
  );

  const matrix = await service.listDeliverables("event-1", "organizer");
  const row = matrix.items.find((item) => item.task.id === "upload-task");
  expect(row?.currentAsset).toMatchObject({
    id: "family-v2",
    version: 2,
    state: "ready",
  });
  expect(row?.assets.map((asset) => asset.id)).toEqual([
    "family-v1",
    "family-v2",
    "family-v3-pending",
  ]);
});
describe("organizer immutable content history", () => {
  it("records attributed session edits and restores an earlier version with optimistic concurrency", async () => {
    const repository = new LifecycleRepository();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "owner",
    });
    let current: SpeakerContentRecord = {
      id: "session-content-1",
      tenantId: "tenant-1",
      eventId: "event-1",
      entityType: "session",
      entityId: "session-1",
      title: "Original",
      description: "Original abstract",
      status: "Draft",
      version: 1,
      updatedAt: now,
      updatedBy: "seed",
    };
    const history: SpeakerContentHistoryEntry[] = [
      {
        id: "content-history-1",
        eventId: "event-1",
        entityType: "session",
        entityId: "session-1",
        action: "created",
        version: 1,
        actorAccountId: "seed",
        occurredAt: now,
        snapshot: structuredClone(current),
      },
    ];
    const extension = repository;
    extension.getContent = async () => structuredClone(current);
    extension.listContentHistory = async () => structuredClone(history);
    extension.updateContent = async (command) => {
      if (current.version !== command.expectedVersion)
        return { ok: false, reason: "version_conflict" };
      current = {
        ...current,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.description === undefined ? {} : { description: command.description }),
        version: current.version + 1,
        updatedAt: command.updatedAt,
        updatedBy: command.accountId,
      };
      history.push({
        id: `content-history-${current.version}`,
        eventId: current.eventId,
        entityType: current.entityType,
        entityId: current.entityId,
        action: "updated",
        version: current.version,
        actorAccountId: command.accountId,
        occurredAt: command.updatedAt,
        snapshot: structuredClone(current),
      });
      return { ok: true, value: structuredClone(current) };
    };
    extension.restoreContentVersion = async (command) => {
      if (current.version !== command.expectedVersion)
        return { ok: false, reason: "version_conflict" };
      const target = history.find((entry) => entry.version === command.version);
      if (target === undefined) return { ok: false, reason: "not_found" };
      current = {
        ...current,
        ...target.snapshot,
        version: current.version + 1,
        updatedAt: command.updatedAt,
        updatedBy: command.accountId,
      };
      history.push({
        id: `content-history-${current.version}`,
        eventId: current.eventId,
        entityType: current.entityType,
        entityId: current.entityId,
        action: "restored",
        version: current.version,
        actorAccountId: command.accountId,
        occurredAt: command.updatedAt,
        snapshot: structuredClone(current),
      });
      return { ok: true, value: structuredClone(current) };
    };
    const service = new SpeakerService(
      withTestSpeakerOrganizerLifecycle(repository),
      new CapabilityGateway(),
      {
        speakerSender,
        sessionAuthority: acceptedTestSessionAuthority,
        now: () => new Date(now),
      },
    );
    const first = await service.updateContent({
      eventId: "event-1",
      accountId: "organizer",
      entityType: "session",
      entityId: "session-1",
      expectedVersion: 1,
      description: "Live demo of remote build caching.",
    });
    const second = await service.updateContent({
      eventId: "event-1",
      accountId: "organizer",
      entityType: "session",
      entityId: "session-1",
      expectedVersion: first.version,
      description: "Live demo of remote build caching. Attendees should bring a laptop.",
    });
    history.push({
      id: "content-history-cross-event",
      eventId: "event-2",
      entityType: "session",
      entityId: "session-1",
      action: "updated",
      version: 99,
      actorAccountId: "other-organizer",
      occurredAt: now,
      snapshot: {
        ...structuredClone(current),
        eventId: "event-2",
        version: 99,
      },
    });
    await expect(
      service.restoreContentVersion({
        eventId: "event-1",
        accountId: "organizer",
        entityType: "session",
        entityId: "session-1",
        version: 99,
        expectedVersion: second.version,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.listSessionContentHistory("event-1", "organizer", "session-1"),
    ).resolves.toHaveLength(3);
    const restored = await service.restoreContentVersion({
      eventId: "event-1",
      accountId: "organizer",
      entityType: "session",
      entityId: "session-1",
      version: first.version,
      expectedVersion: second.version,
    });
    expect(restored.description).toBe("Live demo of remote build caching.");
    expect(restored.updatedBy).toBe("organizer");
    await expect(
      service.restoreContentVersion({
        eventId: "event-1",
        accountId: "organizer",
        entityType: "session",
        entityId: "session-1",
        version: first.version,
        expectedVersion: second.version,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });
});
function archiveManifest(body: Uint8Array): SpeakerDeliverablesExportManifest {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const fileNameLength = view.getUint16(26, true);
  const dataStart = 30 + fileNameLength;
  const localHeader = [0x50, 0x4b, 0x03, 0x04];
  const centralHeader = [0x50, 0x4b, 0x01, 0x02];
  const signatureAt = (offset: number, signature: readonly number[]): boolean =>
    signature.every((byte, index) => body[offset + index] === byte);
  let dataEnd = body.byteLength;
  for (let offset = dataStart; offset < body.byteLength - 3; offset += 1) {
    if (signatureAt(offset, localHeader) || signatureAt(offset, centralHeader)) {
      dataEnd = offset;
      break;
    }
  }
  return JSON.parse(
    new TextDecoder().decode(body.slice(dataStart, dataEnd)),
  ) as SpeakerDeliverablesExportManifest;
}

describe("organizer deliverables exports", () => {
  it("exports only current authorized bytes with deterministic, collision-safe metadata for owners and admins", async () => {
    const repository = new LifecycleRepository();
    const gateway = new CapabilityGateway();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "owner",
    });
    const firstTask = repository.tasks[0];
    if (firstTask === undefined) throw new Error("Expected an upload task fixture.");
    repository.tasks.push({
      ...firstTask,
      id: "upload-task-2",
      title: "Upload slides",
    });
    repository.roster.push({
      id: "roster-export",
      eventId: "event-1",
      submissionId: "submission-1",
      participantId: "participant-1",
      displayName: "A/B",
      role: "primary",
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    Object.assign(repository, {
      listRosterForEvent: (eventId: string) =>
        Promise.resolve(repository.roster.filter((entry) => entry.eventId === eventId)),
    });
    repository.assets.push(
      {
        id: "asset-old",
        tenantId: "tenant-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "upload-task",
        kind: "slides",
        objectKey: "opaque/export/old",
        fileName: "../deck.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
        state: "ready",
        createdAt: now,
        version: 1,
        versionFamilyId: "export-family",
      },
      {
        id: "asset-current",
        tenantId: "tenant-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "upload-task",
        kind: "slides",
        objectKey: "opaque/export/current",
        fileName: "../deck.pdf",
        contentType: "application/pdf",
        sizeBytes: 4,
        state: "ready",
        createdAt: now,
        version: 2,
        versionFamilyId: "export-family",
        supersedesAssetId: "asset-old",
        latestVersionId: "asset-current",
        currentVersionId: "asset-current",
        releasedVersionId: "asset-current",
      },
      {
        id: "asset-collision",
        tenantId: "tenant-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "upload-task-2",
        kind: "slides",
        objectKey: "opaque/export/collision",
        fileName: "../deck.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
        state: "ready",
        createdAt: now,
        version: 1,
        versionFamilyId: "collision-family",
        latestVersionId: "asset-collision",
        currentVersionId: "asset-collision",
        releasedVersionId: "asset-collision",
      },
      {
        id: "asset-revoked",
        tenantId: "tenant-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "upload-task",
        kind: "slides",
        objectKey: "opaque/export/revoked",
        fileName: "revoked.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        state: "rejected",
        createdAt: now,
        version: 1,
        versionFamilyId: "revoked-family",
      },
      {
        id: "asset-unavailable",
        tenantId: "tenant-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "upload-task",
        kind: "slides",
        objectKey: "opaque/export/unavailable",
        fileName: "unavailable.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        state: "ready",
        createdAt: now,
        version: 1,
        versionFamilyId: "unavailable-family",
      },
      {
        id: "asset-cross-tenant",
        tenantId: "tenant-2",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "upload-task",
        kind: "slides",
        objectKey: "opaque/export/cross-tenant",
        fileName: "cross.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        state: "ready",
        createdAt: now,
        version: 1,
        versionFamilyId: "cross-family",
      },
    );
    gateway.objects.set("opaque/export/old", {
      body: new TextEncoder().encode("old"),
      contentType: "application/pdf",
    });
    gateway.objects.set("opaque/export/current", {
      body: new TextEncoder().encode("new!"),
      contentType: "application/pdf",
    });
    gateway.objects.set("opaque/export/collision", {
      body: new TextEncoder().encode("two"),
      contentType: "application/pdf",
    });
    const audits: SpeakerAssetAuditEntry[] = [];
    repository.appendAssetAudit = async (entry) => {
      audits.push(entry);
    };
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: {
        getSession: async (organizationId: string, eventId: string) =>
          ({
            id: "accepted-session-1",
            tenantId: organizationId,
            eventId,
            status: "accepted",
            title: "Accepted schedule title",
            speakerIds: ["participant-1"],
          }) as never,
      },
      now: () => new Date(now),
      generateId: (() => {
        let sequence = 0;
        return () => `export-${++sequence}`;
      })(),
    });

    const first = await service.exportDeliverables({
      eventId: "event-1",
      accountId: "organizer",
      assetIds: ["asset-old", "asset-collision", "asset-revoked", "asset-unavailable"],
    });
    const second = await service.exportDeliverables({
      eventId: "event-1",
      accountId: "organizer",
      assetIds: ["asset-old", "asset-collision", "asset-revoked", "asset-unavailable"],
    });
    expect(first.contentType).toBe("application/zip");
    expect(first.sizeBytes).toBe(first.body.byteLength);
    expect([...first.body]).toEqual([...second.body]);
    expect(first.manifest.entries.map((entry) => entry.assetId)).toEqual([
      "asset-collision",
      "asset-current",
    ]);
    expect(first.manifest.entries.every((entry) => entry.participantName === "A/B")).toBe(true);
    expect(first.manifest.entries.every((entry) => entry.sessionId === "accepted-session-1")).toBe(
      true,
    );
    expect(
      first.manifest.entries.every((entry) => entry.sessionTitle === "Accepted schedule title"),
    ).toBe(true);
    const paths = first.manifest.entries.map((entry) => entry.path);
    expect(paths.some((path) => path.endsWith("-2.pdf"))).toBe(true);
    expect(paths.every((path) => !path.includes(".."))).toBe(true);
    expect(new Set(first.manifest.entries.map((entry) => entry.path)).size).toBe(2);
    expect(JSON.stringify(first.manifest)).not.toContain("objectKey");
    expect(JSON.stringify(first.manifest)).not.toContain("opaque/export");
    expect(new TextDecoder().decode(first.body)).toContain("new!");
    expect(new TextDecoder().decode(first.body)).not.toContain("old");
    expect(audits.every((entry) => entry.action === "exported")).toBe(true);

    const app = createSpeakerRoutes({
      service,
      authenticate: async (request) =>
        request.headers.get("authorization") === "Bearer organizer"
          ? { accountId: "organizer" }
          : request.headers.get("authorization") === "Bearer admin"
            ? { accountId: "admin" }
            : { accountId: "reviewer" },
    });
    repository.organizerScopes.set("event-1:admin", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "admin",
    });
    const ownerResponse = await app.request("/events/event-1/organizer/deliverables/export", {
      method: "POST",
      headers: {
        authorization: "Bearer organizer",
        "content-type": "application/json",
      },
      body: JSON.stringify({ assetIds: ["asset-current"] }),
    });
    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.headers.get("content-type")).toContain("application/zip");
    expect(ownerResponse.headers.get("content-disposition")).toContain("attachment");
    const adminResponse = await app.request("/events/event-1/organizer/deliverables/export", {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ taskIds: ["upload-task"] }),
    });
    expect(adminResponse.status).toBe(200);
    const reviewerResponse = await app.request("/events/event-1/organizer/deliverables/export", {
      method: "POST",
      headers: {
        authorization: "Bearer reviewer",
        "content-type": "application/json",
      },
      body: JSON.stringify({ assetIds: ["asset-current"] }),
    });
    expect(reviewerResponse.status).toBe(404);
    await expect(
      service.exportDeliverables({
        eventId: "event-1",
        accountId: "organizer",
        assetIds: ["asset-cross-tenant"],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const manifest = archiveManifest(first.body);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(
      first.manifest.entries.map((entry) => entry.path),
    );
  });
  it("exports the latest ready revision when a newer family version is pending", async () => {
    const repository = new LifecycleRepository();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "owner",
    });
    repository.assets.push(
      {
        id: "asset-family-v1-ready",
        tenantId: "tenant-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "upload-task",
        kind: "slides",
        objectKey: "opaque/export/family-v1",
        fileName: "slides-v1.pdf",
        contentType: "application/pdf",
        sizeBytes: 8,
        state: "ready",
        createdAt: "2026-08-09T01:00:00.000Z",
        version: 1,
        versionFamilyId: "pending-family",
      },
      {
        id: "asset-family-v2-pending",
        tenantId: "tenant-1",
        eventId: "event-1",
        sessionId: "speaker-submission:submission-1",
        participantId: "participant-1",
        taskId: "upload-task",
        kind: "slides",
        objectKey: "opaque/export/family-v2",
        fileName: "slides-v2.pdf",
        contentType: "application/pdf",
        sizeBytes: 8,
        state: "pending_upload",
        createdAt: "2026-08-09T02:00:00.000Z",
        version: 2,
        versionFamilyId: "pending-family",
        supersedesAssetId: "asset-family-v1-ready",
        latestVersionId: "asset-family-v2-pending",
        currentVersionId: "asset-family-v1-ready",
        releasedVersionId: "asset-family-v1-ready",
      },
    );
    const gateway = new CapabilityGateway();
    gateway.objects.set("opaque/export/family-v1", {
      body: new TextEncoder().encode("ready-v1"),
      contentType: "application/pdf",
    });
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
    });

    const exported = await service.exportDeliverables({
      eventId: "event-1",
      accountId: "organizer",
      assetIds: ["asset-family-v2-pending"],
    });

    expect(exported.manifest.entries).toMatchObject([
      {
        assetId: "asset-family-v1-ready",
        version: 1,
      },
    ]);
    expect(new TextDecoder().decode(exported.body)).toContain("ready-v1");
    expect(new TextDecoder().decode(exported.body)).not.toContain("family-v2");
  });

  it("fails closed for missing gateway reads and bounded selections", async () => {
    const repository = new LifecycleRepository();
    repository.organizerScopes.set("event-1:organizer", {
      tenantId: "tenant-1",
      eventId: "event-1",
      submissionIds: ["submission-1"],
      participantIds: ["participant-1"],
      role: "owner",
    });
    const gateway = new CapabilityGateway();
    const missingGateway = gateway as unknown as { readObject?: unknown };
    missingGateway.readObject = undefined;
    const service = new SpeakerService(withTestSpeakerOrganizerLifecycle(repository), gateway, {
      speakerSender,
      sessionAuthority: acceptedTestSessionAuthority,
      now: () => new Date(now),
    });
    await expect(
      service.exportDeliverables({
        eventId: "event-1",
        accountId: "organizer",
        assetIds: Array.from({ length: 101 }, (_, index) => `asset-${index}`),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.exportDeliverables({
        eventId: "event-1",
        accountId: "organizer",
        status: "all",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });
});
