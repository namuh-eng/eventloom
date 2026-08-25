import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrganizationMember } from "../../members/api";
import type { ApiSubmittedReview } from "./api-api-submitted-review";
import { OrganizerSubmittedReviews } from "./organizer-view-submitted-reviews";

const privateReviewerId = "reviewer-secret-42";
const submittedReview = {
  id: "review-1",
  planId: "plan-1",
  roundId: "round-1",
  submissionId: "submission-1",
  reviewerId: privateReviewerId,
  comment: "Useful reviewer evidence.",
  submittedAt: "2026-08-15T12:00:00.000Z",
} satisfies ApiSubmittedReview;

const authorizedReviewer = {
  organizationId: "org-1",
  userId: privateReviewerId,
  email: "reviewer@example.test",
  name: "Authorized Reviewer",
  emailVerified: true,
  status: "active",
  role: "reviewer",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies OrganizationMember;

function renderEvidence(reviewerMembers: readonly OrganizationMember[]): string {
  return renderToStaticMarkup(
    createElement(OrganizerSubmittedReviews, {
      reviews: [submittedReview],
      reviewerMembers,
    }),
  );
}

describe("OrganizerSubmittedReviews", () => {
  it("renders an authorized human name without exposing the reviewer account ID", () => {
    const markup = renderEvidence([authorizedReviewer]);

    expect(markup).toContain(authorizedReviewer.name);
    expect(markup).toContain(submittedReview.comment);
    expect(markup).not.toContain(privateReviewerId);
  });
  it("hides internal scorecard response markers from organizer comments", () => {
    const markup = renderToStaticMarkup(
      createElement(OrganizerSubmittedReviews, {
        reviews: [
          {
            ...submittedReview,
            comment:
              'Visible recommendation.\\n[scorecard-response id="tooling"]Internal criterion response[/scorecard-response]',
          },
        ],
        reviewerMembers: [authorizedReviewer],
      }),
    );

    expect(markup).toContain("Visible recommendation.");
    expect(markup).not.toContain("scorecard-response");
    expect(markup).not.toContain("Internal criterion response");
  });

  it("uses a private fallback when the member roster is empty or unavailable", () => {
    const markup = renderEvidence([]);

    expect(markup).toContain("Reviewer unavailable");
    expect(markup).not.toContain(privateReviewerId);
  });

  it("uses a private fallback when the submitted reviewer is missing from the roster", () => {
    const markup = renderEvidence([
      {
        ...authorizedReviewer,
        userId: "different-reviewer",
        name: "Different Reviewer",
      },
    ]);

    expect(markup).toContain("Reviewer unavailable");
    expect(markup).not.toContain(privateReviewerId);
    expect(markup).not.toContain(authorizedReviewer.name);
  });
});
