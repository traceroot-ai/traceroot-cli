import { ApiClient, ApiError, REGISTRY, bearerAuth, dispatch } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";

describe("@traceroot-ai/tools package", () => {
  it("exposes the registry and dispatcher", () => {
    expect(REGISTRY.length).toBeGreaterThan(0);
    expect(typeof dispatch).toBe("function");
    expect(typeof ApiClient).toBe("function");
    expect(typeof ApiError).toBe("function");
    expect(bearerAuth("k")).toEqual({ Authorization: "Bearer k" });
  });

  it("every entry has an object input schema, and every write carries a policy", () => {
    for (const entry of REGISTRY) {
      expect(["get", "post"]).toContain(entry.method);
      expect(entry.inputSchema.type).toBe("object");
      expect(entry.inputSchema.additionalProperties).toBe(false);
      if (entry.method !== "get") {
        // The package guarantees a policy on every non-GET entry; the CLI
        // relies on policy.tenancy to decide project-scope injection.
        expect(entry.policy).toBeDefined();
        // The package's own type declares all three; the CLI reads none of them
        // today, so this pins the contract rather than any behaviour here.
        expect(["none", "confirm", "approval"]).toContain(entry.policy?.approvalClass);
        expect(["account", "workspace", "project"]).toContain(entry.policy?.tenancy);
        expect(entry.bodyParams?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
