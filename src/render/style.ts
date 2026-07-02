import { type Sink, colorEnabled } from "../output.js";

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_YELLOW = "\x1b[33m";
// OSC 8 hyperlink: OSC 8 ; ; <url> ST <text> OSC 8 ; ; ST (ST = ESC \).
const OSC8_OPEN = "\x1b]8;;";
const OSC8_ST = "\x1b\\";

/** Applies emphasis to text, no-op when color is disabled. */
export interface Styler {
  /** Bold/bright emphasis (used for labels and table headers). */
  bold(text: string): string;
  /** Dim de-emphasis (used for secondary detail such as IDs and links/URLs). */
  dim(text: string): string;
  /** Yellow emphasis for warnings. */
  warn(text: string): string;
  /**
   * Renders `url` as an OSC 8 terminal hyperlink whose visible text is `text`
   * (defaulting to the URL itself), clickable in terminals that support OSC 8.
   * When emphasis is disabled, returns the visible text with no escapes so
   * piped/`NO_COLOR` output stays a plain, copyable URL.
   */
  link(url: string, text?: string): string;
}

/**
 * Builds a {@link Styler} for the given sink. Emphasis is applied only when
 * {@link colorEnabled} is true for that sink (a TTY with `NO_COLOR` unset);
 * otherwise every method returns its input unchanged, keeping piped/`NO_COLOR`
 * output free of ANSI escapes. Centralizing this here lets `status`, `traces
 * list`, and `traces get` share one color-discipline-aware styler.
 */
export function createStyler(sink: Sink, env: NodeJS.ProcessEnv = process.env): Styler {
  const on = colorEnabled(sink, env);
  const wrap =
    (code: string) =>
    (text: string): string =>
      on ? `${code}${text}${ANSI_RESET}` : text;
  return {
    bold: wrap(ANSI_BOLD),
    dim: wrap(ANSI_DIM),
    warn: wrap(ANSI_YELLOW),
    link: (url: string, text?: string): string => {
      const label = text ?? url;
      return on ? `${OSC8_OPEN}${url}${OSC8_ST}${label}${OSC8_OPEN}${OSC8_ST}` : label;
    },
  };
}
