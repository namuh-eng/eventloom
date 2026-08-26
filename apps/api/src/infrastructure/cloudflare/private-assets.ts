import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type {
  CreatePrivateUploadGrantCommand,
  PrivateAssetCapabilityBinding,
  PrivateAssetGateway,
  PrivateDownloadCapabilityBinding,
  PrivateDownloadGrant,
  PrivateDownloadObject,
  PrivateUploadGrant,
  PrivateUploadReceipt,
} from "../../features/speaker/types";

type JsonRecord = Record<string, unknown>;
const downloadCapabilityRetentionMs = 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface StoredPrivateCapability {
  kind: "upload" | "download";
  capabilityHash: string;
  tenantId: string;
  eventId: string;
  subject: PrivateAssetCapabilityBinding["subject"];
  participantId: string;
  taskId?: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  fileName: string;
  expiresAt: string;
}

interface PrivateUploadRow {
  object_key: string;
  content_type: string;
  byte_size: number;
  state: string;
  scan_result_code: string | null;
  expires_at: string | null;
}

interface StoredDownloadCapability {
  assetId: string;
  tenantId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  fileName: string;
  capabilityHash: string;
  expiresAt: string;
  consumedAt: string | null;
  eventId: string;
  subject: PrivateAssetCapabilityBinding["subject"];
  participantId: string;
  requesterAccountId: string;
  requesterKind: "speaker" | "organizer";
  assetVersion: number;
  capabilityId: string;
}

interface PrivateDownloadCapabilityRow {
  asset_id: string;
  tenant_id: string;
  event_id: string | null;
  participant_id: string | null;
  requester_account_id: string | null;
  requester_kind: "speaker" | "organizer" | null;
  asset_version: number | null;
  capability_id: string | null;
  subject_kind: "cfp_submission" | "speaker_session" | "participant" | null;
  subject_id: string | null;
  object_key: string;
  content_type: string;
  byte_size: number;
  file_name: string;
  token_digest: string;
  expires_at: string;
  consumed_at: string | null;
}

function subjectId(subject: PrivateAssetCapabilityBinding["subject"]): string | null {
  switch (subject.kind) {
    case "cfp_submission":
      return subject.submissionId;
    case "speaker_session":
      return subject.sessionId;
    case "participant":
      return null;
  }
}

function storedSubject(
  kind: PrivateDownloadCapabilityRow["subject_kind"],
  id: string | null,
): PrivateAssetCapabilityBinding["subject"] | null {
  if (kind === "cfp_submission" && typeof id === "string") {
    return { kind, submissionId: id };
  }
  if (kind === "speaker_session" && typeof id === "string") {
    return { kind, sessionId: id };
  }
  return kind === "participant" && id === null ? { kind } : null;
}

function capabilityPayload(capability: StoredPrivateCapability): string {
  return JSON.stringify(capability);
}

function validSubject(value: unknown): value is PrivateAssetCapabilityBinding["subject"] {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  return (
    (value.kind === "cfp_submission" && typeof value.submissionId === "string") ||
    (value.kind === "speaker_session" && typeof value.sessionId === "string") ||
    value.kind === "participant"
  );
}

function sameSubject(
  left: PrivateAssetCapabilityBinding["subject"],
  right: PrivateAssetCapabilityBinding["subject"],
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "cfp_submission"
      ? right.kind === "cfp_submission" && left.submissionId === right.submissionId
      : left.kind === "speaker_session"
        ? right.kind === "speaker_session" && left.sessionId === right.sessionId
        : true)
  );
}

function parseStoredCapability(value: string | null): StoredPrivateCapability | null {
  if (value === null) return null;
  try {
    const candidate: unknown = JSON.parse(value);
    if (!isRecord(candidate)) return null;
    if (
      (candidate.kind !== "upload" && candidate.kind !== "download") ||
      typeof candidate.capabilityHash !== "string" ||
      typeof candidate.tenantId !== "string" ||
      typeof candidate.eventId !== "string" ||
      !validSubject(candidate.subject) ||
      typeof candidate.participantId !== "string" ||
      typeof candidate.objectKey !== "string" ||
      typeof candidate.contentType !== "string" ||
      typeof candidate.sizeBytes !== "number" ||
      !Number.isSafeInteger(candidate.sizeBytes) ||
      typeof candidate.fileName !== "string" ||
      typeof candidate.expiresAt !== "string"
    ) {
      return null;
    }
    return candidate as unknown as StoredPrivateCapability;
  } catch {
    return null;
  }
}

function capabilityToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function capabilityHash(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function capabilityExpired(expiresAt: string): boolean {
  const expiration = Date.parse(expiresAt);
  return !Number.isFinite(expiration) || expiration <= Date.now();
}

/** R2 private bytes are reachable only through database-backed opaque capabilities. */
export class R2PrivateAssetGateway implements PrivateAssetGateway {
  readonly #bucket: R2Bucket;
  readonly #database: D1Database | undefined;
  readonly #memory = new Map<
    string,
    {
      capability: StoredPrivateCapability;
      state: "pending" | "scanning" | "uploaded" | "consumed";
    }
  >();
  readonly #downloadCapabilities = new Map<string, StoredDownloadCapability>();

  constructor(bucket: R2Bucket, _origin: string, database?: D1Database) {
    this.#bucket = bucket;
    this.#database = database;
  }

  async createUploadGrant(_command: CreatePrivateUploadGrantCommand): Promise<PrivateUploadGrant> {
    throw new Error("A fully bound upload capability is required.");
  }

  async createDownloadGrant(_command: {
    objectKey: string;
    fileName: string;
    expiresAt: string;
  }): Promise<PrivateDownloadGrant> {
    throw new Error("A fully bound download capability is required.");
  }

  async registerUploadCapability(
    binding: PrivateAssetCapabilityBinding,
  ): Promise<PrivateUploadGrant> {
    const token = capabilityToken();
    const capability: StoredPrivateCapability = {
      kind: "upload",
      capabilityHash: await capabilityHash(token),
      tenantId: binding.tenantId,
      eventId: binding.eventId,
      subject: binding.subject,
      participantId: binding.participantId,
      ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }),
      objectKey: binding.objectKey,
      contentType: binding.contentType,
      sizeBytes: binding.sizeBytes,
      fileName: binding.fileName,
      expiresAt: binding.expiresAt,
    };
    await this.storeCapability(binding.capabilityId, capability, "pending");
    return {
      method: "PUT",
      url: `/api/speaker/assets/capabilities/upload/${encodeURIComponent(binding.capabilityId)}/${token}`,
      headers: {
        "content-type": binding.contentType,
        "content-length": String(binding.sizeBytes),
      },
      expiresAt: binding.expiresAt,
    };
  }

  async registerDownloadCapability(
    binding: PrivateDownloadCapabilityBinding,
  ): Promise<PrivateDownloadGrant> {
    const object = await this.#bucket.head(binding.objectKey);
    if (
      object === null ||
      object.size !== binding.sizeBytes ||
      (object.httpMetadata?.contentType ?? "").trim().toLowerCase() !==
        binding.contentType.trim().toLowerCase()
    ) {
      throw new Error("The requested private asset is not available.");
    }
    const capabilityId = crypto.randomUUID();
    const token = capabilityToken();
    const capability: StoredDownloadCapability = {
      assetId: binding.capabilityId,
      tenantId: binding.tenantId,
      objectKey: binding.objectKey,
      contentType: binding.contentType,
      sizeBytes: binding.sizeBytes,
      fileName: binding.fileName,
      capabilityHash: await capabilityHash(token),
      expiresAt: binding.expiresAt,
      consumedAt: null,
      eventId: binding.eventId,
      subject: binding.subject,
      participantId: binding.participantId,
      requesterAccountId: binding.requesterAccountId,
      requesterKind: binding.requesterKind,
      assetVersion: binding.assetVersion,
      capabilityId,
    };
    const createdAt = new Date().toISOString();
    const retentionCutoff = new Date(
      Date.parse(createdAt) - downloadCapabilityRetentionMs,
    ).toISOString();
    if (this.#database === undefined) {
      for (const [storedCapabilityId, storedCapability] of this.#downloadCapabilities) {
        if (Date.parse(storedCapability.expiresAt) <= Date.parse(retentionCutoff)) {
          this.#downloadCapabilities.delete(storedCapabilityId);
        }
      }
      this.#downloadCapabilities.set(capabilityId, capability);
    } else {
      await this.#database
        .prepare("DELETE FROM private_download_capabilities WHERE expires_at <= ?")
        .bind(retentionCutoff)
        .run();
      await this.#database.batch([
        this.#database
          .prepare(
            `INSERT INTO private_download_capabilities
               (id, asset_id, tenant_id, event_id, participant_id, requester_account_id,
                requester_kind, asset_version, capability_id, subject_kind, subject_id, object_key,
                content_type, byte_size, file_name, token_digest, expires_at, consumed_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          )
          .bind(
            capabilityId,
            capability.assetId,
            capability.tenantId,
            capability.eventId,
            capability.participantId,
            capability.requesterAccountId,
            capability.requesterKind,
            capability.assetVersion,
            capability.capabilityId,
            capability.subject.kind,
            subjectId(capability.subject),
            capability.objectKey,
            capability.contentType,
            capability.sizeBytes,
            capability.fileName,
            capability.capabilityHash,
            capability.expiresAt,
            createdAt,
          ),
        this.#database
          .prepare(
            "INSERT INTO speaker_asset_comments (id, organization_id, event_id, asset_id, version_id, body, author_label, author_account_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            `private-download-issued:${capabilityId}`,
            capability.tenantId,
            capability.eventId,
            capability.assetId,
            capability.assetId,
            JSON.stringify({
              id: `private-download-issued:${capabilityId}`,
              organizationId: capability.tenantId,
              eventId: capability.eventId,
              assetId: capability.assetId,
              action: "download_authorized",
              actorAccountId: capability.requesterAccountId,
              requesterKind: capability.requesterKind,
              capabilityId,
              attributionBasis: "authenticated_requester",
              occurredAt: createdAt,
              version: capability.assetVersion,
            }),
            "__speaker_asset_audit__",
            capability.requesterAccountId,
            capability.assetVersion,
            createdAt,
            createdAt,
          ),
      ]);
    }
    return {
      method: "GET",
      url: `/api/speaker/assets/capabilities/download/${encodeURIComponent(capabilityId)}/${token}`,
      expiresAt: binding.expiresAt,
    };
  }

  async consumeUploadCapability(
    capabilityId: string,
    token: string,
    request: Request,
  ): Promise<PrivateUploadReceipt> {
    if (request.method !== "PUT") throw new Error("The upload capability requires PUT.");
    const row = await this.readRow(capabilityId);
    const capability = parseStoredCapability(row?.scan_result_code ?? null);
    if (row === null || capability === null || capability.kind !== "upload") {
      throw new Error("The upload capability is invalid.");
    }
    await this.assertToken(capability, token);
    if (row.state !== "pending") throw new Error("The upload capability has already been used.");
    if (Date.parse(capability.expiresAt) <= Date.now()) {
      throw new Error("The upload capability has expired.");
    }
    const contentType = request.headers.get("content-type")?.trim().toLowerCase() ?? "";
    const declaredLength = request.headers.get("content-length");
    if (
      contentType !== capability.contentType.trim().toLowerCase() ||
      (declaredLength !== null &&
        (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== capability.sizeBytes))
    ) {
      throw new Error("The uploaded object metadata is not allowed.");
    }
    const body = await request.arrayBuffer();
    if (body.byteLength !== capability.sizeBytes) {
      throw new Error("The uploaded object size does not match the capability.");
    }
    const payload = row.scan_result_code ?? "";
    await this.claim(capabilityId, payload, "scanning");
    try {
      await this.#bucket.put(capability.objectKey, body, {
        httpMetadata: { contentType: capability.contentType },
      });
      await this.claim(capabilityId, payload, "uploaded", "scanning");
    } catch (error) {
      await this.releaseClaim(capabilityId, payload);
      throw error;
    }
    return {
      contentType: capability.contentType,
      sizeBytes: capability.sizeBytes,
      uploadedAt: new Date().toISOString(),
    };
  }

  async consumeDownloadCapability(
    capabilityId: string,
    token: string,
  ): Promise<PrivateDownloadObject> {
    const capability = await this.readDownloadCapability(capabilityId);
    if (capability === null) {
      throw new Error("The download capability is invalid.");
    }
    if (
      capability.eventId.length === 0 ||
      capability.participantId.length === 0 ||
      capability.requesterAccountId.length === 0 ||
      capability.capabilityId !== capabilityId
    ) {
      throw new Error("The download capability is invalid.");
    }
    await this.assertToken(capability, token);
    if (Date.parse(capability.expiresAt) <= Date.now()) {
      throw new Error("The download capability has expired.");
    }
    if (capability.consumedAt !== null) {
      throw new Error("The download capability has already been used.");
    }
    await this.claimDownloadCapability(capability, new Date().toISOString());
    const object = await this.#bucket.get(capability.objectKey);
    if (object === null || object.body === null) {
      throw new Error("The requested private asset is not available.");
    }
    const contentType = object.httpMetadata?.contentType ?? "";
    if (
      object.size !== capability.sizeBytes ||
      contentType.trim().toLowerCase() !== capability.contentType.trim().toLowerCase()
    ) {
      throw new Error("The private asset no longer matches its immutable metadata.");
    }
    return {
      body: object.body,
      contentType: capability.contentType,
      sizeBytes: object.size,
      fileName: capability.fileName,
    };
  }

  async inspectObject(
    command: Pick<PrivateAssetCapabilityBinding, "objectKey" | "contentType" | "sizeBytes">,
  ) {
    const object = await this.#bucket.head(command.objectKey);
    if (object === null || object.size !== command.sizeBytes) return null;
    const contentType = object.httpMetadata?.contentType ?? "";
    return contentType.trim().toLowerCase() === command.contentType.trim().toLowerCase()
      ? { contentType, sizeBytes: object.size }
      : null;
  }
  async verifyUploadCapability(binding: PrivateAssetCapabilityBinding): Promise<boolean> {
    const row = await this.readRow(binding.capabilityId);
    const capability = parseStoredCapability(row?.scan_result_code ?? null);
    if (
      row === null ||
      capability === null ||
      capability.kind !== "upload" ||
      row.state !== "uploaded" ||
      capabilityExpired(capability.expiresAt) ||
      capability.tenantId !== binding.tenantId ||
      capability.eventId !== binding.eventId ||
      !sameSubject(capability.subject, binding.subject) ||
      capability.participantId !== binding.participantId ||
      capability.objectKey !== binding.objectKey ||
      capability.contentType.trim().toLowerCase() !== binding.contentType.trim().toLowerCase() ||
      capability.sizeBytes !== binding.sizeBytes ||
      capability.fileName !== binding.fileName
    ) {
      return false;
    }
    return (await this.inspectObject(binding)) !== null;
  }

  async invalidateUploadCapability(binding: PrivateAssetCapabilityBinding): Promise<void> {
    const row = await this.readRow(binding.capabilityId);
    const capability = parseStoredCapability(row?.scan_result_code ?? null);
    if (
      row === null ||
      capability === null ||
      capability.kind !== "upload" ||
      capabilityExpired(capability.expiresAt) ||
      capability.tenantId !== binding.tenantId ||
      capability.eventId !== binding.eventId ||
      !sameSubject(capability.subject, binding.subject) ||
      capability.participantId !== binding.participantId ||
      capability.objectKey !== binding.objectKey ||
      (row.state !== "pending" && row.state !== "uploaded")
    ) {
      throw new Error("The upload capability cannot be invalidated.");
    }
    if (this.#database === undefined) {
      const stored = this.#memory.get(binding.capabilityId);
      if (stored === undefined) throw new Error("The upload capability cannot be invalidated.");
      stored.state = "consumed";
      return;
    }
    const result = await this.#database
      .prepare(
        `UPDATE private_uploads
            SET state = 'deleted', updated_at = ?
          WHERE id = ? AND state IN ('pending', 'uploaded') AND scan_result_code = ?
            AND expires_at > ?`,
      )
      .bind(
        new Date().toISOString(),
        binding.capabilityId,
        row.scan_result_code,
        new Date().toISOString(),
      )
      .run();
    if ((result.meta?.changes ?? 0) !== 1) {
      throw new Error("The upload capability cannot be invalidated.");
    }
  }

  async readObject(binding: PrivateAssetCapabilityBinding): Promise<PrivateDownloadObject | null> {
    const object = await this.#bucket.get(binding.objectKey);
    if (object === null || object.body === null || object.size !== binding.sizeBytes) return null;
    const contentType = object.httpMetadata?.contentType?.trim().toLowerCase() ?? "";
    if (contentType !== binding.contentType.trim().toLowerCase()) return null;
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType ?? binding.contentType,
      sizeBytes: object.size,
      fileName: binding.fileName,
    };
  }

  private async assertToken(
    capability: Pick<StoredPrivateCapability, "capabilityHash">,
    token: string,
  ): Promise<void> {
    if (token.length < 32 || (await capabilityHash(token)) !== capability.capabilityHash) {
      throw new Error("The capability token is invalid.");
    }
  }

  private async readDownloadCapability(
    capabilityId: string,
  ): Promise<StoredDownloadCapability | null> {
    if (this.#database === undefined) {
      return this.#downloadCapabilities.get(capabilityId) ?? null;
    }
    const row = await this.#database
      .prepare(
        `SELECT asset_id, tenant_id, event_id, participant_id, requester_account_id,
                requester_kind, asset_version, capability_id, subject_kind, subject_id, object_key,
                content_type, byte_size, file_name, token_digest, expires_at, consumed_at
           FROM private_download_capabilities
          WHERE id = ?
          LIMIT 1`,
      )
      .bind(capabilityId)
      .first<PrivateDownloadCapabilityRow>();
    if (row === null) return null;
    const subject = storedSubject(row.subject_kind, row.subject_id);
    if (subject === null) return null;
    return {
      assetId: row.asset_id,
      tenantId: row.tenant_id,
      eventId: row.event_id ?? "",
      subject,
      participantId: row.participant_id ?? "",
      requesterAccountId: row.requester_account_id ?? "",
      requesterKind: row.requester_kind ?? "speaker",
      assetVersion: row.asset_version ?? 1,
      capabilityId: row.capability_id ?? capabilityId,
      objectKey: row.object_key,
      contentType: row.content_type,
      sizeBytes: row.byte_size,
      fileName: row.file_name,
      capabilityHash: row.token_digest,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };
  }

  private async claimDownloadCapability(
    capability: StoredDownloadCapability,
    consumedAt: string,
  ): Promise<void> {
    if (this.#database === undefined) {
      const stored = this.#downloadCapabilities.get(capability.capabilityId);
      if (
        stored === undefined ||
        stored.consumedAt !== null ||
        stored.capabilityHash !== capability.capabilityHash ||
        Date.parse(stored.expiresAt) <= Date.parse(consumedAt)
      ) {
        throw new Error("The download capability is invalid or already used.");
      }
      stored.consumedAt = consumedAt;
      return;
    }
    const claimId = crypto.randomUUID();
    const audit = JSON.stringify({
      id: `private-download-consumed:${claimId}`,
      organizationId: capability.tenantId,
      eventId: capability.eventId,
      assetId: capability.assetId,
      action: "downloaded",
      actorAccountId: capability.requesterAccountId,
      requesterKind: capability.requesterKind,
      capabilityId: capability.capabilityId,
      attributionBasis: "issuance_principal",
      occurredAt: consumedAt,
      version: capability.assetVersion,
    });
    const results = await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE private_download_capabilities
              SET consumed_at = ?, consumption_claim_id = ?
            WHERE id = ?
              AND consumed_at IS NULL
              AND expires_at > ?
              AND token_digest = ?
              AND requester_account_id IS NOT NULL
              AND requester_kind IN ('speaker', 'organizer')
              AND event_id IS NOT NULL
              AND participant_id IS NOT NULL
              AND asset_version IS NOT NULL`,
        )
        .bind(consumedAt, claimId, capability.capabilityId, consumedAt, capability.capabilityHash),
      this.#database
        .prepare(
          `INSERT INTO speaker_asset_comments
             (id, organization_id, event_id, asset_id, version_id, body,
              author_label, author_account_id, version, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             FROM private_download_capabilities
            WHERE id = ? AND consumption_claim_id = ?`,
        )
        .bind(
          `private-download-consumed:${claimId}`,
          capability.tenantId,
          capability.eventId,
          capability.assetId,
          capability.assetId,
          audit,
          "__speaker_asset_audit__",
          capability.requesterAccountId,
          capability.assetVersion,
          consumedAt,
          consumedAt,
          capability.capabilityId,
          claimId,
        ),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1) {
      throw new Error("The download capability is invalid or already used.");
    }
  }

  private async readRow(capabilityId: string): Promise<PrivateUploadRow | null> {
    if (this.#database !== undefined) {
      return this.#database
        .prepare(
          `SELECT object_key, content_type, byte_size, state, scan_result_code, expires_at
             FROM private_uploads
            WHERE id = ?
            LIMIT 1`,
        )
        .bind(capabilityId)
        .first<PrivateUploadRow>();
    }
    const stored = this.#memory.get(capabilityId);
    return stored === undefined
      ? null
      : {
          object_key: stored.capability.objectKey,
          content_type: stored.capability.contentType,
          byte_size: stored.capability.sizeBytes,
          state: stored.state,
          scan_result_code: capabilityPayload(stored.capability),
          expires_at: stored.capability.expiresAt,
        };
  }

  private async storeCapability(
    capabilityId: string,
    capability: StoredPrivateCapability,
    state: "pending" | "uploaded",
  ): Promise<void> {
    const payload = capabilityPayload(capability);
    if (this.#database === undefined) {
      const existing = this.#memory.get(capabilityId);
      const canReplace =
        existing === undefined ||
        existing.state === "pending" ||
        (capability.kind === "download" && existing.state !== "scanning");
      if (!canReplace) {
        throw new Error("The private asset capability cannot be reauthorized.");
      }
      if (
        existing !== undefined &&
        (existing.capability.objectKey !== capability.objectKey ||
          existing.capability.contentType !== capability.contentType ||
          existing.capability.sizeBytes !== capability.sizeBytes)
      ) {
        throw new Error("The private asset capability binding is immutable.");
      }
      this.#memory.set(capabilityId, { capability, state });
      return;
    }
    const existing = await this.readRow(capabilityId);
    if (existing === null) {
      await this.#database
        .prepare(
          `INSERT INTO private_uploads
             (id, tenant_id, object_key, content_type, byte_size, checksum_sha256,
              state, scan_result_code, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'not-computed', ?, ?, ?, ?, ?)`,
        )
        .bind(
          capabilityId,
          capability.tenantId,
          capability.objectKey,
          capability.contentType,
          capability.sizeBytes,
          state,
          payload,
          new Date().toISOString(),
          new Date().toISOString(),
          capability.expiresAt,
        )
        .run();
      return;
    }
    if (
      existing.object_key !== capability.objectKey ||
      existing.content_type !== capability.contentType ||
      existing.byte_size !== capability.sizeBytes
    ) {
      throw new Error("The private asset capability binding is immutable.");
    }
    const canReplace =
      existing.state === "pending" ||
      (capability.kind === "upload" && existing.state === "deleted") ||
      (capability.kind === "download" && existing.state !== "scanning");
    if (!canReplace) {
      throw new Error("The private asset capability cannot be reauthorized.");
    }
    const statePredicate =
      capability.kind === "upload" ? "state IN ('pending', 'deleted')" : "state <> 'scanning'";
    const result = await this.#database
      .prepare(
        `UPDATE private_uploads
            SET state = ?, scan_result_code = ?, updated_at = ?, expires_at = ?
          WHERE id = ? AND ${statePredicate}`,
      )
      .bind(state, payload, new Date().toISOString(), capability.expiresAt, capabilityId)
      .run();
    if ((result.meta?.changes ?? 0) !== 1) {
      throw new Error("The private asset capability cannot be reauthorized.");
    }
  }

  private async claim(
    capabilityId: string,
    expectedPayload: string,
    nextState: "scanning" | "uploaded" | "download-consumed",
    expectedState: "pending" | "scanning" | "uploaded" = "pending",
  ): Promise<void> {
    if (this.#database === undefined) {
      const stored = this.#memory.get(capabilityId);
      if (
        stored === undefined ||
        stored.state !== expectedState ||
        capabilityPayload(stored.capability) !== expectedPayload
      ) {
        throw new Error("The capability has already been used.");
      }
      stored.state = nextState === "download-consumed" ? "consumed" : nextState;
      return;
    }
    const databaseState = nextState === "download-consumed" ? expectedState : nextState;
    const result = await this.#database
      .prepare(
        `UPDATE private_uploads
            SET state = ?, scan_result_code = ?, updated_at = ?
          WHERE id = ? AND state = ? AND scan_result_code = ?`,
      )
      .bind(
        databaseState,
        nextState === "download-consumed" ? nextState : expectedPayload,
        new Date().toISOString(),
        capabilityId,
        expectedState,
        expectedPayload,
      )
      .run();
    if ((result.meta?.changes ?? 0) !== 1) {
      throw new Error("The capability has already been used.");
    }
  }

  private async releaseClaim(capabilityId: string, payload: string): Promise<void> {
    if (this.#database === undefined) {
      const stored = this.#memory.get(capabilityId);
      if (
        stored !== undefined &&
        stored.state === "scanning" &&
        capabilityPayload(stored.capability) === payload
      ) {
        stored.state = "pending";
      }
      return;
    }
    await this.#database
      .prepare(
        `UPDATE private_uploads
            SET state = 'pending', updated_at = ?
          WHERE id = ? AND state = 'scanning' AND scan_result_code = ?`,
      )
      .bind(new Date().toISOString(), capabilityId, payload)
      .run();
  }
}
