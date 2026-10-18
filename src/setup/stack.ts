import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { PackageManager } from "../repo/detect.js";
import type { DetectedService, DetectedStack, StackLanguage } from "./types.js";

/**
 * Directories that commonly hold sub-projects. Scanning one level deep covers
 * the overwhelmingly common monorepo shapes without walking a whole tree (which
 * would be slow and would find vendored copies, fixtures and examples).
 */
const WORKSPACE_DIRS = [
  "apps",
  "packages",
  "services",
  "src",
  "backend",
  "frontend",
  "server",
  "api",
] as const;

/** Directories never treated as candidate services. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "dist",
  "build",
  "__pycache__",
  ".next",
  "target",
  "vendor",
  "examples",
  "example",
  "fixtures",
  "test",
  "tests",
  ".traceroot",
]);

/**
 * Manifests for languages the CLI knowingly does not support for
 * instrumentation. Detecting them explicitly lets setup say "Go is not
 * supported yet" instead of silently reporting an empty repository — and, more
 * importantly, stops it from falling back to a generic setup for a language the
 * SDK has no story for.
 */
const UNSUPPORTED_MANIFESTS: ReadonlyArray<[string, string]> = [
  ["go.mod", "Go"],
  ["Cargo.toml", "Rust"],
  ["pom.xml", "Java"],
  ["build.gradle", "Java"],
  ["build.gradle.kts", "Java"],
  ["Gemfile", "Ruby"],
  ["composer.json", "PHP"],
];

/** Lockfile → package manager, matching `repo/detect.ts`'s priority order. */
const NODE_LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];
const PYTHON_LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
];

/** Dependency substring → framework label, most specific first. */
const NODE_FRAMEWORKS: ReadonlyArray<[string, string]> = [
  ["@mastra/core", "mastra"],
  ["next", "next"],
  ["@nestjs/core", "nestjs"],
  ["fastify", "fastify"],
  ["express", "express"],
  ["hono", "hono"],
  ["koa", "koa"],
  ["@langchain/core", "langchain"],
  ["langchain", "langchain"],
  ["ai", "vercel-ai-sdk"],
];

const PYTHON_FRAMEWORKS: ReadonlyArray<[string, string]> = [
  ["fastapi", "fastapi"],
  ["django", "django"],
  ["flask", "flask"],
  ["litestar", "litestar"],
  ["langgraph", "langgraph"],
  ["langchain", "langchain"],
  ["crewai", "crewai"],
  ["llama-index", "llamaindex"],
  ["llama_index", "llamaindex"],
];

/** Entry points probed in order; the first that exists wins. */
const PYTHON_ENTRY_POINTS = ["main.py", "app.py", "src/main.py", "src/app.py", "manage.py"];
const NODE_ENTRY_POINTS = [
  "src/index.ts",
  "src/main.ts",
  "src/server.ts",
  "src/index.js",
  "src/main.js",
  "index.ts",
  "index.js",
  "server.js",
  "app.js",
];

/**
 * Builds a service for a directory the user named explicitly.
 *
 * `--service` is the user answering the question, so a missing manifest is no
 * longer a reason to refuse: they can see their own repository. Without this
 * the "point at it with --service" remedy was a dead end that produced the
 * very error it was suggested to resolve.
 */
