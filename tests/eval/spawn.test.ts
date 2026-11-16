import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunOutcome } from "../../src/eval/events.js";
import { type RunEvalRunnerOptions, runEvalRunner, runnerEnv } from "../../src/eval/spawn.js";
import { makeSecret } from "../../src/setup/secret.js";
import { StringSink } from "../helpers/stringSink.js";

const NODE = process.execPath;
/** Process groups, and so the forwarding of a terminal signal to one, are POSIX-only. */
const WINDOWS = process.platform === "win32";
const FIXTURES = fileURLToPath(new URL("../fixtures/eval/", import.meta.url));

/** Every environment a stub runner gets starts from this, so nothing from the test's own leaks in. */
const BASE_ENV = { PATH: process.env.PATH ?? "" };

/**
 * The start of every stub runner. `say` writes a line to stderr without buffering, so it survives
 * an immediate `process.exit`. `emit` appends one event the way the runners do. `ready` prints
 * the line a test reads the runner's pid and event file from, once the stub is set up.
 */
const PRELUDE = [
  'const fs = require("node:fs");',
  "const say = (text) => fs.writeSync(2, `${text}\\n`);",
  "const emit = (event) =>",
  "  fs.appendFileSync(process.env.TRACEROOT_EVAL_EVENT_FILE, `${JSON.stringify(event)}\\n`);",
  "const ready = () => say(`runner ${process.pid} ${process.env.TRACEROOT_EVAL_EVENT_FILE}`);",
].join("\n");

/** A stub runner: Node evaluating `body` after {@link PRELUDE}. */
function stub(...body: string[]): string[] {
  return [NODE, "-e", [PRELUDE, ...body].join("\n")];
}

/** A statement that appends `event` to the event file. */
function emit(event: object): string {
  return `emit(${JSON.stringify(event)});`;
}

const hello = { type: "hello", sdk_version: "0.5.1", eval_api_version: 1, capabilities: {} };
const started = { type: "evaluation_started", name: "uppercase", run_mode: "full" };
const caseStarted = { type: "case_started", case_id: "case-0" };
const caseCompleted = { type: "case_completed", case_id: "case-0", status: "not_scored" };
const counts = { cases: 1, errored: 0, task_errors: 0, scorer_errors: 0, not_scored: 1 };

function evaluationCompleted(status: string) {
  return {
    type: "evaluation_completed",
    name: "uppercase",
    status,
    local_run_id: "run_00000000000000000000000001",
    run_id: null,
    counts,
  };
}

/** Where a stub said it was: its pid, and the event file it was given. */
function runnerLine(output: string): { pid: number; eventFile: string } {
  const match = /^runner (\d+) (.+)$/m.exec(output);
  if (match === null) {
    throw new Error(`the stub runner never said it was ready:\n${output}`);
  }
  return { pid: Number(match[1]), eventFile: match[2] as string };
}

/** Pids of every stub runner a test started, killed after each test in case it failed early. */
const runners: number[] = [];

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs a stub in this process, and checks that its event file is gone afterwards. */
async function run(
  argv: string[],
  options: Pick<RunEvalRunnerOptions, "env" | "cwd" | "upload"> = {},
): Promise<{ outcome: RunOutcome; output: string }> {
  const sink = new StringSink();
  const outcome = await runEvalRunner({ argv, output: sink, env: BASE_ENV, ...options });
  const { pid, eventFile } = runnerLine(sink.data);
  runners.push(pid);
  expect(existsSync(eventFile)).toBe(false);
  expect(existsSync(dirname(eventFile))).toBe(false);
  return { outcome, output: sink.data };
}

afterEach(() => {
  for (const pid of runners.splice(0)) {
    try {
      // Each runner leads its own process group, so this reaches anything it started too.
      process.kill(WINDOWS ? pid : -pid, "SIGKILL");
    } catch {
      // Already gone, which is the expected case.
    }
  }
});

