import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewDataNotice,
  SubmissionDetailWorkspace,
  SubmissionListWorkspace,
} from "./submission-workspace";
import {
  createEvaluationDecisionAttempt,
  DECISION_COMMITTED_WITHOUT_DELIVERY_MESSAGE,
  decisionAttemptMatches,
  decisionNotificationSummary,
  type EvaluationDecisionRecord,
  enrichCanonicalSubmission,
  getAcceptedHandoffMetadata,
  indexOrganizerEvaluationWorkspace,
  initialOrganizerEventName,
  loadCanonicalSubmissionList,
  loadOrganizerEvaluationWorkspace,
  loadOrganizerEventIdentity,
  loadOrganizerEventName,
  mapCanonicalSubmission,
  mergeCanonicalSubmissionEvaluation,
  type OrganizerEvaluationWorkspace,
  reconcileEvaluationDecisionFailure,
  submissionListState,
  submissionLoadErrorMessage,
  submissionLoadFailure,
} from "./submission-workspace-model";

describe("review data notices", () => {
  it("treats a missing plan as setup guidance instead of a retryable error", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewDataNotice, {
        state: {
          status: "no_plan",
          message: "No evaluation plan is configured for this event.",
        },
        onRetry: vi.fn(),
        setupHref: "/admin/organizations/org/events/summit/reviews",
      }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Set up review plan");
    expect(markup).toContain('href="/admin/organizations/org/events/summit/reviews"');
    expect(markup).not.toContain("Retry review data");
  });

  it("keeps retry available for a genuine review-data failure", () => {
    const markup = renderToStaticMarkup(
      createElement(ReviewDataNotice, {
        state: {
          status: "unavailable",
          message: "Review data is temporarily unavailable.",
        },
        onRetry: vi.fn(),
      }),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Retry review data<\/button>/u);
    expect(markup).not.toContain("Set up review plan");
  });
});

const canonicalEnvelope = {
  submission: {
    id: "submission-devflow-1",
    tenantId: "tenant-devflow",
    eventId: "devflow-conf-2027",
    formId: "main-cfp",
    ownerAccountId: "speaker-account",
    formVersion: 4,
    version: 1,
    status: "submitted" as const,
    completedSteps: ["welcome", "account", "submission", "participant", "review"],
    answers: {
      title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
      abstract:
        "Our monorepo CI took 40 minutes on a good day. This talk walks through how we cut it to 6 minutes.",
      format: "workshop",
      track: "platform",
      topics: ["accessibility", "reliability"],
      workshopAudience: "Staff engineers and platform teams.",
    },
    participants: [
      {
        id: "participant-priya",
        firstName: "Priya",
        lastName: "Raman",
        email: "sbek-speaker@example.com",
        role: "primary" as const,
        biography: "Priya's canonical biography.",
        answers: {
          participantType: "company",
          participantCompany: "Latticework Systems",
        },
      },
      {
        id: "participant-marcus",
        firstName: "Marcus",
        lastName: "Okafor",
        email: "sbek-speaker2@example.com",
        role: "co_speaker" as const,
        biography: "Marcus's canonical biography.",
        answers: { participantType: "individual" },
      },
    ],
    secondaryContacts: [],
    createdAt: "2027-01-02T11:00:00.000Z",
    updatedAt: "2027-01-02T12:00:00.000Z",
    submittedAt: "2027-01-02T12:00:00.000Z",
    reopenedAt: null,
  },
  submissionFields: [
    { key: "title", label: "Session title" },
    { key: "abstract", label: "Abstract" },
    {
      key: "format",
      label: "Session format",
      options: [{ value: "workshop", label: "Workshop" }],
    },
    {
      key: "track",
      label: "Track",
      options: [{ value: "platform", label: "Platform & Infra" }],
    },
    {
      key: "topics",
      label: "Topics",
      options: [
        { value: "accessibility", label: "Accessibility" },
        { value: "reliability", label: "Reliability" },
      ],
    },
    { key: "workshopAudience", label: "Workshop audience" },
  ],
  participantFields: [
    { key: "firstName", label: "First name" },
    { key: "lastName", label: "Last name" },
    { key: "email", label: "Email" },
    {
      key: "participantType",
      label: "Participant type",
      options: [
        { value: "company", label: "Company" },
        { value: "individual", label: "Individual" },
      ],
    },
    { key: "participantCompany", label: "Company" },
    { key: "biography", label: "Biography" },
  ],
} as const;

