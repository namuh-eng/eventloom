"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createMemberApi,
  type MemberApi,
  MemberApiError,
  type OrganizationMember,
  type ReviewerPool,
} from "../../members/api";
import { browserSameOrigin } from "./model-browser-same-origin";
import {
  reviewerPoolScopeKey,
  type ScopedReviewerPoolValue,
  scopedReviewerPoolValue,
} from "./model-reviewer-pool-scope";
import { buildReviewerPoolInput, type ReviewerPoolDraft } from "./organizer-reviewer-pool-model";

interface OrganizerReviewerPoolOptions {
  readonly baseUrl: string;
  readonly organizationId?: string | undefined;
  readonly eventId: string;
  readonly roundId: string;
  readonly reviewers: readonly OrganizationMember[];
  readonly defaultMaxAssignments: number;
  readonly onSaved?: (() => Promise<void>) | undefined;
  readonly onSaveStart?: (() => boolean | undefined) | undefined;
  readonly onSaveFinished?: (() => void) | undefined;
}

function poolDraft(pool: ReviewerPool | null): ReviewerPoolDraft {
  return Object.fromEntries(
    pool?.grants.map((grant) => [grant.reviewerId, grant.maxAssignments]) ?? [],
  );
}

function reviewerPoolError(reason: unknown): string {
  if (reason instanceof MemberApiError && reason.status === 409) {
    return "This review team changed in another session. Reload the team before saving again.";
  }
  if (reason instanceof MemberApiError && reason.status === 403) {
    return "Your organization role cannot change this review team.";
  }
  return reason instanceof Error && reason.message.trim().length > 0
    ? reason.message
    : "The review team could not be loaded.";
}

export function useOrganizerReviewerPool({
  baseUrl,
  organizationId,
  eventId,
  roundId,
  reviewers,
  defaultMaxAssignments,
  onSaved,
  onSaveStart,
  onSaveFinished,
}: OrganizerReviewerPoolOptions) {
  const resolvedOrganizationId = organizationId?.trim() ?? "";
  const resolvedEventId = eventId.trim();
  const resolvedRoundId = roundId.trim();
  const scopeKey = reviewerPoolScopeKey(resolvedOrganizationId, resolvedEventId, resolvedRoundId);
  const currentScopeRef = useRef(scopeKey);
  currentScopeRef.current = scopeKey;
  const memberApi = useMemo<MemberApi | null>(() => {
    if (!resolvedOrganizationId) return null;
    try {
      return createMemberApi(baseUrl || browserSameOrigin(), resolvedOrganizationId);
    } catch {
      return null;
    }
  }, [baseUrl, resolvedOrganizationId]);
  const [poolState, setPoolState] = useState<ScopedReviewerPoolValue<ReviewerPool | null>>({
    scopeKey: "",
    value: null,
  });
  const [draftState, setDraftState] = useState<ScopedReviewerPoolValue<ReviewerPoolDraft>>({
    scopeKey: "",
    value: {},
  });
  const pool = scopedReviewerPoolValue(scopeKey, poolState, null);
  const draft = scopedReviewerPoolValue(scopeKey, draftState, {});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const saveSequenceRef = useRef(0);
  const setDraft = useCallback(
    (update: ReviewerPoolDraft | ((current: ReviewerPoolDraft) => ReviewerPoolDraft)): void => {
      setDraftState((current) => {
        const currentValue = scopedReviewerPoolValue(scopeKey, current, {});
        return {
          scopeKey,
          value: typeof update === "function" ? update(currentValue) : update,
        };
      });
    },
    [scopeKey],
  );

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const requestedScope = scopeKey;
      const sequence = loadSequenceRef.current + 1;
      loadSequenceRef.current = sequence;
      setLoading(true);
      try {
        if (memberApi === null || !resolvedEventId || !resolvedRoundId) {
          setPoolState({ scopeKey: requestedScope, value: null });
          setDraftState({ scopeKey: requestedScope, value: {} });
          setError("The organization review-team service is not configured.");
          return;
        }
        setError(null);
        setMessage(null);
        setPoolState({ scopeKey: requestedScope, value: null });
        setDraftState({ scopeKey: requestedScope, value: {} });
        const nextPool = await memberApi.getReviewerPool(resolvedEventId, resolvedRoundId, signal);
        if (
          signal?.aborted ||
          loadSequenceRef.current !== sequence ||
          currentScopeRef.current !== requestedScope
        ) {
          return;
        }
        setPoolState({ scopeKey: requestedScope, value: nextPool });
        setDraftState({ scopeKey: requestedScope, value: poolDraft(nextPool) });
      } catch (reason: unknown) {
        if (
          !signal?.aborted &&
          loadSequenceRef.current === sequence &&
          currentScopeRef.current === requestedScope
        ) {
          setError(reviewerPoolError(reason));
        }
      } finally {
        setLoading((current) => (loadSequenceRef.current === sequence ? false : current));
      }
    },
    [memberApi, resolvedEventId, resolvedRoundId, scopeKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function changeReviewer(reviewerId: string, selected: boolean): void {
    if (!reviewers.some((reviewer) => reviewer.userId === reviewerId)) return;
    setDraft((current) => {
      if (!selected) {
        const next = { ...current };
        delete next[reviewerId];
        return next;
      }
      const previous = pool?.grants.find((grant) => grant.reviewerId === reviewerId);
      return {
        ...current,
        [reviewerId]: previous?.maxAssignments ?? Math.max(1, defaultMaxAssignments),
      };
    });
    setMessage(null);
  }

  function changeMaxAssignments(reviewerId: string, value: number): void {
    if (draft[reviewerId] === undefined) return;
    const maxAssignments = Number.isSafeInteger(value) && value > 0 ? Math.min(value, 10_000) : 1;
    setDraft((current) => ({ ...current, [reviewerId]: maxAssignments }));
    setMessage(null);
  }

  async function save(): Promise<void> {
    if (memberApi === null || !resolvedEventId || !resolvedRoundId) {
      setError("The organization review-team service is not configured.");
      return;
    }
    const sequence = saveSequenceRef.current + 1;
    const requestedScope = scopeKey;
    let saveStartAttempted = false;
    saveSequenceRef.current = sequence;
    setSaving(true);
    try {
      saveStartAttempted = true;
      if (onSaveStart?.() === false) return;
      setError(null);
      setMessage(null);
      const nextPool = await memberApi.setReviewerPool(
        resolvedEventId,
        resolvedRoundId,
        buildReviewerPoolInput(draft, pool?.version),
      );
      if (saveSequenceRef.current !== sequence || currentScopeRef.current !== requestedScope) {
        return;
      }
      setPoolState({ scopeKey: requestedScope, value: nextPool });
      setDraftState({ scopeKey: requestedScope, value: poolDraft(nextPool) });
      setMessage("Review team saved. Assignment candidates now match this round.");
      await onSaved?.();
    } catch (reason: unknown) {
      if (saveSequenceRef.current === sequence && currentScopeRef.current === requestedScope) {
        setError(reviewerPoolError(reason));
      }
    } finally {
      let finishError: unknown;
      if (saveStartAttempted) {
        try {
          onSaveFinished?.();
        } catch (reason: unknown) {
          finishError = reason;
        }
      }
      if (saveSequenceRef.current === sequence) {
        setSaving(false);
        if (finishError !== undefined && currentScopeRef.current === requestedScope) {
          setError(reviewerPoolError(finishError));
        }
      }
    }
  }

  return {
    pool,
    draft,
    loading,
    saving,
    error,
    message,
    changeReviewer,
    changeMaxAssignments,
    save,
    reload: () => void load(),
  };
}
