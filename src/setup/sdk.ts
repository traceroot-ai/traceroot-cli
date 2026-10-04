import type { DetectedService, StackLanguage } from "./types.js";

/**
 * Package to install per language/framework. Mastra apps get the dedicated
 * integration package; everything else gets the core SDK.
 */
export interface SdkPackage {
  /** Registry name, e.g. `@traceroot-ai/traceroot`. */
  name: string;
  registry: "npm" | "pypi";
}

/**
 * Last-known-good versions, shipped with the CLI. These are the fallback when
 * the registry is unreachable — setup degrades to a slightly stale pin rather
 * than failing. A stale pin still produces a working, reproducible install; a
 * failed setup produces nothing.
 */
const FALLBACK_VERSIONS: Readonly<Record<string, string>> = {
  traceroot: "0.0.4",
  "@traceroot-ai/traceroot": "0.0.4",
  "@traceroot-ai/mastra": "0.0.4",
};

/** Chooses the package a service should install. */
export function sdkPackageFor(service: DetectedService): SdkPackage {
  if (service.language === "python") {
    return { name: "traceroot", registry: "pypi" };
  }
  if (service.framework === "mastra") {
    return { name: "@traceroot-ai/mastra", registry: "npm" };
  }
  return { name: "@traceroot-ai/traceroot", registry: "npm" };
}

export interface ResolveSdkVersionDeps {
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A resolved, pinnable SDK version and where the number came from. */
export interface ResolvedSdk {
  package: string;
  version: string;
  source: "registry" | "bundled";
}

function isVersionString(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+/.test(value);
}

/**
 * Resolves the exact version to pin.
 *
 * Delegating this to the agent, which would install whatever is current, makes
 * two runs of the same command produce different installs. Setup resolves a
 * concrete version here and puts the literal string in the task, so the
 * instrumentation is reproducible and the version appears in the checkpoint.
 *
 * Never throws: a registry that is slow, offline or rate-limiting falls back to
 * the bundled pin.
 */
export async function resolveSdkVersion(
  pkg: SdkPackage,
  deps: ResolveSdkVersionDeps = {},
): Promise<ResolvedSdk> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const fallback: ResolvedSdk = {
    package: pkg.name,
    version: FALLBACK_VERSIONS[pkg.name] ?? "latest",
    source: "bundled",
  };

  const url =
    pkg.registry === "npm"
      ? `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`
      : `https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/json`;

  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: deps.signal ?? AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    if (!res.ok) {
      return fallback;
    }
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) {
      return fallback;
    }
    const version =
      pkg.registry === "npm"
        ? (body as { version?: unknown }).version
        : (body as { info?: { version?: unknown } }).info?.version;
    if (!isVersionString(version)) {
      return fallback;
    }
    return { package: pkg.name, version, source: "registry" };
  } catch {
    return fallback;
  }
}

/** How to prove the SDK is importable, paired with {@link installCommand}. */
export interface ImportCheck {
  program: string;
  args: string[];
  /** How to name the interpreter in a failure message, e.g. `poetry run python`. */
  display: string;
  /** The module asked for, which is not always the distribution name. */
  module: string;
}

/**
 * The command that proves {@link installCommand} actually landed.
 *
 * It lives beside the install deliberately. The two have to agree about *where*
 * the package goes, and they are easy to let drift: `poetry add` installs into
 * Poetry's own environment, which for a project without an in-project
 * virtualenv is a directory under Poetry's cache that no amount of looking
 * beside the service will find. A probe of the system interpreter then rejects
 * a perfectly successful install — worse than not checking at all. Adding a
 * package manager to one function and not the other is now visibly wrong.
 *
 * Per manager:
 *
 * - `poetry` — asked through `poetry run python`, which executes in the
 *   project's environment wherever Poetry put it. `poetry run` does not
 *   install, so it reports on the environment rather than changing it.
 * - `uv` — the located interpreter. `uv add` puts the environment at `.venv`
 *   in the project directory, which is exactly where `detectPythonEnvironment`
 *   looks. `uv run` is deliberately *not* used: it syncs the environment first
 *   (hence its `--no-sync`), so it would install the package it is supposed to
 *   be checking for and always succeed.
 * - `pip` and no manager at all — the located interpreter, falling back to
 *   `python3`, which is the interpreter the install command itself names.
 *
 * Returns null when there is nothing to check. JavaScript and TypeScript are
 * unverified **by design**, for all four of `npm`, `pnpm`, `yarn` and `bun`:
 * proving a package resolves means reproducing Node's algorithm across
 * hoisting, workspaces, pnpm's symlinked store, Yarn PnP — which has no
 * `node_modules` to look in at all — and an exports map that can refuse a
 * CommonJS require of a working install. Every one of those failure modes
 * rejects a working install, and a check that does that costs more than the
 * silence it replaces.
 */
export function importCheck(
  sdk: ResolvedSdk,
  service: DetectedService,
  /** The virtualenv interpreter found for this service, if any. */
  pythonInterpreter: string | null,
): ImportCheck | null {
  if (service.language !== "python") {
    return null;
  }
  // A distribution name is not always an import name: PyPI allows a `-` where
  // Python requires `_`, and `import a-b` is a syntax error rather than a
  // missing module, which would fail every run instead of the broken ones.
  const module = sdk.package.replaceAll("-", "_");
  const code = `import ${module}`;
  if (service.packageManager === "poetry") {
    return {
      program: "poetry",
      args: ["run", "python", "-c", code],
      display: "poetry run python",
      module,
    };
  }
  const interpreter = pythonInterpreter ?? "python3";
  return { program: interpreter, args: ["-c", code], display: interpreter, module };
}

/** The install command an agent should run, with the version pinned exactly. */
export function installCommand(
  sdk: ResolvedSdk,
  service: DetectedService,
  language: StackLanguage = service.language,
  /**
   * A virtualenv interpreter to install into, when one was found. Without it
   * the command falls back to `python3 -m pip`, which fails outright on a
   * PEP 668 "externally managed" Python — see `python.ts`.
   */
  pythonInterpreter: string | null = null,
): string {
  const pinned = sdk.version === "latest" ? sdk.package : `${sdk.package}@${sdk.version}`;
  if (language === "python") {
    const pep440 = sdk.version === "latest" ? sdk.package : `${sdk.package}==${sdk.version}`;
    switch (service.packageManager) {
      case "uv":
        return `uv add ${pep440}`;
      case "poetry":
        return `poetry add ${pep440}`;
      default:
        if (pythonInterpreter !== null) {
          // Single-quoted, with any `'` closed and re-opened around an escaped
          // one: a repository path routinely contains spaces, and this string is
          // pasted into a shell by an agent, where `$`, a backtick or a `"` inside
          // double quotes would be expanded rather than taken literally.
          return `'${pythonInterpreter.replaceAll("'", "'\\''")}' -m pip install ${pep440}`;
        }
        // `python3 -m pip`, never bare `pip`. A Homebrew or pyenv Python
        // installs `pip3` and `pip3.14` and no `pip` at all, so the bare form
        // exits 127 on a machine where installing is perfectly possible. An
        // agent handed that command reads "command not found" as the
        // environment refusing it and spends the run trying to get around a
        // wall that is not there. The module form works wherever `python3` does, which
        // for a Python service is guaranteed.
        return `python3 -m pip install ${pep440}`;
    }
  }
  switch (service.packageManager) {
    case "pnpm":
      return `pnpm add ${pinned}`;
    case "yarn":
      return `yarn add ${pinned}`;
    case "bun":
      return `bun add ${pinned}`;
    default:
      return `npm install ${pinned}`;
  }
}
