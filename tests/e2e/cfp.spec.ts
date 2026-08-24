import type { Request } from "@playwright/test";
import { E2E_SESSION_COOKIE, type E2eAuthSession, expect, test } from "./fixtures/auth";
import { installCfpApi } from "./fixtures/cfp-api";

test.use({ authRole: "submitter" });
const EVALUATOR_CFP_PATH = "/cfp/organizations/evaluator-org/events/evaluator-2026";

test("participant-only accounts enter CFP without organizer context controls", async ({
  page,
  authSession,
}) => {
  await installCfpApi(page, authSession, {
    eventId: "participant-context",
    initiallyAuthenticated: true,
    memberships: [],
  });

  await page.goto("/cfp/organizations/evaluator-org/events/participant-context/account");

  await expect(page.locator("[data-cfp-applicant-context-boundary]")).toHaveCount(0);
  await expect(page.locator('a[href="/admin"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue to proposal" })).toBeEnabled();
});

test("welcome enters Account without claiming or creating a draft", async ({
  page,
  authSession,
}) => {
  const eventId = "welcome-navigation";
  await installCfpApi(page, authSession, {
    eventId,
    initiallyAuthenticated: true,
    memberships: [],
  });
  const mutationRequests: Request[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/cfp/") && request.method() !== "GET") {
      mutationRequests.push(request);
    }
  });

  await page.goto(`/cfp/organizations/evaluator-org/events/${eventId}`);
  const continueLink = page.getByRole("link", { name: "Continue →" });
  await expect(continueLink).toHaveAttribute(
    "href",
    `/cfp/organizations/evaluator-org/events/${eventId}/account`,
  );
  await expect(page.getByText("Draft saved", { exact: true })).toHaveCount(0);

  await Promise.all([
    page.waitForURL(new RegExp(`/cfp/organizations/evaluator-org/events/${eventId}/account$`)),
    continueLink.click(),
  ]);

  expect(mutationRequests).toEqual([]);
  await expect(page.getByRole("button", { name: "Continue to proposal" })).toBeEnabled();
});

test("authenticated Account continuation stays locked while the draft opens", async ({
  page,
  authSession,
}) => {
  let releaseDraftCreation!: () => void;
  const draftCreationGate = new Promise<void>((resolve) => {
    releaseDraftCreation = resolve;
  });
  let signalDraftCreation!: () => void;
  const draftCreationStarted = new Promise<void>((resolve) => {
    signalDraftCreation = resolve;
  });
  const harness = await installCfpApi(page, authSession, {
    eventId: "authenticated-pending-context",
    initiallyAuthenticated: true,
    memberships: [],
  });
  await page.route("**/api/cfp/**", async (route) => {
    if (route.request().method() !== "GET") {
      signalDraftCreation();
      await draftCreationGate;
    }
    await route.fallback();
  });

  const accountPath =
    "/cfp/organizations/evaluator-org/events/authenticated-pending-context/account";
  const submissionPath =
    "/cfp/organizations/evaluator-org/events/authenticated-pending-context/submission";
  await page.goto(accountPath);
  await page.getByRole("checkbox", { name: /I agree to the Terms of Service/ }).check();
  const submit = page.getByRole("button", { name: "Continue to proposal" }).click();
  await draftCreationStarted;
  await expect(page.getByRole("button", { name: "Continuing…" })).toBeDisabled();
  const pointerKey = `eventloom:cfp-submission:v1:evaluator-org:authenticated-pending-context:${encodeURIComponent(harness.form.id)}`;
  const activeKey = `eventloom:cfp-active-submission:v1:evaluator-org:authenticated-pending-context:${encodeURIComponent(harness.form.id)}`;
  await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
    key: pointerKey,
    value: "submission-selected-in-other-tab",
  });

  const submissionNavigation = page.waitForURL(new RegExp(`${submissionPath}$`));
  releaseDraftCreation();
  await submit;
  await submissionNavigation;
  expect(await page.evaluate((key) => window.localStorage.getItem(key), pointerKey)).toBe(
    "submission-selected-in-other-tab",
  );
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), activeKey)).toBe(
    harness.submission.id,
  );
});

test("current-organization organizers confirm the CFP applicant context", async ({
  page,
  authSession,
}) => {
  await installCfpApi(page, authSession, {
    eventId: "organizer-context",
    initiallyAuthenticated: true,
    memberships: [{ organizationId: "evaluator-org", role: "owner" }],
  });

  await page.goto("/cfp/organizations/evaluator-org/events/organizer-context/account");

  const boundary = page.locator("[data-cfp-applicant-context-boundary]");
  await expect(boundary).toBeVisible();
  await expect(page.locator('a[href="/admin"]')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
  await boundary.locator("[data-cfp-applicant-context-confirm]").click();
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
});

async function selectSearchable(
  page: import("@playwright/test").Page,
  label: string,
  option: string,
): Promise<void> {
  const combobox = page.getByRole("combobox", { name: label });
  await combobox.fill(option);
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(combobox).toHaveValue(option);
}
interface CfpPortalHandoffHarness {
  selectedEventIds: string[];
}

async function installCfpPortalHandoffApi(
  page: import("@playwright/test").Page,
  session: E2eAuthSession,
  submittedEventId: string,
  submissionId: string,
): Promise<CfpPortalHandoffHarness> {
  const participantId = "participant-cfp-handoff";
  const alternateEventId = "event-alternate-authorized";
  const matchingContext = {
    id: `portal:ai-engineer:${submittedEventId}`,
    eventId: submittedEventId,
    name: "Submitted CFP Event",
    capabilities: ["profile-self"],
    submissionIds: [submissionId],
    participantIds: [participantId],
    primaryParticipantId: participantId,
  };
  const alternateContext = {
    id: `portal:ai-engineer:${alternateEventId}`,
    eventId: alternateEventId,
    name: "Alternate Authorized Event",
    capabilities: ["profile-self"],
    submissionIds: [],
    participantIds: ["participant-alternate"],
    primaryParticipantId: "participant-alternate",
  };
  const viewFor = (context: typeof matchingContext) => ({
    submissions:
      context.eventId === submittedEventId
        ? [
            {
              id: submissionId,
              eventId: submittedEventId,
              title: "Submitted CFP session",
              status: "submitted",
              participantIds: [participantId],
              updatedAt: "2026-08-08T13:05:00.000Z",
            },
          ]
        : [],
    profiles: [
      {
        id: `profile-${context.eventId}`,
        eventId: context.eventId,
        participantId: context.primaryParticipantId,
        displayName: context.eventId === submittedEventId ? "Ada Speaker" : "Alternate Speaker",
        biography: "",
        version: 1,
        updatedAt: "2026-08-08T13:05:00.000Z",
      },
    ],
    tasks: [],
    outstandingTaskCount: 0,
    context,
    capabilities: context.capabilities,
  });
  const selectedEventIds: string[] = [];
  await page.route("**/api/speaker/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.headers().cookie?.includes(`${E2E_SESSION_COOKIE}=${session.token}`) !== true) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "AUTHENTICATION_REQUIRED" } }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/speaker/portal/contexts") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [alternateContext, matchingContext] }),
      });
      return;
    }
    const portalPath = url.pathname.match(/^\/api\/speaker\/events\/([^/]+)\/portal$/u);
    if (request.method() === "GET" && portalPath) {
      const eventId = decodeURIComponent(portalPath[1] ?? "");
      selectedEventIds.push(eventId);
      const context =
        eventId === submittedEventId
          ? matchingContext
          : eventId === alternateEventId
            ? alternateContext
            : null;
      if (!context) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "NOT_FOUND" } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: viewFor(context) }),
      });
      return;
    }
    await route.fallback();
  });
  return { selectedEventIds };
}

test("switching Account modes clears rejected authentication errors", async ({
  page,
  authSession,
}) => {
  await installCfpApi(page, authSession, {
    eventId: "evt_evaluator_2026",
    eventSlug: "evaluator-2026",
    formId: "evaluator-2026-cfp",
  });
  await page.route(/\/api\/auth\/sign-(?:in|up)\/email$/u, async (route) => {
    const action = route.request().url().includes("/sign-up/") ? "sign-up" : "sign-in";
    await route.fulfill({
      body: JSON.stringify({
        code: "INVALID_CREDENTIALS",
        message: `Rejected synthetic ${action}.`,
      }),
      contentType: "application/json",
      status: 401,
    });
  });

  await page.goto(`${EVALUATOR_CFP_PATH}/account`);
  await page.getByLabel("Email address").fill("rejected@example.test");
  await page.getByLabel("Password").fill("StrongPass1!");
  await page.getByRole("button", { name: "Sign in and continue" }).click();
  await expect(page.getByText("Rejected synthetic sign-in.", { exact: true })).toBeVisible();

  await page.locator('[data-cfp-account-mode="sign_up"]').click();
  await expect(page.locator('p[aria-live="polite"]')).toHaveText("");
  await page.getByLabel("First name").fill("Rejected");
  await page.getByLabel("Last name").fill("Applicant");
  await page.getByRole("checkbox", { name: /I agree to the Terms of Service/ }).check();
  await page.getByRole("button", { name: "Create account and continue" }).click();
  await expect(page.getByText("Rejected synthetic sign-up.", { exact: true })).toBeVisible();

  await page.locator('[data-cfp-account-mode="sign_in"]').click();
  await expect(page.locator('p[aria-live="polite"]')).toHaveText("");
});

