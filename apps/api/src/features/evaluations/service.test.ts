import { describe, expect, it } from "vitest";
import type { EvaluationError } from "./errors";
import {
  type EvaluationPlanRevisionPrecondition,
  type EvaluationPlanScheduleSync,
  type EvaluationReviewWriteAdmission,
  InMemoryEvaluationRepository,
  InMemorySubmissionReviewSource,
  type OrganizerWorkspaceRecords,
  type ReviewerWorkspaceRecords,
  type SubmissionReviewLookup,
  type WriteEvaluationReview,
} from "./repository";
import { MAX_REVISION_RECONCILIATION_ROUNDS } from "./revision-schedule-sync";
import {
  type EvaluationDecisionProjectionInput,
  type EvaluationEventMetadataSource,
  EvaluationService,
  type EvaluationServiceOptions,
  type EvaluationSessionDecisionReconciliationInput,
} from "./service";
import type {
  EvaluationActor,
  EvaluationAssignment,
  EvaluationPlan,
  EvaluationReview,
  EvaluationReviewerProjection,
  EvaluationSuggestion,
  EvaluationSuggestionProviderCandidate,
  EvaluationSuggestionProviderInput,
  ReviewRound,
  SubmissionReviewMaterial,
} from "./types";

const tenantId = "tenant-1";
const eventId = "event-1";
const nowIso = "2026-08-08T12:00:00.000Z";

function evaluationEventSource(
  overrides: Partial<{
    startsAt: string;
    endsAt: string;
    timeZone: string;
  }> = {},
): EvaluationEventMetadataSource {
  return {
    async getEventMetadata(requestedTenantId, requestedEventId) {
      if (requestedTenantId !== tenantId || requestedEventId !== eventId) return null;
      return {
        id: eventId,
        name: "Monthly program",
        timeZone: overrides.timeZone ?? "America/Los_Angeles",
        startsAt: overrides.startsAt ?? "2026-08-09T16:00:00.000Z",
        endsAt: overrides.endsAt ?? "2026-09-30T23:59:00.000Z",
      };
    },
  };
}

const organizer: EvaluationActor = {
  tenantId,
  userId: "organizer-1",
  kind: "human",
  grants: [{ eventId, role: "organizer" }],
};

function reviewer(userId: string, tenant = tenantId): EvaluationActor {
  return {
    tenantId: tenant,
    userId,
    kind: "human",
    grants: [{ eventId, role: "reviewer" }],
  };
}
class StaleAssignmentRepository extends InMemoryEvaluationRepository {
  override async getAssignment(
    tenantId: string,
    assignmentId: string,
  ): Promise<EvaluationAssignment | null> {
    const assignment = await super.getAssignment(tenantId, assignmentId);
    return assignment === null ? null : { ...assignment, status: "assigned" };
  }
}

class GatedReviewWriteRepository extends InMemoryEvaluationRepository {
  writeGate: Promise<void> | null = null;
  writeEntered: (() => void) | null = null;

  override async writeReview(input: WriteEvaluationReview): Promise<void> {
    this.writeEntered?.();
    if (this.writeGate !== null) await this.writeGate;
    return super.writeReview(input);
  }
}

class NonAtomicEvaluationRepository extends InMemoryEvaluationRepository {
  override readonly supportsAtomicPlanRevisionSync: boolean = false;
}

class ReconciliationBatchRepository extends InMemoryEvaluationRepository {
  reconciliationCalls = 0;

  override async reconcilePlanRevisionFamily(
    tip: EvaluationPlan,
    expectedVersion: number,
    scheduleSyncs: readonly EvaluationPlanScheduleSync[],
    revisionSyncToken: string,
  ): Promise<void> {
    this.reconciliationCalls += 1;
    await super.reconcilePlanRevisionFamily(tip, expectedVersion, scheduleSyncs, revisionSyncToken);
  }
}
class WorkspaceBatchRepository extends InMemoryEvaluationRepository {
  planGate: Promise<void> | null = null;
  planListStarted: (() => void) | null = null;
  planListCalls = 0;
  organizerWorkspaceCalls = 0;
  organizerWorkspaceStarted: (() => void) | null = null;
  decisionCalls = 0;
  workspaceCalls = 0;
  assignmentListCalls = 0;
  reviewListCalls = 0;
  successorCalls = 0;
  batchGate: Promise<void> | null = null;
  organizerWorkspaceFailure: Error | null = null;

  override async listPlans(tenantId: string, requestedEventId?: string) {
    this.planListCalls += 1;
    this.planListStarted?.();
    const gate = this.planGate;
    if (gate !== null) await gate;
    return super.listPlans(tenantId, requestedEventId);
  }

  override async listReviewerWorkspaceRecords(
    requestedTenantId: string,
    reviewerId: string,
    eventIds: readonly string[],
  ): Promise<ReviewerWorkspaceRecords> {
    this.workspaceCalls += 1;
    const gate = this.batchGate;
    if (gate !== null) await gate;
    return super.listReviewerWorkspaceRecords(requestedTenantId, reviewerId, eventIds);
  }
  override async listOrganizerWorkspaceRecords(
    requestedTenantId: string,
    requestedEventId: string,
  ): Promise<OrganizerWorkspaceRecords> {
    this.organizerWorkspaceCalls += 1;
    this.organizerWorkspaceStarted?.();
    const gate = this.batchGate;
    if (gate !== null) await gate;
    if (this.organizerWorkspaceFailure !== null) throw this.organizerWorkspaceFailure;
    return super.listOrganizerWorkspaceRecords(requestedTenantId, requestedEventId);
  }
  override async getDecision(requestedTenantId: string, planId: string, submissionId: string) {
    this.decisionCalls += 1;
    return super.getDecision(requestedTenantId, planId, submissionId);
  }

  override async listAssignments(requestedTenantId: string, planId: string) {
    this.assignmentListCalls += 1;
    return super.listAssignments(requestedTenantId, planId);
  }

  override async listReviews(requestedTenantId: string, planId: string) {
    this.reviewListCalls += 1;
    return super.listReviews(requestedTenantId, planId);
  }

  override async getPlanSuccessor(tenantId: string, eventId: string, predecessorPlanId: string) {
    this.successorCalls += 1;
    return super.getPlanSuccessor(tenantId, eventId, predecessorPlanId);
  }

  resetCounts(): void {
    this.planGate = null;
    this.planListStarted = null;
    this.planListCalls = 0;
    this.workspaceCalls = 0;
    this.assignmentListCalls = 0;
    this.reviewListCalls = 0;
    this.successorCalls = 0;
    this.organizerWorkspaceCalls = 0;
    this.organizerWorkspaceStarted = null;
    this.decisionCalls = 0;
  }
}

class RacingLineageRepository extends InMemoryEvaluationRepository {
  lineagePlanId: string | null = null;

  override async putPlan(
    plan: EvaluationPlan,
    expectedVersion: number | null,
    revisionPrecondition?: EvaluationPlanRevisionPrecondition,
  ): Promise<void> {
    const lineagePlanId = this.lineagePlanId;
    if (revisionPrecondition !== undefined && lineagePlanId !== null) {
      this.lineagePlanId = null;
      const lineagePlan = await this.getPlan(plan.tenantId, lineagePlanId);
      if (lineagePlan === null) throw new Error("Expected a lineage race fixture.");
      await super.putPlan(
        {
          ...lineagePlan,
          version: lineagePlan.version + 1,
        },
        lineagePlan.version,
      );
    }
    await super.putPlan(plan, expectedVersion, revisionPrecondition);
  }
}

class PausedReconciliationRepository extends InMemoryEvaluationRepository {
  #pause:
    | {
        readonly entered: () => void;
        readonly release: Promise<void>;
      }
    | undefined;

  pauseNextReconciliation(): { readonly entered: Promise<void>; readonly release: () => void } {
    let signalEntered = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#pause = { entered: signalEntered, release: released };
    return { entered, release };
  }

  override async reconcilePlanRevisionFamily(
    tip: EvaluationPlan,
    expectedVersion: number,
    scheduleSyncs: readonly EvaluationPlanScheduleSync[],
    revisionSyncToken: string,
  ): Promise<void> {
    const pause = this.#pause;
    if (pause !== undefined) {
      this.#pause = undefined;
      pause.entered();
      await pause.release;
    }
    await super.reconcilePlanRevisionFamily(tip, expectedVersion, scheduleSyncs, revisionSyncToken);
  }
}

class FailingReconciliationRepository extends InMemoryEvaluationRepository {
  failNextReconciliation = false;

  override async reconcilePlanRevisionFamily(
    tip: EvaluationPlan,
    expectedVersion: number,
    scheduleSyncs: readonly EvaluationPlanScheduleSync[],
    revisionSyncToken: string,
  ): Promise<void> {
    if (this.failNextReconciliation) {
      this.failNextReconciliation = false;
      throw new Error("Injected reconciliation interruption.");
    }
    await super.reconcilePlanRevisionFamily(tip, expectedVersion, scheduleSyncs, revisionSyncToken);
  }
}

class PendingLineageRepairRepository extends InMemoryEvaluationRepository {
  override async hasPendingPlanLineageRepair(): Promise<boolean> {
    return true;
  }
}

class RacingReviewAdmissionRepository extends InMemoryEvaluationRepository {
  supersedeBeforeReviewWrite = false;
  closeBeforeSuggestionWrite = false;

  override async putReview(
    review: EvaluationReview,
    expectedVersion: number | null,
    admission: EvaluationReviewWriteAdmission,
  ): Promise<void> {
    if (this.supersedeBeforeReviewWrite) {
      this.supersedeBeforeReviewWrite = false;
      const current = await this.getAssignment(
        admission.assignment.tenantId,
        admission.assignment.id,
      );
      if (current === null) throw new Error("Expected an assignment race fixture.");
      await this.putAssignmentsForTesting([
        { ...current, status: "superseded", version: current.version + 1 },
      ]);
    }
    await super.putReview(review, expectedVersion, admission);
  }

  override async writeReview(input: WriteEvaluationReview): Promise<void> {
    if (this.supersedeBeforeReviewWrite) {
      this.supersedeBeforeReviewWrite = false;
      const current = await this.getAssignment(
        input.authority.tenantId,
        input.authority.assignmentId,
      );
      if (current === null) throw new Error("Expected an assignment race fixture.");
      await this.putAssignmentsForTesting([
        { ...current, status: "superseded", version: current.version + 1 },
      ]);
    }
    await super.writeReview(input);
  }

  override async putSuggestion(
    suggestion: EvaluationSuggestion,
    expectedVersion: number | null,
    expectedSubmissionRevision?: number,
    allowClosedPlan = false,
  ): Promise<void> {
    if (this.closeBeforeSuggestionWrite) {
      this.closeBeforeSuggestionWrite = false;
      const plan = await this.getPlan(suggestion.tenantId, suggestion.planId);
      if (plan === null) throw new Error("Expected a plan race fixture.");
      await super.putPlanState(
        { ...plan, status: "closed", version: plan.version + 1 },
        plan.version,
        [],
      );
    }
    await super.putSuggestion(
      suggestion,
      expectedVersion,
      expectedSubmissionRevision,
      allowClosedPlan,
    );
  }
}

class MultiTenantWorkspaceRepository extends InMemoryEvaluationRepository {
  readonly workspaceScopes: Array<{
    readonly tenantId: string;
    readonly eventIds: readonly string[];
  }> = [];

  override async listReviewerWorkspaceRecords(
    tenantId: string,
    reviewerId: string,
    eventIds: readonly string[],
  ): Promise<ReviewerWorkspaceRecords> {
    this.workspaceScopes.push({ tenantId, eventIds });
    return super.listReviewerWorkspaceRecords(tenantId, reviewerId, eventIds);
  }
}

class WorkspaceBatchSource extends InMemorySubmissionReviewSource {
  singleCalls = 0;
  batchCalls = 0;
  lastLookups: readonly SubmissionReviewLookup[] = [];
  omitMaterials = false;
  failure: Error | null = null;
  organizerListCalls = 0;
  organizerListStarted: (() => void) | null = null;
  organizerBatchGate: Promise<void> | null = null;

  override async getSubmissionForReview(
    requestedTenantId: string,
    requestedEventId: string,
    submissionId: string,
  ) {
    this.singleCalls += 1;
    return super.getSubmissionForReview(requestedTenantId, requestedEventId, submissionId);
  }

  override async getSubmissionsForReview(
    requestedTenantId: string,
    lookups: readonly SubmissionReviewLookup[],
  ) {
    this.batchCalls += 1;
    this.lastLookups = structuredClone(lookups);
    if (this.failure !== null) throw this.failure;
    if (this.omitMaterials) return [];
    return [...(await super.getSubmissionsForReview(requestedTenantId, lookups))].reverse();
  }
  override async listSubmissionsForOrganizer(requestedTenantId: string, requestedEventId: string) {
    this.organizerListCalls += 1;
    this.organizerListStarted?.();
    const gate = this.organizerBatchGate;
    if (gate !== null) await gate;
    return super.listSubmissionsForOrganizer(requestedTenantId, requestedEventId);
  }

  resetCounts(): void {
    this.singleCalls = 0;
    this.batchCalls = 0;
    this.lastLookups = [];
    this.organizerListCalls = 0;
    this.organizerListStarted = null;
    this.organizerBatchGate = null;
  }
}

const round: ReviewRound = {
  id: "round-1",
  name: "Committee review",
  sequence: 1,
  closesAt: "2026-08-10T12:00:00.000Z",
  rubric: {
    id: "rubric-1",
    name: "Program rubric",
    criteria: [
      {
        id: "quality",
        label: "Quality",
        description: "How strong is the proposal?",
        minimum: 1,
        maximum: 5,
        weight: 2,
        required: true,
      },
      {
        id: "relevance",
        label: "Relevance",
        description: "How relevant is the proposal?",
        minimum: 0,
        maximum: 10,
        weight: 1,
        required: true,
      },
    ],
  },
};

const submission: SubmissionReviewMaterial = {
  id: "submission-1",
  tenantId,
  eventId,
  status: "submitted",
  title: "A useful session",
  abstract: "Practical material for the audience.",
  answers: {
    experience: "Advanced",
    speakerEmail: "speaker@example.com",
  },
  identityFieldIds: ["speakerEmail"],
  participants: [
    {
      id: "participant-1",
      displayName: "Speaker Name",
      email: "speaker@example.com",
      biography: "Identifying biography",
    },
  ],
};

function validAiCandidates(): readonly [
  EvaluationSuggestionProviderCandidate,
  EvaluationSuggestionProviderCandidate,
] {
  return [
    {
      criterionId: "quality",
      value: 4,
      evidence: ["The practical material gives the audience a concrete outcome."],
      provenance: {
        sourceReferences: ["abstract:Practical material for the audience."],
      },
    },
    {
      criterionId: "relevance",
      value: 8,
      evidence: ["The practical audience focus directly supports program relevance."],
      provenance: {
        sourceReferences: ["abstract:Practical material for the audience."],
      },
    },
  ];
}

async function fixture(
  options: Pick<
    EvaluationServiceOptions,
    "acceptanceHandoff" | "aiSuggestionProducer" | "aiSuggestionProvider" | "decisionProjection"
  > & {
    blindReview?: boolean;
    reviewsPerSubmission?: number;
    maxAssignmentsPerReviewer?: number;
    submissionMaterial?: SubmissionReviewMaterial;
    reviewerProjection?: EvaluationReviewerProjection;
    repository?: InMemoryEvaluationRepository;
    submissions?: InMemorySubmissionReviewSource;
    reviewRound?: ReviewRound;
    reviewRounds?: readonly ReviewRound[];
  } = {},
) {
  let currentTime = new Date(nowIso);
  const submissions =
    options.submissions ??
    new InMemorySubmissionReviewSource([
      { status: "submitted", ...(options.submissionMaterial ?? submission) },
      { ...submission, id: "submission-2", status: "submitted", title: "Another session" },
    ]);
  const repository = options.repository ?? new InMemoryEvaluationRepository(submissions);
  Object.defineProperty(repository, "usesDurableDecisionOutbox", {
    configurable: true,
    value: true,
  });
  const service = new EvaluationService(
    repository,
    submissions,
    {
      ...evaluationEventSource(),
    },
    {
      clock: () => new Date(currentTime),
      ...(options.acceptanceHandoff === undefined
        ? {}
        : { acceptanceHandoff: options.acceptanceHandoff }),
      ...(options.decisionProjection === undefined
        ? {}
        : { decisionProjection: options.decisionProjection }),
      ...(options.aiSuggestionProducer === undefined
        ? {}
        : { aiSuggestionProducer: options.aiSuggestionProducer }),
      ...(options.aiSuggestionProvider === undefined
        ? {}
        : { aiSuggestionProvider: options.aiSuggestionProvider }),
    },
  );
  const draft = await service.createPlan(organizer, {
    id: "plan-1",
    eventId,
    name: "Main review",
    blindReview: options.blindReview ?? true,
    closesAt: "2026-08-12T12:00:00.000Z",
    assignmentRule: {
      reviewsPerSubmission: options.reviewsPerSubmission ?? 2,
      maxAssignmentsPerReviewer: options.maxAssignmentsPerReviewer ?? 1,
    },
    rounds: options.reviewRounds ?? [options.reviewRound ?? round],
    ...(options.reviewerProjection === undefined
      ? {}
      : { reviewerProjection: options.reviewerProjection }),
  });
  const plan = await service.openPlan(organizer, draft.id, draft.version, crypto.randomUUID());
  return {
    repository,
    service,
    plan,
    submissions,
    setTime(value: string) {
      currentTime = new Date(value);
    },
  };
}

async function assignOne(service: EvaluationService, userId = "reviewer-1") {
  const assignments = await service.assignReviewers(organizer, {
    planId: "plan-1",
    roundId: round.id,
    submissionId: submission.id,
    reviewerIds: [userId],
  });
  const assignment = assignments[0];
  if (assignment === undefined) {
    throw new Error("Expected an assignment fixture.");
  }
  return assignment;
}

const triageRound: ReviewRound = { ...round, aiTriageEnabled: true };

function generateTriage(
  service: EvaluationService,
  options: { planId?: string; roundId?: string; submissionId?: string; regenerate?: boolean } = {},
): Promise<EvaluationSuggestion> {
  return service.generateRoundAiSuggestions(organizer, {
    planId: options.planId ?? "plan-1",
    roundId: options.roundId ?? round.id,
    submissionId: options.submissionId ?? submission.id,
    ...(options.regenerate === true ? { regenerate: true } : {}),
  });
}

async function expectProviderCandidatesRejected(
  candidates: readonly EvaluationSuggestionProviderCandidate[],
  reviewRound: ReviewRound = triageRound,
): Promise<void> {
  const { repository, service, plan } = await fixture({
    reviewsPerSubmission: 1,
    reviewRound,
    aiSuggestionProducer: async () => ({ candidates }),
  });

  await expectEvaluationError(generateTriage(service), "EVALUATION_INVALID_INPUT");
  expect(await repository.listSuggestions(tenantId, plan.id)).toEqual([]);
}

