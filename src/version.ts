import { readFileSync } from "node:fs";

/**
 * Reads the package version at runtime from package.json.
 *
 * Compiled to dist/version.js, so `../package.json` resolves to the package
 * root next to the dist/ directory.
 */
export function getVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return JSON.parse(raw).version as string;
}
