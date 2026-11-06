import { isInternalUrl, siteScope } from "./scope";
import type { SeoCrawlFetcher } from "./types";

/**
 * WHAT THE CRAWL SENDS A SITE THAT ASKS TO SIGN IN: the members' extra request headers, HTTP basic
 * auth and (on the desktop app) the cookies of a recorded login, as one set of headers - sent ONLY to
 * the project's own host and its `www.` twin, never to another site a page links to or loads from,
 * and checked again at every redirect hop, so a redirect off the site drops them.
 *
 * PURE: no database, no network; a desktop main process can run it.
 */

/** The headers a request to one URL carries for the site, or null when the URL is not on the site. */
export type SeoSiteHeaders = (url: string) => Record<string, string> | null;

/**
 * Header names a member may not set: the ones the crawler sets itself (its User-Agent says who it is)
 * and the ones the transport owns.
 */
export const SEO_RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
	"user-agent",
	"host",
	"content-length",
	"content-type",
	"connection",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"expect"
]);

/** A header name as HTTP allows it (a token). */
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]{1,100}$/;

/**
 * Whether a member may set a request header of this name.
 *
 * @param name - The name.
 * @returns Whether it is a valid header name the crawler does not set itself.
 */
export function allowedHeaderName(name: string): boolean {
	return HEADER_NAME.test(name) && !SEO_RESERVED_HEADER_NAMES.has(name.toLowerCase());
}

/**
 * Whether a header value is safe to send: no line break or other control character.
 *
 * @param value - The value.
 * @returns Whether it may be sent.
 */
export function allowedHeaderValue(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return false;
	}
	return true;
}

/**
 * The `Authorization` value of HTTP basic auth, the credentials UTF-8 encoded.
 *
 * @param username - The user name.
 * @param password - The password.
 * @returns `Basic <base64>`.
 */
export function basicAuthValue(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

/**
 * The site's request headers as a function of the URL: the headers for a URL on the site's own hosts,
 * nothing elsewhere, and over plain http only when the website itself is on plain http (a secret is
 * never sent in clear for a site that has https). Invalid names and values are left out.
 *
 * @param siteUrl - The project's website.
 * @param headers - The headers, by name.
 * @returns The function, or undefined when there is nothing to send.
 */
export function siteHeadersFor(
	siteUrl: string,
	headers: Readonly<Record<string, string>> | null | undefined
): SeoSiteHeaders | undefined {
	const scope = siteScope(siteUrl);
	if (scope === null || headers == null) return undefined;
	const kept: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (allowedHeaderName(name) && allowedHeaderValue(value)) kept[name] = value;
	}
	if (Object.keys(kept).length === 0) return undefined;
	const protocolOf = (url: string): string | null =>
		URL.canParse(url) ? new URL(url).protocol : null;
	const plainHttp = protocolOf(siteUrl) === "http:";
	return (url) =>
		isInternalUrl(scope, url) && (plainHttp || protocolOf(url) === "https:") ? { ...kept } : null;
}

/**
 * A transport that adds the site's headers to every request it makes to the site's own hosts. The
 * crawler's own headers stay as they are unless a member's header replaces one of them (an `Accept-Language`).
 *
 * @param fetch - The guarded transport.
 * @param siteHeaders - The site's headers, or undefined for none.
 * @returns The transport (the same one when there is nothing to add).
 */
export function withSiteHeaders(
	fetch: SeoCrawlFetcher,
	siteHeaders: SeoSiteHeaders | undefined
): SeoCrawlFetcher {
	if (siteHeaders === undefined) return fetch;
	return (url, init, timeoutMs) => {
		const extra = siteHeaders(url);
		if (extra === null) return fetch(url, init, timeoutMs);
		const headers = new Headers(init.headers);
		for (const [name, value] of Object.entries(extra)) headers.set(name, value);
		return fetch(url, { ...init, headers }, timeoutMs);
	};
}

/**
 * A crawl's dependencies with the site's headers: its transport adds them to every request to the
 * site's own hosts, and the rendering browser is told them for the requests the page makes.
 *
 * @param deps - The dependencies.
 * @param siteHeaders - The site's headers, or undefined for none.
 * @returns The dependencies (the same object when there is nothing to add).
 */
export function withSiteAccess<T extends { fetch: SeoCrawlFetcher }>(
	deps: T,
	siteHeaders: SeoSiteHeaders | undefined
): T & { siteHeaders?: SeoSiteHeaders } {
	if (siteHeaders === undefined) return deps;
	return { ...deps, fetch: withSiteHeaders(deps.fetch, siteHeaders), siteHeaders };
}

/**
 * Two header sets merged, the second winning.
 *
 * @param left - The first set, or null.
 * @param right - The second set, or null.
 * @returns The merged set, or null when both are empty.
 */
export function mergeHeaders(
	left: Readonly<Record<string, string>> | null | undefined,
	right: Readonly<Record<string, string>> | null | undefined
): Record<string, string> | null {
	const merged = { ...left, ...right };
	return Object.keys(merged).length === 0 ? null : merged;
}
