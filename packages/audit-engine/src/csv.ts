/**
 * CSV, ONE WAY FOR EVERY EXPORT: the screens' table downloads and the server's streamed Site audit
 * files write cells the same way (RFC 4180, CRLF line ends). Numbers are written raw, text as it reads,
 * and a text cell a spreadsheet would run as a formula is led by an apostrophe. Pure.
 */

/** One cell: a number written raw, text, or nothing. */
export type CsvCell = string | number | null;

/**
 * One cell as CSV: quoted when it holds a comma, a semicolon, a quote or a line break, and a text cell
 * a spreadsheet would run as a formula (one starting with `=`, `+`, `-`, `@`, a tab or a carriage
 * return) led by an apostrophe, so an exported value can never run as one. A semicolon is quoted too:
 * a spreadsheet that reads semicolon-separated files would otherwise split the cell there and could
 * start the next cell with a formula.
 *
 * @param cell - The cell.
 * @returns The CSV text.
 */
export function csvCell(cell: CsvCell): string {
	if (cell === null) return "";
	if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
	const text = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
	return /[",;\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One row as a CSV line, its CRLF included.
 *
 * @param row - The cells.
 * @returns The line.
 */
export function csvLine(row: readonly CsvCell[]): string {
	return `${row.map(csvCell).join(",")}\r\n`;
}

/**
 * Rows as CSV text: comma separated, lines ended by CRLF (RFC 4180), no line end after the last.
 *
 * @param rows - The rows, the header first.
 * @returns The text.
 */
export function csvText(rows: readonly (readonly CsvCell[])[]): string {
	return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
