import { csvText } from "./csv";
import type { CsvCell } from "./csv";

/**
 * THE AUDIT REPORT: what a standalone crawl ({@link crawlSite} in `./site`) hands back, as plain JSON
 * a program can store, diff or turn into a file. Versioned by {@link AUDIT_REPORT_SCHEMA_VERSION}: a
 * change that breaks a reader raises it; a new optional field does not.
 *
 * Every finding is a STABLE rule id from the catalog (`./catalog`) with its evidence as structured
 * params, never English, so a reader can word it in any language and match on the id.
 */

/** The report format's version. */
export const AUDIT_REPORT_SCHEMA_VERSION = 1;

/** How serious an issue is: `critical` (shown as an error), `warning` or `notice`. */
export type AuditReportSeverity = "critical" | "warning" | "notice";

/**
 * Whether a finding is a problem to fix (`issue`, counted and scored) or a small improvement that is
 * not a problem (`tip`, listed apart, never counted as an issue).
 */
export type AuditReportKind = "issue" | "tip";

/** One page the crawl read. */
export interface AuditReportPage {
	/** The page's URL, `https://` plus its key. */
	url: string;
	/** The page's key: host, path and query, normalized (`example.com/blog`). */
	pageKey: string;
	/** The status it answered (a redirect's own status), 0 when nothing answered, null when not read. */
	status: number | null;
	/** Why nothing usable answered (`timeout`, `network`, `status_403`...), or null. */
	error: string | null;
	/** Its title, or null when it has none or is not a page. */
	title: string | null;
	/** Clicks from the home page along followed links, or null when no such path reaches it. */
	clickDepth: number | null;
	/** Words in its main text, or null when it is not a page. */
	wordCount: number | null;
	/** How many issues (not tips) were filed on it. */
	issues: number;
}

/** One finding on one page (a whole-site finding is filed on the home page). */
export interface AuditReportIssue {
	/** The check's stable id (`title_missing`, `broken_internal_links`...). */
	ruleId: string;
	severity: AuditReportSeverity;
	/** The area of the site the check is about (`metadata`, `links`, `performance`...). */
	category: string;
	kind: AuditReportKind;
	/** Whether the check judges the whole site rather than one page. */
	siteWide: boolean;
	/** The page's URL. */
	page: string;
	/** The page's key. */
	pageKey: string;
	/** What the check found, as structured params (counts, examples, measured values). */
	evidence: Record<string, unknown>;
}

/** The counts of a report. */
export interface AuditReportSummary {
	/** Pages the crawl read. */
	pages: number;
	/** Issues filed (tips left out). */
	issues: number;
	/** Tips filed. */
	tips: number;
	/** Issues by severity. */
	bySeverity: Record<AuditReportSeverity, number>;
	/** Findings (issues and tips) by rule id. */
	byRule: Record<string, number>;
	/** Pages with at least one critical issue. */
	pagesWithErrors: number;
	/** The site's health score, 0 to 100, or null when no page could be judged. */
	score: number | null;
}

/** What a standalone crawl found. */
export interface AuditReport {
	schemaVersion: typeof AUDIT_REPORT_SCHEMA_VERSION;
	/** The URL the crawl started from. */
	startUrl: string;
	/** When the crawl started and finished (ISO). */
	startedAt: string;
	finishedAt: string;
	/**
	 * Whether the crawl read every page it found: false when it stopped at its page cap, so the checks
	 * that judge what is MISSING from the site (an orphan page, a page left out of the sitemap) held
	 * back.
	 */
	complete: boolean;
	/** Every page read, in the order it was found. */
	pages: AuditReportPage[];
	/** Every finding, issues before tips, the most serious first. */
	issues: AuditReportIssue[];
	summary: AuditReportSummary;
}

/** The CSV header {@link toCsv} writes. */
const CSV_HEADER: readonly CsvCell[] = [
	"page",
	"rule_id",
	"severity",
	"category",
	"kind",
	"site_wide",
	"evidence"
];

/**
 * A report's findings as CSV (RFC 4180, CRLF line ends): one row per finding with its page, rule id,
 * severity, category, kind, whether it is site-wide, and its evidence as JSON.
 *
 * @param report - The report.
 * @returns The CSV text, the header first.
 */
export function toCsv(report: AuditReport): string {
	return csvText([
		CSV_HEADER,
		...report.issues.map((issue): CsvCell[] => [
			issue.page,
			issue.ruleId,
			issue.severity,
			issue.category,
			issue.kind,
			issue.siteWide ? "yes" : "no",
			JSON.stringify(issue.evidence)
		])
	]);
}

/**
 * Text made safe inside HTML.
 *
 * @param value - The text.
 * @returns The escaped text.
 */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * A rule id as a readable label: `title_missing` reads `Title missing`.
 *
 * @param ruleId - The id.
 * @returns The label.
 */
