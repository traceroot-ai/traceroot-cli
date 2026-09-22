import type { Command } from "commander";
import type { Dataset } from "../../api/client.js";
import { type Writers, logProgress, writeJson } from "../../output.js";
import { type Wire, orDash, orNone, renderFields } from "./eval-reads.js";
import type { Enhancer, RenderContext } from "./types.js";

type DatasetDetail = Wire<Dataset>;

/** Rendering core, network-free. */
export function renderDataset(ds: DatasetDetail, writers: Writers): void {
  renderFields(
    [
      ["dataset id", orDash(ds.dataset_id)],
      ["name", orDash(ds.name)],
      ["key", orDash(ds.key)],
      ["description", orDash(ds.description)],
      ["current version", orNone(ds.current_dataset_version_id)],
    ],
    writers,
  );
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
  // No flags of its own. Without this the factory derives `--project-id` from the
  // tool's schema, and the project comes from the global --project on every other
  // read, as it does on the four sibling evaluation reads.
  flags(_cmd: Command): void {},
  render(payload: unknown, ctx: RenderContext): void {
    if (ctx.json) {
      writeJson(payload, ctx.writers);
      return;
    }
    renderDataset(payload as DatasetDetail, ctx.writers);
  },
};
