import type { SeoPageDomFacts } from "../facts";

import { AUDIT_EXAMPLES, finding, htmlSnapshot, indexableSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage, AuditResource } from "./types";

/**
 * THE RULES THAT JOIN THE RENDER WITH THE RESOURCE CHECKS: what a page transferred while it loaded
 * (the render's own count of the document, scripts, styles and data, plus the size the resource checks
 * found for each image and font the browser asked for), and images whose file is much larger than the
 * box the page shows them in (the box from the render, the pixel size from the image's file header).
 * Pure; the same for a cloud and a desktop audit.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - only the images and fonts the browser asked for on the first screen count (a lazy image below it
 *   is not loaded), each at the size its check found; one with no known size counts as nothing;
 * - an image is too large only when its file is more than three times as wide as its box (the
 *   sharpest phone screens use three pixels per CSS pixel), it weighs at least the resource check's
 *   size floor, and it is not an SVG (which scales);
 * - pages search engines are not asked to show are not judged.
 */

/** The thresholds of these rules. */
export const RENDERED_WEIGHT_THRESHOLDS = {
	/** The bytes a page may transfer while it loads (Lighthouse's "enormous network payload"). */
	payloadBytes: 4 * 1024 * 1024,
	/** How many times wider than its box an image's file may be. */
	oversizeRatio: 3
} as const;

/**
 * A URL without its fragment.
 *
 * @param url - The URL.
 * @returns It, its `#...` dropped.
 */
export function withoutFragment(url: string): string {
	const at = url.indexOf("#");
	return at === -1 ? url : url.slice(0, at);
}

/**
 * The resource checks of what a page loads, by URL without its fragment (the first check of a URL
 * wins; outbound links left out).
 *
 * @param resources - What the page references.
 * @returns The checks by URL.
 */
export function loadedByUrl(resources: readonly AuditResource[]): Map<string, AuditResource> {
	const byUrl = new Map<string, AuditResource>();
	for (const resource of resources) {
		if (resource.kind === "link" || resource.kind === "spelling") continue;
		const url = withoutFragment(resource.url);
		if (!byUrl.has(url)) byUrl.set(url, resource);
	}
	return byUrl;
}

/**
 * The images a rendered page shows whose file is more than
 * {@link RENDERED_WEIGHT_THRESHOLDS}.oversizeRatio times wider than their box, by URL.
 *
 * @param dom - The probe's facts.
 * @param byUrl - The resource checks by URL ({@link loadedByUrl}).
 * @returns The URLs, in the order the page shows them.
 */
export function oversizedImageUrls(
	dom: SeoPageDomFacts,
	byUrl: ReadonlyMap<string, AuditResource>
): string[] {
	const oversized: string[] = [];
	const seen = new Set<string>();
	for (const image of dom.images) {
		const url = withoutFragment(image.url);
		if (seen.has(url)) continue;
		seen.add(url);
		const width = byUrl.get(url)?.width ?? null;
		if (width === null || image.width <= 0) continue;
		if (width > image.width * RENDERED_WEIGHT_THRESHOLDS.oversizeRatio) oversized.push(url);
	}
	return oversized;
}

/**
 * The findings of one page over what it loads, joined with the resource checks.
 *
 * @param page - The page.
 * @param resources - What it references, with the site's latest check of each.
 * @param context - The audit.
 * @returns Its findings.
 */
export function renderedWeightFindings(
	page: AuditPage,
	resources: readonly AuditResource[],
	context: AuditContext
): AuditFinding[] {
	const render = page.facts?.render;
	const dom = render?.dom;
	if (render == null || render.outcome === "failed" || dom == null) return [];
	if (htmlSnapshot(page) === null || indexableSnapshot(page, context) === null) return [];
	const key = page.pageKey;
	const t = RENDERED_WEIGHT_THRESHOLDS;
	const byUrl = loadedByUrl(resources);
	const found: AuditFinding[] = [];

	let bytes = dom.transfer.bytes;
	for (const url of new Set([...dom.transfer.images, ...dom.transfer.fonts])) {
		bytes += byUrl.get(withoutFragment(url))?.sizeBytes ?? 0;
	}
	if (bytes > t.payloadBytes) {
		found.push(finding(key, "network_payload_large", { bytes, max: t.payloadBytes }));
	}

	const oversized = oversizedImageUrls(dom, byUrl);
	if (oversized.length > 0) {
		found.push(
			finding(key, "image_incorrectly_sized", {
				count: oversized.length,
				urls: oversized.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	return found;
}
