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
