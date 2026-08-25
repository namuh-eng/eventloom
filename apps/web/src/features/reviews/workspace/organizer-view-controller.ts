"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OrganizationMember } from "../../members/api";
import { useOrganizerAiTriage } from "../organizer-ai-triage";
import type { ApiOrganizerResultScope } from "./api-api-organizer-workspace-response";
import type { ApiPlan } from "./api-api-plan";
import type { AggregateRow } from "./organizer-aggregate-row";
import type { DecisionStatus } from "./organizer-decision-status";
import { loadRoundAggregates } from "./organizer-load-round-aggregates";
import { mapSeedRoundAggregates } from "./organizer-map-seed-round-aggregates";
import {
  createOrganizerResultsExportAttemptRunner,
  type OrganizerResultsExportRun,
} from "./organizer-results-export";
import type { ReviewPlanSeed } from "./organizer-review-plan-seed";

import { deriveOrganizerWorkspaceModel } from "./organizer-view-model";
export interface OrganizerWorkspaceViewProps {
  seed: ReviewPlanSeed;
  baseUrl: string;
  organizationId?: string | undefined;
  reviewerMembers: readonly OrganizationMember[];
  reviewerMembersLoading: boolean;
  reviewerMembersError: string | null;
  onAuthoritativePlan?: ((plan: ApiPlan) => void) | undefined;
  onAssignmentsPersisted?: (() => Promise<void>) | undefined;
}

export interface OrganizerDecisionOverrideState {
  readonly planId: string;
  readonly decisions: ReviewPlanSeed["decisionBySubmission"];
}

export function mergeOrganizerDecisionOverrides(
  seed: ReviewPlanSeed,
  overrides: OrganizerDecisionOverrideState,
): ReviewPlanSeed["decisionBySubmission"] {
  if (overrides.planId !== seed.planId) return {};
  return Object.fromEntries(
    Object.entries(overrides.decisions).filter(
      ([submissionId, decision]) =>
        decision.version > (seed.decisionBySubmission[submissionId]?.version ?? 0),
    ),
  );
}

