/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it } from "vitest";
import { EventInvitationService } from "../../../features/event-invitations/service";
import { SqliteD1 } from "../../../test-support/sqlite-d1";
import { D1EventRoleInvitationRepository } from "./event-role-invitations";
import { D1ReviewerPoolRepository } from "./reviewer-pool";

const NOW = "2026-08-16T12:00:00.000Z";
const LATER = "2026-08-16T12:01:00.000Z";
const LATEST = "2026-08-16T12:02:00.000Z";
const AFTER_LATEST = "2026-08-16T12:03:00.000Z";

const migrations = [
  "0001_identity_and_access.sql",
  "0002_operational_state.sql",
  "0003_auth_password.sql",
  "0004_organizations.sql",
  "0005_integrations.sql",
  "0006_domain_consistency_operational_state.sql",
  "0007_program_core.sql",
  "0008_cfp_and_speakers.sql",
  "0009_evaluations.sql",
  "0010_sessions_and_agenda.sql",
  "0011_content_communications_crm.sql",
  "0012_reports_remix_publication.sql",
  "0013_webhooks_and_airtable_sync.sql",
  "0020_self_hostable_communication_senders.sql",
  "0021_calendar_invitation_lifecycle.sql",
  "0022_event_schedule_dates.sql",
  "0023_airtable_oauth_authorization_generation.sql",
  "0024_cfp_file_assets.sql",
  "0025_canonical_d1_speakers.sql",
  "0026_cfp_url_field_kind.sql",
  "0027_event_role_invitations.sql",
] as const;

const databases: SqliteD1[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.dispose();
});

function migration(name: string): string {
  return readFileSync(join(process.cwd(), "apps/api/migrations", name), "utf8");
}

function databaseBeforeEventInvitations(): SqliteD1 {
  const database = new SqliteD1("eventloom-pre-event-role-invitations-");
  databases.push(database);
  for (const name of migrations.slice(0, migrations.indexOf("0027_event_role_invitations.sql"))) {
    database.executeScript(migration(name));
  }
  return database;
}

function fixture(): {
  database: SqliteD1;
  repository: D1EventRoleInvitationRepository;
} {
  const database = new SqliteD1("eventloom-event-role-invitations-");
  databases.push(database);
  for (const name of migrations) database.executeScript(migration(name));
  database.executeScript(`
    INSERT INTO auth_users (id,email,email_verified,name,created_at,updated_at) VALUES
      ('reviewer-account','reviewer@example.test',1,'Review Person','${NOW}','${NOW}'),
      ('speaker-account','speaker@example.test',1,'Speaker Person','${NOW}','${NOW}'),
      ('other-account','other@example.test',1,'Other Person','${NOW}','${NOW}'),
      ('unverified-account','unverified@example.test',0,'Unverified Person','${NOW}','${NOW}');

    INSERT INTO organizations (organization_id,slug,name,config_json,created_at,updated_at) VALUES
      ('org-a','org-a','Organization A','{}','${NOW}','${NOW}'),
      ('org-b','org-b','Organization B','{}','${NOW}','${NOW}');

    INSERT INTO organization_memberships (organization_id,user_id,role,created_at,updated_at)
    VALUES ('org-a','reviewer-account','reviewer','${NOW}','${NOW}');

    INSERT INTO events
      (id,organization_id,slug,name,status,time_zone,starts_at,ends_at,schedule_dates_json,
       venue,cfp_enabled,cfp_opens_at,cfp_closes_at,default_duration_minutes,
       default_calendar_time_zone,default_calendar_location,version,created_at,updated_at,
       created_by,updated_by)
    VALUES
      ('event-a','org-a','event-a','Event A','active','UTC','2026-09-01T09:00:00.000Z',
       '2026-09-01T17:00:00.000Z','["2026-09-01"]',NULL,0,NULL,NULL,30,'UTC',NULL,1,
       '${NOW}','${NOW}','organizer-a','organizer-a'),
      ('event-b','org-b','event-b','Event B','active','UTC','2026-10-01T09:00:00.000Z',
       '2026-10-01T17:00:00.000Z','["2026-10-01"]',NULL,0,NULL,NULL,30,'UTC',NULL,1,
       '${NOW}','${NOW}','organizer-b','organizer-b');

    INSERT INTO cfp_forms
      (id,organization_id,event_id,name,status,welcome_content,speaker_limit,
       max_submissions_per_account,reminders_enabled,admin_notifications_enabled,
       confirmation_message,success_content,redirect_url,version,created_at,updated_at)
    VALUES
      ('form-a','org-a','event-a','Form A','closed','',1,1,0,0,'','',NULL,1,'${NOW}','${NOW}');

    INSERT INTO submissions
      (id,organization_id,event_id,form_id,owner_account_id,form_version,status,
       completed_steps_json,version,created_at,updated_at,submitted_at)
    VALUES
      ('submission-a','org-a','event-a','form-a','speaker-account',1,'submitted','[]',1,
       '${NOW}','${NOW}','${NOW}');

    INSERT INTO participants
      (id,organization_id,event_id,first_name,last_name,display_name,email,normalized_email,
       identity_state,source_type,source_id,claimed_user_id,version,created_at,updated_at)
    VALUES
      ('participant-a','org-a','event-a','Speaker','Person','Speaker Person',
       'speaker@example.test','speaker@example.test','resolved','cfp','submission-a',NULL,1,
       '${NOW}','${NOW}');

    INSERT INTO submission_participants
      (organization_id,event_id,submission_id,participant_id,role,biography,answers_json,ordinal)
    VALUES ('org-a','event-a','submission-a','participant-a','primary','Existing biography.','{}',0);

    INSERT INTO speaker_profiles
      (id,organization_id,event_id,participant_id,display_name,email,job_title,company,status,
       biography,social_links_json,travel_required,arrival_at,departure_at,accommodation,
       dietary_requirements,accessibility_needs,travel_notes,headshot_asset_id,source_type,
       source_id,version,created_at,updated_at,admitted_by_account_id,admitted_at)
    VALUES
      ('profile-a','org-a','event-a','participant-a','Speaker Person','speaker@example.test',
       'Engineer','Example Co','confirmed','Existing biography.','{}',0,NULL,NULL,'','','','',NULL,
       'cfp','submission-a',1,'${NOW}','${NOW}','organizer-a','${NOW}');

    INSERT INTO session_statuses
      (id,organization_id,event_id,value,name,description,agenda_eligible,sort_order,active,
       version,created_at,updated_at)
    VALUES ('status-accepted','org-a','event-a','Accepted','Accepted','',1,0,1,1,'${NOW}','${NOW}');

    INSERT INTO sessions
      (id,organization_id,event_id,title,description,status,content_status,duration_minutes,
       capacity_required,room_id,format_id,level_id,version,created_at,updated_at,created_by,
       updated_by,deleted_at)
    VALUES
      ('session-a','org-a','event-a','Existing session','','Accepted','Approved',30,0,NULL,NULL,NULL,
       1,'${NOW}','${NOW}','organizer-a','organizer-a',NULL);

    INSERT INTO session_speakers
      (organization_id,event_id,session_id,speaker_id,display_name,role,ordinal)
    VALUES ('org-a','event-a','session-a','participant-a','Speaker Person','speaker',0);

    INSERT INTO speaker_tasks
      (id,organization_id,event_id,submission_id,participant_id,type,owner,title,description,
       instructions,status,due_at,allowed_mime_types_json,max_bytes,accepted_asset_kinds_json,
       version,created_at,updated_at)
    VALUES
      ('task-a','org-a','event-a','submission-a','participant-a','action','speaker',
       'Existing task','','','not_started',NULL,'[]',NULL,'[]',1,'${NOW}','${NOW}');

    INSERT INTO review_plans
      (id,organization_id,event_id,name,status,blind_review,reviews_per_submission,
       max_assignments_per_reviewer,auto_distribute,reviewer_projection_field_ids_json,
       reviewer_projection_file_ids_json,version,created_at,updated_at)
    VALUES ('plan-a','org-a','event-a','Plan A','open',0,1,10,0,'[]','[]',1,'${NOW}','${NOW}');

    INSERT INTO review_rubrics (id,organization_id,event_id,plan_id,revision,name)
    VALUES ('rubric-a','org-a','event-a','plan-a',1,'Rubric A');

    INSERT INTO review_rounds
      (id,organization_id,event_id,plan_id,name,sequence,revision,rubric_id,rubric_revision,
       opens_at,closes_at,blind_review,anonymization,track_filter)
    VALUES ('round-a','org-a','event-a','plan-a','Round A',0,1,'rubric-a',1,NULL,NULL,0,'none',NULL);

    INSERT INTO review_assignments
      (id,organization_id,event_id,plan_id,round_id,round_revision,submission_id,reviewer_id,
       status,predecessor_assignment_id,successor_assignment_id,superseded_reason,superseded_at,
       plan_version,rubric_revision,submission_revision,version,created_at,updated_at)
    VALUES
      ('assignment-a','org-a','event-a','plan-a','round-a',1,'submission-a','reviewer-account',
       'assigned',NULL,NULL,NULL,NULL,1,1,1,3,'${NOW}','${NOW}');
  `);
  return {
    database,
    repository: new D1EventRoleInvitationRepository(database as unknown as D1Database),
  };
}

