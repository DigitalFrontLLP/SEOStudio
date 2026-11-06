import {
	AUDIT_EXAMPLES,
	brokenStatus,
	copyRedirect,
	crawlBlocked,
	failureUnconfirmed,
	finding,
	htmlSnapshot,
	indexableSnapshot,
	isHome
} from "./page-state";
import { linkSpelling } from "./lookups";
import type { SeoAuditOnce } from "../score";
import { sharedLayoutTest } from "./shared-layout";
import type { AuditContext, AuditFinding, AuditLink, AuditSitePage } from "./types";

/**
 * THE LINK RULES, which only the internal link graph can answer: links to broken pages, links to
 * redirects, pages no page links to, and pages that link nowhere.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a link is broken only when its target's failure is CONFIRMED (two days) and the target did not
 *   refuse the crawler (403, 429, bot wall): a page that is only rate-limiting the crawler is fine;
 * - a link whose spelling is not the URL the crawler reads its page at (a trailing or doubled slash)
 *   is judged by what that spelling answered when the resource checks asked it: a redirect is a link
 *   to a redirect, a 404 or a 410 (answered to a HEAD and a GET alike) is a broken link while the
 *   page itself answers, and a page is a working link whatever its other spelling answers;
 * - a link to a temporary redirect whose landing copy names the linked URL as its canonical (a blog
 *   platform sending phones to its `?m=1` copy; `./page-state` `copyRedirect`) is no link to a
 *   redirect: the linked URL is the one search engines index;
 * - a page is an orphan only when the link graph is whole (the crawl covered every sitemap URL, or
 *   read every page it knows of), never the home page, and never a page deliberately hidden (noindex,
 *   canonical elsewhere); it is known from a sitemap, search traffic, Analytics or a backlink;
 * - "links nowhere" is judged from the rendered page (links a script builds count), never from a
 *   page whose render failed (its raw HTML may lack them) and never on a site of one page;
 * - a broken or redirecting link the shared layout carries (a menu or footer link on more than 80% of
 *   the pages, `./shared-layout`) stays filed on every page that shows it, marked `layout`, so the
 *   page says it is one fix; when every such link of the page is the layout's it is marked `once` too,
 *   and the health score prices it at half on each page.
 */

/**
 * The status a link's target answered, or null when it is not known or not settled.
 *
 * @param target - The target page, if crawled.
 * @returns The status, or null.
 */
function settledStatus(target: AuditSitePage | undefined): number | null {
	if (target === undefined || crawlBlocked(target) || failureUnconfirmed(target)) return null;
	return target.status ?? target.snapshot?.status ?? null;
}

/** What a link's own spelling says about it, when the resource checks asked that spelling. */
type SpellingVerdict = "ok" | "redirect" | "broken" | null;

/**
 * What the link's own spelling answered, when it was asked: a page, a redirect, or gone (404, 410)
 * while the page it names answers; null when it was not asked or its answer settles nothing (a
 * refusal, a server error, no answer).
 *
 * @param link - The link.
 * @param context - The audit.
 * @returns The verdict.
 */
function spellingVerdict(link: AuditLink, context: AuditContext): SpellingVerdict {
	const url = linkSpelling(link).split("#")[0] ?? "";
	const answer = context.site.linkSpellings?.get(url);
	if (answer === undefined || answer.error !== null) return null;
	if (answer.status >= 200 && answer.status < 300) return "ok";
	if (answer.status >= 300 && answer.status < 400) return "redirect";
	if (answer.status !== 404 && answer.status !== 410) return null;
	const page = settledStatus(context.byKey.get(link.resolvedKey ?? link.targetKey));
	return page !== null && page >= 200 && page < 300 ? "broken" : null;
}

/**
 * The links of a page that sit in the site's shared layout (`params.layout` of
 * `broken_internal_links`, `links_to_redirect` and `links_to_http`): menu or footer links one fix in
 * the layout repairs on every page.
 */
export interface LayoutLinks {
	/** A few of the page's links of the finding that the layout carries. */
	targets: string[];
	/** Whether every such link of the page is the layout's: it is then marked `once` (one fix, half price in the score). */
	all: boolean;
}

/**
 * The link targets the site's shared layout carries: linked from more than the shared layout's share
 * of the readable pages, or of one template's (`./shared-layout`).
 *
 * @param bySource - Each page's targets.
 * @param context - The audit.
 * @param sources - The readable pages' keys.
 * @returns The targets.
 */
function layoutTargets(
	bySource: ReadonlyMap<string, ReadonlySet<string>>,
	context: AuditContext,
	sources: ReadonlySet<string>
): Set<string> {
	const linkedFrom = new Map<string, Set<string>>();
	for (const [source, targets] of bySource) {
		for (const target of targets) {
			const list = linkedFrom.get(target);
			if (list === undefined) linkedFrom.set(target, new Set([source]));
			else list.add(source);
		}
	}
	const inLayout = sharedLayoutTest(context.pages.filter((page) => sources.has(page.pageKey)));
	return new Set([...linkedFrom].filter(([, from]) => inLayout(from)).map(([target]) => target));
}

/**
 * What a finding's params say about its links in the shared layout: the layout's links among them,
 * and `once` when every one of them is the layout's.
 *
 * @param targets - The page's links of the finding.
 * @param inLayout - The links the layout carries.
 * @returns The params to add, empty when none is the layout's.
 */
export function layoutLinkParams(
	targets: ReadonlySet<string>,
	inLayout: ReadonlySet<string>
): { layout?: LayoutLinks; once?: SeoAuditOnce } {
	const layout = [...targets].filter((target) => inLayout.has(target)).sort();
	if (layout.length === 0) return {};
	const all = layout.length === targets.size;
	return {
		layout: { targets: layout.slice(0, AUDIT_EXAMPLES), all },
		...(all ? { once: "layout" as const } : {})
	};
}

