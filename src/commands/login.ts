import { createInterface } from "node:readline";
import type { Command } from "commander";
import { type ApiClient, type ApiClientOptions, createApiClient } from "../api/client.js";
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
  /** Prompts for a yes/no answer; resolves `false` on empty input or EOF. */
  promptConfirm: (question: string) => Promise<boolean>;
  /** Prompts for a secret without echoing it. */
  promptHidden: (question: string) => Promise<string>;
  /** Prompts for a visible value, offering `def` as the default on empty input. */
  promptVisible: (question: string, def: string) => Promise<string>;
  createClient: (opts: ApiClientOptions) => ApiClient;
  writeConfig: (config: { api_key: string; host_url: string }) => void;
  writers: Writers;
}

const MISSING_KEY =
  "an API key is required: pass --api-key, set TRACEROOT_API_KEY (or a .env file), or run interactively";

/**
 * Establishes credentials: takes the api key and host already resolved from the
 * precedence chain (flags > `--env-file` > env > config > auto `.env`) or, when
 * none resolved and interactive, prompts; validates them via `whoami`, and only
 * on success persists them with restrictive permissions. The full api token is
 * never printed; on validation failure no config is written.
 */
export async function runLogin(deps: LoginDeps): Promise<void> {
  const { writers } = deps;

  const alreadyLoggedIn = deps.apiKeySource === "config";
  const currentHost = deps.resolvedHost?.trim() || DEFAULT_HOST;

  if (alreadyLoggedIn && (!deps.isInteractive || deps.json)) {
    if (deps.json) {
      writeJson({ status: "already_logged_in", host: currentHost }, writers);
    } else {
      logInfo(`Already logged in to ${currentHost}.`, writers);
      logInfo("Pass --api-key or set TRACEROOT_API_KEY to switch accounts.", writers);
    }
    return;
  }

  const resolvedKey = deps.resolvedApiKey?.trim();
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

  const resolvedHost = deps.resolvedHost?.trim();
  let host: string;
  if (resolvedHost !== undefined && resolvedHost !== "") {
    host = resolvedHost;
  } else if (deps.isInteractive) {
    const answer = (await deps.promptVisible("Host", DEFAULT_HOST)).trim();
    host = answer === "" ? DEFAULT_HOST : answer;
  } else {
    host = DEFAULT_HOST;
  }

  const client = deps.createClient({ host, apiKey });
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
      `Logged in to ${who.host}`,
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
        promptConfirm: (question) =>
          new Promise((resolve) => {
            const rl = createInterface({
              input: process.stdin,
              output: process.stdout,
              terminal: true,
            });
            rl.question(`${question} [y/N] `, (answer) => {
              rl.close();
              resolve(answer.trim().toLowerCase() === "y");
            });
          }),
        promptHidden,
        promptVisible,
        createClient: createApiClient,
        writeConfig: realWriteConfig,
        writers: defaultWriters,
      });
    });
}
