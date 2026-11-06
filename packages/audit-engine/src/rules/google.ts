import { canonicalMismatch, normalizePageUrl } from "../urls";

import { SEO_AUDIT_TRAFFIC_JOINS } from "../catalog";
import type { SeoAuditRuleId } from "../catalog";
import { detectVitalsRegressions, passesVitals, rateVital, SEO_VITALS_THRESHOLDS } from "../crux";
import type { SeoVitalsMetric } from "../crux";
import { compileRobots, parseRobots, robotsDecision } from "../robots";
import { bareHost } from "../scope";
import { finding, htmlSnapshot, indexableSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditGoogle, AuditPage, AuditVitals } from "./types";

/**
 * THE GOOGLE DATA JOINS: what Search Console, Analytics, URL Inspection and the Chrome UX Report say
 * about the crawled pages, as audit rules. Each source's rules run only when the project holds that
 * source (`AuditSite.google`); without it they are absent, never failing.
 *
 * ONE SOURCE OF TRUTH:
 * - the traffic rules never detect a state themselves: each joins a finding another rule already filed
 *   (an error status, a noindex, a canonical elsewhere, an orphan, a redirect) with the page's clicks,
 *   so the two can never disagree;
 * - Google's canonical choice is compared with the indexing report's own `canonicalMismatch`, and Core
 *   Web Vitals are rated and their regressions found by the Command center's own CrUX functions.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - traffic means CLICKS from Google search over 90 days (Analytics visits count too for an error
 *   page): a few impressions on a deliberately hidden page are not traffic;
 * - an indexable page is "not indexed" only once Google kept it out for two weeks, so a new page has
 *   time to be crawled; a page Google folded into another canonical is filed under that check alone;
 * - a page's own Core Web Vitals are read only when CrUX holds data for the page itself, never the
 *   origin's numbers shown for it; the origin's are filed once, on the home page.
 */

/** The thresholds the Google data rules use. */
export const GOOGLE_THRESHOLDS = {
	/** Days Google must have kept an indexable page out of its index before it is filed. */
	notIndexedDays: 14,
	/** Weekly CrUX points looked back over for a page or the origin that stopped passing. */
	vitalsRegressionWeeks: 4
} as const;

/**
 * The rules that can file on a page the crawler never reads (robots.txt keeps it off): every audit
 * judges them anew, so one stops being open as soon as it no longer fires.
 */
export const GOOGLE_UNCRAWLED_RULES: ReadonlySet<string> = new Set(["disallowed_with_traffic"]);

/** The reasons Google files a page under when it is indexed, but with a problem. */
const INDEXED_WITH_ISSUES: ReadonlySet<string> = new Set([
	"indexed_blocked_robots",
	"indexed_no_content"
]);

/** Each Core Web Vital, the rule a poor one files, and where a reading keeps it. */
const VITAL_RULES: readonly (readonly [SeoVitalsMetric, SeoAuditRuleId])[] = [
	["lcp", "cwv_lcp_poor"],
	["inp", "cwv_inp_poor"],
	["cls", "cwv_cls_poor"]
];

/**
 * The project's Google data, or null when none is held.
 *
 * @param context - The audit.
 * @returns The data.
 */
function googleOf(context: AuditContext): AuditGoogle | null {
	return context.site.google ?? null;
}

/**
 * The Google search clicks a page had over 90 days (0 without Search Console).
 *
 * @param google - The Google data.
 * @param pageKey - The page.
 * @returns The clicks.
 */
function clicksOf(google: AuditGoogle, pageKey: string): number {
	return google.search?.get(pageKey)?.clicks ?? 0;
}

/**
 * The scalar params of a base finding worth carrying into its traffic join (its status or target).
 *
 * @param base - The base finding.
 * @returns The params.
 */
function carried(base: AuditFinding): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(base.params).filter(
			([key, value]) =>
				(key === "status" || key === "target") &&
				(typeof value === "number" || typeof value === "string")
		)
	);
}

/**
 * THE TRAFFIC JOINS: an error page, a noindex page, a page canonicalised elsewhere, an orphan or a
 * redirect that still gets clicks from Google search (an error page also when Analytics counted visits
 * landing on it). Read from the findings the other rules filed, so each state is judged once.
 *
 * @param context - The audit.
 * @param found - The findings filed so far.
 * @returns The joined findings.
 */
