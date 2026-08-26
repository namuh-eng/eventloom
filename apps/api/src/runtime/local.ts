import {
  type ApiScope,
  localDateInTimeZone,
  standardPresentationUploadMimeTypes,
} from "@eventloom/contracts";
import type { ApiDependencies } from "../app";
import { AgendaCatalogSynchronizer } from "../features/agenda/catalog-sync";
import {
  AgendaEngine,
  AgendaError,
  DeterministicAgendaSuggestionProvider,
} from "../features/agenda/engine";
import {
  InMemoryAgendaMutationLock,
  InMemoryAgendaRepository,
} from "../features/agenda/infrastructure";
import { neutralSpeakerDisplayName } from "../features/agenda/speaker-labels";
import type {
  AgendaEntryInput,
  AgendaRepository,
  PublishedAgendaRevision,
} from "../features/agenda/types";
import { RequestAuthenticator } from "../features/auth/authenticator";
import type {
  ApiKeyScope,
  AuthPrincipal,
  BetterAuthGateway,
  D1ApiKeyGateway,
} from "../features/auth/types";
import type { EventCfp, Submission } from "../features/cfp/model";
import { CfpError } from "../features/cfp/service";
import {
  CommunicationService,
  InMemoryCommunicationRepository,
} from "../features/communications/service";
import type {
  CommunicationDeliveryAdapter,
  CommunicationRecipient,
  CommunicationSenderIdentities,
  CommunicationTemplate,
} from "../features/communications/types";
import { CrmService, InMemoryCrmRepository } from "../features/crm/service";
import { evaluationRolesForPrincipal } from "../features/evaluations/access";
import {
  InMemoryEvaluationRepository,
  InMemorySubmissionReviewSource,
} from "../features/evaluations/repository";
import {
  type EvaluationAcceptanceHandoff,
  type EvaluationAcceptanceHandoffInput,
  EvaluationService,
} from "../features/evaluations/service";
import type {
  EvaluationActor,
  EvaluationPlan,
  SubmissionReviewMaterial,
} from "../features/evaluations/types";
import { InMemoryEventRoleInvitationRepository } from "../features/event-invitations/memory";
import type {
  EventRoleInvitation,
  EventRoleInvitationTransitionInput,
} from "../features/event-invitations/types";
import {
  EventService,
  EventServiceError,
  InMemoryEventRepository,
  InMemoryProgramPublicationRepository,
  ProgramPublicationService,
} from "../features/events/service";
import type {
  Event,
  EventEmbedConfiguration,
  ProgramPublicationManifest,
} from "../features/events/types";
import {
  InMemoryMemberAuthBoundary,
  InMemoryMemberIdentityRepository,
  InMemoryMemberInvitationDelivery,
  InMemoryReviewerPoolRepository,
  MemberService,
} from "../features/members/service";
import type { MemberMembership, MemberUser, ReviewerPool } from "../features/members/types";
import type {
  PublicApiCreateInput,
  PublicApiGetInput,
  PublicApiListInput,
  PublicApiListResult,
  PublicApiRepository,
  PublicApiUpdateInput,
} from "../features/public-api/routes";
import { RemixService } from "../features/remix/service";
import type {
  ContentRemixCandidate,
  RemixAuditEntry,
  RemixContentGateway,
  RemixRepository,
  RemixSessionRecord,
  RemixSpeakerRecord,
} from "../features/remix/types";
import { InMemoryReportRepository, ReportService } from "../features/reports/service";
import type { ReportProgramRecord } from "../features/reports/types";
import { InMemorySessionRepository, SessionService } from "../features/sessions/service";
import type { DecisionVersionFence, Session } from "../features/sessions/types";
import { CommunicationSpeakerCommunications } from "../features/speaker/communications";
import { SpeakerService } from "../features/speaker/service";
import type {
  CreatePendingSpeakerAssetVersionCommand,
  CreatePrivateUploadGrantCommand,
  FinalizeSpeakerAssetCommand,
  PrivateAssetCapabilityBinding,
  PrivateAssetGateway,
  PrivateDownloadCapabilityBinding,
  PrivateDownloadGrant,
  PrivateUploadGrant,
  RepositoryResult,
  RestoreSpeakerContentVersionCommand,
  SpeakerAccessScope,
  SpeakerAccountWorkloadRepository,
  SpeakerAsset,
  SpeakerAssetAuditEntry,
  SpeakerAssetComment,
  SpeakerAssetReviewCommand,
  SpeakerCanonicalSession,
  SpeakerContentHistoryEntry,
  SpeakerContentRecord,
  SpeakerEventResource,
  SpeakerOrganizerLifecycleRepository,
  SpeakerOrganizerReadModel,
  SpeakerPortalCapability,
  SpeakerPortalContext,
  SpeakerProfile,
  SpeakerRosterEntry,
  SpeakerSubmission,
  SpeakerTask,
  SpeakerTaskTransition,
  SpeakerWikiPage,
  TransitionSpeakerTaskCommand,
  UpdateBiographyCommand,
  UpdateSpeakerContentCommand,
  UpdateSpeakerProfileCommand,
} from "../features/speaker/types";
import { selectReleasedSpeakerHeadshot } from "../infrastructure/cloudflare/repositories/published-speakers";
import type { CloudflareAiProviders } from "../integrations/ai";
import type { CalendarIntegrationOptions } from "../integrations/calendar";
import { InMemoryWebhookRepository } from "../integrations/webhooks/types";
import { invalidatePublishedAgendaCache } from "../routes/agenda";
import type {
  IntegrationAdminRouteDependencies,
  IntegrationApiKeyCreation,
  IntegrationApiKeySummary,
  IntegrationDeliveryStatus,
  IntegrationEvent,
  IntegrationWebhookDelivery,
} from "../routes/integrations";
import type {
  OrganizerOverviewActionItem,
  OrganizerOverviewActivityData,
  OrganizerOverviewCoreData,
  OrganizerOverviewEvent,
  OrganizerOverviewRouteDependencies,
} from "../routes/organizer-overview";
import {
  invalidatePublishedSpeakerCache,
  type PublishedSpeakerProjection,
  publishedSpeakerPhotoPath,
} from "../routes/public-speakers";
import { createLocalCfpService, seedLocalCfpForm } from "./cfp";
import { createRuntimeEventRoleInvitationAdapters } from "./d1";
import { seedLocalCfpScenario } from "./local-cfp-scenario";
import { seedLocalEvaluationWorkflow } from "./local-evaluation-workflow";
import { LOCAL_REVIEW_SCENARIO_REVIEWERS, localSubmissionScenario } from "./local-review-scenario";

export {
  LOCAL_API_KEY,
  LOCAL_ORGANIZATION_ID,
  LOCAL_SESSION_TOKEN,
  LOCAL_SPEAKER_ACCOUNT_ID,
} from "./constants";

import {
  LOCAL_API_KEY,
  LOCAL_ORGANIZATION_ID,
  LOCAL_SESSION_TOKEN,
  LOCAL_SPEAKER_ACCOUNT_ID,
} from "./constants";

const SEEDED_AT = "2026-08-08T12:00:00.000Z";
const EVENT_SEED_AT = "2026-07-31T12:00:00.000Z";
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const LOCAL_API_KEY_SCOPES: readonly ApiKeyScope[] = [
  "events:read",
  "events:write",
  "submissions:read",
  "submissions:write",
  "agenda:read",
  "agenda:write",
  "webhooks:read",
  "webhooks:write",
];
const LOCAL_SPEAKER_CAPABILITIES = [
  "profile-self",
  "submission-edit",
  "roster-manage",
  "task-response",
  "asset-read",
  "asset-write",
  "asset-comment",
  "resource-read",
] as const satisfies readonly SpeakerPortalCapability[];

const LOCAL_EVENT_START = "2026-09-18T16:00:00.000Z";
const LOCAL_EVENT_END = "2026-09-18T23:00:00.000Z";
const LOCAL_EVENT_TIME_ZONE = "America/Los_Angeles";
const LOCAL_EVENT_VENUE = "Eventloom Hall";
const LOCAL_COMMUNICATION_SENDERS = {
  auth: "auth@local.eventloom.test",
  speakers: "speakers@local.eventloom.test",
  calendar: "calendar@local.eventloom.test",
} as const satisfies CommunicationSenderIdentities;
const LOCAL_CALENDAR_OPTIONS = {
  organizer: LOCAL_COMMUNICATION_SENDERS.calendar,
  uidDomain: "calendar.local.eventloom.test",
} as const satisfies CalendarIntegrationOptions;

const LOCAL_PUBLIC_EMBED: EventEmbedConfiguration = {
  id: "public-schedule",
  name: "Public schedule",
  widgetId: "agenda",
  enabled: true,
  theme: "light",
  outputFormat: "styled-html",
  layout: "comfortable",
  accent: "#4f5ee8",
  backgroundColor: "#ffffff",
  textColor: "#20232b",
  customCss: "",
  displayFields: ["title", "date-time", "room", "speakers", "track", "summary"],
  trackIds: ["local-track-main", "local-track-practice"],
  statuses: ["Accepted"],
  revision: 1,
};

export const LOCAL_ORGANIZER_ACCOUNT_ID = "local-organizer";
export const LOCAL_REVIEWER_ACCOUNT_ID = "local-reviewer";
export const LOCAL_ORGANIZER_EMAIL = "organizer@local.eventloom.test";
export const LOCAL_REVIEWER_EMAIL = "reviewer@local.eventloom.test";
export const LOCAL_SPEAKER_EMAIL = "speaker@local.eventloom.test";
export const LOCAL_ORGANIZER_PASSWORD = "organizer-local";
export const LOCAL_REVIEWER_PASSWORD = "reviewer-local";
export const LOCAL_SPEAKER_PASSWORD = "speaker-local";

export const LOCAL_ORGANIZER_SESSION_TOKEN = LOCAL_SESSION_TOKEN;
export const LOCAL_REVIEWER_SESSION_TOKEN = "local-reviewer-session";
export const LOCAL_SPEAKER_SESSION_TOKEN = "local-speaker-session";

type LocalPersona = {
  readonly key: "organizer" | "reviewer" | "speaker" | "applicant";
  readonly sessionToken: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly password: string;
  readonly memberships: readonly { organizationId: string; role: "owner" | "reviewer" }[];
  readonly speakerGrants: readonly { organizationId: string; speakerProfileId: string }[];
};

const LOCAL_PERSONAS: readonly LocalPersona[] = [
  {
    key: "organizer",
    sessionToken: LOCAL_ORGANIZER_SESSION_TOKEN,
    sessionId: "local-organizer-session-id",
    userId: LOCAL_ORGANIZER_ACCOUNT_ID,
    email: LOCAL_ORGANIZER_EMAIL,
    name: "Local Organizer",
    password: LOCAL_ORGANIZER_PASSWORD,
    memberships: [{ organizationId: LOCAL_ORGANIZATION_ID, role: "owner" }],
    speakerGrants: [],
  },
  ...LOCAL_REVIEW_SCENARIO_REVIEWERS.map(
    (reviewer, index): LocalPersona => ({
      key: "reviewer",
      sessionToken: reviewer.sessionToken,
      sessionId: index === 0 ? "local-reviewer-session-id" : `${reviewer.id}-session-id`,
      userId: reviewer.id,
      email: reviewer.email,
      name: reviewer.name,
      password: reviewer.password,
      memberships: [{ organizationId: LOCAL_ORGANIZATION_ID, role: "reviewer" }],
      speakerGrants: [],
    }),
  ),
  {
    key: "speaker",
    sessionToken: LOCAL_SPEAKER_SESSION_TOKEN,
    sessionId: "local-speaker-session-id",
    userId: LOCAL_SPEAKER_ACCOUNT_ID,
    email: LOCAL_SPEAKER_EMAIL,
    name: "Alex Rivera",
    password: LOCAL_SPEAKER_PASSWORD,
    memberships: [],
    speakerGrants: [
      {
        organizationId: LOCAL_ORGANIZATION_ID,
        speakerProfileId: "cfp-profile:local-participant",
      },
    ],
  },
];

function localPersonaForToken(
  personas: readonly LocalPersona[],
  token: string,
): LocalPersona | null {
  return personas.find((persona) => persona.sessionToken === token) ?? null;
}

function localPersonaForCredentials(
  personas: readonly LocalPersona[],
  email: string,
  password: string,
): LocalPersona | null {
  return (
    personas.find(
      (persona) => persona.email === email.trim().toLowerCase() && persona.password === password,
    ) ?? null
  );
}

function localCookieToken(request: Request): string | null {
  const prefix = `${LOCAL_SESSION_COOKIE}=`;
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  return value === undefined || value.length === 0 ? null : value;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}

async function sourceHash(value: unknown): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function localAuthenticator(
  personas: readonly LocalPersona[],
  invitations: InMemoryEventRoleInvitationRepository,
): RequestAuthenticator {
  const sessions: BetterAuthGateway = {
    async resolveSession(token) {
      const persona = localPersonaForToken(personas, token);
      if (persona === null) return null;
      const acceptedInvitations = await invitations.listForVerifiedAccount(
        persona.userId,
        persona.email,
      );
      return {
        sessionId: persona.sessionId,
        userId: persona.userId,
        displayName: persona.name,
        email: persona.email,
        emailVerified: true,
        expiresAt: FAR_FUTURE,
        memberships: persona.memberships,
        reviewerGrants: acceptedInvitations.flatMap((invitation) =>
          invitation.status === "accepted" && invitation.role === "reviewer"
            ? [{ organizationId: invitation.organizationId, eventId: invitation.eventId }]
            : [],
        ),
        speakerGrants: [
          ...persona.speakerGrants,
          ...acceptedInvitations.flatMap((invitation) =>
            invitation.status === "accepted" &&
            invitation.role === "speaker" &&
            invitation.participantId !== null
              ? [
                  {
                    organizationId: invitation.organizationId,
                    speakerProfileId: `cfp-profile:${invitation.participantId}`,
                  },
                ]
              : [],
          ),
        ],
      };
    },
    async requestMagicLink() {},
    async consumeMagicLink() {
      return null;
    },
  };
  const apiKeys: D1ApiKeyGateway = {
    async findByPresentedKey(token) {
      if (token !== LOCAL_API_KEY) return null;
      return {
        id: "local-api-key-id",
        organizationId: LOCAL_ORGANIZATION_ID,
        label: "Local development",
        scopes: LOCAL_API_KEY_SCOPES,
        expiresAt: null,
        revokedAt: null,
      };
    },
    async recordSuccessfulUse() {},
  };
  return new RequestAuthenticator(sessions, apiKeys, {
    clock: { now: () => new Date(SEEDED_AT) },
  });
}

const LOCAL_SESSION_COOKIE = "better-auth.session_token";

function localSessionPayload(persona: LocalPersona): Record<string, unknown> {
  return {
    session: {
      id: persona.sessionId,
      userId: persona.userId,
      expiresAt: FAR_FUTURE.toISOString(),
    },
    user: {
      id: persona.userId,
      email: persona.email,
      name: persona.name,
      emailVerified: true,
    },
    memberships: persona.memberships,
    reviewerGrants: [],
    speakerGrants: persona.speakerGrants,
  };
}

function localAuthCookieHeader(sessionToken: string): string {
  return `${LOCAL_SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`;
}

