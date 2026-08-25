ALTER TABLE private_download_capabilities ADD COLUMN subject_kind TEXT
  CHECK (subject_kind IS NULL OR subject_kind IN ('cfp_submission', 'speaker_session', 'participant'));
ALTER TABLE private_download_capabilities ADD COLUMN subject_id TEXT;
PRAGMA foreign_keys = ON;
