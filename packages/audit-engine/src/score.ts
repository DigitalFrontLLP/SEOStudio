import { isSeoAuditRuleId, seoAuditByCategory, seoAuditRule } from "./catalog";
import type { SeoAuditCategory, SeoAuditRuleId, SeoAuditSeverity } from "./catalog";

/**
 * THE HEALTH SCORE: weighted pages (the owner's rule, 2026-10-07). Computed from the open issues,
 * never judged by a model. PURE: the audit stores it per run, a mute recomputes it, and the agent
 * tools and the screen only read it.
 *
 * 1. Every page the audit read starts at 100. Each of its issues costs points by severity (an error a
 *    lot, a warning some, a notice a little, an insight nothing), with diminishing returns: the worst
 *    issue costs its full price, each next one 70% of the one before, so a page full of small notices
 *    never falls to zero.
 * 2. Pages are weighted by importance: by their search impressions when the project has any (Search
 *    Console), else by their Link Score and clicks from the home page. A page weighs 1 to
 *    {@link SEO_AUDIT_SCORE_MODEL}.maxWeight.
 * 3. The site's score is the weighted mean of its pages. A whole-site check counts on the home page.
 *    A fault one fix repairs on every page (`params.once`: a broken, redirecting or http link of the
 *    menu or footer, or one setting of the whole site, such as compression switched off) is a defect
 *    every visitor of those pages meets, but one fix: it costs {@link SEO_AUDIT_SCORE_MODEL}.sharedShare
 *    of its price on every page that shows it (the owner, 2026-10-08: a store with a broken link in
 *    every menu must not score like a well-built site, nor like a site broken page by page).
 * 4. A breakage of the whole site (search engines blocked by robots.txt, robots.txt unreachable, an
 *    expired or invalid certificate, a home page that fails) caps the score at
 *    {@link SEO_AUDIT_SCORE_MODEL}.cap.
 *
 * Each category's score is the same sum over that category's issues alone. A muted check counts
 * nowhere.
 */

/** The model's numbers. */
export const SEO_AUDIT_SCORE_MODEL = {
	/** What one issue costs a page at full price, by severity. */
	cost: { critical: 50, warning: 10, notice: 2 } satisfies Record<SeoAuditSeverity, number>,
	/** Each next issue on a page costs this share of the one before it (the worst first). */
	decay: 0.7,
	/** The highest score while the whole site is broken. */
	cap: 40,
	/** What the most important page weighs, against 1 for the least. */
	maxWeight: 5,
	/** The share of its price a fault one fix repairs everywhere (`params.once`) costs each page. */
	sharedShare: 0.5
} as const;

/** How the pages were weighted: by search traffic, or by the site's own links. */
export type SeoAuditWeighting = "traffic" | "links";

/** One page the score reads. */
export interface SeoAuditScorePage {
	pageKey: string;
	/** Search impressions over 90 days. */
	impressions: number;
	/** Link Score, 0 to 100, or null when unknown. */
	linkScore: number | null;
	/** Clicks from the home page, or null when no path reaches it. */
	clickDepth: number | null;
}

/** One open issue the score reads. */
export interface SeoAuditScoreIssue {
	pageKey: string;
	ruleId: string;
	/** The severity the issue was filed at (a lab check may file below its catalog severity). */
	severity: string;
	params?: Record<string, unknown>;
}

/** What the score reads. */
export interface SeoAuditScoreInput {
	/** The pages the audit read. */
	pages: readonly SeoAuditScorePage[];
	issues: readonly SeoAuditScoreIssue[];
	/** The home page's key: whole-site checks count on it. */
	homeKey: string | null;
	/** The checks the project muted. */
	muted?: ReadonlySet<string>;
}

/** The score and what it is made of. */
export interface SeoAuditScoring {
	/** 0 to 100, or null with no page read. */
	score: number | null;
	/** Each category's score, or null with no page read. */
	categories: Record<SeoAuditCategory, number> | null;
	/** For every check with open issues: the share of the site's page weight it is on, 0 to 100. */
	weights: Record<string, number>;
	/** The whole-site breakage that capped the score, or null. */
	cappedBy: SeoAuditRuleId | null;
	/** Pages with at least one error, neither muted nor an insight. */
	pagesWithErrors: number;
	weighting: SeoAuditWeighting;
}

