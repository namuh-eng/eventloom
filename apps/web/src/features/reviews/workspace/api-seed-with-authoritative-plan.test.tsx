import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrganizationMember } from "../../members/api";
import type { ApiPlan } from "./api-api-plan";
import type { ApiSubmittedReview } from "./api-api-submitted-review";
import { seedWithAuthoritativePlan } from "./api-seed-with-authoritative-plan";
import type { ReviewPlanSeed } from "./organizer-review-plan-seed";
import { OrganizerSubmittedReviews } from "./organizer-view-submitted-reviews";

const submittedReview = {
  id: "review-1",
  planId: "plan-1",
  roundId: "round-1",
  submissionId: "submission-1",
  reviewerId: "reviewer-1",
  comment: "Strong proposal with clear audience value.",
  submittedAt: "2026-08-15T12:00:00.000Z",
} satisfies ApiSubmittedReview;

const authorizedReviewer = {
  organizationId: "org-1",
  userId: submittedReview.reviewerId,
  email: "reviewer@example.test",
  name: "Authorized Reviewer",
  emailVerified: true,
  status: "active",
  role: "reviewer",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies OrganizationMember;

const seed = {
  planId: "plan-1",
  version: 2,
  decisionBySubmission: {},
  eventId: "event-1",
  eventName: "Summit 2026",
  planName: "Review plan",
  status: "open",
  opensAt: "Aug 10, 2026",
  closesAt: "Aug 20, 2026",
  blindReview: false,
  assignmentRule: {
    reviewsPerSubmission: 1,
    maxAssignmentsPerReviewer: 3,
  },
  rounds: [],
  aggregates: [],
  submittedReviews: [submittedReview],
  assignments: [],
  progress: {
    totalAssignments: 0,
    assigned: 0,
    inProgress: 0,
    submitted: 0,
    abstained: 0,
    conflicts: 0,
    completionPercent: 0,
    reviewers: [],
  },
} satisfies ReviewPlanSeed;

function authoritativePlan(status: ApiPlan["status"], closesAt: string, version: number): ApiPlan {
  return {
    id: seed.planId,
    eventId: seed.eventId,
    name: seed.planName,
    status,
    blindReview: false,
    closesAt,
    assignmentRule: seed.assignmentRule,
    version,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-15T13:00:00.000Z",
    rounds: [
      {
        id: submittedReview.roundId,
        name: "Initial review",
        sequence: 1,
        opensAt: "2026-08-10T00:00:00.000Z",
        closesAt,
        blindReview: false,
        rubric: {
          id: "rubric-1",
          name: "Review rubric",
          criteria: [],
        },
      },
    ],
  };
}

function expectSubmittedEvidencePreserved(plan: ApiPlan): void {
  const result = seedWithAuthoritativePlan(seed, plan);
  const markup = renderToStaticMarkup(
    createElement(OrganizerSubmittedReviews, {
      reviews: result.submittedReviews,
      reviewerMembers: [authorizedReviewer],
    }),
  );

  expect(result.submittedReviews).toEqual([submittedReview]);
  expect(markup).toContain(submittedReview.comment);
  expect(markup).toContain(authorizedReviewer.name);
}

describe("seedWithAuthoritativePlan", () => {
  it("preserves submitted evidence when the authoritative plan closes", () => {
    expectSubmittedEvidencePreserved(authoritativePlan("closed", "2026-08-21T23:59:59.000Z", 3));
  });

  it("preserves submitted evidence when the authoritative closing date changes", () => {
    expectSubmittedEvidencePreserved(authoritativePlan("open", "2026-08-25T23:59:59.000Z", 4));
  });

  it("preserves the latest decision when authoritative plan data refreshes", () => {
    const decision = {
      status: "waitlisted" as const,
      reason: "Capacity is currently full.",
      version: 7,
    };
    const result = seedWithAuthoritativePlan(
      {
        ...seed,
        decisionBySubmission: { "submission-1": decision },
      },
      authoritativePlan("closed", "2026-08-21T23:59:59.000Z", 8),
    );

    expect(result.decisionBySubmission["submission-1"]).toEqual(decision);
  });
});
