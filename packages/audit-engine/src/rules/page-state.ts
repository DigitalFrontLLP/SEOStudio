import { normalizePageUrl } from "../urls";

import { SEO_AUDIT_RULES } from "../catalog";
import type { SeoAuditRuleId } from "../catalog";
import { directivesNofollow, directivesNoindex } from "../robots";
import { onSiteOrBelow } from "../scope";
import { auditThresholdsOf } from "../thresholds";
import type { SeoAuditThresholdValues } from "../thresholds";
import type {
	AuditContext,
	AuditFinding,
	AuditPage,
	AuditSitePage,
	AuditSiteSnapshot,
	AuditSnapshot
} from "./types";

/**
 * THE PAGE FACTS EVERY RULE FAMILY SHARES: a finding under the catalog's severity, whether a page is a
 * readable HTML page, whether it is indexable, where its canonical points, and the fresh fetch facts
 * preferred over a snapshot that may be older. Pure.
 */

/**
 * The failure kind of a page the site answered 403 for the browser User-Agent that names the crawler a
 * bot, while it served the same page to the crawler's own plain User-Agent (`../reading`
 * `answersPlainAgent`): its firewall refuses the string, most often for the word `bot`.
 */
export const SEO_BOT_AGENT_REFUSED = "status_403_bot";

/** The failure kinds that say the site refused the crawler, not that the page is broken. */
const CRAWL_BLOCK_ERRORS = new Set([
	"bot_wall",
	"blocked",
	"status_403",
	SEO_BOT_AGENT_REFUSED,
	"status_429"
]);

/** How many examples a finding names. */
export const AUDIT_EXAMPLES = 5;

/**
 * The thresholds an audit judges with: the project's own where it changed one, else the tuned
 * default (`../thresholds`).
 *
 * @param context - The audit.
 * @returns The values.
 */
export function thresholdsOf(context: Pick<AuditContext, "site">): SeoAuditThresholdValues {
	return auditThresholdsOf(context.site.thresholds);
}

/**
 * The checks that find a page sending its visitor on to another page from inside the page (a refresh
 * or a script): the page is a redirect, its body a stand-in nobody reads.
 */
export const PAGE_REDIRECT_RULES: ReadonlySet<string> = new Set([
	"redirect_meta_refresh",
	"redirect_http_refresh",
	"redirect_javascript"
]);

/**
 * A finding under the severity the catalog files its rule at.
 *
 * @param pageKey - The page (the home page for a whole-site check).
 * @param ruleId - The rule.
 * @param params - The numbers it found (never English).
 * @returns The finding.
 */
export function finding(
	pageKey: string,
	ruleId: SeoAuditRuleId,
	params: Record<string, unknown> = {}
): AuditFinding {
	return { pageKey, ruleId, severity: SEO_AUDIT_RULES[ruleId].severity, params };
}

/**
 * Whether the latest fetch was refused by the site (a bot wall, a 403 or 429, a blocked transport).
 *
 * @param page - The page.
 * @returns Whether it was.
 */
export function crawlBlocked(page: AuditSitePage): boolean {
	return page.lastError !== null && CRAWL_BLOCK_ERRORS.has(page.lastError);
}

/**
 * Whether the latest fetch failed on a single day only: the page's state is not known yet.
 *
 * @param page - The page.
 * @returns Whether it is unconfirmed.
 */
export function failureUnconfirmed(page: AuditSitePage): boolean {
	return page.lastError !== null && !crawlBlocked(page) && (page.failCount ?? 2) < 2;
}

/**
 * The page's snapshot when it is a 2xx HTML page read from its HTML, else null.
 *
 * @param page - The page.
 * @returns The snapshot, or null.
 */
export function htmlSnapshot(page: AuditPage): AuditSnapshot | null;
export function htmlSnapshot(page: AuditSitePage): AuditSiteSnapshot | null;
export function htmlSnapshot(page: AuditSitePage): AuditSiteSnapshot | null {
	const snapshot = page.snapshot;
	if (snapshot === null || page.lastError !== null) return null;
	if (page.status !== null && (page.status < 200 || page.status >= 300)) return null;
	if (snapshot.status < 200 || snapshot.status >= 300) return null;
	const type = (snapshot.contentType ?? "").toLowerCase();
	return type === "" || type.includes("html") ? snapshot : null;
}

/**
 * Whether the page tells search engines not to index it.
 *
 * @param snapshot - The page's snapshot.
 * @returns Whether it does.
 */
export function noindexOf(snapshot: AuditSiteSnapshot): boolean {
	return directivesNoindex(snapshot.metaRobots, snapshot.xRobotsTag);
}

/**
 * Whether the page tells search engines not to follow its links.
 *
 * @param snapshot - The page's snapshot.
 * @returns Whether it does.
 */
export function nofollowOf(snapshot: AuditSiteSnapshot): boolean {
	return directivesNofollow(snapshot.metaRobots, snapshot.xRobotsTag);
}

