import {
	SEO_CRAWLER_ROBOTS_AGENT,
	SEO_CRAWLER_USER_AGENT_TOKEN,
	SEO_STATED_CHROME_MAJOR,
	seoCrawlerLimits,
	seoDesktopRenderUserAgent,
	seoRenderUserAgent
} from "./config";
import type {
	SeoAgentFilesFacts,
	SeoCustomCheck,
	SeoPageA11yFacts,
	SeoPageCheckFacts,
	SeoPageDesktopView,
	SeoPageDomFacts,
	SeoPageRenderOutcomeValue,
	SeoPageRenderResourceFailure,
	SeoPageScriptResult,
	SeoRobotsFetchFacts,
	SeoRobotsFetchOutcomeValue,
	SeoSitemapFileFacts,
	SeoSitemapSourceValue,
	SeoSoft404Probe
} from "./facts";
import { normalizePageUrl } from "./urls";

import { readAgentFiles } from "./agent-files";
import { ampFactsOf } from "./amp-validate";
import { runCustomChecks } from "./custom-checks";
import { SEO_DOM_LIMITS } from "./dom-facts-schema";
import { extractPage } from "./extract";
import { grammarCodeWords, grammarFactsOf } from "./grammar";
import type { SeoGrammarChecker } from "./grammar";
import {
	decodeBody,
	decodeServedBody,
	fetchResource,
	optionalAuditHeaders,
	withoutNul
} from "./fetch";
import type { FetchResourceOptions } from "./fetch";
import { hostGateKey } from "./host-gate";
import { cutDeepMarkup } from "./markup-depth";
import { GOOGLEBOT_FILE_BYTES } from "./rules/head";
import type { SeoHostGate } from "./host-gate";
import { SEO_READING_LIMITS } from "./reading-limits";
import {
	compileRobots,
	directivesNoindex,
	isRobotsUnreachable,
	parseRobots,
	robotsAllows,
	SEO_ROBOTS_MAX_BYTES
} from "./robots";
import type { CompiledRobots } from "./robots";
import { hostOfKey, isInternalHost, siteScope } from "./scope";
import type { SiteScope } from "./scope";
import { spellingFactsOf } from "./spelling";
import type { SeoSpellingScope } from "./spelling";
import type { SeoSiteHeaders } from "./site-access";
import {
	COMMON_SITEMAP_PATHS,
	readSitemapStream,
	SITEMAP_MAX_IMAGES_PER_URL,
	SITEMAP_ROOTS,
	validLastmod
} from "./sitemap";
import type { ParsedSitemap, SitemapStreamReader } from "./sitemap";
import type {
	ExtractedPage,
	FetchedResource,
	SeoBrowserRender,
	SeoCrawlFetcher,
	SeoPageRenderer,
	SeoRenderRequest,
	SeoRenderScript
} from "./types";

/**
 * THE CRAWL'S NETWORK HALF: what the site answers, read and extracted, with NO database. Plain JSON
 * out, so the same reading can be committed where it was made (the server's crawl job) or carried to
 * the server from somewhere else (a crawl run on the user's own computer by the desktop app).
 *
 * Two readings: the PLAN's (robots.txt, the sitemaps, the soft-404 probe) and a PAGE's (one fetch,
 * redirects followed by hand, the extractor's read of its raw HTML, and - like Google - the same
 * extractor's read of the page as a browser rendered it). The decisions that need the stored pages -
 * what changed, what is new, what the cap allows - stay with the host's crawl (the server's, or `./site` for a standalone one).
 *
 * Imports only pure modules and type-only database shapes, so a desktop main process can run it.
 */

export { SEO_READING_LIMITS };

/** The `Accept` header of a page fetch. */
export const SEO_ACCEPT_HTML = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";

/** The `Accept` header of a robots.txt or sitemap fetch. */
const ACCEPT_XML = "application/xml,text/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";

/** The path prefix of the soft-404 probe: a page no site holds, so a real 404 is the right answer. */
const SOFT_404_PROBE_PREFIX = "site-snapshot-missing-page-";

/** The most of the probe's answer read: only its status matters. */
const SOFT_404_PROBE_BYTES = 64 * 1024;

/** Statuses that say "not now" rather than anything about the page. */
export const SEO_FAILURE_STATUSES: ReadonlySet<number> = new Set([403, 429, 503]);

/**
 * Server errors a page is asked for once more, after the polite pause, before its answer is kept: a
 * server that fails one request and answers the next is not broken, and a page error is filed only
 * when it answers the same twice (as a crawler's "retry 5xx" setting does).
 */
const RETRIED_SERVER_ERRORS: ReadonlySet<number> = new Set([500, 502, 504]);

/** What a reading reaches outside itself: the guarded transport, the clock, a pause and the browser. */
export interface SeoReadDeps {
	fetch: SeoCrawlFetcher;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
	/** The browser a page is rendered in; a reading made without one is raw only. */
	render?: SeoPageRenderer;
	/** The pace every crawl of a host shares (the server's); without one, a reading only pauses itself. */
	hostGate?: SeoHostGate;
	/**
	 * The site's sign-in headers (`./site-access`), for the requests the rendering browser makes to the
	 * site; `fetch` already adds them to the crawl's own requests (`withSiteAccess`).
	 */
	siteHeaders?: SeoSiteHeaders;
}

/**
 * Waits before a request to a site: for the host's shared slot when a gate is at hand (every crawl of
 * the host takes turns), else the plain pause.
 *
 * @param deps - The clock, the pause and the gate.
 * @param url - The URL about to be asked for.
 * @param delayMs - The least time between two requests to the host.
 * @param first - Whether this is the reading's first request (no plain pause before it).
 */
export async function paceRequest(
	deps: Pick<SeoReadDeps, "now" | "sleep" | "hostGate">,
	url: string,
	delayMs: number,
	first = false
): Promise<void> {
	if (deps.hostGate === undefined) {
		if (!first) await deps.sleep(delayMs);
		return;
	}
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return;
	}
	const wait = await deps.hostGate.reserve(host, delayMs, deps.now().getTime());
	if (wait > 0) await deps.sleep(wait);
}

/**
 * The pause between two requests to the site: the robots.txt `Crawl-delay`, never below the configured
 * floor nor above its ceiling.
 *
 * @param robots - The site's robots.txt.
 * @returns The pause in ms.
 */
export function politeDelay(robots: CompiledRobots): number {
	const asked = robots.crawlDelayMs ?? 0;
	return Math.max(seoCrawlerLimits.minDelayMs, Math.min(asked, seoCrawlerLimits.maxCrawlDelayMs));
}

/**
 * A robots.txt compiled for the group the crawl obeys: the crawler's own token by default.
 *
 * @param text - The file, or null when none was read.
 * @param agent - The product token whose group is obeyed (`robotsAgentOf` in `./discovery`).
 * @returns The compiled rules.
 */
export function crawlerRobots(
	text: string | null,
	agent: string = SEO_CRAWLER_ROBOTS_AGENT
): CompiledRobots {
	return compileRobots(parseRobots(text), agent);
}

/** What a plan reading needs to know about the site, from the server. */
export interface SeoSitePlanInput {
	/** The project's website. */
	siteUrl: string;
	/** The User-Agent every request sends. */
	userAgent: string;
	/** Whether the project holds a verified property for its site (every site is crawled whole). */
	verified: boolean;
	/** The robots.txt group the crawl obeys; the crawler's own when absent (an older server). */
	robotsAgent?: string;
	/** Whether the soft-404 probe is due. */
	probeSoft404: boolean;
	/** The robots.txt read last time, used when the site does not answer for it now. */
	fallbackRobotsTxt: string | null;
	/** The last soft-404 probe, for a plan that does not probe again; absent from an older server. */
	soft404?: SeoSoft404Probe | null;
}

/** What the plan read from the site. */
export interface SeoSitePlanReading {
	/**
	 * The robots.txt the crawl obeys: the file the site served, empty when it answered 4xx (no file
	 * allows everything), the last one read when it did not answer, or null when there is none at all.
	 */
	robotsTxt: string | null;
	sitemap: {
		/** Whether any sitemap could be read. */
		read: boolean;
		/** Each listed page on the site's own hosts, its URL as written (one per page key). */
		urls: string[];
		/** Each url set file's facts. */
		files: SeoSitemapFileFacts[];
	};
	/** The probe for a page that cannot exist, or null when it was not made (or nothing usable answered). */
	soft404: SeoSoft404Probe | null;
	/**
	 * How robots.txt answered; absent on readings from an app made before it was read. Stored only from
	 * the server's own read: the server replaces whatever a member's computer sends with it.
	 */
	robotsFetch?: SeoRobotsFetch | null;
	/** The site's files for AI agents; absent on readings from an app made before they were read. */
	agentFiles?: SeoAgentFilesFacts | null;
}

