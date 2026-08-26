import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createPortalApi, type PortalApi, validatePortalSocialUrl } from "./api";
import { groupPortalAssetVersions } from "./portal-assets";
import { PortalProvider } from "./portal-provider";
import { isPortalGenerationCurrent, loadPortalStartup } from "./portal-provider-model";
import { portalContentMode, portalRouteAuthorized, signOutAndRedirect } from "./portal-shell-model";
import {
  NoParticipantWorkspaceState,
  PageHeading,
  PortalFrame,
  PortalStaleDataNotice,
  PortalUnavailableState,
  Progress,
  SubmissionStatusBadge,
  TaskStatusBadge,
} from "./portal-ui";
import {
  formatPortalFileSize,
  portalAssetStateLabel,
  portalContentAvailability,
  portalNavigation,
  portalNavigationItemActive,
} from "./portal-ui-model";
import { AssetDetails } from "./portal-workspace";
import { SubmissionAnswers, SubmissionParticipants } from "./submission-detail";
import type { PortalAsset, PortalContext, PortalProfile, PortalView } from "./types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal",
  useSearchParams: () => new URLSearchParams(),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function portalStartupContext(eventId: string): PortalContext {
  return {
    id: `portal:${eventId}`,
    eventId,
    name: eventId,
    capabilities: [],
    submissionIds: [],
    participantIds: ["participant-1"],
    primaryParticipantId: "participant-1",
  };
}

function portalStartupView(context: PortalContext): PortalView {
  return {
    submissions: [],
    sessions: [],
    profiles: [],
    tasks: [],
    outstandingTaskCount: 0,
    context,
  };
}

