import { seoCrawlerLimits, seoDesktopRenderUserAgent, seoRenderUserAgent } from "./config";
import type {
	SeoPageA11yFacts,
	SeoPageDomFacts,
	SeoPageRenderResourceFailure,
	SeoPageScriptResult
} from "./facts";

import { SEO_A11Y_RULES } from "./a11y-rules.generated";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { SEO_DOM_LIMITS, seoA11yFactsSchema, seoDomFactsSchema } from "./dom-facts-schema";
import { SEO_CRAWL_OPTION_LIMITS } from "./reading-limits";
import { seoCaptureInPage } from "./render-capture";
import { RenderCookieJar } from "./render-cookies";
import { bareHost, onSiteOrBelow } from "./scope";
import {
	SEO_PROBE_INIT_SCRIPT,
	SEO_PROBE_WORLD,
	seoAxeExpression,
	seoProbeExpression
} from "./render-probe";
import type {
	SeoBrowserRender,
	SeoCrawlFetcher,
	SeoPageRenderer,
	SeoRenderCaptureResult,
	SeoRenderRequest,
	SeoRenderScript
} from "./types";

/** The pixel density a content screenshot (`request.capture`) renders at, for sharp text. */
const CAPTURE_SCALE = 2;

/**
 * THE RENDER, as one Chrome DevTools Protocol conversation with a page: the same code drives the
 * server's headless Chromium (Playwright's CDP session) and the desktop app's hidden Electron window
 * (its `webContents.debugger`), so both render a page the same way.
 *
 * Like Google's renderer: the page is the raw HTML the crawler already read (never fetched again), on a
 * phone's viewport, its scripts run until the network and the DOM go quiet or the time limit cuts it;
 * images, fonts and media are never loaded (a content screenshot alone loads the images and fonts,
 * through the same guarded transport, so it shows what a visitor sees) - an image is answered with an empty placeholder that has
 * no size of its own (only a photo's 16:9 shape), so it takes the box the page gives it (its width and
 * height attributes, its CSS) as the loaded image would; scripts, styles and data requests are loaded, through the crawler's own
 * guarded transport.
 *
 * SECURITY: the page runs the site's own JavaScript. EVERY request it makes is paused here and either
 * refused or fetched by THIS code through the guarded transport (`safeFetch` in production: https
 * only, the host resolved and every address checked against private, loopback, link-local and metadata
 * ranges, the connection pinned to the address it checked, redirects never followed - the browser
 * re-asks for each hop, so each is checked again). The browser itself never opens a connection for a
 * paused request. What cannot be paused (a WebSocket, a service worker, WebRTC) is removed from the
 * page or refused here, and the hosts send the browser's own network into a black hole besides.
 * Dialogs are dismissed, popups and downloads refused by the hosts.
 *
 * NEVER AN OPEN PROXY: a page may read (GET, HEAD) from any public host, but it may send (POST) only to
 * its own site, with a small body; every other method is refused. No cookie or credential of ours ever
 * rides along (a short list of request headers is forwarded to other hosts, the headers the page's own
 * scripts set only to its own site, and their token only to the page's exact origin; the cookies its
 * own site sets during the render go back to that site alone, as a browser sends them, and are
 * forgotten with the render, `./render-cookies`). A render makes a bounded number of requests, a
 * bounded number at once, and reads a bounded number of bytes in all.
 *
 * NEVER UNBOUNDED: every DevTools call is bounded by the render's hard deadline (its time limit plus a
 * short grace), so a page whose script never yields, a DOM too large to read, or a flood of requests or
 * console events cannot hold the render, or the crawl behind it: the render answers a failed outcome
 * (`hung`, `too_large`) and the host kills the page.
 *
 * MEASURED, NOT TRUSTED: once the DOM is read, a phone render runs the in-page probe (`./render-probe`)
 * and, when asked, the accessibility checks (axe-core), both in an isolated world the page's scripts
 * cannot reach, each in its own bounded time; their answer is parsed against a bounded schema. What the
 * page transferred and the history entries it added are measured here, outside the page. The page's
 * console errors are kept only until the render ends: past that its requests are refused (a script the
 * probes' scrolling asked for then fails to load), so a later error is the render's, never the page's.
 *
 * Pure apart from the channel and the transport it is handed: no Node, no Electron, no Playwright.
 */

/** A DevTools session on one page. */
export interface SeoCdpChannel {
	/**
	 * Sends a command.
	 *
	 * @param method - The CDP method, e.g. `Page.navigate`.
	 * @param params - Its parameters.
	 * @returns The result.
	 */
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	/**
	 * Listens to one event.
	 *
	 * @param event - The CDP event, e.g. `Fetch.requestPaused`.
	 * @param listener - Called with its parameters.
	 */
	on(event: string, listener: (params: unknown) => void): void;
}

/**
 * Opens one fresh, locked-down page, hands its DevTools session (and the browser's Chrome major
 * version) to `work`, and closes the page whatever happens: what a host - the desktop app's hidden
 * window - lends the render.
 */
export type SeoPageHost = <T>(
	work: (channel: SeoCdpChannel, chromeMajor: string) => Promise<T>
) => Promise<T>;

/** What one render reaches outside the page. */
export interface SeoRenderCoreDeps {
	/** The guarded transport every request of the page goes through. */
	fetch: SeoCrawlFetcher;
	/** The scripts and styles kept between renders. */
	cache: SeoRenderCache;
	/** The rendering browser's Chrome major version, for the User-Agent. */
	chromeMajor: string;
	/** A millisecond clock. */
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	/** How long the page may run before it is read as it stands, in ms (default: the crawler config). */
	timeoutMs?: number;
}

/** The JPEG quality of a single page analysis's screenshot. */
const SCREENSHOT_QUALITY = 60;

/** The longest a screenshot may take, in ms. */
const SCREENSHOT_MS = 5_000;

/** The largest screenshot kept, in base64 characters (about 1.5 MB). */
const SCREENSHOT_MAX_CHARS = 2_000_000;

/** The isolated world the members' custom JavaScript snippets run in, apart from the probe's. */
export const SEO_SNIPPET_WORLD = "__seo_snippets";

/** The characters of a snippet's value kept. */
const SEO_SNIPPET_VALUE_CHARS = SEO_CRAWL_OPTION_LIMITS.scriptValueChars;

/**
 * The expression one custom snippet is evaluated as: its code as the body of an async function, its
 * value turned to text inside the page (a string as it is, anything else as JSON) and cut short, so
 * only a short string ever leaves the page.
 *
 * @param code - The snippet's code.
 * @returns The expression.
 */
function seoSnippetExpression(code: string): string {
	return `(async () => {
const value = await (async () => {
${code}
})();
if (value === undefined || value === null) return null;
const text = typeof value === "string" ? value : JSON.stringify(value);
return typeof text === "string" ? text.slice(0, ${String(SEO_SNIPPET_VALUE_CHARS)}) : null;
})()`;
}

/** The longest one scroll round of the infinite-scroll test waits for content, in ms. */
const SCROLL_WAIT_MS = 1_000;

/** The axe-core source, loaded once on first use; null when it cannot be loaded. */
let axeSourceLoad: Promise<string | null> | null = null;

/**
 * The axe-core source, injected into a page for the accessibility checks.
 *
 * @returns The source, or null when axe-core cannot be loaded.
 */
async function axeSource(): Promise<string | null> {
	axeSourceLoad ??= import("axe-core").then(
		(module) => module.default.source,
		() => null
	);
	return axeSourceLoad;
}

/**
 * The axe rules a render runs: the search-relevant subset, or every rule the audit files.
 *
 * @param mode - Which set.
 * @returns The axe rule ids.
 */
function seoAxeRuleIds(mode: "seo" | "all"): string[] {
	return Object.values(SEO_A11Y_RULES)
		.filter((rule) => mode === "all" || rule.seo)
		.map((rule) => rule.axe);
}

/** A DevTools call that did not answer in its time. */
const STALLED: unique symbol = Symbol("stalled");