/** How many listed URLs a sitemap file fact names as examples. */
const SITEMAP_EXAMPLES = 5;

/** How old a news sitemap entry may be (Google reads news published in the last two days). */
const NEWS_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** How far ahead of the read a `<lastmod>` may lie (a time zone apart) before it is in the future. */
const LASTMOD_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * What one url set file states for the sitemap file rules: its URLs out of scope, its invalid and
 * future dates, the tags Google ignores, the extensions' limits, and URLs an earlier file listed.
 *
 * @param parsed - The parsed file.
 * @param fileUrl - Where the file answered.
 * @param declared - Whether robots.txt named the file (or the index that named it): it may then list
 *   any URL of the site, not only its own folder's.
 * @param onSite - Whether a host is one of the site's own.
 * @param listed - The URLs earlier files listed; this file's are added.
 * @param now - The read's time.
 * @returns The facts beyond the counts.
 */
export function sitemapFileFacts(
	parsed: ParsedSitemap,
	fileUrl: string,
	declared: boolean,
	onSite: (host: string) => boolean,
	listed: Set<string>,
	now: Date
): Omit<
	SeoSitemapFileFacts,
	"url" | "urls" | "withLastmod" | "distinctLastmod" | "source" | "status"
> {
	let folder = "/";
	try {
		const path = new URL(fileUrl).pathname;
		folder = path.slice(0, path.lastIndexOf("/") + 1);
	} catch {
		folder = "/";
	}
	const outside: string[] = [];
	const badDates: string[] = [];
	let outsideCount = 0;
	let badDateCount = 0;
	let future = 0;
	let deprecated = 0;
	let imagesOver = 0;
	let videosIncomplete = 0;
	let newsStale = 0;
	let repeated = 0;
	for (const [index, raw] of parsed.urls.entries()) {
		let url: URL | null = null;
		try {
			url = new URL(raw);
		} catch {
			url = null;
		}
		if (url === null || !onSite(url.hostname) || (!declared && !url.pathname.startsWith(folder))) {
			outsideCount += 1;
			if (outside.length < SITEMAP_EXAMPLES)
				outside.push(raw.slice(0, SEO_READING_LIMITS.sitemapUrlChars));
		}
		if (listed.has(raw)) repeated += 1;
		else if (listed.size < seoCrawlerLimits.maxSitemapUrls) listed.add(raw);
		const entry = parsed.entries[index];
		if (entry === undefined) continue;
		if (entry.lastmod !== null && entry.lastmod !== "") {
			if (!validLastmod(entry.lastmod)) {
				badDateCount += 1;
				if (badDates.length < SITEMAP_EXAMPLES)
					badDates.push(entry.lastmod.slice(0, SEO_READING_LIMITS.textChars));
			} else if (Date.parse(entry.lastmod) > now.getTime() + LASTMOD_FUTURE_SLACK_MS) future += 1;
		}
		if (entry.deprecated) deprecated += 1;
		if (entry.images > SITEMAP_MAX_IMAGES_PER_URL) imagesOver += 1;
		videosIncomplete += entry.videosIncomplete;
		if (
			entry.newsDates.some((date) => {
				const at = Date.parse(date);
				return Number.isFinite(at) && now.getTime() - at > NEWS_MAX_AGE_MS;
			})
		) {
			newsStale += 1;
		}
	}
	return {
		invalid: !parsed.wellFormed ? "malformed" : parsed.namespaced ? null : "namespace",
		outOfScope: { count: outsideCount, examples: outside },
		lastmodInvalid: { count: badDateCount, examples: badDates },
		lastmodFuture: future,
		deprecatedTags: deprecated,
		extension: { imagesOver, videosIncomplete, newsStale },
		repeated
	};
}

/**
 * The host of a sitemap URL that may sit on another host than the site's: an absolute http(s) URL
 * with no credentials in it. Whether that host may be reached at all is the guarded transport's call
 * (public addresses only), at every request and every redirect hop.
 *
 * @param url - The URL robots.txt or an index names.
 * @returns Its host (with its port), lowercased, or null when it is no such URL.
 */
