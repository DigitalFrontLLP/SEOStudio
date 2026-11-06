import { seoCrawlerLimits } from "../config";
import type { SeoSitemapFileFacts } from "../facts";

import type { SeoAuditRuleId } from "../catalog";
import { parseRobots } from "../robots";
import { bareHostOfKey, onSiteOrBelow } from "../scope";
import { disallowedForGoogle } from "./lookups";
import { pageNumber } from "./pagination";
import {
	AUDIT_EXAMPLES,
	brokenStatus,
	canonicalElsewhere,
	canonicalKey,
	copyRedirect,
	crawlBlocked,
	finding,
	htmlSnapshot,
	indexableSnapshot,
	noindexOf,
	redirectCopy
} from "./page-state";
import type { AuditContext, AuditFinding, AuditPage } from "./types";

/**
 * THE SITEMAP RULES: what the sitemaps list, and whether they can be trusted.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a sitemap URL is judged only once the crawler read it, and a URL the site refused the crawler
 *   (403, 429, bot wall) is never called broken;
 * - a URL that differs from the page only by scheme, a trailing slash or tracking parameters is the
 *   same page (one page key), never a redirect;
 * - a URL whose temporary redirect lands on a copy that names it as the canonical (a blog platform
 *   sending phones to its `?m=1` copy; `./page-state` `copyRedirect`) is the right URL to list, never
 *   a redirect in the sitemap, and the copy it lands on is never missing from the sitemap;
 * - "no sitemap" and "uniform dates" are judged only once a plan read the sitemaps (every file, on
 *   every project); uniform dates need at least {@link UNIFORM_LASTMOD_MIN_URLS} dated URLs in one
 *   file, so a small site rebuilt in one go is not flagged;
 * - a sitemap file is judged unreachable or invalid only when robots.txt or a sitemap index named it:
 *   a common path tried on every site that answers nothing is a guess that missed; a file the site
 *   refused the crawler (401, 403, 429) is neither unreachable nor missing, since a firewall that
 *   stops the crawler says nothing about what search engines are served, and no sitemap is called
 *   missing when robots.txt itself refused the crawler (it may name one), nor when robots.txt names
 *   one on another host (a CDN or a storage bucket: search engines accept a sitemap robots.txt names
 *   anywhere; the plan reads it there, and a plan made before it did says nothing either way);
 * - a sitemap that answers as a valid sitemap but lists no page is `sitemap_empty`, never
 *   `sitemap_missing`: the file is there, its generator lists nothing;
 * - a page missing from the sitemaps is judged only when every sitemap was read whole (under the
 *   plan's file and URL caps), never while the crawl samples each URL pattern (the plan then drops
 *   the sitemap URLs it does not crawl, so a page found later by its links may be listed), never on
 *   page 2 or later of a series (archives are left out of sitemaps on purpose), and only on a page
 *   search engines are asked to show.
 */

/** URLs one sitemap file may list (sitemaps.org). */
export const SITEMAP_MAX_URLS = 50_000;

/** Statuses that say the site refused the crawler (a firewall, a rate limit), not that a file is gone. */
const REFUSED: ReadonlySet<number> = new Set([401, 403, 429]);

/** The dated URLs one sitemap file needs before one shared date is called uniform. */
export const UNIFORM_LASTMOD_MIN_URLS = 10;

/**
 * Whether the sitemaps were read whole: some were read, and the plan stopped at neither its file cap
 * nor its URL cap.
 *
 * @param context - The audit.
 * @returns Whether every listed URL is known.
 */
function sitemapsWhole(context: AuditContext): boolean {
	const { sitemapRead, sitemapFiles } = context.site;
	if (sitemapRead !== true || sitemapFiles === null) return false;
	const listed = sitemapFiles.reduce((sum, file) => sum + file.urls, 0);
	return (
		sitemapFiles.length < seoCrawlerLimits.maxSitemapFiles &&
		listed < seoCrawlerLimits.maxSitemapUrls
	);
}

