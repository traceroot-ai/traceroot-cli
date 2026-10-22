import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MANIFEST,
  SKILLS_REMOTE,
  SKILL_NAME,
  SOURCE,
  assetsSkillsDir,
  fail,
  parseGitRemote,
  renderSource,
  sha256,
} from "./skills-vendor.mjs";

// Re-vendors assets/skills/ from a local clone of the skills repository and
// rewrites assets/skills/source.json to describe exactly what it wrote.
//
//   npm run skills:refresh -- ../traceroot-skills [ref]
//
// The ref defaults to the clone's HEAD. Everything is read out of the named
// commit with `git cat-file`, never off the clone's working tree: the point of
// the record is that the commit it names accounts for the bytes, and a dirty
// checkout would make that a lie. No network is used — a local clone plus
// `git` is the whole dependency — so this runs offline and is not part of
// `npm ci`, `npm run build` or `npm test`. Re-vendoring is a deliberate act,
// reviewed as a diff like any other change.
//
// This is deliberately not wired to a lifecycle hook. .npmrc commits
// `ignore-scripts=true`, which suppresses this package's own `prebuild`,
// `pretest`, `prepack` and `prepublishOnly` as well as its dependencies', so a
// hook here would be silently inert — and the tree it is responsible for would
// go missing from the tarball with nothing reporting it.
//
// Only the entries a manifest marks `bundledWithCli: true` are vendored, and
// the manifest written beside them is filtered to match. The CLI ships prose
// for the skills it ships and no others: src/skills/registry.ts requires the
// vendored manifest to describe exactly its built-in allowlist, so an entry for
// a skill with no files next to it is a mismatch, not extra information.

const [, , cloneArg, refArg] = process.argv;
const USAGE = "usage: npm run skills:refresh -- <path-to-traceroot-skills-clone> [ref]";

if (cloneArg === undefined || cloneArg.startsWith("-")) {
  fail(`no clone path given.\n${USAGE}`);
}
if (!existsSync(cloneArg)) {
  fail(
    `${cloneArg} does not exist — clone traceroot-skills and point this script at it.\n${USAGE}`,
  );
}

const ref = refArg ?? "HEAD";

/** Runs git in the clone, returning stdout as a Buffer. Any failure is fatal and named. */
function git(args, what) {
  const result = spawnSync("git", ["-C", cloneArg, ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    process.stderr.write(`${result.error}\n`);
    fail(`cannot run git — ${what}.`);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr?.toString("utf8") ?? "");
    fail(what);
  }
  return result.stdout;
}

const text = (args, what) => git(args, what).toString("utf8").trim();

if (
  text(["rev-parse", "--is-inside-work-tree"], `${cloneArg} is not a git repository.`) !== "true"
) {
  fail(`${cloneArg} is not a git work tree.\n${USAGE}`);
}

// `^{commit}` makes a tag resolve to the commit it points at rather than to the
// tag object, so the record always names something `git cat-file` can read a
// tree out of.
const commit = text(
  ["rev-parse", "--verify", `${ref}^{commit}`],
  `${ref} does not resolve to a commit in ${cloneArg} — fetch it, or name a ref that exists.`,
);
if (!/^[0-9a-f]{40}$/.test(commit)) {
  fail(`git resolved ${ref} to ${JSON.stringify(commit)}, which is not a commit SHA.`);
}

