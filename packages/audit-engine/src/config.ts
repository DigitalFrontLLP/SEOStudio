/**
 * THE CRAWLER'S IDENTITY AND LIMITS: how it introduces itself, how hard it may knock, and how much it
 * reads. Committed data, never env: a site owner reading their logs sees one neutral token rather
 * than a product name, and the docs link in the User-Agent is built from the base URL it is given.
 *
 * A host that runs the crawler at scale adds its own limits beside these (SEOStudio's job steps,
 * queue and capacity live in its private config, built on {@link seoCrawlerLimits}).
 */

/** The robots.txt group name the crawler obeys before falling back to `*`. */
export const SEO_CRAWLER_ROBOTS_AGENT = "SiteSnapshot";

/** The product token every crawler request carries. Neutral on purpose: no product name. */
export const SEO_CRAWLER_USER_AGENT_TOKEN = `${SEO_CRAWLER_ROBOTS_AGENT}/1.0`;

/** Google's crawler token: its robots.txt group decides what Google may crawl, which the audit judges. */
export const SEO_GOOGLEBOT_ROBOTS_AGENT = "Googlebot";

/** Bing's crawler token. */
export const SEO_BINGBOT_ROBOTS_AGENT = "Bingbot";

/** The docs page a site owner lands on from the User-Agent's link. */
export const SEO_CRAWLER_DOCS_PATH = "/docs/site-snapshot";

/**
 * The User-Agent header a crawl sends: the token plus a link explaining it.
 *
 * @param baseUrl - The site's base URL, e.g. `https://example.com`.
 * @returns The header value, e.g. `SiteSnapshot/1.0 (+https://example.com/docs/site-snapshot)`.
 */
export function seoCrawlerUserAgent(baseUrl: string): string {
	return `${SEO_CRAWLER_USER_AGENT_TOKEN} (+${baseUrl.replace(/\/+$/, "")}${SEO_CRAWLER_DOCS_PATH})`;
}

/**
 * The part of a browser User-Agent's `(compatible; ...)` that names the crawler: its token, the word
 * `bot` and its docs link (`SiteSnapshot/1.0; bot; +https://example.com/docs/site-snapshot`). Platforms
 * that serve crawlers a server-built page look for that word (a forum that answers bots its
 * server-built view while browsers get a script-built app, a website builder that builds a page for
 * bots on demand while browsers get a script-built fallback): with it, the crawler is served what
 * Google's crawler gets.
 *
 * @param crawlerUserAgent - The crawler's own User-Agent, from {@link seoCrawlerUserAgent}.
 * @returns The part inside `(compatible; ...)`.
 */
function compatiblePart(crawlerUserAgent: string): string {
	const match = /^(\S+) \(\+([^)]+)\)$/.exec(crawlerUserAgent.trim());
	return match === null
		? `${crawlerUserAgent.trim()}; bot`
		: `${match[1] ?? ""}; bot; +${match[2] ?? ""}`;
}

/**
 * The User-Agent the RENDERING browser sends: a phone's Chrome, as Google's smartphone crawler renders
 * with, carrying the crawler's own token, the word `bot` and its docs link the way Googlebot carries its
 * own ({@link compatiblePart}), so a site owner reads one crawler in their logs and robots.txt groups
 * still match the token.
 *
 * @param crawlerUserAgent - The crawler's own User-Agent, from {@link seoCrawlerUserAgent}.
 * @param chromeMajor - The rendering browser's Chrome major version, e.g. `151`.
 * @returns The header value.
 */
