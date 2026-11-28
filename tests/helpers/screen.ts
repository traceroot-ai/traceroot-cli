import { stripVTControlCharacters } from "node:util";

/** Erase the row the cursor is on. */
const ERASE = "\x1b[2K";

/** The sequence the progress line erases its row with: erase the row, back to column 0. */
export const CLEAR_LINE = `${ERASE}\r`;

/**
 * What a terminal shows after `output` is written to it, one string per row, with color removed.
 *
 * It follows only what the progress line and a runner's plain output use: erase the row (`ESC[2K`),
 * back to column 0 (`\r`), a new row (`\n`), and text, which overwrites from the cursor. Any other
 * escape sequence is dropped, so the rows hold the text as a reader sees it. A row the progress line
 * erased and left reads as an empty row.
 */
export function screen(output: string): string[] {
  const rows: string[][] = [[]];
  let column = 0;
  let text = "";
  const put = (): void => {
    const row = rows[rows.length - 1] as string[];
    for (const char of stripVTControlCharacters(text)) {
      row[column] = char;
      column += 1;
    }
    text = "";
  };
  for (let index = 0; index < output.length; index += 1) {
    if (output.startsWith(ERASE, index)) {
      put();
      (rows[rows.length - 1] as string[]).length = 0;
      index += ERASE.length - 1;
    } else if (output[index] === "\r") {
      put();
      column = 0;
    } else if (output[index] === "\n") {
      put();
      rows.push([]);
      column = 0;
    } else {
      text += output[index];
    }
  }
  put();
  return rows.map((row) => Array.from(row, (char) => char ?? " ").join(""));
}

/**
 * Each frame the progress line drew in `output`, as a reader sees it: the text written after each
 * erase, up to the next newline, with color removed. Runner output written above the line starts
 * with an erase too, and shows up here as its first line.
 */
export function frames(output: string): string[] {
  return output
    .split(CLEAR_LINE)
    .slice(1)
    .map((part) => stripVTControlCharacters(part.split("\n")[0] ?? ""));
}
