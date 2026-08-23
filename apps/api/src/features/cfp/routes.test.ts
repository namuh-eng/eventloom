import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { AuthAccessError, type AuthPrincipal } from "../auth/types";
import type { CfpForm, EventCfp, Submission } from "./model";
import type { CfpRouteService } from "./routes";
import { CfpError, type CfpService } from "./service";

const environment = { APP_ENV: "local", WEB_ORIGIN: "http://localhost:3000" };
const basePath = "/api/cfp/organizations/org_1/events/event_1";

const event: EventCfp = {
  id: "event_1",
  tenantId: "org_1",
  version: 1,
  slug: "future-conf",
  name: "Future Conf",
  timezone: "America/Los_Angeles",
  opensAt: "2026-08-01T07:00:00.000Z",
  closesAt: "2026-08-10T07:00:00.000Z",
};

const form: CfpForm = {
  id: "form_1",
  tenantId: "org_1",
  eventId: "event_1",
  name: "Main CFP",
  version: 1,
  status: "published",
  welcomeContent: "Welcome",
  settings: {
    speakerLimit: 3,
    maxSubmissionsPerAccount: 2,
    remindersEnabled: true,
    adminNotificationsEnabled: true,
    confirmationMessage: "Received",
    successContent: "Thank you",
  },
  sections: [{ id: "session", title: "Session", description: "Session details" }],
  submissionFields: [],
  participantFields: [],
  rules: [],
};

const submission: Submission = {
  id: "submission_1",
  tenantId: "org_1",
  eventId: "event_1",
  formId: "form_1",
  ownerAccountId: "applicant_1",
  formVersion: 1,
  version: 1,
  status: "draft",
  completedSteps: [],
  answers: {},
  participants: [],
  secondaryContacts: [],
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

type ServiceCall = { method: string; input: unknown };

class FakeCfpService implements CfpRouteService {
  readonly calls: ServiceCall[] = [];
  failure: CfpError | null = null;

  #record(method: string, input: unknown): void {
    if (this.failure) throw this.failure;
    this.calls.push({ method, input });
  }

  async saveEvent(input: unknown, expectedVersion: number | null): Promise<EventCfp> {
    this.#record("saveEvent", { input, expectedVersion });
    return structuredClone(input as EventCfp);
  }

  async saveForm(input: unknown, expectedVersion: number | null): Promise<CfpForm> {
    this.#record("saveForm", { input, expectedVersion });
    return structuredClone(input as CfpForm);
  }
  async saveConfiguration(
    input: Parameters<CfpService["saveConfiguration"]>[0],
  ): Promise<Awaited<ReturnType<CfpService["saveConfiguration"]>>> {
    this.#record("saveConfiguration", input);
    return {
      event: structuredClone(input.event as EventCfp),
      form: structuredClone(input.form as CfpForm),
    };
  }

  async publishForm(
    input: Parameters<CfpService["publishForm"]>[0],
  ): Promise<Awaited<ReturnType<CfpService["publishForm"]>>> {
    this.#record("publishForm", input);
    return { ...structuredClone(form), version: input.expectedVersion + 1, status: "published" };
  }

  async getPublishedCfp(
    input: Parameters<CfpService["getPublishedCfp"]>[0],
  ): Promise<Awaited<ReturnType<CfpService["getPublishedCfp"]>>> {
    this.#record("getPublishedCfp", input);
    return {
      organization: { id: "org_1", slug: "org-1", name: "Organization 1" },
      event: {
        id: event.id,
        slug: event.slug,
        name: event.name,
        timezone: event.timezone,
        opensAt: event.opensAt,
        closesAt: event.closesAt,
      },
      form: {
        ...structuredClone(form),
        status: "published",
        rules: [],
        settings: {
          speakerLimit: form.settings.speakerLimit,
          maxSubmissionsPerAccount: form.settings.maxSubmissionsPerAccount,
          confirmationMessage: form.settings.confirmationMessage,
          successContent: form.settings.successContent,
          ...(form.settings.redirectUrl === undefined
            ? {}
            : { redirectUrl: form.settings.redirectUrl }),
        },
      },
    };
  }
  async listOrganizerSubmissions(
    input: Parameters<CfpService["listOrganizerSubmissions"]>[0],
  ): Promise<Awaited<ReturnType<CfpService["listOrganizerSubmissions"]>>> {
    this.#record("listOrganizerSubmissions", input);
    return [
      {
        submission: structuredClone(submission),
        submissionFields: structuredClone(form.submissionFields),
        participantFields: structuredClone(form.participantFields),
      },
    ];
  }

  async createDraft(
    input: Parameters<CfpService["createDraft"]>[0],
  ): Promise<Awaited<ReturnType<CfpService["createDraft"]>>> {
    this.#record("createDraft", input);
    return structuredClone(submission);
  }

  async saveDraft(
    input: Parameters<CfpService["saveDraft"]>[0],
  ): Promise<Awaited<ReturnType<CfpService["saveDraft"]>>> {
    this.#record("saveDraft", input);
    return {
      ...structuredClone(submission),
      version: input.expectedVersion + 1,
      completedSteps: input.completedStep ? [input.completedStep] : [],
      participants: input.participants ? structuredClone(input.participants) : [],
      secondaryContacts: input.secondaryContacts ? structuredClone(input.secondaryContacts) : [],
    };
  }

  async review(
    input: Parameters<CfpService["review"]>[0],
  ): Promise<Awaited<ReturnType<CfpService["review"]>>> {
    this.#record("review", input);
    return {
      submissionId: input.submissionId,
      version: 2,
      canSubmit: true,
      issues: [],
      matchedRuleIds: [],
      routes: [],
    };
  }

  async submit(
    input: Parameters<CfpService["submit"]>[0],
  ): Promise<Awaited<ReturnType<CfpService["submit"]>>> {
    this.#record("submit", input);
    return {
      submission: {
        ...structuredClone(submission),
        version: input.expectedVersion + 1,
        status: "submitted",
        submittedAt: "2026-08-08T12:01:00.000Z",
      },
      confirmationQueued: true,
    };
  }
}

