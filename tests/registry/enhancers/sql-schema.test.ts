import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { SqlResult, SqlSchema } from "../../../src/api/client.js";
import { buildProgram } from "../../../src/cli.js";
import { CliError, ExitCode } from "../../../src/output.js";
import { renderSqlSchema } from "../../../src/registry/enhancers/sql-schema.js";
import { GROUPS, PLACEMENTS } from "../../../src/registry/naming.js";
import { createFakeFetch, errorResponse, jsonResponse } from "../../helpers/fakeFetch.js";
import { StringSink } from "../../helpers/stringSink.js";

/** Shaped like the server's curated schema, abbreviated. */
function makeSchema(): SqlSchema {
  return {
    tables: [
      {
        name: "spans",
        columns: [
          { name: "span_id", type: "String" },
          { name: "duration_ms", type: "Nullable(Int64)" },
          { name: "metadata", type: "Map(LowCardinality(String), String)" },
        ],
      },
      {
        name: "traces",
        columns: [
          { name: "trace_id", type: "String" },
          { name: "trace_start_time", type: "DateTime64(3)" },
        ],
      },
    ],
  };
}

function harness(response: Response) {
  const fake = createFakeFetch(() => response);
  const out = new StringSink();
  const err = new StringSink();
  const program = buildProgram({ registry: { fetchImpl: fake.fetchImpl, writers: { out, err } } });
  const run = (...argv: string[]) =>
    program.parseAsync(["--api-key", "k", "--host", "https://api.test", ...argv], { from: "user" });
  return { fake, out, err, run, program };
}

function sqlCommand(program: Command): Command {
  const sql = program.commands.find((command) => command.name() === "sql");
  if (sql === undefined) throw new Error("sql not registered");
  return sql;
}

describe("renderSqlSchema", () => {
  it("prints one row per column with its table and type, starting at the header", () => {
    const out = new StringSink();
    renderSqlSchema(makeSchema(), { json: false, writers: { out, err: new StringSink() } });
    // No prose ahead of the table: stdout is data, so piping it to grep or awk
    // gets rows and nothing else, as with every other command.
    const lines = out.data.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^TABLE\s+COLUMN\s+TYPE$/);
    expect(lines[1]).toMatch(/^spans\s+span_id\s+String$/);
    expect(lines[4]).toMatch(/^traces\s+trace_id\s+String$/);
    expect(lines).toHaveLength(6);
  });

  it("emits the server's response unchanged with --json", () => {
    const out = new StringSink();
    renderSqlSchema(makeSchema(), { json: true, writers: { out, err: new StringSink() } });
    expect(JSON.parse(out.data)).toEqual(makeSchema());
  });
});

describe("traceroot sql schema", () => {
  it("GETs the schema route and renders it", async () => {
    const h = harness(jsonResponse(makeSchema()));
    await h.run("sql", "schema");
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0].url).toBe("https://api.test/api/v1/public/sql/schema");
    expect(h.fake.calls[0].init.method?.toUpperCase() ?? "GET").toBe("GET");
    expect(h.out.data).toMatch(/^TABLE\s+COLUMN\s+TYPE/);
  });

  it("still runs a query through `sql` itself now that it has a subcommand", async () => {
    const result: SqlResult = {
      columns: [{ name: "n", type: "UInt64" }],
      rows: [[1]],
      row_count: 1,
      truncated: false,
      elapsed_ms: 1,
      statistics: {},
    };
    const h = harness(jsonResponse(result));
    await h.run("sql", "SELECT count() AS n FROM spans", "--json");
    expect(h.fake.calls[0].url).toBe("https://api.test/api/v1/public/sql");
    expect(JSON.parse(h.out.data)).toEqual(result);
  });

  it.each(["--csv", "--output=x.csv", "--max-rows=5", "--param=a=1", "--file=q.sql"])(
    "refuses the query flag %s instead of silently ignoring it",
    async (flag) => {
      const h = harness(jsonResponse(makeSchema()));
      const err = await h.run("sql", "schema", flag).catch((e) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(ExitCode.usage);
      expect((err as CliError).message).toMatch(/is not an option of 'sql schema'$/);
      expect(h.fake.calls).toHaveLength(0);
    },
  );

  it("lists only the program's options as global in its help", () => {
    const { program } = harness(jsonResponse(makeSchema()));
    const schema = sqlCommand(program).commands.find((command) => command.name() === "schema");
    const help = schema?.helpInformation() ?? "";
    expect(help).toContain("--api-key");
    expect(help).not.toContain("--file");
    expect(help).not.toContain("--csv");
  });

  it("shows schema under the sql command's help", () => {
    const { program } = harness(jsonResponse(makeSchema()));
    expect(sqlCommand(program).helpInformation()).toMatch(/Commands:\n\s+schema\s/);
  });

  it("points a missing-column error at `sql schema`", async () => {
    const h = harness(
      errorResponse(400, "Query references a column that does not exist in the public schema."),
    );
    const err = await h.run("sql", "SELECT input FROM spans").catch((e) => e);
    expect((err as CliError).message).toMatch(/\nHint: run `traceroot sql schema`/);
  });
});

describe("a top-level command that is also a group", () => {
  it("reuses the group only when the name is one", () => {
    // `status` is a hand-written top-level command, not a GROUPS entry, so a
    // placement colliding with it must still fail loudly.
    expect(() =>
      buildProgram({
        registry: {
          placements: { ...PLACEMENTS, get_sql_schema: { kind: "command", path: ["status"] } },
          groups: GROUPS,
        },
      }),
    ).toThrow(/cannot add command 'status'/);
  });
});
