import { z } from "zod";

export const cfpSubmissionSteps = [
  "welcome",
  "account",
  "submission",
  "participant",
  "review",
] as const;
export type CfpSubmissionStep = (typeof cfpSubmissionSteps)[number];

export interface CfpApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    traceId?: string;
    details?: unknown;
  };
}

export class CfpApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly traceId: string | undefined;
  readonly details: unknown;

  constructor(code: string, message: string, status: number, traceId?: string, details?: unknown) {
    super(message);
    this.name = "CfpApiError";
    this.code = code;
    this.status = status;
    this.traceId = traceId;
    this.details = details;
  }
}
export interface CfpMutationLease {
  sequence: number;
}

export class CfpMutationGate {
  #activeSequence: number | null = null;
  #nextSequence = 0;

  begin(): CfpMutationLease | null {
    if (this.#activeSequence !== null) return null;
    const sequence = ++this.#nextSequence;
    this.#activeSequence = sequence;
    return { sequence };
  }

  isActive(): boolean {
    return this.#activeSequence !== null;
  }

  isCurrent(lease: CfpMutationLease): boolean {
    return this.#activeSequence === lease.sequence;
  }

  finish(lease: CfpMutationLease): void {
    if (this.isCurrent(lease)) this.#activeSequence = null;
  }

  invalidate(): void {
    this.#activeSequence = null;
    this.#nextSequence += 1;
  }
}
export interface CfpFileAssetReference {
  assetId: string;
}

export interface CfpFileUploadAuthorization {
  asset: CfpFileAssetReference & Record<string, unknown>;
  grant: {
    method: "PUT";
    url: string;
    headers: Readonly<Record<string, string>>;
    expiresAt: string;
  };
}

export interface CfpFileUploadResult extends CfpFileAssetReference {
  state: "ready" | "rejected";
  contentType: string;
  sizeBytes: number;
  fileName: string;
}

export function isCfpSchemaVersionConflict(error: unknown): error is CfpApiError {
  if (!(error instanceof CfpApiError) || error.status !== 409) return false;
  const code = error.code.toLowerCase().replaceAll("-", "_");
  if (
    code.includes("form_version") ||
    code.includes("schema_version") ||
    code.includes("stale_form") ||
    (code.includes("schema") && (code.includes("conflict") || code.includes("stale")))
  ) {
    return true;
  }
  const message = error.message.toLowerCase();
  const details =
    error.details === undefined
      ? ""
      : (() => {
          try {
            return JSON.stringify(error.details).toLowerCase();
          } catch {
            return "";
          }
        })();
  return (
    message.includes("schema version") ||
    message.includes("form version") ||
    (message.includes("form") &&
      (message.includes("stale") || message.includes("no longer available"))) ||
    details.includes("formversion") ||
    details.includes("schemaversion")
  );
}

const participantSchema = z
  .object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    role: z.enum(["primary", "co_speaker"]),
    biography: z.string(),
    answers: z.record(z.string(), z.unknown()),
  })
  .loose();

const secondaryContactSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
  })
  .loose();

export const cfpSubmissionSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    eventId: z.string(),
    formId: z.string(),
    ownerAccountId: z.string(),
    formVersion: z.number().int().positive(),
    version: z.number().int().positive(),
    status: z.enum(["draft", "submitted", "reopened", "withdrawn"]),
    completedSteps: z.array(z.enum(cfpSubmissionSteps)),
    answers: z.record(z.string(), z.unknown()),
    participants: z.array(participantSchema),
    secondaryContacts: z.array(secondaryContactSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
    submittedAt: z.string().optional(),
    reopenedAt: z.string().optional(),
    withdrawnAt: z.string().optional(),
    finalDecisionAt: z.string().optional(),
  })
  .loose();
export type CfpServerSubmission = z.infer<typeof cfpSubmissionSchema>;

const publicEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  timezone: z.string(),
  opensAt: z.string(),
  closesAt: z.string(),
});

const formFieldOptionSchema = z.union([
  z.string(),
  z
    .object({
      value: z.string(),
      label: z.string().optional(),
      description: z.string().optional(),
      disabled: z.boolean().optional(),
    })
    .loose(),
]);
const formFieldReferenceSchema = z.union([
  z.string(),
  z
    .object({
      id: z.string(),
      version: z.number().int().positive(),
    })
    .loose(),
]);

