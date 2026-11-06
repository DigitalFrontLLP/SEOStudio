import { seoCrawlerLimits } from "./config";
import type { SeoHostProbe, SeoHostProbes, SeoHreflangProbe, SeoPageHreflang } from "./facts";
import { normalizePageUrl } from "./urls";

import { linkHeaderCanonical, linkHeaderHreflang } from "./audit-facts";
import { hostGateKey } from "./host-gate";
import { crawlerRobots, paceRequest, politeDelay, SEO_ACCEPT_HTML } from "./reading";
import type { SeoReadDeps } from "./reading";
import { SEO_READING_LIMITS } from "./reading-limits";
import { robotsAllows } from "./robots";
import { isInternalUrl, siteScope } from "./scope";
import type { SiteScope } from "./scope";
import type { SeoHttpProbe } from "./types";

/**
 * THE HOST VARIANT READS of a plan, the server's own: the home page over http and https on the site's
 * host and its `www.` twin, and a few crawled pages over plain http, each asked ONCE and never
 * followed - only its status and `Location` are kept, and the canonical an https version that answers a
 * page names (so a `www.` twin that answers with a canonical to the main address is told apart from
 * a true duplicate). Plain http goes through the guarded plain-http
 * read (`safePlainHttpGet`: the same address guard, GET only, no body read); https through the crawl's
 * own guarded transport. robots.txt and the site's pace are obeyed. No database: the host's crawl hands the
 * pages to sample and stores what came back on the crawl state.
 *
 * THE CROSS-DOMAIN HREFLANG READS ({@link readHreflangReturns}): the language versions the site's own
 * pages name on OTHER domains are never crawled, so whether they name the site's page back would never
 * be known. A plan reads a few of them - one page on each such domain, at most
 * {@link SEO_HREFLANG_DOMAINS} domains, each after that domain's robots.txt (so at most twice that many
 * requests) - through the guarded transport and the shared host gate, and keeps the alternates each
 * names. Only domains the site's own hreflang names are ever asked.
 */

/** The most other domains a plan reads one hreflang alternate on (each costs its robots.txt and one page). */
export const SEO_HREFLANG_DOMAINS = 10;

/** The crawled pages with hreflang a plan looks through for alternates on other domains. */
export const SEO_HREFLANG_SAMPLE_PAGES = 20;

/** The most crawled pages asked over plain http per plan. */
export const SEO_HTTP_SAMPLE_PAGES = 5;

/** What the reads reach outside themselves. */
export type SeoHostProbeDeps = Pick<SeoReadDeps, "fetch" | "now" | "sleep" | "hostGate"> & {
	httpProbe: SeoHttpProbe;
};

/** What the reads are told about the site. */
export interface SeoHostProbeInput {
	/** The project's website. */
	siteUrl: string;
	userAgent: string;
	/** The robots.txt the crawl obeys. */
	robotsTxt: string;
	/** The robots.txt group the crawl obeys. */
	robotsAgent?: string;
	/** Page keys of crawled pages that answered 200, the home page left out. */
	samplePageKeys: readonly string[];
}

/**
 * The home page's four host variants, or null when the site's host is an address or carries a port
 * (its variants are not meaningful there).
 *
 * @param siteUrl - The project's website.
 * @returns The URLs, https first.
 */
export function hostVariantUrls(siteUrl: string): string[] | null {
	const scope = siteScope(siteUrl);
	if (scope === null || new URL(scope.origin).port !== "") return null;
	if (/^[\d.]+$/.test(scope.host) || scope.host.includes(":") || !scope.host.includes("."))
		return null;
	const bare = scope.host.replace(/^www\./, "");
	const hosts = [bare, `www.${bare}`];
	return ["https", "http"].flatMap((scheme) => hosts.map((host) => `${scheme}://${host}/`));
}

/**
 * Names why a read got no answer.
 *
 * @param error - What the transport threw.
 * @returns The failure kind.
 */
