import { readFileSync } from "node:fs";
import { type ParamSchema, REGISTRY, type RegistryEntry } from "@traceroot-ai/tools";
import type { Command } from "commander";
import { contextFromCommand } from "../commands/shared.js";
import { CliError, ExitCode, type Writers, defaultWriters } from "../output.js";
import { ENHANCERS } from "./enhancers/index.js";
import type { Enhancer, RenderContext, ResolveInput, Resolved } from "./enhancers/types.js";
import { acceptsProjectScope, executeTool, transportFromContext } from "./execute.js";
import { onceOption, rejectExtras } from "./flags.js";

export { rejectExtras } from "./flags.js";
import { GROUPS, PLACEMENTS, type Placement } from "./naming.js";
import { renderDefault } from "./render.js";

export interface RegistryDeps {
  fetchImpl?: typeof fetch;
  writers?: Writers;
  /** Test seam: override which tools surface as commands (default PLACEMENTS). */
  placements?: Record<string, Placement>;
  /** Test seam: group descriptions for injected placements (default GROUPS). */
  groups?: Record<string, string>;
}

type CommandPlacement = Extract<Placement, { kind: "command" }>;

const registryByName = new Map(REGISTRY.map((entry) => [entry.name, entry]));

export function ensureGroup(
  program: Command,
  name: string,
  groups: Record<string, string> = GROUPS,
): Command {
  const existing = program.commands.find((cmd) => cmd.name() === name);
  if (existing !== undefined) return existing;
  const description = groups[name];
  if (description === undefined) throw new Error(`no group description for '${name}'`);
  return program.command(name).description(description).helpCommand(false);
}

