/**
 * Secrets are carried in an opaque holder rather than as bare strings, so that
 * serializing any structure that contains one is a hard error instead of a
 * silent leak. The classification is by *type*, not by field name, which means
 * a new field carrying a credential cannot accidentally end up in the
 * checkpoint or in `--json` output
 * just because nobody remembered to add its name to a deny-list.
 *
 * The only way to read a secret is {@link Secret.reveal}, which is deliberately
 * greppable: `rg '\.reveal\(\)'` enumerates every place a credential is used.
 */

/** Thrown when something tries to serialize a {@link Secret}. */
export class SecretSerializationError extends Error {
  constructor() {
    super("refusing to serialize a secret value");
    this.name = "SecretSerializationError";
  }
}

/** An opaque credential. Safe to hold, log the `hint` of, and pass around. */
export interface Secret {
  /** Deliberate extraction of the plaintext value. */
  reveal(): string;
  /** Non-secret display form, e.g. `tr-…a1b2`. Safe everywhere. */
  readonly hint: string;
  /** Always throws — a secret must never be JSON-serialized. */
  toJSON(): never;
}

/**
 * Builds the display hint for a credential: a short prefix, an ellipsis, and at
 * most the last four characters. Short values are reduced to a fixed mask so a
 * secret can never be reconstructed from its own hint.
 */
export function secretHint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return "…";
  }
  const prefix = trimmed.slice(0, 3);
  const suffix = trimmed.slice(-4);
  return `${prefix}…${suffix}`;
}

/** Wraps a plaintext credential. The value is held in a closure, not a field. */
export function makeSecret(value: string): Secret {
  const hint = secretHint(value);
  return {
    reveal: () => value,
    hint,
    toJSON(): never {
      throw new SecretSerializationError();
    },
  };
}

/**
 * Last-resort redaction for text that may embed a credential (a child process's
 * captured output, a transport error message). Mirrors the redaction already
 * applied in `api/client.ts`, but for an arbitrary set of secrets.
 *
 * This is a safety net, not the primary defence: secrets are kept out of these
 * strings by construction. Very short values are ignored, since substituting
 * them would corrupt unrelated text.
 */
export function redact(text: string, secrets: readonly Secret[]): string {
  let out = text;
  for (const secret of secrets) {
    const raw = secret.reveal();
    if (raw.length < 8) {
      continue;
    }
    out = out.split(raw).join("<redacted>");
  }
  return out;
}
