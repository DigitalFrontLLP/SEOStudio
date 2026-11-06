import type { SeoPageAuditFacts, SeoSitePlatformValue } from "../facts";

import type {
	AuditPage,
	AuditSiteBookmarks,
	AuditSiteFacts,
	AuditSitePage,
	AuditSnapshot
} from "./types";

/**
 * A PAGE AS THE WHOLE-SITE RULES HOLD IT: the small part of a page every whole-site rule may read,
 * kept for every page of the site at once while the whole page is read only a batch at a time. Pure.
 */

/**
 * The 32-bit FNV-1a hash of a bookmark id, as the whole-site rules hold a page's ids.
 *
 * @param id - The id.
 * @returns The hash.
 */
export function bookmarkHash(id: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < id.length; index += 1) {
		hash ^= id.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Whether a page holds a bookmark id, read from its own list or from the hashes the whole-site rules
 * keep (a hash two ids share answers yes: a missing bookmark is then left unreported, never invented).
 *
 * @param bookmarks - The page's bookmarks.
 * @param id - The id.
 * @returns Whether it holds it.
 */
export function holdsBookmark(bookmarks: AuditSiteBookmarks, id: string): boolean {
	if (bookmarks.ids !== undefined) return bookmarks.ids.includes(id);
	const hashes = bookmarks.idHashes;
	if (hashes === undefined) return false;
	const wanted = bookmarkHash(id);
	let low = 0;
	let high = hashes.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const value = hashes[middle] ?? 0;
		if (value === wanted) return true;
		if (value < wanted) low = middle + 1;
		else high = middle - 1;
	}
	return false;
}

/**
 * The small part of a page's fetch facts the whole-site rules read.
 *
 * @param facts - The whole facts.
 * @returns The part kept for the whole site.
 */
export function siteFactsOf(facts: SeoPageAuditFacts): AuditSiteFacts {
	const { markup, render, text, checks } = facts;
	return {
		redirectChain: facts.redirectChain,
		responseMs: facts.responseMs,
		sizeBytes: facts.sizeBytes,
		...(facts.htmlUnlabelled === undefined ? {} : { htmlUnlabelled: facts.htmlUnlabelled }),
		page: facts.page,
		headers: facts.headers,
		html: facts.html,
		canonicals: facts.canonicals,
		hreflang: facts.hreflang,
		mixedContent: facts.mixedContent,
		...(markup === undefined
			? {}
			: {
					markup:
						markup === null
							? null
							: {
									lang: markup.lang,
									canonicals: markup.canonicals,
									analytics: markup.analytics,
									ajaxFragmentMeta: markup.ajaxFragmentMeta,
									pagination: markup.pagination,
									amp: markup.amp,
									bookmarks: {
										idHashes: Uint32Array.from(markup.bookmarks.ids, bookmarkHash).sort(),
										idsTruncated: markup.bookmarks.idsTruncated
									},
									openGraphType: markup.openGraph.type,
									...(markup.skeleton === undefined ? {} : { skeleton: markup.skeleton }),
									...(markup.markdownAlternate === undefined
										? {}
										: { markdownAlternate: markup.markdownAlternate }),
									...(markup.platform === undefined ? {} : { platform: markup.platform })
								}
				}),
		...(render === undefined
			? {}
			: { render: render === null ? null : { outcome: render.outcome } }),
		...(text === undefined
			? {}
			: { text: text === null ? null : { minhash: text.minhash, languages: text.languages } }),
		...(checks === undefined
			? {}
			: {
					checks:
						checks === null
							? null
							: checks.spelling === undefined
								? {}
								: { spelling: checks.spelling }
				})
	};
}

/**
 * A snapshot without its heading outline.
 *
 * @param snapshot - The snapshot.
 * @returns It as the whole-site rules hold it.
 */
function siteSnapshotOf(snapshot: AuditSnapshot): Omit<AuditSnapshot, "headings"> {
	const { headings: _headings, ...rest } = snapshot;
	return rest;
}

/**
 * A whole page as the whole-site rules hold it.
 *
 * @param page - The page.
 * @returns The page, its facts cut to the part every whole-site rule reads.
 */
export function sitePageOf(page: AuditPage): AuditSitePage {
	const { facts, snapshot, ...rest } = page;
	return {
		...rest,
		snapshot: snapshot === null ? null : siteSnapshotOf(snapshot),
		...(facts === undefined ? {} : { facts: facts === null ? null : siteFactsOf(facts) })
	};
}

/**
 * THE SITE'S PLATFORM: the site builder or framework its home page shows it was made with (after its
 * redirects), else the one most of its pages show; null when none is recognised.
 *
 * @param pages - The crawled pages as the whole-site rules hold them.
 * @param homeKey - The home page's key, or null.
 * @param resolve - The page a key lands on after the known variants and redirects.
 * @returns The platform, or null.
 */
export function sitePlatformOf(
	pages: readonly AuditSitePage[],
	homeKey: string | null,
	resolve: (key: string) => string
): SeoSitePlatformValue | null {
	const home =
		homeKey === null ? undefined : pages.find((page) => page.pageKey === resolve(homeKey));
	const own = home?.facts?.markup?.platform ?? null;
	if (own !== null) return own;
	const counts = new Map<SeoSitePlatformValue, number>();
	for (const page of pages) {
		const platform = page.facts?.markup?.platform ?? null;
		if (platform !== null) counts.set(platform, (counts.get(platform) ?? 0) + 1);
	}
	let best: SeoSitePlatformValue | null = null;
	for (const [platform, count] of counts) {
		if (count * 2 > pages.length && (best === null || count > (counts.get(best) ?? 0))) {
			best = platform;
		}
	}
	return best;
}
