import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { authUsers, organizations } from "./identity-access";
import { events } from "./program-core";
import { sessions } from "./sessions-agenda";

const b = (n: string) => integer(n, { mode: "boolean" }).notNull();
const j = (n: string) => text(n, { mode: "json" }).notNull();
const json = (n: string, c: unknown, k: "array" | "object") =>
  check(n, sql`json_valid(${c}) and json_type(${c})=${k}`);
const eventFk = (
  o: AnySQLiteColumn,
  e: AnySQLiteColumn,
  del: "cascade" | "restrict" = "restrict",
) =>
  foreignKey({ columns: [o, e], foreignColumns: [events.organizationId, events.id] }).onDelete(del);
export const cfpForms = sqliteTable(
  "cfp_forms",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    name: text().notNull(),
    status: text().notNull(),
    welcomeContent: text("welcome_content").notNull(),
    speakerLimit: integer("speaker_limit").notNull(),
    maxSubmissionsPerAccount: integer("max_submissions_per_account").notNull(),
    remindersEnabled: b("reminders_enabled"),
    adminNotificationsEnabled: b("admin_notifications_enabled"),
    confirmationMessage: text("confirmation_message").notNull(),
    successContent: text("success_content").notNull(),
    redirectUrl: text("redirect_url"),
    version: integer().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId, "cascade"),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.eventId, t.id),
    index("cfp_forms_event_status_name_idx").on(t.organizationId, t.eventId, t.status, t.name),
    check("cfp_forms_status_check", sql`${t.status} in('draft','published','closed')`),
    check(
      "cfp_forms_limits_check",
      sql`${t.speakerLimit}>0 and ${t.maxSubmissionsPerAccount}>0 and ${t.version}>0`,
    ),
    check(
      "cfp_forms_booleans_check",
      sql`${t.remindersEnabled} in(0,1) and ${t.adminNotificationsEnabled} in(0,1)`,
    ),
  ],
);
export const cfpFormSections = sqliteTable(
  "cfp_form_sections",
  {
    organizationId: text("organization_id").notNull(),
    formId: text("form_id").notNull(),
    id: text().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.formId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.formId],
      foreignColumns: [cfpForms.organizationId, cfpForms.id],
    }).onDelete("cascade"),
    unique().on(t.organizationId, t.formId, t.sortOrder),
    index("cfp_form_sections_order_idx").on(t.organizationId, t.formId, t.sortOrder),
    check("cfp_form_sections_order_check", sql`${t.sortOrder}>=0`),
  ],
);
export const reusableFields = sqliteTable(
  "reusable_fields",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.organizationId, { onDelete: "cascade" }),
    id: text().notNull(),
    version: integer().notNull(),
    definitionJson: j("definition_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id, t.version] }),
    index("reusable_fields_versions_idx").on(t.organizationId, t.id, t.version),
    check("reusable_fields_version_check", sql`${t.version}>0`),
    json("reusable_fields_json_check", t.definitionJson, "object"),
  ],
);
export const cfpFormFields = sqliteTable(
  "cfp_form_fields",
  {
    organizationId: text("organization_id").notNull(),
    formId: text("form_id").notNull(),
    id: text().notNull(),
    sectionId: text("section_id").notNull(),
    scope: text().notNull(),
    fieldKey: text("field_key").notNull(),
    label: text().notNull(),
    description: text(),
    placeholder: text(),
    kind: text().notNull(),
    required: b("required"),
    optionsJson: j("options_json"),
    fileOwner: text("file_owner"),
    allowedMimeTypesJson: text("allowed_mime_types_json", { mode: "json" }),
    maxBytes: integer("max_bytes"),
    reusableFieldId: text("reusable_field_id"),
    reusableFieldVersion: integer("reusable_field_version"),
    sortOrder: integer("sort_order").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.formId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.formId],
      foreignColumns: [cfpForms.organizationId, cfpForms.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.formId, t.sectionId],
      foreignColumns: [cfpFormSections.organizationId, cfpFormSections.formId, cfpFormSections.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.reusableFieldId, t.reusableFieldVersion],
      foreignColumns: [reusableFields.organizationId, reusableFields.id, reusableFields.version],
    }).onDelete("restrict"),
    unique().on(t.organizationId, t.formId, t.fieldKey),
    unique().on(t.organizationId, t.formId, t.scope, t.sortOrder),
    index("cfp_form_fields_order_idx").on(t.organizationId, t.formId, t.scope, t.sortOrder),
    index("cfp_form_fields_reusable_idx").on(
      t.organizationId,
      t.reusableFieldId,
      t.reusableFieldVersion,
    ),
    check("cfp_form_fields_scope_check", sql`${t.scope} in('submission','participant')`),
    check(
      "cfp_form_fields_kind_check",
      sql`${t.kind} in('file_request','text','rich_text','email','url','select','multi_select','boolean','number')`,
    ),
    check(
      "cfp_form_fields_file_check",
      sql`(${t.kind}='file_request' and ${t.fileOwner} in('submission','participant') and ${t.allowedMimeTypesJson} is not null and ${t.maxBytes}>0) or (${t.kind}<>'file_request' and ${t.fileOwner} is null and ${t.allowedMimeTypesJson} is null and ${t.maxBytes} is null)`,
    ),
    check(
      "cfp_form_fields_reusable_check",
      sql`(${t.reusableFieldId} is null)=(${t.reusableFieldVersion} is null)`,
    ),
    json("cfp_form_fields_options_check", t.optionsJson, "array"),
  ],
);
export const cfpFormRules = sqliteTable(
  "cfp_form_rules",
  {
    organizationId: text("organization_id").notNull(),
    formId: text("form_id").notNull(),
    id: text().notNull(),
    priority: integer().notNull(),
    conditionJson: j("condition_json"),
    actionsJson: j("actions_json"),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.formId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.formId],
      foreignColumns: [cfpForms.organizationId, cfpForms.id],
    }).onDelete("cascade"),
    unique().on(t.organizationId, t.formId, t.priority),
    index("cfp_form_rules_priority_idx").on(t.organizationId, t.formId, t.priority),
    check("cfp_form_rules_priority_check", sql`${t.priority}>=0`),
    json("cfp_form_rules_condition_check", t.conditionJson, "object"),
    json("cfp_form_rules_actions_check", t.actionsJson, "array"),
  ],
);
export const submissions = sqliteTable(
  "submissions",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    formId: text("form_id").notNull(),
    ownerAccountId: text("owner_account_id").notNull(),
    formVersion: integer("form_version").notNull(),
    status: text().notNull(),
    completedStepsJson: j("completed_steps_json"),
    version: integer().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    submittedAt: text("submitted_at"),
    reopenedAt: text("reopened_at"),
    withdrawnAt: text("withdrawn_at"),
    finalDecisionAt: text("final_decision_at"),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.formId],
      foreignColumns: [cfpForms.organizationId, cfpForms.eventId, cfpForms.id],
    }).onDelete("restrict"),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.eventId, t.id),
    index("submissions_event_updated_idx").on(t.organizationId, t.eventId, t.updatedAt),
    index("submissions_owner_form_idx").on(t.organizationId, t.eventId, t.formId, t.ownerAccountId),
    index("submissions_status_idx").on(t.organizationId, t.eventId, t.status, t.updatedAt),
    check(
      "submissions_status_check",
      sql`${t.status} in('draft','submitted','reopened','withdrawn')`,
    ),
    check("submissions_versions_check", sql`${t.formVersion}>0 and ${t.version}>0`),
    json("submissions_steps_check", t.completedStepsJson, "array"),
  ],
);
export const participants = sqliteTable(
  "participants",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    displayName: text("display_name").notNull(),
    email: text().notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    identityState: text("identity_state").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    claimedUserId: text("claimed_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    version: integer().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId, "cascade"),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.eventId, t.id),
    uniqueIndex("participants_resolved_email_uidx")
      .on(t.organizationId, t.eventId, t.normalizedEmail)
      .where(sql`${t.normalizedEmail}<>'' and ${t.identityState}='resolved'`),
    index("participants_email_idx").on(t.organizationId, t.eventId, t.normalizedEmail),
    index("participants_source_idx").on(t.organizationId, t.eventId, t.sourceType, t.sourceId),
    check("participants_identity_check", sql`${t.identityState} in('resolved','ambiguous')`),
    check("participants_source_check", sql`${t.sourceType} in('cfp','manual','csv','crm')`),
    check("participants_version_check", sql`${t.version}>0`),
  ],
);
export const submissionParticipants = sqliteTable(
  "submission_participants",
  {
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    submissionId: text("submission_id").notNull(),
    participantId: text("participant_id").notNull(),
    role: text().notNull(),
    biography: text().notNull(),
    answersJson: j("answers_json"),
    ordinal: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.submissionId, t.participantId] }),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.submissionId],
      foreignColumns: [submissions.organizationId, submissions.eventId, submissions.id],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.participantId],
      foreignColumns: [participants.organizationId, participants.eventId, participants.id],
    }).onDelete("restrict"),
    unique().on(t.organizationId, t.submissionId, t.ordinal),
    uniqueIndex("submission_participants_primary_uidx")
      .on(t.organizationId, t.submissionId)
      .where(sql`${t.role}='primary'`),
    index("submission_participants_participant_idx").on(
      t.organizationId,
      t.eventId,
      t.participantId,
      t.submissionId,
    ),
    check("submission_participants_role_check", sql`${t.role} in('primary','co_speaker')`),
    check("submission_participants_order_check", sql`${t.ordinal}>=0`),
    json("submission_participants_answers_check", t.answersJson, "object"),
  ],
);
export const submissionSecondaryContacts = sqliteTable(
  "submission_secondary_contacts",
  {
    organizationId: text("organization_id").notNull(),
    submissionId: text("submission_id").notNull(),
    id: text().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    ordinal: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.submissionId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.submissionId],
      foreignColumns: [submissions.organizationId, submissions.id],
    }).onDelete("cascade"),
    unique().on(t.organizationId, t.submissionId, t.ordinal),
    index("submission_secondary_contacts_order_idx").on(
      t.organizationId,
      t.submissionId,
      t.ordinal,
    ),
    check("submission_secondary_contacts_order_check", sql`${t.ordinal}>=0`),
  ],
);
export const submissionVersions = sqliteTable(
  "submission_versions",
  {
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    submissionId: text("submission_id").notNull(),
    version: integer().notNull(),
    reason: text().notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    snapshotJson: j("snapshot_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.submissionId, t.version] }),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.submissionId],
      foreignColumns: [submissions.organizationId, submissions.eventId, submissions.id],
    }).onDelete("restrict"),
    uniqueIndex("submission_versions_idempotency_uidx")
      .on(t.organizationId, t.submissionId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("submission_versions_event_time_idx").on(t.organizationId, t.eventId, t.createdAt),
    check(
      "submission_versions_reason_check",
      sql`${t.reason} in('draft_created','draft_saved','submitted','reopened','withdrawn')`,
    ),
    check("submission_versions_version_check", sql`${t.version}>0`),
    json("submission_versions_snapshot_check", t.snapshotJson, "object"),
  ],
);