const fileRequestSchema = z
  .object({
    allowedMimeTypes: z.array(z.string()).optional(),
    mimeTypes: z.array(z.string()).optional(),
    maxBytes: z.number().int().positive().optional(),
    required: z.boolean().optional(),
    owner: z.string().optional(),
  })
  .loose();

export const cfpFormFieldSchema = z
  .object({
    id: z.string(),
    sectionId: z.string(),
    key: z.string(),
    label: z.string(),
    kind: z.string(),
    description: z.string().optional(),
    placeholder: z.string().optional(),
    required: z.boolean().default(false),
    options: z.array(formFieldOptionSchema).default([]),
    fieldRef: formFieldReferenceSchema.optional(),
    fieldVersion: z.number().int().positive().optional(),
    fileRequest: fileRequestSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
export type CfpFormField = z.infer<typeof cfpFormFieldSchema>;

const formSectionSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().default(""),
  })
  .loose();

const formRulesSchema = z.array(z.record(z.string(), z.unknown()));

const publicFormSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.number().int().positive(),
    status: z.literal("published"),
    welcomeContent: z.string(),
    settings: z
      .object({
        speakerLimit: z.number().int().positive(),
        maxSubmissionsPerAccount: z.number().int().positive(),
        confirmationMessage: z.string(),
        successContent: z.string(),
        redirectUrl: z.string().optional(),
      })
      .loose(),
    sections: z.array(formSectionSchema),
    submissionFields: z.array(cfpFormFieldSchema),
    participantFields: z.array(cfpFormFieldSchema),
    rules: formRulesSchema.default([]),
  })
  .loose();

export const publishedCfpSchema = z.object({
  organization: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
  event: publicEventSchema,
  form: publicFormSchema,
});
export type PublishedCfp = z.infer<typeof publishedCfpSchema>;
export type CfpPublishedForm = PublishedCfp["form"];

const cfpReceiptSchema = z.object({
  id: z.string(),
  submissionId: z.string(),
  version: z.number().int().positive(),
  submittedAt: z.string(),
});
export type CfpReceipt = z.infer<typeof cfpReceiptSchema>;

const cfpSubmitResultSchema = z.object({
  submission: cfpSubmissionSchema,
  receipt: cfpReceiptSchema,
  confirmationQueued: z.boolean(),
});
export type CfpSubmitResult = z.infer<typeof cfpSubmitResultSchema>;
const cfpFileUploadAuthorizationSchema = z.object({
  asset: z
    .object({
      assetId: z.string().trim().min(1),
    })
    .loose(),
  grant: z
    .object({
      method: z.literal("PUT"),
      url: z.string().trim().min(1),
      headers: z.record(z.string(), z.string()),
      expiresAt: z.string().trim().min(1),
    })
    .loose(),
});
const cfpFileUploadResultSchema = z
  .object({
    assetId: z.string().trim().min(1),
    state: z.enum(["ready", "rejected"]),
    contentType: z.string().trim().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .loose();

const eventSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    version: z.number().int().positive(),
    slug: z.string(),
    name: z.string(),
    timezone: z.string(),
    eventStartsAt: z.string().optional(),
    opensAt: z.string(),
    closesAt: z.string(),
  })
  .loose();
const formSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    eventId: z.string(),
    name: z.string(),
    version: z.number().int().positive(),
    status: z.enum(["draft", "published", "closed"]),
    welcomeContent: z.string(),
    settings: z.record(z.string(), z.unknown()),
    sections: z.array(formSectionSchema),
    submissionFields: z.array(cfpFormFieldSchema),
    participantFields: z.array(cfpFormFieldSchema),
    rules: formRulesSchema.default([]),
  })
  .loose();
export type CfpEventConfiguration = z.infer<typeof eventSchema>;
export type CfpFormConfiguration = z.infer<typeof formSchema>;
type CfpWireFormField = Omit<CfpFormField, "fieldRef" | "fieldVersion"> & {
  fieldRef?: Exclude<CfpFormField["fieldRef"], string>;
};

type CfpWireFormConfiguration = Omit<
  CfpFormConfiguration,
  "participantFields" | "submissionFields"
> & {
  participantFields: CfpWireFormField[];
  submissionFields: CfpWireFormField[];
};