function probeFailure(error: unknown): NonNullable<SeoHostProbe["error"]> {
	if (error instanceof Error) {
		if (error.name === "BlockedUrlError") {
			return "reason" in error && error.reason === "not_found" ? "unresolved" : "blocked";
		}
		if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
	}
	return "network";
}

/**
 * A `Location` header made absolute against the URL that sent it, cut to the reading's bound.
 *
 * @param location - The header, or null.
 * @param base - The URL asked.
 * @returns The absolute URL, or null.
 */
function absoluteLocation(location: string | null, base: string): string | null {
	if (location === null) return null;
	try {
		return new URL(location, base).href.slice(0, SEO_READING_LIMITS.textChars);
	} catch {
		return null;
	}
}

/** The most bytes of a version's HTML read for its canonical tag (the head comes first). */
export const SEO_HOST_PROBE_HEAD_BYTES = 64 * 1024;

/** The most bytes of an alternate's HTML read for its hreflang tags (a long head carries many). */
const HREFLANG_HEAD_BYTES = 256 * 1024;

/** The most bytes of another domain's robots.txt read. */
const ROBOTS_BYTES = 512 * 1024;

/** A `<link>` tag, and the `rel`, `href` and `hreflang` inside one. */
const LINK_TAG = /<link\s[^>]*>/gi;
const REL = /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HREFLANG = /\shreflang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * The first part of an answer's body as text, read up to a bound and then let go.
 *
 * @param response - The answer.
 * @param maxBytes - The most bytes read.
 * @returns The text.
 */
