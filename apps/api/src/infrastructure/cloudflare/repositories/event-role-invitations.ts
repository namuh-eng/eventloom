import type {
  CreateEventRoleInvitationInput,
  EventRoleInvitation,
  EventRoleInvitationRepository,
  EventRoleInvitationTransitionInput,
  ReconcileEventRoleInvitationsInput,
  RevokeEventReviewerInvitationInput,
  RevokeReviewerInvitationsInput,
} from "../../../features/event-invitations/types";
import { EventRoleInvitationRepositoryConflictError } from "../../../features/event-invitations/types";

interface InvitationRow {
  readonly id: string;
  readonly organization_id: string;
  readonly organization_name: string | null;
  readonly event_id: string;
  readonly event_name: string;
  readonly role: "reviewer" | "speaker";
  readonly recipient_user_id: string;
  readonly normalized_email: string;
  readonly participant_id: string | null;
  readonly status: "pending" | "accepted" | "declined" | "revoked";
  readonly creation_idempotency_key: string;
  readonly invited_by_actor_type: "user" | "system";
  readonly invited_by_actor_id: string | null;
  readonly invited_at: string;
  readonly accepted_by_user_id: string | null;
  readonly accepted_at: string | null;
  readonly declined_by_user_id: string | null;
  readonly declined_at: string | null;
  readonly revoked_by_actor_type: "user" | "system" | null;
  readonly revoked_by_actor_id: string | null;
  readonly revoked_at: string | null;
  readonly version: number;
  readonly updated_at: string;
}

interface MutationResult {
  readonly meta?: { readonly changes?: number };
}

const SELECT = `SELECT invitation.id, invitation.organization_id, organization.name AS organization_name,
  invitation.event_id, event.name AS event_name, invitation.role, invitation.recipient_user_id,
  invitation.normalized_email, invitation.participant_id, invitation.status,
  invitation.creation_idempotency_key, invitation.invited_by_actor_type,
  invitation.invited_by_actor_id, invitation.invited_at, invitation.accepted_by_user_id,
  invitation.accepted_at, invitation.declined_by_user_id, invitation.declined_at,
  invitation.revoked_by_actor_type, invitation.revoked_by_actor_id, invitation.revoked_at,
  invitation.version, invitation.updated_at
 FROM event_role_invitations invitation
 JOIN events event
   ON event.organization_id = invitation.organization_id AND event.id = invitation.event_id
 JOIN organizations organization ON organization.organization_id = invitation.organization_id`;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function invitation(row: InvitationRow): EventRoleInvitation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    eventId: row.event_id,
    eventName: row.event_name,
    role: row.role,
    recipientUserId: row.recipient_user_id,
    recipientEmail: row.normalized_email,
    normalizedEmail: row.normalized_email,
    participantId: row.participant_id,
    status: row.status,
    creationIdempotencyKey: row.creation_idempotency_key,
    invitedByActorType: row.invited_by_actor_type,
    invitedByActorId: row.invited_by_actor_id,
    invitedAt: row.invited_at,
    createdBy: row.invited_by_actor_id,
    createdAt: row.invited_at,
    acceptedByUserId: row.accepted_by_user_id,
    acceptedAt: row.accepted_at,
    declinedByUserId: row.declined_by_user_id,
    declinedAt: row.declined_at,
    revokedByActorType: row.revoked_by_actor_type,
    revokedByActorId: row.revoked_by_actor_id,
    revokedAt: row.revoked_at,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function changes(value: unknown): number {
  return (value as MutationResult | undefined)?.meta?.changes ?? 0;
}

function compatibleReplay(
  current: EventRoleInvitation,
  input: CreateEventRoleInvitationInput,
): boolean {
  return (
    current.role === input.role &&
    current.recipientUserId === input.recipientUserId &&
    current.normalizedEmail === normalizeEmail(input.normalizedEmail) &&
    current.participantId === (input.participantId ?? null)
  );
}

function revokerId(input: RevokeReviewerInvitationsInput): string | null {
  const actorId = input.revokedByActorId?.trim() || null;
  if (input.revokedByActorType === "user" && actorId === null) {
    throw new Error("A user revoker requires an actor id.");
  }
  if (input.revokedByActorType === "system" && actorId !== null) {
    throw new Error("A system revoker cannot have an actor id.");
  }
  return actorId;
}

