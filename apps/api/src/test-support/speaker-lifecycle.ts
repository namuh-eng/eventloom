/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { SpeakerService, type SpeakerServiceOptions } from "../features/speaker/service";
import { R2PrivateAssetGateway } from "../infrastructure/cloudflare/private-assets";
import { D1SpeakerRepository } from "../infrastructure/cloudflare/repositories/speaker";
import { SqliteD1 } from "./sqlite-d1";

export const speakerLifecycleIds = {
  organizationId: "org-lifecycle",
  eventId: "event-lifecycle",
  organizerAccountId: "organizer-lifecycle",
  priyaAccountId: "priya-account",
  marcusAccountId: "marcus-account",
  acceptedAccountId: "accepted-account",
  acceptedParticipantId: "accepted-participant",
  acceptedSubmissionId: "accepted-submission",
  outsiderAccountId: "outsider-account",
  otherOrganizationId: "org-other",
  otherEventId: "event-other",
  otherOrganizerAccountId: "other-organizer",
} as const;

export const speakerLifecycleNow = "2099-08-15T04:00:00.000Z";

const migrationNames = [
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
  "0028_remove_event_status.sql",
  "0029_agenda_validation_revision.sql",
  "0033_private_download_capabilities.sql",
  "0034_program_publication_reservations.sql",
  "0035_review_plan_revision_lineage.sql",
  "0036_evaluation_export_jobs.sql",
  "0037_review_plan_lineage_repairs.sql",
  "0038_review_plan_lineage_repair_triggers.sql",
  "0039_review_plan_revision_sync_lock.sql",
  "0040_review_plan_revision_sync_token.sql",
  "0041_organization_entitlements.sql",
  "0042_idempotency_lease_fencing.sql",
  "0043_crm_pipeline_actor_name.sql",
  "0044_event_retirement_compatibility.sql",
  "0045_immutable_speaker_projection_snapshots.sql",
  "0046_speaker_asset_uploader.sql",
  "0047_speaker_asset_creation_idempotency.sql",
  "0048_speaker_task_replacement_baseline.sql",
  "0049_private_download_attribution.sql",
  "0050_private_object_cleanup.sql",
  "0051_evaluation_decision_outbox.sql",
  "0052_shared_ai_triage.sql",
  "0053_cfp_configuration_write_guards.sql",
  "0054_review_round_lineage_candidates.sql",
  "0055_speaker_task_session_subjects.sql",
  "0056_private_download_capability_subject.sql",
] as const;

class FakeR2Bucket {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  async put(
    key: string,
    body: ArrayBuffer,
    options: { httpMetadata: { contentType: string } },
  ): Promise<void> {
    this.objects.set(key, {
      body: new Uint8Array(body),
      contentType: options.httpMetadata.contentType,
    });
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object === undefined
      ? null
      : { size: object.body.byteLength, httpMetadata: { contentType: object.contentType } };
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    const body = object.body.slice();
    return {
      size: body.byteLength,
      httpMetadata: { contentType: object.contentType },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      async arrayBuffer() {
        return body.slice().buffer;
      },
    };
  }
}

function migration(name: string): string {
  return readFileSync(join(process.cwd(), "apps/api/migrations", name), "utf8");
}

