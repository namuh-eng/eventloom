import { describe, expect, it, vi } from "vitest";
import { type ApiDependencies, createApp } from "../app";
import type { AgendaState } from "../features/agenda/types";
import type { CfpForm, EventCfp, Submission } from "../features/cfp/model";
import {
  CommunicationService,
  InMemoryCommunicationRepository,
  InMemoryReminderRepository,
} from "../features/communications/service";
import type { CommunicationActor, CommunicationRecipient } from "../features/communications/types";
import type { EvaluationDecisionProjectionInput } from "../features/evaluations/service";
import type {
  EventRoleInvitation,
  EventRoleInvitationRepository,
} from "../features/event-invitations/types";
import type { AirtableRequest, AirtableTransport } from "../infrastructure/airtable";
import { FakeAirtableTransport } from "../infrastructure/airtable";
import type { CloudflareOutboxMessage } from "../infrastructure/cloudflare/bindings";
import {
  AirtableAgendaRepository,
  AirtableCommunicationRepository,
  AirtableCrmRepository,
  AirtableEvaluationDecisionProjection,
  AirtableEvaluationProjectionStore,
  AirtableEvaluationReminderBoundary,
  AirtableEventRepository,
  AirtableRemixContentGateway,
  CloudflareCfpEffects,
  EVALUATION_REMINDER_ATTEMPTS_SQL,
  evaluationReminderAttemptKey,
  listProductionOrganizationsForUser,
} from "./airtable";
import { createLocalCfpService, seedLocalCfpForm } from "./cfp";
import {
  D1ApiKeyAuthenticatorGateway,
  D1BetterAuthGateway,
  inspectProductionRuntime,
  type RuntimeBindings,
  runtimeBindingsForEnvironment,
} from "./cloudflare";
import {
  AUTOMATIC_REMINDER_CRON,
  createRuntimeApp,
  createRuntimeWorker,
  EVALUATION_EXPORT_RECOVERY_CRON,
  runScheduledReminders,
  shouldRunScheduledReminders,
} from "./composition";
import { createRuntimeEventRoleInvitationAdapters } from "./d1";
import {
  createLocalDependencies,
  LOCAL_API_KEY,
  LOCAL_ORGANIZATION_ID,
  LOCAL_ORGANIZER_ACCOUNT_ID,
  LOCAL_ORGANIZER_EMAIL,
  LOCAL_REVIEWER_EMAIL,
  LOCAL_SESSION_TOKEN,
  LOCAL_SPEAKER_EMAIL,
  LOCAL_SPEAKER_SESSION_TOKEN,
} from "./local";

vi.setConfig({ testTimeout: 30_000 });

const localBindings: RuntimeBindings = {
  APP_ENV: "local",
  RUNTIME_PROFILE: "fixture",
  WEB_ORIGIN: "http://127.0.0.1:3015",
};
const testSenderAddresses = {
  auth: "auth@sessionboard.namuh.co",
  speakers: "speakers@sessionboard.namuh.co",
  calendar: "calendar@sessionboard.namuh.co",
} as const;
class FormulaRecordingTransport implements AirtableTransport {
  readonly fake = new FakeAirtableTransport();
  readonly requests: AirtableRequest[] = [];

  constructor(private readonly delayMs = 0) {}

  seed(record: Parameters<FakeAirtableTransport["seed"]>[0]): void {
    this.fake.seed(record);
  }

  async request<TBody = unknown>(request: AirtableRequest) {
    this.requests.push({
      ...request,
      ...(request.query === undefined ? {} : { query: { ...request.query } }),
    });
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
    const upsertRecords =
      request.method === "PATCH" && request.recordId === undefined
        ? (
            request.body as
              | {
                  readonly records?: readonly {
                    readonly fields?: Readonly<Record<string, unknown>>;
                  }[];
                }
              | undefined
          )?.records
        : undefined;
    if (upsertRecords !== undefined) {
      const listed = await this.fake.request<{
        readonly records: readonly {
          readonly id: string;
          readonly fields: Readonly<Record<string, unknown>>;
        }[];
      }>({
        method: "GET",
        baseId: request.baseId,
        table: request.table,
        query: { pageSize: 100 },
      });
      const mutations = upsertRecords.map((record) => {
        const fields = record.fields;
        const applicationId = fields?.["Application ID"];
        if (
          fields === undefined ||
          typeof applicationId !== "string" ||
          typeof fields["Scores JSON"] !== "string"
        ) {
          throw new TypeError("The evaluation batch upsert is invalid.");
        }
        return {
          fields,
          recordId: listed.body.records.find(
            (existing) => existing.fields["Application ID"] === applicationId,
          )?.id,
        };
      });
      const records = [];
      for (const mutation of mutations) {
        const response = await this.fake.request({
          method: mutation.recordId === undefined ? "POST" : "PATCH",
          baseId: request.baseId,
          table: request.table,
          ...(mutation.recordId === undefined ? {} : { recordId: mutation.recordId }),
          body: { fields: mutation.fields },
        });
        records.push(response.body);
      }
      return { status: 200, headers: {}, body: { records } as TBody };
    }
    const formula = request.query?.filterByFormula;
    if (typeof formula !== "string") return this.fake.request<TBody>(request);
    const delegatedFormula = formula.includes("FIND(")
      ? undefined
      : formula.startsWith("AND(")
        ? formula.slice(4, -1).split(",")[0]
        : formula;
    return this.fake.request<TBody>({
      ...request,
      query: {
        ...request.query,
        filterByFormula: delegatedFormula,
      },
    });
  }
}
function organizerHeaders(): HeadersInit {
  return { cookie: `better-auth.session_token=${LOCAL_SESSION_TOKEN}` };
}
function speakerHeaders(): HeadersInit {
  return { cookie: `better-auth.session_token=${LOCAL_SPEAKER_SESSION_TOKEN}` };
}
function productionD1(digest: string): NonNullable<RuntimeBindings["DB"]> {
  const row = {
    id: "key-production",
    organization_id: LOCAL_ORGANIZATION_ID,
    label: "Production test key",
    scopes_json: '["events:read","events:write","agenda:read","agenda:write"]',
    expires_at: null,
    revoked_at: null,
  };
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return query.includes("FROM api_keys") && values[0] === digest ? (row as T) : null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as NonNullable<RuntimeBindings["DB"]>;
}

function productionBindings(
  _transport: AirtableTransport,
  database: NonNullable<RuntimeBindings["DB"]>,
): RuntimeBindings {
  const coordinator = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch() {
          return Response.json({ revision: 0 });
        },
      };
    },
  } as unknown as NonNullable<RuntimeBindings["AGENDA_COORDINATOR"]>;
  const bucket = {
    head: async (objectKey: string) =>
      objectKey === "assets/marcus-accepted.pdf"
        ? { size: 256, httpMetadata: { contentType: "application/pdf" } }
        : null,
    get: async () => null,
    put: async () => undefined,
  } as unknown as NonNullable<RuntimeBindings["PRIVATE_FILES"]>;
  const queue = {
    async send() {},
  } as unknown as NonNullable<RuntimeBindings["OUTBOX_QUEUE"]>;
  return {
    APP_ENV: "production",
    WEB_ORIGIN: "https://web-production.example.test",
    API_ORIGIN: "https://api-production.example.test",
    DB: database,
    AGENDA_COORDINATOR: coordinator,
    PRIVATE_FILES: bucket,
    OUTBOX_QUEUE: queue,
    AIRTABLE_ACCESS_TOKEN: "test-token",
    AI: {
      async run() {
        return { response: "{}" };
      },
    },
    AI_MODEL: "@cf/meta/llama-3.1-8b-instruct-fp8",
    AIRTABLE_BASE_ID: "base-test",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
    OPENSEND_API_URL: "https://mail.production.example.test",
    OPENSEND_API_KEY: "opensend-test-key",
    AUTH_FROM_EMAIL: "login@production.example.test",
    SPEAKERS_FROM_EMAIL: "program@production.example.test",
    CALENDAR_FROM_EMAIL: "schedule@production.example.test",
    CALENDAR_UID_DOMAIN: "calendar.production.example.test",
    CACHE_INVALIDATION_URL: "https://web-production.example.test/api/internal/cache-invalidation",
    CACHE_INVALIDATION_TOKEN: "shared-cache-invalidation-token",
  };
}

interface AutojoinDatabaseState {
  readonly email: string;
  readonly name: string | null;
  readonly emailVerified: boolean;
  readonly memberships: Array<{ organization_id: string; role: string }>;
  readonly speakerGrants: Array<{
    organization_id: string;
    speaker_profile_id: string;
  }>;
  readonly reviewerGrants: Array<{
    organization_id: string;
    event_id: string;
  }>;
  readonly inserts: Array<{
    organization_id: string;
    user_id: string;
    role: string;
    created_at: string;
    updated_at: string;
  }>;
  readonly queries: string[];
  operationCount: number;
}

