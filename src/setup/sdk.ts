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
          // Quoted: a repository path routinely contains spaces, and this one
          // is pasted into a shell by an agent.
          return `"${pythonInterpreter}" -m pip install ${pep440}`;
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
