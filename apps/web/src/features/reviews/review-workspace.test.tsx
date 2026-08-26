import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ReviewerPage from "../../app/review/page";
import {
  applyReviewAssignments,
  assignmentCompletionPercent,
  buildEvaluationPlanCreateDto,
  createEvaluationPlan,
  createReviewAutosaveQueue,
  type DistributionPreviewInput,
  distributionPreviewKey,
  type EvaluatorAssignment,
  effectiveReviewClosesAt,
  isHumanConfirmedReviewScore,
  loadCreatedOrganizerPlan,
  loadEvaluatorQueue,
  loadOrganizerData,
  loadReminderDeliveryFacts,
  normalizeCompletionPercent,
  OrganizerDetailStatus,
  parseNumericAuthoringValue,
  previewReviewAssignments,
  type ReviewPlanSeed,
  type ReviewRound,
  ReviewWorkspace,
  type RubricCriterion,
  reminderDeliveryForSelection,
  reminderDeliveryMessage,
  reminderRequestPresentation,
  reminderReviewerIdsRequiringSend,
  replaceSingleReviewAssignment,
  reviewerDisplayLabel,
  reviewerIdsForAssignmentTarget,
  reviewerNavigationDisabled,
  reviewerSelectionBlocked,
  reviseEvaluationPlan,
  validateCreateEvaluationPlanForm,
} from "./review-workspace";
import { ReviewNavigation } from "./workspace/evaluator-queue-review-navigation";
import { authoringDateLabel } from "./workspace/model-authoring-date-label";

const organizerEventWorkspace = vi.hoisted(() => ({
  current: null as {
    readonly id: string;
    readonly name: string;
    readonly organizationId: string;
    readonly slug: string;
  } | null,
}));

vi.mock("@/features/admin/organizer-event-workspace", () => ({
  useOrganizerEventId: (fallbackEventId?: string) =>
    organizerEventWorkspace.current?.id ?? fallbackEventId,
  useOrganizerEventWorkspace: () => organizerEventWorkspace.current,
}));

it("formats review authoring summaries in the configured event timezone", () => {
  const localLabel = authoringDateLabel("2026-12-01T07:30:00.000Z", "America/Los_Angeles");
  expect(localLabel).toContain("Nov 30");
  expect(localLabel).not.toContain("Dec 1");
});
it("derives an active plan closing date from its final round", () => {
  expect(
    effectiveReviewClosesAt({
      id: "plan-1",
      eventId: "event-1",
      name: "Review",
      status: "open",
      blindReview: false,
      closesAt: null,
      assignmentRule: {
        reviewsPerSubmission: 1,
        maxAssignmentsPerReviewer: 5,
        autoDistribute: false,
      },
      rounds: [
        {
          id: "round-1",
          name: "Initial",
          sequence: 1,
          opensAt: null,
          closesAt: "2026-10-15T23:59:59.000Z",
          blindReview: false,
          rubric: { id: "rubric-1", name: "Initial", criteria: [] },
        },
        {
          id: "round-2",
          name: "Final",
          sequence: 2,
          opensAt: null,
          closesAt: "2026-11-30T23:59:59.000Z",
          blindReview: false,
          rubric: { id: "rubric-2", name: "Final", criteria: [] },
        },
      ],
      version: 3,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    }),
  ).toBe("2026-11-30T23:59:59.000Z");
});

const workspaceStyles = readFileSync(
  fileURLToPath(new URL("./review-workspace.module.css", import.meta.url)),
  "utf8",
);
const reviewerQueueStyles = readFileSync(
  fileURLToPath(new URL("./workspace/reviewer-queue.module.css", import.meta.url)),
  "utf8",
);

const testCriteria: readonly RubricCriterion[] = [
  {
    id: "audience-impact",
    label: "Audience impact",
    description: "A clear, useful outcome for the event audience.",
    minimum: 1,
    maximum: 5,
    weight: 35,
    required: true,
  },
  {
    id: "clarity",
    label: "Clarity and structure",
    description: "A focused proposal with an understandable arc.",
    minimum: 1,
    maximum: 5,
    weight: 25,
    required: true,
  },
  {
    id: "originality",
    label: "Originality",
    description: "A distinctive point of view.",
    minimum: 1,
    maximum: 5,
    weight: 20,
    required: true,
  },
  {
    id: "feasibility",
    label: "Delivery feasibility",
    description: "The scope can be delivered in the available session.",
    minimum: 1,
    maximum: 5,
    weight: 20,
    required: true,
  },
  {
    id: "recommendation",
    label: "Recommendation",
    description: "Committee recommendation for disposition.",
    minimum: 1,
    maximum: 3,
    weight: 15,
    required: true,
    inputType: "dropdown",
    options: [
      { id: "accept", label: "Accept", value: "accept" },
      { id: "maybe", label: "Maybe", value: "maybe" },
      { id: "reject", label: "Reject", value: "reject" },
    ],
  },
  {
    id: "reviewer-comments",
    label: "Comments",
    description: "Evidence and context for the organizing committee.",
    minimum: 0,
    maximum: 1,
    weight: 1,
    required: false,
    inputType: "free_text",
  },
];

function testPlan(eventId: string): ReviewPlanSeed {
  const round: ReviewRound = {
    id: "round-initial",
    name: "Initial committee review",
    status: "open",
    opensAt: "Aug 10, 2026",
    closesAt: "Aug 18, 2026",
    completionPercent: 67,
    blindReview: true,
    anonymization: "double",
    reviewerPool: { reviewerIds: ["sam-whitfield"], name: "Initial review committee" },
    rubric: { name: "Summit proposal rubric", criteria: testCriteria },
  };
  return {
    planId: "plan-test",
    version: 3,
    decisionBySubmission: {},
    eventId,
    eventName: "Summit 2026",
    planName: "Summit 2026 program committee",
    status: "open",
    opensAt: "Aug 10, 2026",
    closesAt: "Aug 24, 2026",
    blindReview: true,
    assignmentRule: { reviewsPerSubmission: 3, maxAssignmentsPerReviewer: 8 },
    rounds: [
      round,
      {
        ...round,
        id: "round-calibration",
        name: "Calibration and final review",
        status: "scheduled",
        opensAt: "Aug 19, 2026",
        closesAt: "Aug 24, 2026",
        completionPercent: 0,
        reviewerPool: { reviewerIds: [], name: "Final review committee" },
      },
    ],
    aggregates: [
      {
        id: "submission-042",
        reference: "SUB-042",
        title: "Designing resilient public services",
        countedScore: "87.4",
        possibleScore: "100",
        countedReviews: 3,
        expectedReviews: 3,
        conflicts: 0,
        abstentions: 0,
        participants: [
          { id: "priya", displayName: "Priya Raman", role: "Author" },
          { id: "marcus", displayName: "Marcus Okafor", role: "Co-author" },
        ],
      },
      {
        id: "submission-017",
        reference: "SUB-017",
        title: "A practical guide to calm incident response",
        countedScore: "81.2",
        possibleScore: "100",
        countedReviews: 2,
        expectedReviews: 3,
        conflicts: 1,
        abstentions: 1,
        participants: [{ id: "riley", displayName: "Riley Chen", role: "Author" }],
      },
    ],
    submittedReviews: [],
    assignments: [
      {
        id: "assignment-042-sam",
        eventId,
        planId: "plan-test",
        roundId: "round-initial",
        submissionId: "submission-042",
        reviewerId: "sam-whitfield",
        status: "in_progress",
        version: 1,
      },
      {
        id: "assignment-017-sam",
        eventId,
        planId: "plan-test",
        roundId: "round-initial",
        submissionId: "submission-017",
        reviewerId: "sam-whitfield",
        status: "assigned",
        version: 1,
      },
    ],
    progress: {
      totalAssignments: 18,
      assigned: 18,
      inProgress: 4,
      submitted: 12,
      abstained: 1,
      conflicts: 2,
      completionPercent: 67,
      reviewers: [
        {
          reviewerId: "sam-whitfield",
          roundId: "round-initial",
          assigned: 2,
          inProgress: 1,
          submitted: 1,
          abstained: 0,
          outstanding: 1,
          completionPercent: 50,
        },
      ],
    },
  };
}

function testAssignment(eventId: string): EvaluatorAssignment {
  const seed = testPlan(eventId);
  const round = seed.rounds[0];
  if (round === undefined) throw new Error("Test fixture round is missing.");
  return {
    eventId,
    eventName: seed.eventName,
    planId: seed.planId,
    planName: seed.planName,
    reviewVersion: undefined,
    initialScores: {},
    initialResponses: {},
    initialConfirmed: [],
    initialComment: "",
    submittedAt: null,
    id: "assignment-test",
    reference: "SUB-042",
    title: "Designing resilient public services",
    participants: [{ id: "priya", displayName: "Priya Raman", role: "Speaker" }],
    track: "Public services",
    abstract: "A practical session for resilient public services.",
    round,
  };
}

const organizerState = { organizer: testPlan("summit-2026") };
const evaluatorState = { assignment: testAssignment("summit-2026") };
const reviewerQueueState = { queue: [{ assignment: testAssignment("summit-2026") }] };

type MockStateSlot = { value: unknown };
type ResolvedHost = { element: ReactElement; children: unknown };

