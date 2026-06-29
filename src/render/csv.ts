/**
 * Renders an RFC-4180-style CSV string. The first line is the header row;
 * subsequent lines are data rows. Every line, including the last, ends with
 * `\n`. No external dependencies; output is fully deterministic.
 */
export function renderCsv(headers: string[], rows: unknown[][]): string {
  const serializeCell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }
    // object, array, or anything else
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
