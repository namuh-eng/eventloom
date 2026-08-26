import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrations = resolve(root, "apps/api/migrations");
const migration = (name) => readFileSync(resolve(migrations, name), "utf8");

function databaseAt0054() {
  const database = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrations)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0055_")
    .sort()) {
    database.exec(migration(name));
  }
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec(`
    INSERT INTO organizations (organization_id,slug,name,created_at,updated_at) VALUES ('org','org','Organization','2026-01-01','2026-01-01');
    INSERT INTO events (id,organization_id,slug,name,status,time_zone,starts_at,ends_at,venue,cfp_enabled,cfp_opens_at,cfp_closes_at,default_duration_minutes,default_calendar_time_zone,default_calendar_location,version,created_at,updated_at,created_by,updated_by)
      VALUES ('event','org','event','Event','active','UTC','2027-01-01','2027-01-02',NULL,0,NULL,NULL,30,'UTC',NULL,1,'2026-01-01','2026-01-01','owner','owner');
    INSERT INTO session_statuses VALUES ('status','org','event','active','Active','',1,0,1,1,'2026-01-01','2026-01-01');
    INSERT INTO sessions VALUES
      ('direct','org','event','Direct','', 'active',NULL,30,0,NULL,NULL,NULL,1,'2026-01-01','2026-01-01','owner','owner',NULL),
      ('session-prefixed','org','event','Prefixed','', 'active',NULL,30,0,NULL,NULL,NULL,1,'2026-01-01','2026-01-01','owner','owner',NULL);
    INSERT INTO participants VALUES ('participant','org','event','First','Last','Speaker','speaker@example.test','speaker@example.test','resolved','manual',NULL,NULL,1,'2026-01-01','2026-01-01');
    INSERT INTO cfp_forms VALUES ('form','org','event','Form','published','',1,1,0,0,'','',NULL,1,'2026-01-01','2026-01-01');
    INSERT INTO submissions VALUES ('submission','org','event','form','owner',1,'submitted','[]',1,'2026-01-01','2026-01-01',NULL,NULL,NULL,NULL);
    INSERT INTO speaker_tasks (id,organization_id,event_id,submission_id,participant_id,type,owner,title,description,instructions,status,due_at,allowed_mime_types_json,max_bytes,accepted_asset_kinds_json,version,created_at,updated_at,replacement_baseline_asset_id) VALUES
      ('task-direct','org','event','direct','participant','form','speaker','Direct','','','not_started',NULL,'[]',NULL,'[]',1,'2026-01-01','2026-01-01',NULL),
      ('task-prefixed','org','event','prefixed','participant','form','speaker','Prefixed','','','not_started',NULL,'[]',NULL,'[]',1,'2026-01-01','2026-01-01',NULL),
      ('task-null','org','event',NULL,'participant','form','speaker','Null','','','not_started',NULL,'[]',NULL,'[]',1,'2026-01-01','2026-01-01',NULL);
    INSERT INTO speaker_assets (id,organization_id,event_id,submission_id,participant_id,task_id,kind,object_key,file_name,content_type,size_bytes,state,version,version_family_id,supersedes_asset_id,comment_thread_id,review_state,review_note,reviewed_at,reviewed_by,review_version,latest_version_id,current_version_id,approved_version_id,released_version_id,rejection_reason,created_at,finalized_at,uploader_account_id,uploader_label,creation_idempotency_key,creation_request_digest) VALUES
      ('asset-direct','org','event','direct','participant','task-direct','headshot','private/direct','direct.png','image/png',1,'ready',1,'family',NULL,'thread',NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,'2026-01-01',NULL,NULL,NULL,NULL,NULL),
      ('asset-prefixed','org','event','prefixed','participant','task-prefixed','slides','private/prefixed','prefixed.pdf','application/pdf',1,'ready',2,'family','asset-direct','thread',NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,'2026-01-01',NULL,NULL,NULL,NULL,NULL),
      ('asset-null','org','event',NULL,'participant','task-null','supporting_file','private/null','null.txt','text/plain',1,'ready',1,'family-null',NULL,'thread-null',NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,'2026-01-01',NULL,NULL,NULL,NULL,NULL);
    INSERT INTO speaker_task_dependencies VALUES ('org','event','task-prefixed','task-direct');
    INSERT INTO speaker_task_reminder_offsets VALUES ('org','event','task-direct',60);
    INSERT INTO speaker_task_transitions VALUES ('transition','org','event','task-direct','participant','owner','not_started','in_progress',NULL,'2026-01-01');
    INSERT INTO speaker_task_forms VALUES ('task-direct','org','event','task-direct','Form','', '[]',1,1,'2026-01-01');
    INSERT INTO speaker_task_responses VALUES ('response','org','event','task-direct','participant',1,'{}','submitted',1,NULL,'2026-01-01','2026-01-01');
    INSERT INTO submission_answers VALUES ('org','submission','answer','{}','asset-direct');
    INSERT INTO speaker_asset_comments VALUES ('comment','org','event','asset-direct','asset-direct','Comment','Owner',NULL,1,'2026-01-01','2026-01-01');
    INSERT INTO speaker_content (id,organization_id,event_id,entity_type,entity_id,title,description,abstract,biography,social_links_json,headshot_asset_id,status,version,updated_at,updated_by) VALUES ('content','org','event','speaker','participant',NULL,NULL,NULL,NULL,NULL,'asset-direct',NULL,1,'2026-01-01','owner');
    INSERT INTO speaker_profiles (id,organization_id,event_id,participant_id,display_name,email,job_title,company,status,biography,social_links_json,travel_required,accommodation,dietary_requirements,accessibility_needs,travel_notes,headshot_asset_id,version,created_at,updated_at) VALUES ('profile','org','event','participant','Speaker',NULL,'','','pending','','{}',0,'','','','','asset-direct',1,'2026-01-01','2026-01-01');
    INSERT INTO speaker_roster (id,organization_id,event_id,submission_id,participant_id,role,status,workflow_status,organizer_status,display_name,email,job_title,company,biography,social_links_json,travel_logistics_json,headshot_asset_id,source_type,source_id,version,created_at,updated_at,author_account_id) VALUES ('roster','org','event','submission','participant','primary','active',NULL,NULL,'Speaker',NULL,'','','','{}','{}','asset-direct',NULL,NULL,1,'2026-01-01','2026-01-01',NULL);
    INSERT INTO private_download_capabilities (id,asset_id,tenant_id,object_key,content_type,byte_size,file_name,token_digest,expires_at,consumed_at,created_at) VALUES ('capability','asset-direct','org','private/direct','image/png',1,'direct.png','digest','2027-01-01',NULL,'2026-01-01');
  `);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function apply(database, name) {
  database.exec("BEGIN");
  try {
    database.exec(migration(name));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

test("0055 preserves populated dependent graph and 0056 leaves existing capabilities unclassified", () => {
  const database = databaseAt0054();
  apply(database, "0055_speaker_task_session_subjects.sql");
  apply(database, "0056_private_download_capability_subject.sql");

  assert.deepEqual(
    database
      .prepare("SELECT id, session_id FROM speaker_tasks ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: "task-direct", session_id: "direct" },
      { id: "task-null", session_id: null },
      { id: "task-prefixed", session_id: "session-prefixed" },
    ],
  );
  assert.deepEqual(
    database
      .prepare("SELECT id, session_id, supersedes_asset_id FROM speaker_assets ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: "asset-direct", session_id: "direct", supersedes_asset_id: null },
      { id: "asset-null", session_id: null, supersedes_asset_id: null },
      { id: "asset-prefixed", session_id: "session-prefixed", supersedes_asset_id: "asset-direct" },
    ],
  );
  for (const table of [
    "speaker_task_dependencies",
    "speaker_task_reminder_offsets",
    "speaker_task_transitions",
    "speaker_task_forms",
    "speaker_task_responses",
    "submission_answers",
    "speaker_asset_comments",
  ]) {
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 1, table);
  }
  for (const table of ["speaker_content", "speaker_profiles", "speaker_roster"])
    assert.equal(
      database.prepare(`SELECT headshot_asset_id FROM ${table}`).get().headshot_asset_id,
      "asset-direct",
      table,
    );
  assert.deepEqual(
    {
      ...database
        .prepare(
          "SELECT subject_kind, subject_id FROM private_download_capabilities WHERE id = 'capability'",
        )
        .get(),
    },
    { subject_kind: null, subject_id: null },
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name GLOB '_0055_*'",
      )
      .get().count,
    0,
  );
  assert.ok(
    database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN ('speaker_tasks_session_idx','speaker_assets_task_idx')",
      )
      .get().count,
    2,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0055 rolls back atomically when a legacy speaker subject cannot be mapped", () => {
  const database = databaseAt0054();
  database.exec(
    "INSERT INTO submissions (id,organization_id,event_id,form_id,owner_account_id,form_version,status,completed_steps_json,version,created_at,updated_at,submitted_at,reopened_at,withdrawn_at,final_decision_at) SELECT 'missing',organization_id,event_id,form_id,owner_account_id,form_version,status,completed_steps_json,version,created_at,updated_at,submitted_at,reopened_at,withdrawn_at,final_decision_at FROM submissions WHERE id = 'submission'",
  );
  database.exec("UPDATE speaker_tasks SET submission_id = 'missing' WHERE id = 'task-direct'");
  assert.throws(() => apply(database, "0055_speaker_task_session_subjects.sql"));
  assert.equal(
    database.prepare("SELECT submission_id FROM speaker_tasks WHERE id = 'task-direct'").get()
      .submission_id,
    "missing",
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name GLOB '_0055_*'",
      )
      .get().count,
    0,
  );
});
