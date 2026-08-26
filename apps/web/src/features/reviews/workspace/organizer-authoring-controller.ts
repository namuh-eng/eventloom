"use client";
import { useOrganizerAssignmentActions } from "./organizer-authoring-assignment-actions";
import { useOrganizerLifecycleActions } from "./organizer-authoring-lifecycle-actions";
import { useOrganizerPlanActions } from "./organizer-authoring-plan-actions";
import { useOrganizerRoundActions } from "./organizer-authoring-round-actions";
import type { OrganizerAuthoringProps } from "./organizer-authoring-state";
import { useOrganizerAuthoringState } from "./organizer-authoring-state";
import { useOrganizerReviewerPool } from "./organizer-reviewer-pool-controller";
export function useOrganizerAuthoringController(props: OrganizerAuthoringProps) {
  const state = useOrganizerAuthoringState(props);
  const rounds = useOrganizerRoundActions(state);
  const plan = useOrganizerPlanActions(rounds);
  const assignments = useOrganizerAssignmentActions(plan);
  const lifecycle = useOrganizerLifecycleActions(assignments);
  const reviewerPool = useOrganizerReviewerPool({
    baseUrl: lifecycle.baseUrl,
    organizationId: lifecycle.organizationId,
    eventId: lifecycle.seed.eventId,
    roundId: lifecycle.assignmentRoundId,
    reviewers: lifecycle.reviewerMembers,
    defaultMaxAssignments: lifecycle.maxAssignmentsPerReviewer,
    onSaved: lifecycle.onAssignmentsPersisted,
    onSaveStart: () => assignments.blockAssignmentsForReviewerPoolSave(),
    onSaveFinished: () => assignments.unblockAssignmentsAfterReviewerPoolSave(),
  });
  return { ...lifecycle, reviewerPool };
}
export type OrganizerAuthoringController = ReturnType<typeof useOrganizerAuthoringController>;
