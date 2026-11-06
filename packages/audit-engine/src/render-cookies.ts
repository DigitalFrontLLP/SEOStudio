/**
 * THE COOKIES A PAGE'S OWN SITE SETS DURING ONE RENDER: kept for that render only and sent back to that
 * site as a browser sends them (by domain, path and `Secure`), so a page whose data calls need the
 * session cookie its own server just set (a store's cart, a CSRF token) renders its content instead
 * of an error. Never sent to another host, never kept past the render, never stored. Pure.
 */

/** The most cookies one render keeps. */
const MAX_COOKIES = 50;

/** The longest name and value one cookie may have, in characters. */
const MAX_COOKIE_CHARS = 4_096;

/** One cookie the site set. */
interface SiteCookie {
	name: string;
	value: string;
	/** The host it was set by, or the domain it names. */
	domain: string;
	/** Whether only the host that set it gets it back (no `Domain` attribute). */
	hostOnly: boolean;
	path: string;
	secure: boolean;
}

/**
 * The path a cookie set without a `Path` attribute belongs to: the request's directory.
 *
 * @param pathname - The request's path.
 * @returns The default path.
 */
function defaultPath(pathname: string): string {
	const slash = pathname.lastIndexOf("/");
	return slash <= 0 ? "/" : pathname.slice(0, slash);
}

/**
 * Whether a request path is within a cookie's path.
 *
 * @param requestPath - The request's path.
 * @param cookiePath - The cookie's path.
 * @returns Whether the cookie applies.
 */
function pathMatches(requestPath: string, cookiePath: string): boolean {
	if (requestPath === cookiePath) return true;
	if (!requestPath.startsWith(cookiePath)) return false;
	return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

/**
 * Whether a host gets a cookie back.
 *
 * @param host - The request's host, lower case.
 * @param cookie - The cookie.
 * @returns Whether its domain covers the host.
 */
function domainMatches(host: string, cookie: SiteCookie): boolean {
	return host === cookie.domain || (!cookie.hostOnly && host.endsWith(`.${cookie.domain}`));
}

/** One render's cookie jar for the page's own site; the caller judges which URLs are that site. */
export class RenderCookieJar {
	private readonly cookies = new Map<string, SiteCookie>();

	/**
	 * Keeps the cookies an answer from the page's own site set, and forgets those it expired.
	 *
	 * @param url - The URL that answered.
	 * @param setCookies - Its `Set-Cookie` header values.
	 * @param now - The time, in ms.
	 */
	store(url: string, setCookies: readonly string[], now: number): void {
		if (setCookies.length === 0) return;
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return;
		}
		const host = parsed.hostname.toLowerCase();
		for (const line of setCookies) {
			const [pair = "", ...attributes] = line.split(";");
			const equals = pair.indexOf("=");
			if (equals <= 0) continue;
			const name = pair.slice(0, equals).trim();
			const value = pair.slice(equals + 1).trim();
			if (name === "" || name.length + value.length > MAX_COOKIE_CHARS) continue;
			let domain: string | null = null;
			let path: string | null = null;
			let secure = false;
			let expired = false;
			let maxAge: number | null = null;
			for (const attribute of attributes) {
				const at = attribute.indexOf("=");
				const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
				const given = at < 0 ? "" : attribute.slice(at + 1).trim();
				if (key === "domain" && given !== "") domain = given.toLowerCase().replace(/^\./, "");
				else if (key === "path" && given.startsWith("/")) path = given;
				else if (key === "secure") secure = true;
				else if (key === "max-age" && /^-?\d+$/.test(given)) maxAge = Number(given);
				else if (key === "expires") {
					const when = Date.parse(given);
					if (!Number.isNaN(when) && when <= now) expired = true;
				}
			}
			if (maxAge !== null) expired = maxAge <= 0;
			if (domain !== null && domain !== host && !host.endsWith(`.${domain}`)) continue;
			const cookie: SiteCookie = {
				name,
				value,
				domain: domain ?? host,
				hostOnly: domain === null,
				path: path ?? defaultPath(parsed.pathname),
				secure
			};
			const key = `${cookie.domain}\u0000${cookie.path}\u0000${name}`;
			this.cookies.delete(key);
			if (expired) continue;
			if (this.cookies.size >= MAX_COOKIES) continue;
			this.cookies.set(key, cookie);
		}
	}

	/**
	 * The `Cookie` header a request to the page's own site carries: the kept cookies its host, path and
	 * scheme get back, the longest paths first.
	 *
	 * @param url - The request's URL.
	 * @returns The header value, or null when no cookie applies.
	 */
	header(url: string): string | null {
		if (this.cookies.size === 0) return null;
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return null;
		}
		const host = parsed.hostname.toLowerCase();
		const https = parsed.protocol === "https:";
		const sent = [...this.cookies.values()]
			.filter(
				(cookie) =>
					domainMatches(host, cookie) &&
					pathMatches(parsed.pathname, cookie.path) &&
					(https || !cookie.secure)
			)
			.sort((left, right) => right.path.length - left.path.length)
			.map((cookie) => `${cookie.name}=${cookie.value}`);
		return sent.length === 0 ? null : sent.join("; ");
	}
}