export const speakerTasks = sqliteTable(
  "speaker_tasks",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    sessionId: text("session_id"),
    participantId: text("participant_id").notNull(),
    type: text().notNull(),
    owner: text().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    instructions: text().notNull().default(""),
    status: text().notNull(),
    dueAt: text("due_at"),
    allowedMimeTypesJson: j("allowed_mime_types_json"),
    maxBytes: integer("max_bytes"),
    acceptedAssetKindsJson: j("accepted_asset_kinds_json"),
    replacementBaselineAssetId: text("replacement_baseline_asset_id"),
    version: integer().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.participantId],
      foreignColumns: [participants.organizationId, participants.eventId, participants.id],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.sessionId],
      foreignColumns: [sessions.organizationId, sessions.eventId, sessions.id],
    }).onDelete("restrict"),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.eventId, t.id),
    index("speaker_tasks_participant_status_idx").on(
      t.organizationId,
      t.eventId,
      t.participantId,
      t.status,
      t.dueAt,
    ),
    index("speaker_tasks_session_idx").on(t.organizationId, t.eventId, t.sessionId),
    index("speaker_tasks_replacement_baseline_idx").on(
      t.organizationId,
      t.eventId,
      t.replacementBaselineAssetId,
    ),
    check("speaker_tasks_type_check", sql`${t.type} in('form','upload','action')`),
    check("speaker_tasks_owner_check", sql`${t.owner} in('speaker','organizer')`),
    check(
      "speaker_tasks_status_check",
      sql`${t.status} in('not_started','in_progress','submitted','needs_changes','completed','waived','overdue','reopened')`,
    ),
    check(
      "speaker_tasks_numbers_check",
      sql`${t.version}>0 and (${t.maxBytes} is null or ${t.maxBytes}>0)`,
    ),
    json("speaker_tasks_mime_check", t.allowedMimeTypesJson, "array"),
    json("speaker_tasks_kinds_check", t.acceptedAssetKindsJson, "array"),
  ],
);
export const speakerTaskDependencies = sqliteTable(
  "speaker_task_dependencies",
  {
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    taskId: text("task_id").notNull(),
    dependencyTaskId: text("dependency_task_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.eventId, t.taskId, t.dependencyTaskId] }),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.taskId],
      foreignColumns: [speakerTasks.organizationId, speakerTasks.eventId, speakerTasks.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.dependencyTaskId],
      foreignColumns: [speakerTasks.organizationId, speakerTasks.eventId, speakerTasks.id],
    }).onDelete("cascade"),
    index("speaker_task_dependencies_reverse_idx").on(
      t.organizationId,
      t.eventId,
      t.dependencyTaskId,
    ),
    check("speaker_task_dependencies_self_check", sql`${t.taskId}<>${t.dependencyTaskId}`),
  ],
);
export const speakerTaskReminderOffsets = sqliteTable(
  "speaker_task_reminder_offsets",
  {
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    taskId: text("task_id").notNull(),
    offsetMinutes: integer("offset_minutes").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.eventId, t.taskId, t.offsetMinutes] }),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.taskId],
      foreignColumns: [speakerTasks.organizationId, speakerTasks.eventId, speakerTasks.id],
    }).onDelete("cascade"),
    check("speaker_task_offsets_check", sql`${t.offsetMinutes}>=0`),
  ],
);
export const speakerTaskTransitions = sqliteTable(
  "speaker_task_transitions",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    taskId: text("task_id").notNull(),
    participantId: text("participant_id").notNull(),
    actorAccountId: text("actor_account_id").notNull(),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    note: text(),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.eventId, t.taskId],
      foreignColumns: [speakerTasks.organizationId, speakerTasks.eventId, speakerTasks.id],
    }).onDelete("restrict"),
    index("speaker_task_transitions_time_idx").on(
      t.organizationId,
      t.eventId,
      t.taskId,
      t.occurredAt,
    ),
    check(
      "speaker_task_transitions_from_check",
      sql`${t.fromStatus} in('not_started','in_progress','submitted','needs_changes','completed','waived','overdue','reopened')`,
    ),
    check(
      "speaker_task_transitions_to_check",
      sql`${t.toStatus} in('not_started','in_progress','submitted','needs_changes','completed','waived','overdue','reopened')`,
    ),
  ],
);

