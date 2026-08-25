import { type Context, Hono } from "hono";
import { z } from "zod";
import { type SpeakerService, SpeakerServiceError } from "./service";
import {
  type SpeakerAsset,
  type SpeakerAssetComment,
  type SpeakerDeliverablesMatrix,
  type SpeakerEventResource,
  type SpeakerFormAnswer,
  type SpeakerTravelLogistics,
  speakerTaskStatuses,
} from "./types";

interface SpeakerRouteEnvironment {
  Variables: {
    speakerAccountId: string;
    speakerTraceId: string;
  };
}

export interface SpeakerRouteDependencies {
  service: SpeakerService;
  authenticate(request: Request): Promise<{ accountId: string } | null>;
}

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const calendarDateSchema = z.string().superRefine((value, context) => {
  if (!calendarDatePattern.test(value)) {
    context.addIssue({ code: "custom", message: "Expected YYYY-MM-DD." });
    return;
  }
  const [year, month, day] = value.split("-").map(Number);
  const roundTrip = new Date(0);
  roundTrip.setUTCFullYear(year ?? 0, (month ?? 0) - 1, day ?? 0);
  roundTrip.setUTCHours(0, 0, 0, 0);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  ) {
    context.addIssue({ code: "custom", message: "Expected a real calendar date." });
  }
});

const transitionTaskSchema = z.object({
  toStatus: z.enum(speakerTaskStatuses),
  expectedVersion: z.number().int().nonnegative(),
  note: z.string().optional(),
});

const uploadSchema = z.object({
  participantId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  kind: z.enum(["headshot", "slides", "supporting_file"]),
  fileName: z.string(),
  contentType: z.string().trim().min(1),
  sizeBytes: z.number().int().positive(),
  supersedesAssetId: z.string().trim().min(1).optional(),
  expectedLatestVersion: z.number().int().positive().optional(),
});

const organizerHeadshotUploadSchema = z
  .object({
    participantId: z.string().trim().min(1).max(200),
    sessionId: z.string().trim().min(1).max(200).optional(),
    kind: z.literal("headshot"),
    fileName: z.string().trim().min(1).max(120),
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024),
    supersedesAssetId: z.string().trim().min(1).max(200).optional(),
    expectedLatestVersion: z.number().int().positive().optional(),
  })
  .strict();

const finalizeAssetSchema = z.object({
  state: z.enum(["ready", "rejected"]),
  rejectionReason: z.string().optional(),
});
const rosterCreateSchema = z.object({
  participantId: z.string().trim().min(1).optional(),
  email: z.string().trim().min(1).max(320),
  displayName: z.string().trim().min(1).max(200),
  role: z.literal("co_speaker").optional(),
});

const rosterUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().min(1).max(320).optional(),
  role: z.literal("co_speaker").optional(),
  status: z.enum(["pending", "active", "revoked"]).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
});

const assetCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  expectedVersion: z.number().int().nonnegative().optional(),
});

const taskResponseSchema = z.object({
  definitionVersion: z.number().int().positive(),
  answers: z.record(z.string(), z.unknown()),
  expectedVersion: z.number().int().nonnegative().optional(),
});
const organizerTaskCreateSchema = z.object({
  type: z.enum(["form", "upload", "action"]).default("upload"),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(10_000).optional(),
  description: z.string().max(10_000).optional(),
  dueAt: calendarDateSchema.optional(),
  dueDate: calendarDateSchema.optional(),
  allowedMimeTypes: z.array(z.string().trim().min(1).max(120)).default([]),
  maxBytes: z.number().int().positive().optional(),
  maxSizeBytes: z.number().int().positive().optional(),
  acceptedAssetKinds: z.array(z.enum(["headshot", "slides", "supporting_file"])).optional(),
  dependencyIds: z.array(z.string().trim().min(1)).optional(),
  reminderOffsetsMinutes: z
    .array(
      z
        .number()
        .int()
        .nonnegative()
        .refine(Number.isSafeInteger)
        .refine((value) => value % 60 === 0)
        .refine((value) => value <= 365 * 24 * 60),
    )
    .max(24)
    .optional(),
  assignments: z
    .array(
      z.object({
        participantId: z.string().trim().min(1),
        subject: z.discriminatedUnion("type", [
          z.object({ type: z.literal("participant") }),
          z.object({ type: z.literal("session"), sessionId: z.string().trim().min(1) }),
        ]),
      }),
    )
    .min(1),
});

const reminderOffsetSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Expected a safe integer.")
  .refine((value) => value % 60 === 0, "Expected a whole-hour increment in minutes.")
  .refine((value) => value <= 365 * 24 * 60, "Expected an offset within one year.");

const organizerTaskReminderOffsetsSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().refine(Number.isSafeInteger),
    reminderOffsetsMinutes: z.array(reminderOffsetSchema).max(24),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.reminderOffsetsMinutes).size !== value.reminderOffsetsMinutes.length) {
      context.addIssue({
        code: "custom",
        path: ["reminderOffsetsMinutes"],
        message: "Reminder offsets must be unique.",
      });
    }
  });

const organizerTaskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  instructions: z.string().max(10_000).optional(),
  description: z.string().max(10_000).optional(),
  dueDate: calendarDateSchema.optional(),
  dueAt: calendarDateSchema.optional(),
  allowedMimeTypes: z.array(z.string().trim().min(1).max(120)).optional(),
  maxBytes: z.number().int().positive().optional(),
  maxSizeBytes: z.number().int().positive().optional(),
  acceptedAssetKinds: z.array(z.enum(["headshot", "slides", "supporting_file"])).optional(),
  dependencyIds: z.array(z.string().trim().min(1)).optional(),
  // Reminder offsets mutate only through the dedicated reminder-offsets command.
  status: z.enum(speakerTaskStatuses).optional(),
  expectedVersion: z.number().int().nonnegative(),
});

const organizerAssetReviewSchema = z.object({
  state: z.enum(["approved", "needs_changes"]),
  note: z.string().max(2_000).optional(),
  expectedVersion: z.number().int().nonnegative(),
  release: z.boolean().optional(),
});
const organizerDeliverablesExportStatuses = [
  "all",
  "incomplete",
  "pending",
  "uploaded",
  ...speakerTaskStatuses,
] as const;