test("account access mode stays locked while authentication is pending", async ({
  page,
  authSession,
}) => {
  let releaseAuthentication!: () => void;
  const authenticationGate = new Promise<void>((resolve) => {
    releaseAuthentication = resolve;
  });
  await installCfpApi(page, authSession, {
    eventId: "evt_evaluator_2026",
    eventSlug: "evaluator-2026",
    formId: "evaluator-2026-cfp",
  });
  await page.route("**/api/auth/sign-in/email", async (route) => {
    await authenticationGate;
    await route.fallback();
  });

  await page.goto(`${EVALUATOR_CFP_PATH}/account`);
  await page.getByLabel("Email address").fill("pending@example.test");
  await page.getByLabel("Password").fill("StrongPass1!");
  const requestStarted = page.waitForRequest("**/api/auth/sign-in/email");
  const submit = page.getByRole("button", { name: "Sign in and continue" }).click();
  await requestStarted;

  await expect(page.locator('[data-cfp-account-mode="sign_in"]')).toBeDisabled();
  await expect(page.locator('[data-cfp-account-mode="sign_up"]')).toBeDisabled();
  await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();

  const submissionNavigation = page.waitForURL(new RegExp(`${EVALUATOR_CFP_PATH}/submission$`));
  releaseAuthentication();
  await submit;
  await submissionNavigation;
});

