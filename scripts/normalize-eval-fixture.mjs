// Turns one recorded eval run into a fixture directory. Called by record-eval-fixtures.sh.
//
//   node scripts/normalize-eval-fixture.mjs <project dir> <fixture dir> <placeholder>=<path>...
//
// Copies the runner's event stream and the run files it saved, and replaces what changes from one
// recording to the next with fixed values: run ids, timestamps, durations, and the absolute paths
// given as placeholder=path pairs. Everything else stays byte for byte as the runner wrote it.
// Fails when a fixture would still contain an absolute path, a hostname or a credential.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

const [projectDir, fixtureDir, ...pairs] = process.argv.slice(2);
if (projectDir === undefined || fixtureDir === undefined) {
  fail("usage: normalize-eval-fixture.mjs <project dir> <fixture dir> <placeholder>=<path>...");
}

const RUN_ID = /\brun_[0-9A-HJKMNP-TV-Z]{26}\b/g;
const RUN_FILE = /^(run_[0-9A-HJKMNP-TV-Z]{26})\.(json|cases\.jsonl)$/;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const DURATION = /("duration_ms": ?)-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

// Longest first, so a path is never half-replaced by a placeholder for one of its parents.
const placeholders = pairs
  .map((pair) => {
    const at = pair.indexOf("=");
    if (at <= 0 || at === pair.length - 1) fail(`not a placeholder=path pair: ${pair}`);
    return { placeholder: pair.slice(0, at), path: pair.slice(at + 1) };
  })
  .sort((a, b) => b.path.length - a.path.length);

const events = readFileSync(join(projectDir, "events.jsonl"), "utf8");
const runFiles = readRunFiles(join(projectDir, ".traceroot", "eval", "runs"));

// Run ids are numbered in the order they first appear: the event stream, then the run files.
const runIds = new Map();
for (const text of [events, ...runFiles.flatMap((file) => [file.name, file.text])]) {
  for (const [id] of text.matchAll(RUN_ID)) {
    if (!runIds.has(id)) {
      runIds.set(id, `run_${String(runIds.size + 1).padStart(26, "0")}`);
    }
  }
}

write("events.jsonl", normalize(events));
for (const file of runFiles) {
  write(join("runs", `${runIds.get(file.runId)}.${file.kind}`), normalize(file.text));
}

function readRunFiles(dir) {
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const name of names) {
    // The runner drops a .gitignore next to the runs; it is not part of the run.
    if (name === ".gitignore") continue;
    const match = RUN_FILE.exec(name);
    if (match === null) fail(`unexpected file in the runs directory: ${name}`);
    const text = readFileSync(join(dir, name), "utf8");
    files.push({ name, runId: match[1], kind: match[2], text });
  }
  return files;
}

function normalize(text) {
  let result = text;
  for (const { placeholder, path } of placeholders) {
    result = result.split(path).join(placeholder);
  }
  return result
    .replace(RUN_ID, (id) => runIds.get(id))
    .replace(TIMESTAMP, (_, zone) =>
      zone === "Z" ? "2000-01-01T00:00:00.000Z" : "2000-01-01T00:00:00.000000+00:00",
    )
    .replace(DURATION, (_, key) => `${key}1.5`);
}

function write(relative, text) {
  checkForLeaks(relative, text);
  const target = join(fixtureDir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function checkForLeaks(relative, text) {
  const host = hostname();
  const leaks = [
    [/(^|["'\s(=])\/[\w.@-]+\//m, "an absolute path"],
    [/file:\/\//, "a file URL"],
    [/\b[A-Za-z]:\\/, "a Windows path"],
    [/127\.0\.0\.1|localhost/, "a hostname"],
    [/\btr[_-][\w-]{4,}/, "an API key"],
  ];
  for (const name of new Set([host, host.split(".")[0]])) {
    if (name.length >= 3) leaks.push([name, "this machine's hostname"]);
  }
  for (const [pattern, what] of leaks) {
    const found = typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
    if (found) fail(`${join(fixtureDir, relative)} would contain ${what}`);
  }
}

function fail(message) {
  process.stderr.write(`normalize-eval-fixture: ${message}\n`);
  process.exit(1);
}