/** The checks whose failure on the HOME PAGE breaks the whole site. */
const HOME_BREAKING: ReadonlySet<string> = new Set([
	"unreachable",
	"status_client_error",
	"status_server_error",
	"redirect_loop",
	"redirect_broken",
	"redirect_too_many"
]);

/** The certificate faults that break the site for every visitor. */
const BROKEN_TLS: ReadonlySet<string> = new Set(["expired", "invalid"]);

/**
 * Whether an issue breaks the whole site.
 *
 * @param issue - The issue.
 * @param homeKey - The home page's key.
 * @returns Whether it caps the score.
 */
function breaksSite(issue: SeoAuditScoreIssue, homeKey: string | null): boolean {
	switch (issue.ruleId) {
		case "search_engine_blocked":
		case "robots_unreachable":
			return true;
		case "tls_certificate": {
			const kinds = issue.params?.kinds;
			return Array.isArray(kinds) && kinds.some((kind) => BROKEN_TLS.has(String(kind)));
		}
		default:
			return issue.pageKey === homeKey && HOME_BREAKING.has(issue.ruleId);
	}
}

/** Why one fix repairs a fault on every page: it sits in the shared layout, or it is one setting of the whole site. */
export type SeoAuditOnce = "layout" | "setting";

/**
 * Whether an issue is a fault one fix repairs on every page (`params.once`): it costs each page
 * {@link SEO_AUDIT_SCORE_MODEL}.sharedShare of its price.
 *
 * @param issue - The issue.
 * @returns Whether it is.
 */
function fixedOnce(issue: SeoAuditScoreIssue): boolean {
	const once = issue.params?.once;
	return once === "layout" || once === "setting";
}

/**
 * Each page's weight, 1 to {@link SEO_AUDIT_SCORE_MODEL}.maxWeight: by impressions (on a log scale)
 * when any page has some, else half by Link Score and half by closeness to the home page.
 *
 * @param pages - The pages.
 * @returns The weights by page key, and how they were made.
 */
export function seoAuditPageWeights(pages: readonly SeoAuditScorePage[]): {
	weights: Map<string, number>;
	weighting: SeoAuditWeighting;
} {
	const span = SEO_AUDIT_SCORE_MODEL.maxWeight - 1;
	const most = pages.reduce((max, page) => Math.max(max, page.impressions), 0);
	const weights = new Map<string, number>();
	for (const page of pages) {
		const importance =
			most > 0
				? Math.log1p(Math.max(0, page.impressions)) / Math.log1p(most)
				: 0.5 * (Math.min(100, Math.max(0, page.linkScore ?? 0)) / 100) +
					0.5 * (page.clickDepth === null ? 0 : 1 / (1 + Math.max(0, page.clickDepth)));
		weights.set(page.pageKey, 1 + span * importance);
	}
	return { weights, weighting: most > 0 ? "traffic" : "links" };
}

/**
 * What a page's issues cost it, worst first, each next one at {@link SEO_AUDIT_SCORE_MODEL}.decay of
 * the one before.
 *
 * @param costs - The full price of each issue.
 * @returns The points lost, under 100.
 */
export function seoAuditPageCost(costs: readonly number[]): number {
	const sorted = [...costs].filter((cost) => cost > 0).sort((a, b) => b - a);
	let total = 0;
	let share = 1;
	for (const cost of sorted) {
		total += cost * share;
		share *= SEO_AUDIT_SCORE_MODEL.decay;
	}
	return Math.min(100, total);
}

/**
 * A severity's full price, or 0 for one the model does not know.
 *
 * @param severity - The severity filed.
 * @returns The price.
 */