test("submitter completes the account-first CFP with two participants", async ({
  page,
  authSession,
}) => {
  test.setTimeout(60_000);
  await installCfpApi(page, authSession, {
    eventId: "evt_evaluator_2026",
    eventSlug: "evaluator-2026",
    formId: "evaluator-2026-cfp",
  });
  const portalHandoff = await installCfpPortalHandoffApi(
    page,
    authSession,
    "evt_evaluator_2026",
    "submission-evt_evaluator_2026-e2e",
  );
  await page.goto(EVALUATOR_CFP_PATH);

  await expect(
    page.getByRole("heading", { level: 1, name: "Welcome to our event!" }),
  ).toBeVisible();
  const continueButton = page.getByRole("link", { name: "Continue →" });
  await continueButton.focus();
  await expect(continueButton).toBeFocused();
  await Promise.all([
    page.waitForURL(new RegExp(`${EVALUATOR_CFP_PATH}/account$`)),
    continueButton.press("Enter"),
  ]);

  const accountAccess = page.locator('[data-cfp-account-access="true"]');
  const existingAccount = page.locator('[data-cfp-account-mode="sign_in"]');
  const createAccount = page.locator('[data-cfp-account-mode="sign_up"]');
  const accountEmail = page.getByLabel("Email address");
  const accountPassword = page.getByLabel("Password");
  const accountActions = page.locator('[data-cfp-actions="true"]');
  const accountForm = page.locator('[data-cfp-account-form="true"]');

  await expect(accountAccess).toBeVisible();
  await expect(accountAccess).toHaveAccessibleName("Account access");
  await expect(accountActions).toBeVisible();
  await expect(accountForm).toBeVisible();
  const accountMeasure = await page
    .locator("[data-cfp-main-flow]")
    .evaluate((mainFlow, formSelector) => {
      const form = mainFlow.querySelector<HTMLElement>(formSelector);
      if (!form) return null;
      const mainRect = mainFlow.getBoundingClientRect();
      const formRect = form.getBoundingClientRect();
      return {
        centerDelta: Math.abs(
          mainRect.left + mainRect.width / 2 - (formRect.left + formRect.width / 2),
        ),
        width: formRect.width,
      };
    }, '[data-cfp-account-form="true"]');
  expect(accountMeasure).not.toBeNull();
  expect(accountMeasure?.centerDelta).toBeLessThanOrEqual(1);
  expect(accountMeasure?.width).toBeLessThanOrEqual(672);
  await expect(page.locator('[data-cfp-session-footer="true"]')).toHaveCount(0);
  await expect
    .poll(async () =>
      accountActions.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backdropFilter: style.backdropFilter,
          boxShadow: style.boxShadow,
          position: style.position,
        };
      }),
    )
    .toEqual({
      backdropFilter: "none",
      boxShadow: "none",
      position: "static",
    });
  await expect(existingAccount).toHaveAttribute("data-state", "on");
  await accountEmail.fill("ada@example.test");
  await accountPassword.fill("CalmSystems!26");
  await existingAccount.focus();
  await existingAccount.press("ArrowRight");
  await expect(createAccount).toBeFocused();
  await createAccount.press("Space");
  await expect(createAccount).toHaveAttribute("data-state", "on");
  await expect(accountEmail).toHaveValue("ada@example.test");
  await expect(accountPassword).toHaveValue("CalmSystems!26");
  await expect(accountPassword).toHaveAttribute("autocomplete", "new-password");
  await page.getByRole("button", { name: "Create account and continue" }).click();
  await expect(page.getByLabel("First name")).toBeFocused();
  await expect(page.getByLabel("First name")).toHaveAttribute("aria-invalid", "true");

  await existingAccount.focus();
  await existingAccount.press("Space");
  await expect(existingAccount).toHaveAttribute("data-state", "on");
  await expect(page.getByLabel("First name")).toHaveCount(0);
  await expect(page.getByText("First name is required.", { exact: true })).toHaveCount(0);
  await expect(accountEmail).toHaveValue("ada@example.test");
  await expect(accountPassword).toHaveValue("CalmSystems!26");

  await existingAccount.press("ArrowRight");
  await expect(createAccount).toBeFocused();
  await createAccount.press("Space");
  await expect(createAccount).toHaveAttribute("data-state", "on");
  await expect(page.getByLabel("First name")).not.toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("First name").fill("Ada");
  await page.getByLabel("Last name").fill("Speaker");
  await page.getByRole("checkbox", { name: /I agree to the Terms of Service/ }).check();
  await Promise.all([
    page.waitForURL(new RegExp(`${EVALUATOR_CFP_PATH}/submission$`)),
    page.getByRole("button", { name: "Create account and continue" }).click(),
  ]);

  await page.getByLabel("Title").fill("Designing calm incident response");
  await page
    .getByLabel("Description")
    .fill(
      "A practical, evidence-led approach to building resilient teams before an incident begins.",
    );
  await selectSearchable(page, "Format", "Breakout Session");
  const tagsSearch = page.getByLabel("Search Tags options");
  await tagsSearch.fill("Leadership");
  const leadershipTag = page.getByRole("option", { name: "Leadership", exact: true });
  await leadershipTag.click();
  await expect(tagsSearch).toHaveValue("");
  await selectSearchable(page, "Track", "Track 2");
  await selectSearchable(page, "Level", "Advanced");
  await selectSearchable(page, "Language", "English");
  await Promise.all([
    page.waitForURL(new RegExp(`${EVALUATOR_CFP_PATH}/participants$`)),
    page.getByRole("button", { name: "Next step →" }).click(),
  ]);

  await expect(page.getByLabel("First Name").first()).toHaveValue("Ada");
  await expect(page.getByLabel("Last Name").first()).toHaveValue("Speaker");
  await expect(page.getByLabel("Email").first()).toHaveValue("ada@example.test");
  await page.getByLabel("Biography").first().fill("Staff engineer and resilient-systems educator.");
  await page.getByRole("button", { name: "＋ Add participant" }).click();
  await page.getByLabel("First Name").nth(1).fill("Grace");
  await page.getByLabel("Last Name").nth(1).fill("Cooper");
  await page.getByLabel("Email").nth(1).fill("grace@example.test");
  await page.getByLabel("Biography").nth(1).fill("Engineering leader and incident facilitator.");
  await Promise.all([
    page.waitForURL(new RegExp(`${EVALUATOR_CFP_PATH}/review$`)),
    page.getByRole("button", { name: "Continue to review →" }).click(),
  ]);

  await expect(
    page.getByRole("heading", { level: 1, name: "Review your submission" }),
  ).toBeVisible();
  await expect(page.getByText("Designing calm incident response", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: /Ada Speaker/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: /Grace Cooper/ })).toBeVisible();
  await Promise.all([
    page.waitForURL(new RegExp(`${EVALUATOR_CFP_PATH}/complete$`)),
    page.getByRole("button", { name: "Submit", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Submission received: Designing calm incident response",
    }),
  ).toBeVisible();
  await expect(page.getByText("Your proposal has been received.", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Thank you for contributing to the program.", { exact: true }),
  ).toBeVisible();

  const statusDashboard = page.getByRole("button", { name: "View submission" });
  await Promise.all([
    page.waitForURL(/\/portal\/submissions\?event=evt_evaluator_2026$/),
    statusDashboard.click(),
  ]);
  await expect(page.getByRole("heading", { level: 1, name: "Submissions" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Event context" })).toHaveValue(
    "portal:ai-engineer:evt_evaluator_2026",
  );
  expect(portalHandoff.selectedEventIds).toEqual(["evt_evaluator_2026"]);

  await page.goto("/portal/submissions?event=event-not-authorized");
  await expect(page.getByRole("heading", { level: 1, name: "Submissions" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Event context" })).toHaveValue(
    "portal:ai-engineer:event-alternate-authorized",
  );
  expect(portalHandoff.selectedEventIds).toEqual([
    "evt_evaluator_2026",
    "event-alternate-authorized",
  ]);
  expect(portalHandoff.selectedEventIds).not.toContain("event-not-authorized");

  const browserState = await page.evaluate(() => ({
    pointer: window.localStorage.getItem(
      "eventloom:cfp-submission:v1:evaluator-org:evt_evaluator_2026:evaluator-2026-cfp",
    ),
    legacyDraft: window.localStorage.getItem("open-sessionboard:cfp-draft:v1:evaluator-2026"),
    completionHandoff: window.sessionStorage.getItem(
      "eventloom:cfp-completion:v1:evaluator-org:evt_evaluator_2026:evaluator-2026-cfp",
    ),
  }));
  expect(browserState.pointer).toBeNull();
  expect(browserState.completionHandoff).toMatch(/^submission[_-]/);
  expect(browserState.legacyDraft).toBeNull();
  await page.goto(`${EVALUATOR_CFP_PATH}/complete`);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Submission received: Designing calm incident response",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Submit another session" }).click();
  await expect(page).toHaveURL(new RegExp(`${EVALUATOR_CFP_PATH}$`));
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem(
          "eventloom:cfp-submission:v1:evaluator-org:evt_evaluator_2026:evaluator-2026-cfp",
        ),
      ),
    )
    .toBeNull();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.sessionStorage.getItem(
          "eventloom:cfp-completion:v1:evaluator-org:evt_evaluator_2026:evaluator-2026-cfp",
        ),
      ),
    )
    .toBeNull();
});
test("new submitter returns from email verification and continues automatically", async ({
  page,
  authSession,
}) => {
  await installCfpApi(page, authSession, {
    eventId: "verification-return",
    formId: "verification-return-cfp",
    eventName: "Verification Return Test Event",
  });
  const email = "averylongunbrokeneverificationaddress@example.test";
  let verified = false;
  let callbackUrl: string | null = null;
  await page.route("**/api/auth/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname.endsWith("/get-session")) {
      if (!verified) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ code: "AUTHENTICATION_REQUIRED" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session: { id: "verified-session", userId: "verified-user" },
          user: {
            id: "verified-user",
            email,
            name: "Verified Speaker",
            emailVerified: true,
          },
        }),
      });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/sign-in/email")) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD" }),
      });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/sign-up/email")) {
      const body: unknown = request.postDataJSON();
      callbackUrl =
        typeof body === "object" &&
        body !== null &&
        "callbackURL" in body &&
        typeof body.callbackURL === "string"
          ? body.callbackURL
          : null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "verified-user",
            email,
            name: "Verified Speaker",
            emailVerified: false,
          },
        }),
      });
      return;
    }
    await route.fallback();
  });

  const accountPath = "/cfp/organizations/evaluator-org/events/verification-return/account";
  await page.goto(accountPath);
  await page.getByLabel("Email address").fill(email);
  await page.locator('[data-cfp-account-mode="sign_up"]').click();
  await page.getByLabel("Password").fill("StrongPass1!");
  await page.getByLabel("First name").fill("Verified");
  await page.getByLabel("Last name").fill("Speaker");
  await page.getByRole("checkbox", { name: /I agree to the Terms of Service/ }).check();
  await Promise.all([
    expect(page.getByRole("heading", { level: 1, name: "Check your inbox" })).toBeVisible(),
    page.getByRole("button", { name: "Create account and continue" }).click(),
  ]);
  await expect(page.locator('[data-cfp-session-footer="true"]')).toHaveCount(0);
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(
    page.getByText("After verification, you’ll return here and continue automatically.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("[data-local-mail-inbox]")).toHaveAttribute(
    "href",
    "http://127.0.0.1:8025/",
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "Check the highlighted fields." }),
  ).toHaveCount(0);
  expect(callbackUrl).not.toBeNull();
  const verificationReturn = new URL(callbackUrl ?? "http://invalid.test");
  expect(verificationReturn.searchParams.get("cfpVerification")).toBe("complete");

  verified = true;
  await page.goto(verificationReturn.toString());
  await expect(page).toHaveURL(
    /\/cfp\/organizations\/evaluator-org\/events\/verification-return\/submission$/,
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Tell us about your submission" }),
  ).toBeVisible();
});
test("CFP shell reflows without clipping and exposes the current step", async ({
  page,
  authSession,
}, testInfo) => {
  await installCfpApi(page, authSession, {
    eventId: "mobile-progress",
    formId: "mobile-progress-cfp",
    eventName: "Mobile Progress Test Event",
  });
  await page.setViewportSize({ height: 900, width: 900 });
  await page.goto("/cfp/organizations/evaluator-org/events/mobile-progress");

  const progressNavigations = page.getByRole("navigation", { name: "Submission progress" });
  const submissionWindow = page.locator('[data-cfp-submission-window="true"]');
  await expect(progressNavigations).toHaveCount(1);
  await expect(progressNavigations).toBeVisible();
  await expect(submissionWindow).toHaveCount(1);
  await expect(
    page.locator('[data-cfp-context-rail] [data-cfp-submission-window="true"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-cfp-main-flow] [data-cfp-submission-window="true"]'),
  ).toHaveCount(1);
  const summaryWidth = await submissionWindow
    .locator('[data-cfp-window-summary="true"]')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(summaryWidth).toBeGreaterThan(280);
  await expect(progressNavigations.getByText("Get started", { exact: true })).toBeVisible();
  await expect(progressNavigations.getByText("Review", { exact: true })).toBeVisible();
  await expect(progressNavigations.locator('[aria-current="step"]')).toHaveCount(1);
  const formWhitespace = await page.locator("form").evaluate((form) => {
    const parent = form.parentElement;
    if (parent === null) throw new Error("The CFP form column is unavailable.");
    const formRect = form.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    return {
      left: formRect.left - parentRect.left,
      right: parentRect.right - formRect.right,
    };
  });
  expect(Math.abs(formWhitespace.left - formWhitespace.right)).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
        document.body.scrollWidth <= document.body.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("applicant-cfp-shell-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ height: 844, width: 390 });
  const compactProgress = page.getByRole("navigation", { name: "Submission progress" });
  await expect(compactProgress).toBeVisible();
  await expect(compactProgress.getByText("Step 1 of 5", { exact: true })).toBeVisible();
  const currentCompactStep = compactProgress.locator('[aria-current="step"]');
  await expect(currentCompactStep).toHaveCount(1);
  await expect(currentCompactStep).toContainText("Get started");
  for (const value of await submissionWindow
    .locator("[data-cfp-window-date-group], [data-cfp-window-clock-group]")
    .all()) {
    await expect(value).toHaveCSS("white-space", "nowrap");
  }

  const fitsViewport = await page.evaluate(
    () =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      document.body.scrollWidth <= document.body.clientWidth,
  );
  expect(fitsViewport).toBe(true);

  const continueButton = page.getByRole("link", { name: "Continue →" });
  await Promise.all([
    page.waitForURL(/\/cfp\/organizations\/evaluator-org\/events\/mobile-progress\/account$/),
    continueButton.click(),
  ]);
  const existingAccount = page.locator('[data-cfp-account-mode="sign_in"]');
  const createAccount = page.locator('[data-cfp-account-mode="sign_up"]');
  const backButton = page.getByRole("button", { name: "← Back" });
  const primaryButton = page.getByRole("button", { name: "Sign in and continue" });
  const mobileOrder = await Promise.all([
    existingAccount.boundingBox(),
    createAccount.boundingBox(),
    backButton.boundingBox(),
    primaryButton.boundingBox(),
  ]);
  expect(mobileOrder.every((box) => box !== null)).toBe(true);
  expect(mobileOrder[1]?.y).toBeGreaterThan(mobileOrder[0]?.y ?? 0);
  expect(mobileOrder[3]?.y).toBeGreaterThan(mobileOrder[2]?.y ?? 0);

  await page.setViewportSize({ height: 1000, width: 1280 });
  await page.screenshot({
    path: testInfo.outputPath("applicant-cfp-account-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Choose color theme" }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/u);
  await page.screenshot({
    path: testInfo.outputPath("applicant-cfp-account-desktop-dark.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Choose color theme" }).click();
  await page.getByRole("menuitemradio", { name: "Light" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/u);

  await page.setViewportSize({ height: 720, width: 320 });
  const textZoomStyle = await page.addStyleTag({
    content: "html { font-size: 200% !important; }",
  });
  const zoomedPageFits = await page.evaluate(
    () =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      document.body.scrollWidth <= document.body.clientWidth,
  );
  expect(zoomedPageFits).toBe(true);
  await textZoomStyle.evaluate((element) => element.remove());

  await page.setViewportSize({ height: 844, width: 390 });
  const mutatingRequests: string[] = [];
  const recordMutatingRequest = (request: Request) => {
    const url = new URL(request.url());
    if (
      request.method() !== "GET" &&
      (url.pathname.startsWith("/api/auth/") || url.pathname.includes("/submissions"))
    ) {
      mutatingRequests.push(`${request.method()} ${url.pathname}`);
    }
  };
  page.on("request", recordMutatingRequest);
  await Promise.all([
    page.waitForURL(/\/cfp\/organizations\/evaluator-org\/events\/mobile-progress$/),
    backButton.click(),
  ]);
  page.off("request", recordMutatingRequest);
  expect(mutatingRequests).toEqual([]);

  await page.addStyleTag({
    content:
      "@media (max-width: 48rem) { html, body, #cfp-main { height: auto !important; max-height: none !important; overflow: visible !important; } }",
  });
  const expandWorkspaceForScreenshot = async () => {
    await page.locator("#cfp-main").evaluate((main) => {
      main.style.height = `${main.scrollHeight}px`;
      let ancestor = main.parentElement;
      while (ancestor && ancestor !== document.body) {
        ancestor.style.height = "auto";
        ancestor.style.maxHeight = "none";
        ancestor.style.overflow = "visible";
        ancestor = ancestor.parentElement;
      }
      document.documentElement.style.height = "auto";
      document.body.style.height = "auto";
    });
  };
  await expandWorkspaceForScreenshot();
  await page.screenshot({
    path: testInfo.outputPath("applicant-cfp-shell-mobile.png"),
    fullPage: true,
  });
  await Promise.all([
    page.waitForURL(/\/cfp\/organizations\/evaluator-org\/events\/mobile-progress\/account$/),
    continueButton.click(),
  ]);
  await expandWorkspaceForScreenshot();
  await page.screenshot({
    path: testInfo.outputPath("applicant-cfp-account-mobile.png"),
    fullPage: true,
  });
});

test("required CFP validation announces errors and focuses the first invalid field", async ({
  page,
  authSession,
}) => {
  await installCfpApi(page, authSession, {
    eventId: "validation-check",
    formId: "validation-check-cfp",
    eventName: "Validation Check Event",
  });
  await page.goto("/cfp/organizations/evaluator-org/events/validation-check/account");
  await page.getByRole("button", { name: "Sign in and continue" }).click();

  const errorSummary = page.getByRole("alert").filter({ hasText: "Check the highlighted fields." });
  await expect(errorSummary).toBeVisible();
  await expect(errorSummary).toContainText("Email address is required.");
  await expect(page.getByLabel("Email address")).toBeFocused();
  await expect(page.getByLabel("Email address")).toHaveAttribute("aria-invalid", "true");
});

test("CFP draft survives a reload without submitting", async ({ page, authSession }) => {
  await installCfpApi(page, authSession, {
    eventId: "resume-check",
    formId: "resume-check-cfp",
    eventName: "Resume Draft Test Event",
  });
  await page.goto("/cfp/organizations/evaluator-org/events/resume-check/account");
  await expect(page.getByRole("button", { name: "Save as draft" })).toHaveCount(0);
  await page.getByLabel("Email address").fill("resume@example.test");
  await page.locator('[data-cfp-account-mode="sign_up"]').click();
  await page.getByLabel("Password").fill("ResumeDraft!26");
  await page.getByLabel("First name").fill("Resilient");
  await page.getByLabel("Last name").fill("Speaker");
  await page.getByRole("checkbox", { name: /I agree to the Terms of Service/ }).check();
  await Promise.all([
    page.waitForURL(/\/resume-check\/submission$/),
    page.getByRole("button", { name: "Create account and continue" }).click(),
  ]);
  await page.getByLabel("Title").fill("A persisted draft title");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Title")).toHaveValue("A persisted draft title");
});
const CFP_ORGANIZATION_ID = "ai-engineer";
const CFP_EVENT_ID = "open-sessionboard-conf";
const CFP_FORM_ID = "main-cfp";
const CFP_FORM_VERSION = 4;
const CFP_SUBMISSION_ID = "submission-cfp-e2e";
const CFP_UPDATED_AT = "2026-08-08T12:00:00.000Z";
const CFP_PATH = `/cfp/organizations/${CFP_ORGANIZATION_ID}/events/${CFP_EVENT_ID}`;

const CFP_ORGANIZATION = {
  id: CFP_ORGANIZATION_ID,
  slug: CFP_ORGANIZATION_ID,
  name: "AI Engineer",
} as const;

const CFP_EVENT = {
  id: CFP_EVENT_ID,
  slug: CFP_EVENT_ID,
  name: "Eventloom Conference",
  timezone: "America/Los_Angeles",
  opensAt: "2026-08-01T07:00:00.000Z",
  closesAt: "2026-09-15T07:00:00.000Z",
} as const;

const CFP_FORM = {
  id: CFP_FORM_ID,
  name: "Conference call for speakers",
  version: CFP_FORM_VERSION,
  status: "published",
  welcomeContent: "Share the session you want to bring to our community.",
  settings: {
    speakerLimit: 3,
    maxSubmissionsPerAccount: 3,
    confirmationMessage: "Your proposal has been received.",
    successContent: "Thank you for contributing to the program.",
  },
  sections: [
    {
      id: "session",
      title: "Session proposal",
      description: "Tell us about the proposed session.",
    },
    {
      id: "workshop",
      title: "Workshop details",
      description: "These details are shown for workshop proposals.",
    },
    {
      id: "people",
      title: "Speakers",
      description: "Add the people presenting the session.",
    },
  ],
  submissionFields: [
    {
      id: "field-title",
      sectionId: "session",
      key: "title",
      label: "Session title",
      kind: "text",
      required: true,
      options: [],
      fieldRef: { id: "shared-session-title", version: 3 },
    },
    {
      id: "field-abstract",
      sectionId: "session",
      key: "abstract",
      label: "Abstract",
      kind: "rich_text",
      required: true,
      options: [],
    },
    {
      id: "field-format",
      sectionId: "session",
      key: "format",
      label: "Session format",
      kind: "select",
      required: true,
      options: ["Talk", "Workshop", "Panel"],
    },
    {
      id: "field-track",
      sectionId: "session",
      key: "track",
      label: "Track",
      kind: "select",
      required: true,
      options: ["Platform", "Community", "Operations"],
    },
    {
      id: "field-topics",
      sectionId: "session",
      key: "topics",
      label: "Topics",
      kind: "multi_select",
      required: false,
      options: ["Reliability", "Accessibility", "Leadership"],
    },
    {
      id: "field-audience",
      sectionId: "workshop",
      key: "audience",
      label: "Workshop audience",
      kind: "text",
      required: true,
      options: [],
    },
    {
      id: "field-slides",
      sectionId: "workshop",
      key: "slides",
      label: "Final slides",
      kind: "file_request",
      required: true,
      options: [],
      fileRequest: {
        allowedMimeTypes: ["application/pdf"],
        maxBytes: 1_048_576,
        required: true,
        owner: "submission",
      },
    },
  ],
  participantFields: [
    {
      id: "participant-first-name",
      sectionId: "people",
      key: "firstName",
      label: "First name",
      kind: "text",
      required: true,
      options: [],
    },
    {
      id: "participant-last-name",
      sectionId: "people",
      key: "lastName",
      label: "Last name",
      kind: "text",
      required: true,
      options: [],
    },
    {
      id: "participant-email",
      sectionId: "people",
      key: "email",
      label: "Email",
      kind: "email",
      required: true,
      options: [],
    },
    {
      id: "participant-type",
      sectionId: "people",
      key: "participantType",
      label: "Participant type",
      kind: "select",
      required: true,
      options: ["Individual", "Company"],
    },
    {
      id: "participant-company",
      sectionId: "people",
      key: "participantCompany",
      label: "Company",
      kind: "text",
      required: false,
      options: [],
    },
    {
      id: "participant-biography",
      sectionId: "people",
      key: "biography",
      label: "Biography",
      kind: "rich_text",
      required: false,
      options: [],
    },
  ],
  rules: [
    {
      id: "hide-workshop",
      priority: 1,
      when: {
        type: "group",
        operator: "all",
        conditions: [
          { type: "predicate", fieldKey: "format", operator: "not_equals", value: "Workshop" },
        ],
      },
      actions: [
        { type: "hide_section", sectionId: "workshop" },
        { type: "hide_field", fieldKey: "audience" },
        { type: "hide_field", fieldKey: "slides" },
      ],
    },
    {
      id: "show-workshop",
      priority: 2,
      when: {
        type: "group",
        operator: "all",
        conditions: [
          { type: "predicate", fieldKey: "format", operator: "equals", value: "Workshop" },
        ],
      },
      actions: [
        { type: "show_section", sectionId: "workshop" },
        { type: "show_field", fieldKey: "audience" },
        { type: "show_field", fieldKey: "slides" },
      ],
    },
    {
      id: "hide-company",
      priority: 1,
      when: {
        type: "group",
        operator: "all",
        conditions: [
          {
            type: "predicate",
            fieldKey: "participantType",
            operator: "not_equals",
            value: "Company",
          },
        ],
      },
      actions: [{ type: "hide_field", fieldKey: "participantCompany" }],
    },
    {
      id: "show-company",
      priority: 2,
      when: {
        type: "group",
        operator: "all",
        conditions: [
          {
            type: "predicate",
            fieldKey: "participantType",
            operator: "equals",
            value: "Company",
          },
        ],
      },
      actions: [{ type: "show_field", fieldKey: "participantCompany" }],
    },
  ],
} as const;

interface DynamicCfpParticipant {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: "primary" | "co_speaker";
  biography: string;
  answers: Record<string, unknown>;
}

interface DynamicCfpSubmission {
  id: string;
  tenantId: string;
  eventId: string;
  formId: string;
  ownerAccountId: string;
  formVersion: number;
  version: number;
  status: "draft" | "submitted" | "withdrawn";
  completedSteps: string[];
  answers: Record<string, unknown>;
  participants: DynamicCfpParticipant[];
  secondaryContacts: Array<{ id: string; name: string; email: string }>;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
}

interface DynamicCfpHarness {
  requests: Array<import("@playwright/test").Request>;
  publishedResponses: Array<{
    organization: typeof CFP_ORGANIZATION;
    event: typeof CFP_EVENT;
    form: typeof CFP_FORM;
  }>;
  submission: DynamicCfpSubmission;
  receiptRequests: Array<import("@playwright/test").Request>;
  draftLoads: Array<import("@playwright/test").Request>;
}

interface DynamicCfpHarnessOptions {
  stalePointer?: boolean;
  unauthorizedPointerOnce?: boolean;
  unauthenticatedStartup?: boolean;
  unauthorizedPointerAlways?: boolean;
  conflictOnDraftPatch?: number;
  initialAnswers?: Record<string, unknown>;
  withdrawnPointer?: boolean;
  replacementPointer?: string;
}

function cfpRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cloneCfp<T>(value: T): T {
  return structuredClone(value);
}

async function fulfillCfpJson(
  route: import("@playwright/test").Route,
  data: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,idempotency-key",
      "access-control-allow-methods": "GET,PATCH,POST,PUT,OPTIONS",
      "access-control-allow-origin": "http://127.0.0.1:3015",
    },
    body: JSON.stringify({ data }),
  });
}

function cfpErrorBody(code: string, message: string): string {
  return JSON.stringify({ error: { code, message, traceId: "trace-cfp-e2e" } });
}
async function fulfillCfpConflict(
  route: import("@playwright/test").Route,
  message = "The CFP submission has changed.",
): Promise<void> {
  await route.fulfill({
    status: 409,
    contentType: "application/json",
    headers: {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,idempotency-key",
      "access-control-allow-methods": "GET,PATCH,POST,PUT,OPTIONS",
      "access-control-allow-origin": "http://127.0.0.1:3015",
    },
    body: cfpErrorBody("CONFLICT", message),
  });
}

async function installDynamicCfpApi(
  page: import("@playwright/test").Page,
  session: E2eAuthSession,
  options: DynamicCfpHarnessOptions = {},
): Promise<DynamicCfpHarness> {
  const requests: Array<import("@playwright/test").Request> = [];
  const publishedResponses: DynamicCfpHarness["publishedResponses"] = [];
  const receiptRequests: Array<import("@playwright/test").Request> = [];
  const draftLoads: Array<import("@playwright/test").Request> = [];
  const submission: DynamicCfpSubmission = {
    id: CFP_SUBMISSION_ID,
    tenantId: CFP_ORGANIZATION_ID,
    eventId: CFP_EVENT_ID,
    formId: CFP_FORM_ID,
    ownerAccountId: session.userId,
    formVersion: CFP_FORM_VERSION,
    version: 1,
    status: options.withdrawnPointer ? "withdrawn" : "draft",
    completedSteps: ["welcome"],
    answers: cloneCfp(
      options.initialAnswers ?? {
        slides: { assetId: "asset-finalized-slides" },
      },
    ),
    participants: [],
    secondaryContacts: [],
    createdAt: CFP_UPDATED_AT,
    updatedAt: CFP_UPDATED_AT,
  };
  let draftPatchCount = 0;
  let authenticated = !options.unauthenticatedStartup;
  let unauthorizedPointerLoadsRemaining = options.unauthorizedPointerAlways
    ? Number.POSITIVE_INFINITY
    : options.unauthorizedPointerOnce
      ? 1
      : 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());

    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-credentials": "true",
          "access-control-allow-headers": "content-type,idempotency-key",
          "access-control-allow-methods": "GET,PATCH,POST,PUT,OPTIONS",
          "access-control-allow-origin": "http://127.0.0.1:3015",
        },
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/auth/get-session") {
      if (!authenticated) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      } else if (options.unauthenticatedStartup) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            session: {
              id: session.token,
              userId: session.userId,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            user: {
              id: session.userId,
              email: session.email,
              name: session.displayName,
              emailVerified: true,
            },
            memberships: [],
            speakerGrants: [],
          }),
        });
      } else {
        await route.fallback();
      }
      return;
    }
    expect(request.headers().cookie).toContain(`${E2E_SESSION_COOKIE}=${session.token}`);

    if (
      request.method() === "POST" &&
      (url.pathname === "/api/auth/sign-in/email" || url.pathname === "/api/auth/sign-up/email")
    ) {
      authenticated = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "set-cookie": `${E2E_SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Lax`,
        },
        body: JSON.stringify({
          token: session.token,
          user: {
            id: session.userId,
            email: session.email,
            name: session.displayName,
            emailVerified: true,
          },
        }),
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/auth/sign-out") {
      authenticated = false;
      await route.fulfill({ status: 204 });
      return;
    }

    const publicPath = `/api/public/cfp/organizations/${CFP_ORGANIZATION_ID}/events/${CFP_EVENT_ID}`;
    const apiPath = `/api/cfp/organizations/${CFP_ORGANIZATION_ID}/events/${CFP_EVENT_ID}`;
    if (
      request.method() === "GET" &&
      (url.pathname === publicPath || url.pathname === `${publicPath}/forms/${CFP_FORM_ID}`)
    ) {
      const response = {
        organization: cloneCfp(CFP_ORGANIZATION),
        event: cloneCfp(CFP_EVENT),
        form: cloneCfp(CFP_FORM),
      };
      publishedResponses.push(response);
      await fulfillCfpJson(route, response);
      return;
    }

    const draftSubmissionId = url.pathname.match(/\/submissions\/([^/]+)\/draft$/u)?.[1];
    if (
      request.method() === "GET" &&
      draftSubmissionId !== undefined &&
      (draftSubmissionId === CFP_SUBMISSION_ID || draftSubmissionId === options.replacementPointer)
    ) {
      draftLoads.push(request);
      if (unauthorizedPointerLoadsRemaining > 0) {
        unauthorizedPointerLoadsRemaining -= 1;
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: cfpErrorBody("UNAUTHORIZED", "Authentication is required."),
        });
        return;
      }
      if (options.stalePointer) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          headers: {
            "access-control-allow-credentials": "true",
            "access-control-allow-headers": "content-type,idempotency-key",
            "access-control-allow-methods": "GET,PATCH,POST,PUT,OPTIONS",
            "access-control-allow-origin": "http://127.0.0.1:3015",
          },
          body: cfpErrorBody("NOT_FOUND", "The CFP submission was not found."),
        });
        return;
      }
      await fulfillCfpJson(
        route,
        cloneCfp(
          draftSubmissionId === options.replacementPointer
            ? { ...submission, id: draftSubmissionId, status: "draft" as const }
            : submission,
        ),
      );
      return;
    }

    if (request.method() === "POST" && url.pathname === `${apiPath}/forms/${CFP_FORM_ID}/drafts`) {
      submission.version = 1;
      submission.status = "draft";
      await fulfillCfpJson(route, cloneCfp(submission), 201);
      return;
    }

    if (
      request.method() === "PATCH" &&
      url.pathname.startsWith(`${apiPath}/`) &&
      url.pathname.endsWith(`/submissions/${CFP_SUBMISSION_ID}/draft`)
    ) {
      draftPatchCount += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.formVersion !== CFP_FORM_VERSION || body.expectedVersion !== submission.version) {
        await fulfillCfpConflict(route);
        return;
      }
      if (options.conflictOnDraftPatch === draftPatchCount) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          headers: {
            "access-control-allow-credentials": "true",
            "access-control-allow-headers": "content-type,idempotency-key",
            "access-control-allow-methods": "GET,PATCH,POST,PUT,OPTIONS",
            "access-control-allow-origin": "http://127.0.0.1:3015",
          },
          body: cfpErrorBody("CONFLICT", "The CFP submission has changed."),
        });
        return;
      }
      const answers = cfpRecord(body.answers);
      if (answers !== null) submission.answers = { ...submission.answers, ...cloneCfp(answers) };
      if (
        typeof body.completedStep === "string" &&
        !submission.completedSteps.includes(body.completedStep)
      ) {
        submission.completedSteps = [...submission.completedSteps, body.completedStep];
      }
      submission.version += 1;
      submission.updatedAt = "2026-08-08T13:00:00.000Z";
      await fulfillCfpJson(route, cloneCfp(submission));
      return;
    }

    if (
      request.method() === "PUT" &&
      url.pathname.startsWith(`${apiPath}/`) &&
      url.pathname.endsWith(`/submissions/${CFP_SUBMISSION_ID}/participants`)
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.formVersion !== CFP_FORM_VERSION || body.expectedVersion !== submission.version) {
        await fulfillCfpConflict(route);
        return;
      }
      if (Array.isArray(body.participants)) {
        submission.participants = cloneCfp(body.participants) as DynamicCfpParticipant[];
      }
      if (Array.isArray(body.secondaryContacts)) {
        submission.secondaryContacts = cloneCfp(body.secondaryContacts) as Array<{
          id: string;
          name: string;
          email: string;
        }>;
      }
      submission.version += 1;
      submission.updatedAt = "2026-08-08T13:00:00.000Z";
      await fulfillCfpJson(route, cloneCfp(submission));
      return;
    }

    if (
      request.method() === "POST" &&
      url.pathname.startsWith(`${apiPath}/`) &&
      url.pathname.endsWith(`/submissions/${CFP_SUBMISSION_ID}/review`)
    ) {
      await fulfillCfpJson(route, {
        submissionId: submission.id,
        version: submission.version,
        canSubmit: true,
        issues: [],
        matchedRuleIds: ["show-workshop", "show-company"],
        routes: [],
      });
      return;
    }

    if (
      request.method() === "POST" &&
      url.pathname.startsWith(`${apiPath}/`) &&
      url.pathname.endsWith(`/submissions/${CFP_SUBMISSION_ID}/submit`)
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.formVersion !== CFP_FORM_VERSION || body.expectedVersion !== submission.version) {
        await fulfillCfpConflict(route);
        return;
      }
      submission.version += 1;
      submission.status = "submitted";
      submission.updatedAt = "2026-08-08T13:00:00.000Z";
      submission.submittedAt = "2026-08-08T13:05:00.000Z";
      const receipt = {
        id: "receipt-cfp-e2e",
        submissionId: submission.id,
        version: submission.version,
        submittedAt: submission.submittedAt,
      };
      await fulfillCfpJson(route, {
        submission: cloneCfp(submission),
        receipt,
        confirmationQueued: true,
      });
      return;
    }

    if (
      request.method() === "GET" &&
      url.pathname.startsWith(`${apiPath}/`) &&
      url.pathname.endsWith(`/submissions/${CFP_SUBMISSION_ID}/receipt`)
    ) {
      receiptRequests.push(request);
      await fulfillCfpJson(route, {
        id: "receipt-cfp-e2e",
        submissionId: submission.id,
        version: submission.version,
        submittedAt: submission.submittedAt ?? "2026-08-08T13:05:00.000Z",
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      headers: {
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "content-type,idempotency-key",
        "access-control-allow-methods": "GET,PATCH,POST,PUT,OPTIONS",
        "access-control-allow-origin": "http://127.0.0.1:3015",
      },
      body: cfpErrorBody("E2E_ROUTE_NOT_FOUND", `No E2E route for ${url.pathname}`),
    });
  });

  return { requests, publishedResponses, submission, receiptRequests, draftLoads };
}

