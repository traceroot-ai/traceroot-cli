/**
 * What the SDK eval runners write: the events they emit while they work, and the runs they save.
 *
 * traceroot (`python -m traceroot.eval.runner`) and @traceroot-ai/traceroot
 * (`dist/eval/runner.js`) ship runners that speak `eval_api_version` 1. A runner writes one JSON
 * event per line to the file named by `TRACEROOT_EVAL_EVENT_FILE`, and saves each evaluation it
 * runs as `.traceroot/eval/runs/<run id>.json` (the run file) plus `<run id>.cases.jsonl` (one
 * case line per case).
 *
 * The types cover only the fields the CLI reads. The parsers check those fields, drop every other
 * one, and fail with a {@link ProtocolError} that names the field and where it was. Runs recorded
 * from the released SDKs live in tests/fixtures/eval.
 *
 * traceroot's events can hold a bare `NaN`, `Infinity` or `-Infinity`, which is how Python writes
 * a float that is NaN or infinite, and isn't JSON. Every parser here reads such a token outside a
 * string as null.
 */

/** The protocol version the CLI reads. A runner announces its own in its `hello` event. */
export const EVAL_API_VERSION = 1;

const RUN_STATUSES = ["completed", "completed_with_errors", "incomplete"] as const;
/**
 * How a run ended. `completed_with_errors` means a task or a scorer raised on at least one case.
 *
 * An interrupted run (SIGINT) ends `incomplete`, and its stream ends with a `suite_completed`
 * whose `cancelled` is true. The runner doesn't report an interrupt with a `fatal` event.
 */
export type RunStatus = (typeof RUN_STATUSES)[number];

const RUN_MODES = ["full", "first", "sample"] as const;
/** `full` ran every case. `first` and `sample` ran a subset, and their run is never final. */
export type RunMode = (typeof RUN_MODES)[number];

const CASE_STATUSES = ["errored", "not_scored"] as const;
/**
 * A case's own status is never pass or fail: it is `errored` when the task or any scorer raised,
 * and `not_scored` otherwise. Pass and fail live on each score's `passed`.
 */
export type CaseStatus = (typeof CASE_STATUSES)[number];

const PAYLOADS = ["complete", "truncated"] as const;
/** Whether the run file stores each case's payloads in full or cut down to a preview. */
export type Payloads = (typeof PAYLOADS)[number];

/** The first event. Any version other than {@link EVAL_API_VERSION} is rejected. */
export interface HelloEvent {
  type: "hello";
  eval_api_version: typeof EVAL_API_VERSION;
}

/** The evaluations a file defines. Written only when listing, which the CLI doesn't do. */
export interface DefinitionsEvent {
  type: "definitions";
}

export interface EvaluationStartedEvent {
  type: "evaluation_started";
}

export interface CaseStartedEvent {
  type: "case_started";
}

export interface CaseCompletedEvent {
  type: "case_completed";
}

/** Counts for one evaluation, as the runner reports them when it ends. */
export interface RunCounts {
  cases: number;
  errored: number;
  task_errors: number;
  scorer_errors: number;
  not_scored: number;
}

export interface EvaluationCompletedEvent {
  type: "evaluation_completed";
  name: string;
  status: RunStatus;
  /** The id the run was saved under: `.traceroot/eval/runs/<local_run_id>.json`. */
  local_run_id: string;
  /** The TraceRoot run id when the run was uploaded, otherwise null. */
  run_id: string | null;
  counts: RunCounts;
}

/**
 * The last event of a stream that ran to its end. `evaluations` is 0 when the file defines no
 * evaluation at module level. `cancelled` is true when the run was interrupted.
 */
export interface SuiteCompletedEvent {
  type: "suite_completed";
  evaluations: number;
  cancelled: boolean;
}

/**
 * A failure of the runner itself, such as a file that fails to import (`import_error`). The
 * runner still exits 0 after it, so only this event says that the run failed.
 */
