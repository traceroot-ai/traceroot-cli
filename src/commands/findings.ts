import type { Command } from "commander";
import { ensureGroup } from "../registry/factory.js";
import { registerFindingsList } from "./findings/list.js";

export function registerFindings(program: Command): void {
  const findings = ensureGroup(program, "findings");
  registerFindingsList(findings);
}
