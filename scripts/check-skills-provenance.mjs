import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE, assetsSkillsDir, fail, hashedFiles, readTree, sha256 } from "./skills-vendor.mjs";

// The skills counterpart to scripts/codegen-check.mjs: the same shape, the same
// "run `npm run …`" failure line and the same exit conventions, wired into
// lint.yml beside the OpenAPI codegen drift check.
//
// assets/skills/ is a copy of a tree authored in another repository, committed
// here because the CLI resolves a bundled skill from disk with no network. A
// copy is only trustworthy if something can tell re-vendoring it apart from
// editing it by hand, and that something is assets/skills/source.json: the
// upstream repository, the 40-hex commit the bytes were read out of, the command
// that produced them, and a SHA-256 per file.
//
// Three things are asserted:
//
//  1. The record names an immutable commit. A branch name resolves to different
//     bytes over time, so recording one would make the rest of this check
//     vacuous — it would verify the copy against a moving target.
//  2. The record's file set equals the set on disk *exactly*. Checking only that
//     every recorded file is present would let an unrecorded file be added and
//     pass, which is the more useful half of the attack: a skill nobody vendored
//     shipping in the tarball. Checking only the other direction would let a
//     file be deleted and pass. Both directions are reported by name.
//  3. Every file still hashes to what the record says, reported with the path,
//     the expected digest and the one computed.
//
// What this does not do is ask whether the recorded commit is still upstream's
// head. That is deliberate: the failure worth catching is a copy that no longer
// matches what was recorded, and moving to a newer upstream commit should be a
// reviewed diff, not something CI demands.
const sourcePath = join(assetsSkillsDir, SOURCE);

let record;
try {
  record = JSON.parse(readFileSync(sourcePath, "utf8"));
} catch (err) {
  process.stderr.write(`${err}\n`);
  fail(
    `cannot read assets/skills/${SOURCE} — the vendored skill tree must carry its provenance record. Re-vendor it with \`npm run skills:refresh -- <path-to-traceroot-skills-clone>\`.`,
  );
}

const named = (field) => typeof record?.[field] === "string" && record[field].trim() !== "";
for (const field of ["repository", "generator"]) {
  if (!named(field)) {
    fail(`assets/skills/${SOURCE} has no \`${field}\` — it must record where the copy came from.`);
  }
}

if (!/^[0-9a-f]{40}$/.test(record.commit ?? "")) {
  fail(
    `assets/skills/${SOURCE} records \`commit\` as ${JSON.stringify(record.commit)} — it must be a full 40-character commit SHA, never a branch or tag name, because a copy can only be verified against bytes that cannot move.`,
  );
}

if (
  typeof record.files !== "object" ||
  record.files === null ||
  Array.isArray(record.files) ||
  Object.keys(record.files).length === 0
) {
  fail(
    `assets/skills/${SOURCE} has no \`files\` object mapping each vendored path to its SHA-256.`,
  );
}

const tree = readTree(assetsSkillsDir);
const onDisk = hashedFiles(tree);
const recorded = Object.keys(record.files).sort();

if (recorded.includes(SOURCE)) {
  fail(`assets/skills/${SOURCE} lists itself in \`files\`, which it cannot hash.`);
}

const unrecorded = onDisk.filter((path) => !(path in record.files));
const missing = recorded.filter((path) => !tree.has(path));
if (unrecorded.length > 0 || missing.length > 0) {
  const detail = [
    unrecorded.length > 0 ? `not recorded: ${unrecorded.join(", ")}` : undefined,
    missing.length > 0 ? `recorded but absent: ${missing.join(", ")}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join("; ");
  fail(
    `assets/skills/ does not hold the files assets/skills/${SOURCE} records (${detail}) — re-vendor the tree with \`npm run skills:refresh -- <path-to-traceroot-skills-clone>\` and commit the result, rather than editing it by hand.`,
  );
}

const changed = [];
for (const path of recorded) {
  const expected = record.files[path];
  if (!/^[0-9a-f]{64}$/.test(expected ?? "")) {
    fail(`assets/skills/${SOURCE} records ${path} as ${JSON.stringify(expected)}, not a SHA-256.`);
  }
  const actual = sha256(tree.get(path));
  if (actual !== expected) {
    changed.push(`${path}: expected ${expected}, got ${actual}`);
  }
}

if (changed.length > 0) {
  fail(
    `${changed.length} vendored file(s) do not match assets/skills/${SOURCE} (${changed.join("; ")}) — assets/skills/ is a copy, so change the skill upstream in ${record.repository}, then re-vendor it with \`npm run skills:refresh -- <path-to-traceroot-skills-clone>\`.`,
  );
}

process.stdout.write(
  `ok: verified ${recorded.length} vendored skill file(s) against ${record.repository}@${record.commit}.\n`,
);
process.exit(0);
