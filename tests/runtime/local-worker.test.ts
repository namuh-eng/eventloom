import { describe, expect, it } from "vitest";
import worker from "../../apps/api/src/index";
import { apiErrorSchema, healthResponseSchema } from "../../packages/contracts/src";

type RuntimeBindings = {
  APP_ENV: "local" | "staging" | "production";
  RUNTIME_PROFILE?: "integrated" | "fixture";
  WEB_ORIGIN: string;
  DB: unknown;
  AGENDA_COORDINATOR: unknown;
  PRIVATE_FILES: unknown;
  OUTBOX_QUEUE: unknown;
};

type RuntimeWorker = {
  fetch(
    request: Request,
    bindings: RuntimeBindings,
    executionContext: unknown,
  ): Response | Promise<Response>;
};

const traceId = "a326508b-2ef9-4a90-b57f-24af14b6092f";
const organizationId = "local-organization";
const eventId = "demo-event";
const formId = "main-cfp";
const webOrigin = "http://127.0.0.1:3015";
const organizerHeaders = {
  cookie: "better-auth.session_token=local-session",
  "x-request-id": traceId,
};
const reviewerHeaders = {
  cookie: "better-auth.session_token=local-reviewer-session",
  "x-request-id": traceId,
};
const speakerHeaders = {
  cookie: "better-auth.session_token=local-speaker-session",
  "x-request-id": traceId,
};

function createBindingFakes(): Omit<RuntimeBindings, "APP_ENV" | "WEB_ORIGIN"> {
  const statement = {
    bind() {
      return this;
    },
    first: async () => null,
    all: async () => ({ results: [], success: true, meta: {} }),
    raw: async () => [],
    run: async () => ({ results: [], success: true, meta: {} }),
  };

  return {
    DB: {
      prepare: () => statement,
      batch: async () => [],
    },
    AGENDA_COORDINATOR: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
    },
    PRIVATE_FILES: {
      get: async () => null,
      put: async () => ({ key: "unused" }),
    },
    OUTBOX_QUEUE: {
      send: async () => undefined,
    },
  };
}

const localBindings: RuntimeBindings = {
  APP_ENV: "local",
  RUNTIME_PROFILE: "fixture",
  WEB_ORIGIN: webOrigin,
  ...createBindingFakes(),
};
const productionBindings: RuntimeBindings = {
  APP_ENV: "production",
  WEB_ORIGIN: "https://app.example.test",
  ...createBindingFakes(),
};
const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
};
const runtimeWorker = worker as unknown as RuntimeWorker;

function runtimeRequest(
  path: string,
  init: RequestInit = {},
  bindings: RuntimeBindings = localBindings,
): Promise<Response> {
  const request = new Request(new URL(path, "https://worker.example.test"), init);
  return Promise.resolve(runtimeWorker.fetch(request, bindings, executionContext));
}

async function errorResponse(response: Response, status: number, code: string) {
  const body = apiErrorSchema.parse(await response.json());
  expect(response.status).toBe(status);
  expect(body.error.code).toBe(code);
  expect(response.headers.get("x-request-id")).toBe(body.error.traceId);
  return body;
}

async function jsonData<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data: T };
  return body.data;
}

function jsonRequest(method: string, body: unknown, headers: HeadersInit = {}): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

