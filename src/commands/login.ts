import { createInterface } from "node:readline";
import type { Command } from "commander";
import {
  type ApiClient,
  type ApiClientOptions,
  type Whoami,
  createApiClient,
} from "../api/client.js";
import { writeConfig as realWriteConfig } from "../config/manager.js";
import type { AuthSource } from "../config/resolve.js";
import { CliError, type Writers, defaultWriters, logInfo, writeJson } from "../output.js";
import { apiKeyLabel, identity } from "../render/identity.js";
import { createStyler } from "../render/style.js";
import { DEFAULT_HOST } from "./constants.js";
import { contextFromCommand } from "./shared.js";

/** Dependencies for {@link runLogin}; production wiring lives in {@link registerLogin}. */
export interface LoginDeps {
  /**
   * The api key resolved from the full precedence chain (flags > `--env-file` >
   * env > config > auto-discovered `.env`), if any. When absent, login prompts
   * (interactive) or errors (non-interactive).
   */
  resolvedApiKey?: string;
  /** The host resolved from the same precedence chain, if any. */
  resolvedHost?: string;
  json: boolean;
  isInteractive: boolean;
  /** Provenance of the resolved api key; `"config"` means the user is already
   * logged in via the persisted config file (a bare `login` re-invocation). */
  apiKeySource: AuthSource;
  /** Provenance of the resolved host. An explicit override (`flag`/`env`/
   * `env-file`) signals intent to change the host and bypasses the
   * already-logged-in warning even when the key still comes from config. */
  hostSource: AuthSource;
  /** Prompts for a yes/no answer; resolves `false` on empty input or EOF. */
  promptConfirm: (question: string) => Promise<boolean>;
  /** Prompts for a secret without echoing it. */
  promptHidden: (question: string) => Promise<string>;
  /** Prompts for a visible value, offering `def` as the default on empty input. */
  promptVisible: (question: string, def: string) => Promise<string>;
  createClient: (opts: ApiClientOptions) => ApiClient;
  writeConfig: (config: { api_key: string; host_url: string }) => void;
  /** Per-request network timeout (ms) so credential validation can't hang. */
  timeoutMs?: number;
  writers: Writers;
}

const MISSING_KEY =
  "an API key is required: pass --api-key, set TRACEROOT_API_KEY (or a .env file), or run interactively";

/**
 * Timeout for the courtesy `whoami` that enriches the already-logged-in
 * warning. It is only informational, so a slow/unreachable host degrades to the
 * host-only fallback quickly rather than hanging the command.
 */
export const WHOAMI_WARNING_TIMEOUT_MS = 5000;

/**
 * Establishes credentials: takes the api key and host already resolved from the
 * precedence chain (flags > `--env-file` > env > config > auto `.env`) or, when
 * none resolved and interactive, prompts; validates them via `whoami`, and only
 * on success persists them with restrictive permissions. The full api token is
 * never printed; on validation failure no config is written.
 */
export async function runLogin(deps: LoginDeps): Promise<void> {
  const { writers } = deps;

  // An explicit override of either field (a higher-precedence flag/env/env-file)
  // is deliberate intent, not a bare re-invocation. Since `apiKeySource ===
  // "config"` (or `"global-config"`, the read-only global fallback) already
  // implies the key was not explicitly overridden, only the host needs a
  // separate override check (e.g. `login --host ...`).
  const hostOverridden =
    deps.hostSource === "flag" || deps.hostSource === "env" || deps.hostSource === "env-file";
  const alreadyLoggedIn =
    (deps.apiKeySource === "config" || deps.apiKeySource === "global-config") && !hostOverridden;
  const currentHost = deps.resolvedHost?.trim() || DEFAULT_HOST;

  let resolvedKey = deps.resolvedApiKey?.trim();
  let resolvedHost = deps.resolvedHost?.trim();

  if (alreadyLoggedIn) {
    const outcome = await reportAlreadyLoggedIn(deps, currentHost, resolvedKey ?? "");
    if (outcome === "exit") {
      return;
    }
    // User opted to switch: ignore persisted creds and prompt fresh below.
    resolvedKey = undefined;
    resolvedHost = undefined;
  }

  let apiKey: string;
  if (resolvedKey !== undefined && resolvedKey !== "") {
    apiKey = resolvedKey;
  } else if (deps.isInteractive) {
    apiKey = (await deps.promptHidden("API key: ")).trim();
  } else {
    throw new CliError(MISSING_KEY);
  }
  if (apiKey === "") {
    throw new CliError(MISSING_KEY);
  }

  let host: string;
  if (resolvedHost !== undefined && resolvedHost !== "") {
    host = resolvedHost;
  } else if (deps.isInteractive) {
    const answer = (await deps.promptVisible("Host", DEFAULT_HOST)).trim();
    host = answer === "" ? DEFAULT_HOST : answer;
  } else {
    host = DEFAULT_HOST;
  }

  const client = deps.createClient({ host, apiKey, timeoutMs: deps.timeoutMs });
  // Validate before persisting; a failure throws and leaves config untouched.
  const who = await client.whoami();

  deps.writeConfig({ api_key: apiKey, host_url: host });

  if (deps.json) {
    writeJson(
      {
        project_id: who.project_id,
        project_name: who.project_name,
        workspace_id: who.workspace_id,
        workspace_name: who.workspace_name,
        key_name: who.key_name,
        key_hint: who.key_hint,
        host: who.host,
        ui_base_url: who.ui_base_url,
      },
      writers,
    );
  } else {
    const styler = createStyler(writers.out);
    const lines = [
      `Logged in to ${styler.dim(who.host)}`,
      `  ${styler.bold("Workspace:")} ${identity(who.workspace_name, who.workspace_id, styler)}`,
      `  ${styler.bold("Project:")}   ${identity(who.project_name, who.project_id, styler)}`,
      `  ${styler.bold("API key:")}   ${apiKeyLabel(who.key_name, who.key_hint, styler)}`,
    ];
    writers.out.write(`${lines.join("\n")}\n`);
  }

  logInfo("\nNext: run `traceroot status` to confirm your identity.", writers);
  logInfo("Next: run `traceroot traces list` to see your traces.", writers);
}