export function registerRegistryCommands(program: Command, deps: RegistryDeps = {}): void {
  for (const [tool, placement] of Object.entries(deps.placements ?? PLACEMENTS)) {
    if (placement.kind !== "command") continue;
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
  const parent =
    placement.path.length === 2 ? ensureGroup(program, placement.path[0], deps.groups) : program;
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

  // Write commands accept their whole body as one JSON document. Added by the
  // factory (not addSchemaFlags) so it exists even when an enhancer owns flags.
  if (entry.method !== "get") {
    cmd.option(
      "--from-file <path>",
      "read body params from a JSON file ('-' reads stdin); individual flags override its fields",
      onceOption("--from-file"),
    );
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

    // Applied in the shared action path (not inside defaultResolveArgs) so
    // --from-file works the same regardless of which resolver ran — an
    // enhancer's resolveArgs has no reason to know about the flag. File
    // first: whatever the resolver already put in resolved.args (flags,
    // positionals, or an enhancer's own logic) overrides the file's fields.
    const fromFileOpt = input.opts.fromFile;
    const fromFile = typeof fromFileOpt === "string" ? readBodyFile(fromFileOpt) : undefined;

    const ctx = contextFromCommand(command);
    const transport = transportFromContext(ctx, deps);
    const target =
      resolved.tool === undefined ? entry : requireCompanion(entry.name, resolved.tool);
    if (fromFile !== undefined) {
      // A stray key here is a typo in the user's JSON, not the enhancer bug
      // assertKnownArgs guards against — it must fail as a usage error (exit
      // 2), never assertKnownArgs' internal error (exit 1).
      assertKnownBodyFields(target, fromFile);
    }
    const args = fromFile === undefined ? resolved.args : { ...fromFile, ...resolved.args };
    assertKnownArgs(target, args);
    assertPathParamsPresent(target, args);
    assertRequiredArgs(target, args, transport);
    assertEnums(target, args);
    const payload = await executeTool(target, args, transport);

    const writers = deps.writers ?? defaultWriters;
    const renderCtx: RenderContext = {
      json: ctx.json,
      writers,
      args,
      state: resolved.state,
      dispatchTool: (companionName, companionArgs) => {
        const companion = requireCompanion(entry.name, companionName);
        assertKnownArgs(companion, companionArgs);
        assertPathParamsPresent(companion, companionArgs);
        return executeTool(companion, companionArgs, transport);
      },
      dispatchToolOptional: (companionName, companionArgs) => {
        // Validation throws SYNCHRONOUSLY — before any promise exists — so a
        // programming bug (bad companion name, schema-unknown arg, blank path
        // param) escapes even when the caller chains `.catch(...)`. Only the
        // API call itself is best-effort: any dispatch failure degrades to null.
        const companion = requireCompanion(entry.name, companionName);
        assertKnownArgs(companion, companionArgs);
        assertPathParamsPresent(companion, companionArgs);
        return executeTool(companion, companionArgs, transport).catch(() => null);
      },
    };
    if (enhancer?.render !== undefined) {
      await enhancer.render(payload, renderCtx);
    } else {
      renderDefault(payload, { json: ctx.json, writers, args });
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
  if (schema.format === "date-time" && Number.isNaN(Date.parse(raw))) {
    // Light client-side check so an unparseable timestamp is a usage error
    // (exit 2) instead of a server 400 surfaced as internal. The server stays
    // authoritative on the exact accepted forms.
    throw new CliError(
      `${flag} must be an ISO 8601 timestamp, e.g. 2026-06-01T13:00:00Z`,
      ExitCode.usage,
    );
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
    // Object.hasOwn, not `in`: inherited keys like "toString" must not pass.
    if (!Object.hasOwn(entry.inputSchema.properties, key)) {
      throw new Error(
        `internal: resolveArgs for '${entry.name}' produced arg '${key}' not in the tool's input schema — the dispatcher would silently drop it`,
      );
    }
  }
}

/**
 * The registry dispatcher's `fillPath` throws a plain, pre-fetch Error for a
 * missing/empty path-param value, which `translate()` in execute.ts would
 * otherwise bucket as a retryable network failure (and leak the raw path
 * template in the message) — a blank identifier is a usage error, not a
 * network one. Catches it here, before dispatch, for every path this command
 * can take: the default/enhancer-resolved args, a `resolved.tool` retarget,
 * and a companion dispatched from `render`. `fillPath` itself only rejects an
 * exact `""`; this also rejects whitespace-only values, since those are just
 * as meaningless a path segment. The message mirrors commander's own `missing
 * required argument '<name>'` so an omitted positional (caught by commander)
 * and a blank one (caught here) read the same way.
 */
export function assertPathParamsPresent(entry: RegistryEntry, args: Record<string, unknown>): void {
  const placeholders = [...entry.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] as string);
  for (const name of placeholders) {
    const value = args[name];
    const blank =
      value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    if (blank) {
      throw new CliError(`missing required argument '${kebab(name)}'`, ExitCode.usage);
    }
  }
}

/**
 * Enforces the tool's `inputSchema.required` before dispatch. The factory
 * previously checked only path params, which was enough for reads; a write
 * carries most of its contract in the body, and a missing field would
 * otherwise surface as a server rejection instead of a usage error.
 *
 * `transport` is optional and, when given, lets a project-tenancy write's
 * required `project_id` be satisfied by the injection `withProjectScope`
 * (execute.ts) performs before dispatch — without it, a user with a
 * configured default project would be told to pass a flag the CLI already
 * knows the value of. `acceptsProjectScope` is the same predicate the
 * injection itself is gated on, so the two can never disagree.
 *
 * Treats `null` the same as `undefined`: an explicit null in a --from-file
 * document is exactly the kind of "missing" this validator exists to catch
 * before it becomes a server rejection.
 */
export function assertRequiredArgs(
  entry: RegistryEntry,
  args: Record<string, unknown>,
  transport?: { projectId?: string },
): void {
  const missing = entry.inputSchema.required.filter((name) => {
    const value = args[name];
    if (value !== undefined && value !== null) return false;
    if (name === "project_id" && transport?.projectId !== undefined && acceptsProjectScope(entry)) {
      return false;
    }
    return true;
  });
  if (missing.length > 0) {
    throw new CliError(
      `missing required ${missing.length === 1 ? "field" : "fields"}: ${missing
        .map((name) => `--${kebab(name)}`)
        .join(", ")}`,
      ExitCode.usage,
    );
  }
}

/**
 * Enforces schema `enum` constraints on the merged args. `coerce` handles
 * types, formats and numeric bounds for flag values but never enums, and a
 * value supplied through `--from-file` bypasses `coerce` entirely — so this
 * runs over the final args, whatever their source.
 */
export function assertEnums(entry: RegistryEntry, args: Record<string, unknown>): void {
  for (const [prop, schema] of Object.entries(entry.inputSchema.properties)) {
    const allowed = schema.enum;
    if (!Array.isArray(allowed)) continue;
    const value = args[prop];
    if (value === undefined) continue;
    if (!allowed.includes(value)) {
      throw new CliError(`--${kebab(prop)} must be one of: ${allowed.join(", ")}`, ExitCode.usage);
    }
  }
}

/**
 * Reads a write command's body params from a JSON file, or from stdin when the
 * path is `-`. Nested params (an alert's `renotify` object and `filters` array,
 * a widget's `spec`) are impractical as shell-quoted flags, so the whole body
 * travels as one document; individual flags still override single fields.
 */
export function readBodyFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  } catch {
    // Never interpolate the fs error: it adds errno noise without telling the
    // user anything actionable beyond the path they typed.
    throw new CliError(`--from-file could not read ${path}`, ExitCode.usage);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("--from-file must contain valid JSON", ExitCode.usage);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("--from-file must contain a JSON object of body params", ExitCode.usage);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Validates that a --from-file document names only fields the target tool's
 * schema knows about. Deliberately separate from `assertKnownArgs`: a stray
 * key here is a typo in user-authored JSON — a usage error (exit 2) — not the
 * enhancer bug `assertKnownArgs` guards against, which is an internal error
 * (exit 1). Interpolates only the key names, never their values.
 */
function assertKnownBodyFields(entry: RegistryEntry, body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter(
    (key) => !Object.hasOwn(entry.inputSchema.properties, key),
  );
  if (unknown.length > 0) {
    throw new CliError(
      `--from-file: unknown ${unknown.length === 1 ? "field" : "fields"}: ${unknown
        .map((name) => kebab(name))
        .join(", ")}`,
      ExitCode.usage,
    );
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
