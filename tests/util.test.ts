import { describe, expect, it } from "vitest";
import { CliError } from "../src/output.js";
import { formatIsoUtc, formatTimestamp, parseDuration } from "../src/util/index.js";

describe("parseDuration", () => {
  it("parses each supported unit into milliseconds", () => {
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("6h")).toBe(6 * 3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
    expect(parseDuration("2w")).toBe(2 * 604_800_000);
  });

  it("trims surrounding whitespace", () => {
    expect(parseDuration("  12h  ")).toBe(12 * 3_600_000);
  });

  it("throws CliError on a missing or unknown unit", () => {
    expect(() => parseDuration("10")).toThrow(CliError);
    expect(() => parseDuration("10y")).toThrow(CliError);
    expect(() => parseDuration("abc")).toThrow(CliError);
    expect(() => parseDuration("")).toThrow(CliError);
  });

  it("throws CliError on a non-positive amount", () => {
    expect(() => parseDuration("0h")).toThrow(CliError);
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

describe("formatIsoUtc", () => {
  it("returns a Z-suffixed ISO string for a naive (zone-less) backend timestamp", () => {
    // Backend sends naive UTC timestamps without suffix
    expect(formatIsoUtc("2026-06-23T20:31:02.000000")).toBe("2026-06-23T20:31:02.000Z");
  });

  it("returns a Z-suffixed ISO string for an already-Z timestamp", () => {
    expect(formatIsoUtc("2026-06-23T20:31:02.000Z")).toBe("2026-06-23T20:31:02.000Z");
  });

  it("normalizes microsecond precision to milliseconds", () => {
    // Backend can send 6-decimal microseconds; output should be 3-decimal
    expect(formatIsoUtc("2026-06-23T20:31:02.500000")).toBe("2026-06-23T20:31:02.500Z");
  });

  it("falls back to empty string for an unparseable timestamp", () => {
    expect(formatIsoUtc("not-a-date")).toBe("");
  });
});
