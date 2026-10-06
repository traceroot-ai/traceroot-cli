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