function sitemapHost(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
		if (parsed.username !== "" || parsed.password !== "") return null;
		return parsed.host.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Reads a site's sitemaps: the ones robots.txt declares, else the common paths; indexes followed.
 * Sitemap files are read on the site's own hosts, and on another host only when robots.txt itself
 * names the file there (search engines accept a sitemap robots.txt names on any host: a CDN, a storage
 * bucket), with that index's children on that same host. Every request goes through the same guarded
 * transport, pace and caps, and only page URLs on the site's own hosts are kept. A file robots.txt or
 * an index named that cannot be read, or is not a sitemap, is kept as a fact; a common path that
 * answers nothing is only a guess that missed.
 *
 * @param scope - The site.
 * @param declared - The `Sitemap:` URLs from robots.txt.
 * @param userAgent - The User-Agent.
 * @param delay - The pause between two requests.
 * @param deps - The transport.
 * @param maxFiles - The most sitemap files read.
 * @returns Page key to its raw URL, whether any sitemap was read, and each file's facts.
 */
async function readSitemaps(
	scope: SiteScope,
	declared: readonly string[],
	userAgent: string,
	delay: number,
	deps: SeoReadDeps,
	maxFiles: number
): Promise<{ urls: Map<string, string>; read: boolean; files: SeoSitemapFileFacts[] }> {
	const onSite = (url: string): boolean => {
		try {
			return isInternalHost(scope, new URL(url).hostname);
		} catch {
			return false;
		}
	};
	const named = declared.filter((url) => onSite(url) || sitemapHost(url) !== null);
	const queue: { url: string; source: SeoSitemapSourceValue }[] =
		named.length > 0
			? named.map((url) => ({ url, source: "robots" }))
			: COMMON_SITEMAP_PATHS.map((path) => ({ url: `${scope.origin}${path}`, source: "guess" }));
	const elsewhere = new Set(
		named.filter((url) => !onSite(url)).map((url) => sitemapHost(url) ?? "")
	);
	const mayFollow = (url: string, from: string): boolean => {
		if (onSite(url)) return true;
		const host = sitemapHost(url);
		return host !== null && elsewhere.has(host) && host === sitemapHost(from);
	};
	const seen = new Set<string>();
	const urls = new Map<string, string>();
	const listed = new Set<string>();
	const facts: SeoSitemapFileFacts[] = [];
	let read = false;
	let files = 0;
	let bytes = 0;
	while (
		queue.length > 0 &&
		files < maxFiles &&
		bytes < seoCrawlerLimits.maxSitemapBytesTotal &&
		urls.size < seoCrawlerLimits.maxSitemapUrls
	) {
		const next = queue.shift();
		if (next === undefined || seen.has(next.url)) continue;
		seen.add(next.url);
		await paceRequest(deps, next.url, delay);
		files += 1;
		const room = Math.min(
			seoCrawlerLimits.maxSitemapBytes,
			seoCrawlerLimits.maxSitemapBytesTotal - bytes
		);
		const held: { stream: SitemapStreamReader | null } = { stream: null };
		const resource = await fetchResource(next.url, {
			fetcher: deps.fetch,
			userAgent,
			accept: ACCEPT_XML,
			maxBytes: room,
			timeoutMs: seoCrawlerLimits.timeoutMs,
			maxRedirects: seoCrawlerLimits.maxRedirects,
			now: deps.now,
			sink: (chunk, contentType) => {
				held.stream ??= readSitemapStream(contentType, room);
				return held.stream.write(chunk);
			}
		});
		const transported = Math.min(resource.sizeBytes, room);
		const empty = { url: resource.finalUrl, urls: 0, withLastmod: 0, distinctLastmod: 0 };
		if (resource.error !== null || resource.finalStatus < 200 || resource.finalStatus >= 300) {
			const unread = await held.stream?.end(true);
			bytes += Math.max(transported, unread?.bytes ?? 0);
			if (next.source !== "guess") {
				facts.push({
					...empty,
					url: next.url,
					source: next.source,
					status: resource.error === null ? resource.finalStatus : 0
				});
			}
			continue;
		}
		const streamed = await (held.stream ?? readSitemapStream(resource.contentType, room)).end(
			resource.truncated
		);
		bytes += Math.max(transported, streamed.bytes);
		const parsed = streamed.cut ? { ...streamed.parsed, wellFormed: true } : streamed.parsed;
		const status = resource.finalStatus;
		if (parsed.root === null || !SITEMAP_ROOTS.has(parsed.root)) {
			if (next.source !== "guess") {
				const invalid = streamed.blank ? "empty" : "not_sitemap";
				facts.push({ ...empty, source: next.source, status, invalid });
			}
			continue;
		}
		if (parsed.urls.length > 0 || parsed.sitemaps.length > 0) read = true;
		const declaredFile = next.source === "robots" || next.source === "declared_index";
		const childSource: SeoSitemapSourceValue = declaredFile ? "declared_index" : "index";
		for (const url of parsed.sitemaps) {
			if (queue.length >= maxFiles - files) break;
			if (mayFollow(url, next.url) && !seen.has(url) && !queue.some((queued) => queued.url === url))
				queue.push({ url, source: childSource });
		}
		if (parsed.root === "sitemapindex") {
			if (!parsed.wellFormed || !parsed.namespaced) {
				facts.push({
					...empty,
					source: next.source,
					status,
					invalid: parsed.wellFormed ? "namespace" : "malformed"
				});
			}
		} else {
			const days = parsed.lastmods.filter((day): day is string => day !== null);
			facts.push({
				url: resource.finalUrl,
				urls: parsed.listed,
				withLastmod: days.length,
				distinctLastmod: new Set(days).size,
				source: next.source,
				status,
				...sitemapFileFacts(
					parsed,
					resource.finalUrl,
					declaredFile,
					(host) => isInternalHost(scope, host),
					listed,
					deps.now()
				),
				...(parsed.hreflang === undefined ? {} : { hreflang: parsed.hreflang })
			});
		}
		for (const raw of parsed.urls) {
			if (urls.size >= seoCrawlerLimits.maxSitemapUrls) break;
			const key = normalizePageUrl(raw);
			if (key === null || urls.has(key) || !isInternalHost(scope, hostOfKey(key))) continue;
			urls.set(key, raw);
		}
	}
	return { urls, read, files: facts };
}

/**
 * Asks the site for a page that cannot exist, to see whether unknown URLs answer 404. Skipped when
 * robots.txt forbids the probe's path.
 *
 * @param scope - The site.
 * @param robots - The site's robots.txt rules.
 * @param fetchOptions - The transport and limits.
 * @param deps - The clock, the pause and the host's shared pace, taken before the request.
 * @param now - Now.
 * @returns The probe, or null when it was not made (or nothing usable answered).
 */
async function probeSoft404(
	scope: SiteScope,
	robots: CompiledRobots,
	fetchOptions: Omit<FetchResourceOptions, "accept" | "maxBytes">,
	deps: Pick<SeoReadDeps, "now" | "sleep" | "hostGate">,
	now: Date
): Promise<SeoSoft404Probe | null> {
	const url = `${scope.origin}/${SOFT_404_PROBE_PREFIX}${crypto.randomUUID().slice(0, 12)}`;
	if (!robotsAllows(robots, url)) return null;
	await paceRequest(deps, url, politeDelay(robots));
	const resource = await fetchResource(url, {
		...fetchOptions,
		accept: SEO_ACCEPT_HTML,
		maxBytes: SOFT_404_PROBE_BYTES
	});
	if (resource.error !== null && resource.error !== "too_many_redirects") return null;
	const finalKey = normalizePageUrl(resource.finalUrl);
	const moved =
		resource.chain.length > 1 && finalKey !== null && finalKey !== normalizePageUrl(url);
	const probe: SeoSoft404Probe = {
		checkedAt: now.toISOString(),
		url,
		status: resource.status,
		finalStatus: resource.finalStatus,
		landedOn: moved ? finalKey : null
	};
	return (await probeNoindex(resource)) ? { ...probe, noindex: true } : probe;
}

/**
 * Whether the page a probe for a missing URL answered with tells search engines not to index it, by
 * its `X-Robots-Tag` header or a robots meta tag: Google names that as a way to keep an error page
 * that answers 200 out of its index.
 *
 * @param resource - What answered the probe.
 * @returns Whether it does.
 */
async function probeNoindex(resource: FetchedResource): Promise<boolean> {
	if (directivesNoindex(resource.xRobotsTag)) return true;
	if (resource.body === null || resource.finalStatus < 200 || resource.finalStatus >= 300)
		return false;
	const html = await decodeBody(resource.body, resource.contentType, SOFT_404_PROBE_BYTES);
	return directivesNoindex(extractPage(cutDeepMarkup(html), resource.finalUrl).metaRobots);
}

/** How robots.txt answered one read. */
export interface SeoRobotsFetch {
	/** The last answer's status, or null when nothing answered. */
	status: number | null;
	outcome: SeoRobotsFetchOutcomeValue;
}

/** One read of robots.txt: the file the crawl obeys, and how the site answered for it. */
export interface SeoRobotsRead {
	/** The file, "" for a 4xx, the last one read when the site did not answer, or null when none. */
	text: string | null;
	/** How the site answered, or null when the website is not a crawlable URL. */
	fetch: SeoRobotsFetch | null;
}

/**
 * How a robots.txt fetch answered: a redirect chain that comes back to a URL it already asked is a
 * loop; a chain that is only long is not (a crawler reads that as no file).
 *
 * @param read - The fetch.
 * @returns The outcome.
 */
function robotsFetchOf(read: Omit<FetchedResource, "body">): SeoRobotsFetch {
	const status = read.chain.length === 0 ? null : read.finalStatus;
	if (read.error === "timeout") return { status, outcome: "timeout" };
	if (read.error === "too_many_redirects") {
		const urls = read.chain.map((hop) => hop.url);
		return { status, outcome: new Set(urls).size < urls.length ? "redirect_loop" : "failed" };
	}
	if (read.error !== null) return { status, outcome: "failed" };
	const final = read.finalStatus;
	if (final >= 200 && final < 300) return { status, outcome: "ok" };
	if (final >= 400 && final < 500) return { status, outcome: "client_error" };
	if (final >= 500 && final < 600) return { status, outcome: "server_error" };
	return { status, outcome: "failed" };
}

/**
 * Reads the robots.txt a crawl obeys from the site's own origin: the file it served, empty when it
 * answered 4xx (no file allows everything), the last one read when it did not answer, or null when
 * there is none at all; beside it, how the site answered.
 *
 * @param input - The site, the User-Agent and the last robots.txt read.
 * @param deps - The transport and the clock.
 * @returns The robots.txt and how the site answered.
 */
export async function readSiteRobots(
	input: Pick<SeoSitePlanInput, "siteUrl" | "userAgent" | "fallbackRobotsTxt">,
	deps: Pick<SeoReadDeps, "fetch" | "now"> & Partial<Pick<SeoReadDeps, "sleep" | "hostGate">>
): Promise<SeoRobotsRead> {
	const scope = siteScope(input.siteUrl);
	if (scope === null) return { text: input.fallbackRobotsTxt, fetch: null };
	const robotsUrl = `${scope.origin}/robots.txt`;
	if (deps.hostGate !== undefined && deps.sleep !== undefined) {
		await paceRequest(
			{ now: deps.now, sleep: deps.sleep, hostGate: deps.hostGate },
			robotsUrl,
			seoCrawlerLimits.minDelayMs,
			true
		);
	}
	const robotsRead = await fetchResource(robotsUrl, {
		fetcher: deps.fetch,
		userAgent: input.userAgent,
		maxRedirects: seoCrawlerLimits.maxRedirects,
		timeoutMs: seoCrawlerLimits.timeoutMs,
		now: deps.now,
		accept: "text/plain,*/*;q=0.5",
		maxBytes: SEO_ROBOTS_MAX_BYTES
	});
	const fetch = robotsFetchOf(robotsRead);
	if (fetch.outcome === "ok") {
		return {
			text:
				robotsRead.body === null
					? ""
					: await decodeBody(robotsRead.body, robotsRead.contentType, SEO_ROBOTS_MAX_BYTES),
			fetch
		};
	}
	if (fetch.outcome === "client_error") return { text: "", fetch };
	return { text: input.fallbackRobotsTxt, fetch };
}

/**
 * How robots.txt answered at a plan, with the run of plans in a row it was unreachable at.
 *
 * @param fetch - How it answered now.
 * @param before - The last plan's facts, or null.
 * @param now - Now.
 * @returns The facts to store.
 */
export function robotsFetchFacts(
	fetch: SeoRobotsFetch,
	before: SeoRobotsFetchFacts | null,
	now: Date
): SeoRobotsFetchFacts {
	return {
		checkedAt: now.toISOString(),
		status: fetch.status,
		outcome: fetch.outcome,
		failures: isRobotsUnreachable(fetch.outcome) ? (before?.failures ?? 0) + 1 : 0
	};
}

/**
 * READS WHAT A CRAWL PLAN NEEDS FROM THE SITE: robots.txt, every sitemap file and, when it is due, the
 * soft-404 probe. When there is no robots.txt to obey at all, nothing else is fetched.
 *
 * @param input - The site and what the server decided about it.
 * @param deps - The transport, the clock and the pause.
 * @returns The reading, or null when the website is not a crawlable URL.
 */
export async function readSitePlan(
	input: SeoSitePlanInput,
	deps: SeoReadDeps
): Promise<SeoSitePlanReading | null> {
	const scope = siteScope(input.siteUrl);
	if (scope === null) return null;
	const fetchOptions = {
		fetcher: deps.fetch,
		userAgent: input.userAgent,
		maxRedirects: seoCrawlerLimits.maxRedirects,
		timeoutMs: seoCrawlerLimits.timeoutMs,
		now: deps.now
	};
	const robotsRead = await readSiteRobots(input, deps);
	const robotsTxt = robotsRead.text;
	if (robotsTxt === null) {
		return {
			robotsTxt: null,
			sitemap: { read: false, urls: [], files: [] },
			soft404: null,
			robotsFetch: robotsRead.fetch
		};
	}
	const robots = crawlerRobots(robotsTxt, input.robotsAgent);
	const sitemap = await readSitemaps(
		scope,
		robots.sitemaps,
		input.userAgent,
		politeDelay(robots),
		deps,
		seoCrawlerLimits.maxSitemapFiles
	);
	const soft404 = input.probeSoft404
		? await probeSoft404(scope, robots, fetchOptions, deps, deps.now())
		: null;
	const probe = soft404 ?? input.soft404 ?? null;
	const agentFiles = await readAgentFiles(
		{
			origin: scope.origin,
			userAgent: input.userAgent,
			robots,
			catchAll: probe === null ? null : probe.finalStatus >= 200 && probe.finalStatus < 300
		},
		{
			fetch: deps.fetch,
			now: deps.now,
			pace: (url) => paceRequest(deps, url, politeDelay(robots))
		}
	);
	return {
		robotsTxt,
		sitemap: {
			read: sitemap.read,
			urls: [...sitemap.urls.values()],
			files: sitemap.files
		},
		soft404,
		robotsFetch: robotsRead.fetch,
		agentFiles
	};
}

/** What one fetch answered, as a reading carries it: the body left behind once it was read. */
export type SeoReadResource = Omit<FetchedResource, "body" | "requestedUrl" | "truncated">;

/** The page as a browser rendered it, read by the same extractor as its raw HTML. */
export interface SeoRenderedReading {
	outcome: SeoPageRenderOutcomeValue;
	/** Why the render failed, or null. */
	error: string | null;
	/** The URL of the document the browser ended on. */
	finalUrl: string;
	renderMs: number;
	/** The extractor's read of the rendered DOM; null when the render failed. */
	page: ExtractedPage | null;
	/** Uncaught script errors and console errors, cut short. */
	consoleErrors: string[];
	/** Scripts, stylesheets and data requests the page could not load. */
	failedResources: SeoPageRenderResourceFailure[];
	/** Requests the render refused to send (a POST to another host, a private address); absent from an older app. */
	blockedRequests?: number;
	/** Requests a host refused for the crawl's rate limit; absent from an older app. */
	rateLimitedRequests?: number;
	/** What the in-page probe measured; absent from an app from before it ran, null when it could not. */
	dom?: SeoPageDomFacts | null;
	/** What the accessibility checks found; absent or null when they did not run. */
	a11y?: SeoPageA11yFacts | null;
	/** The page as a desktop browser rendered it (the desktop app's second render), when there was one. */
	desktop?: SeoPageDesktopView | null;
}

/** One page's reading: what answered, the extractor's read of its raw HTML, and of its render. */
export interface SeoPageReading {
	/** The page fetched. */
	pageKey: string;
	resource: SeoReadResource;
	/**
	 * The page read from the RAW answer: only for a 2xx HTML answer that did not redirect to another
	 * page, null otherwise (a redirect, an error status, a failure, a file that is not HTML).
	 */
	page: ExtractedPage | null;
	/**
	 * The page as a browser rendered it, whenever the raw answer was a page; null when it was not (or
	 * the reading was made without a browser, by an older desktop app).
	 */
	rendered: SeoRenderedReading | null;
	/** What the optional checks found on the page (spelling, AMP, custom patterns); absent or null when none ran. */
	checks?: SeoPageCheckFacts | null;
	/**
	 * A JPEG of the rendered page (base64), only when the reading asked for one (a single page
	 * analysis, or a crawl on a member's computer that keeps screenshots); never carried to the server
	 * with a crawl's readings.
	 */
	screenshot?: string | null;
	/**
	 * The page's raw and rendered HTML, only when the reading asked for them (a crawl on a member's
	 * computer that keeps them for itself); never carried to the server.
	 */
	html?: { raw: string; rendered: string | null } | null;
}

/** Where a fetch answered from, as the crawl judges it. */
export interface SeoReadVerdict {
	/** The page the fetch landed on, when it is a crawlable URL. */
	finalKey: string | null;
	/** Whether the chain moved to another page. */
	redirected: boolean;
	/** The status the page is filed under: a redirecting page's own redirect status, else the last hop's. */
	status: number;
	/** Whether nothing usable answered (a transport failure, nothing at all). */
	failed: boolean;
}

/**
 * How the crawl reads a fetch: failed or not, redirected or not, and the status it files.
 *
 * @param pageKey - The page fetched.
 * @param resource - What answered.
 * @returns The verdict.
 */
export function readVerdict(pageKey: string, resource: SeoReadResource): SeoReadVerdict {
	const failed = resource.error !== null || resource.status === 0;
	const finalKey = normalizePageUrl(resource.finalUrl);
	const redirected = resource.chain.length > 1 && finalKey !== null && finalKey !== pageKey;
	return {
		finalKey,
		redirected,
		status: redirected ? resource.status : resource.finalStatus,
		failed
	};
}

/**
 * Whether a reading is about the page it names: its first hop (or, with no hop, the URL it failed on)
 * is that page, and a fetch that answered ends on the last hop of its own chain. A reading made
 * somewhere else carries its URLs, so a reading that names one page and describes another is refused.
 *
 * @param pageKey - The page the reading names.
 * @param resource - What answered.
 * @returns Whether the reading describes that page.
 */
export function readingFitsPage(pageKey: string, resource: SeoReadResource): boolean {
	const first = resource.chain[0]?.url ?? resource.finalUrl;
	if (normalizePageUrl(first) !== pageKey) return false;
	if (resource.error !== null) return true;
	return resource.chain.length > 0 && resource.chain.at(-1)?.url === resource.finalUrl;
}

/**
 * Whether a fetch's answer is a page the extractor reads: a 2xx HTML answer that stayed on the page.
 *
 * @param pageKey - The page fetched.
 * @param resource - What answered.
 * @returns Whether its body is read as a page.
 */
export function readsAsPage(pageKey: string, resource: SeoReadResource): boolean {
	const verdict = readVerdict(pageKey, resource);
	if (verdict.failed || verdict.redirected || SEO_FAILURE_STATUSES.has(verdict.status))
		return false;
	const ok = verdict.status >= 200 && verdict.status < 300;
	return ok && /html/i.test(resource.contentType ?? "");
}

/** The start of an HTML document, past any byte order mark (a whitespace to `\s`) and comments. */
const HTML_START = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body)[\s>]/i;

