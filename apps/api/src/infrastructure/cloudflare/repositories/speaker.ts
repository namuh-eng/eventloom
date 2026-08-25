import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { and, eq, inArray } from "drizzle-orm";

import { createDatabase, type OpenSessionboardDatabase } from "../../../db/client";
import {
  events,
  speakerAssetComments,
  speakerAssets,
  speakerProfiles,
  speakerTaskDependencies,
  speakerTaskReminderOffsets,
  speakerTasks,
  submissions,
} from "../../../db/schema";
import type {
  CommitOrganizerSpeakerImportCommand,
  CreatePendingSpeakerAssetVersionCommand,
  FinalizeSpeakerAssetCommand,
  OrganizationQualifiedSpeakerSubmission,
  OrganizationQualifiedSpeakerTask,
  OrganizerSpeakerAggregateResult,
  RepositoryResult,
  SaveOrganizerSpeakerImportPreviewCommand,
  SpeakerAccessScope,
  SpeakerAccountWorkloadRepository,
  SpeakerAsset,
  SpeakerAssetAuditEntry,
  SpeakerAssetComment,
  SpeakerAssetReviewCommand,
  SpeakerDecisionWriteFence,
  SpeakerEventResource,
  SpeakerImportPreview,
  SpeakerImportRow,
  SpeakerOrganizerAccessScope,
  SpeakerOrganizerLifecycleRepository,
  SpeakerOrganizerReadModel,
  SpeakerOrganizerReadResources,
  SpeakerPortalCapability,
  SpeakerPortalContext,
  SpeakerPortalContextScopeProjection,
  SpeakerProfile,
  SpeakerSubmission,
  SpeakerTask,
  SpeakerTaskFormDefinition,
  SpeakerTaskRepositoryCommand,
  SpeakerTaskResponseRecord,
  SpeakerWikiPage,
  TransitionSpeakerTaskCommand,
  UpdateBiographyCommand,
  UpdateSpeakerProfileCommand,
  UpsertOrganizerSpeakerAggregateCommand,
} from "../../../features/speaker/types";
import { privateObjectCleanupOutboxStatement } from "../private-object-cleanup";
import { guard, updateGuard } from "./shared";

export function portalSubmissionStatus(
  submissionStatus: string,
  decisionStatus: string | undefined,
): SpeakerSubmission["status"] {
  if (decisionStatus === "accepted") return "accepted";
  if (decisionStatus === "rejected") return "declined";
  if (decisionStatus === "waitlisted") return "under_review";
  if (
    submissionStatus === "draft" ||
    submissionStatus === "submitted" ||
    submissionStatus === "under_review" ||
    submissionStatus === "accepted" ||
    submissionStatus === "declined" ||
    submissionStatus === "withdrawn"
  ) {
    return submissionStatus;
  }
  return "submitted";
}

const json = (value: unknown): string => JSON.stringify(value);
const auditLabel = "__speaker_asset_audit__";

type EventScope = { organizationId: string; eventId: string };

