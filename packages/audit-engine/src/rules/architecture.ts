import { normalizePageUrl } from "../urls";

import { SEO_AUDIT_THRESHOLD_SPECS } from "../thresholds";
import {
	AUDIT_EXAMPLES,
	canonicalElsewhere,
	canonicalKey,
	finding,
	htmlSnapshot,
	indexableSnapshot,
	isHome,
	nofollowOf,
	thresholdsOf
} from "./page-state";
import { robotsDisallowed } from "./lookups";
import type { AuditContext, AuditFinding, AuditSitePage } from "./types";

/**
 * THE SITE ARCHITECTURE RULES, which only the whole internal link graph can answer: how deep a page
 * sits, whether search engines can reach it through pages they index, which links carry nofollow, how
 * many pages link to it, and whether a canonical target or a redirecting URL is linked at all.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a rule that says a link is ABSENT (no followed link, a single one, none to a canonical target or a
 *   redirect) runs only on a graph whole enough to say so (`linksComplete`): an unread page may hold the
 *   missing link;
 * - a page is deep only when its depth is exact or truly deeper: every page shallower than the cut was
 *   read, so no unread page hides a shorter path;
 * - the home page is never deep, isolated or short of links, and only pages search engines are asked
 *   to show are judged by the inlink rules (a noindex page or a canonicalised one is left alone);
 * - a page whose one followed link comes from the home page is not short of links (on a small site
 *   that is every page, and a link from the home page is the strongest a site has);
 * - a link is "followed" unless it carries `rel="nofollow"` or its page asks crawlers not to follow
 *   any of its links.
 */

/** The link architecture limits, in one place for the docs and the agent tools. */
export const LINK_THRESHOLDS = {
	/** Clicks from the home page past which a page is deep, by default (`../thresholds`). */
	deepPageClicks: SEO_AUDIT_THRESHOLD_SPECS.deepClicks.value,
	/** Internal links on one page past which it holds very many (an insight). */
	outlinksHighInternal: 1000,
	/** Links off the site on one page past which it holds very many (an insight). */
	outlinksHighExternal: 100
} as const;

/** The links into one page. */
interface Inlinks {
	/** Pages that link to it, and those of them that link to it with a followed link. */
	sources: Set<string>;
	followedSources: Set<string>;
	/** Links to it with and without `rel="nofollow"` (the page-level directive left out). */
	nofollowLinks: number;
	followedLinks: number;
	/** Pages that link to it with `rel="nofollow"`. */
	nofollowSources: Set<string>;
}

/**
 * Whether a crawled page asks crawlers not to follow any of its links.
 *
 * @param page - The page, if crawled.
 * @returns Whether it does.
 */
function pageNofollow(page: AuditSitePage | undefined): boolean {
	const snapshot = page === undefined ? null : htmlSnapshot(page);
	return snapshot !== null && nofollowOf(snapshot);
}

/**
 * The links into every crawled page, by the key each lands on, self links left out (a target never
 * crawled is never judged, so it holds no entry).
 *
 * @param context - The audit.
 * @returns Landing key to its inlinks.
 */
function inlinksOf(context: AuditContext): Map<string, Inlinks> {
	const byTarget = new Map<string, Inlinks>();
	const sourceNofollow = new Map<string, boolean>();
	const crawled = new Set(context.pages.map((page) => context.resolve(page.pageKey)));
	for (const link of context.links) {
		const source = context.resolve(link.sourceKey);
		const target = link.resolvedKey ?? context.resolve(link.targetKey);
		if (source === target || !crawled.has(target)) continue;
		let entry = byTarget.get(target);
		if (entry === undefined) {
			entry = {
				sources: new Set(),
				followedSources: new Set(),
				nofollowLinks: 0,
				followedLinks: 0,
				nofollowSources: new Set()
			};
			byTarget.set(target, entry);
		}
		entry.sources.add(source);
		if (link.nofollow === true) {
			entry.nofollowLinks += 1;
			entry.nofollowSources.add(source);
			continue;
		}
		entry.followedLinks += 1;
		let blocked = sourceNofollow.get(link.sourceKey);
		if (blocked === undefined) {
			blocked = pageNofollow(context.byKey.get(link.sourceKey));
			sourceNofollow.set(link.sourceKey, blocked);
		}
		if (!blocked) entry.followedSources.add(source);
	}
	return byTarget;
}

