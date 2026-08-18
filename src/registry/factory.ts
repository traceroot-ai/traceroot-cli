import { type ParamSchema, REGISTRY, type RegistryEntry } from "@traceroot-ai/tools";
import type { Command } from "commander";
import { contextFromCommand } from "../commands/shared.js";
import { CliError, ExitCode, type Writers, defaultWriters } from "../output.js";
import { ENHANCERS } from "./enhancers/index.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./enhancers/types.js";
import { executeTool, transportFromContext } from "./execute.js";
import { onceOption, rejectExtras } from "./flags.js";

export { rejectExtras } from "./flags.js";
import { GROUPS, PLACEMENTS, type Placement } from "./naming.js";
import { renderDefault } from "./render.js";

export interface RegistryDeps {
  fetchImpl?: typeof fetch;
  writers?: Writers;
}

type CommandPlacement = Extract<Placement, { kind: "command" }>;

/** Tools the factory registers today. Grows one migration task at a time as the
 * hand-written commands move onto the generated path; removed at the end of #65
 * so the factory registers every command placement. */
const GENERATED = new Set(["list_sessions", "get_session", "list_trace_filter_values"]);

const registryByName = new Map(REGISTRY.map((entry) => [entry.name, entry]));

export function ensureGroup(program: Command, name: string): Command {
  const existing = program.commands.find((cmd) => cmd.name() === name);
  if (existing !== undefined) return existing;
  const description = GROUPS[name];
  if (description === undefined) throw new Error(`no group description for '${name}'`);
  return program.command(name).description(description).helpCommand(false);
}

export function registerRegistryCommands(program: Command, deps: RegistryDeps = {}): void {
  for (const [tool, placement] of Object.entries(PLACEMENTS)) {
    if (placement.kind !== "command" || !GENERATED.has(tool)) continue;
    const entry = registryByName.get(tool);
    if (entry === undefined) continue; // parity + naming tests report this properly
    registerOne(program, entry, placement, deps);
  }
}

function kebab(name: string): string {
  return name.replaceAll("_", "-");
}

/** The tool's positional arguments ARE its path parameters, in template order. */
function pathParams(entry: RegistryEntry): string[] {
  return [...entry.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] as string);
}

