import { describe, expect, it } from "vitest";
import { couldBeNotice, filterNotices, rewriteNotice } from "../../src/eval/notices.js";

const TAIL =
  "The AI agent needs both to correlate traces to source. Set TRACEROOT_GIT_REPO / TRACEROOT_GIT_REF";
const URL = "https://docs.traceroot.ai/tracing/git-context";
/** The notice as each released SDK prints it. */
const PYTHON = `TraceRoot: git context incomplete (repo=unset, ref=unset). ${TAIL} — see ${URL}`;
const PYTHON_NEXT = `traceroot: git context incomplete (repo=unset, ref=unset). ${TAIL} — see ${URL}`;
const NODE = `[TraceRoot] git context incomplete (repo=unset, ref=unset). ${TAIL} (see ${URL}).`;
const NODE_NEXT = `[traceroot] git context incomplete (repo=unset, ref=unset). ${TAIL} (see ${URL}).`;

const REWORDED = [
  "warning: no Git repository or commit was found, so the uploaded traces won't link to source code.",
  `  Set TRACEROOT_GIT_REPO and TRACEROOT_GIT_REF: ${URL}`,
];

describe("rewriteNotice", () => {
  it.each([PYTHON, PYTHON_NEXT, NODE, NODE_NEXT])("rewords %s", (line) => {
    expect(rewriteNotice(line, undefined, true)).toEqual(REWORDED);
    expect(rewriteNotice(`${line}\r`, undefined, true)).toEqual(REWORDED);
  });

  it("says which of the two was missing", () => {
    expect(rewriteNotice(PYTHON.replace("ref=unset", "ref=4f2c9a1"), undefined, true)?.[0]).toBe(
      "warning: no Git repository was found (commit 4f2c9a1), so the uploaded traces won't link to source code.",
    );
    expect(
      rewriteNotice(NODE.replace("repo=unset", "repo=github.com/acme/agent"), undefined, true)?.[0],
    ).toBe(
      "warning: no Git commit was found (repository github.com/acme/agent), so the uploaded traces won't link to source code.",
    );
  });

  it("wraps to the terminal at word boundaries and keeps the link whole", () => {
    expect(rewriteNotice(PYTHON, 40, true)).toEqual([
      "warning: no Git repository or commit was",
      "  found, so the uploaded traces won't",
      "  link to source code.",
      "  Set TRACEROOT_GIT_REPO and",
      "    TRACEROOT_GIT_REF:",
      `    ${URL}`,
    ]);
  });

  it("leaves any other line alone, however close", () => {
    expect(rewriteNotice(`WARNING:traceroot.client:${PYTHON}`, undefined, true)).toBeNull();
    expect(
      rewriteNotice("TraceRoot: git context incomplete, says my app", undefined, true),
    ).toBeNull();
    expect(rewriteNotice(`${PYTHON} and more`, undefined, true)).toBeNull();
  });
});

describe("couldBeNotice", () => {
  it("holds a line only while it could still be the notice", () => {
    expect(couldBeNotice("")).toBe(true);
    expect(couldBeNotice("[Trace")).toBe(true);
    expect(couldBeNotice("traceroot: git context incomplete (repo=")).toBe(true);
    expect(couldBeNotice("trace started")).toBe(false);
    expect(couldBeNotice("NOISY stdout")).toBe(false);
  });
});

describe("filterNotices", () => {
  function collect(
    width?: number,
    uploads = true,
  ): { filter: ReturnType<typeof filterNotices>; writes: string[] } {
    const writes: string[] = [];
    return { filter: filterNotices((text) => writes.push(text), width, uploads), writes };
  }

  it("rewrites the notice however the runner's writes split it", () => {
    const { filter, writes } = collect();
    const text = `before\n${NODE}\nafter\n`;
    for (const piece of [
      text.slice(0, 10),
      text.slice(10, 50),
      text.slice(50, 200),
      text.slice(200),
    ]) {
      filter.write(piece);
    }
    filter.flush();

    expect(writes.join("")).toBe(`before\n${REWORDED.join("\n")}\nafter\n`);
  });

  it("passes any other output on at once, an unfinished line included", () => {
    const { filter, writes } = collect();

    filter.write("NOISY stdout case=weather\nprogress 1/3");

    expect(writes).toEqual(["NOISY stdout case=weather\nprogress 1/3"]);
    filter.write(" [TraceRoot] git context incomplete mid-line\n");
    expect(writes.at(-1)).toBe(" [TraceRoot] git context incomplete mid-line\n");
  });

  it("passes on a held line that ends without a newline when the runner ends", () => {
    const { filter, writes } = collect();

    filter.write("[TraceRoot] git");
    expect(writes).toEqual([]);
    filter.flush();

    expect(writes).toEqual(["[TraceRoot] git"]);
  });

  it("leaves the notice out of a run that uploads nothing, and passes every other line on", () => {
    const { filter, writes } = collect(undefined, false);

    filter.write(`before\n${PYTHON}\nafter\n[TraceRoot] git`);
    filter.flush();

    expect(writes.join("")).toBe("before\nafter\n[TraceRoot] git");
    expect(rewriteNotice(NODE, 80, false)).toEqual([]);
  });
});
