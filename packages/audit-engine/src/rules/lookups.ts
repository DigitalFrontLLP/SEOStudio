import { normalizePageUrl } from "../urls";

import { compileRobots, parseRobots, robotsAllows } from "../robots";
import type { CompiledRobots } from "../robots";
import { hostOfKey } from "../scope";
import type { AuditContext, AuditLink, AuditSite } from "./types";

/**
 * THE LOOKUPS SEVERAL RULE FAMILIES SHARE, built once per audit and kept beside it: the links out of
 * and into each page, robots.txt as Google's crawler reads it, and the pages the crawl was kept from.
 * Pure: each is derived from the audit context alone.
 */

/** The links of one page, made on demand from the audit's link graph. */
export interface PageLinks {
	/**
	 * The links of one page.
	 *
	 * @param key - The page's key.
	 * @returns Its links, or undefined when it has none.
	 */
	get: (key: string) => readonly AuditLink[] | undefined;
}

/**
 * The internal links each page holds, by its key.
 *
 * @param context - The audit.
 * @returns Source key to its links.
 */
export function linksFrom(context: AuditContext): PageLinks {
	return { get: (key) => context.links.from(key) };
}

/**
 * The internal links pointing at each page, by the key they land on.
 *
 * @param context - The audit.
 * @returns Landing key to the links pointing at it.
 */
export function linksTo(context: AuditContext): PageLinks {
	return { get: (key) => context.links.to(key) };
}

/** robots.txt compiled for Googlebot, per site facts. */
const googlebotCache = new WeakMap<AuditSite, CompiledRobots | null>();

/**
 * The URL a link spelled: its kept spelling, or `https://` plus its key when it spelled exactly that.
 *
 * @param link - The link.
 * @returns The URL.
 */
export function linkSpelling(link: AuditLink): string {
	return link.href ?? `https://${link.targetKey}`;
}

/**
 * robots.txt as Googlebot reads it (its own group, else `*`), or null before one was read.
 *
 * @param site - The site facts.
 * @returns The compiled rules, or null.
 */
function googlebotRobots(site: AuditSite): CompiledRobots | null {
	if (googlebotCache.has(site)) return googlebotCache.get(site) ?? null;
	const compiled =
		site.robotsTxt === null || site.robotsTxt.trim() === ""
			? null
			: compileRobots(parseRobots(site.robotsTxt), "Googlebot");
	googlebotCache.set(site, compiled);
	return compiled;
}

/** Each site's robots.txt answers by page key, so the rules that ask about one page share one answer. */
const disallowedCache = new WeakMap<AuditSite, Map<string, boolean>>();

/**
 * Whether robots.txt keeps Google's crawler from a page of the site's own host. A page on another
 * host (its robots.txt was not read) is never called disallowed. Answered once per page per site.
 *
 * @param key - The page key.
 * @param site - The site facts.
 * @returns Whether it is disallowed.
 */
export function disallowedForGoogle(key: string, site: AuditSite): boolean {
	const home = site.homeKey;
	if (home === null || hostOfKey(key) !== hostOfKey(home)) return false;
	const robots = googlebotRobots(site);
	if (robots === null) return false;
	let answers = disallowedCache.get(site);
	if (answers === undefined) {
		answers = new Map();
		disallowedCache.set(site, answers);
	}
	const held = answers.get(key);
	if (held !== undefined) return held;
	const disallowed = !robotsAllows(robots, `https://${key}`);
	answers.set(key, disallowed);
	return disallowed;
}

/**
 * Whether a page is one robots.txt keeps crawlers from: the crawl was refused it, or Googlebot's group
 * disallows it.
 *
 * @param key - The page key.
 * @param context - The audit.
 * @returns Whether it is.
 */
export function robotsDisallowed(key: string, context: AuditContext): boolean {
	return blockedKeys(context).has(key) || disallowedForGoogle(key, context.site);
}

/** The keys the crawl was refused, per site facts. */
const blockedCache = new WeakMap<AuditContext, Set<string>>();

/**
 * The keys of the pages robots.txt kept the crawl from.
 *
 * @param context - The audit.
 * @returns The keys.
 */
function blockedKeys(context: AuditContext): Set<string> {
	let keys = blockedCache.get(context);
	if (keys === undefined) {
		keys = new Set((context.site.robotsBlocked ?? []).map((entry) => entry.pageKey));
		blockedCache.set(context, keys);
	}
	return keys;
}

/**
 * The key a URL names, landed through the site's known variants, or null when it names no page.
 *
 * @param url - The URL.
 * @param context - The audit.
 * @returns The key, or null.
 */
export function landingKey(url: string, context: AuditContext): string | null {
	const key = normalizePageUrl(url);
	return key === null ? null : context.resolve(key);
}
