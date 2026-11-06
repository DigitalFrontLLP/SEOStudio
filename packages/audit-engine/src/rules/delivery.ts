import { SEO_COMPRESS_MIN_BYTES, seoCompressible } from "../resource-check";
import { bareHostOfKey } from "../scope";
import { AUDIT_EXAMPLES, finding, htmlSnapshot, onOwnHost } from "./page-state";
import type { AuditFinding, AuditPage, AuditResource, AuditResourceRule } from "./types";

/**
 * THE DELIVERY RULES: how the site serves its HTML and the files its pages load, from the response
 * headers the crawl and the resource checks kept. Text sent without compression (`compression_missing`)
 * and static files with no or a short cache lifetime (`cache_policy_weak`). Pure; the same for a cloud
 * and a desktop audit.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - only files on the site's own hosts are issues: its host and its subdomains (a CDN the site set up
 *   at `static.` or `cdn.` of its domain). A file on another host (a platform's CDN, a third-party
 *   script), or one the site's CDN manages under its reserved path (Cloudflare's `/cdn-cgi/` scripts),
 *   is not the owner's to fix, so the same findings there are the insights
 *   `compression_missing_third_party` and `cache_policy_weak_third_party`, listed but never scored;
 * - text is uncompressed only when the answer to a GET offering gzip and brotli named no encoding (the
 *   resource check asks again by GET where a HEAD or a ranged answer named none: many servers compress
 *   only a full GET), it is HTML, CSS, JavaScript, JSON, XML or SVG, and it weighs at least
 *   {@link DELIVERY_THRESHOLDS.compressMinBytes} (a smaller file gains next to nothing);
 * - a cache lifetime is short under {@link DELIVERY_THRESHOLDS.cacheMinDays} days, read from
 *   `Cache-Control: max-age` (else `Expires`); `immutable` is a long one; only images, scripts,
 *   stylesheets, fonts, icons and media that answered 2xx count, never a page, a data request or the
 *   share image (`og:image`): visitors' browsers never load it, so its cache lifetime costs them nothing;
 * - a file checked before the headers were kept is not judged.
 */

/** The thresholds of the delivery rules. */
export const DELIVERY_THRESHOLDS = {
	/** Text under this many bytes gains too little from compression to be filed. */
	compressMinBytes: SEO_COMPRESS_MIN_BYTES,
	/** A static file cached for less than this many days is cached for a short time. */
	cacheMinDays: 7
} as const;

/** The kinds of file a cache lifetime is judged on. */
const STATIC_KINDS = new Set<AuditResource["kind"]>([
	"image",
	"script",
	"stylesheet",
	"font",
	"icon",
	"media"
]);

/** One day, in seconds. */
const DAY_SECONDS = 86_400;

/**
 * Whether a `Content-Encoding` names real compression.
 *
 * @param encoding - The header, or null.
 * @returns Whether it does.
 */
function compressed(encoding: string | null | undefined): boolean {
	const value = (encoding ?? "").trim().toLowerCase();
	return value !== "" && value !== "identity";
}

/**
 * Whether a resource answered 2xx with its headers kept (a file robots.txt forbids was never fetched).
 *
 * @param resource - The resource.
 * @returns Whether it can be judged.
 */
function answered(resource: AuditResource): boolean {
	return (
		resource.kind !== "link" &&
		resource.kind !== "document" &&
		resource.robotsAllowed !== false &&
		resource.headers != null &&
		resource.error === null &&
		resource.finalStatus !== null &&
		resource.finalStatus >= 200 &&
		resource.finalStatus < 300
	);
}

/**
 * A file's cache lifetime in seconds: `max-age` first, `immutable` as a year, else `Expires` against
 * the check's time; 0 for `no-store` or `no-cache`; null when the headers name none.
 *
 * @param resource - The checked resource.
 * @returns The lifetime, or null for none named.
 */
