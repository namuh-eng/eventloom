PRAGMA defer_foreign_keys = ON;

CREATE TABLE _0055_speaker_tasks AS SELECT * FROM speaker_tasks;
CREATE TABLE _0055_speaker_assets AS SELECT * FROM speaker_assets;
CREATE TABLE _0055_speaker_task_dependencies AS SELECT * FROM speaker_task_dependencies;
CREATE TABLE _0055_speaker_task_reminder_offsets AS SELECT * FROM speaker_task_reminder_offsets;
CREATE TABLE _0055_speaker_task_transitions AS SELECT * FROM speaker_task_transitions;
CREATE TABLE _0055_speaker_task_forms AS SELECT * FROM speaker_task_forms;
CREATE TABLE _0055_speaker_task_responses AS SELECT * FROM speaker_task_responses;
CREATE TABLE _0055_submission_answers AS SELECT * FROM submission_answers;
CREATE TABLE _0055_speaker_asset_comments AS SELECT * FROM speaker_asset_comments;
CREATE TABLE _0055_speaker_content_headshots AS SELECT * FROM speaker_content;
CREATE TABLE _0055_speaker_profile_headshots AS SELECT * FROM speaker_profiles;
CREATE TABLE _0055_speaker_roster_headshots AS SELECT * FROM speaker_roster;

UPDATE _0055_speaker_tasks AS task
SET submission_id = CASE
  WHEN task.submission_id IS NULL THEN NULL
  ELSE COALESCE(
    (SELECT session.id FROM sessions AS session
      WHERE session.organization_id = task.organization_id
        AND session.event_id = task.event_id
        AND session.id = task.submission_id LIMIT 1),
    (SELECT session.id FROM sessions AS session
      WHERE session.organization_id = task.organization_id
        AND session.event_id = task.event_id
        AND session.id = 'session-' || task.submission_id LIMIT 1),
    json_extract('unmappable legacy speaker task session', '$')
  )
END;

UPDATE _0055_speaker_assets AS asset
SET submission_id = CASE
  WHEN asset.submission_id IS NULL THEN NULL
  ELSE COALESCE(
    (SELECT session.id FROM sessions AS session
      WHERE session.organization_id = asset.organization_id
        AND session.event_id = asset.event_id
        AND session.id = asset.submission_id LIMIT 1),
    (SELECT session.id FROM sessions AS session
      WHERE session.organization_id = asset.organization_id
        AND session.event_id = asset.event_id
        AND session.id = 'session-' || asset.submission_id LIMIT 1),
    json_extract('unmappable legacy speaker asset session', '$')
  )
END;

DELETE FROM speaker_asset_comments;
DELETE FROM submission_answers;
DELETE FROM speaker_task_responses;
DELETE FROM speaker_task_forms;
DELETE FROM speaker_task_transitions;
DELETE FROM speaker_task_reminder_offsets;
DELETE FROM speaker_task_dependencies;
UPDATE speaker_content SET headshot_asset_id = NULL WHERE headshot_asset_id IS NOT NULL;
UPDATE speaker_profiles SET headshot_asset_id = NULL WHERE headshot_asset_id IS NOT NULL;
UPDATE speaker_roster SET headshot_asset_id = NULL WHERE headshot_asset_id IS NOT NULL;
UPDATE speaker_assets SET supersedes_asset_id = NULL;
DELETE FROM speaker_assets;
DELETE FROM speaker_tasks;
DROP TABLE speaker_assets;
DROP TABLE speaker_tasks;

CREATE TABLE speaker_tasks (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  session_id TEXT,
  participant_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN('form','upload','action')),
  owner TEXT NOT NULL CHECK(owner IN('speaker','organizer')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN('not_started','in_progress','submitted','needs_changes','completed','waived','overdue','reopened')),
  due_at TEXT,
  allowed_mime_types_json TEXT NOT NULL CHECK(json_valid(allowed_mime_types_json) AND json_type(allowed_mime_types_json)='array'),
  max_bytes INTEGER CHECK(max_bytes IS NULL OR max_bytes>0),
  accepted_asset_kinds_json TEXT NOT NULL CHECK(json_valid(accepted_asset_kinds_json) AND json_type(accepted_asset_kinds_json)='array'),
  version INTEGER NOT NULL CHECK(version>0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  replacement_baseline_asset_id TEXT,
  FOREIGN KEY(organization_id,event_id) REFERENCES events(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,event_id,participant_id) REFERENCES participants(organization_id,event_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,event_id,session_id) REFERENCES sessions(organization_id,event_id,id) ON DELETE RESTRICT,
  UNIQUE(organization_id,id),
  UNIQUE(organization_id,event_id,id)
) STRICT;