function pointerKey(): string {
  return `eventloom:cfp-submission:v1:${encodeURIComponent(CFP_ORGANIZATION_ID)}:${encodeURIComponent(CFP_EVENT_ID)}:${encodeURIComponent(CFP_FORM_ID)}`;
}
function activePointerKey(): string {
  return `eventloom:cfp-active-submission:v1:${encodeURIComponent(CFP_ORGANIZATION_ID)}:${encodeURIComponent(CFP_EVENT_ID)}:${encodeURIComponent(CFP_FORM_ID)}`;
}
function newSubmissionIntentKey(): string {
  return `eventloom:cfp-new-submission:v1:${encodeURIComponent(CFP_ORGANIZATION_ID)}:${encodeURIComponent(CFP_EVENT_ID)}:${encodeURIComponent(CFP_FORM_ID)}`;
}

function cfpMutationBody(request: import("@playwright/test").Request): Record<string, unknown> {
  const body = request.postDataJSON();
  return cfpRecord(body) ?? {};
}

test("published dynamic CFP keeps conditional sections, custom answers, and schema references through submission", async ({
  authSession,
  page,
}, testInfo) => {
  const harness = await installDynamicCfpApi(page, authSession);
  await page.goto(CFP_PATH);

  await expect(page.getByRole("heading", { level: 1, name: "Eventloom Conference" })).toBeVisible();
  const visibleProposalLimit = page
    .getByText(`Up to ${CFP_FORM.settings.maxSubmissionsPerAccount} proposals per account`, {
      exact: true,
    })
    .filter({ visible: true });
  await expect(visibleProposalLimit).toHaveCount(1);
  await expect(page.getByText(CFP_FORM.welcomeContent, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Continue →" }).click();
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/account$`));

  await page.getByLabel("Email address").fill("cfp-e2e@example.test");
  await page.locator('[data-cfp-account-mode="sign_up"]').click();
  await page.getByLabel("Password").fill("CalmSystems!26");
  await page.getByLabel("First name").fill("Ada");
  await page.getByLabel("Last name").fill("Speaker");
  await page.getByRole("checkbox", { name: /I agree to the Terms of Service/ }).check();
  await Promise.all([
    page.waitForURL(new RegExp(`${CFP_PATH}/submission$`)),
    page.getByRole("button", { name: "Create account and continue" }).click(),
  ]);

  await expect(page.getByRole("heading", { level: 2, name: "Session proposal" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Workshop details" })).toHaveCount(0);
  await expect(page.getByLabel("Final slides")).toHaveCount(0);
  await page.getByLabel("Session title").fill("Designing calm incident response");
  const abstract = page.getByLabel("Abstract");
  await abstract.fill("A practical, evidence-led approach to resilient teams.");
  await abstract.selectText();
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(abstract).toHaveValue("**A practical, evidence-led approach to resilient teams.**");
  await selectSearchable(page, "Session format", "Workshop");
  await selectSearchable(page, "Track", "Platform");
  const topicsSearch = page.getByPlaceholder("Search options…");
  await topicsSearch.fill("Access");
  await page.getByRole("option", { name: "Accessibility", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Workshop details" })).toBeVisible();
  await page.getByLabel("Workshop audience").fill("Staff engineers and platform teams.");
  await expect(page.getByLabel("Final slides")).toBeVisible();
  await page.getByRole("button", { name: "Next step →" }).click();
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/participants$`));

  await expect(page.getByRole("heading", { level: 1, name: "Tell us about you" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Primary speaker" })).toBeVisible();
  await expect(page.getByLabel("Company", { exact: true })).toHaveCount(0);
  const firstParticipantType = page.getByRole("combobox", { name: "Participant type" }).first();
  await firstParticipantType.fill("Company");
  await page.getByRole("option", { name: "Company", exact: true }).click();
  await expect(page.getByLabel("Company", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Company", { exact: true }).first().fill("Calm Systems, Inc.");
  const firstBiography = page.getByLabel("Biography").first();
  await firstBiography.fill("Staff engineer and resilient-systems educator.");
  await page.getByRole("button", { name: "＋ Add participant" }).click();
  await page.getByLabel("First name").nth(1).fill("Grace");
  await page.getByLabel("Last name").nth(1).fill("Cooper");
  await page.getByLabel("Email").nth(1).fill("grace@example.test");
  const secondParticipantType = page.getByRole("combobox", { name: "Participant type" }).nth(1);
  await secondParticipantType.fill("Individual");
  await page.getByRole("option", { name: "Individual", exact: true }).click();
  await expect(page.getByText("Co-speaker", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Company", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Continue to review →" }).click();
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/review$`));
  await expect(page.getByRole("heading", { level: 3, name: /Ada Speaker/ })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: /Grace Cooper/ })).toContainText(
    "Co-speaker",
  );
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/complete$`));
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Submission received: Designing calm incident response",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(CFP_FORM.settings.confirmationMessage, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(CFP_FORM.settings.successContent, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit submission" })).toBeVisible();
  await expect(page.getByText(/Eventloom Conference received your proposal\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "View submission" })).toBeVisible();
  const completedProgress = page
    .getByRole("navigation", { name: "Submission progress" })
    .filter({ visible: true });
  await expect(completedProgress).toBeVisible();
  await expect(completedProgress.locator('[data-state="complete"]')).toHaveCount(5);
  await expect(completedProgress.locator('[aria-current="step"]')).toHaveCount(0);
  await expect(
    page.getByText(CFP_ORGANIZATION.name, { exact: true }).filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(CFP_FORM.name, { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("applicant-cfp-complete-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ height: 844, width: 390 });
  await expect(completedProgress).toBeVisible();
  await expect(completedProgress.getByText("Submission complete", { exact: true })).toBeVisible();
  await expect(
    page.locator('[data-cfp-main-flow] [data-cfp-submission-window="true"]').filter({
      visible: true,
    }),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-cfp-context-rail] [data-cfp-submission-window="true"]'),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
        document.body.scrollWidth <= document.body.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("applicant-cfp-complete-mobile.png"),
    fullPage: true,
  });

  await page.setViewportSize({ height: 900, width: 1440 });
  const submittedSnapshot = cloneCfp(harness.submission);
  const submittedEditRequestIndex = harness.requests.length;
  await page.evaluate((key) => window.sessionStorage.setItem(key, "1"), newSubmissionIntentKey());
  await page.getByRole("button", { name: "Edit submission" }).click();
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/submission$`));
  expect(
    await page.evaluate((key) => window.sessionStorage.getItem(key), newSubmissionIntentKey()),
  ).toBeNull();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/account$`));
  await expect(page.getByLabel("Email address")).toHaveValue("cfp-e2e@example.test");
  await page.getByRole("button", { name: "Continue to proposal" }).click();
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/submission$`));
  expect(harness.submission.id).toBe(submittedSnapshot.id);
  expect(harness.submission.version).toBe(submittedSnapshot.version);
  expect(
    harness.requests
      .slice(submittedEditRequestIndex)
      .filter(
        (request) =>
          request.method() === "POST" &&
          new URL(request.url()).pathname.endsWith(`/forms/${CFP_FORM_ID}/drafts`),
      ),
  ).toHaveLength(0);
  await page.screenshot({
    path: testInfo.outputPath("submitted-edit-back-forward.png"),
    fullPage: true,
  });

  expect(harness.publishedResponses.length).toBeGreaterThan(0);
  expect(harness.submission.formVersion).toBe(CFP_FORM_VERSION);
  expect(harness.publishedResponses[0]?.organization).toEqual(CFP_ORGANIZATION);
  expect(harness.publishedResponses[0]?.form.sections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "session", title: "Session proposal" }),
      expect.objectContaining({ id: "workshop", title: "Workshop details" }),
    ]),
  );
  expect(harness.publishedResponses[0]?.form.submissionFields[0]).toMatchObject({
    key: "title",
    fieldRef: { id: "shared-session-title", version: 3 },
  });
  const draftWrites = harness.requests.filter(
    (request) =>
      request.method() === "PATCH" &&
      request.url().includes(`/submissions/${CFP_SUBMISSION_ID}/draft`),
  );
  const participantWrites = harness.requests.filter(
    (request) =>
      request.method() === "PUT" &&
      request.url().includes(`/submissions/${CFP_SUBMISSION_ID}/participants`),
  );
  const submitWrites = harness.requests.filter(
    (request) =>
      request.method() === "POST" &&
      request.url().includes(`/submissions/${CFP_SUBMISSION_ID}/submit`),
  );
  expect(draftWrites.length).toBeGreaterThan(0);
  expect(draftWrites.map((request) => cfpMutationBody(request).completedStep)).toEqual([
    "account",
    "submission",
    "participant",
    "review",
  ]);
  expect(participantWrites).toHaveLength(1);
  expect(submitWrites).toHaveLength(1);
  for (const request of [...draftWrites, ...participantWrites, ...submitWrites]) {
    expect(cfpMutationBody(request)).toMatchObject({
      expectedVersion: expect.any(Number),
      formVersion: CFP_FORM_VERSION,
    });
    expect(new URL(request.url()).pathname).toContain(
      `/api/cfp/organizations/${CFP_ORGANIZATION_ID}/events/${CFP_EVENT_ID}/`,
    );
  }

  const submissionWrite = draftWrites
    .map(cfpMutationBody)
    .find((body) => cfpRecord(body.answers)?.format === "Workshop");
  expect(submissionWrite).toBeDefined();
  const answers = cfpRecord(submissionWrite?.answers);
  expect(answers).toMatchObject({
    title: "Designing calm incident response",
    abstract: "**A practical, evidence-led approach to resilient teams.**",
    format: "Workshop",
    track: "Platform",
    topics: ["Accessibility"],
    slides: { assetId: "asset-finalized-slides" },
  });
  expect(cfpRecord(answers?.slides)).toEqual({ assetId: "asset-finalized-slides" });

  const participantBody = cfpMutationBody(
    participantWrites[0] as import("@playwright/test").Request,
  );
  expect(participantBody).toMatchObject({
    formVersion: CFP_FORM_VERSION,
    participants: [
      {
        role: "primary",
        answers: {
          participantType: "Company",
          participantCompany: "Calm Systems, Inc.",
        },
      },
      {
        role: "co_speaker",
        answers: { participantType: "Individual" },
      },
    ],
  });
  expect(harness.receiptRequests.length).toBeGreaterThan(0);
  expect(new Set(harness.receiptRequests.map((request) => request.url()))).toHaveProperty(
    "size",
    1,
  );
  expect(harness.submission.status).toBe("submitted");
  expect(harness.submission.submittedAt).toBe("2026-08-08T13:05:00.000Z");
  expect(harness.receiptRequests[0]?.url()).toContain(
    `/api/cfp/organizations/${CFP_ORGANIZATION_ID}/events/${CFP_EVENT_ID}/`,
  );
});

test("CFP rejects a stale draft version without abandoning the five-step session", async ({
  authSession,
  page,
}) => {
  const harness = await installDynamicCfpApi(page, authSession, { conflictOnDraftPatch: 1 });
  await page.goto(`${CFP_PATH}/account`);
  await page.getByLabel("Email address").fill("stale-cfp@example.test");
  await page.locator('[data-cfp-account-mode="sign_up"]').click();
  await page.getByLabel("Password").fill("CalmSystems!26");
  await page.getByLabel("First name").fill("Stale");
  await page.getByLabel("Last name").fill("Writer");
  await page.getByRole("checkbox", { name: /I agree to the Terms of Service/ }).check();
  await Promise.all([
    expect(page.getByText("The CFP submission has changed.", { exact: true })).toBeVisible(),
    page.getByRole("button", { name: "Create account and continue" }).click(),
  ]);
  await expect(page.getByLabel("Email address")).toHaveValue("stale-cfp@example.test");
  await expect(page.getByLabel("First name")).toHaveValue("Stale");
  await expect(page.getByLabel("Last name")).toHaveValue("Writer");
  await expect(
    page.getByRole("checkbox", { name: /I agree to the Terms of Service/ }),
  ).toBeChecked();
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/account$`));
  const conflictedWrite = harness.requests.find(
    (request) =>
      request.method() === "PATCH" &&
      request.url().includes(`/submissions/${CFP_SUBMISSION_ID}/draft`) &&
      cfpMutationBody(request).completedStep === "account",
  );
  expect(conflictedWrite).toBeDefined();
  expect(cfpMutationBody(conflictedWrite as import("@playwright/test").Request)).toMatchObject({
    expectedVersion: 1,
    formVersion: CFP_FORM_VERSION,
    completedStep: "account",
  });
  expect(harness.submission.formVersion).toBe(CFP_FORM_VERSION);
});