export class D1EventRoleInvitationRepository implements EventRoleInvitationRepository {
  constructor(private readonly database: D1Database) {}

  async create(input: CreateEventRoleInvitationInput): Promise<EventRoleInvitation> {
    const replay = await this.findByCreationKey(
      input.organizationId,
      input.eventId,
      input.creationIdempotencyKey,
    );
    if (replay !== null) {
      if (!compatibleReplay(replay, input)) {
        throw new EventRoleInvitationRepositoryConflictError(
          "The invitation idempotency key is already bound to another recipient.",
        );
      }
      return replay;
    }
    const live = await this.findLiveForBinding(input);
    if (live !== null) {
      if (live.status === "accepted" || compatibleReplay(live, input)) return live;
      throw new EventRoleInvitationRepositoryConflictError(
        "A live invitation is already bound to another recipient email.",
      );
    }
    try {
      const statement = this.database
        .prepare(
          `INSERT INTO event_role_invitations
            (id, organization_id, event_id, role, recipient_user_id, normalized_email,
             participant_id, status, creation_idempotency_key, invited_by_actor_type,
             invited_by_actor_id, invited_at, accepted_by_user_id, accepted_at,
             declined_by_user_id, declined_at, revoked_by_actor_type, revoked_by_actor_id,
             revoked_at, version, updated_at)
           ${
             input.decisionFence === undefined
               ? "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?)"
               : `SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                         NULL, NULL, NULL, 1, ?
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
          input.id,
          input.organizationId,
          input.eventId,
          input.role,
          input.recipientUserId,
          normalizeEmail(input.normalizedEmail),
          input.participantId ?? null,
          input.creationIdempotencyKey,
          input.invitedByActorType,
          input.invitedByActorId ?? null,
          input.invitedAt,
          input.invitedAt,
          ...(input.decisionFence === undefined
            ? []
            : [
                input.decisionFence.tenantId,
                input.decisionFence.eventId,
                input.decisionFence.planId,
                input.decisionFence.submissionId,
                input.decisionFence.version,
                input.decisionFence.status,
              ]),
        );
      const result = await statement.run();
      if (input.decisionFence !== undefined && result.meta.changes !== 1) {
        throw new EventRoleInvitationRepositoryConflictError("The decision is no longer current.");
      }
    } catch (error) {
      const concurrent = await this.findByCreationKey(
        input.organizationId,
        input.eventId,
        input.creationIdempotencyKey,
      );
      if (concurrent !== null && compatibleReplay(concurrent, input)) return concurrent;
      const live = await this.findLiveForBinding(input);
      if (live !== null && (live.status === "accepted" || compatibleReplay(live, input))) {
        return live;
      }
      throw error;
    }
    const created = await this.findById(input.id);
    if (created === null) throw new Error("The event invitation insert did not persist.");
    return created;
  }

