"use client";

import Link from "next/link";
import { clearCfpDraftStorage } from "../cfp/draft-persistence";
import { portalSubmissionIdsMatch, submissionStatusPresentation } from "./model";
import styles from "./portal.module.css";
import { usePortal } from "./portal-provider";
import {
  canonicalPortalSubmissionId,
  portalSubmissionActionTargets,
  portalSubmissionDisplayTitle,
} from "./portal-submission-model";
import { EmptyState, PageHeading, PortalContentState, SubmissionStatusBadge } from "./portal-ui";
import { formatPortalDate } from "./portal-ui-model";
import { SubmissionAnswers, SubmissionParticipants } from "./submission-detail-sections";
import type { PortalSubmissionStatus } from "./types";

export { SubmissionAnswers, SubmissionParticipants } from "./submission-detail-sections";

const standardJourney: readonly PortalSubmissionStatus[] = [
  "submitted",
  "under_review",
  "accepted",
];

export function SubmissionDetail({ submissionId }: Readonly<{ submissionId: string }>) {
  return (
    <PortalContentState>
      <SubmissionDetailContent submissionId={submissionId} />
    </PortalContentState>
  );
}

function SubmissionDetailContent({ submissionId }: Readonly<{ submissionId: string }>) {
  const { eventQuery, view, context, can } = usePortal();
  if (!view) return null;
  const submission = view.submissions.find((candidate) =>
    portalSubmissionIdsMatch(candidate.id, submissionId),
  );
  if (!submission) {
    return (
      <EmptyState
        title="Submission not found"
        description="This submission is not available to your account in the selected event."
        action={
          <Link className={styles.secondaryButton} href={`/portal/submissions${eventQuery}`}>
            Back to submissions
          </Link>
        }
      />
    );
  }

  const presentation = submissionStatusPresentation(submission.status);
  const displayTitle = portalSubmissionDisplayTitle(submission, view.submissions);
  const currentJourneyIndex = standardJourney.indexOf(submission.status);
  const actionTargets =
    can("submission-edit") && submission.status !== "accepted"
      ? portalSubmissionActionTargets(context, submission)
      : null;
  const cfpEventSlug = context?.slug?.trim() || context?.eventId.trim() || "";

  return (
    <>
      <Link className={styles.backLink} href={`/portal/submissions${eventQuery}`}>
        <span aria-hidden="true">←</span> All submissions
      </Link>
      <PageHeading
        eyebrow="Proposal status"
        title={displayTitle}
        description="The latest persisted proposal status and any accepted-speaker requirements."
        action={<SubmissionStatusBadge status={submission.status} />}
      />
      {actionTargets === null ? null : (
        <div className={styles.headingAction}>
          <Link
            className={styles.primaryButton}
            href={actionTargets.editHref}
            onClick={() => {
              const submissionId = canonicalPortalSubmissionId(submission.id);
              window.localStorage.setItem(actionTargets.pointerKey, submissionId);
              window.sessionStorage.setItem(actionTargets.activePointerKey, submissionId);
              window.sessionStorage.removeItem(actionTargets.newSubmissionIntentKey);
            }}
          >
            Edit proposal
          </Link>
          <Link
            className={styles.secondaryButton}
            href={actionTargets.newProposalHref}
            onClick={() => {
              if (context === null || cfpEventSlug.length === 0) return;
              const submissionId = canonicalPortalSubmissionId(submission.id);
              if (window.localStorage.getItem(actionTargets.pointerKey) === submissionId) {
                window.localStorage.removeItem(actionTargets.pointerKey);
              }
              clearCfpDraftStorage(cfpEventSlug, window.localStorage);
              window.sessionStorage.removeItem(actionTargets.activePointerKey);
              window.sessionStorage.setItem(actionTargets.newSubmissionIntentKey, "1");
            }}
          >
            Submit another proposal
          </Link>
        </div>
      )}

      <section className={`${styles.panel} ${styles.statusHero}`}>
        <div
          className={`${styles.statusMark} ${styles[`tone_${presentation.tone}`]}`}
          aria-hidden="true"
        >
          {submission.status === "accepted" ? "✓" : "i"}
        </div>
        <div>
          <p className={styles.eyebrow}>Current status</p>
          <h2>{presentation.label}</h2>
          <p>{presentation.description}</p>
          <small>
            {submission.version === undefined ? "" : `Revision ${submission.version} · `}
            Last updated {formatPortalDate(submission.updatedAt) ?? "recently"}
          </small>
        </div>
      </section>

      {submission.status === "declined" || submission.status === "withdrawn" ? null : (
        <section className={styles.panel} aria-labelledby="status-progress-heading">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.eyebrow}>Program workflow</p>
              <h2 id="status-progress-heading">Status progress</h2>
            </div>
          </div>
          <ol className={styles.statusTimeline}>
            {standardJourney.map((status, index) => {
              const statusPresentation = submissionStatusPresentation(status);
              const isCurrent = submission.status === status;
              const complete = currentJourneyIndex > index;
              return (
                <li
                  key={status}
                  data-current={isCurrent || undefined}
                  data-complete={complete || undefined}
                >
                  <span aria-hidden="true">{complete ? "✓" : index + 1}</span>
                  <div>
                    <strong>{statusPresentation.label}</strong>
                    <p>{statusPresentation.description}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {submission.answers ? <SubmissionAnswers answers={submission.answers} /> : null}
      {submission.participants ? (
        <SubmissionParticipants participants={submission.participants} />
      ) : null}

      {submission.status === "accepted" ? (
        <section className={styles.panel} aria-labelledby="accepted-tasks-heading">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.eyebrow}>Accepted speaker checklist</p>
              <h2 id="accepted-tasks-heading">My tasks</h2>
            </div>
          </div>
          <p>Tasks are organized by their current participant or program-session assignment.</p>
          {can("task-response") ? (
            <Link href={`/portal/tasks${eventQuery}`}>Open My tasks</Link>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