const organizerDeliverablesExportSchema = z
  .object({
    assetIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    taskIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    participantIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    status: z.enum(organizerDeliverablesExportStatuses).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.assetIds !== undefined ||
      value.taskIds !== undefined ||
      value.participantIds !== undefined ||
      value.status !== undefined,
    "Select deliverable asset IDs or task filters before exporting.",
  );

const organizerProfileSchema = z.object({
  biography: z.string().optional(),
  jobTitle: z.string().max(160).optional(),
  company: z.string().max(200).optional(),
  socialLinks: z.record(z.string(), z.string()).optional(),
  social: z.record(z.string(), z.string()).optional(),
  headshotAssetId: z.string().trim().min(1).nullable().optional(),
  travelLogistics: z
    .object({
      travelRequired: z.boolean().optional(),
      arrivalAt: z.string().trim().max(80).nullable().optional(),
      departureAt: z.string().trim().max(80).nullable().optional(),
      accommodation: z.string().max(500).optional(),
      dietaryRequirements: z.string().max(2_000).optional(),
      accessibilityNeeds: z.string().max(2_000).optional(),
      travelNotes: z.string().max(5_000).optional(),
    })
    .optional(),
  expectedVersion: z.number().int().nonnegative(),
});

const reminderSchema = z.object({
  taskIds: z.array(z.string().trim().min(1)).optional(),
  recipientIds: z.array(z.string().trim().min(1)).optional(),
  idempotencyKey: z.string().trim().min(1).max(300).optional(),
});

const speakerEmailTemplateSchema = z.object({
  templateId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(500),
  html: z.string().trim().max(100_000).optional(),
  text: z.string().trim().min(1).max(100_000),
  status: z.enum(["draft", "approved"]).optional(),
});

const speakerEmailTemplateVersionSchema = speakerEmailTemplateSchema
  .omit({ name: true })
  .extend({ templateId: z.string().trim().min(1).max(200).optional() });

const speakerEmailPreviewSchema = z.object({
  participantIds: z.array(z.string().trim().min(1)).min(1).max(500),
  templateId: z.string().trim().min(1).max(200),
  templateVersion: z.number().int().positive().optional(),
});

const speakerEmailSendSchema = z.object({
  previewId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(300),
});
const contentUpdateSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  title: z.string().optional(),
  description: z.string().optional(),
  abstract: z.string().optional(),
  biography: z.string().optional(),
  socialLinks: z.record(z.string(), z.string()).optional(),
  headshotAssetId: z.string().trim().min(1).nullable().optional(),
  status: z.string().optional(),
});

const contentRestoreSchema = z.object({
  version: z.number().int().positive(),
  expectedVersion: z.number().int().nonnegative().optional(),
});

function traceIdFor(request: Request): string {
  const incoming = request.headers.get("x-request-id");
  return incoming &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(incoming)
    ? incoming
    : crypto.randomUUID();
}

function errorBody(context: Context<SpeakerRouteEnvironment>, code: string, message: string) {
  return {
    error: {
      code,
      message,
      traceId: context.get("speakerTraceId"),
    },
  };
}