function invite(
  database: SqliteD1,
  input: {
    id: string;
    organizationId?: string;
    eventId?: string;
    recipientUserId: string;
    normalizedEmail: string;
    role: "reviewer" | "speaker";
    participantId?: string | null;
  },
): void {
  database.run(`
    INSERT INTO event_role_invitations
      (id,organization_id,event_id,role,recipient_user_id,normalized_email,participant_id,
       status,creation_idempotency_key,invited_by_actor_type,invited_by_actor_id,invited_at,
       accepted_by_user_id,accepted_at,declined_by_user_id,declined_at,revoked_by_actor_type,
       revoked_by_actor_id,revoked_at,version,updated_at)
    VALUES
      ('${input.id}','${input.organizationId ?? "org-a"}','${input.eventId ?? "event-a"}',
       '${input.role}','${input.recipientUserId}','${input.normalizedEmail}',
       ${input.participantId === undefined || input.participantId === null ? "NULL" : `'${input.participantId}'`},
       'pending','create:${input.id}','user','organizer-a','${NOW}',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,'${NOW}')
  `);
}

function count(database: SqliteD1, table: string, where = "1 = 1"): number {
  return (
    database.query<{ count: number }>(`SELECT count(*) AS count FROM ${table} WHERE ${where}`)[0]
      ?.count ?? 0
  );
}

async function invitation(
  repository: D1EventRoleInvitationRepository,
  invitationId: string,
  recipientUserId: string,
  normalizedEmail: string,
) {
  const found = await repository.findForVerifiedAccount(
    invitationId,
    recipientUserId,
    normalizedEmail,
  );
  if (found === null) throw new Error(`Expected invitation ${invitationId}.`);
  return found;
}

function transition(
  invitationId: string,
  recipientUserId: string,
  normalizedEmail: string,
  expectedVersion: number,
) {
  return {
    invitationId,
    recipientUserId,
    normalizedEmail,
    expectedVersion,
    occurredAt: LATER,
  };
}

function addEvent(database: SqliteD1, eventId: string): void {
  database.run(`
    INSERT INTO events
      (id,organization_id,slug,name,status,time_zone,starts_at,ends_at,schedule_dates_json,
       venue,cfp_enabled,cfp_opens_at,cfp_closes_at,default_duration_minutes,
       default_calendar_time_zone,default_calendar_location,version,created_at,updated_at,
       created_by,updated_by)
    VALUES
      ('${eventId}','org-a','${eventId}','${eventId}','active','UTC',
       '2026-11-01T09:00:00.000Z','2026-11-01T17:00:00.000Z','["2026-11-01"]',NULL,0,
       NULL,NULL,30,'UTC',NULL,1,'${NOW}','${NOW}','organizer-a','organizer-a')
  `);
}

function addReviewerPool(
  database: SqliteD1,
  input: {
    roundId: string;
    poolId: string;
    reviewerId: string;
    sequence: number;
    grantedAt?: string;
  },
): void {
  database.executeScript(`
    INSERT INTO review_rounds
      (id,organization_id,event_id,plan_id,name,sequence,revision,rubric_id,rubric_revision,
       opens_at,closes_at,blind_review,anonymization,track_filter)
    VALUES
      ('${input.roundId}','org-a','event-a','plan-a','${input.roundId}',${input.sequence},1,
       'rubric-a',1,NULL,NULL,0,'none',NULL);
    INSERT INTO reviewer_pools
      (id,organization_id,event_id,round_id,round_revision,name,version,created_at,updated_at)
    VALUES
      ('${input.poolId}','org-a','event-a','${input.roundId}',1,NULL,1,'${NOW}','${NOW}');
    INSERT INTO reviewer_pool_members (organization_id,event_id,pool_id,reviewer_id,granted_at)
    VALUES (
      'org-a','event-a','${input.poolId}','${input.reviewerId}','${input.grantedAt ?? NOW}'
    );
  `);
}

function addLegacyMemberInvitation(
  database: SqliteD1,
  input: { id: string; userId: string; email: string; status: "pending" | "delivered" | "revoked" },
): void {
  const envelope = JSON.stringify({
    kind: "member_invitation",
    invitation: {
      id: input.id,
      organizationId: "org-a",
      userId: input.userId,
      email: input.email,
      role: "reviewer",
      status: input.status,
    },
  }).replaceAll("'", "''");
  database.run(`
    INSERT INTO auth_verifications
      (id,identifier,token_digest,expires_at,created_at,updated_at)
    VALUES
      ('${input.id}','${envelope}','token:${input.id}','2027-08-16T12:00:00.000Z','${NOW}','${NOW}')
  `);
}

