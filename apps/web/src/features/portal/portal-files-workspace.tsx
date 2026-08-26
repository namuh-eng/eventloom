"use client";

import {
  formatUploadMimeTypes,
  standardImageUploadMimeTypes,
  standardPresentationUploadMimeTypes,
  standardSupportingFileUploadMimeTypes,
  standardUploadMaximumBytes,
} from "@eventloom/contracts";
import { type FormEvent, useMemo, useState } from "react";
import { Button, FileUpload, formatFileUploadSize } from "@/components/ui";
import {
  MetadataList,
  MetadataRow,
  StatusBadge,
  WorkspaceHeader,
  WorkspaceListDetail,
  WorkspaceState,
  WorkspaceSurface,
} from "@/components/workspace";
import { AssetDetails } from "./portal-asset-details";
import {
  groupPortalAssetVersions,
  portalFileStatus,
  portalReviewStatus,
  resolvePortalAssetFamily,
} from "./portal-assets";
import styles from "./portal-workspace.module.css";
import type { PortalAsset, PortalTask } from "./types";

export interface FilesWorkspaceUpload {
  readonly participantId: string;
  readonly sessionId: string;
  readonly kind: PortalAsset["kind"];
  readonly file: File;
  readonly taskId?: string;
  readonly supersedesAssetId?: string;
}
export interface FilesSessionOption {
  readonly id: string;
  readonly eventId: string;
  readonly title: string;
  readonly uploadTasks: readonly PortalTask[];
}

export interface FilesWorkspaceViewProps {
  readonly eventName: string;
  readonly sessions: readonly FilesSessionOption[];
  readonly selectedSessionId: string | null;
  readonly assets: readonly PortalAsset[];
  readonly participantId: string | null;
  readonly canWrite: boolean;
  readonly busyAssetIds: ReadonlySet<string>;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onUpload: (input: FilesWorkspaceUpload) => Promise<boolean> | boolean;
  readonly onRetryUpload: (assetId: string, file: File) => void;
  readonly onCompleteUpload: (assetId: string) => void;
  readonly onDownload: (asset: PortalAsset) => void;
}

