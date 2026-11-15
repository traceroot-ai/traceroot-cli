/**
 * A stand-in for an SDK's eval runner, for end-to-end tests of `traceroot evals run`.
 *
 * It is started two ways:
 * - as a project's Python, through `.venv/bin/python`, a shell script that runs
 *   `node <this file> python <venv dir> <args>`. Given `-c`, it answers the lookup's version probe
 *   with the versions in `<venv dir>/stub.json`; given `-m traceroot.eval.runner <file>`, it runs
 *   the file;
 * - as the TypeScript runner, `node_modules/@traceroot-ai/traceroot/dist/eval/runner.js`, which
 *   requires this file. Its last argument is the file.
 *
 * The evaluation file holds JSON that says what the run does:
 * - `replay`: a folder of tests/fixtures/eval. Its events go to the event file, its run is saved
 *   under `.traceroot/eval/runs`, and the runner exits with its recorded status;
 * - `run_id`: the id the replayed run is saved under, in place of the recorded one;
 * - `replace`: `[from, to]` pairs applied to every replayed file;
 * - `unfinished`: leave the replay's `suite_completed` event out, as a runner that stops after the
 *   replayed evaluation does;
 * - `events`: events written instead of a replay, or after it;
 * - `exit`: the exit status, in place of the recorded one;
 * - `wait`: write `events` and wait for SIGINT, SIGTERM or SIGHUP, then do the `replay` and exit
 *   130, the way both runners end a cancelled run;
 * - `chatty`: while it waits, write a line to stderr every 50 ms.
 *
 * Whichever way it starts, it records the environment it was given and its pid in the folder it
 * runs in, so a test can check what reached it.
 */
const fs = require("node:fs");
const path = require("node:path");

/** The run id every recorded fixture saved its run under. */
const RECORDED_RUN_ID = "run_00000000000000000000000001";

const args = process.argv.slice(2);
if (args[0] === "python") {
  const venv = args[1];
  const rest = args.slice(2);
  if (rest[0] === "-c") {
    probe(venv);
  } else {
    run(rest[rest.length - 1]);
  }
} else {
  run(args[args.length - 1]);
}

/** What a process the CLI started was given. */
function seen(env) {
  return {
    api_key: env.TRACEROOT_API_KEY ?? null,
    enabled: env.TRACEROOT_ENABLED ?? null,
    options: env.TRACEROOT_EVAL_OPTIONS ?? null,
    event_file: env.TRACEROOT_EVAL_EVENT_FILE ?? null,
  };
}

function probe(venv) {
  const answer = JSON.parse(fs.readFileSync(path.join(venv, "stub.json"), "utf8"));
  fs.writeFileSync(path.join(venv, "probe-env.json"), JSON.stringify(seen(process.env)));
  process.stdout.write(
    `${JSON.stringify({
      executable: path.join(venv, "bin", "python"),
      python: "3.12.4",
      traceroot: answer.traceroot,
    })}\n`,
  );
}

function run(file) {
  const spec = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync("runner-env.json", JSON.stringify(seen(process.env)));
  fs.writeFileSync("runner.pid", String(process.pid));
  process.stdout.write("runner stdout\n");
  process.stderr.write("runner stderr\n");
  if (spec.wait) {
    writeEvents(spec.events ?? []);
    const stop = () => {
      replay(spec);
      process.exit(130);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, stop);
    }
    setInterval(() => {}, 1000);
    if (spec.chatty) {
      setInterval(() => process.stderr.write("runner still running\n"), 50);
    }
    process.stderr.write("runner ready\n");
    return;
  }
  const status = spec.replay === undefined ? 0 : replay(spec);
  writeEvents(spec.events ?? []);
  process.exit(spec.exit ?? status);
}

function writeEvents(events) {
  for (const event of events) {
    fs.appendFileSync(process.env.TRACEROOT_EVAL_EVENT_FILE, `${JSON.stringify(event)}\n`);
  }
}

/** Replays a recorded run and returns the status its runner exited with. */
function replay(spec) {
  const id = spec.run_id ?? RECORDED_RUN_ID;
  const pairs = [[RECORDED_RUN_ID, id], ...(spec.replace ?? [])];
  const edit = (text) => pairs.reduce((out, [from, to]) => out.split(from).join(to), text);
  const read = (name) => fs.readFileSync(path.join(spec.replay, name), "utf8");

  const events = edit(read("events.jsonl"))
    .split("\n")
    .filter((line) => !(spec.unfinished && line.includes('"suite_completed"')))
    .join("\n");
  fs.appendFileSync(process.env.TRACEROOT_EVAL_EVENT_FILE, events);
  const runs = path.join(spec.replay, "runs");
  if (fs.existsSync(runs)) {
    const saved = path.join(".traceroot", "eval", "runs");
    fs.mkdirSync(saved, { recursive: true });
    for (const name of fs.readdirSync(runs)) {
      fs.writeFileSync(path.join(saved, edit(name)), edit(read(path.join("runs", name))));
    }
  }
  return Number(read("exit-status"));
}
