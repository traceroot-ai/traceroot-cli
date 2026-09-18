import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlResult } from "../../../src/api/client.js";
import { buildProgram } from "../../../src/cli.js";
import { CliError, ExitCode } from "../../../src/output.js";
import {
  collectParam,
  parseMaxRows,
  renderSqlResult,
  resolveQuery,
  sql,
} from "../../../src/registry/enhancers/sql.js";
import { createFakeFetch, errorResponse, jsonResponse } from "../../helpers/fakeFetch.js";
import { StringSink } from "../../helpers/stringSink.js";

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

function harness(response: Response) {
  const fake = createFakeFetch(() => response);
  const out = new StringSink();
  const err = new StringSink();
  const program = buildProgram({ registry: { fetchImpl: fake.fetchImpl, writers: { out, err } } });
  const run = (...argv: string[]) =>
    program.parseAsync(["--api-key", "k", "--host", "https://api.test", ...argv], { from: "user" });
  return { fake, out, err, run };
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
    expect(call.url).toBe("https://api.test/api/v1/public/sql");
    expect(call.init.method?.toUpperCase()).toBe("POST");
    expect(JSON.parse(call.init.body as string)).toEqual({
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
    [["sql", "SELECT", "1"], "quote the whole query"],
    [["sql", "SELECT 1", "--max-rows", "0"], "--max-rows must be at least 1"],
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
