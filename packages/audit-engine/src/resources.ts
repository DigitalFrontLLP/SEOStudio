import { seoResourceCheckLimits } from "./config";
import type { SeoPageRenderResourceFailure, SeoResourceKindValue } from "./facts";

import { isDocumentUrl } from "./document-facts";
import type { SeoRenderedReading } from "./reading";
import { SEO_READING_LIMITS } from "./reading-limits";
import { isInternalHost } from "./scope";
import type { SiteScope } from "./scope";
import type { ExtractedPage } from "./types";

/**
 * WHAT ONE PAGE REFERENCES FOR THE RESOURCE CHECKS: the files the page loads (the markup read's list, `./extract-markup`),
 * the requests its render could not complete, and its links to other sites. Pure: the crawl's commit
 * (the host's crawl, or `./site` for a standalone one) hands the list to the store, which keeps one row per URL per site.
 */

/** The most link spellings of one site asked about. */
export const SEO_LINK_SPELLINGS_PER_SITE = 200;

/** One URL a page references, with how the page uses it. */
export interface SeoPageResourceRef {
	/** The absolute http(s) URL, fragment dropped. */
	url: string;
	kind: SeoResourceKindValue;
}

/**
 * A URL as the resource checks key it: absolute http(s), fragment dropped.
 *
 * @param value - The URL as read.
 * @returns The URL, or null when it is not an http(s) URL.
 */
export function resourceUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

/** What a failed render request was, as a resource. */
const FAILURE_KINDS: Readonly<Record<SeoPageRenderResourceFailure["type"], SeoResourceKindValue>> =
	{
		script: "script",
		stylesheet: "stylesheet",
		xhr: "other",
		fetch: "other",
		other: "other"
	};

/**
 * Whether a resource is an outbound link (checked by HEAD alone, its answer shared across projects)
 * rather than a file the page loads.
 *
 * @param kind - How the page uses it.
 * @returns Whether it is a link.
 */
export function isOutboundLink(kind: SeoResourceKindValue): boolean {
	return kind === "link";
}

/**
 * 4xx answers that are a site refusing a crawler, asking for a pause or timing the request out,
 * never a sign the page is gone.
 */
const OUTBOUND_REFUSALS: ReadonlySet<number> = new Set([401, 403, 407, 408, 429, 451]);

/** The part of an outbound link's check its failure is read from. */
export interface SeoOutboundCheck {
	finalStatus: number | null;
	error: string | null;
}

/**
 * The definite failure an outbound link's check answered: the page is gone (`gone`: a 4xx other than
 * a refusal, or a host that does not exist in DNS) or its server failed (`server`: a 5xx other than
 * 503, which is as often a bot wall as an outage). Null for a live page, a refusal, and every
 * transient failure (a timeout, a network error, a resolver that could not answer).
 *
 * @param check - The check.
 * @returns The failure, or null.
 */
export function outboundFailure(check: SeoOutboundCheck): "gone" | "server" | null {
	if (check.error === "dns_not_found") return "gone";
	if (check.error !== null || check.finalStatus === null) return null;
	const status = check.finalStatus;
	if (status >= 400 && status < 500) return OUTBOUND_REFUSALS.has(status) ? null : "gone";
	if (status >= 500 && status < 600 && status !== 503) return "server";
	return null;
}

/**
 * Whether an outbound link's check failed for a reason that may pass (no answer in time, a network
 * error), so it is asked again soon rather than trusted.
 *
 * @param check - The check.
 * @returns Whether it was transient.
 */
export function outboundTransient(check: SeoOutboundCheck): boolean {
	return check.error === "timeout" || check.error === "network";
}

/**
 * Whether an outbound link's failure is CONFIRMED: two checks in a row answered a definite failure,
 * and for a server failure the two fell on different days (an outage passes).
 *
 * @param check - The latest check, with its run of failures.
 * @param check.failCount - Checks in a row that failed, the latest included.
 * @param check.failingSince - When that run began.
 * @param check.checkedAt - When the latest check was made.
 * @returns Whether the link is broken.
 */