/**
 * The pages search engines reach from the home page through pages they index: breadth first along
 * followed links whose page is indexable and lets its links be followed, and along the hreflang
 * alternates an indexable page names (search engines find and crawl a page's language versions there,
 * as on a home page that only names its languages and sends visitors on with a script).
 *
 * @param context - The audit.
 * @param indexable - The landing keys of the indexable pages.
 * @param home - The home page's landing key.
 * @returns The keys reached, the home page included.
 */
function reachedThroughIndexable(
	context: AuditContext,
	indexable: ReadonlySet<string>,
	home: string
): Set<string> {
	const out = new Map<string, string[]>();
	for (const link of context.links) {
		if (link.nofollow === true) continue;
		const source = context.resolve(link.sourceKey);
		if (!indexable.has(source) || pageNofollow(context.byKey.get(link.sourceKey))) continue;
		const target = link.resolvedKey ?? context.resolve(link.targetKey);
		const list = out.get(source);
		if (list === undefined) out.set(source, [target]);
		else list.push(target);
	}
	for (const page of context.pages) {
		const source = context.resolve(page.pageKey);
		if (!indexable.has(source)) continue;
		const host = page.pageKey.split("/")[0];
		for (const entry of page.facts?.hreflang ?? page.snapshot?.hreflang ?? []) {
			const key = normalizePageUrl(entry.url, host);
			if (key === null) continue;
			const list = out.get(source);
			if (list === undefined) out.set(source, [context.resolve(key)]);
			else list.push(context.resolve(key));
		}
	}
	const reached = new Set([home]);
	let frontier = [home];
	while (frontier.length > 0) {
		const next: string[] = [];
		for (const key of frontier) {
			if (!indexable.has(key)) continue;
			for (const target of out.get(key) ?? []) {
				if (reached.has(target)) continue;
				reached.add(target);
				next.push(target);
			}
		}
		frontier = next;
	}
	return reached;
}

/**
 * A few of a set's entries, sorted.
 *
 * @param values - The entries.
 * @returns Up to {@link AUDIT_EXAMPLES} of them.
 */
function examples(values: Iterable<string>): string[] {
	return [...values].sort().slice(0, AUDIT_EXAMPLES);
}

/**
 * Whether every click depth up to the deep-page cut is exact: no unread page sits shallower than it.
 *
 * @param context - The audit.
 * @returns Whether deep pages can be judged.
 */
function depthsExact(context: AuditContext): boolean {
	const shallowest = context.graph.shallowestUnread;
	return shallowest === null || shallowest >= thresholdsOf(context).deepClicks;
}

/**
 * The inlink, depth and reachability findings of the indexable pages.
 *
 * @param context - The audit.
 * @param inlinks - The links into every page.
 * @returns The findings.
 */
function indexablePageFindings(
	context: AuditContext,
	inlinks: ReadonlyMap<string, Inlinks>
): AuditFinding[] {
	const found: AuditFinding[] = [];
	const indexablePages = context.pages.filter((page) => indexableSnapshot(page, context) !== null);
	const indexable = new Set(indexablePages.map((page) => context.resolve(page.pageKey)));
	const homeKey = context.site.homeKey === null ? null : context.resolve(context.site.homeKey);
	const reached =
		context.linksComplete && homeKey !== null && indexable.has(homeKey)
			? reachedThroughIndexable(context, indexable, homeKey)
			: null;
	const deepJudged = depthsExact(context);
	const deepClicks = thresholdsOf(context).deepClicks;
	for (const page of indexablePages) {
		const key = context.resolve(page.pageKey);
		const into = inlinks.get(key);
		if (into !== undefined && into.nofollowLinks > 0 && into.followedLinks > 0) {
			found.push(
				finding(page.pageKey, "inlinks_follow_nofollow_mix", {
					nofollow: into.nofollowLinks,
					followed: into.followedLinks,
					pages: examples(into.nofollowSources)
				})
			);
		}
		if (isHome(page, context)) continue;
		const depth = page.clickDepth ?? null;
		if (deepJudged && depth !== null && depth > deepClicks) {
			found.push(finding(page.pageKey, "deep_page", { depth, max: deepClicks }));
		}
		if (!context.linksComplete || into === undefined) continue;
		const followed = into.followedSources.size;
		if (followed === 0) {
			found.push(
				finding(page.pageKey, "inlinks_nofollow_only", {
					count: into.nofollowLinks + into.followedLinks,
					pages: examples(into.sources)
				})
			);
			continue;
		}
		if (followed === 1 && !into.followedSources.has(homeKey ?? "")) {
			found.push(
				finding(page.pageKey, "inlinks_single", { pages: examples(into.followedSources) })
			);
		}
		if (reached !== null && !reached.has(key)) {
			found.push(
				finding(page.pageKey, "isolated_page", {
					count: followed,
					pages: examples(into.followedSources)
				})
			);
		}
	}
	return found;
}