async function expectEvaluationError(
  promise: Promise<unknown>,
  code: EvaluationError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("evaluation plans and assignments", () => {
  it("returns submitted organizer comments while withholding reviewer drafts", async () => {
    const { service, repository } = await fixture({
      reviewsPerSubmission: 2,
      maxAssignmentsPerReviewer: 2,
    });
    const assignments = await service.assignReviewers(organizer, {
      planId: "plan-1",
      roundId: round.id,
      submissionId: submission.id,
      reviewerIds: ["reviewer-submitted", "reviewer-draft"],
    });
    const submittedAssignment = assignments.find(
      (assignment) => assignment.reviewerId === "reviewer-submitted",
    );
    const draftAssignment = assignments.find(
      (assignment) => assignment.reviewerId === "reviewer-draft",
    );
    if (submittedAssignment === undefined || draftAssignment === undefined) {
      throw new Error("Expected submitted and draft assignment fixtures.");
    }

    const submittedReview = await service.saveReview(
      reviewer(submittedAssignment.reviewerId),
      submittedAssignment.id,
      {
        scores: [
          { criterionId: "quality", value: 4, origin: "human" },
          { criterionId: "relevance", value: 8, origin: "human" },
        ],
        comment: "Submitted committee evidence.",
      },
    );
    await service.submitReview(
      reviewer(submittedAssignment.reviewerId),
      submittedAssignment.id,
      submittedReview.version,
    );
    await service.saveReview(reviewer(draftAssignment.reviewerId), draftAssignment.id, {
      scores: [
        { criterionId: "quality", value: 3, origin: "human" },
        { criterionId: "relevance", value: 6, origin: "human" },
      ],
      comment: "Private draft evidence.",
    });

    const workspace = await service.getOrganizerWorkspace(organizer, eventId);

    expect(workspace.submittedReviews).toEqual([
      expect.objectContaining({
        submissionId: submission.id,
        reviewerId: submittedAssignment.reviewerId,
        roundId: round.id,
        comment: "Submitted committee evidence.",
      }),
    ]);
    expect(JSON.stringify(workspace.submittedReviews)).not.toContain("Private draft evidence.");
    await expectEvaluationError(
      service.getOrganizerWorkspace(reviewer(submittedAssignment.reviewerId), eventId),
      "EVALUATION_FORBIDDEN",
    );

    const persistedAssignment = await repository.getAssignment(tenantId, submittedAssignment.id);
    if (persistedAssignment === null) {
      throw new Error("Expected the submitted assignment to remain persisted.");
    }
    await service.replaceAssignment(organizer, submittedAssignment.id, {
      replacementReviewerId: "reviewer-replacement",
      expectedVersion: persistedAssignment.version,
      reason: "The original reviewer became unavailable.",
    });
    await expect(service.getOrganizerWorkspace(organizer, eventId)).resolves.toMatchObject({
      submittedReviews: [],
    });
  });

  it("removes submitted comments and counted scores after a reviewer declares conflict", async () => {
    const { service } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    const actor = reviewer(assignment.reviewerId);
    const draft = await service.saveReview(actor, assignment.id, {
      scores: [
        { criterionId: "quality", value: 4, origin: "human" },
        { criterionId: "relevance", value: 8, origin: "human" },
      ],
      comment: "Submitted before conflict declaration.",
    });
    const submitted = await service.submitReview(actor, assignment.id, draft.version);
    expect(submitted.submittedAt).not.toBeNull();

    await service.declareConflict(actor, assignment.id, "I collaborated with the submitter.");

    const workspace = await service.getOrganizerWorkspace(organizer, eventId);
    const aggregate = workspace.aggregates.find(
      (candidate) => candidate.roundId === round.id && candidate.submissionId === submission.id,
    );

    expect(aggregate).toMatchObject({
      roundId: round.id,
      submissionId: submission.id,
      submittedReviewCount: 0,
      averageWeightedTotal: null,
    });
    expect(workspace.submittedReviews).toEqual([]);
    await expect(
      service.listSubmittedReviews(organizer, "plan-1", round.id, submission.id),
    ).resolves.toEqual([]);
    await expect(
      service.getAggregate(organizer, "plan-1", round.id, submission.id),
    ).resolves.toMatchObject({
      submittedReviewCount: 0,
      averageWeightedTotal: null,
    });
  });

  it("loads reviewer work across every granted organization scope", async () => {
    const repository = new MultiTenantWorkspaceRepository();
    const service = new EvaluationService(
      repository,
      new InMemorySubmissionReviewSource(),
      evaluationEventSource(),
    );

    await expect(
      service.listReviewerWorkspace({
        tenantId: "org-a",
        userId: "reviewer-multi-org",
        kind: "human",
        grants: [
          { tenantId: "org-a", eventId: "event-a", role: "reviewer" },
          { tenantId: "org-b", eventId: "event-b", role: "reviewer" },
        ],
      }),
    ).resolves.toEqual({ assignments: [] });

    expect(repository.workspaceScopes).toEqual([
      { tenantId: "org-a", eventIds: ["event-a"] },
      { tenantId: "org-b", eventIds: ["event-b"] },
    ]);
  });

  it("scopes duplicate event identifiers to one requested organization", async () => {
    const repository = new MultiTenantWorkspaceRepository();
    const service = new EvaluationService(
      repository,
      new InMemorySubmissionReviewSource(),
      evaluationEventSource(),
    );

    await expect(
      service.listReviewerWorkspace(
        {
          tenantId: "org-a",
          userId: "reviewer-multi-org",
          kind: "human",
          grants: [
            { tenantId: "org-a", eventId: "shared-event", role: "reviewer" },
            { tenantId: "org-b", eventId: "shared-event", role: "reviewer" },
          ],
        },
        "shared-event",
        "org-b",
      ),
    ).resolves.toEqual({ assignments: [] });

    expect(repository.workspaceScopes).toEqual([{ tenantId: "org-b", eventIds: ["shared-event"] }]);
  });

  it("accepts zero-weight dropdowns and neutral free-text bounds", async () => {
    const service = new EvaluationService(
      new InMemoryEvaluationRepository(),
      new InMemorySubmissionReviewSource(),
      evaluationEventSource(),
      { clock: () => new Date(nowIso) },
    );
    const plan = await service.createPlan(organizer, {
      id: "plan-non-numeric-criteria",
      eventId: "event-1",
      name: "Program review",
      blindReview: true,
      closesAt: "2026-09-10T19:00:00.000Z",
      assignmentRule: {
        reviewsPerSubmission: 2,
        maxAssignmentsPerReviewer: 12,
      },
      rounds: [
        {
          id: "round-1",
          name: "Committee review",
          sequence: 1,
          opensAt: "2026-08-08T12:00:00.000Z",
          closesAt: "2026-09-10T19:00:00.000Z",
          blindReview: true,
          anonymization: "double",
          reviewerPool: { name: "Program committee", reviewerIds: ["reviewer-1"] },
          rubric: {
            id: "rubric-1",
            name: "Program rubric",
            criteria: [
              {
                id: "recommendation",
                label: "Recommendation",
                description: "Would you recommend this proposal?",
                minimum: 0,
                maximum: 2,
                weight: 0,
                required: true,
                inputType: "dropdown",
                options: [
                  { label: "Accept", value: "accept" },
                  { label: "Maybe", value: "maybe" },
                  { label: "Reject", value: "reject" },
                ],
              },
              {
                id: "reviewer-notes",
                label: "Reviewer notes",
                description: "Share committee-only context.",
                minimum: 0,
                maximum: 0,
                weight: 0,
                required: false,
                inputType: "free_text",
              },
            ],
          },
        },
      ],
    });

    expect(plan.rounds[0]?.rubric.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "recommendation", inputType: "dropdown" }),
        expect.objectContaining({ id: "reviewer-notes", inputType: "free_text" }),
      ]),
    );
  });

  it("replaces the complete active reviewer set and validates resulting limits", async () => {
    const { service, repository } = await fixture({ reviewsPerSubmission: 2 });
    const initial = await service.assignReviewers(organizer, {
      planId: "plan-1",
      roundId: round.id,
      submissionId: submission.id,
      reviewerIds: ["reviewer-1", "reviewer-2"],
    });

    expect(initial).toHaveLength(2);
    const replacement = await service.assignReviewers(organizer, {
      planId: "plan-1",
      roundId: round.id,
      submissionId: submission.id,
      reviewerIds: ["reviewer-2", "reviewer-3"],
    });
    expect(replacement).toHaveLength(2);
    expect(replacement[0]?.reviewerId).toBe("reviewer-2");
    expect(replacement[0]?.id).toBe(initial[1]?.id);
    await expect(repository.getAssignment(tenantId, initial[0]?.id ?? "")).resolves.toMatchObject({
      status: "superseded",
      successorAssignmentId: null,
    });
    await expect(repository.getAssignment(tenantId, initial[1]?.id ?? "")).resolves.toMatchObject({
      reviewerId: "reviewer-2",
    });

    await expect(
      service.assignReviewers(organizer, {
        planId: "plan-1",
        roundId: round.id,
        submissionId: "submission-2",
        reviewerIds: ["reviewer-1"],
      }),
    ).resolves.toHaveLength(1);
  });

  it("reuses one active assignment for the same reviewer, plan, round, and submission", async () => {
    const { service, repository } = await fixture({ reviewsPerSubmission: 1 });
    const original = await assignOne(service, "reviewer-1");

    const repeated = await service.assignReviewers(organizer, {
      planId: "plan-1",
      roundId: round.id,
      submissionId: submission.id,
      reviewerIds: ["reviewer-1"],
    });

    expect(repeated).toEqual([original]);
    const matchingAssignments = (await repository.listAssignments(tenantId, "plan-1")).filter(
      (assignment) =>
        assignment.tenantId === tenantId &&
        assignment.eventId === eventId &&
        assignment.planId === "plan-1" &&
        assignment.roundId === round.id &&
        assignment.submissionId === submission.id &&
        assignment.reviewerId === "reviewer-1" &&
        assignment.status !== "superseded",
    );
    expect(matchingAssignments).toEqual([original]);
    expect(original).not.toHaveProperty("predecessorAssignmentId");
  });

  it("creates separate active root assignments for the same reviewer and submission in different rounds", async () => {
    const finalRound: ReviewRound = {
      ...round,
      id: "round-2",
      name: "Final review",
      sequence: 2,
    };
    const { service } = await fixture({
      reviewsPerSubmission: 1,
      maxAssignmentsPerReviewer: 2,
      reviewRounds: [round, finalRound],
    });
    const committeeAssignment = await assignOne(service, "reviewer-1");

    const finalAssignments = await service.assignReviewers(organizer, {
      planId: "plan-1",
      roundId: finalRound.id,
      submissionId: submission.id,
      reviewerIds: ["reviewer-1"],
    });
    const finalAssignment = finalAssignments[0];
    if (finalAssignment === undefined)
      throw new Error("Expected a final-round assignment fixture.");

    expect(finalAssignment).toMatchObject({
      id: `plan-1:${finalRound.id}:${submission.id}:reviewer-1`,
      roundId: finalRound.id,
      submissionId: submission.id,
      reviewerId: "reviewer-1",
      status: "assigned",
    });
    expect(finalAssignment.id).not.toBe(committeeAssignment.id);
    expect(committeeAssignment).not.toHaveProperty("predecessorAssignmentId");
    expect(finalAssignment).not.toHaveProperty("predecessorAssignmentId");
    await expect(
      service.listReviewerAssignments(reviewer("reviewer-1"), "plan-1"),
    ).resolves.toEqual([
      expect.objectContaining({ id: committeeAssignment.id, roundId: round.id }),
      expect.objectContaining({ id: finalAssignment.id, roundId: finalRound.id }),
    ]);
  });

  it("excludes terminal submissions from active queues and progress while retaining history", async () => {
    const submissions = new WorkspaceBatchSource([
      submission,
      { ...submission, id: "submission-withdrawn", status: "withdrawn" },
    ]);
    const { service, repository } = await fixture({
      submissions,
      reviewsPerSubmission: 2,
      maxAssignmentsPerReviewer: 2,
    });
    const activeAssignment = await assignOne(service, "reviewer-1");
    const withdrawnAssignment: EvaluationAssignment = {
      ...activeAssignment,
      id: "assignment-withdrawn",
      submissionId: "submission-withdrawn",
      reviewerId: "reviewer-2",
    };
    await repository.putAssignmentsForTesting([withdrawnAssignment]);
    await repository.putReviewForTesting({
      id: "review-withdrawn",
      tenantId,
      eventId,
      planId: "plan-1",
      roundId: round.id,
      assignmentId: withdrawnAssignment.id,
      submissionId: withdrawnAssignment.submissionId,
      reviewerId: withdrawnAssignment.reviewerId,
      scores: {},
      comment: "Historical draft remains stored.",
      submittedAt: null,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    await expect(service.listReviewerWorkspace(reviewer("reviewer-2"), eventId)).resolves.toEqual({
      assignments: [],
    });
    await expect(service.listOrganizerAssignments(organizer, "plan-1")).resolves.toEqual([
      expect.objectContaining({ id: activeAssignment.id }),
    ]);
    await expect(service.getProgress(organizer, "plan-1")).resolves.toMatchObject({
      total: 1,
      assigned: 1,
    });
    await expect(repository.getAssignment(tenantId, withdrawnAssignment.id)).resolves.toMatchObject(
      {
        id: withdrawnAssignment.id,
        status: "assigned",
      },
    );
    await expect(repository.getReview(tenantId, withdrawnAssignment.id)).resolves.toMatchObject({
      id: "review-withdrawn",
    });
    await expect(
      service.getReviewContext(reviewer("reviewer-2"), withdrawnAssignment.id),
    ).rejects.toMatchObject({ code: "EVALUATION_NOT_FOUND" });
  });

  it("blocks reviewer reads and writes while legacy lineage repair is unresolved", async () => {
    const repository = new PendingLineageRepairRepository();
    const { service } = await fixture({ reviewsPerSubmission: 1, repository });
    const assignment = await assignOne(service);

    await expectEvaluationError(
      service.listReviewerWorkspace(reviewer("reviewer-1"), eventId),
      "EVALUATION_CONFLICT",
    );
    await expectEvaluationError(
      service.saveReview(reviewer("reviewer-1"), assignment.id, {
        scores: [{ criterionId: "quality", value: 4, origin: "human" }],
      }),
      "EVALUATION_CONFLICT",
    );
  });

  it("rejects a review save when assignment supersession wins the commit race", async () => {
    const repository = new RacingReviewAdmissionRepository();
    const { service } = await fixture({ reviewsPerSubmission: 1, repository });
    const assignment = await assignOne(service);
    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
    });
    repository.supersedeBeforeReviewWrite = true;

    await expectEvaluationError(
      service.saveReview(reviewer("reviewer-1"), assignment.id, {
        scores: [{ criterionId: "quality", value: 5, origin: "human" }],
        expectedVersion: draft.version,
      }),
      "EVALUATION_CONFLICT",
    );
    await expect(repository.getReview(tenantId, assignment.id)).resolves.toMatchObject({
      version: draft.version,
    });
  });

  it("rejects AI suggestion persistence when plan close wins the provider race", async () => {
    const repository = new RacingReviewAdmissionRepository();
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      repository,
      reviewRound: triageRound,
      aiSuggestionProvider: {
        suggest: async () => ({
          candidates: validAiCandidates(),
        }),
      },
    });
    repository.closeBeforeSuggestionWrite = true;

    await expectEvaluationError(generateTriage(service), "EVALUATION_CLOSED");
    await expect(repository.listSuggestions(tenantId, plan.id)).resolves.toEqual([]);
  });

  it("blocks reviewer reads and writes while legacy lineage repair is unresolved", async () => {
    const repository = new PendingLineageRepairRepository();
    const { service } = await fixture({ reviewsPerSubmission: 1, repository });
    const assignment = await assignOne(service);

    await expectEvaluationError(
      service.listReviewerWorkspace(reviewer("reviewer-1"), eventId),
      "EVALUATION_CONFLICT",
    );
    await expectEvaluationError(
      service.saveReview(reviewer("reviewer-1"), assignment.id, {
        scores: [{ criterionId: "quality", value: 4, origin: "human" }],
      }),
      "EVALUATION_CONFLICT",
    );
  });

  it("rejects a review save when assignment supersession wins the commit race", async () => {
    const repository = new RacingReviewAdmissionRepository();
    const { service } = await fixture({ reviewsPerSubmission: 1, repository });
    const assignment = await assignOne(service);
    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
    });
    repository.supersedeBeforeReviewWrite = true;

    await expectEvaluationError(
      service.saveReview(reviewer("reviewer-1"), assignment.id, {
        scores: [{ criterionId: "quality", value: 5, origin: "human" }],
        expectedVersion: draft.version,
      }),
      "EVALUATION_CONFLICT",
    );
    await expect(repository.getReview(tenantId, assignment.id)).resolves.toMatchObject({
      version: draft.version,
    });
  });

  it("rejects AI suggestion persistence when plan close wins the provider race", async () => {
    const repository = new RacingReviewAdmissionRepository();
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      repository,
      reviewRound: triageRound,
      aiSuggestionProvider: {
        suggest: async () => ({
          candidates: validAiCandidates(),
        }),
      },
    });
    repository.closeBeforeSuggestionWrite = true;

    await expectEvaluationError(generateTriage(service), "EVALUATION_CLOSED");
    await expect(repository.listSuggestions(tenantId, plan.id)).resolves.toEqual([]);
  });

  it("excludes decided submissions from reviewer queues while retaining organizer facts", async () => {
    const { service, repository } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "rejected",
      reason: "The program committee reached a final decision.",
      idempotencyKey: "terminal-review-decision",
    });

    await expect(
      service.listReviewerAssignments(reviewer("reviewer-1"), "plan-1"),
    ).resolves.toEqual([]);
    await expect(service.getOrganizerWorkspace(organizer, eventId)).resolves.toMatchObject({
      assignments: [
        {
          id: assignment.id,
          submissionId: submission.id,
          reviewerId: "reviewer-1",
          status: "assigned",
        },
      ],
      progress: { total: 1, assigned: 1, completionPercent: 0 },
      aggregates: expect.arrayContaining([
        expect.objectContaining({
          submissionId: submission.id,
          roundId: round.id,
          submittedReviewCount: 0,
          expectedReviewCount: 1,
        }),
      ]),
      decisions: { [submission.id]: { status: "rejected" } },
    });
    await expect(repository.getAssignment(tenantId, assignment.id)).resolves.toMatchObject({
      id: assignment.id,
      status: "assigned",
    });
    await expect(
      service.assignReviewers(organizer, {
        planId: "plan-1",
        roundId: round.id,
        submissionId: submission.id,
        reviewerIds: ["reviewer-2"],
      }),
    ).rejects.toMatchObject({ code: "EVALUATION_CONFLICT" });
  });

  it("denies historical terminal CFP outcomes from a new review plan", async () => {
    const submissions = new InMemorySubmissionReviewSource([
      {
        ...submission,
        id: "submission-accepted",
        status: "accepted",
        title: "Accepted in an earlier CFP workflow",
      },
    ]);
    const { service, plan } = await fixture({
      submissions,
    });

    await expect(
      service.assignReviewers(organizer, {
        planId: plan.id,
        roundId: plan.rounds[0]?.id ?? "",
        submissionId: "submission-accepted",
        reviewerIds: ["reviewer-1"],
      }),
    ).rejects.toMatchObject({ code: "EVALUATION_NOT_FOUND" });
    await expect(service.getOrganizerWorkspace(organizer, eventId, plan.id)).resolves.toMatchObject(
      {
        submissions: [],
        assignments: [],
        decisions: {},
      },
    );
  });

  it("supports an empty replacement and removes organizer and reviewer projections", async () => {
    const { service, repository } = await fixture();
    const assignment = await assignOne(service);
    await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
    });

    await service.assignReviewers(organizer, {
      planId: "plan-1",
      roundId: round.id,
      submissionId: submission.id,
      reviewerIds: [],
    });

    await expect(repository.getAssignment(tenantId, assignment.id)).resolves.toMatchObject({
      status: "superseded",
      supersededReason: expect.any(String),
    });
    await expect(repository.getReview(tenantId, assignment.id)).resolves.toMatchObject({
      assignmentId: assignment.id,
    });
    await expect(service.listReviewerWorkspace(reviewer("reviewer-1"), eventId)).resolves.toEqual({
      assignments: [],
    });
    await expect(service.getOrganizerWorkspace(organizer, eventId)).resolves.toMatchObject({
      assignments: [],
      progress: { total: 0, completionPercent: 0 },
    });
  });

  it("retains replacement lineage and review evidence while isolating reviewer workspaces", async () => {
    const { service, repository } = await fixture({ reviewsPerSubmission: 2 });
    const original = await assignOne(service, "reviewer-1");
    const review = await service.saveReview(reviewer("reviewer-1"), original.id, {
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
      comment: "Retained evidence.",
    });
    const currentAssignment = await repository.getAssignment(tenantId, original.id);
    if (currentAssignment === null) throw new Error("Expected retained assignment fixture.");

    const result = await service.replaceAssignment(organizer, original.id, {
      replacementReviewerId: "reviewer-2",
      expectedVersion: currentAssignment.version,
      reason: "Reviewer conflict disclosed after assignment.",
    });

    expect(result.replacedAssignment).toMatchObject({
      id: original.id,
      status: "superseded",
      successorAssignmentId: result.successorAssignment.id,
      supersededReason: "Reviewer conflict disclosed after assignment.",
    });
    expect(result.replacedAssignment.lineage).toMatchObject({
      predecessorAssignmentId: null,
      successorAssignmentId: result.successorAssignment.id,
      reason: "Reviewer conflict disclosed after assignment.",
    });
    expect(result.successorAssignment).toMatchObject({
      reviewerId: "reviewer-2",
      predecessorAssignmentId: original.id,
      status: "assigned",
    });
    expect(result.successorAssignment.lineage).toMatchObject({
      predecessorAssignmentId: original.id,
      successorAssignmentId: null,
      reason: "Reviewer conflict disclosed after assignment.",
    });
    expect(result.history).toEqual([
      expect.objectContaining({
        assignment: expect.objectContaining({ id: original.id, status: "superseded" }),
        review: expect.objectContaining({ id: review.id, assignmentId: original.id }),
      }),
    ]);
    await expect(repository.getReview(tenantId, original.id)).resolves.toMatchObject({
      id: review.id,
    });
    await expect(service.listReviewerWorkspace(reviewer("reviewer-1"), eventId)).resolves.toEqual({
      assignments: [],
    });
    await expect(
      service.listReviewerWorkspace(reviewer("reviewer-2"), eventId),
    ).resolves.toMatchObject({
      assignments: [
        expect.objectContaining({
          assignment: expect.objectContaining({ id: result.successorAssignment.id }),
        }),
      ],
    });
    await expect(service.getOrganizerWorkspace(organizer, eventId)).resolves.toMatchObject({
      assignments: [
        expect.objectContaining({ id: result.successorAssignment.id, status: "assigned" }),
      ],
    });
    const organizerRecords = await repository.listOrganizerWorkspaceRecords(tenantId, eventId);
    expect(organizerRecords.assignments.map((candidate) => candidate.id)).toEqual([
      result.successorAssignment.id,
    ]);
    expect(organizerRecords.reviews).toEqual([
      expect.objectContaining({ assignmentId: original.id, id: review.id }),
    ]);
  });

  it("rejects a stale replacement without mutating the retained assignment or review", async () => {
    const { service, repository } = await fixture();
    const original = await assignOne(service, "reviewer-1");
    const draft = await service.saveReview(reviewer("reviewer-1"), original.id, {
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
    });
    const currentAssignment = await repository.getAssignment(tenantId, original.id);
    if (currentAssignment === null) throw new Error("Expected retained assignment fixture.");
    await service.replaceAssignment(organizer, original.id, {
      replacementReviewerId: "reviewer-2",
      expectedVersion: currentAssignment.version,
      reason: "Replace the first reviewer.",
    });

    await expectEvaluationError(
      service.replaceAssignment(organizer, original.id, {
        replacementReviewerId: "reviewer-3",
        expectedVersion: original.version,
        reason: "Stale replacement attempt.",
      }),
      "EVALUATION_CONFLICT",
    );
    await expect(repository.getAssignment(tenantId, original.id)).resolves.toMatchObject({
      status: "superseded",
      successorAssignmentId: expect.any(String),
    });
    await expect(repository.getReview(tenantId, original.id)).resolves.toMatchObject({
      id: draft.id,
      assignmentId: original.id,
    });
  });

  it("reports distribution deficits and reviewer exclusions", async () => {
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      maxAssignmentsPerReviewer: 1,
    });
    const assignment = await assignOne(service, "reviewer-1");
    await service.declareConflict(
      reviewer("reviewer-1"),
      assignment.id,
      "Reviewer has a conflict.",
    );

    const preview = await service.previewDistribution(organizer, {
      planId: plan.id,
      roundId: round.id,
      submissionIds: [submission.id],
      reviewerIds: ["reviewer-1"],
      expectedVersion: plan.version,
    });

    expect(preview.desiredAssignments).toEqual([]);
    expect(preview.deficits).toEqual([
      {
        submissionId: submission.id,
        missingReviewCount: 1,
        reason: "insufficient_eligible_reviewers",
      },
    ]);
    expect(preview.exclusions).toEqual([
      {
        submissionId: submission.id,
        reviewerId: "reviewer-1",
        reason: "declared_conflict",
      },
    ]);
  });
  it("reports track-filter exclusions without creating assignments", async () => {
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      maxAssignmentsPerReviewer: 2,
      submissionMaterial: { ...submission, trackIds: ["track-other"] },
      reviewRound: { ...round, trackFilter: "track-required" },
    });

    const preview = await service.previewDistribution(organizer, {
      planId: plan.id,
      roundId: round.id,
      submissionIds: [submission.id],
      reviewerIds: ["reviewer-1"],
      expectedVersion: plan.version,
    });

    expect(preview.desiredAssignments).toEqual([]);
    expect(preview.deficits).toEqual([
      {
        submissionId: submission.id,
        missingReviewCount: 1,
        reason: "submission_outside_track",
      },
    ]);
    expect(preview.exclusions).toEqual([
      {
        submissionId: submission.id,
        reviewerId: "reviewer-1",
        reason: "outside_track",
      },
    ]);
  });
  it("produces deterministic distribution fingerprints and rejects stale applies", async () => {
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      maxAssignmentsPerReviewer: 2,
    });
    const preview = await service.previewDistribution(organizer, {
      planId: plan.id,
      roundId: round.id,
      submissionIds: [submission.id, "submission-2"],
      reviewerIds: ["reviewer-2", "reviewer-1"],
      expectedVersion: plan.version,
    });
    const reordered = await service.previewDistribution(organizer, {
      planId: plan.id,
      roundId: round.id,
      submissionIds: ["submission-2", submission.id],
      reviewerIds: ["reviewer-1", "reviewer-2"],
      expectedVersion: plan.version,
    });
    expect(reordered).toEqual(preview);
    expect(preview.desiredAssignments).toEqual([
      expect.objectContaining({ submissionId: submission.id, reviewerId: "reviewer-1" }),
      expect.objectContaining({ submissionId: "submission-2", reviewerId: "reviewer-2" }),
    ]);
    expect(preview.deficits).toEqual([]);
    expect(preview.exclusions).toEqual([]);
    expect(preview.fingerprint).toEqual(expect.any(String));
    expect(preview.fingerprint.length).toBeGreaterThan(0);

    await assignOne(service, "reviewer-1");
    await expectEvaluationError(
      service.applyDistribution(organizer, {
        planId: plan.id,
        roundId: round.id,
        submissionIds: [submission.id, "submission-2"],
        reviewerIds: ["reviewer-1", "reviewer-2"],
        expectedVersion: plan.version,
        fingerprint: preview.fingerprint,
      }),
      "EVALUATION_CONFLICT",
    );
  });
  it("applies a submission-scoped distribution without touching unrelated assignments", async () => {
    const { service, repository, plan } = await fixture({
      reviewsPerSubmission: 1,
      maxAssignmentsPerReviewer: 2,
    });
    const unrelated = await service.assignReviewers(organizer, {
      planId: plan.id,
      roundId: round.id,
      submissionId: "submission-2",
      reviewerIds: ["reviewer-9"],
    });
    const preview = await service.previewDistribution(organizer, {
      planId: plan.id,
      roundId: round.id,
      submissionIds: [submission.id],
      reviewerIds: ["reviewer-1"],
      expectedVersion: plan.version,
    });

    await expect(
      service.applyDistribution(organizer, {
        planId: plan.id,
        roundId: round.id,
        submissionIds: [submission.id],
        reviewerIds: ["reviewer-1"],
        expectedVersion: plan.version,
        fingerprint: preview.fingerprint,
      }),
    ).resolves.toMatchObject({
      activeAssignments: [
        expect.objectContaining({
          submissionId: submission.id,
          reviewerId: "reviewer-1",
        }),
      ],
    });
    await expect(repository.getAssignment(tenantId, unrelated[0]?.id ?? "")).resolves.toMatchObject(
      {
        status: "assigned",
        submissionId: "submission-2",
        reviewerId: "reviewer-9",
      },
    );
  });
  it("denies unassigned and cross-tenant reviewers", async () => {
    const { service } = await fixture();
    const assignment = await assignOne(service);

    await expectEvaluationError(
      service.getReviewContext(reviewer("reviewer-2"), assignment.id),
      "EVALUATION_FORBIDDEN",
    );
    await expectEvaluationError(
      service.getReviewContext(reviewer("reviewer-1", "tenant-2"), assignment.id),
      "EVALUATION_NOT_FOUND",
    );
  });

  it("redacts identity fields and participants in blind rounds", async () => {
    const { plan, service } = await fixture({ blindReview: true });
    expect(plan.reviewerProjection).toEqual({ fieldIds: [], fileIds: [] });
    const assignment = await assignOne(service);

    const context = await service.getReviewContext(reviewer("reviewer-1"), assignment.id);

    expect(context.submission).toEqual({
      id: submission.id,
      title: submission.title,
      abstract: submission.abstract,
      answers: {},
      participants: [],
      files: [],
      identityRedacted: true,
    });
    expect(JSON.stringify(context)).not.toContain("speaker@example.com");
    expect(JSON.stringify(context)).not.toContain("Speaker Name");
  });

  it("exposes identity only when blind review is disabled", async () => {
    const { service } = await fixture({ blindReview: false });
    const assignment = await assignOne(service);

    const context = await service.getReviewContext(reviewer("reviewer-1"), assignment.id);

    expect(context.submission.identityRedacted).toBe(false);
    expect(context.submission.participants[0]?.email).toBe("speaker@example.com");
    expect(context.submission.answers).toEqual({});
    expect(context.submission.files).toEqual([]);
  });

  it("exposes only explicitly allowlisted answers and files", async () => {
    const { service } = await fixture({
      blindReview: false,
      reviewerProjection: { fieldIds: ["experience"], fileIds: ["file-1"] },
      submissionMaterial: {
        ...submission,
        files: [
          {
            id: "file-1",
            name: "allowed.pdf",
            mimeType: "application/pdf",
            sizeBytes: 12,
          },
          {
            id: "file-2",
            name: "private.pdf",
            mimeType: "application/pdf",
            sizeBytes: 24,
          },
        ],
      },
    });
    const assignment = await assignOne(service);

    const context = await service.getReviewContext(reviewer("reviewer-1"), assignment.id);

    expect(context.submission.answers).toEqual({ experience: "Advanced" });
    expect(context.submission.files).toEqual([
      {
        id: "file-1",
        name: "allowed.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12,
      },
    ]);
    expect(context.submission.answers).not.toHaveProperty("speakerEmail");
    expect(JSON.stringify(context.submission)).not.toContain("private.pdf");
  });
  it("batches reviewer workspace reads concurrently with stable ordering and safe errors", async () => {
    const repository = new WorkspaceBatchRepository();
    const submissions = new WorkspaceBatchSource([
      { ...submission, version: 3 },
      { ...submission, id: "submission-2", title: "Another session", version: 4 },
    ]);
    const { service } = await fixture({
      repository,
      submissions,
      reviewsPerSubmission: 1,
      maxAssignmentsPerReviewer: 2,
    });
    await assignOne(service);
    await service.assignReviewers(organizer, {
      planId: "plan-1",
      roundId: round.id,
      submissionId: "submission-2",
      reviewerIds: ["reviewer-1"],
    });
    repository.resetCounts();
    submissions.resetCounts();

    let releaseBatchReads = () => {};
    repository.batchGate = new Promise<void>((resolve) => {
      releaseBatchReads = resolve;
    });
    const pending = service.listReviewerWorkspace(reviewer("reviewer-1"), eventId);

    expect(repository.planListCalls).toBe(1);
    expect(repository.workspaceCalls).toBe(1);
    releaseBatchReads();
    const workspace = await pending;

    expect(repository.assignmentListCalls).toBe(0);
    expect(repository.reviewListCalls).toBe(0);
    expect(repository.successorCalls).toBe(0);
    expect(submissions.singleCalls).toBe(0);
    expect(submissions.batchCalls).toBe(1);
    expect(submissions.lastLookups).toEqual([
      { eventId, submissionId: "submission-1" },
      { eventId, submissionId: "submission-2" },
    ]);
    expect(workspace.assignments.map((entry) => entry.submission.title)).toEqual([
      "A useful session",
      "Another session",
    ]);
    expect(
      workspace.assignments.every(
        (entry) =>
          entry.assignment.tenantId === tenantId &&
          entry.submission.participants.length === 0 &&
          !JSON.stringify(entry.submission).includes("speaker@example.com"),
      ),
    ).toBe(true);

    repository.batchGate = null;
    submissions.omitMaterials = true;
    await expectEvaluationError(
      service.listReviewerWorkspace(reviewer("reviewer-1"), eventId),
      "EVALUATION_NOT_FOUND",
    );

    submissions.omitMaterials = false;
    const failure = new Error("workspace source unavailable");
    submissions.failure = failure;
    await expect(service.listReviewerWorkspace(reviewer("reviewer-1"), eventId)).rejects.toBe(
      failure,
    );
  });
  it("starts organizer hydration while plan discovery is gated and uses authoritative review progress", async () => {
    const repository = new WorkspaceBatchRepository();
    const submissions = new WorkspaceBatchSource([
      submission,
      { ...submission, id: "submission-2", title: "Another session" },
    ]);
    const { service } = await fixture({
      repository,
      submissions,
      reviewsPerSubmission: 1,
      maxAssignmentsPerReviewer: 2,
    });
    const assignment = await assignOne(service);
    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      scores: [
        { criterionId: "quality", value: 4, origin: "human" },
        { criterionId: "relevance", value: 8, origin: "human" },
      ],
    });
    await service.submitReview(reviewer("reviewer-1"), assignment.id, draft.version);
    await repository.putDecisionForTesting({
      id: "decision-1",
      tenantId,
      eventId,
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      version: 1,
      history: [],
      updatedAt: nowIso,
    });
    await repository.putAssignmentsForTesting([
      { ...assignment, id: "assignment-other-event", eventId: "event-2" },
      { ...assignment, id: "assignment-other-tenant", tenantId: "tenant-2" },
    ]);
    repository.resetCounts();
    submissions.resetCounts();

    let releaseBatchReads = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseBatchReads = resolve;
    });
    repository.planGate = gate;
    repository.batchGate = gate;
    submissions.organizerBatchGate = gate;
    const planListStarted = new Promise<void>((resolve) => {
      repository.planListStarted = resolve;
    });
    const organizerWorkspaceStarted = new Promise<void>((resolve) => {
      repository.organizerWorkspaceStarted = resolve;
    });
    const organizerListStarted = new Promise<void>((resolve) => {
      submissions.organizerListStarted = resolve;
    });
    const pending = service.getOrganizerWorkspace(organizer, eventId);
    await Promise.all([planListStarted, organizerWorkspaceStarted, organizerListStarted]);

    expect(repository.planListCalls).toBe(1);
    expect(repository.organizerWorkspaceCalls).toBe(1);
    expect(submissions.organizerListCalls).toBe(1);
    releaseBatchReads();
    const workspace = await pending;

    expect(repository.assignmentListCalls).toBe(0);
    expect(repository.reviewListCalls).toBe(0);
    expect(repository.decisionCalls).toBe(0);
    expect(workspace.plan.id).toBe("plan-1");
    expect(workspace.submissions.map((entry) => entry.id)).toEqual([
      "submission-1",
      "submission-2",
    ]);
    expect(workspace.assignments).toHaveLength(1);
    expect(workspace.assignments[0]).toMatchObject({
      id: assignment.id,
      status: "submitted",
      tenantId,
      eventId,
      planId: "plan-1",
    });
    expect(workspace.progress).toMatchObject({
      total: 1,
      assigned: 0,
      submitted: 1,
      completionPercent: 100,
    });
    expect(workspace.aggregates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          submissionId: submission.id,
          roundId: round.id,
          submittedReviewCount: 1,
        }),
        expect.objectContaining({
          submissionId: "submission-2",
          roundId: round.id,
          submittedReviewCount: 0,
        }),
      ]),
    );
    expect(workspace.decisions[submission.id]).toMatchObject({
      status: "accepted",
      submissionId: submission.id,
    });
  });
  it("rejects organizer workspaces when decision hydration fails without returning empty decisions", async () => {
    const repository = new WorkspaceBatchRepository();
    const submissions = new WorkspaceBatchSource([submission]);
    const { service } = await fixture({ repository, submissions, reviewsPerSubmission: 1 });
    await assignOne(service);
    repository.resetCounts();
    submissions.resetCounts();
    const decisionFailure = new Error("Decision row could not be decoded.");
    repository.organizerWorkspaceFailure = decisionFailure;

    await expect(service.getOrganizerWorkspace(organizer, eventId)).rejects.toBe(decisionFailure);

    expect(repository.planListCalls).toBe(1);
    expect(repository.organizerWorkspaceCalls).toBe(1);
    expect(repository.assignmentListCalls).toBe(0);
    expect(repository.reviewListCalls).toBe(0);
    expect(submissions.organizerListCalls).toBe(1);
  });

  it("includes only explicitly reviewable submissions in organizer workspaces", async () => {
    const submissions = new WorkspaceBatchSource([
      { ...submission, id: "submission-submitted", status: "submitted" },
      { ...submission, id: "submission-under-review", status: "under_review" },
      { ...submission, id: "submission-draft", status: "draft" },
      { ...submission, id: "submission-withdrawn", status: "withdrawn" },
    ]);
    const { service, repository } = await fixture({ submissions });
    await repository.putDecisionForTesting({
      id: "decision-orphan-withdrawn",
      tenantId,
      eventId,
      planId: "plan-1",
      submissionId: "submission-withdrawn",
      status: "rejected",
      version: 1,
      history: [],
      updatedAt: nowIso,
    });

    const workspace = await service.getOrganizerWorkspace(organizer, eventId);

    expect(workspace.submissions.map(({ id }) => id)).toEqual(["submission-submitted"]);
    expect(workspace.aggregates.map(({ submissionId }) => submissionId)).toEqual([
      "submission-submitted",
    ]);
    expect(workspace.decisions).toEqual({});
  });

  it("returns missing-plan deterministically when organizer hydration fails", async () => {
    const repository = new WorkspaceBatchRepository();
    repository.organizerWorkspaceFailure = new Error("Decision row could not be decoded.");
    const submissions = new WorkspaceBatchSource([submission]);
    const service = new EvaluationService(repository, submissions, evaluationEventSource());

    await expectEvaluationError(
      service.getOrganizerWorkspace(organizer, eventId),
      "EVALUATION_NOT_FOUND",
    );

    expect(repository.planListCalls).toBe(1);
    expect(repository.organizerWorkspaceCalls).toBe(1);
    expect(repository.assignmentListCalls).toBe(0);
    expect(repository.reviewListCalls).toBe(0);
    expect(submissions.organizerListCalls).toBe(1);
  });
  it("supersedes assignments and retains review evidence during organizer cleanup", async () => {
    const { service, repository } = await fixture({ reviewsPerSubmission: 2 });
    const assigned = await assignOne(service);

    await service.unassignAssignment(organizer, "plan-1", assigned.id);
    await expect(repository.getAssignment(tenantId, assigned.id)).resolves.toMatchObject({
      status: "superseded",
    });

    const inProgress = await assignOne(service, "reviewer-2");
    const draft = await service.saveReview(reviewer("reviewer-2"), inProgress.id, {
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
    });
    expect(draft.submittedAt).toBeNull();
    await expect(repository.getAssignment(tenantId, inProgress.id)).resolves.toMatchObject({
      status: "in_progress",
    });

    await service.unassignAssignment(organizer, "plan-1", inProgress.id);
    await expect(repository.getAssignment(tenantId, inProgress.id)).resolves.toMatchObject({
      status: "superseded",
    });
    await expect(repository.getReview(tenantId, inProgress.id)).resolves.toMatchObject({
      id: draft.id,
    });
    const reassigned = await assignOne(service, "reviewer-2");
    expect(reassigned).toMatchObject({ status: "assigned", version: 1 });
    expect(reassigned.id).not.toBe(inProgress.id);
    await expect(repository.getReview(tenantId, reassigned.id)).resolves.toBeNull();
  });
  it("allows organizer cleanup after the evaluation plan closes", async () => {
    const { plan, repository, service } = await fixture();
    const assignment = await assignOne(service);
    await service.closePlan(organizer, plan.id, plan.version, crypto.randomUUID());

    await service.unassignAssignment(organizer, plan.id, assignment.id);

    await expect(repository.getAssignment(tenantId, assignment.id)).resolves.toMatchObject({
      status: "superseded",
    });
  });

  it("requires organizer authorization and isolates plan, event, and tenant assignment scope", async () => {
    const { service, repository } = await fixture({ reviewsPerSubmission: 2 });
    const assignment = await assignOne(service);

    await expectEvaluationError(
      service.unassignAssignment(reviewer("reviewer-1"), "plan-1", assignment.id),
      "EVALUATION_FORBIDDEN",
    );
    await expectEvaluationError(
      service.unassignAssignment(organizer, "missing-plan", assignment.id),
      "EVALUATION_NOT_FOUND",
    );

    await repository.putAssignmentsForTesting([
      { ...assignment, id: "assignment-other-plan", planId: "plan-2" },
      { ...assignment, id: "assignment-other-event", eventId: "event-2" },
    ]);
    await expectEvaluationError(
      service.unassignAssignment(organizer, "plan-1", "assignment-other-plan"),
      "EVALUATION_NOT_FOUND",
    );
    await expectEvaluationError(
      service.unassignAssignment(organizer, "plan-1", "assignment-other-event"),
      "EVALUATION_NOT_FOUND",
    );
    await expectEvaluationError(
      service.unassignAssignment({ ...organizer, tenantId: "tenant-2" }, "plan-1", assignment.id),
      "EVALUATION_NOT_FOUND",
    );
  });

  it("supersedes submitted assignments while preserving review evidence", async () => {
    const { service, repository } = await fixture({ reviewsPerSubmission: 2 });
    const assignment = await assignOne(service);
    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      scores: [
        { criterionId: "quality", value: 4, origin: "human" },
        { criterionId: "relevance", value: 8, origin: "human" },
      ],
    });
    const submitted = await service.submitReview(
      reviewer("reviewer-1"),
      assignment.id,
      draft.version,
    );
    expect(submitted.submittedAt).not.toBeNull();

    await service.unassignAssignment(organizer, "plan-1", assignment.id);
    await expect(repository.getAssignment(tenantId, assignment.id)).resolves.toMatchObject({
      status: "superseded",
    });
    await expect(repository.getReview(tenantId, assignment.id)).resolves.toMatchObject({
      id: submitted.id,
      assignmentId: assignment.id,
    });

    const abstained = await assignOne(service, "reviewer-2");
    await repository.putAssignmentsForTesting([
      { ...abstained, id: "assignment-abstained", status: "abstained" },
    ]);
    await expectEvaluationError(
      service.unassignAssignment(organizer, "plan-1", "assignment-abstained"),
      "EVALUATION_CONFLICT",
    );

    const staleRepository = new StaleAssignmentRepository();
    const { service: staleService } = await fixture({
      repository: staleRepository,
      reviewsPerSubmission: 1,
    });
    const staleAssignment = await assignOne(staleService);
    const staleDraft = await staleService.saveReview(reviewer("reviewer-1"), staleAssignment.id, {
      scores: [
        { criterionId: "quality", value: 4, origin: "human" },
        { criterionId: "relevance", value: 8, origin: "human" },
      ],
    });
    await staleService.submitReview(reviewer("reviewer-1"), staleAssignment.id, staleDraft.version);
    await expect(
      staleService.getReviewContext(reviewer("reviewer-1"), staleAssignment.id),
    ).resolves.toMatchObject({
      assignment: { status: "submitted" },
    });
    await staleService.unassignAssignment(organizer, "plan-1", staleAssignment.id);
    await expect(staleRepository.listAssignments(tenantId, "plan-1")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: staleAssignment.id, status: "superseded" }),
      ]),
    );
  });
  it("rounds bounded completion percentages for display", async () => {
    const submissions = new InMemorySubmissionReviewSource([
      submission,
      { ...submission, id: "submission-2", title: "Another session" },
      { ...submission, id: "submission-3", title: "Third session" },
    ]);
    const { service } = await fixture({
      submissions,
      reviewsPerSubmission: 1,
      maxAssignmentsPerReviewer: 3,
    });
    const assignments = await Promise.all(
      ["submission-1", "submission-2", "submission-3"].map(async (submissionId) => {
        const result = await service.assignReviewers(organizer, {
          planId: "plan-1",
          roundId: round.id,
          submissionId,
          reviewerIds: ["reviewer-1"],
        });
        const assignment = result[0];
        if (assignment === undefined) throw new Error("Expected an assignment fixture.");
        return assignment;
      }),
    );
    for (const assignment of assignments.slice(0, 2)) {
      const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
        scores: [
          { criterionId: "quality", value: 4, origin: "human" },
          { criterionId: "relevance", value: 8, origin: "human" },
        ],
      });
      await service.submitReview(reviewer("reviewer-1"), assignment.id, draft.version);
    }

    await expect(service.getProgress(organizer, "plan-1")).resolves.toMatchObject({
      total: 3,
      submitted: 2,
      completionPercent: 67,
    });
  });
});

