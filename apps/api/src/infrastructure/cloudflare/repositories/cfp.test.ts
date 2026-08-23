import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it } from "vitest";
import type { CfpForm, EventCfp } from "../../../features/cfp/model";
import { SqliteD1 } from "../../../test-support/sqlite-d1";
import { D1CfpRepository, eventCfpFromRow } from "./cfp";

const eventRow = {
  id: "event-1",
  organizationId: "organization-1",
  version: 1,
  slug: "future-conf",
  name: "Future Conf",
  timeZone: "UTC",
  startsAt: "2026-11-05T09:00:00.000Z",
  endsAt: "2026-11-07T17:00:00.000Z",
  cfpOpensAt: null,
  cfpClosesAt: null,
};
const form = (overrides: Partial<CfpForm> = {}): CfpForm => ({
  id: "form-1",
  tenantId: "organization-1",
  eventId: "event-1",
  name: "Main CFP",
  version: 1,
  status: "draft",
  welcomeContent: "Welcome",
  settings: {
    speakerLimit: 3,
    maxSubmissionsPerAccount: 3,
    remindersEnabled: true,
    adminNotificationsEnabled: true,
    confirmationMessage: "Received",
    successContent: "Thanks",
  },
  sections: [{ id: "proposal", title: "Proposal", description: "", order: 0 }],
  submissionFields: [
    {
      id: "title",
      sectionId: "proposal",
      key: "title",
      label: "Title",
      kind: "text",
      required: true,
      options: [],
    },
  ],
  participantFields: [],
  rules: [],
  ...overrides,
});

const databases: SqliteD1[] = [];

function createDatabase(): SqliteD1 {
  const database = new SqliteD1(
    "eventloom-cfp-authority-",
    `
      CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        organization_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        schedule_dates_json TEXT NOT NULL,
        venue TEXT,
        cfp_enabled INTEGER NOT NULL,
        cfp_opens_at TEXT,
        cfp_closes_at TEXT,
        legacy_retired_at TEXT,
        default_duration_minutes INTEGER NOT NULL,
        default_calendar_time_zone TEXT NOT NULL,
        default_calendar_location TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        UNIQUE (organization_id, id),
        CHECK (cfp_opens_at IS NULL OR cfp_closes_at > cfp_opens_at)
      ) STRICT;
      INSERT INTO events (
        id, organization_id, slug, name, status, time_zone, starts_at, ends_at,
        schedule_dates_json, venue, cfp_enabled, cfp_opens_at, cfp_closes_at,
        default_duration_minutes, default_calendar_time_zone, default_calendar_location,
        version, created_at, updated_at, created_by, updated_by
      ) VALUES (
        'event-1', 'organization-1', 'future-conf', 'Future Conf', 'active', 'UTC',
        '2026-11-05T09:00:00.000Z', '2026-11-07T17:00:00.000Z', '["2026-11-05"]',
        NULL, 1, '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
        30, 'UTC', NULL, 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
        'organizer-1', 'organizer-1'
      );
      CREATE TABLE cfp_configuration_write_guards (
        token TEXT PRIMARY KEY NOT NULL,
        organization_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        form_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE cfp_forms (
        id TEXT PRIMARY KEY NOT NULL,
        organization_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        welcome_content TEXT NOT NULL,
        speaker_limit INTEGER NOT NULL,
        max_submissions_per_account INTEGER NOT NULL,
        reminders_enabled INTEGER NOT NULL,
        admin_notifications_enabled INTEGER NOT NULL,
        confirmation_message TEXT NOT NULL,
        success_content TEXT NOT NULL,
        redirect_url TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, id),
        UNIQUE (organization_id, event_id, id)
      ) STRICT;
      CREATE TABLE cfp_form_sections (
        organization_id TEXT NOT NULL,
        form_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (organization_id, form_id, id)
      ) STRICT;
      CREATE TABLE cfp_form_fields (
        organization_id TEXT NOT NULL,
        form_id TEXT NOT NULL,
        id TEXT NOT NULL,
        section_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        field_key TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        placeholder TEXT,
        kind TEXT NOT NULL,
        required INTEGER NOT NULL,
        options_json TEXT NOT NULL,
        file_owner TEXT,
        allowed_mime_types_json TEXT,
        max_bytes INTEGER,
        reusable_field_id TEXT,
        reusable_field_version INTEGER,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (organization_id, form_id, id)
      ) STRICT;
      CREATE TABLE cfp_form_rules (
        organization_id TEXT NOT NULL,
        form_id TEXT NOT NULL,
        id TEXT NOT NULL,
        priority INTEGER NOT NULL,
        condition_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        PRIMARY KEY (organization_id, form_id, id)
      ) STRICT;
    `,
  );
  databases.push(database);
  return database;
}