function costOf(severity: string): number {
	return severity === "critical" || severity === "warning" || severity === "notice"
		? SEO_AUDIT_SCORE_MODEL.cost[severity]
		: 0;
}

/**
 * The weighted mean of the pages' scores, each losing what its issues cost; never 100 while an issue
 * costs anything (a rounded 99.6 still reads as 99).
 *
 * @param weights - Each page's weight.
 * @param costs - Each page's issue prices.
 * @returns The score, 0 to 100, rounded.
 */
function weightedScore(
	weights: ReadonlyMap<string, number>,
	costs: ReadonlyMap<string, number[]>
): number {
	let total = 0;
	let sum = 0;
	let any = false;
	for (const [pageKey, weight] of weights) {
		const lost = seoAuditPageCost(costs.get(pageKey) ?? []);
		if (lost > 0) any = true;
		total += weight;
		sum += weight * (100 - lost);
	}
	if (total <= 0) return 100;
	const score = Math.round(sum / total);
	return any ? Math.min(99, score) : score;
}

/**
 * Scores a site from its open issues.
 *
 * @param input - The pages read, the open issues, the home page and the muted checks.
 * @returns The score, each category's score, each check's share of the page weight and the cap.
 */
export function scoreSeoAudit(input: SeoAuditScoreInput): SeoAuditScoring {
	const { weights, weighting } = seoAuditPageWeights(input.pages);
	const muted = input.muted ?? new Set<string>();
	const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
	const all = new Map<string, number[]>();
	const byCategory = new Map<SeoAuditCategory, Map<string, number[]>>();
	const ruleWeight = new Map<string, number>();
	const sitewide = new Set<string>();
	const broken = new Set<string>();
	let cappedBy: SeoAuditRuleId | null = null;
	for (const issue of input.issues) {
		const rule = seoAuditRule(issue.ruleId);
		if (rule === null) continue;
		const pageKey = rule.scope === "site" ? input.homeKey : issue.pageKey;
		if (rule.scope === "site") sitewide.add(issue.ruleId);
		else if (pageKey !== null && weights.has(pageKey)) {
			ruleWeight.set(
				issue.ruleId,
				(ruleWeight.get(issue.ruleId) ?? 0) + (weights.get(pageKey) ?? 0)
			);
		}
		if (rule.insight || muted.has(issue.ruleId)) continue;
		if (cappedBy === null && isSeoAuditRuleId(issue.ruleId) && breaksSite(issue, input.homeKey)) {
			cappedBy = issue.ruleId;
		}
		if (pageKey === null || !weights.has(pageKey)) continue;
		const cost =
			costOf(issue.severity) * (fixedOnce(issue) ? SEO_AUDIT_SCORE_MODEL.sharedShare : 1);
		if (cost <= 0) continue;
		if (issue.severity === "critical") broken.add(pageKey);
		all.set(pageKey, [...(all.get(pageKey) ?? []), cost]);
		const costs = byCategory.get(rule.category) ?? new Map<string, number[]>();
		costs.set(pageKey, [...(costs.get(pageKey) ?? []), cost]);
		byCategory.set(rule.category, costs);
	}
	const shares: Record<string, number> = {};
	for (const ruleId of sitewide) shares[ruleId] = 100;
	for (const [ruleId, weight] of ruleWeight) {
		if (sitewide.has(ruleId)) continue;
		shares[ruleId] = totalWeight > 0 ? Math.round((1000 * weight) / totalWeight) / 10 : 0;
	}
	if (weights.size === 0) {
		return {
			score: null,
			categories: null,
			weights: shares,
			cappedBy,
			pagesWithErrors: 0,
			weighting
		};
	}
	const raw = weightedScore(weights, all);
	const categories = seoAuditByCategory((category) =>
		weightedScore(weights, byCategory.get(category) ?? new Map<string, number[]>())
	);
	return {
		score: cappedBy === null ? raw : Math.min(raw, SEO_AUDIT_SCORE_MODEL.cap),
		categories,
		weights: shares,
		cappedBy,
		pagesWithErrors: broken.size,
		weighting
	};
}