describe("runnerEnv", () => {
  it("removes the API key under any spelling, and turns tracing and reporting off", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/someone",
      TRACEROOT_HOST_URL: "https://traceroot.example",
      TRACEROOT_API_KEY: "tr-test-0000",
      Traceroot_Api_Key: "tr-test-0001",
      TRACEROOT_ENABLED: "true",
      TRACEROOT_EVAL_OPTIONS: '{"reporting":true}',
      TRACEROOT_EVAL_EVENT_FILE: "/somewhere/else.jsonl",
    };
    const before = { ...parent };

    expect(runnerEnv(parent, "/tmp/run/events.jsonl")).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      TRACEROOT_HOST_URL: "https://traceroot.example",
      TRACEROOT_ENABLED: "false",
      TRACEROOT_EVAL_OPTIONS: "{}",
      TRACEROOT_EVAL_EVENT_FILE: "/tmp/run/events.jsonl",
    });
    expect(parent).toEqual(before);
  });

  it("names no event file when given none, for a process started before the runner", () => {
    const parent = {
      PATH: "/usr/bin",
      TRACEROOT_API_KEY: "tr-test-0000",
      TRACEROOT_EVAL_EVENT_FILE: "/somewhere/else.jsonl",
    };

    expect(runnerEnv(parent)).toEqual({
      PATH: "/usr/bin",
      TRACEROOT_ENABLED: "false",
      TRACEROOT_EVAL_OPTIONS: "{}",
    });
  });

  it("gives an uploaded run the key and host it is given, with reporting and tracing on", () => {
    const parent = {
      PATH: "/usr/bin",
      TRACEROOT_HOST_URL: "https://elsewhere.example",
      Traceroot_Host_Url: "https://elsewhere.example",
      TRACEROOT_API_KEY: "tr-test-0000",
      Traceroot_Api_Key: "tr-test-0001",
      TRACEROOT_ENABLED: "false",
      TRACEROOT_EVAL_OPTIONS: "{}",
    };
    const upload = { host: "https://traceroot.example", apiKey: makeSecret("tr-test-upload-0002") };

    expect(runnerEnv(parent, "/tmp/run/events.jsonl", upload)).toEqual({
      PATH: "/usr/bin",
      TRACEROOT_API_KEY: "tr-test-upload-0002",
      TRACEROOT_HOST_URL: "https://traceroot.example",
      TRACEROOT_ENABLED: "true",
      TRACEROOT_EVAL_OPTIONS: '{"reporting":true}',
      TRACEROOT_EVAL_EVENT_FILE: "/tmp/run/events.jsonl",
    });
  });
});

