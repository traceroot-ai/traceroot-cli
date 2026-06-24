import { describe, expect, it } from "vitest";
import { formatBytes, formatTimestamp } from "../src/util/index.js";

describe("formatBytes", () => {
  it("groups thousands and appends a one-decimal MB value", () => {
    expect(formatBytes(534922)).toBe("534,922 bytes (0.5 MB)");
  });

  it("handles small and large counts", () => {
    expect(formatBytes(2215)).toBe("2,215 bytes (0.0 MB)");
    expect(formatBytes(0)).toBe("0 bytes (0.0 MB)");
    expect(formatBytes(12_345_678)).toBe("12,345,678 bytes (12.3 MB)");
  });
});

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
