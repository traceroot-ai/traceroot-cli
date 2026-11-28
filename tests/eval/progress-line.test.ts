import { describe, expect, it } from "vitest";
import {
  type ProgressLineOptions,
  elapsed,
  fitLine,
  startProgressLine,
} from "../../src/eval/progress-line.js";
import { CLEAR_LINE, frames, screen } from "../helpers/screen.js";
import { StringSink } from "../helpers/stringSink.js";

/** A terminal of `columns` columns that keeps everything written to it. */
class TerminalSink extends StringSink {
  constructor(readonly columns = 80) {
    super(true);
  }
}

const event = (fields: object): string => JSON.stringify(fields);
const evaluationStarted = (name: string, caseCount?: number): string =>
  event({ type: "evaluation_started", name, run_mode: "full", dataset: { case_count: caseCount } });
const caseStarted = event({ type: "case_started", case_id: "c" });
const casePassed = event({ type: "case_completed", case_id: "c", status: "not_scored" });
const caseErrored = event({ type: "case_completed", case_id: "c", task_error: "ValueError: no" });

/** A progress line on a fake terminal, with a clock and an animation the test moves by hand. */
function start(options: Partial<ProgressLineOptions> & { columns?: number } = {}) {
  const sink = (options.sink as TerminalSink | undefined) ?? new TerminalSink(options.columns);
  let time = 1_000_000;
  let tick: (() => void) | null = null;
  let animating = false;
  const line = startProgressLine({
    sink,
    exactCount: true,
    now: () => time,
    animate: (next) => {
      tick = next;
      animating = true;
      return () => {
        animating = false;
      };
    },
    ...options,
  });
  return {
    sink,
    line,
    /** Moves the clock on by `ms` and draws the next frame, as the animation would. */
    advance(ms: number): void {
      time += ms;
      tick?.();
    },
    animating: () => animating,
    /** The last frame drawn, as a reader sees it. */
    last: (): string => frames(sink.data).at(-1) ?? "",
  };
}

