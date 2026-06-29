import { describe, expect, it } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import type { SqlQueryResponse, SqlSchemaResponse } from "../../src/api/client.js";
import { CliError } from "../../src/output.js";
import { createFakeFetch, errorResponse, jsonResponse } from "../helpers/fakeFetch.js";

const API_KEY = "tr_secret_LEAK";

function clientWith(responder: Parameters<typeof createFakeFetch>[0], host = "https://h") {
  const fake = createFakeFetch(responder);
  const client = createApiClient({ host, apiKey: API_KEY, fetchImpl: fake.fetchImpl });
  return { client, calls: fake.calls };
}

describe("sqlQuery", () => {
  it("POSTs to /api/v1/public/sql with correct method, headers, and body", async () => {
    const mockResponse: SqlQueryResponse = {
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "string" },
      ],
      rows: [
        [1, "Alice"],
        [2, "Bob"],
      ],
      row_count: 2,
      truncated: false,
      elapsed_ms: 42,
      statistics: {},
    };
    const { client, calls } = clientWith(() => jsonResponse(mockResponse));
    await client.sqlQuery({
      query: "SELECT * FROM users",
      parameters: { model: "gpt-4o" },
      max_rows: 100,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://h/api/v1/public/sql");
    expect(calls[0]?.init.method).toBe("POST");

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.query).toBe("SELECT * FROM users");
    expect(body.parameters).toEqual({ model: "gpt-4o" });
    expect(body.max_rows).toBe(100);
  });

  it("returns the parsed SqlQueryResponse", async () => {
    const mockResponse: SqlQueryResponse = {
      columns: [{ name: "count", type: "integer" }],
      rows: [[42]],
      row_count: 1,
      truncated: false,
      elapsed_ms: 10,
      statistics: { bytes_processed: 1024 },
    };
    const { client } = clientWith(() => jsonResponse(mockResponse));
    const result = await client.sqlQuery({ query: "SELECT COUNT(*) FROM traces" });
    expect(result).toEqual(mockResponse);
  });

  it("maps a non-2xx detail response to CliError", async () => {
    const { client } = clientWith(() => errorResponse(400, "Unknown table 'users'..."));
    await expect(client.sqlQuery({ query: "SELECT * FROM users" })).rejects.toBeInstanceOf(
      CliError,
    );
    await expect(client.sqlQuery({ query: "SELECT * FROM users" })).rejects.toThrow(
      /Unknown table 'users'/,
    );
  });

  it("keeps the api key out of a network-failure CliError via sqlQuery", async () => {
    const { client } = clientWith(() => {
      throw new Error(`boom ${API_KEY}`);
    });
    const err = await client.sqlQuery({ query: "SELECT 1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    const e = err as CliError;
    expect(e.message).not.toContain(API_KEY);
    expect(String(e)).not.toContain(API_KEY);
  });
});

describe("sqlSchema", () => {
  it("GETs /api/v1/public/sql/schema with bearer auth", async () => {
    const mockResponse: SqlSchemaResponse = {
      tables: [{ name: "traces", columns: [{ name: "id", type: "string" }] }],
    };
    const { client, calls } = clientWith(() => jsonResponse(mockResponse));
    await client.sqlSchema();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://h/api/v1/public/sql/schema");
    expect(calls[0]?.init.method).toBe("GET");

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("returns the parsed SqlSchemaResponse", async () => {
    const mockResponse: SqlSchemaResponse = {
      tables: [
        {
          name: "traces",
          columns: [
            { name: "id", type: "string" },
            { name: "created_at", type: "timestamp" },
          ],
        },
      ],
    };
    const { client } = clientWith(() => jsonResponse(mockResponse));
    const result = await client.sqlSchema();
    expect(result).toEqual(mockResponse);
  });
});
