import { normalizePageUrl } from "../urls";

import { primaryLanguage, sameLanguage } from "../language";
import { SEO_READING_LIMITS } from "../reading-limits";
import { compileRobots, parseRobots, robotsAllows } from "../robots";
import type { CompiledRobots } from "../robots";
import { hostOfKey } from "../scope";
import {
	AUDIT_EXAMPLES,
	brokenStatus,
	canonicalElsewhere,
	crawlBlocked,
	failureUnconfirmed,
	finding,
	htmlSnapshot,
	indexableSnapshot,
	noindexOf
} from "./page-state";
import { writtenLanguage } from "./duplicates";
import type { AuditContext, AuditFinding, AuditPage, AuditSitePage } from "./types";

/**
 * THE INTERNATIONAL RULES: the hreflang alternates a page names.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a page without hreflang is never flagged (most sites serve one language), nor the alternates of a
 *   page that is noindex itself: search engines use no hreflang of a page they leave out (its own
 *   noindex is filed for it);
 * - one URL under several codes is fine (en-gb and en-ie may share a page); only one code naming
 *   DIFFERENT pages is a conflict;
 * - a missing return link or a non-canonical alternate is judged only when the crawler read that
 *   alternate; an alternate on another domain is judged for its return link only when the plan read
 *   it (a few per crawl, one per domain: `../host-probe` `readHreflangReturns`) and it answered as an
 *   HTML page;
 * - a missing x-default is a notice: Google calls it recommended, not required;
 * - an x-default is no language: the page it names is never held to it for consistent codes (the
 *   usual x-default is the English page, which calls itself `en`);
 * - an alternate's status, indexability and own codes are judged only when the crawler read it, and
 *   robots.txt only on the site's own host; an alternate never crawled is a notice
 *   (`hreflang_group_incomplete`), and only on a host the crawl covers;
 * - alternates from the HTML and from the `Link` header are one set; naming them in two places (or in
 *   the sitemap too, counted only when every sitemap entry carries alternates) is a notice;
 * - `<html lang>` is judged as a language tag (a 2 or 3 letter language, optional subtags), and against
 *   hreflang only by language, never by region;
 * - a site with pages in several languages and no hreflang anywhere (`hreflang_missing`) is filed once,
 *   and only when each language is a real version of the site: indexable pages written in it (their
 *   `<html lang>` when the text reads in it, else the language the text reads as when it rules the
 *   declared one out, so language spaces that all declare `en` over other text still count), two or
 *   more of them or one whose address names the language (`/fr/`, `fr.`); a lone page in another
 *   language may be no translation of anything.
 */

