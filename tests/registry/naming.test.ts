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
      if (placement.kind !== "command" || placement.path.length < 2) continue;
      // Every segment but the last is a group, keyed by its space-joined path,
      // so a nested command needs a description for each level it creates.
      const groups = placement.path.slice(0, -1);
      for (let depth = 1; depth <= groups.length; depth += 1) {
        expect(Object.keys(GROUPS)).toContain(groups.slice(0, depth).join(" "));
      }
    }
  });

  it("a nested group is declared after the parent it hangs from", () => {
    const declared = Object.keys(GROUPS);
    declared.forEach((key, index) => {
      const segments = key.split(" ");
      if (segments.length === 1) return;
      const parent = segments.slice(0, -1).join(" ");
      // Two different failures, so two different messages: -1 means the parent
      // group was never declared at all, while an index above this one means it
      // was declared too late for `--help` to nest under it.
      const parentIndex = declared.indexOf(parent);
      expect(parentIndex, `'${key}' has no declared parent '${parent}'`).toBeGreaterThan(-1);
      expect(parentIndex, `'${key}' is declared before its parent '${parent}'`).toBeLessThan(index);
    });
  });
});
