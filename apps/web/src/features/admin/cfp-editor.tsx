"use client";

import type { FormEvent, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CfpApiError,
  type CfpEventConfiguration,
  type CfpFormConfiguration,
  createCfpApi,
} from "../cfp/api";
import { createEventSettingsApi } from "../settings/api";
import { getCfpStepRoute } from "../cfp/routes";
import styles from "./cfp-editor.module.css";
import { CfpEditorMasthead, CfpSectionNavigation, CfpStepActions } from "./cfp-editor-chrome";
import {
  type CfpCondition,
  type CfpConfiguration,
  type CfpEditorProps,
  type CfpFormField,
  cfpMinimumDate,
  closeCfpNowConfiguration,
  configurationFromServer,
  createEmptyCfpConfiguration,
  cfpRuleFields,
  fieldKeyForRuleField,
  CANONICAL_TITLE_FIELD_KEY,
  fieldKeyFromLabel,
  fieldOptionValues,
  firstRuleCondition,
  isCfpCloseDatePast,
  loadCfpEditorConfiguration,
  ORGANIZER_SCROLL_CONTAINER_ID,
  persistCfpConfiguration,
  removeCfpEditorField,
  resolveCfpEditorStepIndex,
  ruleMatches,
  SECTION_LINKS,
  summarizeRule,
  updateCfpEditorField,
  updateCfpShowWhenCondition,
  validateCfpDateRange,
} from "./cfp-editor-model";
import {
  CfpEditorSections,
  CfpEventIdentityFields,
  CfpPastCloseConfirmation,
} from "./cfp-editor-sections";
import type { EventDateSelectionValue } from "./event-date-picker";
import { useOrganizerEventId } from "./organizer-event-workspace";

export { CfpEventIdentityFields, CfpPastCloseConfirmation };

type CfpSectionId = (typeof SECTION_LINKS)[number]["id"];
type CfpSaveState = "idle" | "saving" | "saved" | "error";
type CfpTaxonomyKey = "formats" | "levels" | "tags" | "tracks";

function cfpEditorErrorMessage(error: unknown): string {
  if (!(error instanceof CfpApiError) || !Array.isArray(error.details)) {
    return error instanceof Error ? error.message : "The CFP configuration could not be saved.";
  }
  const firstIssue = error.details.find(
    (issue): issue is { path?: unknown; message: string } =>
      typeof issue === "object" &&
      issue !== null &&
      "message" in issue &&
      typeof issue.message === "string",
  );
  if (firstIssue === undefined) return error.message;
  const path = Array.isArray(firstIssue.path)
    ? firstIssue.path
        .filter((segment) => typeof segment === "string" || typeof segment === "number")
        .join(".")
    : "";
  return `${error.message} ${path ? `${path}: ` : ""}${firstIssue.message}`;
}
type CfpCanonicalTaxonomy = Readonly<Record<CfpTaxonomyKey, readonly string[]>>;
type CfpPreviewSelectionKey = "format" | "track" | "level";

interface CfpPreviewSelections {
  readonly track: string;
  readonly format: string;
  readonly level: string;
}

interface CfpPreviewSubmissionResult {
  readonly confirmationBody: string;
  readonly confirmationTitle: string;
  readonly successMessage: string;
}

