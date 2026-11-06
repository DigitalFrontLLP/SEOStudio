import { seoCrawlerLimits } from "./config";
import { crawlKeyOf, pageReferences } from "./discovery";
import type { SeoUrlRules } from "./discovery";
import { parseRefresh } from "./extract-markup";
import type { SeoPageLinkPlacementValue } from "./facts";
import type { SeoRenderedReading } from "./reading";
import { isInternalUrl, keyInScope } from "./scope";
import type { SiteScope } from "./scope";
import type { ExtractedPage } from "./types";

/**
 * WHERE A CRAWLED PAGE LEADS: its links as a crawl keeps them, and the internal pages it points
 * crawlers at (its links, the URLs it references without linking, a refresh, a script redirect), each
 * URL keyed by the crawl's URL rules. Pure.
 */

/** What reading a page's links needs to know of the crawl: the site and its URL rules. */
export interface SeoLinkContext {
	scope: SiteScope;
	rules: SeoUrlRules;
}

/** One link as a crawl keeps it. */
export interface StoredLink {
	targetKey: string | null;
	targetHost: string | null;
	/** The URL as the link spelled it: every external link, an internal one only when it differs from its key. */
	href: string | null;
	anchor: string;
	placement: SeoPageLinkPlacementValue;
	nofollow: boolean;
}

/** Links to these files are never crawled as pages. */
export const ASSET_PATH =
	/\.(?:jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|gz|rar|7z|mp4|webm|mov|mp3|wav|ogg|css|js|mjs|json|xml|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|eot)$/i;

/** An internal URL a crawled page leads to. */
export interface DiscoveredTarget {
	key: string;
	url: string;
	follow: boolean;
}

/**
 * The URL a link spelled, kept beside its key only where the key hides something: always for an
 * external link, and for an internal one when it is not simply `https://` plus its key.
 *
 * @param href - The link's absolute URL.
 * @param key - Its page key, or null for an external link.
 * @returns The spelling to keep, or null.
 */
function spelledHref(href: string, key: string | null): string | null {
	const kept = href.slice(0, 2000);
	return key !== null && kept === `https://${key}` ? null : kept;
}

/**
 * Turns a page's links into stored links and the new internal pages they name, each URL keyed by the
 * project's URL rules.
 *
 * @param context - The crawl.
 * @param extracted - The page.
 * @returns The links to store and the internal keys (with a raw URL) the page points at.
 */
export function readLinks(
	context: SeoLinkContext,
	extracted: ExtractedPage
): {
	stored: StoredLink[];
	internal: DiscoveredTarget[];
	internalCount: number;
	externalCount: number;
} {
	const stored: StoredLink[] = [];
	const internal: DiscoveredTarget[] = [];
	const seen = new Set<string>();
	let internalCount = 0;
	let externalCount = 0;
	for (const link of extracted.links) {
		let host: string;
		try {
			host = new URL(link.href).hostname.toLowerCase();
		} catch {
			continue;
		}
		const isInternal = isInternalUrl(context.scope, link.href);
		const key = isInternal ? crawlKeyOf(link.href, context.rules) : null;
		if (isInternal && (key === null || !keyInScope(context.scope, key))) continue;
		if (isInternal) internalCount += 1;
		else externalCount += 1;
		if (key !== null) internal.push({ key, url: link.href, follow: !link.nofollow });
		const href = spelledHref(link.href, key);
		const dedupe = `${key ?? host}\u0000${href ?? ""}\u0000${link.placement}\u0000${link.anchor}`;
		if (seen.has(dedupe) || stored.length >= seoCrawlerLimits.maxLinksPerPage) continue;
		seen.add(dedupe);
		stored.push({
			targetKey: key,
			targetHost: key === null ? host : null,
			href,
			anchor: link.anchor.slice(0, 500),
			placement: link.placement,
			nofollow: link.nofollow
		});
	}
	return { stored, internal, internalCount, externalCount };
}

/**
 * The internal URLs a page points crawlers at without linking (canonical, hreflang, next/prev, AMP),
 * from its raw HTML, its render and its `Link` header, keyed by the project's URL rules.
 *
 * @param context - The crawl.
 * @param pages - The page as read raw and as rendered (either may be null).
 * @param linkHeader - The response's `Link` header, or null.
 * @param base - The URL the page answered at.
 * @returns The targets, each once.
 */
export function readReferences(
	context: SeoLinkContext,
	pages: readonly (ExtractedPage | null)[],
	linkHeader: string | null,
	base: string
): DiscoveredTarget[] {
	const found = new Map<string, DiscoveredTarget>();
	for (const page of pages) {
		if (page === null) continue;
		for (const url of pageReferences(page, linkHeader, base)) {
			if (!isInternalUrl(context.scope, url)) continue;
			const key = crawlKeyOf(url, context.rules);
			if (key !== null && keyInScope(context.scope, key) && !found.has(key))
				found.set(key, { key, url, follow: true });
		}
	}
	return [...found.values()];
}

/**
 * Where a page's REFRESH sends the visitor, as a crawl target: a `<meta http-equiv="refresh">` or a
 * `Refresh` header naming another page of the site. Search engines follow both as a redirect (an
 * instant one as a permanent move), so the crawl does too; a refresh that reloads the page, or leaves
 * the site, names nothing.
 *
 * @param context - The crawl.
 * @param pageKey - The page's key.
 * @param page - The page as read raw.
 * @param refreshHeader - The response's `Refresh` header, or null.
 * @param base - The URL the page answered at.
 * @returns The target, or null.
 */
export function refreshTargetOf(
	context: SeoLinkContext,
	pageKey: string,
	page: ExtractedPage,
	refreshHeader: string | null,
	base: string
): DiscoveredTarget | null {
	const urls = (page.markup?.refresh ?? []).map((entry) => entry.url);
	if (refreshHeader !== null) urls.push(parseRefresh(refreshHeader, base).url);
	for (const url of urls) {
		if (url === null || !isInternalUrl(context.scope, url)) continue;
		const key = crawlKeyOf(url, context.rules);
		if (key === null || key === pageKey || !keyInScope(context.scope, key)) continue;
		return { key, url, follow: true };
	}
	return null;
}

/**
 * Where a page's SCRIPT sent the browser, as a crawl target: the render ended on another page of the
 * site (a JavaScript redirect). Search engines that render follow it, so the crawl reads where it
 * lands and the audit can tell a script redirect to a broken page; one that leaves the site, or comes
 * back to the page, names nothing.
 *
 * @param context - The crawl.
 * @param pageKey - The page's key.
 * @param rendered - The page's render, or null.
 * @returns The target, or null.
 */
export function scriptTargetOf(
	context: SeoLinkContext,
	pageKey: string,
	rendered: SeoRenderedReading | null
): DiscoveredTarget | null {
	if (rendered === null || rendered.error !== "navigated") return null;
	const url = rendered.finalUrl;
	if (!isInternalUrl(context.scope, url)) return null;
	const key = crawlKeyOf(url, context.rules);
	if (key === null || key === pageKey || !keyInScope(context.scope, key)) return null;
	return { key, url, follow: true };
}
