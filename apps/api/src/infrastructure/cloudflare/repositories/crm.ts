import { CrmRepositoryConflictError } from "../../../features/crm/service";
import type {
  CrmContact,
  CrmContactTransitionAudit,
  CrmEventProjection,
  CrmHistoryEntry,
  CrmImportResult,
  CrmMergeReconciliationInput,
  CrmMergeReconciliationResult,
  CrmNote,
  CrmOutreachCommand,
  CrmParticipantConflict,
  CrmParticipantContactLink,
  CrmPipelineEntry,
  CrmRepository,
  CrmRepositoryFilter,
  CrmSegment,
  CrmSegmentRule,
  CrmValue,
} from "../../../features/crm/types";
import {
  batch,
  booleanValue,
  changed,
  consequentialAuditId,
  consequentialStatements,
  type D1StatementCondition,
  guard,
  insertGuard,
  json,
  parseJson,
  rows,
  stableSort,
  statement,
  updateGuard,
} from "./shared";

type Row = Record<string, unknown>;

const stringValue = (value: unknown): string => String(value);
const nullableString = (value: unknown): string | null => (value == null ? null : String(value));
const numberValue = (value: unknown): number => Number(value);

function speakerProjectionStatements(
  database: D1Database,
  projection: CrmEventProjection,
  contact: CrmContact,
): readonly D1PreparedStatement[] {
  const displayParts = contact.displayName.trim().split(/\s+/u).filter(Boolean);
  const firstName = contact.firstName?.trim() || displayParts[0] || contact.displayName;
  const lastName = contact.lastName?.trim() || displayParts.slice(1).join(" ");
  const biographyValue = contact.customFields.biography ?? contact.customFields.bio;
  const biography = typeof biographyValue === "string" ? biographyValue : (contact.notes ?? "");
  const socialLinks = {
    ...(contact.website === null ? {} : { website: contact.website }),
    ...(contact.linkedinUrl === null ? {} : { linkedin: contact.linkedinUrl }),
  };
  const profileId = `profile:${projection.eventId}:${projection.participantId}`;
  return [
    statement(
      database,
      `INSERT OR IGNORE INTO participants
       (id,organization_id,event_id,first_name,last_name,display_name,email,normalized_email,identity_state,source_type,source_id,claimed_user_id,version,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'resolved','crm',?,NULL,1,?,?)`,
      [
        projection.participantId,
        projection.organizationId,
        projection.eventId,
        firstName,
        lastName,
        contact.displayName,
        contact.email,
        contact.email?.trim().toLowerCase() ?? null,
        contact.id,
        projection.createdAt,
        projection.updatedAt,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO speaker_profiles
       (id,organization_id,event_id,participant_id,display_name,email,job_title,company,status,biography,social_links_json,travel_required,arrival_at,departure_at,accommodation,dietary_requirements,accessibility_needs,travel_notes,headshot_asset_id,source_type,source_id,version,created_at,updated_at,admitted_by_account_id,admitted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,'','','','',NULL,'crm',?,1,?,?,?,?)`,
      [
        profileId,
        projection.organizationId,
        projection.eventId,
        projection.participantId,
        contact.displayName,
        contact.email,
        contact.title ?? "",
        contact.company ?? "",
        "pending",
        biography,
        json(socialLinks),
        contact.id,
        projection.createdAt,
        projection.updatedAt,
        projection.createdBy,
        projection.createdAt,
      ],
    ),
  ];
}

function contactFromRow(row: Row, tags: readonly string[] = []): CrmContact {
  return {
    id: stringValue(row.id),
    organizationId: stringValue(row.organization_id),
    firstName: nullableString(row.first_name),
    lastName: nullableString(row.last_name),
    displayName: stringValue(row.display_name),
    email: nullableString(row.email),
    phone: nullableString(row.phone),
    company: nullableString(row.company),
    title: nullableString(row.title),
    website: nullableString(row.website),
    linkedinUrl: nullableString(row.linkedin_url),
    notes: nullableString(row.notes),
    tags,
    customFields: parseJson(String(row.custom_fields_json), {}),
    source: row.source as CrmContact["source"],
    status: row.status as CrmContact["status"],
    mergedIntoId: nullableString(row.merged_into_id),
    mergeAuditId: nullableString(row.merge_audit_id),
    mergedAt: nullableString(row.merged_at),
    mergeSourceIds: parseJson(String(row.merge_source_ids_json), []),
    pipelineStage: row.pipeline_stage as CrmContact["pipelineStage"],
    version: numberValue(row.version),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function segmentFromRow(row: Row): CrmSegment {
  return {
    id: stringValue(row.id),
    organizationId: stringValue(row.organization_id),
    name: stringValue(row.name),
    description: nullableString(row.description),
    rules: parseJson(String(row.rules_json), []),
    mergeAuditIds: parseJson(String(row.merge_audit_ids_json), []),
    createdBy: stringValue(row.created_by),
    version: numberValue(row.version),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function historyFromRow(row: Row): CrmHistoryEntry {
  return {
    id: stringValue(row.id),
    organizationId: stringValue(row.organization_id),
    contactId: stringValue(row.contact_id),
    kind: row.kind as CrmHistoryEntry["kind"],
    eventId: nullableString(row.event_id),
    sessionId: nullableString(row.session_id),
    title: stringValue(row.title),
    detail: nullableString(row.detail),
    occurredAt: stringValue(row.occurred_at),
    metadata: parseJson(String(row.metadata_json), {}),
  };
}

function pipelineFromRow(row: Row): CrmPipelineEntry {
  return {
    id: stringValue(row.id),
    organizationId: stringValue(row.organization_id),
    contactId: stringValue(row.contact_id),
    sourceCrmContactId: stringValue(row.source_crm_contact_id),
    ...(nullableString(row.merge_audit_id) === null
      ? {}
      : { mergeAuditId: nullableString(row.merge_audit_id) as string }),
    fromStage: row.from_stage as CrmPipelineEntry["fromStage"],
    toStage: row.to_stage as CrmPipelineEntry["toStage"],
    note: nullableString(row.note),
    actorId: stringValue(row.actor_id),
    actorName: stringValue(row.actor_name),
    createdAt: stringValue(row.created_at),
  };
}

function noteFromRow(row: Row): CrmNote {
  return {
    id: stringValue(row.id),
    organizationId: stringValue(row.organization_id),
    contactId: stringValue(row.contact_id),
    sourceCrmContactId: stringValue(row.source_crm_contact_id),
    ...(nullableString(row.merge_audit_id) === null
      ? {}
      : { mergeAuditId: nullableString(row.merge_audit_id) as string }),
    body: stringValue(row.body),
    authorId: stringValue(row.author_id),
    createdAt: stringValue(row.created_at),
  };
}

function projectionFromRow(row: Row): CrmEventProjection {
  const crmContactId = stringValue(row.crm_contact_id);
  return {
    id: stringValue(row.id),
    organizationId: stringValue(row.organization_id),
    eventId: stringValue(row.event_id),
    participantId: stringValue(row.participant_id),
    crmContactId,
    contactId: crmContactId,
    ...(nullableString(row.source_crm_contact_id) === null
      ? {}
      : { sourceCrmContactId: nullableString(row.source_crm_contact_id) as string }),
    ...(nullableString(row.merge_audit_id) === null
      ? {}
      : { mergeAuditId: nullableString(row.merge_audit_id) as string }),
    sessionId: nullableString(row.session_id),
    role: row.role as CrmEventProjection["role"],
    note: nullableString(row.note),
    createdBy: stringValue(row.created_by),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function outreachFromRow(row: Row): CrmOutreachCommand {
  return {
    id: stringValue(row.id),
    organizationId: stringValue(row.organization_id),
    contactId: stringValue(row.contact_id),
    eventId: nullableString(row.event_id),
    recipientEmail: stringValue(row.recipient_email),
    templateSubject: stringValue(row.template_subject),
    subject: stringValue(row.subject),
    body: stringValue(row.body),
    renderedBody: stringValue(row.rendered_body),
    status: row.status as CrmOutreachCommand["status"],
    queuedCount: numberValue(row.queued_count),
    sentCount: numberValue(row.sent_count),
    failedCount: numberValue(row.failed_count),
    terminal: booleanValue(numberValue(row.terminal)),
    failureReason: nullableString(row.failure_reason),
    providerMessageId: nullableString(row.provider_message_id),
    completedAt: nullableString(row.completed_at),
    idempotencyKey: stringValue(row.idempotency_key),
    createdBy: stringValue(row.created_by),
    createdAt: stringValue(row.created_at),
  };
}

function replaceContactReference(
  value: CrmValue | readonly CrmSegmentRule[],
  retired: ReadonlySet<string>,
  survivorId: string,
): { value: CrmValue | readonly CrmSegmentRule[]; changed: boolean } {
  if (typeof value === "string")
    return retired.has(value) ? { value: survivorId, changed: true } : { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const replaced = replaceContactReference(item as CrmValue, retired, survivorId);
      changed ||= replaced.changed;
      return replaced.value;
    });
    return { value: next as unknown as readonly CrmSegmentRule[], changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, CrmValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const replaced = replaceContactReference(item, retired, survivorId);
      changed ||= replaced.changed;
      next[key] = replaced.value as CrmValue;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

export class D1CrmRepository implements CrmRepository {
  constructor(private readonly database: D1Database) {}

  async listContacts(
    organizationId: string,
    filter: CrmRepositoryFilter = {},
  ): Promise<readonly CrmContact[]> {
    if (filter.organizationId !== undefined && filter.organizationId !== organizationId) return [];
    const clauses = ["contact.organization_id = ?"];
    const values: (string | number)[] = [organizationId];
    if (filter.email !== undefined) {
      clauses.push("contact.email = ? COLLATE NOCASE");
      values.push(filter.email);
    }
    if (filter.eventId !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM crm_participant_links link WHERE link.organization_id=contact.organization_id AND link.crm_contact_id=contact.id AND link.event_id=?)",
      );
      values.push(filter.eventId);
    }
    if (filter.status !== undefined) {
      clauses.push("contact.status = ?");
      values.push(filter.status);
    }
    if (filter.pipelineStage !== undefined) {
      clauses.push("contact.pipeline_stage = ?");
      values.push(filter.pipelineStage);
    }
    if (filter.company !== undefined) {
      clauses.push("lower(coalesce(contact.company, '')) LIKE ?");
      values.push(`%${filter.company.toLowerCase()}%`);
    }
    if (filter.query !== undefined) {
      clauses.push(
        "(lower(contact.display_name) LIKE ? OR lower(coalesce(contact.email,'')) LIKE ? OR lower(coalesce(contact.company,'')) LIKE ? OR lower(coalesce(contact.title,'')) LIKE ? OR lower(coalesce(contact.phone,'')) LIKE ? OR lower(coalesce(contact.notes,'')) LIKE ?)",
      );
      const query = `%${filter.query.toLowerCase()}%`;
      values.push(query, query, query, query, query, query);
    }
    for (const tag of filter.tags ?? []) {
      clauses.push(
        "EXISTS (SELECT 1 FROM crm_contact_tags tag WHERE tag.organization_id=contact.organization_id AND tag.contact_id=contact.id AND tag.tag=?)",
      );
      values.push(tag);
    }
    if (filter.cursor !== undefined) {
      clauses.push("contact.id > ?");
      values.push(filter.cursor);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 500, 500));
    values.push(limit);
    const result = await statement(
      this.database,
      `SELECT contact.*, coalesce(json_group_array(tag.tag) FILTER (WHERE tag.tag IS NOT NULL), '[]') AS tags_json
      FROM crm_contacts contact LEFT JOIN crm_contact_tags tag ON tag.organization_id=contact.organization_id AND tag.contact_id=contact.id
      WHERE ${clauses.join(" AND ")} GROUP BY contact.id ORDER BY contact.display_name, contact.id LIMIT ?`,
      values,
    ).all<Row>();
    return rows(result).map((row) => contactFromRow(row, parseJson(String(row.tags_json), [])));
  }

  async getContact(organizationId: string, contactId: string): Promise<CrmContact | null> {
    const row = await statement(
      this.database,
      `SELECT contact.*, coalesce(json_group_array(tag.tag) FILTER (WHERE tag.tag IS NOT NULL), '[]') AS tags_json
      FROM crm_contacts contact LEFT JOIN crm_contact_tags tag ON tag.organization_id=contact.organization_id AND tag.contact_id=contact.id
      WHERE contact.organization_id=? AND contact.id=? GROUP BY contact.id`,
      [organizationId, contactId],
    ).first<Row>();
    return row === null ? null : contactFromRow(row, parseJson(String(row.tags_json), []));
  }

  async findContactByEmail(organizationId: string, email: string): Promise<CrmContact | null> {
    const row = await statement(
      this.database,
      `SELECT contact.*, coalesce(json_group_array(tag.tag) FILTER (WHERE tag.tag IS NOT NULL), '[]') AS tags_json
      FROM crm_contacts contact LEFT JOIN crm_contact_tags tag ON tag.organization_id=contact.organization_id AND tag.contact_id=contact.id
      WHERE contact.organization_id=? AND contact.email=? COLLATE NOCASE AND contact.status='active' GROUP BY contact.id LIMIT 1`,
      [organizationId, email],
    ).first<Row>();
    return row === null ? null : contactFromRow(row, parseJson(String(row.tags_json), []));
  }

  async saveContact(
    contact: CrmContact,
    expectedVersion: number | null,
    transitionAudit?: CrmContactTransitionAudit,
  ): Promise<CrmContact> {
    if (contact.version !== (expectedVersion ?? 0) + 1)
      throw new CrmRepositoryConflictError("The contact version is invalid.");
    if (
      transitionAudit !== undefined &&
      (transitionAudit.pipeline.organizationId !== contact.organizationId ||
        transitionAudit.pipeline.contactId !== contact.id ||
        transitionAudit.history.organizationId !== contact.organizationId ||
        transitionAudit.history.contactId !== contact.id)
    ) {
      throw new CrmRepositoryConflictError("The pipeline audit does not match the contact.");
    }
    const contactAction =
      expectedVersion === null ? "created" : contact.status === "merged" ? "merged" : "updated";
    const casGuardAction = "crm.contact.cas_guard";
    const casProbeAction = "crm.contact.cas_probe";
    const casGuardResourceType = "crm_contact_write_guard";
    const casGuardResourceId = `${contact.id}:${crypto.randomUUID()}`;
    const casProbeResourceId = `${contact.id}:${crypto.randomUUID()}`;
    const casCondition: D1StatementCondition =
      expectedVersion === null
        ? {
            sql: "NOT EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=?)",
            values: [contact.organizationId, contact.id],
          }
        : {
            sql: "EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=? AND version=?)",
            values: [contact.organizationId, contact.id, expectedVersion],
          };
    const casGuardWrite = {
      tenantId: contact.organizationId,
      action: casGuardAction,
      resourceType: casGuardResourceType,
      resourceId: casGuardResourceId,
      resourceVersion: contact.version,
      occurredAt: contact.updatedAt,
      condition: casCondition,
    };
    const casGuard = consequentialStatements(this.database, casGuardWrite)[0];
    const casProbeWrite = {
      tenantId: contact.organizationId,
      action: casProbeAction,
      resourceType: casGuardResourceType,
      resourceId: casProbeResourceId,
      resourceVersion: contact.version,
      occurredAt: contact.updatedAt,
      condition: casCondition,
    };
    const casProbe = consequentialStatements(this.database, casProbeWrite)[0];
    const committedCondition: D1StatementCondition = {
      sql: "EXISTS (SELECT 1 FROM audit_events WHERE id=? AND tenant_id=? AND action=? AND resource_type=? AND resource_id=?)",
      values: [
        consequentialAuditId(casGuardWrite),
        contact.organizationId,
        casGuardAction,
        casGuardResourceType,
        casGuardResourceId,
      ],
    };
    const domain =
      expectedVersion === null
        ? statement(
            this.database,
            `INSERT INTO crm_contacts (id,organization_id,first_name,last_name,display_name,email,phone,company,title,website,linkedin_url,notes,custom_fields_json,source,status,merged_into_id,merge_audit_id,merged_at,merge_source_ids_json,pipeline_stage,version,created_at,updated_at)
             SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (${committedCondition.sql})`,
            [...this.contactValues(contact), ...committedCondition.values],
          )
        : statement(
            this.database,
            `UPDATE crm_contacts SET first_name=?,last_name=?,display_name=?,email=?,phone=?,company=?,title=?,website=?,linkedin_url=?,notes=?,custom_fields_json=?,source=?,status=?,merged_into_id=?,merge_audit_id=?,merged_at=?,merge_source_ids_json=?,pipeline_stage=?,version=?,updated_at=?
             WHERE organization_id=? AND id=? AND version=? AND (${committedCondition.sql})`,
            [
              ...this.contactValues(contact).slice(2, 20),
              contact.version,
              contact.updatedAt,
              contact.organizationId,
              contact.id,
              expectedVersion,
              ...committedCondition.values,
            ],
          );
    const statements = [
      casGuard,
      casProbe,
      domain,
      statement(
        this.database,
        `DELETE FROM crm_contact_tags WHERE organization_id=? AND contact_id=? AND (${committedCondition.sql})`,
        [contact.organizationId, contact.id, ...committedCondition.values],
      ),
      ...stableSort(contact.tags, (tag) => tag).map((tag) =>
        statement(
          this.database,
          `INSERT INTO crm_contact_tags (organization_id,contact_id,tag)
           SELECT ?,?,? WHERE (${committedCondition.sql})`,
          [contact.organizationId, contact.id, tag, ...committedCondition.values],
        ),
      ),
      ...(transitionAudit === undefined
        ? []
        : [
            statement(
              this.database,
              `INSERT INTO crm_pipeline_history (id,organization_id,contact_id,source_crm_contact_id,merge_audit_id,from_stage,to_stage,note,actor_id,actor_name,created_at)
               SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (${committedCondition.sql})`,
              [
                transitionAudit.pipeline.id,
                transitionAudit.pipeline.organizationId,
                transitionAudit.pipeline.contactId,
                transitionAudit.pipeline.sourceCrmContactId ?? transitionAudit.pipeline.contactId,
                transitionAudit.pipeline.mergeAuditId ?? null,
                transitionAudit.pipeline.fromStage,
                transitionAudit.pipeline.toStage,
                transitionAudit.pipeline.note,
                transitionAudit.pipeline.actorId,
                transitionAudit.pipeline.actorName,
                transitionAudit.pipeline.createdAt,
                ...committedCondition.values,
              ],
            ),
            ...consequentialStatements(this.database, {
              tenantId: transitionAudit.pipeline.organizationId,
              action: "appended",
              resourceType: "crm_pipeline_history",
              resourceId: transitionAudit.pipeline.id,
              resourceVersion: 1,
              occurredAt: transitionAudit.pipeline.createdAt,
              after: transitionAudit.pipeline,
              condition: committedCondition,
            }),
            statement(
              this.database,
              `INSERT INTO crm_history (id,organization_id,contact_id,kind,event_id,session_id,title,detail,occurred_at,metadata_json)
               SELECT ?,?,?,?,?,?,?,?,?,? WHERE (${committedCondition.sql})`,
              [
                transitionAudit.history.id,
                transitionAudit.history.organizationId,
                transitionAudit.history.contactId,
                transitionAudit.history.kind,
                transitionAudit.history.eventId,
                transitionAudit.history.sessionId,
                transitionAudit.history.title,
                transitionAudit.history.detail,
                transitionAudit.history.occurredAt,
                json(transitionAudit.history.metadata),
                ...committedCondition.values,
              ],
            ),
            ...consequentialStatements(this.database, {
              tenantId: transitionAudit.history.organizationId,
              eventId: transitionAudit.history.eventId,
              action: "appended",
              resourceType: "crm_history",
              resourceId: transitionAudit.history.id,
              resourceVersion: 1,
              occurredAt: transitionAudit.history.occurredAt,
              after: transitionAudit.history,
              condition: committedCondition,
            }),
          ]),
      ...consequentialStatements(this.database, {
        tenantId: contact.organizationId,
        action: contactAction,
        resourceType: "crm_contact",
        resourceId: contact.id,
        resourceVersion: contact.version,
        occurredAt: contact.updatedAt,
        after: contact,
        condition: committedCondition,
        sync: { entityType: "crm_contact", payload: contact },
      }),
      statement(
        this.database,
        "DELETE FROM audit_events WHERE id=? AND tenant_id=? AND action=? AND resource_type=? AND resource_id=?",
        committedCondition.values,
      ),
      statement(
        this.database,
        "DELETE FROM audit_events WHERE id=? AND tenant_id=? AND action=? AND resource_type=? AND resource_id=?",
        [
          consequentialAuditId(casProbeWrite),
          contact.organizationId,
          casProbeAction,
          casGuardResourceType,
          casProbeResourceId,
        ],
      ),
    ];
    const results = await batch(this.database, statements);
    const casResult = results[0];
    if (casResult === undefined) throw new Error("The CRM contact batch returned no CAS result.");
    if (changed(casResult) === 0) {
      const probeResult = results[1];
      if (probeResult === undefined)
        throw new Error("The CRM contact batch returned no CAS probe result.");
      if (changed(probeResult) > 0)
        throw new Error("The CRM contact CAS guard could not be acquired.");
      const current = await this.getContact(contact.organizationId, contact.id);
      throw new CrmRepositoryConflictError(
        "The contact changed before it could be saved.",
        undefined,
        current ?? undefined,
      );
    }
    return contact;
  }

  async listSegments(organizationId: string): Promise<readonly CrmSegment[]> {
    const result = await statement(
      this.database,
      "SELECT * FROM crm_segments WHERE organization_id=? ORDER BY name,id",
      [organizationId],
    ).all<Row>();
    return rows(result).map(segmentFromRow);
  }
  async getSegment(organizationId: string, segmentId: string): Promise<CrmSegment | null> {
    const row = await statement(
      this.database,
      "SELECT * FROM crm_segments WHERE organization_id=? AND id=?",
      [organizationId, segmentId],
    ).first<Row>();
    return row === null ? null : segmentFromRow(row);
  }
  async saveSegment(segment: CrmSegment, expectedVersion: number | null): Promise<CrmSegment> {
    if (segment.version !== (expectedVersion ?? 0) + 1)
      throw new CrmRepositoryConflictError("The segment version is invalid.");
    const domain =
      expectedVersion === null
        ? statement(
            this.database,
            "INSERT INTO crm_segments (id,organization_id,name,description,rules_json,merge_audit_ids_json,created_by,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
              segment.id,
              segment.organizationId,
              segment.name,
              segment.description,
              json(segment.rules),
              json(segment.mergeAuditIds ?? []),
              segment.createdBy,
              segment.version,
              segment.createdAt,
              segment.updatedAt,
            ],
          )
        : statement(
            this.database,
            "UPDATE crm_segments SET name=?,description=?,rules_json=?,merge_audit_ids_json=?,version=?,updated_at=? WHERE organization_id=? AND id=? AND version=?",
            [
              segment.name,
              segment.description,
              json(segment.rules),
              json(segment.mergeAuditIds ?? []),
              segment.version,
              segment.updatedAt,
              segment.organizationId,
              segment.id,
              expectedVersion,
            ],
          );
    try {
      await batch(this.database, [
        expectedVersion === null
          ? insertGuard(this.database, "crm_segments", "organization_id=? AND id=?", [
              segment.organizationId,
              segment.id,
            ])
          : updateGuard(this.database, "crm_segments", "organization_id=? AND id=? AND version=?", [
              segment.organizationId,
              segment.id,
              expectedVersion,
            ]),
        domain,
        ...consequentialStatements(this.database, {
          tenantId: segment.organizationId,
          action: expectedVersion === null ? "created" : "updated",
          resourceType: "crm_segment",
          resourceId: segment.id,
          resourceVersion: segment.version,
          occurredAt: segment.updatedAt,
          after: segment,
          sync: { entityType: "crm_segment", payload: segment },
        }),
      ]);
    } catch (error) {
      throw this.conflict(error, "The segment changed before it could be saved.");
    }
    return segment;
  }
  async deleteSegment(
    organizationId: string,
    segmentId: string,
    expectedVersion: number,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    try {
      await batch(this.database, [
        updateGuard(this.database, "crm_segments", "organization_id=? AND id=? AND version=?", [
          organizationId,
          segmentId,
          expectedVersion,
        ]),
        statement(
          this.database,
          "DELETE FROM crm_segments WHERE organization_id=? AND id=? AND version=?",
          [organizationId, segmentId, expectedVersion],
        ),
        ...consequentialStatements(this.database, {
          tenantId: organizationId,
          action: "deleted",
          resourceType: "crm_segment",
          resourceId: segmentId,
          resourceVersion: expectedVersion,
          occurredAt,
          sync: { entityType: "crm_segment", operation: "delete" },
        }),
      ]);
    } catch (error) {
      throw this.conflict(error, "The segment changed before it could be deleted.");
    }
  }

  async listHistory(
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmHistoryEntry[]> {
    const result = await statement(
      this.database,
      "SELECT * FROM crm_history WHERE organization_id=? AND contact_id=? ORDER BY occurred_at,id",
      [organizationId, contactId],
    ).all<Row>();
    return rows(result).map(historyFromRow);
  }
  async appendHistory(entry: CrmHistoryEntry): Promise<CrmHistoryEntry> {
    const existing = await statement(this.database, "SELECT * FROM crm_history WHERE id=?", [
      entry.id,
    ]).first<Row>();
    if (existing !== null) {
      if (existing.organization_id !== entry.organizationId)
        throw new CrmRepositoryConflictError("The history entry belongs to another organization.");
      return historyFromRow(existing);
    }
    try {
      await batch(this.database, [
        guard(
          this.database,
          "EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=?)",
          [entry.organizationId, entry.contactId],
        ),
        statement(
          this.database,
          "INSERT INTO crm_history (id,organization_id,contact_id,kind,event_id,session_id,title,detail,occurred_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [
            entry.id,
            entry.organizationId,
            entry.contactId,
            entry.kind,
            entry.eventId,
            entry.sessionId,
            entry.title,
            entry.detail,
            entry.occurredAt,
            json(entry.metadata),
          ],
        ),
        ...consequentialStatements(this.database, {
          tenantId: entry.organizationId,
          eventId: entry.eventId,
          action: "appended",
          resourceType: "crm_history",
          resourceId: entry.id,
          resourceVersion: 1,
          occurredAt: entry.occurredAt,
          after: entry,
        }),
      ]);
    } catch (error) {
      throw this.conflict(error, "The history entry could not be saved.");
    }
    return entry;
  }
  async listPipelineHistory(
    organizationId: string,
    contactId: string,
  ): Promise<readonly CrmPipelineEntry[]> {
    const result = await statement(
      this.database,
      "SELECT * FROM crm_pipeline_history WHERE organization_id=? AND contact_id=? ORDER BY created_at,id",
      [organizationId, contactId],
    ).all<Row>();
    return rows(result).map(pipelineFromRow);
  }
  async appendPipeline(entry: CrmPipelineEntry): Promise<CrmPipelineEntry> {
    const existing = await statement(
      this.database,
      "SELECT * FROM crm_pipeline_history WHERE id=?",
      [entry.id],
    ).first<Row>();
    if (existing !== null) {
      if (existing.organization_id !== entry.organizationId)
        throw new CrmRepositoryConflictError("The pipeline entry belongs to another organization.");
      return pipelineFromRow(existing);
    }
    const source = entry.sourceCrmContactId ?? entry.contactId;
    try {
      await batch(this.database, [
        guard(
          this.database,
          "EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=?) AND EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=?)",
          [entry.organizationId, entry.contactId, entry.organizationId, source],
        ),
        statement(
          this.database,
          "INSERT INTO crm_pipeline_history (id,organization_id,contact_id,source_crm_contact_id,merge_audit_id,from_stage,to_stage,note,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          [
            entry.id,
            entry.organizationId,
            entry.contactId,
            source,
            entry.mergeAuditId ?? null,
            entry.fromStage,
            entry.toStage,
            entry.note,
            entry.actorId,
            entry.actorName,
            entry.createdAt,
          ],
        ),
        ...consequentialStatements(this.database, {
          tenantId: entry.organizationId,
          action: "appended",
          resourceType: "crm_pipeline_history",
          resourceId: entry.id,
          resourceVersion: 1,
          occurredAt: entry.createdAt,
          after: entry,
        }),
      ]);
    } catch (error) {
      throw this.conflict(error, "The pipeline entry could not be saved.");
    }
    return { ...entry, sourceCrmContactId: source };
  }
  async listNotes(organizationId: string, contactId: string): Promise<readonly CrmNote[]> {
    const result = await statement(
      this.database,
      "SELECT * FROM crm_notes WHERE organization_id=? AND contact_id=? ORDER BY created_at,id",
      [organizationId, contactId],
    ).all<Row>();
    return rows(result).map(noteFromRow);
  }
  async appendNote(note: CrmNote): Promise<CrmNote> {
    const existing = await statement(this.database, "SELECT * FROM crm_notes WHERE id=?", [
      note.id,
    ]).first<Row>();
    if (existing !== null) {
      if (existing.organization_id !== note.organizationId)
        throw new CrmRepositoryConflictError("The note belongs to another organization.");
      return noteFromRow(existing);
    }
    const source = note.sourceCrmContactId ?? note.contactId;
    try {
      await batch(this.database, [
        guard(
          this.database,
          "EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=?) AND EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=?)",
          [note.organizationId, note.contactId, note.organizationId, source],
        ),
        statement(
          this.database,
          "INSERT INTO crm_notes (id,organization_id,contact_id,source_crm_contact_id,merge_audit_id,body,author_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
          [
            note.id,
            note.organizationId,
            note.contactId,
            source,
            note.mergeAuditId ?? null,
            note.body,
            note.authorId,
            note.createdAt,
          ],
        ),
        ...consequentialStatements(this.database, {
          tenantId: note.organizationId,
          action: "appended",
          resourceType: "crm_note",
          resourceId: note.id,
          resourceVersion: 1,
          occurredAt: note.createdAt,
          after: note,
        }),
      ]);
    } catch (error) {
      throw this.conflict(error, "The note could not be saved.");
    }
    return { ...note, sourceCrmContactId: source };
  }

  async getProjection(
    organizationId: string,
    eventId: string,
    crmContactId: string,
  ): Promise<CrmEventProjection | null> {
    const row = await statement(
      this.database,
      "SELECT * FROM crm_participant_links WHERE organization_id=? AND event_id=? AND crm_contact_id=? ORDER BY id LIMIT 1",
      [organizationId, eventId, crmContactId],
    ).first<Row>();
    return row === null ? null : projectionFromRow(row);
  }
  async saveProjection(
    projection: CrmEventProjection,
    contact: CrmContact,
  ): Promise<CrmEventProjection> {
    if (
      contact.organizationId !== projection.organizationId ||
      contact.id !== projection.crmContactId
    )
      throw new CrmRepositoryConflictError(
        "The projected contact does not belong to this organization.",
      );
    const existing = await statement(
      this.database,
      "SELECT * FROM crm_participant_links WHERE organization_id=? AND event_id=? AND (participant_id=? OR crm_contact_id=?) ORDER BY CASE WHEN participant_id=? THEN 0 ELSE 1 END LIMIT 1",
      [
        projection.organizationId,
        projection.eventId,
        projection.participantId,
        projection.crmContactId,
        projection.participantId,
      ],
    ).first<Row>();
    if (existing !== null) {
      const saved = projectionFromRow(existing);
      await batch(this.database, [
        guard(
          this.database,
          "EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=?) AND EXISTS (SELECT 1 FROM events WHERE organization_id=? AND id=?)",
          [saved.organizationId, saved.crmContactId, saved.organizationId, saved.eventId],
        ),
        ...speakerProjectionStatements(this.database, saved, contact),
      ]);
      return saved;
    }
    try {
      await batch(this.database, [
        guard(
          this.database,
          "EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=?) AND EXISTS (SELECT 1 FROM events WHERE organization_id=? AND id=?)",
          [
            projection.organizationId,
            projection.crmContactId,
            projection.organizationId,
            projection.eventId,
          ],
        ),
        statement(
          this.database,
          "INSERT INTO crm_participant_links (id,organization_id,event_id,participant_id,crm_contact_id,source_crm_contact_id,merge_audit_id,session_id,role,note,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            projection.id,
            projection.organizationId,
            projection.eventId,
            projection.participantId,
            projection.crmContactId,
            projection.sourceCrmContactId ?? null,
            projection.mergeAuditId ?? null,
            projection.sessionId,
            projection.role,
            projection.note,
            projection.createdBy,
            projection.createdAt,
            projection.updatedAt,
          ],
        ),
        ...speakerProjectionStatements(this.database, projection, contact),
        ...consequentialStatements(this.database, {
          tenantId: projection.organizationId,
          eventId: projection.eventId,
          action: "created",
          resourceType: "crm_participant_link",
          resourceId: projection.id,
          resourceVersion: 1,
          occurredAt: projection.updatedAt,
          after: projection,
          sync: { entityType: "crm_participant_link", payload: projection },
        }),
      ]);
    } catch (error) {
      const concurrent = await this.getProjection(
        projection.organizationId,
        projection.eventId,
        projection.crmContactId,
      );
      if (concurrent !== null) return this.saveProjection(concurrent, contact);
      throw this.conflict(error, "The event projection could not be saved.");
    }
    return projection;
  }
  async listProjections(organizationId: string): Promise<readonly CrmEventProjection[]> {
    const result = await statement(
      this.database,
      "SELECT * FROM crm_participant_links WHERE organization_id=? ORDER BY event_id,participant_id",
      [organizationId],
    ).all<Row>();
    return rows(result).map(projectionFromRow);
  }
  async listParticipantContactLinks(
    organizationId: string,
  ): Promise<readonly CrmParticipantContactLink[]> {
    return (await this.listProjections(organizationId)).map(
      ({ contactId: _contactId, ...link }) => link,
    );
  }

  async reconcileContactMerge(
    input: CrmMergeReconciliationInput,
  ): Promise<CrmMergeReconciliationResult> {
    const retiredIds = [...new Set(input.retiredIds)].sort();
    if (retiredIds.length === 0 || retiredIds.includes(input.survivorId))
      throw new CrmRepositoryConflictError(
        "Retired CRM contacts must be unique and different from the survivor.",
      );
    const prior = await this.getCommandResult<CrmMergeReconciliationResult>(
      input.organizationId,
      "reconcile-contact-merge",
      input.auditId,
    );
    if (prior !== null) {
      if (prior.survivorId !== input.survivorId || json(prior.retiredIds) !== json(retiredIds))
        throw new CrmRepositoryConflictError(
          "The CRM merge audit was already used for another reconciliation.",
        );
      return prior;
    }
    const placeholders = retiredIds.map(() => "?").join(",");
    const contacts = await statement(
      this.database,
      `SELECT * FROM crm_contacts WHERE organization_id=? AND id IN (?,${placeholders})`,
      [input.organizationId, input.survivorId, ...retiredIds],
    ).all<Row>();
    const mapped = rows(contacts).map((row) => contactFromRow(row));
    const survivor = mapped.find((item) => item.id === input.survivorId);
    if (survivor?.status !== "active")
      throw new CrmRepositoryConflictError("The CRM merge survivor is not active.");
    for (const id of retiredIds) {
      const retired = mapped.find((item) => item.id === id);
      if (
        retired?.status !== "merged" ||
        retired.mergedIntoId !== input.survivorId ||
        retired.mergeAuditId !== input.auditId
      )
        throw new CrmRepositoryConflictError(
          `Retired CRM contact ${id} does not match this merge audit.`,
        );
    }
    const links = await this.listProjections(input.organizationId);
    const affected = new Set([input.survivorId, ...retiredIds]);
    const conflicts: CrmParticipantConflict[] = [];
    const byEvent = new Map<string, CrmEventProjection[]>();
    for (const link of links.filter((item) => affected.has(item.crmContactId))) {
      const list = byEvent.get(link.eventId) ?? [];
      list.push(link);
      byEvent.set(link.eventId, list);
    }
    for (const [eventId, eventLinks] of byEvent) {
      const participants = [...new Set(eventLinks.map((item) => item.participantId))];
      if (participants.length > 1)
        conflicts.push({
          eventId,
          participantIds: participants.sort(),
          crmContactIds: [...new Set(eventLinks.map((item) => item.crmContactId))].sort(),
          reason: "distinct-participants-share-merged-contacts",
        });
    }
    if (conflicts.length > 0)
      throw new CrmRepositoryConflictError(
        "The merge would reconcile distinct participants in one event.",
        conflicts,
      );
    const noteRows = await statement(
      this.database,
      `SELECT * FROM crm_notes WHERE organization_id=? AND contact_id IN (${placeholders})`,
      [input.organizationId, ...retiredIds],
    ).all<Row>();
    const pipelineRows = await statement(
      this.database,
      `SELECT * FROM crm_pipeline_history WHERE organization_id=? AND contact_id IN (${placeholders})`,
      [input.organizationId, ...retiredIds],
    ).all<Row>();
    const segmentRows = await statement(
      this.database,
      "SELECT * FROM crm_segments WHERE organization_id=?",
      [input.organizationId],
    ).all<Row>();
    const linkTargets = links.filter((item) => retiredIds.includes(item.crmContactId));
    const segments = rows(segmentRows)
      .map(segmentFromRow)
      .flatMap((segment) => {
        const replaced = replaceContactReference(
          segment.rules,
          new Set(retiredIds),
          input.survivorId,
        );
        return replaced.changed
          ? [{ segment, rules: replaced.value as readonly CrmSegmentRule[] }]
          : [];
      });
    const result: CrmMergeReconciliationResult = {
      survivorId: input.survivorId,
      retiredIds,
      rewired: {
        participantContactLinks: linkTargets.length,
        notes: rows(noteRows).length,
        segments: segments.length,
        pipelineHistory: rows(pipelineRows).length,
      },
      participantConflicts: [],
      auditId: input.auditId,
    };
    const occurredAt = survivor.updatedAt;
    const statements = [
      guard(
        this.database,
        `EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=? AND status='active') AND (SELECT count(*) FROM crm_contacts WHERE organization_id=? AND id IN (${placeholders}) AND status='merged' AND merged_into_id=? AND merge_audit_id=?)=?`,
        [
          input.organizationId,
          input.survivorId,
          input.organizationId,
          ...retiredIds,
          input.survivorId,
          input.auditId,
          retiredIds.length,
        ],
      ),
      ...linkTargets.map((link) =>
        statement(
          this.database,
          "UPDATE crm_participant_links SET crm_contact_id=?,source_crm_contact_id=coalesce(source_crm_contact_id,?),merge_audit_id=? WHERE organization_id=? AND id=? AND crm_contact_id=?",
          [
            input.survivorId,
            link.crmContactId,
            input.auditId,
            input.organizationId,
            link.id,
            link.crmContactId,
          ],
        ),
      ),
      statement(
        this.database,
        `UPDATE crm_notes SET contact_id=?,source_crm_contact_id=coalesce(source_crm_contact_id,contact_id),merge_audit_id=? WHERE organization_id=? AND contact_id IN (${placeholders})`,
        [input.survivorId, input.auditId, input.organizationId, ...retiredIds],
      ),
      statement(
        this.database,
        `UPDATE crm_pipeline_history SET contact_id=?,source_crm_contact_id=coalesce(source_crm_contact_id,contact_id),merge_audit_id=? WHERE organization_id=? AND contact_id IN (${placeholders})`,
        [input.survivorId, input.auditId, input.organizationId, ...retiredIds],
      ),
      ...segments.map(({ segment, rules }) =>
        statement(
          this.database,
          "UPDATE crm_segments SET rules_json=?,merge_audit_ids_json=?,version=version+1 WHERE organization_id=? AND id=? AND version=?",
          [
            json(rules),
            json([...new Set([...(segment.mergeAuditIds ?? []), input.auditId])]),
            input.organizationId,
            segment.id,
            segment.version,
          ],
        ),
      ),
      statement(
        this.database,
        "INSERT INTO crm_command_results (organization_id,command,idempotency_key,result_json,created_at,expires_at) VALUES (?,'reconcile-contact-merge',?,?,?,NULL)",
        [input.organizationId, input.auditId, json(result), occurredAt],
      ),
      ...consequentialStatements(this.database, {
        tenantId: input.organizationId,
        action: "reconciled",
        resourceType: "crm_contact_merge",
        resourceId: input.auditId,
        resourceVersion: survivor.version,
        occurredAt,
        after: result,
        sync: {
          entityType: "crm_contact",
          applicationId: input.survivorId,
          operation: "reconcile",
          payload: result,
        },
      }),
    ];
    try {
      await batch(this.database, statements);
    } catch (error) {
      throw this.conflict(error, "CRM relationships changed during reconciliation.");
    }
    return result;
  }

  async saveOutreach(command: CrmOutreachCommand): Promise<CrmOutreachCommand> {
    const existing = await this.getOutreachByIdempotencyKey(
      command.organizationId,
      command.idempotencyKey,
    );
    if (existing !== null) return existing;
    try {
      await batch(this.database, [
        guard(
          this.database,
          "EXISTS (SELECT 1 FROM crm_contacts WHERE organization_id=? AND id=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM events WHERE organization_id=? AND id=?))",
          [
            command.organizationId,
            command.contactId,
            command.eventId,
            command.organizationId,
            command.eventId,
          ],
        ),
        statement(
          this.database,
          "INSERT INTO crm_outreach (id,organization_id,contact_id,event_id,recipient_email,template_subject,subject,body,rendered_body,status,queued_count,sent_count,failed_count,terminal,failure_reason,provider_message_id,completed_at,idempotency_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          this.outreachValues(command),
        ),
        ...consequentialStatements(this.database, {
          tenantId: command.organizationId,
          eventId: command.eventId,
          action: "queued",
          resourceType: "crm_outreach",
          resourceId: command.id,
          resourceVersion: 1,
          occurredAt: command.createdAt,
          after: command,
          sync: { entityType: "crm_outreach", payload: command },
        }),
      ]);
    } catch (error) {
      const concurrent = await this.getOutreachByIdempotencyKey(
        command.organizationId,
        command.idempotencyKey,
      );
      if (concurrent !== null) return concurrent;
      throw this.conflict(error, "The outreach could not be saved.");
    }
    return command;
  }
  async updateOutreach(command: CrmOutreachCommand): Promise<CrmOutreachCommand> {
    const current = await this.getOutreachByIdempotencyKey(
      command.organizationId,
      command.idempotencyKey,
    );
    if (current === null || current.id !== command.id || current.contactId !== command.contactId)
      throw new CrmRepositoryConflictError("The outreach delivery identity does not match.");
    try {
      await batch(this.database, [
        updateGuard(
          this.database,
          "crm_outreach",
          "organization_id=? AND id=? AND idempotency_key=? AND contact_id=? AND terminal=0",
          [command.organizationId, command.id, command.idempotencyKey, command.contactId],
        ),
        statement(
          this.database,
          "UPDATE crm_outreach SET status=?,queued_count=?,sent_count=?,failed_count=?,terminal=?,failure_reason=?,provider_message_id=?,completed_at=? WHERE organization_id=? AND id=? AND idempotency_key=? AND contact_id=? AND terminal=0",
          [
            command.status,
            command.queuedCount,
            command.sentCount,
            command.failedCount,
            command.terminal ? 1 : 0,
            command.failureReason,
            command.providerMessageId ?? null,
            command.completedAt ?? null,
            command.organizationId,
            command.id,
            command.idempotencyKey,
            command.contactId,
          ],
        ),
        ...consequentialStatements(this.database, {
          tenantId: command.organizationId,
          eventId: command.eventId,
          action: "delivery_updated",
          resourceType: "crm_outreach",
          resourceId: command.id,
          resourceVersion: 2,
          occurredAt: command.completedAt ?? command.createdAt,
          before: current,
          after: command,
          sync: { entityType: "crm_outreach", payload: command },
        }),
      ]);
    } catch (error) {
      throw this.conflict(error, "The outreach delivery changed before it could be saved.");
    }
    return command;
  }
  async getOutreachByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<CrmOutreachCommand | null> {
    const row = await statement(
      this.database,
      "SELECT * FROM crm_outreach WHERE organization_id=? AND idempotency_key=?",
      [organizationId, idempotencyKey],
    ).first<Row>();
    return row === null ? null : outreachFromRow(row);
  }
  async listOutreach(organizationId: string): Promise<readonly CrmOutreachCommand[]> {
    const result = await statement(
      this.database,
      "SELECT * FROM crm_outreach WHERE organization_id=? ORDER BY created_at DESC,id",
      [organizationId],
    ).all<Row>();
    return rows(result).map(outreachFromRow);
  }

  async saveImport(result: CrmImportResult): Promise<CrmImportResult> {
    if (result.idempotencyKey !== undefined) {
      const prior = await this.getImportByIdempotencyKey(
        result.organizationId,
        result.idempotencyKey,
      );
      if (prior !== null) return prior;
    }
    const values = [
      result.id,
      result.organizationId,
      result.created,
      result.updated,
      result.skipped,
      result.errors,
      json(result.mapping),
      json(result.rows),
      json(result.contacts.map((contact) => contact.id)),
      result.idempotent ? 1 : 0,
      result.idempotencyKey ?? null,
      result.planFingerprint ?? null,
      result.preview === true ? 1 : 0,
      result.createdAt,
    ];
    try {
      await batch(this.database, [
        insertGuard(this.database, "crm_imports", "id=?", [result.id]),
        statement(
          this.database,
          "INSERT INTO crm_imports (id,organization_id,created_count,updated_count,skipped_count,error_count,mapping_json,rows_json,contact_ids_json,idempotent,idempotency_key,plan_fingerprint,preview,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          values,
        ),
        ...consequentialStatements(this.database, {
          tenantId: result.organizationId,
          action: result.preview === true ? "previewed" : "imported",
          resourceType: "crm_import",
          resourceId: result.id,
          resourceVersion: 1,
          occurredAt: result.createdAt,
          after: result,
        }),
      ]);
    } catch (error) {
      if (result.idempotencyKey !== undefined) {
        const concurrent = await this.getImportByIdempotencyKey(
          result.organizationId,
          result.idempotencyKey,
        );
        if (concurrent !== null) return concurrent;
      }
      throw this.conflict(error, "The import could not be saved.");
    }
    return result;
  }
  async getImportByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<CrmImportResult | null> {
    const row = await statement(
      this.database,
      "SELECT * FROM crm_imports WHERE organization_id=? AND idempotency_key=? AND preview=0",
      [organizationId, idempotencyKey],
    ).first<Row>();
    if (row === null) return null;
    const ids = parseJson<readonly string[]>(String(row.contact_ids_json), []);
    const contacts: CrmContact[] = [];
    for (const id of ids) {
      const contact = await this.getContact(organizationId, id);
      if (contact !== null) contacts.push(contact);
    }
    return {
      id: stringValue(row.id),
      organizationId,
      created: numberValue(row.created_count),
      updated: numberValue(row.updated_count),
      skipped: numberValue(row.skipped_count),
      errors: numberValue(row.error_count),
      contacts,
      mapping: parseJson(String(row.mapping_json), []),
      rows: parseJson(String(row.rows_json), []),
      idempotent: booleanValue(numberValue(row.idempotent)),
      createdAt: stringValue(row.created_at),
      idempotencyKey: stringValue(row.idempotency_key),
      ...(row.plan_fingerprint == null
        ? {}
        : { planFingerprint: stringValue(row.plan_fingerprint) }),
      preview: booleanValue(numberValue(row.preview)),
    };
  }
  async getCommandResult<T>(
    organizationId: string,
    command: string,
    key: string,
  ): Promise<T | null> {
    const row = await statement(
      this.database,
      "SELECT result_json FROM crm_command_results WHERE organization_id=? AND command=? AND idempotency_key=? AND (expires_at IS NULL OR expires_at>?)",
      [organizationId, command, key, new Date().toISOString()],
    ).first<Row>();
    return row === null ? null : parseJson<T>(String(row.result_json), null as T);
  }
  async saveCommandResult<T>(
    organizationId: string,
    command: string,
    key: string,
    value: T,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    try {
      await batch(this.database, [
        statement(
          this.database,
          "INSERT INTO crm_command_results (organization_id,command,idempotency_key,result_json,created_at,expires_at) VALUES (?,?,?,?,?,NULL) ON CONFLICT (organization_id,command,idempotency_key) DO NOTHING",
          [organizationId, command, key, json(value), occurredAt],
        ),
        ...consequentialStatements(this.database, {
          tenantId: organizationId,
          action: "recorded",
          resourceType: "crm_command_result",
          resourceId: `${command}:${key}`,
          resourceVersion: 1,
          occurredAt,
          after: value,
        }),
      ]);
    } catch (error) {
      throw this.conflict(error, "The command result could not be saved.");
    }
  }

  private contactValues(contact: CrmContact): readonly (string | number | null)[] {
    return [
      contact.id,
      contact.organizationId,
      contact.firstName,
      contact.lastName,
      contact.displayName,
      contact.email,
      contact.phone,
      contact.company,
      contact.title,
      contact.website,
      contact.linkedinUrl,
      contact.notes,
      json(contact.customFields),
      contact.source,
      contact.status,
      contact.mergedIntoId,
      contact.mergeAuditId ?? null,
      contact.mergedAt ?? null,
      json(contact.mergeSourceIds ?? []),
      contact.pipelineStage,
      contact.version,
      contact.createdAt,
      contact.updatedAt,
    ];
  }
  private outreachValues(command: CrmOutreachCommand): readonly (string | number | null)[] {
    return [
      command.id,
      command.organizationId,
      command.contactId,
      command.eventId,
      command.recipientEmail,
      command.templateSubject,
      command.subject,
      command.body,
      command.renderedBody,
      command.status,
      command.queuedCount,
      command.sentCount,
      command.failedCount,
      command.terminal ? 1 : 0,
      command.failureReason,
      command.providerMessageId ?? null,
      command.completedAt ?? null,
      command.idempotencyKey,
      command.createdBy,
      command.createdAt,
    ];
  }
  private conflict(error: unknown, message: string): CrmRepositoryConflictError {
    return error instanceof CrmRepositoryConflictError
      ? error
      : new CrmRepositoryConflictError(
          error instanceof Error && error.message.length > 0
            ? `${message} ${error.message}`
            : message,
        );
  }
}

export { D1CrmRepository as CloudflareCrmRepository };
