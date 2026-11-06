import { bareHostOfKey, onSiteOrBelow } from "../scope";
import { SEO_AUDIT_THRESHOLD_SPECS } from "../thresholds";
import {
	AUDIT_EXAMPLES,
	finding,
	htmlSnapshot,
	indexableSnapshot,
	onOwnHost,
	thresholdsOf
} from "./page-state";
import { loadedByUrl, oversizedImageUrls, withoutFragment } from "./rendered-weight";
import type { AuditContext, AuditFinding, AuditPage, AuditResource } from "./types";

/**
 * THE RULES OVER THE FILES A PAGE LOADS, from the resource checks held for each (its status, where it
 * led, its type, its weight and what its first bytes say): images that do not load, files that
 * redirect, heavy images, images in an older format, animated GIFs, and large images offered in one
 * size only. Pure; the same for a cloud and a desktop audit.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - an image is broken on the site's own hosts when it answers a 4xx or a 5xx (a 401, 403 or 429 is
 *   the site refusing the crawler, never proof the file is gone); on another host only when it answers
 *   404 or 410 (a third party's passing error is not the site's); nothing answering at all, a URL
 *   robots.txt forbids, and a file not checked yet are never judged;
 * - a redirect is filed only for the site's own files that land on a working file: the site can point
 *   the page at the final URL, and a third party's redirect, or one of its CDN's or platform's own
 *   scripts (Cloudflare's bot script under `/cdn-cgi/` redirects to a versioned copy), is not the
 *   site's to fix;
 * - weight, format and animation are judged on pages search engines are asked to show, and only for
 *   the image files the page shows (the ones the phone render chose; a `srcset` candidate for larger
 *   screens is not weight a phone pays): an image over
 *   {@link IMAGE_THRESHOLDS}.maxBytes, the page's largest image on the first screen over
 *   {@link IMAGE_THRESHOLDS}.heroMaxBytes; an image already filed as far larger than its box
 *   (`image_incorrectly_sized`) is that check's, never filed twice;
 * - the format, animation and single-size checks are insights: a JPEG, PNG or BMP of some weight
 *   (the check asks as a browser does, so a server that sends WebP or AVIF to browsers is not judged
 *   on its fallback), a GIF that loops or shows a second frame, and an image file at least
 *   {@link IMAGE_THRESHOLDS}.srcsetMinWidth pixels wide with no `srcset`.
 */

/** The thresholds of these rules. */
export const IMAGE_THRESHOLDS = {
	/** The weight (bytes) an image may have, by default (`../thresholds`). */
	maxBytes: SEO_AUDIT_THRESHOLD_SPECS.imageKb.value * 1024,
	/** The weight (bytes) the page's largest image on the first screen may have. */
	heroMaxBytes: 300 * 1024,
	/** The weight (bytes) from which an older format costs enough to note. */
	legacyMinBytes: 32 * 1024,
	/** The weight (bytes) from which an animated GIF is worth a video. */
	animatedMinBytes: 100 * 1024,
	/** The file width (pixels) from which an image should offer smaller sizes. */
	srcsetMinWidth: 1000
} as const;

/** Error statuses that say the site refused the crawler, not that the file is gone. */
const REFUSED: ReadonlySet<number> = new Set([401, 403, 429]);

/** The statuses that say a file moved. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The kinds of file a page loads whose redirect costs the page a request. */
const LOADED: ReadonlySet<string> = new Set([
	"image",
	"stylesheet",
	"script",
	"font",
	"icon",
	"media"
]);

/** The image types a newer format (WebP, AVIF) usually makes much lighter. */
const LEGACY_TYPES = /^image\/(?:jpe?g|png|bmp|x-ms-bmp)\b/i;

/**
 * The site's host without `www.` or a port, from the home page's key.
 *
 * @param context - The audit.
 * @returns The host, or null without a home page.
 */
function siteHost(context: AuditContext): string | null {
	const home = context.site.homeKey;
	return home === null ? null : bareHostOfKey(home);
}

/**
 * Whether an image's check says it does not load.
 *
 * @param image - The image's check.
 * @param own - Whether it is on the site's own hosts.
 * @returns Whether it is broken.
 */
function brokenImage(image: AuditResource, own: boolean): boolean {
	const status = image.finalStatus;
	if (status === null || status === 0) return false;
	return own ? status >= 400 && !REFUSED.has(status) : status === 404 || status === 410;
}

/**
 * Whether a file's check answered a working file.
 *
 * @param file - The check.
 * @returns Whether it did.
 */
function served(file: AuditResource): boolean {
	return file.finalStatus !== null && file.finalStatus >= 200 && file.finalStatus < 300;
}

/**
 * A finding's count and example URLs.
 *
 * @param files - The files it is about.
 * @returns The params.
 */
function listed(files: readonly AuditResource[]): { count: number; urls: string[] } {
	return { count: files.length, urls: files.slice(0, AUDIT_EXAMPLES).map((file) => file.url) };
}

/**
 * A markup URL resolved against the page, its fragment dropped.
 *
 * @param src - The URL as written.
 * @param base - The page's URL.
 * @returns The absolute URL, or null when it is not one.
 */
