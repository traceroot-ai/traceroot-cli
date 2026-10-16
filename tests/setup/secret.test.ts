import { describe, expect, it } from "vitest";
import { makeSecret, redact } from "../../src/setup/secret.js";

describe("a secret holder", () => {
  it("cannot have its serialization guarantee removed", () => {
    // The module's headline promise is that serializing any structure holding a
    // secret is a hard error. Reassigning `toJSON` from outside was the one way
    // to switch that off.
    const secret = makeSecret("tr-a-long-enough-value");
    expect(() => {
      (secret as { toJSON: () => unknown }).toJSON = () => "leaked";
    }).toThrow();
    expect(() => JSON.stringify({ secret })).toThrow();
  });
});

describe("redacting child-process output", () => {
  it("does not let a shorter secret break a longer one's match", () => {
    // Substituting the short one first would consume the prefix and leave the
    // longer credential's tail in the text — the result must not depend on the
    // order the caller happened to pass them in.
    const short = makeSecret("tr-abcdefgh");
    const long = makeSecret("tr-abcdefgh-ijklmnop");
    const text = `key=${long.reveal()}`;

    for (const secrets of [
      [short, long],
      [long, short],
    ]) {
      const out = redact(text, secrets);
      expect(out).toBe("key=<redacted>");
      expect(out).not.toContain("ijklmnop");
    }
  });

  it("leaves anything too short to be a credential alone", () => {
    // A short value is likelier to be a substring of ordinary output than a
    // secret, so redacting it would scrub text that is not sensitive.
    expect(redact("say tiny please", [makeSecret("tiny")])).toBe("say tiny please");
  });
});