export const speakerAssets = sqliteTable(
  "speaker_assets",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    sessionId: text("session_id"),
    participantId: text("participant_id").notNull(),
    taskId: text("task_id"),
    kind: text().notNull(),
    objectKey: text("object_key").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploaderAccountId: text("uploader_account_id"),
    uploaderLabel: text("uploader_label"),
    creationIdempotencyKey: text("creation_idempotency_key"),
    creationRequestDigest: text("creation_request_digest"),
    state: text().notNull(),
    version: integer().notNull(),
    versionFamilyId: text("version_family_id").notNull(),
    supersedesAssetId: text("supersedes_asset_id"),
    commentThreadId: text("comment_thread_id").notNull(),
    reviewState: text("review_state"),
    reviewNote: text("review_note"),
    reviewedAt: text("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    reviewVersion: integer("review_version").notNull().default(0),
    latestVersionId: text("latest_version_id"),
    currentVersionId: text("current_version_id"),
    approvedVersionId: text("approved_version_id"),
    releasedVersionId: text("released_version_id"),
    rejectionReason: text("rejection_reason"),
    createdAt: text("created_at").notNull(),
    finalizedAt: text("finalized_at"),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.participantId],
      foreignColumns: [participants.organizationId, participants.eventId, participants.id],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.sessionId],
      foreignColumns: [sessions.organizationId, sessions.eventId, sessions.id],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.taskId],
      foreignColumns: [speakerTasks.organizationId, speakerTasks.eventId, speakerTasks.id],
    }).onDelete("restrict"),
    foreignKey({ columns: [t.uploaderAccountId], foreignColumns: [authUsers.id] }).onDelete(
      "set null",
    ),
    foreignKey({ columns: [t.supersedesAssetId], foreignColumns: [t.id] }).onDelete("restrict"),
    unique().on(t.objectKey),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.eventId, t.id),
    unique().on(t.organizationId, t.eventId, t.versionFamilyId, t.version),
    uniqueIndex("speaker_assets_creation_idempotency_uidx")
      .on(t.organizationId, t.eventId, t.creationIdempotencyKey)
      .where(sql`${t.creationIdempotencyKey} IS NOT NULL`),
    index("speaker_assets_participant_idx").on(
      t.organizationId,
      t.eventId,
      t.participantId,
      t.createdAt,
    ),
    index("speaker_assets_task_idx").on(t.organizationId, t.eventId, t.taskId, t.createdAt),
    index("speaker_assets_family_idx").on(
      t.organizationId,
      t.eventId,
      t.versionFamilyId,
      t.version,
    ),
    index("speaker_assets_state_idx").on(t.organizationId, t.eventId, t.state, t.createdAt),
    index("speaker_assets_released_idx").on(t.releasedVersionId),
    check("speaker_assets_kind_check", sql`${t.kind} in('headshot','slides','supporting_file')`),
    check("speaker_assets_state_check", sql`${t.state} in('pending_upload','ready','rejected')`),
    check(
      "speaker_assets_review_check",
      sql`${t.reviewState} is null or ${t.reviewState} in('approved','needs_changes')`,
    ),
    check(
      "speaker_assets_numbers_check",
      sql`${t.sizeBytes}>=0 and ${t.version}>0 and ${t.reviewVersion}>=0`,
    ),
  ],
);

