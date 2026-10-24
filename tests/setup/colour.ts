const ESC = "\u001b";
/** SGR only: every `\u001b[…m` sequence, and nothing else. */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/**
 * Drops colour from rendered output, leaving the characters untouched.
 *
 * These assertions are about wording, layout and the rail — not about how the
 * text is drawn. Colour is decided by the environment, and CI sets
 * `FORCE_COLOR`, so the same renderer emits SGR codes there and plain text in a
 * local pipe. Comparing stripped output is what makes one assertion hold in both
 * places.
 *
 * OSC 8 hyperlinks are deliberately left alone: whether a URL is wrapped in one
 * is behaviour the suite asserts on directly.
 */
export function plain(text: string): string {
  return text.replace(SGR, "");
}