function normalizeCfpFormField(
  field: CfpFormField,
  collection: "participantFields" | "submissionFields",
  index: number,
): CfpWireFormField {
  const { fieldRef, fieldVersion, ...fieldWithoutLegacyVersion } = field;
  if (typeof fieldRef === "string") {
    if (typeof fieldVersion !== "number" || !Number.isInteger(fieldVersion) || fieldVersion <= 0) {
      throw new CfpApiError(
        "CFP_INVALID_FIELD_REFERENCE",
        `Reusable field reference at ${collection}[${index}] requires a positive integer fieldVersion.`,
        400,
      );
    }
    return {
      ...fieldWithoutLegacyVersion,
      fieldRef: { id: fieldRef, version: fieldVersion },
    };
  }
  return fieldRef === undefined
    ? fieldWithoutLegacyVersion
    : { ...fieldWithoutLegacyVersion, fieldRef };
}

function normalizeCfpFormPayload(form: CfpFormConfiguration): CfpWireFormConfiguration {
  return {
    ...form,
    participantFields: form.participantFields.map((field, index) =>
      normalizeCfpFormField(field, "participantFields", index),
    ),
    submissionFields: form.submissionFields.map((field, index) =>
      normalizeCfpFormField(field, "submissionFields", index),
    ),
  };
}

export interface CfpOrganizationMembership {
  organizationId: string;
  role: "owner" | "admin" | "reviewer";
}
export interface CfpAuthenticatedSession {
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  memberships: readonly CfpOrganizationMembership[];
}
export type CfpAccountAuthentication =
  | {
      status: "authenticated";
      session: CfpAuthenticatedSession;
    }
  | {
      status: "verification_required";
    };
export interface CfpApi {
  uploadFile?(input: {
    organizationId: string;
    eventId: string;
    submissionId: string;
    fieldKey: string;
    participantId?: string;
    file: File;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<CfpFileUploadResult>;
  getSession(input?: { signal?: AbortSignal }): Promise<CfpAuthenticatedSession | null>;
  getPublished(input: {
    organizationId: string;
    eventId: string;
    formId?: string;
    signal?: AbortSignal;
  }): Promise<PublishedCfp>;
  authenticateAccount(input: {
    email: string;
    mode: "sign_in" | "sign_up";
    password: string;
    name: string;
    verificationCallbackUrl?: string;
  }): Promise<CfpAccountAuthentication>;
  loadDraft(input: {
    organizationId: string;
    eventId: string;
    submissionId: string;
    signal?: AbortSignal;
  }): Promise<CfpServerSubmission>;
  getReceipt(input: {
    organizationId: string;
    eventId: string;
    submissionId: string;
    signal?: AbortSignal;
  }): Promise<CfpReceipt>;
  createDraft(input: {
    organizationId: string;
    eventId: string;
    formId: string;
    idempotencyKey?: string;
  }): Promise<CfpServerSubmission>;
  saveDraft(input: {
    organizationId: string;
    eventId: string;
    submissionId: string;
    expectedVersion: number;
    formVersion: number;
    idempotencyKey?: string;
    completedStep?: CfpSubmissionStep;
    answers?: Record<string, unknown>;
    participants?: CfpServerSubmission["participants"];
    secondaryContacts?: CfpServerSubmission["secondaryContacts"];
  }): Promise<CfpServerSubmission>;
  review(input: {
    organizationId: string;
    eventId: string;
    submissionId: string;
    idempotencyKey?: string;
  }): Promise<{
    submissionId: string;
    version: number;
    canSubmit: boolean;
    issues: Array<{ path: string; code: string; message: string }>;
    matchedRuleIds: string[];
    routes: unknown[];
  }>;
  submit(input: {
    organizationId: string;
    eventId: string;
    submissionId: string;
    expectedVersion: number;
    formVersion: number;
    idempotencyKey?: string;
  }): Promise<CfpSubmitResult>;
  getEvent(input: {
    organizationId: string;
    eventId: string;
    signal?: AbortSignal;
  }): Promise<CfpEventConfiguration>;
  getForm(input: {
    organizationId: string;
    eventId: string;
    formId: string;
    signal?: AbortSignal;
  }): Promise<CfpFormConfiguration>;
  listForms(input: {
    organizationId: string;
    eventId: string;
    signal?: AbortSignal;
  }): Promise<CfpFormConfiguration[]>;
  saveEvent(input: {
    organizationId: string;
    eventId: string;
    event: CfpEventConfiguration;
    expectedVersion: number | null;
    idempotencyKey?: string;
  }): Promise<CfpEventConfiguration>;
  saveForm(input: {
    organizationId: string;
    eventId: string;
    form: CfpFormConfiguration;
    expectedVersion: number | null;
    idempotencyKey?: string;
  }): Promise<CfpFormConfiguration>;
  saveConfiguration(input: {
    organizationId: string;
    eventId: string;
    event: CfpEventConfiguration;
    form: CfpFormConfiguration;
    expectedEventVersion: number | null;
    expectedFormVersion: number | null;
    idempotencyKey?: string;
  }): Promise<{ event: CfpEventConfiguration; form: CfpFormConfiguration }>;
  createForm(input: {
    organizationId: string;
    eventId: string;
    form: CfpFormConfiguration;
    idempotencyKey?: string;
  }): Promise<CfpFormConfiguration>;
  publishForm(input: {
    organizationId: string;
    eventId: string;
    formId: string;
    expectedVersion: number;
    idempotencyKey?: string;
  }): Promise<CfpFormConfiguration>;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function withApiPath(baseUrl: string, path: string): string {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl);
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

function segment(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError("A CFP route identifier is required.");
  return encodeURIComponent(normalized);
}

function resolveUploadGrantUrl(value: string, origin: string): string {
  try {
    return new URL(value).toString();
  } catch {
    const normalizedOrigin = trimTrailingSlash(origin);
    return normalizedOrigin ? new URL(value, `${normalizedOrigin}/`).toString() : value;
  }
}
function makeIdempotencyKey(prefix: string): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("The CFP API requires Web Crypto for idempotent mutations.");
  }
  return `${prefix}-${crypto.randomUUID()}`;
}

async function parseError(response: Response): Promise<CfpApiError> {
  const payload = (await response.json().catch(() => undefined)) as CfpApiErrorBody | undefined;
  return new CfpApiError(
    payload?.error?.code ?? "CFP_REQUEST_FAILED",
    payload?.error?.message ?? "The CFP request could not be completed.",
    response.status,
    payload?.error?.traceId,
    payload?.error?.details,
  );
}
type AuthResponseBody = {
  code?: unknown;
  message?: unknown;
  token?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    traceId?: unknown;
    details?: unknown;
  };
};

