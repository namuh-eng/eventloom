import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { useOrganizerPlanActions } from "./organizer-authoring-plan-actions";
import type { OrganizerRoundActions } from "./organizer-authoring-round-actions";
import {
  prefersAuthoritativePlan,
  shouldApplyAuthoritativePlan,
} from "./organizer-organizer-workspace";
import { reviewPlanClosesAtField } from "./review-temporal-policy";

const authoringWorkbenchSource = readFileSync(
  fileURLToPath(new URL("./organizer-authoring-workbench.tsx", import.meta.url)),
  "utf8",
);
const workspaceStyles = readFileSync(
  fileURLToPath(new URL("../review-workspace.module.css", import.meta.url)),
  "utf8",
);

describe("review authoring action rail accessibility order", () => {
  it("places actions before the editor and explicitly restores the visual grid order", () => {
    expect(authoringWorkbenchSource.indexOf("<OrganizerPlanActionsView")).toBeLessThan(
      authoringWorkbenchSource.indexOf("<OrganizerDraftPlan"),
    );
    expect(workspaceStyles).toContain(`.authoringMain {
  grid-column: 1;
  grid-row: 1;
}`);
    expect(workspaceStyles).toContain(`.authoringAside {
  grid-column: 2;
  grid-row: 1;
}`);
    expect(workspaceStyles).toContain(`.authoringMain {
    grid-column: 1;
    grid-row: 2;
  }

  .authoringAside {
    position: static;
    grid-column: 1;
    grid-row: 1;
  }`);
  });
});
function unresolvedPlanScope(
  setMessage: (message: string | null) => void,
  status: "draft" | "open" = "draft",
): OrganizerRoundActions {
  return {
    seed: { planId: "plan-test" },
    baseUrl: "",
    reviewerMembersError: null,
    onAuthoritativePlan: undefined,
    name: "Review plan",
    setName: () => undefined,
    planClosesAt: "2026-03-08T09:30:00.000Z",
    setPlanClosesAt: () => undefined,
    blindReview: false,
    setBlindReview: () => undefined,
    reviewsPerSubmission: 1,
    setReviewsPerSubmission: () => undefined,
    maxAssignmentsPerReviewer: 5,
    setMaxAssignmentsPerReviewer: () => undefined,
    fieldIds: "",
    setFieldIds: () => undefined,
    fileIds: "",
    setFileIds: () => undefined,
    rounds: [],
    setRounds: () => undefined,
    setMessage,
    version: 3,
    setVersion: () => undefined,
    status,
    setStatus: () => undefined,
    setBusy: () => undefined,
    reviewerIdSet: new Set<string>(),
    reviewerDirectoryReady: true,
    unresolvedTemporalFields: new Set([reviewPlanClosesAtField]),
  } as unknown as OrganizerRoundActions;
}

describe("review authoring temporal integrity", () => {
  it.each([
    ["draft", "saveDraft"],
    ["open", "saveSchedule"],
  ] as const)(
    "blocks the %s save path while a DST-local draft is unresolved",
    async (status, action) => {
      const setMessage = vi.fn();
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const actions = useOrganizerPlanActions(unresolvedPlanScope(setMessage, status));

      await actions[action]();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(setMessage).toHaveBeenCalledWith(
        "Resolve the invalid or ambiguous review date and time before saving.",
      );
    },
  );
});

describe("review authoring authoritative identity", () => {
  it("adopts a lower-version revision while rejecting a stale same-plan seed", () => {
    expect(
      prefersAuthoritativePlan(
        { planId: "plan-original", version: 2 },
        { planId: "plan-revision", version: 1 },
      ),
    ).toBe(true);
    expect(
      prefersAuthoritativePlan(
        { planId: "plan-original", version: 2 },
        { planId: "plan-original", version: 1 },
      ),
    ).toBe(false);
    expect(
      shouldApplyAuthoritativePlan({ planId: "plan-revision", version: 1 }, "plan-original", {
        planId: "plan-original",
        version: 3,
      }),
    ).toBe(false);
    expect(
      shouldApplyAuthoritativePlan({ planId: "plan-revision", version: 2 }, "plan-revision", {
        planId: "plan-revision",
        version: 1,
      }),
    ).toBe(false);
  });
});
describe("review authoring plan identity", () => {
  it("saves a newly activated draft revision with its own version and scorecards", async () => {
    const setRounds = vi.fn();
    const onAuthoritativePlan = vi.fn();
    const rounds = [
      {
        id: "round-first",
        name: "First round",
        sequence: 1,
        opensAt: null,
        closesAt: null,
        blindReview: false,
        rubric: {
          id: "rubric-first",
          name: "First rubric",
          criteria: [{ id: "first-score", label: "First Score", minimum: 1, maximum: 5 }],
        },
      },
      {
        id: "round-final",
        name: "Final round",
        sequence: 2,
        opensAt: null,
        closesAt: null,
        blindReview: false,
        rubric: {
          id: "rubric-final",
          name: "Final rubric",
          criteria: [{ id: "final-score", label: "Final Score", minimum: 1, maximum: 10 }],
        },
      },
    ];
    const updated = {
      id: "plan-revision",
      eventId: "event-test",
      name: "Revision",
      status: "draft",
      blindReview: false,
      closesAt: null,
      assignmentRule: { reviewsPerSubmission: 2, maxAssignmentsPerReviewer: 6 },
      reviewerProjection: { fieldIds: [], fileIds: [] },
      rounds,
      version: 2,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: updated }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const actions = useOrganizerPlanActions({
      ...unresolvedPlanScope(vi.fn()),
      seed: { planId: "plan-revision" },
      version: 1,
      rounds,
      unresolvedTemporalFields: new Set(),
      setRounds,
      onAuthoritativePlan,
    } as unknown as OrganizerRoundActions);

    await actions.saveDraft();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/evaluations/plans/plan-revision");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      expectedVersion: 1,
      rounds: [
        { rubric: { criteria: [{ label: "First Score", minimum: 1, maximum: 5 }] } },
        { rubric: { criteria: [{ label: "Final Score", minimum: 1, maximum: 10 }] } },
      ],
    });
    expect(setRounds).toHaveBeenCalledWith(rounds);
    expect(onAuthoritativePlan).toHaveBeenCalledWith(updated);
    fetchMock.mockRestore();
  });
});
