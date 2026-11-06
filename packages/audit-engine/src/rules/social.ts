import { normalizePageUrl } from "../urls";

import { canonicalKey, finding, indexableSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage, AuditResource } from "./types";

/**
 * THE SHARE PREVIEW RULES beyond "no tags at all" (`./presentation`): Open Graph and X card tags that
 * are there but incomplete, an `og:url` naming another page than the canonical, and an `og:image` that
 * does not load.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS: they judge only pages search engines are asked to show, from the
 * rendered page's markup. Open Graph is judged only when the page has some of it (none at all is
 * `open_graph_missing`); an X card only when `twitter:card` is set, and its title may come from
 * `og:title` (X reads the Open Graph tags when its own are missing). `og:url` is compared with a declared
 * canonical only (a page without one is `canonical_missing`), by page key, so a trailing slash or the protocol never counts. An image is broken only when its check answered
 * 4xx or 5xx, or nothing answered for a reason other than time (a large image a CDN resizes on its
 * first request may answer late); one robots.txt forbids or not yet checked is never judged. An image
 * that answered, heavier than a social site accepts, is a notice of its own (`og_image_too_large`).
 */

/**
 * The heaviest share image each social site takes, in bytes: Facebook's 8 MB and X's 5 MB (a card
 * image over it shows no picture).
 */
export const OG_IMAGE_MAX_BYTES = { facebook: 8 * 1024 * 1024, x: 5 * 1024 * 1024 } as const;

/** The social sites a share image is judged for. */
type ShareSite = keyof typeof OG_IMAGE_MAX_BYTES;

/**
 * The Open Graph tags a share preview cannot do without. `og:type` defaults to `website` and `og:url`
 * to the shared address, so leaving them out changes nothing a reader sees.
 */
const OPEN_GRAPH_REQUIRED = ["title", "image"] as const;

/**
 * The share preview findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function socialFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	if (indexableSnapshot(page, context) === null) return [];
	const markup = page.facts?.markup ?? null;
	if (markup === null) return [];
	const found: AuditFinding[] = [];
	const og = markup.openGraph;
	const set = (value: string | null): boolean => value !== null && value.trim() !== "";
	const missing: string[] = [];
	if (Object.values(og).some(set))
		for (const name of OPEN_GRAPH_REQUIRED) if (!set(og[name])) missing.push(`og:${name}`);
	const twitter = markup.twitter;
	if (set(twitter.card) && !set(twitter.title) && !set(og.title)) missing.push("twitter:title");
	if (missing.length > 0) found.push(finding(page.pageKey, "social_tags_incomplete", { missing }));
	if (set(og.url)) {
		const ogKey = normalizePageUrl(og.url ?? "");
		const target = canonicalKey(page, context);
		if (ogKey !== null && target !== null && context.resolve(ogKey) !== target)
			found.push(finding(page.pageKey, "og_url_not_canonical", { ogUrl: og.url }));
	}
	return found;
}

/**
 * The share image findings of one page: its `og:image` as the resource checks last found it, broken
 * or too heavy for a social site.
 *
 * @param page - The page.
 * @param resources - What it loads, with the site's latest check of each.
 * @param context - The audit.
 * @returns Its findings.
 */
export function socialResourceFindings(
	page: AuditPage,
	resources: readonly AuditResource[],
	context: AuditContext
): AuditFinding[] {
	if (indexableSnapshot(page, context) === null) return [];
	const images = resources.filter(
		(resource) => resource.kind === "og_image" && resource.robotsAllowed !== false
	);
	const broken = images.find(
		(resource) =>
			resource.finalStatus !== null &&
			((resource.finalStatus === 0 && resource.error !== "timeout") || resource.finalStatus >= 400)
	);
	if (broken !== undefined)
		return [
			finding(page.pageKey, "og_image_broken", { url: broken.url, status: broken.finalStatus })
		];
	for (const image of images) {
		const size = image.sizeBytes;
		const status = image.finalStatus;
		if (size === null || status === null || status < 200 || status >= 300) continue;
		const sites = (Object.keys(OG_IMAGE_MAX_BYTES) as ShareSite[]).filter(
			(site) => size > OG_IMAGE_MAX_BYTES[site]
		);
		if (sites.length === 0) continue;
		return [
			finding(page.pageKey, "og_image_too_large", {
				url: image.url,
				mb: Math.round((size / (1024 * 1024)) * 10) / 10,
				sites: sites.sort()
			})
		];
	}
	return [];
}
