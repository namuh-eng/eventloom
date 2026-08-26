import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CrmWorkspaceView } from "./crm-workspace";
import { createCrmApi, settleCrmOutreachRecipients } from "./crm-workspace-api";
import {
  type CrmAnalytics,
  type CrmApi,
  type CrmContact,
  type CrmEvent,
  type CrmHistoryEntry,
  type CrmSegment,
  createCrmWorkspaceReadCoordinator,
  preferNewerCrmContact,
  refreshCrmAnalyticsAfterContactSave,
  refreshCrmDuplicatesAfterContactSave,
  refreshCrmEventMembershipAfterSave,
  refreshSelectedContactAfterCollectionReload,
} from "./crm-workspace-model";
import { isCurrentCrmOutreachRefresh } from "./crm-workspace-views";

type TestFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const importPreview = {
  id: "preview-import-1",
  organizationId: "org/one",
  created: 1,
  updated: 1,
  skipped: 1,
  errors: 1,
  contacts: [],
  mapping: [],
  rows: [
    {
      rowNumber: 1,
      identity: "ada@example.test",
      status: "created" as const,
      contactId: "contact-1",
      reason: null,
    },
    {
      rowNumber: 2,
      identity: "existing@example.test",
      status: "updated" as const,
      contactId: "contact-2",
      reason: null,
    },
    {
      rowNumber: 3,
      identity: "skip@example.test",
      status: "skipped" as const,
      contactId: null,
      reason: "No changes",
    },
    {
      rowNumber: 4,
      identity: null,
      status: "error" as const,
      contactId: null,
      reason: "Email is invalid",
    },
  ],
  idempotent: false,
  createdAt: "2026-08-09T10:00:00.000Z",
  planFingerprint: "plan-import-1",
  preview: true as const,
};
type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readHandlers() {
  return {
    setContacts: vi.fn(),
    setSegments: vi.fn(),
    setEvents: vi.fn(),
    setAnalytics: vi.fn(),
    setContactsLoading: vi.fn(),
    setSegmentsLoading: vi.fn(),
    setEventsLoading: vi.fn(),
    setAnalyticsLoading: vi.fn(),
    setError: vi.fn(),
  };
}

const contact: CrmContact = {
  id: "contact-1",
  organizationId: "org/one",
  firstName: "Ada",
  lastName: "Lovelace",
  displayName: "Ada Lovelace",
  email: "ada@example.test",
  phone: "+1 555 0100",
  company: "Analytical Engines",
  title: "Founder",
  website: "https://example.test",
  linkedinUrl: "https://linkedin.test/ada",
  notes: "Met at the summit.",
  tags: ["speaker", "west"],
  customFields: {
    region: "west",
    priority: "high",
    bio: "Mathematician and founder building analytical systems.",
    headshotUrl: "https://cdn.example.test/ada.jpg",
  },
  source: "speaker",
  status: "active",
  mergedIntoId: null,
  pipelineStage: "qualified",
  version: 3,
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-09T10:00:00.000Z",
};

const event: CrmEvent = {
  id: "event/one",
  organizationId: "org/one",
  name: "Eventloom Summit",
  slug: "eventloom-summit",
};

const analytics: CrmAnalytics = {
  organizationId: "org/one",
  totalContacts: 1,
  activeContacts: 1,
  contactsByPipelineStage: { qualified: 1 },
  contactsByEvent: [{ eventId: event.id, count: 1 }],
  contactsBySource: { speaker: 1 },
  outreach: { queued: 1, sent: 0, failed: 0 },
  generatedAt: "2026-08-09T10:00:00.000Z",
};

