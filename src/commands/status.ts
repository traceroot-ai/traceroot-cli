import { join } from "node:path";
import type { Command } from "commander";
import type { ApiClient } from "../api/client.js";
import { configPath } from "../config/manager.js";
import type { AuthSource } from "../config/resolve.js";
import type { Context } from "../context.js";
import { type Writers, defaultWriters, writeJson } from "../output.js";
import { apiKeyLabel, identity } from "../render/identity.js";
import { createStyler } from "../render/style.js";
import { contextFromCommand, requireApiClient } from "./shared.js";

/**
 * Human-readable description of where the credentials were resolved from — and,
 * for file-based sources, the path of that file (so `Config source` answers
 * "where is my config?").
 */
function describeSource(source: AuthSource): string {
  switch (source) {
    case "config":
      return configPath();
    case "auto-env-file":
      return `${join(process.cwd(), ".env")} (auto-loaded)`;
    case "env-file":
      return "--env-file";
    case "env":
      return "environment (TRACEROOT_API_KEY / TRACEROOT_HOST_URL)";
    case "flag":
      return "--api-key / --host flags";
    default:
      return "(none)";
  }
}

/** Dependencies for {@link runStatus}; production wiring lives in {@link registerStatus}. */
export interface StatusDeps {
  ctx: Context;
  client: ApiClient;
  writers: Writers;
}

/**
 * Shows the authenticated identity for the resolved credentials. In `--json`
 * mode writes exactly one JSON document to stdout; otherwise writes a readable
 * block. The full api token is never printed (only the backend `key_hint`).
 * A whoami failure propagates as a thrown error (nothing on stdout).
 */
export async function runStatus(deps: StatusDeps): Promise<void> {
  const { ctx, client, writers } = deps;
  const who = await client.whoami();
  const configSource = ctx.auth.apiKey.source;

  if (ctx.json) {
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
        config_source: configSource,
        config_path: configPath(),
      },
      writers,
    );
    return;
  }

  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);

  const lines = [
    `${label("Workspace:")}     ${identity(who.workspace_name, who.workspace_id, styler)}`,
    `${label("Project:")}       ${identity(who.project_name, who.project_id, styler)}`,
    `${label("API key:")}       ${apiKeyLabel(who.key_name, who.key_hint, styler)}`,
    `${label("Host:")}          ${who.host}`,
    `${label("UI base URL:")}   ${who.ui_base_url}`,
    `${label("Config source:")} ${describeSource(configSource)}`,
  ];
  writers.out.write(`${lines.join("\n")}\n`);
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show authentication status")
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      await runStatus({ ctx, client: requireApiClient(ctx), writers: defaultWriters });
    });
}