export const cfpFileAssets = sqliteTable(
  "cfp_file_assets",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    submissionId: text("submission_id").notNull(),
    owner: text().notNull(),
    participantId: text("participant_id"),
    fieldKey: text("field_key").notNull(),
    objectKey: text("object_key").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    state: text().notNull(),
    rejectionReason: text("rejection_reason"),
    createdAt: text("created_at").notNull(),
    finalizedAt: text("finalized_at"),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.submissionId],
      foreignColumns: [submissions.organizationId, submissions.eventId, submissions.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.participantId],
      foreignColumns: [participants.organizationId, participants.eventId, participants.id],
    }).onDelete("cascade"),
    unique().on(t.objectKey),
    unique().on(t.organizationId, t.eventId, t.id),
    index("cfp_file_assets_submission_idx").on(
      t.organizationId,
      t.eventId,
      t.submissionId,
      t.createdAt,
    ),
    index("cfp_file_assets_participant_idx").on(
      t.organizationId,
      t.eventId,
      t.participantId,
      t.createdAt,
    ),
    check("cfp_file_assets_owner_check", sql`${t.owner} in('submission','participant')`),
    check(
      "cfp_file_assets_owner_participant_check",
      sql`(${t.owner}='submission' and ${t.participantId} is null) or (${t.owner}='participant' and ${t.participantId} is not null)`,
    ),
    check("cfp_file_assets_state_check", sql`${t.state} in('pending_upload','ready','rejected')`),
    check("cfp_file_assets_size_check", sql`${t.sizeBytes}>0`),
  ],
);

