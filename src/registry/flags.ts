import { CliError, ExitCode } from "../output.js";

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
