import type { Command } from "commander";
import { type RegistryDeps, ensureGroup, registerRegistryCommands } from "../registry/factory.js";
import { GROUPS } from "../registry/naming.js";
import { registerDoctor } from "./doctor.js";
import { registerInstrument } from "./instrument.js";
import { registerLogin } from "./login.js";
import { registerSkills } from "./skills.js";
import { registerStatus } from "./status.js";

/**
 * The single extension point for command registration. Later issues add their
 * command groups here without reshaping cli.ts.
 */
export function registerCommands(program: Command, deps: RegistryDeps = {}): void {
  registerLogin(program);
  registerStatus(program);
  // Pre-create every command group (in GROUPS order) so `--help` lists groups
  // in a fixed order, regardless of which register* below attaches subcommands
  // to a group first.
  for (const group of Object.keys(GROUPS)) ensureGroup(program, group);
  registerRegistryCommands(program, deps);
  registerSkills(program);
  registerInstrument(program);
  registerDoctor(program);
}
