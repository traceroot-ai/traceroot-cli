import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { relativeToRoot, serviceArtifactDir } from "../../src/setup/artifacts.js";
import { ENV_FILE_HEADER, ensureIgnored, upsertEnvContent } from "../../src/setup/envWrite.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tr-artifacts-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A directory with a dependency manifest in it, which is what makes it a service. */
function serviceAt(...segments: string[]): string {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi"]\n');
  writeFileSync(join(dir, "main.py"), "print('hi')\n");
  return dir;
}

describe("where setup's own files go", () => {
  it("follows the directory you ran in, when that is a service", () => {
    // The credential has to land beside the application that reads it, not
    // wherever the repository root happens to be.
    const test1 = serviceAt("test1");
    expect(serviceArtifactDir({ root, cwd: test1 })).toBe(test1);
  });

  it("stays at the root when you ran there", () => {
    serviceAt();
    expect(serviceArtifactDir({ root, cwd: root })).toBe(root);
  });

  it("stays at the root when where you are standing is not a service", () => {
    // Running from `docs/` should not drop a credential in `docs/`. The root is
    // the honest answer to "you did not say, and there is nothing here".
    serviceAt();
    const docs = join(root, "docs");
    mkdirSync(docs, { recursive: true });
    expect(serviceArtifactDir({ root, cwd: docs })).toBe(root);
  });

  it("lets --service override where you are standing", () => {
    const api = serviceAt("api");
    const docs = join(root, "docs");
    mkdirSync(docs, { recursive: true });
    expect(serviceArtifactDir({ root, cwd: docs, service: "api" })).toBe(api);
    // Including when it names the root itself.
    expect(serviceArtifactDir({ root, cwd: docs, service: "." })).toBe(root);
  });

  it("does not follow a service the user never named", () => {
    // DETECT_STACK can auto-select a lone service in a directory nobody
    // mentioned. Writing a credential there would be a surprise, so the
    // artefacts stay at the root and the agent still instruments `api/`.
    serviceAt("api");
    expect(serviceArtifactDir({ root, cwd: root })).toBe(root);
  });

  it("names itself relative to the root, for a gitignore entry", () => {
    const test1 = serviceAt("test1");
    expect(relativeToRoot(root, test1)).toBe("test1");
    expect(relativeToRoot(root, root)).toBe(".");
  });
});

describe("keeping the credential out of git", () => {
  const read = (): string => readFileSync(join(root, ".gitignore"), "utf8");

  it("ignores the path the file actually landed at", () => {
    expect(ensureIgnored(root, "test1/.env.traceroot")).toBe("appended");
    expect(read()).toContain("test1/.env.traceroot");
  });

  it("does not mistake a root-anchored rule for cover of a nested file", () => {
    // THE expensive mistake. `/.env.traceroot` is anchored to the directory
    // holding the .gitignore, so it says nothing about `test1/.env.traceroot`.
    // Reading it as "already ignored" commits an API key.
    writeFileSync(join(root, ".gitignore"), "/.env.traceroot\n");
    expect(ensureIgnored(root, "test1/.env.traceroot")).toBe("appended");
    expect(read()).toContain("test1/.env.traceroot");
  });

  it("accepts an unanchored rule, which git applies at any depth", () => {
    // A bare basename genuinely does cover the nested file, so appending a
    // second rule would be noise in the user's file.
    writeFileSync(join(root, ".gitignore"), ".env.traceroot\n");
    expect(ensureIgnored(root, "test1/.env.traceroot")).toBe("already");
    expect(ensureIgnored(root, ".env.traceroot")).toBe("already");
  });

  it("accepts the usual dotenv wildcard", () => {
    writeFileSync(join(root, ".gitignore"), ".env*\n");
    expect(ensureIgnored(root, "test1/.env.traceroot")).toBe("already");
  });

  it("still covers the root case exactly as before", () => {
    writeFileSync(join(root, ".gitignore"), "/.env.traceroot\n");
    expect(ensureIgnored(root, ".env.traceroot")).toBe("already");
  });

  it("is not fooled by a comment that happens to name the file", () => {
    writeFileSync(join(root, ".gitignore"), "# .env.traceroot is secret\n");
    expect(ensureIgnored(root, ".env.traceroot")).toBe("appended");
  });

  it("appends rather than rewriting, and keeps the user's rules", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules\ndist\n");
    expect(ensureIgnored(root, "api/.env.traceroot")).toBe("appended");
    expect(read()).toBe("node_modules\ndist\napi/.env.traceroot\n");
  });
});

describe("what the credential file says about itself", () => {
  const headerCount = (content: string): number =>
    content.split("\n").filter((line) => line === ENV_FILE_HEADER[0]).length;

  it("heads a file it creates, above the key", () => {
    const { content } = upsertEnvContent(null, { TRACEROOT_API_KEY: "tr-secret" });
    expect(content.startsWith(`${ENV_FILE_HEADER.join("\n")}\n`)).toBe(true);
    expect(content).toContain("TRACEROOT_API_KEY=tr-secret");
    // Says not to commit it, and that it is disposable once it has done its job.
    expect(content).toContain("Do not commit");
    expect(content).toContain("deleted");
  });

  it("never puts the key in the comment", () => {
    // The one file where this mistake is unrecoverable.
    const { content } = upsertEnvContent(null, { TRACEROOT_API_KEY: "tr-secret" });
    for (const line of content.split("\n")) {
      if (line.startsWith("#")) {
        expect(line).not.toContain("tr-secret");
      }
    }
  });

  it("leaves exactly one header after a second run changes the key", () => {
    const first = upsertEnvContent(null, { TRACEROOT_API_KEY: "tr-one" }).content;
    const second = upsertEnvContent(first, { TRACEROOT_API_KEY: "tr-two" });
    expect(headerCount(second.content)).toBe(1);
    expect(second.content).toContain("TRACEROOT_API_KEY=tr-two");
    expect(second.content).not.toContain("tr-one");
    // And the header is still at the top, not pushed down or reordered.
    expect(second.content.startsWith(ENV_FILE_HEADER[0] ?? "")).toBe(true);
  });

  it("does not re-add a header the user deleted", () => {
    // Their file. A tool that keeps putting a comment back is a tool being
    // argued with.
    const stripped = "TRACEROOT_API_KEY=tr-one\n";
    const { content } = upsertEnvContent(stripped, { TRACEROOT_API_KEY: "tr-two" });
    expect(headerCount(content)).toBe(0);
    expect(content).toBe("TRACEROOT_API_KEY=tr-two\n");
  });

  it("does not disturb a file the user has written in", () => {
    const theirs = "# my own note\nOTHER=1\n\nTRACEROOT_API_KEY=tr-one\n";
    const { content } = upsertEnvContent(theirs, { TRACEROOT_API_KEY: "tr-two" });
    expect(content).toBe("# my own note\nOTHER=1\n\nTRACEROOT_API_KEY=tr-two\n");
  });

  it("writes no file at all when there was nothing to write", () => {
    // A header on its own would be an empty secret file appearing for no reason.
    const { content, written } = upsertEnvContent(null, {});
    expect(written).toEqual([]);
    expect(content).not.toContain("TRACEROOT_API_KEY");
  });
});
