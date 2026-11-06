import type {
	SeoPageAuditFacts,
	SeoPageCheckFacts,
	SeoPageHreflang,
	SeoPageJsonLdBlock,
	SeoPageMarkupFacts,
	SeoPageRenderFacts
} from "./facts";

import { xRobotsTagGroups } from "./extract-markup";
import { optionalAuditHeaders } from "./fetch";
import { textFactsOf } from "./text-facts";
import type { ExtractedPage, FetchedResource } from "./types";

/**
 * WHAT ONE FETCH LEAVES FOR THE SITE AUDIT (`seo_pages.audit_facts`): the redirect chain, the headers
 * the audit reads, and the extractor's audit fields, the JSON-LD bodies kept within a size budget, and
 * the markup facts of the page as stored (the rendered page whenever the browser rendered it; the raw
 * HTML's head goes with the render facts, for the comparison; the subresource list is left to the
 * resource checks, never stored here), and what the content rules read from the main text (its
 * fingerprint, languages and reading ease; never the text itself). Pure: the crawl writes what this
 * returns on every read of a page.
 */

/** The characters of a header value kept. */
const HEADER_CHARS = 500;

/** The most examples a fact list keeps. */
const EXAMPLES = 5;

/**
 * The `rel="canonical"` target of a `Link` header (RFC 8288), absolute.
 *
 * @param link - The raw header, or null.
 * @param base - The URL the response answered for, to resolve a relative target.
 * @returns The target, or null when the header names none.
 */
export function linkHeaderCanonical(link: string | null, base: string): string | null {
	if (link === null) return null;
	for (const match of link.matchAll(/<([^<>]*)>\s*((?:;[^;,]*)*)/g)) {
		const params = match[2] ?? "";
		const rel = /;\s*rel\s*=\s*"?([^";,]*)"?/i.exec(params)?.[1] ?? "";
		if (!rel.toLowerCase().split(/\s+/).includes("canonical")) continue;
		try {
			return new URL((match[1] ?? "").trim(), base).href;
		} catch {
			return null;
		}
	}
	return null;
}

/** The most hreflang alternates kept from a `Link` header. */
const LINK_HREFLANG = 200;

/**
 * The hreflang alternates a `Link` header names (`<url>; rel="alternate"; hreflang="de"`), absolute.
 *
 * @param link - The raw header, or null.
 * @param base - The URL the response answered for, to resolve a relative target.
 * @returns The alternates, in header order.
 */
export function linkHeaderHreflang(link: string | null, base: string): SeoPageHreflang[] {
	if (link === null) return [];
	const found: SeoPageHreflang[] = [];
	for (const match of link.matchAll(/<([^<>]*)>\s*((?:;[^;,]*)*)/g)) {
		if (found.length >= LINK_HREFLANG) break;
		const params = match[2] ?? "";
		const rel = /;\s*rel\s*=\s*"?([^";,]*)"?/i.exec(params)?.[1] ?? "";
		const lang = /;\s*hreflang\s*=\s*"?([^";,]*)"?/i.exec(params)?.[1]?.trim() ?? "";
		if (lang === "" || !rel.toLowerCase().split(/\s+/).includes("alternate")) continue;
		try {
			found.push({ lang, url: new URL((match[1] ?? "").trim(), base).href });
		} catch {
			found.push({ lang, url: (match[1] ?? "").trim() });
		}
	}
	return found;
}

/**
 * The JSON-LD blocks within a page's budget: each block kept whole while it fits, a marker past it.
 *
 * @param blocks - The raw blocks.
 * @param budget - The characters kept per page.
 * @returns The blocks as stored.
 */
export function keptJsonLd(blocks: readonly string[], budget: number): SeoPageJsonLdBlock[] {
	let left = budget;
	return blocks.map((text) => {
		const trimmed = text.trim().replaceAll("\u0000", "");
		if (trimmed.length > left) return { text: null, chars: trimmed.length };
		left -= trimmed.length;
		return { text: trimmed, chars: trimmed.length };
	});
}

/**
 * The markup facts kept for a page: the stored read's (rendered when the browser rendered it), the
 * subresource list left out (the resource checks keep it, `./resource-check`).
 *
 * @param extracted - The read stored.
 * @returns The facts, or undefined when the read carries none (an app from before they were read).
 */
