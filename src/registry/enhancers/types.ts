import type { Command } from "commander";
import type { Writers } from "../../output.js";

/** Raw command inputs the factory hands to `resolveArgs`, before schema coercion. */
export interface ResolveInput {
  opts: Record<string, unknown>;
  positionals: Record<string, string | undefined>;
  extras: string[];
}

/** The tool args to dispatch, optionally redirecting to a companion tool and
 * carrying enhancer-owned state through to `render`. */
export interface Resolved {
  tool?: string;
  args: Record<string, unknown>;
  state?: unknown;
}

/** Everything an enhancer's `render` needs to produce output for one invocation. */
export interface RenderContext {
  json: boolean;
  writers: Writers;
  args: Record<string, unknown>;
  state: unknown;
  dispatchTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Per-tool presentation override, applied by the factory over the generated
 * defaults. Every field is optional — an enhancer overrides only what it needs;
 * everything else stays on the generated (zero-code) path.
 */
export interface Enhancer {
  description?: string;
  /**
   * Replaces the generated positionals entirely. Contract: must declare
   * exactly as many arguments as the placement's `positionals` lists, in the
   * same order — the factory enforces this at registration time and throws
   * if the counts diverge. An override may only relax requiredness (e.g.
   * `<x>` → `[x]`); it may never add or remove positional slots, since the
   * factory maps `positionals[i]` to the i-th declared argument by index.
   */
  arguments?: (cmd: Command) => void;
  /** Replaces the schema-derived flags entirely. */
  flags?: (cmd: Command) => void;
  /**
   * Supplying `resolveArgs` means owning `input.extras` — the factory no
   * longer rejects stray positional operands on your behalf. Call
   * `rejectExtras(input)` (from `../factory.js`) unless you deliberately
   * consume the extras yourself (e.g. to produce a legacy-verbatim message).
   */
  resolveArgs?: (input: ResolveInput) => Resolved;
  render?: (payload: unknown, ctx: RenderContext) => void | Promise<void>;
}