/**
 * Whether a 2xx answer that stayed on the page holds an HTML document its `Content-Type` does not
 * name as HTML (missing, `text/plain`, ...): browsers may still show it, but search engines read it
 * by its type.
 *
 * @param pageKey - The page fetched.
 * @param resource - What answered.
 * @param body - Its body, or null.
 * @returns Whether it does.
 */
export function htmlUnlabelled(
	pageKey: string,
	resource: SeoReadResource,
	body: Uint8Array | null
): boolean {
	if (body === null || /html/i.test(resource.contentType ?? "")) return false;
	const verdict = readVerdict(pageKey, resource);
	if (verdict.failed || verdict.redirected || verdict.status < 200 || verdict.status >= 300)
		return false;
	return HTML_START.test(new TextDecoder("latin1").decode(body.subarray(0, 1024)));
}

/** The share of the main text's words the part Googlebot reads must hold for the main text to be whole. */
const CUT_MAIN_TEXT_KEPT = 0.95;

/**
 * WHAT GOOGLEBOT'S CUT LEAVES OUT of an HTML file over what it reads ({@link GOOGLEBOT_FILE_BYTES}):
 * the page read again from only that first part, against the whole read. The head is cut when the
 * part reads a head element search engines use otherwise (the title, the description, the robots meta,
 * the canonical, hreflang); the main text is cut when the part holds fewer than
 * {@link CUT_MAIN_TEXT_KEPT} of its words.
 *
 * @param html - The page's HTML as served, decoded.
 * @param page - The whole read.
 * @param finalUrl - The URL it was read at.
 * @returns What the cut leaves out, or null for a file within the limit.
 */
