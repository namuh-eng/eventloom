"use client";

import { useRef, useState } from "react";
import { applyReviewAssignments } from "./assignment-apply-review-assignments";
import type { DistributionPreviewInput } from "./assignment-distribution-preview-input";
import { previewReviewAssignments } from "./assignment-preview-review-assignments";
import {
  assignmentDistributionReviewerIds,
  assignmentReviewerSelectionError,
} from "./model-assignment-reviewer-selection";
import { distributionPreviewKey } from "./model-distribution-preview-key";
import type { OrganizerPlanActions } from "./organizer-authoring-plan-actions";

export function distributionAppliedMessage(activeAssignmentCount: number): string {
  const assignmentLabel = activeAssignmentCount === 1 ? "assignment" : "assignments";
  return `Reviewer assignments updated. ${activeAssignmentCount} active ${assignmentLabel}.`;
}

export function useOrganizerAssignmentActions(scope: OrganizerPlanActions) {
  const {
    seed,
    baseUrl,
    reviewerMembersError,
    onAssignmentsPersisted,
    rounds,
    assignmentRoundId,
    assignmentPreview,
    setAssignmentPreview,
    assignmentPreviewKey,
    setAssignmentPreviewKey,
    setMessage,
    assignmentSubmissionId,
    assignmentReviewerIds,
    assignmentReviewerSelectionMode,
    version,
    status,
    busy,
    setBusy,
    reviewerIdSet,
    reviewerDirectoryReady,
  } = scope;
  const reviewerPoolSavePendingRef = useRef(false);
  const previewRequestSequenceRef = useRef(0);
  const activeAssignmentOperationRef = useRef<{
    readonly kind: "apply" | "preview";
    readonly sequence: number;
  } | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [reviewerPoolSavePending, setReviewerPoolSavePending] = useState(false);

  function blockAssignmentsForReviewerPoolSave(): boolean {
    if (
      reviewerPoolSavePendingRef.current ||
      activeAssignmentOperationRef.current !== null ||
      busyRef.current
    ) {
      setMessage("Wait for the current authoring operation before saving the review team.");
      return false;
    }
    reviewerPoolSavePendingRef.current = true;
    previewRequestSequenceRef.current += 1;
    setReviewerPoolSavePending(true);
    setAssignmentPreview(null);
    setAssignmentPreviewKey(null);
    busyRef.current = true;
    setBusy(true);
    return true;
  }

  function unblockAssignmentsAfterReviewerPoolSave(): void {
    if (!reviewerPoolSavePendingRef.current) return;
    previewRequestSequenceRef.current += 1;
    setAssignmentPreview(null);
    setAssignmentPreviewKey(null);
    reviewerPoolSavePendingRef.current = false;
    setReviewerPoolSavePending(false);
    busyRef.current = false;
    setBusy(false);
  }

  function assignmentsBlockedByReviewerPoolSave(): boolean {
    return reviewerPoolSavePendingRef.current;
  }

  function beginAssignmentOperation(kind: "apply" | "preview", sequence: number): boolean {
    const activeOperation = activeAssignmentOperationRef.current;
    if (
      assignmentsBlockedByReviewerPoolSave() ||
      (busyRef.current && activeOperation === null) ||
      activeOperation?.kind === "apply" ||
      (kind === "apply" && activeOperation !== null)
    ) {
      setMessage("Wait for the current authoring operation before continuing.");
      return false;
    }
    activeAssignmentOperationRef.current = { kind, sequence };
    busyRef.current = true;
    setBusy(true);
    return true;
  }

  function finishAssignmentOperation(sequence: number): void {
    if (activeAssignmentOperationRef.current?.sequence !== sequence) return;
    activeAssignmentOperationRef.current = null;
    if (!assignmentsBlockedByReviewerPoolSave()) {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function previewAssignments(): Promise<void> {
    if (assignmentsBlockedByReviewerPoolSave()) {
      setMessage("Wait for the review-team save and authoritative refresh before previewing.");
      return;
    }
    const previewRequestSequence = previewRequestSequenceRef.current + 1;
    previewRequestSequenceRef.current = previewRequestSequence;
    if (status !== "open") {
      setAssignmentPreview(null);
      setAssignmentPreviewKey(null);
      setMessage("Reviewer assignments require an open evaluation plan.");
      return;
    }
    const round = rounds.find((candidate) => candidate.id === assignmentRoundId);
    const reviewerIds = [...assignmentReviewerIds];
    const reviewerSelectionError = assignmentReviewerSelectionError(
      assignmentReviewerSelectionMode,
      reviewerIds,
    );
    const submissionId = assignmentSubmissionId.trim();
    if (round === undefined || submissionId.length === 0) {
      setMessage("Choose a round and proposal to preview reviewer distribution.");
      return;
    }
    if (!reviewerDirectoryReady) {
      setMessage(
        reviewerMembersError ??
          "Load the active, verified organization reviewers before previewing a distribution.",
      );
      return;
    }
    if (reviewerSelectionError !== null) {
      setMessage(reviewerSelectionError);
      return;
    }
    if (reviewerIds.some((reviewerId) => !reviewerIdSet.has(reviewerId))) {
      setMessage("Select only active, verified organization reviewers.");
      return;
    }
    if (!beginAssignmentOperation("preview", previewRequestSequence)) return;
    setMessage(null);
    try {
      const requestReviewerIds = assignmentDistributionReviewerIds(
        assignmentReviewerSelectionMode,
        reviewerIds,
      );
      const input = {
        roundId: round.id,
        submissionIds: [submissionId],
        ...(requestReviewerIds === undefined ? {} : { reviewerIds: requestReviewerIds }),
        expectedVersion: version,
      } satisfies DistributionPreviewInput;
      const preview = await previewReviewAssignments(baseUrl, seed.planId, input);
      if (
        assignmentsBlockedByReviewerPoolSave() ||
        previewRequestSequenceRef.current !== previewRequestSequence ||
        activeAssignmentOperationRef.current?.sequence !== previewRequestSequence
      ) {
        return;
      }
      setAssignmentPreview(preview);
      setAssignmentPreviewKey(distributionPreviewKey(input));
      setMessage("Authoritative reviewer distribution preview loaded.");
    } catch (reason: unknown) {
      if (
        assignmentsBlockedByReviewerPoolSave() ||
        previewRequestSequenceRef.current !== previewRequestSequence ||
        activeAssignmentOperationRef.current?.sequence !== previewRequestSequence
      ) {
        return;
      }
      setAssignmentPreview(null);
      setAssignmentPreviewKey(null);
      setMessage(
        reason instanceof Error
          ? reason.message
          : "The reviewer distribution preview could not be loaded.",
      );
    } finally {
      finishAssignmentOperation(previewRequestSequence);
    }
  }

  async function assignReviewers(): Promise<void> {
    if (assignmentsBlockedByReviewerPoolSave()) {
      setMessage("Wait for the review-team save and authoritative refresh before applying.");
      return;
    }
    if (status !== "open") {
      setMessage("Reviewer assignments require an open evaluation plan.");
      return;
    }
    const round = rounds.find((candidate) => candidate.id === assignmentRoundId);
    const reviewerIds = [...assignmentReviewerIds];
    const reviewerSelectionError = assignmentReviewerSelectionError(
      assignmentReviewerSelectionMode,
      reviewerIds,
    );
    const submissionId = assignmentSubmissionId.trim();
    if (round === undefined || submissionId.length === 0) {
      setMessage("Choose a round and proposal.");
      return;
    }
    if (!reviewerDirectoryReady) {
      setMessage(
        reviewerMembersError ??
          "Load the active, verified organization reviewers before applying a distribution.",
      );
      return;
    }
    if (reviewerSelectionError !== null) {
      setMessage(reviewerSelectionError);
      return;
    }
    if (reviewerIds.some((reviewerId) => !reviewerIdSet.has(reviewerId))) {
      setMessage("Select only active, verified organization reviewers.");
      return;
    }
    const preview = assignmentPreview;
    const requestReviewerIds = assignmentDistributionReviewerIds(
      assignmentReviewerSelectionMode,
      reviewerIds,
    );
    const input = {
      roundId: round.id,
      submissionIds: [submissionId],
      ...(requestReviewerIds === undefined ? {} : { reviewerIds: requestReviewerIds }),
      expectedVersion: version,
    } satisfies DistributionPreviewInput;
    if (
      preview === null ||
      assignmentPreviewKey !== distributionPreviewKey(input) ||
      preview.scope.roundId !== round.id ||
      preview.fingerprint.trim().length === 0
    ) {
      setMessage("Load a fresh authoritative preview before applying reviewer distribution.");
      return;
    }
    const assignmentRequestSequence = previewRequestSequenceRef.current + 1;
    previewRequestSequenceRef.current = assignmentRequestSequence;
    if (!beginAssignmentOperation("apply", assignmentRequestSequence)) return;
    setMessage(null);
    try {
      const result = await applyReviewAssignments(baseUrl, seed.planId, {
        ...input,
        fingerprint: preview.fingerprint,
      });
      if (
        previewRequestSequenceRef.current !== assignmentRequestSequence ||
        activeAssignmentOperationRef.current?.sequence !== assignmentRequestSequence
      ) {
        return;
      }
      setAssignmentPreview(null);
      setAssignmentPreviewKey(null);
      setMessage(distributionAppliedMessage(result.activeAssignments.length));
      await onAssignmentsPersisted?.();
    } catch (reason: unknown) {
      if (
        previewRequestSequenceRef.current !== assignmentRequestSequence ||
        activeAssignmentOperationRef.current?.sequence !== assignmentRequestSequence
      ) {
        return;
      }
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Reviewer distribution could not be applied atomically.",
      );
    } finally {
      finishAssignmentOperation(assignmentRequestSequence);
    }
  }
  return {
    ...scope,
    reviewerPoolSavePending,
    blockAssignmentsForReviewerPoolSave,
    unblockAssignmentsAfterReviewerPoolSave,
    previewAssignments,
    assignReviewers,
  };
}
export type OrganizerAssignmentActions = ReturnType<typeof useOrganizerAssignmentActions>;