async function headText(response: Response, maxBytes: number): Promise<string> {
	const reader = response.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let read = 0;
	try {
		while (read < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			read += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(read);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

/**
 * An attribute's value from a tag, as one of the three quoting forms matched it.
 *
 * @param pattern - The attribute's pattern.
 * @param tag - The tag.
 * @returns The value, trimmed ("" when absent).
 */
function attribute(pattern: RegExp, tag: string): string {
	const match = pattern.exec(tag);
	return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

/**
 * The canonical the first part of an answer's HTML names, read up to
 * {@link SEO_HOST_PROBE_HEAD_BYTES} and then let go.
 *
 * @param response - The answer.
 * @param url - The URL asked.
 * @returns The canonical, resolved, or null.
 */
async function headCanonical(response: Response, url: string): Promise<string | null> {
	const html = await headText(response, SEO_HOST_PROBE_HEAD_BYTES);
	for (const [tag] of html.matchAll(LINK_TAG)) {
		const rel = REL.exec(tag);
		const words = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? "").toLowerCase().split(/\s+/);
		if (!words.includes("canonical")) continue;
		const href = HREF.exec(tag);
		const value = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
		return value === "" ? null : absoluteLocation(value, url);
	}
	return null;
}

/**
 * Asks one URL once, never following it. A version that answers a page over https is read for the
 * canonical it names (its `Link` header, else the first part of its HTML); over plain http only the
 * status is read.
 *
 * @param url - The URL.
 * @param userAgent - The User-Agent.
 * @param deps - The guarded transports.
 * @returns What it answered.
 */
async function probeOnce(
	url: string,
	userAgent: string,
	deps: SeoHostProbeDeps
): Promise<SeoHostProbe> {
	const headers = { "User-Agent": userAgent, Accept: SEO_ACCEPT_HTML };
	try {
		let answer: { status: number; location: string | null; canonical?: string | null };
		if (url.startsWith("http:")) {
			answer = await deps.httpProbe(url, headers, seoCrawlerLimits.timeoutMs);
		} else {
			const response = await deps.fetch(
				url,
				{ method: "GET", headers },
				seoCrawlerLimits.timeoutMs
			);
			const page = response.status >= 200 && response.status < 300;
			const linked = page ? linkHeaderCanonical(response.headers.get("link"), url) : null;
			let canonical: string | null | undefined;
			if (page) canonical = linked ?? (await headCanonical(response, url).catch(() => null));
			else await response.body?.cancel().catch(() => undefined);
			if (page && linked !== null) await response.body?.cancel().catch(() => undefined);
			answer = {
				status: response.status,
				location: response.headers.get("location"),
				...(canonical === undefined ? {} : { canonical })
			};
		}
		return {
			url,
			status: answer.status,
			location: absoluteLocation(answer.location, url),
			error: null,
			...(answer.canonical === undefined ? {} : { canonical: answer.canonical })
		};
	} catch (error) {
		return { url, status: null, location: null, error: probeFailure(error) };
	}
}

/**
 * READS THE HOST VARIANTS of a site and a few of its pages over plain http, one request each at the
 * site's pace. The pages are asked only when the site answered over plain http at all, so a host that
 * does not serve http costs no more than its home page.
 *
 * @param input - The site, its robots.txt and the pages to sample.
 * @param deps - The guarded transports, the clock and the pause.
 * @returns The reads, or null when the site has no meaningful variants.
 */
export async function readHostProbes(
	input: SeoHostProbeInput,
	deps: SeoHostProbeDeps
): Promise<SeoHostProbes | null> {
	const urls = hostVariantUrls(input.siteUrl);
	if (urls === null) return null;
	const robots = crawlerRobots(input.robotsTxt, input.robotsAgent);
	const delayMs = politeDelay(robots);
	const allowed = (url: string): boolean => {
		try {
			const secure = new URL(url);
			secure.protocol = "https:";
			return robotsAllows(robots, secure.href);
		} catch {
			return false;
		}
	};
	const variants: SeoHostProbe[] = [];
	for (const url of urls) {
		if (!allowed(url)) continue;
		await paceRequest(deps, url, delayMs);
		variants.push(await probeOnce(url, input.userAgent, deps));
	}
	const servesHttp = variants.some(
		(probe) => probe.url.startsWith("http:") && probe.status !== null
	);
	const pages: SeoHostProbes["pages"] = [];
	for (const pageKey of servesHttp ? input.samplePageKeys.slice(0, SEO_HTTP_SAMPLE_PAGES) : []) {
		const url = `http://${pageKey}`;
		if (!allowed(url)) continue;
		await paceRequest(deps, url, delayMs);
		pages.push({ pageKey, ...(await probeOnce(url, input.userAgent, deps)) });
	}
	return { checkedAt: deps.now().toISOString(), variants, pages };
}

/** What the cross-domain hreflang reads are told: the site and a few of its pages with alternates. */
export interface SeoHreflangProbeInput {
	/** The site the crawl covers: an alternate outside it is on another domain. */
	scope: SiteScope;
	userAgent: string;
	/** The robots.txt group the crawl obeys, on every domain. */
	robotsAgent?: string;
	/** Crawled pages and the alternates each names, the pages nearest the home page first. */
	pages: readonly { pageKey: string; alternates: readonly SeoPageHreflang[] }[];
}

/**
 * The alternates to read: one per other domain, from the pages in order, at most
 * {@link SEO_HREFLANG_DOMAINS}. Only https URLs outside the site are taken.
 *
 * @param input - The site and its pages.
 * @returns The URLs and their keys.
 */
function hreflangTargets(input: SeoHreflangProbeInput): { url: string; key: string }[] {
	const byDomain = new Map<string, { url: string; key: string }>();
	for (const page of input.pages) {
		for (const alternate of page.alternates) {
			if (byDomain.size >= SEO_HREFLANG_DOMAINS) return [...byDomain.values()];
			const url = alternate.url.trim();
			if (!/^https:\/\//i.test(url) || isInternalUrl(input.scope, url)) continue;
			const key = normalizePageUrl(url);
			if (key === null) continue;
			const domain = hostGateKey(new URL(url).hostname);
			if (!byDomain.has(domain)) byDomain.set(domain, { url, key });
		}
	}
	return [...byDomain.values()];
}

/**
 * The page keys an answer's hreflang names: its `Link` header's and its HTML head's alternates.
 *
 * @param response - The answer (2xx HTML).
 * @param url - The URL asked.
 * @returns The keys, at most the reading's hreflang bound.
 */
async function namedAlternates(response: Response, url: string): Promise<string[]> {
	const urls = linkHeaderHreflang(response.headers.get("link"), url).map((entry) => entry.url);
	const html = await headText(response, HREFLANG_HEAD_BYTES);
	for (const [tag] of html.matchAll(LINK_TAG)) {
		const rel = attribute(REL, tag).toLowerCase().split(/\s+/);
		if (!rel.includes("alternate") || attribute(HREFLANG, tag) === "") continue;
		const href = attribute(HREF, tag);
		if (href !== "") urls.push(absoluteLocation(href, url) ?? href);
	}
	const keys = new Set<string>();
	for (const named of urls) {
		const key = normalizePageUrl(named);
		if (key !== null) keys.add(key);
		if (keys.size >= SEO_READING_LIMITS.hreflang) break;
	}
	return [...keys];
}

/**
 * Reads one alternate on another domain: that domain's robots.txt first, then the page, once and never
 * followed, each through the shared host gate at the crawler's pace.
 *
 * @param target - The alternate.
 * @param input - The site's crawl identity.
 * @param deps - The guarded transport, the clock, the pause and the gate.
 * @returns What it answered and the alternates it names.
 */
async function readHreflangTarget(
	target: { url: string; key: string },
	input: SeoHreflangProbeInput,
	deps: Pick<SeoReadDeps, "fetch" | "now" | "sleep" | "hostGate">
): Promise<SeoHreflangProbe> {
	const unread: SeoHreflangProbe = { ...target, status: null, names: null };
	const delayMs = seoCrawlerLimits.minDelayMs;
	const headers = { "User-Agent": input.userAgent };
	try {
		const robotsUrl = new URL("/robots.txt", target.url).href;
		await paceRequest(deps, robotsUrl, delayMs, true);
		const robots = await deps.fetch(
			robotsUrl,
			{ method: "GET", headers: { ...headers, Accept: "text/plain" } },
			seoCrawlerLimits.timeoutMs
		);
		const text =
			robots.status >= 200 && robots.status < 300 ? await headText(robots, ROBOTS_BYTES) : "";
		if (robots.status < 200 || robots.status >= 300)
			await robots.body?.cancel().catch(() => undefined);
		if (robots.status >= 500 || robots.status === 429) return unread;
		if (!robotsAllows(crawlerRobots(text, input.robotsAgent), target.url)) return unread;
		await paceRequest(deps, target.url, delayMs);
		const page = await deps.fetch(
			target.url,
			{ method: "GET", headers: { ...headers, Accept: SEO_ACCEPT_HTML } },
			seoCrawlerLimits.timeoutMs
		);
		const html = /html/i.test(page.headers.get("content-type") ?? "");
		if (page.status < 200 || page.status >= 300 || !html) {
			await page.body?.cancel().catch(() => undefined);
			return { ...target, status: page.status, names: null };
		}
		return { ...target, status: page.status, names: await namedAlternates(page, target.url) };
	} catch {
		return unread;
	}
}

/**
 * READS A FEW HREFLANG ALTERNATES ON OTHER DOMAINS: one page on each of at most
 * {@link SEO_HREFLANG_DOMAINS} domains the site's pages name as language versions (the pages nearest
 * the home page first), each domain's robots.txt obeyed, all through the guarded transport and the
 * shared host gate; the domains are read side by side, each one request at a time.
 *
 * @param input - The site and its pages with alternates.
 * @param deps - The guarded transport, the clock, the pause and the gate.
 * @returns What each alternate answered and names; empty when the site names none elsewhere.
 */
export async function readHreflangReturns(
	input: SeoHreflangProbeInput,
	deps: Pick<SeoReadDeps, "fetch" | "now" | "sleep" | "hostGate">
): Promise<SeoHreflangProbe[]> {
	return Promise.all(
		hreflangTargets(input).map((target) => readHreflangTarget(target, input, deps))
	);
}
