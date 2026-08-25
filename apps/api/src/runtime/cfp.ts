import { standardPresentationUploadMimeTypes } from "@eventloom/contracts";
import type {
  AuditEntry,
  CfpForm,
  EventCfp,
  Submission,
  SubmissionVersion,
} from "../features/cfp/model";
import {
  type CfpEffects,
  CfpError,
  type CfpFileAsset,
  type CfpFileAssetGateway,
  type CfpFileUploadAuthorization,
  type CfpIdempotencyCoordinator,
  type CfpRepository,
  CfpService,
} from "../features/cfp/service";
import type {
  PrivateAssetCapabilityBinding,
  PrivateAssetGateway,
  PrivateUploadGrant,
} from "../features/speaker/types";

const LOCAL_CFP_NOW = "2026-08-08T12:00:00.000Z";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(tenantId: string, id: string): string {
  return `${tenantId}\u0000${id}`;
}

type LocalCfpEventRepository = Pick<CfpRepository, "getEvent" | "getEventBySlug" | "saveEvent">;

function localFixtureForm(tenantId: string, eventId: string, formId = "main-cfp"): CfpForm {
  return {
    id: formId,
    tenantId,
    eventId,
    name: "Main call for speakers",
    version: 1,
    status: "draft",
    welcomeContent: "Share the session you want to bring to our community.",
    settings: {
      speakerLimit: 3,
      maxSubmissionsPerAccount: 3,
      remindersEnabled: true,
      adminNotificationsEnabled: true,
      confirmationMessage: "Your proposal has been received.",
      successContent: "Thank you for contributing to the program.",
      redirectUrl: "http://127.0.0.1:3015/portal",
    },
    sections: [
      { id: "session", title: "Session", description: "Tell us about the proposed session." },
      { id: "people", title: "Speakers", description: "Add the people presenting the session." },
    ],
    submissionFields: [
      {
        id: "field-title",
        sectionId: "session",
        key: "title",
        label: "Session title",
        kind: "text",
        required: true,
        options: [],
      },
      {
        id: "field-abstract",
        sectionId: "session",
        key: "abstract",
        label: "Abstract",
        kind: "rich_text",
        required: true,
        options: [],
      },
      {
        id: "field-format",
        sectionId: "session",
        key: "format",
        label: "Format",
        kind: "select",
        required: true,
        options: ["Featured Keynote", "Keynote", "Breakout Session", "Workshop"],
      },
      {
        id: "field-level",
        sectionId: "session",
        key: "level",
        label: "Audience level",
        kind: "select",
        required: true,
        options: ["Introductory", "Intermediate", "Advanced", "All levels"],
      },
      {
        id: "field-track",
        sectionId: "session",
        key: "track",
        label: "Program track",
        kind: "select",
        required: true,
        options: [
          "Platform & Infrastructure",
          "Product & Design",
          "Leadership & Teams",
          "Data & AI",
          "Community & Ecosystems",
        ],
      },
      {
        id: "field-slides",
        sectionId: "session",
        key: "slides",
        label: "Optional session slides",
        kind: "file_request",
        required: false,
        options: [],
        fileRequest: {
          allowedMimeTypes: [...standardPresentationUploadMimeTypes],
          maxBytes: 10 * 1024 * 1024,
          required: false,
          owner: "submission",
        },
      },
    ],
    participantFields: [
      {
        id: "participant-first-name",
        sectionId: "people",
        key: "firstName",
        label: "First name",
        kind: "text",
        required: true,
        options: [],
      },
      {
        id: "participant-last-name",
        sectionId: "people",
        key: "lastName",
        label: "Last name",
        kind: "text",
        required: true,
        options: [],
      },
      {
        id: "participant-email",
        sectionId: "people",
        key: "email",
        label: "Email",
        kind: "email",
        required: true,
        options: [],
      },
      {
        id: "participant-company",
        sectionId: "people",
        key: "company",
        label: "Company",
        kind: "text",
        required: false,
        options: [],
      },
    ],
    rules: [],
  };
}

class LocalCfpRepository implements CfpRepository {
  readonly #forms = new Map<string, CfpForm>();
  readonly #submissions = new Map<string, Submission>();
  readonly #sharedEvents: LocalCfpEventRepository | undefined;
  readonly versions: SubmissionVersion[] = [];
  readonly audits: AuditEntry[] = [];