export const submissionAnswers = sqliteTable(
  "submission_answers",
  {
    organizationId: text("organization_id").notNull(),
    submissionId: text("submission_id").notNull(),
    fieldKey: text("field_key").notNull(),
    valueJson: j("value_json"),
    assetId: text("asset_id"),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.submissionId, t.fieldKey] }),
    foreignKey({
      columns: [t.organizationId, t.submissionId],
      foreignColumns: [submissions.organizationId, submissions.id],
    }).onDelete("cascade"),
    foreignKey({ columns: [t.assetId], foreignColumns: [speakerAssets.id] }).onDelete("restrict"),
    index("submission_answers_submission_idx").on(t.organizationId, t.submissionId),
    index("submission_answers_asset_idx").on(t.assetId),
    check("submission_answers_json_check", sql`json_valid(${t.valueJson})`),
  ],
);

export const speakerProfiles = sqliteTable(
  "speaker_profiles",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    participantId: text("participant_id").notNull(),
    displayName: text("display_name").notNull(),
    email: text(),
    jobTitle: text("job_title").notNull().default(""),
    company: text().notNull().default(""),
    status: text().notNull().default(""),
    biography: text().notNull(),
    socialLinksJson: j("social_links_json"),
    travelRequired: b("travel_required"),
    arrivalAt: text("arrival_at"),
    departureAt: text("departure_at"),
    accommodation: text().notNull().default(""),
    dietaryRequirements: text("dietary_requirements").notNull().default(""),
    accessibilityNeeds: text("accessibility_needs").notNull().default(""),
    travelNotes: text("travel_notes").notNull().default(""),
    headshotAssetId: text("headshot_asset_id"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    version: integer().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    admittedByAccountId: text("admitted_by_account_id"),
    admittedAt: text("admitted_at"),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.eventId, t.participantId],
      foreignColumns: [participants.organizationId, participants.eventId, participants.id],
    }).onDelete("restrict"),
    foreignKey({ columns: [t.headshotAssetId], foreignColumns: [speakerAssets.id] }).onDelete(
      "set null",
    ),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.eventId, t.id),
    unique().on(t.organizationId, t.eventId, t.participantId),
    index("speaker_profiles_participant_idx").on(t.organizationId, t.eventId, t.participantId),
    index("speaker_profiles_status_idx").on(t.organizationId, t.eventId, t.status),
    index("speaker_profiles_source_idx").on(t.organizationId, t.eventId, t.sourceType, t.sourceId),
    check(
      "speaker_profiles_source_check",
      sql`${t.sourceType} is null or ${t.sourceType} in('cfp','manual','csv','crm')`,
    ),
    check("speaker_profiles_version_check", sql`${t.version}>0`),
    json("speaker_profiles_social_check", t.socialLinksJson, "object"),
  ],
);

