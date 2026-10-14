import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetsSkillsDir, fail, readTree } from "./skills-vendor.mjs";

// Asserts the npm tarball actually carries assets/skills/.
//
// git guarantees those files are in a checkout — they are committed — but
// nothing guarantees they reach the archive. That is decided by `files` in
// package.json, and the usual places to vet it are closed here: .npmrc commits
// `ignore-scripts=true`, which suppresses this package's own lifecycle hooks as
// well as its dependencies', so neither `prepack` nor `prepublishOnly` fires.
// `npm pack` and `npm publish` therefore cannot be made to check themselves,
// and a `files` entry dropped or mistyped would publish a CLI with no skills to
// install, with no error anywhere.
//
// So this runs as an explicit step in publish.yml, immediately before
// `npm publish`: the workflow is the only route to the registry, since the
// publish is OIDC-trusted to it with no stored token. `npm run pack:check` is
// also the way to check a tarball by hand before packing one.
//
// It packs for real and reads the entry list out of the archive with `tar`,
// rather than taking `npm pack --dry-run --json`'s word for what an archive
// would have held. The two should agree; only one of them is the artifact that
// gets published.
//
// Whether the packed tree matches the upstream skills repository is a different
// question, asked by the provenance check against assets/skills/source.json.
const root = fileURLToPath(new URL("..", import.meta.url));

/** The tarball path prefix the directory's contents appear under. */
const PREFIX = "package/assets/skills";

const vendored = [...readTree(assetsSkillsDir).keys()].sort();
if (vendored.length === 0) {
  fail(
    "assets/skills/ holds no files — it is committed, so this checkout is incomplete; restore it with `git checkout -- assets/skills` or re-vendor it.",
  );
}

const destination = mkdtempSync(join(tmpdir(), "traceroot-cli-pack-"));
try {
  // Prefer the npm that invoked this script; fall back to the one on PATH when
  // it was started directly with node.
  const execPath = process.env.npm_execpath;
  const viaNode = execPath?.endsWith(".js") === true;
  const args = ["pack", "--json", "--pack-destination", destination];
  const pack = spawnSync(viaNode ? process.execPath : "npm", viaNode ? [execPath, ...args] : args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (pack.status !== 0) {
    process.stderr.write(pack.stderr ?? "");
    fail("`npm pack` failed, so the tarball's contents could not be checked.");
  }

  let filename;
  try {
    filename = JSON.parse(pack.stdout)[0].filename;
  } catch (err) {
    process.stderr.write(`${err}\n`);
    fail("cannot read the tarball name from `npm pack --json`.");
  }

  const listing = spawnSync("tar", ["-tzf", join(destination, filename)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listing.error !== undefined) {
    process.stderr.write(`${listing.error}\n`);
    fail("cannot run `tar`, so the packed tarball could not be read.");
  }
  if (listing.status !== 0) {
    process.stderr.write(listing.stderr ?? "");
    fail(`cannot list the entries of ${filename}.`);
  }

  // Directory entries end in a slash and are not compared; only files matter.
  const packed = new Set(listing.stdout.split("\n").filter((line) => !line.endsWith("/")));
  const missing = vendored.filter((path) => !packed.has(`${PREFIX}/${path}`));
  if (missing.length > 0) {
    fail(
      `${filename} omits ${missing.length} of the ${vendored.length} file(s) under assets/skills/ (${missing.join(", ")}) — check \`files\` in package.json.`,
    );
  }

  process.stdout.write(
    `ok: ${filename} carries all ${vendored.length} file(s) under assets/skills/.\n`,
  );
} finally {
  rmSync(destination, { recursive: true, force: true });
}

process.exit(0);
