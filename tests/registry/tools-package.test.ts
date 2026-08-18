import { ApiClient, ApiError, REGISTRY, bearerAuth, dispatch } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";

describe("@traceroot-ai/tools vendored package", () => {
  it("exposes the registry and dispatcher", () => {
    expect(REGISTRY.length).toBeGreaterThan(0);
    expect(typeof dispatch).toBe("function");
    expect(typeof ApiClient).toBe("function");
    expect(typeof ApiError).toBe("function");
    expect(bearerAuth("k")).toEqual({ Authorization: "Bearer k" });
  });

  it("every entry is a GET with an object input schema", () => {
    for (const entry of REGISTRY) {
      expect(entry.method).toBe("get");
      expect(entry.inputSchema.type).toBe("object");
      expect(entry.inputSchema.additionalProperties).toBe(false);
    }
  });
});