describe("startProgressLine", () => {
  it("draws at once, before the runner has written anything", () => {
    const { last } = start();

    expect(last()).toBe("◒  Waiting for the runner to start an evaluation");
  });

  it("spins and counts the time the run has taken, with no estimate of the time left", () => {
    const run = start();

    run.advance(999);
    expect(run.last()).toBe("◐  Waiting for the runner to start an evaluation");
    run.advance(11_001);
    expect(run.last()).toBe("◓  Waiting for the runner to start an evaluation [12s]");
    run.advance(65_000);
    expect(run.last()).toBe("◑  Waiting for the runner to start an evaluation [1m 17s]");
  });

  it("shows the evaluation's name, cases done out of its total, cases running and errors", () => {
    const run = start();

    run.line.events([evaluationStarted("uppercase", 10), caseStarted, caseStarted, caseStarted]);
    expect(run.last()).toBe("◒  uppercase · 0/10 cases done · 3 running · 0 errored");
    run.line.events([casePassed, caseErrored]);
    run.advance(4000);
    expect(run.last()).toBe("◐  uppercase · 2/10 cases done · 1 running · 1 errored [4s]");
  });

  it("shows only the cases done when the runner's count isn't the total", () => {
    const run = start({ exactCount: false });

    run.line.events([evaluationStarted("uppercase", 10), caseStarted, casePassed]);

    expect(run.last()).toBe("◒  uppercase · 1 case done · 0 running · 0 errored");
    expect(frames(run.sink.data).join("\n")).not.toContain("/10");
  });

  it("skips a line it can't read, and redraws only for an event it shows", () => {
    const run = start();
    run.line.events([evaluationStarted("uppercase", 2)]);
    const drawn = frames(run.sink.data).length;

    run.line.events(['{"type":"case_sta', '{"type":"hello","eval_api_version":1}']);
    expect(frames(run.sink.data)).toHaveLength(drawn);
    run.line.events(["not json", caseStarted]);
    expect(run.last()).toBe("◒  uppercase · 0/2 cases done · 1 running · 0 errored");
  });

  it("shows a file of several evaluations one at a time, and says when one has finished", () => {
    const run = start();

    run.line.events([evaluationStarted("first", 1), caseStarted, casePassed]);
    run.line.events([event({ type: "evaluation_completed", name: "first", status: "completed" })]);
    expect(run.last()).toBe("◒  first · finished · the runner is still working");
    run.line.events([evaluationStarted("second", 3), caseStarted]);
    expect(run.last()).toBe("◒  second · 0/3 cases done · 1 running · 0 errored");
  });

  it("says the run is stopping once it is interrupted", () => {
    const run = start();
    run.line.events([evaluationStarted("uppercase", 3), caseStarted, casePassed, caseStarted]);

    run.line.stopping();

    expect(run.last()).toBe("◒  uppercase · 1/3 cases done · 0 errored · stopping");
  });

  it("shortens a long name to keep the counts in view at 80 columns, and never fills the row", () => {
    const run = start({ columns: 80 });
    const name = `evaluation-${"long-".repeat(20)}name`;

    run.line.events([evaluationStarted(name, 1000), caseStarted, caseStarted, caseErrored]);
    run.advance(125_000);

    const shown = run.last();
    expect(shown).toMatch(
      /^◐ {2}evaluation-long-.*… · 1\/1000 cases done · 1 running · 1 errored \[2m 5s\]$/,
    );
    for (const frame of frames(run.sink.data)) {
      expect(frame.length).toBeLessThan(80);
    }
  });

  it("counts each character other than ASCII as two columns, so a wide name can't wrap", () => {
    const run = start({ columns: 60 });

    run.line.events([evaluationStarted("評価".repeat(20), 5), caseStarted]);

    const shown = run.last();
    // The spinner, then two columns for each character other than ASCII.
    const columns = [...shown].reduce((sum, char) => sum + (char.charCodeAt(0) < 0x80 ? 1 : 2), 0);
    expect(columns).toBeLessThan(60);
    expect(shown).toBe("◒  評価評価… · 0/5 cases done · 1 running · 0 errored");
  });

  it("fits a frame to the terminal's width now, before the stream has heard of a resize", () => {
    // The stream still says 100 columns; its handle, asked directly, says the terminal is now 40.
    const sink = Object.assign(new TerminalSink(100), {
      _handle: {
        getWindowSize: (size: number[]): number => {
          size[0] = 40;
          size[1] = 24;
          return 0;
        },
      },
    });
    const run = start({ sink });

    run.line.events([evaluationStarted(`evaluation-${"long-".repeat(20)}name`, 10), caseStarted]);

    expect(run.last()).toBe("◒  evaluation-long-long-long-long-lo…");
    // A frame that fits never wraps, so erasing its one row leaves nothing behind.
    for (const frame of frames(run.sink.data)) {
      expect(frame.length).toBeLessThan(40);
    }
  });

  it("falls back to the width the stream says when its handle can't say", () => {
    const sink = Object.assign(new TerminalSink(60), {
      _handle: { getWindowSize: (): number => -22 },
    });
    const run = start({ sink });

    run.line.events([evaluationStarted("x".repeat(70), 3)]);

    // Cut to the stream's 60 columns; the 80 taken for a terminal that says nothing shows more.
    expect(run.last()).toBe(`◒  ${"x".repeat(9)}… · 0/3 cases done · 0 running · 0 errored`);
  });

  it("takes a terminal that reports no width as 80 columns wide", () => {
    const run = start({ columns: 0 });

    run.line.events([evaluationStarted("uppercase", 3)]);

    expect(run.last()).toBe("◒  uppercase · 0/3 cases done · 0 running · 0 errored");
  });

  it("writes the runner's complete lines above itself, and holds a partial one until its newline", () => {
    const run = start();
    run.line.events([evaluationStarted("uppercase", 3), caseStarted]);

    run.line.write("Calling the model\nhalf of a li");
    expect(screen(run.sink.data)).toEqual([
      "Calling the model",
      "◒  uppercase · 0/3 cases done · 1 running · 0 errored",
    ]);
    run.line.write("ne\n");
    expect(screen(run.sink.data)).toEqual([
      "Calling the model",
      "half of a line",
      "◒  uppercase · 0/3 cases done · 1 running · 0 errored",
    ]);
  });

  it("is erased at the end and leaves nothing behind, with a partial line written as it was", () => {
    const run = start();
    run.line.events([evaluationStarted("uppercase", 3), caseStarted]);
    run.line.write("done\nno newline at the end");

    run.line.end();

    expect(screen(run.sink.data)).toEqual(["done", "no newline at the end"]);
    expect(run.sink.data.endsWith(`${CLEAR_LINE}no newline at the end`)).toBe(true);
    // Its own rows were never committed: every newline is one the runner wrote.
    expect(run.sink.data.split("\n")).toHaveLength(2);
    expect(run.animating()).toBe(false);
  });

  it("ends once, and passes anything written after it straight on", () => {
    const run = start();
    run.line.end();
    const ended = run.sink.data;

    run.line.end();
    run.advance(5000);
    run.line.events([evaluationStarted("late", 1)]);
    run.line.stopping();
    run.line.write("late output");

    expect(run.sink.data).toBe(`${ended}late output`);
    expect(screen(run.sink.data)).toEqual(["late output"]);
  });
});

describe("fitLine", () => {
  it("leaves a line that fits as it is", () => {
    expect(fitLine({ subject: "a", detail: "b" }, "3s", 80)).toBe("a · b [3s]");
    expect(fitLine({ subject: null, detail: "b" }, "", 80)).toBe("b");
  });

  it("cuts the whole line when even a short name wouldn't leave room for the rest", () => {
    const fitted = fitLine({ subject: "name", detail: "x".repeat(40) }, "1s", 30);

    expect(fitted).toBe(`name · ${"x".repeat(15)}…`);
  });
});

describe("elapsed", () => {
  it("says nothing in the first second, then seconds, then minutes and seconds", () => {
    expect(elapsed(0)).toBe("");
    expect(elapsed(999)).toBe("");
    expect(elapsed(1000)).toBe("1s");
    expect(elapsed(59_999)).toBe("59s");
    expect(elapsed(60_000)).toBe("1m 0s");
    expect(elapsed(3_725_000)).toBe("62m 5s");
  });
});
