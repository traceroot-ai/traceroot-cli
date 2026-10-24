import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runProcess } from "../../src/setup/exec.js";

/**
 * `child_process` emits `error` for more than a failure to start, and the rest
 * cannot be provoked with a real process: a `kill` the kernel refuses needs a
 * child this run is not allowed to signal (one that re-execed something
 * setuid), which no test can arrange portably. So these tests mock `spawn` —
 * the only file here that does — and drive the events Node would emit.
 */

const state = vi.hoisted(() => ({
  /** The fake the last `spawn` handed back, so a test can drive its events. */
  child: null as unknown,
  /** What `spawn` leaves on the child; undefined is a child that never ran. */
  pid: undefined as number | undefined,
  /** What the fake does when the module signals it. */
  onKill: null as ((child: EventEmitter) => void) | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: () => {
      const child = new FakeChild();
      state.child = child;
      return child;
    },
  };
});

/** The surface of a `ChildProcess` that {@link runProcess} touches. */
class FakeChild extends EventEmitter {
  readonly pid: number | undefined = state.pid;
  readonly stdout = null;
  readonly stderr = null;
  readonly stdin = null;

  kill(): boolean {
    state.onKill?.(this);
    return false;
  }
}

/** The error Node emits from `kill` for anything but ESRCH, EINVAL or ENOSYS. */
function killRefused(): Error {
  return Object.assign(new Error("kill EPERM"), { code: "EPERM" });
}

function opts(extra: Record<string, unknown> = {}) {
  return {
    // A file that exists on every host, named by its absolute path. `spawn` is
    // mocked, so it never runs, but on Windows the module resolves the program
    // first and refuses a bare name nothing on PATH answers to, which would
    // settle these runs as failures to start before any fake was made.
    program: process.execPath,
    args: [],
    cwd: process.cwd(),
    env: {},
    stdio: "capture" as const,
    ...extra,
  };
}

function driven(): FakeChild {
  const child = state.child;
  if (!(child instanceof FakeChild)) {
    throw new Error("spawn was not called");
  }
  return child;
}

describe("an error event that is not a failure to start", () => {
  it("does not report a kill it could not deliver as an unstartable command", async () => {
    // `inherit` is the reachable shape: it is the only stdio this module does
    // not detach, so it is the one whose timeout and abort paths signal through
    // `child.kill` rather than the process group — and `kill` is what emits
    // this. Before, the run settled as a spawn failure with status 127, and the
    // wizard told the user their command could not be started, about a command
    // that had been running for the whole timeout.
    state.pid = 4242;
    state.onKill = (child) => child.emit("error", killRefused());

    const result = await runProcess(opts({ stdio: "inherit", timeoutMs: 5 }));

    expect(result.spawnFailed).toBe(false);
    expect(result.exitCode).not.toBe(127);
    // Why the signal was sent survives, so the caller can still say it timed
    // out rather than that it failed for no stated reason.
    expect(result.timedOut).toBe(true);
  });

  it("keeps the real status when the error arrives after the child has exited", async () => {
    // A captured run settles on `exit` plus a drain grace period, so there is a
    // window where the status is known and the promise is not yet settled.
    // Taking an error in that window as a spawn failure replaced a real exit
    // code with 127.
    state.pid = 4243;
    state.onKill = null;

    const pending = runProcess(opts());
    const child = driven();
    child.emit("exit", 3, null);
    child.emit("error", killRefused());
    const result = await pending;

    expect(result.exitCode).toBe(3);
    expect(result.spawnFailed).toBe(false);
  });

  it("still reports the failure to start that arrives on the same event", async () => {
    // ENOENT, EACCES, EAGAIN, EMFILE and ENFILE come back here instead of
    // throwing, and the child Node hands back for them has no pid. That is the
    // whole of the difference from the two cases above.
    state.pid = undefined;
    state.onKill = null;

    const pending = runProcess(opts());
    driven().emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    const result = await pending;

    expect(result.spawnFailed).toBe(true);
    expect(result.exitCode).toBe(127);
  });
});