/**
 * The key the page's canonical names, landed through the known variants, or null without one.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns The canonical key, or null.
 */
export function canonicalKey(page: AuditSitePage, context: AuditContext): string | null {
	const raw =
		page.facts?.canonicals[0] ??
		page.snapshot?.canonical ??
		page.facts?.headers.linkCanonical ??
		"";
	if (raw === "") return null;
	const key = normalizePageUrl(raw);
	return key === null ? null : context.resolve(key);
}

/**
 * Whether the page's canonical names another page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Whether it does.
 */
export function canonicalElsewhere(page: AuditSitePage, context: AuditContext): boolean {
	const target = canonicalKey(page, context);
	return target !== null && target !== context.resolve(page.pageKey);
}

/** The temporary redirect statuses: the redirected URL stays the one search engines index. */
const TEMPORARY_REDIRECTS: ReadonlySet<number> = new Set([302, 303, 307]);

/** Per audit, the queries of the copy redirects confirmed on a copy the crawl read. */
const confirmedCopyQueries = new WeakMap<AuditContext, ReadonlySet<string>>();

/**
 * Where a temporary redirect of a page lands, as a key: null for any other page.
 *
 * @param page - The page.
 * @returns The landing key, or null.
 */
function temporaryRedirectTarget(page: AuditSitePage): string | null {
	const status = page.status ?? page.snapshot?.status ?? null;
	if (status === null || !TEMPORARY_REDIRECTS.has(status)) return null;
	const finalUrl = page.snapshot?.finalUrl ?? "";
	const targetKey = finalUrl === "" ? null : normalizePageUrl(finalUrl);
	return targetKey === null || targetKey === page.pageKey ? null : targetKey;
}

/**
 * Whether the page a redirect lands on names the redirected URL as its canonical.
 *
 * @param pageKey - The redirected page.
 * @param targetKey - Where it lands.
 * @param context - The audit.
 * @returns Whether it does.
 */
function namesBack(pageKey: string, targetKey: string, context: AuditContext): boolean {
	const target = context.byKey.get(targetKey);
	const raw =
		target?.facts?.canonicals[0] ??
		target?.snapshot?.canonical ??
		target?.facts?.headers.linkCanonical ??
		"";
	return raw !== "" && normalizePageUrl(raw) === pageKey;
}

/**
 * The query a redirect only appends to the same URL (`?m=1`), or null when it goes elsewhere.
 *
 * @param pageKey - The redirected page.
 * @param targetKey - Where it lands.
 * @returns The appended query, or null.
 */
function appendedQuery(pageKey: string, targetKey: string): string | null {
	if (pageKey.includes("?") || !targetKey.startsWith(`${pageKey}?`)) return null;
	return targetKey.slice(pageKey.length);
}

/**
 * The queries of the copy redirects confirmed on a copy the crawl read, worked out once per audit.
 *
 * @param context - The audit.
 * @returns The queries.
 */
function copyQueries(context: AuditContext): ReadonlySet<string> {
	const known = confirmedCopyQueries.get(context);
	if (known !== undefined) return known;
	const found = new Set<string>();
	for (const page of context.pages) {
		const targetKey = temporaryRedirectTarget(page);
		if (targetKey === null || !namesBack(page.pageKey, targetKey, context)) continue;
		const query = appendedQuery(page.pageKey, targetKey);
		if (query !== null) found.add(query);
	}
	confirmedCopyQueries.set(context, found);
	return found;
}

/**
 * Whether a page's redirect sends the visitor to a copy that names the page back: a temporary redirect
 * (302, 303, 307) whose landing page's canonical is the redirected URL, the way a blog platform sends
 * phones to its `?m=1` copy. Both signals keep the redirected URL the one search engines index, so it
 * stays the right URL to list in a sitemap and to link. A copy the crawl did not read counts when the
 * redirect only appends the same query as a copy that was read and names its page back.
 *
 * @param page - The redirected page.
 * @param context - The audit.
 * @returns Whether it does.
 */
export function copyRedirect(page: AuditSitePage, context: AuditContext): boolean {
	const targetKey = temporaryRedirectTarget(page);
	if (targetKey === null) return false;
	if ((context.byKey.get(targetKey)?.snapshot ?? null) !== null) {
		return namesBack(page.pageKey, targetKey, context);
	}
	const query = appendedQuery(page.pageKey, targetKey);
	return query !== null && copyQueries(context).has(query);
}

/**
 * Whether a page is the copy a {@link copyRedirect} lands on: its canonical names a URL whose
 * temporary redirect sends the visitor here. The URL it names is the one search engines index.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Whether it is.
 */
export function redirectCopy(page: AuditSitePage, context: AuditContext): boolean {
	const raw =
		page.facts?.canonicals[0] ??
		page.snapshot?.canonical ??
		page.facts?.headers.linkCanonical ??
		"";
	const sourceKey = raw === "" ? null : normalizePageUrl(raw);
	if (sourceKey === null || sourceKey === page.pageKey) return false;
	const source = context.byKey.get(sourceKey);
	return (
		source !== undefined &&
		temporaryRedirectTarget(source) === page.pageKey &&
		copyRedirect(source, context)
	);
}

