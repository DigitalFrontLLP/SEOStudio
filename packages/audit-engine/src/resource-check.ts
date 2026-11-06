import { seoCrawlerLimits, seoResourceCheckLimits } from "./config";
import type {
	SeoPageRedirectHop,
	SeoResourceCheckErrorValue,
	SeoResourceCheckMethodValue,
	SeoResourceHeaders,
	SeoResourceKindValue
} from "./facts";

import { gunzipCapped, readStreamCapped } from "./bytes";
import { isPdf, pdfTitleOf } from "./document-facts";
import { toFetchUrl } from "./fetch";
import { gifAnimated, imageSizeOf } from "./image-size";
import type { SeoImageSize } from "./image-size";
import { hostGateKey, isSharedCdnHost } from "./host-gate";
import type { SeoHostGate } from "./host-gate";
import { SEO_READING_LIMITS } from "./reading-limits";
import { isOutboundLink } from "./resources";
import { GOOGLEBOT_FILE_BYTES } from "./rules/head";
import type { SeoCrawlFetcher } from "./types";

/**
 * THE RESOURCE CHECK'S NETWORK HALF: one URL a site's pages load or link out to, asked about through
 * the crawler's guarded transport (`safeFetch` in production: every hop SSRF-checked again, redirects
 * followed here by hand), and a list of them read politely: each host one request at a time with a pause
 * between two requests to it, a few hosts at once. Plain JSON out and NO database, so the server's crawl job and the
 * desktop app's main process run the very same check.
 *
 * A file a page loads gets a HEAD, then a ranged GET (`Range: bytes=0-0`) when the HEAD was refused or
 * did not say how big the file is; a server that ignores the range has its body counted up to a cap and
 * cut. An outbound link gets a HEAD alone, and a ranged GET only where the HEAD was refused or answered
 * any failure but a 429 (some servers fail a HEAD they would answer by GET): its status is all its
 * check needs. An image is asked for with a browser's `Accept` header (a server that sends WebP or
 * AVIF to browsers answers as it does for them), and one of some weight gets one more ranged GET of its
 * first bytes, where its header states its pixel size (an image much larger than the page shows it is
 * wasted bytes) and a GIF shows whether it is animated. A text file a page
 * loads (a script, a stylesheet, an SVG, JSON) whose answer named no compression is asked once more by
 * a plain GET offering gzip and brotli, its body never read: many servers compress a GET but not a
 * HEAD or a ranged answer. A compressed script or stylesheet of some weight is read once by a plain GET,
 * up to just past what Googlebot reads of a file, for its unpacked size. A linked PDF gets two ranged
 * GETs more, of its first and its last bytes, where its title is written. A link's spelling of a page of
 * the site is asked once, its redirect never followed: what that one answer says is all its check needs.
 */

/** Images lighter than this are not asked for their pixel size: shown too large, they waste little. */
export const SEO_IMAGE_SIZE_MIN_BYTES = 20 * 1024;

/** The first bytes of an image read for its pixel size. */
const IMAGE_HEADER_BYTES = 32 * 1024;

/** Text under this many bytes gains too little from compression to be judged. */
export const SEO_COMPRESS_MIN_BYTES = 4 * 1024;

/**
 * A compressed script or stylesheet lighter than this is not unpacked to measure: no real code
 * compresses over a hundred times, so it cannot unpack past what Googlebot reads of a file.
 */
const DECODE_MIN_BYTES = 16 * 1024;

/** Content types worth compressing: HTML and other text, JavaScript, JSON, XML, SVG. */
const COMPRESSIBLE =
	/^(?:text\/|application\/(?:[\w.+-]*\+)?(?:javascript|ecmascript|json|xml)|image\/svg\+xml)/i;

/** The kinds of file that are binary unless they are an SVG. */
const MEDIA_KINDS: ReadonlySet<SeoResourceKindValue> = new Set([
	"image",
	"og_image",
	"icon",
	"font",
	"media"
]);