export function htmlCutOf(
	html: string,
	page: ExtractedPage,
	finalUrl: string
): { head: boolean; mainText: boolean } | null {
	const bytes = new TextEncoder().encode(html);
	if (bytes.byteLength <= GOOGLEBOT_FILE_BYTES) return null;
	const kept = new TextDecoder().decode(bytes.subarray(0, GOOGLEBOT_FILE_BYTES));
	const part = extractPage(cutDeepMarkup(kept), finalUrl);
	const head =
		part.title !== page.title ||
		part.metaDescription !== page.metaDescription ||
		part.metaRobots !== page.metaRobots ||
		part.canonical !== page.canonical ||
		part.hreflang.length !== page.hreflang.length;
	return { head, mainText: part.wordCount < page.wordCount * CUT_MAIN_TEXT_KEPT };
}

/**
 * What the extractor reads from a browser's render, judged against the page it was asked for: a render
 * that ended on another document (a script navigated away) or on a bot wall reads as failed.
 *
 * @param pageKey - The page.
 * @param render - What the browser answered.
 * @returns The rendered reading.
 */
export function renderedReadingOf(pageKey: string, render: SeoBrowserRender): SeoRenderedReading {
	const base = {
		finalUrl: render.finalUrl,
		renderMs: render.renderMs,
		consoleErrors: render.consoleErrors,
		failedResources: render.failedResources,
		blockedRequests: render.blockedRequests,
		rateLimitedRequests: render.rateLimitedRequests ?? 0,
		dom: render.dom ?? null,
		a11y: render.a11y ?? null
	};
	if (render.outcome === "failed" || render.html === null) {
		return { ...base, outcome: "failed", error: render.error ?? "browser", page: null };
	}
	if (normalizePageUrl(render.finalUrl) !== pageKey) {
		return { ...base, outcome: "failed", error: "navigated", page: null };
	}
	const page = boundPage(
		extractPage(cutDeepMarkup(render.html), render.finalUrl, { rendered: true })
	);
	if (page.botWall) return { ...base, outcome: "failed", error: "bot_wall", page: null };
	return { ...base, outcome: render.outcome, error: null, page };
}

/**
 * Whether a subresource may be fetched by the rendering browser: anything off the site, and on the
 * site's own hosts what its robots.txt lets the crawler fetch (Google obeys robots.txt for a page's
 * scripts, styles and data too).
 *
 * @param pageUrl - The page rendered.
 * @param robots - The site's robots.txt, or null when none is known (everything allowed).
 * @returns The check, or null when nothing is checked.
 */
export function renderResourceCheck(
	pageUrl: string,
	robots: CompiledRobots | null
): ((url: string) => boolean) | null {
	const scope = siteScope(pageUrl);
	if (robots === null || scope === null) return null;
	return (url) => {
		let host: string;
		try {
			host = new URL(url).hostname.toLowerCase();
		} catch {
			return true;
		}
		return !isInternalHost(scope, host) || robotsAllows(robots, url);
	};
}

/** How a page reading is made beyond its transport. */
export interface SeoReadPageOptions {
	/** The robots.txt the crawl obeys, for the rendering browser's own requests to the site. */
	robots?: CompiledRobots | null;
	/** Told just before the page is rendered. */
	onRender?: () => void;
	/** Which accessibility rules run on the rendered page: the search-relevant subset, all, or none. */
	accessibility?: "seo" | "all" | null;
	/** Whether the page is also rendered as a desktop browser sees it, for the parity check. */
	desktopRender?: boolean;
	/** Which languages the spelling check reads (the server's light ones, or all), or null for none. */
	spelling?: SeoSpellingScope | null;
	/** The project's custom search and extraction patterns. */
	customChecks?: readonly SeoCustomCheck[];
	/**
	 * A second robots.txt the browser also obeys for the site's own files (a desktop run's test file):
	 * a file either one forbids is not loaded.
	 */
	extraRobots?: CompiledRobots | null;
	/** Whether the rendered page is also captured as a screenshot (a single page analysis). */
	screenshot?: boolean;
	/** The device the page is rendered as: a phone (the default, as Google renders) or a desktop. */
	device?: "mobile" | "desktop";
	/** How long a rendered page is left to run once it settled, in ms (the members' render wait). */
	renderWaitMs?: number;
	/** The project's custom JavaScript snippets, run on the rendered page (a member's computer only). */
	scripts?: readonly SeoRenderScript[];
	/** The grammar checker the host lends (a member's computer only), or null for no grammar check. */
	grammar?: SeoGrammarChecker | null;
	/**
	 * Whether the reading keeps the page's raw and rendered HTML (`html`), for the member's computer to
	 * keep for itself; never carried to the server.
	 */
	keepHtml?: boolean;
}

/**
 * The optional checks of a page read as a page: spelling (when asked) and the custom patterns over the
 * page the audit judges (the rendered one whenever the browser rendered it), the AMP validator over the
 * HTML an AMP page served.
 *
 * @param raw - The extractor's read of the raw HTML.
 * @param rawHtml - The raw HTML.
 * @param rendered - The render, or null.
 * @param renderedHtml - The rendered HTML, or null.
 * @param options - Which checks run.
 * @returns The facts, or null when none ran.
 */
async function pageChecksOf(
	raw: ExtractedPage,
	rawHtml: string,
	rendered: SeoRenderedReading | null,
	renderedHtml: string | null,
	options: SeoReadPageOptions
): Promise<SeoPageCheckFacts | null> {
	const renderedPage =
		rendered !== null && rendered.outcome !== "failed" && renderedHtml !== null
			? rendered.page
			: null;
	const page = renderedPage ?? raw;
	const checks: SeoPageCheckFacts = {};
	const spelling = options.spelling ?? null;
	if (spelling !== null) {
		checks.spelling = await spellingFactsOf(
			{
				mainText: page.mainText,
				title: page.title,
				h1: page.h1,
				lang: page.markup?.lang.html ?? (page.lang === "" ? null : page.lang)
			},
			spelling
		);
	}
	const grammar = options.grammar ?? null;
	if (grammar !== null) {
		checks.grammar = await grammarFactsOf(
			{
				title: page.title,
				h1: page.h1,
				mainText: page.mainText,
				lang: page.markup?.lang.html ?? (page.lang === "" ? null : page.lang)
			},
			grammar,
			grammarCodeWords(renderedPage !== null && renderedHtml !== null ? renderedHtml : rawHtml)
		);
	}
	if (raw.markup?.amp.isAmp === true) checks.amp = await ampFactsOf(rawHtml);
	const custom = options.customChecks ?? [];
	if (custom.length > 0) {
		checks.custom = runCustomChecks(
			renderedPage !== null && renderedHtml !== null ? renderedHtml : rawHtml,
			custom
		);
	}
	return Object.keys(checks).length === 0 ? null : checks;
}

