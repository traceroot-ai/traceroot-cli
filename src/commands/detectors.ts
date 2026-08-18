import type { Command } from "commander";
import { ensureGroup } from "../registry/factory.js";
import { registerDetectorsList } from "./detectors/list.js";

export function registerDetectors(program: Command): void {
  const detectors = ensureGroup(program, "detectors");
  registerDetectorsList(detectors);
}
