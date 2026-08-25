import type { D1Database, Queue } from "@cloudflare/workers-types";
import { afterEach, expect, it } from "vitest";
import type { ApiDependencies } from "../app";
import { CommunicationService } from "../features/communications/service";
import type { CloudflareOutboxMessage } from "../infrastructure/cloudflare/bindings";
import {
  CloudflareReminderOutbox,
  D1ReminderRepository,
} from "../infrastructure/cloudflare/reminder-repository";
import { D1CommunicationRepository } from "../infrastructure/cloudflare/repositories/communications";
import {
  createSpeakerLifecycleFixture,
  speakerLifecycleIds as ids,
} from "../test-support/speaker-lifecycle";
import type { RuntimeBindings } from "./cloudflare";
import { RuntimeReminderCandidateSource, runScheduledReminders } from "./composition";

const fixtures: ReturnType<typeof createSpeakerLifecycleFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

it("queues each task at its exact reminder threshold and keeps later runs idempotent", async () => {
  const lifecycle = createSpeakerLifecycleFixture();
  fixtures.push(lifecycle);
  const phase = lifecycle.createPhase({
    eventTemporalSource: {
      getEventTemporalContext(organizationId, eventId) {
        return Promise.resolve(
          organizationId === ids.organizationId && eventId === ids.eventId
            ? {
                organizationId,
                eventId,
                timeZone: "America/Santiago",
                startsAt: "2100-01-10T17:00:00.000Z",
                endsAt: "2100-01-11T01:00:00.000Z",
              }
            : null,
        );
      },
    },
  });
  lifecycle.database.executeScript(`
    INSERT INTO participants
      (id,organization_id,event_id,first_name,last_name,display_name,email,normalized_email,
       identity_state,source_type,source_id,claimed_user_id,version,created_at,updated_at)
    VALUES
      ('participant-priya','${ids.organizationId}','${ids.eventId}','Priya','Nair','Priya Nair',
       'priya@example.test','priya@example.test','resolved','manual','manual:participant-priya',
       '${ids.priyaAccountId}',1,'2099-08-15T04:00:00.000Z','2099-08-15T04:00:00.000Z');
  `);
  await phase.service.createOrganizerSpeaker({
    organizationId: ids.organizationId,
    eventId: ids.eventId,
    accountId: ids.organizerAccountId,
    explicitParticipantId: "participant-priya",
    sourceType: "manual",
    sourceId: "manual:participant-priya",
    idempotencyKey: "scheduler-speaker",
    displayName: "Priya Nair",
    email: "priya@example.test",
    jobTitle: "Engineer",
    company: "Example",
    biography: "Speaker biography",
    socialLinks: {},
    status: "confirmed",
  });
  const [upcomingTask] = await phase.service.createOrganizerTask({
    eventId: ids.eventId,
    accountId: ids.organizerAccountId,
    type: "upload",
    title: "Upload slides in 48 hours",
    description: "Complete this speaker requirement.",
    allowedMimeTypes: ["application/pdf"],
    maxBytes: 5_000_000,
    dueAt: "2099-09-07",
    assignments: [{ participantId: "participant-priya", subject: { type: "participant" } }],
  });
  const [overdueTask] = await phase.service.createOrganizerTask({
    eventId: ids.eventId,
    accountId: ids.organizerAccountId,
    type: "upload",
    title: "Sign overdue release",
    description: "Complete this speaker requirement.",
    allowedMimeTypes: ["application/pdf"],
    maxBytes: 5_000_000,
    dueAt: "2099-09-04",
    assignments: [{ participantId: "participant-priya", subject: { type: "participant" } }],
  });
  if (upcomingTask === undefined || overdueTask === undefined) {
    throw new Error("The reminder test tasks were not created.");
  }
  await phase.service.updateOrganizerTaskReminderOffsets({
    organizationId: ids.organizationId,
    eventId: ids.eventId,
    accountId: ids.organizerAccountId,
    taskId: upcomingTask.id,
    expectedVersion: upcomingTask.version,
    reminderOffsetsMinutes: [2_880],
  });
  await phase.service.updateOrganizerTaskReminderOffsets({
    organizationId: ids.organizationId,
    eventId: ids.eventId,
    accountId: ids.organizerAccountId,
    taskId: overdueTask.id,
    expectedVersion: overdueTask.version,
    reminderOffsetsMinutes: [0],
  });

  const database = lifecycle.database as unknown as D1Database;
  const queued: CloudflareOutboxMessage[] = [];
  const queue = {
    async send(message: CloudflareOutboxMessage) {
      queued.push(message);
    },
  } as unknown as Queue<CloudflareOutboxMessage>;
  const communications = new CommunicationService(new D1CommunicationRepository(database));
  const dependencies = {
    speaker: { service: phase.service },
    communications: { service: communications, actorFor: async () => null },
    events: {
      service: {
        async listEvents() {
          return [{ id: ids.eventId, organizationId: ids.organizationId }];
        },
      },
    },
  } as unknown as ApiDependencies;
  const reminderRepository = new D1ReminderRepository(database);
  communications.configureReminders({
    repository: reminderRepository,
    source: new RuntimeReminderCandidateSource(
      dependencies,
      database,
      "speakers@sessionboard.namuh.co",
    ),
    outbox: new CloudflareReminderOutbox(database, queue),
  });
  const bindings = { DB: database } as RuntimeBindings;
  const beforeOverdue = new Date("2099-09-05T03:59:59.999Z");
  const overdueThreshold = new Date("2099-09-05T04:00:00.000Z");
  const beforeUpcoming = new Date("2099-09-06T02:59:59.999Z");
  const upcomingThreshold = new Date("2099-09-06T03:00:00.000Z");
  const laterRetry = new Date("2099-09-06T04:00:00.000Z");

  await runScheduledReminders(dependencies, bindings, beforeOverdue);
  expect(queued).toHaveLength(0);
  expect(
    lifecycle.database.query("SELECT id FROM outbox_jobs WHERE topic='communications'"),
  ).toHaveLength(0);

  await runScheduledReminders(dependencies, bindings, overdueThreshold);
  expect(queued).toHaveLength(1);

  await runScheduledReminders(dependencies, bindings, beforeUpcoming);
  expect(queued).toHaveLength(1);
  const beforeUpcomingDispatches = await reminderRepository.listDispatches(
    ids.organizationId,
    ids.eventId,
  );
  expect(
    beforeUpcomingDispatches.filter(
      (dispatch) =>
        dispatch.subject.type === "task" &&
        dispatch.subject.taskId === upcomingTask.id &&
        dispatch.status === "queued",
    ),
  ).toHaveLength(0);

  await runScheduledReminders(dependencies, bindings, upcomingThreshold);
  expect(queued).toHaveLength(2);
  await runScheduledReminders(dependencies, bindings, laterRetry);
  expect(queued).toHaveLength(2);

  const runId = (hourWindow: string) =>
    `reminder-run:${ids.organizationId}:${ids.eventId}:automatic:${hourWindow}`;
  const expectedRuns = [
    {
      id: runId("2099-09-05T03:00:00.000Z"),
      candidateCount: 2,
      eligibleCount: 0,
      queuedCount: 0,
      skippedCount: 2,
    },
    {
      id: runId(overdueThreshold.toISOString()),
      candidateCount: 1,
      eligibleCount: 1,
      queuedCount: 1,
      skippedCount: 0,
    },
    {
      id: runId("2099-09-06T02:00:00.000Z"),
      candidateCount: 0,
      eligibleCount: 0,
      queuedCount: 0,
      skippedCount: 0,
    },
    {
      id: runId(upcomingThreshold.toISOString()),
      candidateCount: 1,
      eligibleCount: 1,
      queuedCount: 1,
      skippedCount: 0,
    },
    {
      id: runId(laterRetry.toISOString()),
      candidateCount: 0,
      eligibleCount: 0,
      queuedCount: 0,
      skippedCount: 0,
    },
  ] as const;
  const runs = await reminderRepository.listRuns(ids.organizationId, ids.eventId);
  expect(runs.map((run) => run.id).sort()).toEqual(expectedRuns.map((run) => run.id).sort());
  const runsById = new Map(runs.map((run) => [run.id, run]));
  for (const expectedRun of expectedRuns) {
    expect(runsById.get(expectedRun.id)).toMatchObject({
      ...expectedRun,
      triggerType: "automatic",
      audienceType: "task",
      failedCount: 0,
      state: "completed",
      configurationFailure: null,
    });
  }

  const dispatches = await reminderRepository.listDispatches(ids.organizationId, ids.eventId);
  for (const run of runs) {
    const owned = dispatches.filter((dispatch) => dispatch.runId === run.id);
    const ownedQueued = owned.filter((dispatch) => dispatch.status === "queued");
    const ownedSkipped = owned.filter((dispatch) => dispatch.status === "skipped");
    expect(run.candidateCount).toBe(owned.length);
    expect(run.eligibleCount).toBe(ownedQueued.length);
    expect(run.queuedCount).toBe(ownedQueued.length);
    expect(run.skippedCount).toBe(ownedSkipped.length);
  }
  const queuedDispatches = dispatches.filter((dispatch) => dispatch.status === "queued");
  expect(queuedDispatches).toHaveLength(2);

  const outbox = lifecycle.database.query<{
    id: string;
    state: string;
    payload_json: string;
  }>("SELECT id,state,payload_json FROM outbox_jobs WHERE topic='communications'");
  expect(outbox).toHaveLength(2);
  for (const expected of [
    {
      taskId: overdueTask.id,
      cadenceWindow: overdueThreshold.toISOString(),
      owningRunId: runId(overdueThreshold.toISOString()),
    },
    {
      taskId: upcomingTask.id,
      cadenceWindow: upcomingThreshold.toISOString(),
      owningRunId: runId(upcomingThreshold.toISOString()),
    },
  ]) {
    const dispatch = queuedDispatches.find(
      (candidate) =>
        candidate.subject.type === "task" && candidate.subject.taskId === expected.taskId,
    );
    expect(dispatch).toMatchObject({
      recipient: "participant-priya",
      subject: { type: "task", taskId: expected.taskId },
      cadenceWindow: expected.cadenceWindow,
      runId: expected.owningRunId,
      status: "queued",
      outboxJobId: expect.any(String),
    });
    if (dispatch?.outboxJobId === null || dispatch?.outboxJobId === undefined) {
      throw new Error(`The reminder dispatch for ${expected.taskId} has no outbox job.`);
    }
    const job = outbox.find((candidate) => candidate.id === dispatch.outboxJobId);
    expect(job?.state).toBe("queued");
    const payload = JSON.parse(job?.payload_json ?? "{}") as {
      effect?: string;
      eventId?: string;
      runId?: string;
      dispatchId?: string;
      payload?: { idempotencyKey?: string };
    };
    expect(payload).toMatchObject({
      effect: "send_reminder",
      eventId: ids.eventId,
      runId: expected.owningRunId,
      dispatchId: dispatch.id,
      payload: { idempotencyKey: dispatch.idempotencyKey },
    });
    expect(queued.find((message) => message.jobId === job?.id)).toMatchObject({
      tenantId: ids.organizationId,
      topic: "communications",
    });
  }
}, 60_000);