test("CFP resumes an authentication-protected saved draft without creating a replacement", async ({
  authSession,
  page,
}) => {
  const harness = await installDynamicCfpApi(page, authSession, {
    unauthorizedPointerOnce: true,
    unauthenticatedStartup: true,
  });
  const key = pointerKey();
  await page.addInitScript(
    (pointer) => {
      window.localStorage.setItem(pointer.key, pointer.value);
    },
    { key, value: CFP_SUBMISSION_ID },
  );

  await page.goto(`${CFP_PATH}/account`);
  await expect(
    page.getByText("Sign in with the account that owns this saved draft.", { exact: true }),
  ).toBeVisible();
  await page.locator('[data-cfp-account-mode="sign_in"]').click();
  await page.getByLabel("Email address").fill(authSession.email);
  await page.getByLabel("Password").fill("StrongPass1!");
  await page.getByRole("button", { name: "Sign in and continue" }).click();

  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/submission$`));
  expect(harness.draftLoads.length).toBeGreaterThanOrEqual(2);
  const authenticationIndex = harness.requests.findIndex(
    (request) => request.method() === "POST" && request.url().endsWith("/api/auth/sign-in/email"),
  );
  const postAuthenticationLoadIndex = harness.requests.findIndex(
    (request, index) =>
      index > authenticationIndex &&
      request.method() === "GET" &&
      request.url().endsWith(`/submissions/${CFP_SUBMISSION_ID}/draft`),
  );
  const pinnedSaveIndex = harness.requests.findIndex(
    (request) =>
      request.method() === "PATCH" &&
      request.url().endsWith(`/submissions/${CFP_SUBMISSION_ID}/draft`),
  );
  expect(authenticationIndex).toBeGreaterThan(-1);
  expect(postAuthenticationLoadIndex).toBeGreaterThan(authenticationIndex);
  expect(pinnedSaveIndex).toBeGreaterThan(postAuthenticationLoadIndex);
  expect(
    harness.requests.filter(
      (request) =>
        request.method() === "POST" && request.url().endsWith(`/forms/${CFP_FORM_ID}/drafts`),
    ),
  ).toHaveLength(0);
  expect(await page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)).toBe(
    CFP_SUBMISSION_ID,
  );
});
test("CFP keeps each tab bound to its hydrated proposal across step remounts", async ({
  authSession,
  context,
  page,
}) => {
  const harness = await installDynamicCfpApi(page, authSession);
  const localKey = pointerKey();
  const tabKey = activePointerKey();
  await page.goto("/");
  await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
    key: localKey,
    value: CFP_SUBMISSION_ID,
  });

  await page.goto(`${CFP_PATH}/submission`);
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/submission$`));
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), tabKey)).toBe(
    CFP_SUBMISSION_ID,
  );

  const otherTab = await context.newPage();
  await otherTab.goto("/");
  await otherTab.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
    key: localKey,
    value: "submission-selected-in-other-tab",
  });
  await otherTab.close();

  await page.goto(`${CFP_PATH}/participants`);
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/participants$`));
  expect(harness.draftLoads.length).toBeGreaterThanOrEqual(2);
  expect(
    harness.draftLoads.every((request) =>
      request.url().endsWith(`/submissions/${CFP_SUBMISSION_ID}/draft`),
    ),
  ).toBe(true);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), localKey)).toBe(
    "submission-selected-in-other-tab",
  );
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), tabKey)).toBe(
    CFP_SUBMISSION_ID,
  );
});
test("CFP lets a wrong account explicitly sign out before switching to a protected draft owner", async ({
  authSession,
  page,
}) => {
  const harness = await installDynamicCfpApi(page, authSession, {
    unauthorizedPointerAlways: true,
    unauthenticatedStartup: true,
  });
  const key = pointerKey();
  await page.addInitScript(
    (pointer) => {
      window.localStorage.setItem(pointer.key, pointer.value);
    },
    { key, value: CFP_SUBMISSION_ID },
  );

  await page.goto(`${CFP_PATH}/account`);
  await page.getByLabel("Email address").fill(authSession.email);
  await page.getByLabel("Password").fill("StrongPass1!");
  await page.getByRole("button", { name: "Sign in and continue" }).click();

  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/account$`));
  await expect(page.getByRole("button", { name: "Sign out and switch account" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out and switch account" }).click();
  await expect(page).toHaveURL(/\/login\?next=/u);
  expect(
    harness.requests.filter(
      (request) =>
        (request.method() === "POST" && request.url().endsWith(`/forms/${CFP_FORM_ID}/drafts`)) ||
        (request.method() === "PATCH" &&
          request.url().endsWith(`/submissions/${CFP_SUBMISSION_ID}/draft`)),
    ),
  ).toHaveLength(0);
  expect(await page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)).toBe(
    CFP_SUBMISSION_ID,
  );
});
test("CFP releases a matching withdrawn pointer so an authenticated account can create a replacement", async ({
  authSession,
  page,
}) => {
  const harness = await installDynamicCfpApi(page, authSession, {
    unauthenticatedStartup: true,
    withdrawnPointer: true,
  });
  const key = pointerKey();
  await page.addInitScript(
    (pointer) => {
      window.localStorage.setItem(pointer.key, pointer.value);
    },
    { key, value: CFP_SUBMISSION_ID },
  );

  await page.goto(`${CFP_PATH}/account`);
  await page.getByLabel("Email address").fill(authSession.email);
  await page.getByLabel("Password").fill("StrongPass1!");
  await page.getByRole("button", { name: "Sign in and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`${CFP_PATH}/submission$`));
  expect(
    harness.requests.filter(
      (request) =>
        request.method() === "POST" && request.url().endsWith(`/forms/${CFP_FORM_ID}/drafts`),
    ),
  ).toHaveLength(1);
  expect(await page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)).toBe(
    CFP_SUBMISSION_ID,
  );
});
test("CFP preserves a newer pointer selected while a withdrawn draft is loading", async ({
  authSession,
  page,
}) => {
  const replacementPointer = "submission-selected-in-other-tab";
  await installDynamicCfpApi(page, authSession, {
    replacementPointer,
    unauthenticatedStartup: true,
    withdrawnPointer: true,
  });
  const key = pointerKey();
  await page.addInitScript(
    (pointer) => {
      window.localStorage.setItem(pointer.key, pointer.value);
    },
    { key, value: CFP_SUBMISSION_ID },
  );
  await page.route(`**/submissions/${CFP_SUBMISSION_ID}/draft`, async (route) => {
    await page.evaluate(
      ({ storageKey, replacement }) => window.localStorage.setItem(storageKey, replacement),
      { storageKey: key, replacement: replacementPointer },
    );
    await route.fallback();
  });

  await page.goto(`${CFP_PATH}/account`);
  await page.getByLabel("Email address").fill(authSession.email);
  await page.getByLabel("Password").fill("StrongPass1!");
  await page.getByRole("button", { name: "Sign in and continue" }).click();
  await expect(page.getByLabel("Email address")).toHaveValue(authSession.email);
  expect(await page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)).toBe(
    replacementPointer,
  );
});
test("CFP clears a stale saved pointer and starts a fresh account step", async ({
  authSession,
  page,
}) => {
  const harness = await installDynamicCfpApi(page, authSession, { stalePointer: true });
  const key = pointerKey();
  await page.addInitScript(
    (pointer) => {
      window.localStorage.setItem(pointer.key, pointer.value);
    },
    { key, value: CFP_SUBMISSION_ID },
  );
  await page.goto(`${CFP_PATH}/account`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveValue("");
  await page.locator('[data-cfp-account-mode="sign_up"]').click();
  await expect(page.getByLabel("First name")).toHaveValue("");
  expect(
    await page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key),
  ).toBeNull();
  expect(harness.draftLoads).toHaveLength(1);
  expect(harness.draftLoads[0]?.url()).toContain(
    `/api/cfp/organizations/${CFP_ORGANIZATION_ID}/events/${CFP_EVENT_ID}/submissions/${CFP_SUBMISSION_ID}/draft`,
  );
});