describe("organization CRM workspace", () => {
  it("settles outreach receipts in stable preview order without discarding failures", async () => {
    const recipients = [
      {
        contactId: "contact-1",
        email: "ada@example.test",
        displayName: "Ada Lovelace",
        subject: "Hello Ada",
        body: "Hi Ada",
        unknownTags: [],
        idempotencyKey: "outreach-ada",
      },
      {
        contactId: "contact-2",
        email: "grace@example.test",
        displayName: "Grace Hopper",
        subject: "Hello Grace",
        body: "Hi Grace",
        unknownTags: [],
        idempotencyKey: "outreach-grace",
      },
    ] as const;
    const settlements = await settleCrmOutreachRecipients(recipients, async (recipient) => {
      if (recipient.contactId === "contact-2") throw new Error("recipient queue failed");
      return {
        id: `queue-${recipient.idempotencyKey}`,
        contactId: recipient.contactId,
        recipientEmail: recipient.email,
        subject: recipient.subject,
        renderedBody: recipient.body,
        status: "queued" as const,
        queuedCount: 1,
        sentCount: 0,
        failedCount: 0,
        terminal: false,
        failureReason: null,
      };
    });

    expect(settlements.map((settlement) => settlement.recipient.idempotencyKey)).toEqual([
      "outreach-ada",
      "outreach-grace",
    ]);
    expect(settlements[0]).toMatchObject({
      status: "fulfilled",
      receipt: { id: "queue-outreach-ada", contactId: "contact-1" },
    });
    expect(settlements[1]).toMatchObject({
      status: "rejected",
      error: expect.objectContaining({ message: "recipient queue failed" }),
    });
  });

  it("fences stale outreach refreshes by busy lease and selection generation", () => {
    expect(isCurrentCrmOutreachRefresh(2, 2, 4, 4)).toBe(true);
    expect(isCurrentCrmOutreachRefresh(2, 3, 4, 4)).toBe(false);
    expect(isCurrentCrmOutreachRefresh(2, 2, 4, 5)).toBe(false);
  });
  it("renders directory, detail, segments, pipeline, outreach, and analytics controls", () => {
    const onMerge = vi.fn(async () => undefined);
    const markup = renderToStaticMarkup(
      createElement(CrmWorkspaceView, {
        organizationId: "org/one",
        contacts: [contact],
        selectedContact: contact,
        selectedContactId: contact.id,
        initialImportOpen: true,
        initialImportCsv: "Name,Email,Topics\nAda Lovelace,ada@example.test,computing",
        selectedContactIds: [contact.id],
        segments: [
          {
            id: "segment-1",
            organizationId: "org/one",
            name: "Qualified speakers",
            description: null,
            rules: [{ field: "pipelineStage", operator: "eq", value: "qualified" }],
            createdBy: "organizer-1",
            version: 1,
            createdAt: contact.createdAt,
            updatedAt: contact.updatedAt,
          },
        ],
        events: [event],
        history: [
          {
            id: "history-1",
            organizationId: "org/one",
            contactId: contact.id,
            kind: "event",
            eventId: event.id,
            sessionId: null,
            title: "Added to event",
            detail: "Prospect",
            occurredAt: contact.updatedAt,
            metadata: {},
          },
        ],
        pipelineHistory: [],
        notes: [],
        duplicates: {
          contactId: contact.id,
          matches: [
            {
              contact: {
                ...contact,
                id: "contact-2",
                email: "ada.duplicate@example.test",
                version: 1,
              },
              score: 0.95,
              matchedFields: ["displayName", "company"],
            },
          ],
        },
        analytics,
        importResult: {
          id: "import-1",
          organizationId: "org/one",
          created: 1,
          updated: 0,
          skipped: 1,
          errors: 0,
          contacts: [contact],
          idempotent: false,
          createdAt: contact.updatedAt,
          planFingerprint: "plan-import-1",
          preview: false,
          mapping: [
            { sourceColumn: "Name", targetField: "displayName", custom: false },
            { sourceColumn: "Email", targetField: "email", custom: false },
            { sourceColumn: "Topics", targetField: "custom.Topics", custom: true },
          ],
          rows: [
            {
              rowNumber: 1,
              identity: "ada@example.test",
              status: "created",
              contactId: contact.id,
              reason: null,
            },
            {
              rowNumber: 2,
              identity: null,
              status: "skipped",
              contactId: null,
              reason: "Email is required as the canonical import identity.",
            },
          ],
        },
        importPreviewResult: importPreview,
        importPreviewSource: "Name,Email,Topics\nAda Lovelace,ada@example.test,computing",
        mergePreview: {
          organizationId: "org/one",
          survivorId: contact.id,
          retiredIds: ["contact-2"],
          rewired: {
            participantContactLinks: 2,
            notes: 1,
            segments: 1,
            pipelineHistory: 3,
          },
          participantConflicts: [],
          auditId: "audit-crm-1",
          planFingerprint: "plan-merge-1",
          survivor: contact,
          tombstones: [{ ...contact, id: "contact-2" }],
          primary: contact,
          merged: [{ ...contact, id: "contact-2" }],
          preview: true,
          canCommit: true,
        },
        mergePreviewPlanKey: JSON.stringify({
          duplicateContactIds: ["contact-2"],
          fieldWinners: {
            email: contact.id,
            phone: contact.id,
            name: contact.id,
            company: contact.id,
            title: contact.id,
            bio: contact.id,
            headshot: contact.id,
          },
          customFieldWinners: {},
        }),
        outreachPreview: {
          subject: "Hello {{first_name}}",
          body: "Hi {{first_name}}",
          count: 1,
          recipients: [
            {
              contactId: contact.id,
              email: "ada@example.test",
              displayName: "Ada Lovelace",
              subject: "Hello Ada",
              body: "Hi Ada",
              unknownTags: [],
              idempotencyKey: "outreach-preview-1",
            },
          ],
        },
        outreachRecipients: [contact],
        onSelectionChange: vi.fn(),
        onFindDuplicates: vi.fn(),
        onMerge,
        onMovePipeline: vi.fn(),
        onEnrollPipeline: vi.fn(async () => undefined),
        onSavePipeline: vi.fn(async () => undefined),
        onAddNote: vi.fn(async () => undefined),
        onAddToEvent: vi.fn(async () => undefined),
        lastAddedEventId: event.id,
        lastEventResult: {
          idempotent: false,
          outcome: "created",
          projection: {
            id: "event-contact-1",
            eventId: event.id,
            contactId: contact.id,
            role: "prospect",
          },
        },
        onPreviewOutreach: vi.fn(async () => undefined),
        onSendOutreach: vi.fn(async () => undefined),
        outreachResults: [
          {
            id: "send-1",
            contactId: contact.id,
            recipientEmail: "ada@example.test",
            subject: "Hello Ada",
            renderedBody: "Hi Ada",
            status: "sent",
            queuedCount: 0,
            sentCount: 1,
            failedCount: 0,
            terminal: true,
            failureReason: null,
          },
          {
            id: "outreach-failed-outreach-grace",
            contactId: "contact-2",
            recipientEmail: "grace@example.test",
            subject: "Hello Grace",
            renderedBody: "Hi Grace",
            status: "failed",
            queuedCount: 0,
            sentCount: 0,
            failedCount: 1,
            terminal: true,
            failureReason: "Recipient queue failed.",
          },
        ],
        onCreateSegment: vi.fn(async () => undefined),
        onSelectSegment: vi.fn(),
      }),
    );

    expect(markup).toContain("Organization CRM");
    expect(markup).toContain("Search contacts");
    expect(markup).toContain("CSV file");
    expect(markup).toContain("Hide import");
    expect(markup).toContain("Detected CSV column mapping");
    expect(markup).toContain("custom.Topics (custom field)");
    expect(markup).toContain("Import result");
    expect(markup).toContain("1 created");
    expect(markup).toContain("1 skipped");
    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain("Select Ada Lovelace");
    expect(markup).toContain("Custom fields");
    expect(markup).toContain("Communicate with selected");
    expect(markup).toContain("Find possible duplicates");
    expect(markup).toContain("+ Enroll contact");
    expect(markup).toContain("Open pipeline card detail for Ada Lovelace");
    expect(markup).toContain("Review selected merge");
    expect(markup).not.toContain("Merge selected into this contact");
    expect(onMerge).not.toHaveBeenCalled();
    expect(markup).toContain("Select records to compare");
    expect(markup).toContain("Pipeline history");
    expect(markup).toContain("Profile");
    expect(markup).toContain("Add to event");
    expect(markup).toContain("Mathematician and founder");
    expect(markup).toContain("Notes and cross-event history");
    expect(markup).toContain("{{first_name}}");
    expect(markup).toContain("Hello Ada");
    expect(markup).toContain("Outreach queue result");
    expect(markup).toContain("1 sent");
    expect(markup).toContain("1 failed");
    expect(markup).toContain("Recipient queue failed.");
    expect(markup.indexOf("ada@example.test")).toBeLessThan(markup.indexOf("grace@example.test"));
    expect(markup.indexOf("queue send-1")).toBeLessThan(
      markup.indexOf("queue outreach-failed-outreach-grace"),
    );
    expect(markup).not.toContain("Send Now");
    expect(markup).toContain("Queue outreach for delivery");
    expect(markup).toContain("Recipient safeguards");
    expect(markup).toContain("Preview confirms merge fields, not consent.");
    expect(markup).toContain("provider suppression");
    expect(markup).toContain("selected for queueing");
    expect(markup).toContain("Qualified speakers");
    expect(markup).toContain("Pipeline board");
    expect(markup).toContain("CRM analytics");
    expect(markup).toContain("View contacts");
    expect(markup).toContain("Open event workspace");
    expect(markup).toContain("Canonical relationship created");
    expect(markup).toContain('href="/admin/organizations/org%2Fone/events/event%2Fone"');
    expect(markup).not.toContain("eventloom-summit");
  });
  it("replaces stale directory controls with an accessible loading state", () => {
    const markup = renderToStaticMarkup(
      createElement(CrmWorkspaceView, {
        organizationId: "org/one",
        contacts: [contact],
        segments: [],
        events: [],
        history: [],
        pipelineHistory: [],
        notes: [],
        duplicates: null,
        analytics: null,
        loading: true,
      }),
    );

    expect(markup).toContain("Updating the contact directory for the current filters…");
    expect(markup).toContain('aria-label="Loading contact directory"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Loading organization CRM data"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain('aria-label="Select Ada Lovelace"');
    expect(markup).not.toContain("Organization CRM contact directory");
    expect(markup).not.toContain("1 contact shown");
  });

  it("exposes direct outreach, duplicate review, and analytics drill-down targets", () => {
    const markup = renderToStaticMarkup(
      createElement(CrmWorkspaceView, {
        organizationId: "org/one",
        contacts: [contact],
        selectedContact: contact,
        selectedContactId: contact.id,
        segments: [],
        events: [event],
        history: [],
        pipelineHistory: [],
        notes: [],
        duplicates: {
          contactId: contact.id,
          matches: [
            {
              contact: {
                ...contact,
                id: "contact-2",
                email: "ada.duplicate@example.test",
                version: 1,
              },
              score: 0.95,
              matchedFields: ["displayName", "company"],
            },
          ],
        },
        analytics,
      }),
    );

    expect(markup).toContain("Open outreach composer");
    expect(markup).toContain('aria-controls="crm-outreach-composer"');
    expect(markup).toMatch(/<section id="crm-outreach-composer"/u);
    expect(markup).toContain("Review possible duplicates");
    expect(markup).toContain('aria-controls="crm-duplicate-review"');
    expect(markup).toContain('id="crm-duplicate-review"');
    expect(markup).toContain('aria-labelledby="crm-duplicate-review-title"');
    expect(markup).toMatch(/<section id="crm-duplicate-review"/u);
    expect(markup).toContain("Contact snapshot");
    expect(markup).toContain('href="#crm-analytics"');
    expect(markup).toContain('id="crm-analytics"');
    expect(markup).toMatch(/<section id="crm-analytics"/u);
    expect(markup.indexOf("Contact snapshot")).toBeLessThan(markup.indexOf("Contact directory"));
    expect(markup).toContain("View contacts");
  });

  it("shows every recipient preview and blocks unknown outreach merge tags", () => {
    const markup = renderToStaticMarkup(
      createElement(CrmWorkspaceView, {
        organizationId: "org/one",
        contacts: [contact],
        selectedContact: contact,
        segments: [],
        events: [],
        history: [],
        pipelineHistory: [],
        notes: [],
        duplicates: null,
        analytics: null,
        outreachPreview: {
          subject: "Hello {{unknownTag}}",
          body: "Body",
          count: 1,
          recipients: [
            {
              contactId: contact.id,
              email: contact.email ?? "",
              displayName: contact.displayName,
              subject: "Hello {{unknownTag}}",
              body: "Body",
              unknownTags: ["unknownTag"],
              idempotencyKey: "outreach-preview-invalid",
            },
          ],
        },
        onSendOutreach: async () => undefined,
      }),
    );

    expect(markup).toContain("Queueing is blocked");
    expect(markup).toContain("Unknown merge tags: unknownTag");
  });

  it("renders one timeline item per saved note while retaining note audit records", () => {
    const note = {
      id: "note-1",
      organizationId: contact.organizationId,
      contactId: contact.id,
      body: "Follow up once",
      authorId: "owner-1",
      createdAt: contact.updatedAt,
    };
    const markup = renderToStaticMarkup(
      createElement(CrmWorkspaceView, {
        organizationId: contact.organizationId,
        contacts: [contact],
        selectedContact: contact,
        segments: [],
        events: [],
        history: [
          {
            id: "history-note-1",
            organizationId: contact.organizationId,
            contactId: contact.id,
            kind: "note",
            eventId: null,
            sessionId: null,
            title: "Note added",
            detail: note.body,
            occurredAt: note.createdAt,
            metadata: { noteId: note.id },
          },
        ],
        pipelineHistory: [],
        notes: [note],
        duplicates: null,
        analytics: null,
      }),
    );

    expect(markup.match(/Follow up once/gu)?.length).toBe(1);
  });
  it("renders human-readable pipeline transition history", () => {
    const markup = renderToStaticMarkup(
      createElement(CrmWorkspaceView, {
        organizationId: contact.organizationId,
        contacts: [contact],
        selectedContact: contact,
        segments: [],
        events: [],
        history: [],
        pipelineHistory: [
          {
            id: "pipeline-history-1",
            organizationId: contact.organizationId,
            contactId: contact.id,
            fromStage: "contacted",
            toStage: "qualified",
            note: "Invite to the infrastructure track.",
            actorId: "owner-1",
            actorName: "Owner Ada",
            createdAt: contact.updatedAt,
          },
        ],
        notes: [],
        duplicates: null,
        analytics: null,
      }),
    );

    expect(markup).toContain("Owner Ada");
    expect(markup).toContain("Previous stage: contacted");
    expect(markup).toContain("New stage: qualified");
    expect(markup).toContain("Note: Invite to the infrastructure track.");
  });
  it("renders non-empty personalized outreach previews for display-name-only contacts", () => {
    const displayNameOnlyContacts = [
      {
        ...contact,
        id: "contact-dana",
        firstName: null,
        lastName: null,
        displayName: "Dana Okafor",
        email: "dana@example.test",
      },
      {
        ...contact,
        id: "contact-marcus",
        firstName: null,
        lastName: null,
        displayName: "Marcus Chen",
        email: "marcus@example.test",
      },
      {
        ...contact,
        id: "contact-explicit",
        displayName: "Display Person",
        firstName: "Explicit",
        lastName: "Names",
        email: "explicit@example.test",
      },
    ] as const;
    const markup = renderToStaticMarkup(
      createElement(CrmWorkspaceView, {
        organizationId: "org/one",
        contacts: displayNameOnlyContacts,
        selectedContact: displayNameOnlyContacts[0],
        selectedContactId: displayNameOnlyContacts[0].id,
        segments: [],
        events: [],
        history: [],
        pipelineHistory: [],
        notes: [],
        duplicates: null,
        analytics: null,
        outreachPreview: {
          subject: "Invitation from {{first_name}}",
          body: "Hi {{first_name}}",
          count: displayNameOnlyContacts.length,
          recipients: [
            {
              contactId: "contact-dana",
              email: "dana@example.test",
              displayName: "Dana Okafor",
              subject: "Invitation from Dana",
              body: "Hi Dana",
              unknownTags: [],
              idempotencyKey: "outreach-preview-dana",
            },
            {
              contactId: "contact-marcus",
              email: "marcus@example.test",
              displayName: "Marcus Chen",
              subject: "Invitation from Marcus",
              body: "Hi Marcus",
              unknownTags: [],
              idempotencyKey: "outreach-preview-marcus",
            },
            {
              contactId: "contact-explicit",
              email: "explicit@example.test",
              displayName: "Display Person",
              subject: "Invitation from Explicit",
              body: "Hi Explicit",
              unknownTags: [],
              idempotencyKey: "outreach-preview-explicit",
            },
          ],
        },
        onSendOutreach: async () => undefined,
      }),
    );

    expect(markup).toContain("Invitation from Dana");
    expect(markup).toContain("Hi Dana");
    expect(markup).toContain("Invitation from Marcus");
    expect(markup).toContain("Hi Marcus");
    expect(markup).toContain("Invitation from Explicit");
    expect(markup).toContain("Hi Explicit");
  });
  it("seeds saved segments from active directory filters and exposes selected-contact context", () => {
    const markup = renderToStaticMarkup(
      createElement(CrmWorkspaceView, {
        organizationId: "org/one",
        contacts: [contact],
        segments: [],
        events: [event],
        history: [],
        pipelineHistory: [],
        notes: [],
        duplicates: null,
        analytics: null,
        companyFilter: "Analytical Engines",
        tagsFilter: "speaker,west",
        selectedContactIds: [contact.id],
        initialImportOpen: true,
      }),
    );

    expect(markup).toContain("Save current directory filters");
    expect(markup).toContain("company contains Analytical Engines");
    expect(markup).toContain("tags contains speaker");
    expect(markup).toContain("Selected directory contacts (1)");
    expect(markup).toContain("Segment context (optional)");
    expect(markup).toContain("CSV file");
  });
  it("routes server-authoritative CSV and merge previews with exact request bodies", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn<TestFetcher>(async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return response(
        calls.length === 1
          ? importPreview
          : {
              organizationId: "org/one",
              survivorId: contact.id,
              retiredIds: ["contact-2"],
              rewired: {
                participantContactLinks: 1,
                notes: 2,
                segments: 3,
                pipelineHistory: 4,
              },
              participantConflicts: [],
              auditId: "audit-merge",
              planFingerprint: "plan-merge",
              survivor: contact,
              tombstones: [],
              primary: contact,
              merged: [],
              preview: true,
              canCommit: true,
            },
      );
    });
    const api = createCrmApi("https://api.example.test/", "org/one", fetcher);
    await api.previewImport("Name,Email\nAda,ada@example.test");
    await api.previewMerge(contact.id, ["contact-2"], {
      fieldWinners: {
        email: contact.id,
        phone: contact.id,
        name: contact.id,
        company: contact.id,
        title: contact.id,
        bio: contact.id,
        headshot: contact.id,
      },
      customFieldWinners: { region: contact.id },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.test/api/admin/organizations/org%2Fone/crm/contacts/import/preview",
      "https://api.example.test/api/admin/organizations/org%2Fone/crm/contacts/contact-1/merge/preview",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      csv: "Name,Email\nAda,ada@example.test",
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      duplicateContactIds: ["contact-2"],
      fieldWinners: {
        email: contact.id,
        phone: contact.id,
        name: contact.id,
        company: contact.id,
        title: contact.id,
        bio: contact.id,
        headshot: contact.id,
      },
      customFieldWinners: { region: contact.id },
    });
  });
  it("renders durable 202 outreach receipts without polling", async () => {
    const receipt = {
      id: "outreach-202",
      contactId: contact.id,
      recipientEmail: contact.email,
      subject: "Hello Ada",
      renderedBody: "Hi Ada",
      status: "queued" as const,
      queuedCount: 1,
      sentCount: 0,
      failedCount: 0,
      terminal: false,
      failureReason: null,
    };
    const fetcher = vi.fn<TestFetcher>(async () => response(receipt, 202));
    const api = createCrmApi("https://api.example.test", "org/one", fetcher);

    await expect(
      api.sendOutreach(
        { contactId: contact.id, subject: "Hello Ada", body: "Hi Ada" },
        "outreach-202-key",
      ),
    ).resolves.toEqual(receipt);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses authoritative organization CRM and event envelopes with credentials and no-store", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn<TestFetcher>(async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return response(
        calls.length === 2
          ? contact
          : calls.length === 14
            ? event
            : calls.length === 15
              ? analytics
              : [],
      );
    });
    const api = createCrmApi("https://api.example.test/", "org/one", fetcher);

    await api.listContacts({
      query: "Ada",
      company: "Analytical Engines",
      pipelineStage: "qualified",
      status: "active",
      eventId: event.id,
    });
    await api.getContact(contact.id);
    await api.createContact({ displayName: "Grace Hopper" });
    await api.updateContact(contact.id, { company: "Navy", expectedVersion: 3 });
    await api.importContacts("firstName,lastName\nGrace,Hopper", "import-key");
    await api.listSegments();
    await api.createSegment({
      name: "Qualified",
      rules: [{ field: "pipelineStage", operator: "eq", value: "qualified" }],
    });
    await api.listSegmentContacts("segment/1");
    await api.findDuplicates(contact.id);
    await api.mergeContacts(contact.id, ["contact/2"], "merge-key");
    await api.getContactHistory(contact.id);
    await api.getPipelineHistory(contact.id);
    await api.updatePipeline(contact.id, {
      stage: "invited",
      expectedVersion: contact.version,
      score: 85,
      rationale: "Strong platform-engineering track record.",
      note: "Invite sent",
    });
    await api.listNotes(contact.id);
    await api.addNote(contact.id, "Follow up next week");
    await api.addContactToEvent(contact.id, { eventId: event.id, role: "prospect" }, "event-key");
    await api.sendOutreach(
      {
        contactId: contact.id,
        subject: "Hello",
        body: "Hi {{first_name}}",
        variables: { first_name: "Ada" },
      },
      "outreach-key",
    );
    await api.analytics();
    await api.listEvents();

    expect(calls[0]?.url).toBe(
      "https://api.example.test/api/admin/organizations/org%2Fone/crm/contacts?query=Ada&company=Analytical+Engines&pipelineStage=qualified&status=active&eventId=event%2Fone",
    );
    expect(JSON.parse(String(calls[12]?.init.body))).toEqual({
      stage: "invited",
      expectedVersion: contact.version,
      score: 85,
      rationale: "Strong platform-engineering track record.",
      note: "Invite sent",
    });
  });

  it("preserves explicit null pipeline score and rationale clearing", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn<TestFetcher>(async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return response(contact);
    });
    const api = createCrmApi("https://api.example.test", "org/one", fetcher);

    await api.updatePipeline(contact.id, {
      stage: "qualified",
      expectedVersion: contact.version,
      score: null,
      rationale: null,
    });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      stage: "qualified",
      expectedVersion: contact.version,
      score: null,
      rationale: null,
    });
  });

  it("makes an empty directory action-first and hides data-dependent controls", () => {
    const markup = renderToStaticMarkup(
      createElement(CrmWorkspaceView, {
        organizationId: "org-1",
        contacts: [],
        segments: [],
        events: [],
        history: [],
        pipelineHistory: [],
        notes: [],
        duplicates: null,
        analytics: null,
      }),
    );

    expect(markup).toContain("Your directory is empty");
    expect(markup).toContain("Add contact");
    expect(markup).toContain("Import CSV");
    expect(markup).not.toContain("Search contacts");
    expect(markup).not.toContain("Saved dynamic segments");
    expect(markup).not.toContain("Pipeline board");
    expect(markup).not.toContain("CRM analytics");
  });

  it("keeps one human error summary and puts technical details behind disclosure", () => {
    const markup = renderToStaticMarkup(
      createElement(CrmWorkspaceView, {
        organizationId: "org-1",
        contacts: [],
        segments: [],
        events: [],
        history: [],
        pipelineHistory: [],
        notes: [],
        duplicates: null,
        analytics: null,
        error: "Contacts unavailable\nSegments unavailable\nTechnical reference: trace abc-123",
      }),
    );

    expect(markup).toContain("Contacts unavailable");
    expect(markup).toContain("Show technical details");
    expect(markup.indexOf("Contacts unavailable")).toBeLessThan(
      markup.indexOf("Show technical details"),
    );
    expect(markup).not.toContain("Segments unavailable</p>");
  });
});
describe("CRM workspace read coordination", () => {
  it("starts all independent initial reads before any deferred response settles", async () => {
    const starts: string[] = [];
    const contactsRead = deferred<readonly CrmContact[]>();
    const segmentsRead = deferred<readonly CrmSegment[]>();
    const eventsRead = deferred<readonly CrmEvent[]>();
    const analyticsRead = deferred<CrmAnalytics>();
    const api = {
      listContacts: vi.fn(() => {
        starts.push("contacts");
        return contactsRead.promise;
      }),
      listSegments: vi.fn(() => {
        starts.push("segments");
        return segmentsRead.promise;
      }),
      listEvents: vi.fn(() => {
        starts.push("events");
        return eventsRead.promise;
      }),
      analytics: vi.fn(() => {
        starts.push("analytics");
        return analyticsRead.promise;
      }),
    } as unknown as CrmApi;
    const handlers = readHandlers();
    const coordinator = createCrmWorkspaceReadCoordinator(api, handlers);

    const refresh = coordinator.refresh({ query: "Ada", status: "active" });

    expect(starts).toEqual(["contacts", "segments", "events", "analytics"]);
    expect(api.listContacts).toHaveBeenCalledTimes(1);
    expect(api.listSegments).toHaveBeenCalledTimes(1);
    expect(api.listEvents).toHaveBeenCalledTimes(1);
    expect(api.analytics).toHaveBeenCalledTimes(1);

    contactsRead.resolve([contact]);
    segmentsRead.resolve([]);
    eventsRead.resolve([event]);
    analyticsRead.resolve(analytics);
    await refresh;
    coordinator.dispose();
  });
  it("reactivates after an effect cleanup replay", async () => {
    const api = {
      listSegments: vi.fn(async () => []),
    } as unknown as CrmApi;
    const handlers = readHandlers();
    const coordinator = createCrmWorkspaceReadCoordinator(api, handlers);

    coordinator.dispose();
    coordinator.activate();
    await coordinator.loadSegments();

    expect(api.listSegments).toHaveBeenCalledTimes(1);
    expect(handlers.setSegments).toHaveBeenCalledWith([]);
    expect(handlers.setSegmentsLoading).toHaveBeenLastCalledWith(false);
    coordinator.dispose();
  });

  it("reloads only contacts for a filter change and ignores stale contact responses", async () => {
    const firstContactsRead = deferred<readonly CrmContact[]>();
    const secondContactsRead = deferred<readonly CrmContact[]>();
    const newerContact = { ...contact, id: "contact-2", email: "newer@example.test" };
    const api = {
      listContacts: vi
        .fn()
        .mockImplementationOnce(() => firstContactsRead.promise)
        .mockImplementationOnce(() => secondContactsRead.promise),
      listSegments: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
      analytics: vi.fn(async () => analytics),
    } as unknown as CrmApi;
    const handlers = readHandlers();
    const coordinator = createCrmWorkspaceReadCoordinator(api, handlers);

    const firstLoad = coordinator.loadContacts({ query: "Ada", status: "active" });
    const secondLoad = coordinator.loadContacts({ query: "Grace", status: "active" });

    expect(api.listContacts).toHaveBeenCalledTimes(2);
    expect(api.listSegments).not.toHaveBeenCalled();
    expect(api.listEvents).not.toHaveBeenCalled();
    expect(api.analytics).not.toHaveBeenCalled();

    secondContactsRead.resolve([newerContact]);
    await secondLoad;
    firstContactsRead.resolve([contact]);
    await firstLoad;

    const contactUpdate = handlers.setContacts.mock.lastCall?.[0] as
      | readonly CrmContact[]
      | ((current: readonly CrmContact[]) => readonly CrmContact[]);
    expect(typeof contactUpdate).toBe("function");
    expect(typeof contactUpdate === "function" ? contactUpdate([contact]) : contactUpdate).toEqual([
      newerContact,
    ]);
    coordinator.dispose();
  });

  it("does not let a delayed collection response overwrite a newer saved contact", async () => {
    const contactsRead = deferred<readonly CrmContact[]>();
    const api = {
      listContacts: vi.fn(() => contactsRead.promise),
    } as unknown as CrmApi;
    let currentContacts: readonly CrmContact[] = [contact];
    const handlers = {
      ...readHandlers(),
      setContacts: vi.fn(
        (
          update:
            | readonly CrmContact[]
            | ((current: readonly CrmContact[]) => readonly CrmContact[]),
        ) => {
          currentContacts = typeof update === "function" ? update(currentContacts) : update;
        },
      ),
    };
    const coordinator = createCrmWorkspaceReadCoordinator(api, handlers);
    const load = coordinator.loadContacts({ status: "active" });
    const savedContact = {
      ...contact,
      company: "Newer saved company",
      version: contact.version + 1,
    };

    currentContacts = [savedContact];
    contactsRead.resolve([contact]);
    await load;

    expect(currentContacts).toEqual([savedContact]);
    coordinator.dispose();
  });

  it("does not let a delayed collection response drop a contact created after the read began", async () => {
    const contactsRead = deferred<readonly CrmContact[]>();
    const createdContact = {
      ...contact,
      id: "contact-2",
      displayName: "Grace Hopper",
      email: "grace@example.test",
      version: 1,
    };
    const api = {
      listContacts: vi
        .fn()
        .mockImplementationOnce(() => contactsRead.promise)
        .mockResolvedValue([contact, createdContact]),
    } as unknown as CrmApi;
    let currentContacts: readonly CrmContact[] = [contact];
    const handlers = {
      ...readHandlers(),
      setContacts: vi.fn(
        (
          update:
            | readonly CrmContact[]
            | ((current: readonly CrmContact[]) => readonly CrmContact[]),
        ) => {
          currentContacts = typeof update === "function" ? update(currentContacts) : update;
        },
      ),
    };
    const coordinator = createCrmWorkspaceReadCoordinator(api, handlers);
    const load = coordinator.loadContacts({ status: "active" });

    currentContacts = [contact, createdContact];
    coordinator.markContactMutation();
    contactsRead.resolve([contact]);
    await load;

    expect(currentContacts).toEqual([contact, createdContact]);
    expect(api.listContacts).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("refreshes each intended resource exactly once", async () => {
    const api = {
      listContacts: vi.fn(async () => [contact]),
      listSegments: vi.fn(async () => []),
      listEvents: vi.fn(async () => [event]),
      analytics: vi.fn(async () => analytics),
    } as unknown as CrmApi;
    const handlers = readHandlers();
    const coordinator = createCrmWorkspaceReadCoordinator(api, handlers);

    await coordinator.refresh({ status: "active" });

    expect(api.listContacts).toHaveBeenCalledTimes(1);
    expect(api.listSegments).toHaveBeenCalledTimes(1);
    expect(api.listEvents).toHaveBeenCalledTimes(1);
    expect(api.analytics).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });
  it("keeps resource failures visible until that same resource succeeds", async () => {
    const contactsRead = deferred<readonly CrmContact[]>();
    const api = {
      listContacts: vi
        .fn()
        .mockImplementationOnce(() => contactsRead.promise)
        .mockResolvedValue([contact]),
      listSegments: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
      analytics: vi.fn(async () => analytics),
    } as unknown as CrmApi;
    const handlers = readHandlers();
    const coordinator = createCrmWorkspaceReadCoordinator(api, handlers);

    const contactsLoad = coordinator.loadContacts({ status: "active" });
    contactsRead.reject(new Error("Contacts unavailable"));
    await contactsLoad;

    expect(handlers.setError).toHaveBeenLastCalledWith("Contacts unavailable");

    await coordinator.loadSegments();
    expect(handlers.setError).toHaveBeenLastCalledWith("Contacts unavailable");

    await coordinator.loadContacts({ status: "active" });
    expect(handlers.setError).toHaveBeenLastCalledWith(null);
    coordinator.dispose();
  });

  it("aggregates concurrent resource failures in stable read-kind order", async () => {
    const api = {
      listContacts: vi.fn(async () => {
        throw new Error("Contacts unavailable");
      }),
      listSegments: vi.fn(async () => {
        throw new Error("Segments unavailable");
      }),
      listEvents: vi.fn(async () => []),
      analytics: vi.fn(async () => analytics),
    } as unknown as CrmApi;
    const handlers = readHandlers();
    const coordinator = createCrmWorkspaceReadCoordinator(api, handlers);

    await Promise.all([coordinator.loadSegments(), coordinator.loadContacts({ status: "active" })]);

    expect(handlers.setError).toHaveBeenLastCalledWith(
      "Contacts unavailable\nSegments unavailable",
    );
    coordinator.dispose();
  });
});

describe("CRM contact analytics refresh", () => {
  it("skips analytics for profile-only edits and refreshes after creates", async () => {
    const loadAnalytics = vi.fn(async () => undefined);

    await refreshCrmAnalyticsAfterContactSave(contact, loadAnalytics);
    expect(loadAnalytics).not.toHaveBeenCalled();

    await refreshCrmAnalyticsAfterContactSave(undefined, loadAnalytics);
    expect(loadAnalytics).toHaveBeenCalledTimes(1);
  });
  it("refreshes authoritative duplicates after create and identity edits", async () => {
    const findDuplicates = vi.fn(async (contactId: string) => ({ contactId, matches: [] }));

    await expect(
      refreshCrmDuplicatesAfterContactSave(undefined, contact, findDuplicates),
    ).resolves.toEqual({ contactId: contact.id, matches: [] });
    expect(findDuplicates).toHaveBeenCalledWith(contact.id);

    findDuplicates.mockClear();
    await expect(
      refreshCrmDuplicatesAfterContactSave(
        contact,
        { ...contact, title: "New Title" },
        findDuplicates,
      ),
    ).resolves.toBeNull();
    expect(findDuplicates).not.toHaveBeenCalled();

    await expect(
      refreshCrmDuplicatesAfterContactSave(
        contact,
        { ...contact, email: "new@example.test" },
        findDuplicates,
      ),
    ).resolves.toEqual({ contactId: contact.id, matches: [] });
    expect(findDuplicates).toHaveBeenCalledWith(contact.id);
  });
  it("reloads filtered contacts after event membership changes", async () => {
    const history: readonly CrmHistoryEntry[] = [
      {
        id: "history-1",
        organizationId: contact.organizationId,
        contactId: contact.id,
        kind: "event",
        eventId: "event-1",
        sessionId: null,
        title: "Added to event",
        detail: "Speaker",
        occurredAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      },
    ];
    const loadHistory = vi.fn(async () => history);
    const loadAnalytics = vi.fn(async () => undefined);
    const loadContacts = vi.fn(async () => undefined);
    const markContactMutation = vi.fn();

    await expect(
      refreshCrmEventMembershipAfterSave(
        loadHistory,
        loadAnalytics,
        loadContacts,
        markContactMutation,
      ),
    ).resolves.toBe(history);
    expect(loadHistory).toHaveBeenCalledOnce();
    expect(loadAnalytics).toHaveBeenCalledOnce();
    expect(loadContacts).toHaveBeenCalledOnce();
    expect(markContactMutation).toHaveBeenCalledOnce();
  });
});

describe("CRM selected contact refresh", () => {
  it("applies the authoritative selected contact after a collection reload", async () => {
    const authoritativeContact = { ...contact, version: contact.version + 1 };
    const applyContact = vi.fn();

    await refreshSelectedContactAfterCollectionReload({
      contactId: contact.id,
      expectedSelectionGeneration: 4,
      currentSelectionGeneration: () => 4,
      getContact: vi.fn(async () => authoritativeContact),
      applyContact,
    });

    expect(applyContact).toHaveBeenCalledWith(authoritativeContact);
  });

  it("does not replace a newer user selection with a stale refresh response", async () => {
    const contactRead = deferred<CrmContact>();
    let selectionGeneration = 4;
    const applyContact = vi.fn();
    const refresh = refreshSelectedContactAfterCollectionReload({
      contactId: contact.id,
      expectedSelectionGeneration: selectionGeneration,
      currentSelectionGeneration: () => selectionGeneration,
      getContact: vi.fn(() => contactRead.promise),
      applyContact,
    });

    selectionGeneration += 1;
    contactRead.resolve({ ...contact, version: contact.version + 1 });
    await refresh;

    expect(applyContact).not.toHaveBeenCalled();
  });

  it("does not replace a newer saved selected contact with a delayed lower version", async () => {
    const contactRead = deferred<CrmContact>();
    let selectedContact = contact;
    const refresh = refreshSelectedContactAfterCollectionReload({
      contactId: contact.id,
      expectedSelectionGeneration: 4,
      currentSelectionGeneration: () => 4,
      getContact: vi.fn(() => contactRead.promise),
      applyContact: (candidate) => {
        selectedContact = preferNewerCrmContact(selectedContact, candidate);
      },
    });
    const savedContact = {
      ...contact,
      displayName: "Newer Saved Contact",
      version: contact.version + 1,
    };

    selectedContact = savedContact;
    contactRead.resolve(contact);
    await refresh;

    expect(selectedContact).toEqual(savedContact);
  });
});
