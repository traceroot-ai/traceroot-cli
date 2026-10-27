import { describe, expect, it } from "vitest";
import { buildSetupTask, manualInstructions } from "../../src/setup/task.js";
import type { DetectedService } from "../../src/setup/types.js";

const SDK = { package: "@traceroot-ai/traceroot", version: "1.2.3", source: "registry" as const };

function service(overrides: Partial<DetectedService> = {}): DetectedService {
  return {
    path: ".",
    language: "python",
    framework: null,
    entryPoint: "main.py",
    packageManager: "pip",
    testCommand: null,
    evidence: [],
    ...overrides,
  } as unknown as DetectedService;
}

function task(overrides: Record<string, unknown> = {}): string {
  return buildSetupTask({
    service: service(),
    root: "/repo",
    sdk: SDK,
    skillPath: ".claude/skills/traceroot-instrument-repo",
    verifyCommand: null,
    interactive: false,
    existingInstrumentation: [],
    // The channel the hard rules describe. Empty is the degraded case — no file
    // holds the key, so the agent's environment carries it — and the tests that
    // are about the channel name it themselves.
    credentialFiles: [],
    ...overrides,
  });
}

describe("naming the interpreter the service runs on", () => {
  it("names a service-local virtualenv from the service's own directory", () => {
    const text = task({
      service: service({ path: "api" }),
      pythonInterpreter: "/repo/api/.venv/bin/python",
    });
    expect(text).toContain("./.venv/bin/python main.py");
    // Explicitly: not the parent's. `"../.venv/…"` contains `"./.venv/…"`, so the
    // assertion above passes on the wrong answer without this one.
    expect(text).not.toContain("../.venv/bin/python");
  });

  it("climbs exactly once for a root virtualenv from a nested service", () => {
    // The old version repeated `../` per path segment against a string it had
    // already stripped to a tail, so the depth and the path disagreed.
    const text = task({
      service: service({ path: "api" }),
      pythonInterpreter: "/repo/.venv/bin/python",
    });
    expect(text).toContain("../.venv/bin/python main.py");
    expect(text).not.toContain("../../.venv/bin/python");
  });

  it("keeps an interpreter outside the repository absolute", () => {
    const text = task({
      service: service({ path: "api" }),
      pythonInterpreter: "/opt/homebrew/bin/python3",
    });
    expect(text).toContain("/opt/homebrew/bin/python3 main.py");
  });
});

describe("the run line for a service that is not Python", () => {
  it("runs a TypeScript entry point with tsx, not a Python interpreter", () => {
    const text = task({
      service: service({ language: "typescript", entryPoint: "src/index.ts" }),
    });
    expect(text).toContain("npx tsx src/index.ts");
    expect(text).not.toContain("python3 src/index.ts");
  });

  it("runs a JavaScript entry point with node", () => {
    const text = task({ service: service({ language: "javascript", entryPoint: "index.js" }) });
    expect(text).toContain("node index.js");
  });

  it("does not offer a Python virtualenv recovery to a Node service", () => {
    // The PEP 668 paragraph was gated on "no virtualenv was found", which is
    // always true for a Node service — so it was told to build one.
    const text = task({ service: service({ language: "typescript", entryPoint: "src/index.ts" }) });
    expect(text).not.toContain("externally-managed-environment");
    expect(text).not.toContain("python3 -m venv");
  });
});

describe("the snippet the agent is told to paste", () => {
  it("imports the package the installer actually installs", () => {
    const text = task({ service: service({ language: "typescript", entryPoint: "src/index.ts" }) });
    expect(text).toContain('from "@traceroot-ai/traceroot"');
    expect(text).not.toContain("traceroot-sdk-ts");
  });
});