/**
 * A store's action link: putting a product in the cart or the wishlist (WooCommerce's `?add-to-cart=`,
 * a wishlist plugin's `?add_to_wishlist=`, a cart path's `add`). It changes the cart, it is no page,
 * and store platforms mark it nofollow on purpose.
 */
const STORE_ACTION_LINK =
	/[?&](?:add-to-cart|add_to_cart|add-to-wishlist|add_to_wishlist|remove_item)=|\/cart\/add(?:[/?]|$)|\/cart\.php\?(?:[^#]*&)?action=add\b/i;

/**
 * An action URL: a query that names an action (a wiki's `?action=edit`, `index.php?title=...&action=history`,
 * `?veaction=edit`) or a wiki's API (`/w/api.php`). It does something, it is no page.
 */
const ACTION_URL = /[?&](?:action|veaction)=|\/api\.php(?:[?#]|$)/i;

/**
 * The pages that put `rel="nofollow"` on links to the site's own pages, a store's cart and wishlist
 * actions ({@link STORE_ACTION_LINK}) aside, and action URLs ({@link ACTION_URL}) robots.txt keeps
 * crawlers from: a wiki marks its edit and history links nofollow on purpose.
 *
 * @param context - The audit.
 * @returns The findings.
 */
function nofollowOutlinkFindings(context: AuditContext): AuditFinding[] {
	const bySource = new Map<string, Set<string>>();
	for (const link of context.links) {
		if (link.nofollow !== true || STORE_ACTION_LINK.test(link.targetKey)) continue;
		if (ACTION_URL.test(link.targetKey) && robotsDisallowed(link.targetKey, context)) continue;
		const page = context.byKey.get(link.sourceKey);
		if (page === undefined || htmlSnapshot(page) === null) continue;
		const target = link.resolvedKey ?? context.resolve(link.targetKey);
		if (target === context.resolve(link.sourceKey)) continue;
		const targets = bySource.get(link.sourceKey) ?? new Set<string>();
		targets.add(link.targetKey);
		bySource.set(link.sourceKey, targets);
	}
	return [...bySource].map(([source, targets]) =>
		finding(source, "outlinks_internal_nofollow", {
			count: targets.size,
			targets: examples(targets)
		})
	);
}

/**
 * The pages whose canonical names a page of the site no internal link points to.
 *
 * @param context - The audit.
 * @returns The findings.
 */
function canonicalUnlinkedFindings(context: AuditContext): AuditFinding[] {
	if (!context.linksComplete) return [];
	const found: AuditFinding[] = [];
	for (const page of context.pages) {
		if (htmlSnapshot(page) === null || !canonicalElsewhere(page, context)) continue;
		const target = canonicalKey(page, context);
		if (target === null) continue;
		const targetPage = context.byKey.get(target);
		if (targetPage === undefined || htmlSnapshot(targetPage) === null) continue;
		if (context.links.linksIn(target) > 0) continue;
		found.push(finding(page.pageKey, "canonical_unlinked", { targets: [target] }));
	}
	return found;
}

/**
 * The redirecting URLs nothing on the site links to and that no sitemap, search traffic, Analytics or
 * backlink accounts for: reached only through other redirects (or a reference).
 *
 * @param context - The audit.
 * @returns The findings.
 */
function redirectUnlinkedFindings(context: AuditContext): AuditFinding[] {
	if (!context.linksComplete) return [];
	const found: AuditFinding[] = [];
	for (const page of context.pages) {
		const status = page.status ?? page.snapshot?.status ?? null;
		if (status === null || status < 300 || status >= 400 || page.lastError !== null) continue;
		if (page.inSitemap || page.hasTraffic || page.inAnalytics === true || page.backlinked === true)
			continue;
		if (isHome(page, context) || context.links.spells(page.pageKey)) continue;
		found.push(
			finding(page.pageKey, "redirect_unlinked", { target: page.snapshot?.finalUrl ?? "" })
		);
	}
	return found;
}

/**
 * The link architecture findings of the whole site.
 *
 * @param context - The audit.
 * @returns The findings, at most one per page and rule.
 */
export function linkGraphFindings(context: AuditContext): AuditFinding[] {
	return [
		...indexablePageFindings(context, inlinksOf(context)),
		...nofollowOutlinkFindings(context),
		...canonicalUnlinkedFindings(context),
		...redirectUnlinkedFindings(context)
	];
}
