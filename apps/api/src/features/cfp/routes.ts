import { type ApiErrorCode, apiErrorSchema } from "@eventloom/contracts";
import { type Context, Hono } from "hono";
import { ZodError, z } from "zod";
import { requireOrganizationRole } from "../auth/authorization";
import { AuthAccessError, type UserPrincipal } from "../auth/types";
import {
  cfpFormSchema,
  eventCfpSchema,
  secondaryContactSchema,
  submissionParticipantSchema,
  submissionStepSchema,
} from "./model";
import { CfpError, type CfpService } from "./service";

export interface CfpRouteEnvironment {
  Variables: {
    traceId: string;
    authPrincipal: import("../auth/types").AuthPrincipal | null;
  };
}

export interface CfpRouteService
  extends Pick<
      CfpService,
      | "saveEvent"
      | "saveForm"
      | "saveConfiguration"
      | "createDraft"
      | "saveDraft"
      | "review"
      | "submit"
      | "listOrganizerSubmissions"
    >,
    Partial<
      Pick<
        CfpService,
        | "getEvent"
        | "getForm"
        | "listForms"
        | "getPublishedCfp"
        | "getReceipt"
        | "loadDraft"
        | "createForm"
        | "publishForm"
        | "issueFileUpload"
        | "finalizeFileUpload"
      >
    > {}

export interface CfpRouteDependencies {
  readonly service: CfpRouteService;
}
export interface CfpPublicRouteDependencies {
  readonly service: Partial<Pick<CfpService, "getPublishedCfp" | "loadDraft" | "getReceipt">>;
}

const identifierSchema = z.string().trim().min(1).max(128);
const idempotencyKeySchema = z.string().trim().min(1).max(512);
const expectedVersionSchema = z.number().int().positive();
const saveEventSchema = z
  .object({
    event: eventCfpSchema,
    expectedVersion: expectedVersionSchema.nullable(),
  })
  .strict();
const saveFormSchema = z
  .object({
    form: cfpFormSchema,
    expectedVersion: expectedVersionSchema.nullable(),
  })
  .strict();
const saveConfigurationSchema = z
  .object({
    event: eventCfpSchema,
    form: cfpFormSchema,
    expectedEventVersion: expectedVersionSchema.nullable(),
    expectedFormVersion: expectedVersionSchema.nullable(),
  })
  .strict();
const createFormSchema = z
  .object({
    form: cfpFormSchema,
    expectedVersion: expectedVersionSchema.nullable().optional(),
  })
  .strict();
const publishSchema = z.object({ expectedVersion: expectedVersionSchema }).strict();
const saveDraftSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    formVersion: expectedVersionSchema.optional(),
    completedStep: submissionStepSchema.optional(),
    answers: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const fileUploadSchema = z
  .object({
    participantId: identifierSchema.optional(),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(127),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
const fileFinalizeSchema = z
  .object({
    participantId: identifierSchema.optional(),
    state: z.enum(["ready", "rejected"]),
    rejectionReason: z.string().max(2000).optional(),
  })
  .strict();
const saveParticipantsSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    formVersion: expectedVersionSchema.optional(),
    participants: z.array(submissionParticipantSchema).max(15),
    secondaryContacts: z.array(secondaryContactSchema).max(15).optional(),
  })
  .strict();
const submitSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    formVersion: expectedVersionSchema.optional(),
  })
  .strict();

type CfpContext = Context<CfpRouteEnvironment>;
type ErrorStatus = 400 | 401 | 403 | 404 | 409;

interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

function traceId(context: CfpContext): string {
  return context.get("traceId") ?? crypto.randomUUID();
}

function errorResponse(
  context: CfpContext,
  status: ErrorStatus,
  code: ApiErrorCode,
  message: string,
  details?: readonly ValidationIssue[],
): Response {
  return context.json(
    apiErrorSchema.parse({
      error: {
        code,
        message,
        traceId: traceId(context),
        ...(details === undefined || details.length === 0 ? {} : { details }),
      },
    }),
    status,
  );
}

function validationDetails(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    ),
    code: issue.code,
    message: issue.message,
  }));
}

