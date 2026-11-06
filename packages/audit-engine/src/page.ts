import { auditFactsOf } from "./audit-facts";
import { SEO_JSON_LD_CHARS_PER_PAGE } from "./config";
import type { SeoLinkContext } from "./links";
import { readLinks } from "./links";
import { mainTextHash } from "./main-text";
import { readsAsPage, readVerdict, SEO_FAILURE_STATUSES } from "./reading";
import type { SeoPageReading } from "./reading";
import { primaryRead, renderFactsOf } from "./render-facts";
import type { AuditPage } from "./rules/types";

/**
 * ONE PAGE'S READING AS THE AUDIT JUDGES IT: the reading turned into the page the rules read (its
 * answer, its snapshot fields and its audit facts), exactly as a crawl that stores it would hold it.
 * Pure apart from the hashing of the main text.
 */

/** What a crawl knows of a page beyond one reading of it: its sitemap entry, its traffic, its place in the link graph. */
export type AuditPageHeld = Pick<
	AuditPage,
	| "inSitemap"
	| "hasTraffic"
	| "impressions"
	| "inAnalytics"
	| "backlinked"
	| "clickDepth"
	| "linkScore"
>;

/**
 * The audit's view of the page as read now, as the crawl would store it.
 *
 * @param context - The site and its URL rules.
 * @param reading - The reading.
 * @param now - When it was read.
 * @param held - What the crawl knows of the page beyond the reading.
 * @param jsonLdChars - The JSON-LD kept for the structured data rules.
 * @returns The audit page.
 */
export function auditPageOfReading(
	context: SeoLinkContext,
	reading: SeoPageReading,
	now: Date,
	held: AuditPageHeld,
	jsonLdChars: number = SEO_JSON_LD_CHARS_PER_PAGE
): AuditPage {
	const { resource } = reading;
	const verdict = readVerdict(reading.pageKey, resource);
	const jsonLd = jsonLdChars;
	if (verdict.failed) {
		return {
			pageKey: reading.pageKey,
			status: 0,
			lastError: resource.error ?? "network",
			failCount: 2,
			...held,
			snapshot: null,
			facts:
				resource.error === "too_many_redirects" ? auditFactsOf(resource, null, now, jsonLd) : null
		};
	}
	if (SEO_FAILURE_STATUSES.has(verdict.status)) {
		return {
			pageKey: reading.pageKey,
			status: verdict.status,
			lastError: `status_${String(verdict.status)}`,
			failCount: 2,
			...held,
			snapshot: null,
			facts: null
		};
	}
	const raw = readsAsPage(reading.pageKey, resource) ? reading.page : null;
	const rendered = raw === null ? null : reading.rendered;
	const primary = raw === null ? null : primaryRead(raw, rendered);
	const page = primary?.page ?? null;
	const counts = page === null ? null : readLinks(context, page);
	const facts = auditFactsOf(
		resource,
		page,
		now,
		jsonLd,
		counts === null
			? undefined
			: { internal: counts.internalCount, external: counts.externalCount },
		raw === null ? null : renderFactsOf(context.scope, raw, rendered),
		raw === null ? null : (reading.checks ?? null)
	);
	return {
		pageKey: reading.pageKey,
		status: verdict.status,
		lastError: null,
		failCount: 0,
		...held,
		fetchMode: primary?.mode ?? null,
		facts,
		snapshot: {
			mode: primary?.mode ?? "plain",
			status: verdict.status,
			finalUrl: resource.finalUrl,
			redirectChain: resource.chain,
			contentType: resource.contentType,
			xRobotsTag: resource.xRobotsTag,
			title: page?.title ?? null,
			metaDescription: page?.metaDescription ?? null,
			h1: page?.h1 ?? null,
			h1Count: page?.h1Count ?? null,
			canonical: page?.canonical ?? null,
			metaRobots: page?.metaRobots ?? null,
			lang: page?.lang ?? null,
			viewport: page?.viewport ?? null,
			schemaTypes: page?.schemaTypes ?? null,
			hasOpenGraph: page?.hasOpenGraph ?? null,
			hasTwitterCard: page?.hasTwitterCard ?? null,
			images: page?.images ?? null,
			imagesMissingAlt: page?.imagesMissingAlt ?? null,
			wordCount: page?.wordCount ?? null,
			mainTextHash: page === null ? null : mainTextHash(page.mainText),
			responseMs: resource.responseMs,
			sizeBytes: resource.sizeBytes,
			headings: page?.headings ?? null,
			hreflang: page?.hreflang ?? null,
			datePublished: page?.datePublished ?? null,
			dateModified: page?.dateModified ?? null,
			fetchedAt: now.toISOString()
		}
	};
}
