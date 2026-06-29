import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ApiClient,
  SqlQueryRequest,
  SqlQueryResponse,
  SqlSchemaResponse,
} from "../../src/api/client.js";
import {
  parseMaxRows,
  resolveFormat,
  resolveQuery,
  runSqlQuery,
} from "../../src/commands/sql/query.js";
import { CliError, type Writers } from "../../src/output.js";
import { runCli } from "../helpers/runCli.js";
import { StringSink } from "../helpers/stringSink.js";

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

const BASE_RESPONSE: SqlQueryResponse = {
  columns: [
    { name: "model_name", type: "String" },
    { name: "n", type: "UInt64" },
  ],
  rows: [
    ["gpt-4,turbo", 42], // comma → CSV quoting required
    ['he said "hello"', 7], // quote → CSV double-escape required
  ],
  row_count: 2,
  truncated: false,
  elapsed_ms: 10,
  statistics: {},
};

function makeSqlClient(opts: {
  queryResponse?: SqlQueryResponse;
  queryError?: unknown;
  schemaResponse?: SqlSchemaResponse;
}): { client: ApiClient; calls: { sqlQuery: SqlQueryRequest[] } } {
  const calls = { sqlQuery: [] as SqlQueryRequest[] };
  const client: ApiClient = {
    whoami: () => Promise.reject(new Error("not used")),
    listTraces: () => Promise.reject(new Error("not used")),
    getTrace: () => Promise.reject(new Error("not used")),
    exportTrace: () => Promise.reject(new Error("not used")),
    sqlQuery: (body) => {
      calls.sqlQuery.push(body);
      if (opts.queryError) return Promise.reject(opts.queryError);
      return Promise.resolve(opts.queryResponse as SqlQueryResponse);
    },
    sqlSchema: () => Promise.resolve(opts.schemaResponse as SqlSchemaResponse),
  };
  return { client, calls };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "tr-sql-query-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("runSqlQuery", () => {
  it("table output writes aligned table with headers and data to out; nothing is JSON", async () => {
    const { client } = makeSqlClient({ queryResponse: BASE_RESPONSE });
    const { writers, out } = makeWriters();

    await runSqlQuery({ client, query: "SELECT 1", format: "table", writers });

    expect(out.data).toContain("model_name");
    expect(out.data).toContain("n");
    expect(out.data).toContain("gpt-4,turbo");
    // Sanity: table mode never emits the JSON "columns" key
    expect(out.data).not.toContain('"columns"');
  });

  it("json output writes exactly one compact JSON line that deep-equals the response", async () => {
    const { client } = makeSqlClient({ queryResponse: BASE_RESPONSE });
    const { writers, out } = makeWriters();

    await runSqlQuery({ client, query: "SELECT 1", format: "json", writers });

    const lines = out.data.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(out.data)).toEqual(BASE_RESPONSE);
  });

  it("csv output writes a header line and correctly quoted cells with trailing newline", async () => {
    const { client } = makeSqlClient({ queryResponse: BASE_RESPONSE });
    const { writers, out } = makeWriters();

    await runSqlQuery({ client, query: "SELECT 1", format: "csv", writers });

    expect(out.data.startsWith("model_name,n\n")).toBe(true);
    expect(out.data).toContain('"gpt-4,turbo"'); // comma in value → quoted field
    expect(out.data).toContain('"he said ""hello"""'); // quote in value → doubled inside quotes
    expect(out.data.endsWith("\n")).toBe(true);
  });

  it("output file write stores the formatted bytes and out stays empty", async () => {
    const { client } = makeSqlClient({ queryResponse: BASE_RESPONSE });
    const { writers, out } = makeWriters();
    const outputPath = join(tmpRoot, "result.csv");

    await runSqlQuery({ client, query: "SELECT 1", format: "csv", outputPath, writers });

    const contents = readFileSync(outputPath, "utf8");
    expect(contents).toContain("model_name,n");
    expect(out.data).toBe("");
  });

  it("truncation warning appears in err for table mode", async () => {
    const truncated: SqlQueryResponse = { ...BASE_RESPONSE, truncated: true };
    const { client } = makeSqlClient({ queryResponse: truncated });
    const { writers, err } = makeWriters();

    await runSqlQuery({ client, query: "SELECT 1", format: "table", writers });

    expect(err.data).toContain("truncated");
  });

  it("truncation warning appears in err for csv mode", async () => {
    const truncated: SqlQueryResponse = { ...BASE_RESPONSE, truncated: true };
    const { client } = makeSqlClient({ queryResponse: truncated });
    const { writers, err } = makeWriters();

    await runSqlQuery({ client, query: "SELECT 1", format: "csv", writers });

    expect(err.data).toContain("truncated");
  });

  it("no truncation warning in err when format is json, even when truncated:true", async () => {
    const truncated: SqlQueryResponse = { ...BASE_RESPONSE, truncated: true };
    const { client } = makeSqlClient({ queryResponse: truncated });
    const { writers, err } = makeWriters();

    await runSqlQuery({ client, query: "SELECT 1", format: "json", writers });

    expect(err.data).not.toContain("truncated");
  });

  it("max-rows value is forwarded in the request body", async () => {
    const { client, calls } = makeSqlClient({ queryResponse: BASE_RESPONSE });
    const { writers } = makeWriters();

    await runSqlQuery({ client, query: "SELECT 1", format: "table", maxRows: 1000, writers });

    expect(calls.sqlQuery[0]?.max_rows).toBe(1000);
  });

  it("CliError from client.sqlQuery propagates and message contains the detail", async () => {
    const detail = "Unknown table 'users'. Allowed tables: spans, traces.";
    const { client } = makeSqlClient({ queryError: new CliError(detail) });
    const { writers } = makeWriters();

    await expect(
      runSqlQuery({ client, query: "SELECT * FROM users", format: "table", writers }),
    ).rejects.toBeInstanceOf(CliError);

    await expect(
      runSqlQuery({ client, query: "SELECT * FROM users", format: "table", writers }),
    ).rejects.toThrow(detail);
  });

  it("table mode renders an object cell via JSON.stringify", async () => {
    const objectResponse: SqlQueryResponse = {
      ...BASE_RESPONSE,
      columns: [{ name: "data", type: "String" }],
      rows: [[{ a: 1 }]],
      row_count: 1,
    };
    const { client } = makeSqlClient({ queryResponse: objectResponse });
    const { writers, out } = makeWriters();

    await runSqlQuery({ client, query: "SELECT 1", format: "table", writers });

    expect(out.data).toContain('{"a":1}');
  });
});

