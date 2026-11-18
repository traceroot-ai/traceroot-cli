import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type CaseLine,
  ProtocolError,
  type RunFile,
  type RunnerEvent,
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
      dashboard_url: null,
    });
  });

  it("reads only the link from the upload block, whose status reads uploaded even for a local run", () => {
    const url = "https://app.example/projects/p/evaluations/evr_1";
    const uploaded = { ...runFile, upload: { ...runFile.upload, dashboard_url: url } };

    const run = parseRunFile(JSON.stringify(uploaded));

    expect(run.dashboard_url).toBe(url);
    expect(run).not.toHaveProperty("upload");
    const { upload: _upload, ...withoutUpload } = runFile;
    expect(parseRunFile(JSON.stringify(withoutUpload)).dashboard_url).toBeNull();
    expect(() =>
      parseRunFile(JSON.stringify({ ...runFile, upload: { dashboard_url: 7 } })),
    ).toThrow('run file, upload: "dashboard_url" should be a string or null, found 7');
  });

  it("accepts a run without a dataset", () => {
    expect(parseRunFile(JSON.stringify({ ...runFile, dataset: null })).dataset).toBeNull();
  });

  it("reads a scorer version saved as a number as its string form", () => {
    const scorers = [
      { name: "exact_match", version: null },
      { name: "not_empty", version: 2 },
    ];

    expect(parseRunFile(JSON.stringify({ ...runFile, scorers })).scorers).toEqual([
      { name: "exact_match", version: null },
      { name: "not_empty", version: "2" },
    ]);
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
      duration_ms: 1.5,
    });
  });

  it("reads a field that may be null as null when it is missing", () => {
    const {
      expected: _expected,
      task_error: _taskError,
      duration_ms: _durationMs,
      ...rest
    } = caseLine;

    const [item] = parseCaseLines(JSON.stringify(rest));

    expect(item?.expected).toBeNull();
    expect(item?.task_error).toBeNull();
    expect(item?.duration_ms).toBeNull();
  });

  it("reads an empty file as no cases", () => {
    expect(parseCaseLines("")).toEqual([]);
  });

  it("reads a scorer version saved as a number as its string form", () => {
    const withNumbers = {
      ...caseLine,
      scores: [{ scorer_name: "exact_match", scorer_version: 2, value: true, passed: true }],
      scorer_errors: [{ scorer_name: "not_empty", scorer_version: 1.5, message: "ValueError" }],
    };

    const [item] = parseCaseLines(JSON.stringify(withNumbers));

    expect(item?.scores[0]?.scorer_version).toBe("2");
    expect(item?.scorer_errors[0]?.scorer_version).toBe("1.5");
    const versionAsBoolean = {
      ...withNumbers,
      scores: [{ scorer_name: "exact_match", scorer_version: true, value: true, passed: true }],
    };
    expect(() => parseCaseLines(JSON.stringify(versionAsBoolean))).toThrow(
      'case line 1, scores[0]: "scorer_version" should be a string, a number or null, found true',
    );
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
    expect(() => parseCaseLines(JSON.stringify({ ...caseLine, duration_ms: "fast" }))).toThrow(
      'case line 1: "duration_ms" should be a number or null, found "fast"',
    );
  });
});

const FIXTURES = fileURLToPath(new URL("../fixtures/eval/", import.meta.url));

const NEWEST = ["python-0.5.1", "typescript-0.8.1"];
const OLDEST = ["python-0.3.0", "typescript-0.8.0"];
const SCENARIOS = [
  "all-pass",
  "import-error",
  "inline-rows-a",
  "inline-rows-b",
  "interrupted",
  "no-evaluations",
  "numeric-no-threshold",
  "one-fails",
  "sampled",
  "scorer-error-unversioned",
  "scorer-error-versioned",
  "task-error",
  "upload-plain-list",
];

interface Recording {
  events: RunnerEvent[];
  exitStatus: number;
  /** The saved run, when the runner saved one. */
  run?: { file: RunFile; raw: Record<string, unknown>; cases: CaseLine[] };
}