export function outboundBroken(
	check: SeoOutboundCheck & {
		failCount: number;
		failingSince: Date | null;
		checkedAt: Date | null;
	}
): boolean {
	const failure = outboundFailure(check);
	if (failure === null || check.failCount < 2) return false;
	if (failure === "gone") return true;
	if (check.failingSince === null || check.checkedAt === null) return false;
	return (
		check.failingSince.toISOString().slice(0, 10) !== check.checkedAt.toISOString().slice(0, 10)
	);
}

/**
 * The URL a resource row is keyed by within its site: the URL, prefixed for an outbound link and for a
 * link spelling, so the same URL loaded by one page and linked to by another is checked both ways.
 *
 * @param url - The URL.
 * @param kind - How a page uses it.
 * @returns The key.
 */
export function resourceKey(url: string, kind: SeoResourceKindValue): string {
	return isOutboundLink(kind) || kind === "spelling" ? `${kind}|${url}` : url;
}

/**
 * Whether a link's spelling of a page of the site is worth asking about on its own: it names the same
 * host as the URL the crawler reads the page at but writes another path (a trailing slash, a doubled
 * slash), so what it answers was never read. A spelling that differs only by its scheme
 * (`links_to_http` files it) or its query (`url_session_or_tracking`) is not.
 *
 * @param spelled - The URL the link wrote, absolute.
 * @param fetched - The URL the crawler reads the page at.
 * @returns Whether to check it.
 */
export function linkSpellingToCheck(spelled: string, fetched: string): boolean {
	try {
		const link = new URL(spelled);
		const page = new URL(fetched);
		if (link.protocol !== "http:" && link.protocol !== "https:") return false;
		return link.host.toLowerCase() === page.host.toLowerCase() && link.pathname !== page.pathname;
	} catch {
		return false;
	}
}

/**
 * The resources a page references, deduplicated by key in document order: the files it loads first,
 * then the documents it links to (on the site or off it: a PDF, an office file), then its links to
 * other sites (a document off the site is also checked as an outbound link),
 * each list capped by {@link seoResourceCheckLimits}; a URL too long to carry is left out.
 *
 * @param scope - The site, to tell its own links from links off it.
 * @param page - The page as stored (rendered when the browser rendered it).
 * @param rendered - The render, for the requests it could not complete; null when there was none.
 * @returns The references.
 */
export function pageResourceRefs(
	scope: SiteScope,
	page: ExtractedPage,
	rendered: Pick<SeoRenderedReading, "failedResources"> | null
): SeoPageResourceRef[] {
	const seen = new Set<string>();
	const loads: SeoPageResourceRef[] = [];
	const documents: SeoPageResourceRef[] = [];
	const links: SeoPageResourceRef[] = [];
	const add = (
		into: SeoPageResourceRef[],
		url: string | null,
		kind: SeoResourceKindValue,
		max: number
	): void => {
		if (url === null || url.length > SEO_READING_LIMITS.textChars || into.length >= max) return;
		const key = resourceKey(url, kind);
		if (seen.has(key)) return;
		seen.add(key);
		into.push({ url, kind });
	};
	const { resourcesPerPage, outboundLinksPerPage, documentsPerPage } = seoResourceCheckLimits;
	for (const resource of page.markup?.resources ?? []) {
		add(loads, resourceUrl(resource.url), resource.kind, resourcesPerPage);
	}
	for (const failure of rendered?.failedResources ?? []) {
		add(loads, resourceUrl(failure.url), FAILURE_KINDS[failure.type], resourcesPerPage);
	}
	for (const link of page.links) {
		let host: string;
		try {
			host = new URL(link.href).hostname.toLowerCase();
		} catch {
			continue;
		}
		const url = resourceUrl(link.href);
		if (url !== null && isDocumentUrl(url)) add(documents, url, "document", documentsPerPage);
		if (isInternalHost(scope, host)) continue;
		add(links, url, "link", outboundLinksPerPage);
	}
	return [...loads, ...documents, ...links];
}