function assertedService(
  root: string,
  relPath: string,
  language: StackLanguage,
): DetectedService | null {
  const dir = relPath === "." ? root : join(root, relPath);
  try {
    if (!statSync(dir).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const entryPoints = language === "python" ? PYTHON_ENTRY_POINTS : NODE_ENTRY_POINTS;
  return {
    path: relPath,
    language,
    framework: null,
    entryPoint: firstExisting(dir, entryPoints),
    packageManager: detectPackageManager(dir, root, language),
    testCommand: null,
    evidence: [`no dependency manifest in ${relPath}; language chosen by the user`],
    // Nothing here was detected. The agent identifies the real service.
    agentMustIdentify: true,
  };
}

/** `traceroot.init(...)` or `traceroot.initialize(...)`: unambiguous on its own. */
const QUALIFIED_INITIALIZE = /\btraceroot\s*\.\s*init(?:ialize)?\s*\(/i;
/**
 * A bare `initialize()`, which is how the Python SDK is started after
 * `from traceroot import initialize` — and also how a great many applications
 * start their own database, logger or unrelated SDK. It only counts when the same
 * file actually imports us.
 */
const BARE_INITIALIZE = /(?:^|[^\w.])initialize\s*\(\s*\)/m;
const TRACEROOT_IMPORT =
  /^\s*(?:from|import)\s+traceroot\b|require\(\s*["'][^"']*traceroot|from\s+["'][^"']*traceroot/im;

/**
 * An actual call that starts the SDK, in either language.
 *
 * The bar for "already instrumented": importing the package, or listing it as
 * a dependency, proves only that somebody intended to. Matching the call is
 * what distinguishes a wired-up application from one that merely mentions us.
 */
function initializesTraceRoot(source: string): boolean {
  return (
    QUALIFIED_INITIALIZE.test(source) ||
    (BARE_INITIALIZE.test(source) && TRACEROOT_IMPORT.test(source))
  );
}

/** Substrings that mean a manifest already depends on a TraceRoot SDK. */
const TRACEROOT_DEPS = ["@traceroot-ai/traceroot", "@traceroot-ai/mastra", "traceroot"];

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `dependencies` and `devDependencies` as one map: every question asked here is about both. */
function dependenciesOf(pkg: Record<string, unknown>): Record<string, string> {
  return {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  const raw = readIfPresent(join(dir, "package.json"));
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function detectPackageManager(
  dir: string,
  repoRoot: string,
  language: StackLanguage,
): PackageManager | undefined {
  // Only this service's own ecosystem. A root `pnpm-lock.yaml` says nothing about
  // how a Python service beneath it installs, and answering `pnpm` there costs
  // the `uv add` the service actually needs — and hides `requirements.txt` behind
  // a lockfile from the other half of the repository.
  const lockfiles = language === "python" ? PYTHON_LOCKFILES : NODE_LOCKFILES;
  // A lockfile in the service directory wins; otherwise fall back to the repo
  // root, since monorepos usually keep a single lockfile at the top.
  for (const searchDir of dir === repoRoot ? [dir] : [dir, repoRoot]) {
    for (const [lockfile, manager] of lockfiles) {
      if (existsSync(join(searchDir, lockfile))) {
        return manager;
      }
    }
  }
  if (existsSync(join(dir, "requirements.txt"))) {
    return "pip";
  }
  return undefined;
}

/** Whether a repo-relative path lives in a directory that holds generated output. */
function isBuildArtifact(relPath: string): boolean {
  return relPath
    .split(/[\\/]/)
    .some((segment) => IGNORED_DIRS.has(segment) && segment !== "test" && segment !== "tests");
}

function firstExisting(dir: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(join(dir, candidate))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Exact dependency-name match, for the Node table. The Python table is scanned
 * against raw manifest TEXT, where a substring is the only option; a
 * `package.json` gives parsed names, and a substring there makes `ai` match
 * `chai`, `tailwindcss` and `openai`.
 */
function matchFrameworkByName(
  names: readonly string[],
  table: ReadonlyArray<[string, string]>,
): string | null {
  const present = new Set(names.map((name) => name.toLowerCase()));
  for (const [needle, label] of table) {
    if (present.has(needle)) {
      return label;
    }
  }
  return null;
}

function matchFramework(haystack: string, table: ReadonlyArray<[string, string]>): string | null {
  const lowered = haystack.toLowerCase();
  for (const [needle, label] of table) {
    if (lowered.includes(needle)) {
      return label;
    }
  }
  return null;
}

/**
 * Whether a manifest describes an actual application rather than a container.
 *
 * A repository root often carries a `package.json` that exists only to hold
 * workspaces, tooling config, or nothing at all — `{}` is common. Treating that
 * as a service is how setup ends up "instrumenting" the top of a monorepo: it
 * finds no entry point, no test command, and hands an agent a target that does
 * not exist.
 */
function describesAnApplication(pkg: Record<string, unknown>, hasEntryPoint: boolean): boolean {
  // A `workspaces` field means this manifest points at other packages — but a
  // repo is often BOTH a workspace root and a real application (a CLI with
  // extracted sub-packages, say). Only treat it as a pure container when there
  // is also nothing to run: no entry point and no `bin`.
  if (pkg.workspaces !== undefined && !hasEntryPoint && pkg.bin === undefined) {
    return false;
  }
  const deps = dependenciesOf(pkg);
  const scripts = (pkg.scripts as Record<string, string>) ?? {};
  return Object.keys(deps).length > 0 || Object.keys(scripts).length > 0 || hasEntryPoint;
}

/**
 * Whether a `test` script is the placeholder `npm init` writes rather than a
 * real check.
 *
 * `npm init` (and `pnpm init`) generate:
 *
 * ```json
 * "test": "echo \"Error: no test specified\" && exit 1"
 * ```
 *
 * That is a non-empty string, so a presence check accepted it — and setup then
 * ran, as its verification, a command whose entire purpose is to exit non-zero.
 * The report blamed the instrumentation for breaking a suite that never
 * existed, *after* the coding agent had already edited the repository. Projects
 * that ran `npm init` and never wrote a test are exactly the population an
 * onboarding wizard meets.
 *
 * Matched by the two properties that make it a placeholder — it announces that
 * no test is specified, and it exits non-zero — rather than by equality against
 * the generated string, which any requoting or reflowing defeats. Both are
 * required, so a real script cannot be swallowed: `vitest run`,
 * `jest --coverage` and `npm run test:unit && npm run test:e2e` contain the word
 * "test" but not the phrase, and `jest || exit 1` exits non-zero but announces
 * nothing. Only a script that says there is no test to run matches.
 */
function isPlaceholderTestScript(script: string): boolean {
  const normalized = script.toLowerCase().replace(/\s+/g, " ");
  return normalized.includes("no test specified") && normalized.includes("exit 1");
}

/** Builds the Node/TypeScript candidate rooted at `dir`, or `null` if there is none. */
function nodeService(dir: string, repoRoot: string): DetectedService | null {
  const pkg = readPackageJson(dir);
  if (pkg === null) {
    return null;
  }
  const relPath = relative(repoRoot, dir) || ".";
  const evidence = [`package.json in ${relPath}`];

  const isTypeScript = existsSync(join(dir, "tsconfig.json"));
  if (isTypeScript) {
    evidence.push(`tsconfig.json in ${relPath}`);
  }

  const framework = matchFrameworkByName(Object.keys(dependenciesOf(pkg)), NODE_FRAMEWORKS);
  if (framework !== null) {
    evidence.push(`${framework} dependency`);
  }

  const scripts = (pkg.scripts as Record<string, string>) ?? {};
  const manager = detectPackageManager(dir, repoRoot, isTypeScript ? "typescript" : "javascript");
  const runner = manager === "pnpm" || manager === "yarn" || manager === "bun" ? manager : "npm";
  // A declared script is only a verification command when it would actually
  // check something: an empty string is npm running nothing and exiting 0, a
  // vacuous pass that reads as proof.
  const declared = (name: string): string | null => {
    const value = scripts[name];
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  };
  const declaredTest = declared("test");
  const testCommand =
    declaredTest !== null && !isPlaceholderTestScript(declaredTest)
      ? `${runner} test`
      : declared("typecheck") !== null
        ? `${runner} run typecheck`
        : null;

  // `main` usually points at COMPILED output (`dist/cli.js`). Instrumenting that
  // tells an agent to edit a file the next build overwrites, so a published
  // entry point is only trusted when it is not inside a build directory.
  const mainField = typeof pkg.main === "string" ? pkg.main : null;
  const mainIsSource =
    mainField !== null && !isBuildArtifact(mainField) && existsSync(join(dir, mainField));
  const entryPoint = mainIsSource ? mainField : firstExisting(dir, NODE_ENTRY_POINTS);

  if (!describesAnApplication(pkg, entryPoint !== null)) {
    return null;
  }

  return {
    path: relPath,
    language: isTypeScript ? "typescript" : "javascript",
    framework,
    entryPoint,
    packageManager: manager,
    testCommand,
    evidence,
  };
}

/** Builds the Python candidate rooted at `dir`, or `null` if there is none. */
function pythonService(dir: string, repoRoot: string): DetectedService | null {
  const pyproject = readIfPresent(join(dir, "pyproject.toml"));
  const requirements = readIfPresent(join(dir, "requirements.txt"));
  if (pyproject === null && requirements === null) {
    return null;
  }
  const relPath = relative(repoRoot, dir) || ".";
  const evidence = [
    pyproject !== null ? `pyproject.toml in ${relPath}` : `requirements.txt in ${relPath}`,
  ];

  const manifest = `${pyproject ?? ""}\n${requirements ?? ""}`;
  const framework = matchFramework(manifest, PYTHON_FRAMEWORKS);
  if (framework !== null) {
    evidence.push(`${framework} dependency`);
  }

  const manager = detectPackageManager(dir, repoRoot, "python");
  // Prefer a real test runner over a bare import check: `pytest` is present in
  // the manifest of nearly every Python project that has tests at all.
  const hasPytest =
    manifest.toLowerCase().includes("pytest") ||
    existsSync(join(dir, "pytest.ini")) ||
    existsSync(join(dir, "tox.ini"));
  // Through the project's own manager when it has one that owns the
  // environment. `uv` and `poetry` both put the virtualenv somewhere this
  // process cannot be expected to find — poetry's default is a hashed
  // directory under its own cache, which `detectPythonEnvironment` does not
  // look at — so a bare `pytest` there is not on PATH, and fails as a missing
  // test runner that is in fact installed. `installCommand` and `importCheck`
  // already go through Poetry for the same reason.
  const testCommand = hasPytest
    ? manager === "uv"
      ? "uv run pytest"
      : manager === "poetry"
        ? "poetry run pytest"
        : "pytest"
    : null;

  return {
    path: relPath,
    language: "python",
    framework,
    entryPoint: firstExisting(dir, PYTHON_ENTRY_POINTS),
    packageManager: manager,
    testCommand,
    evidence,
  };
}

/**
 * Candidate directories: the root, every top-level directory, and one level
 * inside the usual workspace folders.
 *
 * Scanning only a hardcoded list of workspace names (`apps`, `packages`, …)
 * misses the very common layout where sibling projects sit directly at the top
 * of a repository. That produced the worst possible outcome: exactly one
 * candidate — the root — so nothing looked ambiguous and setup proceeded with a
 * target nobody meant.
 */
function candidateDirs(root: string): string[] {
  const dirs = [root];

  // Every top-level directory is a possible project.
  try {
    for (const dir of subdirectories(root, readdirSync(root))) {
      dirs.push(dir);
    }
  } catch {
    // unreadable root — the root itself is still a candidate
  }

  for (const workspace of WORKSPACE_DIRS) {
    const workspaceDir = join(root, workspace);
    let entries: string[];
    try {
      if (!statSync(workspaceDir).isDirectory()) {
        continue;
      }
      entries = readdirSync(workspaceDir);
    } catch {
      continue;
    }
    // `api/` and `server/` are often the service itself rather than a container
    // of services, so consider the directory as well as its children.
    dirs.push(workspaceDir);
    for (const dir of subdirectories(workspaceDir, entries)) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/** The directories among `entries` of `parent`, by name, minus ignored and hidden ones. */
function subdirectories(parent: string, entries: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const entry of [...entries].sort()) {
    if (IGNORED_DIRS.has(entry) || entry.startsWith(".")) {
      continue;
    }
    const child = join(parent, entry);
    try {
      if (statSync(child).isDirectory()) {
        dirs.push(child);
      }
    } catch {
      // unreadable entry — skip
    }
  }
  return dirs;
}

/** Repo-level evidence that TraceRoot is already wired in. */
function detectExistingInstrumentation(
  root: string,
  services: DetectedService[],
): { present: boolean; evidence: string[] } {
  const evidence: string[] = [];
  // Tracked separately from `evidence`, because the two answer different
  // questions. A declared dependency is worth telling the agent about; only a
  // call to `initialize()` means the application is actually wired up.
  let wired = false;

  for (const service of services) {
    const dir = service.path === "." ? root : join(root, service.path);
    const manifests = ["package.json", "pyproject.toml", "requirements.txt"];
    for (const manifest of manifests) {
      const raw = readIfPresent(join(dir, manifest));
      if (raw === null) {
        continue;
      }
      for (const dep of TRACEROOT_DEPS) {
        // `"traceroot"` as a bare word would also match a comment; requiring the
        // quoted/pinned forms keeps this to real dependency declarations.
        if (raw.includes(`"${dep}"`) || raw.includes(`${dep}==`) || raw.includes(`${dep}>=`)) {
          evidence.push(`${dep} declared in ${service.path}/${manifest}`);
          break;
        }
      }
    }
    // Only hand-written source counts. A compiled bundle mentions everything it
    // ever imported, so scanning one reports instrumentation that is not there —
    // and in a repository whose own name is "traceroot", it always matches.
    const entry = service.entryPoint;
    if (entry !== null && !isBuildArtifact(entry)) {
      const source = readIfPresent(join(dir, entry));
      if (source !== null && initializesTraceRoot(source)) {
        evidence.push(`traceroot initialized in ${service.path}/${entry}`);
        wired = true;
      }
    }
  }

  // A dependency line is not instrumentation.
  //
  // Treating one as "already present" told the coding agent the work was done
  // and it wrote nothing — which is exactly what happens in a repository that
  // depends on TraceRoot for other reasons, or one named after it. Only an
  // actual initialization call means there is nothing to do.
  return { present: wired, evidence };
}

/** The service's entry point as a path from the repository root, if it has one. */
export function serviceEntryPath(service: DetectedService): string | null {
  const entry = service.entryPoint;
  if (entry === null) {
    return null;
  }
  return service.path === "." ? entry : `${service.path}/${entry}`;
}

/**
 * Reads whether a service is wired up to TraceRoot *now*, naming the file that
 * proves it.
 *
 * {@link detectStack} asks this once, before anything has been edited, and
 * stores the answer as `existingInstrumentation`. This is that same reading —
 * an actual `initialize()` call in hand-written source, by the rules in
 * {@link initializesTraceRoot} — made available on its own so a caller can ask
 * again after a coding agent has had the repository. Asking directly is what
 * separates "nothing was edited" from "something was edited that instrumented
 * nothing", and unlike a diff it needs no git repository to answer.
 *
 * The entry point is read first: it is where the task tells the agent to put
 * the call, and it is the file worth naming when the answer is no. `alsoRead`
 * is for files the agent claims to have changed, or that git saw change — a
 * call wired into a module the entry point imports is still instrumentation,
 * and refusing to look there would fail a run that worked. Each of those is
 * tried against the repository root and the service directory, because a
 * reported path may be relative to either, and one that turns out to be a
 * directory is read as the source files inside it, because that is how `git
 * status` spells a wholly untracked one — which also lets a caller with no
 * report and no diff to go on name the service's own directory and have it read
 * under the same bounded budget.
 *
 * Every candidate is resolved and required to be inside `root` first. The
 * reported ones are the agent's own JSON, so an absolute path or a `..` is
 * whatever the model wrote, and a file outside the repository says nothing
 * about this service however instrumented it is.
 *
 * Returns the first file found to start TraceRoot, spelled as it was given, or
 * `null` when none of them does.
 */
export function findTraceRootInitialization(
  root: string,
  service: DetectedService,
  alsoRead: readonly string[] = [],
): string | null {
  const dir = service.path === "." ? root : join(root, service.path);
  const candidates: Array<{ display: string; path: string }> = [];
  const entry = serviceEntryPath(service);
  if (entry !== null && service.entryPoint !== null) {
    candidates.push({ display: entry, path: join(dir, service.entryPoint) });
  }
  for (const file of alsoRead) {
    if (isAbsolute(file)) {
      candidates.push({ display: file, path: file });
      continue;
    }
    candidates.push({ display: file, path: join(root, file) });
    // The second resolution only when it is a second file. A root service's
    // directory *is* the repository root, so pushing both reads every reported
    // file twice — and walks a reported directory twice, under a file budget
    // that is meant to be one.
    if (dir !== root) {
      candidates.push({ display: file, path: join(dir, file) });
    }
  }

  for (const candidate of expandDirectories(
    candidates.filter((candidate) => withinRoot(root, candidate.path)),
  )) {
    // The same exclusion detection makes: a compiled bundle mentions
    // everything it ever imported, so reading one reports instrumentation that
    // is not in the source.
    if (isBuildArtifact(candidate.display)) {
      continue;
    }
    const source = readIfPresent(candidate.path);
    if (source !== null && initializesTraceRoot(source)) {
      return candidate.display;
    }
  }
  return null;
}

/**
 * Whether a resolved path is inside the repository.
 *
 * The repository, not the service directory: the candidates are deliberately
 * resolved against both roots, and a module shared between services is still
 * this service's instrumentation when its entry point imports it. What is
 * excluded is everything outside the tree the agent was given —
 * `/usr/lib/python3/site-packages/traceroot/__init__.py` certifies nothing, and
 * neither does `../sibling/app.py`.
 *
 * `root` itself passes: that is the candidate a root service's own directory
 * resolves to.
 */
function withinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Extensions worth opening when a whole directory has to be searched. */
const SOURCE_EXTENSIONS = [".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * How much of one directory is read: a handful of new files, never a tree walk.
 *
 * The thing being looked for is a module an agent just added, so the budget is
 * set where that is comfortably covered and an untracked `data/` or `fixtures/`
 * is not read file by file.
 */
const MAX_DIRECTORY_FILES = 64;
const MAX_DIRECTORY_DEPTH = 2;

/** Whether the path is a directory — absent or unreadable is not. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Source files beneath `dir`, as paths relative to it. */
function sourceFilesUnder(dir: string, depth = 0): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (depth >= MAX_DIRECTORY_DEPTH) {
        continue;
      }
      for (const nested of sourceFilesUnder(join(dir, entry.name), depth + 1)) {
        files.push(`${entry.name}/${nested}`);
        if (files.length >= MAX_DIRECTORY_FILES) {
          return files;
        }
      }
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      continue;
    }
    files.push(entry.name);
    if (files.length >= MAX_DIRECTORY_FILES) {
      return files;
    }
  }
  return files;
}

/**
 * The candidate list with every directory in it replaced by the source files
 * inside it.
 *
 * A reported path can be a directory, and reading one answers `null` however
 * instrumented its contents are. `git status --porcelain` is where they come
 * from: without `-uall` it reports a wholly untracked directory as the single
 * entry `src/telemetry/` rather than the files in it, so an initialization an
 * agent put in a new module arrives here as a directory name and the run was
 * failed as uninstrumented when it was not. (`-uall` on the status call would
 * fix the same thing by listing every file in every untracked directory, which
 * is what the setup report then says the run changed.)
 *
 * Anything that is not a directory is passed through untouched, including a
 * path that does not exist: the read is what answers for those.
 */
function expandDirectories(
  candidates: ReadonlyArray<{ display: string; path: string }>,
): Array<{ display: string; path: string }> {
  const expanded: Array<{ display: string; path: string }> = [];
  for (const candidate of candidates) {
    // The artifact test is first and short-circuits the stat: `node_modules/`
    // and `dist/` arrive here like any other untracked directory, and the loop
    // that reads these drops them on sight, so expanding one would readdir a
    // dependency tree to reach an answer already known.
    if (isBuildArtifact(candidate.display) || !isDirectory(candidate.path)) {
      expanded.push(candidate);
      continue;
    }
    const display = candidate.display.replace(/\/+$/, "");
    for (const file of sourceFilesUnder(candidate.path)) {
      // `.` is how a root service's own directory arrives, and `./main.py` is
      // not how anything else in the run spells that file.
      expanded.push({
        display: display === "." ? file : `${display}/${file}`,
        path: join(candidate.path, file),
      });
    }
  }
  return expanded;
}

/** Languages present in the repo that the CLI cannot instrument. */
function detectUnsupported(dirs: readonly string[]): string[] {
  const found = new Set<string>();
  // The same directories the service scan uses: a repository whose only project
  // is `services/api/go.mod` was reported as empty rather than as unsupported.
  for (const dir of dirs) {
    for (const [manifest, label] of UNSUPPORTED_MANIFESTS) {
      if (existsSync(join(dir, manifest))) {
        found.add(label);
      }
    }
  }
  return [...found].sort();
}

export interface DetectStackOptions {
  /** `--language`: narrows candidates before the ambiguity check. */
  language?: string;
  /** `--service`: selects a candidate by its repo-relative path. */
  service?: string;
}

/** Normalizes a `--language` value; `javascript` and `typescript` are both Node. */
export function normalizeLanguage(value: string): StackLanguage | null {
  const lowered = value.trim().toLowerCase();
  if (lowered === "python" || lowered === "py") {
    return "python";
  }
  if (lowered === "typescript" || lowered === "ts") {
    return "typescript";
  }
  if (lowered === "javascript" || lowered === "js" || lowered === "node") {
    return "javascript";
  }
  return null;
}

/**
 * Enumerates the candidate services in a repository and decides whether the
 * choice is unambiguous.
 *
 * Detection is by file presence and manifest content only — nothing is executed
 * — so this is safe to run in any directory and deterministic in tests.
 *
 * The key behaviour is that a repository with more than one candidate and no
 * disambiguating flag yields `ambiguous: true` and `selected: null`. Setup then
 * stops and asks, rather than instrumenting whichever service happened to sort
 * first: picking the wrong service produces a confident, wrong "success" that
 * costs far more than a question.
 */
export function detectStack(root: string, options: DetectStackOptions = {}): DetectedStack {
  const services: DetectedService[] = [];
  const seen = new Set<string>();

  const dirs = candidateDirs(root);
  for (const dir of dirs) {
    for (const candidate of [nodeService(dir, root), pythonService(dir, root)]) {
      if (candidate === null || seen.has(`${candidate.path}:${candidate.language}`)) {
        continue;
      }
      seen.add(`${candidate.path}:${candidate.language}`);
      services.push(candidate);
    }
  }

  const unsupportedLanguages = detectUnsupported(dirs);

  let candidates = services;

  // `--service` as a repo-relative path: `./api/` and `api` name one directory.
  const wanted =
    options.service === undefined
      ? undefined
      : options.service.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  if (wanted !== undefined) {
    candidates = candidates.filter((s) => s.path === wanted);
  }

  if (options.language !== undefined) {
    const language = normalizeLanguage(options.language);
    // `--language typescript` should also accept a plain-JavaScript service:
    // the user is naming an ecosystem, not asserting a compiler.
    candidates = candidates.filter((s) => {
      if (language === "python") {
        return s.language === "python";
      }
      if (language === null) {
        return false;
      }
      return s.language === "typescript" || s.language === "javascript";
    });
  }

  // The user named a directory that produced no service. Honour it when they
  // also said which language: `--service` is them answering, and refusing would
  // make the remedy other errors suggest impossible to follow. Without a
  // language there is nothing to guess from — inferring one from file
  // extensions is exactly the kind of guess that produces a confident, wrong
  // answer, so it is refused.
  if (wanted !== undefined && candidates.length === 0) {
    const language = normalizeLanguage(options.language ?? "");
    if (language !== null) {
      const asserted = assertedService(root, wanted, language);
      if (asserted !== null) {
        candidates = [asserted];
      }
    }
  }

  const selected = candidates.length === 1 ? (candidates[0] ?? null) : null;

  // Scoped to what is about to be instrumented, not to the repository.
  //
  // Asking "does anything here use TraceRoot?" is the wrong question: one
  // instrumented service made every *other* service look already done, so the
  // agent was told the work was finished and wrote nothing. The question is
  // whether the chosen target is wired up.
  const existingInstrumentation = detectExistingInstrumentation(
    root,
    selected === null ? candidates : [selected],
  );

  return {
    root,
    services: candidates,
    ambiguous: selected === null && candidates.length > 1,
    selected,
    unsupportedLanguages,
    existingInstrumentation,
  };
}