function autojoinDatabase(input: {
  readonly email: string;
  readonly name?: string | null;
  readonly emailVerified: boolean;
  readonly memberships?: readonly { organization_id: string; role: string }[];
  readonly pendingInvitation?: boolean;
  readonly speakerGrants?: readonly {
    organization_id: string;
    speaker_profile_id: string;
  }[];
  readonly reviewerGrants?: readonly {
    organization_id: string;
    event_id: string;
  }[];
  readonly delayMs?: number;
}): {
  readonly database: NonNullable<RuntimeBindings["DB"]>;
  readonly state: AutojoinDatabaseState;
} {
  const state: AutojoinDatabaseState = {
    email: input.email,
    name: input.name ?? null,
    emailVerified: input.emailVerified,
    memberships: [...(input.memberships ?? [])],
    speakerGrants: [...(input.speakerGrants ?? [])],
    reviewerGrants: [...(input.reviewerGrants ?? [])],
    inserts: [],
    queries: [],
    operationCount: 0,
  };
  const delayMs = input.delayMs ?? 0;
  async function delayOperation(): Promise<void> {
    state.operationCount += 1;
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const database = {
    prepare(query: string) {
      state.queries.push(query);
      return {
        async all<T>() {
          return this.bind().all<T>();
        },
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              await delayOperation();
              if (query.includes("FROM api_keys")) {
                return {
                  id: "api-key-autojoin",
                  organization_id: "ai-engineer",
                  label: "Autojoin test key",
                  scopes_json: '["events:read"]',
                  expires_at: null,
                  revoked_at: null,
                } as T;
              }
              if (!query.includes("FROM auth_sessions")) return null;
              return {
                session_id: "session-autojoin",
                user_id: "user-autojoin",
                email: state.email,
                name: state.name,
                email_verified: state.emailVerified ? 1 : 0,
                expires_at: "2099-01-01T00:00:00.000Z",
              } as T;
            },
            async all<T>() {
              await delayOperation();
              if (query.includes("FROM auth_sessions") && query.includes("scope_type")) {
                return {
                  results: [
                    {
                      session_id: "session-autojoin",
                      user_id: "user-autojoin",
                      email: state.email,
                      name: state.name,
                      email_verified: state.emailVerified ? 1 : 0,
                      expires_at: "2099-01-01T00:00:00.000Z",
                      scope_type: "session",
                      scope_order: 0,
                      organization_id: null,
                      role: null,
                      speaker_profile_id: null,
                    },
                    ...state.memberships.map((membership) => ({
                      session_id: "session-autojoin",
                      user_id: "user-autojoin",
                      email: state.email,
                      name: state.name,
                      email_verified: state.emailVerified ? 1 : 0,
                      expires_at: "2099-01-01T00:00:00.000Z",
                      scope_type: "membership",
                      scope_order: 1,
                      organization_id: membership.organization_id,
                      role: membership.role,
                      speaker_profile_id: null,
                    })),
                    ...(state.emailVerified
                      ? state.reviewerGrants.map((reviewerGrant) => ({
                          session_id: "session-autojoin",
                          user_id: "user-autojoin",
                          email: state.email,
                          name: state.name,
                          email_verified: 1,
                          expires_at: "2099-01-01T00:00:00.000Z",
                          scope_type: "reviewer_grant",
                          scope_order: 2,
                          organization_id: reviewerGrant.organization_id,
                          event_id: reviewerGrant.event_id,
                          role: null,
                          speaker_profile_id: null,
                        }))
                      : []),
                    ...state.speakerGrants.map((speakerGrant) => ({
                      session_id: "session-autojoin",
                      user_id: "user-autojoin",
                      email: state.email,
                      name: state.name,
                      email_verified: state.emailVerified ? 1 : 0,
                      expires_at: "2099-01-01T00:00:00.000Z",
                      scope_type: "speaker_grant",
                      scope_order: 3,
                      organization_id: speakerGrant.organization_id,
                      event_id: null,
                      role: null,
                      speaker_profile_id: speakerGrant.speaker_profile_id,
                    })),
                  ] as T[],
                };
              }
              if (query.includes("FROM organization_memberships")) {
                return { results: state.memberships as T[] };
              }
              if (query.includes("FROM speaker_grants")) {
                return { results: state.speakerGrants as T[] };
              }
              if (query.includes("FROM auth_verifications")) {
                return {
                  results: input.pendingInvitation
                    ? ([
                        {
                          id: "pending-invitation",
                          identifier: JSON.stringify({
                            kind: "member_invitation",
                            invitation: {
                              id: "pending-invitation",
                              organizationId: "ai-engineer",
                              userId: "user-autojoin",
                              email: input.email.trim().toLowerCase(),
                              name: "Pending Evaluator",
                              role: "reviewer",
                              idempotencyKey: "pending-autojoin",
                              status: "delivered",
                              createdAt: "2026-08-11T00:00:00.000Z",
                              updatedAt: "2026-08-11T00:00:01.000Z",
                              expiresAt: "2099-01-01T00:00:00.000Z",
                              deliveredAt: "2026-08-11T00:00:01.000Z",
                              acceptedAt: null,
                            },
                            activationDigest: null,
                            usedAt: null,
                          }),
                          token_digest: "random-pending-token-digest",
                          expires_at: "2099-01-01T00:00:00.000Z",
                          created_at: "2026-08-11T00:00:00.000Z",
                          updated_at: "2026-08-11T00:00:01.000Z",
                        },
                      ] as T[])
                    : ([] as T[]),
                };
              }
              return { results: [] as T[] };
            },
            async run() {
              await delayOperation();
              if (query.includes("INSERT INTO organization_memberships")) {
                const [organizationId, userId, createdAt, updatedAt] = values;
                const row = {
                  organization_id: String(organizationId),
                  user_id: String(userId),
                  role: "admin",
                  created_at: String(createdAt),
                  updated_at: String(updatedAt),
                };
                state.inserts.push(row);
                if (
                  !state.memberships.some(
                    (membership) =>
                      membership.organization_id === row.organization_id &&
                      row.user_id === "user-autojoin",
                  )
                ) {
                  state.memberships.push({
                    organization_id: row.organization_id,
                    role: row.role,
                  });
                }
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as NonNullable<RuntimeBindings["DB"]>;
  return { database, state };
}
interface CfpReceiptOutboxRow {
  readonly id: string;
  readonly tenantId: string;
  readonly topic: string;
  readonly deduplicationKey: string;
  readonly payloadJson: string;
  state: string;
}

function cfpReceiptDatabase(): {
  readonly database: NonNullable<RuntimeBindings["DB"]>;
  readonly rows: Map<string, CfpReceiptOutboxRow>;
} {
  const rows = new Map<string, CfpReceiptOutboxRow>();
  const database = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (query.includes("FROM auth_users")) {
                return { email: "verified.submitter@example.test" } as T;
              }
              if (query.includes("SELECT state FROM outbox_jobs")) {
                const row = rows.get(String(values[0]));
                return row === undefined ? null : ({ state: row.state } as T);
              }
              return null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (query.includes("INSERT INTO outbox_jobs")) {
                const [id, tenantId, topic, deduplicationKey, payloadJson] = values;
                const duplicate = [...rows.values()].some(
                  (row) =>
                    row.tenantId === String(tenantId) &&
                    row.topic === String(topic) &&
                    row.deduplicationKey === String(deduplicationKey),
                );
                if (duplicate) return { success: true, meta: { changes: 0 } };
                rows.set(String(id), {
                  id: String(id),
                  tenantId: String(tenantId),
                  topic: String(topic),
                  deduplicationKey: String(deduplicationKey),
                  payloadJson: String(payloadJson),
                  state: "pending",
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (query.includes("UPDATE outbox_jobs SET state = 'queued'")) {
                const row = rows.get(String(values[1]));
                if (row !== undefined) row.state = "queued";
                return {
                  success: true,
                  meta: { changes: row === undefined ? 0 : 1 },
                };
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as NonNullable<RuntimeBindings["DB"]>;
  return { database, rows };
}
describe("production CFP receipt effects", () => {
  it("queues one verified submitter receipt per submission version without calling OpenSend", async () => {
    const queueMessages: CloudflareOutboxMessage[] = [];
    const queue = {
      async send(message: CloudflareOutboxMessage) {
        queueMessages.push(message);
      },
    } as unknown as NonNullable<RuntimeBindings["OUTBOX_QUEUE"]>;
    const { database, rows } = cfpReceiptDatabase();
    const effects = new CloudflareCfpEffects(queue, database, testSenderAddresses);
    const event: EventCfp = {
      id: "event-cfp",
      tenantId: "tenant-cfp",
      version: 1,
      slug: "cfp-event",
      name: "Reliable Systems Summit",
      timezone: "UTC",
      opensAt: "2026-08-01T00:00:00.000Z",
      closesAt: "2026-09-01T00:00:00.000Z",
    };
    const form: CfpForm = {
      id: "form-cfp",
      tenantId: "tenant-cfp",
      eventId: "event-cfp",
      name: "Main CFP",
      version: 3,
      status: "published",
      welcomeContent: "",
      settings: {
        speakerLimit: 1,
        maxSubmissionsPerAccount: 1,
        remindersEnabled: false,
        adminNotificationsEnabled: false,
        confirmationMessage: "",
        successContent: "",
      },
      sections: [{ id: "section", title: "Talk", description: "" }],
      submissionFields: [],
      participantFields: [],
      rules: [],
    };
    const submission: Submission = {
      id: "submission-cfp",
      tenantId: "tenant-cfp",
      eventId: "event-cfp",
      formId: "form-cfp",
      ownerAccountId: "account-cfp",
      formVersion: 3,
      version: 7,
      status: "submitted",
      completedSteps: ["welcome", "account", "submission", "participant", "review"],
      answers: { title: "Idempotent Receipts" },
      participants: [
        {
          id: "participant-cfp",
          firstName: "Attacker",
          lastName: "Address",
          email: "unverified.form@example.test",
          role: "primary",
          biography: "",
          answers: {},
        },
      ],
      secondaryContacts: [],
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T01:00:00.000Z",
      submittedAt: "2026-08-08T01:00:00.000Z",
    };
    const input = {
      submission,
      form,
      event,
      submissionTitle: "Idempotent Receipts",
      idempotencyKey: "caller-key-is-not-authoritative",
    };

    await effects.enqueueSubmissionConfirmation(input);
    await effects.enqueueSubmissionConfirmation({
      ...input,
      idempotencyKey: "different-retry-key",
    });

    expect(rows).toHaveLength(1);
    const job = [...rows.values()][0];
    if (job === undefined) throw new Error("The CFP receipt outbox job was not persisted.");
    const payload = JSON.parse(job.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      from: "speakers@sessionboard.namuh.co",
      senderPurpose: "speakers",
      to: ["verified.submitter@example.test"],
      subject: "Submission received: Idempotent Receipts — Reliable Systems Summit",
      html: "<p>Your submission <strong>Idempotent Receipts</strong> for <strong>Reliable Systems Summit</strong> was received.</p>",
      text: 'Your submission "Idempotent Receipts" for Reliable Systems Summit was received.',
      idempotencyKey: "cfp-receipt:submission-cfp:v7",
    });
    expect(job).toMatchObject({
      tenantId: "tenant-cfp",
      topic: "communications",
      deduplicationKey: "cfp-receipt:submission-cfp:v7",
      state: "queued",
    });
    expect(queueMessages).toHaveLength(1);
    expect(queueMessages[0]).toMatchObject({
      version: 1,
      jobId: "runtime:tenant-cfp:communications:cfp-receipt:submission-cfp:v7",
      tenantId: "tenant-cfp",
      topic: "communications",
    });
    expect(JSON.stringify(payload)).not.toContain("foreverbrowsing.com");
    expect(JSON.stringify(payload)).not.toContain("unverified.form@example.test");
  });
});
describe("production authenticated tenant scope", () => {
  it("loads a valid session and scopes with one delayed D1 operation", async () => {
    const { database, state } = autojoinDatabase({
      email: "member@example.com",
      name: "  Dana Organizer  ",
      emailVerified: true,
      memberships: [{ organization_id: "org-membership", role: "reviewer" }],
      speakerGrants: [{ organization_id: "org-speaker", speaker_profile_id: "speaker-1" }],
      reviewerGrants: [],
      delayMs: 300,
    });
    const gateway = new D1BetterAuthGateway(database);
    const startedAt = Date.now();
    const session = await gateway.resolveSession("session-token");
    const elapsedMs = Date.now() - startedAt;

    expect(state.operationCount).toBe(1);
    expect(elapsedMs).toBeLessThanOrEqual(500);
    expect(session).toMatchObject({
      sessionId: "session-autojoin",
      userId: "user-autojoin",
      displayName: "Dana Organizer",
      email: "member@example.com",
      emailVerified: true,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      memberships: [{ organizationId: "org-membership", role: "reviewer" }],
      speakerGrants: [{ organizationId: "org-speaker", speakerProfileId: "speaker-1" }],
      reviewerGrants: [],
    });
    const scopeQuery = state.queries.find(
      (query) => query.includes("FROM auth_sessions") && query.includes("'speaker_grant'"),
    );
    expect(scopeQuery).toContain("invitations.recipient_user_id = grants.user_id");
    expect(scopeQuery).toContain("invitations.participant_id = grants.participant_id");
    expect(scopeQuery).toContain("invitations.status = 'accepted'");
    expect(scopeQuery).toContain("profiles.status <> 'revoked'");
    expect(scopeQuery).toContain("base.email_verified = 1");
  });
  it("does not synthesize a D1 session display name from email", async () => {
    const { database } = autojoinDatabase({
      email: "private-organizer@example.com",
      name: null,
      emailVerified: true,
      memberships: [{ organization_id: "org-membership", role: "admin" }],
    });

    const session = await new D1BetterAuthGateway(database).resolveSession("session-token");

    expect(session).not.toBeNull();
    expect(session).not.toHaveProperty("displayName");
    expect(session).toMatchObject({ email: "private-organizer@example.com" });
  });
  async function resolveSession(input: {
    readonly email: string;
    readonly emailVerified: boolean;
    readonly memberships?: readonly { organization_id: string; role: string }[];
    readonly pendingInvitation?: boolean;
    readonly speakerGrants?: readonly {
      organization_id: string;
      speaker_profile_id: string;
    }[];
    readonly reviewerGrants?: readonly {
      organization_id: string;
      event_id: string;
    }[];
  }) {
    const { database, state } = autojoinDatabase(input);
    const gateway = new D1BetterAuthGateway(database);
    const session = await gateway.resolveSession("session-token");
    return { session, state };
  }

  it("retains accepted reviewer access after a verified account email change", async () => {
    const { database, state } = autojoinDatabase({
      email: "reviewer-new@example.test",
      emailVerified: true,
      reviewerGrants: [{ organization_id: "org-reviewer", event_id: "event-reviewer" }],
    });
    const gateway = new D1BetterAuthGateway(database);

    await expect(gateway.resolveSession("session-token")).resolves.toMatchObject({
      email: "reviewer-new@example.test",
      reviewerGrants: [{ organizationId: "org-reviewer", eventId: "event-reviewer" }],
    });
    const scopeQuery = state.queries.find(
      (query) => query.includes("FROM auth_sessions") && query.includes("'reviewer_grant'"),
    );
    expect(scopeQuery).toContain("invitations.recipient_user_id = base.user_id");
    expect(scopeQuery).toContain("invitations.status = 'accepted'");
    expect(scopeQuery).toContain("base.email_verified = 1");
    expect(scopeQuery).not.toContain("invitations.normalized_email = base.email");
  });

  it("does not grant accepted reviewer access to a currently unverified account", async () => {
    const { database } = autojoinDatabase({
      email: "reviewer-new@example.test",
      emailVerified: false,
      reviewerGrants: [{ organization_id: "org-reviewer", event_id: "event-reviewer" }],
    });

    await expect(
      new D1BetterAuthGateway(database).resolveSession("session-token"),
    ).resolves.toMatchObject({
      reviewerGrants: [],
    });
  });

  it("does not derive an organization membership from the user's email domain", async () => {
    const input = {
      email: " Host@SWYX.IO ",
      emailVerified: true,
      speakerGrants: [{ organization_id: "ai-engineer", speaker_profile_id: "speaker-1" }],
      reviewerGrants: [],
    } as const;
    const { database, state } = autojoinDatabase(input);
    const gateway = new D1BetterAuthGateway(database);

    await expect(gateway.resolveSession("session-token")).resolves.toMatchObject({
      email: input.email,
      emailVerified: true,
      memberships: [],
      speakerGrants: [{ organizationId: "ai-engineer", speakerProfileId: "speaker-1" }],
      reviewerGrants: [],
    });
    expect(state.inserts).toHaveLength(0);
  });

  it("does not autojoin a verified evaluator while an invitation is unfinished", async () => {
    const { session, state } = await resolveSession({
      email: "evaluator@swyx.io",
      emailVerified: true,
      pendingInvitation: true,
    });

    expect(session?.memberships).toEqual([]);
    expect(state.inserts).toHaveLength(0);
  });

  it("preserves an existing organization role", async () => {
    const { session, state } = await resolveSession({
      email: "host@swyx.io",
      emailVerified: true,
      memberships: [{ organization_id: "ai-engineer", role: "reviewer" }],
    });

    expect(session?.memberships).toEqual([{ organizationId: "ai-engineer", role: "reviewer" }]);
    expect(state.inserts).toHaveLength(0);
    const owner = await resolveSession({
      email: "owner@swyx.io",
      emailVerified: true,
      memberships: [{ organization_id: "ai-engineer", role: "owner" }],
    });
    expect(owner.session?.memberships).toEqual([{ organizationId: "ai-engineer", role: "owner" }]);
    expect(owner.state.inserts).toHaveLength(0);
  });

  it("denies unverified, subdomain, lookalike, and other-domain sessions", async () => {
    const cases = [
      { email: "host@swyx.io", emailVerified: false },
      { email: "host@sub.swyx.io", emailVerified: true },
      { email: "host@swyx.io.attacker", emailVerified: true },
      { email: "host@example.com", emailVerified: true },
    ] as const;

    for (const input of cases) {
      const { session, state } = await resolveSession(input);
      expect(session?.memberships).toEqual([]);
      expect(state.inserts).toHaveLength(0);
    }
  });
  it("does not autojoin API key credentials", async () => {
    const { database, state } = autojoinDatabase({
      email: "host@swyx.io",
      emailVerified: true,
    });
    const gateway = new D1ApiKeyAuthenticatorGateway(database);

    await expect(gateway.findByPresentedKey("api-key")).resolves.toMatchObject({
      organizationId: "ai-engineer",
    });
    expect(state.inserts).toHaveLength(0);
  });
  it("does not autojoin verified sessions when the policy is disabled", async () => {
    const { database, state } = autojoinDatabase({
      email: "host@swyx.io",
      emailVerified: true,
    });
    const gateway = new D1BetterAuthGateway(database);

    await expect(gateway.resolveSession("session-token")).resolves.toMatchObject({
      email: "host@swyx.io",
      memberships: [],
    });
    expect(state.inserts).toHaveLength(0);
  });

  it("accepts integrated runtime configuration without tenant autojoin settings", () => {
    const bindings = productionBindings(new FakeAirtableTransport(), productionD1("unused"));
    expect(inspectProductionRuntime(bindings).success).toBe(true);
    expect(() => createRuntimeApp(bindings)).not.toThrow();
  });

  it("boots production D1 authority without legacy Airtable business credentials", () => {
    const bindings = productionBindings(new FakeAirtableTransport(), productionD1("unused"));
    const {
      AIRTABLE_ACCESS_TOKEN: _airtableAccessToken,
      AIRTABLE_BASE_ID: _airtableBaseId,
      ...d1Only
    } = bindings;

    expect(inspectProductionRuntime(d1Only).success).toBe(true);
    expect(() => createRuntimeApp(d1Only)).not.toThrow();
  });
});

describe("integrated local runtime composition", () => {
  function bindingsFor(transport: AirtableTransport): RuntimeBindings {
    return {
      ...productionBindings(transport, productionD1("unused")),
      APP_ENV: "local",
      RUNTIME_PROFILE: "integrated",
      WEB_ORIGIN: "http://127.0.0.1:3015",
      API_ORIGIN: "http://127.0.0.1:8787",
      AIRTABLE_BASE_ID: "production-base-must-not-be-used",
      AIRTABLE_BASE_DEV_ID: "development-base",
      BETTER_AUTH_SECRET: "production-secret-must-not-be-used",
      OPENSEND_API_URL: "http://127.0.0.1:8026",
      OPENSEND_API_KEY: "local-development",
      AUTH_FROM_EMAIL: "login@local.example.test",
      SPEAKERS_FROM_EMAIL: "program@local.example.test",
      CALENDAR_FROM_EMAIL: "schedule@local.example.test",
      CALENDAR_UID_DOMAIN: "calendar.local.example.test",
    };
  }

  it("keeps local OpenSend and identity values explicit instead of replacing them with provider defaults", () => {
    const bindings = bindingsFor(new FakeAirtableTransport());
    const effective = runtimeBindingsForEnvironment(bindings);

    expect(effective).toMatchObject({
      OPENSEND_API_URL: "http://127.0.0.1:8026",
      OPENSEND_API_KEY: "local-development",
      AUTH_FROM_EMAIL: "login@local.example.test",
      SPEAKERS_FROM_EMAIL: "program@local.example.test",
      CALENDAR_FROM_EMAIL: "schedule@local.example.test",
      CALENDAR_UID_DOMAIN: "calendar.local.example.test",
    });
  });

  it("boots local D1 authority without AIRTABLE_BASE_DEV_ID", () => {
    const bindings = bindingsFor(new FakeAirtableTransport());
    const { AIRTABLE_BASE_DEV_ID: _developmentBase, ...withoutDevelopmentBase } = bindings;
    const inspection = inspectProductionRuntime(withoutDevelopmentBase);

    expect(inspection.success).toBe(true);
    expect(inspection.issues).not.toContain(
      "AIRTABLE_BASE_DEV_ID is required for integrated local development",
    );
    expect(() => createRuntimeApp(withoutDevelopmentBase)).not.toThrow();
  });
});

describe("event invitation runtime composition", () => {
  it("persists pending reviewer invitations when a reviewer pool is saved", async () => {
    const dependencies = createLocalDependencies();
    const members = dependencies.members?.service;
    const invitations = dependencies.eventInvitations?.service;
    expect(members).toBeDefined();
    expect(invitations).toBeDefined();
    if (members === undefined || invitations === undefined) return;

    await members.setReviewerPool(
      {
        kind: "user",
        organizationId: LOCAL_ORGANIZATION_ID,
        userId: LOCAL_ORGANIZER_ACCOUNT_ID,
        role: "owner",
      },
      {
        organizationId: LOCAL_ORGANIZATION_ID,
        eventId: "open-sessionboard-conf",
        roundId: "runtime-composition-round",
        reviewerIds: ["local-reviewer"],
        maxAssignmentsPerReviewer: 2,
      },
    );

    await expect(
      invitations.list({
        kind: "user",
        userId: "local-reviewer",
        email: LOCAL_REVIEWER_EMAIL,
        emailVerified: true,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: LOCAL_ORGANIZATION_ID,
          eventId: "open-sessionboard-conf",
          role: "reviewer",
          status: "pending",
        }),
      ]),
    );
  });

  it("persists a pending invitation before sending a speaker welcome message", async () => {
    const dependencies = createLocalDependencies();
    const speakers = dependencies.speaker?.service;
    const invitations = dependencies.eventInvitations?.service;
    expect(speakers).toBeDefined();
    expect(invitations).toBeDefined();
    if (speakers === undefined || invitations === undefined) return;

    await speakers.createOrganizerSpeaker({
      organizationId: LOCAL_ORGANIZATION_ID,
      eventId: "demo-event",
      accountId: LOCAL_ORGANIZER_ACCOUNT_ID,
      displayName: "Review Speaker",
      email: LOCAL_REVIEWER_EMAIL,
      jobTitle: "Reviewer",
      company: "Runtime Test",
      biography: "Validates runtime invitation composition.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "runtime-composition-speaker",
      sourceType: "manual",
      sourceId: "runtime-composition-speaker",
      explicitParticipantId: "local-invitation-participant",
    });
    await speakers.sendOrganizerSpeakerInvitations({
      organizationId: LOCAL_ORGANIZATION_ID,
      eventId: "demo-event",
      accountId: LOCAL_ORGANIZER_ACCOUNT_ID,
      participantIds: ["local-invitation-participant"],
      templateId: "speaker-approved-welcome",
      idempotencyKey: "runtime-composition-speaker-send",
    });

    await expect(
      invitations.list({
        kind: "user",
        userId: "local-reviewer",
        email: LOCAL_REVIEWER_EMAIL,
        emailVerified: true,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: "demo-event",
          role: "speaker",
          status: "pending",
        }),
      ]),
    );
  });

  it("reconciles late verification before listing through the runtime adapter", async () => {
    let reconciled = false;
    const invitation: EventRoleInvitation = {
      id: "late-verification-invitation",
      organizationId: "org-late",
      organizationName: "Late Organization",
      eventId: "event-late",
      eventName: "Late Event",
      role: "reviewer",
      recipientUserId: "late-user",
      recipientEmail: "verified-late@example.test",
      normalizedEmail: "verified-late@example.test",
      participantId: null,
      status: "pending",
      version: 1,
      createdBy: null,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
    };
    const repository = {
      async create() {
        return invitation;
      },
      async reconcileForVerifiedAccount(input) {
        expect(input).toMatchObject({
          recipientUserId: "late-user",
          normalizedEmail: "verified-late@example.test",
        });
        reconciled = true;
      },
      async listForVerifiedAccount() {
        return reconciled ? [invitation] : [];
      },
      async findForVerifiedAccount() {
        return null;
      },
      async accept() {
        return null;
      },
      async decline() {
        return null;
      },
      async listAcceptedReviewerEventIds() {
        return [];
      },
      async revokeReviewerInvitationsForOrganizationUser() {
        return 0;
      },
      async revokeEventReviewerInvitationIfNoPoolGrantsRemain() {
        return false;
      },
    } satisfies EventRoleInvitationRepository;
    const adapters = createRuntimeEventRoleInvitationAdapters(repository, {
      clock: () => new Date("2026-08-16T01:00:00.000Z"),
    });

    await expect(
      adapters.service.list({
        kind: "user",
        userId: "late-user",
        email: "verified-late@example.test",
        emailVerified: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        invitationId: "late-verification-invitation",
        role: "reviewer",
        status: "pending",
      }),
    ]);
    expect(reconciled).toBe(true);
  });

  it("resolves accepted reviewer organizations after a verified email change", async () => {
    let query = "";
    let values: readonly unknown[] = [];
    const database = {
      prepare(statement: string) {
        query = statement;
        return {
          bind(...bound: unknown[]) {
            values = bound;
            return {
              async all<T>() {
                return {
                  results: [
                    { organization_id: "org-accepted", name: "Accepted Organization" },
                  ] as T[],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(listProductionOrganizationsForUser(database, "reviewer-user")).resolves.toEqual([
      { organizationId: "org-accepted", name: "Accepted Organization" },
    ]);
    expect(values).toEqual(["reviewer-user", "reviewer-user", "reviewer-user"]);
    expect(query).toContain("invitation.recipient_user_id = ?");
    expect(query).toContain("invitation.role = 'reviewer'");
    expect(query).toContain("invitation.status = 'accepted'");
    expect(query).toContain("account.email_verified = 1");
    expect(query).not.toContain("account.email = invitation.normalized_email");
  });

  it("refuses to expose acceptance when the repository lacks an accept adapter", () => {
    const incomplete = {
      create: async () => {
        throw new Error("unused");
      },
      reconcileForVerifiedAccount: async () => undefined,
      listForVerifiedAccount: async () => [],
      findForVerifiedAccount: async () => null,
      decline: async () => null,
      listAcceptedReviewerEventIds: async () => [],
      revokeReviewerInvitationsForOrganizationUser: async () => 0,
      revokeEventReviewerInvitationIfNoPoolGrantsRemain: async () => false,
    } satisfies EventRoleInvitationRepository;

    expect(() => createRuntimeEventRoleInvitationAdapters(incomplete)).toThrow(
      "The event invitation repository is missing accept.",
    );
    const { reconcileForVerifiedAccount: _reconcileForVerifiedAccount, ...withoutReconciliation } =
      {
        ...incomplete,
        accept: async () => null,
      };
    expect(() => createRuntimeEventRoleInvitationAdapters(withoutReconciliation)).toThrow(
      "The event invitation repository is missing reconcileForVerifiedAccount.",
    );
  });
});

describe("fixture local runtime composition", () => {
  it("serves health and a seeded speaker portal without external credentials", async () => {
    const app = createRuntimeApp(localBindings);

    const health = await app.request("/api/health", undefined, localBindings);
    const portal = await app.request(
      "/api/speaker/events/demo-event/portal",
      { headers: speakerHeaders() },
      localBindings,
    );

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      environment: "local",
    });
    expect(portal.status).toBe(200);
    await expect(portal.json()).resolves.toMatchObject({
      data: {
        outstandingTaskCount: 1,
        submissions: [{ id: "submission_local_1", status: "accepted" }],
        profiles: [{ participantId: "local-participant", displayName: "Alex Rivera" }],
      },
    });

    const [contexts, accessContexts, speakerTasks] = await Promise.all([
      app.request("/api/speaker/portal/contexts", { headers: speakerHeaders() }, localBindings),
      app.request("/api/account/access-contexts", { headers: speakerHeaders() }, localBindings),
      app.request(
        `/api/account/speaker-tasks?organizationId=${LOCAL_ORGANIZATION_ID}&eventId=demo-event`,
        { headers: speakerHeaders() },
        localBindings,
      ),
    ]);
    expect(contexts.status).toBe(200);
    await expect(contexts.json()).resolves.toMatchObject({
      data: [
        {
          eventId: "demo-event",
          submissionIds: ["submission_local_1"],
          participantIds: ["local-participant"],
          primaryParticipantId: "local-participant",
        },
      ],
    });
    expect(accessContexts.status).toBe(200);
    await expect(accessContexts.json()).resolves.toMatchObject({
      data: [
        { scope: "organization", organization: { id: LOCAL_ORGANIZATION_ID } },
        {
          scope: "event",
          organization: { id: LOCAL_ORGANIZATION_ID },
          event: { id: "demo-event" },
          roles: ["speaker"],
          capabilities: ["speaker.portal.read", "speaker.tasks.read"],
        },
      ],
    });
    expect(speakerTasks.status).toBe(200);
    await expect(speakerTasks.json()).resolves.toMatchObject({
      data: {
        organizationId: LOCAL_ORGANIZATION_ID,
        eventId: "demo-event",
        tasks: [
          {
            taskId: "local-speaker-id-1",
            title: "Upload your presentation slides",
            status: "not_started",
          },
        ],
      },
    });
  });
  it("previews the approved invitation for the seeded roster participant", async () => {
    const dependencies = createLocalDependencies();
    const speaker = dependencies.speaker?.service;
    expect(speaker).toBeDefined();
    if (speaker === undefined) return;

    await expect(
      speaker.previewOrganizerSpeakerInvitations(
        LOCAL_ORGANIZATION_ID,
        "demo-event",
        LOCAL_ORGANIZER_ACCOUNT_ID,
        ["local-participant"],
      ),
    ).resolves.toEqual([
      {
        participantId: "local-participant",
        recipientEmail: LOCAL_SPEAKER_EMAIL,
        state: "ready",
      },
    ]);
  });
  it("projects submitted CFP proposals into the submitting account portal", async () => {
    const dependencies = createLocalDependencies();
    const cfp = dependencies.cfp?.service;
    const speaker = dependencies.speaker?.service;
    expect(cfp).toBeDefined();
    expect(speaker).toBeDefined();
    if (cfp === undefined || speaker === undefined) return;

    const draft = await cfp.createDraft({
      tenantId: LOCAL_ORGANIZATION_ID,
      eventId: "demo-event",
      formId: "main-cfp",
      ownerAccountId: LOCAL_ORGANIZER_ACCOUNT_ID,
      idempotencyKey: "organizer-portal-draft",
    });
    let version = draft.version;
    for (const [index, completedStep] of (
      ["welcome", "account", "submission"] as const
    ).entries()) {
      const saved = await cfp.saveDraft({
        tenantId: LOCAL_ORGANIZATION_ID,
        eventId: "demo-event",
        submissionId: draft.id,
        ownerAccountId: LOCAL_ORGANIZER_ACCOUNT_ID,
        expectedVersion: version,
        completedStep,
        ...(completedStep === "submission"
          ? {
              answers: {
                title: "Testing submission",
                abstract: "A proposal submitted through the public CFP.",
                format: "Workshop",
                level: "Intermediate",
                track: "Platform & Infrastructure",
              },
            }
          : {}),
        idempotencyKey: `organizer-portal-step-${index}`,
      });
      version = saved.version;
    }
    const participantSaved = await cfp.saveDraft({
      tenantId: LOCAL_ORGANIZATION_ID,
      eventId: "demo-event",
      submissionId: draft.id,
      ownerAccountId: LOCAL_ORGANIZER_ACCOUNT_ID,
      expectedVersion: version,
      completedStep: "participant",
      participants: [
        {
          id: "organizer-cfp-participant",
          firstName: "Speaker",
          lastName: "Applicant",
          email: LOCAL_ORGANIZER_EMAIL,
          role: "primary",
          biography: "",
          answers: {},
        },
      ],
      secondaryContacts: [],
      idempotencyKey: "organizer-portal-participant",
    });
    const reviewSaved = await cfp.saveDraft({
      tenantId: LOCAL_ORGANIZATION_ID,
      eventId: "demo-event",
      submissionId: draft.id,
      ownerAccountId: LOCAL_ORGANIZER_ACCOUNT_ID,
      expectedVersion: participantSaved.version,
      completedStep: "review",
      idempotencyKey: "organizer-portal-review-step",
    });
    const submitted = await cfp.submit({
      tenantId: LOCAL_ORGANIZATION_ID,
      eventId: "demo-event",
      submissionId: draft.id,
      ownerAccountId: LOCAL_ORGANIZER_ACCOUNT_ID,
      expectedVersion: reviewSaved.version,
      idempotencyKey: "organizer-portal-submit",
    });

    const contexts = await speaker.listPortalContexts(LOCAL_ORGANIZER_ACCOUNT_ID);
    expect(contexts).toMatchObject([
      {
        eventId: "demo-event",
        submissionIds: [submitted.submission.id],
        participantIds: ["organizer-cfp-participant"],
      },
    ]);
    const portal = await speaker.getPortal("demo-event", LOCAL_ORGANIZER_ACCOUNT_ID);
    expect(portal.submissions).toMatchObject([
      {
        id: submitted.submission.id,
        title: "Testing submission",
        status: "submitted",
      },
    ]);
  });
  it("serves the seeded canonical submission list to its organization organizer", async () => {
    const app = createRuntimeApp(localBindings);
    const response = await app.request(
      `/api/cfp/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/submissions`,
      { headers: organizerHeaders() },
      localBindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{
        submission: {
          tenantId: string;
          eventId: string;
          ownerAccountId: string;
        };
      }>;
    };
    expect(body.data).toHaveLength(300);
    expect(body.data[0]).toMatchObject({
      submission: {
        tenantId: LOCAL_ORGANIZATION_ID,
        eventId: "demo-event",
        ownerAccountId: expect.any(String),
      },
    });
  });
  it("serves the organizer overview core and activity from local repositories", async () => {
    const app = createRuntimeApp(localBindings);
    const coreResponse = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/overview/core`,
      { headers: organizerHeaders() },
      localBindings,
    );
    const activityResponse = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/overview/activity`,
      { headers: organizerHeaders() },
      localBindings,
    );

    expect(coreResponse.status).toBe(200);
    expect(activityResponse.status).toBe(200);
    expect(coreResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(activityResponse.headers.get("cache-control")).toBe("private, no-store");

    const coreBody = (await coreResponse.json()) as { data: Record<string, unknown> };
    expect(coreBody).toMatchObject({
      data: {
        organizationId: LOCAL_ORGANIZATION_ID,
        metrics: { eventCount: 2 },
        events: [
          { id: "demo-event", name: "Open Sessionboard Conference" },
          {
            id: "open-sessionboard-conf",
            name: "Eventloom Conference",
          },
        ],
      },
    });
    expect(coreBody.data).not.toHaveProperty("actionItems");
    expect(coreBody.data.metrics).not.toHaveProperty("submissionCount");

    const activityBody = (await activityResponse.json()) as { data: Record<string, unknown> };
    expect(activityBody).toMatchObject({
      data: {
        organizationId: LOCAL_ORGANIZATION_ID,
        metrics: {
          submissionCount: 300,
          pendingReviewCount: 1,
          outstandingSpeakerTaskCount: 75,
          publishedSessionCount: 2,
        },
        actionItems: [
          { id: "reviews:demo-event", count: 1 },
          { id: "speaker_tasks:demo-event", count: 75 },
          { id: "agenda:demo-event", count: 73 },
        ],
      },
    });
    expect(activityBody.data).not.toHaveProperty("events");
    expect(activityBody.data.metrics).not.toHaveProperty("eventCount");

    const legacyResponse = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/overview`,
      { headers: organizerHeaders() },
      localBindings,
    );
    expect(legacyResponse.status).toBe(404);
  });
  it("serves seeded integration admin data for the current organizer workspace", async () => {
    const app = createRuntimeApp(localBindings);
    const response = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/integrations`,
      { headers: organizerHeaders() },
      localBindings,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        event: { id: string; name: string; timeZone: string };
        delivery: {
          openSend: { state: string; deliveredLast24Hours: number };
          calendar: { state: string; sentLast24Hours: number };
        };
        apiKeys: readonly { id: string }[];
        webhooks: readonly { id: string; endpointUrl: string }[];
      };
    };
    expect(body.data.event).toEqual({
      id: "demo-event",
      name: "Open Sessionboard Conference",
      timeZone: "America/Los_Angeles",
      publishedAgendaRevisionId: expect.stringMatching(/^revision_local_/u),
    });
    expect(body.data.delivery).toMatchObject({
      openSend: { state: "connected", deliveredLast24Hours: 18 },
      calendar: { state: "degraded", sentLast24Hours: 7 },
    });
    expect(body.data.apiKeys).toEqual([
      expect.objectContaining({
        id: "local-key-demo-event",
        label: "Local integration client",
      }),
    ]);
    expect(body.data.webhooks).toEqual([
      expect.objectContaining({
        id: "local-webhook-demo",
        endpointUrl: "https://hooks.local.eventloom.test/demo",
      }),
    ]);
    expect(body.data).not.toHaveProperty("accelevents");

    const anonymous = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/integrations`,
      undefined,
      localBindings,
    );
    expect(anonymous.status).toBe(401);

    const organizationKeys = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/api-keys`,
      { headers: organizerHeaders() },
      localBindings,
    );
    expect(organizationKeys.status).toBe(200);
    await expect(organizationKeys.json()).resolves.toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ id: "local-key-demo-event" })]),
    });

    const credential = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/integrations/opensend/credential`,
      {
        method: "PUT",
        headers: { ...organizerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ secret: "replacement-open-send-key" }),
      },
      localBindings,
    );
    expect(credential.status).toBe(204);

    const createdKey = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/api-keys`,
      {
        method: "POST",
        headers: { ...organizerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          label: "QA client",
          scopes: ["events:read"],
          expiresAt: null,
        }),
      },
      localBindings,
    );
    expect(createdKey.status).toBe(201);
    const createdKeyBody = (await createdKey.json()) as {
      data: { id: string; secret: string };
    };
    expect(createdKeyBody.data).toMatchObject({ id: "local-created-key-1" });
    expect(createdKeyBody.data.secret.length).toBeGreaterThan(32);

    const revokedKey = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/api-keys/${createdKeyBody.data.id}`,
      { method: "DELETE", headers: organizerHeaders() },
      localBindings,
    );
    expect(revokedKey.status).toBe(204);

    const createdWebhook = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/webhooks`,
      {
        method: "POST",
        headers: { ...organizerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          endpointUrl: "https://hooks.local.eventloom.test/qa",
          events: ["agenda.published"],
        }),
      },
      localBindings,
    );
    expect(createdWebhook.status).toBe(201);
    const createdWebhookBody = (await createdWebhook.json()) as {
      data: { id: string; secret: string };
    };
    expect(createdWebhookBody.data.secret.length).toBeGreaterThan(32);

    const pausedWebhook = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/webhooks/${createdWebhookBody.data.id}`,
      {
        method: "PATCH",
        headers: { ...organizerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ active: false }),
      },
      localBindings,
    );
    expect(pausedWebhook.status).toBe(204);

    const rotatedWebhook = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/webhooks/${createdWebhookBody.data.id}/rotate-secret`,
      {
        method: "POST",
        headers: { ...organizerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      localBindings,
    );
    expect(rotatedWebhook.status).toBe(200);

    const deletedWebhook = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/webhooks/${createdWebhookBody.data.id}`,
      { method: "DELETE", headers: organizerHeaders() },
      localBindings,
    );
    expect(deletedWebhook.status).toBe(204);

    const retry = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/integrations/calendar/deliveries/calendar-local-failure-demo-event/retry`,
      {
        method: "POST",
        headers: { ...organizerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      localBindings,
    );
    expect(retry.status).toBe(204);

    const refreshed = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/integrations`,
      { headers: organizerHeaders() },
      localBindings,
    );
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      data: {
        delivery: {
          openSend: { credentialLastFour: "-key" },
          calendar: { state: "connected", lastFailure: null },
        },
        apiKeys: expect.arrayContaining([
          expect.objectContaining({
            id: "local-created-key-1",
            revokedAt: expect.any(String),
          }),
        ]),
        webhooks: [expect.objectContaining({ id: "local-webhook-demo" })],
      },
    });
  });

  it("returns a private 404 for mismatched and legacy integration scopes", async () => {
    const app = createRuntimeApp(localBindings);
    const mismatched = await app.request(
      "/api/admin/organizations/another-organization/events/demo-event/integrations",
      { headers: organizerHeaders() },
      localBindings,
    );
    expect(mismatched.status).toBe(404);
    await expect(mismatched.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND", message: "The event was not found." },
    });

    const legacy = await app.request(
      "/api/admin/events/demo-event/integrations",
      { headers: organizerHeaders() },
      localBindings,
    );
    expect(legacy.status).toBe(404);
  });

  it("denies anonymous, reviewer, and wrong-tenant organizer overview access", async () => {
    const app = createRuntimeApp(localBindings);
    const suffixes = ["core", "activity"] as const;
    const basePath = `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/overview`;
    const anonymous = await Promise.all(
      suffixes.map((suffix) => app.request(`${basePath}/${suffix}`, undefined, localBindings)),
    );
    const wrongTenant = await Promise.all(
      suffixes.map((suffix) =>
        app.request(
          `/api/admin/organizations/another-organization/overview/${suffix}`,
          { headers: organizerHeaders() },
          localBindings,
        ),
      ),
    );
    const reviewerApp = createApp({
      authenticator: {
        authenticate: async () => ({
          kind: "user" as const,
          sessionId: "reviewer-session",
          userId: "reviewer",
          email: "reviewer@example.test",
          memberships: [
            {
              organizationId: LOCAL_ORGANIZATION_ID,
              role: "reviewer" as const,
            },
          ],
          speakerGrants: [],
          reviewerGrants: [],
        }),
      },
      organizerOverview: {
        getOverviewCore: async (organizationId: string) => ({
          organizationId,
          metrics: { eventCount: 0 },
          events: [],
        }),
        getOverviewActivity: async (organizationId: string) => ({
          organizationId,
          metrics: {
            submissionCount: 0,
            pendingReviewCount: 0,
            outstandingSpeakerTaskCount: 0,
            publishedSessionCount: 0,
          },
          actionItems: [],
        }),
      },
    });
    const reviewer = await Promise.all(
      suffixes.map((suffix) =>
        reviewerApp.request(`${basePath}/${suffix}`, undefined, localBindings),
      ),
    );

    expect(anonymous.map((response) => response.status)).toEqual([401, 401]);
    expect(wrongTenant.map((response) => response.status)).toEqual([403, 403]);
    expect(reviewer.map((response) => response.status)).toEqual([403, 403]);
  });

  it("keeps core overview independent from activity failures", async () => {
    let coreCalls = 0;
    let activityCalls = 0;
    const app = createApp({
      authenticator: {
        authenticate: async () => ({
          kind: "user" as const,
          sessionId: "overview-session",
          userId: "owner",
          email: "owner@example.test",
          memberships: [{ organizationId: "organization-1", role: "owner" as const }],
          speakerGrants: [],
          reviewerGrants: [],
        }),
      },
      organizerOverview: {
        getOverviewCore: async (organizationId: string) => {
          coreCalls += 1;
          return {
            organizationId,
            metrics: { eventCount: 1 },
            events: [
              {
                id: "event-1",
                name: "Event",
                slug: null,
                startsAt: null,
                endsAt: null,
              },
            ],
          };
        },
        getOverviewActivity: async () => {
          activityCalls += 1;
          throw new Error("activity unavailable");
        },
      },
    });

    const core = await app.request(
      "/api/admin/organizations/organization-1/overview/core",
      undefined,
      localBindings,
    );
    expect(core.status).toBe(200);
    expect(coreCalls).toBe(1);
    expect(activityCalls).toBe(0);

    const activity = await app.request(
      "/api/admin/organizations/organization-1/overview/activity",
      undefined,
      localBindings,
    );
    expect(activity.status).toBe(500);
    expect(coreCalls).toBe(1);
    expect(activityCalls).toBe(1);
  });

  it("returns explicit empty split overview data without repository fiction", async () => {
    const app = createApp({
      authenticator: {
        authenticate: async () => ({
          kind: "user" as const,
          sessionId: "empty-session",
          userId: "owner",
          email: "owner@example.test",
          memberships: [{ organizationId: "empty-organization", role: "owner" as const }],
          speakerGrants: [],
          reviewerGrants: [],
        }),
      },
      organizerOverview: {
        getOverviewCore: async (organizationId: string) => ({
          organizationId,
          metrics: { eventCount: 0 },
          events: [],
        }),
        getOverviewActivity: async (organizationId: string) => ({
          organizationId,
          metrics: {
            submissionCount: 0,
            pendingReviewCount: 0,
            outstandingSpeakerTaskCount: 0,
            publishedSessionCount: 0,
          },
          actionItems: [],
        }),
      },
    });
    const core = await app.request(
      "/api/admin/organizations/empty-organization/overview/core",
      undefined,
      localBindings,
    );
    const activity = await app.request(
      "/api/admin/organizations/empty-organization/overview/activity",
      undefined,
      localBindings,
    );

    expect(core.status).toBe(200);
    await expect(core.json()).resolves.toEqual({
      data: {
        organizationId: "empty-organization",
        metrics: { eventCount: 0 },
        events: [],
      },
    });
    expect(activity.status).toBe(200);
    await expect(activity.json()).resolves.toEqual({
      data: {
        organizationId: "empty-organization",
        metrics: {
          submissionCount: 0,
          pendingReviewCount: 0,
          outstandingSpeakerTaskCount: 0,
          publishedSessionCount: 0,
        },
        actionItems: [],
      },
    });
  });

  it("keeps local speaker mutations stateful and version checked", async () => {
    const app = createRuntimeApp(localBindings);
    const path = "/api/speaker/events/demo-event/profiles/local-participant";

    const current = await app.request(
      "/api/speaker/events/demo-event/portal",
      { headers: speakerHeaders() },
      localBindings,
    );
    const currentBody = (await current.json()) as {
      data: { profiles: Array<{ participantId: string; version: number }> };
    };
    const currentVersion = currentBody.data.profiles.find(
      ({ participantId }) => participantId === "local-participant",
    )?.version;
    if (currentVersion === undefined) throw new Error("Expected the local speaker profile.");
    const updated = await app.request(
      path,
      {
        method: "PATCH",
        headers: { ...speakerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          biography: "Updated local biography.",
          expectedVersion: currentVersion,
        }),
      },
      localBindings,
    );
    const stale = await app.request(
      path,
      {
        method: "PATCH",
        headers: { ...speakerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          biography: "Stale update.",
          expectedVersion: currentVersion,
        }),
      },
      localBindings,
    );

    expect(current.status).toBe(200);
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: {
        biography: "Updated local biography.",
        version: currentVersion + 1,
      },
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "CONFLICT" },
    });
  });

  it("seeds a mutable draft and immutable public agenda projection", async () => {
    const app = createRuntimeApp(localBindings);
    const adminBase = `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/agenda`;
    const draftResponse = await app.request(
      `${adminBase}/draft`,
      { headers: organizerHeaders() },
      localBindings,
    );
    const draftPayload = (await draftResponse.json()) as {
      data: {
        version: number;
        entries: Array<{
          id: string;
          sessionId: string;
          roomId: string;
          trackIds: string[];
          startsAtLocal: string;
          endsAtLocal: string;
        }>;
      };
    };
    const updated = await app.request(
      `${adminBase}/draft`,
      {
        method: "PUT",
        headers: { ...organizerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: draftPayload.data.version,
          entries: draftPayload.data.entries.map(
            ({ id, sessionId, roomId, trackIds, startsAtLocal, endsAtLocal }) => ({
              id,
              sessionId,
              roomId,
              trackIds,
              startsAtLocal,
              endsAtLocal,
            }),
          ),
        }),
      },
      localBindings,
    );
    const published = await app.request(
      "/api/public/events/demo-event/agenda",
      undefined,
      localBindings,
    );

    expect(draftResponse.status).toBe(200);
    expect(draftPayload.data.entries).toHaveLength(2);
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: { version: draftPayload.data.version },
    });
    expect(published.status).toBe(200);
    const publication = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/publication`,
      { headers: organizerHeaders() },
      localBindings,
    );
    expect(publication.status).toBe(200);
    await expect(publication.json()).resolves.toMatchObject({
      data: {
        servedManifest: {
          lifecycle: "served",
          agendaRevisionNumber: 1,
          speakerRevisionNumber: 1,
        },
      },
    });
    const speakers = await app.request(
      "/api/public/events/demo-event/speakers",
      undefined,
      localBindings,
    );
    expect(speakers.status).toBe(200);
    expect(speakers.headers.get("x-sessionboard-program-revision")).toBe("1");
    const publishedBody = (await published.json()) as {
      data: Record<string, unknown> & { revision: Record<string, unknown> };
    };
    expect(publishedBody).toMatchObject({
      data: {
        event: {
          slug: "demo-event",
          name: "Open Sessionboard Conference",
          timeZone: "America/Los_Angeles",
          startsOn: "2026-09-18",
          endsOn: "2026-09-18",
          venueName: "Eventloom Hall",
        },
        revision: {
          number: 1,
          publishedAt: "2026-08-08T12:00:00.000Z",
        },
        entries: [
          {
            id: "local-entry-keynote",
            sessionId: "session-submission_local_1",
            title: "Designing reliable community systems",
            speakerNames: ["Alex Rivera"],
            roomName: "Main Hall",
            trackNames: ["Main stage"],
          },
          {
            id: "local-entry-workshop",
            sessionId: "session-submission_local_2",
            speakerNames: ["Taylor Silva"],
            roomName: "Workshop Studio",
            trackNames: ["Practice"],
          },
        ],
      },
    });
    expect(publishedBody.data).not.toHaveProperty("eventId");
    expect(publishedBody.data).not.toHaveProperty("sourceDraftVersion");
    expect(publishedBody.data.revision).not.toHaveProperty("sourceDraftVersion");
    expect(publishedBody.data.revision).not.toHaveProperty("publishedBy");
  });

  it("withholds unsafe generic resources and advertises only mounted webhooks locally", async () => {
    const app = createRuntimeApp(localBindings);
    const apiHeaders = { authorization: `Bearer ${LOCAL_API_KEY}` };
    const genericRequests = [
      `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/events`,
      `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event`,
      `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/speakers`,
      `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/agenda`,
      `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/sessions`,
      `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/sessions/local-session-keynote`,
    ];

    for (const path of genericRequests) {
      const response = await app.request(path, { headers: apiHeaders }, localBindings);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "NOT_FOUND", traceId: expect.any(String) },
      });
    }

    const eventCreate = await app.request(
      `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/events`,
      {
        method: "POST",
        headers: { ...apiHeaders, "content-type": "application/json" },
        body: JSON.stringify({ name: "Unsafe generic create" }),
      },
      localBindings,
    );
    const sessionUpdate = await app.request(
      `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/sessions/local-session-keynote`,
      {
        method: "PATCH",
        headers: { ...apiHeaders, "content-type": "application/json" },
        body: JSON.stringify({ title: "Unsafe generic update" }),
      },
      localBindings,
    );
    expect(eventCreate.status).toBe(404);
    expect(sessionUpdate.status).toBe(404);

    const webhooks = await app.request(
      `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/webhooks`,
      { headers: apiHeaders },
      localBindings,
    );
    expect(webhooks.status).toBe(200);

    const discovery = await app.request("/api/v1/openapi.json", undefined, localBindings);
    expect(discovery.status).toBe(200);
    const document = (await discovery.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/v1/organizations/{organizationId}/webhooks",
      "/api/v1/organizations/{organizationId}/webhooks/{subscriptionId}",
    ]);
    expect(
      Object.keys(document.paths["/api/v1/organizations/{organizationId}/webhooks"] ?? {}),
    ).toEqual(expect.arrayContaining(["get", "post"]));
    expect(document.paths["/api/v1/organizations/{organizationId}/webhooks"]).toMatchObject({
      get: { security: [{ apiKey: ["webhooks:read"] }] },
      post: { security: [{ apiKey: ["webhooks:write"] }] },
    });
    expect(
      Object.keys(
        document.paths["/api/v1/organizations/{organizationId}/webhooks/{subscriptionId}"] ?? {},
      ),
    ).toEqual(expect.arrayContaining(["get", "patch", "put", "delete"]));
  });

  it("seeds an open CFP with deterministic draft creation", async () => {
    let authoritativeEvent: EventCfp = {
      id: "demo-event",
      tenantId: LOCAL_ORGANIZATION_ID,
      version: 1,
      slug: "demo-event",
      name: "Open Sessionboard Conference",
      timezone: "America/Los_Angeles",
      eventStartsAt: "2026-10-01T16:00:00.000Z",
      opensAt: "2026-08-01T07:00:00.000Z",
      closesAt: "2026-09-15T07:00:00.000Z",
    };
    const service = createLocalCfpService(undefined, undefined, {
      async getEvent(tenantId, eventId) {
        return authoritativeEvent.tenantId === tenantId && authoritativeEvent.id === eventId
          ? structuredClone(authoritativeEvent)
          : null;
      },
      async getEventBySlug(tenantId, eventSlug) {
        return authoritativeEvent.tenantId === tenantId && authoritativeEvent.slug === eventSlug
          ? structuredClone(authoritativeEvent)
          : null;
      },
      async saveEvent(event, expectedVersion) {
        if (authoritativeEvent.version !== expectedVersion) {
          throw new Error("event version conflict");
        }
        authoritativeEvent = structuredClone(event);
      },
    });
    await seedLocalCfpForm(service, {
      tenantId: LOCAL_ORGANIZATION_ID,
      eventId: "demo-event",
      formId: "main-cfp",
      actorId: "local-organizer",
    });
    const draft = await service.createDraft({
      tenantId: LOCAL_ORGANIZATION_ID,
      eventId: "demo-event",
      formId: "main-cfp",
      ownerAccountId: "local-speaker",
      idempotencyKey: "local-cfp-draft",
    });
    const replay = await service.createDraft({
      tenantId: LOCAL_ORGANIZATION_ID,
      eventId: "demo-event",
      formId: "main-cfp",
      ownerAccountId: "local-speaker",
      idempotencyKey: "local-cfp-draft",
    });

    expect(draft).toMatchObject({
      id: "submission_local_1",
      tenantId: LOCAL_ORGANIZATION_ID,
      eventId: "demo-event",
      formId: "main-cfp",
      ownerAccountId: "local-speaker",
      status: "draft",
      version: 1,
    });
    expect(replay).toEqual(draft);
  });

  it("does not query or mutate raw Airtable tables through generic public-v1 routes", async () => {
    const transport = new FormulaRecordingTransport();
    transport.seed({
      baseId: "base-test",
      table: "Events",
      recordId: "rec00000000000001",
      fields: {
        "Application ID": "event-airtable",
        "Settings JSON": JSON.stringify({
          id: "event-airtable",
          organizationId: LOCAL_ORGANIZATION_ID,
          name: "Private Airtable Event",
          version: 1,
        }),
      },
    });
    transport.seed({
      baseId: "base-test",
      table: "Participants",
      recordId: "rec00000000000002",
      fields: {
        "Application ID": "participant-airtable",
        "First Name": "Private",
        Email: "private@example.test",
      },
    });
    const digestBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("production-api-key")),
    );
    const digest = [...digestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const database = productionD1(digest);
    const bindings = productionBindings(transport, database);
    const app = createRuntimeApp(bindings);
    const headers = { authorization: "Bearer production-api-key" };

    for (const resource of ["events", "sessions", "speakers", "agenda"]) {
      const response = await app.request(
        `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/${resource}`,
        { headers },
        bindings,
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "NOT_FOUND", traceId: expect.any(String) },
      });
    }

    const create = await app.request(
      `/api/v1/organizations/${LOCAL_ORGANIZATION_ID}/events`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Must not be written" }),
      },
      bindings,
    );
    expect(create.status).toBe(404);
    expect(
      transport.requests.some((request) =>
        ["Events", "Sessions", "Participants", "Agenda Versions"].includes(request.table),
      ),
    ).toBe(false);
  });
  it("matches canonical email against mixed-case authoritative CRM rows", async () => {
    const transport = new FakeAirtableTransport();
    transport.seed({
      baseId: "base-test",
      table: "CRM Contacts",
      fields: {
        "Application ID": "mixed-case-contact",
        "Contact JSON": JSON.stringify({
          id: "mixed-case-contact",
          organizationId: "crm-organization",
          displayName: "Mixed Case",
          email: "Mixed.Case@Example.Test",
          status: "active",
        }),
      },
    });
    const repository = new AirtableCrmRepository({
      baseId: "base-test",
      transport,
    });

    await expect(
      repository.findContactByEmail("crm-organization", "mixed.case@example.test"),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "mixed-case-contact",
        email: "Mixed.Case@Example.Test",
      }),
    );
  });
  it("requires configured origins and OpenSend credentials", () => {
    const bindings = productionBindings(new FakeAirtableTransport(), productionD1("unused"));
    expect(inspectProductionRuntime(bindings).success).toBe(true);
    const { API_ORIGIN: _apiOrigin, ...withoutApiOrigin } = bindings;
    expect(inspectProductionRuntime(withoutApiOrigin).success).toBe(false);
    const {
      OPENSEND_API_KEY: _openSendKey,
      OPENSEND_SENDING_API_KEY: _sendingKey,
      ...withoutOpenSendKey
    } = bindings;
    expect(inspectProductionRuntime(withoutOpenSendKey).success).toBe(false);
    for (const key of [
      "AUTH_FROM_EMAIL",
      "SPEAKERS_FROM_EMAIL",
      "CALENDAR_FROM_EMAIL",
      "CALENDAR_UID_DOMAIN",
    ] as const) {
      const { [key]: _missing, ...withoutIdentity } = bindings;
      expect(inspectProductionRuntime(withoutIdentity).success).toBe(false);
    }
    expect(
      inspectProductionRuntime({ ...bindings, AUTH_FROM_EMAIL: "not-an-email" }).issues,
    ).toContain("AUTH_FROM_EMAIL must be a valid email address.");
    expect(
      inspectProductionRuntime({
        ...bindings,
        CALENDAR_UID_DOMAIN: "https://calendar.example.test",
      }).issues,
    ).toContain("CALENDAR_UID_DOMAIN must be a valid domain name");
    expect(
      inspectProductionRuntime({
        ...bindings,
        API_ORIGIN: "https://api-production.example.test",
      }).success,
    ).toBe(true);
    expect(
      inspectProductionRuntime({
        ...bindings,
        API_ORIGIN: "http://api-production.example.test",
      }).success,
    ).toBe(false);
    expect(
      inspectProductionRuntime({
        ...bindings,
        API_ORIGIN: "https://api-production.example.test/path",
      }).success,
    ).toBe(false);
    expect(
      inspectProductionRuntime({
        ...bindings,
        API_ORIGIN: "http://api-production.example.test",
      }).success,
    ).toBe(false);
    expect(
      inspectProductionRuntime({
        ...bindings,
        API_ORIGIN: "https://api-production.example.test/path",
      }).success,
    ).toBe(false);
  });

  it("mounts the live Better Auth session path through the production app", async () => {
    const bindings = productionBindings(new FakeAirtableTransport(), productionD1("unused"));
    const app = createRuntimeApp(bindings);
    const response = await app.request(
      `${bindings.API_ORIGIN}/api/auth/get-session`,
      { headers: { origin: bindings.WEB_ORIGIN } },
      bindings,
    );

    expect(response.status).not.toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).not.toContain("open-send-test-key");
  });

  it("fails closed without non-local provider configuration and never returns issue details", async () => {
    const worker = createRuntimeWorker();
    const bindings: RuntimeBindings = {
      APP_ENV: "production",
      WEB_ORIGIN: "https://eventloom.pages.dev",
    };
    const response = await worker.fetch?.(
      new Request("https://api.example.com/api/health", {
        headers: { origin: bindings.WEB_ORIGIN },
      }),
      bindings,
      {} as ExecutionContext,
    );

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(503);
    expect(response?.headers.get("access-control-allow-origin")).toBe(bindings.WEB_ORIGIN);
    const payload = await response?.json();
    expect(payload).toMatchObject({
      error: {
        code: "CONFIGURATION_ERROR",
        message: "The API runtime is not configured.",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("AIRTABLE_ACCESS_TOKEN");
  });
  it("exposes a scheduled handler and fails closed on invalid runtime configuration", async () => {
    const worker = createRuntimeWorker();
    const scheduled = worker.scheduled;
    if (scheduled === undefined) throw new Error("The runtime worker did not expose scheduled.");
    const bindings: RuntimeBindings = {
      APP_ENV: "production",
      WEB_ORIGIN: "https://eventloom.pages.dev",
    };

    await expect(
      scheduled({ scheduledTime: Date.now() } as never, bindings, {} as ExecutionContext),
    ).resolves.toBeUndefined();
  });
  it("keeps automatic reminders hourly while exports recover every five minutes", () => {
    expect(shouldRunScheduledReminders(EVALUATION_EXPORT_RECOVERY_CRON)).toBe(false);
    expect(shouldRunScheduledReminders(AUTOMATIC_REMINDER_CRON)).toBe(true);
    expect(shouldRunScheduledReminders(undefined)).toBe(true);
  });
  it("skips retired legacy events before recording automatic reminder runs", async () => {
    const reminders = new InMemoryReminderRepository();
    const service = new CommunicationService(new InMemoryCommunicationRepository(), undefined, {
      reminders: { repository: reminders },
    });
    const database = {
      prepare(query: string) {
        return {
          async all() {
            if (query.includes("legacy_retired_at")) {
              return { results: [{ id: "event-retired" }] };
            }
            return {
              results: [
                {
                  organization_id: "organization-reminders",
                  user_id: "organizer-reminders",
                  role: "owner",
                },
              ],
            };
          },
        };
      },
    } as unknown as D1Database;
    const dependencies = {
      communications: {
        service,
        actorFor: async () => null,
      },
      events: {
        service: {
          async listEvents() {
            return [
              { id: "event-reminders", organizationId: "organization-reminders" },
              { id: "event-retired", organizationId: "organization-reminders" },
            ];
          },
        },
      },
    } as unknown as ApiDependencies;

    await runScheduledReminders(
      dependencies,
      {
        APP_ENV: "production",
        WEB_ORIGIN: "https://open-sessionboard.pages.dev",
        DB: database,
      },
      new Date("2026-08-12T12:30:00.000Z"),
    );

    await expect(
      reminders.listRuns("organization-reminders", "event-reminders"),
    ).resolves.toMatchObject([
      {
        triggerType: "automatic",
        state: "failed",
        configurationFailure: "The reminder candidate source is not configured.",
      },
    ]);
    await expect(reminders.listRuns("organization-reminders", "event-retired")).resolves.toEqual(
      [],
    );
  });

  it("exposes the production outbox queue consumer and retries when bindings fail closed", async () => {
    const worker = createRuntimeWorker();
    const queue = worker.queue;
    if (queue === undefined) throw new Error("The runtime worker did not expose queue.");
    const retries: Array<{ delaySeconds?: number }> = [];
    const message = {
      body: {
        version: 1,
        jobId: "job-1",
        tenantId: "ai-engineer",
        topic: "communications",
        enqueuedAt: "2026-08-10T00:00:00.000Z",
      },
      ack() {
        throw new Error("An unconfigured runtime must not acknowledge outbox work.");
      },
      retry(options?: { delaySeconds?: number }) {
        retries.push(options ?? {});
      },
    };

    await expect(
      queue(
        { messages: [message] } as never,
        {
          APP_ENV: "production",
          WEB_ORIGIN: "https://web-production.example.test",
        },
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
    expect(retries).toEqual([{ delaySeconds: 60 }]);
  });
});
type AcceptanceIdempotencyRow = {
  requestDigest: string;
  state: "processing" | "completed";
  responseJson: string | null;
  responseStatus: number | null;
  expiresAt: string;
};

function acceptanceDatabase(
  events: string[],
  options: {
    readonly speakerGrantAvailable?: boolean;
    readonly decisionStatusesByParticipantPlan?: ReadonlyMap<
      string,
      readonly ("accepted" | "waitlisted" | "rejected")[]
    >;
  } = {},
): {
  readonly database: NonNullable<RuntimeBindings["DB"]>;
  readonly outbox: Map<
    string,
    {
      state: string;
      topic: string;
      payload: unknown;
      createdAt?: string;
      updatedAt?: string;
      completedAt?: string | null;
      lastErrorCode?: string | null;
    }
  >;
  readonly grants: string[];
  readonly audiences: Map<string, Set<string>>;
} {
  const idempotency = new Map<string, AcceptanceIdempotencyRow>();
  const outbox = new Map<
    string,
    {
      state: string;
      topic: string;
      payload: unknown;
      createdAt?: string;
      updatedAt?: string;
      completedAt?: string | null;
      lastErrorCode?: string | null;
    }
  >();
  const grants: string[] = [];
  const audiences = new Map<string, Set<string>>();
  const database = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (query.includes("FROM idempotency_records")) {
                const key = `${String(values[0])}:${String(values[1])}:${String(values[2])}`;
                const row = idempotency.get(key);
                return (
                  row === undefined
                    ? null
                    : {
                        request_digest: row.requestDigest,
                        state: row.state,
                        response_status: row.responseStatus,
                        response_json: row.responseJson,
                        expires_at: row.expiresAt,
                      }
                ) as T | null;
              }
              if (query.includes("SELECT state FROM outbox_jobs")) {
                const row = outbox.get(String(values[0]));
                return (row === undefined ? null : { state: row.state }) as T | null;
              }
              if (query.includes("FROM evaluation_decisions")) {
                const submissionId = String(values[3]);
                return {
                  version: 1,
                  status: submissionId.includes("accepted") ? "accepted" : "rejected",
                } as T;
              }
              if (query.includes("FROM auth_users")) {
                events.push("db:auth-users");
                return options.speakerGrantAvailable === false
                  ? null
                  : ({
                      id: "account-speaker",
                      email: "speaker@example.test",
                    } as T);
              }
              return null;
            },
            async all<T>() {
              if (query.includes("FROM outbox_jobs")) {
                const tenantId = String(values[0]);
                const planId = String(values[1]);
                return {
                  results: [...outbox.entries()]
                    .filter(
                      ([id, row]) =>
                        id.includes(tenantId) &&
                        typeof row.payload === "object" &&
                        row.payload !== null &&
                        "planId" in row.payload &&
                        row.payload.planId === planId,
                    )
                    .map(([id, row]) => ({
                      id,
                      payload_json: JSON.stringify(row.payload),
                      state: row.state,
                      created_at: row.createdAt ?? "2026-08-13T12:00:00.000Z",
                      updated_at: row.updatedAt ?? "2026-08-13T12:00:00.000Z",
                      completed_at: row.completedAt ?? null,
                      last_error_code: row.lastErrorCode ?? null,
                    })) as T[],
                };
              }
              return { results: [] as T[] };
            },
            async run() {
              if (query.includes("INSERT INTO idempotency_records")) {
                const key = `${String(values[0])}:${String(values[1])}:${String(values[2])}`;
                idempotency.set(key, {
                  requestDigest: String(values[3]),
                  state: "processing",
                  responseJson: null,
                  responseStatus: null,
                  expiresAt: String(values[5]),
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (query.includes("UPDATE idempotency_records")) {
                const key = `${String(values[3])}:${String(values[4])}:${String(values[5])}`;
                const row = idempotency.get(key);
                if (row !== undefined) {
                  row.state = "completed";
                  row.responseStatus = Number(values[0]);
                  row.responseJson = String(values[1]);
                  row.expiresAt = String(values[2]);
                }
                return {
                  success: true,
                  meta: { changes: row === undefined ? 0 : 1 },
                };
              }
              if (query.includes("DELETE FROM idempotency_records")) {
                const key = `${String(values[0])}:${String(values[1])}:${String(values[2])}`;
                idempotency.delete(key);
                return { success: true, meta: { changes: 1 } };
              }
              if (query.includes("INSERT INTO outbox_jobs")) {
                const id = String(values[0]);
                const topic = String(values[2]);
                const payload = JSON.parse(String(values[4])) as unknown;
                const duplicate = outbox.has(id);
                if (!duplicate) {
                  const reminderPayload =
                    typeof payload === "object" &&
                    payload !== null &&
                    "planId" in payload &&
                    "reviewerId" in payload;
                  outbox.set(id, {
                    state: "pending",
                    topic,
                    payload,
                    ...(reminderPayload
                      ? {
                          createdAt: String(values[6]),
                          updatedAt: String(values[7]),
                          completedAt: null,
                          lastErrorCode: null,
                        }
                      : {}),
                  });
                }
                return { success: true, meta: { changes: duplicate ? 0 : 1 } };
              }
              if (query.includes("UPDATE outbox_jobs SET state = 'queued'")) {
                const row = outbox.get(String(values[1]));
                if (row !== undefined) row.state = "queued";
                return {
                  success: true,
                  meta: { changes: row === undefined ? 0 : 1 },
                };
              }
              if (query.includes("INSERT INTO speaker_grants")) {
                grants.push(String(values[2]));
              }
              return { success: true, meta: { changes: 1 } };
            },
            query,
            values,
          };
        },
      };
    },
    async batch(statements: unknown[]) {
      for (const statement of statements) {
        const { query, values } = statement as {
          readonly query: string;
          readonly values: readonly unknown[];
        };
        if (query.includes("DELETE FROM communication_recipient_audiences")) {
          const recipientId = String(values[2]);
          const memberships = audiences.get(recipientId);
          if (memberships === undefined) continue;
          if (query.includes("AND audience = ?")) {
            const audience = String(values[3]);
            const status =
              audience === "accepted_participants"
                ? "accepted"
                : audience === "waitlisted_participants"
                  ? "waitlisted"
                  : "rejected";
            if (
              !options.decisionStatusesByParticipantPlan
                ?.get(`${recipientId}:${String(values[7])}`)
                ?.includes(status)
            ) {
              memberships.delete(audience);
            }
          } else {
            memberships.delete("accepted_participants");
            memberships.delete("waitlisted_participants");
            memberships.delete("rejected_participants");
          }
          continue;
        }
        if (query.includes("INSERT INTO communication_recipient_audiences")) {
          const recipientId = String(values[2]);
          const audience = String(values[3]);
          const memberships = audiences.get(recipientId) ?? new Set<string>();
          if (
            memberships.has(audience) &&
            !query.includes(
              "ON CONFLICT(organization_id, event_id, recipient_id, audience) DO NOTHING",
            )
          ) {
            throw new Error("Duplicate communication recipient audience.");
          }
          memberships.add(audience);
          audiences.set(recipientId, memberships);
        }
      }
      return [];
    },
  } as unknown as NonNullable<RuntimeBindings["DB"]>;
  return { database, outbox, grants, audiences };
}