describe("evaluation temporal integrity", () => {
  it.each(["2026-08-10", "2026-08-10T12:00:00"])(
    "rejects evaluation boundaries without an explicit offset: %s",
    async (boundary) => {
      const service = new EvaluationService(
        new InMemoryEvaluationRepository(),
        new InMemorySubmissionReviewSource(),
        evaluationEventSource(),
        { clock: () => new Date(nowIso) },
      );

      await expect(
        service.createPlan(organizer, {
          id: `invalid-${boundary}`,
          eventId,
          name: "Invalid review boundary",
          blindReview: true,
          closesAt: boundary,
          assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 1 },
          rounds: [round],
        }),
      ).rejects.toMatchObject({ code: "EVALUATION_INVALID_INPUT" });
      await expect(
        service.createPlan(organizer, {
          id: `invalid-round-${boundary}`,
          eventId,
          name: "Invalid round boundary",
          blindReview: true,
          closesAt: "2026-08-12T12:00:00.000Z",
          assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 1 },
          rounds: [{ ...round, closesAt: boundary }],
        }),
      ).rejects.toMatchObject({ code: "EVALUATION_INVALID_INPUT" });
    },
  );

  it("normalizes alternate offsets before ordering, event-bound checks, and persistence", async () => {
    const service = new EvaluationService(
      new InMemoryEvaluationRepository(),
      new InMemorySubmissionReviewSource(),
      evaluationEventSource({ endsAt: "2026-08-11T12:00:00.000Z" }),
      { clock: () => new Date(nowIso) },
    );

    const created = await service.createPlan(organizer, {
      id: "offset-plan",
      eventId,
      name: "Offset review",
      blindReview: true,
      closesAt: "2026-08-11T08:00:00-04:00",
      assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 1 },
      rounds: [
        {
          ...round,
          opensAt: "2026-08-10T10:00:00+02:00",
          closesAt: "2026-08-10T08:30:00Z",
        },
      ],
    });

    expect(created.closesAt).toBe("2026-08-11T12:00:00.000Z");
    expect(created.rounds[0]?.opensAt).toBe("2026-08-10T08:00:00.000Z");
    expect(created.rounds[0]?.closesAt).toBe("2026-08-10T08:30:00.000Z");

    await expect(
      service.createPlan(organizer, {
        id: "offset-bypass-plan",
        eventId,
        name: "Late offset review",
        blindReview: true,
        closesAt: "2026-08-11T08:30:00-04:00",
        assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 1 },
        rounds: [round],
      }),
    ).rejects.toMatchObject({ code: "EVALUATION_INVALID_INPUT" });
  });

  it("rejects new review boundaries before today or after event end", async () => {
    const repository = new InMemoryEvaluationRepository();
    const service = new EvaluationService(
      repository,
      new InMemorySubmissionReviewSource(),
      evaluationEventSource({ endsAt: "2026-08-11T23:59:00.000Z" }),
      { clock: () => new Date(nowIso) },
    );

    await expect(
      service.createPlan(organizer, {
        id: "past-plan",
        eventId,
        name: "Past review",
        blindReview: true,
        closesAt: "2026-08-10T12:00:00.000Z",
        assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 1 },
        rounds: [{ ...round, closesAt: "2026-08-07T12:00:00.000Z" }],
      }),
    ).rejects.toMatchObject({ code: "EVALUATION_INVALID_INPUT" });

    await expect(
      service.createPlan(organizer, {
        id: "late-plan",
        eventId,
        name: "Late review",
        blindReview: true,
        closesAt: "2026-08-12T12:00:00.000Z",
        assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 1 },
        rounds: [{ ...round, closesAt: "2026-08-12T12:00:00.000Z" }],
      }),
    ).rejects.toMatchObject({ code: "EVALUATION_INVALID_INPUT" });
  });

  it("requires the overall deadline to cover the final round", async () => {
    const service = new EvaluationService(
      new InMemoryEvaluationRepository(),
      new InMemorySubmissionReviewSource(),
      evaluationEventSource(),
      { clock: () => new Date(nowIso) },
    );

    await expect(
      service.createPlan(organizer, {
        id: "short-plan",
        eventId,
        name: "Short plan",
        blindReview: true,
        closesAt: "2026-08-09T12:00:00.000Z",
        assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 1 },
        rounds: [round],
      }),
    ).rejects.toMatchObject({ code: "EVALUATION_INVALID_INPUT" });
  });

  it("preserves unchanged historical boundaries but rejects changed past values", async () => {
    let currentTime = new Date(nowIso);
    const service = new EvaluationService(
      new InMemoryEvaluationRepository(),
      new InMemorySubmissionReviewSource(),
      evaluationEventSource(),
      { clock: () => new Date(currentTime) },
    );
    const created = await service.createPlan(organizer, {
      id: "active-plan",
      eventId,
      name: "Active review",
      blindReview: true,
      closesAt: "2026-08-10T12:00:00.000Z",
      assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 1 },
      rounds: [round],
    });
    currentTime = new Date("2026-08-12T12:00:00.000Z");

    const unchanged = await service.updatePlan(organizer, created.id, {
      expectedVersion: created.version,
      name: created.name,
      blindReview: created.blindReview,
      closesAt: created.closesAt,
      assignmentRule: created.assignmentRule,
      rounds: created.rounds,
    });
    const unchangedRound = unchanged.rounds[0];
    if (unchangedRound === undefined) throw new Error("Expected the review round to exist.");
    await expect(
      service.updatePlan(organizer, unchanged.id, {
        expectedVersion: unchanged.version,
        name: unchanged.name,
        blindReview: unchanged.blindReview,
        closesAt: unchanged.closesAt,
        assignmentRule: unchanged.assignmentRule,
        rounds: [
          {
            ...unchangedRound,
            closesAt: "2026-08-11T12:00:00.000Z",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "EVALUATION_INVALID_INPUT" });
  });
});