/**
 * Runs in the page before any of its own scripts: no service worker, no popup, no WebRTC (none of them
 * can be paused, so none may run), and a clock of the DOM's last change, which tells the render when
 * the page has settled.
 */
const SEO_RENDER_INIT_SCRIPT = `(() => {
	try { delete Navigator.prototype.serviceWorker; } catch {}
	try { window.open = function () { return null; }; } catch {}
	for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "WebTransport"]) {
		try { delete window[name]; } catch {}
	}
	let last = performance.now();
	const mark = () => { last = performance.now(); };
	try {
		new MutationObserver(mark).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	} catch {}
	try {
		Object.defineProperty(window, "__siteSnapshotQuiet", { value: () => performance.now() - last });
	} catch {}
})();`;

/**
 * Serializes the rendered document, doctype included, cut to a length in the page; a document with
 * more elements than the bound is refused unread.
 *
 * @param maxChars - The most characters handed back.
 * @param maxElements - The most elements a document may hold.
 * @returns The expression.
 */
function serializeDom(maxChars: number, maxElements: number): string {
	return `(() => {
	if (document.getElementsByTagName("*").length > ${String(maxElements)}) return { tooLarge: true, html: "" };
	const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "";
	const html = doctype + (document.documentElement ? document.documentElement.outerHTML : "");
	return { tooLarge: false, html: html.length > ${String(maxChars)} ? html.slice(0, ${String(maxChars)}) : html };
})()`;
}

/** How long the DOM has been quiet, in ms, as the page's clock reads it. */
const DOM_QUIET = `typeof window.__siteSnapshotQuiet === "function" ? window.__siteSnapshotQuiet() : 0`;

/** Resource types never loaded: layout and text need none of them, and some cannot be paused. */
const SKIPPED_TYPES: ReadonlySet<string> = new Set([
	"Image",
	"Media",
	"Font",
	"TextTrack",
	"Prefetch",
	"EventSource",
	"WebSocket",
	"Manifest",
	"SignedExchange",
	"Ping",
	"CSPViolationReport",
	"FedCM"
]);

/** Resource types a content screenshot loads (through the guarded transport): it shows the page as a visitor sees it. */
const SHOT_TYPES: ReadonlySet<string> = new Set(["Image", "Font"]);

/**
 * What an image request is answered with: an SVG with no size of its own, so the image lays out at the
 * size its page gives it, and nothing is fetched or decoded. It has a photo's 16:9 shape: an image the
 * page sizes on one side only (an icon given a height) takes a width near its own, where a shapeless
 * one would take the browser's default 300 px and widen a phone page that is not wide.
 */
const IMAGE_PLACEHOLDER = bytesToBase64(
	new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"/>')
);

/** The browser's own icon request: never part of the page. */
const FAVICON = /^https?:\/\/[^/]+\/favicon\.ico(?:[?#]|$)/i;

/** The resource types a failure is recorded for: what a page's content can depend on. */
const CRITICAL_TYPES: ReadonlyMap<string, SeoPageRenderResourceFailure["type"]> = new Map([
	["Script", "script"],
	["Stylesheet", "stylesheet"],
	["XHR", "xhr"],
	["Fetch", "fetch"]
]);

/** Request headers a fetch forwards from the browser to any host; the rest stay behind. */
const FORWARDED_HEADERS: ReadonlySet<string> = new Set([
	"accept",
	"accept-language",
	"content-type",
	"referer",
	"origin",
	"x-requested-with",
	"range"
]);

/**
 * Request headers never forwarded, the page's own site included: the browser's credentials (its
 * cookies, a proxy's sign-in; the page's own token is {@link PAGE_SESSION_HEADERS}, the cookies its own
 * site sets go from the render's own jar, `./render-cookies`), what the transport sets itself (host,
 * length, encoding, connection), the browser's own fetch metadata, the User-Agent (the render sends its
 * own), and a method override (the page writes only by POST).
 */
const WITHHELD_HEADERS: ReadonlySet<string> = new Set([
	"cookie",
	"cookie2",
	"authorization",
	"host",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"content-length",
	"expect",
	"accept-encoding",
	"user-agent",
	"priority",
	"x-client-data",
	"x-http-method",
	"x-http-method-override",
	"x-method-override"
]);

/**
 * The language and time zone every render runs in, whatever the computer's own: a page that picks its
 * language or its dates in the browser renders the same on the server and on a member's computer. The
 * `Accept-Language` the browser adds for it is never sent (a crawler asks for no language).
 */
const RENDER_LOCALE = "en-US";
const RENDER_TIMEZONE = "UTC";

/** Header name prefixes never forwarded: the browser's fetch metadata and client hints, a proxy's. */
const WITHHELD_PREFIX = /^(?:sec-|proxy-)/;

/**
 * Whether a header the page sent is forwarded: the short list to any host; to the page's own site
 * ({@link sameSiteAsPage}) every header its scripts set but the withheld ones, as a browser sends them
 * (a storefront asks its own server for a fragment by a header, BigCommerce's `stencil-options`, and
 * the whole page it answers without one runs every script of the page again inside the page); the
 * page's token to its exact origin only.
 *
 * @param name - The header's name, lower case.
 * @param value - Its value.
 * @param ownSite - Whether the request goes to the page's own site.
 * @param ownOrigin - Whether it goes to the page's exact origin.
 * @param visitor - Whether the render shows the page to a market's visitor (its language is then sent).
 * @returns Whether it is forwarded.
 */
function forwardedHeader(
	name: string,
	value: string,
	ownSite: boolean,
	ownOrigin: boolean,
	visitor = false
): boolean {
	if (PAGE_SESSION_HEADERS.has(name)) return ownOrigin;
	if (name === "accept-language" && value === RENDER_LOCALE && !visitor) return false;
	if (FORWARDED_HEADERS.has(name)) return true;
	return ownSite && !WITHHELD_HEADERS.has(name) && !WITHHELD_PREFIX.test(name);
}

/**
 * Request headers the page's own scripts set during the render (a storefront's API token it fetched a
 * moment earlier): forwarded only to the page's exact origin ({@link sameOriginAsPage}: a storefront's
 * API proxy sits there, e.g. a PWA's `/mobify/proxy/api`), so a page whose data calls need the token
 * renders its content instead of an error view. Never to another host or scheme, a sibling subdomain
 * included, and so never after a redirect away from the origin (the browser asks again for each hop and
 * each is judged on its own URL); never kept in the shared cache, and never in what the render
 * answers. Never ours: the site's saved sign-in is added after, by name.
 */
const PAGE_SESSION_HEADERS: ReadonlySet<string> = new Set(["authorization"]);

/** Response headers never handed back: the body is already decoded and its length is the browser's to set. */
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive"
]);

/** A request open longer than this is a long poll: the page is not waiting on it to settle. */
const LONG_POLL_MS = 5_000;

/** With the network quiet this long, a DOM that keeps moving (a ticker, an animation) is settled. */
const NETWORK_ONLY_SETTLE_MS = 2_000;

/** How often the render checks whether the page has settled. */
const POLL_MS = 100;

/** Navigations away from the page a render follows before it refuses more. */
const MAX_NAVIGATIONS = 3;

/** The longest one check of the DOM's quiet clock may take, in ms. */
const DOM_CHECK_MS = 1_000;

/** Paused requests, as a multiple of the request cap, past which a page is flooding and is cut short. */
const FLOOD_FACTOR = 4;

/** Console and exception events read before the render stops listening to them. */
const RUNTIME_EVENTS_MAX = 200;

/** The methods a page may use to any public host: reads only. */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The method a CORS preflight asks permission for, or null when the request is no preflight: a
 * preflight is judged as the request it precedes, so the page never asks a host about a request the
 * render will refuse anyway (and the refused request never follows a preflight that was let through).
 *
 * @param request - The paused request.
 * @returns The method, upper case, or null.
 */