// A record is only useful if someone else can fetch the commit it names, and
// "on some remote-tracking branch" is not that: a commit living only on an
// open pull request's branch passes such a test and then stops being
// reachable the moment that pull request is squash-merged and its branch
// deleted, leaving `skills:check` verifying the copy against a commit nobody
// can fetch. So test reachability from origin's default branch instead, and
// keep it a warning rather than a refusal so a refresh can still be run ahead
// of merging.
const originHead = spawnSync(
  "git",
  ["-C", cloneArg, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
  { encoding: "utf8" },
);
if (originHead.status !== 0 || originHead.stdout.trim() === "") {
  // `origin/HEAD` is written by `git clone` and left stale by a default-branch
  // rename, so its absence says nothing about the commit either way.
  process.stderr.write(
    `warning: ${cloneArg} has no origin/HEAD, so whether ${commit} has landed on the skills repository's default branch could not be checked. Run \`git -C ${cloneArg} remote set-head origin -a\` and re-run to get that check.\n`,
  );
} else {
  const target = originHead.stdout.trim();
  const reachable = spawnSync(
    "git",
    ["-C", cloneArg, "merge-base", "--is-ancestor", commit, target],
    { encoding: "utf8" },
  );
  // 0 = ancestor, 1 = not an ancestor, 128 = a ref could not be read. Only 1
  // is evidence that the commit is unreachable.
  if (reachable.status === 1) {
    process.stderr.write(
      `warning: ${commit} has not landed on ${target} in ${cloneArg}, so it may be on a branch that disappears when its pull request merges. Record a commit that is on ${target} before this pin is relied on.\n`,
    );
  } else if (reachable.status !== 0) {
    process.stderr.write(
      `warning: could not check whether ${commit} has landed on ${target} in ${cloneArg} (git exited ${reachable.status}).\n`,
    );
  }
}

// The record names the repository the bytes came from, and nothing downstream
// checks the value — the provenance check only requires it to be a non-empty
// string — so a refresh run against any other clone would record
// `traceroot-ai/traceroot-skills` for bytes that did not come from it and pass
// CI, pinning a commit the skills repository does not have.
//
// `owner/repo` alone does not identify a repository: every host has its own
// `traceroot-ai/traceroot-skills` for the asking, so the slug has to be checked
// together with the host that served it. Both come from `parseGitRemote`, which
// resolves the authority the way a fetch would rather than trusting the shape
// of the URL.
/** `owner/repo` for the clone's `origin`, refusing any origin but the canonical one. */
function canonicalRepository() {
  const url = text(
    ["remote", "get-url", "origin"],
    `${cloneArg} has no \`origin\` remote, so there is no repository to record.`,
  );
  const expected = `${SKILLS_REMOTE.host}/${SKILLS_REMOTE.repository}`;
  const remote = parseGitRemote(url);
  if (remote === null) {
    fail(
      `cannot read a host and owner/repo out of the \`origin\` URL ${JSON.stringify(url)}, which has to be ${expected} — set the clone's \`origin\` to https://${expected}.git or git@${SKILLS_REMOTE.host}:${SKILLS_REMOTE.repository}.git, or pass a canonical clone.`,
    );
  }
  if (
    remote.host !== SKILLS_REMOTE.host ||
    remote.repository.toLowerCase() !== SKILLS_REMOTE.repository
  ) {
    fail(
      `${cloneArg}'s \`origin\` is ${remote.host}/${remote.repository}, not ${expected} — vendoring from anywhere else records a commit the skills repository cannot serve, under a name that claims it can. Point the clone's \`origin\` at ${expected}, or pass a canonical clone.`,
    );
  }
  return remote.repository;
}

const repository = canonicalRepository();

/** One blob at `commit`, as bytes. */
const blob = (path) =>
  git(["cat-file", "blob", `${commit}:${path}`], `cannot read ${path} at ${commit}.`);

/** Every path under `prefix` at `commit`, in git's own sorted order. */
function tracked(prefix) {
  const out = git(
    ["ls-tree", "-r", "-z", "--name-only", commit, "--", prefix],
    `cannot list ${prefix} at ${commit}.`,
  );
  return out.toString("utf8").split("\0").filter(Boolean);
}

let manifest;
try {
  manifest = JSON.parse(blob(`skills/${MANIFEST}`).toString("utf8"));
} catch (err) {
  process.stderr.write(`${err}\n`);
  fail(`skills/${MANIFEST} at ${commit} is not valid JSON.`);
}
if (!Array.isArray(manifest?.skills)) {
  fail(`skills/${MANIFEST} at ${commit} has no \`skills\` array.`);
}

const bundled = manifest.skills.filter((skill) => skill?.bundledWithCli === true);
if (bundled.length === 0) {
  fail(`no skill in skills/${MANIFEST} at ${commit} is marked \`bundledWithCli: true\`.`);
}

// `relative/posix/path -> contents` for the whole tree that is about to be
// written, read in full before anything on disk is touched.
const files = new Map();
for (const skill of bundled) {
  if (typeof skill.name !== "string" || !SKILL_NAME.test(skill.name)) {
    fail(`manifest skill name ${JSON.stringify(skill.name)} is not a plain directory name.`);
  }
  const paths = tracked(`skills/${skill.name}/`);
  if (paths.length === 0) {
    fail(
      `the manifest bundles '${skill.name}' but ${commit} has no files under skills/${skill.name}/.`,
    );
  }
  for (const path of paths) {
    files.set(`${skill.name}/${path.slice(`skills/${skill.name}/`.length)}`, blob(path));
  }
}
files.set(
  MANIFEST,
  Buffer.from(`${JSON.stringify({ ...manifest, skills: bundled }, null, 2)}\n`, "utf8"),
);

const hashes = new Map([...files].map(([path, contents]) => [path, sha256(contents)]));
files.set(
  SOURCE,
  Buffer.from(
    renderSource({
      repository,
      commit,
      generator: "npm run skills:refresh -- <path-to-traceroot-skills-clone>",
      files: hashes,
    }),
    "utf8",
  ),
);

// Stage the complete tree in a sibling directory, then install it with two
// renames — the old tree moves aside, the new one takes the path it left, and
// the old one is deleted last. Nothing is destroyed until the replacement is in
// place, so a failure anywhere up to that point costs the staging directory and
// nothing else: the catch below moves the old tree back before it reports.
//
// What two renames do not buy is a path that is never empty. Between them
// assets/skills/ does not exist, because no single call can replace one
// non-empty directory with another. That gap is two metadata operations wide and
// it is survivable: a process killed inside it leaves the whole old tree beside
// the path, under the `.old` suffix below.
//
// Replacing the whole directory rather than each `<name>` in turn is what stops
// a skill the manifest no longer bundles surviving in the tree — such a skill is
// absent from `files` above, so writing per-name would leave exactly the case
// this guards against.
const stagingDir = `${assetsSkillsDir}.${process.pid}.tmp`;
const previousDir = `${assetsSkillsDir}.${process.pid}.old`;
/** True while the old tree sits at `previousDir` and the path it came from is empty. */
let movedAside = false;
try {
  rmSync(stagingDir, { recursive: true, force: true });
  rmSync(previousDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  for (const [path, contents] of files) {
    const destination = join(stagingDir, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }

  mkdirSync(dirname(assetsSkillsDir), { recursive: true });
  // renameSync cannot replace a non-empty directory, so the old tree has to
  // leave this path before the new one can have it — moved, not deleted.
  if (existsSync(assetsSkillsDir)) {
    renameSync(assetsSkillsDir, previousDir);
    movedAside = true;
  }
  renameSync(stagingDir, assetsSkillsDir);
  movedAside = false;
} catch (err) {
  // Undo the move before reporting, so a failed run leaves the tree that was
  // there when it started.
  if (movedAside) {
    try {
      renameSync(previousDir, assetsSkillsDir);
      movedAside = false;
    } catch {
      // Could not be put back; the message below names where it is instead.
    }
  }
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  process.stderr.write(`${err}\n`);
  if (movedAside) {
    fail(
      `cannot re-vendor the skills, and the previous assets/skills/ could not be moved back — it is at ${previousDir}. Fix the cause above, move that directory back or delete it, and run the command again.`,
    );
  }
  fail("cannot re-vendor the skills — fix the cause above and run the command again.");
}

// The only destructive step, and it runs after the replacement is installed. A
// failure here is not a failed re-vendoring — assets/skills/ already holds the
// new tree — so it is reported as what it is: a directory left behind.
try {
  rmSync(previousDir, { recursive: true, force: true });
} catch (err) {
  process.stderr.write(`${err}\n`);
  process.stderr.write(`warning: re-vendored the skills but could not remove ${previousDir}.\n`);
}

process.stdout.write(
  `ok: vendored ${bundled.length} skill(s) in ${hashes.size} file(s) from ${repository}@${commit}.\n`,
);
process.stdout.write("Review the diff, including assets/skills/source.json, before committing.\n");
process.exit(0);