function ruleLabel(ruleId: string): string {
	const words = ruleId.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The label each severity is shown under. */
const SEVERITY_LABEL: Record<AuditReportSeverity, string> = {
	critical: "Error",
	warning: "Warning",
	notice: "Notice"
};

/** The order severities are listed in, most serious first. */
const SEVERITY_ORDER: readonly AuditReportSeverity[] = ["critical", "warning", "notice"];

/**
 * One rule's findings as a section: its label, severity, how many pages, and each page with its
 * evidence.
 *
 * @param ruleId - The rule.
 * @param issues - Its findings.
 * @returns The HTML.
 */
function ruleSection(ruleId: string, issues: readonly AuditReportIssue[]): string {
	const first = issues[0];
	if (first === undefined) return "";
	const rows = issues
		.map(
			(issue) =>
				`<tr><td><a href="${escapeHtml(issue.page)}">${escapeHtml(issue.pageKey)}</a></td><td><code>${escapeHtml(JSON.stringify(issue.evidence))}</code></td></tr>`
		)
		.join("");
	const tag = first.kind === "tip" ? "Tip" : SEVERITY_LABEL[first.severity];
	return `<details class="rule ${escapeHtml(first.kind === "tip" ? "tip" : first.severity)}"><summary><span class="tag">${escapeHtml(tag)}</span> ${escapeHtml(ruleLabel(ruleId))} <code>${escapeHtml(ruleId)}</code> <span class="count">${String(issues.length)}</span></summary><table><thead><tr><th>Page</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

/** The report page's styles: light and dark, readable at phone width. */
const STYLES = `:root{--bg:#fafafa;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--card:#fff;--error:#dc2626;--warning:#d97706;--notice:#2563eb;--tip:#059669}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--line:#27272a;--card:#18181b}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 12px}
.muted{color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-top:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}.stat b{display:block;font-size:22px}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:8px 0;overflow:hidden}
summary{cursor:pointer;padding:10px 12px}summary code{color:var(--muted);font-size:12px}.count{float:right;color:var(--muted)}
.tag{display:inline-block;font-size:12px;font-weight:600;border-radius:4px;padding:1px 6px;color:#fff;background:var(--notice)}
.critical .tag{background:var(--error)}.warning .tag{background:var(--warning)}.tip .tag{background:var(--tip)}
table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}th,td{text-align:left;padding:6px 12px;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
a{color:inherit}code{font-size:12px}.scroll{overflow-x:auto}`;

/**
 * A report as one standalone HTML page (no script, no external file): the counts, every finding
 * grouped by rule (issues first, the most serious first), and every page read.
 *
 * @param report - The report.
 * @returns The HTML document.
 */
export function renderHtmlReport(report: AuditReport): string {
	const byRule = new Map<string, AuditReportIssue[]>();
	for (const issue of report.issues) {
		const list = byRule.get(issue.ruleId) ?? [];
		list.push(issue);
		byRule.set(issue.ruleId, list);
	}
	const sections = (kind: AuditReportKind): string =>
		[...byRule.entries()]
			.filter(([, issues]) => issues[0]?.kind === kind)
			.sort(([leftId, left], [rightId, right]) => {
				const rank = (issues: readonly AuditReportIssue[]): number =>
					SEVERITY_ORDER.indexOf(issues[0]?.severity ?? "notice");
				return (
					rank(left) - rank(right) || right.length - left.length || leftId.localeCompare(rightId)
				);
			})
			.map(([ruleId, issues]) => ruleSection(ruleId, issues))
			.join("");
	const { summary } = report;
	const stat = (label: string, value: string): string =>
		`<div class="stat"><b>${escapeHtml(value)}</b><span class="muted">${escapeHtml(label)}</span></div>`;
	const pages = report.pages
		.map(
			(page) =>
				`<tr><td><a href="${escapeHtml(page.url)}">${escapeHtml(page.pageKey)}</a></td><td>${escapeHtml(page.status === null ? "-" : String(page.status))}</td><td>${escapeHtml(page.title ?? "")}</td><td>${String(page.issues)}</td></tr>`
		)
		.join("");
	const issues = sections("issue");
	const tips = sections("tip");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site audit: ${escapeHtml(report.startUrl)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>Site audit</h1>
<p class="muted">${escapeHtml(report.startUrl)} &middot; ${escapeHtml(report.finishedAt)}${report.complete ? "" : " &middot; stopped at the page limit"}</p>
<div class="stats">${stat("Health score", summary.score === null ? "-" : String(summary.score))}${stat("Pages", String(summary.pages))}${stat("Errors", String(summary.bySeverity.critical))}${stat("Warnings", String(summary.bySeverity.warning))}${stat("Notices", String(summary.bySeverity.notice))}${stat("Tips", String(summary.tips))}</div>
<h2>Issues</h2>
${issues === "" ? '<p class="muted">No issues found.</p>' : issues}
${tips === "" ? "" : `<h2>Tips</h2>\n${tips}`}
<h2>Pages</h2>
<div class="scroll"><table><thead><tr><th>Page</th><th>Status</th><th>Title</th><th>Issues</th></tr></thead><tbody>${pages}</tbody></table></div>
</main>
</body>
</html>
`;
}
