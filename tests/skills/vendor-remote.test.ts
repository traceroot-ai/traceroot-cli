import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs build script, deliberately not part of the tsc project.
import { SKILLS_REMOTE, parseGitRemote } from "../../scripts/skills-vendor.mjs";

// scripts/refresh-skills.mjs records `owner/repo` and nothing else, and the
// provenance check downstream only requires that value to be a non-empty
// string. So `parseGitRemote` has to report the host as well: every host serves
// its own `traceroot-ai/traceroot-skills` for the asking, and a refresh run
// against one of those would otherwise record the canonical name for bytes it
// did not serve.

const canonical = `${SKILLS_REMOTE.host}/${SKILLS_REMOTE.repository}`;

/** `host/owner/repo` for a remote URL, or "refused" when it cannot be read. */
function identity(url: string): string {
  const remote = parseGitRemote(url);
  return remote === null ? "refused" : `${remote.host}/${remote.repository}`;
}

describe("parseGitRemote", () => {
  it("reads the forms git hands out for the canonical remote", () => {
    for (const url of [
      "https://github.com/traceroot-ai/traceroot-skills.git",
      "https://github.com/traceroot-ai/traceroot-skills",
      "https://github.com/traceroot-ai/traceroot-skills/",
      "git@github.com:traceroot-ai/traceroot-skills.git",
      "ssh://git@github.com/traceroot-ai/traceroot-skills.git",
      "ssh://git@github.com:22/traceroot-ai/traceroot-skills.git",
      "git://github.com/traceroot-ai/traceroot-skills.git",
      "https://x-access-token:TOKEN@github.com/traceroot-ai/traceroot-skills.git",
      "https://GitHub.com/traceroot-ai/traceroot-skills.git",
    ]) {
      expect(identity(url), url).toBe(canonical);
    }
  });

  it("separates a spoofed host from the canonical owner/repo", () => {
    // The slug is identical in all three; only the host tells them apart.
    expect(identity("https://attacker.example/traceroot-ai/traceroot-skills.git")).toBe(
      "attacker.example/traceroot-ai/traceroot-skills",
    );
    expect(identity("git@evil.test:traceroot-ai/traceroot-skills.git")).toBe(
      "evil.test/traceroot-ai/traceroot-skills",
    );
    expect(identity("https://github.com.evil.test/traceroot-ai/traceroot-skills.git")).toBe(
      "github.com.evil.test/traceroot-ai/traceroot-skills",
    );
  });

  it("takes the authority a fetch would use, not the one the URL reads like", () => {
    // Userinfo runs to the last `@`, so this resolves to evil.test — as curl
    // and git would resolve it — rather than to github.com.
    expect(identity("https://github.com@evil.test/traceroot-ai/traceroot-skills.git")).toBe(
      "evil.test/traceroot-ai/traceroot-skills",
    );
  });

  it("refuses rather than guessing at a URL it cannot resolve", () => {
    for (const url of [
      "../traceroot-skills",
      "/Users/me/traceroot-skills",
      "ssh://git@[::1]/traceroot-ai/traceroot-skills.git",
      "file:///Users/me/traceroot-ai/traceroot-skills",
      "https://github.com",
      "a@b@github.com:traceroot-ai/traceroot-skills.git",
      "",
    ]) {
      expect(identity(url), url).toBe("refused");
    }
  });

  it("does not read a local path as the canonical remote", () => {
    // A Windows path looks scp-like, so it parses to something. That something
    // is not github.com, which is all this has to be.
    expect(identity("C:/clones/traceroot-ai/traceroot-skills")).not.toBe(canonical);
  });
});