/**
 * Handles a bare `login` while already logged in: warns which workspace/project
 * the saved session belongs to and, interactively, asks whether to re-login.
 *
 * To name the session it calls `whoami` with the saved key; the full token is
 * never printed. If that lookup fails (expired key, offline) it degrades to a
 * host-only warning that notes the session couldn't be verified — the warning
 * never throws. Returns `"relogin"` only when an interactive user opts to switch
 * accounts; every other path (no TTY, `--json`, or a declined prompt) returns
 * `"exit"`, leaving the existing config untouched.
 */
async function reportAlreadyLoggedIn(
  deps: LoginDeps,
  currentHost: string,
  savedKey: string,
): Promise<"exit" | "relogin"> {
  const { writers } = deps;
  const styler = createStyler(writers.err);

  let who: Whoami | null = null;
  try {
    const client = deps.createClient({
      host: currentHost,
      apiKey: savedKey,
      timeoutMs: WHOAMI_WARNING_TIMEOUT_MS,
    });
    who = await client.whoami();
  } catch {
    who = null;
  }

  if (deps.json) {
    writeJson(
      who !== null
        ? {
            status: "already_logged_in",
            verified: true,
            host: who.host,
            workspace_id: who.workspace_id,
            workspace_name: who.workspace_name,
            project_id: who.project_id,
            project_name: who.project_name,
          }
        : { status: "already_logged_in", verified: false, host: currentHost },
      writers,
    );
    return "exit";
  }

  if (who !== null) {
    const lines = [
      `${styler.warn("WARNING:")} Already logged in:`,
      `  ${styler.bold("Workspace:")} ${identity(who.workspace_name, who.workspace_id, styler)}`,
      `  ${styler.bold("Project:")}   ${identity(who.project_name, who.project_id, styler)}`,
      `  ${styler.bold("Host:")}      ${styler.dim(who.host)}`,
    ];
    logInfo(lines.join("\n"), writers);
  } else {
    logInfo(`${styler.warn("WARNING:")} Already logged in to ${styler.dim(currentHost)}`, writers);
    logInfo("  (couldn't verify the saved session).", writers);
  }

  if (!deps.isInteractive) {
    logInfo("Pass --api-key or set TRACEROOT_API_KEY to switch accounts.", writers);
    return "exit";
  }

  const proceed = await deps.promptConfirm("Re-login with a different account? (y/N): ");
  if (!proceed) {
    logInfo("Keeping current session.", writers);
    return "exit";
  }
  return "relogin";
}

/**
 * Reads a line from stdin without echoing the typed characters (a `*` is shown
 * per keystroke). Used only on the real interactive path.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const asMutable = rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = asMutable._writeToOutput?.bind(rl);
    asMutable._writeToOutput = (chunk: string): void => {
      // Echo the prompt itself, mask everything else.
      if (chunk.includes(question)) {
        original?.(chunk);
      } else {
        process.stdout.write("*");
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

/** Reads a visible line from stdin, returning `def` on empty input. */
function promptVisible(question: string, def: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(`${question} [${def}]: `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Reads a visible yes/no answer; returns `true` only for an explicit y/yes. */
function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "y" || normalized === "yes");
    });
  });
}

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Authenticate with TraceRoot")
    .action(async (_opts, command: Command) => {
      // Reuse the standard resolution chain so `login` honors flags, --env-file,
      // env vars, an existing config, and a working-directory .env identically
      // to the read commands.
      const ctx = contextFromCommand(command);
      await runLogin({
        resolvedApiKey: ctx.auth.apiKey.value,
        resolvedHost: ctx.auth.hostUrl.value,
        json: ctx.json,
        isInteractive: process.stdin.isTTY === true,
        apiKeySource: ctx.auth.apiKey.source,
        hostSource: ctx.auth.hostUrl.source,
        promptConfirm,
        promptHidden,
        promptVisible,
        createClient: createApiClient,
        writeConfig: realWriteConfig,
        timeoutMs: ctx.timeoutMs,
        writers: defaultWriters,
      });
    });
}
