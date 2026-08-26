"use client";

import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { WorkspaceFormSection, WorkspaceState } from "../../components/workspace/workspace-state";
import { assetPointerLabels } from "./portal-assets";
import { usePortal } from "./portal-provider";
import {
  assetVersionId,
  commentsForAsset,
  commentsForAssetVersion,
  commentThreadExpectedVersion,
  type TaskAssetResolution,
} from "./portal-task-assets";
import styles from "./portal-task-assets.module.css";
import { formatPortalDate, formatPortalFileSize, portalAssetStateLabel } from "./portal-ui-model";
import type { PortalAsset, PortalTask } from "./types";

export function PortalTaskAssetView({
  task,
  resolution,
}: Readonly<{ task: PortalTask; resolution: TaskAssetResolution }>) {
  const {
    addAssetComment,
    can,
    clearWorkspaceError,
    downloadAsset,
    loadAssetComments,
    workspace,
    workspaceError,
  } = usePortal();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [commentPending, setCommentPending] = useState(false);
  const [downloadPending, setDownloadPending] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const commentsRequestIdRef = useRef(0);
  const commentSubmissionIdRef = useRef(0);
  const asset =
    resolution.assets.find((candidate) => candidate.id === selectedId) ?? resolution.latest;
  const selectedAssetId = asset?.id;

  useEffect(() => {
    if (!selectedAssetId) return;
    const requestId = commentsRequestIdRef.current + 1;
    commentsRequestIdRef.current = requestId;
    let active = true;
    setCommentsLoading(true);
    clearWorkspaceError();
    void loadAssetComments(selectedAssetId).finally(() => {
      if (active && requestId === commentsRequestIdRef.current) setCommentsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [selectedAssetId, clearWorkspaceError, loadAssetComments]);

  if (!asset) {
    if (["missing-metadata", "conflict"].includes(resolution.status)) {
      return (
        <WorkspaceState
          variant="error"
          title="File metadata unavailable"
          description={resolution.error ?? "Authoritative version pointers are unavailable."}
        />
      );
    }
    return null;
  }

  const familyComments = workspace.assetComments[asset.id] ?? [];
  const comments = commentsForAsset(asset, familyComments);
  const expectedCommentVersion = commentThreadExpectedVersion(
    commentsForAssetVersion(asset, familyComments),
  );
  const version = asset.version ?? assetVersionId(asset);

  async function download(selected: PortalAsset) {
    if (selected.state !== "ready") return;
    setDownloadPending(true);
    try {
      const grant = await downloadAsset(selected.id);
      if (grant) window.location.assign(grant.url);
    } finally {
      setDownloadPending(false);
    }
  }

  async function postComment(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!asset || !comment.trim() || commentsLoading) return;
    const submissionId = commentSubmissionIdRef.current + 1;
    commentSubmissionIdRef.current = submissionId;
    setCommentPending(true);
    const expectedVersion = expectedCommentVersion;
    try {
      const succeeded = await addAssetComment({
        assetId: asset.id,
        body: comment.trim(),
        expectedVersion,
      });
      if (succeeded) setComment("");
    } finally {
      setCommentPending((current) =>
        submissionId === commentSubmissionIdRef.current ? false : current,
      );
    }
  }

  return (
    <WorkspaceFormSection
      title={`File version ${version}`}
      description="Pointers and comments stay bound to this immutable file version."
      action={
        asset.state === "ready" ? (
          <Button variant="outline" disabled={downloadPending} onClick={() => void download(asset)}>
            {downloadPending ? "Preparing…" : "Secure download"}
          </Button>
        ) : undefined
      }
    >
      <div className={styles.assetFacts}>
        <span>
          <strong>File</strong>
          {asset.fileName}
        </span>
        <span>
          <strong>State</strong>
          {portalAssetStateLabel(asset.state)}
        </span>
        <span>
          <strong>Format</strong>
          {asset.contentType}
        </span>
        <span>
          <strong>Size</strong>
          {formatPortalFileSize(asset.sizeBytes)}
        </span>
      </div>
      <fieldset className={styles.pointerBadges}>
        <legend className={styles.srOnly}>Authoritative asset pointers</legend>
        {assetPointerLabels(asset, resolution.pointers).map((label) => (
          <span key={label}>{label}</span>
        ))}
      </fieldset>
      {resolution.pointers.status !== "ready" ? (
        <WorkspaceState
          variant="error"
          title="Version state unavailable"
          description={resolution.error ?? "Authoritative asset pointers cannot be confirmed."}
        />
      ) : null}
      {asset.state === "pending_upload" ? (
        <p className={styles.notice}>
          Transfer finished, but server finalization is still pending.
        </p>
      ) : null}
      {asset.state === "rejected" ? (
        <p className={styles.error}>
          {asset.rejectionReason ?? "The server rejected this upload."}
        </p>
      ) : null}
      {resolution.assets.length > 1 ? (
        <fieldset className={styles.versionPicker}>
          <legend className={styles.srOnly}>File versions</legend>
          {resolution.assets.map((candidate) => (
            <Button
              key={candidate.id}
              size="sm"
              variant={candidate.id === asset.id ? "secondary" : "ghost"}
              aria-pressed={candidate.id === asset.id}
              onClick={() => setSelectedId(candidate.id)}
            >
              Version {candidate.version ?? assetVersionId(candidate)}
            </Button>
          ))}
        </fieldset>
      ) : null}
      <section className={styles.comments} aria-labelledby={`task-comments-${task.id}`}>
        <h3 id={`task-comments-${task.id}`}>Comments on version {version}</h3>
        {workspaceError ? (
          <p className={styles.error} role="alert">
            {workspaceError}
          </p>
        ) : null}
        {commentsLoading ? (
          <p className={styles.muted} role="status">
            Loading comments…
          </p>
        ) : comments.length === 0 ? (
          <p className={styles.muted}>No comments on this file version.</p>
        ) : (
          <ol>
            {comments.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.authorLabel}</strong>
                <time dateTime={entry.createdAt}>{formatPortalDate(entry.createdAt)}</time>
                <p>{entry.body}</p>
              </li>
            ))}
          </ol>
        )}
        {can("asset-comment") ? (
          <form className={styles.commentForm} onSubmit={(event) => void postComment(event)}>
            <label htmlFor={`task-comment-${task.id}`}>Reply on this version</label>
            <Textarea
              id={`task-comment-${task.id}`}
              rows={3}
              maxLength={10_000}
              value={comment}
              onChange={(event) => setComment(event.currentTarget.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={commentsLoading || commentPending || !comment.trim()}
            >
              {commentPending ? "Posting…" : "Post reply"}
            </Button>
          </form>
        ) : null}
      </section>
    </WorkspaceFormSection>
  );
}
