import type { SeoPageRedirectHop } from "./facts";

import { drainStreamCapped, gunzipCapped, readStreamCapped } from "./bytes";
import type { FetchedAuditHeaders, FetchedResource, SeoCrawlFetcher } from "./types";

/**
 * ONE GUARDED FETCH, redirects followed by hand.
 *
 * The transport is `safeFetch` in production: it SSRF-checks the URL, pins the connection to the
 * address it checked and never follows a redirect itself. So every hop of a chain is a fresh call,
 * and every hop is checked again - a public page cannot bounce the crawler to a private address. The
 * body is read through a byte cap and the stream cancelled past it, so a huge or endless page costs
 * at most the cap.
 *
 * Plain `http:` is fetched as `https:`: the guard refuses plain http, and a site's http URL almost
 * always serves (or redirects to) the same page over https. A hop the server sent to `http:` keeps that
 * spelling beside the URL fetched (`location`), so the audit still sees a redirect to http.
 */

/** Statuses that carry a `Location` to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Options for {@link fetchResource}. */
export interface FetchResourceOptions {
	fetcher: SeoCrawlFetcher;
	userAgent: string;
	/** The `Accept` header. */
	accept: string;
	maxBytes: number;
	timeoutMs: number;
	maxRedirects: number;
	now: () => Date;
	/**
	 * Takes a 2xx answer's body as it arrives, within `maxBytes`, with the answer's `Content-Type`, and
	 * answers whether it takes more: the body is then never held (`body` stays null). Any other answer's
	 * body is cancelled unread.
	 */
	sink?: (bytes: Uint8Array, contentType: string | null) => Promise<boolean>;
}

/**
 * The URL a hop is fetched at: `http:` upgraded to `https:`, the fragment dropped.
 *
 * @param url - The absolute URL.
 * @returns The URL to fetch, or null when it is not http(s).
 */
export function toFetchUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	parsed.protocol = "https:";
	parsed.hash = "";
	return parsed.href;
}

/**
 * Names a transport failure.
 *
 * @param error - What the transport threw.
 * @returns The failure kind.
 */
function failureKind(error: unknown): "timeout" | "blocked" | "network" {
	if (error instanceof Error) {
		if (error.name === "BlockedUrlError") return "blocked";
		if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
	}
	return "network";
}

/** The audit headers a reading from an app from before they were read lacks (absent, not null). */
export const SEO_OPTIONAL_AUDIT_HEADERS = [
	"contentType",
	"contentEncoding",
	"cacheControl",
	"contentLanguage",
	"refresh"
] as const;

/**
 * The optional audit headers a fetch carries, each cut to a bound, the absent ones left out (unknown,
 * which a rule must not read as missing).
 *
 * @param headers - The fetch's headers.
 * @param maxChars - The most characters kept of each.
 * @returns The headers present.
 */
export function optionalAuditHeaders(
	headers: FetchedAuditHeaders,
	maxChars: number
): Partial<Record<(typeof SEO_OPTIONAL_AUDIT_HEADERS)[number], string | null>> {
	const kept: Partial<Record<(typeof SEO_OPTIONAL_AUDIT_HEADERS)[number], string | null>> = {};
	for (const name of SEO_OPTIONAL_AUDIT_HEADERS) {
		const value = headers[name];
		if (value !== undefined) kept[name] = value === null ? null : value.slice(0, maxChars);
	}
	return kept;
}

/** The audit headers of a fetch nothing answered. */
const NO_AUDIT_HEADERS: FetchedAuditHeaders = {
	strictTransportSecurity: null,
	contentSecurityPolicy: null,
	xContentTypeOptions: null,
	xFrameOptions: null,
	referrerPolicy: null,
	link: null,
	contentType: null,
	contentEncoding: null,
	cacheControl: null,
	contentLanguage: null,
	refresh: null
};

/**
 * The headers the site audit reads from a response.
 *
 * @param headers - The response's headers.
 * @returns The audit headers, null where absent.
 */
function readAuditHeaders(headers: Headers): FetchedAuditHeaders {
	return {
		strictTransportSecurity: headers.get("strict-transport-security"),
		contentSecurityPolicy: headers.get("content-security-policy"),
		xContentTypeOptions: headers.get("x-content-type-options"),
		xFrameOptions: headers.get("x-frame-options"),
		referrerPolicy: headers.get("referrer-policy"),
		link: headers.get("link"),
		contentType: headers.get("content-type"),
		contentEncoding: headers.get("content-encoding"),
		cacheControl: headers.get("cache-control"),
		contentLanguage: headers.get("content-language"),
		refresh: headers.get("refresh")
	};
}

/**
 * Fetches one URL, following up to `maxRedirects` hops, each through the guarded transport. The time
 * limit covers the whole chain: each hop gets what is left of it, so a slow redirect chain ends at the
 * limit as one slow answer does. The response time is the last hop's, the page's own answer: a
 * redirect before it (often the crawler's own spelling without the trailing slash a site links) is
 * timed by no visitor who follows the site's links, and the redirect checks judge it.
 *
 * @param url - The absolute URL.
 * @param options - The transport, headers and limits.
 * @returns What answered; `status` 0 with an `error` when nothing usable did.
 */
