import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli.js";
import { createFakeFetch, jsonResponse } from "../helpers/fakeFetch.js";
import { StringSink } from "../helpers/stringSink.js";

/**
 * Pins finding 4 of the final review: `withProjectScope` (src/registry/
 * execute.ts) must inject the default project into every project-scoped read
 * but leave account-scope discovery (`workspaces list`, `projects list`)
 * alone, since those tools don't declare `project_id` in their own input
 * schema. Uses the real, shipped placements (not a test fixture) because this
 * is exactly the production command surface the finding is about.
 *
 * Exercises the full CLI under session (browser-login) auth — the only
 * credential kind that ever carries a default project — via `TRACEROOT_TOKEN`
 * and a faked mint response for `POST {authHost}/api/cli/token`.
 */
describe("account-scope discovery is not scoped to the default project", () => {
  function harness(responses: Record<string, unknown>) {
    const fake = createFakeFetch((call) => {
      if (call.url.includes("/api/cli/token")) {
        return jsonResponse({ accessToken: "jwt-access", expiresIn: 600 });
      }
      for (const [needle, body] of Object.entries(responses)) {
        if (call.url.includes(needle)) return jsonResponse(body);
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const out = new StringSink();
    const err = new StringSink();
    const program = buildProgram({
      registry: { fetchImpl: fake.fetchImpl, writers: { out, err } },
    });
    const run = async (...argv: string[]) => {
      const previous = process.env.TRACEROOT_TOKEN;
      process.env.TRACEROOT_TOKEN = "sess-token";
      try {
        await program.parseAsync(
          [
            "--host",
            "https://api.test",
            "--auth-host",
            "https://api.test",
            "--project",
            "p-1",
            "--json",
            ...argv,
          ],
          { from: "user" },
        );
      } finally {
        if (previous === undefined) {
          // biome-ignore lint/performance/noDelete: restoring an env var; assigning undefined would stringify it
          delete process.env.TRACEROOT_TOKEN;
        } else process.env.TRACEROOT_TOKEN = previous;
      }
    };
    return { fake, out, err, run };
  }

  // The dispatch call is whichever fetch isn't the token mint.
  function dispatchUrl(fake: { calls: { url: string }[] }): string {
    const dispatched = fake.calls.find((c) => !c.url.includes("/api/cli/token"));
    if (dispatched === undefined) throw new Error("no dispatch call recorded");
    return dispatched.url;
  }

  it("workspaces list does not carry project_id", async () => {
    const h = harness({ "/workspaces": { data: [] } });
    await h.run("workspaces", "list");
    expect(dispatchUrl(h.fake)).not.toContain("project_id");
  });

  it("projects list does not carry project_id", async () => {
    const h = harness({ "/projects": { data: [] } });
    await h.run("projects", "list");
    expect(dispatchUrl(h.fake)).not.toContain("project_id");
  });

  it("positive counterpart: traces list still carries project_id", async () => {
    const h = harness({ "/traces": { data: [] } });
    await h.run("traces", "list");
    expect(dispatchUrl(h.fake)).toContain("project_id=p-1");
  });
});
