import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ProgressEvent,
  type RunProgress,
  advance,
  countsCasesItRuns,
  describeProgress,
  readProgressEvent,
  startingProgress,
} from "../../src/eval/progress.js";
import { parseEvents } from "../../src/eval/protocol.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/eval/", import.meta.url));

/** The progress after `events`, from a runner that has written nothing. */
function progressAfter(events: ProgressEvent[], exactCount = true): RunProgress {
  return events.reduce(
    (progress, event) => advance(progress, event, exactCount),
    startingProgress(),
  );
}

const started = (caseCount: number | null, name: string | null = "uppercase"): ProgressEvent => ({
  type: "evaluation_started",
  name,
  caseCount,
});
const caseStarted: ProgressEvent = { type: "case_started" };
const passed: ProgressEvent = { type: "case_completed", errored: false };
const errored: ProgressEvent = { type: "case_completed", errored: true };

describe("readProgressEvent", () => {
  it("reads an evaluation's name and case count from evaluation_started", () => {
    const line = JSON.stringify({
      type: "evaluation_started",
      name: "uppercase",
      run_mode: "full",
      is_final: true,
      dataset: { case_count: 3, name: "words" },
    });

    expect(readProgressEvent(line)).toEqual({
      type: "evaluation_started",
      name: "uppercase",
      caseCount: 3,
    });
  });

  it.each([
    ["no dataset", { type: "evaluation_started", name: "x" }],
    ["no case_count", { type: "evaluation_started", name: "x", dataset: {} }],
    ["a string", { type: "evaluation_started", name: "x", dataset: { case_count: "3" } }],
    ["a negative count", { type: "evaluation_started", name: "x", dataset: { case_count: -1 } }],
    ["a fraction", { type: "evaluation_started", name: "x", dataset: { case_count: 1.5 } }],
    ["a dataset that is a list", { type: "evaluation_started", name: "x", dataset: [3] }],
  ])("reads the case count as unknown for %s", (_, event) => {
    expect(readProgressEvent(JSON.stringify(event))).toEqual({
      type: "evaluation_started",
      name: "x",
      caseCount: null,
    });
  });

  it("reads a missing, empty or non-string name as unknown", () => {
    for (const name of [undefined, "", 7, null]) {
      const line = JSON.stringify({ type: "evaluation_started", name, dataset: { case_count: 0 } });
      expect(readProgressEvent(line)).toEqual({
        type: "evaluation_started",
        name: null,
        caseCount: 0,
      });
    }
    expect(readProgressEvent('{"type":"evaluation_completed"}')).toEqual({
      type: "evaluation_completed",
      name: null,
    });
  });

  it.each([
    ["a status of errored", { status: "errored" }],
    ["a task error", { status: "not_scored", task_error: "ValueError: no" }],
    ["a scorer error", { scorer_errors: [{ scorer_name: "x", message: "no" }] }],
    ["a task error, from a runner that writes no status", { task_error: "boom" }],
  ])("counts a finished case with %s as errored", (_, fields) => {
    const line = JSON.stringify({ type: "case_completed", case_id: "c", ...fields });

    expect(readProgressEvent(line)).toEqual({ type: "case_completed", errored: true });
  });

  it("counts a finished case with neither error as not errored, whatever else it lacks", () => {
    for (const fields of [
      { status: "not_scored", task_error: null, scorer_errors: [] },
      {},
      { task_error: "", scorer_errors: "none" },
    ]) {
      const line = JSON.stringify({ type: "case_completed", ...fields });
      expect(readProgressEvent(line)).toEqual({ type: "case_completed", errored: false });
    }
  });

  it("reads a case whose score Python wrote as a bare NaN", () => {
    const line =
      '{"type": "case_completed", "case_id": "c", "status": "not_scored", "scores": [{"value": NaN}], "task_error": null, "scorer_errors": []}';

    expect(readProgressEvent(line)).toEqual({ type: "case_completed", errored: false });
  });

  it.each([
    ["a line that isn't JSON", '{"type": "case_star'],
    ["a JSON value that isn't an object", "[1, 2]"],
    ["an empty line", ""],
    ["an event with no type", '{"case_id": "c"}'],
    ["an event of a type the line doesn't show", '{"type": "hello", "eval_api_version": 1}'],
    ["a fatal event", '{"type": "fatal", "kind": "import_error", "message": "no"}'],
  ])("skips %s", (_, line) => {
    expect(readProgressEvent(line)).toBeNull();
  });

  /** Every recorded stream, as the progress line reads it, line by line. */
  const recordings = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((sdk) =>
      readdirSync(join(FIXTURES, sdk.name)).map((scenario) => join(sdk.name, scenario)),
    );

  it.each(recordings)(
    "ends %s with the counts its runner reported for each evaluation",
    (recording) => {
      const text = readFileSync(join(FIXTURES, recording, "events.jsonl"), "utf8");
      const reported = parseEvents(text).filter((event) => event.type === "evaluation_completed");
      let progress = startingProgress();
      const counted: { name: string | null; cases: number; errored: number }[] = [];
      for (const line of text.split("\n")) {
        const event = readProgressEvent(line);
        if (event === null) {
          continue;
        }
        progress = advance(progress, event, true);
        if (event.type === "evaluation_completed") {
          counted.push({
            name: progress.name,
            cases: progress.completed,
            errored: progress.errored,
          });
        }
      }

      expect(counted).toEqual(
        reported.map((event) => ({
          name: event.name,
          cases: event.counts.cases,
          errored: event.counts.errored,
        })),
      );
    },
  );
});