export function useOrganizerWorkspaceViewController({
  seed,
  baseUrl,
  organizationId,
  reviewerMembers,
  reviewerMembersLoading,
  reviewerMembersError,
  onAuthoritativePlan,
  onAssignmentsPersisted,
}: OrganizerWorkspaceViewProps) {
  const activeRound =
    [...seed.rounds]
      .filter((round) => round.status === "open")
      .sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0))[0] ??
    [...seed.rounds].sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0))[0];
  const resultScopes = useMemo(() => {
    const scopes = seed.resultScopes?.length
      ? seed.resultScopes
      : seed.rounds.map((round, index) => ({
          planId: seed.planId,
          planVersion: seed.version,
          lineageOrdinal: 0,
          planName: seed.planName,
          roundId: round.id,
          roundName: round.name,
          sequence: round.sequence ?? index,
          historical: false,
        }));
    return [
      ...new Map(
        scopes.map((scope) => [JSON.stringify([scope.planId, scope.roundId]), scope]),
      ).values(),
    ];
  }, [seed]);
  const scopeKey = (scope: ApiOrganizerResultScope): string =>
    JSON.stringify([scope.planId, scope.roundId]);
  const initialRoundId =
    seed.aggregates.find((aggregate) => aggregate.roundId !== undefined)?.roundId ??
    activeRound?.id ??
    seed.rounds[0]?.id ??
    "";
  const initialResultScope =
    resultScopes.find(
      (scope) => scope.planId === seed.planId && scope.roundId === initialRoundId,
    ) ??
    resultScopes.find((scope) => scope.planId === seed.planId) ??
    resultScopes[0];
  const [selectedScopeOverride, setSelectedScopeOverride] = useState<string | null>(null);
  const selectedResultScope =
    resultScopes.find((scope) => scopeKey(scope) === selectedScopeOverride) ?? initialResultScope;
  const selectedRoundId = selectedResultScope?.roundId ?? "";
  const setSelectedRoundId = (value: string): void => {
    setSelectedScopeOverride(value);
  };
  const [roundAggregates, setRoundAggregates] = useState<readonly AggregateRow[]>(seed.aggregates);
  const [aggregateLoading, setAggregateLoading] = useState(false);
  const [aggregateError, setAggregateError] = useState<string | null>(null);
  const [aggregateSort, setAggregateSort] = useState<"ascending" | "descending">("descending");
  const [exportRun, setExportRun] = useState<OrganizerResultsExportRun | null>(null);
  const [exportCreating, setExportCreating] = useState(false);
  const [exportRequestError, setExportRequestError] = useState<string | null>(null);
  const [view, setView] = useState<"overview" | "setup" | "assignments" | "decisions">(
    seed.status === "draft" ? "setup" : "overview",
  );
  const [assignmentTarget, setAssignmentTarget] = useState<{
    readonly roundId: string;
    readonly submissionId: string;
  } | null>(null);
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
  const [decisionQuery, setDecisionQuery] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<"all" | "undecided" | DecisionStatus>(
    "undecided",
  );
  const [decisionRowLimit, setDecisionRowLimit] = useState(5);
  const [decisionOverrides, setDecisionOverrides] = useState<OrganizerDecisionOverrideState>({
    planId: seed.planId,
    decisions: {},
  });
  const currentDecisionOverrides = useMemo(
    () => mergeOrganizerDecisionOverrides(seed, decisionOverrides),
    [decisionOverrides, seed],
  );
  const effectiveDecisionBySubmission = useMemo(
    () => ({
      ...seed.decisionBySubmission,
      ...currentDecisionOverrides,
    }),
    [currentDecisionOverrides, seed.decisionBySubmission],
  );
  const effectiveSeed = useMemo(
    () => ({ ...seed, decisionBySubmission: effectiveDecisionBySubmission }),
    [effectiveDecisionBySubmission, seed],
  );
  const decisionEditorRef = useRef<HTMLDivElement | null>(null);
  const exportAbortControllerRef = useRef<AbortController | null>(null);
  const exportAttemptRunnerRef = useRef(createOrganizerResultsExportAttemptRunner());
  const isActiveResultScope = selectedResultScope?.planId === seed.planId;
  const selectedRound = isActiveResultScope
    ? (seed.rounds.find((round) => round.id === selectedRoundId) ?? activeRound)
    : undefined;
  const aiTriage = useOrganizerAiTriage({
    baseUrl,
    planId: seed.planId,
    roundId: selectedRoundId,
    enabled: isActiveResultScope && selectedRound?.aiTriageEnabled === true,
  });
  const aiTriageCriterionLabels = Object.fromEntries(
    (selectedRound?.rubric.criteria ?? []).map((criterion) => [criterion.id, criterion.label]),
  );
  useEffect(
    () => () => {
      exportAbortControllerRef.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (selectedResultScope === undefined || selectedRoundId.length === 0) return;
    let cancelled = false;
    setAggregateLoading(true);
    setAggregateError(null);
    void loadRoundAggregates(baseUrl, selectedResultScope.planId, selectedRoundId)
      .then((aggregates) => {
        if (!cancelled) {
          setRoundAggregates(mapSeedRoundAggregates(seed, aggregates, selectedRoundId));
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setAggregateError(
            reason instanceof Error
              ? reason.message
              : `Aggregates for ${selectedRoundId} are unavailable; other organizer data remains available.`,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setAggregateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, seed, selectedResultScope, selectedRoundId]);
  useEffect(() => {
    if (selectedDecisionId === null) return;
    decisionEditorRef.current?.focus();
    decisionEditorRef.current?.scrollIntoView({ block: "start" });
  }, [selectedDecisionId]);
  const derived = deriveOrganizerWorkspaceModel({
    seed: effectiveSeed,
    roundAggregates,
    aggregateSort,
    decisionFilter,
    decisionQuery,
    decisionRowLimit,
    selectedDecisionId,
    selectedRound,
    selectedRoundId,
    resultScopeIsActive: isActiveResultScope,
    reviewerMembers,
  });
  function openReviewersForSubmission(submissionId: string): void {
    if (!isActiveResultScope) return;
    const aggregate = roundAggregates.find((candidate) => candidate.id === submissionId);
    const roundId = aggregate?.roundId ?? selectedRound?.id ?? selectedRoundId;
    if (roundId.length > 0) setAssignmentTarget({ roundId, submissionId });
    setView("assignments");
  }

  function openDecisionForSubmission(submissionId: string): void {
    if (!isActiveResultScope) return;
    const aggregate = roundAggregates.find((candidate) => candidate.id === submissionId);
    const roundId = aggregate?.roundId ?? selectedRound?.id ?? selectedRoundId;
    if (roundId.length > 0) {
      const scope = resultScopes.find(
        (candidate) => candidate.planId === seed.planId && candidate.roundId === roundId,
      );
      if (scope !== undefined) setSelectedRoundId(scopeKey(scope));
    }
    setDecisionQuery("");
    setDecisionFilter("all");
    setSelectedDecisionId(submissionId);
    setView("decisions");
  }

  function recordDecision(
    submissionId: string,
    decision: ReviewPlanSeed["decisionBySubmission"][string],
  ): void {
    if (!isActiveResultScope) return;
    setDecisionOverrides((current) => ({
      planId: seed.planId,
      decisions: {
        ...(current.planId === seed.planId ? current.decisions : {}),
        [submissionId]: decision,
      },
    }));
  }

  async function exportResults(): Promise<void> {
    if (!isActiveResultScope || exportAbortControllerRef.current !== null) return;
    const controller = new AbortController();
    exportAbortControllerRef.current = controller;
    setExportCreating(true);
    setExportRun(null);
    setExportRequestError(null);
    try {
      const terminal = await exportAttemptRunnerRef.current.start({
        baseUrl,
        planId: seed.planId,
        signal: controller.signal,
        onStatus: setExportRun,
      });
      setExportRun(terminal);
    } catch (reason: unknown) {
      if (controller.signal.aborted) return;
      setExportRequestError(
        reason instanceof Error ? reason.message : "The CSV export could not be generated.",
      );
    } finally {
      if (exportAbortControllerRef.current === controller) {
        exportAbortControllerRef.current = null;
        setExportCreating(false);
      }
    }
  }

  return {
    seed: effectiveSeed,
    baseUrl,
    organizationId,
    reviewerMembers,
    reviewerMembersLoading,
    reviewerMembersError,
    onAuthoritativePlan,
    onAssignmentsPersisted,
    activeRound,
    initialRoundId,
    selectedRoundId,
    selectedResultScope,
    selectedResultScopeKey: selectedResultScope === undefined ? "" : scopeKey(selectedResultScope),
    resultScopes,
    isActiveResultScope,
    setSelectedRoundId,
    roundAggregates,
    aggregateLoading,
    aggregateError,
    aggregateSort,
    setAggregateSort,
    exportRun,
    exportCreating,
    exportRequestError,
    view,
    setView,
    assignmentTarget,
    selectedDecisionId,
    setSelectedDecisionId,
    decisionQuery,
    setDecisionQuery,
    decisionFilter,
    setDecisionFilter,
    decisionRowLimit,
    setDecisionRowLimit,
    decisionEditorRef,
    selectedRound,
    aiTriage: { ...aiTriage, criterionLabels: aiTriageCriterionLabels },
    ...derived,
    openReviewersForSubmission,
    openDecisionForSubmission,
    recordDecision,
    exportResults,
  };
}
export type OrganizerWorkspaceViewController = ReturnType<
  typeof useOrganizerWorkspaceViewController
>;
