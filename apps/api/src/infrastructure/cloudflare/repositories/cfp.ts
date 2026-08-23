import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import { createDatabase, type OpenSessionboardDatabase } from "../../../db/client";
import {
  cfpFormFields,
  cfpFormRules,
  cfpFormSections,
  cfpForms,
  events,
  participants,
  reusableFields,
  submissionAnswers,
  submissionParticipants,
  submissionSecondaryContacts,
  submissions,
} from "../../../db/schema";
import {
  type AuditEntry,
  type CfpForm,
  cfpFormSchema,
  type EventCfp,
  eventCfpSchema,
  type FormField,
  type Submission,
  type SubmissionVersion,
  submissionSchema,
} from "../../../features/cfp/model";
import {
  CfpError,
  type CfpOrganizerSubmissionsReadModel,
  type CfpRepository,
  type CfpReusableField,
} from "../../../features/cfp/service";
import { airtableSyncStatement } from "./shared";

const json = (value: unknown): string => JSON.stringify(value);
const nowIso = (): string => new Date().toISOString();

function conflict(message: string): CfpError {
  return new CfpError("CONFLICT", message);
}

type EventCfpRow = Pick<
  typeof events.$inferSelect,
  | "id"
  | "organizationId"
  | "version"
  | "slug"
  | "name"
  | "timeZone"
  | "startsAt"
  | "endsAt"
  | "cfpOpensAt"
  | "cfpClosesAt"
>;

export function eventCfpFromRow(row: EventCfpRow): EventCfp {
  return eventCfpSchema.parse({
    id: row.id,
    tenantId: row.organizationId,
    version: row.version,
    slug: row.slug,
    name: row.name,
    timezone: row.timeZone,
    eventStartsAt: row.startsAt,
    opensAt: row.cfpOpensAt ?? row.startsAt,
    closesAt: row.cfpClosesAt ?? row.endsAt,
  });
}

export class D1CfpRepository implements CfpRepository {
  readonly #db: D1Database;
  readonly #orm: OpenSessionboardDatabase;
  readonly #now: () => string;
  readonly #token: () => string;

  constructor(db: D1Database, options: { now?: () => string; token?: () => string } = {}) {
    this.#db = db;
    this.#orm = createDatabase(db);
    this.#now = options.now ?? nowIso;
    this.#token =
      options.token ??
      (() =>
        (
          globalThis as unknown as {
            crypto: { randomUUID(): string };
          }
        ).crypto.randomUUID());
  }

  async getEvent(tenantId: string, eventId: string): Promise<EventCfp | null> {
    const rows = await this.#orm
      .select()
      .from(events)
      .where(and(eq(events.organizationId, tenantId), eq(events.id, eventId)))
      .limit(1);
    return rows[0] === undefined ? null : this.#event(rows[0]);
  }

