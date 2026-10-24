import { afterEach, beforeEach, vi } from "vitest";

/**
 * Runs every test in the calling file with `FORCE_COLOR` cleared.
 *
 * Colour is decided from the environment as well as from the sink: `FORCE_COLOR`
 * means "paint anyway, whatever you are writing to, because I can render it",
 * and a test runner is one of the callers that says so. Assertions that name
 * exact characters — a table's columns, the wizard's rail, a bare `error:` line,
 * the absence of an escape on a sink that is not a terminal — are about layout,
 * wording and colour discipline rather than about a runner's own preference, so
 * they state the environment they are read in instead of inheriting it.
 *
 * Narrower than stripping the escapes back out, which is what the setup suite
 * does where the subject really is painted output (see `tests/setup/colour.ts`):
 * stripping would make "contains no escape" vacuous, and those are exactly the
 * assertions worth keeping literal. What `FORCE_COLOR` itself does is asserted
 * directly, against `colorEnabled`, in `tests/output.test.ts`.
 */
export function withoutForcedColor(): void {
  beforeEach(() => {
    vi.stubEnv("FORCE_COLOR", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}