function preflightMethod(request: {
	method: string;
	headers: Record<string, string>;
}): string | null {
	if (request.method !== "OPTIONS") return null;
	for (const [name, value] of Object.entries(request.headers)) {
		if (name.toLowerCase() === "access-control-request-method") return value.trim().toUpperCase();
	}
	return null;
}

/** Characters of one console line kept, and lines kept. */
const CONSOLE_CHARS = 300;
const CONSOLE_LINES = 20;

/** Failed resources kept. */
const FAILURES_KEPT = 50;

/** What one paused request asks for. */
interface PausedRequest {
	requestId: string;
	url: string;
	method: string;
	headers: Record<string, string>;
	/**
	 * The request's body as the page sent it, byte for byte (`postDataEntries`): Chrome's `postData`
	 * text drops every byte that is not UTF-8, so a binary body (a gzipped analytics batch) sent from it
	 * reached the site corrupted. Null when Chrome handed no readable body (none, a large one left out,
	 * or a file upload).
	 */
	body: Uint8Array<ArrayBuffer> | null;
	/** Whether the request has a body (Chrome leaves a large one out of `postData`). */
	hasPostData: boolean;
	resourceType: string;
	frameId: string | null;
}

/** An answer the page is handed. */
interface FetchedAnswer {
	status: number;
	headers: [string, string][];
	body: Uint8Array;
	/**
	 * The bytes the server sent, for the page's transfer total: its compressed length when it said, an
	 * estimate (the body gzipped) when it compressed without saying, else the body's length.
	 */
	servedBytes: number;
}

/**
 * Whether an answer refuses a request for its asker's rate limit: a 429, or a 403 whose rate-limit
 * header says no request is left (GitHub's API answers so once an address asked 60 times in an hour).
 * The crawl's own address asked too often while it read the site page after page; a visitor's browser
 * is answered.
 *
 * @param answer - The answer.
 * @returns Whether it does.
 */
function rateLimitAnswer(answer: Pick<FetchedAnswer, "status" | "headers">): boolean {
	if (answer.status === 429) return true;
	if (answer.status !== 403) return false;
	return answer.headers.some(
		([name, value]) => /^(?:x-)?ratelimit-remaining$/i.test(name) && value.trim() === "0"
	);
}

/**
 * The size of a body gzipped: the bytes a server that compresses sends for it, near enough (brotli
 * sends a little less), so a compressed answer that names no length is not counted at its decoded
 * size.
 *
 * @param body - The decoded body.
 * @returns Its gzipped length.
 */
async function gzippedBytes(body: Uint8Array): Promise<number> {
	const reader = new Blob([body.slice()])
		.stream()
		.pipeThrough(new CompressionStream("gzip"))
		.getReader();
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return size;
		size += value.byteLength;
	}
}

/**
 * A plain object, or null.
 *
 * @param value - Anything.
 * @returns The object, or null.
 */
function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * A string field, or a fallback.
 *
 * @param object - The object.
 * @param name - The field.
 * @param fallback - What a missing field reads as.
 * @returns The string.
 */
function stringField(object: Record<string, unknown> | null, name: string, fallback = ""): string {
	const value = object?.[name];
	return typeof value === "string" ? value : fallback;
}

/**
 * A request's body byte for byte: the `postDataEntries` Chrome sends (each part base64), else the
 * `postData` text when Chrome sent no parts. A part without bytes (a file the page uploads) leaves the
 * body unreadable.
 *
 * @param entries - The event's `postDataEntries`.
 * @param postData - The event's `postData`.
 * @returns The body, or null when there is none or it cannot be read.
 */
function postBodyOf(entries: unknown, postData: unknown): Uint8Array<ArrayBuffer> | null {
	if (!Array.isArray(entries) || entries.length === 0) {
		return typeof postData === "string" ? new TextEncoder().encode(postData) : null;
	}
	const parts: Uint8Array[] = [];
	for (const entry of entries) {
		const bytes = record(entry)?.bytes;
		if (typeof bytes !== "string") return null;
		const part = base64ToBytes(bytes);
		if (part === null) return null;
		parts.push(part);
	}
	const body = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		body.set(part, at);
		at += part.byteLength;
	}
	return body;
}

/**
 * The request a `Fetch.requestPaused` event names.
 *
 * @param params - The event's parameters.
 * @returns The request, or null when it is not one.
 */
function pausedRequestOf(params: unknown): PausedRequest | null {
	const event = record(params);
	const request = record(event?.request);
	const requestId = stringField(event, "requestId");
	const url = stringField(request, "url");
	if (requestId === "" || url === "") return null;
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(record(request?.headers) ?? {})) {
		if (typeof value === "string") headers[name.toLowerCase()] = value;
	}
	const body = postBodyOf(request?.postDataEntries, request?.postData);
	return {
		requestId,
		url,
		method: stringField(request, "method", "GET").toUpperCase(),
		headers,
		body,
		hasPostData: request?.hasPostData === true || body !== null,
		resourceType: stringField(event, "resourceType", "Other"),
		frameId: typeof event?.frameId === "string" ? event.frameId : null
	};
}

/**
 * A URL without its fragment, for comparing documents.
 *
 * @param url - The URL.
 * @returns It, its `#...` dropped.
 */
function withoutFragment(url: string): string {
	const at = url.indexOf("#");
	return at === -1 ? url : url.slice(0, at);
}

/**
 * Whether a URL's scheme is one the render fetches at all.
 *
 * @param url - The URL.
 * @returns Whether it is http or https.
 */
function webScheme(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/**
 * Whether a URL is on a page's own site: the page's host (a leading `www.` aside) or one below it.
 *
 * @param url - The URL asked for.
 * @param pageUrl - The page's URL.
 * @returns Whether it is the page's own site.
 */
export function sameSiteAsPage(url: string, pageUrl: string): boolean {
	let pageHost: string;
	try {
		pageHost = new URL(pageUrl).hostname;
	} catch {
		return false;
	}
	const site = bareHost(pageHost);
	return site !== "" && onSiteOrBelow(url, site);
}

/**
 * Whether a URL is on a page's exact origin: the same scheme, host and port.
 *
 * @param url - The URL asked for.
 * @param pageUrl - The page's URL.
 * @returns Whether it is.
 */
function sameOriginAsPage(url: string, pageUrl: string): boolean {
	try {
		const origin = new URL(url).origin;
		return origin !== "null" && origin === new URL(pageUrl).origin;
	} catch {
		return false;
	}
}

/** The bytes a render may still read, shared by every request of the page. */
interface ByteBudget {
	remaining: number;
}

/**
 * Reads a response body up to a bound, drawing on the page's byte budget as it reads.
 *
 * @param response - The response.
 * @param maxBytes - The most bytes read for this body.
 * @param budget - The page's budget, spent chunk by chunk.
 * @returns The body, or null when it is larger than the bound or the budget ran out.
 */
async function boundedBody(
	response: Response,
	maxBytes: number,
	budget: ByteBudget
): Promise<Uint8Array | null> {
	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		budget.remaining -= value.byteLength;
		if (total > maxBytes || budget.remaining < 0) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		parts.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.byteLength;
	}
	return body;
}

/** One kept script or style. */
interface CachedAnswer extends FetchedAnswer {
	storedAt: number;
}

/**
 * THE SCRIPTS AND STYLES KEPT BETWEEN RENDERS: most pages of a site load the same bundles, so they are
 * fetched once per crawl window rather than once per page. Only the same-for-everyone answers are
 * kept: a public, cacheable 200 to a GET of a script or style that carried no credential (no sign-in
 * header, no token the page set, no cookie its site set), that sets no cookie and varies by nothing
 * but its encoding. Each answer is kept under the page's site, the render's browser and the request's
 * `Origin` beside its URL ({@link renderCacheKey}), so one site's renders never hand another site
 * (another project, another account) a script fetched for them. Bounded in bytes and age, the least
 * recently used dropped first.
 */
export class SeoRenderCache {
	private readonly entries = new Map<string, CachedAnswer>();
	private bytes = 0;

