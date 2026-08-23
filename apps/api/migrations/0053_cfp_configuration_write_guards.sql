PRAGMA foreign_keys = ON;
CREATE TABLE cfp_configuration_write_guards (
  token TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, event_id) REFERENCES events(organization_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX cfp_configuration_write_guards_scope_idx
  ON cfp_configuration_write_guards(organization_id, event_id, form_id);
