import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Runs as `prepublishOnly` (npm runs this automatically before `npm publish`,
// never before `npm ci`/`npm install`/`npm pack`) so a `file:` dependency —
// e.g. the vendored @traceroot-ai/tools tarball used during issue #65
// development, see vendor/README.md — can never ship in a published package;
// npm consumers cannot install a `file:` specifier that points at a path
// that doesn't exist in their own tree.
const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const offenders = Object.entries(pkg.dependencies ?? {})
  .filter(([, spec]) => typeof spec === "string" && spec.startsWith("file:"))
  .map(([name, spec]) => `${name}@${spec}`);

if (offenders.length > 0) {
  process.stderr.write(
    `error: dependencies contain a file: specifier (${offenders.join(", ")}) — swap the vendored @traceroot-ai/tools tarball for the npm release before publishing (see vendor/README.md)\n`,
  );
  process.exit(1);
}

process.stdout.write("ok: no file: dependencies.\n");
process.exit(0);
