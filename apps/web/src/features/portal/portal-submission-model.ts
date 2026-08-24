import type { CfpSubmissionPointerIdentity } from "../cfp/draft-persistence";
import { getCfpStepRoute } from "../cfp/routes";
import { portalSubmissionEditTarget, portalSubmissionIdsMatch } from "./model";
import type { PortalContext, PortalSubmission } from "./types";

export function canonicalPortalSubmissionId(id: string): string {
  const normalized = id.trim();
  const prefix = "speaker-submission:";
  return normalized.toLocaleLowerCase().startsWith(prefix)
    ? normalized.slice(prefix.length).trim()
    : normalized;
}

const acronyms = new Set(["ai", "api", "cfp", "ci", "llm", "qa", "ui", "ux"]);
const minorWords = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function isUuidReference(reference: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    reference.trim(),
  );
}

function humanizeReference(reference: string): string {
  const marker = /(?:^|[-_/:])submission[-_/:]/iu.exec(reference);
  const source =
    marker?.index === undefined ? reference : reference.slice(marker.index + marker[0].length);
  const words = source
    .replace(/[-_]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return "No title";
  return words
    .map((word, index) => {
      const normalized = word.toLocaleLowerCase();
      if (acronyms.has(normalized)) return normalized.toLocaleUpperCase();
      if (index > 0 && minorWords.has(normalized)) return normalized;
      return `${normalized[0]?.toLocaleUpperCase() ?? ""}${normalized.slice(1)}`;
    })
    .join(" ");
}

function isMachineTitle(
  title: string,
  submission: Pick<PortalSubmission, "id" | "title">,
): boolean {
  const normalized = title.trim().toLocaleLowerCase();
  const references = [submission.id, canonicalPortalSubmissionId(submission.id)].map((value) =>
    value.toLocaleLowerCase(),
  );
  return (
    normalized.length === 0 ||
    references.includes(normalized) ||
    normalized.startsWith("speaker-submission:")
  );
}

export function portalSubmissionDisplayTitle(
  submission: Pick<PortalSubmission, "id" | "title">,
  equivalents: readonly Pick<PortalSubmission, "id" | "title">[] = [],
): string {
  const equivalent = equivalents.find(
    (candidate) =>
      portalSubmissionIdsMatch(candidate.id, submission.id) &&
      !isMachineTitle(candidate.title, candidate),
  );
  if (equivalent?.title.trim()) return equivalent.title.trim();
  if (!isMachineTitle(submission.title, submission) && submission.title.trim())
    return submission.title.trim();
  const machineTitle = submission.title.trim();
  if (machineTitle.toLocaleLowerCase().startsWith("speaker-submission:")) {
    const reference = machineTitle.slice("speaker-submission:".length).trim();
    if (
      reference.length > 0 &&
      !isUuidReference(reference) &&
      reference.toLocaleLowerCase() !==
        canonicalPortalSubmissionId(submission.id).toLocaleLowerCase()
    ) {
      return humanizeReference(reference);
    }
  }
  return "No title";
}

export interface PortalSubmissionActionTargets {
  editHref: string;
  newProposalHref: string;
  pointerKey: string;
  activePointerKey: string;
  newSubmissionIntentKey: string;
  identity: CfpSubmissionPointerIdentity;
}

export function portalSubmissionActionTargets(
  context: PortalContext | null,
  submission: PortalSubmission,
): PortalSubmissionActionTargets | null {
  const formId = submission.formId?.trim();
  if (context === null || formId === undefined || formId.length === 0) return null;
  const closeAt = submission.closeAt?.trim();
  if (closeAt) {
    const closeTime = Date.parse(closeAt);
    if (!Number.isFinite(closeTime) || closeTime <= Date.now()) return null;
  }
  const editTarget = portalSubmissionEditTarget(context, { ...submission, formId });
  if (editTarget === null) return null;
  const eventSlug = context.slug?.trim() || context.eventId.trim();
  const organizationId = context.organizationId?.trim() || context.id.split(":")[1]?.trim() || "";
  if (!eventSlug || !organizationId) return null;
  return {
    editHref: editTarget.href,
    newProposalHref: getCfpStepRoute(organizationId, eventSlug, "welcome"),
    pointerKey: editTarget.pointerKey,
    activePointerKey: editTarget.activePointerKey,
    newSubmissionIntentKey: editTarget.newSubmissionIntentKey,
    identity: { organizationId, eventId: context.eventId, formId },
  };
}
