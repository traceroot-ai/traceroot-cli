import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const binPath = fileURLToPath(new URL("../bin/traceroot.mjs", import.meta.url));

// Isolate from any real ~/.traceroot/config.json and ambient credentials so
// `status` deterministically resolves no credentials and exercises the failure
// contract (non-zero exit, empty stdout, error on stderr) on every machine.
const isolatedEnv: NodeJS.ProcessEnv = {
  ...process.env,
  TRACEROOT_CONFIG_PATH: join(tmpdir(), "traceroot-cli-no-such-config", "config.json"),
  TRACEROOT_API_KEY: "",
  TRACEROOT_HOST_URL: "",
};

function runIsolated(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: isolatedEnv,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("output contract (spawned failing command)", () => {
  it("writes nothing to stdout, an error to stderr, and exits non-zero", () => {
    const { stdout, stderr, status } = runIsolated("status");
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
  });

  it("keeps the same contract under --json", () => {
    const { stdout, stderr, status } = runIsolated("--json", "status");
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
  });

  it("emits no ANSI escape sequences when spawned (non-TTY)", () => {
    const { stdout, stderr } = runIsolated("status");
    expect(stdout).not.toContain("\x1b[");
    expect(stderr).not.toContain("\x1b[");
  });
});

// These tests drive the REAL spawned binary against a throwaway localhost API so
// `traces get` runs end-to-end without a network. The stub API runs as its OWN
// process (helpers/traceServer.mjs): the tests block the event loop on the
// synchronous `spawnSync`, so an in-process server could never answer.
describe("output contract (traces get against a local server)", () => {
  const SPAN_COUNT = 2000;
  const serverPath = fileURLToPath(new URL("./helpers/traceServer.mjs", import.meta.url));
  let server: ChildProcess;
  let host: string;

  beforeAll(async () => {
    server = spawn(process.execPath, [serverPath], {
      env: { ...process.env, SPAN_COUNT: String(SPAN_COUNT) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    host = await new Promise<string>((resolve, reject) => {
      let buf = "";
      server.stdout?.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const match = /PORT (\d+)/.exec(buf);
        if (match) {
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      server.on("error", reject);
      setTimeout(() => reject(new Error("traceServer did not report a port in time")), 10_000);
    });
  });

  afterAll(() => {
    server.kill();
  });

  function get(...args: string[]): ReturnType<typeof runIsolated> {
    return runIsolated("--host", host, "--api-key", "test-key", "traces", "get", ...args);
  }

  it("emits jsonl: a header line then one JSON-parseable span per line", () => {
    const { stdout, status } = get("tr-1", "--output", "jsonl");
    expect(status).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(SPAN_COUNT + 1); // header + one per span
    // Every line is independently valid JSON.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const header = JSON.parse(lines[0] as string);
    expect(header.spans).toBeUndefined(); // header excludes the spans array
    expect(header.trace_id).toBe("tr-1");
    expect(JSON.parse(lines[1] as string).span_id).toBe("s-0");
  });

  it("surfaces the true total in the truncation marker under --json --max-spans", () => {
    const { stdout, status } = get("tr-1", "--json", "--max-spans", "5");
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.spans).toHaveLength(5);
    expect(parsed.spans_truncated).toEqual({ shown: 5, total: SPAN_COUNT });
  });

  it("stays head-safe: `traces get --output jsonl | head -1` exits cleanly with no stack trace", () => {
    // A large trace keeps the CLI writing while `head` closes the pipe, forcing
    // the EPIPE path. The global handler must turn that into a quiet exit.
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        `'${process.execPath}' '${binPath}' --host '${host}' --api-key test-key traces get tr-1 --output jsonl | head -1`,
      ],
      { encoding: "utf8", env: isolatedEnv },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).not.toMatch(/EPIPE|at .*\(/); // no Node stack trace
    expect(JSON.parse(result.stdout.trim()).trace_id).toBe("tr-1");
  });
});
