"use client";

import Link from "next/link";
import { portalSubmissionEditTarget, submissionStatusPresentation } from "./model";
import styles from "./portal.module.css";
import {
  canonicalPortalSubmissionId,
  portalSubmissionDisplayTitle,
} from "./portal-submission-model";
import { SubmissionStatusBadge } from "./portal-ui";
import { formatPortalDate } from "./portal-ui-model";
import type { PortalContext, PortalSubmission } from "./types";

export function PortalSubmissionCard({
  canEdit,
  context,
  eventQuery,
  equivalents,
  submission,
}: {
  readonly canEdit: boolean;
  readonly context: PortalContext | null;
  readonly eventQuery: string;
  readonly equivalents: readonly PortalSubmission[];
  readonly submission: PortalSubmission;
}) {
  const presentation = submissionStatusPresentation(submission.status);
  const accepted = submission.status === "accepted";
  const draft = submission.status === "draft";
  const displayTitle = portalSubmissionDisplayTitle(submission, equivalents);
  const editTarget = canEdit ? portalSubmissionEditTarget(context, submission) : null;

  return (
    <article className={styles.submissionTile}>
      <div className={styles.submissionTileTop}>
        <span className={styles.documentIcon} aria-hidden="true">
          ▤
        </span>
        <SubmissionStatusBadge status={submission.status} />
      </div>
      <div>
        <p className={styles.submissionId}>Proposal · {displayTitle}</p>
        <h3>{displayTitle}</h3>
        <p>{presentation.description}</p>
      </div>
      <footer>
        <span>
          {submission.version === undefined ? "" : `Revision ${submission.version} · `}
          Updated {formatPortalDate(submission.updatedAt) ?? "recently"}
        </span>
        {accepted ? (
          <strong className={styles.acceptedMessage}>Your proposal was accepted</strong>
        ) : null}
        {editTarget === null ? null : (
          <Link
            className={draft ? styles.primaryTextLink : undefined}
            href={editTarget.href}
            aria-label={`${draft ? "Continue" : "Edit"} proposal ${displayTitle}`}
            onClick={() => {
              const submissionId = canonicalPortalSubmissionId(submission.id);
              window.localStorage.setItem(editTarget.pointerKey, submissionId);
              window.sessionStorage.setItem(editTarget.activePointerKey, submissionId);
              window.sessionStorage.removeItem(editTarget.newSubmissionIntentKey);
            }}
          >
            {draft ? "Continue proposal" : "Edit proposal"}
          </Link>
        )}
        <Link
          href={`/portal/submissions/${encodeURIComponent(submission.id)}${eventQuery}`}
          aria-label={`View submission status for ${displayTitle}`}
        >
          View submission status <span aria-hidden="true">→</span>
        </Link>
        {accepted ? (
          <Link className={styles.primaryTextLink} href={`/portal${eventQuery}`}>
            Open speaker workspace <span aria-hidden="true">→</span>
          </Link>
        ) : null}
      </footer>
    </article>
  );
}