export interface FatalEvent {
  type: "fatal";
  kind: string;
  message: string;
}

export type RunnerEvent =
  | HelloEvent
  | DefinitionsEvent
  | EvaluationStartedEvent
  | CaseStartedEvent
  | CaseCompletedEvent
  | EvaluationCompletedEvent
  | SuiteCompletedEvent
  | FatalEvent;

/**
 * A score name the run produced, with the version its scorer declared. Both SDKs save a version
 * declared as a number (`version=2`) as that number; it reads as its string form, `"2"`. The
 * same goes for every `scorer_version`.
 */
export interface RunScorer {
  name: string;
  version: string | null;
}

/**
 * A saved run (`<run id>.json`).
 *
 * The file also has an `upload` block, which these types leave out on purpose: a run that never
 * left the machine records `upload.status` as `uploaded` too, so it says nothing about whether
 * the run reached TraceRoot.
 */
export interface RunFile {
  evaluation_name: string;
  status: RunStatus;
  run_mode: RunMode;
  /** False for a run of a subset of the cases, and for an interrupted run. */
  is_final: boolean;
  /**
   * The dataset the run used. For a `Dataset`, the revision is a hash of its cases in both SDKs.
   * For an inline dataset (a plain list of cases), traceroot hashes the rows too, but
   * @traceroot-ai/traceroot records `local-<case count>`, so two inline datasets of the same size
   * share a revision whatever their rows. A sampled traceroot run records the revision of the
   * cases it ran.
   */
  dataset: { revision: string } | null;
  scorers: RunScorer[];
  artifact: { payloads: Payloads };
}

export interface CaseScore {
  scorer_name: string;
  scorer_version: string | null;
  /** A number, boolean or string in practice. */
  value: unknown;
  /**
   * Whether the score passes. A boolean score passes when it is true, and a number when it meets
   * its scorer's declared threshold. null when nothing decides it, such as a number from a scorer
   * with no threshold.
   */
  passed: boolean | null;
}

/** A scorer that raised on a case. It has no score on that case. */
export interface ScorerError {
  /** The name the scorer declares, or its function name when it declares none. */
  scorer_name: string;
  /** null in every released runner, even for a scorer that declares a version. */
  scorer_version: string | null;
  message: string;
}

/** One case of a saved run (a line of `<run id>.cases.jsonl`). */
export interface CaseLine {
  /**
   * A `Dataset` derives each case id from the case's content. An inline dataset whose rows have no
   * ids gets positional ids (`case-0`, `case-1`, ...) in both SDKs, so in two runs the same id can
   * name different rows.
   */
  case_id: string;
  status: CaseStatus;
  /**
   * The stored payload. When the run's payloads are truncated, a long one is stored as a
   * `{ truncated, preview }` object.
   */
  input: unknown;
  expected: unknown;
  /** The task's error, when the task raised. The case then has no scores. */
  task_error: string | null;
  scorer_errors: ScorerError[];
  scores: CaseScore[];
}

/** Something a runner wrote that the CLI can't read. The message says what and where. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * Parses an event stream: one JSON event per line, blank lines skipped. Events of a type the CLI
 * doesn't know are dropped. A last line with no newline that doesn't parse is an event the runner
 * never finished writing, and is dropped too.
 *
 * @throws {ProtocolError} for a line that isn't a JSON object, an event that lacks a field the CLI
 * reads, or a `hello` with an `eval_api_version` other than 1.
 */
export function parseEvents(text: string): RunnerEvent[] {
  const lines = text.split("\n");
  if (!isJson(lines.at(-1) ?? "")) {
    lines.pop();
  }
  const events: RunnerEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    const event = readEvent(parseObject(line, `event line ${index + 1}`), index + 1);
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}

/**
 * Parses a run file (`<run id>.json`).
 *
 * @throws {ProtocolError} when the file isn't a JSON object or lacks a field the CLI reads.
 */
