/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCfpAssetFixture } from "../test-support/cfp-file-assets";
import { SqliteD1 } from "../test-support/sqlite-d1";

const databases: SqliteD1[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.dispose();
});

function createDatabase(): SqliteD1 {
  const database = new SqliteD1("eventloom-cfp-assets-");
  databases.push(database);
  database.executeScript(
    readFileSync(join(process.cwd(), "apps/api/src/test-support/cfp-file-assets-base.sql"), "utf8"),
  );
  database.executeScript(
    readFileSync(join(process.cwd(), "apps/api/migrations/0002_operational_state.sql"), "utf8"),
  );
  database.executeScript(
    readFileSync(join(process.cwd(), "apps/api/migrations/0024_cfp_file_assets.sql"), "utf8"),
  );
  database.executeScript(
    readFileSync(
      join(process.cwd(), "apps/api/migrations/0050_private_object_cleanup.sql"),
      "utf8",
    ),
  );
  return database;
}

function issueUpload(fixture: ReturnType<typeof createCfpAssetFixture>, key = "issue-file-1") {
  return fixture.gateway.issueUpload({
    tenantId: fixture.event.tenantId,
    eventId: fixture.event.id,
    submissionId: fixture.submission.id,
    owner: "submission",
    fieldKey: "slides",
    fileName: "slides.pdf",
    contentType: "application/pdf",
    sizeBytes: 4,
    idempotencyKey: key,
  });
}

