import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  parseCaseLines,
  parseEvents,
  parseRunFile,
} from "../../src/eval/protocol.js";

/** Lines as the runners write them: one JSON object per line, each ending in a newline. */
function stream(...events: object[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

const hello = { type: "hello", sdk_version: "0.5.1", eval_api_version: 1, capabilities: {} };
const completed = {
  type: "evaluation_completed",
  name: "uppercase",
  status: "completed",
  created_at: "2000-01-01T00:00:00.000Z",
  local_run_id: "run_00000000000000000000000001",
  run_id: null,
  counts: { cases: 3, errored: 0, task_errors: 0, scorer_errors: 0, not_scored: 3 },
  score_summary: {},
  artifact: null,
};

describe("parseEvents", () => {
  it("reads the fields the CLI uses from each of the eight event types", () => {
    const events = parseEvents(
      stream(
        hello,
        { type: "definitions", evaluations: [{ name: "uppercase", module: "eval.py" }] },
        { type: "evaluation_started", name: "uppercase", run_mode: "full" },
        { type: "case_started", case_id: "case-0" },
        { type: "case_completed", case_id: "case-0", status: "not_scored", scores: [] },
        completed,
        { type: "suite_completed", evaluations: 1, cancelled: false },
        { type: "fatal", kind: "import_error", message: "ModuleNotFoundError: helpers" },
      ),
    );

    expect(events).toEqual([
      { type: "hello", eval_api_version: 1 },
      { type: "definitions" },
      { type: "evaluation_started" },
      { type: "case_started" },
      { type: "case_completed" },
      {
        type: "evaluation_completed",
        name: "uppercase",
        status: "completed",
        local_run_id: "run_00000000000000000000000001",
        run_id: null,
        counts: { cases: 3, errored: 0, task_errors: 0, scorer_errors: 0, not_scored: 3 },
      },
      { type: "suite_completed", evaluations: 1, cancelled: false },
      { type: "fatal", kind: "import_error", message: "ModuleNotFoundError: helpers" },
    ]);
  });

  it("keeps the TraceRoot run id of an uploaded run", () => {
    const [event] = parseEvents(stream({ ...completed, run_id: "2f6c" }));

    expect(event).toMatchObject({ type: "evaluation_completed", run_id: "2f6c" });
  });

  it("ignores event types it doesn't know, and blank lines", () => {
    const text = `${stream(hello)}\n${stream({ type: "progress", done: 1 })}`;

    expect(parseEvents(text)).toEqual([{ type: "hello", eval_api_version: 1 }]);
  });

  it("rejects a runner that speaks another protocol version, naming it", () => {
    expect(() => parseEvents(stream({ ...hello, eval_api_version: 2 }))).toThrow(
      new ProtocolError(
        "the eval runner speaks eval_api_version 2, and this CLI reads only version 1",
      ),
    );
    expect(() => parseEvents(stream({ ...hello, eval_api_version: "1" }))).toThrow(
      'speaks eval_api_version "1"',
    );
    expect(() => parseEvents(stream({ type: "hello" }))).toThrow(
      "the eval runner announces no eval_api_version",
    );
  });

  it("names the line and the field when an event lacks one the CLI reads", () => {
    const { status: _status, ...withoutStatus } = completed;

    expect(() => parseEvents(stream(hello, withoutStatus))).toThrow(
      'event line 2 (evaluation_completed): "status" is missing',
    );
    expect(() => parseEvents(stream({ ...completed, status: "failed" }))).toThrow(
      '"status" should be one of completed, completed_with_errors, incomplete, found "failed"',
    );
    expect(() =>
      parseEvents(stream({ ...completed, counts: { ...completed.counts, cases: "3" } })),
    ).toThrow('event line 1 (evaluation_completed), counts: "cases" should be a number');
  });

  it("rejects a line that isn't a JSON object, or an event without a type", () => {
    expect(() => parseEvents(`${stream(hello)}{"type":\n`)).toThrow(ProtocolError);
    expect(() => parseEvents(`${stream(hello)}{"type":\n`)).toThrow("event line 2: not valid JSON");
    expect(() => parseEvents("[1, 2]\n")).toThrow("event line 1: expected a JSON object");
    expect(() => parseEvents(stream({ kind: "import_error" }))).toThrow(
      'event line 1: "type" is missing or not a string',
    );
  });

  it("drops a last line the runner never finished writing", () => {
    const torn = `${stream(hello)}{"type": "case_comp`;

    expect(parseEvents(torn)).toEqual([{ type: "hello", eval_api_version: 1 }]);
  });

  it("keeps a complete last event that has no newline", () => {
    const text = `${stream(hello)}${JSON.stringify({ type: "suite_completed", evaluations: 0, cancelled: false })}`;

    expect(parseEvents(text)).toEqual([
      { type: "hello", eval_api_version: 1 },
      { type: "suite_completed", evaluations: 0, cancelled: false },
    ]);
  });

  it("reads an empty stream as no events", () => {
    expect(parseEvents("")).toEqual([]);
  });
});

const runFile = {
  schema_version: "1",
  kind: "eval_run",
  local_run_id: "run_00000000000000000000000001",
  run_id: null,
  evaluation_name: "uppercase",
  status: "completed_with_errors",
  run_mode: "full",
  is_final: true,
  sample: { count: null, seed: null },
  dataset: { dataset_id: "ds_inline", revision: "local-2", case_count: 2 },
  scorers: [
    { name: "exact_match", version: null },
    { name: "not_empty", version: "2" },
  ],
  upload: { status: "uploaded", dashboard_url: null, failed_result_count: 0 },
  artifact: { run: ".traceroot/eval/runs/x.json", payloads: "complete" },
};

describe("parseRunFile", () => {
  it("reads the fields the CLI uses and nothing else", () => {
    expect(parseRunFile(JSON.stringify(runFile, null, 2))).toEqual({
      evaluation_name: "uppercase",
      status: "completed_with_errors",
      run_mode: "full",
      is_final: true,
      dataset: { revision: "local-2" },
      scorers: [
        { name: "exact_match", version: null },
        { name: "not_empty", version: "2" },
      ],
      artifact: { payloads: "complete" },
    });
  });

  it("leaves out the upload block, which reads uploaded even for a local run", () => {
    expect(parseRunFile(JSON.stringify(runFile))).not.toHaveProperty("upload");
  });

  it("accepts a run without a dataset", () => {
    expect(parseRunFile(JSON.stringify({ ...runFile, dataset: null })).dataset).toBeNull();
  });

  it("names the field that is wrong", () => {
    expect(() => parseRunFile(JSON.stringify({ ...runFile, run_mode: "partial" }))).toThrow(
      'run file: "run_mode" should be one of full, first, sample, found "partial"',
    );
    expect(() =>
      parseRunFile(JSON.stringify({ ...runFile, artifact: { payloads: "some" } })),
    ).toThrow('run file, artifact: "payloads" should be one of complete, truncated');
    expect(() =>
      parseRunFile(JSON.stringify({ ...runFile, scorers: [{ name: "exact_match" }, {}] })),
    ).toThrow('run file, scorers[1]: "name" is missing');
    expect(() => parseRunFile("not json")).toThrow("run file: not valid JSON");
  });
});

const caseLine = {
  schema_version: "1",
  case_id: "case-1",
  status: "errored",
  input: { word: "beta" },
  output: null,
  expected: "BETA",
  scores: [
    {
      scorer_name: "exact_match",
      scorer_version: null,
      value: false,
      passed: false,
      explanation: null,
    },
    { scorer_name: "output_length", scorer_version: null, value: 4, passed: null },
  ],
  scorer_errors: [
    { scorer_name: "not_empty", scorer_version: null, message: "ValueError: cannot check" },
  ],
  task_error: null,
  trace_id: null,
  duration_ms: 1.5,
};

describe("parseCaseLines", () => {
  it("reads one case per line, skipping blank lines", () => {
    const text = `${JSON.stringify(caseLine)}\n\n${JSON.stringify({ ...caseLine, case_id: "case-2" })}\n`;

    const cases = parseCaseLines(text);

    expect(cases.map((item) => item.case_id)).toEqual(["case-1", "case-2"]);
    expect(cases[0]).toEqual({
      case_id: "case-1",
      status: "errored",
      input: { word: "beta" },
      expected: "BETA",
      task_error: null,
      scorer_errors: [
        { scorer_name: "not_empty", scorer_version: null, message: "ValueError: cannot check" },
      ],
      scores: [
        { scorer_name: "exact_match", scorer_version: null, value: false, passed: false },
        { scorer_name: "output_length", scorer_version: null, value: 4, passed: null },
      ],
    });
  });

  it("reads a field that may be null as null when it is missing", () => {
    const { expected: _expected, task_error: _taskError, ...rest } = caseLine;

    const [item] = parseCaseLines(JSON.stringify(rest));

    expect(item?.expected).toBeNull();
    expect(item?.task_error).toBeNull();
  });

  it("reads an empty file as no cases", () => {
    expect(parseCaseLines("")).toEqual([]);
  });

  it("names the line and the field that is wrong", () => {
    const passedAsText = {
      ...caseLine,
      scores: [{ scorer_name: "exact_match", scorer_version: null, value: 1, passed: "yes" }],
    };

    expect(() =>
      parseCaseLines(`${JSON.stringify(caseLine)}\n${JSON.stringify(passedAsText)}\n`),
    ).toThrow('case line 2, scores[0]: "passed" should be true, false or null, found "yes"');
    expect(() => parseCaseLines(JSON.stringify({ ...caseLine, status: "passed" }))).toThrow(
      'case line 1: "status" should be one of errored, not_scored, found "passed"',
    );
  });
});
