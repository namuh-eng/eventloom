"use client";

import { type FormEvent, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { DeliverableComment } from "./api";
import styles from "./file-library.module.css";
import { formatFileTime } from "./file-library-model";
import { fileFamilyCommentThread, selectedAssetCommentVersion } from "./file-review-model";
import type { FileReviewContext } from "./file-review-types";

interface FileReviewCommentsProps {
  readonly context: FileReviewContext;
  readonly comments: readonly DeliverableComment[];
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onAddComment?: (body: string, expectedVersion: number) => Promise<void>;
}

export function FileReviewComments({
  context,
  comments,
  loading,
  busy,
  error,
  onAddComment,
}: FileReviewCommentsProps) {
  const [body, setBody] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const thread = useMemo(
    () => fileFamilyCommentThread(comments, context.versions),
    [comments, context.versions],
  );
  const expectedVersion = selectedAssetCommentVersion(thread, context.asset.id);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      setValidationError("Enter a comment before posting.");
      return;
    }
    if (onAddComment === undefined) return;

    setValidationError(null);
    await onAddComment(trimmed, expectedVersion);
    setBody("");
  }

  return (
    <div className={styles.tabContent}>
      <div>
        <h3>Comments for version {context.asset.version ?? 1}</h3>
        <p className={styles.muted}>
          This thread is limited to file version v{context.asset.version ?? 1}.
        </p>
      </div>

      {error !== null ? (
        <Alert variant="destructive">
          <AlertTitle>Comments unavailable</AlertTitle>
          <AlertDescription>
            Comments for this file version could not be loaded. Try again.
          </AlertDescription>
        </Alert>
      ) : thread.length === 0 ? (
        <p className={styles.muted}>
          {loading ? "Loading comments…" : "No comments yet for this file family."}
        </p>
      ) : (
        <ol className={styles.commentList}>
          {thread.map((comment) => (
            <li className={styles.comment} key={comment.id}>
              <div className={styles.commentHeader}>
                <strong>{comment.authorLabel}</strong>
                <time dateTime={comment.createdAt}>{formatFileTime(comment.createdAt)}</time>
              </div>
              <p>{comment.body}</p>
            </li>
          ))}
        </ol>
      )}

      <form className={styles.commentForm} onSubmit={(event) => void submit(event)}>
        <div className={styles.field}>
          <Label htmlFor="file-comment-body">Reply to file v{context.asset.version ?? 1}</Label>
          <Textarea
            id="file-comment-body"
            rows={4}
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
          />
        </div>

        {validationError === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{validationError}</AlertDescription>
          </Alert>
        )}

        <Button variant="outline" type="submit" disabled={busy || onAddComment === undefined}>
          {onAddComment === undefined ? "Comments unavailable" : "Post organizer reply"}
        </Button>
      </form>
    </div>
  );
}
