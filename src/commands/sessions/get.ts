import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { CliError, ExitCode, type Writers, defaultWriters, writeJson } from "../../output.js";
import { createStyler } from "../../render/style.js";
import { renderTable } from "../../render/table.js";
import { formatTimestamp } from "../../util/index.js";
import { contextFromCommand, requireApiClient } from "../shared.js";
import { onceOption } from "../traces/list.js";

/** Dependencies for the testable core of `sessions get`. */
export interface RunSessionGetDeps {
  client: ApiClient;
  json: boolean;
  writers: Writers;
  sessionId: string;
  /** ISO 8601 lower bound (inclusive) on the traces shown, sent as `start_after`. */
  startAfter?: string;
  /** ISO 8601 upper bound (exclusive) on the traces shown, sent as `end_before`. */
  endBefore?: string;
  /** IANA timezone override for the human-local time display. */
  timeZone?: string;
  /** Target project (required by the server under user credentials). */
  projectId?: string;
}

/** Core, network-free logic for `sessions get`. Tests inject a fake client. */
export async function runSessionGet(deps: RunSessionGetDeps): Promise<void> {
  const { client, json, writers, sessionId } = deps;
  if (sessionId.trim() === "") {
    throw new CliError("provide a session id", ExitCode.usage);
  }
  const session = await client.getSession(sessionId, {
    startAfter: deps.startAfter,
    endBefore: deps.endBefore,
    projectId: deps.projectId,
  });

  if (json) {
    // Bare object, byte-for-byte the backend response (mirrors `traces get`).
    writeJson(session, writers);
    return;
  }

  const styler = createStyler(writers.out);
  const label = (text: string): string => styler.bold(text);
  const lines = [
    `${label("Session:")}  ${session.session_id}`,
    `${label("Traces:")}   ${session.trace_count}`,
    `${label("Users:")}    ${session.user_ids.join(", ") || "(none)"}`,
    `${label("First:")}    ${
      session.first_trace_time !== null
        ? formatTimestamp(session.first_trace_time, deps.timeZone)
        : "(unknown)"
    }`,
    `${label("Last:")}     ${
      session.last_trace_time !== null
        ? formatTimestamp(session.last_trace_time, deps.timeZone)
        : "(unknown)"
    }`,
  ];

  if (session.traces.length > 0) {
    const headers = ["STARTED", "STATUS", "NAME", "TRACE ID"];
    const rows = session.traces.map((trace) => [
      formatTimestamp(trace.trace_start_time, deps.timeZone),
      trace.status ?? "",
      trace.name ?? "",
      trace.trace_id,
    ]);
    lines.push("", renderTable(headers, rows, { headerStyle: styler.bold }));
  }

  writers.out.write(`${lines.join("\n")}\n`);
}

export function registerSessionsGet(sessions: Command): void {
  sessions
    .command("get")
    .argument("<sessionId>", "session identifier")
    .description("Get a single session with its traces")
    .option(
      "--from <timestamp>",
      "only traces at or after this time (ISO 8601)",
      onceOption("--from"),
    )
    .option(
      "--to <timestamp>",
      "only traces before this time (exclusive, ISO 8601)",
      onceOption("--to"),
    )
    .action(async (sessionId: string, _opts, command: Command) => {
      const ctx = contextFromCommand(command);
      const opts = command.opts();
      await runSessionGet({
        client: requireApiClient(ctx),
        json: ctx.json,
        writers: defaultWriters,
        sessionId,
        startAfter: opts.from as string | undefined,
        endBefore: opts.to as string | undefined,
        projectId: ctx.auth.projectId.value,
      });
    });
}
