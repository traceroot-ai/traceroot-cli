import { describe, expect, it } from "vitest";
import type {
  ApiClient,
  SqlQueryRequest,
  SqlQueryResponse,
  SqlSchemaResponse,
} from "../../src/api/client.js";
import { runSqlSchema } from "../../src/commands/sql/schema.js";
import type { Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

// Fixture intentionally contains NO columns named input, output, or metadata —
// those words only appear in the preamble/note sentence as human context.
const SCHEMA_RESPONSE: SqlSchemaResponse = {
  tables: [
    {
      name: "spans",
      columns: [
        { name: "span_id", type: "String" },
        { name: "model_name", type: "Nullable(String)" },
        { name: "duration_ms", type: "Float64" },
      ],
    },
    {
      name: "traces",
      columns: [
        { name: "trace_id", type: "String" },
        { name: "project_id", type: "String" },
        { name: "status", type: "String" },
      ],
    },
  ],
};

function makeSqlClient(opts: {
  schemaResponse?: SqlSchemaResponse;
  queryResponse?: SqlQueryResponse;
  queryError?: unknown;
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

describe("runSqlSchema", () => {
  it("default output contains spans, span_id, traces, trace_id and the preamble", async () => {
    const { client } = makeSqlClient({ schemaResponse: SCHEMA_RESPONSE });
    const { writers, out } = makeWriters();

    await runSqlSchema({ client, json: false, writers });

    expect(out.data).toContain("spans");
    expect(out.data).toContain("span_id");
    expect(out.data).toContain("traces");
    expect(out.data).toContain("trace_id");
    expect(out.data).toContain("Analytical export schema");
  });

  it("json output is one compact line equaling { tables, note }", async () => {
    const { client } = makeSqlClient({ schemaResponse: SCHEMA_RESPONSE });
    const { writers, out } = makeWriters();

    await runSqlSchema({ client, json: true, writers });

    const lines = out.data.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(out.data)).toEqual({
      tables: SCHEMA_RESPONSE.tables,
      note: "Analytical export schema. input/output/metadata blobs excluded from MVP.",
    });
  });

  describe("input/output/metadata columns absent from rendered schema content (regression)", () => {
    const FORBIDDEN_COLUMNS = ["input", "output", "metadata"];

    it("default output: no column cells in the rendered table equal input, output, or metadata", async () => {
      const { client } = makeSqlClient({ schemaResponse: SCHEMA_RESPONSE });
      const { writers, out } = makeWriters();

      await runSqlSchema({ client, json: false, writers });

      // Parse the COLUMN cells from the rendered out.data — the preamble legitimately
      // contains the words "input", "output", "metadata", so a naive substring check
      // would false-positive. Instead, find the header line, take all data rows that
      // follow it, and extract the second whitespace-separated token (the COLUMN cell).
      const lines = out.data.split("\n");
      const headerIdx = lines.findIndex((l) => l.trimStart().startsWith("TABLE"));
      const dataLines = lines.slice(headerIdx + 1).filter((l) => l.trim().length > 0);
      const columnCells = dataLines.map((l) => l.trim().split(/\s+/)[1] ?? "");
      for (const forbidden of FORBIDDEN_COLUMNS) {
        expect(columnCells).not.toContain(forbidden);
      }
    });

    it("json output: no JSON column names equal input, output, or metadata", async () => {
      const { client } = makeSqlClient({ schemaResponse: SCHEMA_RESPONSE });
      const { writers, out } = makeWriters();

      await runSqlSchema({ client, json: true, writers });

      const parsed = JSON.parse(out.data) as {
        tables: Array<{ columns: Array<{ name: string }> }>;
      };
      const allColNames = parsed.tables.flatMap((t) => t.columns.map((c) => c.name));
      for (const forbidden of FORBIDDEN_COLUMNS) {
        expect(allColNames).not.toContain(forbidden);
      }
    });
  });
});
