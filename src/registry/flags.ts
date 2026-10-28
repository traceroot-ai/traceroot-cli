import { CliError, ExitCode } from "../output.js";
import type { ResolveInput } from "./enhancers/types.js";

/**
 * Rejects stray positional operands beyond what the command declared. The
 * factory's default resolve path always calls this; an enhancer's `resolveArgs`
 * must call it too (see the contract note on `Enhancer.resolveArgs`) unless it
 * deliberately owns `input.extras` itself. Lives here — a leaf module — so
 * enhancers never have to import from the factory (which imports the enhancers).
 */
export function rejectExtras(input: ResolveInput): void {
  if (input.extras.length > 0) {
    throw new CliError(`unexpected argument(s): ${input.extras.join(" ")}`, ExitCode.usage);
  }
}

/**
 * Coercion that rejects a flag given more than once. Relies on Commander passing
 * the previously parsed value as `prev` on a repeat occurrence (and `undefined`
 * on the first). IMPORTANT: do NOT set `.default(...)` on any option using this —
 * Commander would pass that default as `prev` on the first use and falsely reject it.
 */
export function onceOption(flag: string): (val: string, prev: string | undefined) => string {
  return (val: string, prev: string | undefined): string => {
    if (prev !== undefined) {
      throw new CliError(`${flag} may only be given once`, ExitCode.usage);
    }
    return val;
  };
}

/**
 * Parser for a schema boolean's optional value. A presence-only switch can
 * only send `true`, so a field whose `false` matters (a detector's `enabled`
 * pause switch) needs this value form. Commander calls this only when a value
 * follows the flag; a bare `--flag` still means true.
 * Strict on purpose: an optional value swallows the next non-dash operand, so
 * anything that is not true/false (a misplaced positional) must fail loudly.
 */
export function booleanOption(flag: string): (val: string) => boolean {
  return (val: string): boolean => {
    const normalized = val.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw new CliError(
      `${flag} must be true or false, got '${val}'; a value right after ${flag} is read as its value, so put positional arguments first or write ${flag}=true`,
      ExitCode.usage,
    );
  };
}
