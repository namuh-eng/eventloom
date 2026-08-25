import type { D1Database, DurableObjectNamespace, Queue } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../../app";
import type { Submission } from "../../../features/cfp/model";
import type { CfpRepository } from "../../../features/cfp/service";
import type { Session, SessionRepository } from "../../../features/sessions/types";
import type { SpeakerAsset } from "../../../features/speaker/types";
import {
  AirtableEvaluationAcceptanceHandoff,
  createD1ApplicationDependencies,
} from "../../../runtime/airtable";
import { D1BetterAuthGateway } from "../../../runtime/cloudflare";
import {
  createD1RuntimeDependencies,
  createRuntimeEventRoleInvitationAdapters,
} from "../../../runtime/d1";
import {
  createSpeakerLifecycleFixture,
  privateCapabilityParts,
  type SpeakerLifecycleFixture,
  speakerLifecycleIds,
} from "../../../test-support/speaker-lifecycle";
import type { CloudflareOutboxMessage } from "../bindings";
import { D1CfpRepository } from "./cfp";
import { D1EventRoleInvitationRepository } from "./event-role-invitations";
import { D1SpeakerRepository } from "./speaker";

const fixtures: SpeakerLifecycleFixture[] = [];

async function tokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const {
  organizationId,
  eventId,
  organizerAccountId,
  priyaAccountId,
  marcusAccountId,
  acceptedAccountId,
  acceptedParticipantId,
  acceptedSubmissionId,
  outsiderAccountId,
  otherOrganizationId,
  otherEventId,
  otherOrganizerAccountId,
} = speakerLifecycleIds;

it("atomically records rejected speaker asset cleanup intent", async () => {
  const fixture = createSpeakerLifecycleFixture();
  fixtures.push(fixture);
  const { repository } = fixture.createPhase();
  const asset: SpeakerAsset = {
    id: "asset-rejected-cleanup",
    tenantId: organizationId,
    eventId,
    participantId: acceptedParticipantId,
    kind: "slides",
    objectKey: "speaker/private/rejected-cleanup.pdf",
    fileName: "rejected-cleanup.pdf",
    contentType: "application/pdf",
    sizeBytes: 4,
    state: "pending_upload",
    version: 1,
    versionFamilyId: "asset-rejected-cleanup",
    latestVersionId: "asset-rejected-cleanup",
    commentThreadId: "asset-thread:rejected-cleanup",
    createdAt: "2099-08-15T04:00:00.000Z",
  };
  await repository.createPendingAsset(asset);

  await expect(
    repository.finalizeAsset?.({
      eventId,
      assetId: asset.id,
      state: "rejected",
      rejectionReason: "Malware detected",
      finalizedAt: "2099-08-15T04:01:00.000Z",
      latestVersionId: asset.id,
    }),
  ).resolves.toMatchObject({ ok: true, value: { state: "rejected" } });

  expect(
    fixture.database.query<{ state: string }>(
      `SELECT state FROM speaker_assets WHERE id = '${asset.id}'`,
    ),
  ).toEqual([{ state: "rejected" }]);
  expect(
    fixture.database.query<{ topic: string; payload_json: string }>(
      `SELECT topic, payload_json FROM outbox_jobs WHERE topic = 'file-scan'`,
    ),
  ).toEqual([
    {
      topic: "file-scan",
      payload_json: JSON.stringify({
        kind: "private_object_delete",
        source: "speaker",
        tenantId: organizationId,
        eventId,
        assetId: asset.id,
        objectKey: asset.objectKey,
      }),
    },
  ]);
});

async function createAndAcceptSpeakerInvitation(input: {
  database: D1Database;
  invitationId: string;
  creationIdempotencyKey: string;
  participantId: string;
  accountId: string;
  email: string;
  invitedAt: string;
  acceptedAt: string;
}): Promise<void> {
  const invitations = new D1EventRoleInvitationRepository(input.database);
  const invitation = await invitations.create({
    id: input.invitationId,
    organizationId,
    eventId,
    role: "speaker",
    recipientUserId: input.accountId,
    normalizedEmail: input.email,
    participantId: input.participantId,
    creationIdempotencyKey: input.creationIdempotencyKey,
    invitedByActorType: "user",
    invitedByActorId: organizerAccountId,
    invitedAt: input.invitedAt,
  });
  const accepted = await invitations.accept({
    invitationId: invitation.id,
    recipientUserId: input.accountId,
    normalizedEmail: input.email,
    expectedVersion: invitation.version,
    occurredAt: input.acceptedAt,
  });
  expect(accepted).toMatchObject({
    id: input.invitationId,
    participantId: input.participantId,
    recipientUserId: input.accountId,
    status: "accepted",
    version: invitation.version + 1,
  });
}