export const speakerImportPreviews = sqliteTable(
  "speaker_import_previews",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    accountId: text("account_id").notNull(),
    sourceDigest: text("source_digest").notNull(),
    rowsJson: j("rows_json"),
    rosterRevision: integer("roster_revision").notNull(),
    createdAt: text("created_at").notNull(),
    committedAt: text("committed_at"),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId, "cascade"),
    unique().on(t.organizationId, t.eventId, t.id),
    index("speaker_import_previews_scope_idx").on(t.organizationId, t.eventId, t.createdAt),
    check("speaker_import_previews_revision_check", sql`${t.rosterRevision}>=0`),
    json("speaker_import_previews_rows_check", t.rowsJson, "array"),
  ],
);

export const speakerAggregateOperations = sqliteTable(
  "speaker_aggregate_operations",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    operationType: text("operation_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expectedVersion: integer("expected_version"),
    sourceDigest: text("source_digest").notNull(),
    previewId: text("preview_id"),
    participantIdsJson: j("participant_ids_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId, "cascade"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.previewId],
      foreignColumns: [
        speakerImportPreviews.organizationId,
        speakerImportPreviews.eventId,
        speakerImportPreviews.id,
      ],
    }).onDelete("restrict"),
    unique().on(t.organizationId, t.eventId, t.operationType, t.idempotencyKey),
    index("speaker_aggregate_operations_scope_idx").on(t.organizationId, t.eventId, t.createdAt),
    check(
      "speaker_aggregate_operations_type_check",
      sql`${t.operationType} in('create','import','update','revoke')`,
    ),
    check(
      "speaker_aggregate_operations_expected_version_check",
      sql`${t.expectedVersion} is null or ${t.expectedVersion}>0`,
    ),
    json("speaker_aggregate_operations_participants_check", t.participantIdsJson, "array"),
  ],
);