describe("production CFP file asset persistence", () => {
  it("authorizes a submission-owned upload without creating a speaker participant", async () => {
    const { database, event, gateway, privateAssets, submission } = createCfpAssetFixture(
      createDatabase(),
    );

    await expect(
      gateway.issueUpload({
        tenantId: event.tenantId,
        eventId: event.id,
        submissionId: submission.id,
        owner: "submission",
        fieldKey: "slides",
        fileName: "slides.pdf",
        contentType: "application/pdf",
        sizeBytes: 4,
        idempotencyKey: "issue-file-1",
      }),
    ).resolves.toMatchObject({
      asset: {
        tenantId: event.tenantId,
        eventId: event.id,
        submissionId: submission.id,
        owner: "submission",
        state: "pending_upload",
      },
    });
    expect(
      database.query<{ participant_id: string | null }>(
        "SELECT participant_id FROM cfp_file_assets",
      ),
    ).toEqual([{ participant_id: null }]);
    expect(database.query("SELECT id FROM speaker_assets")).toEqual([]);
    expect(privateAssets.registered[0]).toMatchObject({
      subject: { kind: "cfp_submission", submissionId: submission.id },
    });
  });

  it("reissues one pending asset for the same idempotency binding", async () => {
    const fixture = createCfpAssetFixture(createDatabase());

    const first = await issueUpload(fixture);
    const second = await issueUpload(fixture);

    expect(second.asset.assetId).toBe(first.asset.assetId);
    expect(fixture.database.query("SELECT id FROM cfp_file_assets")).toHaveLength(1);
    expect(fixture.privateAssets.registered).toHaveLength(2);
    await expect(
      fixture.gateway.issueUpload({
        tenantId: fixture.event.tenantId,
        eventId: fixture.event.id,
        submissionId: fixture.submission.id,
        owner: "submission",
        fieldKey: "slides",
        fileName: "changed.pdf",
        contentType: "application/pdf",
        sizeBytes: 4,
        idempotencyKey: "issue-file-1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("verifies exact private bytes before finalizing a ready asset", async () => {
    const fixture = createCfpAssetFixture(createDatabase());
    const authorization = await issueUpload(fixture);
    const finalize = () =>
      fixture.gateway.finalizeUpload({
        tenantId: fixture.event.tenantId,
        eventId: fixture.event.id,
        submissionId: fixture.submission.id,
        owner: "submission",
        fieldKey: "slides",
        assetId: authorization.asset.assetId,
        state: "ready",
        idempotencyKey: "finalize-file-1",
      });

    await expect(finalize()).rejects.toMatchObject({ code: "CONFLICT" });
    fixture.privateAssets.verified = true;
    await expect(finalize()).resolves.toMatchObject({ state: "ready" });
    expect(fixture.privateAssets.verifiedBindings.at(-1)).toMatchObject({
      capabilityId: authorization.asset.assetId,
      participantId: "__cfp_submission__",
    });
    expect(fixture.privateAssets.invalidated.at(-1)).toMatchObject({
      capabilityId: authorization.asset.assetId,
      participantId: "__cfp_submission__",
    });
    expect(fixture.database.query<{ state: string }>("SELECT state FROM cfp_file_assets")).toEqual([
      { state: "ready" },
    ]);
    await expect(
      fixture.gateway.getAsset({
        tenantId: "other-tenant",
        eventId: fixture.event.id,
        submissionId: fixture.submission.id,
        assetId: authorization.asset.assetId,
        owner: "submission",
      }),
    ).resolves.toBeNull();
  });

  it("does not publish ready when cleanup wins after byte verification", async () => {
    const fixture = createCfpAssetFixture(createDatabase());
    const authorization = await issueUpload(fixture);
    fixture.privateAssets.verified = true;
    fixture.privateAssets.cleanupAfterVerification = true;

    await expect(
      fixture.gateway.finalizeUpload({
        tenantId: fixture.event.tenantId,
        eventId: fixture.event.id,
        submissionId: fixture.submission.id,
        owner: "submission",
        fieldKey: "slides",
        assetId: authorization.asset.assetId,
        state: "ready",
        idempotencyKey: "finalize-file-cleanup-race",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.database.query<{ state: string }>("SELECT state FROM cfp_file_assets")).toEqual([
      { state: "pending_upload" },
    ]);
  });

  it("rolls back rejected cleanup intent when the CFP finalization CAS loses", async () => {
    const fixture = createCfpAssetFixture(createDatabase());
    const authorization = await issueUpload(fixture, "issue-file-rejection-race");
    fixture.database.beforeNextBatch(() => {
      fixture.database.run(
        `UPDATE cfp_file_assets SET state = 'ready' WHERE id = '${authorization.asset.assetId}'`,
      );
    });

    await expect(
      fixture.gateway.finalizeUpload({
        tenantId: fixture.event.tenantId,
        eventId: fixture.event.id,
        submissionId: fixture.submission.id,
        owner: "submission",
        fieldKey: "slides",
        assetId: authorization.asset.assetId,
        state: "rejected",
        rejectionReason: "Malware detected",
        idempotencyKey: "reject-file-race",
      }),
    ).rejects.toThrow();
    expect(fixture.database.query<{ state: string }>("SELECT state FROM cfp_file_assets")).toEqual([
      { state: "ready" },
    ]);
    expect(fixture.database.query("SELECT id FROM outbox_jobs")).toEqual([]);
  });

  it("invalidates a rejected upload capability", async () => {
    const fixture = createCfpAssetFixture(createDatabase());
    const authorization = await issueUpload(fixture, "issue-file-rejected");

    await expect(
      fixture.gateway.finalizeUpload({
        tenantId: fixture.event.tenantId,
        eventId: fixture.event.id,
        submissionId: fixture.submission.id,
        owner: "submission",
        fieldKey: "slides",
        assetId: authorization.asset.assetId,
        state: "rejected",
        rejectionReason: "Malware detected",
        idempotencyKey: "reject-file-1",
      }),
    ).resolves.toMatchObject({ state: "rejected" });
    expect(fixture.privateAssets.invalidated).toHaveLength(1);
    expect(
      fixture.database.query<{ topic: string; payload_json: string }>(
        "SELECT topic, payload_json FROM outbox_jobs",
      ),
    ).toEqual([
      {
        topic: "file-scan",
        payload_json: JSON.stringify({
          kind: "private_object_delete",
          source: "cfp",
          tenantId: fixture.event.tenantId,
          eventId: fixture.event.id,
          submissionId: fixture.submission.id,
          assetId: authorization.asset.assetId,
          objectKey: fixture.privateAssets.registered[0]?.objectKey,
        }),
      },
    ]);
  });
});
