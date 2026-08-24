import { formatInstantInTimeZone, localDateInTimeZone } from "@eventloom/contracts";

interface ReviewEventTemporalContext {
  readonly timeZone: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export const reviewPlanClosesAtField = "plan-closes-at";

export function reviewRoundScheduleField(roundId: string): string {
  return `round:${roundId}:schedule`;
}

export function reviewTemporalDraftError(
  unresolvedFields: ReadonlySet<string>,
  roundIds: readonly string[] = [],
): string | null {
  const hasUnresolvedField =
    unresolvedFields.has(reviewPlanClosesAtField) ||
    roundIds.some((roundId) => unresolvedFields.has(reviewRoundScheduleField(roundId)));
  return hasUnresolvedField
    ? "Resolve the invalid or ambiguous review date and time before saving."
    : null;
}

export function reviewTemporalConstraints(
  event: ReviewEventTemporalContext,
  now = new Date(),
): Readonly<{ minimum: string; maximum: string }> {
  return {
    minimum: `${localDateInTimeZone(now.toISOString(), event.timeZone)}T00:00`,
    maximum: reviewLocalValue(event.endsAt, event.timeZone),
  };
}

export function reviewExtendsPastEventStart(
  boundaries: readonly (string | null | undefined)[],
  eventStartsAt: string,
): boolean {
  const startsAt = Date.parse(eventStartsAt);
  return boundaries.some((boundary) => boundary != null && Date.parse(boundary) > startsAt);
}

export function reviewLocalValue(instant: string, timeZone: string): string {
  return formatInstantInTimeZone(instant, timeZone).slice(0, 16);
}