  async reconcileForVerifiedAccount(input: ReconcileEventRoleInvitationsInput): Promise<void> {
    const email = normalizeEmail(input.normalizedEmail);
    const reviewerInvitations = this.database
      .prepare(
        `INSERT OR IGNORE INTO event_role_invitations
          (id, organization_id, event_id, role, recipient_user_id, normalized_email,
           participant_id, status, creation_idempotency_key, invited_by_actor_type,
           invited_by_actor_id, invited_at, accepted_by_user_id, accepted_at,
           declined_by_user_id, declined_at, revoked_by_actor_type, revoked_by_actor_id,
           revoked_at, version, updated_at)
         SELECT DISTINCT
                'reconciled:reviewer:' || member.organization_id || ':' || member.event_id || ':' ||
                  account.id || ':' || hex(coalesce(member.granted_at, pool.updated_at)),
                member.organization_id, member.event_id, 'reviewer', account.id,
                lower(trim(account.email)), NULL, 'pending',
                'verified-account:reviewer:' || account.id || ':' ||
                  hex(coalesce(member.granted_at, pool.updated_at)),
                'system', NULL, coalesce(member.granted_at, pool.updated_at),
                NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?
           FROM auth_users account
           JOIN reviewer_pool_members member ON member.reviewer_id = account.id
           JOIN reviewer_pools pool
             ON pool.organization_id = member.organization_id
            AND pool.event_id = member.event_id
            AND pool.id = member.pool_id
          WHERE account.id = ? AND account.email_verified = 1
            AND lower(trim(account.email)) = ?
            AND (
              EXISTS (
                SELECT 1
                  FROM organization_memberships membership
                 WHERE membership.organization_id = member.organization_id
                   AND membership.user_id = account.id
                   AND membership.role = 'reviewer'
              )
              OR EXISTS (
                SELECT 1
                  FROM auth_verifications verification
                 WHERE json_extract(
                         CASE WHEN json_valid(verification.identifier)
                              THEN verification.identifier ELSE '{}' END,
                         '$.kind'
                       ) = 'member_invitation'
                   AND json_extract(
                         CASE WHEN json_valid(verification.identifier)
                              THEN verification.identifier ELSE '{}' END,
                         '$.invitation.organizationId'
                       ) = member.organization_id
                   AND json_extract(
                         CASE WHEN json_valid(verification.identifier)
                              THEN verification.identifier ELSE '{}' END,
                         '$.invitation.userId'
                       ) = account.id
                   AND json_extract(
                         CASE WHEN json_valid(verification.identifier)
                              THEN verification.identifier ELSE '{}' END,
                         '$.invitation.role'
                       ) = 'reviewer'
                   AND json_extract(
                         CASE WHEN json_valid(verification.identifier)
                              THEN verification.identifier ELSE '{}' END,
                         '$.invitation.status'
                       ) IN ('pending', 'delivered')
              )
            )
            AND NOT EXISTS (
              SELECT 1
                FROM event_role_invitations existing
               WHERE existing.organization_id = member.organization_id
                 AND existing.event_id = member.event_id
                 AND existing.role = 'reviewer'
                 AND existing.recipient_user_id = account.id
                 AND existing.status IN ('pending', 'accepted')
            )
            AND NOT EXISTS (
              SELECT 1
                FROM event_role_invitations terminal
               WHERE terminal.organization_id = member.organization_id
                 AND terminal.event_id = member.event_id
                 AND terminal.role = 'reviewer'
                 AND terminal.recipient_user_id = account.id
                 AND terminal.status IN ('declined', 'revoked')
                 AND terminal.updated_at >= coalesce(member.granted_at, pool.updated_at)
            )`,
      )
      .bind(input.occurredAt, input.recipientUserId, email);
    await this.database.batch([reviewerInvitations]);
  }

  async listForVerifiedAccount(
    recipientUserId: string,
    normalizedEmail: string,
  ): Promise<readonly EventRoleInvitation[]> {
    const result = await this.database
      .prepare(
        `${SELECT}
          WHERE invitation.recipient_user_id = ?
            AND (invitation.status = 'accepted'
              OR (invitation.status = 'pending'
                AND invitation.normalized_email = ? COLLATE NOCASE))
            AND EXISTS (
              SELECT 1 FROM auth_users account
               WHERE account.id = invitation.recipient_user_id
                 AND account.email_verified = 1
                 AND account.email = ? COLLATE NOCASE
            )
          ORDER BY invitation.invited_at, invitation.id`,
      )
      .bind(recipientUserId, normalizeEmail(normalizedEmail), normalizeEmail(normalizedEmail))
      .all<InvitationRow>();
    return (result.results ?? []).map(invitation);
  }

  async findForVerifiedAccount(
    invitationId: string,
    recipientUserId: string,
    normalizedEmail: string,
  ): Promise<EventRoleInvitation | null> {
    const row = await this.database
      .prepare(
        `${SELECT}
          WHERE invitation.id = ?
            AND invitation.recipient_user_id = ?
            AND (invitation.status = 'accepted'
              OR invitation.normalized_email = ? COLLATE NOCASE)
            AND EXISTS (
              SELECT 1 FROM auth_users account
               WHERE account.id = invitation.recipient_user_id
                 AND account.email_verified = 1
                 AND account.email = ? COLLATE NOCASE
            )
          LIMIT 1`,
      )
      .bind(
        invitationId,
        recipientUserId,
        normalizeEmail(normalizedEmail),
        normalizeEmail(normalizedEmail),
      )
      .first<InvitationRow>();
    return row === null ? null : invitation(row);
  }