describe("the env file the entry point is told to load", () => {
  // `detectEnvFiles` names the file relative to the service directory, and the
  // instruction used to repeat that path verbatim. The application is not run
  // from the service directory, though: `python api/main.py` from the
  // repository root resolved `"./.env"` against the root, loaded nothing, and
  // raised nothing — python-dotenv treats a missing file as a no-op — so
  // tracing was silently off behind a line that looked correct.
  it("resolves the app's env file against the entry point, not the working directory", () => {
    const text = task({ service: service({ path: "api" }), envFiles: ["./.env"] });
    expect(text).toContain('load_dotenv(Path(__file__).resolve().parent / ".env")');
    expect(text).not.toContain('load_dotenv("./.env")');
  });

  it("climbs out of a nested entry point's own directory to reach it", () => {
    const text = task({
      service: service({ path: "api", entryPoint: "src/main.py" }),
      envFiles: ["./.env"],
    });
    expect(text).toContain('load_dotenv(Path(__file__).resolve().parent / "../.env")');
    expect(text).not.toContain('/ ".env")');
  });

  it("keeps the climb a repository-root env file already carries", () => {
    // `detectEnvFiles` names the root's `.env` as `../.env` from a nested
    // service, and the entry point sits at that service's root.
    const text = task({ service: service({ path: "api" }), envFiles: ["../.env"] });
    expect(text).toContain('load_dotenv(Path(__file__).resolve().parent / "../.env")');
    expect(text).not.toContain('load_dotenv("../.env")');
  });

  it("imports pathlib everywhere it emits the load", () => {
    // Step 3's snippet and step 6's reminder both emit the call. Either one
    // handing the agent a `Path` it never imported is a NameError on first run.
    const text = task({ envFiles: ["./.env"] });
    expect(text.split("load_dotenv(Path(").length - 1).toBe(2);
    expect(text.split("from pathlib import Path").length - 1).toBe(2);
  });

  it("emits no load, and no pathlib import, when no env file was found", () => {
    const text = task();
    expect(text).not.toContain("load_dotenv");
    expect(text).not.toContain("from pathlib import Path");
  });

  it("does not hand a Node service a Python loader", () => {
    const text = task({
      service: service({ language: "typescript", entryPoint: "src/index.ts" }),
      envFiles: ["./.env"],
    });
    expect(text).toContain('from "dotenv"');
    expect(text).not.toContain("load_dotenv");
    expect(text).not.toContain("from pathlib import Path");
  });

  it("resolves a Node service's env file against the entry point too", () => {
    // `import "dotenv/config"` resolves `.env` against `process.cwd()`, so the
    // instruction above it — load from inside the entry point, not from
    // wherever the app was started — was contradicted by its own example.
    const text = task({
      service: service({ language: "typescript", entryPoint: "src/index.ts" }),
      envFiles: ["./.env"],
    });
    expect(text).toContain('config({ path: new URL("../.env", import.meta.url) })');
    expect(text).not.toContain('import "dotenv/config"');
  });

  it("does not show a Node service its load at module scope either", () => {
    // Step 3 moved the Python pair into the entry point's guard; this is the
    // same instruction's Node half, which would otherwise show the load running
    // on import — the thing that put four test-suite traces in the UI.
    const text = task({
      service: service({ language: "typescript", entryPoint: "src/index.ts" }),
      envFiles: ["./.env"],
    });
    expect(text).toContain("async function main() {");
    expect(text).toContain('\n  config({ path: new URL("../.env", import.meta.url) })');
    expect(text).not.toMatch(/\nconfig\(\{ path:/);
  });

  it("names the env file the credential is actually in, for a Node service", () => {
    // `chooseCredentialEnvFile` writes into an existing `.env.local`, and
    // `dotenv/config` reads `.env` and only `.env` — so the application started
    // with no TraceRoot credential, which is unrecoverable once the key is no
    // longer in the agent's own environment either.
    const text = task({
      service: service({ language: "javascript", entryPoint: "index.js" }),
      envFiles: ["./.env.local", "./.env"],
    });
    expect(text).toContain('config({ path: new URL(".env.local", import.meta.url) })');
  });

  it("does not measure a path from an entry point detection never found", () => {
    // The fallback assumed the entry point sat at the service root. A nested one
    // then loaded `.env` from its own directory, found nothing, and raised
    // nothing — so the run spent its whole trace timeout before reporting that
    // the instrumented path never ran.
    for (const language of ["python", "typescript"] as const) {
      const text = task({
        service: service({ language, entryPoint: null }),
        envFiles: ["./.env"],
      });
      expect(text).toContain("<path from this file to the env file>");
      expect(text).toContain("That path is a placeholder");
      expect(text).not.toContain('/ ".env")');
      expect(text).not.toContain('new URL(".env"');
    }
  });
});

describe("where the task says the agent's own credential is", () => {
  it("names the file when a file the application loads holds the key", () => {
    // `buildAgentEnv` withholds the variable over the same answer, so a rule
    // that still claimed the key was in the environment would send an agent
    // whose SDK reports no credential to report that rather than to check the
    // load that would fix it.
    const text = task({ envFiles: ["./.env"], credentialFiles: ["/repo/.env"] });

    expect(text).toContain("`TRACEROOT_API_KEY` is **not** in your environment");
    expect(text).not.toContain("is already set in your environment");
  });

  it("still tells an agent that does hold the key in its environment so", () => {
    // No file holds it — git tracks the one setup would have written, or the
    // key came out of the user's own shell — so the environment is the channel,
    // and sending that agent after a file would send it after one that holds
    // nothing.
    const text = task({ envFiles: ["./.env"], credentialFiles: [] });

    expect(text).toContain("is already set in your environment");
    expect(text).not.toContain("**not** in your environment");
  });
});

describe("the definition of done", () => {
  it("promises no output the SDK does not produce", () => {
    // The step used to quote a `[traceroot] trace <id> → <url>` line and call
    // seeing it "the confirmation". Neither SDK prints it — `flush()` returns
    // without writing anything — so the only stop condition the step offered
    // was one that could never be met, and an agent hunting for it re-ran the
    // application until it gave up. A run cost three full invocations.
    const text = task({ envFiles: ["./.env"] });
    expect(text).not.toContain("[traceroot] trace");
    expect(text).not.toContain("Seeing that line is the confirmation");
    expect(text).not.toMatch(/the SDK prints/i);
  });

  it("says the silence is expected and a second run proves nothing", () => {
    const text = task({ envFiles: ["./.env"] });
    expect(text).toContain("There is no confirmation line to wait for");
    expect(text).toContain("do not run the application again to go looking");
  });

  it("leaves confirming the trace to the poll, and keeps the agent off the API", () => {
    const text = task({ envFiles: ["./.env"] });
    expect(text).toContain("Confirming the trace is not your job");
    expect(text).toContain("traces list");
    expect(text).toContain("traces get");
  });

  it("treats a null trace id as the ordinary outcome", () => {
    // The field stays, because an application that logs its own trace id is
    // worth hearing about. What changed is that null is no longer framed as
    // the exception.
    const text = task({ envFiles: ["./.env"] });
    expect(text).toContain("that is the normal answer");
  });
});

describe("the span coverage the task asks for", () => {
  it("states a bar for each boundary a run has, not a licence to stop at one span", () => {
    // A run against an agent application that ran its own tool loop produced a
    // single span on the entrypoint and nothing else: no tool spans, no
    // dispatch span, no session attributes. Nothing in the task stated a
    // coverage standard, while three things pushed the other way — "the minimum
    // wiring", "add manual spans only at boundaries auto-instrumentation
    // misses", and a step headed "add manual spans only where
    // auto-instrumentation cannot reach" — so the narrowest reading was the
    // compliant one.
    const text = task();
    expect(text).toContain("One outermost span around a single logical run");
    expect(text).toContain("One span per model call");
    expect(text).toContain("One span per tool this application's own code calls");
    expect(text).toContain("so does the step that dispatches between");
    expect(text).toContain("One span per external call that nothing else instruments");
  });

  it("leaves a tool the framework calls alone, instead of doubling its span", () => {
    // The bar is a branch, not a number. Most of the published examples register
    // their tools with a framework that traces tool execution itself, and they
    // carry exactly one span on purpose — one of them says so in a comment: "the
    // framework already traces tool execution, so decorating would double it
    // up". An unconditional span per tool would be wrong for those.
    const text = task();
    expect(text).toContain("**No span on a tool a framework calls for you.**");
    expect(text).toContain("produces two spans for one call");
    expect(text).toContain("One span and the attributes is the whole job for an application");
  });

  it("gives one checkable question for deciding who owns the tool loop", () => {
    // Whatever the rule is, the agent has to be able to apply it from the
    // source in front of it, without running anything or reading a trace.
    const text = task();
    expect(text).toContain("does a line in this repository\ncall the tool function?");
    expect(text).toContain("the only mention of the function is its registration");
  });

  it("sends an undecidable case toward the thinner trace, not the doubled one", () => {
    const text = task();
    expect(text).toContain("If you cannot tell, leave the tools undecorated");
    expect(text).toContain("a doubled span misreports what the application did");
  });

  it("asks for user and session attributes unconditionally", () => {
    // Every published example that traces an application attaches them — it is
    // the one thing that does not vary with the application's shape — so this
    // is not conditional on inferring a "user concept" from the code.
    const text = task();
    expect(text).toContain("**User and session attributes, always.**");
    expect(text).toContain("not\n  whether to attach them");
    expect(text).not.toContain("where the application has either concept");
  });

  it("no longer offers finishing after initialization as the good outcome", () => {
    const text = task();
    expect(text).not.toContain("you are done after step 3");
    expect(text).not.toContain("One or two is normal");
    expect(text).not.toMatch(/Auto-instrumentation is the goal, not the floor/);
    expect(text).not.toMatch(/only where auto-instrumentation cannot reach/);
    expect(text).not.toMatch(/manual spans only at boundaries auto-instrumentation misses/);
  });

  it("separates what a provider's integration covers from a framework's", () => {
    // The rule that used to prefer auto-instrumentation "over hand-written
    // spans" read as covering the whole trace, and the replacement for it
    // read as covering only the model calls. Which it is depends on the
    // integration: a provider's covers its own calls, an agent framework's
    // covers the tool loop too, and that is the whole reason step 4 branches.
    const text = task();
    expect(text).toContain("a model provider's integration covers the calls");
    expect(text).toContain("nothing about the structure around them");
    expect(text).toContain("also covers the tool calls and the loop that makes them");
    expect(text).toContain("The integrations you enabled in step 3 already emit these");
  });

  it("limits the files touched without limiting what the trace covers", () => {
    // Both halves matter: the surface-area rule is legitimate and stays, so
    // the bar has to say which of the two it is bounding.
    const text = task();
    expect(text).toContain("Touch the fewest files that can work");
    expect(text).toContain("not how much of the run the trace covers");
  });

  it("keeps the bar on boundaries rather than on lines", () => {
    // The opposite failure is real: a decorator per function makes a trace
    // nobody can read and bills the user for the spans.
    const text = task();
    expect(text).toContain("Spans go on boundaries, not on lines");
    expect(text).toContain("Helpers, pure functions, parsers, formatters and loop bodies");
    expect(text).toContain('"What to instrument"');
  });

  it("names the span kinds, since one span type for everything reads as one layer", () => {
    const text = task();
    expect(text).toContain("a tool is `tool`");
  });

  it("points at the skill's table for user and session context instead of restating it", () => {
    // Duplicating the table here would be a second copy to drift. Pointing at
    // it only works if the agent is still allowed to read that step, which is
    // what the carve-out in step 1 preserves — the step otherwise tells it
    // that the skill's steps 1-3 were done before it started.
    const text = task();
    expect(text).toContain("table in the skill's analyse step is for deciding what the values are");
    expect(text).toContain("setup does not know whether this application");
    // Not a copy of the table's own rows.
    expect(text).not.toContain("conversation history");
    expect(text).not.toContain("multi-turn app");
  });

  it("asks for the same coverage of a service that is not Python", () => {
    // The bar is language-independent prose, and a Node service reaches it
    // through a different branch of the template.
    const text = task({
      service: service({ language: "typescript", entryPoint: "src/index.ts" }),
    });
    expect(text).toContain("One span per tool this application's own code calls");
    expect(text).toContain("Spans go on boundaries, not on lines");
  });
});

describe("how the task has the agent run the project's tests", () => {
  it("runs the suite with TraceRoot switched off, in the command itself", () => {
    // A plain `pytest` sends a trace per test whenever a key is within reach —
    // the agent's own environment, or an entry point that loads its `.env` at
    // module scope — and those traces land beside the application's. The
    // variable is in the command, not in a sentence the agent may skim past.
    expect(task({ verifyCommand: "pytest" })).toContain(
      "Run `TRACEROOT_ENABLED=false pytest` once",
    );
    expect(task({ verifyCommand: "npm test" })).toContain(
      "Run `TRACEROOT_ENABLED=false npm test` once",
    );
    expect(task()).toContain("with `TRACEROOT_ENABLED=false` in front of it");
  });

  it("says the trace setup looks for comes from running the application", () => {
    for (const text of [task({ verifyCommand: "pytest" }), task()]) {
      expect(text).toContain("by running the application itself as step 6 says");
      expect(text).toContain("The trace `traceroot setup` looks for is the application's own");
    }
  });

  it("asks for no report of a run without credentials", () => {
    // The task tells the agent not to make that run, and setup makes its own
    // check with TraceRoot off. A field asking for its result invites the run.
    expect(task()).not.toContain("tests_passed_without_credentials");
  });
});

describe("where the task puts initialization", () => {
  it("puts the credential load and the initialize call on the run path, not at module scope", () => {
    // Module scope runs on import. A project whose test suite imports the
    // entry point then loads the credential and starts the SDK once per test
    // process, and every test that touches an instrumented function exports a
    // trace of its own — each one looking exactly like the application's.
    const text = task({ envFiles: ["./.env"] });
    expect(text).toContain('if __name__ == "__main__":');
    expect(text).toContain('\n    load_dotenv(Path(__file__).resolve().parent / ".env")');
    expect(text).toContain("\n    traceroot.initialize(integrations=[Integration.ANTHROPIC])");
    // Not at the left margin, which is where the snippet used to show it.
    expect(text).not.toMatch(/\ntraceroot\.initialize\(/);
    expect(text).not.toMatch(/\nload_dotenv\(/);
  });

  it("drops the import-order claim that kept initialization at module scope", () => {
    // The snippet could not move while the prose said initialization had to
    // precede the provider import: the two requirements only conflict if that
    // one is true. Auto-instrumentation patches the provider's own methods, so
    // it is not.
    const text = task({ envFiles: ["./.env"] });
    expect(text).not.toContain("must come after initialize()");
    expect(text).not.toContain("Initialize TraceRoot before the LLM/agent libraries are imported");
    expect(text).not.toMatch(/after those imports will silently\ncapture nothing/);
    expect(text).toContain("The order that matters is not the import order");
    expect(text).toContain("whether or not that library has already been imported");
  });

  it("says why module scope is the problem: the test suite imports the entry point", () => {
    const text = task({ envFiles: ["./.env"] });
    expect(text).toContain("Module scope runs on import, and a project's test suite imports its");
  });

  it("warns that an instrumented call starts the SDK and a later initialize is ignored", () => {
    // This is why "initialize lazily, from the entry function" is not the
    // answer: a decorated entry function starts the SDK before its own body
    // runs, and the initialize inside it is then skipped, integrations and all.
    const text = task({ envFiles: ["./.env"] });
    expect(text).toContain("starts the SDK itself when nothing");
    expect(text).toContain("is skipped with a warning");
  });

  it("keeps the guard in the snippet when there is no env file to load", () => {
    const text = task();
    expect(text).toContain('if __name__ == "__main__":');
    expect(text).toContain("\n    traceroot.initialize(integrations=[Integration.ANTHROPIC])");
    expect(text).not.toContain("load_dotenv");
  });

  it("does not hand a Node service the Python import guard", () => {
    const text = task({
      service: service({ language: "typescript", entryPoint: "src/index.ts" }),
      envFiles: ["./.env"],
    });
    expect(text).not.toContain("__main__");
    expect(text).toContain("the function the entry point calls to start itself");
  });

  it("stops offering the test suite as the thing that emits the trace", () => {
    // Step 6 listed "a test" among the ways to produce one. The suite runs with
    // TraceRoot switched off now, and the trace setup looks for is the one the
    // application sends — so that route would have the agent prove the trace
    // with the one path that is meant to send nothing.
    const text = task({ envFiles: ["./.env"] });
    expect(text).not.toContain("a test, a script, one function call");
    expect(text).toContain(
      "test suite is\nnot one of those things: it runs with TraceRoot switched off",
    );
  });

  it("does not claim the guard alone keeps the tests from exporting", () => {
    // It does not. `observe` starts the SDK whenever `TRACEROOT_API_KEY` is in
    // the environment, and a real run's suite exported every test it ran with
    // `initialize()` correctly under the guard. The placement rule stays; the
    // promise that it was enough goes.
    const text = task({ envFiles: ["./.env"] });
    expect(text).not.toContain("the tests stop\nexporting without touching them");
    expect(text).not.toContain("loads no credential and starts no SDK");
    expect(text).toContain(
      "the run path does not on its own keep the project's tests from exporting",
    );
    expect(text).toContain('if __name__ == "__main__":');
  });

  it("refuses the project's test configuration as the place to fix this", () => {
    // Editing someone's test setup to stop traces they did not ask for is a
    // larger intrusion than the entry-point edit, and it is unnecessary.
    const text = task({ envFiles: ["./.env"] });
    expect(text).toContain("conftest.py");
    expect(text).toContain("None of this belongs in the project's test configuration");
  });

  it("names the shapes where module scope is unavoidable, with the exporter off", () => {
    // Both are real and neither can move the load: a module a runner imports,
    // and an application that reads its own credentials while being imported.
    const text = task({ envFiles: ["./.env"] });
    expect(text).toContain("TRACEROOT_ENABLED=false");
    expect(text).toContain("initialize where the framework starts");
    expect(text).toContain("still being imported");
  });
});

describe("the manual steps", () => {
  function manual(overrides: Partial<Parameters<typeof manualInstructions>[0]> = {}): string {
    return manualInstructions({
      service: service({ testCommand: "pytest" }),
      sdk: SDK,
      skillPath: ".claude/skills/traceroot-instrument-repo",
      envFiles: ["./.env"],
      pythonInterpreter: null,
      ...overrides,
    });
  }

  it("load the env file and install into the venv for a pip service", () => {
    // Followed exactly, the old steps started the application without its key:
    // nothing loaded the file setup wrote it into, and `python3 -m pip` fails
    // on a PEP 668 Python with no venv active.
    const text = manual({
      sdk: { ...SDK, package: "traceroot" },
      pythonInterpreter: "/repo/.venv/bin/python",
    });
    expect(text).toContain(
      "'/repo/.venv/bin/python' -m pip install traceroot==1.2.3 python-dotenv",
    );
    expect(text).not.toContain("python3 -m pip");
    expect(text).not.toContain("CommonJS");
    expect(text).toContain("from dotenv import load_dotenv");
    expect(text).toMatch(
      /if __name__ == "__main__":\n\s+load_dotenv\(Path\(__file__\)\.resolve\(\)\.parent \/ "\.env"\)/,
    );
    // The agent's own snippet, so the two cannot drift apart again.
    expect(task({ envFiles: ["./.env"] })).toContain(
      'load_dotenv(Path(__file__).resolve().parent / ".env")',
    );
  });

  it("keep the snippet's trailing prose out of the code and say the provider is an example", () => {
    // Copied as shown, the block ended in an English sentence, and an
    // application on any other provider imported a library it doesn't use.
    const text = manual({ sdk: { ...SDK, package: "traceroot" } });
    expect(text).not.toContain("and, for a short-lived script only");
    expect(text).toMatch(/\n {11}main\(\)[^\n]*\n\n {5}Anthropic stands in for your provider/);
    expect(text).toContain("traceroot.flush() before it exits.");
    const ts = manual({
      service: service({
        language: "typescript",
        entryPoint: "src/index.ts",
        packageManager: "npm",
      }),
    });
    // Its own stand-in, named in `instrumentModules` rather than as an
    // `Integration` member the Node package does not have.
    expect(ts).toContain("OpenAI stands in for your provider");
    expect(ts).not.toContain("Anthropic stands in for your provider");
    expect(ts).toMatch(/\n {7}\}\n/);
  });

  it("load the env file and install dotenv for an npm TypeScript service", () => {
    const text = manual({
      service: service({
        language: "typescript",
        entryPoint: "src/index.ts",
        packageManager: "npm",
        testCommand: "npm test",
      }),
    });
    expect(text).toContain("npm install @traceroot-ai/traceroot@1.2.3 dotenv");
    expect(text).toContain('import { config } from "dotenv";');
    expect(text).toContain('config({ path: new URL("../.env", import.meta.url) });');
    expect(text).not.toContain("```");
    // The form above does not parse in a CommonJS entry point, and nothing
    // detected says which kind this one is, so the other form is named too.
    expect(text).toContain('give the same path as join(__dirname, "...")');
  });

  it("install no dotenv when there is no env file to load", () => {
    const text = manual({ sdk: { ...SDK, package: "traceroot" }, envFiles: [] });
    expect(text).not.toContain("dotenv");
    expect(text).toContain("python3 -m pip install traceroot==1.2.3\n");
  });
});

describe("the API each package's instructions name", () => {
  // Read from each package's source at the version setup pins when the
  // registry cannot be reached: `traceroot` 0.3.0, `@traceroot-ai/traceroot`
  // 0.5.0 and `@traceroot-ai/mastra` 0.1.1. The first two have the same
  // tracing names in 0.4.0 and 0.6.0, their current releases. Evaluation
  // exports are left out, because no instruction names one.
  //
  // The Node instructions used to be the Python SDK's — `Integration`,
  // `using_attributes`, a bare `initialize()` — under a line saying they were
  // verified against the Node package, and the Mastra ones imported from
  // `@traceroot-ai/traceroot`, which nothing had installed.
  const EXPORTS: Readonly<Record<string, readonly string[]>> = {
    traceroot: [
      "__version__",
      "initialize",
      "get_client",
      "flush",
      "shutdown",
      "observe",
      "TracerootClient",
      "Integration",
      "get_current_trace_id",
      "get_current_span_id",
      "update_current_span",
      "update_current_trace",
      "using_attributes",
    ],
    "@traceroot-ai/traceroot": [
      "TraceRoot",
      "initialize",
      "observe",
      "updateCurrentSpan",
      "updateCurrentTrace",
      "getCurrentTraceId",
      "getCurrentSpanId",
      "getCurrentSpan",
      "usingAttributes",
      "SpanAttributes",
      "OpenAIAgentsProcessor",
      "startSpan",
      "usingSpan",
      "instrumentPiAgentCore",
    ],
    "@traceroot-ai/mastra": ["TraceRootExporter"],
  };
  // The Node SDK's `flush` is a static on `TraceRoot`, not an export.
  const TRACEROOT_STATICS = [
    "initialize",
    "flush",
    "shutdown",
    "isInitialized",
    "isTracingActive",
    "resolveCredentials",
  ];
  const INSTRUMENT_MODULES = [
    "openAI",
    "anthropic",
    "langchain",
    "claudeAgentSDK",
    "bedrock",
    "typeSafe",
    "openaiAgents",
    "piCodingAgent",
    "piAgentCore",
  ];
  const INTEGRATION_MEMBERS = [
    "OPENAI",
    "ANTHROPIC",
    "LANGCHAIN",
    "GOOGLE_GENAI",
    "CREWAI",
    "OPENAI_AGENTS",
    "CLAUDE_AGENT_SDK",
    "LLAMA_INDEX",
    "AUTOGEN",
    "AGNO",
    "GROQ",
    "DSPY",
    "GOOGLE_ADK",
    "MISTRAL",
    "PYDANTIC_AI",
    "BEDROCK",
    "AGENT_FRAMEWORK",
  ];

  const variants = [
    {
      name: "Python",
      sdk: { ...SDK, package: "traceroot" },
      service: service({ testCommand: "pytest" }),
      // Each module the code imports that setup installs, with what step 1 of
      // the manual steps installs for it; then the ones the application has.
      installs: { traceroot: "traceroot==1.2.3", dotenv: "python-dotenv" },
      appModules: ["pathlib", "anthropic"],
    },
    {
      name: "TypeScript",
      sdk: SDK,
      service: service({
        language: "typescript",
        entryPoint: "src/index.ts",
        packageManager: "npm",
      }),
      installs: { "@traceroot-ai/traceroot": "@traceroot-ai/traceroot@1.2.3", dotenv: "dotenv" },
      appModules: ["openai"],
    },
    {
      name: "Mastra",
      sdk: { ...SDK, package: "@traceroot-ai/mastra" },
      service: service({
        language: "typescript",
        framework: "mastra",
        entryPoint: "src/index.ts",
        packageManager: "npm",
      }),
      installs: {
        "@traceroot-ai/mastra": "@traceroot-ai/mastra@1.2.3",
        dotenv: "dotenv",
        "@mastra/observability": "npm install @mastra/observability",
      },
      appModules: [],
    },
  ] as const;

  function render(variant: (typeof variants)[number]): { task: string; manual: string } {
    return {
      task: task({ service: variant.service, sdk: variant.sdk, envFiles: ["./.env"] }),
      manual: manualInstructions({
        service: variant.service,
        sdk: variant.sdk,
        skillPath: ".claude/skills/traceroot-instrument-repo",
        envFiles: ["./.env"],
        pythonInterpreter: null,
      }),
    };
  }

  /** Every `[module, name]` an `import { … } from` or a `from … import` brings in. */
  function importedNames(text: string): Array<[string, string]> {
    const found: Array<[string, string]> = [];
    for (const [, names = "", module = ""] of text.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g,
    )) {
      for (const name of names.split(",")) found.push([module, name.trim()]);
    }
    for (const [, module = "", names = ""] of text.matchAll(/^\s*from (\S+) import ([^#\n]+)/gm)) {
      for (const name of names.split(",")) found.push([module, name.trim()]);
    }
    return found.filter(([, name]) => name !== "");
  }

  /** Every module the text imports, in either language. */
  function importedModules(text: string): string[] {
    return [
      ...[...text.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]),
      ...[...text.matchAll(/^\s*from (\S+) import /gm)].map((m) => m[1]),
      // Python's bare `import x`; a Node default import carries a `from`.
      ...[...text.matchAll(/^\s*import ([\w.]+)[ \t]*(?:#.*)?$/gm)].map((m) => m[1]),
    ].filter((m): m is string => m !== undefined);
  }

  /** The words of the fenced block that follows `marker`. */
  function blockAfter(text: string, marker: string): string[] {
    const at = text.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const block = /```\n([\s\S]*?)```/.exec(text.slice(at))?.[1] ?? "";
    return block.split(/\s+/).filter((word) => word !== "");
  }

  /** The text from `start` up to the next `end`; both must be there. */
  function between(text: string, start: string, end: string): string {
    const from = text.indexOf(start);
    expect(from).toBeGreaterThan(-1);
    const to = text.indexOf(end, from);
    expect(to).toBeGreaterThan(from);
    return text.slice(from, to);
  }

  for (const variant of variants) {
    it(`imports only names the installed package exports, for ${variant.name}`, () => {
      for (const text of Object.values(render(variant))) {
        for (const [module, name] of importedNames(text)) {
          if (module in EXPORTS) {
            expect(module).toBe(variant.sdk.package);
            expect(EXPORTS[module]).toContain(name);
          }
        }
        for (const [, member = ""] of text.matchAll(/\bTraceRoot\.(\w+)\(/g)) {
          expect(TRACEROOT_STATICS).toContain(member);
        }
        for (const [, member = ""] of text.matchAll(/\btraceroot\.(\w+)\(/g)) {
          expect(EXPORTS.traceroot).toContain(member);
        }
        for (const [, member = ""] of text.matchAll(/\bIntegration\.(\w+)/g)) {
          expect(INTEGRATION_MEMBERS).toContain(member);
        }
        for (const [, keys = ""] of text.matchAll(/instrumentModules: \{([^}]*)\}/g)) {
          for (const key of keys.split(",")) {
            expect(INSTRUMENT_MODULES).toContain(key.split(":")[0]?.trim());
          }
        }
      }
    });

    it(`imports nothing the install step did not install, for ${variant.name}`, () => {
      const { task: text, manual } = render(variant);
      const installs: Readonly<Record<string, string>> = variant.installs;
      const appModules: readonly string[] = variant.appModules;
      for (const rendered of [text, manual]) {
        const imported = importedModules(rendered).filter((module) => !appModules.includes(module));
        expect(new Set(imported)).toEqual(new Set(Object.keys(installs)));
      }
      const step1 = between(manual, "\n  1. ", "\n  2. ");
      for (const install of Object.values(installs)) {
        expect(step1).toContain(install);
      }
      // The task's step 2 installs the SDK and any peer it needs; step 6 has the
      // agent add dotenv to the manifest once it imports it.
      const step2 = between(text, "### 2.", "### 3.");
      for (const [module, install] of Object.entries(installs)) {
        if (module === "dotenv") {
          expect(text).toContain("Add the dotenv package to the manifest if you import it.");
        } else {
          expect(step2).toContain(install);
        }
      }
    });
  }

  it("lists Python's Integration members and whole API only for Python", () => {
    const python = render(variants[0]).task;
    expect(python).toContain("That is the whole API you need");
    expect(python).toContain("`Integration` members, verified against `traceroot==1.2.3`");
    expect(blockAfter(python, "`Integration` members").sort()).toEqual(
      [...INTEGRATION_MEMBERS].sort(),
    );
    for (const variant of variants.slice(1)) {
      for (const text of Object.values(render(variant))) {
        expect(text).not.toContain("whole API");
        expect(text).not.toContain("verified against");
        expect(text).not.toMatch(/\bIntegration\b/);
      }
    }
  });

  it("names no Python-only file, function or server in a Node task", () => {
    for (const variant of variants.slice(1)) {
      const { task: text } = render(variant);
      for (const name of ["conftest.py", "pytest.ini", "using_attributes", "uvicorn", "gunicorn"]) {
        expect(text).not.toContain(name);
      }
    }
  });

  it("names the provider in instrumentModules and says what a bare initialize() does", () => {
    const { task: text, manual } = render(variants[1]);
    for (const rendered of [text, manual]) {
      expect(rendered).toContain(
        "TraceRoot.initialize({ instrumentModules: { openAI: OpenAI } });",
      );
      expect(rendered).not.toContain("  initialize();");
      expect(rendered).toContain("main();");
    }
    expect(text).toContain(
      "auto-instruments only modules loaded with `require()` — CommonJS — so in an ES module it\ninstruments nothing",
    );
    expect(manual).toContain("instrumentModules out and initialize() instruments only modules");
    expect(manual).toContain(
      "loaded with require() (CommonJS), so an ES module gets no model spans.",
    );
    expect(blockAfter(text, "The keys it takes in").sort()).toEqual([...INSTRUMENT_MODULES].sort());
  });

  it("puts Mastra's exporter on the application's Mastra instance", () => {
    const { task: text, manual } = render(variants[2]);
    for (const rendered of [text, manual]) {
      expect(rendered).toContain('import { TraceRootExporter } from "@traceroot-ai/mastra";');
      expect(rendered).toContain("exporters: [new TraceRootExporter()]");
      expect(rendered).not.toContain('"@traceroot-ai/traceroot"');
      // The exporter reads the key as it is constructed, so the load goes first.
      const load = rendered.indexOf("config({ path:");
      expect(load).toBeGreaterThan(-1);
      expect(load).toBeLessThan(rendered.indexOf("new TraceRootExporter()"));
    }
    // The file that constructs the instance is not one detection names.
    expect(text).toContain("<path from this file to the env file>");
    expect(text).toContain("there is no `initialize()` to call");
    expect(text).not.toContain("async function main()");
  });

  it("asks a Mastra service for no span the core SDK would have to write", () => {
    // Step 4's bar is met with `observe` and `usingAttributes`, which come from
    // a package a Mastra service does not install. Mastra traces the run
    // itself, so the step asks only for the user and the session, through
    // Mastra's own tracing metadata.
    const { task: text, manual } = render(variants[2]);
    for (const rendered of [text, manual]) {
      expect(rendered).not.toContain("observe(");
      expect(rendered).not.toContain("usingAttributes");
    }
    const step4 = text.slice(text.indexOf("### 4."), text.indexOf("### 5."));
    expect(step4).toContain("Write no spans by hand in this service");
    expect(step4).toContain("tracingOptions: { metadata: { userId, sessionId } }");
    expect(step4).not.toContain("One span per tool this application's own code calls");
    // Every other service keeps the span-by-span bar.
    for (const variant of variants.slice(0, 2)) {
      expect(render(variant).task).toContain("One span per tool this application's own code calls");
    }
  });
});
