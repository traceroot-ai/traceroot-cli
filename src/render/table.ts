import { displayWidth, padDisplay, wrapItems, wrapWords } from "./wrap.js";

/** Optional behavior for {@link renderTable}. */
export interface RenderTableOptions {
  /**
   * Applied to the fully-padded header line. Column widths are computed from the
   * raw (unstyled) header text first, so adding ANSI codes here never disturbs
   * alignment. Defaults to identity (no styling).
   */
  headerStyle?: (line: string) => string;
  /**
   * Applied to each fully-padded data row line, given the row's index. Like
   * {@link headerStyle}, runs after width computation so ANSI codes never
   * disturb alignment. Defaults to identity.
   */
  rowStyle?: (line: string, rowIndex: number) => string;
}

/**
 * Renders a plain-text, column-aligned table. Each column is padded to the
 * widest cell (header or value) in that column. No external deps and fully
 * deterministic so stdout stays clean and stable; color, if any, is confined to
 * the header line via {@link RenderTableOptions.headerStyle}.
 */
export function renderTable(
  headers: string[],
  rows: string[][],
  options: RenderTableOptions = {},
): string {
  const headerStyle = options.headerStyle ?? ((line: string): string => line);
  const rowStyle = options.rowStyle ?? ((line: string): string => line);
  const widths = headers.map((header, col) => {
    let max = header.length;
    for (const row of rows) {
      const cell = row[col] ?? "";
      if (cell.length > max) {
        max = cell.length;
      }
    }
    return max;
  });

  const renderRow = (cells: string[]): string =>
    headers
      .map((_, col) => {
        const cell = cells[col] ?? "";
        const width = widths[col] ?? cell.length;
        // Do not pad the final column: trailing whitespace serves no purpose.
        return col === headers.length - 1 ? cell : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd();

  const lines = [
    headerStyle(renderRow(headers)),
    ...rows.map((row, i) => rowStyle(renderRow(row), i)),
  ];
  return lines.join("\n");
}

/** How {@link fitTable} fits a table to a terminal. */
export interface FitTableOptions extends RenderTableOptions {
  /** The columns available, or undefined to print the table whole, as {@link renderTable} does. */
  width: number | undefined;
  /** What each line starts with. */
  indent?: string;
  /**
   * Whether the last column is prose, which may wrap at word boundaries within its cell when the
   * other columns fit and it keeps at least {@link MIN_WRAPPED_COLUMN} columns.
   */
  wrapLast?: boolean;
  /**
   * For the stacked form: whether each column's value is printed after its lowercased header
   * ("mean 1") or alone. Defaults to every column labelled.
   */
  labels?: readonly boolean[];
}

/** The fewest columns a wrapped last column keeps before the table is stacked instead. */
const MIN_WRAPPED_COLUMN = 20;

const COLUMN_GAP = "  ";

/**
 * A table fitted to `width` columns, as lines. A table that fits prints as {@link renderTable}
 * prints it, aligned on display width so wide characters line up. One that doesn't fit wraps its
 * last column within the cell when {@link FitTableOptions.wrapLast} allows, and otherwise is
 * stacked: each row's first cell on a line of its own, then its other cells joined with ` · `,
 * wrapped between cells. A cell is never cut, so an id or a name always prints whole.
 */
export function fitTable(headers: string[], rows: string[][], options: FitTableOptions): string[] {
  const { width, indent = "", wrapLast = false } = options;
  const headerStyle = options.headerStyle ?? ((line: string): string => line);
  const rowStyle = options.rowStyle ?? ((line: string): string => line);
  const last = headers.length - 1;
  const widths = headers.map((header, col) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[col] ?? ""))),
  );
  const aligned = (cells: readonly string[]): string =>
    headers
      .map((_, col) => {
        const cell = cells[col] ?? "";
        return col === last ? cell : padDisplay(cell, widths[col] ?? 0);
      })
      .join(COLUMN_GAP)
      .trimEnd();
  const fixed =
    displayWidth(indent) +
    widths.slice(0, last).reduce((sum, columns) => sum + columns + COLUMN_GAP.length, 0);
  const natural = fixed + (widths[last] ?? 0);

  if (width === undefined || natural <= width) {
    return [
      `${indent}${headerStyle(aligned(headers))}`,
      ...rows.map((row, i) => `${indent}${rowStyle(aligned(row), i)}`),
    ];
  }
  if (wrapLast && last > 0 && width - fixed >= MIN_WRAPPED_COLUMN) {
    const room = width - fixed;
    const under = " ".repeat(fixed);
    return [
      `${indent}${headerStyle(aligned(headers))}`,
      ...rows.flatMap((row, i) => {
        const [first = "", ...rest] = wrapWords(row[last] ?? "", room);
        return [
          `${indent}${rowStyle(aligned([...row.slice(0, last), first]), i)}`,
          ...rest.map((piece) => `${under}${piece}`),
        ];
      }),
    ];
  }
  const labels = options.labels ?? headers.map(() => true);
  return rows.flatMap((row, i) => {
    // An empty value is left out, label and all.
    const items = row.slice(1).flatMap((cell, col) => {
      if (cell.trim() === "") {
        return [];
      }
      return [
        labels[col + 1] === false ? cell : `${(headers[col + 1] ?? "").toLowerCase()} ${cell}`,
      ];
    });
    return [
      `${indent}${rowStyle(row[0] ?? "", i)}`,
      ...wrapItems(items, width, { indent: `${indent}  ` }),
    ];
  });
}
