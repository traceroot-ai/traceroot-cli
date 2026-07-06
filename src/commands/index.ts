import type { Command } from "commander";
import { registerDetectors } from "./detectors.js";
import { registerDoctor } from "./doctor.js";
import { registerFindings } from "./findings.js";
import { registerInstrument } from "./instrument.js";
import { registerLogin } from "./login.js";
import { registerSkills } from "./skills.js";
import { registerStatus } from "./status.js";
import { registerTraces } from "./traces.js";

/**
 * The single extension point for command registration. Later issues add their
 * command groups here without reshaping cli.ts.
 */
export function registerCommands(program: Command): void {
  registerLogin(program);
  registerStatus(program);
  registerTraces(program);
  registerDetectors(program);
  registerFindings(program);
  registerSkills(program);
  registerInstrument(program);
  registerDoctor(program);
}
