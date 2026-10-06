import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Every path in `scripts/skills-vendor.mjs` resolves from that file, so a
 * sandbox holding `scripts/` and `assets/skills/` behaves exactly like the
 * repository. That is what lets these tests drive the real scripts — including
 * their failure paths — without touching the working tree's own vendored
 * assets, which other test files read concurrently.
 */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPTS = ["skills-vendor.mjs", "refresh-skills.mjs", "check-skills-provenance.mjs"];

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

/**
 * CI forces colour on, so assertions compare the text rather than the escapes.
 * The pattern is built from a string because biome disallows a control
 * character inside a regex literal.
 */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string): string => s.replace(SGR, "");

/** A sandbox holding the real scripts and nothing else yet. */
function sandbox(): string {
  const root = temporaryDir("tr-sklprov-");
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const script of SCRIPTS) {
    cpSync(join(repoRoot, "scripts", script), join(root, "scripts", script));
  }
  return root;
}

const asset = (root: string, ...parts: string[]) => join(root, "assets", "skills", ...parts);

function write(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

/** Every file under `dir`, as relative posix paths. */
function tree(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...tree(dir, child));
    } else {
      out.push(child);
    }
  }
  return out.sort();
}

const run = (root: string, script: string, args: string[] = []) =>
  spawnSync(process.execPath, [join(root, "scripts", script), ...args], { encoding: "utf8" });

const check = (root: string) => run(root, "check-skills-provenance.mjs");
const refresh = (root: string, args: string[]) => run(root, "refresh-skills.mjs", args);

const sha256 = (contents: string) =>
  spawnSync(
    process.execPath,
    [
      "-e",
      'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(0)).digest("hex"))',
    ],
    {
      input: contents,
      encoding: "utf8",
    },
  ).stdout;

interface RecordOptions {
  commit?: string;
  repository?: string | undefined;
  generator?: string | undefined;
  files?: Record<string, string>;
}

/**
 * A sandbox holding two vendored files and a matching provenance record, which
 * each test then damages in one specific way.
 */
function vendored(options: RecordOptions = {}): string {
  const root = sandbox();
  const contents = {
    "manifest.json": '{"version":1,"skills":[]}\n',
    "skill-one/SKILL.md": "# skill one\n",
  };
  for (const [path, body] of Object.entries(contents)) {
    write(asset(root, ...path.split("/")), body);
  }
  const record: Record<string, unknown> = {
    commit: options.commit ?? "0".repeat(40),
    files:
      options.files ??
      Object.fromEntries(Object.entries(contents).map(([path, body]) => [path, sha256(body)])),
  };
  if ("repository" in options) {
    if (options.repository !== undefined) {
      record.repository = options.repository;
    }
  } else {
    record.repository = "traceroot-ai/traceroot-skills";
  }
  if ("generator" in options) {
    if (options.generator !== undefined) {
      record.generator = options.generator;
    }
  } else {
    record.generator = "npm run skills:refresh -- <clone>";
  }
  write(asset(root, "source.json"), `${JSON.stringify(record, null, 2)}\n`);
  return root;
}

