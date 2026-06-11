import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/runCli.js";

const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const expectedVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version as string;

describe("traceroot --version", () => {
  it("prints the package version and exits 0", () => {
    const { stdout, stderr, status } = runCli("--version");
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(expectedVersion);
    expect(stderr).toBe("");
  });
});