  async accept(input: EventRoleInvitationTransitionInput): Promise<EventRoleInvitation | null> {
    return this.transition(input, "accepted");
  }

  async decline(input: EventRoleInvitationTransitionInput): Promise<EventRoleInvitation | null> {
    return this.transition(input, "declined");
  }

  async listAcceptedReviewerEventIds(
    organizationId: string,
    recipientUserId: string,
  ): Promise<readonly string[]> {
    const result = await this.database
      .prepare(
        `SELECT invitation.event_id
           FROM event_role_invitations invitation
           JOIN auth_users account ON account.id = invitation.recipient_user_id
          WHERE invitation.organization_id = ?
            AND invitation.recipient_user_id = ?
            AND invitation.role = 'reviewer'
            AND invitation.status = 'accepted'
            AND account.email_verified = 1
          ORDER BY invitation.event_id`,
      )
      .bind(organizationId, recipientUserId)
      .all<{ event_id: string }>();
    return (result.results ?? []).map((row) => row.event_id);
  }

  async revokeReviewerInvitationsForOrganizationUser(
    input: RevokeReviewerInvitationsInput,
  ): Promise<number> {
    const actorId = revokerId(input);
    const result = await this.database
      .prepare(
        `UPDATE event_role_invitations
            SET status = 'revoked', revoked_by_actor_type = ?, revoked_by_actor_id = ?,
                revoked_at = ?, version = version + 1, updated_at = ?
          WHERE organization_id = ? AND recipient_user_id = ? AND role = 'reviewer'
            AND status IN ('pending', 'accepted')`,
      )
      .bind(
        input.revokedByActorType,
        actorId,
        input.occurredAt,
        input.occurredAt,
        input.organizationId,
        input.recipientUserId,
      )
      .run();
    return changes(result);
  }

  async revokeEventReviewerInvitationIfNoPoolGrantsRemain(
    input: RevokeEventReviewerInvitationInput,
  ): Promise<boolean> {
    const actorId = revokerId(input);
    const result = await this.database
      .prepare(
        `UPDATE event_role_invitations
            SET status = 'revoked', revoked_by_actor_type = ?, revoked_by_actor_id = ?,
                revoked_at = ?, version = version + 1, updated_at = ?
          WHERE organization_id = ? AND event_id = ? AND recipient_user_id = ?
            AND role = 'reviewer' AND status IN ('pending', 'accepted')
            AND NOT EXISTS (
              SELECT 1
                FROM reviewer_pool_members member
                JOIN reviewer_pools pool
                  ON pool.organization_id = member.organization_id
                 AND pool.event_id = member.event_id
                 AND pool.id = member.pool_id
               WHERE member.organization_id = event_role_invitations.organization_id
                 AND member.event_id = event_role_invitations.event_id
                 AND member.reviewer_id = event_role_invitations.recipient_user_id
                 AND pool.round_id <> ?
            )`,
      )
      .bind(
        input.revokedByActorType,
        actorId,
        input.occurredAt,
        input.occurredAt,
        input.organizationId,
        input.eventId,
        input.recipientUserId,
        input.excludedRoundId,
      )
      .run();
    return changes(result) === 1;
  }

