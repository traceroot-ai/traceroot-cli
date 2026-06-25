/**
 * Tolerates an API key pasted in its env-assignment form. Copying the key from
 * the UI yields `TRACEROOT_API_KEY=tr_...`; if a user pastes that whole string
 * (e.g. into `--api-key` or the interactive prompt), strip the
 * `TRACEROOT_API_KEY=` (optionally `export `-prefixed) and any surrounding
 * quotes so the bare key is used.
 */
export function normalizeApiKey(value: string): string {
  let key = value.trim();
  const assignment = key.match(/^(?:export\s+)?TRACEROOT_API_KEY\s*=\s*(.*)$/i);
  if (assignment?.[1] !== undefined) {
    key = assignment[1].trim();
  }
  if (key.length >= 2) {
    const first = key[0];
    const last = key[key.length - 1];
    if (first === last && (first === '"' || first === "'")) {
      key = key.slice(1, -1);
    }
  }
  return key;
}