describe("review drafts, AI assistance, and aggregates", () => {
  it("returns an empty aggregate when an assignment has no review record", async () => {
    const { service } = await fixture({ reviewsPerSubmission: 1 });
    await assignOne(service);

    await expect(
      service.getAggregate(organizer, "plan-1", round.id, submission.id),
    ).resolves.toMatchObject({
      submittedReviewCount: 0,
      expectedReviewCount: 1,
      averageWeightedTotal: null,
    });
  });
  it("returns all organizer aggregates in one batch", async () => {
    const { service } = await fixture({ reviewsPerSubmission: 1 });
    await assignOne(service);

    const aggregates = await service.listAggregates(organizer, "plan-1", round.id);
    expect(aggregates).toHaveLength(2);
    expect(aggregates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planId: "plan-1",
          roundId: round.id,
          submissionId: submission.id,
          submittedReviewCount: 0,
          expectedReviewCount: 1,
          averageWeightedTotal: null,
        }),
      ]),
    );
  });
  it("keys aggregates by round and rubric revision snapshots", async () => {
    const { service, repository, plan } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      scores: [
        { criterionId: "quality", value: 4, origin: "human" },
        { criterionId: "relevance", value: 8, origin: "human" },
      ],
    });
    await service.submitReview(reviewer("reviewer-1"), assignment.id, draft.version);

    const aggregate = await service.getAggregate(organizer, plan.id, round.id, submission.id);
    expect(aggregate).toMatchObject({
      roundRevision: expect.any(Number),
      rubricRevision: expect.any(Number),
      submittedReviewCount: 1,
    });

    const currentReview = await repository.getReview(tenantId, assignment.id);
    if (currentReview === null) throw new Error("Expected submitted review fixture.");
    await repository.putReviewForTesting({
      ...currentReview,
      roundRevision: aggregate.roundRevision + 1,
      rubricRevision: aggregate.rubricRevision + 1,
    });
    await expect(
      service.getAggregate(organizer, plan.id, round.id, submission.id),
    ).resolves.toMatchObject({
      roundRevision: aggregate.roundRevision,
      rubricRevision: aggregate.rubricRevision,
      submittedReviewCount: 0,
      averageWeightedTotal: null,
    });
  });
  it("never exposes shared AI suggestions to reviewers and never counts them in aggregates", async () => {
    const { service } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => ({ candidates: validAiCandidates() }),
    });
    const assignment = await assignOne(service);
    const actor = reviewer("reviewer-1");
    const suggestion = await generateTriage(service);

    const context = await service.getReviewContext(actor, assignment.id);
    expect(context).not.toHaveProperty("suggestions");
    expect(await service.getAggregate(organizer, "plan-1", round.id, submission.id)).toMatchObject({
      submittedReviewCount: 0,
      averageWeightedTotal: null,
    });
    expect(suggestion.assignmentId).toBeNull();
  });

  it("uses submitted reviews as the authoritative queue and progress state", async () => {
    const { service } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    const actor = reviewer("reviewer-1");
    const draft = await service.saveReview(actor, assignment.id, {
      scores: [
        { criterionId: "quality", value: 4, origin: "human" },
        { criterionId: "relevance", value: 8, origin: "human" },
      ],
    });

    const submitted = await service.submitReview(actor, assignment.id, draft.version);
    expect(submitted.submittedAt).not.toBeNull();
    await expect(service.getReviewContext(actor, assignment.id)).resolves.toMatchObject({
      assignment: { status: "submitted" },
      review: { submittedAt: submitted.submittedAt },
    });
    await expect(service.listReviewerAssignments(actor, "plan-1")).resolves.toMatchObject([
      { status: "submitted" },
    ]);
    await expect(service.listOrganizerAssignments(organizer, "plan-1")).resolves.toMatchObject([
      { status: "submitted" },
    ]);
    await expect(service.getProgress(organizer, "plan-1")).resolves.toMatchObject({
      total: 1,
      submitted: 1,
      completionPercent: 100,
      reviewers: [
        expect.objectContaining({
          reviewerId: actor.userId,
          assigned: 1,
          submitted: 1,
          outstanding: 0,
          completionPercent: 100,
        }),
      ],
    });
    await expect(service.submitReview(actor, assignment.id, draft.version)).resolves.toEqual(
      submitted,
    );
  });

  it("rejects an autosave when a conflict commits before the guarded review write", async () => {
    const submissions = new InMemorySubmissionReviewSource([submission]);
    const repository = new GatedReviewWriteRepository(submissions);
    const { service } = await fixture({
      reviewsPerSubmission: 1,
      repository,
      submissions,
    });
    const assignment = await assignOne(service);
    let releaseWrite!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      repository.writeEntered = resolve;
      repository.writeGate = new Promise<void>((resolveGate) => {
        releaseWrite = resolveGate;
      });
    });
    const save = service.saveReview(reviewer("reviewer-1"), assignment.id, {
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
    });

    await writeEntered;
    await service.declareConflict(reviewer("reviewer-1"), assignment.id, "Cannot review fairly.");
    releaseWrite();

    await expectEvaluationError(save, "EVALUATION_CONFLICT");
    await expect(repository.getReview(tenantId, assignment.id)).resolves.toBeNull();
  });

  it("rejects submission when withdrawal commits before the guarded review write", async () => {
    const submissions = new InMemorySubmissionReviewSource([submission]);
    const repository = new GatedReviewWriteRepository(submissions);
    const { service } = await fixture({
      reviewsPerSubmission: 1,
      repository,
      submissions,
    });
    const assignment = await assignOne(service);
    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      scores: [
        { criterionId: "quality", value: 4, origin: "human" },
        { criterionId: "relevance", value: 8, origin: "human" },
      ],
    });
    let releaseWrite!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      repository.writeEntered = resolve;
      repository.writeGate = new Promise<void>((resolveGate) => {
        releaseWrite = resolveGate;
      });
    });
    const submit = service.submitReview(reviewer("reviewer-1"), assignment.id, draft.version);

    await writeEntered;
    submissions.set({ ...submission, status: "withdrawn", version: (submission.version ?? 0) + 1 });
    releaseWrite();

    await expectEvaluationError(submit, "EVALUATION_CONFLICT");
    await expect(repository.getReview(tenantId, assignment.id)).resolves.toMatchObject({
      version: draft.version,
      submittedAt: null,
    });
  });

  it("does not expose assignments persisted for another event", async () => {
    const { service, repository } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    await repository.putAssignmentsForTesting([
      {
        ...assignment,
        id: "foreign-event-assignment",
        eventId: "event-other",
        submissionId: "submission-2",
      },
    ]);

    await expect(
      service.listReviewerAssignments(reviewer("reviewer-1"), "plan-1"),
    ).resolves.toEqual([assignment]);
    await expect(service.getProgress(organizer, "plan-1")).resolves.toMatchObject({
      total: 1,
    });
  });
  it("treats a human edit as authoritative and rejects stale autosaves", async () => {
    const { service } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    const actor = reviewer("reviewer-1");
    const first = await service.saveReview(actor, assignment.id, {
      scores: [
        {
          criterionId: "quality",
          value: 3,
          origin: "human",
        },
      ],
    });
    const edited = await service.saveReview(actor, assignment.id, {
      scores: [{ criterionId: "quality", value: 5, origin: "human" }],
      comment: "Updated after checking the rubric.",
      expectedVersion: first.version,
    });

    expect(edited.scores.quality).toMatchObject({
      value: 5,
      origin: "human",
    });
    await expectEvaluationError(
      service.saveReview(actor, assignment.id, {
        scores: [{ criterionId: "relevance", value: 7, origin: "human" }],
        expectedVersion: first.version,
      }),
      "EVALUATION_CONFLICT",
    );
  });

  it("blocks writes after a round closes", async () => {
    const { service, setTime } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    setTime("2026-08-10T12:00:00.000Z");

    await expectEvaluationError(
      service.saveReview(reviewer("reviewer-1"), assignment.id, {
        scores: [{ criterionId: "quality", value: 4, origin: "human" }],
      }),
      "EVALUATION_CLOSED",
    );
  });
});