/**
 * The rendering browser's check of a subresource under one or two robots.txt files.
 *
 * @param pageUrl - The page rendered.
 * @param robots - The robots.txt the crawl obeys, or null.
 * @param extra - A second file the browser also obeys, or null.
 * @returns The check, or null when nothing is checked.
 */
function renderResourceChecks(
	pageUrl: string,
	robots: CompiledRobots | null,
	extra: CompiledRobots | null
): ((url: string) => boolean) | null {
	const first = renderResourceCheck(pageUrl, robots);
	const second = renderResourceCheck(pageUrl, extra);
	if (first === null || second === null) return first ?? second;
	return (url) => first(url) && second(url);
}

/**
 * A desktop render's view of the page: what the parity check compares with the phone render.
 *
 * @param pageKey - The page.
 * @param render - What the desktop browser answered.
 * @returns The view.
 */
export function desktopViewOf(pageKey: string, render: SeoBrowserRender): SeoPageDesktopView {
	const reading = renderedReadingOf(pageKey, render);
	const page = reading.page;
	const value = (text: string, max: number = SEO_DOM_LIMITS.valueChars): string =>
		text.length > max ? text.slice(0, max) : text;
	return {
		outcome: reading.outcome,
		title: value(page?.title ?? ""),
		metaRobots: value(page?.metaRobots ?? ""),
		canonical: value(page?.canonical ?? "", SEO_DOM_LIMITS.urlChars),
		words: page?.wordCount ?? 0,
		schemaTypes: (page?.schemaTypes ?? [])
			.slice(0, SEO_DOM_LIMITS.schemaTypes)
			.map((type) => value(type, 200))
	};
}

/**
 * A render's answer with the NUL characters of its HTML dropped: the browser got the page as served,
 * NULs included, and what is read and kept of its answer holds none (Postgres text cannot).
 *
 * @param render - What the browser answered.
 * @returns The answer, its HTML without NULs.
 */
function storableRender(render: SeoBrowserRender): SeoBrowserRender {
	return render.html === null || !render.html.includes("\u0000")
		? render
		: { ...render, html: withoutNul(render.html) };
}

/**
 * The pace a server render's requests to the page's own host take: turns in the per-host gate every
 * crawl of the host shares, at the render's shorter interval. Requests to other hosts keep the render's
 * own caps. Nothing without a gate (the desktop app paces itself).
 *
 * @param pageUrl - The page rendered.
 * @param deps - The clock, the pause and the gate, when at hand.
 * @returns The request's pace hook, or nothing.
 */
function renderPace(
	pageUrl: string,
	deps: Pick<SeoReadDeps, "now"> & Partial<Pick<SeoReadDeps, "sleep" | "hostGate">>
): Pick<SeoRenderRequest, "paceResource"> {
	const { hostGate, sleep, now } = deps;
	if (hostGate === undefined || sleep === undefined) return {};
	let pageHost: string;
	try {
		pageHost = hostGateKey(new URL(pageUrl).hostname);
	} catch {
		return {};
	}
	return {
		paceResource: async (url) => {
			let host: string;
			try {
				host = new URL(url).hostname;
			} catch {
				return;
			}
			if (hostGateKey(host) !== pageHost) return;
			await paceRequest(
				{ now, sleep, hostGate },
				url,
				seoCrawlerLimits.renderResourceIntervalMs,
				true
			);
		}
	};
}

/**
 * The User-Agent a page is asked for with when a browser renders it: the very one the browser then
 * sends (a phone's Chrome carrying the crawler's token, or a desktop's for a desktop render), so a site
 * that serves phones another page (a website builder's own phone layout, without a `Vary` header) is
 * judged on the page a phone and Google's smartphone crawler get. A whole browser string (a preset) and
 * a member's own string are sent as they are.
 *
 * @param userAgent - The crawl's User-Agent.
 * @param device - The device the page is rendered as.
 * @returns The User-Agent of the page request and its render.
 */
function renderedDocumentUserAgent(userAgent: string, device: "mobile" | "desktop"): string {
	if (!userAgent.trim().startsWith(SEO_CRAWLER_USER_AGENT_TOKEN)) return userAgent;
	return device === "desktop"
		? seoDesktopRenderUserAgent(userAgent, SEO_STATED_CHROME_MAJOR)
		: seoRenderUserAgent(userAgent, SEO_STATED_CHROME_MAJOR);
}

/** The most of the plain re-ask's answer read: only its status matters. */
const PLAIN_AGENT_PROBE_BYTES = 1024;

/**
 * Whether the site serves a page to the crawler's own plain User-Agent (its token and docs link, no
 * browser string, no word `bot`) after it answered 403 to the browser User-Agent the page was asked
 * with (a phone's Chrome naming the crawler, `(compatible; <token>; bot; ...)`). Same address, same
 * transport, another User-Agent: the site's firewall then refuses that string, most often for its word
 * `bot`, not the crawler's address. One request more, asked only after such a 403, after the host's
 * pace.
 *
 * @param url - The page's URL.
 * @param userAgent - The crawler's own User-Agent.
 * @param deps - The transport, the clock, and the pause and pace when the crawl has them.
 * @returns Whether the plain User-Agent got the page (a 2xx).
 */
async function answersPlainAgent(
	url: string,
	userAgent: string,
	deps: Pick<SeoReadDeps, "fetch" | "now"> & Partial<Pick<SeoReadDeps, "sleep" | "hostGate">>
): Promise<boolean> {
	const { sleep } = deps;
	if (sleep !== undefined)
		await paceRequest(
			{ now: deps.now, sleep, hostGate: deps.hostGate },
			url,
			seoCrawlerLimits.minDelayMs
		);
	const plain = await fetchResource(url, {
		fetcher: deps.fetch,
		userAgent,
		accept: SEO_ACCEPT_HTML,
		maxBytes: PLAIN_AGENT_PROBE_BYTES,
		timeoutMs: seoCrawlerLimits.timeoutMs,
		maxRedirects: seoCrawlerLimits.maxRedirects,
		now: deps.now
	});
	return plain.error === null && plain.finalStatus >= 200 && plain.finalStatus < 300;
}

/**
 * The address a page is read at. A page key never ends in a slash, so a page the site publishes at
 * `/fr/` is asked for at `/fr`; a server that answers both spellings alike (a static host) then serves
 * the same HTML at an address the site never links, and a script that builds links from the address
 * (a language switcher) builds them wrong. When the page answered at once and names its own slash
 * spelling as canonical, it is read and rendered at that spelling, as the site and search engines
 * address it.
 *
 * @param pageKey - The page.
 * @param resource - What answered.
 * @param page - The extractor's read of the raw HTML.
 * @returns The URL the page is read at.
 */
function slashSpellingOf(pageKey: string, resource: SeoReadResource, page: ExtractedPage): string {
	const slashed = `https://${pageKey}/`;
	if (pageKey.includes("?") || pageKey.endsWith("/")) return resource.finalUrl;
	if (resource.chain.length !== 1 || resource.finalUrl !== `https://${pageKey}`)
		return resource.finalUrl;
	const canonicals = page.audit.canonicals;
	return canonicals.length > 0 && canonicals.every((url) => url === slashed)
		? slashed
		: resource.finalUrl;
}

/** The temporary redirect statuses a platform sends phones to a mobile copy of a page with. */
const MOBILE_COPY_REDIRECTS: ReadonlySet<number> = new Set([302, 303, 307]);

/** The query parameters a platform adds to a page's URL for its mobile copy (Blogger's `?m=1`). */
const MOBILE_COPY_PARAMS: ReadonlySet<string> = new Set(["m=1"]);

/**
 * The page key a mobile copy's key is the copy of: the same key with one known mobile-copy parameter
 * ({@link MOBILE_COPY_PARAMS}) taken out, or null when the key carries none. Keys sort their
 * parameters, so the rest keep their order.
 *
 * @param key - The copy's page key.
 * @returns The original page's key, or null.
 */
function mobileCopyOriginal(key: string): string | null {
	const at = key.indexOf("?");
	if (at < 0) return null;
	const params = key.slice(at + 1).split("&");
	const kept = params.filter((param) => !MOBILE_COPY_PARAMS.has(param));
	if (kept.length !== params.length - 1) return null;
	return kept.length === 0 ? key.slice(0, at) : `${key.slice(0, at)}?${kept.join("&")}`;
}

