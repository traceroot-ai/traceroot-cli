/**
 * The SDK's own notices in a runner's output, which the CLI prints in its own words.
 *
 * A runner's output is the evaluation's: its logs, its prints and its tracebacks pass on unchanged.
 * The one line rewritten is a notice the traceroot SDK itself prints, recognised by its exact
 * wording in every released runner, so an application's line that merely mentions Git is never
 * touched. The SDK prints it when it starts without a Git repository and commit to link traces
 * to: one sentence of about 200 characters, which a terminal breaks mid-word and which drowns the
 * lines around it. An uploaded run gets it as a short warning. A local run sends no traces, so
 * there is nothing for it to link and the notice is left out; traceroot prints it there too, from
 * an evaluation that calls `initialize()`.
 */

import { wrapLine } from "../render/wrap.js";

/** How the notice starts, as each released SDK spells it, lowercased. */
const NOTICE_STARTS = ["traceroot: git context incomplete", "[traceroot] git context incomplete"];

/**
 * The notice in full. traceroot ends it `— see <url>`, @traceroot-ai/traceroot `(see <url>).`;
 * the prefix is `TraceRoot:`/`traceroot:` or `[TraceRoot]`/`[traceroot]` depending on the release.
 */
const GIT_NOTICE =
  /^(?:traceroot:|\[traceroot\]) git context incomplete \(repo=(.*), ref=(.*)\)\. The AI agent needs both to correlate traces to source\. Set TRACEROOT_GIT_REPO \/ TRACEROOT_GIT_REF (?:— see (\S+)|\(see (\S+)\)\.)$/i;

/** What a value the notice reports as missing reads as. */
const UNSET = "unset";

/**
 * Whether `text`, the start of a line so far, could still turn out to be the notice: a line is
 * held back only while it could, so every other line passes on as soon as it is written.
 */
export function couldBeNotice(text: string): boolean {
  const lower = text.toLowerCase();
  return NOTICE_STARTS.some((start) => start.startsWith(lower) || lower.startsWith(start));
}

/**
 * The notice in the CLI's words, wrapped to `width`, or null when `line` isn't the notice. It still
 * says which of the two was missing, what to set, and where the docs are. For a run that uploads
 * nothing it is no lines at all.
 */
export function rewriteNotice(
  line: string,
  width: number | undefined,
  uploads: boolean,
): string[] | null {
  const match = GIT_NOTICE.exec(line.replace(/\r$/, ""));
  if (match === null) {
    return null;
  }
  if (!uploads) {
    return [];
  }
  const [, repo = UNSET, ref = UNSET, dashUrl, parenUrl] = match;
  const url = dashUrl ?? parenUrl ?? "";
  const missing =
    repo === UNSET && ref === UNSET
      ? "no Git repository or commit was found"
      : repo === UNSET
        ? `no Git repository was found (commit ${ref})`
        : `no Git commit was found (repository ${repo})`;
  return [
    ...wrapLine(`warning: ${missing}, so the uploaded traces won't link to source code.`, width),
    ...wrapLine(`  Set TRACEROOT_GIT_REPO and TRACEROOT_GIT_REF: ${url}`, width),
  ];
}

/** Where a runner's output goes with the SDK's notices rewritten. */
export interface NoticeFilter {
  write(chunk: string): void;
  /** Passes on a line held back because it could have been a notice, once the runner has ended. */
  flush(): void;
}

/**
 * Passes `chunk`s on to `write` unchanged, except a whole line that is the SDK's notice, which is
 * replaced by {@link rewriteNotice}'s lines, or left out for a run that uploads nothing. Only the
 * start of a line that could still be the notice is held back, until its end shows whether it is;
 * every other line, and the unfinished last line of a chunk, passes on at once. `width` is asked
 * when the notice prints, so it fits a terminal resized since the run started.
 */
export function filterNotices(
  write: (text: string) => void,
  width: () => number | undefined,
  uploads: boolean,
): NoticeFilter {
  let atLineStart = true;
  let held = "";
  /** The line as it prints, each of its lines ending in a newline: nothing for a dropped notice. */
  const replaced = (line: string): string =>
    (rewriteNotice(line, width(), uploads) ?? [line]).map((piece) => `${piece}\n`).join("");
  return {
    write: (chunk) => {
      let text = held + chunk;
      held = "";
      let out = "";
      while (text !== "") {
        const newline = text.indexOf("\n");
        const line = newline === -1 ? text : text.slice(0, newline);
        if (atLineStart && couldBeNotice(line)) {
          if (newline === -1) {
            held = text;
            break;
          }
          out += replaced(line);
          text = text.slice(newline + 1);
          continue;
        }
        if (newline === -1) {
          out += text;
          atLineStart = false;
          break;
        }
        out += text.slice(0, newline + 1);
        atLineStart = true;
        text = text.slice(newline + 1);
      }
      if (out !== "") {
        write(out);
      }
    },
    flush: () => {
      if (held !== "") {
        // The runner ended mid-line, so the held text gets no newline it didn't write.
        const text = rewriteNotice(held, width(), uploads)?.join("\n") ?? held;
        if (text !== "") {
          write(text);
        }
        held = "";
      }
    },
  };
}
