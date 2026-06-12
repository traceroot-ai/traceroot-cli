import type { Styler } from "./style.js";

/**
 * Renders a named entity name-first with its id de-emphasized, e.g.
 * `my-project (proj_123)` where the id is dimmed. When the name is missing the
 * id becomes the primary (undimmed) identifier rather than printing a
 * placeholder name. Shared by `status` and `login` so both read identically.
 */
export function identity(name: string | null, id: string, styler: Styler): string {
  return name !== null && name !== "" ? `${name} ${styler.dim(`(${id})`)}` : id;
}

/**
 * Renders an API key as its name followed by the masked hint (dimmed, no
 * surrounding brackets), e.g. `ci-key tr_…1234`. When the key has no name only
 * the dimmed hint is shown; when neither is present it falls back to
 * `(unknown)`.
 */
export function apiKeyLabel(name: string | null, hint: string | null, styler: Styler): string {
  const dimHint = hint !== null && hint !== "" ? styler.dim(hint) : "";
  if (name !== null && name !== "") {
    return `${name} ${dimHint}`.trimEnd();
  }
  return dimHint || "(unknown)";
}
