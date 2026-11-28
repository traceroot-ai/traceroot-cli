/**
 * Fitting text to a terminal: how many columns a string takes, prose wrapped at word boundaries
 * with a hanging indent, and how wide the terminal a sink writes to is.
 *
 * Only a terminal wraps a long line, so only a terminal's width is fitted to: a pipe or a file gets
 * every line whole, as it always has. A word is never split, so a command, a URL or a path that is
 * one word stays whole and copyable; one wider than the terminal runs past the edge on its own
 * line, where the terminal's own soft wrap keeps it one line when copied.
 */

import { stripVTControlCharacters } from "node:util";
import type { Sink } from "../output.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Code points a terminal draws two columns wide: East Asian wide and fullwidth forms. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

/**
 * How many columns `text` takes on a terminal. Escape sequences take none, a combining mark or a
 * zero-width character none, and a wide character or an emoji two.
 */
export function displayWidth(text: string): number {
  let columns = 0;
  for (const { segment } of graphemes.segment(stripVTControlCharacters(text))) {
    columns += graphemeWidth(segment);
  }
  return columns;
}

function graphemeWidth(grapheme: string): number {
  const code = grapheme.codePointAt(0) ?? 0;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
    return 0;
  }
  if (code < 0x300) {
    return 1;
  }
  if (EMOJI_PRESENTATION.test(grapheme) || grapheme.includes("️")) {
    return 2;
  }
  if (WIDE_RANGES.some(([low, high]) => code >= low && code <= high)) {
    return 2;
  }
  return ZERO_WIDTH.test(grapheme) ? 0 : 1;
}

/** `text` padded with spaces to `width` columns. */
export function padDisplay(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * How wide the terminal `sink` writes to is, or undefined when it isn't a terminal or doesn't say:
 * nothing then gets fitted, and every line prints whole.
 */
export function terminalColumns(sink: Sink): number | undefined {
  if (sink.isTTY !== true) {
    return undefined;
  }
  const { columns } = sink as { columns?: number };
  return columns !== undefined && columns > 0 ? columns : undefined;
}

/**
 * Greedy word wrap of `text` to `width` columns. Words are split on single spaces and never
 * broken, so a word wider than `width` takes a line of its own and runs past it. A space inside one
 * of `whole`, such as a path with a space in it, splits nothing.
 */
export function wrapWords(text: string, width: number, whole: readonly string[] = []): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of splitWords(text, whole)) {
    if (current === "") {
      current = word;
    } else if (displayWidth(`${current} ${word}`) <= width) {
      current = `${current} ${word}`;
    } else {
      pieces.push(current);
      current = word;
    }
  }
  if (current !== "") {
    pieces.push(current);
  }
  return pieces;
}

/** `text` split at single spaces, except a space inside an occurrence of one of `whole`. */
function splitWords(text: string, whole: readonly string[]): string[] {
  if (whole.length === 0) {
    return text.split(" ");
  }
  const kept = new Set<number>();
  for (const span of whole.filter((item) => item !== "")) {
    for (let at = text.indexOf(span); at !== -1; at = text.indexOf(span, at + span.length)) {
      for (let i = at; i < at + span.length; i += 1) {
        kept.add(i);
      }
    }
  }
  const words: string[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || (text[i] === " " && !kept.has(i))) {
      words.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return words;
}

/** How far a wrapped line's continuation lines sit in from its first. */
const HANG = 2;

/**
 * One line of prose, wrapped to `width` columns: the line's own indent stays on the first line,
 * and every continuation line sits {@link HANG} columns further in, so a wrapped sentence reads as
 * one item. It never breaks inside one of `whole` (see {@link wrapWords}). With no width, the line
 * is returned whole.
 */
export function wrapLine(
  line: string,
  width: number | undefined,
  whole: readonly string[] = [],
): string[] {
  if (width === undefined || displayWidth(line) <= width) {
    return [line];
  }
  const indent = /^ */.exec(line)?.[0] ?? "";
  const hang = `${indent}${" ".repeat(HANG)}`;
  const [first = "", ...rest] = wrapWords(line.slice(indent.length), width - indent.length, whole);
  const continued = rest.length === 0 ? [] : wrapWords(rest.join(" "), width - hang.length, whole);
  return [`${indent}${first}`, ...continued.map((piece) => `${hang}${piece}`)];
}

/** Each of `lines` wrapped with {@link wrapLine}. */
export function wrapLines(lines: readonly string[], width: number | undefined): string[] {
  return lines.flatMap((line) => wrapLine(line, width));
}

/**
 * Items joined with `separator` and filled greedily into lines of `width` columns: an item is
 * never split across lines unless it is wider than a line on its own, when its words wrap. The
 * first line starts with `indent`; the rest sit {@link HANG} columns further in.
 */
export function wrapItems(
  items: readonly string[],
  width: number | undefined,
  { indent = "", separator = " · " }: { indent?: string; separator?: string } = {},
): string[] {
  const whole = `${indent}${items.join(separator)}`;
  if (width === undefined || displayWidth(whole) <= width) {
    return [whole];
  }
  const hang = `${indent}${" ".repeat(HANG)}`;
  const lines: string[] = [];
  let current = "";
  const prefix = (): string => (lines.length === 0 ? indent : hang);
  for (const item of items) {
    if (current !== "" && displayWidth(`${prefix()}${current}${separator}${item}`) <= width) {
      current = `${current}${separator}${item}`;
      continue;
    }
    if (current !== "") {
      lines.push(`${prefix()}${current}`);
      current = "";
    }
    if (displayWidth(`${prefix()}${item}`) <= width) {
      current = item;
    } else {
      const pieces = wrapWords(item, width - hang.length);
      const last = pieces.pop() ?? "";
      for (const piece of pieces) {
        lines.push(`${prefix()}${piece}`);
      }
      current = last;
    }
  }
  if (current !== "") {
    lines.push(`${prefix()}${current}`);
  }
  return lines;
}