function localPersonaForRequest(
  personas: readonly LocalPersona[],
  request: Request,
): LocalPersona | null {
  const token = localCookieToken(request);
  return token === null ? null : localPersonaForToken(personas, token);
}
function localAuthJson(payload: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

/**
 * Email/password sign-in for local development only. Local mode has no
 * better-auth instance or user database; deterministic fixture credentials issue
 * one of the organizer, reviewer, or speaker sessions.
 */
function localAuthRoutes(personas: LocalPersona[]): {
  handler: (request: Request) => Promise<Response>;
} {
  return {
    async handler(request) {
      const path = new URL(request.url).pathname;
      if (
        (path === "/api/auth/sign-in/email" || path === "/api/auth/sign-up/email") &&
        request.method === "POST"
      ) {
        const body: { email?: unknown; password?: unknown; name?: unknown } = await request
          .clone()
          .json<{ email?: unknown; password?: unknown; name?: unknown }>()
          .catch(() => ({}));
        let persona =
          typeof body.email === "string" && typeof body.password === "string"
            ? localPersonaForCredentials(personas, body.email, body.password)
            : null;
        if (
          persona === null &&
          path === "/api/auth/sign-up/email" &&
          typeof body.email === "string" &&
          typeof body.password === "string" &&
          typeof body.name === "string"
        ) {
          const email = body.email.trim().toLowerCase();
          const name = body.name.trim();
          if (email.length > 0 && body.password.length > 0 && name.length > 0) {
            const identity = crypto.randomUUID();
            persona = {
              key: "applicant",
              sessionToken: `local-applicant-${identity}`,
              sessionId: `local-applicant-session-${identity}`,
              userId: `local-applicant-${identity}`,
              email,
              name,
              password: body.password,
              memberships: [],
              speakerGrants: [],
            };
            personas.push(persona);
          }
        }
        if (persona === null) {
          return localAuthJson({ error: { code: "INVALID_EMAIL_OR_PASSWORD" } }, { status: 401 });
        }
        const authenticatedPersona = persona;
        return localAuthJson(
          {
            token: authenticatedPersona.sessionToken,
            ...localSessionPayload(authenticatedPersona),
          },
          {
            headers: {
              "set-cookie": localAuthCookieHeader(authenticatedPersona.sessionToken),
            },
          },
        );
      }
      if (path === "/api/auth/sign-in/magic-link" && request.method === "POST") {
        return localAuthJson({ status: true });
      }
      if (path === "/api/auth/get-session" && request.method === "GET") {
        const persona = localPersonaForRequest(personas, request);
        if (persona === null) return localAuthJson(null, { status: 401 });
        return localAuthJson(localSessionPayload(persona));
      }
      if (path === "/api/auth/sign-out" && request.method === "POST") {
        return localAuthJson(
          { success: true },
          {
            headers: {
              "set-cookie": `${LOCAL_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
            },
          },
        );
      }
      return localAuthJson(
        { code: "LOCAL_AUTH_UNSUPPORTED", message: "This auth route is not available locally." },
        { status: 404 },
      );
    },
  };
}

export class LocalSpeakerRepository
  implements SpeakerAccountWorkloadRepository, SpeakerOrganizerLifecycleRepository
{
  readonly #submissions = new Map<string, SpeakerSubmission[]>();
  readonly #profiles = new Map<string, SpeakerProfile[]>();
  readonly #tasks = new Map<string, SpeakerTask[]>();
  readonly #assets = new Map<string, SpeakerAsset[]>();
  readonly #assetComments = new Map<string, SpeakerAssetComment[]>();
  readonly #assetAudit = new Map<string, SpeakerAssetAuditEntry[]>();
  readonly #taskTransitions = new Map<string, SpeakerTaskTransition[]>();
  readonly #assetVersionCreations = new Map<string, { requestDigest: string; assetId: string }>();
  readonly #content = new Map<string, SpeakerContentRecord>();
  readonly #contentHistory = new Map<string, SpeakerContentHistoryEntry[]>();
  readonly #cfpPortalContexts = new Map<string, SpeakerPortalContext>();
  readonly #importPreviews = new Map<
    string,
    Awaited<ReturnType<SpeakerOrganizerLifecycleRepository["saveOrganizerSpeakerImportPreview"]>>
  >();
  readonly #aggregateOperations = new Map<string, { digest: string; participantIds: string[] }>();
  #canonicalSessionReader?: (eventId: string) => Promise<readonly SpeakerCanonicalSession[]>;

  setCanonicalSessionReader(
    reader: (eventId: string) => Promise<readonly SpeakerCanonicalSession[]>,
  ): void {
    this.#canonicalSessionReader = reader;
  }

  constructor(
    private readonly invitationRecipientForEmail: (
      email: string,
    ) => { userId: string; normalizedEmail: string } | null,
    private readonly beforeReviewCommit?: (tasks: Map<string, SpeakerTask[]>) => void,
    private readonly decisionFenceChecker?: (fence: DecisionVersionFence) => Promise<boolean>,
  ) {}

  async resolveVerifiedInvitationRecipient(email: string) {
    return this.invitationRecipientForEmail(email.trim().toLowerCase());
  }

  #aggregateOperationKey(
    organizationId: string,
    eventId: string,
    operationType: "create" | "import" | "revoke" | "update",
    idempotencyKey: string,
  ): string {
    return `${organizationId}\u0000${eventId}\u0000${operationType}\u0000${idempotencyKey}`;
  }

  #contentKey(eventId: string, entityType: "session" | "speaker", entityId: string): string {
    return `${eventId}\u0000${entityType}\u0000${entityId}`;
  }

  #ensureEvent(eventId: string): void {
    if (!this.#submissions.has(eventId)) this.#submissions.set(eventId, []);
    if (!this.#profiles.has(eventId)) this.#profiles.set(eventId, []);
    if (!this.#tasks.has(eventId)) this.#tasks.set(eventId, []);
    if (!this.#assets.has(eventId)) this.#assets.set(eventId, []);
    if (!this.#assetComments.has(eventId)) this.#assetComments.set(eventId, []);
    if (!this.#assetAudit.has(eventId)) this.#assetAudit.set(eventId, []);
    if (!this.#taskTransitions.has(eventId)) this.#taskTransitions.set(eventId, []);
  }

  listStoredSubmissions(eventId: string): SpeakerSubmission[] {
    return clone(this.#submissions.get(eventId) ?? []);
  }

  listStoredTasks(eventId: string): SpeakerTask[] {
    return clone(this.#tasks.get(eventId) ?? []);
  }

  registerCfpSubmission(submission: Submission, submissionTitle: string, eventName: string): void {
    const primary =
      submission.participants.find((participant) => participant.role === "primary") ??
      submission.participants[0];
    if (primary === undefined) return;
    const submissions = this.#submissions.get(submission.eventId) ?? [];
    this.#submissions.set(submission.eventId, [
      ...submissions.filter(({ id }) => id !== submission.id),
      {
        id: submission.id,
        eventId: submission.eventId,
        formId: submission.formId,
        title: submissionTitle,
        status: "submitted",
        participantIds: submission.participants.map(({ id }) => id),
        primaryParticipantId: primary.id,
        version: submission.version,
        answers: submission.answers,
        updatedAt: submission.updatedAt,
      },
    ]);
    const profiles = this.#profiles.get(submission.eventId) ?? [];
    const projectedProfiles = submission.participants.map((participant): SpeakerProfile => {
      const profile: SpeakerProfile = {
        id: `cfp-profile:${participant.id}`,
        eventId: submission.eventId,
        participantId: participant.id,
        displayName:
          [participant.firstName, participant.lastName].filter(Boolean).join(" ") ||
          participant.email ||
          "Speaker",
        biography: participant.biography,
        version: submission.version,
        updatedAt: submission.updatedAt,
      };
      return participant.email ? { ...profile, email: participant.email } : profile;
    });
    const projectedIds = new Set(projectedProfiles.map(({ participantId }) => participantId));
    this.#profiles.set(submission.eventId, [
      ...profiles.filter(({ participantId }) => !projectedIds.has(participantId)),
      ...projectedProfiles,
    ]);
    for (const participant of submission.participants) {
      const content: SpeakerContentRecord = {
        id: `speaker-content:${submission.eventId}:${participant.id}`,
        tenantId: LOCAL_ORGANIZATION_ID,
        eventId: submission.eventId,
        entityType: "speaker",
        entityId: participant.id,
        biography: participant.biography,
        version: 1,
        updatedAt: submission.updatedAt,
        updatedBy: submission.ownerAccountId,
      };
      const contentKey = this.#contentKey(submission.eventId, content.entityType, content.entityId);
      if (!this.#content.has(contentKey)) {
        this.#content.set(contentKey, content);
        this.#contentHistory.set(contentKey, [
          {
            id: `local-speaker-content-history-${participant.id}-1`,
            eventId: submission.eventId,
            entityType: "speaker",
            entityId: participant.id,
            action: "created",
            version: 1,
            actorAccountId: submission.ownerAccountId,
            actorLabel: "CFP submission",
            occurredAt: submission.updatedAt,
            snapshot: clone(content),
          },
        ]);
      }
    }
    this.#cfpPortalContexts.set(submission.ownerAccountId, {
      id: `portal:${LOCAL_ORGANIZATION_ID}:${submission.eventId}:${primary.id}`,
      eventId: submission.eventId,
      name: eventName,
      slug: submission.eventId,
      capabilities: ["submission-edit"],
      submissionIds: [submission.id],
      participantIds: submission.participants.map(({ id }) => id),
      primaryParticipantId: primary.id,
    });
  }

  async getAccessScope(eventId: string, accountId: string): Promise<SpeakerAccessScope> {
    this.#ensureEvent(eventId);
    const cfpContext = this.#cfpPortalContexts.get(accountId);
    if (cfpContext?.eventId === eventId) {
      return {
        tenantId: LOCAL_ORGANIZATION_ID,
        role: "speaker",
        organizer: false,
        submissionIds: [...cfpContext.submissionIds],
        participantIds: [...cfpContext.participantIds],
        capabilities: [...cfpContext.capabilities],
        capabilitiesByParticipant: Object.fromEntries(
          cfpContext.participantIds.map((participantId) => [
            participantId,
            [...cfpContext.capabilities],
          ]),
        ),
        ...(cfpContext.primaryParticipantId === undefined
          ? {}
          : { primaryParticipantId: cfpContext.primaryParticipantId }),
      };
    }
    if (accountId !== LOCAL_ORGANIZER_ACCOUNT_ID) {
      return { submissionIds: [], participantIds: [] };
    }
    const submissions = this.#submissions.get(eventId) ?? [];
    const participantIds = [
      ...new Set(submissions.flatMap(({ participantIds }) => participantIds)),
    ];
    return {
      tenantId: LOCAL_ORGANIZATION_ID,
      role: "owner",
      organizer: true,
      submissionIds: submissions.map(({ id }) => id),
      participantIds,
      capabilities: LOCAL_SPEAKER_CAPABILITIES,
      capabilitiesByParticipant: Object.fromEntries(
        participantIds.map((participantId) => [participantId, [...LOCAL_SPEAKER_CAPABILITIES]]),
      ),
    };
  }
  async getAccessScopeForOrganization(
    organizationId: string,
    eventId: string,
    accountId: string,
  ): Promise<SpeakerAccessScope> {
    if (organizationId !== LOCAL_ORGANIZATION_ID) {
      return { submissionIds: [], participantIds: [] };
    }
    const scope = await this.getAccessScope(eventId, accountId);
    return scope.tenantId === organizationId ? scope : { submissionIds: [], participantIds: [] };
  }
  async listPortalContexts(accountId: string) {
    return (await this.listPortalContextScopes(accountId)).map(({ context }) => context);
  }
  async listPortalContextScopes(accountId: string) {
    const cfpContext = this.#cfpPortalContexts.get(accountId);
    if (cfpContext === undefined) return [];
    const scope = await this.getAccessScope(cfpContext.eventId, accountId);
    return [
      {
        context: clone(cfpContext),
        scope,
        speakerProfileIds: (await this.listProfiles(cfpContext.eventId, scope.participantIds)).map(
          (profile) => profile.id,
        ),
      },
    ];
  }
  async listPortalCanonicalSessions(): Promise<readonly SpeakerCanonicalSession[]> {
    // Local CFP contexts are not explicit speaker invitations, so they confer no session access.
    return [];
  }

  async getOrganizerAccessScope(eventId: string, accountId: string) {
    if (accountId !== LOCAL_ORGANIZER_ACCOUNT_ID) return null;
    this.#ensureEvent(eventId);
    const submissions = this.#submissions.get(eventId) ?? [];
    return {
      tenantId: LOCAL_ORGANIZATION_ID,
      eventId,
      role: "owner" as const,
      submissionIds: submissions.map(({ id }) => id),
      participantIds: [
        ...new Set([
          ...submissions.flatMap(({ participantIds }) => participantIds),
          ...(this.#profiles.get(eventId) ?? []).map(({ participantId }) => participantId),
        ]),
      ],
    };
  }
  async getAccountDisplayName(accountId: string): Promise<string | null> {
    return LOCAL_PERSONAS.find((persona) => persona.userId === accountId)?.name ?? null;
  }

  async listActiveParticipantIds(organizationId: string, eventId: string): Promise<string[]> {
    if (organizationId !== LOCAL_ORGANIZATION_ID) return [];
    this.#ensureEvent(eventId);
    return (this.#profiles.get(eventId) ?? [])
      .filter(({ status }) => status !== "revoked")
      .map(({ participantId }) => participantId)
      .sort();
  }

  async getOrganizerReadModel(
    eventId: string,
    accountId: string,
    resources: Parameters<SpeakerOrganizerLifecycleRepository["getOrganizerReadModel"]>[2],
  ): Promise<SpeakerOrganizerReadModel | null> {
    const scope = await this.getOrganizerAccessScope(eventId, accountId);
    if (scope === null) return null;
    if (this.#canonicalSessionReader === undefined) {
      throw new Error("Canonical session reader unavailable");
    }
    const canonicalSessions = await this.#canonicalSessionReader(eventId);
    const submissions = await this.listSubmissions(eventId, scope.submissionIds);
    const profiles = resources.profiles === true ? clone(this.#profiles.get(eventId) ?? []) : [];
    const tasks = resources.tasks === true ? clone(this.#tasks.get(eventId) ?? []) : [];
    const assets = resources.assets === true ? clone(this.#assets.get(eventId) ?? []) : [];
    const roster = profiles.map((profile) => {
      const submissionId = submissions.find((submission) =>
        submission.participantIds.includes(profile.participantId),
      )?.id;
      return {
        id: profile.id,
        eventId,
        ...(submissionId === undefined ? {} : { submissionId }),
        participantId: profile.participantId,
        displayName: profile.displayName,
        ...(profile.email === undefined ? {} : { email: profile.email }),
        ...(profile.jobTitle === undefined ? {} : { jobTitle: profile.jobTitle }),
        ...(profile.company === undefined ? {} : { company: profile.company }),
        biography: profile.biography,
        ...(profile.socialLinks === undefined ? {} : { socialLinks: profile.socialLinks }),
        ...(profile.travelLogistics === undefined
          ? {}
          : { travelLogistics: profile.travelLogistics }),
        ...(profile.sourceType === undefined ? {} : { sourceType: profile.sourceType }),
        ...(profile.sourceId === undefined ? {} : { sourceId: profile.sourceId }),
        role: "primary" as const,
        status:
          profile.status === "revoked"
            ? ("revoked" as const)
            : profile.status === "active"
              ? ("active" as const)
              : ("pending" as const),
        workflowStatus: profile.status ?? "pending",
        organizerStatus: profile.status ?? "pending",
        version: profile.version,
        createdAt: profile.updatedAt,
        updatedAt: profile.updatedAt,
      };
    });
    return { scope, submissions, roster, profiles, tasks, assets, canonicalSessions };
  }

  async resolveEventParticipant(
    input: Parameters<SpeakerOrganizerLifecycleRepository["resolveEventParticipant"]>[0],
  ): ReturnType<SpeakerOrganizerLifecycleRepository["resolveEventParticipant"]> {
    this.#ensureEvent(input.eventId);
    const profiles = this.#profiles.get(input.eventId) ?? [];
    const matches = profiles.filter(
      (profile) =>
        profile.participantId === input.explicitParticipantId ||
        (profile.sourceType === input.sourceType && profile.sourceId === input.sourceId) ||
        (input.normalizedEmail !== undefined &&
          profile.email?.trim().toLowerCase() === input.normalizedEmail),
    );
    if (matches.length > 1) {
      return Promise.resolve({
        state: "ambiguous",
        candidateParticipantIds: matches.map((profile) => profile.participantId),
      });
    }
    const participantId = matches[0]?.participantId ?? input.createParticipantId;
    return Promise.resolve({
      state: "resolved",
      participantId,
      submissionIds: (this.#submissions.get(input.eventId) ?? [])
        .filter((submission) => submission.participantIds.includes(participantId))
        .map((submission) => submission.id),
      created: matches.length === 0,
    });
  }

  saveOrganizerSpeakerImportPreview(
    command: Parameters<
      SpeakerOrganizerLifecycleRepository["saveOrganizerSpeakerImportPreview"]
    >[0],
  ): ReturnType<SpeakerOrganizerLifecycleRepository["saveOrganizerSpeakerImportPreview"]> {
    const preview = {
      previewId: command.previewId,
      sourceDigest: command.sourceDigest,
      rosterRevision: (this.#profiles.get(command.eventId) ?? []).length,
      validRows: clone(command.rows),
      invalidRows: [],
    };
    this.#importPreviews.set(command.previewId, preview);
    return Promise.resolve(clone(preview));
  }

  async commitOrganizerSpeakerImport(
    command: Parameters<SpeakerOrganizerLifecycleRepository["commitOrganizerSpeakerImport"]>[0],
  ): ReturnType<SpeakerOrganizerLifecycleRepository["commitOrganizerSpeakerImport"]> {
    const operationKey = this.#aggregateOperationKey(
      command.organizationId,
      command.eventId,
      "import",
      command.idempotencyKey,
    );
    const existing = this.#aggregateOperations.get(operationKey);
    if (existing !== undefined) {
      if (command.sourceDigest !== undefined && command.sourceDigest !== existing.digest) {
        throw new Error("The import idempotency key belongs to another payload.");
      }
      return { participantIds: [...existing.participantIds], replayed: true };
    }
    const preview = this.#importPreviews.get(command.previewId);
    if (
      preview === undefined ||
      (command.sourceDigest !== undefined && preview.sourceDigest !== command.sourceDigest)
    ) {
      throw new Error("The speaker import preview is invalid.");
    }
    const participantIds: string[] = [];
    for (const row of preview.validRows) {
      const participantId = `local-import:${command.previewId}:${row.rowNumber}`;
      participantIds.push(participantId);
      const result = await this.upsertOrganizerSpeakerAggregate({
        organizationId: command.organizationId,
        eventId: command.eventId,
        accountId: command.accountId,
        participantId,
        profileId: `local-profile:${command.eventId}:${participantId}`,
        displayName: row.displayName,
        email: row.email,
        jobTitle: row.jobTitle,
        company: row.company,
        biography: row.biography,
        socialLinks: row.socialLinks,
        travelLogistics: {
          travelRequired: false,
          arrivalAt: null,
          departureAt: null,
          accommodation: "",
          dietaryRequirements: "",
          accessibilityNeeds: "",
          travelNotes: "",
        },
        status: row.status ?? "pending",
        sourceType: "csv",
        sourceId: `${command.previewId}:row:${row.rowNumber}`,
        expectedVersion: null,
        updatedAt: command.committedAt,
      });
      if (!result.ok) throw new Error("The speaker import could not be committed.");
    }
    this.#aggregateOperations.set(operationKey, {
      digest: preview.sourceDigest ?? "",
      participantIds,
    });
    return { participantIds, replayed: false };
  }

  upsertOrganizerSpeakerAggregate(
    command: Parameters<SpeakerOrganizerLifecycleRepository["upsertOrganizerSpeakerAggregate"]>[0],
  ): ReturnType<SpeakerOrganizerLifecycleRepository["upsertOrganizerSpeakerAggregate"]> {
    this.#ensureEvent(command.eventId);
    if (command.organizationId !== LOCAL_ORGANIZATION_ID) {
      return Promise.resolve({ ok: false, reason: "not_found" });
    }
    const profiles = this.#profiles.get(command.eventId) ?? [];
    const digest = command.sourceDigest ?? "";
    const operationType =
      command.expectedVersion === null
        ? "create"
        : command.status === "revoked"
          ? "revoke"
          : "update";
    const operationIdempotencyKey =
      command.expectedVersion === null
        ? command.idempotencyKey
        : `${command.participantId}:${command.expectedVersion}`;
    if (operationIdempotencyKey !== undefined) {
      const operationKey = this.#aggregateOperationKey(
        command.organizationId,
        command.eventId,
        operationType,
        operationIdempotencyKey,
      );
      const existing = this.#aggregateOperations.get(operationKey);
      if (existing !== undefined) {
        if (existing.digest !== digest) {
          return Promise.resolve({ ok: false, reason: "version_conflict" });
        }
        const participantId = existing.participantIds[0];
        const replayed = profiles.find((profile) => profile.participantId === participantId);
        return Promise.resolve(
          replayed === undefined
            ? { ok: false, reason: "not_found" }
            : { ok: true, value: clone(replayed) },
        );
      }
    }
    const index = profiles.findIndex((profile) => profile.participantId === command.participantId);
    const current = profiles[index];
    if (
      command.expectedVersion === null
        ? current !== undefined
        : current?.version !== command.expectedVersion
    ) {
      return Promise.resolve({ ok: false, reason: "version_conflict" });
    }
    const profile: SpeakerProfile = {
      id: current?.id ?? command.profileId,
      eventId: command.eventId,
      participantId: command.participantId,
      displayName: command.displayName,
      email: command.email,
      jobTitle: command.jobTitle,
      company: command.company,
      biography: command.biography,
      socialLinks: clone(command.socialLinks),
      travelLogistics: clone(command.travelLogistics),
      status: command.status,
      sourceType: command.sourceType,
      sourceId: command.sourceId,
      version: (current?.version ?? 0) + 1,
      updatedAt: command.updatedAt,
    };
    if (index < 0) profiles.push(profile);
    else profiles[index] = profile;
    this.#profiles.set(command.eventId, profiles);
    if (operationIdempotencyKey !== undefined) {
      this.#aggregateOperations.set(
        this.#aggregateOperationKey(
          command.organizationId,
          command.eventId,
          operationType,
          operationIdempotencyKey,
        ),
        {
          digest,
          participantIds: [command.participantId],
        },
      );
    }
    return Promise.resolve({ ok: true, value: clone(profile) });
  }

  async listSubmissions(eventId: string, submissionIds: readonly string[]) {
    this.#ensureEvent(eventId);
    const allowed = new Set(submissionIds);
    return clone((this.#submissions.get(eventId) ?? []).filter(({ id }) => allowed.has(id)));
  }

  async listSubmissionsForOrganization(
    organizationId: string,
    eventId: string,
    submissionIds: readonly string[],
  ) {
    if (organizationId !== LOCAL_ORGANIZATION_ID) return [];
    return (await this.listSubmissions(eventId, submissionIds)).map((submission) => ({
      ...submission,
      tenantId: LOCAL_ORGANIZATION_ID,
    }));
  }

  async getSubmission(eventId: string, submissionId: string) {
    this.#ensureEvent(eventId);
    const canonicalId = submissionId.startsWith("speaker-submission:")
      ? submissionId.slice("speaker-submission:".length)
      : submissionId;
    return clone(this.#submissions.get(eventId)?.find(({ id }) => id === canonicalId) ?? null);
  }

  acceptSubmission(eventId: string, submissionId: string, updatedAt: string): void {
    this.#ensureEvent(eventId);
    const submissions = this.#submissions.get(eventId) ?? [];
    const index = submissions.findIndex(({ id }) => id === submissionId);
    const current = submissions[index];
    if (current === undefined) throw new Error("The accepted local submission was not projected.");
    submissions[index] = { ...current, status: "accepted", updatedAt };
    const participantIds = new Set(current.participantIds);
    const profiles = this.#profiles.get(eventId) ?? [];
    for (const [profileIndex, profile] of profiles.entries()) {
      if (participantIds.has(profile.participantId)) {
        profiles[profileIndex] = { ...profile, status: "accepted", updatedAt };
      }
    }
  }

  acceptSpeakerInvitation(accountId: string, eventId: string, participantId: string): void {
    this.#ensureEvent(eventId);
    const current = this.#cfpPortalContexts.get(accountId);
    if (current?.eventId === eventId && current.participantIds.includes(participantId)) {
      this.#cfpPortalContexts.set(accountId, {
        ...current,
        capabilities: [...LOCAL_SPEAKER_CAPABILITIES],
      });
      return;
    }
    const submission = (this.#submissions.get(eventId) ?? []).find(({ participantIds }) =>
      participantIds.includes(participantId),
    );
    this.#cfpPortalContexts.set(accountId, {
      id: `portal:${LOCAL_ORGANIZATION_ID}:${eventId}:${participantId}`,
      eventId,
      name: eventId,
      slug: eventId,
      capabilities: [...LOCAL_SPEAKER_CAPABILITIES],
      submissionIds: submission === undefined ? [] : [submission.id],
      participantIds: [participantId],
      primaryParticipantId: participantId,
    });
  }

  async createTask(command: {
    task: SpeakerTask;
    expectedVersion: number | null;
    actorAccountId: string;
    decisionFence?: DecisionVersionFence;
  }): Promise<RepositoryResult<SpeakerTask>> {
    this.#ensureEvent(command.task.eventId);
    if (
      command.decisionFence !== undefined &&
      this.decisionFenceChecker !== undefined &&
      !(await this.decisionFenceChecker(command.decisionFence))
    ) {
      return { ok: false, reason: "version_conflict" };
    }
    const tasks = this.#tasks.get(command.task.eventId) ?? [];
    if (command.expectedVersion !== null || tasks.some(({ id }) => id === command.task.id)) {
      return { ok: false, reason: "version_conflict" };
    }
    tasks.push(clone(command.task));
    return { ok: true, value: clone(command.task) };
  }

  async listProfiles(eventId: string, participantIds: readonly string[]) {
    this.#ensureEvent(eventId);
    const allowed = new Set(participantIds);
    return clone(
      (this.#profiles.get(eventId) ?? []).filter(({ participantId }) => allowed.has(participantId)),
    );
  }

  async getProfile(eventId: string, participantId: string) {
    this.#ensureEvent(eventId);
    return clone(
      this.#profiles.get(eventId)?.find((profile) => profile.participantId === participantId) ??
        null,
    );
  }

  async updateBiography(
    command: UpdateBiographyCommand,
  ): Promise<RepositoryResult<SpeakerProfile>> {
    this.#ensureEvent(command.eventId);
    const profiles = this.#profiles.get(command.eventId) ?? [];
    const index = profiles.findIndex(
      ({ participantId }) => participantId === command.participantId,
    );
    const profile = profiles[index];
    if (profile === undefined) return { ok: false, reason: "not_found" };
    if (profile.version !== command.expectedVersion) {
      return { ok: false, reason: "version_conflict" };
    }
    const updated: SpeakerProfile = {
      ...profile,
      biography: command.biography,
      version: profile.version + 1,
      updatedAt: command.updatedAt,
    };
    profiles[index] = updated;
    return { ok: true, value: clone(updated) };
  }
  async updateProfile(
    command: UpdateSpeakerProfileCommand,
  ): Promise<RepositoryResult<SpeakerProfile>> {
    this.#ensureEvent(command.eventId);
    const profiles = this.#profiles.get(command.eventId) ?? [];
    const index = profiles.findIndex(
      ({ participantId }) => participantId === command.participantId,
    );
    const profile = profiles[index];
    if (profile === undefined) return { ok: false, reason: "not_found" };
    if (profile.version !== command.expectedVersion) {
      return { ok: false, reason: "version_conflict" };
    }
    const updated: SpeakerProfile = {
      ...profile,
      ...(command.displayName === undefined ? {} : { displayName: command.displayName }),
      ...(command.email === undefined ? {} : { email: command.email }),
      ...(command.jobTitle === undefined ? {} : { jobTitle: command.jobTitle }),
      ...(command.company === undefined ? {} : { company: command.company }),
      ...(command.status === undefined ? {} : { status: command.status }),
      ...(command.biography === undefined ? {} : { biography: command.biography }),
      ...(command.socialLinks === undefined ? {} : { socialLinks: clone(command.socialLinks) }),
      ...(command.headshotAssetId === undefined || command.headshotAssetId === null
        ? {}
        : { headshotAssetId: command.headshotAssetId }),
      version: profile.version + 1,
      updatedAt: command.updatedAt,
    };
    if (command.headshotAssetId === null) delete updated.headshotAssetId;
    profiles[index] = updated;
    return { ok: true, value: clone(updated) };
  }

  async listTasks(eventId: string, participantIds: readonly string[]) {
    this.#ensureEvent(eventId);
    const allowed = new Set(participantIds);
    return clone(
      (this.#tasks.get(eventId) ?? [])
        .filter(({ participantId }) => allowed.has(participantId))
        .map((task) => ({ ...task, tenantId: LOCAL_ORGANIZATION_ID })),
    );
  }

  async listTasksForOrganization(
    organizationId: string,
    eventId: string,
    participantIds: readonly string[],
  ) {
    if (organizationId !== LOCAL_ORGANIZATION_ID) return [];
    return (await this.listTasks(eventId, participantIds)).map((task) => ({
      ...task,
      tenantId: LOCAL_ORGANIZATION_ID,
    }));
  }

  async getTask(eventId: string, taskId: string) {
    this.#ensureEvent(eventId);
    const task = this.#tasks.get(eventId)?.find(({ id }) => id === taskId);
    return task === undefined ? null : clone({ ...task, tenantId: LOCAL_ORGANIZATION_ID });
  }

  async getTasksByIds(eventId: string, taskIds: readonly string[]) {
    this.#ensureEvent(eventId);
    const allowed = new Set(taskIds);
    return clone(
      (this.#tasks.get(eventId) ?? [])
        .filter(({ id }) => allowed.has(id))
        .map((task) => ({ ...task, tenantId: LOCAL_ORGANIZATION_ID })),
    );
  }

  async transitionTask(command: TransitionSpeakerTaskCommand) {
    this.#ensureEvent(command.eventId);
    const tasks = this.#tasks.get(command.eventId) ?? [];
    const index = tasks.findIndex(({ id }) => id === command.taskId);
    const task = tasks[index];
    if (task === undefined) return { ok: false, reason: "not_found" } as const;
    if (task.version !== command.expectedVersion || task.status !== command.fromStatus) {
      return { ok: false, reason: "version_conflict" } as const;
    }
    if (command.toStatus === "submitted" && task.replacementBaselineAssetId !== undefined) {
      const assets = (this.#assets.get(command.eventId) ?? []).filter(
        (asset) => asset.taskId === task.id,
      );
      const baseline = assets.find((asset) => asset.id === task.replacementBaselineAssetId);
      const family =
        baseline === undefined
          ? []
          : assets.filter(
              (asset) =>
                (asset.versionFamilyId ?? asset.id) === (baseline.versionFamilyId ?? baseline.id),
            );
      const current =
        family.find((asset) => asset.currentVersionId === asset.id) ??
        [...family].sort((left, right) => (right.version ?? 0) - (left.version ?? 0))[0];
      if (
        baseline === undefined ||
        current === undefined ||
        current.state !== "ready" ||
        current.id === baseline.id ||
        (current.version ?? 0) <= (baseline.version ?? 0) ||
        (task.acceptedAssetKinds !== undefined && !task.acceptedAssetKinds.includes(current.kind))
      ) {
        return { ok: false, reason: "invalid_state" } as const;
      }
    }
    const { replacementBaselineAssetId: _baseline, ...taskWithoutBaseline } = task;
    const updated: SpeakerTask =
      command.toStatus === "submitted"
        ? {
            ...taskWithoutBaseline,
            status: command.toStatus,
            version: task.version + 1,
            updatedAt: command.transition.occurredAt,
          }
        : {
            ...task,
            status: command.toStatus,
            version: task.version + 1,
            updatedAt: command.transition.occurredAt,
          };
    tasks[index] = updated;
    const transitions = this.#taskTransitions.get(command.eventId) ?? [];
    if (!transitions.some((transition) => transition.id === command.transition.id)) {
      this.#taskTransitions.set(command.eventId, [...transitions, clone(command.transition)]);
    }
    return {
      ok: true,
      value: { task: clone(updated), transition: clone(command.transition) },
    } as const;
  }

  async createPendingAsset(asset: SpeakerAsset) {
    this.#ensureEvent(asset.eventId);
    this.#assets.get(asset.eventId)?.push(clone(asset));
    return clone(asset);
  }

  async createPendingAssetVersion(
    command: CreatePendingSpeakerAssetVersionCommand,
  ): Promise<RepositoryResult<SpeakerAsset>> {
    const { asset } = command;
    this.#ensureEvent(asset.eventId);
    const assets = this.#assets.get(asset.eventId) ?? [];
    const key = `${asset.tenantId ?? asset.eventId}\u0000${asset.eventId}\u0000${command.idempotencyKey}`;
    const replay = this.#assetVersionCreations.get(key);
    if (replay !== undefined) {
      const stored = assets.find((candidate) => candidate.id === replay.assetId);
      return replay.requestDigest === command.requestDigest && stored !== undefined
        ? { ok: true, value: clone(stored) }
        : { ok: false, reason: "version_conflict" };
    }
    const familyId = asset.versionFamilyId ?? asset.id;
    const expected = assets.find(
      (candidate) =>
        candidate.id === command.expectedLatestAssetId &&
        (candidate.versionFamilyId ?? candidate.id) === familyId,
    );
    if (
      expected === undefined ||
      expected.version !== command.expectedLatestVersion ||
      !["ready", "rejected"].includes(expected.state) ||
      asset.state !== "pending_upload" ||
      asset.supersedesAssetId !== expected.id ||
      asset.version !== command.expectedLatestVersion + 1 ||
      asset.versionId !== asset.id ||
      asset.latestVersionId !== asset.id ||
      assets.some(
        (candidate) =>
          (candidate.versionFamilyId ?? candidate.id) === familyId &&
          (candidate.version ?? 0) > command.expectedLatestVersion,
      )
    ) {
      return { ok: false, reason: "version_conflict" };
    }
    const stored = clone(asset);
    assets.push(stored);
    this.#assetVersionCreations.set(key, {
      requestDigest: command.requestDigest,
      assetId: stored.id,
    });
    return { ok: true, value: clone(stored) };
  }

  async getAsset(eventId: string, assetId: string) {
    this.#ensureEvent(eventId);
    return clone(this.#assets.get(eventId)?.find(({ id }) => id === assetId) ?? null);
  }

  async listAssets(eventId: string, participantIds: readonly string[]) {
    this.#ensureEvent(eventId);
    const allowed = new Set(participantIds);
    return clone(
      (this.#assets.get(eventId) ?? []).filter(({ participantId }) => allowed.has(participantId)),
    );
  }

  async listAssetHistory(eventId: string, versionFamilyId: string) {
    this.#ensureEvent(eventId);
    return clone(
      (this.#assets.get(eventId) ?? []).filter(
        (asset) => (asset.versionFamilyId ?? asset.id) === versionFamilyId,
      ),
    );
  }

  async finalizeAsset(
    command: FinalizeSpeakerAssetCommand,
  ): Promise<RepositoryResult<SpeakerAsset>> {
    this.#ensureEvent(command.eventId);
    const assets = this.#assets.get(command.eventId) ?? [];
    const index = assets.findIndex(({ id }) => id === command.assetId);
    const asset = assets[index];
    if (asset === undefined) return { ok: false, reason: "not_found" };
    if (asset.state !== "pending_upload") return { ok: false, reason: "invalid_state" };
    const finalized: SpeakerAsset = {
      ...asset,
      state: command.state,
      finalizedAt: command.finalizedAt,
      latestVersionId: command.latestVersionId,
      ...(command.currentVersionId === undefined
        ? {}
        : { currentVersionId: command.currentVersionId }),
      ...(command.rejectionReason === undefined
        ? {}
        : { rejectionReason: command.rejectionReason }),
    };
    assets[index] = finalized;
    if (command.state === "ready") {
      const familyId = asset.versionFamilyId ?? asset.id;
      for (const [candidateIndex, candidate] of assets.entries()) {
        if ((candidate.versionFamilyId ?? candidate.id) !== familyId) continue;
        assets[candidateIndex] = {
          ...candidate,
          latestVersionId: asset.id,
          currentVersionId: asset.id,
        };
      }
    }
    return { ok: true, value: clone(finalized) };
  }

  async reviewAsset(command: SpeakerAssetReviewCommand): Promise<RepositoryResult<SpeakerAsset>> {
    this.#ensureEvent(command.eventId);
    const assets = this.#assets.get(command.eventId) ?? [];
    const index = assets.findIndex(({ id }) => id === command.assetId);
    const asset = assets[index];
    if (asset === undefined) return { ok: false, reason: "not_found" };
    if (
      asset.state !== "ready" ||
      (asset.reviewVersion ?? 0) !== command.expectedVersion ||
      asset.currentVersionId !== asset.id
    ) {
      return { ok: false, reason: "version_conflict" };
    }
    const tasks = this.#tasks.get(command.eventId) ?? [];
    const returnTaskIndex =
      command.returnTask === undefined
        ? -1
        : tasks.findIndex(({ id }) => id === command.returnTask?.taskId);
    const returnTask = returnTaskIndex < 0 ? undefined : tasks[returnTaskIndex];
    if (command.returnTask !== undefined) {
      if (returnTask === undefined) return { ok: false, reason: "not_found" };
      if (
        command.returnTask.eventId !== command.eventId ||
        command.returnTask.baselineAssetId !== command.assetId ||
        (command.returnTask.transition !== undefined &&
          (command.returnTask.transition.eventId !== command.eventId ||
            command.returnTask.transition.taskId !== command.returnTask.taskId ||
            command.returnTask.transition.participantId !== returnTask.participantId))
      ) {
        return { ok: false, reason: "invalid_state" };
      }
      if (
        returnTask.version !== command.returnTask.expectedVersion ||
        returnTask.status !== command.returnTask.fromStatus
      ) {
        return { ok: false, reason: "version_conflict" };
      }
    }
    this.beforeReviewCommit?.(this.#tasks);
    const currentReturnTask =
      command.returnTask === undefined
        ? undefined
        : this.#tasks.get(command.eventId)?.find(({ id }) => id === command.returnTask?.taskId);
    if (
      command.returnTask !== undefined &&
      (currentReturnTask === undefined ||
        currentReturnTask.version !== command.returnTask.expectedVersion ||
        currentReturnTask.status !== command.returnTask.fromStatus)
    ) {
      return { ok: false, reason: "version_conflict" };
    }
    const versionFamilyId = asset.versionFamilyId ?? asset.id;
    const approvedVersionId =
      command.state === "approved"
        ? command.assetId
        : asset.approvedVersionId === command.assetId
          ? undefined
          : asset.approvedVersionId;
    const releasedVersionId = command.release ? command.assetId : asset.releasedVersionId;
    for (const [candidateIndex, candidate] of assets.entries()) {
      if ((candidate.versionFamilyId ?? candidate.id) !== versionFamilyId) continue;
      const updated = {
        ...candidate,
        ...(approvedVersionId === undefined ? {} : { approvedVersionId }),
        ...(releasedVersionId === undefined ? {} : { releasedVersionId }),
      };
      if (approvedVersionId === undefined) delete updated.approvedVersionId;
      if (releasedVersionId === undefined) delete updated.releasedVersionId;
      assets[candidateIndex] = updated;
    }
    const reviewed: SpeakerAsset = {
      ...asset,
      ...(approvedVersionId === undefined ? {} : { approvedVersionId }),
      ...(releasedVersionId === undefined ? {} : { releasedVersionId }),
      reviewState: command.state,
      ...(command.note === undefined ? {} : { reviewNote: command.note }),
      reviewedAt: command.reviewedAt,
      reviewedBy: command.reviewedBy,
      reviewVersion: command.expectedVersion + 1,
    };
    if (approvedVersionId === undefined) delete reviewed.approvedVersionId;
    if (releasedVersionId === undefined) delete reviewed.releasedVersionId;
    if (command.note === undefined) delete reviewed.reviewNote;
    assets[index] = reviewed;
    if (command.audit !== undefined) {
      const entries = this.#assetAudit.get(command.eventId) ?? [];
      if (!entries.some((entry) => entry.id === command.audit?.id)) {
        this.#assetAudit.set(command.eventId, [...entries, clone(command.audit)]);
      }
    }
    if (command.returnTask !== undefined && returnTask !== undefined) {
      tasks[returnTaskIndex] = {
        ...returnTask,
        status: command.returnTask.toStatus,
        replacementBaselineAssetId: command.returnTask.baselineAssetId,
        version: command.returnTask.expectedVersion + 1,
        updatedAt: command.returnTask.transition?.occurredAt ?? command.reviewedAt,
      };
      if (command.returnTask.transition !== undefined) {
        const transitions = this.#taskTransitions.get(command.eventId) ?? [];
        if (
          !transitions.some((transition) => transition.id === command.returnTask?.transition?.id)
        ) {
          this.#taskTransitions.set(command.eventId, [
            ...transitions,
            clone(command.returnTask.transition),
          ]);
        }
      }
    }
    return { ok: true, value: clone(reviewed) };
  }

  async appendAssetAudit(entry: SpeakerAssetAuditEntry): Promise<void> {
    this.#ensureEvent(entry.eventId);
    const entries = this.#assetAudit.get(entry.eventId) ?? [];
    if (entries.some((candidate) => candidate.id === entry.id)) return;
    this.#assetAudit.set(entry.eventId, [...entries, clone(entry)]);
  }

  async listAssetAudit(eventId: string, assetId: string): Promise<SpeakerAssetAuditEntry[]> {
    this.#ensureEvent(eventId);
    return clone(
      (this.#assetAudit.get(eventId) ?? []).filter((entry) => entry.assetId === assetId),
    );
  }

  async listAssetComments(eventId: string, assetId: string): Promise<SpeakerAssetComment[]> {
    this.#ensureEvent(eventId);
    return clone(
      (this.#assetComments.get(eventId) ?? [])
        .filter((comment) => comment.assetId === assetId && comment.versionId === assetId)
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            (left.version ?? 0) - (right.version ?? 0) ||
            left.id.localeCompare(right.id),
        ),
    );
  }

  async createAssetComment(comment: SpeakerAssetComment): Promise<SpeakerAssetComment> {
    this.#ensureEvent(comment.eventId);
    const asset = (this.#assets.get(comment.eventId) ?? []).find(
      ({ id }) => id === comment.assetId,
    );
    if (asset === undefined || comment.versionId !== comment.assetId) {
      throw new Error("The version-specific speaker asset does not exist.");
    }
    const comments = this.#assetComments.get(comment.eventId) ?? [];
    if (comments.some(({ id }) => id === comment.id)) {
      throw new Error("The version-specific speaker asset comment already exists.");
    }
    const created = clone(comment);
    comments.push(created);
    this.#assetComments.set(comment.eventId, comments);
    return clone(created);
  }

  async listRoster(eventId: string, _submissionId: string): Promise<SpeakerRosterEntry[]> {
    this.#ensureEvent(eventId);
    return [];
  }

  async listEventResources(eventId: string): Promise<SpeakerEventResource[]> {
    this.#ensureEvent(eventId);
    return [];
  }

  async listWikiPages(eventId: string): Promise<SpeakerWikiPage[]> {
    this.#ensureEvent(eventId);
    return [];
  }

  async getContent(eventId: string, entityType: "session" | "speaker", entityId: string) {
    this.#ensureEvent(eventId);
    return clone(this.#content.get(this.#contentKey(eventId, entityType, entityId)) ?? null);
  }

  async listContentHistory(eventId: string, entityType: "session" | "speaker", entityId: string) {
    this.#ensureEvent(eventId);
    return clone(this.#contentHistory.get(this.#contentKey(eventId, entityType, entityId)) ?? []);
  }

  async updateContent(
    command: UpdateSpeakerContentCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>> {
    this.#ensureEvent(command.eventId);
    const key = this.#contentKey(command.eventId, command.entityType, command.entityId);
    const current = this.#content.get(key);
    if (current === undefined) return { ok: false, reason: "not_found" };
    if (current.version !== command.expectedVersion) {
      return { ok: false, reason: "version_conflict" };
    }
    const updated: SpeakerContentRecord = {
      ...current,
      ...(command.title === undefined ? {} : { title: command.title }),
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.abstract === undefined ? {} : { abstract: command.abstract }),
      ...(command.biography === undefined ? {} : { biography: command.biography }),
      ...(command.socialLinks === undefined ? {} : { socialLinks: clone(command.socialLinks) }),
      ...(command.headshotAssetId === undefined || command.headshotAssetId === null
        ? {}
        : { headshotAssetId: command.headshotAssetId }),
      ...(command.status === undefined ? {} : { status: command.status }),
      version: current.version + 1,
      updatedAt: command.updatedAt,
      updatedBy: command.accountId,
    };
    if (command.headshotAssetId === null) delete updated.headshotAssetId;
    this.#content.set(key, updated);
    this.#contentHistory.get(key)?.push({
      id: `local-${command.entityType}-content-history-${updated.version}`,
      eventId: command.eventId,
      entityType: command.entityType,
      entityId: command.entityId,
      action: "updated",
      version: updated.version,
      actorAccountId: command.accountId,
      actorLabel: "Local Organizer",
      occurredAt: command.updatedAt,
      snapshot: clone(updated),
    });
    return { ok: true, value: clone(updated) };
  }

  async restoreContentVersion(
    command: RestoreSpeakerContentVersionCommand,
  ): Promise<RepositoryResult<SpeakerContentRecord>> {
    this.#ensureEvent(command.eventId);
    const key = this.#contentKey(command.eventId, command.entityType, command.entityId);
    const current = this.#content.get(key);
    if (current === undefined) return { ok: false, reason: "not_found" };
    if (current.version !== command.expectedVersion) {
      return { ok: false, reason: "version_conflict" };
    }
    const target = this.#contentHistory
      .get(key)
      ?.find(({ version }) => version === command.version);
    if (target === undefined) return { ok: false, reason: "not_found" };
    const restored: SpeakerContentRecord = {
      ...clone(target.snapshot),
      version: current.version + 1,
      updatedAt: command.updatedAt,
      updatedBy: command.accountId,
    };
    this.#content.set(key, restored);
    this.#contentHistory.get(key)?.push({
      id: `local-${command.entityType}-content-history-${restored.version}`,
      eventId: command.eventId,
      entityType: command.entityType,
      entityId: command.entityId,
      action: "restored",
      version: restored.version,
      actorAccountId: command.accountId,
      actorLabel: "Local Organizer",
      occurredAt: command.updatedAt,
      snapshot: clone(restored),
    });
    return { ok: true, value: clone(restored) };
  }
}

class LocalSessionRepository extends InMemorySessionRepository {
  constructor(
    private readonly speakerRepository: LocalSpeakerRepository,
    decisionFenceChecker: (fence: DecisionVersionFence) => Promise<boolean>,
  ) {
    super({}, decisionFenceChecker);
  }

  override listSpeakerIds(tenantId: string, eventId: string): Promise<readonly string[]> {
    return this.speakerRepository.listActiveParticipantIds(tenantId, eventId);
  }
}

type LocalPrivateAssetRecord = {
  readonly binding: PrivateAssetCapabilityBinding | PrivateDownloadCapabilityBinding;
  readonly kind: "upload" | "download";
  readonly tokens: Set<string>;
  state: "pending" | "uploaded" | "claiming" | "consumed";
};

type LocalPrivateAssetObject = {
  readonly contentType: string;
  readonly bytes: Uint8Array;
};

function samePrivateAssetSubject(
  left: PrivateAssetCapabilityBinding["subject"],
  right: PrivateAssetCapabilityBinding["subject"],
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "cfp_submission"
      ? right.kind === "cfp_submission" && left.submissionId === right.submissionId
      : left.kind === "speaker_session"
        ? right.kind === "speaker_session" && left.sessionId === right.sessionId
        : true)
  );
}

function sameUploadBinding(
  left: PrivateAssetCapabilityBinding,
  right: PrivateAssetCapabilityBinding,
): boolean {
  return (
    left.capabilityId === right.capabilityId &&
    left.tenantId === right.tenantId &&
    left.eventId === right.eventId &&
    samePrivateAssetSubject(left.subject, right.subject) &&
    left.participantId === right.participantId &&
    left.objectKey === right.objectKey &&
    left.fileName === right.fileName &&
    left.contentType === right.contentType &&
    left.sizeBytes === right.sizeBytes &&
    left.expiresAt === right.expiresAt
  );
}

class LocalPrivateAssetGateway implements PrivateAssetGateway {
  readonly #capabilities = new Map<string, LocalPrivateAssetRecord>();
  readonly #objects = new Map<string, LocalPrivateAssetObject>();
  #sequence = 0;

  constructor(
    private readonly appendAssetAudit?: (entry: SpeakerAssetAuditEntry) => Promise<void>,
  ) {}

  async createUploadGrant(_command: CreatePrivateUploadGrantCommand): Promise<PrivateUploadGrant> {
    throw new Error("A fully bound local upload capability is required.");
  }

  async createDownloadGrant(_command: {
    objectKey: string;
    fileName: string;
    expiresAt: string;
  }): Promise<PrivateDownloadGrant> {
    throw new Error("A fully bound local download capability is required.");
  }

  async registerUploadCapability(binding: PrivateAssetCapabilityBinding) {
    const token = await this.token("upload", binding);
    const existing = this.#capabilities.get(binding.capabilityId);
    if (
      existing !== undefined &&
      existing.kind === "upload" &&
      existing.state === "pending" &&
      sameUploadBinding(existing.binding, binding)
    ) {
      existing.tokens.add(token);
      return {
        method: "PUT" as const,
        url: `/api/speaker/assets/capabilities/upload/${encodeURIComponent(binding.capabilityId)}/${token}`,
        headers: {
          "content-type": binding.contentType,
          "content-length": String(binding.sizeBytes),
        },
        expiresAt: binding.expiresAt,
      };
    }
    if (existing?.kind === "upload" && existing.state === "uploaded") {
      throw new Error("The upload capability cannot be reauthorized.");
    }
    this.#capabilities.set(binding.capabilityId, {
      binding: { ...binding },
      kind: "upload",
      tokens: new Set([token]),
      state: "pending",
    });
    return {
      method: "PUT" as const,
      url: `/api/speaker/assets/capabilities/upload/${encodeURIComponent(binding.capabilityId)}/${token}`,
      headers: {
        "content-type": binding.contentType,
        "content-length": String(binding.sizeBytes),
      },
      expiresAt: binding.expiresAt,
    };
  }

  async registerDownloadCapability(binding: PrivateDownloadCapabilityBinding) {
    const object = this.#objects.get(binding.objectKey);
    if (
      object === undefined ||
      object.bytes.byteLength !== binding.sizeBytes ||
      object.contentType.trim().toLowerCase() !== binding.contentType.trim().toLowerCase()
    ) {
      throw new Error("The requested private asset is not available.");
    }
    const capabilityId = `download:${crypto.randomUUID()}`;
    const token = await this.token("download", binding);
    const createdAt = new Date().toISOString();
    await this.appendAssetAudit?.({
      id: `private-download-issued:${capabilityId}`,
      organizationId: binding.tenantId,
      eventId: binding.eventId,
      assetId: binding.capabilityId,
      action: "download_authorized",
      actorAccountId: binding.requesterAccountId,
      requesterKind: binding.requesterKind,
      capabilityId,
      attributionBasis: "authenticated_requester",
      occurredAt: createdAt,
      version: binding.assetVersion,
    });
    this.#capabilities.set(capabilityId, {
      binding: { ...binding },
      kind: "download",
      tokens: new Set([token]),
      state: "uploaded",
    });
    return {
      method: "GET" as const,
      url: `/api/speaker/assets/capabilities/download/${encodeURIComponent(capabilityId)}/${token}`,
      expiresAt: binding.expiresAt,
    };
  }

  async consumeUploadCapability(capabilityId: string, token: string, request: Request) {
    const capability = this.#capabilities.get(capabilityId);
    if (capability === undefined || capability.kind !== "upload" || !capability.tokens.has(token)) {
      throw new Error("The upload capability is invalid.");
    }
    if (capability.state !== "pending") {
      throw new Error("The upload capability has already been used.");
    }
    if (this.expired(capability.binding.expiresAt)) {
      throw new Error("The upload capability has expired.");
    }
    if (request.method !== "PUT") throw new Error("The upload capability requires PUT.");

    const contentType = request.headers.get("content-type")?.trim().toLowerCase() ?? "";
    const declaredLength = request.headers.get("content-length");
    if (
      contentType !== capability.binding.contentType.trim().toLowerCase() ||
      (declaredLength !== null &&
        (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== capability.binding.sizeBytes))
    ) {
      throw new Error("The uploaded object metadata is not allowed.");
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength !== capability.binding.sizeBytes) {
      throw new Error("The uploaded object size does not match the capability.");
    }

    capability.state = "uploaded";
    this.#objects.set(capability.binding.objectKey, {
      contentType: capability.binding.contentType,
      bytes: body.slice(),
    });
    return {
      contentType: capability.binding.contentType,
      sizeBytes: capability.binding.sizeBytes,
      uploadedAt: new Date(SEEDED_AT).toISOString(),
    };
  }

  async consumeDownloadCapability(capabilityId: string, token: string) {
    const capability = this.#capabilities.get(capabilityId);
    if (
      capability === undefined ||
      capability.kind !== "download" ||
      !capability.tokens.has(token)
    ) {
      throw new Error("The download capability is invalid.");
    }
    if (capability.state !== "uploaded") {
      throw new Error("The download capability has already been used.");
    }
    if (this.expired(capability.binding.expiresAt)) {
      throw new Error("The download capability has expired.");
    }
    capability.state = "claiming";
    const binding = capability.binding;
    if (!("requesterAccountId" in binding)) {
      capability.state = "consumed";
      throw new Error("The download capability is invalid.");
    }
    const claimId = crypto.randomUUID();
    try {
      await this.appendAssetAudit?.({
        id: `private-download-consumed:${claimId}`,
        organizationId: binding.tenantId,
        eventId: binding.eventId,
        assetId: binding.capabilityId,
        action: "downloaded",
        actorAccountId: binding.requesterAccountId,
        requesterKind: binding.requesterKind,
        capabilityId,
        attributionBasis: "issuance_principal",
        occurredAt: new Date().toISOString(),
        version: binding.assetVersion,
      });
    } catch (error) {
      capability.state = "uploaded";
      throw error;
    }
    capability.state = "consumed";
    const object = this.#objects.get(binding.objectKey);
    if (
      object === undefined ||
      object.bytes.byteLength !== binding.sizeBytes ||
      object.contentType.trim().toLowerCase() !== binding.contentType.trim().toLowerCase()
    ) {
      throw new Error("The requested private asset is not available.");
    }

    capability.state = "consumed";
    return {
      body: this.body(object.bytes),
      contentType: object.contentType,
      sizeBytes: object.bytes.byteLength,
      fileName: binding.fileName,
    };
  }

  async verifyUploadCapability(binding: PrivateAssetCapabilityBinding) {
    const capability = this.#capabilities.get(binding.capabilityId);
    return (
      capability !== undefined &&
      capability.kind === "upload" &&
      capability.state === "uploaded" &&
      !this.expired(capability.binding.expiresAt) &&
      this.sameBinding(capability.binding, binding)
    );
  }

  async invalidateUploadCapability(binding: PrivateAssetCapabilityBinding) {
    const capability = this.#capabilities.get(binding.capabilityId);
    if (
      capability === undefined ||
      capability.kind !== "upload" ||
      capability.state === "consumed" ||
      this.expired(capability.binding.expiresAt) ||
      !this.sameBinding(capability.binding, binding)
    ) {
      throw new Error("The upload capability cannot be invalidated.");
    }
    capability.state = "consumed";
  }

  async inspectObject(
    command: Pick<PrivateAssetCapabilityBinding, "objectKey" | "contentType" | "sizeBytes">,
  ) {
    const object = this.#objects.get(command.objectKey);
    if (
      object === undefined ||
      object.bytes.byteLength !== command.sizeBytes ||
      object.contentType.trim().toLowerCase() !== command.contentType.trim().toLowerCase()
    ) {
      return null;
    }
    return {
      contentType: object.contentType,
      sizeBytes: object.bytes.byteLength,
    };
  }

  async readObject(binding: PrivateAssetCapabilityBinding) {
    const object = this.#objects.get(binding.objectKey);
    if (
      object === undefined ||
      object.bytes.byteLength !== binding.sizeBytes ||
      object.contentType.trim().toLowerCase() !== binding.contentType.trim().toLowerCase()
    ) {
      return null;
    }
    return {
      body: this.body(object.bytes),
      contentType: object.contentType,
      sizeBytes: object.bytes.byteLength,
      fileName: binding.fileName,
    };
  }

  readPublishedObject(
    binding: Pick<PrivateAssetCapabilityBinding, "objectKey" | "contentType" | "sizeBytes">,
  ) {
    const object = this.#objects.get(binding.objectKey);
    if (
      object === undefined ||
      object.bytes.byteLength !== binding.sizeBytes ||
      object.contentType.trim().toLowerCase() !== binding.contentType.trim().toLowerCase()
    ) {
      return null;
    }
    return {
      body: this.body(object.bytes),
      contentType: object.contentType,
      sizeBytes: object.bytes.byteLength,
    };
  }

  private sameBinding(
    left: PrivateAssetCapabilityBinding,
    right: PrivateAssetCapabilityBinding,
  ): boolean {
    return (
      left.tenantId === right.tenantId &&
      left.eventId === right.eventId &&
      samePrivateAssetSubject(left.subject, right.subject) &&
      left.participantId === right.participantId &&
      left.taskId === right.taskId &&
      left.objectKey === right.objectKey &&
      left.contentType === right.contentType &&
      left.sizeBytes === right.sizeBytes &&
      left.fileName === right.fileName
    );
  }

  private expired(expiresAt: string): boolean {
    const timestamp = Date.parse(expiresAt);
    return !Number.isFinite(timestamp) || timestamp <= Date.parse(SEEDED_AT);
  }

  private body(bytes: Uint8Array): ReadableStream<Uint8Array> {
    const copy = bytes.slice();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(copy);
        controller.close();
      },
    });
  }

  private async token(kind: "upload" | "download", binding: PrivateAssetCapabilityBinding) {
    const sequence = ++this.#sequence;
    const payload = JSON.stringify([
      "local-private-asset-capability-v1",
      kind,
      sequence,
      binding.capabilityId,
      binding.tenantId,
      binding.eventId,
      binding.subject,
      binding.participantId,
      binding.taskId ?? "",
      binding.objectKey,
      binding.contentType,
      binding.sizeBytes,
      binding.fileName,
      binding.expiresAt,
    ]);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
    );
    return `local-capability-${[...digest]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
  }
}

function localAgendaEngine(
  eventRepository: InMemoryEventRepository,
  mutationLock: InMemoryAgendaMutationLock,
  suggestionProvider?: CloudflareAiProviders["agenda"],
): AgendaEngine {
  return new AgendaEngine(new InMemoryAgendaRepository(), mutationLock, {
    clock: { now: () => new Date(SEEDED_AT) },
    idGenerator: {
      nextId: (() => {
        let sequence = 0;
        return (prefix) => `${prefix}_local_${++sequence}`;
      })(),
    },
    ...(suggestionProvider === undefined ? {} : { suggestionProvider }),
    async eventScheduleForEvent(eventId) {
      const event = await eventRepository.getEvent(LOCAL_ORGANIZATION_ID, eventId);
      return event === null
        ? null
        : {
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            timeZone: event.timeZone,
            ...(event.scheduleDates === undefined ? {} : { scheduleDates: event.scheduleDates }),
          };
    },
  });
}

class LocalPublicApiRepository implements PublicApiRepository {
  readonly #records = new Map<string, Map<string, Record<string, unknown>>>();
  #sequence = 0;

  replaceProjection(resource: string, records: readonly Record<string, unknown>[]): void {
    this.#seed(resource, records);
  }

  #seed(resource: string, records: readonly Record<string, unknown>[]): void {
    this.#records.set(
      `${LOCAL_ORGANIZATION_ID}:${resource}`,
      new Map(records.map((record) => [String(record.id), clone(record)])),
    );
  }

  #collection(organizationId: string, resource: string) {
    const key = `${organizationId}:${resource}`;
    let collection = this.#records.get(key);
    if (collection === undefined) {
      collection = new Map();
      this.#records.set(key, collection);
    }
    return collection;
  }
  listStored(organizationId: string, resource: string): Record<string, unknown>[] {
    return clone([...this.#collection(organizationId, resource).values()]);
  }

  async list(input: PublicApiListInput): Promise<PublicApiListResult<Record<string, unknown>>> {
    const items = [...this.#collection(input.organizationId, input.resource).values()].filter(
      (record) =>
        Object.entries(input.filters).every(([key, value]) => String(record[key] ?? "") === value),
    );
    return { items: clone(items), hasMore: false, nextCursor: null };
  }

  async get(input: PublicApiGetInput) {
    return clone(this.#collection(input.organizationId, input.resource).get(input.id) ?? null);
  }

  async create(input: PublicApiCreateInput<Record<string, unknown>>) {
    const collection = this.#collection(input.organizationId, input.resource);
    const requestedId = typeof input.data.id === "string" ? input.data.id.trim() : "";
    const id = requestedId || `${input.resource}-local-${++this.#sequence}`;
    const record = {
      ...clone(input.data),
      id,
      organizationId: input.organizationId,
      version: 1,
      updatedAt: SEEDED_AT,
    };
    collection.set(id, record);
    return clone(record);
  }

  async update(input: PublicApiUpdateInput<Record<string, unknown>>) {
    const collection = this.#collection(input.organizationId, input.resource);
    const current = collection.get(input.id);
    if (current === undefined || current.version !== input.expectedVersion) return null;
    const record = {
      ...current,
      ...clone(input.data),
      id: input.id,
      organizationId: input.organizationId,
      version: input.expectedVersion + 1,
      updatedAt: SEEDED_AT,
    };
    collection.set(input.id, record);
    return clone(record);
  }
}
class LocalIntegrationAdminRepository {
  readonly #events = new Map<string, IntegrationEvent>();
  readonly #delivery = new Map<string, IntegrationDeliveryStatus>();
  readonly #apiKeys = new Map<string, IntegrationApiKeySummary[]>();
  readonly #webhookLastDelivery = new Map<string, IntegrationWebhookDelivery>();
  #apiKeySequence = 0;

  constructor(private readonly publicRepository: LocalPublicApiRepository) {
    this.refresh();
  }

  refresh(): void {
    this.#events.clear();
    this.#delivery.clear();
    this.#apiKeys.clear();
    for (const record of this.publicRepository.listStored(LOCAL_ORGANIZATION_ID, "events")) {
      const id = textValue(record, "id");
      if (id === null) continue;
      const event: IntegrationEvent = {
        id,
        organizationId: LOCAL_ORGANIZATION_ID,
        name: textValue(record, "name", "title") ?? id,
        timeZone: textValue(record, "timeZone") ?? "UTC",
        publishedAgendaRevisionId: textValue(record, "publishedAgendaRevisionId"),
      };
      this.#events.set(id, event);
      this.#delivery.set(id, {
        openSend: {
          state: "connected",
          credentialLastFour: "al-key",
          senderChecks: [
            { address: "auth@foreverbrowsing.com", status: "verified" },
            { address: "speakers@foreverbrowsing.com", status: "verified" },
            { address: "calendar@foreverbrowsing.com", status: "verified" },
          ],
          deliveredLast24Hours: id === "demo-event" ? 18 : 11,
          failedLast24Hours: id === "demo-event" ? 1 : 0,
          lastDeliveryAt: SEEDED_AT,
        },
        calendar: {
          state: "degraded",
          sentLast24Hours: id === "demo-event" ? 7 : 4,
          failedLast24Hours: 1,
          lastInvitationAt: SEEDED_AT,
          lastFailure: {
            deliveryId: `calendar-local-failure-${id}`,
            summary: "One invitation needs a retry after its recipient address was corrected.",
            occurredAt: SEEDED_AT,
            retryable: true,
          },
        },
      });
      this.#apiKeys.set(id, [
        {
          id: `local-key-${id}`,
          label: "Local integration client",
          prefix: "osb_local_",
          scopes: ["events:read", "agenda:read", "webhooks:read"],
          eventId: id,
          createdAt: SEEDED_AT,
          lastUsedAt: SEEDED_AT,
          expiresAt: null,
          revokedAt: null,
        },
      ]);
    }
    this.#webhookLastDelivery.set("local-webhook-demo", {
      status: "succeeded",
      attemptedAt: SEEDED_AT,
      responseStatus: 202,
    });
    this.#webhookLastDelivery.set("local-webhook-conference", {
      status: "retrying",
      attemptedAt: SEEDED_AT,
      responseStatus: 503,
    });
  }

  async getEvent(organizationId: string, eventId: string): Promise<IntegrationEvent | null> {
    const event = this.#events.get(eventId);
    return event?.organizationId === organizationId ? clone(event) : null;
  }

  async getDeliveryStatus(
    organizationId: string,
    eventId: string,
  ): Promise<IntegrationDeliveryStatus> {
    if (organizationId !== LOCAL_ORGANIZATION_ID) {
      throw new Error("The local integration organization was not seeded.");
    }
    const status = this.#delivery.get(eventId);
    if (status === undefined) throw new Error("The local integration event was not seeded.");
    return clone(status);
  }

  async saveCredential(
    organizationId: string,
    eventId: string,
    _provider: "opensend",
    secret: string,
  ): Promise<void> {
    const status = await this.getDeliveryStatus(organizationId, eventId);
    this.#delivery.set(eventId, {
      ...status,
      openSend: {
        ...status.openSend,
        state: "connected",
        credentialLastFour: secret.slice(-4),
      },
    });
  }

  async listApiKeys(
    organizationId: string,
    eventId?: string,
  ): Promise<readonly IntegrationApiKeySummary[]> {
    if (organizationId !== LOCAL_ORGANIZATION_ID) return [];
    if (eventId !== undefined) return clone(this.#apiKeys.get(eventId) ?? []);
    return clone([...this.#apiKeys.values()].flat());
  }

  async createApiKey(input: {
    readonly organizationId: string;
    readonly eventId?: string | null;
    readonly label: string;
    readonly scopes: readonly ApiScope[];
    readonly expiresAt: string | null;
  }): Promise<IntegrationApiKeyCreation> {
    if (input.organizationId !== LOCAL_ORGANIZATION_ID) {
      throw new Error("The local integration organization was not seeded.");
    }
    const secret = `osb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const summary: IntegrationApiKeySummary = {
      id: `local-created-key-${++this.#apiKeySequence}`,
      label: input.label,
      prefix: secret.slice(0, 12),
      scopes: [...new Set(input.scopes)],
      eventId: input.eventId ?? null,
      createdAt: SEEDED_AT,
      lastUsedAt: null,
      expiresAt: input.expiresAt?.trim() || null,
      revokedAt: null,
    };
    const storageId = input.eventId ?? "__organization__";
    const keys = this.#apiKeys.get(storageId) ?? [];
    if (!this.#apiKeys.has(storageId)) {
      this.#apiKeys.set(storageId, keys);
    }
    keys.push(summary);
    return { summary: clone(summary), secret };
  }

  async revokeApiKey(organizationId: string, apiKeyId: string, eventId?: string): Promise<boolean> {
    if (organizationId !== LOCAL_ORGANIZATION_ID) return false;
    const keySets =
      eventId === undefined ? [...this.#apiKeys.values()] : [this.#apiKeys.get(eventId) ?? []];
    for (const keys of keySets) {
      const index = keys.findIndex((key) => key.id === apiKeyId && key.revokedAt === null);
      if (index < 0) continue;
      const key = keys[index];
      if (key === undefined) continue;
      keys[index] = { ...key, revokedAt: SEEDED_AT };
      return true;
    }
    return false;
  }

  async getWebhookLastDelivery(
    eventId: string,
    subscriptionId: string,
  ): Promise<IntegrationWebhookDelivery | null> {
    if (!this.#events.has(eventId)) return null;
    return clone(this.#webhookLastDelivery.get(subscriptionId) ?? null);
  }

  async retryCalendarDelivery(eventId: string, deliveryId: string): Promise<boolean> {
    const status = await this.getDeliveryStatus(LOCAL_ORGANIZATION_ID, eventId);
    if (status.calendar.lastFailure?.deliveryId !== deliveryId) return false;
    this.#delivery.set(eventId, {
      ...status,
      calendar: {
        ...status.calendar,
        state: "connected",
        lastFailure: null,
        sentLast24Hours: status.calendar.sentLast24Hours + 1,
      },
    });
    return true;
  }
}

interface LocalOverviewAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly status: string;
  readonly dueAt?: string;
}

class LocalRemixRepository implements RemixRepository {
  readonly #candidates = new Map<string, ContentRemixCandidate>();
  readonly #audit = new Map<string, RemixAuditEntry[]>();

  async getCandidateById(tenantId: string, candidateId: string) {
    const candidate = this.#candidates.get(`${tenantId}\u0000${candidateId}`);
    return candidate === undefined ? null : clone(candidate);
  }

  async getCandidate(tenantId: string, eventId: string, candidateId: string) {
    const candidate = await this.getCandidateById(tenantId, candidateId);
    return candidate?.eventId === eventId ? candidate : null;
  }

  async listCandidates(tenantId: string, eventId: string) {
    return clone(
      [...this.#candidates.values()].filter(
        (candidate) => candidate.tenantId === tenantId && candidate.eventId === eventId,
      ),
    );
  }

  async saveCandidate(candidate: ContentRemixCandidate, expectedVersion: number | null) {
    const key = `${candidate.tenantId}\u0000${candidate.id}`;
    const current = this.#candidates.get(key);
    if ((current?.version ?? null) !== expectedVersion) {
      throw new Error("The remix candidate changed.");
    }
    this.#candidates.set(key, clone(candidate));
  }

  async appendAudit(entry: RemixAuditEntry) {
    const key = `${entry.tenantId}\u0000${entry.eventId}`;
    const entries = this.#audit.get(key) ?? [];
    entries.push(clone(entry));
    this.#audit.set(key, entries);
  }

  async listAudit(tenantId: string, eventId: string) {
    return clone(this.#audit.get(`${tenantId}\u0000${eventId}`) ?? []);
  }
}

class LocalRemixContentGateway implements RemixContentGateway {
  constructor(
    private readonly sessions: SessionService,
    private readonly sessionRepository: InMemorySessionRepository,
    private readonly speakers: LocalSpeakerRepository,
  ) {}

  async listSessions(input: {
    tenantId: string;
    eventId: string;
  }): Promise<readonly RemixSessionRecord[]> {
    const sessions = await this.sessionRepository.listSessions(input.tenantId, input.eventId);
    return sessions.map((session) => ({
      kind: "session",
      id: session.id,
      eventId: session.eventId,
      revision: session.version,
      title: session.title,
      description: session.description,
      tags: [...session.tagIds],
      tracks: [...session.trackIds],
    }));
  }

  async listSpeakers(input: {
    tenantId: string;
    eventId: string;
  }): Promise<readonly RemixSpeakerRecord[]> {
    const profiles = await this.speakers.listProfiles(input.eventId, ["local-participant"]);
    return profiles.map((profile) => ({
      kind: "speaker",
      id: profile.participantId,
      eventId: profile.eventId,
      revision: profile.version,
      biography: profile.biography,
    }));
  }

  async getSession(input: {
    tenantId: string;
    eventId: string;
    sourceId: string;
  }): Promise<RemixSessionRecord | null> {
    const session = await this.sessionRepository.getSession(
      input.tenantId,
      input.eventId,
      input.sourceId,
    );
    return session === null
      ? null
      : {
          kind: "session",
          id: session.id,
          eventId: session.eventId,
          revision: session.version,
          title: session.title,
          description: session.description,
          tags: [...session.tagIds],
          tracks: [...session.trackIds],
        };
  }

  async getSpeaker(input: {
    tenantId: string;
    eventId: string;
    sourceId: string;
  }): Promise<RemixSpeakerRecord | null> {
    const profile = await this.speakers.getProfile(input.eventId, input.sourceId);
    return profile === null
      ? null
      : {
          kind: "speaker",
          id: profile.participantId,
          eventId: profile.eventId,
          revision: profile.version,
          biography: profile.biography,
        };
  }

  async applyRevision(input: {
    tenantId: string;
    eventId: string;
    sourceType: "session" | "speaker";
    sourceId: string;
    expectedSourceRevision: number;
    fields: readonly ("title" | "description" | "tags" | "tracks" | "biography")[];
    content:
      | { title: string; description: string; tags: readonly string[]; tracks: readonly string[] }
      | { biography: string };
    candidateId: string;
    actorId: string;
    appliedAt: string;
  }) {
    if (input.sourceType === "session") {
      const content = input.content as {
        title: string;
        description: string;
        tags: readonly string[];
        tracks: readonly string[];
      };
      const current = await this.sessionRepository.getSession(
        input.tenantId,
        input.eventId,
        input.sourceId,
      );
      if (current === null) throw new Error("The session content was not found.");
      const updated = await this.sessions.updateSession(
        {
          tenantId: input.tenantId,
          userId: input.actorId,
          role: "owner",
          kind: "user",
        },
        {
          tenantId: input.tenantId,
          eventId: input.eventId,
          sessionId: input.sourceId,
          expectedVersion: input.expectedSourceRevision,
          title: content.title,
          description: content.description,
          tagIds: [...content.tags],
          trackIds: [...content.tracks],
        },
      );
      return {
        id: `revision:${input.candidateId}`,
        tenantId: input.tenantId,
        eventId: input.eventId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceRevision: updated.version,
        fields: [...input.fields],
        content: clone(content),
        candidateId: input.candidateId,
        appliedBy: input.actorId,
        appliedAt: input.appliedAt,
      };
    }
    const content = input.content as { biography: string };
    const result = await this.speakers.updateBiography({
      eventId: input.eventId,
      participantId: input.sourceId,
      biography: content.biography,
      expectedVersion: input.expectedSourceRevision,
      updatedAt: input.appliedAt,
    });
    if (!result.ok) throw new Error("The speaker content was not found.");
    return {
      id: `revision:${input.candidateId}`,
      tenantId: input.tenantId,
      eventId: input.eventId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceRevision: result.value.version,
      fields: [...input.fields],
      content: clone(content),
      candidateId: input.candidateId,
      appliedBy: input.actorId,
      appliedAt: input.appliedAt,
    };
  }
}

class LocalOrganizerOverviewRepository implements OrganizerOverviewRouteDependencies {
  readonly #publicRepository: LocalPublicApiRepository;
  readonly #speakerRepository: LocalSpeakerRepository;
  readonly #assignments: readonly LocalOverviewAssignment[];

  constructor(options: {
    readonly publicRepository: LocalPublicApiRepository;
    readonly speakerRepository: LocalSpeakerRepository;
    readonly assignments?: readonly LocalOverviewAssignment[];
  }) {
    this.#publicRepository = options.publicRepository;
    this.#speakerRepository = options.speakerRepository;
    this.#assignments = options.assignments ?? [];
  }

  async getOverviewCore(organizationId: string): Promise<OrganizerOverviewCoreData> {
    const { events } = this.scopedEvents(organizationId);
    return {
      organizationId,
      metrics: { eventCount: events.length },
      events,
    };
  }

  async getOverviewActivity(organizationId: string): Promise<OrganizerOverviewActivityData> {
    const { events, eventIds } = this.scopedEvents(organizationId);
    if (events.length === 0) {
      return {
        organizationId,
        metrics: {
          submissionCount: 0,
          pendingReviewCount: 0,
          outstandingSpeakerTaskCount: 0,
          publishedSessionCount: 0,
        },
        actionItems: [],
      };
    }

    const submissions =
      organizationId === LOCAL_ORGANIZATION_ID
        ? events.flatMap((event) =>
            this.#speakerRepository
              .listStoredSubmissions(event.id)
              .filter((submission) => submission.status !== "withdrawn"),
          )
        : [];
    const pendingAssignments = this.#assignments.filter(
      (assignment) =>
        assignment.tenantId === organizationId &&
        eventIds.has(assignment.eventId) &&
        (assignment.status === "assigned" || assignment.status === "in_progress"),
    );
    const tasks =
      organizationId === LOCAL_ORGANIZATION_ID
        ? events.flatMap((event) =>
            this.#speakerRepository
              .listStoredTasks(event.id)
              .filter((task) => task.status !== "completed" && task.status !== "waived"),
          )
        : [];
    const sessions = this.#publicRepository
      .listStored(organizationId, "sessions")
      .filter(
        (session) =>
          eventIds.has(textValue(session, "eventId") ?? "") &&
          textValue(session, "status") !== "cancelled",
      );
    const publishedSessionIdsByEvent = new Map(
      events.map(
        (event) => [event.id, this.publishedSessionIds(organizationId, event.id)] as const,
      ),
    );
    const publishedSessionCount = [...publishedSessionIdsByEvent.values()].reduce(
      (total, ids) => total + ids.size,
      0,
    );
    const actionItems: OrganizerOverviewActionItem[] = [];

    for (const event of events) {
      const eventPendingReviews = pendingAssignments.filter(
        (assignment) => assignment.eventId === event.id,
      );
      if (eventPendingReviews.length > 0) {
        actionItems.push({
          id: `reviews:${event.id}`,
          type: "reviews",
          eventId: event.id,
          title:
            eventPendingReviews.length === 1
              ? "Complete a pending review"
              : "Complete pending reviews",
          description: `${eventPendingReviews.length} review${eventPendingReviews.length === 1 ? "" : "s"} still need organizer attention.`,
          count: eventPendingReviews.length,
          priority: 90,
          dueAt: earliestDueAt(eventPendingReviews.map((assignment) => assignment.dueAt ?? null)),
          href: hrefFor(organizationId, event.id, "reviews"),
        });
      }

      const eventTasks = tasks.filter((task) => task.eventId === event.id);
      if (eventTasks.length > 0) {
        actionItems.push({
          id: `speaker_tasks:${event.id}`,
          type: "speaker_tasks",
          eventId: event.id,
          title: eventTasks.length === 1 ? "Resolve a speaker task" : "Resolve speaker tasks",
          description: `${eventTasks.length} speaker task${eventTasks.length === 1 ? "" : "s"} remain open.`,
          count: eventTasks.length,
          priority: 70,
          dueAt: earliestDueAt(eventTasks.map((task) => task.dueAt ?? null)),
          href: hrefFor(organizationId, event.id, "speakers"),
        });
      }

      const eventSessions = sessions.filter(
        (session) => textValue(session, "eventId") === event.id,
      );
      const publishedIds = publishedSessionIdsByEvent.get(event.id) ?? new Set<string>();
      const unpublishedSessionCount = eventSessions.filter(
        (session) => !publishedIds.has(textValue(session, "id") ?? ""),
      ).length;
      if (unpublishedSessionCount > 0) {
        actionItems.push({
          id: `agenda:${event.id}`,
          type: "agenda",
          eventId: event.id,
          title:
            unpublishedSessionCount === 1
              ? "Publish the remaining session"
              : "Publish the remaining sessions",
          description: `${unpublishedSessionCount} session${unpublishedSessionCount === 1 ? "" : "s"} are not in the current published agenda.`,
          count: unpublishedSessionCount,
          priority: 50,
          dueAt: null,
          href: hrefFor(organizationId, event.id, "agenda"),
        });
      }
    }

    actionItems.sort(
      (left, right) =>
        right.priority - left.priority ||
        compareNullableDates(left.dueAt, right.dueAt) ||
        left.id.localeCompare(right.id),
    );
    return {
      organizationId,
      metrics: {
        submissionCount: submissions.length,
        pendingReviewCount: pendingAssignments.length,
        outstandingSpeakerTaskCount: tasks.length,
        publishedSessionCount,
      },
      actionItems,
    };
  }

  private scopedEvents(organizationId: string): {
    readonly events: OrganizerOverviewEvent[];
    readonly eventIds: ReadonlySet<string>;
  } {
    const events = this.#publicRepository
      .listStored(organizationId, "events")
      .map((event) => this.eventView(event))
      .sort((left, right) => left.id.localeCompare(right.id));
    return { events, eventIds: new Set(events.map((event) => event.id)) };
  }
  private eventView(record: Record<string, unknown>): OrganizerOverviewEvent {
    const id = textValue(record, "id") ?? "unknown";
    return {
      id,
      name: textValue(record, "name", "title") ?? id,
      slug: textValue(record, "slug"),
      startsAt: textValue(record, "startsAt", "startsOn", "startAt"),
      endsAt: textValue(record, "endsAt", "endsOn", "endAt"),
    };
  }

  private publishedSessionIds(organizationId: string, eventId: string): ReadonlySet<string> {
    const agenda = this.#publicRepository
      .listStored(organizationId, "agenda")
      .find((record) => textValue(record, "id", "eventId") === eventId);
    if (agenda === undefined) return new Set<string>();
    const values = agenda.sessionIds ?? agenda.publishedSessionIds;
    return Array.isArray(values)
      ? new Set(values.filter((value): value is string => typeof value === "string"))
      : new Set<string>();
  }
}

function textValue(record: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function earliestDueAt(values: readonly (string | null)[]): string | null {
  return (
    values
      .filter((value): value is string => value !== null && !Number.isNaN(Date.parse(value)))
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null
  );
}

function hrefFor(
  organizationId: string,
  eventId: string,
  suffix: "reviews" | "speakers" | "agenda",
): string {
  return `/admin/organizations/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(eventId)}/${suffix}`;
}

function compareNullableDates(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return Date.parse(left) - Date.parse(right);
}

function agendaEngineAfterSeed(engine: AgendaEngine, seeded: Promise<void>): AgendaEngine {
  const repository: AgendaRepository = {
    async load(eventId) {
      await seeded;
      return engine.repository.load(eventId);
    },
    async compareAndSwap(eventId, expectedStateVersion, nextState) {
      await seeded;
      return engine.repository.compareAndSwap(eventId, expectedStateVersion, nextState);
    },
  };
  return new Proxy(engine, {
    get(target, property, receiver) {
      if (property === "repository") return repository;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => seeded.then(() => Reflect.apply(value, target, args));
    },
  });
}

function serviceAfterSeed<TService extends object>(
  service: TService,
  seeded: Promise<void>,
): TService {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => seeded.then(() => Reflect.apply(value, target, args));
    },
  });
}