function cfpErrorDetails(details: unknown): ValidationIssue[] | undefined {
  const candidate =
    typeof details === "object" && details !== null && "issues" in details
      ? details.issues
      : details;
  if (!Array.isArray(candidate)) return undefined;

  const issues = candidate.flatMap((issue): ValidationIssue[] => {
    if (typeof issue !== "object" || issue === null) return [];
    const message = "message" in issue && typeof issue.message === "string" ? issue.message : null;
    if (!message) return [];
    const pathValue = "path" in issue ? issue.path : [];
    const path = Array.isArray(pathValue)
      ? pathValue.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number",
        )
      : typeof pathValue === "string"
        ? [pathValue]
        : [];
    const code = "code" in issue && typeof issue.code === "string" ? issue.code : "invalid";
    return [{ path, code, message }];
  });
  return issues.length === 0 ? undefined : issues;
}

function cfpErrorResponse(context: CfpContext, error: CfpError): Response {
  switch (error.code) {
    case "NOT_FOUND":
      return errorResponse(context, 404, "NOT_FOUND", error.message);
    case "FORBIDDEN":
      return errorResponse(context, 403, "ACCESS_DENIED", error.message);
    case "VALIDATION_FAILED":
    case "IDEMPOTENCY_KEY_REQUIRED":
      return errorResponse(
        context,
        400,
        "VALIDATION_FAILED",
        error.message,
        cfpErrorDetails(error.details),
      );
    case "CONFLICT":
    case "FORM_LIMIT_REACHED":
    case "SUBMISSION_LIMIT_REACHED":
    case "CFP_NOT_OPEN":
    case "CFP_CLOSED":
    case "FORM_NOT_PUBLISHED":
    case "INVALID_TRANSITION":
      return errorResponse(context, 409, "CONFLICT", error.message, cfpErrorDetails(error.details));
  }
}

function routeParam(context: CfpContext, name: string): string {
  return identifierSchema.parse(context.req.param(name));
}

async function body<T>(context: CfpContext, schema: z.ZodType<T>): Promise<T> {
  const payload = await context.req.json().catch(() => undefined);
  return schema.parse(payload);
}

function idempotencyKey(context: CfpContext): string {
  const result = idempotencyKeySchema.safeParse(context.req.header("idempotency-key"));
  if (!result.success) {
    throw new CfpError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required for this request.",
      { issues: result.error.issues },
    );
  }
  return result.data;
}

function applicant(context: CfpContext): UserPrincipal {
  const principal = context.get("authPrincipal");
  if (!principal) {
    throw new AuthAccessError("UNAUTHENTICATED", "Authentication is required.");
  }
  if (principal.kind !== "user") {
    throw new AuthAccessError("FORBIDDEN", "CFP submissions require a user session.");
  }
  return principal;
}

function organizer(context: CfpContext, organizationId: string): UserPrincipal {
  const principal = context.get("authPrincipal");
  if (!principal) {
    throw new AuthAccessError("UNAUTHENTICATED", "Authentication is required.");
  }
  return requireOrganizationRole(principal, organizationId, ["owner", "admin"]);
}

function assertEventPath(
  context: CfpContext,
  resource: { tenantId: string; eventId?: string; id: string },
  resourceName: "event" | "form",
): void {
  const organizationId = routeParam(context, "organizationId");
  const eventId = routeParam(context, "eventId");
  if (resource.tenantId !== organizationId) {
    throw new AuthAccessError("FORBIDDEN", "The CFP resource belongs to another organization.");
  }
  const resourceEventId = resourceName === "event" ? resource.id : resource.eventId;
  if (resourceEventId !== eventId) {
    throw new CfpError("VALIDATION_FAILED", `The ${resourceName} does not match the request path.`);
  }
  if (
    resourceName === "form" &&
    context.req.param("formId") !== undefined &&
    resource.id !== routeParam(context, "formId")
  ) {
    throw new CfpError("VALIDATION_FAILED", "The form does not match the request path.");
  }
}

