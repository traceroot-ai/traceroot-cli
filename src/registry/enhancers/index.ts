import { tracesExport } from "./traces-export.js";
import { tracesGet } from "./traces-get.js";
import { tracesList } from "./traces-list.js";
import type { Enhancer } from "./types.js";

/** Per-tool presentation overrides, applied by the factory over the generated
 * defaults. Absence = fully generated command (the zero-code path). */
export const ENHANCERS: Partial<Record<string, Enhancer>> = {
  list_traces: tracesList,
  get_trace: tracesGet,
  export_trace: tracesExport,
};
