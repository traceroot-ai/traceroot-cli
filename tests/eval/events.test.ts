import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_ERROR_KIND, type RunnerExit, outcomeOf } from "../../src/eval/events.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/eval/", import.meta.url));

/** Lines as the runners write them: one JSON object per line, each ending in a newline. */
function stream(...events: object[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

/** A runner that exited 0 on its own, with no signal sent to the CLI. */
function exit(overrides: Partial<RunnerExit> = {}): RunnerExit {
  return { status: 0, signal: null, outputTail: [], ...overrides };
}

const hello = { type: "hello", sdk_version: "0.5.1", eval_api_version: 1, capabilities: {} };
const started = { type: "evaluation_started", name: "uppercase", run_mode: "full" };
const caseStarted = { type: "case_started", case_id: "case-0" };
const counts = { cases: 3, errored: 0, task_errors: 0, scorer_errors: 0, not_scored: 3 };

function evaluationCompleted(overrides: Record<string, unknown> = {}) {
  return {
    type: "evaluation_completed",
    name: "uppercase",
    status: "completed",
    local_run_id: "run_00000000000000000000000001",
    run_id: null,
    counts,
    ...overrides,
  };
}

function suiteCompleted(evaluations = 1, cancelled = false) {
  return { type: "suite_completed", evaluations, cancelled };
}

const importError = {
  type: "fatal",
  kind: "import_error",
  message: "ModuleNotFoundError: No module named 'helpers'",
};

const allPass = stream(hello, started, caseStarted, evaluationCompleted(), suiteCompleted());

/** A recorded event stream and the status its runner exited with. */
function recorded(sdk: string, scenario: string): { text: string; status: number } {
  const dir = join(FIXTURES, sdk, scenario);
  return {
    text: readFileSync(join(dir, "events.jsonl"), "utf8"),
    status: Number(readFileSync(join(dir, "exit-status"), "utf8")),
  };
}

describe("outcomeOf", () => {
  it("lists each evaluation of a run that finished, in the order they ran", () => {
    const second = evaluationCompleted({
      name: "lowercase",
      status: "completed_with_errors",
      local_run_id: "run_00000000000000000000000002",
      run_id: "9c41",
      counts: { ...counts, errored: 1, task_errors: 1, not_scored: 2 },
    });

    const outcome = outcomeOf(
      stream(hello, started, evaluationCompleted(), started, second, suiteCompleted(2)),
      exit(),
    );

    expect(outcome).toEqual({
      outcome: "completed",
      evaluations: [
        {
          type: "evaluation_completed",
          name: "uppercase",
          status: "completed",
          local_run_id: "run_00000000000000000000000001",
          run_id: null,
          counts,
        },
        {
          type: "evaluation_completed",
          name: "lowercase",
          status: "completed_with_errors",
          local_run_id: "run_00000000000000000000000002",
          run_id: "9c41",
          counts: { cases: 3, errored: 1, task_errors: 1, scorer_errors: 0, not_scored: 2 },
        },
      ],
    });
  });

  it("ignores event types it doesn't know", () => {
    const text = stream(
      hello,
      { type: "progress", done: 1 },
      evaluationCompleted(),
      suiteCompleted(),
    );

    expect(outcomeOf(text, exit())).toMatchObject({ outcome: "completed" });
  });

  it("reports a suite that ran no evaluation", () => {
    expect(outcomeOf(stream(hello, suiteCompleted(0)), exit())).toEqual({
      outcome: "no_evaluations",
    });
  });

  describe("an interrupt", () => {
    it("carries the signal the CLI received, whatever the stream says", () => {
      // Signalled, the runner may stop before its stream ends, or a kill may stop it mid-line.
      expect(outcomeOf("", exit({ signal: "SIGTERM", status: 143 }))).toEqual({
        outcome: "interrupted",
        signal: "SIGTERM",
        evaluations: [],
      });
      expect(outcomeOf(stream(hello, importError), exit({ signal: "SIGINT" }))).toEqual({
        outcome: "interrupted",
        signal: "SIGINT",
        evaluations: [],
      });
      expect(outcomeOf(allPass, exit({ signal: "SIGHUP" }))).toEqual({
        outcome: "interrupted",
        signal: "SIGHUP",
        evaluations: [evaluationCompleted()],
      });
    });

    it("keeps every evaluation the runner recorded before it stopped, an incomplete one too", () => {
      const partial = evaluationCompleted({
        name: "lowercase",
        status: "incomplete",
        local_run_id: "run_00000000000000000000000002",
        counts: { ...counts, cases: 1, not_scored: 1 },
      });
      const text = stream(
        hello,
        started,
        evaluationCompleted(),
        started,
        caseStarted,
        partial,
        suiteCompleted(2, true),
      );

      expect(outcomeOf(text, exit({ status: 130 }))).toEqual({
        outcome: "interrupted",
        signal: null,
        evaluations: [evaluationCompleted(), partial],
      });
    });

    it("is read from a runner that exited 130, even with no stream at all", () => {
      expect(outcomeOf("", exit({ status: 130 }))).toEqual({
        outcome: "interrupted",
        signal: null,
        evaluations: [],
      });
    });

    it("is read from a suite that ended cancelled", () => {
      const text = stream(hello, started, evaluationCompleted(), suiteCompleted(1, true));

      expect(outcomeOf(text, exit())).toEqual({
        outcome: "interrupted",
        signal: null,
        evaluations: [evaluationCompleted()],
      });
    });

    it("is read from an evaluation that ended incomplete", () => {
      const incomplete = evaluationCompleted({ status: "incomplete" });

      expect(outcomeOf(stream(hello, started, incomplete), exit())).toEqual({
        outcome: "interrupted",
        signal: null,
        evaluations: [incomplete],
      });
    });

    it("is read from a fatal event of kind cancelled", () => {
      const cancelled = { type: "fatal", kind: "cancelled", message: "interrupted" };

      expect(outcomeOf(stream(hello, caseStarted, cancelled), exit())).toEqual({
        outcome: "interrupted",
        signal: null,
        evaluations: [],
      });
    });

    it("wins over an event stream the CLI can't read", () => {
      const unreadable = `${stream(hello)}not json\n`;

      expect(outcomeOf(unreadable, exit({ signal: "SIGINT" }))).toEqual({
        outcome: "interrupted",
        signal: "SIGINT",
        evaluations: [],
      });
      expect(outcomeOf(unreadable, exit({ status: 130 }))).toMatchObject({
        outcome: "interrupted",
        signal: null,
      });
    });
  });

  describe("a fatal event", () => {
    it("carries the runner's kind and message", () => {
      expect(outcomeOf(stream(hello, importError), exit())).toEqual({
        outcome: "fatal",
        kind: "import_error",
        message: "ModuleNotFoundError: No module named 'helpers'",
        evaluations: [],
      });
    });

    it("keeps the evaluations that finished before it", () => {
      const harnessError = { type: "fatal", kind: "harness_error", message: "flush failed" };
      const text = stream(
        hello,
        started,
        evaluationCompleted(),
        { ...started, name: "lowercase" },
        caseStarted,
        harnessError,
      );

      expect(outcomeOf(text, exit())).toEqual({
        outcome: "fatal",
        kind: "harness_error",
        message: "flush failed",
        evaluations: [evaluationCompleted()],
      });
    });

    it("wins over a non-zero exit, and reports the first fatal event", () => {
      const second = { type: "fatal", kind: "harness_error", message: "flush failed" };

      expect(outcomeOf(stream(hello, importError, second), exit({ status: 1 }))).toMatchObject({
        outcome: "fatal",
        kind: "import_error",
      });
    });

    it("is what a runner that speaks another protocol version becomes, naming the version", () => {
      const outcome = outcomeOf(
        stream({ ...hello, eval_api_version: 2 }, suiteCompleted()),
        exit(),
      );

      expect(outcome).toMatchObject({ outcome: "fatal", kind: PROTOCOL_ERROR_KIND });
      expect(outcome).toHaveProperty("message", expect.stringContaining("eval_api_version 2"));
    });

    it("is what an event the CLI can't read becomes, naming the line", () => {
      const text = `${stream(hello)}not json\n${stream(suiteCompleted())}`;
      const outcome = outcomeOf(text, exit());

      expect(outcome).toMatchObject({ outcome: "fatal", kind: PROTOCOL_ERROR_KIND });
      expect(outcome).toHaveProperty("message", expect.stringContaining("event line 2"));
    });

    it("carries no evaluations from a stream the CLI can't read, even ones before the bad line", () => {
      const text = `${stream(hello, started, evaluationCompleted())}not json\n${stream(suiteCompleted())}`;

      expect(outcomeOf(text, exit())).toMatchObject({
        outcome: "fatal",
        kind: PROTOCOL_ERROR_KIND,
        evaluations: [],
      });
    });
  });

  describe("a crash", () => {
    it("is a stream with no suite_completed, carrying the exit status and the last output", () => {
      const text = stream(hello, started, caseStarted);
      const outputTail = ["Traceback (most recent call last):", "MemoryError"];

      expect(outcomeOf(text, exit({ status: 137, outputTail }))).toEqual({
        outcome: "crashed",
        exitStatus: 137,
        outputTail,
        evaluations: [],
      });
    });

    it("keeps the evaluations that finished before the runner stopped", () => {
      const text = stream(
        hello,
        started,
        evaluationCompleted(),
        { ...started, name: "lowercase" },
        caseStarted,
      );

      expect(outcomeOf(text, exit({ status: 137 }))).toEqual({
        outcome: "crashed",
        exitStatus: 137,
        outputTail: [],
        evaluations: [evaluationCompleted()],
      });
    });

    it("is a stream with no suite_completed even when the runner exited 0", () => {
      expect(outcomeOf(stream(hello, started, caseStarted), exit())).toMatchObject({
        outcome: "crashed",
        exitStatus: 0,
      });
    });

    it("is a runner that wrote nothing", () => {
      expect(outcomeOf("", exit())).toMatchObject({ outcome: "crashed", exitStatus: 0 });
    });

    it("is a stream whose last event was cut off mid-line", () => {
      // The parser drops a final line that isn't valid JSON, so the suite never completed.
      const text = `${stream(hello, started, evaluationCompleted())}{"type":"suite_comp`;

      expect(outcomeOf(text, exit())).toMatchObject({ outcome: "crashed", exitStatus: 0 });
    });

    it("is a complete stream from a runner that exited non-zero, never completed", () => {
      expect(outcomeOf(allPass, exit({ status: 1 }))).toMatchObject({
        outcome: "crashed",
        exitStatus: 1,
      });
    });
  });
});

// traceroot drops the case in flight on SIGINT, and @traceroot-ai/traceroot finishes it.
describe.each([
  { sdk: "python-0.5.1", casesBeforeTheInterrupt: 1 },
  { sdk: "typescript-0.8.1", casesBeforeTheInterrupt: 2 },
])("$sdk's recorded runs", ({ sdk, casesBeforeTheInterrupt }) => {
  it("read an import error as fatal, with the runner's message", () => {
    const { text, status } = recorded(sdk, "import-error");
    const written = JSON.parse(text.trim().split("\n").at(-1) ?? "") as { message: string };

    expect(written.message).toMatch(/^(ModuleNotFoundError|Error): /);
    expect(outcomeOf(text, exit({ status }))).toEqual({
      outcome: "fatal",
      kind: "import_error",
      message: written.message,
      evaluations: [],
    });
  });

  it("read a file with no module-level evaluation as no evaluations", () => {
    const { text, status } = recorded(sdk, "no-evaluations");

    expect(outcomeOf(text, exit({ status }))).toEqual({ outcome: "no_evaluations" });
  });

  it("read the interrupted run as interrupted from its events alone, with its saved run", () => {
    const { text } = recorded(sdk, "interrupted");

    expect(outcomeOf(text, exit({ status: 0 }))).toEqual({
      outcome: "interrupted",
      signal: null,
      evaluations: [
        evaluationCompleted({
          status: "incomplete",
          counts: {
            cases: casesBeforeTheInterrupt,
            errored: 0,
            task_errors: 0,
            scorer_errors: 0,
            not_scored: casesBeforeTheInterrupt,
          },
        }),
      ],
    });
  });
});
