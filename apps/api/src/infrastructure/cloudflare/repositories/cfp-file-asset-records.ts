import type { CfpFileAsset } from "../../../features/cfp/service";
import type {
  PrivateAssetCapabilityBinding,
  PrivateUploadGrant,
} from "../../../features/speaker/types";
import { privateObjectCleanupOutboxStatement } from "../private-object-cleanup";

const SUBMISSION_CAPABILITY_PARTICIPANT = "__cfp_submission__";
const UPLOAD_TTL_MS = 15 * 60 * 1000;

export interface CfpFileAssetStatement {
  bind(...values: (ArrayBuffer | null | number | string)[]): CfpFileAssetStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface CfpFileAssetCapabilityProvider {
  registerUploadCapability(binding: PrivateAssetCapabilityBinding): Promise<PrivateUploadGrant>;
  verifyUploadCapability(binding: PrivateAssetCapabilityBinding): Promise<boolean>;
  invalidateUploadCapability(binding: PrivateAssetCapabilityBinding): Promise<void>;
}

export interface CfpFileAssetDatabase {
  prepare(query: string): CfpFileAssetStatement;
  batch(
    statements: readonly CfpFileAssetStatement[],
  ): Promise<readonly { meta?: { changes?: number } }[]>;
}

export interface StoredCfpFileAsset {
  id: string;
  organization_id: string;
  event_id: string;
  submission_id: string;
  owner: "submission" | "participant";
  participant_id: string | null;
  field_key: string;
  object_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  state: "pending_upload" | "ready" | "rejected";
  rejection_reason: string | null;
}

export async function cfpFileAssetId(requestKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(requestKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `cfp-file-${hash.slice(0, 40)}`;
}

export function cfpFileAssetObjectSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

export function cfpFileUploadExpiresAt(now: Date): string {
  return new Date(now.getTime() + UPLOAD_TTL_MS).toISOString();
}

export function cfpFileAssetView(asset: StoredCfpFileAsset): CfpFileAsset {
  return {
    assetId: asset.id,
    tenantId: asset.organization_id,
    eventId: asset.event_id,
    submissionId: asset.submission_id,
    owner: asset.owner,
    ...(asset.participant_id ? { participantId: asset.participant_id } : {}),
    state: asset.state,
    contentType: asset.content_type,
    sizeBytes: asset.size_bytes,
  };
}

export function cfpFileAssetBinding(
  asset: StoredCfpFileAsset,
  expiresAt: string,
): PrivateAssetCapabilityBinding {
  return {
    capabilityId: asset.id,
    tenantId: asset.organization_id,
    eventId: asset.event_id,
    subject: { kind: "cfp_submission", submissionId: asset.submission_id },
    participantId: asset.participant_id ?? SUBMISSION_CAPABILITY_PARTICIPANT,
    objectKey: asset.object_key,
    fileName: asset.file_name,
    contentType: asset.content_type,
    sizeBytes: asset.size_bytes,
    expiresAt,
  };
}

export function findCfpFileAsset(
  database: CfpFileAssetDatabase,
  tenantId: string,
  eventId: string,
  submissionId: string,
  assetId: string,
): Promise<StoredCfpFileAsset | null> {
  return database
    .prepare(
      `SELECT id, organization_id, event_id, submission_id, owner, participant_id, field_key, object_key, file_name, content_type, size_bytes, state, rejection_reason
       FROM cfp_file_assets
       WHERE organization_id = ? AND event_id = ? AND submission_id = ? AND id = ?`,
    )
    .bind(tenantId, eventId, submissionId, assetId)
    .first<StoredCfpFileAsset>();
}

export async function insertPendingCfpFileAsset(
  database: CfpFileAssetDatabase,
  asset: Omit<StoredCfpFileAsset, "rejection_reason" | "state"> & { createdAt: string },
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO cfp_file_assets
        (id, organization_id, event_id, submission_id, owner, participant_id, field_key, object_key, file_name, content_type, size_bytes, state, rejection_reason, created_at, finalized_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_upload', NULL, ?, NULL)`,
    )
    .bind(
      asset.id,
      asset.organization_id,
      asset.event_id,
      asset.submission_id,
      asset.owner,
      asset.participant_id,
      asset.field_key,
      asset.object_key,
      asset.file_name,
      asset.content_type,
      asset.size_bytes,
      asset.createdAt,
    )
    .run();
}

export async function finalizeCfpFileAsset(
  database: CfpFileAssetDatabase,
  input: {
    tenantId: string;
    eventId: string;
    submissionId: string;
    assetId: string;
    state: "ready" | "rejected";
    rejectionReason: string | null;
    finalizedAt: string;
    objectKey: string;
  },
): Promise<void> {
  const statements: CfpFileAssetStatement[] = [
    database
      .prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM cfp_file_assets
            WHERE organization_id = ? AND event_id = ? AND submission_id = ?
              AND id = ? AND state = 'pending_upload'
         ) THEN 1 ELSE json_extract('D1_CAS_CONFLICT', '$') END AS valid`,
      )
      .bind(input.tenantId, input.eventId, input.submissionId, input.assetId),
    database
      .prepare(
        `UPDATE cfp_file_assets
         SET state = ?, rejection_reason = ?, finalized_at = ?
         WHERE organization_id = ? AND event_id = ? AND submission_id = ? AND id = ? AND state = 'pending_upload'`,
      )
      .bind(
        input.state,
        input.rejectionReason,
        input.finalizedAt,
        input.tenantId,
        input.eventId,
        input.submissionId,
        input.assetId,
      ),
  ];
  if (input.state === "rejected") {
    statements.push(
      privateObjectCleanupOutboxStatement(
        database,
        {
          kind: "private_object_delete",
          source: "cfp",
          tenantId: input.tenantId,
          eventId: input.eventId,
          submissionId: input.submissionId,
          assetId: input.assetId,
          objectKey: input.objectKey,
        },
        input.finalizedAt,
      ) as CfpFileAssetStatement,
    );
  }
  await database.batch(statements);
}