/**
 * Whether a fetch has the shape of a platform's MOBILE COPY redirect: one temporary redirect
 * ({@link MOBILE_COPY_REDIRECTS}) from the page to the same URL with only a known mobile-copy parameter
 * added (Blogger sends every phone from `/post.html` to `/post.html?m=1`), answered by a 2xx HTML page.
 * Whether the copy names the page back as its canonical is the caller's to check.
 *
 * @param pageKey - The page fetched.
 * @param resource - What answered.
 * @returns Whether it has the shape.
 */
function mobileCopyShaped(pageKey: string, resource: SeoReadResource): boolean {
	const [first, last] = resource.chain;
	if (resource.error !== null || resource.chain.length !== 2) return false;
	if (first === undefined || last === undefined) return false;
	if (!MOBILE_COPY_REDIRECTS.has(first.status) || normalizePageUrl(first.url) !== pageKey)
		return false;
	if (last.status < 200 || last.status >= 300 || !/html/i.test(resource.contentType ?? ""))
		return false;
	const copyKey = normalizePageUrl(resource.finalUrl);
	return copyKey !== null && mobileCopyOriginal(copyKey) === pageKey;
}

/**
 * Whether a page's canonical tags all name the page: at least one, and every one the same page key.
 *
 * @param page - The extractor's read.
 * @param pageKey - The page.
 * @returns Whether they do.
 */
function canonicalNamesPage(page: ExtractedPage, pageKey: string): boolean {
	const canonicals = page.audit.canonicals;
	return canonicals.length > 0 && canonicals.every((url) => normalizePageUrl(url) === pageKey);
}

/**
 * A MOBILE COPY READ AS THE PAGE ITSELF: a temporary redirect to the page's own URL with only a known
 * mobile-copy parameter added, landing on a copy whose canonical names the page ({@link mobileCopyShaped}).
 * Search engines index the page, never the copy, so the crawl reads the copy's answer as the page's
 * own: one URL of the crawl's budget per page, never a redirect plus a copy. Any other redirect is
 * left as it answered.
 *
 * @param pageKey - The page fetched.
 * @param resource - What answered; rewritten in place to a 2xx answer at the page's own URL when it was a copy.
 * @param body - The copy's body, or null.
 */
async function readMobileCopyAsPage(
	pageKey: string,
	resource: SeoReadResource,
	body: Uint8Array | null
): Promise<void> {
	const first = resource.chain[0];
	if (body === null || first === undefined || !mobileCopyShaped(pageKey, resource)) return;
	const served = await decodeServedBody(body, resource.contentType, seoCrawlerLimits.maxPageBytes);
	const copy = extractPage(cutDeepMarkup(withoutNul(served)), resource.finalUrl);
	if (!canonicalNamesPage(copy, pageKey)) return;
	resource.status = resource.finalStatus;
	resource.finalUrl = first.url;
	resource.chain = [{ url: first.url, status: resource.finalStatus }];
}

/**
 * READS ONE PAGE: one fetch through the guarded transport (redirects followed hop by hop, the body
 * capped; a server error asked for once more after the polite pause, {@link RETRIED_SERVER_ERRORS};
 * a platform's mobile copy read as the page itself, {@link readMobileCopyAsPage}),
 * the extractor's read of it when it is a page, and - when a browser is at hand - the same
 * extractor's read of the page as the browser rendered that very HTML. With a browser at hand the page
 * is asked for with the browser's own User-Agent (`renderedDocumentUserAgent`).
 *
 * @param pageKey - The page (a normalized key; fetched over https).
 * @param userAgent - The User-Agent.
 * @param deps - The transport, the clock, the browser and (on the server) the per-host pace its
 *   requests to the site's own host share with every crawl of it.
 * @param options - The robots.txt the browser obeys and a hook before it renders.
 * @returns The reading.
 */
export async function readSitePage(
	pageKey: string,
	userAgent: string,
	deps: Pick<SeoReadDeps, "fetch" | "now" | "render"> &
		Partial<Pick<SeoReadDeps, "sleep" | "hostGate" | "siteHeaders">>,
	options: SeoReadPageOptions = {}
): Promise<SeoPageReading> {
	const device = options.device ?? "mobile";
	const documentAgent =
		deps.render === undefined ? userAgent : renderedDocumentUserAgent(userAgent, device);
	const fetchPage = (): Promise<FetchedResource> =>
		fetchResource(`https://${pageKey}`, {
			fetcher: deps.fetch,
			userAgent: documentAgent,
			accept: SEO_ACCEPT_HTML,
			maxBytes: seoCrawlerLimits.maxPageBytes,
			timeoutMs: seoCrawlerLimits.timeoutMs,
			maxRedirects: seoCrawlerLimits.maxRedirects,
			now: deps.now
		});
	let fetched = await fetchPage();
	if (
		fetched.error === null &&
		RETRIED_SERVER_ERRORS.has(fetched.finalStatus) &&
		deps.sleep !== undefined
	) {
		await paceRequest(
			{ now: deps.now, sleep: deps.sleep, hostGate: deps.hostGate },
			fetched.finalUrl,
			seoCrawlerLimits.minDelayMs
		);
		fetched = await fetchPage();
	}
	const resource: SeoReadResource = {
		finalUrl: fetched.finalUrl,
		status: fetched.status,
		finalStatus: fetched.finalStatus,
		chain: fetched.chain,
		contentType: fetched.contentType,
		xRobotsTag: fetched.xRobotsTag,
		auditHeaders: fetched.auditHeaders,
		sizeBytes: fetched.sizeBytes,
		responseMs: fetched.responseMs,
		error: fetched.error,
		...(fetched.retryAfter == null ? {} : { retryAfter: fetched.retryAfter })
	};
	await readMobileCopyAsPage(pageKey, resource, fetched.body);
	if (
		fetched.error === null &&
		fetched.finalStatus === 403 &&
		documentAgent !== userAgent &&
		(await answersPlainAgent(`https://${pageKey}`, userAgent, deps))
	)
		resource.botAgentRefused = true;
	if (htmlUnlabelled(pageKey, resource, fetched.body)) resource.htmlUnlabelled = true;
	let page: ExtractedPage | null = null;
	let rendered: SeoRenderedReading | null = null;
	let checks: SeoPageCheckFacts | null = null;
	let screenshot: string | null = null;
	let kept: { raw: string; rendered: string | null } | null = null;
	let scriptResults: SeoPageScriptResult[] | null = null;
	if (fetched.body !== null && readsAsPage(pageKey, resource)) {
		const served = await decodeServedBody(
			fetched.body,
			resource.contentType,
			seoCrawlerLimits.maxPageBytes
		);
		const body = withoutNul(served);
		const html = cutDeepMarkup(body);
		let whole = extractPage(html, resource.finalUrl);
		const readAt = slashSpellingOf(pageKey, resource, boundPage(whole));
		if (readAt !== resource.finalUrl) whole = extractPage(html, readAt);
		const cut = htmlCutOf(body, whole, readAt);
		if (cut !== null) resource.htmlCut = cut;
		page = boundPage(whole);
		let renderedHtml: string | null = null;
		let keptRendered: string | null = null;
		if (deps.render !== undefined && !page.botWall) {
			options.onRender?.();
			const request: SeoRenderRequest = {
				url: readAt,
				html: served,
				status: resource.finalStatus,
				contentSecurityPolicy: resource.auditHeaders.contentSecurityPolicy,
				userAgent: documentAgent,
				allowResource: renderResourceChecks(
					resource.finalUrl,
					options.robots ?? null,
					options.extraRobots ?? null
				),
				...renderPace(resource.finalUrl, deps),
				...(deps.siteHeaders === undefined ? {} : { siteHeaders: deps.siteHeaders }),
				...((options.renderWaitMs ?? 0) > 0 ? { waitMs: options.renderWaitMs } : {})
			};
			const render = storableRender(
				await deps.render({
					...request,
					accessibility: options.accessibility ?? null,
					...(device === "desktop" ? { device, probe: true } : {}),
					...(options.screenshot === true ? { screenshot: true } : {}),
					...(options.scripts !== undefined && options.scripts.length > 0
						? { scripts: options.scripts }
						: {})
				})
			);
			rendered = renderedReadingOf(pageKey, render);
			keptRendered = render.html;
			renderedHtml = render.html === null ? null : cutDeepMarkup(render.html);
			screenshot = render.screenshot ?? null;
			if (options.desktopRender === true && device === "mobile" && rendered.outcome !== "failed") {
				const desktop = storableRender(
					await deps.render({
						...request,
						userAgent,
						device: "desktop",
						probe: false
					})
				);
				rendered = { ...rendered, desktop: desktopViewOf(pageKey, desktop) };
			}
			if (render.scripts != null) scriptResults = render.scripts;
		}
		if (!page.botWall) checks = await pageChecksOf(page, html, rendered, renderedHtml, options);
		if (scriptResults !== null && !page.botWall)
			checks = { ...(checks ?? {}), scripts: scriptResults };
		if (options.keepHtml === true) kept = { raw: body, rendered: keptRendered };
	}
	return {
		pageKey,
		resource,
		page,
		rendered,
		...(checks === null ? {} : { checks }),
		...(options.screenshot === true ? { screenshot } : {}),
		...(options.keepHtml === true ? { html: kept } : {})
	};
}

