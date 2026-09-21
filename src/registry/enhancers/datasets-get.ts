import { type Writers, logProgress, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { orDash, orNone } from "./eval-reads.js";
import type { Enhancer, RenderContext } from "./types.js";

interface Dataset {
  dataset_id: string;
  name: string;
  key?: string | null;
  description?: string | null;
  current_dataset_version_id?: string | null;
}

/** Rendering core, network-free. */
export function renderDataset(ds: Dataset, writers: Writers): void {
  const styler = createStyler(writers.out);
  const fields: [string, string][] = [
    ["dataset id", ds.dataset_id],
    ["name", ds.name],
    ["key", orDash(ds.key)],
    ["description", orDash(ds.description)],
    ["current version", orNone(ds.current_dataset_version_id)],
  ];
  const width = Math.max(...fields.map(([label]) => label.length));
  for (const [label, value] of fields) {
    writers.out.write(`${styler.bold(label.padEnd(width))}  ${value}\n`);
  }
  // Saying so beats leaving a reader to infer it from "(none)": nothing is
  // wrong, there is simply no snapshot to read cases out of yet.
  if (ds.current_dataset_version_id === null || ds.current_dataset_version_id === undefined) {
    logProgress(
      "no version has been published, so this dataset has nothing to read yet — " +
        "publish one from the SDK, then `traceroot datasets versions get <version-id>`",
      writers,
    );
  }
}

export const datasetsGet: Enhancer = {
  render(payload: unknown, ctx: RenderContext): void {
    if (ctx.json) {
      writeJson(payload, ctx.writers);
      return;
    }
    renderDataset(payload as Dataset, ctx.writers);
  },
};
