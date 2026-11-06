import { renderHtmlReport, toCsv } from "@seostudio/audit-engine";
import type { AuditReport } from "@seostudio/audit-engine";

import type { ReportFormat } from "./args.js";

/** The file extension of each report format. */
const EXTENSION: Readonly<Record<ReportFormat, string>> = { html: "html", json: "json", csv: "csv" };

/**
 * A report in one format: a standalone HTML page, the versioned JSON report, or one CSV row per
 * finding.
 *
 * @param report - The report.
 * @param format - The format.
 * @returns The file's text.
 */
export function renderReport(report: AuditReport, format: ReportFormat): string {
	if (format === "html") return renderHtmlReport(report);
	if (format === "csv") return toCsv(report);
	return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * The file a report is written to when `--out` is not given: `seostudio-audit-<host>.<ext>` in the
 * current folder.
 *
 * @param url - The audited site.
 * @param format - The format.
 * @returns The file name.
 */
export function defaultReportFile(url: string, format: ReportFormat): string {
	let host = "site";
	try {
		host = new URL(url).hostname.replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "-") || host;
	} catch {
		host = "site";
	}
	return `seostudio-audit-${host}.${EXTENSION[format]}`;
}