/**
 * A whole-site finding over the sitemap files that show one problem: how many, and a few of their URLs.
 *
 * @param home - The home page key.
 * @param ruleId - The rule.
 * @param files - The files with the problem.
 * @param extra - More params.
 * @returns The finding, or nothing when no file shows it.
 */
function fileFinding(
	home: string,
	ruleId: SeoAuditRuleId,
	files: readonly SeoSitemapFileFacts[],
	extra: Record<string, unknown> = {}
): AuditFinding[] {
	if (files.length === 0) return [];
	return [
		finding(home, ruleId, {
			count: files.length,
			urls: files.map((file) => file.url).slice(0, AUDIT_EXAMPLES),
			...extra
		})
	];
}

/**
 * The sitemap file findings: files that cannot be read or are not sitemaps, files over the limits,
 * and what their entries state.
 *
 * @param home - The home page key.
 * @param files - The files the last plan read.
 * @returns The findings.
 */
function sitemapFileFindings(home: string, files: readonly SeoSitemapFileFacts[]): AuditFinding[] {
	const named = files.filter((file) => file.source !== undefined && file.source !== "guess");
	const unreachable = named.filter(
		(file) =>
			file.status !== undefined &&
			(file.status < 200 || file.status >= 300) &&
			!REFUSED.has(file.status)
	);
	const invalid = files.filter((file) => file.invalid != null);
	const sum = (pick: (file: SeoSitemapFileFacts) => number): number =>
		files.reduce((total, file) => total + pick(file), 0);
	const outOfScope = files.filter((file) => (file.outOfScope?.count ?? 0) > 0);
	const extension = files.filter(
		(file) =>
			(file.extension?.imagesOver ?? 0) +
				(file.extension?.videosIncomplete ?? 0) +
				(file.extension?.newsStale ?? 0) >
			0
	);
	const dates = files.filter(
		(file) => (file.lastmodInvalid?.count ?? 0) + (file.lastmodFuture ?? 0) > 0
	);
	return [
		...fileFinding(home, "sitemap_unreachable", unreachable, {
			status: unreachable[0]?.status ?? 0
		}),
		...fileFinding(home, "sitemap_invalid_xml", invalid, { kind: invalid[0]?.invalid ?? "" }),
		...fileFinding(
			home,
			"sitemap_too_big",
			files.filter((file) => file.urls > SITEMAP_MAX_URLS),
			{ max: SITEMAP_MAX_URLS }
		),
		...fileFinding(home, "sitemap_out_of_scope", outOfScope, {
			listed: sum((file) => file.outOfScope?.count ?? 0),
			examples: outOfScope
				.flatMap((file) => file.outOfScope?.examples ?? [])
				.slice(0, AUDIT_EXAMPLES)
		}),
		...fileFinding(home, "sitemap_extension_invalid", extension, {
			imagesOver: sum((file) => file.extension?.imagesOver ?? 0),
			videosIncomplete: sum((file) => file.extension?.videosIncomplete ?? 0),
			newsStale: sum((file) => file.extension?.newsStale ?? 0)
		}),
		...fileFinding(home, "sitemap_lastmod_invalid", dates, {
			invalid: sum((file) => file.lastmodInvalid?.count ?? 0),
			future: sum((file) => file.lastmodFuture ?? 0),
			examples: dates
				.flatMap((file) => file.lastmodInvalid?.examples ?? [])
				.slice(0, AUDIT_EXAMPLES)
		}),
		...fileFinding(
			home,
			"sitemap_deprecated_tags",
			files.filter((file) => (file.deprecatedTags ?? 0) > 0),
			{ entries: sum((file) => file.deprecatedTags ?? 0) }
		),
		...fileFinding(
			home,
			"sitemap_url_in_multiple",
			files.filter((file) => (file.repeated ?? 0) > 0),
			{ entries: sum((file) => file.repeated ?? 0) }
		)
	];
}

