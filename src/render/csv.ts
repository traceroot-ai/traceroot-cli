/**
 * Renders an RFC 4180 style CSV string. The first line is the header row and
 * the rest are data rows. Every line, including the last, ends with `\n`. A
 * cell is quoted only when it contains a comma, a double quote, or a line
 * break, and embedded quotes are doubled. `null` and `undefined` become empty
 * cells; objects and arrays are JSON-encoded.
 *
 * Values are written verbatim. Cells that begin with `=`, `+`, `-` or `@` are
 * not rewritten to defuse spreadsheet formulas, because the output is data for
 * other tools and altering it would corrupt legitimate values; open untrusted
 * CSV in a spreadsheet through its import dialog rather than directly.
 */
export function renderCsv(headers: string[], rows: unknown[][]): string {
  const serializeCell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }
    return JSON.stringify(value);
  };

  const quoteCell = (text: string): string => {
    if (/[,"\r\n]/.test(text)) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  };

  const renderRow = (cells: unknown[]): string =>
    headers.map((_, col) => quoteCell(serializeCell(cells[col]))).join(",");

  const lines = [renderRow(headers), ...rows.map((row) => renderRow(row))];
  return `${lines.join("\n")}\n`;
}