describe.sequential("composed local Worker", () => {
  it("serves health, CORS, and contract-normalized errors through the Worker entry point", async () => {
    const health = await runtimeRequest("/api/health", {
      headers: { "x-request-id": traceId, origin: webOrigin },
    });
    const healthBody = healthResponseSchema.parse(await health.json());

    expect(health.status).toBe(200);
    expect(healthBody).toMatchObject({ status: "ok", environment: "local", traceId });
    expect(health.headers.get("access-control-allow-origin")).toBe(webOrigin);
    expect(health.headers.get("access-control-allow-credentials")).toBe("true");

    const preflight = await runtimeRequest("/api/health", {
      method: "OPTIONS",
      headers: {
        origin: webOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "X-Request-ID",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(webOrigin);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Request-ID");

    const rejectedOrigin = await runtimeRequest("/api/health", {
      headers: { origin: "https://attacker.example" },
    });
    expect(rejectedOrigin.headers.has("access-control-allow-origin")).toBe(false);

    const missing = await runtimeRequest("/api/runtime/not-a-route", {
      headers: { "x-request-id": traceId },
    });
    const error = await errorResponse(missing, 404, "NOT_FOUND");
    expect(error.error.message).not.toContain("not-a-route");
  });

  it("serves seeded local organizer data for Events, People, CRM, and CFP review", async () => {
    const eventsResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events`,
      { headers: organizerHeaders },
    );
    const events = await jsonData<Array<{ id: string; organizationId: string }>>(eventsResponse);
    expect(eventsResponse.status).toBe(200);
    expect(events.map((event) => event.id)).toEqual(
      expect.arrayContaining(["demo-event", "open-sessionboard-conf"]),
    );
    expect(events.every((event) => event.organizationId === organizationId)).toBe(true);

    const membersResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/members`,
      { headers: organizerHeaders },
    );
    const members = await jsonData<Array<{ userId: string; role: string }>>(membersResponse);
    expect(membersResponse.status).toBe(200);
    expect(members).toContainEqual(
      expect.objectContaining({ userId: "local-organizer", role: "owner" }),
    );
    expect(members).not.toContainEqual(expect.objectContaining({ userId: "local-speaker" }));

    const contactsResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/crm/contacts?status=active`,
      { headers: organizerHeaders },
    );
    expect(contactsResponse.status).toBe(200);
    expect(await jsonData<unknown[]>(contactsResponse)).toEqual([]);

    const cfpResponse = await runtimeRequest(
      `/api/public/cfp/organizations/${organizationId}/events/${eventId}`,
    );
    expect(cfpResponse.status).toBe(200);
    expect(await jsonData<{ event: { id: string } }>(cfpResponse)).toMatchObject({
      event: { id: eventId },
    });

    const evaluationResponse = await runtimeRequest(
      `/api/admin/evaluations/organizer/workspace?eventId=${eventId}`,
      { headers: organizerHeaders },
    );
    expect(evaluationResponse.status).toBe(200);
    const evaluationWorkspace = await jsonData<{
      plan: {
        id: string;
        eventId: string;
        status: string;
        rounds: Array<{ reviewerPool: { reviewerIds: string[] } }>;
      };
      submissions: unknown[];
      assignments: unknown[];
      progress: { reviewers: unknown[] };
      decisions: Record<string, unknown>;
    }>(evaluationResponse);
    expect(evaluationWorkspace).toMatchObject({
      plan: {
        id: "local-evaluation-plan",
        eventId,
        status: "open",
      },
    });
    expect(evaluationWorkspace.submissions).toHaveLength(300);
    expect(evaluationWorkspace.assignments).toHaveLength(600);
    expect(evaluationWorkspace.plan.rounds[0]?.reviewerPool.reviewerIds).toHaveLength(24);
    expect(evaluationWorkspace.progress.reviewers).toHaveLength(24);
    expect(Object.keys(evaluationWorkspace.decisions)).toHaveLength(150);

    const speakerContentPath = `/api/speaker/events/${eventId}/organizer/content/speaker/local-participant`;
    const speakerContentResponse = await runtimeRequest(speakerContentPath, {
      headers: organizerHeaders,
    });
    expect(speakerContentResponse.status).toBe(200);
    expect(
      await jsonData<{ entityId: string; version: number; biography: string }>(
        speakerContentResponse,
      ),
    ).toMatchObject({
      entityId: "local-participant",
      version: 1,
    });

    const speakerHistoryResponse = await runtimeRequest(`${speakerContentPath}/history`, {
      headers: organizerHeaders,
    });
    expect(speakerHistoryResponse.status).toBe(200);
    expect(
      await jsonData<Array<{ entityId: string; version: number; action: string }>>(
        speakerHistoryResponse,
      ),
    ).toEqual([
      expect.objectContaining({
        entityId: "local-participant",
        version: 1,
        action: "created",
      }),
    ]);
  }, 15_000);

  it("seeds a production-scale review scenario through the local CFP workflow", async () => {
    const response = await runtimeRequest(
      `/api/admin/evaluations/organizer/workspace?eventId=${eventId}`,
      { headers: organizerHeaders },
    );
    expect(response.status).toBe(200);
    const workspace = await jsonData<{
      plan: { rounds: Array<{ reviewerPool: { reviewerIds: string[] } }> };
      submissions: unknown[];
      assignments: Array<{ submissionId: string; reviewerId: string }>;
      progress: { reviewers: unknown[] };
      decisions: Record<string, unknown>;
    }>(response);
    expect(workspace.submissions).toHaveLength(300);
    expect(workspace.assignments).toHaveLength(600);
    const reviewersBySubmission = new Map<string, Set<string>>();
    for (const assignment of workspace.assignments) {
      const reviewers = reviewersBySubmission.get(assignment.submissionId) ?? new Set<string>();
      reviewers.add(assignment.reviewerId);
      reviewersBySubmission.set(assignment.submissionId, reviewers);
    }
    expect(reviewersBySubmission.size).toBe(300);
    expect([...reviewersBySubmission.values()].every((reviewers) => reviewers.size === 2)).toBe(
      true,
    );
    expect(workspace.plan.rounds[0]?.reviewerPool.reviewerIds).toHaveLength(24);
    expect(workspace.progress.reviewers).toHaveLength(24);
    expect(Object.keys(workspace.decisions)).toHaveLength(150);
  });

  it("enforces auth boundaries while exposing a useful seeded speaker portal", async () => {
    const unauthenticatedAgenda = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events/${eventId}/agenda/draft`,
      { headers: { "x-request-id": traceId } },
    );
    await errorResponse(unauthenticatedAgenda, 401, "AUTHENTICATION_REQUIRED");

    const unauthenticatedPublicApi = await runtimeRequest(
      `/api/v1/organizations/${organizationId}/webhooks`,
      { headers: { "x-request-id": traceId } },
    );
    await errorResponse(unauthenticatedPublicApi, 401, "AUTHENTICATION_REQUIRED");

    const apiKeyHeaders = {
      authorization: "Bearer local-api-key",
      "x-request-id": traceId,
    };
    const crossTenant = await runtimeRequest(
      "/api/v1/organizations/another-organization/webhooks",
      { headers: apiKeyHeaders },
    );
    await errorResponse(crossTenant, 403, "ACCESS_DENIED");

    const agendaProjectionResponse = await runtimeRequest(`/api/public/events/${eventId}/agenda`);
    const agendaProjection = await jsonData<{ entries: Array<Record<string, unknown>> }>(
      agendaProjectionResponse,
    );

    expect(agendaProjectionResponse.status).toBe(200);
    expect(agendaProjection.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(agendaProjection)).not.toContain("email");

    const portalResponse = await runtimeRequest(`/api/speaker/events/${eventId}/portal`, {
      headers: speakerHeaders,
    });
    const portal = await jsonData<{
      submissions: Array<{ id: string; eventId: string }>;
      profiles: Array<{ participantId: string; eventId: string }>;
      tasks: Array<{ id: string; eventId: string }>;
      outstandingTaskCount: number;
    }>(portalResponse);

    expect(portalResponse.status).toBe(200);
    expect(portalResponse.headers.get("cache-control")).toContain("no-store");
    expect(portal.submissions.length).toBeGreaterThan(0);
    expect(portal.profiles.length).toBeGreaterThan(0);
    expect(portal.tasks.length).toBeGreaterThan(0);
    expect(portal.outstandingTaskCount).toBeGreaterThan(0);
    expect(portal.submissions.every((submission) => submission.eventId === eventId)).toBe(true);
    expect(portal.profiles.every((profile) => profile.eventId === eventId)).toBe(true);
    expect(portal.tasks.every((task) => task.eventId === eventId)).toBe(true);
  });
  it("keeps organizer, reviewer, and speaker personas on separate authorization paths", async () => {
    const signIn = async (email: string, password: string) => {
      const response = await runtimeRequest(
        "/api/auth/sign-in/email",
        jsonRequest("POST", { email, password }),
      );
      expect(response.status).toBe(200);
      return response;
    };
    const organizerSignIn = await signIn("organizer@local.eventloom.test", "organizer-local");
    const reviewerSignIn = await signIn("reviewer@local.eventloom.test", "reviewer-local");
    const speakerSignIn = await signIn("speaker@local.eventloom.test", "speaker-local");

    expect((await organizerSignIn.json()).token).toBe("local-session");
    expect((await reviewerSignIn.json()).token).toBe("local-reviewer-session");
    expect((await speakerSignIn.json()).token).toBe("local-speaker-session");

    const reviewerWorkspace = await runtimeRequest(
      "/api/admin/evaluations/reviewer/workspace?eventId=demo-event",
      { headers: reviewerHeaders },
    );
    const reviewerData = await jsonData<{
      assignments: Array<{
        assignment: { reviewerId: string; status: string; submissionId: string };
        plan: { eventName: string };
      }>;
    }>(reviewerWorkspace);
    expect(reviewerWorkspace.status).toBe(200);
    expect(reviewerData.assignments.length).toBeGreaterThan(1);
    expect(
      reviewerData.assignments.every(
        ({ plan }) => plan.eventName === "Open Sessionboard Conference",
      ),
    ).toBe(true);
    expect(
      reviewerData.assignments.every(
        ({ assignment }) => assignment.reviewerId === "local-reviewer",
      ),
    ).toBe(true);
    expect(
      new Set(reviewerData.assignments.map(({ assignment }) => assignment.submissionId)).size,
    ).toBe(reviewerData.assignments.length);
    expect(reviewerData.assignments.map(({ assignment }) => assignment.status)).toEqual(
      expect.arrayContaining(["assigned", "in_progress", "submitted"]),
    );

    const reviewerEvents = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events`,
      { headers: reviewerHeaders },
    );
    await errorResponse(reviewerEvents, 403, "ACCESS_DENIED");

    const reviewerOrganizerWorkspace = await runtimeRequest(
      "/api/admin/evaluations/organizer/workspace?eventId=demo-event",
      { headers: reviewerHeaders },
    );
    await errorResponse(reviewerOrganizerWorkspace, 403, "ACCESS_DENIED");

    const speakerEvents = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events`,
      { headers: speakerHeaders },
    );
    await errorResponse(speakerEvents, 403, "ACCESS_DENIED");

    const reviewerPortal = await runtimeRequest(`/api/speaker/events/${eventId}/portal`, {
      headers: reviewerHeaders,
    });
    await errorResponse(reviewerPortal, 404, "NOT_FOUND");
    const speakerPortal = await runtimeRequest(`/api/speaker/events/${eventId}/portal`, {
      headers: speakerHeaders,
    });
    expect(speakerPortal.status).toBe(200);
  });

  it("serves one event lifecycle across organizer surfaces and public projections", async () => {
    const eventResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events`,
      { headers: organizerHeaders },
    );
    const events = await jsonData<Array<Record<string, unknown>>>(eventResponse);
    expect(eventResponse.status).toBe(200);
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: eventId, slug: eventId })]),
    );

    const eventDetailResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events/${eventId}`,
      { headers: organizerHeaders },
    );
    const eventDetail = await jsonData<Record<string, unknown>>(eventDetailResponse);
    expect(eventDetailResponse.status).toBe(200);
    expect(eventDetail).toMatchObject({
      id: eventId,
      cfpSettings: { enabled: true },
      embedConfigurations: [expect.objectContaining({ enabled: true, widgetId: "agenda" })],
    });
    const overviewResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/overview/activity`,
      { headers: organizerHeaders },
    );
    const overview = await jsonData<{
      metrics: {
        submissionCount: number;
        pendingReviewCount: number;
        outstandingSpeakerTaskCount: number;
        publishedSessionCount: number;
      };
    }>(overviewResponse);
    expect(overviewResponse.status).toBe(200);
    expect(overview.metrics).toMatchObject({
      submissionCount: 300,
      pendingReviewCount: 1,
      outstandingSpeakerTaskCount: 75,
      publishedSessionCount: 2,
    });

    const sessionsResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events/${eventId}/sessions`,
      { headers: organizerHeaders },
    );
    const sessions = await jsonData<Array<Record<string, unknown>>>(sessionsResponse);
    const settingsResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events/${eventId}/sessions/settings`,
      { headers: organizerHeaders },
    );
    const settings = await jsonData<Record<string, unknown>>(settingsResponse);
    const auditResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events/${eventId}/sessions/audit`,
      { headers: organizerHeaders },
    );
    const audit = await jsonData<Array<Record<string, unknown>>>(auditResponse);
    expect(sessionsResponse.status).toBe(200);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.every((session) => session.status === "Accepted")).toBe(true);
    expect(settingsResponse.status).toBe(200);
    expect(settings).toMatchObject({ agendaEligibleStatuses: ["Accepted"] });
    expect(auditResponse.status).toBe(200);
    expect(audit.length).toBeGreaterThan(0);

    const membersResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/members`,
      { headers: organizerHeaders },
    );
    const members = await jsonData<Array<Record<string, unknown>>>(membersResponse);
    expect(membersResponse.status).toBe(200);
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "local-organizer", role: "owner" }),
        expect.objectContaining({ userId: "local-reviewer", role: "reviewer" }),
      ]),
    );

    const cfpResponse = await runtimeRequest(
      `/api/cfp/organizations/${organizationId}/events/${eventId}/submissions`,
      { headers: organizerHeaders },
    );
    const cfpSubmissions =
      await jsonData<Array<{ submission: { id: string; status: string } }>>(cfpResponse);
    expect(cfpResponse.status).toBe(200);
    expect(cfpSubmissions).toHaveLength(300);
    expect(cfpSubmissions.every(({ submission }) => submission.status === "submitted")).toBe(true);

    const publicCfpResponse = await runtimeRequest(
      `/api/public/cfp/organizations/${organizationId}/events/${eventId}`,
    );
    expect(publicCfpResponse.status).toBe(200);

    const organizerEvaluation = await runtimeRequest(
      "/api/admin/evaluations/organizer/workspace?eventId=demo-event",
      { headers: organizerHeaders },
    );
    expect(organizerEvaluation.status).toBe(200);

    const deliverablesResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/organizer/deliverables`,
      { headers: organizerHeaders },
    );
    const deliverables = await jsonData<{
      items: Array<{ task: { type: string; acceptedAssetKinds?: string[] } }>;
    }>(deliverablesResponse);
    const filesResponse = await runtimeRequest(`/api/speaker/events/${eventId}/organizer/assets`, {
      headers: organizerHeaders,
    });
    const files = await jsonData<Array<Record<string, unknown>>>(filesResponse);
    expect(deliverablesResponse.status).toBe(200);
    expect(deliverables.items).toHaveLength(1);
    expect(deliverables.items).toContainEqual(
      expect.objectContaining({
        task: expect.objectContaining({ type: "upload", acceptedAssetKinds: ["slides"] }),
      }),
    );
    expect(filesResponse.status).toBe(200);
    expect(files).toContainEqual(
      expect.objectContaining({
        kind: "headshot",
        state: "ready",
        reviewState: "approved",
      }),
    );

    const advertisedEventFilesResponse = await runtimeRequest(
      "/api/speaker/events/open-sessionboard-conf/organizer/assets",
      { headers: organizerHeaders },
    );
    const advertisedEventFiles = await jsonData<Array<Record<string, unknown>>>(
      advertisedEventFilesResponse,
    );
    expect(advertisedEventFilesResponse.status).toBe(200);
    expect(advertisedEventFiles).toEqual([]);

    const communicationsResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events/${eventId}/communications/templates`,
      { headers: organizerHeaders },
    );
    const communications = await communicationsResponse.json();
    expect(communicationsResponse.status).toBe(200);
    expect(JSON.stringify(communications)).toContain("local-template-accepted");

    const reportsResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events/${eventId}/reports`,
      { headers: organizerHeaders },
    );
    const reports = await reportsResponse.json();
    expect(reportsResponse.status).toBe(200);
    expect(JSON.stringify(reports)).toContain("local-program-report");

    const remixRecordsResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events/${eventId}/remix/records?sourceType=session`,
      { headers: organizerHeaders },
    );
    const remixRecords = await remixRecordsResponse.json();
    expect(remixRecordsResponse.status).toBe(200);
    expect(JSON.stringify(remixRecords)).toContain("session-submission_local_1");

    const publicAgendaResponse = await runtimeRequest(`/api/public/events/${eventId}/agenda`);
    const publicAgenda = await jsonData<{ event: { slug: string }; entries: unknown[] }>(
      publicAgendaResponse,
    );
    const publicSpeakersResponse = await runtimeRequest(`/api/public/events/${eventId}/speakers`);
    const publicSpeakers = await publicSpeakersResponse.json();
    expect(publicAgendaResponse.status).toBe(200);
    expect(publicAgenda.event.slug).toBe(eventId);
    expect(publicAgenda.entries.length).toBeGreaterThan(0);
    expect(publicSpeakersResponse.status).toBe(200);
    expect(JSON.stringify(publicSpeakers)).toContain("Alex Rivera");

    const agendaWorkspaceResponse = await runtimeRequest(
      `/api/admin/organizations/${organizationId}/events/${eventId}/agenda`,
      { headers: organizerHeaders },
    );
    const agendaWorkspace = await jsonData<{
      event: { id: string };
      draft: { entries: unknown[] };
    }>(agendaWorkspaceResponse);
    expect(agendaWorkspaceResponse.status).toBe(200);
    expect(agendaWorkspace.event.id).toBe(eventId);
    expect(agendaWorkspace.draft.entries.length).toBeGreaterThan(0);
  });

  it("rejects agenda conflicts and stale writes, then publishes the immutable public projection", async () => {
    const adminBase = `/api/admin/organizations/${organizationId}/events/${eventId}/agenda`;
    const seededPublicResponse = await runtimeRequest(`/api/public/events/${eventId}/agenda`);
    const seededPublic = await jsonData<{ entries: unknown[] }>(seededPublicResponse);
    expect(seededPublicResponse.status).toBe(200);
    expect(seededPublic.entries.length).toBeGreaterThanOrEqual(2);
    const draftResponse = await runtimeRequest(`${adminBase}/draft`, {
      headers: organizerHeaders,
    });
    expect(draftResponse.status).toBe(200);
    const draft = await jsonData<{
      eventId: string;
      version: number;
      entries: Array<{
        id: string;
        sessionId: string;
        roomId: string;
        trackIds: string[];
        startsAtLocal: string;
        endsAtLocal: string;
      }>;
    }>(draftResponse);
    const inputEntries = draft.entries.map(
      ({ id, sessionId, roomId, trackIds, startsAtLocal, endsAtLocal }) => ({
        id,
        sessionId,
        roomId,
        trackIds,
        startsAtLocal,
        endsAtLocal,
      }),
    );
    const firstEntry = inputEntries[0];
    const secondEntry = inputEntries[1];

    expect(draft.eventId).toBe(eventId);
    expect(inputEntries.length).toBeGreaterThanOrEqual(2);
    if (!firstEntry || !secondEntry) throw new Error("The local agenda seed needs two entries.");

    const conflictingEntries = inputEntries.map((entry, index) =>
      index === 1
        ? {
            ...entry,
            roomId: firstEntry.roomId,
            startsAtLocal: firstEntry.startsAtLocal,
            endsAtLocal: firstEntry.endsAtLocal,
          }
        : entry,
    );
    const conflictResponse = await runtimeRequest(
      `${adminBase}/draft`,
      jsonRequest(
        "PUT",
        { expectedVersion: draft.version, entries: conflictingEntries },
        organizerHeaders,
      ),
    );
    const conflict = await errorResponse(conflictResponse, 409, "CONFLICT");
    expect(conflict.error.details?.map((detail) => detail.code)).toContain("agenda.room");

    const unchangedResponse = await runtimeRequest(`${adminBase}/draft`, {
      headers: organizerHeaders,
    });
    const unchanged = await jsonData<{ version: number; entries: unknown[] }>(unchangedResponse);
    expect(unchanged.version).toBe(draft.version);
    expect(unchanged.entries).toHaveLength(draft.entries.length);

    const updatedEntries = inputEntries.map((entry, index) =>
      index === 0 ? { ...entry, endsAtLocal: "2026-09-18T09:45:00" } : entry,
    );

    const updateResponse = await runtimeRequest(
      `${adminBase}/draft`,
      jsonRequest(
        "PUT",
        { expectedVersion: draft.version, entries: updatedEntries },
        organizerHeaders,
      ),
    );
    const updated = await jsonData<{ version: number }>(updateResponse);
    expect(updateResponse.status).toBe(200);
    expect(updated.version).toBe(draft.version + 1);

    const staleResponse = await runtimeRequest(
      `${adminBase}/draft`,
      jsonRequest("PUT", { expectedVersion: draft.version, entries: [] }, organizerHeaders),
    );
    await errorResponse(staleResponse, 409, "CONFLICT");

    const validateResponse = await runtimeRequest(
      `${adminBase}/validate`,
      jsonRequest("POST", { expectedVersion: updated.version }, organizerHeaders),
    );
    expect(validateResponse.status).toBe(200);

    const publishResponse = await runtimeRequest(
      `${adminBase}/publish`,
      jsonRequest("POST", { expectedVersion: updated.version }, organizerHeaders),
    );
    const publication = await jsonData<{
      id: string;
      eventId: string;
      sourceDraftVersion: number;
      entries: unknown[];
    }>(publishResponse);
    expect(publishResponse.status).toBe(200);
    expect(publication).toMatchObject({ eventId, sourceDraftVersion: updated.version });

    const publicResponse = await runtimeRequest(`/api/public/events/${eventId}/agenda`);
    const publicAgenda = await jsonData<{
      event: { slug: string };
      revision: { id: string; number: number; publishedAt: string };
      entries: unknown[];
    }>(publicResponse);
    const serialized = JSON.stringify(publicAgenda);

    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("cache-control")).toContain("s-maxage=60");
    expect(publicAgenda).toMatchObject({
      event: { slug: eventId },
      revision: { id: publication.id },
    });
    expect(publicAgenda.entries).toHaveLength(draft.entries.length);
    expect(serialized).not.toContain("publishedBy");
    expect(serialized).not.toContain("warningOverrides");
    expect(serialized).not.toContain("updatedBy");
  });

  it("creates, edits, and idempotently resubmits CFP data through the composed runtime", async () => {
    const applicantSignUpResponse = await runtimeRequest(
      "/api/auth/sign-up/email",
      jsonRequest("POST", {
        email: "runtime-applicant@example.test",
        password: "runtime-applicant",
        name: "Runtime Applicant",
      }),
    );
    const applicantSignUp = (await applicantSignUpResponse.json()) as {
      token: string;
      user: { id: string };
    };
    expect(applicantSignUpResponse.status).toBe(200);
    const applicantHeaders = {
      cookie: `better-auth.session_token=${applicantSignUp.token}`,
      "x-request-id": traceId,
    };
    const cfpBase = `/api/cfp/organizations/${organizationId}/events/${eventId}`;
    const createPath = `${cfpBase}/forms/${formId}/drafts`;
    const createInit = {
      method: "POST",
      headers: {
        ...applicantHeaders,
        "idempotency-key": "runtime-cfp-create-1",
      },
    } satisfies RequestInit;

    const unauthenticated = await runtimeRequest(createPath, {
      method: "POST",
      headers: { "idempotency-key": "runtime-cfp-unauthenticated-1", "x-request-id": traceId },
    });
    await errorResponse(unauthenticated, 401, "AUTHENTICATION_REQUIRED");

    const missingIdempotencyKey = await runtimeRequest(createPath, {
      method: "POST",
      headers: applicantHeaders,
    });
    await errorResponse(missingIdempotencyKey, 400, "VALIDATION_FAILED");

    const createdResponse = await runtimeRequest(createPath, createInit);
    const created = await jsonData<{
      id: string;
      version: number;
      status: string;
      ownerAccountId: string;
    }>(createdResponse);
    expect(createdResponse.status).toBe(201);
    expect(created).toMatchObject({
      status: "draft",
      ownerAccountId: applicantSignUp.user.id,
    });

    const replayResponse = await runtimeRequest(createPath, createInit);
    const replay = await jsonData<{ id: string; version: number }>(replayResponse);
    expect(replayResponse.status).toBe(201);
    expect(replay).toEqual(expect.objectContaining({ id: created.id, version: created.version }));

    let version = created.version;
    const completedSteps = ["welcome", "account", "submission"] as const;
    for (const completedStep of completedSteps) {
      const savedResponse = await runtimeRequest(
        `${cfpBase}/submissions/${created.id}/draft`,
        jsonRequest(
          "PATCH",
          {
            expectedVersion: version,
            completedStep,
            ...(completedStep === "submission"
              ? {
                  answers: {
                    title: "Reliable local runtime verification",
                    format: "Breakout Session",
                    level: "Intermediate",
                    track: "Platform & Infrastructure",
                    abstract:
                      "A complete deterministic CFP submission exercised without credentials.",
                  },
                }
              : {}),
          },
          {
            ...applicantHeaders,
            "idempotency-key": `runtime-cfp-step-${completedStep}`,
          },
        ),
      );
      const saved = await jsonData<{ version: number }>(savedResponse);
      expect(savedResponse.status).toBe(200);
      version = saved.version;
    }

    const participantsResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/participants`,
      jsonRequest(
        "PUT",
        {
          expectedVersion: version,
          participants: [
            {
              id: "participant-runtime",
              firstName: "Avery",
              lastName: "Speaker",
              email: "avery@example.test",
              role: "primary",
              biography: "A deterministic local speaker biography.",
              answers: {},
            },
          ],
          secondaryContacts: [],
        },
        { ...applicantHeaders, "idempotency-key": "runtime-cfp-participants-1" },
      ),
    );
    const participants = await jsonData<{ version: number }>(participantsResponse);
    expect(participantsResponse.status).toBe(200);
    version = participants.version;

    const reviewStepResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/draft`,
      jsonRequest(
        "PATCH",
        { expectedVersion: version, completedStep: "review" },
        { ...applicantHeaders, "idempotency-key": "runtime-cfp-review-step-1" },
      ),
    );
    const reviewStep = await jsonData<{ version: number }>(reviewStepResponse);
    expect(reviewStepResponse.status).toBe(200);
    version = reviewStep.version;

    const reviewResponse = await runtimeRequest(`${cfpBase}/submissions/${created.id}/review`, {
      method: "POST",
      headers: { ...applicantHeaders, "idempotency-key": "runtime-cfp-review-1" },
    });
    const review = await jsonData<{ canSubmit: boolean; issues: unknown[] }>(reviewResponse);
    expect(reviewResponse.status).toBe(200);
    expect(review).toMatchObject({ canSubmit: true, issues: [] });

    const submitInit = jsonRequest(
      "POST",
      { expectedVersion: version },
      { ...applicantHeaders, "idempotency-key": "runtime-cfp-submit-1" },
    );
    const submitResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/submit`,
      submitInit,
    );
    type RuntimeCfpSubmission = {
      id: string;
      status: string;
      version: number;
      submittedAt: string | null;
      completedSteps: string[];
      answers: Record<string, unknown>;
      participants: Array<{
        id: string;
        firstName: string;
        lastName: string;
        email: string;
        role: string;
        biography: string;
        answers: Record<string, unknown>;
      }>;
    };
    type RuntimeCfpSubmitResult = {
      submission: RuntimeCfpSubmission;
      receipt: {
        submissionId: string;
        version: number;
        submittedAt: string;
      };
      confirmationQueued: boolean;
    };
    const submitted = await jsonData<RuntimeCfpSubmitResult>(submitResponse);
    expect(submitResponse.status).toBe(200);
    expect(submitted.submission).toMatchObject({ id: created.id, status: "submitted" });
    expect(submitted.confirmationQueued).toBe(true);

    const submitReplayResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/submit`,
      submitInit,
    );
    const submitReplay = await jsonData<RuntimeCfpSubmitResult>(submitReplayResponse);
    expect(submitReplayResponse.status).toBe(200);
    expect(submitReplay).toEqual(submitted);

    const submittedAt = submitted.submission.submittedAt;
    const submittedCompletedSteps = submitted.submission.completedSteps;
    const submittedParticipantIds = submitted.submission.participants.map(
      (participant) => participant.id,
    );
    const submittedVersion = submitted.submission.version;
    const submittedParticipantsReloadResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/draft`,
      { headers: applicantHeaders },
    );
    const submittedParticipantsReload = await jsonData<RuntimeCfpSubmission>(
      submittedParticipantsReloadResponse,
    );
    expect(submittedParticipantsReloadResponse.status).toBe(200);
    expect(submittedParticipantsReload).toEqual(submitted.submission);

    const editPatchInit = jsonRequest(
      "PATCH",
      {
        expectedVersion: submittedVersion,
        answers: {
          ...submitted.submission.answers,
          abstract: "Updated after submission without losing lifecycle state.",
        },
      },
      { ...applicantHeaders, "idempotency-key": "runtime-cfp-submitted-edit-patch-1" },
    );
    const editPatchResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/draft`,
      editPatchInit,
    );
    const editedDraft = await jsonData<RuntimeCfpSubmission>(editPatchResponse);
    expect(editPatchResponse.status).toBe(200);
    expect(editedDraft).toMatchObject({
      status: "submitted",
      submittedAt,
      completedSteps: submittedCompletedSteps,
      version: submittedVersion + 1,
    });
    expect(editedDraft.answers.abstract).toBe(
      "Updated after submission without losing lifecycle state.",
    );
    expect(editedDraft.participants.map((participant) => participant.id)).toEqual(
      submittedParticipantIds,
    );

    const editPatchReplayResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/draft`,
      editPatchInit,
    );
    const editedDraftReplay = await jsonData<typeof editedDraft>(editPatchReplayResponse);
    expect(editPatchReplayResponse.status).toBe(200);
    expect(editedDraftReplay).toEqual(editedDraft);

    const participantsReloadResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/draft`,
      { headers: applicantHeaders },
    );
    const participantsReload = await jsonData<RuntimeCfpSubmission>(participantsReloadResponse);
    expect(participantsReloadResponse.status).toBe(200);
    expect(participantsReload).toEqual(editedDraft);

    const editedParticipantRecords = participantsReload.participants.map((participant) => ({
      ...participant,
      answers: { ...participant.answers, company: "Runtime Systems" },
    }));
    const participantsEditInit = jsonRequest(
      "PUT",
      {
        expectedVersion: participantsReload.version,
        participants: editedParticipantRecords,
        secondaryContacts: [],
      },
      {
        ...applicantHeaders,
        "idempotency-key": "runtime-cfp-submitted-edit-participants-1",
      },
    );
    const participantsEditResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/participants`,
      participantsEditInit,
    );
    const editedParticipants = await jsonData<typeof editedDraft>(participantsEditResponse);
    expect(participantsEditResponse.status).toBe(200);
    expect(editedParticipants).toMatchObject({
      status: "submitted",
      submittedAt,
      completedSteps: submittedCompletedSteps,
      version: submittedVersion + 2,
    });
    expect(editedParticipants.participants.map((participant) => participant.id)).toEqual(
      submittedParticipantIds,
    );
    expect(editedParticipants.participants[0]?.answers.company).toBe("Runtime Systems");

    const participantsEditReplayResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/participants`,
      participantsEditInit,
    );
    const editedParticipantsReplay = await jsonData<typeof editedDraft>(
      participantsEditReplayResponse,
    );
    expect(participantsEditReplayResponse.status).toBe(200);
    expect(editedParticipantsReplay).toEqual(editedParticipants);

    const reviewReloadResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/draft`,
      {
        headers: applicantHeaders,
      },
    );
    const reviewReload = await jsonData<RuntimeCfpSubmission>(reviewReloadResponse);
    expect(reviewReloadResponse.status).toBe(200);
    expect(reviewReload).toEqual(editedParticipants);

    const editedReviewInit = {
      method: "POST",
      headers: {
        ...applicantHeaders,
        "idempotency-key": "runtime-cfp-submitted-edit-review-1",
      },
    };
    const editedReviewResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/review`,
      editedReviewInit,
    );
    const editedReview = await jsonData<{
      canSubmit: boolean;
      issues: unknown[];
      version: number;
    }>(editedReviewResponse);
    expect(editedReviewResponse.status).toBe(200);
    expect(editedReview).toMatchObject({
      canSubmit: true,
      issues: [],
      version: editedParticipants.version,
    });

    const editedReviewReplayResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/review`,
      editedReviewInit,
    );
    const editedReviewReplay = await jsonData<typeof editedReview>(editedReviewReplayResponse);
    expect(editedReviewReplayResponse.status).toBe(200);
    expect(editedReviewReplay).toEqual(editedReview);

    const resubmitInit = jsonRequest(
      "POST",
      {
        expectedVersion: reviewReload.version,
      },
      {
        ...applicantHeaders,
        "idempotency-key": "runtime-cfp-submitted-edit-resubmit-1",
      },
    );
    const resubmitResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/submit`,
      resubmitInit,
    );
    const resubmitted = await jsonData<RuntimeCfpSubmitResult>(resubmitResponse);
    expect(resubmitResponse.status).toBe(200);
    expect(resubmitted.submission).toEqual(reviewReload);
    expect(resubmitted.submission).toMatchObject({
      status: "submitted",
      submittedAt,
      completedSteps: submittedCompletedSteps,
      version: editedParticipants.version,
    });
    expect(resubmitted.submission.participants.map((participant) => participant.id)).toEqual(
      submittedParticipantIds,
    );
    expect(resubmitted.submission.participants[0]?.answers.company).toBe("Runtime Systems");
    expect(resubmitted.receipt).toMatchObject({
      submissionId: created.id,
      submittedAt,
      version: editedParticipants.version,
    });
    expect(resubmitted.confirmationQueued).toBe(false);

    const resubmitReplayResponse = await runtimeRequest(
      `${cfpBase}/submissions/${created.id}/submit`,
      resubmitInit,
    );
    const resubmitReplay = await jsonData<RuntimeCfpSubmitResult>(resubmitReplayResponse);
    expect(resubmitReplayResponse.status).toBe(200);
    expect(resubmitReplay).toEqual(resubmitted);

    const reconciledResponse = await runtimeRequest(`${cfpBase}/submissions/${created.id}/draft`, {
      headers: applicantHeaders,
    });
    const reconciled = await jsonData<RuntimeCfpSubmission>(reconciledResponse);
    expect(reconciledResponse.status).toBe(200);
    expect(reconciled).toEqual(reviewReload);
  });

  it("completes a seeded speaker task upload and authorized local download", async () => {
    const portalResponse = await runtimeRequest(`/api/speaker/events/${eventId}/portal`, {
      headers: speakerHeaders,
    });
    const portal = await jsonData<{
      tasks: Array<{
        id: string;
        subject: { type: "participant" } | { type: "session"; sessionId: string };
        participantId: string;
        type: string;
        allowedMimeTypes?: string[];
        maxBytes?: number;
        acceptedAssetKinds?: string[];
      }>;
    }>(portalResponse);
    expect(portalResponse.status).toBe(200);
    const uploadTask = portal.tasks.find(
      (task) =>
        task.type === "upload" &&
        task.allowedMimeTypes?.includes("application/pdf") === true &&
        task.acceptedAssetKinds?.includes("slides") === true,
    );
    if (uploadTask === undefined || uploadTask.subject.type !== "session") {
      throw new Error("The featured accepted session needs a canonical slides upload task.");
    }
    expect(uploadTask.maxBytes).toEqual(expect.any(Number));
    expect(Number.isFinite(uploadTask.maxBytes)).toBe(true);

    const fileBody = "deterministic local speaker bytes";
    const uploadPayload = {
      participantId: uploadTask.participantId,
      sessionId: uploadTask.subject.sessionId,
      taskId: uploadTask.id,
      kind: "slides" as const,
      fileName: "local-speaker-slides.pdf",
      contentType: "application/pdf",
      sizeBytes: new TextEncoder().encode(fileBody).byteLength,
    };
    const uploadResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/uploads`,
      jsonRequest("POST", uploadPayload, speakerHeaders),
    );
    const upload = await jsonData<{
      asset: { id: string; state: string; version: number; versionFamilyId: string };
      grant: {
        method: "PUT";
        url: string;
        headers: Record<string, string>;
        expiresAt: string;
      };
    }>(uploadResponse);
    expect(uploadResponse.status).toBe(201);
    expect(upload.asset).toMatchObject({ state: "pending_upload", version: 1 });
    expect(upload.grant).toMatchObject({ method: "PUT" });
    expect(upload.grant.url).toMatch(
      /^\/api\/speaker\/assets\/capabilities\/upload\/[^/]+\/[^/]+$/u,
    );
    expect(upload.grant.url).not.toMatch(/^https?:/u);

    const wrongTokenUrl = upload.grant.url.replace(/[^/]+$/u, "wrong-token");
    const wrongTokenResponse = await runtimeRequest(wrongTokenUrl, {
      method: "PUT",
      headers: { ...upload.grant.headers, ...speakerHeaders },
      body: fileBody,
    });
    await errorResponse(wrongTokenResponse, 404, "NOT_FOUND");

    const reviewerResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/uploads`,
      jsonRequest("POST", uploadPayload, reviewerHeaders),
    );
    await errorResponse(reviewerResponse, 404, "NOT_FOUND");

    const putResponse = await runtimeRequest(upload.grant.url, {
      method: "PUT",
      headers: { ...upload.grant.headers, ...speakerHeaders },
      body: fileBody,
    });
    const receipt = await jsonData<{
      contentType: string;
      sizeBytes: number;
      uploadedAt: string;
    }>(putResponse);
    expect(putResponse.status).toBe(201);
    expect(receipt).toMatchObject({
      contentType: "application/pdf",
      sizeBytes: uploadPayload.sizeBytes,
    });

    const finalizeResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/assets/${upload.asset.id}/finalize`,
      jsonRequest("POST", { state: "ready" }, speakerHeaders),
    );
    const finalized = await jsonData<{ id: string; state: string; version: number }>(
      finalizeResponse,
    );
    expect(finalizeResponse.status).toBe(200);
    expect(finalized).toMatchObject({
      id: upload.asset.id,
      state: "ready",
      version: 1,
    });

    const finalizedTaskResponse = await runtimeRequest(`/api/speaker/events/${eventId}/tasks`, {
      headers: speakerHeaders,
    });
    const finalizedTasks =
      await jsonData<Array<{ id: string; status: string; version: number }>>(finalizedTaskResponse);
    expect(finalizedTaskResponse.status).toBe(200);
    expect(finalizedTasks).toContainEqual(
      expect.objectContaining({ id: uploadTask.id, status: "not_started", version: 1 }),
    );

    const startTaskResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/tasks/${encodeURIComponent(uploadTask.id)}/transitions`,
      jsonRequest("POST", { toStatus: "in_progress", expectedVersion: 1 }, speakerHeaders),
    );
    expect(startTaskResponse.status).toBe(200);
    expect(
      await jsonData<{ task: { id: string; status: string; version: number } }>(startTaskResponse),
    ).toMatchObject({
      task: { id: uploadTask.id, status: "in_progress", version: 2 },
    });

    const submitTaskResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/tasks/${encodeURIComponent(uploadTask.id)}/transitions`,
      jsonRequest("POST", { toStatus: "submitted", expectedVersion: 2 }, speakerHeaders),
    );
    expect(submitTaskResponse.status).toBe(200);
    expect(
      await jsonData<{ task: { id: string; status: string; version: number } }>(submitTaskResponse),
    ).toMatchObject({
      task: { id: uploadTask.id, status: "submitted", version: 3 },
    });

    const taskResponse = await runtimeRequest(`/api/speaker/events/${eventId}/tasks`, {
      headers: speakerHeaders,
    });
    const tasks =
      await jsonData<Array<{ id: string; status: string; version: number }>>(taskResponse);
    expect(taskResponse.status).toBe(200);
    expect(tasks).toContainEqual(
      expect.objectContaining({ id: uploadTask.id, status: "submitted", version: 3 }),
    );

    const deliverablesResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/organizer/deliverables?taskId=${encodeURIComponent(uploadTask.id)}`,
      { headers: organizerHeaders },
    );
    const deliverables = await jsonData<{
      items: Array<{
        task: { id: string };
        currentAsset?: { id: string; state: string; version: number };
      }>;
    }>(deliverablesResponse);
    expect(deliverablesResponse.status).toBe(200);
    expect(deliverables.items).toContainEqual(
      expect.objectContaining({
        task: expect.objectContaining({ id: uploadTask.id }),
        currentAsset: expect.objectContaining({
          id: upload.asset.id,
          state: "ready",
          version: 1,
        }),
      }),
    );

    const needsChangesResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/organizer/assets/${upload.asset.id}/review`,
      jsonRequest(
        "POST",
        {
          state: "needs_changes",
          release: false,
          note: "Replace the session deck with v2.",
          expectedVersion: 0,
        },
        organizerHeaders,
      ),
    );
    expect(needsChangesResponse.status).toBe(200);
    expect(
      await jsonData<{ reviewState: string; reviewNote?: string }>(needsChangesResponse),
    ).toMatchObject({
      reviewState: "needs_changes",
      reviewNote: "Replace the session deck with v2.",
    });

    const returnedTaskResponse = await runtimeRequest(`/api/speaker/events/${eventId}/tasks`, {
      headers: speakerHeaders,
    });
    const returnedTasks =
      await jsonData<Array<{ id: string; status: string; version: number }>>(returnedTaskResponse);
    expect(returnedTaskResponse.status).toBe(200);
    expect(returnedTasks).toContainEqual(
      expect.objectContaining({ id: uploadTask.id, status: "needs_changes", version: 4 }),
    );

    const replacementBody = "deterministic replacement speaker bytes";
    const authorizeReplacement = (idempotencyKey: string, fileName = "deck-v2.pdf") =>
      runtimeRequest(
        `/api/speaker/events/${eventId}/uploads`,
        jsonRequest(
          "POST",
          {
            participantId: uploadTask.participantId,
            taskId: uploadTask.id,
            kind: "slides",
            fileName,
            contentType: "application/pdf",
            sizeBytes: new TextEncoder().encode(replacementBody).byteLength,
            supersedesAssetId: upload.asset.id,
            expectedLatestVersion: upload.asset.version,
          },
          { ...speakerHeaders, "idempotency-key": idempotencyKey },
        ),
      );
    const [replacementAuthorizeResponse, replayedReplacementResponse] = await Promise.all([
      authorizeReplacement("local-runtime-replacement-v2"),
      authorizeReplacement("local-runtime-replacement-v2"),
    ]);
    expect(
      replacementAuthorizeResponse.status,
      await replacementAuthorizeResponse.clone().text(),
    ).toBe(201);
    const replacement = await jsonData<{
      asset: {
        id: string;
        version: number;
        versionFamilyId: string;
        supersedesAssetId?: string;
      };
      grant: { method: string; url: string; headers: Record<string, string> };
    }>(replacementAuthorizeResponse);
    const replayedReplacement = await jsonData<{
      asset: { id: string };
      grant: { method: string; url: string; headers: Record<string, string> };
    }>(replayedReplacementResponse);
    expect(replayedReplacementResponse.status).toBe(201);
    expect(replayedReplacement.asset.id).toBe(replacement.asset.id);
    const changedReplayResponse = await authorizeReplacement(
      "local-runtime-replacement-v2",
      "deck-v2-renamed.pdf",
    );
    expect(changedReplayResponse.status).toBe(409);
    const staleHeadResponse = await authorizeReplacement("local-runtime-replacement-v2-other");
    expect(staleHeadResponse.status).toBe(409);
    expect(replacement.asset).toMatchObject({
      version: 2,
      versionFamilyId: upload.asset.versionFamilyId,
      supersedesAssetId: upload.asset.id,
    });
    const replacementUploadResponse = await runtimeRequest(replayedReplacement.grant.url, {
      method: replayedReplacement.grant.method,
      headers: { ...replayedReplacement.grant.headers, ...speakerHeaders },
      body: replacementBody,
    });
    expect(replacementUploadResponse.status, await replacementUploadResponse.clone().text()).toBe(
      201,
    );
    const replacementFinalizeResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/assets/${replacement.asset.id}/finalize`,
      jsonRequest("POST", { state: "ready" }, speakerHeaders),
    );
    expect(replacementFinalizeResponse.status).toBe(200);
    const replacementSubmitResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/tasks/${uploadTask.id}/transitions`,
      jsonRequest(
        "POST",
        {
          toStatus: "submitted",
          expectedVersion: 4,
        },
        speakerHeaders,
      ),
    );
    expect(replacementSubmitResponse.status).toBe(200);

    const updatedDeliverablesResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/organizer/deliverables`,
      { headers: organizerHeaders },
    );
    const updatedDeliverables = await jsonData<{
      items: Array<{
        task: { id: string };
        currentAsset?: { id: string; version: number; versionFamilyId: string };
      }>;
    }>(updatedDeliverablesResponse);
    expect(updatedDeliverablesResponse.status).toBe(200);
    expect(updatedDeliverables.items).toContainEqual(
      expect.objectContaining({
        task: expect.objectContaining({ id: uploadTask.id }),
        currentAsset: expect.objectContaining({
          id: replacement.asset.id,
          version: 2,
          versionFamilyId: upload.asset.versionFamilyId,
        }),
      }),
    );

    const downloadGrantResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/organizer/assets/${upload.asset.id}/download`,
      { method: "POST", headers: organizerHeaders },
    );
    const downloadGrant = await jsonData<{
      method: "GET";
      url: string;
      expiresAt: string;
    }>(downloadGrantResponse);
    expect(downloadGrantResponse.status).toBe(200);
    expect(downloadGrant).toMatchObject({ method: "GET" });
    expect(downloadGrant.url).toMatch(
      /^\/api\/speaker\/assets\/capabilities\/download\/[^/]+\/[^/]+$/u,
    );
    expect(downloadGrant.url).not.toMatch(/^https?:/u);

    const issuedAuditResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/organizer/assets/${upload.asset.id}/audit`,
      { headers: organizerHeaders },
    );
    const issuedAudit =
      await jsonData<Array<{ action: string; actorAccountId: string; requesterKind?: string }>>(
        issuedAuditResponse,
      );
    expect(issuedAuditResponse.status).toBe(200);
    expect(issuedAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "download_authorized",
          actorAccountId: "local-organizer",
          requesterKind: "organizer",
        }),
      ]),
    );

    const downloadResponse = await runtimeRequest(downloadGrant.url, {
      headers: organizerHeaders,
    });
    const downloadedBytes = new Uint8Array(await downloadResponse.arrayBuffer());
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe("application/pdf");
    expect([...downloadedBytes]).toEqual([...new TextEncoder().encode(fileBody)]);

    const consumedAuditResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/organizer/assets/${upload.asset.id}/audit`,
      { headers: organizerHeaders },
    );
    const consumedAudit =
      await jsonData<Array<{ action: string; actorAccountId: string; requesterKind?: string }>>(
        consumedAuditResponse,
      );
    expect(consumedAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "downloaded",
          actorAccountId: "local-organizer",
          requesterKind: "organizer",
        }),
      ]),
    );

    const replayResponse = await runtimeRequest(downloadGrant.url, {
      headers: organizerHeaders,
    });
    await errorResponse(replayResponse, 409, "CONFLICT");

    const reviewerDownloadResponse = await runtimeRequest(
      `/api/speaker/events/${eventId}/organizer/assets/${upload.asset.id}/download`,
      { method: "POST", headers: reviewerHeaders },
    );
    await errorResponse(reviewerDownloadResponse, 404, "NOT_FOUND");
  });
  it("fails closed outside local mode when provider configuration is absent", async () => {
    const response = await runtimeRequest(
      `/api/speaker/events/${eventId}/portal`,
      { headers: speakerHeaders },
      productionBindings,
    );
    const body = apiErrorSchema.parse(await response.json());

    expect(response.status).toBe(503);
    expect(["CONFIGURATION_ERROR", "INTEGRATION_UNAVAILABLE"]).toContain(body.error.code);
    expect(JSON.stringify(body)).not.toContain("local-speaker");
  });
});
