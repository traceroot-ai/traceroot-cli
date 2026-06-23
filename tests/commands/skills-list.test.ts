import { describe, expect, it } from "vitest";
import { runSkillsList } from "../../src/commands/skills/list.js";
import type { Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

describe("runSkillsList (human)", () => {
  it("lists both skills with descriptions on stdout", () => {
    const { writers, out, err } = makeWriters();
    runSkillsList({ json: false, writers });
    expect(out.data).toContain("traceroot-instrument-repo");
    expect(out.data).toContain("traceroot-quickstart");
    expect(out.data).toContain("Best for:");
    expect(err.data).toBe("");
  });
});

describe("runSkillsList (--json)", () => {
  it("writes exactly one JSON document with a data array of both skills", () => {
    const { writers, out, err } = makeWriters();
    runSkillsList({ json: true, writers });

    const parsed = JSON.parse(out.data) as { data: Array<{ name: string; bestFor: string[] }> };
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data.map((s) => s.name)).toEqual([
      "traceroot-instrument-repo",
      "traceroot-quickstart",
    ]);
    expect(parsed.data[0]?.bestFor.length).toBeGreaterThan(0);
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
    expect(err.data).toBe("");
  });
});
