"use client";

import Link from "next/link";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button as UiButton } from "@/components/ui/button";
import {
  Card as UiCard,
  CardContent as UiCardContent,
  CardHeader as UiCardHeader,
  CardTitle as UiCardTitle,
} from "@/components/ui/card";
import { FileUpload } from "@/components/ui/file-upload";
import { Input } from "@/components/ui/input";
import styles from "./crm-workspace.module.css";
import {
  type ContactDraft,
  CRM_MERGE_SCALAR_FIELDS,
  CRM_PIPELINE_STAGES,
  type CrmAnalytics,
  type CrmContact,
  type CrmContactStatus,
  type CrmDuplicateReport,
  type CrmEvent,
  type CrmEventProjectionResult,
  type CrmHistoryEntry,
  type CrmImportPreviewResult,
  type CrmImportResult,
  type CrmMergePreview,
  type CrmMergeResult,
  type CrmMergeScalarField,
  type CrmNote,
  type CrmOutreachCommand,
  type CrmOutreachPreview,
  type CrmPipelineEntry,
  type CrmPipelineStage,
  type CrmSegment,
  type CrmSegmentOperator,
  type CrmSegmentRule,
  type CsvPreview,
  contactBio,
  contactDraft,
  contactHeadshotUrl,
  customFieldText,
  displayName,
  focusAndScroll,
  humanErrorSummary,
  mergeFieldValue,
  mergeValuePresent,
  mergeValueText,
} from "./crm-workspace-model";

function subscribeToCrmDate(): () => void {
  return () => undefined;
}

function browserCrmDate(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function crmDateFallback(value: string | undefined): string {
  return value === undefined || value.length === 0 ? "—" : value;
}

function ClientFormattedDate({ value }: Readonly<{ value: string | undefined }>) {
  return useSyncExternalStore(
    subscribeToCrmDate,
    () => browserCrmDate(value),
    () => crmDateFallback(value),
  );
}

function Card({
  title,
  eyebrow,
  children,
  actions,
}: Readonly<{ title: string; eyebrow?: string; children: ReactNode; actions?: ReactNode }>) {
  return (
    <UiCard className={styles.card}>
      <UiCardHeader className={styles.cardHeader}>
        <div>
          {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
          <UiCardTitle>
            <h2>{title}</h2>
          </UiCardTitle>
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </UiCardHeader>
      <UiCardContent className={styles.cardContent}>{children}</UiCardContent>
    </UiCard>
  );
}

function ContactEditor({
  contact,
  busy,
  onSave,
  onCancel,
}: Readonly<{
  contact?: CrmContact;
  busy: boolean;
  onSave: (draft: ContactDraft) => Promise<void>;
  onCancel?: () => void;
}>) {
  const [draft, setDraft] = useState<ContactDraft>(() => contactDraft(contact));
  const [formError, setFormError] = useState<string | null>(null);

  function update(key: keyof ContactDraft, value: string): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (draft.email.trim().length === 0 && draft.displayName.trim().length === 0) {
      setFormError("Add a display name or email before saving the contact.");
      return;
    }
    setFormError(null);
    await onSave(draft);
  }
  const field = (key: keyof ContactDraft, label: string, type = "text") => (
    <label className={styles.field} key={key}>
      <span>{label}</span>
      <input
        type={type}
        value={draft[key]}
        onChange={(event) => update(key, event.currentTarget.value)}
      />
    </label>
  );
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <div className={styles.formGrid}>
        {field("firstName", "First name")}
        {field("lastName", "Last name")}
        {field("displayName", "Display name")}
        {field("email", "Email", "email")}
        {field("phone", "Phone", "tel")}
        {field("company", "Company")}
        {field("title", "Title")}
        {field("website", "Website", "url")}
        {field("linkedinUrl", "LinkedIn URL", "url")}
      </div>
      <label className={styles.field}>
        <span>Bio</span>
        <textarea
          rows={4}
          value={draft.bio}
          onChange={(event) => update("bio", event.currentTarget.value)}
          placeholder="A short speaker biography"
        />
      </label>
      <label className={styles.field}>
        <span>Headshot/profile image URL</span>
        <input
          type="url"
          value={draft.headshotUrl}
          onChange={(event) => update("headshotUrl", event.currentTarget.value)}
          placeholder="https://…"
        />
      </label>
      <label className={styles.field}>
        <span>Tags (comma-separated)</span>
        <input value={draft.tags} onChange={(event) => update("tags", event.currentTarget.value)} />
      </label>
      <label className={styles.field}>
        <span>Custom fields (one key=value per line)</span>
        <textarea
          rows={3}
          value={draft.customFields}
          onChange={(event) => update("customFields", event.currentTarget.value)}
          placeholder="region=west\npriority=high"
        />
      </label>
      <label className={styles.field}>
        <span>Contact notes</span>
        <textarea
          rows={3}
          value={draft.notes}
          onChange={(event) => update("notes", event.currentTarget.value)}
        />
      </label>
      {formError ? (
        <p className={styles.error} role="alert">
          {formError}
        </p>
      ) : null}
      <div className={styles.actions}>
        <UiButton type="submit" disabled={busy}>
          {busy ? "Saving…" : contact ? "Save contact" : "Add contact"}
        </UiButton>
        {onCancel ? (
          <UiButton variant="outline" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </UiButton>
        ) : null}
      </div>
    </form>
  );
}