/** @deprecated Retained only for expand/backfill compatibility; not canonical authority. */
export const speakerRoster = sqliteTable(
  "speaker_roster",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    submissionId: text("submission_id").notNull(),
    participantId: text("participant_id").notNull(),
    role: text().notNull(),
    status: text().notNull(),
    workflowStatus: text("workflow_status"),
    organizerStatus: text("organizer_status"),
    displayName: text("display_name").notNull(),
    email: text(),
    jobTitle: text("job_title").notNull(),
    company: text().notNull(),
    biography: text().notNull(),
    socialLinksJson: j("social_links_json"),
    travelLogisticsJson: j("travel_logistics_json"),
    headshotAssetId: text("headshot_asset_id"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    version: integer().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    authorAccountId: text("author_account_id"),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.eventId, t.submissionId],
      foreignColumns: [submissions.organizationId, submissions.eventId, submissions.id],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.participantId],
      foreignColumns: [participants.organizationId, participants.eventId, participants.id],
    }).onDelete("restrict"),
    foreignKey({ columns: [t.headshotAssetId], foreignColumns: [speakerAssets.id] }).onDelete(
      "set null",
    ),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.eventId, t.id),
    unique().on(t.organizationId, t.eventId, t.submissionId, t.participantId),
    index("speaker_roster_submission_idx").on(
      t.organizationId,
      t.eventId,
      t.submissionId,
      t.status,
    ),
    index("speaker_roster_participant_idx").on(
      t.organizationId,
      t.eventId,
      t.participantId,
      t.status,
    ),
    index("speaker_roster_status_idx").on(t.organizationId, t.eventId, t.status, t.updatedAt),
    check("speaker_roster_role_check", sql`${t.role} in('primary','co_speaker')`),
    check("speaker_roster_status_check", sql`${t.status} in('pending','active','revoked')`),
    check(
      "speaker_roster_source_check",
      sql`${t.sourceType} is null or ${t.sourceType} in('cfp','manual','csv','crm')`,
    ),
    check("speaker_roster_version_check", sql`${t.version}>0`),
    json("speaker_roster_social_check", t.socialLinksJson, "object"),
    json("speaker_roster_travel_check", t.travelLogisticsJson, "object"),
  ],
);
export const speakerTaskForms = sqliteTable(
  "speaker_task_forms",
  {
    id: text().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    taskId: text("task_id").notNull(),
    title: text().notNull(),
    description: text().notNull(),
    fieldsJson: j("fields_json"),
    version: integer().notNull(),
    published: b("published"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.taskId],
      foreignColumns: [speakerTasks.organizationId, speakerTasks.eventId, speakerTasks.id],
    }).onDelete("restrict"),
    unique().on(t.organizationId, t.eventId, t.taskId, t.version),
    uniqueIndex("speaker_task_forms_published_uidx")
      .on(t.organizationId, t.eventId, t.taskId)
      .where(sql`${t.published}=1`),
    index("speaker_task_forms_versions_idx").on(t.organizationId, t.eventId, t.taskId, t.version),
    check("speaker_task_forms_version_check", sql`${t.version}>0`),
    json("speaker_task_forms_fields_check", t.fieldsJson, "array"),
  ],
);
export const speakerTaskResponses = sqliteTable(
  "speaker_task_responses",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    taskId: text("task_id").notNull(),
    participantId: text("participant_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    answersJson: j("answers_json"),
    status: text().notNull(),
    version: integer().notNull(),
    feedback: text(),
    submittedAt: text("submitted_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.eventId, t.taskId],
      foreignColumns: [speakerTasks.organizationId, speakerTasks.eventId, speakerTasks.id],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.participantId],
      foreignColumns: [participants.organizationId, participants.eventId, participants.id],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.taskId, t.definitionVersion],
      foreignColumns: [speakerTaskForms.id, speakerTaskForms.version],
    }).onDelete("restrict"),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.eventId, t.taskId, t.participantId, t.version),
    index("speaker_task_responses_latest_idx").on(
      t.organizationId,
      t.eventId,
      t.taskId,
      t.participantId,
      t.version,
    ),
    check(
      "speaker_task_responses_status_check",
      sql`${t.status} in('draft','submitted','needs_changes','reopened')`,
    ),
    check(
      "speaker_task_responses_versions_check",
      sql`${t.definitionVersion}>0 and ${t.version}>0`,
    ),
    json("speaker_task_responses_answers_check", t.answersJson, "object"),
  ],
);
export const speakerAssetComments = sqliteTable(
  "speaker_asset_comments",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    assetId: text("asset_id").notNull(),
    versionId: text("version_id").notNull(),
    body: text().notNull(),
    authorLabel: text("author_label").notNull(),
    authorAccountId: text("author_account_id"),
    version: integer().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.assetId], foreignColumns: [speakerAssets.id] }).onDelete("restrict"),
    index("speaker_asset_comments_version_idx").on(
      t.organizationId,
      t.eventId,
      t.assetId,
      t.versionId,
      t.createdAt,
    ),
    check("speaker_asset_comments_version_check", sql`${t.version}>0`),
  ],
);
export const portalContexts = sqliteTable(
  "portal_contexts",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    accountId: text("account_id").notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    status: text().notNull(),
    primaryParticipantId: text("primary_participant_id").notNull(),
    capabilitiesJson: j("capabilities_json"),
    version: integer().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId, "cascade"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.primaryParticipantId],
      foreignColumns: [participants.organizationId, participants.eventId, participants.id],
    }).onDelete("restrict"),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.eventId, t.id),
    unique().on(t.organizationId, t.eventId, t.accountId, t.id),
    uniqueIndex("portal_contexts_slug_unique").on(t.organizationId, t.eventId, t.slug),
    index("portal_contexts_account_idx").on(t.organizationId, t.eventId, t.accountId),
    index("portal_contexts_event_idx").on(t.organizationId, t.eventId, t.status),
    check("portal_contexts_version_check", sql`${t.version}>0`),
    json("portal_contexts_capabilities_check", t.capabilitiesJson, "array"),
  ],
);
export const portalContextSubmissions = sqliteTable(
  "portal_context_submissions",
  {
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    contextId: text("context_id").notNull(),
    submissionId: text("submission_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.eventId, t.contextId, t.submissionId] }),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.contextId],
      foreignColumns: [portalContexts.organizationId, portalContexts.eventId, portalContexts.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.submissionId],
      foreignColumns: [submissions.organizationId, submissions.eventId, submissions.id],
    }).onDelete("restrict"),
    index("portal_context_submissions_submission_idx").on(
      t.organizationId,
      t.eventId,
      t.submissionId,
    ),
  ],
);
export const portalContextParticipants = sqliteTable(
  "portal_context_participants",
  {
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    contextId: text("context_id").notNull(),
    participantId: text("participant_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.eventId, t.contextId, t.participantId] }),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.contextId],
      foreignColumns: [portalContexts.organizationId, portalContexts.eventId, portalContexts.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.eventId, t.participantId],
      foreignColumns: [participants.organizationId, participants.eventId, participants.id],
    }).onDelete("restrict"),
    index("portal_context_participants_participant_idx").on(
      t.organizationId,
      t.eventId,
      t.participantId,
    ),
  ],
);
const resource = (name: string, wiki = false) =>
  sqliteTable(
    name,
    {
      id: text().primaryKey().notNull(),
      organizationId: text("organization_id").notNull(),
      eventId: text("event_id").notNull(),
      title: text().notNull(),
      ...(wiki ? { slug: text().notNull() } : {}),
      summary: text(),
      html: text(),
      url: text(),
      sortOrder: integer("sort_order").notNull(),
      status: text().notNull(),
      version: integer().notNull(),
      updatedAt: text("updated_at").notNull(),
    },
    (t) => [
      eventFk(t.organizationId, t.eventId, "cascade"),
      unique().on(t.organizationId, t.id),
      unique().on(t.organizationId, t.eventId, t.id),
      unique().on(t.organizationId, t.eventId, t.sortOrder),
      ...(wiki
        ? [
            uniqueIndex(`${name}_slug_unique`).on(
              t.organizationId,
              t.eventId,
              (t as typeof t & { slug: AnySQLiteColumn }).slug,
            ),
          ]
        : []),
      index(`${name}_order_idx`).on(t.organizationId, t.eventId, t.sortOrder),
      check(`${name}_status_check`, sql`${t.status} in('draft','published','archived')`),
      check(`${name}_numbers_check`, sql`${t.sortOrder}>=0 and ${t.version}>0`),
    ],
  );