export function trafficFindings(
	context: AuditContext,
	found: readonly AuditFinding[]
): AuditFinding[] {
	const google = googleOf(context);
	if (google === null || (google.search === null && !google.analytics)) return [];
	const joined: AuditFinding[] = [];
	for (const base of found) {
		const join = SEO_AUDIT_TRAFFIC_JOINS[base.ruleId];
		if (join === undefined) continue;
		const clicks = clicksOf(google, base.pageKey);
		if (join === "error_page_with_traffic") {
			const visits = google.analytics && context.byKey.get(base.pageKey)?.inAnalytics === true;
			if (clicks > 0 || visits) {
				joined.push(
					finding(base.pageKey, "error_page_with_traffic", {
						...carried(base),
						clicks,
						source: clicks > 0 ? "search" : "analytics"
					})
				);
			}
			continue;
		}
		if (clicks > 0) joined.push(finding(base.pageKey, join, { ...carried(base), clicks }));
	}
	return joined;
}

/**
 * Whether a page key sits on the site's own host (or its www twin), so the site's robots.txt governs it.
 *
 * @param pageKey - The page key.
 * @param homeKey - The home page's key.
 * @returns Whether it does.
 */
function onSiteHost(pageKey: string, homeKey: string): boolean {
	return bareHost(pageKey.split("/")[0] ?? "") === bareHost(homeKey.split("/")[0] ?? "");
}

/**
 * Pages robots.txt keeps Googlebot off that still get clicks from Google search (crawled or not: the
 * crawler never fetches a page robots.txt forbids it).
 *
 * @param context - The audit.
 * @returns The findings.
 */
function disallowedWithTraffic(context: AuditContext): AuditFinding[] {
	const search = googleOf(context)?.search ?? null;
	const home = context.site.homeKey;
	const robotsTxt = context.site.robotsTxt;
	if (search === null || home === null || robotsTxt === null || robotsTxt.trim() === "") return [];
	const robots = compileRobots(parseRobots(robotsTxt), "Googlebot");
	const found: AuditFinding[] = [];
	for (const [pageKey, totals] of search) {
		if (totals.clicks <= 0 || !onSiteHost(pageKey, home)) continue;
		const decision = robotsDecision(robots, `https://${pageKey}`);
		if (decision.allowed) continue;
		found.push(
			finding(pageKey, "disallowed_with_traffic", {
				clicks: totals.clicks,
				...(decision.rule === null ? {} : { rule: decision.rule.line })
			})
		);
	}
	return found;
}

/**
 * The key a CrUX reading is filed on: the home page for the origin, else the crawled page it names.
 *
 * @param reading - The reading.
 * @param context - The audit.
 * @returns The key, or null when the page is not in the crawl.
 */
function vitalsKey(reading: AuditVitals, context: AuditContext): string | null {
	if (reading.pageKey === "") return context.site.homeKey;
	if (context.byKey.has(reading.pageKey)) return reading.pageKey;
	const landed = context.resolve(reading.pageKey);
	return context.byKey.has(landed) ? landed : null;
}

/**
 * A reading's 75th percentile of one metric.
 *
 * @param reading - The reading or weekly point.
 * @param reading.lcpMs - LCP.
 * @param reading.inpMs - INP.
 * @param reading.cls - CLS.
 * @param metric - The metric.
 * @returns The value, or null.
 */
function valueOf(
	reading: { lcpMs: number | null; inpMs: number | null; cls: number | null },
	metric: SeoVitalsMetric
): number | null {
	if (metric === "lcp") return reading.lcpMs;
	return metric === "inp" ? reading.inpMs : reading.cls;
}

/**
 * Whether a reading stopped passing Core Web Vitals within the last weeks: it passed at the start of
 * the window, fails now, and a metric got 20%+ worse into a worse rating on the way.
 *
 * @param reading - The reading with its weekly history.
 * @returns The regression that broke it, or null.
 */
function stoppedPassing(
	reading: AuditVitals
): { metric: SeoVitalsMetric; before: number; after: number } | null {
	const weeks = [...reading.weeks]
		.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
		.slice(-(GOOGLE_THRESHOLDS.vitalsRegressionWeeks + 1));
	const first = weeks[0];
	const last = weeks.at(-1);
	if (first === undefined || last === undefined || first === last) return null;
	if (passesVitals(first) !== true || passesVitals(last) !== false) return null;
	const regression = detectVitalsRegressions(weeks).at(-1);
	return regression === undefined
		? null
		: { metric: regression.metric, before: regression.before, after: regression.after };
}

/**
 * THE CORE WEB VITALS RULES (CrUX field data): a page's own poor LCP, INP or CLS on phones or
 * desktops, and a page that stopped passing; the origin's, filed on the home page unless the home page
 * has its own reading for that form factor.
 *
 * @param context - The audit.
 * @returns The findings.
 */
