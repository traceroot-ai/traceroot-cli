import { describe, expect, it } from "vitest";
import type { ApiClient, Whoami } from "../../src/api/client.js";
import { runStatus } from "../../src/commands/status.js";
import { configPath, globalConfigPath } from "../../src/config/manager.js";
import type { AuthSource } from "../../src/config/resolve.js";
import type { Context } from "../../src/context.js";
import { CliError, type Writers } from "../../src/output.js";
import { StringSink } from "../helpers/stringSink.js";

const FULL_TOKEN = "tr_secret_LEAK";

function makeWhoami(overrides: Partial<Whoami> = {}): Whoami {
  return {
    host: "https://api.example.com",
    project_id: "proj_123",
    project_name: "My Project",
    workspace_id: "ws_456",
    workspace_name: "My Workspace",
    key_name: "ci-key",
    key_hint: "tr_***1234",
    ui_base_url: "https://app.example.com",
    ...overrides,
  };
}

function makeContext(json: boolean, source: AuthSource = "config"): Context {
  return {
    auth: {
      apiKey: { value: FULL_TOKEN, source },
      hostUrl: { value: "https://api.example.com", source },
    },
    json,
  };
}

function fakeClient(whoami: () => Promise<Whoami>): ApiClient {
  return {
    whoami,
    listTraces: () => Promise.reject(new Error("not used")),
    getTrace: () => Promise.reject(new Error("not used")),
    exportTrace: () => Promise.reject(new Error("not used")),
  };
}

function makeWriters(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

describe("runStatus (human)", () => {
  it("writes identity (project/workspace/key_hint/host) to stdout", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami({ key_hint: "tr_***1234" });
    await runStatus({
      ctx: makeContext(false),
      client: fakeClient(() => Promise.resolve(who)),
      writers,
    });

    expect(out.data).toContain("My Project");
    expect(out.data).toContain("My Workspace");
    expect(out.data).toContain("tr_***1234");
    expect(out.data).toContain("https://api.example.com");
    expect(out.data).toContain("https://app.example.com");
  });

  it("never prints the full api token", async () => {
    const { writers, out, err } = makeWriters();
    const who = makeWhoami();
    await runStatus({
      ctx: makeContext(false),
      client: fakeClient(() => Promise.resolve(who)),
      writers,
    });

    expect(out.data).not.toContain(FULL_TOKEN);
    expect(err.data).not.toContain(FULL_TOKEN);
  });

  it("shows the resolved config source", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami();
    await runStatus({
      ctx: makeContext(false),
      client: fakeClient(() => Promise.resolve(who)),
      writers,
    });

    expect(out.data).toContain("config");
  });

  it("shows the global config path when credentials resolved from the global fallback", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami();
    await runStatus({
      ctx: makeContext(false, "global-config"),
      client: fakeClient(() => Promise.resolve(who)),
      writers,
    });

    expect(out.data).toContain(globalConfigPath());
  });

  it("shows the key name and hint without brackets", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami({ key_name: "ci-key", key_hint: "tr_***1234" });
    await runStatus({
      ctx: makeContext(false),
      client: fakeClient(() => Promise.resolve(who)),
      writers,
    });

    expect(out.data).toContain("ci-key tr_***1234"); // name then hint, no brackets
    expect(out.data).not.toContain("[tr_***1234]");
    expect(out.data).not.toContain("(none)");
  });

  it("shows only the hint (no name field) when the key has no name", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami({ key_name: null, key_hint: "tr_***1234" });
    await runStatus({
      ctx: makeContext(false),
      client: fakeClient(() => Promise.resolve(who)),
      writers,
    });

    expect(out.data).toContain("API key:       tr_***1234");
    expect(out.data).not.toContain("(unknown)");
    expect(out.data).not.toContain("[tr_***1234]");
  });

  it("falls back to the id as primary when a name is null", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami({ workspace_name: null });
    await runStatus({
      ctx: makeContext(false),
      client: fakeClient(() => Promise.resolve(who)),
      writers,
    });

    expect(out.data).toContain("ws_456");
    expect(out.data).not.toContain("(none)");
  });

  it("renders names first with dimmed ids on a TTY", async () => {
    const out = new StringSink(true);
    const err = new StringSink(true);
    const who = makeWhoami();
    await runStatus({
      ctx: makeContext(false),
      client: fakeClient(() => Promise.resolve(who)),
      writers: { out, err },
    });

    // Name comes first; the id is wrapped in the ANSI dim code.
    expect(out.data).toContain("My Project \x1b[2m(proj_123)\x1b[0m");
    expect(out.data).toContain("My Workspace \x1b[2m(ws_456)\x1b[0m");
  });
});

describe("runStatus (--json)", () => {
  it("writes exactly one JSON document that round-trips and includes config_source", async () => {
    const { writers, out, err } = makeWriters();
    const who = makeWhoami({ key_hint: "tr_***1234" });
    await runStatus({
      ctx: makeContext(true),
      client: fakeClient(() => Promise.resolve(who)),
      writers,
    });

    const parsed = JSON.parse(out.data) as Record<string, unknown>;
    expect(parsed.project_id).toBe("proj_123");
    expect(parsed.workspace_id).toBe("ws_456");
    expect(parsed.key_hint).toBe("tr_***1234");
    expect(parsed.host).toBe("https://api.example.com");
    expect(parsed.ui_base_url).toBe("https://app.example.com");
    expect(parsed.config_source).toBe("config");
    expect(parsed.config_path).toBe(configPath());
    // Exactly one document: stripped of its single trailing newline, no extra lines.
    expect(out.data.trimEnd().split("\n")).toHaveLength(1);
    expect(err.data).toBe("");
  });

  it("reports the global config path as config_path when the global config won", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami();
    await runStatus({
      ctx: makeContext(true, "global-config"),
      client: fakeClient(() => Promise.resolve(who)),
      writers,
    });

    const parsed = JSON.parse(out.data) as Record<string, unknown>;
    expect(parsed.config_source).toBe("global-config");
    expect(parsed.config_path).toBe(globalConfigPath());
  });

  it("never prints the full api token in JSON mode", async () => {
    const { writers, out } = makeWriters();
    const who = makeWhoami();
    await runStatus({
      ctx: makeContext(true),
      client: fakeClient(() => Promise.resolve(who)),
      writers,
    });

    expect(out.data).not.toContain(FULL_TOKEN);
  });
});

describe("runStatus errors", () => {
  it("propagates a whoami CliError and writes nothing to stdout", async () => {
    const { writers, out } = makeWriters();
    const client = fakeClient(() => Promise.reject(new CliError("auth failed")));

    await expect(runStatus({ ctx: makeContext(false), client, writers })).rejects.toBeInstanceOf(
      CliError,
    );
    expect(out.data).toBe("");
  });
});