async function parseBody<T>(
  context: Context<SpeakerRouteEnvironment>,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const body = await context.req.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
type SpeakerTravelLogisticsBody = {
  travelRequired?: boolean | undefined;
  arrivalAt?: string | null | undefined;
  departureAt?: string | null | undefined;
  accommodation?: string | undefined;
  dietaryRequirements?: string | undefined;
  accessibilityNeeds?: string | undefined;
  travelNotes?: string | undefined;
};

function normalizePartialTravelLogistics(
  value: SpeakerTravelLogisticsBody | undefined,
): Partial<SpeakerTravelLogistics> | undefined {
  if (value === undefined) return undefined;
  return {
    ...(value.travelRequired === undefined ? {} : { travelRequired: value.travelRequired }),
    ...(value.arrivalAt === undefined ? {} : { arrivalAt: value.arrivalAt }),
    ...(value.departureAt === undefined ? {} : { departureAt: value.departureAt }),
    ...(value.accommodation === undefined ? {} : { accommodation: value.accommodation }),
    ...(value.dietaryRequirements === undefined
      ? {}
      : { dietaryRequirements: value.dietaryRequirements }),
    ...(value.accessibilityNeeds === undefined
      ? {}
      : { accessibilityNeeds: value.accessibilityNeeds }),
    ...(value.travelNotes === undefined ? {} : { travelNotes: value.travelNotes }),
  };
}

/** Never serialize the server-owned R2 key, account id, or any capability binding. */
function publicAsset(
  asset: SpeakerAsset,
): Omit<SpeakerAsset, "objectKey" | "tenantId" | "uploaderAccountId"> {
  const {
    objectKey: _objectKey,
    tenantId: _tenantId,
    uploaderAccountId: _uploaderAccountId,
    ...safe
  } = asset;
  return safe;
}

function speakerAsset(
  asset: SpeakerAsset,
): Omit<SpeakerAsset, "objectKey" | "tenantId" | "uploaderAccountId" | "reviewedBy"> {
  const { reviewedBy: _reviewedBy, ...safe } = publicAsset(asset);
  return safe;
}

function publicComment(comment: SpeakerAssetComment): Omit<SpeakerAssetComment, "authorAccountId"> {
  const { authorAccountId: _authorAccountId, ...safe } = comment;
  return safe;
}
function publicPublishedResource(
  resource: SpeakerEventResource,
): Omit<SpeakerEventResource, "eventId"> {
  const { eventId: _eventId, ...safe } = resource;
  return safe;
}
function publicDeliverablesMatrix(matrix: SpeakerDeliverablesMatrix) {
  return {
    organizationId: matrix.organizationId,
    eventId: matrix.eventId,
    total: matrix.total,
    filters: matrix.filters,
    items: matrix.items.map((item) => ({
      ...item,
      assets: item.assets.map(publicAsset),
      ...(item.currentAsset === undefined ? {} : { currentAsset: publicAsset(item.currentAsset) }),
    })),
  };
}

function isCapabilityPath(path: string): boolean {
  return /(?:^|\/)assets\/capabilities\/(?:upload|download)\//u.test(path);
}

function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createSpeakerRoutes(dependencies: SpeakerRouteDependencies) {
  const app = new Hono<SpeakerRouteEnvironment>();

  app.use("*", async (context, next) => {
    const traceId = traceIdFor(context.req.raw);
    context.set("speakerTraceId", traceId);
    context.header("cache-control", "private, no-store");
    context.header("x-request-id", traceId);
    context.header("x-content-type-options", "nosniff");

    // An opaque, single-use capability is the authorization for transfer endpoints.
    if (isCapabilityPath(context.req.path)) {
      await next();
      return;
    }
    const actor = await dependencies.authenticate(context.req.raw);
    if (!actor?.accountId) {
      return context.json(
        errorBody(context, "AUTHENTICATION_REQUIRED", "Authentication is required."),
        401,
      );
    }
    context.set("speakerAccountId", actor.accountId);
    await next();
  });
  function contentTypeParam(value: string): "session" | "speaker" | null {
    return value === "session" || value === "speaker" ? value : null;
  }

  app.get("/events/:eventId/organizer/tasks", async (context) => {
    const tasks = await dependencies.service.listOrganizerTasks(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
    );
    return context.json({ data: { tasks, items: tasks } });
  });

  app.post("/events/:eventId/organizer/tasks", async (context) => {
    const body = await parseBody(context, organizerTaskCreateSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The organizer task payload is invalid."),
        400,
      );
    }
    const tasks = await dependencies.service.createOrganizerTask({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      type: body.type,
      title: body.title,
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt }),
      ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
      allowedMimeTypes: body.allowedMimeTypes,
      ...(body.maxBytes === undefined
        ? body.maxSizeBytes === undefined
          ? {}
          : { maxBytes: body.maxSizeBytes }
        : { maxBytes: body.maxBytes }),
      ...(body.acceptedAssetKinds === undefined
        ? {}
        : { acceptedAssetKinds: body.acceptedAssetKinds }),
      ...(body.dependencyIds === undefined ? {} : { dependencyIds: body.dependencyIds }),
      ...(body.reminderOffsetsMinutes === undefined
        ? {}
        : { reminderOffsetsMinutes: body.reminderOffsetsMinutes }),
      assignments: body.assignments.map(({ participantId, subject }) => ({
        participantId,
        subject:
          subject.type === "participant"
            ? { type: "participant" }
            : { type: "session", sessionId: subject.sessionId },
      })),
    });
    const task = tasks[0];
    return context.json({ data: task, items: tasks }, 201);
  });

  app.patch("/events/:eventId/organizer/tasks/:taskId", async (context) => {
    const body = await parseBody(context, organizerTaskUpdateSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The organizer task payload is invalid."),
        400,
      );
    }
    const task = await dependencies.service.updateOrganizerTask({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      taskId: context.req.param("taskId"),
      expectedVersion: body.expectedVersion,
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt }),
      ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
      ...(body.allowedMimeTypes === undefined ? {} : { allowedMimeTypes: body.allowedMimeTypes }),
      ...(body.maxBytes === undefined
        ? body.maxSizeBytes === undefined
          ? {}
          : { maxBytes: body.maxSizeBytes }
        : { maxBytes: body.maxBytes }),
      ...(body.acceptedAssetKinds === undefined
        ? {}
        : { acceptedAssetKinds: body.acceptedAssetKinds }),
      ...(body.dependencyIds === undefined ? {} : { dependencyIds: body.dependencyIds }),
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    return context.json({ data: task });
  });

  app.get("/events/:eventId/organizer/deliverables", async (context) => {
    const status = context.req.query("status");
    const participantId = context.req.query("participantId");
    const taskId = context.req.query("taskId");
    const matrix = await dependencies.service.listDeliverables(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      {
        ...(status === undefined || status === "" ? {} : { status: status as never }),
        ...(participantId === undefined || participantId === "" ? {} : { participantId }),
        ...(taskId === undefined || taskId === "" ? {} : { taskId }),
      },
    );
    return context.json({ data: publicDeliverablesMatrix(matrix) });
  });

  app.post("/events/:eventId/organizer/deliverables/export", async (context) => {
    const body = await parseBody(context, organizerDeliverablesExportSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The deliverables export payload is invalid."),
        400,
      );
    }
    const archive = await dependencies.service.exportDeliverables({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      ...(body.assetIds === undefined ? {} : { assetIds: body.assetIds }),
      ...(body.taskIds === undefined ? {} : { taskIds: body.taskIds }),
      ...(body.participantIds === undefined ? {} : { participantIds: body.participantIds }),
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    return new Response(archive.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": archive.contentType,
        "content-length": String(archive.sizeBytes),
        "content-disposition": contentDisposition(archive.fileName),
      },
    });
  });

  app.get("/events/:eventId/organizer/assets", async (context) => {
    const assets = await dependencies.service.listOrganizerAssets(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      context.req.query("participantId") || undefined,
      context.req.query("versionFamilyId") || undefined,
    );
    return context.json({ data: assets.map(publicAsset) });
  });
  app.post("/events/:eventId/organizer/assets/:assetId/finalize", async (context) => {
    const body = await parseBody(context, finalizeAssetSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The asset finalization payload is invalid."),
        400,
      );
    }
    const asset = await dependencies.service.finalizeAsset({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      assetId: context.req.param("assetId"),
      state: body.state,
      organizer: true,
      ...(body.rejectionReason === undefined ? {} : { rejectionReason: body.rejectionReason }),
    });
    return context.json({ data: publicAsset(asset) });
  });

  app.get("/events/:eventId/organizer/assets/:assetId/history", async (context) => {
    const assets = await dependencies.service.listOrganizerAssetHistory(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      context.req.param("assetId"),
    );
    return context.json({ data: assets.map(publicAsset) });
  });

  app.get("/events/:eventId/organizer/assets/:assetId/comments", async (context) => {
    const comments = await dependencies.service.listOrganizerAssetComments(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      context.req.param("assetId"),
    );
    return context.json({ data: comments.map(publicComment) });
  });

  app.post("/events/:eventId/organizer/assets/:assetId/comments", async (context) => {
    const body = await parseBody(context, assetCommentSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The asset comment payload is invalid."),
        400,
      );
    }
    const comment = await dependencies.service.addOrganizerAssetComment({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      assetId: context.req.param("assetId"),
      body: body.body,
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
    });
    return context.json({ data: publicComment(comment) }, 201);
  });

  app.post("/events/:eventId/organizer/assets/:assetId/download", async (context) => {
    const grant = await dependencies.service.issueOrganizerDownloadGrant({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      assetId: context.req.param("assetId"),
    });
    return context.json({ data: grant });
  });

  app.post("/events/:eventId/organizer/assets/:assetId/review", async (context) => {
    const body = await parseBody(context, organizerAssetReviewSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The asset review payload is invalid."),
        400,
      );
    }
    const asset = await dependencies.service.reviewAsset({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      assetId: context.req.param("assetId"),
      state: body.state,
      ...(body.note === undefined ? {} : { note: body.note }),
      expectedVersion: body.expectedVersion,
      ...(body.release === undefined ? {} : { release: body.release }),
    });
    return context.json({ data: publicAsset(asset) });
  });

  app.get("/events/:eventId/organizer/assets/:assetId/audit", async (context) => {
    const audit = await dependencies.service.listAssetAudit(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      context.req.param("assetId"),
    );
    return context.json({ data: audit });
  });

  app.get("/events/:eventId/organizer/profiles", async (context) => {
    const profiles = await dependencies.service.listOrganizerProfiles(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
    );
    return context.json({ data: { profiles, items: profiles } });
  });

  app.patch("/events/:eventId/organizer/profiles/:participantId", async (context) => {
    const body = await parseBody(context, organizerProfileSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The organizer profile payload is invalid."),
        400,
      );
    }
    const travelLogistics = normalizePartialTravelLogistics(body.travelLogistics);
    const profile = await dependencies.service.updateOrganizerProfile({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      participantId: context.req.param("participantId"),
      ...(body.jobTitle === undefined ? {} : { jobTitle: body.jobTitle }),
      ...(body.company === undefined ? {} : { company: body.company }),
      ...(body.biography === undefined ? {} : { biography: body.biography }),
      ...(body.socialLinks === undefined ? {} : { socialLinks: body.socialLinks }),
      ...(body.social === undefined ? {} : { social: body.social }),
      ...(body.headshotAssetId === undefined ? {} : { headshotAssetId: body.headshotAssetId }),
      ...(travelLogistics === undefined ? {} : { travelLogistics }),
      expectedVersion: body.expectedVersion,
    });
    return context.json({ data: profile });
  });

  app.post("/events/:eventId/organizer/profiles/:participantId/headshot", async (context) => {
    const body = await parseBody(context, organizerHeadshotUploadSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The headshot upload payload is invalid."),
        400,
      );
    }
    const idempotencyKey = context.req.header("idempotency-key");
    const result = await dependencies.service.issueOrganizerUploadGrant({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      participantId: context.req.param("participantId"),
      ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
      ...(body.supersedesAssetId === undefined
        ? {}
        : {
            supersedesAssetId: body.supersedesAssetId,
            ...(body.expectedLatestVersion === undefined
              ? {}
              : { expectedLatestVersion: body.expectedLatestVersion }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          }),
      kind: "headshot",
      fileName: body.fileName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
    });
    return context.json({ data: { ...result, asset: speakerAsset(result.asset) } }, 201);
  });

  app.post("/events/:eventId/organizer/reminders/preview", async (context) => {
    const body = await parseBody(context, reminderSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The reminder preview payload is invalid."),
        400,
      );
    }
    const preview = await dependencies.service.previewOutstandingReminders({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      ...(body.taskIds === undefined ? {} : { taskIds: body.taskIds }),
      ...(body.recipientIds === undefined ? {} : { recipientIds: body.recipientIds }),
    });
    return context.json({ data: preview });
  });

  app.post("/events/:eventId/organizer/reminders/queue", async (context) => {
    const body = await parseBody(context, reminderSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The reminder queue payload is invalid."),
        400,
      );
    }
    const result = await dependencies.service.queueReminders({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      ...(body.taskIds === undefined ? {} : { taskIds: body.taskIds }),
      ...(body.recipientIds === undefined ? {} : { recipientIds: body.recipientIds }),
      ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
    });
    return context.json({ data: result });
  });
  app.get("/events/:eventId/organizer/content/:entityType/:entityId", async (context) => {
    const entityType = contentTypeParam(context.req.param("entityType"));
    if (entityType === null) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The content type is invalid."),
        400,
      );
    }
    const content = await dependencies.service.getContent(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      entityType,
      context.req.param("entityId"),
    );
    return context.json({ data: content });
  });

  app.patch("/events/:eventId/organizer/content/:entityType/:entityId", async (context) => {
    const entityType = contentTypeParam(context.req.param("entityType"));
    const body = await parseBody(context, contentUpdateSchema);
    if (entityType === null || !body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The content update payload is invalid."),
        400,
      );
    }
    const content = await dependencies.service.updateContent({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      entityType,
      entityId: context.req.param("entityId"),
      expectedVersion: body.expectedVersion,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.abstract === undefined ? {} : { abstract: body.abstract }),
      ...(body.biography === undefined ? {} : { biography: body.biography }),
      ...(body.socialLinks === undefined ? {} : { socialLinks: body.socialLinks }),
      ...(body.headshotAssetId === undefined ? {} : { headshotAssetId: body.headshotAssetId }),
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    return context.json({ data: content });
  });

  app.get("/events/:eventId/organizer/content/:entityType/:entityId/history", async (context) => {
    const entityType = contentTypeParam(context.req.param("entityType"));
    if (entityType === null) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The content type is invalid."),
        400,
      );
    }
    const history = await dependencies.service.listContentHistory(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      entityType,
      context.req.param("entityId"),
    );
    return context.json({ data: history });
  });

  app.post("/events/:eventId/organizer/content/:entityType/:entityId/restore", async (context) => {
    const entityType = contentTypeParam(context.req.param("entityType"));
    const body = await parseBody(context, contentRestoreSchema);
    if (entityType === null || !body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The content restore payload is invalid."),
        400,
      );
    }
    const content = await dependencies.service.restoreContentVersion({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      entityType,
      entityId: context.req.param("entityId"),
      version: body.version,
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
    });
    return context.json({ data: content });
  });
  app.post("/events/:eventId/tasks", async (context) => {
    const body = await parseBody(context, organizerTaskCreateSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The organizer task payload is invalid."),
        400,
      );
    }
    const tasks = await dependencies.service.createOrganizerTask({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      type: body.type,
      title: body.title,
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt }),
      ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
      allowedMimeTypes: body.allowedMimeTypes,
      ...(body.maxBytes === undefined
        ? body.maxSizeBytes === undefined
          ? {}
          : { maxBytes: body.maxSizeBytes }
        : { maxBytes: body.maxBytes }),
      ...(body.acceptedAssetKinds === undefined
        ? {}
        : { acceptedAssetKinds: body.acceptedAssetKinds }),
      ...(body.dependencyIds === undefined ? {} : { dependencyIds: body.dependencyIds }),
      ...(body.reminderOffsetsMinutes === undefined
        ? {}
        : { reminderOffsetsMinutes: body.reminderOffsetsMinutes }),
      assignments: body.assignments.map(({ participantId, subject }) => ({
        participantId,
        subject:
          subject.type === "participant"
            ? { type: "participant" }
            : { type: "session", sessionId: subject.sessionId },
      })),
    });
    return context.json({ data: tasks[0], items: tasks }, 201);
  });

  app.patch("/events/:eventId/tasks/:taskId", async (context) => {
    const body = await parseBody(context, organizerTaskUpdateSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The organizer task payload is invalid."),
        400,
      );
    }
    const task = await dependencies.service.updateOrganizerTask({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      taskId: context.req.param("taskId"),
      expectedVersion: body.expectedVersion,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt }),
      ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
      ...(body.allowedMimeTypes === undefined ? {} : { allowedMimeTypes: body.allowedMimeTypes }),
      ...(body.maxBytes === undefined
        ? body.maxSizeBytes === undefined
          ? {}
          : { maxBytes: body.maxSizeBytes }
        : { maxBytes: body.maxBytes }),
      ...(body.acceptedAssetKinds === undefined
        ? {}
        : { acceptedAssetKinds: body.acceptedAssetKinds }),
      ...(body.dependencyIds === undefined ? {} : { dependencyIds: body.dependencyIds }),
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    return context.json({ data: task });
  });

  app.get("/events/:eventId/deliverables", async (context) => {
    const status = context.req.query("status");
    const participantId = context.req.query("participantId");
    const taskId = context.req.query("taskId");
    const matrix = await dependencies.service.listDeliverables(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      {
        ...(status === undefined || status === "" ? {} : { status: status as never }),
        ...(participantId === undefined || participantId === "" ? {} : { participantId }),
        ...(taskId === undefined || taskId === "" ? {} : { taskId }),
      },
    );
    return context.json({ data: publicDeliverablesMatrix(matrix) });
  });

  app.post("/events/:eventId/assets/:assetId/review", async (context) => {
    const body = await parseBody(context, organizerAssetReviewSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The asset review payload is invalid."),
        400,
      );
    }
    const asset = await dependencies.service.reviewAsset({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      assetId: context.req.param("assetId"),
      state: body.state,
      ...(body.note === undefined ? {} : { note: body.note }),
      expectedVersion: body.expectedVersion,
      ...(body.release === undefined ? {} : { release: body.release }),
    });
    return context.json({ data: publicAsset(asset) });
  });
  app.get("/events/:eventId/reminders/eligibility", async (context) => {
    const splitQuery = (value: string | undefined): readonly string[] | undefined => {
      if (value === undefined || value.trim().length === 0) return undefined;
      return value
        .split(",")
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0);
    };
    const taskIds = splitQuery(context.req.query("taskIds"));
    const recipientIds = splitQuery(context.req.query("recipientIds"));
    const data = await dependencies.service.getReminderEligibility({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      ...(taskIds === undefined ? {} : { taskIds }),
      ...(recipientIds === undefined ? {} : { recipientIds }),
    });
    return context.json({ data });
  });
  app.post("/events/:eventId/reminders/preview", async (context) => {
    const body = await parseBody(context, reminderSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The reminder preview payload is invalid."),
        400,
      );
    }
    const preview = await dependencies.service.previewOutstandingReminders({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      ...(body.taskIds === undefined ? {} : { taskIds: body.taskIds }),
      ...(body.recipientIds === undefined ? {} : { recipientIds: body.recipientIds }),
    });
    return context.json({ data: preview });
  });

  app.post("/events/:eventId/reminders/queue", async (context) => {
    const body = await parseBody(context, reminderSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The reminder queue payload is invalid."),
        400,
      );
    }
    const result = await dependencies.service.queueReminders({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      ...(body.taskIds === undefined ? {} : { taskIds: body.taskIds }),
      ...(body.recipientIds === undefined ? {} : { recipientIds: body.recipientIds }),
      ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
    });
    return context.json({ data: result });
  });
  app.post("/events/:eventId/reminders", async (context) => {
    const body = await parseBody(context, reminderSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The reminder queue payload is invalid."),
        400,
      );
    }
    const result = await dependencies.service.queueReminders({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      ...(body.taskIds === undefined ? {} : { taskIds: body.taskIds }),
      ...(body.recipientIds === undefined ? {} : { recipientIds: body.recipientIds }),
      ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
    });
    return context.json({ data: result });
  });
  app.get("/events/:eventId/content/:entityType/:entityId", async (context) => {
    const entityType = contentTypeParam(context.req.param("entityType"));
    if (entityType === null) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The content type is invalid."),
        400,
      );
    }
    const content = await dependencies.service.getContent(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      entityType,
      context.req.param("entityId"),
    );
    return context.json({ data: content });
  });

  app.patch("/events/:eventId/content/:entityType/:entityId", async (context) => {
    const entityType = contentTypeParam(context.req.param("entityType"));
    const body = await parseBody(context, contentUpdateSchema);
    if (entityType === null || !body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The content update payload is invalid."),
        400,
      );
    }
    const content = await dependencies.service.updateContent({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      entityType,
      entityId: context.req.param("entityId"),
      expectedVersion: body.expectedVersion,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.abstract === undefined ? {} : { abstract: body.abstract }),
      ...(body.biography === undefined ? {} : { biography: body.biography }),
      ...(body.socialLinks === undefined ? {} : { socialLinks: body.socialLinks }),
      ...(body.headshotAssetId === undefined ? {} : { headshotAssetId: body.headshotAssetId }),
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    return context.json({ data: content });
  });

  app.get("/events/:eventId/content/:entityType/:entityId/history", async (context) => {
    const entityType = contentTypeParam(context.req.param("entityType"));
    if (entityType === null) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The content type is invalid."),
        400,
      );
    }
    const history = await dependencies.service.listContentHistory(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      entityType,
      context.req.param("entityId"),
    );
    return context.json({ data: history });
  });

  app.post("/events/:eventId/content/:entityType/:entityId/restore", async (context) => {
    const entityType = contentTypeParam(context.req.param("entityType"));
    const body = await parseBody(context, contentRestoreSchema);
    if (entityType === null || !body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The content restore payload is invalid."),
        400,
      );
    }
    const content = await dependencies.service.restoreContentVersion({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      entityType,
      entityId: context.req.param("entityId"),
      version: body.version,
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
    });
    return context.json({ data: content });
  });
  app.get("/portal/contexts", async (context) => {
    const data = await dependencies.service.listPortalContexts(context.get("speakerAccountId"));
    return context.json({ data });
  });

  app.get("/events/:eventId/portal/context", async (context) => {
    const data = await dependencies.service.getPortalContext(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
    );
    return context.json({ data });
  });
  app.get("/events/:eventId/portal", async (context) => {
    const data = await dependencies.service.getPortal(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
    );
    const safeData = {
      ...data,
      ...(data.assets === undefined ? {} : { assets: data.assets.map(speakerAsset) }),
      ...(data.resources === undefined
        ? {}
        : { resources: data.resources.map(publicPublishedResource) }),
      ...(data.wiki === undefined ? {} : { wiki: data.wiki.map(publicPublishedResource) }),
    };
    return context.json({ data: safeData });
  });

  app.get("/events/:eventId/submissions", async (context) => {
    const data = await dependencies.service.listSubmissions(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
    );
    return context.json({ data });
  });
  app.get("/events/:eventId/submissions/:submissionId/roster", async (context) => {
    const data = await dependencies.service.getRoster(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      context.req.param("submissionId"),
    );
    return context.json({ data });
  });

  app.post("/events/:eventId/submissions/:submissionId/roster", async (context) => {
    const body = await parseBody(context, rosterCreateSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The roster invitation payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.addRosterEntry({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      submissionId: context.req.param("submissionId"),
      ...(body.participantId === undefined ? {} : { participantId: body.participantId }),
      email: body.email,
      displayName: body.displayName,
      ...(body.role === undefined ? {} : { role: body.role }),
    });
    return context.json({ data }, 201);
  });

  app.patch("/events/:eventId/submissions/:submissionId/roster/:participantId", async (context) => {
    const body = await parseBody(context, rosterUpdateSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The roster update payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.updateRosterEntry({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      submissionId: context.req.param("submissionId"),
      participantId: context.req.param("participantId"),
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.email === undefined ? {} : { email: body.email }),
      ...(body.role === undefined ? {} : { role: body.role }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
    });
    return context.json({ data });
  });

  app.delete(
    "/events/:eventId/submissions/:submissionId/roster/:participantId",
    async (context) => {
      const raw = await context.req.json().catch(() => ({}));
      const parsed = rosterUpdateSchema.safeParse(raw);
      if (!parsed.success) {
        return context.json(
          errorBody(context, "VALIDATION_ERROR", "The roster removal payload is invalid."),
          400,
        );
      }
      const data = await dependencies.service.removeRosterEntry({
        eventId: context.req.param("eventId"),
        accountId: context.get("speakerAccountId"),
        submissionId: context.req.param("submissionId"),
        participantId: context.req.param("participantId"),
        ...(parsed.data.expectedVersion === undefined
          ? {}
          : { expectedVersion: parsed.data.expectedVersion }),
      });
      return context.json({ data });
    },
  );

  app.get("/events/:eventId/profiles", async (context) => {
    const data = await dependencies.service.listProfiles(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
    );
    return context.json({ data });
  });

  app.post("/events/:eventId/profiles/:participantId/headshot", async (context) => {
    const body = await parseBody(context, uploadSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The headshot upload payload is invalid."),
        400,
      );
    }
    const idempotencyKey = context.req.header("idempotency-key");
    const result = await dependencies.service.issueUploadGrant({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      participantId: context.req.param("participantId"),
      organizer: false,
      ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
      ...(body.supersedesAssetId === undefined
        ? {}
        : {
            supersedesAssetId: body.supersedesAssetId,
            ...(body.expectedLatestVersion === undefined
              ? {}
              : { expectedLatestVersion: body.expectedLatestVersion }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          }),
      kind: "headshot",
      fileName: body.fileName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
    });
    return context.json({ data: { ...result, asset: speakerAsset(result.asset) } }, 201);
  });
  app.patch("/events/:eventId/profiles/:participantId", async (context) => {
    const body = await parseBody(context, organizerProfileSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The profile update payload is invalid."),
        400,
      );
    }
    const travelLogistics = normalizePartialTravelLogistics(body.travelLogistics);
    const data = await dependencies.service.updateProfile({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      participantId: context.req.param("participantId"),
      ...(body.jobTitle === undefined ? {} : { jobTitle: body.jobTitle }),
      ...(body.company === undefined ? {} : { company: body.company }),
      ...(body.biography === undefined ? {} : { biography: body.biography }),
      ...(body.socialLinks === undefined ? {} : { socialLinks: body.socialLinks }),
      ...(body.social === undefined ? {} : { social: body.social }),
      ...(body.headshotAssetId === undefined ? {} : { headshotAssetId: body.headshotAssetId }),
      ...(travelLogistics === undefined ? {} : { travelLogistics }),
      expectedVersion: body.expectedVersion,
    });
    return context.json({ data });
  });

  app.get("/events/:eventId/tasks", async (context) => {
    const data = await dependencies.service.listTasks(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
    );
    return context.json({ data });
  });

  app.post("/events/:eventId/tasks/:taskId/transitions", async (context) => {
    const body = await parseBody(context, transitionTaskSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The task transition payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.transitionTask({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      taskId: context.req.param("taskId"),
      toStatus: body.toStatus,
      expectedVersion: body.expectedVersion,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
    return context.json({ data });
  });
  app.get("/events/:eventId/tasks/:taskId/form", async (context) => {
    const form = await dependencies.service.getTaskForm(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      context.req.param("taskId"),
    );
    return context.json({ data: form });
  });

  app.get("/events/:eventId/tasks/:taskId/responses", async (context) => {
    const response = await dependencies.service.getTaskResponse(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      context.req.param("taskId"),
    );
    return context.json({ data: response });
  });

  app.put("/events/:eventId/tasks/:taskId/responses", async (context) => {
    const body = await parseBody(context, taskResponseSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The task response payload is invalid."),
        400,
      );
    }
    const response = await dependencies.service.saveTaskResponse({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      taskId: context.req.param("taskId"),
      definitionVersion: body.definitionVersion,
      answers: body.answers as Readonly<Record<string, SpeakerFormAnswer>>,
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
    });
    return context.json({ data: response });
  });

  app.post("/events/:eventId/uploads", async (context) => {
    const body = await parseBody(context, uploadSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The upload authorization payload is invalid."),
        400,
      );
    }
    const idempotencyKey = context.req.header("idempotency-key");
    const data = await dependencies.service.issueUploadGrant({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      participantId: body.participantId,
      ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
      ...(body.taskId === undefined ? {} : { taskId: body.taskId }),
      kind: body.kind,
      fileName: body.fileName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      ...(body.supersedesAssetId === undefined
        ? {}
        : {
            supersedesAssetId: body.supersedesAssetId,
            ...(body.expectedLatestVersion === undefined
              ? {}
              : { expectedLatestVersion: body.expectedLatestVersion }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          }),
    });
    return context.json({ data: { ...data, asset: speakerAsset(data.asset) } }, 201);
  });

  app.get("/events/:eventId/assets", async (context) => {
    const participantId = context.req.query("participantId");
    const versionFamilyId = context.req.query("versionFamilyId");
    const assets = await dependencies.service.listAssets(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      participantId === undefined || participantId.trim().length === 0 ? undefined : participantId,
      versionFamilyId === undefined || versionFamilyId.trim().length === 0
        ? undefined
        : versionFamilyId,
    );
    return context.json({ data: assets.map(speakerAsset) });
  });
  app.get("/events/:eventId/assets/:assetId/history", async (context) => {
    const assets = await dependencies.service.listAssetHistory(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      context.req.param("assetId"),
    );
    return context.json({ data: assets.map(speakerAsset) });
  });
  app.get("/events/:eventId/resources", async (context) => {
    const resources = await dependencies.service.listResources(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
    );
    return context.json({ data: resources.map(publicPublishedResource) });
  });

  app.get("/events/:eventId/wiki", async (context) => {
    const wiki = await dependencies.service.listWikiPages(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
    );
    return context.json({ data: wiki.map(publicPublishedResource) });
  });

  app.get("/events/:eventId/assets/:assetId/comments", async (context) => {
    const comments = await dependencies.service.listAssetComments(
      context.req.param("eventId"),
      context.get("speakerAccountId"),
      context.req.param("assetId"),
    );
    return context.json({ data: comments.map(publicComment) });
  });

  app.post("/events/:eventId/assets/:assetId/comments", async (context) => {
    const body = await parseBody(context, assetCommentSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The asset comment payload is invalid."),
        400,
      );
    }
    const comment = await dependencies.service.addAssetComment({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      assetId: context.req.param("assetId"),
      body: body.body,
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
    });
    return context.json({ data: publicComment(comment) }, 201);
  });

  app.post("/events/:eventId/assets/:assetId/finalize", async (context) => {
    const body = await parseBody(context, finalizeAssetSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The asset finalization payload is invalid."),
        400,
      );
    }
    const asset = await dependencies.service.finalizeAsset({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      assetId: context.req.param("assetId"),
      state: body.state,
      ...(body.rejectionReason === undefined ? {} : { rejectionReason: body.rejectionReason }),
    });
    return context.json({ data: speakerAsset(asset) });
  });

  app.post("/events/:eventId/assets/:assetId/upload-authorization", async (context) => {
    const data = await dependencies.service.reauthorizePendingUpload({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      assetId: context.req.param("assetId"),
    });
    return context.json({ data: { ...data, asset: speakerAsset(data.asset) } });
  });

  app.post("/events/:eventId/assets/:assetId/download", async (context) => {
    const data = await dependencies.service.issueDownloadGrant({
      eventId: context.req.param("eventId"),
      accountId: context.get("speakerAccountId"),
      assetId: context.req.param("assetId"),
    });
    return context.json({ data });
  });

  app.put("/assets/capabilities/upload/:assetId/:token", async (context) => {
    const receipt = await dependencies.service.consumeUploadCapability(
      context.req.param("assetId"),
      context.req.param("token"),
      context.req.raw,
    );
    return context.json({ data: receipt }, 201);
  });

  app.get("/assets/capabilities/download/:capabilityId/:token", async (context) => {
    const object = await dependencies.service.consumeDownloadCapability(
      context.req.param("capabilityId"),
      context.req.param("token"),
    );
    return new Response(object.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": object.contentType,
        "content-length": String(object.sizeBytes),
        "content-disposition": contentDisposition(object.fileName),
      },
    });
  });

  app.onError((error, context) => {
    if (error instanceof SpeakerServiceError) {
      return context.json(errorBody(context, error.code, error.message), error.status);
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "speaker_request_failed",
        traceId: context.get("speakerTraceId"),
        errorName: error.name,
      }),
    );
    return context.json(
      errorBody(context, "INTERNAL_ERROR", "The speaker request could not be completed."),
      500,
    );
  });

  return app;
}
const canonicalSpeakerSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(300),
  sourceType: z.enum(["cfp", "manual", "csv", "crm"]).default("manual"),
  sourceId: z.string().trim().min(1).max(300).optional(),
  participantId: z.string().trim().min(1).max(300).optional(),
  displayName: z.string().trim().min(1).max(200),
  email: z.string().trim().min(1).max(320),
  jobTitle: z.string().max(160),
  company: z.string().max(200),
  biography: z.string().max(20_000),
  socialLinks: z.record(z.string(), z.string()).default({}),
  travelLogistics: z
    .object({
      travelRequired: z.boolean().optional(),
      arrivalAt: z.string().trim().max(80).nullable().optional(),
      departureAt: z.string().trim().max(80).nullable().optional(),
      accommodation: z.string().max(500).optional(),
      dietaryRequirements: z.string().max(2_000).optional(),
      accessibilityNeeds: z.string().max(2_000).optional(),
      travelNotes: z.string().max(5_000).optional(),
    })
    .optional(),
  status: z.string().trim().min(1).max(80),
});