export function parseRunFile(text: string): RunFile {
  const where = "run file";
  const file = new Fields(parseObject(text, where), where);
  const dataset = file.nullableObject("dataset");
  const artifact = file.object("artifact");
  return {
    evaluation_name: file.string("evaluation_name"),
    status: file.oneOf("status", RUN_STATUSES),
    run_mode: file.oneOf("run_mode", RUN_MODES),
    is_final: file.boolean("is_final"),
    dataset: dataset === null ? null : { revision: dataset.string("revision") },
    scorers: file.objects("scorers").map((scorer) => ({
      name: scorer.string("name"),
      version: scorer.scorerVersion("version"),
    })),
    artifact: { payloads: artifact.oneOf("payloads", PAYLOADS) },
  };
}

/**
 * Parses the case lines of a run (`<run id>.cases.jsonl`), blank lines skipped.
 *
 * @throws {ProtocolError} for a line that isn't a JSON object or lacks a field the CLI reads.
 */
export function parseCaseLines(text: string): CaseLine[] {
  const cases: CaseLine[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") {
      continue;
    }
    const where = `case line ${index + 1}`;
    const item = new Fields(parseObject(line, where), where);
    cases.push({
      case_id: item.string("case_id"),
      status: item.oneOf("status", CASE_STATUSES),
      input: item.value("input"),
      expected: item.value("expected"),
      task_error: item.nullableString("task_error"),
      scorer_errors: item.objects("scorer_errors").map((error) => ({
        scorer_name: error.string("scorer_name"),
        scorer_version: error.scorerVersion("scorer_version"),
        message: error.string("message"),
      })),
      scores: item.objects("scores").map((score) => ({
        scorer_name: score.string("scorer_name"),
        scorer_version: score.scorerVersion("scorer_version"),
        value: score.value("value"),
        passed: score.nullableBoolean("passed"),
      })),
    });
  }
  return cases;
}

function readEvent(raw: Record<string, unknown>, lineNumber: number): RunnerEvent | null {
  const type = raw.type;
  if (typeof type !== "string") {
    throw new ProtocolError(`event line ${lineNumber}: "type" is missing or not a string`);
  }
  const event = new Fields(raw, `event line ${lineNumber} (${type})`);
  switch (type) {
    case "hello": {
      const version = raw.eval_api_version;
      if (version !== EVAL_API_VERSION) {
        const announced =
          version === undefined
            ? "announces no eval_api_version"
            : `speaks eval_api_version ${JSON.stringify(version)}`;
        throw new ProtocolError(
          `the eval runner ${announced}, and this CLI reads only version ${EVAL_API_VERSION}`,
        );
      }
      return { type, eval_api_version: EVAL_API_VERSION };
    }
    case "definitions":
    case "evaluation_started":
    case "case_started":
    case "case_completed":
      return { type };
    case "evaluation_completed": {
      const counts = event.object("counts");
      return {
        type,
        name: event.string("name"),
        status: event.oneOf("status", RUN_STATUSES),
        local_run_id: event.string("local_run_id"),
        run_id: event.nullableString("run_id"),
        counts: {
          cases: counts.number("cases"),
          errored: counts.number("errored"),
          task_errors: counts.number("task_errors"),
          scorer_errors: counts.number("scorer_errors"),
          not_scored: counts.number("not_scored"),
        },
      };
    }
    case "suite_completed":
      return {
        type,
        evaluations: event.number("evaluations"),
        cancelled: event.boolean("cancelled"),
      };
    case "fatal":
      return { type, kind: event.string("kind"), message: event.string("message") };
    default:
      return null;
  }
}