interface CfpEditorController {
  readonly eventId: string;
  readonly configuration: CfpConfiguration;
  readonly activeSection: CfpSectionId;
  readonly previewResultRef: RefObject<HTMLElement | null>;
  readonly publishDialogOpen: boolean;
  readonly saveState: CfpSaveState;
  readonly saveError: string | null;
  readonly pastCloseAcknowledged: boolean;
  readonly previewResponses: Readonly<Record<string, string>>;
  readonly previewSelections: CfpPreviewSelections;
  readonly previewView: "application" | "confirmation";
  readonly configurationLoadState: "loading" | "ready" | "error";
  readonly resolvedOrganizationId: string;
  readonly canonicalTaxonomy: CfpCanonicalTaxonomy | null;
  readonly taxonomyManageHref: string;
  readonly minimumCfpDate: string;
  readonly maximumCfpDate: string | undefined;
  readonly dateValidationError: string | null;
  readonly historicalCfpDates: readonly string[];
  readonly closeDatePast: boolean;
  readonly effectiveClosed: boolean;
  readonly publicRoute: string | null;
  readonly publicRoutePath: string | null;
  readonly publicLinkAvailable: boolean;
  readonly visibleFields: readonly CfpFormField[];
  readonly ruleFields: readonly CfpFormField[];
  readonly selectedRuleFieldKey: string;
  readonly selectedRuleOptions: readonly string[];
  readonly ruleSummary: string;
  readonly primaryCondition: CfpCondition;
  readonly activeSectionIndex: number;
  readonly submittedPreviewResult: CfpPreviewSubmissionResult | null;
  readonly publicLinkCopied: boolean;
  readonly onCopyPublicLink: () => Promise<void>;
  readonly onSectionChange: (sectionId: CfpSectionId) => void;
  readonly onSave: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onRequestPublish: () => Promise<void>;
  readonly onCloseNow: () => Promise<void>;
  readonly onPublishDialogChange: (open: boolean) => void;
  readonly onConfirmPublish: () => void;
  readonly onConfigurationChange: <K extends keyof CfpConfiguration>(
    key: K,
    value: CfpConfiguration[K],
  ) => void;
  readonly onDateRangeChange: (selection: EventDateSelectionValue) => void;
  readonly onPastCloseAcknowledgedChange: (checked: boolean) => void;
  readonly onTaxonomyChange: (key: CfpTaxonomyKey, values: string[]) => void;
  readonly onHelpfulLinkChange: (
    index: number,
    patch: Partial<{ label: string; href: string }>,
  ) => void;
  readonly onFieldChange: (fieldId: string, patch: Partial<CfpFormField>) => void;
  readonly onAddField: () => void;
  readonly onRemoveField: (fieldId: string) => void;
  readonly onParticipantFieldRequiredChange: (fieldId: string, required: boolean) => void;
  readonly onPrimaryConditionChange: (
    patch: Partial<Omit<CfpCondition, "type" | "operator">>,
  ) => void;
  readonly onRuleTargetChange: (target: string) => void;
  readonly configuredFieldForKey: (key: string) => CfpFormField | undefined;
  readonly onPreviewInput: () => void;
  readonly onPreviewResponseChange: (fieldId: string, value: string) => void;
  readonly onPreviewSelectionChange: (key: CfpPreviewSelectionKey, value: string) => void;
  readonly onPreviewSubmit: () => void;
  readonly onPreviewViewChange: (view: "application" | "confirmation") => void;
}