  async getEventBySlug(tenantId: string, eventSlug: string): Promise<EventCfp | null> {
    const rows = await this.#orm
      .select()
      .from(events)
      .where(
        and(
          eq(events.organizationId, tenantId),
          eq(events.slug, eventSlug),
          isNull(events.legacyRetiredAt),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : this.#event(rows[0]);
  }

  async saveEvent(event: EventCfp, expectedVersion: number | null): Promise<void> {
    const current = await this.getEvent(event.tenantId, event.id);
    if (current === null) throw new CfpError("NOT_FOUND", "The event was not found.");
    if (current.version !== expectedVersion)
      throw conflict("The event CFP configuration has changed.");
    const statement = this.#db
      .prepare(
        `UPDATE events SET cfp_enabled = 1, cfp_opens_at = ?, cfp_closes_at = ?, version = ?, updated_at = ?
         WHERE organization_id = ? AND id = ? AND version = ?
           AND julianday(?) <= julianday(starts_at)
           AND julianday(?) <= julianday(starts_at)`,
      )
      .bind(
        event.opensAt,
        event.closesAt,
        event.version,
        this.#now(),
        event.tenantId,
        event.id,
        expectedVersion,
        event.opensAt,
        event.closesAt,
      );
    const [result] = await this.#db.batch([statement]);
    if ((result?.meta?.changes ?? 0) !== 1)
      throw conflict("The event CFP configuration has changed.");
  }

  async getForm(tenantId: string, formId: string): Promise<CfpForm | null> {
    const rows = await this.#orm
      .select()
      .from(cfpForms)
      .where(and(eq(cfpForms.organizationId, tenantId), eq(cfpForms.id, formId)))
      .limit(1);
    return rows[0] === undefined ? null : this.#hydrateForm(rows[0]);
  }

  async listFormsByIds(ids: readonly string[]): Promise<readonly CfpForm[]> {
    if (ids.length === 0) return [];
    const rows = await this.#orm
      .select()
      .from(cfpForms)
      .where(inArray(cfpForms.id, [...new Set(ids)]));
    return Promise.all(rows.map((row) => this.#hydrateForm(row)));
  }

  async listForms(tenantId: string, eventId: string): Promise<CfpForm[]> {
    const rows = await this.#orm
      .select()
      .from(cfpForms)
      .where(and(eq(cfpForms.organizationId, tenantId), eq(cfpForms.eventId, eventId)));
    return Promise.all(rows.map((row) => this.#hydrateForm(row)));
  }

  async saveForm(form: CfpForm, expectedVersion: number | null): Promise<void> {
    const timestamp = this.#now();
    const token = this.#token();
    const guard = (sql: string, values: unknown[]) =>
      this.#db
        .prepare(
          `${sql} AND EXISTS (
             SELECT 1 FROM cfp_configuration_write_guards
             WHERE token = ? AND organization_id = ? AND event_id = ? AND form_id = ?
           )`,
        )
        .bind(...values, token, form.tenantId, form.eventId, form.id);
    const statements: D1PreparedStatement[] = [
      this.#db
        .prepare(
          `INSERT INTO cfp_configuration_write_guards (token, organization_id, event_id, form_id, created_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM events WHERE organization_id = ? AND id = ?)
             AND (
               (? IS NULL AND NOT EXISTS (
                 SELECT 1 FROM cfp_forms WHERE organization_id = ? AND id = ?
               ))
               OR
               (? IS NOT NULL AND EXISTS (
                 SELECT 1 FROM cfp_forms
                 WHERE organization_id = ? AND id = ? AND event_id = ? AND version = ?
               ))
             )`,
        )
        .bind(
          token,
          form.tenantId,
          form.eventId,
          form.id,
          timestamp,
          form.tenantId,
          form.eventId,
          expectedVersion,
          form.tenantId,
          form.id,
          expectedVersion,
          form.tenantId,
          form.id,
          form.eventId,
          expectedVersion,
        ),
    ];
    if (expectedVersion === null) {
      statements.push(
        guard(
          `INSERT INTO cfp_forms (id, organization_id, event_id, name, status, welcome_content, speaker_limit, max_submissions_per_account, reminders_enabled, admin_notifications_enabled, confirmation_message, success_content, redirect_url, version, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1 = 1`,
          [
            form.id,
            form.tenantId,
            form.eventId,
            form.name,
            form.status,
            form.welcomeContent,
            form.settings.speakerLimit,
            form.settings.maxSubmissionsPerAccount,
            form.settings.remindersEnabled ? 1 : 0,
            form.settings.adminNotificationsEnabled ? 1 : 0,
            form.settings.confirmationMessage,
            form.settings.successContent,
            form.settings.redirectUrl ?? null,
            form.version,
            timestamp,
            timestamp,
          ],
        ),
      );
    } else {
      statements.push(
        guard(
          `UPDATE cfp_forms SET name = ?, status = ?, welcome_content = ?, speaker_limit = ?, max_submissions_per_account = ?, reminders_enabled = ?, admin_notifications_enabled = ?, confirmation_message = ?, success_content = ?, redirect_url = ?, version = ?, updated_at = ?
           WHERE organization_id = ? AND id = ? AND event_id = ?`,
          [
            form.name,
            form.status,
            form.welcomeContent,
            form.settings.speakerLimit,
            form.settings.maxSubmissionsPerAccount,
            form.settings.remindersEnabled ? 1 : 0,
            form.settings.adminNotificationsEnabled ? 1 : 0,
            form.settings.confirmationMessage,
            form.settings.successContent,
            form.settings.redirectUrl ?? null,
            form.version,
            timestamp,
            form.tenantId,
            form.id,
            form.eventId,
          ],
        ),
        guard("DELETE FROM cfp_form_rules WHERE organization_id = ? AND form_id = ?", [
          form.tenantId,
          form.id,
        ]),
        guard("DELETE FROM cfp_form_fields WHERE organization_id = ? AND form_id = ?", [
          form.tenantId,
          form.id,
        ]),
        guard("DELETE FROM cfp_form_sections WHERE organization_id = ? AND form_id = ?", [
          form.tenantId,
          form.id,
        ]),
      );
    }
    for (const [index, section] of form.sections.entries()) {
      statements.push(
        guard(
          `INSERT INTO cfp_form_sections (organization_id, form_id, id, title, description, sort_order)
           SELECT ?, ?, ?, ?, ?, ? WHERE 1 = 1`,
          [
            form.tenantId,
            form.id,
            section.id,
            section.title,
            section.description,
            section.order ?? index,
          ],
        ),
      );
    }
    const addFields = (fields: readonly FormField[], scope: "submission" | "participant") => {
      for (const [index, field] of fields.entries()) {
        statements.push(
          guard(
            `INSERT INTO cfp_form_fields (organization_id, form_id, id, section_id, scope, field_key, label, description, placeholder, kind, required, options_json, file_owner, allowed_mime_types_json, max_bytes, reusable_field_id, reusable_field_version, sort_order)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1 = 1`,
            [
              form.tenantId,
              form.id,
              field.id,
              field.sectionId,
              scope,
              field.key,
              field.label,
              field.description ?? null,
              field.placeholder ?? null,
              field.kind,
              field.required ? 1 : 0,
              json(field.options),
              field.fileRequest?.owner ?? null,
              field.fileRequest === undefined ? null : json(field.fileRequest.allowedMimeTypes),
              field.fileRequest?.maxBytes ?? null,
              field.fieldRef?.id ?? null,
              field.fieldRef?.version ?? null,
              index,
            ],
          ),
        );
      }
    };
    addFields(form.submissionFields, "submission");
    addFields(form.participantFields, "participant");
    for (const rule of form.rules) {
      statements.push(
        guard(
          `INSERT INTO cfp_form_rules (organization_id, form_id, id, priority, condition_json, actions_json)
           SELECT ?, ?, ?, ?, ?, ? WHERE 1 = 1`,
          [form.tenantId, form.id, rule.id, rule.priority, json(rule.when), json(rule.actions)],
        ),
      );
    }
    statements.push(
      this.#db
        .prepare(
          `DELETE FROM cfp_configuration_write_guards
           WHERE token = ? AND organization_id = ? AND event_id = ? AND form_id = ?`,
        )
        .bind(token, form.tenantId, form.eventId, form.id),
    );
    try {
      const results = await this.#db.batch(statements);
      if ((results[0]?.meta?.changes ?? 0) !== 1) throw conflict("The CFP form has changed.");
    } catch (error) {
      if (error instanceof CfpError) throw error;
      throw conflict("The CFP form has changed.");
    }
  }

  async saveConfiguration(
    event: EventCfp,
    form: CfpForm,
    expectedEventVersion: number | null,
    expectedFormVersion: number | null,
  ): Promise<void> {
    const timestamp = this.#now();
    const token = this.#token();
    const guard = (sql: string, values: unknown[]) =>
      this.#db
        .prepare(
          `${sql} AND EXISTS (
             SELECT 1 FROM cfp_configuration_write_guards
             WHERE token = ? AND organization_id = ? AND event_id = ? AND form_id = ?
           )`,
        )
        .bind(...values, token, event.tenantId, event.id, form.id);
    const statements: D1PreparedStatement[] = [
      this.#db
        .prepare(
          `INSERT INTO cfp_configuration_write_guards (token, organization_id, event_id, form_id, created_at)
           SELECT ?, ?, ?, ?, ?
           WHERE ? = ? AND ? = ?
             AND EXISTS (
               SELECT 1 FROM events
               WHERE organization_id = ? AND id = ? AND version = ?
                 AND julianday(?) <= julianday(starts_at)
                 AND julianday(?) <= julianday(starts_at)
             )
             AND (
               (? IS NULL AND NOT EXISTS (
                 SELECT 1 FROM cfp_forms WHERE organization_id = ? AND id = ?
               ))
               OR
               (? IS NOT NULL AND EXISTS (
                 SELECT 1 FROM cfp_forms
                 WHERE organization_id = ? AND id = ? AND event_id = ? AND version = ?
               ))
             )`,
        )
        .bind(
          token,
          event.tenantId,
          event.id,
          form.id,
          timestamp,
          form.tenantId,
          event.tenantId,
          form.eventId,
          event.id,
          event.tenantId,
          event.id,
          expectedEventVersion,
          event.opensAt,
          event.closesAt,
          expectedFormVersion,
          form.tenantId,
          form.id,
          expectedFormVersion,
          form.tenantId,
          form.id,
          form.eventId,
          expectedFormVersion,
        ),
    ];
    if (expectedFormVersion === null) {
      statements.push(
        guard(
          `INSERT INTO cfp_forms (id, organization_id, event_id, name, status, welcome_content, speaker_limit, max_submissions_per_account, reminders_enabled, admin_notifications_enabled, confirmation_message, success_content, redirect_url, version, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1 = 1`,
          [
            form.id,
            form.tenantId,
            form.eventId,
            form.name,
            form.status,
            form.welcomeContent,
            form.settings.speakerLimit,
            form.settings.maxSubmissionsPerAccount,
            form.settings.remindersEnabled ? 1 : 0,
            form.settings.adminNotificationsEnabled ? 1 : 0,
            form.settings.confirmationMessage,
            form.settings.successContent,
            form.settings.redirectUrl ?? null,
            form.version,
            timestamp,
            timestamp,
          ],
        ),
      );
    } else {
      statements.push(
        guard(
          `UPDATE cfp_forms SET name = ?, status = ?, welcome_content = ?, speaker_limit = ?, max_submissions_per_account = ?, reminders_enabled = ?, admin_notifications_enabled = ?, confirmation_message = ?, success_content = ?, redirect_url = ?, version = ?, updated_at = ?
           WHERE organization_id = ? AND id = ? AND event_id = ?`,
          [
            form.name,
            form.status,
            form.welcomeContent,
            form.settings.speakerLimit,
            form.settings.maxSubmissionsPerAccount,
            form.settings.remindersEnabled ? 1 : 0,
            form.settings.adminNotificationsEnabled ? 1 : 0,
            form.settings.confirmationMessage,
            form.settings.successContent,
            form.settings.redirectUrl ?? null,
            form.version,
            timestamp,
            form.tenantId,
            form.id,
            form.eventId,
          ],
        ),
        guard("DELETE FROM cfp_form_rules WHERE organization_id = ? AND form_id = ?", [
          form.tenantId,
          form.id,
        ]),
        guard("DELETE FROM cfp_form_fields WHERE organization_id = ? AND form_id = ?", [
          form.tenantId,
          form.id,
        ]),
        guard("DELETE FROM cfp_form_sections WHERE organization_id = ? AND form_id = ?", [
          form.tenantId,
          form.id,
        ]),
      );
    }
    for (const [index, section] of form.sections.entries()) {
      statements.push(
        guard(
          `INSERT INTO cfp_form_sections (organization_id, form_id, id, title, description, sort_order)
           SELECT ?, ?, ?, ?, ?, ? WHERE 1 = 1`,
          [
            form.tenantId,
            form.id,
            section.id,
            section.title,
            section.description,
            section.order ?? index,
          ],
        ),
      );
    }
    const addFields = (fields: readonly FormField[], scope: "submission" | "participant") => {
      for (const [index, field] of fields.entries()) {
        statements.push(
          guard(
            `INSERT INTO cfp_form_fields (organization_id, form_id, id, section_id, scope, field_key, label, description, placeholder, kind, required, options_json, file_owner, allowed_mime_types_json, max_bytes, reusable_field_id, reusable_field_version, sort_order)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1 = 1`,
            [
              form.tenantId,
              form.id,
              field.id,
              field.sectionId,
              scope,
              field.key,
              field.label,
              field.description ?? null,
              field.placeholder ?? null,
              field.kind,
              field.required ? 1 : 0,
              json(field.options),
              field.fileRequest?.owner ?? null,
              field.fileRequest === undefined ? null : json(field.fileRequest.allowedMimeTypes),
              field.fileRequest?.maxBytes ?? null,
              field.fieldRef?.id ?? null,
              field.fieldRef?.version ?? null,
              index,
            ],
          ),
        );
      }
    };
    addFields(form.submissionFields, "submission");
    addFields(form.participantFields, "participant");
    for (const rule of form.rules) {
      statements.push(
        guard(
          `INSERT INTO cfp_form_rules (organization_id, form_id, id, priority, condition_json, actions_json)
           SELECT ?, ?, ?, ?, ?, ? WHERE 1 = 1`,
          [form.tenantId, form.id, rule.id, rule.priority, json(rule.when), json(rule.actions)],
        ),
      );
    }
    statements.push(
      guard(
        `UPDATE events SET cfp_enabled = 1, cfp_opens_at = ?, cfp_closes_at = ?, version = ?, updated_at = ?
         WHERE organization_id = ? AND id = ?`,
        [event.opensAt, event.closesAt, event.version, timestamp, event.tenantId, event.id],
      ),
      this.#db
        .prepare(
          `DELETE FROM cfp_configuration_write_guards
           WHERE token = ? AND organization_id = ? AND event_id = ? AND form_id = ?`,
        )
        .bind(token, event.tenantId, event.id, form.id),
    );
    try {
      const results = await this.#db.batch(statements);
      if ((results[0]?.meta?.changes ?? 0) !== 1) {
        throw conflict("The event CFP configuration has changed.");
      }
    } catch (error) {
      if (error instanceof CfpError) throw error;
      throw conflict("The event CFP configuration has changed.");
    }
  }
  async getReusableField(
    tenantId: string,
    fieldId: string,
    version: number,
  ): Promise<CfpReusableField | null> {
    const rows = await this.#orm
      .select()
      .from(reusableFields)
      .where(
        and(
          eq(reusableFields.organizationId, tenantId),
          eq(reusableFields.id, fieldId),
          eq(reusableFields.version, version),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : { tenantId, id: row.id, version: row.version, field: row.definitionJson as FormField };
  }

  async getSubmission(tenantId: string, submissionId: string): Promise<Submission | null> {
    const rows = await this.#orm
      .select()
      .from(submissions)
      .where(and(eq(submissions.organizationId, tenantId), eq(submissions.id, submissionId)))
      .limit(1);
    return rows[0] === undefined ? null : this.#hydrateSubmission(rows[0]);
  }

  async countOwnedSubmissions(input: {
    tenantId: string;
    eventId: string;
    formId: string;
    ownerAccountId: string;
  }): Promise<number> {
    const rows = await this.#orm
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(
          eq(submissions.organizationId, input.tenantId),
          eq(submissions.eventId, input.eventId),
          eq(submissions.formId, input.formId),
          eq(submissions.ownerAccountId, input.ownerAccountId),
          ne(submissions.status, "withdrawn"),
        ),
      );
    return rows.length;
  }

  async listSubmissionsForEvent(tenantId: string, eventId: string): Promise<Submission[]> {
    const rows = await this.#orm
      .select()
      .from(submissions)
      .where(and(eq(submissions.organizationId, tenantId), eq(submissions.eventId, eventId)));
    return Promise.all(rows.map((row) => this.#hydrateSubmission(row)));
  }

  async getOrganizerSubmissionsReadModel(
    tenantId: string,
    eventId: string,
  ): Promise<CfpOrganizerSubmissionsReadModel> {
    const [event, submissionsForEvent, forms] = await Promise.all([
      this.getEvent(tenantId, eventId),
      this.listSubmissionsForEvent(tenantId, eventId),
      this.listForms(tenantId, eventId),
    ]);
    if (event === null) return { submissions: [], forms: [] };
    return { submissions: submissionsForEvent, forms };
  }

  async saveSubmissionVersion(
    version: SubmissionVersion,
    expectedVersion: number | null,
    audit?: AuditEntry,
  ): Promise<void> {
    const next = submissionSchema.parse(version.submission);
    const current = await this.getSubmission(next.tenantId, next.id);
    if ((current?.version ?? null) !== expectedVersion)
      throw conflict("The CFP submission has changed.");
    const statements: D1PreparedStatement[] = [];
    if (current === null) {
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO submissions (id, organization_id, event_id, form_id, owner_account_id, form_version, status, completed_steps_json, version, created_at, updated_at, submitted_at, reopened_at, withdrawn_at, final_decision_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            next.id,
            next.tenantId,
            next.eventId,
            next.formId,
            next.ownerAccountId,
            next.formVersion,
            next.status,
            json(next.completedSteps),
            next.version,
            next.createdAt,
            next.updatedAt,
            next.submittedAt ?? null,
            next.reopenedAt ?? null,
            next.withdrawnAt ?? null,
            next.finalDecisionAt ?? null,
          ),
      );
    } else {
      statements.push(
        this.#db
          .prepare(
            `UPDATE submissions SET status = ?, completed_steps_json = ?, version = ?, updated_at = ?, submitted_at = ?, reopened_at = ?, withdrawn_at = ?, final_decision_at = ?
         WHERE organization_id = ? AND event_id = ? AND id = ? AND version = ?`,
          )
          .bind(
            next.status,
            json(next.completedSteps),
            next.version,
            next.updatedAt,
            next.submittedAt ?? null,
            next.reopenedAt ?? null,
            next.withdrawnAt ?? null,
            next.finalDecisionAt ?? null,
            next.tenantId,
            next.eventId,
            next.id,
            expectedVersion,
          ),
      );
      statements.push(
        this.#db
          .prepare("DELETE FROM submission_answers WHERE organization_id = ? AND submission_id = ?")
          .bind(next.tenantId, next.id),
        this.#db
          .prepare(
            "DELETE FROM submission_secondary_contacts WHERE organization_id = ? AND submission_id = ?",
          )
          .bind(next.tenantId, next.id),
        this.#db
          .prepare(
            "DELETE FROM submission_participants WHERE organization_id = ? AND submission_id = ?",
          )
          .bind(next.tenantId, next.id),
      );
    }
    for (const [fieldKey, value] of Object.entries(next.answers)) {
      statements.push(
        this.#db
          .prepare(
            "INSERT INTO submission_answers (organization_id, submission_id, field_key, value_json, asset_id) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(next.tenantId, next.id, fieldKey, json(value), null),
      );
    }
    for (const [index, participant] of next.participants.entries()) {
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO participants (id, organization_id, event_id, first_name, last_name, display_name, email, normalized_email, identity_state, source_type, source_id, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'resolved', 'cfp', ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, display_name = excluded.display_name, email = excluded.email, normalized_email = excluded.normalized_email, updated_at = excluded.updated_at
           WHERE participants.organization_id = excluded.organization_id AND participants.event_id = excluded.event_id`,
          )
          .bind(
            participant.id,
            next.tenantId,
            next.eventId,
            participant.firstName,
            participant.lastName,
            `${participant.firstName} ${participant.lastName}`.trim(),
            participant.email,
            participant.email.trim().toLowerCase(),
            next.id,
            next.createdAt,
            next.updatedAt,
          ),
        this.#db
          .prepare(
            "INSERT INTO submission_participants (organization_id, event_id, submission_id, participant_id, role, biography, answers_json, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            next.tenantId,
            next.eventId,
            next.id,
            participant.id,
            participant.role,
            participant.biography,
            json(participant.answers),
            index,
          ),
      );
    }
    for (const [index, contact] of next.secondaryContacts.entries()) {
      statements.push(
        this.#db
          .prepare(
            "INSERT INTO submission_secondary_contacts (organization_id, submission_id, id, name, email, ordinal) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(next.tenantId, next.id, contact.id, contact.name, contact.email, index),
      );
    }
    statements.push(
      this.#db
        .prepare(
          "INSERT INTO submission_versions (organization_id, event_id, submission_id, version, reason, actor_id, idempotency_key, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          next.tenantId,
          next.eventId,
          next.id,
          next.version,
          version.reason,
          version.actorId,
          version.idempotencyKey ?? null,
          json({ submission: next, ...(audit === undefined ? {} : { audit }) }),
          next.updatedAt,
        ),
    );
    statements.push(
      airtableSyncStatement(this.#db, {
        id: `sync:submission:${next.id}:${next.version}`,
        tenantId: next.tenantId,
        entityType: "submission",
        applicationId: next.id,
        sourceVersion: next.version,
        operation: "upsert",
        payloadJson: json(next),
        availableAt: next.updatedAt,
        condition: {
          sql: "EXISTS (SELECT 1 FROM submission_versions WHERE organization_id = ? AND submission_id = ? AND version = ?)",
          values: [next.tenantId, next.id, next.version],
        },
      }),
    );
    try {
      const results = await this.#db.batch(statements);
      if ((results[0]?.meta?.changes ?? 0) !== 1) throw conflict("The CFP submission has changed.");
    } catch (error) {
      if (error instanceof CfpError) throw error;
      throw conflict("The CFP submission has changed.");
    }
  }

  #event(row: typeof events.$inferSelect): EventCfp {
    return eventCfpFromRow(row);
  }

  async #hydrateForm(row: typeof cfpForms.$inferSelect): Promise<CfpForm> {
    const [sections, fields, rules] = await Promise.all([
      this.#orm
        .select()
        .from(cfpFormSections)
        .where(
          and(
            eq(cfpFormSections.organizationId, row.organizationId),
            eq(cfpFormSections.formId, row.id),
          ),
        ),
      this.#orm
        .select()
        .from(cfpFormFields)
        .where(
          and(
            eq(cfpFormFields.organizationId, row.organizationId),
            eq(cfpFormFields.formId, row.id),
          ),
        ),
      this.#orm
        .select()
        .from(cfpFormRules)
        .where(
          and(eq(cfpFormRules.organizationId, row.organizationId), eq(cfpFormRules.formId, row.id)),
        ),
    ]);
    const mappedFields = fields
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(
        (field): FormField => ({
          id: field.id,
          sectionId: field.sectionId,
          key: field.fieldKey,
          label: field.label,
          ...(field.description === null ? {} : { description: field.description }),
          ...(field.placeholder === null ? {} : { placeholder: field.placeholder }),
          kind: field.kind as FormField["kind"],
          required: field.required,
          options: field.optionsJson as string[],
          ...(field.fileOwner === null
            ? {}
            : {
                fileRequest: {
                  owner: field.fileOwner as "submission" | "participant",
                  required: field.required,
                  allowedMimeTypes: field.allowedMimeTypesJson as string[],
                  maxBytes: field.maxBytes as number,
                },
              }),
          ...(field.reusableFieldId === null
            ? {}
            : {
                fieldRef: {
                  id: field.reusableFieldId,
                  version: field.reusableFieldVersion as number,
                },
              }),
        }),
      );
    return cfpFormSchema.parse({
      id: row.id,
      tenantId: row.organizationId,
      eventId: row.eventId,
      name: row.name,
      version: row.version,
      status: row.status,
      welcomeContent: row.welcomeContent,
      settings: {
        speakerLimit: row.speakerLimit,
        maxSubmissionsPerAccount: row.maxSubmissionsPerAccount,
        remindersEnabled: row.remindersEnabled,
        adminNotificationsEnabled: row.adminNotificationsEnabled,
        confirmationMessage: row.confirmationMessage,
        successContent: row.successContent,
        ...(row.redirectUrl === null ? {} : { redirectUrl: row.redirectUrl }),
      },
      sections: sections
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((section) => ({
          id: section.id,
          title: section.title,
          description: section.description,
          order: section.sortOrder,
        })),
      submissionFields: mappedFields.filter(
        (_, index) =>
          fields.sort((a, b) => a.sortOrder - b.sortOrder)[index]?.scope === "submission",
      ),
      participantFields: mappedFields.filter(
        (_, index) =>
          fields.sort((a, b) => a.sortOrder - b.sortOrder)[index]?.scope === "participant",
      ),
      rules: rules
        .sort((a, b) => a.priority - b.priority)
        .map((rule) => ({
          id: rule.id,
          priority: rule.priority,
          when: rule.conditionJson as CfpForm["rules"][number]["when"],
          actions: rule.actionsJson as CfpForm["rules"][number]["actions"],
        })),
    });
  }

  async #hydrateSubmission(row: typeof submissions.$inferSelect): Promise<Submission> {
    const [answers, participantRows, contactRows] = await Promise.all([
      this.#orm
        .select()
        .from(submissionAnswers)
        .where(
          and(
            eq(submissionAnswers.organizationId, row.organizationId),
            eq(submissionAnswers.submissionId, row.id),
          ),
        ),
      this.#orm
        .select({ link: submissionParticipants, participant: participants })
        .from(submissionParticipants)
        .innerJoin(
          participants,
          and(
            eq(participants.organizationId, submissionParticipants.organizationId),
            eq(participants.eventId, submissionParticipants.eventId),
            eq(participants.id, submissionParticipants.participantId),
          ),
        )
        .where(
          and(
            eq(submissionParticipants.organizationId, row.organizationId),
            eq(submissionParticipants.submissionId, row.id),
          ),
        ),
      this.#orm
        .select()
        .from(submissionSecondaryContacts)
        .where(
          and(
            eq(submissionSecondaryContacts.organizationId, row.organizationId),
            eq(submissionSecondaryContacts.submissionId, row.id),
          ),
        ),
    ]);
    return submissionSchema.parse({
      id: row.id,
      tenantId: row.organizationId,
      eventId: row.eventId,
      formId: row.formId,
      ownerAccountId: row.ownerAccountId,
      formVersion: row.formVersion,
      version: row.version,
      status: row.status,
      completedSteps: row.completedStepsJson,
      answers: Object.fromEntries(answers.map((answer) => [answer.fieldKey, answer.valueJson])),
      participants: participantRows
        .sort((a, b) => a.link.ordinal - b.link.ordinal)
        .map(({ link, participant }) => ({
          id: participant.id,
          firstName: participant.firstName,
          lastName: participant.lastName,
          email: participant.email,
          role: link.role,
          biography: link.biography,
          answers: link.answersJson,
        })),
      secondaryContacts: contactRows
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((contact) => ({ id: contact.id, name: contact.name, email: contact.email })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.submittedAt === null ? {} : { submittedAt: row.submittedAt }),
      ...(row.reopenedAt === null ? {} : { reopenedAt: row.reopenedAt }),
      ...(row.withdrawnAt === null ? {} : { withdrawnAt: row.withdrawnAt }),
      ...(row.finalDecisionAt === null ? {} : { finalDecisionAt: row.finalDecisionAt }),
    });
  }
}
