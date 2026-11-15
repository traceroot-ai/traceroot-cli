import type { StackLanguage } from "../setup/types.js";

/**
 * What it takes to run one evaluation file: the interpreter that has the
 * user's SDK installed, the runner entry point inside that SDK, and proof that
 * the SDK is new enough to write the events the CLI reads.
 *
 * The lookup only finds. The one process it starts is the Python version
 * probe; it runs nothing it found and chooses no exit code. Every way it can
 * fail is a {@link LookupFailure} with a one-line fix, never a thrown error, so
 * the command decides what each one exits with.
 */
export interface EvalRunner {
  language: StackLanguage;
  /** The installed SDK's version, already checked against its floor. */
  sdkVersion: string;
  /** The runner command, program first, spawned as given and never through a shell. */
  argv: string[];
}

export type LookupFailureKind =
  | "unsupported_extension"
  | "no_interpreter"
  | "sdk_missing"
  | "sdk_too_old"
  | "tsx_missing"
  | "tsx_too_old"
  | "node_too_old";

export interface LookupFailure {
  kind: LookupFailureKind;
  /** What was found, naming the interpreter, the versions and the floor involved. */
  message: string;
  /** The one thing to do about it. */
  fix: string;
}

export type RunnerLookup = { ok: true; runner: EvalRunner } | { ok: false; failure: LookupFailure };