function vitalsFindings(context: AuditContext): AuditFinding[] {
	const vitals = googleOf(context)?.vitals ?? null;
	if (vitals === null || vitals.length === 0) return [];
	const home = context.site.homeKey;
	const homeOwn = new Set(
		vitals
			.filter((reading) => reading.pageKey !== "" && vitalsKey(reading, context) === home)
			.map((reading) => reading.formFactor)
	);
	const ordered = [
		...vitals.filter((reading) => reading.pageKey !== ""),
		...vitals.filter((reading) => reading.pageKey === "" && !homeOwn.has(reading.formFactor))
	];
	const poor = new Map<string, AuditFinding>();
	const found: AuditFinding[] = [];
	for (const reading of ordered) {
		const key = vitalsKey(reading, context);
		if (key === null) continue;
		const level = reading.pageKey === "" ? "origin" : "url";
		for (const [metric, ruleId] of VITAL_RULES) {
			const value = valueOf(reading, metric);
			if (rateVital(metric, value) !== "poor" || value === null) continue;
			const id = `${key}\u0000${ruleId}`;
			const held = poor.get(id)?.params;
			if (held !== undefined && (held.level !== level || Number(held.p75) >= value)) continue;
			poor.set(
				id,
				finding(key, ruleId, {
					level,
					formFactor: reading.formFactor,
					p75: Math.round(value * 1000) / 1000,
					threshold: SEO_VITALS_THRESHOLDS[metric].poor
				})
			);
		}
		const broke = stoppedPassing(reading);
		if (broke !== null) {
			found.push(
				finding(key, "cwv_regressed", { level, formFactor: reading.formFactor, ...broke })
			);
		}
	}
	return [...found, ...poor.values()];
}

/**
 * THE GOOGLE VIEW OF ONE PAGE (URL Inspection and Search Console): Google chose another canonical,
 * an indexable page Google has not indexed, a page indexed with a problem, rich results Google calls
 * invalid, and an indexable page with no search impressions in 90 days (an insight).
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function googlePageFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const google = googleOf(context);
	if (google === null) return [];
	const key = page.pageKey;
	const found: AuditFinding[] = [];
	const indexable = indexableSnapshot(page, context) !== null;
	if (google.search !== null && indexable && (google.search.get(key)?.impressions ?? 0) === 0) {
		found.push(finding(key, "no_search_data"));
	}
	const inspection = google.inspections?.get(key);
	if (inspection === undefined || htmlSnapshot(page) === null) return found;
	const differs =
		canonicalMismatch(inspection.googleCanonical, inspection.userCanonical) &&
		!sameLanding(inspection.googleCanonical, inspection.userCanonical, context);
	if (differs) {
		found.push(
			finding(key, "google_canonical_differs", {
				google: inspection.googleCanonical ?? "",
				declared: inspection.userCanonical ?? ""
			})
		);
	}
	if (inspection.indexed) {
		if (INDEXED_WITH_ISSUES.has(inspection.reason) || inspection.verdict === "PARTIAL") {
			found.push(finding(key, "indexed_with_issues", { reason: inspection.reason }));
		}
	} else if (!differs && indexable && inspection.stateDays >= GOOGLE_THRESHOLDS.notIndexedDays) {
		found.push(
			finding(key, "indexable_not_indexed", {
				reason: inspection.reason,
				days: inspection.stateDays
			})
		);
	}
	if (inspection.richResultsVerdict === "FAIL") {
		found.push(
			finding(key, "rich_result_invalid_google", {
				types: inspection.richResultTypes.join(", ")
			})
		);
	}
	return found;
}

/**
 * Whether two URLs land on the same page through the site's known variants and redirects.
 *
 * @param left - One URL.
 * @param right - The other.
 * @param context - The audit.
 * @returns Whether they do.
 */
function sameLanding(left: string | null, right: string | null, context: AuditContext): boolean {
	if (left === null || right === null) return false;
	const a = normalizePageUrl(left);
	const b = normalizePageUrl(right);
	return a !== null && b !== null && context.resolve(a) === context.resolve(b);
}

/**
 * THE WHOLE-SITE GOOGLE RULES: pages robots.txt keeps Googlebot off that still get clicks, and the
 * Core Web Vitals of the origin and the busiest pages.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function googleSiteFindings(context: AuditContext): AuditFinding[] {
	if (googleOf(context) === null) return [];
	return [...disallowedWithTraffic(context), ...vitalsFindings(context)];
}
