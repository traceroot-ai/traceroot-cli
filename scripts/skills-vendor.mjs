import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The vendored skill tree, read one way only. Shared by
// scripts/refresh-skills.mjs, which rewrites assets/skills/ from a local
// traceroot-skills clone, and by the provenance check that re-hashes what is
// already there — so the writer and the reader cannot disagree about which
// files make up the tree or how they are hashed.
//
// assets/skills/ is committed, not generated at build time. The CLI resolves a
// bundled skill from disk with no network (src/skills/bundled.ts), and the npm
// tarball has to carry those files, so a copy lives in this repository. What
// keeps that copy honest is source.json beside it: the upstream repository, the
// 40-hex commit it was taken from, the command that produced it, and a SHA-256
// per file. Nothing is inferred from the tree itself.
//
// Every path below resolves from this file, so a self-contained directory
// holding scripts/ and assets/skills/ behaves exactly like the real repository.
// The tests are built on that.

/** No trailing separator: scripts/refresh-skills.mjs renames siblings against this path. */
export const assetsSkillsDir = fileURLToPath(new URL("../assets/skills", import.meta.url));

/** The provenance record's filename, inside {@link assetsSkillsDir}. */
export const SOURCE = "source.json";

/** The vendored manifest's filename, inside {@link assetsSkillsDir}. */
export const MANIFEST = "manifest.json";

/** A skill name is interpolated into a path, so only a plain directory name is allowed. */
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The one remote assets/skills/ may be vendored from, as the two things a git
 * remote URL carries: the host that serves the bytes and the `owner/repo` the
 * provenance record names. Both have to be checked, because the record only
 * ever states the second one — a clone of a repository with the same
 * `owner/repo` on a different host produces a record that is true about the
 * slug and false about where the bytes came from.
 */
export const SKILLS_REMOTE = { host: "github.com", repository: "traceroot-ai/traceroot-skills" };

/**
 * `{ host, repository }` for a git remote URL, or null when it is neither form
 * git hands out. The host is lowercased because DNS names are case-insensitive;
 * the repository is left exactly as written, so what gets recorded is what the
 * remote says.
 *
 * Both forms are parsed the way git and curl resolve them, so that what this
 * reports is the host a fetch would actually talk to:
 *
 *   - `scheme://[userinfo@]host[:port]/owner/repo(.git)` — the userinfo runs to
 *     the *last* `@` in the authority, so `https://github.com@evil.test/o/r`
 *     reads as host `evil.test`, which is where it would really go.
 *   - `[user@]host:owner/repo(.git)` — scp-like, recognised only when no slash
 *     precedes the colon, which is git's own rule for telling it from a URL.
 *
 * A `scheme://` URL is never retried as scp-like, which is also git's rule, so
 * one whose authority cannot be read — `file:///path`, an IPv6 literal — is
 * refused instead of being re-read as a host named after its scheme.
 */
export function parseGitRemote(url) {
  const trimmed = url.trim();
  const match = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? /^[a-z][a-z0-9+.-]*:\/\/(?:[^/]*@)?([^/:@]+)(?::\d+)?\/(.+)$/i.exec(trimmed)
    : /^(?:[^@/]+@)?([^@/:]+):(.+)$/.exec(trimmed);
  if (match === null) {
    return null;
  }
  const [, host, path] = match;
  if (host === undefined || path === undefined) {
    return null;
  }
  // `owner/repo.git/`, `owner/repo/` and `owner/repo` all name the same
  // repository: trailing slashes first, then the suffix they may have hidden.
  const repository = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
  if (repository === "") {
    return null;
  }
  return { host: host.toLowerCase(), repository };
}

/** Writes `message` as an `error:` line and exits 1 — the convention both scripts share. */
export function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/** Lowercase hex SHA-256 of `contents`, which must be a Buffer so the digest is over bytes. */
export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Every file under `dir` as a `relative/posix/path -> contents` Map, built from a
 * sorted walk and read as bytes, so the result is a function of the tree's
 * contents alone — no mode, no timestamp, no directory order.
 *
 * Anything that is neither a regular file nor a directory is rejected rather
 * than skipped. Skipping would make it invisible to the provenance check: a
 * stale symlink under assets/skills/ would be absent from both the record and
 * the walk, the check would report the tree verified, and
 * `src/skills/install.ts` would then refuse to install that bundle.
 * `readdirSync` reports entry types from an `lstat`, so a symlink is reported as
 * neither a file nor a directory here however it resolves.
 */
/**
 * Names npm never packs, so neither check should ever see them. `npm-packlist`
 * injects these unconditionally through its `defaults` rule set, so a
 * Finder-created `.DS_Store` under assets/skills/ would otherwise be recorded
 * and compared while being absent from every tarball — failing both checks
 * with remedies that cannot work: `skills:check` would blame a hand edit, and
 * `pack:check` would blame `files` in package.json, which can never bring one
 * back. Kept to npm's own list so the walk stays a function of what ships.
 */
const neverPacked = (name) => name === ".DS_Store" || name.startsWith("._");

export function readTree(dir) {
  const files = new Map();
  if (!existsSync(dir)) {
    return files;
  }
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const path = relative(dir, absolute).split(sep).join("/");
      // Before the symlink and regular-file checks below: npm drops these
      // whatever they are, so one cannot reach a tarball and neither check
      // has anything to say about it.
      if (neverPacked(entry.name)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        fail(
          `${path} under ${dir} is a symlink — skill bundles hold plain files, and \`skills install\` refuses a bundle containing one. Delete it and re-vendor the tree.`,
        );
      }
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        files.set(path, readFileSync(absolute));
      } else {
        fail(
          `${path} under ${dir} is not a regular file or directory — skill bundles hold plain files only. Delete it and re-vendor the tree.`,
        );
      }
    }
  };
  try {
    walk(dir);
  } catch (err) {
    // An unreadable file or directory, reported the way every other refusal in
    // this module is. Without this the callers would print a raw Node stack:
    // the walk is how both scripts read the tree, so it is where I/O errors
    // surface.
    process.stderr.write(`${err}\n`);
    fail(`cannot read the tree at ${dir}.`);
  }
  return files;
}

/**
 * The vendored files a provenance record covers: everything under
 * {@link assetsSkillsDir} except the record itself, which cannot hash its own
 * bytes. Takes the walk's result so the caller reads the tree once.
 */
export function hashedFiles(tree) {
  return [...tree.keys()].filter((path) => path !== SOURCE).sort();
}

/**
 * The exact bytes `assets/skills/source.json` must hold for a given record.
 * Keys are emitted in sorted order so re-vendoring an unchanged tree produces
 * an identical file, whatever order the walk happened to visit it in.
 */
export function renderSource({ repository, commit, generator, files }) {
  const sorted = {};
  for (const path of [...files.keys()].sort()) {
    sorted[path] = files.get(path);
  }
  return `${JSON.stringify({ repository, commit, generator, files: sorted }, null, 2)}\n`;
}