const principals = {
  organizer: {
    kind: "user",
    sessionId: "session_organizer",
    userId: "organizer_1",
    email: "organizer@example.com",
    memberships: [{ organizationId: "org_1", role: "admin" }],
    speakerGrants: [],
    reviewerGrants: [],
  },
  applicant: {
    kind: "user",
    sessionId: "session_applicant",
    userId: "applicant_1",
    email: "applicant@example.com",
    memberships: [],
    speakerGrants: [],
    reviewerGrants: [],
  },
  apiKey: {
    kind: "apiKey",
    apiKeyId: "key_1",
    organizationId: "org_1",
    scopes: ["submissions:write"],
  },
} as const satisfies Record<string, AuthPrincipal>;

function createFixture() {
  const service = new FakeCfpService();
  const app = createApp({
    authenticator: {
      authenticate: async (request) => {
        const credential = request.headers.get("authorization")?.replace("Bearer ", "");
        if (credential === "organizer") return principals.organizer;
        if (credential === "applicant") return principals.applicant;
        if (credential === "api-key") return principals.apiKey;
        throw new AuthAccessError("UNAUTHENTICATED", "Authentication is required.");
      },
    },
    cfp: { service },
  });
  return { app, service };
}

function requestHeaders(credential: string, idempotencyKey?: string): HeadersInit {
  return {
    authorization: `Bearer ${credential}`,
    "content-type": "application/json",
    ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
  };
}