function hostElements(node: unknown): readonly ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => hostElements(child));
  if (node === null || typeof node !== "object" || !("element" in node)) return [];
  const host = node as ResolvedHost;
  return [host.element, ...hostElements(host.children)];
}
describe("review workspace", () => {
  it("keeps direct human scores confirmed after authoritative hydration", () => {
    expect(
      isHumanConfirmedReviewScore({
        origin: "human",
        humanConfirmedBy: null,
        suggestionStatus: null,
      }),
    ).toBe(true);
    expect(
      isHumanConfirmedReviewScore({
        origin: "ai",
        humanConfirmedBy: "reviewer-1",
        suggestionStatus: "accepted",
      }),
    ).toBe(true);
    expect(
      isHumanConfirmedReviewScore({
        origin: "ai",
        humanConfirmedBy: null,
        suggestionStatus: "pending",
      }),
    ).toBe(false);
  });

  it("keeps numeric authoring edits finite during intermediate input", () => {
    expect(parseNumericAuthoringValue(2, "2.5")).toBe(2.5);
    expect(parseNumericAuthoringValue(2, "")).toBe(2);
    expect(parseNumericAuthoringValue(2, "not-a-number")).toBe(2);

    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "organizer",
        initialState: organizerState,
      }),
    );
    expect(markup).not.toContain("NaN");
  });

  it("labels an empty organizer queue without claiming completion", () => {
    const seed = testPlan("summit-2026");
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "organizer",
        initialState: {
          organizer: {
            ...seed,
            assignments: [],
            aggregates: [],
            progress: {
              ...seed.progress,
              totalAssignments: 0,
              assigned: 0,
              inProgress: 0,
              submitted: 0,
              abstained: 0,
              conflicts: 0,
              completionPercent: 0,
              reviewers: [],
            },
          },
        },
      }),
    );

    expect(markup).toContain("0 submissions in this review plan");
    expect(markup).toContain("0 submissions need attention");
    expect(markup).not.toContain("All assigned reviews submitted");
  });

  it("resolves Sam's persisted reviewer ID to a named progress label", () => {
    expect(
      reviewerDisplayLabel("sam-whitfield", [
        {
          organizationId: "org-1",
          userId: "sam-whitfield",
          email: "sam@example.com",
          name: "Sam Whitfield",
          emailVerified: true,
          status: "active",
          role: "reviewer",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ]),
    ).toBe("Sam Whitfield");
  });
  it("does not expose a raw reviewer ID when directory identity is unavailable", () => {
    expect(reviewerDisplayLabel("reviewer_01JRAWIDENTIFIER", [])).toBe("Reviewer 1");
  });
  it("keeps reviewer navigation disabled until the autosave queue is idle", async () => {
    const pendingStates: boolean[] = [];
    let resolveSave: (() => void) | undefined;
    const deferredSave = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const queue = createReviewAutosaveQueue((pending) => pendingStates.push(pending));
    const saving = queue.enqueue(() => deferredSave);

    expect(queue.isPending()).toBe(true);
    expect(reviewerNavigationDisabled(true, queue.isPending(), false, false)).toBe(true);
    expect(reviewerSelectionBlocked("assignment-a", "assignment-a", "assignment-b")).toBe(true);
    expect(reviewerSelectionBlocked("assignment-a", "assignment-a", null)).toBe(true);
    expect(reviewerSelectionBlocked("assignment-a", "assignment-a", "assignment-a")).toBe(false);

    if (resolveSave === undefined) throw new Error("Expected a deferred autosave resolver.");
    resolveSave();
    await saving;

    expect(queue.isPending()).toBe(false);
    expect(reviewerNavigationDisabled(true, queue.isPending(), false, false)).toBe(false);
    expect(reviewerNavigationDisabled(false, queue.isPending(), false, false)).toBe(true);
    expect(reviewerSelectionBlocked(null, "assignment-a", "assignment-b")).toBe(false);
    expect(pendingStates).toEqual([true, false]);
  });
  it("does not render long authoritative submission references in ordinary reviewer UI", () => {
    const longReference = `submission-${"authoritative-id-".repeat(20)}`;
    const assignment = {
      ...testAssignment("summit-2026"),
      id: longReference,
      reference: longReference,
    };
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        mode: "evaluator",
        initialState: { queue: [{ assignment }] },
      }),
    );

    const visibleText = markup.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
    expect(visibleText).not.toContain(longReference);
    expect(workspaceStyles).toMatch(/\.decisionSummary\s*>\s*\*\s*\{[^}]*min-inline-size:\s*0/u);
  });
  it("keeps the reviewer drawer full-page control on one aligned baseline", () => {
    expect(reviewerQueueStyles).toMatch(
      /\.sheetNavigation\s*\[[^\]]*data-slot="button"[^\]]*\]\s*\{[^}]*align-items:\s*center/u,
    );
    expect(reviewerQueueStyles).toMatch(/\.sheetFullPageIcon\s*\{[^}]*display:\s*block/u);
    expect(reviewerQueueStyles).toMatch(/\.sheetFullPageLabel\s*\{[^}]*align-items:\s*center/u);
  });
  it("makes the default overview a submission-centric review operations surface", () => {
    const plan = testPlan("summit-2026");
    expect(plan.assignments).toHaveLength(2);
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "organizer",
        initialState: { organizer: plan },
      }),
    );

    expect(markup).toContain('role="tab"');
    expect(markup).toContain('data-submission-id="submission-042"');
    expect(markup).toContain('data-review-status="complete"');
    expect(markup).toContain('data-action="manage-reviewers"');
    expect(markup).not.toContain("Current reviewer assignments");
    expect(markup).not.toContain("Unassign");
  });

  it("posts exact authoritative preview and apply requests and invalidates keys when inputs change", async () => {
    const requests: Array<{ input: string; method: string | undefined; body: string | undefined }> =
      [];
    const input: DistributionPreviewInput = {
      roundId: "round-1",
      submissionIds: ["submission-1", "submission-2"],
      reviewerIds: ["reviewer-2", "reviewer-1"],
      expectedVersion: 3,
    };
    const preview = {
      scope: {
        tenantId: "tenant-1",
        eventId: "event-1",
        planId: "plan-test",
        roundId: "round-1",
        planVersion: 3,
      },
      desiredAssignments: [{ submissionId: "submission-1", reviewerId: "reviewer-1" }],
      deficits: [{ submissionId: "submission-2", missingReviewCount: 1, reason: "cap" }],
      exclusions: [
        { submissionId: "submission-2", reviewerId: "reviewer-2", reason: "reviewer_cap" },
      ],
      expectedActiveVersions: [],
      submissionRevisions: [{ submissionId: "submission-1", revision: 4 }],
      fingerprint: "fingerprint-1",
    };
    await previewReviewAssignments(
      "https://api.example",
      "plan-test",
      input,
      async (request, init) => {
        requests.push({ input: String(request), method: init?.method, body: String(init?.body) });
        return new Response(JSON.stringify({ data: preview }), { status: 200 });
      },
    );
    await applyReviewAssignments(
      "https://api.example",
      "plan-test",
      { ...input, fingerprint: preview.fingerprint },
      async (request, init) => {
        requests.push({ input: String(request), method: init?.method, body: String(init?.body) });
        return new Response(
          JSON.stringify({
            data: {
              scope: preview.scope,
              activeAssignments: [],
              supersededAssignments: [],
              history: [],
            },
          }),
          { status: 200 },
        );
      },
    );
    expect(requests).toEqual([
      {
        input: "https://api.example/api/admin/evaluations/plans/plan-test/distribution/preview",
        method: "POST",
        body: JSON.stringify(input),
      },
      {
        input: "https://api.example/api/admin/evaluations/plans/plan-test/distribution/apply",
        method: "POST",
        body: JSON.stringify({ ...input, fingerprint: preview.fingerprint }),
      },
    ]);
    expect(distributionPreviewKey(input)).not.toBe(
      distributionPreviewKey({ ...input, expectedVersion: 4 }),
    );
    expect(distributionPreviewKey(input)).not.toBe(
      distributionPreviewKey({ ...input, reviewerIds: ["reviewer-1"] }),
    );
  });

  it("posts atomic single-assignment replacement and preserves returned lineage", async () => {
    const requests: Array<{ input: string; method: string | undefined; body: string | undefined }> =
      [];
    const replacement = await replaceSingleReviewAssignment(
      "https://api.example",
      "plan-test",
      "assignment-old",
      {
        replacementReviewerId: "reviewer-new",
        expectedVersion: 7,
        reason: "Conflict of interest declared by the assigned reviewer.",
      },
      async (request, init) => {
        requests.push({ input: String(request), method: init?.method, body: String(init?.body) });
        return new Response(
          JSON.stringify({
            data: {
              scope: {
                tenantId: "tenant-1",
                eventId: "event-1",
                planId: "plan-test",
                roundId: "round-1",
                submissionId: "submission-1",
              },
              replacedAssignment: {
                id: "assignment-old",
                status: "superseded",
                predecessorAssignmentId: null,
                successorAssignmentId: "assignment-new",
              },
              successorAssignment: {
                id: "assignment-new",
                status: "assigned",
                predecessorAssignmentId: "assignment-old",
                successorAssignmentId: null,
              },
              activeAssignments: [],
              history: [],
            },
          }),
          { status: 200 },
        );
      },
    );
    expect(replacement.successorAssignment.predecessorAssignmentId).toBe("assignment-old");
    expect(requests).toEqual([
      {
        input:
          "https://api.example/api/admin/evaluations/plans/plan-test/assignments/assignment-old/replace",
        method: "POST",
        body: JSON.stringify({
          replacementReviewerId: "reviewer-new",
          expectedVersion: 7,
          reason: "Conflict of interest declared by the assigned reviewer.",
        }),
      },
    ]);
  });

  it("renders concise reminder status without internal routing identifiers", () => {
    const queued = reminderDeliveryMessage({
      queued: 2,
      facts: [
        {
          runId: "run-1",
          outboxId: "outbox-1",
          providerId: "provider-1",
          status: "queued",
          timestamp: "2026-08-12T10:00:00.000Z",
        },
      ],
    });
    expect(queued).toContain("pending");
    const delivered = reminderDeliveryMessage({
      queued: 1,
      facts: [{ runId: "run-2", status: "delivered", timestamp: "2026-08-12T11:00:00.000Z" }],
    });
    expect(delivered).toContain("delivery confirmed");
    const failed = reminderDeliveryMessage({
      queued: 0,
      facts: [
        {
          outboxId: "outbox-3",
          status: "failed",
          completedAt: "2026-08-12T12:00:00.000Z",
          lastErrorCode: "REQUEST_REJECTED",
        },
      ],
    });
    expect(failed).toContain("delivery failed");
    for (const message of [queued, delivered, failed]) {
      expect(message).not.toMatch(/run-|outbox-|provider-|2026-08-12T/);
    }
  });
  it("reloads durable reminder facts instead of retaining the temporary queued response", async () => {
    const requests: string[] = [];
    const facts = await loadReminderDeliveryFacts(
      "https://api.example/api/admin/evaluations",
      "plan-1",
      async (input) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            facts: [
              {
                outboxId: "outbox-1",
                reviewerId: "reviewer-1",
                roundId: "round-1",
                status: "delivered",
                createdAt: "2026-08-12T10:00:00.000Z",
                updatedAt: "2026-08-12T10:00:01.000Z",
                completedAt: "2026-08-12T10:00:01.000Z",
                lastErrorCode: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    expect(requests).toEqual([
      "https://api.example/api/admin/evaluations/api/admin/evaluations/plans/plan-1/reminders",
    ]);
    expect(facts[0]).toMatchObject({ outboxId: "outbox-1", status: "delivered" });
  });
  it("uses durable selected-reviewer facts for post-send confirmation", () => {
    expect(
      reminderDeliveryForSelection(
        [
          {
            reviewerId: "reviewer-sam",
            roundId: "round-initial",
            status: "delivered",
            completedAt: "2026-08-14T01:01:34.151Z",
          },
          {
            reviewerId: "reviewer-other",
            roundId: "round-initial",
            status: "failed",
          },
        ],
        "round-initial",
        ["reviewer-sam"],
      ),
    ).toContain("delivery confirmed");
  });
  it("skips duplicate reminder sends but keeps terminal failures retryable", () => {
    expect(
      reminderReviewerIdsRequiringSend(
        [
          {
            reviewerId: "reviewer-delivered",
            roundId: "round-initial",
            status: "delivered",
          },
          {
            reviewerId: "reviewer-failed",
            roundId: "round-initial",
            status: "dead-letter",
          },
        ],
        "round-initial",
        ["reviewer-delivered", "reviewer-failed", "reviewer-new"],
      ),
    ).toEqual(["reviewer-failed", "reviewer-new"]);
  });
  it("exposes a machine-readable pending reminder request state", () => {
    expect(reminderRequestPresentation(false)).toEqual({
      ariaBusy: false,
      action: "idle",
    });
    expect(reminderRequestPresentation(true)).toEqual({
      ariaBusy: true,
      action: "pending",
    });
  });
  it("derives the authoritative reviewer set for an assignment target", () => {
    const target = testPlan("summit-2026").assignments[0];
    if (target === undefined) throw new Error("Expected a target assignment.");
    expect(
      reviewerIdsForAssignmentTarget(
        [
          target,
          { ...target, id: "assignment-042-duplicate" },
          { ...target, id: "assignment-042-other", reviewerId: "reviewer-2", status: "submitted" },
          {
            ...target,
            id: "assignment-042-recused",
            reviewerId: "reviewer-3",
            status: "abstained",
          },
          {
            ...target,
            id: "assignment-other-submission",
            submissionId: "submission-017",
            reviewerId: "reviewer-4",
          },
        ],
        target.roundId,
        target.submissionId,
      ),
    ).toEqual(["reviewer-2", target.reviewerId]);
  });
  it("keeps the organizer plan usable while review details load or fail", () => {
    const retry = vi.fn();
    const loadingMarkup = renderToStaticMarkup(
      createElement(OrganizerDetailStatus, {
        loading: true,
        error: null,
        onRetry: retry,
      }),
    );
    const errorMarkup = renderToStaticMarkup(
      createElement(OrganizerDetailStatus, {
        loading: false,
        error: "Aggregate details are temporarily unavailable.",
        onRetry: retry,
      }),
    );

    expect(loadingMarkup).toContain(
      "The plan is usable while aggregate scores and decisions load.",
    );
    expect(loadingMarkup).toContain('role="status"');
    expect(errorMarkup).toContain("Aggregate details are temporarily unavailable.");
    expect(errorMarkup).toContain("Retry review details");
    expect(errorMarkup).toContain('role="alert"');
    const retryTree = OrganizerDetailStatus({
      loading: false,
      error: "Aggregate details are temporarily unavailable.",
      onRetry: retry,
    });
    expect(isValidElement(retryTree)).toBe(true);
    if (!isValidElement(retryTree)) throw new Error("Expected review detail status.");
    const retryButton = (
      retryTree as { props: { children: readonly unknown[] } }
    ).props.children.find(
      (child) =>
        isValidElement(child) &&
        (child.props as Record<string, unknown>).children === "Retry review details",
    );
    expect(isValidElement(retryButton)).toBe(true);
    if (!isValidElement(retryButton)) throw new Error("Expected review detail retry button.");
    const onRetryClick = (retryButton.props as Record<string, unknown>).onClick;
    expect(onRetryClick).toBeTypeOf("function");
    (onRetryClick as () => void)();
    expect(retry).toHaveBeenCalledOnce();
  });
  it("propagates created-plan refresh failures and permits an authoritative retry", async () => {
    const authoritative = testPlan("event-empty");
    const loader = vi
      .fn<typeof loadOrganizerData>()
      .mockRejectedValueOnce(new Error("Authoritative review details are unavailable."))
      .mockResolvedValueOnce(authoritative);

    await expect(
      loadCreatedOrganizerPlan("event-empty", "", authoritative.planId, loader),
    ).rejects.toThrow("Authoritative review details are unavailable.");
    await expect(
      loadCreatedOrganizerPlan("event-empty", "", authoritative.planId, loader),
    ).resolves.toBe(authoritative);
    expect(loader).toHaveBeenNthCalledWith(1, "event-empty", "", authoritative.planId);
    expect(loader).toHaveBeenNthCalledWith(2, "event-empty", "", authoritative.planId);
  });
  it("renders an accessible first-plan form for an organizer event with no plans", () => {
    organizerEventWorkspace.current = {
      id: "87aad17-5e75-4732-9085-65df6b8e9a9b",
      name: "Test Summit Local",
      organizationId: "org-selected",
      slug: "test-summit-local",
    };
    try {
      const markup = renderToStaticMarkup(
        createElement(ReviewWorkspace, {
          eventId: "test-summit-local",
          organizationId: "org-selected",
          mode: "organizer",
          initialState: { organizerPlanMissing: true },
        }),
      );

      expect(markup).toContain("Create the first evaluation plan");
      expect(markup).toContain("Test Summit Local");
      expect(markup).toContain("test-summit-local");
      expect(markup).not.toContain("87aad17-5e75-4732-9085-65df6b8e9a9b");
      expect(markup).toContain("Organizer setup");
      expect(markup).toContain('id="create-plan-name"');
      expect(markup).toContain('for="create-plan-name"');
      expect(markup).toContain('aria-describedby="create-plan-name-description"');
      expect(markup).not.toContain('id="create-plan-rounds"');
      expect(markup).not.toContain('id="create-plan-first-rubric"');
      expect(markup).not.toContain('id="create-plan-first-criterion"');
      expect(markup).not.toContain('id="create-plan-blind-review"');
      expect(markup).not.toContain('id="create-plan-event-id"');
      expect(markup).toContain("Create draft plan");
      expect(markup).toContain("One editable round is created now.");
    } finally {
      organizerEventWorkspace.current = null;
    }
  });

  it("builds the exact canonical DTO for one editable starter round", () => {
    expect(
      buildEvaluationPlanCreateDto({
        eventId: "event-99",
        name: "  Program committee  ",
      }),
    ).toEqual({
      id: "plan-event-99-program-committee",
      eventId: "event-99",
      name: "Program committee",
      blindReview: false,
      closesAt: null,
      assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 5 },
      rounds: [
        {
          id: "round-1",
          name: "Initial review",
          sequence: 1,
          opensAt: null,
          closesAt: null,
          aiTriageEnabled: false,
          blindReview: false,
          anonymization: "none",
          rubric: {
            id: "rubric-1",
            name: "Evaluation rubric",
            criteria: [
              {
                id: "criterion-1-1",
                label: "Overall quality",
                description: "Describe the evidence reviewers should consider.",
                minimum: 1,
                maximum: 5,
                weight: 1,
                required: true,
                inputType: "numeric",
              },
            ],
          },
        },
      ],
    });
  });

  it("posts the canonical DTO through the same-origin gateway and returns the created plan", async () => {
    const input = {
      eventId: "event-empty",
      name: "Program committee",
    };
    const requests: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const responsePlan = { id: "plan-created" };
    const created = await createEvaluationPlan("", input, async (request, init) => {
      requests.push({ input: request, init });
      return new Response(JSON.stringify(responsePlan), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    expect(created).toEqual(responsePlan);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.input).toBe("/api/admin/evaluations/plans");
    expect(request?.init?.method).toBe("POST");
    expect(JSON.parse(String(request?.init?.body))).toEqual(buildEvaluationPlanCreateDto(input));
  });

  it("surfaces canonical API errors when the first plan cannot be created", async () => {
    const input = {
      eventId: "event-empty",
      name: "Program committee",
    };

    await expect(
      createEvaluationPlan(
        "https://api.example",
        input,
        async () =>
          new Response(JSON.stringify({ error: { message: "Plan creation is forbidden." } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    ).rejects.toThrow("Plan creation is forbidden.");
  });

  it("reports client validation errors before a create request", () => {
    expect(
      validateCreateEvaluationPlanForm({
        eventId: "event-1",
        name: " ",
      }),
    ).toBe("Plan name is required.");
    expect(
      validateCreateEvaluationPlanForm({
        eventId: "",
        name: "Plan",
      }),
    ).toBe("Event ID is required.");
  });

  it("does not render demo seed content when no initial state is supplied", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, { eventId: "event-empty", mode: "organizer" }),
    );

    expect(markup).toContain("Loading authoritative evaluation data");
    expect(markup).not.toContain("Summit 2026 program committee");
    expect(markup).not.toContain("Initial committee review");
  });

  it("tolerates legacy reviewer projections without field arrays", () => {
    const plan = {
      ...testPlan("summit-2026"),
      reviewerProjection: {} as NonNullable<ReviewPlanSeed["reviewerProjection"]>,
    };
    expect(() =>
      renderToStaticMarkup(
        createElement(ReviewWorkspace, {
          eventId: "summit-2026",
          mode: "organizer",
          initialState: { organizer: plan },
        }),
      ),
    ).not.toThrow();
  });
  it("renders the overview status, dates, active round, and progress for organizers", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "organizer",
        initialState: organizerState,
      }),
    );

    expect(markup).toContain("Plan overview");
    expect(markup).toContain("Organizer review");
    expect(markup).toContain("Open for review");
    expect(markup).toContain("Initial committee review");
    expect(markup).toContain("Aug 10, 2026");
    expect(markup).toContain("Aug 24, 2026");
    expect(markup).toContain("83%");
    expect(markup).toContain("2 conflicts declared");
    expect(markup).not.toContain("Calibration and final review");
    expect(markup).not.toContain("Blind review");
  });
  it("keeps organizer review navigation scoped to the selected organization", () => {
    organizerEventWorkspace.current = {
      id: "87aad17-5e75-4732-9085-65df6b8e9a9b",
      name: "Summit 2026",
      organizationId: "org-selected",
      slug: "summit-2026",
    };
    try {
      const markup = renderToStaticMarkup(
        createElement(ReviewWorkspace, {
          eventId: "summit-2026",
          mode: "organizer",
          organizationId: "org-selected",
          initialState: organizerState,
        }),
      );

      expect(markup).not.toContain(
        'href="/admin/organizations/org-selected/events/summit-2026/reviews"',
      );
      expect(markup).not.toContain(
        'href="/admin/organizations/org-selected/events/87aad17-5e75-4732-9085-65df6b8e9a9b/reviews"',
      );
      expect(markup).not.toContain('href="/review"');
      expect(markup).not.toContain("Reviewer AI workspace");
      expect(markup).toContain('href="/admin/organizations/org-selected/members?tab=invite"');
      expect(markup).toContain("Invite reviewers");
      expect(markup).toContain("Assignments");

      expect(markup).not.toContain('href="/admin/events/summit-2026/reviews"');
    } finally {
      organizerEventWorkspace.current = null;
    }
  });
  it("builds private review-plan hrefs from canonical event IDs", () => {
    const eventId = "87aad17-5e75-4732-9085-65df6b8e9a9b";
    const eventSlug = "summit-2026";
    const markup = renderToStaticMarkup(
      createElement(ReviewNavigation, {
        eventId,
        mode: "organizer",
        organizationId: "org-selected",
      }),
    );

    expect(markup).toContain(`href="/admin/organizations/org-selected/events/${eventId}/reviews"`);
    expect(markup).not.toContain(eventSlug);
  });

  it("omits redundant reviewer navigation in evaluator mode", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "evaluator",
        initialState: {},
      }),
    );

    expect(markup).not.toContain('aria-label="Reviewer navigation"');
    expect(markup).not.toContain('href="/review"');
  });

  it("keeps plan setup authoring out of the default overview", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "event-empty",
        mode: "organizer",
        initialState: { organizer: testPlan("event-empty") },
      }),
    );

    expect(markup).toContain("Setup");
    expect(markup).not.toContain("Configure the evaluation plan");
    expect(markup).not.toContain("Add round");
    expect(markup).not.toContain("Add criterion");
    expect(markup).not.toContain("Round reviewer pool");
  });

  it("opens draft plans directly in setup", () => {
    const plan = testPlan("event-empty");
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "event-empty",
        mode: "organizer",
        initialState: { organizer: { ...plan, status: "draft" } },
      }),
    );

    expect(markup).toContain("Configure the plan");
    expect(markup).toContain("Add round");
    expect(markup).toContain("Reviews per proposal");
    expect(markup).not.toContain("Plan overview");
  });
  it("renders event-timezone-backed draft plans with null closing dates", () => {
    const seed = testPlan("event-empty");
    const plan: ReviewPlanSeed = {
      ...seed,
      status: "draft",
      closesAt: "—",
      sourceClosesAt: null,
      eventTimeZone: "America/New_York",
      eventStartsAt: "2026-08-01T00:00:00.000Z",
      eventEndsAt: "2026-08-31T23:59:59.000Z",
      rounds: seed.rounds.map((round) => ({ ...round, closesAt: "—" })),
    };
    let markup = "";
    expect(() => {
      markup = renderToStaticMarkup(
        createElement(ReviewWorkspace, {
          eventId: "event-empty",
          mode: "organizer",
          initialState: { organizer: plan },
        }),
      );
    }).not.toThrow();

    expect(markup).toContain("Configure the plan");
    expect(markup).toContain("Editable draft");
    expect(markup).toContain("Overall review deadline");
  });
  it("keeps a valid authoritative closing instant available as a local draft value", () => {
    const seed = testPlan("event-empty");
    const plan: ReviewPlanSeed = {
      ...seed,
      status: "draft",
      closesAt: "Aug 24, 2026",
      sourceClosesAt: "2026-08-24T16:00:00.000Z",
      eventTimeZone: "America/New_York",
      eventStartsAt: "2026-08-01T00:00:00.000Z",
      eventEndsAt: "2026-08-31T23:59:59.000Z",
    };
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "event-empty",
        mode: "organizer",
        initialState: { organizer: plan },
      }),
    );

    expect(markup).toContain('value="12:00"');
  });

  it("keeps round reviewer-pool editing out of plan authoring", () => {
    const targetingSource = readFileSync(
      fileURLToPath(
        new URL("./workspace/organizer-authoring-round-targeting.tsx", import.meta.url),
      ),
      "utf8",
    );

    expect(targetingSource).not.toContain("Round reviewer pool");
    expect(targetingSource).not.toContain("Verified organization reviewers for this round");
  });

  it("keeps assignment and decision detail out of the default overview", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "organizer",
        initialState: organizerState,
      }),
    );

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("6 reviews");
    expect(markup).toContain("2 conflicts declared");
    expect(markup).not.toContain("Reviewer assignment progress");
    expect(markup).not.toContain("Counted aggregate scores");
    expect(markup).not.toContain("Human decisions");
  });
  it("renders aggregate review completion consistently across text, width, and ARIA", () => {
    const plan = testPlan("summit-2026");
    const decimalPlan: ReviewPlanSeed = {
      ...plan,
      rounds: plan.rounds.map((round, index) =>
        index === 0 ? { ...round, completionPercent: 66.66666666666666 } : round,
      ),
      progress: {
        ...plan.progress,
        completionPercent: 66.66666666666666,
        reviewers: plan.progress.reviewers.map((reviewer) => ({
          ...reviewer,
          completionPercent: 66.66666666666666,
        })),
      },
    };
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "organizer",
        initialState: { organizer: decimalPlan },
      }),
    );

    expect(normalizeCompletionPercent(66.66666666666666)).toBe(67);
    expect(markup).toContain("<strong>83%</strong>");
    expect(markup).toContain('aria-valuenow="83"');
    expect(markup).toContain('style="transform:translateX(-17%)"');
  });
  it("derives round completion from the authoritative active assignment projection", () => {
    const base = testPlan("summit-2026").assignments[0];
    if (base === undefined) throw new Error("Expected an assignment fixture.");
    const assignments = [
      { ...base, id: "assignment-1", status: "submitted" as const },
      { ...base, id: "assignment-2", reviewerId: "reviewer-2", status: "submitted" as const },
      { ...base, id: "assignment-3", reviewerId: "reviewer-3", status: "assigned" as const },
      { ...base, id: "assignment-4", reviewerId: "reviewer-4", status: "abstained" as const },
    ];

    expect(assignmentCompletionPercent(assignments, "round-initial")).toBe(67);
    expect(assignmentCompletionPercent(assignments, "round-missing")).toBe(0);
    expect(assignmentCompletionPercent(assignments)).toBe(67);
  });

  it("keeps decision editors closed until an explicit selection", () => {
    const decidedPlan: ReviewPlanSeed = {
      ...testPlan("summit-2026"),
      decisionBySubmission: {
        "submission-042": {
          status: "accepted",
          reason: "The committee approved this proposal.",
          version: 1,
        },
      },
    };

    const organizerMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "organizer",
        initialState: { organizer: decidedPlan },
      }),
    );
    const evaluatorMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "evaluator",
        initialState: evaluatorState,
      }),
    );

    expect(organizerMarkup).toContain("Results");
    expect(organizerMarkup).not.toContain("Confirm human decision");
    expect(organizerMarkup).not.toContain("Written reason");
    expect(organizerMarkup).not.toContain("Review decision");
    expect(evaluatorMarkup).not.toContain('type="number"');
    expect(evaluatorMarkup).toContain('role="radiogroup"');
    expect(evaluatorMarkup).toContain('type="radio"');
  });

  it("keeps evaluator content blind and limited to one assignment", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "evaluator",
        initialState: evaluatorState,
      }),
    );

    expect(markup).toContain('id="review-content"');
    expect(markup).toContain('aria-labelledby="assigned-submission-heading"');
    expect(markup.match(/data-score-anchor=/gu)).toHaveLength(testCriteria.length);
    expect(markup).not.toContain("Riley");
    expect(markup).not.toContain("Create evaluation plan");
    expect(markup).not.toContain('data-reviewer-collection="true"');
  });
  it("does not render account identity fields from blind submission answers", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "evaluator",
        initialState: {
          assignment: {
            ...testAssignment("summit-2026"),
            submissionFields: [
              { id: "email", label: "Email", value: "ada@example.com" },
              { id: "firstName", label: "First name", value: "Ada" },
              { id: "lastName", label: "Last name", value: "Lovelace" },
              { id: "fullName", label: "Full name", value: "Ada Lovelace" },
              { id: "topic", label: "Topic", value: "Accessible systems" },
            ],
          },
        },
      }),
    );

    expect(markup).toContain("Accessible systems");
    expect(markup).not.toContain("ada@example.com");
    expect(markup).not.toContain("<dt>Email</dt>");
    expect(markup).not.toContain("<dt>First name</dt>");
    expect(markup).not.toContain("<dt>Last name</dt>");
    expect(markup).not.toContain("<dt>Full name</dt>");
  });
  it("filters generic reviewer answers to the blind evaluator projection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                assignments: [
                  {
                    plan: {
                      id: "plan-blind",
                      eventId: "summit-2026",
                      name: "Blind review",
                      status: "open",
                      blindReview: true,
                      createdAt: "2026-08-10T00:00:00.000Z",
                      updatedAt: "2026-08-10T01:00:00.000Z",
                    },
                    assignment: {
                      id: "assignment-blind",
                      eventId: "summit-2026",
                      planId: "plan-blind",
                      submissionId: "submission-blind",
                      roundId: "round-blind",
                      reviewerId: "reviewer-1",
                      status: "assigned",
                      version: 1,
                    },
                    round: {
                      id: "round-blind",
                      name: "Blind round",
                      sequence: 1,
                      opensAt: null,
                      closesAt: "2026-08-18T00:00:00.000Z",
                      rubric: {
                        id: "rubric-blind",
                        name: "Blind rubric",
                        criteria: testCriteria,
                      },
                    },
                    submission: {
                      id: "submission-blind",
                      title: "Blind submission",
                      abstract: "Blind abstract",
                      identityRedacted: true,
                      answers: {
                        email: "ada@example.com",
                        firstName: "Ada",
                        lastName: "Lovelace",
                        fullName: "Ada Lovelace",
                        topic: "Accessible systems",
                      },
                    },
                    review: null,
                    suggestions: [],
                  },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    try {
      const queue = await loadEvaluatorQueue(undefined, "https://api.example");
      const assignment = queue[0]?.assignment;
      if (assignment === undefined) throw new Error("Expected a blind evaluator assignment.");
      const markup = renderToStaticMarkup(
        createElement(ReviewWorkspace, {
          eventId: "summit-2026",
          mode: "evaluator",
          initialState: { assignment },
        }),
      );

      expect(markup).toContain("Accessible systems");
      expect(markup).not.toContain("ada@example.com");
      expect(markup).not.toContain("<dt>First name</dt>");
      expect(markup).not.toContain("<dt>Last name</dt>");
      expect(markup).not.toContain("<dt>Full name</dt>");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders only human review controls and requires a written abstention reason", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "evaluator",
        initialState: evaluatorState,
      }),
    );

    expect(markup).not.toContain("Cited evidence");
    expect(markup).not.toContain("Confirm or edit this suggestion");
    expect(markup).toContain("Submission waits for autosave");
    expect(markup).toContain("Submit review");
    expect(markup).not.toContain("Confirm review submission");
    expect(markup).toContain("Declare conflict");
    expect(markup).not.toContain('id="abstention-reason"');
  });

  it("exposes explicit draft state text and per-criterion validation hooks", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "evaluator",
        initialState: evaluatorState,
      }),
    );

    expect(markup).toContain("Autosave ready");
    expect(markup).not.toContain("Save draft");
    expect(markup).toContain("aria-invalid");
    expect(markup).toContain("score-help");
  });
  it("renders a structured, keyboard-ready evaluator workflow", () => {
    const evaluatorMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "evaluator",
        initialState: evaluatorState,
      }),
    );
    const organizerMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "organizer",
        initialState: organizerState,
      }),
    );
    const queueMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        mode: "evaluator",
        initialState: reviewerQueueState,
      }),
    );

    expect(evaluatorMarkup).toContain('aria-labelledby="blind-review-heading"');
    expect(evaluatorMarkup).toContain('data-score-anchor="audience-impact"');
    expect(evaluatorMarkup).toContain('data-reviewer-scorecard-footer="true"');
    expect(queueMarkup).not.toContain("Queue position");
    expect(queueMarkup).toContain('data-reviewer-collection="true"');
    expect(queueMarkup).toContain('data-reviewer-column-headings="true"');
    expect(queueMarkup).toContain('data-reviewer-assignment-id="assignment-test"');
    expect(evaluatorMarkup).not.toContain(">Previous<");
    expect(evaluatorMarkup).not.toContain(">Next<");
    expect(evaluatorMarkup).not.toContain("Evaluation actions");
    expect(evaluatorMarkup).not.toContain("Save draft");
    expect(evaluatorMarkup).toContain('role="radiogroup"');
    expect(evaluatorMarkup).toContain("<fieldset");
    expect(evaluatorMarkup).toContain('aria-live="polite"');
    expect(organizerMarkup).toContain('role="tablist"');
    expect(organizerMarkup).toContain('id="review-tab-setup"');
    expect(organizerMarkup).toContain('id="review-tab-assignments"');
    expect(organizerMarkup).toContain('id="review-tab-decisions"');
    expect(organizerMarkup).not.toContain("criteriaList");
    expect(organizerMarkup).not.toContain("criterionEditor");
    expect(organizerMarkup).not.toContain("criteria authoring</caption>");
  });
  it("keeps advanced controls and evaluator scorecard coverage explicit", () => {
    const organizerMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "organizer",
        initialState: organizerState,
      }),
    );
    const evaluatorMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "evaluator",
        initialState: evaluatorState,
      }),
    );

    expect(organizerMarkup).toContain("Setup");
    expect(organizerMarkup).toContain("Assignments");
    expect(organizerMarkup).toContain("Results");
    expect(organizerMarkup).not.toContain("Round reviewer pool");
    expect(organizerMarkup).not.toContain("Sort aggregate score");
    expect(organizerMarkup).not.toContain("Export review results CSV");
    expect(evaluatorMarkup).toContain("Choose an option");
    expect(evaluatorMarkup).toContain(
      "Written responses are stored with this scorecard criterion.",
    );
    expect(evaluatorMarkup).toContain("Declare conflict");
  });

  it("regresses the old 12-request two-phase baseline (plans 2, progress 2, assignments 2, submissions 2, aggregate 1, decisions 3) to one authoritative workspace request for three submissions", async () => {
    const requests: string[] = [];
    const plan = {
      id: "plan-batch",
      eventId: "summit-2026",
      name: "Batch review",
      status: "open",
      blindReview: false,
      closesAt: "2099-08-20T00:00:00.000Z",
      assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 5 },
      version: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T01:00:00.000Z",
      rounds: [
        {
          id: "round-batch",
          name: "Batch round",
          sequence: 1,
          opensAt: "2026-08-01T00:00:00.000Z",
          closesAt: "2099-08-18T00:00:00.000Z",
          rubric: { id: "rubric-batch", name: "Batch rubric", criteria: testCriteria },
        },
      ],
    };
    const assignments = [
      {
        id: "assignment-a",
        eventId: "summit-2026",
        planId: plan.id,
        roundId: "round-batch",
        submissionId: "submission-a",
        reviewerId: "reviewer-1",
        status: "submitted",
        version: 1,
      },
      {
        id: "assignment-b",
        eventId: "summit-2026",
        planId: plan.id,
        roundId: "round-batch",
        submissionId: "submission-b",
        reviewerId: "reviewer-2",
        status: "in_progress",
        version: 1,
      },
      {
        id: "assignment-c",
        eventId: "summit-2026",
        planId: plan.id,
        roundId: "round-batch",
        submissionId: "submission-c",
        reviewerId: "reviewer-3",
        status: "assigned",
        version: 1,
      },
    ];
    const submissions = [
      { id: "submission-a", title: "Submission A", abstract: "A" },
      { id: "submission-b", title: "Submission B", abstract: "B" },
      { id: "submission-c", title: "Submission C", abstract: "C" },
    ];
    const progress = {
      planId: plan.id,
      total: 3,
      assigned: 1,
      inProgress: 1,
      submitted: 1,
      abstained: 0,
      completionPercent: 100,
      reviewers: [
        {
          reviewerId: "reviewer-1",
          roundId: "round-batch",
          assigned: 1,
          inProgress: 0,
          submitted: 1,
          abstained: 0,
          outstanding: 0,
          completionPercent: 100,
        },
      ],
    };
    const aggregates = [
      {
        planId: plan.id,
        roundId: "round-batch",
        submissionId: "submission-b",
        submittedReviewCount: 2,
        expectedReviewCount: 3,
        averageWeightedTotal: 3,
        possibleWeightedTotal: 5,
      },
      {
        planId: plan.id,
        roundId: "round-batch",
        submissionId: "submission-a",
        submittedReviewCount: 1,
        expectedReviewCount: 1,
        averageWeightedTotal: 4.5,
        possibleWeightedTotal: 5,
      },
      {
        planId: plan.id,
        roundId: "round-batch",
        submissionId: "submission-c",
        submittedReviewCount: 0,
        expectedReviewCount: 1,
        averageWeightedTotal: null,
        possibleWeightedTotal: 5,
      },
    ];
    const decisions = {
      "submission-b": {
        id: "decision-b",
        tenantId: "tenant-test",
        eventId: "summit-2026",
        planId: plan.id,
        submissionId: "submission-b",
        status: "waitlisted",
        version: 2,
        history: [
          {
            from: null,
            to: "waitlisted",
            reason: "Needs a stronger delivery plan.",
            decidedBy: "organizer-1",
            decidedAt: "2026-08-10T02:00:00.000Z",
          },
        ],
        updatedAt: "2026-08-10T02:00:00.000Z",
      },
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify({ data: body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        requests.push(url.toString());
        const path = url.pathname.replace("/api/admin/evaluations", "");
        if (path === "/organizer/workspace") {
          return json({
            event: {
              id: "summit-2026",
              name: "Summit 2026",
              timeZone: "America/Los_Angeles",
              startsAt: "2099-08-01T16:00:00.000Z",
              endsAt: "2099-08-31T23:00:00.000Z",
            },
            plan,
            submissions,
            assignments,
            resultScopes: [
              {
                planId: plan.id,
                planVersion: plan.version,
                planName: plan.name,
                roundId: "round-batch",
                roundName: "Batch round",
                sequence: 1,
                historical: false,
              },
            ],
            submittedReviews: [],
            progress,
            aggregates,
            decisions,
          });
        }
        throw new Error(`Unexpected evaluation request: ${url.toString()}`);
      }),
    );

    try {
      const seed = await loadOrganizerData("summit-2026", "https://api.example");
      const paths = requests.map((request) => new URL(request).pathname);
      const dedicatedPlanRequests = paths.filter((path) => path.endsWith("/plans"));
      const progressRequests = paths.filter((path) => path.endsWith("/progress"));
      const assignmentRequests = paths.filter((path) => path.endsWith("/assignments"));
      const submissionRequests = paths.filter(
        (path) => path.endsWith("/submissions") && !path.includes("/plans/"),
      );
      const aggregateRequests = paths.filter((path) => path.endsWith("/aggregates"));
      const decisionRequests = paths.filter((path) => path.endsWith("/decision"));

      expect(requests).toHaveLength(1);
      expect(requests[0]).toBe(
        "https://api.example/api/admin/evaluations/organizer/workspace?eventId=summit-2026",
      );
      expect(dedicatedPlanRequests).toHaveLength(0);
      expect(progressRequests).toHaveLength(0);
      expect(assignmentRequests).toHaveLength(0);
      expect(submissionRequests).toHaveLength(0);
      expect(aggregateRequests).toHaveLength(0);
      expect(decisionRequests).toHaveLength(0);
      expect(submissions).toHaveLength(3);
      expect(seed.assignments).toEqual(assignments);
      expect(seed.progress).toEqual({
        totalAssignments: 3,
        assigned: 3,
        inProgress: 1,
        submitted: 1,
        abstained: 0,
        conflicts: 0,
        completionPercent: 33,
        reviewers: progress.reviewers,
      });
      expect(seed.rounds[0]?.completionPercent).toBe(33);
      expect(seed.opensAt).toBe("Aug 1, 2026");
      expect(seed.opensAt).not.toBe("Aug 10, 2026");
      expect(seed.decisionBySubmission).toEqual({
        "submission-b": {
          status: "waitlisted",
          reason: "Needs a stronger delivery plan.",
          version: 2,
        },
      });
      expect(seed.aggregates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "submission-a",
            countedScore: "4.5",
            possibleScore: "5.0",
            countedReviews: 1,
            expectedReviews: 1,
          }),
          expect.objectContaining({
            id: "submission-b",
            countedScore: "3.0",
            possibleScore: "5.0",
            countedReviews: 2,
            expectedReviews: 3,
          }),
          expect.objectContaining({
            id: "submission-c",
            countedScore: "—",
            possibleScore: "5.0",
            countedReviews: 0,
            expectedReviews: 1,
          }),
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("maps API-provided submitted assignment state into the reviewer queue from one batch context request", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            data: {
              assignments: [
                {
                  plan: {
                    id: "plan-canonical",
                    eventId: "summit-2026",
                    name: "Canonical review plan",
                    status: "open",
                    blindReview: true,
                    createdAt: "2026-08-10T00:00:00.000Z",
                    updatedAt: "2026-08-10T01:00:00.000Z",
                  },
                  assignment: {
                    id: "assignment-canonical",
                    eventId: "summit-2026",
                    planId: "plan-canonical",
                    submissionId: "submission-canonical",
                    roundId: "round-canonical",
                    reviewerId: "reviewer-1",
                    status: "submitted",
                    version: 2,
                    updatedAt: "2026-08-10T12:00:00.000Z",
                  },
                  round: {
                    id: "round-canonical",
                    name: "Canonical round",
                    sequence: 1,
                    opensAt: null,
                    closesAt: "2026-08-18T00:00:00.000Z",
                    rubric: {
                      id: "rubric-canonical",
                      name: "Canonical rubric",
                      criteria: testCriteria,
                    },
                  },
                  submission: {
                    id: "submission-canonical",
                    title: "Canonical submission title",
                    abstract: "Canonical abstract",
                  },
                  review: null,
                  rubricRevision: 3,
                  submissionRevision: 1,
                  suggestions: [],
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    try {
      const queue = await loadEvaluatorQueue("summit-2026", "");
      const markup = renderToStaticMarkup(
        createElement(ReviewWorkspace, {
          mode: "evaluator",
          initialState: { queue },
        }),
      );

      expect(requests).toEqual(["/api/admin/evaluations/reviewer/workspace?eventId=summit-2026"]);
      expect(requests.some((request) => request.includes("/assignments/"))).toBe(false);
      expect(markup).toContain("Canonical submission title");
      expect(markup).toContain('data-reviewer-collection="true"');
      expect(markup).toContain('data-reviewer-assignment-id="assignment-canonical"');
      expect(markup).toContain('data-assignment-status="submitted"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("keeps reviewer root queue mode free of organizer creation controls", async () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        mode: "evaluator",
        initialState: reviewerQueueState,
      }),
    );
    const pageMarkup = renderToStaticMarkup(await ReviewerPage());

    expect(markup).toContain('data-reviewer-collection="true"');
    expect(markup).toContain('data-reviewer-column-headings="true"');
    expect(markup).toContain('aria-label="Assigned reviews"');
    expect(markup).toContain('data-reviewer-assignment-id="assignment-test"');
    expect(markup).not.toContain("Create evaluation plan");
    expect(markup).not.toContain("/admin/");
    expect(pageMarkup).toContain('id="review-content"');
    expect(pageMarkup).toContain('role="status"');
    expect(pageMarkup).not.toContain("Create evaluation plan");
  });
  it("locks a scorecard and labels its queue entry from authoritative submitted state", () => {
    const submittedAssignment = {
      ...testAssignment("summit-2026"),
      submittedAt: "2026-08-10T12:00:00.000Z",
    };
    const evaluatorMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "evaluator",
        initialState: { assignment: submittedAssignment },
      }),
    );
    const queueMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        mode: "evaluator",
        initialState: { queue: [{ assignment: submittedAssignment }] },
      }),
    );

    expect(evaluatorMarkup).toContain("Review submitted to the committee.");
    expect(evaluatorMarkup).toMatch(/disabled=""/u);
    expect(queueMarkup).toContain("Submitted");
    expect(queueMarkup).toContain('data-assignment-status="submitted"');
  });
  it("does not reopen persisted abstained assignments after reload", () => {
    const abstainedAssignment = {
      ...testAssignment("summit-2026"),
      assignmentStatus: "abstained" as const,
    };
    const scorecardMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        eventId: "summit-2026",
        mode: "evaluator",
        initialState: { assignment: abstainedAssignment },
      }),
    );
    const queueMarkup = renderToStaticMarkup(
      createElement(ReviewWorkspace, {
        mode: "evaluator",
        initialState: { queue: [{ assignment: abstainedAssignment }] },
      }),
    );

    expect(scorecardMarkup).toContain("Assignment abstained");
    expect(scorecardMarkup).not.toContain("Score this submission");
    expect(queueMarkup).toContain("No active reviews");
    expect(queueMarkup).toContain("open for reviewer action");
    expect(queueMarkup).not.toContain("Return to organizer workspace");
    expect(queueMarkup).not.toContain("Start review");
  });
  it("posts a safe editable draft revision request for a grading-locked plan", async () => {
    const requests: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const revision = await reviseEvaluationPlan("", "plan-test", 7, async (input, init) => {
      requests.push({ input, init });
      return new Response(
        JSON.stringify({
          id: "plan-test-revision-7",
          eventId: "summit-2026",
          name: "Summit review revision",
          status: "draft",
          blindReview: true,
          closesAt: null,
          assignmentRule: { reviewsPerSubmission: 3, maxAssignmentsPerReviewer: 8 },
          version: 1,
          createdAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-13T12:00:00.000Z",
          rounds: [],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    expect(revision).toMatchObject({ id: "plan-test-revision-7", status: "draft", version: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("/api/admin/evaluations/plans/plan-test/revise");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ expectedVersion: 7 });
  });
  it("keeps organizer authoring controls safe when React defers event updaters", async () => {
    vi.doUnmock("react");
    vi.resetModules();
    const assignmentRequests: Array<{ readonly url: string; readonly body: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (
        (url.endsWith("/plans/plan-test/distribution/preview") ||
          url.endsWith("/plans/plan-test/distribution/apply")) &&
        init?.method === "POST"
      ) {
        assignmentRequests.push({ url, body: String(init.body) });
        const assignment = {
          id: "assignment-persisted",
          eventId: "event-empty",
          planId: "plan-test",
          roundId: "round-initial",
          submissionId: "submission-042",
          reviewerId: "reviewer-a",
          status: "assigned",
          version: 1,
        };
        const preview = {
          scope: {
            tenantId: "tenant-1",
            eventId: "event-empty",
            planId: "plan-test",
            roundId: "round-initial",
            planVersion: 3,
          },
          desiredAssignments: [{ submissionId: "submission-042", reviewerId: "reviewer-a" }],
          deficits: [],
          exclusions: [],
          expectedActiveVersions: [],
          submissionRevisions: [{ submissionId: "submission-042", revision: 2 }],
          fingerprint: "fingerprint-authoritative",
        };
        return new Response(
          JSON.stringify({
            data: url.endsWith("/preview")
              ? preview
              : {
                  scope: preview.scope,
                  activeAssignments: [assignment],
                  supersededAssignments: [],
                  history: [],
                },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: "Authoritative refresh unavailable in harness." } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    });

    const stateSlots: Array<MockStateSlot | undefined> = [];
    const refSlots: Array<{ current: unknown } | undefined> = [];
    const pendingUpdates: Array<() => void> = [];
    let stateCursor = 0;
    let refCursor = 0;

    const useStateMock = <T,>(initialState: T | (() => T)) => {
      const index = stateCursor;
      stateCursor += 1;
      let slot = stateSlots[index];
      if (slot === undefined) {
        slot = {
          value: typeof initialState === "function" ? (initialState as () => T)() : initialState,
        };
        stateSlots[index] = slot;
      }
      const currentSlot = slot;
      const setState = (next: T | ((current: T) => T)) => {
        pendingUpdates.push(() => {
          const current = currentSlot.value as T;
          currentSlot.value =
            typeof next === "function" ? (next as (current: T) => T)(current) : next;
        });
      };
      return [currentSlot.value as T, setState] as const;
    };
    const useRefMock = <T,>(initialValue: T) => {
      const index = refCursor;
      refCursor += 1;
      let ref = refSlots[index];
      if (ref === undefined) {
        ref = { current: initialValue };
        refSlots[index] = ref;
      }
      return ref as { current: T };
    };
    const useEffectMock = () => undefined;

    try {
      vi.doMock("react", async () => {
        const actualReact = await vi.importActual<typeof import("react")>("react");
        return {
          ...actualReact,
          useCallback: <T,>(callback: T) => callback,
          useEffect: useEffectMock,
          useMemo: <T,>(factory: () => T) => factory(),
          useRef: useRefMock,
          useState: useStateMock,
        };
      });
      vi.doMock("@/features/admin/organizer-event-workspace", () => ({
        useOrganizerEventId: (fallbackEventId?: string) => fallbackEventId,
        useOrganizerEventWorkspace: () => null,
      }));
      vi.doMock("./workspace/organizer-reviewer-pool-controller", () => ({
        useOrganizerReviewerPool: () => ({
          pool: {
            organizationId: "org-1",
            eventId: "event-empty",
            roundId: "round-initial",
            reviewerIds: ["reviewer-a", "reviewer-b"],
            grants: [
              { reviewerId: "reviewer-a", maxAssignments: 8, assignedCount: 0 },
              { reviewerId: "reviewer-b", maxAssignments: 8, assignedCount: 0 },
            ],
            version: 1,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
          draft: { "reviewer-a": 8, "reviewer-b": 8 },
          loading: false,
          saving: false,
          error: null,
          message: null,
          changeReviewer: () => undefined,
          changeMaxAssignments: () => undefined,
          save: async () => undefined,
          reload: () => undefined,
        }),
      }));
      const reviewModule = await import("./review-workspace");
      const draftOrganizerState = testPlan("event-empty");
      let lifecycleStatus: "draft" | "open" = "draft";
      const reviewProps = {
        mode: "organizer" as const,
      };

      function resolveNode(node: unknown): unknown {
        if (Array.isArray(node)) return node.map((child) => resolveNode(child));
        if (!isValidElement(node)) return node;
        const props = node.props as Record<string, unknown>;
        if (typeof node.type === "function") {
          const component = node.type as (props: Record<string, unknown>) => unknown;
          if (component.name.includes("Link")) return resolveNode(props.children);
          return resolveNode(component(props));
        }
        return {
          element: node,
          children: resolveNode(props.children),
        } satisfies ResolvedHost;
      }

      function renderTree(): unknown {
        stateCursor = 0;
        refCursor = 0;
        return resolveNode(
          reviewModule.ReviewWorkspace({
            ...reviewProps,
            initialState: {
              organizer: {
                ...draftOrganizerState,
                status: lifecycleStatus,
              },
            },
          }),
        );
      }
      let findHostCall = 0;

      function findHost(
        tree: unknown,
        predicate: (props: Record<string, unknown>) => boolean,
      ): ReactElement {
        findHostCall += 1;
        const element = hostElements(tree).find((candidate) =>
          predicate(candidate.props as Record<string, unknown>),
        );
        if (element === undefined) {
          throw new Error(`Expected organizer authoring control at lookup ${findHostCall}.`);
        }
        return element;
      }

      function fireChange(
        element: ReactElement,
        target: {
          readonly value: string;
          readonly checked?: boolean;
          readonly selectedOptions?: readonly { readonly value: string }[];
        },
      ): void {
        const props = element.props as Record<string, unknown>;
        const onCheckedChange = props.onCheckedChange;
        if (typeof onCheckedChange === "function") {
          (onCheckedChange as (checked: boolean) => void)(target.checked ?? false);
        } else {
          const onChange = props.onChange;
          const onValueChange = props.onValueChange;
          if (typeof onChange === "function") {
            const event: { currentTarget: unknown | null } = { currentTarget: target };
            (onChange as (event: unknown) => void)(event);
            event.currentTarget = null;
          } else if (typeof onValueChange === "function") {
            (onValueChange as (value: string) => void)(target.value);
          } else {
            throw new Error("Expected a change handler.");
          }
        }
        for (const apply of pendingUpdates.splice(0)) apply();
      }
      async function fireClick(element: ReactElement): Promise<void> {
        const onClick = (element.props as Record<string, unknown>).onClick;
        if (typeof onClick !== "function") throw new Error("Expected a click handler.");
        await (onClick as () => void | Promise<void>)();
        for (const apply of pendingUpdates.splice(0)) apply();
      }

      let tree = renderTree();
      const reviewerMembersSlot = stateSlots[6];
      if (reviewerMembersSlot === undefined) {
        throw new Error("Expected reviewer member state.");
      }
      reviewerMembersSlot.value = [
        {
          organizationId: "org-1",
          userId: "reviewer-a",
          email: "reviewer-a@example.com",
          name: "Reviewer A",
          emailVerified: true,
          status: "active",
          role: "reviewer",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          organizationId: "org-1",
          userId: "reviewer-b",
          email: "reviewer-b@example.com",
          name: "Reviewer B",
          emailVerified: true,
          status: "active",
          role: "reviewer",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ];
      const reviewerMemberFixtures = reviewerMembersSlot.value;
      tree = renderTree();
      const organizerTabs = hostElements(tree).find((element) => {
        const props = element.props as Record<string, unknown>;
        return props.value === "setup" && typeof props.onValueChange === "function";
      });
      if (organizerTabs === undefined) throw new Error("Expected the organizer tab control.");
      fireChange(organizerTabs, { value: "assignments" });
      tree = renderTree();
      findHost(tree, (props) => props.children === "Open the plan before assigning reviewers");
      expect(
        hostElements(tree).some(
          (element) => (element.props as Record<string, unknown>).id === "assignment-submission-id",
        ),
      ).toBe(false);

      fireChange(organizerTabs, { value: "decisions" });
      tree = renderTree();
      findHost(tree, (props) => props.children === "Results are not available yet");
      expect(
        hostElements(tree).some(
          (element) =>
            (element.props as Record<string, unknown>).id === "organizer-aggregate-round",
        ),
      ).toBe(false);
      fireChange(organizerTabs, { value: "setup" });
      tree = renderTree();
      const reviewsPerSubmission = findHost(
        tree,
        (props) => props.id === "evaluation-plan-reviews-per-submission",
      );
      fireChange(reviewsPerSubmission, { value: "2" });
      tree = renderTree();
      expect(
        (
          findHost(tree, (props) => props.id === "evaluation-plan-reviews-per-submission")
            .props as Record<string, unknown>
        ).value,
      ).toBe(2);
      findHost(tree, (props) => props.id === "evaluation-plan-max-assignments-per-reviewer");

      const initialRemoveRoundButtons = hostElements(tree).filter(
        (element) => (element.props as Record<string, unknown>).children === "Remove round",
      );
      const removeCalibrationRound = initialRemoveRoundButtons.at(-1);
      if (removeCalibrationRound === undefined)
        throw new Error("Expected a removable second round.");
      await fireClick(removeCalibrationRound);
      tree = renderTree();
      expect(
        hostElements(tree).some(
          (element) => (element.props as Record<string, unknown>).id === "round-calibration-name",
        ),
      ).toBe(false);
      expect(
        hostElements(tree).some(
          (element) => (element.props as Record<string, unknown>).children === "Remove round",
        ),
      ).toBe(false);

      await fireClick(findHost(tree, (props) => props.children === "Add round"));
      tree = renderTree();
      expect(
        (findHost(tree, (props) => props.id === "round-2-name").props as Record<string, unknown>)
          .value,
      ).toBe("Round 2");
      expect(
        (
          findHost(tree, (props) => props.id === "round-2-track-filter").props as Record<
            string,
            unknown
          >
        ).value,
      ).toBe("");
      findHost(tree, (props) => props["aria-label"] === "Overall quality input type");

      const roundName = hostElements(tree).find(
        (element) => (element.props as Record<string, unknown>).id === "round-initial-name",
      );
      if (roundName === undefined) {
        const visibleIds = hostElements(tree)
          .map((element) => (element.props as Record<string, unknown>).id)
          .filter((id): id is string => typeof id === "string");
        throw new Error(`Expected round authoring control; visible ids: ${visibleIds.join(", ")}`);
      }
      fireChange(roundName, { value: "Final review" });
      tree = renderTree();
      expect(
        (
          findHost(tree, (props) => props.id === "round-initial-name").props as Record<
            string,
            unknown
          >
        ).value,
      ).toBe("Final review");

      const anonymization = findHost(tree, (props) => props.id === "round-initial-anonymization");
      fireChange(anonymization, { value: "single" });
      tree = renderTree();
      expect(
        (
          findHost(tree, (props) => props.id === "round-initial-anonymization").props as Record<
            string,
            unknown
          >
        ).value,
      ).toBe("single");

      const minimum = findHost(tree, (props) => props["aria-label"] === "Audience impact minimum");
      fireChange(minimum, { value: "2.5" });
      tree = renderTree();
      expect(
        (
          findHost(tree, (props) => props["aria-label"] === "Audience impact minimum")
            .props as Record<string, unknown>
        ).value,
      ).toBe(2.5);

      const required = findHost(
        tree,
        (props) => props["aria-label"] === "Audience impact required",
      );
      fireChange(required, { value: "on", checked: false });
      tree = renderTree();
      expect(
        (
          findHost(tree, (props) => props["aria-label"] === "Audience impact required")
            .props as Record<string, unknown>
        ).checked,
        "required criterion state should update safely",
      ).toBe(false);
      const removeInitialRound = hostElements(tree).find(
        (element) => (element.props as Record<string, unknown>).children === "Remove round",
      );
      if (removeInitialRound === undefined)
        throw new Error("Expected the initial round to be removable.");
      await fireClick(removeInitialRound);
      tree = renderTree();
      await fireClick(findHost(tree, (props) => props.children === "Add round"));
      tree = renderTree();
      expect(
        (findHost(tree, (props) => props.id === "round-2-name").props as Record<string, unknown>)
          .value,
      ).toBe("Round 2");
      expect(
        (findHost(tree, (props) => props.id === "round-3-name").props as Record<string, unknown>)
          .value,
      ).toBe("Round 3");
      stateSlots.length = 0;
      refSlots.length = 0;
      pendingUpdates.length = 0;
      lifecycleStatus = "open";
      tree = renderTree();
      const openReviewerMembersSlot = stateSlots[6];
      if (openReviewerMembersSlot === undefined) {
        throw new Error("Expected reviewer member state for the open plan.");
      }
      openReviewerMembersSlot.value = reviewerMemberFixtures;
      tree = renderTree();
      fireChange(
        findHost(
          tree,
          (props) => props.value === "overview" && typeof props.onValueChange === "function",
        ),
        { value: "assignments" },
      );
      tree = renderTree();
      const assignmentSubmission = findHost(
        tree,
        (props) => props.id === "assignment-submission-id",
      );
      const assignmentSubmissionProps = assignmentSubmission.props as Record<string, unknown>;
      expect(assignmentSubmissionProps.style).toBeUndefined();
      expect(assignmentSubmissionProps.className).toEqual(expect.any(String));
      const assignmentSubmissionLabels = hostElements(tree).filter(
        (element) =>
          (element.props as Record<string, unknown>).htmlFor === "assignment-submission-id",
      );
      expect(assignmentSubmissionLabels.length).toBeGreaterThan(0);
      expect(
        isValidElement(
          (assignmentSubmissionLabels[0]?.props as Record<string, unknown> | undefined)?.children,
        ),
        "assignment submission label must not wrap its select",
      ).toBe(false);
      fireChange(assignmentSubmission, { value: "submission-042" });
      tree = renderTree();

      const assignmentReviewerSearch = findHost(
        tree,
        (props) => props.id === "assignment-reviewer-search",
      );
      expect((assignmentReviewerSearch.props as Record<string, unknown>).placeholder).toBe(
        "Name or email",
      );
      const assignmentReviewer = findHost(
        tree,
        (props) => props.id === "assignment-reviewer-reviewer-a",
      );
      const assignmentReviewerLabels = hostElements(tree).filter(
        (element) =>
          (element.props as Record<string, unknown>).htmlFor === "assignment-reviewer-reviewer-a",
      );
      expect(assignmentReviewerLabels.length).toBeGreaterThan(0);
      fireChange(assignmentReviewer, { value: "reviewer-a", checked: true });
      tree = renderTree();
      expect(
        hostElements(tree).some((element) => {
          const children = (element.props as Record<string, unknown>).children;
          return Array.isArray(children)
            ? children.join("") === "1 assignment reviewer selected"
            : children === "1 assignment reviewer selected";
        }),
      ).toBe(true);
      expect(
        hostElements(tree).some(
          (element) => (element.props as Record<string, unknown>).id === "assignment-reviewer-ids",
        ),
      ).toBe(false);

      const previewButton = findHost(tree, (props) => props.children === "Preview assignments");
      expect(
        (previewButton.props as Record<string, unknown>).disabled,
        "distribution preview should be enabled for an open plan",
      ).toBe(false);
      await fireClick(previewButton);
      tree = renderTree();
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/preview"))).toBe(true);

      const applyButton = findHost(tree, (props) => props.children === "Apply assignments");
      expect(
        (applyButton.props as Record<string, unknown>).disabled,
        "distribution apply should enable after a current preview",
      ).toBe(false);
      await fireClick(applyButton);
      tree = renderTree();

      expect(assignmentRequests).toEqual([
        {
          url: "/api/admin/evaluations/plans/plan-test/distribution/preview",
          body: JSON.stringify({
            roundId: "round-initial",
            submissionIds: ["submission-042"],
            reviewerIds: ["reviewer-a"],
            expectedVersion: 3,
          }),
        },
        {
          url: "/api/admin/evaluations/plans/plan-test/distribution/apply",
          body: JSON.stringify({
            roundId: "round-initial",
            submissionIds: ["submission-042"],
            reviewerIds: ["reviewer-a"],
            expectedVersion: 3,
            fingerprint: "fingerprint-authoritative",
          }),
        },
      ]);
    } finally {
      fetchMock.mockRestore();
      vi.doUnmock("react");
      vi.doUnmock("./workspace/organizer-reviewer-pool-controller");
      vi.resetModules();
    }
  });
  it("keeps assignment previews behind the reviewer-pool refresh barrier", async () => {
    vi.doUnmock("react");
    vi.resetModules();
    const stateSlots: Array<{ value: unknown } | undefined> = [];
    const refSlots: Array<{ current: unknown } | undefined> = [];
    let stateCursor = 0;
    let refCursor = 0;
    let assignmentPreview: unknown = null;
    let assignmentPreviewKey: string | null = null;
    let busy = false;
    let message: string | null = null;
    let previewRequest = 0;
    let applyRequest = 0;
    let resolveLatePreview: ((response: Response) => void) | undefined;
    const preview = (fingerprint: string) => ({
      scope: {
        tenantId: "tenant-1",
        eventId: "event-1",
        planId: "plan-1",
        roundId: "round-1",
        planVersion: 3,
      },
      desiredAssignments: [],
      deficits: [],
      exclusions: [],
      expectedActiveVersions: [],
      submissionRevisions: [{ submissionId: "submission-1", revision: 1 }],
      fingerprint,
    });
    let useOrganizerAssignmentActions: typeof import("./workspace/organizer-authoring-assignment-actions").useOrganizerAssignmentActions;
    function renderMockedHook<TOptions, TResult>(
      hook: (options: TOptions) => TResult,
      options: TOptions,
    ): TResult {
      stateCursor = 0;
      refCursor = 0;
      return hook(options);
    }
    function renderAssignmentActionsHarness() {
      return renderMockedHook(useOrganizerAssignmentActions, {
        seed: { planId: "plan-1" },
        baseUrl: "",
        reviewerMembersError: null,
        onAssignmentsPersisted: async () => undefined,
        rounds: [{ id: "round-1" }],
        assignmentRoundId: "round-1",
        assignmentPreview,
        setAssignmentPreview: (next: unknown) => {
          assignmentPreview = next;
        },
        assignmentPreviewKey,
        setAssignmentPreviewKey: (next: string | null) => {
          assignmentPreviewKey = next;
        },
        setMessage: (next: string | null) => {
          message = next;
        },
        assignmentSubmissionId: "submission-1",
        assignmentReviewerIds: ["reviewer-1"],
        assignmentReviewerSelectionMode: "explicit",
        version: 3,
        status: "open",
        setBusy: (next: boolean) => {
          busy = next;
        },
        reviewerIdSet: new Set(["reviewer-1"]),
        reviewerDirectoryReady: true,
      } as never);
    }

    try {
      vi.doMock("react", async () => {
        const actualReact = await vi.importActual<typeof import("react")>("react");
        return {
          ...actualReact,
          useCallback: <T,>(callback: T) => callback,
          useEffect: () => undefined,
          useMemo: <T,>(factory: () => T) => factory(),
          useRef: <T,>(initial: T) => {
            const index = refCursor++;
            let slot = refSlots[index];
            if (slot === undefined) {
              slot = { current: initial };
              refSlots[index] = slot;
            }
            return slot as { current: T };
          },
          useState: <T,>(initial: T) => {
            const index = stateCursor++;
            let slot = stateSlots[index];
            if (slot === undefined) {
              slot = { value: initial };
              stateSlots[index] = slot;
            }
            return [
              slot.value as T,
              (next: T | ((current: T) => T)) => {
                slot.value =
                  typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
              },
            ] as const;
          },
        };
      });
      ({ useOrganizerAssignmentActions } = await import(
        "./workspace/organizer-authoring-assignment-actions"
      ));
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/preview")) {
          previewRequest += 1;
          if (previewRequest === 2) {
            return new Promise<Response>((resolve) => {
              resolveLatePreview = resolve;
            });
          }
          return new Response(JSON.stringify({ data: preview(`fresh-${previewRequest}`) }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/apply")) {
          applyRequest += 1;
          if (applyRequest === 1) {
            return new Response(JSON.stringify({ error: { message: "Preview is stale." } }), {
              status: 409,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              data: {
                scope: preview("unused").scope,
                activeAssignments: [],
                supersededAssignments: [],
                history: [],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      let actions = renderAssignmentActionsHarness();
      await actions.previewAssignments();
      actions = renderAssignmentActionsHarness();
      expect(assignmentPreview).not.toBeNull();

      const latePreview = actions.previewAssignments();
      if (resolveLatePreview === undefined) throw new Error("Expected a pending preview request.");
      expect(actions.blockAssignmentsForReviewerPoolSave()).toBe(false);
      actions = renderAssignmentActionsHarness();
      expect(assignmentPreview).not.toBeNull();
      expect(actions.reviewerPoolSavePending).toBe(false);
      expect(busy).toBe(true);

      await actions.assignReviewers();
      expect(applyRequest).toBe(0);
      resolveLatePreview(
        new Response(JSON.stringify({ error: { message: "Late preview failed." } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
      await actions.previewAssignments();
      actions = renderAssignmentActionsHarness();
      expect(message).toBe("Authoritative reviewer distribution preview loaded.");
      expect(busy).toBe(false);
      await latePreview;
      expect(message).toBe("Authoritative reviewer distribution preview loaded.");
      expect(busy).toBe(false);
      expect(assignmentPreview).not.toBeNull();

      expect(actions.blockAssignmentsForReviewerPoolSave()).toBe(true);
      actions = renderAssignmentActionsHarness();
      expect(actions.reviewerPoolSavePending).toBe(true);
      expect(busy).toBe(true);
      actions.unblockAssignmentsAfterReviewerPoolSave();
      actions = renderAssignmentActionsHarness();
      expect(actions.reviewerPoolSavePending).toBe(false);
      expect(busy).toBe(false);

      await actions.previewAssignments();
      actions = renderAssignmentActionsHarness();
      await actions.assignReviewers();
      expect(message).toBe("Preview is stale.");
      expect(assignmentPreview).not.toBeNull();

      await actions.previewAssignments();
      actions = renderAssignmentActionsHarness();
      await actions.assignReviewers();
      expect(applyRequest).toBe(2);
      expect(assignmentPreview).toBeNull();
      stateSlots.length = 0;
      refSlots.length = 0;
      vi.doMock("../members/api", () => ({
        MemberApiError: Error,
        createMemberApi: () => ({
          getReviewerPool: async () => null,
          setReviewerPool: async () => ({
            organizationId: "org-1",
            eventId: "event-1",
            roundId: "round-1",
            version: 1,
            grants: [],
          }),
        }),
      }));
      const { useOrganizerReviewerPool } = await import(
        "./workspace/organizer-reviewer-pool-controller"
      );
      let reviewerPoolBarrier = false;
      function renderReviewerPool(
        onSaveStart: () => boolean | undefined,
        onSaveFinished: () => void,
      ) {
        return renderMockedHook(useOrganizerReviewerPool, {
          baseUrl: "",
          organizationId: "org-1",
          eventId: "event-1",
          roundId: "round-1",
          reviewers: [],
          defaultMaxAssignments: 1,
          onSaveStart,
          onSaveFinished,
        });
      }
      let reviewerPool = renderReviewerPool(
        () => {
          reviewerPoolBarrier = true;
          throw new Error("Start callback failed.");
        },
        () => {
          reviewerPoolBarrier = false;
        },
      );
      await reviewerPool.save();
      reviewerPool = renderReviewerPool(
        () => {
          reviewerPoolBarrier = true;
          throw new Error("Start callback failed.");
        },
        () => {
          reviewerPoolBarrier = false;
        },
      );
      expect(reviewerPoolBarrier).toBe(false);
      expect(reviewerPool.saving).toBe(false);
      expect(reviewerPool.error).toBe("Start callback failed.");

      reviewerPool = renderReviewerPool(
        () => {
          reviewerPoolBarrier = true;
          return true;
        },
        () => {
          reviewerPoolBarrier = false;
          throw new Error("Finish callback failed.");
        },
      );
      await reviewerPool.save();
      reviewerPool = renderReviewerPool(
        () => {
          reviewerPoolBarrier = true;
          return true;
        },
        () => {
          reviewerPoolBarrier = false;
          throw new Error("Finish callback failed.");
        },
      );
      expect(reviewerPoolBarrier).toBe(false);
      expect(reviewerPool.saving).toBe(false);
      expect(reviewerPool.error).toBe("Finish callback failed.");
    } finally {
      vi.restoreAllMocks();
      vi.doUnmock("react");
      vi.doUnmock("../members/api");
      vi.resetModules();
    }
  });
});