type AuthErrorFields = {
  code?: string;
  message?: string;
  traceId?: string;
  details?: unknown;
};

function authErrorFields(body: unknown): AuthErrorFields {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const responseBody = body as AuthResponseBody;
  const nested =
    typeof responseBody.error === "object" &&
    responseBody.error !== null &&
    !Array.isArray(responseBody.error)
      ? responseBody.error
      : undefined;
  const code = nested?.code ?? responseBody.code;
  const message = nested?.message ?? responseBody.message;
  return {
    ...(typeof code === "string" && code.trim() ? { code } : {}),
    ...(typeof message === "string" && message.trim() ? { message } : {}),
    ...(typeof nested?.traceId === "string" ? { traceId: nested.traceId } : {}),
    ...(nested?.details === undefined ? {} : { details: nested.details }),
  };
}

function authError(
  response: Response,
  body: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): CfpApiError {
  const fields = authErrorFields(body);
  const messages: Record<string, string> = {
    INVALID_EMAIL: "Enter a valid email address.",
    INVALID_PASSWORD: "Enter a valid password.",
    PASSWORD_TOO_SHORT: "Password must be at least 8 characters.",
    PASSWORD_TOO_LONG: "Password must be 128 characters or fewer.",
    INVALID_EMAIL_OR_PASSWORD: "The email or password is incorrect.",
    EMAIL_NOT_VERIFIED: "Check your email to verify your account before signing in.",
  };
  return new CfpApiError(
    fields.code ?? fallbackCode,
    messages[fields.code ?? ""] ?? fields.message ?? fallbackMessage,
    response.status,
    fields.traceId,
    fields.details,
  );
}

