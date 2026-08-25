import { describe, expect, it } from "vitest";
import { InMemorySessionRepository, SessionService } from "./service";

describe("SessionService agenda catalog", () => {
  it("keeps accepted sessions with unapproved and speaker-edited content schedulable while withholding them from publication", async () => {
    const service = new SessionService(new InMemorySessionRepository());
    const organizer = { tenantId: "tenant-a", userId: "organizer-a", role: "organizer" as const };

    await service.createSession(organizer, {
      eventId: "event-a",
      id: "marcus",
      title: "Marcus's accepted proposal",
      description: "Private scheduling details",
      durationMinutes: 45,
      status: "Accepted",
      speakerIds: ["marcus"],
    });
    const priya = await service.createSession(organizer, {
      eventId: "event-a",
      id: "priya",
      title: "Priya's speaker-edited proposal",
      description: "Initial speaker details",
      durationMinutes: 30,
      status: "Accepted",
      speakerIds: ["priya"],
    });
    const approvedPriya = await service.updateSession(organizer, {
      eventId: "event-a",
      sessionId: priya.id,
      expectedVersion: priya.version,
      contentStatus: "Approved",
    });
    await service.updateSession(organizer, {
      eventId: "event-a",
      sessionId: priya.id,
      expectedVersion: approvedPriya.version,
      speakerIds: ["priya", "co-speaker"],
    });

    await expect(service.getAgendaCatalog("tenant-a", "event-a")).resolves.toMatchObject({
      sessions: [
        {
          id: "marcus",
          title: "Marcus's accepted proposal",
          status: "accepted",
          summary: "Private scheduling details",
          publicApprovalEligible: false,
        },
        {
          id: "priya",
          title: "Priya's speaker-edited proposal",
          participantIds: ["priya", "co-speaker"],
          publicApprovalEligible: false,
        },
      ],
    });
    await expect(service.getPublishedSessionContent("tenant-a", "event-a")).resolves.toEqual({
      tenantId: "tenant-a",
      eventId: "event-a",
      sessions: [],
    });
  });
});
describe("SessionService approval-gated taxonomy", () => {
  it("invalidates approval when duration, format, and normalized tracks change under CAS", async () => {
    const service = new SessionService(new InMemorySessionRepository());
    const organizer = { tenantId: "tenant-a", userId: "organizer-a", role: "organizer" as const };
    const trackA = await service.createTrack(organizer, {
      eventId: "event-a",
      name: "Track A",
    });
    const trackB = await service.createTrack(organizer, {
      eventId: "event-a",
      name: "Track B",
    });
    const format = await service.createFormat(organizer, {
      eventId: "event-a",
      name: "Talk",
    });
    const alternateFormat = await service.createFormat(organizer, {
      eventId: "event-a",
      name: "Panel",
    });
    const created = await service.createSession(organizer, {
      eventId: "event-a",
      id: "session-a",
      title: "Approved session",
      durationMinutes: 30,
      status: "Accepted",
      trackIds: [trackA.id],
      formatId: format.id,
    });
    const approved = await service.updateSession(organizer, {
      eventId: "event-a",
      sessionId: created.id,
      expectedVersion: created.version,
      contentStatus: "Approved",
    });
    const changed = await service.updateSession(organizer, {
      eventId: "event-a",
      sessionId: approved.id,
      expectedVersion: approved.version,
      durationMinutes: 45,
    });

    expect(changed.contentStatus).toBe("Needs changes");
    const formatApproved = await service.updateSession(organizer, {
      eventId: "event-a",
      sessionId: changed.id,
      expectedVersion: changed.version,
      contentStatus: "Approved",
    });
    const formatChanged = await service.updateSession(organizer, {
      eventId: "event-a",
      sessionId: changed.id,
      expectedVersion: formatApproved.version,
      formatId: alternateFormat.id,
    });
    expect(formatChanged.contentStatus).toBe("Needs changes");
    const tracksApproved = await service.updateSession(organizer, {
      eventId: "event-a",
      sessionId: changed.id,
      expectedVersion: formatChanged.version,
      contentStatus: "Approved",
    });
    const tracksChanged = await service.updateSession(organizer, {
      eventId: "event-a",
      sessionId: changed.id,
      expectedVersion: tracksApproved.version,
      trackIds: [trackB.id],
    });
    expect(tracksChanged.contentStatus).toBe("Needs changes");
    const removalApproved = await service.updateSession(organizer, {
      eventId: "event-a",
      sessionId: changed.id,
      expectedVersion: tracksChanged.version,
      contentStatus: "Approved",
    });
    const tracksRemoved = await service.updateSession(organizer, {
      eventId: "event-a",
      sessionId: changed.id,
      expectedVersion: removalApproved.version,
      trackIds: [],
    });
    expect(tracksRemoved.contentStatus).toBe("Needs changes");
    await expect(service.getAgendaCatalog("tenant-a", "event-a")).resolves.toMatchObject({
      sessions: [{ id: changed.id, trackIds: [], publicApprovalEligible: false }],
    });
  });
});