function commaSeparatedIds(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export class D1SpeakerRepository
  implements SpeakerAccountWorkloadRepository, SpeakerOrganizerLifecycleRepository
{
  readonly #db: D1Database;
  readonly #orm: OpenSessionboardDatabase;

  constructor(db: D1Database) {
    this.#db = db;
    this.#orm = createDatabase(db);
  }

  async #grantedAccessScope(
    eventId: string,
    accountId: string,
    organizationId?: string,
  ): Promise<SpeakerAccessScope | null> {
    const rows = await this.#db
      .withSession("first-primary")
      .prepare(
        `SELECT pg.organization_id, pg.participant_id, pg.permissions_json,
                group_concat(DISTINCT sp.submission_id) AS submission_ids
           FROM participant_grants pg
           JOIN event_role_invitations invitation
             ON invitation.organization_id = pg.organization_id
            AND invitation.event_id = pg.event_id
            AND invitation.role = 'speaker'
            AND invitation.recipient_user_id = pg.user_id
            AND invitation.participant_id = pg.participant_id
            AND invitation.status = 'accepted'
           JOIN speaker_profiles profile
             ON profile.organization_id = pg.organization_id
            AND profile.event_id = pg.event_id
            AND profile.participant_id = pg.participant_id
            AND profile.status <> 'revoked'
      LEFT JOIN submission_participants sp
             ON sp.organization_id = pg.organization_id
            AND sp.event_id = pg.event_id
            AND sp.participant_id = pg.participant_id
          WHERE pg.event_id = ?
            AND pg.user_id = ?
            AND pg.revoked_at IS NULL
            AND (? IS NULL OR pg.organization_id = ?)
       GROUP BY pg.organization_id, pg.participant_id, pg.permissions_json
       ORDER BY pg.organization_id, pg.participant_id`,
      )
      .bind(eventId, accountId, organizationId ?? null, organizationId ?? null)
      .all<Record<string, unknown>>();
    const matches = rows.results ?? [];
    const organizations = new Set(matches.map((row) => String(row.organization_id)));
    if (organizations.size !== 1) return null;
    const tenantId = organizations.values().next().value as string | undefined;
    if (tenantId === undefined) return null;
    const participantIds = matches.map((row) => String(row.participant_id));
    const capabilitiesByParticipant = Object.fromEntries(
      matches.map((row) => {
        const permissions = new Set<string>();
        try {
          const parsed: unknown = JSON.parse(String(row.permissions_json ?? "[]"));
          if (Array.isArray(parsed)) {
            for (const permission of parsed) {
              if (typeof permission === "string") permissions.add(permission);
            }
          }
        } catch {
          // Malformed permissions fail closed; the migration enforces valid JSON.
        }
        const capabilities: SpeakerPortalCapability[] = [];
        if (permissions.has("edit_own_profile")) capabilities.push("profile-self");
        if (permissions.has("view_own_tasks") || permissions.has("update_own_tasks")) {
          capabilities.push("task-response");
        }
        if (permissions.has("manage_own_assets")) {
          capabilities.push("asset-read", "asset-write", "asset-comment");
        }
        capabilities.push("resource-read");
        return [String(row.participant_id), capabilities] as const;
      }),
    );
    const capabilities = [
      ...new Set(Object.values(capabilitiesByParticipant).flat()),
    ] as SpeakerPortalCapability[];
    return {
      tenantId,
      submissionIds: [...new Set(matches.flatMap((row) => commaSeparatedIds(row.submission_ids)))],
      participantIds,
      capabilities,
      capabilitiesByParticipant,
      ...(participantIds[0] === undefined ? {} : { primaryParticipantId: participantIds[0] }),
      role: "speaker",
    };
  }

  async #listGrantedPortalContexts(accountId: string): Promise<SpeakerPortalContext[]> {
    const rows = await this.#db
      .withSession("first-primary")
      .prepare(
        `SELECT e.organization_id, e.id AS event_id, e.name, e.slug,
                group_concat(DISTINCT pg.participant_id) AS participant_ids,
                group_concat(DISTINCT sp.submission_id) AS submission_ids
           FROM participant_grants pg
           JOIN event_role_invitations invitation
             ON invitation.organization_id = pg.organization_id
            AND invitation.event_id = pg.event_id
            AND invitation.role = 'speaker'
            AND invitation.recipient_user_id = pg.user_id
            AND invitation.participant_id = pg.participant_id
            AND invitation.status = 'accepted'
           JOIN speaker_profiles profile
             ON profile.organization_id = pg.organization_id
            AND profile.event_id = pg.event_id
            AND profile.participant_id = pg.participant_id
            AND profile.status <> 'revoked'
           JOIN events e ON e.organization_id = pg.organization_id AND e.id = pg.event_id
      LEFT JOIN submission_participants sp
             ON sp.organization_id = pg.organization_id
            AND sp.event_id = pg.event_id
            AND sp.participant_id = pg.participant_id
          WHERE pg.user_id = ? AND pg.revoked_at IS NULL
       GROUP BY e.organization_id, e.id
       ORDER BY e.updated_at DESC`,
      )
      .bind(accountId)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map((row) => {
      const participantIds = commaSeparatedIds(row.participant_ids);
      return {
        id: `speaker:${String(row.organization_id)}:${String(row.event_id)}:${accountId}`,
        organizationId: String(row.organization_id),
        eventId: String(row.event_id),
        name: String(row.name),
        slug: String(row.slug),
        capabilities: [
          "profile-self",
          "task-response",
          "asset-read",
          "asset-write",
          "asset-comment",
          "resource-read",
        ],
        submissionIds: commaSeparatedIds(row.submission_ids),
        participantIds,
        ...(participantIds[0] === undefined ? {} : { primaryParticipantId: participantIds[0] }),
      };
    });
  }

  async #profilesForGrant(
    organizationId: string,
    eventId: string,
    accountId: string,
  ): Promise<string[]> {
    if (organizationId.length === 0) return [];
    const rows = await this.#db
      .prepare(
        `SELECT sp.id
           FROM participant_grants pg
           JOIN speaker_profiles sp
             ON sp.organization_id = pg.organization_id
            AND sp.event_id = pg.event_id
            AND sp.participant_id = pg.participant_id
            AND sp.status <> 'revoked'
           JOIN event_role_invitations invitation
             ON invitation.organization_id = pg.organization_id
            AND invitation.event_id = pg.event_id
            AND invitation.role = 'speaker'
            AND invitation.recipient_user_id = pg.user_id
            AND invitation.participant_id = pg.participant_id
            AND invitation.status = 'accepted'
          WHERE pg.organization_id = ? AND pg.event_id = ?
            AND pg.user_id = ? AND pg.revoked_at IS NULL
       ORDER BY sp.id`,
      )
      .bind(organizationId, eventId, accountId)
      .all<{ id: string }>();
    return (rows.results ?? []).map((row) => row.id);
  }

  async #listOwnedPortalContexts(accountId: string): Promise<SpeakerPortalContext[]> {
    const result = await this.#db
      .withSession("first-primary")
      .prepare(
        `SELECT e.organization_id,
                e.id AS event_id,
                e.name AS event_name,
                e.slug AS event_slug,
                s.id AS submission_id,
                sp.participant_id
           FROM submissions AS s
           JOIN events AS e
             ON e.organization_id = s.organization_id
            AND e.id = s.event_id
      LEFT JOIN submission_participants AS sp
             ON sp.organization_id = s.organization_id
            AND sp.event_id = s.event_id
            AND sp.submission_id = s.id
            AND sp.role = 'primary'
          WHERE s.owner_account_id = ?
       ORDER BY e.updated_at DESC, s.updated_at DESC`,
      )
      .bind(accountId)
      .all<Record<string, unknown>>();
    const contexts = new Map<string, SpeakerPortalContext>();
    for (const row of result.results ?? []) {
      const eventId = String(row.event_id);
      const submissionId = String(row.submission_id);
      const participantId =
        row.participant_id === null || row.participant_id === undefined
          ? undefined
          : String(row.participant_id);
      const existing = contexts.get(eventId);
      if (existing !== undefined) {
        contexts.set(eventId, {
          ...existing,
          submissionIds: existing.submissionIds.includes(submissionId)
            ? existing.submissionIds
            : [...existing.submissionIds, submissionId],
          participantIds:
            participantId === undefined || existing.participantIds.includes(participantId)
              ? existing.participantIds
              : [...existing.participantIds, participantId],
        });
        continue;
      }
      contexts.set(eventId, {
        id: eventId,
        organizationId: String(row.organization_id),
        eventId,
        name: String(row.event_name),
        slug: String(row.event_slug),
        capabilities: ["submission-edit"],
        submissionIds: [submissionId],
        participantIds: participantId === undefined ? [] : [participantId],
        ...(participantId === undefined ? {} : { primaryParticipantId: participantId }),
      });
    }
    return [...contexts.values()];
  }

  async getAccessScope(eventId: string, accountId: string): Promise<SpeakerAccessScope> {
    const granted = await this.#grantedAccessScope(eventId, accountId);
    const session = this.#db.withSession("first-primary");
    const owned = await session
      .prepare(
        `SELECT s.organization_id,
                group_concat(DISTINCT s.id) AS submission_ids,
                group_concat(DISTINCT sp.participant_id) AS participant_ids,
                max(CASE WHEN sp.role = 'primary' THEN sp.participant_id END)
                  AS primary_participant_id
           FROM submissions AS s
      LEFT JOIN submission_participants AS sp
             ON sp.organization_id = s.organization_id
            AND sp.event_id = s.event_id
            AND sp.submission_id = s.id
          WHERE s.event_id = ?
            AND s.owner_account_id = ?
       GROUP BY s.organization_id
          LIMIT 1`,
      )
      .bind(eventId, accountId)
      .first<Record<string, unknown>>();
    if (owned === null) return granted ?? { submissionIds: [], participantIds: [] };
    if (granted !== null && granted.tenantId !== String(owned.organization_id)) {
      return { submissionIds: [], participantIds: [] };
    }
    const ownedParticipantIds = commaSeparatedIds(owned.participant_ids);
    const participantIds = [
      ...new Set([...(granted?.participantIds ?? []), ...ownedParticipantIds]),
    ];
    const capabilities = [
      ...new Set([...(granted?.capabilities ?? []), "submission-edit" as const]),
    ];
    const capabilitiesByParticipant: Record<string, readonly SpeakerPortalCapability[]> = {
      ...(granted?.capabilitiesByParticipant ?? {}),
    };
    for (const participantId of ownedParticipantIds) {
      capabilitiesByParticipant[participantId] = [
        ...new Set([
          ...(capabilitiesByParticipant[participantId] ?? []),
          "submission-edit" as const,
        ]),
      ];
    }
    return {
      tenantId: String(owned.organization_id),
      submissionIds: [
        ...new Set([...(granted?.submissionIds ?? []), ...commaSeparatedIds(owned.submission_ids)]),
      ],
      participantIds,
      capabilities,
      capabilitiesByParticipant,
      primaryParticipantId:
        granted?.primaryParticipantId ?? String(owned.primary_participant_id ?? ""),
      role: "speaker",
    };
  }

  async getAccessScopeForOrganization(
    organizationId: string,
    eventId: string,
    accountId: string,
  ): Promise<SpeakerAccessScope> {
    return (
      (await this.#grantedAccessScope(eventId, accountId, organizationId)) ?? {
        submissionIds: [],
        participantIds: [],
      }
    );
  }

  async listPortalContextScopes(
    accountId: string,
  ): Promise<readonly SpeakerPortalContextScopeProjection[]> {
    const [grantedContexts, ownedContexts] = await Promise.all([
      this.#listGrantedPortalContexts(accountId),
      this.#listOwnedPortalContexts(accountId),
    ]);
    const contextsByEvent = new Map<string, SpeakerPortalContext>();
    for (const context of [...grantedContexts, ...ownedContexts]) {
      const current = contextsByEvent.get(context.eventId);
      contextsByEvent.set(
        context.eventId,
        current === undefined
          ? context
          : {
              ...current,
              capabilities: [...new Set([...current.capabilities, ...context.capabilities])],
              submissionIds: [...new Set([...current.submissionIds, ...context.submissionIds])],
              participantIds: [...new Set([...current.participantIds, ...context.participantIds])],
              ...((current.primaryParticipantId ?? context.primaryParticipantId) === undefined
                ? {}
                : {
                    primaryParticipantId:
                      current.primaryParticipantId ?? context.primaryParticipantId,
                  }),
            },
      );
    }
    return Promise.all(
      [...contextsByEvent.values()].map(async (context) => {
        const scope = await this.getAccessScope(context.eventId, accountId);
        const speakerProfileIds = await this.#profilesForGrant(
          scope.tenantId ?? "",
          context.eventId,
          accountId,
        );
        return { context, scope, speakerProfileIds };
      }),
    );
  }

  async listPortalContexts(accountId: string) {
    return (await this.listPortalContextScopes(accountId)).map(({ context }) => context);
  }

  async getOrganizerAccessScope(
    eventId: string,
    accountId: string,
  ): Promise<SpeakerOrganizerAccessScope | null> {
    const row = await this.#db
      .withSession("first-primary")
      .prepare(
        `SELECT e.organization_id, om.role,
                (SELECT group_concat(DISTINCT s.id)
                   FROM submissions s
                   JOIN evaluation_decisions d
                     ON d.organization_id = s.organization_id
                    AND d.event_id = s.event_id
                    AND d.submission_id = s.id
                  WHERE s.organization_id = e.organization_id
                    AND s.event_id = e.id AND d.status = 'accepted') AS submission_ids,
                (SELECT group_concat(DISTINCT participant_id) FROM (
                   SELECT sp.participant_id
                     FROM speaker_profiles sp
                    WHERE sp.organization_id = e.organization_id AND sp.event_id = e.id
                   UNION
                   SELECT spl.participant_id
                     FROM submission_participants spl
                     JOIN evaluation_decisions d
                       ON d.organization_id = spl.organization_id
                      AND d.event_id = spl.event_id
                      AND d.submission_id = spl.submission_id
                    WHERE spl.organization_id = e.organization_id
                      AND spl.event_id = e.id AND d.status = 'accepted'
                )) AS participant_ids
           FROM events e
           JOIN organization_memberships om
             ON om.organization_id = e.organization_id AND om.user_id = ?
          WHERE e.id = ? AND om.role IN ('owner','admin')
          LIMIT 2`,
      )
      .bind(accountId, eventId)
      .all<Record<string, unknown>>();
    const matches = row.results ?? [];
    if (matches.length !== 1) return null;
    const scope = matches[0];
    if (scope === undefined) return null;
    return {
      tenantId: String(scope.organization_id),
      eventId,
      role: scope.role === "owner" ? "owner" : "admin",
      submissionIds: commaSeparatedIds(scope.submission_ids),
      participantIds: commaSeparatedIds(scope.participant_ids),
    };
  }

  async getAccountDisplayName(accountId: string): Promise<string | null> {
    const row = await this.#db
      .prepare(`SELECT name FROM auth_users WHERE id = ? LIMIT 1`)
      .bind(accountId)
      .first<Record<string, unknown>>();
    const name = row?.name;
    return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
  }

  async getOrganizerReadModel(
    eventId: string,
    accountId: string,
    resources: SpeakerOrganizerReadResources,
  ): Promise<SpeakerOrganizerReadModel | null> {
    const scope = await this.getOrganizerAccessScope(eventId, accountId);
    if (scope === null) return null;
    const [submissionsForScope, roster, profiles, tasks, assets] = await Promise.all([
      this.listSubmissions(eventId, scope.submissionIds),
      this.listRosterForEvent(eventId),
      resources.profiles === true ? this.listProfilesForEvent(scope.tenantId, eventId) : [],
      resources.tasks === true ? this.listTasks(eventId, scope.participantIds) : [],
      resources.assets === true ? this.listAssets(eventId, scope.participantIds) : [],
    ]);
    return { scope, submissions: submissionsForScope, roster, profiles, tasks, assets };
  }

  async resolveEventParticipant(input: {
    organizationId: string;
    eventId: string;
    sourceType: "cfp" | "manual" | "csv" | "crm";
    sourceId: string;
    explicitParticipantId?: string;
    normalizedEmail?: string;
    createParticipantId: string;
  }) {
    const event = await this.#db
      .prepare("SELECT 1 AS found FROM events WHERE organization_id = ? AND id = ?")
      .bind(input.organizationId, input.eventId)
      .first<{ found: number }>();
    if (event === null) return { state: "ambiguous" as const, candidateParticipantIds: [] };
    const rows = await this.#db
      .prepare(
        `SELECT p.id,
                group_concat(DISTINCT sp.submission_id) AS submission_ids
           FROM participants p
      LEFT JOIN submission_participants sp
             ON sp.organization_id = p.organization_id
            AND sp.event_id = p.event_id AND sp.participant_id = p.id
          WHERE p.organization_id = ? AND p.event_id = ?
            AND ((? IS NOT NULL AND p.id = ?)
              OR (p.source_type = ? AND p.source_id = ?)
              OR (? IS NOT NULL AND p.normalized_email = ? COLLATE NOCASE))
       GROUP BY p.id ORDER BY p.id`,
      )
      .bind(
        input.organizationId,
        input.eventId,
        input.explicitParticipantId ?? null,
        input.explicitParticipantId ?? null,
        input.sourceType,
        input.sourceId,
        input.normalizedEmail ?? null,
        input.normalizedEmail ?? null,
      )
      .all<{ id: string; submission_ids: string | null }>();
    const matches = rows.results ?? [];
    if (matches.length > 1) {
      return { state: "ambiguous" as const, candidateParticipantIds: matches.map((row) => row.id) };
    }
    const match = matches[0];
    if (match === undefined && input.explicitParticipantId !== undefined) {
      return { state: "ambiguous" as const, candidateParticipantIds: [] };
    }
    return match === undefined
      ? {
          state: "resolved" as const,
          participantId: input.createParticipantId,
          submissionIds: [],
          created: true,
        }
      : {
          state: "resolved" as const,
          participantId: match.id,
          submissionIds: commaSeparatedIds(match.submission_ids),
          created: false,
        };
  }

  async listRoster(
    eventId: string,
    submissionId: string,
  ): Promise<import("../../../features/speaker/types").SpeakerRosterEntry[]> {
    return (await this.listRosterForEvent(eventId)).filter(
      (entry) =>
        entry.submissionId === submissionId ||
        entry.submissionId === `speaker-submission:${submissionId}` ||
        `speaker-submission:${entry.submissionId}` === submissionId,
    );
  }

  async listRosterForEvent(
    eventId: string,
  ): Promise<import("../../../features/speaker/types").SpeakerRosterEntry[]> {
    const rows = await this.#db
      .prepare(
        `SELECT sp.*, (
           SELECT spl.submission_id
             FROM submission_participants spl
             LEFT JOIN evaluation_decisions d
               ON d.organization_id = spl.organization_id
              AND d.event_id = spl.event_id AND d.submission_id = spl.submission_id
            WHERE spl.organization_id = sp.organization_id
              AND spl.event_id = sp.event_id AND spl.participant_id = sp.participant_id
            ORDER BY CASE WHEN d.status = 'accepted' THEN 0 ELSE 1 END, spl.ordinal
            LIMIT 1
         ) AS submission_id
           FROM speaker_profiles sp
          WHERE sp.event_id = ?
       ORDER BY sp.display_name, sp.participant_id`,
      )
      .bind(eventId)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map((row) => {
      const submissionId = typeof row.submission_id === "string" ? row.submission_id : "";
      return {
        id: String(row.id),
        eventId,
        ...(submissionId.length === 0 ? {} : { submissionId }),
        participantId: String(row.participant_id),
        displayName: String(row.display_name),
        ...(row.email === null ? {} : { email: String(row.email) }),
        jobTitle: String(row.job_title),
        company: String(row.company),
        biography: String(row.biography),
        socialLinks: JSON.parse(String(row.social_links_json)) as Record<string, string>,
        travelLogistics: {
          travelRequired: Number(row.travel_required) === 1,
          arrivalAt: row.arrival_at === null ? null : String(row.arrival_at),
          departureAt: row.departure_at === null ? null : String(row.departure_at),
          accommodation: String(row.accommodation),
          dietaryRequirements: String(row.dietary_requirements),
          accessibilityNeeds: String(row.accessibility_needs),
          travelNotes: String(row.travel_notes),
        },
        ...(row.headshot_asset_id === null
          ? {}
          : { headshotAssetId: String(row.headshot_asset_id) }),
        ...(row.source_type === null
          ? {}
          : { sourceType: row.source_type as "cfp" | "manual" | "csv" | "crm" }),
        ...(row.source_id === null ? {} : { sourceId: String(row.source_id) }),
        role: "primary" as const,
        status:
          String(row.status) === "revoked"
            ? ("revoked" as const)
            : String(row.status) === "active"
              ? ("active" as const)
              : ("pending" as const),
        workflowStatus: String(row.status),
        organizerStatus: String(row.status),
        version: Number(row.version),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        ...(row.admitted_by_account_id === null
          ? {}
          : { authorAccountId: String(row.admitted_by_account_id) }),
      };
    });
  }

  async resolveVerifiedInvitationRecipient(email: string): Promise<{
    userId: string;
    normalizedEmail: string;
  } | null> {
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.length === 0) return null;
    const users = await this.#db
      .prepare(
        `SELECT id
           FROM auth_users
          WHERE email = ? COLLATE NOCASE AND email_verified = 1
          ORDER BY id
          LIMIT 2`,
      )
      .bind(normalizedEmail)
      .all<{ id: string }>();
    const matches = users.results ?? [];
    if (matches.length !== 1 || matches[0] === undefined) return null;
    return { userId: matches[0].id, normalizedEmail };
  }

  async ensureVerifiedParticipantGrant(input: {
    readonly organizationId: string;
    readonly eventId: string;
    readonly participantId: string;
    readonly email: string;
    readonly createdAt: string;
  }): Promise<boolean> {
    const profile = await this.#db
      .prepare(
        `SELECT id
           FROM speaker_profiles
          WHERE organization_id = ? AND event_id = ? AND participant_id = ?
            AND email = ? COLLATE NOCASE AND status <> 'revoked'
          LIMIT 2`,
      )
      .bind(input.organizationId, input.eventId, input.participantId, input.email.trim())
      .all<{ id: string }>();
    if ((profile.results ?? []).length !== 1) return false;
    const users = await this.#db
      .prepare(
        `SELECT users.id
           FROM auth_users AS users
           JOIN event_role_invitations AS invitations
             ON invitations.organization_id = ?
            AND invitations.event_id = ?
            AND invitations.role = 'speaker'
            AND invitations.participant_id = ?
            AND invitations.recipient_user_id = users.id
            AND invitations.accepted_by_user_id = users.id
            AND invitations.status = 'accepted'
            AND invitations.normalized_email = lower(trim(users.email))
          WHERE users.email = ? COLLATE NOCASE
            AND users.email_verified = 1
          ORDER BY users.id
          LIMIT 2`,
      )
      .bind(input.organizationId, input.eventId, input.participantId, input.email.trim())
      .all<{ id: string }>();
    if ((users.results ?? []).length !== 1) return false;
    const user = users.results[0];
    if (user === undefined) return false;
    await this.#db
      .prepare(
        `INSERT INTO participant_grants
           (organization_id,event_id,participant_id,user_id,permissions_json,
            created_at,updated_at,revoked_at)
         VALUES (?,?,?,?,'["edit_own_profile","manage_own_assets","view_own_tasks","update_own_tasks"]',?,?,NULL)
         ON CONFLICT(organization_id,event_id,participant_id,user_id) DO UPDATE SET
           permissions_json = excluded.permissions_json,
           updated_at = excluded.updated_at,
           revoked_at = NULL`,
      )
      .bind(
        input.organizationId,
        input.eventId,
        input.participantId,
        user.id,
        input.createdAt,
        input.createdAt,
      )
      .run();
    return true;
  }

  async saveOrganizerSpeakerImportPreview(
    command: SaveOrganizerSpeakerImportPreviewCommand,
  ): Promise<SpeakerImportPreview> {
    const scope = await this.getOrganizerAccessScope(command.eventId, command.accountId);
    if (scope === null || scope.tenantId !== command.organizationId)
      throw new Error("Organizer scope denied.");
    const revision = await this.#profileRevision(command.organizationId, command.eventId);
    await this.#db
      .prepare(
        `INSERT INTO speaker_import_previews
          (id,organization_id,event_id,account_id,source_digest,rows_json,roster_revision,created_at,committed_at)
         VALUES (?,?,?,?,?,?,?,?,NULL)`,
      )
      .bind(
        command.previewId,
        command.organizationId,
        command.eventId,
        command.accountId,
        command.sourceDigest,
        json(command.rows),
        revision,
        command.createdAt,
      )
      .run();
    return {
      previewId: command.previewId,
      sourceDigest: command.sourceDigest,
      rosterRevision: revision,
      validRows: command.rows,
      invalidRows: [],
    };
  }

  async commitOrganizerSpeakerImport(
    command: CommitOrganizerSpeakerImportCommand,
  ): Promise<OrganizerSpeakerAggregateResult> {
    const scope = await this.getOrganizerAccessScope(command.eventId, command.accountId);
    if (scope === null || scope.tenantId !== command.organizationId)
      throw new Error("Organizer scope denied.");
    const existing = await this.#db
      .prepare(
        `SELECT source_digest, participant_ids_json FROM speaker_aggregate_operations WHERE organization_id = ? AND event_id = ? AND operation_type = 'import' AND idempotency_key = ?`,
      )
      .bind(command.organizationId, command.eventId, command.idempotencyKey)
      .first<{ source_digest: string; participant_ids_json: string }>();
    if (existing !== null) {
      if (command.sourceDigest !== undefined && existing.source_digest !== command.sourceDigest)
        throw new Error("Idempotency digest conflict.");
      return {
        participantIds: JSON.parse(existing.participant_ids_json) as string[],
        replayed: true,
      };
    }
    const preview = await this.#db
      .prepare(
        `SELECT rows_json, source_digest, roster_revision FROM speaker_import_previews WHERE organization_id = ? AND event_id = ? AND id = ? AND account_id = ?`,
      )
      .bind(command.organizationId, command.eventId, command.previewId, command.accountId)
      .first<{ rows_json: string; source_digest: string; roster_revision: number }>();
    if (
      preview === null ||
      (command.sourceDigest !== undefined && preview.source_digest !== command.sourceDigest)
    )
      throw new Error("Import preview digest conflict.");
    if (
      (await this.#profileRevision(command.organizationId, command.eventId)) !==
      preview.roster_revision
    )
      throw new Error("Import preview is stale.");
    const rows = JSON.parse(preview.rows_json) as SpeakerImportRow[];
    const participantIds =
      command.participantIds === undefined || command.participantIds.length === 0
        ? await Promise.all(
            rows.map(async (row) => {
              const existingParticipant = await this.#db
                .prepare(
                  `SELECT id FROM participants WHERE organization_id = ? AND event_id = ? AND normalized_email = ? COLLATE NOCASE LIMIT 2`,
                )
                .bind(command.organizationId, command.eventId, row.email.toLowerCase())
                .all<{ id: string }>();
              const matches = existingParticipant.results ?? [];
              if (matches.length > 1) throw new Error("Import participant identity is ambiguous.");
              return matches[0]?.id ?? `participant:${command.previewId}:${row.rowNumber}`;
            }),
          )
        : [...command.participantIds];
    if (
      rows.length !== participantIds.length ||
      new Set(participantIds).size !== participantIds.length
    )
      throw new Error("Import participant identities are invalid.");
    const statements: D1PreparedStatement[] = [];
    rows.forEach((row, index) => {
      const participantId = participantIds[index];
      if (participantId === undefined) throw new Error("Import participant identity is missing.");
      const names = this.#participantNames(row.displayName);
      const sourceId = `${command.previewId}:row:${row.rowNumber}`;
      statements.push(
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO participants (id,organization_id,event_id,first_name,last_name,display_name,email,normalized_email,identity_state,source_type,source_id,claimed_user_id,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'resolved','csv',?,NULL,1,?,?)`,
          )
          .bind(
            participantId,
            command.organizationId,
            command.eventId,
            names.firstName,
            names.lastName,
            row.displayName,
            row.email,
            row.email.toLowerCase(),
            sourceId,
            command.committedAt,
            command.committedAt,
          ),
        this.#db
          .prepare(
            `INSERT INTO speaker_profiles (id,organization_id,event_id,participant_id,display_name,email,job_title,company,status,biography,social_links_json,travel_required,arrival_at,departure_at,accommodation,dietary_requirements,accessibility_needs,travel_notes,headshot_asset_id,source_type,source_id,version,created_at,updated_at,admitted_by_account_id,admitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,'','','','',NULL,'csv',?,1,?,?,?,?)`,
          )
          .bind(
            `profile:${command.eventId}:${participantId}`,
            command.organizationId,
            command.eventId,
            participantId,
            row.displayName,
            row.email,
            row.jobTitle,
            row.company,
            row.status ?? "pending",
            row.biography,
            json(row.socialLinks),
            sourceId,
            command.committedAt,
            command.committedAt,
            command.accountId,
            command.committedAt,
          ),
        ...this.#communicationRecipientStatements({
          organizationId: command.organizationId,
          eventId: command.eventId,
          participantId,
          displayName: row.displayName,
          email: row.email,
          updatedAt: command.committedAt,
        }),
        this.#db
          .prepare(
            `INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,details_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            `speaker-import:${command.eventId}:${command.idempotencyKey}:${row.rowNumber}`,
            command.organizationId,
            "user",
            command.accountId,
            "speaker.imported",
            "speaker_profile",
            `profile:${command.eventId}:${participantId}`,
            json({
              eventId: command.eventId,
              previewId: command.previewId,
              rowNumber: row.rowNumber,
            }),
            command.committedAt,
          ),
      );
    });
    statements.push(
      this.#db
        .prepare(
          `INSERT INTO speaker_aggregate_operations (id,organization_id,event_id,operation_type,idempotency_key,source_digest,preview_id,participant_ids_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          `speaker-import:${command.eventId}:${command.idempotencyKey}`,
          command.organizationId,
          command.eventId,
          "import",
          command.idempotencyKey,
          preview.source_digest,
          command.previewId,
          json(participantIds),
          command.committedAt,
        ),
      this.#db
        .prepare(
          `UPDATE speaker_import_previews SET committed_at = ? WHERE organization_id = ? AND event_id = ? AND id = ? AND committed_at IS NULL`,
        )
        .bind(command.committedAt, command.organizationId, command.eventId, command.previewId),
    );
    await this.#db.batch(statements);
    return { participantIds, replayed: false };
  }

  async upsertOrganizerSpeakerAggregate(
    command: UpsertOrganizerSpeakerAggregateCommand,
  ): Promise<RepositoryResult<SpeakerProfile>> {
    const scope = await this.getOrganizerAccessScope(command.eventId, command.accountId);
    if (scope === null || scope.tenantId !== command.organizationId)
      return { ok: false, reason: "not_found" };
    const digest = command.sourceDigest ?? json({ ...command, updatedAt: undefined });
    const operationKey = command.idempotencyKey;
    if (operationKey !== undefined) {
      const existing = await this.#db
        .prepare(
          `SELECT source_digest, participant_ids_json FROM speaker_aggregate_operations WHERE organization_id = ? AND event_id = ? AND operation_type = 'create' AND idempotency_key = ?`,
        )
        .bind(command.organizationId, command.eventId, operationKey)
        .first<{ source_digest: string; participant_ids_json: string }>();
      if (existing !== null) {
        if (existing.source_digest !== digest) return { ok: false, reason: "version_conflict" };
        const profile = await this.getProfile(command.eventId, command.participantId);
        return profile === null ? { ok: false, reason: "not_found" } : { ok: true, value: profile };
      }
    }
    if (command.expectedVersion !== null) {
      const mutationType = command.status === "revoked" ? "revoke" : "update";
      const durableKey = `${command.participantId}:${command.expectedVersion}`;
      const replay = await this.#db
        .prepare(
          `SELECT source_digest FROM speaker_aggregate_operations WHERE organization_id = ? AND event_id = ? AND operation_type = ? AND idempotency_key = ?`,
        )
        .bind(command.organizationId, command.eventId, mutationType, durableKey)
        .first<{ source_digest: string }>();
      if (replay !== null) {
        if (replay.source_digest !== digest) return { ok: false, reason: "version_conflict" };
        const profile = await this.getProfile(command.eventId, command.participantId);
        return profile === null ? { ok: false, reason: "not_found" } : { ok: true, value: profile };
      }
    }
    const current = await this.getProfile(command.eventId, command.participantId);
    if (command.expectedVersion === null) {
      if (current !== null) return { ok: false, reason: "version_conflict" };
      const names = this.#participantNames(command.displayName);
      const statements = [
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO participants (id,organization_id,event_id,first_name,last_name,display_name,email,normalized_email,identity_state,source_type,source_id,claimed_user_id,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'resolved',?,?,NULL,1,?,?)`,
          )
          .bind(
            command.participantId,
            command.organizationId,
            command.eventId,
            names.firstName,
            names.lastName,
            command.displayName,
            command.email,
            command.email.toLowerCase(),
            command.sourceType,
            command.sourceId,
            command.updatedAt,
            command.updatedAt,
          ),
        this.#db
          .prepare(
            `INSERT INTO speaker_profiles (id,organization_id,event_id,participant_id,display_name,email,job_title,company,status,biography,social_links_json,travel_required,arrival_at,departure_at,accommodation,dietary_requirements,accessibility_needs,travel_notes,headshot_asset_id,source_type,source_id,version,created_at,updated_at,admitted_by_account_id,admitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,1,?,?,?,?)`,
          )
          .bind(
            command.profileId,
            command.organizationId,
            command.eventId,
            command.participantId,
            command.displayName,
            command.email,
            command.jobTitle,
            command.company,
            command.status,
            command.biography,
            json(command.socialLinks),
            command.travelLogistics.travelRequired ? 1 : 0,
            command.travelLogistics.arrivalAt,
            command.travelLogistics.departureAt,
            command.travelLogistics.accommodation,
            command.travelLogistics.dietaryRequirements,
            command.travelLogistics.accessibilityNeeds,
            command.travelLogistics.travelNotes,
            command.sourceType,
            command.sourceId,
            command.updatedAt,
            command.updatedAt,
            command.accountId,
            command.updatedAt,
          ),
        ...this.#communicationRecipientStatements({
          organizationId: command.organizationId,
          eventId: command.eventId,
          participantId: command.participantId,
          displayName: command.displayName,
          email: command.email,
          updatedAt: command.updatedAt,
        }),
        this.#db
          .prepare(
            `INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,details_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            `speaker-create:${command.eventId}:${operationKey ?? command.participantId}`,
            command.organizationId,
            "user",
            command.accountId,
            "speaker.created",
            "speaker_profile",
            command.profileId,
            json({ eventId: command.eventId, participantId: command.participantId }),
            command.updatedAt,
          ),
      ];
      if (operationKey !== undefined)
        statements.push(
          this.#db
            .prepare(
              `INSERT INTO speaker_aggregate_operations (id,organization_id,event_id,operation_type,idempotency_key,source_digest,preview_id,participant_ids_json,created_at) VALUES (?,?,?,?,?,?,NULL,?,?)`,
            )
            .bind(
              `speaker-create:${command.eventId}:${operationKey}`,
              command.organizationId,
              command.eventId,
              "create",
              operationKey,
              digest,
              json([command.participantId]),
              command.updatedAt,
            ),
        );
      try {
        await this.#db.batch(statements);
      } catch {
        return { ok: false, reason: "version_conflict" };
      }
    } else {
      if (current === null) return { ok: false, reason: "not_found" };
      if (current.version !== command.expectedVersion)
        return { ok: false, reason: "version_conflict" };
      const mutationType = command.status === "revoked" ? "revoke" : "update";
      const durableKey = `${command.participantId}:${command.expectedVersion}`;
      const updateId = `speaker-${mutationType}:${command.eventId}:${durableKey}`;
      try {
        await this.#db.batch([
          this.#db
            .prepare(
              `INSERT INTO speaker_aggregate_operations (id,organization_id,event_id,operation_type,idempotency_key,expected_version,source_digest,preview_id,participant_ids_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              updateId,
              command.organizationId,
              command.eventId,
              mutationType,
              durableKey,
              command.expectedVersion,
              digest,
              null,
              json([command.participantId]),
              command.updatedAt,
            ),
          this.#db
            .prepare(
              `UPDATE speaker_profiles SET display_name=?,email=?,job_title=?,company=?,status=?,biography=?,social_links_json=?,travel_required=?,arrival_at=?,departure_at=?,accommodation=?,dietary_requirements=?,accessibility_needs=?,travel_notes=?,version=version+1,updated_at=?,admitted_by_account_id=? WHERE organization_id=? AND event_id=? AND participant_id=? AND version=?`,
            )
            .bind(
              command.displayName,
              command.email,
              command.jobTitle,
              command.company,
              command.status,
              command.biography,
              json(command.socialLinks),
              command.travelLogistics.travelRequired ? 1 : 0,
              command.travelLogistics.arrivalAt,
              command.travelLogistics.departureAt,
              command.travelLogistics.accommodation,
              command.travelLogistics.dietaryRequirements,
              command.travelLogistics.accessibilityNeeds,
              command.travelLogistics.travelNotes,
              command.updatedAt,
              command.accountId,
              command.organizationId,
              command.eventId,
              command.participantId,
              command.expectedVersion,
            ),
          ...this.#communicationRecipientStatements({
            organizationId: command.organizationId,
            eventId: command.eventId,
            participantId: command.participantId,
            displayName: command.displayName,
            email: command.email,
            updatedAt: command.updatedAt,
          }),
          this.#db
            .prepare(
              `INSERT INTO audit_events (id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,details_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              updateId,
              command.organizationId,
              "user",
              command.accountId,
              command.status === "revoked" ? "speaker.revoked" : "speaker.updated",
              "speaker_profile",
              current.id,
              json({
                eventId: command.eventId,
                participantId: command.participantId,
                expectedVersion: command.expectedVersion,
              }),
              command.updatedAt,
            ),
        ]);
      } catch {
        return { ok: false, reason: "version_conflict" };
      }
    }
    const value = await this.getProfile(command.eventId, command.participantId);
    return value === null ? { ok: false, reason: "not_found" } : { ok: true, value };
  }

  async #profileRevision(organizationId: string, eventId: string): Promise<number> {
    const row = await this.#db
      .prepare(
        `SELECT COALESCE(sum(version),0) AS revision FROM speaker_profiles WHERE organization_id = ? AND event_id = ?`,
      )
      .bind(organizationId, eventId)
      .first<{ revision: number }>();
    return Number(row?.revision ?? 0);
  }

  #participantNames(displayName: string): { firstName: string; lastName: string } {
    const normalized = displayName.trim();
    const split = normalized.indexOf(" ");
    return split < 0
      ? { firstName: normalized, lastName: "" }
      : { firstName: normalized.slice(0, split), lastName: normalized.slice(split + 1).trim() };
  }

  #communicationRecipientStatements(
    input: {
      organizationId: string;
      eventId: string;
      participantId: string;
      displayName: string;
      email: string;
      updatedAt: string;
    },
    decisionFence?: SpeakerDecisionWriteFence,
  ): D1PreparedStatement[] {
    const firstName = this.#participantNames(input.displayName).firstName;
    const decisionGuard =
      decisionFence === undefined
        ? { sql: "", values: [] as readonly unknown[] }
        : {
            sql: ` WHERE EXISTS (
              SELECT 1
              FROM evaluation_decisions
              WHERE organization_id = ?
                AND event_id = ?
                AND plan_id = ?
                AND submission_id = ?
                AND version = ?
                AND status = ?
            )`,
            values: [
              decisionFence.tenantId,
              decisionFence.eventId,
              decisionFence.planId,
              decisionFence.submissionId,
              decisionFence.version,
              decisionFence.status,
            ],
          };
    return [
      this.#db
        .prepare(
          `INSERT INTO communication_recipients
             (id,organization_id,event_id,participant_id,email,display_name,data_json,updated_at)
           ${
             decisionFence === undefined ? "VALUES (?,?,?,?,?,?,?,?)" : "SELECT ?,?,?,?,?,?,?,? "
}${decisionGuard.sql}
           ON CONFLICT(id) DO UPDATE SET
             organization_id=excluded.organization_id,
             event_id=excluded.event_id,
             participant_id=excluded.participant_id,
             email=excluded.email,
             display_name=excluded.display_name,
             data_json=excluded.data_json,
             updated_at=excluded.updated_at`,
        )
        .bind(
          input.participantId,
          input.organizationId,
          input.eventId,
          input.participantId,
          input.email,
          input.displayName,
          json({ first_name: firstName, display_name: input.displayName, email: input.email }),
          input.updatedAt,
          ...decisionGuard.values,
        ),
      this.#db
        .prepare(
          `INSERT INTO communication_recipient_audiences
             (organization_id,event_id,recipient_id,audience)
           ${
             decisionFence === undefined ? "VALUES (?,?,?,'all_participants')" : "SELECT ?,?,?,? "
}${decisionGuard.sql}
           ON CONFLICT(organization_id,event_id,recipient_id,audience) DO NOTHING`,
        )
        .bind(
          input.organizationId,
          input.eventId,
          input.participantId,
          ...(decisionFence === undefined ? [] : ["all_participants"]),
          ...decisionGuard.values,
        ),
    ];
  }

  async listSubmissions(
    eventId: string,
    submissionIds: readonly string[],
  ): Promise<SpeakerSubmission[]> {
    if (submissionIds.length === 0) return [];
    const storedSubmissionIds = [...new Set(submissionIds)];
    const rows = await this.#orm
      .select()
      .from(submissions)
      .where(and(eq(submissions.eventId, eventId), inArray(submissions.id, storedSubmissionIds)));
    const result: SpeakerSubmission[] = [];
    for (const row of rows) {
      const links = await this.#db
        .prepare(
          `SELECT sp.participant_id, sp.role, p.first_name, p.last_name, p.email
             FROM submission_participants sp
             JOIN participants p
               ON p.organization_id = sp.organization_id
              AND p.event_id = sp.event_id
              AND p.id = sp.participant_id
            WHERE sp.organization_id = ? AND sp.submission_id = ?
            ORDER BY sp.ordinal`,
        )
        .bind(row.organizationId, row.id)
        .all<{
          participant_id: string;
          role: string;
          first_name: string;
          last_name: string;
          email: string;
        }>();
      const answers = await this.#db
        .prepare(
          "SELECT field_key, value_json FROM submission_answers WHERE organization_id = ? AND submission_id = ?",
        )
        .bind(row.organizationId, row.id)
        .all<{ field_key: string; value_json: string }>();
      const answerRecord = Object.fromEntries(
        (answers.results ?? []).map((answer) => [answer.field_key, JSON.parse(answer.value_json)]),
      );
      const decision = await this.#db
        .withSession("first-primary")
        .prepare(
          "SELECT status FROM evaluation_decisions WHERE organization_id = ? AND event_id = ? AND submission_id = ? ORDER BY updated_at DESC, version DESC, id DESC LIMIT 1",
        )
        .bind(row.organizationId, row.eventId, row.id)
        .first<{ status: string }>();
      result.push({
        id: row.id,
        eventId: row.eventId,
        title: typeof answerRecord.title === "string" ? answerRecord.title : row.id,
        status: portalSubmissionStatus(row.status, decision?.status),
        participantIds: (links.results ?? []).map((link) => link.participant_id),
        participants: (links.results ?? []).map((link) => ({
          id: link.participant_id,
          firstName: link.first_name,
          lastName: link.last_name,
          email: link.email,
          role: link.role === "primary" ? "primary" : "co_author",
        })),
        primaryParticipantId: (links.results ?? []).find((link) => link.role === "primary")
          ?.participant_id,
        formId: row.formId,
        version: row.version,
        updatedAt: row.updatedAt,
        answers: answerRecord,
      } as SpeakerSubmission);
    }
    return result;
  }

  async listSubmissionsForOrganization(
    organizationId: string,
    eventId: string,
    submissionIds: readonly string[],
  ): Promise<OrganizationQualifiedSpeakerSubmission[]> {
    if (submissionIds.length === 0) return [];
    const rows = await this.#orm
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.organizationId, organizationId),
          eq(submissions.eventId, eventId),
          inArray(submissions.id, [...new Set(submissionIds)]),
        ),
      );
    const result: OrganizationQualifiedSpeakerSubmission[] = [];
    for (const row of rows) {
      const links = await this.#db
        .prepare(
          "SELECT participant_id, role FROM submission_participants WHERE organization_id = ? AND event_id = ? AND submission_id = ? ORDER BY ordinal",
        )
        .bind(organizationId, eventId, row.id)
        .all<{ participant_id: string; role: string }>();
      const answers = await this.#db
        .prepare(
          "SELECT field_key, value_json FROM submission_answers WHERE organization_id = ? AND submission_id = ?",
        )
        .bind(organizationId, row.id)
        .all<{ field_key: string; value_json: string }>();
      const answerRecord = Object.fromEntries(
        (answers.results ?? []).map((answer) => [answer.field_key, JSON.parse(answer.value_json)]),
      );
      result.push({
        tenantId: row.organizationId,
        id: row.id,
        eventId: row.eventId,
        title: typeof answerRecord.title === "string" ? answerRecord.title : row.id,
        status: row.status,
        participantIds: (links.results ?? []).map((link) => link.participant_id),
        primaryParticipantId: (links.results ?? []).find((link) => link.role === "primary")
          ?.participant_id,
        formId: row.formId,
        version: row.version,
        updatedAt: row.updatedAt,
        answers: answerRecord,
      } as OrganizationQualifiedSpeakerSubmission);
    }
    return result;
  }

  async getSubmission(eventId: string, submissionId: string): Promise<SpeakerSubmission | null> {
    return (await this.listSubmissions(eventId, [submissionId]))[0] ?? null;
  }

  async listProfiles(
    eventId: string,
    participantIds: readonly string[],
  ): Promise<SpeakerProfile[]> {
    if (participantIds.length === 0) return [];
    const rows = await this.#orm
      .select()
      .from(speakerProfiles)
      .where(
        and(
          eq(speakerProfiles.eventId, eventId),
          inArray(speakerProfiles.participantId, [...new Set(participantIds)]),
        ),
      );
    return rows.map((row) => this.#profile(row));
  }

  async getProfile(eventId: string, participantId: string): Promise<SpeakerProfile | null> {
    return (await this.listProfiles(eventId, [participantId]))[0] ?? null;
  }

  async listProfilesForEvent(organizationId: string, eventId: string): Promise<SpeakerProfile[]> {
    const rows = await this.#orm
      .select()
      .from(speakerProfiles)
      .where(
        and(
          eq(speakerProfiles.organizationId, organizationId),
          eq(speakerProfiles.eventId, eventId),
        ),
      );
    return rows.map((row) => this.#profile(row));
  }

  async createProfile(
    profile: SpeakerProfile,
    decisionFence?: SpeakerDecisionWriteFence,
  ): Promise<RepositoryResult<SpeakerProfile>> {
    const scope = await this.#eventScope(profile.eventId);
    if (scope === null) return { ok: false, reason: "not_found" };
    try {
      const email = profile.email?.trim() ?? "";
      const profileValues = [
        profile.id,
        scope.organizationId,
        profile.eventId,
        profile.participantId,
        profile.displayName,
        email.length === 0 ? null : email,
        profile.jobTitle ?? "",
        profile.company ?? "",
        profile.status ?? "",
        profile.biography,
        json(profile.socialLinks ?? {}),
        profile.travelLogistics?.travelRequired ? 1 : 0,
        profile.travelLogistics?.arrivalAt ?? null,
        profile.travelLogistics?.departureAt ?? null,
        profile.travelLogistics?.accommodation ?? "",
        profile.travelLogistics?.dietaryRequirements ?? "",
        profile.travelLogistics?.accessibilityNeeds ?? "",
        profile.travelLogistics?.travelNotes ?? "",
        profile.headshotAssetId ?? null,
        profile.sourceType ?? null,
        profile.sourceId ?? null,
        profile.version,
        profile.updatedAt,
        profile.updatedAt,
      ];
      const profileStatement = this.#db
        .prepare(
          `INSERT INTO speaker_profiles
             (id, organization_id, event_id, participant_id, display_name, email, job_title,
              company, status, biography, social_links_json, travel_required, arrival_at,
              departure_at, accommodation, dietary_requirements, accessibility_needs,
              travel_notes, headshot_asset_id, source_type, source_id, version, created_at, updated_at)
           ${
             decisionFence === undefined
               ? "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
               : `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                  WHERE EXISTS (
                    SELECT 1
                    FROM evaluation_decisions
                    WHERE organization_id = ?
                      AND event_id = ?
                      AND plan_id = ?
                      AND submission_id = ?
                      AND version = ?
                      AND status = ?
                  )`
}`,
        )
        .bind(
          ...profileValues,
          ...(decisionFence === undefined
            ? []
            : [
                decisionFence.tenantId,
                decisionFence.eventId,
                decisionFence.planId,
                decisionFence.submissionId,
                decisionFence.version,
                decisionFence.status,
              ]),
        );
      if (decisionFence === undefined) {
        await this.#db.batch([
          profileStatement,
          ...(email.length === 0
            ? []
            : this.#communicationRecipientStatements({
                organizationId: scope.organizationId,
                eventId: profile.eventId,
                participantId: profile.participantId,
                displayName: profile.displayName,
                email,
                updatedAt: profile.updatedAt,
              })),
        ]);
      } else {
        const [result] = await this.#db.batch([profileStatement]);
        if (result?.meta.changes !== 1) return { ok: false, reason: "version_conflict" };
        if (email.length !== 0) {
          await this.#db.batch(
            this.#communicationRecipientStatements(
              {
                organizationId: scope.organizationId,
                eventId: profile.eventId,
                participantId: profile.participantId,
                displayName: profile.displayName,
                email,
                updatedAt: profile.updatedAt,
              },
              decisionFence,
            ),
          );
        }
      }
    } catch {
      return { ok: false, reason: "version_conflict" };
    }
    const value = await this.getProfile(profile.eventId, profile.participantId);
    return value === null ? { ok: false, reason: "not_found" } : { ok: true, value };
  }

  async updateBiography(
    command: UpdateBiographyCommand,
  ): Promise<RepositoryResult<SpeakerProfile>> {
    const current = await this.getProfile(command.eventId, command.participantId);
    if (current === null) return { ok: false, reason: "not_found" };
    if (current.version !== command.expectedVersion)
      return { ok: false, reason: "version_conflict" };
    return this.updateProfile?.({ ...command, actorAccountId: command.participantId });
  }

  async updateProfile(
    command: UpdateSpeakerProfileCommand,
  ): Promise<RepositoryResult<SpeakerProfile>> {
    const current = await this.getProfile(command.eventId, command.participantId);
    if (current === null) return { ok: false, reason: "not_found" };
    if (current.version !== command.expectedVersion)
      return { ok: false, reason: "version_conflict" };
    const travel = command.travelLogistics ?? current.travelLogistics;
    const scope = await this.#eventScope(command.eventId);
    if (scope === null) return { ok: false, reason: "not_found" };
    const displayName = command.displayName ?? current.displayName;
    const email = command.email ?? current.email ?? "";
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE speaker_profiles SET display_name = ?, email = ?, job_title = ?, company = ?, status = ?, biography = ?, social_links_json = ?, headshot_asset_id = ?, travel_required = ?, arrival_at = ?, departure_at = ?, accommodation = ?, dietary_requirements = ?, accessibility_needs = ?, travel_notes = ?, version = version + 1, updated_at = ?
         WHERE event_id = ? AND participant_id = ? AND version = ?`,
        )
        .bind(
          displayName,
          email.length === 0 ? null : email,
          command.jobTitle ?? current.jobTitle ?? "",
          command.company ?? current.company ?? "",
          command.status ?? current.status ?? "",
          command.biography ?? current.biography,
          json(command.socialLinks ?? current.socialLinks ?? {}),
          command.headshotAssetId === null
            ? null
            : (command.headshotAssetId ?? current.headshotAssetId ?? null),
          travel?.travelRequired ? 1 : 0,
          travel?.arrivalAt ?? null,
          travel?.departureAt ?? null,
          travel?.accommodation ?? "",
          travel?.dietaryRequirements ?? "",
          travel?.accessibilityNeeds ?? "",
          travel?.travelNotes ?? "",
          command.updatedAt,
          command.eventId,
          command.participantId,
          command.expectedVersion,
        ),
      ...(email.length === 0
        ? []
        : this.#communicationRecipientStatements({
            organizationId: scope.organizationId,
            eventId: command.eventId,
            participantId: command.participantId,
            displayName,
            email,
            updatedAt: command.updatedAt,
          })),
    ]);
    const persisted = await this.getProfile(command.eventId, command.participantId);
    if (persisted === null) return { ok: false, reason: "not_found" };
    if (
      (results[0]?.meta?.changes ?? 0) !== 1 &&
      (persisted.version !== command.expectedVersion + 1 ||
        persisted.updatedAt !== command.updatedAt)
    ) {
      return { ok: false, reason: "version_conflict" };
    }
    return { ok: true, value: persisted };
  }

  async listTasks(eventId: string, participantIds: readonly string[]): Promise<SpeakerTask[]> {
    if (participantIds.length === 0) return [];
    const rows = await this.#orm
      .select()
      .from(speakerTasks)
      .where(
        and(
          eq(speakerTasks.eventId, eventId),
          inArray(speakerTasks.participantId, [...new Set(participantIds)]),
        ),
      );
    return Promise.all(
      rows.map(async (row) => ({ ...(await this.#task(row)), tenantId: row.organizationId })),
    );
  }

  async listTasksForOrganization(
    organizationId: string,
    eventId: string,
    participantIds: readonly string[],
  ): Promise<OrganizationQualifiedSpeakerTask[]> {
    if (participantIds.length === 0) return [];
    const rows = await this.#orm
      .select()
      .from(speakerTasks)
      .where(
        and(
          eq(speakerTasks.organizationId, organizationId),
          eq(speakerTasks.eventId, eventId),
          inArray(speakerTasks.participantId, [...new Set(participantIds)]),
        ),
      );
    return Promise.all(
      rows.map(async (row) => ({ ...(await this.#task(row)), tenantId: row.organizationId })),
    );
  }

  async getTask(eventId: string, taskId: string): Promise<SpeakerTask | null> {
    const rows = await this.#orm
      .select()
      .from(speakerTasks)
      .where(and(eq(speakerTasks.eventId, eventId), eq(speakerTasks.id, taskId)))
      .limit(1);
    return rows[0] === undefined
      ? null
      : { ...(await this.#task(rows[0])), tenantId: rows[0].organizationId };
  }

  async getTasksByIds(eventId: string, taskIds: readonly string[]): Promise<SpeakerTask[]> {
    if (taskIds.length === 0) return [];
    const rows = await this.#orm
      .select()
      .from(speakerTasks)
      .where(
        and(eq(speakerTasks.eventId, eventId), inArray(speakerTasks.id, [...new Set(taskIds)])),
      );
    return Promise.all(
      rows.map(async (row) => ({ ...(await this.#task(row)), tenantId: row.organizationId })),
    );
  }

  async getTaskForm(eventId: string, taskId: string): Promise<SpeakerTaskFormDefinition | null> {
    const scope = await this.#eventScope(eventId);
    if (scope === null) return null;
    const row = await this.#db
      .prepare(
        `SELECT id, event_id, task_id, title, description, fields_json, version, published, updated_at
           FROM speaker_task_forms
          WHERE organization_id = ? AND event_id = ? AND task_id = ? AND published = 1
          LIMIT 1`,
      )
      .bind(scope.organizationId, eventId, taskId)
      .first<Record<string, unknown>>();
    if (row === null) return null;
    return {
      id: String(row.id),
      eventId: String(row.event_id),
      taskId: String(row.task_id),
      title: String(row.title),
      ...(String(row.description ?? "").length === 0
        ? {}
        : { description: String(row.description) }),
      fields: this.#storedJson(row.fields_json) as SpeakerTaskFormDefinition["fields"],
      version: Number(row.version),
      published: Boolean(row.published),
      updatedAt: String(row.updated_at),
    };
  }

  async listTaskResponses(
    eventId: string,
    taskId: string,
    participantId: string,
  ): Promise<SpeakerTaskResponseRecord[]> {
    const scope = await this.#eventScope(eventId);
    if (scope === null) return [];
    const rows = await this.#db
      .prepare(
        `SELECT id, event_id, task_id, participant_id, definition_version, answers_json,
                status, version, feedback, submitted_at, updated_at
           FROM speaker_task_responses
          WHERE organization_id = ? AND event_id = ? AND task_id = ? AND participant_id = ?
          ORDER BY version ASC, updated_at ASC, id ASC`,
      )
      .bind(scope.organizationId, eventId, taskId, participantId)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map((row) => ({
      id: String(row.id),
      eventId: String(row.event_id),
      taskId: String(row.task_id),
      participantId: String(row.participant_id),
      definitionVersion: Number(row.definition_version),
      answers: this.#storedJson(row.answers_json) as SpeakerTaskResponseRecord["answers"],
      status: String(row.status) as SpeakerTaskResponseRecord["status"],
      version: Number(row.version),
      updatedAt: String(row.updated_at),
      ...(row.feedback === null || row.feedback === undefined
        ? {}
        : { feedback: String(row.feedback) }),
      ...(row.submitted_at === null || row.submitted_at === undefined
        ? {}
        : { submittedAt: String(row.submitted_at) }),
    }));
  }

  async saveTaskResponse(
    response: SpeakerTaskResponseRecord,
    expectedVersion: number | null,
  ): Promise<RepositoryResult<SpeakerTaskResponseRecord>> {
    const scope = await this.#eventScope(response.eventId);
    if (scope === null) return { ok: false, reason: "not_found" };
    const currentVersion = expectedVersion ?? 0;
    if (response.version !== currentVersion + 1) {
      return { ok: false, reason: "version_conflict" };
    }
    try {
      const result = await this.#db
        .prepare(
          `INSERT INTO speaker_task_responses
             (id, organization_id, event_id, task_id, participant_id, definition_version,
              answers_json, status, version, feedback, submitted_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE COALESCE((
                    SELECT MAX(version)
                      FROM speaker_task_responses
                     WHERE organization_id = ? AND event_id = ? AND task_id = ? AND participant_id = ?
                  ), 0) = ?`,
        )
        .bind(
          response.id,
          scope.organizationId,
          response.eventId,
          response.taskId,
          response.participantId,
          response.definitionVersion,
          json(response.answers),
          response.status,
          response.version,
          response.feedback ?? null,
          response.submittedAt ?? null,
          response.updatedAt,
          scope.organizationId,
          response.eventId,
          response.taskId,
          response.participantId,
          currentVersion,
        )
        .run();
      if ((result.meta?.changes ?? 0) !== 1) return { ok: false, reason: "version_conflict" };
    } catch {
      return { ok: false, reason: "version_conflict" };
    }
    return { ok: true, value: structuredClone(response) };
  }

  async createTask(command: SpeakerTaskRepositoryCommand): Promise<RepositoryResult<SpeakerTask>> {
    return this.#saveTask(command, true);
  }
  async createSpeakerTask(
    command: SpeakerTaskRepositoryCommand,
  ): Promise<RepositoryResult<SpeakerTask>> {
    return this.createTask(command);
  }
  async updateTask(command: SpeakerTaskRepositoryCommand): Promise<RepositoryResult<SpeakerTask>> {
    return this.#saveTask(command, false);
  }
  async updateSpeakerTask(
    command: SpeakerTaskRepositoryCommand,
  ): Promise<RepositoryResult<SpeakerTask>> {
    return this.updateTask(command);
  }

  async transitionTask(
    command: TransitionSpeakerTaskCommand,
  ): Promise<RepositoryResult<{ task: SpeakerTask; transition: typeof command.transition }>> {
    const current = await this.getTask(command.eventId, command.taskId);
    if (current === null) return { ok: false, reason: "not_found" };
    if (current.version !== command.expectedVersion || current.status !== command.fromStatus)
      return { ok: false, reason: "version_conflict" };
    const scope = await this.#eventScope(command.eventId);
    if (scope === null) return { ok: false, reason: "not_found" };
    const statements = [
      ...(command.toStatus === "submitted" && command.replacementBaselineAssetId !== undefined
        ? [
            guard(
              this.#db,
              `EXISTS (
                SELECT 1
                  FROM speaker_tasks AS task
                  JOIN speaker_assets AS baseline
                    ON baseline.organization_id = task.organization_id
                   AND baseline.event_id = task.event_id
                   AND baseline.id = task.replacement_baseline_asset_id
                  JOIN speaker_assets AS current
                    ON current.organization_id = baseline.organization_id
                   AND current.event_id = baseline.event_id
                   AND current.version_family_id = baseline.version_family_id
                   AND current.id = current.current_version_id
                 WHERE task.organization_id = ?
                   AND task.event_id = ?
                   AND task.id = ?
                   AND task.version = ?
                   AND task.status = ?
                   AND task.replacement_baseline_asset_id = ?
                   AND current.state = 'ready'
                   AND current.version > baseline.version
                   AND (
                     task.accepted_asset_kinds_json = '[]'
                     OR EXISTS (
                       SELECT 1
                         FROM json_each(task.accepted_asset_kinds_json)
                        WHERE value = current.kind
                     )
                   )
              )`,
              [
                scope.organizationId,
                command.eventId,
                command.taskId,
                command.expectedVersion,
                command.fromStatus,
                command.replacementBaselineAssetId,
              ],
            ),
          ]
        : []),
      this.#db
        .prepare(
          "UPDATE speaker_tasks SET status = ?, replacement_baseline_asset_id = CASE WHEN ? = 'submitted' THEN NULL ELSE replacement_baseline_asset_id END, version = version + 1, updated_at = ? WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ? AND status = ?",
        )
        .bind(
          command.toStatus,
          command.toStatus,
          command.transition.occurredAt,
          scope.organizationId,
          command.eventId,
          command.taskId,
          command.expectedVersion,
          command.fromStatus,
        ),
      this.#db
        .prepare(
          `INSERT INTO speaker_task_transitions
             (id, organization_id, event_id, task_id, participant_id, actor_account_id, from_status, to_status, note, occurred_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM speaker_tasks
               WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ? AND status = ?
            )`,
        )
        .bind(
          command.transition.id,
          scope.organizationId,
          command.eventId,
          command.taskId,
          command.transition.participantId,
          command.transition.actorAccountId,
          command.fromStatus,
          command.toStatus,
          command.transition.note ?? null,
          command.transition.occurredAt,
          scope.organizationId,
          command.eventId,
          command.taskId,
          command.expectedVersion + 1,
          command.toStatus,
        ),
    ];
    try {
      const result = await this.#db.batch(statements);
      const updateIndex =
        command.toStatus === "submitted" && command.replacementBaselineAssetId !== undefined
          ? 1
          : 0;
      if ((result[updateIndex]?.meta?.changes ?? 0) !== 1) {
        return { ok: false, reason: "version_conflict" };
      }
    } catch {
      return { ok: false, reason: "version_conflict" };
    }
    const task = await this.getTask(command.eventId, command.taskId);
    return task === null
      ? { ok: false, reason: "not_found" }
      : { ok: true, value: { task, transition: command.transition } };
  }

  async createPendingAsset(asset: SpeakerAsset): Promise<SpeakerAsset> {
    const scope = await this.#eventScope(asset.eventId);
    if (scope === null || (asset.tenantId !== undefined && asset.tenantId !== scope.organizationId))
      throw new Error("The speaker asset is outside the event tenant.");
    const version = asset.version ?? 1;
    await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO speaker_assets (id, organization_id, event_id, session_id, participant_id, task_id, kind, object_key, file_name, content_type, size_bytes, uploader_account_id, uploader_label, state, version, version_family_id, supersedes_asset_id, comment_thread_id, review_state, review_note, reviewed_at, reviewed_by, review_version, latest_version_id, current_version_id, approved_version_id, released_version_id, rejection_reason, created_at, finalized_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          asset.id,
          scope.organizationId,
          asset.eventId,
          asset.sessionId ?? null,
          asset.participantId,
          asset.taskId ?? null,
          asset.kind,
          asset.objectKey,
          asset.fileName,
          asset.contentType,
          asset.sizeBytes,
          asset.uploaderAccountId ?? null,
          asset.uploaderLabel ?? null,
          asset.state,
          version,
          asset.versionFamilyId ?? asset.id,
          asset.supersedesAssetId ?? null,
          asset.commentThreadId ?? `asset-thread:${asset.id}`,
          asset.reviewState ?? null,
          asset.reviewNote ?? null,
          asset.reviewedAt ?? null,
          asset.reviewedBy ?? null,
          asset.reviewVersion ?? 0,
          asset.latestVersionId ?? null,
          asset.currentVersionId ?? null,
          asset.approvedVersionId ?? null,
          asset.releasedVersionId ?? null,
          asset.rejectionReason ?? null,
          asset.createdAt,
          asset.finalizedAt ?? null,
        ),
    ]);
    const persisted = await this.getAsset(asset.eventId, asset.id);
    if (persisted === null) throw new Error("The speaker asset was not persisted.");
    return persisted;
  }

  async createPendingAssetVersion(
    command: CreatePendingSpeakerAssetVersionCommand,
  ): Promise<RepositoryResult<SpeakerAsset>> {
    const { asset } = command;
    const scope = await this.#eventScope(asset.eventId);
    if (
      scope === null ||
      (asset.tenantId !== undefined && asset.tenantId !== scope.organizationId) ||
      asset.state !== "pending_upload" ||
      asset.supersedesAssetId !== command.expectedLatestAssetId ||
      asset.version !== command.expectedLatestVersion + 1 ||
      asset.versionId !== asset.id ||
      asset.latestVersionId !== asset.id
    ) {
      return { ok: false, reason: "version_conflict" };
    }
    const storedForKey = async () => {
      const rows = await this.#orm
        .select()
        .from(speakerAssets)
        .where(
          and(
            eq(speakerAssets.organizationId, scope.organizationId),
            eq(speakerAssets.eventId, asset.eventId),
            eq(speakerAssets.creationIdempotencyKey, command.idempotencyKey),
          ),
        )
        .limit(2);
      return rows;
    };
    const existing = await storedForKey();
    if (existing.length > 0) {
      const replay = existing[0];
      return replay !== undefined &&
        replay.creationRequestDigest === command.requestDigest &&
        replay.versionFamilyId === asset.versionFamilyId &&
        replay.supersedesAssetId === command.expectedLatestAssetId &&
        replay.version === command.expectedLatestVersion + 1
        ? { ok: true, value: this.#asset(replay) }
        : { ok: false, reason: "version_conflict" };
    }

    const familyId = asset.versionFamilyId ?? asset.id;
    const predicate = `(
      EXISTS (
        SELECT 1
          FROM speaker_assets
         WHERE organization_id = ?
           AND event_id = ?
           AND creation_idempotency_key = ?
           AND creation_request_digest = ?
      )
      OR (
        NOT EXISTS (
          SELECT 1
            FROM speaker_assets
           WHERE organization_id = ?
             AND event_id = ?
             AND creation_idempotency_key = ?
        )
        AND EXISTS (
          SELECT 1
            FROM speaker_assets
           WHERE organization_id = ?
             AND event_id = ?
             AND version_family_id = ?
             AND id = ?
             AND version = ?
             AND state IN ('ready', 'rejected')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM speaker_assets
           WHERE organization_id = ?
             AND event_id = ?
             AND version_family_id = ?
             AND version > ?
        )
      )
    )`;
    const statements = [
      guard(this.#db, predicate, [
        scope.organizationId,
        asset.eventId,
        command.idempotencyKey,
        command.requestDigest,
        scope.organizationId,
        asset.eventId,
        command.idempotencyKey,
        scope.organizationId,
        asset.eventId,
        familyId,
        command.expectedLatestAssetId,
        command.expectedLatestVersion,
        scope.organizationId,
        asset.eventId,
        familyId,
        command.expectedLatestVersion,
      ]),
      this.#db
        .prepare(
          `INSERT INTO speaker_assets (
             id, organization_id, event_id, session_id, participant_id, task_id,
             kind, object_key, file_name, content_type, size_bytes,
             uploader_account_id, uploader_label, state, version, version_family_id,
             supersedes_asset_id, comment_thread_id, review_state, review_note,
             reviewed_at, reviewed_by, review_version, latest_version_id,
             current_version_id, approved_version_id, released_version_id,
             rejection_reason, created_at, finalized_at,
             creation_idempotency_key, creation_request_digest
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1
                FROM speaker_assets
               WHERE organization_id = ?
                 AND event_id = ?
                 AND creation_idempotency_key = ?
           )`,
        )
        .bind(
          asset.id,
          scope.organizationId,
          asset.eventId,
          asset.sessionId ?? null,
          asset.participantId,
          asset.taskId ?? null,
          asset.kind,
          asset.objectKey,
          asset.fileName,
          asset.contentType,
          asset.sizeBytes,
          asset.uploaderAccountId ?? null,
          asset.uploaderLabel ?? null,
          asset.state,
          asset.version,
          familyId,
          asset.supersedesAssetId,
          asset.commentThreadId ?? `asset-thread:${asset.id}`,
          asset.reviewState ?? null,
          asset.reviewNote ?? null,
          asset.reviewedAt ?? null,
          asset.reviewedBy ?? null,
          asset.reviewVersion ?? 0,
          asset.latestVersionId ?? null,
          asset.currentVersionId ?? null,
          asset.approvedVersionId ?? null,
          asset.releasedVersionId ?? null,
          asset.rejectionReason ?? null,
          asset.createdAt,
          asset.finalizedAt ?? null,
          command.idempotencyKey,
          command.requestDigest,
          scope.organizationId,
          asset.eventId,
          command.idempotencyKey,
        ),
    ];
    try {
      await this.#db.batch(statements);
    } catch (error) {
      const replay = await storedForKey();
      const row = replay[0];
      if (
        row !== undefined &&
        row.creationRequestDigest === command.requestDigest &&
        row.versionFamilyId === familyId &&
        row.supersedesAssetId === command.expectedLatestAssetId &&
        row.version === command.expectedLatestVersion + 1
      ) {
        return { ok: true, value: this.#asset(row) };
      }
      const family = (await this.listAssets(asset.eventId, [asset.participantId])).filter(
        (candidate) => (candidate.versionFamilyId ?? candidate.id) === familyId,
      );
      const expected = family.find((candidate) => candidate.id === command.expectedLatestAssetId);
      if (
        expected === undefined ||
        expected.version !== command.expectedLatestVersion ||
        (expected.state !== "ready" && expected.state !== "rejected") ||
        family.some((candidate) => (candidate.version ?? 0) > command.expectedLatestVersion)
      ) {
        return { ok: false, reason: "version_conflict" };
      }
      throw error;
    }
    const persisted = (await storedForKey())[0];
    return persisted !== undefined &&
      persisted.creationRequestDigest === command.requestDigest &&
      persisted.versionFamilyId === familyId &&
      persisted.supersedesAssetId === command.expectedLatestAssetId &&
      persisted.version === command.expectedLatestVersion + 1
      ? { ok: true, value: this.#asset(persisted) }
      : { ok: false, reason: "version_conflict" };
  }

  async getAsset(eventId: string, assetId: string): Promise<SpeakerAsset | null> {
    const scope = await this.#eventScope(eventId);
    if (scope === null) return null;
    const rows = await this.#orm
      .select()
      .from(speakerAssets)
      .where(
        and(
          eq(speakerAssets.organizationId, scope.organizationId),
          eq(speakerAssets.eventId, eventId),
          eq(speakerAssets.id, assetId),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : this.#asset(rows[0]);
  }

  async listAssets(eventId: string, participantIds: readonly string[]): Promise<SpeakerAsset[]> {
    if (participantIds.length === 0) return [];
    const scope = await this.#eventScope(eventId);
    if (scope === null) return [];
    const rows = await this.#orm
      .select()
      .from(speakerAssets)
      .where(
        and(
          eq(speakerAssets.organizationId, scope.organizationId),
          eq(speakerAssets.eventId, eventId),
          inArray(speakerAssets.participantId, [...new Set(participantIds)]),
        ),
      );
    return rows.map((row) => this.#asset(row));
  }

  async finalizeAsset(
    command: FinalizeSpeakerAssetCommand,
  ): Promise<RepositoryResult<SpeakerAsset>> {
    const current = await this.getAsset(command.eventId, command.assetId);
    if (current === null) return { ok: false, reason: "not_found" };
    if (current.state !== "pending_upload") return { ok: false, reason: "invalid_state" };
    const scope = await this.#eventScope(command.eventId);
    if (scope === null) return { ok: false, reason: "not_found" };
    const statements: D1PreparedStatement[] = [
      updateGuard(
        this.#db,
        "speaker_assets",
        "organization_id = ? AND event_id = ? AND id = ? AND state = 'pending_upload'",
        [scope.organizationId, command.eventId, command.assetId],
      ),
      updateGuard(
        this.#db,
        "speaker_assets",
        "organization_id = ? AND event_id = ? AND version_family_id = ?",
        [scope.organizationId, command.eventId, current.versionFamilyId ?? current.id],
      ),
      this.#db
        .prepare(
          `UPDATE speaker_assets
              SET state = CASE WHEN id = ? THEN ? ELSE state END,
                  finalized_at = CASE WHEN id = ? THEN ? ELSE finalized_at END,
                  rejection_reason = CASE WHEN id = ? THEN ? ELSE rejection_reason END,
                  latest_version_id = ?,
                  current_version_id = ?
            WHERE organization_id = ? AND event_id = ? AND version_family_id = ?`,
        )
        .bind(
          command.assetId,
          command.state,
          command.assetId,
          command.finalizedAt,
          command.assetId,
          command.rejectionReason ?? null,
          command.latestVersionId,
          command.currentVersionId ?? null,
          scope.organizationId,
          command.eventId,
          current.versionFamilyId ?? current.id,
        ),
    ];
    if (command.state === "rejected") {
      statements.push(
        privateObjectCleanupOutboxStatement(
          this.#db,
          {
            kind: "private_object_delete",
            source: "speaker",
            tenantId: scope.organizationId,
            eventId: command.eventId,
            assetId: command.assetId,
            objectKey: current.objectKey,
          },
          command.finalizedAt,
        ) as D1PreparedStatement,
      );
    }
    try {
      await this.#db.batch(statements);
    } catch {
      return { ok: false, reason: "version_conflict" };
    }
    const value = await this.getAsset(command.eventId, command.assetId);
    if (value === null) return { ok: false, reason: "not_found" };
    if (
      value.state !== command.state ||
      value.finalizedAt !== command.finalizedAt ||
      value.rejectionReason !== command.rejectionReason ||
      value.latestVersionId !== command.latestVersionId ||
      value.currentVersionId !== (command.currentVersionId ?? current.currentVersionId)
    ) {
      return { ok: false, reason: "version_conflict" };
    }
    return { ok: true, value };
  }

  async reviewAsset(command: SpeakerAssetReviewCommand): Promise<RepositoryResult<SpeakerAsset>> {
    const current = await this.getAsset(command.eventId, command.assetId);
    if (current === null) return { ok: false, reason: "not_found" };
    if (
      current.state !== "ready" ||
      (current.reviewVersion ?? 0) !== command.expectedVersion ||
      current.currentVersionId !== current.id
    )
      return { ok: false, reason: "version_conflict" };
    const scope = await this.#eventScope(command.eventId);
    if (scope === null) return { ok: false, reason: "not_found" };
    if (command.returnTask !== undefined) {
      const task = await this.getTask(command.eventId, command.returnTask.taskId);
      if (task === null) return { ok: false, reason: "not_found" };
      if (
        command.returnTask.eventId !== command.eventId ||
        command.returnTask.baselineAssetId !== command.assetId ||
        (command.returnTask.transition !== undefined &&
          (command.returnTask.transition.eventId !== command.eventId ||
            command.returnTask.transition.taskId !== command.returnTask.taskId ||
            command.returnTask.transition.participantId !== task.participantId))
      ) {
        return { ok: false, reason: "invalid_state" };
      }
      if (
        task.version !== command.returnTask.expectedVersion ||
        task.status !== command.returnTask.fromStatus
      ) {
        return { ok: false, reason: "version_conflict" };
      }
    }
    const statements: D1PreparedStatement[] = [
      updateGuard(
        this.#db,
        "speaker_assets",
        "organization_id = ? AND event_id = ? AND id = ? AND state = 'ready' AND review_version = ? AND current_version_id = id",
        [scope.organizationId, command.eventId, command.assetId, command.expectedVersion],
      ),
      updateGuard(
        this.#db,
        "speaker_assets",
        "organization_id = ? AND event_id = ? AND version_family_id = ?",
        [scope.organizationId, command.eventId, current.versionFamilyId ?? current.id],
      ),
      this.#db
        .prepare(
          `UPDATE speaker_assets
              SET review_state = ?, review_note = ?, reviewed_at = ?, reviewed_by = ?,
                  review_version = review_version + 1
            WHERE organization_id = ? AND event_id = ? AND id = ? AND state = 'ready'
              AND review_version = ? AND current_version_id = id`,
        )
        .bind(
          command.state,
          command.note ?? null,
          command.reviewedAt,
          command.reviewedBy,
          scope.organizationId,
          command.eventId,
          command.assetId,
          command.expectedVersion,
        ),
      this.#db
        .prepare(
          `UPDATE speaker_assets
              SET approved_version_id = CASE
                    WHEN ? = 'approved' THEN ?
                    WHEN approved_version_id = ? THEN NULL
                    ELSE approved_version_id
                  END,
                  released_version_id = CASE WHEN ? = 1 THEN ? ELSE released_version_id END
            WHERE organization_id = ? AND event_id = ? AND version_family_id = ?
              AND EXISTS (
                SELECT 1
                  FROM speaker_assets AS reviewed
                 WHERE reviewed.organization_id = ? AND reviewed.event_id = ?
                   AND reviewed.id = ? AND reviewed.review_version = ?
                   AND reviewed.review_state = ? AND reviewed.reviewed_at = ?
                   AND reviewed.reviewed_by = ?
              )`,
        )
        .bind(
          command.state,
          command.assetId,
          command.assetId,
          command.release ? 1 : 0,
          command.assetId,
          scope.organizationId,
          command.eventId,
          current.versionFamilyId ?? current.id,
          scope.organizationId,
          command.eventId,
          command.assetId,
          command.expectedVersion + 1,
          command.state,
          command.reviewedAt,
          command.reviewedBy,
        ),
    ];
    if (command.returnTask !== undefined) {
      statements.push(
        updateGuard(
          this.#db,
          "speaker_tasks",
          "organization_id = ? AND event_id = ? AND id = ? AND version = ? AND status = ?",
          [
            scope.organizationId,
            command.eventId,
            command.returnTask.taskId,
            command.returnTask.expectedVersion,
            command.returnTask.fromStatus,
          ],
        ),
        this.#db
          .prepare(
            "UPDATE speaker_tasks SET status = ?, replacement_baseline_asset_id = ?, version = version + 1, updated_at = ? WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ? AND status = ?",
          )
          .bind(
            command.returnTask.toStatus,
            command.returnTask.baselineAssetId,
            command.returnTask.transition?.occurredAt ?? command.reviewedAt,
            scope.organizationId,
            command.eventId,
            command.returnTask.taskId,
            command.returnTask.expectedVersion,
            command.returnTask.fromStatus,
          ),
        ...(command.returnTask.transition === undefined
          ? []
          : [
              this.#db
                .prepare(
                  "INSERT INTO speaker_task_transitions (id, organization_id, event_id, task_id, participant_id, actor_account_id, from_status, to_status, note, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(
                  command.returnTask.transition.id,
                  scope.organizationId,
                  command.eventId,
                  command.returnTask.taskId,
                  command.returnTask.transition.participantId,
                  command.returnTask.transition.actorAccountId,
                  command.returnTask.fromStatus,
                  command.returnTask.toStatus,
                  command.returnTask.transition.note ?? null,
                  command.returnTask.transition.occurredAt,
                ),
            ]),
      );
    }
    if (command.audit !== undefined) statements.push(this.#auditStatement(command.audit));
    try {
      await this.#db.batch(statements);
    } catch {
      return { ok: false, reason: "version_conflict" };
    }
    const value = await this.getAsset(command.eventId, command.assetId);
    if (value === null) return { ok: false, reason: "not_found" };
    const expectedApprovedVersionId =
      command.state === "approved"
        ? command.assetId
        : current.approvedVersionId === command.assetId
          ? undefined
          : current.approvedVersionId;
    const expectedReleasedVersionId = command.release ? command.assetId : current.releasedVersionId;
    if (
      value.reviewState !== command.state ||
      value.reviewNote !== command.note ||
      value.reviewedAt !== command.reviewedAt ||
      value.reviewedBy !== command.reviewedBy ||
      value.reviewVersion !== command.expectedVersion + 1 ||
      value.approvedVersionId !== expectedApprovedVersionId ||
      value.releasedVersionId !== expectedReleasedVersionId
    ) {
      return { ok: false, reason: "version_conflict" };
    }
    if (command.returnTask !== undefined) {
      const task = await this.getTask(command.eventId, command.returnTask.taskId);
      if (
        task === null ||
        task.status !== command.returnTask.toStatus ||
        task.version !== command.returnTask.expectedVersion + 1
      ) {
        return { ok: false, reason: "version_conflict" };
      }
    }
    return { ok: true, value };
  }
  async updateAssetReview(
    command: SpeakerAssetReviewCommand,
  ): Promise<RepositoryResult<SpeakerAsset>> {
    return this.reviewAsset(command);
  }

  async listAssetHistory(eventId: string, versionFamilyId: string): Promise<SpeakerAsset[]> {
    const scope = await this.#eventScope(eventId);
    if (scope === null) return [];
    const rows = await this.#db
      .prepare(
        `SELECT *
           FROM speaker_assets
          WHERE organization_id = ? AND event_id = ? AND version_family_id = ?
          ORDER BY version ASC, created_at ASC, id ASC`,
      )
      .bind(scope.organizationId, eventId, versionFamilyId)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map((row) => this.#assetRecord(row));
  }

  async listAssetComments(eventId: string, assetId: string): Promise<SpeakerAssetComment[]> {
    const scope = await this.#eventScope(eventId);
    if (scope === null) return [];
    const rows = await this.#db
      .prepare(
        `SELECT id, event_id, asset_id, version_id, body, author_label, version, created_at, updated_at
           FROM speaker_asset_comments
          WHERE organization_id = ? AND event_id = ? AND asset_id = ? AND version_id = ?
            AND author_label <> ?
          ORDER BY created_at ASC, version ASC, id ASC`,
      )
      .bind(scope.organizationId, eventId, assetId, assetId, auditLabel)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map((row) => this.#assetCommentRecord(row));
  }

  async createAssetComment(comment: SpeakerAssetComment): Promise<SpeakerAssetComment> {
    const scope = await this.#eventScope(comment.eventId);
    if (scope === null || comment.versionId !== comment.assetId) {
      throw new Error("The version-specific speaker asset does not exist.");
    }
    const asset = await this.#db
      .prepare(
        `SELECT id
           FROM speaker_assets
          WHERE organization_id = ? AND event_id = ? AND id = ?
          LIMIT 1`,
      )
      .bind(scope.organizationId, comment.eventId, comment.assetId)
      .first<Record<string, unknown>>();
    if (asset === null) throw new Error("The version-specific speaker asset does not exist.");
    await this.#db
      .prepare(
        `INSERT INTO speaker_asset_comments
           (id, organization_id, event_id, asset_id, version_id, body, author_label,
            author_account_id, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        comment.id,
        scope.organizationId,
        comment.eventId,
        comment.assetId,
        comment.versionId,
        comment.body,
        comment.authorLabel,
        comment.authorAccountId ?? null,
        comment.version ?? 1,
        comment.createdAt,
        comment.updatedAt ?? comment.createdAt,
      )
      .run();
    return structuredClone(comment);
  }

  async listEventResources(eventId: string): Promise<SpeakerEventResource[]> {
    const scope = await this.#eventScope(eventId);
    if (scope === null) return [];
    const rows = await this.#db
      .prepare(
        `SELECT id, event_id, title, summary, html, url, sort_order, updated_at
           FROM speaker_event_resources
          WHERE organization_id = ? AND event_id = ? AND status = 'published'
          ORDER BY sort_order ASC, id ASC`,
      )
      .bind(scope.organizationId, eventId)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map((row) => this.#resourceRecord(row));
  }

  async listWikiPages(eventId: string): Promise<SpeakerWikiPage[]> {
    const scope = await this.#eventScope(eventId);
    if (scope === null) return [];
    const rows = await this.#db
      .prepare(
        `SELECT id, event_id, title, slug, summary, html, url, sort_order, updated_at
           FROM speaker_wiki_pages
          WHERE organization_id = ? AND event_id = ? AND status = 'published'
          ORDER BY sort_order ASC, id ASC`,
      )
      .bind(scope.organizationId, eventId)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map((row) => ({
      ...this.#resourceRecord(row),
      slug: String(row.slug),
    }));
  }

  async appendAssetAudit(entry: SpeakerAssetAuditEntry): Promise<void> {
    await this.#db.batch([this.#auditStatement(entry)]);
  }

  async listAssetAudit(eventId: string, assetId: string): Promise<SpeakerAssetAuditEntry[]> {
    const rows = await this.#orm
      .select()
      .from(speakerAssetComments)
      .where(
        and(
          eq(speakerAssetComments.eventId, eventId),
          eq(speakerAssetComments.assetId, assetId),
          eq(speakerAssetComments.authorLabel, auditLabel),
        ),
      );
    return rows
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((row) => JSON.parse(row.body) as SpeakerAssetAuditEntry);
  }

  async #saveTask(
    command: SpeakerTaskRepositoryCommand,
    create: boolean,
  ): Promise<RepositoryResult<SpeakerTask>> {
    if (
      (create && command.expectedVersion !== null) ||
      (!create && command.expectedVersion === null)
    )
      return { ok: false, reason: "version_conflict" };
    const scope = await this.#eventScope(command.task.eventId);
    if (scope === null) return { ok: false, reason: "not_found" };
    const task = command.task;
    const sessionId = task.subject.type === "session" ? task.subject.sessionId : null;
    const statements: D1PreparedStatement[] = [];
    if (create) {
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO speaker_tasks (id, organization_id, event_id, session_id, participant_id, type, owner, title, description, instructions, status, due_at, allowed_mime_types_json, max_bytes, accepted_asset_kinds_json, replacement_baseline_asset_id, version, created_at, updated_at)
         ${
           command.decisionFence === undefined
             ? "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
             : `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                WHERE EXISTS (
                  SELECT 1
                  FROM evaluation_decisions
                  WHERE organization_id = ?
                    AND event_id = ?
                    AND plan_id = ?
                    AND submission_id = ?
                    AND version = ?
                    AND status = ?
                )`
}`,
          )
          .bind(
            task.id,
            scope.organizationId,
            task.eventId,
            sessionId,
            task.participantId,
            task.type,
            task.owner,
            task.title,
            task.description ?? "",
            task.instructions ?? "",
            task.status,
            task.dueAt ?? task.dueDate ?? null,
            json(task.allowedMimeTypes ?? []),
            task.maxBytes ?? task.maxSizeBytes ?? null,
            json(task.acceptedAssetKinds ?? []),
            task.replacementBaselineAssetId ?? null,
            task.version,
            task.updatedAt,
            task.updatedAt,
            ...(command.decisionFence === undefined
              ? []
              : [
                  command.decisionFence.tenantId,
                  command.decisionFence.eventId,
                  command.decisionFence.planId,
                  command.decisionFence.submissionId,
                  command.decisionFence.version,
                  command.decisionFence.status,
                ]),
          ),
      );
    } else {
      statements.push(
        this.#db
          .prepare(
            `UPDATE speaker_tasks SET session_id = ?, participant_id = ?, type = ?, owner = ?, title = ?, description = ?, instructions = ?, status = ?, due_at = ?, allowed_mime_types_json = ?, max_bytes = ?, accepted_asset_kinds_json = ?, replacement_baseline_asset_id = ?, version = ?, updated_at = ?
         WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ?`,
          )
          .bind(
            sessionId,
            task.participantId,
            task.type,
            task.owner,
            task.title,
            task.description ?? "",
            task.instructions ?? "",
            task.status,
            task.dueAt ?? task.dueDate ?? null,
            json(task.allowedMimeTypes ?? []),
            task.maxBytes ?? task.maxSizeBytes ?? null,
            json(task.acceptedAssetKinds ?? []),
            task.replacementBaselineAssetId ?? null,
            task.version,
            task.updatedAt,
            scope.organizationId,
            task.eventId,
            task.id,
            command.expectedVersion,
          ),
      );
      statements.push(
        this.#db
          .prepare(
            `DELETE FROM speaker_task_dependencies
              WHERE organization_id = ? AND event_id = ? AND task_id = ?
                AND EXISTS (
                  SELECT 1 FROM speaker_tasks
                   WHERE organization_id = ? AND event_id = ? AND id = ?
                     AND version = ? AND updated_at = ?
                )`,
          )
          .bind(
            scope.organizationId,
            task.eventId,
            task.id,
            scope.organizationId,
            task.eventId,
            task.id,
            task.version,
            task.updatedAt,
          ),
        this.#db
          .prepare(
            `DELETE FROM speaker_task_reminder_offsets
              WHERE organization_id = ? AND event_id = ? AND task_id = ?
                AND EXISTS (
                  SELECT 1 FROM speaker_tasks
                   WHERE organization_id = ? AND event_id = ? AND id = ?
                     AND version = ? AND updated_at = ?
                )`,
          )
          .bind(
            scope.organizationId,
            task.eventId,
            task.id,
            scope.organizationId,
            task.eventId,
            task.id,
            task.version,
            task.updatedAt,
          ),
      );
    }
    for (const dependencyId of task.dependencyIds)
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO speaker_task_dependencies
              (organization_id, event_id, task_id, dependency_task_id)
             SELECT ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM speaker_tasks
                 WHERE organization_id = ? AND event_id = ? AND id = ?
                   AND version = ? AND updated_at = ?
              )`,
          )
          .bind(
            scope.organizationId,
            task.eventId,
            task.id,
            dependencyId,
            scope.organizationId,
            task.eventId,
            task.id,
            task.version,
            task.updatedAt,
          ),
      );
    for (const offset of task.reminderOffsetsMinutes)
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO speaker_task_reminder_offsets
              (organization_id, event_id, task_id, offset_minutes)
             SELECT ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM speaker_tasks
                 WHERE organization_id = ? AND event_id = ? AND id = ?
                   AND version = ? AND updated_at = ?
              )`,
          )
          .bind(
            scope.organizationId,
            task.eventId,
            task.id,
            offset,
            scope.organizationId,
            task.eventId,
            task.id,
            task.version,
            task.updatedAt,
          ),
      );
    if (command.audit !== undefined) {
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO audit_events
              (id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,details_json,occurred_at)
             SELECT ?,?,?,?,?,?,?,?,?
              WHERE EXISTS (
                SELECT 1 FROM speaker_tasks
                 WHERE organization_id = ? AND event_id = ? AND id = ?
                   AND version = ? AND updated_at = ?
              )`,
          )
          .bind(
            command.audit.id,
            scope.organizationId,
            "user",
            command.actorAccountId,
            command.audit.action,
            "speaker_task",
            task.id,
            json({
              eventId: task.eventId,
              previousVersion: command.expectedVersion,
              version: task.version,
              previousReminderOffsetsMinutes: command.audit.previousReminderOffsetsMinutes,
              reminderOffsetsMinutes: task.reminderOffsetsMinutes,
            }),
            task.updatedAt,
            scope.organizationId,
            task.eventId,
            task.id,
            task.version,
            task.updatedAt,
          ),
      );
    }
    try {
      const result = await this.#db.batch(statements);
      if ((result[0]?.meta?.changes ?? 0) !== 1) return { ok: false, reason: "version_conflict" };
    } catch {
      return { ok: false, reason: "version_conflict" };
    }
    const value = await this.getTask(task.eventId, task.id);
    return value === null ? { ok: false, reason: "not_found" } : { ok: true, value };
  }

  async #eventScope(eventId: string): Promise<EventScope | null> {
    const rows = await this.#orm
      .select({ organizationId: events.organizationId, eventId: events.id })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(2);
    return rows.length === 1 ? (rows[0] ?? null) : null;
  }

  async #task(row: typeof speakerTasks.$inferSelect): Promise<SpeakerTask> {
    const [dependencies, offsets] = await Promise.all([
      this.#orm
        .select()
        .from(speakerTaskDependencies)
        .where(
          and(
            eq(speakerTaskDependencies.organizationId, row.organizationId),
            eq(speakerTaskDependencies.eventId, row.eventId),
            eq(speakerTaskDependencies.taskId, row.id),
          ),
        ),
      this.#orm
        .select()
        .from(speakerTaskReminderOffsets)
        .where(
          and(
            eq(speakerTaskReminderOffsets.organizationId, row.organizationId),
            eq(speakerTaskReminderOffsets.eventId, row.eventId),
            eq(speakerTaskReminderOffsets.taskId, row.id),
          ),
        ),
    ]);
    return {
      id: row.id,
      eventId: row.eventId,
      participantId: row.participantId,
      subject:
        row.sessionId === null
          ? { type: "participant", participantId: row.participantId }
          : { type: "session", participantId: row.participantId, sessionId: row.sessionId },
      type: row.type,
      owner: row.owner,
      title: row.title,
      ...(row.description.length === 0 ? {} : { description: row.description }),
      ...(row.instructions.length === 0 ? {} : { instructions: row.instructions }),
      status: row.status,
      ...(row.dueAt === null ? {} : { dueAt: row.dueAt, dueDate: row.dueAt }),
      dependencyIds: dependencies.map((dependency) => dependency.dependencyTaskId),
      reminderOffsetsMinutes: offsets.map((offset) => offset.offsetMinutes),
      allowedMimeTypes: row.allowedMimeTypesJson as string[],
      ...(row.maxBytes === null ? {} : { maxBytes: row.maxBytes, maxSizeBytes: row.maxBytes }),
      acceptedAssetKinds: row.acceptedAssetKindsJson as SpeakerTask["acceptedAssetKinds"],
      ...(row.replacementBaselineAssetId === null
        ? {}
        : { replacementBaselineAssetId: row.replacementBaselineAssetId }),
      version: row.version,
      updatedAt: row.updatedAt,
    } as SpeakerTask;
  }

  #profile(row: typeof speakerProfiles.$inferSelect): SpeakerProfile {
    return {
      id: row.id,
      eventId: row.eventId,
      participantId: row.participantId,
      displayName: row.displayName,
      ...(row.email === null ? {} : { email: row.email }),
      jobTitle: row.jobTitle,
      company: row.company,
      status: row.status,
      biography: row.biography,
      socialLinks: row.socialLinksJson as Record<string, string>,
      ...(row.headshotAssetId === null ? {} : { headshotAssetId: row.headshotAssetId }),
      ...(row.sourceType === null
        ? {}
        : { sourceType: row.sourceType as NonNullable<SpeakerProfile["sourceType"]> }),
      ...(row.sourceId === null ? {} : { sourceId: row.sourceId }),
      travelLogistics: {
        travelRequired: row.travelRequired,
        arrivalAt: row.arrivalAt,
        departureAt: row.departureAt,
        accommodation: row.accommodation,
        dietaryRequirements: row.dietaryRequirements,
        accessibilityNeeds: row.accessibilityNeeds,
        travelNotes: row.travelNotes,
      },
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }

  #storedJson(value: unknown): unknown {
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  #resourceRecord(row: Record<string, unknown>): SpeakerEventResource {
    return {
      id: String(row.id),
      eventId: String(row.event_id),
      title: String(row.title),
      ...(row.summary === null || row.summary === undefined
        ? {}
        : { summary: String(row.summary) }),
      ...(row.html === null || row.html === undefined ? {} : { html: String(row.html) }),
      ...(row.url === null || row.url === undefined ? {} : { url: String(row.url) }),
      order: Number(row.sort_order),
      updatedAt: String(row.updated_at),
    };
  }

  #assetCommentRecord(row: Record<string, unknown>): SpeakerAssetComment {
    return {
      id: String(row.id),
      eventId: String(row.event_id),
      assetId: String(row.asset_id),
      versionId: String(row.version_id),
      body: String(row.body),
      authorLabel: String(row.author_label),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      version: Number(row.version),
    };
  }

  #assetRecord(row: Record<string, unknown>): SpeakerAsset {
    return {
      id: String(row.id),
      tenantId: String(row.organization_id),
      eventId: String(row.event_id),
      ...(row.session_id === null || row.session_id === undefined
        ? {}
        : { sessionId: String(row.session_id) }),
      participantId: String(row.participant_id),
      ...(row.task_id === null || row.task_id === undefined ? {} : { taskId: String(row.task_id) }),
      kind: String(row.kind) as SpeakerAsset["kind"],
      objectKey: String(row.object_key),
      fileName: String(row.file_name),
      contentType: String(row.content_type),
      sizeBytes: Number(row.size_bytes),
      ...(row.uploader_account_id === null || row.uploader_account_id === undefined
        ? {}
        : { uploaderAccountId: String(row.uploader_account_id) }),
      ...(row.uploader_label === null || row.uploader_label === undefined
        ? {}
        : { uploaderLabel: String(row.uploader_label) }),
      state: String(row.state) as SpeakerAsset["state"],
      createdAt: String(row.created_at),
      version: Number(row.version),
      versionFamilyId: String(row.version_family_id),
      ...(row.supersedes_asset_id === null || row.supersedes_asset_id === undefined
        ? {}
        : { supersedesAssetId: String(row.supersedes_asset_id) }),
      commentThreadId: String(row.comment_thread_id),
      versionId: String(row.id),
      ...(row.review_state === null || row.review_state === undefined
        ? {}
        : { reviewState: String(row.review_state) as NonNullable<SpeakerAsset["reviewState"]> }),
      ...(row.review_note === null || row.review_note === undefined
        ? {}
        : { reviewNote: String(row.review_note) }),
      ...(row.reviewed_at === null || row.reviewed_at === undefined
        ? {}
        : { reviewedAt: String(row.reviewed_at) }),
      ...(row.reviewed_by === null || row.reviewed_by === undefined
        ? {}
        : { reviewedBy: String(row.reviewed_by) }),
      reviewVersion: Number(row.review_version),
      ...(row.latest_version_id === null || row.latest_version_id === undefined
        ? {}
        : { latestVersionId: String(row.latest_version_id) }),
      ...(row.current_version_id === null || row.current_version_id === undefined
        ? {}
        : { currentVersionId: String(row.current_version_id) }),
      ...(row.approved_version_id === null || row.approved_version_id === undefined
        ? {}
        : { approvedVersionId: String(row.approved_version_id) }),
      ...(row.released_version_id === null || row.released_version_id === undefined
        ? {}
        : { releasedVersionId: String(row.released_version_id) }),
      ...(row.rejection_reason === null || row.rejection_reason === undefined
        ? {}
        : { rejectionReason: String(row.rejection_reason) }),
      ...(row.finalized_at === null || row.finalized_at === undefined
        ? {}
        : { finalizedAt: String(row.finalized_at) }),
    };
  }

  #asset(row: typeof speakerAssets.$inferSelect): SpeakerAsset {
    return {
      id: row.id,
      tenantId: row.organizationId,
      eventId: row.eventId,
      ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
      participantId: row.participantId,
      ...(row.taskId === null ? {} : { taskId: row.taskId }),
      kind: row.kind,
      objectKey: row.objectKey,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      ...(row.uploaderAccountId === null ? {} : { uploaderAccountId: row.uploaderAccountId }),
      ...(row.uploaderLabel === null ? {} : { uploaderLabel: row.uploaderLabel }),
      state: row.state,
      createdAt: row.createdAt,
      version: row.version,
      versionFamilyId: row.versionFamilyId,
      ...(row.supersedesAssetId === null ? {} : { supersedesAssetId: row.supersedesAssetId }),
      commentThreadId: row.commentThreadId,
      versionId: row.id,
      ...(row.reviewState === null ? {} : { reviewState: row.reviewState }),
      ...(row.reviewNote === null ? {} : { reviewNote: row.reviewNote }),
      ...(row.reviewedAt === null ? {} : { reviewedAt: row.reviewedAt }),
      ...(row.reviewedBy === null ? {} : { reviewedBy: row.reviewedBy }),
      reviewVersion: row.reviewVersion,
      ...(row.latestVersionId === null ? {} : { latestVersionId: row.latestVersionId }),
      ...(row.currentVersionId === null ? {} : { currentVersionId: row.currentVersionId }),
      ...(row.approvedVersionId === null ? {} : { approvedVersionId: row.approvedVersionId }),
      ...(row.releasedVersionId === null ? {} : { releasedVersionId: row.releasedVersionId }),
      ...(row.rejectionReason === null ? {} : { rejectionReason: row.rejectionReason }),
      ...(row.finalizedAt === null ? {} : { finalizedAt: row.finalizedAt }),
    } as SpeakerAsset;
  }

  #auditStatement(entry: SpeakerAssetAuditEntry): D1PreparedStatement {
    return this.#db
      .prepare(
        "INSERT OR IGNORE INTO speaker_asset_comments (id, organization_id, event_id, asset_id, version_id, body, author_label, author_account_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        entry.id,
        entry.organizationId,
        entry.eventId,
        entry.assetId,
        entry.assetId,
        json(entry),
        auditLabel,
        entry.actorAccountId,
        Math.max(1, entry.version),
        entry.occurredAt,
        entry.occurredAt,
      );
  }
}
