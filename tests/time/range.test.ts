import { describe, expect, it } from "vitest";
import { CliError } from "../../src/output.js";
import {
  formatLocalDisplay,
  parseLimit,
  renderRangeSummary,
  resolveTimeRange,
} from "../../src/time/range.js";

describe("resolveTimeRange", () => {
  const fixedNow = () => Date.parse("2024-06-15T12:00:00.000Z");

  it("returns an empty range when no flags are given", () => {
    expect(resolveTimeRange({})).toEqual({});
  });

  it("turns --since into a startAfter window ending now (no endBefore)", () => {
    expect(resolveTimeRange({ since: "24h" }, fixedNow)).toEqual({
      startAfter: "2024-06-14T12:00:00.000Z",
      sinceLabel: "24h",
    });
  });

  it("maps --from/--to to startAfter/endBefore", () => {
    expect(resolveTimeRange({ from: "2024-01-01T00:00:00Z", to: "2024-02-01T00:00:00Z" })).toEqual({
      startAfter: "2024-01-01T00:00:00.000Z",
      endBefore: "2024-02-01T00:00:00.000Z",
    });
  });

  it("treats a bare date as midnight UTC and a zone-less time as UTC", () => {
    expect(resolveTimeRange({ from: "2024-03-04" }).startAfter).toBe("2024-03-04T00:00:00.000Z");
    expect(resolveTimeRange({ from: "2024-03-04T09:30:00" }).startAfter).toBe(
      "2024-03-04T09:30:00.000Z",
    );
  });

  it("rejects an inverted --from/--to range with an ordering message", () => {
    expect(() =>
      resolveTimeRange({ from: "2024-02-01T00:00:00Z", to: "2024-01-01T00:00:00Z" }),
    ).toThrow(/--from must resolve to an earlier time than --to/);
  });

  it("rejects an equal --from/--to range explaining inclusive/exclusive bounds", () => {
    expect(() =>
      resolveTimeRange({ from: "2024-01-01T00:00:00Z", to: "2024-01-01T00:00:00Z" }),
    ).toThrow(/resolve to the same time.*inclusive.*exclusive/s);
  });

  it("rejects combining --since with --from or --to", () => {
    expect(() => resolveTimeRange({ since: "24h", from: "2024-01-01T00:00:00Z" })).toThrow(
      CliError,
    );
    expect(() => resolveTimeRange({ since: "24h", to: "2024-01-01T00:00:00Z" })).toThrow(CliError);
  });

  it("rejects an invalid duration or timestamp", () => {
    expect(() => resolveTimeRange({ since: "soon" })).toThrow(CliError);
    expect(() => resolveTimeRange({ from: "not-a-date" })).toThrow(CliError);
  });

  it("rejects ISO inputs with invalid calendar dates (no silent normalization)", () => {
    expect(() => resolveTimeRange({ from: "2026-02-31" })).toThrow(CliError); // bare date
    expect(() => resolveTimeRange({ from: "2026-02-31T10:00:00Z" })).toThrow(CliError); // Z
    expect(() => resolveTimeRange({ to: "2026-02-31T10:00:00-06:00" })).toThrow(CliError); // offset
    expect(() => resolveTimeRange({ from: "2026-04-31" })).toThrow(CliError); // April has 30 days
    expect(() => resolveTimeRange({ from: "2026-02-29" })).toThrow(CliError); // 2026 not a leap year
  });

  it("accepts Feb 29 in a leap year", () => {
    expect(resolveTimeRange({ from: "2024-02-29" }).startAfter).toBe("2024-02-29T00:00:00.000Z");
  });

  it("rejects a --since window so large it overflows the date range", () => {
    expect(() => resolveTimeRange({ since: "99999999w" })).toThrow(CliError);
  });

  // ── Quoted display timestamp format ──────────────────────────────────────

  it("accepts a quoted display timestamp for --from (Denver/MDT)", () => {
    // "2026-06-23 14:31:02 MDT" in America/Denver = 2026-06-23T20:31:02.000Z
    const result = resolveTimeRange(
      { from: "2026-06-23 14:31:02 MDT" },
      Date.now,
      "America/Denver",
    );
    expect(result.startAfter).toBe("2026-06-23T20:31:02.000Z");
  });

  it("accepts a quoted display timestamp for --to (Denver/MDT)", () => {
    // "2026-06-23 14:31:02 MDT" = 2026-06-23T20:31:02.000Z
    const result = resolveTimeRange({ to: "2026-06-23 14:31:02 MDT" }, Date.now, "America/Denver");
    expect(result.endBefore).toBe("2026-06-23T20:31:02.000Z");
  });

  it("accepts a quoted STARTED value with a GMT±offset abbreviation (IST/JST/etc.)", () => {
    // The STARTED column shows "GMT+5:30" in zones Intl renders as GMT offsets;
    // the explicit offset is parsed directly (no local-zone lookup needed).
    // 17:30:00 +05:30 = 12:00:00 UTC; 21:00:00 +09:00 = 12:00:00 UTC.
    expect(resolveTimeRange({ from: "2026-06-23 17:30:00 GMT+5:30" }).startAfter).toBe(
      "2026-06-23T12:00:00.000Z",
    );
    expect(resolveTimeRange({ to: "2026-06-23 21:00:00 GMT+9" }).endBefore).toBe(
      "2026-06-23T12:00:00.000Z",
    );
    expect(resolveTimeRange({ from: "2026-06-23 09:00:00 GMT-3" }).startAfter).toBe(
      "2026-06-23T12:00:00.000Z",
    );
  });

  it("rejects invalid GMT±offset display values (no normalization)", () => {
    expect(() => resolveTimeRange({ from: "2026-02-31 17:30:00 GMT+5:30" })).toThrow(CliError);
    expect(() => resolveTimeRange({ from: "2026-06-23 25:30:00 GMT+5:30" })).toThrow(CliError);
    expect(() => resolveTimeRange({ from: "2026-06-23 17:30:00 GMT+99" })).toThrow(CliError);
    expect(() => resolveTimeRange({ from: "2026-06-23 17:30:00 GMT+5:99" })).toThrow(CliError);
  });

  it("accepts display timestamps for both --from and --to (Denver/MDT)", () => {
    const result = resolveTimeRange(
      {
        from: "2026-06-23 14:28:35 MDT",
        to: "2026-06-23 14:31:02 MDT",
      },
      Date.now,
      "America/Denver",
    );
    expect(result.startAfter).toBe("2026-06-23T20:28:35.000Z");
    expect(result.endBefore).toBe("2026-06-23T20:31:02.000Z");
  });

  it("rejects a display timestamp with mismatched abbreviation (PST given but Denver is MDT)", () => {
    expect(() =>
      resolveTimeRange({ from: "2026-06-23 14:31:02 PST" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });

  it("rejects a summer MST abbreviation when the local zone is MDT (Denver)", () => {
    // In June, Denver uses MDT (UTC-6), not MST (UTC-7)
    expect(() =>
      resolveTimeRange({ from: "2026-06-23 14:31:02 MST" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });

  it("accepts a quoted display timestamp for --from in winter (Denver/MST)", () => {
    // "2026-12-23 14:31:02 MST" in America/Denver = 2026-12-23T21:31:02.000Z (MST = UTC-7)
    const result = resolveTimeRange(
      { from: "2026-12-23 14:31:02 MST" },
      Date.now,
      "America/Denver",
    );
    expect(result.startAfter).toBe("2026-12-23T21:31:02.000Z");
  });

  it("accepts fall-back ambiguous wall-clock with MDT abbreviation (earlier/pre-transition occurrence)", () => {
    // On 2026-11-01 in America/Denver, the clock falls back at 02:00 MDT → 01:00 MST.
    // 01:30:00 occurs twice. The implementation resolves to the EARLIER (MDT, UTC-6) instant.
    // Observed: resolveTimeRange({ from: "2026-11-01 01:30:00 MDT" }, ...) → 2026-11-01T07:30:00.000Z
    const result = resolveTimeRange(
      { from: "2026-11-01 01:30:00 MDT" },
      Date.now,
      "America/Denver",
    );
    expect(result.startAfter).toBe("2026-11-01T07:30:00.000Z");
  });

  it("rejects fall-back ambiguous wall-clock with MST abbreviation (abbreviation mismatch)", () => {
    // On 2026-11-01 in America/Denver, 01:30:00 is ambiguous (falls in the DST fold).
    // The implementation resolves to the earlier (MDT) occurrence, so the zone abbreviation
    // for the resolved instant is MDT — not the typed MST. This mismatch causes rejection.
    expect(() =>
      resolveTimeRange({ from: "2026-11-01 01:30:00 MST" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });

  it("error message for mismatched abbreviation is actionable", () => {
    let message = "";
    try {
      resolveTimeRange({ from: "2026-06-23 14:31:02 PST" }, Date.now, "America/Denver");
    } catch (e) {
      message = (e as Error).message;
    }
    // Should mention the bad abbreviation, local zone, and suggest ISO 8601 with offset
    expect(message).toContain("PST");
    expect(message).toContain("America/Denver");
    expect(message).toContain("ISO 8601");
  });
});

describe("parseLimit", () => {
  it("enforces an upper bound when given, matching the generated path's wording", () => {
    expect(() => parseLimit("999999", 200)).toThrow("--limit must be at most 200");
    expect(parseLimit("200", 200)).toBe(200);
  });

  it("returns undefined when absent", () => {
    expect(parseLimit(undefined)).toBeUndefined();
  });

  it("parses a positive integer", () => {
    expect(parseLimit("5")).toBe(5);
  });

  it("throws CliError on non-integer, zero, or negative", () => {
    expect(() => parseLimit("abc")).toThrow(CliError);
    expect(() => parseLimit("0")).toThrow(CliError);
    expect(() => parseLimit("-3")).toThrow(CliError);
    expect(() => parseLimit("1.5")).toThrow(CliError);
  });
});

describe("resolveTimeRange (additional cases)", () => {
  it("parses an explicit UTC offset like 2026-06-23T14:29:54-06:00", () => {
    const range = resolveTimeRange({ from: "2026-06-23T14:29:54-06:00" });
    // -06:00 means 14:29:54 local = 20:29:54 UTC
    expect(range.startAfter).toBe("2026-06-23T20:29:54.000Z");
  });
});

// ─── renderRangeSummary (pure unit tests) ──────────────────────────────────

describe("renderRangeSummary", () => {
  const TZ = "America/Denver"; // MDT in June (UTC-6)

  it("returns 'all traces' when no bounds are set", () => {
    expect(renderRangeSummary({})).toBe("all traces");
  });

  it("returns 'since <label>' when sinceLabel is set (ignores bounds)", () => {
    expect(renderRangeSummary({ sinceLabel: "2m" })).toBe("since 2m");
    expect(renderRangeSummary({ sinceLabel: "24h", startAfter: "2026-06-23T20:00:00.000Z" })).toBe(
      "since 24h",
    );
  });

  it("returns 'from <local 24h>' for startAfter-only (Denver/MDT)", () => {
    // 2026-06-23T20:29:54Z = 14:29:54 MDT
    const result = renderRangeSummary({ startAfter: "2026-06-23T20:29:54.000Z" }, TZ);
    expect(result).toBe("from 2026-06-23 14:29:54 MDT");
  });

  it("returns 'before <local 24h>' for endBefore-only (Denver/MDT)", () => {
    // 2026-06-23T20:31:02Z = 14:31:02 MDT
    const result = renderRangeSummary({ endBefore: "2026-06-23T20:31:02.000Z" }, TZ);
    expect(result).toBe("before 2026-06-23 14:31:02 MDT");
  });

  it("returns 'from … to before …' for both bounds (Denver/MDT)", () => {
    const result = renderRangeSummary(
      {
        startAfter: "2026-06-23T20:28:35.000Z", // 14:28:35 MDT
        endBefore: "2026-06-23T20:31:02.000Z", // 14:31:02 MDT
      },
      TZ,
    );
    expect(result).toBe("from 2026-06-23 14:28:35 MDT to before 2026-06-23 14:31:02 MDT");
  });
});

// ─── formatLocalDisplay (pure unit tests) ──────────────────────────────────

describe("formatLocalDisplay", () => {
  it("formats a UTC ISO string as the local 24-hour table form (YYYY-MM-DD HH:mm:ss TZ)", () => {
    // 2026-06-23T20:29:54Z = 14:29:54 MDT
    expect(formatLocalDisplay("2026-06-23T20:29:54.000Z", "America/Denver")).toBe(
      "2026-06-23 14:29:54 MDT",
    );
  });

  it("formats midnight as 00:00:00 (24-hour)", () => {
    // 2026-06-23T06:00:00Z = midnight MDT
    expect(formatLocalDisplay("2026-06-23T06:00:00.000Z", "America/Denver")).toBe(
      "2026-06-23 00:00:00 MDT",
    );
  });

  it("formats noon as 12:00:00 (24-hour)", () => {
    // 2026-06-23T18:00:00Z = noon MDT
    expect(formatLocalDisplay("2026-06-23T18:00:00.000Z", "America/Denver")).toBe(
      "2026-06-23 12:00:00 MDT",
    );
  });
});

// ─── T3: round-trip validation ────────────────────────────────────────────

describe("resolveTimeRange (round-trip validation)", () => {
  it("rejects an invalid calendar date (Feb 31)", () => {
    expect(() =>
      resolveTimeRange({ from: "2026-02-31 14:31:02 MDT" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });

  it("rejects an out-of-range hour (hour 25)", () => {
    expect(() =>
      resolveTimeRange({ from: "2026-06-23 25:31:02 MDT" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });

  it("round-trip error message is actionable", () => {
    let message = "";
    try {
      resolveTimeRange({ from: "2026-02-31 14:31:02 MDT" }, Date.now, "America/Denver");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("not a valid local time");
    expect(message).toContain("ISO 8601");
    expect(message).toContain("--from");
  });

  it("still accepts valid MDT date in Denver (round-trip passes)", () => {
    const result = resolveTimeRange(
      { from: "2026-06-23 14:31:02 MDT" },
      Date.now,
      "America/Denver",
    );
    expect(result.startAfter).toBe("2026-06-23T20:31:02.000Z");
  });

  it("rejects a spring-forward gap time in Denver (2026-03-08 02:30:00 MDT)", () => {
    // America/Denver springs forward on 2026-03-08 at 02:00 MST → 03:00 MDT
    // 02:30 doesn't exist; the round-trip will produce a different time
    expect(() =>
      resolveTimeRange({ from: "2026-03-08 02:30:00 MDT" }, Date.now, "America/Denver"),
    ).toThrow(CliError);
  });
});

// ─── T5: flag ordering independence ───────────────────────────────────────

describe("flag ordering independence", () => {
  it("resolveTimeRange results are identical regardless of object key order", () => {
    const tz = "America/Denver";
    const r1 = resolveTimeRange(
      { from: "2026-06-23 14:28:35 MDT", to: "2026-06-23 14:31:02 MDT" },
      Date.now,
      tz,
    );
    const r2 = resolveTimeRange(
      { to: "2026-06-23 14:31:02 MDT", from: "2026-06-23 14:28:35 MDT" },
      Date.now,
      tz,
    );
    expect(r1).toEqual(r2);
  });
});
