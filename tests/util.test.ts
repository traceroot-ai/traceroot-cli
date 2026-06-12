import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../src/util/index.js";

describe("formatTimestamp", () => {
  it("treats a zone-less backend timestamp as UTC and labels the zone", () => {
    expect(formatTimestamp("2026-06-04T23:43:13.590000", "UTC")).toBe("2026-06-04 23:43:13 UTC");
  });

  it("converts UTC to the given local zone", () => {
    // 12:00 UTC in January = 04:00 PST (UTC-8).
    expect(formatTimestamp("2024-01-01T12:00:00", "America/Los_Angeles")).toBe(
      "2024-01-01 04:00:00 PST",
    );
  });

  it("respects an explicit Z without double-shifting", () => {
    expect(formatTimestamp("2026-06-04T23:43:13Z", "UTC")).toBe("2026-06-04 23:43:13 UTC");
  });

  it("falls back to the raw string when unparseable", () => {
    expect(formatTimestamp("not-a-date", "UTC")).toBe("not-a-date");
  });
});
