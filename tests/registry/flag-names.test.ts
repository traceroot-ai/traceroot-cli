import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY } from "@traceroot-ai/tools";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli.js";
import { CliError, ExitCode } from "../../src/output.js";
import { FLAG_NAMES } from "../../src/registry/naming.js";
import { createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";
import { StringSink } from "../helpers/stringSink.js";

function harness() {
  const fake = createFakeFetch(() => jsonResponse({ id: "a1" }));
  const program = buildProgram({
    registry: {
      fetchImpl: fake.fetchImpl,
      writers: { out: new StringSink(), err: new StringSink() },
    },
  });
  const run = (...argv: string[]) =>
    program.parseAsync(["--api-key", "k", "--host", "https://api.test", "--json", ...argv], {
      from: "user",
    });
  const body = () => JSON.parse(String(fake.calls[0]?.init.body)) as Record<string, unknown>;
  return { fake, program, run, body };
}

const CREATE = [
  "alerts",
  "create",
  "--project-id",
  "p1",
  "--name",
  "n",
  "--view",
  "SPANS",
  "--measure",
  "duration_ms",
  "--aggregation",
  "p95",
  "--window",
  "5m",
  "--threshold-operator",
  ">",
  "--threshold",
  "1500",
  "--renotify",
  '{"mode":"OFF"}',
];
const UPDATE = ["alerts", "update", "a1", "--project-id", "p1"];

async function usageError(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).exitCode).toBe(ExitCode.usage);
  return (err as CliError).message;
}

function subcommand(program: Command, ...path: string[]): Command {
  let cmd = program;
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (next === undefined) throw new Error(`no command '${path.join(" ")}'`);
    cmd = next;
  }
  return cmd;
}

function allCommands(cmd: Command): Command[] {
  return [cmd, ...cmd.commands.flatMap(allCommands)];
}

describe("alerts --on-no-data", () => {
  it("sends the no-data mode on create", async () => {
    const h = harness();
    await h.run(...CREATE, "--on-no-data", "NOTIFY");
    expect(h.fake.calls[0]?.init.method).toBe("POST");
    expect(h.body().no_data_mode).toBe("NOTIFY");
  });

  it("sends only the no-data mode on update", async () => {
    const h = harness();
    await h.run(...UPDATE, "--on-no-data", "ZERO");
    expect(h.fake.calls[0]?.init.method).toBe("PATCH");
    expect(h.body()).toEqual({ project_id: "p1", no_data_mode: "ZERO" });
  });

  it("leaves the field out of an update that doesn't set it", async () => {
    const h = harness();
    await h.run(...UPDATE, "--name", "renamed");
    expect(h.body()).not.toHaveProperty("no_data_mode");
  });

  it.each([["--no-data-mode", "NOTIFY"], ["--no-data-mode=NOTIFY"]])(
    "accepts the field's own spelling %s as the same flag",
    async (...flag) => {
      const h = harness();
      await h.run(...UPDATE, ...flag);
      expect(h.body().no_data_mode).toBe("NOTIFY");
    },
  );

  it.each([
    [["--on-no-data", "ZERO", "--on-no-data", "HOLD"], "--on-no-data may only be given once"],
    [["--no-data-mode", "ZERO", "--no-data-mode", "HOLD"], "--no-data-mode may only be given once"],
    [
      ["--on-no-data", "ZERO", "--no-data-mode", "ZERO"],
      "--on-no-data may only be given once (--no-data-mode is the same flag)",
    ],
  ])("rejects %j before any request", async (flags, message) => {
    const h = harness();
    expect(await usageError(h.run(...UPDATE, ...flags))).toBe(message);
    expect(h.fake.calls).toHaveLength(0);
  });

  it.each([["--on-no-data"], ["--no-data-mode"]])(
    "names --on-no-data when %s gets a value outside the enum",
    async (flag) => {
      const h = harness();
      expect(await usageError(h.run(...UPDATE, flag, "SOMETIMES"))).toBe(
        "--on-no-data must be one of: HOLD, ZERO, NOTIFY",
      );
      expect(h.fake.calls).toHaveLength(0);
    },
  );

  describe("with --from-file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tr-on-no-data-"));
    const file = (body: Record<string, unknown>) => {
      const path = join(dir, `${Object.values(body).join("-")}.json`);
      writeFileSync(path, JSON.stringify(body));
      return path;
    };

    it("lets the flag override the file's value", async () => {
      const h = harness();
      await h.run(
        ...UPDATE,
        "--from-file",
        file({ no_data_mode: "HOLD" }),
        "--on-no-data",
        "NOTIFY",
      );
      expect(h.body().no_data_mode).toBe("NOTIFY");
    });

    it("names --on-no-data for a bad value in the file", async () => {
      const h = harness();
      const message = await usageError(
        h.run(...UPDATE, "--from-file", file({ no_data_mode: "SOMETIMES" })),
      );
      expect(message).toBe("--on-no-data must be one of: HOLD, ZERO, NOTIFY");
    });
  });

  it.each([["create"], ["update"]])(
    "shows --on-no-data in alerts %s --help, without the alias",
    (name) => {
      const help = subcommand(harness().program, "alerts", name).helpInformation();
      expect(help).toContain("--on-no-data <value>");
      expect(help).not.toContain("--no-data-mode");
    },
  );
});

describe("flag names", () => {
  it("names only fields the registry has", () => {
    const fields = new Set(REGISTRY.flatMap((entry) => Object.keys(entry.inputSchema.properties)));
    for (const field of Object.keys(FLAG_NAMES)) expect(fields).toContain(field);
  });

  it("refuses to register a field whose flag would start with --no-", () => {
    const saved = FLAG_NAMES.no_data_mode as string;
    // biome-ignore lint/performance/noDelete: the guard keys off the field being absent
    delete FLAG_NAMES.no_data_mode;
    try {
      expect(() => buildProgram()).toThrow(
        "'create_alert' field 'no_data_mode' would get the flag --no-data-mode",
      );
    } finally {
      FLAG_NAMES.no_data_mode = saved;
    }
  });

  it("gives every --no- option either no value or no negation", () => {
    // commander treats a --no- flag as switching another flag off and presets
    // that flag's key to true; on an option that takes a value, that preset
    // reads as an earlier use and the value lands under the wrong key.
    const offenders = allCommands(buildProgram()).flatMap((cmd) =>
      cmd.options
        .filter((o) => o.long?.startsWith("--no-") && o.negate && (o.required || o.optional))
        .map((o) => `${cmd.name()} ${o.flags}`),
    );
    expect(offenders).toEqual([]);
  });
});
