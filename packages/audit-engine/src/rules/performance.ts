import type { SeoPageDomFacts } from "../facts";

import { GOOGLEBOT_FILE_BYTES } from "./head";
import { SEO_AUDIT_THRESHOLD_SPECS } from "../thresholds";
import { finding, htmlSnapshot, indexableSnapshot, thresholdsOf } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage } from "./types";

/**
 * THE PERFORMANCE AND IMAGE RULES: how fast and how heavy the HTML was, and the images that slow the
 * first paint or shift the layout.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - time and weight are read from the LATEST fetch (the audit facts), never from an older snapshot;
 *   the size is the HTML document alone, so a page is heavy only when its HTML is;
 *   HTML over what Googlebot reads of a file is `html_over_2mb` (`./head`), never also a weight issue;
 * - an image with `alt=""` is decorative and correct; only an `<img>` with no alt attribute counts;
 * - a lazy-loaded image is flagged only when the rendered page measured it as its largest paint on
 *   the first screen (without a measured render: the first content image before much text), and an
 *   image sized by its style (a `fill` image) is sized;
 * - the image rules judge only pages search engines are asked to show.
 */

/**
 * The thresholds the performance rules use by default; a project may change them (`../thresholds`).
 * The answer time is measured from our crawler's server, not from the site's visitors.
 */
export const PERFORMANCE_THRESHOLDS = {
	slowMs: SEO_AUDIT_THRESHOLD_SPECS.slowMs.value,
	moderateMs: SEO_AUDIT_THRESHOLD_SPECS.moderateMs.value,
	moderateBytes: SEO_AUDIT_THRESHOLD_SPECS.pageKb.value * 1024
} as const;

/**
 * A site's stand-in for a missing picture (`/img/placeholder.png`, `no-image.jpg`): loaded lazily on
 * its own, it defers no real image. One a script swaps for the real file is never `loading="lazy"`
 * itself, so its page is still judged.
 */
const STAND_IN_IMAGE =
	/(?:^|\/)[^/?#]*(?:placeholder|no[-_]?image|missing[-_]?image|image[-_]?missing)[^/?#]*\.(?:png|jpe?g|gif|svg|webp|avif)(?:[?#]|$)/i;

/** The share of the phone screen's width from which an image at the top of the content is its main visual. */
const HERO_WIDTH_SHARE = 0.5;

/**
 * The page's main image when it loads lazily. The rendered page decides when the render measured it:
 * its largest paint on the first screen when that is a lazily loaded image, or else the markup's first
 * large content image before much text when the render drew it across at least half the screen (a
 * wide image at the top of a page whose long text block measures bigger is still its main visual). A
 * largest paint that is an image loaded at once means the main image is not lazy, whatever wide
 * decoration the markup puts first; one drawn across less than half the screen (an avatar the render
 * measured largest) is not the main image, nor is the markup's image when the render drew it below the
 * first screen (a landing page's big headline and buttons come first). A lazy thumbnail, avatar
 * or logo before the text is never the main image, nor one that fades in (painted first at opacity
 * 0, which Chrome never takes as the largest paint). Without a measured render, the markup's guess
 * stands.
 *
 * @param markup - The markup's likely main image when it is lazy, or null.
 * @param dom - The render's probe facts: undefined when the page was not measured.
 * @param base - The page's URL, to compare the images' addresses.
 * @returns The finding's params, or null.
 */
function lazyMainImage(
	markup: { src: string; method: "native" | "javascript" } | null,
	dom: SeoPageDomFacts | null | undefined,
	base: string
): { src: string; method?: "native" | "javascript" } | null {
	if (dom == null) return markup;
	const resolved = (src: string): string | null => {
		try {
			return new URL(src, base).href;
		} catch {
			return null;
		}
	};
	const drawn = (src: string): SeoPageDomFacts["images"][number] | null => {
		const address = resolved(src);
		return dom.images.find((image) => resolved(image.url) === address) ?? null;
	};
	const drawnWidth = (src: string): number | null => drawn(src)?.width ?? null;
	const wide = dom.viewport.width * HERO_WIDTH_SHARE;
	const lcp = dom.lcp;
	if (lcp !== null && lcp.kind === "image" && lcp.url !== null) {
		if (!lcp.lazy) return null;
		const width = drawnWidth(lcp.url);
		if (width === null || width >= wide) {
			if (markup !== null && resolved(markup.src) === resolved(lcp.url)) {
				return { src: lcp.url, method: markup.method };
			}
			return { src: lcp.url };
		}
	}
	if (markup === null) return null;
	const fadedIn = (dom.fadedIn ?? []).map(resolved);
	if (fadedIn.includes(resolved(markup.src))) return null;
	const image = drawn(markup.src);
	if (image === null || image.width < wide) return null;
	return image.top !== undefined && image.top >= dom.viewport.height ? null : markup;
}

/**
 * A page's lazily loaded main image, as `images_lazy_hero` judges it.
 *
 * @param page - The page.
 * @returns The finding's params, or null when its main image loads eagerly or it has none.
 */
export function pageLazyMainImage(
	page: AuditPage
): { src: string; method?: "native" | "javascript" } | null {
	const snapshot = htmlSnapshot(page);
	const main = lazyMainImage(
		page.facts?.images.lazyHero ?? null,
		page.facts?.render?.dom,
		snapshot?.finalUrl ?? `https://${page.pageKey}`
	);
	return main !== null && main.method === "native" && STAND_IN_IMAGE.test(main.src) ? null : main;
}

/**
 * The performance and image findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function performanceFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const snapshot = htmlSnapshot(page);
	if (snapshot === null) return [];
	const key = page.pageKey;
	const t = thresholdsOf(context);
	const found: AuditFinding[] = [];
	const ms = page.facts?.responseMs ?? snapshot.responseMs;
	if (ms !== null) {
		const from = page.facts?.measuredFrom ?? "unknown";
		if (ms > t.slowMs) found.push(finding(key, "response_slow", { ms, max: t.slowMs, from }));
		else if (ms > t.moderateMs)
			found.push(finding(key, "response_moderate", { ms, max: t.moderateMs, from }));
	}
	const bytes = page.facts?.sizeBytes ?? snapshot.sizeBytes;
	const maxBytes = t.pageKb * 1024;
	if (bytes !== null) {
		if (bytes > maxBytes && bytes <= GOOGLEBOT_FILE_BYTES)
			found.push(
				finding(key, "page_moderate", {
					bytes,
					max: maxBytes,
					kb: Math.round(bytes / 1024),
					maxKb: t.pageKb
				})
			);
	}
	if (snapshot.mode === "rendered" || indexableSnapshot(page, context) === null) return found;

	const missingAlt = page.facts?.page?.imagesMissingAlt ?? snapshot.imagesMissingAlt ?? 0;
	if (missingAlt > 0) {
		found.push(
			finding(key, "images_missing_alt", {
				missing: missingAlt,
				total: page.facts?.page?.images ?? snapshot.images ?? missingAlt
			})
		);
	}
	const images = page.facts?.images ?? null;
	const lazyHero = pageLazyMainImage(page);
	if (lazyHero !== null) found.push(finding(key, "images_lazy_hero", lazyHero));
	if (images !== null && images.missingDimensions > 0) {
		found.push(
			finding(key, "images_missing_dimensions", {
				missing: images.missingDimensions,
				total: images.total,
				examples: images.missingDimensionsExamples
			})
		);
	}
	return found;
}
