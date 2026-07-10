/**
 * Width-aware text wrapping with minimal markdown treatment, for rendering
 * free-form text (e.g. an RCA result) that may contain light markdown from an
 * LLM. Pure string transform — no I/O, no width detection — so callers pass in
 * an explicit width (typically `process.stdout.columns ?? 80`) and a `bold`
 * styler (typically `createStyler(sink).bold`), keeping this testable without a
 * real TTY.
 *
 * Handled, deliberately minimally:
 *  - `# `..`###### ` headings: the `#` marker is stripped and the heading text
 *    is styled bold (or left plain when `bold` is a no-op).
 *  - `**bold**` spans: the `**` markers are stripped and the enclosed text is
 *    styled bold.
 *  - `` `code` `` spans: the backticks are stripped (left plain).
 *  - `-`/`*`/`1.`-style list items: wrapped with a hanging indent so
 *    continuation lines align under the item's text rather than the marker.
 *  - Plain paragraphs (consecutive non-blank, non-list, non-heading lines):
 *    joined and re-wrapped to `width`; blank lines are preserved as paragraph
 *    separators.
 *
 * Never emits a literal `#`/`**`/backtick marker for the constructs above.
 */

/** A styling function, e.g. `Styler["bold"]`; identity for plain-text output. */
export type StyleFn = (text: string) => string;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const BOLD_SPAN_RE = /\*\*(.+?)\*\*/g;
const CODE_SPAN_RE = /`([^`]+)`/g;

interface Word {
  plain: string;
  bold: boolean;
}

/** Strips inline code backticks (left plain) then splits `**bold**` spans out. */
function tokenizeInline(text: string): Array<{ text: string; bold: boolean }> {
  const noCode = text.replace(CODE_SPAN_RE, "$1");
  const tokens: Array<{ text: string; bold: boolean }> = [];
  let last = 0;
  for (const match of noCode.matchAll(BOLD_SPAN_RE)) {
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push({ text: noCode.slice(last, index), bold: false });
    }
    tokens.push({ text: match[1] ?? "", bold: true });
    last = index + match[0].length;
  }
  if (last < noCode.length) {
    tokens.push({ text: noCode.slice(last), bold: false });
  }
  return tokens;
}

/** Splits inline-tokenized text into individual words, each carrying its emphasis. */
function toWords(text: string): Word[] {
  const words: Word[] = [];
  for (const token of tokenizeInline(text)) {
    for (const plain of token.text.split(/\s+/)) {
      if (plain.length > 0) {
        words.push({ plain, bold: token.bold });
      }
    }
  }
  return words;
}

/**
 * Greedily fills lines up to `width` visible columns (ANSI escapes added by
 * `style` don't count toward width, since wrapping decisions use `plain`
 * lengths). `firstPrefix` prefixes the first output line (e.g. a list marker);
 * `contPrefix` prefixes every following line (e.g. matching spaces), so
 * continuation lines align under the first line's text.
 */
function fillLines(
  words: Word[],
  width: number,
  style: StyleFn,
  firstPrefix: string,
  contPrefix: string,
): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current: Word[] = [];
  let currentLen = firstPrefix.length;

  const flush = (): void => {
    const prefix = lines.length === 0 ? firstPrefix : contPrefix;
    lines.push(prefix + current.map((w) => (w.bold ? style(w.plain) : w.plain)).join(" "));
    current = [];
    currentLen = contPrefix.length;
  };

  for (const word of words) {
    const sep = current.length === 0 ? 0 : 1;
    if (current.length > 0 && currentLen + sep + word.plain.length > safeWidth) {
      flush();
    }
    current.push(word);
    currentLen += (current.length === 1 ? 0 : 1) + word.plain.length;
  }
  if (current.length > 0 || lines.length === 0) {
    flush();
  }
  return lines;
}

/**
 * Wraps `text` to `width` columns, applying minimal markdown styling (see
 * module doc). `bold` is applied to headings and `**bold**` spans; pass the
 * identity function for a plain-text (no-ANSI) fallback.
 */
export function wrapMarkdown(text: string, width: number, bold: StyleFn = (s) => s): string {
  const out: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    const joined = paragraph.join(" ").trim();
    out.push(...fillLines(toWords(joined), width, bold, "", ""));
    paragraph = [];
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      flushParagraph();
      out.push("");
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      const words = toWords((heading[2] ?? "").trim()).map((w) => ({ ...w, bold: true }));
      out.push(...fillLines(words, width, bold, "", ""));
      continue;
    }

    const listItem = LIST_ITEM_RE.exec(line);
    if (listItem) {
      flushParagraph();
      const [, indent, marker, rest] = listItem;
      const firstPrefix = `${indent ?? ""}${marker ?? ""} `;
      const contPrefix = " ".repeat(firstPrefix.length);
      out.push(...fillLines(toWords(rest ?? ""), width, bold, firstPrefix, contPrefix));
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();

  return out.join("\n");
}