function localCfpServiceWithSeed(
  service: ReturnType<typeof createLocalCfpService>,
  prerequisite: Promise<void>,
  onSeeded: (submissions: readonly SubmissionReviewMaterial[]) => Promise<void>,
): {
  readonly service: ReturnType<typeof createLocalCfpService>;
  readonly seeded: Promise<void>;
} {
  const seeded = prerequisite
    .then(() =>
      seedLocalCfpForm(service, {
        tenantId: LOCAL_ORGANIZATION_ID,
        eventId: "demo-event",
        formId: "main-cfp",
        actorId: LOCAL_ORGANIZER_ACCOUNT_ID,
      }),
    )
    .then(() =>
      seedLocalCfpScenario(service, {
        tenantId: LOCAL_ORGANIZATION_ID,
        eventId: "demo-event",
        formId: "main-cfp",
        submissionCount: 300,
        submissionFactory(index) {
          const scenario = localSubmissionScenario(index);
          return index === 0
            ? {
                ...scenario,
                ownerAccountId: LOCAL_SPEAKER_ACCOUNT_ID,
                participant: {
                  ...scenario.participant,
                  id: "local-participant",
                  email: LOCAL_SPEAKER_EMAIL,
                },
              }
            : scenario;
        },
      }),
    )
    .then(onSeeded);
  return {
    service: serviceAfterSeed(service, seeded),
    seeded,
  };
}