const canonicalSpeakerUpdateSchema = canonicalSpeakerSchema
  .omit({
    idempotencyKey: true,
    sourceType: true,
    sourceId: true,
    participantId: true,
  })
  .extend({
    expectedVersion: z.number().int().nonnegative(),
  });

const canonicalImportCommitSchema = z
  .object({
    previewId: z.string().trim().min(1).max(200),
    sourceDigest: z.string().trim().min(1).max(200).optional(),
    idempotencyKey: z.string().trim().min(1).max(300),
  })
  .strict();

const canonicalTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  dueAt: calendarDateSchema,
  assignments: z
    .array(
      z.object({
        participantId: z.string().trim().min(1),
        subject: z.discriminatedUnion("type", [
          z.object({ type: z.literal("participant") }),
          z.object({ type: z.literal("session"), sessionId: z.string().trim().min(1) }),
        ]),
      }),
    )
    .min(1)
    .max(500),
});

const canonicalInvitationPreviewSchema = z.object({
  participantIds: z.array(z.string().trim().min(1)).min(1).max(500),
});

const canonicalInvitationSendSchema = canonicalInvitationPreviewSchema.extend({
  templateId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(300),
});

function requiredSpeakerParam(context: Context<SpeakerRouteEnvironment>, name: string): string {
  const value = context.req.param(name);
  if (value === undefined || value.trim().length === 0) {
    throw new SpeakerServiceError(
      "VALIDATION_ERROR",
      400,
      `The ${name} path parameter is required.`,
    );
  }
  return value;
}

