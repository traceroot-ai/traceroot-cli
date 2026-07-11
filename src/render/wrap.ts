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
 *    continuation lines align under the item's text rather than the marker;
 *    indented source lines directly under a bullet are folded into that item.
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

/** A run of same-emphasis characters within a {@link Word}. */
interface Piece {
  plain: string;
  bold: boolean;
}

/**
 * One wrappable unit: a maximal run of non-whitespace characters. A word can
 * span emphasis boundaries (e.g. `(**timeout**),` is one word of three pieces:
 * `(`, bold `timeout`, `),`), so punctuation glued to a bold span in the source
 * stays glued in the output. `length` is the visible (unstyled) width.
 */
interface Word {
  pieces: Piece[];
  length: number;
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

/**
 * Splits inline-tokenized text into words. Whitespace in the SOURCE is the only
 * word boundary: an emphasis edge with no whitespace around it (e.g.
 * `**Note**:` or `pre**bold**post`) continues the current word, so no space is
 * invented next to punctuation when the pieces are rejoined.
 */
function toWords(text: string): Word[] {
  const words: Word[] = [];
  let pieces: Piece[] = [];

  const flushWord = (): void => {
    if (pieces.length > 0) {
      words.push({ pieces, length: pieces.reduce((n, p) => n + p.plain.length, 0) });
      pieces = [];
    }
  };

  for (const token of tokenizeInline(text)) {
    // Split into alternating whitespace / non-whitespace runs (both kept):
    // whitespace ends the current word; a non-whitespace run extends it.
    for (const run of token.text.split(/(\s+)/)) {
      if (run === "") {
        continue;
      }
      if (/^\s/.test(run)) {
        flushWord();
      } else {
        pieces.push({ plain: run, bold: token.bold });
      }
    }
  }
  flushWord();
  return words;
}

/** Renders a word's pieces, applying `style` to the bold ones. */
function renderWord(word: Word, style: StyleFn): string {
  return word.pieces.map((p) => (p.bold ? style(p.plain) : p.plain)).join("");
}

/** A copy of `word` with every piece marked bold (for headings). */
function boldWord(word: Word): Word {
  return { pieces: word.pieces.map((p) => ({ ...p, bold: true })), length: word.length };
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
    lines.push(prefix + current.map((w) => renderWord(w, style)).join(" "));
    current = [];
    currentLen = contPrefix.length;
  };

  for (const word of words) {
    const sep = current.length === 0 ? 0 : 1;
    if (current.length > 0 && currentLen + sep + word.length > safeWidth) {
      flush();
    }
    current.push(word);
    currentLen += (current.length === 1 ? 0 : 1) + word.length;
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
/** An in-progress list item: its marker prefixes plus accumulated text lines. */
interface OpenListItem {
  firstPrefix: string;
  contPrefix: string;
  text: string[];
}

export function wrapMarkdown(text: string, width: number, bold: StyleFn = (s) => s): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let listItem: OpenListItem | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    const joined = paragraph.join(" ").trim();
    out.push(...fillLines(toWords(joined), width, bold, "", ""));
    paragraph = [];
  };

  const flushListItem = (): void => {
    if (listItem === null) {
      return;
    }
    const joined = listItem.text.join(" ").trim();
    out.push(...fillLines(toWords(joined), width, bold, listItem.firstPrefix, listItem.contPrefix));
    listItem = null;
  };

  // At most one of paragraph / listItem is open at a time; flush both at any
  // block boundary (blank line, heading, new bullet).
  const flushBlocks = (): void => {
    flushParagraph();
    flushListItem();
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      flushBlocks();
      out.push("");
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushBlocks();
      const words = toWords((heading[2] ?? "").trim()).map(boldWord);
      out.push(...fillLines(words, width, bold, "", ""));
      continue;
    }

    const marker = LIST_ITEM_RE.exec(line);
    if (marker) {
      flushBlocks();
      const firstPrefix = `${marker[1] ?? ""}${marker[2] ?? ""} `;
      listItem = {
        firstPrefix,
        contPrefix: " ".repeat(firstPrefix.length),
        text: [marker[3] ?? ""],
      };
      continue;
    }

    // An indented line directly under an open bullet continues that item, so
    // it keeps the item's hanging indent instead of falling out flush-left.
    if (listItem !== null && /^\s/.test(line)) {
      listItem.text.push(line.trim());
      continue;
    }

    flushListItem();
    paragraph.push(line.trim());
  }
  flushBlocks();

  return out.join("\n");
}
