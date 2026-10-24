import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureGitignore, relativeToRoot, serviceArtifactDir } from "../../src/setup/artifacts.js";
import {
  ENV_FILE_HEADER,
  chooseCredentialEnvFile,
  upsertEnvContent,
  upsertEnvFile,
} from "../../src/setup/envWrite.js";
import { SetupError } from "../../src/setup/errors.js";

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
  it("names the path the file actually landed at, for git to be asked about", () => {
    // The question used to be answered here, by matching patterns out of the
    // repository root's `.gitignore`. It is asked of `git check-ignore` now —
    // see `isPathIgnored` in `git.ts` — and this module's remaining job is to
    // name the right path. `test1/.env` and `.env` are different files, and
    // asking about the wrong one is how a tracked credential gets written to.
    const test1 = serviceAt("test1");

    expect(relativeToRoot(root, join(test1, ".env"))).toBe("test1/.env");
    expect(relativeToRoot(root, join(root, ".env"))).toBe(".env");
  });

  it("does not create or touch a .gitignore of its own", () => {
    // Setup used to append a rule to the user's ignore file. It no longer writes
    // to git at all: it reads the answer with `git check-ignore` and tells the
    // user.
    //
    // The credential write is performed here rather than assumed. Asserting the
    // absence of a file after creating only fixtures passes whatever the code
    // does, so it reported "setup leaves your ignore file alone" without ever
    // running the part of setup that used not to.
    const test1 = serviceAt("test1");
    const target = chooseCredentialEnvFile(test1);
    const result = upsertEnvFile(join(test1, target.name), { TRACEROOT_API_KEY: "tr-secret" });

    expect(result.created).toBe(true);
    expect(existsSync(join(test1, target.name))).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(existsSync(join(test1, ".gitignore"))).toBe(false);
  });
});

describe("what the credential file says about itself", () => {
  const headerCount = (content: string): number =>
    content.split("\n").filter((line) => line === ENV_FILE_HEADER[0]).length;

  it("heads a file it creates, above the key", () => {
    const { content } = upsertEnvContent(null, { TRACEROOT_API_KEY: "tr-secret" });
    expect(content.startsWith(`${ENV_FILE_HEADER.join("\n")}\n`)).toBe(true);
    expect(content).toContain("TRACEROOT_API_KEY=tr-secret");
    // Says who wrote it and not to commit it. It no longer says the file is
    // disposable: that was true of a `.env.traceroot` only this tool read, and
    // is false of the project's own `.env`, where deleting it takes the
    // application's configuration with it.
    expect(content).toContain("Do not commit");
    expect(content).not.toContain("deleted");
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

describe("a --service that points outside the repository", () => {
  it("is refused before anything is written", () => {
    // The credential and the checkpoint land in this directory, and the
    // credential's `.gitignore` entry is written relative to the root — a `../`
    // entry could never match the file it was meant to cover, so the run would
    // report the key as ignored when it is not.
    expect(() => serviceArtifactDir({ root, cwd: root, service: "../other" })).toThrow(SetupError);
  });

  it("still accepts an absolute path that lands inside", () => {
    const inside = join(root, "api");
    mkdirSync(inside, { recursive: true });
    expect(serviceArtifactDir({ root, cwd: root, service: inside })).toBe(inside);
  });
});

describe("the `.gitignore` that covers setup's own files", () => {
  it("writes `*` into a `.traceroot` directory that has none", () => {
    const dir = join(root, ".traceroot");
    mkdirSync(dir, { recursive: true });

    ensureGitignore(dir);

    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("never touches a directory the CLI does not own", () => {
    // It is called with whatever directory an artefact landed in, so a wrong
    // answer here would start ignoring a user's own source tree.
    ensureGitignore(root);

    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  it("owns the directory called `.traceroot`, not every name ending in it", () => {
    // The one input the two predicates disagree about, and therefore the only
    // one that says which is in force: `vendor.traceroot` is a directory whose
    // name ends with ours and that nobody here owns. A test whose directory
    // fails both is satisfied by either.
    const dir = join(root, "vendor.traceroot");
    mkdirSync(dir, { recursive: true });

    ensureGitignore(dir);

    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("leaves an existing file alone", () => {
    const dir = join(root, ".traceroot");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "# mine\n");

    ensureGitignore(dir);

    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("# mine\n");
  });

  it("does nothing, rather than throwing, when the directory is not there", () => {
    expect(() => ensureGitignore(join(root, "gone", ".traceroot"))).not.toThrow();
  });

  it("writes through no symlink planted at the path", () => {
    // `existsSync` answers about the target, so a `.gitignore` symlinked
    // somewhere else reads as absent — and a plain write would follow it and
    // create that file with our content.
    const dir = join(root, ".traceroot");
    mkdirSync(dir, { recursive: true });
    const elsewhere = join(root, "elsewhere.txt");
    symlinkSync(elsewhere, join(dir, ".gitignore"));

    expect(() => ensureGitignore(dir)).not.toThrow();

    expect(existsSync(elsewhere)).toBe(false);
  });
});
