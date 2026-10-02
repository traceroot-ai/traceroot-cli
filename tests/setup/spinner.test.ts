import { describe, expect, it } from "vitest";
import type { Sink } from "../../src/output.js";
import { startLineSpinner } from "../../src/setup/spinner.js";
import { plain } from "./colour.js";

const ESC = String.fromCharCode(27);

function sink(isTTY: boolean): Sink & { data: string; writes: string[] } {
  const s = {
    data: "",
    writes: [] as string[],
    isTTY,
    write(chunk: string) {
      s.data += chunk;
      s.writes.push(chunk);
      return true;
    },
  };
  return s as unknown as Sink & { data: string; writes: string[] };
}

/** A spinner with a hand-driven clock and a hand-driven animation. */
function harness(isTTY = true, maxFeedLines?: number, deadline?: number) {
  const out = sink(isTTY);
  let clock = 0;
  const ticks: Array<() => void> = [];
  const spinner = startLineSpinner({
    sink: out,
    message: "waiting for sign-in",
    env: { TERM: "xterm" } as NodeJS.ProcessEnv,
    now: () => clock,
    maxFeedLines,
    deadline,
    animate: (tick) => {
      ticks.push(tick);
      return () => {
        const at = ticks.indexOf(tick);
        if (at !== -1) {
          ticks.splice(at, 1);
        }
      };
    },
  });
  return {
    spinner,
    out,
    advance: (ms: number) => {
      clock += ms;
    },
    tick: () => {
      for (const fire of [...ticks]) {
        fire();
      }
    },
    animating: () => ticks.length > 0,
  };
}

/** The CSI sequences this spinner is allowed to emit. */
const CSI = new RegExp(`^${ESC}\\[(\\d*)([A-Za-z])`);

/**
 * The smallest terminal that can judge redrawing: rows of text and a cursor.
 *
 * Asserting on escape codes only proves which bytes were written, not what a
 * user would be left looking at — and "what is left on screen" is the entire
 * question for a block that erases itself. Replaying the writes answers it.
 */
function screen() {
  const rows: string[] = [""];
  let row = 0;
  let col = 0;

  const put = (text: string): void => {
    const line = (rows[row] ?? "").padEnd(col, " ");
    rows[row] = line.slice(0, col) + text + line.slice(col + text.length);
    col += text.length;
  };

  return {
    write(chunk: string): void {
      let rest = chunk;
      while (rest !== "") {
        const csi = rest.match(CSI);
        if (csi !== null) {
          const count = csi[1] === "" ? 0 : Number(csi[1]);
          if (csi[2] === "A") {
            row = Math.max(0, row - Math.max(1, count));
          } else if (csi[2] === "K" && count === 2) {
            rows[row] = "";
          } else if (csi[2] === "J" && count === 0) {
            // Erase from the cursor to the bottom.
            rows[row] = (rows[row] ?? "").slice(0, col);
            rows.length = row + 1;
          }
          rest = rest.slice(csi[0].length);
          continue;
        }
        const char = rest[0] ?? "";
        if (char === "\n") {
          row += 1;
          col = 0;
          while (rows.length <= row) {
            rows.push("");
          }
        } else if (char === "\r") {
          col = 0;
        } else {
          put(char);
        }
        rest = rest.slice(1);
      }
    },
    lines: (): string[] => [...rows],
  };
}

describe("waiting for the browser", () => {
  it("spins from the moment it starts, without being told to", () => {
    const { out } = harness();
    expect(plain(out.data)).toMatch(/[◒◐◓◑]/u);
    expect(plain(out.data)).toContain("waiting for sign-in");
  });

  it("counts the wait once there is a number worth showing", () => {
    const { out, advance, tick } = harness();
    advance(12_000);
    tick();
    expect(plain(out.data)).toContain("[12s]");
  });

  it("leaves the counter at the terminal's own colour", () => {
    // Dimming it would treat it as a detail of the line rather than the line.
    // On the only line still moving that is backwards: through a long agent run
    // the number is the information, and dimming it hides the one thing that
    // tells a user the wizard is waiting rather than wedged.
    const { out, advance, tick } = harness();
    advance(12_000);
    tick();
    // Wording only. `harness()` gives a TTY sink, but picocolors is off across
    // this suite, so nothing here is coloured either way — which is why the
    // "counter is not dimmed" claim lives in `wizard.colour.test.ts`, where
    // colour is forced on and the assertion can actually fail.
    expect(out.data).toContain(" [12s]");
  });

  it("counts down instead, when the wait has a deadline", () => {
    // A sign-in link expires. Elapsed time answers "is this hung?"; the budget
    // answers "is the link still worth clicking?", which is the question a user
    // who tabbed away comes back with.
    const { out, advance, tick } = harness(true, undefined, 600_000);
    advance(2_000);
    tick();
    expect(plain(out.data)).toContain("[9m 58s left]");
  });

  it("drops the minutes once there are none", () => {
    const { out, advance, tick } = harness(true, undefined, 600_000);
    advance(555_000);
    tick();
    expect(plain(out.data)).toContain("[45s left]");
    // "left" is load-bearing: an unlabelled bracket reads as elapsed, which
    // would be the opposite of what it means.
    expect(plain(out.data)).not.toContain("[45s]");
  });

  it("falls back to elapsed once the deadline is behind it", () => {
    // The poll reports an expired link within a couple of seconds; until it
    // does, a frozen `[0s left]` would look like a hang.
    const { out, advance, tick } = harness(true, undefined, 600_000);
    advance(601_000);
    tick();
    expect(plain(out.data)).toContain("[601s]");
  });

  it("moves through clack's frames on its own", () => {
    const { out, tick } = harness();
    const first = plain(out.data);
    tick();
    tick();
    expect(plain(out.data).length).toBeGreaterThan(first.length);
    // More than one distinct frame has been drawn.
    const drawn = new Set((plain(out.data).match(/[◒◐◓◑]/gu) ?? []).values());
    expect(drawn.size).toBeGreaterThan(1);
  });
});

