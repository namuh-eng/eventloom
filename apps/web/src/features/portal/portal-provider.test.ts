import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type PortalApi, PortalApiError } from "./api";
import {
  assetMatchesPendingRetry,
  isOptionalGuideReadFailure,
  isOptionalWorkspaceSubreadFailure,
  shouldIsolateWorkspaceReadFailure,
  workspaceReplacementTuple,
} from "./portal-provider";
import {
  assetBelongsToPortalContext,
  assetFamilyCommentResponseAuthorized,
  createPortalProviderApi,
  loadPortalRosters,
  participantSafeGuideFailure,
  portalContextLabel,
  portalContextResponseForTarget,
  portalViewAfterLoadFailure,
  portalViewMatchesSelection,
  profileAssetBelongsToPortalContext,
} from "./portal-provider-model";
import type {
  PortalAsset,
  PortalContext,
  PortalRosterEnvelope,
  PortalTask,
  PortalView,
} from "./types";

const target: PortalContext = {
  id: "portal:organization-1:event-1",
  eventId: "event-1",
  name: "DevFlow Conf 2027",
  capabilities: ["roster-manage"],
  submissionIds: ["speaker-submission:submission-1"],
  participantIds: ["participant-1"],
  primaryParticipantId: "participant-1",
};

it("retains the previous portal view only for a failed same-context refresh", () => {
  const previousView = {
    submissions: [],
    profiles: [],
    tasks: [],
    outstandingTaskCount: 0,
    context: { ...target, selectedParticipantId: "participant-1" },
  } satisfies PortalView;

  expect(portalViewMatchesSelection(previousView, target, "participant-1")).toBe(true);
  expect(
    portalViewMatchesSelection(
      previousView,
      { ...target, id: "portal:other:event-1" },
      "participant-1",
    ),
  ).toBe(false);
  expect(portalViewMatchesSelection(previousView, target, "participant-2")).toBe(false);
  expect(portalViewAfterLoadFailure(previousView, true)).toBe(previousView);
  expect(portalViewAfterLoadFailure(previousView, false)).toBeNull();
});

it("uses the event name from the authorized context", () => {
  const context = {
    ...target,
    eventId: "demo-event",
    name: "Authorized event name",
  };

  expect(portalContextLabel(context)).toBe(context.name);
});

function roster(submissionId: string, eventId = "event-1"): PortalRosterEnvelope {
  return {
    organizationId: "organization-1",
    eventId,
    submissionId,
    capabilities: { manage: true, invite: true },
    members: [],
  };
}

function view(
  submissions: PortalView["submissions"],
  rosterValue?: PortalRosterEnvelope,
): PortalView {
  return {
    submissions,
    profiles: [],
    tasks: [],
    outstandingTaskCount: 0,
    ...(rosterValue === undefined ? {} : { roster: rosterValue }),
  };
}