/**
 * The links of the given pages that switch scheme from the page's own (`links_to_http`), from the
 * link graph: the scheme each page's finding names (`params.to`).
 *
 * @param context - The audit.
 * @param pages - Each page with the finding, by key, and the scheme its links switch to.
 * @returns Each page's switched links, as spelled.
 */
function switchedLinks(
	context: AuditContext,
	pages: ReadonlyMap<string, string>
): Map<string, Set<string>> {
	const bySource = new Map<string, Set<string>>();
	for (const link of context.links) {
		const to = pages.get(link.sourceKey);
		if (to === undefined) continue;
		const spelled = linkSpelling(link);
		if (!spelled.toLowerCase().startsWith(`${to}:`)) continue;
		const set = bySource.get(link.sourceKey) ?? new Set<string>();
		set.add(spelled);
		bySource.set(link.sourceKey, set);
	}
	return bySource;
}

/**
 * Marks each `links_to_http` finding whose switched links the shared layout carries (`layout`, and
 * `once` when they all are): an http link in the menu is one fix. Read from the whole site's link
 * graph, which the per-page link rule never holds.
 *
 * @param findings - The findings.
 * @param context - The audit.
 * @returns The findings, those marked.
 */
export function markLayoutSchemeLinks(
	findings: readonly AuditFinding[],
	context: AuditContext
): AuditFinding[] {
	const pages = new Map<string, string>();
	for (const entry of findings) {
		if (entry.ruleId === "links_to_http" && typeof entry.params.to === "string")
			pages.set(entry.pageKey, entry.params.to);
	}
	if (pages.size === 0) return [...findings];
	const sources = new Set(
		context.pages.filter((page) => htmlSnapshot(page) !== null).map((page) => page.pageKey)
	);
	const switched = switchedLinks(context, pages);
	const inLayout = layoutTargets(switched, context, sources);
	if (inLayout.size === 0) return [...findings];
	return findings.map((entry) => {
		if (entry.ruleId !== "links_to_http") return entry;
		const marks = layoutLinkParams(switched.get(entry.pageKey) ?? new Set(), inLayout);
		return marks.layout === undefined ? entry : { ...entry, params: { ...entry.params, ...marks } };
	});
}

/**
 * The link findings of the whole site.
 *
 * @param context - The audit.
 * @returns The findings, at most one per page and rule.
 */
export function linkFindings(context: AuditContext): AuditFinding[] {
	const sources = new Set(
		context.pages.filter((page) => htmlSnapshot(page) !== null).map((page) => page.pageKey)
	);
	const broken = new Map<string, Set<string>>();
	const redirected = new Map<string, Set<string>>();
	for (const link of context.links) {
		if (!sources.has(link.sourceKey)) continue;
		const verdict = spellingVerdict(link, context);
		if (verdict === "ok") continue;
		if (verdict !== null) {
			const into = verdict === "broken" ? broken : redirected;
			const spelled = linkSpelling(link).split("#")[0] ?? link.targetKey;
			into.set(link.sourceKey, (into.get(link.sourceKey) ?? new Set()).add(spelled));
			continue;
		}
		const target = context.byKey.get(link.targetKey);
		const status =
			settledStatus(target) ?? settledStatus(context.byKey.get(link.resolvedKey ?? link.targetKey));
		if (status === null) continue;
		const into = brokenStatus(status) ? broken : status >= 300 && status < 400 ? redirected : null;
		if (into === null) continue;
		if (into === redirected && target !== undefined && copyRedirect(target, context)) continue;
		into.set(link.sourceKey, (into.get(link.sourceKey) ?? new Set()).add(link.targetKey));
	}
	const found: AuditFinding[] = [];
	for (const [ruleId, bySource] of [
		["broken_internal_links", broken],
		["links_to_redirect", redirected]
	] as const) {
		const inLayout = layoutTargets(bySource, context, sources);
		for (const [source, targets] of bySource) {
			found.push(
				finding(source, ruleId, {
					count: targets.size,
					targets: [...targets].sort().slice(0, AUDIT_EXAMPLES),
					...layoutLinkParams(targets, inLayout)
				})
			);
		}
	}
	const indexable = context.pages.filter((page) => indexableSnapshot(page, context) !== null);
	if (context.linksComplete) {
		for (const page of indexable) {
			const inAnalytics = page.inAnalytics === true;
			const backlinked = page.backlinked === true;
			if (!(page.inSitemap || page.hasTraffic || inAnalytics || backlinked)) continue;
			if (isHome(page, context)) continue;
			if (context.links.linksIn(context.resolve(page.pageKey)) > 0) continue;
			const sources = [
				...(page.inSitemap ? ["sitemap"] : []),
				...(page.hasTraffic ? ["search"] : []),
				...(inAnalytics ? ["analytics"] : []),
				...(backlinked ? ["backlinks"] : [])
			];
			found.push(
				finding(page.pageKey, "orphan", {
					inSitemap: page.inSitemap,
					hasTraffic: page.hasTraffic,
					inAnalytics,
					backlinked,
					source: sources[0] ?? "",
					sources
				})
			);
		}
	}
	if (indexable.length > 1) {
		for (const page of indexable) {
			if (page.fetchMode === "rendered" || page.facts?.render?.outcome === "failed") continue;
			const out = page.facts?.page?.internalLinks;
			if (out === 0) found.push(finding(page.pageKey, "no_internal_links_out"));
		}
	}
	return found;
}
