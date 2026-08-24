import { describe, expect, it } from "vitest";
import { reviewExtendsPastEventStart, reviewTemporalConstraints } from "./review-temporal-policy";

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