describe("countsCasesItRuns", () => {
  it("takes traceroot's case count as the total, and not @traceroot-ai/traceroot's", () => {
    expect(countsCasesItRuns("python")).toBe(true);
    expect(countsCasesItRuns("typescript")).toBe(false);
    expect(countsCasesItRuns("javascript")).toBe(false);
  });
});

describe("advance", () => {
  it("counts the cases running now as those started and not yet finished", () => {
    const progress = progressAfter([started(5), caseStarted, caseStarted, caseStarted, passed]);

    expect(progress).toMatchObject({ phase: "running", started: 3, completed: 1, total: 5 });
    expect(describeProgress(progress).detail).toBe("1/5 cases done · 2 running · 0 errored");
  });

  it("counts an errored case as finished and as errored", () => {
    const progress = progressAfter([started(3), caseStarted, caseStarted, errored, passed]);

    expect(progress).toMatchObject({ completed: 2, errored: 1 });
    expect(describeProgress(progress).detail).toBe("2/3 cases done · 0 running · 1 errored");
  });

  it("shows no total for a runner whose case count isn't the cases it runs", () => {
    const progress = progressAfter([started(5), caseStarted, passed], false);

    expect(progress.total).toBeNull();
    expect(describeProgress(progress).detail).toBe("1 case done · 0 running · 0 errored");
  });

  it("shows no total when the runner gave none", () => {
    const progress = progressAfter([started(null), caseStarted, caseStarted, passed, passed]);

    expect(describeProgress(progress).detail).toBe("2 cases done · 0 running · 0 errored");
  });

  it("drops a total once more cases than it start", () => {
    const within = progressAfter([started(2), caseStarted, caseStarted, passed]);
    const past = advance(within, caseStarted, true);

    expect(within.total).toBe(2);
    expect(past.total).toBeNull();
    expect(describeProgress(past).detail).toBe("1 case done · 2 running · 0 errored");
  });

  it("starts the counts again for each evaluation in the file", () => {
    const first = progressAfter([started(2, "first"), caseStarted, errored, caseStarted, passed]);
    const finished = advance(first, { type: "evaluation_completed", name: "first" }, true);
    const second = advance(finished, started(4, "second"), true);

    expect(describeProgress(finished)).toEqual({
      subject: "first",
      detail: "finished · the runner is still working",
    });
    expect(second).toMatchObject({
      phase: "running",
      name: "second",
      total: 4,
      started: 0,
      completed: 0,
      errored: 0,
    });
    expect(describeProgress(second)).toEqual({
      subject: "second",
      detail: "0/4 cases done · 0 running · 0 errored",
    });
  });

  it("keeps the started evaluation's name when its completion gives none", () => {
    const progress = progressAfter([
      started(1, "named"),
      { type: "evaluation_completed", name: null },
    ]);

    expect(describeProgress(progress).subject).toBe("named");
  });

  it("counts cases from a runner that announced no evaluation", () => {
    const progress = progressAfter([caseStarted, passed, caseStarted]);

    expect(describeProgress(progress)).toEqual({
      subject: null,
      detail: "1 case done · 1 running · 0 errored",
    });
  });
});

describe("describeProgress", () => {
  it("waits for the runner before its first evaluation", () => {
    expect(describeProgress(startingProgress())).toEqual({
      subject: null,
      detail: "Waiting for the runner to start an evaluation",
    });
  });

  it("says the total in the singular for one case, and shows a total of none", () => {
    expect(describeProgress(progressAfter([started(1), caseStarted])).detail).toBe(
      "0/1 case done · 1 running · 0 errored",
    );
    expect(describeProgress(progressAfter([started(0)])).detail).toBe(
      "0/0 cases done · 0 running · 0 errored",
    );
  });

  it("says the runner is finishing once the suite has ended, without naming an evaluation", () => {
    const progress = progressAfter([started(1), caseStarted, passed, { type: "suite_completed" }]);

    expect(describeProgress(progress)).toEqual({
      subject: null,
      detail: "Waiting for the runner to exit",
    });
  });

  it("says the run is stopping once it was interrupted, in place of what runs", () => {
    const stop = (progress: RunProgress): RunProgress => ({ ...progress, stopping: true });

    expect(describeProgress(stop(startingProgress())).detail).toBe("Stopping the run");
    expect(
      describeProgress(stop(progressAfter([started(3), caseStarted, errored, caseStarted]))).detail,
    ).toBe("1/3 cases done · 1 errored · stopping");
    expect(
      describeProgress(
        stop(progressAfter([started(1), { type: "evaluation_completed", name: null }])),
      ).detail,
    ).toBe("finished · stopping");
  });

  it("keeps stopping when the runner starts another evaluation", () => {
    const stopping = { ...progressAfter([started(1, "first")]), stopping: true };

    expect(describeProgress(advance(stopping, started(2, "second"), true)).detail).toBe(
      "0/2 cases done · 0 errored · stopping",
    );
  });

  it("escapes control characters in the evaluation's name", () => {
    const progress = progressAfter([started(1, "evil\x1b[2Jname\nsecond line")]);

    const { subject } = describeProgress(progress);
    expect(subject).not.toContain("\x1b");
    expect(subject).not.toContain("\n");
    expect(subject).toContain("evil");
  });
});