  constructor(sharedEvents?: LocalCfpEventRepository) {
    this.#sharedEvents = sharedEvents;
  }

  async getEvent(tenantId: string, eventId: string) {
    return clone((await this.#sharedEvents?.getEvent(tenantId, eventId)) ?? null);
  }

  async getEventBySlug(tenantId: string, eventSlug: string) {
    return clone((await this.#sharedEvents?.getEventBySlug(tenantId, eventSlug)) ?? null);
  }

  async saveEvent(event: EventCfp, expectedVersion: number | null): Promise<void> {
    const shared = await this.#sharedEvents?.getEvent(event.tenantId, event.id);
    if (shared === undefined || shared === null || this.#sharedEvents === undefined) {
      throw new CfpError("NOT_FOUND", "The event was not found.");
    }
    await this.#sharedEvents.saveEvent(event, expectedVersion);
  }

  async getForm(tenantId: string, formId: string) {
    return clone(this.#forms.get(key(tenantId, formId)) ?? null);
  }

  async listForms(tenantId: string, eventId: string) {
    return [...this.#forms.values()]
      .filter((form) => form.tenantId === tenantId && form.eventId === eventId)
      .map(clone);
  }

  async saveForm(form: CfpForm, expectedVersion: number | null): Promise<void> {
    const storageKey = key(form.tenantId, form.id);
    if ((this.#forms.get(storageKey)?.version ?? null) !== expectedVersion) {
      throw new CfpError("CONFLICT", "The CFP form has changed.");
    }
    this.#forms.set(storageKey, clone(form));
  }

  async getSubmission(tenantId: string, submissionId: string) {
    return clone(this.#submissions.get(key(tenantId, submissionId)) ?? null);
  }

  async listSubmissionsForEvent(tenantId: string, eventId: string) {
    return [...this.#submissions.values()]
      .filter((submission) => submission.tenantId === tenantId && submission.eventId === eventId)
      .map(clone);
  }

  async countOwnedSubmissions(input: {
    tenantId: string;
    eventId: string;
    formId: string;
    ownerAccountId: string;
  }) {
    return [...this.#submissions.values()].filter(
      (submission) =>
        submission.tenantId === input.tenantId &&
        submission.eventId === input.eventId &&
        submission.formId === input.formId &&
        submission.ownerAccountId === input.ownerAccountId &&
        submission.status !== "withdrawn",
    ).length;
  }

  async saveSubmissionVersion(
    version: SubmissionVersion,
    expectedVersion: number | null,
    audit?: AuditEntry,
  ): Promise<void> {
    const storageKey = key(version.submission.tenantId, version.submission.id);
    if ((this.#submissions.get(storageKey)?.version ?? null) !== expectedVersion) {
      throw new CfpError("CONFLICT", "The CFP submission has changed.");
    }
    this.#submissions.set(storageKey, clone(version.submission));
    this.versions.push(clone(version));
    if (audit !== undefined) this.audits.push(clone(audit));
  }
}
type LocalFileCapability = {
  readonly assetId: string;
  readonly fieldKey: string;
  readonly objectKey: string;
  readonly fileName: string;
  readonly token: string;
  readonly expiresAt: string;
  grant?: PrivateUploadGrant;
  used: boolean;
  uploaded?: {
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly body: Uint8Array;
  };
};

async function localDigest(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class LocalCfpFileAssetGateway implements CfpFileAssetGateway {
  readonly #repository: LocalCfpRepository;
  readonly #assets = new Map<string, CfpFileAsset>();
  readonly #capabilities = new Map<string, LocalFileCapability>();
  readonly #requestIds = new Map<string, string>();
  readonly #now: () => Date;
  readonly #privateAssets:
    | Pick<PrivateAssetGateway, "registerUploadCapability" | "inspectObject">
    | undefined;

  constructor(
    repository: LocalCfpRepository,
    now: () => Date,
    privateAssets?: Pick<PrivateAssetGateway, "registerUploadCapability" | "inspectObject">,
  ) {
    this.#repository = repository;
    this.#now = now;
    this.#privateAssets = privateAssets;
  }

  private async context(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    owner: "submission" | "participant";
    participantId?: string;
    fieldKey: string;
  }): Promise<{
    readonly submission: Submission;
    readonly field: CfpForm["submissionFields"][number];
  }> {
    const event = await this.#repository.getEvent(input.tenantId, input.eventId);
    const submission = await this.#repository.getSubmission(input.tenantId, input.submissionId);
    if (event === null || submission === null || submission.eventId !== input.eventId) {
      throw new CfpError("FORBIDDEN", "The file asset binding is not owned by this event.");
    }
    const form = await this.#repository.getForm(input.tenantId, submission.formId);
    if (form === null || form.eventId !== input.eventId) {
      throw new CfpError("FORBIDDEN", "The file asset form is not owned by this event.");
    }
    const fields =
      input.participantId === undefined ? form.submissionFields : form.participantFields;
    const field = fields.find((candidate) => candidate.key === input.fieldKey);
    if (field === undefined || field.kind !== "file_request" || field.fileRequest === undefined) {
      throw new CfpError(
        "VALIDATION_FAILED",
        "The requested field is not an authorized file request.",
      );
    }
    if (field.fileRequest.owner !== input.owner) {
      throw new CfpError("FORBIDDEN", "The file asset owner does not match the requested field.");
    }
    if (input.owner === "participant") {
      if (
        input.participantId === undefined ||
        !submission.participants.some((participant) => participant.id === input.participantId)
      ) {
        throw new CfpError(
          "FORBIDDEN",
          "The file upload participant is not part of this submission.",
        );
      }
    } else if (input.participantId !== undefined) {
      throw new CfpError("FORBIDDEN", "This submission file request cannot target a participant.");
    }
    return { submission, field };
  }

  async issueUpload(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    owner: "submission" | "participant";
    participantId?: string;
    fieldKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    idempotencyKey: string;
  }): Promise<CfpFileUploadAuthorization> {
    if (input.idempotencyKey.trim().length === 0) {
      throw new CfpError("IDEMPOTENCY_KEY_REQUIRED", "An idempotency key is required.");
    }
    const { submission, field } = await this.context(input);
    const contentType = input.contentType.trim().toLowerCase();
    const fileName = input.fileName.trim();
    if (
      fileName.length === 0 ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      field.fileRequest === undefined ||
      input.sizeBytes > field.fileRequest.maxBytes ||
      !field.fileRequest.allowedMimeTypes.some((allowed) => {
        const candidate = allowed.trim().toLowerCase();
        return (
          candidate === contentType ||
          (candidate.endsWith("/*") && contentType.startsWith(candidate.slice(0, -1)))
        );
      })
    ) {
      throw new CfpError("VALIDATION_FAILED", "The upload metadata is not allowed.");
    }
    const requestKey = JSON.stringify([
      input.tenantId,
      input.eventId,
      submission.id,
      input.owner,
      input.participantId ?? "",
      input.fieldKey,
      input.idempotencyKey,
    ]);
    const existingId = this.#requestIds.get(requestKey);
    if (existingId !== undefined) {
      const existing = this.#assets.get(existingId);
      const capability = this.#capabilities.get(existingId);
      if (
        existing !== undefined &&
        capability !== undefined &&
        existing.state === "pending_upload" &&
        existing.contentType === contentType &&
        existing.sizeBytes === input.sizeBytes &&
        existing.owner === input.owner &&
        existing.participantId === input.participantId
      ) {
        return this.authorization(existing, capability);
      }
      throw new CfpError("CONFLICT", "The file upload idempotency key is already bound.");
    }
    const digest = await localDigest(requestKey);
    const assetId = `cfp-file-local-${digest.slice(0, 32)}`;
    const token = `local-upload-${(await localDigest(`${requestKey}:token`)).slice(0, 40)}`;
    const expiresAt = new Date(this.#now().getTime() + 15 * 60 * 1000).toISOString();
    const objectKey = [
      "cfp",
      encodeURIComponent(input.tenantId),
      encodeURIComponent(input.eventId),
      encodeURIComponent(submission.id),
      input.owner,
      encodeURIComponent(input.fieldKey),
      assetId,
    ].join("/");
    const asset: CfpFileAsset = {
      assetId,
      tenantId: input.tenantId,
      eventId: input.eventId,
      submissionId: submission.id,
      owner: input.owner,
      ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
      state: "pending_upload",
      contentType,
      sizeBytes: input.sizeBytes,
    };
    this.#assets.set(assetId, asset);
    this.#requestIds.set(requestKey, assetId);
    const capability: LocalFileCapability = {
      assetId,
      fieldKey: input.fieldKey,
      objectKey,
      fileName,
      token,
      expiresAt,
      used: false,
    };
    if (this.#privateAssets?.registerUploadCapability !== undefined) {
      const binding: PrivateAssetCapabilityBinding = {
        capabilityId: assetId,
        tenantId: input.tenantId,
        eventId: input.eventId,
        subject: { kind: "cfp_submission", submissionId: submission.id },
        participantId: input.participantId ?? "cfp-submission",
        objectKey,
        contentType,
        sizeBytes: input.sizeBytes,
        fileName,
        expiresAt,
      };
      capability.grant = await this.#privateAssets.registerUploadCapability(binding);
    }
    this.#capabilities.set(assetId, capability);
    return this.authorization(asset, capability);
  }

  private authorization(
    asset: CfpFileAsset,
    capability: LocalFileCapability,
  ): CfpFileUploadAuthorization {
    return {
      authorizationId: asset.assetId,
      asset: clone(asset),
      grant: capability.grant ?? {
        method: "PUT",
        url: `/api/speaker/assets/capabilities/upload/${encodeURIComponent(asset.assetId)}/${capability.token}`,
        headers: {
          "content-type": asset.contentType,
          "content-length": String(asset.sizeBytes),
        },
        expiresAt: capability.expiresAt,
      },
    };
  }

  async consumeUploadCapability(
    assetId: string,
    token: string,
    request: Request,
  ): Promise<{
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly uploadedAt: string;
  }> {
    const capability = this.#capabilities.get(assetId);
    const asset = this.#assets.get(assetId);
    if (
      capability === undefined ||
      asset === undefined ||
      capability.token !== token ||
      capability.used ||
      Date.parse(capability.expiresAt) <= this.#now().getTime()
    ) {
      throw new Error("The upload capability is invalid or expired.");
    }
    if (request.method !== "PUT") throw new Error("The upload capability requires PUT.");
    const contentType = request.headers.get("content-type")?.trim().toLowerCase() ?? "";
    const body = new Uint8Array(await request.arrayBuffer());
    const declaredLength = request.headers.get("content-length");
    if (
      contentType !== asset.contentType ||
      body.byteLength !== asset.sizeBytes ||
      (declaredLength !== null && Number(declaredLength) !== asset.sizeBytes)
    ) {
      throw new Error("The uploaded object metadata is not allowed.");
    }
    capability.used = true;
    capability.uploaded = {
      contentType,
      sizeBytes: body.byteLength,
      body,
    };
    return {
      contentType,
      sizeBytes: body.byteLength,
      uploadedAt: this.#now().toISOString(),
    };
  }

  async finalizeUpload(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    fieldKey: string;
    assetId: string;
    owner: "submission" | "participant";
    participantId?: string;
    state: "ready" | "rejected";
    rejectionReason?: string;
    idempotencyKey: string;
  }): Promise<CfpFileAsset> {
    if (input.idempotencyKey.trim().length === 0) {
      throw new CfpError("IDEMPOTENCY_KEY_REQUIRED", "An idempotency key is required.");
    }
    const rejectionReason = input.rejectionReason?.trim();
    if (rejectionReason !== undefined && rejectionReason.length > 2000) {
      throw new CfpError("VALIDATION_FAILED", "The upload rejection reason is too long.");
    }
    await this.context(input);
    const asset = this.#assets.get(input.assetId);
    const capability = this.#capabilities.get(input.assetId);
    if (
      asset === undefined ||
      capability === undefined ||
      asset.tenantId !== input.tenantId ||
      asset.eventId !== input.eventId ||
      asset.submissionId !== input.submissionId ||
      asset.owner !== input.owner ||
      asset.participantId !== input.participantId ||
      capability.fieldKey !== input.fieldKey
    ) {
      throw new CfpError("FORBIDDEN", "The private upload asset is not owned by this submission.");
    }
    if (asset.state === input.state) return clone(asset);
    if (asset.state !== "pending_upload") {
      throw new CfpError("VALIDATION_FAILED", "The private upload asset is no longer available.");
    }
    const expiration = Date.parse(capability.expiresAt);
    if (!Number.isFinite(expiration) || expiration <= this.#now().getTime()) {
      throw new CfpError("VALIDATION_FAILED", "The private upload capability has expired.");
    }
    if (input.state === "ready") {
      const uploaded =
        this.#privateAssets?.inspectObject === undefined
          ? capability.uploaded
          : await this.#privateAssets.inspectObject({
              objectKey: capability.objectKey,
              contentType: asset.contentType,
              sizeBytes: asset.sizeBytes,
            });
      if (
        uploaded === undefined ||
        uploaded === null ||
        uploaded.sizeBytes !== asset.sizeBytes ||
        uploaded.contentType.trim().toLowerCase() !== asset.contentType.trim().toLowerCase()
      ) {
        throw new CfpError("VALIDATION_FAILED", "The private upload has not been uploaded.");
      }
    }
    const finalized: CfpFileAsset = {
      ...asset,
      state: input.state,
    };
    this.#assets.set(input.assetId, finalized);
    capability.used = true;
    return clone(finalized);
  }

  async getAsset(input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    assetId: string;
    owner: "submission" | "participant";
    participantId?: string;
  }): Promise<CfpFileAsset | null> {
    const asset = this.#assets.get(input.assetId);
    const capability = this.#capabilities.get(input.assetId);
    if (asset === undefined || capability === undefined) return null;
    try {
      await this.context({
        tenantId: input.tenantId,
        eventId: input.eventId,
        submissionId: input.submissionId,
        owner: asset.owner,
        fieldKey: capability.fieldKey,
        ...(asset.participantId === undefined ? {} : { participantId: asset.participantId }),
      });
    } catch {
      return null;
    }
    if (
      asset.tenantId !== input.tenantId ||
      asset.eventId !== input.eventId ||
      asset.submissionId !== input.submissionId ||
      asset.owner !== input.owner ||
      asset.participantId !== input.participantId
    ) {
      return null;
    }
    return clone(asset);
  }
}

class LocalCfpIdempotency implements CfpIdempotencyCoordinator {
  readonly #operations = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

  run<T>(
    scope: string,
    idempotencyKey: string,
    operation: () => Promise<T>,
    fingerprint = `cfp:${scope}:${idempotencyKey}`,
  ): Promise<T> {
    const storageKey = key(scope, idempotencyKey);
    const existing = this.#operations.get(storageKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new CfpError(
            "CONFLICT",
            "The idempotency key was already used with a different request.",
          ),
        );
      }
      return existing.promise as Promise<T>;
    }
    const pending = operation().catch((error) => {
      if (this.#operations.get(storageKey)?.promise === pending) {
        this.#operations.delete(storageKey);
      }
      throw error;
    });
    this.#operations.set(storageKey, { fingerprint, promise: pending });
    return pending;
  }
}

export function createLocalCfpService(
  privateAssets?: Pick<PrivateAssetGateway, "registerUploadCapability" | "inspectObject">,
  effects?: CfpEffects,
  sharedEvents?: LocalCfpEventRepository,
): CfpService {
  let sequence = 0;
  const now = () => new Date(LOCAL_CFP_NOW);
  const repository = new LocalCfpRepository(sharedEvents);
  return new CfpService({
    repository,
    organization: {
      getPublicOrganization: async (tenantId) => ({
        id: tenantId,
        slug: tenantId,
        name: "Eventloom",
      }),
    },
    idempotency: new LocalCfpIdempotency(),
    effects: effects ?? { async enqueueSubmissionConfirmation() {} },
    clock: { now },
    ids: { next: (prefix) => `${prefix}_local_${++sequence}` },
    fileAssets: new LocalCfpFileAssetGateway(repository, () => new Date(), privateAssets),
  });
}

export async function seedLocalCfpForm(
  service: CfpService,
  input: {
    tenantId: string;
    eventId: string;
    formId?: string;
    actorId: string;
  },
): Promise<CfpForm> {
  const formId = input.formId ?? "main-cfp";
  const draft = await service.createForm({
    tenantId: input.tenantId,
    form: localFixtureForm(input.tenantId, input.eventId, formId),
    expectedVersion: null,
    idempotencyKey: `local-cfp-form:${input.eventId}:${formId}`,
  });
  return service.publishForm({
    tenantId: input.tenantId,
    eventId: input.eventId,
    formId: draft.id,
    organizerId: input.actorId,
    expectedVersion: draft.version,
    idempotencyKey: `local-cfp-form-publish:${input.eventId}:${formId}`,
  });
}
