import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSpawnTarget, runProcess } from "../../src/setup/exec.js";
import { makeSecret } from "../../src/setup/secret.js";

const NODE = process.execPath;
const KEY = "tr-secret-value-long-enough";
/** Process groups are POSIX-only, so the group-wide kill is too. */
const WINDOWS = process.platform === "win32";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), "traceroot-exec-"));

function shell(script: string, extra: Record<string, unknown> = {}) {
  return {
    program: "sh",
    args: ["-c", script],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    stdio: "capture" as const,
    ...extra,
  };
}

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

describe("a timeout the child's own children cannot outlast", () => {
  it.skipIf(WINDOWS)("fires while a grandchild is still holding the pipes open", async () => {
    // `close` fires only once every holder of the stdio pipes has closed them,
    // and a grandchild inherits them — so this resolved after the full eight
    // seconds, with `timedOut: true` but half a minute late. The stage that
    // runs the project's test command would never have timed out at all for
    // any `npm test` or `pytest` that starts a server or a watcher.
    const started = Date.now();
    const result = await runProcess(shell("sleep 8 & sleep 8", { timeoutMs: 500 }));

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.skipIf(WINDOWS)("takes the grandchild down rather than leaving it running", async () => {
    // `child.kill` signals only the direct child, so the grandchild survived
    // the timeout along with whatever port or lock it was holding. The marker
    // is written a second after the kill, so it exists only if it survived.
    const dir = await workspace();
    const marker = join(dir, "survived");

    const result = await runProcess(
      shell(`sh -c 'sleep 1; : > "${marker}"' & sleep 8`, { timeoutMs: 300 }),
    );
    await sleep(1500);

    expect(result.timedOut).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(WINDOWS)("escalates to SIGKILL when nothing in the tree honours SIGTERM", async () => {
    // An ignored signal survives `exec`, so neither the shell nor its `sleep`
    // takes this SIGTERM. Gating the escalation on the promise would skip it
    // exactly here, now that the promise settles once the direct child exits.
    const started = Date.now();
    const result = await runProcess(shell('trap "" TERM; sleep 10', { timeoutMs: 300 }));

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(128 + 9);
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it("does not throw when the escalation lands on a group that has already gone", async () => {
    // `process.kill(-pid, …)` throws ESRCH once the group is empty, and the
    // escalation probes it two seconds after the SIGTERM — long after this run
    // settled, so an unhandled one surfaces as an uncaught error rather than a
    // rejected promise.
    const errors: unknown[] = [];
    const record = (error: unknown): void => {
      errors.push(error);
    };

    process.on("uncaughtException", record);
    try {
      const result = await runProcess(opts("setTimeout(() => {}, 10000)", { timeoutMs: 200 }));
      expect(result.timedOut).toBe(true);
      await sleep(2600);
    } finally {
      process.off("uncaughtException", record);
    }

    expect(errors).toEqual([]);
  }, 15000);
});

describe("settling once the child exits rather than once the pipes close", () => {
  it.skipIf(WINDOWS)("settles even when a survivor has left the process group", async () => {
    // Killing the group is not enough on its own: a grandchild spawned
    // `detached` leads a session of its own, so no group signal reaches it, and
    // it holds the pipes long after the child this run spawned is gone. Only
    // settling on `exit` bounds the wait.
    const dir = await workspace();
    const escapee = join(dir, "escapee.cjs");
    const child = join(dir, "child.cjs");
    await writeFile(escapee, "setTimeout(() => {}, 4000);");
    await writeFile(
      child,
      [
        'const { spawn } = require("node:child_process");',
        // `detached`, so the kill below cannot reach it; `inherit`, so it is
        // holding this run's stdio pipes open the whole time.
        'spawn(process.execPath, [process.argv[2]], { stdio: "inherit", detached: true });',
        "setTimeout(() => {}, 4000);",
      ].join("\n"),
    );

    const started = Date.now();
    const result = await runProcess({
      program: process.execPath,
      args: [child, escapee],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      stdio: "capture",
      timeoutMs: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still hands back the whole of a long output", async () => {
    // The bounded drain is what makes settling on `exit` safe: the pipe can
    // still hold what the child wrote just before exiting, and dropping it
    // would silently truncate the tail of a captured test run.
    const script = [
      'const line = "x".repeat(99) + "\\n";',
      "for (let i = 0; i < 20000; i += 1) process.stdout.write(line);",
    ].join("");

    const chunks: string[] = [];
    const result = await runProcess(opts(script, { onData: (c: string) => chunks.push(c) }));

    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBe(20000 * 100);
    expect(chunks.join("")).toBe(result.output);
  });

  it("leaves no signal handler behind once the run is over", async () => {
    // The forwarding handler below exists only while a detached child does. A
    // permanent one would change how the CLI itself answers Ctrl+C.
    const before = process.listenerCount("SIGINT");

    await runProcess(opts('console.log("done")'));

    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("a Ctrl+C part-way through a captured run", () => {
  it.skipIf(WINDOWS)(
    "kills the detached child and still ends the CLI",
    async () => {
      // A detached child is not in the terminal's foreground group, so Ctrl+C
      // reaches the CLI alone — which is what this harness reproduces by
      // signalling only its own pid. The child must not outlive the cancelled
      // run, and the signal must still end the CLI with the status it always had.
      const dir = await workspace();
      const marker = join(dir, "survived");
      const grandchild = join(dir, "grandchild.cjs");
      const child = join(dir, "child.cjs");
      const harness = join(dir, "harness.mjs");
      const module = new URL("../../dist/setup/exec.js", import.meta.url).href;

      await writeFile(
        grandchild,
        'setTimeout(() => require("node:fs").writeFileSync(process.argv[2], "late"), 1500);',
      );
      await writeFile(
        child,
        [
          'const { spawn } = require("node:child_process");',
          // `inherit`, so this is the grandchild that holds the pipes open.
          'spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "inherit" });',
          "setTimeout(() => {}, 8000);",
        ].join("\n"),
      );
      await writeFile(
        harness,
        [
          `const { runProcess } = await import(${JSON.stringify(module)});`,
          "const run = runProcess({",
          "  program: process.execPath,",
          `  args: [${JSON.stringify(child)}, ${JSON.stringify(grandchild)}, ${JSON.stringify(marker)}],`,
          `  cwd: ${JSON.stringify(dir)},`,
          '  env: { PATH: process.env.PATH ?? "" },',
          '  stdio: "capture",',
          "});",
          'setTimeout(() => process.kill(process.pid, "SIGINT"), 400);',
          "await run;",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [harness], { encoding: "utf8" });
      await sleep(2000);

      expect(result.signal).toBe("SIGINT");
      expect(existsSync(marker)).toBe(false);
    },
    15000,
  );
});

describe("a survivor that ignored SIGTERM", () => {
  it.skipIf(WINDOWS)(
    "is still escalated to SIGKILL once the run has settled",
    async () => {
      // The run settles a quarter-second after the direct child exits, which is
      // the moment a grandchild that ignored SIGTERM is still running. The
      // escalation is the only thing left that ends it, so it has to keep the
      // CLI alive long enough to fire: this harness awaits the run and then has
      // nothing else to do, which is the shape of the last stage of a run.
      const dir = await workspace();
      const marker = join(dir, "survived");
      const grandchild = join(dir, "grandchild.cjs");
      const child = join(dir, "child.cjs");
      const harness = join(dir, "harness.mjs");
      const module = new URL("../../dist/setup/exec.js", import.meta.url).href;

      await writeFile(
        grandchild,
        [
          // Ignoring SIGTERM is what leaves only the escalation, and `inherit`
          // below is what makes it the holder of the run's stdio pipes.
          'process.on("SIGTERM", () => {});',
          'setTimeout(() => require("node:fs").writeFileSync(process.argv[2], "late"), 3500);',
        ].join("\n"),
      );
      await writeFile(
        child,
        [
          'const { spawn } = require("node:child_process");',
          'spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "inherit" });',
          "setTimeout(() => {}, 8000);",
        ].join("\n"),
      );
      await writeFile(
        harness,
        [
          `const { runProcess } = await import(${JSON.stringify(module)});`,
          "await runProcess({",
          "  program: process.execPath,",
          `  args: [${JSON.stringify(child)}, ${JSON.stringify(grandchild)}, ${JSON.stringify(marker)}],`,
          `  cwd: ${JSON.stringify(dir)},`,
          '  env: { PATH: process.env.PATH ?? "" },',
          '  stdio: "capture",',
          "  timeoutMs: 300,",
          "});",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [harness], { encoding: "utf8" });
      await sleep(4000);

      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
    },
    19000,
  );
});

describe("a cancelled run whose binary is missing", () => {
  it("neither signals the CLI's own group nor waits out the escalation", async () => {
    // A failed spawn hands back a child with no pid and emits `error` with no
    // `exit` to follow it, so the run settles with `exited` still false. On a
    // run cancelled before the stage started, that left two marks. The SIGTERM
    // went through `child.kill` on a child that never existed, which reaches
    // `kill(0, …)` — the CLI's OWN process group — and `stillRunning()` read
    // that child as live, so the escalation was never cleared: a referenced
    // two-second timer held the CLI open after a run that had settled in three
    // milliseconds.
    //
    // Out of process, and `detached` so the harness leads a group of its own:
    // that stray signal would otherwise land on the test runner's group. The
    // harness catches it rather than dying of it, so the escalation delay is
    // observable too instead of being cut short.
    const dir = await workspace();
    const harness = join(dir, "harness.mjs");
    const module = new URL("../../dist/setup/exec.js", import.meta.url).href;

    await writeFile(
      harness,
      [
        `const { runProcess } = await import(${JSON.stringify(module)});`,
        "let selfSignalled = null;",
        'process.on("SIGTERM", () => {',
        '  selfSignalled = "SIGTERM";',
        "});",
        "const controller = new AbortController();",
        "controller.abort();",
        "const result = await runProcess({",
        '  program: "traceroot-no-such-binary-exists",',
        "  args: [],",
        `  cwd: ${JSON.stringify(dir)},`,
        '  env: { PATH: process.env.PATH ?? "" },',
        '  stdio: "capture",',
        "  signal: controller.signal,",
        "});",
        // Node dispatches a signal handler from the event loop rather than from
        // the `kill` that raised it, so a pending one needs a turn to arrive.
        "await new Promise((resolve) => setTimeout(resolve, 100));",
        "const { exitCode, spawnFailed } = result;",
        "process.stdout.write(`${JSON.stringify({ exitCode, spawnFailed, selfSignalled })}\\n`);",
      ].join("\n"),
    );

    const started = Date.now();
    // Node's `spawnSync` honours `detached`, but @types/node leaves it out of
    // the sync options; the intersection says so without a cast.
    const options: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = {
      encoding: "utf8",
      detached: true,
    };
    const run = spawnSync(process.execPath, [harness], options);
    const elapsed = Date.now() - started;

    expect(run.signal).toBe(null);
    expect(run.status).toBe(0);
    expect(elapsed).toBeLessThan(1500);
    const reported = JSON.parse(run.stdout) as {
      exitCode: number;
      spawnFailed: boolean;
      selfSignalled: string | null;
    };
    expect(reported.selfSignalled).toBe(null);
    // The outcome itself is unchanged: the caller still learns that the program
    // was never there.
    expect(reported.spawnFailed).toBe(true);
    expect(reported.exitCode).toBe(127);
  }, 15000);
});

describe("resolving what to spawn on Windows", () => {
  const NODEJS = "C:\\Program Files\\nodejs";
  const SHIM = `${NODEJS}\\npm.cmd`;
  const COMSPEC = "C:\\Windows\\system32\\cmd.exe";

  /**
   * The win32 branch with the platform injected, so the shape it produces is
   * pinned from a POSIX host. `isFile` is case-insensitive because NTFS is, and
   * the candidate spellings come from PATHEXT's own casing.
   */
  const onWindows = (
    program: string,
    args: readonly string[],
    files: readonly string[],
    env: NodeJS.ProcessEnv = {},
  ) =>
    resolveSpawnTarget(program, args, {
      platform: "win32",
      env: {
        Path: `${NODEJS};C:\\Windows\\system32`,
        PATHEXT: ".exe;.cmd",
        ComSpec: COMSPEC,
        ...env,
      },
      isFile: (path) => files.some((candidate) => candidate.toLowerCase() === path.toLowerCase()),
    });

  it("runs a package manager's batch shim through cmd.exe, which is the only way to run one", () => {
    // `npm`, `pnpm` and `yarn` are `.cmd` shims on Windows, and a shell-less
    // spawn of one is refused by Node outright — so `npm test` could not be run
    // at all, and the report blamed the project's own check for it.
    expect(onWindows("npm", ["test"], [SHIM])).toEqual({
      program: COMSPEC,
      args: ["/d", "/s", "/c", `""${SHIM}" "test""`],
      windowsVerbatimArguments: true,
    });
  });

  it("prefers an executable PATHEXT entry, and spawns that one without a shell", () => {
    // The shell is for shims only. Anything `CreateProcess` can start is still
    // started directly, so the no-shell guarantee covers every ordinary case.
    const target = onWindows(
      "python",
      ["-m", "pytest"],
      [`${NODEJS}\\python.exe`, `${NODEJS}\\python.cmd`],
    );

    expect(target?.program.toLowerCase()).toBe(`${NODEJS}\\python.exe`.toLowerCase());
    expect(target?.args).toEqual(["-m", "pytest"]);
    expect(target?.windowsVerbatimArguments).toBe(false);
  });

  it("refuses a command line cmd.exe would re-interpret rather than escaping it", () => {
    // The point of spawning without a shell is that a manifest field never
    // reaches one. Quoting does not undo that on its own: cmd.exe expands
    // `%VAR%` inside quotes and a `"` ends the quoted run. Refused, so a value
    // out of the customer's repository cannot become part of the command.
    expect(onWindows("npm", ["run", "test & whoami"], [SHIM])).toBe(null);
    expect(onWindows("npm", ["run", "%USERPROFILE%"], [SHIM])).toBe(null);
    expect(onWindows("npm", ["run", 'say"hi'], [SHIM])).toBe(null);
    expect(onWindows("npm", ["run", "out\\"], [SHIM])).toBe(null);
    expect(onWindows("npm", ["run", "(x)"], [SHIM])).toBe(null);
  });

  it("ignores a shim sitting in the repository rather than on the child's PATH", () => {
    // `CreateProcess` searches the current directory, which here is the
    // customer's repository: an `npm.cmd` checked into it must never be run in
    // preference to the real one. Nothing on PATH answers, so nothing is
    // spawned: handing Node the bare name would let its own search find it.
    const target = resolveSpawnTarget("npm", ["test"], {
      platform: "win32",
      env: { Path: `${NODEJS};C:\\Windows\\system32`, PATHEXT: ".exe;.cmd", ComSpec: COMSPEC },
      cwd: "C:\\repo",
      isFile: (path) => path.toLowerCase() === "c:\\repo\\npm.cmd",
    });

    expect(target).toBe(null);
  });

  it("searches the child's own PATH, not this process's", () => {
    // A caller composes the child's environment to decide what resolves — a
    // virtualenv prepended so `pytest` is the one inside it. Resolving against
    // `process.env` instead would spawn a different program than the one the
    // run was set up to measure.
    const venv = "C:\\repo\\.venv\\Scripts";
    const target = onWindows("pytest", [], [`${venv}\\pytest.exe`], { Path: venv });

    expect(target?.program).toBe(`${venv}\\pytest.exe`);
  });

  it("quotes the program's own path rather than refusing the usual install location", () => {
    // `C:\Program Files (x86)\…` is where a great many Windows installs put
    // it, and parentheses are literal inside a quoted run. A rule strict enough
    // for an argument out of a manifest would refuse the program itself.
    const shim = "C:\\Program Files (x86)\\nodejs\\npm.cmd";
    const target = onWindows("npm", ["test"], [shim], { Path: "C:\\Program Files (x86)\\nodejs" });

    expect(target).toEqual({
      program: COMSPEC,
      args: ["/d", "/s", "/c", `""${shim}" "test""`],
      windowsVerbatimArguments: true,
    });
  });

  it("takes an explicit path to a shim without searching PATH for it", () => {
    const target = onWindows("C:\\tools\\check.cmd", ["--ci"], ["C:\\tools\\check.cmd"]);

    expect(target).toEqual({
      program: COMSPEC,
      args: ["/d", "/s", "/c", '""C:\\tools\\check.cmd" "--ci""'],
      windowsVerbatimArguments: true,
    });
  });

  it("finds a relative program from the child's working directory, not this process's", () => {
    // The spawn runs it from `cwd`, so that is where it has to be looked for:
    // checking this process's own directory would find a different file, or
    // miss the shim and hand the spawn a batch file it refuses.
    const target = resolveSpawnTarget("scripts\\check.cmd", [], {
      platform: "win32",
      env: { ComSpec: COMSPEC },
      cwd: "C:\\repo\\api",
      isFile: (path) => path === "C:\\repo\\api\\scripts\\check.cmd",
    });

    expect(target?.args).toEqual(["/d", "/s", "/c", '""C:\\repo\\api\\scripts\\check.cmd""']);
  });

  it("leaves a POSIX spawn exactly as it was handed over", () => {
    // No shims, and `execvp` does the lookup: resolving here would only add a
    // way for the two to disagree.
    expect(
      resolveSpawnTarget("npm", ["test"], {
        platform: "linux",
        env: { PATH: "/usr/bin" },
        isFile: () => true,
      }),
    ).toEqual({ program: "npm", args: ["test"], windowsVerbatimArguments: false });
  });
});

describe("spawning a batch shim on Windows", () => {
  // The resolution above is only half of the fix: these pin that `runProcess`
  // spawns what it resolved to, and spawns nothing when the line was refused.
  // The platform is stubbed and `ComSpec` is a script that prints its own
  // arguments, so the spawn Windows would make is observed from a POSIX host.
  const asWindows = async <T>(body: () => Promise<T>): Promise<T> => {
    const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { ...real, value: "win32" });
    try {
      return await body();
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  };

  const fixture = async () => {
    const dir = await workspace();
    const shim = join(dir, "npm.cmd");
    const comspec = join(dir, "comspec");
    await writeFile(shim, "");
    await writeFile(comspec, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
    return { dir, shim, comspec };
  };

  it.skipIf(WINDOWS)("runs the shim through ComSpec, on the line built for it", async () => {
    const { dir, shim, comspec } = await fixture();

    const result = await asWindows(() =>
      runProcess({
        program: shim,
        args: ["test"],
        cwd: dir,
        env: { ComSpec: comspec },
        stdio: "capture",
      }),
    );

    expect(result.spawnFailed).toBe(false);
    expect(result.output).toBe(`/d\n/s\n/c\n""${shim}" "test""\n`);
  });

  it.skipIf(WINDOWS)("starts nothing when the command line was refused", async () => {
    // Reported as a failed spawn, because that is what it is: the command was
    // never run. The same fixture spawns in the test above, so an empty output
    // here means the shell was never started, not that it could not be.
    const { dir, shim, comspec } = await fixture();

    const result = await asWindows(() =>
      runProcess({
        program: shim,
        args: ["run", "test & whoami"],
        cwd: dir,
        env: { ComSpec: comspec },
        stdio: "capture",
      }),
    );

    expect(result).toMatchObject({ exitCode: 127, output: "", spawnFailed: true });
  });
});