class LocalEventRoleInvitationRepository extends InMemoryEventRoleInvitationRepository {
  constructor(
    seed: readonly EventRoleInvitation[],
    private readonly onAccepted: (invitation: EventRoleInvitation) => void,
  ) {
    super(seed);
  }

  override async accept(
    input: EventRoleInvitationTransitionInput,
  ): Promise<EventRoleInvitation | null> {
    const invitation = await super.accept(input);
    if (invitation?.status === "accepted") this.onAccepted(invitation);
    return invitation;
  }
}

function eventIdFrom(request: Request): string | null {
  const url = new URL(request.url);
  const pathMatch = /\/(?:events|event)\/([^/]+)/u.exec(url.pathname)?.[1];
  if (pathMatch !== undefined) return decodeURIComponent(pathMatch);

  const queryEventId = url.searchParams.get("eventId")?.trim();
  return queryEventId === undefined || queryEventId.length === 0 ? null : queryEventId;
}

function localCfpEvent(event: Event): EventCfp {
  const configuredOpensAt = event.cfpSettings.opensAt ?? event.startsAt;
  const configuredClosesAt = event.cfpSettings.closesAt ?? event.endsAt;
  const hasValidConfiguredWindow = Date.parse(configuredOpensAt) < Date.parse(configuredClosesAt);
  return {
    id: event.id,
    tenantId: event.organizationId,
    version: event.version,
    slug: event.slug,
    name: event.name,
    timezone: event.timeZone,
    eventStartsAt: event.startsAt,
    opensAt: hasValidConfiguredWindow ? configuredOpensAt : event.startsAt,
    closesAt: hasValidConfiguredWindow ? configuredClosesAt : event.endsAt,
  };
}

