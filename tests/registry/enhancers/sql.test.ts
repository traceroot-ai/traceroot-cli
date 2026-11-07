import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlResult } from "../../../src/api/client.js";
import { CliError, ExitCode } from "../../../src/output.js";
import {
  collectParam,
  parseMaxRows,
  renderSqlResult,
  resolveQuery,
  sql,
} from "../../../src/registry/enhancers/sql.js";
import { errorResponse, jsonResponse } from "../../helpers/fakeFetch.js";
import { withoutForcedColor } from "../../helpers/plainColor.js";
import { runCli } from "../../helpers/runCli.js";
import { harness, sqlCommand } from "../../helpers/sqlHarness.js";
import { StringSink } from "../../helpers/stringSink.js";

withoutForcedColor();

const COMMENTED = "-- note\nSELECT 1";
const TWO_QUERIES = "expected one query argument but got 2";

function makeResult(over: Partial<SqlResult> = {}): SqlResult {
  return {
    columns: [
      { name: "model_name", type: "Nullable(String)" },
      { name: "spans", type: "UInt64" },
    ],
    rows: [
      ["gpt-4o", 12],
      [null, 3],
    ],
    row_count: 2,
    truncated: false,
    elapsed_ms: 7,
    statistics: {},
    ...over,
  };
}

function usageError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    return err as CliError;
  }
  throw new Error("expected a usage error");
}

function sentBody(h: ReturnType<typeof harness>): unknown {
  expect(h.fake.calls).toHaveLength(1);
  return JSON.parse(h.fake.calls[0]?.init.body as string);
}

/** A directory made before each test in the calling `describe` and removed after it. */
function withTempDir(): () => string {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "traceroot-sql-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}

describe("resolveQuery", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "traceroot-sql-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes the query argument", () => {
    expect(resolveQuery(["SELECT 1 FROM spans"], undefined)).toBe("SELECT 1 FROM spans");
  });

  it("reads the query from --file", () => {
    const file = join(dir, "q.sql");
    writeFileSync(file, "SELECT count() FROM traces\n");
    expect(resolveQuery([], file)).toBe("SELECT count() FROM traces\n");
  });

  it("refuses both a query argument and --file", () => {
    const err = usageError(() => resolveQuery(["SELECT 1"], join(dir, "q.sql")));
    expect(err.message).toBe("provide either a query argument or --file, not both");
  });

  it("refuses neither", () => {
    expect(usageError(() => resolveQuery([], undefined)).message).toBe(
      "provide a query argument or --file <path>",
    );
  });

  it("refuses an unquoted query split into several arguments, with a quoting hint", () => {
    const err = usageError(() => resolveQuery(["SELECT", "1"], undefined));
    expect(err.message).toContain("quote the whole query");
  });

  it("refuses an unreadable --file", () => {
    const err = usageError(() => resolveQuery([], join(dir, "missing.sql")));
    expect(err.message).toContain("could not read query file");
  });

  it("refuses a blank query", () => {
    expect(usageError(() => resolveQuery(["   "], undefined)).message).toBe("the query is empty");
  });
});

describe("parseMaxRows", () => {
  it("accepts a whole number inside the published bounds", () => {
    expect(parseMaxRows(undefined)).toBeUndefined();
    expect(parseMaxRows("10")).toBe(10);
  });

  it.each(["abc", "1.5", "-1", ""])("refuses %j", (raw) => {
    usageError(() => parseMaxRows(raw));
  });

  it("enforces the schema's minimum and maximum", () => {
    expect(usageError(() => parseMaxRows("0")).message).toBe("--max-rows must be at least 1");
    expect(usageError(() => parseMaxRows("1000001")).message).toBe(
      "--max-rows must be at most 1000000",
    );
  });
});

describe("collectParam", () => {
  it("accumulates repeated flags and keeps everything after the first '='", () => {
    const params = collectParam("b=x=y", collectParam("a=1", undefined));
    expect(Object.fromEntries(params)).toEqual({ a: "1", b: "x=y" });
  });

  it("allows an empty value", () => {
    expect(Object.fromEntries(collectParam("a=", undefined))).toEqual({ a: "" });
  });

  it.each(["novalue", "=1"])("refuses %j without a name=value shape", (raw) => {
    expect(usageError(() => collectParam(raw, undefined)).message).toContain("name=value");
  });

  it("refuses a name that is not a plain identifier", () => {
    usageError(() => collectParam("a-b=1", undefined));
    usageError(() => collectParam("1a=1", undefined));
  });

  it("refuses the same name twice", () => {
    const err = usageError(() => collectParam("a=2", collectParam("a=1", undefined)));
    expect(err.message).toBe("--param a may only be given once");
  });
});