describe("CFP API routes", () => {
  it("requires authentication whenever CFP routes are mounted", () => {
    expect(() => createApp({ cfp: { service: new FakeCfpService() } })).toThrow(
      "Authentication must be configured",
    );
  });

  it("lets organizers save tenant-bound event and form configuration", async () => {
    const { app, service } = createFixture();
    const eventResponse = await app.request(
      `${basePath}/config`,
      {
        method: "PUT",
        headers: requestHeaders("organizer"),
        body: JSON.stringify({ event, expectedVersion: 1 }),
      },
      environment,
    );
    const formResponse = await app.request(
      `${basePath}/forms/form_1`,
      {
        method: "PUT",
        headers: requestHeaders("organizer"),
        body: JSON.stringify({ form, expectedVersion: 1 }),
      },
      environment,
    );

    expect(eventResponse.status).toBe(200);
    await expect(eventResponse.json()).resolves.toMatchObject({ data: { id: "event_1" } });
    expect(formResponse.status).toBe(200);
    await expect(formResponse.json()).resolves.toMatchObject({ data: { id: "form_1" } });
    expect(service.calls.map((call) => call.method)).toEqual(["saveEvent", "saveForm"]);
  });
  it("saves aggregate configuration through the single conditional endpoint", async () => {
    const { app, service } = createFixture();
    const response = await app.request(
      `${basePath}/configuration`,
      {
        method: "PUT",
        headers: requestHeaders("organizer", "configuration-save"),
        body: JSON.stringify({
          event: { ...event, version: 2 },
          form: { ...form, version: 2 },
          expectedEventVersion: 1,
          expectedFormVersion: 1,
        }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { event: { version: 2 }, form: { version: 2 } },
    });
    expect(service.calls).toEqual([
      {
        method: "saveConfiguration",
        input: {
          event: { ...event, version: 2 },
          form: { ...form, version: 2 },
          expectedEventVersion: 1,
          expectedFormVersion: 1,
          idempotencyKey: "configuration-save",
        },
      },
    ]);
  });

  it("rejects incomplete aggregate configuration before calling the service", async () => {
    const { app, service } = createFixture();
    const response = await app.request(
      `${basePath}/configuration`,
      {
        method: "PUT",
        headers: requestHeaders("organizer", "configuration-invalid"),
        body: JSON.stringify({
          event,
          form,
          expectedEventVersion: 1,
        }),
      },
      environment,
    );

    expect(response.status).toBe(400);
    expect(service.calls).toEqual([]);
  });
  it("accepts a fully configured form with a URL field before publishing", async () => {
    const { app, service } = createFixture();
    const configuredForm = {
      ...form,
      status: "draft" as const,
      submissionFields: [
        {
          id: "proposal_website",
          sectionId: "session",
          key: "proposal_website",
          label: "Proposal website",
          kind: "url" as const,
          required: false,
          options: [],
        },
      ],
    };

    const response = await app.request(
      `${basePath}/forms/form_1`,
      {
        method: "PUT",
        headers: requestHeaders("organizer"),
        body: JSON.stringify({ form: configuredForm, expectedVersion: 1 }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    expect(service.calls).toEqual([
      { method: "saveForm", input: { input: configuredForm, expectedVersion: 1 } },
    ]);
  });

  it("publishes with optimistic concurrency and resolves the exact logged-out slug route", async () => {
    const { app, service } = createFixture();
    const publishResponse = await app.request(
      `${basePath}/forms/form_1/publish`,
      {
        method: "POST",
        headers: requestHeaders("organizer", "publish-form-1"),
        body: JSON.stringify({ expectedVersion: 4 }),
      },
      environment,
    );
    const publicResponse = await app.request(
      "/api/public/cfp/organizations/org_1/events/future-conf",
      { method: "GET" },
      environment,
    );

    expect(publishResponse.status).toBe(200);
    await expect(publishResponse.json()).resolves.toMatchObject({
      data: { id: "form_1", status: "published", version: 5 },
    });
    expect(publicResponse.status).toBe(200);
    await expect(publicResponse.json()).resolves.toMatchObject({
      data: { event: { slug: "future-conf" }, form: { id: "form_1", status: "published" } },
    });
    expect(service.calls).toEqual([
      {
        method: "publishForm",
        input: {
          tenantId: "org_1",
          eventId: "event_1",
          formId: "form_1",
          organizerId: "organizer_1",
          expectedVersion: 4,
          idempotencyKey: "publish-form-1",
        },
      },
      {
        method: "getPublishedCfp",
        input: { tenantId: "org_1", eventSlug: "future-conf" },
      },
    ]);
  });

  it("allows an organizer to persist a past close date without changing tenant scope", async () => {
    const { app, service } = createFixture();
    const pastEvent = {
      ...event,
      closesAt: "2026-08-05T07:00:00.000Z",
    };
    const response = await app.request(
      `${basePath}/config`,
      {
        method: "PUT",
        headers: requestHeaders("organizer"),
        body: JSON.stringify({ event: pastEvent, expectedVersion: 1 }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        tenantId: "org_1",
        closesAt: "2026-08-05T07:00:00.000Z",
      },
    });
    expect(service.calls).toEqual([
      { method: "saveEvent", input: { input: pastEvent, expectedVersion: 1 } },
    ]);
  });

  it("denies configuration writes to applicants and rejects cross-tenant bodies", async () => {
    const { app } = createFixture();
    const applicantResponse = await app.request(
      `${basePath}/config`,
      {
        method: "PUT",
        headers: requestHeaders("applicant"),
        body: JSON.stringify({ event, expectedVersion: 1 }),
      },
      environment,
    );
    const crossTenantResponse = await app.request(
      `${basePath}/config`,
      {
        method: "PUT",
        headers: requestHeaders("organizer"),
        body: JSON.stringify({ event: { ...event, tenantId: "org_2" }, expectedVersion: 1 }),
      },
      environment,
    );

    expect(applicantResponse.status).toBe(403);
    await expect(applicantResponse.json()).resolves.toMatchObject({
      error: { code: "ACCESS_DENIED" },
    });
    expect(crossTenantResponse.status).toBe(403);
    await expect(crossTenantResponse.json()).resolves.toMatchObject({
      error: { code: "ACCESS_DENIED" },
    });
  });

  it("creates an owner-bound draft and requires an idempotency key", async () => {
    const { app, service } = createFixture();
    const response = await app.request(
      `${basePath}/forms/form_1/drafts`,
      { method: "POST", headers: requestHeaders("applicant", "draft-create-1") },
      environment,
    );
    const missingKeyResponse = await app.request(
      `${basePath}/forms/form_1/drafts`,
      { method: "POST", headers: requestHeaders("applicant") },
      environment,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { id: "submission_1" } });
    expect(service.calls[0]).toEqual({
      method: "createDraft",
      input: {
        tenantId: "org_1",
        eventId: "event_1",
        formId: "form_1",
        ownerAccountId: "applicant_1",
        idempotencyKey: "draft-create-1",
      },
    });
    expect(missingKeyResponse.status).toBe(400);
    await expect(missingKeyResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", message: expect.stringContaining("Idempotency-Key") },
    });
  });

  it("exposes draft, participant, review, and submit operations without trusting actor ids", async () => {
    const { app, service } = createFixture();
    const draftResponse = await app.request(
      `${basePath}/submissions/submission_1/draft`,
      {
        method: "PATCH",
        headers: requestHeaders("applicant", "draft-save-1"),
        body: JSON.stringify({
          expectedVersion: 1,
          completedStep: "submission",
          answers: { title: "Reliable systems" },
        }),
      },
      environment,
    );
    const participantsResponse = await app.request(
      `${basePath}/submissions/submission_1/participants`,
      {
        method: "PUT",
        headers: requestHeaders("applicant", "participants-save-1"),
        body: JSON.stringify({
          expectedVersion: 2,
          participants: [
            {
              id: "participant_1",
              firstName: "Maya",
              lastName: "Chen",
              email: "maya@example.com",
              role: "primary",
              biography: "Speaker",
              answers: {},
            },
          ],
        }),
      },
      environment,
    );
    const reviewResponse = await app.request(
      `${basePath}/submissions/submission_1/review`,
      { method: "POST", headers: requestHeaders("applicant", "review-1") },
      environment,
    );
    const submitResponse = await app.request(
      `${basePath}/submissions/submission_1/submit`,
      {
        method: "POST",
        headers: requestHeaders("applicant", "submit-1"),
        body: JSON.stringify({ expectedVersion: 3, ownerAccountId: "attacker" }),
      },
      environment,
    );

    expect(draftResponse.status).toBe(200);
    expect(participantsResponse.status).toBe(200);
    expect(reviewResponse.status).toBe(200);
    expect(submitResponse.status).toBe(400);
    await expect(submitResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const validSubmitResponse = await app.request(
      `${basePath}/submissions/submission_1/submit`,
      {
        method: "POST",
        headers: requestHeaders("applicant", "submit-2"),
        body: JSON.stringify({ expectedVersion: 3 }),
      },
      environment,
    );
    expect(validSubmitResponse.status).toBe(200);
    await expect(validSubmitResponse.json()).resolves.toMatchObject({
      data: { submission: { status: "submitted" }, confirmationQueued: true },
    });
    expect(service.calls.map((call) => call.method)).toEqual([
      "saveDraft",
      "saveDraft",
      "review",
      "submit",
    ]);
    expect(service.calls[1]).toMatchObject({
      input: {
        ownerAccountId: "applicant_1",
        completedStep: "participant",
      },
    });
    expect(service.calls[3]).toMatchObject({ input: { ownerAccountId: "applicant_1" } });
  });

  it("rejects API keys and unauthenticated callers from applicant mutations", async () => {
    const { app } = createFixture();
    const apiKeyResponse = await app.request(
      `${basePath}/forms/form_1/drafts`,
      { method: "POST", headers: requestHeaders("api-key", "draft-1") },
      environment,
    );
    const unauthenticatedResponse = await app.request(
      `${basePath}/forms/form_1/drafts`,
      { method: "POST" },
      environment,
    );

    expect(apiKeyResponse.status).toBe(403);
    await expect(apiKeyResponse.json()).resolves.toMatchObject({
      error: { code: "ACCESS_DENIED" },
    });
    expect(unauthenticatedResponse.status).toBe(401);
    await expect(unauthenticatedResponse.json()).resolves.toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
  });

  it("maps CFP domain failures to the shared error envelope", async () => {
    const { app, service } = createFixture();
    service.failure = new CfpError(
      "SUBMISSION_LIMIT_REACHED",
      "The account has reached this form's submission limit.",
    );

    const response = await app.request(
      `${basePath}/forms/form_1/drafts`,
      {
        method: "POST",
        headers: {
          ...requestHeaders("applicant", "draft-limit-1"),
          "x-request-id": "2fb0c7a6-3ae4-449b-8c9c-1b2068524b02",
        },
      },
      environment,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONFLICT",
        message: "The account has reached this form's submission limit.",
        traceId: "2fb0c7a6-3ae4-449b-8c9c-1b2068524b02",
      },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("authorizes organizers and preserves the canonical organizer submissions envelope", async () => {
    const { app, service } = createFixture();
    const organizerResponse = await app.request(
      `${basePath}/submissions`,
      { method: "GET", headers: requestHeaders("organizer") },
      environment,
    );
    const applicantResponse = await app.request(
      `${basePath}/submissions`,
      { method: "GET", headers: requestHeaders("applicant") },
      environment,
    );

    expect(organizerResponse.status).toBe(200);
    await expect(organizerResponse.json()).resolves.toEqual({
      data: [
        {
          submission,
          submissionFields: [],
          participantFields: [],
        },
      ],
    });
    expect(service.calls).toEqual([
      {
        method: "listOrganizerSubmissions",
        input: { tenantId: "org_1", eventId: "event_1" },
      },
    ]);
    expect(applicantResponse.status).toBe(403);
    await expect(applicantResponse.json()).resolves.toMatchObject({
      error: { code: "ACCESS_DENIED" },
    });
  });
});
