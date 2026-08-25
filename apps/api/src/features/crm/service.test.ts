import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type CrmRouteEnvironment, createCrmRoutes } from "./routes";
import {
  CrmRepositoryConflictError,
  CrmService,
  CrmServiceError,
  InMemoryCrmRepository,
} from "./service";
import type {
  CrmActor,
  CrmContact,
  CrmContactTransitionAudit,
  UpdateCrmPipelineInput,
} from "./types";

const actor: CrmActor = { kind: "user", organizationId: "org-a", userId: "owner-a", role: "owner" };
const otherActor: CrmActor = {
  kind: "user",
  organizationId: "org-b",
  userId: "owner-b",
  role: "owner",
};

function service() {
  let sequence = 0;
  return new CrmService(
    { repository: new InMemoryCrmRepository() },
    {
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      generateId: (prefix) => `${prefix}-${++sequence}`,
    },
  );
}

function crmRouteApp(crm: CrmService): Hono<CrmRouteEnvironment> {
  const app = new Hono<CrmRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("authPrincipal", {
      kind: "user",
      sessionId: "crm-test-session",
      userId: actor.userId,
      email: "owner@example.test",
      memberships: [{ organizationId: actor.organizationId, role: "owner" }],
      speakerGrants: [],
      reviewerGrants: [],
    });
    await next();
  });
  app.route("/api/admin/organizations/:organizationId/crm", createCrmRoutes({ service: crm }));
  return app;
}

class FailPrimaryMergeRepository extends InMemoryCrmRepository {
  primaryContactId: string | undefined;
  failPrimarySaveOnce = false;
  duplicateRetirementWrites = 0;

  override async saveContact(
    contact: CrmContact,
    expectedVersion: number | null,
  ): Promise<CrmContact> {
    if (
      this.failPrimarySaveOnce &&
      contact.id === this.primaryContactId &&
      contact.status === "active" &&
      expectedVersion !== null
    ) {
      this.failPrimarySaveOnce = false;
      throw new Error("Injected primary save failure.");
    }
    if (contact.status === "merged" && contact.mergedIntoId === this.primaryContactId)
      this.duplicateRetirementWrites += 1;
    return super.saveContact(contact, expectedVersion);
  }
}
type CountedCrmRead =
  | "listContacts"
  | "listProjections"
  | "listOutreach"
  | "getContact"
  | "getCommandResult"
  | "getProjection";

class CountingDelayedCrmRepository extends InMemoryCrmRepository {
  readonly calls: Record<CountedCrmRead, number> = {
    listContacts: 0,
    listProjections: 0,
    listOutreach: 0,
    getContact: 0,
    getCommandResult: 0,
    getProjection: 0,
  };
  readonly started = new Set<CountedCrmRead>();
  activeReads = 0;
  maxConcurrentReads = 0;
  readonly #delays: Record<CountedCrmRead, number>;

  constructor(delays: Partial<Record<CountedCrmRead, number>> = {}) {
    super();
    this.#delays = {
      listContacts: 0,
      listProjections: 0,
      listOutreach: 0,
      getContact: 0,
      getCommandResult: 0,
      getProjection: 0,
      ...delays,
    };
  }

  resetReads(): void {
    for (const kind of Object.keys(this.calls) as CountedCrmRead[]) this.calls[kind] = 0;
    this.started.clear();
    this.activeReads = 0;
    this.maxConcurrentReads = 0;
  }

  private async delayed<T>(kind: CountedCrmRead, read: () => Promise<T>): Promise<T> {
    this.calls[kind] += 1;
    this.started.add(kind);
    this.activeReads += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, this.#delays[kind]));
      return await read();
    } finally {
      this.activeReads -= 1;
    }
  }

  override listContacts(
    organizationId: string,
    filter?: Parameters<InMemoryCrmRepository["listContacts"]>[1],
  ) {
    return this.delayed("listContacts", () => super.listContacts(organizationId, filter));
  }

  override listProjections(organizationId: string) {
    return this.delayed("listProjections", () => super.listProjections(organizationId));
  }

  override listOutreach(organizationId: string) {
    return this.delayed("listOutreach", () => super.listOutreach(organizationId));
  }

  override getContact(organizationId: string, contactId: string) {
    return this.delayed("getContact", () => super.getContact(organizationId, contactId));
  }

  override getProjection(organizationId: string, eventId: string, contactId: string) {
    return this.delayed("getProjection", () =>
      super.getProjection(organizationId, eventId, contactId),
    );
  }

  override getCommandResult<T>(organizationId: string, command: string, key: string) {
    return this.delayed("getCommandResult", () =>
      super.getCommandResult<T>(organizationId, command, key),
    );
  }
}
class DelayedOutreachPersistenceRepository extends InMemoryCrmRepository {
  readonly started: string[] = [];
  activeWrites = 0;
  maxConcurrentWrites = 0;

  constructor(private readonly delayMs = 5) {
    super();
  }

  private async tracked<T>(kind: string, work: () => Promise<T>): Promise<T> {
    this.started.push(kind);
    this.activeWrites += 1;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.activeWrites);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
      return await work();
    } finally {
      this.activeWrites -= 1;
    }
  }

  override appendHistory(entry: Parameters<InMemoryCrmRepository["appendHistory"]>[0]) {
    return this.tracked("history", () => super.appendHistory(entry));
  }

  override saveCommandResult<T>(
    organizationId: string,
    command: string,
    key: string,
    value: T,
  ): Promise<void> {
    return this.tracked("command-result", () =>
      super.saveCommandResult(organizationId, command, key, value),
    );
  }
}

