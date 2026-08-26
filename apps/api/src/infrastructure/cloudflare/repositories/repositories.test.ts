import { describe, expect, it, vi } from "vitest";
import { CrmRepositoryConflictError } from "../../../features/crm/service";
import type {
  CrmContact,
  CrmContactTransitionAudit,
  CrmEventProjection,
  CrmPipelineEntry,
} from "../../../features/crm/types";
import type { Event, EventAuditEntry } from "../../../features/events/types";
import {
  EventRepositoryCapacityError,
  EventRepositoryConflictError,
} from "../../../features/events/types";
import type { Session, SessionAuditEntry, SessionSettings } from "../../../features/sessions/types";
import { SessionRepositoryConflictError } from "../../../features/sessions/types";
import { SqliteD1 } from "../../../test-support/sqlite-d1";
import { D1CrmRepository } from "./crm";
import { D1EventRepository } from "./events";
import { D1SessionRepository } from "./sessions";
import { consequentialAuditId } from "./shared";

function statement(query: string) {
  const bound = { query, values: [] as unknown[] };
  return {
    bind(...values: unknown[]) {
      bound.values = values;
      return this;
    },
    async all() {
      return { results: [] };
    },
    async first(): Promise<Record<string, unknown> | null> {
      return null;
    },
    async run() {
      return { meta: { changes: 0 } };
    },
    bound,
  };
}

function database(changes = 1, firstResults: readonly (Record<string, unknown> | null)[] = []) {
  const statements: ReturnType<typeof statement>[] = [];
  const rows = [...firstResults];
  const batch = vi.fn(async (items: readonly ReturnType<typeof statement>[]) =>
    items.map((_item, index) => ({ meta: { changes: index === 0 ? changes : 1 } })),
  );
  return {
    prepare(query: string) {
      const prepared = statement(query);
      prepared.first = async () => rows.shift() ?? null;
      statements.push(prepared);
      return prepared;
    },
    batch,
    statements,
  } as unknown as D1Database & {
    statements: ReturnType<typeof statement>[];
    batch: ReturnType<typeof vi.fn>;
  };
}

const now = "2026-08-13T12:00:00.000Z";
const event: Event = {
  id: "event-1",
  organizationId: "org-1",
  slug: "event-1",
  name: "Event",
  timeZone: "UTC",
  startsAt: now,
  endsAt: "2026-08-14T12:00:00.000Z",
  scheduleDates: ["2026-08-13", "2026-08-14"],
  venue: null,
  cfpSettings: { enabled: false, opensAt: null, closesAt: null },
  defaultCalendarSettings: { durationMinutes: 30, timeZone: "UTC", location: null },
  embedConfigurations: [],
  version: 2,
  createdAt: now,
  updatedAt: now,
  createdBy: "user-1",
  updatedBy: "user-1",
};
const eventAudit: EventAuditEntry = {
  id: "audit-1",
  organizationId: "org-1",
  eventId: "event-1",
  action: "updated",
  version: 2,
  actorId: "user-1",
  occurredAt: now,
  after: event,
};

const session: Session = {
  id: "session-1",
  tenantId: "org-1",
  eventId: "event-1",
  title: "Session",
  description: "",
  status: "Accepted",
  contentStatus: "Approved",
  durationMinutes: 30,
  capacityRequired: 0,
  trackIds: [],
  tagIds: [],
  speakerIds: [],
  speakerRoster: [],
  resourceIds: [],
  version: 2,
  createdAt: now,
  updatedAt: now,
  createdBy: "user-1",
  updatedBy: "user-1",
  history: [],
};
const sessionAudit: SessionAuditEntry = {
  id: "audit-session-1",
  tenantId: "org-1",
  eventId: "event-1",
  entityType: "session",
  entityId: "session-1",
  action: "updated",
  version: 2,
  actorId: "user-1",
  occurredAt: now,
  after: session,
};