describe("organizer submission workspace", () => {
  it("formats durable decision notification delivery evidence", () => {
    expect(
      decisionNotificationSummary({
        state: "delivered",
        completedAt: "2026-08-13T20:00:00.000Z",
      }),
    ).toContain("Decision notification delivered");
  });

  describe("decision retries", () => {
    const attempt = {
      status: "accepted" as const,
      reason: "Committee consensus",
      idempotencyKey: "web-decision-committed",
    };
    const committedDecision = {
      id: "decision-1",
      tenantId: "tenant-1",
      eventId: "event-1",
      planId: "plan-1",
      submissionId: "submission-1",
      status: "accepted" as const,
      version: 1,
      history: [
        {
          from: null,
          to: "accepted" as const,
          reason: attempt.reason,
          decidedBy: "organizer-1",
          decidedAt: "2027-01-03T12:00:00.000Z",
          idempotencyKey: attempt.idempotencyKey,
        },
      ],
      updatedAt: "2027-01-03T12:00:00.000Z",
    } satisfies EvaluationDecisionRecord;

    it("reconciles a committed decision into visible history", () => {
      expect(
        reconcileEvaluationDecisionFailure(committedDecision, attempt, "Gateway failed"),
      ).toEqual({
        status: "committed",
        decision: committedDecision,
        message: DECISION_COMMITTED_WITHOUT_DELIVERY_MESSAGE,
      });
    });
    const [committedTransition] = committedDecision.history;
    if (committedTransition === undefined) throw new Error("Expected a committed transition.");

    it("retains the original error when reconciliation has no matching transition", () => {
      expect(
        reconcileEvaluationDecisionFailure(
          {
            ...committedDecision,
            history: [{ ...committedTransition, reason: "A different reason" }],
          },
          attempt,
          "Gateway failed",
        ),
      ).toEqual({ status: "retry", error: "Gateway failed" });
      expect(reconcileEvaluationDecisionFailure(undefined, attempt, "Gateway failed")).toEqual({
        status: "retry",
        error: "Gateway failed",
      });
    });

    it("reuses a key for the same trimmed payload", () => {
      const randomUuid = vi.spyOn(globalThis.crypto, "randomUUID");
      randomUuid.mockReturnValueOnce("attempt-1");

      const first = createEvaluationDecisionAttempt("accepted", "  Committee consensus  ");
      const retry = createEvaluationDecisionAttempt("accepted", "Committee consensus", first);

      expect(first.idempotencyKey).toBe("web-decision-attempt-1");
      expect(retry).toBe(first);
      expect(decisionAttemptMatches(retry, "accepted", " Committee consensus ")).toBe(true);
      randomUuid.mockRestore();
    });

    it("rotates the key after a payload change", () => {
      const randomUuid = vi.spyOn(globalThis.crypto, "randomUUID");
      randomUuid.mockReturnValueOnce("attempt-1").mockReturnValueOnce("attempt-2");

      const first = createEvaluationDecisionAttempt("accepted", "Committee consensus");
      const changed = createEvaluationDecisionAttempt("accepted", "A changed reason", first);

      expect(first.idempotencyKey).toBe("web-decision-attempt-1");
      expect(changed.idempotencyKey).toBe("web-decision-attempt-2");
      randomUuid.mockRestore();
    });

    it("does not describe an ambiguous commit as queued notification delivery", () => {
      const reconciliation = reconcileEvaluationDecisionFailure(
        committedDecision,
        attempt,
        "Gateway failed",
      );
      if (reconciliation.status !== "committed")
        throw new Error("Expected committed reconciliation.");
      expect(reconciliation.message).toContain("notification/session delivery was not confirmed");
      expect(reconciliation.message).not.toMatch(/queued/u);
    });
  });

  it("distinguishes loading, failure, unconfigured, empty, and filtered states", () => {
    expect(
      submissionListState({
        loading: true,
        loadFailure: null,
        submissionCount: 0,
        visibleCount: 0,
      }),
    ).toBe("loading");
    expect(
      submissionListState({
        loading: false,
        loadFailure: { kind: "failure", message: "Gateway unavailable" },
        submissionCount: 0,
        visibleCount: 0,
      }),
    ).toBe("failure");
    expect(
      submissionListState({
        loading: false,
        loadFailure: {
          kind: "unconfigured",
          message: "Submission intake is not configured for this event.",
        },
        submissionCount: 0,
        visibleCount: 0,
      }),
    ).toBe("unconfigured");
    expect(
      submissionListState({
        loading: false,
        loadFailure: null,
        submissionCount: 0,
        visibleCount: 0,
      }),
    ).toBe("empty");
    expect(
      submissionListState({
        loading: false,
        loadFailure: null,
        submissionCount: 2,
        visibleCount: 0,
      }),
    ).toBe("filtered_empty");

    const markup = renderToStaticMarkup(
      createElement(SubmissionListWorkspace, {
        eventId: "event-with-no-submissions",
        organizationId: "org-1",
      }),
    );
    expect(markup).toContain("Loading submissions");
    expect(markup).not.toContain("No submissions yet");
    expect(markup).not.toContain('id="submission-search"');
    expect(markup).not.toContain("<table");
  });

  it("explains a missing CFP record without claiming the event is missing", () => {
    expect(submissionLoadFailure(404, "The event was not found.")).toEqual({
      kind: "unconfigured",
      message: "Submission intake is not configured for this event.",
    });
    expect(submissionLoadFailure(503, "Gateway unavailable")).toEqual({
      kind: "failure",
      message: "Gateway unavailable",
    });
    expect(submissionLoadErrorMessage(404, "The event was not found.")).toBe(
      "Submission intake is not configured for this event.",
    );
    expect(submissionLoadErrorMessage(503, "Gateway unavailable")).toBe("Gateway unavailable");
  });

  it("maps the exact canonical fields, edited values, and every co-speaker", () => {
    const record = mapCanonicalSubmission(canonicalEnvelope);

    expect(record).toMatchObject({
      id: "submission-devflow-1",
      title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
      track: "Platform & Infra",
      format: "Workshop",
      abstract:
        "Our monorepo CI took 40 minutes on a good day. This talk walks through how we cut it to 6 minutes.",
    });
    expect(record.reviewData).toEqual({ status: "pending" });
    expect(record.answers).toEqual([
      {
        question: "Session title",
        answer: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
      },
      {
        question: "Abstract",
        answer:
          "Our monorepo CI took 40 minutes on a good day. This talk walks through how we cut it to 6 minutes.",
      },
      { question: "Session format", answer: "Workshop" },
      { question: "Track", answer: "Platform & Infra" },
      { question: "Topics", answer: "Accessibility, Reliability" },
      { question: "Workshop audience", answer: "Staff engineers and platform teams." },
    ]);
    expect(record.participants).toMatchObject([
      {
        name: "Priya Raman",
        role: "Speaker",
        organization: "Latticework Systems",
        biography: "Priya's canonical biography.",
        answers: {
          "First name": "Priya",
          "Last name": "Raman",
          Email: "sbek-speaker@example.com",
          "Participant type": "Company",
          Company: "Latticework Systems",
          Biography: "Priya's canonical biography.",
        },
      },
      {
        name: "Marcus Okafor",
        role: "Co-speaker",
        organization: "",
        biography: "Marcus's canonical biography.",
        answers: {
          "First name": "Marcus",
          "Last name": "Okafor",
          Email: "sbek-speaker2@example.com",
          "Participant type": "Individual",
          Company: "—",
          Biography: "Marcus's canonical biography.",
        },
      },
    ]);

    const editedAbstract = "Updated: the session now includes the canonical 2027 benchmark data.";
    const editedRecord = mapCanonicalSubmission({
      ...canonicalEnvelope,
      submission: {
        ...canonicalEnvelope.submission,
        version: 2,
        updatedAt: "2027-01-03T12:00:00.000Z",
        answers: { ...canonicalEnvelope.submission.answers, abstract: editedAbstract },
      },
    });
    expect(editedRecord.abstract).toBe(editedAbstract);
    expect(editedRecord.answers).toContainEqual({
      question: "Abstract",
      answer: editedAbstract,
    });
  });
  it("reads canonical answers stored under immutable field ids after form revisions", () => {
    const submissionFields = canonicalEnvelope.submissionFields.map((definition) => ({
      ...definition,
      id: `field-${definition.key}`,
    }));
    const participantFields = canonicalEnvelope.participantFields.map((definition) => ({
      ...definition,
      id: `field-${definition.key}`,
    }));
    const answers = Object.fromEntries(
      Object.entries(canonicalEnvelope.submission.answers).map(([key, value]) => [
        `field-${key}`,
        value,
      ]),
    );
    const participants = canonicalEnvelope.submission.participants.map((participant) => ({
      ...participant,
      answers: Object.fromEntries(
        Object.entries(participant.answers).map(([key, value]) => [`field-${key}`, value]),
      ),
    }));

    const record = mapCanonicalSubmission({
      ...canonicalEnvelope,
      submission: {
        ...canonicalEnvelope.submission,
        answers,
        participants,
      },
      submissionFields,
      participantFields,
    });

    expect(record).toMatchObject({
      title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
      abstract:
        "Our monorepo CI took 40 minutes on a good day. This talk walks through how we cut it to 6 minutes.",
      track: "Platform & Infra",
      format: "Workshop",
    });
    expect(record.participants[0]?.organization).toBe("Latticework Systems");
  });

  it("uses No title instead of an internal identifier for untitled submissions", () => {
    const untitledEnvelope: Parameters<typeof mapCanonicalSubmission>[0] = {
      ...canonicalEnvelope,
      submission: {
        ...canonicalEnvelope.submission,
        answers: {
          ...canonicalEnvelope.submission.answers,
          title: "",
        },
      },
    };
    const record = mapCanonicalSubmission(untitledEnvelope);
    const opaqueRecord = mapCanonicalSubmission({
      ...untitledEnvelope,
      submission: {
        ...untitledEnvelope.submission,
        answers: {
          ...untitledEnvelope.submission.answers,
          title: untitledEnvelope.submission.id,
        },
      },
    });

    expect(record.title).toBe("No title");
    expect(record.title).not.toBe(canonicalEnvelope.submission.id);
    expect(opaqueRecord.title).toBe("No title");
  });

  it("loads the authoritative event name instead of presenting a raw event UUID", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: { name: "Forward Summit 2028" } }));

    try {
      await expect(
        loadOrganizerEventName("", "organization-1", "82b23d61-c2f8-4f6b-a89a-9bba98c3555c"),
      ).resolves.toBe("Forward Summit 2028");
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/cfp/organizations/organization-1/events/82b23d61-c2f8-4f6b-a89a-9bba98c3555c/config",
        expect.objectContaining({ credentials: "include", cache: "no-store" }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps an authoritative public slug separate from the event id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          id: "evt_01JXYZ",
          name: "DevFlow Conference",
          slug: "devflow-conf-2027",
        },
      }),
    );
    try {
      await expect(loadOrganizerEventIdentity("", "organization-1", "evt_01JXYZ")).resolves.toEqual(
        {
          name: "DevFlow Conference",
          slug: "devflow-conf-2027",
        },
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/cfp/organizations/organization-1/events/evt_01JXYZ/config",
        expect.objectContaining({ credentials: "include", cache: "no-store" }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("uses the assigned Initial Review aggregate instead of an empty future round", async () => {
    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/organizer/workspace?eventId=")) {
        return Response.json({
          data: {
            plan: {
              id: "plan-1",
              rounds: [
                { id: "round-initial", sequence: 1 },
                { id: "round-final", sequence: 2 },
              ],
            },
            resultScopes: [
              {
                planId: "plan-1",
                planVersion: 1,
                lineageOrdinal: 0,
                planName: "Taming",
                roundId: "round-initial",
                roundName: "Initial Review",
                sequence: 1,
                historical: false,
              },
              {
                planId: "plan-1",
                planVersion: 1,
                lineageOrdinal: 0,
                planName: "Taming",
                roundId: "round-final",
                roundName: "Final Review",
                sequence: 2,
                historical: false,
              },
            ],
            assignments: [
              {
                id: "assignment-1",
                planId: "plan-1",
                reviewerId: "reviewer-1",
                submissionId: "submission-devflow-1",
                roundId: "round-initial",
                status: "submitted",
              },
            ],
            decisions: {},
            aggregates: [
              {
                planId: "plan-1",
                submissionId: "submission-devflow-1",
                roundId: "round-initial",
                submittedReviewCount: 1,
                expectedReviewCount: 1,
                averageWeightedTotal: 11,
                possibleWeightedTotal: 20,
              },
              {
                planId: "plan-1",
                submissionId: "submission-devflow-1",
                roundId: "round-final",
                submittedReviewCount: 0,
                expectedReviewCount: 1,
                averageWeightedTotal: null,
                possibleWeightedTotal: 0,
              },
            ],
          },
        });
      }
      if (url.endsWith("/reviews")) {
        return Response.json({
          data: {
            reviews: [
              {
                planId: "plan-1",
                roundId: "round-initial",
                assignmentId: "assignment-1",
                submissionId: "submission-devflow-1",
                comment: "Ready for the committee.",
                scores: {
                  overall_rating: { value: 4 },
                  recommendation: { value: "accept" },
                },
              },
            ],
          },
        });
      }
      if (url === "/api/admin/organizations/organization-1/members") {
        return Response.json([
          {
            organizationId: "organization-1",
            userId: "reviewer-1",
            email: "sam@example.test",
            name: "Sam Whitfield",
            emailVerified: true,
            status: "active",
            role: "reviewer",
            createdAt: "2026-08-13T00:00:00.000Z",
            updatedAt: "2026-08-13T00:00:00.000Z",
          },
        ]);
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    try {
      const submission = await enrichCanonicalSubmission("", canonicalEnvelope, "organization-1");
      expect(submission).toMatchObject({
        id: "submission-devflow-1",
        title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
        evaluationPlanId: "plan-1",
        reviewSummary: { completed: 1, total: 1, averageScore: 11, maxScore: 20 },
        reviewAssignments: [
          {
            reviewer: "Sam Whitfield",
            status: "complete",
            criterionScores: [
              { criterion: "Overall Rating", value: 4 },
              { criterion: "Recommendation", value: "accept" },
            ],
            comment: "Ready for the committee.",
          },
        ],
      });
      expect(requests).toHaveLength(3);

      expect(requests).toContain("/api/admin/organizations/organization-1/members");
      expect(requests.filter((request) => request.includes("/organizer/workspace"))).toHaveLength(
        1,
      );
      expect(requests).toContain(
        "/api/admin/evaluations/plans/plan-1/rounds/round-initial/submissions/submission-devflow-1/reviews",
      );
      expect(requests.some((request) => request.includes("/plans?eventId="))).toBe(false);
      expect(requests.some((request) => request.endsWith("/assignments"))).toBe(false);
      expect(requests.some((request) => request.endsWith("/aggregate"))).toBe(false);
      expect(requests.some((request) => request.endsWith("/decision"))).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("keeps predecessor ABS results isolated from the active Taming source scope", async () => {
    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/organizer/workspace?eventId=")) {
        return Response.json({
          data: {
            plan: { id: "plan-taming", rounds: [{ id: "round-review", sequence: 1 }] },
            resultScopes: [
              {
                planId: "plan-abs",
                planVersion: 1,
                lineageOrdinal: 0,
                planName: "ABS",
                roundId: "round-review",
                roundName: "ABS Review",
                sequence: 1,
                historical: true,
              },
              {
                planId: "plan-taming",
                planVersion: 2,
                lineageOrdinal: 1,
                planName: "Taming",
                roundId: "round-review",
                roundName: "Taming Review",
                sequence: 1,
                historical: false,
              },
            ],
            assignments: [
              {
                id: "assignment-abs",
                planId: "plan-abs",
                reviewerId: "reviewer-1",
                submissionId: canonicalEnvelope.submission.id,
                roundId: "round-review",
                status: "submitted",
              },
            ],
            aggregates: [
              {
                planId: "plan-abs",
                roundId: "round-review",
                submissionId: canonicalEnvelope.submission.id,
                submittedReviewCount: 1,
                expectedReviewCount: 1,
                averageWeightedTotal: 7,
                possibleWeightedTotal: 10,
              },
              {
                planId: "plan-taming",
                roundId: "round-review",
                submissionId: canonicalEnvelope.submission.id,
                submittedReviewCount: 9,
                expectedReviewCount: 9,
                averageWeightedTotal: 99,
                possibleWeightedTotal: 100,
              },
            ],
            decisions: {},
          },
        });
      }
      if (url.endsWith("/reviews")) {
        return Response.json({
          data: {
            reviews: [
              {
                planId: "plan-abs",
                roundId: "round-review",
                assignmentId: "assignment-abs",
                submissionId: canonicalEnvelope.submission.id,
                comment: "ABS reviewer comment.",
                scores: { abs_criterion: { value: 7 } },
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    try {
      const submission = await enrichCanonicalSubmission("", canonicalEnvelope);
      expect(submission.reviewSummary).toMatchObject({
        completed: 1,
        total: 1,
        averageScore: 7,
        maxScore: 10,
      });
      expect(submission.reviewAssignments).toEqual([
        expect.objectContaining({
          comment: "ABS reviewer comment.",
          criterionScores: [{ criterion: "Abs Criterion", value: 7 }],
        }),
      ]);
      expect(requests).toContain(
        "/api/admin/evaluations/plans/plan-abs/rounds/round-review/submissions/submission-devflow-1/reviews",
      );
      expect(requests.some((request) => request.includes("/plans/plan-taming/rounds/"))).toBe(
        false,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("chooses the newest three-plan lineage result despite the oldest plan's higher version", () => {
    const submission = mergeCanonicalSubmissionEvaluation(
      canonicalEnvelope,
      indexOrganizerEvaluationWorkspace({
        plan: { id: "plan-taming", rounds: [{ id: "round-review", sequence: 1 }] },
        resultScopes: [
          {
            planId: "plan-abs",
            planVersion: 99,
            lineageOrdinal: 0,
            planName: "ABS",
            roundId: "round-review",
            roundName: "ABS Review",
            sequence: 1,
            historical: true,
          },
          {
            planId: "plan-calibrate",
            planVersion: 2,
            lineageOrdinal: 1,
            planName: "Calibrate",
            roundId: "round-review",
            roundName: "Calibration Review",
            sequence: 1,
            historical: true,
          },
          {
            planId: "plan-taming",
            planVersion: 1,
            lineageOrdinal: 2,
            planName: "Taming",
            roundId: "round-review",
            roundName: "Taming Review",
            sequence: 1,
            historical: false,
          },
        ],
        assignments: [
          {
            id: "assignment-abs",
            planId: "plan-abs",
            reviewerId: "reviewer-abs",
            submissionId: canonicalEnvelope.submission.id,
            roundId: "round-review",
            status: "submitted",
          },
          {
            id: "assignment-calibrate",
            planId: "plan-calibrate",
            reviewerId: "reviewer-calibrate",
            submissionId: canonicalEnvelope.submission.id,
            roundId: "round-review",
            status: "submitted",
          },
          {
            id: "assignment-taming",
            planId: "plan-taming",
            reviewerId: "reviewer-taming",
            submissionId: canonicalEnvelope.submission.id,
            roundId: "round-review",
            status: "in_progress",
          },
        ],
        aggregates: [
          {
            planId: "plan-abs",
            roundId: "round-review",
            submissionId: canonicalEnvelope.submission.id,
            submittedReviewCount: 1,
            expectedReviewCount: 1,
            averageWeightedTotal: 7,
            possibleWeightedTotal: 10,
          },
          {
            planId: "plan-calibrate",
            roundId: "round-review",
            submissionId: canonicalEnvelope.submission.id,
            submittedReviewCount: 1,
            expectedReviewCount: 1,
            averageWeightedTotal: 8,
            possibleWeightedTotal: 15,
          },
          {
            planId: "plan-taming",
            roundId: "round-review",
            submissionId: canonicalEnvelope.submission.id,
            submittedReviewCount: 0,
            expectedReviewCount: 2,
            averageWeightedTotal: null,
            possibleWeightedTotal: 20,
          },
        ],
        decisions: {},
      }),
    );

    expect(submission.reviewSummary).toMatchObject({ completed: 0, total: 2, maxScore: 20 });
    expect(submission.reviewAssignments).toEqual([
      expect.objectContaining({ status: "in_progress" }),
    ]);
  });
  it("moves detail review data to the highest round including an abstention", () => {
    const workspace: OrganizerEvaluationWorkspace = {
      plan: {
        id: "plan-1",
        rounds: [
          { id: "round-initial", sequence: 1 },
          { id: "round-final", sequence: 2 },
        ],
      },
      resultScopes: [
        {
          planId: "plan-1",
          planVersion: 1,
          lineageOrdinal: 0,
          planName: "Taming",
          roundId: "round-initial",
          roundName: "Initial Review",
          sequence: 1,
          historical: false,
        },
        {
          planId: "plan-1",
          planVersion: 1,
          lineageOrdinal: 0,
          planName: "Taming",
          roundId: "round-final",
          roundName: "Final Review",
          sequence: 2,
          historical: false,
        },
      ],
      assignments: [
        {
          planId: "plan-1",
          id: "assignment-initial",
          reviewerId: "reviewer-1",
          submissionId: canonicalEnvelope.submission.id,
          roundId: "round-initial",
          status: "submitted",
        },
        {
          planId: "plan-1",
          id: "assignment-final",
          reviewerId: "reviewer-2",
          submissionId: canonicalEnvelope.submission.id,
          roundId: "round-final",
          status: "abstained",
        },
      ],
      aggregates: [
        {
          planId: "plan-1",
          roundId: "round-initial",
          submissionId: canonicalEnvelope.submission.id,
          submittedReviewCount: 1,
          expectedReviewCount: 1,
          averageWeightedTotal: 11,
          possibleWeightedTotal: 20,
        },
        {
          planId: "plan-1",
          roundId: "round-final",
          submissionId: canonicalEnvelope.submission.id,
          submittedReviewCount: 0,
          expectedReviewCount: 2,
          averageWeightedTotal: null,
          possibleWeightedTotal: 30,
        },
      ],
      decisions: {},
    };

    const submission = mergeCanonicalSubmissionEvaluation(
      canonicalEnvelope,
      indexOrganizerEvaluationWorkspace(workspace),
    );

    expect(submission.reviewSummary).toMatchObject({
      completed: 0,
      total: 2,
      averageScore: null,
      maxScore: 30,
    });
    expect(submission.reviewAssignments).toEqual([
      expect.objectContaining({ status: "abstained" }),
    ]);
  });
  it("falls back to the initial round when a submission has no assignments", () => {
    const submission = mergeCanonicalSubmissionEvaluation(
      canonicalEnvelope,
      indexOrganizerEvaluationWorkspace({
        plan: {
          id: "plan-1",
          rounds: [
            { id: "round-initial", sequence: 1 },
            { id: "round-final", sequence: 2 },
          ],
        },
        resultScopes: [
          {
            planId: "plan-1",
            planVersion: 1,
            lineageOrdinal: 0,
            planName: "Taming",
            roundId: "round-initial",
            roundName: "Initial Review",
            sequence: 1,
            historical: false,
          },
          {
            planId: "plan-1",
            planVersion: 1,
            lineageOrdinal: 0,
            planName: "Taming",
            roundId: "round-final",
            roundName: "Final Review",
            sequence: 2,
            historical: false,
          },
        ],
        assignments: [],
        aggregates: [
          {
            planId: "plan-1",
            roundId: "round-initial",
            submissionId: canonicalEnvelope.submission.id,
            submittedReviewCount: 0,
            expectedReviewCount: 0,
            averageWeightedTotal: null,
            possibleWeightedTotal: 20,
          },
          {
            planId: "plan-1",
            roundId: "round-final",
            submissionId: canonicalEnvelope.submission.id,
            submittedReviewCount: 0,
            expectedReviewCount: 1,
            averageWeightedTotal: null,
            possibleWeightedTotal: 30,
          },
        ],
        decisions: {},
      }),
    );

    expect(submission.reviewSummary).toMatchObject({ total: 0, maxScore: 20 });
    expect(submission.reviewAssignments).toEqual([]);
  });
  it("loads canonical titles independently of the event-wide evaluation batch", async () => {
    let releaseWorkspace: ((response: Response) => void) | undefined;
    const workspaceGate = new Promise<Response>((resolve) => {
      releaseWorkspace = resolve;
    });
    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/cfp/organizations/org-1/events/event-1/submissions") {
        return Response.json({ data: [canonicalEnvelope] });
      }
      if (url === "/api/admin/evaluations/organizer/workspace?eventId=event-1") {
        return workspaceGate;
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    try {
      const workspacePromise = loadOrganizerEvaluationWorkspace("", "event-1");
      const envelopes = await loadCanonicalSubmissionList("", "org-1", "event-1");
      const rows = envelopes.map(mapCanonicalSubmission);
      expect(rows.map((row) => row.title)).toEqual([
        "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
      ]);
      expect(requests).toEqual([
        "/api/admin/evaluations/organizer/workspace?eventId=event-1",
        "/api/cfp/organizations/org-1/events/event-1/submissions",
      ]);

      releaseWorkspace?.(
        Response.json({
          data: {
            plan: { id: "plan-1", rounds: [{ id: "round-1", sequence: 1 }] },
            resultScopes: [],
            assignments: [],
            aggregates: [],
            decisions: {},
          },
        }),
      );
      const workspace = await workspacePromise;
      expect(
        envelopes.map((envelope) =>
          mergeCanonicalSubmissionEvaluation(
            envelope,
            indexOrganizerEvaluationWorkspace(workspace),
          ),
        ),
      ).toHaveLength(1);
      expect(requests.some((request) => request.includes("/plans?eventId="))).toBe(false);
      expect(requests.some((request) => request.endsWith("/reviews"))).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps canonical rows when the evaluation batch fails", async () => {
    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/cfp/organizations/org-1/events/event-1/submissions") {
        return Response.json({ data: [canonicalEnvelope] });
      }
      if (url === "/api/admin/evaluations/organizer/workspace?eventId=event-1") {
        return Response.json({ error: { message: "Evaluation unavailable." } }, { status: 503 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    try {
      const [envelopes, workspace] = await Promise.all([
        loadCanonicalSubmissionList("", "org-1", "event-1"),
        loadOrganizerEvaluationWorkspace("", "event-1").catch(() => null),
      ]);
      const rows =
        workspace === null
          ? envelopes.map(mapCanonicalSubmission)
          : envelopes.map((envelope) =>
              mergeCanonicalSubmissionEvaluation(
                envelope,
                indexOrganizerEvaluationWorkspace(workspace),
              ),
            );
      expect(rows[0]?.title).toBe("Taming 40-Minute CI: Incremental Builds at Monorepo Scale");
      expect(
        submissionListState({
          loading: false,
          loadFailure: null,
          submissionCount: rows.length,
          visibleCount: rows.length,
        }),
      ).toBe("ready");
      expect(requests).toHaveLength(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not expose internal reviewer or organizer identifiers in merged presentation data", () => {
    const internalReviewerId = "reviewer-internal-123";
    const internalOrganizerId = "organizer-internal-456";
    const workspace: OrganizerEvaluationWorkspace = {
      plan: { id: "plan-1", rounds: [{ id: "round-1", sequence: 1 }] },
      resultScopes: [
        {
          planId: "plan-1",
          planVersion: 1,
          lineageOrdinal: 0,
          planName: "Taming",
          roundId: "round-1",
          roundName: "Review",
          sequence: 1,
          historical: false,
        },
      ],
      assignments: [
        {
          planId: "plan-1",
          id: "assignment-1",
          reviewerId: internalReviewerId,
          submissionId: canonicalEnvelope.submission.id,
          roundId: "round-1",
          status: "assigned",
        },
      ],
      aggregates: [
        {
          planId: "plan-1",
          roundId: "round-1",
          submissionId: canonicalEnvelope.submission.id,
          submittedReviewCount: 0,
          expectedReviewCount: 1,
          averageWeightedTotal: null,
          possibleWeightedTotal: 5,
        },
      ],
      decisions: {
        [canonicalEnvelope.submission.id]: {
          id: "decision-1",
          tenantId: canonicalEnvelope.submission.tenantId,
          eventId: canonicalEnvelope.submission.eventId,
          planId: "plan-1",
          submissionId: canonicalEnvelope.submission.id,
          status: "accepted",
          version: 2,
          history: [
            {
              from: null,
              to: "accepted",
              reason: "Ready for the program.",
              decidedBy: internalOrganizerId,
              decidedAt: "2027-01-03T12:00:00.000Z",
              idempotencyKey: "decision-accepted",
            },
          ],
          updatedAt: "2027-01-03T12:00:00.000Z",
        },
      },
    };

    const row = mergeCanonicalSubmissionEvaluation(
      canonicalEnvelope,
      indexOrganizerEvaluationWorkspace(workspace),
    );

    expect(row.reviewAssignments[0]?.reviewer).toBeTruthy();
    expect(row.reviewAssignments[0]?.reviewer).not.toContain(internalReviewerId);
    expect(row.timeline.some((entry) => entry.detail.includes(internalOrganizerId))).toBe(false);
  });

  it("distinguishes submitted-review failures from an authoritative zero result", async () => {
    let reviewsFail = true;
    const reviewRequests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/organizer/workspace?eventId=")) {
        return Response.json({
          data: {
            plan: { id: "plan-1", rounds: [{ id: "round-final", sequence: 2 }] },
            resultScopes: [
              {
                planId: "plan-1",
                planVersion: 1,
                lineageOrdinal: 0,
                planName: "Taming",
                roundId: "round-final",
                roundName: "Final Review",
                sequence: 2,
                historical: false,
              },
            ],
            assignments: [
              {
                planId: "plan-1",
                id: "assignment-1",
                reviewerId: "reviewer-1",
                submissionId: canonicalEnvelope.submission.id,
                roundId: "round-final",
                status: "submitted",
              },
            ],
            decisions: {},
            aggregates: [
              {
                planId: "plan-1",
                roundId: "round-final",
                submissionId: canonicalEnvelope.submission.id,
                submittedReviewCount: 1,
                expectedReviewCount: 1,
                averageWeightedTotal: 4,
                possibleWeightedTotal: 5,
              },
            ],
          },
        });
      }
      if (url.endsWith("/reviews")) {
        reviewRequests.push(url);
        return reviewsFail
          ? Response.json(
              { error: { message: "Submitted review read unavailable." } },
              { status: 503 },
            )
          : Response.json({ data: { reviews: [] } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    try {
      const failed = await enrichCanonicalSubmission("", canonicalEnvelope);
      expect(failed.submittedReviewRead).toEqual({
        status: "error",
        message: "Submitted review read unavailable.",
      });
      expect(failed.reviewAssignments[0]).not.toHaveProperty("criterionScores");
      expect(failed.reviewAssignments[0]).not.toHaveProperty("comment");

      reviewsFail = false;
      const empty = await enrichCanonicalSubmission("", canonicalEnvelope);
      expect(empty.submittedReviewRead).toEqual({ status: "ready", count: 0 });
      expect(reviewRequests).toEqual([
        "/api/admin/evaluations/plans/plan-1/rounds/round-final/submissions/submission-devflow-1/reviews",
        "/api/admin/evaluations/plans/plan-1/rounds/round-final/submissions/submission-devflow-1/reviews",
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("keeps canonical detail content when optional evaluation data has no plan or is unavailable", async () => {
    let evaluationStatus = 404;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/organizer/workspace?eventId=")) {
        return Response.json(
          {
            error: {
              message: evaluationStatus === 404 ? "No evaluation plan." : "Evaluation unavailable.",
            },
          },
          { status: evaluationStatus },
        );
      }
      if (url.includes("/plans?eventId=")) {
        return Response.json({
          plans:
            evaluationStatus === 404
              ? []
              : [
                  {
                    id: "plan-fallback",
                    status: "open",
                    updatedAt: "2026-08-16T12:00:00.000Z",
                  },
                ],
        });
      }
      if (url.includes("/plans/plan-fallback/submissions/") && url.endsWith("/decision")) {
        return Response.json({
          id: "decision-fallback",
          planId: "plan-fallback",
          submissionId: canonicalEnvelope.submission.id,
          status: "waitlisted",
          version: 3,
          decidedByUserId: "organizer-1",
          decidedAt: "2026-08-16T12:30:00.000Z",
          history: [
            {
              fromStatus: "undecided",
              toStatus: "waitlisted",
              reason: "Waiting for the final room allocation.",
              decidedByUserId: "organizer-1",
              decidedAt: "2026-08-16T12:30:00.000Z",
              idempotencyKey: "decision-fallback-v3",
              version: 3,
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    try {
      const noPlan = await enrichCanonicalSubmission("", canonicalEnvelope);
      expect(noPlan).toMatchObject({
        id: canonicalEnvelope.submission.id,
        title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
        abstract:
          "Our monorepo CI took 40 minutes on a good day. This talk walks through how we cut it to 6 minutes.",
        participants: [{ name: "Priya Raman" }, { name: "Marcus Okafor" }],
        reviewSummary: { completed: 0, total: 0 },
        reviewData: {
          status: "no_plan",
          message: "No evaluation plan is configured for this event.",
        },
      });
      expect(noPlan.evaluationPlanId).toBeUndefined();

      evaluationStatus = 503;
      const unavailable = await enrichCanonicalSubmission("", canonicalEnvelope);
      assert.equal(unavailable.id, canonicalEnvelope.submission.id);
      assert.equal(unavailable.title, "Taming 40-Minute CI: Incremental Builds at Monorepo Scale");
      assert.equal(unavailable.evaluationPlanId, "plan-fallback");
      assert.equal(unavailable.decision?.status, "waitlisted");
      assert.equal(unavailable.decision?.version, 3);
      assert.equal(
        unavailable.decision?.history.at(-1)?.reason,
        "Waiting for the final room allocation.",
      );
      assert.deepEqual(unavailable.reviewData, {
        status: "unavailable",
        message: "Review data is unavailable: Evaluation unavailable.",
      });
      assert.equal(
        unavailable.answers.some(
          (answer) =>
            answer.question === "Session title" &&
            answer.answer === "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
        ),
        true,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("starts submission detail in loading until the canonical list responds", () => {
    const previousRuntimeProfile = process.env.NEXT_PUBLIC_RUNTIME_PROFILE;
    process.env.NEXT_PUBLIC_RUNTIME_PROFILE = "fixture";
    try {
      const markup = renderToStaticMarkup(
        createElement(SubmissionDetailWorkspace, {
          eventId: "summit-2026",
          submissionId: "missing-submission",
          organizationId: "organization-1",
        }),
      );

      expect(markup).toContain("Loading submission");
      expect(markup).not.toContain("Submission not found");
      expect(markup).not.toContain("Unable to load submission");
    } finally {
      process.env.NEXT_PUBLIC_RUNTIME_PROFILE = previousRuntimeProfile;
    }
  });

  it("projects persisted accepted and rejected decisions into canonical statuses", async () => {
    let decisionStatus: "accepted" | "rejected" = "accepted";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/organizer/workspace?eventId=")) {
        return Response.json({
          data: {
            plan: { id: "plan-1", rounds: [{ id: "round-final", sequence: 1 }] },
            resultScopes: [
              {
                planId: "plan-1",
                planVersion: 1,
                lineageOrdinal: 0,
                planName: "Taming",
                roundId: "round-final",
                roundName: "Final Review",
                sequence: 1,
                historical: false,
              },
            ],
            assignments: [],
            aggregates: [
              {
                planId: "plan-1",
                roundId: "round-final",
                submissionId: canonicalEnvelope.submission.id,
                submittedReviewCount: 0,
                expectedReviewCount: 0,
                averageWeightedTotal: null,
                possibleWeightedTotal: 0,
              },
            ],
            decisions: {
              [canonicalEnvelope.submission.id]: {
                id: "decision-1",
                tenantId: canonicalEnvelope.submission.tenantId,
                eventId: canonicalEnvelope.submission.eventId,
                planId: "plan-1",
                submissionId: canonicalEnvelope.submission.id,
                status: decisionStatus,
                version: 2,
                history: [
                  {
                    from: null,
                    to: decisionStatus,
                    reason: `Organizer decision: ${decisionStatus}.`,
                    decidedBy: "organizer-1",
                    decidedAt: "2027-01-03T12:00:00.000Z",
                    idempotencyKey: `decision-${decisionStatus}`,
                  },
                ],
                updatedAt: "2027-01-03T12:00:00.000Z",
              },
            },
          },
        });
      }
      if (url.endsWith("/reviews")) return Response.json({ data: { reviews: [] } });
      throw new Error(`Unexpected request: ${url}`);
    });

    try {
      for (const [status, expectedStatus, timelineLabel] of [
        ["accepted", "accepted", "Accepted"],
        ["rejected", "declined", "Rejected"],
      ] as const) {
        decisionStatus = status;
        const submission = await enrichCanonicalSubmission("", canonicalEnvelope);
        expect(submission.status).toBe(expectedStatus);
        expect(submission.decision?.status).toBe(status);
        expect(submission.timeline.at(-1)?.label).toBe(timelineLabel);
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses stored taxonomy answers and an em dash only when a canonical field is absent", () => {
    const record = mapCanonicalSubmission({
      ...canonicalEnvelope,
      submission: {
        ...canonicalEnvelope.submission,
        answers: { ...canonicalEnvelope.submission.answers, format: undefined },
      },
    });
    expect(record).toMatchObject({
      track: "Platform & Infra",
      format: "—",
    });
  });
  it("keeps the initial event label neutral until authoritative identity loads", () => {
    expect(initialOrganizerEventName()).toBe("Selected event");

    for (const eventId of ["demo-event", "summit-2026", "forge-2025"]) {
      const markup = renderToStaticMarkup(
        createElement(SubmissionListWorkspace, {
          eventId,
          organizationId: "organization-1",
        }),
      );
      expect(markup).toContain("Selected event");
      expect(markup).not.toContain("Open Sessionboard Conference");
      expect(markup).not.toContain("Eventloom Summit 2026");
      expect(markup).not.toContain("Forge Community Day 2025");
    }
  });

  it("loads canonical submissions from the same-origin API even under fixture profile", async () => {
    const previousRuntimeProfile = process.env.NEXT_PUBLIC_RUNTIME_PROFILE;
    process.env.NEXT_PUBLIC_RUNTIME_PROFILE = "fixture";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: [canonicalEnvelope] }));

    try {
      await expect(
        loadCanonicalSubmissionList("", "organization-1", "summit-2026"),
      ).resolves.toEqual([canonicalEnvelope]);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/cfp/organizations/organization-1/events/summit-2026/submissions",
        expect.objectContaining({ credentials: "include", cache: "no-store" }),
      );
    } finally {
      fetchMock.mockRestore();
      process.env.NEXT_PUBLIC_RUNTIME_PROFILE = previousRuntimeProfile;
    }
  });

  it("derives accepted handoff metadata from canonical API data", () => {
    const accepted = mapCanonicalSubmission({
      ...canonicalEnvelope,
      submission: {
        ...canonicalEnvelope.submission,
        status: "submitted",
      },
    });
    const metadata = getAcceptedHandoffMetadata(accepted);

    expect(metadata).toMatchObject({
      title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
      track: "Platform & Infra",
      primarySpeaker: { name: "Priya Raman", role: "Speaker" },
      coSpeakers: [{ name: "Marcus Okafor", role: "Co-speaker" }],
      version: 1,
    });
  });
});