export function cacheLifetimeSeconds(resource: AuditResource): number | null {
	const control = (resource.headers?.cacheControl ?? "").toLowerCase();
	const directives = new Map<string, string>();
	for (const part of control.split(",")) {
		const [name, value] = part.split("=", 2);
		const key = name?.trim() ?? "";
		if (key !== "") directives.set(key, (value ?? "").trim().replace(/^"|"$/g, ""));
	}
	if (directives.has("no-store") || directives.has("no-cache")) return 0;
	if (directives.has("immutable")) return 365 * DAY_SECONDS;
	const maxAge = directives.get("max-age");
	if (maxAge !== undefined && /^\d+$/.test(maxAge)) return Number.parseInt(maxAge, 10);
	const expires = resource.headers?.expires ?? null;
	if (expires === null || resource.checkedAt === null) return null;
	const at = Date.parse(expires);
	if (Number.isNaN(at)) return 0;
	return Math.max(0, Math.round((at - Date.parse(resource.checkedAt)) / 1000));
}

/**
 * Whether the page's own HTML was sent uncompressed.
 *
 * @param page - The page.
 * @returns Its size when it was, else null.
 */
function uncompressedDocument(page: AuditPage): number | null {
	const snapshot = htmlSnapshot(page);
	const headers = page.facts?.headers;
	if (snapshot === null || headers?.contentEncoding === undefined) return null;
	if (compressed(headers.contentEncoding)) return null;
	const bytes = page.facts?.sizeBytes ?? snapshot.sizeBytes;
	return bytes !== null && bytes >= DELIVERY_THRESHOLDS.compressMinBytes ? bytes : null;
}

/**
 * The delivery findings of one page: its HTML and the files it loads.
 *
 * @param page - The page.
 * @param resources - What it loads, with the site's latest check of each.
 * @returns The findings.
 */
export const deliveryFindings: AuditResourceRule = (page, resources) => {
	const key = page.pageKey;
	const siteHost = bareHostOfKey(key);
	const found: AuditFinding[] = [];
	const t = DELIVERY_THRESHOLDS;
	const own = { uncompressed: [] as string[], shortCache: [] as string[] };
	const other = { uncompressed: [] as string[], shortCache: [] as string[] };
	const seen = new Set<string>();
	for (const resource of resources) {
		if (seen.has(resource.url) || !answered(resource)) continue;
		seen.add(resource.url);
		const into = onOwnHost(resource.url, siteHost) ? own : other;
		if (
			seoCompressible(resource.kind, resource.contentType) &&
			!compressed(resource.headers?.contentEncoding) &&
			resource.sizeBytes !== null &&
			resource.sizeBytes >= t.compressMinBytes
		) {
			into.uncompressed.push(resource.url);
		}
		if (STATIC_KINDS.has(resource.kind)) {
			const lifetime = cacheLifetimeSeconds(resource);
			if (lifetime === null || lifetime < t.cacheMinDays * DAY_SECONDS)
				into.shortCache.push(resource.url);
		}
	}
	const documentBytes = uncompressedDocument(page);
	if (documentBytes !== null || own.uncompressed.length > 0) {
		found.push(
			finding(key, "compression_missing", {
				document: documentBytes === null ? "no" : "yes",
				count: own.uncompressed.length,
				urls: own.uncompressed.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	if (own.shortCache.length > 0) {
		found.push(
			finding(key, "cache_policy_weak", {
				count: own.shortCache.length,
				urls: own.shortCache.slice(0, AUDIT_EXAMPLES),
				days: t.cacheMinDays
			})
		);
	}
	if (other.uncompressed.length > 0) {
		found.push(
			finding(key, "compression_missing_third_party", {
				count: other.uncompressed.length,
				urls: other.uncompressed.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	if (other.shortCache.length > 0) {
		found.push(
			finding(key, "cache_policy_weak_third_party", {
				count: other.shortCache.length,
				urls: other.shortCache.slice(0, AUDIT_EXAMPLES),
				days: t.cacheMinDays
			})
		);
	}
	return found;
};