export function createCfpRoutes(dependencies: CfpRouteDependencies): Hono<CfpRouteEnvironment> {
  const routes = new Hono<CfpRouteEnvironment>();

  routes.use("*", async (context, next) => {
    context.header("cache-control", "private, no-store");
    await next();
  });
  routes.get("/published", async (context) => {
    const service = dependencies.service.getPublishedCfp;
    if (service === undefined) {
      throw new CfpError("NOT_FOUND", "The published CFP form was not found.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
    });
    return context.json({ data });
  });

  routes.get("/forms/:formId/published", async (context) => {
    const service = dependencies.service.getPublishedCfp;
    if (service === undefined) {
      throw new CfpError("NOT_FOUND", "The published CFP form was not found.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      formId: routeParam(context, "formId"),
    });
    return context.json({ data });
  });
  routes.get("/config", async (context) => {
    organizer(context, routeParam(context, "organizationId"));
    const service = dependencies.service.getEvent;
    if (service === undefined) {
      throw new CfpError("NOT_FOUND", "The event CFP configuration was not found.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
    });
    return context.json({ data });
  });
  routes.get("/forms", async (context) => {
    organizer(context, routeParam(context, "organizationId"));
    const service = dependencies.service.listForms;
    if (service === undefined) {
      throw new CfpError("NOT_FOUND", "The CFP forms were not found.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
    });
    return context.json({ data });
  });

  routes.get("/forms/:formId", async (context) => {
    organizer(context, routeParam(context, "organizationId"));
    const service = dependencies.service.getForm;
    if (service === undefined) {
      throw new CfpError("NOT_FOUND", "The CFP form was not found.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      formId: routeParam(context, "formId"),
    });
    if (data.eventId !== routeParam(context, "eventId")) {
      throw new CfpError("FORBIDDEN", "The CFP form does not belong to this event.");
    }
    return context.json({ data });
  });
  routes.get("/submissions", async (context) => {
    organizer(context, routeParam(context, "organizationId"));
    const data = await dependencies.service.listOrganizerSubmissions({
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
    });
    return context.json({ data });
  });

  routes.get("/submissions/:submissionId", async (context) => {
    const principal = applicant(context);
    const service = dependencies.service.loadDraft;
    if (service === undefined) {
      throw new CfpError("NOT_FOUND", "The CFP submission was not found.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      submissionId: routeParam(context, "submissionId"),
      ownerAccountId: principal.userId,
    });
    return context.json({ data });
  });
  routes.get("/submissions/:submissionId/draft", async (context) => {
    const principal = applicant(context);
    const service = dependencies.service.loadDraft;
    if (service === undefined) {
      throw new CfpError("NOT_FOUND", "The CFP submission was not found.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      submissionId: routeParam(context, "submissionId"),
      ownerAccountId: principal.userId,
    });
    return context.json({ data });
  });
  routes.get("/submissions/:submissionId/receipt", async (context) => {
    const principal = applicant(context);
    const service = dependencies.service.getReceipt;
    if (service === undefined) {
      throw new CfpError("NOT_FOUND", "A submission receipt is not available.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      submissionId: routeParam(context, "submissionId"),
      ownerAccountId: principal.userId,
    });
    return context.json({ data });
  });

  routes.post("/forms", async (context) => {
    const principal = organizer(context, routeParam(context, "organizationId"));
    const input = await body(context, createFormSchema);
    assertEventPath(context, input.form, "form");
    const data = dependencies.service.createForm
      ? await dependencies.service.createForm({
          tenantId: routeParam(context, "organizationId"),
          form: input.form,
          expectedVersion: input.expectedVersion ?? null,
          idempotencyKey: idempotencyKey(context),
        })
      : await dependencies.service.saveForm(input.form, input.expectedVersion ?? null);
    void principal;
    return context.json({ data }, 201);
  });

  routes.post("/forms/:formId/publish", async (context) => {
    const principal = organizer(context, routeParam(context, "organizationId"));
    const input = await body(context, publishSchema);
    const service = dependencies.service.publishForm;
    if (service === undefined) {
      throw new CfpError("INVALID_TRANSITION", "Publishing CFP forms is not configured.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      formId: routeParam(context, "formId"),
      organizerId: principal.userId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: idempotencyKey(context),
    });
    return context.json({ data });
  });

  routes.put("/config", async (context) => {
    organizer(context, routeParam(context, "organizationId"));
    const input = await body(context, saveEventSchema);
    assertEventPath(context, input.event, "event");
    return context.json({
      data: await dependencies.service.saveEvent(input.event, input.expectedVersion),
    });
  });
  routes.put("/configuration", async (context) => {
    organizer(context, routeParam(context, "organizationId"));
    const input = await body(context, saveConfigurationSchema);
    assertEventPath(context, input.event, "event");
    assertEventPath(context, input.form, "form");
    return context.json({
      data: await dependencies.service.saveConfiguration({
        ...input,
        idempotencyKey: idempotencyKey(context),
      }),
    });
  });

  routes.put("/forms/:formId", async (context) => {
    organizer(context, routeParam(context, "organizationId"));
    const input = await body(context, saveFormSchema);
    assertEventPath(context, input.form, "form");
    return context.json({
      data: await dependencies.service.saveForm(input.form, input.expectedVersion),
    });
  });

  routes.post("/forms/:formId/drafts", async (context) => {
    const principal = applicant(context);
    const data = await dependencies.service.createDraft({
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      formId: routeParam(context, "formId"),
      ownerAccountId: principal.userId,
      idempotencyKey: idempotencyKey(context),
    });
    return context.json({ data }, 201);
  });

  routes.patch("/submissions/:submissionId/draft", async (context) => {
    const principal = applicant(context);
    const input = await body(context, saveDraftSchema);
    const data = await dependencies.service.saveDraft({
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      submissionId: routeParam(context, "submissionId"),
      ownerAccountId: principal.userId,
      idempotencyKey: idempotencyKey(context),
      expectedVersion: input.expectedVersion,
      ...(input.formVersion === undefined ? {} : { formVersion: input.formVersion }),
      ...(input.completedStep === undefined ? {} : { completedStep: input.completedStep }),
      ...(input.answers === undefined ? {} : { answers: input.answers }),
    });
    return context.json({ data });
  });
  routes.post("/submissions/:submissionId/file-requests/:fieldKey/upload", async (context) => {
    const principal = applicant(context);
    const service = dependencies.service.issueFileUpload;
    if (service === undefined) {
      throw new CfpError("VALIDATION_FAILED", "Private file uploads are not configured.");
    }
    const input = await body(context, fileUploadSchema);
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      submissionId: routeParam(context, "submissionId"),
      ownerAccountId: principal.userId,
      fieldKey: routeParam(context, "fieldKey"),
      idempotencyKey: idempotencyKey(context),
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
    });
    return context.json({ data }, 201);
  });

  routes.post(
    "/submissions/:submissionId/file-requests/:fieldKey/assets/:assetId/finalize",
    async (context) => {
      const principal = applicant(context);
      const service = dependencies.service.finalizeFileUpload;
      if (service === undefined) {
        throw new CfpError("VALIDATION_FAILED", "Private file uploads are not configured.");
      }
      const input = await body(context, fileFinalizeSchema);
      const data = await service.call(dependencies.service, {
        tenantId: routeParam(context, "organizationId"),
        eventId: routeParam(context, "eventId"),
        submissionId: routeParam(context, "submissionId"),
        ownerAccountId: principal.userId,
        fieldKey: routeParam(context, "fieldKey"),
        assetId: routeParam(context, "assetId"),
        idempotencyKey: idempotencyKey(context),
        state: input.state,
        ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
        ...(input.rejectionReason === undefined ? {} : { rejectionReason: input.rejectionReason }),
      });
      return context.json({ data });
    },
  );

  routes.put("/submissions/:submissionId/participants", async (context) => {
    const principal = applicant(context);
    const input = await body(context, saveParticipantsSchema);
    const data = await dependencies.service.saveDraft({
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      submissionId: routeParam(context, "submissionId"),
      ownerAccountId: principal.userId,
      idempotencyKey: idempotencyKey(context),
      expectedVersion: input.expectedVersion,
      ...(input.formVersion === undefined ? {} : { formVersion: input.formVersion }),
      completedStep: "participant",
      participants: input.participants,
      ...(input.secondaryContacts === undefined
        ? {}
        : { secondaryContacts: input.secondaryContacts }),
    });
    return context.json({ data });
  });

  routes.post("/submissions/:submissionId/review", async (context) => {
    const principal = applicant(context);
    const data = await dependencies.service.review({
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      submissionId: routeParam(context, "submissionId"),
      ownerAccountId: principal.userId,
      idempotencyKey: idempotencyKey(context),
    });
    return context.json({ data });
  });

  routes.post("/submissions/:submissionId/submit", async (context) => {
    const principal = applicant(context);
    const input = await body(context, submitSchema);
    const data = await dependencies.service.submit({
      tenantId: routeParam(context, "organizationId"),
      eventId: routeParam(context, "eventId"),
      submissionId: routeParam(context, "submissionId"),
      ownerAccountId: principal.userId,
      idempotencyKey: idempotencyKey(context),
      expectedVersion: input.expectedVersion,
      ...(input.formVersion === undefined ? {} : { formVersion: input.formVersion }),
    });
    return context.json({ data });
  });

  routes.onError((error, context) => {
    if (error instanceof ZodError) {
      return errorResponse(
        context,
        400,
        "VALIDATION_FAILED",
        "The CFP request is invalid.",
        validationDetails(error),
      );
    }
    if (error instanceof AuthAccessError) {
      return errorResponse(
        context,
        error.status,
        error.code === "UNAUTHENTICATED" ? "AUTHENTICATION_REQUIRED" : "ACCESS_DENIED",
        error.message,
      );
    }
    if (error instanceof CfpError) {
      return cfpErrorResponse(context, error);
    }
    throw error;
  });

  return routes;
}
export const CFP_PUBLIC_ROUTE_PREFIX = "/api/public/cfp";

