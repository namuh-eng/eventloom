import { describe, expect, it } from "vitest";
import {
  reviewExtendsPastEventStart,
  reviewRoundScheduleConstraints,
  reviewTemporalConstraints,
} from "./review-temporal-policy";

describe("review temporal policy", () => {
  it("uses event-local today and the exact event end as picker bounds", () => {
    expect(
      reviewTemporalConstraints(
        {
          timeZone: "America/Los_Angeles",
          startsAt: "2026-08-01T16:00:00.000Z",
          endsAt: "2026-08-31T23:30:00.000Z",
        },
        new Date("2026-08-16T02:00:00.000Z"),
      ),
    ).toEqual({
      minimum: "2026-08-15T00:00",
      maximum: "2026-08-31T16:30",
    });
  });
  it("allows a round to open before today while preserving the event-end cap", () => {
    const event = {
      timeZone: "America/Los_Angeles",
      startsAt: "2026-08-01T07:00:00.000Z",
      endsAt: "2027-10-16T06:59:00.000Z",
    };
    const today = new Date("2026-08-24T19:00:00.000Z");

    expect(reviewTemporalConstraints(event, today)).toEqual({
      minimum: "2026-08-24T00:00",
      maximum: "2027-10-15T23:59",
    });
    expect(reviewRoundScheduleConstraints(event)).toEqual({
      maximum: "2027-10-15T23:59",
    });
  });

  it("warns without blocking when review continues after event start", () => {
    const eventStartsAt = "2026-08-01T16:00:00.000Z";

    expect(
      reviewExtendsPastEventStart(
        ["2026-08-01T16:00:00.000Z", "2026-08-15T16:00:00.000Z"],
        eventStartsAt,
      ),
    ).toBe(true);
    expect(
      reviewExtendsPastEventStart(["2026-07-31T16:00:00.000Z", eventStartsAt], eventStartsAt),
    ).toBe(false);
  });
});