function isEmailNotVerifiedError(response: Response, body: unknown): boolean {
  const fields = authErrorFields(body);
  return (
    fields.code === "EMAIL_NOT_VERIFIED" ||
    (response.status === 403 && fields.message?.toLowerCase().includes("verif") === true)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authResponsePayload(body: unknown): Record<string, unknown> | null {
  const payload = isRecord(body) && Object.hasOwn(body, "data") ? body.data : body;
  return isRecord(payload) ? payload : null;
}

function hasAuthSession(body: unknown): boolean {
  const payload = authResponsePayload(body);
  if (payload === null) return false;
  if (typeof payload.token === "string" && payload.token.trim().length > 0) return true;
  if (isRecord(payload.session)) return true;
  return isRecord(payload.user) && payload.user.emailVerified === true;
}

function hasUnverifiedAuthUser(body: unknown): boolean {
  const payload = authResponsePayload(body);
  return isRecord(payload?.user) && payload.user.emailVerified === false;
}
export const CFP_REQUEST_TIMEOUT_MS = 20_000;

async function withCfpRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout!: ReturnType<typeof setTimeout>;
  let rejectCaller: ((reason?: unknown) => void) | undefined;
  const callerAbortError =
    callerSignal === undefined
      ? null
      : new Promise<never>((_, reject) => {
          rejectCaller = reject;
        });
  const abortCaller = () => {
    controller.abort();
    rejectCaller?.(new DOMException("The CFP request was aborted.", "AbortError"));
  };
  if (callerSignal?.aborted) {
    abortCaller();
  } else {
    callerSignal?.addEventListener("abort", abortCaller, { once: true });
  }
  const timeoutError = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new CfpApiError("CFP_REQUEST_TIMEOUT", message, 504));
    }, CFP_REQUEST_TIMEOUT_MS);
  });
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race(
      callerSignal === undefined
        ? [operationPromise, timeoutError]
        : [operationPromise, timeoutError, callerAbortError as Promise<never>],
    );
  } catch (error) {
    if (timedOut) {
      throw new CfpApiError("CFP_REQUEST_TIMEOUT", message, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortCaller);
  }
}

function authenticatedSessionFrom(body: unknown): CfpAuthenticatedSession | null {
  const payload = authResponsePayload(body);
  if (payload === null) return null;
  const user = isRecord(payload.user) ? payload.user : null;
  if (user === null) return null;
  const hasSessionCredential =
    (typeof payload.token === "string" && payload.token.trim().length > 0) ||
    isRecord(payload.session);
  if (!hasSessionCredential || user.emailVerified !== true) return null;
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (!email) return null;

  const explicitFirstName =
    typeof user.firstName === "string"
      ? user.firstName.trim()
      : typeof user.givenName === "string"
        ? user.givenName.trim()
        : "";
  const explicitLastName =
    typeof user.lastName === "string"
      ? user.lastName.trim()
      : typeof user.familyName === "string"
        ? user.familyName.trim()
        : "";
  const name = typeof user.name === "string" ? user.name.trim() : "";
  const nameParts = name.split(/\s+/u).filter(Boolean);
  const firstName = explicitFirstName || nameParts[0] || "";
  const lastName = explicitLastName || nameParts.slice(1).join(" ");
  return {
    email,
    name: name || [firstName, lastName].filter(Boolean).join(" ") || email,
    firstName,
    lastName,
    memberships: authenticatedMembershipsFrom(payload, user),
  };
}

function authenticatedMembershipsFrom(
  payload: Record<string, unknown>,
  user: Record<string, unknown>,
): readonly CfpOrganizationMembership[] {
  const source = Array.isArray(payload.memberships)
    ? payload.memberships
    : Array.isArray(user.memberships)
      ? user.memberships
      : [];
  return source.flatMap((value) => {
    if (!isRecord(value)) return [];
    const rawOrganizationId = value.organizationId ?? value.organization_id;
    const organizationId = typeof rawOrganizationId === "string" ? rawOrganizationId.trim() : "";
    const role = typeof value.role === "string" ? value.role.trim().toLowerCase() : "";
    if (organizationId === "" || (role !== "owner" && role !== "admin" && role !== "reviewer")) {
      return [];
    }
    return [{ organizationId, role }];
  });
}