  private async transition(
    input: EventRoleInvitationTransitionInput,
    status: "accepted" | "declined",
  ): Promise<EventRoleInvitation | null> {
    const email = normalizeEmail(input.normalizedEmail);
    const actorColumn = status === "accepted" ? "accepted_by_user_id" : "declined_by_user_id";
    const atColumn = status === "accepted" ? "accepted_at" : "declined_at";
    const nextVersion = input.expectedVersion + 1;
    const reviewerAcceptanceGuard =
      status === "accepted"
        ? `AND (event_role_invitations.role <> 'reviewer'
            OR EXISTS (
              SELECT 1
                FROM organization_memberships membership
               WHERE membership.organization_id = event_role_invitations.organization_id
                 AND membership.user_id = event_role_invitations.recipient_user_id
                 AND membership.role = 'reviewer'
            )
            OR EXISTS (
              SELECT 1
                FROM auth_verifications verification
               WHERE json_extract(
                       CASE WHEN json_valid(verification.identifier)
                            THEN verification.identifier ELSE '{}' END,
                       '$.kind'
                     ) = 'member_invitation'
                 AND json_extract(
                       CASE WHEN json_valid(verification.identifier)
                            THEN verification.identifier ELSE '{}' END,
                       '$.invitation.organizationId'
                     ) = event_role_invitations.organization_id
                 AND json_extract(
                       CASE WHEN json_valid(verification.identifier)
                            THEN verification.identifier ELSE '{}' END,
                       '$.invitation.userId'
                     ) = event_role_invitations.recipient_user_id
                 AND json_extract(
                       CASE WHEN json_valid(verification.identifier)
                            THEN verification.identifier ELSE '{}' END,
                       '$.invitation.role'
                     ) = 'reviewer'
                 AND json_extract(
                       CASE WHEN json_valid(verification.identifier)
                            THEN verification.identifier ELSE '{}' END,
                       '$.invitation.status'
                     ) IN ('pending', 'delivered')
            ))`
        : "";
    const update = this.database
      .prepare(
        `UPDATE event_role_invitations
            SET status = ?, ${actorColumn} = ?, ${atColumn} = ?, version = ?, updated_at = ?
          WHERE id = ? AND recipient_user_id = ? AND normalized_email = ? COLLATE NOCASE
            AND status = 'pending' AND version = ?
            AND EXISTS (
              SELECT 1 FROM auth_users account
               WHERE account.id = event_role_invitations.recipient_user_id
                 AND account.email_verified = 1
                 AND account.email = event_role_invitations.normalized_email COLLATE NOCASE
            )
            ${reviewerAcceptanceGuard}`,
      )
      .bind(
        status,
        input.recipientUserId,
        input.occurredAt,
        nextVersion,
        input.occurredAt,
        input.invitationId,
        input.recipientUserId,
        email,
        input.expectedVersion,
      );
    const result = await update.run();
    if (changes(result) !== 1) {
      const current = await this.findForVerifiedAccount(
        input.invitationId,
        input.recipientUserId,
        email,
      );
      if (status === "accepted" && current?.status === "accepted") return current;
      if (current === null) return null;
      throw new EventRoleInvitationRepositoryConflictError();
    }
    return this.findForVerifiedAccount(input.invitationId, input.recipientUserId, email);
  }

  private async findById(id: string): Promise<EventRoleInvitation | null> {
    const row = await this.database
      .prepare(`${SELECT} WHERE invitation.id = ? LIMIT 1`)
      .bind(id)
      .first<InvitationRow>();
    return row === null ? null : invitation(row);
  }

  private async findByCreationKey(
    organizationId: string,
    eventId: string,
    creationIdempotencyKey: string,
  ): Promise<EventRoleInvitation | null> {
    const row = await this.database
      .prepare(
        `${SELECT}
          WHERE invitation.organization_id = ? AND invitation.event_id = ?
            AND invitation.creation_idempotency_key = ?
          LIMIT 1`,
      )
      .bind(organizationId, eventId, creationIdempotencyKey)
      .first<InvitationRow>();
    return row === null ? null : invitation(row);
  }

  private async findLiveForBinding(
    input: CreateEventRoleInvitationInput,
  ): Promise<EventRoleInvitation | null> {
    const row = await this.database
      .prepare(
        `${SELECT}
          WHERE invitation.organization_id = ? AND invitation.event_id = ?
            AND invitation.role = ? AND invitation.recipient_user_id = ?
            AND invitation.participant_id IS ?
            AND invitation.status IN ('pending', 'accepted')
          LIMIT 1`,
      )
      .bind(
        input.organizationId,
        input.eventId,
        input.role,
        input.recipientUserId,
        input.participantId ?? null,
      )
      .first<InvitationRow>();
    return row === null ? null : invitation(row);
  }
}
