import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CfpApi, CfpFormConfiguration } from "../cfp/api";
import { CfpEditor, CfpEventIdentityFields, CfpPastCloseConfirmation } from "./cfp-editor";
import { createTestCfpConfiguration } from "./cfp-editor.test-fixtures";
import {
  cfpActiveSectionThreshold,
  cfpContainerScrollTop,
  cfpMinimumDate,
  cfpSectionScrollOffset,
  closeCfpNowConfiguration,
  closeCfpNowInstant,
  cfpRuleFields,
  configurationFromServer,
  createEmptyCfpConfiguration,
  fieldOptionValues,
  isCfpCloseDatePast,
  loadCfpEditorConfiguration,
  persistCfpConfiguration,
  removeCfpEditorField,
  resolveCfpEditorStepIndex,
  selectEditorForm,
  summarizeRule,
  toFormConfiguration,
  updateCfpEditorField,
  updateCfpShowWhenCondition,
  validateCfpDateRange,
  withCoreProposalFields,
} from "./cfp-editor-model";

describe("CFP editor", () => {
  it("defaults new CFPs to twenty proposals per account", () => {
    expect(createEmptyCfpConfiguration("summit-2026").proposalLimit).toBe(20);
  });
  it("represents a new conditional rule as fully blank", () => {
    const configuration = createEmptyCfpConfiguration("summit-2026");

    expect(configuration.rule).toEqual({
      type: "condition",
      field: "",
      operator: "is",
      value: "",
    });
    expect(configuration.ruleTargetField).toBeUndefined();
    expect(toFormConfiguration(configuration, "organization-1", "summit-2026").rules).toEqual([]);
  });
  it("uses the event name when optional CFP welcome copy is blank", () => {
    const configuration = createEmptyCfpConfiguration("summit-2026");
    configuration.eventName = "Eventloom Summit 2026";

    expect(toFormConfiguration(configuration, "organization-1", "summit-2026").name).toBe(
      "Eventloom Summit 2026",
    );
  });

  it("resolves all taxonomy rule fields with authoritative options", () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    configuration.formats = ["Workshop"];
    configuration.tags = ["Accessibility"];
    configuration.tracks = ["Community"];
    configuration.levels = ["Advanced"];

    expect(
      cfpRuleFields(configuration)
        .filter((field) =>
          ["format", "tags", "track", "level", "language"].includes(field.key ?? ""),
        )
        .map((field) => [field.key, fieldOptionValues(field)]),
    ).toEqual([
      ["format", ["Workshop"]],
      ["tags", ["Accessibility"]],
      ["track", ["Community"]],
      ["level", ["Advanced"]],
      ["language", ["English"]],
    ]);
  });
  it("saves a fully blank conditional rule without generating a rule", async () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    configuration.rule = { type: "condition", field: "", operator: "is", value: "" };
    configuration.ruleTargetField = undefined;
    let savedRules: CfpFormConfiguration["rules"] | undefined;
    const api = {
      saveConfiguration: async (input: Parameters<CfpApi["saveConfiguration"]>[0]) => {
        savedRules = input.form.rules;
        return { event: input.event, form: input.form };
      },
    } as CfpApi;

    await persistCfpConfiguration(api, {
      configuration,
      organizationId: "organization-1",
      eventId: "devflow-conf-2027",
      formId: "devflow-cfp",
    });
    expect(savedRules).toEqual([]);
  });

  it("blocks forward editor navigation until the current step is valid", () => {
    expect(
      resolveCfpEditorStepIndex({
        currentIndex: 1,
        requestedIndex: 2,
        currentStepValid: false,
      }),
    ).toBe(1);
    expect(
      resolveCfpEditorStepIndex({
        currentIndex: 1,
        requestedIndex: 2,
        currentStepValid: true,
      }),
    ).toBe(2);
    expect(
      resolveCfpEditorStepIndex({
        currentIndex: 3,
        requestedIndex: 1,
        currentStepValid: false,
      }),
    ).toBe(1);
  });

  it("computes section offsets for the organizer panel scroll container", () => {
    expect(cfpSectionScrollOffset(52, 64)).toBe(132);
    expect(cfpActiveSectionThreshold(52, 64)).toBe(156);
    expect(cfpContainerScrollTop(120, 460, 48, 64)).toBe(452);
  });

  it("renders authoritative event identity as read-only and directs edits to Event details", () => {
    const markup = renderToStaticMarkup(
      createElement(CfpEventIdentityFields, {
        eventName: "DevFlow Conference",
        slug: "devflow-conf",
        timezone: "America/New_York",
        organizationId: "organization-1",
      }),
    );

    expect(markup).toMatch(/<input(?=[^>]*name="eventName")(?=[^>]*readOnly="")[^>]*>/);
    expect(markup).toMatch(/<input(?=[^>]*name="slug")(?=[^>]*readOnly="")[^>]*>/);
    expect(markup).toMatch(/<select(?=[^>]*name="timezone")(?=[^>]*disabled="")[^>]*>/);
    expect(markup).toContain('href="/admin/events"');
  });

  it("starts in a truthful loading state without fixture configuration", () => {
    const previousRuntimeProfile = process.env.NEXT_PUBLIC_RUNTIME_PROFILE;
    process.env.NEXT_PUBLIC_RUNTIME_PROFILE = "fixture";
    try {
      const markup = renderToStaticMarkup(
        createElement(CfpEditor, { eventId: "summit-2026", organizationId: "organization-1" }),
      );

      expect(markup).toContain("Loading CFP configuration");
      expect(markup).not.toContain("Eventloom Summit 2026");
      expect(markup).not.toContain("America/Los_Angeles");
      expect(markup).not.toContain("Copy public link");
      expect(markup).not.toContain("View public form");
      expect(markup).not.toContain('aria-label="Event and CFP configuration"');
    } finally {
      process.env.NEXT_PUBLIC_RUNTIME_PROFILE = previousRuntimeProfile;
    }
  });

  it("loads authoritative event and form configuration through the injected API", async () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    const event = {
      id: "event-1",
      tenantId: "organization-1",
      version: 3,
      slug: "devflow-conf-2027",
      name: "DevFlow Conference",
      timezone: "America/New_York",
      opensAt: "2027-01-01T05:00:00.000Z",
      closesAt: "2027-02-01T05:00:00.000Z",
    };
    const form = toFormConfiguration(configuration, "organization-1", "event-1");
    const calls: string[] = [];
    const api = {
      getEvent: async () => {
        calls.push("event");
        return event;
      },
      listForms: async () => {
        calls.push("forms");
        return [form];
      },
    } as unknown as CfpApi;

    const loaded = await loadCfpEditorConfiguration(api, {
      organizationId: "organization-1",
      eventId: "event-1",
    });

    expect(calls).toEqual(["event", "forms"]);
    expect(loaded).toEqual({ event, form });
  });

  it("deduplicates concurrent loads for the same editor scope", async () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    const event = {
      id: "event-1",
      tenantId: "organization-1",
      version: 3,
      slug: "devflow-conf-2027",
      name: "DevFlow Conference",
      timezone: "America/New_York",
      opensAt: "2027-01-01T05:00:00.000Z",
      closesAt: "2027-02-01T05:00:00.000Z",
    };
    const form = toFormConfiguration(configuration, "organization-1", "event-1");
    const calls: string[] = [];
    const api = {
      getEvent: async () => {
        calls.push("event");
        return event;
      },
      listForms: async () => {
        calls.push("forms");
        return [form];
      },
    } as unknown as CfpApi;
    const input = { organizationId: "organization-1", eventId: "event-1" };

    await Promise.all([
      loadCfpEditorConfiguration(api, input),
      loadCfpEditorConfiguration(api, input),
    ]);

    expect(calls).toEqual(["event", "forms"]);
  });

  it("validates date ordering and identifies past close dates", () => {
    expect(validateCfpDateRange("2026-08-10", "2026-08-10")).toBe(
      "The close date must be after the open date.",
    );
    expect(validateCfpDateRange("not-a-date", "2026-08-10")).toBe(
      "Enter valid open and close dates.",
    );
    expect(isCfpCloseDatePast("2026-08-01", new Date("2026-08-10T00:00:00.000Z"))).toBe(true);
  });

  it("validates unchanged same-local-date boundaries using their exact persisted instants", () => {
    expect(
      validateCfpDateRange(
        "2026-08-16",
        "2026-08-16",
        "America/Los_Angeles",
        "2026-08-16T17:45:12.345Z",
        "2026-08-16T23:30:45.678Z",
      ),
    ).toBeNull();
  });

  it("does not classify an unchanged later-today close instant as past", () => {
    const now = new Date("2026-08-16T20:00:00.000Z");

    expect(isCfpCloseDatePast("2026-08-16", now, "America/Los_Angeles")).toBe(true);
    expect(
      isCfpCloseDatePast("2026-08-16", now, "America/Los_Angeles", "2026-08-16T23:30:45.678Z"),
    ).toBe(false);
  });

  it("does not render a past-close warning for an unchanged later-today close instant", () => {
    const markup = renderToStaticMarkup(
      createElement(CfpPastCloseConfirmation, {
        closesAt: "2026-08-16",
        persistedClosesAt: "2026-08-16T23:30:45.678Z",
        timezone: "America/Los_Angeles",
        now: new Date("2026-08-16T20:00:00.000Z"),
        acknowledged: false,
        onAcknowledgedChange: () => undefined,
      }),
    );

    const pastMarkup = renderToStaticMarkup(
      createElement(CfpPastCloseConfirmation, {
        closesAt: "2026-08-16",
        persistedClosesAt: "2026-08-16T19:30:45.678Z",
        timezone: "America/Los_Angeles",
        now: new Date("2026-08-16T20:00:00.000Z"),
        acknowledged: false,
        onAcknowledgedChange: () => undefined,
      }),
    );

    expect(markup).toBe("");
    expect(markup).not.toContain("Confirm past close date");
    expect(pastMarkup).toContain("Confirm past close date");
  });
  it("computes the CFP minimum date in the configured timezone", () => {
    const now = new Date("2026-08-16T06:30:00.000Z");
    expect(cfpMinimumDate(now, "America/Los_Angeles")).toBe("2026-08-15");
    expect(cfpMinimumDate(now, "Asia/Singapore")).toBe("2026-08-16");
  });
  it("computes a server close-now instant without violating the open boundary", () => {
    const now = new Date("2026-08-10T13:46:51.000Z");
    expect(closeCfpNowInstant("2026-08-01", now)).toBe(now.toISOString());
    expect(closeCfpNowInstant("2026-08-20", now)).toBe("2026-08-20T00:00:00.001Z");

    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    configuration.opensAt = "2027-01-01";
    const closed = closeCfpNowConfiguration(configuration, now);
    expect(closed.closesAt).toBe("2027-01-01T08:00:00.001Z");
    expect(Date.parse(closed.closesAt)).toBeGreaterThanOrEqual(
      Date.parse(`${configuration.opensAt}T00:00:00.000Z`),
    );
  });

  it("persists CFP configuration through one aggregate request and rehydrates its authoritative versions", async () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    configuration.opensAt = "2026-08-01";
    configuration.closesAt = "2026-08-15";
    configuration.id = "devflow-cfp";
    configuration.eventVersion = 3;
    configuration.formVersion = 4;
    configuration.formats = ["Workshop"];
    configuration.rule = {
      type: "condition",
      field: "format",
      operator: "is",
      value: "Workshop",
    };
    configuration.ruleTargetField = "prerequisites";
    configuration.fields = [
      ...configuration.fields,
      {
        id: "prerequisites",
        key: "prerequisites",
        label: "Prerequisites",
        type: "textarea",
        kind: "rich_text",
        required: false,
        visible: true,
        placeholder: "",
        options: [],
      },
    ];
    const savedEvent = {
      id: "devflow-conf-2027",
      tenantId: "organization-1",
      version: 4,
      slug: "devflow-conf-2027",
      name: configuration.eventName,
      timezone: configuration.timezone,
      opensAt: "2026-08-01T07:00:00.000Z",
      closesAt: "2026-08-15T07:00:00.000Z",
    };
    const savedForm = {
      ...toFormConfiguration(configuration, "organization-1", "devflow-conf-2027"),
      version: 5,
      status: "draft" as const,
    };
    let aggregateInput: Parameters<CfpApi["saveConfiguration"]>[0] | undefined;
    const api = {
      saveConfiguration: async (input: Parameters<CfpApi["saveConfiguration"]>[0]) => {
        aggregateInput = input;
        return { event: savedEvent, form: savedForm };
      },
    } as CfpApi;

    await expect(
      persistCfpConfiguration(api, {
        configuration,
        organizationId: "organization-1",
        eventId: "devflow-conf-2027",
        formId: "devflow-cfp",
      }),
    ).resolves.toEqual({ event: savedEvent, form: savedForm });
    expect(aggregateInput).toMatchObject({
      expectedEventVersion: 3,
      expectedFormVersion: 4,
      form: expect.objectContaining({
        rules: expect.arrayContaining([
          expect.objectContaining({
            actions: [{ type: "show_field", fieldKey: "prerequisites" }],
            when: expect.objectContaining({
              conditions: [
                expect.objectContaining({
                  fieldKey: "format",
                  operator: "equals",
                  value: "Workshop",
                }),
              ],
            }),
          }),
        ]),
      }),
    });
    const rehydrated = configurationFromServer(configuration, savedEvent, savedForm);
    expect(rehydrated.eventVersion).toBe(4);
    expect(rehydrated.formVersion).toBe(5);
    expect(rehydrated.closesAt).toBe("2026-08-15");
  });

  it("rejects every partial conditional rule before the aggregate request", async () => {
    const partialRules = [
      { field: "", value: "", target: "accessibility-notes" },
      { field: "format", value: "", target: "" },
      { field: "", value: "Workshop · 60 minutes", target: "" },
      { field: "format", value: "Workshop · 60 minutes", target: "" },
      { field: "", value: "Workshop · 60 minutes", target: "accessibility-notes" },
      { field: "format", value: "", target: "accessibility-notes" },
    ];
    let calls = 0;
    const api = {
      saveConfiguration: async () => {
        calls += 1;
        throw new Error("should not be called");
      },
    } as unknown as CfpApi;

    for (const partial of partialRules) {
      const configuration = createTestCfpConfiguration("devflow-conf-2027");
      configuration.rule = {
        type: "condition",
        field: partial.field,
        operator: "is",
        value: partial.value,
      };
      configuration.ruleTargetField = partial.target || undefined;
      expect(
        toFormConfiguration(configuration, "organization-1", "devflow-conf-2027").rules,
      ).toEqual([]);
      await expect(
        persistCfpConfiguration(api, {
          configuration,
          organizationId: "organization-1",
          eventId: "devflow-conf-2027",
          formId: "devflow-cfp",
        }),
      ).rejects.toThrow(/Conditional rule/);
    }
    expect(calls).toBe(0);
  });

  it("does not advance local versions when the aggregate save rejects", async () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    configuration.eventVersion = 3;
    configuration.formVersion = 4;
    const api = {
      saveConfiguration: async () => {
        throw new Error("aggregate persistence failed");
      },
    } as unknown as CfpApi;

    await expect(
      persistCfpConfiguration(api, {
        configuration,
        organizationId: "organization-1",
        eventId: "devflow-conf-2027",
        formId: "devflow-cfp",
      }),
    ).rejects.toThrow("aggregate persistence failed");
    expect(configuration.eventVersion).toBe(3);
    expect(configuration.formVersion).toBe(4);
  });

  it("loads CFP dates in the event timezone instead of slicing UTC dates", () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    const form = toFormConfiguration(configuration, "organization-1", "devflow-conf-2027");
    const loaded = configurationFromServer(
      configuration,
      {
        id: "devflow-conf-2027",
        tenantId: "organization-1",
        version: 4,
        slug: "devflow-conf-2027",
        name: "DevFlow Conference 2027",
        timezone: "America/Los_Angeles",
        opensAt: "2027-01-05T07:30:00.000Z",
        closesAt: "2027-02-15T07:30:00.000Z",
      },
      form,
    );

    expect(loaded.opensAt).toBe("2027-01-04");
    expect(loaded.closesAt).toBe("2027-02-14");
  });

  it("preserves exact non-midnight CFP instants through an unrelated save", async () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    const form = toFormConfiguration(configuration, "organization-1", "devflow-conf-2027");
    const event = {
      id: "devflow-conf-2027",
      tenantId: "organization-1",
      version: 4,
      slug: "devflow-conf-2027",
      name: "DevFlow Conference 2027",
      timezone: "America/Los_Angeles",
      eventStartsAt: "2027-03-01T17:00:00.000Z",
      opensAt: "2027-01-05T17:45:12.345Z",
      closesAt: "2027-02-15T23:30:45.678Z",
    };
    const loaded = configurationFromServer(configuration, event, form);
    loaded.welcomeBody = "An unrelated copy edit.";
    let savedEventInput: unknown;
    const api = {
      saveConfiguration: async (input: Parameters<CfpApi["saveConfiguration"]>[0]) => {
        savedEventInput = input.event;
        return { event: input.event, form: input.form };
      },
    } as CfpApi;

    await persistCfpConfiguration(api, {
      configuration: loaded,
      organizationId: "organization-1",
      eventId: "devflow-conf-2027",
      formId: form.id,
    });

    expect(savedEventInput).toMatchObject({
      opensAt: event.opensAt,
      closesAt: event.closesAt,
    });
  });

  it("converts an intentionally changed CFP date to event-local midnight", async () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    const form = toFormConfiguration(configuration, "organization-1", "devflow-conf-2027");
    const event = {
      id: "devflow-conf-2027",
      tenantId: "organization-1",
      version: 4,
      slug: "devflow-conf-2027",
      name: "DevFlow Conference 2027",
      timezone: "America/Los_Angeles",
      eventStartsAt: "2027-03-01T17:00:00.000Z",
      opensAt: "2027-01-05T17:45:12.345Z",
      closesAt: "2027-02-15T23:30:45.678Z",
    };
    const loaded = configurationFromServer(configuration, event, form);
    loaded.opensAt = "2027-01-06";
    let savedEventInput: unknown;
    const api = {
      saveConfiguration: async (input: Parameters<CfpApi["saveConfiguration"]>[0]) => {
        savedEventInput = input.event;
        return { event: input.event, form: input.form };
      },
    } as CfpApi;

    await persistCfpConfiguration(api, {
      configuration: loaded,
      organizationId: "organization-1",
      eventId: "devflow-conf-2027",
      formId: form.id,
    });

    expect(savedEventInput).toMatchObject({
      opensAt: "2027-01-06T08:00:00.000Z",
      closesAt: event.closesAt,
    });
  });

  it("repairs missing core proposal fields when loading an existing form", () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    const form = toFormConfiguration(configuration, "organization-1", "devflow-conf-2027");
    const repaired = configurationFromServer(
      configuration,
      {
        id: "devflow-conf-2027",
        tenantId: "organization-1",
        version: 4,
        slug: "devflow-conf-2027",
        name: "DevFlow Conference 2027",
        timezone: "America/Los_Angeles",
        opensAt: "2027-01-05T08:00:00.000Z",
        closesAt: "2027-02-15T08:00:00.000Z",
      },
      {
        ...form,
        submissionFields: form.submissionFields.filter(
          (field) => !["title", "abstract", "description"].includes(field.key),
        ),
      },
    );

    expect(repaired.fields.slice(0, 3)).toMatchObject([
      {
        id: "title",
        key: "title",
        label: "Session title",
        type: "text",
        required: true,
        visible: true,
      },
      {
        id: "abstract",
        key: "abstract",
        label: "Abstract",
        type: "textarea",
        required: false,
        visible: true,
      },
      {
        id: "description",
        key: "description",
        label: "Description",
        type: "textarea",
        required: false,
        visible: true,
      },
    ]);
  });

  it("summarizes nested AND/OR condition logic", () => {
    expect(
      summarizeRule({
        type: "group",
        operator: "AND",
        conditions: [
          { type: "condition", field: "Format", operator: "is", value: "Workshop" },
          {
            type: "group",
            operator: "OR",
            conditions: [
              { type: "condition", field: "Track", operator: "is", value: "Community" },
              { type: "condition", field: "Level", operator: "is", value: "Introductory" },
            ],
          },
        ],
      }),
    ).toBe("(Format is Workshop AND (Track is Community OR Level is Introductory))");
  });
  it("round-trips sections, participant fields, rules, and reusable field lineage", () => {
    const configuration = createTestCfpConfiguration();
    configuration.proposalLimit = 7;
    configuration.sections = [
      { id: "proposal", title: "Proposal", description: "Tell us what you will share." },
      { id: "logistics", title: "Logistics", description: "Accessibility and files." },
    ];
    configuration.fields = [
      ...configuration.fields.map((field) => ({
        ...field,
        key: field.id,
        sectionId: "proposal",
        ...(field.id === "website"
          ? {
              fieldRef: { id: "tenant.website", version: 4 },
              fieldVersion: 4,
              description: "A public profile or project link.",
              config: { category: "profile", indexing: "public" },
            }
          : {}),
      })),
      {
        id: "slide-deck",
        key: "slideDeck",
        label: "Slide deck",
        type: "file_request",
        kind: "file_request",
        required: false,
        visible: true,
        placeholder: "",
        sectionId: "logistics",
        options: [],
        description: "Optional presentation materials.",
        fileRequest: {
          allowedMimeTypes: ["application/pdf"],
          maxBytes: 4_000_000,
          owner: "submission",
          required: false,
        },
        config: { category: "presentation" },
      },
    ];
    configuration.participantFields = [
      {
        id: "participant-pronouns",
        key: "pronouns",
        label: "Pronouns",
        type: "select",
        kind: "select",
        required: false,
        visible: true,
        placeholder: "",
        sectionId: "logistics",
        options: ["she/her", "they/them"],
        fieldRef: "tenant.pronouns",
        fieldVersion: 2,
      },
    ];
    delete configuration.ruleTargetField;
    configuration.ruleAction = "";
    configuration.rules = [
      {
        id: "show-logistics",
        priority: 10,
        when: {
          type: "group",
          operator: "all",
          conditions: [
            { type: "predicate", fieldKey: "format", operator: "equals", value: "Workshop" },
          ],
        },
        actions: [{ type: "show_section", sectionId: "logistics" }],
      },
    ];

    const event = {
      id: "summit-2026",
      tenantId: "org-1",
      version: 3,
      slug: "summit-2026",
      name: configuration.eventName,
      timezone: configuration.timezone,
      opensAt: "2026-01-15T00:00:00.000Z",
      closesAt: "2026-03-31T00:00:00.000Z",
    };
    const form = toFormConfiguration(configuration, "org-1", "summit-2026");
    const restored = configurationFromServer(configuration, event, form);

    expect(form.settings.maxSubmissionsPerAccount).toBe(7);
    expect(restored.proposalLimit).toBe(7);
    expect(restored.sections).toEqual(configuration.sections);
    expect(restored.rules).toEqual(configuration.rules);
    expect(restored.participantFields?.[0]).toMatchObject({
      key: "pronouns",
      fieldRef: "tenant.pronouns",
      fieldVersion: 2,
    });
    expect(restored.fields.find((field) => field.key === "website")).toMatchObject({
      sectionId: "proposal",
      fieldRef: { id: "tenant.website", version: 4 },
      fieldVersion: 4,
      description: "A public profile or project link.",
      config: { category: "profile", indexing: "public" },
      type: "url",
      visible: true,
    });
    expect(restored.fields.find((field) => field.key === "slideDeck")).toMatchObject({
      type: "file_request",
      visible: true,
      description: "Optional presentation materials.",
      fileRequest: {
        allowedMimeTypes: ["application/pdf"],
        maxBytes: 4_000_000,
        owner: "submission",
        required: false,
      },
      config: { category: "presentation" },
    });
  });
  it("discovers the published form for the exact event before stable fallbacks", () => {
    const draftConfiguration = createTestCfpConfiguration("devflow-conf-2027");
    draftConfiguration.id = "devflow-draft";
    draftConfiguration.status = "draft";
    const publishedConfiguration = createTestCfpConfiguration("devflow-conf-2027");
    publishedConfiguration.id = "devflow-conf-2027-cfp";
    publishedConfiguration.status = "published";
    const otherEventConfiguration = createTestCfpConfiguration("other-event");
    otherEventConfiguration.id = "main-cfp";
    otherEventConfiguration.status = "published";

    const selected = selectEditorForm(
      [
        toFormConfiguration(draftConfiguration, "ai-engineer", "devflow-conf-2027"),
        toFormConfiguration(otherEventConfiguration, "ai-engineer", "other-event"),
        toFormConfiguration(publishedConfiguration, "ai-engineer", "devflow-conf-2027"),
      ],
      "ai-engineer",
      "devflow-conf-2027",
    );

    expect(selected?.id).toBe("devflow-conf-2027-cfp");
  });

  it("uses an event-qualified form id when creating an empty event form", () => {
    const seeded = createTestCfpConfiguration("empty-event");
    const { id: _id, formVersion: _formVersion, ...configuration } = seeded;

    expect(toFormConfiguration(configuration, "ai-engineer", "empty-event")).toMatchObject({
      id: "empty-event-cfp",
      eventId: "empty-event",
      version: 1,
    });
  });

  it("authorizes newly selected file-request fields with safe submission defaults", () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    configuration.fields.push({
      id: "proposal-deck",
      key: "proposal_deck",
      label: "Session proposal deck",
      type: "file_request",
      kind: "file_request",
      required: true,
      visible: true,
      placeholder: "",
      options: [],
    });

    const form = toFormConfiguration(configuration, "ai-engineer", "devflow-conf-2027");

    expect(form.submissionFields.find((field) => field.key === "proposal_deck")).toMatchObject({
      kind: "file_request",
      required: true,
      fileRequest: {
        allowedMimeTypes: [
          "application/pdf",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-powerpoint",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "image/jpeg",
          "image/png",
          "image/webp",
          "text/plain",
        ],
        maxBytes: 25 * 1024 * 1024,
        required: true,
        owner: "submission",
      },
    });
  });

  it("keeps show-when semantics and rule references when a target key is edited", () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    configuration.formats = ["Talk (30 min)", "Workshop (120 min)"];
    configuration.rule = {
      type: "condition",
      field: "format",
      operator: "is not",
      value: "Workshop (120 min)",
    };
    configuration.ruleTargetField = "workshop-prerequisites";
    configuration.fields.push({
      id: "workshop-prerequisites",
      key: "workshop-prerequisites",
      label: "Workshop prerequisites",
      type: "textarea",
      kind: "rich_text",
      required: false,
      visible: true,
      placeholder: "",
      options: [],
    });

    const withShowWhenSemantics = updateCfpShowWhenCondition(configuration, {
      field: "format",
      value: "Workshop (120 min)",
    });
    const updated = updateCfpEditorField(withShowWhenSemantics, "workshop-prerequisites", {
      key: "workshop_prerequisites",
    });

    expect(updated.ruleTargetField).toBe("workshop_prerequisites");
    expect(updated.rule).toEqual({
      type: "condition",
      field: "format",
      operator: "is",
      value: "Workshop (120 min)",
    });
    expect(toFormConfiguration(updated, "ai-engineer", "devflow-conf-2027").rules).toContainEqual(
      expect.objectContaining({
        when: expect.objectContaining({
          conditions: [
            expect.objectContaining({
              fieldKey: "format",
              operator: "equals",
              value: "Workshop (120 min)",
            }),
          ],
        }),
        actions: [{ type: "show_field", fieldKey: "workshop_prerequisites" }],
      }),
    );
  });

  it("round-trips equals Workshop to show_field prerequisites without inversion", () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    configuration.formats = ["Workshop"];
    configuration.rule = {
      type: "condition",
      field: "format",
      operator: "is",
      value: "Workshop",
    };
    configuration.ruleTargetField = "prerequisites";
    configuration.ruleAction = "show prerequisites";
    configuration.fields = [
      ...configuration.fields,
      {
        id: "prerequisites",
        key: "prerequisites",
        label: "Prerequisites",
        type: "textarea",
        kind: "rich_text",
        required: false,
        visible: true,
        placeholder: "",
        options: [],
      },
    ];

    const form = toFormConfiguration(configuration, "ai-engineer", "devflow-conf-2027");
    const editorRule = form.rules.find((rule) => rule.id === "editor-conditional-rule");
    expect(editorRule).toMatchObject({
      when: {
        type: "group",
        operator: "all",
        conditions: [
          {
            type: "predicate",
            fieldKey: "format",
            operator: "equals",
            value: "Workshop",
          },
        ],
      },
      actions: [{ type: "show_field", fieldKey: "prerequisites" }],
    });

    const event = {
      id: "devflow-conf-2027",
      tenantId: "ai-engineer",
      version: 1,
      slug: "devflow-conf-2027",
      name: configuration.eventName,
      timezone: configuration.timezone,
      opensAt: "2027-01-01T00:00:00.000Z",
      closesAt: "2027-02-01T00:00:00.000Z",
    };
    const unrelatedRule = {
      id: "published-routing-rule",
      priority: 20,
      when: {
        type: "group",
        operator: "all",
        conditions: [
          {
            type: "predicate",
            fieldKey: "track",
            operator: "equals",
            value: "Product craft",
          },
        ],
      },
      actions: [{ type: "route", destination: "product-review" }],
    };
    const persistedForm = {
      ...form,
      rules: [
        ...form.rules.map((rule) =>
          rule.id === "editor-conditional-rule"
            ? { ...rule, id: "rule-workshop-prerequisites", priority: 10 }
            : rule,
        ),
        unrelatedRule,
      ],
    };
    const restored = configurationFromServer(
      createEmptyCfpConfiguration("devflow-conf-2027"),
      event,
      persistedForm,
    );
    expect(restored.rule).toEqual(configuration.rule);
    expect(restored.ruleTargetField).toBe("prerequisites");
    expect(restored.editorRuleId).toBe("rule-workshop-prerequisites");

    const roundTripped = toFormConfiguration(restored, "ai-engineer", "devflow-conf-2027");
    expect(roundTripped.rules).toHaveLength(persistedForm.rules.length);
    expect(roundTripped.rules).toContainEqual(unrelatedRule);
    expect(roundTripped.rules).toContainEqual(
      expect.objectContaining({
        id: "rule-workshop-prerequisites",
        priority: 10,
        when: expect.objectContaining({
          operator: "all",
          conditions: [expect.objectContaining({ operator: "equals", value: "Workshop" })],
        }),
        actions: [{ type: "show_field", fieldKey: "prerequisites" }],
      }),
    );
    const nestedPersistedForm = {
      ...persistedForm,
      rules: persistedForm.rules.map((rule) =>
        rule.id === "rule-workshop-prerequisites"
          ? {
              ...rule,
              when: {
                type: "group",
                operator: "all",
                conditions: [
                  {
                    type: "predicate",
                    fieldKey: "format",
                    operator: "equals",
                    value: "Workshop",
                  },
                  {
                    type: "group",
                    operator: "any",
                    conditions: [
                      {
                        type: "predicate",
                        fieldKey: "track",
                        operator: "equals",
                        value: "Community systems",
                      },
                      {
                        type: "predicate",
                        fieldKey: "level",
                        operator: "equals",
                        value: "Introductory",
                      },
                    ],
                  },
                ],
              },
            }
          : rule,
      ),
    };
    const nestedRestored = configurationFromServer(configuration, event, nestedPersistedForm);
    expect(nestedRestored.rule).toEqual({
      type: "group",
      operator: "AND",
      conditions: [
        {
          type: "condition",
          field: "format",
          operator: "is",
          value: "Workshop",
        },
        {
          type: "group",
          operator: "OR",
          conditions: [
            {
              type: "condition",
              field: "track",
              operator: "is",
              value: "Community systems",
            },
            {
              type: "condition",
              field: "level",
              operator: "is",
              value: "Introductory",
            },
          ],
        },
      ],
    });
    const nestedRoundTripped = toFormConfiguration(
      nestedRestored,
      "ai-engineer",
      "devflow-conf-2027",
    );
    expect(nestedRoundTripped.rules).toContainEqual(
      expect.objectContaining({
        id: "rule-workshop-prerequisites",
        when: {
          type: "group",
          operator: "all",
          conditions: [
            {
              type: "predicate",
              fieldKey: "format",
              operator: "equals",
              value: "Workshop",
            },
            {
              type: "group",
              operator: "any",
              conditions: [
                {
                  type: "predicate",
                  fieldKey: "track",
                  operator: "equals",
                  value: "Community systems",
                },
                {
                  type: "predicate",
                  fieldKey: "level",
                  operator: "equals",
                  value: "Introductory",
                },
              ],
            },
          ],
        },
      }),
    );
  });
  it("preserves nonrepresentable show-field rules without claiming editor ownership", () => {
    const current = createTestCfpConfiguration("devflow-conf-2027");
    const event = {
      id: "devflow-conf-2027",
      tenantId: "ai-engineer",
      version: 1,
      slug: "devflow-conf-2027",
      name: current.eventName,
      timezone: current.timezone,
      opensAt: "2027-01-01T00:00:00.000Z",
      closesAt: "2027-02-01T00:00:00.000Z",
    };
    const baseForm = toFormConfiguration(current, "ai-engineer", "devflow-conf-2027");
    const unsupportedRule = {
      id: "external-show-rule",
      priority: 37,
      when: {
        type: "group",
        operator: "all",
        conditions: [
          {
            type: "predicate",
            fieldKey: "format",
            operator: "contains",
            value: "Workshop",
          },
        ],
      },
      actions: [{ type: "show_field", fieldKey: "accessibility-notes" }],
    };
    const persistedForm = { ...baseForm, rules: [unsupportedRule] };

    const restored = configurationFromServer(
      createEmptyCfpConfiguration("devflow-conf-2027"),
      event,
      persistedForm,
    );
    expect(restored.editorRuleId).toBeUndefined();
    expect(restored.rule).toEqual({
      type: "condition",
      field: "",
      operator: "is",
      value: "",
    });
    expect(toFormConfiguration(restored, "ai-engineer", "devflow-conf-2027").rules).toEqual([
      unsupportedRule,
    ]);
  });

  it("omits empty optional taxonomy fields from persisted forms", () => {
    const configuration = createTestCfpConfiguration("devflow-conf-2027");
    configuration.tags = [];
    configuration.levels = [];
    configuration.fields = configuration.fields.filter(
      (field) => !["tags", "level"].includes(field.key ?? field.id),
    );

    const form = toFormConfiguration(configuration, "ai-engineer", "devflow-conf-2027");
    expect(form.submissionFields.map((field) => field.key)).not.toContain("tags");
    expect(form.submissionFields.map((field) => field.key)).not.toContain("level");
  });

  it("locks the canonical session title field key and prevents removal", () => {
    const configuration = withCoreProposalFields(
      createTestCfpConfiguration("devflow-conf-2027").fields,
    );
    const base = {
      ...createTestCfpConfiguration("devflow-conf-2027"),
      fields: configuration,
    };
    const title = base.fields.find((field) => field.key === "title");
    expect(title).toMatchObject({
      key: "title",
      system: true,
      keyLocked: true,
      required: true,
    });
    expect(title?.id).toBeTruthy();
    if (title === undefined) throw new Error("The test CFP title field is missing.");

    const renamed = updateCfpEditorField(base, title.id, {
      key: "title1",
      label: "Session title 1",
      required: false,
    });
    const renamedTitle = renamed.fields.find((field) => field.id === title.id);
    expect(renamedTitle).toMatchObject({
      key: "title",
      label: "Session title 1",
      required: true,
      system: true,
      keyLocked: true,
    });

    const withoutTitle = removeCfpEditorField(renamed, title.id);
    expect(withoutTitle.fields.some((field) => field.key === "title")).toBe(true);

    const customClaim = updateCfpEditorField(renamed, "abstract", { key: "title" });
    expect(customClaim.fields.find((field) => field.id === "abstract")?.key).toBe("abstract");
  });

  it("repairs a mis-keyed title field when loading core proposal fields", () => {
    const repaired = withCoreProposalFields([
      {
        id: "title",
        key: "title1",
        label: "Session title 1",
        type: "text",
        required: true,
        visible: true,
        placeholder: "",
        options: [],
      },
      {
        id: "abstract",
        key: "abstract",
        label: "Abstract",
        type: "textarea",
        required: false,
        visible: true,
        placeholder: "",
        options: [],
      },
    ]);

    const title = repaired.find((field) => field.id === "title");
    expect(title).toMatchObject({
      key: "title",
      label: "Session title 1",
      system: true,
      keyLocked: true,
      required: true,
    });
    expect(repaired.filter((field) => field.key === "title")).toHaveLength(1);
  });
});
