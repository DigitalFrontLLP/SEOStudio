import type { SeoAuditRunChange } from "./facts";

import { isSeoAuditRuleId, SEO_AUDIT_RULES } from "./catalog";
import type { SeoAuditSeverity } from "./catalog";
import { scoreSeoAudit } from "./score";
import type { SeoAuditScorePage, SeoAuditScoring } from "./score";

/**
 * THE AUDIT'S SUMMARY of its open issues: counts by severity and rule, the pages with an error, and the
 * weighted health score (`./score`). Pure, shared by the audit job (which stores it per
 * day), a mute (which scores again) and the readers.
 */

/** One open issue as the summary reads it. */
export interface SummaryIssue {
	pageKey: string;
	ruleId: string;
	severity: string;
	params?: Record<string, unknown>;
}

/** What the summary counts. */
export interface AuditSummary {
	pagesCrawled: number;
	pagesWithErrors: number;
	healthScore: number | null;
	scoring: SeoAuditScoring;
	/**
	 * The pages open issues are on, by severity: insights and muted checks left out; a layout fact
	 * filed once counts every page it stands for (`params.shared.pages`), a whole-site check one.
	 */
	counts: Record<SeoAuditSeverity, number>;
	/** The pages open issues are on, per rule id, every one, counted the same way. */
	byRule: Record<string, number>;
}

/** What the summary reads besides the issues. */
export interface AuditSummarySite {
	/** The pages the audit read, with what weighs them. */
	pages: readonly SeoAuditScorePage[];
	/** The home page's key. */
	homeKey: string | null;
	/** The checks the project muted. */
	muted?: ReadonlySet<string>;
}

/**
 * The pages one open issue stands for: every page a layout fact filed once is on, else its own page.
 *
 * @param issue - The issue.
 * @returns The pages.
 */
function issuePages(issue: SummaryIssue): number {
	const shared = issue.params?.shared;
	if (typeof shared !== "object" || shared === null) return 1;
	const pages = (shared as Record<string, unknown>).pages;
	return typeof pages === "number" && Number.isInteger(pages) && pages > 1 ? pages : 1;
}

/**
 * Summarizes a project's open issues. A whole-site check counts on the home page; an issue on a page
 * the audit did not read (a page past the plan's cap) counts in no score.
 *
 * @param issues - The open issues.
 * @param site - The pages read, the home page and the muted checks.
 * @returns The summary.
 */
export function summarizeAudit(
	issues: readonly SummaryIssue[],
	site: AuditSummarySite
): AuditSummary {
	const counts: Record<SeoAuditSeverity, number> = { critical: 0, warning: 0, notice: 0 };
	const byRule: Record<string, number> = {};
	const muted = site.muted ?? new Set<string>();
	for (const issue of issues) {
		if (!isSeoAuditRuleId(issue.ruleId)) continue;
		const rule = SEO_AUDIT_RULES[issue.ruleId];
		const pages = issuePages(issue);
		byRule[issue.ruleId] = (byRule[issue.ruleId] ?? 0) + pages;
		if (!rule.insight && !muted.has(issue.ruleId)) counts[rule.severity] += pages;
	}
	const scoring = scoreSeoAudit({ pages: site.pages, issues, homeKey: site.homeKey, muted });
	return {
		pagesCrawled: site.pages.length,
		pagesWithErrors: scoring.pagesWithErrors,
		healthScore: scoring.score,
		scoring,
		counts,
		byRule
	};
}

/** One issue key: its page and its rule. */
export interface IssueKey {
	pageKey: string;
	ruleId: string;
}

/**
 * What one audit changed, per rule: the issues it found that were not open before (`found`), of them
 * the ones an earlier audit had fixed (`regressed`, counted apart from `found`), and the open ones it
 * judged and no longer found (`fixed`).
 *
 * @param before - The issues open before the audit.
 * @param findings - What the audit found.
 * @param judged - The pages the audit judged: an open issue elsewhere stays open.
 * @param fixedBefore - Issues an earlier audit had fixed.
 * @returns The changes, by rule id; a rule nothing changed for is left out.
 */
export function auditChanges(
	before: readonly IssueKey[],
	findings: readonly IssueKey[],
	judged: ReadonlySet<string>,
	fixedBefore: readonly IssueKey[]
): Record<string, SeoAuditRunChange> {
	const key = (issue: IssueKey): string => `${issue.pageKey}\u0000${issue.ruleId}`;
	const open = new Set(before.map(key));
	const found = new Set(findings.map(key));
	const wasFixed = new Set(fixedBefore.map(key));
	const changes: Record<string, SeoAuditRunChange> = {};
	const bump = (ruleId: string, field: keyof SeoAuditRunChange): void => {
		const change = changes[ruleId] ?? { found: 0, fixed: 0, regressed: 0 };
		change[field] += 1;
		changes[ruleId] = change;
	};
	for (const issue of findings) {
		if (open.has(key(issue))) continue;
		bump(issue.ruleId, wasFixed.has(key(issue)) ? "regressed" : "found");
	}
	for (const issue of before) {
		if (judged.has(issue.pageKey) && !found.has(key(issue))) bump(issue.ruleId, "fixed");
	}
	return changes;
}

/**
 * Two sets of changes added up (two audits on one day).
 *
 * @param a - The first.
 * @param b - The second.
 * @returns The sum.
 */
export function addAuditChanges(
	a: Readonly<Record<string, SeoAuditRunChange>>,
	b: Readonly<Record<string, SeoAuditRunChange>>
): Record<string, SeoAuditRunChange> {
	const sum: Record<string, SeoAuditRunChange> = {};
	for (const [ruleId, change] of [...Object.entries(a), ...Object.entries(b)]) {
		const current = sum[ruleId] ?? { found: 0, fixed: 0, regressed: 0 };
		sum[ruleId] = {
			found: current.found + change.found,
			fixed: current.fixed + change.fixed,
			regressed: current.regressed + change.regressed
		};
	}
	return sum;
}

/** One page as the score's page list is drawn from: whether and how it was read, and what weighs it. */
export interface SeoScorePageRow {
	pageKey: string;
	/** When the page was last read, or null when it never was. */
	lastCrawledAt: Date | null;
	status: number | null;
	/** Search impressions over 90 days. */
	impressions90d: number;
	linkScore: number | null;
	clickDepth: number | null;
}

/**
 * The pages the health score weighs, with their impressions, Link Score and clicks from the home page:
 * every page read that answered (a confirmed status), and every page an open issue is filed on (one
 * unreachable twice, say). A page whose reads all failed once is not known to be healthy, so it is
 * left out rather than counted as clean, and so is a page the site refused to show the crawler (a bot
 * wall, a 403): it was never read, and a site that refuses every page has no score at all.
 *
 * @param rows - The page rows.
 * @param issues - The open issues.
 * @returns The pages the score weighs.
 */
export function scorePagesOf(
	rows: readonly SeoScorePageRow[],
	issues: readonly { pageKey: string; ruleId: string }[]
): SeoAuditScorePage[] {
	const filed = new Set(issues.map((issue) => issue.pageKey));
	const refused = new Set(
		issues.filter((issue) => issue.ruleId === "crawl_blocked").map((issue) => issue.pageKey)
	);
	return rows
		.filter(
			(row) =>
				row.lastCrawledAt !== null &&
				!refused.has(row.pageKey) &&
				(row.status !== null || filed.has(row.pageKey))
		)
		.map((row) => ({
			pageKey: row.pageKey,
			impressions: row.impressions90d,
			linkScore: row.linkScore,
			clickDepth: row.clickDepth
		}));
}