function rawConfigurationState(database: SqliteD1) {
  return {
    event: database.query("SELECT * FROM events ORDER BY organization_id, id"),
    forms: database.query("SELECT * FROM cfp_forms ORDER BY organization_id, id"),
    sections: database.query(
      "SELECT * FROM cfp_form_sections ORDER BY organization_id, form_id, id",
    ),
    fields: database.query("SELECT * FROM cfp_form_fields ORDER BY organization_id, form_id, id"),
    rules: database.query("SELECT * FROM cfp_form_rules ORDER BY organization_id, form_id, id"),
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.dispose();
});

describe("D1 CFP event mapping", () => {
  it("uses event dates when a new event has no CFP window yet", () => {
    expect(eventCfpFromRow(eventRow)).toMatchObject({
      opensAt: eventRow.startsAt,
      closesAt: eventRow.endsAt,
    });
  });

  it("preserves an explicitly configured CFP window", () => {
    expect(
      eventCfpFromRow({
        ...eventRow,
        cfpOpensAt: "2026-09-01T00:00:00.000Z",
        cfpClosesAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      opensAt: "2026-09-01T00:00:00.000Z",
      closesAt: "2026-10-01T00:00:00.000Z",
    });
  });
});

describe("D1 CFP authoritative event bounds", () => {
  it("does not create an authoritative event through CFP persistence", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database);

    await expect(
      repository.saveEvent(
        {
          id: "missing-event",
          tenantId: "organization-1",
          version: 1,
          slug: "missing-event",
          name: "Missing Event",
          timezone: "UTC",
          opensAt: "2026-09-01T00:00:00.000Z",
          closesAt: "2026-10-01T00:00:00.000Z",
        },
        null,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(database.query<{ count: number }>("SELECT COUNT(*) AS count FROM events")).toEqual([
      { count: 1 },
    ]);
  });

  it("updates only CFP-owned fields and preserves authoritative event identity", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database, {
      now: () => "2026-08-02T00:00:00.000Z",
    });
    const current = await repository.getEvent("organization-1", "event-1");
    if (current === null) throw new Error("Expected the event fixture.");

    await repository.saveEvent(
      {
        ...current,
        version: 2,
        slug: "forged-slug",
        name: "Forged name",
        timezone: "America/New_York",
        opensAt: "2026-09-02T00:00:00.000Z",
        closesAt: "2026-10-02T00:00:00.000Z",
      },
      1,
    );

    expect(
      database.query<{
        slug: string;
        name: string;
        time_zone: string;
        starts_at: string;
        ends_at: string;
        cfp_opens_at: string;
        cfp_closes_at: string;
        version: number;
      }>(
        "SELECT slug, name, time_zone, starts_at, ends_at, cfp_opens_at, cfp_closes_at, version FROM events",
      ),
    ).toEqual([
      {
        slug: "future-conf",
        name: "Future Conf",
        time_zone: "UTC",
        starts_at: "2026-11-05T09:00:00.000Z",
        ends_at: "2026-11-07T17:00:00.000Z",
        cfp_opens_at: "2026-09-02T00:00:00.000Z",
        cfp_closes_at: "2026-10-02T00:00:00.000Z",
        version: 2,
      },
    ]);
  });

  it("rejects CFP boundaries that exceed a concurrently changed authoritative event start", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database, {
      now: () => "2026-08-02T00:00:00.000Z",
    });
    const current = await repository.getEvent("organization-1", "event-1");
    if (current === null) throw new Error("Expected the event fixture.");
    const update: EventCfp = {
      ...current,
      version: 2,
      opensAt: "2026-09-01T00:00:00.000Z",
      closesAt: "2026-10-02T00:00:00.000Z",
    };

    database.beforeNextBatch(() => {
      database.run(
        "UPDATE events SET starts_at = '2026-09-15T00:00:00.000-07:00' WHERE organization_id = 'organization-1' AND id = 'event-1'",
      );
    });

    await expect(repository.saveEvent(update, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      database.query<{ cfp_opens_at: string; cfp_closes_at: string; version: number }>(
        "SELECT cfp_opens_at, cfp_closes_at, version FROM events",
      ),
    ).toEqual([
      {
        cfp_opens_at: "2026-09-01T00:00:00.000Z",
        cfp_closes_at: "2026-10-01T00:00:00.000Z",
        version: 1,
      },
    ]);
  });

  it("hides legacy-retired events from public slug resolution without hiding organizer reads", async () => {
    const database = createDatabase();
    database.run(
      "UPDATE events SET legacy_retired_at = '2026-08-17T00:00:00.000Z' WHERE organization_id = 'organization-1' AND id = 'event-1'",
    );
    const repository = new D1CfpRepository(database as unknown as D1Database);

    await expect(repository.getEventBySlug("organization-1", "future-conf")).resolves.toBeNull();
    await expect(repository.getEvent("organization-1", "event-1")).resolves.toMatchObject({
      id: "event-1",
      slug: "future-conf",
    });
  });
  it("uses a D1 guard so stale configuration writes leave raw rows unchanged", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database, {
      now: () => "2026-08-02T00:00:00.000Z",
    });
    const event = await repository.getEvent("organization-1", "event-1");
    if (event === null) throw new Error("Expected the event fixture.");

    await repository.saveConfiguration(
      {
        ...event,
        version: 2,
        opensAt: "2026-09-01T00:00:00.000Z",
        closesAt: "2026-10-01T00:00:00.000Z",
      },
      form(),
      1,
      null,
    );
    const before = rawConfigurationState(database);

    await expect(
      repository.saveConfiguration(
        {
          ...event,
          version: 3,
          opensAt: "2026-09-02T00:00:00.000Z",
          closesAt: "2026-10-02T00:00:00.000Z",
        },
        form({ version: 2, name: "Stale replacement" }),
        1,
        1,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(rawConfigurationState(database)).toEqual(before);
    expect(database.query("SELECT * FROM cfp_configuration_write_guards")).toEqual([]);
  });
  it("rejects duplicate create without changing the existing aggregate", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database);
    const event = await repository.getEvent("organization-1", "event-1");
    if (event === null) throw new Error("Expected the event fixture.");
    await repository.saveConfiguration({ ...event, version: 2 }, form(), 1, null);
    const before = rawConfigurationState(database);

    await expect(
      repository.saveConfiguration(
        { ...event, version: 3 },
        form({ name: "Duplicate create" }),
        2,
        null,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(rawConfigurationState(database)).toEqual(before);
    expect(database.query("SELECT * FROM cfp_configuration_write_guards")).toEqual([]);
  });

  it("rejects a stale form whose current version equals the proposed version", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database);
    const event = await repository.getEvent("organization-1", "event-1");
    if (event === null) throw new Error("Expected the event fixture.");
    await repository.saveConfiguration({ ...event, version: 2 }, form(), 1, null);
    await repository.saveForm(
      form({
        version: 2,
        name: "Winning form",
        sections: [{ id: "winning", title: "Winning", description: "", order: 0 }],
        submissionFields: [
          {
            id: "winning-title",
            sectionId: "winning",
            key: "title",
            label: "Winning title",
            kind: "text",
            required: true,
            options: [],
          },
        ],
      }),
      1,
    );
    const before = rawConfigurationState(database);

    await expect(
      repository.saveConfiguration(
        { ...event, version: 3 },
        form({ version: 2, name: "Stale form" }),
        2,
        1,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(rawConfigurationState(database)).toEqual(before);
    expect(database.query("SELECT * FROM cfp_configuration_write_guards")).toEqual([]);
  });

  it("rejects date-ineligible and cross-scope aggregates without partial writes", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database);
    const event = await repository.getEvent("organization-1", "event-1");
    if (event === null) throw new Error("Expected the event fixture.");
    await repository.saveConfiguration({ ...event, version: 2 }, form(), 1, null);
    const before = rawConfigurationState(database);

    await expect(
      repository.saveConfiguration(
        {
          ...event,
          version: 3,
          opensAt: "2026-12-01T00:00:00.000Z",
          closesAt: "2026-12-02T00:00:00.000Z",
        },
        form({ version: 2 }),
        2,
        1,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      repository.saveConfiguration(
        { ...event, version: 3 },
        form({ tenantId: "other-organization", version: 2 }),
        2,
        1,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(rawConfigurationState(database)).toEqual(before);
    expect(database.query("SELECT * FROM cfp_configuration_write_guards")).toEqual([]);
  });

  it("atomically replaces the form graph and advances both versions", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database, {
      now: () => "2026-08-02T00:00:00.000Z",
    });
    const event = await repository.getEvent("organization-1", "event-1");
    if (event === null) throw new Error("Expected the event fixture.");
    await repository.saveConfiguration({ ...event, version: 2 }, form(), 1, null);

    await repository.saveConfiguration(
      {
        ...event,
        version: 3,
        opensAt: "2026-09-02T00:00:00.000Z",
        closesAt: "2026-10-02T00:00:00.000Z",
      },
      form({
        version: 2,
        name: "Updated CFP",
        sections: [{ id: "updated", title: "Updated", description: "", order: 0 }],
        submissionFields: [
          {
            id: "updated-title",
            sectionId: "updated",
            key: "title",
            label: "Updated title",
            kind: "text",
            required: true,
            options: [],
          },
        ],
      }),
      2,
      1,
    );

    expect(database.query<{ version: number }>("SELECT version FROM events")).toEqual([
      { version: 3 },
    ]);
    expect(
      database.query<{ name: string; version: number }>("SELECT name, version FROM cfp_forms"),
    ).toEqual([{ name: "Updated CFP", version: 2 }]);
    expect(database.query<{ id: string }>("SELECT id FROM cfp_form_sections")).toEqual([
      { id: "updated" },
    ]);
    expect(database.query<{ id: string }>("SELECT id FROM cfp_form_fields")).toEqual([
      { id: "updated-title" },
    ]);
    expect(database.query("SELECT * FROM cfp_configuration_write_guards")).toEqual([]);
  });
  it("rolls back aggregate writes when a child constraint fails after guard acquisition", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database);
    const event = await repository.getEvent("organization-1", "event-1");
    if (event === null) throw new Error("Expected the event fixture.");
    const before = rawConfigurationState(database);
    const duplicateFields = [
      {
        id: "duplicate",
        sectionId: "proposal",
        key: "title",
        label: "Title",
        kind: "text" as const,
        required: true,
        options: [],
      },
      {
        id: "duplicate",
        sectionId: "proposal",
        key: "duplicate-title",
        label: "Duplicate",
        kind: "text" as const,
        required: false,
        options: [],
      },
    ];

    await expect(
      repository.saveConfiguration(
        { ...event, version: 2 },
        form({ submissionFields: duplicateFields }),
        1,
        null,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(rawConfigurationState(database)).toEqual(before);
    expect(database.query("SELECT * FROM cfp_configuration_write_guards")).toEqual([]);
  });

  it("rolls back standalone updates when a child constraint fails after guard acquisition", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database);
    await repository.saveForm(form(), null);
    const before = rawConfigurationState(database);

    await expect(
      repository.saveForm(
        form({
          version: 2,
          name: "Must roll back",
          submissionFields: [
            {
              id: "duplicate",
              sectionId: "proposal",
              key: "title",
              label: "Title",
              kind: "text",
              required: true,
              options: [],
            },
            {
              id: "duplicate",
              sectionId: "proposal",
              key: "duplicate-title",
              label: "Duplicate",
              kind: "text",
              required: false,
              options: [],
            },
          ],
        }),
        1,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(rawConfigurationState(database)).toEqual(before);
    expect(database.query("SELECT * FROM cfp_configuration_write_guards")).toEqual([]);
  });

  it("guards standalone create, duplicate create, and cross-scope writes", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database);
    await repository.saveForm(form(), null);
    const afterCreate = rawConfigurationState(database);

    await expect(repository.saveForm(form({ name: "Duplicate" }), null)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      repository.saveForm(
        form({
          id: "other-form",
          tenantId: "other-organization",
          eventId: "event-1",
        }),
        null,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(rawConfigurationState(database)).toEqual(afterCreate);
    expect(database.query("SELECT * FROM cfp_configuration_write_guards")).toEqual([]);
  });
  it("guards standalone form replacement against a read-to-batch race", async () => {
    const database = createDatabase();
    const repository = new D1CfpRepository(database as unknown as D1Database, {
      now: () => "2026-08-02T00:00:00.000Z",
    });
    const event = await repository.getEvent("organization-1", "event-1");
    if (event === null) throw new Error("Expected the event fixture.");
    await repository.saveConfiguration(
      {
        ...event,
        version: 2,
        opensAt: "2026-09-01T00:00:00.000Z",
        closesAt: "2026-10-01T00:00:00.000Z",
      },
      form(),
      1,
      null,
    );
    const before = database.query<Record<string, unknown>>("SELECT * FROM cfp_forms ORDER BY id");
    database.beforeNextBatch(() => {
      database.run(
        "UPDATE cfp_forms SET version = 2 WHERE organization_id = 'organization-1' AND id = 'form-1'",
      );
    });

    await expect(
      repository.saveForm(form({ version: 2, name: "Lost update" }), 1),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(database.query("SELECT * FROM cfp_forms ORDER BY id")).toEqual(
      before.map((row) => ({ ...row, version: 2 })),
    );
    expect(database.query("SELECT * FROM cfp_configuration_write_guards")).toEqual([]);
  });
});
