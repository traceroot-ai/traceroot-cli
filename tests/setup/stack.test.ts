import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectStack, findTraceRootInitialization } from "../../src/setup/stack.js";

/** Every root this file makes, so none is left behind in the system tmpdir. */
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "traceroot-stack-"));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return root;
}

describe("identifying the framework from a package.json", () => {
  it("matches a dependency by name, not as a substring of one", () => {
    // The table's `ai` entry is the Vercel AI SDK. Joining the names into one
    // string made it match `chai`, `tailwindcss` and `openai`, so a project with
    // any of those was reported as an AI SDK app and instrumented as one.
    const root = repo({
      "package.json": JSON.stringify({
        name: "app",
        main: "index.js",
        dependencies: { chai: "^5.0.0", tailwindcss: "^3.0.0", openai: "^4.0.0" },
      }),
      "index.js": "console.log(1)",
    });

    expect(detectStack(root).selected?.framework).toBeNull();
  });

  it("still matches the dependency the table is about", () => {
    const root = repo({
      "package.json": JSON.stringify({
        name: "app",
        main: "index.js",
        dependencies: { ai: "^3.0.0" },
      }),
      "index.js": "console.log(1)",
    });

    expect(detectStack(root).selected?.framework).not.toBeNull();
  });
});

describe("choosing a package manager", () => {
  it("ignores a lockfile from the other half of the repository", () => {
    // A root pnpm-lock.yaml says nothing about how a Python service beneath it
    // installs, and answering `pnpm` there costs the `uv add` it actually needs.
    // Deliberately NO python lockfile in the service: that is what forced the
    // fallback to the repository root, where the old shared table found
    // `pnpm-lock.yaml` and answered `pnpm` for a Python service — which also hid
    // the `requirements.txt` sitting right next to the manifest.
    const root = repo({
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "package.json": JSON.stringify({ name: "web", workspaces: ["api"] }),
      "api/pyproject.toml": "[project]\nname = 'api'\n",
      "api/requirements.txt": "flask\n",
      "api/main.py": "print(1)",
    });

    const api = detectStack(root, { service: "api" }).selected;
    expect(api?.language).toBe("python");
    expect(api?.packageManager).toBe("pip");
  });
});

describe("deciding a service is already instrumented", () => {
  it("does not count a bare initialize() from something else", () => {
    // `db.initialize()` and `sentry.initialize()` are ordinary lines in an entry
    // point. Treating one as evidence made setup skip instrumenting entirely.
    const root = repo({
      "pyproject.toml": "[project]\nname = 'api'\n",
      "main.py": "import sqlalchemy\ndb = sqlalchemy.create_engine('x')\ndb.initialize()\n",
    });

    expect(detectStack(root).existingInstrumentation.present).toBe(false);
  });

  it("counts a bare initialize() when the file imports traceroot", () => {
    // How the Python SDK is actually started: `from traceroot import initialize`.
    const root = repo({
      "pyproject.toml": "[project]\nname = 'api'\n",
      "main.py": "from traceroot import initialize\ninitialize()\n",
    });

    expect(detectStack(root).existingInstrumentation.present).toBe(true);
  });
});

describe("a repository the CLI cannot instrument", () => {
  it("reports an unsupported language found below the root", () => {
    // Scanning only the root reported a repository whose one project is
    // `services/api/go.mod` as empty, which reads as "nothing here" rather than
    // "nothing I can do".
    const root = repo({ "services/api/go.mod": "module example.com/api\n" });

    expect(detectStack(root).unsupportedLanguages).toContain("Go");
  });
});

describe("choosing a Node service's verification command", () => {
  /** Verbatim what `npm init` writes into a fresh package.json. */
  const NPM_INIT_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

  function nodeRepo(scripts: Record<string, string>): string {
    return repo({
      "package.json": JSON.stringify({ name: "app", main: "index.js", scripts }),
      "index.js": "console.log(1)",
    });
  }

  it("rejects the placeholder test script npm init writes", () => {
    // It is a non-empty string, so a presence check took it for the project's
    // own check — and verification then ran a command built to exit 1, reporting
    // "npm test failed after instrumentation" for a suite that never existed,
    // after the agent had already edited the repository.
    expect(detectStack(nodeRepo({ test: NPM_INIT_PLACEHOLDER })).selected?.testCommand).toBeNull();
  });

  it("rejects the placeholder however it was requoted or reflowed", () => {
    // Matching the generated string by equality is defeated by a stray space or
    // a change of quotes, which is why the match is on what makes it a
    // placeholder rather than on the string itself.
    const root = nodeRepo({ test: "echo  'Error:  No test specified'   &&  exit  1" });

    expect(detectStack(root).selected?.testCommand).toBeNull();
  });

  it("detects a real test script", () => {
    expect(detectStack(nodeRepo({ test: "vitest run" })).selected?.testCommand).toBe("npm test");
  });

  it("detects a real test script that itself exits non-zero", () => {
    // Half of the placeholder's signature. Exiting non-zero is what any failing
    // suite does; only saying there is no test to run makes a script a
    // placeholder, so both halves are required.
    const root = nodeRepo({ test: "jest --coverage || exit 1" });

    expect(detectStack(root).selected?.testCommand).toBe("npm test");
  });

  it("detects a real test script that is mostly the word test", () => {
    const root = nodeRepo({ test: "npm run test:unit && npm run test:e2e" });

    expect(detectStack(root).selected?.testCommand).toBe("npm test");
  });

  it("falls back to typecheck when the test script is the placeholder", () => {
    const root = nodeRepo({ test: NPM_INIT_PLACEHOLDER, typecheck: "tsc --noEmit" });

    expect(detectStack(root).selected?.testCommand).toBe("npm run typecheck");
  });

  it("ignores a script declared as an empty string", () => {
    // `npm run typecheck` with an empty script runs nothing and exits 0 — a
    // vacuous pass that would be reported as the application verifying.
    const root = nodeRepo({ test: NPM_INIT_PLACEHOLDER, typecheck: "   " });

    expect(detectStack(root).selected?.testCommand).toBeNull();
  });
});