/** Commander camel-cases `--start-after` to opts.startAfter; mirror it. */
function optKey(prop: string): string {
  return prop.replace(/_([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
}

function registerOne(
  program: Command,
  entry: RegistryEntry,
  placement: CommandPlacement,
  deps: RegistryDeps,
): void {
  const parent = placement.path.length === 2 ? ensureGroup(program, placement.path[0]) : program;
  const name = placement.path[placement.path.length - 1] as string;
  const enhancer: Enhancer | undefined = ENHANCERS[entry.name];
  const positionals = pathParams(entry);
  // Own the stray-operand contract ourselves (defaultResolveArgs / an
  // enhancer's resolveArgs via rejectExtras): commander 13 defaults
  // excessArguments to reject, which would preempt our message.
  const cmd = parent
    .command(name)
    .description(enhancer?.description ?? entry.description)
    .allowExcessArguments();

  if (enhancer?.arguments !== undefined) {
    enhancer.arguments(cmd);
    if (cmd.registeredArguments.length !== positionals.length) {
      throw new Error(
        `enhancer for '${entry.name}' declares ${cmd.registeredArguments.length} argument(s) but the tool's path template has ${positionals.length} parameter(s) — they must match 1:1`,
      );
    }
  } else {
    for (const prop of positionals) {
      const schema = entry.inputSchema.properties[prop];
      const help =
        typeof schema?.description === "string" && schema.description !== ""
          ? schema.description
          : kebab(prop).replaceAll("-", " ");
      cmd.argument(`<${kebab(prop)}>`, help);
    }
  }

  if (enhancer?.flags !== undefined) {
    enhancer.flags(cmd);
  } else {
    addSchemaFlags(cmd, entry, new Set(positionals));
  }

  cmd.action(async (...actionArgs: unknown[]) => {
    const command = actionArgs[actionArgs.length - 1] as Command;
    const declared = command.registeredArguments.length;
    const values = command.processedArgs.slice(0, declared) as (string | undefined)[];
    const positionalRecord: Record<string, string | undefined> = {};
    positionals.forEach((prop, index) => {
      positionalRecord[prop] = values[index];
    });
    const input: ResolveInput = {
      opts: command.opts(),
      positionals: positionalRecord,
      extras: command.args.slice(declared),
    };
    const resolved =
      enhancer?.resolveArgs !== undefined
        ? enhancer.resolveArgs(input)
        : defaultResolveArgs(entry, input, positionals);

    const ctx = contextFromCommand(command);
    const transport = transportFromContext(ctx, deps);
    const target =
      resolved.tool === undefined ? entry : requireCompanion(entry.name, resolved.tool);
    assertKnownArgs(target, resolved.args);
    const payload = await executeTool(target, resolved.args, transport);

    const writers = deps.writers ?? defaultWriters;
    const renderCtx: RenderContext = {
      json: ctx.json,
      writers,
      args: resolved.args,
      state: resolved.state,
      dispatchTool: (companionName, companionArgs) => {
        const companion = requireCompanion(entry.name, companionName);
        assertKnownArgs(companion, companionArgs);
        return executeTool(companion, companionArgs, transport);
      },
      dispatchToolOptional: (companionName, companionArgs) => {
        // Validation throws SYNCHRONOUSLY — before any promise exists — so a
        // programming bug (bad companion name, schema-unknown arg) escapes even
        // when the caller chains `.catch(...)`. Only the API call itself is
        // best-effort: any dispatch failure degrades to null.
        const companion = requireCompanion(entry.name, companionName);
        assertKnownArgs(companion, companionArgs);
        return executeTool(companion, companionArgs, transport).catch(() => null);
      },
    };
    if (enhancer?.render !== undefined) {
      await enhancer.render(payload, renderCtx);
    } else {
      renderDefault(payload, { json: ctx.json, writers, args: resolved.args });
    }
  });
}

function addSchemaFlags(cmd: Command, entry: RegistryEntry, positionals: Set<string>): void {
  for (const [prop, schema] of Object.entries(entry.inputSchema.properties)) {
    if (positionals.has(prop)) continue;
    const flag = `--${kebab(prop)}`;
    const description = typeof schema.description === "string" ? schema.description : "";
    if (schema.type === "boolean") {
      cmd.option(flag, description);
    } else {
      // Never .default(...) here — onceOption would falsely reject the first use.
      cmd.option(`${flag} <value>`, description, onceOption(flag));
    }
  }
}

function defaultResolveArgs(
  entry: RegistryEntry,
  input: ResolveInput,
  positionals: string[],
): Resolved {
  rejectExtras(input);
  const args: Record<string, unknown> = {};
  for (const prop of positionals) {
    const value = input.positionals[prop];
    if (value !== undefined) args[prop] = value;
  }
  for (const [prop, schema] of Object.entries(entry.inputSchema.properties)) {
    if (prop in args) continue;
    const raw = input.opts[optKey(prop)];
    if (raw === undefined) continue;
    args[prop] = coerce(prop, schema, raw);
  }
  return { args };
}

function coerce(prop: string, schema: ParamSchema, raw: unknown): unknown {
  const flag = `--${kebab(prop)}`;
  if (schema.type === "boolean") return raw === true;
  if (typeof raw !== "string") return raw;
  if (schema.type === "integer") {
    if (!/^-?\d+$/.test(raw)) throw new CliError(`${flag} must be an integer`, ExitCode.usage);
    return checkRange(flag, Number.parseInt(raw, 10), schema);
  }
  if (schema.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new CliError(`${flag} must be a number`, ExitCode.usage);
    return checkRange(flag, value, schema);
  }
  if (schema.type === "array" || schema.type === "object") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new CliError(`${flag} must be valid JSON`, ExitCode.usage);
    }
  }
  return raw;
}

/**
 * Enforces the schema's numeric bounds client-side so a generated command's
 * out-of-range value is a usage error (exit 2) with a clear message, not a
 * server 422 surfaced as an internal failure.
 */
function checkRange(flag: string, value: number, schema: ParamSchema): number {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    throw new CliError(`${flag} must be at least ${schema.minimum}`, ExitCode.usage);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    throw new CliError(`${flag} must be at most ${schema.maximum}`, ExitCode.usage);
  }
  return value;
}

/**
 * The registry dispatcher silently drops args it doesn't know; for a CLI a
 * silent no-op flag is a support ticket. Every resolved args object — default
 * path, enhancer path, and companion dispatches — must contain only keys the
 * target tool's input schema declares, or we fail loudly (an enhancer bug,
 * never a user error).
 */
export function assertKnownArgs(entry: RegistryEntry, args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (!(key in entry.inputSchema.properties)) {
      throw new Error(
        `internal: resolveArgs for '${entry.name}' produced arg '${key}' not in the tool's input schema — the dispatcher would silently drop it`,
      );
    }
  }
}

export function requireCompanion(owner: string, companion: string): RegistryEntry {
  const placement = PLACEMENTS[companion];
  if (placement?.kind !== "companion" || !placement.of.includes(owner)) {
    throw new Error(
      `tool '${companion}' is not a companion of '${owner}' in src/registry/naming.ts`,
    );
  }
  const entry = registryByName.get(companion);
  if (entry === undefined) throw new Error(`companion tool '${companion}' missing from REGISTRY`);
  return entry;
}