function keptMarkup(extracted: ExtractedPage): SeoPageMarkupFacts | undefined {
	if (extracted.markup === undefined) return undefined;
	const { resources: _resources, ...markup } = extracted.markup;
	return markup;
}

/**
 * The audit facts of one fetch.
 *
 * @param resource - What answered.
 * @param extracted - The page read from it, or null when no HTML was read.
 * @param readAt - When it was fetched.
 * @param jsonLdBudget - The JSON-LD characters kept per page.
 * @param linkCounts - The links to the site's own pages and to other sites the page holds, when it
 *   was read.
 * @param render - What the browser's render found beside the raw HTML, or null when no HTML was read.
 * @param checks - What the optional checks found (spelling, AMP, custom patterns), or null.
 * @returns The facts to store.
 */
export function auditFactsOf(
	resource: Pick<
		FetchedResource,
		| "chain"
		| "responseMs"
		| "sizeBytes"
		| "auditHeaders"
		| "finalUrl"
		| "xRobotsTag"
		| "htmlUnlabelled"
		| "htmlCut"
	>,
	extracted: ExtractedPage | null,
	readAt: Date,
	jsonLdBudget: number,
	linkCounts: { internal: number; external: number } = { internal: 0, external: 0 },
	render: SeoPageRenderFacts | null = null,
	checks: SeoPageCheckFacts | null = null
): SeoPageAuditFacts {
	const headers = resource.auditHeaders;
	const audit = extracted?.audit ?? null;
	const markup = extracted === null ? null : keptMarkup(extracted);
	return {
		readAt: readAt.toISOString(),
		redirectChain: resource.chain,
		responseMs: resource.responseMs,
		sizeBytes: resource.sizeBytes,
		...(resource.htmlUnlabelled === true ? { htmlUnlabelled: true } : {}),
		...(resource.htmlCut === undefined ? {} : { htmlCut: resource.htmlCut }),
		page:
			extracted === null
				? null
				: {
						h1Count: extracted.h1Count,
						...(extracted.h1Empty === undefined ? {} : { h1Empty: extracted.h1Empty }),
						lang: extracted.lang,
						viewport: extracted.viewport,
						hasOpenGraph: extracted.hasOpenGraph,
						hasTwitterCard: extracted.hasTwitterCard,
						images: extracted.images,
						imagesMissingAlt: extracted.imagesMissingAlt,
						internalLinks: linkCounts.internal,
						externalLinks: linkCounts.external
					},
		headers: {
			strictTransportSecurity: headers.strictTransportSecurity,
			contentSecurityPolicy: headers.contentSecurityPolicy,
			xContentTypeOptions: headers.xContentTypeOptions,
			xFrameOptions: headers.xFrameOptions,
			referrerPolicy: headers.referrerPolicy,
			linkCanonical: linkHeaderCanonical(headers.link, resource.finalUrl),
			linkHreflang: linkHeaderHreflang(headers.link, resource.finalUrl),
			...optionalAuditHeaders(headers, HEADER_CHARS)
		},
		robotsHeader: xRobotsTagGroups(resource.xRobotsTag),
		...(markup === undefined ? {} : { markup }),
		html: extracted !== null,
		canonicals: audit?.canonicals ?? [],
		hreflang: extracted?.hreflang ?? [],
		jsonLd: audit === null ? [] : keptJsonLd(audit.jsonLd, jsonLdBudget),
		mixedContent: {
			active: audit?.mixedActive.length ?? 0,
			passive: audit?.mixedPassive.length ?? 0,
			examples: [...new Set([...(audit?.mixedActive ?? []), ...(audit?.mixedPassive ?? [])])]
				.slice(0, EXAMPLES)
				.map((url) => url.slice(0, 500))
		},
		images: {
			total: audit?.images ?? 0,
			missingDimensions: audit?.unsizedImages.length ?? 0,
			missingDimensionsExamples: [...new Set(audit?.unsizedImages ?? [])]
				.filter((src) => src !== "")
				.slice(0, EXAMPLES)
				.map((src) => src.slice(0, 500)),
			lazyHero:
				audit?.lazyHero == null
					? null
					: { src: audit.lazyHero.src.slice(0, 500), method: audit.lazyHero.method }
		},
		render,
		text:
			extracted === null
				? null
				: textFactsOf(extracted.mainText, extracted.markup?.lang.html ?? extracted.lang),
		...(checks === null || extracted === null ? {} : { checks })
	};
}