/**
 * Whether a file is text worth compressing: a text content type, and for an image, an icon, a font or
 * a media file, an SVG only (a binary file a server labels as text is not).
 *
 * @param kind - How a page uses it.
 * @param contentType - The `Content-Type`, or null.
 * @returns Whether it is.
 */
export function seoCompressible(kind: SeoResourceKindValue, contentType: string | null): boolean {
	const type = (contentType ?? "").trim().toLowerCase();
	if (MEDIA_KINDS.has(kind)) return type.startsWith("image/svg+xml");
	return COMPRESSIBLE.test(type);
}

/** The most characters of a kept header. */
const HEADER_CHARS = 200;

/** Statuses that carry a `Location` to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** HEAD answers that often mean "this server refuses HEAD", not "this URL is broken": asked again by GET. */
const HEAD_REFUSED = new Set([400, 403, 405, 501]);

/** One URL to check. */
export interface SeoResourceCheckTarget {
	url: string;
	kind: SeoResourceKindValue;
}

/**
 * What one check found. No response header is kept beyond the content type, the size and, for a file
 * a page loads, its caching and compression headers (the rules read no other), and a failure is only
 * ever one of the {@link SeoResourceCheckErrorValue} codes, never a transport's message.
 */
export interface SeoResourceReading {
	/** The URL checked, as it was handed out. */
	url: string;
	kind: SeoResourceKindValue;
	/** The request whose answer is kept: a HEAD, or the GET that followed it. */
	method: SeoResourceCheckMethodValue;
	/** The first hop's status (a redirecting URL is a redirect), 0 when nothing answered. */
	status: number;
	/** The last hop's status, 0 when nothing answered. */
	finalStatus: number;
	finalUrl: string;
	chain: SeoPageRedirectHop[];
	contentType: string | null;
	/** The body's size in bytes as served, or null when the server never said. */
	sizeBytes: number | null;
	/**
	 * An image's pixel size, from its file header; null when it was not read (not an image, a light
	 * one, an SVG, a format not known); absent from an app from before it was read.
	 */
	width?: number | null;
	height?: number | null;
	/**
	 * The caching and compression headers of a file a page loads; null for an outbound link or when
	 * nothing answered; absent from an app from before they were kept (an older app's `headers`, read
	 * from a HEAD alone, are never taken for them).
	 */
	delivery?: SeoResourceHeaders | null;
	/**
	 * A linked document's title from its metadata (a PDF's): `''` when it holds none, null when it was
	 * not read; absent from an app from before it was read.
	 */
	title?: string | null;
	responseMs: number;
	error: SeoResourceCheckErrorValue | null;
}

/** What a check reaches outside itself. */
export interface SeoResourceCheckDeps {
	fetch: SeoCrawlFetcher;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
	/** The per-host pace every crawl of a host shares (the server's); without one a list paces itself. */
	hostGate?: SeoHostGate;
}

/** One request's outcome, redirects followed. */
interface Hops {
	chain: SeoPageRedirectHop[];
	finalUrl: string;
	response: Response | null;
	error: SeoResourceReading["error"];
}

/**
 * Names a transport failure.
 *
 * @param error - What the transport threw.
 * @returns The failure kind.
 */
function failureKind(error: unknown): "timeout" | "blocked" | "network" | "dns_not_found" {
	if (error instanceof Error) {
		if (error.name === "BlockedUrlError") {
			const reason = "reason" in error ? error.reason : null;
			if (reason === "not_found") return "dns_not_found";
			if (reason === "dns_unavailable") return "network";
			return "blocked";
		}
		if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
	}
	return "network";
}

/**
 * Asks for a URL, following redirects by hand, each hop through the guarded transport. The final
 * answer's body is left unread for the caller.
 *
 * @param url - The URL.
 * @param method - HEAD, or a ranged GET.
 * @param userAgent - The User-Agent.
 * @param fetcher - The guarded transport.
 * @param range - The range a GET asks for, or null for the whole body (offering compression).
 * @param accept - The `Accept` header: an image is asked for as a browser asks for one.
 * @returns The chain and the final answer, or the failure.
 */