export function seoRenderUserAgent(crawlerUserAgent: string, chromeMajor: string): string {
	if (seoIsBrowserUserAgent(crawlerUserAgent)) return crawlerUserAgent.trim();
	const major = /^\d+$/.test(chromeMajor) ? chromeMajor : "0";
	return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36 (compatible; ${compatiblePart(crawlerUserAgent)})`;
}

/**
 * The User-Agent of the desktop app's second render, a desktop Chrome's, carrying the crawler's token
 * as {@link seoRenderUserAgent} does.
 *
 * @param crawlerUserAgent - The crawler's own User-Agent.
 * @param chromeMajor - The rendering browser's Chrome major version.
 * @returns The header value.
 */
export function seoDesktopRenderUserAgent(crawlerUserAgent: string, chromeMajor: string): string {
	if (seoIsBrowserUserAgent(crawlerUserAgent)) return crawlerUserAgent.trim();
	const major = /^\d+$/.test(chromeMajor) ? chromeMajor : "0";
	return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 (compatible; ${compatiblePart(crawlerUserAgent)})`;
}

/**
 * The Chrome major version a User-Agent states when no browser is at hand to ask: a preset's string,
 * and a page's own request made before the rendering browser starts.
 */
export const SEO_STATED_CHROME_MAJOR = "141";

/** A User-Agent preset the crawl settings offer, beside the crawler's own and a member's own string. */
export type SeoUserAgentPreset = "googlebot_smartphone" | "googlebot_desktop" | "bingbot";

/**
 * The HTTP User-Agent of a search engine preset, as that engine's crawler sends it. Only a member's
 * computer sends it; the platform's servers always send the crawler's own.
 *
 * @param preset - The preset.
 * @param chromeMajor - The Chrome major version the string carries, e.g. `151`.
 * @returns The header value.
 */
export function seoPresetUserAgent(
	preset: SeoUserAgentPreset,
	chromeMajor = SEO_STATED_CHROME_MAJOR
): string {
	const major = /^\d+$/.test(chromeMajor) ? chromeMajor : SEO_STATED_CHROME_MAJOR;
	switch (preset) {
		case "googlebot_smartphone":
			return `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`;
		case "googlebot_desktop":
			return `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/${major}.0.0.0 Safari/537.36`;
		default:
			return `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/${major}.0.0.0 Safari/537.36`;
	}
}

/**
 * Whether a User-Agent is a whole browser string (a preset or a member's own) rather than the crawler's
 * own short token: the render then sends it as it is instead of wrapping it in a phone Chrome's.
 *
 * @param userAgent - The User-Agent.
 * @returns Whether it is a whole browser string.
 */
export function seoIsBrowserUserAgent(userAgent: string): boolean {
	return userAgent.trim().startsWith("Mozilla/");
}