function seedDatabase(database: SqliteD1): void {
  const ids = speakerLifecycleIds;
  for (const name of migrationNames) database.executeScript(migration(name));
  database.executeScript(`
    INSERT INTO auth_users (id,email,email_verified,name,created_at,updated_at) VALUES
      ('${ids.organizerAccountId}','organizer@example.test',1,'Organizer','${speakerLifecycleNow}','${speakerLifecycleNow}'),
      ('${ids.priyaAccountId}','priya@example.test',1,'Priya Nair','${speakerLifecycleNow}','${speakerLifecycleNow}'),
      ('${ids.marcusAccountId}','marcus@example.test',1,'Marcus Chen','${speakerLifecycleNow}','${speakerLifecycleNow}'),
      ('${ids.acceptedAccountId}','accepted@example.test',1,'Accepted Speaker','${speakerLifecycleNow}','${speakerLifecycleNow}'),
      ('${ids.outsiderAccountId}','outsider@example.test',1,'Outsider','${speakerLifecycleNow}','${speakerLifecycleNow}'),
      ('${ids.otherOrganizerAccountId}','other-organizer@example.test',1,'Other Organizer','${speakerLifecycleNow}','${speakerLifecycleNow}');
    INSERT INTO organizations (organization_id,slug,name,config_json,created_at,updated_at) VALUES
      ('${ids.organizationId}','lifecycle','Lifecycle Org','{}','${speakerLifecycleNow}','${speakerLifecycleNow}'),
      ('${ids.otherOrganizationId}','other','Other Org','{}','${speakerLifecycleNow}','${speakerLifecycleNow}');
    INSERT INTO organization_memberships (organization_id,user_id,role,created_at,updated_at) VALUES
      ('${ids.organizationId}','${ids.organizerAccountId}','owner','${speakerLifecycleNow}','${speakerLifecycleNow}'),
      ('${ids.otherOrganizationId}','${ids.otherOrganizerAccountId}','owner','${speakerLifecycleNow}','${speakerLifecycleNow}');
    INSERT INTO events (id,organization_id,slug,name,status,time_zone,starts_at,ends_at,schedule_dates_json,venue,cfp_enabled,cfp_opens_at,cfp_closes_at,default_duration_minutes,default_calendar_time_zone,default_calendar_location,version,created_at,updated_at,created_by,updated_by) VALUES
      ('${ids.eventId}','${ids.organizationId}','lifecycle-event','Lifecycle Event','active','UTC','2100-01-10T09:00:00.000Z','2100-01-10T17:00:00.000Z','["2100-01-10"]',NULL,0,NULL,NULL,30,'UTC',NULL,1,'${speakerLifecycleNow}','${speakerLifecycleNow}','${ids.organizerAccountId}','${ids.organizerAccountId}'),
      ('${ids.otherEventId}','${ids.otherOrganizationId}','other-event','Other Event','active','UTC','2100-02-10T09:00:00.000Z','2100-02-10T17:00:00.000Z','["2100-02-10"]',NULL,0,NULL,NULL,30,'UTC',NULL,1,'${speakerLifecycleNow}','${speakerLifecycleNow}','${ids.otherOrganizerAccountId}','${ids.otherOrganizerAccountId}');
    INSERT INTO cfp_forms (id,organization_id,event_id,name,status,welcome_content,speaker_limit,max_submissions_per_account,reminders_enabled,admin_notifications_enabled,confirmation_message,success_content,redirect_url,version,created_at,updated_at)
      VALUES ('accepted-form','${ids.organizationId}','${ids.eventId}','Accepted CFP','closed','',1,1,0,0,'','',NULL,1,'${speakerLifecycleNow}','${speakerLifecycleNow}');
    INSERT INTO submissions (id,organization_id,event_id,form_id,owner_account_id,form_version,status,completed_steps_json,version,created_at,updated_at,submitted_at)
      VALUES ('${ids.acceptedSubmissionId}','${ids.organizationId}','${ids.eventId}','accepted-form','${ids.acceptedAccountId}',1,'submitted','[]',1,'${speakerLifecycleNow}','${speakerLifecycleNow}','${speakerLifecycleNow}');
    INSERT INTO participants (id,organization_id,event_id,first_name,last_name,display_name,email,normalized_email,identity_state,source_type,source_id,claimed_user_id,version,created_at,updated_at)
      VALUES ('${ids.acceptedParticipantId}','${ids.organizationId}','${ids.eventId}','Accepted','Speaker','Accepted Speaker','accepted@example.test','accepted@example.test','resolved','cfp','${ids.acceptedSubmissionId}','${ids.acceptedAccountId}',1,'${speakerLifecycleNow}','${speakerLifecycleNow}');
    INSERT INTO submission_participants (organization_id,event_id,submission_id,participant_id,role,biography,answers_json,ordinal)
      VALUES ('${ids.organizationId}','${ids.eventId}','${ids.acceptedSubmissionId}','${ids.acceptedParticipantId}','primary','Accepted speaker biography.','{}',0);
    INSERT INTO review_plans (id,organization_id,event_id,name,status,blind_review,reviews_per_submission,max_assignments_per_reviewer,auto_distribute,reviewer_projection_field_ids_json,reviewer_projection_file_ids_json,version,created_at,updated_at)
      VALUES ('accepted-plan','${ids.organizationId}','${ids.eventId}','Accepted Plan','closed',0,1,1,0,'[]','[]',1,'${speakerLifecycleNow}','${speakerLifecycleNow}');
    INSERT INTO evaluation_decisions (id,organization_id,event_id,plan_id,submission_id,status,version,updated_at)
      VALUES ('accepted-decision','${ids.organizationId}','${ids.eventId}','accepted-plan','${ids.acceptedSubmissionId}','accepted',1,'${speakerLifecycleNow}');
  `);
}

export interface SpeakerLifecycleFixture {
  readonly database: SqliteD1;
  readonly privateFiles: R2Bucket;
  createPhase(options?: Pick<SpeakerServiceOptions, "eventTemporalSource" | "now">): {
    repository: D1SpeakerRepository;
    assets: R2PrivateAssetGateway;
    service: SpeakerService;
  };
  dispose(): void;
}

export function createSpeakerLifecycleFixture(): SpeakerLifecycleFixture {
  const database = new SqliteD1("eventloom-airtable-free-speaker-");
  const bucket = new FakeR2Bucket();
  let idSequence = 0;
  seedDatabase(database);
  return {
    database,
    privateFiles: bucket as unknown as R2Bucket,
    createPhase(options) {
      const repository = new D1SpeakerRepository(database as unknown as D1Database);
      const assets = new R2PrivateAssetGateway(
        bucket as unknown as R2Bucket,
        "https://api.example.test",
        database as unknown as D1Database,
      );
      return {
        repository,
        assets,
        service: new SpeakerService(repository, assets, {
          sessionAuthority: {
            async getSession() {
              return null;
            },
          },
          speakerSender: "speakers@example.test",
          now: options?.now ?? (() => new Date(speakerLifecycleNow)),
          generateId: () => `lifecycle-${++idSequence}`,
          ...(options?.eventTemporalSource === undefined
            ? {}
            : { eventTemporalSource: options.eventTemporalSource }),
        }),
      };
    },
    dispose() {
      database.dispose();
    },
  };
}

export function privateCapabilityParts(url: string): {
  capabilityId: string;
  token: string;
} {
  const segments = new URL(url, "https://api.example.test").pathname.split("/");
  const token = segments.at(-1);
  const capabilityId = segments.at(-2);
  if (capabilityId === undefined || token === undefined) {
    throw new Error("Expected an opaque private capability URL.");
  }
  return {
    capabilityId: decodeURIComponent(capabilityId),
    token: decodeURIComponent(token),
  };
}
