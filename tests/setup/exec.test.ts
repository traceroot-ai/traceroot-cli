import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/setup/exec.js";
import { makeSecret } from "../../src/setup/secret.js";

const NODE = process.execPath;
const KEY = "tr-secret-value-long-enough";

function opts(script: string, extra: Record<string, unknown> = {}) {
  return {
    program: NODE,
    args: ["-e", script],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    stdio: "capture" as const,
    ...extra,
  };
}

describe("capturing a child's output", () => {
  it("redacts a credential on the streaming path, not only in the buffer", async () => {
    // A caller renders these chunks straight into the wizard's feed, so an
    // unscrubbed chunk is a visible leak of the key the same run just minted —
    // while the buffered `output` was already being scrubbed.
    const chunks: string[] = [];
    const result = await runProcess(
      opts(`console.log("running with ${KEY}")`, {
        onData: (chunk: string) => chunks.push(chunk),
        secrets: [makeSecret(KEY)],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).not.toContain(KEY);
    expect(chunks.join("")).toContain("<redacted>");
    expect(result.output).not.toContain(KEY);
  });
});

describe("cancelling a run", () => {
  it("kills a child whose signal aborted before it was spawned", async () => {
    // The run-wide signal outlives one stage, so after a cancellation mid-run
    // this is the ordinary case: `addEventListener` never fires for a signal
    // that is already aborted, and nothing else would stop the child.
    const controller = new AbortController();
    controller.abort();

    const result = await runProcess(
      opts("setTimeout(() => {}, 10000)", { signal: controller.signal }),
    );

    expect(result.exitCode).not.toBe(0);
  }, 10000);

  it("reports which signal killed the child, not Ctrl+C for everything", async () => {
    // 130 is specifically 128 + SIGINT. Reporting it for a timeout made a child
    // this module killed itself look like a user interrupt.
    const result = await runProcess(opts("setTimeout(() => {}, 10000)", { timeoutMs: 200 }));

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(128 + 15);
  }, 10000);
});

describe("decoding what the child writes", () => {
  it("reassembles a character split across two chunks", async () => {
    // `git status -z` paths come through this capture. Decoding each chunk with
    // `buf.toString("utf8")` turned a straddling character into U+FFFD, so a
    // non-ASCII path came back as one the worktree does not have.
    const script = [
      'const b = Buffer.from("café.ts", "utf8");',
      // Byte 4 lands inside the two-byte `é`.
      "process.stdout.write(b.subarray(0, 4));",
      "setTimeout(() => process.stdout.write(b.subarray(4)), 50);",
    ].join("");

    const chunks: string[] = [];
    const result = await runProcess(opts(script, { onData: (c: string) => chunks.push(c) }));

    expect(result.output).toBe("café.ts");
    expect(result.output).not.toContain("\ufffd");
    expect(chunks.join("")).toBe("café.ts");
  }, 10000);
});

describe("a process that ends mid-character", () => {
  it("hands the caller the same text it streamed", async () => {
    // The decoder holds a truncated character until it is flushed. Flushing into
    // `output` alone made the streamed view and the returned output differ by
    // exactly that text, so a caller rendering progress showed one thing and the
    // caller reading the result got another.
    const script = [
      'const b = Buffer.from("café", "utf8");',
      // Stops inside the two-byte `é`, so the decoder is still holding a byte.
      "process.stdout.write(b.subarray(0, 4));",
    ].join("");

    const chunks: string[] = [];
    const result = await runProcess(opts(script, { onData: (c: string) => chunks.push(c) }));

    expect(chunks.join("")).toBe(result.output);
    expect(result.output.startsWith("caf")).toBe(true);
  }, 10000);
});