describe("speaker portal UI components", () => {
  it("renders submitted proposal answers as read-only content", () => {
    const markup = renderToStaticMarkup(
      <SubmissionAnswers
        answers={{
          title: "Reliable CFP operations",
          abstract: "How to preserve submitted content after closure.",
          audienceLevel: "Advanced",
          tags: ["Operations", "Reliability"],
          recorded: false,
        }}
      />,
    );
    expect(markup).toContain("Proposal content");
    expect(markup).toContain("Reliable CFP operations");
    expect(markup).toContain("How to preserve submitted content after closure.");
    expect(markup).toContain("Advanced");
    expect(markup).toContain("Operations, Reliability");
    expect(markup).toContain("No");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
  });
  it("renders proposal participants with primary and co-author roles", () => {
    const markup = renderToStaticMarkup(
      <SubmissionParticipants
        participants={[
          {
            id: "primary-speaker",
            firstName: "Priya",
            lastName: "Raman",
            email: "priya@example.test",
            role: "primary",
          },
          {
            id: "co-author",
            firstName: "Marcus",
            lastName: "Okafor",
            email: "marcus@example.test",
            role: "co_author",
          },
        ]}
      />,
    );
    expect(markup).toContain("Participants");
    expect(markup).toContain("Priya Raman");
    expect(markup).toContain("Primary speaker");
    expect(markup).toContain("Marcus Okafor");
    expect(markup).toContain("Co-author");
  });
  it("separates submitter submission access from accepted-speaker capabilities", () => {
    const noCapabilities = () => false;
    expect(
      portalRouteAuthorized({
        pathname: "/portal/submissions",
        workspace: null,
        submissionCount: 1,
        can: noCapabilities,
      }),
    ).toBe(true);
    expect(
      portalRouteAuthorized({
        pathname: "/portal/submissions/submission-1",
        workspace: null,
        submissionCount: 1,
        can: noCapabilities,
      }),
    ).toBe(true);
    for (const [pathname, workspace] of [
      ["/portal/tasks", null],
      ["/portal/profile", null],
      ["/portal", "files"],
    ] as const) {
      expect(
        portalRouteAuthorized({
          pathname,
          workspace,
          submissionCount: 1,
          can: noCapabilities,
        }),
      ).toBe(false);
    }
    const acceptedCapabilities = new Set(["task-response", "profile-self", "asset-read"]);
    for (const [pathname, workspace] of [
      ["/portal/tasks", null],
      ["/portal/profile", null],
      ["/portal", "files"],
    ] as const) {
      expect(
        portalRouteAuthorized({
          pathname,
          workspace,
          submissionCount: 1,
          can: (capability) => acceptedCapabilities.has(capability),
        }),
      ).toBe(true);
    }
  });

  it("renders no-access rather than redirecting authenticated users without matching context grants", () => {
    expect(
      portalRouteAuthorized({
        pathname: "/portal/tasks",
        workspace: null,
        submissionCount: 0,
        can: () => false,
      }),
    ).toBe(false);
  });

  it("allows an authenticated account to reach an empty submissions workspace", () => {
    expect(
      portalRouteAuthorized({
        pathname: "/portal/submissions",
        workspace: null,
        submissionCount: 0,
        can: () => false,
      }),
    ).toBe(true);
  });

  it("keeps load failures in the retry UI and reserves no-access for successful denial", () => {
    expect(
      portalContentMode({
        loading: false,
        error: "The portal could not be loaded.",
        hasView: false,
        routeAuthorized: false,
      }),
    ).toBe("children");
    expect(
      portalContentMode({
        loading: false,
        error: null,
        hasView: true,
        routeAuthorized: false,
      }),
    ).toBe("no-access");
    expect(
      portalContentMode({
        loading: false,
        error: null,
        hasView: true,
        routeAuthorized: true,
      }),
    ).toBe("children");
  });

  it("round-trips the complete profile DTO and validates social profile URLs", async () => {
    const requests: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const updatedProfile: PortalProfile & {
      jobTitle: string;
      company: string;
      socialLinks: { twitter: string; linkedin: string };
    } = {
      id: "profile-1",
      eventId: "event-1",
      participantId: "participant-1",
      displayName: "Priya Raman",
      biography: "Updated biography",
      jobTitle: "Principal Engineer",
      company: "Latticework Systems",
      socialLinks: {
        twitter: "https://x.com/priya",
        linkedin: "https://www.linkedin.com/in/priya",
      },
      version: 2,
      updatedAt: "2026-08-09T01:00:00.000Z",
    };
    const api = createPortalApi("https://api.example.com", async (input, init) => {
      requests.push({ input, init });
      return jsonResponse({ data: updatedProfile });
    });

    await expect(
      api.updateProfile?.({
        eventId: "event one",
        participantId: "participant/one",
        biography: updatedProfile.biography,
        jobTitle: updatedProfile.jobTitle,
        company: updatedProfile.company,
        socialLinks: updatedProfile.socialLinks,
        headshotAssetId: "asset-headshot-v2",
        expectedVersion: 1,
      }),
    ).resolves.toEqual(updatedProfile);

    expect(String(requests[0]?.input)).toBe(
      "https://api.example.com/api/speaker/events/event%20one/profiles/participant%2Fone",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      biography: updatedProfile.biography,
      jobTitle: updatedProfile.jobTitle,
      company: updatedProfile.company,
      socialLinks: updatedProfile.socialLinks,
      headshotAssetId: "asset-headshot-v2",
      expectedVersion: 1,
    });
    expect(validatePortalSocialUrl("https://x.com/priya", "twitter")).toBeNull();
    expect(validatePortalSocialUrl("@priya", "twitter")).toBeNull();
    expect(validatePortalSocialUrl("https://www.linkedin.com/in/priya", "linkedin")).toBeNull();
    expect(validatePortalSocialUrl("javascript:alert(1)", "twitter")).toContain("HTTP or HTTPS");
    expect(validatePortalSocialUrl("https://example.com/priya", "linkedin")).toContain(
      "matching profile network",
    );
  });

  it("uses the private headshot grant, preserves superseding lineage, and issues fresh old-version downloads", async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const first: PortalAsset = {
      id: "asset-headshot-v1",
      eventId: "event-1",
      participantId: "participant-1",
      kind: "headshot",
      fileName: "headshot.png",
      contentType: "image/png",
      sizeBytes: 100,
      state: "ready",
      createdAt: "2026-08-09T00:00:00.000Z",
      version: 1,
      versionFamilyId: "family-headshot",
    };
    const second: PortalAsset = {
      ...first,
      id: "asset-headshot-v2",
      state: "pending_upload",
      createdAt: "2026-08-09T01:00:00.000Z",
      version: 2,
      supersedesAssetId: first.id,
    };
    const api = createPortalApi("https://api.example.com", async (input, init) => {
      calls.push({ input, init });
      if (calls.length === 1) {
        return jsonResponse({
          data: {
            asset: second,
            grant: {
              method: "PUT",
              url: "https://uploads.example.com/private/headshot-v2",
              headers: { "content-type": "image/png" },
              expiresAt: "2026-08-09T01:05:00.000Z",
            },
          },
        });
      }
      if (calls.length === 2) return new Response(null, { status: 204 });
      if (calls.length === 3) return jsonResponse({ data: { ...second, state: "ready" } });
      return jsonResponse({
        data: {
          method: "GET",
          url: `https://downloads.example.com/${calls.length}`,
          expiresAt: "2026-08-09T01:15:00.000Z",
        },
      });
    });
    const file = new File(["headshot-v2"], "headshot.png", { type: "image/png" });

    await expect(
      api.uploadFile?.({
        eventId: "event-1",
        participantId: "participant-1",
        kind: "headshot",
        file,
        supersedesAssetId: first.id,
      }),
    ).resolves.toEqual(second);
    const uploadBody = JSON.parse(String(calls[0]?.init?.body));
    expect(uploadBody).toMatchObject({
      participantId: "participant-1",
      kind: "headshot",
      supersedesAssetId: first.id,
    });
    expect(uploadBody).not.toHaveProperty("objectKey");

    const finalized = await api.finalizeAsset?.({
      eventId: "event-1",
      assetId: second.id,
      state: "ready",
    });
    expect(finalized).toMatchObject({
      id: second.id,
      state: "ready",
      supersedesAssetId: first.id,
    });

    const families = groupPortalAssetVersions([first, second]);
    expect(families).toHaveLength(1);
    expect(families[0]?.versions.map((asset) => asset.id)).toEqual([first.id, second.id]);
    expect(families[0]?.current.id).toBe(second.id);

    const firstGrant = await api.getDownloadGrant?.("event-1", first.id);
    const secondGrant = await api.getDownloadGrant?.("event-1", first.id);
    expect(firstGrant?.url).not.toBe(secondGrant?.url);
    expect(calls.slice(3).map(({ input }) => String(input))).toEqual([
      "https://api.example.com/api/speaker/events/event-1/assets/asset-headshot-v1/download",
      "https://api.example.com/api/speaker/events/event-1/assets/asset-headshot-v1/download",
    ]);
  });

  it("renders a clear page heading hierarchy", () => {
    const markup = renderToStaticMarkup(
      createElement(PageHeading, {
        eyebrow: "Speaker portal",
        title: "Tasks",
        description: "Complete your accepted-speaker tasks.",
      }),
    );

    expect(markup).toContain("<h1>Tasks</h1>");
    expect(markup).toContain("Speaker portal");
    expect(markup).toContain("Complete your accepted-speaker tasks.");
  });

  it("exposes status labels as text rather than color alone", () => {
    const submission = renderToStaticMarkup(
      createElement(SubmissionStatusBadge, { status: "accepted" }),
    );
    const task = renderToStaticMarkup(createElement(TaskStatusBadge, { status: "needs_changes" }));

    expect(submission).toContain("Accepted");
    expect(task).toContain("Needs changes");
  });

  it("renders in-progress and ready values with native progress semantics", () => {
    const inProgress = renderToStaticMarkup(
      createElement(Progress, { value: 60, label: "Speaker readiness" }),
    );
    const ready = renderToStaticMarkup(
      createElement(Progress, { value: 100, label: "Speaker readiness" }),
    );

    expect(inProgress).toContain('role="progressbar"');
    expect(inProgress).toContain('aria-valuenow="60"');
    expect(inProgress).toContain('aria-label="Speaker readiness"');
    expect(ready).toContain('aria-valuenow="100"');
    expect(ready).toContain("100%");
  });

  it("renders zero tasks as neutral copy without a percentage or progressbar", () => {
    const markup = renderToStaticMarkup(
      createElement(Progress, { value: null, label: "Speaker readiness" }),
    );

    expect(markup).toContain("No tasks assigned");
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain("%");
    expect(markup).not.toContain("Ready");
  });

  it("distinguishes retryable unavailability from labeled stale data", () => {
    expect(
      portalContentAvailability({ loading: false, error: "Network unavailable", hasView: false }),
    ).toBe("unavailable");
    expect(
      portalContentAvailability({ loading: false, error: "Network unavailable", hasView: true }),
    ).toBe("stale");

    const unavailable = renderToStaticMarkup(
      createElement(PortalUnavailableState, {
        error: "Network unavailable",
        onRetry: vi.fn(),
      }),
    );
    expect(unavailable).toContain('role="alert"');
    expect(unavailable).toContain("We could not load your portal");
    expect(unavailable).toContain("Try again");

    const stale = renderToStaticMarkup(
      createElement(PortalStaleDataNotice, {
        error: "Refresh failed",
        onRetry: vi.fn(),
      }),
    );
    expect(stale).toContain('role="alert"');
    expect(stale).toContain("Showing stale portal data");
    expect(stale).toContain("Refresh failed");
    expect(stale).toContain("Try again");
  });

  it("keeps primary portal pages and restored operational workspaces visible", () => {
    expect(portalNavigation.map(({ label }) => label)).toEqual([
      "My events",
      "Submissions",
      "Tasks",
      "Profile",
      "Sessions",
      "Files",
      "Event guide",
    ]);
    expect(portalNavigation.map(({ href }) => href)).toEqual([
      "/portal",
      "/portal/submissions",
      "/portal/tasks",
      "/portal/profile",
      "/portal?workspace=co-speakers",
      "/portal?workspace=files",
      "/portal?workspace=resources",
    ]);
  });

  it("marks the participant navigation item matching the route and workspace", () => {
    expect(portalNavigationItemActive("/portal", "/portal", null)).toBe(true);
    expect(portalNavigationItemActive("/portal", "/portal", "files")).toBe(false);
    expect(portalNavigationItemActive("/portal/submissions", "/portal/submissions/one", null)).toBe(
      true,
    );
    expect(portalNavigationItemActive("/portal?workspace=files", "/portal", "files")).toBe(true);
    expect(portalNavigationItemActive("/portal?workspace=wiki", "/portal", "resources")).toBe(
      false,
    );
  });

  it("formats truthful private-asset metadata and states", () => {
    expect(formatPortalFileSize(1_536)).toBe("1.5 KiB");
    expect(formatPortalFileSize(-1)).toBe("Unknown size");
    expect(portalAssetStateLabel("pending_upload")).toBe("Processing upload");
    expect(portalAssetStateLabel("ready")).toBe("Uploaded");
    expect(portalAssetStateLabel("rejected")).toBe("Upload failed");
  });
  it("offers secure retry and completion actions for pending speaker uploads", () => {
    const pendingAsset: PortalAsset = {
      id: "asset-pending",
      eventId: "event-1",
      participantId: "participant-1",
      kind: "slides",
      fileName: "slides.pdf",
      contentType: "application/pdf",
      sizeBytes: 1_536,
      state: "pending_upload",
      createdAt: "2026-08-09T00:00:00.000Z",
      version: 1,
    };
    const markup = renderToStaticMarkup(
      createElement(AssetDetails, {
        asset: pendingAsset,
        versions: [pendingAsset],
        comments: [],
        canComment: false,
        canCompleteUpload: true,
        busy: false,
        onRetryUpload: vi.fn(),
        onCompleteUpload: vi.fn(),
        onDownload: vi.fn(),
        commentDraft: "",
        onCommentDraftChange: vi.fn(),
        onComment: vi.fn(),
      }),
    );

    expect(markup).toContain(">Mark upload complete</button>");
    expect(markup).toContain("Retry file upload");
    expect(markup).toContain('type="file"');
    expect(markup).toContain("event-team approval happens separately");
    expect(markup).not.toContain("Reject file");
    expect(markup).not.toMatch(/<button[^>]*>[^<]*(?:approve|review|reject)/iu);
  });
  it("renders the honest empty participant workspace state", () => {
    const markup = renderToStaticMarkup(createElement(NoParticipantWorkspaceState));

    expect(markup).toContain("<h1>Your speaker workspace is not open yet</h1>");
    expect(markup).toContain('href="/portal/submissions"');
    expect(markup).toContain("Track your proposal in My submissions");
    expect(markup).not.toContain("files");
  });

  it("does not render event navigation before an authorized context exists", () => {
    const api = {
      getPortal: async () => {
        throw new Error("The server render must not load an event without a context.");
      },
    } as unknown as PortalApi;
    const markup = renderToStaticMarkup(
      <PortalProvider api={api}>
        <PortalFrame>
          <p>Portal content</p>
        </PortalFrame>
      </PortalProvider>,
    );

    expect(markup).toContain('data-role-workspace-shell="true"');
    expect(markup).toContain('data-role-workspace="participant"');
    expect(markup).toContain('id="workspace-main"');
    expect(markup).not.toContain('aria-label="Speaker portal"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).not.toContain(">Sign out</button>");
  });

  it("applies one shared content inset across participant pages", () => {
    const shellSource = readFileSync(
      fileURLToPath(new URL("./portal-shell.tsx", import.meta.url)),
      "utf8",
    );
    const shellStyles = readFileSync(
      fileURLToPath(new URL("./portal-shell.module.css", import.meta.url)),
      "utf8",
    );
    const pageHeadingStyles = readFileSync(
      fileURLToPath(new URL("./portal.module.css", import.meta.url)),
      "utf8",
    );
    const workspaceHeaderStyles = readFileSync(
      fileURLToPath(new URL("../../components/workspace/workspace-ui.module.css", import.meta.url)),
      "utf8",
    );

    expect(shellSource).toContain("contentBodyClassName={styles.workspaceContent");
    expect(shellSource).toContain('data-scroll-region="sidebar-navigation"');
    expect(shellSource).toContain('variant="embedded"');
    expect(shellStyles).toMatch(
      /\.workspaceContent\s*\{[\s\S]*--workspace-heading-padding-inline:\s*0px;[\s\S]*padding:\s*var\(--space-4\);/u,
    );
    expect(shellStyles).toMatch(
      /\.navGroups\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;/u,
    );
    expect(pageHeadingStyles).toContain("var(--workspace-heading-padding-inline, 1rem)");
    expect(workspaceHeaderStyles).toContain("var(--workspace-heading-padding-inline, 1.5rem)");
  });

  it("posts sign-out with session credentials before navigating to login", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const navigate = vi.fn();

    await expect(signOutAndRedirect({ fetcher, navigate })).resolves.toBe(true);

    expect(fetcher).toHaveBeenCalledWith("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("does not leave the portal or report completion when session revocation fails", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    const navigate = vi.fn();

    await expect(signOutAndRedirect({ fetcher, navigate })).resolves.toBe(false);

    expect(navigate).not.toHaveBeenCalled();
  });
  it("discards deferred portal completions after the active context generation changes", async () => {
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const startedGeneration = 4;
    let activeGeneration = startedGeneration;
    const staleCompletion = completion.then(() =>
      isPortalGenerationCurrent(startedGeneration, activeGeneration),
    );

    activeGeneration += 1;
    resolveCompletion();

    await expect(staleCompletion).resolves.toBe(false);
    expect(isPortalGenerationCurrent(activeGeneration, activeGeneration)).toBe(true);
  });
  it("validates the configured event against server contexts before prefetching", async () => {
    let resolveContexts!: (contexts: PortalContext[]) => void;
    const contexts = new Promise<PortalContext[]>((resolve) => {
      resolveContexts = resolve;
    });
    const matchingContext = portalStartupContext("event-1");
    const requests: string[] = [];
    const api = {
      listPortalContexts: () => {
        requests.push("contexts");
        return contexts;
      },
      getPortal: async (eventId: string) => {
        requests.push(`workspace:${eventId}`);
        return portalStartupView(matchingContext);
      },
    };

    const startup = loadPortalStartup(api, "event-1");
    expect(requests).toEqual(["contexts"]);

    resolveContexts([matchingContext]);
    const result = await startup;
    expect(requests).toEqual(["contexts", "workspace:event-1"]);
    expect(result.preferredContext?.eventId).toBe("event-1");
    expect(result.prefetchedView).toMatchObject({ status: "fulfilled" });
  });
  it("treats a configured context id as a selection hint without a duplicate workspace prefetch", async () => {
    const context = portalStartupContext("event-1");
    const requests: string[] = [];
    const api = {
      listPortalContexts: async () => {
        requests.push("contexts");
        return [context];
      },
      getPortal: async (eventId: string) => {
        requests.push(`workspace:${eventId}`);
        return portalStartupView(context);
      },
    };

    const result = await loadPortalStartup(api, context.id);
    expect(result.preferredContext?.id).toBe(context.id);
    expect(result.prefetchedView).toBeUndefined();
    expect(requests).toEqual(["contexts"]);

    await api.getPortal(result.preferredContext?.eventId ?? "");
    expect(requests).toEqual(["contexts", "workspace:event-1"]);
  });

  it("does not consume a workspace prefetch after abort", async () => {
    const context = portalStartupContext("event-1");
    const controller = new AbortController();
    let resolveContexts!: (contexts: PortalContext[]) => void;
    const requests: string[] = [];
    const api = {
      listPortalContexts: () => {
        requests.push("contexts");
        return new Promise<PortalContext[]>((resolve) => {
          resolveContexts = resolve;
        });
      },
      getPortal: async (eventId: string) => {
        requests.push(`workspace:${eventId}`);
        return portalStartupView(context);
      },
    };

    const startup = loadPortalStartup(api, context.eventId, controller.signal);
    expect(requests).toEqual(["contexts"]);
    controller.abort();
    resolveContexts([context]);

    const result = await startup;
    expect(result.prefetchedView).toBeUndefined();
    expect(requests).toEqual(["contexts"]);
  });

  it("ignores an unauthorized event hint and does not query that event", async () => {
    const authorizedContext = portalStartupContext("event-authorized");
    const unauthorizedEventId = "event-not-authorized";
    const requests: string[] = [];
    const api = {
      listPortalContexts: async () => [authorizedContext],
      getPortal: async (eventId: string) => {
        requests.push(eventId);
        return portalStartupView(authorizedContext);
      },
    };

    const result = await loadPortalStartup(api, unauthorizedEventId);
    expect(result.preferredContext?.eventId).toBe(authorizedContext.eventId);
    expect(result.prefetchedView).toMatchObject({ status: "fulfilled" });
    expect(requests).toEqual([authorizedContext.eventId]);
  });

  it("selects the matching authorized event among multiple contexts", async () => {
    const firstContext = portalStartupContext("event-first");
    const matchingContext = portalStartupContext("event-matching");
    const requests: string[] = [];
    const api = {
      listPortalContexts: async () => [firstContext, matchingContext],
      getPortal: async (eventId: string) => {
        requests.push(eventId);
        return portalStartupView(
          eventId === matchingContext.eventId ? matchingContext : firstContext,
        );
      },
    };

    const result = await loadPortalStartup(api, matchingContext.eventId);
    expect(result.preferredContext?.eventId).toBe(matchingContext.eventId);
    expect(result.prefetchedView).toMatchObject({ status: "fulfilled" });
    expect(requests).toEqual([matchingContext.eventId]);
  });

  it("completes delayed production-equivalent startup under one second", async () => {
    const context = portalStartupContext("event-1");
    const startedAt = Date.now();
    const result = await loadPortalStartup(
      {
        listPortalContexts: () =>
          new Promise<PortalContext[]>((resolve) => {
            setTimeout(() => resolve([context]), 450);
          }),
        getPortal: () =>
          new Promise<PortalView>((resolve) => {
            setTimeout(() => resolve(portalStartupView(context)), 450);
          }),
      },
      context.eventId,
    );

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.prefetchedView).toMatchObject({ status: "fulfilled" });
  });
});
