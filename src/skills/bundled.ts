import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliError } from "../output.js";
import type { BuiltinSkillName } from "./registry.js";

/**
 * Absolute path to the vendored skill assets shipped inside the package. Both
 * the compiled module (`dist/skills/bundled.js`) and the source module
 * (`src/skills/bundled.ts`, used under vitest) sit two levels below the package
 * root, so `../../assets/skills/` resolves to the bundled assets in either case
 * — mirroring how `version.ts` reads `../package.json` from `dist/`.
 */
export function bundledSkillsRoot(): string {
  return fileURLToPath(new URL("../../assets/skills/", import.meta.url));
}

/**
 * Resolves the bundled source directory for a built-in skill, asserting it
 * exists in the installed package. Throws a {@link CliError} (not a raw fs
 * error) when the package was published without its assets.
 */
export function bundledSkillDir(name: BuiltinSkillName): string {
  const dir = fileURLToPath(new URL(`../../assets/skills/${name}/`, import.meta.url));
  if (!existsSync(dir)) {
    throw new CliError(
      `Bundled assets for skill '${name}' are missing from this install. Reinstall traceroot-cli.`,
    );
  }
  return dir;
}