function directories(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function recorded(sdk: string, scenario: string): Recording {
  const dir = join(FIXTURES, sdk, scenario);
  const recording: Recording = {
    events: parseEvents(readFileSync(join(dir, "events.jsonl"), "utf8")),
    exitStatus: Number(readFileSync(join(dir, "exit-status"), "utf8")),
  };
  const runs = join(dir, "runs");
  if (existsSync(runs)) {
    const names = readdirSync(runs).sort();
    expect(names).toEqual([
      "run_00000000000000000000000001.cases.jsonl",
      "run_00000000000000000000000001.json",
    ]);
    const text = readFileSync(join(runs, "run_00000000000000000000000001.json"), "utf8");
    recording.run = {
      file: parseRunFile(text),
      raw: JSON.parse(text),
      cases: parseCaseLines(
        readFileSync(join(runs, "run_00000000000000000000000001.cases.jsonl"), "utf8"),
      ),
    };
  }
  return recording;
}

function only<T extends RunnerEvent["type"]>(
  events: RunnerEvent[],
  type: T,
): Extract<RunnerEvent, { type: T }> {
  const matches = events.filter((event) => event.type === type);
  expect(matches).toHaveLength(1);
  return matches[0] as Extract<RunnerEvent, { type: T }>;
}

function caseFor(recording: Recording, input: string): CaseLine {
  const found = recording.run?.cases.find((item) => item.input === input);
  if (found === undefined) {
    throw new Error(`no recorded case for ${input}`);
  }
  return found;
}

describe("the recorded runs", () => {
  it("cover every scenario on the newest releases, and two on the oldest", () => {
    expect(directories(FIXTURES)).toEqual([...OLDEST, ...NEWEST].sort());
    for (const sdk of NEWEST) {
      expect(directories(join(FIXTURES, sdk))).toEqual(SCENARIOS);
    }
    for (const sdk of OLDEST) {
      expect(directories(join(FIXTURES, sdk))).toEqual(["all-pass", "import-error"]);
    }
  });

  const all = [...OLDEST, ...NEWEST].flatMap((sdk) =>
    directories(join(FIXTURES, sdk)).map((scenario) => ({ sdk, scenario })),
  );

  it.each(all)("$sdk/$scenario parses", ({ sdk, scenario }) => {
    const recording = recorded(sdk, scenario);

    expect(recording.events[0]).toEqual({ type: "hello", eval_api_version: 1 });
    if (recording.run !== undefined) {
      const completed = only(recording.events, "evaluation_completed");
      expect(recording.run.file.evaluation_name).toBe(completed.name);
      expect(recording.run.file.status).toBe(completed.status);
      expect(recording.run.cases).toHaveLength(completed.counts.cases);
      // Every release times each case, and gives a run TraceRoot never registered no link.
      for (const item of recording.run.cases) {
        expect(item.duration_ms).toEqual(expect.any(Number));
      }
      expect(recording.run.file.dashboard_url).toBeNull();
    }
  });

  it("contain no absolute path, hostname or credential", () => {
    for (const { sdk, scenario } of all) {
      const dir = join(FIXTURES, sdk, scenario);
      const runs = join(dir, "runs");
      const files = [
        join(dir, "events.jsonl"),
        join(dir, "exit-status"),
        ...(existsSync(runs) ? readdirSync(runs).map((name) => join(runs, name)) : []),
      ];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        expect(text, file).not.toMatch(/(^|["'\s(=])\/[\w.@-]+\//m);
        expect(text, file).not.toMatch(/file:\/\/|127\.0\.0\.1|localhost/);
        expect(text, file).not.toMatch(/\btr-[\w-]{4,}/);
      }
    }
  });
});

describe.each(NEWEST)("what %s's runner writes", (sdk) => {
  it("exits 0 after a fatal event", () => {
    const importError = recorded(sdk, "import-error");

    expect(importError.exitStatus).toBe(0);
    expect(only(importError.events, "fatal").kind).toBe("import_error");
    expect(importError.run).toBeUndefined();
  });

  it("refuses to upload a plain-list dataset before any case runs", () => {
    const upload = recorded(sdk, "upload-plain-list");

    expect(upload.exitStatus).toBe(0);
    expect(only(upload.events, "fatal")).toMatchObject({
      kind: "harness_error",
      message: expect.stringContaining("no synced dataset to report against"),
    });
    expect(upload.events.map((event) => event.type)).not.toContain("case_started");
    expect(upload.run).toBeUndefined();
  });

  it("ends a file with no module-level evaluation with zero evaluations", () => {
    const none = recorded(sdk, "no-evaluations");

    expect(none.events).toEqual([
      { type: "hello", eval_api_version: 1 },
      { type: "suite_completed", evaluations: 0, cancelled: false },
    ]);
  });

  it("ends an interrupted run cancelled and incomplete, with no fatal event", () => {
    const interrupted = recorded(sdk, "interrupted");

    expect(interrupted.exitStatus).toBe(130);
    expect(only(interrupted.events, "suite_completed").cancelled).toBe(true);
    expect(only(interrupted.events, "evaluation_completed").status).toBe("incomplete");
    expect(interrupted.events.map((event) => event.type)).not.toContain("fatal");
    expect(interrupted.run?.file).toMatchObject({ status: "incomplete", is_final: false });
  });

  it("marks a sampled run as not final", () => {
    expect(recorded(sdk, "sampled").run?.file).toMatchObject({
      run_mode: "sample",
      is_final: false,
    });
  });

  it("records pass and fail on each score, never on the case", () => {
    const run = recorded(sdk, "one-fails");

    expect(run.run?.cases.map((item) => item.status)).toEqual([
      "not_scored",
      "not_scored",
      "not_scored",
    ]);
    expect(caseFor(run, "beta").scores).toEqual([
      { scorer_name: "exact_match", scorer_version: null, value: false, passed: false },
      { scorer_name: "not_empty", scorer_version: "2", value: true, passed: true },
    ]);
  });

  it("records a numeric score with no threshold as neither passing nor failing", () => {
    const run = recorded(sdk, "numeric-no-threshold");

    expect(caseFor(run, "beta").scores).toContainEqual({
      scorer_name: "output_length",
      scorer_version: null,
      value: 4,
      passed: null,
    });
  });

  it("records a task error as an errored case with no scores", () => {
    const beta = caseFor(recorded(sdk, "task-error"), "beta");

    expect(beta).toMatchObject({ status: "errored", scores: [], scorer_errors: [] });
    expect(beta.task_error).toContain("cannot convert");
  });

  it("records a raising scorer under its scorer name, with no version", () => {
    const unversioned = caseFor(recorded(sdk, "scorer-error-unversioned"), "beta");
    const versioned = recorded(sdk, "scorer-error-versioned");

    expect(unversioned.status).toBe("errored");
    expect(unversioned.scorer_errors).toMatchObject([
      { scorer_name: "exact_match", scorer_version: null },
    ]);
    expect(caseFor(versioned, "beta").scorer_errors).toMatchObject([
      { scorer_name: "not_empty", scorer_version: null },
    ]);
    expect(versioned.run?.file.scorers).toContainEqual({ name: "not_empty", version: "2" });
  });

  it("records upload.status as uploaded for a run that never left the machine", () => {
    const run = recorded(sdk, "all-pass");

    expect(only(run.events, "evaluation_completed").run_id).toBeNull();
    expect(run.run?.raw.upload).toMatchObject({ status: "uploaded" });
  });

  it("gives an inline dataset positional case ids, and a Dataset content ones", () => {
    const inline = recorded(sdk, "inline-rows-a");
    const dataset = recorded(sdk, "all-pass");

    expect(inline.run?.cases.map((item) => item.case_id)).toEqual(["case-0", "case-1"]);
    for (const item of dataset.run?.cases ?? []) {
      expect(item.case_id).toMatch(/^tc_[0-9a-f]{20}$/);
    }
  });
});

describe("an inline dataset's revision", () => {
  const revision = (sdk: string, scenario: string) =>
    recorded(sdk, scenario).run?.file.dataset?.revision;

  it("is its case count in @traceroot-ai/traceroot, whatever the rows", () => {
    expect(revision("typescript-0.8.1", "inline-rows-a")).toBe("local-2");
    expect(revision("typescript-0.8.1", "inline-rows-b")).toBe("local-2");
  });

  it("follows the rows in traceroot", () => {
    expect(revision("python-0.5.1", "inline-rows-a")).not.toBe(
      revision("python-0.5.1", "inline-rows-b"),
    );
  });
});

/**
 * traceroot writes a float that is NaN or infinite as a bare `NaN`, `Infinity` or `-Infinity`,
 * which isn't JSON. These tests put such tokens into copies of a recorded run.
 */
describe("a bare NaN, Infinity or -Infinity", () => {
  const dir = join(FIXTURES, "python-0.5.1", "numeric-no-threshold");
  const run = "run_00000000000000000000000001";
  const read = (...path: string[]): string => readFileSync(join(dir, ...path), "utf8");

  /** `text` with its first `from` replaced by `to`. Fails when `text` has no `from`. */
  function swap(text: string, from: string, to: string): string {
    expect(text).toContain(from);
    return text.replace(from, to);
  }

  it("reads as null in an event line", () => {
    const original = read("events.jsonl");
    let text = swap(original, '"value": 5,', '"value": NaN,');
    text = swap(text, '"value": 4,', '"value": Infinity,');
    text = swap(text, '"value": 5,', '"value": -Infinity,');

    expect(parseEvents(text)).toEqual(parseEvents(original));
  });

  it("keeps a last event with no newline when it parses with them read as null", () => {
    const original = read("events.jsonl");
    const upToSummary = original.slice(0, original.indexOf('{"type": "suite_completed"') - 1);
    const text = swap(upToSummary, '"mean": 4.666666666666667', '"mean": NaN');

    expect(parseEvents(text).at(-1)).toMatchObject({
      type: "evaluation_completed",
      name: "uppercase",
    });
  });

  it("still rejects a line that isn't JSON with them read as null", () => {
    expect(() => parseEvents(`${stream(hello)}{"value": NaN,\n`)).toThrow(
      "event line 2: not valid JSON",
    );
  });

  it("reads as null in a case line, and leaves the same words inside a string as they are", () => {
    let text = swap(read("runs", `${run}.cases.jsonl`), '"value": 4,', '"value": NaN,');
    text = swap(text, '"input": "beta"', '"input": "NaN, \\"Infinity\\" or -Infinity"');

    const [, beta] = parseCaseLines(text);

    expect(beta?.input).toBe('NaN, "Infinity" or -Infinity');
    expect(beta?.scores).toContainEqual({
      scorer_name: "output_length",
      scorer_version: null,
      value: null,
      passed: null,
    });
  });

  it("reads as null in a run file", () => {
    const original = read("runs", `${run}.json`);
    let text = swap(original, '"mean": 4.666666666666667', '"mean": NaN');
    text = swap(text, '"value": 4,', '"value": -Infinity,');

    expect(parseRunFile(text)).toEqual(parseRunFile(original));
  });
});