describe("D1EventRoleInvitationRepository", () => {
  it("migrates divergent legacy speaker grants without backfilling incompatible invitations", () => {
    const database = databaseBeforeEventInvitations();
    database.executeScript(`
      INSERT INTO auth_users (id,email,email_verified,name,created_at,updated_at) VALUES
        ('legacy-good','good@example.test',1,'Good','${NOW}','${NOW}'),
        ('legacy-unresolved','unresolved@example.test',1,'Unresolved','${NOW}','${NOW}'),
        ('legacy-participant-mismatch','participant@example.test',1,'Participant mismatch','${NOW}','${NOW}'),
        ('legacy-profile-mismatch','grant@example.test',1,'Profile mismatch','${NOW}','${NOW}'),
        ('legacy-unverified','unverified-legacy@example.test',0,'Unverified','${NOW}','${NOW}'),
        ('legacy-revoked','revoked@example.test',1,'Revoked','${NOW}','${NOW}');
      INSERT INTO organizations (organization_id,slug,name,config_json,created_at,updated_at)
      VALUES ('legacy-org','legacy-org','Legacy Organization','{}','${NOW}','${NOW}');
      INSERT INTO events
        (id,organization_id,slug,name,status,time_zone,starts_at,ends_at,schedule_dates_json,
         venue,cfp_enabled,cfp_opens_at,cfp_closes_at,default_duration_minutes,
         default_calendar_time_zone,default_calendar_location,version,created_at,updated_at,
         created_by,updated_by)
      VALUES
        ('legacy-event','legacy-org','legacy-event','Legacy Event','active','UTC',
         '2026-09-01T09:00:00.000Z','2026-09-01T17:00:00.000Z','["2026-09-01"]',NULL,0,
         NULL,NULL,30,'UTC',NULL,1,'${NOW}','${NOW}','organizer','organizer');
      INSERT INTO organization_memberships (organization_id,user_id,role,created_at,updated_at)
      VALUES ('legacy-org','legacy-good','reviewer','${NOW}','${NOW}');
      INSERT INTO review_plans
        (id,organization_id,event_id,name,status,blind_review,reviews_per_submission,
         max_assignments_per_reviewer,auto_distribute,reviewer_projection_field_ids_json,
         reviewer_projection_file_ids_json,version,created_at,updated_at)
      VALUES
        ('legacy-plan','legacy-org','legacy-event','Legacy Plan','open',0,1,10,0,'[]','[]',1,
         '${NOW}','${NOW}');
      INSERT INTO participants
        (id,organization_id,event_id,first_name,last_name,display_name,email,normalized_email,
         identity_state,source_type,source_id,claimed_user_id,version,created_at,updated_at)
      VALUES
        ('participant-good','legacy-org','legacy-event','Good','','Good','good@example.test',
         'good@example.test','resolved','manual',NULL,NULL,1,'${NOW}','${NOW}'),
        ('participant-unresolved','legacy-org','legacy-event','Unresolved','','Unresolved',
         'unresolved@example.test','unresolved@example.test','ambiguous','manual',NULL,NULL,1,
         '${NOW}','${NOW}'),
        ('participant-mismatch','legacy-org','legacy-event','Mismatch','','Mismatch',
         'participant@example.test','participant@example.test','resolved','manual',NULL,NULL,1,
         '${NOW}','${NOW}'),
        ('profile-mismatch','legacy-org','legacy-event','Profile','','Profile',
         'profile@example.test','profile@example.test','resolved','manual',NULL,NULL,1,
         '${NOW}','${NOW}'),
        ('participant-unverified','legacy-org','legacy-event','Unverified','','Unverified',
         'unverified-legacy@example.test','unverified-legacy@example.test','resolved','manual',NULL,
         NULL,1,'${NOW}','${NOW}'),
        ('participant-revoked','legacy-org','legacy-event','Revoked','','Revoked',
         'revoked@example.test','revoked@example.test','resolved','manual',NULL,NULL,1,
         '${NOW}','${NOW}');
      INSERT INTO speaker_profiles
        (id,organization_id,event_id,participant_id,display_name,email,job_title,company,status,
         biography,social_links_json,travel_required,arrival_at,departure_at,accommodation,
         dietary_requirements,accessibility_needs,travel_notes,headshot_asset_id,source_type,
         source_id,version,created_at,updated_at,admitted_by_account_id,admitted_at)
      VALUES
        ('profile-good','legacy-org','legacy-event','participant-good','Good','good@example.test',
         '','','active','','{}',0,NULL,NULL,'','','','',NULL,'manual',NULL,1,'${NOW}','${NOW}',NULL,'${NOW}'),
        ('profile-unresolved','legacy-org','legacy-event','participant-unresolved','Unresolved',
         'unresolved@example.test','','','active','','{}',0,NULL,NULL,'','','','',NULL,'manual',NULL,1,
         '${NOW}','${NOW}',NULL,'${NOW}'),
        ('profile-participant-mismatch','legacy-org','legacy-event','participant-mismatch','Mismatch',
         'participant@example.test','','','active','','{}',0,NULL,NULL,'','','','',NULL,'manual',NULL,1,
         '${NOW}','${NOW}',NULL,'${NOW}'),
        ('profile-email-mismatch','legacy-org','legacy-event','profile-mismatch','Profile',
         'profile@example.test','','','active','','{}',0,NULL,NULL,'','','','',NULL,'manual',NULL,1,
         '${NOW}','${NOW}',NULL,'${NOW}'),
        ('profile-unverified','legacy-org','legacy-event','participant-unverified','Unverified',
         'unverified-legacy@example.test','','','active','','{}',0,NULL,NULL,'','','','',NULL,'manual',NULL,1,
         '${NOW}','${NOW}',NULL,'${NOW}'),
        ('profile-revoked','legacy-org','legacy-event','participant-revoked','Revoked',
         'revoked@example.test','','','revoked','','{}',0,NULL,NULL,'','','','',NULL,'manual',NULL,1,
         '${NOW}','${NOW}',NULL,'${NOW}');
      UPDATE participants SET normalized_email = 'different@example.test'
       WHERE id = 'participant-mismatch';
      UPDATE participants SET claimed_user_id = 'legacy-profile-mismatch'
       WHERE id = 'profile-mismatch';
      UPDATE participants SET claimed_user_id = 'legacy-unverified'
       WHERE id = 'participant-unverified';
      UPDATE participants SET claimed_user_id = 'legacy-revoked'
       WHERE id = 'participant-revoked';
      INSERT OR IGNORE INTO participant_grants
        (organization_id,event_id,participant_id,user_id,permissions_json,created_at,updated_at,revoked_at)
      VALUES
        ('legacy-org','legacy-event','profile-mismatch','legacy-profile-mismatch','[]','${NOW}','${NOW}',NULL),
        ('legacy-org','legacy-event','participant-unverified','legacy-unverified','[]','${NOW}','${NOW}',NULL),
        ('legacy-org','legacy-event','participant-revoked','legacy-revoked','[]','${NOW}','${NOW}',NULL);
    `);

    expect(() =>
      database.executeScript(migration("0027_event_role_invitations.sql")),
    ).not.toThrow();
    expect(
      database.query<{ participant_id: string; recipient_user_id: string }>(
        `SELECT participant_id, recipient_user_id FROM event_role_invitations
          WHERE role = 'speaker' ORDER BY participant_id`,
      ),
    ).toEqual([{ participant_id: "participant-good", recipient_user_id: "legacy-good" }]);
    expect(
      database.query<{ status: string; recipient_user_id: string }>(
        `SELECT status, recipient_user_id FROM event_role_invitations
          WHERE role = 'reviewer' AND event_id = 'legacy-event'`,
      ),
    ).toEqual([{ status: "accepted", recipient_user_id: "legacy-good" }]);
    expect(
      database.query<{ participant_id: string; user_id: string }>(
        `SELECT participant_id, user_id FROM participant_grants
          WHERE revoked_at IS NULL
            AND participant_id IN ('profile-mismatch','participant-unverified','participant-revoked')
          ORDER BY participant_id`,
      ),
    ).toEqual([]);
    expect(
      database.query<{ id: string; claimed_user_id: string | null }>(
        `SELECT id, claimed_user_id FROM participants
          WHERE id IN ('profile-mismatch','participant-unverified','participant-revoked')
          ORDER BY id`,
      ),
    ).toEqual([
      { id: "participant-revoked", claimed_user_id: null },
      { id: "participant-unverified", claimed_user_id: null },
      { id: "profile-mismatch", claimed_user_id: null },
    ]);
  });

  it("lists only invitations bound to the verified account and its current normalized email", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-reviewer",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      role: "reviewer",
    });
    invite(database, {
      id: "invite-stale-email",
      recipientUserId: "other-account",
      normalizedEmail: "other@example.test",
      role: "reviewer",
    });
    database.run(
      `UPDATE auth_users SET email = 'changed@example.test', updated_at = '${LATER}'
        WHERE id = 'other-account'`,
    );
    database.run(
      `UPDATE auth_users SET email_verified = 1, updated_at = '${NOW}'
        WHERE id = 'unverified-account'`,
    );
    invite(database, {
      id: "invite-unverified",
      recipientUserId: "unverified-account",
      normalizedEmail: "unverified@example.test",
      role: "reviewer",
    });
    database.run(
      `UPDATE auth_users SET email_verified = 0, updated_at = '${LATER}'
        WHERE id = 'unverified-account'`,
    );

    await expect(
      repository.listForVerifiedAccount("reviewer-account", "REVIEWER@example.test"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "invite-reviewer",
        recipientUserId: "reviewer-account",
        normalizedEmail: "reviewer@example.test",
        status: "pending",
      }),
    ]);
    await expect(
      repository.listForVerifiedAccount("other-account", "changed@example.test"),
    ).resolves.toEqual([]);
    await expect(
      repository.listForVerifiedAccount("unverified-account", "unverified@example.test"),
    ).resolves.toEqual([]);
  });

  it("creates a fresh reviewer invitation generation after revocation and reuses live access", async () => {
    const { database, repository } = fixture();
    const create = (id: string, creationIdempotencyKey: string, invitedAt: string) =>
      repository.create({
        id,
        organizationId: "org-a",
        eventId: "event-a",
        role: "reviewer",
        recipientUserId: "reviewer-account",
        normalizedEmail: "reviewer@example.test",
        participantId: null,
        creationIdempotencyKey,
        invitedByActorType: "user",
        invitedByActorId: "organizer-a",
        invitedAt,
      });
    const first = await create("invite-reviewer-generation-1", "reviewer-generation:1", NOW);
    await expect(
      repository.revokeEventReviewerInvitationIfNoPoolGrantsRemain({
        organizationId: "org-a",
        eventId: "event-a",
        excludedRoundId: "round-a",
        recipientUserId: "reviewer-account",
        revokedByActorType: "user",
        revokedByActorId: "organizer-a",
        occurredAt: LATER,
      }),
    ).resolves.toBe(true);

    const second = await create("invite-reviewer-generation-2", "reviewer-generation:2", LATEST);
    const replayedPending = await create(
      "invite-reviewer-generation-3",
      "reviewer-generation:3",
      LATEST,
    );
    const accepted = await repository.accept(
      transition(second.id, "reviewer-account", "reviewer@example.test", 1),
    );
    const replayedAccepted = await create(
      "invite-reviewer-generation-4",
      "reviewer-generation:4",
      LATEST,
    );

    expect(first.status).toBe("pending");
    expect(second).toMatchObject({ id: "invite-reviewer-generation-2", status: "pending" });
    expect(replayedPending.id).toBe(second.id);
    expect(accepted).toMatchObject({ id: second.id, status: "accepted" });
    expect(replayedAccepted.id).toBe(second.id);
    expect(count(database, "event_role_invitations", "role = 'reviewer'")).toBe(2);
  });

  it("preserves retained reviewer grant generations and refreshes only explicit re-adds", async () => {
    const { database } = fixture();
    database.run(`
      INSERT INTO review_rounds
        (id,organization_id,event_id,plan_id,name,sequence,revision,rubric_id,rubric_revision,
         opens_at,closes_at,blind_review,anonymization,track_filter)
      VALUES
        ('round-generation','org-a','event-a','plan-a','Round Generation',1,1,
         'rubric-a',1,NULL,NULL,0,'none',NULL)
    `);
    const pools = new D1ReviewerPoolRepository(database as unknown as D1Database);
    const save = (
      version: number,
      expectedVersion: number | null,
      reviewerIds: readonly string[],
      updatedAt: string,
    ) =>
      pools.saveReviewerPool(
        {
          organizationId: "org-a",
          eventId: "event-a",
          roundId: "round-generation",
          reviewerIds,
          grants: reviewerIds.map((reviewerId) => ({
            reviewerId,
            maxAssignments: 4,
            assignedCount: 0,
          })),
          version,
          createdAt: NOW,
          updatedAt,
        },
        expectedVersion,
      );
    const grantRows = () =>
      database.query<{ reviewer_id: string; granted_at: string }>(
        `SELECT reviewer_id, granted_at FROM reviewer_pool_members
          WHERE pool_id = 'reviewer-pool:org-a:event-a:round-generation' ORDER BY reviewer_id`,
      );

    await save(1, null, ["revieweraccount"], NOW);
    await save(2, 1, ["otheraccount", "revieweraccount"], LATER);
    expect(grantRows()).toEqual([
      { reviewer_id: "otheraccount", granted_at: LATER },
      { reviewer_id: "revieweraccount", granted_at: NOW },
    ]);

    await save(3, 2, ["otheraccount"], LATEST);
    await save(4, 3, ["otheraccount", "revieweraccount"], AFTER_LATEST);
    expect(grantRows()).toEqual([
      { reviewer_id: "otheraccount", granted_at: LATER },
      { reviewer_id: "revieweraccount", granted_at: AFTER_LATEST },
    ]);
  });

  it("keeps reviewer access when a stale atomic pool removal loses its compare-and-swap", async () => {
    const { database, repository } = fixture();
    database.run(`
      INSERT INTO review_rounds
        (id,organization_id,event_id,plan_id,name,sequence,revision,rubric_id,rubric_revision,
         opens_at,closes_at,blind_review,anonymization,track_filter)
      VALUES
        ('round-atomic','org-a','event-a','plan-a','Round Atomic',1,1,
         'rubric-a',1,NULL,NULL,0,'none',NULL)
    `);
    const pools = new D1ReviewerPoolRepository(database as unknown as D1Database);
    const pool = (version: number, reviewerIds: readonly string[], updatedAt: string) => ({
      organizationId: "org-a",
      eventId: "event-a",
      roundId: "round-atomic",
      reviewerIds,
      grants: reviewerIds.map((reviewerId) => ({
        reviewerId,
        maxAssignments: 4,
        assignedCount: 0,
      })),
      version,
      createdAt: NOW,
      updatedAt,
    });
    await pools.saveReviewerPool(pool(1, ["reviewer-account"], NOW), null);
    const invitation = await repository.create({
      id: "invite-atomic-stale-reviewer",
      organizationId: "org-a",
      eventId: "event-a",
      role: "reviewer",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      participantId: null,
      creationIdempotencyKey: "reviewer-atomic-stale:1",
      invitedByActorType: "user",
      invitedByActorId: "organizer-a",
      invitedAt: NOW,
    });
    await pools.saveReviewerPool(pool(2, ["reviewer-account"], LATER), 1);

    await expect(
      pools.saveReviewerPoolAndRevokeInvitations({
        pool: pool(2, [], LATER),
        expectedVersion: 1,
        removedReviewerIds: ["reviewer-account"],
        addedReviewerInvitations: [],
        revokedByUserId: "organizer-a",
        revokedAt: LATER,
      }),
    ).rejects.toMatchObject({ name: "MemberRepositoryConflictError" });

    await expect(pools.getReviewerPool("org-a", "event-a", "round-atomic")).resolves.toMatchObject({
      version: 2,
      reviewerIds: ["reviewer-account"],
    });
    expect(
      database.query<{ status: string; version: number }>(
        `SELECT status, version FROM event_role_invitations
          WHERE id = '${invitation.id}'`,
      )[0],
    ).toEqual({ status: "pending", version: 1 });

    await pools.saveReviewerPoolAndRevokeInvitations({
      pool: pool(3, [], LATEST),
      expectedVersion: 2,
      removedReviewerIds: ["reviewer-account"],
      addedReviewerInvitations: [],
      revokedByUserId: "organizer-a",
      revokedAt: LATEST,
    });
    await expect(pools.getReviewerPool("org-a", "event-a", "round-atomic")).resolves.toMatchObject({
      version: 3,
      reviewerIds: [],
    });
    expect(
      database.query<{ status: string; version: number }>(
        `SELECT status, version FROM event_role_invitations
          WHERE id = '${invitation.id}'`,
      )[0],
    ).toEqual({ status: "revoked", version: 2 });

    const readded = {
      id: "invite-atomic-stale-readd",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      creationIdempotencyKey: "reviewer-atomic-stale:2",
      invitedByUserId: "organizer-a",
      invitedAt: AFTER_LATEST,
    };
    await expect(
      pools.saveReviewerPoolAndRevokeInvitations({
        pool: pool(3, ["reviewer-account"], AFTER_LATEST),
        expectedVersion: 2,
        removedReviewerIds: [],
        addedReviewerInvitations: [readded],
        revokedByUserId: "organizer-a",
        revokedAt: AFTER_LATEST,
      }),
    ).rejects.toMatchObject({ name: "MemberRepositoryConflictError" });
    expect(
      count(
        database,
        "event_role_invitations",
        "recipient_user_id = 'reviewer-account' AND status = 'pending'",
      ),
    ).toBe(0);

    await pools.saveReviewerPoolAndRevokeInvitations({
      pool: pool(4, ["reviewer-account"], AFTER_LATEST),
      expectedVersion: 3,
      removedReviewerIds: [],
      addedReviewerInvitations: [readded],
      revokedByUserId: "organizer-a",
      revokedAt: AFTER_LATEST,
    });
    expect(
      database.query<{ status: string; version: number }>(
        `SELECT status, version FROM event_role_invitations WHERE id = '${readded.id}'`,
      )[0],
    ).toEqual({ status: "pending", version: 1 });
  });

  it("rejects pending acceptance after the verified account email no longer matches", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-pending-email-change",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      role: "reviewer",
    });
    database.run(
      `UPDATE auth_users SET email = 'reviewer-new@example.test', updated_at = '${LATER}'
        WHERE id = 'reviewer-account'`,
    );
    const service = new EventInvitationService(repository, { clock: () => new Date(LATER) });

    await expect(
      service.accept(
        {
          kind: "user",
          userId: "reviewer-account",
          email: "reviewer-new@example.test",
          emailVerified: true,
        },
        { invitationId: "invite-pending-email-change", expectedVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(
      database.query<{ status: string; version: number }>(
        `SELECT status, version FROM event_role_invitations
          WHERE id = 'invite-pending-email-change'`,
      )[0],
    ).toEqual({ status: "pending", version: 1 });
  });

  it("keeps accepted reviewer and speaker authority account-bound across verified email changes", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-reviewer-email-change",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      role: "reviewer",
    });
    invite(database, {
      id: "invite-speaker-email-change",
      recipientUserId: "speaker-account",
      normalizedEmail: "speaker@example.test",
      role: "speaker",
      participantId: "participant-a",
    });
    await repository.accept(
      transition("invite-reviewer-email-change", "reviewer-account", "reviewer@example.test", 1),
    );
    await repository.accept(
      transition("invite-speaker-email-change", "speaker-account", "speaker@example.test", 1),
    );

    database.executeScript(`
      UPDATE auth_users SET email = 'reviewer-new@example.test', updated_at = '${LATER}'
       WHERE id = 'reviewer-account';
      UPDATE auth_users SET email = 'speaker-new@example.test', updated_at = '${LATER}'
       WHERE id = 'speaker-account';
    `);

    await expect(
      repository.listAcceptedReviewerEventIds("org-a", "reviewer-account"),
    ).resolves.toEqual(["event-a"]);
    await expect(
      repository.listForVerifiedAccount("reviewer-account", "reviewer-new@example.test"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "invite-reviewer-email-change",
        status: "accepted",
        normalizedEmail: "reviewer@example.test",
      }),
    ]);
    await expect(
      repository.listForVerifiedAccount("speaker-account", "speaker-new@example.test"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "invite-speaker-email-change",
        status: "accepted",
        normalizedEmail: "speaker@example.test",
      }),
    ]);
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-a' AND user_id = 'speaker-account' AND revoked_at IS NULL",
      ),
    ).toBe(1);
    expect(
      database.query<{ claimed_user_id: string | null }>(
        "SELECT claimed_user_id FROM participants WHERE id = 'participant-a'",
      )[0]?.claimed_user_id,
    ).toBe("speaker-account");

    database.run(
      `UPDATE auth_users SET email_verified = 0, updated_at = '${LATER}'
        WHERE id = 'speaker-account'`,
    );
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-a' AND user_id = 'speaker-account' AND revoked_at IS NULL",
      ),
    ).toBe(0);
    expect(
      database.query<{ claimed_user_id: string | null }>(
        "SELECT claimed_user_id FROM participants WHERE id = 'participant-a'",
      )[0]?.claimed_user_id,
    ).toBeNull();

    database.run(
      `UPDATE auth_users SET email_verified = 1, updated_at = '${LATER}'
        WHERE id = 'speaker-account'`,
    );
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-a' AND user_id = 'speaker-account' AND revoked_at IS NULL",
      ),
    ).toBe(1);
    expect(
      database.query<{ claimed_user_id: string | null }>(
        "SELECT claimed_user_id FROM participants WHERE id = 'participant-a'",
      )[0]?.claimed_user_id,
    ).toBe("speaker-account");
  });

  it("accepts idempotently without rewriting a pre-created reviewer assignment", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-reviewer",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      role: "reviewer",
    });
    const before = database.query<Record<string, unknown>>(
      "SELECT * FROM review_assignments WHERE id = 'assignment-a'",
    )[0];
    const pending = await invitation(
      repository,
      "invite-reviewer",
      "reviewer-account",
      "reviewer@example.test",
    );
    const input = transition(
      pending.id,
      pending.recipientUserId,
      pending.normalizedEmail ?? pending.recipientEmail,
      pending.version,
    );

    const first = await repository.accept(input);
    const replay = await repository.accept(input);

    expect(replay).toEqual(first);
    expect(
      database.query<{
        status: string;
        accepted_by_user_id: string;
        accepted_at: string;
        version: number;
      }>(
        `SELECT status, accepted_by_user_id, accepted_at, version
           FROM event_role_invitations WHERE id = 'invite-reviewer'`,
      )[0],
    ).toEqual({
      status: "accepted",
      accepted_by_user_id: "reviewer-account",
      accepted_at: LATER,
      version: 2,
    });
    expect(
      database.query<Record<string, unknown>>(
        "SELECT * FROM review_assignments WHERE id = 'assignment-a'",
      )[0],
    ).toEqual(before);
    expect(
      count(
        database,
        "audit_events",
        "resource_type = 'event_role_invitation' AND resource_id = 'invite-reviewer' AND action = 'accepted'",
      ),
    ).toBe(1);
  });

  it("supports one verified speaker account across multiple participants in the same event", async () => {
    const { database, repository } = fixture();
    database.executeScript(`
      INSERT INTO participants
        (id,organization_id,event_id,first_name,last_name,display_name,email,normalized_email,
         identity_state,source_type,source_id,claimed_user_id,version,created_at,updated_at)
      VALUES
        ('participant-b','org-a','event-a','Speaker','Two','Speaker Two',
         'speaker-two@example.test','speaker-two@example.test','resolved','manual',NULL,NULL,1,
         '${NOW}','${NOW}');
      INSERT INTO speaker_profiles
        (id,organization_id,event_id,participant_id,display_name,email,job_title,company,status,
         biography,social_links_json,travel_required,arrival_at,departure_at,accommodation,
         dietary_requirements,accessibility_needs,travel_notes,headshot_asset_id,source_type,
         source_id,version,created_at,updated_at,admitted_by_account_id,admitted_at)
      VALUES
        ('profile-b','org-a','event-a','participant-b','Speaker Two','speaker-two@example.test',
         '','','active','','{}',0,NULL,NULL,'','','','',NULL,'manual',NULL,1,
         '${NOW}','${NOW}','organizer-a','${NOW}');
    `);
    const createSpeaker = (id: string, participantId: string, normalizedEmail: string) =>
      repository.create({
        id,
        organizationId: "org-a",
        eventId: "event-a",
        role: "speaker",
        recipientUserId: "speaker-account",
        normalizedEmail,
        participantId,
        creationIdempotencyKey: `speaker-multi:${participantId}`,
        invitedByActorType: "user",
        invitedByActorId: "organizer-a",
        invitedAt: NOW,
      });
    const first = await createSpeaker(
      "invite-speaker-multi-a",
      "participant-a",
      "speaker@example.test",
    );

    await repository.accept(
      transition(first.id, "speaker-account", "speaker@example.test", first.version),
    );
    database.run(`
      UPDATE auth_users
         SET email = 'speaker-two@example.test', updated_at = '${LATER}'
       WHERE id = 'speaker-account'
    `);
    const second = await createSpeaker(
      "invite-speaker-multi-b",
      "participant-b",
      "speaker-two@example.test",
    );
    await repository.accept(
      transition(second.id, "speaker-account", "speaker-two@example.test", second.version),
    );

    expect(
      count(
        database,
        "event_role_invitations",
        "recipient_user_id = 'speaker-account' AND role = 'speaker' AND status = 'accepted'",
      ),
    ).toBe(2);
    expect(
      count(
        database,
        "participant_grants",
        "user_id = 'speaker-account' AND event_id = 'event-a' AND revoked_at IS NULL",
      ),
    ).toBe(2);
    await expect(
      repository.listForVerifiedAccount("speaker-account", "speaker-two@example.test"),
    ).resolves.toEqual([
      expect.objectContaining({ participantId: "participant-a", status: "accepted" }),
      expect.objectContaining({ participantId: "participant-b", status: "accepted" }),
    ]);
  });

  it("links an existing speaker participant and never duplicates its grant, profile, session, or task", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-speaker",
      recipientUserId: "speaker-account",
      normalizedEmail: "speaker@example.test",
      role: "speaker",
      participantId: "participant-a",
    });

    expect(
      database.query<{ claimed_user_id: string | null }>(
        "SELECT claimed_user_id FROM participants WHERE id = 'participant-a'",
      )[0]?.claimed_user_id,
    ).toBeNull();
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-a' AND user_id = 'speaker-account' AND revoked_at IS NULL",
      ),
    ).toBe(0);

    const pending = await invitation(
      repository,
      "invite-speaker",
      "speaker-account",
      "speaker@example.test",
    );
    const input = transition(
      pending.id,
      pending.recipientUserId,
      pending.normalizedEmail ?? pending.recipientEmail,
      pending.version,
    );
    await repository.accept(input);
    await repository.accept(input);

    expect(
      database.query<{ claimed_user_id: string | null }>(
        "SELECT claimed_user_id FROM participants WHERE id = 'participant-a'",
      )[0]?.claimed_user_id,
    ).toBe("speaker-account");
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-a' AND user_id = 'speaker-account' AND revoked_at IS NULL",
      ),
    ).toBe(1);
    expect(count(database, "speaker_profiles", "participant_id = 'participant-a'")).toBe(1);
    expect(count(database, "sessions", "id = 'session-a'")).toBe(1);
    expect(count(database, "session_speakers", "speaker_id = 'participant-a'")).toBe(1);
    expect(count(database, "speaker_tasks", "participant_id = 'participant-a'")).toBe(1);
    expect(
      database.query<{ id: string; version: number; biography: string }>(
        "SELECT id, version, biography FROM speaker_profiles WHERE participant_id = 'participant-a'",
      )[0],
    ).toEqual({ id: "profile-a", version: 1, biography: "Existing biography." });
    expect(
      database.query<{ id: string; version: number; status: string }>(
        "SELECT id, version, status FROM speaker_tasks WHERE participant_id = 'participant-a'",
      )[0],
    ).toEqual({ id: "task-a", version: 1, status: "not_started" });
  });

  it("revokes pending and accepted speaker invitations when their profiles are revoked", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-speaker-profile-revoked",
      recipientUserId: "speaker-account",
      normalizedEmail: "speaker@example.test",
      role: "speaker",
      participantId: "participant-a",
    });
    await repository.accept(
      transition("invite-speaker-profile-revoked", "speaker-account", "speaker@example.test", 1),
    );
    database.executeScript(`
      INSERT INTO participants
        (id,organization_id,event_id,first_name,last_name,display_name,email,normalized_email,
         identity_state,source_type,source_id,claimed_user_id,version,created_at,updated_at)
      VALUES
        ('participant-pending-revoke','org-a','event-a','Other','Person','Other Person',
         'other@example.test','other@example.test','resolved','manual',NULL,NULL,1,'${NOW}','${NOW}');
      INSERT INTO speaker_profiles
        (id,organization_id,event_id,participant_id,display_name,email,job_title,company,status,
         biography,social_links_json,travel_required,arrival_at,departure_at,accommodation,
         dietary_requirements,accessibility_needs,travel_notes,headshot_asset_id,source_type,
         source_id,version,created_at,updated_at,admitted_by_account_id,admitted_at)
      VALUES
        ('profile-pending-revoke','org-a','event-a','participant-pending-revoke','Other Person',
         'other@example.test','','','active','','{}',0,NULL,NULL,'','','','',NULL,
         'manual',NULL,1,'${NOW}','${NOW}','organizer-a','${NOW}');
    `);
    invite(database, {
      id: "invite-speaker-pending-profile-revoked",
      recipientUserId: "other-account",
      normalizedEmail: "other@example.test",
      role: "speaker",
      participantId: "participant-pending-revoke",
    });
    const sessionBefore = database.query<Record<string, unknown>>(
      "SELECT * FROM sessions WHERE id = 'session-a'",
    )[0];
    const taskBefore = database.query<Record<string, unknown>>(
      "SELECT * FROM speaker_tasks WHERE id = 'task-a'",
    )[0];

    database.executeScript(`
      UPDATE speaker_profiles SET status = 'revoked', updated_at = '${LATER}'
       WHERE id = 'profile-a';
      UPDATE speaker_profiles SET status = 'revoked', updated_at = '${LATER}'
       WHERE id = 'profile-pending-revoke';
    `);

    expect(
      database.query<{
        id: string;
        status: string;
        revoked_by_actor_type: string;
        revoked_at: string;
        version: number;
      }>(
        `SELECT id, status, revoked_by_actor_type, revoked_at, version
           FROM event_role_invitations
          WHERE id IN ('invite-speaker-profile-revoked',
                       'invite-speaker-pending-profile-revoked')
          ORDER BY id`,
      ),
    ).toEqual([
      {
        id: "invite-speaker-pending-profile-revoked",
        status: "revoked",
        revoked_by_actor_type: "system",
        revoked_at: LATER,
        version: 2,
      },
      {
        id: "invite-speaker-profile-revoked",
        status: "revoked",
        revoked_by_actor_type: "system",
        revoked_at: LATER,
        version: 3,
      },
    ]);
    expect(
      database.query<{ resource_id: string; action: string; actor_type: string }>(
        `SELECT resource_id, action, actor_type FROM audit_events
          WHERE resource_id IN ('invite-speaker-profile-revoked',
                                'invite-speaker-pending-profile-revoked')
            AND action = 'revoked'
          ORDER BY resource_id`,
      ),
    ).toEqual([
      {
        resource_id: "invite-speaker-pending-profile-revoked",
        action: "revoked",
        actor_type: "system",
      },
      {
        resource_id: "invite-speaker-profile-revoked",
        action: "revoked",
        actor_type: "system",
      },
    ]);
    await expect(
      repository.listForVerifiedAccount("speaker-account", "speaker@example.test"),
    ).resolves.toEqual([]);
    expect(
      database.query<Record<string, unknown>>("SELECT * FROM sessions WHERE id = 'session-a'")[0],
    ).toEqual(sessionBefore);
    expect(
      database.query<Record<string, unknown>>("SELECT * FROM speaker_tasks WHERE id = 'task-a'")[0],
    ).toEqual(taskBefore);
    expect(count(database, "participants", "id = 'participant-a'")).toBe(1);
  });

  it("revokes the prior speaker account when the organizer reassigns the profile email", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-speaker-reassigned",
      recipientUserId: "speaker-account",
      normalizedEmail: "speaker@example.test",
      role: "speaker",
      participantId: "participant-a",
    });
    await repository.accept(
      transition("invite-speaker-reassigned", "speaker-account", "speaker@example.test", 1),
    );
    const sessionBefore = database.query<Record<string, unknown>>(
      "SELECT * FROM sessions WHERE id = 'session-a'",
    )[0];
    const taskBefore = database.query<Record<string, unknown>>(
      "SELECT * FROM speaker_tasks WHERE id = 'task-a'",
    )[0];

    database.run(
      `UPDATE speaker_profiles
          SET email = 'other@example.test', updated_at = '${LATER}'
        WHERE id = 'profile-a'`,
    );

    expect(
      database.query<{
        status: string;
        revoked_by_actor_type: string;
        revoked_at: string;
        version: number;
      }>(
        `SELECT status, revoked_by_actor_type, revoked_at, version
           FROM event_role_invitations WHERE id = 'invite-speaker-reassigned'`,
      )[0],
    ).toEqual({
      status: "revoked",
      revoked_by_actor_type: "system",
      revoked_at: LATER,
      version: 3,
    });
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-a' AND user_id = 'speaker-account' AND revoked_at IS NULL",
      ),
    ).toBe(0);
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-a' AND user_id = 'other-account' AND revoked_at IS NULL",
      ),
    ).toBe(0);
    expect(
      count(
        database,
        "audit_events",
        "resource_id = 'invite-speaker-reassigned' AND action = 'revoked' AND actor_type = 'system'",
      ),
    ).toBe(1);

    const service = new EventInvitationService(repository, { clock: () => new Date(LATER) });
    await expect(
      service.list({
        kind: "user",
        userId: "other-account",
        email: "other@example.test",
        emailVerified: true,
      }),
    ).resolves.toEqual([]);
    invite(database, {
      id: "invite-speaker-explicit-reassignment",
      recipientUserId: "other-account",
      normalizedEmail: "other@example.test",
      role: "speaker",
      participantId: "participant-a",
    });
    const [pending] = await service.list({
      kind: "user",
      userId: "other-account",
      email: "other@example.test",
      emailVerified: true,
    });
    expect(pending).toMatchObject({ role: "speaker", status: "pending", eventId: "event-a" });
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-a' AND user_id = 'other-account' AND revoked_at IS NULL",
      ),
    ).toBe(0);
    if (pending === undefined)
      throw new Error("Expected an explicit reassigned speaker invitation.");
    await repository.accept(
      transition(pending.invitationId, "other-account", "other@example.test", pending.version),
    );
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-a' AND user_id = 'other-account' AND revoked_at IS NULL",
      ),
    ).toBe(1);
    expect(
      database.query<{ claimed_user_id: string | null }>(
        "SELECT claimed_user_id FROM participants WHERE id = 'participant-a'",
      )[0]?.claimed_user_id,
    ).toBe("other-account");
    expect(
      database.query<Record<string, unknown>>("SELECT * FROM sessions WHERE id = 'session-a'")[0],
    ).toEqual(sessionBefore);
    expect(
      database.query<Record<string, unknown>>("SELECT * FROM speaker_tasks WHERE id = 'task-a'")[0],
    ).toEqual(taskBefore);
    expect(count(database, "speaker_profiles", "id = 'profile-a'")).toBe(1);
  });

  it("keeps decline terminal without creating speaker authorization", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-declined",
      recipientUserId: "speaker-account",
      normalizedEmail: "speaker@example.test",
      role: "speaker",
      participantId: "participant-a",
    });
    const pending = await invitation(
      repository,
      "invite-declined",
      "speaker-account",
      "speaker@example.test",
    );
    const declined = await repository.decline(
      transition(
        pending.id,
        pending.recipientUserId,
        pending.normalizedEmail ?? pending.recipientEmail,
        pending.version,
      ),
    );
    if (declined === null) throw new Error("Expected the speaker invitation to be declined.");

    await expect(
      repository.accept(
        transition(
          declined.id,
          declined.recipientUserId,
          declined.normalizedEmail ?? declined.recipientEmail,
          declined.version,
        ),
      ),
    ).rejects.toMatchObject({ name: "EventRoleInvitationRepositoryConflictError" });
    await repository.reconcileForVerifiedAccount({
      recipientUserId: "speaker-account",
      normalizedEmail: "speaker@example.test",
      occurredAt: LATER,
    });
    expect(
      database.query<{ status: string; accepted_at: string | null; declined_at: string }>(
        `SELECT status, accepted_at, declined_at
           FROM event_role_invitations WHERE id = 'invite-declined'`,
      )[0],
    ).toEqual({ status: "declined", accepted_at: null, declined_at: LATER });
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-a' AND user_id = 'speaker-account' AND revoked_at IS NULL",
      ),
    ).toBe(0);
    expect(
      count(
        database,
        "event_role_invitations",
        "recipient_user_id = 'speaker-account' AND participant_id = 'participant-a'",
      ),
    ).toBe(1);
  });

  it("requires an explicit organizer speaker invitation despite matching CRM profile data", async () => {
    const { database, repository } = fixture();
    database.executeScript(`
      INSERT INTO participants
        (id,organization_id,event_id,first_name,last_name,display_name,email,normalized_email,
         identity_state,source_type,source_id,claimed_user_id,version,created_at,updated_at)
      VALUES
        ('participant-late','org-a','event-a','Late','Person','Late Person',
         'unverified@example.test','unverified@example.test','resolved','crm','contact-late',NULL,1,
         '${NOW}','${NOW}');
      INSERT INTO speaker_profiles
        (id,organization_id,event_id,participant_id,display_name,email,job_title,company,status,
         biography,social_links_json,travel_required,arrival_at,departure_at,accommodation,
         dietary_requirements,accessibility_needs,travel_notes,headshot_asset_id,source_type,
         source_id,version,created_at,updated_at,admitted_by_account_id,admitted_at)
      VALUES
        ('profile-late','org-a','event-a','participant-late','Late Person',
         'unverified@example.test','','','pending','','{}',0,NULL,NULL,'','','','',NULL,
         'crm','contact-late',1,'${NOW}','${NOW}',NULL,NULL);
    `);
    addReviewerPool(database, {
      roundId: "round-late",
      poolId: "pool-late",
      reviewerId: "unverified-account",
      sequence: 1,
    });
    addLegacyMemberInvitation(database, {
      id: "member-invite-late",
      userId: "unverified-account",
      email: "unverified@example.test",
      status: "pending",
    });
    const service = new EventInvitationService(repository, { clock: () => new Date(LATER) });
    const actor = {
      kind: "user" as const,
      userId: "unverified-account",
      email: "unverified@example.test",
      emailVerified: true,
    };

    await expect(service.list({ ...actor, emailVerified: false })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    database.run(
      `UPDATE auth_users SET email_verified = 1, updated_at = '${LATER}'
       WHERE id = 'unverified-account'`,
    );

    await expect(service.list(actor)).resolves.toEqual([
      expect.objectContaining({ role: "reviewer", status: "pending", eventId: "event-a" }),
    ]);
    await expect(
      repository.findForVerifiedAccount(
        "reconciled:speaker:org-a:event-a:participant-late:unverified-account",
        actor.userId,
        actor.email,
      ),
    ).resolves.toBeNull();
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-late' AND user_id = 'unverified-account' AND revoked_at IS NULL",
      ),
    ).toBe(0);

    const speaker = await repository.create({
      id: "invite-late-speaker",
      organizationId: "org-a",
      eventId: "event-a",
      role: "speaker",
      recipientUserId: actor.userId,
      normalizedEmail: actor.email,
      participantId: "participant-late",
      creationIdempotencyKey: "organizer:invite-late-speaker",
      invitedByActorType: "user",
      invitedByActorId: "organizer-a",
      invitedAt: LATER,
    });
    await expect(service.list(actor)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ invitationId: speaker.id, role: "speaker", status: "pending" }),
      ]),
    );
    await expect(
      service.accept(actor, { invitationId: speaker.id, expectedVersion: speaker.version }),
    ).resolves.toMatchObject({ invitationId: speaker.id, status: "accepted" });
    expect(
      count(
        database,
        "participant_grants",
        "participant_id = 'participant-late' AND user_id = 'unverified-account' AND revoked_at IS NULL",
      ),
    ).toBe(1);
  });

  it("reconciles an active organization reviewer membership with existing pool access", async () => {
    const { database, repository } = fixture();
    addReviewerPool(database, {
      roundId: "round-active-member",
      poolId: "pool-active-member",
      reviewerId: "reviewer-account",
      sequence: 1,
    });
    const service = new EventInvitationService(repository, { clock: () => new Date(LATER) });

    await expect(
      service.list({
        kind: "user",
        userId: "reviewer-account",
        email: "reviewer@example.test",
        emailVerified: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ role: "reviewer", status: "pending", eventId: "event-a" }),
    ]);
  });

  it("reconciles only a reviewer pool grant newer than the latest terminal invitation", async () => {
    const { database, repository } = fixture();
    addReviewerPool(database, {
      roundId: "round-reviewer-regeneration",
      poolId: "pool-reviewer-regeneration",
      reviewerId: "reviewer-account",
      sequence: 1,
    });
    const service = new EventInvitationService(repository, { clock: () => new Date(LATEST) });
    const actor = {
      kind: "user" as const,
      userId: "reviewer-account",
      email: "reviewer@example.test",
      emailVerified: true,
    };
    const first = await service.list(actor);
    const firstReviewer = first.find((candidate) => candidate.role === "reviewer");
    if (firstReviewer === undefined) throw new Error("Expected the first reviewer invitation.");
    await repository.revokeEventReviewerInvitationIfNoPoolGrantsRemain({
      organizationId: "org-a",
      eventId: "event-a",
      excludedRoundId: "round-reviewer-regeneration",
      recipientUserId: "reviewer-account",
      revokedByActorType: "user",
      revokedByActorId: "organizer-a",
      occurredAt: LATER,
    });

    await expect(service.list(actor)).resolves.toEqual([]);

    database.executeScript(`
      DELETE FROM reviewer_pool_members
       WHERE organization_id = 'org-a' AND event_id = 'event-a'
         AND pool_id = 'pool-reviewer-regeneration' AND reviewer_id = 'reviewer-account';
      UPDATE reviewer_pools SET version = version + 1, updated_at = '${LATEST}'
       WHERE id = 'pool-reviewer-regeneration';
      INSERT INTO reviewer_pool_members
        (organization_id,event_id,pool_id,reviewer_id,granted_at)
      VALUES (
        'org-a','event-a','pool-reviewer-regeneration','reviewer-account','${LATEST}'
      );
    `);

    const regenerated = await service.list(actor);
    const pending = regenerated.find((candidate) => candidate.role === "reviewer");
    if (pending === undefined) throw new Error("Expected the regenerated reviewer invitation.");
    expect(pending).toMatchObject({ status: "pending", eventId: "event-a" });
    expect(pending.invitationId).not.toBe(firstReviewer.invitationId);
    await expect(
      repository.accept(
        transition(
          pending.invitationId,
          "reviewer-account",
          "reviewer@example.test",
          pending.version,
        ),
      ),
    ).resolves.toMatchObject({ id: pending.invitationId, status: "accepted" });
    expect(
      count(
        database,
        "event_role_invitations",
        "recipient_user_id = 'reviewer-account' AND role = 'reviewer'",
      ),
    ).toBe(2);
  });

  it("does not reconcile a revoked legacy reviewer member invitation after verification", async () => {
    const { database, repository } = fixture();
    addReviewerPool(database, {
      roundId: "round-revoked-member",
      poolId: "pool-revoked-member",
      reviewerId: "unverified-account",
      sequence: 1,
    });
    addLegacyMemberInvitation(database, {
      id: "member-invite-revoked",
      userId: "unverified-account",
      email: "unverified@example.test",
      status: "revoked",
    });
    database.run(
      `INSERT INTO auth_verifications
        (id,identifier,token_digest,expires_at,created_at,updated_at)
       VALUES
        ('malformed-member-envelope','not-json','token:malformed-member-envelope',
         '2027-08-16T12:00:00.000Z','${NOW}','${NOW}')`,
    );
    database.run(
      `UPDATE auth_users SET email_verified = 1, updated_at = '${LATER}'
        WHERE id = 'unverified-account'`,
    );
    const service = new EventInvitationService(repository, { clock: () => new Date(LATER) });

    await expect(
      service.list({
        kind: "user",
        userId: "unverified-account",
        email: "unverified@example.test",
        emailVerified: true,
      }),
    ).resolves.toEqual([]);
    expect(
      count(
        database,
        "event_role_invitations",
        "recipient_user_id = 'unverified-account' AND role = 'reviewer'",
      ),
    ).toBe(0);
    expect(
      count(
        database,
        "reviewer_pool_members",
        "reviewer_id = 'unverified-account' AND pool_id = 'pool-revoked-member'",
      ),
    ).toBe(1);
  });

  it("rejects a surviving pending reviewer invitation after its legacy member invitation is revoked", async () => {
    const { database, repository } = fixture();
    addReviewerPool(database, {
      roundId: "round-revoked-before-accept",
      poolId: "pool-revoked-before-accept",
      reviewerId: "unverified-account",
      sequence: 1,
    });
    addLegacyMemberInvitation(database, {
      id: "member-invite-revoked-before-accept",
      userId: "unverified-account",
      email: "unverified@example.test",
      status: "pending",
    });
    database.run(
      `UPDATE auth_users SET email_verified = 1, updated_at = '${LATER}'
        WHERE id = 'unverified-account'`,
    );
    const service = new EventInvitationService(repository, { clock: () => new Date(LATER) });
    const actor = {
      kind: "user" as const,
      userId: "unverified-account",
      email: "unverified@example.test",
      emailVerified: true,
    };
    const [pending] = await service.list(actor);
    if (pending === undefined) throw new Error("Expected a reconciled reviewer invitation.");
    database.run(
      `UPDATE auth_verifications
          SET identifier = json_set(identifier, '$.invitation.status', 'revoked'),
              updated_at = '${LATER}'
        WHERE id = 'member-invite-revoked-before-accept'`,
    );

    await expect(
      repository.accept(
        transition(pending.invitationId, "unverified-account", "unverified@example.test", 1),
      ),
    ).rejects.toMatchObject({ name: "EventRoleInvitationRepositoryConflictError" });
    expect(
      database.query<{ status: string; version: number }>(
        `SELECT status, version FROM event_role_invitations WHERE id = '${pending.invitationId}'`,
      )[0],
    ).toEqual({ status: "pending", version: 1 });
    expect(
      count(
        database,
        "organization_memberships",
        "organization_id = 'org-a' AND user_id = 'unverified-account'",
      ),
    ).toBe(0);
    expect(count(database, "participant_grants", "user_id = 'unverified-account'")).toBe(0);
    expect(count(database, "audit_events", `resource_id = '${pending.invitationId}'`)).toBe(0);
  });

  it("revokes the exact reviewer event invitation without changing assignments or history", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-exact-reviewer",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      role: "reviewer",
    });
    const before = database.query<Record<string, unknown>>(
      "SELECT * FROM review_assignments WHERE id = 'assignment-a'",
    )[0];
    await repository.accept(
      transition("invite-exact-reviewer", "reviewer-account", "reviewer@example.test", 1),
    );

    await expect(
      repository.revokeEventReviewerInvitationIfNoPoolGrantsRemain({
        organizationId: "org-a",
        eventId: "event-a",
        excludedRoundId: "round-a",
        recipientUserId: "reviewer-account",
        revokedByActorType: "user",
        revokedByActorId: "organizer-a",
        occurredAt: LATER,
      }),
    ).resolves.toBe(true);

    expect(
      database.query<{ status: string; accepted_at: string; revoked_at: string; version: number }>(
        `SELECT status, accepted_at, revoked_at, version
           FROM event_role_invitations WHERE id = 'invite-exact-reviewer'`,
      )[0],
    ).toEqual({ status: "revoked", accepted_at: LATER, revoked_at: LATER, version: 3 });
    expect(
      database.query<Record<string, unknown>>(
        "SELECT * FROM review_assignments WHERE id = 'assignment-a'",
      )[0],
    ).toEqual(before);
    expect(
      database.query<{ action: string }>(
        `SELECT action FROM audit_events
          WHERE resource_id = 'invite-exact-reviewer' ORDER BY sequence`,
      ),
    ).toEqual([{ action: "accepted" }, { action: "revoked" }]);
  });

  it("retains an event reviewer invitation while any round still grants pool access", async () => {
    const { database, repository } = fixture();
    addReviewerPool(database, {
      roundId: "round-pool-a",
      poolId: "pool-a",
      reviewerId: "reviewer-account",
      sequence: 1,
    });
    addReviewerPool(database, {
      roundId: "round-pool-b",
      poolId: "pool-b",
      reviewerId: "reviewer-account",
      sequence: 2,
    });
    invite(database, {
      id: "invite-multi-round",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      role: "reviewer",
    });
    const revoke = (excludedRoundId: string) =>
      repository.revokeEventReviewerInvitationIfNoPoolGrantsRemain({
        organizationId: "org-a",
        eventId: "event-a",
        excludedRoundId,
        recipientUserId: "reviewer-account",
        revokedByActorType: "system",
        occurredAt: LATER,
      });

    await expect(revoke("round-pool-a")).resolves.toBe(false);
    database.run("DELETE FROM reviewer_pool_members WHERE pool_id = 'pool-a'");
    expect(
      count(database, "event_role_invitations", "id = 'invite-multi-round' AND status = 'pending'"),
    ).toBe(1);

    await expect(revoke("round-pool-b")).resolves.toBe(true);
    database.run("DELETE FROM reviewer_pool_members WHERE pool_id = 'pool-b'");
    expect(
      count(database, "event_role_invitations", "id = 'invite-multi-round' AND status = 'revoked'"),
    ).toBe(1);
  });

  it("revokes every live reviewer invitation for an organization user", async () => {
    const { database, repository } = fixture();
    addEvent(database, "event-c");
    invite(database, {
      id: "invite-member-a",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      role: "reviewer",
    });
    invite(database, {
      id: "invite-member-c",
      eventId: "event-c",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      role: "reviewer",
    });
    await repository.accept(
      transition("invite-member-a", "reviewer-account", "reviewer@example.test", 1),
    );

    await expect(
      repository.revokeReviewerInvitationsForOrganizationUser({
        organizationId: "org-a",
        recipientUserId: "reviewer-account",
        revokedByActorType: "user",
        revokedByActorId: "organizer-a",
        occurredAt: LATER,
      }),
    ).resolves.toBe(2);
    expect(
      database.query<{ id: string; status: string }>(
        `SELECT id, status FROM event_role_invitations
          WHERE id IN ('invite-member-a','invite-member-c') ORDER BY id`,
      ),
    ).toEqual([
      { id: "invite-member-a", status: "revoked" },
      { id: "invite-member-c", status: "revoked" },
    ]);
    expect(count(database, "review_assignments", "id = 'assignment-a'")).toBe(1);
  });

  it("persists one matching terminal audit for concurrent opposite transitions", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-race",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      role: "reviewer",
    });
    const input = transition("invite-race", "reviewer-account", "reviewer@example.test", 1);

    const results = await Promise.allSettled([repository.accept(input), repository.decline(input)]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { name: "EventRoleInvitationRepositoryConflictError" },
    });
    expect(
      database.query<{ status: string; version: number }>(
        "SELECT status, version FROM event_role_invitations WHERE id = 'invite-race'",
      )[0],
    ).toEqual({ status: "accepted", version: 2 });
    expect(
      database.query<{ action: string; details_json: string }>(
        `SELECT action, details_json FROM audit_events
          WHERE resource_type = 'event_role_invitation' AND resource_id = 'invite-race'`,
      ),
    ).toEqual([
      { action: "accepted", details_json: '{"eventId":"event-a","role":"reviewer","version":2}' },
    ]);

    await expect(repository.accept(input)).resolves.toMatchObject({
      status: "accepted",
      version: 2,
    });
    expect(count(database, "audit_events", "resource_id = 'invite-race'")).toBe(1);
  });

  it("does not reveal another account's invitation, matching the absent-invitation boundary", async () => {
    const { database, repository } = fixture();
    invite(database, {
      id: "invite-private",
      organizationId: "org-b",
      eventId: "event-b",
      recipientUserId: "reviewer-account",
      normalizedEmail: "reviewer@example.test",
      role: "reviewer",
    });

    const crossAccount = await repository.accept(
      transition("invite-private", "other-account", "other@example.test", 1),
    );
    const absent = await repository.accept(
      transition("invite-absent", "other-account", "other@example.test", 1),
    );

    expect(crossAccount).toBeNull();
    expect(absent).toBeNull();
    expect(
      count(database, "event_role_invitations", "id = 'invite-private' AND status = 'pending'"),
    ).toBe(1);
  });
});
