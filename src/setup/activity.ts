/**
 * Turns a coding agent's streamed output into a short activity feed.
 *
 * The agent runs captured rather than owning the terminal, and the wizard
 * renders a digest of what it is doing — one line per tool call, a spinner,
 * and elapsed time:
 *
 *     Running Claude Code to instrument your application
 *     Starting agent...
 *     run: ls -la "/path/to/repo"
 *     read: barebone.py
 *     write: test.py
 *
 * That is a better answer than either extreme. Handing over the terminal means
 * the wizard's own UI vanishes for the longest step of the run; hiding the
 * agent entirely behind a spinner means an LLM edits a repository with nothing
 * to show for it. A feed keeps the shape of the wizard while still saying, in
 * one line each, exactly which files are being read and written.
 */

/** One thing the agent did. */
export interface ActivityLine {
  verb: "run" | "read" | "write" | "fetch";
  detail: string;
}

/** Longest a rendered detail may be before it is cut. */
const MAX_DETAIL = 96;

function truncate(text: string): string {
  // Third-party text rendered into a framed, spinner-driven region: `\s` does not
  // match ESC, BEL or DEL, so an escape sequence here rewrites the wizard's own
  // output — and the truncation below can cut one in half.
  const flat = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the intent.
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return flat.length <= MAX_DETAIL ? flat : `${flat.slice(0, MAX_DETAIL - 3)}...`;
}

/**
 * Maps a tool name and its input to a line.
 *
 * Returns null for tools with nothing worth showing — a feed that narrates
 * every internal step is as unreadable as no feed at all.
 */
function describe(name: string, input: Record<string, unknown>): ActivityLine | null {
  const str = (key: string): string | null => {
    const value = input[key];
    return typeof value === "string" && value !== "" ? value : null;
  };

  switch (name) {
    case "Bash": {
      const command = str("command");
      return command === null ? null : { verb: "run", detail: truncate(command) };
    }
    case "Read":
    case "NotebookRead": {
      const path = str("file_path") ?? str("notebook_path");
      return path === null ? null : { verb: "read", detail: truncate(path) };
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = str("file_path") ?? str("notebook_path");
      return path === null ? null : { verb: "write", detail: truncate(path) };
    }
    case "WebFetch": {
      const url = str("url");
      return url === null ? null : { verb: "fetch", detail: truncate(url) };
    }
    case "Glob":
    case "Grep": {
      const pattern = str("pattern");
      return pattern === null ? null : { verb: "run", detail: truncate(`search ${pattern}`) };
    }
    default:
      return null;
  }
}

/**
 * Parses Claude Code's `--output-format stream-json` feed.
 *
 * Deliberately forgiving. The stream is a debugging affordance of somebody
 * else's tool, not a contract we control: a line that does not parse, or a
 * shape that changed in a release, must cost a missing feed line and never the
 * run itself.
 */
export function createActivityParser(): (chunk: string) => ActivityLine[] {
  let pending = "";

  return (chunk: string): ActivityLine[] => {
    pending += chunk;
    const lines = pending.split("\n");
    // The last element is whatever arrived without a newline yet.
    pending = lines.pop() ?? "";

    const found: ActivityLine[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || !trimmed.startsWith("{")) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }

      const record = parsed as Record<string, unknown>;
      const message = record.message;
      if (typeof message !== "object" || message === null) {
        continue;
      }
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) {
        continue;
      }

      for (const block of content) {
        if (typeof block !== "object" || block === null) {
          continue;
        }
        const item = block as Record<string, unknown>;
        if (item.type !== "tool_use" || typeof item.name !== "string") {
          continue;
        }
        const input =
          typeof item.input === "object" && item.input !== null
            ? (item.input as Record<string, unknown>)
            : {};
        const described = describe(item.name, input);
        if (described !== null) {
          found.push(described);
        }
      }
    }
    return found;
  };
}