describe("resolveQuery", () => {
  it("returns the positional query string as-is", () => {
    expect(resolveQuery({ positional: "SELECT 1" })).toBe("SELECT 1");
  });

  it("reads and returns the UTF-8 contents of a .sql file", () => {
    const sqlFile = join(tmpRoot, "query.sql");
    writeFileSync(sqlFile, "SELECT count() FROM spans", "utf8");

    expect(resolveQuery({ file: sqlFile })).toBe("SELECT count() FROM spans");
  });

  it("throws CliError when both positional and file are provided", () => {
    expect(() => resolveQuery({ positional: "SELECT 1", file: "query.sql" })).toThrow(CliError);
  });

  it("throws CliError when neither positional nor file is provided", () => {
    expect(() => resolveQuery({})).toThrow(CliError);
  });

  it("throws CliError with 'the query is empty' when positional is whitespace-only", () => {
    expect(() => resolveQuery({ positional: "   " })).toThrow(CliError);
    expect(() => resolveQuery({ positional: "   " })).toThrow("the query is empty");
  });

  it("throws CliError starting with 'could not read query file' when file does not exist", () => {
    const missing = join(tmpRoot, "no-such-file.sql");
    expect(() => resolveQuery({ file: missing })).toThrow(CliError);
    expect(() => resolveQuery({ file: missing })).toThrow("could not read query file");
  });
});

describe("resolveFormat", () => {
  it("returns 'table' when neither json nor csv is set", () => {
    expect(resolveFormat({ json: false, csv: false })).toBe("table");
  });

  it("returns 'json' when json is true", () => {
    expect(resolveFormat({ json: true, csv: false })).toBe("json");
  });

  it("returns 'csv' when csv is true", () => {
    expect(resolveFormat({ json: false, csv: true })).toBe("csv");
  });

  it("throws CliError when both json and csv are true", () => {
    expect(() => resolveFormat({ json: true, csv: true })).toThrow(CliError);
  });
});

describe("parseMaxRows", () => {
  it("returns undefined when raw is undefined", () => {
    expect(parseMaxRows(undefined)).toBeUndefined();
  });

  it("parses a valid positive integer string", () => {
    expect(parseMaxRows("1000")).toBe(1000);
  });

  it("throws CliError for zero", () => {
    expect(() => parseMaxRows("0")).toThrow(CliError);
  });

  it("throws CliError for a non-integer string", () => {
    expect(() => parseMaxRows("x")).toThrow(CliError);
  });
});

describe("sql runCli surface", () => {
  it("exits non-zero and stderr mentions the unknown option when --nope is passed", () => {
    const { status, stderr } = runCli("sql", "SELECT 1", "--nope");

    expect(status).not.toBe(0);
    expect(stderr).toContain("--nope");
  });
});