function acceptanceTransport(events: string[]): {
  readonly fake: FakeAirtableTransport;
  readonly transport: AirtableTransport;
} {
  const fake = new FakeAirtableTransport();
  const transport: AirtableTransport = {
    async request(request) {
      events.push(`airtable:${request.method}:${request.table}`);
      return fake.request(request);
    },
  };
  return { fake, transport };
}

describe("production agenda, portal, acceptance, and reminder boundaries", () => {
  it("preserves independent accepted and rejected audiences for one participant", async () => {
    const events: string[] = [];
    const { database, outbox, audiences } = acceptanceDatabase(events, {
      decisionStatusesByParticipantPlan: new Map([
        ["participant-shared:plan-1", ["accepted", "rejected"]],
      ]),
    });
    const queueMessages: CloudflareOutboxMessage[] = [];
    const submissionFor = (submissionId: string, participantId: string): Submission => ({
      id: submissionId,
      tenantId: "organization-1",
      eventId: "event-1",
      formId: "form-1",
      ownerAccountId: `owner-${participantId}`,
      formVersion: 1,
      version: 1,
      status: "submitted",
      completedSteps: [],
      answers: { title: `Session ${submissionId}` },
      participants: [
        {
          id: participantId,
          firstName: "Decision",
          lastName: participantId,
          email: `${participantId}@example.test`,
          role: "primary",
          biography: "Speaker biography.",
          answers: {},
        },
      ],
      secondaryContacts: [],
      createdAt: "2099-08-15T03:00:00.000Z",
      updatedAt: "2099-08-15T03:00:00.000Z",
      submittedAt: "2099-08-15T03:00:00.000Z",
    });
    const submissions = new Map([
      ["submission-accepted", submissionFor("submission-accepted", "participant-shared")],
      ["submission-rejected", submissionFor("submission-rejected", "participant-shared")],
    ]);
    const projection = new AirtableEvaluationDecisionProjection(
      {
        async getSubmission(organizationId: string, submissionId: string) {
          return organizationId === "organization-1"
            ? (submissions.get(submissionId) ?? null)
            : null;
        },
      },
      database,
      {
        async send(message: CloudflareOutboxMessage) {
          queueMessages.push(message);
        },
      } as unknown as NonNullable<RuntimeBindings["OUTBOX_QUEUE"]>,
      undefined,
      testSenderAddresses,
    );
    const decisionInput = (
      submissionId: string,
      status: "accepted" | "rejected",
    ): EvaluationDecisionProjectionInput => ({
      tenantId: "organization-1",
      eventId: "event-1",
      planId: "plan-1",
      submissionId,
      decisionId: `decision-${submissionId}`,
      decisionVersion: 1,
      status,
      priorStatus: null,
      reason: status === "accepted" ? "Accepted." : "Rejected.",
      decidedByUserId: "organizer-1",
      decidedAt: "2099-08-15T04:00:00.000Z",
      idempotencyKey: `evaluation-decision:plan-1:${submissionId}:v1`,
      participantProjection: {
        status,
        reason: status === "accepted" ? "Accepted." : "Rejected.",
        decisionVersion: 1,
        decidedAt: "2099-08-15T04:00:00.000Z",
      },
      communication: {
        templatePurpose: status === "accepted" ? "decision_accepted" : "decision_rejected",
      },
    });
    const accepted = decisionInput("submission-accepted", "accepted");
    const rejected = decisionInput("submission-rejected", "rejected");

    await projection.projectDecision(accepted);
    await projection.projectDecision(rejected);
    await projection.projectDecision(accepted);

    expect(
      [...outbox.values()]
        .filter((row) => row.topic === "communications")
        .map((row) => row.payload)
        .sort((left, right) =>
          String((left as { readonly status?: string }).status).localeCompare(
            String((right as { readonly status?: string }).status),
          ),
        ),
    ).toEqual([
      expect.objectContaining({
        purpose: "decision",
        status: "accepted",
        idempotencyKey: "decision:evaluation-decision:plan-1:submission-accepted:v1",
      }),
      expect.objectContaining({
        purpose: "decision",
        status: "rejected",
        idempotencyKey: "decision:evaluation-decision:plan-1:submission-rejected:v1",
      }),
    ]);
    expect(queueMessages).toHaveLength(2);
    expect([...(audiences.get("participant-shared") ?? [])].sort()).toEqual([
      "accepted_participants",
      "rejected_participants",
    ]);
  });

  it("loads the authoritative agenda workspace with one Airtable request", async () => {
    const eventId = "event-workspace-read";
    const state: AgendaState = {
      eventId,
      stateVersion: 3,
      timeZone: "UTC",
      minimumTravelMinutes: 0,
      sessions: [],
      rooms: [],
      tracks: [],
      draft: {
        eventId,
        timeZone: "UTC",
        version: 2,
        entries: [],
        warningOverrides: [],
        updatedAt: "2026-08-11T00:00:00.000Z",
        updatedBy: "organizer-workspace-read",
      },
      revisions: [],
      currentPublishedRevisionId: null,
      outbox: [],
      audit: [],
      suggestionRuns: [],
    };
    const transport = new FakeAirtableTransport();
    transport.seed({
      baseId: "base-test",
      table: "Agenda Versions",
      fields: {
        "Application ID": eventId,
        "Conflicts JSON": JSON.stringify(state),
      },
    });
    const repository = new AirtableAgendaRepository({
      baseId: "base-test",
      transport,
    });

    await expect(repository.load(eventId)).resolves.toEqual(state);
    expect(
      transport.requests.map((request) => ({
        method: request.method,
        table: request.table,
      })),
    ).toEqual([{ method: "GET", table: "Agenda Versions" }]);
  });

  it("does not project an event lifecycle status during embed-only updates", async () => {
    const transport = new FakeAirtableTransport();
    const eventId = "event-embed-status";
    transport.seed({
      baseId: "base-test",
      table: "Events",
      fields: {
        "Application ID": eventId,
        Version: 1,
        "Settings JSON": JSON.stringify({
          id: eventId,
          organizationId: LOCAL_ORGANIZATION_ID,
          slug: eventId,
          name: "Embed status event",
          timeZone: "UTC",
          startsAt: "2027-05-12T00:00:00.000Z",
          endsAt: "2027-05-13T00:00:00.000Z",
          cfpSettings: { enabled: true, opensAt: null, closesAt: null },
          defaultCalendarSettings: { durationMinutes: 30, timeZone: "UTC", location: null },
          embedConfigurations: [],
          version: 1,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
          createdBy: "owner",
          updatedBy: "owner",
        }),
      },
    });
    const repository = new AirtableEventRepository({ baseId: "base-test", transport });
    const current = await repository.getEvent(LOCAL_ORGANIZATION_ID, eventId);
    if (current === null) throw new Error("Expected the event fixture.");
    await repository.saveEvent(
      {
        ...current,
        embedConfigurations: [
          {
            id: "embed-status",
            name: "Agenda",
            widgetId: "agenda",
            enabled: true,
            theme: "light",
            outputFormat: "styled-html",
            layout: "comfortable",
            accent: "#4f5ee8",
            backgroundColor: "#ffffff",
            textColor: "#20232b",
            customCss: "",
            displayFields: ["title", "date-time"],
            trackIds: [],
            statuses: [],
            revision: 1,
          },
        ],
        version: 2,
      },
      1,
    );
    const update = transport.requests.find(
      (request) => request.method === "PATCH" && request.table === "Events",
    );
    expect(update?.body).not.toHaveProperty("fields.Status");
  });

  it("restricts remix speaker visibility and application to the event tenant", async () => {
    const tenantId = "tenant-remix-owner";
    const otherTenantId = "tenant-remix-other";
    const eventId = "event-remix-scope";
    const events: string[] = [];
    const { fake, transport } = acceptanceTransport(events);
    fake.seed({
      baseId: "base-test",
      table: "Events",
      fields: {
        "Application ID": eventId,
        "Settings JSON": JSON.stringify({
          id: eventId,
          organizationId: tenantId,
          eventId,
          name: "Remix scope event",
        }),
      },
    });
    fake.seed({
      baseId: "base-test",
      table: "Speaker Profiles",
      fields: {
        "Application ID": `speaker-profile:${eventId}:accepted`,
        Biography: JSON.stringify({
          id: `speaker-profile:${eventId}:accepted`,
          tenantId,
          eventId,
          participantId: "accepted",
          displayName: "Accepted Speaker",
          biography: "Accepted biography",
          status: "accepted",
          version: 1,
          updatedAt: "2026-08-09T00:00:00.000Z",
        }),
      },
    });
    fake.seed({
      baseId: "base-test",
      table: "Speaker Profiles",
      fields: {
        "Application ID": `speaker-profile:${eventId}:organizer`,
        Biography: JSON.stringify({
          id: `speaker-profile:${eventId}:organizer`,
          eventId,
          participantId: "organizer",
          displayName: "Organizer Speaker",
          biography: "Organizer biography",
          status: "active",
          version: 1,
          updatedAt: "2026-08-09T00:00:00.000Z",
        }),
      },
    });
    fake.seed({
      baseId: "base-test",
      table: "Speaker Profiles",
      fields: {
        "Application ID": `speaker-profile:${eventId}:cross-tenant`,
        Biography: JSON.stringify({
          id: `speaker-profile:${eventId}:cross-tenant`,
          organizationId: otherTenantId,
          eventId,
          participantId: "cross-tenant",
          displayName: "Cross Tenant Speaker",
          biography: "Cross tenant biography",
          status: "active",
          version: 1,
          updatedAt: "2026-08-09T00:00:00.000Z",
        }),
      },
    });
    const { database } = acceptanceDatabase(events);
    const queue = {
      async send() {},
    } as unknown as NonNullable<RuntimeBindings["OUTBOX_QUEUE"]>;
    const gateway = new AirtableRemixContentGateway({
      baseId: "base-test",
      transport,
      database,
      queue,
    });

    await expect(gateway.listSpeakers({ tenantId, eventId })).resolves.toEqual([
      expect.objectContaining({ id: "accepted", biography: "Accepted biography" }),
      expect.objectContaining({ id: "organizer", biography: "Organizer biography" }),
    ]);
    await expect(gateway.listSpeakers({ tenantId: otherTenantId, eventId })).resolves.toEqual([]);
    await expect(
      gateway.getSpeaker({ tenantId: otherTenantId, eventId, sourceId: "accepted" }),
    ).resolves.toBeNull();

    await expect(
      gateway.applyRevision({
        tenantId,
        eventId,
        sourceType: "speaker",
        sourceId: "organizer",
        expectedSourceRevision: 1,
        fields: ["biography"],
        content: { biography: "Updated organizer biography" },
        candidateId: "candidate-organizer",
        actorId: "organizer-owner",
        appliedAt: "2026-08-09T01:00:00.000Z",
      }),
    ).resolves.toMatchObject({ sourceRevision: 2, sourceId: "organizer" });
    const profilePatch = fake.requests.find(
      (request) => request.method === "PATCH" && request.table === "Speaker Profiles",
    );
    const profilePatchFields = (
      profilePatch?.body as { readonly fields?: Readonly<Record<string, unknown>> } | undefined
    )?.fields;
    expect(profilePatchFields).toEqual({
      "Application ID": `speaker-profile:${eventId}:organizer`,
      Version: 2,
      Biography: expect.any(String),
    });
    expect(JSON.parse(String(profilePatchFields?.Biography))).toMatchObject({
      tenantId,
      eventId,
      version: 2,
      biography: "Updated organizer biography",
    });
    await expect(gateway.getSpeaker({ tenantId, eventId, sourceId: "organizer" })).resolves.toEqual(
      expect.objectContaining({ biography: "Updated organizer biography", revision: 2 }),
    );

    await expect(
      gateway.applyRevision({
        tenantId: otherTenantId,
        eventId,
        sourceType: "speaker",
        sourceId: "accepted",
        expectedSourceRevision: 1,
        fields: ["biography"],
        content: { biography: "Cross tenant update" },
        candidateId: "candidate-cross-tenant",
        actorId: "other-owner",
        appliedAt: "2026-08-09T01:00:00.000Z",
      }),
    ).rejects.toThrow("speaker content changed");
  });
  it("batches organizer workspace Airtable projection reads", async () => {
    const tenantId = "tenant-organizer-workspace";
    const eventId = "event-organizer-workspace";
    const otherTenantId = "tenant-organizer-other";
    const otherEventId = "event-organizer-other";
    const planId = "plan-organizer-workspace";
    const roundId = "round-organizer-workspace";
    const now = "2026-08-10T12:00:00.000Z";
    const later = "2026-08-10T12:05:00.000Z";
    const transport = new FormulaRecordingTransport(700);
    const reviewRound = {
      id: roundId,
      name: "Organizer review",
      sequence: 1,
      closesAt: null,
      rubric: {
        id: "rubric-organizer-workspace",
        name: "Organizer rubric",
        criteria: [
          {
            id: "quality",
            label: "Quality",
            description: "Proposal quality",
            minimum: 1,
            maximum: 5,
            weight: 1,
            required: true,
          },
        ],
      },
    };
    const plan = {
      id: planId,
      tenantId,
      eventId,
      name: "Organizer queue",
      status: "open",
      blindReview: true,
      closesAt: null,
      assignmentRule: { reviewsPerSubmission: 1, maxAssignmentsPerReviewer: 10 },
      rounds: [reviewRound],
      reviewerProjection: { fieldIds: [], fileIds: [] },
      gradingLockedAt: now,
      version: 2,
      createdAt: now,
      updatedAt: now,
    };
    transport.seed({
      baseId: "base-test",
      table: "Review Plans",
      fields: {
        "Application ID": planId,
        "Rounds JSON": JSON.stringify(plan),
      },
    });
    transport.seed({
      baseId: "base-test",
      table: "Review Plans",
      fields: {
        "Application ID": "foreign-plan",
        "Rounds JSON": JSON.stringify({
          ...plan,
          id: "foreign-plan",
          tenantId: otherTenantId,
          eventId: otherEventId,
        }),
      },
    });
    const assignmentSubmitted = {
      id: "assignment-organizer-submitted",
      tenantId,
      eventId,
      planId,
      roundId,
      submissionId: "submission-organizer-alpha",
      reviewerId: "reviewer-organizer-one",
      status: "assigned",
      planVersion: 2,
      rubricRevision: 2,
      submissionRevision: 1,
      version: 2,
      createdAt: now,
      updatedAt: later,
    };
    const assignmentOutstanding = {
      id: "assignment-organizer-outstanding",
      tenantId,
      eventId,
      planId,
      roundId,
      submissionId: "submission-organizer-zulu",
      reviewerId: "reviewer-organizer-two",
      status: "assigned",
      planVersion: 2,
      rubricRevision: 2,
      submissionRevision: 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const staleAssignment = { ...assignmentSubmitted, version: 1, updatedAt: now };
    const reviewSubmitted = {
      id: `review:${assignmentSubmitted.id}`,
      tenantId,
      eventId,
      planId,
      roundId,
      assignmentId: assignmentSubmitted.id,
      submissionId: assignmentSubmitted.submissionId,
      reviewerId: assignmentSubmitted.reviewerId,
      scores: {
        quality: {
          criterionId: "quality",
          value: 4,
          origin: "human",
          evidence: ["reviewer evidence"],
          humanConfirmedBy: assignmentSubmitted.reviewerId,
        },
      },
      comment: "Strong proposal",
      submittedAt: later,
      version: 2,
      planRevision: 2,
      rubricRevision: 2,
      submissionRevision: 1,
      createdAt: now,
      updatedAt: later,
    };
    const staleReview = { ...reviewSubmitted, version: 1, updatedAt: now, submittedAt: null };
    const reviewDraft = {
      id: `review:${assignmentOutstanding.id}`,
      tenantId,
      eventId,
      planId,
      roundId,
      assignmentId: assignmentOutstanding.id,
      submissionId: assignmentOutstanding.submissionId,
      reviewerId: assignmentOutstanding.reviewerId,
      scores: {},
      comment: "Draft",
      submittedAt: null,
      version: 1,
      planRevision: 2,
      rubricRevision: 2,
      submissionRevision: 1,
      createdAt: now,
      updatedAt: now,
    };
    for (const evaluation of [
      staleAssignment,
      assignmentSubmitted,
      assignmentOutstanding,
      staleReview,
      reviewSubmitted,
      reviewDraft,
      {
        ...assignmentOutstanding,
        id: "foreign-tenant-assignment",
        tenantId: otherTenantId,
      },
      {
        ...reviewDraft,
        id: "review:foreign-tenant-assignment",
        assignmentId: "foreign-tenant-assignment",
        tenantId: otherTenantId,
      },
      {
        ...assignmentOutstanding,
        id: "foreign-event-assignment",
        eventId: otherEventId,
      },
    ]) {
      transport.seed({
        baseId: "base-test",
        table: "Evaluations",
        fields: {
          "Application ID": evaluation.id,
          "Scores JSON": JSON.stringify({
            ...evaluation,
            entityType: "scores" in evaluation ? "evaluation_review" : "evaluation_assignment",
          }),
        },
      });
    }

    const decisionAccepted = {
      id: `decision:${planId}:${assignmentSubmitted.submissionId}`,
      tenantId,
      eventId,
      planId,
      submissionId: assignmentSubmitted.submissionId,
      status: "accepted",
      version: 2,
      history: [
        {
          from: null,
          to: "accepted",
          reason: "Accepted",
          decidedBy: "organizer-workspace",
          decidedAt: later,
          idempotencyKey: "decision-accepted",
        },
      ],
      updatedAt: later,
    };
    const decisionWaitlisted = {
      id: `decision:${planId}:${assignmentOutstanding.submissionId}`,
      tenantId,
      eventId,
      planId,
      submissionId: assignmentOutstanding.submissionId,
      status: "waitlisted",
      version: 1,
      history: [
        {
          from: null,
          to: "waitlisted",
          reason: "Waitlisted",
          decidedBy: "organizer-workspace",
          decidedAt: now,
          idempotencyKey: "decision-waitlisted",
        },
      ],
      updatedAt: now,
    };
    const staleDecision = { ...decisionAccepted, version: 1, status: "waitlisted", updatedAt: now };
    for (const decision of [
      staleDecision,
      decisionAccepted,
      decisionWaitlisted,
      {
        ...decisionWaitlisted,
        id: "decision:foreign-tenant",
        tenantId: otherTenantId,
        submissionId: "submission-foreign-tenant",
      },
      {
        ...decisionWaitlisted,
        id: "decision:foreign-event",
        eventId: otherEventId,
        submissionId: "submission-foreign-event",
      },
    ]) {
      transport.seed({
        baseId: "base-test",
        table: "Decisions",
        fields: {
          "Application ID": decision.id,
          "Metadata JSON": JSON.stringify({ ...decision, entityType: "evaluation_decision" }),
        },
      });
    }

    const seedSubmission = (input: {
      readonly id: string;
      readonly tenantId: string;
      readonly eventId: string;
      readonly title: string;
      readonly version?: number;
    }) => {
      const version = input.version ?? 1;
      transport.seed({
        baseId: "base-test",
        table: "Submissions",
        fields: {
          "Application ID": input.id,
          "Answers JSON": JSON.stringify({
            id: input.id,
            tenantId: input.tenantId,
            eventId: input.eventId,
            formId: "form-organizer-workspace",
            ownerAccountId: "speaker-organizer-workspace",
            formVersion: 1,
            version,
            status: "submitted",
            completedSteps: ["welcome"],
            answers: { title: input.title, abstract: `${input.title} abstract` },
            participants: [],
            secondaryContacts: [],
            createdAt: now,
            updatedAt: version === 1 ? now : later,
            submittedAt: now,
            reopenedAt: null,
          }),
        },
      });
    };
    seedSubmission({
      id: "submission-organizer-alpha",
      tenantId,
      eventId,
      title: "Alpha proposal",
    });
    seedSubmission({
      id: "submission-organizer-zulu",
      tenantId,
      eventId,
      title: "Zulu proposal",
    });
    seedSubmission({
      id: "submission-foreign-tenant",
      tenantId: otherTenantId,
      eventId,
      title: "Foreign tenant proposal",
    });
    seedSubmission({
      id: "submission-foreign-event",
      tenantId,
      eventId: otherEventId,
      title: "Foreign event proposal",
    });

    const projection = new AirtableEvaluationProjectionStore({
      baseId: "base-test",
      transport,
    });
    transport.requests.length = 0;
    const records = await projection.listOrganizerWorkspaceRecords(tenantId, eventId);

    expect(records.assignments.map((assignment) => assignment.id).sort()).toEqual([
      assignmentOutstanding.id,
      assignmentSubmitted.id,
    ]);
    expect(records.reviews).toEqual([reviewDraft, reviewSubmitted]);
    expect(records.decisions).toEqual([
      expect.objectContaining({
        id: decisionAccepted.id,
        status: "accepted",
        version: 2,
      }),
      expect.objectContaining({
        id: decisionWaitlisted.id,
        status: "waitlisted",
        version: 1,
      }),
    ]);
    const reads = transport.requests.filter((request) => request.method === "GET");
    expect(reads).toHaveLength(3);
    expect(reads.map((request) => request.table).sort()).toEqual([
      "Decisions",
      "Evaluations",
      "Review Plans",
    ]);
    for (const table of ["Review Plans", "Evaluations", "Decisions"] as const) {
      const read = reads.find((request) => request.table === table);
      expect(read?.query?.filterByFormula).toContain("AND(");
      expect(read?.query?.filterByFormula).toContain(tenantId);
      expect(read?.query?.filterByFormula).toContain(eventId);
    }
    expect(JSON.stringify(records)).not.toContain("foreign");
  });
  it("reads superseded assignment lineage from Airtable projections", async () => {
    const tenantId = "tenant-replacement";
    const eventId = "event-replacement";
    const planId = "plan-replacement";
    const roundId = "round-replacement";
    const submissionId = "submission-replacement";
    const now = "2026-08-10T12:00:00.000Z";
    const replacedAt = "2026-08-10T12:10:00.000Z";
    const transport = new FormulaRecordingTransport();
    const assignmentA = {
      id: "assignment-replacement-a",
      tenantId,
      eventId,
      planId,
      roundId,
      submissionId,
      reviewerId: "reviewer-a",
      status: "assigned" as const,
      planVersion: 4,
      rubricRevision: 7,
      roundRevision: 3,
      submissionRevision: 2,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const assignmentB = {
      ...assignmentA,
      id: "assignment-replacement-b",
      reviewerId: "reviewer-b",
      status: "submitted" as const,
      version: 2,
      updatedAt: "2026-08-10T12:05:00.000Z",
    };
    const assignmentC = {
      ...assignmentA,
      id: "assignment-replacement-c",
      reviewerId: "reviewer-c",
      createdAt: replacedAt,
      updatedAt: replacedAt,
    };
    const reviewA = {
      id: `review:${assignmentA.id}`,
      tenantId,
      eventId,
      planId,
      roundId,
      assignmentId: assignmentA.id,
      submissionId,
      reviewerId: assignmentA.reviewerId,
      scores: {},
      comment: "Submitted review",
      submittedAt: now,
      version: 1,
      planRevision: 4,
      rubricRevision: 7,
      roundRevision: 3,
      submissionRevision: 2,
      createdAt: now,
      updatedAt: now,
    };
    const plan = {
      id: planId,
      tenantId,
      eventId,
      name: "Replacement plan",
      status: "open" as const,
      blindReview: false,
      closesAt: null,
      assignmentRule: { reviewsPerSubmission: 3, maxAssignmentsPerReviewer: 10 },
      rounds: [
        {
          id: roundId,
          opensAt: null,
          closesAt: "2026-08-10T13:00:00.000Z",
        },
      ],
      version: 4,
      createdAt: now,
      updatedAt: now,
    };
    transport.seed({
      baseId: "base-test",
      table: "Review Plans",
      recordId: "rec00000000000100",
      fields: {
        "Application ID": plan.id,
        "Rounds JSON": JSON.stringify(plan),
      },
    });
    const supersededAssignment = {
      ...assignmentA,
      status: "superseded" as const,
      version: 2,
      supersededByAssignmentId: assignmentC.id,
      updatedAt: replacedAt,
    };
    const successorAssignment = {
      ...assignmentC,
      replacementForAssignmentId: assignmentA.id,
    };
    for (const [recordId, entity, entityType] of [
      ["rec00000000000101", supersededAssignment, "evaluation_assignment"],
      ["rec00000000000102", assignmentB, "evaluation_assignment"],
      ["rec00000000000103", reviewA, "evaluation_review"],
      ["rec00000000000104", successorAssignment, "evaluation_assignment"],
    ] as const) {
      transport.seed({
        baseId: "base-test",
        table: "Evaluations",
        recordId,
        fields: {
          "Application ID": entity.id,
          "Scores JSON": JSON.stringify({ ...entity, entityType }),
        },
      });
    }

    const projection = new AirtableEvaluationProjectionStore({
      baseId: "base-test",
      transport,
    });
    await expect(projection.getAssignment(tenantId, assignmentA.id)).resolves.toEqual(
      supersededAssignment,
    );
    await expect(projection.getAssignment(tenantId, assignmentC.id)).resolves.toEqual(
      successorAssignment,
    );
    await expect(projection.getReview(tenantId, assignmentA.id)).resolves.toEqual(reviewA);
    await expect(projection.listAssignments(tenantId, planId)).resolves.toEqual([
      supersededAssignment,
      assignmentB,
      successorAssignment,
    ]);
  });

  it("reads a >10 assignment generation snapshot from Airtable projections", async () => {
    const tenantId = "tenant-generation";
    const eventId = "event-generation";
    const planId = "plan-generation";
    const roundId = "round-generation";
    const submissionId = "submission-generation";
    const now = "2026-08-10T12:00:00.000Z";
    const committedAt = "2026-08-10T12:15:00.000Z";
    const transport = new FormulaRecordingTransport();
    const plan = {
      id: planId,
      tenantId,
      eventId,
      name: "Generation plan",
      status: "open" as const,
      blindReview: false,
      closesAt: null,
      assignmentRule: { reviewsPerSubmission: 20, maxAssignmentsPerReviewer: 20 },
      rounds: [{ id: roundId, opensAt: null, closesAt: null }],
      version: 3,
      createdAt: now,
      updatedAt: now,
    };
    const previousAssignments = Array.from({ length: 6 }, (_, index) => ({
      id: `a-assignment-generation-${String(index).padStart(2, "0")}`,
      tenantId,
      eventId,
      planId,
      roundId,
      submissionId,
      reviewerId: `reviewer-old-${index}`,
      status: "assigned" as const,
      planVersion: 3,
      rubricRevision: 5,
      roundRevision: 2,
      submissionRevision: 8,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));
    for (const [index, assignment] of previousAssignments.entries()) {
      transport.seed({
        baseId: "base-test",
        table: "Evaluations",
        recordId: `rec${String(210 + index).padStart(14, "0")}`,
        fields: {
          "Application ID": assignment.id,
          "Scores JSON": JSON.stringify({
            ...assignment,
            entityType: "evaluation_assignment",
          }),
        },
      });
    }
    const historicalReview = {
      id: `review:${previousAssignments[0]?.id}`,
      tenantId,
      eventId,
      planId,
      roundId,
      assignmentId: previousAssignments[0]?.id ?? "",
      submissionId,
      reviewerId: previousAssignments[0]?.reviewerId ?? "",
      scores: {},
      comment: "Historical review",
      submittedAt: now,
      version: 1,
      planRevision: 3,
      rubricRevision: 5,
      roundRevision: 2,
      submissionRevision: 8,
      createdAt: now,
      updatedAt: now,
    };
    transport.seed({
      baseId: "base-test",
      table: "Evaluations",
      recordId: "rec00000000000220",
      fields: {
        "Application ID": historicalReview.id,
        "Scores JSON": JSON.stringify({
          ...historicalReview,
          entityType: "evaluation_review",
        }),
      },
    });

    const desiredAssignments = Array.from({ length: 5 }, (_, index) => ({
      id: `z-assignment-generation-${String(index).padStart(2, "0")}`,
      tenantId,
      eventId,
      planId,
      roundId,
      submissionId,
      reviewerId: `reviewer-new-${index}`,
      status: "assigned" as const,
      planVersion: 3,
      rubricRevision: 5,
      roundRevision: 2,
      submissionRevision: 8,
      version: 1,
      createdAt: committedAt,
      updatedAt: committedAt,
    }));
    const supersededAssignments = previousAssignments.map((assignment) => ({
      ...assignment,
      status: "superseded" as const,
      version: 2,
      updatedAt: committedAt,
    }));
    transport.seed({
      baseId: "base-test",
      table: "Review Plans",
      recordId: "rec00000000000200",
      fields: {
        "Application ID": plan.id,
        "Rounds JSON": JSON.stringify({
          ...plan,
          assignmentGenerationSnapshot: {
            version: 1,
            committedAt,
            assignments: [...supersededAssignments, ...desiredAssignments],
          },
        }),
      },
    });
    const projection = new AirtableEvaluationProjectionStore({
      baseId: "base-test",
      transport,
    });

    const listed = await projection.listAssignments(tenantId, planId);
    expect(listed).toHaveLength(11);
    expect(listed.filter((assignment) => assignment.status === "superseded")).toHaveLength(6);
    expect(listed.filter((assignment) => assignment.status === "assigned")).toHaveLength(5);
    await expect(
      projection.getAssignment(tenantId, previousAssignments[0]?.id ?? ""),
    ).resolves.toMatchObject({ status: "superseded", version: 2 });
    await expect(
      projection.getAssignment(tenantId, desiredAssignments[4]?.id ?? ""),
    ).resolves.toEqual(desiredAssignments[4]);
    await expect(
      projection.listOrganizerWorkspaceRecords(tenantId, eventId),
    ).resolves.toMatchObject({
      assignments: desiredAssignments,
      reviews: [historicalReview],
    });
    await expect(
      projection.listReviewerWorkspaceRecords(tenantId, desiredAssignments[4]?.reviewerId ?? "", [
        eventId,
      ]),
    ).resolves.toEqual({
      assignments: [desiredAssignments[4]],
      reviews: [],
    });
    await expect(projection.getReview(tenantId, previousAssignments[0]?.id ?? "")).resolves.toEqual(
      historicalReview,
    );
  });

  it("exposes no Airtable suggestion command methods or PATCH boundary", () => {
    const transport = new FormulaRecordingTransport();
    const projection = new AirtableEvaluationProjectionStore({
      baseId: "base-test",
      transport,
    });
    expect("putSuggestion" in projection).toBe(false);
    expect("resolveSuggestion" in projection).toBe(false);
    expect(
      transport.requests.some(
        (request) => request.method === "PATCH" && request.table === "Evaluations",
      ),
    ).toBe(false);
  });
  it("queues reviewer reminders through the shared outbox with stable idempotency", async () => {
    const transport = new FakeAirtableTransport();
    transport.seed({
      baseId: "base-test",
      table: "Review Plans",
      fields: {
        "Application ID": "plan-reminder",
        "Rounds JSON": JSON.stringify({
          id: "plan-reminder",
          tenantId: "tenant-reminder",
          eventId: "event-reminder",
          name: "Review plan",
          version: 1,
          status: "open",
          rounds: [],
        }),
      },
    });
    const events: string[] = [];
    const { database, outbox } = acceptanceDatabase(events);
    const messages: CloudflareOutboxMessage[] = [];
    const queue = {
      async send(message: CloudflareOutboxMessage) {
        messages.push(message);
      },
    } as unknown as NonNullable<RuntimeBindings["OUTBOX_QUEUE"]>;
    const boundary = new AirtableEvaluationReminderBoundary(
      new AirtableEvaluationProjectionStore({ baseId: "base-test", transport }),
      database,
      queue,
      testSenderAddresses,
    );
    const actor = {
      tenantId: "tenant-reminder",
      userId: "organizer-reminder",
      kind: "human" as const,
      grants: [{ eventId: "event-reminder", role: "organizer" as const }],
    };
    await expect(
      boundary.sendOutstandingReviewerReminders(actor, {
        planId: "plan-reminder",
        roundId: "round-1",
        reviewerIds: ["reviewer-1"],
        assignmentIds: ["assignment-1"],
      }),
    ).resolves.toMatchObject({
      queued: 1,
      reviewerIds: ["reviewer-1"],
      facts: [
        {
          reviewerId: "reviewer-1",
          roundId: "round-1",
          status: "queued",
        },
      ],
    });
    await boundary.sendOutstandingReviewerReminders(actor, {
      planId: "plan-reminder",
      roundId: "round-1",
      reviewerIds: ["reviewer-1"],
      assignmentIds: ["assignment-1"],
    });
    expect(messages).toHaveLength(1);
    expect([...outbox.values()]).toHaveLength(1);
    expect([...outbox.values()][0]).toMatchObject({
      topic: "communications",
      state: "queued",
      payload: {
        effect: "send_email",
        reviewerId: "reviewer-1",
        planId: "plan-reminder",
        roundId: "round-1",
        payload: {
          to: ["speaker@example.test"],
          subject: "Review reminder: Review plan",
        },
      },
    });
    const row = [...outbox.values()][0];
    if (row === undefined) throw new Error("Expected a durable reminder outbox row.");
    const reminderPayload = row.payload as {
      payload?: { idempotencyKey?: string };
    };
    const reminderIdempotencyKey = reminderPayload.payload?.idempotencyKey;
    expect(reminderIdempotencyKey).toMatch(/^evaluation-reminder:/);
    expect(reminderIdempotencyKey?.length).toBeLessThanOrEqual(128);
    expect(
      evaluationReminderAttemptKey("evaluation-reminder:plan:round:reviewer", [
        { state: "dead-letter" },
      ]),
    ).toBe("evaluation-reminder:plan:round:reviewer:retry-1");
    expect(
      evaluationReminderAttemptKey("evaluation-reminder:plan:round:reviewer", [
        { state: "dead-letter" },
        { state: "failed" },
      ]),
    ).toBe("evaluation-reminder:plan:round:reviewer:retry-2");
    expect(
      evaluationReminderAttemptKey("evaluation-reminder:plan:round:reviewer", [
        { state: "delivered" },
      ]),
    ).toBe("evaluation-reminder:plan:round:reviewer");
    expect(EVALUATION_REMINDER_ATTEMPTS_SQL).not.toContain(" LIKE ");
    expect(EVALUATION_REMINDER_ATTEMPTS_SQL).toContain("instr(deduplication_key");
    row.state = "delivered";
    row.completedAt = "2026-08-13T12:00:01.000Z";
    row.updatedAt = row.completedAt;
    await expect(
      boundary.listOutstandingReviewerReminderDeliveries(actor, { planId: "plan-reminder" }),
    ).resolves.toMatchObject([
      {
        reviewerId: "reviewer-1",
        roundId: "round-1",
        status: "delivered",
        completedAt: "2026-08-13T12:00:01.000Z",
      },
    ]);
  });
});
describe("production communication repository composition", () => {
  it("uses event-scoped template and recipient reads and preserves the authorized snapshot", async () => {
    const transport = new FormulaRecordingTransport();
    const tenantId = "communications-tenant";
    const eventId = "communications-event";
    const otherEventId = "other-communications-event";
    const template = {
      id: "group-template",
      tenantId,
      eventId,
      name: "Event update",
      purpose: "organizer_group_email",
      version: 1,
      status: "approved",
      sender: "speakers@sessionboard.namuh.co",
      subject: "Hello {{displayName}}",
      html: "<p>{{displayName}}</p><div>{{message}}</div>",
      text: "Hello {{displayName}}: {{message}}",
      variables: ["displayName", "message"],
      createdBy: "organizer-communications",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      approvedBy: "organizer-communications",
      approvedAt: "2026-08-10T00:00:00.000Z",
      entityType: "communication_template",
    };
    const otherTemplate = { ...template, id: "other-template", eventId: otherEventId };
    const recipient: CommunicationRecipient = {
      id: "participant-communications",
      participantId: "participant-communications",
      tenantId,
      eventId,
      email: "participant@example.test",
      displayName: "Participant",
      audiences: ["all_participants"],
      data: { firstName: "Participant" },
    };
    transport.seed({
      baseId: "base-test",
      table: "Email Templates",
      fields: {
        "Application ID": "template:group-template:v1",
        "Organization ID": tenantId,
        "Event ID": eventId,
        Purpose: "organizer_group_email",
        Status: "approved",
        Sender: "speakers@sessionboard.namuh.co",
        "Settings JSON": JSON.stringify(template),
      },
    });
    transport.seed({
      baseId: "base-test",
      table: "Email Templates",
      fields: {
        "Application ID": "template:other-template:v1",
        "Organization ID": tenantId,
        "Event ID": otherEventId,
        Purpose: "organizer_group_email",
        Status: "approved",
        Sender: "speakers@sessionboard.namuh.co",
        "Settings JSON": JSON.stringify(otherTemplate),
      },
    });
    transport.seed({
      baseId: "base-test",
      table: "Participants",
      fields: {
        "Application ID": recipient.id,
        Event: eventId,
        "Metadata JSON": JSON.stringify({ ...recipient, entityType: "participant" }),
      },
    });
    transport.seed({
      baseId: "base-test",
      table: "Participants",
      fields: {
        "Application ID": "participant-other-event",
        Event: otherEventId,
        "Metadata JSON": JSON.stringify({
          ...recipient,
          id: "participant-other-event",
          eventId: otherEventId,
          email: "other-event@example.test",
          entityType: "participant",
        }),
      },
    });

    const repository = new AirtableCommunicationRepository({
      baseId: "base-test",
      transport,
    });
    const listed = await repository.listTemplates(tenantId, eventId, "organizer_group_email");
    expect(listed.map((item) => item.id)).toEqual(["group-template"]);
    const templateRequest = transport.requests.find(
      (request) => request.method === "GET" && request.table === "Email Templates",
    );
    expect(String(templateRequest?.query?.filterByFormula)).toBe(
      `AND({Organization ID}='${tenantId}',{Event ID}='${eventId}',{Purpose}='organizer_group_email')`,
    );

    transport.requests.length = 0;
    const service = new CommunicationService(repository, undefined, {
      clock: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    const actor: CommunicationActor = {
      tenantId,
      userId: "organizer-communications",
      kind: "human",
      grants: [{ eventId, role: "organizer" }],
    };
    const preview = await service.previewGroupSend(actor, {
      eventId,
      purpose: "organizer_group_email",
      templateId: "group-template",
      audience: "all_participants",
      data: { message: "Scoped update" },
    });

    expect(preview.recipientCount).toBe(1);
    expect(preview.recipients).toEqual([recipient]);
    for (const [table, count] of [
      ["Participants", 2],
      ["Submissions", 2],
      ["Decisions", 1],
    ] as const) {
      const reads = transport.requests.filter(
        (request) => request.method === "GET" && request.table === table,
      );
      expect(reads).toHaveLength(count);
      expect(reads.every((request) => typeof request.query?.filterByFormula === "string")).toBe(
        true,
      );
    }
    expect(
      transport.requests.filter(
        (request) => request.method === "GET" && request.table === "Email Templates",
      ),
    ).toHaveLength(1);
    expect(
      transport.requests.filter(
        (request) => request.method === "GET" && request.table === "Email Send Snapshots",
      ),
    ).toHaveLength(1);
    expect(
      transport.requests.filter(
        (request) => request.method === "POST" && request.table === "Email Send Snapshots",
      ),
    ).toHaveLength(1);
  });
});
