import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  type CfpAuthenticatedSession,
  CfpMutationGate,
  type CfpPublishedForm,
  type PublishedCfp,
} from "./api";
import { createCfpStartupStore } from "./cfp-startup-store";
import {
  canResumeCfpSubmission,
  canSaveCfpDraftAtStep,
  cfpConfirmationEmailMessage,
  cfpHttpUrlIsValid,
  cfpPublishedFieldIsVisible,
  cfpReviewAudienceLevel,
  cfpSubmissionErrorKey,
  cfpSubmissionFieldValue,
  cfpSubmissionPayload,
  getCfpCompletionHandoffStorageKey,
  getCfpPortalHandoffHref,
  rotateCfpCompletionIdentity,
  shouldAuthenticateCfpAccount,
} from "./cfp-wizard-model";
import {
  clearCfpSubmissionState,
  getCfpActiveSubmissionStorageKey,
  getCfpDraftStorageKey,
  getCfpSubmissionPointerStorageKey,
} from "./draft-persistence";
import { getCfpStepRoute, getNextCfpStep, getPreviousCfpStep } from "./routes";
import {
  createEmptyDraft,
  createEmptyParticipant,
  markDraftSubmitted,
  syncPrimaryParticipant,
} from "./types";

const cfpWizardSectionsSource = readFileSync(
  new URL("./cfp-wizard-sections.tsx", import.meta.url),
  "utf8",
);
const cfpWizardSource = readFileSync(new URL("./cfp-wizard.tsx", import.meta.url), "utf8");

