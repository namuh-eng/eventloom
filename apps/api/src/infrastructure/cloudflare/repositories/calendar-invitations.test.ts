/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaState, PublishedAgendaRevision } from "../../../features/agenda/types";
import type { SpeakerProfile } from "../../../features/speaker/types";
import { CalendarInvitationLifecycle } from "../../../integrations/calendar";
import { reconcilePublishedAgendaCalendarInvitations } from "../../../runtime/airtable";
import type { CloudflareOutboxMessage } from "../bindings";
import { D1CalendarInvitationRepository } from "./calendar-invitations";

const NOW = "2026-08-14T12:00:00.000Z";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function expand(query: string, values: readonly unknown[]): string {
  let index = 0;
  const expanded = query.replaceAll("?", () => {
    const value = values[index];
    index += 1;
    return sqlLiteral(value);
  });
  if (index !== values.length) throw new Error("D1 test statement binding mismatch.");
  return expanded;
}

class SqliteStatement {
  readonly #values: unknown[];

  constructor(
    private readonly database: SqliteD1,
    readonly query: string,
    values: readonly unknown[] = [],
  ) {
    this.#values = [...values];
  }

  bind(...values: unknown[]) {
    return new SqliteStatement(this.database, this.query, values);
  }

  async first<T>(): Promise<T | null> {
    return (await this.all<T>()).results[0] ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.query<T>(expand(this.query, this.#values)) };
  }

  async run() {
    return { meta: { changes: this.database.run(expand(this.query, this.#values)) } };
  }

  expanded(): string {
    return expand(this.query, this.#values);
  }
}

class SqliteD1 {
  readonly path: string;

  constructor() {
    const directory = mkdtempSync(join(tmpdir(), "eventloom-calendar-d1-"));
    directories.push(directory);
    this.path = join(directory, "database.sqlite");
    this.execute(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE organizations (organization_id TEXT PRIMARY KEY NOT NULL) STRICT;
      CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        organization_id TEXT NOT NULL,
        UNIQUE (organization_id, id),
        FOREIGN KEY (organization_id) REFERENCES organizations(organization_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE outbox_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        deduplication_key TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, topic, deduplication_key)
      ) STRICT;
      INSERT INTO organizations (organization_id) VALUES ('org-1');
      INSERT INTO events (id, organization_id) VALUES ('event-1', 'org-1');
      ${readFileSync(
        join(process.cwd(), "apps/api/migrations/0021_calendar_invitation_lifecycle.sql"),
        "utf8",
      )}
    `);
  }

  prepare(query: string) {
    return new SqliteStatement(this, query);
  }

  async batch(statements: readonly SqliteStatement[]) {
    const script = [
      "PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;",
      ...statements.flatMap((statement) => [
        `${statement.expanded()};`,
        "SELECT changes() AS changes;",
      ]),
      "COMMIT;",
    ].join("\n");
    const output = this.execute(script);
    return output
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ meta: { changes: Number(JSON.parse(line)[0]?.changes ?? 0) } }));
  }

  query<T>(query: string): T[] {
    const output = this.execute(`PRAGMA foreign_keys = ON; ${query}`);
    return output.trim().length === 0 ? [] : (JSON.parse(output) as T[]);
  }

  run(query: string): number {
    const output = this.execute(
      `PRAGMA foreign_keys = ON; BEGIN IMMEDIATE; ${query}; SELECT changes() AS changes; COMMIT;`,
    );
    return Number(JSON.parse(output)[0]?.changes ?? 0);
  }

  private execute(sql: string): string {
    return execFileSync("sqlite3", ["-json", this.path], { input: sql, encoding: "utf8" }).trim();
  }
}

function repository(
  database: SqliteD1,
  send = vi.fn(async (_message: CloudflareOutboxMessage) => undefined),
) {
  return {
    send,
    value: new D1CalendarInvitationRepository({
      database: database as unknown as D1Database,
      queue: { send } as unknown as Queue<CloudflareOutboxMessage>,
      organizationId: "org-1",
      eventId: "event-1",
      sessionId: "session-1",
      now: () => new Date(NOW),
    }),
  };
}

function input(idempotencyKey: string, summary = "Durable calendars") {
  return {
    tenantId: "org-1",
    eventId: "event-1",
    sessionId: "session-1",
    timeZone: "UTC",
    startsAt: "2026-09-01T09:00:00.000Z",
    endsAt: "2026-09-01T10:00:00.000Z",
    attendees: ["speaker@example.com"],
    summary,
    location: "Room 1",
    idempotencyKey,
  };
}

function agendaState(): AgendaState {
  return {
    eventId: "event-1",
    stateVersion: 1,
    timeZone: "UTC",
    minimumTravelMinutes: 0,
    sessions: [
      {
        id: "session-1",
        title: "Durable calendars",
        status: "Accepted",
        publicApprovalEligible: true,
        participantIds: ["speaker-1"],
        resourceIds: [],
        capacityRequired: 0,
      },
    ],
    rooms: [{ id: "room-1", name: "Room 1", capacity: 10 }],
    tracks: [],
    draft: {
      eventId: "event-1",
      version: 1,
      timeZone: "UTC",
      entries: [],
      warningOverrides: [],
      updatedAt: NOW,
      updatedBy: "organizer-1",
    },
    revisions: [],
    currentPublishedRevisionId: null,
    outbox: [],
    audit: [],
    suggestionRuns: [],
  };
}

function revision(id: string, entries = 1): PublishedAgendaRevision {
  return {
    id,
    eventId: "event-1",
    revisionNumber: Number(id.slice(-1)),
    sourceDraftVersion: Number(id.slice(-1)),
    timeZone: "UTC",
    entries:
      entries === 0
        ? []
        : [
            {
              id: "entry-1",
              sessionId: "session-1",
              roomId: "room-1",
              trackIds: [],
              startsAt: "2026-09-01T09:00:00.000Z",
              endsAt: "2026-09-01T10:00:00.000Z",
              startsAtLocal: "2026-09-01T09:00:00",
              endsAtLocal: "2026-09-01T10:00:00",
              timeZone: "UTC",
              metadata: {
                title: "Durable calendars",
                summary: "",
                format: "Talk",
                speakerNames: ["Speaker One"],
                roomName: "Room 1",
                trackNames: [],
              },
            },
          ],
    warningOverrides: [],
    publishedAt: NOW,
    publishedBy: "organizer-1",
    rollbackOfRevisionId: null,
  };
}

const speakerProfile: SpeakerProfile = {
  id: "profile-1",
  eventId: "event-1",
  participantId: "speaker-1",
  displayName: "Speaker One",
  email: "speaker@example.com",
  biography: "",
  version: 1,
  updatedAt: NOW,
};

describe("D1CalendarInvitationRepository", () => {
  it("persists stable UID, organizer, sequence history, and one durable outbox job per publication", async () => {
    const database = new SqliteD1();
    const scoped = repository(database);
    const initialLifecycle = new CalendarInvitationLifecycle(scoped.value, {
      organizer: "calendar@legacy.example",
      uidDomain: "calendar.legacy.example",
    });
    const requested = await initialLifecycle.request(input("calendar-request-1"));
    const rotatedLifecycle = new CalendarInvitationLifecycle(scoped.value, {
      organizer: "calendar@current.example",
      uidDomain: "calendar.current.example",
    });
    const updated = await rotatedLifecycle.publishPayload({
      ...requested.payload,
      method: "UPDATE",
      summary: "Durable calendars updated",
      idempotencyKey: "calendar-update-2",
    });
    const replay = await rotatedLifecycle.publishPayload({
      ...requested.payload,
      method: "UPDATE",
      summary: "Durable calendars updated",
      idempotencyKey: "calendar-update-2",
    });

    expect(requested.sequence).toBe(0);
    expect(updated.sequence).toBe(1);
    expect(replay.sequence).toBe(1);
    expect(updated.uid).toBe(requested.uid);
    expect(updated.payload.organizer).toBe("calendar@legacy.example");
    expect(updated.ical).toContain("ORGANIZER:mailto:calendar@legacy.example");
    expect(scoped.send).toHaveBeenCalledTimes(2);
    expect(
      database.query<{ count: number }>(
        "SELECT count(*) AS count FROM calendar_invitation_publications",
      )[0]?.count,
    ).toBe(2);
    expect(
      database.query<{ count: number }>(
        "SELECT count(*) AS count FROM outbox_jobs WHERE topic = 'calendar'",
      )[0]?.count,
    ).toBe(2);
  });

  it("persists a cancellation with the authoritative identity and incremented sequence", async () => {
    const database = new SqliteD1();
    const scoped = repository(database);
    const lifecycle = new CalendarInvitationLifecycle(scoped.value, {
      organizer: "calendar@example.com",
      uidDomain: "calendar.example.com",
    });
    const requested = await lifecycle.request(input("calendar-request-1"));
    const cancelled = await lifecycle.publishPayload({
      ...requested.payload,
      method: "CANCEL",
      idempotencyKey: "calendar-cancel-2",
    });

    expect(cancelled.sequence).toBe(1);
    expect(cancelled.uid).toBe(requested.uid);
    expect(cancelled.ical).toContain("METHOD:CANCEL");
    expect(cancelled.ical).toContain("STATUS:CANCELLED");
    await expect(scoped.value.listActiveForEvent()).resolves.toEqual([]);
  });

  it("reconciles agenda publication updates and removed sessions into REQUEST, UPDATE, and CANCEL", async () => {
    const database = new SqliteD1();
    const send = vi.fn(async (_message: CloudflareOutboxMessage) => {
      if (send.mock.calls.length === 3) throw new Error("queue unavailable during cancellation");
    });
    const shared = {
      database: database as unknown as D1Database,
      queue: { send } as unknown as Queue<CloudflareOutboxMessage>,
      organizationId: "org-1",
      eventId: "event-1",
      agendaState: agendaState(),
      profiles: [speakerProfile],
    };

    await reconcilePublishedAgendaCalendarInvitations({
      ...shared,
      revision: revision("revision-1"),
      integrationOptions: {
        organizer: "calendar@legacy.example",
        uidDomain: "calendar.legacy.example",
      },
    });
    await reconcilePublishedAgendaCalendarInvitations({
      ...shared,
      revision: revision("revision-2"),
      integrationOptions: {
        organizer: "calendar@current.example",
        uidDomain: "calendar.current.example",
      },
    });
    const cancellation = {
      ...shared,
      revision: revision("revision-3", 0),
      integrationOptions: {
        organizer: "calendar@current.example",
        uidDomain: "calendar.current.example",
      },
    };
    await expect(reconcilePublishedAgendaCalendarInvitations(cancellation)).rejects.toThrow(
      "queue unavailable during cancellation",
    );
    await reconcilePublishedAgendaCalendarInvitations(cancellation);

    const stored = database.query<{
      uid: string;
      sequence: number;
      organizer: string;
      method: string;
      payload_json: string;
    }>("SELECT uid, sequence, organizer, method, payload_json FROM calendar_invitations")[0];
    expect(stored).toMatchObject({
      sequence: 2,
      organizer: "calendar@legacy.example",
      method: "CANCEL",
    });
    expect(stored?.uid).toContain("@calendar.legacy.example");
    expect(JSON.parse(stored?.payload_json ?? "{}")).toMatchObject({
      method: "CANCEL",
      sequence: 2,
      organizer: "calendar@legacy.example",
    });
    expect(send).toHaveBeenCalledTimes(4);
    expect(
      database.query<{ count: number }>("SELECT count(*) AS count FROM outbox_jobs")[0]?.count,
    ).toBe(3);
    expect(
      database.query<{ count: number }>(
        "SELECT count(*) AS count FROM outbox_jobs WHERE state = 'queued'",
      )[0]?.count,
    ).toBe(3);
  });

  it("keeps the outbox job pending when queue publication fails and queues it on replay", async () => {
    const database = new SqliteD1();
    const failing = repository(
      database,
      vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
    );
    const lifecycle = new CalendarInvitationLifecycle(failing.value, {
      organizer: "calendar@example.com",
      uidDomain: "calendar.example.com",
    });

    await expect(lifecycle.request(input("calendar-request-1"))).rejects.toThrow(
      "queue unavailable",
    );
    expect(database.query<{ state: string }>("SELECT state FROM outbox_jobs")[0]?.state).toBe(
      "pending",
    );

    const recovered = repository(database);
    const replayLifecycle = new CalendarInvitationLifecycle(recovered.value, {
      organizer: "calendar@example.com",
      uidDomain: "calendar.example.com",
    });
    await expect(replayLifecycle.request(input("calendar-request-1"))).resolves.toMatchObject({
      sequence: 0,
    });
    expect(recovered.send).toHaveBeenCalledOnce();
    expect(database.query<{ state: string }>("SELECT state FROM outbox_jobs")[0]?.state).toBe(
      "queued",
    );
  });
});