describe("not damaging what is already on screen", () => {
  it("never moves the cursor up, so the URL above it survives", () => {
    // The whole point: a user has to read a verification code and select a URL
    // with a mouse while this animates over them.
    const { spinner, advance, tick, out } = harness();
    advance(3000);
    tick();
    spinner.setMessage("approved — finish the remaining steps in your browser");
    tick();
    spinner.stop("Browser sign-in complete.");

    // Cursor-up (`ESC[<n>A`) would reach lines this spinner does not own.
    expect(plain(out.data)).not.toMatch(new RegExp(`${ESC}\\[\\d*A`, "u"));
    // Only ever erase-this-line and return-to-column-0.
    expect(plain(out.data)).toContain(`${ESC}[2K\r`);
  });

  it("writes exactly one newline, at the end", () => {
    // Every frame in between rewrites the same line; a newline per frame would
    // scroll the sign-in block away.
    const { spinner, tick, out } = harness();
    tick();
    tick();
    spinner.setMessage("approved");
    spinner.stop("Browser sign-in complete.");

    expect(plain(out.data).split("\n")).toHaveLength(2);
    expect(plain(out.data).endsWith("Browser sign-in complete.\n")).toBe(true);
  });

  it("changes the message in place rather than appending a line", () => {
    const { spinner, out } = harness();
    const before = plain(out.data);
    spinner.setMessage("approved — finish the remaining steps in your browser");

    expect(plain(out.data).slice(before.length)).not.toContain("\n");
    expect(plain(out.data)).toContain("approved — finish the remaining steps in your browser");
  });

  it("stops animating once it has settled", () => {
    const h = harness();
    expect(h.animating()).toBe(true);
    h.spinner.stop("Browser sign-in complete.");
    expect(h.animating()).toBe(false);
  });
});

describe("a feed accumulating above it", () => {
  it("keeps the spinner on the bottom as lines pile up", () => {
    const { spinner, out } = harness();
    spinner.writeAbove("run: ls -la /repo");
    spinner.writeAbove("read: barebone.py");

    // Each committed line is preceded by an erase of the spinner it replaced.
    const settled = plain(out.data)
      .split("\n")
      .filter((line) => line.includes("│  "))
      .map((line) => line.slice(line.indexOf("│")));
    expect(settled).toEqual(["│  run: ls -la /repo", "│  read: barebone.py"]);
    // Whatever is on the unterminated last line is the spinner, not a feed line.
    expect(plain(out.data).split("\n").at(-1)).toMatch(/[◒◐◓◑]/u);
  });

  it("never reaches a line it does not own", () => {
    // Cursor-up would let a long feed erase the wizard above it.
    const { spinner, out } = harness();
    for (const line of ["run: ls", "read: a.py", "write: b.py"]) {
      spinner.writeAbove(line);
    }
    spinner.stop("Claude Code finished; changed 1 file(s).");

    expect(plain(out.data)).not.toMatch(new RegExp(`${ESC}\\[\\d*A`, "u"));
    expect(plain(out.data)).toContain("│  write: b.py");
    expect(plain(out.data).endsWith("Claude Code finished; changed 1 file(s).\n")).toBe(true);
  });

  it("goes on counting the wait while the feed grows", () => {
    const { spinner, out, advance, tick } = harness();
    advance(34_000);
    spinner.writeAbove("write: test.py");
    tick();

    expect(plain(out.data)).toContain("[34s]");
  });
});

