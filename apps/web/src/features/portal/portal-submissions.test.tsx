import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PortalSubmissionCard } from "./portal-submission-card";
import { portalSubmissionActionTargets, portalSubmissionDisplayTitle } from "./portal-submissions";
import type { PortalContext, PortalSubmission } from "./types";

const context: PortalContext = {
  id: "portal:organization-1:event-1",
  organizationId: "organization-1",
  eventId: "event-1",
  slug: "event-one",
  name: "Event One",
  capabilities: ["submission-edit"],
  submissionIds: ["550e8400-e29b-41d4-a716-446655440000"],
  participantIds: ["participant-1"],
};

const draft: PortalSubmission = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  eventId: "event-1",
  formId: "main-cfp",
  title: "550e8400-e29b-41d4-a716-446655440000",
  status: "draft",
  participantIds: ["participant-1"],
  updatedAt: "2026-08-15T10:00:00.000Z",
};

describe("participant submission regressions", () => {
  it("never exposes missing or opaque proposal titles", () => {
    expect(portalSubmissionDisplayTitle(draft)).toBe("No title");
    expect(portalSubmissionDisplayTitle({ ...draft, title: " " })).toBe("No title");
    expect(
      portalSubmissionDisplayTitle({ ...draft, title: `speaker-submission:${draft.id}` }),
    ).toBe("No title");
  });

  it("renders an editable draft with a primary continuation into its authoritative CFP draft", () => {
    expect(portalSubmissionActionTargets(context, draft)).toMatchObject({
      editHref: "/cfp/organizations/organization-1/events/event-one/submission",
      pointerKey: "eventloom:cfp-submission:v1:organization-1:event-1:main-cfp",
      activePointerKey: "eventloom:cfp-active-submission:v1:organization-1:event-1:main-cfp",
      newSubmissionIntentKey: "eventloom:cfp-new-submission:v1:organization-1:event-1:main-cfp",
    });

    const markup = renderToStaticMarkup(
      <PortalSubmissionCard
        canEdit
        context={context}
        eventQuery="?event=event-1"
        equivalents={[draft]}
        submission={draft}
      />,
    );

    expect(markup).toContain("No title");
    expect(markup).toContain("Continue proposal");
    expect(markup).toContain(
      'href="/cfp/organizations/organization-1/events/event-one/submission"',
    );
    expect(markup).not.toContain("550e8400-e29b-41d4-a716-446655440000</h3>");
  });

  it("retains submitted editing while keeping accepted proposals read-only", () => {
    const submittedMarkup = renderToStaticMarkup(
      <PortalSubmissionCard
        canEdit
        context={context}
        eventQuery="?event=event-1"
        equivalents={[]}
        submission={{ ...draft, title: "A complete proposal", status: "submitted" }}
      />,
    );
    expect(submittedMarkup).toContain("Edit proposal");
    expect(submittedMarkup).not.toContain("Continue proposal");

    const acceptedMarkup = renderToStaticMarkup(
      <PortalSubmissionCard
        canEdit
        context={context}
        eventQuery="?event=event-1"
        equivalents={[]}
        submission={{ ...draft, title: "An accepted proposal", status: "accepted" }}
      />,
    );
    expect(acceptedMarkup).toContain("Your proposal was accepted");
    expect(acceptedMarkup).toContain("Open speaker workspace");
    expect(acceptedMarkup).not.toContain("Edit proposal");
  });

  it("keeps the submission page inside tokenized desktop and narrow-screen gutters", () => {
    const css = readFileSync(fileURLToPath(new URL("portal.module.css", import.meta.url)), "utf8");

    expect(css).toMatch(/\.submissionsPage\s*\{[^}]*max-width:\s*var\(--content-width\)/su);
    expect(css).toMatch(/\.submissionsPage\s*\{[^}]*--portal-blue-dark:\s*var\(--foreground\)/su);
    expect(css).toMatch(/\.submissionsPage\s*\{[^}]*margin-inline:\s*auto/su);
    expect(css).toMatch(/\.submissionsPage\s*\{[^}]*padding:\s*var\(--space-5\)/su);
    expect(css).toMatch(
      /@media \(max-width:\s*44rem\)[\s\S]*?\.submissionsPage\s*\{[^}]*padding:\s*var\(--space-4\)/u,
    );
  });
});