describe("check-skills-provenance.mjs", () => {
  it("verifies a tree that matches its record", () => {
    const result = check(vendored());
    expect(result.status).toBe(0);
    expect(plain(result.stdout)).toContain("ok: verified 2 vendored skill file(s)");
    expect(plain(result.stdout)).toContain("traceroot-ai/traceroot-skills@");
  });

  it("fails when the record is missing", () => {
    const root = vendored();
    rmSync(asset(root, "source.json"));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("cannot read assets/skills/source.json");
    expect(plain(result.stderr)).toContain("npm run skills:refresh");
  });

  it("fails when the record is not JSON", () => {
    const root = vendored();
    write(asset(root, "source.json"), "{ not json");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("cannot read assets/skills/source.json");
  });

  it.each([
    ["a branch name", "main"],
    ["an abbreviated SHA", "d8effa4"],
    ["a 40-character non-hex string", "z".repeat(40)],
    ["uppercase hex", "D".repeat(40)],
    ["nothing at all", ""],
  ])("rejects %s as the commit", (_label, commit) => {
    const result = check(vendored({ commit }));
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("must be a full 40-character commit SHA");
  });

  it.each(["repository", "generator"] as const)("fails when %s is absent", (field) => {
    const result = check(vendored({ [field]: undefined }));
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain(`has no \`${field}\``);
  });

  it("fails when a file on disk is not in the record", () => {
    // The one-sided addition: every recorded file is present and correct, so a
    // check that only walked the record would pass this.
    const root = vendored();
    write(asset(root, "skill-two", "SKILL.md"), "# smuggled in\n");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("not recorded: skill-two/SKILL.md");
  });

  it("fails when a recorded file is absent from disk", () => {
    const root = vendored();
    rmSync(asset(root, "skill-one", "SKILL.md"));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("recorded but absent: skill-one/SKILL.md");
  });

  it("reports an addition and a deletion together", () => {
    const root = vendored();
    rmSync(asset(root, "skill-one", "SKILL.md"));
    write(asset(root, "skill-one", "OTHER.md"), "# renamed\n");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("not recorded: skill-one/OTHER.md");
    expect(plain(result.stderr)).toContain("recorded but absent: skill-one/SKILL.md");
  });

  it("fails on an edited file, naming the path and both digests", () => {
    const root = vendored();
    const expected = sha256("# skill one\n");
    write(asset(root, "skill-one", "SKILL.md"), "# edited by hand\n");
    const result = check(root);
    expect(result.status).toBe(1);
    const stderr = plain(result.stderr);
    expect(stderr).toContain("skill-one/SKILL.md");
    expect(stderr).toContain(`expected ${expected}`);
    expect(stderr).toContain(`got ${sha256("# edited by hand\n")}`);
    expect(stderr).toContain("change the skill upstream in traceroot-ai/traceroot-skills");
  });

  it("fails when a recorded digest is not a SHA-256", () => {
    const result = check(
      vendored({ files: { "manifest.json": "deadbeef", "skill-one/SKILL.md": "deadbeef" } }),
    );
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("not a SHA-256");
  });

  it("fails when files is empty or not an object", () => {
    for (const files of [{}, [] as unknown as Record<string, string>]) {
      const root = vendored();
      const record = JSON.parse(readFileSync(asset(root, "source.json"), "utf8"));
      record.files = files;
      write(asset(root, "source.json"), JSON.stringify(record));
      const result = check(root);
      expect(result.status).toBe(1);
      expect(plain(result.stderr)).toContain("has no `files` object");
    }
  });

  it("fails when the record lists itself", () => {
    const root = vendored();
    const record = JSON.parse(readFileSync(asset(root, "source.json"), "utf8"));
    record.files["source.json"] = "0".repeat(64);
    write(asset(root, "source.json"), JSON.stringify(record));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("lists itself");
  });

  it("rejects a symlink in the tree rather than looking past it", () => {
    // A symlink is neither a file nor a directory to the walk, so without an
    // explicit refusal it would be absent from both sides and verify clean —
    // while `skills install` refuses the bundle that holds it.
    const root = vendored();
    symlinkSync("SKILL.md", asset(root, "skill-one", "LINK.md"));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("is a symlink");
  });
});

