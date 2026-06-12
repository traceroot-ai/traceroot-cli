import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(
  new URL("../node_modules/openapi-typescript/bin/cli.js", import.meta.url),
);
const schemaPath = fileURLToPath(new URL("../src/api/generated/schema.ts", import.meta.url));

const result = spawnSync(process.execPath, [cli, "openapi.json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  process.stderr.write("error: failed to regenerate schema for drift check.\n");
  process.exit(1);
}

const normalize = (s) => s.replace(/\r\n/g, "\n");
const generated = normalize(result.stdout);
const committed = normalize(readFileSync(schemaPath, "utf8"));

if (generated !== committed) {
  process.stderr.write(
    "error: src/api/generated/schema.ts is out of date — run `npm run codegen` and commit the result.\n",
  );
  process.exit(1);
}

process.stdout.write("ok: src/api/generated/schema.ts is up to date.\n");
process.exit(0);
