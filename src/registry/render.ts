import { type Writers, logProgress, writeJson } from "../output.js";
import { fieldLines } from "../render/fields.js";
import { createStyler } from "../render/style.js";
import { renderTable } from "../render/table.js";
import { plural } from "../util/index.js";

export interface DefaultRenderOptions {
  json: boolean;
  writers: Writers;
  /** Resolved tool args; used for the footer's limit fallback when meta.limit is absent. */
  args: Record<string, unknown>;
}

interface ListShape {
  data: Record<string, unknown>[];
  meta?: { limit?: number; total?: number };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isListShape(payload: unknown): payload is ListShape {
  if (typeof payload !== "object" || payload === null) return false;
  const data = (payload as { data?: unknown }).data;
  // Every item must be a plain object, or the table renderer would fabricate
  // columns (a string item's "keys" are its character indexes). Anything else
  // falls through to the key/value renderer.
  return Array.isArray(data) && data.every(isPlainObject);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Generic renderer for generated commands: `--json` emits the raw response;
 * list-shaped payloads (`{data: [...]}`) become the standard table + count
 * footer; anything else becomes an aligned key/value block. Enhancers replace
 * this per tool when curated output is required.
 */
export function renderDefault(payload: unknown, opts: DefaultRenderOptions): void {
  if (opts.json) {
    writeJson(payload, opts.writers);
    return;
  }
  if (isListShape(payload)) {
    renderListPayload(payload, opts);
    return;
  }
  renderObjectPayload(payload, opts.writers);
}

function renderListPayload(payload: ListShape, opts: DefaultRenderOptions): void {
  const { writers } = opts;
  // Column set is the union of every row's keys (first-occurrence order), so a
  // row 0 that happens to omit an optional field cannot hide a whole column.
  const keys: string[] = [];
  for (const item of payload.data) {
    for (const key of Object.keys(item)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  if (keys.length > 0) {
    const headers = keys.map((key) => key.replaceAll("_", " ").toUpperCase());
    const rows = payload.data.map((item) => keys.map((key) => cellText(item[key])));
    const styler = createStyler(writers.out);
    writers.out.write(`${renderTable(headers, rows, { headerStyle: styler.bold })}\n`);
  }
  const returned = payload.data.length;
  const total = payload.meta?.total;
  const countText =
    typeof total === "number" && total > returned
      ? `${returned} of ${total} ${plural(total, "item")}`
      : `${returned} ${plural(returned, "item")}`;
  const limitArg = typeof opts.args.limit === "number" ? opts.args.limit : undefined;
  const effectiveLimit = payload.meta?.limit ?? limitArg;
  logProgress(
    effectiveLimit === undefined ? countText : `${countText} | limit ${effectiveLimit}`,
    writers,
  );
}

const LABEL_WORDS = new Map([
  ["id", "ID"],
  ["ids", "IDs"],
  ["url", "URL"],
]);

/**
 * A response key as the curated commands label it: `detector_id` →
 * `Detector ID`, `run_ids` → `Run IDs`, and a time drops its `_at`, so
 * `updated_at` → `Updated`.
 */
function labelFor(key: string): string {
  const words = key
    .replace(/_at$/, "")
    .split("_")
    .map((word) => LABEL_WORDS.get(word) ?? word)
    .join(" ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function renderObjectPayload(payload: unknown, writers: Writers): void {
  if (typeof payload !== "object" || payload === null) {
    writers.out.write(`${cellText(payload)}\n`);
    return;
  }
  const fields = Object.entries(payload as Record<string, unknown>).map(
    ([key, value]): [string, string] => [
      labelFor(key),
      value === null || value === undefined ? "—" : cellText(value),
    ],
  );
  for (const line of fieldLines(fields, createStyler(writers.out))) {
    writers.out.write(`${line}\n`);
  }
}