/** A throwaway skills repository: a manifest, one file per skill, one commit. */
function skillsRepo(skills: { name: string; bundled: boolean }[], origin?: string): string {
  const root = temporaryDir("tr-sklrepo-");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  };

  spawnSync("git", ["init", "-q", "-b", "main", root], { encoding: "utf8" });
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(root, ".no-hooks"));

  for (const skill of skills) {
    write(join(root, "skills", skill.name, "SKILL.md"), `# ${skill.name}\n`);
    write(join(root, "skills", skill.name, "references", "notes.md"), `notes for ${skill.name}\n`);
  }
  write(
    join(root, "skills", "manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        skills: skills.map((skill) => ({
          name: skill.name,
          description: `prose for ${skill.name}`,
          bestFor: [`tag for ${skill.name}`],
          bundledWithCli: skill.bundled,
        })),
      },
      null,
      2,
    )}\n`,
  );
  git("add", "-A");
  git("commit", "-q", "-m", "skills");
  git("remote", "add", "origin", origin ?? "https://github.com/traceroot-ai/traceroot-skills.git");
  return root;
}

const headOf = (repo: string) =>
  spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

/** Makes the repo's HEAD look fetched, which is what silences the push warning. */
const publish = (repo: string) =>
  spawnSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", headOf(repo)]);

describe("refresh-skills.mjs", () => {
  it("vendors only the bundled skills and filters the manifest to match", () => {
    const root = sandbox();
    const repo = skillsRepo([
      { name: "skill-one", bundled: true },
      { name: "skill-two", bundled: false },
    ]);
    publish(repo);

    const result = refresh(root, [repo]);
    expect(plain(result.stderr)).toBe("");
    expect(result.status).toBe(0);
    expect(tree(asset(root))).toEqual([
      "manifest.json",
      "skill-one/SKILL.md",
      "skill-one/references/notes.md",
      "source.json",
    ]);

    const manifest = JSON.parse(readFileSync(asset(root, "manifest.json"), "utf8"));
    expect(manifest.skills.map((s: { name: string }) => s.name)).toEqual(["skill-one"]);
    expect(manifest.version).toBe(1);
  });

  it("writes a record the check then verifies", () => {
    const root = sandbox();
    const repo = skillsRepo([{ name: "skill-one", bundled: true }]);
    publish(repo);

    expect(refresh(root, [repo]).status).toBe(0);

    const record = JSON.parse(readFileSync(asset(root, "source.json"), "utf8"));
    expect(record.commit).toBe(headOf(repo));
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.repository).toBe("traceroot-ai/traceroot-skills");
    expect(record.generator).toContain("npm run skills:refresh");
    expect(Object.keys(record.files).sort()).toEqual([
      "manifest.json",
      "skill-one/SKILL.md",
      "skill-one/references/notes.md",
    ]);

    const verified = check(root);
    expect(verified.status).toBe(0);
    expect(plain(verified.stdout)).toContain("ok: verified 3 vendored skill file(s)");
  });

  it("reads the named commit, not the clone's working tree", () => {
    const root = sandbox();
    const repo = skillsRepo([{ name: "skill-one", bundled: true }]);
    publish(repo);
    // A dirty checkout must not reach the tree, or the recorded commit would
    // not account for the bytes beside it.
    write(join(repo, "skills", "skill-one", "SKILL.md"), "# uncommitted\n");
    write(join(repo, "skills", "skill-one", "references", "stray.md"), "# untracked\n");

    expect(refresh(root, [repo]).status).toBe(0);
    expect(readFileSync(asset(root, "skill-one", "SKILL.md"), "utf8")).toBe("# skill-one\n");
    expect(existsSync(asset(root, "skill-one", "references", "stray.md"))).toBe(false);
    expect(check(root).status).toBe(0);
  });

  it("accepts an explicit ref and records the commit it resolves to", () => {
    const root = sandbox();
    const repo = skillsRepo([{ name: "skill-one", bundled: true }]);
    publish(repo);
    const first = headOf(repo);
    // A second commit the default HEAD would pick up instead.
    write(join(repo, "skills", "skill-one", "SKILL.md"), "# second\n");
    spawnSync("git", ["-C", repo, "commit", "-aqm", "second", "--no-gpg-sign"]);

    expect(refresh(root, [repo, first]).status).toBe(0);
    const record = JSON.parse(readFileSync(asset(root, "source.json"), "utf8"));
    expect(record.commit).toBe(first);
    expect(readFileSync(asset(root, "skill-one", "SKILL.md"), "utf8")).toBe("# skill-one\n");
  });

  it("drops a skill the manifest no longer bundles", () => {
    const root = sandbox();
    // Left behind by an earlier vendoring.
    write(asset(root, "skill-gone", "SKILL.md"), "# stale\n");

    const repo = skillsRepo([{ name: "skill-one", bundled: true }]);
    publish(repo);
    expect(refresh(root, [repo]).status).toBe(0);
    expect(existsSync(asset(root, "skill-gone"))).toBe(false);
    expect(check(root).status).toBe(0);
  });

  it("leaves nothing beside the tree once the swap is done", () => {
    const root = sandbox();
    const repo = skillsRepo([{ name: "skill-one", bundled: true }]);
    publish(repo);
    expect(refresh(root, [repo]).status).toBe(0);
    expect(readdirSync(join(root, "assets"))).toEqual(["skills"]);
  });

  it("warns when the recorded commit is on no remote-tracking branch", () => {
    const root = sandbox();
    // No `publish(repo)`, so nothing has been fetched from a remote: the commit
    // resolves here and would verify forever while naming bytes nobody can
    // look up.
    const repo = skillsRepo([{ name: "skill-one", bundled: true }]);
    const result = refresh(root, [repo]);
    expect(result.status).toBe(0);
    expect(plain(result.stderr)).toContain("is not on any remote-tracking branch");
    expect(plain(result.stderr)).toContain("Push it before this record is relied on");
  });

  it("records owner/repo from an scp-style origin URL", () => {
    const root = sandbox();
    const repo = skillsRepo(
      [{ name: "skill-one", bundled: true }],
      "git@github.com:traceroot-ai/traceroot-skills.git",
    );
    publish(repo);
    expect(refresh(root, [repo]).status).toBe(0);
    const record = JSON.parse(readFileSync(asset(root, "source.json"), "utf8"));
    expect(record.repository).toBe("traceroot-ai/traceroot-skills");
  });

  it("refuses a path that is not there", () => {
    const root = sandbox();
    const result = refresh(root, [join(root, "nowhere")]);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("does not exist");
    expect(plain(result.stderr)).toContain("usage: npm run skills:refresh");
  });

  it("refuses to run with no clone path", () => {
    const result = refresh(sandbox(), []);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("no clone path given");
  });

  it("refuses a ref that does not resolve", () => {
    const root = sandbox();
    const repo = skillsRepo([{ name: "skill-one", bundled: true }]);
    const result = refresh(root, [repo, "no-such-ref"]);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("does not resolve to a commit");
    expect(existsSync(asset(root))).toBe(false);
  });

  it("refuses a manifest that bundles nothing", () => {
    const root = sandbox();
    const repo = skillsRepo([{ name: "skill-one", bundled: false }]);
    const result = refresh(root, [repo]);
    expect(result.status).toBe(1);
    expect(plain(result.stderr)).toContain("bundledWithCli");
  });

  it("leaves the previous tree in place when it refuses", () => {
    const root = sandbox();
    const repo = skillsRepo([{ name: "skill-one", bundled: true }]);
    publish(repo);
    expect(refresh(root, [repo]).status).toBe(0);
    const before = tree(asset(root));

    // A manifest that bundles nothing is rejected after the tree has been read
    // but before anything is written.
    const broken = skillsRepo([{ name: "skill-one", bundled: false }]);
    expect(refresh(root, [broken]).status).toBe(1);
    expect(tree(asset(root))).toEqual(before);
    expect(check(root).status).toBe(0);
  });
});
