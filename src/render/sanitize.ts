/**
 * Removes terminal control sequences and remaining C0/C1 controls from
 * untrusted text before it is written by a human-readable renderer.
 *
 * ANSI styling owned by the CLI is applied after this boundary, so it is
 * preserved while control sequences supplied by API data remain inert.
 */
export function sanitizeTerminalText(value: string): string {
  // OSC sequences can carry hyperlinks or terminal commands. Remove the whole
  // sequence, including its payload, before stripping any remaining controls.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is intentional.
  const withoutOsc = value.replace(
    /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g,
    "",
  );
  // CSI sequences include cursor movement, screen clearing and SGR styling.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is intentional.
  const withoutCsi = withoutOsc.replace(
    /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g,
    "",
  );
  // Preserve readable separation while preventing untrusted text from adding lines or tabs.
  const normalizedWhitespace = withoutCsi.replace(/[\r\n\t]+/g, " ");
  // Remove any remaining C0, DEL or C1 controls (including incomplete escapes).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the intent.
  return normalizedWhitespace.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}
