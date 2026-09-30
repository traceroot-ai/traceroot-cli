import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectStack } from "../../src/setup/stack.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "traceroot-stack-"));
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
