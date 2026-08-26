import { beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiDependencies, createApp } from "../app";
import type { RuntimeBindings } from "./cloudflare";
import { createRuntimeWorker } from "./composition";
import { createLocalDependencies, LOCAL_ORGANIZATION_ID, LocalSpeakerRepository } from "./local";

vi.setConfig({ testTimeout: 15_000 });

const organizer = {
  tenantId: LOCAL_ORGANIZATION_ID,
  userId: "local-organizer",
  role: "owner" as const,
  kind: "user" as const,
};
const evaluator = {
  tenantId: LOCAL_ORGANIZATION_ID,
  userId: "local-organizer",
  kind: "human" as const,
  grants: [{ eventId: "demo-event", role: "organizer" as const }],
};

describe("local fixture event graph", () => {
  let dependencies: ApiDependencies;
  const environment = {
    APP_ENV: "local" as const,
    WEB_ORIGIN: "http://localhost:3015",
  };

  beforeAll(async () => {
    dependencies = createLocalDependencies();
    await dependencies.agenda?.engine.getPublishedAgenda("demo-event");
  }, 30_000);

  it("lists only evaluation plans covered by explicit reviewer grants", async () => {
    const app = createApp(dependencies);
    const response = await app.request(
      "/api/admin/evaluations/plans",
      { headers: { cookie: "better-auth.session_token=local-reviewer-session" } },
      environment,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      plans: readonly { id: string; eventId: string }[];
    };
    expect(payload.plans).toContainEqual(
      expect.objectContaining({ id: "local-evaluation-plan", eventId: "demo-event" }),
    );
    expect(payload.plans.every(({ eventId }) => eventId === "demo-event")).toBe(true);

    const ungrantedResponse = await app.request(
      "/api/admin/evaluations/plans?eventId=open-sessionboard-conf",
      { headers: { cookie: "better-auth.session_token=local-reviewer-session" } },
      environment,
    );
    expect(ungrantedResponse.status).toBe(403);
  });

  it("does not expose legacy CFP-only events outside the canonical event graph", async () => {
    const app = createApp(dependencies);
    const response = await app.request(
      "/api/cfp/organizations/local-organization/events/evaluator-2026/config",
      { headers: { cookie: "better-auth.session_token=local-session" } },
      environment,
    );

    expect(response.status).toBe(404);
  });

  it("keeps fixture event writes across fresh binding objects", async () => {
    const worker = createRuntimeWorker();
    const fetch = worker.fetch;
    if (fetch === undefined) throw new Error("The runtime worker did not expose fetch.");
    const firstBindings: RuntimeBindings = {
      APP_ENV: "local",
      RUNTIME_PROFILE: "fixture",
      WEB_ORIGIN: "http://localhost:3015",
    };
    const createdResponse = await fetch(
      new Request(`http://api.local/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "better-auth.session_token=local-session",
        },
        body: JSON.stringify({
          name: "Fresh binding event",
          slug: "fresh-binding-event",
          timeZone: "UTC",
          startsAt: "2026-10-02T09:00:00.000Z",
          endsAt: "2026-10-02T17:00:00.000Z",
          venue: "Local QA",
        }),
      }),
      firstBindings,
      {} as ExecutionContext,
    );
    expect(createdResponse.status).toBe(201);
    const createdPayload = (await createdResponse.json()) as {
      data?: { id?: unknown };
    };
    if (typeof createdPayload.data?.id !== "string") {
      throw new Error("Expected the event create route to return an event ID.");
    }

    const freshBindings: RuntimeBindings = { ...firstBindings };
    const response = await fetch(
      new Request(
        `http://api.local/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/${createdPayload.data.id}`,
        { headers: { cookie: "better-auth.session_token=local-session" } },
      ),
      freshBindings,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
  });

  it("exposes newly created organizer events to CFP configuration", async () => {
    const app = createApp(dependencies);
    const startsAt = "2026-10-01T09:00:00.000Z";
    const endsAt = "2026-10-01T17:00:00.000Z";
    const createdResponse = await app.request(
      `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "better-auth.session_token=local-session",
        },
        body: JSON.stringify({
          name: "Local persistence event",
          slug: "local-persistence-event",
          timeZone: "UTC",
          startsAt,
          endsAt,
          venue: "Local QA",
          cfpSettings: {
            enabled: false,
            opensAt: null,
            closesAt: null,
          },
        }),
      },
      environment,
    );
    expect(createdResponse.status).toBe(201);
    const createdPayload = (await createdResponse.json()) as {
      data?: { id?: unknown };
    };
    if (typeof createdPayload.data?.id !== "string") {
      throw new Error("Expected the event create route to return an event ID.");
    }

    const response = await app.request(
      `/api/cfp/organizations/${LOCAL_ORGANIZATION_ID}/events/${createdPayload.data.id}/config`,
      { headers: { cookie: "better-auth.session_token=local-session" } },
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        id: createdPayload.data.id,
        tenantId: LOCAL_ORGANIZATION_ID,
        name: "Local persistence event",
        timezone: "UTC",
        opensAt: startsAt,
        closesAt: endsAt,
      },
    });
  });

  it("publishes only sessions belonging to the agenda event", async () => {
    const revision = await dependencies.agenda?.engine.getPublishedAgenda("demo-event");
    const otherRevision = dependencies.agenda?.engine.getPublishedAgenda("open-sessionboard-conf");
    const sessions = await dependencies.sessions?.service.listSessions(organizer, {
      eventId: "demo-event",
      limit: 100,
    });
    const eventBySessionId = new Map(sessions?.map((session) => [session.id, session.eventId]));

    expect(revision?.entries.length).toBeGreaterThan(0);
    expect(
      revision?.entries.every((entry) => eventBySessionId.get(entry.sessionId) === "demo-event"),
    ).toBe(true);
    await expect(otherRevision).rejects.toMatchObject({ code: "AGENDA_NOT_FOUND" });
  });

  it("propagates an approved session revision without republishing the agenda", async () => {
    const runtime = createLocalDependencies();
    const app = createApp(runtime);
    const sessionService = runtime.sessions?.service;
    if (sessionService === undefined) throw new Error("Expected the local session service.");

    const readPublicAgenda = async () => {
      const response = await app.request(
        "/api/public/events/demo-event/agenda.json",
        undefined,
        environment,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        data: {
          revision: { number: number };
          entries: readonly {
            sessionId: string;
            title: string;
            format: string;
            speakerNames: readonly string[];
            trackIds: readonly string[];
            trackNames: readonly string[];
          }[];
        };
      };
    };
    const readPublicSpeakers = async () => {
      const response = await app.request(
        "/api/public/events/demo-event/speakers",
        undefined,
        environment,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        data: {
          speakers: readonly {
            id: string;
            sessionIds: readonly string[];
            trackNames: readonly string[];
          }[];
        };
      };
    };

    const before = await readPublicAgenda();
    const publishedEntry = before.data.entries[0];
    if (publishedEntry === undefined) throw new Error("Expected a published session.");
    const sessions = await sessionService.listSessions(organizer, {
      eventId: "demo-event",
      limit: 100,
    });
    const session = sessions.find(({ id }) => id === publishedEntry.sessionId);
    if (session === undefined) throw new Error("Expected the published canonical session.");
    const approvedTitle = `${publishedEntry.title} approved revision`;

    const edited = await sessionService.updateSession(organizer, {
      eventId: "demo-event",
      sessionId: session.id,
      expectedVersion: session.version,
      title: approvedTitle,
    });
    expect(edited.contentStatus).toBe("Needs changes");
    expect((await readPublicAgenda()).data.entries).toContainEqual(
      expect.objectContaining({ sessionId: session.id, title: publishedEntry.title }),
    );

    const approved = await sessionService.updateSession(organizer, {
      eventId: "demo-event",
      sessionId: session.id,
      expectedVersion: edited.version,
      contentStatus: "Approved",
    });

    const refreshedRevision = await runtime.agenda?.engine.getPublishedAgenda("demo-event");
    expect(refreshedRevision?.revisionNumber).toBeGreaterThan(before.data.revision.number);
    const servedManifest = await runtime.agenda?.getProgramPublicationManifest?.("demo-event");
    expect(servedManifest?.agendaRevisionNumber).toBeGreaterThan(before.data.revision.number);
    const after = await readPublicAgenda();
    expect(after.data.revision.number).toBeGreaterThan(before.data.revision.number);
    expect(after.data.entries).toContainEqual(
      expect.objectContaining({ sessionId: session.id, title: approvedTitle }),
    );
    const publicIcal = await app.request(
      "/api/public/events/demo-event/agenda.ics",
      undefined,
      environment,
    );
    expect(publicIcal.status).toBe(200);
    expect(await publicIcal.text()).toContain(`SUMMARY:${approvedTitle}`);
    const publicSpeakers = await app.request(
      "/api/public/events/demo-event/speakers",
      undefined,
      environment,
    );
    expect(publicSpeakers.status).toBe(200);
    expect(await publicSpeakers.text()).toContain(approvedTitle);

    const repeatedApproval = await sessionService.updateSession(organizer, {
      eventId: "demo-event",
      sessionId: session.id,
      expectedVersion: approved.version,
      contentStatus: "Approved",
    });
    expect(repeatedApproval.version).toBe(approved.version);
    expect((await readPublicAgenda()).data.revision.number).toBe(after.data.revision.number);

    const restored = await sessionService.restoreSessionVersion(organizer, {
      eventId: "demo-event",
      sessionId: session.id,
      expectedVersion: approved.version,
      version: session.version,
    });
    expect((await readPublicAgenda()).data.revision.number).toBe(after.data.revision.number);
    const correctiveApproval = await sessionService.updateSession(organizer, {
      eventId: "demo-event",
      sessionId: session.id,
      expectedVersion: restored.version,
      contentStatus: "Approved",
    });
    const reverted = await readPublicAgenda();
    expect(reverted.data.revision.number).toBeGreaterThan(after.data.revision.number);
    expect(reverted.data.entries).toContainEqual(
      expect.objectContaining({ sessionId: session.id, title: publishedEntry.title }),
    );

    const formatId = correctiveApproval.formatId;
    if (formatId === undefined) throw new Error("Expected the published session format.");
    const formats = await sessionService.listFormats(organizer, { eventId: "demo-event" });
    const format = formats.find(({ id }) => id === formatId);
    if (format === undefined) throw new Error("Expected the canonical session format.");
    const renamedFormat = "Propagation Keynote";
    await sessionService.updateFormat(organizer, {
      eventId: "demo-event",
      resourceId: formatId,
      expectedVersion: format.version,
      name: renamedFormat,
    });
    const afterFormat = await readPublicAgenda();
    expect(afterFormat.data.revision.number).toBeGreaterThan(reverted.data.revision.number);
    expect(afterFormat.data.entries).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        format: renamedFormat,
      }),
    );

    const publishedSession = afterFormat.data.entries.find(
      (entry) => entry.sessionId === session.id,
    );
    const trackId = publishedSession?.trackIds[0];
    if (trackId === undefined) throw new Error("Expected the published session track.");
    const tracks = await sessionService.listTracks(organizer, { eventId: "demo-event" });
    const track = tracks.find(({ id }) => id === trackId);
    if (track === undefined) throw new Error("Expected the canonical session track.");
    const renamedTrack = "Propagation systems";
    await sessionService.updateTrack(organizer, {
      eventId: "demo-event",
      resourceId: track.id,
      expectedVersion: track.version,
      name: renamedTrack,
    });
    const afterTrack = await readPublicAgenda();
    expect(afterTrack.data.revision.number).toBeGreaterThan(afterFormat.data.revision.number);
    expect(afterTrack.data.entries).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        trackNames: [renamedTrack],
      }),
    );
    expect(
      (await readPublicSpeakers()).data.speakers.find(({ id }) =>
        correctiveApproval.speakerIds.includes(id),
      )?.trackNames,
    ).toContain(renamedTrack);

    const speakerReference = correctiveApproval.speakerRoster[0];
    if (speakerReference === undefined) throw new Error("Expected the published speaker roster.");
    const pendingSpeakerName = "Pending private speaker name";
    const rosterEdit = await sessionService.updateSession(organizer, {
      eventId: "demo-event",
      sessionId: session.id,
      expectedVersion: correctiveApproval.version,
      speakerRoster: correctiveApproval.speakerRoster.map((reference) =>
        reference.id === speakerReference.id
          ? { ...reference, displayName: pendingSpeakerName }
          : reference,
      ),
    });
    expect(rosterEdit.contentStatus).toBe("Needs changes");
    const afterRosterEdit = await readPublicAgenda();
    expect(afterRosterEdit.data.revision.number).toBe(afterTrack.data.revision.number);
    expect(
      afterRosterEdit.data.entries.find((entry) => entry.sessionId === session.id)?.speakerNames,
    ).not.toContain(pendingSpeakerName);

    const replacementSpeaker = sessions
      .filter((candidate) => candidate.id !== session.id)
      .flatMap((candidate) => candidate.speakerRoster)
      .find((reference) => !correctiveApproval.speakerIds.includes(reference.id));
    if (replacementSpeaker?.displayName === undefined) {
      throw new Error("Expected another canonical speaker with a display name.");
    }
    const assignmentEdit = await sessionService.updateSession(organizer, {
      eventId: "demo-event",
      sessionId: session.id,
      expectedVersion: rosterEdit.version,
      speakerRoster: [replacementSpeaker],
    });
    expect(assignmentEdit.contentStatus).toBe("Needs changes");
    const approvedAssignment = await sessionService.updateSession(organizer, {
      eventId: "demo-event",
      sessionId: session.id,
      expectedVersion: assignmentEdit.version,
      contentStatus: "Approved",
    });
    expect(approvedAssignment.contentStatus).toBe("Approved");
    const afterAssignment = await readPublicAgenda();
    expect(afterAssignment.data.entries).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        speakerNames: [replacementSpeaker.displayName],
      }),
    );
    const assignmentSpeakers = (await readPublicSpeakers()).data.speakers;
    expect(assignmentSpeakers.find(({ id }) => id === replacementSpeaker.id)?.sessionIds).toContain(
      session.id,
    );
    expect(
      assignmentSpeakers.find(({ id }) => id === speakerReference.id)?.sessionIds ?? [],
    ).not.toContain(session.id);
  }, 45_000);

  it("retains public speakers and headshots when rolling back a local program release", async () => {
    const freshDependencies = createLocalDependencies();
    const freshApp = createApp(freshDependencies);
    const sessionService = freshDependencies.sessions?.service;
    if (sessionService === undefined) throw new Error("Expected local session service.");
    const organizerHeaders = {
      "content-type": "application/json",
      cookie: "better-auth.session_token=local-session",
    };
    const publicationPath =
      "/api/admin/organizations/local-organization/events/demo-event/publication";
    const readPublication = async () => {
      const response = await freshApp.request(
        publicationPath,
        { headers: organizerHeaders },
        environment,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        data: {
          version: number;
          servedRevision: number;
          servedManifest: {
            speakerProjectionId: string;
            speakerRevisionNumber: number;
            speakerSourceHash: string;
          } | null;
        };
      };
    };
    const readPublicSpeakers = async () => {
      const response = await freshApp.request(
        "/api/public/events/demo-event/speakers",
        undefined,
        environment,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        data: {
          speakers: readonly {
            id: string;
            photoUrl: string | null;
            sessionTitles: readonly string[];
          }[];
        };
      };
    };

    const initialSpeakers = await readPublicSpeakers();
    const initialSpeaker = initialSpeakers.data.speakers.find(
      (speaker) => speaker.photoUrl !== null,
    );
    if (initialSpeaker?.photoUrl === null || initialSpeaker === undefined) {
      throw new Error("Expected a released local speaker headshot.");
    }
    const initialHeadshot = await freshApp.request(initialSpeaker.photoUrl, undefined, environment);
    expect(initialHeadshot.status).toBe(200);
    const initialHeadshotBytes = new Uint8Array(await initialHeadshot.arrayBuffer());
    const releaseOne = await readPublication();
    if (releaseOne.data.servedManifest === null) {
      throw new Error("Expected the initial local served manifest.");
    }

    const agendaResponse = await freshApp.request(
      "/api/public/events/demo-event/agenda.json",
      undefined,
      environment,
    );
    expect(agendaResponse.status).toBe(200);
    const agenda = (await agendaResponse.json()) as {
      data: { entries: readonly { sessionId: string; title: string }[] };
    };
    const publishedEntry = agenda.data.entries[0];
    if (publishedEntry === undefined) throw new Error("Expected a published local session.");
    const sessions = await sessionService.listSessions(organizer, {
      eventId: "demo-event",
      limit: 100,
    });
    const session = sessions.find(({ id }) => id === publishedEntry.sessionId);
    if (session === undefined) throw new Error("Expected the published canonical session.");
    const edited = await sessionService.updateSession(organizer, {
      eventId: "demo-event",
      sessionId: session.id,
      expectedVersion: session.version,
      title: `${publishedEntry.title} release two`,
    });
    await sessionService.updateSession(organizer, {
      eventId: "demo-event",
      sessionId: session.id,
      expectedVersion: edited.version,
      contentStatus: "Approved",
    });

    const releaseTwo = await readPublication();
    expect(releaseTwo.data.servedRevision).toBeGreaterThan(releaseOne.data.servedRevision);
    expect(releaseTwo.data.servedManifest?.speakerProjectionId).not.toBe(
      releaseOne.data.servedManifest.speakerProjectionId,
    );

    const rollbackResponse = await freshApp.request(
      `${publicationPath}/rollback`,
      {
        method: "POST",
        headers: organizerHeaders,
        body: JSON.stringify({
          targetRevision: releaseOne.data.servedRevision,
          expectedServedRevision: releaseTwo.data.servedRevision,
          expectedPublicationVersion: releaseTwo.data.version,
        }),
      },
      environment,
    );
    expect(rollbackResponse.status).toBe(200);

    const rollbackState = await readPublication();
    expect(rollbackState.data.servedRevision).toBeGreaterThan(releaseTwo.data.servedRevision);
    expect(rollbackState.data.servedManifest).toMatchObject({
      speakerProjectionId: releaseOne.data.servedManifest.speakerProjectionId,
      speakerRevisionNumber: releaseOne.data.servedManifest.speakerRevisionNumber,
      speakerSourceHash: releaseOne.data.servedManifest.speakerSourceHash,
    });
    const rolledBackSpeakers = await readPublicSpeakers();
    expect(rolledBackSpeakers.data.speakers).toEqual(initialSpeakers.data.speakers);
    const rolledBackHeadshot = await freshApp.request(
      initialSpeaker.photoUrl,
      undefined,
      environment,
    );
    expect(rolledBackHeadshot.status).toBe(200);
    expect(new Uint8Array(await rolledBackHeadshot.arrayBuffer())).toEqual(initialHeadshotBytes);
  }, 45_000);

  it("lists only events with a served public release", async () => {
    const app = createApp(dependencies);
    const response = await app.request("/api/public/events", undefined, environment);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: readonly {
        events: readonly { slug: string }[];
      }[];
    };
    const eventSlugs = payload.data.flatMap(({ events }) => events.map(({ slug }) => slug));
    expect(eventSlugs).toContain("demo-event");
    expect(eventSlugs).not.toContain("open-sessionboard-conf");
  });

  it("hands accepted evaluation decisions into canonical session and speaker state", async () => {
    const decision = await dependencies.evaluations?.service.getDecision(
      evaluator,
      "local-evaluation-plan",
      "submission_local_1",
    );
    const sessions = await dependencies.sessions?.service.listSessions(organizer, {
      eventId: "demo-event",
      limit: 100,
    });
    const portal = await dependencies.speaker?.service.getPortal("demo-event", "local-speaker");
    if (portal === undefined) throw new Error("Expected the local speaker portal service.");

    expect(decision?.status).toBe("accepted");
    expect(sessions).toContainEqual(
      expect.objectContaining({
        id: "session-submission_local_1",
        eventId: "demo-event",
        status: "Accepted",
        speakerIds: ["local-participant"],
      }),
    );
    expect(portal.submissions).toContainEqual(
      expect.objectContaining({ id: "submission_local_1", status: "accepted" }),
    );
    expect(portal.profiles).toContainEqual(
      expect.objectContaining({ participantId: "local-participant", status: "accepted" }),
    );
    expect(portal.tasks).toContainEqual(
      expect.objectContaining({
        subject: {
          type: "session",
          participantId: "local-participant",
          sessionId: "session-submission_local_1",
        },
        participantId: "local-participant",
        status: "not_started",
      }),
    );
  });

  it("grants accepted manual speaker invitations participant-only task scope", async () => {
    const repository = new LocalSpeakerRepository(() => null);
    await repository.createTask({
      task: {
        id: "manual-participant-task",
        tenantId: LOCAL_ORGANIZATION_ID,
        eventId: "demo-event",
        participantId: "manual-participant",
        subject: { type: "participant", participantId: "manual-participant" },
        type: "form",
        owner: "speaker",
        title: "Complete profile",
        status: "not_started",
        dependencyIds: [],
        reminderOffsetsMinutes: [],
        version: 1,
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
      expectedVersion: null,
      actorAccountId: "local-organizer",
    });
    repository.acceptSpeakerInvitation(
      "manual-speaker-account",
      "demo-event",
      "manual-participant",
    );

    const scope = await repository.getAccessScope("demo-event", "manual-speaker-account");
    const tasks = await repository.listTasks("demo-event", scope.participantIds);

    expect(scope).toMatchObject({
      tenantId: LOCAL_ORGANIZATION_ID,
      submissionIds: [],
      participantIds: ["manual-participant"],
      primaryParticipantId: "manual-participant",
    });
    expect(tasks.map((task) => task.id)).toEqual(["manual-participant-task"]);
  });
  it("replays manual speaker creation and validates session speakers against active canonical state", async () => {
    const app = createApp(createLocalDependencies());
    const headers = {
      "content-type": "application/json",
      cookie: "better-auth.session_token=local-session",
    };
    const speakerEndpoint = `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/speakers`;
    const sessionEndpoint = `/api/admin/organizations/${LOCAL_ORGANIZATION_ID}/events/demo-event/sessions`;
    const speakerInput = {
      idempotencyKey: "local-manual-speaker-replay",
      sourceType: "manual",
      displayName: "Replay Speaker",
      email: "replay-speaker@local.eventloom.test",
      jobTitle: "Staff Engineer",
      company: "Local QA",
      biography: "Tests local canonical speaker lifecycle invariants.",
      socialLinks: {},
      status: "active",
    };

    const createdResponse = await app.request(
      speakerEndpoint,
      { method: "POST", headers, body: JSON.stringify(speakerInput) },
      environment,
    );
    const replayResponse = await app.request(
      speakerEndpoint,
      { method: "POST", headers, body: JSON.stringify(speakerInput) },
      environment,
    );

    expect(createdResponse.status).toBe(201);
    expect(replayResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      data: { speakers: readonly { participantId: string; email: string; version: number }[] };
    };
    const replayed = (await replayResponse.json()) as typeof created;
    const createdSpeaker = created.data.speakers.find(({ email }) => email === speakerInput.email);
    const replayedSpeakers = replayed.data.speakers.filter(
      ({ email }) => email === speakerInput.email,
    );
    expect(createdSpeaker).toBeDefined();
    expect(replayedSpeakers).toEqual([
      expect.objectContaining({ participantId: createdSpeaker?.participantId }),
    ]);
    if (createdSpeaker === undefined) throw new Error("Expected the manual speaker to be created.");

    const activeSessionResponse = await app.request(
      sessionEndpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "local-active-speaker-session",
          title: "Active speaker assignment",
          durationMinutes: 30,
          speakerIds: [createdSpeaker.participantId],
        }),
      },
      environment,
    );
    expect(activeSessionResponse.status).toBe(201);

    const revokeResponse = await app.request(
      `${speakerEndpoint}/${encodeURIComponent(createdSpeaker.participantId)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          expectedVersion: createdSpeaker.version,
          displayName: speakerInput.displayName,
          email: speakerInput.email,
          jobTitle: speakerInput.jobTitle,
          company: speakerInput.company,
          biography: speakerInput.biography,
          socialLinks: speakerInput.socialLinks,
          status: "revoked",
        }),
      },
      environment,
    );
    expect(revokeResponse.status).toBe(200);

    const revokedSessionResponse = await app.request(
      sessionEndpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "local-revoked-speaker-session",
          title: "Revoked speaker assignment",
          durationMinutes: 30,
          speakerIds: [createdSpeaker.participantId],
        }),
      },
      environment,
    );
    expect(revokedSessionResponse.status).toBe(404);
    await expect(revokedSessionResponse.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    const unknownSessionResponse = await app.request(
      sessionEndpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "local-unknown-speaker-session",
          title: "Unknown speaker assignment",
          durationMinutes: 30,
          speakerIds: ["unknown-local-participant"],
        }),
      },
      environment,
    );
    expect(unknownSessionResponse.status).toBe(404);
    await expect(unknownSessionResponse.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("builds local report rows from canonical accepted sessions", async () => {
    const reportService = dependencies.reports?.service;
    expect(reportService).toBeDefined();
    if (reportService === undefined) return;

    const run = await reportService.runDefinition(
      {
        tenantId: "local-organization",
        userId: "local-organizer",
        kind: "human",
        grants: [{ eventId: "demo-event", role: "organizer" }],
      },
      "local-program-report",
      { format: "csv" },
    );

    expect(run.export.body).toContain("session-submission_local_1");
    expect(run.export.body).not.toContain("local-session-keynote");
  });
});