function useCfpEditorController({
  eventId: fallbackEventId,
  organizationId,
  formId,
  api: providedApi,
}: CfpEditorProps): CfpEditorController {
  const eventId = useOrganizerEventId(fallbackEventId);
  const [configuration, setConfiguration] = useState<CfpConfiguration>(() =>
    createEmptyCfpConfiguration(eventId),
  );
  const api = useMemo(() => providedApi ?? createCfpApi(""), [providedApi]);
  const [activeSection, setActiveSection] = useState<CfpSectionId>("event-details");
  const previewResultRef = useRef<HTMLElement | null>(null);
  const saveInFlightRef = useRef(false);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const preparedPublishVersionRef = useRef<number | null>(null);
  const [saveState, setSaveState] = useState<CfpSaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [historicalCfpDates, setHistoricalCfpDates] = useState<readonly string[]>([]);
  const [pastCloseAcknowledged, setPastCloseAcknowledged] = useState(false);
  const [previewResponses, setPreviewResponses] = useState<Record<string, string>>({});
  const [previewSelections, setPreviewSelections] = useState<CfpPreviewSelections>({
    track: "Community systems",
    format: "Workshop · 60 minutes",
    level: "Introductory",
  });
  const [previewSubmissionKey, setPreviewSubmissionKey] = useState<string | null>(null);
  const [previewView, setPreviewView] = useState<"application" | "confirmation">("application");
  const [publicLinkCopied, setPublicLinkCopied] = useState(false);
  const [configurationLoadState, setConfigurationLoadState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [canonicalTaxonomy, setCanonicalTaxonomy] = useState<CfpCanonicalTaxonomy | null>(null);

  const resolvedOrganizationId = organizationId.trim();
  const requestedFormId = formId?.trim() || undefined;
  const resolvedFormId = requestedFormId ?? configuration.id;
  const cfpNow = new Date();
  const minimumCfpDate = cfpMinimumDate(cfpNow, configuration.timezone);
  const maximumCfpDate =
    configuration.eventStartsAt === undefined
      ? undefined
      : cfpMinimumDate(new Date(configuration.eventStartsAt), configuration.timezone);
  const dateValidationError = validateCfpDateRange(
    configuration.opensAt,
    configuration.closesAt,
    configuration.timezone,
    configuration.persistedOpensAt,
    configuration.persistedClosesAt,
  );
  const closeDatePast = isCfpCloseDatePast(
    configuration.closesAt,
    cfpNow,
    configuration.timezone,
    configuration.persistedClosesAt,
  );
  const effectiveClosed = configuration.status === "closed" || closeDatePast;

  useEffect(() => {
    if (!resolvedOrganizationId) {
      setConfigurationLoadState("error");
      setSaveState("error");
      return;
    }
    let active = true;
    setConfigurationLoadState("loading");
    setSaveError(null);
    void loadCfpEditorConfiguration(api, {
      organizationId: resolvedOrganizationId,
      eventId,
      ...(requestedFormId === undefined ? {} : { formId: requestedFormId }),
    })
      .then(({ event: eventConfiguration, form: formConfiguration }) => {
        if (!active) return;
        const loadedOpensAt = cfpMinimumDate(
          new Date(eventConfiguration.opensAt),
          eventConfiguration.timezone,
        );
        const loadedClosesAt = cfpMinimumDate(
          new Date(eventConfiguration.closesAt),
          eventConfiguration.timezone,
        );
        setHistoricalCfpDates([loadedOpensAt, loadedClosesAt]);
        if (formConfiguration !== undefined) {
          setConfiguration((current) =>
            configurationFromServer(current, eventConfiguration, formConfiguration),
          );
        } else {
          const newFormId = requestedFormId ?? `${eventId}-cfp`;
          setConfiguration((current) => {
            const { formVersion: _formVersion, ...withoutFormVersion } = current;
            return {
              ...withoutFormVersion,
              id: newFormId,
              status: "draft",
              eventVersion: eventConfiguration.version,
              eventName: eventConfiguration.name,
              slug: eventConfiguration.slug,
              timezone: eventConfiguration.timezone,
              ...(eventConfiguration.eventStartsAt === undefined
                ? {}
                : { eventStartsAt: eventConfiguration.eventStartsAt }),
              opensAt: loadedOpensAt,
              closesAt: loadedClosesAt,
              persistedOpensAt: eventConfiguration.opensAt,
              persistedClosesAt: eventConfiguration.closesAt,
            };
          });
        }
        setConfigurationLoadState("ready");
      })
      .catch((error: unknown) => {
        if (active) {
          setConfigurationLoadState("error");
          setSaveState("error");
          setSaveError(
            error instanceof Error ? error.message : "The CFP configuration could not be loaded.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [api, eventId, requestedFormId, resolvedOrganizationId]);
  useEffect(() => {
    if (!resolvedOrganizationId) return;
    let active = true;
    const settingsApi = createEventSettingsApi("", resolvedOrganizationId);
    void settingsApi
      .getWorkspace(eventId)
      .then((data) => {
        if (!active) return;
        const next: CfpCanonicalTaxonomy = {
          tracks: data.tracks.map(({ name }) => name),
          formats: data.formats.map(({ name }) => name),
          levels: data.levels.map(({ name }) => name),
          tags: data.tags.map(({ name }) => name),
        };
        setCanonicalTaxonomy(next);
        setConfiguration((current) => ({
          ...current,
          tracks: current.tracks.length === 0 ? [...next.tracks] : current.tracks,
          formats: current.formats.length === 0 ? [...next.formats] : current.formats,
          levels: current.levels.length === 0 ? [...next.levels] : current.levels,
          tags: current.tags.length === 0 ? [...next.tags] : current.tags,
        }));
      })
      .catch(() => {
        if (active) setCanonicalTaxonomy(null);
      });
    return () => {
      active = false;
    };
  }, [eventId, resolvedOrganizationId]);
  useEffect(() => {
    if (configurationLoadState !== "ready" || canonicalTaxonomy === null) return;
    setConfiguration((current) => {
      const next = {
        tracks: current.tracks.length === 0 ? [...canonicalTaxonomy.tracks] : current.tracks,
        formats: current.formats.length === 0 ? [...canonicalTaxonomy.formats] : current.formats,
        levels: current.levels.length === 0 ? [...canonicalTaxonomy.levels] : current.levels,
        tags: current.tags.length === 0 ? [...canonicalTaxonomy.tags] : current.tags,
      };
      return next.tracks === current.tracks &&
        next.formats === current.formats &&
        next.levels === current.levels &&
        next.tags === current.tags
        ? current
        : { ...current, ...next };
    });
  }, [canonicalTaxonomy, configurationLoadState]);

  function updateConfiguration<K extends keyof CfpConfiguration>(
    key: K,
    value: CfpConfiguration[K],
  ): void {
    setConfiguration((current) => ({ ...current, [key]: value }));
    setSaveState("idle");
    setSaveError(null);
    if (key === "closesAt") setPastCloseAcknowledged(false);
  }

  function updateCfpDateRange(selection: EventDateSelectionValue): void {
    setConfiguration((current) => ({
      ...current,
      opensAt: selection.startsAt.slice(0, 10),
      closesAt: selection.endsAt.slice(0, 10),
    }));
    setSaveState("idle");
    setSaveError(null);
    setPastCloseAcknowledged(false);
  }

  function updateField(fieldId: string, patch: Partial<CfpFormField>): void {
    setConfiguration((current) => updateCfpEditorField(current, fieldId, patch));
    setSaveState("idle");
  }

  function addField(): void {
    const id = `custom-field-${Date.now()}`;
    setConfiguration((current) => {
      const label = "New custom field";
      const generated = `${fieldKeyFromLabel(label)}-${current.fields.length + 1}`;
      const key =
        generated === CANONICAL_TITLE_FIELD_KEY
          ? `custom-field-${current.fields.length + 1}`
          : generated;
      return {
        ...current,
        fields: [
          ...current.fields,
          {
            id,
            key,
            label,
            type: "text",
            kind: "text",
            required: false,
            visible: true,
            placeholder: "",
            options: [],
          },
        ],
      };
    });
    setSaveState("idle");
  }

  function removeField(fieldId: string): void {
    setConfiguration((current) => removeCfpEditorField(current, fieldId));
    setSaveState("idle");
  }

  function updatePrimaryCondition(patch: Partial<Omit<CfpCondition, "type" | "operator">>): void {
    setConfiguration((current) => {
      if (patch.field?.trim() !== "") return updateCfpShowWhenCondition(current, patch);
      const { ruleTargetField: _ruleTargetField, ...configurationWithoutTarget } = current;
      return {
        ...configurationWithoutTarget,
        rule: { type: "condition", field: "", operator: "is", value: "" },
        ruleAction: "",
      };
    });
    setSaveState("idle");
    setSaveError(null);
  }

  function updateHelpfulLink(index: number, patch: Partial<{ label: string; href: string }>): void {
    setConfiguration((current) => ({
      ...current,
      helpfulLinks: current.helpfulLinks.map((link, linkIndex) =>
        linkIndex === index ? { ...link, ...patch } : link,
      ),
    }));
    setSaveState("idle");
  }

  function replaceTaxonomyOptions(key: CfpTaxonomyKey, values: string[]): void {
    setConfiguration((current) => ({ ...current, [key]: values }));
    setSaveState("idle");
  }

  function updatePastCloseAcknowledged(checked: boolean): void {
    setPastCloseAcknowledged(checked);
    setSaveError(null);
    setSaveState("idle");
  }

  function updateParticipantFieldRequired(fieldId: string, required: boolean): void {
    setConfiguration((current) => ({
      ...current,
      ...(current.participantFields
        ? {
            participantFields: current.participantFields.map((field) =>
              field.id === fieldId ? { ...field, required } : field,
            ),
          }
        : {}),
    }));
  }

  function updateRuleTarget(target: string): void {
    setConfiguration((current) => {
      if (!target.trim()) {
        return {
          ...current,
          rule: { type: "condition", field: "", operator: "is", value: "" },
          ruleAction: "",
          ruleTargetField: undefined,
        };
      }
      const selectedTarget = current.fields.find((field) => (field.key ?? field.id) === target);
      return {
        ...current,
        ruleTargetField: target,
        ruleAction: selectedTarget ? `show ${selectedTarget.label}` : current.ruleAction,
      };
    });
    setSaveState("idle");
    setSaveError(null);
  }

  function handlePreviewInput(): void {
    setPreviewSubmissionKey(null);
  }

  function handlePreviewResponseChange(fieldId: string, value: string): void {
    setPreviewResponses((current) => ({ ...current, [fieldId]: value }));
  }

  function handlePreviewSelectionChange(key: CfpPreviewSelectionKey, value: string): void {
    setPreviewSelections((current) => ({ ...current, [key]: value }));
  }

  function handlePreviewViewChange(view: "application" | "confirmation"): void {
    setPreviewView(view);
  }

  function focusFirstInvalidControl(): boolean {
    if (typeof document === "undefined") return true;
    const form = document.getElementById("cfp-editor-form");
    if (!(form instanceof HTMLFormElement) || form.checkValidity()) return true;

    const invalidControl = Array.from(
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input, select, textarea",
      ),
    ).find((control) => !control.disabled && !control.checkValidity());
    if (!invalidControl) return false;

    const sectionId = invalidControl.closest("section")?.id;
    const section = SECTION_LINKS.find((candidate) => candidate.id === sectionId);
    if (section) setActiveSection(section.id);
    setSaveState("error");
    setSaveError("Complete the highlighted field before publishing.");
    window.requestAnimationFrame(() => {
      invalidControl.focus();
      invalidControl.reportValidity();
    });
    return false;
  }

  async function saveConfiguration(options?: { readonly validateForPublish?: boolean }): Promise<{
    event: CfpEventConfiguration;
    form: CfpFormConfiguration;
  } | null> {
    if (saveInFlightRef.current) return null;
    setSaveError(null);
    if (options?.validateForPublish === true && !focusFirstInvalidControl()) return null;
    if (!resolvedOrganizationId || !resolvedFormId) {
      setSaveState("error");
      setSaveError("An organizer organization and form are required before saving.");
      return null;
    }
    if (dateValidationError !== null) {
      setSaveState("error");
      setSaveError(dateValidationError);
      return null;
    }
    if (closeDatePast && !pastCloseAcknowledged) {
      setSaveState("error");
      setSaveError("A past close date requires explicit organizer confirmation before saving.");
      return null;
    }
    try {
      saveInFlightRef.current = true;
      setSaveState("saving");
      const saved = await persistCfpConfiguration(api, {
        configuration,
        organizationId: resolvedOrganizationId,
        eventId,
        formId: resolvedFormId,
      });
      setConfiguration((current) => configurationFromServer(current, saved.event, saved.form));
      setHistoricalCfpDates([
        cfpMinimumDate(new Date(saved.event.opensAt), saved.event.timezone),
        cfpMinimumDate(new Date(saved.event.closesAt), saved.event.timezone),
      ]);
      setSaveState("saved");
      return saved;
    } catch (error) {
      setSaveState("error");
      setSaveError(cfpEditorErrorMessage(error));
      return null;
    } finally {
      saveInFlightRef.current = false;
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await saveConfiguration();
  }

  async function requestPublish(): Promise<void> {
    if (saveInFlightRef.current) return;
    setSaveError(null);
    const saved = await saveConfiguration({ validateForPublish: true });
    if (saved === null) return;
    preparedPublishVersionRef.current = saved.form.version;
    setPublishDialogOpen(true);
  }

  async function handleCloseNow(): Promise<void> {
    setSaveError(null);
    if (!resolvedOrganizationId || !resolvedFormId || configuration.formVersion === undefined) {
      setSaveState("error");
      setSaveError("Save the published CFP configuration before closing it.");
      return;
    }
    if (configuration.status !== "published") {
      setSaveState("error");
      setSaveError("Publish the CFP form before closing it.");
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Close CFP now? This is destructive: new drafts and edits will be locked immediately. Existing submissions remain visible in the speaker dashboard.",
      )
    ) {
      return;
    }

    let closingConfiguration: CfpConfiguration;
    try {
      closingConfiguration = closeCfpNowConfiguration(configuration);
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "The CFP could not be closed.");
      return;
    }

    try {
      setSaveState("saving");
      const { event: savedEvent, form: savedForm } = await persistCfpConfiguration(api, {
        configuration: closingConfiguration,
        organizationId: resolvedOrganizationId,
        eventId,
        formId: resolvedFormId,
      });
      setConfiguration((current) => configurationFromServer(current, savedEvent, savedForm));
      setHistoricalCfpDates([
        cfpMinimumDate(new Date(savedEvent.opensAt), savedEvent.timezone),
        cfpMinimumDate(new Date(savedEvent.closesAt), savedEvent.timezone),
      ]);
      setSaveState("saved");
      setSaveError(null);
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "The CFP could not be closed.");
    }
  }

  async function handlePublish(expectedVersion: number | null): Promise<void> {
    setSaveError(null);
    if (!resolvedOrganizationId || !resolvedFormId || expectedVersion === null) {
      setSaveState("error");
      setSaveError("The CFP configuration must be saved before publishing.");
      return;
    }
    try {
      setSaveState("saving");
      const published = await api.publishForm({
        organizationId: resolvedOrganizationId,
        eventId,
        formId: resolvedFormId,
        expectedVersion,
      });
      setConfiguration((current) => ({
        ...current,
        id: published.id,
        status: published.status,
        formVersion: published.version,
      }));
      preparedPublishVersionRef.current = null;
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "The CFP form could not be published.");
    }
  }

  function openSection(id: CfpSectionId): void {
    const currentIndex = SECTION_LINKS.findIndex((section) => section.id === activeSection);
    const requestedIndex = SECTION_LINKS.findIndex((section) => section.id === id);
    const currentSection = document.getElementById(activeSection);
    const invalidControl = Array.from(
      currentSection?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input, select, textarea",
      ) ?? [],
    ).find((control) => !control.disabled && !control.checkValidity());
    const currentDateError = activeSection === "event-details" ? dateValidationError : null;
    const nextIndex = resolveCfpEditorStepIndex({
      currentIndex,
      requestedIndex,
      currentStepValid: invalidControl === undefined && currentDateError === null,
    });
    if (nextIndex === currentIndex && requestedIndex > currentIndex) {
      if (invalidControl !== undefined) {
        invalidControl.reportValidity();
      } else if (currentDateError !== null) {
        setSaveState("error");
        setSaveError(currentDateError);
      }
      return;
    }
    setActiveSection(SECTION_LINKS[nextIndex]?.id ?? "event-details");
    const scrollContainer = document.getElementById(ORGANIZER_SCROLL_CONTAINER_ID);
    if (scrollContainer === null) {
      window.scrollTo({ top: 0, behavior: "auto" });
    } else {
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function handlePreviewSubmit(): void {
    setPreviewSubmissionKey(previewStateKey);
    setPreviewView("confirmation");
    window.requestAnimationFrame(() => previewResultRef.current?.focus());
  }

  const configuredFieldForKey = (key: string) =>
    configuration.fields.find((field) => (field.key ?? field.id).toLocaleLowerCase() === key);
  const previewValueForKey = (key: CfpPreviewSelectionKey): string => {
    const configuredField = configuredFieldForKey(key);
    return configuredField === undefined
      ? previewSelections[key]
      : (previewResponses[configuredField.id] ?? "");
  };
  const previewRuleMatches = ruleMatches(firstRuleCondition(configuration.rule), {
    format: previewValueForKey("format"),
    track: previewValueForKey("track"),
    level: previewValueForKey("level"),
  });
  const visibleFields = configuration.fields.filter(
    (field) =>
      field.visible &&
      ((field.key ?? field.id) !== configuration.ruleTargetField || previewRuleMatches),
  );
  const ruleSummary = summarizeRule(configuration.rule);
  const primaryCondition = firstRuleCondition(configuration.rule);
  const ruleFields = cfpRuleFields(configuration);
  const selectedRuleFieldKey = fieldKeyForRuleField(primaryCondition.field, ruleFields);
  const selectedRuleField = ruleFields.find((field) => field.key === selectedRuleFieldKey);
  const selectedRuleOptions = fieldOptionValues(selectedRuleField);
  const activeSectionIndex = Math.max(
    0,
    SECTION_LINKS.findIndex((section) => section.id === activeSection),
  );
  const previewStateKey = JSON.stringify({ configuration, previewResponses });
  const submittedPreviewResult =
    previewSubmissionKey === previewStateKey
      ? {
          confirmationBody: configuration.confirmationBody,
          confirmationTitle: configuration.confirmationTitle,
          successMessage: configuration.successMessage,
        }
      : null;
  const publicRoute = configuration.slug
    ? getCfpStepRoute(resolvedOrganizationId, configuration.slug, "welcome")
    : null;
  const publicRoutePath = publicRoute
    ? `/cfp/organizations/${resolvedOrganizationId}/events/${configuration.slug}`
    : null;
  const publicLinkAvailable = publicRoute !== null && configuration.status === "published";

  async function copyPublicLink(): Promise<void> {
    if (
      !publicLinkAvailable ||
      !publicRoute ||
      typeof navigator === "undefined" ||
      !navigator.clipboard
    ) {
      return;
    }
    const publicUrl = new URL(publicRoute, window.location.origin).toString();
    await navigator.clipboard.writeText(publicUrl);
    setPublicLinkCopied(true);
    window.setTimeout(() => setPublicLinkCopied(false), 1800);
  }

  function onPublishDialogChange(open: boolean): void {
    setPublishDialogOpen(open);
    if (!open) preparedPublishVersionRef.current = null;
  }

  function onConfirmPublish(): void {
    const expectedVersion = preparedPublishVersionRef.current;
    preparedPublishVersionRef.current = null;
    setPublishDialogOpen(false);
    void handlePublish(expectedVersion);
  }

  return {
    eventId,
    configuration,
    activeSection,
    previewResultRef,
    publishDialogOpen,
    saveState,
    saveError,
    pastCloseAcknowledged,
    previewResponses,
    previewSelections,
    previewView,
    configurationLoadState,
    resolvedOrganizationId,
    canonicalTaxonomy,
    taxonomyManageHref: `/admin/organizations/${encodeURIComponent(resolvedOrganizationId)}/events/${encodeURIComponent(eventId)}/settings/classification`,
    minimumCfpDate,
    maximumCfpDate,
    dateValidationError,
    historicalCfpDates,
    closeDatePast,
    effectiveClosed,
    publicRoute,
    publicRoutePath,
    publicLinkAvailable,
    visibleFields,
    ruleFields,
    selectedRuleFieldKey,
    selectedRuleOptions,
    ruleSummary,
    primaryCondition,
    activeSectionIndex,
    submittedPreviewResult,
    publicLinkCopied,
    onCopyPublicLink: copyPublicLink,
    onSectionChange: openSection,
    onSave: handleSave,
    onRequestPublish: requestPublish,
    onCloseNow: handleCloseNow,
    onPublishDialogChange,
    onConfirmPublish,
    onConfigurationChange: updateConfiguration,
    onDateRangeChange: updateCfpDateRange,
    onPastCloseAcknowledgedChange: updatePastCloseAcknowledged,
    onTaxonomyChange: replaceTaxonomyOptions,
    onHelpfulLinkChange: updateHelpfulLink,
    onFieldChange: updateField,
    onAddField: addField,
    onRemoveField: removeField,
    onParticipantFieldRequiredChange: updateParticipantFieldRequired,
    onPrimaryConditionChange: updatePrimaryCondition,
    onRuleTargetChange: updateRuleTarget,
    configuredFieldForKey,
    onPreviewInput: handlePreviewInput,
    onPreviewResponseChange: handlePreviewResponseChange,
    onPreviewSelectionChange: handlePreviewSelectionChange,
    onPreviewSubmit: handlePreviewSubmit,
    onPreviewViewChange: handlePreviewViewChange,
  };
}

export function CfpEditor(props: CfpEditorProps) {
  const controller = useCfpEditorController(props);
  if (!controller.resolvedOrganizationId) {
    return (
      <div className={styles.viewport}>
        <section className={styles.pageHeader} role="alert">
          <div>
            <p className={styles.eyebrow}>Organizer workspace</p>
            <h1>Organization scope required</h1>
            <p className={styles.pageIntro}>
              Open this editor from an organization-qualified event route.
            </p>
          </div>
        </section>
      </div>
    );
  }

  if (controller.configurationLoadState !== "ready") {
    return (
      <div className={styles.viewport}>
        <section
          className={styles.pageHeader}
          role={controller.configurationLoadState === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <div>
            <p className={styles.eyebrow}>Organizer workspace / {controller.eventId}</p>
            <h1>
              {controller.configurationLoadState === "error"
                ? "Unable to load CFP configuration"
                : "Loading CFP configuration"}
            </h1>
            <p className={styles.pageIntro}>
              {controller.configurationLoadState === "error"
                ? (controller.saveError ?? "The event and CFP form could not be loaded.")
                : "Loading the authoritative event and form configuration."}
            </p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.viewport}>
      <CfpEditorMasthead
        status={
          controller.configuration.status === "published"
            ? "Published"
            : controller.configuration.status === "closed"
              ? "Closed"
              : "Draft"
        }
        metadata={[
          controller.configuration.eventName,
          `${controller.configuration.opensAt} – ${controller.configuration.closesAt}`,
          controller.configuration.timezone,
          `${controller.visibleFields.length} public fields`,
          controller.configuration.adminNotifications ? "Notifications on" : "Notifications off",
        ]}
        error={controller.saveState === "error" ? controller.saveError : null}
        actions={
          <>
            {controller.publicLinkAvailable && controller.publicRoute ? (
              <>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={() => void controller.onCopyPublicLink()}
                >
                  {controller.publicLinkCopied ? "Copied" : "Copy public link"}
                </button>
                <a className={styles.secondaryButton} href={controller.publicRoute}>
                  View public form
                </a>
                <span className="sr-only" aria-live="polite">
                  {controller.publicLinkCopied ? "Public CFP link copied to clipboard." : ""}
                </span>
              </>
            ) : null}
            <button
              className={styles.primaryButton}
              type="submit"
              form="cfp-editor-form"
              disabled={controller.saveState === "saving"}
            >
              {controller.saveState === "saving" ? "Saving…" : "Save changes"}
            </button>
          </>
        }
      />
      <CfpSectionNavigation
        activeSection={controller.activeSection}
        sections={SECTION_LINKS}
        onChange={(sectionId) => controller.onSectionChange(sectionId as CfpSectionId)}
      />
      <CfpEditorSections
        activeSection={controller.activeSection}
        closeDatePast={controller.closeDatePast}
        canonicalTaxonomy={controller.canonicalTaxonomy}
        taxonomyManageHref={controller.taxonomyManageHref}
        configuration={controller.configuration}
        dateValidationError={controller.dateValidationError}
        effectiveClosed={controller.effectiveClosed}
        minimumCfpDate={controller.minimumCfpDate}
        maximumCfpDate={controller.maximumCfpDate}
        pastCloseAcknowledged={controller.pastCloseAcknowledged}
        historicalCfpDates={controller.historicalCfpDates}
        previewResponses={controller.previewResponses}
        previewResultRef={controller.previewResultRef}
        previewSelections={controller.previewSelections}
        previewView={controller.previewView}
        primaryCondition={controller.primaryCondition}
        publicLinkAvailable={controller.publicLinkAvailable}
        publicRoute={controller.publicRoute}
        publicRoutePath={controller.publicRoutePath}
        ruleFields={controller.ruleFields}
        ruleSummary={controller.ruleSummary}
        saveState={controller.saveState}
        selectedRuleFieldKey={controller.selectedRuleFieldKey}
        selectedRuleOptions={controller.selectedRuleOptions}
        submittedPreviewResult={controller.submittedPreviewResult}
        visibleFields={controller.visibleFields}
        onAddField={controller.onAddField}
        onCloseNow={() => void controller.onCloseNow()}
        onConfigurationChange={controller.onConfigurationChange}
        onDateRangeChange={controller.onDateRangeChange}
        onFieldChange={controller.onFieldChange}
        onHelpfulLinkChange={controller.onHelpfulLinkChange}
        onParticipantFieldRequiredChange={controller.onParticipantFieldRequiredChange}
        onPastCloseAcknowledgedChange={controller.onPastCloseAcknowledgedChange}
        onPreviewInput={controller.onPreviewInput}
        onPreviewResponseChange={controller.onPreviewResponseChange}
        onPreviewSelectionChange={controller.onPreviewSelectionChange}
        onPreviewSubmit={controller.onPreviewSubmit}
        onPreviewViewChange={controller.onPreviewViewChange}
        onPrimaryConditionChange={controller.onPrimaryConditionChange}
        onRemoveField={controller.onRemoveField}
        onRuleTargetChange={controller.onRuleTargetChange}
        configuredFieldForKey={controller.configuredFieldForKey}
        onSave={controller.onSave}
        onTaxonomyChange={controller.onTaxonomyChange}
      />

      <CfpStepActions
        activeSection={controller.activeSection}
        busy={controller.saveState === "saving"}
        sections={SECTION_LINKS}
        saveStatus={
          controller.saveState === "saved"
            ? "All changes saved"
            : controller.saveState === "saving"
              ? "Saving changes…"
              : controller.saveState === "error"
                ? "Save failed"
                : "Changes save when you choose Save changes"
        }
        onBack={() =>
          controller.onSectionChange(
            SECTION_LINKS[controller.activeSectionIndex - 1]?.id ?? "event-details",
          )
        }
        onNext={() => {
          const nextSection = SECTION_LINKS[controller.activeSectionIndex + 1];
          if (nextSection !== undefined) controller.onSectionChange(nextSection.id);
        }}
        onFinish={() => void controller.onRequestPublish()}
      />
      <AlertDialog
        open={controller.publishDialogOpen}
        onOpenChange={controller.onPublishDialogChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish this CFP form?</AlertDialogTitle>
            <AlertDialogDescription>
              Publishing makes the saved CFP version available to applicants. Confirm only after
              reviewing the form and its dates.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={controller.saveState === "saving"}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={controller.saveState === "saving"}
              onClick={controller.onConfirmPublish}
            >
              Publish form
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