/** A language (ISO 639-1, or 639-2 for languages without a two-letter code), an optional script and region. */
const CODE = /^(?:x-default|[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?)$/i;

/** Region codes sites often write that ISO 3166-1 does not have (the UK is GB). */
const WRONG_REGIONS = new Set(["uk", "eu"]);

/** One alternate as the rules read it. */
interface Alternate {
	lang: string;
	url: string;
	key: string | null;
}

/**
 * Whether an hreflang code is one search engines accept.
 *
 * @param code - The code as written.
 * @returns Whether it is valid.
 */
function validHreflangCode(code: string): boolean {
	if (!CODE.test(code)) return false;
	const region = code.split("-").at(-1)?.toLowerCase() ?? "";
	return !(code.includes("-") && WRONG_REGIONS.has(region));
}

/**
 * Whether an `<html lang>` value is a well-formed language tag: a 2 or 3 letter language and subtags
 * the standard allows (`en`, `en-GB`, `zh-Hant-TW`); `en_US` and `english` are not.
 *
 * @param value - The value as written.
 * @returns Whether it is.
 */
export function validLangTag(value: string): boolean {
	const tag = value.trim();
	if (!/^[a-z]{2,3}(?:-|$)/i.test(tag)) return false;
	try {
		return Intl.getCanonicalLocales(tag).length === 1;
	} catch {
		return false;
	}
}

/**
 * The language part of a code, lowercased (`en` of `en-GB`).
 *
 * @param code - The code.
 * @returns Its language.
 */
function languageOf(code: string): string {
	return code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

/** Each audit's compiled robots.txt for Google, built once. */
const robotsCache = new WeakMap<AuditContext, CompiledRobots | null>();

/**
 * The site's robots.txt rules for Google, or null when none was read.
 *
 * @param context - The audit.
 * @returns The rules.
 */
function googleRobots(context: AuditContext): CompiledRobots | null {
	if (robotsCache.has(context)) return robotsCache.get(context) ?? null;
	const text = context.site.robotsTxt;
	const compiled = text === null ? null : compileRobots(parseRobots(text), "Googlebot");
	robotsCache.set(context, compiled);
	return compiled;
}

/** Each audit's crawled hosts, built once. */
const hostsCache = new WeakMap<AuditContext, ReadonlySet<string>>();

/**
 * The hosts the crawl read pages on.
 *
 * @param context - The audit.
 * @returns The hosts.
 */
function crawledHosts(context: AuditContext): ReadonlySet<string> {
	const held = hostsCache.get(context);
	if (held !== undefined) return held;
	const hosts = new Set(
		context.pages.filter((page) => page.snapshot !== null).map((page) => hostOfKey(page.pageKey))
	);
	hostsCache.set(context, hosts);
	return hosts;
}

/** The alternates of one page the rules read (the HTML's first, then the `Link` header's). */
const MAX_ALTERNATES = SEO_READING_LIMITS.hreflang;

/** The robots.txt answers one audit keeps for alternate URLs, so a URL many pages name is judged once. */
const MAX_ROBOTS_ANSWERS = 100_000;

/** Each audit's alternates by page key, read once. */
const alternatesCache = new WeakMap<AuditContext, Map<string, Alternate[]>>();

/** Each audit's alternates by page key, indexed by the key each lands on (its codes). */
const returnsCache = new WeakMap<
	AuditContext,
	Map<string, ReadonlyMap<string, readonly string[]>>
>();

/** Each audit's robots.txt answers by alternate URL. */
const robotsAnswers = new WeakMap<AuditContext, Map<string, boolean>>();

/** Each audit's alternates on other domains the plan read, by key, with the pages each names. */
const probedCache = new WeakMap<AuditContext, ReadonlyMap<string, ReadonlySet<string>>>();

/**
 * The alternates on other domains the plan read as pages, each with the pages its own hreflang names
 * (as the keys they land on), built once per audit.
 *
 * @param context - The audit.
 * @returns The names by alternate key.
 */
function probedAlternates(context: AuditContext): ReadonlyMap<string, ReadonlySet<string>> {
	const held = probedCache.get(context);
	if (held !== undefined) return held;
	const probed = new Map<string, ReadonlySet<string>>();
	for (const probe of context.site.hostProbes?.hreflang ?? []) {
		if (probe.names === null) continue;
		probed.set(probe.key, new Set(probe.names.map((name) => context.resolve(name))));
	}
	probedCache.set(context, probed);
	return probed;
}

/**
 * The page's alternates from its HTML and its `Link` header, each with the key it lands on (null when
 * the URL is not absolute), at most {@link MAX_ALTERNATES}, read once per audit.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns The alternates.
 */
function alternatesOf(page: AuditSitePage, context: AuditContext): Alternate[] {
	let cache = alternatesCache.get(context);
	if (cache === undefined) {
		cache = new Map();
		alternatesCache.set(context, cache);
	}
	const held = cache.get(page.pageKey);
	if (held !== undefined) return held;
	const list = [
		...(page.facts?.hreflang ?? page.snapshot?.hreflang ?? []).slice(0, MAX_ALTERNATES),
		...(page.facts?.headers.linkHreflang ?? []).slice(0, MAX_ALTERNATES)
	].slice(0, MAX_ALTERNATES);
	const alternates = list.map((entry) => {
		const absolute = /^https?:\/\//i.test(entry.url.trim());
		const key = absolute ? normalizePageUrl(entry.url) : null;
		return {
			lang: entry.lang.trim().toLowerCase(),
			url: entry.url,
			key: key === null ? null : context.resolve(key)
		};
	});
	cache.set(page.pageKey, alternates);
	return alternates;
}

/**
 * The page's alternates by the key each lands on, with the codes naming it, built once per audit, so
 * the return-link check of each alternate is a lookup.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns The codes by key.
 */
function returnsOf(
	page: AuditSitePage,
	context: AuditContext
): ReadonlyMap<string, readonly string[]> {
	let cache = returnsCache.get(context);
	if (cache === undefined) {
		cache = new Map();
		returnsCache.set(context, cache);
	}
	const held = cache.get(page.pageKey);
	if (held !== undefined) return held;
	const byKey = new Map<string, string[]>();
	for (const entry of alternatesOf(page, context)) {
		if (entry.key === null) continue;
		const codes = byKey.get(entry.key);
		if (codes === undefined) byKey.set(entry.key, [entry.lang]);
		else codes.push(entry.lang);
	}
	cache.set(page.pageKey, byKey);
	return byKey;
}

/**
 * Whether robots.txt lets Google crawl an alternate URL, answered once per URL per audit.
 *
 * @param robots - The site's rules for Google.
 * @param url - The alternate's URL.
 * @param context - The audit.
 * @returns Whether it is allowed.
 */
function robotsAllowAlternate(robots: CompiledRobots, url: string, context: AuditContext): boolean {
	let answers = robotsAnswers.get(context);
	if (answers === undefined) {
		answers = new Map();
		robotsAnswers.set(context, answers);
	}
	const held = answers.get(url);
	if (held !== undefined) return held;
	const allowed = robotsAllows(robots, url);
	if (answers.size < MAX_ROBOTS_ANSWERS) answers.set(url, allowed);
	return allowed;
}

/**
 * The international findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function hreflangFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const snapshot = htmlSnapshot(page);
	if (snapshot === null || snapshot.mode === "rendered") return [];
	const key = page.pageKey;
	const found: AuditFinding[] = [];
	const htmlLang = (page.facts?.markup?.lang.html ?? snapshot.lang ?? "").trim();
	if (htmlLang !== "" && !validLangTag(htmlLang))
		found.push(finding(key, "lang_invalid", { lang: htmlLang.slice(0, 50) }));
	const alternates = alternatesOf(page, context);
	if (alternates.length === 0) return found;
	const self = context.resolve(key);
	if (canonicalElsewhere(page, context))
		return [...found, finding(key, "hreflang_on_canonicalized")];
	if (noindexOf(snapshot)) return found;

	const methods = declaredMethods(page, context);
	if (methods.length >= 2) found.push(finding(key, "hreflang_multiple_methods", { methods }));
	const selfCodes = alternates
		.filter((a) => a.key === self && a.lang !== "x-default")
		.map((a) => languageOf(a.lang));
	if (htmlLang !== "" && selfCodes.length > 0 && !selfCodes.includes(languageOf(htmlLang)))
		found.push(
			finding(key, "hreflang_lang_mismatch", {
				lang: htmlLang.slice(0, 50),
				hreflang: [...new Set(selfCodes)].slice(0, AUDIT_EXAMPLES)
			})
		);

	const invalid = [
		...new Set(alternates.map((a) => a.lang).filter((code) => !validHreflangCode(code)))
	];
	if (invalid.length > 0)
		found.push(finding(key, "hreflang_invalid_code", { codes: invalid.slice(0, AUDIT_EXAMPLES) }));
	const relative = alternates.filter((a) => a.key === null).map((a) => a.url.slice(0, 200));
	if (relative.length > 0)
		found.push(
			finding(key, "hreflang_relative_url", {
				count: relative.length,
				urls: relative.slice(0, AUDIT_EXAMPLES)
			})
		);

	const byCode = new Map<string, Set<string>>();
	for (const a of alternates)
		if (a.key !== null) byCode.set(a.lang, (byCode.get(a.lang) ?? new Set()).add(a.key));
	const conflicting = [...byCode].filter(([, keys]) => keys.size > 1).map(([code]) => code);
	if (conflicting.length > 0)
		found.push(finding(key, "hreflang_conflict", { codes: conflicting.slice(0, AUDIT_EXAMPLES) }));

	const absolute = alternates.filter((a): a is Alternate & { key: string } => a.key !== null);
	if (relative.length === 0 && !absolute.some((a) => a.key === self))
		found.push(finding(key, "hreflang_no_self"));
	if (alternates.length >= 2 && !alternates.some((a) => a.lang === "x-default"))
		found.push(finding(key, "hreflang_missing_x_default"));

	const noReturn = new Set<string>();
	const nonCanonical = new Set<string>();
	const targetError = new Set<string>();
	const notIndexable = new Set<string>();
	const inconsistent = new Set<string>();
	const notCrawled = new Set<string>();
	const robots = googleRobots(context);
	const homeHost = context.site.homeKey === null ? null : hostOfKey(context.site.homeKey);
	for (const a of absolute) {
		if (a.key === self) continue;
		if (
			robots !== null &&
			hostOfKey(a.key) === homeHost &&
			!robotsAllowAlternate(robots, a.url.trim(), context)
		) {
			notIndexable.add(a.key);
			continue;
		}
		const target = context.byKey.get(a.key);
		if (target === undefined || (target.snapshot === null && target.status === null)) {
			const names = target === undefined ? probedAlternates(context).get(a.key) : undefined;
			if (names !== undefined && !names.has(self)) noReturn.add(a.key);
			else if (context.linksComplete && crawledHosts(context).has(hostOfKey(a.key)))
				notCrawled.add(a.key);
			continue;
		}
		if (brokenStatus(target.status) && !failureUnconfirmed(target) && !crawlBlocked(target)) {
			targetError.add(a.key);
			continue;
		}
		const status = target.status ?? target.snapshot?.status ?? null;
		if (status !== null && status >= 300 && status < 400) {
			nonCanonical.add(a.key);
			continue;
		}
		const targetSnapshot = htmlSnapshot(target);
		if ((targetSnapshot?.mode ?? "rendered") === "rendered" || targetSnapshot === null) continue;
		if (noindexOf(targetSnapshot)) {
			notIndexable.add(a.key);
			continue;
		}
		if (canonicalElsewhere(target, context)) {
			nonCanonical.add(a.key);
			continue;
		}
		const back = returnsOf(target, context);
		if (!back.has(self)) noReturn.add(a.key);
		const ownCodes = back.get(a.key) ?? [];
		if (a.lang !== "x-default" && ownCodes.length > 0 && !ownCodes.includes(a.lang))
			inconsistent.add(a.key);
	}
	const listed = (ruleId: Parameters<typeof finding>[1], keys: ReadonlySet<string>): void => {
		if (keys.size === 0) return;
		found.push(
			finding(key, ruleId, { count: keys.size, pages: [...keys].sort().slice(0, AUDIT_EXAMPLES) })
		);
	};
	listed("hreflang_target_error", targetError);
	listed("hreflang_target_not_indexable", notIndexable);
	listed("hreflang_inconsistent_codes", inconsistent);
	listed("hreflang_group_incomplete", notCrawled);
	if (noReturn.size > 0)
		found.push(
			finding(key, "hreflang_no_return", {
				count: noReturn.size,
				pages: [...noReturn].sort().slice(0, AUDIT_EXAMPLES)
			})
		);
	if (nonCanonical.size > 0)
		found.push(
			finding(key, "hreflang_to_non_canonical", {
				count: nonCanonical.size,
				pages: [...nonCanonical].sort().slice(0, AUDIT_EXAMPLES)
			})
		);
	return found;
}

/**
 * The places a page declares its alternates in: its HTML, its `Link` header, and the sitemap (counted
 * only when every entry of every sitemap read carries alternates, so this page's entry does too).
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns The methods, in that order.
 */
function declaredMethods(page: AuditPage, context: AuditContext): string[] {
	const methods: string[] = [];
	if ((page.facts?.hreflang ?? page.snapshot?.hreflang ?? []).length > 0) methods.push("html");
	if ((page.facts?.headers.linkHreflang ?? []).length > 0) methods.push("header");
	const files = context.site.sitemapFiles ?? [];
	const listed = files.reduce((sum, file) => sum + file.urls, 0);
	const withAlternates = files.reduce((sum, file) => sum + (file.hreflang?.urls ?? 0), 0);
	if (page.inSitemap && listed > 0 && withAlternates === listed) methods.push("sitemap");
	return methods;
}

/**
 * Whether a page's address names a language: its first path segment or its first host label is that
 * language's code, alone or with a region (`/fr/`, `/pt-br/`, `es.`).
 *
 * @param key - The page key.
 * @param language - The language.
 * @returns Whether it does.
 */
function addressNamesLanguage(key: string, language: string): boolean {
	const [host = "", segment = ""] = key.split(/[/?#]/);
	return [host.split(".")[0] ?? "", segment].some(
		(label) => /^[a-z]{2,3}(?:[-_][a-z]{2})?$/i.test(label) && sameLanguage(label, language)
	);
}

/**
 * The languages a site's indexable pages are written in, each with its pages: a page counts in the
 * language its `<html lang>` names when its text reads in it, else in the language its text reads as
 * when the text rules the declared one out (`writtenLanguage`). Languages a reader or a detector
 * cannot tell apart are one.
 *
 * @param context - The audit.
 * @returns The page keys by language (its primary code), each list sorted.
 */
function writtenLanguages(context: AuditContext): Map<string, string[]> {
	const byLanguage = new Map<string, string[]>();
	for (const page of context.pages) {
		const snapshot = indexableSnapshot(page, context);
		if (snapshot === null) continue;
		const written = writtenLanguage(page, snapshot);
		if (written === "") continue;
		const language =
			[...byLanguage.keys()].find((held) => sameLanguage(held, written)) ??
			primaryLanguage(written);
		const keys = byLanguage.get(language);
		if (keys === undefined) byLanguage.set(language, [page.pageKey]);
		else keys.push(page.pageKey);
	}
	for (const keys of byLanguage.values()) keys.sort();
	return byLanguage;
}

/**
 * The site notice for language versions no page names in hreflang: two or more languages the site's
 * indexable pages are written in, each with two or more pages or one whose address names it, filed
 * once on the home page with the languages (the most written first) and one page of each (one whose
 * address names its language when there is one).
 *
 * @param context - The audit.
 * @param homeKey - The home page's key.
 * @returns The finding, or none.
 */
function missingHreflangFindings(context: AuditContext, homeKey: string): AuditFinding[] {
	const versions = [...writtenLanguages(context)]
		.filter(
			([language, keys]) =>
				keys.length >= 2 || keys.some((key) => addressNamesLanguage(key, language))
		)
		.sort(([a, left], [b, right]) => right.length - left.length || a.localeCompare(b));
	if (versions.length < 2) return [];
	return [
		finding(homeKey, "hreflang_missing", {
			count: versions.length,
			codes: versions.map(([language]) => language).slice(0, AUDIT_EXAMPLES),
			pages: versions
				.map(
					([language, keys]) =>
						keys.find((key) => addressNamesLanguage(key, language)) ?? keys[0] ?? ""
				)
				.slice(0, AUDIT_EXAMPLES)
		})
	];
}

/**
 * The whole-site international findings: sitemap hreflang sets that are broken (filed on the home
 * page); on a site that uses hreflang, the indexable pages no set names (an insight); on a site that
 * does not, language versions left without it.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function hreflangSiteFindings(context: AuditContext): AuditFinding[] {
	const found: AuditFinding[] = [];
	const homeKey = context.site.homeKey;
	const broken = (context.site.sitemapFiles ?? []).filter(
		(file) =>
			file.hreflang !== undefined &&
			(file.hreflang.namespaceMissing || file.hreflang.incomplete > 0)
	);
	if (homeKey !== null && broken.length > 0)
		found.push(
			finding(homeKey, "hreflang_sitemap_invalid", {
				count: broken.length,
				files: broken.slice(0, AUDIT_EXAMPLES).map((file) => ({
					url: file.url,
					namespaceMissing: file.hreflang?.namespaceMissing ?? false,
					incomplete: file.hreflang?.incomplete ?? 0,
					examples: file.hreflang?.examples ?? []
				}))
			})
		);
	const selves = new Set(context.pages.map((page) => context.resolve(page.pageKey)));
	const referenced = new Set<string>();
	const declaring = new Set<string>();
	for (const page of context.pages) {
		if (htmlSnapshot(page) === null) continue;
		const alternates = alternatesOf(page, context);
		if (alternates.length === 0) continue;
		declaring.add(context.resolve(page.pageKey));
		for (const a of alternates) if (a.key !== null && selves.has(a.key)) referenced.add(a.key);
	}
	if (declaring.size === 0) {
		const sitemapAlternates = (context.site.sitemapFiles ?? []).some(
			(file) => (file.hreflang?.urls ?? 0) > 0
		);
		return homeKey === null || sitemapAlternates
			? found
			: [...found, ...missingHreflangFindings(context, homeKey)];
	}
	for (const page of context.pages) {
		const self = context.resolve(page.pageKey);
		if (declaring.has(self) || referenced.has(self)) continue;
		if (indexableSnapshot(page, context) === null) continue;
		found.push(finding(page.pageKey, "hreflang_page_unreferenced"));
	}
	return found;
}