	/**
	 * @param maxBytes - The most bytes kept.
	 * @param maxAgeMs - How long an answer is kept.
	 * @param now - The clock.
	 */
	constructor(
		private readonly maxBytes = 64 * 1024 * 1024,
		private readonly maxAgeMs = 10 * 60 * 1000,
		private readonly now: () => number = () => Date.now()
	) {}

	/**
	 * A kept answer.
	 *
	 * @param key - Its key (`renderCacheKey`).
	 * @returns The answer, or null.
	 */
	get(key: string): FetchedAnswer | null {
		const entry = this.entries.get(key);
		if (entry === undefined) return null;
		if (this.now() - entry.storedAt > this.maxAgeMs) {
			this.drop(key);
			return null;
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry;
	}

	/**
	 * Keeps an answer when it fits.
	 *
	 * @param key - Its key (`renderCacheKey`).
	 * @param answer - The answer.
	 */
	put(key: string, answer: FetchedAnswer): void {
		if (answer.body.byteLength > this.maxBytes / 8) return;
		this.drop(key);
		const headers = answer.headers.filter(([name]) => name !== "set-cookie");
		this.entries.set(key, { ...answer, headers, storedAt: this.now() });
		this.bytes += answer.body.byteLength;
		while (this.bytes > this.maxBytes) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) break;
			this.drop(oldest.value);
		}
	}

	/**
	 * Forgets one answer.
	 *
	 * @param key - Its key.
	 */
	private drop(key: string): void {
		const entry = this.entries.get(key);
		if (entry === undefined) return;
		this.bytes -= entry.body.byteLength;
		this.entries.delete(key);
	}
}

/**
 * Whether an answer may be kept for other pages.
 *
 * @param request - What was asked.
 * @param answer - What answered.
 * @returns Whether it is a public, cacheable script or style.
 */
function cacheable(request: PausedRequest, answer: FetchedAnswer): boolean {
	if (request.method !== "GET" || answer.status !== 200) return false;
	if (request.resourceType !== "Script" && request.resourceType !== "Stylesheet") return false;
	const header = (name: string): string => answer.headers.find(([key]) => key === name)?.[1] ?? "";
	if (answer.headers.some(([key]) => key === "set-cookie")) return false;
	const vary = header("vary")
		.split(",")
		.map((token) => token.trim().toLowerCase())
		.filter((token) => token !== "");
	return (
		!/no-store|private/i.test(header("cache-control")) &&
		vary.every((token) => token === "accept-encoding")
	);
}

/**
 * The key a shared answer is kept under: the page's site, the render's browser and the request's
 * `Origin` beside the URL, so an answer is handed only to a request that would have got the same one.
 *
 * @param pageUrl - The page rendered.
 * @param userAgent - The render's User-Agent.
 * @param request - The request.
 * @returns The key.
 */
function renderCacheKey(pageUrl: string, userAgent: string, request: PausedRequest): string {
	let site = "";
	try {
		site = bareHost(new URL(pageUrl).hostname);
	} catch {
		site = pageUrl;
	}
	return [site, userAgent, request.headers.origin ?? "", request.url].join("\u0000");
}

/**
 * A console line as kept: the first line, cut short.
 *
 * @param text - The message.
 * @returns The line, or null when empty.
 */
function consoleLine(text: string): string | null {
	const line = (text.split("\n")[0] ?? "").trim();
	return line === "" ? null : line.slice(0, CONSOLE_CHARS);
}

/**
 * An object's preview as a browser's console prints it: `{code: 500, message: 'Not found'}`, a class
 * instance under its name (`CustomEvent {isTrusted: false, …}`), an array as `[1, 'two']`.
 *
 * @param preview - The `ObjectPreview` DevTools sent with the argument.
 * @returns The text, or null when there is no preview.
 */
function previewText(preview: Record<string, unknown> | null): string | null {
	if (preview === null || !Array.isArray(preview.properties)) return null;
	const array = preview.subtype === "array";
	const parts = preview.properties.map((entry) => {
		const property = record(entry);
		const value = stringField(property, "value", stringField(property, "type"));
		const shown = stringField(property, "type") === "string" ? `'${value}'` : value;
		return array ? shown : `${stringField(property, "name")}: ${shown}`;
	});
	if (preview.overflow === true) parts.push("…");
	if (array) return `[${parts.join(", ")}]`;
	const name = stringField(preview, "description");
	const body = `{${parts.join(", ")}}`;
	return name === "" || name === "Object" ? body : `${name} ${body}`;
}

/**
 * One console argument as a browser's console prints it: a string as it is, a value as its literal,
 * an error as its message, an object through its preview (never only its type, `Object`).
 *
 * @param arg - The `RemoteObject` DevTools sent.
 * @returns The text.
 */
function consoleArgText(arg: unknown): string {
	const value = record(arg);
	if (value === null) return "";
	const type = stringField(value, "type");
	if (typeof value.value === "string") return value.value;
	if (type === "undefined") return "undefined";
	if (value.subtype === "null") return "null";
	if (typeof value.value === "number" || typeof value.value === "boolean")
		return String(value.value);
	const description = stringField(value, "description", stringField(value, "unserializableValue"));
	if (type !== "object" || value.subtype === "error")
		return (description.split("\n")[0] ?? "").trim();
	return previewText(record(value.preview)) ?? description;
}

/** A console format directive: `%s`, `%d`, `%i`, `%f`, `%o`, `%O`, `%c`, or `%%`. */
const CONSOLE_DIRECTIVE = /%[sdifoOc%]/g;

/**
 * The text of a `Runtime.consoleAPICalled` error, as a browser's console prints it: a first string's
 * format directives filled from the arguments after it (a `%c` style dropped), the rest joined by
 * spaces.
 *
 * @param params - The event.
 * @returns The message, or null when it is not an error.
 */
function consoleErrorOf(params: unknown): string | null {
	const event = record(params);
	if (stringField(event, "type") !== "error") return null;
	const args: unknown[] = Array.isArray(event?.args) ? event.args : [];
	const rest = args.slice(1);
	const first = record(args[0]);
	let head = consoleArgText(args[0]);
	if (typeof first?.value === "string") {
		head = head.replace(CONSOLE_DIRECTIVE, (directive) => {
			if (directive === "%%") return "%";
			if (rest.length === 0) return directive;
			const next = rest.shift();
			return directive === "%c" ? "" : consoleArgText(next);
		});
	}
	const text = [head, ...rest.map(consoleArgText)].filter((part) => part !== "").join(" ");
	return consoleLine(text);
}

/**
 * The text of a `Runtime.exceptionThrown` event: an error's message, a thrown object (a rejected
 * promise's `Event`) through its preview.
 *
 * @param params - The event.
 * @returns The message, or null.
 */
function exceptionOf(params: unknown): string | null {
	const details = record(record(params)?.exceptionDetails);
	const exception = record(details?.exception);
	const thrown =
		exception?.type === "object" && exception.subtype !== "error"
			? previewText(record(exception.preview))
			: null;
	const description = thrown ?? stringField(exception, "description");
	return consoleLine(description !== "" ? description : stringField(details, "text"));
}

/**
 * A failed render, for a page no browser took.
 *
 * @param request - The page.
 * @param error - Why.
 * @returns The outcome.
 */
export function failedRender(request: SeoRenderRequest, error: string): SeoBrowserRender {
	return {
		outcome: "failed",
		error,
		html: null,
		finalUrl: request.url,
		renderMs: 0,
		consoleErrors: [],
		failedResources: [],
		blockedRequests: 0,
		rateLimitedRequests: 0,
		dom: null,
		a11y: null
	};
}

/**
 * A renderer over a host's pages: each render on a fresh page the host opens, its requests through
 * `fetch`, scripts and styles kept between pages.
 *
 * @param host - Opens and closes the pages.
 * @param fetch - The guarded transport.
 * @returns The renderer; a page the host cannot open is a failed render.
 */