describe("speaker portal provider", () => {
  it("maps guide failures to fixed participant-safe copy", () => {
    const sensitiveMessage =
      "Storage bucket speaker-private-prod denied access with credential token secret-value.";
    const failure = participantSafeGuideFailure(
      new PortalApiError("NOT_FOUND", sensitiveMessage, 404, "trace_support-123"),
      "resources",
    );

    expect(failure).toEqual({
      message: "Published event resources are not available for this event.",
      supportId: "trace_support-123",
    });
    expect(JSON.stringify(failure)).not.toContain(sensitiveMessage);
    expect(JSON.stringify(failure)).not.toContain("secret-value");
  });

  it("constructs the production API against the same-origin speaker gateway", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: view([]),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    try {
      const api = createPortalProviderApi(undefined, "");
      await api.getPortal("event-1");
      expect(fetcher).toHaveBeenCalledWith(
        "/api/speaker/events/event-1/portal",
        expect.objectContaining({ credentials: "include" }),
      );
    } finally {
      fetcher.mockRestore();
    }
  });

  it("uses a fresh same-identity server context without stale authorization narrowing", () => {
    const freshContext: PortalContext = {
      ...target,
      capabilities: [...target.capabilities, "asset-read"],
      submissionIds: [...target.submissionIds, "speaker-submission:submission-2"],
    };

    expect(portalContextResponseForTarget(target, freshContext)).toBe(freshContext);
    expect(portalContextResponseForTarget(target, freshContext)).toMatchObject({
      capabilities: ["roster-manage", "asset-read"],
      submissionIds: ["speaker-submission:submission-1", "speaker-submission:submission-2"],
    });
    expect(() =>
      portalContextResponseForTarget(target, {
        ...freshContext,
        primaryParticipantId: "participant-2",
      }),
    ).toThrow(PortalApiError);
    expect(() => portalContextResponseForTarget(target, undefined)).toThrow(PortalApiError);
  });

  it("rejects an asset whose task and session belong to different authorized sessions", () => {
    const crossSessionTarget: PortalContext = {
      ...target,
      capabilities: ["roster-manage", "task-response"],
      submissionIds: ["speaker-submission:submission-1", "speaker-submission:submission-2"],
    };
    const task: PortalTask = {
      id: "task-1",
      eventId: "event-1",
      subject: { type: "session", sessionId: "session-1" },
      participantId: "participant-1",
      type: "upload",
      acceptedAssetKinds: ["slides"],
      owner: "speaker",
      title: "Upload slides",
      status: "not_started",
      dependencyIds: [],
      reminderOffsetsMinutes: [],
      version: 1,
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    const asset: PortalAsset = {
      id: "asset-1",
      eventId: "event-1",
      sessionId: "session-2",
      participantId: "participant-1",
      taskId: task.id,
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      state: "ready",
      createdAt: "2026-08-09T00:00:00.000Z",
    };
    const profileAsset: PortalAsset = {
      ...asset,
      kind: "headshot",
    };
    delete profileAsset.taskId;
    delete profileAsset.sessionId;

    expect(assetBelongsToPortalContext(asset, crossSessionTarget, [task])).toBe(false);
    expect(
      assetBelongsToPortalContext({ ...asset, sessionId: "session-1" }, crossSessionTarget, [task]),
    ).toBe(true);
    expect(profileAssetBelongsToPortalContext(profileAsset, target)).toBe(true);
    expect(profileAssetBelongsToPortalContext({ ...profileAsset, taskId: task.id }, target)).toBe(
      false,
    );
  });
  it("accepts self-consistent sibling comments from an authorized family endpoint", () => {
    const task: PortalTask = {
      id: "task-family",
      eventId: "event-1",
      subject: { type: "session", sessionId: "session-1" },
      participantId: "participant-1",
      type: "upload",
      acceptedAssetKinds: ["slides"],
      owner: "speaker",
      title: "Upload slides",
      status: "submitted",
      dependencyIds: [],
      reminderOffsetsMinutes: [],
      version: 2,
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    const first: PortalAsset = {
      id: "asset-v1",
      eventId: "event-1",
      sessionId: "session-1",
      participantId: "participant-1",
      taskId: task.id,
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      state: "ready",
      versionFamilyId: "family-1",
      createdAt: "2026-08-09T00:00:00.000Z",
    };
    const second: PortalAsset = {
      ...first,
      id: "asset-v2",
      supersedesAssetId: first.id,
    };
    const scopedView = view([]);
    scopedView.tasks = [task];
    const familyTarget: PortalContext = {
      ...target,
      capabilities: [...target.capabilities, "task-response"],
    };

    expect(
      assetFamilyCommentResponseAuthorized(
        second.id,
        first.id,
        first.id,
        familyTarget,
        scopedView,
        [first, second],
      ),
    ).toBe(true);
    expect(
      assetFamilyCommentResponseAuthorized(
        second.id,
        first.id,
        second.id,
        familyTarget,
        scopedView,
        [first, second],
      ),
    ).toBe(false);
    expect(
      assetFamilyCommentResponseAuthorized(
        "unauthorized-asset",
        first.id,
        first.id,
        familyTarget,
        scopedView,
        [first, second],
      ),
    ).toBe(false);
  });

  it("loads only accepted rosters for the active authorized session", async () => {
    const getRoster = vi.fn(async (_eventId: string, submissionId: string) =>
      roster(`speaker-submission:${submissionId}`),
    );
    const api = { getRoster } as unknown as PortalApi;
    const result = await loadPortalRosters(
      api,
      target,
      view([
        {
          id: "submission-1",
          eventId: "event-1",
          title: "Authorized session",
          status: "accepted",
          participantIds: ["participant-1"],
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        {
          id: "submission-2",
          eventId: "event-1",
          title: "Not accepted",
          status: "under_review",
          participantIds: ["participant-1"],
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        {
          id: "submission-other-speaker",
          eventId: "event-1",
          title: "Other speaker",
          status: "accepted",
          participantIds: ["participant-2"],
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        {
          id: "submission-other-event",
          eventId: "event-2",
          title: "Other event",
          status: "accepted",
          participantIds: ["participant-1"],
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
      ]),
    );

    expect(getRoster).toHaveBeenCalledOnce();
    expect(getRoster).toHaveBeenCalledWith("event-1", "submission-1", undefined);
    expect(result.entries).toEqual([["submission-1", roster("speaker-submission:submission-1")]]);
    expect(result.failures).toEqual([]);
  });

  it("rejects stale included and cross-identity roster responses", async () => {
    const stale = await loadPortalRosters(
      { getRoster: vi.fn() } as unknown as PortalApi,
      { ...target, capabilities: [] },
      view(
        [
          {
            id: "submission-1",
            eventId: "event-1",
            title: "Authorized session",
            status: "accepted",
            participantIds: ["participant-1"],
            updatedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
        roster("submission-other"),
      ),
    );
    expect(stale.entries).toEqual([]);
    expect(stale.failures[0]).toBeInstanceOf(PortalApiError);

    const crossIdentity = await loadPortalRosters(
      {
        getRoster: vi.fn(async () => roster("submission-other", "event-2")),
      } as unknown as PortalApi,
      target,
      view([
        {
          id: "submission-1",
          eventId: "event-1",
          title: "Authorized session",
          status: "accepted",
          participantIds: ["participant-1"],
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
      ]),
    );
    expect(crossIdentity.entries).toEqual([]);
    expect(crossIdentity.failures[0]).toBeInstanceOf(PortalApiError);
  });
  it("keeps an anti-enumeration authority 404 fatal while guide 404 is isolated", () => {
    const missing = new PortalApiError("NOT_FOUND", "missing", 404);

    expect(shouldIsolateWorkspaceReadFailure("authority", missing)).toBe(false);
    expect(shouldIsolateWorkspaceReadFailure("guide", missing)).toBe(true);
    expect(isOptionalWorkspaceSubreadFailure(missing)).toBe(true);
    expect(shouldIsolateWorkspaceReadFailure("optional", missing)).toBe(true);
    expect(
      isOptionalWorkspaceSubreadFailure(new PortalApiError("UNAUTHORIZED", "denied", 401)),
    ).toBe(false);
    expect(
      isOptionalWorkspaceSubreadFailure(new PortalApiError("CONTEXT_MISMATCH", "wrong scope", 404)),
    ).toBe(false);
    expect(isOptionalGuideReadFailure(new PortalApiError("UNAUTHORIZED", "denied", 401))).toBe(
      false,
    );
    expect(isOptionalGuideReadFailure(new PortalApiError("FORBIDDEN", "denied", 403))).toBe(false);
    expect(
      isOptionalGuideReadFailure(new PortalApiError("CONTEXT_MISMATCH", "wrong scope", 404)),
    ).toBe(false);
  });

  it("uses the finalized authoritative latest task-bound family head for replacement CAS", () => {
    const v1: PortalAsset = {
      id: "asset-v1",
      eventId: "event-1",
      sessionId: "session-1",
      participantId: "participant-1",
      taskId: "task-1",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      state: "ready",
      createdAt: "2026-08-09T00:00:00.000Z",
      version: 1,
      versionId: "asset-v1",
      versionFamilyId: "family-1",
      latestVersionId: "asset-v2",
      currentVersionId: "asset-v1",
    };
    const v2: PortalAsset = {
      ...v1,
      id: "asset-v2",
      state: "rejected",
      version: 2,
      versionId: "asset-v2",
      supersedesAssetId: v1.id,
      latestVersionId: "asset-v2",
      currentVersionId: "asset-v1",
    };

    expect(workspaceReplacementTuple([v1, v2], v1.id)).toBeNull();
    expect(workspaceReplacementTuple([v1, v2], v2.id)).toMatchObject({
      predecessor: v2,
      sessionId: "session-1",
      taskId: "task-1",
      versionFamilyId: "family-1",
      expectedLatestVersion: 2,
      successorVersion: 3,
    });
  });
  it("preserves one pending task asset identity through retry and finalization", () => {
    const pending: PortalAsset = {
      id: "asset-pending",
      eventId: "event-1",
      participantId: "participant-1",
      sessionId: "session-1",
      taskId: "task-1",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 608,
      state: "pending_upload",
      createdAt: "2026-08-09T00:00:00.000Z",
      version: 1,
      versionId: "asset-pending",
      versionFamilyId: "asset-pending",
      latestVersionId: "asset-pending",
    };
    const input = {
      eventId: "event-1",
      participantId: "participant-1",
      sessionId: "session-1",
      taskId: "task-1",
      kind: "slides" as const,
    };

    expect(assetMatchesPendingRetry(pending, pending, { ...input, state: "pending_upload" })).toBe(
      true,
    );
    expect(
      assetMatchesPendingRetry(
        { ...pending, state: "ready", currentVersionId: pending.id },
        pending,
        { ...input, state: "ready" },
      ),
    ).toBe(true);
    expect(
      assetMatchesPendingRetry({ ...pending, id: "parallel-asset" }, pending, {
        ...input,
        state: "pending_upload",
      }),
    ).toBe(false);
  });
  it("fails closed when the authoritative predecessor lacks immutable version identity", () => {
    const asset: PortalAsset = {
      id: "asset-v1",
      eventId: "event-1",
      participantId: "participant-1",
      kind: "headshot",
      fileName: "headshot.png",
      contentType: "image/png",
      sizeBytes: 10,
      state: "ready",
      createdAt: "2026-08-09T00:00:00.000Z",
      version: 1,
      versionFamilyId: "family-1",
      latestVersionId: "asset-v1",
      currentVersionId: "asset-v1",
    };

    expect(workspaceReplacementTuple([asset], asset.id)).toBeNull();
  });
  it("keeps participant switching scoped to state updates while the workspace view owns loading", () => {
    const providerSource = readFileSync(
      fileURLToPath(new URL("./portal-provider.tsx", import.meta.url)),
      "utf8",
    );
    const workspaceSource = readFileSync(
      fileURLToPath(new URL("./portal-workspace.tsx", import.meta.url)),
      "utf8",
    );
    const switchStart = providerSource.indexOf("const switchParticipant = useCallback(");
    const workspaceLoadStart = providerSource.indexOf(
      "const loadWorkspace = useCallback(",
      switchStart,
    );

    expect(switchStart).toBeGreaterThanOrEqual(0);
    expect(workspaceLoadStart).toBeGreaterThan(switchStart);
    expect(providerSource.slice(switchStart, workspaceLoadStart)).not.toContain(
      "loadWorkspaceFor(",
    );
    expect(providerSource.slice(switchStart, workspaceLoadStart)).toContain("workspaceDispatch({");
    expect(providerSource.slice(switchStart, workspaceLoadStart)).toContain(
      "loadGeneration.current += 1;",
    );
    expect(workspaceSource).toContain("if (context && view) void portal.loadWorkspace();");
    expect(workspaceSource.split("if (context && view) void portal.loadWorkspace();")).toHaveLength(
      2,
    );
  });
  it("keeps comment loading to one request per selected asset and disables posting while loading", () => {
    const providerSource = readFileSync(
      fileURLToPath(new URL("./portal-provider.tsx", import.meta.url)),
      "utf8",
    );
    const assetViewSource = readFileSync(
      fileURLToPath(new URL("./portal-task-asset-view.tsx", import.meta.url)),
      "utf8",
    );

    expect(providerSource).toContain("const clearWorkspaceError = useCallback(");
    expect(providerSource).toContain("const clearMutationError = useCallback(");
    expect(assetViewSource.split("void loadAssetComments(selectedAssetId)")).toHaveLength(2);
    expect(assetViewSource).toContain(
      "}, [selectedAssetId, clearWorkspaceError, loadAssetComments]);",
    );
    expect(assetViewSource).toContain(
      "disabled={commentsLoading || commentPending || !comment.trim()}",
    );
  });
});