async function authSessionRequest(
  fetcher: Fetcher,
  authBase: string,
  signal?: AbortSignal,
): Promise<{ response: Response; body: unknown }> {
  return withCfpRequestTimeout(
    async (requestSignal) => {
      const response = await fetcher(`${authBase}/get-session`, {
        method: "GET",
        credentials: "include",
        headers: new Headers({ accept: "application/json" }),
        cache: "no-store",
        signal: requestSignal,
      });
      return { response, body: await response.json().catch(() => undefined) };
    },
    signal,
    "The CFP session lookup timed out. Try again.",
  );
}
async function authRequest(
  fetcher: Fetcher,
  authBase: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; body: unknown }> {
  return withCfpRequestTimeout(
    async (requestSignal) => {
      const headers = new Headers({
        accept: "application/json",
        "content-type": "application/json",
      });
      const response = await fetcher(`${authBase}${path}`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      return { response, body: await response.json().catch(() => undefined) };
    },
    undefined,
    "The account request timed out. Check your connection and try again.",
  );
}

export function createCfpApi(baseUrl: string, fetcher: Fetcher = fetch): CfpApi {
  const apiBase = withApiPath(baseUrl, "/api/cfp");
  const publicBase = withApiPath(baseUrl, "/api/public/cfp");
  const authBase = withApiPath(baseUrl, "/api/auth");

  async function request<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return withCfpRequestTimeout(
      async (requestSignal) => {
        const response = await fetcher(url, {
          ...init,
          credentials: "include",
          headers,
          signal: requestSignal,
        });
        if (!response.ok) throw await parseError(response);
        if (response.status === 204) return undefined as T;
        const payload = (await response.json()) as { data?: unknown };
        return schema.parse(payload.data);
      },
      init.signal ?? undefined,
      "The CFP request timed out. Check your connection and try again.",
    );
  }

  function resourcePath(organizationId: string, eventId: string): string {
    return `/organizations/${segment(organizationId)}/events/${segment(eventId)}`;
  }

  function key(prefix: string, provided?: string): string {
    return provided?.trim() || makeIdempotencyKey(prefix);
  }
  async function uploadPrivateFile(
    file: File,
    grant: CfpFileUploadAuthorization["grant"],
    signal?: AbortSignal,
  ): Promise<void> {
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new CfpApiError(
        "CFP_FILE_UPLOAD_EXPIRED",
        "The private file upload authorization has expired.",
        409,
      );
    }
    const response = await withCfpRequestTimeout(
      (requestSignal) =>
        fetcher(resolveUploadGrantUrl(grant.url, baseUrl), {
          method: grant.method,
          credentials: "omit",
          cache: "no-store",
          headers: grant.headers,
          body: file,
          signal: requestSignal,
        }),
      signal,
      "The private file upload timed out. Try again.",
    );
    if (!response.ok) throw await parseError(response);
  }

  return {
    uploadFile: async (input) => {
      const issueKey = key("cfp-file-upload", input.idempotencyKey);
      const authorization = await request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/submissions/${segment(input.submissionId)}/file-requests/${segment(input.fieldKey)}/upload`,
        cfpFileUploadAuthorizationSchema,
        {
          method: "POST",
          headers: { "idempotency-key": issueKey },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          body: JSON.stringify({
            fileName: input.file.name,
            contentType: input.file.type.trim() || "application/octet-stream",
            sizeBytes: input.file.size,
            ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
          }),
        },
      );
      const grantExpiry = Date.parse(authorization.grant.expiresAt);
      if (!Number.isFinite(grantExpiry) || grantExpiry <= Date.now()) {
        throw new CfpApiError(
          "CFP_FILE_UPLOAD_EXPIRED",
          "The private file upload authorization has expired.",
          409,
        );
      }
      await uploadPrivateFile(input.file, authorization.grant, input.signal);
      const finalized = await request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/submissions/${segment(input.submissionId)}/file-requests/${segment(input.fieldKey)}/assets/${segment(authorization.asset.assetId)}/finalize`,
        cfpFileUploadResultSchema,
        {
          method: "POST",
          headers: {
            "idempotency-key": key(
              "cfp-file-finalize",
              input.idempotencyKey === undefined ? undefined : `${input.idempotencyKey}:finalize`,
            ),
          },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          body: JSON.stringify({
            state: "ready",
            ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
          }),
        },
      );
      if (finalized.assetId !== authorization.asset.assetId || finalized.state !== "ready") {
        throw new CfpApiError(
          "CFP_FILE_UPLOAD_REJECTED",
          "The uploaded file was rejected during finalization.",
          409,
        );
      }
      return { ...finalized, fileName: input.file.name };
    },
    getSession: async (input) => {
      const result = await authSessionRequest(fetcher, authBase, input?.signal);
      if (result.response.status === 401 || result.response.status === 403) return null;
      if (!result.response.ok) {
        throw authError(
          result.response,
          result.body,
          "AUTH_SESSION_LOOKUP_FAILED",
          "We could not check your sign-in session.",
        );
      }
      return authenticatedSessionFrom(result.body);
    },
    getPublished(input) {
      const formPath = input.formId === undefined ? "" : `/forms/${segment(input.formId)}`;
      return request(
        `${publicBase}${resourcePath(input.organizationId, input.eventId)}${formPath}`,
        publishedCfpSchema,
        { cache: "no-store", ...(input.signal === undefined ? {} : { signal: input.signal }) },
      );
    },
    authenticateAccount: async (input) => {
      const email = input.email.trim().toLowerCase();
      if (input.mode === "sign_in") {
        const signIn = await authRequest(fetcher, authBase, "/sign-in/email", {
          email,
          password: input.password,
          ...(input.verificationCallbackUrl ? { callbackURL: input.verificationCallbackUrl } : {}),
        });
        if (signIn.response.ok) {
          const session = authenticatedSessionFrom(signIn.body);
          if (session !== null) {
            const refreshed = await authSessionRequest(fetcher, authBase);
            if (!refreshed.response.ok) {
              throw authError(
                refreshed.response,
                refreshed.body,
                "AUTH_SESSION_LOOKUP_FAILED",
                "We could not check your sign-in session.",
              );
            }
            const authoritativeSession = authenticatedSessionFrom(refreshed.body);
            if (authoritativeSession !== null) {
              return { status: "authenticated", session: authoritativeSession };
            }
            throw authError(
              refreshed.response,
              refreshed.body,
              "AUTH_SESSION_NOT_CREATED",
              "Your sign-in session could not be established.",
            );
          }
          if (hasUnverifiedAuthUser(signIn.body)) return { status: "verification_required" };
          throw authError(
            signIn.response,
            signIn.body,
            "AUTH_SESSION_NOT_CREATED",
            "Your sign-in session could not be established.",
          );
        }
        if (isEmailNotVerifiedError(signIn.response, signIn.body)) {
          return { status: "verification_required" };
        }
        throw authError(
          signIn.response,
          signIn.body,
          "AUTH_SIGN_IN_FAILED",
          "We could not sign you in with that email and password.",
        );
      }

      const signUp = await authRequest(fetcher, authBase, "/sign-up/email", {
        email,
        password: input.password,
        name: input.name.trim(),
        ...(input.verificationCallbackUrl ? { callbackURL: input.verificationCallbackUrl } : {}),
      });
      if (!signUp.response.ok) {
        if (isEmailNotVerifiedError(signUp.response, signUp.body)) {
          return { status: "verification_required" };
        }
        throw authError(
          signUp.response,
          signUp.body,
          "AUTH_SIGN_UP_FAILED",
          "We could not create your account.",
        );
      }
      const session = authenticatedSessionFrom(signUp.body);
      if (session !== null) return { status: "authenticated", session };
      if (hasUnverifiedAuthUser(signUp.body) || !hasAuthSession(signUp.body)) {
        return { status: "verification_required" };
      }
      throw authError(
        signUp.response,
        signUp.body,
        "AUTH_SESSION_NOT_CREATED",
        "Your sign-up session could not be established.",
      );
    },

    loadDraft(input) {
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/submissions/${segment(input.submissionId)}/draft`,
        cfpSubmissionSchema,
        { cache: "no-store", ...(input.signal === undefined ? {} : { signal: input.signal }) },
      );
    },
    getReceipt(input) {
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/submissions/${segment(input.submissionId)}/receipt`,
        cfpReceiptSchema,
        { cache: "no-store", ...(input.signal === undefined ? {} : { signal: input.signal }) },
      );
    },

    createDraft(input) {
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/forms/${segment(input.formId)}/drafts`,
        cfpSubmissionSchema,
        { method: "POST", headers: { "idempotency-key": key("cfp-draft", input.idempotencyKey) } },
      );
    },

    async saveDraft(input) {
      const providedIdempotencyKey = input.idempotencyKey?.trim();
      const hasDraftMutation = input.answers !== undefined || input.completedStep !== undefined;
      const hasParticipantMutation =
        input.participants !== undefined || input.secondaryContacts !== undefined;
      const idempotencyKey = key("cfp-save", providedIdempotencyKey);
      const participantsIdempotencyKey = hasParticipantMutation
        ? key(
            "cfp-participants",
            hasDraftMutation && providedIdempotencyKey
              ? `${providedIdempotencyKey}:participants`
              : providedIdempotencyKey,
          )
        : undefined;
      let version = input.expectedVersion;
      let latest: CfpServerSubmission | undefined;
      if (hasDraftMutation) {
        latest = await request(
          `${apiBase}${resourcePath(input.organizationId, input.eventId)}/submissions/${segment(input.submissionId)}/draft`,
          cfpSubmissionSchema,
          {
            method: "PATCH",
            headers: { "idempotency-key": idempotencyKey },
            body: JSON.stringify({
              expectedVersion: version,
              formVersion: input.formVersion,
              ...(input.completedStep === undefined ? {} : { completedStep: input.completedStep }),
              ...(input.answers === undefined ? {} : { answers: input.answers }),
            }),
          },
        );
        version = latest.version;
      }
      if (hasParticipantMutation) {
        latest = await request(
          `${apiBase}${resourcePath(input.organizationId, input.eventId)}/submissions/${segment(input.submissionId)}/participants`,
          cfpSubmissionSchema,
          {
            method: "PUT",
            headers: { "idempotency-key": participantsIdempotencyKey as string },
            body: JSON.stringify({
              expectedVersion: version,
              formVersion: input.formVersion,
              participants: input.participants ?? latest?.participants ?? [],
              ...(input.secondaryContacts === undefined
                ? {}
                : { secondaryContacts: input.secondaryContacts }),
            }),
          },
        );
      }
      if (latest === undefined) {
        latest = await request(
          `${apiBase}${resourcePath(input.organizationId, input.eventId)}/submissions/${segment(input.submissionId)}`,
          cfpSubmissionSchema,
          { cache: "no-store" },
        );
      }
      return latest;
    },

    review(input) {
      const schema = z.object({
        submissionId: z.string(),
        version: z.number().int().positive(),
        canSubmit: z.boolean(),
        issues: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
        matchedRuleIds: z.array(z.string()),
        routes: z.array(z.unknown()),
      });
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/submissions/${segment(input.submissionId)}/review`,
        schema,
        { method: "POST", headers: { "idempotency-key": key("cfp-review", input.idempotencyKey) } },
      );
    },

    submit(input) {
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/submissions/${segment(input.submissionId)}/submit`,
        cfpSubmitResultSchema,
        {
          method: "POST",
          headers: { "idempotency-key": key("cfp-submit", input.idempotencyKey) },
          body: JSON.stringify({
            expectedVersion: input.expectedVersion,
            formVersion: input.formVersion,
          }),
        },
      );
    },

    getEvent(input) {
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/config`,
        eventSchema,
        { cache: "no-store", ...(input.signal === undefined ? {} : { signal: input.signal }) },
      );
    },

    getForm(input) {
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/forms/${segment(input.formId)}`,
        formSchema,
        { cache: "no-store", ...(input.signal === undefined ? {} : { signal: input.signal }) },
      );
    },
    listForms(input) {
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/forms`,
        z.array(formSchema),
        { cache: "no-store", ...(input.signal === undefined ? {} : { signal: input.signal }) },
      );
    },

    saveEvent(input) {
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/config`,
        eventSchema,
        {
          method: "PUT",
          headers: { "idempotency-key": key("cfp-event-save", input.idempotencyKey) },
          body: JSON.stringify({ event: input.event, expectedVersion: input.expectedVersion }),
        },
      );
    },
    async saveConfiguration(input) {
      const form = normalizeCfpFormPayload(input.form);
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/configuration`,
        z.object({ event: eventSchema, form: formSchema }),
        {
          method: "PUT",
          headers: { "idempotency-key": key("cfp-configuration-save", input.idempotencyKey) },
          body: JSON.stringify({
            event: input.event,
            form,
            expectedEventVersion: input.expectedEventVersion,
            expectedFormVersion: input.expectedFormVersion,
          }),
        },
      );
    },

    async saveForm(input) {
      const form = normalizeCfpFormPayload(input.form);
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/forms/${segment(input.form.id)}`,
        formSchema,
        {
          method: "PUT",
          headers: { "idempotency-key": key("cfp-form-save", input.idempotencyKey) },
          body: JSON.stringify({ form, expectedVersion: input.expectedVersion }),
        },
      );
    },
    async createForm(input) {
      const form = normalizeCfpFormPayload(input.form);
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/forms`,
        formSchema,
        {
          method: "POST",
          headers: { "idempotency-key": key("cfp-form-create", input.idempotencyKey) },
          body: JSON.stringify({ form }),
        },
      );
    },

    publishForm(input) {
      return request(
        `${apiBase}${resourcePath(input.organizationId, input.eventId)}/forms/${segment(input.formId)}/publish`,
        formSchema,
        {
          method: "POST",
          headers: { "idempotency-key": key("cfp-form-publish", input.idempotencyKey) },
          body: JSON.stringify({ expectedVersion: input.expectedVersion }),
        },
      );
    },
  };
}
