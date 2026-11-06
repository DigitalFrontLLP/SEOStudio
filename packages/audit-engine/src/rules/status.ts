import { SEO_AUDIT_THRESHOLD_SPECS } from "../thresholds";
import {
	AUDIT_EXAMPLES,
	crawlBlocked,
	finding,
	htmlSnapshot,
	isHome,
	thresholdsOf
} from "./page-state";
import type { AuditContext, AuditFinding, AuditPage } from "./types";

/**
 * THE CRAWLABILITY RULES: what answered when the page was fetched.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a 403, a 429 or a bot wall is the site refusing THE CRAWLER, a notice (`crawl_blocked`), never a
 *   client error: it does not prove search engines are refused; a site answering 429 to several
 *   pages throttles the crawl as a whole, filed once for the site (`crawl_rate_limited`);
 * - a deleted page is no error by itself (the owner, 2026-10-18), and only what can be fixed is filed:
 *   a 410 (a deliberate removal) only while an internal link from a crawled page or the sitemap still
 *   points to it; a 404 also while a redirect does. Either is then an error that names what points to
 *   it. A 404 nothing on the site points to that still had search clicks over the last 90 days or a
 *   known backlink is a warning worded as an opportunity (`missing_page_with_visitors`: redirect it to
 *   the closest live page to keep those visitors). Search impressions alone are never a finding:
 *   search engines drop a gone page on their own. The home page answering 4xx always is an error;
 * - a loop is told from a chain too long to follow by a URL answering twice;
 * - a wrong content type is filed only when the body is an HTML document (it starts as one) that the
 *   `Content-Type` does not name as HTML: a text file, a feed or an API answer is what it says;
 * - a page answering 2xx is a soft 404 when its title or H1 says "not found", or when its title is only
 *   the site's name AND its main text is only a shop's empty listing notice (`emptyListing`, from
 *   `../text-facts`): a product or category gone empty that still answers 200. Either alone is no
 *   error page: many sites title every page with their name, and a real category may be empty a while.
 */

/** Hops from which a redirect chain is filed by default (a project may change it: `../thresholds`). */
export const REDIRECT_CHAIN_HOPS = SEO_AUDIT_THRESHOLD_SPECS.redirectHops.value;

/** URL length (characters of the page key) past which a URL is very long, by default. */
export const URL_MAX_LENGTH = SEO_AUDIT_THRESHOLD_SPECS.urlMaxChars.value;

/** Words under which a page whose title or H1 says "not found" is an error page. */
const SOFT_404_MAX_WORDS = 250;

/** A title or H1 that says the page was not found, in the languages most sites use. */
const NOT_FOUND_TEXT =
	/(?:^|\b)(?:page not found|not found|seite nicht gefunden|página no encontrada|pagina no encontrada|page introuvable|page non trouvée|pagina non trovata|pagina niet gevonden|página não encontrada|strona nie znaleziona)(?:\b|$)/i;

/**
 * A part of a title or H1 that is the bare error code ("404", "Error 404", "Oops! 404"): the number
 * inside a longer name ("Custom 404 page", an article about error pages) is no error page.
 */
const BARE_404 = /^(?:(?:error|oops|sorry|http)\W*)*404(?:\W*(?:error|oops))*\W*$/i;

/**
 * Whether a title or H1 says the page was not found: a not-found phrase, or the bare error code as
 * one of the parts a separator splits it into (a site name after a bar is its own part).
 *
 * @param text - The title or H1.
 * @returns Whether it does.
 */
function saysNotFound(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length > 80) return false;
	if (NOT_FOUND_TEXT.test(trimmed)) return true;
	return trimmed.split(/\s[|\-–—:·]\s|\s*[|·]\s*/).some((part) => BARE_404.test(part.trim()));
}

/**
 * A name as it is compared: lowercase, apostrophes and other punctuation dropped, spaces collapsed
 * ("Pastry Chef's Boutique" and "Pastry Chefs Boutique" are one name).
 *
 * @param text - The name.
 * @returns The comparable form.
 */
function nameKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/['’`]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Whether a page's title is only the site's name: the name its own `og:site_name` gives, or the home
 * page's title or the first or last part of it (a separator splits off the site name).
 *
 * @param page - The page.
 * @param title - Its title.
 * @param context - The audit.
 * @returns Whether it is.
 */
function titleIsSiteName(page: AuditPage, title: string, context: AuditContext): boolean {
	const key = nameKey(title);
	if (key === "") return false;
	const names = new Set<string>();
	const own = page.facts?.markup?.openGraph.siteName ?? null;
	if (own !== null) names.add(nameKey(own));
	const home = context.site.homeKey;
	const homeTitle = home === null ? null : (context.byKey.get(home)?.snapshot?.title ?? null);
	if (homeTitle !== null) {
		const parts = homeTitle.split(/\s[|\-–—:·]\s|\s*[|·]\s*/);
		for (const text of [homeTitle, parts[0] ?? "", parts.at(-1) ?? ""]) names.add(nameKey(text));
	}
	names.delete("");
	return names.has(key);
}

/**
 * The hops of a redirect chain, and whether one URL, spelled exactly (a hop that only adds a trailing
 * slash or changes the case is a real redirect, not a loop), answered twice in it.
 *
 * @param chain - Every hop, the final one included.
 * @returns The hops and whether it loops.
 */
function chainShape(chain: readonly { url: string; location?: string }[]): {
	hops: number;
	loop: boolean;
} {
	const seen = new Set<string>();
	let loop = false;
	for (const hop of chain) {
		const key = hop.location ?? hop.url;
		if (seen.has(key)) loop = true;
		seen.add(key);
	}
	return { hops: Math.max(0, chain.length - 1), loop };
}

/** The failure kind of a page the site answered 429 Too Many Requests. */
const RATE_LIMITED = "status_429";

/**
 * The pages answering 429 from which the site is throttling the crawl as a whole: it is then filed
 * once for the site (`crawl_rate_limited`), never page by page.
 */
export const RATE_LIMITED_PAGES = 3;

/** The pages each audit found answering 429, read once per audit. */
const rateLimitedCache = new WeakMap<AuditContext, string[]>();

/**
 * The pages whose latest fetch the site answered 429 Too Many Requests.
 *
 * @param context - The audit.
 * @returns Their keys.
 */
function rateLimitedPages(context: AuditContext): string[] {
	const held = rateLimitedCache.get(context);
	if (held !== undefined) return held;
	const keys = context.pages
		.filter((page) => page.lastError === RATE_LIMITED)
		.map((page) => page.pageKey);
	rateLimitedCache.set(context, keys);
	return keys;
}

/**
 * The whole-site throttling check: the site answered 429 Too Many Requests to
 * {@link RATE_LIMITED_PAGES} pages or more, so the crawl backed off and left them unread.
 *
 * @param context - The audit.
 * @returns The finding, filed on the home page, or nothing.
 */
export function rateLimitFindings(context: AuditContext): AuditFinding[] {
	const home = context.site.homeKey;
	const pages = rateLimitedPages(context);
	if (home === null || pages.length < RATE_LIMITED_PAGES) return [];
	return [
		finding(home, "crawl_rate_limited", {
			count: pages.length,
			pages: [...pages].sort().slice(0, AUDIT_EXAMPLES)
		})
	];
}

/** The pages each audit found redirecting, by the page they land on, read once per audit. */
const redirectSourcesCache = new WeakMap<AuditContext, Map<string, string[]>>();

/**
 * The pages that redirect to each page: a held page answering 3xx whose redirect lands there.
 *
 * @param context - The audit.
 * @returns The redirecting pages by the page they land on.
 */
function redirectSources(context: AuditContext): Map<string, string[]> {
	const held = redirectSourcesCache.get(context);
	if (held !== undefined) return held;
	const sources = new Map<string, string[]>();
	for (const page of context.pages) {
		const status = page.status ?? page.snapshot?.status ?? null;
		if (status === null || status < 300 || status >= 400) continue;
		const target = context.resolve(page.pageKey);
		if (target === page.pageKey) continue;
		const list = sources.get(target);
		if (list === undefined) sources.set(target, [page.pageKey]);
		else list.push(page.pageKey);
	}
	redirectSourcesCache.set(context, sources);
	return sources;
}

/**
 * The finding of a page answering 4xx, by what still points to it: an error while an internal link or
 * the sitemap does (for a 404, a redirect too), naming them; for a 404 nothing on the site points to, a
 * warning while it still had search clicks over the last 90 days or a known backlink; else nothing (a
 * deleted page nobody points to). The home page answering 4xx is always an error.
 *
 * @param page - The page.
 * @param status - Its status (4xx).
 * @param context - The audit.
 * @returns The finding, or null.
 */
function missingPageFinding(
	page: AuditPage,
	status: number,
	context: AuditContext
): AuditFinding | null {
	const key = context.resolve(page.pageKey);
	const linking = [
		...new Set(
			(context.links.to(key) ?? [])
				.map((link) => link.sourceKey)
				.filter((source) => context.resolve(source) !== key)
		)
	].sort();
	const redirects = status === 410 ? [] : (redirectSources(context).get(key) ?? []);
	if (isHome(page, context) || linking.length > 0 || page.inSitemap || redirects.length > 0) {
		return finding(page.pageKey, "status_client_error", {
			status,
			links: linking.length,
			sitemap: page.inSitemap ? 1 : 0,
			redirects: redirects.length,
			...(linking.length === 0 ? {} : { pages: linking.slice(0, AUDIT_EXAMPLES) }),
			...(redirects.length === 0
				? {}
				: { examples: [...redirects].sort().slice(0, AUDIT_EXAMPLES) })
		});
	}
	if (status === 410) return null;
	const clicks = context.site.google?.search?.get(page.pageKey)?.clicks ?? 0;
	const backlinks = page.backlinked === true;
	if (clicks <= 0 && !backlinks) return null;
	return finding(page.pageKey, "missing_page_with_visitors", {
		status,
		clicks,
		backlinks: backlinks ? 1 : 0
	});
}

/**
 * The crawlability findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function statusFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const found: AuditFinding[] = [];
	const key = page.pageKey;
	const t = thresholdsOf(context);
	if (crawlBlocked(page)) {
		if (page.lastError === RATE_LIMITED && rateLimitedPages(context).length >= RATE_LIMITED_PAGES)
			return found;
		found.push(finding(key, "crawl_blocked", { reason: page.lastError ?? "" }));
		return found;
	}
	const chain = page.facts?.redirectChain ?? page.snapshot?.redirectChain ?? [];
	const shape = chainShape(chain);
	if (page.lastError === "too_many_redirects") {
		found.push(
			shape.loop
				? finding(key, "redirect_loop", { hops: shape.hops })
				: finding(key, "redirect_too_many", { hops: shape.hops })
		);
		return found;
	}
	if (page.status === 0) {
		found.push(finding(key, "unreachable", { error: page.lastError ?? "" }));
		return found;
	}
	const status = page.status ?? page.snapshot?.status ?? null;
	if (status === null) return found;
	if (status >= 500) found.push(finding(key, "status_server_error", { status }));
	else if (status >= 400) {
		const missing = missingPageFinding(page, status, context);
		if (missing !== null) found.push(missing);
	} else if (status >= 300 && status < 400) {
		found.push(finding(key, "redirect", { status, target: page.snapshot?.finalUrl ?? "" }));
	}
	if (shape.loop) found.push(finding(key, "redirect_loop", { hops: shape.hops }));
	else if (shape.hops >= t.redirectHops)
		found.push(finding(key, "redirect_chain", { hops: shape.hops }));
	if (key.length > t.urlMaxChars) {
		found.push(finding(key, "url_too_long", { length: key.length, max: t.urlMaxChars }));
	}
	if (status >= 200 && status < 300 && page.facts?.htmlUnlabelled === true) {
		const contentType = page.facts.headers.contentType ?? page.snapshot?.contentType ?? "";
		found.push(finding(key, "bad_content_type", { contentType: contentType.trim() || "none" }));
	}
	const snapshot = htmlSnapshot(page);
	if (snapshot === null) return found;
	if (snapshot.mode !== "rendered" && !isHome(page, context)) {
		const words = snapshot.wordCount ?? 0;
		const says = [snapshot.title, snapshot.h1].some((text) => text !== null && saysNotFound(text));
		const emptyListing =
			page.facts?.text?.emptyListing === true &&
			snapshot.title !== null &&
			titleIsSiteName(page, snapshot.title, context);
		if ((says || emptyListing) && words < SOFT_404_MAX_WORDS)
			found.push(finding(key, "soft_404_page"));
	}
	return found;
}

/**
 * The whole-site soft-404 check: a URL that cannot exist answered 2xx (on its own, or after a
 * redirect, often to the home page). A probe that got no answer, or a 401/403, is not judged, nor one
 * whose page says `noindex`: Google names that as a way to keep an error page answering 200 out of
 * its index (an app that cannot send a 404 status).
 *
 * @param context - The audit.
 * @returns The finding, filed on the home page, or nothing.
 */
export function soft404CatchAll(context: AuditContext): AuditFinding[] {
	const probe = context.site.soft404;
	const home = context.site.homeKey;
	if (probe === null || home === null || probe.noindex === true) return [];
	if (probe.finalStatus < 200 || probe.finalStatus >= 300) return [];
	return [
		finding(home, "soft_404_catch_all", {
			url: probe.url,
			finalStatus: probe.finalStatus,
			...(probe.landedOn === null ? {} : { landedOn: probe.landedOn })
		})
	];
}