export const speakerEventResources = resource("speaker_event_resources");
export const speakerWikiPages = resource("speaker_wiki_pages", true);
export const speakerContent = sqliteTable(
  "speaker_content",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    title: text(),
    description: text(),
    abstract: text(),
    biography: text(),
    socialLinksJson: text("social_links_json", { mode: "json" }),
    headshotAssetId: text("headshot_asset_id"),
    status: text(),
    version: integer().notNull(),
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId, "cascade"),
    foreignKey({ columns: [t.headshotAssetId], foreignColumns: [speakerAssets.id] }).onDelete(
      "set null",
    ),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.eventId, t.id),
    unique().on(t.organizationId, t.eventId, t.entityType, t.entityId),
    index("speaker_content_source_idx").on(t.organizationId, t.eventId, t.entityType, t.entityId),
    check("speaker_content_entity_check", sql`${t.entityType} in('session','speaker')`),
    check("speaker_content_version_check", sql`${t.version}>0`),
  ],
);
export const speakerContentHistory = sqliteTable(
  "speaker_content_history",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text().notNull(),
    version: integer().notNull(),
    actorAccountId: text("actor_account_id").notNull(),
    actorLabel: text("actor_label"),
    occurredAt: text("occurred_at").notNull(),
    snapshotJson: j("snapshot_json"),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId),
    unique().on(t.organizationId, t.eventId, t.entityType, t.entityId, t.version),
    index("speaker_content_history_source_idx").on(
      t.organizationId,
      t.eventId,
      t.entityType,
      t.entityId,
      t.version,
    ),
    check("speaker_content_history_entity_check", sql`${t.entityType} in('session','speaker')`),
    check(
      "speaker_content_history_action_check",
      sql`${t.action} in('created','updated','restored','approved','needs_changes')`,
    ),
    check("speaker_content_history_version_check", sql`${t.version}>0`),
    json("speaker_content_history_snapshot_check", t.snapshotJson, "object"),
  ],
);
export const speakerReminderReceipts = sqliteTable(
  "speaker_reminder_receipts",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    eventId: text("event_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    taskIdsJson: j("task_ids_json"),
    recipientIdsJson: j("recipient_ids_json"),
    receiptsJson: j("receipts_json"),
    actorAccountId: text("actor_account_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    eventFk(t.organizationId, t.eventId),
    unique().on(t.organizationId, t.eventId, t.idempotencyKey),
    index("speaker_reminder_receipts_time_idx").on(t.organizationId, t.eventId, t.createdAt),
    json("speaker_reminder_tasks_check", t.taskIdsJson, "array"),
    json("speaker_reminder_recipients_check", t.recipientIdsJson, "array"),
    json("speaker_reminder_receipts_check", t.receiptsJson, "array"),
  ],
);