CREATE TABLE speaker_assets (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  session_id TEXT,
  participant_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN('headshot','slides','supporting_file')),
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  state TEXT NOT NULL CHECK(state IN('pending_upload','ready','rejected')),
  version INTEGER NOT NULL CHECK(version>0),
  version_family_id TEXT NOT NULL,
  supersedes_asset_id TEXT,
  comment_thread_id TEXT NOT NULL,
  review_state TEXT CHECK(review_state IN('approved','needs_changes')),
  review_note TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_version INTEGER NOT NULL DEFAULT 0 CHECK(review_version>=0),
  latest_version_id TEXT,
  current_version_id TEXT,
  approved_version_id TEXT,
  released_version_id TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  uploader_account_id TEXT REFERENCES auth_users(id) ON DELETE SET NULL,
  uploader_label TEXT,
  creation_idempotency_key TEXT,
  creation_request_digest TEXT,
  FOREIGN KEY(organization_id,event_id) REFERENCES events(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,event_id,participant_id) REFERENCES participants(organization_id,event_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,event_id,session_id) REFERENCES sessions(organization_id,event_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,event_id,task_id) REFERENCES speaker_tasks(organization_id,event_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(supersedes_asset_id) REFERENCES speaker_assets(id) ON DELETE RESTRICT,
  UNIQUE(organization_id,id),
  UNIQUE(organization_id,event_id,id),
  UNIQUE(organization_id,event_id,version_family_id,version),
  CHECK((review_state IS NULL AND reviewed_at IS NULL AND reviewed_by IS NULL) OR (review_state IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  CHECK(state<>'rejected' OR rejection_reason IS NOT NULL)
) STRICT;

INSERT INTO speaker_tasks SELECT * FROM _0055_speaker_tasks;
INSERT INTO speaker_assets SELECT * FROM _0055_speaker_assets;
INSERT INTO speaker_task_dependencies SELECT * FROM _0055_speaker_task_dependencies;
INSERT INTO speaker_task_reminder_offsets SELECT * FROM _0055_speaker_task_reminder_offsets;
INSERT INTO speaker_task_transitions SELECT * FROM _0055_speaker_task_transitions;
INSERT INTO speaker_task_forms SELECT * FROM _0055_speaker_task_forms;
INSERT INTO speaker_task_responses SELECT * FROM _0055_speaker_task_responses;
INSERT INTO submission_answers SELECT * FROM _0055_submission_answers;
INSERT INTO speaker_asset_comments SELECT * FROM _0055_speaker_asset_comments;
UPDATE speaker_content
SET headshot_asset_id = (
  SELECT backup.headshot_asset_id FROM _0055_speaker_content_headshots AS backup
  WHERE backup.id = speaker_content.id
)
WHERE id IN (SELECT id FROM _0055_speaker_content_headshots WHERE headshot_asset_id IS NOT NULL);
UPDATE speaker_profiles
SET headshot_asset_id = (
  SELECT backup.headshot_asset_id FROM _0055_speaker_profile_headshots AS backup
  WHERE backup.id = speaker_profiles.id
)
WHERE id IN (SELECT id FROM _0055_speaker_profile_headshots WHERE headshot_asset_id IS NOT NULL);
UPDATE speaker_roster
SET headshot_asset_id = (
  SELECT backup.headshot_asset_id FROM _0055_speaker_roster_headshots AS backup
  WHERE backup.id = speaker_roster.id
)
WHERE id IN (SELECT id FROM _0055_speaker_roster_headshots WHERE headshot_asset_id IS NOT NULL);
DROP TABLE _0055_speaker_roster_headshots;
DROP TABLE _0055_speaker_profile_headshots;
DROP TABLE _0055_speaker_content_headshots;
DROP TABLE _0055_speaker_asset_comments;
DROP TABLE _0055_submission_answers;
DROP TABLE _0055_speaker_task_responses;
DROP TABLE _0055_speaker_task_forms;
DROP TABLE _0055_speaker_task_transitions;
DROP TABLE _0055_speaker_task_reminder_offsets;
DROP TABLE _0055_speaker_task_dependencies;
DROP TABLE _0055_speaker_assets;
DROP TABLE _0055_speaker_tasks;

CREATE INDEX speaker_tasks_participant_status_idx
  ON speaker_tasks(organization_id,event_id,participant_id,status,due_at);
CREATE INDEX speaker_tasks_session_idx
  ON speaker_tasks(organization_id,event_id,session_id);
CREATE INDEX speaker_tasks_replacement_baseline_idx
  ON speaker_tasks(organization_id,event_id,replacement_baseline_asset_id)
  WHERE replacement_baseline_asset_id IS NOT NULL;
CREATE INDEX speaker_assets_participant_idx
  ON speaker_assets(organization_id,event_id,participant_id,created_at);
CREATE INDEX speaker_assets_task_idx
  ON speaker_assets(organization_id,event_id,task_id,created_at);
CREATE INDEX speaker_assets_family_idx
  ON speaker_assets(organization_id,event_id,version_family_id,version);
CREATE INDEX speaker_assets_state_idx
  ON speaker_assets(organization_id,event_id,state,created_at);
CREATE INDEX speaker_assets_released_idx ON speaker_assets(released_version_id);
CREATE INDEX speaker_assets_uploader_idx
  ON speaker_assets(organization_id,event_id,uploader_account_id,created_at);
CREATE UNIQUE INDEX speaker_assets_creation_idempotency_uidx
  ON speaker_assets(organization_id,event_id,creation_idempotency_key)
  WHERE creation_idempotency_key IS NOT NULL;

PRAGMA defer_foreign_keys = OFF;
PRAGMA foreign_keys = ON;