export function hostedRenderer(host: SeoPageHost, fetch: SeoCrawlFetcher): SeoPageRenderer {
	const cache = new SeoRenderCache();
	return async (request) => {
		try {
			return await host((channel, chromeMajor) =>
				renderThroughCdp(channel, request, {
					fetch,
					cache,
					chromeMajor,
					now: () => Date.now(),
					sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
				})
			);
		} catch {
			return failedRender(request, "browser");
		}
	};
}

/**
 * RENDERS ONE PAGE through a DevTools session on a fresh, blank page: the raw HTML handed in is the
 * document (with `fetchDocument`, the browser asks for it through the guard like any other request),
 * every other request goes through the guard, and the DOM is read once the page settles or
 * its time runs out. Never throws, and never outlasts its hard deadline (the time limit plus the
 * grace): a DevTools call that does not answer by then makes it a `hung` render.
 *
 * @param channel - The DevTools session on the page.
 * @param request - The page and its raw HTML.
 * @param deps - The guarded transport, the cache and the clock.
 * @returns What the browser rendered.
 */
export async function renderThroughCdp(
	channel: SeoCdpChannel,
	request: SeoRenderRequest,
	deps: SeoRenderCoreDeps
): Promise<SeoBrowserRender> {
	const config = seoCrawlerLimits;
	const started = deps.now();
	const deadline = started + (deps.timeoutMs ?? config.renderTimeoutMs);
	const hardDeadline = deadline + config.renderGraceMs;
	const device = request.device ?? "mobile";
	const probing = request.probe !== false && (device === "mobile" || request.probe === true);
	const userAgent =
		device === "desktop"
			? seoDesktopRenderUserAgent(request.userAgent, deps.chromeMajor)
			: seoRenderUserAgent(request.userAgent, deps.chromeMajor);
	const consoleErrors: string[] = [];
	const failures: SeoPageRenderResourceFailure[] = [];
	const inflight = new Map<string, number>();
	const budget: ByteBudget = { remaining: config.renderMaxBytes };
	const siteCookies = new RenderCookieJar();
	const slotWaiters: (() => void)[] = [];
	let fetching = 0;
	let lastActivity = started;
	let loaded = false;
	let crashed = false;
	let ended = false;
	let mainFrameId: string | null = null;
	let documentServed = false;
	let documentStatus: number | null = null;
	let navigations = 0;
	let requests = 0;
	/** The images and fonts a content screenshot loaded: their own budget, so they never starve the page's scripts. */
	let shotAssets = 0;
	let paused = 0;
	let runtimeEvents = 0;
	let blocked = 0;
	let rateLimited = 0;
	let sameDocumentNavigations = 0;
	let finalUrl = request.url;
	let loading = true;
	let transferBytes = 0;
	let transferRequests = 0;
	let documentBytes: Promise<void> = Promise.resolve();
	const requestedImages = new Set<string>();
	const requestedFonts = new Set<string>();
	let dom: SeoPageDomFacts | null = null;
	let a11y: SeoPageA11yFacts | null = null;
	let screenshot: string | null = null;
	let scripts: SeoPageScriptResult[] | null = null;
	let shotCaptured: SeoRenderCaptureResult | null = null;

	const result = (
		outcome: SeoBrowserRender["outcome"],
		error: string | null,
		html: string | null
	): SeoBrowserRender => ({
		outcome,
		error,
		html,
		finalUrl,
		renderMs: Math.max(0, Math.round(deps.now() - started)),
		consoleErrors: consoleErrors.slice(0, CONSOLE_LINES),
		failedResources: failures.slice(0, FAILURES_KEPT),
		blockedRequests: blocked,
		rateLimitedRequests: rateLimited,
		dom,
		a11y,
		...(request.screenshot === true ? { screenshot } : {}),
		...(scripts === null ? {} : { scripts }),
		...(request.capture === undefined ? {} : { capture: shotCaptured }),
		...(request.fetchDocument === true ? { documentStatus } : {})
	});

	if (!webScheme(request.url)) return result("failed", "url", null);

	/**
	 * A promise, or {@link STALLED} when it has not settled in `ms`.
	 *
	 * @param promise - The promise.
	 * @param ms - The longest wait.
	 * @returns Its value, or STALLED.
	 */
	const within = async <T>(promise: Promise<T>, ms: number): Promise<T | typeof STALLED> =>
		Promise.race([promise, deps.sleep(Math.max(0, ms)).then((): typeof STALLED => STALLED)]);
	const send = async (method: string, params?: Record<string, unknown>): Promise<unknown> =>
		channel.send(method, params);
	const quietly = (method: string, params?: Record<string, unknown>): void => {
		void channel.send(method, params).catch(() => undefined);
	};
	const end = (): void => {
		ended = true;
		for (const wake of slotWaiters.splice(0)) wake();
	};
	const fail = (requestId: string, errorReason: string): void => {
		quietly("Fetch.failRequest", { requestId, errorReason });
	};
	const fulfill = (requestId: string, answer: FetchedAnswer): void => {
		if (loading) {
			transferBytes += answer.servedBytes;
			transferRequests += 1;
		}
		void channel
			.send("Fetch.fulfillRequest", {
				requestId,
				responseCode: answer.status,
				responseHeaders: answer.headers.map(([name, value]) => ({ name, value })),
				body: bytesToBase64(answer.body)
			})
			.catch(() => {
				fail(requestId, "Failed");
			});
	};
	const recordFailure = (
		pausedRequest: PausedRequest,
		reason: SeoPageRenderResourceFailure["reason"],
		status: number | null
	): void => {
		const type = CRITICAL_TYPES.get(pausedRequest.resourceType);
		if (type === undefined || failures.length >= FAILURES_KEPT) return;
		failures.push({ url: pausedRequest.url.slice(0, 2_000), type, reason, status });
	};

	/**
	 * Whether the page may send this request at all: reads to any host, a small POST to its own site,
	 * nothing else.
	 *
	 * @param pausedRequest - The request.
	 * @returns Whether it may go out.
	 */
	const methodAllowed = (pausedRequest: PausedRequest): boolean => {
		const preflightFor = preflightMethod(pausedRequest);
		if (preflightFor !== null) {
			return (
				!pausedRequest.hasPostData &&
				(READ_METHODS.has(preflightFor) ||
					(preflightFor === "POST" && sameSiteAsPage(pausedRequest.url, request.url)))
			);
		}
		if (READ_METHODS.has(pausedRequest.method)) return !pausedRequest.hasPostData;
		if (pausedRequest.method !== "POST") return false;
		if (!sameSiteAsPage(pausedRequest.url, request.url)) return false;
		if (!pausedRequest.hasPostData) return true;
		if (pausedRequest.body === null) return false;
		return pausedRequest.body.byteLength <= config.renderMaxPostBytes;
	};

	/**
	 * Waits for one of the page's fetch slots.
	 *
	 * @returns Whether a slot was taken (false once the render is over).
	 */
	const takeSlot = async (): Promise<boolean> => {
		while (fetching >= config.renderMaxInflight) {
			if (ended) return false;
			await new Promise<void>((resolve) => slotWaiters.push(resolve));
		}
		if (ended) return false;
		fetching += 1;
		return true;
	};
	const releaseSlot = (): void => {
		fetching -= 1;
		slotWaiters.shift()?.();
	};

	/**
	 * The site's sign-in headers for a request: the members' headers on the project's own hosts, none
	 * elsewhere. A request that carries them is never answered from, nor kept in, the shared cache.
	 *
	 * @param url - The request's URL.
	 * @returns The headers, or null.
	 */
	const signedIn = (url: string): Record<string, string> | null =>
		request.siteHeaders?.(url) ?? null;

	/**
	 * Fetches what the page asked for through the guard.
	 *
	 * @param pausedRequest - The request.
	 * @param sent - Set to whether the request went out plain: only the short list of headers any host
	 *   gets, no sign-in header, token or cookie; only such an answer may be shared
	 *   ({@link SeoRenderCache}).
	 * @returns The answer, or why there is none: `cut` when the render's own end or deadline stopped
	 *   the fetch (the site did not fail), `too_large` past the render's byte budget.
	 */
	const fetchThrough = async (
		pausedRequest: PausedRequest,
		sent: { plain: boolean }
	): Promise<FetchedAnswer | "blocked" | "network" | "too_large" | "cut"> => {
		if (budget.remaining <= 0) return "too_large";
		if (request.paceResource !== undefined) await request.paceResource(pausedRequest.url);
		if (ended) return "cut";
		const headers = new Headers();
		const ownSite = sameSiteAsPage(pausedRequest.url, request.url);
		const ownOrigin = sameOriginAsPage(pausedRequest.url, request.url);
		for (const [name, value] of Object.entries(pausedRequest.headers)) {
			if (forwardedHeader(name, value, ownSite, ownOrigin, request.capture?.visitor !== undefined))
				headers.set(name, value);
		}
		for (const [name, value] of Object.entries(signedIn(pausedRequest.url) ?? {})) {
			headers.set(name, value);
		}
		const cookie = ownSite ? siteCookies.header(pausedRequest.url) : null;
		if (cookie !== null) {
			const signedInCookie = headers.get("cookie");
			headers.set("cookie", signedInCookie === null ? cookie : `${signedInCookie}; ${cookie}`);
		}
		headers.set("user-agent", userAgent);
		sent.plain = [...headers.keys()].every(
			(name) => name === "user-agent" || FORWARDED_HEADERS.has(name)
		);
		const timeout = Math.max(500, Math.min(config.renderResourceTimeoutMs, deadline - deps.now()));
		let response: Response;
		try {
			response = await deps.fetch(
				pausedRequest.url,
				{
					method: pausedRequest.method,
					headers,
					redirect: "manual",
					credentials: "omit",
					...(pausedRequest.body !== null && pausedRequest.method === "POST"
						? { body: pausedRequest.body }
						: {})
				},
				timeout
			);
		} catch (error) {
			if (error instanceof Error && error.name === "BlockedUrlError") return "blocked";
			return ended || timeout < config.renderResourceTimeoutMs ? "cut" : "network";
		}
		if (ownSite) siteCookies.store(pausedRequest.url, response.headers.getSetCookie(), deps.now());
		let body: Uint8Array | null;
		try {
			body = await boundedBody(response, config.renderMaxResourceBytes, budget);
		} catch {
			return ended || timeout < config.renderResourceTimeoutMs ? "cut" : "network";
		}
		if (body === null) return "too_large";
		const encoded = response.headers.get("content-encoding") !== null;
		const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
		const servedBytes = !encoded
			? body.byteLength
			: Number.isSafeInteger(length) && length >= 0
				? length
				: await gzippedBytes(body);
		const kept: [string, string][] = [];
		response.headers.forEach((value, name) => {
			const lower = name.toLowerCase();
			if (DROPPED_RESPONSE_HEADERS.has(lower)) return;
			if (lower === "location") {
				try {
					kept.push([lower, new URL(value, pausedRequest.url).href]);
				} catch {
					return;
				}
				return;
			}
			kept.push([lower, value]);
		});
		return { status: response.status, headers: kept, body, servedBytes };
	};

	/**
	 * Answers one paused request: the page's own document from the raw HTML, a skipped type or a
	 * refused URL or method failed at once, anything else fetched through the guard.
	 *
	 * @param pausedRequest - The request.
	 */
	const answer = async (pausedRequest: PausedRequest): Promise<void> => {
		if (ended) {
			fail(pausedRequest.requestId, "Aborted");
			return;
		}
		const isDocument = pausedRequest.resourceType === "Document";
		const mainFrame = isDocument && (mainFrameId === null || pausedRequest.frameId === mainFrameId);
		if (
			request.fetchDocument !== true &&
			mainFrame &&
			!documentServed &&
			pausedRequest.method === "GET" &&
			withoutFragment(pausedRequest.url) === withoutFragment(request.url)
		) {
			documentServed = true;
			const headers: [string, string][] = [["content-type", "text/html; charset=utf-8"]];
			if (request.contentSecurityPolicy !== null)
				headers.push(["content-security-policy", request.contentSecurityPolicy]);
			const body = new TextEncoder().encode(request.html);
			const counted = loading;
			fulfill(pausedRequest.requestId, { status: request.status, headers, body, servedBytes: 0 });
			documentBytes = gzippedBytes(body).then(
				(bytes) => {
					if (counted) transferBytes += bytes;
				},
				() => undefined
			);
			return;
		}
		if (loading && webScheme(pausedRequest.url)) {
			const kept = withoutFragment(pausedRequest.url).slice(0, SEO_DOM_LIMITS.urlChars);
			if (
				pausedRequest.resourceType === "Image" &&
				requestedImages.size < SEO_DOM_LIMITS.transferImages
			)
				requestedImages.add(kept);
			if (
				pausedRequest.resourceType === "Font" &&
				requestedFonts.size < SEO_DOM_LIMITS.transferFonts
			)
				requestedFonts.add(kept);
		}
		if (
			request.capture === undefined &&
			pausedRequest.resourceType === "Image" &&
			webScheme(pausedRequest.url) &&
			!FAVICON.test(pausedRequest.url)
		) {
			quietly("Fetch.fulfillRequest", {
				requestId: pausedRequest.requestId,
				responseCode: 200,
				responseHeaders: [{ name: "content-type", value: "image/svg+xml" }],
				body: IMAGE_PLACEHOLDER
			});
			return;
		}
		if (
			(SKIPPED_TYPES.has(pausedRequest.resourceType) &&
				!(request.capture !== undefined && SHOT_TYPES.has(pausedRequest.resourceType))) ||
			(isDocument && !mainFrame) ||
			FAVICON.test(pausedRequest.url)
		) {
			fail(pausedRequest.requestId, "BlockedByClient");
			return;
		}
		if (!webScheme(pausedRequest.url) || !methodAllowed(pausedRequest)) {
			blocked += 1;
			fail(pausedRequest.requestId, "AccessDenied");
			return;
		}
		const shotAsset = request.capture !== undefined && SHOT_TYPES.has(pausedRequest.resourceType);
		if (shotAsset) shotAssets += 1;
		else requests += 1;
		if (
			(shotAsset ? shotAssets : requests) > config.renderMaxRequests ||
			(mainFrame && navigations >= MAX_NAVIGATIONS)
		) {
			fail(pausedRequest.requestId, "BlockedByClient");
			return;
		}
		if (mainFrame) navigations += 1;
		if (request.allowResource !== null && !request.allowResource(pausedRequest.url)) {
			recordFailure(pausedRequest, "robots", null);
			fail(pausedRequest.requestId, "BlockedByClient");
			return;
		}
		const shared =
			signedIn(pausedRequest.url) === null &&
			!(
				sameSiteAsPage(pausedRequest.url, request.url) &&
				siteCookies.header(pausedRequest.url) !== null
			) &&
			!Object.keys(pausedRequest.headers).some((name) => PAGE_SESSION_HEADERS.has(name));
		const cacheKey = renderCacheKey(request.url, userAgent, pausedRequest);
		const cached = pausedRequest.method === "GET" && shared ? deps.cache.get(cacheKey) : null;
		if (cached !== null) {
			fulfill(pausedRequest.requestId, cached);
			return;
		}
		inflight.set(pausedRequest.requestId, deps.now());
		lastActivity = deps.now();
		try {
			if (!(await takeSlot())) {
				fail(pausedRequest.requestId, "Aborted");
				return;
			}
			let fetched: Awaited<ReturnType<typeof fetchThrough>>;
			const sent = { plain: false };
			try {
				fetched = await fetchThrough(pausedRequest, sent);
			} finally {
				releaseSlot();
			}
			if (fetched === "blocked") {
				blocked += 1;
				fail(pausedRequest.requestId, "AccessDenied");
				return;
			}
			if (fetched === "cut" || fetched === "too_large") {
				fail(pausedRequest.requestId, "Failed");
				return;
			}
			if (fetched === "network") {
				recordFailure(pausedRequest, "network", null);
				fail(pausedRequest.requestId, "Failed");
				return;
			}
			if (fetched.status >= 400) recordFailure(pausedRequest, "status", fetched.status);
			if (mainFrame) documentStatus = fetched.status;
			if (rateLimitAnswer(fetched)) rateLimited += 1;
			if (shared && sent.plain && cacheable(pausedRequest, fetched))
				deps.cache.put(cacheKey, fetched);
			if (ended) {
				fail(pausedRequest.requestId, "Aborted");
				return;
			}
			fulfill(pausedRequest.requestId, fetched);
		} finally {
			inflight.delete(pausedRequest.requestId);
			lastActivity = deps.now();
		}
	};

	/**
	 * Counts one console or exception event; past the bound the render stops listening to them, so a
	 * page that logs without end cannot flood the DevTools session.
	 *
	 * @returns Whether the event is still read.
	 */
	const runtimeEvent = (): boolean => {
		runtimeEvents += 1;
		if (runtimeEvents === RUNTIME_EVENTS_MAX) quietly("Runtime.disable");
		return runtimeEvents <= RUNTIME_EVENTS_MAX;
	};

	/**
	 * Evaluates an expression in the probe's world, bounded in time: a page that keeps the main thread
	 * busy past the bound has its script execution cut and the answer is null.
	 *
	 * @param contextId - The probe world's execution context.
	 * @param expression - The expression.
	 * @param ms - The longest wait.
	 * @param awaitPromise - Whether the expression answers a promise to wait for.
	 * @returns The value, or null.
	 */
	const evaluateIn = async (
		contextId: number,
		expression: string,
		ms: number,
		awaitPromise: boolean
	): Promise<unknown> => {
		const evaluated = send("Runtime.evaluate", {
			expression,
			contextId,
			returnByValue: true,
			awaitPromise
		}).catch(() => null);
		const answered = await within(evaluated, ms);
		if (answered === STALLED) {
			quietly("Runtime.terminateExecution");
			return null;
		}
		const outcome = record(answered);
		if (outcome === null || outcome.exceptionDetails !== undefined) return null;
		return record(outcome.result)?.value ?? null;
	};

	/**
	 * The probe's isolated world on the page's main frame.
	 *
	 * @returns Its execution context id, or null when it cannot be had.
	 */
	const probeWorld = async (): Promise<number | null> => {
		if (mainFrameId === null) return null;
		const created = await within(
			send("Page.createIsolatedWorld", {
				frameId: mainFrameId,
				worldName: SEO_PROBE_WORLD,
				grantUniveralAccess: false
			}).catch(() => null),
			DOM_CHECK_MS
		);
		const id = created === STALLED ? null : record(created)?.executionContextId;
		return typeof id === "number" ? id : null;
	};

	/**
	 * Whether a history entry the page added on load repeats the entry before it: the same URL pushed
	 * again, so the Back button lands on the page itself.
	 *
	 * @param pushed - Entries the page added.
	 * @returns Whether one repeats.
	 */
	const historyRepeats = async (pushed: number): Promise<boolean> => {
		if (pushed <= 0) return false;
		const answered = await within(
			send("Page.getNavigationHistory").catch(() => null),
			DOM_CHECK_MS
		);
		const history = answered === STALLED ? null : record(answered);
		const entries: unknown[] = Array.isArray(history?.entries) ? history.entries : [];
		const current = typeof history?.currentIndex === "number" ? history.currentIndex : -1;
		const urls = entries
			.slice(Math.max(0, current - pushed), current + 1)
			.map((entry) => stringField(record(entry), "url"));
		return urls.some((url, at) => at > 0 && url !== "" && url === urls[at - 1]);
	};

	/**
	 * Runs the in-page probe and adds what the render measured itself (the transfer and the history).
	 * The history entries the page added count no more than its own document's same-page navigations
	 * (`pushState`, a fragment): an embed whose frame the render refused and the page then pointed
	 * elsewhere adds an entry too, and that is no Back button the page took.
	 *
	 * @param contextId - The probe world's execution context.
	 * @param scroll - Whether to test for infinite scroll (only on a page whose DOM went quiet).
	 * @returns The facts, or null when the probe could not run in its time.
	 */
	const probe = async (contextId: number, scroll: boolean): Promise<SeoPageDomFacts | null> => {
		const value = await evaluateIn(
			contextId,
			seoProbeExpression({
				scroll,
				scrollWaitMs: SCROLL_WAIT_MS,
				budgetMs: config.renderProbeMs - DOM_CHECK_MS
			}),
			config.renderProbeMs,
			true
		);
		const parsed = seoDomFactsSchema.safeParse(value);
		if (!parsed.success) return null;
		const facts = parsed.data;
		const pushed = Math.min(facts.history.pushed, sameDocumentNavigations);
		await documentBytes;
		return {
			...facts,
			history: { pushed, repeated: await historyRepeats(pushed) },
			transfer: {
				bytes: transferBytes,
				requests: transferRequests,
				images: [...requestedImages],
				fonts: [...requestedFonts]
			}
		};
	};

	/**
	 * Runs the members' custom snippets in an isolated world of their own, one after the other, all of
	 * them within `renderScriptsMs`, once the page was read and its network ended: every request a
	 * snippet makes is refused, so nothing it reads can leave the page but its own short value. A
	 * snippet that overruns has its script execution cut and is answered as `timeout`, one that throws
	 * as `error`.
	 *
	 * @param list - The snippets.
	 * @returns Each snippet's answer, or null when the world could not be had.
	 */
	const snippets = async (
		list: readonly SeoRenderScript[]
	): Promise<SeoPageScriptResult[] | null> => {
		if (mainFrameId === null) return null;
		const started = deps.now();
		const created = await within(
			send("Page.createIsolatedWorld", {
				frameId: mainFrameId,
				worldName: SEO_SNIPPET_WORLD,
				grantUniveralAccess: false
			}).catch(() => null),
			DOM_CHECK_MS
		);
		const contextId = created === STALLED ? null : record(created)?.executionContextId;
		if (typeof contextId !== "number") return null;
		const answers: SeoPageScriptResult[] = [];
		for (const snippet of list) {
			const left = config.renderScriptsMs - (deps.now() - started);
			if (left <= 0) {
				answers.push({ id: snippet.id, value: null, error: "timeout" });
				continue;
			}
			const evaluated = send("Runtime.evaluate", {
				expression: seoSnippetExpression(snippet.code),
				contextId,
				returnByValue: true,
				awaitPromise: true
			}).catch(() => null);
			const answered = await within(evaluated, left);
			if (answered === STALLED) {
				quietly("Runtime.terminateExecution");
				answers.push({ id: snippet.id, value: null, error: "timeout" });
				continue;
			}
			const outcome = record(answered);
			if (outcome === null || outcome.exceptionDetails !== undefined) {
				answers.push({ id: snippet.id, value: null, error: "error" });
				continue;
			}
			const value = record(outcome.result)?.value;
			answers.push({
				id: snippet.id,
				value: typeof value === "string" ? value.slice(0, SEO_SNIPPET_VALUE_CHARS) : null,
				error: null
			});
		}
		return answers;
	};

	/**
	 * Runs the accessibility checks (axe-core) in the probe's world.
	 *
	 * @param contextId - The probe world's execution context.
	 * @param mode - The search-relevant subset, or every rule.
	 * @returns The findings, or null when they could not run in their time.
	 */
	const accessibility = async (
		contextId: number,
		mode: "seo" | "all"
	): Promise<SeoPageA11yFacts | null> => {
		const started = deps.now();
		const source = await axeSource();
		if (source === null) return null;
		const loaded = await evaluateIn(
			contextId,
			`${source}\n;typeof axe === "object"`,
			config.renderAxeMs,
			false
		);
		if (loaded !== true) return null;
		const left = config.renderAxeMs - (deps.now() - started);
		if (left <= 0) return null;
		const violations = await evaluateIn(
			contextId,
			seoAxeExpression(seoAxeRuleIds(mode)),
			left,
			true
		);
		const parsed = seoA11yFactsSchema.safeParse({ rules: mode, violations });
		return parsed.success ? parsed.data : null;
	};

	channel.on("Fetch.requestPaused", (params) => {
		paused += 1;
		const pausedRequest = pausedRequestOf(params);
		if (pausedRequest !== null)
			void answer(pausedRequest).catch(() => fail(pausedRequest.requestId, "Failed"));
	});
	channel.on("Page.loadEventFired", () => {
		loaded = true;
		lastActivity = Math.max(lastActivity, deps.now());
	});
	channel.on("Page.frameNavigated", (params) => {
		const frame = record(record(params)?.frame);
		if (frame === null || typeof frame.parentId === "string") return;
		const url = stringField(frame, "url");
		if (url !== "" && url !== "about:blank") finalUrl = url;
	});
	channel.on("Page.navigatedWithinDocument", (params) => {
		const frameId = stringField(record(params), "frameId");
		if (mainFrameId === null || frameId === mainFrameId) sameDocumentNavigations += 1;
	});
	channel.on("Page.javascriptDialogOpening", () => {
		quietly("Page.handleJavaScriptDialog", { accept: false });
	});
	channel.on("Runtime.exceptionThrown", (params) => {
		if (ended || !runtimeEvent()) return;
		const line = exceptionOf(params);
		if (line !== null && consoleErrors.length < CONSOLE_LINES) consoleErrors.push(line);
	});
	channel.on("Runtime.consoleAPICalled", (params) => {
		if (ended || !runtimeEvent()) return;
		const line = consoleErrorOf(params);
		if (line !== null && consoleErrors.length < CONSOLE_LINES) consoleErrors.push(line);
	});
	channel.on("Inspector.targetCrashed", () => {
		crashed = true;
	});

	const setup = async (): Promise<void> => {
		await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
		await send("Page.enable");
		await send("Runtime.enable");
		await send("Page.addScriptToEvaluateOnNewDocument", { source: SEO_RENDER_INIT_SCRIPT });
		if (probing) {
			await send("Page.addScriptToEvaluateOnNewDocument", {
				source: SEO_PROBE_INIT_SCRIPT,
				worldName: SEO_PROBE_WORLD
			});
		}
		const mobile = device === "mobile";
		const viewport = mobile ? config.renderViewport : config.renderDesktopViewport;
		const visitor = request.capture?.visitor;
		await send("Emulation.setUserAgentOverride", {
			userAgent,
			acceptLanguage: visitor?.acceptLanguage ?? RENDER_LOCALE,
			platform: mobile ? "Linux armv8l" : "Linux x86_64"
		});
		quietly("Emulation.setLocaleOverride", { locale: visitor?.locale ?? RENDER_LOCALE });
		quietly("Emulation.setTimezoneOverride", { timezoneId: visitor?.timezone ?? RENDER_TIMEZONE });
		await send("Emulation.setDeviceMetricsOverride", {
			width: viewport.width,
			height: viewport.height,
			deviceScaleFactor: request.capture === undefined ? 1 : CAPTURE_SCALE,
			mobile
		});
		if (mobile) {
			await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		}
		quietly("Page.setDownloadBehavior", { behavior: "deny" });
		const tree = record(record(await send("Page.getFrameTree"))?.frameTree);
		mainFrameId = stringField(record(tree?.frame), "id") || null;
	};
	try {
		if ((await within(setup(), deadline - deps.now())) === STALLED) {
			end();
			return result("failed", "hung", null);
		}
	} catch {
		end();
		return result("failed", "browser", null);
	}

	const navigation = send("Page.navigate", { url: request.url }).then(
		(value) => stringField(record(value), "errorText"),
		() => "navigation"
	);
	const navigationError = await within(navigation, deadline - deps.now());
	if (navigationError !== STALLED && navigationError !== "") {
		end();
		return result("failed", "navigation", null);
	}

	let settled = false;
	let domSettled = false;
	let flooded = false;
	let domQuietMs = 0;
	let lastDomCheck = 0;
	for (;;) {
		if (crashed || deps.now() >= deadline) break;
		if (paused > config.renderMaxRequests * FLOOD_FACTOR) {
			flooded = true;
			break;
		}
		const now = deps.now();
		const waiting = [...inflight.values()].some((since) => now - since < LONG_POLL_MS);
		const networkQuiet = waiting ? 0 : now - lastActivity;
		if (loaded && networkQuiet >= config.renderQuietMs) {
			if (now - lastDomCheck >= POLL_MS * 2) {
				lastDomCheck = now;
				try {
					const checked = await within(
						send("Runtime.evaluate", { expression: DOM_QUIET, returnByValue: true }),
						Math.min(DOM_CHECK_MS, deadline - now)
					);
					const evaluated = checked === STALLED ? null : record(record(checked)?.result);
					domQuietMs = typeof evaluated?.value === "number" ? evaluated.value : 0;
				} catch {
					domQuietMs = 0;
				}
			}
			if (domQuietMs >= config.renderQuietMs || networkQuiet >= NETWORK_ONLY_SETTLE_MS) {
				settled = true;
				domSettled = domQuietMs >= config.renderQuietMs;
				break;
			}
		}
		await deps.sleep(POLL_MS);
	}
	const waitMs = Math.min(request.waitMs ?? 0, config.renderMaxWaitMs);
	if (!crashed && waitMs > 0)
		await deps.sleep(Math.max(0, Math.min(waitMs, deadline - deps.now())));
	loading = false;
	if (crashed) {
		end();
		return result("failed", "crashed", null);
	}
	if (request.capture !== undefined) {
		shotCaptured = await seoCaptureInPage(
			{ send, sleep: deps.sleep, now: deps.now },
			request.capture,
			hardDeadline + config.renderProbeMs + config.renderAxeMs,
			CAPTURE_SCALE
		).catch(() => null);
	}
	if (!probing) end();

	const capture = send("Runtime.evaluate", {
		expression: serializeDom(config.maxPageBytes, config.renderMaxElements),
		returnByValue: true
	}).catch(() => null);
	let captured = await within(capture, (hardDeadline - deps.now()) / 2);
	if (captured === STALLED) {
		quietly("Runtime.terminateExecution");
		captured = await within(capture, hardDeadline - deps.now());
	}
	if (captured === STALLED) {
		end();
		return result("failed", "hung", null);
	}
	const value = record(record(record(captured)?.result)?.value);
	const html = typeof value?.html === "string" ? value.html : null;
	if (value?.tooLarge === true || html === null || html === "") {
		end();
		return result("failed", value?.tooLarge === true ? "too_large" : "capture", null);
	}
	const capped = html.length > config.maxPageBytes ? html.slice(0, config.maxPageBytes) : html;
	if (request.screenshot === true) {
		const shot = await within(
			send("Page.captureScreenshot", {
				format: "jpeg",
				quality: SCREENSHOT_QUALITY,
				fromSurface: true
			}).catch(() => null),
			Math.min(SCREENSHOT_MS, hardDeadline - deps.now())
		);
		const data = shot === STALLED ? null : record(shot)?.data;
		screenshot =
			typeof data === "string" && data.length > 0 && data.length <= SCREENSHOT_MAX_CHARS
				? data
				: null;
	}
	if (probing) {
		const world = await probeWorld();
		if (world !== null) {
			dom = await probe(world, settled && domSettled && !flooded);
			end();
			if (dom !== null && request.accessibility != null) {
				a11y = await accessibility(world, request.accessibility);
			}
		}
		end();
	}
	if (request.scripts !== undefined && request.scripts.length > 0) {
		end();
		scripts = await snippets(request.scripts);
	}
	return result(settled ? "ok" : "timeout", flooded ? "requests" : null, capped);
}