export async function fetchResource(
	url: string,
	options: FetchResourceOptions
): Promise<FetchedResource> {
	const started = options.now().getTime();
	const chain: SeoPageRedirectHop[] = [];
	let current = toFetchUrl(url);
	let spelled: string | null = null;
	const failed = (error: FetchedResource["error"]): FetchedResource => ({
		requestedUrl: url,
		finalUrl: current ?? url,
		status: chain[0]?.status ?? 0,
		finalStatus: 0,
		chain,
		contentType: null,
		xRobotsTag: null,
		auditHeaders: NO_AUDIT_HEADERS,
		body: null,
		truncated: false,
		sizeBytes: 0,
		responseMs: options.now().getTime() - started,
		error
	});
	if (current === null) return failed("blocked");
	for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
		const hopStarted = options.now().getTime();
		const left = options.timeoutMs - (hopStarted - started);
		if (left <= 0) return failed("timeout");
		let response: Response;
		try {
			response = await options.fetcher(
				current,
				{
					method: "GET",
					headers: {
						"User-Agent": options.userAgent,
						Accept: options.accept,
						"Accept-Language": "*"
					}
				},
				left
			);
		} catch (error) {
			return failed(failureKind(error));
		}
		chain.push(
			spelled === null || spelled === current
				? { url: current, status: response.status }
				: { url: current, status: response.status, location: spelled }
		);
		const location = response.headers.get("location");
		if (REDIRECT_STATUSES.has(response.status) && location !== null) {
			await response.body?.cancel().catch(() => undefined);
			let next: string | null;
			try {
				spelled = new URL(location, current).href;
				next = toFetchUrl(spelled);
			} catch {
				next = null;
			}
			if (next === null) return failed("blocked");
			current = next;
			continue;
		}
		let read: { body: Uint8Array | null; truncated: boolean; sizeBytes: number };
		try {
			const { sink } = options;
			if (sink === undefined) read = await readStreamCapped(response.body, options.maxBytes);
			else if (response.status >= 200 && response.status < 300) {
				const contentType = response.headers.get("content-type");
				const drained = await drainStreamCapped(response.body, options.maxBytes, (bytes) =>
					sink(bytes, contentType)
				);
				read = { body: null, ...drained };
			} else {
				await response.body?.cancel().catch(() => undefined);
				read = { body: null, truncated: false, sizeBytes: 0 };
			}
		} catch (error) {
			return failed(failureKind(error));
		}
		return {
			requestedUrl: url,
			finalUrl: current,
			status: chain[0]?.status ?? response.status,
			finalStatus: response.status,
			chain,
			contentType: response.headers.get("content-type"),
			xRobotsTag: response.headers.get("x-robots-tag"),
			auditHeaders: readAuditHeaders(response.headers),
			body: read.body,
			truncated: read.truncated,
			sizeBytes: read.sizeBytes,
			responseMs: options.now().getTime() - hopStarted,
			error: null,
			retryAfter: response.headers.get("retry-after")
		};
	}
	return failed("too_many_redirects");
}

/**
 * Decodes a body as text, as served: gzip unpacked (through the same byte cap as the read) when the
 * bytes are gzip, the charset the header names honoured when the runtime knows it, UTF-8 otherwise.
 * NUL characters are kept: a browser rendering the page must get them (a router whose root id holds
 * one fails to hydrate without it); nothing kept or stored may read this text ({@link decodeBody}).
 *
 * @param body - The bytes.
 * @param contentType - The `Content-Type` header, if any.
 * @param maxBytes - The most unpacked bytes read.
 * @returns The text.
 */
export async function decodeServedBody(
	body: Uint8Array,
	contentType: string | null,
	maxBytes: number
): Promise<string> {
	let bytes = body.byteLength > maxBytes ? body.subarray(0, maxBytes) : body;
	if (bytes.byteLength > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
		try {
			bytes = (await gunzipCapped(bytes, maxBytes)).body;
		} catch {
			bytes = body.subarray(0, Math.min(body.byteLength, maxBytes));
		}
	}
	const charset = /charset=([^;\s]+)/i.exec(contentType ?? "")?.[1]?.replace(/["']/g, "");
	let text: string;
	try {
		text = new TextDecoder(charset ?? "utf-8").decode(bytes);
	} catch {
		text = new TextDecoder("utf-8").decode(bytes);
	}
	return text;
}

/**
 * Drops the NUL characters of a text (Postgres text cannot hold them).
 *
 * @param text - The text.
 * @returns It without NULs.
 */
export function withoutNul(text: string): string {
	return text.replaceAll("\u0000", "");
}

/**
 * Decodes a body as text ({@link decodeServedBody}) with its NUL characters dropped, so it can be
 * read, kept and stored.
 *
 * @param body - The bytes.
 * @param contentType - The `Content-Type` header, if any.
 * @param maxBytes - The most unpacked bytes read.
 * @returns The text.
 */
export async function decodeBody(
	body: Uint8Array,
	contentType: string | null,
	maxBytes: number
): Promise<string> {
	return withoutNul(await decodeServedBody(body, contentType, maxBytes));
}
