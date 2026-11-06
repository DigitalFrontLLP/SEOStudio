import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AuditReport, CrawlSiteOptions } from "@seostudio/audit-engine";

import { DEFAULT_MAX_PAGES, MAX_PAGES_LIMIT, REPORT_FORMATS, siteUrlOf } from "./args.js";
import type { ReportFormat } from "./args.js";
import type { LocalTool } from "./mcp.js";
import { textResult } from "./mcp.js";
import { renderReport } from "./report.js";
import { summarize } from "./summary.js";

/**
 * THE AUDIT TOOLS `seostudio mcp` SERVES FROM THIS COMPUTER: crawl a site and audit it, read a report,
 * list its issues. The reports live in this process only, newest last; nothing is sent anywhere but to
 * the audited site.
 */

/** The most reports one MCP session keeps; the oldest goes first. */
const REPORTS_KEPT = 10;

/** The issues one list answers when no limit is given. */
const DEFAULT_ISSUES = 100;

/** The most issues one list answers. */
const MAX_ISSUES = 1_000;

/** The crawl the tools run; the engine's `crawlSite` in the CLI. */
export type CrawlSite = (options: CrawlSiteOptions) => Promise<AuditReport>;

/**
 * A string argument, trimmed, or null when absent or not a string.
 *
 * @param args - The arguments.
 * @param name - The argument.
 * @returns The value.
 */
function stringArg(args: Record<string, unknown>, name: string): string | null {
	const value = args[name];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The local audit tools.
 *
 * @param crawl - The crawl to run.
 * @param cwd - The folder a relative `out` path is written under.
 * @returns The tools.
 */
export function localAuditTools(crawl: CrawlSite, cwd: string = process.cwd()): LocalTool[] {
	const reports = new Map<string, AuditReport>();
	let made = 0;
	const reportOf = (args: Record<string, unknown>): AuditReport | string => {
		const id = stringArg(args, "reportId");
		if (id === null) {
			const last = [...reports.values()].at(-1);
			return last ?? "No audit has run yet. Run local_audit_run first.";
		}
		return reports.get(id) ?? `No report ${id}. Reports: ${[...reports.keys()].join(", ") || "none"}.`;
	};
	return [
		{
			name: "local_audit_run",
			description:
				"Crawl a website from this computer and audit it (free, no account): broken links, redirects, titles and descriptions, headings, thin pages, indexability, structured data, speed signals and more. Answers the summary and a reportId for local_audit_get and local_audit_issues_list. Takes a while: about one page a second.",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string", description: "The site, e.g. example.com or https://example.com/blog/." },
					maxPages: {
						type: "integer",
						minimum: 1,
						maximum: MAX_PAGES_LIMIT,
						description: `The most pages read (default ${String(DEFAULT_MAX_PAGES)}).`
					}
				},
				required: ["url"]
			},
			run: async (args) => {
				const url = siteUrlOf(stringArg(args, "url") ?? "");
				if (url === null) return textResult("`url` is not a website address.", true);
				const max = args.maxPages ?? DEFAULT_MAX_PAGES;
				if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_PAGES_LIMIT) {
					return textResult(`maxPages must be a whole number from 1 to ${String(MAX_PAGES_LIMIT)}.`, true);
				}
				const report = await crawl({ url, maxPages: max });
				made += 1;
				const reportId = `r${String(made)}`;
				reports.set(reportId, report);
				if (reports.size > REPORTS_KEPT) {
					const oldest = reports.keys().next().value;
					if (oldest !== undefined) reports.delete(oldest);
				}
				return textResult({ reportId, ...summarize(report) });
			}
		},
		{
			name: "local_audit_get",
			description:
				"Read an audit report made by local_audit_run: its summary (default), or the whole report as json, csv or html. With `out`, writes the report to that file on this computer and answers the path.",
			inputSchema: {
				type: "object",
				properties: {
					reportId: { type: "string", description: "The report; the latest when left out." },
					format: { type: "string", enum: ["summary", ...REPORT_FORMATS] },
					out: { type: "string", description: "A file path to write the report to." }
				}
			},
			run: async (args) => {
				const report = reportOf(args);
				if (typeof report === "string") return textResult(report, true);
				const asked = stringArg(args, "format") ?? "summary";
				const format = REPORT_FORMATS.find((entry): entry is ReportFormat => entry === asked);
				if (asked !== "summary" && format === undefined) {
					return textResult(`format must be summary, ${REPORT_FORMATS.join(", ")}.`, true);
				}
				const out = stringArg(args, "out");
				if (out !== null) {
					const path = resolve(cwd, out);
					await writeFile(path, renderReport(report, format ?? "html"), "utf-8");
					return textResult({ written: path, format: format ?? "html" });
				}
				return format === undefined
					? textResult(summarize(report))
					: textResult(renderReport(report, format));
			}
		},
		{
			name: "local_audit_issues_list",
			description:
				"List the findings of an audit report made by local_audit_run, filtered by severity, rule id or page. Each finding has its rule id, severity, page and evidence.",
			inputSchema: {
				type: "object",
				properties: {
					reportId: { type: "string", description: "The report; the latest when left out." },
					severity: { type: "string", enum: ["critical", "warning", "notice"] },
					ruleId: { type: "string", description: "One check, e.g. title_missing." },
					page: { type: "string", description: "Only findings on pages whose URL contains this." },
					tips: { type: "boolean", description: "Include tips (small improvements, not problems)." },
					limit: { type: "integer", minimum: 1, maximum: MAX_ISSUES }
				}
			},
			run: async (args) => {
				const report = reportOf(args);
				if (typeof report === "string") return textResult(report, true);
				const severity = stringArg(args, "severity");
				const ruleId = stringArg(args, "ruleId");
				const page = stringArg(args, "page");
				const limit =
					typeof args.limit === "number" && Number.isInteger(args.limit)
						? Math.min(Math.max(args.limit, 1), MAX_ISSUES)
						: DEFAULT_ISSUES;
				const matching = report.issues.filter(
					(issue) =>
						(args.tips === true || issue.kind === "issue") &&
						(severity === null || issue.severity === severity) &&
						(ruleId === null || issue.ruleId === ruleId) &&
						(page === null || issue.page.includes(page))
				);
				return textResult({
					total: matching.length,
					issues: matching.slice(0, limit).map((issue) => ({
						ruleId: issue.ruleId,
						severity: issue.severity,
						kind: issue.kind,
						page: issue.page,
						evidence: issue.evidence
					}))
				});
			}
		}
	];
}