export function createSpeakerAdminRoutes(dependencies: SpeakerRouteDependencies) {
  const app = new Hono<SpeakerRouteEnvironment>();

  app.use("*", async (context, next) => {
    const traceId = traceIdFor(context.req.raw);
    context.set("speakerTraceId", traceId);
    context.header("cache-control", "private, no-store");
    context.header("x-request-id", traceId);
    context.header("x-content-type-options", "nosniff");

    const actor = await dependencies.authenticate(context.req.raw);
    if (!actor?.accountId) {
      return context.json(
        errorBody(context, "AUTHENTICATION_REQUIRED", "Authentication is required."),
        401,
      );
    }
    context.set("speakerAccountId", actor.accountId);
    await next();
  });

  const organizationId = (context: Context<SpeakerRouteEnvironment>) =>
    requiredSpeakerParam(context, "organizationId");
  const eventId = (context: Context<SpeakerRouteEnvironment>) =>
    requiredSpeakerParam(context, "eventId");
  const accountId = (context: Context<SpeakerRouteEnvironment>) => context.get("speakerAccountId");

  app.get("/", async (context) => {
    const data = await dependencies.service.listOrganizerSpeakerRoster(
      organizationId(context),
      eventId(context),
      accountId(context),
    );
    return context.json({ data });
  });

  app.get("/email/templates", async (context) => {
    const templates = await dependencies.service.listOrganizerSpeakerEmailTemplates(
      organizationId(context),
      eventId(context),
      accountId(context),
    );
    return context.json({ data: templates });
  });

  app.post("/email/templates", async (context) => {
    const body = await parseBody(context, speakerEmailTemplateSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The speaker email template payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.createOrganizerSpeakerEmailTemplate({
      organizationId: organizationId(context),
      eventId: eventId(context),
      accountId: accountId(context),
      ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
      name: body.name,
      subject: body.subject,
      ...(body.html === undefined ? {} : { html: body.html }),
      text: body.text,
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    return context.json({ data }, 201);
  });

  app.post("/email/templates/:templateId/versions", async (context) => {
    const body = await parseBody(context, speakerEmailTemplateVersionSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The speaker email template version is invalid."),
        400,
      );
    }
    const data = await dependencies.service.createOrganizerSpeakerEmailTemplateVersion({
      organizationId: organizationId(context),
      eventId: eventId(context),
      accountId: accountId(context),
      templateId: requiredSpeakerParam(context, "templateId"),
      subject: body.subject,
      ...(body.html === undefined ? {} : { html: body.html }),
      text: body.text,
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    return context.json({ data }, 201);
  });

  app.post("/email/preview", async (context) => {
    const body = await parseBody(context, speakerEmailPreviewSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The speaker email preview payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.previewOrganizerSpeakerEmails({
      organizationId: organizationId(context),
      eventId: eventId(context),
      accountId: accountId(context),
      participantIds: body.participantIds,
      templateId: body.templateId,
      ...(body.templateVersion === undefined ? {} : { templateVersion: body.templateVersion }),
    });
    return context.json({ data });
  });

  app.post("/email/send", async (context) => {
    const body = await parseBody(context, speakerEmailSendSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The speaker email send payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.sendOrganizerSpeakerEmails({
      organizationId: organizationId(context),
      eventId: eventId(context),
      accountId: accountId(context),
      previewId: body.previewId,
      idempotencyKey: body.idempotencyKey,
    });
    return context.json({ data }, 202);
  });

  app.get("/email/history", async (context) => {
    const data = await dependencies.service.listOrganizerSpeakerEmailHistory(
      organizationId(context),
      eventId(context),
      accountId(context),
    );
    return context.json({ data });
  });

  app.get("/reminders/eligibility", async (context) => {
    const splitQuery = (value: string | undefined): readonly string[] | undefined => {
      if (value === undefined || value.trim().length === 0) return undefined;
      return value
        .split(",")
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0);
    };
    const taskIds = splitQuery(context.req.query("taskIds"));
    const recipientIds = splitQuery(context.req.query("recipientIds"));
    const data = await dependencies.service.getReminderEligibility({
      eventId: eventId(context),
      accountId: accountId(context),
      ...(taskIds === undefined ? {} : { taskIds }),
      ...(recipientIds === undefined ? {} : { recipientIds }),
    });
    return context.json({ data });
  });
  app.get("/:participantId", async (context) => {
    const data = await dependencies.service.getOrganizerSpeaker(
      organizationId(context),
      eventId(context),
      accountId(context),
      requiredSpeakerParam(context, "participantId"),
    );
    return context.json({ data });
  });

  app.post("/", async (context) => {
    const body = await parseBody(context, canonicalSpeakerSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The speaker payload is invalid."),
        400,
      );
    }
    const travelLogistics = normalizePartialTravelLogistics(body.travelLogistics);
    const data = await dependencies.service.createOrganizerSpeaker({
      organizationId: organizationId(context),
      eventId: eventId(context),
      accountId: accountId(context),
      idempotencyKey: body.idempotencyKey,
      sourceType: body.sourceType,
      ...(body.sourceId === undefined ? {} : { sourceId: body.sourceId }),
      ...(body.participantId === undefined ? {} : { explicitParticipantId: body.participantId }),
      displayName: body.displayName,
      email: body.email,
      jobTitle: body.jobTitle,
      company: body.company,
      biography: body.biography,
      socialLinks: body.socialLinks,
      ...(travelLogistics === undefined ? {} : { travelLogistics }),
      status: body.status,
    });
    return context.json({ data }, 201);
  });

  app.patch("/:participantId", async (context) => {
    const body = await parseBody(context, canonicalSpeakerUpdateSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The speaker update payload is invalid."),
        400,
      );
    }
    const travelLogistics = normalizePartialTravelLogistics(body.travelLogistics);
    const data = await dependencies.service.updateOrganizerSpeaker({
      organizationId: organizationId(context),
      eventId: eventId(context),
      accountId: accountId(context),
      participantId: requiredSpeakerParam(context, "participantId"),
      expectedVersion: body.expectedVersion,
      displayName: body.displayName,
      email: body.email,
      jobTitle: body.jobTitle,
      company: body.company,
      biography: body.biography,
      socialLinks: body.socialLinks,
      ...(travelLogistics === undefined ? {} : { travelLogistics }),
      status: body.status,
    });
    return context.json({ data });
  });

  app.post("/imports/preview", async (context) => {
    const contentLength = context.req.header("content-length");
    if (contentLength !== undefined) {
      const parsedLength = Number(contentLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 1 || parsedLength > 1_048_576) {
        return context.json(
          errorBody(
            context,
            "VALIDATION_ERROR",
            "The CSV file is empty or exceeds the size limit.",
          ),
          400,
        );
      }
    }
    const form = await context.req.raw.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      return context.json(errorBody(context, "VALIDATION_ERROR", "A CSV file is required."), 400);
    }
    if (file.size === 0 || file.size > 1_048_576) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The CSV file is empty or exceeds the size limit."),
        400,
      );
    }
    const csv = new TextDecoder().decode(await file.arrayBuffer());
    const data = await dependencies.service.previewSpeakerImport({
      organizationId: organizationId(context),
      eventId: eventId(context),
      accountId: accountId(context),
      csv,
    });
    return context.json({ data });
  });

  app.post("/imports", async (context) => {
    const body = await parseBody(context, canonicalImportCommitSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The speaker import payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.commitSpeakerImport({
      organizationId: organizationId(context),
      eventId: eventId(context),
      accountId: accountId(context),
      previewId: body.previewId,
      ...(body.sourceDigest === undefined ? {} : { sourceDigest: body.sourceDigest }),
      idempotencyKey: body.idempotencyKey,
    });
    return context.json({ data }, 201);
  });

  app.get("/:participantId/sessions", async (context) => {
    const data = await dependencies.service.listOrganizerSpeakerSessions(
      organizationId(context),
      eventId(context),
      accountId(context),
      requiredSpeakerParam(context, "participantId"),
    );
    return context.json({ data });
  });

  app.get("/:participantId/assets", async (context) => {
    const data = await dependencies.service.listOrganizerSpeakerAssets(
      organizationId(context),
      eventId(context),
      accountId(context),
      requiredSpeakerParam(context, "participantId"),
    );
    return context.json({ data });
  });

  app.post("/invitations/preview", async (context) => {
    const body = await parseBody(context, canonicalInvitationPreviewSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The invitation preview payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.previewOrganizerSpeakerInvitations(
      organizationId(context),
      eventId(context),
      accountId(context),
      body.participantIds,
    );
    return context.json({ data });
  });

  app.post("/invitations/send", async (context) => {
    const body = await parseBody(context, canonicalInvitationSendSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The invitation payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.sendOrganizerSpeakerInvitations({
      organizationId: organizationId(context),
      eventId: eventId(context),
      accountId: accountId(context),
      participantIds: body.participantIds,
      templateId: body.templateId,
      idempotencyKey: body.idempotencyKey,
    });
    return context.json({ data });
  });

  app.onError((error, context) => {
    if (error instanceof SpeakerServiceError) {
      return context.json(errorBody(context, error.code, error.message), error.status);
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "speaker_admin_request_failed",
        traceId: context.get("speakerTraceId"),
        errorName: error.name,
      }),
    );
    return context.json(
      errorBody(context, "INTERNAL_ERROR", "The speaker request could not be completed."),
      500,
    );
  });

  return app;
}
export function createSpeakerTaskAdminRoutes(dependencies: SpeakerRouteDependencies) {
  const app = new Hono<SpeakerRouteEnvironment>();

  app.use("*", async (context, next) => {
    const traceId = traceIdFor(context.req.raw);
    context.set("speakerTraceId", traceId);
    context.header("cache-control", "private, no-store");
    context.header("x-request-id", traceId);
    context.header("x-content-type-options", "nosniff");

    const actor = await dependencies.authenticate(context.req.raw);
    if (!actor?.accountId) {
      return context.json(
        errorBody(context, "AUTHENTICATION_REQUIRED", "Authentication is required."),
        401,
      );
    }
    context.set("speakerAccountId", actor.accountId);
    await next();
  });

  app.get("/", async (context) => {
    const data = await dependencies.service.listOrganizerSpeakerTasks(
      requiredSpeakerParam(context, "organizationId"),
      requiredSpeakerParam(context, "eventId"),
      context.get("speakerAccountId"),
      context.req.query("participantId") || undefined,
    );
    return context.json({ data });
  });

  app.post("/", async (context) => {
    const body = await parseBody(context, canonicalTaskSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The speaker task payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.assignOrganizerSpeakerTask({
      organizationId: requiredSpeakerParam(context, "organizationId"),
      eventId: requiredSpeakerParam(context, "eventId"),
      accountId: context.get("speakerAccountId"),
      ...body,
      assignments: body.assignments.map(({ participantId, subject }) => ({
        participantId,
        subject:
          subject.type === "participant"
            ? { type: "participant" }
            : { type: "session", sessionId: subject.sessionId },
      })),
    });
    return context.json({ data }, 201);
  });
  app.put("/:taskId/reminder-offsets", async (context) => {
    const body = await parseBody(context, organizerTaskReminderOffsetsSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The reminder schedule payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.updateOrganizerTaskReminderOffsets({
      organizationId: requiredSpeakerParam(context, "organizationId"),
      eventId: requiredSpeakerParam(context, "eventId"),
      accountId: context.get("speakerAccountId"),
      taskId: requiredSpeakerParam(context, "taskId"),
      expectedVersion: body.expectedVersion,
      reminderOffsetsMinutes: body.reminderOffsetsMinutes,
    });
    return context.json({ data });
  });

  app.patch("/:taskId", async (context) => {
    const body = await parseBody(context, organizerTaskUpdateSchema);
    if (!body) {
      return context.json(
        errorBody(context, "VALIDATION_ERROR", "The speaker task update payload is invalid."),
        400,
      );
    }
    const data = await dependencies.service.updateOrganizerSpeakerTask({
      organizationId: requiredSpeakerParam(context, "organizationId"),
      eventId: requiredSpeakerParam(context, "eventId"),
      accountId: context.get("speakerAccountId"),
      taskId: requiredSpeakerParam(context, "taskId"),
      expectedVersion: body.expectedVersion,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt }),
      ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
      ...(body.allowedMimeTypes === undefined ? {} : { allowedMimeTypes: body.allowedMimeTypes }),
      ...(body.maxBytes === undefined
        ? body.maxSizeBytes === undefined
          ? {}
          : { maxBytes: body.maxSizeBytes }
        : { maxBytes: body.maxBytes }),
      ...(body.acceptedAssetKinds === undefined
        ? {}
        : { acceptedAssetKinds: body.acceptedAssetKinds }),
      ...(body.dependencyIds === undefined ? {} : { dependencyIds: body.dependencyIds }),
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    return context.json({ data });
  });

  app.onError((error, context) => {
    if (error instanceof SpeakerServiceError) {
      return context.json(errorBody(context, error.code, error.message), error.status);
    }
    return context.json(
      errorBody(context, "INTERNAL_ERROR", "The speaker request could not be completed."),
      500,
    );
  });

  return app;
}