function DirectoryTable({
  contacts,
  selectedContactId,
  selectedContactIds,
  loading,
  onSelect,
  onToggleSelection,
  onToggleAll,
}: Readonly<{
  contacts: readonly CrmContact[];
  selectedContactId: string | null;
  selectedContactIds: readonly string[];
  loading: boolean;
  onSelect: (contactId: string) => void;
  onToggleSelection: (contactId: string) => void;
  onToggleAll: (checked: boolean) => void;
}>) {
  const selectedContactIdSet = useMemo(() => new Set(selectedContactIds), [selectedContactIds]);
  if (loading) {
    return (
      <div
        className={styles.loading}
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="Loading contact directory"
      >
        Updating the contact directory for the current filters…
      </div>
    );
  }
  return contacts.length === 0 ? (
    <p className={styles.emptyState}>
      No contacts match these filters. Add a contact or import a CSV directory.
    </p>
  ) : (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className={styles.srOnly}>Organization CRM contact directory</caption>
        <thead>
          <tr>
            <th scope="col">
              <input
                type="checkbox"
                aria-label="Select all visible contacts"
                checked={
                  contacts.length > 0 &&
                  contacts.every((contact) => selectedContactIdSet.has(contact.id))
                }
                onChange={(event) => onToggleAll(event.currentTarget.checked)}
                disabled={loading}
              />
            </th>
            <th scope="col">Contact</th>
            <th scope="col">Company</th>
            <th scope="col">Tags</th>
            <th scope="col">Pipeline</th>
            <th scope="col">
              <span className={styles.srOnly}>Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((contact) => (
            <tr
              key={contact.id}
              className={selectedContactId === contact.id ? styles.selectedRow : undefined}
            >
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${displayName(contact)}`}
                  checked={selectedContactIdSet.has(contact.id)}
                  onChange={() => onToggleSelection(contact.id)}
                  disabled={loading}
                />
              </td>
              <th scope="row">
                <button
                  className={styles.tableLink}
                  type="button"
                  onClick={() => onSelect(contact.id)}
                  disabled={loading}
                >
                  {displayName(contact)}
                </button>
                <small>{contact.email ?? "No email"}</small>
              </th>
              <td>{contact.company ?? "—"}</td>
              <td>
                <div className={styles.tagList}>
                  {contact.tags.length > 0
                    ? contact.tags.map((tag) => (
                        <Badge variant="secondary" className={styles.tag} key={tag}>
                          {tag}
                        </Badge>
                      ))
                    : "—"}
                </div>
              </td>
              <td>
                <Badge variant="outline" className={styles.stageBadge}>
                  {contact.pipelineStage}
                </Badge>
              </td>
              <td>
                <button
                  className={styles.secondaryButtonSmall}
                  type="button"
                  onClick={() => onSelect(contact.id)}
                  disabled={loading}
                >
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SegmentManager({
  segments,
  busy,
  currentRules,
  onCreate,
  onSelect,
}: Readonly<{
  segments: readonly CrmSegment[];
  busy: boolean;
  currentRules: readonly CrmSegmentRule[];
  onCreate: (input: {
    name: string;
    description: string;
    rules: readonly CrmSegmentRule[];
  }) => Promise<void>;
  onSelect: (segmentId: string) => void;
}>) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [field, setField] = useState("pipelineStage");
  const [operator, setOperator] = useState<CrmSegmentOperator>("eq");
  const [value, setValue] = useState("new");
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!name.trim() || !field.trim()) return;
    const rules =
      currentRules.length > 0
        ? currentRules
        : [{ field: field.trim(), operator, ...(value.trim() ? { value: value.trim() } : {}) }];
    await onCreate({
      name: name.trim(),
      description: description.trim(),
      rules,
    });
    setName("");
    setDescription("");
  }
  return (
    <Card title="Saved dynamic segments" eyebrow="Audience building">
      <div className={styles.segmentLayout}>
        <div>
          {segments.length === 0 ? (
            <p className={styles.muted}>No saved segments yet.</p>
          ) : (
            <ul className={styles.segmentList}>
              {segments.map((segment) => (
                <li key={segment.id}>
                  <button
                    type="button"
                    className={styles.segmentButton}
                    onClick={() => onSelect(segment.id)}
                  >
                    <strong>{segment.name}</strong>
                    <small>
                      {segment.rules
                        .map((rule) => `${rule.field} ${rule.operator} ${String(rule.value ?? "")}`)
                        .join(" · ")}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {currentRules.length > 0 ? (
          <div className={styles.filterSummary} role="status">
            <strong>Current directory filters will be saved:</strong>{" "}
            {currentRules
              .map((rule) => `${rule.field} ${rule.operator} ${String(rule.value ?? "")}`)
              .join(" · ")}
          </div>
        ) : null}
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <h3>
            {currentRules.length > 0 ? "Save current directory filters" : "Create a named segment"}
          </h3>
          <label className={styles.field}>
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
              placeholder="West coast prospects"
            />
          </label>
          <label className={styles.field}>
            <span>Description</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span>Rule field</span>
              <input value={field} onChange={(event) => setField(event.currentTarget.value)} />
            </label>
            <label className={styles.field}>
              <span>Operator</span>
              <select
                value={operator}
                onChange={(event) => setOperator(event.currentTarget.value as CrmSegmentOperator)}
              >
                {["eq", "neq", "contains", "startsWith", "endsWith", "in", "notIn", "exists"].map(
                  (candidate) => (
                    <option key={candidate} value={candidate}>
                      {candidate}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
          <label className={styles.field}>
            <span>Rule value</span>
            <input
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
              placeholder="new"
            />
          </label>
          <button className={styles.primaryButton} type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save segment"}
          </button>
        </form>
      </div>
    </Card>
  );
}

function PipelineBoard({
  contacts,
  onMove,
  onSelect,
  onEnroll,
}: Readonly<{
  contacts: readonly CrmContact[];
  onMove: (contactId: string, stage: CrmPipelineStage) => void;
  onSelect: (contactId: string) => void;
  onEnroll: (input: {
    contactId: string;
    stage: CrmPipelineStage;
    score: string;
    rationale: string;
  }) => Promise<void>;
}>) {
  const [showEnroll, setShowEnroll] = useState(false);
  const [enrollContactId, setEnrollContactId] = useState(contacts[0]?.id ?? "");
  const [enrollStage, setEnrollStage] = useState<CrmPipelineStage>("new");
  const [enrollScore, setEnrollScore] = useState("");
  const [enrollRationale, setEnrollRationale] = useState("");

  async function submitEnrollment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!enrollContactId) return;
    await onEnroll({
      contactId: enrollContactId,
      stage: enrollStage,
      score: enrollScore,
      rationale: enrollRationale,
    });
    setEnrollScore("");
    setEnrollRationale("");
    setShowEnroll(false);
  }

  return (
    <Card
      title="Pipeline board"
      eyebrow="Stage transitions and history"
      actions={
        <button
          className={styles.primaryButton}
          type="button"
          onClick={() => setShowEnroll((current) => !current)}
        >
          {showEnroll ? "Close enrollment" : "+ Enroll contact"}
        </button>
      }
    >
      {showEnroll ? (
        <form className={styles.enrollBox} onSubmit={(event) => void submitEnrollment(event)}>
          <h3>Enroll a contact in the pipeline</h3>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span>Contact</span>
              <select
                aria-label="Pipeline contact"
                value={enrollContactId}
                onChange={(event) => setEnrollContactId(event.currentTarget.value)}
                required
              >
                <option value="">Choose a contact</option>
                {contacts.map((contact) => (
                  <option value={contact.id} key={contact.id}>
                    {displayName(contact)}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>Starting stage</span>
              <select
                aria-label="Pipeline starting stage"
                value={enrollStage}
                onChange={(event) => setEnrollStage(event.currentTarget.value as CrmPipelineStage)}
              >
                {CRM_PIPELINE_STAGES.map((stage) => (
                  <option value={stage} key={stage}>
                    {stage}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>Score (0–100, optional)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={enrollScore}
                onChange={(event) => setEnrollScore(event.currentTarget.value)}
              />
            </label>
          </div>
          <label className={styles.field}>
            <span>Rationale (optional)</span>
            <textarea
              rows={3}
              value={enrollRationale}
              onChange={(event) => setEnrollRationale(event.currentTarget.value)}
              placeholder="Why is this contact a fit?"
            />
          </label>
          <button className={styles.primaryButton} type="submit">
            Enroll in pipeline
          </button>
        </form>
      ) : null}
      <div className={styles.pipelineBoard}>
        {CRM_PIPELINE_STAGES.map((stage) => {
          const stageContacts = contacts.filter((contact) => contact.pipelineStage === stage);
          return (
            <section
              className={styles.pipelineColumn}
              key={stage}
              aria-labelledby={`pipeline-${stage}`}
            >
              <div className={styles.pipelineColumnHeader}>
                <h3 id={`pipeline-${stage}`}>{stage}</h3>
                <span>{stageContacts.length}</span>
              </div>
              {stageContacts.length === 0 ? (
                <p className={styles.muted}>No contacts</p>
              ) : (
                stageContacts.map((contact) => (
                  <article className={styles.pipelineCard} key={contact.id}>
                    <button
                      className={styles.pipelineCardButton}
                      aria-label={`Open pipeline card detail for ${displayName(contact)}`}
                      type="button"
                      onClick={() => onSelect(contact.id)}
                    >
                      <strong>{displayName(contact)}</strong>
                      <small>{contact.company ?? contact.email ?? ""}</small>
                      {customFieldText(contact, ["score", "pipelineScore"]) ? (
                        <small>Score {customFieldText(contact, ["score", "pipelineScore"])}</small>
                      ) : null}
                    </button>
                    <label className={styles.srOnly} htmlFor={`pipeline-move-${contact.id}`}>
                      Move {displayName(contact)}
                    </label>
                    <select
                      id={`pipeline-move-${contact.id}`}
                      value={contact.pipelineStage}
                      onChange={(event) =>
                        onMove(contact.id, event.currentTarget.value as CrmPipelineStage)
                      }
                    >
                      {CRM_PIPELINE_STAGES.map((candidate) => (
                        <option key={candidate} value={candidate}>
                          {candidate}
                        </option>
                      ))}
                    </select>
                  </article>
                ))
              )}
            </section>
          );
        })}
      </div>
    </Card>
  );
}

function AnalyticsPanel({
  analytics,
  events,
  onEventDrillThrough,
}: Readonly<{
  analytics: CrmAnalytics | null;
  events: readonly CrmEvent[];
  onEventDrillThrough: (eventId: string) => void;
}>) {
  if (analytics === null)
    return (
      <Card title="CRM analytics" eyebrow="Organization insights">
        <p className={styles.muted}>Analytics are not available yet.</p>
      </Card>
    );
  const eventName = new Map(events.map((event) => [event.id, event.name]));
  return (
    <Card
      title="CRM analytics"
      eyebrow="Organization insights"
      actions={
        <span className={styles.muted}>
          Updated <ClientFormattedDate value={analytics.generatedAt} />
        </span>
      }
    >
      <div className={styles.kpiGrid}>
        <div className={styles.kpi}>
          <span>Total contacts</span>
          <strong>{analytics.totalContacts}</strong>
        </div>
        <div className={styles.kpi}>
          <span>Active contacts</span>
          <strong>{analytics.activeContacts}</strong>
        </div>
        <div className={styles.kpi}>
          <span>Queued outreach</span>
          <strong>{analytics.outreach.queued}</strong>
        </div>
        <div className={styles.kpi}>
          <span>Sent outreach</span>
          <strong>{analytics.outreach.sent}</strong>
        </div>
        <div className={styles.kpi}>
          <span>Failed outreach</span>
          <strong>{analytics.outreach.failed}</strong>
        </div>
      </div>
      <div className={styles.analyticsGrid}>
        <div>
          <h3>Pipeline conversion</h3>
          <ul className={styles.metricList}>
            {CRM_PIPELINE_STAGES.map((stage) => (
              <li key={stage}>
                <span>{stage}</span>
                <strong>{analytics.contactsByPipelineStage[stage] ?? 0}</strong>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Contacts by source</h3>
          <ul className={styles.metricList}>
            {Object.entries(analytics.contactsBySource).map(([source, count]) => (
              <li key={source}>
                <span>{source}</span>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Event reach</h3>
          {analytics.contactsByEvent.length === 0 ? (
            <p className={styles.muted}>No event projections yet.</p>
          ) : (
            <ul className={styles.metricList}>
              {analytics.contactsByEvent.map(({ eventId, count }) => (
                <li key={eventId}>
                  <span>{eventName.get(eventId) ?? eventId}</span>
                  <button
                    className={styles.metricButton}
                    type="button"
                    onClick={() => onEventDrillThrough(eventId)}
                  >
                    {count} · View contacts
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

interface CrmDirectoryFilterControlsProps {
  readonly contacts: readonly CrmContact[];
  readonly selectedContactIds: readonly string[];
  readonly loading: boolean;
  readonly busy: boolean;
  readonly query: string;
  readonly companyFilter: string;
  readonly tagsFilter: string;
  readonly pipelineFilter: CrmPipelineStage | "";
  readonly statusFilter: CrmContactStatus | "";
  readonly onQueryChange: (value: string) => void;
  readonly onCompanyChange: (value: string) => void;
  readonly onTagsChange: (value: string) => void;
  readonly onPipelineFilterChange: (value: CrmPipelineStage | "") => void;
  readonly onStatusFilterChange: (value: CrmContactStatus | "") => void;
  readonly onStartAdd: () => void;
  readonly onOpenImport: () => void;
  readonly onCommunicateWithSelected: () => void;
  readonly onSelectionChange: (contactIds: readonly string[]) => void;
}

function CrmDirectoryFilterControls({
  contacts,
  selectedContactIds,
  loading,
  busy,
  query,
  companyFilter,
  tagsFilter,
  pipelineFilter,
  statusFilter,
  onQueryChange,
  onCompanyChange,
  onTagsChange,
  onPipelineFilterChange,
  onStatusFilterChange,
  onStartAdd,
  onOpenImport,
  onCommunicateWithSelected,
  onSelectionChange,
}: CrmDirectoryFilterControlsProps) {
  return (
    <>
      {contacts.length > 0 ? (
        <div className={styles.filterGrid}>
          <label className={styles.field} htmlFor="crm-search">
            <span>Search contacts</span>
            <Input
              id="crm-search"
              aria-label="Search contacts"
              value={query}
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              placeholder="Name, email, company"
            />
          </label>
          <label className={styles.field} htmlFor="crm-company-filter">
            <span>Company</span>
            <Input
              id="crm-company-filter"
              aria-label="Filter by company"
              value={companyFilter}
              onChange={(event) => onCompanyChange(event.currentTarget.value)}
            />
          </label>
          <label className={styles.field} htmlFor="crm-tags-filter">
            <span>Tags</span>
            <Input
              id="crm-tags-filter"
              aria-label="Filter by tags"
              value={tagsFilter}
              onChange={(event) => onTagsChange(event.currentTarget.value)}
              placeholder="speaker,west"
            />
          </label>
          <label className={styles.field}>
            <span>Pipeline stage</span>
            <select
              aria-label="Filter by pipeline stage"
              value={pipelineFilter}
              onChange={(event) =>
                onPipelineFilterChange(event.currentTarget.value as CrmPipelineStage | "")
              }
            >
              <option value="">All stages</option>
              {CRM_PIPELINE_STAGES.map((stage) => (
                <option value={stage} key={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Record status</span>
            <select
              aria-label="Filter by contact status"
              value={statusFilter}
              onChange={(event) =>
                onStatusFilterChange(event.currentTarget.value as CrmContactStatus | "")
              }
            >
              <option value="">All records</option>
              <option value="active">Active</option>
              <option value="merged">Merged</option>
            </select>
          </label>
        </div>
      ) : (
        <div className={styles.emptyDirectory} role="status">
          <h3>Your directory is empty</h3>
          <p>
            Add a contact manually or import a CSV to start building your organization directory.
          </p>
          <div className={styles.actions}>
            <UiButton type="button" onClick={onStartAdd} disabled={busy}>
              Add contact
            </UiButton>
            <UiButton variant="outline" type="button" onClick={onOpenImport}>
              Import CSV
            </UiButton>
          </div>
        </div>
      )}
      {selectedContactIds.length > 0 ? (
        <div className={styles.bulkToolbar} role="status">
          <strong>{selectedContactIds.length} selected</strong>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={onCommunicateWithSelected}
            aria-controls="crm-outreach-composer"
            disabled={loading}
          >
            Communicate with selected
          </button>
          <button
            className={styles.secondaryButtonSmall}
            type="button"
            onClick={() => onSelectionChange([])}
          >
            Clear selection
          </button>
        </div>
      ) : null}
    </>
  );
}

interface CrmDirectoryImportPanelProps {
  readonly showImport: boolean;
  readonly busy: boolean;
  readonly importCsv: string;
  readonly updateImportCsv: (csv: string) => void;
  readonly readImportFile: (file: File) => Promise<void>;
  readonly importFileName: string;
  readonly importPreview: CsvPreview | null;
  readonly importPreviewResult: CrmImportPreviewResult | null;
  readonly importPreviewLoading: boolean;
  readonly importPreviewError: string | null;
  readonly importPreviewCurrent: boolean;
  readonly importPreviewHasErrors: boolean;
  readonly onImport: ((csv: string) => Promise<void>) | undefined;
}

function CrmDirectoryImportPanel({
  showImport,
  busy,
  importCsv,
  updateImportCsv,
  readImportFile,
  importFileName,
  importPreview,
  importPreviewResult,
  importPreviewLoading,
  importPreviewError,
  importPreviewCurrent,
  importPreviewHasErrors,
  onImport,
}: CrmDirectoryImportPanelProps) {
  return (
    <>
      {showImport ? (
        <form
          className={styles.importBox}
          onSubmit={(event) => {
            event.preventDefault();
            if (
              importCsv.trim() &&
              importPreview !== null &&
              importPreview.rows.length > 0 &&
              importPreview.issues.length === 0 &&
              importPreviewCurrent &&
              !importPreviewHasErrors &&
              !importPreviewLoading &&
              importPreviewError === null &&
              onImport
            ) {
              void onImport(importCsv);
            }
          }}
        >
          <div className={styles.field}>
            <span>CSV file</span>
            <FileUpload
              accept=".csv,text/csv"
              title="Drop a CRM CSV here or browse"
              hint="Select a .csv file to preview its mapped rows."
              files={
                importFileName
                  ? [
                      {
                        id: importFileName,
                        name: importFileName,
                        sizeLabel: importPreviewLoading ? "Validating CSV…" : "Selected CSV",
                        status: importPreviewLoading ? "uploading" : "selected",
                        removable: false,
                      },
                    ]
                  : []
              }
              onFilesSelected={(files) => {
                const file = files[0];
                if (file) void readImportFile(file);
              }}
            />
          </div>
          <label className={styles.field}>
            <span>CSV contents (optional paste fallback)</span>
            <textarea
              rows={4}
              value={importCsv}
              onChange={(event) => updateImportCsv(event.currentTarget.value)}
              placeholder="Select a .csv file to preview its mapped rows"
            />
          </label>
          {importPreview ? (
            <div className={styles.importPreview}>
              <p className={styles.resultCount}>
                Previewing {importPreview.rows.length} data row
                {importPreview.rows.length === 1 ? "" : "s"}.
              </p>
              {importPreview.issues.length > 0 ? (
                <ul className={styles.issueList}>
                  {importPreview.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : (
                <p className={styles.success}>No mapping issues detected in the preview.</p>
              )}
              {importPreview.mapping.length > 0 ? (
                <div className={styles.tableWrap}>
                  <table className={styles.importTable}>
                    <caption>Detected CSV column mapping</caption>
                    <thead>
                      <tr>
                        <th scope="col">Source column</th>
                        <th scope="col">CRM field</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.mapping.map((column) => (
                        <tr key={column.sourceColumn}>
                          <th scope="row">{column.sourceColumn}</th>
                          <td>
                            {column.targetField}
                            {column.custom ? " (custom field)" : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {importPreview.headers.length > 0 ? (
                <div className={styles.tableWrap}>
                  <table className={styles.importTable}>
                    <caption className={styles.srOnly}>CSV import preview</caption>
                    <thead>
                      <tr>
                        {importPreview.headers.map((header) => (
                          <th scope="col" key={header}>
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((row) => (
                        <tr key={row.join("\u001f")}>
                          {importPreview.headers.map((header, columnIndex) => (
                            <td key={header}>{row[columnIndex] ?? ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
          {importCsv.trim() ? (
            <section className={styles.previewBox} aria-live="polite">
              <h3>Authoritative CRM import preview</h3>
              {importPreviewLoading ? (
                <p className={styles.muted} role="status" aria-busy="true">
                  Checking this CSV against the organization CRM…
                </p>
              ) : importPreviewError ? (
                <Alert variant="destructive">
                  <AlertTitle>Authoritative preview unavailable</AlertTitle>
                  <AlertDescription>
                    <p>{humanErrorSummary(importPreviewError)}</p>
                    <details className={styles.errorDetails}>
                      <summary>Show preview error details</summary>
                      <pre>{importPreviewError}</pre>
                    </details>
                  </AlertDescription>
                </Alert>
              ) : !importPreviewCurrent ? (
                <p className={styles.muted} role="status">
                  Preview pending. The server must classify this exact CSV before it can be
                  committed.
                </p>
              ) : importPreviewHasErrors ? (
                <Alert variant="destructive">
                  <AlertTitle>Import preview contains row errors</AlertTitle>
                  <AlertDescription>
                    <p>
                      Resolve the authoritative error rows before committing. No local parse result
                      can override server classification.
                    </p>
                  </AlertDescription>
                </Alert>
              ) : (
                <p className={styles.success} role="status">
                  Authoritative preview ready. Commit uses this exact normalized CSV plan.
                </p>
              )}
              {importPreviewCurrent && importPreviewResult ? (
                <>
                  <p className={styles.resultCount}>
                    {importPreviewResult.created} created · {importPreviewResult.updated} updated ·{" "}
                    {importPreviewResult.skipped} skipped · {importPreviewResult.errors} errors
                  </p>
                  <p className={styles.muted}>
                    {importPreviewResult.preview ? "Preview" : "Receipt"} {importPreviewResult.id}
                    {importPreviewResult.planFingerprint
                      ? ` · plan ${importPreviewResult.planFingerprint}`
                      : ""}
                    {" · generated "}
                    <ClientFormattedDate value={importPreviewResult.createdAt} /> ·{" "}
                    {importPreviewResult.contacts.length} authoritative contact
                    {importPreviewResult.contacts.length === 1 ? "" : "s"} ·{" "}
                    {importPreviewResult.mapping.length} mapped column
                    {importPreviewResult.mapping.length === 1 ? "" : "s"}
                  </p>
                  <ol className={styles.historyList}>
                    {importPreviewResult.rows.map((row) => (
                      <li key={`${row.rowNumber}-${row.identity ?? "missing"}`}>
                        <strong>
                          Row {row.rowNumber}: {row.status}
                        </strong>
                        <small>
                          {row.identity ?? "No canonical email"}
                          {row.contactId ? ` · contact ${row.contactId}` : ""}
                          {row.reason ? ` · ${row.reason}` : ""}
                        </small>
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
            </section>
          ) : null}
          <button
            className={styles.primaryButton}
            type="submit"
            disabled={
              busy ||
              !importCsv.trim() ||
              importPreview === null ||
              importPreview.rows.length === 0 ||
              importPreview.issues.length > 0 ||
              !importPreviewCurrent ||
              importPreviewHasErrors ||
              importPreviewLoading ||
              importPreviewError !== null ||
              onImport === undefined
            }
          >
            {busy ? "Importing…" : "Import directory"}
          </button>
        </form>
      ) : null}
    </>
  );
}

interface CrmDirectoryImportResultProps {
  readonly importResult: CrmImportResult | null;
}

function CrmDirectoryImportResult({ importResult }: CrmDirectoryImportResultProps) {
  return (
    <>
      {importResult ? (
        <section className={styles.importPreview} aria-labelledby="crm-import-result-title">
          <h3 id="crm-import-result-title">Import result</h3>
          <p className={styles.resultCount}>
            {importResult.created} created · {importResult.updated} updated · {importResult.skipped}{" "}
            skipped · {importResult.errors} errors
            {importResult.idempotent ? " · idempotent replay" : ""}
          </p>
          <p className={styles.muted}>
            Receipt {importResult.id} · organization {importResult.organizationId} · generated{" "}
            <ClientFormattedDate value={importResult.createdAt} />
            {importResult.planFingerprint ? ` · plan ${importResult.planFingerprint}` : ""} ·{" "}
            {importResult.contacts.length} authoritative contact
            {importResult.contacts.length === 1 ? "" : "s"}
          </p>
          <ol className={styles.historyList}>
            {importResult.rows.map((row) => (
              <li key={`${row.rowNumber}-${row.identity ?? "missing"}`}>
                <strong>
                  Row {row.rowNumber}: {row.status}
                </strong>
                <small>
                  {row.identity ?? "No canonical email"}
                  {row.contactId ? ` · contact ${row.contactId}` : ""}
                  {row.reason ? ` · ${row.reason}` : ""}
                </small>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}
interface CrmWorkspaceDirectoryCardProps {
  readonly contacts: readonly CrmContact[];
  readonly selectedContactId: string | null;
  readonly selectedContactIds: readonly string[];
  readonly loading: boolean;
  readonly busy: boolean;
  readonly query: string;
  readonly companyFilter: string;
  readonly tagsFilter: string;
  readonly pipelineFilter: CrmPipelineStage | "";
  readonly statusFilter: CrmContactStatus | "";
  readonly onQueryChange: (value: string) => void;
  readonly onCompanyChange: (value: string) => void;
  readonly onTagsChange: (value: string) => void;
  readonly onPipelineFilterChange: (value: CrmPipelineStage | "") => void;
  readonly onStatusFilterChange: (value: CrmContactStatus | "") => void;
  readonly onStartAdd: () => void;
  readonly showImport: boolean;
  readonly onToggleImport: () => void;
  readonly onOpenImport: () => void;
  readonly onCommunicateWithSelected: () => void;
  readonly onSelectionChange: (contactIds: readonly string[]) => void;
  readonly onSelectDirectoryContact: (contactId: string) => void;
  readonly readImportFile: (file: File) => Promise<void>;
  readonly importCsv: string;
  readonly updateImportCsv: (csv: string) => void;
  readonly importFileName: string;
  readonly importPreview: CsvPreview | null;
  readonly importPreviewResult: CrmImportPreviewResult | null;
  readonly importPreviewLoading: boolean;
  readonly importPreviewError: string | null;
  readonly importPreviewCurrent: boolean;
  readonly importPreviewHasErrors: boolean;
  readonly onImport: ((csv: string) => Promise<void>) | undefined;
  readonly importResult: CrmImportResult | null;
}

export function CrmWorkspaceDirectoryCard({
  contacts,
  selectedContactId,
  selectedContactIds,
  loading,
  busy,
  query,
  companyFilter,
  tagsFilter,
  pipelineFilter,
  statusFilter,
  onQueryChange,
  onCompanyChange,
  onTagsChange,
  onPipelineFilterChange,
  onStatusFilterChange,
  onStartAdd,
  showImport,
  onToggleImport,
  onOpenImport,
  onCommunicateWithSelected,
  onSelectionChange,
  onSelectDirectoryContact,
  readImportFile,
  importCsv,
  updateImportCsv,
  importFileName,
  importPreview,
  importPreviewResult,
  importPreviewLoading,
  importPreviewError,
  importPreviewCurrent,
  importPreviewHasErrors,
  onImport,
  importResult,
}: CrmWorkspaceDirectoryCardProps) {
  return (
    <Card
      title="Contact directory"
      eyebrow="Search, filter, add, edit, or import"
      actions={
        contacts.length > 0 ? (
          <div className={styles.actions}>
            <UiButton type="button" onClick={onStartAdd} disabled={busy}>
              Add contact
            </UiButton>
            <UiButton variant="outline" type="button" onClick={onToggleImport}>
              {showImport ? "Hide import" : "Import CSV"}
            </UiButton>
          </div>
        ) : null
      }
    >
      <CrmDirectoryFilterControls
        contacts={contacts}
        selectedContactIds={selectedContactIds}
        loading={loading}
        busy={busy}
        query={query}
        companyFilter={companyFilter}
        tagsFilter={tagsFilter}
        pipelineFilter={pipelineFilter}
        statusFilter={statusFilter}
        onQueryChange={onQueryChange}
        onCompanyChange={onCompanyChange}
        onTagsChange={onTagsChange}
        onPipelineFilterChange={onPipelineFilterChange}
        onStatusFilterChange={onStatusFilterChange}
        onStartAdd={onStartAdd}
        onOpenImport={onOpenImport}
        onCommunicateWithSelected={onCommunicateWithSelected}
        onSelectionChange={onSelectionChange}
      />
      <CrmDirectoryImportPanel
        showImport={showImport}
        busy={busy}
        importCsv={importCsv}
        updateImportCsv={updateImportCsv}
        readImportFile={readImportFile}
        importFileName={importFileName}
        importPreview={importPreview}
        importPreviewResult={importPreviewResult}
        importPreviewLoading={importPreviewLoading}
        importPreviewError={importPreviewError}
        importPreviewCurrent={importPreviewCurrent}
        importPreviewHasErrors={importPreviewHasErrors}
        onImport={onImport}
      />
      <CrmDirectoryImportResult importResult={importResult} />
      {!loading ? (
        <p className={styles.resultCount}>
          {contacts.length} contact{contacts.length === 1 ? "" : "s"} shown
        </p>
      ) : null}
      <DirectoryTable
        contacts={contacts}
        selectedContactId={selectedContactId}
        selectedContactIds={selectedContactIds}
        loading={loading}
        onSelect={onSelectDirectoryContact}
        onToggleSelection={(id) =>
          onSelectionChange?.(
            selectedContactIds.includes(id)
              ? selectedContactIds.filter((candidate) => candidate !== id)
              : [...selectedContactIds, id],
          )
        }
        onToggleAll={(checked) =>
          onSelectionChange?.(
            checked
              ? Array.from(
                  new Set([...selectedContactIds, ...contacts.map((contact) => contact.id)]),
                )
              : selectedContactIds.filter((id) => !contacts.some((contact) => contact.id === id)),
          )
        }
      />
    </Card>
  );
}

interface CrmWorkspaceAddContactSectionProps {
  readonly organizationId: string;
  readonly busy: boolean;
  readonly onSaveContact: ((draft: ContactDraft) => Promise<void>) | undefined;
  readonly onClose: () => void;
}

export function CrmWorkspaceAddContactSection({
  organizationId,
  busy,
  onSaveContact,
  onClose,
}: CrmWorkspaceAddContactSectionProps) {
  return (
    <Card title="Add a CRM contact" eyebrow="New organization record">
      <ContactEditor
        key={`${organizationId}:new`}
        busy={busy}
        onSave={async (draft) => {
          await onSaveContact?.(draft);
          onClose();
        }}
        onCancel={onClose}
      />
    </Card>
  );
}

interface CrmWorkspaceContactDetailSectionProps {
  readonly organizationId: string;
  readonly selectedContact: CrmContact;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly onSaveContact: ((draft: ContactDraft) => Promise<void>) | undefined;
  readonly onCancelEdit: (() => void) | undefined;
  readonly onOpenOutreach: () => void;
  readonly onFindDuplicates: (() => void) | undefined;
  readonly onToggleMergeSelection: (contactId: string, checked: boolean) => void;
  readonly mergeCandidates: readonly CrmDuplicateReport["matches"][number][];
  readonly duplicates: CrmDuplicateReport | null;
  readonly mergeSelectionSet: ReadonlySet<string>;
  readonly selectedMergeContacts: readonly CrmDuplicateReport["matches"][number][];
  readonly mergeReviewContacts: readonly CrmContact[];
  readonly mergeCustomKeys: readonly string[];
  readonly conflictingScalarFields: readonly {
    readonly key: CrmMergeScalarField;
    readonly label: string;
  }[];
  readonly conflictingCustomKeys: readonly string[];
  readonly mergeReviewOpen: boolean;
  readonly mergePreview: CrmMergePreview | null;
  readonly mergePreviewLoading: boolean;
  readonly mergePreviewError: string | null;
  readonly mergePreviewCurrent: boolean;
  readonly mergePreviewHasConflicts: boolean;
  readonly mergeResult: CrmMergeResult | null;
  readonly mergeCommitReady: boolean;
  readonly mergeCompleted: boolean;
  readonly mergeCompletedContactId: string | null;
  readonly mergeFieldWinners: Partial<Record<CrmMergeScalarField, string>>;
  readonly mergeCustomFieldWinners: Record<string, string>;
  readonly mergeConfirmed: boolean;
  readonly mergeSubmitting: boolean;
  readonly onOpenMergeReview: () => void;
  readonly onCloseMergeReview: () => void;
  readonly onSubmitMerge: () => Promise<void>;
  readonly onSetMergeFieldWinners: (value: Partial<Record<CrmMergeScalarField, string>>) => void;
  readonly onSetMergeCustomFieldWinners: (value: Record<string, string>) => void;
  readonly onSetMergeConfirmed: (value: boolean) => void;
  readonly onRequestMergePreview: (
    fieldWinners: Partial<Record<CrmMergeScalarField, string>>,
    customFieldWinners: Readonly<Record<string, string>>,
  ) => void;
}

interface CrmDuplicateReviewSectionProps {
  readonly duplicateReviewRef: RefObject<HTMLDivElement | null>;
  readonly selectedContact: CrmContact;
  readonly busy: boolean;
  readonly mergeCandidates: readonly CrmDuplicateReport["matches"][number][];
  readonly mergeSelectionSet: ReadonlySet<string>;
  readonly selectedMergeContacts: readonly CrmDuplicateReport["matches"][number][];
  readonly mergeReviewContacts: readonly CrmContact[];
  readonly mergeCustomKeys: readonly string[];
  readonly conflictingScalarFields: readonly {
    readonly key: CrmMergeScalarField;
    readonly label: string;
  }[];
  readonly conflictingCustomKeys: readonly string[];
  readonly mergeReviewOpen: boolean;
  readonly mergePreview: CrmMergePreview | null;
  readonly mergePreviewLoading: boolean;
  readonly mergePreviewError: string | null;
  readonly mergePreviewCurrent: boolean;
  readonly mergePreviewHasConflicts: boolean;
  readonly mergeResult: CrmMergeResult | null;
  readonly mergeCommitReady: boolean;
  readonly mergeFieldWinners: Partial<Record<CrmMergeScalarField, string>>;
  readonly mergeCustomFieldWinners: Record<string, string>;
  readonly mergeConfirmed: boolean;
  readonly mergeSubmitting: boolean;
  readonly mergeCompleted: boolean;
  readonly onToggleMergeSelection: (contactId: string, checked: boolean) => void;
  readonly onOpenMergeReview: () => void;
  readonly onCloseMergeReview: () => void;
  readonly onSubmitMerge: () => Promise<void>;
  readonly onSetMergeFieldWinners: (value: Partial<Record<CrmMergeScalarField, string>>) => void;
  readonly onSetMergeCustomFieldWinners: (value: Record<string, string>) => void;
  readonly onSetMergeConfirmed: (value: boolean) => void;
  readonly onRequestMergePreview: (
    fieldWinners: Partial<Record<CrmMergeScalarField, string>>,
    customFieldWinners: Readonly<Record<string, string>>,
  ) => void;
}

interface CrmMergePreviewPanelProps {
  readonly mergeReviewOpen: boolean;
  readonly mergePreview: CrmMergePreview | null;
  readonly mergePreviewLoading: boolean;
  readonly mergePreviewError: string | null;
  readonly mergePreviewCurrent: boolean;
  readonly mergePreviewHasConflicts: boolean;
  readonly mergeResult: CrmMergeResult | null;
}

function CrmMergePreviewPanel({
  mergeReviewOpen,
  mergePreview,
  mergePreviewLoading,
  mergePreviewError,
  mergePreviewCurrent,
  mergePreviewHasConflicts,
  mergeResult,
}: CrmMergePreviewPanelProps) {
  return (
    <>
      {mergeReviewOpen || mergePreview !== null || mergePreviewLoading || mergePreviewError ? (
        <section className={styles.previewBox} aria-live="polite">
          <h3>Authoritative relationship-aware merge preview</h3>
          <p className={styles.muted}>
            CRM contact merge rewires CRM relationships only. It never merges participant identity,
            authorization, portal grants, task ownership, asset ownership, roster membership,
            reviewer access, or historical recipient snapshots.
          </p>
          {mergePreviewLoading ? (
            <p className={styles.muted} role="status" aria-busy="true">
              Checking relationship links and participant conflicts…
            </p>
          ) : mergePreviewError ? (
            <Alert variant="destructive">
              <AlertTitle>Merge preview unavailable</AlertTitle>
              <AlertDescription>
                <p>{humanErrorSummary(mergePreviewError)}</p>
                <details className={styles.errorDetails}>
                  <summary>Show preview error details</summary>
                  <pre>{mergePreviewError}</pre>
                </details>
              </AlertDescription>
            </Alert>
          ) : !mergePreviewCurrent ? (
            <p className={styles.muted} role="status">
              Preview pending or stale. A current server preview is required before this merge can
              be committed.
            </p>
          ) : mergePreview ? (
            <>
              <p className={styles.resultCount}>
                Survivor{" "}
                <strong>
                  {displayName(mergePreview.survivor)} ({mergePreview.survivorId})
                </strong>{" "}
                · retired {mergePreview.retiredIds.length} contact
                {mergePreview.retiredIds.length === 1 ? "" : "s"}
              </p>
              <p className={styles.muted}>
                Retired contacts:{" "}
                {mergePreview.tombstones
                  .map((candidate) => `${displayName(candidate)} (${candidate.id})`)
                  .join(", ") || "—"}
              </p>
              <ul className={styles.metricList}>
                <li>
                  <span>Participant CRM links rewired</span>
                  <strong>{mergePreview.rewired.participantContactLinks}</strong>
                </li>
                <li>
                  <span>Notes rewired</span>
                  <strong>{mergePreview.rewired.notes}</strong>
                </li>
                <li>
                  <span>Segments rewired</span>
                  <strong>{mergePreview.rewired.segments}</strong>
                </li>
                <li>
                  <span>Pipeline history rewired</span>
                  <strong>{mergePreview.rewired.pipelineHistory}</strong>
                </li>
              </ul>
              <p className={styles.muted}>
                Stable audit reference <strong>{mergePreview.auditId}</strong> · plan{" "}
                {mergePreview.planFingerprint}
              </p>
              {mergePreviewHasConflicts ? (
                <Alert variant="destructive">
                  <AlertTitle>
                    Participant conflict blocks this merge (
                    {mergePreview.participantConflicts.length})
                  </AlertTitle>
                  <AlertDescription>
                    <p>
                      Distinct participants are linked to contacts in this merge. CRM merge cannot
                      choose a participant identity or change authorization.
                    </p>
                    <ul>
                      {mergePreview.participantConflicts.map((conflict) => (
                        <li key={`${conflict.eventId}-${conflict.participantIds.join(",")}`}>
                          Event {conflict.eventId}: participants{" "}
                          {conflict.participantIds.join(", ")} share CRM contacts{" "}
                          {conflict.crmContactIds.join(", ")}.
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : mergePreview.canCommit ? (
                <p className={styles.success} role="status">
                  Relationship preview is clear and current. The commit remains idempotent and will
                  use this plan.
                </p>
              ) : (
                <Alert variant="destructive">
                  <AlertTitle>Merge preview conflict</AlertTitle>
                  <AlertDescription>
                    The server marked this relationship plan as non-committable.
                  </AlertDescription>
                </Alert>
              )}
            </>
          ) : null}
          {mergeResult ? (
            <div className={styles.success} role="status">
              <strong>
                Merge committed{mergeResult.idempotent ? " (idempotent replay)" : ""}.
              </strong>
              <p>
                Audit {mergeResult.auditId}: survivor {mergeResult.survivorId}; retired{" "}
                {mergeResult.retiredIds.length} contact
                {mergeResult.retiredIds.length === 1 ? "" : "s"}.
              </p>
              <p>
                Rewired {mergeResult.rewired.participantContactLinks} participant CRM link
                {mergeResult.rewired.participantContactLinks === 1 ? "" : "s"},{" "}
                {mergeResult.rewired.notes} note
                {mergeResult.rewired.notes === 1 ? "" : "s"}, {mergeResult.rewired.segments} segment
                {mergeResult.rewired.segments === 1 ? "" : "s"}, and{" "}
                {mergeResult.rewired.pipelineHistory} pipeline history record
                {mergeResult.rewired.pipelineHistory === 1 ? "" : "s"}.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}{" "}
    </>
  );
}

interface CrmMergeReviewPanelProps {
  readonly selectedContact: CrmContact;
  readonly selectedMergeContacts: readonly CrmDuplicateReport["matches"][number][];
  readonly mergeReviewContacts: readonly CrmContact[];
  readonly mergeCustomKeys: readonly string[];
  readonly conflictingScalarFields: readonly {
    readonly key: CrmMergeScalarField;
    readonly label: string;
  }[];
  readonly conflictingCustomKeys: readonly string[];
  readonly mergeReviewOpen: boolean;
  readonly mergeFieldWinners: Partial<Record<CrmMergeScalarField, string>>;
  readonly mergeCustomFieldWinners: Record<string, string>;
  readonly mergeConfirmed: boolean;
  readonly mergeSubmitting: boolean;
  readonly mergeCommitReady: boolean;
  readonly mergeCompleted: boolean;
  readonly busy: boolean;
  readonly onCloseMergeReview: () => void;
  readonly onSubmitMerge: () => Promise<void>;
  readonly onSetMergeFieldWinners: (value: Partial<Record<CrmMergeScalarField, string>>) => void;
  readonly onSetMergeCustomFieldWinners: (value: Record<string, string>) => void;
  readonly onSetMergeConfirmed: (value: boolean) => void;
  readonly onRequestMergePreview: (
    fieldWinners: Partial<Record<CrmMergeScalarField, string>>,
    customFieldWinners: Readonly<Record<string, string>>,
  ) => void;
}

function CrmMergeReviewPanel({
  selectedContact,
  selectedMergeContacts,
  mergeReviewContacts,
  mergeCustomKeys,
  conflictingScalarFields,
  conflictingCustomKeys,
  mergeReviewOpen,
  mergeFieldWinners,
  mergeCustomFieldWinners,
  mergeConfirmed,
  mergeSubmitting,
  mergeCommitReady,
  mergeCompleted,
  busy,
  onCloseMergeReview,
  onSubmitMerge,
  onSetMergeFieldWinners,
  onSetMergeCustomFieldWinners,
  onSetMergeConfirmed,
  onRequestMergePreview,
}: CrmMergeReviewPanelProps) {
  return (
    <>
      {mergeReviewOpen && selectedMergeContacts.length > 0 ? (
        <section className={styles.mergeReview} aria-labelledby="crm-merge-review-title">
          <div>
            <h3 id="crm-merge-review-title">Review contact merge</h3>
            <p className={styles.muted}>
              Compare the primary with each selected duplicate. Selected winner values are retained
              on the primary when the merge completes.
            </p>
          </div>
          <div className={styles.mergeComparison}>
            <table className={styles.mergeTable}>
              <caption className={styles.srOnly}>
                Side-by-side primary and duplicate contact comparison
              </caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">
                    Primary
                    <span className={styles.mergeColumnName}>{displayName(selectedContact)}</span>
                  </th>
                  {selectedMergeContacts.map((match) => (
                    <th scope="col" key={match.contact.id}>
                      Duplicate
                      <span className={styles.mergeColumnName}>{displayName(match.contact)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CRM_MERGE_SCALAR_FIELDS.map(({ key: field, label }) => (
                  <tr key={field}>
                    <th scope="row">{label}</th>
                    <td>{mergeFieldValue(selectedContact, field) || "—"}</td>
                    {selectedMergeContacts.map((match) => (
                      <td key={match.contact.id}>{mergeFieldValue(match.contact, field) || "—"}</td>
                    ))}
                  </tr>
                ))}
                {mergeCustomKeys.map((key) => (
                  <tr key={`custom-${key}`}>
                    <th scope="row">Custom · {key}</th>
                    <td>{mergeValueText(selectedContact.customFields[key]) || "—"}</td>
                    {selectedMergeContacts.map((match) => (
                      <td key={match.contact.id}>
                        {mergeValueText(match.contact.customFields[key]) || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {conflictingScalarFields.length > 0 || conflictingCustomKeys.length > 0 ? (
            <div className={styles.mergeConflictList}>
              <h4>Choose a winner for each conflict</h4>
              {conflictingScalarFields.map(({ key: field, label }) => (
                <fieldset className={styles.mergeConflict} key={field}>
                  <legend>{label} winner</legend>
                  {mergeReviewContacts.reduce<ReactNode[]>((options, candidate) => {
                    if (!mergeValuePresent(mergeFieldValue(candidate, field))) {
                      return options;
                    }
                    options.push(
                      <label className={styles.mergeOption} key={candidate.id}>
                        <input
                          type="radio"
                          name={`crm-merge-${field}`}
                          value={candidate.id}
                          checked={
                            (mergeFieldWinners[field] ?? selectedContact.id) === candidate.id
                          }
                          onChange={() => {
                            const nextFieldWinners = {
                              ...mergeFieldWinners,
                              [field]: candidate.id,
                            };
                            onSetMergeFieldWinners(nextFieldWinners);
                            onSetMergeConfirmed(false);
                            onRequestMergePreview(nextFieldWinners, mergeCustomFieldWinners);
                          }}
                        />
                        <span>
                          {candidate.id === selectedContact.id ? "Primary" : "Duplicate"} ·{" "}
                          {displayName(candidate)}: {mergeFieldValue(candidate, field)}
                        </span>
                      </label>,
                    );
                    return options;
                  }, [])}
                </fieldset>
              ))}
              {conflictingCustomKeys.map((key) => (
                <fieldset className={styles.mergeConflict} key={`custom-${key}`}>
                  <legend>Custom field “{key}” winner</legend>
                  {mergeReviewContacts.reduce<ReactNode[]>((options, candidate) => {
                    if (!mergeValuePresent(candidate.customFields[key])) {
                      return options;
                    }
                    options.push(
                      <label className={styles.mergeOption} key={candidate.id}>
                        <input
                          type="radio"
                          name={`crm-merge-custom-${key}`}
                          value={candidate.id}
                          checked={
                            (mergeCustomFieldWinners[key] ?? selectedContact.id) === candidate.id
                          }
                          onChange={() => {
                            const nextCustomFieldWinners = {
                              ...mergeCustomFieldWinners,
                              [key]: candidate.id,
                            };
                            onSetMergeCustomFieldWinners(nextCustomFieldWinners);
                            onSetMergeConfirmed(false);
                            onRequestMergePreview(mergeFieldWinners, nextCustomFieldWinners);
                          }}
                        />
                        <span>
                          {candidate.id === selectedContact.id ? "Primary" : "Duplicate"} ·{" "}
                          {displayName(candidate)}: {mergeValueText(candidate.customFields[key])}
                        </span>
                      </label>,
                    );
                    return options;
                  }, [])}
                </fieldset>
              ))}
            </div>
          ) : (
            <p className={styles.muted}>
              No conflicting values were found. The backend retains primary values and fills blank
              primary fields from selected duplicates.
            </p>
          )}
          <div className={styles.mergeRetention}>
            <strong>What stays with the primary contact</strong>
            <p>
              The primary identity remains authoritative. Its tags and cross-event history stay
              attached to it; selected duplicates are marked merged for auditability.
            </p>
          </div>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={mergeConfirmed}
              onChange={(event) => onSetMergeConfirmed(event.currentTarget.checked)}
              aria-describedby="crm-merge-confirmation"
            />
            <span id="crm-merge-confirmation">
              I understand this is permanent and cannot be undone from this CRM.
            </span>
          </label>
          <div className={styles.mergeActions}>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={onCloseMergeReview}
              disabled={mergeSubmitting}
            >
              Back to duplicate list
            </button>
            <button
              className={styles.dangerButton}
              type="button"
              onClick={() => void onSubmitMerge()}
              disabled={
                busy || mergeSubmitting || !mergeConfirmed || !mergeCommitReady || mergeCompleted
              }
            >
              {mergeSubmitting ? "Merging…" : "Confirm permanent merge"}
            </button>
          </div>
        </section>
      ) : null}{" "}
    </>
  );
}

function CrmDuplicateReviewSection({
  duplicateReviewRef,
  selectedContact,
  busy,
  mergeCandidates,
  mergeSelectionSet,
  selectedMergeContacts,
  mergeReviewContacts,
  mergeCustomKeys,
  conflictingScalarFields,
  conflictingCustomKeys,
  mergeReviewOpen,
  mergePreview,
  mergePreviewLoading,
  mergePreviewError,
  mergePreviewCurrent,
  mergePreviewHasConflicts,
  mergeResult,
  mergeCommitReady,
  mergeFieldWinners,
  mergeCustomFieldWinners,
  mergeConfirmed,
  mergeSubmitting,
  mergeCompleted,
  onToggleMergeSelection,
  onOpenMergeReview,
  onCloseMergeReview,
  onSubmitMerge,
  onSetMergeFieldWinners,
  onSetMergeCustomFieldWinners,
  onSetMergeConfirmed,
  onRequestMergePreview,
}: CrmDuplicateReviewSectionProps) {
  return (
    <section
      id="crm-duplicate-review"
      ref={duplicateReviewRef}
      className={styles.duplicateBox}
      tabIndex={-1}
      aria-labelledby="crm-duplicate-review-title"
    >
      <strong id="crm-duplicate-review-title">
        {mergeCandidates.length} possible duplicate
        {mergeCandidates.length === 1 ? "" : "s"}
      </strong>
      <p className={styles.muted}>
        Select records to compare. Nothing is merged until you review the values and confirm the
        permanent action.
      </p>
      {mergeCandidates.map((match) => (
        <label className={styles.checkRow} key={match.contact.id}>
          <input
            type="checkbox"
            checked={mergeSelectionSet.has(match.contact.id)}
            aria-label={`Select ${displayName(match.contact)}`}
            onChange={(event) =>
              onToggleMergeSelection(match.contact.id, event.currentTarget.checked)
            }
          />
          {displayName(match.contact)} · {Math.round(match.score * 100)}% match (
          {match.matchedFields.join(", ")})
        </label>
      ))}
      <button
        className={styles.secondaryButton}
        type="button"
        onClick={onOpenMergeReview}
        disabled={busy || selectedMergeContacts.length === 0}
      >
        Review selected merge
      </button>
      <CrmMergePreviewPanel
        mergeReviewOpen={mergeReviewOpen}
        mergePreview={mergePreview}
        mergePreviewLoading={mergePreviewLoading}
        mergePreviewError={mergePreviewError}
        mergePreviewCurrent={mergePreviewCurrent}
        mergePreviewHasConflicts={mergePreviewHasConflicts}
        mergeResult={mergeResult}
      />
      <CrmMergeReviewPanel
        selectedContact={selectedContact}
        selectedMergeContacts={selectedMergeContacts}
        mergeReviewContacts={mergeReviewContacts}
        mergeCustomKeys={mergeCustomKeys}
        conflictingScalarFields={conflictingScalarFields}
        conflictingCustomKeys={conflictingCustomKeys}
        mergeReviewOpen={mergeReviewOpen}
        mergeFieldWinners={mergeFieldWinners}
        mergeCustomFieldWinners={mergeCustomFieldWinners}
        mergeConfirmed={mergeConfirmed}
        mergeSubmitting={mergeSubmitting}
        mergeCommitReady={mergeCommitReady}
        mergeCompleted={mergeCompleted}
        busy={busy}
        onCloseMergeReview={onCloseMergeReview}
        onSubmitMerge={onSubmitMerge}
        onSetMergeFieldWinners={onSetMergeFieldWinners}
        onSetMergeCustomFieldWinners={onSetMergeCustomFieldWinners}
        onSetMergeConfirmed={onSetMergeConfirmed}
        onRequestMergePreview={onRequestMergePreview}
      />
    </section>
  );
}

export function CrmWorkspaceContactDetailSection({
  organizationId,
  selectedContact,
  busy,
  loading,
  onSaveContact,
  onCancelEdit,
  onOpenOutreach,
  onFindDuplicates,
  onToggleMergeSelection,
  mergeCandidates,
  duplicates,
  mergeSelectionSet,
  selectedMergeContacts,
  mergeReviewContacts,
  mergeCustomKeys,
  conflictingScalarFields,
  conflictingCustomKeys,
  mergeReviewOpen,
  mergePreview,
  mergePreviewLoading,
  mergePreviewError,
  mergePreviewCurrent,
  mergePreviewHasConflicts,
  mergeResult,
  mergeCommitReady,
  mergeCompleted,
  mergeCompletedContactId,
  mergeFieldWinners,
  mergeCustomFieldWinners,
  mergeConfirmed,
  mergeSubmitting,
  onOpenMergeReview,
  onCloseMergeReview,
  onSubmitMerge,
  onSetMergeFieldWinners,
  onSetMergeCustomFieldWinners,
  onSetMergeConfirmed,
  onRequestMergePreview,
}: CrmWorkspaceContactDetailSectionProps) {
  const duplicateReviewRef = useRef<HTMLDivElement>(null);
  const focusDuplicateReview = () => focusAndScroll(duplicateReviewRef.current);
  return (
    <Card
      title={displayName(selectedContact)}
      eyebrow="Pipeline card detail · identity, tags, custom fields, and notes"
      actions={
        <div className={styles.actions}>
          <Badge variant="outline" className={styles.stageBadge}>
            {selectedContact.pipelineStage}
          </Badge>
          {mergeCandidates.length > 0 ? (
            <>
              <span className={styles.muted}>
                {mergeCandidates.length} possible duplicate
                {mergeCandidates.length === 1 ? "" : "s"}
              </span>
              <button
                className={styles.secondaryButtonSmall}
                type="button"
                onClick={focusDuplicateReview}
                aria-controls="crm-duplicate-review"
                disabled={busy}
              >
                Review possible duplicates
              </button>
            </>
          ) : null}
        </div>
      }
    >
      <div className={styles.detailGrid}>
        <div className={styles.detailIdentity}>
          <dl className={styles.identityList}>
            <div>
              <dt>Email</dt>
              <dd>{selectedContact.email ?? "—"}</dd>
            </div>
            <div>
              <dt>Company</dt>
              <dd>{selectedContact.company ?? "—"}</dd>
            </div>
            <div>
              <dt>Title</dt>
              <dd>{selectedContact.title ?? "—"}</dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd>{selectedContact.phone ?? "—"}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{selectedContact.source}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>
                <ClientFormattedDate value={selectedContact.updatedAt} />
              </dd>
            </div>
          </dl>
          <div className={styles.profilePanel}>
            <h3>Profile</h3>
            <p>
              <strong>Bio</strong>
              <br />
              {contactBio(selectedContact) || "No persisted bio yet."}
            </p>
            <p>
              <strong>Headshot</strong>
              <br />
              {contactHeadshotUrl(selectedContact) ? (
                <a href={contactHeadshotUrl(selectedContact)} target="_blank" rel="noreferrer">
                  {contactHeadshotUrl(selectedContact)}
                </a>
              ) : (
                "No persisted headshot yet."
              )}
            </p>
          </div>
          <div className={styles.tagList}>
            {selectedContact.tags.map((tag) => (
              <Badge variant="secondary" className={styles.tag} key={tag}>
                {tag}
              </Badge>
            ))}
          </div>
          <h3>Custom fields</h3>
          {Object.keys(selectedContact.customFields).length === 0 ? (
            <p className={styles.muted}>No custom fields.</p>
          ) : (
            <dl className={styles.identityList}>
              {Object.entries(selectedContact.customFields).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <ContactEditor
          key={`${organizationId}:${selectedContact.id}:${selectedContact.version}`}
          contact={selectedContact}
          busy={busy}
          onSave={async (draft) => onSaveContact?.(draft)}
          {...(onCancelEdit === undefined ? {} : { onCancel: onCancelEdit })}
        />
      </div>
      <div className={styles.detailActions}>
        <button
          className={styles.primaryButton}
          type="button"
          onClick={onOpenOutreach}
          aria-controls="crm-outreach-composer"
          disabled={busy || loading}
        >
          Open outreach composer
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={onFindDuplicates}
          disabled={busy}
        >
          Find possible duplicates
        </button>
        {mergeCompleted && mergeCompletedContactId === selectedContact.id ? (
          <div className={styles.success} role="status">
            <strong>Merge completed.</strong>
            <p>
              The primary contact remains the authoritative record. This CRM has no undo endpoint,
              so the merge cannot be reversed here; review the retained tags and history on the
              primary contact.
            </p>
          </div>
        ) : null}
        {duplicates && mergeCandidates.length > 0 ? (
          <CrmDuplicateReviewSection
            duplicateReviewRef={duplicateReviewRef}
            selectedContact={selectedContact}
            busy={busy}
            mergeCandidates={mergeCandidates}
            mergeSelectionSet={mergeSelectionSet}
            selectedMergeContacts={selectedMergeContacts}
            mergeReviewContacts={mergeReviewContacts}
            mergeCustomKeys={mergeCustomKeys}
            conflictingScalarFields={conflictingScalarFields}
            conflictingCustomKeys={conflictingCustomKeys}
            mergeReviewOpen={mergeReviewOpen}
            mergePreview={mergePreview}
            mergePreviewLoading={mergePreviewLoading}
            mergePreviewError={mergePreviewError}
            mergePreviewCurrent={mergePreviewCurrent}
            mergePreviewHasConflicts={mergePreviewHasConflicts}
            mergeResult={mergeResult}
            mergeCommitReady={mergeCommitReady}
            mergeFieldWinners={mergeFieldWinners}
            mergeCustomFieldWinners={mergeCustomFieldWinners}
            mergeConfirmed={mergeConfirmed}
            mergeSubmitting={mergeSubmitting}
            mergeCompleted={mergeCompleted}
            onToggleMergeSelection={onToggleMergeSelection}
            onOpenMergeReview={onOpenMergeReview}
            onCloseMergeReview={onCloseMergeReview}
            onSubmitMerge={onSubmitMerge}
            onSetMergeFieldWinners={onSetMergeFieldWinners}
            onSetMergeCustomFieldWinners={onSetMergeCustomFieldWinners}
            onSetMergeConfirmed={onSetMergeConfirmed}
            onRequestMergePreview={onRequestMergePreview}
          />
        ) : duplicates ? (
          <p className={styles.muted}>No eligible duplicates found.</p>
        ) : null}
      </div>
    </Card>
  );
}

interface CrmWorkspaceContactOperationsSectionProps {
  readonly organizationId: string;
  readonly selectedContact: CrmContact;
  readonly busy: boolean;
  readonly pipelineStage: CrmPipelineStage;
  readonly pipelineNote: string;
  readonly onPipelineStageChange: (value: CrmPipelineStage) => void;
  readonly onPipelineNoteChange: (value: string) => void;
  readonly pipelineHistory: readonly CrmPipelineEntry[];
  readonly events: readonly CrmEvent[];
  readonly eventId: string;
  readonly eventRole: "speaker" | "prospect" | "attendee" | "sponsor";
  readonly eventNote: string;
  readonly onEventIdChange: (value: string) => void;
  readonly onEventRoleChange: (value: "speaker" | "prospect" | "attendee" | "sponsor") => void;
  readonly onEventNoteChange: (value: string) => void;
  readonly selectedEvent: CrmEvent | undefined;
  readonly lastAddedEventId: string | null;
  readonly lastEventResult: CrmEventProjectionResult | null;
  readonly notes: readonly CrmNote[];
  readonly timelineHistory: readonly CrmHistoryEntry[];
  readonly noteBody: string;
  readonly noteError: string | null;
  readonly onNoteBodyChange: (value: string) => void;
  readonly saveEvent: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly saveNote: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onSavePipeline: ((stage: CrmPipelineStage, note: string) => Promise<void>) | undefined;
}

export function CrmWorkspaceContactOperationsSection({
  organizationId,
  selectedContact,
  busy,
  pipelineStage,
  pipelineNote,
  onPipelineStageChange,
  onPipelineNoteChange,
  pipelineHistory,
  events,
  eventId,
  eventRole,
  eventNote,
  onEventIdChange,
  onEventRoleChange,
  onEventNoteChange,
  selectedEvent,
  lastAddedEventId,
  lastEventResult,
  notes,
  timelineHistory,
  noteBody,
  noteError,
  onNoteBodyChange,
  saveEvent,
  saveNote,
  onSavePipeline,
}: CrmWorkspaceContactOperationsSectionProps) {
  return (
    <div className={styles.twoColumn}>
      <Card title="Pipeline transition" eyebrow="Every move is audited">
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (onSavePipeline) void onSavePipeline(pipelineStage, pipelineNote);
          }}
        >
          <label className={styles.field}>
            <span>Current stage</span>
            <select
              value={pipelineStage}
              onChange={(event) =>
                onPipelineStageChange(event.currentTarget.value as CrmPipelineStage)
              }
            >
              {CRM_PIPELINE_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Transition note</span>
            <input
              value={pipelineNote}
              onChange={(event) => onPipelineNoteChange(event.currentTarget.value)}
              placeholder="Why is this moving?"
            />
          </label>
          <button
            className={styles.primaryButton}
            type="submit"
            disabled={busy || pipelineStage === selectedContact.pipelineStage}
          >
            Save pipeline stage
          </button>
        </form>
        <h3>Pipeline history</h3>
        {pipelineHistory.length === 0 ? (
          <p className={styles.muted}>No pipeline transitions recorded.</p>
        ) : (
          <ol className={styles.historyList}>
            {pipelineHistory.map((entry) => (
              <li key={entry.id}>
                <strong>
                  Previous stage: {entry.fromStage ?? "—"} → New stage: {entry.toStage}
                </strong>
                <small>
                  {entry.actorName} · <ClientFormattedDate value={entry.createdAt} />
                  {entry.note ? ` · Note: ${entry.note}` : ""}
                </small>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card title="Add to event" eyebrow="Organization event picker">
        <form className={styles.form} onSubmit={(event) => void saveEvent(event)}>
          <label className={styles.field}>
            <span>Event</span>
            <select
              value={eventId}
              onChange={(event) => onEventIdChange(event.currentTarget.value)}
              required
            >
              <option value="">Choose an event</option>
              {events.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Relationship</span>
            <select
              value={eventRole}
              onChange={(event) => onEventRoleChange(event.currentTarget.value as typeof eventRole)}
            >
              <option value="prospect">Prospect</option>
              <option value="speaker">Speaker</option>
              <option value="attendee">Attendee</option>
              <option value="sponsor">Sponsor</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>Event note</span>
            <input
              value={eventNote}
              onChange={(event) => onEventNoteChange(event.currentTarget.value)}
            />
          </label>
          <button className={styles.primaryButton} type="submit" disabled={busy || !eventId}>
            Add contact to event
          </button>
        </form>
        {lastAddedEventId && lastEventResult ? (
          <p className={styles.success}>
            Canonical relationship{" "}
            {lastEventResult.outcome === "created" ? "created" : "already existed"} for{" "}
            {selectedEvent?.name ?? lastAddedEventId}
            {lastEventResult.idempotent ? " (idempotent)." : "."}{" "}
            <Link
              href={`/admin/organizations/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(selectedEvent?.id ?? lastAddedEventId)}`}
            >
              Open event workspace
            </Link>
          </p>
        ) : null}
      </Card>
      <Card title="Notes and cross-event history" eyebrow="A durable contact timeline">
        <form className={styles.form} onSubmit={(event) => void saveNote(event)}>
          <label className={styles.field}>
            <span>New note</span>
            <textarea
              rows={3}
              value={noteBody}
              onChange={(event) => onNoteBodyChange(event.currentTarget.value)}
              placeholder="Record a relationship detail"
              required
            />
          </label>
          <button
            className={styles.primaryButton}
            type="submit"
            disabled={busy || !noteBody.trim()}
          >
            Save note
          </button>
          {noteError ? (
            <p className={styles.error} role="alert">
              {noteError}
            </p>
          ) : null}
        </form>
        <div className={styles.timeline}>
          {notes.map((note) => (
            <article key={note.id}>
              <strong>Note</strong>
              <p>{note.body}</p>
              <small>
                <ClientFormattedDate value={note.createdAt} />
              </small>
            </article>
          ))}
          {timelineHistory.map((entry) => (
            <article key={entry.id}>
              <strong>{entry.title}</strong>
              <p>
                {entry.detail ?? entry.kind}
                {entry.eventId ? ` · event ${entry.eventId}` : ""}
              </p>
              <small>
                <ClientFormattedDate value={entry.occurredAt} />
              </small>
            </article>
          ))}
          {notes.length === 0 && timelineHistory.length === 0 ? (
            <p className={styles.muted}>No history has been recorded for this contact.</p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

interface CrmWorkspaceOutreachSectionProps {
  readonly selectedContactIds: readonly string[];
  readonly segments: readonly CrmSegment[];
  readonly events: readonly CrmEvent[];
  readonly busy: boolean;
  readonly outreachSegmentId: string;
  readonly outreachContextSegmentId: string;
  readonly outreachEventId: string;
  readonly outreachSubject: string;
  readonly outreachBody: string;
  readonly outreachPreview: CrmOutreachPreview | null;
  readonly outreachHasUnknownTags: boolean;
  readonly outreachResults: readonly CrmOutreachCommand[];
  readonly onSegmentChange: (value: string) => void;
  readonly onContextSegmentChange: (value: string) => void;
  readonly onEventChange: (value: string) => void;
  readonly onSubjectChange: (value: string) => void;
  readonly onBodyChange: (value: string) => void;
  readonly previewOutreach: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onSendOutreach: (() => Promise<void>) | undefined;
  readonly outreachComposerRef: RefObject<HTMLDivElement | null>;
}

export function CrmWorkspaceOutreachSection({
  selectedContactIds,
  segments,
  events,
  busy,
  outreachSegmentId,
  outreachContextSegmentId,
  outreachEventId,
  outreachSubject,
  outreachBody,
  outreachPreview,
  outreachHasUnknownTags,
  outreachResults,
  onSegmentChange,
  onContextSegmentChange,
  onEventChange,
  onSubjectChange,
  onBodyChange,
  previewOutreach,
  onSendOutreach,
  outreachComposerRef,
}: CrmWorkspaceOutreachSectionProps) {
  return (
    <section
      id="crm-outreach-composer"
      ref={outreachComposerRef}
      tabIndex={-1}
      aria-label="Personalized outreach composer"
    >
      <Card
        title="Personalized outreach"
        eyebrow={
          outreachSegmentId === "__selected__" && selectedContactIds.length > 0
            ? `Communicate with ${selectedContactIds.length} selected contacts`
            : "Preview before queueing"
        }
      >
        <div className={styles.previewBox} role="note" aria-label="Recipient safeguards">
          <h3>Recipient safeguards</h3>
          <p>
            Preview confirms merge fields, not consent. Active-contact, valid-address, sender
            exclusion, provider suppression, and unsubscribe rules are rechecked when delivery is
            queued. Final failures, bounces, and complaints remain visible in the queue results.
          </p>
        </div>
        <form className={styles.form} onSubmit={(event) => void previewOutreach(event)}>
          <label className={styles.field}>
            <span>Audience</span>
            <select
              aria-label="Outreach audience"
              value={outreachSegmentId}
              onChange={(event) => onSegmentChange(event.currentTarget.value)}
            >
              <option value="">This contact</option>
              {selectedContactIds.length > 0 ? (
                <option value="__selected__">
                  Selected directory contacts ({selectedContactIds.length})
                </option>
              ) : null}
              {segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  Segment: {segment.name}
                </option>
              ))}
            </select>
          </label>
          {selectedContactIds.length > 0 ? (
            <label className={styles.field}>
              <span>Segment context (optional)</span>
              <select
                aria-label="Outreach segment context"
                value={outreachContextSegmentId}
                onChange={(event) => onContextSegmentChange(event.currentTarget.value)}
              >
                <option value="">No segment context</option>
                {segments.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className={styles.field}>
            <span>Event context (optional)</span>
            <select
              aria-label="Outreach event"
              value={outreachEventId}
              onChange={(event) => onEventChange(event.currentTarget.value)}
            >
              <option value="">No event</option>
              {events.map((event) => (
                <option value={event.id} key={event.id}>
                  {event.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Subject</span>
            <input
              value={outreachSubject}
              onChange={(event) => onSubjectChange(event.currentTarget.value)}
              required
            />
          </label>
          <label className={styles.field}>
            <span>Message</span>
            <textarea
              rows={5}
              value={outreachBody}
              onChange={(event) => onBodyChange(event.currentTarget.value)}
              required
            />
            <small className={styles.muted}>
              Use <code>{"{{first_name}}"}</code> for safe per-contact personalization.
            </small>
          </label>
          <button className={styles.primaryButton} type="submit" disabled={busy}>
            {busy ? "Preparing…" : "Preview personalized outreach"}
          </button>
        </form>
        {outreachPreview ? (
          <div className={styles.previewBox}>
            <h3>Outreach preview</h3>
            <p>
              <strong>{outreachPreview.count}</strong> recipient
              {outreachPreview.count === 1 ? "" : "s"} selected for queueing.
            </p>
            {outreachPreview.eventId ? <p>Event context: {outreachPreview.eventId}</p> : null}
            {outreachPreview.segmentId ? <p>Segment context: {outreachPreview.segmentId}</p> : null}
            {outreachHasUnknownTags ? (
              <p className={styles.error} role="alert">
                Queueing is blocked because one or more recipients have unknown merge tags.
              </p>
            ) : null}
            <div className={styles.timeline}>
              {outreachPreview.recipients.map((recipient) => (
                <article key={recipient.contactId}>
                  <h4>
                    {recipient.displayName} · {recipient.email}
                  </h4>
                  <p>
                    <strong>Subject:</strong> {recipient.subject}
                  </p>
                  <pre>{recipient.body}</pre>
                  {recipient.unknownTags.length > 0 ? (
                    <p className={styles.error}>
                      Unknown merge tags: {recipient.unknownTags.join(", ")}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
            <button
              className={styles.primaryButton}
              aria-label="Queue outreach for delivery"
              type="button"
              onClick={() => onSendOutreach?.()}
              disabled={
                busy ||
                outreachPreview.count === 0 ||
                outreachHasUnknownTags ||
                onSendOutreach === undefined
              }
            >
              {busy
                ? "Queueing…"
                : `Queue outreach for delivery to ${outreachPreview.count} contact${outreachPreview.count === 1 ? "" : "s"}`}
            </button>
          </div>
        ) : null}
        {outreachResults.length > 0 ? (
          <section className={styles.previewBox} aria-labelledby="crm-outreach-result-title">
            <h3 id="crm-outreach-result-title">Outreach queue result</h3>
            <p className={styles.resultCount}>
              {outreachResults.reduce((count, result) => count + result.sentCount, 0)} sent ·{" "}
              {outreachResults.reduce((count, result) => count + result.queuedCount, 0)} queued ·{" "}
              {outreachResults.reduce((count, result) => count + result.failedCount, 0)} failed
            </p>
            <ol className={styles.historyList}>
              {outreachResults.map((result) => (
                <li key={result.id}>
                  <strong>
                    {result.recipientEmail}: {result.status}
                  </strong>
                  <small>
                    queue {result.id}
                    {result.terminal ? " · terminal" : " · awaiting delivery"}
                    {result.failureReason ? ` · ${result.failureReason}` : ""}
                  </small>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </Card>
    </section>
  );
}

interface CrmWorkspaceDirectoryExtrasProps {
  readonly contacts: readonly CrmContact[];
  readonly segments: readonly CrmSegment[];
  readonly events: readonly CrmEvent[];
  readonly analytics: CrmAnalytics | null;
  readonly busy: boolean;
  readonly currentRules: readonly CrmSegmentRule[];
  readonly onCreateSegment:
    | ((input: {
        name: string;
        description: string;
        rules: readonly CrmSegmentRule[];
      }) => Promise<void>)
    | undefined;
  readonly onSelectSegment: ((segmentId: string) => void) | undefined;
  readonly onMovePipeline: ((contactId: string, stage: CrmPipelineStage) => void) | undefined;
  readonly onSelectContact: (contactId: string) => void;
  readonly onEnrollPipeline:
    | ((input: {
        contactId: string;
        stage: CrmPipelineStage;
        score: string;
        rationale: string;
      }) => Promise<void>)
    | undefined;
  readonly onAnalyticsEventDrillThrough: ((eventId: string) => void) | undefined;
}

export function CrmWorkspaceDirectoryExtras({
  contacts,
  segments,
  events,
  analytics,
  busy,
  currentRules,
  onCreateSegment,
  onSelectSegment,
  onMovePipeline,
  onSelectContact,
  onEnrollPipeline,
  onAnalyticsEventDrillThrough,
}: CrmWorkspaceDirectoryExtrasProps) {
  return (
    <>
      <SegmentManager
        segments={segments}
        busy={busy}
        currentRules={currentRules}
        onCreate={onCreateSegment ?? (async () => undefined)}
        onSelect={onSelectSegment ?? (() => undefined)}
      />
      <PipelineBoard
        contacts={contacts}
        onMove={onMovePipeline ?? (() => undefined)}
        onSelect={(id) => onSelectContact(id)}
        onEnroll={onEnrollPipeline ?? (async () => undefined)}
      />
      {analytics ? (
        <section id="crm-analytics" tabIndex={-1} aria-label="CRM analytics panel">
          <AnalyticsPanel
            analytics={analytics}
            events={events}
            onEventDrillThrough={onAnalyticsEventDrillThrough ?? (() => undefined)}
          />
        </section>
      ) : null}
    </>
  );
}
