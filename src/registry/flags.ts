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