describe("CrmService", () => {
  it("serializes competing contact updates and returns authoritative conflict state", async () => {
    class BundledRepositoryConflictError extends Error {
      override readonly name = "CrmRepositoryConflictError";

      constructor(readonly current: CrmContact | undefined) {
        super("The CRM record already exists or changed.");
      }
    }

    class BarrierCrmRepository extends InMemoryCrmRepository {
      private arrivals = 0;
      private release!: () => void;
      private readonly barrier = new Promise<void>((resolve) => {
        this.release = resolve;
      });

      override async saveContact(
        contact: CrmContact,
        expectedVersion: number | null,
      ): Promise<CrmContact> {
        if (expectedVersion !== null) {
          this.arrivals += 1;
          if (this.arrivals === 2) this.release();
          await this.barrier;
        }
        try {
          return await super.saveContact(contact, expectedVersion);
        } catch (error) {
          if (error instanceof CrmRepositoryConflictError) {
            throw new BundledRepositoryConflictError(error.current);
          }
          throw error;
        }
      }
    }

    const repository = new BarrierCrmRepository();
    let sequence = 0;
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-${++sequence}`,
      },
    );
    const created = await crm.createContact(actor, {
      organizationId: actor.organizationId,
      displayName: "Ada Lovelace",
      email: "ada@example.test",
    });

    const results = await Promise.allSettled([
      crm.updateContact(actor, {
        organizationId: actor.organizationId,
        contactId: created.id,
        expectedVersion: created.version,
        company: "Analytical Engines",
      }),
      crm.updateContact(actor, {
        organizationId: actor.organizationId,
        contactId: created.id,
        expectedVersion: created.version,
        title: "Principal Engineer",
      }),
    ]);
    const winners = results.filter(
      (result): result is PromiseFulfilledResult<CrmContact> => result.status === "fulfilled",
    );
    const conflicts = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(winners).toHaveLength(1);
    expect(winners[0]?.value.version).toBe(2);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBeInstanceOf(CrmServiceError);
    expect(conflicts[0]?.reason).toMatchObject({
      code: "CRM_CONFLICT",
      details: { current: winners[0]?.value },
    });

    const conflict = conflicts[0]?.reason as CrmServiceError;
    const current = (conflict.details as { current: CrmContact }).current;
    const retried = await crm.updateContact(actor, {
      organizationId: actor.organizationId,
      contactId: created.id,
      expectedVersion: current.version,
      title: "Principal Engineer",
    });
    expect(retried).toMatchObject({
      version: 3,
      title: "Principal Engineer",
    });
  });

  it("does not translate repository storage failures into optimistic conflicts", async () => {
    const failure = new Error("deliberate late history failure");
    class LateFailureRepository extends InMemoryCrmRepository {
      override async saveContact(
        contact: CrmContact,
        expectedVersion: number | null,
        transitionAudit?: CrmContactTransitionAudit,
      ): Promise<CrmContact> {
        if (expectedVersion !== null) throw failure;
        return super.saveContact(contact, expectedVersion, transitionAudit);
      }
    }
    const crm = new CrmService(
      { repository: new LateFailureRepository() },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-late-failure`,
      },
    );
    const created = await crm.createContact(actor, {
      organizationId: actor.organizationId,
      displayName: "Late Failure",
    });

    await expect(
      crm.updateContact(actor, {
        organizationId: actor.organizationId,
        contactId: created.id,
        expectedVersion: created.version,
        company: "Must roll back",
      }),
    ).rejects.toBe(failure);
  });

  it("persists pipeline scoring and one human-readable transition audit", async () => {
    const crm = service();
    const namedActor = { ...actor, actorName: "Owner Ada" } as CrmActor;
    const contact = await crm.createContact(namedActor, {
      organizationId: actor.organizationId,
      displayName: "Grace Hopper",
      email: "grace@example.test",
    });

    const progressed = await crm.setPipelineStage(namedActor, {
      organizationId: actor.organizationId,
      contactId: contact.id,
      expectedVersion: contact.version,
      stage: "qualified",
      score: 85,
      rationale: "Strong platform-engineering track record.",
      note: "Invite to the infrastructure track.",
    });

    expect(progressed).toMatchObject({
      version: 2,
      pipelineStage: "qualified",
      customFields: {
        pipelineScore: 85,
        pipelineRationale: "Strong platform-engineering track record.",
      },
    });
    await expect(
      crm.listPipelineHistory(namedActor, actor.organizationId, contact.id),
    ).resolves.toEqual([
      expect.objectContaining({
        fromStage: "new",
        toStage: "qualified",
        actorId: actor.userId,
        actorName: "Owner Ada",
        note: "Invite to the infrastructure track.",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
  });

  it.each([undefined, 0, -1, 1.5])(
    "rejects invalid pipeline expectedVersion %s at the service boundary",
    async (expectedVersion) => {
      const crm = service();
      const contact = await crm.createContact(actor, {
        organizationId: actor.organizationId,
        displayName: "Runtime Version Guard",
      });
      const input = {
        organizationId: actor.organizationId,
        contactId: contact.id,
        stage: "qualified",
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      } as unknown as UpdateCrmPipelineInput;

      await expect(crm.setPipelineStage(actor, input)).rejects.toMatchObject({
        name: "CrmServiceError",
        code: "CRM_INVALID_INPUT",
        message: "expectedVersion must be a positive integer.",
      });
      await expect(crm.getContact(actor, actor.organizationId, contact.id)).resolves.toMatchObject({
        pipelineStage: "new",
        version: contact.version,
      });
    },
  );

  it("keeps pipeline state and audit unchanged when the atomic save fails", async () => {
    class FailingTransitionRepository extends InMemoryCrmRepository {
      override async saveContact(
        contact: CrmContact,
        expectedVersion: number | null,
        transitionAudit?: CrmContactTransitionAudit,
      ): Promise<CrmContact> {
        if (transitionAudit !== undefined) throw new Error("Injected transition batch failure.");
        return super.saveContact(contact, expectedVersion);
      }
    }

    const repository = new FailingTransitionRepository();
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-atomic`,
      },
    );
    const contact = await crm.createContact(actor, {
      organizationId: actor.organizationId,
      displayName: "Atomic Pipeline Contact",
      email: "atomic-pipeline@example.test",
    });

    await expect(
      crm.setPipelineStage(actor, {
        organizationId: actor.organizationId,
        contactId: contact.id,
        expectedVersion: contact.version,
        stage: "qualified",
        note: "This transition must be all-or-nothing.",
      }),
    ).rejects.toThrow("Injected transition batch failure.");

    await expect(crm.getContact(actor, actor.organizationId, contact.id)).resolves.toMatchObject({
      version: 1,
      pipelineStage: "new",
    });
    await expect(crm.listPipelineHistory(actor, actor.organizationId, contact.id)).resolves.toEqual(
      [],
    );
    await expect(crm.getContactHistory(actor, actor.organizationId, contact.id)).resolves.toEqual(
      [],
    );
  });

  it("accepts route pipeline retries and keeps one transition for same-stage scoring", async () => {
    const repository = new InMemoryCrmRepository();
    let sequence = 0;
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-route-pipeline-${++sequence}`,
      },
    );
    const contact = await crm.createContact(actor, {
      organizationId: actor.organizationId,
      displayName: "Route Pipeline Contact",
      email: "route-pipeline@example.test",
    });
    const app = crmRouteApp(crm);
    const path = `/api/admin/organizations/org-a/crm/contacts/${contact.id}/pipeline`;

    const progressed = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: contact.version,
        stage: "qualified",
        score: 85,
        rationale: "Strong platform-engineering track record.",
        note: "Invite to the infrastructure track.",
      }),
    });
    expect(progressed.status).toBe(200);
    await expect(progressed.json()).resolves.toMatchObject({
      data: {
        version: 2,
        pipelineStage: "qualified",
        customFields: {
          pipelineScore: 85,
          pipelineRationale: "Strong platform-engineering track record.",
        },
      },
    });

    const stale = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: contact.version,
        stage: "won",
      }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: {
        code: "CONFLICT",
        details: { current: { id: contact.id, version: 2, pipelineStage: "qualified" } },
      },
    });

    const rescored = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 2,
        stage: "qualified",
        score: 90,
        rationale: "Updated after organizer review.",
      }),
    });
    expect(rescored.status).toBe(200);
    await expect(rescored.json()).resolves.toMatchObject({
      data: {
        version: 3,
        customFields: {
          pipelineScore: 90,
          pipelineRationale: "Updated after organizer review.",
        },
      },
    });
    await expect(repository.listPipelineHistory(actor.organizationId, contact.id)).resolves.toEqual(
      [
        expect.objectContaining({
          actorId: actor.userId,
          actorName: "owner@example.test",
          fromStage: "new",
          toStage: "qualified",
        }),
      ],
    );
  });

  it("filters contact search by event participant-link membership through the route", async () => {
    const repository = new InMemoryCrmRepository();
    let sequence = 0;
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-event-filter-${++sequence}`,
      },
    );
    const linked = await crm.createContact(actor, {
      organizationId: actor.organizationId,
      displayName: "Linked Contact",
      email: "linked@example.test",
    });
    await crm.createContact(actor, {
      organizationId: actor.organizationId,
      displayName: "Unlinked Contact",
      email: "unlinked@example.test",
    });
    await crm.addContactToEvent(actor, {
      organizationId: actor.organizationId,
      contactId: linked.id,
      eventId: "event-filter",
      idempotencyKey: "event-filter-link",
    });

    const response = await crmRouteApp(crm).request(
      "/api/admin/organizations/org-a/crm/contacts?eventId=event-filter",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [{ id: linked.id }],
    });
  });

  it("keeps contacts tenant isolated while supporting search, custom fields, and tags", async () => {
    const crm = service();
    const contact = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Ada Lovelace",
      email: "ADA@example.com",
      tags: ["Speaker", "speaker"],
      customFields: { sourceCampaign: "winter" },
    });
    await crm.createContact(otherActor, {
      organizationId: "org-b",
      displayName: "Ada B",
      email: "ada-b@example.com",
    });

    expect(contact.email).toBe("ada@example.com");
    expect(contact.tags).toEqual(["speaker"]);
    expect(
      (await crm.searchContacts(actor, "org-a", { query: "ada" })).map((item) => item.id),
    ).toEqual([contact.id]);
    await expect(crm.listContacts(actor, "org-b")).rejects.toMatchObject({ code: "CRM_FORBIDDEN" });
    await expect(crm.getContact(actor, "org-a", "missing")).rejects.toMatchObject({
      code: "CRM_NOT_FOUND",
    });
  });

  it("imports CSV rows idempotently and supports saved segment evaluation", async () => {
    const crm = service();
    const first = await crm.importCsv(actor, {
      organizationId: "org-a",
      idempotencyKey: "csv-1",
      csv: "name,email,topics\nGrace Hopper,grace@example.com,compiler\nAlan Turing,alan@example.com,security",
    });
    const replay = await crm.importCsv(actor, {
      organizationId: "org-a",
      idempotencyKey: "csv-1",
      csv: "name,email,topics\nGrace Hopper,grace@example.com,compiler\nAlan Turing,alan@example.com,security",
    });
    expect(first.created).toBe(2);
    expect(first.mapping).toEqual([
      { sourceColumn: "name", targetField: "displayName", custom: false },
      { sourceColumn: "email", targetField: "email", custom: false },
      { sourceColumn: "topics", targetField: "custom.topics", custom: true },
    ]);
    expect(first.rows).toEqual([
      {
        rowNumber: 1,
        identity: "grace@example.com",
        status: "created",
        contactId: first.contacts[0]?.id,
        reason: null,
      },
      {
        rowNumber: 2,
        identity: "alan@example.com",
        status: "created",
        contactId: first.contacts[1]?.id,
        reason: null,
      },
    ]);
    const createOnly = await crm.importCsv(actor, {
      organizationId: "org-a",
      idempotencyKey: "csv-create-only",
      mode: "create",
      csv: "name,email\nGrace Duplicate, GRACE@example.com\nNo identity,",
    });
    expect(createOnly).toMatchObject({ created: 0, updated: 0, skipped: 1, errors: 1 });
    expect(createOnly.rows.map((row) => row.status)).toEqual(["skipped", "error"]);
    expect(replay.id).toBe(first.id);
    expect(replay.idempotent).toBe(true);

    const segment = await crm.createSegment(actor, {
      organizationId: "org-a",
      name: "Compiler contacts",
      rules: [{ field: "custom.topics", operator: "contains", value: "compiler" }],
    });
    expect(
      (await crm.listSegmentContacts(actor, "org-a", segment.id)).map((item) => item.displayName),
    ).toEqual(["Grace Hopper"]);
  });

  it("imports same-name contacts by normalized email and preserves speaker metadata on partial updates", async () => {
    const crm = service();
    const result = await crm.importCsv(actor, {
      organizationId: "org-a",
      idempotencyKey: "speaker-import-identity",
      csv: [
        "name,email,jobTitle,company,source",
        "Priya Raman,priya@example.com,Principal Engineer,Latticework Systems,speaker",
        "Priya Raman,priya.second@example.com,Community Lead,Northstar,speaker",
        "Priya Updated, PRIYA@example.com, , ,speaker",
      ].join("\n"),
    });

    expect(result).toMatchObject({ created: 2, updated: 1, skipped: 0 });
    const contacts = await crm.listContacts(actor, "org-a", { limit: 10 });
    expect(contacts).toHaveLength(2);
    expect(contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: "Priya Updated",
          email: "priya@example.com",
          company: "Latticework Systems",
          title: "Principal Engineer",
          source: "speaker",
        }),
        expect.objectContaining({
          displayName: "Priya Raman",
          email: "priya.second@example.com",
          company: "Northstar",
          title: "Community Lead",
          source: "speaker",
        }),
      ]),
    );
    expect(result.rows[0]?.contactId).toBe(result.rows[2]?.contactId);
  });

  it("maps speaker row metadata without clearing fields omitted by a later email upsert", async () => {
    const crm = service();
    const created = await crm.importContacts(actor, {
      organizationId: "org-a",
      idempotencyKey: "speaker-row-create",
      rows: [
        {
          displayName: "Marcus Okafor",
          email: "MARCUS@example.com",
          company: "Northstar",
          jobTitle: "Community Lead",
          source: "speaker",
        },
      ],
    });
    const contactId = created.rows[0]?.contactId;
    expect(contactId).not.toBeNull();

    const updated = await crm.importContacts(actor, {
      organizationId: "org-a",
      idempotencyKey: "speaker-row-update",
      rows: [
        {
          displayName: "Marcus O.",
          email: " marcus@example.com ",
          company: " ",
          jobTitle: " ",
          source: "speaker",
        },
      ],
    });

    expect(updated).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    expect(updated.contacts).toEqual([
      expect.objectContaining({
        id: contactId,
        displayName: "Marcus O.",
        email: "marcus@example.com",
        company: "Northstar",
        title: "Community Lead",
        source: "speaker",
      }),
    ]);
    await expect(crm.listContacts(actor, "org-a")).resolves.toHaveLength(1);
  });
  it("detects and merges duplicates, retaining tags and custom fields", async () => {
    const crm = service();
    const primary = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Katherine Johnson",
      email: "katherine@example.com",
      tags: ["vip"],
      customFields: { cohort: "one" },
    });
    const duplicate = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Katherine Johnson",
      email: "other@example.com",
      tags: ["speaker"],
      customFields: { track: "math" },
    });
    expect(
      (await crm.findDuplicates(actor, "org-a", primary.id)).matches.map((item) => item.contact.id),
    ).toContain(duplicate.id);
    const merged = await crm.mergeContacts(actor, {
      organizationId: "org-a",
      primaryContactId: primary.id,
      duplicateContactIds: [duplicate.id],
      idempotencyKey: "merge-1",
    });
    expect(merged.primary.tags).toEqual(["speaker", "vip"]);
    expect(merged.primary.customFields).toMatchObject({ cohort: "one", track: "math" });
    expect(merged.merged[0]?.mergedIntoId).toBe(primary.id);
  });
  it("applies authoritative scalar and custom-field winners while merging duplicate emails", async () => {
    const crm = service();
    const primary = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Primary Contact",
      email: "primary@example.com",
      customFields: { role: "primary", region: "west" },
    });
    const duplicate = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Duplicate Contact",
      email: "winner@example.com",
      customFields: { role: "duplicate", source: "import" },
    });

    const merged = await crm.mergeContacts(actor, {
      organizationId: "org-a",
      primaryContactId: primary.id,
      duplicateContactIds: [duplicate.id],
      fieldWinners: { email: duplicate.id, name: duplicate.id },
      customFieldWinners: { role: duplicate.id },
      idempotencyKey: "merge-winners",
    });

    expect(merged.primary.email).toBe("winner@example.com");
    expect(merged.primary.displayName).toBe("Duplicate Contact");
    expect(merged.primary.customFields).toMatchObject({
      role: "duplicate",
      region: "west",
      source: "import",
    });
    expect(merged.merged[0]?.status).toBe("merged");
    expect(merged.merged[0]?.mergedIntoId).toBe(primary.id);
  });

  it("rejects invalid or cross-tenant winner IDs before mutating contacts", async () => {
    const crm = service();
    const primary = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Primary Contact",
      email: "primary@example.com",
    });
    const duplicate = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Duplicate Contact",
      email: "duplicate@example.com",
    });
    const foreign = await crm.createContact(otherActor, {
      organizationId: "org-b",
      displayName: "Foreign Contact",
      email: "foreign@example.com",
    });

    await expect(
      crm.mergeContacts(actor, {
        organizationId: "org-a",
        primaryContactId: primary.id,
        duplicateContactIds: [duplicate.id],
        fieldWinners: { email: "missing-contact" },
      }),
    ).rejects.toMatchObject({ code: "CRM_INVALID_INPUT" });
    await expect(
      crm.mergeContacts(actor, {
        organizationId: "org-a",
        primaryContactId: primary.id,
        duplicateContactIds: [duplicate.id],
        fieldWinners: { email: foreign.id },
      }),
    ).rejects.toMatchObject({ code: "CRM_INVALID_INPUT" });

    expect(await crm.getContact(actor, "org-a", primary.id)).toEqual(primary);
    expect(await crm.getContact(actor, "org-a", duplicate.id)).toEqual(duplicate);
  });

  it("replays an idempotent merge without applying it twice", async () => {
    const crm = service();
    const primary = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Primary Contact",
      email: "primary@example.com",
    });
    const duplicate = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Duplicate Contact",
      email: "duplicate@example.com",
    });
    const input = {
      organizationId: "org-a",
      primaryContactId: primary.id,
      duplicateContactIds: [duplicate.id],
      fieldWinners: { email: duplicate.id },
      idempotencyKey: "merge-replay",
    } as const;

    const first = await crm.mergeContacts(actor, input);
    const replay = await crm.mergeContacts(actor, input);

    expect(first.idempotent).toBe(false);
    expect(replay.idempotent).toBe(true);
    expect(replay.primary).toEqual(first.primary);
    expect(await crm.getContactHistory(actor, "org-a", primary.id)).toHaveLength(1);
  });
  it("resumes after duplicate retirement when the primary save fails", async () => {
    let sequence = 0;
    const repository = new FailPrimaryMergeRepository();
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-${++sequence}`,
      },
    );
    const primary = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Primary Contact",
      email: "primary@example.com",
      customFields: { region: "west" },
    });
    const duplicate = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Duplicate Contact",
      email: "winner@example.com",
      customFields: { role: "duplicate", source: "import" },
    });
    repository.primaryContactId = primary.id;
    repository.failPrimarySaveOnce = true;
    const input = {
      organizationId: "org-a",
      primaryContactId: primary.id,
      duplicateContactIds: [duplicate.id],
      fieldWinners: { email: duplicate.id },
      customFieldWinners: { role: duplicate.id },
      idempotencyKey: "merge-resume",
    } as const;

    await expect(crm.mergeContacts(actor, input)).rejects.toThrow("Injected primary save failure.");

    const partiallyMergedDuplicate = await crm.getContact(actor, "org-a", duplicate.id);
    expect(partiallyMergedDuplicate).toMatchObject({
      status: "merged",
      mergedIntoId: primary.id,
      customFields: duplicate.customFields,
    });
    expect(await crm.getContact(actor, "org-a", primary.id)).toEqual(primary);

    const retry = await crm.mergeContacts(actor, input);
    expect(retry.idempotent).toBe(false);
    expect(retry.primary.email).toBe(duplicate.email);
    expect(retry.primary.customFields).toMatchObject({
      region: "west",
      role: "duplicate",
      source: "import",
    });
    expect(retry.merged[0]?.customFields).toEqual(duplicate.customFields);
    expect(repository.duplicateRetirementWrites).toBe(1);

    const replay = await crm.mergeContacts(actor, input);
    expect(replay.idempotent).toBe(true);
    expect(repository.duplicateRetirementWrites).toBe(1);
    expect(await crm.getContactHistory(actor, "org-a", primary.id)).toHaveLength(1);
  });

  it("records pipeline history, notes, event projection, personalized outreach, and analytics", async () => {
    const crm = service();
    const contact = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Grace Hopper",
      email: "grace@example.com",
      firstName: "Grace",
    });
    const progressed = await crm.setPipelineStage(actor, {
      organizationId: "org-a",
      contactId: contact.id,
      expectedVersion: contact.version,
      stage: "qualified",
      note: "Strong fit",
    });
    expect(progressed.pipelineStage).toBe("qualified");
    await crm.addNote(actor, {
      organizationId: "org-a",
      contactId: contact.id,
      body: "Follow up after the event.",
    });
    const event = await crm.addContactToEvent(actor, {
      organizationId: "org-a",
      contactId: contact.id,
      eventId: "event-a",
      idempotencyKey: "event-1",
    });
    expect(
      (
        await crm.addContactToEvent(actor, {
          organizationId: "org-a",
          contactId: contact.id,
          eventId: "event-a",
          idempotencyKey: "event-1",
        })
      ).idempotent,
    ).toBe(true);
    const existingEvent = await crm.addContactToEvent(actor, {
      organizationId: "org-a",
      contactId: contact.id,
      eventId: "event-a",
      idempotencyKey: "event-2",
    });
    expect(existingEvent).toMatchObject({ idempotent: true, outcome: "existing" });
    await expect(
      crm.addContactToEvent(actor, {
        organizationId: "org-a",
        contactId: contact.id,
        eventId: "event-a",
        role: "speaker",
        idempotencyKey: "event-1",
      }),
    ).rejects.toMatchObject({ code: "CRM_CONFLICT" });
    const outreach = await crm.sendPersonalizedOutreach(actor, {
      organizationId: "org-a",
      contactId: contact.id,
      subject: "Hello",
      body: "Hi {{firstName}}",
      idempotencyKey: "outreach-1",
    });
    expect(outreach.renderedBody).toBe("Hi Grace");
    expect(outreach).toMatchObject({
      subject: "Hello",
      status: "failed",
      queuedCount: 0,
      sentCount: 0,
      failedCount: 1,
      terminal: true,
    });
    const history = await crm.getContactHistory(actor, "org-a", contact.id);
    expect(history.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["pipeline", "note", "event", "communication"]),
    );
    expect((await crm.analytics(actor, "org-a")).contactsByEvent).toEqual([
      { eventId: "event-a", count: 1 },
    ]);
    expect(event.projection.contactId).toBe(contact.id);
    expect(event.outcome).toBe("created");
    await expect(
      crm.sendPersonalizedOutreach(actor, {
        organizationId: "org-a",
        contactId: contact.id,
        subject: "Hello {{unknownTag}}",
        body: "Body",
        idempotencyKey: "outreach-unknown",
      }),
    ).rejects.toMatchObject({ code: "CRM_INVALID_INPUT" });
  });
  it("persists outreach history before the idempotent command result", async () => {
    const repository = new DelayedOutreachPersistenceRepository();
    let sequence = 0;
    const crm = new CrmService(
      {
        repository,
        outreach: {
          async send(command) {
            return { ...command, status: "queued" };
          },
        },
      },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-${++sequence}`,
      },
    );
    const contact = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Parallel Persistence",
      email: "parallel@example.com",
    });

    const result = await crm.sendPersonalizedOutreach(actor, {
      organizationId: "org-a",
      contactId: contact.id,
      subject: "Queue",
      body: "Hello",
      idempotencyKey: "outreach-parallel-persistence",
    });

    expect(result.status).toBe("queued");
    expect(repository.started).toEqual(["history", "command-result"]);
    expect(repository.maxConcurrentWrites).toBe(1);
    await expect(
      repository.getCommandResult("org-a", "outreach", "outreach-parallel-persistence"),
    ).resolves.toEqual(result);
  });
  it("keeps built-in outreach merge tags server-owned with deterministic name fallback", async () => {
    const repository = new InMemoryCrmRepository();
    const crm = new CrmService(
      {
        repository,
        outreach: {
          async send(command) {
            return { ...command, status: "queued" };
          },
        },
      },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (() => {
          let sequence = 0;
          return (prefix: string) => `${prefix}-${++sequence}`;
        })(),
      },
    );
    const displayNameOnly = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Dana Kowalski",
      email: "dana@example.com",
    });
    const explicitFirstName = await crm.createContact(actor, {
      organizationId: "org-a",
      firstName: "Ada",
      displayName: "Ada Lovelace",
      email: "ada@example.com",
    });

    const fallback = await crm.sendPersonalizedOutreach(actor, {
      organizationId: "org-a",
      contactId: displayNameOnly.id,
      subject: "Hello {{first_name}}",
      body: "Hi {{first_name}} / {{display_name}} / {{firstName}}",
      variables: {
        first_name: "",
        firstName: "Caller override",
        display_name: "Caller display override",
      },
      idempotencyKey: "outreach-merge-fallback",
    });
    expect(fallback.renderedBody).toBe("Hi Dana / Dana Kowalski / Dana");
    expect(fallback.status).toBe("queued");

    const explicit = await crm.sendPersonalizedOutreach(actor, {
      organizationId: "org-a",
      contactId: explicitFirstName.id,
      subject: "Hello {{first_name}}",
      body: "Hi {{first_name}}",
      variables: { first_name: "" },
      idempotencyKey: "outreach-merge-explicit",
    });
    expect(explicit.renderedBody).toBe("Hi Ada");

    await expect(
      crm.sendPersonalizedOutreach(actor, {
        organizationId: "org-a",
        contactId: displayNameOnly.id,
        subject: "Hello {{unknown_tag}}",
        body: "Body",
        idempotencyKey: "outreach-merge-unknown",
      }),
    ).rejects.toMatchObject({ code: "CRM_INVALID_INPUT" });
  });
  it("renders outreach names from explicit fields and trimmed display names", async () => {
    const crm = service();
    const explicit = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Display Person",
      firstName: "Explicit",
      lastName: "Names",
      email: "explicit@example.com",
    });
    const explicitOutreach = await crm.sendPersonalizedOutreach(actor, {
      organizationId: "org-a",
      contactId: explicit.id,
      subject: "Subject {{first_name}} {{firstName}}",
      body: "Hi {{last_name}} {{lastName}}",
      variables: {
        first_name: "Ignored",
        firstName: "Ignored",
        last_name: "Ignored",
        lastName: "Ignored",
      },
      idempotencyKey: "outreach-explicit-names",
    });
    expect(explicitOutreach.subject).toBe("Subject Explicit Explicit");
    expect(explicitOutreach.renderedBody).toBe("Hi Names Names");

    for (const [id, displayName, firstName, lastName] of [
      ["dana", " Dana   Okafor ", "Dana", "Okafor"],
      ["marcus", "Marcus Chen", "Marcus", "Chen"],
    ] as const) {
      const displayNameOnly = await crm.createContact(actor, {
        organizationId: "org-a",
        displayName,
        email: `${id}@example.com`,
      });
      const fallbackOutreach = await crm.sendPersonalizedOutreach(actor, {
        organizationId: "org-a",
        contactId: displayNameOnly.id,
        subject: "Subject {{first_name}} {{firstName}}",
        body: "Hi {{last_name}} {{lastName}}",
        variables: {
          first_name: "",
          firstName: "",
          last_name: "",
          lastName: "",
        },
        idempotencyKey: `outreach-${id}-names`,
      });
      expect(fallbackOutreach.subject).toBe(`Subject ${firstName} ${firstName}`);
      expect(fallbackOutreach.renderedBody).toBe(`Hi ${lastName} ${lastName}`);
    }
  });
  it("starts analytics reads together and scopes each source to the organization", async () => {
    const repository = new CountingDelayedCrmRepository({
      listContacts: 25,
      listProjections: 75,
      listOutreach: 150,
    });
    let sequence = 0;
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-${++sequence}`,
      },
    );
    const contact = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Analytics Contact",
      email: "analytics@example.com",
    });
    const otherContact = await crm.createContact(otherActor, {
      organizationId: "org-b",
      displayName: "Other Analytics Contact",
      email: "other-analytics@example.com",
    });
    await crm.addContactToEvent(actor, {
      organizationId: "org-a",
      contactId: contact.id,
      eventId: "event-a",
      idempotencyKey: "analytics-event-a",
    });
    await crm.addContactToEvent(otherActor, {
      organizationId: "org-b",
      contactId: otherContact.id,
      eventId: "event-b",
      idempotencyKey: "analytics-event-b",
    });
    await crm.sendPersonalizedOutreach(actor, {
      organizationId: "org-a",
      contactId: contact.id,
      subject: "Analytics",
      body: "Hello",
      idempotencyKey: "analytics-outreach-a",
    });
    await crm.sendPersonalizedOutreach(otherActor, {
      organizationId: "org-b",
      contactId: otherContact.id,
      subject: "Other Analytics",
      body: "Hello",
      idempotencyKey: "analytics-outreach-b",
    });
    repository.resetReads();

    const analytics = await crm.analytics(actor, "org-a");

    expect(repository.calls).toEqual({
      listContacts: 1,
      listProjections: 1,
      listOutreach: 1,
      getContact: 0,
      getCommandResult: 0,
      getProjection: 0,
    });
    expect(repository.started).toEqual(
      new Set(["listContacts", "listProjections", "listOutreach"]),
    );
    expect(repository.maxConcurrentReads).toBe(3);
    expect(analytics).toMatchObject({
      organizationId: "org-a",
      totalContacts: 1,
      activeContacts: 1,
      contactsByEvent: [{ eventId: "event-a", count: 1 }],
      outreach: { queued: 0, sent: 0, failed: 1 },
      contactsByPipelineStage: { new: 1 },
      contactsBySource: { manual: 1 },
    });
  });

  it("reuses add-to-event receipts without rereading the contact or projection", async () => {
    const repository = new CountingDelayedCrmRepository();
    let sequence = 0;
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-${++sequence}`,
      },
    );
    const contact = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Event Contact",
      email: "event@example.com",
    });
    const input = {
      organizationId: "org-a",
      contactId: contact.id,
      eventId: "event-a",
      idempotencyKey: "event-reuse",
    } as const;

    repository.resetReads();
    const created = await crm.addContactToEvent(actor, input);
    expect(created).toMatchObject({ outcome: "created", idempotent: false });
    expect(created.projection.participantId).toBe(`crm-participant:event-a:${contact.id}`);
    expect(repository.calls).toEqual({
      listContacts: 0,
      listProjections: 0,
      listOutreach: 0,
      getContact: 1,
      getCommandResult: 1,
      getProjection: 0,
    });

    repository.resetReads();
    const replay = await crm.addContactToEvent(actor, input);
    expect(replay).toEqual({ ...created, idempotent: true });
    expect(repository.calls).toEqual({
      listContacts: 0,
      listProjections: 0,
      listOutreach: 0,
      getContact: 0,
      getCommandResult: 1,
      getProjection: 0,
    });

    repository.resetReads();
    const reused = await crm.addContactToEvent(actor, {
      ...input,
      idempotencyKey: "event-reuse-alias",
    });
    expect(reused).toMatchObject({
      outcome: "existing",
      idempotent: true,
      projection: created.projection,
    });
    expect(repository.calls).toEqual({
      listContacts: 0,
      listProjections: 0,
      listOutreach: 0,
      getContact: 1,
      getCommandResult: 1,
      getProjection: 0,
    });
    expect(await repository.listProjections("org-a")).toHaveLength(1);
    expect(await repository.listHistory("org-a", contact.id)).toHaveLength(1);
  });
  it("keeps same-name event projections keyed by contact identity", async () => {
    const repository = new InMemoryCrmRepository();
    let sequence = 0;
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-${++sequence}`,
      },
    );
    const first = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Marcus Chen",
      email: "marcus.first@example.com",
    });
    const selected = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Marcus Chen",
      email: "marcus.selected@example.com",
    });

    await crm.addContactToEvent(actor, {
      organizationId: "org-a",
      contactId: first.id,
      eventId: "event-a",
      idempotencyKey: "event-first",
    });
    const projected = await crm.addContactToEvent(actor, {
      organizationId: "org-a",
      contactId: selected.id,
      eventId: "event-a",
      idempotencyKey: "event-selected",
    });

    const projections = await repository.listProjections("org-a");
    expect(projections).toHaveLength(2);
    expect(projections.map((projection) => projection.contactId)).toEqual(
      expect.arrayContaining([first.id, selected.id]),
    );
    expect(projected.projection.contactId).toBe(selected.id);
    await expect(crm.getContact(actor, "org-a", selected.id)).resolves.toMatchObject({
      id: selected.id,
      email: "marcus.selected@example.com",
    });
  });
  it("uses the outreach boundary once while retaining an Airtable-compatible command receipt", async () => {
    const repository = new InMemoryCrmRepository();
    const sent: string[] = [];
    const crm = new CrmService(
      {
        repository,
        outreach: {
          async send(command) {
            sent.push(command.idempotencyKey);
            return { ...command, status: "queued" };
          },
        },
      },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-boundary`,
      },
    );
    const contact = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Queue Recipient",
      email: "recipient@example.com",
    });
    const input = {
      organizationId: "org-a",
      contactId: contact.id,
      subject: "Follow up",
      body: "Hello {{displayName}}",
      idempotencyKey: "outreach-boundary-1",
    };
    const first = await crm.sendPersonalizedOutreach(actor, input);
    const replay = await crm.sendPersonalizedOutreach(actor, input);
    expect(first.status).toBe("queued");
    expect(first).toMatchObject({
      status: "queued",
      queuedCount: 1,
      sentCount: 0,
      failedCount: 0,
      terminal: false,
      recipientEmail: "recipient@example.com",
      subject: "Follow up",
    });
    expect(replay).toEqual(first);
    expect(sent).toEqual(["outreach-boundary-1"]);
    await expect(
      repository.getOutreachByIdempotencyKey("org-a", input.idempotencyKey),
    ).resolves.toEqual(expect.objectContaining({ contactId: contact.id, status: "queued" }));
    expect(
      (await repository.listHistory("org-a", contact.id)).filter(
        (entry) => entry.kind === "communication",
      ),
    ).toHaveLength(1);

    const delivered = await crm.recordOutreachDeliveryStatus({
      organizationId: "org-a",
      outreachId: first.id,
      idempotencyKey: input.idempotencyKey,
      status: "delivered",
      providerMessageId: "provider-message-1",
      occurredAt: "2026-01-01T00:01:00.000Z",
    });
    expect(delivered).toMatchObject({
      status: "delivered",
      queuedCount: 0,
      sentCount: 1,
      failedCount: 0,
      terminal: true,
      providerMessageId: "provider-message-1",
      completedAt: "2026-01-01T00:01:00.000Z",
    });
    await expect(
      crm.recordOutreachDeliveryStatus({
        organizationId: "org-a",
        outreachId: first.id,
        idempotencyKey: input.idempotencyKey,
        status: "delivered",
        providerMessageId: "provider-message-1",
      }),
    ).resolves.toEqual(delivered);
    await expect(
      crm.recordOutreachDeliveryStatus({
        organizationId: "org-a",
        outreachId: first.id,
        idempotencyKey: input.idempotencyKey,
        status: "bounced",
      }),
    ).rejects.toMatchObject({ code: "CRM_CONFLICT" });
    expect(
      (await repository.listHistory("org-a", contact.id)).filter(
        (entry) => entry.kind === "communication",
      ),
    ).toHaveLength(2);
  });
  it.each(["failed", "bounced", "complained"] as const)(
    "persists terminal %s outreach completion",
    async (status) => {
      const repository = new InMemoryCrmRepository();
      const crm = new CrmService(
        {
          repository,
          outreach: {
            async send(command) {
              return { ...command, status: "queued" };
            },
          },
        },
        {
          clock: () => new Date("2026-01-01T00:00:00.000Z"),
          generateId: (prefix) => `${prefix}-${status}`,
        },
      );
      const contact = await crm.createContact(actor, {
        organizationId: "org-a",
        displayName: "Terminal Recipient",
        email: `${status}@example.com`,
      });
      const outreach = await crm.sendPersonalizedOutreach(actor, {
        organizationId: "org-a",
        contactId: contact.id,
        subject: "Follow up",
        body: "Hello",
        idempotencyKey: `outreach-${status}`,
      });

      const completed = await crm.recordOutreachDeliveryStatus({
        organizationId: "org-a",
        outreachId: outreach.id,
        idempotencyKey: `outreach-${status}`,
        status,
        providerMessageId: `provider-${status}`,
        reason: `provider reported ${status}`,
      });

      expect(completed).toMatchObject({
        status,
        queuedCount: 0,
        sentCount: 0,
        failedCount: 1,
        terminal: true,
        failureReason: `provider reported ${status}`,
        providerMessageId: `provider-${status}`,
      });
    },
  );
  it("previews CSV without mutation and persists authoritative row outcomes across reload", async () => {
    const repository = new InMemoryCrmRepository();
    let sequence = 0;
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-${++sequence}`,
      },
    );
    const existing = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Existing",
      email: "existing@example.com",
    });
    const rows = [
      { displayName: "Created", email: "created@example.com" },
      { displayName: "Updated", email: "existing@example.com", company: "Northstar" },
      { displayName: "Updated", email: "existing@example.com", company: "Northstar" },
      { displayName: "Malformed", email: "not-an-email" },
    ] as const;
    const before = await repository.listContacts("org-a");
    const preview = await crm.previewImport(actor, {
      organizationId: "org-a",
      rows,
    });
    expect(preview.preview).toBe(true);
    expect(preview.rows.map((row) => row.status)).toEqual([
      "created",
      "updated",
      "skipped",
      "error",
    ]);
    expect(preview.errors).toBe(1);
    expect(await repository.listContacts("org-a")).toEqual(before);

    const committed = await crm.importContacts(actor, {
      organizationId: "org-a",
      rows,
      idempotencyKey: "csv-reconcile-1",
    });
    expect(committed).toMatchObject({ created: 1, updated: 1, skipped: 1, errors: 1 });
    expect(committed.rows.map((row) => row.rowNumber)).toEqual([1, 2, 3, 4]);
    const reloaded = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-reload-${++sequence}`,
      },
    );
    const replay = await reloaded.importContacts(actor, {
      organizationId: "org-a",
      rows,
      idempotencyKey: "csv-reconcile-1",
    });
    expect(replay).toEqual({ ...committed, idempotent: true });
    expect(replay.contacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: existing.id, company: "Northstar" })]),
    );
  });

  it("reconciles safe CRM relationships while retaining tombstone provenance", async () => {
    const repository = new InMemoryCrmRepository();
    let sequence = 0;
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-${++sequence}`,
      },
    );
    const survivor = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Survivor",
      email: "survivor@example.com",
    });
    const retired = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Retired",
      email: "retired@example.com",
    });
    await crm.addNote(actor, {
      organizationId: "org-a",
      contactId: retired.id,
      body: "Historical note",
    });
    await crm.setPipelineStage(actor, {
      organizationId: "org-a",
      contactId: retired.id,
      expectedVersion: retired.version,
      stage: "qualified",
    });
    const projection = await crm.addContactToEvent(actor, {
      organizationId: "org-a",
      contactId: retired.id,
      participantId: "participant-a",
      eventId: "event-a",
      idempotencyKey: "link-retired",
    });
    const segment = await crm.createSegment(actor, {
      organizationId: "org-a",
      name: "Retired segment",
      rules: [{ field: "custom.contactId", operator: "eq", value: retired.id }],
    });
    const outreach = await crm.sendPersonalizedOutreach(actor, {
      organizationId: "org-a",
      contactId: retired.id,
      subject: "Historical recipient",
      body: "Do not rewire",
      idempotencyKey: "retired-recipient-snapshot",
    });

    const preview = await crm.previewMergeContacts(actor, {
      organizationId: "org-a",
      primaryContactId: survivor.id,
      duplicateContactIds: [retired.id],
    });
    expect(preview.canCommit).toBe(true);
    expect(preview.rewired).toEqual({
      participantContactLinks: 1,
      notes: 1,
      segments: 1,
      pipelineHistory: 1,
    });
    expect((await repository.getContact("org-a", retired.id))?.status).toBe("active");

    const merged = await crm.mergeContacts(actor, {
      organizationId: "org-a",
      primaryContactId: survivor.id,
      duplicateContactIds: [retired.id],
      idempotencyKey: "merge-reconcile-1",
    });
    expect(merged).toMatchObject({
      survivorId: survivor.id,
      retiredIds: [retired.id],
      auditId: expect.any(String),
      rewired: {
        participantContactLinks: 1,
        notes: 1,
        segments: 1,
        pipelineHistory: 1,
      },
    });
    expect(merged.merged[0]).toMatchObject({
      id: retired.id,
      status: "merged",
      mergedIntoId: survivor.id,
      mergeAuditId: merged.auditId,
    });
    expect((await repository.listNotes("org-a", survivor.id))[0]).toMatchObject({
      body: "Historical note",
      contactId: survivor.id,
      sourceCrmContactId: retired.id,
      mergeAuditId: merged.auditId,
    });
    expect((await repository.listPipelineHistory("org-a", survivor.id))[0]).toMatchObject({
      contactId: survivor.id,
      sourceCrmContactId: retired.id,
      mergeAuditId: merged.auditId,
    });
    expect((await repository.listParticipantContactLinks("org-a"))[0]).toMatchObject({
      participantId: "participant-a",
      eventId: "event-a",
      crmContactId: survivor.id,
      sourceCrmContactId: retired.id,
      mergeAuditId: merged.auditId,
    });
    expect(await repository.getProjection("org-a", "event-a", retired.id)).toBeNull();
    expect(await repository.getProjection("org-a", "event-a", survivor.id)).toMatchObject({
      participantId: "participant-a",
      crmContactId: survivor.id,
    });
    expect(await repository.getSegment("org-a", segment.id)).toMatchObject({
      rules: [expect.objectContaining({ value: survivor.id })],
      mergeAuditIds: [merged.auditId],
    });
    expect(
      await repository.getOutreachByIdempotencyKey("org-a", "retired-recipient-snapshot"),
    ).toMatchObject({
      id: outreach.id,
      contactId: retired.id,
      recipientEmail: "retired@example.com",
    });
    expect(projection.projection.participantId).toBe("participant-a");
  });

  it("fails same-event distinct-participant collisions before any CRM mutation", async () => {
    const repository = new InMemoryCrmRepository();
    let sequence = 0;
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-collision-${++sequence}`,
      },
    );
    const survivor = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Survivor",
      email: "collision-survivor@example.com",
    });
    const retired = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Retired",
      email: "collision-retired@example.com",
    });
    await crm.addContactToEvent(actor, {
      organizationId: "org-a",
      contactId: survivor.id,
      participantId: "participant-one",
      eventId: "event-collision",
      idempotencyKey: "collision-one",
    });
    await crm.addContactToEvent(actor, {
      organizationId: "org-a",
      contactId: retired.id,
      participantId: "participant-two",
      eventId: "event-collision",
      idempotencyKey: "collision-two",
    });

    const preview = await crm.previewMergeContacts(actor, {
      organizationId: "org-a",
      primaryContactId: survivor.id,
      duplicateContactIds: [retired.id],
    });
    expect(preview.participantConflicts).toEqual([
      expect.objectContaining({
        eventId: "event-collision",
        participantIds: ["participant-one", "participant-two"],
      }),
    ]);
    await expect(
      crm.mergeContacts(actor, {
        organizationId: "org-a",
        primaryContactId: survivor.id,
        duplicateContactIds: [retired.id],
        idempotencyKey: "collision-commit",
      }),
    ).rejects.toMatchObject({
      code: "CRM_CONFLICT",
      details: { participantConflicts: expect.any(Array) },
    });
    expect(await crm.getContact(actor, "org-a", survivor.id)).toMatchObject({ status: "active" });
    expect(await crm.getContact(actor, "org-a", retired.id)).toMatchObject({ status: "active" });
    expect(
      (await repository.listParticipantContactLinks("org-a")).map((link) => link.crmContactId),
    ).toEqual(expect.arrayContaining([survivor.id, retired.id]));
  });
  it("exposes read-only import preview and requires idempotency for route commits", async () => {
    const repository = new InMemoryCrmRepository();
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-route`,
      },
    );
    const app = crmRouteApp(crm);
    const base = "/api/admin/organizations/org-a/crm";

    const preview = await app.request(`${base}/contacts/import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        csv: "name,email\nRoute Preview,route-preview@example.com",
      }),
    });
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      data: {
        preview: true,
        created: 1,
        updated: 0,
        skipped: 0,
        errors: 0,
        rows: [{ rowNumber: 1, status: "created" }],
      },
    });
    expect(await repository.listContacts("org-a")).toEqual([]);

    const missingKey = await app.request(`${base}/contacts/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        csv: "name,email\nRoute Commit,route-commit@example.com",
      }),
    });
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const committed = await app.request(`${base}/contacts/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "route-import-commit",
      },
      body: JSON.stringify({
        csv: "name,email\nRoute Commit,route-commit@example.com",
      }),
    });
    expect(committed.status).toBe(201);
    await expect(committed.json()).resolves.toMatchObject({
      data: {
        preview: false,
        created: 1,
        rows: [{ rowNumber: 1, status: "created" }],
      },
    });
  });

  it("returns participant merge collisions through route preview and commit", async () => {
    const repository = new InMemoryCrmRepository();
    let sequence = 0;
    const crm = new CrmService(
      { repository },
      {
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        generateId: (prefix) => `${prefix}-route-${++sequence}`,
      },
    );
    const survivor = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Route Survivor",
      email: "route-survivor@example.com",
    });
    const retired = await crm.createContact(actor, {
      organizationId: "org-a",
      displayName: "Route Retired",
      email: "route-retired@example.com",
    });
    await crm.addContactToEvent(actor, {
      organizationId: "org-a",
      contactId: survivor.id,
      participantId: "route-participant-one",
      eventId: "route-event",
      idempotencyKey: "route-link-one",
    });
    await crm.addContactToEvent(actor, {
      organizationId: "org-a",
      contactId: retired.id,
      participantId: "route-participant-two",
      eventId: "route-event",
      idempotencyKey: "route-link-two",
    });
    const app = crmRouteApp(crm);
    const mergePath = `/api/admin/organizations/org-a/crm/contacts/${survivor.id}/merge`;

    const preview = await app.request(`${mergePath}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ duplicateContactIds: [retired.id] }),
    });
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      data: {
        canCommit: false,
        participantConflicts: [
          {
            eventId: "route-event",
            participantIds: ["route-participant-one", "route-participant-two"],
          },
        ],
      },
    });

    const committed = await app.request(mergePath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "route-merge-collision",
      },
      body: JSON.stringify({ duplicateContactIds: [retired.id] }),
    });
    expect(committed.status).toBe(409);
    await expect(committed.json()).resolves.toMatchObject({
      error: {
        code: "CONFLICT",
        details: { participantConflicts: expect.any(Array) },
      },
    });
    expect(await repository.getContact("org-a", retired.id)).toMatchObject({
      status: "active",
    });
  });
});
