import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createParticipantDashboard } from "./participant-dashboard-model";
import { ParticipantEventsDashboard } from "./portal-dashboard";
import type { PortalContext, PortalSubmission, PortalTask } from "./types";

const selectedContext: PortalContext = {
  id: "portal:org:north",
  organizationId: "org",
  eventId: "north",
  name: "North Summit",
  capabilities: ["submission-edit", "task-response", "profile-self"],
  submissionIds: ["accepted-1", "under-review-1"],
  participantIds: ["speaker-1"],
  primaryParticipantId: "speaker-1",
  selectedParticipantId: "speaker-1",
};

const otherContext: PortalContext = {
  id: "portal:org:south",
  organizationId: "org",
  eventId: "south",
  name: "South Summit",
  capabilities: ["submission-edit", "task-response"],
  submissionIds: ["south-1", "south-2"],
  participantIds: ["speaker-1"],
  primaryParticipantId: "speaker-1",
};

const submissions: readonly PortalSubmission[] = [
  {
    id: "accepted-1",
    eventId: "north",
    title: "speaker-submission:reliable-platforms",
    status: "accepted",
    participantIds: ["speaker-1"],
    updatedAt: "2026-08-15T10:00:00.000Z",
  },
  {
    id: "under-review-1",
    eventId: "north",
    title: "Operational AI",
    status: "under_review",
    participantIds: ["speaker-1"],
    updatedAt: "2026-08-14T10:00:00.000Z",
  },
];

const tasks: readonly PortalTask[] = [
  {
    id: "task-1",
    eventId: "north",
    subject: { type: "participant" },
    participantId: "speaker-1",
    type: "form",
    owner: "speaker",
    title: "Confirm speaker details",
    status: "not_started",
    dependencyIds: [],
    reminderOffsetsMinutes: [],
    version: 1,
    updatedAt: "2026-08-15T10:00:00.000Z",
  },
];

describe("participant portal workspace", () => {
  it("renders every authorized event while reserving detailed statuses for the selected context", () => {
    const dashboard = createParticipantDashboard({
      contexts: [selectedContext, otherContext],
      submissions,
      tasks,
      eventQuery: "?event=north&participant=speaker-1",
    });
    const markup = renderToStaticMarkup(
      <ParticipantEventsDashboard dashboard={dashboard} selectedContextId={selectedContext.id} />,
    );

    expect(markup).toContain("My events");
    expect(markup).toContain("North Summit");
    expect(markup).toContain("South Summit");
    expect(markup).toContain("Reliable Platforms");
    expect(markup).toContain("Under review");
    expect(markup).toContain("Prepare for event");
    expect(markup).toContain("2 submissions");
    expect(markup).toContain("Select this event to view proposal statuses");
    expect(markup).not.toMatch(/schedule|agreement/iu);
  });

  it("uses semantic design tokens and responsive layout without direct color literals", () => {
    const css = ["portal-dashboard.module.css", "portal-shell.module.css"]
      .map((file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"))
      .join("\n");

    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/\brgba?\(/u);
    expect(css).toContain("var(--background)");
    expect(css).toContain("var(--border)");
    expect(css).toContain("var(--space-4)");
    expect(css).toContain("@media (max-width: 48rem)");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});