describe("sql resolveArgs", () => {
  const resolve = sql.resolveArgs as NonNullable<typeof sql.resolveArgs>;

  it("refuses --json together with --csv before anything is dispatched", () => {
    const err = usageError(() =>
      resolve({ opts: { csv: true }, positionals: {}, extras: ["SELECT 1"], json: true }),
    );
    expect(err.message).toBe("--json and --csv cannot be combined");
  });

  it("builds the body from the query, --max-rows and --param", () => {
    const resolved = resolve({
      opts: { maxRows: "5", param: collectParam("min_ms=100", undefined) },
      positionals: {},
      extras: ["SELECT 1 FROM spans"],
    });
    expect(resolved.args).toEqual({
      query: "SELECT 1 FROM spans",
      max_rows: 5,
      parameters: { min_ms: "100" },
    });
  });

  it("keeps a parameter named __proto__ an ordinary key of the body", () => {
    const resolved = resolve({
      opts: { param: collectParam("__proto__=x", undefined) },
      positionals: {},
      extras: ["SELECT 1 FROM spans"],
    });
    const parameters = resolved.args.parameters as Record<string, unknown>;
    expect(Object.hasOwn(parameters, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parameters)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(resolved.args))).toEqual({
      query: "SELECT 1 FROM spans",
      parameters: JSON.parse('{"__proto__":"x"}'),
    });
  });

  it("sends only the query when nothing else is given", () => {
    const resolved = resolve({ opts: {}, positionals: {}, extras: ["SELECT 1 FROM spans"] });
    expect(resolved.args).toEqual({ query: "SELECT 1 FROM spans" });
  });
});

describe("renderSqlResult", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "traceroot-sql-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function render(result: SqlResult, over: { json?: boolean; csv?: boolean; output?: string }) {
    const out = new StringSink();
    const err = new StringSink();
    renderSqlResult(result, {
      json: over.json ?? false,
      csv: over.csv ?? false,
      output: over.output,
      writers: { out, err },
    });
    return { out: out.data, err: err.data };
  }

  it("renders a table with the column names as headers, NULL for null, and a row count", () => {
    const { out, err } = render(makeResult(), {});
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^model_name\s+spans$/);
    expect(lines[1]).toMatch(/^gpt-4o\s+12$/);
    expect(lines[2]).toMatch(/^NULL\s+3$/);
    expect(err).toContain("2 row(s) in 7 ms");
  });

  it("escapes control characters in table cells so data cannot drive the terminal", () => {
    const result = makeResult({ rows: [["evil\u001b[2Jname\nnext", 1]], row_count: 1 });
    const { out } = render(result, {});
    expect(out).not.toContain("\u001b");
    expect(out).toContain("evil\\u001b[2Jname\\nnext");
  });

  it("escapes DEL and C1 controls too, which JSON leaves literal", () => {
    // U+009B is the 8-bit CSI; a terminal that honours C1 would act on it.
    const result = makeResult({ rows: [["a\u007fb\u009bc\u0085d", 1]], row_count: 1 });
    const { out } = render(result, {});
    for (const cp of [0x7f, 0x9b, 0x85]) {
      expect(out).not.toContain(String.fromCodePoint(cp));
    }
    expect(out).toContain("a\\u007fb\\u009bc\\u0085d");
  });

  it("escapes control characters in column headers, which come from the query's aliases", () => {
    const result = makeResult({
      columns: [
        { name: "x\u001b[2Jy", type: "String" },
        { name: "spans", type: "UInt64" },
      ],
      rows: [["v", 1]],
      row_count: 1,
    });
    const { out } = render(result, {});
    expect(out).not.toContain("\u001b");
    expect(out.split("\n")[0]).toContain("x\\u001b[2Jy");
  });

  it("renders CSV with --csv", () => {
    const { out } = render(makeResult(), { csv: true });
    expect(out).toBe("model_name,spans\ngpt-4o,12\n,3\n");
  });

  it("emits the raw response as one JSON document with --json", () => {
    const result = makeResult({ truncated: true });
    const { out, err } = render(result, { json: true });
    expect(JSON.parse(out)).toEqual(result);
    expect(err).toBe("");
  });

  it("warns on truncation in table and CSV output, where the flag would otherwise be lost", () => {
    const result = makeResult({ truncated: true });
    expect(render(result, {}).err).toContain("warning: result truncated to 2 row(s)");
    expect(render(result, { csv: true }).err).toContain("warning: result truncated to 2 row(s)");
  });

  it("says nothing about truncation when the result is complete", () => {
    expect(render(makeResult(), {}).err).not.toContain("truncated");
  });

  it("writes any format to --output instead of stdout", () => {
    const file = join(dir, "out.csv");
    const { out, err } = render(makeResult(), { csv: true, output: file });
    expect(out).toBe("");
    expect(readFileSync(file, "utf8")).toBe("model_name,spans\ngpt-4o,12\n,3\n");
    expect(err).toContain(`wrote 2 row(s) to ${file}`);
  });

  it("reports a failed --output write as a CLI error", () => {
    expect(() => render(makeResult(), { output: join(dir, "missing", "out.txt") })).toThrow(
      /could not write/,
    );
  });
});