async function publishHeadshotScenario(input: {
  readonly workflow: "profile" | "task";
  readonly release: boolean;
  readonly seedOrphanProjection?: boolean;
}) {
  const fixture = createSpeakerLifecycleFixture();
  fixtures.push(fixture);
  const database = fixture.database as unknown as D1Database;
  const organizerService = fixture.createPhase().service;
  const participantId = acceptedParticipantId;
  const participantAccountId = acceptedAccountId;
  fixture.database.executeScript(`
    UPDATE auth_users SET email = 'accepted@example.com' WHERE id = '${participantAccountId}';
    UPDATE participants
       SET email = 'accepted@example.com', normalized_email = 'accepted@example.com'
     WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
       AND id = '${participantId}';
    INSERT INTO session_statuses
      (id,organization_id,event_id,value,name,description,agenda_eligible,sort_order,active,version,created_at,updated_at)
    VALUES
      ('status-accepted','${organizationId}','${eventId}','Accepted','Accepted','',1,0,1,1,
       '2099-08-15T04:00:00.000Z','2099-08-15T04:00:00.000Z');
  `);
  const grantSubmission: Submission = {
    id: acceptedSubmissionId,
    tenantId: organizationId,
    eventId,
    formId: "accepted-form",
    ownerAccountId: participantAccountId,
    formVersion: 1,
    version: 1,
    status: "submitted",
    completedSteps: [],
    answers: { title: "Public headshot session" },
    participants: [
      {
        id: participantId,
        firstName: "Accepted",
        lastName: "Speaker",
        email: "accepted@example.com",
        role: "primary",
        biography: "Accepted speaker biography.",
        answers: {},
      },
    ],
    secondaryContacts: [],
    createdAt: "2099-08-15T04:00:00.000Z",
    updatedAt: "2099-08-15T04:00:00.000Z",
    submittedAt: "2099-08-15T04:00:00.000Z",
  };
  await new AirtableEvaluationAcceptanceHandoff({
    cfp: {
      async getSubmission() {
        return grantSubmission;
      },
    } as unknown as CfpRepository,
    speakers: new D1SpeakerRepository(database),
    sessions: {
      async getSession() {
        return null;
      },
      async listTracks() {
        return [];
      },
      async listFormats() {
        return [];
      },
      async listTags() {
        return [];
      },
      async listLevels() {
        return [];
      },
      async putSession(session: Session) {
        return session;
      },
      async appendAudit() {},
    } as unknown as SessionRepository,
    database,
    queue: { async send() {} } as unknown as Queue,
  }).accept({
    tenantId: organizationId,
    eventId,
    planId: "accepted-plan",
    submissionId: acceptedSubmissionId,
    decisionId: "accepted-decision",
    decidedBy: organizerAccountId,
    decidedAt: "2099-08-15T04:00:00.000Z",
    reason: "Accepted before granting speaker access.",
    idempotencyKey: `grant-public-headshot-${input.workflow}-${input.release}`,
  });
  await createAndAcceptSpeakerInvitation({
    database,
    invitationId: `event-role-invitation:speaker:${eventId}:${participantId}`,
    creationIdempotencyKey: `evaluation-acceptance:${acceptedSubmissionId}:${participantId}`,
    participantId,
    accountId: participantAccountId,
    email: "accepted@example.com",
    invitedAt: "2099-08-15T04:01:00.000Z",
    acceptedAt: "2099-08-15T04:02:00.000Z",
  });

  const participantService = fixture.createPhase().service;
  let taskId: string | undefined;
  if (input.workflow === "task") {
    const assigned = await organizerService.createOrganizerTask({
      eventId,
      accountId: organizerAccountId,
      type: "upload",
      title: "Upload headshot",
      description: "Upload the headshot for the public speaker gallery.",
      acceptedAssetKinds: ["headshot"],
      allowedMimeTypes: ["image/png"],
      maxBytes: 100_000,
      assignments: [{ participantId, subject: { type: "participant" } }],
    });
    taskId = assigned[0]?.id;
    expect(taskId).toBeDefined();
  }

  const bytes = new TextEncoder().encode(`published-${input.workflow}-headshot`);
  const authorization = await participantService.issueUploadGrant({
    eventId,
    accountId: participantAccountId,
    participantId,
    ...(taskId === undefined ? {} : { taskId }),
    kind: "headshot",
    fileName: "priya.png",
    contentType: "image/png",
    sizeBytes: bytes.byteLength,
  });
  const capability = privateCapabilityParts(authorization.grant.url);
  await participantService.consumeUploadCapability(
    capability.capabilityId,
    capability.token,
    new Request("https://api.example.test/private-upload", {
      method: "PUT",
      headers: {
        "content-type": "image/png",
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
    }),
  );
  const asset = await participantService.finalizeUpload({
    eventId,
    accountId: participantAccountId,
    assetId: authorization.asset.id,
    state: "ready",
  });

  if (taskId === undefined) {
    const profile = (await participantService.listProfiles(eventId, participantAccountId)).find(
      (candidate) => candidate.participantId === participantId,
    );
    if (profile === undefined) throw new Error("Expected the admitted speaker profile.");
    await participantService.updateProfile({
      eventId,
      accountId: participantAccountId,
      participantId,
      headshotAssetId: asset.id,
      expectedVersion: profile.version,
    });
  } else {
    const task = (await participantService.listTasks(eventId, participantAccountId)).find(
      (candidate) => candidate.id === taskId,
    );
    if (task === undefined) throw new Error("Expected the assigned headshot task.");
    await participantService.transitionTask({
      eventId,
      accountId: participantAccountId,
      taskId,
      toStatus: "submitted",
      expectedVersion: task.version,
      note: "Uploaded priya.png",
    });
  }

  await fixture.createPhase().service.reviewAsset({
    eventId,
    accountId: organizerAccountId,
    assetId: asset.id,
    state: "approved",
    release: input.release,
    expectedVersion: 0,
  });

  const businessRepositories = createD1RuntimeDependencies({ DB: database });
  const profile = await businessRepositories.speaker.getProfile(eventId, participantId);
  const submission: Submission = {
    id: acceptedSubmissionId,
    tenantId: organizationId,
    eventId,
    formId: "accepted-form",
    ownerAccountId: participantAccountId,
    formVersion: 1,
    version: 1,
    status: "submitted",
    completedSteps: [],
    answers: { title: "Public headshot session" },
    participants: [
      {
        id: participantId,
        firstName: "Accepted",
        lastName: "Speaker",
        email: "accepted@example.com",
        role: "primary",
        biography: "Accepted speaker biography.",
        answers: {},
      },
    ],
    secondaryContacts: [],
    createdAt: "2099-08-15T04:00:00.000Z",
    updatedAt: "2099-08-15T04:00:00.000Z",
    submittedAt: "2099-08-15T04:00:00.000Z",
  };
  const queue = { async send(_message: CloudflareOutboxMessage) {} } as unknown as Queue;
  await new AirtableEvaluationAcceptanceHandoff({
    cfp: {
      async getSubmission(requestedOrganizationId: string, requestedSubmissionId: string) {
        return requestedOrganizationId === organizationId &&
          requestedSubmissionId === acceptedSubmissionId
          ? submission
          : null;
      },
    } as unknown as CfpRepository,
    speakers: businessRepositories.speaker,
    sessions: businessRepositories.sessions,
    database,
    queue,
  }).accept({
    tenantId: organizationId,
    eventId,
    planId: "accepted-plan",
    submissionId: acceptedSubmissionId,
    decisionId: "accepted-decision",
    decidedBy: organizerAccountId,
    decidedAt: "2099-08-15T04:03:00.000Z",
    reason: "Accepted for the public headshot test.",
    idempotencyKey: `accepted-public-headshot-${input.workflow}-${input.release}`,
  });
  const session = (await businessRepositories.sessions.listSessions(organizationId, eventId)).find(
    (candidate) => candidate.speakerIds.includes(participantId),
  );
  if (session === undefined) throw new Error("Expected the accepted public headshot session.");
  fixture.database.executeScript(`
    UPDATE sessions
       SET content_status = 'Approved'
     WHERE organization_id = '${organizationId}'
       AND event_id = '${eventId}'
       AND id = '${session.id}';
  `);
  try {
    await businessRepositories.sessions.putRoom(
      {
        id: "room-main",
        tenantId: organizationId,
        eventId,
        name: "Main room",
        capacity: 100,
        resources: [],
        resourceIds: [],
        version: 1,
        createdAt: "2099-08-15T04:03:00.000Z",
        updatedAt: "2099-08-15T04:03:00.000Z",
        createdBy: organizerAccountId,
        updatedBy: organizerAccountId,
        history: [],
      },
      null,
    );
  } catch (error) {
    throw new Error("Failed to persist the public headshot room.", { cause: error });
  }
  const dependencies = createD1ApplicationDependencies({
    authenticator: {
      async authenticate() {
        return null;
      },
    },
    database,
    agendaCoordinator: {
      idFromName(name: string) {
        return name;
      },
      get() {
        return {
          async fetch() {
            return Response.json({ revision: 0 });
          },
        };
      },
    } as unknown as DurableObjectNamespace,
    privateFiles: fixture.privateFiles,
    outboxQueue: {
      async send(_message: CloudflareOutboxMessage) {},
    } as unknown as Queue<CloudflareOutboxMessage>,
    webOrigin: "https://web.example.test",
    businessRepositories,
    eventRoleInvitationAdapters: createRuntimeEventRoleInvitationAdapters(
      businessRepositories.eventRoleInvitations,
    ),
    senderAddresses: {
      auth: "auth@example.test",
      speakers: "speakers@example.test",
      calendar: "calendar@example.test",
    },
    calendarIntegrationOptions: {
      organizer: "calendar@example.test",
      uidDomain: "calendar.example.test",
    },
  });
  const agenda = dependencies.agenda;
  if (agenda === undefined) throw new Error("Expected the D1 agenda dependencies.");

  await agenda.engine.createAgenda({
    eventId,
    actorId: organizerAccountId,
    minimumTravelMinutes: 0,
    sessions: [
      {
        id: session.id,
        title: session.title,
        status: session.status,
        publicApprovalEligible: true,
        participantIds: session.speakerIds,
        resourceIds: session.resourceIds,
        capacityRequired: session.capacityRequired,
        durationMinutes: session.durationMinutes,
      },
    ],
    rooms: [{ id: "room-main", name: "Main room", capacity: 100 }],
    tracks: [],
  });
  await agenda.engine.updateDraft({
    eventId,
    expectedVersion: 1,
    actorId: organizerAccountId,
    entries: [
      {
        id: "entry-public-headshot",
        sessionId: session.id,
        roomId: "room-main",
        trackIds: [],
        startsAtLocal: "2100-01-10T09:00",
        endsAtLocal: "2100-01-10T09:30",
      },
    ],
  });
  await agenda.engine.validate({
    eventId,
    expectedVersion: 2,
    actorId: organizerAccountId,
  });
  await agenda.engine.publish({
    eventId,
    expectedVersion: 2,
    actorId: organizerAccountId,
    afterPublish: async (published) => {
      if (input.seedOrphanProjection === true) {
        await database
          .prepare(
            `INSERT INTO program_speaker_projections (
              id,
              organization_id,
              event_id,
              revision_number,
              source_hash,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `${published.id}:orphaned-speaker-snapshot`,
            organizationId,
            eventId,
            published.revisionNumber,
            "orphaned-speaker-source-hash",
            published.publishedAt,
          )
          .run();
      }
      await agenda.afterPublish?.(eventId, published);
    },
  });

  return {
    app: createApp(dependencies),
    asset,
    bindings: {
      APP_ENV: "test",
      WEB_ORIGIN: "https://web.example.test",
    } as never,
    bytes,
    participantId,
    photoUrl: `/api/public/events/lifecycle-event/speakers/${encodeURIComponent(participantId)}/headshot`,
    profile,
  };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

describe("Airtable-free speaker lifecycle on canonical D1", () => {
  it("persists and reloads a published CFP URL field through canonical D1", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    const repository = new D1CfpRepository(fixture.database as unknown as D1Database);

    await repository.saveForm(
      {
        id: "url-form",
        tenantId: organizationId,
        eventId,
        name: "URL field form",
        status: "published",
        version: 1,
        welcomeContent: "Share a project link.",
        settings: {
          speakerLimit: 3,
          maxSubmissionsPerAccount: 3,
          remindersEnabled: true,
          adminNotificationsEnabled: true,
          confirmationMessage: "Received",
          successContent: "Thank you",
        },
        sections: [
          {
            id: "section-links",
            title: "Links",
            description: "Project references",
          },
        ],
        submissionFields: [
          {
            id: "field-website",
            sectionId: "section-links",
            key: "website",
            label: "Project website",
            kind: "url",
            required: false,
            options: [],
          },
        ],
        participantFields: [],
        rules: [],
      },
      null,
    );

    await expect(repository.getForm(organizationId, "url-form")).resolves.toMatchObject({
      status: "published",
      submissionFields: [
        expect.objectContaining({
          key: "website",
          kind: "url",
        }),
      ],
    });
  });

  it("persists organizer uploader provenance independently from the asset speaker", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);

    const created = await fixture.createPhase().service.createOrganizerSpeaker({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      displayName: "Distinct Asset Speaker",
      email: "distinct-asset-speaker@example.test",
      jobTitle: "Speaker",
      company: "Eventloom",
      biography: "Speaker whose organizer uploads a headshot.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "create-distinct-asset-speaker",
    });
    const participantId = created.speakers.find(
      (speaker) => speaker.email === "distinct-asset-speaker@example.test",
    )?.participantId;
    if (participantId === undefined) throw new Error("Expected the created asset speaker.");

    const authorization = await fixture.createPhase().service.issueOrganizerUploadGrant({
      eventId,
      accountId: organizerAccountId,
      participantId,
      kind: "headshot",
      fileName: "organizer-uploaded-headshot.png",
      contentType: "image/png",
      sizeBytes: 21,
    });
    expect(authorization.asset).toMatchObject({
      participantId,
      uploaderAccountId: organizerAccountId,
      uploaderLabel: "Organizer",
    });

    const reloaded = fixture.createPhase();
    await expect(
      reloaded.repository.getAsset(eventId, authorization.asset.id),
    ).resolves.toMatchObject({
      participantId,
      uploaderAccountId: organizerAccountId,
      uploaderLabel: "Organizer",
    });
    await expect(
      reloaded.service.listOrganizerAssets(eventId, organizerAccountId, participantId),
    ).resolves.toEqual([
      expect.objectContaining({
        id: authorization.asset.id,
        participantId,
        participantName: "Distinct Asset Speaker",
        uploaderAccountId: organizerAccountId,
        uploaderLabel: "Organizer",
      }),
    ]);
  });

  it("replays one canonical pending replacement from an event-scoped idempotency key", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);

    const created = await fixture.createPhase().service.createOrganizerSpeaker({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      displayName: "Replacement Replay Speaker",
      email: "replacement-replay@example.test",
      jobTitle: "Speaker",
      company: "Eventloom",
      biography: "Speaker for replacement replay coverage.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "create-replacement-replay-speaker",
    });
    const participantId = created.speakers.find(
      (speaker) => speaker.email === "replacement-replay@example.test",
    )?.participantId;
    if (participantId === undefined) throw new Error("Expected the replacement replay speaker.");

    const service = fixture.createPhase().service;
    const authorization = await service.issueOrganizerUploadGrant({
      eventId,
      accountId: organizerAccountId,
      participantId,
      kind: "headshot",
      fileName: "headshot-v1.png",
      contentType: "image/png",
      sizeBytes: 3,
    });
    const upload = privateCapabilityParts(authorization.grant.url);
    await service.consumeUploadCapability(
      upload.capabilityId,
      upload.token,
      new Request("https://api.example.test/private-upload", {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "content-length": "3",
        },
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    const ready = await service.finalizeAsset({
      eventId,
      accountId: organizerAccountId,
      assetId: authorization.asset.id,
      state: "ready",
      organizer: true,
    });
    if (ready.version === undefined) throw new Error("Expected a versioned ready asset.");
    const readyVersion = ready.version;

    const candidate = (id: string): SpeakerAsset => ({
      id,
      eventId,
      participantId,
      kind: ready.kind,
      objectKey: `events/${eventId}/participants/${participantId}/headshot/${id}`,
      fileName: "headshot-v2.png",
      contentType: ready.contentType,
      sizeBytes: ready.sizeBytes,
      state: "pending_upload",
      version: readyVersion + 1,
      versionFamilyId: ready.versionFamilyId ?? ready.id,
      supersedesAssetId: ready.id,
      versionId: id,
      latestVersionId: id,
      currentVersionId: ready.id,
      createdAt: "2099-08-15T06:00:00.000Z",
      tenantId: organizationId,
      uploaderAccountId: organizerAccountId,
      uploaderLabel: "Organizer",
    });
    const repository = fixture.createPhase().repository;
    const first = await repository.createPendingAssetVersion({
      asset: candidate("asset-replacement-a"),
      expectedLatestAssetId: ready.id,
      expectedLatestVersion: readyVersion,
      idempotencyKey: "replacement-replay-key",
      requestDigest: "replacement-replay-digest",
    });
    const replay = await repository.createPendingAssetVersion({
      asset: candidate("asset-replacement-b"),
      expectedLatestAssetId: ready.id,
      expectedLatestVersion: readyVersion,
      idempotencyKey: "replacement-replay-key",
      requestDigest: "replacement-replay-digest",
    });
    const mismatchedReplay = await repository.createPendingAssetVersion({
      asset: candidate("asset-replacement-c"),
      expectedLatestAssetId: ready.id,
      expectedLatestVersion: readyVersion,
      idempotencyKey: "replacement-replay-key",
      requestDigest: "changed-request-digest",
    });
    const losingKey = await repository.createPendingAssetVersion({
      asset: candidate("asset-replacement-d"),
      expectedLatestAssetId: ready.id,
      expectedLatestVersion: readyVersion,
      idempotencyKey: "different-replacement-key",
      requestDigest: "different-replacement-digest",
    });

    expect(first).toMatchObject({ ok: true, value: { id: "asset-replacement-a" } });
    expect(replay).toMatchObject({ ok: true, value: { id: "asset-replacement-a" } });
    expect(mismatchedReplay).toEqual({ ok: false, reason: "version_conflict" });
    expect(losingKey).toEqual({ ok: false, reason: "version_conflict" });
    const family = await repository.listAssets(eventId, [participantId]);
    expect(family).toHaveLength(2);
    expect(family).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ready.id, version: 1 }),
        expect.objectContaining({
          id: "asset-replacement-a",
          version: 2,
          supersedesAssetId: ready.id,
        }),
      ]),
    );
  });

  it("rethrows D1 failures when a rejected predecessor is unchanged", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    const phase = fixture.createPhase();
    const authorization = await phase.service.issueOrganizerUploadGrant({
      eventId,
      accountId: organizerAccountId,
      participantId: acceptedParticipantId,
      kind: "headshot",
      fileName: "rejected-predecessor.png",
      contentType: "image/png",
      sizeBytes: 3,
    });
    const upload = privateCapabilityParts(authorization.grant.url);
    await phase.service.consumeUploadCapability(
      upload.capabilityId,
      upload.token,
      new Request("https://api.example.test/private-upload", {
        method: "PUT",
        headers: { "content-type": "image/png", "content-length": "3" },
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    const rejected = await phase.service.finalizeAsset({
      eventId,
      accountId: organizerAccountId,
      assetId: authorization.asset.id,
      state: "rejected",
      rejectionReason: "The uploaded file needs replacement.",
      organizer: true,
    });
    if (rejected.version === undefined) throw new Error("Expected a versioned rejected asset.");

    const candidate: SpeakerAsset = {
      ...rejected,
      id: "rejected-successor",
      state: "pending_upload",
      version: rejected.version + 1,
      versionId: "rejected-successor",
      supersedesAssetId: rejected.id,
      latestVersionId: "rejected-successor",
      currentVersionId: rejected.id,
      objectKey: "events/event-1/participants/accepted-participant/headshot/rejected-successor",
      createdAt: "2099-08-15T06:00:00.000Z",
    };
    fixture.database.beforeNextBatch(() => {
      throw new Error("d1 unavailable");
    });

    await expect(
      phase.repository.createPendingAssetVersion({
        asset: candidate,
        expectedLatestAssetId: rejected.id,
        expectedLatestVersion: rejected.version,
        idempotencyKey: "rejected-successor-d1-failure",
        requestDigest: "rejected-successor-d1-failure-digest",
      }),
    ).rejects.toThrow("d1 unavailable");
  });

  it("roundtrips organizer, participant, task, profile, and private-headshot state", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    const createPhase = fixture.createPhase;

    let priyaParticipantId = "";
    let marcusParticipantId = "";
    {
      const { service } = createPhase();
      const admitted = await service.createOrganizerSpeaker({
        organizationId,
        eventId,
        accountId: organizerAccountId,
        displayName: "Accepted Speaker",
        email: "accepted@example.test",
        jobTitle: "Platform Engineer",
        company: "Accepted Co",
        biography: "Accepted speaker biography.",
        socialLinks: {},
        status: "confirmed",
        idempotencyKey: "admit-accepted-speaker",
        sourceType: "cfp",
        sourceId: acceptedSubmissionId,
        explicitParticipantId: acceptedParticipantId,
      });
      expect(admitted.speakers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            participantId: acceptedParticipantId,
            status: "confirmed",
            sessions: [
              expect.objectContaining({
                submissionId: `speaker-submission:${acceptedSubmissionId}`,
                status: "accepted",
              }),
            ],
          }),
        ]),
      );

      const created = await service.createOrganizerSpeaker({
        organizationId,
        eventId,
        accountId: organizerAccountId,
        displayName: "Priya Nair",
        email: "priya@example.test",
        jobTitle: "Staff Engineer",
        company: "Durable Systems",
        biography: "Initial Priya biography.",
        socialLinks: {},
        status: "confirmed",
        idempotencyKey: "create-priya",
      });
      priyaParticipantId =
        created.speakers.find((speaker) => speaker.email === "priya@example.test")?.participantId ??
        "";
      expect(priyaParticipantId).not.toBe("");

      const preview = await service.previewSpeakerImport({
        organizationId,
        eventId,
        accountId: organizerAccountId,
        csv: [
          "displayName,email,jobTitle,company,biography,status,linkedin",
          "Marcus Chen,marcus@example.test,Developer Advocate,Cloud Co,Marcus biography,confirmed,https://linkedin.com/in/marcus-chen",
        ].join("\n"),
      });
      expect(preview.invalidRows).toEqual([]);
      if (preview.previewId === undefined || preview.sourceDigest === undefined) {
        throw new Error("Expected a durable server-issued import preview.");
      }
      const imported = await service.commitSpeakerImport({
        organizationId,
        eventId,
        accountId: organizerAccountId,
        previewId: preview.previewId,
        sourceDigest: preview.sourceDigest,
        idempotencyKey: "import-marcus",
      });
      expect(imported.speakers).toHaveLength(3);
      marcusParticipantId =
        imported.speakers.find((speaker) => speaker.email === "marcus@example.test")
          ?.participantId ?? "";
      expect(marcusParticipantId).not.toBe("");
    }

    for (const [participantId, accountId, email] of [
      [acceptedParticipantId, acceptedAccountId, "accepted@example.test"],
      [priyaParticipantId, priyaAccountId, "priya@example.test"],
      [marcusParticipantId, marcusAccountId, "marcus@example.test"],
    ] as const) {
      await createAndAcceptSpeakerInvitation({
        database: fixture.database as unknown as D1Database,
        invitationId: `event-invitation:lifecycle:${participantId}`,
        creationIdempotencyKey: `event-invitation:lifecycle:${participantId}`,
        participantId,
        accountId,
        email,
        invitedAt: "2099-08-15T04:01:00.000Z",
        acceptedAt: "2099-08-15T04:02:00.000Z",
      });
    }

    {
      for (const [accountId, token] of [
        [priyaAccountId, "manual-speaker-session"],
        [marcusAccountId, "imported-speaker-session"],
      ] as const) {
        await fixture.database
          .prepare(
            `INSERT INTO auth_sessions
               (id,user_id,token_digest,expires_at,created_at,updated_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .bind(
            `session:${accountId}`,
            accountId,
            await tokenDigest(token),
            "2100-08-15T04:00:00.000Z",
            "2099-08-15T04:00:00.000Z",
            "2099-08-15T04:00:00.000Z",
          )
          .run();
      }
      const gateway = new D1BetterAuthGateway(fixture.database as unknown as D1Database);
      await expect(gateway.resolveSession("manual-speaker-session")).resolves.toMatchObject({
        userId: priyaAccountId,
        speakerGrants: [
          {
            organizationId,
            speakerProfileId: `profile:${eventId}:${priyaParticipantId}`,
          },
        ],
      });
      await expect(gateway.resolveSession("imported-speaker-session")).resolves.toMatchObject({
        userId: marcusAccountId,
        speakerGrants: [
          {
            organizationId,
            speakerProfileId: `profile:${eventId}:${marcusParticipantId}`,
          },
        ],
      });
    }

    {
      const { repository, service } = createPhase();
      const priyaScope = await repository.getAccessScope(eventId, priyaAccountId);
      expect(priyaScope).toMatchObject({
        tenantId: organizationId,
        participantIds: [priyaParticipantId],
      });
      expect(priyaScope.capabilitiesByParticipant?.[priyaParticipantId]).toEqual(
        expect.arrayContaining(["profile-self", "task-response", "asset-read", "asset-write"]),
      );
      const acceptedScope = await repository.getAccessScope(eventId, acceptedAccountId);
      expect(acceptedScope).toMatchObject({
        tenantId: organizationId,
        submissionIds: [acceptedSubmissionId],
        participantIds: [acceptedParticipantId],
      });
      expect(acceptedScope.capabilitiesByParticipant?.[acceptedParticipantId]).toEqual(
        expect.arrayContaining(["profile-self", "task-response", "asset-read", "asset-write"]),
      );
      await expect(repository.listPortalContexts(priyaAccountId)).resolves.toEqual([
        expect.objectContaining({
          organizationId,
          eventId,
          participantIds: [priyaParticipantId],
        }),
      ]);
      await expect(service.listProfiles(eventId, priyaAccountId)).resolves.toEqual([
        expect.objectContaining({ participantId: priyaParticipantId }),
      ]);
      await expect(service.listProfiles(eventId, outsiderAccountId)).resolves.toEqual([]);
      await expect(
        service.listOrganizerSpeakerRoster(otherOrganizationId, eventId, organizerAccountId),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        service.listOrganizerSpeakerRoster(organizationId, otherEventId, organizerAccountId),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }

    {
      const { service } = createPhase();
      const roster = await service.listOrganizerSpeakerRoster(
        organizationId,
        eventId,
        organizerAccountId,
      );
      const priya = roster.speakers.find((speaker) => speaker.participantId === priyaParticipantId);
      if (priya === undefined) throw new Error("Expected Priya in the organizer roster.");
      await service.updateOrganizerSpeaker({
        organizationId,
        eventId,
        accountId: organizerAccountId,
        participantId: priyaParticipantId,
        expectedVersion: priya.version,
        displayName: priya.displayName,
        email: priya.email,
        jobTitle: priya.jobTitle,
        company: priya.company,
        biography: priya.biography,
        socialLinks: priya.socialLinks,
        status: "travel_confirmed",
        travelLogistics: {
          travelRequired: true,
          arrivalAt: "2100-01-09",
          accommodation: "Conference hotel",
          dietaryRequirements: "Vegetarian",
          travelNotes: "Airport transfer requested.",
        },
      });
    }

    const priyaTaskIds: string[] = [];
    let marcusTaskId = "";
    {
      const { service } = createPhase();
      for (const [title, participantId] of [
        ["Confirm badge name", priyaParticipantId],
        ["Confirm travel details", priyaParticipantId],
        ["Review event guide", marcusParticipantId],
      ] as const) {
        const assigned = await service.assignOrganizerSpeakerTask({
          organizationId,
          eventId,
          accountId: organizerAccountId,
          title,
          description: `${title} before arrival.`,
          dueAt: "2100-01-01",
          assignments: [{ participantId, subject: { type: "participant" } }],
        });
        const taskId = assigned.tasks[0]?.taskId;
        if (taskId === undefined) throw new Error("Expected a persisted general speaker task.");
        if (participantId === priyaParticipantId) priyaTaskIds.push(taskId);
        else marcusTaskId = taskId;
      }
      expect(priyaTaskIds).toHaveLength(2);
      expect(marcusTaskId).not.toBe("");
    }

    {
      const { service } = createPhase();
      const portalTasks = await service.listTasks(eventId, priyaAccountId);
      expect(portalTasks.map((task) => task.id).sort()).toEqual([...priyaTaskIds].sort());
      for (const taskId of priyaTaskIds) {
        const task = portalTasks.find((candidate) => candidate.id === taskId);
        if (task === undefined) throw new Error("Expected Priya's portal task.");
        await service.transitionTask({
          eventId,
          accountId: priyaAccountId,
          taskId,
          toStatus: "completed",
          expectedVersion: task.version,
        });
      }
    }

    {
      const { service } = createPhase();
      const roster = await service.listOrganizerSpeakerRoster(
        organizationId,
        eventId,
        organizerAccountId,
      );
      expect(
        roster.speakers.find((speaker) => speaker.participantId === priyaParticipantId)
          ?.taskSummary,
      ).toEqual({ total: 2, completed: 2, overdue: 0 });
      expect(
        roster.speakers.find((speaker) => speaker.participantId === marcusParticipantId)
          ?.taskSummary,
      ).toEqual({ total: 1, completed: 0, overdue: 0 });
      const allTasks = await service.listOrganizerSpeakerTasks(
        organizationId,
        eventId,
        organizerAccountId,
      );
      expect(allTasks.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: priyaTaskIds[0], status: "completed" }),
          expect.objectContaining({ taskId: priyaTaskIds[1], status: "completed" }),
          expect.objectContaining({ taskId: marcusTaskId, status: "not_started" }),
        ]),
      );
    }

    {
      const { service } = createPhase();
      const portalProfiles = await service.listProfiles(eventId, priyaAccountId);
      const profile = portalProfiles.find(
        (candidate) => candidate.participantId === priyaParticipantId,
      );
      if (profile === undefined) throw new Error("Expected Priya's portal profile.");
      await service.updateProfile({
        eventId,
        accountId: priyaAccountId,
        participantId: priyaParticipantId,
        biography: "Priya's participant-edited biography.",
        socialLinks: {
          linkedin: "https://linkedin.com/in/priya-nair",
          website: "https://priya.example.test",
        },
        expectedVersion: profile.version,
      });
    }

    {
      const { service } = createPhase();
      await expect(
        service.getOrganizerSpeaker(
          organizationId,
          eventId,
          organizerAccountId,
          priyaParticipantId,
        ),
      ).resolves.toMatchObject({
        biography: "Priya's participant-edited biography.",
        socialLinks: {
          linkedin: "https://linkedin.com/in/priya-nair",
          website: "https://priya.example.test",
        },
        status: "travel_confirmed",
        travelLogistics: expect.objectContaining({
          travelRequired: true,
          accommodation: "Conference hotel",
          dietaryRequirements: "Vegetarian",
        }),
      });
    }

    const headshotBytes = new TextEncoder().encode("fake-png-headshot");
    let headshotAssetId = "";
    {
      const { service } = createPhase();
      const authorization = await service.issueUploadGrant({
        eventId,
        accountId: priyaAccountId,
        participantId: priyaParticipantId,
        kind: "headshot",
        fileName: "priya.png",
        contentType: "image/png",
        sizeBytes: headshotBytes.byteLength,
      });
      headshotAssetId = authorization.asset.id;
      expect(authorization.asset).toMatchObject({
        participantId: priyaParticipantId,
        kind: "headshot",
        state: "pending_upload",
      });
      expect(authorization.asset.sessionId).toBeUndefined();
      const uploadCapability = privateCapabilityParts(authorization.grant.url);
      await service.consumeUploadCapability(
        uploadCapability.capabilityId,
        uploadCapability.token,
        new Request("https://api.example.test/private-upload", {
          method: "PUT",
          headers: {
            "content-type": "image/png",
            "content-length": String(headshotBytes.byteLength),
          },
          body: headshotBytes,
        }),
      );
      await service.finalizeUpload({
        eventId,
        accountId: priyaAccountId,
        assetId: headshotAssetId,
        state: "ready",
      });
    }

    {
      const { service } = createPhase();
      const portalProfiles = await service.listProfiles(eventId, priyaAccountId);
      const profile = portalProfiles.find(
        (candidate) => candidate.participantId === priyaParticipantId,
      );
      if (profile === undefined) throw new Error("Expected Priya's reloaded portal profile.");
      await service.updateProfile({
        eventId,
        accountId: priyaAccountId,
        participantId: priyaParticipantId,
        headshotAssetId,
        expectedVersion: profile.version,
      });
    }

    {
      const { service } = createPhase();
      await expect(
        service.getOrganizerSpeaker(
          organizationId,
          eventId,
          organizerAccountId,
          priyaParticipantId,
        ),
      ).resolves.toMatchObject({ headshotAssetId });
      await expect(
        service.listOrganizerSpeakerAssets(
          organizationId,
          eventId,
          organizerAccountId,
          priyaParticipantId,
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          assetId: headshotAssetId,
          kind: "headshot",
          fileName: "priya.png",
          contentType: "image/png",
          byteSize: headshotBytes.byteLength,
          status: "ready",
        }),
      ]);
      const [uploadRow] = fixture.database.query<{
        object_key: string;
        content_type: string;
        byte_size: number;
      }>(
        `SELECT object_key, content_type, byte_size
           FROM private_uploads
          WHERE id = ${sqlString(headshotAssetId)}`,
      );
      if (uploadRow === undefined) throw new Error("Expected the persisted headshot upload row.");
      const legacyToken = "legacy-download-capability-token-0001";
      fixture.database.executeScript(
        `UPDATE private_uploads
            SET state = 'uploaded',
                scan_result_code = ${sqlString(
                  JSON.stringify({
                    kind: "download",
                    capabilityHash: await tokenDigest(legacyToken),
                    tenantId: organizationId,
                    eventId,
                    subject: { kind: "participant" },
                    participantId: priyaParticipantId,
                    objectKey: uploadRow.object_key,
                    contentType: uploadRow.content_type,
                    sizeBytes: uploadRow.byte_size,
                    fileName: "priya.png",
                    expiresAt: "2099-08-15T04:02:00.000Z",
                  }),
                )}
          WHERE id = ${sqlString(headshotAssetId)};`,
      );
      await expect(
        service.consumeDownloadCapability(headshotAssetId, legacyToken),
      ).rejects.toMatchObject({ code: "CAPABILITY_INVALID" });

      const firstGrant = await service.issueOrganizerDownloadGrant({
        eventId,
        accountId: organizerAccountId,
        assetId: headshotAssetId,
      });
      const secondGrant = await service.issueOrganizerDownloadGrant({
        eventId,
        accountId: organizerAccountId,
        assetId: headshotAssetId,
      });
      expect(firstGrant.url).not.toBe(secondGrant.url);

      const firstDownloadCapability = privateCapabilityParts(firstGrant.url);
      const firstDownload = await service.consumeDownloadCapability(
        firstDownloadCapability.capabilityId,
        firstDownloadCapability.token,
      );
      expect(firstDownload).toMatchObject({
        contentType: "image/png",
        sizeBytes: headshotBytes.byteLength,
        fileName: "priya.png",
      });
      expect(new Uint8Array(await new Response(firstDownload.body).arrayBuffer())).toEqual(
        headshotBytes,
      );

      const secondDownloadCapability = privateCapabilityParts(secondGrant.url);
      const secondDownload = await service.consumeDownloadCapability(
        secondDownloadCapability.capabilityId,
        secondDownloadCapability.token,
      );
      expect(secondDownload).toMatchObject({
        contentType: "image/png",
        sizeBytes: headshotBytes.byteLength,
        fileName: "priya.png",
      });
      expect(new Uint8Array(await new Response(secondDownload.body).arrayBuffer())).toEqual(
        headshotBytes,
      );

      const racedGrant = await service.issueOrganizerDownloadGrant({
        eventId,
        accountId: organizerAccountId,
        assetId: headshotAssetId,
      });
      const racedCapability = privateCapabilityParts(racedGrant.url);
      const racedResults = await Promise.allSettled([
        service.consumeDownloadCapability(racedCapability.capabilityId, racedCapability.token),
        service.consumeDownloadCapability(racedCapability.capabilityId, racedCapability.token),
      ]);
      const fulfilledRaces = racedResults.filter((result) => result.status === "fulfilled");
      const rejectedRaces = racedResults.filter((result) => result.status === "rejected");
      expect(fulfilledRaces).toHaveLength(1);
      expect(rejectedRaces).toHaveLength(1);
      expect(
        new Uint8Array(await new Response(fulfilledRaces[0]?.value.body).arrayBuffer()),
      ).toEqual(headshotBytes);

      await expect(
        service.issueOrganizerDownloadGrant({
          eventId,
          accountId: otherOrganizerAccountId,
          assetId: headshotAssetId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(service.listAssets(eventId, outsiderAccountId)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }

    {
      const { service } = createPhase();
      const marcus = await service.getOrganizerSpeaker(
        organizationId,
        eventId,
        organizerAccountId,
        marcusParticipantId,
      );
      await service.updateOrganizerSpeaker({
        organizationId,
        eventId,
        accountId: organizerAccountId,
        participantId: marcusParticipantId,
        expectedVersion: marcus.version,
        displayName: marcus.displayName,
        email: marcus.email,
        jobTitle: marcus.jobTitle,
        company: marcus.company,
        biography: marcus.biography,
        socialLinks: marcus.socialLinks,
        travelLogistics: marcus.travelLogistics,
        status: "revoked",
      });
    }

    {
      const { repository, service } = createPhase();
      await expect(repository.getAccessScope(eventId, marcusAccountId)).resolves.toEqual({
        submissionIds: [],
        participantIds: [],
      });
      await expect(
        service.getOrganizerSpeaker(
          organizationId,
          eventId,
          organizerAccountId,
          marcusParticipantId,
        ),
      ).resolves.toMatchObject({ status: "revoked" });
      await expect(repository.getAccessScope(otherEventId, priyaAccountId)).resolves.toEqual({
        submissionIds: [],
        participantIds: [],
      });
    }
  }, 120_000);

  it("durably replaces reminder offsets and records the winning organizer audit", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    const firstPhase = fixture.createPhase();
    const admitted = await firstPhase.service.createOrganizerSpeaker({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      displayName: "Reminder Speaker",
      email: "reminder-speaker@example.test",
      jobTitle: "Engineer",
      company: "Example",
      biography: "Reminder lifecycle speaker.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "reminder-offset-speaker",
    });
    const participantId = admitted.speakers[0]?.participantId;
    if (participantId === undefined) throw new Error("Expected an admitted speaker.");
    const [created] = await firstPhase.service.createOrganizerTask({
      eventId,
      accountId: organizerAccountId,
      type: "upload",
      title: "Upload reminder deck",
      dueAt: "2099-09-01",
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 1_000_000,
      acceptedAssetKinds: ["slides"],
      reminderOffsetsMinutes: [60],
      assignments: [{ participantId, subject: { type: "participant" } }],
    });
    if (created === undefined) throw new Error("Expected a reminder task.");

    await expect(
      firstPhase.service.updateOrganizerTaskReminderOffsets({
        organizationId,
        eventId,
        accountId: organizerAccountId,
        taskId: created.id,
        expectedVersion: created.version,
        reminderOffsetsMinutes: [10_080, 0, 1_440],
      }),
    ).resolves.toMatchObject({
      reminderOffsetsMinutes: [0, 1_440, 10_080],
      version: 2,
    });

    const restarted = fixture.createPhase();
    await expect(restarted.repository.getTask(eventId, created.id)).resolves.toMatchObject({
      reminderOffsetsMinutes: [0, 1_440, 10_080],
      version: 2,
    });
    expect(
      fixture.database.query<{ actor_id: string; action: string; details_json: string }>(
        `SELECT actor_id, action, details_json FROM audit_events WHERE resource_type = 'speaker_task' AND resource_id = ${sqlString(created.id)}`,
      ),
    ).toEqual([
      expect.objectContaining({
        actor_id: organizerAccountId,
        action: "speaker_task.reminder_offsets_updated",
        details_json: expect.stringContaining('"reminderOffsetsMinutes":[0,1440,10080]'),
      }),
    ]);
  });

  it("leaves task offsets and audit unchanged when a stale D1 CAS loses", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    const { service } = fixture.createPhase();
    const admitted = await service.createOrganizerSpeaker({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      displayName: "Task CAS Speaker",
      email: "task-cas@example.test",
      jobTitle: "Engineer",
      company: "Example",
      biography: "Task CAS lifecycle speaker.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "task-cas-speaker",
    });
    const participantId = admitted.speakers[0]?.participantId;
    if (participantId === undefined) throw new Error("Expected a task CAS speaker.");
    const [created] = await service.createOrganizerTask({
      eventId,
      accountId: organizerAccountId,
      type: "upload",
      title: "Upload CAS deck",
      dueAt: "2099-09-01",
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 1_000_000,
      acceptedAssetKinds: ["slides"],
      reminderOffsetsMinutes: [60],
      assignments: [{ participantId, subject: { type: "participant" } }],
    });
    if (created === undefined) throw new Error("Expected a task CAS fixture.");

    fixture.database.beforeNextBatch(() => {
      fixture.database.run(
        `UPDATE speaker_tasks
            SET version = version + 1, updated_at = '2099-08-15T04:30:00.000Z'
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND id = '${created.id}' AND version = ${created.version}`,
      );
    });
    await expect(
      service.updateOrganizerTaskReminderOffsets({
        organizationId,
        eventId,
        accountId: organizerAccountId,
        taskId: created.id,
        expectedVersion: created.version,
        reminderOffsetsMinutes: [0, 1_440],
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    expect(
      fixture.database.query<{ offset_minutes: number }>(
        `SELECT offset_minutes FROM speaker_task_reminder_offsets
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND task_id = '${created.id}' ORDER BY offset_minutes`,
      ),
    ).toEqual([{ offset_minutes: 60 }]);
    expect(
      fixture.database.query<{ count: number }>(
        `SELECT count(*) AS count FROM audit_events
          WHERE resource_type = 'speaker_task' AND resource_id = '${created.id}'
            AND action = 'speaker_task.reminder_offsets_updated'`,
      )[0]?.count,
    ).toBe(0);
  });

  it("roundtrips immutable file pointers, cross-role comments, approval, and ZIP export", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    const admitted = await fixture.createPhase().service.createOrganizerSpeaker({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      displayName: "Priya Raman",
      email: "priya@example.test",
      jobTitle: "Staff Engineer",
      company: "Durable Systems",
      biography: "Priya biography.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "content-roundtrip-priya",
    });
    const participantId = admitted.speakers.find(
      (speaker) => speaker.email === "priya@example.test",
    )?.participantId;
    if (participantId === undefined) throw new Error("Expected the admitted participant.");
    await createAndAcceptSpeakerInvitation({
      database: fixture.database as unknown as D1Database,
      invitationId: "event-invitation:content-roundtrip-priya",
      creationIdempotencyKey: "event-invitation:content-roundtrip-priya",
      participantId,
      accountId: priyaAccountId,
      email: "priya@example.test",
      invitedAt: "2099-08-15T04:01:00.000Z",
      acceptedAt: "2099-08-15T04:02:00.000Z",
    });
    const assigned = await fixture.createPhase().service.createOrganizerTask({
      eventId,
      accountId: organizerAccountId,
      type: "upload",
      title: "Upload Session Presentation",
      description: "Upload the final deck.",
      acceptedAssetKinds: ["slides"],
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 100_000,
      assignments: [{ participantId, subject: { type: "participant" } }],
    });
    const taskId = assigned[0]?.id;
    if (taskId === undefined) throw new Error("Expected the assigned upload task.");
    const firstBytes = new TextEncoder().encode("first-deck");
    const secondBytes = new TextEncoder().encode("second-deck");

    const upload = async (input: {
      fileName: string;
      bytes: Uint8Array;
      supersedesAssetId?: string;
    }) => {
      const { service } = fixture.createPhase();
      const authorization = await service.issueUploadGrant({
        eventId,
        accountId: priyaAccountId,
        participantId,
        taskId,
        kind: "slides",
        fileName: input.fileName,
        contentType: "application/pdf",
        sizeBytes: input.bytes.byteLength,
        ...(input.supersedesAssetId === undefined
          ? {}
          : {
              supersedesAssetId: input.supersedesAssetId,
              expectedLatestVersion: 1,
              idempotencyKey: `content-roundtrip-replacement-${input.fileName}`,
            }),
      });
      const capability = privateCapabilityParts(authorization.grant.url);
      await service.consumeUploadCapability(
        capability.capabilityId,
        capability.token,
        new Request("https://api.example.test/private-upload", {
          method: "PUT",
          headers: {
            "content-type": "application/pdf",
            "content-length": String(input.bytes.byteLength),
          },
          body: input.bytes,
        }),
      );
      return service.finalizeUpload({
        eventId,
        accountId: priyaAccountId,
        assetId: authorization.asset.id,
        state: "ready",
      });
    };

    const first = await upload({ fileName: "slides-v1.pdf", bytes: firstBytes });
    const second = await upload({
      fileName: "slides-v2.pdf",
      bytes: secondBytes,
      supersedesAssetId: first.id,
    });

    const participantService = fixture.createPhase().service;
    await participantService.addAssetComment({
      eventId,
      accountId: priyaAccountId,
      assetId: second.id,
      body: "Draft deck - final version coming Friday.",
      expectedVersion: 0,
    });
    const organizerService = fixture.createPhase().service;
    await expect(
      organizerService.listOrganizerAssetComments(eventId, organizerAccountId, second.id),
    ).resolves.toEqual([
      expect.objectContaining({
        assetId: second.id,
        authorLabel: "Priya Raman",
        version: 1,
      }),
    ]);
    await organizerService.addOrganizerAssetComment({
      eventId,
      accountId: organizerAccountId,
      assetId: second.id,
      body: "Thanks - please confirm the final version by Tuesday.",
      expectedVersion: 1,
    });
    await expect(
      fixture.createPhase().service.listAssetComments(eventId, priyaAccountId, second.id),
    ).resolves.toEqual([
      expect.objectContaining({ authorLabel: "Priya Raman", version: 1 }),
      expect.objectContaining({ authorLabel: "Organizer", version: 2 }),
    ]);

    await organizerService.reviewAsset({
      eventId,
      accountId: organizerAccountId,
      assetId: second.id,
      state: "approved",
      release: true,
      expectedVersion: 0,
    });
    const projected = await fixture
      .createPhase()
      .service.listOrganizerAssets(eventId, organizerAccountId);
    expect(projected.map((asset) => asset.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(projected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          latestVersionId: second.id,
          currentVersionId: second.id,
          approvedVersionId: second.id,
          releasedVersionId: second.id,
        }),
        expect.objectContaining({
          id: second.id,
          latestVersionId: second.id,
          currentVersionId: second.id,
          approvedVersionId: second.id,
          releasedVersionId: second.id,
        }),
      ]),
    );

    const exported = await fixture.createPhase().service.exportDeliverables({
      eventId,
      accountId: organizerAccountId,
      assetIds: [second.id],
    });
    expect(exported.contentType).toBe("application/zip");
    expect(exported.manifest.entries).toEqual([
      expect.objectContaining({ assetId: second.id, version: 2 }),
    ]);
    expect(new TextDecoder().decode(exported.body)).toContain("second-deck");
    expect(new TextDecoder().decode(exported.body)).not.toContain("first-deck");
  }, 120_000);

  it("returns a persisted submitted upload task when its current asset needs changes", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);

    const admitted = await fixture.createPhase().service.createOrganizerSpeaker({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      displayName: "Review Return Speaker",
      email: "priya@example.test",
      jobTitle: "Staff Engineer",
      company: "Durable Systems",
      biography: "Speaker for the needs-changes lifecycle.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "review-return-speaker",
    });
    const participantId = admitted.speakers.find(
      (speaker) => speaker.email === "priya@example.test",
    )?.participantId;
    if (participantId === undefined) {
      throw new Error("Expected the admitted review-return participant.");
    }

    await createAndAcceptSpeakerInvitation({
      database: fixture.database as unknown as D1Database,
      invitationId: "event-invitation:review-return-speaker",
      creationIdempotencyKey: "event-invitation:review-return-speaker",
      participantId,
      accountId: priyaAccountId,
      email: "priya@example.test",
      invitedAt: "2099-08-15T04:01:00.000Z",
      acceptedAt: "2099-08-15T04:02:00.000Z",
    });

    const assigned = await fixture.createPhase().service.createOrganizerTask({
      eventId,
      accountId: organizerAccountId,
      type: "upload",
      title: "Upload Review Return Slides",
      description: "Upload the deck for organizer review.",
      acceptedAssetKinds: ["slides"],
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 100_000,
      assignments: [{ participantId, subject: { type: "participant" } }],
    });
    const task = assigned[0];
    if (task === undefined) throw new Error("Expected the assigned upload task.");

    const bytes = new TextEncoder().encode("review-return-deck");
    const participantService = fixture.createPhase().service;
    const authorization = await participantService.issueUploadGrant({
      eventId,
      accountId: priyaAccountId,
      participantId,
      taskId: task.id,
      kind: "slides",
      fileName: "review-return-slides.pdf",
      contentType: "application/pdf",
      sizeBytes: bytes.byteLength,
    });

    const capability = privateCapabilityParts(authorization.grant.url);
    await participantService.consumeUploadCapability(
      capability.capabilityId,
      capability.token,
      new Request("https://api.example.test/private-upload", {
        method: "PUT",
        headers: {
          "content-type": "application/pdf",
          "content-length": String(bytes.byteLength),
        },
        body: bytes,
      }),
    );

    const finalized = await participantService.finalizeUpload({
      eventId,
      accountId: priyaAccountId,
      assetId: authorization.asset.id,
      state: "ready",
    });
    expect(finalized).toMatchObject({
      id: authorization.asset.id,
      participantId,
      taskId: task.id,
      state: "ready",
      latestVersionId: authorization.asset.id,
      currentVersionId: authorization.asset.id,
    });

    const submitted = await fixture.createPhase().service.transitionTask({
      eventId,
      accountId: priyaAccountId,
      taskId: task.id,
      toStatus: "submitted",
      expectedVersion: task.version,
    });
    expect(submitted.task).toMatchObject({
      id: task.id,
      status: "submitted",
      version: task.version + 1,
    });

    const reviewed = await fixture.createPhase().service.reviewAsset({
      eventId,
      accountId: organizerAccountId,
      assetId: authorization.asset.id,
      state: "needs_changes",
      note: "Replace the session deck with v2.",
      expectedVersion: 0,
    });
    expect(reviewed).toMatchObject({
      id: authorization.asset.id,
      taskId: task.id,
      reviewState: "needs_changes",
      reviewNote: "Replace the session deck with v2.",
      reviewVersion: 1,
      latestVersionId: authorization.asset.id,
      currentVersionId: authorization.asset.id,
    });
    const returnedTask = await fixture.createPhase().repository.getTask(eventId, task.id);
    expect(returnedTask).toMatchObject({
      status: "needs_changes",
      replacementBaselineAssetId: authorization.asset.id,
    });
    if (returnedTask === null) throw new Error("Expected the returned task.");
    await expect(
      fixture.createPhase().service.transitionTask({
        eventId,
        accountId: priyaAccountId,
        taskId: task.id,
        toStatus: "submitted",
        expectedVersion: returnedTask.version,
      }),
    ).rejects.toMatchObject({ code: "TASK_ASSET_NOT_READY", status: 409 });
    expect(
      fixture.database.query(
        `SELECT task_id, participant_id, actor_account_id, from_status, to_status, note
           FROM speaker_task_transitions
          WHERE task_id = '${task.id}' AND to_status = 'needs_changes'`,
      ),
    ).toEqual([
      {
        task_id: task.id,
        participant_id: participantId,
        actor_account_id: organizerAccountId,
        from_status: "submitted",
        to_status: "needs_changes",
        note: "Replace the session deck with v2.",
      },
    ]);

    const reloadedParticipantService = fixture.createPhase().service;
    await expect(reloadedParticipantService.listTasks(eventId, priyaAccountId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: task.id,
          participantId,
          subject: { type: "participant", participantId },
          status: "needs_changes",
          version: submitted.task.version + 1,
        }),
      ]),
    );

    await expect(
      reloadedParticipantService.listAssetHistory(eventId, priyaAccountId, authorization.asset.id),
    ).resolves.toEqual([
      expect.objectContaining({
        id: authorization.asset.id,
        participantId,
        taskId: task.id,
        reviewState: "needs_changes",
        reviewNote: "Replace the session deck with v2.",
        reviewVersion: 1,
        latestVersionId: authorization.asset.id,
        currentVersionId: authorization.asset.id,
      }),
    ]);
  }, 120_000);

  it("rolls back a needs-changes review when the linked task CAS loses", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    const service = fixture.createPhase().service;
    const admitted = await service.createOrganizerSpeaker({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      displayName: "Stale review speaker",
      email: "priya@example.test",
      jobTitle: "Engineer",
      company: "Example",
      biography: "A stale review regression speaker.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "stale-review-speaker",
    });
    const participantId = admitted.speakers[0]?.participantId;
    if (participantId === undefined) throw new Error("Expected the stale review speaker.");
    await createAndAcceptSpeakerInvitation({
      database: fixture.database as unknown as D1Database,
      invitationId: "event-invitation:stale-review",
      creationIdempotencyKey: "event-invitation:stale-review",
      participantId,
      accountId: priyaAccountId,
      email: "priya@example.test",
      invitedAt: "2099-08-15T04:01:00.000Z",
      acceptedAt: "2099-08-15T04:02:00.000Z",
    });
    const [task] = await service.createOrganizerTask({
      eventId,
      accountId: organizerAccountId,
      type: "upload",
      title: "Stale review deck",
      acceptedAssetKinds: ["slides"],
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 100_000,
      assignments: [{ participantId, subject: { type: "participant" } }],
    });
    if (task === undefined) throw new Error("Expected the stale review task.");
    const bytes = new TextEncoder().encode("stale-review-deck");
    const participantService = fixture.createPhase().service;
    const authorization = await participantService.issueUploadGrant({
      eventId,
      accountId: priyaAccountId,
      participantId,
      taskId: task.id,
      kind: "slides",
      fileName: "stale-review.pdf",
      contentType: "application/pdf",
      sizeBytes: bytes.byteLength,
    });
    const capability = privateCapabilityParts(authorization.grant.url);
    await participantService.consumeUploadCapability(
      capability.capabilityId,
      capability.token,
      new Request("https://api.example.test/private-upload", {
        method: "PUT",
        headers: {
          "content-type": "application/pdf",
          "content-length": String(bytes.byteLength),
        },
        body: bytes,
      }),
    );
    await participantService.finalizeUpload({
      eventId,
      accountId: priyaAccountId,
      assetId: authorization.asset.id,
      state: "ready",
    });
    const submitted = await fixture.createPhase().service.transitionTask({
      eventId,
      accountId: priyaAccountId,
      taskId: task.id,
      toStatus: "submitted",
      expectedVersion: task.version,
    });
    const beforeAuditCount =
      fixture.database.query<{ count: number }>(
        `SELECT count(*) AS count FROM speaker_asset_comments
          WHERE asset_id = '${authorization.asset.id}' AND author_label = '__speaker_asset_audit__'`,
      )[0]?.count ?? 0;
    const beforeTaskVersion = submitted.task.version;
    fixture.database.beforeNextBatch(() => {
      fixture.database.run(
        `UPDATE speaker_tasks
            SET version = version + 1, updated_at = '2099-08-15T05:30:00.000Z'
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND id = '${task.id}' AND version = ${beforeTaskVersion}`,
      );
    });

    await expect(
      fixture.createPhase().service.reviewAsset({
        eventId,
        accountId: organizerAccountId,
        assetId: authorization.asset.id,
        state: "needs_changes",
        note: "This review must lose its stale task CAS.",
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    expect(
      fixture.database.query<{
        state: string;
        review_state: string | null;
        review_version: number | null;
        current_version_id: string | null;
      }>(
        `SELECT state, review_state, review_version, current_version_id
           FROM speaker_assets
          WHERE id = '${authorization.asset.id}'`,
      ),
    ).toEqual([
      {
        state: "ready",
        review_state: null,
        review_version: 0,
        current_version_id: authorization.asset.id,
      },
    ]);
    expect(
      fixture.database.query<{
        status: string;
        version: number;
        replacement_baseline_asset_id: string | null;
      }>(
        `SELECT status, version, replacement_baseline_asset_id
           FROM speaker_tasks
          WHERE id = '${task.id}'`,
      ),
    ).toEqual([
      {
        status: "submitted",
        version: beforeTaskVersion + 1,
        replacement_baseline_asset_id: null,
      },
    ]);
    expect(
      fixture.database.query<{ count: number }>(
        `SELECT count(*) AS count FROM speaker_asset_comments
          WHERE asset_id = '${authorization.asset.id}' AND author_label = '__speaker_asset_audit__'`,
      )[0]?.count,
    ).toBe(beforeAuditCount);
    expect(
      fixture.database.query<{ count: number }>(
        `SELECT count(*) AS count FROM speaker_task_transitions
          WHERE task_id = '${task.id}' AND to_status = 'needs_changes'`,
      )[0]?.count,
    ).toBe(0);
  }, 120_000);

  it("accepts a persisted profile CAS when remote batch metadata reports zero changes", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    const admitted = await fixture.createPhase().service.createOrganizerSpeaker({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      displayName: "Remote metadata speaker",
      email: "remote-metadata@example.test",
      jobTitle: "Engineer",
      company: "Example",
      biography: "Original biography.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "remote-metadata-speaker",
      sourceType: "manual",
    });
    const admittedSpeaker = admitted.speakers.find(
      (speaker) => speaker.displayName === "Remote metadata speaker",
    );
    if (admittedSpeaker === undefined) throw new Error("Expected the admitted speaker.");
    const current = await fixture
      .createPhase()
      .repository.getProfile(eventId, admittedSpeaker.participantId);
    if (current === null) throw new Error("Expected the admitted speaker profile.");
    const misleadingDatabase = new Proxy(fixture.database, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: Parameters<typeof target.batch>[0]) => {
            const results = await target.batch(statements);
            return results.map((result, index) =>
              index === 0 ? { ...result, meta: { ...result.meta, changes: 0 } } : result,
            );
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const repository = new D1SpeakerRepository(misleadingDatabase as unknown as D1Database);
    const updatedAt = "2099-08-15T05:00:00.000Z";

    await expect(
      repository.updateProfile({
        eventId,
        participantId: admittedSpeaker.participantId,
        biography: "Persisted despite misleading remote metadata.",
        expectedVersion: current.version,
        updatedAt,
        actorAccountId: admittedSpeaker.participantId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        biography: "Persisted despite misleading remote metadata.",
        version: current.version + 1,
        updatedAt,
      },
    });
  });

  it("provisions accepted participant access only through the canonical grant boundary", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    fixture.database.executeScript(`
      UPDATE auth_users SET email = 'accepted@example.com' WHERE id = '${acceptedAccountId}';
      UPDATE participants
         SET email = 'accepted@example.com', normalized_email = 'accepted@example.com'
       WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
         AND id = '${acceptedParticipantId}';
    `);
    const database = fixture.database as unknown as D1Database;
    const submission: Submission = {
      id: acceptedSubmissionId,
      tenantId: organizationId,
      eventId,
      formId: "accepted-form",
      ownerAccountId: acceptedAccountId,
      formVersion: 1,
      version: 1,
      status: "submitted",
      completedSteps: [],
      answers: { title: "Accepted lifecycle session" },
      participants: [
        {
          id: acceptedParticipantId,
          firstName: "Accepted",
          lastName: "Speaker",
          email: "accepted@example.com",
          role: "primary",
          biography: "Accepted speaker biography.",
          answers: {},
        },
      ],
      secondaryContacts: [],
      createdAt: "2099-08-15T04:00:00.000Z",
      updatedAt: "2099-08-15T04:00:00.000Z",
      submittedAt: "2099-08-15T04:00:00.000Z",
    };
    const handoff = new AirtableEvaluationAcceptanceHandoff({
      cfp: {
        async getSubmission(requestedOrganizationId: string, requestedSubmissionId: string) {
          return requestedOrganizationId === organizationId &&
            requestedSubmissionId === acceptedSubmissionId
            ? submission
            : null;
        },
      } as unknown as CfpRepository,
      speakers: new D1SpeakerRepository(database),
      sessions: {
        async getSession() {
          return null;
        },
        async listTracks() {
          return [];
        },
        async listFormats() {
          return [];
        },
        async listTags() {
          return [];
        },
        async listLevels() {
          return [];
        },
        async putSession(session: Session) {
          return session;
        },
        async appendAudit() {},
      } as unknown as SessionRepository,
      database,
      queue: { async send() {} } as unknown as Queue,
    });

    await handoff.accept({
      tenantId: organizationId,
      eventId,
      planId: "accepted-plan",
      submissionId: acceptedSubmissionId,
      decisionId: "accepted-decision",
      decidedBy: organizerAccountId,
      decidedAt: "2099-08-15T04:00:00.000Z",
      reason: "Accepted",
      idempotencyKey: "accepted-handoff",
    });
    expect(
      fixture.database.query(
        `SELECT id, payload_json FROM outbox_jobs
          WHERE tenant_id = '${organizationId}' AND topic = 'communications'`,
      ),
    ).toEqual([]);

    expect(
      fixture.database.query<{ participant_id: string; user_id: string }>(
        `SELECT participant_id, user_id FROM participant_grants
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND participant_id = '${acceptedParticipantId}' AND revoked_at IS NULL`,
      ),
    ).toEqual([]);
    await createAndAcceptSpeakerInvitation({
      database,
      invitationId: `event-role-invitation:speaker:${eventId}:${acceptedParticipantId}`,
      creationIdempotencyKey: `evaluation-acceptance:${acceptedSubmissionId}:${acceptedParticipantId}`,
      participantId: acceptedParticipantId,
      accountId: acceptedAccountId,
      email: "accepted@example.com",
      invitedAt: "2099-08-15T04:00:00.000Z",
      acceptedAt: "2099-08-15T04:01:00.000Z",
    });
    expect(
      fixture.database.query<{ participant_id: string; user_id: string }>(
        `SELECT participant_id, user_id FROM participant_grants
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND participant_id = '${acceptedParticipantId}' AND revoked_at IS NULL`,
      ),
    ).toEqual([{ participant_id: acceptedParticipantId, user_id: acceptedAccountId }]);
    expect(
      fixture.database.query(
        `SELECT * FROM speaker_grants WHERE organization_id = '${organizationId}'`,
      ),
    ).toEqual([]);

    await fixture.database
      .prepare(
        `INSERT INTO auth_sessions
           (id,user_id,token_digest,expires_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .bind(
        "session:accepted",
        acceptedAccountId,
        await tokenDigest("accepted-speaker-session"),
        "2100-08-15T04:00:00.000Z",
        "2099-08-15T04:00:00.000Z",
        "2099-08-15T04:00:00.000Z",
      )
      .run();
    const gateway = new D1BetterAuthGateway(database);
    await expect(gateway.resolveSession("accepted-speaker-session")).resolves.toMatchObject({
      userId: acceptedAccountId,
      speakerGrants: [
        {
          organizationId,
          speakerProfileId: `speaker-profile:${eventId}:${acceptedParticipantId}`,
        },
      ],
    });
  });

  it("aborts a lost organizer aggregate update without committing side effects", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    const { repository, service } = fixture.createPhase();
    const created = await service.createOrganizerSpeaker({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      displayName: "Race Speaker",
      email: "race@example.test",
      jobTitle: "Engineer",
      company: "Race Co",
      biography: "Before the race.",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "create-race-speaker",
    });
    const speaker = created.speakers.find((candidate) => candidate.email === "race@example.test");
    if (speaker === undefined) throw new Error("Expected the race speaker fixture.");
    const command = {
      organizationId,
      eventId,
      accountId: organizerAccountId,
      participantId: speaker.participantId,
      profileId: `profile:${eventId}:${speaker.participantId}`,
      displayName: speaker.displayName,
      email: speaker.email,
      jobTitle: speaker.jobTitle,
      company: speaker.company,
      biography: "Losing writer biography.",
      socialLinks: speaker.socialLinks,
      travelLogistics: speaker.travelLogistics,
      status: speaker.status,
      sourceType: "manual" as const,
      sourceId: `manual:${eventId}:${speaker.participantId}`,
      expectedVersion: speaker.version,
      sourceDigest: "losing-writer-digest",
      updatedAt: "2099-08-15T05:00:00.000Z",
    };

    fixture.database.beforeNextBatch(() => {
      fixture.database.run(
        `UPDATE speaker_profiles SET version = version + 1
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND participant_id = '${speaker.participantId}' AND version = ${speaker.version}`,
      );
    });
    await expect(repository.upsertOrganizerSpeakerAggregate(command)).resolves.toEqual({
      ok: false,
      reason: "version_conflict",
    });
    expect(
      fixture.database.query<{ count: number }>(
        `SELECT count(*) AS count FROM speaker_aggregate_operations
          WHERE operation_type = 'update' AND participant_ids_json = '["${speaker.participantId}"]'`,
      )[0]?.count,
    ).toBe(0);
    expect(
      fixture.database.query<{ count: number }>(
        `SELECT count(*) AS count FROM audit_events
          WHERE id = 'speaker-update:${eventId}:${speaker.participantId}:${speaker.version}'`,
      )[0]?.count,
    ).toBe(0);
    expect(
      fixture.database.query<{ biography: string }>(
        `SELECT biography FROM speaker_profiles
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND participant_id = '${speaker.participantId}'`,
      )[0]?.biography,
    ).toBe("Before the race.");

    const winningCommand = {
      ...command,
      expectedVersion: speaker.version + 1,
      sourceDigest: "winning-writer-digest",
    };
    const applied = await repository.upsertOrganizerSpeakerAggregate(winningCommand);
    expect(applied).toMatchObject({ ok: true, value: { version: speaker.version + 2 } });
    await expect(repository.upsertOrganizerSpeakerAggregate(winningCommand)).resolves.toEqual(
      applied,
    );
  });

  it("grants an invited verified speaker portal access only after event invitation acceptance", async () => {
    const fixture = createSpeakerLifecycleFixture();
    fixtures.push(fixture);
    const { service } = fixture.createPhase();
    const invitations = new D1EventRoleInvitationRepository(
      fixture.database as unknown as D1Database,
    );
    const email = "event-invitation@example.test";
    const accountId = "event-invitation-account";
    const participantRecordCounts = (participantId: string) => ({
      participants: fixture.database.query<{ count: number }>(
        `SELECT count(*) AS count FROM participants
            WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
              AND id = '${participantId}'`,
      )[0]?.count,
      profiles: fixture.database.query<{ count: number }>(
        `SELECT count(*) AS count FROM speaker_profiles
            WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
              AND participant_id = '${participantId}'`,
      )[0]?.count,
      sessions: fixture.database.query<{ count: number }>(
        `SELECT count(*) AS count FROM sessions AS sessions
             JOIN session_speakers AS speakers
               ON speakers.organization_id = sessions.organization_id
              AND speakers.event_id = sessions.event_id
              AND speakers.session_id = sessions.id
            WHERE sessions.organization_id = '${organizationId}' AND sessions.event_id = '${eventId}'
              AND speakers.speaker_id = '${participantId}'`,
      )[0]?.count,
      tasks: fixture.database.query<{ count: number }>(
        `SELECT count(*) AS count FROM speaker_tasks
            WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
              AND participant_id = '${participantId}'`,
      )[0]?.count,
    });

    fixture.database.executeScript(`
      INSERT INTO auth_users (id, email, email_verified, name, created_at, updated_at)
      VALUES (
        '${accountId}', '${email}', 1, 'Event Invitation',
        '2099-08-15T06:00:00.000Z', '2099-08-15T06:00:00.000Z'
      );
    `);
    const created = await service.createOrganizerSpeaker({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      displayName: "Event Invitation",
      email,
      jobTitle: "",
      company: "",
      biography: "",
      socialLinks: {},
      status: "confirmed",
      idempotencyKey: "event-invitation-speaker",
      sourceType: "manual",
      sourceId: "event-invitation-source",
    });
    const participantId = created.speakers[0]?.participantId;
    if (participantId === undefined) throw new Error("Expected the manual speaker participant.");

    await service.assignOrganizerSpeakerTask({
      organizationId,
      eventId,
      accountId: organizerAccountId,
      title: "Confirm invitation details",
      description: "Review the speaker portal invitation.",
      dueAt: "2100-01-01",
      assignments: [{ participantId, subject: { type: "participant" } }],
    });
    fixture.database.executeScript(`
      INSERT INTO session_statuses
        (id, organization_id, event_id, value, name, description, agenda_eligible, sort_order,
         active, version, created_at, updated_at)
      VALUES
        ('event-invitation-session-status', '${organizationId}', '${eventId}', 'confirmed',
         'Confirmed', '', 1, 0, 1, 1,
         '2099-08-15T06:00:00.000Z', '2099-08-15T06:00:00.000Z');
      INSERT INTO sessions
        (id, organization_id, event_id, title, description, status, content_status,
         duration_minutes, capacity_required, room_id, format_id, level_id, version, created_at,
         updated_at, created_by, updated_by, deleted_at)
      VALUES
        ('event-invitation-session', '${organizationId}', '${eventId}', 'Event invitation session',
         '', 'confirmed', NULL, 30, 0, NULL, NULL, NULL, 1,
         '2099-08-15T06:00:00.000Z', '2099-08-15T06:00:00.000Z', '${organizerAccountId}',
         '${organizerAccountId}', NULL);
      INSERT INTO session_speakers
        (organization_id, event_id, session_id, speaker_id, display_name, role, ordinal)
      VALUES
        ('${organizationId}', '${eventId}', 'event-invitation-session', '${participantId}',
         'Event Invitation', 'speaker', 0);
    `);
    const beforeAcceptance = participantRecordCounts(participantId);
    expect(beforeAcceptance).toEqual({ participants: 1, profiles: 1, sessions: 1, tasks: 1 });

    expect(
      fixture.database.query<{ participant_id: string; user_id: string }>(
        `SELECT participant_id, user_id FROM participant_grants
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND participant_id = '${participantId}' AND user_id = '${accountId}'
            AND revoked_at IS NULL`,
      ),
    ).toEqual([]);
    expect(
      fixture.database.query<{ claimed_user_id: string | null }>(
        `SELECT claimed_user_id FROM participants
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND id = '${participantId}'`,
      )[0]?.claimed_user_id,
    ).toBeNull();

    const invitation = await invitations.create({
      id: "event-invitation",
      organizationId,
      eventId,
      role: "speaker",
      recipientUserId: accountId,
      normalizedEmail: email,
      participantId,
      creationIdempotencyKey: "event-invitation-speaker",
      invitedByActorType: "user",
      invitedByActorId: organizerAccountId,
      invitedAt: "2099-08-15T06:01:00.000Z",
    });
    await expect(
      invitations.accept({
        invitationId: invitation.id,
        recipientUserId: accountId,
        normalizedEmail: email,
        expectedVersion: invitation.version,
        occurredAt: "2099-08-15T06:02:00.000Z",
      }),
    ).resolves.toMatchObject({
      id: invitation.id,
      participantId,
      recipientUserId: accountId,
      status: "accepted",
      version: invitation.version + 1,
    });

    expect(
      fixture.database.query<{ claimed_user_id: string | null }>(
        `SELECT claimed_user_id FROM participants
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND id = '${participantId}'`,
      )[0]?.claimed_user_id,
    ).toBe(accountId);
    expect(
      fixture.database.query<{ participant_id: string; user_id: string }>(
        `SELECT participant_id, user_id FROM participant_grants
          WHERE organization_id = '${organizationId}' AND event_id = '${eventId}'
            AND participant_id = '${participantId}' AND user_id = '${accountId}'
            AND revoked_at IS NULL`,
      ),
    ).toEqual([{ participant_id: participantId, user_id: accountId }]);
    expect(participantRecordCounts(participantId)).toEqual(beforeAcceptance);
  });

  it("publishes a released headshot from a speaker upload task without a profile mutation", async () => {
    const { app, bindings, bytes, participantId, photoUrl, profile } =
      await publishHeadshotScenario({
        workflow: "task",
        release: true,
      });
    expect(profile?.headshotAssetId).toBeUndefined();

    const speakersResponse = await app.request(
      "/api/public/events/lifecycle-event/speakers",
      undefined,
      bindings,
    );
    const speakersBody = await speakersResponse.json();
    expect(speakersResponse.status, JSON.stringify(speakersBody)).toBe(200);
    expect(speakersBody).toMatchObject({
      data: {
        speakers: [
          expect.objectContaining({
            id: participantId,
            photoUrl,
          }),
        ],
      },
    });

    const headshotResponse = await app.request(photoUrl, undefined, bindings);
    expect(headshotResponse.status).toBe(200);
    expect(headshotResponse.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await headshotResponse.arrayBuffer())).toEqual(bytes);
  }, 60_000);

  it("recovers beside an orphaned speaker snapshot for the same agenda revision", async () => {
    const { app, bindings, participantId, photoUrl } = await publishHeadshotScenario({
      workflow: "task",
      release: true,
      seedOrphanProjection: true,
    });

    const speakersResponse = await app.request(
      "/api/public/events/lifecycle-event/speakers",
      undefined,
      bindings,
    );
    expect(speakersResponse.status).toBe(200);
    expect(await speakersResponse.json()).toMatchObject({
      data: {
        speakers: [
          expect.objectContaining({
            id: participantId,
            photoUrl,
          }),
        ],
      },
    });
    expect((await app.request(photoUrl, undefined, bindings)).status).toBe(200);
  }, 60_000);

  it("keeps an approved headshot private until its selected version is released", async () => {
    const { app, asset, bindings, participantId, photoUrl, profile } =
      await publishHeadshotScenario({
        workflow: "profile",
        release: false,
      });
    expect(profile?.headshotAssetId).toBe(asset.id);

    const speakersResponse = await app.request(
      "/api/public/events/lifecycle-event/speakers",
      undefined,
      bindings,
    );
    expect(speakersResponse.status).toBe(200);
    const speakersBody = (await speakersResponse.json()) as {
      data: { speakers: Array<{ id: string; photoUrl: string | null }> };
    };
    expect(speakersBody.data.speakers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: participantId,
          photoUrl: null,
        }),
      ]),
    );
    expect((await app.request(photoUrl, undefined, bindings)).status).toBe(404);
  }, 60_000);
});
