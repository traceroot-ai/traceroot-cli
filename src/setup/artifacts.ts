import { isAbsolute, relative, resolve } from "node:path";
import { SetupError } from "./errors.js";
import { detectStack } from "./stack.js";

/**
 * Where the files setup writes are allowed to live.
 *
 * One answer, computed once, used by all of them. Without a single rule — the
 * credential and the checkpoint at the git root, `.traceroot/config.json` at
 * the working directory — running `traceroot setup` in `test1/` scatters one
 * run across two directories, and puts the credential two levels above the
 * application that has to read it, which is the one place it is no use.
 *
 * The credential is what settles the rule. `.env.traceroot` is read by the
 * process that runs the user's application, from the directory that
 * application lives in; a copy at the repository root of a monorepo is a file
 * nobody will find and nothing will load. So the artefacts follow the service,
 * and the checkpoint and config follow the credential rather than being
 * scattered away from it.
 *
 * The repository root still keeps the things that are genuinely about the
 * repository (the git checks, the agent's working directory, the `.gitignore`
 * it appends to); the service gets the things that are about the service.
 */

export interface ServiceArtifactDirInput {
  /** Repository root: the git root when inside one, else the working directory. */
  root: string;
  /** Where the user actually ran the command. */
  cwd: string;
  /** `--service <path>`, relative to the root, when the user named one. */
  service?: string | undefined;
}

/**
 * The directory setup's artefacts belong to, as an absolute path.
 *
 * Three cases, in order:
 *
 * 1. `--service <path>` is the user naming the target outright, and it wins.
 * 2. Otherwise the directory the command was run in, but only when that
 *    directory actually holds a service. This is the same probe `DETECT_STACK`
 *    uses to pick its instrumentation target, so the artefacts and the agent
 *    agree about what is being set up without either consulting the other.
 * 3. Otherwise the repository root.
 *
 * Deliberately NOT "whatever `DETECT_STACK` finally selected". That stage can
 * auto-select a lone service in a directory the user never mentioned — running
 * from the root of a repo whose only manifest is in `api/` selects `api/` — and
 * writing a credential into a directory nobody named is a surprise. Falling
 * back to the root is the honest answer to "you did not tell me, and where you
 * are standing is not a service". It is also why this can be resolved before
 * the pipeline starts, which is what lets `--resume` find the checkpoint before
 * any stage has run.
 */
export function serviceArtifactDir(input: ServiceArtifactDirInput): string {
  const { root, cwd } = input;

  if (input.service !== undefined && input.service !== "") {
    const dir = isAbsolute(input.service) ? input.service : resolve(root, input.service);
    const inside = relative(root, dir);
    // The credential and the checkpoint land here, and the credential's
    // `.gitignore` entry is written relative to the root — a `../` entry could
    // never match the file it was meant to cover, so the run would report the key
    // as ignored when it is not.
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new SetupError({
        stage: "detect_stack",
        code: "UNSUPPORTED",
        message: `--service ${input.service} is outside this repository.`,
        remedy: "Name a directory inside the repository, relative to its root.",
      });
    }
    return dir;
  }

  const here = relative(root, cwd);
  // Empty means cwd *is* the root; `..` means cwd is outside it, which only
  // happens if a caller passes a mismatched pair. Both are the root's case.
  if (here === "" || here.startsWith("..")) {
    return root;
  }

  return detectStack(root, { service: here }).selected === null ? root : resolve(root, here);
}

/**
 * The same directory as a repository-relative path, for a `.gitignore` entry or
 * a line of output. `.` when the artefacts live at the root.
 */
export function relativeToRoot(root: string, dir: string): string {
  // `/` separators: this string becomes a `.gitignore` pattern and a pathspec,
  // and a backslash in a gitignore pattern is an escape character rather than a
  // separator — the rule would read as one literal filename and match nothing.
  const rel = relative(root, dir).replaceAll("\\", "/");
  return rel === "" ? "." : rel;
}
