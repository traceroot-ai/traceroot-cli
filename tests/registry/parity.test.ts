import { readFileSync } from "node:fs";
import { REGISTRY } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";

interface XTool {
  enabled?: boolean;
  name?: string;
}
interface OpenApiDoc {
  paths: Record<string, Record<string, { "x-tool"?: XTool }>>;
}

function enabledToolNames(doc: OpenApiDoc): string[] {
  const names: string[] = [];
  for (const operations of Object.values(doc.paths)) {
    for (const operation of Object.values(operations)) {
      const tool = operation["x-tool"];
      if (tool?.enabled === true && tool.name !== undefined) {
        names.push(tool.name);
      }
    }
  }
  return names.sort();
}

describe("openapi.json / @traceroot-ai/tools parity", () => {
  // A mismatch means the vendored dependency and the committed snapshot are out
  // of step: bump/rebuild vendor/traceroot-ai-tools-*.tgz and/or refresh
  // openapi.json (see OPENAPI.md), then rerun `npm run codegen`.
  it("the snapshot's enabled x-tool names equal the installed registry's names", () => {
    const doc = JSON.parse(
      readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
    ) as OpenApiDoc;
    expect([...REGISTRY.map((entry) => entry.name)].sort()).toEqual(enabledToolNames(doc));
  });
});
