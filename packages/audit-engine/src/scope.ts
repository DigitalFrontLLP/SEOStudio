/**
 * WHICH HOSTS A CRAWL MAY TOUCH, and which search property proves a project owns them.
 *
 * The crawl is scoped to the project's own host and its `www.` twin, never every subdomain of a domain
 * property: one robots.txt and one host concurrency key then govern every request. A property counts
 * as VERIFYING the project only when it covers that host, so a project pointed at somebody else's
 * site never gets the full crawl from an unrelated property.
 *
 * PURE: no database, no network.
 */

/** The site a crawl covers. */
export interface SiteScope {
	/** `https://host[:port]`. */
	origin: string;
	host: string;
	/**
	 * Whether the site's subdomains (`blog.` and `shop.` of the host) count as the site, as the members'
	 * crawl settings may ask; each is then crawled under its own robots.txt.
	 */
	subdomains?: boolean;
}

/**
 * A host without a leading `www.`, lowercased, its trailing dot dropped.
 *
 * @param host - The host.
 * @returns The bare host.
 */
export function bareHost(host: string): string {
	return host
		.toLowerCase()
		.replace(/\.$/, "")
		.replace(/^www\./, "");
}

/**
 * The site a project's website names.
 *
 * @param url - The project's website.
 * @returns The scope, or null when the URL is unusable.
 */
export function siteScope(url: string): SiteScope | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		const host = parsed.hostname.toLowerCase();
		if (host === "") return null;
		return { origin: `https://${parsed.host.toLowerCase()}`, host };
	} catch {
		return null;
	}
}

/**
 * Whether a host is the site: the project's host or its `www.` twin, and - when the scope counts them -
 * any host below it.
 *
 * @param scope - The site.
 * @param host - The host.
 * @returns Whether it is internal.
 */
export function isInternalHost(scope: SiteScope, host: string): boolean {
	const bare = bareHost(host);
	const site = bareHost(scope.host);
	if (bare === site) return true;
	return scope.subdomains === true && site !== "" && bare.endsWith(`.${site}`);
}

/**
 * The port a URL of the scope's origin is asked at: `''` for the scheme's default.
 *
 * @param scope - The site.
 * @returns The port.
 */
function scopePort(scope: SiteScope): string {
	try {
		return new URL(scope.origin).port;
	} catch {
		return "";
	}
}

/**
 * Whether a URL is on the site, read by the ONE parser the fetch uses too (the WHATWG URL parser, so a
 * backslash, an encoded dot, an IDN, a trailing dot or a port reads the same here as when it is asked
 * for): http or https, no user name or password (a URL carrying credentials is never the site's), the
 * site's own port, and an internal host. Every check of whether the crawl may go somewhere, and send
 * the site's headers there, goes through it.
 *
 * @param scope - The site.
 * @param url - The absolute URL.
 * @returns Whether it is on the site.
 */
export function isInternalUrl(scope: SiteScope, url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
	if (parsed.username !== "" || parsed.password !== "") return false;
	if (parsed.port !== scopePort(scope)) return false;
	return isInternalHost(scope, parsed.hostname);
}

/**
 * Whether a page key (`host[:port]/path?query`) is on the site, read as the URL the crawl fetches it
 * at (`https://` plus the key).
 *
 * @param scope - The site.
 * @param key - The page key.
 * @returns Whether it is on the site.
 */
export function keyInScope(scope: SiteScope, key: string): boolean {
	return isInternalUrl(scope, `https://${key}`);
}

/**
 * Whether a host is a subdomain the scope counts as the site: internal, but not the project's own host
 * nor its `www.` twin (so it answers to a robots.txt of its own).
 *
 * @param scope - The site.
 * @param host - The host.
 * @returns Whether it is a counted subdomain.
 */
export function isSubdomainHost(scope: SiteScope, host: string): boolean {
	return isInternalHost(scope, host) && bareHost(host) !== bareHost(scope.host);
}

/**
 * The site with the members' choice whether its subdomains count as it.
 *
 * @param scope - The site.
 * @param subdomains - Whether subdomains are internal.
 * @returns The scope.
 */
export function withSubdomains(scope: SiteScope, subdomains: boolean): SiteScope {
	return subdomains ? { ...scope, subdomains: true } : scope;
}

/**
 * The host of a page key (`host[:port]/path?query`).
 *
 * @param key - The key.
 * @returns The host, port dropped.
 */
export function hostOfKey(key: string): string {
	return (key.split("/")[0] ?? "").replace(/:\d+$/, "");
}

/**
 * The site host of a page key: its host, port and `www.` dropped, lowercased.
 *
 * @param key - The key.
 * @returns The bare host.
 */
export function bareHostOfKey(key: string): string {
	return bareHost(hostOfKey(key));
}

/**
 * Whether a URL is on a site host or one below it, a leading `www.` of the URL's host aside.
 *
 * @param url - The URL.
 * @param siteHost - The site's host, `www.` dropped ({@link bareHostOfKey}).
 * @returns Whether it is.
 */
export function onSiteOrBelow(url: string, siteHost: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return false;
	}
	return host === siteHost || host.endsWith(`.${siteHost}`);
}

/**
 * The folder a CDN keeps for itself on every site it fronts: Cloudflare answers all of `/cdn-cgi/`
 * (email obfuscation `/cdn-cgi/l/email-protection`, the bot trap `/cdn-cgi/content`, challenges,
 * image resizing, `/cdn-cgi/trace`) before the request reaches the site, so nothing there is a page
 * the site owner made or can fix.
 */
const PLATFORM_PATH = /^\/cdn-cgi(?:\/|$)/i;

/**
 * Whether a URL is one the CDN in front of the site answers, never a page of the site
 * ({@link PLATFORM_PATH}): the crawl never follows, plans or keeps one.
 *
 * @param keyOrUrl - A page key (`host[:port]/path?query`) or an absolute http(s) URL.
 * @returns Whether it is.
 */
export function isPlatformPath(keyOrUrl: string): boolean {
	if (/^https?:\/\//i.test(keyOrUrl)) {
		try {
			return PLATFORM_PATH.test(new URL(keyOrUrl).pathname);
		} catch {
			return false;
		}
	}
	const slash = keyOrUrl.indexOf("/");
	return slash !== -1 && PLATFORM_PATH.test(keyOrUrl.slice(slash).split(/[?#]/)[0] ?? "");
}

/**
 * Whether two keys differ only by the `www.` of their host.
 *
 * @param left - One key.
 * @param right - The other.
 * @returns Whether they are www twins.
 */
export function wwwTwins(left: string, right: string): boolean {
	return left !== right && left.replace(/^www\./, "") === right.replace(/^www\./, "");
}

/**
 * Whether a Search Console or Bing property covers a host: `sc-domain:x` covers `x` and every host
 * under it; a URL-prefix property (and a Bing site URL) covers its own host, `www.` ignored.
 *
 * @param property - The property as `source_connections.property` stores it.
 * @param host - The project's host.
 * @returns Whether the property covers the host.
 */
export function propertyCoversHost(property: string, host: string): boolean {
	const target = host.toLowerCase().replace(/\.$/, "");
	if (target === "") return false;
	const domain = /^sc-domain:(.+)$/i
		.exec(property.trim())?.[1]
		?.trim()
		.toLowerCase()
		.replace(/\.$/, "");
	if (domain !== undefined)
		return domain !== "" && (target === domain || target.endsWith(`.${domain}`));
	try {
		return bareHost(new URL(property.trim()).hostname) === bareHost(target);
	} catch {
		return false;
	}
}