describe("choosing a Python service's verification command", () => {
  it("runs pytest through Poetry in a Poetry project", () => {
    // Poetry's default environment is a hashed directory under its own cache,
    // which `detectPythonEnvironment` does not look at — so a bare `pytest` is
    // not on PATH there, and fails as "pytest was not found" about a pytest
    // that is installed.
    const root = repo({
      "pyproject.toml": "[tool.poetry.group.dev.dependencies]\npytest = '^8.0'\n",
      "poetry.lock": "",
      "main.py": "print(1)",
    });

    expect(detectStack(root).selected?.testCommand).toBe("poetry run pytest");
  });
});

describe("reading whether a service is wired up now", () => {
  /** The detected service, which is what the real caller has in hand. */
  function serviceIn(root: string) {
    const service = detectStack(root).selected;
    if (service === null) {
      throw new Error("the fixture produced no service to read");
    }
    return service;
  }

  it("looks inside a directory git reported as one untracked entry", () => {
    // `git status --porcelain` without `-uall` reports a wholly untracked
    // directory as `telemetry/` rather than the files in it, so that is the
    // spelling this is handed when an agent puts the initialization in a new
    // module — and reading it as a file answers null however instrumented the
    // module is, which failed runs that had worked.
    const root = repo({
      "pyproject.toml": '[project]\ndependencies = ["fastapi"]\n',
      "main.py": "import telemetry\n\nprint('hi')\n",
      "telemetry/tracing.py": "import traceroot\n\ntraceroot.initialize()\n",
    });

    expect(findTraceRootInitialization(root, serviceIn(root), ["telemetry/"])).toBe(
      "telemetry/tracing.py",
    );
  });

  it("does not certify a service from a compiled bundle in such a directory", () => {
    // The exclusion survives the expansion: a bundle mentions everything it
    // ever imported, so reading one reports instrumentation that is not in the
    // source.
    const root = repo({
      "pyproject.toml": '[project]\ndependencies = ["fastapi"]\n',
      "main.py": "print('hi')\n",
      "dist/bundle.js": "traceroot.initialize();\n",
    });

    expect(findTraceRootInitialization(root, serviceIn(root), ["dist/"])).toBeNull();
  });

  it("answers null for a directory that holds no initialization", () => {
    const root = repo({
      "pyproject.toml": '[project]\ndependencies = ["fastapi"]\n',
      "main.py": "print('hi')\n",
      "telemetry/tracing.py": "def start():\n    pass\n",
    });

    expect(findTraceRootInitialization(root, serviceIn(root), ["telemetry/"])).toBeNull();
  });

  it("does not certify a service from a build artifact named as a file", () => {
    // The directory spelling is covered above; this is the other one an agent
    // writes, and it takes a different path through the reading — the
    // build-artifact exclusion in the candidate loop rather than the one before
    // the directory walk. A bundle mentions everything it ever imported, so
    // reading it as evidence passes a service whose source holds nothing.
    const root = repo({
      "pyproject.toml": '[project]\ndependencies = ["fastapi"]\n',
      "main.py": "print('hi')\n",
      "dist/app.js": "traceroot.initialize();\n",
    });

    expect(findTraceRootInitialization(root, serviceIn(root), ["dist/app.js"])).toBeNull();
  });

  it("refuses an absolute path outside the repository", () => {
    // `alsoRead` carries the agent's own JSON, read as given. An installed copy
    // of the SDK initializes TraceRoot in its own tests and examples, and it is
    // not this service's instrumentation.
    const root = repo({
      "pyproject.toml": '[project]\ndependencies = ["fastapi"]\n',
      "main.py": "print('hi')\n",
    });
    const elsewhere = repo({ "app.py": "import traceroot\n\ntraceroot.initialize()\n" });

    expect(
      findTraceRootInitialization(root, serviceIn(root), [join(elsewhere, "app.py")]),
    ).toBeNull();
  });

  it("refuses a relative path that climbs out of the repository", () => {
    // The same thing without an absolute path: `join(root, "../x")` lands
    // outside the tree the agent was given.
    const root = repo({
      "pyproject.toml": '[project]\ndependencies = ["fastapi"]\n',
      "main.py": "print('hi')\n",
    });
    const sibling = join(root, "..", "sibling-app.py");
    writeFileSync(sibling, "import traceroot\n\ntraceroot.initialize()\n");
    try {
      expect(findTraceRootInitialization(root, serviceIn(root), ["../sibling-app.py"])).toBeNull();
    } finally {
      rmSync(sibling, { force: true });
    }
  });

  it("still reads a module the service shares with the rest of the repository", () => {
    // Contained means inside the repository, not inside the service directory.
    // A monorepo service whose entry point imports a shared package is
    // instrumented by a call in that package, and the two roots the candidates
    // are resolved against exist precisely so that path can be found.
    const root = repo({
      "apps/api/pyproject.toml": '[project]\ndependencies = ["fastapi"]\n',
      "apps/api/main.py": "from shared import tracing\n\nprint('hi')\n",
      "shared/tracing.py": "import traceroot\n\ntraceroot.initialize()\n",
    });
    const service = detectStack(root).services.find((s) => s.path === "apps/api");
    if (service === undefined) {
      throw new Error("the fixture produced no apps/api service");
    }

    expect(findTraceRootInitialization(root, service, ["shared/tracing.py"])).toBe(
      "shared/tracing.py",
    );
  });
});
