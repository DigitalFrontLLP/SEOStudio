import { normalizePageUrl } from "../urls";

import { parseRefresh } from "../extract-markup";
import { linkSpelling, linksTo } from "./lookups";
import { crawlBlocked, finding } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage } from "./types";

/**
 * THE REDIRECT RULES beyond the chain and the loop (`./status`): what a redirect answers, how it was
 * made, and what it costs.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a redirect is broken only when its last hop answers a real error: a 401, 403 or 429 is the site
 *   refusing the crawler, never proof the target is gone;
 * - a temporary redirect is filed only once the page has answered it for
 *   {@link REDIRECT_TEMPORARY_DAYS} days: a short-lived 302 is what it says;
 * - a hop that changes letter case is filed; a hop that only adds or drops a trailing slash is filed
 *   when the site's own links spell the redirecting URL (or an earlier hop of the site's chain sent
 *   the crawler there): a URL the crawler spelled itself is never blamed on the site; a spelling the
 *   site's links write that the crawler never read is filed from what it answered when the resource
 *   checks asked it, on the page it lands on;
 * - a redirect from https to http is filed, except on the crawler's own slashless spelling of a page
 *   (a server that adds the slash over http): that one is filed only when a link of the site spells
 *   it, as the slash rule above;
 * - a refresh is a redirect only when it sends the visitor to another page; a refresh that reloads
 *   the page (a live score, a dashboard) is not;
 * - a script that moves the browser to another page is filed only when no refresh explains it, naming
 *   where it went; it is a redirect to a broken page when that page was read and answered an error
 *   (a refusal of the crawler aside), as a server redirect ending there is.
 */

/** Days a temporary redirect must have stood before it reads as a permanent move made temporary. */
export const REDIRECT_TEMPORARY_DAYS = 14;

/** The statuses of a temporary redirect. */
const TEMPORARY = new Set([302, 307]);

/** Error statuses that say the site refused the crawler, not that the target is gone. */
const REFUSED = new Set([401, 403, 429]);

/** One step of a redirect chain: the URL that answered, its status, and where it sent the crawler. */
interface Hop {
	index: number;
	from: string;
	status: number;
	to: string;
}

/**
 * The redirect steps of a chain, each with the target exactly as its `Location` spelled it.
 *
 * @param chain - Every hop, the final one included.
 * @returns The steps.
 */
function hopsOf(chain: readonly { url: string; status: number; location?: string }[]): Hop[] {
	const hops: Hop[] = [];
	for (let index = 0; index + 1 < chain.length; index += 1) {
		const current = chain[index];
		const next = chain[index + 1];
		if (current === undefined || next === undefined) continue;
		hops.push({
			index,
			from: current.url,
			status: current.status,
			to: next.location ?? next.url
		});
	}
	return hops;
}

/**
 * A URL with its path's trailing slash dropped and its letters lowercased: two URLs equal under this
 * differ only by a slash or by case.
 *
 * @param url - The URL.
 * @returns Its folded form, or null when it is not a URL.
 */
function folded(url: string): string | null {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/(?<!\/)\/+$/, "") : "/";
		return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * A URL with its path's trailing slash dropped, letter case kept.
 *
 * @param url - The URL.
 * @returns The URL without the slash.
 */