async function follow(
	url: string,
	method: "HEAD" | "GET",
	userAgent: string,
	fetcher: SeoCrawlFetcher,
	range: string | null = "bytes=0-0",
	accept: string = "*/*"
): Promise<Hops> {
	const chain: SeoPageRedirectHop[] = [];
	let current = toFetchUrl(url);
	if (current === null) return { chain, finalUrl: url, response: null, error: "blocked" };
	for (let hop = 0; hop <= seoCrawlerLimits.maxRedirects; hop += 1) {
		let response: Response;
		try {
			response = await fetcher(
				current,
				{
					method,
					headers: {
						"User-Agent": userAgent,
						Accept: accept,
						...(method !== "GET"
							? {}
							: range === null
								? { "Accept-Encoding": "gzip, deflate, br" }
								: { Range: range })
					}
				},
				seoCrawlerLimits.timeoutMs
			);
		} catch (error) {
			return { chain, finalUrl: current, response: null, error: failureKind(error) };
		}
		chain.push({ url: current, status: response.status });
		const location = response.headers.get("location");
		if (!REDIRECT_STATUSES.has(response.status) || location === null) {
			return { chain, finalUrl: current, response, error: null };
		}
		await response.body?.cancel().catch(() => undefined);
		let next: string | null;
		try {
			next = toFetchUrl(new URL(location, current).href);
		} catch {
			next = null;
		}
		if (next === null) return { chain, finalUrl: current, response: null, error: "blocked" };
		current = next;
	}
	return { chain, finalUrl: current, response: null, error: "too_many_redirects" };
}

/**
 * A whole, non-negative number from a header.
 *
 * @param value - The header value, or null.
 * @returns The number, or null.
 */