/**
 * The page's snapshot when the page is one search engines are asked to show: a 2xx HTML page read
 * from its HTML, without noindex, whose canonical is itself (or missing). The content rules judge only
 * these, so a deliberately hidden page is never flagged for its title or its text.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns The snapshot, or null.
 */
export function indexableSnapshot(page: AuditPage, context: AuditContext): AuditSnapshot | null;
export function indexableSnapshot(
	page: AuditSitePage,
	context: AuditContext
): AuditSiteSnapshot | null;
export function indexableSnapshot(
	page: AuditSitePage,
	context: AuditContext
): AuditSiteSnapshot | null {
	const snapshot = htmlSnapshot(page);
	if (snapshot === null || snapshot.mode === "rendered") return null;
	if (noindexOf(snapshot) || canonicalElsewhere(page, context)) return null;
	return snapshot;
}

/**
 * Whether a page is the site's home page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Whether it is.
 */
export function isHome(page: AuditSitePage, context: AuditContext): boolean {
	const home = context.site.homeKey;
	if (home === null) return page.pageKey.indexOf("/") === page.pageKey.length - 1;
	return context.resolve(page.pageKey) === context.resolve(home);
}

/**
 * A path segment of a store's cart, checkout or order confirmation, as the common platforms name it
 * (Shopify, WooCommerce, Webflow, PrestaShop, Magento), in the languages most stores use. Only whole
 * segments, and only words no product or category is named by alone.
 */
const CHECKOUT_SEGMENT =
	/^(?:cart|basket|checkouts?|check-out|paypal-checkout|order-confirmation|order-received|order-complete|panier|commande|warenkorb|carrito|winkelwagen|afrekenen|carrello|carrinho|koszyk|varukorg)$/i;

/**
 * Whether a page is a store's cart, checkout or order confirmation, by its path
 * ({@link CHECKOUT_SEGMENT}): no searcher should land on one, and its headings are the platform's.
 *
 * @param pageKey - The page.
 * @returns Whether it is.
 */
export function checkoutPage(pageKey: string): boolean {
	const at = pageKey.indexOf("/");
	const path = (at < 0 ? "" : pageKey.slice(at)).split(/[?#]/)[0] ?? "";
	return path
		.split("/")
		.some((segment) => CHECKOUT_SEGMENT.test(segment.replace(/\.(?:html?|php|aspx)$/i, "")));
}

/**
 * Whether the page has no H1 with text (none at all, or only empty ones: an image with alt text counts
 * as text), and how many empty H1 elements it holds.
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @returns Whether the H1 is missing, and the empty H1 elements.
 */
export function h1MissingOf(
	page: AuditSitePage,
	snapshot: AuditSiteSnapshot
): { missing: boolean; empty: number } {
	const count = page.facts?.page?.h1Count ?? snapshot.h1Count ?? 0;
	const empty = Math.min(count, page.facts?.page?.h1Empty ?? 0);
	if ((snapshot.h1 ?? "").trim() !== "") return { missing: false, empty: 0 };
	return { missing: count === 0 || empty >= count, empty };
}

/**
 * Whether a confirmed status is broken: nothing answered, a 4xx or a 5xx.
 *
 * @param status - The status, or null.
 * @returns Whether it is.
 */
export function brokenStatus(status: number | null): boolean {
	return status !== null && (status === 0 || status >= 400);
}

/**
 * The paths a CDN or a hosting platform reserves on every site it serves for its own scripts, with
 * its own headers and redirects: Cloudflare's `/cdn-cgi/` (bot, email and analytics scripts) and
 * HubSpot's `/_hcms/` and `/hs/` (form and tracking loaders). An image resized there
 * (`/cdn-cgi/image/`) is still the site's own picture, as are HubSpot's `/hs-fs/` and `/hubfs/` files.
 */
const PLATFORM_PATHS = /^\/(?:cdn-cgi\/(?!image\/)|_hcms\/|hs\/)/i;

/**
 * Whether a file on the site's own host is one its CDN or hosting platform serves and manages
 * ({@link PLATFORM_PATHS}): the owner can change neither its headers nor where it redirects.
 *
 * @param url - The file's URL.
 * @returns Whether the platform manages it.
 */
export function platformManaged(url: string): boolean {
	try {
		return PLATFORM_PATHS.test(new URL(url).pathname);
	} catch {
		return false;
	}
}

/**
 * Whether a URL is on the site's own hosts: the page's host, `www.` aside, or one of its subdomains,
 * and not a file its CDN or hosting platform manages there ({@link platformManaged}).
 *
 * @param url - The file's URL.
 * @param siteHost - The page's host, `www.` dropped.
 * @returns Whether the site serves it itself.
 */
export function onOwnHost(url: string, siteHost: string): boolean {
	return onSiteOrBelow(url, siteHost) && !platformManaged(url);
}