function unslashed(url: string): string {
	return url.replace(/(?<=[^/])\/+(?=$|[?#])/, "");
}

/**
 * A URL without its scheme.
 *
 * @param url - The URL.
 * @returns The URL from its host on.
 */
function schemeless(url: string): string {
	return url.replace(/^https?:\/\//i, "");
}

/** Each audit's link spellings by landing key, built once per landing page. */
const spellingsCache = new WeakMap<AuditContext, Map<string, ReadonlySet<string>>>();

/**
 * Whether the site itself spells a URL: an internal link to the page writes it exactly. The spellings
 * of the links into a landing page are gathered once, so many pages redirecting to one page do not
 * each rescan its inlinks.
 *
 * @param page - The page.
 * @param url - The URL.
 * @param context - The audit.
 * @returns Whether a link spells it.
 */
function linkedAs(page: AuditPage, url: string, context: AuditContext): boolean {
	let cache = spellingsCache.get(context);
	if (cache === undefined) {
		cache = new Map();
		spellingsCache.set(context, cache);
	}
	const landing = context.resolve(page.pageKey);
	let spellings = cache.get(landing);
	if (spellings === undefined) {
		spellings = new Set(
			(linksTo(context).get(landing) ?? []).map((link) => schemeless(linkSpelling(link)))
		);
		cache.set(landing, spellings);
	}
	return spellings.has(schemeless(url));
}

/** Each audit's link spellings that redirect by a slash or a letter case alone, by the page they land on. */
const spellingRedirectsCache = new WeakMap<
	AuditContext,
	Map<string, { from: string; to: string }>
>();

/**
 * A spelling the site's links write for the page that redirects to it by a trailing slash or a letter
 * case alone, as the resource checks found when they asked that spelling (it is never the URL the
 * crawler reads the page at, so the page's own fetch never shows it). Filed on the page it lands on,
 * never again on a page that itself redirects there.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns The redirect, or undefined.
 */
function linkedSpellingRedirect(
	page: AuditPage,
	context: AuditContext
): { from: string; to: string } | undefined {
	let byLanding = spellingRedirectsCache.get(context);
	if (byLanding === undefined) {
		byLanding = new Map();
		for (const [url, answer] of context.site.linkSpellings ?? []) {
			if (answer.error !== null || answer.status < 300 || answer.status >= 400) continue;
			const to = answer.finalUrl;
			const from = folded(url);
			if (to === null || to === url || from === null || from !== folded(to)) continue;
			const landing = normalizePageUrl(to);
			if (landing === null) continue;
			const target = context.resolve(landing);
			if (!byLanding.has(target)) byLanding.set(target, { from: url, to });
		}
		spellingRedirectsCache.set(context, byLanding);
	}
	const landing = context.resolve(page.pageKey);
	return landing === page.pageKey ? byLanding.get(landing) : undefined;
}

/**
 * Where a refresh sends the visitor when that is another page, or null when it reloads this one (under
 * any of its spellings) or names nothing. The page itself may map to the target: the crawl records a
 * refresh as a redirect.
 *
 * @param url - The refresh target, resolved, or null.
 * @param page - The page.
 * @param context - The audit.
 * @returns The target, or null.
 */
function refreshTarget(url: string | null, page: AuditPage, context: AuditContext): string | null {
	if (url === null) return null;
	const key = normalizePageUrl(url);
	if (key !== null && (key === page.pageKey || context.resolve(key) === page.pageKey)) return null;
	return url;
}

/**
 * The redirect findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function redirectFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	if (crawlBlocked(page)) return [];
	const key = page.pageKey;
	const found: AuditFinding[] = [];
	const chain = page.facts?.redirectChain ?? page.snapshot?.redirectChain ?? [];
	const hops = hopsOf(chain);

	const downgrade = hops.find(
		(hop) =>
			/^https:/i.test(hop.from) &&
			/^http:/i.test(hop.to) &&
			(hop.index > 0 ||
				schemeless(unslashed(hop.from)) !== schemeless(unslashed(hop.to)) ||
				linkedAs(page, hop.from, context))
	);
	if (downgrade !== undefined) {
		found.push(finding(key, "redirect_https_to_http", { from: downgrade.from, to: downgrade.to }));
	}

	const spelling = hops.find((hop) => {
		if (hop.from === hop.to) return false;
		const from = folded(hop.from);
		if (from === null || from !== folded(hop.to)) return false;
		const slashOnly = unslashed(hop.from) === unslashed(hop.to);
		return !slashOnly || hop.index > 0 || linkedAs(page, hop.from, context);
	});
	const linked = spelling ?? linkedSpellingRedirect(page, context);
	if (linked !== undefined) {
		found.push(finding(key, "redirect_slash_or_case", { from: linked.from, to: linked.to }));
	}

	const status = page.status ?? page.snapshot?.status ?? null;
	const last = chain.at(-1);
	if (
		status !== null &&
		status >= 300 &&
		status < 400 &&
		last !== undefined &&
		hops.length > 0 &&
		last.status >= 400 &&
		last.status < 600 &&
		!REFUSED.has(last.status) &&
		page.lastError === null
	) {
		found.push(finding(key, "redirect_broken", { status: last.status, target: last.url }));
	}

	const snapshot = page.snapshot;
	const readAt = page.facts?.readAt ?? null;
	if (
		status !== null &&
		TEMPORARY.has(status) &&
		snapshot !== null &&
		snapshot.status === status &&
		typeof snapshot.fetchedAt === "string" &&
		readAt !== null
	) {
		const days = (Date.parse(readAt) - Date.parse(snapshot.fetchedAt)) / 86_400_000;
		if (days >= REDIRECT_TEMPORARY_DAYS) {
			found.push(
				finding(key, "redirect_temporary", {
					status,
					days: Math.floor(days),
					target: snapshot.finalUrl ?? ""
				})
			);
		}
	}

	const markup = page.facts?.markup ?? null;
	const meta = (markup?.refresh ?? [])
		.map((entry) => ({ entry, target: refreshTarget(entry.url, page, context) }))
		.find((entry) => entry.target !== null);
	if (meta !== undefined) {
		found.push(
			finding(key, "redirect_meta_refresh", {
				url: meta.target ?? "",
				...(meta.entry.delaySeconds === null ? {} : { delay: meta.entry.delaySeconds })
			})
		);
	}
	const header = page.facts?.headers.refresh ?? null;
	const base = page.snapshot?.finalUrl ?? `https://${key}`;
	const parsedHeader = header === null ? null : parseRefresh(header, base);
	const headerTarget =
		parsedHeader === null ? null : refreshTarget(parsedHeader.url, page, context);
	if (parsedHeader !== null && headerTarget !== null) {
		found.push(
			finding(key, "redirect_http_refresh", {
				url: headerTarget,
				...(parsedHeader.delaySeconds === null ? {} : { delay: parsedHeader.delaySeconds })
			})
		);
	}

	const render = page.facts?.render ?? null;
	if (
		render !== null &&
		render.outcome === "failed" &&
		render.error === "navigated" &&
		meta === undefined &&
		headerTarget === null
	) {
		found.push(...scriptRedirectFindings(key, render.navigatedTo ?? null, context));
	}
	return found;
}

/**
 * The findings of a page a script sends to another page: the JavaScript redirect, naming where it
 * went, and - when that page was read and answered an error the site did not refuse the crawler with -
 * a redirect to a broken page, as a server redirect ending there is.
 *
 * @param key - The page.
 * @param target - Where the script sent the browser, or null when the reading did not keep it.
 * @param context - The audit.
 * @returns The findings.
 */
function scriptRedirectFindings(
	key: string,
	target: string | null,
	context: AuditContext
): AuditFinding[] {
	if (target === null || target === "") return [finding(key, "redirect_javascript")];
	const found = [finding(key, "redirect_javascript", { target })];
	const targetKey = normalizePageUrl(target);
	const landing = targetKey === null ? undefined : context.byKey.get(targetKey);
	const status = landing?.status ?? landing?.snapshot?.status ?? null;
	if (
		landing !== undefined &&
		status !== null &&
		status >= 400 &&
		status < 600 &&
		!REFUSED.has(status) &&
		!crawlBlocked(landing)
	)
		found.push(finding(key, "redirect_broken", { status, target }));
	return found;
}
