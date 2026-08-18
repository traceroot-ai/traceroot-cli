import { REGISTRY } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";
import { GROUPS, PLACEMENTS } from "../../src/registry/naming.js";

const registryNames = REGISTRY.map((entry) => entry.name);

describe("tool placements", () => {
  it("every registry tool is placed (a new endpoint fails here until it has a home)", () => {
    for (const name of registryNames) {
      expect(
        PLACEMENTS[name],
        `tool '${name}' has no entry in src/registry/naming.ts`,
      ).toBeDefined();
    }
  });

  it("every placement refers to a live registry tool", () => {
    for (const name of Object.keys(PLACEMENTS)) {
      expect(registryNames, `stale placement '${name}'`).toContain(name);
    }
  });

  it("command positionals exactly match the tool's path parameters, in order", () => {
    for (const entry of REGISTRY) {
      const placement = PLACEMENTS[entry.name];
      if (placement?.kind !== "command") continue;
      const pathParams = [...entry.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
      expect(placement.positionals ?? [], entry.name).toEqual(pathParams);
    }
  });

  it("companions point at command placements", () => {
    for (const [name, placement] of Object.entries(PLACEMENTS)) {
      if (placement.kind !== "companion") continue;
      expect(placement.of.length).toBeGreaterThan(0);
      for (const owner of placement.of) {
        expect(PLACEMENTS[owner]?.kind, `companion '${name}' → non-command '${owner}'`).toBe(
          "command",
        );
      }
    }
  });

  it("every command group has a description in GROUPS", () => {
    for (const placement of Object.values(PLACEMENTS)) {
      if (placement.kind !== "command" || placement.path.length !== 2) continue;
      expect(Object.keys(GROUPS)).toContain(placement.path[0]);
    }
  });
});