const crmContact: CrmContact = {
  id: "contact-1",
  organizationId: "org-1",
  firstName: "Ada",
  lastName: "Lovelace",
  displayName: "Ada Lovelace",
  email: "ada@example.test",
  phone: null,
  company: null,
  title: null,
  website: null,
  linkedinUrl: null,
  notes: null,
  tags: [],
  customFields: {},
  source: "manual",
  status: "active",
  mergedIntoId: null,
  pipelineStage: "qualified",
  version: 2,
  createdAt: now,
  updatedAt: now,
};
const crmTransitionAudit: CrmContactTransitionAudit = {
  pipeline: {
    id: "pipeline-1",
    organizationId: crmContact.organizationId,
    contactId: crmContact.id,
    fromStage: "new",
    toStage: "qualified",
    note: "Strong fit",
    actorId: "user-1",
    actorName: "owner@example.test",
    createdAt: now,
  },
  history: {
    id: "history-1",
    organizationId: crmContact.organizationId,
    contactId: crmContact.id,
    kind: "pipeline",
    eventId: null,
    sessionId: null,
    title: "Pipeline stage changed",
    detail: "new to qualified",
    occurredAt: now,
    metadata: { pipelineEntryId: "pipeline-1" },
  },
};

const crmSqliteSchema = `
CREATE TABLE crm_contacts (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  title TEXT,
  website TEXT,
  linkedin_url TEXT,
  notes TEXT,
  custom_fields_json TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  merged_into_id TEXT,
  merge_audit_id TEXT,
  merged_at TEXT,
  merge_source_ids_json TEXT NOT NULL,
  pipeline_stage TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id)
);
CREATE TABLE crm_contact_tags (
  organization_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (organization_id, contact_id, tag)
);
CREATE TABLE crm_pipeline_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  source_crm_contact_id TEXT NOT NULL,
  merge_audit_id TEXT,
  from_stage TEXT NOT NULL,
  to_stage TEXT NOT NULL,
  note TEXT,
  actor_id TEXT,
  actor_name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE crm_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_id TEXT,
  session_id TEXT,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  trace_id TEXT,
  details_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE airtable_projection_configs (
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  PRIMARY KEY (organization_id, entity_type)
);
CREATE TABLE airtable_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE airtable_sync_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  application_id TEXT,
  source_version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL,
  deduplication_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL,
  available_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function crmSqliteDatabase(): SqliteD1 {
  const database = new SqliteD1("eventloom-crm-repository-", crmSqliteSchema);
  database.executeScript(`
    INSERT INTO crm_contacts (
      organization_id,id,first_name,last_name,display_name,email,phone,company,title,
      website,linkedin_url,notes,custom_fields_json,source,status,merged_into_id,
      merge_audit_id,merged_at,merge_source_ids_json,pipeline_stage,version,created_at,updated_at
    ) VALUES (
      'org-1','contact-1','Ada','Lovelace','Ada Lovelace','ada@example.com',NULL,
      'Initial Company',NULL,NULL,NULL,NULL,'{}','manual','active',NULL,NULL,NULL,'[]',
      'new',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
    );
    INSERT INTO crm_contact_tags (organization_id,contact_id,tag)
    VALUES ('org-1','contact-1','initial');
  `);
  return database;
}

function crmSqliteState(database: SqliteD1) {
  return {
    contacts: database.query<{
      company: string | null;
      pipeline_stage: string;
      version: number;
    }>("SELECT company,pipeline_stage,version FROM crm_contacts ORDER BY organization_id,id"),
    tags: database.query<{ tag: string }>(
      "SELECT tag FROM crm_contact_tags ORDER BY organization_id,contact_id,tag",
    ),
    pipelineHistory: database.query<{ id: string }>(
      "SELECT id FROM crm_pipeline_history ORDER BY id",
    ),
    history: database.query<{ id: string }>("SELECT id FROM crm_history ORDER BY id"),
    audit: database.query<{
      action: string;
      id: string;
      resource_id: string;
      resource_type: string;
      tenant_id: string;
    }>(
      "SELECT action,id,resource_id,resource_type,tenant_id FROM audit_events ORDER BY tenant_id,id",
    ),
  };
}

describe("D1 event repository commands", () => {
  it("guards managed event creation against the current entitlement in the same batch", async () => {
    const db = database();
    await new D1EventRepository(db).commitEvent({
      event: { ...event, version: 1 },
      expectedVersion: null,
      creationEntitlement: {
        revision: 7,
        activeEventLimit: 3,
      },
    });

    const batch = db.batch.mock.calls[0]?.[0] as readonly ReturnType<typeof statement>[];
    expect(batch[1]?.bound.query).toContain("FROM organization_entitlements");
    expect(batch[1]?.bound.query).toContain("COUNT(*)");
    expect(batch[1]?.bound.values).toEqual(["org-1", 7, now, now, "org-1"]);
  });

  it("reports entitlement admission failures as capacity errors", async () => {
    const db = database();
    db.batch.mockRejectedValueOnce(new Error("D1_CAS_CONFLICT"));

    await expect(
      new D1EventRepository(db).commitEvent({
        event: { ...event, version: 1 },
        expectedVersion: null,
        creationEntitlement: {
          revision: 7,
          activeEventLimit: 0,
        },
      }),
    ).rejects.toBeInstanceOf(EventRepositoryCapacityError);
  });

  it("batches tenant-scoped CAS, audit, and sync-job persistence", async () => {
    const db = database();
    await new D1EventRepository(db).commitEvent({ event, expectedVersion: 1, audit: eventAudit });
    expect(db.batch).toHaveBeenCalledOnce();
    const queries = db.statements.map((item) => item.bound.query).join("\n");
    expect(queries).toContain("WHERE organization_id = ? AND id = ? AND version = ?");
    expect(queries).toContain("schedule_dates_json = ?");
    expect(queries).toContain("FROM review_plans p");
    expect(queries).toContain("FROM review_rounds r");
    expect(queries).toContain("FROM agenda_states s");
    expect(queries).toContain("s.time_zone <> ?");
    expect(queries).toContain("FROM agenda_entries e");
    expect(queries).toContain("FROM json_each(?)");
    expect(db.statements[0]?.bound.values[5]).toBe('["2026-08-13","2026-08-14"]');
    expect(queries).toContain("INSERT INTO audit_events");
    expect(queries).toContain("INSERT INTO airtable_sync_jobs");
    expect(queries).toContain("attempt_count");
    expect(queries).toContain("payload_hash");
    expect(queries).toContain("connection.status = 'connected'");
    expect(queries).not.toContain("attempts");
    expect(queries).not.toContain("c.state");
  });

  it("guards event shortening against evaluation boundaries in the same atomic batch", async () => {
    const db = database();
    const shortened = { ...event, endsAt: "2026-08-14T08:00:00.000Z", version: 3 };

    await new D1EventRepository(db).commitEvent({ event: shortened, expectedVersion: 2 });

    const evaluationGuard = db.statements.find(
      (item) =>
        item.bound.query.includes("FROM review_plans p") &&
        item.bound.query.includes("FROM review_rounds r"),
    );
    expect(evaluationGuard?.bound.query).toContain("p.closes_at > ?");
    expect(evaluationGuard?.bound.query).toContain("r.opens_at > ?");
    expect(evaluationGuard?.bound.query).toContain("r.closes_at > ?");
    expect(evaluationGuard?.bound.values.slice(0, 7)).toEqual([
      "org-1",
      "event-1",
      shortened.endsAt,
      "org-1",
      "event-1",
      shortened.endsAt,
      shortened.endsAt,
    ]);
  });

  it("guards event timezone changes against agenda state in the same atomic batch", async () => {
    const db = database();
    const updated = { ...event, timeZone: "America/Los_Angeles", version: 3 };

    await new D1EventRepository(db).commitEvent({ event: updated, expectedVersion: 2 });

    const temporalGuard = db.statements.find((item) =>
      item.bound.query.includes("FROM agenda_states s"),
    );
    expect(temporalGuard?.bound.query).toContain("s.time_zone <> ?");
    expect(temporalGuard?.bound.values.slice(7, 10)).toEqual([
      "org-1",
      "event-1",
      updated.timeZone,
    ]);
  });

  it("initializes one empty agenda in the event creation batch", async () => {
    const db = database();
    await new D1EventRepository(db).commitEvent({
      event: { ...event, version: 1 },
      expectedVersion: null,
      audit: { ...eventAudit, action: "created", version: 1 },
    });
    const queries = db.statements.map((item) => item.bound.query).join("\n");
    expect(db.statements[0]?.bound.query).toContain("name, status, time_zone");
    expect(db.statements[0]?.bound.values[4]).toBe("active");
    expect(queries).toContain("INSERT INTO agenda_states");
    expect(queries).toContain("INSERT INTO agenda_drafts");
    expect(queries).not.toContain("INSERT INTO agenda_revisions");
    expect(queries).toContain(
      "EXISTS (SELECT 1 FROM events WHERE organization_id = ? AND id = ? AND version = ?)",
    );
    expect(queries).not.toContain("changes()");
  });

  it("reports a stale compare-and-swap from the first batch result", async () => {
    await expect(
      new D1EventRepository(database(0)).commitEvent({
        event,
        expectedVersion: 1,
        audit: eventAudit,
      }),
    ).rejects.toBeInstanceOf(EventRepositoryConflictError);
  });
});

describe("D1 CRM repository commands", () => {
  it("aligns contact writes to the next expected version", async () => {
    const db = database();
    await new D1CrmRepository(db).saveContact(crmContact, 1);
    expect(db.batch).toHaveBeenCalledOnce();
    await expect(
      new D1CrmRepository(database()).saveContact({ ...crmContact, version: 1 }, 1),
    ).rejects.toMatchObject({
      name: "CrmRepositoryConflictError",
      message: "The contact version is invalid.",
    });
  });

  it("leaves all CRM state unchanged when the real SQLite CAS is stale", async () => {
    const database = crmSqliteDatabase();
    const repository = new D1CrmRepository(database as never);
    try {
      await repository.saveContact(crmContact, 1, crmTransitionAudit);
      const before = crmSqliteState(database);
      expect(before.audit.every((entry) => entry.action !== "crm.contact.cas_guard")).toBe(true);
      const staleAudit: CrmContactTransitionAudit = {
        pipeline: {
          ...crmTransitionAudit.pipeline,
          id: "pipeline-stale",
          note: "Stale retry",
        },
        history: {
          ...crmTransitionAudit.history,
          id: "history-stale",
          metadata: { pipelineEntryId: "pipeline-stale" },
        },
      };
      await expect(
        repository.saveContact(
          {
            ...crmContact,
            company: "Stale Company",
            tags: ["stale"],
          },
          1,
          staleAudit,
        ),
      ).rejects.toBeInstanceOf(CrmRepositoryConflictError);

      expect(crmSqliteState(database)).toEqual(before);
    } finally {
      database.dispose();
    }
  });

  it("does not authorize a CRM write from a cross-tenant guard collision", async () => {
    const database = crmSqliteDatabase();
    const repository = new D1CrmRepository(database as never);
    const attemptId = "00000000-0000-4000-8000-000000000001";
    const probeAttemptId = "00000000-0000-4000-8000-000000000002";
    const resourceId = `${crmContact.id}:${attemptId}`;
    const guardId = consequentialAuditId({
      tenantId: crmContact.organizationId,
      action: "crm.contact.cas_guard",
      resourceType: "crm_contact_write_guard",
      resourceId,
      resourceVersion: crmContact.version,
      occurredAt: crmContact.updatedAt,
    });
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(attemptId)
      .mockReturnValueOnce(probeAttemptId);
    database.executeScript(`
      INSERT INTO audit_events (
        id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,
        trace_id,details_json,occurred_at
      ) VALUES (
        '${guardId}','other-organization','system',NULL,'crm.contact.cas_guard',
        'crm_contact_write_guard','${resourceId}',NULL,'{}','${crmContact.updatedAt}'
      );
    `);
    const before = crmSqliteState(database);
    try {
      const failure = repository.saveContact(crmContact, 1, crmTransitionAudit);
      await expect(failure).rejects.not.toBeInstanceOf(CrmRepositoryConflictError);
      await expect(failure).rejects.toThrow("The CRM contact CAS guard could not be acquired.");
      expect(crmSqliteState(database)).toEqual(before);
    } finally {
      randomUuid.mockRestore();
      database.dispose();
    }
  });

  it("rolls back every real SQLite statement and preserves a late history failure", async () => {
    const database = crmSqliteDatabase();
    const repository = new D1CrmRepository(database as never);
    database.executeScript(`
      CREATE TRIGGER fail_late_crm_history
      BEFORE INSERT ON crm_history
      WHEN NEW.id = 'history-1'
      BEGIN
        SELECT RAISE(ABORT, 'deliberate late history failure');
      END;
    `);
    const before = crmSqliteState(database);
    try {
      const failure = repository.saveContact(crmContact, 1, crmTransitionAudit);
      await expect(failure).rejects.not.toBeInstanceOf(CrmRepositoryConflictError);
      await expect(failure).rejects.toThrow("deliberate late history failure");

      expect(crmSqliteState(database)).toEqual(before);
    } finally {
      database.dispose();
    }
  });

  it("materializes CRM event links in the canonical speaker roster", async () => {
    const db = database();
    const projection: CrmEventProjection = {
      id: "event-contact-1",
      organizationId: "org-1",
      eventId: "event-1",
      participantId: "crm-participant:event-1:contact-1",
      crmContactId: crmContact.id,
      contactId: crmContact.id,
      sessionId: null,
      role: "speaker",
      note: null,
      createdBy: "user-1",
      createdAt: now,
      updatedAt: now,
    };

    await new D1CrmRepository(db).saveProjection(projection, crmContact);

    const participant = db.statements.find((item) =>
      item.bound.query.includes("INSERT OR IGNORE INTO participants"),
    );
    const profile = db.statements.find((item) =>
      item.bound.query.includes("INSERT OR IGNORE INTO speaker_profiles"),
    );
    expect(participant?.bound.values).toContain(projection.participantId);
    expect(participant?.bound.values).toContain(crmContact.email);
    expect(profile?.bound.values).toContain(projection.participantId);
    expect(profile?.bound.values).toContain(crmContact.displayName);
  });
  it("rejects a missing pinned CRM participant on first call and replay", async () => {
    const db = database(1, [null, null, null, null]);
    const repository = new D1CrmRepository(db);
    const projection: CrmEventProjection = {
      id: "event-contact-pinned",
      organizationId: "org-1",
      eventId: "event-1",
      participantId: "participant-pinned",
      crmContactId: crmContact.id,
      contactId: crmContact.id,
      sessionId: null,
      role: "speaker",
      note: null,
      createdBy: "user-1",
      createdAt: now,
      updatedAt: now,
    };

    await expect(repository.saveProjection(projection, crmContact)).rejects.toThrow(
      "The pinned participant does not exist.",
    );
    await expect(repository.saveProjection(projection, crmContact)).rejects.toThrow(
      "The pinned participant does not exist.",
    );
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("reuses Marcus's resolved participant for an unpinned CRM projection and replay", async () => {
    const projection: CrmEventProjection = {
      id: "event-contact-marcus",
      organizationId: "org-1",
      eventId: "event-1",
      participantId: "crm-participant:event-1:contact-1",
      crmContactId: crmContact.id,
      contactId: crmContact.id,
      sessionId: null,
      role: "speaker",
      note: null,
      createdBy: "user-1",
      createdAt: now,
      updatedAt: now,
    };
    const canonicalParticipantId = "participant-marcus";
    const db = database(1, [
      null,
      null,
      { id: canonicalParticipantId },
      null,
      {
        id: projection.id,
        organization_id: projection.organizationId,
        event_id: projection.eventId,
        participant_id: canonicalParticipantId,
        crm_contact_id: projection.crmContactId,
        source_crm_contact_id: null,
        merge_audit_id: null,
        session_id: projection.sessionId,
        role: projection.role,
        note: projection.note,
        created_by: projection.createdBy,
        created_at: projection.createdAt,
        updated_at: projection.updatedAt,
      },
    ]);
    const repository = new D1CrmRepository(db);

    const created = await repository.saveProjection(projection, {
      ...crmContact,
      displayName: "Marcus Aurelius",
      email: "MARCUS@example.com",
    });
    const replay = await repository.saveProjection(projection, {
      ...crmContact,
      displayName: "Marcus Aurelius",
      email: "MARCUS@example.com",
    });

    const emailLookup = db.statements.find((item) =>
      item.bound.query.includes("normalized_email=? COLLATE NOCASE"),
    );
    expect(emailLookup?.bound.values).toEqual(["org-1", "event-1", "marcus@example.com"]);
    expect(created.participantId).toBe(canonicalParticipantId);
    expect(replay).toEqual(created);
    expect(db.batch).toHaveBeenCalledTimes(2);
  });
  it("filters contacts through event participant-link membership", async () => {
    const db = database();
    await new D1CrmRepository(db).listContacts("org-1", { eventId: "event-1" });
    const query = db.statements.at(-1)?.bound;
    expect(query?.query).toContain("FROM crm_participant_links link");
    expect(query?.query).toContain("link.crm_contact_id=contact.id AND link.event_id=?");
    expect(query?.values).toEqual(["org-1", "event-1", 500]);
  });

  it("persists pipeline actor names alongside immutable actor IDs", async () => {
    const db = database();
    const entry: CrmPipelineEntry = {
      id: "pipeline-1",
      organizationId: "org-1",
      contactId: crmContact.id,
      fromStage: "new",
      toStage: "qualified",
      note: "Strong fit",
      actorId: "user-1",
      actorName: "owner@example.test",
      createdAt: now,
    };
    await new D1CrmRepository(db).appendPipeline(entry);
    const insert = db.statements.find((item) =>
      item.bound.query.startsWith("INSERT INTO crm_pipeline_history"),
    )?.bound;
    expect(insert?.query).toContain("actor_id,actor_name,created_at");
    expect(insert?.values).toContain("user-1");
    expect(insert?.values).toContain("owner@example.test");
  });
});

describe("D1 session repository commands", () => {
  it("lists event-qualified active speaker profile IDs", async () => {
    const db = database();

    await new D1SessionRepository(db).listSpeakerIds("tenant-a", "event-a");

    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]?.bound.query).toContain("FROM speaker_profiles");
    expect(db.statements[0]?.bound.query).toContain("organization_id = ?");
    expect(db.statements[0]?.bound.query).toContain("event_id = ?");
    expect(db.statements[0]?.bound.query).toContain("status <> 'revoked'");
    expect(db.statements[0]?.bound.values).toEqual(["tenant-a", "event-a"]);
  });

  it("batches tenant/event-scoped CAS, normalized joins, audit, and sync-job persistence", async () => {
    const db = database();
    await new D1SessionRepository(db).commit?.({
      operation: "putSession",
      value: session,
      expectedVersion: 1,
      audit: sessionAudit,
    });
    expect(db.batch).toHaveBeenCalledOnce();
    const queries = db.statements.map((item) => item.bound.query).join("\n");
    expect(queries).toContain(
      "WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ?",
    );
    expect(queries).toContain("DELETE FROM session_tracks");
    expect(queries).toContain("INSERT INTO session_history");
    expect(queries).toContain("INSERT INTO airtable_sync_jobs");
    expect(queries).toContain("attempt_count");
    expect(queries).toContain("payload_hash");
    expect(queries).toContain("connection.status = 'connected'");
    expect(queries).not.toContain("attempts");
    expect(queries).not.toContain("c.state");
  });

  it("reports a stale compare-and-swap from the first batch result", async () => {
    await expect(
      new D1SessionRepository(database(0)).commit?.({
        operation: "putSession",
        value: session,
        expectedVersion: 1,
        audit: sessionAudit,
      }),
    ).rejects.toBeInstanceOf(SessionRepositoryConflictError);
  });

  it("updates status rows without deleting values referenced by sessions", async () => {
    const db = database();
    const settings: SessionSettings = {
      id: "settings-1",
      tenantId: "tenant-1",
      eventId: "event-1",
      statuses: ["Draft", "Accepted"],
      agendaEligibleStatuses: ["Accepted"],
      version: 2,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      createdBy: "user-1",
      updatedBy: "user-1",
      history: [],
    };
    await new D1SessionRepository(db).commit?.({
      operation: "putSettings",
      value: settings,
      expectedVersion: 1,
      audit: {
        ...sessionAudit,
        entityType: "settings",
        entityId: settings.id,
        version: settings.version,
        after: settings,
      },
    });

    const queries = db.statements.map((item) => item.bound.query).join("\n");
    expect(queries).not.toContain("DELETE FROM session_statuses");
    expect(queries).toContain("UPDATE session_statuses SET active = 0");
    expect(queries).toContain("UPDATE session_statuses SET name = ?");
    expect(queries).toContain("INSERT INTO session_statuses");
    expect(queries).toContain("NOT EXISTS");
  });

  it("fences session writes against the current evaluation decision", async () => {
    const db = database();
    const repository = new D1SessionRepository(db);

    await repository.commit({
      operation: "putSession",
      value: session,
      expectedVersion: 1,
      audit: sessionAudit,
      decisionFence: {
        tenantId: "org-1",
        eventId: "event-1",
        planId: "plan-1",
        submissionId: "submission-1",
        version: 3,
        status: "rejected",
      },
    });

    const primary = db.statements[0];
    expect(primary?.bound.query).toContain("FROM evaluation_decisions");
    expect(primary?.bound.query).toContain("organization_id = ?");
    expect(primary?.bound.values).toContain("plan-1");
    expect(primary?.bound.values).toContain("submission-1");
    expect(primary?.bound.values).toContain(3);
    expect(primary?.bound.values).toContain("rejected");
  });
});
