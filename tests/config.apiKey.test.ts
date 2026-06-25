import { describe, expect, it } from "vitest";
import { normalizeApiKey } from "../src/config/apiKey.js";

describe("normalizeApiKey", () => {
  it("leaves a bare key untouched", () => {
    expect(normalizeApiKey("tr_abc123")).toBe("tr_abc123");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeApiKey("  tr_abc123  ")).toBe("tr_abc123");
  });

  it("strips surrounding double quotes", () => {
    expect(normalizeApiKey('"tr_abc123"')).toBe("tr_abc123");
  });

  it("strips surrounding single quotes", () => {
    expect(normalizeApiKey("'tr_abc123'")).toBe("tr_abc123");
  });

  it("strips a pasted TRACEROOT_API_KEY= prefix", () => {
    expect(normalizeApiKey("TRACEROOT_API_KEY=tr_abc123")).toBe("tr_abc123");
  });

  it("strips an `export ` prefix, the assignment, and surrounding quotes", () => {
    expect(normalizeApiKey('export TRACEROOT_API_KEY="tr_abc123"')).toBe("tr_abc123");
  });

  it("strips the prefix and quotes from the dashboard copy form", () => {
    expect(normalizeApiKey('TRACEROOT_API_KEY="tr_abc123"')).toBe("tr_abc123");
  });
});