function parseObject(text: string, where: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch (error) {
    throw new ProtocolError(`${where}: not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(parsed)) {
    throw new ProtocolError(`${where}: expected a JSON object`);
  }
  return parsed;
}

function isJson(text: string): boolean {
  try {
    parseJson(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON.parse, tried once more on text that fails, with every bare `NaN`, `Infinity` and
 * `-Infinity` outside a string read as null. When that fails too, it throws the first error.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    try {
      return JSON.parse(nonFiniteAsNull(text));
    } catch {
      throw error;
    }
  }
}

/** `-Infinity` comes before `Infinity`, so that its sign goes too. */
const NON_FINITE_TOKENS = ["-Infinity", "Infinity", "NaN"];

/**
 * `text` with each `NaN`, `Infinity` and `-Infinity` outside a JSON string replaced by `null`.
 * It follows strings and their escapes, so a string that holds those words is left as it is.
 */
function nonFiniteAsNull(text: string): string {
  let result = "";
  let copied = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") {
        index += 1; // The escaped character, which may be a quote, can't end the string.
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else {
      const token = NON_FINITE_TOKENS.find((word) => text.startsWith(word, index));
      if (token !== undefined) {
        result += `${text.slice(copied, index)}null`;
        index += token.length - 1;
        copied = index + 1;
      }
    }
  }
  return result + text.slice(copied);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads typed fields from one JSON object, naming the object and the field when one is wrong.
 *
 * A field that may be null may also be missing, and reads as null: JSON.stringify leaves out a
 * field whose value is undefined, which is how a TypeScript runner writes an absent value.
 */
class Fields {
  constructor(
    private readonly raw: Record<string, unknown>,
    private readonly where: string,
  ) {}

  /** Any JSON value. */
  value(key: string): unknown {
    return this.raw[key] ?? null;
  }

  string(key: string): string {
    const value = this.raw[key];
    if (typeof value !== "string") {
      throw this.wrong(key, "a string");
    }
    return value;
  }

  nullableString(key: string): string | null {
    const value = this.raw[key] ?? null;
    if (value !== null && typeof value !== "string") {
      throw this.wrong(key, "a string or null");
    }
    return value as string | null;
  }

  /** A string or null, or a finite number, which reads as its string form. */
  scorerVersion(key: string): string | null {
    const value = this.raw[key] ?? null;
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (value !== null && typeof value !== "string") {
      throw this.wrong(key, "a string, a number or null");
    }
    return value as string | null;
  }

  number(key: string): number {
    const value = this.raw[key];
    if (typeof value !== "number") {
      throw this.wrong(key, "a number");
    }
    return value;
  }

  boolean(key: string): boolean {
    const value = this.raw[key];
    if (typeof value !== "boolean") {
      throw this.wrong(key, "true or false");
    }
    return value;
  }

  nullableBoolean(key: string): boolean | null {
    const value = this.raw[key] ?? null;
    if (value !== null && typeof value !== "boolean") {
      throw this.wrong(key, "true, false or null");
    }
    return value as boolean | null;
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    const value = this.raw[key];
    if (!allowed.includes(value as T)) {
      throw this.wrong(key, `one of ${allowed.join(", ")}`);
    }
    return value as T;
  }

  object(key: string): Fields {
    const value = this.raw[key];
    if (!isRecord(value)) {
      throw this.wrong(key, "an object");
    }
    return new Fields(value, `${this.where}, ${key}`);
  }

  nullableObject(key: string): Fields | null {
    return (this.raw[key] ?? null) === null ? null : this.object(key);
  }

  objects(key: string): Fields[] {
    const value = this.raw[key];
    if (!Array.isArray(value)) {
      throw this.wrong(key, "a list");
    }
    return value.map((item, index) => {
      const where = `${this.where}, ${key}[${index}]`;
      if (!isRecord(item)) {
        throw new ProtocolError(`${where}: expected a JSON object`);
      }
      return new Fields(item, where);
    });
  }

  private wrong(key: string, expected: string): ProtocolError {
    const value = this.raw[key];
    if (value === undefined) {
      return new ProtocolError(`${this.where}: "${key}" is missing`);
    }
    let found = JSON.stringify(value);
    if (found.length > 60) {
      found = `${found.slice(0, 57)}...`;
    }
    return new ProtocolError(`${this.where}: "${key}" should be ${expected}, found ${found}`);
  }
}
