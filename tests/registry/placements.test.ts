import { REGISTRY } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";
import { PLACEMENTS } from "../../src/registry/naming.js";

describe("write tool placements", () => {
  it("every tool that changes something is reachable as a command", () => {
    // Keyed on the policy rather than on the method: a tool that asks for
    // confirmation is one a person has to be able to run, while a read can
    // arrive by POST (`run_sql` sends its query in the body) and is placed on
    // its own merits.
    const changing = REGISTRY.filter(
      (entry) => entry.policy !== undefined && entry.policy.approvalClass !== "none",
    ).map((entry) => entry.name);
    expect(changing.length).toBeGreaterThan(0);
    for (const name of changing) {
      expect(PLACEMENTS[name]?.kind, `${name} must be a command`).toBe("command");
    }
  });

  it("every write carries a policy, so the rule above cannot be silently skipped", () => {
    for (const entry of REGISTRY.filter((e) => e.method !== "get")) {
      expect(entry.policy, `${entry.name} has no policy`).toBeDefined();
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