function wholeNumber(value: string | null): number | null {
	if (value === null || !/^\s*\d+\s*$/.test(value)) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * A file's full size from a ranged answer's `Content-Range` (`bytes 0-0/12345`).
 *
 * @param value - The header value, or null.
 * @returns The size, or null when it names none.
 */
function rangeTotal(value: string | null): number | null {
	const total = /\/\s*(\d+)\s*$/.exec(value ?? "")?.[1];
	return total === undefined ? null : wholeNumber(total);
}

/**
 * The size an answer tells, reading the body only when it has to: a ranged answer's total, else the
 * `Content-Length` of a whole answer, else the body counted up to the cap.
 *
 * @param response - The answer.
 * @param method - How it was asked for.
 * @returns The size, or null when it cannot be told.
 */
async function sizeOf(response: Response, method: "HEAD" | "GET"): Promise<number | null> {
	if (method === "GET" && response.status === 206) {
		await response.body?.cancel().catch(() => undefined);
		return rangeTotal(response.headers.get("content-range"));
	}
	const length = wholeNumber(response.headers.get("content-length"));
	if (method === "HEAD" || length !== null) {
		await response.body?.cancel().catch(() => undefined);
		return length;
	}
	try {
		return (await readStreamCapped(response.body, seoResourceCheckLimits.maxBodyBytes)).sizeBytes;
	} catch {
		return null;
	}
}

/**
 * The reading of one request's answer.
 *
 * @param target - What was checked.
 * @param hops - The request's outcome.
 * @param method - How it was asked for.
 * @param started - When the check began, in ms.
 * @param now - The clock.
 * @param measure - Whether the body's size is wanted.
 * @returns The reading.
 */
async function readingOf(
	target: SeoResourceCheckTarget,
	hops: Hops,
	method: "HEAD" | "GET",
	started: number,
	now: () => Date,
	measure: boolean
): Promise<SeoResourceReading> {
	const response = hops.response;
	let sizeBytes: number | null = null;
	if (response !== null) {
		if (measure && response.status >= 200 && response.status < 300) {
			sizeBytes = await sizeOf(response, method);
		} else {
			await response.body?.cancel().catch(() => undefined);
		}
	}
	return {
		url: target.url,
		kind: target.kind,
		method: method === "HEAD" ? "head" : "get",
		status: hops.chain[0]?.status ?? 0,
		finalStatus: response?.status ?? 0,
		finalUrl: hops.finalUrl.slice(0, SEO_READING_LIMITS.textChars),
		chain: hops.chain.map((hop) => ({
			url: hop.url.slice(0, SEO_READING_LIMITS.textChars),
			status: hop.status
		})),
		contentType: response?.headers.get("content-type")?.slice(0, 200) ?? null,
		sizeBytes,
		delivery: measure && response !== null ? keptHeaders(response.headers) : null,
		responseMs: now().getTime() - started,
		error: hops.error
	};
}

/**
 * The caching and compression headers a check keeps.
 *
 * @param headers - The answer's headers.
 * @returns The kept headers, null where absent.
 */
function keptHeaders(headers: Headers): SeoResourceHeaders {
	const cut = (value: string | null): string | null =>
		value === null ? null : value.slice(0, HEADER_CHARS);
	return {
		cacheControl: cut(headers.get("cache-control")),
		expires: cut(headers.get("expires")),
		contentEncoding: cut(headers.get("content-encoding"))
	};
}

/**
 * The compression a text file is served with, asked by a plain GET offering gzip and brotli when its
 * check named none and it is heavy enough to be judged (a HEAD or a ranged answer is often sent
 * uncompressed by a server that compresses the file itself). The body is never read.
 *
 * @param reading - Its check.
 * @param userAgent - The crawler's User-Agent.
 * @param fetcher - The guarded transport.
 * @returns The `Content-Encoding` the GET named (null for none), or undefined when it was not asked
 *   or did not answer.
 */
async function textEncoding(
	reading: SeoResourceReading,
	userAgent: string,
	fetcher: SeoCrawlFetcher
): Promise<string | null | undefined> {
	if (reading.delivery == null) return undefined;
	if (
		reading.delivery.contentEncoding !== null ||
		!seoCompressible(reading.kind, reading.contentType)
	) {
		return undefined;
	}
	if (reading.sizeBytes === null || reading.sizeBytes < SEO_COMPRESS_MIN_BYTES) return undefined;
	if (reading.error !== null || reading.finalStatus < 200 || reading.finalStatus >= 300) {
		return undefined;
	}
	const hops = await follow(reading.finalUrl, "GET", userAgent, fetcher, null);
	const response = hops.response;
	if (response === null) return undefined;
	await response.body?.cancel().catch(() => undefined);
	if (response.status < 200 || response.status >= 300) return undefined;
	return response.headers.get("content-encoding")?.slice(0, HEADER_CHARS) ?? null;
}

/**
 * What a browser asks for when it loads an image, so a server that sends newer formats (WebP, AVIF) to
 * browsers answers the check as it answers them.
 */
const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

/**
 * The `Accept` header a file is asked for with.
 *
 * @param kind - How a page uses it.
 * @returns The header.
 */
function acceptFor(kind: SeoResourceKindValue): string {
	return kind === "image" ? IMAGE_ACCEPT : "*/*";
}

/**
 * Reads an image's pixel size, and whether it is an animated GIF, from its first bytes, when it is an
 * image heavy enough to matter.
 *
 * @param target - What was checked.
 * @param reading - Its check.
 * @param userAgent - The crawler's User-Agent.
 * @param fetcher - The guarded transport.
 * @returns The size (null when the header did not state one) and the animation, or null when not read.
 */
async function imageHeader(
	target: SeoResourceCheckTarget,
	reading: SeoResourceReading,
	userAgent: string,
	fetcher: SeoCrawlFetcher
): Promise<{ size: SeoImageSize | null; animated: boolean } | null> {
	if (target.kind !== "image" && target.kind !== "og_image") return null;
	if (reading.error !== null || reading.finalStatus < 200 || reading.finalStatus >= 300)
		return null;
	const type = (reading.contentType ?? "").toLowerCase();
	if (!type.startsWith("image/") || type.includes("svg")) return null;
	if (reading.sizeBytes !== null && reading.sizeBytes < SEO_IMAGE_SIZE_MIN_BYTES) return null;
	const hops = await follow(
		reading.finalUrl,
		"GET",
		userAgent,
		fetcher,
		`bytes=0-${String(IMAGE_HEADER_BYTES - 1)}`,
		acceptFor(target.kind)
	);
	const response = hops.response;
	if (response === null) return null;
	if (response.status < 200 || response.status >= 300) {
		await response.body?.cancel().catch(() => undefined);
		return null;
	}
	try {
		const { body } = await readStreamCapped(response.body, IMAGE_HEADER_BYTES);
		return { size: imageSizeOf(body), animated: gifAnimated(body) };
	} catch {
		return null;
	}
}

/**
 * CHECKS ONE URL: a HEAD, then a ranged GET where the HEAD was refused (or, for a file a page loads,
 * did not say the file's size; for an outbound link, answered a failure), an image's first bytes for
 * its pixel size, and a text file's compression by a plain GET where its answer named none. Never
 * throws: a failure is a reading with its error, and a host that does not
 * exist in DNS is told apart (`dns_not_found`) from a resolver that could not answer for now
 * (`network`).
 *
 * @param target - The URL and how a page uses it.
 * @param userAgent - The crawler's User-Agent.
 * @param deps - The guarded transport and the clock.
 * @returns What it found.
 */
async function checkResource(
	target: SeoResourceCheckTarget,
	userAgent: string,
	deps: Pick<SeoResourceCheckDeps, "fetch" | "now">
): Promise<SeoResourceReading> {
	if (target.kind === "spelling") return checkLinkSpelling(target, userAgent, deps);
	const answer = await checkResourceAnswer(target, userAgent, deps);
	const encoding = await textEncoding(answer, userAgent, deps.fetch);
	const reading =
		encoding === undefined || answer.delivery == null
			? answer
			: { ...answer, delivery: { ...answer.delivery, contentEncoding: encoding } };
	const decoded = await decodedSize(target, answer, userAgent, deps.fetch);
	const measured =
		decoded === undefined || reading.delivery == null
			? reading
			: { ...reading, delivery: { ...reading.delivery, decodedBytes: decoded } };
	const header = await imageHeader(target, measured, userAgent, deps.fetch);
	const sizedHeader =
		header?.size == null
			? measured
			: { ...measured, width: header.size.width, height: header.size.height };
	const sized =
		header?.animated === true && sizedHeader.delivery != null
			? { ...sizedHeader, delivery: { ...sizedHeader.delivery, animated: true } }
			: sizedHeader;
	if (target.kind !== "document") return sized;
	return { ...sized, title: await documentTitle(sized, userAgent, deps.fetch) };
}

/**
 * Reads a ranged slice of a file, up to the bytes asked.
 *
 * @param url - The file.
 * @param range - The `Range` header.
 * @param max - The most bytes read.
 * @param userAgent - The crawler's User-Agent.
 * @param fetcher - The guarded transport.
 * @returns The bytes and whether the server answered the range, or null when it did not answer 2xx.
 */
async function rangedBytes(
	url: string,
	range: string,
	max: number,
	userAgent: string,
	fetcher: SeoCrawlFetcher
): Promise<{ bytes: Uint8Array; ranged: boolean } | null> {
	const hops = await follow(url, "GET", userAgent, fetcher, range);
	const response = hops.response;
	if (response === null) return null;
	if (response.status < 200 || response.status >= 300) {
		await response.body?.cancel().catch(() => undefined);
		return null;
	}
	try {
		const { body } = await readStreamCapped(response.body, max);
		return { bytes: body, ranged: response.status === 206 };
	} catch {
		return null;
	}
}

/**
 * A linked PDF's title, from its first and last bytes (`seoResourceCheckLimits.documentTitleBytes`
 * each): `''` when it holds none, null when it is not a PDF, did not answer, or cannot be told.
 *
 * @param reading - The document's check.
 * @param userAgent - The crawler's User-Agent.
 * @param fetcher - The guarded transport.
 * @returns The title.
 */
async function documentTitle(
	reading: SeoResourceReading,
	userAgent: string,
	fetcher: SeoCrawlFetcher
): Promise<string | null> {
	if (reading.error !== null || reading.finalStatus < 200 || reading.finalStatus >= 300)
		return null;
	if (!isPdf(reading.finalUrl, reading.contentType)) return null;
	const max = seoResourceCheckLimits.documentTitleBytes;
	const head = await rangedBytes(
		reading.finalUrl,
		`bytes=0-${String(max - 1)}`,
		max,
		userAgent,
		fetcher
	);
	if (head === null) return null;
	const whole = reading.sizeBytes !== null && reading.sizeBytes <= max;
	if (!head.ranged || whole) return pdfTitleOf([head.bytes]);
	const tail = await rangedBytes(
		reading.finalUrl,
		`bytes=-${String(max)}`,
		max,
		userAgent,
		fetcher
	);
	return pdfTitleOf(tail === null || !tail.ranged ? [head.bytes] : [head.bytes, tail.bytes]);
}

/**
 * The unpacked size of a compressed script or stylesheet, which is what Googlebot's per-file limit
 * counts (the served size is the compressed one), read by a plain GET up to just past that limit.
 *
 * @param target - What was checked.
 * @param reading - Its first answer: a size it states is the compressed one only when that answer
 *   named a compression itself.
 * @param userAgent - The crawler's User-Agent.
 * @param fetcher - The guarded transport.
 * @returns The unpacked bytes (past the limit, a number over it), or undefined when not measured.
 */
async function decodedSize(
	target: SeoResourceCheckTarget,
	reading: SeoResourceReading,
	userAgent: string,
	fetcher: SeoCrawlFetcher
): Promise<number | undefined> {
	if (target.kind !== "script" && target.kind !== "stylesheet") return undefined;
	const encoding = (reading.delivery?.contentEncoding ?? "").trim().toLowerCase();
	if (encoding === "" || encoding === "identity") return undefined;
	if (reading.error !== null || reading.finalStatus < 200 || reading.finalStatus >= 300) {
		return undefined;
	}
	if (reading.sizeBytes !== null && reading.sizeBytes < DECODE_MIN_BYTES) return undefined;
	const hops = await follow(reading.finalUrl, "GET", userAgent, fetcher, null);
	const response = hops.response;
	if (response === null) return undefined;
	if (response.status < 200 || response.status >= 300) {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
	try {
		const read = await readStreamCapped(response.body, GOOGLEBOT_FILE_BYTES + 1);
		const gzip = read.body[0] === 0x1f && read.body[1] === 0x8b;
		if (!gzip || read.truncated) return read.sizeBytes;
		return (await gunzipCapped(read.body, GOOGLEBOT_FILE_BYTES + 1)).sizeBytes;
	} catch {
		return undefined;
	}
}

/**
 * Asks once for a link's spelling of a page of the site, never following where it leads: a HEAD, and a
 * ranged GET where the HEAD was refused or said the page is gone (a GET confirms it). That answer is
 * the reading: a redirect's status with the URL its `Location` names as the final URL, or the page's
 * own status.
 *
 * @param target - The spelling.
 * @param userAgent - The crawler's User-Agent.
 * @param deps - The guarded transport and the clock.
 * @returns What it answered.
 */
async function checkLinkSpelling(
	target: SeoResourceCheckTarget,
	userAgent: string,
	deps: Pick<SeoResourceCheckDeps, "fetch" | "now">
): Promise<SeoResourceReading> {
	const started = deps.now().getTime();
	const url = toFetchUrl(target.url);
	const ask = async (
		method: "HEAD" | "GET"
	): Promise<{ response: Response | null; error: SeoResourceReading["error"] }> => {
		if (url === null) return { response: null, error: "blocked" };
		try {
			const response = await deps.fetch(
				url,
				{
					method,
					headers: {
						"User-Agent": userAgent,
						Accept: "*/*",
						...(method === "GET" ? { Range: "bytes=0-0" } : {})
					}
				},
				seoCrawlerLimits.timeoutMs
			);
			return { response, error: null };
		} catch (error) {
			return { response: null, error: failureKind(error) };
		}
	};
	let method: "HEAD" | "GET" = "HEAD";
	let answer = await ask(method);
	const recheck = answer.response?.status ?? 0;
	if (HEAD_REFUSED.has(recheck) || recheck === 404 || recheck === 410) {
		await answer.response?.body?.cancel().catch(() => undefined);
		method = "GET";
		answer = await ask(method);
	}
	const response = answer.response;
	await response?.body?.cancel().catch(() => undefined);
	const status = response?.status ?? 0;
	const location = REDIRECT_STATUSES.has(status) ? response?.headers.get("location") : null;
	let finalUrl = url ?? target.url;
	if (location !== null && location !== undefined) {
		try {
			finalUrl = new URL(location, finalUrl).href;
		} catch {
			finalUrl = url ?? target.url;
		}
	}
	return {
		url: target.url,
		kind: target.kind,
		method: method === "HEAD" ? "head" : "get",
		status,
		finalStatus: status,
		finalUrl: finalUrl.slice(0, SEO_READING_LIMITS.textChars),
		chain:
			response === null
				? []
				: [{ url: (url ?? target.url).slice(0, SEO_READING_LIMITS.textChars), status }],
		contentType: null,
		sizeBytes: null,
		delivery: null,
		responseMs: deps.now().getTime() - started,
		error: answer.error
	};
}

/**
 * The HEAD (and ranged GET) of one URL.
 *
 * @param target - The URL and how a page uses it.
 * @param userAgent - The crawler's User-Agent.
 * @param deps - The guarded transport and the clock.
 * @returns What it found.
 */
async function checkResourceAnswer(
	target: SeoResourceCheckTarget,
	userAgent: string,
	deps: Pick<SeoResourceCheckDeps, "fetch" | "now">
): Promise<SeoResourceReading> {
	const started = deps.now().getTime();
	const measure = !isOutboundLink(target.kind);
	const accept = acceptFor(target.kind);
	const head = await follow(target.url, "HEAD", userAgent, deps.fetch, undefined, accept);
	const finalStatus = head.response?.status ?? 0;
	const refused =
		head.response !== null &&
		(HEAD_REFUSED.has(finalStatus) || (!measure && finalStatus >= 400 && finalStatus !== 429));
	const sizeUnknown =
		measure &&
		head.response !== null &&
		finalStatus >= 200 &&
		finalStatus < 300 &&
		wholeNumber(head.response.headers.get("content-length")) === null;
	if (!refused && !sizeUnknown) {
		return readingOf(target, head, "HEAD", started, deps.now, measure);
	}
	await head.response?.body?.cancel().catch(() => undefined);
	const get = await follow(target.url, "GET", userAgent, deps.fetch, undefined, accept);
	if (sizeUnknown && get.response === null) {
		return readingOf(target, head, "HEAD", started, deps.now, false);
	}
	return readingOf(target, get, "GET", started, deps.now, measure);
}

/**
 * The host a URL is asked at, for the pause between two requests to it.
 *
 * @param url - The URL.
 * @returns The host, or the URL itself when it cannot be parsed.
 */
function hostOf(url: string): string {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return url;
	}
}

/** How a list of checks is read. */
export interface SeoReadResourcesOptions {
	/** The pause between two requests to the same host, in ms (a shared CDN host's is shorter). */
	delayMs: number;
	/**
	 * The site's own host. When given, `delayMs` (which may hold the site's own `Crawl-delay`) paces
	 * that host alone; every other host gets the crawler's own pause, so a site's robots.txt never
	 * slows the shared pace of a host it does not own (an image CDN, another site).
	 */
	siteHost?: string;
	/** Asked before each check; true stops the list there (a deadline, a pause, a stop). */
	stop?: () => boolean;
	/** Told the URL about to be checked. */
	onCheck?: (url: string) => void;
}

/**
 * How many hosts a list of checks reads at once. Each host is still read one check at a time, at its
 * own pace: a page's files spread over a few hosts (the site, its image and script CDNs, the tags it
 * loads), and checking them one after another made every host wait for the others' answers.
 */
export const SEO_RESOURCE_HOSTS_AT_ONCE = 4;

/**
 * READS A LIST OF CHECKS POLITELY: each host one check at a time, never two requests to one host
 * closer than `delayMs` (a check that needs a second request waits again), up to
 * {@link SEO_RESOURCE_HOSTS_AT_ONCE} hosts at once, so a host is never slowed by another's pause or
 * answer. A shared CDN host (`SEO_SHARED_CDN_HOSTS`), built for every site's traffic, is asked at its
 * own shorter pause; a site's own hosts keep `delayMs`. On the server every request takes its turn in
 * the per-host pace every crawl of that host shares.
 *
 * @param targets - The URLs to check.
 * @param userAgent - The crawler's User-Agent.
 * @param deps - The guarded transport, the clock and the pause.
 * @param options - The pause between two requests to one host and when to stop.
 * @returns The readings in the list's order, of the checks made before the list stopped.
 */
export async function readResources(
	targets: readonly SeoResourceCheckTarget[],
	userAgent: string,
	deps: SeoResourceCheckDeps,
	options: SeoReadResourcesOptions
): Promise<SeoResourceReading[]> {
	const nextAt = new Map<string, number>();
	const siteHost = options.siteHost === undefined ? null : hostGateKey(options.siteHost);
	const delayOf = (host: string): number =>
		siteHost === null || host === siteHost
			? options.delayMs
			: Math.min(options.delayMs, seoCrawlerLimits.minDelayMs);
	const paced: SeoResourceCheckDeps["fetch"] = async (url, init, timeoutMs) => {
		const host = hostGateKey(hostOf(url));
		const delayMs = isSharedCdnHost(host)
			? Math.min(delayOf(host), seoResourceCheckLimits.sharedCdnDelayMs)
			: delayOf(host);
		const now = deps.now().getTime();
		const wait =
			deps.hostGate !== undefined
				? await deps.hostGate.reserve(host, delayMs, now)
				: Math.max(0, (nextAt.get(host) ?? now) - now);
		nextAt.set(host, Math.max(nextAt.get(host) ?? 0, now + wait + delayMs));
		if (wait > 0) await deps.sleep(wait);
		try {
			return await deps.fetch(url, init, timeoutMs);
		} finally {
			nextAt.set(host, Math.max(nextAt.get(host) ?? 0, deps.now().getTime() + delayMs));
		}
	};
	const byHost = new Map<string, number[]>();
	for (const [index, target] of targets.entries()) {
		const host = hostGateKey(hostOf(target.url));
		const queue = byHost.get(host);
		if (queue === undefined) byHost.set(host, [index]);
		else queue.push(index);
	}
	const queues = [...byHost.values()];
	const readings: (SeoResourceReading | undefined)[] = [];
	let stopped = false;
	const lane = async (): Promise<void> => {
		for (let queue = queues.shift(); queue !== undefined; queue = queues.shift()) {
			for (const index of queue) {
				const target = targets[index];
				if (target === undefined) continue;
				if (stopped || options.stop?.() === true) {
					stopped = true;
					return;
				}
				options.onCheck?.(target.url);
				readings[index] = await checkResource(target, userAgent, { fetch: paced, now: deps.now });
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(SEO_RESOURCE_HOSTS_AT_ONCE, queues.length) }, lane)
	);
	return readings.filter((reading): reading is SeoResourceReading => reading !== undefined);
}