/**
 * A string cut to a bound.
 *
 * @param value - The string.
 * @param max - The most characters kept.
 * @returns The string, cut.
 */
function cut(value: string, max: number = SEO_READING_LIMITS.textChars): string {
	return value.length > max ? value.slice(0, max) : value;
}

/**
 * A nullable string cut to a bound.
 *
 * @param value - The string, or null.
 * @returns The string, cut, or null.
 */
function cutNullable(value: string | null): string | null {
	return value === null ? null : cut(value);
}

/**
 * A plan reading cut to {@link SEO_READING_LIMITS}: a sitemap URL too long to be a page is left out,
 * as the server's own crawl would never fetch it.
 *
 * @param reading - The plan reading.
 * @returns The bounded reading.
 */
export function boundPlanReading(reading: SeoSitePlanReading): SeoSitePlanReading {
	const limits = SEO_READING_LIMITS;
	return {
		robotsTxt: reading.robotsTxt === null ? null : cut(reading.robotsTxt, limits.robotsChars),
		sitemap: {
			read: reading.sitemap.read,
			urls: reading.sitemap.urls
				.filter((url) => url.length <= limits.sitemapUrlChars)
				.slice(0, limits.sitemapUrls),
			files: reading.sitemap.files.slice(0, limits.sitemapFiles).map((file) => ({
				...file,
				url: cut(file.url),
				...(file.outOfScope === undefined
					? {}
					: {
							outOfScope: {
								count: file.outOfScope.count,
								examples: file.outOfScope.examples.slice(0, SITEMAP_EXAMPLES).map((url) => cut(url))
							}
						}),
				...(file.lastmodInvalid === undefined
					? {}
					: {
							lastmodInvalid: {
								count: file.lastmodInvalid.count,
								examples: file.lastmodInvalid.examples
									.slice(0, SITEMAP_EXAMPLES)
									.map((value) => cut(value))
							}
						}),
				...(file.hreflang === undefined
					? {}
					: { hreflang: { ...file.hreflang, examples: file.hreflang.examples.map(cut) } })
			}))
		},
		soft404:
			reading.soft404 === null
				? null
				: {
						...reading.soft404,
						url: cut(reading.soft404.url),
						landedOn: cutNullable(reading.soft404.landedOn)
					},
		...(reading.robotsFetch === undefined
			? {}
			: {
					robotsFetch:
						reading.robotsFetch === null
							? null
							: { status: reading.robotsFetch.status, outcome: reading.robotsFetch.outcome }
				}),
		...(reading.agentFiles == null ? {} : { agentFiles: reading.agentFiles })
	};
}

/**
 * A reading cut to {@link SEO_READING_LIMITS}, so it can be carried to the server whole. A page
 * within the limits (every real page) comes back unchanged.
 *
 * @param reading - The reading.
 * @returns The bounded reading.
 */
export function boundReading(reading: SeoPageReading): SeoPageReading {
	const limits = SEO_READING_LIMITS;
	const { resource } = reading;
	const bounded: SeoReadResource = {
		...resource,
		finalUrl: cut(resource.finalUrl),
		chain: resource.chain
			.slice(0, limits.chainHops)
			.map((hop) =>
				hop.location === undefined
					? { url: cut(hop.url), status: hop.status }
					: { url: cut(hop.url), status: hop.status, location: cut(hop.location) }
			),
		contentType: cutNullable(resource.contentType),
		xRobotsTag: cutNullable(resource.xRobotsTag),
		...(resource.retryAfter == null ? {} : { retryAfter: cut(resource.retryAfter) }),
		...(resource.htmlUnlabelled === true ? { htmlUnlabelled: true } : {}),
		...(resource.htmlCut === undefined ? {} : { htmlCut: resource.htmlCut }),
		auditHeaders: {
			strictTransportSecurity: cutNullable(resource.auditHeaders.strictTransportSecurity),
			contentSecurityPolicy: cutNullable(resource.auditHeaders.contentSecurityPolicy),
			xContentTypeOptions: cutNullable(resource.auditHeaders.xContentTypeOptions),
			xFrameOptions: cutNullable(resource.auditHeaders.xFrameOptions),
			referrerPolicy: cutNullable(resource.auditHeaders.referrerPolicy),
			link: cutNullable(resource.auditHeaders.link),
			...optionalAuditHeaders(resource.auditHeaders, limits.textChars)
		}
	};
	const rendered = reading.rendered ?? null;
	return {
		pageKey: reading.pageKey,
		resource: bounded,
		page: reading.page === null ? null : boundPage(reading.page),
		rendered:
			rendered === null
				? null
				: {
						...rendered,
						error: cutNullable(rendered.error),
						finalUrl: cut(rendered.finalUrl),
						page: rendered.page === null ? null : boundPage(rendered.page),
						consoleErrors: rendered.consoleErrors
							.slice(0, limits.renderConsoleLines)
							.map((line) => cut(line, limits.renderConsoleChars)),
						failedResources: rendered.failedResources
							.slice(0, limits.renderFailures)
							.map((failure) => ({ ...failure, url: cut(failure.url) }))
					},
		...(reading.checks == null ? {} : { checks: reading.checks })
	};
}

/**
 * An extracted page cut to {@link SEO_READING_LIMITS}: every page read, on the server or a member's
 * computer, is cut the same way before anything reads it, so a hostile page (a title of megabytes, a
 * hundred thousand links) costs what the bounds allow on both and both store the same facts.
 *
 * @param page - The page.
 * @returns The bounded page.
 */
function boundPage(page: ExtractedPage): ExtractedPage {
	const limits = SEO_READING_LIMITS;
	let jsonLdLeft = limits.jsonLdChars;
	const jsonLd = page.audit.jsonLd.slice(0, limits.jsonLdBlocks).map((block) => {
		const kept = block.slice(0, Math.max(0, jsonLdLeft));
		jsonLdLeft -= kept.length;
		return kept;
	});
	return {
		...page,
		title: cut(page.title),
		metaDescription: cut(page.metaDescription),
		h1: cut(page.h1),
		canonical: cut(page.canonical),
		metaRobots: cut(page.metaRobots),
		lang: cut(page.lang),
		viewport: cut(page.viewport),
		schemaTypes: page.schemaTypes.slice(0, limits.schemaTypes).map((type) => cut(type)),
		hreflang: page.hreflang
			.slice(0, limits.hreflang)
			.map((entry) => ({ lang: cut(entry.lang), url: cut(entry.url) })),
		links: page.links.slice(0, limits.links).map((link) => ({
			...link,
			href: cut(link.href),
			anchor: cut(link.anchor)
		})),
		mainText: cut(page.mainText, limits.mainTextChars),
		audit: {
			...page.audit,
			canonicals: page.audit.canonicals.slice(0, limits.listItems).map((url) => cut(url)),
			jsonLd,
			mixedActive: page.audit.mixedActive.slice(0, limits.listItems).map((url) => cut(url)),
			mixedPassive: page.audit.mixedPassive.slice(0, limits.listItems).map((url) => cut(url)),
			unsizedImages: page.audit.unsizedImages.slice(0, limits.listItems).map((url) => cut(url)),
			lazyHero:
				page.audit.lazyHero === null
					? null
					: { src: cut(page.audit.lazyHero.src), method: page.audit.lazyHero.method }
		}
	};
}