describe("taking the transcript away once the step is over", () => {
  /** Replays every write the spinner made onto a screen that already has content. */
  function replay(writes: readonly string[]): string[] {
    const term = screen();
    term.write("│  earlier output\n");
    for (const chunk of writes) {
      term.write(chunk);
    }
    return term.lines();
  }

  it("leaves one line where the whole block was", () => {
    const { spinner, out } = harness(true, 8);
    spinner.writeAbove("run: ls -la");
    spinner.writeAbove("read: barebone.py");
    spinner.writeAbove("write: barebone.py");
    spinner.stopAndClear("◆  Claude Code finished.");

    expect(replay(out.writes)).toEqual(["│  earlier output", "◆  Claude Code finished.", ""]);
  });

  it("still shows the transcript while the step is running", () => {
    // The lines are worth watching; they are only worthless afterwards. A block
    // that was never drawn would fix the complaint by removing the feature.
    const { spinner, out } = harness(true, 8);
    spinner.writeAbove("run: ls -la");
    spinner.writeAbove("read: barebone.py");

    expect(replay(out.writes)).toEqual([
      "│  earlier output",
      "│  run: ls -la",
      "│  read: barebone.py",
      "│",
      "◒  waiting for sign-in",
    ]);
  });

  it("keeps the transcript when the caller settles instead of clearing", () => {
    // A failed agent's feed is the only account of what it was doing.
    const { spinner, out } = harness(true, 8);
    spinner.writeAbove("run: pytest");
    spinner.stop("Claude Code exited with status 1.");

    expect(replay(out.writes)).toEqual([
      "│  earlier output",
      "│  run: pytest",
      "│",
      "│  Claude Code exited with status 1.",
      "",
    ]);
  });

  it("drops the oldest lines rather than growing past the window", () => {
    const { spinner, out } = harness(true, 2);
    for (const line of ["run: a", "run: b", "run: c"]) {
      spinner.writeAbove(line);
    }

    expect(replay(out.writes)).toEqual([
      "│  earlier output",
      "│  run: b",
      "│  run: c",
      "│",
      "◒  waiting for sign-in",
    ]);
  });

  it("stops animating", () => {
    const h = harness(true, 8);
    h.spinner.writeAbove("run: ls");
    h.spinner.stopAndClear("◆  Claude Code finished.");
    expect(h.animating()).toBe(false);
  });

  it("appends into a pipe instead of trying to erase it", () => {
    // The feed lines were flushed as they arrived; a cursor move into a CI log
    // is corruption, and the log is read after the fact anyway.
    const { spinner, out } = harness(false, 8);
    spinner.writeAbove("run: ls -la");
    spinner.stopAndClear("◆  Claude Code finished.");

    expect(out.data).not.toContain(ESC);
    expect(
      plain(out.data)
        .split("\n")
        .filter((line) => line !== ""),
    ).toEqual(["│  waiting for sign-in", "│  run: ls -la", "◆  Claude Code finished."]);
  });
});

describe("where there is no cursor to move", () => {
  it("writes plain lines into a pipe instead of escape codes", () => {
    // An erase sequence in a CI log is corruption, not animation.
    const { spinner, out, animating } = harness(false);
    spinner.setMessage("approved");
    spinner.stop("Browser sign-in complete.");

    expect(out.data).not.toContain(ESC);
    expect(animating()).toBe(false);
    // Still on the rail: the wizard draws its frame into a pipe too, and a bare
    // line falls outside it there exactly as it would on a terminal.
    expect(
      plain(out.data)
        .split("\n")
        .filter((line) => line !== ""),
    ).toEqual(["│  waiting for sign-in", "│  approved", "│  Browser sign-in complete."]);
  });

  it("refuses to redraw under NO_COLOR and TERM=dumb", () => {
    for (const env of [{ NO_COLOR: "1" }, { TERM: "dumb" }]) {
      const out = sink(true);
      const spinner = startLineSpinner({
        sink: out,
        message: "waiting",
        env: env as NodeJS.ProcessEnv,
        animate: () => () => undefined,
      });
      spinner.stop("done");
      expect(out.data).not.toContain(ESC);
    }
  });
});

describe("keeping one physical row per logical line", () => {
  it("clips a feed line to the sink's width", () => {
    // The redraw geometry counts lines and rewinds by that many rows, so a line
    // the terminal wraps costs a row the rewind does not know about — after
    // which every redraw eats one line of whatever sits above the spinner.
    const out = sink(true) as unknown as {
      data: string;
      write: (c: string) => boolean;
      columns: number;
    };
    out.columns = 40;
    let clock = 0;
    const ticks: Array<() => void> = [];
    const spinner = startLineSpinner({
      sink: out as never,
      message: "waiting for sign-in",
      env: { TERM: "xterm" } as NodeJS.ProcessEnv,
      now: () => clock,
      // A feed window is what makes the lines live: they are redrawn on every
      // frame, so their row count has to match what the rewind assumes.
      maxFeedLines: 3,
      animate: (tick: () => void) => {
        ticks.push(tick);
        return () => undefined;
      },
    });
    spinner.writeAbove(`run: ${"x".repeat(200)}`);
    clock += 1000;
    for (const fire of [...ticks]) {
      fire();
    }

    // The full line never reaches the sink; what does is clipped and marked.
    expect(out.data).not.toContain("x".repeat(200));
    expect(out.data).toContain("…");
    // Measured as the longest run of the filler rather than by splitting on
    // newlines: consecutive frames share a line, because a draw ends without one.
    const longest = Math.max(...(out.data.match(/x+/g) ?? [""]).map((run) => run.length));
    expect(longest).toBeLessThanOrEqual(40 - 3);
  });
});