describe("conflicts, progress, and decisions", () => {
  it("makes abstention remove submission access and excludes it from actionable progress", async () => {
    const { service } = await fixture({
      reviewsPerSubmission: 1,
      aiSuggestionProducer: async () => ({
        candidates: validAiCandidates(),
      }),
    });
    const assignment = await assignOne(service);
    const actor = reviewer("reviewer-1");
    await service.saveReview(actor, assignment.id, {
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
    });

    const declaration = await service.declareConflict(
      actor,
      assignment.id,
      "I collaborated with the submitter.",
    );

    expect(declaration.reviewerId).toBe(actor.userId);
    await expectEvaluationError(
      service.getReviewContext(actor, assignment.id),
      "EVALUATION_FORBIDDEN",
    );
    const progress = await service.getProgress(organizer, "plan-1");
    expect(progress).toMatchObject({
      planId: "plan-1",
      total: 1,
      assigned: 0,
      inProgress: 0,
      submitted: 0,
      abstained: 1,
      completionPercent: 0,
    });
    expect(progress.reviewers).toEqual([
      {
        planId: "plan-1",
        roundId: "round-1",
        reviewerId: "reviewer-1",
        assigned: 0,
        inProgress: 0,
        submitted: 0,
        abstained: 1,
        outstanding: 0,
        completionPercent: 0,
      },
    ]);
  });

  it("rejects an in-flight suggestion generation after a decision is recorded", async () => {
    let announceProviderStarted: () => void = () => {
      throw new Error("Provider start signal was not initialized.");
    };
    let releaseProvider: () => void = () => {
      throw new Error("Provider release signal was not initialized.");
    };
    const providerStarted = new Promise<void>((resolve) => {
      announceProviderStarted = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const { repository, service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => {
        announceProviderStarted();
        await providerGate;
        return { candidates: validAiCandidates() };
      },
    });
    await assignOne(service);
    const generation = generateTriage(service);
    await providerStarted;
    await service.recordDecision(organizer, {
      planId: plan.id,
      submissionId: submission.id,
      status: "accepted",
      reason: "Committee consensus reached.",
      idempotencyKey: crypto.randomUUID(),
    });
    releaseProvider();

    await expectEvaluationError(generation, "EVALUATION_CONFLICT");
    expect(await repository.listSuggestions(tenantId, plan.id)).toEqual([]);
  });

  it.each(["draft", "reopened", "withdrawn", "archived"])(
    "rejects %s submission material before provider invocation",
    async (status) => {
      let providerCalls = 0;
      const { repository, service, plan, submissions } = await fixture({
        reviewsPerSubmission: 1,
        reviewRound: triageRound,
        aiSuggestionProducer: async () => {
          providerCalls += 1;
          return { candidates: validAiCandidates() };
        },
      });
      submissions.set({ ...submission, status });

      await expectEvaluationError(generateTriage(service), "EVALUATION_CONFLICT");
      expect(providerCalls).toBe(0);
      expect(await repository.listSuggestions(tenantId, plan.id)).toEqual([]);
    },
  );

  it("rejects missing submission material before provider invocation", async () => {
    let providerCalls = 0;
    const { repository, service, plan, submissions } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => {
        providerCalls += 1;
        return { candidates: validAiCandidates() };
      },
    });
    submissions.delete(tenantId, submission.id);

    await expectEvaluationError(generateTriage(service), "EVALUATION_NOT_FOUND");
    expect(providerCalls).toBe(0);
    expect(await repository.listSuggestions(tenantId, plan.id)).toEqual([]);
  });

  it("rejects AI triage when the round has not enabled it and requires an organizer", async () => {
    const { service } = await fixture({
      reviewsPerSubmission: 1,
      aiSuggestionProducer: async () => ({ candidates: validAiCandidates() }),
    });
    await expectEvaluationError(generateTriage(service), "EVALUATION_FORBIDDEN");
    await expectEvaluationError(
      service.generateRoundAiSuggestions(reviewer("reviewer-1"), {
        planId: "plan-1",
        roundId: round.id,
        submissionId: submission.id,
      }),
      "EVALUATION_FORBIDDEN",
    );
  });

  it("rejects in-flight suggestion generation after submission withdrawal", async () => {
    let releaseProvider: () => void = () => {
      throw new Error("Provider release signal was not initialized.");
    };
    let announceProviderStarted: () => void = () => {
      throw new Error("Provider start signal was not initialized.");
    };
    const providerStarted = new Promise<void>((resolve) => {
      announceProviderStarted = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const { repository, service, plan, submissions } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => {
        announceProviderStarted();
        await providerGate;
        return { candidates: validAiCandidates() };
      },
    });
    const generation = generateTriage(service);
    await providerStarted;
    submissions.set({ ...submission, status: "withdrawn" });
    releaseProvider();

    await expectEvaluationError(generation, "EVALUATION_CONFLICT");
    expect(await repository.listSuggestions(tenantId, plan.id)).toEqual([]);
  });

  it("rejects incomplete acceptance before persisting a decision", async () => {
    const incomplete = {
      ...submission,
      title: "",
      abstract: "",
      participants: [],
    };
    const { service } = await fixture({ submissionMaterial: incomplete });

    await expectEvaluationError(
      service.recordDecision(organizer, {
        planId: "plan-1",
        submissionId: incomplete.id,
        status: "accepted",
        reason: "Committee consensus",
        idempotencyKey: "decision-incomplete",
      }),
      "EVALUATION_INVALID_INPUT",
    );
    await expect(service.getDecision(organizer, "plan-1", incomplete.id)).resolves.toBeNull();
  });
  it("accepts CFP submission identifiers up to the shared 128-character contract", async () => {
    const longSubmission = { ...submission, id: "s".repeat(101) };
    const { service } = await fixture({ submissionMaterial: longSubmission });

    await expect(
      service.recordDecision(organizer, {
        planId: "plan-1",
        submissionId: longSubmission.id,
        status: "accepted",
        reason: "Committee consensus",
        idempotencyKey: "decision-long-submission-id",
      }),
    ).resolves.toMatchObject({ submissionId: longSubmission.id, status: "accepted" });
    await expect(
      service.getDecision(organizer, "plan-1", longSubmission.id),
    ).resolves.toMatchObject({ submissionId: longSubmission.id });
  });
  it("allows only a human organizer to make idempotent, versioned decisions", async () => {
    const { service } = await fixture();
    const automation: EvaluationActor = {
      ...organizer,
      userId: "ai-agent",
      kind: "automation",
    };
    await expectEvaluationError(
      service.recordDecision(automation, {
        planId: "plan-1",
        submissionId: submission.id,
        status: "accepted",
        reason: "Model recommendation",
        idempotencyKey: "decision-1",
      }),
      "EVALUATION_FORBIDDEN",
    );

    const accepted = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "Committee consensus",
      idempotencyKey: "decision-1",
    });
    const replay = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "  Committee consensus  ",
      idempotencyKey: "decision-1",
    });
    await expectEvaluationError(
      service.recordDecision(organizer, {
        planId: "plan-1",
        submissionId: submission.id,
        status: "rejected",
        reason: "A different request must not reuse the key",
        idempotencyKey: "decision-1",
      }),
      "EVALUATION_CONFLICT",
    );
    const waitlisted = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "waitlisted",
      reason: "Capacity changed",
      idempotencyKey: "decision-2",
      expectedVersion: accepted.version,
    });

    expect(replay).toEqual(accepted);
    expect(waitlisted.status).toBe("waitlisted");
    expect(waitlisted.version).toBe(2);
    expect(waitlisted.history).toHaveLength(2);
    expect(waitlisted.history[1]).toMatchObject({
      from: "accepted",
      to: "waitlisted",
      decidedBy: organizer.userId,
    });
  });
});
describe("decision outcome projection", () => {
  it("rechecks the reviewable lifecycle status at the final decision boundary", async () => {
    const submissions = new (class extends InMemorySubmissionReviewSource {
      #reads = 0;

      override async getSubmissionForReview() {
        this.#reads += 1;
        return {
          ...submission,
          status: this.#reads === 1 ? "submitted" : "withdrawn",
        };
      }
    })([submission]);
    const { service, repository } = await fixture({ submissions });

    await expect(
      service.recordDecision(organizer, {
        planId: "plan-1",
        submissionId: submission.id,
        status: "rejected",
        reason: "The status changed while the organizer was deciding.",
        idempotencyKey: "final-boundary-status-recheck",
      }),
    ).rejects.toMatchObject({ code: "EVALUATION_NOT_FOUND" });
    await expect(repository.getDecision(tenantId, "plan-1", submission.id)).resolves.toBeNull();
  });

  it("does not replay historical projection side effects after a newer decision", async () => {
    const projected: EvaluationDecisionProjectionInput[] = [];
    const { service } = await fixture({
      decisionProjection: {
        projectDecision: async (input) => {
          const { isCurrentDecision: _isCurrentDecision, ...cloneable } = input;
          projected.push(structuredClone(cloneable));
        },
      },
    });
    const acceptedInput = {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted" as const,
      reason: "Accepted first.",
      idempotencyKey: "historical-replay-accepted",
    };
    const accepted = await service.recordDecision(organizer, acceptedInput);
    await service.replayPersistedDecisionWork({
      tenantId,
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      decisionVersion: accepted.version,
      transitionIdempotencyKey: "historical-replay-accepted",
    });
    const rejected = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "rejected",
      reason: "The final program changed.",
      idempotencyKey: "historical-replay-rejected",
      expectedVersion: accepted.version,
    });
    await service.replayPersistedDecisionWork({
      tenantId,
      planId: "plan-1",
      submissionId: submission.id,
      status: "rejected",
      decisionVersion: rejected.version,
      transitionIdempotencyKey: "historical-replay-rejected",
    });

    await expect(service.recordDecision(organizer, acceptedInput)).resolves.toEqual(rejected);
    await expect(
      service.replayPersistedDecisionWork({
        tenantId,
        planId: "plan-1",
        submissionId: submission.id,
        status: "accepted",
        decisionVersion: accepted.version,
        transitionIdempotencyKey: "historical-replay-accepted",
      }),
    ).resolves.toBeUndefined();
    expect(rejected).toMatchObject({ status: "rejected", version: 2 });
    expect(projected.map(({ status, decisionVersion }) => ({ status, decisionVersion }))).toEqual([
      { status: "accepted", decisionVersion: 1 },
      { status: "rejected", decisionVersion: 2 },
    ]);
  });

  it("replays persisted decision work after the submission becomes non-reviewable", async () => {
    const projected: EvaluationDecisionProjectionInput[] = [];
    const submissions = new InMemorySubmissionReviewSource([submission]);
    const { service, repository } = await fixture({
      submissions,
      decisionProjection: {
        projectDecision: async (input) => {
          const { isCurrentDecision: _isCurrentDecision, ...cloneable } = input;
          projected.push(structuredClone(cloneable));
        },
      },
    });
    const accepted = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "Accepted before the submission was withdrawn.",
      idempotencyKey: "replay-after-withdrawal",
    });
    projected.length = 0;
    submissions.set({ ...submission, status: "withdrawn", version: 2 });
    const replayedService = new EvaluationService(
      repository,
      submissions,
      evaluationEventSource(),
      {
        clock: () => new Date(nowIso),
        decisionProjection: {
          projectDecision: async (input) => {
            const { isCurrentDecision: _isCurrentDecision, ...cloneable } = input;
            projected.push(structuredClone(cloneable));
          },
        },
      },
    );

    await replayedService.replayPersistedDecisionWork({
      tenantId,
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      decisionVersion: accepted.version,
      transitionIdempotencyKey: "replay-after-withdrawal",
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ status: "accepted", decisionVersion: 1 });
  });

  it("allows exactly one concurrent amendment for the current version", async () => {
    const { service } = await fixture();
    const accepted = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "Accepted before concurrent amendments.",
      idempotencyKey: "concurrent-amendment-initial",
    });
    const amendments = await Promise.allSettled([
      service.recordDecision(organizer, {
        planId: "plan-1",
        submissionId: submission.id,
        status: "waitlisted",
        reason: "Concurrent amendment one.",
        idempotencyKey: "concurrent-amendment-one",
        expectedVersion: accepted.version,
      }),
      service.recordDecision(organizer, {
        planId: "plan-1",
        submissionId: submission.id,
        status: "rejected",
        reason: "Concurrent amendment two.",
        idempotencyKey: "concurrent-amendment-two",
        expectedVersion: accepted.version,
      }),
    ]);
    const fulfilled = amendments.filter((result) => result.status === "fulfilled");
    const rejected = amendments.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    if (fulfilled[0]?.status !== "fulfilled") {
      throw new Error("Expected one concurrent amendment to succeed.");
    }
    expect(fulfilled[0].value.version).toBe(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "EVALUATION_CONFLICT" });
    await expect(service.getDecision(organizer, "plan-1", submission.id)).resolves.toEqual(
      fulfilled[0].value,
    );
  });

  it("keeps accepted and rejected outcomes version-safe across the production lifecycle", async () => {
    const projected: EvaluationDecisionProjectionInput[] = [];
    const schedulableSessions = new Set<string>();
    const { service } = await fixture({
      decisionProjection: {
        projectDecision: async (input) => {
          const { isCurrentDecision: _isCurrentDecision, ...cloneable } = input;
          projected.push(structuredClone(cloneable));
        },
      },
      acceptanceHandoff: {
        accept: async (input) => {
          schedulableSessions.add(input.submissionId);
        },
      },
    });

    const accepted = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "Accepted for the final program.",
      idempotencyKey: "production-decision-a",
    });
    await service.replayPersistedDecisionWork({
      tenantId,
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      decisionVersion: accepted.version,
      transitionIdempotencyKey: "production-decision-a",
    });
    const replay = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "Accepted for the final program.",
      idempotencyKey: "production-decision-a",
    });
    const rejected = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: "submission-2",
      status: "rejected",
      reason: "The proposal does not fit the final program.",
      idempotencyKey: "production-decision-b",
    });
    await service.replayPersistedDecisionWork({
      tenantId,
      planId: "plan-1",
      submissionId: "submission-2",
      status: "rejected",
      decisionVersion: rejected.version,
      transitionIdempotencyKey: "production-decision-b",
    });
    const staleResults = await Promise.allSettled([
      service.recordDecision(organizer, {
        planId: "plan-1",
        submissionId: submission.id,
        status: "accepted",
        reason: "Stale concurrent amendment one.",
        idempotencyKey: "production-decision-a-stale-1",
        expectedVersion: 0,
      }),
      service.recordDecision(organizer, {
        planId: "plan-1",
        submissionId: submission.id,
        status: "accepted",
        reason: "Stale concurrent amendment two.",
        idempotencyKey: "production-decision-a-stale-2",
        expectedVersion: 0,
      }),
    ]);

    expect(replay).toEqual(accepted);
    expect(accepted).toMatchObject({ status: "accepted", version: 1 });
    expect(rejected).toMatchObject({ status: "rejected", version: 1 });
    expect(staleResults.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of staleResults) {
      if (result.status === "fulfilled") throw new Error("Expected the stale decision to fail.");
      expect(result.reason).toMatchObject({ code: "EVALUATION_CONFLICT" });
    }
    await expect(service.getDecision(organizer, "plan-1", submission.id)).resolves.toEqual(
      accepted,
    );
    await expect(service.getDecision(organizer, "plan-1", "submission-2")).resolves.toEqual(
      rejected,
    );
    expect(projected).toHaveLength(2);
    expect(
      projected.map(({ submissionId, participantProjection, communication }) => ({
        submissionId,
        status: participantProjection.status,
        templatePurpose: communication.templatePurpose,
      })),
    ).toEqual([
      {
        submissionId: submission.id,
        status: "accepted",
        templatePurpose: "decision_accepted",
      },
      {
        submissionId: "submission-2",
        status: "rejected",
        templatePurpose: "decision_rejected",
      },
    ]);
    expect([...schedulableSessions]).toEqual([submission.id]);
    expect(schedulableSessions.has("submission-2")).toBe(false);
  });

  it("projects every human outcome, onboards only acceptance, and versions handoffs", async () => {
    const projected: EvaluationDecisionProjectionInput[] = [];
    const onboarded: unknown[] = [];
    const reconciled: EvaluationSessionDecisionReconciliationInput[] = [];
    const { service } = await fixture({
      decisionProjection: {
        projectDecision: async (input) => {
          const { isCurrentDecision: _isCurrentDecision, ...cloneable } = input;
          projected.push(structuredClone(cloneable));
        },
      },
      acceptanceHandoff: {
        accept: async (input) => {
          const { isCurrentDecision: _isCurrentDecision, ...cloneable } = input;
          onboarded.push(structuredClone(cloneable));
        },
        reconcileSessionDecision: async (input) => {
          const { isCurrentDecision: _isCurrentDecision, ...cloneable } = input;
          reconciled.push(structuredClone(cloneable));
        },
      },
    });

    const accepted = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "Committee consensus",
      idempotencyKey: "decision-1",
    });
    await service.replayPersistedDecisionWork({
      tenantId,
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      decisionVersion: accepted.version,
      transitionIdempotencyKey: "decision-1",
    });
    const replay = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "Committee consensus",
      idempotencyKey: "decision-1",
    });
    const waitlisted = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "waitlisted",
      reason: "Capacity changed",
      idempotencyKey: "decision-2",
      expectedVersion: accepted.version,
    });
    await service.replayPersistedDecisionWork({
      tenantId,
      planId: "plan-1",
      submissionId: submission.id,
      status: "waitlisted",
      decisionVersion: waitlisted.version,
      transitionIdempotencyKey: "decision-2",
    });
    const rejected = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "rejected",
      reason: "Program fit changed",
      idempotencyKey: "decision-3",
      expectedVersion: waitlisted.version,
    });
    await service.replayPersistedDecisionWork({
      tenantId,
      planId: "plan-1",
      submissionId: submission.id,
      status: "rejected",
      decisionVersion: rejected.version,
      transitionIdempotencyKey: "decision-3",
    });

    expect(replay).toEqual(accepted);
    expect(rejected.version).toBe(3);
    expect(projected.map((input) => input.status)).toEqual(["accepted", "waitlisted", "rejected"]);
    expect(projected.map((input) => input.decisionVersion)).toEqual([1, 2, 3]);
    expect(projected.map((input) => input.priorStatus)).toEqual([null, "accepted", "waitlisted"]);
    expect(projected.map((input) => input.idempotencyKey)).toEqual([
      "evaluation-decision:plan-1:submission-1:v1",
      "evaluation-decision:plan-1:submission-1:v2",
      "evaluation-decision:plan-1:submission-1:v3",
    ]);
    expect(projected.map((input) => input.communication.templatePurpose)).toEqual([
      "decision_accepted",
      "decision_waitlisted",
      "decision_rejected",
    ]);
    expect(projected[0]?.participantProjection).toEqual({
      status: "accepted",
      reason: "Committee consensus",
      decisionVersion: 1,
      decidedAt: nowIso,
    });
    expect(onboarded).toHaveLength(1);
    expect(
      reconciled.map(({ status, decisionVersion, submissionId }) => ({
        status,
        decisionVersion,
        submissionId,
      })),
    ).toEqual([
      { status: "waitlisted", decisionVersion: 2, submissionId: submission.id },
      { status: "rejected", decisionVersion: 3, submissionId: submission.id },
    ]);
  });
  it("does not delay decision persistence while projection and handoff remain unresolved", async () => {
    let projectionStarted: (() => void) | undefined;
    const projectionHasStarted = new Promise<void>((resolve) => {
      projectionStarted = resolve;
    });
    let releaseProjection: (() => void) | undefined;
    const projectionReleased = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let acceptanceStarted = false;
    const { service } = await fixture({
      decisionProjection: {
        projectDecision: async () => {
          projectionStarted?.();
          await projectionReleased;
        },
      },
      acceptanceHandoff: {
        accept: async () => {
          acceptanceStarted = true;
        },
      },
    });

    const decision = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "Committee consensus",
      idempotencyKey: "decision-projection-before-acceptance",
    });
    expect(decision).toMatchObject({ status: "accepted", version: 1 });
    expect(acceptanceStarted).toBe(false);

    const replay = service.replayPersistedDecisionWork({
      tenantId,
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      decisionVersion: decision.version,
      transitionIdempotencyKey: "decision-projection-before-acceptance",
    });
    await projectionHasStarted;
    await expect(
      service.recordDecision(organizer, {
        planId: "plan-1",
        submissionId: submission.id,
        status: "accepted",
        reason: "Committee consensus",
        idempotencyKey: "decision-projection-before-acceptance",
      }),
    ).resolves.toEqual(decision);
    expect(acceptanceStarted).toBe(false);
    releaseProjection?.();

    await expect(replay).resolves.toBeUndefined();
    expect(acceptanceStarted).toBe(true);
  });
  it("keeps projection-before-handoff ordering in outbox replay", async () => {
    let markAcceptanceStarted: (() => void) | undefined;
    const acceptanceStarted = new Promise<void>((resolve) => {
      markAcceptanceStarted = resolve;
    });
    let releaseAcceptance: (() => void) | undefined;
    const acceptanceReleased = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const { service } = await fixture({
      decisionProjection: {
        projectDecision: async () => undefined,
      },
      acceptanceHandoff: {
        accept: async () => {
          markAcceptanceStarted?.();
          await acceptanceReleased;
        },
      },
    });

    const decision = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "Committee consensus",
      idempotencyKey: "decision-outbox-order",
    });
    const replay = service.replayPersistedDecisionWork({
      tenantId,
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      decisionVersion: decision.version,
      transitionIdempotencyKey: "decision-outbox-order",
    });

    await acceptanceStarted;
    let settled = false;
    void replay.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseAcceptance?.();
    await expect(replay).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
  it("does not start handoffs when durable projection replay fails", async () => {
    let acceptanceCalls = 0;
    let reconciliationCalls = 0;
    const { service } = await fixture({
      decisionProjection: {
        projectDecision: async () => {
          throw new Error("projection unavailable");
        },
      },
      acceptanceHandoff: {
        accept: async () => {
          acceptanceCalls += 1;
        },
        reconcileSessionDecision: async () => {
          reconciliationCalls += 1;
        },
      },
    });

    const accepted = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: submission.id,
      status: "accepted",
      reason: "Committee consensus",
      idempotencyKey: "projection-failure-accepted",
    });
    const waitlisted = await service.recordDecision(organizer, {
      planId: "plan-1",
      submissionId: "submission-2",
      status: "waitlisted",
      reason: "Capacity changed",
      idempotencyKey: "projection-failure-waitlisted",
    });

    await expect(
      service.replayPersistedDecisionWork({
        tenantId,
        planId: "plan-1",
        submissionId: submission.id,
        status: "accepted",
        decisionVersion: accepted.version,
        transitionIdempotencyKey: "projection-failure-accepted",
      }),
    ).rejects.toThrow("projection unavailable");
    await expect(
      service.replayPersistedDecisionWork({
        tenantId,
        planId: "plan-1",
        submissionId: "submission-2",
        status: "waitlisted",
        decisionVersion: waitlisted.version,
        transitionIdempotencyKey: "projection-failure-waitlisted",
      }),
    ).rejects.toThrow("projection unavailable");

    expect(acceptanceCalls).toBe(0);
    expect(reconciliationCalls).toBe(0);
  });

  it("retries persisted decision work without delaying the decision request", async () => {
    let shouldFail = true;
    let attempts = 0;
    const { service } = await fixture({
      decisionProjection: {
        projectDecision: async () => {
          attempts += 1;
          if (shouldFail) throw new Error("projection unavailable");
        },
      },
    });

    const input = {
      planId: "plan-1",
      submissionId: submission.id,
      status: "waitlisted" as const,
      reason: "Capacity changed",
      idempotencyKey: "decision-retry",
    };
    const decision = await service.recordDecision(organizer, input);
    expect(decision).toMatchObject({ status: "waitlisted", version: 1 });
    expect(attempts).toBe(0);

    const replayInput = {
      tenantId,
      planId: input.planId,
      submissionId: input.submissionId,
      status: input.status,
      decisionVersion: decision.version,
      transitionIdempotencyKey: input.idempotencyKey,
    };
    await expect(service.replayPersistedDecisionWork(replayInput)).rejects.toThrow(
      "projection unavailable",
    );
    expect(attempts).toBe(1);

    shouldFail = false;
    await expect(service.replayPersistedDecisionWork(replayInput)).resolves.toBeUndefined();
    expect(attempts).toBe(2);

    await expect(service.recordDecision(organizer, input)).resolves.toEqual(decision);
    expect(attempts).toBe(2);
  });
});
describe("evaluation authoring and advisory suggestion lifecycle", () => {
  it("versions authoring, locks grading on open, and applies deny-by-default projections", async () => {
    const repository = new InMemoryEvaluationRepository();
    const source = new InMemorySubmissionReviewSource([
      {
        ...submission,
        version: 4,
        files: [
          {
            id: "file-1",
            name: "notes.pdf",
            mimeType: "application/pdf",
            sizeBytes: 12,
          },
        ],
      },
    ]);
    const service = new EvaluationService(
      repository,
      source,
      {
        ...evaluationEventSource(),
      },
      {
        clock: () => new Date(nowIso),
      },
    );
    const draft = await service.createPlan(organizer, {
      id: "authoring-plan",
      eventId,
      name: "Authoring plan",
      blindReview: true,
      closesAt: "2026-08-12T12:00:00.000Z",
      assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 2 },
      rounds: [round],
      reviewerProjection: { fieldIds: [], fileIds: [] },
    });
    const edited = await service.updatePlan(organizer, draft.id, {
      expectedVersion: draft.version,
      name: "Edited authoring plan",
      rounds: [
        {
          ...round,
          name: "Edited committee review",
          aiTriageEnabled: true,
          rubric: { ...round.rubric, name: "Edited rubric" },
        },
      ],
    });
    expect(edited.version).toBe(2);
    const opened = await service.openPlan(
      organizer,
      edited.id,
      edited.version,
      crypto.randomUUID(),
    );
    expect(opened.gradingLockedAt).toBe(nowIso);
    const rescheduled = await service.updatePlanSchedule(organizer, opened.id, {
      expectedVersion: opened.version,
      closesAt: "2026-08-13T12:00:00.000Z",
      revisionSyncToken: crypto.randomUUID(),
    });
    expect(rescheduled).toMatchObject({
      closesAt: "2026-08-13T12:00:00.000Z",
      version: opened.version + 1,
      gradingLockedAt: opened.gradingLockedAt,
      gradingRevision: opened.gradingRevision,
      rounds: opened.rounds,
    });
    await expectEvaluationError(
      service.updatePlan(organizer, edited.id, {
        expectedVersion: rescheduled.version,
        name: "Must remain locked",
      }),
      "EVALUATION_CONFLICT",
    );
    const assignments = await service.assignReviewers(organizer, {
      planId: rescheduled.id,
      roundId: round.id,
      submissionId: submission.id,
      reviewerIds: ["reviewer-1"],
    });
    const assignment = assignments[0];
    if (assignment === undefined) {
      throw new Error("Expected an assignment fixture.");
    }
    const context = await service.getReviewContext(reviewer("reviewer-1"), assignment.id);
    expect(context.submission.answers).toEqual({});
    expect(context.submission.files).toEqual([]);
    await expectEvaluationError(
      service.generateRoundAiSuggestions(organizer, {
        planId: rescheduled.id,
        roundId: round.id,
        submissionId: submission.id,
      }),
      "EVALUATION_ADVISORY_UNAVAILABLE",
    );
  });
  it("reopens a closed plan with the current version and preserves its grading lock", async () => {
    const { service, plan } = await fixture({ reviewsPerSubmission: 1 });
    const closedPlan = await service.closePlan(
      organizer,
      plan.id,
      plan.version,
      crypto.randomUUID(),
    );

    await expectEvaluationError(
      service.assignReviewers(organizer, {
        planId: plan.id,
        roundId: round.id,
        submissionId: submission.id,
        reviewerIds: ["reviewer-1"],
        expectedVersion: closedPlan.version,
      }),
      "EVALUATION_CLOSED",
    );

    const reopened = await service.openPlan(
      organizer,
      closedPlan.id,
      closedPlan.version,
      crypto.randomUUID(),
    );
    expect(reopened.status).toBe("open");
    expect(reopened.version).toBe(closedPlan.version + 1);
    expect(reopened.gradingLockedAt).toBe(plan.gradingLockedAt);

    await expectEvaluationError(
      service.openPlan(organizer, closedPlan.id, closedPlan.version, crypto.randomUUID()),
      "EVALUATION_CONFLICT",
    );
    await expectEvaluationError(
      service.updatePlan(organizer, reopened.id, {
        expectedVersion: reopened.version,
        name: "Grading remains locked",
      }),
      "EVALUATION_CONFLICT",
    );

    await expect(
      service.assignReviewers(organizer, {
        planId: reopened.id,
        roundId: round.id,
        submissionId: submission.id,
        reviewerIds: ["reviewer-1"],
        expectedVersion: reopened.version,
      }),
    ).resolves.toHaveLength(1);
  });

  it("clones a grading-locked plan to a new editable draft without changing historical review state", async () => {
    const { service, repository, plan } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    const draftReview = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      scores: [
        { criterionId: "quality", value: 4, origin: "human" },
        { criterionId: "relevance", value: 8, origin: "human" },
      ],
      comment: "Historical review",
    });
    const closedPlan = await service.closePlan(
      organizer,
      plan.id,
      plan.version,
      crypto.randomUUID(),
    );
    const reopened = await service.openPlan(
      organizer,
      closedPlan.id,
      closedPlan.version,
      crypto.randomUUID(),
    );

    const revision = await service.revisePlanToDraft(organizer, reopened.id, {
      expectedVersion: reopened.version,
    });

    expect(revision).toMatchObject({
      id: `${reopened.id}-revision-${reopened.version}`,
      predecessorPlanId: reopened.id,
      eventId: reopened.eventId,
      status: "draft",
      version: 1,
      gradingLockedAt: null,
      name: `${reopened.name} revision`,
    });
    expect(revision.gradingRevision).toBeUndefined();
    expect(revision.rounds).toEqual(
      reopened.rounds.map(
        ({ revision: _roundRevision, rubricRevision: _rubricRevision, ...round }) => ({
          ...round,
          id: `${round.id}-revision-${reopened.version}`,
          predecessorRoundId: round.id,
        }),
      ),
    );

    const edited = await service.updatePlan(organizer, revision.id, {
      expectedVersion: revision.version,
      name: "Editable grading revision",
    });
    expect(edited).toMatchObject({
      status: "draft",
      version: 2,
      name: "Editable grading revision",
    });
    await expect(service.getOrganizerWorkspace(organizer, eventId)).resolves.toMatchObject({
      plan: {
        id: edited.id,
        name: "Editable grading revision",
        status: "draft",
        version: 2,
      },
    });
    await expect(
      service.getOrganizerWorkspace(organizer, eventId, reopened.id),
    ).resolves.toMatchObject({
      plan: { id: reopened.id, status: "open" },
    });
    const leafRevision = {
      ...edited,
      id: `${edited.id}-leaf`,
      predecessorPlanId: edited.id,
      name: "Leaf grading revision",
      version: 1,
      createdAt: "2026-08-10T13:00:00.000Z",
      updatedAt: "2026-08-10T13:00:00.000Z",
    };
    await repository.putPlan(leafRevision, null);
    await expect(service.getOrganizerWorkspace(organizer, eventId)).resolves.toMatchObject({
      plan: { id: leafRevision.id, name: "Leaf grading revision", status: "draft", version: 1 },
    });
    await expect(
      service.getOrganizerWorkspace(organizer, eventId, edited.id),
    ).resolves.toMatchObject({
      plan: { id: edited.id, name: "Editable grading revision", version: 2 },
    });

    expect(await repository.getPlan(tenantId, reopened.id)).toEqual(reopened);
    expect(await repository.getAssignment(tenantId, assignment.id)).toEqual({
      ...assignment,
      status: "in_progress",
      version: assignment.version + 1,
      updatedAt: nowIso,
    });
    expect(await repository.getReview(tenantId, assignment.id)).toEqual(draftReview);
    expect(await repository.listAssignments(tenantId, revision.id)).toEqual([]);
    expect(await repository.listReviews(tenantId, revision.id)).toEqual([]);
  });

  it("projects immutable predecessor reviews through an active revision without mixing rubrics", async () => {
    const absRound = { ...round, name: "ABS" };
    const { service, plan } = await fixture({ reviewsPerSubmission: 3, reviewRound: absRound });
    const allPredecessorAssignments = await service.assignReviewers(organizer, {
      planId: plan.id,
      roundId: absRound.id,
      submissionId: submission.id,
      reviewerIds: ["reviewer-1", "reviewer-2", "reviewer-4"],
    });
    const predecessorAssignments = allPredecessorAssignments.filter(
      (assignment) => assignment.reviewerId !== "reviewer-4",
    );
    const outstandingPredecessorAssignment = allPredecessorAssignments.find(
      (assignment) => assignment.reviewerId === "reviewer-4",
    );
    if (outstandingPredecessorAssignment === undefined) {
      throw new Error("Expected an outstanding predecessor assignment.");
    }
    for (const assignment of predecessorAssignments) {
      const draft = await service.saveReview(reviewer(assignment.reviewerId), assignment.id, {
        scores: [
          { criterionId: "quality", value: 4, origin: "human" },
          { criterionId: "relevance", value: 8, origin: "human" },
        ],
        comment: `ABS ${assignment.reviewerId}`,
      });
      await service.submitReview(reviewer(assignment.reviewerId), assignment.id, draft.version);
    }
    const closed = await service.closePlan(organizer, plan.id, plan.version, crypto.randomUUID());
    const reopened = await service.openPlan(
      organizer,
      closed.id,
      closed.version,
      crypto.randomUUID(),
    );
    const revision = await service.revisePlanToDraft(organizer, reopened.id, {
      expectedVersion: reopened.version,
    });
    const revisionRound = revision.rounds[0];
    const sourceCriterion = round.rubric.criteria[0];
    if (revisionRound === undefined || sourceCriterion === undefined) {
      throw new Error("Expected source and revision rounds.");
    }
    const tamingRound = {
      ...revisionRound,
      name: "Taming",
      rubric: {
        ...round.rubric,
        id: "taming-rubric",
        criteria: [{ ...sourceCriterion, id: "taming-quality", weight: 1 }],
      },
    };
    const authoredRevision = await service.updatePlan(organizer, revision.id, {
      expectedVersion: revision.version,
      rounds: [tamingRound],
    });
    const activeRevision = await service.openPlan(
      organizer,
      authoredRevision.id,
      authoredRevision.version,
      crypto.randomUUID(),
    );
    const [activeAssignment] = await service.assignReviewers(organizer, {
      planId: activeRevision.id,
      roundId: tamingRound.id,
      submissionId: submission.id,
      reviewerIds: ["reviewer-3"],
    });
    if (activeAssignment === undefined) throw new Error("Expected an active revision assignment.");

    const workspace = await service.getOrganizerWorkspace(organizer, eventId, activeRevision.id);

    expect(workspace.plan.id).toBe(activeRevision.id);
    expect(workspace.assignments.map((assignment) => assignment.id).sort()).toEqual(
      [
        ...predecessorAssignments.map((assignment) => assignment.id),
        outstandingPredecessorAssignment.id,
        activeAssignment.id,
      ].sort(),
    );
    expect(workspace.progress).toMatchObject({
      planId: activeRevision.id,
      total: 1,
      assigned: 1,
      inProgress: 0,
      submitted: 0,
      reviewers: [expect.objectContaining({ planId: activeRevision.id })],
    });
    expect(workspace.submittedReviews).toEqual(
      expect.arrayContaining(
        predecessorAssignments.map((assignment) =>
          expect.objectContaining({
            planId: plan.id,
            roundId: absRound.id,
            reviewerId: assignment.reviewerId,
          }),
        ),
      ),
    );
    expect(workspace.resultScopes).toEqual([
      expect.objectContaining({
        planId: plan.id,
        lineageOrdinal: 0,
        planName: plan.name,
        roundId: absRound.id,
        roundName: "ABS",
        historical: true,
      }),
      expect.objectContaining({
        planId: activeRevision.id,
        lineageOrdinal: 1,
        planName: activeRevision.name,
        roundId: tamingRound.id,
        roundName: "Taming",
        historical: false,
      }),
    ]);
    const absAggregate = workspace.aggregates.find(
      (aggregate) => aggregate.planId === plan.id && aggregate.roundId === absRound.id,
    );
    const tamingAggregate = workspace.aggregates.find(
      (aggregate) => aggregate.planId === activeRevision.id && aggregate.roundId === tamingRound.id,
    );
    expect(absAggregate).toMatchObject({ submittedReviewCount: 2, possibleWeightedTotal: 20 });
    expect(tamingAggregate).toMatchObject({ submittedReviewCount: 0, possibleWeightedTotal: 5 });
    expect(new Set(workspace.assignments.map((assignment) => assignment.id)).size).toBe(4);
    expect(new Set(workspace.submittedReviews.map((review) => review.id)).size).toBe(2);
    const predecessorWorkspace = await service.getOrganizerWorkspace(organizer, eventId, plan.id);
    expect(predecessorWorkspace.assignments.map((assignment) => assignment.id).sort()).toEqual(
      [
        ...predecessorAssignments.map((assignment) => assignment.id),
        outstandingPredecessorAssignment.id,
      ].sort(),
    );
    expect(predecessorWorkspace.resultScopes).toEqual([
      expect.objectContaining({
        planId: plan.id,
        lineageOrdinal: 0,
        roundId: absRound.id,
        historical: false,
      }),
    ]);
  });
  it("rejects a partial provider result without persisting a suggestion", async () => {
    await expectProviderCandidatesRejected([validAiCandidates()[0]]);
  });

  it("rejects duplicate provider criterion ids without persisting a suggestion", async () => {
    const quality = validAiCandidates()[0];
    await expectProviderCandidatesRejected([quality, { ...quality, value: 3 }]);
  });

  it("rejects unexpected provider criterion ids without persisting a suggestion", async () => {
    await expectProviderCandidatesRejected([
      validAiCandidates()[0],
      {
        criterionId: "speaker-reputation",
        value: 5,
        evidence: ["The practical material gives the audience a concrete outcome."],
      },
    ]);
  });

  it("rejects an unknown empty provider criterion bucket without persistence", async () => {
    const { repository, service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => ({
        candidates: {
          quality: [validAiCandidates()[0]],
          relevance: [validAiCandidates()[1]],
          injected: [],
        },
      }),
    });

    await expectEvaluationError(generateTriage(service), "EVALUATION_INVALID_INPUT");
    expect(await repository.listSuggestions(tenantId, plan.id)).toEqual([]);
  });

  it("rejects non-scoreable provider criterion ids without persisting a suggestion", async () => {
    const notesCriterion = {
      id: "notes",
      label: "Notes",
      description: "Private evaluator notes.",
      minimum: 0,
      maximum: 0,
      weight: 0,
      required: false,
      inputType: "free_text" as const,
    };
    await expectProviderCandidatesRejected(
      [
        ...validAiCandidates(),
        {
          criterionId: notesCriterion.id,
          value: 0,
          evidence: ["The practical material gives the audience a concrete outcome."],
        },
      ],
      {
        ...triageRound,
        rubric: {
          ...round.rubric,
          criteria: [...round.rubric.criteria, notesCriterion],
        },
      },
    );
  });

  it("persists exactly one valid provider result for every scoreable criterion", async () => {
    const { repository, service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => ({ candidates: validAiCandidates() }),
    });

    const suggestion = await generateTriage(service);

    expect(Object.keys(suggestion.candidates).sort()).toEqual(["quality", "relevance"]);
    expect(suggestion.criterionCandidates).toHaveLength(2);
    expect(await repository.listSuggestions(tenantId, plan.id)).toEqual([suggestion]);
  });

  it("rejects provider candidates without exact source references", async () => {
    const { provenance: _ignored, ...withoutCitation } = validAiCandidates()[0];
    await expectProviderCandidatesRejected([withoutCitation, validAiCandidates()[1]]);
  });

  it("rejects case-modified provider excerpts at the service boundary", async () => {
    await expectProviderCandidatesRejected([
      {
        ...validAiCandidates()[0],
        provenance: {
          sourceReferences: ["abstract:practical material for the audience."],
        },
      },
      validAiCandidates()[1],
    ]);
  });

  it("rejects a one-word rationale without persisting a suggestion", async () => {
    await expectProviderCandidatesRejected([
      { ...validAiCandidates()[0], evidence: ["Excellent"] },
      validAiCandidates()[1],
    ]);
  });

  it("rejects a generic rationale without persisting a suggestion", async () => {
    await expectProviderCandidatesRejected([
      { ...validAiCandidates()[0], evidence: ["This proposal looks good overall."] },
      validAiCandidates()[1],
    ]);
  });

  it("rejects repeated source words without explanatory reasoning", async () => {
    await expectProviderCandidatesRejected([
      {
        ...validAiCandidates()[0],
        evidence: ["Practical material audience practical material audience."],
      },
      validAiCandidates()[1],
    ]);
  });

  it("accepts structurally grounded rationale without lexical quality filtering", async () => {
    const { service } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => ({
        candidates: [
          {
            ...validAiCandidates()[0],
            evidence: ["Practical material audience concrete outcome supports banana bicycle."],
          },
          validAiCandidates()[1],
        ],
      }),
    });

    await expect(generateTriage(service)).resolves.toMatchObject({
      candidates: {
        quality: [
          {
            evidence: ["Practical material audience concrete outcome supports banana bicycle."],
          },
        ],
      },
    });
  });

  it.each([
    {
      language: "Chinese",
      submissionMaterial: {
        ...submission,
        title: "部署可靠性",
        abstract: "通过回滚清单和故障演练帮助团队提高部署可靠性。",
      },
      candidates: [
        {
          criterionId: "quality",
          value: 4,
          evidence: ["回滚清单和故障演练提供了具体的部署可靠性依据。"],
          provenance: {
            sourceReferences: ["abstract:通过回滚清单和故障演练帮助团队提高部署可靠性。"],
          },
        },
        {
          criterionId: "relevance",
          value: 8,
          evidence: ["部署可靠性和故障演练直接对应活动主题。"],
          provenance: {
            sourceReferences: ["abstract:通过回滚清单和故障演练帮助团队提高部署可靠性。"],
          },
        },
      ],
    },
    {
      language: "Thai",
      submissionMaterial: {
        ...submission,
        title: "ความน่าเชื่อถือของการปรับใช้",
        abstract: "รายการตรวจสอบการย้อนกลับและการฝึกซ้อมช่วยให้ทีมปรับใช้ได้อย่างน่าเชื่อถือ",
      },
      candidates: [
        {
          criterionId: "quality",
          value: 4,
          evidence: ["รายการตรวจสอบและการฝึกซ้อมอธิบายแนวทางที่ทีมสามารถนำไปใช้ได้จริง"],
          provenance: {
            sourceReferences: [
              "abstract:รายการตรวจสอบการย้อนกลับและการฝึกซ้อมช่วยให้ทีมปรับใช้ได้อย่างน่าเชื่อถือ",
            ],
          },
        },
        {
          criterionId: "relevance",
          value: 8,
          evidence: ["รายการตรวจสอบและการฝึกซ้อมอธิบายแนวทางที่ทีมสามารถนำไปใช้ได้จริง"],
          provenance: {
            sourceReferences: [
              "abstract:รายการตรวจสอบการย้อนกลับและการฝึกซ้อมช่วยให้ทีมปรับใช้ได้อย่างน่าเชื่อถือ",
            ],
          },
        },
      ],
    },
  ])(
    "rejects meaningful $language rationales because output must be English",
    async ({ submissionMaterial, candidates }) => {
      const { service } = await fixture({
        reviewsPerSubmission: 1,
        reviewRound: triageRound,
        submissionMaterial,
        aiSuggestionProducer: async () => ({ candidates }),
      });

      await expectEvaluationError(generateTriage(service), "EVALUATION_INVALID_INPUT");
    },
  );

  it("accepts nontrivial source-grounded rationales", async () => {
    const { service } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => ({ candidates: validAiCandidates() }),
    });

    await expect(generateTriage(service)).resolves.toMatchObject({
      candidates: {
        quality: [
          {
            evidence: ["The practical material gives the audience a concrete outcome."],
          },
        ],
        relevance: [
          {
            evidence: ["The practical audience focus directly supports program relevance."],
          },
        ],
      },
    });
  });

  it("accepts natural grounded rationale inflections without accepting filler", async () => {
    const candidates = validAiCandidates().map((candidate) =>
      candidate.criterionId === "quality"
        ? {
            ...candidate,
            evidence: [
              "The practical material will resonate with the audience and improve their understanding.",
            ],
          }
        : candidate,
    );
    const { service } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => ({ candidates }),
    });

    await expect(generateTriage(service)).resolves.toMatchObject({
      candidates: {
        quality: [
          {
            evidence: [
              "The practical material will resonate with the audience and improve their understanding.",
            ],
          },
        ],
      },
    });
  });

  it("rejects an all-free-text rubric before invoking the provider", async () => {
    let providerCalls = 0;
    const freeTextRound: ReviewRound = {
      ...triageRound,
      rubric: {
        ...round.rubric,
        criteria: round.rubric.criteria.map((criterion) => ({
          ...criterion,
          inputType: "free_text" as const,
        })),
      },
    };
    const { repository, service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: freeTextRound,
      aiSuggestionProducer: async () => {
        providerCalls += 1;
        return { candidates: [] };
      },
    });

    await expectEvaluationError(generateTriage(service), "EVALUATION_ADVISORY_UNSUPPORTED");
    expect(providerCalls).toBe(0);
    expect(await repository.listSuggestions(tenantId, plan.id)).toEqual([]);
  });

  it("applies a revised round schedule to existing reviewer assignments", async () => {
    const { service, repository, plan } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    const revisedOpeningDates = [
      "2026-08-09T09:00:00.000Z",
      "2026-08-09T10:30:00.000Z",
      "2026-08-09T12:00:00.000Z",
    ] as const;
    let sourcePlan = plan;
    for (const opensAt of revisedOpeningDates) {
      const revision = await service.revisePlanToDraft(organizer, sourcePlan.id, {
        expectedVersion: sourcePlan.version,
      });
      expect(revision.predecessorPlanId).toBe(sourcePlan.id);
      expect(revision.rounds[0]?.predecessorRoundId).toBe(sourcePlan.rounds[0]?.id);
      const edited = await service.updatePlan(organizer, revision.id, {
        expectedVersion: revision.version,
        rounds: revision.rounds.map((reviewRound) => ({
          ...reviewRound,
          opensAt,
        })),
      });
      sourcePlan = await service.openPlan(
        organizer,
        edited.id,
        edited.version,
        crypto.randomUUID(),
      );
    }
    const revisedOpensAt = revisedOpeningDates[2];

    const workspace = await service.listReviewerWorkspace(reviewer("reviewer-1"), eventId);
    expect(workspace.assignments).toHaveLength(1);
    expect(workspace.assignments[0]).toMatchObject({
      assignment: { id: assignment.id, planId: plan.id },
      round: { id: round.id, opensAt: revisedOpensAt },
    });
    expect(await repository.getAssignment(tenantId, assignment.id)).toEqual(assignment);
    expect(await repository.getPlan(tenantId, plan.id)).toMatchObject({
      rounds: [{ id: round.id, opensAt: revisedOpensAt }],
    });
  });

  it("reopens a closed predecessor so retained reviewer work follows the active revision", async () => {
    const { service, repository, plan } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      comment: "Draft evidence",
      scores: [
        {
          criterionId: "quality",
          value: 4,
          origin: "human",
        },
      ],
    });
    const closedPlan = await service.closePlan(
      organizer,
      plan.id,
      plan.version,
      crypto.randomUUID(),
    );
    const revision = await service.revisePlanToDraft(organizer, closedPlan.id, {
      expectedVersion: closedPlan.version,
    });
    const revisedOpensAt = "2026-08-09T12:00:00.000Z";
    const edited = await service.updatePlan(organizer, revision.id, {
      expectedVersion: revision.version,
      rounds: revision.rounds.map((reviewRound) => ({
        ...reviewRound,
        opensAt: revisedOpensAt,
      })),
    });

    const openedRevision = await service.openPlan(
      organizer,
      edited.id,
      edited.version,
      crypto.randomUUID(),
    );

    const workspace = await service.listReviewerWorkspace(reviewer("reviewer-1"), eventId);
    expect(workspace.assignments).toHaveLength(1);
    expect(workspace.assignments[0]).toMatchObject({
      assignment: { id: assignment.id, planId: plan.id, status: "in_progress" },
      round: { id: round.id, opensAt: revisedOpensAt },
      review: { id: draft.id, comment: "Draft evidence" },
    });
    expect(await repository.getPlan(tenantId, plan.id)).toMatchObject({
      status: "open",
      rounds: [{ id: round.id, opensAt: revisedOpensAt }],
    });

    await service.closePlan(
      organizer,
      openedRevision.id,
      openedRevision.version,
      crypto.randomUUID(),
    );
    expect(await repository.getPlan(tenantId, plan.id)).toMatchObject({
      status: "closed",
      rounds: [{ id: round.id, opensAt: revisedOpensAt }],
    });
  });

  it("reconciles a past-due closed tip onto stale legacy ancestors", async () => {
    const { service, repository, plan, setTime } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      comment: "Retained draft",
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
    });
    const revision = await service.revisePlanToDraft(organizer, plan.id, {
      expectedVersion: plan.version,
    });
    const revisedOpensAt = "2026-08-09T12:00:00.000Z";
    const edited = await service.updatePlan(organizer, revision.id, {
      expectedVersion: revision.version,
      rounds: revision.rounds.map((reviewRound) => ({
        ...reviewRound,
        opensAt: revisedOpensAt,
      })),
    });
    const opened = await service.openPlan(
      organizer,
      edited.id,
      edited.version,
      crypto.randomUUID(),
    );
    const closedTip = await service.closePlan(
      organizer,
      opened.id,
      opened.version,
      crypto.randomUUID(),
    );
    const synchronizedAncestor = await repository.getPlan(tenantId, plan.id);
    if (synchronizedAncestor === null) throw new Error("Expected the ancestor plan.");
    await repository.putPlan(
      {
        ...synchronizedAncestor,
        status: "open",
        rounds: plan.rounds,
        version: synchronizedAncestor.version + 1,
      },
      synchronizedAncestor.version,
    );

    setTime("2026-08-20T12:00:00.000Z");
    await service.reconcilePlanRevisionFamily(
      organizer,
      closedTip.id,
      closedTip.version,
      "11111111-1111-4111-8111-111111111111",
    );

    expect(await repository.getPlan(tenantId, plan.id)).toMatchObject({
      status: "closed",
      rounds: [{ id: round.id, opensAt: revisedOpensAt }],
    });
    expect(await repository.getAssignment(tenantId, assignment.id)).toMatchObject({
      id: assignment.id,
      planId: plan.id,
    });
    expect(await repository.getReview(tenantId, assignment.id)).toEqual(draft);
    await expectEvaluationError(
      service.saveReview(reviewer("reviewer-1"), assignment.id, {
        comment: "Must remain closed",
        scores: [{ criterionId: "quality", value: 4, origin: "human" }],
        expectedVersion: draft.version,
      }),
      "EVALUATION_CLOSED",
    );
  });

  it("persists explicit lineage for maximum-length revision identifiers", async () => {
    const { service, repository, plan } = await fixture({ reviewsPerSubmission: 1 });
    const source: EvaluationPlan = {
      ...plan,
      id: "p".repeat(100),
      rounds: plan.rounds.map((reviewRound) => ({
        ...reviewRound,
        id: "r".repeat(100),
      })),
    };
    await repository.putPlan(source, null);

    const firstRevision = await service.revisePlanToDraft(organizer, source.id, {
      expectedVersion: source.version,
    });
    expect(firstRevision.id).toHaveLength(100);
    expect(firstRevision.id).not.toBe(source.id);
    expect(firstRevision.predecessorPlanId).toBe(source.id);
    expect(firstRevision.rounds[0]?.id).toHaveLength(100);
    expect(firstRevision.rounds[0]?.predecessorRoundId).toBe(source.rounds[0]?.id);

    const opened = await service.openPlan(
      organizer,
      firstRevision.id,
      firstRevision.version,
      crypto.randomUUID(),
    );
    const secondRevision = await service.revisePlanToDraft(organizer, opened.id, {
      expectedVersion: opened.version,
    });
    expect(secondRevision.id).toHaveLength(100);
    expect(secondRevision.id).not.toBe(opened.id);
    expect(secondRevision.predecessorPlanId).toBe(opened.id);
    expect(secondRevision.rounds[0]?.predecessorRoundId).toBe(opened.rounds[0]?.id);
  });

  it("requires an explicit grading lock before inserting a revision", async () => {
    const { repository, plan } = await fixture({ reviewsPerSubmission: 1 });
    const unlocked = {
      ...plan,
      gradingRevision: undefined,
      gradingLockedAt: null,
    };
    await repository.putPlan(unlocked, plan.version);
    const revision = {
      ...unlocked,
      id: "unlocked-revision",
      predecessorPlanId: unlocked.id,
      status: "draft" as const,
      version: 1,
    };

    await expect(
      repository.putPlan(revision, null, {
        predecessorPlanId: unlocked.id,
        expectedVersion: unlocked.version,
        lineageVersions: [],
      }),
    ).rejects.toThrow("The evaluation plan changed since it was loaded.");
  });

  it("keeps revision lineage linear and blocks non-tip lifecycle changes", async () => {
    const { service, plan } = await fixture({ reviewsPerSubmission: 1 });
    await service.revisePlanToDraft(organizer, plan.id, {
      expectedVersion: plan.version,
    });

    await expect(
      service.revisePlanToDraft(organizer, plan.id, {
        expectedVersion: plan.version,
      }),
    ).rejects.toThrow("Only the latest review plan revision can change lifecycle or schedule.");
    await expect(
      service.closePlan(organizer, plan.id, plan.version, crypto.randomUUID()),
    ).rejects.toThrow("Only the latest review plan revision can change lifecycle or schedule.");
  });

  it("rejects revision insertion when a validated deeper ancestor changes", async () => {
    const repository = new RacingLineageRepository();
    const { service, plan } = await fixture({ reviewsPerSubmission: 1, repository });
    const source: EvaluationPlan = {
      ...plan,
      id: "lineage-source",
      predecessorPlanId: plan.id,
      rounds: plan.rounds.map((reviewRound, index) => ({
        ...reviewRound,
        id: `lineage-source-round-${index}`,
        predecessorRoundId: reviewRound.id,
      })),
    };
    await repository.putPlan(source, null);
    repository.lineagePlanId = plan.id;

    await expect(
      service.revisePlanToDraft(organizer, source.id, {
        expectedVersion: source.version,
      }),
    ).rejects.toThrow("The evaluation plan changed since it was loaded.");
    expect(await repository.getPlanSuccessor(tenantId, eventId, source.id)).toBeNull();
  });

  it("keeps the active open plan writable while its successor remains draft", async () => {
    const { service, plan } = await fixture({ reviewsPerSubmission: 1 });
    const assignment = await assignOne(service);
    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      comment: "Initial draft",
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
    });
    await service.revisePlanToDraft(organizer, plan.id, {
      expectedVersion: plan.version,
    });

    await expect(
      service.saveReview(reviewer("reviewer-1"), assignment.id, {
        comment: "Still writable",
        scores: [{ criterionId: "quality", value: 5, origin: "human" }],
        expectedVersion: draft.version,
      }),
    ).resolves.toMatchObject({ comment: "Still writable" });
  });

  it("rejects activation when a revision removes a predecessor round", async () => {
    const secondRound: ReviewRound = {
      ...round,
      id: "round-2",
      name: "Round two",
      sequence: 2,
      rubric: { ...round.rubric, id: "rubric-2" },
    };
    const { service, plan, repository } = await fixture({
      reviewsPerSubmission: 1,
      reviewRounds: [round, secondRound],
    });
    const openedSource = {
      ...plan,
      gradingRevision: plan.version,
      gradingLockedAt: nowIso,
    };
    await repository.putPlan(openedSource, plan.version);
    const revision = await service.revisePlanToDraft(organizer, openedSource.id, {
      expectedVersion: openedSource.version,
    });
    const edited = await service.updatePlan(organizer, revision.id, {
      expectedVersion: revision.version,
      rounds: revision.rounds.slice(0, 1),
    });

    await expect(
      service.openPlan(organizer, edited.id, edited.version, crypto.randomUUID()),
    ).rejects.toThrow("Review plan revisions cannot remove a predecessor round.");
  });

  it("rejects an over-depth revision before persisting a successor draft", async () => {
    const { service, repository, plan } = await fixture({ reviewsPerSubmission: 1 });
    let tip = plan;
    for (let depth = 1; depth <= 16; depth += 1) {
      const child: EvaluationPlan = {
        ...tip,
        id: `legacy-plan-${depth}`,
        predecessorPlanId: tip.id,
        name: `Legacy review ${depth}`,
        rounds: tip.rounds.map((reviewRound, index) => ({
          ...reviewRound,
          id: `legacy-round-${depth}-${index}`,
          predecessorRoundId: reviewRound.id,
        })),
      };
      await repository.putPlan(child, null);
      tip = child;
    }
    const before = await repository.listPlans(tenantId, eventId);

    await expect(
      service.revisePlanToDraft(organizer, tip.id, {
        expectedVersion: tip.version,
      }),
    ).rejects.toThrow("Review plan revision depth exceeds the synchronization limit.");
    expect(await repository.listPlans(tenantId, eventId)).toHaveLength(before.length);
    expect(await repository.getPlanSuccessor(tenantId, eventId, tip.id)).toBeNull();
  });

  it("closes a maximum-depth 17-plan revision family atomically", async () => {
    const { service, repository, plan } = await fixture({ reviewsPerSubmission: 1 });
    let tip = plan;
    for (let depth = 1; depth <= 16; depth += 1) {
      const child: EvaluationPlan = {
        ...tip,
        id: `maximum-depth-plan-${depth}`,
        predecessorPlanId: tip.id,
        name: `Maximum depth review ${depth}`,
        rounds: tip.rounds.map((reviewRound, index) => ({
          ...reviewRound,
          id: `maximum-depth-round-${depth}-${index}`,
          predecessorRoundId: reviewRound.id,
          rubric: {
            ...reviewRound.rubric,
            id: `maximum-depth-rubric-${depth}-${index}`,
          },
        })),
      };
      await repository.putPlan(child, null);
      tip = child;
    }

    await expect(
      service.closePlan(organizer, tip.id, tip.version, crypto.randomUUID()),
    ).resolves.toMatchObject({ status: "closed" });

    const family = await repository.listPlans(tenantId, eventId);
    expect(family).toHaveLength(17);
    expect(family.every((candidate) => candidate.status === "closed")).toBe(true);
  });

  it("rejects oversized reconciliation before locking or changing the revision family", async () => {
    const { service, repository, plan } = await fixture({ reviewsPerSubmission: 1 });
    const sourceRound = plan.rounds[0];
    if (sourceRound === undefined) {
      throw new Error("Expected a review round fixture.");
    }
    const ancestor: EvaluationPlan = {
      ...plan,
      version: plan.version + 1,
      rounds: Array.from({ length: MAX_REVISION_RECONCILIATION_ROUNDS + 1 }, (_, index) => ({
        ...sourceRound,
        id: `oversized-ancestor-round-${index}`,
        sequence: index + 1,
        rubric: {
          ...sourceRound.rubric,
          id: `oversized-ancestor-rubric-${index}`,
        },
      })),
    };
    await repository.putPlan(ancestor, plan.version);
    const tip: EvaluationPlan = {
      ...ancestor,
      id: "oversized-revision-tip",
      predecessorPlanId: ancestor.id,
      name: "Oversized revision tip",
      rounds: ancestor.rounds.map((reviewRound, index) => ({
        ...reviewRound,
        id: `oversized-tip-round-${index}`,
        predecessorRoundId: reviewRound.id,
        rubric: {
          ...reviewRound.rubric,
          id: `oversized-tip-rubric-${index}`,
        },
      })),
    };
    await repository.putPlan(tip, null);
    const before = await repository.listPlans(tenantId, eventId);

    await expect(
      service.closePlan(organizer, tip.id, tip.version, crypto.randomUUID()),
    ).rejects.toThrow("Review plan revision reconciliation exceeds the total round limit.");
    expect(await repository.listPlans(tenantId, eventId)).toEqual(before);
  });

  it("does not count unchanged ancestor rounds toward the synchronization limit", async () => {
    const reviewRounds = Array.from(
      { length: 50 },
      (_, index): ReviewRound => ({
        ...round,
        id: `round-${index}`,
        name: `Round ${index + 1}`,
        sequence: index + 1,
        rubric: {
          ...round.rubric,
          id: `rubric-${index}`,
        },
      }),
    );
    const { service, repository, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRounds,
    });
    let tip = plan;
    for (let depth = 1; depth <= 5; depth += 1) {
      const child: EvaluationPlan = {
        ...tip,
        id: `wide-plan-${depth}`,
        predecessorPlanId: tip.id,
        name: `Wide review ${depth}`,
        rounds: tip.rounds.map((reviewRound, index) => ({
          ...reviewRound,
          id: `wide-round-${depth}-${index}`,
          predecessorRoundId: reviewRound.id,
          rubric: {
            ...reviewRound.rubric,
            id: `wide-rubric-${depth}-${index}`,
          },
        })),
      };
      await repository.putPlan(child, null);
      tip = child;
    }

    const revision = await service.revisePlanToDraft(organizer, tip.id, {
      expectedVersion: tip.version,
    });

    expect(revision.predecessorPlanId).toBe(tip.id);
  });

  it("opens and closes a wide revision family through bounded reconciliation", async () => {
    const reviewRounds = Array.from(
      { length: 50 },
      (_, index): ReviewRound => ({
        ...round,
        id: `round-${index}`,
        name: `Round ${index + 1}`,
        sequence: index + 1,
        rubric: {
          ...round.rubric,
          id: `rubric-${index}`,
        },
      }),
    );
    const { service, repository, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRounds,
    });
    let tip = await service.closePlan(organizer, plan.id, plan.version, crypto.randomUUID());
    for (let depth = 1; depth <= 4; depth += 1) {
      const child: EvaluationPlan = {
        ...tip,
        id: `closed-wide-plan-${depth}`,
        predecessorPlanId: tip.id,
        name: `Closed wide review ${depth}`,
        rounds: tip.rounds.map((reviewRound, index) => ({
          ...reviewRound,
          id: `closed-wide-round-${depth}-${index}`,
          predecessorRoundId: reviewRound.id,
          rubric: {
            ...reviewRound.rubric,
            id: `closed-wide-rubric-${depth}-${index}`,
          },
        })),
      };
      await repository.putPlan(child, null);
      tip = child;
    }
    const before = await repository.listPlans(tenantId, eventId);

    const revision = await service.revisePlanToDraft(organizer, tip.id, {
      expectedVersion: tip.version,
    });
    expect(await repository.listPlans(tenantId, eventId)).toHaveLength(before.length + 1);
    const opened = await service.openPlan(
      organizer,
      revision.id,
      revision.version,
      crypto.randomUUID(),
    );
    expect(await repository.getPlan(tenantId, plan.id)).toMatchObject({ status: "open" });
    await service.closePlan(organizer, opened.id, opened.version, crypto.randomUUID());
    expect(await repository.getPlan(tenantId, plan.id)).toMatchObject({ status: "closed" });
  });

  it("blocks reviewer writes and successor insertion while wide close reconciliation is pending", async () => {
    const reviewRounds = Array.from(
      { length: 50 },
      (_, index): ReviewRound => ({
        ...round,
        id: `round-${index}`,
        name: `Round ${index + 1}`,
        sequence: index + 1,
        rubric: {
          ...round.rubric,
          id: `rubric-${index}`,
        },
      }),
    );
    const repository = new PausedReconciliationRepository();
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRounds,
      repository,
    });
    const assignment = await assignOne(service);
    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      comment: "Retained draft",
      scores: [{ criterionId: "quality", value: 4, origin: "human" }],
    });
    let tip = await service.closePlan(organizer, plan.id, plan.version, crypto.randomUUID());
    for (let depth = 1; depth <= 4; depth += 1) {
      const child: EvaluationPlan = {
        ...tip,
        id: `pending-wide-plan-${depth}`,
        predecessorPlanId: tip.id,
        name: `Pending wide review ${depth}`,
        rounds: tip.rounds.map((reviewRound, index) => ({
          ...reviewRound,
          id: `pending-wide-round-${depth}-${index}`,
          predecessorRoundId: reviewRound.id,
          rubric: {
            ...reviewRound.rubric,
            id: `pending-wide-rubric-${depth}-${index}`,
          },
        })),
      };
      await repository.putPlan(child, null);
      tip = child;
    }
    const revision = await service.revisePlanToDraft(organizer, tip.id, {
      expectedVersion: tip.version,
    });
    const opened = await service.openPlan(
      organizer,
      revision.id,
      revision.version,
      crypto.randomUUID(),
    );
    const pause = repository.pauseNextReconciliation();
    const closePromise = service.closePlan(
      organizer,
      opened.id,
      opened.version,
      crypto.randomUUID(),
    );
    await pause.entered;

    const pendingWorkspace = await service.listReviewerWorkspace(reviewer("reviewer-1"), eventId);
    expect(pendingWorkspace.assignments[0]?.plan.status).toBe("closed");
    await expectEvaluationError(
      service.saveReview(reviewer("reviewer-1"), assignment.id, {
        comment: "Must be blocked after authoritative close",
        scores: [{ criterionId: "quality", value: 4, origin: "human" }],
        expectedVersion: draft.version,
      }),
      "EVALUATION_CLOSED",
    );
    await expect(
      service.revisePlanToDraft(organizer, opened.id, {
        expectedVersion: opened.version + 1,
      }),
    ).rejects.toThrow("The evaluation plan changed since it was loaded.");

    pause.release();
    await closePromise;
    expect(await repository.getPlan(tenantId, plan.id)).toMatchObject({ status: "closed" });
  });

  it("resumes an interrupted lifecycle reconciliation with the caller token", async () => {
    const reviewRounds = Array.from(
      { length: 201 },
      (_, index): ReviewRound => ({
        ...round,
        id: `round-${index}`,
        name: `Round ${index + 1}`,
        sequence: index + 1,
        rubric: {
          ...round.rubric,
          id: `rubric-${index}`,
        },
      }),
    );
    const repository = new FailingReconciliationRepository();
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRounds,
      repository,
    });
    const openedSource = {
      ...plan,
      gradingRevision: plan.version,
      gradingLockedAt: nowIso,
    };
    await repository.putPlan(openedSource, plan.version);
    const revision = await service.revisePlanToDraft(organizer, openedSource.id, {
      expectedVersion: openedSource.version,
    });
    const edited = await service.updatePlan(organizer, revision.id, {
      expectedVersion: revision.version,
      rounds: revision.rounds.map((reviewRound) => ({
        ...reviewRound,
        opensAt: "2026-08-09T12:00:00.000Z",
      })),
    });
    const opened = await service.openPlan(
      organizer,
      edited.id,
      edited.version,
      "11111111-1111-4111-8111-111111111111",
    );
    const closeToken = "22222222-2222-4222-8222-222222222222";
    repository.failNextReconciliation = true;

    await expect(
      service.closePlan(organizer, opened.id, opened.version, closeToken),
    ).rejects.toThrow("Injected reconciliation interruption.");
    const interruptedTip = await repository.getPlan(tenantId, opened.id);
    if (interruptedTip === null) throw new Error("Expected the interrupted tip.");
    expect(interruptedTip.status).toBe("closed");

    await expect(
      service.closePlan(organizer, opened.id, opened.version, closeToken),
    ).resolves.toMatchObject({ status: "closed", version: interruptedTip.version });

    expect(await repository.getPlan(tenantId, plan.id)).toMatchObject({ status: "closed" });
    await expect(
      repository.beginPlanRevisionSync(
        interruptedTip,
        interruptedTip.version,
        "33333333-3333-4333-8333-333333333333",
      ),
    ).resolves.toBeUndefined();
    await repository.completePlanRevisionSync(
      interruptedTip,
      interruptedTip.version,
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("replays completed single-batch lifecycle writes with the original caller token", async () => {
    const { service, plan, repository } = await fixture({ reviewsPerSubmission: 1 });
    const openedSource = {
      ...plan,
      gradingRevision: plan.version,
      gradingLockedAt: nowIso,
    };
    await repository.putPlan(openedSource, plan.version);
    const revision = await service.revisePlanToDraft(organizer, openedSource.id, {
      expectedVersion: openedSource.version,
    });
    const openToken = "11111111-1111-4111-8111-111111111111";
    const opened = await service.openPlan(organizer, revision.id, revision.version, openToken);

    await expect(
      service.openPlan(organizer, revision.id, revision.version, openToken),
    ).resolves.toEqual(opened);

    const scheduleToken = "22222222-2222-4222-8222-222222222222";
    const scheduled = await service.updatePlanSchedule(organizer, opened.id, {
      expectedVersion: opened.version,
      closesAt: "2026-08-13T12:00:00.000Z",
      revisionSyncToken: scheduleToken,
    });

    await expect(
      service.updatePlanSchedule(organizer, opened.id, {
        expectedVersion: opened.version,
        closesAt: "2026-08-13T12:00:00.000Z",
        revisionSyncToken: scheduleToken,
      }),
    ).resolves.toEqual(scheduled);

    const closeToken = "33333333-3333-4333-8333-333333333333";
    const closed = await service.closePlan(organizer, scheduled.id, scheduled.version, closeToken);

    await expect(
      service.closePlan(organizer, scheduled.id, scheduled.version, closeToken),
    ).resolves.toEqual(closed);
  });

  it("reconciles oversized legacy families in bounded atomic batches", async () => {
    const reviewRounds = Array.from(
      { length: 50 },
      (_, index): ReviewRound => ({
        ...round,
        id: `round-${index}`,
        name: `Round ${index + 1}`,
        sequence: index + 1,
        rubric: {
          ...round.rubric,
          id: `rubric-${index}`,
        },
      }),
    );
    const repository = new ReconciliationBatchRepository();
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRounds,
      repository,
    });
    const authoritativeOpensAt = "2026-08-09T12:00:00.000Z";
    let tip = plan;
    for (let depth = 1; depth <= 5; depth += 1) {
      const child: EvaluationPlan = {
        ...tip,
        id: `legacy-wide-plan-${depth}`,
        predecessorPlanId: tip.id,
        name: `Legacy wide review ${depth}`,
        rounds: tip.rounds.map((reviewRound, index) => ({
          ...reviewRound,
          id: `legacy-wide-round-${depth}-${index}`,
          predecessorRoundId: reviewRound.id,
          ...(depth === 5 ? { opensAt: authoritativeOpensAt } : {}),
          rubric: {
            ...reviewRound.rubric,
            id: `legacy-wide-rubric-${depth}-${index}`,
          },
        })),
      };
      await repository.putPlan(child, null);
      tip = child;
    }

    await service.reconcilePlanRevisionFamily(
      organizer,
      tip.id,
      tip.version,
      "22222222-2222-4222-8222-222222222222",
    );

    expect(repository.reconciliationCalls).toBe(2);
    const reconciledRoot = await repository.getPlan(tenantId, plan.id);
    expect(
      reconciledRoot?.rounds.every((reviewRound) => reviewRound.opensAt === authoritativeOpensAt),
    ).toBe(true);
  });

  it("reconciles a single legacy ancestor larger than the family round bound", async () => {
    const reviewRounds = Array.from(
      { length: 201 },
      (_, index): ReviewRound => ({
        ...round,
        id: `round-${index}`,
        name: `Round ${index + 1}`,
        sequence: index + 1,
        rubric: {
          ...round.rubric,
          id: `rubric-${index}`,
        },
      }),
    );
    const repository = new ReconciliationBatchRepository();
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRounds,
      repository,
    });
    const authoritativeOpensAt = "2026-08-09T12:00:00.000Z";
    const tip: EvaluationPlan = {
      ...plan,
      id: "oversized-tip",
      predecessorPlanId: plan.id,
      rounds: plan.rounds.map((reviewRound, index) => ({
        ...reviewRound,
        id: `oversized-tip-round-${index}`,
        predecessorRoundId: reviewRound.id,
        opensAt: authoritativeOpensAt,
        rubric: {
          ...reviewRound.rubric,
          id: `oversized-tip-rubric-${index}`,
        },
      })),
    };
    await repository.putPlan(tip, null);

    await service.reconcilePlanRevisionFamily(
      organizer,
      tip.id,
      tip.version,
      "33333333-3333-4333-8333-333333333333",
    );

    expect(repository.reconciliationCalls).toBe(1);
    const reconciledRoot = await repository.getPlan(tenantId, plan.id);
    expect(
      reconciledRoot?.rounds.every((reviewRound) => reviewRound.opensAt === authoritativeOpensAt),
    ).toBe(true);
  });

  it("reconciles a maximum-depth wide legacy family and observes convergence", async () => {
    const reviewRounds = Array.from(
      { length: 50 },
      (_, index): ReviewRound => ({
        ...round,
        id: `round-${index}`,
        name: `Round ${index + 1}`,
        sequence: index + 1,
        rubric: {
          ...round.rubric,
          id: `rubric-${index}`,
        },
      }),
    );
    const repository = new ReconciliationBatchRepository();
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRounds,
      repository,
    });
    const authoritativeOpensAt = "2026-08-09T12:00:00.000Z";
    let tip = plan;
    for (let depth = 1; depth <= 16; depth += 1) {
      const child: EvaluationPlan = {
        ...tip,
        id: `maximum-depth-plan-${depth}`,
        predecessorPlanId: tip.id,
        name: `Maximum depth review ${depth}`,
        rounds: tip.rounds.map((reviewRound, index) => ({
          ...reviewRound,
          id: `maximum-depth-round-${depth}-${index}`,
          predecessorRoundId: reviewRound.id,
          ...(depth === 16 ? { opensAt: authoritativeOpensAt } : {}),
          rubric: {
            ...reviewRound.rubric,
            id: `maximum-depth-rubric-${depth}-${index}`,
          },
        })),
      };
      await repository.putPlan(child, null);
      tip = child;
    }

    await expect(
      service.reconcilePlanRevisionFamily(
        organizer,
        tip.id,
        tip.version,
        "44444444-4444-4444-8444-444444444444",
      ),
    ).resolves.toEqual(tip);
    expect(repository.reconciliationCalls).toBe(4);
    const reconciledRoot = await repository.getPlan(tenantId, plan.id);
    expect(
      reconciledRoot?.rounds.every((reviewRound) => reviewRound.opensAt === authoritativeOpensAt),
    ).toBe(true);
  });

  it("rejects revision creation before an adapter without atomic family writes creates a draft", async () => {
    const repository = new NonAtomicEvaluationRepository();
    const { service, plan } = await fixture({ reviewsPerSubmission: 1, repository });

    await expect(
      service.revisePlanToDraft(organizer, plan.id, {
        expectedVersion: plan.version,
      }),
    ).rejects.toThrow("Review plan revisions require the authoritative D1 runtime.");
    expect(await repository.listPlans(tenantId, eventId)).toHaveLength(1);
  });

  it("keeps every plan unchanged when an ancestor schedule CAS fails", async () => {
    const { service, repository, plan } = await fixture({ reviewsPerSubmission: 1 });
    const revision = await service.revisePlanToDraft(organizer, plan.id, {
      expectedVersion: plan.version,
    });
    const selectedUpdate = {
      ...revision,
      closesAt: "2026-08-11T22:00:00.000Z",
      version: revision.version + 1,
    };
    const ancestorUpdate = {
      ...plan,
      closesAt: selectedUpdate.closesAt,
      version: plan.version + 1,
    };

    await expect(
      repository.putPlanSchedule(selectedUpdate, revision.version, [
        { plan: ancestorUpdate, expectedVersion: plan.version - 1 },
      ]),
    ).rejects.toThrow("Evaluation plan changed since it was loaded.");
    expect(await repository.getPlan(tenantId, revision.id)).toEqual(revision);
    expect(await repository.getPlan(tenantId, plan.id)).toEqual(plan);
  });

  it("requires an injected provider, snapshots revisions, and audits organizer overrides", async () => {
    const repository = new InMemoryEvaluationRepository();
    const source = new InMemorySubmissionReviewSource([{ ...submission, version: 7 }]);
    const provider = {
      generate: async () => ({
        candidates: [
          {
            criterionId: "quality",
            value: 4,
            evidence: ["The practical material gives the audience a concrete outcome."],
            provenance: {
              provider: "test-provider",
              model: "test-model",
              generatedAt: nowIso,
              sourceReferences: ["abstract:Practical material for the audience."],
            },
          },
          {
            criterionId: "relevance",
            value: 8,
            evidence: ["The practical audience focus directly supports program relevance."],
            provenance: {
              provider: "test-provider",
              model: "test-model",
              generatedAt: nowIso,
              sourceReferences: ["abstract:Practical material for the audience."],
            },
          },
        ],
        provenance: {
          provider: "test-provider",
          model: "test-model",
          generatedAt: nowIso,
          sourceReferences: ["abstract"],
        },
      }),
    };
    const service = new EvaluationService(
      repository,
      source,
      {
        ...evaluationEventSource(),
      },
      {
        clock: () => new Date(nowIso),
        aiSuggestionProvider: provider,
      },
    );
    const draft = await service.createPlan(organizer, {
      id: "suggestion-plan",
      eventId,
      name: "Suggestion plan",
      blindReview: true,
      closesAt: "2026-08-12T12:00:00.000Z",
      assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 2 },
      rounds: [triageRound],
    });
    const plan = await service.openPlan(organizer, draft.id, draft.version, crypto.randomUUID());

    const suggestion = await service.generateRoundAiSuggestions(organizer, {
      planId: plan.id,
      roundId: round.id,
      submissionId: submission.id,
    });
    expect(suggestion).toMatchObject({
      status: "pending",
      rubricRevision: plan.version,
      submissionRevision: 7,
      assignmentId: null,
      provenance: { provider: "test-provider", model: "test-model" },
    });
    expect(suggestion.candidates.quality?.[0]).toMatchObject({
      value: 4,
      evidence: ["The practical material gives the audience a concrete outcome."],
    });

    const cached = await service.generateRoundAiSuggestions(organizer, {
      planId: plan.id,
      roundId: round.id,
      submissionId: submission.id,
    });
    expect(cached.id).toBe(suggestion.id);

    const overridden = await service.overrideAiSuggestion(organizer, suggestion.id, {
      expectedVersion: suggestion.version,
      valueByCriterion: { quality: 5 },
      reason: "Committee judged the evidence stronger than the AI.",
    });
    expect(overridden).toMatchObject({
      status: "overridden",
      override: {
        valueByCriterion: { quality: 5 },
        overriddenBy: "organizer-1",
      },
    });
    expect(overridden.history.at(-1)).toMatchObject({
      action: "override",
      actorId: "organizer-1",
      valueByCriterion: { quality: 5 },
    });

    await expectEvaluationError(
      service.overrideAiSuggestion(organizer, suggestion.id, {
        expectedVersion: suggestion.version,
        valueByCriterion: { quality: 3 },
      }),
      "EVALUATION_CONFLICT",
    );

    const listed = await service.listRoundAiSuggestions(organizer, plan.id, round.id);
    expect(listed.map((item) => item.id)).toEqual([suggestion.id]);

    await expectEvaluationError(
      service.overrideAiSuggestion(reviewer("reviewer-1"), suggestion.id, {
        expectedVersion: overridden.version,
        valueByCriterion: { quality: 1 },
      }),
      "EVALUATION_FORBIDDEN",
    );
    await expectEvaluationError(
      service.generateRoundAiSuggestions(reviewer("reviewer-1"), {
        planId: plan.id,
        roundId: round.id,
        submissionId: submission.id,
      }),
      "EVALUATION_FORBIDDEN",
    );
  });

  it("never exposes shared AI triage to a reviewer before or after submission", async () => {
    const { service } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => ({ candidates: validAiCandidates() }),
    });
    const assignment = await assignOne(service);
    await generateTriage(service);

    const before = await service.getReviewContext(reviewer("reviewer-1"), assignment.id);
    expect(before).not.toHaveProperty("suggestions");

    const draft = await service.saveReview(reviewer("reviewer-1"), assignment.id, {
      scores: [
        { criterionId: "quality", value: 4, origin: "human" },
        { criterionId: "relevance", value: 8, origin: "human" },
      ],
    });
    await service.submitReview(reviewer("reviewer-1"), assignment.id, draft.version);
    const after = await service.getReviewContext(reviewer("reviewer-1"), assignment.id);
    expect(after).not.toHaveProperty("suggestions");
  });

  it("omits all answers and participant identity from blind-review AI triage", async () => {
    let capturedInput: EvaluationSuggestionProviderInput | undefined;
    const identifyingAnswers = {
      experience: "Advanced",
      speakerEmail: "speaker@example.com",
      phone: "+1 415 555 0134",
      website: "https://speaker.example.com",
      portfolio: "https://portfolio.example.com/speaker",
    };
    const { service, plan } = await fixture({
      blindReview: true,
      reviewRound: triageRound,
      reviewerProjection: {
        fieldIds: Object.keys(identifyingAnswers),
        fileIds: ["file-1"],
      },
      submissionMaterial: {
        ...submission,
        answers: identifyingAnswers,
        identityFieldIds: ["speakerEmail"],
        files: [
          {
            id: "file-1",
            name: "Jane-Doe-CV.pdf",
            mimeType: "application/pdf",
            sizeBytes: 24_000,
            url: "https://private-files.example.test/jane-cv.pdf",
          },
        ],
      },
      aiSuggestionProducer: async (input) => {
        capturedInput = input;
        return { candidates: validAiCandidates() };
      },
    });

    await service.generateRoundAiSuggestions(organizer, {
      planId: plan.id,
      roundId: triageRound.id,
      submissionId: submission.id,
    });

    expect(capturedInput?.submission).toMatchObject({
      answers: {},
      participants: [],
      identityRedacted: true,
    });
    const providerPayload = JSON.stringify(capturedInput);
    for (const identity of [
      ...Object.values(identifyingAnswers),
      "Speaker Name",
      "Identifying biography",
      "Jane-Doe-CV.pdf",
      "private-files.example.test",
    ]) {
      expect(providerPayload).not.toContain(identity);
    }
    expect(capturedInput?.submission.files).toEqual([
      { id: "redacted", name: "attachment", mimeType: "application/pdf", sizeBytes: 24_000 },
    ]);
  });

  it("preserves explicitly projected answers for non-blind AI triage", async () => {
    let capturedSubmission: EvaluationSuggestionProviderInput["submission"] | undefined;
    const { service, plan } = await fixture({
      blindReview: false,
      reviewRound: triageRound,
      reviewerProjection: { fieldIds: ["experience"] },
      aiSuggestionProducer: async (input) => {
        capturedSubmission = input.submission;
        return { candidates: validAiCandidates() };
      },
    });

    await service.generateRoundAiSuggestions(organizer, {
      planId: plan.id,
      roundId: triageRound.id,
      submissionId: submission.id,
    });

    expect(capturedSubmission?.answers).toEqual({ experience: "Advanced" });
    expect(capturedSubmission?.identityRedacted).toBe(false);
  });

  it("regenerates after a revision change replaces the stale scorecard", async () => {
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      submissionMaterial: { ...submission, version: 1 },
      aiSuggestionProducer: async () => ({ candidates: validAiCandidates() }),
    });

    const input = {
      planId: plan.id,
      roundId: triageRound.id,
      submissionId: submission.id,
    };
    const first = await service.generateRoundAiSuggestions(organizer, input);

    const regenerated = await service.generateRoundAiSuggestions(organizer, {
      ...input,
      regenerate: true,
    });

    expect(regenerated.id).not.toBe(first.id);
    expect(regenerated.status).toBe("pending");
    const listed = await service.listRoundAiSuggestions(organizer, plan.id, triageRound.id);
    const active = listed.filter((item) => item.status !== "stale");
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(regenerated.id);
    expect(listed.some((item) => item.id === first.id && item.status === "stale")).toBe(true);
  });

  it("persists exactly one shared scorecard when two organizers generate concurrently", async () => {
    const providerEntries: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const { service, plan } = await fixture({
      reviewsPerSubmission: 1,
      reviewRound: triageRound,
      aiSuggestionProducer: async () => {
        providerEntries.push(providerEntries.length);
        if (providerEntries.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        } else {
          releaseFirst?.();
        }
        return { candidates: validAiCandidates() };
      },
    });

    const input = {
      planId: plan.id,
      roundId: triageRound.id,
      submissionId: submission.id,
    };
    const [first, second] = await Promise.all([
      service.generateRoundAiSuggestions(organizer, input),
      service.generateRoundAiSuggestions(organizer, input),
    ]);

    expect(first.id).toBe(second.id);
    const listed = await service.listRoundAiSuggestions(organizer, plan.id, triageRound.id);
    expect(listed.filter((item) => item.status !== "stale")).toHaveLength(1);
  });

  it("marks suggestions stale when the submission revision changes", async () => {
    const repository = new InMemoryEvaluationRepository();
    const source = new InMemorySubmissionReviewSource([{ ...submission, version: 1 }]);
    const service = new EvaluationService(
      repository,
      source,
      {
        ...evaluationEventSource(),
      },
      {
        clock: () => new Date(nowIso),
        aiSuggestionProducer: async () => ({ candidates: validAiCandidates() }),
      },
    );
    const draft = await service.createPlan(organizer, {
      id: "stale-plan",
      eventId,
      name: "Stale plan",
      blindReview: true,
      closesAt: "2026-08-12T12:00:00.000Z",
      assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 2 },
      rounds: [triageRound],
    });
    const plan = await service.openPlan(organizer, draft.id, draft.version, crypto.randomUUID());

    const suggestion = await service.generateRoundAiSuggestions(organizer, {
      planId: plan.id,
      roundId: round.id,
      submissionId: submission.id,
    });
    source.set({ ...submission, version: 2 });
    const listed = await service.listRoundAiSuggestions(organizer, plan.id, round.id);
    expect(listed[0]).toMatchObject({ id: suggestion.id, status: "stale" });
    await expectEvaluationError(
      service.overrideAiSuggestion(organizer, suggestion.id, {
        expectedVersion: suggestion.version,
        valueByCriterion: { quality: 3 },
      }),
      "EVALUATION_CONFLICT",
    );
  });
});
