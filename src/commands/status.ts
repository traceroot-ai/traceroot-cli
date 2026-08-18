import { join } from "node:path";
import type { Command } from "commander";
import type { ApiClient, WorkspaceList } from "../api/client.js";
import { credentialsPath } from "../auth/credentials.js";
import { decodeJwtClaims } from "../auth/token.js";
import { configPath } from "../config/manager.js";
import type { AuthSource } from "../config/resolve.js";
import type { Context } from "../context.js";
import { type Writers, defaultWriters, writeJson } from "../output.js";
import { apiKeyLabel, identity } from "../render/identity.js";
import { createStyler } from "../render/style.js";
import { contextFromCommand, requireAuthedClient } from "./shared.js";

/**
 * Human-readable description of where the credentials were resolved from — and,
 * for file-based sources, the path of that file (so `Config source` answers
 * "where is my config?").
 */
function describeSource(source: AuthSource): string {
  switch (source) {
    case "config":
      return configPath();
    case "credentials-file":
      return credentialsPath();
    case "auto-env-file":
      return `${join(process.cwd(), ".env")} (auto-loaded)`;
    case "env-file":
      return "--env-file";
    case "env":
      return "environment (TRACEROOT_API_KEY / TRACEROOT_TOKEN / TRACEROOT_HOST_URL)";
    case "flag":
      return "--api-key / --host flags";
    case "default":
      return "built-in default";
    default:
      return "(none)";
  }
}

/** Dependencies for {@link runStatus}; production wiring lives in {@link registerStatus}. */
export interface StatusDeps {
  ctx: Context;
  client: ApiClient;
  writers: Writers;
  /**
   * Session mode only: mints (or returns the cached) access JWT. Identity comes
   * from its `email` claim — `whoami` is API-key-only server-side and would 401
   * for a user credential.
   */
  getAccessToken?: () => Promise<string>;
}

/**
 * Shows the authenticated identity for the resolved credential. API-key mode
 * asks `whoami`; session mode derives identity from the access JWT plus
 * `list_workspaces` (no whoami — that endpoint rejects user credentials). In
 * `--json` mode writes exactly one JSON document to stdout. No secret is ever
 * printed. A failure propagates as a thrown error (nothing on stdout).
 */
export async function runStatus(deps: StatusDeps): Promise<void> {
  if (deps.ctx.auth.credential.kind === "session") {
    await sessionStatus(deps);
    return;
  }
  await apiKeyStatus(deps);
}

async function apiKeyStatus(deps: StatusDeps): Promise<void> {
  const { ctx, client, writers } = deps;
  const who = await client.whoami();
  const configSource = ctx.auth.credential.source;

  if (ctx.json) {
    writeJson(
      {
        credential: "api-key",
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

async function sessionStatus(deps: StatusDeps): Promise<void> {
  const { ctx, client, writers } = deps;
  if (deps.getAccessToken === undefined) {
    throw new Error("session status requires a token provider");
  }
  // A mint failure (revoked/expired session) propagates: status must say
  // re-login is needed rather than pretend a dead session is fine.
  const jwt = await deps.getAccessToken();
  const claims = decodeJwtClaims(jwt);
  const email = typeof claims?.email === "string" ? claims.email : undefined;

  // Workspace membership is informational; a read failure must not hide the
  // identity we already verified via mint.
  let workspaces: WorkspaceList | null = null;
  try {
    workspaces = await client.listWorkspaces();
  } catch {
    workspaces = null;
  }

  const host = ctx.auth.hostUrl.value;
  const authHost = ctx.auth.authHost.value;
  const projectId = ctx.auth.projectId;
  const credentialSource = ctx.auth.credential.source;

  if (ctx.json) {
    writeJson(
      {
        credential: "session",
        email: email ?? null,
        host,
        auth_host: authHost,
        project_id: projectId.value ?? null,
        project_source: projectId.value !== undefined ? projectId.source : null,
        workspaces: workspaces?.data ?? null,
        config_source: credentialSource,
        config_path: credentialsPath(),
      },
      writers,
    );
    return;
  }

  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);

  const lines = [
    `${label("Logged in as:")}  ${email ?? "(unknown)"}`,
    `${label("Credential:")}    session (browser login)`,
    `${label("Host:")}          ${host ?? "(unset)"}`,
  ];
  if (authHost !== undefined && authHost !== host) {
    lines.push(`${label("Auth host:")}     ${authHost}`);
  }
  lines.push(
    `${label("Project:")}       ${
      projectId.value !== undefined
        ? `${projectId.value} ${styler.dim(`(${describeSource(projectId.source)})`)}`
        : "(none — pass --project or run `traceroot projects list`)"
    }`,
  );
  lines.push(
    `${label("Workspaces:")}    ${
      workspaces === null
        ? "(unavailable)"
        : workspaces.data.length === 0
          ? "(none)"
          : workspaces.data.map((w) => identity(w.name, w.id, styler)).join(", ")
    }`,
  );
  lines.push(`${label("Config source:")} ${describeSource(credentialSource)}`);
  writers.out.write(`${lines.join("\n")}\n`);
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show authentication status")
    .action(async (_opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const authed = requireAuthedClient(ctx);
      await runStatus({
        ctx,
        client: authed.client,
        writers: defaultWriters,
        getAccessToken: authed.getAccessToken,
      });
    });
}
