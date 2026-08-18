import type { Command } from "commander";
import { ensureGroup } from "../registry/factory.js";
import { registerFindingsGet } from "./findings/get.js";
import { registerFindingsList } from "./findings/list.js";

export function registerFindings(program: Command): void {
  const findings = ensureGroup(program, "findings");
  registerFindingsList(findings);
  registerFindingsGet(findings);
}