/**
 * The sitemap findings of one page listed in a sitemap.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function sitemapPageFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	if (crawlBlocked(page)) return [];
	if (!page.inSitemap) {
		return sitemapsWhole(context) &&
			context.site.sitemapSampled !== true &&
			(pageNumber(page.pageKey) ?? 1) < 2 &&
			indexableSnapshot(page, context) !== null &&
			!redirectCopy(page, context)
			? [finding(page.pageKey, "page_not_in_sitemap")]
			: [];
	}
	const key = page.pageKey;
	const status = page.status ?? page.snapshot?.status ?? null;
	if (brokenStatus(status)) return [finding(key, "sitemap_error_url", { status: status ?? 0 })];
	if (status !== null && status >= 300 && status < 400) {
		return copyRedirect(page, context) ? [] : [finding(key, "sitemap_redirect_url", { status })];
	}
	const snapshot = htmlSnapshot(page);
	if (snapshot === null || snapshot.mode === "rendered") return [];
	if (noindexOf(snapshot)) return [finding(key, "sitemap_noindex_url")];
	if (canonicalElsewhere(page, context)) {
		return [
			finding(key, "sitemap_non_canonical_url", { target: canonicalKey(page, context) ?? "" })
		];
	}
	return [];
}

/**
 * Whether robots.txt names a sitemap on a host that is not the site's (nor below it): a plan made
 * before the crawler read such files never read it, so the site cannot be called sitemap-less.
 *
 * @param robotsTxt - The robots.txt last read.
 * @param homeKey - The home page's key.
 * @returns Whether it does.
 */
function namesSitemapElsewhere(robotsTxt: string | null, homeKey: string): boolean {
	const site = bareHostOfKey(homeKey);
	return parseRobots(robotsTxt).sitemaps.some(
		(url) => /^https?:\/\/[^/?#\s]+/i.test(url) && !onSiteOrBelow(url, site)
	);
}

/**
 * The whole-site sitemap findings, filed on the home page.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function sitemapSiteFindings(context: AuditContext): AuditFinding[] {
	const { homeKey, sitemapRead, sitemapFiles } = context.site;
	if (homeKey === null || sitemapRead === null) return [];
	const files = sitemapFiles ?? [];
	const fileFound = sitemapFileFindings(homeKey, files);
	const disallowed = new Set(
		(context.site.robotsBlocked ?? [])
			.filter((entry) => entry.inSitemap)
			.map((entry) => entry.pageKey)
	);
	for (const page of context.pages) {
		if (page.inSitemap && !crawlBlocked(page) && disallowedForGoogle(page.pageKey, context.site)) {
			disallowed.add(page.pageKey);
		}
	}
	if (disallowed.size > 0) {
		fileFound.push(
			finding(homeKey, "sitemap_disallowed_url", {
				count: disallowed.size,
				urls: [...disallowed].slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	if (!sitemapRead) {
		const empty = files.filter(
			(file) =>
				file.urls === 0 &&
				file.invalid == null &&
				file.status !== undefined &&
				file.status >= 200 &&
				file.status < 300
		);
		if (empty.length > 0) return [...fileFinding(homeKey, "sitemap_empty", empty), ...fileFound];
		const robotsStatus = context.site.robotsFetch?.status ?? null;
		const named =
			(robotsStatus !== null && REFUSED.has(robotsStatus)) ||
			namesSitemapElsewhere(context.site.robotsTxt, homeKey) ||
			files.some((file) => file.status !== undefined && REFUSED.has(file.status)) ||
			fileFound.some(
				(entry) => entry.ruleId === "sitemap_unreachable" || entry.ruleId === "sitemap_invalid_xml"
			);
		return named ? fileFound : [finding(homeKey, "sitemap_missing"), ...fileFound];
	}
	const uniform = files.filter(
		(file) =>
			file.withLastmod >= UNIFORM_LASTMOD_MIN_URLS &&
			file.withLastmod === file.urls &&
			file.distinctLastmod === 1
	);
	if (uniform.length === 0) return fileFound;
	return [
		finding(homeKey, "sitemap_lastmod_uniform", {
			count: uniform.length,
			urls: uniform.map((file) => file.url)
		}),
		...fileFound
	];
}
