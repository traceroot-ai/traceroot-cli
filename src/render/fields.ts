import type { Writers } from "../output.js";
import { type Styler, createStyler } from "./style.js";

/**
 * A record's fields as aligned `Label:  value` lines, the one layout every
 * `get` command prints a record in: each label is bold and ends in a colon,
 * and every value starts two spaces after the longest label.
 */
export function fieldLines(fields: [string, string][], styler: Styler): string[] {
  const width = Math.max(0, ...fields.map(([label]) => label.length));
  return fields.map(
    ([label, value]) =>
      `${styler.bold(`${label}:`)}${" ".repeat(width - label.length + 2)}${value}`,
  );
}

/** {@link fieldLines}, written to stdout. */
export function renderFields(fields: [string, string][], writers: Writers): void {
  for (const line of fieldLines(fields, createStyler(writers.out))) {
    writers.out.write(`${line}\n`);
  }
}