describe("runEvalRunner", () => {
  it("never hands the runner the CLI's API key, and always turns tracing off", async () => {
    const show = (name: string) => `${name}=\${process.env.${name} ?? "(unset)"}`;
    const { output } = await run(
      stub(
        "ready();",
        `say(\`${show("TRACEROOT_API_KEY")}\`);`,
        `say(\`${show("TRACEROOT_ENABLED")}\`);`,
        `say(\`${show("TRACEROOT_EVAL_OPTIONS")}\`);`,
        `say(\`${show("KEPT")}\`);`,
        emit(hello),
        emit({ type: "suite_completed", evaluations: 0, cancelled: false }),
      ),
      {
        env: {
          ...BASE_ENV,
          KEPT: "yes",
          TRACEROOT_API_KEY: "tr-test-0000",
          TRACEROOT_ENABLED: "true",
          TRACEROOT_EVAL_OPTIONS: '{"reporting":true}',
        },
      },
    );

    expect(output).toContain("TRACEROOT_API_KEY=(unset)");
    expect(output).toContain("TRACEROOT_ENABLED=false");
    expect(output).toContain("TRACEROOT_EVAL_OPTIONS={}");
    expect(output).toContain("KEPT=yes");
    expect(output).not.toContain("tr-test-0000");
  });

  it("hands an uploaded run its key and host, and scrubs the key from what it writes", async () => {
    const key = "tr-test-upload-0003";
    const show = (name: string) => `${name}=\${process.env.${name} ?? "(unset)"}`;
    const { outcome, output } = await run(
      stub(
        "ready();",
        `say(\`${show("TRACEROOT_API_KEY")}\`);`,
        `say(\`${show("TRACEROOT_HOST_URL")}\`);`,
        `say(\`${show("TRACEROOT_ENABLED")}\`);`,
        `say(\`${show("TRACEROOT_EVAL_OPTIONS")}\`);`,
        emit(hello),
        'emit({ type: "fatal", kind: "harness_error", message: `rejected ${process.env.TRACEROOT_API_KEY}` });',
      ),
      {
        env: { ...BASE_ENV, TRACEROOT_ENABLED: "false" },
        upload: { host: "https://traceroot.example", apiKey: makeSecret(key) },
      },
    );

    expect(output).toContain("TRACEROOT_API_KEY=<redacted>");
    expect(output).toContain("TRACEROOT_HOST_URL=https://traceroot.example");
    expect(output).toContain("TRACEROOT_ENABLED=true");
    expect(output).toContain('TRACEROOT_EVAL_OPTIONS={"reporting":true}');
    expect(output).not.toContain(key);
    expect(outcome).toEqual({
      outcome: "fatal",
      kind: "harness_error",
      message: "rejected <redacted>",
      evaluations: [],
    });
  });

  it.each([0, 1, 8, 15, 16, 17])(
    "scrubs a key whose first %i characters end one chunk of the runner's output",
    async (split) => {
      const key = "tr-test-upload-04";
      // Two writes far enough apart to reach the CLI as two chunks, the key split between them.
      const { output } = await run(
        stub(
          "ready();",
          "const key = process.env.TRACEROOT_API_KEY;",
          `fs.writeSync(2, \`before \${key.slice(0, ${split})}\`);`,
          `setTimeout(() => fs.writeSync(2, \`\${key.slice(${split})} after\`), 200);`,
        ),
        { env: BASE_ENV, upload: { host: "https://traceroot.example", apiKey: makeSecret(key) } },
      );

      expect(output).not.toContain(key);
      expect(output.slice(output.lastIndexOf("\n") + 1)).toBe("before <redacted> after");
    },
  );

  it("passes on output that no key could start at the end of at once, while the runner runs", async () => {
    const key = "tr-test-upload-0006";
    const folder = mkdtempSync(join(tmpdir(), "traceroot-eval-shown-"));
    const shown = join(folder, "shown");
    let output = "";
    // Tells the runner once its line has come through.
    const sink = {
      write: (text: string): boolean => {
        output += text;
        if (output.includes("Calling the model for case 1\n")) {
          writeFileSync(shown, "");
        }
        return true;
      },
    };
    // The runner prints a line, then waits until the CLI has passed it on, or 5 seconds.
    const argv = stub(
      "ready();",
      'say("Calling the model for case 1");',
      "const since = Date.now();",
      "const poll = setInterval(() => {",
      `  if (fs.existsSync(${JSON.stringify(shown)})) {`,
      '    say("case 1 done");',
      "    clearInterval(poll);",
      "  } else if (Date.now() - since > 5000) {",
      '    say("gave up waiting");',
      "    clearInterval(poll);",
      "  }",
      "}, 20);",
    );

    try {
      await runEvalRunner({
        argv,
        output: sink,
        env: BASE_ENV,
        upload: { host: "https://traceroot.example", apiKey: makeSecret(key) },
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    runners.push(runnerLine(output).pid);

    expect(output).toContain("Calling the model for case 1\ncase 1 done\n");
    expect(output).not.toContain("gave up waiting");
  });

  it("never cuts a character in two where it holds back the end of a chunk", async () => {
    const key = "tr-test-upload-0005";
    // The chunk ends with the start of the key, held back from right after the emoji's two units.
    const chunk = `a😀${key.slice(0, 5)}`;
    const bytes: Buffer[] = [];
    // A sink that encodes each write on its own, as a stream does, so half a character shows.
    const sink = {
      write: (text: string) => bytes.push(Buffer.from(text, "utf8")) > 0,
    };
    const argv = stub(
      "ready();",
      "setTimeout(() => fs.writeSync(2, process.env.STUB_CHUNK), 200);",
      "setTimeout(() => fs.writeSync(2, ' after'), 400);",
    );

    await runEvalRunner({
      argv,
      output: sink,
      env: { ...BASE_ENV, STUB_CHUNK: chunk },
      upload: { host: "https://traceroot.example", apiKey: makeSecret(key) },
    });
    const output = Buffer.concat(bytes).toString("utf8");
    runners.push(runnerLine(output).pid);

    expect(output.slice(output.lastIndexOf("\n") + 1)).toBe(`${chunk} after`);
  });

  it("runs the runner in the CLI's directory unless told otherwise", async () => {
    const where = stub("ready();", "say(`cwd ${process.cwd()}`);");
    const folder = mkdtempSync(join(tmpdir(), "traceroot-eval-cwd-"));
    try {
      const byDefault = await run(where);
      const given = await run(where, { cwd: folder });

      expect(byDefault.output).toContain(`cwd ${realpathSync(process.cwd())}\n`);
      expect(given.output).toContain(`cwd ${realpathSync(folder)}\n`);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("sends both the runner's stdout and its stderr to the output it is given", async () => {
    const { output } = await run(
      stub("ready();", 'fs.writeSync(1, "printed by the evaluation\\n");', 'say("a warning");'),
    );

    expect(output).toContain("printed by the evaluation\n");
    expect(output).toContain("a warning\n");
  });

  it("removes its signal and exit listeners once the runner has exited", async () => {
    const listeners = () =>
      ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit"].map((name) => process.listenerCount(name));
    const before = listeners();

    await run(stub("ready();"));

    expect(listeners()).toEqual(before);
  });

  describe("replaying the recorded runs", () => {
    /** Copies a recorded event stream into the event file, then exits with `process.argv[2]`. */
    const replay = (events: string, status: number): string[] => [
      ...stub(
        "ready();",
        "fs.copyFileSync(process.argv[1], process.env.TRACEROOT_EVAL_EVENT_FILE);",
        "process.exit(Number(process.argv[2]));",
      ),
      events,
      String(status),
    ];

    const completed = (status: string, cases: number, errors: Record<string, number> = {}) => ({
      outcome: "completed",
      evaluations: [
        {
          type: "evaluation_completed",
          name: "uppercase",
          status,
          local_run_id: "run_00000000000000000000000001",
          run_id: null,
          counts: {
            cases,
            errored: 0,
            task_errors: 0,
            scorer_errors: 0,
            not_scored: cases - (errors.errored ?? 0),
            ...errors,
          },
        },
      ],
    });

    /** Both runners save the interrupted run as incomplete, under the recording's run id. */
    const interruptedRecording = {
      outcome: "interrupted",
      signal: null,
      evaluations: [
        expect.objectContaining({
          name: "uppercase",
          status: "incomplete",
          local_run_id: "run_00000000000000000000000001",
        }),
      ],
    };

    const expected: Record<string, unknown> = {
      "all-pass": completed("completed", 3),
      "one-fails": completed("completed", 3),
      "numeric-no-threshold": completed("completed", 3),
      sampled: completed("completed", 1),
      "inline-rows-a": completed("completed", 2),
      "inline-rows-b": completed("completed", 2),
      "task-error": completed("completed_with_errors", 3, { errored: 1, task_errors: 1 }),
      "scorer-error-unversioned": completed("completed_with_errors", 3, {
        errored: 1,
        scorer_errors: 1,
      }),
      "scorer-error-versioned": completed("completed_with_errors", 3, {
        errored: 1,
        scorer_errors: 1,
      }),
      interrupted: interruptedRecording,
      "no-evaluations": { outcome: "no_evaluations" },
      "import-error": {
        outcome: "fatal",
        kind: "import_error",
        message: expect.stringContaining("helpers"),
        evaluations: [],
      },
      "upload-plain-list": {
        outcome: "fatal",
        kind: "harness_error",
        message: expect.stringContaining("no synced dataset to report against"),
        evaluations: [],
      },
    };

    const recordings = readdirSync(FIXTURES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((sdk) =>
        readdirSync(join(FIXTURES, sdk.name)).map((scenario) => ({ sdk: sdk.name, scenario })),
      );

    it.each(recordings)("$sdk/$scenario gives its expected outcome", async ({ sdk, scenario }) => {
      const dir = join(FIXTURES, sdk, scenario);
      const status = Number(readFileSync(join(dir, "exit-status"), "utf8"));

      const { outcome } = await run(replay(join(dir, "events.jsonl"), status));

      expect(scenario in expected, `no expected outcome for ${scenario}`).toBe(true);
      expect(outcome).toEqual(expected[scenario]);
    });

    it.each(["python-0.5.1", "typescript-0.8.1"])(
      "%s's interrupted run reads as interrupted even when the runner exits 0",
      async (sdk) => {
        const events = join(FIXTURES, sdk, "interrupted", "events.jsonl");

        const { outcome } = await run(replay(events, 0));

        expect(outcome).toEqual(interruptedRecording);
      },
    );
  });

  describe("a runner that stops early", () => {
    it("is crashed with its status and last output when it exits non-zero partway through", async () => {
      const { outcome } = await run(
        stub(
          "ready();",
          emit(hello),
          emit(started),
          emit(caseStarted),
          'say("Traceback (most recent call last):");',
          'say("RuntimeError: the worker died");',
          "process.exit(3);",
        ),
      );

      expect(outcome).toMatchObject({ outcome: "crashed", exitStatus: 3 });
      const tail = (outcome as { outputTail: string[] }).outputTail;
      expect(tail.slice(-2)).toEqual([
        "Traceback (most recent call last):",
        "RuntimeError: the worker died",
      ]);
    });

    it.skipIf(WINDOWS)(
      "is crashed, never completed, when it is killed partway through",
      async () => {
        // Every evaluation has finished; only the suite's own last event is missing.
        const { outcome } = await run(
          stub(
            "ready();",
            emit(hello),
            emit(started),
            emit(caseStarted),
            emit(caseCompleted),
            emit(evaluationCompleted("completed")),
            'process.kill(process.pid, "SIGKILL");',
          ),
        );

        expect(outcome).toMatchObject({
          outcome: "crashed",
          exitStatus: 128 + 9,
          evaluations: [evaluationCompleted("completed")],
        });
      },
    );

    it("is crashed when it exits 0 without writing a single event", async () => {
      const { outcome } = await run(stub("ready();"));

      expect(outcome).toMatchObject({ outcome: "crashed", exitStatus: 0 });
    });

    it("is interrupted when it exits 130, whatever its events say", async () => {
      const { outcome } = await run(
        stub("ready();", emit(hello), emit(started), emit(caseStarted), "process.exit(130);"),
      );

      expect(outcome).toEqual({ outcome: "interrupted", signal: null, evaluations: [] });
    });
  });
});

/**
 * These tests signal or end the process that runs {@link runEvalRunner}, so it has to be a process
 * of its own: this harness, run from the built CLI. It prints the outcome and its signal and exit
 * listener counts on stdout, and the runner's output goes to its stderr, as it would in the CLI. As
 * in the CLI, a closed stderr (EPIPE) ends it through `handlePipeError`. A SIGUSR2 makes it throw
 * an exception nothing catches. It passes on the early exit code it is started with, if any.
 */
describe.skipIf(WINDOWS)("the CLI's process while the runner is running", () => {
  let harnessFolder = "";
  let harnessFile = "";
  const harnesses: ChildProcess[] = [];

  beforeAll(() => {
    const spawnModule = new URL("../../dist/eval/spawn.js", import.meta.url).href;
    const outputModule = new URL("../../dist/output.js", import.meta.url).href;
    harnessFolder = mkdtempSync(join(tmpdir(), "traceroot-eval-harness-"));
    harnessFile = join(harnessFolder, "harness.mjs");
    writeFileSync(
      harnessFile,
      [
        `const { runEvalRunner } = await import(${JSON.stringify(spawnModule)});`,
        `const { handlePipeError } = await import(${JSON.stringify(outputModule)});`,
        'process.stderr.on("error", (error) => handlePipeError(error));',
        'process.on("SIGUSR2", () => { throw new Error("an exception nothing catches"); });',
        "const [argv, interruptGraceMs, earlyExitCode] = JSON.parse(process.argv[2]);",
        'const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit"];',
        "const listeners = () => signals.map((name) => process.listenerCount(name));",
        "const before = listeners();",
        'const env = { PATH: process.env.PATH ?? "" };',
        "const options = { argv, interruptGraceMs, env, earlyExitCode: earlyExitCode ?? undefined };",
        "const outcome = await runEvalRunner(options);",
        "const result = { outcome, listeners: { before, after: listeners() } };",
        "process.stdout.write(`${JSON.stringify(result)}\\n`);",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(harnessFolder, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const harness of harnesses.splice(0)) {
      if (harness.exitCode === null && harness.signalCode === null) {
        harness.kill("SIGKILL");
      }
    }
  });

  interface Finished {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }

  /** Starts the harness on a stub runner, and waits until the stub says it is ready. */
  async function startHarness(argv: string[], interruptGraceMs: number, earlyExitCode?: number) {
    const options = [argv, interruptGraceMs, earlyExitCode ?? null];
    const child = spawn(NODE, [harnessFile, JSON.stringify(options)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    harnesses.push(child);
    let stdout = "";
    let stderr = "";
    let closed = false;
    const checks = new Set<() => void>();
    const recheck = (): void => {
      for (const check of [...checks]) {
        check();
      }
    };
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      recheck();
    });
    const finished = new Promise<Finished>((resolve) => {
      child.on("close", (code, signal) => {
        closed = true;
        recheck();
        resolve({ code, signal, stdout, stderr });
      });
    });

    /** Resolves once the runner's output, as the harness passed it on, matches `pattern`. */
    const waitFor = (pattern: RegExp): Promise<void> =>
      new Promise((resolve, reject) => {
        const check = (): void => {
          if (pattern.test(stderr)) {
            checks.delete(check);
            resolve();
          } else if (closed) {
            checks.delete(check);
            reject(new Error(`the harness exited before ${pattern}:\n${stdout}${stderr}`));
          }
        };
        checks.add(check);
        check();
      });

    await waitFor(/^runner \d+ .+$/m);
    const runner = runnerLine(stderr);
    runners.push(runner.pid);
    return { child, runner, finished, waitFor };
  }

  /**
   * Checks what every interrupted run has in common once the harness has exited, and that the
   * outcome names the first signal and keeps the evaluations the runner recorded.
   */
  function expectInterrupted(
    finished: Finished,
    runner: { pid: number; eventFile: string },
    signal: string,
    evaluations: object[] = [],
  ) {
    // The CLI wasn't ended by the signal: it went on to read the outcome.
    expect(finished.code).toBe(0);
    const lines = finished.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0] as string) as {
      outcome: RunOutcome;
      listeners: { before: number[]; after: number[] };
    };
    expect(result.outcome).toEqual({ outcome: "interrupted", signal, evaluations });
    expect(result.listeners.after).toEqual(result.listeners.before);
    expect(isRunning(runner.pid)).toBe(false);
    expect(existsSync(runner.eventFile)).toBe(false);
    expect(existsSync(dirname(runner.eventFile))).toBe(false);
  }

  /** A runner mid-case that ignores SIGINT, and says so; SIGTERM ends it, and it says that too. */
  const stubborn = stub(
    emit(hello),
    emit(started),
    emit(caseStarted),
    'process.on("SIGINT", () => say("ignoring SIGINT"));',
    'process.on("SIGTERM", () => { say("ended by SIGTERM"); process.exit(143); });',
    "setInterval(() => {}, 1000);",
    "ready();",
  );

  it("lets the runner finish its case on a Ctrl+C, then reads the event file and removes it", async () => {
    // Like @traceroot-ai/traceroot: the case in flight finishes, then the run ends cancelled.
    const finishesItsCase = stub(
      emit(hello),
      emit(started),
      emit(caseStarted),
      'process.on("SIGINT", () => {',
      `  ${emit(caseCompleted)}`,
      `  ${emit(evaluationCompleted("incomplete"))}`,
      `  ${emit({ type: "suite_completed", evaluations: 1, cancelled: true })}`,
      '  say("finished the case in flight");',
      "  process.exit(130);",
      "});",
      "setInterval(() => {}, 1000);",
      "ready();",
    );
    // Long enough that only the runner's own exit can end this test in time.
    const { child, runner, finished } = await startHarness(finishesItsCase, 60_000);

    child.kill("SIGINT");
    const result = await finished;

    expect(result.stderr).toContain("finished the case in flight");
    expectInterrupted(result, runner, "SIGINT", [evaluationCompleted("incomplete")]);
  });

  it("kills a runner that ignores a Ctrl+C once the deadline passes", async () => {
    const graceMs = 1000;
    const { child, runner, finished, waitFor } = await startHarness(stubborn, graceMs);

    const signalled = Date.now();
    child.kill("SIGINT");
    await waitFor(/ignoring SIGINT/);
    const result = await finished;

    expect(Date.now() - signalled).toBeGreaterThanOrEqual(graceMs - 50);
    expect(result.stderr).toMatch(/ignoring SIGINT\n[\s\S]*ended by SIGTERM/);
    expectInterrupted(result, runner, "SIGINT");
  });

  it("kills the runner at once on a second Ctrl+C", async () => {
    // A deadline far past this test's own timeout, so only the second signal can end the runner.
    const { child, runner, finished, waitFor } = await startHarness(stubborn, 60_000);

    child.kill("SIGINT");
    await waitFor(/ignoring SIGINT/);
    child.kill("SIGINT");
    const result = await finished;

    expect(result.stderr).toContain("ended by SIGTERM");
    expectInterrupted(result, runner, "SIGINT");
  });

  it("kills the runner at once on a SIGTERM after a Ctrl+C, and keeps the Ctrl+C", async () => {
    const { child, runner, finished, waitFor } = await startHarness(stubborn, 60_000);

    child.kill("SIGINT");
    await waitFor(/ignoring SIGINT/);
    child.kill("SIGTERM");
    const result = await finished;

    expect(result.stderr).toContain("ended by SIGTERM");
    expectInterrupted(result, runner, "SIGINT");
  });

  /** A runner mid-run with no handlers of its own, so a signal passed on to it ends it. */
  const quiet = stub(emit(hello), emit(started), "setInterval(() => {}, 1000);", "ready();");

  it("treats SIGTERM to the CLI the same way", async () => {
    const { child, runner, finished } = await startHarness(quiet, 60_000);

    child.kill("SIGTERM");

    expectInterrupted(await finished, runner, "SIGTERM");
  });

  it("treats a closed terminal (SIGHUP) the same way", async () => {
    const { child, runner, finished } = await startHarness(quiet, 60_000);

    child.kill("SIGHUP");

    expectInterrupted(await finished, runner, "SIGHUP");
  });

  /**
   * Checks that the CLI ended before the outcome was read, and left neither the runner nor its event
   * folder behind. The runner may take a moment to act on its SIGTERM once the CLI has gone.
   */
  async function expectNothingLeft(
    finished: Finished,
    runner: { pid: number; eventFile: string },
  ): Promise<void> {
    expect(finished.stdout).toBe("");
    expect(existsSync(dirname(runner.eventFile))).toBe(false);
    const deadline = Date.now() + 5000;
    while (isRunning(runner.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isRunning(runner.pid), `runner ${runner.pid} outlived the CLI`).toBe(false);
  }

  /** A runner that writes a line every 50 ms until it is stopped. */
  const chatty = stub(
    emit(hello),
    emit(started),
    "ready();",
    'setInterval(() => say("still running"), 50);',
  );

  it("kills the runner and removes the event folder when a closed stderr ends the CLI", async () => {
    const { child, runner, finished } = await startHarness(chatty, 60_000);

    // Like `evals run … 2>&1 | head`: the reader goes, and the next line the CLI passes on fails.
    child.stderr?.destroy();
    const result = await finished;

    expect(result.code).toBe(0);
    await expectNothingLeft(result, runner);
  });

  it("ends a CLI that exits 0 while the runner runs with the early exit code it was given", async () => {
    const { child, runner, finished } = await startHarness(chatty, 60_000, 17);

    child.stderr?.destroy();
    const result = await finished;

    expect(result.code).toBe(17);
    await expectNothingLeft(result, runner);
  });

  it("kills the runner and removes the event folder when an uncaught exception ends the CLI, keeping its exit code", async () => {
    const { child, runner, finished } = await startHarness(quiet, 60_000, 17);

    child.kill("SIGUSR2");
    const result = await finished;

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("an exception nothing catches");
    await expectNothingLeft(result, runner);
  });

  it("kills the runner and removes the event folder on SIGQUIT, which then ends the CLI", async () => {
    const { child, runner, finished } = await startHarness(quiet, 60_000);

    child.kill("SIGQUIT");
    const result = await finished;

    expect(result.signal).toBe("SIGQUIT");
    await expectNothingLeft(result, runner);
  });
});