export function createLocalDependencies(aiProviders?: CloudflareAiProviders): ApiDependencies {
  const personas = [...LOCAL_PERSONAS];
  let localDecisionFenceChecker: (fence: DecisionVersionFence) => Promise<boolean> = async () =>
    true;
  const speakerRepository = new LocalSpeakerRepository(
    (email) => {
      const recipients = personas.filter(
        (persona) => persona.email.trim().toLowerCase() === email.trim().toLowerCase(),
      );
      const recipient = recipients.length === 1 ? recipients[0] : undefined;
      return recipient === undefined
        ? null
        : { userId: recipient.userId, normalizedEmail: recipient.email.trim().toLowerCase() };
    },
    undefined,
    (fence) => localDecisionFenceChecker(fence),
  );
  const localEventInvitationSeed: EventRoleInvitation[] = [
    ...LOCAL_REVIEW_SCENARIO_REVIEWERS.map(
      (reviewer): EventRoleInvitation => ({
        id: `local-reviewer-invitation:${reviewer.id}:demo-event`,
        organizationId: LOCAL_ORGANIZATION_ID,
        organizationName: "Eventloom",
        eventId: "demo-event",
        eventName: "Open Sessionboard Conference",
        role: "reviewer",
        recipientUserId: reviewer.id,
        recipientEmail: reviewer.email.trim().toLowerCase(),
        normalizedEmail: reviewer.email.trim().toLowerCase(),
        participantId: null,
        status: "accepted",
        creationIdempotencyKey: `local-reviewer:${reviewer.id}:demo-event`,
        invitedByActorType: "user",
        invitedByActorId: LOCAL_ORGANIZER_ACCOUNT_ID,
        invitedAt: SEEDED_AT,
        createdBy: LOCAL_ORGANIZER_ACCOUNT_ID,
        createdAt: SEEDED_AT,
        acceptedByUserId: reviewer.id,
        acceptedAt: SEEDED_AT,
        declinedByUserId: null,
        declinedAt: null,
        revokedByActorType: null,
        revokedByActorId: null,
        revokedAt: null,
        version: 2,
        updatedAt: SEEDED_AT,
      }),
    ),
    {
      id: "local-speaker-invitation:demo-event:local-participant",
      organizationId: LOCAL_ORGANIZATION_ID,
      organizationName: "Eventloom",
      eventId: "demo-event",
      eventName: "Open Sessionboard Conference",
      role: "speaker",
      recipientUserId: LOCAL_SPEAKER_ACCOUNT_ID,
      recipientEmail: LOCAL_SPEAKER_EMAIL,
      normalizedEmail: LOCAL_SPEAKER_EMAIL,
      participantId: "local-participant",
      status: "accepted",
      creationIdempotencyKey: "evaluation-acceptance:local-submission:local-participant",
      invitedByActorType: "user",
      invitedByActorId: LOCAL_ORGANIZER_ACCOUNT_ID,
      invitedAt: SEEDED_AT,
      createdBy: LOCAL_ORGANIZER_ACCOUNT_ID,
      createdAt: SEEDED_AT,
      acceptedByUserId: LOCAL_SPEAKER_ACCOUNT_ID,
      acceptedAt: SEEDED_AT,
      declinedByUserId: null,
      declinedAt: null,
      revokedByActorType: null,
      revokedByActorId: null,
      revokedAt: null,
      version: 2,
      updatedAt: SEEDED_AT,
    },
  ];
  const eventInvitationRepository = new LocalEventRoleInvitationRepository(
    localEventInvitationSeed,
    (invitation) => {
      const personaIndex = personas.findIndex(
        ({ userId }) => userId === invitation.recipientUserId,
      );
      const persona = personas[personaIndex];
      if (persona !== undefined && invitation.role === "reviewer") {
        const hasMembership = persona.memberships.some(
          ({ organizationId, role }) =>
            organizationId === invitation.organizationId && role === "reviewer",
        );
        if (!hasMembership) {
          personas[personaIndex] = {
            ...persona,
            memberships: [
              ...persona.memberships,
              { organizationId: invitation.organizationId, role: "reviewer" },
            ],
          };
        }
      }
      if (invitation.role === "speaker" && invitation.participantId !== null) {
        speakerRepository.acceptSpeakerInvitation(
          invitation.recipientUserId,
          invitation.eventId,
          invitation.participantId,
        );
      }
    },
  );
  const eventRoleInvitationAdapters = createRuntimeEventRoleInvitationAdapters(
    eventInvitationRepository,
    { clock: () => new Date(SEEDED_AT) },
  );
  const authenticator = localAuthenticator(personas, eventInvitationRepository);
  const privateAssetGateway = new LocalPrivateAssetGateway(
    speakerRepository.appendAssetAudit.bind(speakerRepository),
  );
  let speakerService!: SpeakerService;
  const publicRepository = new LocalPublicApiRepository();
  const eventRepository = new InMemoryEventRepository();
  const eventService = new EventService(
    eventRepository,
    {
      async reviewBoundaries(organizationId, eventId) {
        const plans = await evaluationRepository.listPlans(organizationId, eventId);
        return plans.flatMap((plan) => [
          ...(plan.closesAt === null
            ? []
            : [{ label: "Review deadline", occursAt: plan.closesAt }]),
          ...plan.rounds.flatMap((round) => [
            ...(round.opensAt == null
              ? []
              : [{ label: `Review round ${round.sequence} opening`, occursAt: round.opensAt }]),
            ...(round.closesAt == null
              ? []
              : [{ label: `Review round ${round.sequence} deadline`, occursAt: round.closesAt }]),
          ]),
        ]);
      },
      async agendaState(_organizationId, eventId) {
        const state = await agendaEngine.repository.load(eventId);
        return state === null ? null : { timeZone: state.timeZone };
      },
      async agendaEntries(_organizationId, eventId) {
        const state = await agendaEngine.repository.load(eventId);
        if (state === null) return [];
        const published = state.revisions.find(
          (revision) => revision.id === state.currentPublishedRevisionId,
        );
        return [...state.draft.entries, ...(published?.entries ?? [])].map((entry) => ({
          label: `Agenda entry ${entry.id}`,
          startsAt: entry.startsAt,
          endsAt: entry.endsAt,
          startsAtLocal: entry.startsAtLocal,
          endsAtLocal: entry.endsAtLocal,
        }));
      },
    },
    {
      clock: () => new Date(EVENT_SEED_AT),
      generateId: (() => {
        let sequence = 0;
        return () => `local-event-id-${++sequence}`;
      })(),
    },
  );
  const publicationRepository = new InMemoryProgramPublicationRepository();
  let publicationService!: ProgramPublicationService;
  publicationService = new ProgramPublicationService(
    publicationRepository,
    {
      eventRepository,
      enqueue: {
        async enqueue(input) {
          const state = await publicationRepository.getState(input.organizationId, input.eventId);
          if (state === null) throw new Error("The pending program publication was not stored.");
          const reservationOwnerId = state.releases.find(
            (release) => release.id === input.releaseId && release.revision === input.revision,
          )?.reservationOwnerId;
          if (reservationOwnerId === null || reservationOwnerId === undefined) {
            throw new Error("The pending program publication is missing reservation ownership.");
          }
          await publicationService.completeRebuild({
            ...input,
            expectedPublicationVersion: state.version,
            reservationOwnerId,
          });
          return { id: input.releaseId };
        },
      },
      cacheInvalidation: { async invalidate() {} },
    },
    {
      clock: () => new Date(SEEDED_AT),
      generateId: (() => {
        let sequence = 0;
        return () => `local-program-release-${++sequence}`;
      })(),
    },
  );
  const sessionRepository = new LocalSessionRepository(speakerRepository, (fence) =>
    localDecisionFenceChecker(fence),
  );
  speakerRepository.setCanonicalSessionReader(async (eventId) =>
    (await sessionRepository.listSessions(LOCAL_ORGANIZATION_ID, eventId))
      .filter((session) => session.status.trim().toLowerCase() === "accepted")
      .flatMap((session) =>
        session.speakerIds.map((participantId) => ({
          participantId,
          sessionId: session.id,
          title: session.title,
          status: session.status,
          version: session.version,
        })),
      ),
  );
  const deterministicAgendaSuggestions = new DeterministicAgendaSuggestionProvider();
  const agendaMutationLock = new InMemoryAgendaMutationLock();
  const agendaEngine = localAgendaEngine(
    eventRepository,
    agendaMutationLock,
    aiProviders?.agenda ?? {
      suggest: (request) => ({
        placements: deterministicAgendaSuggestions.suggest(request)?.placements?.slice(0, 1) ?? [],
      }),
    },
  );
  let sessionService!: SessionService;
  let completeApprovedRevision:
    | ((eventId: string, revision: PublishedAgendaRevision) => Promise<void>)
    | undefined;
  const agendaCatalogSynchronizer = new AgendaCatalogSynchronizer({
    engine: agendaEngine,
    catalogReader: {
      getAgendaCatalog: (tenantId, eventId) => sessionService.getAgendaCatalog(tenantId, eventId),
    },
    minimumTravelMinutes: 10,
    actorId: LOCAL_ORGANIZER_ACCOUNT_ID,
    maxRetries: 8,
  });
  const contentPropagatingAgendaCatalogSynchronizer = {
    ensureInitialized: agendaCatalogSynchronizer.ensureInitialized.bind(agendaCatalogSynchronizer),
    async synchronize(input: {
      readonly tenantId: string;
      readonly eventId: string;
      readonly actorId?: string;
      readonly timeZone?: string;
      readonly minimumTravelMinutes?: number;
    }) {
      const synchronized = await agendaCatalogSynchronizer.synchronizePublishedContent(
        input,
        (current) =>
          agendaEngine.refreshPublishedContent({
            eventId: input.eventId,
            actorId: input.actorId ?? LOCAL_ORGANIZER_ACCOUNT_ID,
            expectedCatalogVersion: current.draft.version,
            catalog: current.catalog,
            async afterRefresh(refresh) {
              if (refresh.revision === null) return;
              if (completeApprovedRevision === undefined) {
                throw new Error("Approved public revision handoff is not initialized.");
              }
              await completeApprovedRevision(input.eventId, refresh.revision);
            },
          }),
      );
      return synchronized.draft;
    },
  };
  sessionService = new SessionService(sessionRepository, {
    clock: () => new Date(SEEDED_AT),
    agendaCatalogSynchronizer: contentPropagatingAgendaCatalogSynchronizer,
  });
  const organizerEventActor = {
    organizationId: LOCAL_ORGANIZATION_ID,
    userId: LOCAL_ORGANIZER_ACCOUNT_ID,
    role: "owner" as const,
    kind: "user" as const,
  };
  const organizerSessionActor = {
    tenantId: LOCAL_ORGANIZATION_ID,
    userId: LOCAL_ORGANIZER_ACCOUNT_ID,
    role: "owner" as const,
    kind: "user" as const,
  };
  const fixtureGraphReady = (async () => {
    await eventService.createEvent(organizerEventActor, {
      id: "open-sessionboard-conf",
      organizationId: LOCAL_ORGANIZATION_ID,
      slug: "open-sessionboard-conf",
      name: "Eventloom Conference",
      timeZone: LOCAL_EVENT_TIME_ZONE,
      startsAt: "2026-09-17T16:00:00.000Z",
      endsAt: "2026-09-18T23:00:00.000Z",
      venue: LOCAL_EVENT_VENUE,
      cfpSettings: {
        enabled: true,
        opensAt: "2026-08-01T07:00:00.000Z",
        closesAt: "2026-09-15T07:00:00.000Z",
      },
    });
    await eventService.createEvent(organizerEventActor, {
      id: "demo-event",
      organizationId: LOCAL_ORGANIZATION_ID,
      slug: "demo-event",
      name: "Open Sessionboard Conference",
      timeZone: LOCAL_EVENT_TIME_ZONE,
      startsAt: LOCAL_EVENT_START,
      endsAt: LOCAL_EVENT_END,
      venue: LOCAL_EVENT_VENUE,
      cfpSettings: {
        enabled: true,
        opensAt: "2026-08-01T07:00:00.000Z",
        closesAt: "2026-09-15T07:00:00.000Z",
      },
      embedConfigurations: [LOCAL_PUBLIC_EMBED],
    });
    await Promise.all([
      sessionService.createRoom(organizerSessionActor, {
        id: "local-room-main",
        eventId: "demo-event",
        name: "Main Hall",
        capacity: 200,
      }),
      sessionService.createRoom(organizerSessionActor, {
        id: "local-room-studio",
        eventId: "demo-event",
        name: "Workshop Studio",
        capacity: 48,
      }),
      sessionService.createTrack(organizerSessionActor, {
        id: "local-track-main",
        eventId: "demo-event",
        name: "Main stage",
        description: "Featured program sessions.",
      }),
      sessionService.createTrack(organizerSessionActor, {
        id: "local-track-practice",
        eventId: "demo-event",
        name: "Practice",
        description: "Hands-on program sessions.",
      }),
      sessionService.createFormat(organizerSessionActor, {
        id: "local-format-talk",
        eventId: "demo-event",
        name: "Featured Keynote",
      }),
      sessionService.createFormat(organizerSessionActor, {
        id: "local-format-workshop",
        eventId: "demo-event",
        name: "Workshop",
      }),
      sessionService.createLevel(organizerSessionActor, {
        id: "local-level-all",
        eventId: "demo-event",
        name: "All levels",
      }),
      sessionService.createTag(organizerSessionActor, {
        id: "local-tag-reliable",
        eventId: "demo-event",
        name: "Reliable systems",
      }),
    ]);
  })();
  let crmSequence = 0;
  const crmService = new CrmService(
    { repository: new InMemoryCrmRepository() },
    {
      clock: () => new Date(SEEDED_AT),
      generateId: (prefix) => `${prefix}-local-${++crmSequence}`,
    },
  );
  const evaluationSubmissions = new InMemorySubmissionReviewSource();
  const evaluationRepository = new InMemoryEvaluationRepository(evaluationSubmissions);
  localDecisionFenceChecker = async (fence) => {
    const decision = await evaluationRepository.getDecision(
      fence.tenantId,
      fence.planId,
      fence.submissionId,
    );
    return (
      decision !== null &&
      decision.eventId === fence.eventId &&
      decision.version === fence.version &&
      decision.status === fence.status
    );
  };
  const localEvaluationPlan: EvaluationPlan = {
    id: "local-evaluation-plan",
    tenantId: LOCAL_ORGANIZATION_ID,
    eventId: "demo-event",
    name: "Program review",
    status: "open",
    blindReview: true,
    closesAt: "2026-09-10T19:00:00.000Z",
    assignmentRule: {
      reviewsPerSubmission: 2,
      maxAssignmentsPerReviewer: 32,
    },
    rounds: [
      {
        id: "local-review-round",
        name: "Committee review",
        sequence: 1,
        opensAt: "2026-08-08T12:00:00.000Z",
        closesAt: "2026-09-10T19:00:00.000Z",
        blindReview: true,
        anonymization: "double",
        reviewerPool: {
          name: "Program committee",
          reviewerIds: LOCAL_REVIEW_SCENARIO_REVIEWERS.map(({ id }) => id),
        },
        rubric: {
          id: "local-program-rubric",
          name: "Program rubric",
          criteria: [
            {
              id: "quality",
              label: "Overall quality",
              description: "How strong and useful is this proposal for the event audience?",
              minimum: 1,
              maximum: 5,
              weight: 2,
              required: true,
              inputType: "numeric",
            },
            {
              id: "recommendation",
              label: "Recommendation",
              description: "Would you recommend this proposal for the program?",
              minimum: 0,
              maximum: 2,
              weight: 0,
              required: true,
              inputType: "dropdown",
              options: [
                { label: "Accept", value: "accept" },
                { label: "Maybe", value: "maybe" },
                { label: "Reject", value: "reject" },
              ],
            },
          ],
        },
      },
    ],
    reviewerProjection: {
      fieldIds: ["format", "level"],
      fileIds: [],
    },
    gradingLockedAt: SEEDED_AT,
    version: 2,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  };
  const localReviewMaterials = new Map<string, SubmissionReviewMaterial>();
  const localAcceptanceHandoff: EvaluationAcceptanceHandoff = {
    async accept(input: EvaluationAcceptanceHandoffInput): Promise<void> {
      const isCurrentDecision = input.isCurrentDecision ?? (async () => true);
      if (!(await isCurrentDecision())) return;
      const material = localReviewMaterials.get(input.submissionId);
      if (
        material === undefined ||
        material.tenantId !== input.tenantId ||
        material.eventId !== input.eventId
      ) {
        throw new Error("The accepted local submission was not found in the event review graph.");
      }
      if (!(await isCurrentDecision())) return;
      speakerRepository.acceptSubmission(input.eventId, input.submissionId, input.decidedAt);
      if (!(await isCurrentDecision())) return;
      await Promise.all(
        material.participants.map(async (participant) => {
          if (!(await isCurrentDecision())) return;
          const email = participant.email.trim().toLowerCase();
          const recipients = personas.filter(
            (persona) => persona.email.trim().toLowerCase() === email,
          );
          if (email.length === 0 || recipients.length !== 1) return;
          const recipient = recipients[0];
          if (recipient === undefined) return;
          if (!(await isCurrentDecision())) return;
          const existing = (
            await eventInvitationRepository.listForVerifiedAccount(recipient.userId, email)
          ).find(
            (invitation) =>
              invitation.eventId === input.eventId &&
              invitation.role === "speaker" &&
              invitation.participantId === participant.id,
          );
          if (existing !== undefined) {
            if (existing.status === "accepted") {
              speakerRepository.acceptSpeakerInvitation(
                recipient.userId,
                input.eventId,
                participant.id,
              );
            }
            return;
          }
          if (!(await isCurrentDecision())) return;
          await eventRoleInvitationAdapters.speakerCreator.create({
            id: `local-speaker-invitation:${input.eventId}:${participant.id}`,
            organizationId: input.tenantId,
            eventId: input.eventId,
            role: "speaker",
            recipientUserId: recipient.userId,
            normalizedEmail: email,
            participantId: participant.id,
            creationIdempotencyKey: `evaluation-acceptance:${input.submissionId}:${participant.id}`,
            invitedByActorType: "user",
            invitedByActorId: input.decidedBy,
            invitedAt: input.decidedAt,
            ...(input.decisionFence === undefined ? {} : { decisionFence: input.decisionFence }),
          });
        }),
      );
      const firstParticipant = material.participants[0];
      if (firstParticipant === undefined) {
        throw new Error("An accepted local submission must include a speaker.");
      }
      const featured = material.title === "Designing reliable community systems";
      if (!(await isCurrentDecision())) return;
      await sessionService.upsertAcceptedSession({
        actorId: input.decidedBy,
        ...(input.isCurrentDecision === undefined
          ? {}
          : { beforePersist: input.isCurrentDecision }),
        decisionFence: input.decisionFence,
        session: {
          id: `session-${material.id}`,
          tenantId: input.tenantId,
          eventId: input.eventId,
          title: material.title,
          description: material.abstract,
          status: "Accepted",
          durationMinutes: 60,
          capacityRequired: featured ? 120 : 36,
          roomId: featured ? "local-room-main" : "local-room-studio",
          trackId: featured ? "local-track-main" : "local-track-practice",
          trackIds: [featured ? "local-track-main" : "local-track-practice"],
          formatId: featured ? "local-format-talk" : "local-format-workshop",
          levelId: "local-level-all",
          tagIds: featured ? ["local-tag-reliable"] : [],
          speakerIds: material.participants.map(({ id }) => id),
          speakerRoster: material.participants.map((participant) => ({
            id: participant.id,
            displayName: participant.displayName,
            role: "primary",
          })),
          resourceIds: [],
          version: 1,
          createdAt: input.decidedAt,
          updatedAt: input.decidedAt,
          createdBy: input.decidedBy,
          updatedBy: input.decidedBy,
          history: [],
        },
      });
      if (!(await isCurrentDecision())) return;
      await speakerService.createOrganizerTask({
        eventId: input.eventId,
        accountId: input.decidedBy,
        type: featured ? "upload" : "form",
        title: featured ? "Upload your presentation slides" : "Complete your speaker profile",
        description: featured
          ? "Upload the final PDF or PowerPoint slides for your accepted session."
          : "Review your public name and biography before the program is published.",
        ...(featured
          ? {
              allowedMimeTypes: [...standardPresentationUploadMimeTypes],
              maxBytes: 25 * 1024 * 1024,
              acceptedAssetKinds: ["slides" as const],
            }
          : {}),
        dueAt: "2026-09-01",
        reminderOffsetsMinutes: [10_080, 1_440],
        assignments: material.participants.map((participant) => ({
          participantId: participant.id,
          subject: { type: "session", sessionId: `session-${material.id}` },
        })),
        ...(input.decisionFence === undefined ? {} : { decisionFence: input.decisionFence }),
      });
    },
    async reconcileSessionDecision(input) {
      await sessionService.reconcileDecisionSessionStatus({
        tenantId: input.tenantId,
        eventId: input.eventId,
        sessionId: `session-${input.submissionId}`,
        status: input.status,
        actorId: input.decidedBy,
        isCurrentDecision: input.isCurrentDecision,
        decisionFence: input.decisionFence,
      });
    },
  };
  const evaluationService = new EvaluationService(
    evaluationRepository,
    evaluationSubmissions,
    {
      async getEventMetadata(tenantId, eventId) {
        const event = await eventRepository.getEvent(tenantId, eventId);
        return event === null
          ? null
          : {
              id: event.id,
              name: event.name,
              timeZone: event.timeZone,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
            };
      },
    },
    {
      clock: () => new Date(SEEDED_AT),
      eventSource: eventRepository,
      acceptanceHandoff: localAcceptanceHandoff,
      ...(aiProviders?.evaluations === undefined
        ? {}
        : { aiSuggestionProvider: aiProviders.evaluations }),
    },
  );
  const organizerOverview = new LocalOrganizerOverviewRepository({
    publicRepository,
    speakerRepository,
    assignments: [
      {
        id: "local-review-assignment",
        tenantId: LOCAL_ORGANIZATION_ID,
        eventId: "demo-event",
        status: "assigned",
        dueAt: "2026-09-12T23:59:00.000Z",
      },
    ],
  });
  const localMemberUsers: MemberUser[] = [
    {
      userId: LOCAL_ORGANIZER_ACCOUNT_ID,
      email: LOCAL_ORGANIZER_EMAIL,
      name: "Local Organizer",
      emailVerified: true,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
    ...LOCAL_REVIEW_SCENARIO_REVIEWERS.map(
      (reviewer): MemberUser => ({
        userId: reviewer.id,
        email: reviewer.email,
        name: reviewer.name,
        emailVerified: true,
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT,
      }),
    ),
    {
      userId: LOCAL_SPEAKER_ACCOUNT_ID,
      email: LOCAL_SPEAKER_EMAIL,
      name: "Alex Rivera",
      emailVerified: true,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
  ];
  const localMemberMemberships: MemberMembership[] = [
    {
      organizationId: LOCAL_ORGANIZATION_ID,
      userId: LOCAL_ORGANIZER_ACCOUNT_ID,
      role: "owner",
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
    ...LOCAL_REVIEW_SCENARIO_REVIEWERS.map(
      (reviewer): MemberMembership => ({
        organizationId: LOCAL_ORGANIZATION_ID,
        userId: reviewer.id,
        role: "reviewer",
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT,
      }),
    ),
  ];
  const reviewerPool: ReviewerPool = {
    organizationId: LOCAL_ORGANIZATION_ID,
    eventId: "demo-event",
    roundId: "local-review-round",
    reviewerIds: LOCAL_REVIEW_SCENARIO_REVIEWERS.map(({ id }) => id),
    grants: LOCAL_REVIEW_SCENARIO_REVIEWERS.map(({ id }) => ({
      reviewerId: id,
      maxAssignments: 32,
      assignedCount: 25,
    })),
    version: 1,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  };
  const memberIdentity = new InMemoryMemberIdentityRepository({
    users: localMemberUsers,
    memberships: localMemberMemberships,
  });
  const memberService = new MemberService(
    {
      identity: memberIdentity,
      auth: new InMemoryMemberAuthBoundary({
        baseUrl: "http://127.0.0.1:3015/setup",
        clock: () => new Date(SEEDED_AT),
        generateToken: () => "local-member-setup-token",
      }),
      invitationDelivery: new InMemoryMemberInvitationDelivery(),
      reviewerPools: new InMemoryReviewerPoolRepository({ pools: [reviewerPool] }),
      reviewerEventInvitations: eventRoleInvitationAdapters.reviewerLifecycle,
    },
    {
      clock: () => new Date(SEEDED_AT),
      generateId: (() => {
        let sequence = 0;
        return () => `local-member-id-${++sequence}`;
      })(),
    },
  );
  const webhookIds = { whs: 0, whd: 0 };
  const integrationRepository = new LocalIntegrationAdminRepository(publicRepository);
  const webhookRepository = new InMemoryWebhookRepository(
    [
      {
        id: "local-webhook-demo",
        organizationId: LOCAL_ORGANIZATION_ID,
        eventId: "demo-event",
        endpointUrl: "https://hooks.local.eventloom.test/demo",
        events: ["agenda.published"],
        active: true,
        signingSecret: "local-demo-webhook-secret-20260808-000000",
        signingSecretLastFour: "0000",
        createdAt: new Date(SEEDED_AT),
        updatedAt: new Date(SEEDED_AT),
      },
      {
        id: "local-webhook-conference",
        organizationId: LOCAL_ORGANIZATION_ID,
        eventId: "open-sessionboard-conf",
        endpointUrl: "https://hooks.local.eventloom.test/conference",
        events: ["submission.created", "participant.updated"],
        active: true,
        signingSecret: "local-conference-webhook-secret-20260808",
        signingSecretLastFour: "0808",
        createdAt: new Date(SEEDED_AT),
        updatedAt: new Date(SEEDED_AT),
      },
    ],
    {
      clock: { now: () => new Date(SEEDED_AT) },
      idFactory: (prefix) => `${prefix}_LOCAL_${String(++webhookIds[prefix]).padStart(4, "0")}`,
    },
  );

  const communicationTemplate: CommunicationTemplate = {
    id: "local-template-accepted",
    tenantId: LOCAL_ORGANIZATION_ID,
    eventId: "demo-event",
    name: "Accepted proposal",
    purpose: "decision",
    version: 1,
    status: "approved",
    sender: LOCAL_COMMUNICATION_SENDERS.speakers,
    subject: "Your proposal was accepted",
    html: "<p>Your proposal was accepted.</p>",
    text: "Your proposal was accepted.",
    variables: [],
    createdBy: LOCAL_ORGANIZER_ACCOUNT_ID,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    approvedBy: LOCAL_ORGANIZER_ACCOUNT_ID,
    approvedAt: SEEDED_AT,
  };
  const communicationRepository = new InMemoryCommunicationRepository({
    templates: [communicationTemplate],
    recipients: [
      {
        id: "local-participant",
        participantId: "local-participant",
        tenantId: LOCAL_ORGANIZATION_ID,
        eventId: "demo-event",
        email: LOCAL_SPEAKER_EMAIL,
        displayName: "Alex Rivera",
        audiences: ["accepted_participants", "all_participants"],
        data: {
          first_name: "Alex",
          display_name: "Alex Rivera",
          email: LOCAL_SPEAKER_EMAIL,
          sessionTitle: "Designing reliable community systems",
        },
      } satisfies CommunicationRecipient,
      {
        id: "local-invitation-participant",
        participantId: "local-invitation-participant",
        tenantId: LOCAL_ORGANIZATION_ID,
        eventId: "demo-event",
        email: LOCAL_REVIEWER_EMAIL,
        displayName: "Review Speaker",
        audiences: ["accepted_participants", "all_participants"],
        data: {
          first_name: "Review",
          display_name: "Review Speaker",
          email: LOCAL_REVIEWER_EMAIL,
          sessionTitle: "Invitation composition",
        },
      } satisfies CommunicationRecipient,
    ],
    authorizedAudiences: {
      [`${LOCAL_ORGANIZATION_ID}:demo-event`]: ["accepted_participants", "all_participants"],
    },
  });
  const localCommunicationDelivery: CommunicationDeliveryAdapter = {
    async send(request) {
      return {
        status: "delivered",
        providerMessageId: `local-communication:${request.sendId}:${request.recipientId}`,
      };
    },
  };
  const communicationService = new CommunicationService(
    communicationRepository,
    localCommunicationDelivery,
    {
      clock: () => new Date(SEEDED_AT),
      senderIdentities: LOCAL_COMMUNICATION_SENDERS,
    },
  );
  speakerService = new SpeakerService(speakerRepository, privateAssetGateway, {
    sessionAuthority: {
      getSession: (organizationId, eventId, sessionId) =>
        sessionRepository.getSession(organizationId, eventId, sessionId),
    },
    speakerSender: LOCAL_COMMUNICATION_SENDERS.speakers,
    eventTemporalSource: {
      async getEventTemporalContext(organizationId, eventId) {
        const event = await eventRepository.getEvent(organizationId, eventId);
        return event === null
          ? null
          : {
              organizationId: event.organizationId,
              eventId: event.id,
              timeZone: event.timeZone,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
            };
      },
    },
    now: () => new Date(SEEDED_AT),
    generateId: (() => {
      let sequence = 0;
      return () => `local-speaker-id-${++sequence}`;
    })(),
    communications: new CommunicationSpeakerCommunications(
      communicationService,
      "http://127.0.0.1:3015",
    ),
    invitationCreator: eventRoleInvitationAdapters.speakerCreator,
  });
  let programGraphSeeded!: Promise<void>;
  const reportRepository = new InMemoryReportRepository();
  let reportRunSequence = 0;
  const reportService = new ReportService(reportRepository, {
    clock: () => new Date(SEEDED_AT),
    idGenerator: (prefix) =>
      prefix === "definition"
        ? "local-program-report"
        : `local-program-report-run-${++reportRunSequence}`,
  });
  const reportSeedActor = {
    tenantId: LOCAL_ORGANIZATION_ID,
    userId: LOCAL_ORGANIZER_ACCOUNT_ID,
    kind: "human" as const,
    grants: [{ eventId: "demo-event", role: "organizer" as const }],
  };
  let reportSeed: Promise<void> | null = null;
  const ensureReportSeeded = (): Promise<void> => {
    if (reportSeed !== null) return reportSeed;
    reportSeed = Promise.resolve()
      .then(() => programGraphSeeded)
      .then(async () => {
        const [sessions, rooms, tracks] = await Promise.all([
          sessionRepository.listSessions(LOCAL_ORGANIZATION_ID, "demo-event"),
          sessionRepository.listRooms(LOCAL_ORGANIZATION_ID, "demo-event"),
          sessionRepository.listTracks(LOCAL_ORGANIZATION_ID, "demo-event"),
        ]);
        const speakerIds = [...new Set(sessions.flatMap(({ speakerIds: ids }) => ids))];
        const profiles = await speakerRepository.listProfiles("demo-event", speakerIds);
        const roomNames = new Map(rooms.map(({ id, name }) => [id, name]));
        const trackNames = new Map(tracks.map(({ id, name }) => [id, name]));
        const profilesByParticipantId = new Map(
          profiles.map((profile) => [profile.participantId, profile]),
        );
        const records: ReportProgramRecord[] = sessions.map((session) => {
          const participants = session.speakerIds.flatMap((participantId) => {
            const profile = profilesByParticipantId.get(participantId);
            return profile === undefined
              ? []
              : [
                  {
                    id: profile.participantId,
                    displayName: profile.displayName,
                    biography: profile.biography,
                  },
                ];
          });
          return {
            tenantId: LOCAL_ORGANIZATION_ID,
            eventId: session.eventId,
            session: {
              id: session.id,
              title: session.title,
              abstract: session.description,
              status: session.status,
              ...(session.roomId === undefined
                ? {}
                : { room: roomNames.get(session.roomId) ?? session.roomId }),
              ...(session.trackId === undefined
                ? {}
                : { track: trackNames.get(session.trackId) ?? session.trackId }),
            },
            participants,
            speakers: participants,
            evaluationProgress: [],
          };
        });
        reportRepository.replaceProgramRecords(records);
        await reportService.createDefinition(reportSeedActor, {
          id: "local-program-report",
          eventId: "demo-event",
          name: "Program progress",
          description: "Accepted sessions and participants.",
          relationships: ["sessions", "participants"],
          fields: ["sessions.id", "sessions.title", "sessions.status", "participants.displayName"],
          order: ["sessions.id", "sessions.title", "sessions.status", "participants.displayName"],
          filters: [],
          sort: [{ field: "sessions.title", direction: "asc" }],
        });
        await reportService.runDefinition(reportSeedActor, "local-program-report", {
          format: "csv",
        });
      })
      .then(() => undefined)
      .catch(() => undefined);
    return reportSeed;
  };
  const reportRouteService = new Proxy(reportService, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => ensureReportSeeded().then(() => value.apply(target, args));
    },
  });
  const remixService = new RemixService(
    new LocalRemixRepository(),
    new LocalRemixContentGateway(sessionService, sessionRepository, speakerRepository),
    aiProviders?.remix,
    {
      clock: { now: () => new Date(SEEDED_AT) },
      idGenerator: {
        nextId: (prefix) => `${prefix}_local_${prefix === "candidate" ? "1" : "1"}`,
      },
    },
  );
  const cfpEventRepository = {
    async getEvent(tenantId: string, eventId: string): Promise<EventCfp | null> {
      const event = await eventRepository.getEvent(tenantId, eventId);
      return event === null ? null : localCfpEvent(event);
    },
    async getEventBySlug(tenantId: string, eventSlug: string): Promise<EventCfp | null> {
      const event = await eventRepository.findEventBySlug(tenantId, eventSlug);
      return event === null ? null : localCfpEvent(event);
    },
    async saveEvent(event: EventCfp, expectedVersion: number | null): Promise<void> {
      if (expectedVersion === null || event.version !== expectedVersion + 1) {
        throw new CfpError("CONFLICT", "The event CFP configuration has changed.");
      }
      try {
        const updated = await eventService.updateEvent(organizerEventActor, {
          organizationId: event.tenantId,
          eventId: event.id,
          expectedVersion,
          cfpSettings: {
            enabled: true,
            opensAt: event.opensAt,
            closesAt: event.closesAt,
          },
        });
        if (updated.version !== event.version) {
          throw new CfpError("CONFLICT", "The event CFP configuration has changed.");
        }
      } catch (error) {
        if (error instanceof CfpError) throw error;
        if (error instanceof EventServiceError) {
          switch (error.code) {
            case "NOT_FOUND":
              throw new CfpError("NOT_FOUND", error.message, error.details);
            case "FORBIDDEN":
              throw new CfpError("FORBIDDEN", error.message, error.details);
            case "VALIDATION_ERROR":
              throw new CfpError("VALIDATION_FAILED", error.message, error.details);
            case "VERSION_CONFLICT":
            case "CONFLICT":
              throw new CfpError("CONFLICT", error.message, error.details);
          }
        }
        throw error;
      }
    },
  };
  const { service: cfpService, seeded: localScenarioSeeded } = localCfpServiceWithSeed(
    createLocalCfpService(
      privateAssetGateway,
      {
        async enqueueSubmissionConfirmation({ event, submission, submissionTitle }) {
          speakerRepository.registerCfpSubmission(submission, submissionTitle, event.name);
        },
      },
      cfpEventRepository,
    ),
    fixtureGraphReady,
    async (submissions) => {
      for (const submission of submissions) localReviewMaterials.set(submission.id, submission);
      await seedLocalEvaluationWorkflow(
        evaluationService,
        evaluationSubmissions,
        localEvaluationPlan,
        submissions,
      );
    },
  );
  const seededEvaluationService = serviceAfterSeed(evaluationService, localScenarioSeeded);
  programGraphSeeded = localScenarioSeeded.then(async () => {
    const events = await eventRepository.listEvents(LOCAL_ORGANIZATION_ID);
    const acceptedSessions = (
      await sessionRepository.listSessions(LOCAL_ORGANIZATION_ID, "demo-event")
    ).filter(({ status }) => status.trim().toLowerCase() === "accepted");
    const featured = acceptedSessions.find(
      ({ title }) => title === "Designing reliable community systems",
    );
    const second = acceptedSessions.find(({ id }) => id !== featured?.id);
    const scheduledSessions = [featured, second].filter(
      (session): session is Session => session !== undefined,
    );
    const profiles = await speakerRepository.listProfiles(
      "demo-event",
      acceptedSessions.flatMap(({ speakerIds }) => speakerIds),
    );
    const headshotProfile = profiles.find(
      ({ participantId }) => participantId === "local-participant",
    );
    if (headshotProfile !== undefined) {
      const headshotBytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAwFBMVEX/xXT/wnf/wmz/wXT/v3P+vHT+un39unT8unT8uXT8uHP7uXX6uXT6uHb6uHP5t3TrrHbGlmm+iHeaa32eVD+cSitTSPJdUMRSSO9SSOVRR+xQR+NfRr9PRuZPRuVPRuRPRuNORuNORuJORuFNRORPRNFGQOtGQb1APbk5OZkyNXgrMWUlLVMgKkMiLD4fKT4iLDwgKjwfKjsfKT0eKT0eKTweKTseKTcdKTgcKDQbJzQcKDAbJzAaJy4VIzcOHjeyhugFAAAMUElEQVR42u2dbXuiOhOAoy2P4q5VW9ciXoporS9gaUthweL2//+rZ4Ju91y7VQNM0sQyn05XPpy5mbdMQoaMvriQEkAJoARQAigBlABKACWAEkAJoARQAigBlABKACWAEkAJoARQAigBlABKACWAEkAJQIBYO/mCACx7MrHs4V5s+NMeW18EAFV2aBq9nmmMpzsx4E/DHFoT2zp3AKDj0OiZ09liuXIcd52K6zir5WI+NYGCPbHOGIBtm4YxXSwdN9xsk00SR6n8hP/cJtHaWS1mZs+0hDIgAl/+0DBmy5W7SZKfoe95vh/sxfd9zw+jeJusnSUwGApEQMSp3xsvnHWSRKBsEH4gAfwQbbahs5z2TGEIiDD1p0sXtD+g/H8ghPF2vZoJQyAEQKr+ehv7x7Xfi+9F21AYAgEAbCtVP/JYtN/ZgRcmFMFwcg4AJqaZTf1UKILl1OBfGBDuxW5v7mRWf4dg6y4M7kZA+L/+aJND/RRBnKymxkRlABNj6mzhXeaUF2/rznt8F0s8AVhjY7FOcqu/M4JoaQ5tNQGA+y83USH9IScG2xVXAvwAWCNjlQR+WFACL3Gm5kQ9AFT/bc7o95cbbF2OBAhX/UMU8RKOBIj8+u8J2CoBsCxM/bkS4ANg3EPVPyVgDS1lAEyMZYKqP42EK1MZABNjEQdBiE1g2ZuoAWBsTtfRS4gtL/GCx7qAAwDLdLAdIAUQraccvAAfwKS33HLQnwZCRwUAtjmPwiDkQoBHGCD4EcDZcDEAWBZE6xl6LiSqOMA+F6KbADIAawgZIOAFIAziuWFLDYCrAUB3AOLgWGYAnA1gVwzYEgPgbABgAhtsEyBKGQAHEyBKGQAHE0AFMLTd2A85SzRH7QxgArCNxesLb/2xawFMAGPDSbgbQBC5U8xykGCuAme8Q2AaBl9RwyCRug/08aJwhdkXIJgesOLvAeg+QDCLAFeABwCBn5h5gGDmgPhFgP7IbQGiUhXEoxYimElw44sAAH0RxCBAMENALCIEUAKIQYDgtcJmoSDxkiVeIiTKxUDkKEiUi4FpFDTGEgJYCQMQOxIGQdoO98NQuTRAlMuCsgIYWQKaIXsAoT8zZQMgoB3IpzGICeDn0yF5fv9/fzopLM8i7o9gAvh1UKJ3rX6dFJZn3+SzgNFwcN05KO6vR6rRc/jQOSlMz97eD2QDcNf/H6l8LBfk+u0R3uvz41v30DPZniVSAmg3WlcH5KL7Fj09hW9u+/vBZzI827qUE4Cm1z4WvXZx8/Dr12O3fdGonRCWZ7+pBqCm65VWp9OuHH4i07PqAajVrrRK5fKKQX+WZyUF0Dr6fvUrRvUZnv1WldMCLpk1LCh1TUIAg/vr6jcx+utau383kg9AWxyAlpQAhFnAt8s2lgMgAujf31SbggBUr9FCAKYF3IqygCYA6MsIQKuLAnAjIYBTlRBqDLiV0AXEpQHUJIAIoA9poCkoCdzJeEBCWBREjYGYJ0ROrQbAeBssq8FTD6GGAEwAp0shjWE9rMNSsKaLKoRRAZwshertTqdygoBegV5A7Rgn1DII95zg/e33Y6+/3f3x40dLOwUAnuq2j3Bqwlq4LycASISXh31A+04BdCqN4/q34aEfx5pLqEkQF8BxH2hUOid0S1f6pyjh5gDkw9InisE6Va6rHQlxDJB01ByADOB4LaTvtOtUtMbBduj+iYagKggbwOB4GPyt3/fKh6m+oe1+714drYJQQyD2JzOnyuHUw2mQ1/5GoDdqlVb6649jKQAMYDSS+JshagL1o8uYnY6dFpREDV3/U/xplXrnt/4NgQaA/dncCRN4J9DttKHi0zQdBArECuyF7H84qj++AWADSE3gqA1oqZ/vGLSu6E6n3mrvtYd/bB2tE/ANAP3T2VP1sF6rtH9rC/qm8v4nzRD60WZgGzUFcvl4mm6QHF0SNd69/W+ByKAfrZLq9Vv5AfShLdA8sf9bufoXQZcGxobARgC3CxQYOkOQ8TVYGb4bfxfiQf3f1PhvBOwPRwpcoXHSCSgCuuzXWu1UWjqEwtqpPohOdwT7KgDo0wb56cZHo1HTtPTAi8bUKkJthvO9Rod9k0hPhbkTOBgpcpHSAL9B3IQAcKcMgNEQ9giauK3wFo8AwA3AAAIhJgF++vO6Tm9wj0mAo/7cLlTsI9pAk6P+/K7UxCPAVX+Ol6piEeCrP89rdSFtwVaRXngnsM1Tf64XKw/u7m8uLwsZwbda9brPU3++V2sPoD8CbqAXMH/t5v6ur/Dl6vD2rqtaTiNo1qj5DwYjla/X74MbtKt6DgR6s1rnbP5CBiyAG/SvL6v6Bwvkur6X+kfqX1avbzmbv6ARG2AEt/9FUIez0K0rXW9o7wIdcvinqz99clAfrJ/76xc0ZGXQv08R1Jo6PQe+7wJcVPT2XlqVi4u0MaDB71d6U6fqj3h7v8gxO+AHgKBeTVWHLnjn5saBSVsPvwX+6N5cQ5+cctCqqfqj/uiMBi1ZOwTtznXXeYAvYt7e0i/k9pJ+CQf/9Pjgdm867etb494ejEdnAwCGh/2eMRZRzaPnx1Se32X39xOggN8f9jPHRhP7HABQ7XsmnTEWv75GQar3oU9in5+fKIbXVzpzbG5RBqqP2aEztkB7J9zNGHti+TL4OZ05lkTucj7qmbatMAAbXj7VfhuHnp/py2qYORbE29hdzgyDrxlwBDAZGeZ8td5uQPt800WAgecshlzH7xF+6tPxehGdL1dkwkqYgBlMOSIg3NQfwXg9ePlF7xTwwQzWKQKFANi2QdWH8XooF0bA+D2KYDRRBIA1MY0FqO+hXSixQzA0eGQEwmO64tzZIKq/R5DA7DkOMxixAYyt3mwVJj76pVKBF2+cOX4oIDymK4ZcrpN58dMZjMhGgHuz9Lg3o9MVuV0hRWcw9obS3ixNX7+XeDwv0/HieDUxJL1XGKYrrgpMV2Q0Ah95BiNBNH86XZH/XUp0BiPiKFKClvyMZRyJuVMUZjBaaNPnCJb7g/kHgi5UDGAC4QzrSkUcAFNz5oq6TTB1g80aa+wUwblMcb7eCNQfCETJsje2JAEAt2kGkVD9aUkQr8yRJQUA0B/6XaFgCV62K2M0/nwAkP6Wsajw9/eoBaN4VUgKDxc1V3EYhJ8h6UBe+5MBjM3V9uVz9N8N5C1qAwUBTMXdJvwxAccoGAlJ0fgXv4SfKHTcRDEChQBMofwNg/BTCcAw1vFnAZj2FknwufoXH7tDitT/87X4/P/BHbuF7ponBWZrTtfx5+sPLvi66E3FA4BB0G7shRKID5M489sAKTBUZyuF/nRtWGDwDpF/nABbUTwWC2DCb7iu4JkTJGcAsF0ZAuCfQBjNc4YBknOgyCrxQonEj91JvjBA8gWAxdYPpZLc9RDJNVdP4CwB3sPpST4H2HqS6U+dIFcuJHl2gBaJH0onOZ2AyD1MI5sT5Jk7QWQeKJTZCYYCLMCmJZCcAuVQ9jhI8oyW9eQEkGv+EMkeAWM/lNUEcsxjzR4DXHkBwFjqWdY+Ocm+C+TJqz+YQNZUSKQdqJVTspoAUbcLcCgKjLlagOwGEAYZTYCclQHkKIjJeUWA7FGAnJcBZDcBkqkP4MhvAFAOzrKUgyTTKiAOpHeArA1SkmkZmHjyA8i4KCQZ+gAzOfsAxQZykvMKgdnDIDmvEJg9DBL2EDgLFZFMYZCcnQdAGEwyzCYnZ+cBGX2AnJ8H0DUhuw+Q8/OA1AeYT04R+YbLi+2OkjOrgjLXQoR1O3Dx+qJQEGCvhQhrN1yJdcC7D8Quehp0Y3U8YNcWsRABWColwWyJkJzDdkCRDQKi9o7wsaYApgsoVQVkq4aJ0mcijp6WYGsOE9YzAYFiUZB1SUzYqgDFYmCGnXJydiuhfRTcOCZeDKCnQny1ADCvh4iCJ4OZd0nHaACUSwLsC0JynkmAvRgmbGvh+EU5AFs8AMqtBHZtMbazIuQ8s2CaBxEBrBQEEDtoaVC5pVCWQqAEwFYIfm0AQ0vFQjD0mdqC5EwLQeZSsARQAigBlABKACWAEkAJ4DgA1baGd7Uw09ZIuRYoV4MlAJYbcxJfvY6Qi7YzVPYEFQWAtjP05fcF6MdCXxqAYsdE8fcGlSwFGQtBxvMB6hUCqOcDVNwaYj4nd7ZHZFi/o2c9JaZaGsA9JaZgGmD+YoDxsPTQUWtvKAi9GeIpMdU+F6AGwPrBwP8B8WKa+BTbOekAAAAASUVORK5CYII=",
        ),
        (character) => character.charCodeAt(0),
      );
      const authorization = await speakerService.issueUploadGrant({
        eventId: "demo-event",
        accountId: LOCAL_SPEAKER_ACCOUNT_ID,
        participantId: headshotProfile.participantId,
        kind: "headshot",
        fileName: "local-public-headshot.png",
        contentType: "image/png",
        sizeBytes: headshotBytes.byteLength,
      });
      const capabilitySegments = new URL(authorization.grant.url, "http://127.0.0.1").pathname
        .split("/")
        .filter((segment) => segment.length > 0);
      const capabilityId = capabilitySegments.at(-2);
      const capabilityToken = capabilitySegments.at(-1);
      if (capabilityId === undefined || capabilityToken === undefined) {
        throw new Error("Expected the local headshot upload capability.");
      }
      await speakerService.consumeUploadCapability(
        decodeURIComponent(capabilityId),
        decodeURIComponent(capabilityToken),
        new Request("http://127.0.0.1/api/speaker/assets/capabilities/upload", {
          method: "PUT",
          headers: {
            "content-length": String(headshotBytes.byteLength),
            "content-type": "image/png",
          },
          body: headshotBytes,
        }),
      );
      const headshotAsset = await speakerService.finalizeUpload({
        eventId: "demo-event",
        accountId: LOCAL_SPEAKER_ACCOUNT_ID,
        assetId: authorization.asset.id,
        state: "ready",
      });
      await speakerService.reviewAsset({
        eventId: "demo-event",
        accountId: LOCAL_ORGANIZER_ACCOUNT_ID,
        assetId: headshotAsset.id,
        state: "approved",
        release: true,
        expectedVersion: 0,
      });
    }
    const draft = await agendaEngine.getDraft("demo-event");
    const updated = await agendaEngine.updateDraft({
      eventId: "demo-event",
      actorId: LOCAL_ORGANIZER_ACCOUNT_ID,
      expectedVersion: draft.version,
      entries: scheduledSessions.map(
        (session, index): AgendaEntryInput => ({
          id: index === 0 ? "local-entry-keynote" : "local-entry-workshop",
          sessionId: session.id,
          roomId: index === 0 ? "local-room-main" : "local-room-studio",
          trackIds: [index === 0 ? "local-track-main" : "local-track-practice"],
          startsAtLocal: index === 0 ? "2026-09-18T09:00:00" : "2026-09-18T10:15:00",
          endsAtLocal: index === 0 ? "2026-09-18T10:00:00" : "2026-09-18T11:15:00",
        }),
      ),
    });
    await agendaEngine.validate({
      eventId: "demo-event",
      expectedVersion: updated.version,
      actorId: LOCAL_ORGANIZER_ACCOUNT_ID,
    });
    const revision = await agendaEngine.publish({
      eventId: "demo-event",
      actorId: LOCAL_ORGANIZER_ACCOUNT_ID,
      expectedVersion: updated.version,
    });
    publicRepository.replaceProjection(
      "events",
      events.map((event) => ({
        id: event.id,
        version: event.version,
        organizationId: event.organizationId,
        name: event.name,
        slug: event.slug,
        timeZone: event.timeZone,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        venue: event.venue,
        ...(event.id === "demo-event" ? { publishedAgendaRevisionId: revision.id } : {}),
        updatedAt: event.updatedAt,
      })),
    );
    publicRepository.replaceProjection(
      "sessions",
      acceptedSessions.map((session) => ({
        id: session.id,
        version: session.version,
        organizationId: session.tenantId,
        eventId: session.eventId,
        title: session.title,
        status: session.status,
        updatedAt: session.updatedAt,
      })),
    );
    publicRepository.replaceProjection("agenda", [
      {
        id: "demo-event",
        version: revision.revisionNumber,
        organizationId: LOCAL_ORGANIZATION_ID,
        revision: revision.revisionNumber,
        publishedAt: revision.publishedAt,
        sessionIds: revision.entries.map(({ sessionId }) => sessionId),
      },
    ]);
    publicRepository.replaceProjection(
      "speakers",
      profiles.map((profile) => ({
        id: profile.participantId,
        version: profile.version,
        organizationId: LOCAL_ORGANIZATION_ID,
        eventId: profile.eventId,
        displayName: profile.displayName,
        biography: profile.biography,
        published: true,
        updatedAt: profile.updatedAt,
      })),
    );
    integrationRepository.refresh();
  });
  const speakerProjections = new Map<string, Map<string, PublishedSpeakerProjection>>();
  const speakerHeadshots = new Map<
    string,
    Map<
      string,
      Map<
        string,
        { assetId: string } & Pick<
          PrivateAssetCapabilityBinding,
          "objectKey" | "contentType" | "sizeBytes"
        >
      >
    >
  >();
  const manifestForSlug = async (eventSlug: string): Promise<ProgramPublicationManifest | null> => {
    await programGraphSeeded;
    const event = await eventRepository.findEventBySlug(LOCAL_ORGANIZATION_ID, eventSlug);
    if (event === null) return null;
    let manifest =
      (await publicationRepository.getState(event.organizationId, event.id))?.servedManifest ??
      null;
    if (manifest === null) {
      let revision: PublishedAgendaRevision | null;
      try {
        revision = await agendaEngine.getPublishedAgenda(event.id);
      } catch (error) {
        if (error instanceof AgendaError && error.code === "AGENDA_NOT_FOUND") return null;
        throw error;
      }
      if (revision === null) return null;
      await agendaMutationLock.runExclusive(event.id, async () => {
        const latest = await agendaEngine.getPublishedAgenda(event.id);
        if (latest !== null) await materializePublication(event.id, latest);
      });
      manifest =
        (await publicationRepository.getState(event.organizationId, event.id))?.servedManifest ??
        null;
    }
    return manifest;
  };
  const publishedSpeakerRoutes = {
    getProgramPublicationManifest: manifestForSlug,
    async getPublishedSpeakers(
      eventSlug: string,
      speakerProjectionId?: string,
      speakerRevisionNumber?: number,
    ): Promise<PublishedSpeakerProjection | null> {
      if (speakerProjectionId === undefined || speakerRevisionNumber === undefined) return null;
      const projection = speakerProjections.get(eventSlug)?.get(speakerProjectionId) ?? null;
      return projection?.revision.number === speakerRevisionNumber ? projection : null;
    },
    async getPublishedSpeakerHeadshot(
      eventSlug: string,
      speakerId: string,
      _programRevision?: number,
      speakerProjectionId?: string,
      speakerRevisionNumber?: number,
    ) {
      if (speakerProjectionId === undefined || speakerRevisionNumber === undefined) return null;
      const projection = speakerProjections.get(eventSlug)?.get(speakerProjectionId);
      if (projection?.revision.number !== speakerRevisionNumber) return null;
      const binding = speakerHeadshots.get(eventSlug)?.get(speakerProjectionId)?.get(speakerId);
      if (binding === undefined) return null;
      const published = privateAssetGateway.readPublishedObject(binding);
      if (published === null) return null;
      let contentType: "image/jpeg" | "image/png" | "image/webp";
      switch (published.contentType) {
        case "image/jpeg":
        case "image/png":
        case "image/webp":
          contentType = published.contentType;
          break;
        default:
          return null;
      }
      return {
        body: await new Response(published.body).arrayBuffer(),
        contentType,
        sizeBytes: published.sizeBytes,
      };
    },
  };
  const materializePublication = async (
    eventId: string,
    revision: PublishedAgendaRevision,
    trigger: "approved-content-change" | "released-schedule-change" = "released-schedule-change",
  ): Promise<void> => {
    const event = await eventRepository.getEvent(LOCAL_ORGANIZATION_ID, eventId);
    if (event === null) throw new Error("The published event could not be loaded.");
    const currentAgenda = await agendaEngine.getPublishedAgenda(eventId);
    if (currentAgenda === null || currentAgenda.id !== revision.id) return;
    const current = await publicationRepository.getState(event.organizationId, event.id);
    const servedAgendaRevision = current?.servedManifest?.agendaRevisionNumber;
    if (servedAgendaRevision !== undefined && servedAgendaRevision >= revision.revisionNumber) {
      return;
    }
    const sessions = await sessionRepository.listSessions(LOCAL_ORGANIZATION_ID, event.id);
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const speakerSessions = new Map<
      string,
      Array<{ id: string; title: string; trackNames: readonly string[] }>
    >();
    const approvedSpeakerNameById = new Map<string, string>();
    for (const entry of revision.entries) {
      const session = sessionById.get(entry.sessionId);
      if (session === undefined) continue;
      for (const [speakerIndex, participantId] of session.speakerIds.entries()) {
        const entries = speakerSessions.get(participantId) ?? [];
        entries.push({
          id: session.id,
          title: entry.metadata?.title ?? session.title,
          trackNames: entry.metadata?.trackNames ?? [],
        });
        speakerSessions.set(participantId, entries);
        const approvedSpeakerName =
          entry.metadata?.speakerNames[speakerIndex] ??
          session.speakerRoster.find((reference) => reference.id === participantId)?.displayName;
        if (typeof approvedSpeakerName === "string" && approvedSpeakerName.trim().length > 0) {
          approvedSpeakerNameById.set(participantId, approvedSpeakerName);
        }
      }
    }
    const participantIds = [...speakerSessions.keys()];
    const [profiles, assets] = await Promise.all([
      speakerRepository.listProfiles(event.id, participantIds),
      speakerRepository.listAssets(event.id, participantIds),
    ]);
    const profileById = new Map(profiles.map((profile) => [profile.participantId, profile]));
    const selectedHeadshots = new Map(
      profiles.flatMap((profile) => {
        const asset = selectReleasedSpeakerHeadshot(assets, {
          tenantId: event.organizationId,
          eventId: event.id,
          participantId: profile.participantId,
          ...(profile.headshotAssetId === undefined
            ? {}
            : { selectedAssetId: profile.headshotAssetId }),
        });
        return asset === undefined
          ? []
          : [
              [
                profile.participantId,
                {
                  assetId: asset.id,
                  objectKey: asset.objectKey,
                  contentType: asset.contentType,
                  sizeBytes: asset.sizeBytes,
                },
              ] as const,
            ];
      }),
    );
    const servedProjectionId = current?.servedManifest?.speakerProjectionId;
    const servedSpeakers =
      servedProjectionId === undefined
        ? undefined
        : speakerProjections.get(event.slug)?.get(servedProjectionId)?.speakers;
    const servedHeadshots =
      servedProjectionId === undefined
        ? undefined
        : speakerHeadshots.get(event.slug)?.get(servedProjectionId);
    const headshots =
      trigger === "approved-content-change" && servedHeadshots !== undefined
        ? new Map([
            ...[...servedHeadshots].filter(([participantId]) => speakerSessions.has(participantId)),
            ...selectedHeadshots,
          ])
        : selectedHeadshots;
    const speakers =
      trigger === "approved-content-change" && servedSpeakers !== undefined
        ? [...speakerSessions.entries()]
            .map(([participantId, speakerSessionList]) => {
              const served = servedSpeakers.find((speaker) => speaker.id === participantId);
              const sessionIds = speakerSessionList.map((session) => session.id);
              const sessionTitles = speakerSessionList.map((session) => session.title);
              const trackNames = [
                ...new Set(speakerSessionList.flatMap((session) => session.trackNames)),
              ].sort();
              return served === undefined
                ? {
                    id: participantId,
                    displayName: neutralSpeakerDisplayName(
                      participantId,
                      approvedSpeakerNameById.get(participantId),
                    ),
                    pronouns: null,
                    jobTitle: null,
                    organization: null,
                    biography: "",
                    photoUrl: null,
                    sessionIds,
                    sessionTitles,
                    trackNames,
                  }
                : {
                    ...served,
                    sessionIds,
                    sessionTitles,
                    trackNames,
                  };
            })
            .sort((left, right) => left.displayName.localeCompare(right.displayName))
        : [...speakerSessions.entries()].map(([participantId, speakerSessionList]) => {
            const profile = profileById.get(participantId);
            return {
              id: participantId,
              displayName: neutralSpeakerDisplayName(
                participantId,
                profile?.displayName,
                approvedSpeakerNameById.get(participantId),
              ),
              pronouns: null,
              jobTitle: profile?.jobTitle ?? null,
              organization: profile?.company ?? null,
              biography: profile?.biography ?? "",
              photoUrl: headshots.has(participantId)
                ? publishedSpeakerPhotoPath(event.slug, participantId)
                : null,
              sessionIds: speakerSessionList.map((session) => session.id),
              sessionTitles: speakerSessionList.map((session) => session.title),
              trackNames: [
                ...new Set(speakerSessionList.flatMap((session) => session.trackNames)),
              ].sort(),
            };
          });
    const agendaHash = await sourceHash(revision);
    const speakerHash = await sourceHash({
      speakers,
      headshots: Object.fromEntries(headshots),
    });
    const speakerProjectionId = `${revision.id}:${speakerHash}`;
    const nextSpeakerProjection: PublishedSpeakerProjection = {
      event: {
        slug: event.slug,
        name: event.name,
        timeZone: event.timeZone,
        startsOn: localDateInTimeZone(event.startsAt, event.timeZone),
        endsOn: localDateInTimeZone(event.endsAt, event.timeZone),
        venueName: event.venue,
      },
      revision: {
        id: speakerProjectionId,
        number: revision.revisionNumber,
        publishedAt: revision.publishedAt,
      },
      speakers,
      sourceHash: speakerHash,
    };
    const actor = {
      organizationId: event.organizationId,
      userId: revision.publishedBy,
      role: "owner" as const,
      kind: "human" as const,
    };
    const latestAgenda = await agendaEngine.getPublishedAgenda(eventId);
    if (latestAgenda === null || latestAgenda.id !== revision.id) return;
    const reservationOwnerId = `local-publication:${eventId}`;
    const pending = await publicationService.reserveRebuild(actor, {
      organizationId: event.organizationId,
      eventId: event.id,
      trigger:
        current?.servedManifest === null || current === null ? "initial-publication" : trigger,
      agendaProjectionId: revision.id,
      agendaRevisionNumber: revision.revisionNumber,
      agendaSourceHash: agendaHash,
      speakerProjectionId,
      speakerRevisionNumber: revision.revisionNumber,
      speakerSourceHash: speakerHash,
      approvedContentRevision: revision.revisionNumber,
      approvedProfileRevision:
        trigger === "approved-content-change"
          ? (current?.servedManifest?.approvedProfileRevision ?? revision.revisionNumber)
          : revision.revisionNumber,
      releasedAssetRevision:
        trigger === "approved-content-change"
          ? (current?.servedManifest?.releasedAssetRevision ?? revision.revisionNumber)
          : revision.revisionNumber,
      parentServedRevision: current?.servedRevision ?? null,
      reservationOwnerId,
    });
    const releaseId = pending.pendingReleaseId;
    const pendingRevision = pending.pendingRevision;
    if (releaseId === null || pendingRevision === null) {
      throw new Error("The reserved local publication is missing pending release metadata.");
    }
    const previousSpeakerProjections = speakerProjections.get(event.slug);
    const previousSpeakerHeadshots = speakerHeadshots.get(event.slug);
    try {
      speakerProjections.set(
        event.slug,
        new Map(previousSpeakerProjections).set(speakerProjectionId, nextSpeakerProjection),
      );
      speakerHeadshots.set(
        event.slug,
        new Map(previousSpeakerHeadshots).set(speakerProjectionId, headshots),
      );
      await publicationService.completeRebuild({
        organizationId: event.organizationId,
        eventId: event.id,
        releaseId,
        revision: pendingRevision,
        expectedPublicationVersion: pending.version,
        reservationOwnerId,
      });
    } catch (error) {
      if (previousSpeakerProjections === undefined) {
        speakerProjections.delete(event.slug);
      } else {
        speakerProjections.set(event.slug, previousSpeakerProjections);
      }
      if (previousSpeakerHeadshots === undefined) {
        speakerHeadshots.delete(event.slug);
      } else {
        speakerHeadshots.set(event.slug, previousSpeakerHeadshots);
      }
      try {
        await publicationService.failRebuild({
          organizationId: event.organizationId,
          eventId: event.id,
          releaseId,
          revision: pendingRevision,
          expectedPublicationVersion: pending.version,
          reservationOwnerId,
          reason: error instanceof Error ? error.message : "Local publication handoff failed.",
        });
      } catch (failure) {
        throw new AggregateError([error, failure], "Local publication handoff cleanup failed.");
      }
      throw error;
    }
  };
  const publicAgendaEngine = agendaEngineAfterSeed(agendaEngine, programGraphSeeded);
  completeApprovedRevision = async (eventId, revision) => {
    await materializePublication(eventId, revision, "approved-content-change");
    const event = await eventRepository.getEvent(LOCAL_ORGANIZATION_ID, eventId);
    const publication = await publicationRepository.getState(LOCAL_ORGANIZATION_ID, eventId);
    if (event !== null) {
      await invalidatePublishedSpeakerCache(
        publishedSpeakerRoutes,
        event.slug,
        publication?.servedRevision ?? undefined,
        publication?.servedManifest?.cacheRevision,
      );
    }
    await invalidatePublishedAgendaCache(publicAgendaEngine, eventId, revision);
  };
  return {
    access: {
      async listOrganizationsForUser(principal) {
        const organizations = await memberIdentity.listOrganizationsForUser(principal.userId);
        const known = new Map(
          organizations.map((organization) => [organization.organizationId, organization.name]),
        );
        for (const grant of [...principal.reviewerGrants, ...principal.speakerGrants]) {
          if (!known.has(grant.organizationId) && grant.organizationId === LOCAL_ORGANIZATION_ID) {
            known.set(grant.organizationId, "Eventloom");
          }
        }
        return [...known.entries()].map(([organizationId, name]) => ({ organizationId, name }));
      },
      async listEvents(organizationId) {
        return (await eventRepository.listEvents(organizationId)).map((event) => ({
          organizationId: event.organizationId,
          eventId: event.id,
          name: event.name,
        }));
      },
      async listEvaluationPlans(organizationId) {
        return (await evaluationRepository.listPlans(organizationId)).map((plan) => ({
          organizationId: plan.tenantId,
          eventId: plan.eventId,
          planId: plan.id,
          closesAt: plan.closesAt,
        }));
      },
      async listSpeakerContextScopes(userId) {
        await programGraphSeeded;
        if (speakerRepository.listPortalContextScopes === undefined) return [];
        return (await speakerRepository.listPortalContextScopes(userId)).map(
          ({ context, scope, speakerProfileIds }) => ({
            organizationId: scope.tenantId ?? "",
            resolvedOrganizationIds: scope.tenantId === undefined ? [] : [scope.tenantId],
            eventId: context.eventId,
            accountId: userId,
            speakerProfileIds: [...speakerProfileIds],
            participantIds: [...scope.participantIds],
            ...(scope.capabilities === undefined ? {} : { capabilities: [...scope.capabilities] }),
            ...(scope.capabilitiesByParticipant === undefined
              ? {}
              : { capabilitiesByParticipant: scope.capabilitiesByParticipant }),
          }),
        );
      },
      speakerTasks: {
        async resolveScope(principal, organizationId, eventId) {
          await programGraphSeeded;
          const scope = await speakerRepository.getAccessScopeForOrganization(
            organizationId,
            eventId,
            principal.userId,
          );
          if (scope.tenantId !== organizationId) return null;
          return {
            tenantId: scope.tenantId,
            organizationId: scope.tenantId,
            eventId,
            accountId: principal.userId,
            participantIds: scope.participantIds,
            submissionIds: scope.submissionIds,
            ...(scope.capabilities === undefined ? {} : { capabilities: scope.capabilities }),
            ...(scope.capabilitiesByParticipant === undefined
              ? {}
              : { capabilitiesByParticipant: scope.capabilitiesByParticipant }),
          };
        },
        async listSessions(organizationId: string, eventId: string, sessionIds: readonly string[]) {
          await programGraphSeeded;
          const requestedSessionIds = new Set(sessionIds);
          return (await sessionRepository.listSessions(organizationId, eventId))
            .filter(
              (session) =>
                session.tenantId === organizationId &&
                session.eventId === eventId &&
                requestedSessionIds.has(session.id),
            )
            .map((session) => ({
              tenantId: session.tenantId,
              eventId: session.eventId,
              sessionId: session.id,
              status: session.status,
              speakerIds: session.speakerIds,
            }));
        },
        async listTasks(organizationId, eventId, participantIds) {
          const tasks = await speakerRepository.listTasksForOrganization(
            organizationId,
            eventId,
            participantIds,
          );
          return tasks.map((task) => ({
            organizationId: task.tenantId,
            eventId: task.eventId,
            taskId: task.id,
            sessionId: task.subject.type === "session" ? task.subject.sessionId : null,
            participantId: task.participantId,
            owner: task.owner,
            title: task.title,
            dueAt: task.dueAt ?? task.dueDate ?? null,
            status: task.status,
          }));
        },
      },
      reviewerWorkspace: {
        listReviewerWorkspace: evaluationService.listReviewerWorkspace.bind(evaluationService),
      },
    },
    events: {
      service: serviceAfterSeed(eventService, fixtureGraphReady),
      publication: publicationService,
    },
    sessions: { service: serviceAfterSeed(sessionService, localScenarioSeeded) },
    members: { service: memberService },
    communications: {
      service: communicationService,
      async actorFor(principal: AuthPrincipal, organizationId: string, eventId: string) {
        if (principal.kind !== "user") return null;
        const membership = principal.memberships.find(
          (candidate) =>
            candidate.organizationId === organizationId &&
            (candidate.role === "owner" || candidate.role === "admin"),
        );
        return membership === undefined
          ? null
          : {
              tenantId: organizationId,
              userId: principal.userId,
              kind: "human" as const,
              grants: [{ eventId, role: "organizer" as const }],
            };
      },
    },
    reports: {
      service: reportRouteService,
      async actorFor(principal: AuthPrincipal, organizationId: string, eventId: string) {
        if (principal.kind !== "user") return null;
        const membership = principal.memberships.find(
          (candidate) =>
            candidate.organizationId === organizationId &&
            (candidate.role === "owner" || candidate.role === "admin"),
        );
        return membership === undefined
          ? null
          : {
              tenantId: organizationId,
              userId: principal.userId,
              kind: "human" as const,
              canViewPersonalData: false,
              grants: [{ eventId, role: "organizer" as const, canViewPersonalData: false }],
            };
      },
    },
    remix: {
      service: remixService,
      async actorFor(principal: AuthPrincipal, organizationId: string, eventId: string) {
        if (principal.kind !== "user") return null;
        const membership = principal.memberships.find(
          (candidate) =>
            candidate.organizationId === organizationId &&
            (candidate.role === "owner" || candidate.role === "admin"),
        );
        return membership === undefined
          ? null
          : {
              tenantId: organizationId,
              userId: principal.userId,
              kind: "human" as const,
              grants: [{ eventId, role: "organizer" as const }],
            };
      },
    },
    authenticator,
    auth: localAuthRoutes(personas),
    eventInvitations: { service: eventRoleInvitationAdapters.service },
    organizerOverview: serviceAfterSeed(organizerOverview, programGraphSeeded),
    crm: { service: crmService },
    speaker: {
      service: serviceAfterSeed(speakerService, localScenarioSeeded),
      async authenticate(request) {
        const principal = await authenticator.authenticate(request).catch(() => null);
        return principal?.kind === "user" ? { accountId: principal.userId } : null;
      },
    },
    agenda: {
      engine: publicAgendaEngine,
      calendarUidDomain: LOCAL_CALENDAR_OPTIONS.uidDomain,
      async organizationIdForEvent(eventId) {
        await fixtureGraphReady;
        const event = await eventRepository.getEvent(LOCAL_ORGANIZATION_ID, eventId);
        return event?.organizationId ?? null;
      },
      async agendaCatalogForEvent(eventId) {
        await fixtureGraphReady;
        const event = await eventRepository.getEvent(LOCAL_ORGANIZATION_ID, eventId);
        if (event === null) throw new Error(`Event ${eventId} was not found.`);
        return sessionService.getAgendaCatalog(event.organizationId, eventId);
      },
      async eventMetadataForEvent(eventId) {
        await fixtureGraphReady;
        const event = await eventRepository.getEvent(LOCAL_ORGANIZATION_ID, eventId);
        if (event === null) return null;
        return {
          slug: event.slug,
          name: event.name,
          timeZone: event.timeZone,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          startsOn: localDateInTimeZone(event.startsAt, event.timeZone),
          endsOn: localDateInTimeZone(event.endsAt, event.timeZone),
          ...(event.scheduleDates === undefined ? {} : { scheduleDates: event.scheduleDates }),
          venueName: event.venue,
        };
      },
      async eventIdForSlug(eventSlug) {
        await fixtureGraphReady;
        return (
          (await eventRepository.findEventBySlug(LOCAL_ORGANIZATION_ID, eventSlug))?.id ?? null
        );
      },
      getProgramPublicationManifest: manifestForSlug,
      afterPublish: materializePublication,
    },
    evaluations: {
      service: seededEvaluationService,
      async actorFor(principal: AuthPrincipal, request: Request): Promise<EvaluationActor | null> {
        if (principal.kind !== "user") return null;
        const body = await request
          .clone()
          .json<Record<string, unknown>>()
          .catch(() => undefined);
        const eventId =
          typeof body?.eventId === "string" && body.eventId.trim().length > 0
            ? body.eventId
            : eventIdFrom(request);
        if (eventId === null) {
          await localScenarioSeeded;
          const plans = await evaluationRepository.listPlans(LOCAL_ORGANIZATION_ID);
          const organizer = principal.memberships.some(
            ({ organizationId, role }) =>
              organizationId === LOCAL_ORGANIZATION_ID && (role === "owner" || role === "admin"),
          );
          const grants = [
            ...(organizer
              ? plans.map((plan) => ({ eventId: plan.eventId, role: "organizer" as const }))
              : []),
            ...principal.reviewerGrants
              .filter(({ organizationId }) => organizationId === LOCAL_ORGANIZATION_ID)
              .map((grant) => ({ eventId: grant.eventId, role: "reviewer" as const })),
          ].filter(
            (grant, index, all) =>
              all.findIndex(
                (candidate) => candidate.eventId === grant.eventId && candidate.role === grant.role,
              ) === index,
          );
          if (grants.length === 0) return null;
          return {
            tenantId: LOCAL_ORGANIZATION_ID,
            userId: principal.userId,
            kind: "human",
            grants,
          };
        }
        const roles = evaluationRolesForPrincipal(principal, LOCAL_ORGANIZATION_ID, eventId);
        if (roles.length === 0) return null;
        return {
          tenantId: LOCAL_ORGANIZATION_ID,
          userId: principal.userId,
          kind: "human",
          grants: roles.map((role) => ({ eventId, role })),
        };
      },
    },
    publishedSpeakers: publishedSpeakerRoutes,
    publishedEvents: {
      async listPublishedEvents() {
        await programGraphSeeded;
        const now = new Date();
        const events = await eventRepository.listEvents(LOCAL_ORGANIZATION_ID);
        const published = await Promise.all(
          events.map(async (event) => ({
            event,
            manifest: await manifestForSlug(event.slug),
          })),
        );
        return published.flatMap(({ event, manifest }) =>
          manifest === null
            ? []
            : [
                {
                  organization: {
                    id: LOCAL_ORGANIZATION_ID,
                    name: "Eventloom",
                  },
                  event: {
                    slug: event.slug,
                    name: event.name,
                    timeZone: event.timeZone,
                    startsOn: localDateInTimeZone(event.startsAt, event.timeZone),
                    endsOn: localDateInTimeZone(event.endsAt, event.timeZone),
                    venueName: event.venue,
                    programPublished: true,
                  },
                  cfpOpen:
                    event.cfpSettings.enabled &&
                    (event.cfpSettings.opensAt === null ||
                      new Date(event.cfpSettings.opensAt) <= now) &&
                    (event.cfpSettings.closesAt === null ||
                      now <= new Date(event.cfpSettings.closesAt)),
                },
              ],
        );
      },
    },
    publicApi: {
      resources: [],
    },
    integrations: {
      async getEvent(organizationId, eventId) {
        await programGraphSeeded;
        return integrationRepository.getEvent(organizationId, eventId);
      },
      async getDeliveryStatus(organizationId, eventId) {
        await programGraphSeeded;
        return integrationRepository.getDeliveryStatus(organizationId, eventId);
      },
      async saveCredential(organizationId, eventId, provider, secret) {
        await programGraphSeeded;
        return integrationRepository.saveCredential(organizationId, eventId, provider, secret);
      },
      async listApiKeys(organizationId, eventId) {
        await programGraphSeeded;
        return integrationRepository.listApiKeys(organizationId, eventId);
      },
      async createApiKey(input) {
        await programGraphSeeded;
        return integrationRepository.createApiKey(input);
      },
      async revokeApiKey(organizationId, apiKeyId, eventId) {
        await programGraphSeeded;
        return integrationRepository.revokeApiKey(organizationId, apiKeyId, eventId);
      },
      webhooks: webhookRepository,
      getWebhookLastDelivery:
        integrationRepository.getWebhookLastDelivery.bind(integrationRepository),
      retryCalendarDelivery:
        integrationRepository.retryCalendarDelivery.bind(integrationRepository),
    } satisfies IntegrationAdminRouteDependencies,
    webhooks: webhookRepository,
    cfp: { service: cfpService },
  } as ApiDependencies & {
    cfp: { service: ReturnType<typeof createLocalCfpService> };
  };
}