export function createCfpPublicRoutes(
  dependencies: CfpPublicRouteDependencies,
): Hono<CfpRouteEnvironment> {
  const routes = new Hono<CfpRouteEnvironment>();

  routes.use("*", async (context, next) => {
    context.header("cache-control", "private, no-store");
    await next();
  });

  routes.get("/organizations/:organizationId/events/:eventSlug/forms/:formId", async (context) => {
    const service = dependencies.service.getPublishedCfp;
    if (service === undefined) {
      throw new CfpError("NOT_FOUND", "The published CFP form was not found.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventSlug: routeParam(context, "eventSlug"),
      formId: routeParam(context, "formId"),
    });
    return context.json({ data });
  });

  routes.get("/organizations/:organizationId/events/:eventSlug", async (context) => {
    const service = dependencies.service.getPublishedCfp;
    if (service === undefined) {
      throw new CfpError("NOT_FOUND", "The published CFP form was not found.");
    }
    const data = await service.call(dependencies.service, {
      tenantId: routeParam(context, "organizationId"),
      eventSlug: routeParam(context, "eventSlug"),
    });
    return context.json({ data });
  });
  routes.get(
    "/organizations/:organizationId/events/:eventId/submissions/:submissionId/draft",
    async (context) => {
      const principal = applicant(context);
      const service = dependencies.service.loadDraft;
      if (service === undefined) {
        throw new CfpError("NOT_FOUND", "The CFP submission was not found.");
      }
      const data = await service.call(dependencies.service, {
        tenantId: routeParam(context, "organizationId"),
        eventId: routeParam(context, "eventId"),
        submissionId: routeParam(context, "submissionId"),
        ownerAccountId: principal.userId,
      });
      return context.json({ data });
    },
  );

  routes.get(
    "/organizations/:organizationId/events/:eventId/submissions/:submissionId",
    async (context) => {
      const principal = applicant(context);
      const service = dependencies.service.loadDraft;
      if (service === undefined) {
        throw new CfpError("NOT_FOUND", "The CFP submission was not found.");
      }
      const data = await service.call(dependencies.service, {
        tenantId: routeParam(context, "organizationId"),
        eventId: routeParam(context, "eventId"),
        submissionId: routeParam(context, "submissionId"),
        ownerAccountId: principal.userId,
      });
      return context.json({ data });
    },
  );
  routes.get(
    "/organizations/:organizationId/events/:eventId/submissions/:submissionId/receipt",
    async (context) => {
      const principal = applicant(context);
      const service = dependencies.service.getReceipt;
      if (service === undefined) {
        throw new CfpError("NOT_FOUND", "A submission receipt is not available.");
      }
      const data = await service.call(dependencies.service, {
        tenantId: routeParam(context, "organizationId"),
        eventId: routeParam(context, "eventId"),
        submissionId: routeParam(context, "submissionId"),
        ownerAccountId: principal.userId,
      });
      return context.json({ data });
    },
  );

  routes.onError((error, context) => {
    if (error instanceof ZodError) {
      return errorResponse(
        context,
        400,
        "VALIDATION_FAILED",
        "The CFP request is invalid.",
        validationDetails(error),
      );
    }
    if (error instanceof AuthAccessError) {
      return errorResponse(
        context,
        error.status,
        error.code === "UNAUTHENTICATED" ? "AUTHENTICATION_REQUIRED" : "ACCESS_DENIED",
        error.message,
      );
    }
    if (error instanceof CfpError) return cfpErrorResponse(context, error);
    throw error;
  });

  return routes;
}