describe("traceroot sql (through the registry factory)", () => {
  it("POSTs the query as a JSON body to the public SQL route", async () => {
    const h = harness(jsonResponse(makeResult()));
    await h.run(
      "sql",
      "SELECT model_name, count() AS spans FROM spans GROUP BY model_name",
      "--max-rows",
      "50",
      "--param",
      "min_ms=100",
      "--json",
    );
    expect(h.fake.calls).toHaveLength(1);
    const call = h.fake.calls[0];
    expect(call?.url).toBe("https://api.test/api/v1/public/sql");
    expect(call?.init.method?.toUpperCase()).toBe("POST");
    expect(JSON.parse(call?.init.body as string)).toEqual({
      query: "SELECT model_name, count() AS spans FROM spans GROUP BY model_name",
      max_rows: 50,
      parameters: { min_ms: "100" },
    });
    expect(JSON.parse(h.out.data)).toEqual(makeResult());
  });

  it("renders a table by default", async () => {
    const h = harness(jsonResponse(makeResult()));
    await h.run("sql", "SELECT 1 FROM spans");
    expect(h.out.data.split("\n")[0]).toMatch(/^model_name\s+spans$/);
  });

  it.each([
    [["sql", "SELECT 1", "--csv", "--json"], "--json and --csv cannot be combined"],
    [["sql", "--csv", COMMENTED, "--json"], "--json and --csv cannot be combined"],
    [["sql", "SELECT", "1"], "quote the whole query"],
    [["sql", "-- note", "SELECT 1"], TWO_QUERIES],
    [["sql", "SELECT 1", "-- note"], TWO_QUERIES],
    [["sql", COMMENTED, "SELECT 2"], TWO_QUERIES],
    [["sql", "-- a", "-- b"], TWO_QUERIES],
    [["sql", "-- a", "--max-rows", "5", "-- b"], TWO_QUERIES],
    [["sql", "-- note", "--", "SELECT 1"], TWO_QUERIES],
    [["sql", "-- note", "--", "--jsn"], TWO_QUERIES],
    [["sql", "-- note", "schema"], TWO_QUERIES],
    [["sql", "SELECT 1", "--max-rows", "0"], "--max-rows must be at least 1"],
    [["sql", "--param", "-- x", "SELECT 1"], "--param expects name=value, got '-- x'"],
    [["sql", "--max-rows", "-- 1", "SELECT 1"], "--max-rows must be a positive whole number"],
    [["sql", "--file", "-- missing"], "could not read query file -- missing"],
    [["sql", "-f", "-- missing"], "could not read query file -- missing"],
  ])("refuses %j as a usage error without calling the API", async (argv, message) => {
    const h = harness(jsonResponse(makeResult()));
    const err = await h.run(...argv).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(ExitCode.usage);
    expect((err as CliError).message).toContain(message);
    expect(h.fake.calls).toHaveLength(0);
  });

  it("surfaces the server's validation message", async () => {
    const h = harness(errorResponse(400, "Table 'system.tables' is not allowed."));
    const err = await h.run("sql", "SELECT * FROM system.tables").catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe("Table 'system.tables' is not allowed.");
    expect(h.out.data).toBe("");
  });

  it("adds a narrowing hint when a server cap stopped the query", async () => {
    const h = harness(errorResponse(400, "Query exceeded the maximum execution time."));
    const err = await h.run("sql", "SELECT * FROM spans").catch((e) => e);
    expect((err as CliError).message).toMatch(
      /^Query exceeded the maximum execution time\.\nHint: add a LIMIT/,
    );
  });
});