function resolved(src: string, base: string): string | null {
	if (src.trim() === "") return null;
	try {
		return withoutFragment(new URL(src, base).toString());
	} catch {
		return null;
	}
}

/**
 * The image files the page shows: the ones the phone render chose (a `srcset` candidate for larger
 * screens is never judged as weight a phone pays), else each image's own URL in the markup.
 *
 * @param page - The page.
 * @param base - The page's URL.
 * @returns The URLs, fragments dropped.
 */
function shownImages(page: AuditPage, base: string): Set<string> {
	const dom = page.facts?.render?.dom ?? null;
	if (dom !== null)
		return new Set(
			[...dom.images.map((image) => image.url), ...dom.transfer.images].map(withoutFragment)
		);
	const shown = new Set<string>();
	for (const image of page.facts?.markup?.images ?? []) {
		const url = resolved(image.src, base);
		if (url !== null) shown.add(url);
	}
	return shown;
}

/**
 * The page's images whose file is at least {@link IMAGE_THRESHOLDS}.srcsetMinWidth pixels wide and
 * that offer no `srcset`, by URL.
 *
 * @param page - The page.
 * @param byUrl - The checks of what it loads, by URL.
 * @param base - The page's URL, which the markup's image URLs resolve against.
 * @returns The images.
 */
function singleSizeImages(
	page: AuditPage,
	byUrl: ReadonlyMap<string, AuditResource>,
	base: string
): AuditResource[] {
	const found = new Map<string, AuditResource>();
	for (const image of page.facts?.markup?.images ?? []) {
		const url = image.srcset ? null : resolved(image.src, base);
		if (url === null) continue;
		const file = byUrl.get(url);
		if (file === undefined || file.kind !== "image" || !served(file)) continue;
		if ((file.width ?? 0) >= IMAGE_THRESHOLDS.srcsetMinWidth) found.set(url, file);
	}
	return [...found.values()];
}

/**
 * The findings of one page over the files it loads.
 *
 * @param page - The page.
 * @param resources - What it references, with the site's latest check of each.
 * @param context - The audit.
 * @returns Its findings.
 */
export function imageResourceFindings(
	page: AuditPage,
	resources: readonly AuditResource[],
	context: AuditContext
): AuditFinding[] {
	const snapshot = htmlSnapshot(page);
	if (snapshot === null) return [];
	const key = page.pageKey;
	const host = siteHost(context);
	const byUrl = loadedByUrl(
		resources.filter((file) => file.checkedAt !== null && file.robotsAllowed !== false)
	);
	const files = [...byUrl.values()];
	const images = files.filter((file) => file.kind === "image");
	const found: AuditFinding[] = [];

	const broken = images.filter((image) =>
		brokenImage(image, host !== null && onSiteOrBelow(image.url, host))
	);
	if (broken.length > 0) found.push(finding(key, "image_broken", listed(broken)));

	const moved = files.filter(
		(file) =>
			LOADED.has(file.kind) &&
			file.status !== null &&
			REDIRECTS.has(file.status) &&
			served(file) &&
			host !== null &&
			onOwnHost(file.url, host)
	);
	if (moved.length > 0) found.push(finding(key, "resource_redirect", listed(moved)));

	if (indexableSnapshot(page, context) === null) return found;
	const maxBytes = thresholdsOf(context).imageKb * 1024;
	const t = {
		...IMAGE_THRESHOLDS,
		maxBytes,
		heroMaxBytes: Math.max(IMAGE_THRESHOLDS.heroMaxBytes, maxBytes)
	};
	const dom = page.facts?.render?.dom ?? null;
	const hero = dom?.lcp?.url == null ? null : withoutFragment(dom.lcp.url);
	const oversized = new Set(dom === null ? [] : oversizedImageUrls(dom, byUrl));
	const base = snapshot.finalUrl ?? `https://${key}`;
	const shown = shownImages(page, base);
	const working = images.filter((image) => served(image) && shown.has(withoutFragment(image.url)));

	const heavy = working.filter((image) => {
		const url = withoutFragment(image.url);
		if (image.sizeBytes === null || oversized.has(url)) return false;
		return image.sizeBytes > (url === hero ? t.heroMaxBytes : t.maxBytes);
	});
	if (heavy.length > 0) {
		found.push(
			finding(key, "image_too_large", {
				...listed(heavy),
				maxKb: t.maxBytes / 1024,
				heroKb: t.heroMaxBytes / 1024
			})
		);
	}

	const legacy = working.filter(
		(image) =>
			LEGACY_TYPES.test(image.contentType ?? "") && (image.sizeBytes ?? 0) >= t.legacyMinBytes
	);
	if (legacy.length > 0) found.push(finding(key, "image_legacy_format", listed(legacy)));

	const animated = working.filter(
		(image) => image.headers?.animated === true && (image.sizeBytes ?? 0) >= t.animatedMinBytes
	);
	if (animated.length > 0) found.push(finding(key, "image_animated_gif", listed(animated)));

	const single = singleSizeImages(page, byUrl, base).filter(
		(image) => !oversized.has(withoutFragment(image.url))
	);
	if (single.length > 0) {
		found.push(
			finding(key, "image_srcset_missing", { ...listed(single), width: t.srcsetMinWidth })
		);
	}
	return found;
}
