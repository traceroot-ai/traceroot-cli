import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tailFile, watchEventFile } from "../../src/eval/tail.js";

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "traceroot-eval-tail-"));
  file = join(folder, "events.jsonl");
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("tailFile", () => {
  it("reads nothing from a file the runner hasn't created yet", () => {
    const tail = tailFile(file);

    expect(tail.read()).toEqual([]);
    appendFileSync(file, '{"type":"hello"}\n');
    expect(tail.read()).toEqual(['{"type":"hello"}']);
  });

  it("returns each finished line once, in the order it was written", () => {
    const tail = tailFile(file);

    appendFileSync(file, '{"n":1}\n{"n":2}\n');
    expect(tail.read()).toEqual(['{"n":1}', '{"n":2}']);
    expect(tail.read()).toEqual([]);
    appendFileSync(file, '{"n":3}\n');
    expect(tail.read()).toEqual(['{"n":3}']);
    expect(tail.read()).toEqual([]);
  });

  it("holds back a line the runner is part way through writing until its newline", () => {
    const tail = tailFile(file);

    appendFileSync(file, '{"type":"case_');
    expect(tail.read()).toEqual([]);
    appendFileSync(file, 'started"}\n{"type":"case_comp');
    expect(tail.read()).toEqual(['{"type":"case_started"}']);
    appendFileSync(file, "leted");
    expect(tail.read()).toEqual([]);
    appendFileSync(file, '"}\n');
    expect(tail.read()).toEqual(['{"type":"case_completed"}']);
  });

  it("keeps a character whose bytes arrive in two writes whole", () => {
    const tail = tailFile(file);
    const line = Buffer.from('{"name":"überprüfung 😀"}\n', "utf8");
    // Inside the emoji's four bytes.
    const cut = line.indexOf(Buffer.from("😀", "utf8")) + 2;

    appendFileSync(file, line.subarray(0, cut));
    expect(tail.read()).toEqual([]);
    appendFileSync(file, line.subarray(cut));
    expect(tail.read()).toEqual(['{"name":"überprüfung 😀"}']);
  });

  it("passes on blank lines and a carriage return as written, for the reader to skip", () => {
    const tail = tailFile(file);

    appendFileSync(file, '{"n":1}\r\n\n{"n":2}\n');

    expect(tail.read()).toEqual(['{"n":1}\r', "", '{"n":2}']);
  });
});

/** Resolves once `check` holds, checking every 5 ms for up to 2 seconds. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("watchEventFile", () => {
  it("passes on each line as it is finished, and nothing once it is stopped", async () => {
    const seen: string[] = [];
    const watch = watchEventFile(file, (lines) => seen.push(...lines), 10);
    try {
      appendFileSync(file, '{"n":1}\n{"n":');
      await until(() => seen.length === 1);
      appendFileSync(file, "2}\n");
      await until(() => seen.length === 2);
    } finally {
      watch.stop();
    }
    appendFileSync(file, '{"n":3}\n');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(seen).toEqual(['{"n":1}', '{"n":2}']);
  });

  it("skips a batch it can't pass on, and keeps reading", async () => {
    const seen: string[] = [];
    let calls = 0;
    const watch = watchEventFile(
      file,
      (lines) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("a reader that fails once");
        }
        seen.push(...lines);
      },
      10,
    );
    try {
      appendFileSync(file, '{"n":1}\n');
      await until(() => calls === 1);
      appendFileSync(file, '{"n":2}\n');
      await until(() => seen.length === 1);
    } finally {
      watch.stop();
    }

    // The first batch is never replayed, even though it failed.
    expect(seen).toEqual(['{"n":2}']);
  });
});