describe("traceroot sql (a query that starts with a comment)", () => {
  it.each([
    ["a comment line and then SQL", COMMENTED],
    ["no space after the dashes", "--note\nSELECT 1"],
    ["nothing else on the comment line", "--\nSELECT 1"],
    ["a CRLF line ending", "-- note\r\nSELECT 1"],
    ["a CRLF line ending and no space", "--note\r\nSELECT 1"],
    ["two comment lines", "-- one\n-- two\nSELECT 1"],
    ["only a comment", "-- note"],
    ["only a comment after a tab", "--\tnote"],
  ])("sends %s as the query", async (_label, query) => {
    const h = harness(jsonResponse(makeResult()));
    await h.run("sql", query);
    expect(sentBody(h)).toEqual({ query });
  });

  it.each([[["--project", "p", "sql", COMMENTED]], [["sql", COMMENTED, "--project", "p"]]])(
    "keeps the global --project in %j",
    async (argv) => {
      const h = harness(jsonResponse(makeResult()));
      await h.run(...argv);
      expect(h.program.opts().project).toBe("p");
      expect(sentBody(h)).toEqual({ query: COMMENTED });
    },
  );
});

describe.each([
  ["a plain query", "SELECT 1 FROM spans"],
  ["a query that starts with a comment", COMMENTED],
])("traceroot sql flags around %s", (_label, query) => {
  const orders: [string, (flags: string[]) => string[]][] = [
    ["before", (flags) => ["sql", ...flags, query]],
    ["after", (flags) => ["sql", query, ...flags]],
  ];

  describe.each(orders)("given %s the query", (_order, argv) => {
    const dir = withTempDir();

    it.each<[string[], object, ((stdout: string) => void)?]>([
      [["--json"], {}, (stdout) => expect(JSON.parse(stdout)).toEqual(makeResult())],
      [["--csv"], {}, (stdout) => expect(stdout).toBe("model_name,spans\ngpt-4o,12\n,3\n")],
      [["--max-rows", "5"], { max_rows: 5 }],
      [["--param", "a=1"], { parameters: { a: "1" } }],
    ])("applies %j", async (flags, body, checkStdout) => {
      const h = harness(jsonResponse(makeResult()));
      await h.run(...argv(flags));
      expect(sentBody(h)).toEqual({ query, ...body });
      checkStdout?.(h.out.data);
    });

    it("--output writes the file", async () => {
      const file = join(dir(), "out.csv");
      const h = harness(jsonResponse(makeResult()));
      await h.run(...argv(["--csv", "--output", file]));
      expect(sentBody(h)).toEqual({ query });
      expect(readFileSync(file, "utf8")).toBe("model_name,spans\ngpt-4o,12\n,3\n");
    });

    it("--file is refused alongside a query", async () => {
      const h = harness(jsonResponse(makeResult()));
      const err = await h.run(...argv(["--file", join(dir(), "q.sql")])).catch((e) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(ExitCode.usage);
      expect((err as CliError).message).toBe("provide either a query argument or --file, not both");
      expect(h.fake.calls).toHaveLength(0);
    });
  });
});

describe("traceroot sql (--file)", () => {
  const dir = withTempDir();

  it("reads a file whose first line is a comment", async () => {
    const file = join(dir(), "q.sql");
    writeFileSync(file, `${COMMENTED}\n`);
    const h = harness(jsonResponse(makeResult()));
    await h.run("sql", "--file", file);
    expect(sentBody(h)).toEqual({ query: `${COMMENTED}\n` });
  });
});

describe("traceroot sql (an option's value that looks like a comment)", () => {
  // The server refuses, so nothing is written under the odd --output names.
  const refused = () => harness(errorResponse(400, "refused"));

  it.each([
    [["sql", "--output", "-- x y", "SELECT 1"], "SELECT 1", "-- x y"],
    [["sql", "SELECT 1", "--output", "-- x y"], "SELECT 1", "-- x y"],
    [["sql", "--output=-- x y", "SELECT 1"], "SELECT 1", "-- x y"],
    [["sql", "--output", "-- x\ny", "SELECT 1"], "SELECT 1", "-- x\ny"],
    [["sql", COMMENTED, "--output", "-- x y"], COMMENTED, "-- x y"],
    [["sql", "--output", "-- x y", COMMENTED], COMMENTED, "-- x y"],
  ])("keeps it as --output in %j", async (argv, query, output) => {
    const h = refused();
    await h.run(...argv).catch((e) => e);
    expect(sentBody(h)).toEqual({ query });
    expect(sqlCommand(h.program).opts().output).toBe(output);
  });

  it.each([
    [["sql", "--param", "a=-- b", "SELECT 1"], "SELECT 1"],
    [["sql", "SELECT 1", "--param", "a=-- b"], "SELECT 1"],
    [["sql", "--param=a=-- b", "SELECT 1"], "SELECT 1"],
    [["sql", COMMENTED, "--param", "a=-- b"], COMMENTED],
  ])("keeps it as --param in %j", async (argv, query) => {
    const h = refused();
    await h.run(...argv).catch((e) => e);
    expect(sentBody(h)).toEqual({ query, parameters: { a: "-- b" } });
  });
});

describe("traceroot sql (unknown options)", () => {
  it.each([
    [["sql", "--jsn"], "--jsn"],
    [["sql", "--bogus=a b"], "--bogus=a b"],
    [["sql", "--bogus=a", "b"], "--bogus=a"],
    [["sql", "--bogus", "SELECT 1"], "--bogus"],
    [["sql", "--note"], "--note"],
    [["sql", "SELECT 1", "--jsn"], "--jsn"],
    [["sql", COMMENTED, "--jsn"], "--jsn"],
    [["sql", "--jsn", COMMENTED], "--jsn"],
    [["sql", "-- a", "--jsn", "-- b"], "--jsn"],
    // Only `sql` takes a comment as its query; another command still refuses one.
    [["traces", "list", "-- note"], "-- note"],
    [["traces", "list", COMMENTED], COMMENTED],
  ])("reports %j", async (argv, flag) => {
    const h = harness(jsonResponse(makeResult()));
    await expect(h.run(...argv)).rejects.toMatchObject({
      code: "commander.unknownOption",
      message: expect.stringContaining(`unknown option '${flag}'`),
    });
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe("traceroot sql (query arguments)", () => {
  it.each([
    [["sql", "--", "-- note"], "-- note"],
    [["sql", "--", COMMENTED], COMMENTED],
    [["sql", "--", "--jsn"], "--jsn"],
    [["sql", "--", "SELECT 1"], "SELECT 1"],
    [["sql", "--max-rows=5", "--", "-- note"], "-- note"],
  ])("takes everything after the separator as the query in %j", async (argv, query) => {
    const h = harness(jsonResponse(makeResult()));
    await h.run(...argv);
    expect((sentBody(h) as { query: string }).query).toBe(query);
  });
});

describe("traceroot sql (spawned)", () => {
  it("reaches authentication with a query that starts with a comment", () => {
    // runCli carries no credentials, so getting past parsing means failing there.
    const { stderr, status } = runCli("sql", COMMENTED);
    expect(stderr).toContain("No credentials found");
    expect(status).toBe(3);
  });

  it("exits 2 on an unknown option", () => {
    const { stderr, status } = runCli("sql", "--jsn");
    expect(stderr).toContain("unknown option '--jsn'");
    expect(status).toBe(2);
  });

  it("prints help for --help whether or not a query is given", () => {
    const bare = runCli("sql", "--help");
    expect(bare.status).toBe(0);
    expect(bare.stdout).toContain("Usage: traceroot sql [options] [query]");
    const withQuery = runCli("sql", COMMENTED, "--help");
    expect(withQuery.status).toBe(0);
    expect(withQuery.stdout).toBe(bare.stdout);
  });
});