/** The limits a crawl reads: how hard it may knock, how much it reads, and how long a render may take. */
export interface SeoCrawlerLimits {
	/** The pause between two requests to one host, in ms (robots.txt `Crawl-delay` can raise it). */
	minDelayMs: number;
	/** The longest `Crawl-delay` honoured, in ms; a site asking for more is crawled at this pace. */
	maxCrawlDelayMs: number;
	/** One request's timeout, in ms. */
	timeoutMs: number;
	/** The largest page body read, in bytes; past it the page is read truncated. */
	maxPageBytes: number;
	/**
	 * The most of one sitemap file read, in bytes of its unpacked text: the protocol's own limit (50 MB),
	 * read as it arrives, so memory stays flat whatever the file's size.
	 */
	maxSitemapBytes: number;
	/** Sitemap files read per site, index files included. */
	maxSitemapFiles: number;
	/** Sitemap bytes one plan reads in all, every file together; past it the plan reads no more files. */
	maxSitemapBytesTotal: number;
	/** Page URLs collected from the sitemaps per site. */
	maxSitemapUrls: number;
	/** Redirect hops followed, each one re-validated. */
	maxRedirects: number;
	/**
	 * CRAWL-TRAP GUARDS: a URL past any of them is never fetched (the links to it are still stored), so
	 * faceted or endlessly nested URLs cannot fill the page cap. How deep the crawl goes is bound only by
	 * the cap.
	 */
	trapGuards: {
		/** Query parameters a URL may carry. */
		maxQueryParams: number;
		/** Folders a URL's path may nest. */
		maxPathSegments: number;
		/** Characters of a URL's key (host, path and query). */
		maxUrlChars: number;
		/** How often one folder name may appear in a path before the path reads as a loop (`/a/b/a/b/a`). */
		maxSegmentRepeats: number;
	};
	/** Links stored per page. */
	maxLinksPerPage: number;
	/**
	 * How long a browser may take to render one page, in ms, before what it holds is read as it stands
	 * (a render timeout). Every page is rendered, on every plan, as Google's renderer does.
	 */
	renderTimeoutMs: number;
	/** How long the network and the page must stay quiet before a render counts as settled, in ms. */
	renderQuietMs: number;
	/** One subresource request's timeout inside a render, in ms. */
	renderResourceTimeoutMs: number;
	/** Requests one render may make; past it the rest are refused. */
	renderMaxRequests: number;
	/** The largest subresource body a render reads, in bytes; a larger one fails. */
	renderMaxResourceBytes: number;
	/** The most subresource bytes one render reads in all; past it the rest are refused. */
	renderMaxBytes: number;
	/** Subresource requests one render has open at once; the rest wait their turn. */
	renderMaxInflight: number;
	/**
	 * The least time between two of a server render's requests to the crawled site's own host, in ms:
	 * they take turns in the same per-host pace every crawl of the host shares (shorter than the page
	 * pace, so a page's scripts and styles still load within the render's time).
	 */
	renderResourceIntervalMs: number;
	/** The largest request body a page's own script may send (to its own site only), in bytes. */
	renderMaxPostBytes: number;
	/** Elements a rendered DOM may hold before it is refused as too large to read. */
	renderMaxElements: number;
	/**
	 * The grace past `renderTimeoutMs` in which the rendered DOM must be read, in ms; a page still busy
	 * after it (a script that never yields) is a failed render and its browser page is killed.
	 */
	renderGraceMs: number;
	/**
	 * The time the in-page probe of a rendered page may take, in ms, after its DOM was read: the layout
	 * facts (widths, font sizes, tap targets, images, overlays) and a scroll to the bottom to see whether
	 * more content loads. Past it the page is read without them.
	 */
	renderProbeMs: number;
	/** The time the accessibility checks (axe-core) of a rendered page may take, in ms. */
	renderAxeMs: number;
	/**
	 * The time a member's custom JavaScript snippets may take on one rendered page, all together, in ms
	 * (a member's computer only).
	 */
	renderScriptsMs: number;
	/** The longest extra wait a member may set after a render settles, in ms (kept within the render's time). */
	renderMaxWaitMs: number;
	/** The viewport of the desktop app's second, desktop render (the mobile and desktop parity check). */
	renderDesktopViewport: { width: number; height: number };
	/** The viewport the page is rendered in: a phone, as Google's smartphone crawler renders. */
	renderViewport: { width: number; height: number };
	/**
	 * Pages of one family (the same path with an id segment, `/orders/{id}`) the crawl reads before it
	 * judges the family: once that many were read and every one says `noindex`, the family is read as a
	 * rotating sample (a host that crawls the site again and again sets its own rotation).
	 */
	noindexFamilySample: number;
}

/** The shipped crawl limits. */
export const seoCrawlerLimits: SeoCrawlerLimits = {
	minDelayMs: 1000,
	maxCrawlDelayMs: 10_000,
	timeoutMs: 15_000,
	maxPageBytes: 5 * 1024 * 1024,
	maxSitemapBytes: 50 * 1024 * 1024,
	maxSitemapFiles: 50,
	maxSitemapBytesTotal: 100 * 1024 * 1024,
	maxSitemapUrls: 50_000,
	maxRedirects: 5,
	trapGuards: { maxQueryParams: 3, maxPathSegments: 12, maxUrlChars: 1024, maxSegmentRepeats: 2 },
	maxLinksPerPage: 500,
	renderTimeoutMs: 15_000,
	renderQuietMs: 500,
	renderResourceTimeoutMs: 10_000,
	renderMaxRequests: 300,
	renderMaxResourceBytes: 8 * 1024 * 1024,
	renderMaxBytes: 32 * 1024 * 1024,
	renderMaxInflight: 8,
	renderResourceIntervalMs: 250,
	renderMaxPostBytes: 64 * 1024,
	renderMaxElements: 150_000,
	renderGraceMs: 5_000,
	renderProbeMs: 3_000,
	renderAxeMs: 6_000,
	renderScriptsMs: 4_000,
	renderMaxWaitMs: 10_000,
	renderDesktopViewport: { width: 1350, height: 940 },
	renderViewport: { width: 412, height: 915 },
	noindexFamilySample: 10
};

