import { expect, it } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import type { paths } from "../../src/api/generated/schema.js";

it("imports the client without side effects", () => {
  expect(typeof createApiClient).toBe("function");
});

// Compile-time coverage: each alias fails `typecheck` if the endpoint is missing.
// Exported so they are not flagged as unused; ignore the test-export lint rule.
// biome-ignore lint/suspicious/noExportsInTest: type-only compile-time assertions
export type _AssertWhoami = paths["/api/v1/public/whoami"]["get"];
// biome-ignore lint/suspicious/noExportsInTest: type-only compile-time assertions
export type _AssertTraces = paths["/api/v1/public/traces"]["get"];
// biome-ignore lint/suspicious/noExportsInTest: type-only compile-time assertions
export type _AssertTraceDetail = paths["/api/v1/public/traces/{trace_id}"]["get"];
// biome-ignore lint/suspicious/noExportsInTest: type-only compile-time assertions
export type _AssertTraceExport = paths["/api/v1/public/traces/{trace_id}/export"]["get"];
