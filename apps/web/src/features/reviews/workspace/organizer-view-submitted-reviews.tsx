"use client";

import { Badge } from "../../../components/ui/badge";
import type { OrganizationMember } from "../../members/api";
import styles from "../review-workspace.module.css";
import type { ApiSubmittedReview } from "./api-api-submitted-review";
import { parseScorecardResponses } from "./scorecard-parse-scorecard-responses";

function reviewerLabel(reviewerId: string, reviewerMembers: readonly OrganizationMember[]): string {
  const reviewer = reviewerMembers.find((member) => member.userId === reviewerId);
  return reviewer?.name?.trim() || reviewer?.email || "Reviewer unavailable";
}

export function OrganizerSubmittedReviews({
  reviews,
  reviewerMembers,
}: Readonly<{
  reviews: readonly ApiSubmittedReview[];
  reviewerMembers: readonly OrganizationMember[];
}>) {
  return (
    <section
      className={styles.reviewEvidence}
      aria-labelledby="submitted-review-comments-heading"
      data-review-evidence="submitted"
    >
      <div className={styles.reviewEvidenceHeading}>
        <div>
          <p className={styles.sectionEyebrow}>Reviewer evidence</p>
          <h3 id="submitted-review-comments-heading">Submitted reviewer comments</h3>
        </div>
        <Badge variant="outline">
          {reviews.length} submitted review{reviews.length === 1 ? "" : "s"}
        </Badge>
      </div>
      <p className={styles.reviewEvidenceSummary}>
        These submitted comments support the counted score above. Draft reviewer notes stay private
        until submission.
      </p>
      {reviews.length === 0 ? (
        <p className={styles.reviewEvidenceEmpty}>No submitted reviewer comments for this round.</p>
      ) : (
        <ol className={styles.reviewEvidenceList}>
          {reviews.map((review, index) => (
            <li className={styles.reviewEvidenceItem} key={review.id}>
              <div className={styles.reviewEvidenceMeta}>
                <strong>{reviewerLabel(review.reviewerId, reviewerMembers)}</strong>
                <span>Review {index + 1}</span>
              </div>
              <p>{parseScorecardResponses(review.comment).comment || "No comment provided."}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