/** The render's two short calls beside the probe: creating its isolated world and reading the history. */
const RENDER_CHECKS_MS = 2_000;

/**
 * The longest one render may hold its page, in ms: the page's own time, the grace in which its DOM is
 * read, the in-page probe, the accessibility checks and the probe world's two short calls. A host kills a page held past it (plus its own
 * margin).
 *
 * @param timeoutMs - The page's own time limit (default: the crawler config).
 * @returns The bound.
 */
export function seoRenderBudgetMs(timeoutMs: number = seoCrawlerLimits.renderTimeoutMs): number {
	const config = seoCrawlerLimits;
	return (
		timeoutMs +
		config.renderGraceMs +
		config.renderProbeMs +
		config.renderAxeMs +
		config.renderScriptsMs +
		RENDER_CHECKS_MS
	);
}

/**
 * Hosts built to serve heavy traffic for every site on them, never one site's own server: the resource
 * checks ask them at `sharedCdnDelayMs` instead of a site's pace. A host matches by its exact name or as
 * a subdomain of one listed here.
 */
export const SEO_SHARED_CDN_HOSTS: readonly string[] = [
	"cdn.shopify.com",
	"amplience.net",
	"res.cloudinary.com",
	"imgix.net",
	"imagedelivery.net",
	"cdnjs.cloudflare.com",
	"cdn.jsdelivr.net",
	"unpkg.com",
	"code.jquery.com",
	"global.ssl.fastly.net",
	"static.wixstatic.com",
	"static.parastorage.com",
	"images.squarespace-cdn.com",
	"website-files.com",
	"ctfassets.net",
	"cdn.sanity.io",
	"a.storyblok.com",
	"wp.com",
	"fonts.googleapis.com",
	"ajax.googleapis.com",
	"gstatic.com",
	"googletagmanager.com",
	"use.typekit.net",
	"ytimg.com"
];

/** How the crawl checks what a site's pages load and link out to (`./resource-check`). */
export interface SeoResourceCheckLimits {
	/** Resources (images, stylesheets, scripts, fonts, the `og:image`, failed render requests) kept per page. */
	resourcesPerPage: number;
	/** Distinct outbound link URLs kept per page. */
	outboundLinksPerPage: number;
	/** Checks one job step (or one hand-out to a member's computer) makes. */
	checksPerStep: number;
	/** The pause between two requests to one shared CDN host ({@link SEO_SHARED_CDN_HOSTS}), in ms. */
	sharedCdnDelayMs: number;
	/** The most body bytes read when a server ignores a ranged GET, to measure a file's size. */
	maxBodyBytes: number;
	/** Linked documents (PDFs, office files) kept per page. */
	documentsPerPage: number;
	/** The bytes read from each end of a PDF for its title. */
	documentTitleBytes: number;
	/** A linked document this size or larger is reported as heavy, in bytes. */
	documentLargeBytes: number;
}

/** The shipped resource check limits. */
export const seoResourceCheckLimits: SeoResourceCheckLimits = {
	resourcesPerPage: 200,
	outboundLinksPerPage: 100,
	checksPerStep: 100,
	sharedCdnDelayMs: 125,
	maxBodyBytes: 16 * 1024 * 1024,
	documentsPerPage: 50,
	documentTitleBytes: 64 * 1024,
	documentLargeBytes: 10 * 1024 * 1024
};

/**
 * Characters of JSON-LD kept per page for the structured data rules; blocks past it are only counted.
 */
export const SEO_JSON_LD_CHARS_PER_PAGE = 16_000;