interface FilesWorkspaceDraft {
  readonly ownerKey: string;
  readonly selectedFamilyId?: string | null;
  readonly uploadFamilyId?: string;
  readonly taskId?: string | undefined;
  readonly kind?: PortalAsset["kind"];
  readonly file?: File | null;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "Unknown size";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

const uploadPolicies: Readonly<
  Record<PortalAsset["kind"], { mimeTypes: readonly string[]; maxBytes: number }>
> = {
  headshot: {
    mimeTypes: standardImageUploadMimeTypes,
    maxBytes: standardUploadMaximumBytes.headshot,
  },
  slides: {
    mimeTypes: standardPresentationUploadMimeTypes,
    maxBytes: standardUploadMaximumBytes.slides,
  },
  supporting_file: {
    mimeTypes: standardSupportingFileUploadMimeTypes,
    maxBytes: standardUploadMaximumBytes.supporting_file,
  },
};
export function compatibleFilesUploadTasks(
  session: FilesSessionOption | null,
  kind: PortalAsset["kind"],
): readonly PortalTask[] {
  return session?.uploadTasks.filter((task) => task.acceptedAssetKinds?.includes(kind)) ?? [];
}

export function FilesWorkspaceView({
  eventName,
  sessions,
  selectedSessionId,
  assets,
  participantId,
  canWrite,
  busyAssetIds,
  onSelectSession,
  onUpload,
  onRetryUpload,
  onCompleteUpload,
  onDownload,
}: FilesWorkspaceViewProps) {
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const eventId = selectedSession?.eventId ?? sessions[0]?.eventId ?? eventName;
  const ownerKey = `${eventId}\u0000${participantId ?? ""}\u0000${selectedSessionId ?? ""}`;
  const [draft, setDraft] = useState<FilesWorkspaceDraft | null>(null);
  const ownedDraft = draft?.ownerKey === ownerKey ? draft : null;
  const selectedFamilyId = ownedDraft?.selectedFamilyId ?? null;
  const uploadFamilyId = ownedDraft?.uploadFamilyId ?? "";
  const kind = ownedDraft?.kind ?? "supporting_file";
  const file = ownedDraft?.file ?? null;
  function updateDraft(patch: Omit<FilesWorkspaceDraft, "ownerKey">): void {
    setDraft((current) => ({
      ownerKey,
      ...(current?.ownerKey === ownerKey ? current : {}),
      ...patch,
    }));
  }
  const uploadInputId = selectedSession
    ? `portal-file-upload-${selectedSession.id}`
    : "portal-file-upload";
  const scopedAssets = useMemo(
    () => assets.filter((asset) => asset.sessionId === selectedSession?.id),
    [assets, selectedSession?.id],
  );
  const families = useMemo(() => groupPortalAssetVersions(scopedAssets), [scopedAssets]);
  const selectedFamily = families.find((family) => family.id === selectedFamilyId) ?? families[0];
  const uploadFamily = families.find((family) => family.id === uploadFamilyId);
  const uploadKind = uploadFamily?.kind ?? kind;
  const uploadPolicy = uploadPolicies[uploadKind];
  const uploadResolution = uploadFamily
    ? resolvePortalAssetFamily(uploadFamily.versions, uploadFamily.current)
    : null;
  const replacementHead =
    uploadResolution?.status === "ready" || uploadResolution?.status === "rejected"
      ? uploadResolution.latest
      : undefined;
  const compatibleTasks = compatibleFilesUploadTasks(selectedSession, uploadKind);
  const selectedTask = replacementHead
    ? compatibleTasks.find((task) => task.id === replacementHead.taskId)
    : (compatibleTasks.find((task) => task.id === ownedDraft?.taskId) ?? compatibleTasks[0]);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !file ||
      !participantId ||
      !selectedSession ||
      (!selectedTask && !(replacementHead && replacementHead.taskId === undefined))
    ) {
      return;
    }
    const supersedesAssetId = replacementHead?.id;
    if (uploadFamily && !supersedesAssetId) return;
    const saved = await onUpload({
      participantId,
      sessionId: selectedSession.id,
      kind: uploadFamily?.kind ?? kind,
      file,
      ...(selectedTask === undefined ? {} : { taskId: selectedTask.id }),
      ...(supersedesAssetId ? { supersedesAssetId } : {}),
    });
    if (saved) updateDraft({ file: null });
  }

  return (
    <div className={styles.page}>
      <WorkspaceHeader
        eyebrow="Program-session workspace"
        title="Files"
        description="List, upload, finalize, and download private files with explicit program-session attribution."
        metadata={
          <>
            <span>{eventName}</span>
            <span>{families.length} file families</span>
          </>
        }
      />

      {sessions.length === 0 ? (
        <WorkspaceState
          variant="empty"
          title="No authorized program sessions"
          description="Files appear when the event team assigns you a session-scoped task."
        />
      ) : (
        <label className={styles.field}>
          <span>Session attribution</span>
          <select
            value={selectedSession?.id ?? ""}
            onChange={(event) => onSelectSession(event.currentTarget.value)}
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
        </label>
      )}

      {selectedSession && canWrite ? (
        <WorkspaceSurface
          title={`Upload for ${selectedSession.title}`}
          description="A new version supersedes only the authoritative current version; earlier versions remain immutable."
        >
          <form className={styles.surfaceBody} onSubmit={(event) => void upload(event)}>
            <div className={styles.fields}>
              <label className={styles.field}>
                <span>Version family</span>
                <select
                  value={uploadFamilyId}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    const family = families.find((candidate) => candidate.id === value);
                    updateDraft({
                      uploadFamilyId: value,
                      file: null,
                      ...(family ? { kind: family.kind } : {}),
                    });
                  }}
                >
                  <option value="">New file</option>
                  {families.map((family) => (
                    <option key={family.id} value={family.id}>
                      {family.current.fileName}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span>Upload task</span>
                <select
                  disabled={Boolean(uploadFamily)}
                  value={selectedTask?.id ?? ""}
                  onChange={(event) =>
                    updateDraft({ taskId: event.currentTarget.value, file: null })
                  }
                >
                  {compatibleTasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span>File type</span>
                <select
                  disabled={Boolean(uploadFamily)}
                  value={uploadKind}
                  onChange={(event) => {
                    updateDraft({
                      kind: event.currentTarget.value as PortalAsset["kind"],
                      taskId: undefined,
                      file: null,
                    });
                  }}
                >
                  <option value="headshot">Headshot</option>
                  <option value="slides">Slides</option>
                  <option value="supporting_file">Supporting file</option>
                </select>
              </label>
            </div>
            <div className={styles.field}>
              <span>Choose file</span>
              <FileUpload
                key={`${uploadFamilyId}:${uploadKind}`}
                id={uploadInputId}
                required
                ariaLabel="Choose file"
                accept={uploadPolicy.mimeTypes.join(",")}
                title="Drop your files here or browse"
                hint={`Accepted: ${formatUploadMimeTypes(uploadPolicy.mimeTypes)}. Maximum ${formatBytes(uploadPolicy.maxBytes)}.`}
                files={
                  file
                    ? [
                        {
                          id: file.name,
                          name: file.name,
                          sizeLabel: formatFileUploadSize(file.size),
                          status: "selected",
                        },
                      ]
                    : []
                }
                onFilesSelected={(files) => updateDraft({ file: files[0] ?? null })}
                onRemove={() => updateDraft({ file: null })}
              />
            </div>
            {uploadFamily && (!replacementHead || replacementHead.state === "pending_upload") ? (
              <p className={styles.notice}>
                Authoritative latest-version metadata is unavailable or still processing. Uploading
                a replacement is disabled.
              </p>
            ) : null}
            <div>
              <Button
                type="submit"
                disabled={
                  !file ||
                  !participantId ||
                  busyAssetIds.size > 0 ||
                  Boolean(
                    uploadFamily &&
                      (!replacementHead || replacementHead.state === "pending_upload"),
                  )
                }
              >
                {uploadFamily ? "Upload new version" : "Upload private file"}
              </Button>
            </div>
          </form>
        </WorkspaceSurface>
      ) : null}

      {selectedSession ? (
        <WorkspaceSurface
          title={`Files for ${selectedSession.title}`}
          description="Every item below is explicitly attributed to this program session."
        >
          {families.length === 0 ? (
            <WorkspaceState
              variant="empty"
              title="No files yet"
              description="Private uploads for this session will appear here."
            />
          ) : (
            <WorkspaceListDetail
              listLabel="Session files"
              detailLabel={selectedFamily?.current.fileName ?? "File detail"}
              list={
                <ul className={styles.list}>
                  {families.map((family) => (
                    <li key={family.id}>
                      <button
                        className={styles.listButton}
                        type="button"
                        aria-current={family.id === selectedFamily?.id ? "true" : undefined}
                        onClick={() => updateDraft({ selectedFamilyId: family.id })}
                      >
                        <strong>{family.current.fileName}</strong>
                        <span>
                          {family.kind.replaceAll("_", " ")} · {family.versions.length} versions
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              }
              detail={
                selectedFamily ? (
                  <FileFamilyDetail
                    family={selectedFamily}
                    busyAssetIds={busyAssetIds}
                    canWrite={canWrite}
                    onRetryUpload={onRetryUpload}
                    onCompleteUpload={onCompleteUpload}
                    onDownload={onDownload}
                  />
                ) : (
                  <WorkspaceState
                    variant="empty"
                    title="Select a file"
                    description="Choose a file family to inspect its review and versions."
                  />
                )
              }
            />
          )}
        </WorkspaceSurface>
      ) : null}
    </div>
  );
}

function FileFamilyDetail({
  family,
  busyAssetIds,
  canWrite,
  onRetryUpload,
  onCompleteUpload,
  onDownload,
}: Readonly<{
  family: ReturnType<typeof groupPortalAssetVersions>[number];
  busyAssetIds: ReadonlySet<string>;
  canWrite: boolean;
  onRetryUpload: (assetId: string, file: File) => void;
  onCompleteUpload: (assetId: string) => void;
  onDownload: (asset: PortalAsset) => void;
}>) {
  const resolution = resolvePortalAssetFamily(family.versions, family.current);
  const latest = resolution.latest ?? family.current;
  const current = resolution.current;
  const display = current ?? latest;
  return (
    <div className={styles.detail}>
      <div className={styles.row}>
        <h2>{display.fileName}</h2>
        <StatusBadge
          tone={
            latest.state === "ready"
              ? "success"
              : latest.state === "rejected"
                ? "danger"
                : "warning"
          }
        >
          {portalFileStatus(latest)}
        </StatusBadge>
      </div>
      <MetadataList>
        <MetadataRow label="Session ID" value={display.sessionId ?? "Unavailable"} />
        <MetadataRow label="Size" value={formatBytes(display.sizeBytes)} />
        <MetadataRow label="Format" value={display.contentType} />
        <MetadataRow label="Review state" value={portalReviewStatus(current)} />
      </MetadataList>
      {current?.reviewNote ? (
        <p className={styles.reviewNote}>
          <strong>Review note</strong>
          <br />
          {current.reviewNote}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={current?.state !== "ready" || busyAssetIds.has(current.id)}
        onClick={() => current && onDownload(current)}
      >
        Download current version
      </Button>
      <AssetDetails
        asset={latest}
        versions={family.versions}
        canCompleteUpload={canWrite}
        busy={busyAssetIds.has(latest.id)}
        onRetryUpload={(file) => onRetryUpload(latest.id, file)}
        onCompleteUpload={() => onCompleteUpload(latest.id)}
        onDownload={onDownload}
      />
    </div>
  );
}
