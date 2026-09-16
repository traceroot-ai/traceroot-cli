import { REGISTRY } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";
import { PLACEMENTS } from "../../src/registry/naming.js";

describe("write tool placements", () => {
  it("every write tool is reachable as a command", () => {
    const writes = REGISTRY.filter((e) => e.method !== "get").map((e) => e.name);
    expect(writes.length).toBe(6);
    for (const name of writes) {
      expect(PLACEMENTS[name]?.kind, `${name} must be a command`).toBe("command");
    }
  });

  it("no placement is left with the temporary bump note", () => {
    for (const [name, placement] of Object.entries(PLACEMENTS)) {
      if (placement.kind !== "internal") continue;
      expect(placement.note, `${name} still carries the temporary note`).not.toContain(
        "placed as a command in a later task",
      );
    }
  });
});
