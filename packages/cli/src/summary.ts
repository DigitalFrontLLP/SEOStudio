import type { AuditReport, AuditReportSeverity } from "@seostudio/audit-engine";

/**
 * WHAT A STANDALONE AUDIT TELLS THE TERMINAL: the counts by severity, the issues that touch the most
 * pages, and the thin page candidates - all read from the report alone.
 */

/** The rule whose pages are thin page candidates: little main text. */
export const THIN_RULE = "thin_content";

/** How many of the top issues the summary lists. */
const TOP_ISSUES = 8;

/** How many thin page candidates the summary lists. */
const TOP_THIN = 10;

/** One issue the summary lists: a rule and how many pages it was filed on. */
export interface SummaryIssue {
	ruleId: string;
	severity: AuditReportSeverity;
	pages: number;
}

/**
 * A page the crawl alone marks as thin. Whether to merge, improve or keep it needs its search clicks,
 * which only Search Console holds: the summary says so.
 */
export interface ThinCandidate {
	url: string;
	words: number | null;
}

/** What the summary reads from a report. */
export interface AuditSummary {
	startUrl: string;
	pages: number;
	score: number | null;
	complete: boolean;
	bySeverity: Record<AuditReportSeverity, number>;
	tips: number;
	topIssues: SummaryIssue[];
	thin: ThinCandidate[];
	/** Thin candidates beyond the ones listed. */
	moreThin: number;
}

/** The order severities rank in, most serious first. */
const SEVERITY_RANK: Readonly<Record<AuditReportSeverity, number>> = {
	critical: 0,
	warning: 1,
	notice: 2
};

/**
 * The thin page candidates of a report: every page the thin content check flagged, the fewest words
 * first.
 *
 * @param report - The report.
 * @returns The candidates.
 */
export function thinCandidates(report: AuditReport): ThinCandidate[] {
	const words = new Map(report.pages.map((page) => [page.pageKey, page.wordCount]));
	const seen = new Set<string>();
	const candidates: ThinCandidate[] = [];
	for (const issue of report.issues) {
		if (issue.ruleId !== THIN_RULE || seen.has(issue.pageKey)) continue;
		seen.add(issue.pageKey);
		candidates.push({ url: issue.page, words: words.get(issue.pageKey) ?? null });
	}
	return candidates.sort(
		(left, right) =>
			(left.words ?? Number.MAX_SAFE_INTEGER) - (right.words ?? Number.MAX_SAFE_INTEGER) ||
			left.url.localeCompare(right.url)
	);
}

/**
 * Reads the summary out of a report.
 *
 * @param report - The report.
 * @returns The summary.
 */
export function summarize(report: AuditReport): AuditSummary {
	const byRule = new Map<string, SummaryIssue>();
	for (const issue of report.issues) {
		if (issue.kind !== "issue") continue;
		const held = byRule.get(issue.ruleId);
		if (held === undefined) {
			byRule.set(issue.ruleId, { ruleId: issue.ruleId, severity: issue.severity, pages: 1 });
		} else held.pages += 1;
	}
	const topIssues = [...byRule.values()]
		.sort(
			(left, right) =>
				SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
				right.pages - left.pages ||
				left.ruleId.localeCompare(right.ruleId)
		)
		.slice(0, TOP_ISSUES);
	const thin = thinCandidates(report);
	return {
		startUrl: report.startUrl,
		pages: report.summary.pages,
		score: report.summary.score,
		complete: report.complete,
		bySeverity: report.summary.bySeverity,
		tips: report.summary.tips,
		topIssues,
		thin: thin.slice(0, TOP_THIN),
		moreThin: Math.max(0, thin.length - TOP_THIN)
	};
}

/** How each severity is shown. */
const SEVERITY_LABEL: Readonly<Record<AuditReportSeverity, string>> = {
	critical: "error",
	warning: "warning",
	notice: "notice"
};

/**
 * A rule id as words: `title_missing` reads `Title missing`.
 *
 * @param ruleId - The id.
 * @returns The words.
 */
function ruleWords(ruleId: string): string {
	const words = ruleId.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The summary as terminal lines.
 *
 * @param summary - The summary.
 * @returns The text, without a trailing newline.
 */
export function formatSummary(summary: AuditSummary): string {
	const lines: string[] = [];
	lines.push(`Site audit of ${summary.startUrl}`);
	lines.push(
		`${String(summary.pages)} pages checked${summary.complete ? "" : " (stopped at --max-pages)"}. Health score: ${summary.score === null ? "-" : `${String(summary.score)}/100`}.`
	);
	lines.push(
		`Errors: ${String(summary.bySeverity.critical)}  Warnings: ${String(summary.bySeverity.warning)}  Notices: ${String(summary.bySeverity.notice)}  Tips: ${String(summary.tips)}`
	);
	if (summary.topIssues.length > 0) {
		lines.push("", "Top issues:");
		for (const issue of summary.topIssues) {
			lines.push(
				`  [${SEVERITY_LABEL[issue.severity]}] ${ruleWords(issue.ruleId)} (${issue.ruleId}): ${String(issue.pages)} ${issue.pages === 1 ? "page" : "pages"}`
			);
		}
	} else lines.push("", "No issues found.");
	if (summary.thin.length > 0) {
		lines.push(
			"",
			"Thin page candidates (little text). Check Search Console before you merge or remove one:"
		);
		for (const page of summary.thin) {
			lines.push(`  ${page.url}${page.words === null ? "" : ` (${String(page.words)} words)`}`);
		}
		if (summary.moreThin > 0) lines.push(`  and ${String(summary.moreThin)} more in the report.`);
	}
	return lines.join("\n");
}