describe("CFP flow", () => {
  it("matches server URL validation for absolute HTTP and HTTPS values", () => {
    expect(cfpHttpUrlIsValid("https://example.test/project")).toBe(true);
    expect(cfpHttpUrlIsValid("http://localhost:3000/demo")).toBe(true);
    expect(cfpHttpUrlIsValid("not a URL")).toBe(false);
    expect(cfpHttpUrlIsValid("javascript:alert(1)")).toBe(false);
  });
  it("mounts the public application flow inside the shared workspace shell", () => {
    expect(cfpWizardSectionsSource).toContain(
      'import { ThemeToggle } from "../../components/product-shell/theme-toggle";',
    );
    expect(cfpWizardSectionsSource).toContain(
      'import { WorkspaceContextBar, WorkspaceShell } from "../../components/workspace/workspace-shell";',
    );
    expect(cfpWizardSectionsSource).toContain("<WorkspaceShell");
    expect(cfpWizardSectionsSource).toContain("<WorkspaceContextBar");
    expect(cfpWizardSectionsSource).toContain("<ThemeToggle />");
  });
  it("uses client navigation when returning to the organizer workspace", () => {
    expect(cfpWizardSectionsSource).toContain('import Link from "next/link";');
    expect(cfpWizardSectionsSource).toContain(
      '<Link href="/admin">Return to organizer workspace</Link>',
    );
    expect(cfpWizardSectionsSource).not.toContain(
      '<a href="/admin">Return to organizer workspace</a>',
    );
    expect(cfpWizardSectionsSource).toContain(
      '<Link href="/login?next=%2Fportal%2Fsubmissions">Use another account</Link>',
    );
    expect(cfpWizardSectionsSource).not.toContain(
      '<a href="/login?next=%2Fportal%2Fsubmissions">Use another account</a>',
    );
  });
  it("navigates from welcome to account without entering the draft mutation path", () => {
    expect(cfpWizardSectionsSource).toContain("<Link href={accountHref}>Continue →</Link>");
    expect(cfpWizardSectionsSource).toContain("const accountHref = getCfpStepRoute(");
    expect(cfpWizardSectionsSource).toContain(
      'onSubmit={step === "welcome" ? undefined : (event) => onSubmit(event)}',
    );
    expect(cfpWizardSectionsSource).toContain('{step !== "welcome" ? (');
    expect(cfpWizardSource).toContain(
      'if (step === "welcome") {\n      if (submissionsClosed) setSaveState("idle");\n      return;',
    );
  });

  it("clears a pinned draft pointer only for a 404, not an authentication boundary", () => {
    expect(cfpWizardSource).toContain("error.status !== 404");
    expect(cfpWizardSource).not.toContain("error.status !== 401 && error.status !== 404");
    expect(cfpWizardSource).toContain('pinnedDraft.status === "reset"');
    expect(cfpWizardSource).toContain(': { status: "unavailable" };');
  });

  it("starts draft saving only after authentication reaches the proposal", () => {
    expect(
      (["welcome", "account", "submission", "participants", "review"] as const).map((step) =>
        canSaveCfpDraftAtStep(step),
      ),
    ).toEqual([false, false, true, true, true]);
  });

  it("keeps published abstract and description controls independent", () => {
    const draft = createEmptyDraft("future-conf");
    draft.submission.description = "Legacy summary";
    const answers = {
      abstract: "Short program summary",
      description: "Detailed objectives and audience takeaways",
    };

    expect(cfpSubmissionErrorKey("abstract")).toBe("submission.abstract");
    expect(cfpSubmissionErrorKey("description")).toBe("submission.description");
    expect(cfpSubmissionFieldValue(draft, answers, "abstract")).toBe(answers.abstract);
    expect(cfpSubmissionFieldValue(draft, answers, "description")).toBe(answers.description);
    expect(cfpSubmissionPayload(draft, answers, {}).answers).toMatchObject(answers);
  });
  it("shows workshop prerequisites only when the published format equals Workshop", () => {
    const form = {
      id: "devflow-cfp",
      name: "DevFlow Conf 2027 CFP",
      version: 3,
      status: "published" as const,
      welcomeContent: "Share your proposal",
      settings: {
        speakerLimit: 3,
        maxSubmissionsPerAccount: 3,
        confirmationMessage: "Proposal received",
        successContent: "Thank you",
      },
      sections: [{ id: "proposal", title: "Proposal", description: "" }],
      submissionFields: [
        {
          id: "format",
          sectionId: "proposal",
          key: "format",
          label: "Format",
          kind: "select",
          required: false,
          options: ["Talk (30 min)", "Workshop (120 min)"],
        },
        {
          id: "workshop_prerequisites",
          sectionId: "proposal",
          key: "workshop_prerequisites",
          label: "Workshop prerequisites",
          kind: "rich_text",
          required: false,
          options: [],
        },
      ],
      participantFields: [],
      rules: [
        {
          id: "workshop-prerequisites",
          priority: 100,
          when: {
            type: "group",
            operator: "all",
            conditions: [
              {
                type: "predicate",
                fieldKey: "format",
                operator: "equals",
                value: "Workshop (120 min)",
              },
            ],
          },
          actions: [{ type: "show_field", fieldKey: "workshop_prerequisites" }],
        },
      ],
    } as CfpPublishedForm;

    expect(
      cfpPublishedFieldIsVisible(form, { format: "Workshop (120 min)" }, "workshop_prerequisites"),
    ).toBe(true);
    expect(
      cfpPublishedFieldIsVisible(form, { format: "Talk (30 min)" }, "workshop_prerequisites"),
    ).toBe(false);
  });

  it("shows workshop prerequisites only when the published format equals Workshop", () => {
    const form = {
      id: "devflow-cfp",
      name: "DevFlow Conf 2027 CFP",
      version: 3,
      status: "published" as const,
      welcomeContent: "Share your proposal",
      settings: {
        speakerLimit: 3,
        maxSubmissionsPerAccount: 3,
        confirmationMessage: "Proposal received",
        successContent: "Thank you",
      },
      sections: [{ id: "proposal", title: "Proposal", description: "" }],
      submissionFields: [
        {
          id: "format",
          sectionId: "proposal",
          key: "format",
          label: "Format",
          kind: "select",
          required: false,
          options: ["Talk (30 min)", "Workshop (120 min)"],
        },
        {
          id: "workshop_prerequisites",
          sectionId: "proposal",
          key: "workshop_prerequisites",
          label: "Workshop prerequisites",
          kind: "rich_text",
          required: false,
          options: [],
        },
      ],
      participantFields: [],
      rules: [
        {
          id: "workshop-prerequisites",
          priority: 100,
          when: {
            type: "group",
            operator: "all",
            conditions: [
              {
                type: "predicate",
                fieldKey: "format",
                operator: "equals",
                value: "Workshop (120 min)",
              },
            ],
          },
          actions: [{ type: "show_field", fieldKey: "workshop_prerequisites" }],
        },
      ],
    } as CfpPublishedForm;

    expect(
      cfpPublishedFieldIsVisible(form, { format: "Workshop (120 min)" }, "workshop_prerequisites"),
    ).toBe(true);
    expect(
      cfpPublishedFieldIsVisible(form, { format: "Talk (30 min)" }, "workshop_prerequisites"),
    ).toBe(false);
  });

  it("deduplicates published form and session reads across step remounts", async () => {
    const store = createCfpStartupStore();
    const published = { form: { id: "form-1" } } as unknown as PublishedCfp;
    const session = { email: "speaker@example.com" } as CfpAuthenticatedSession;
    const api = {
      getPublished: vi.fn(async () => published),
      getSession: vi.fn(async () => session),
    };
    const identity = { organizationId: "org-1", eventId: "event-1", formId: "form-1" };

    const welcome = store.load(api, identity);
    const account = store.load(api, identity);
    const submission = store.load(api, identity);

    await expect(
      Promise.all([welcome.published, account.published, submission.published]),
    ).resolves.toEqual([published, published, published]);
    await expect(
      Promise.all([welcome.session, account.session, submission.session]),
    ).resolves.toEqual([session, session, session]);
    expect(api.getPublished).toHaveBeenCalledTimes(1);
    expect(api.getSession).toHaveBeenCalledTimes(1);
  });

  it("keeps event caches isolated and retries a failed published-form read", async () => {
    const store = createCfpStartupStore();
    const published = { form: { id: "form-1" } } as unknown as PublishedCfp;
    const api = {
      getPublished: vi
        .fn<() => Promise<PublishedCfp>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(published),
      getSession: vi.fn(async () => null),
    };
    const identity = { organizationId: "org-1", eventId: "event-1" };
    await expect(store.load(api, identity).published).rejects.toThrow("offline");
    await expect(store.load(api, identity).published).resolves.toBe(published);
    await expect(
      store.load(api, { organizationId: "org-1", eventId: "event-2" }).published,
    ).resolves.toBe(published);
    expect(api.getPublished).toHaveBeenCalledTimes(3);
  });

  it("maps the evidence-defined account-first sequence to stable routes", () => {
    const eventSlug = "future/conf";

    expect(getCfpStepRoute("org/live", eventSlug, "welcome")).toBe(
      "/cfp/organizations/org%2Flive/events/future%2Fconf",
    );
    expect(getCfpStepRoute("org/live", eventSlug, "account")).toBe(
      "/cfp/organizations/org%2Flive/events/future%2Fconf/account",
    );
    expect(getNextCfpStep("welcome")).toBe("account");
    expect(getNextCfpStep("account")).toBe("submission");
    expect(getNextCfpStep("submission")).toBe("participants");
    expect(getNextCfpStep("participants")).toBe("review");
    expect(getNextCfpStep("review")).toBe("complete");
    expect(getPreviousCfpStep("review")).toBe("participants");
  });

  it("routes post-submission handoff to the applicant status dashboard", () => {
    expect(getCfpPortalHandoffHref("/portal/submissions", "demo-event")).toBe(
      "/portal/submissions?event=demo-event",
    );
  });

  it("authenticates anonymous applicants before protected draft writes", () => {
    expect(shouldAuthenticateCfpAccount("account", null)).toBe(true);
    expect(
      shouldAuthenticateCfpAccount("account", {
        email: "speaker@example.com",
        name: "Speaker",
        firstName: "Speaker",
        lastName: "",
        memberships: [],
      }),
    ).toBe(false);
    expect(shouldAuthenticateCfpAccount("submission", null)).toBe(false);
  });
  it("keeps submitted hydration separate from per-step draft save permission", () => {
    const identity = { organizationId: "org-1", eventId: "event-1", formId: "form-1" };
    const pointerKey = getCfpSubmissionPointerStorageKey("org-1", "event-1", "form-1");
    const completionKey = getCfpCompletionHandoffStorageKey("org-1", "event-1", "form-1");
    const activeKey = getCfpActiveSubmissionStorageKey("org-1", "event-1", "form-1");
    const localValues = new Map([[pointerKey, "submission-1"]]);
    const sessionValues = new Map<string, string>([[activeKey, "submission-1"]]);

    rotateCfpCompletionIdentity(
      identity,
      " submission-1 ",
      {
        getItem: (key) => localValues.get(key) ?? null,
        removeItem: (key) => localValues.delete(key),
      },
      {
        removeItem: (key) => sessionValues.delete(key),
        setItem: (key, value) => sessionValues.set(key, value),
      },
    );

    expect(localValues.has(pointerKey)).toBe(false);
    expect(sessionValues.has(activeKey)).toBe(false);
    expect(sessionValues.get(completionKey)).toBe("submission-1");
    localValues.set(pointerKey, "submission-2");
    sessionValues.set(activeKey, "submission-1");
    rotateCfpCompletionIdentity(
      identity,
      "submission-1",
      {
        getItem: (key) => localValues.get(key) ?? null,
        removeItem: (key) => localValues.delete(key),
      },
      {
        removeItem: (key) => sessionValues.delete(key),
        setItem: (key, value) => sessionValues.set(key, value),
      },
    );
    expect(localValues.get(pointerKey)).toBe("submission-2");
    expect(sessionValues.has(activeKey)).toBe(false);
    expect(canResumeCfpSubmission("draft", "welcome")).toBe(true);
    expect(canResumeCfpSubmission("reopened", "account")).toBe(true);
    expect(canResumeCfpSubmission("submitted", "welcome")).toBe(true);
    expect(canResumeCfpSubmission("submitted", "account")).toBe(true);
    expect(canResumeCfpSubmission("submitted", "submission")).toBe(true);
    expect(canResumeCfpSubmission("submitted", "participants")).toBe(true);
    expect(canResumeCfpSubmission("submitted", "review")).toBe(true);
    expect(canSaveCfpDraftAtStep("welcome")).toBe(false);
    expect(canSaveCfpDraftAtStep("account")).toBe(false);
    expect(canSaveCfpDraftAtStep("submission")).toBe(true);
    expect(canSaveCfpDraftAtStep("participants")).toBe(true);
    expect(canSaveCfpDraftAtStep("review")).toBe(true);
  });
  it("reviews the stable audience answer and formats confirmation copy", () => {
    const form = {
      submissionFields: [
        {
          id: "field-audience-level",
          key: "audienceLevel",
          label: "Audience level",
        },
      ],
    } as CfpPublishedForm;

    expect(cfpReviewAudienceLevel(form, { audienceLevel: "Advanced" }, "")).toEqual({
      label: "Audience level",
      value: "Advanced",
    });
    expect(cfpConfirmationEmailMessage("speaker@example.test")).toBe(
      "A confirmation email is queued for speaker@example.test and will include the event name and talk title.",
    );
  });

  it("prefills the primary participant from the account without overwriting edits", () => {
    const draft = createEmptyDraft("future-conf", "2026-08-08T12:00:00.000Z");
    draft.account = {
      email: "account@example.com",
      firstName: "Account",
      lastName: "Owner",
      acceptedTerms: true,
    };
    draft.participants[0] = {
      ...createEmptyParticipant("primary"),
      firstName: "Edited",
    };

    const synced = syncPrimaryParticipant(draft, "2026-08-08T12:01:00.000Z");

    expect(synced.participants[0]).toMatchObject({
      firstName: "Edited",
      lastName: "Owner",
      email: "account@example.com",
    });
  });

  it("emits only one stable confirmation receipt across repeated submits", () => {
    const draft = createEmptyDraft("future-conf");
    const first = markDraftSubmitted(draft, "receipt-1", "2026-08-08T12:00:00.000Z");
    const repeated = markDraftSubmitted(first, "receipt-2", "2026-08-08T12:01:00.000Z");

    expect(first.receipt).toEqual({
      id: "receipt-1",
      submittedAt: "2026-08-08T12:00:00.000Z",
    });
    expect(repeated).toBe(first);
  });
  it("clears the completed draft pointer and legacy browser state before a new session", () => {
    const values = new Map<string, string>([
      [getCfpDraftStorageKey("future-conf"), JSON.stringify(createEmptyDraft("future-conf"))],
      [
        getCfpSubmissionPointerStorageKey("org-1", "future-conf", "future-conf-cfp"),
        "submission_completed",
      ],
    ]);
    const storage = {
      removeItem(key: string) {
        values.delete(key);
      },
    };

    clearCfpSubmissionState(
      "future-conf",
      { organizationId: "org-1", eventId: "future-conf", formId: "future-conf-cfp" },
      storage,
    );

    expect(values).toEqual(new Map());
  });
  it("ignores a stale completion without releasing a newer save", () => {
    const gate = new CfpMutationGate();
    const first = gate.begin();
    expect(first).not.toBeNull();
    expect(gate.begin()).toBeNull();

    gate.invalidate();
    const second = gate.begin();
    expect(second).not.toBeNull();
    if (first === null || second === null) throw new Error("The mutation leases were not created.");

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);

    gate.finish(first);
    expect(gate.isActive()).toBe(true);
    gate.finish(second);
    expect(gate.isActive()).toBe(false);
  });
});
