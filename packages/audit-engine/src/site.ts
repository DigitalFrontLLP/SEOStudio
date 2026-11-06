import { auditSiteWithResources } from "./audit";
import { scorePagesOf, summarizeAudit } from "./audit-summary";
import { isSeoAuditCrawlFact, SEO_AUDIT_RULES, SEO_AUDIT_SEVERITIES } from "./catalog";
import { SEO_CRAWLER_ROBOTS_AGENT, seoCrawlerUserAgent } from "./config";
import {
	clickDepths,
	compileUrlRules,
	crawlKeyOf,
	crawlSettingsOf,
	crawlTrapOf,
	isSignOutUrl,
	linkGraphCoverage,
	urlInScope
} from "./discovery";
import type { SeoHostProbes, SeoPageHreflang } from "./facts";
import { createGuardedFetch } from "./guard";
import { memoryHostGate } from "./host-gate";
import {
	readHostProbes,
	readHreflangReturns,
	SEO_HREFLANG_SAMPLE_PAGES,
	SEO_HTTP_SAMPLE_PAGES
} from "./host-probe";
import { linkScores } from "./link-score";
import { ASSET_PATH, readLinks, readReferences, refreshTargetOf, scriptTargetOf } from "./links";
import type { DiscoveredTarget, SeoLinkContext, StoredLink } from "./links";
import { auditPageOfReading } from "./page";
import {
	boundReading,
	crawlerRobots,
	paceRequest,
	politeDelay,
	readsAsPage,
	readSitePage,
	readSitePlan,
	readVerdict,
	robotsFetchFacts
} from "./reading";
import type { SeoPageReading, SeoReadDeps, SeoReadPageOptions } from "./reading";
import { primaryRead } from "./render-facts";
import { AUDIT_REPORT_SCHEMA_VERSION } from "./report";
import type { AuditReport, AuditReportIssue, AuditReportPage, AuditReportSeverity } from "./report";
import { readResources } from "./resource-check";
import type { SeoResourceCheckTarget, SeoResourceReading } from "./resource-check";
import {
	isOutboundLink,
	linkSpellingToCheck,
	outboundFailure,
	pageResourceRefs,
	SEO_LINK_SPELLINGS_PER_SITE
} from "./resources";
import { directivesNofollow, robotsAllows } from "./robots";
import type { CompiledRobots } from "./robots";
import { SEO_BOT_AGENT_REFUSED } from "./rules/page-state";
import type {
	AuditFinding,
	AuditLink,
	AuditLinkSpelling,
	AuditOutlink,
	AuditPage,
	AuditResource,
	AuditSite
} from "./rules/types";
import { isInternalHost, isPlatformPath, keyInScope, siteScope } from "./scope";
import type { SiteScope } from "./scope";
import { pageTemplates } from "./templates";
import type { SeoCrawlFetcher, SeoHttpProbe, SeoPageRenderer } from "./types";
import { normalizePageUrl } from "./urls";

/**
 * THE STANDALONE CRAWL: a whole site crawled in this process with the same reading, discovery and
 * rules the SEOStudio app uses, held in memory instead of a database, and judged by every rule that
 * needs no paid data. And one page's reading, for a client that fetches from its own address.
 *
 * What it leaves out, because it needs an account or the app's history: Search Console, Analytics,
 * lab tests and CrUX data (their rules stay quiet), the TLS read of the site's host, the members'
 * custom checks and AI prompts, and a page's change history. A one-off crawl confirms an outbound
 * link as gone by asking it twice; a server error on another site is never confirmed within one run
 * (an outage passes).
 */

/** Where a standalone crawl stands, as {@link CrawlSiteOptions.onProgress} is told. */
export interface CrawlSiteProgress {
	/** `plan`: robots.txt and the sitemaps; `pages`: the pages; `resources`: what they load; `audit`: the rules. */
	phase: "plan" | "pages" | "resources" | "audit" | "done";
	/** Pages read so far. */
	pagesRead: number;
	/** Pages found so far, read or not (never more than the page cap). */
	pagesFound: number;
	/** The URL being read, or null between two reads. */
	currentUrl: string | null;
}

/** How a standalone crawl runs. */
export interface CrawlSiteOptions {
	/** The site's start URL, e.g. `https://example.com/`. */
	url: string;
	/** The most pages known to the crawl, read or not; 500 by default. */
	maxPages?: number;
	/** Pages read at once; 2 by default. Each host is still asked at its polite pace. */
	concurrency?: number;
	/** The User-Agent every request sends; the crawler's own by default. */
	userAgent?: string;
	/** Told whenever the crawl moves on. */
	onProgress?: (progress: CrawlSiteProgress) => void;
	/**
	 * The host names (lower-cased) whose private or local addresses the crawl may reach: a staging site
	 * on the local network or on this machine, named one by one. Every other request, each redirect hop
	 * included, is refused when its host resolves to a private, local or reserved address
	 * (`guardedFetch`), so a link from the staging site to another private address is still refused.
	 */
	allowPrivateHosts?: ReadonlySet<string>;
	/**
	 * The transport every request goes through, in place of the address guard (redirects are followed
	 * hop by hop, so it must not follow them itself). Tests pass a fake site.
	 */
	fetch?: SeoCrawlFetcher;
	/** A browser to render each page in; without one every page is judged on its raw HTML. */
	render?: SeoPageRenderer;
	/** The clock; the wall clock by default. */
	now?: () => Date;
	/** The pause between requests; a real one by default. */
	sleep?: (ms: number) => Promise<void>;
}

/** One page's reading, the shape a server accepts from a client that fetched the page itself. */
export type PageReading = SeoPageReading;

/** How one page is read. */
export interface ReadPageOptions extends SeoReadPageOptions {
	/** The User-Agent the request sends; the crawler's own by default. */
	userAgent?: string;
	/** The host names (lower-cased) whose private or local addresses may be reached; none by default. */
	allowPrivateHosts?: ReadonlySet<string>;
	/** The transport, in place of the address guard (redirects followed hop by hop). */
	fetch?: SeoCrawlFetcher;
	/** A browser to render the page in; without one the reading is raw only. */
	render?: SeoPageRenderer;
	/** The clock; the wall clock by default. */
	now?: () => Date;
	/** The pause before a retried request; a real one by default. */
	sleep?: (ms: number) => Promise<void>;
}

/** The page cap of a standalone crawl when none is given. */
const DEFAULT_MAX_PAGES = 500;

/** Pages read at once when none is given. */
const DEFAULT_CONCURRENCY = 2;

/** The base URL the crawler's own User-Agent links to for its docs page. */
const CRAWLER_DOCS_BASE = "https://seostudio.com";

/** What a host's robots.txt is taken to be when it cannot be read: everything forbidden. */
const UNREADABLE_ROBOTS = "User-agent: *\nDisallow: /";

/**
 * A plain-http status read over a transport (the address guard by default): one GET, never followed,
 * its body left unread.
 *
 * @param transport - The transport.
 * @returns The probe.
 */
function httpProbeOver(transport: SeoCrawlFetcher): SeoHttpProbe {
	return async (url, headers, timeoutMs) => {
		const response = await transport(url, { method: "GET", headers }, timeoutMs);
		await response.body?.cancel().catch(() => undefined);
		return { status: response.status, location: response.headers.get("location") };
	};
}

/** The crawler's own User-Agent, linking to its docs page. */
function defaultUserAgent(): string {
	return seoCrawlerUserAgent(CRAWLER_DOCS_BASE);
}

/**
 * READS ONE PAGE as the SEOStudio desktop app does: the fetch (redirects followed hop by hop, a server
 * error asked again once), the extractor's read of its HTML, and the rendered read when a browser is
 * lent. The reading is cut to the bounds a server accepts, so a client can send it as it is.
 *
 * @param url - The page's URL.
 * @param options - How it is read.
 * @returns The reading.
 * @throws When the URL names no http(s) page.
 */
export async function readPage(url: string, options: ReadPageOptions = {}): Promise<PageReading> {
	const pageKey = normalizePageUrl(url);
	if (pageKey === null) throw new Error(`Not a page URL: ${url}`);
	const {
		userAgent,
		allowPrivateHosts,
		fetch: transport,
		render,
		now,
		sleep,
		...readOptions
	} = options;
	const reading = await readSitePage(
		pageKey,
		userAgent ?? defaultUserAgent(),
		{
			fetch: transport ?? createGuardedFetch({ allowPrivateHosts }),
			now: now ?? (() => new Date()),
			sleep: sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
			...(render === undefined ? {} : { render })
		},
		readOptions
	);
	return boundReading(reading);
}

/** How a page came to the crawl's attention. */
type FoundBy = "home" | "sitemap" | "link" | "redirect" | "reference";

/** One page the crawl knows of. */
interface KnownPage {
	pageKey: string;
	/** The URL it is read at. */
	url: string;
	foundBy: FoundBy;
	inSitemap: boolean;
	/** Whether robots.txt keeps the crawler from it (never read). */
	blocked: boolean;
	read: boolean;
}

/** What the crawl holds of one read page. */
interface ReadPage {
	page: AuditPage;
	links: StoredLink[];
	resources: SeoResourceCheckTarget[];
	/** Whether the page asks not to follow its links. */
	unfollowed: boolean;
}

/**
 * Everything the standalone crawl holds while it runs.
 */
interface CrawlState {
	scope: SiteScope;
	context: SeoLinkContext;
	robots: CompiledRobots;
	homeKey: string;
	known: Map<string, KnownPage>;
	queue: string[];
	read: Map<string, ReadPage>;
	variants: Map<string, string>;
	maxPages: number;
	/** Whether a page was left unknown because the cap was reached. */
	capped: boolean;
}

/**
 * Whether the crawl may read a page it was pointed at: on the site, allowed by robots.txt, not a file,
 * within the URL rules, not a crawl trap, not a sign-out link nor a platform's own path.
 *
 * @param state - The crawl.
 * @param key - The page key.
 * @returns `ok`, `blocked` (robots.txt forbids it: known, never read) or `skip`.
 */
function admits(state: CrawlState, key: string): "ok" | "blocked" | "skip" {
	if (!keyInScope(state.scope, key)) return "skip";
	const path = key.slice(key.indexOf("/")).split("?")[0] ?? "";
	if (ASSET_PATH.test(path)) return "skip";
	if (!urlInScope(key, state.context.rules) || crawlTrapOf(key) !== null) return "skip";
	if (isSignOutUrl(key) || isPlatformPath(key)) return "skip";
	return robotsAllows(state.robots, `https://${key}`) ? "ok" : "blocked";
}

/**
 * Makes a page known to the crawl while the cap has room, queued for a read unless robots.txt forbids
 * it.
 *
 * @param state - The crawl.
 * @param target - The page.
 * @param foundBy - How it was found.
 */
function learn(state: CrawlState, target: DiscoveredTarget, foundBy: FoundBy): void {
	if (state.known.has(target.key)) return;
	const verdict = admits(state, target.key);
	if (verdict === "skip") return;
	if (state.known.size >= state.maxPages) {
		state.capped = true;
		return;
	}
	state.known.set(target.key, {
		pageKey: target.key,
		url: target.url,
		foundBy,
		inSitemap: false,
		blocked: verdict === "blocked",
		read: false
	});
	if (verdict === "ok") state.queue.push(target.key);
}

/**
 * The audit's page of a reading, as a crawl commits it: a bot wall or a refusal of the crawler's
 * browser User-Agent filed as such.
 *
 * @param state - The crawl.
 * @param known - The page.
 * @param reading - Its reading.
 * @param now - When it was read.
 * @returns The page.
 */
function committedPage(
	state: CrawlState,
	known: KnownPage,
	reading: SeoPageReading,
	now: Date
): AuditPage {
	const held = {
		inSitemap: known.inSitemap,
		hasTraffic: false,
		impressions: 0,
		inAnalytics: false,
		backlinked: false,
		clickDepth: null,
		linkScore: null
	};
	const page = auditPageOfReading(state.context, reading, now, held);
	const { resource } = reading;
	if (page.status === 403 && resource.botAgentRefused === true)
		return { ...page, lastError: SEO_BOT_AGENT_REFUSED };
	if (readsAsPage(known.pageKey, resource) && reading.page?.botWall === true) {
		return { ...page, lastError: "bot_wall", snapshot: null, facts: null };
	}
	return page;
}

/**
 * Keeps one page's reading and follows where it leads: its links (unless it asks not to follow them),
 * the URLs it references, a redirect, a refresh and a script redirect.
 *
 * @param state - The crawl.
 * @param known - The page.
 * @param reading - Its reading.
 * @param now - When it was read.
 */
function commit(state: CrawlState, known: KnownPage, reading: SeoPageReading, now: Date): void {
	const page = committedPage(state, known, reading, now);
	const { resource } = reading;
	const verdict = readVerdict(known.pageKey, resource);
	const raw = page.lastError === null && readsAsPage(known.pageKey, resource) ? reading.page : null;
	const rendered = raw === null ? null : reading.rendered;
	const extracted = raw === null ? null : primaryRead(raw, rendered).page;
	let links: StoredLink[] = [];
	let unfollowed = false;
	if (extracted !== null) {
		const read = readLinks(state.context, extracted);
		links = read.stored;
		unfollowed = directivesNofollow(extracted.metaRobots, resource.xRobotsTag);
		if (!unfollowed) {
			for (const target of read.internal) if (target.follow) learn(state, target, "link");
			for (const target of readReferences(
				state.context,
				[raw, rendered?.page ?? null],
				resource.auditHeaders.link,
				resource.finalUrl
			))
				learn(state, target, "reference");
		}
	}
	if (
		verdict.redirected &&
		verdict.finalKey !== null &&
		keyInScope(state.scope, verdict.finalKey)
	) {
		state.variants.set(known.pageKey, verdict.finalKey);
		learn(state, { key: verdict.finalKey, url: resource.finalUrl, follow: true }, "redirect");
	}
	if (raw !== null && !verdict.redirected) {
		const refresh = refreshTargetOf(
			state.context,
			known.pageKey,
			raw,
			resource.auditHeaders.refresh ?? null,
			resource.finalUrl
		);
		if (refresh !== null) {
			state.variants.set(known.pageKey, refresh.key);
			learn(state, refresh, "redirect");
		}
		const scripted = scriptTargetOf(state.context, known.pageKey, rendered);
		if (scripted !== null) learn(state, scripted, "redirect");
	}
	state.read.set(known.pageKey, {
		page,
		links,
		resources: extracted === null ? [] : pageResourceRefs(state.scope, extracted, rendered),
		unfollowed
	});
}

/**
 * The resource checks of the whole crawl: each URL any page references checked once (a file on the
 * site that robots.txt forbids is never fetched), an outbound link that answered gone asked once more
 * to confirm it, and the link spellings worth asking about.
 *
 * @param state - The crawl.
 * @param userAgent - The User-Agent.
 * @param deps - The transport, the clock, the pause and the host gate.
 * @param onCheck - Told each URL checked.
 * @returns Each page's resources, and what each link spelling answered.
 */
async function checkResources(
	state: CrawlState,
	userAgent: string,
	deps: Required<Pick<SeoReadDeps, "fetch" | "now" | "sleep" | "hostGate">>,
	onCheck: (url: string) => void
): Promise<{
	byPage: Map<string, AuditResource[]>;
	spellings: Map<string, AuditLinkSpelling>;
}> {
	const robotsVerdict = (url: string): boolean | null => {
		try {
			return isInternalHost(state.scope, new URL(url).hostname.toLowerCase())
				? robotsAllows(state.robots, url)
				: null;
		} catch {
			return null;
		}
	};
	const id = (target: SeoResourceCheckTarget): string => `${target.kind}\u0000${target.url}`;
	const targets = new Map<string, SeoResourceCheckTarget>();
	for (const page of state.read.values())
		for (const target of page.resources) targets.set(id(target), target);
	const spellingUrls = new Set<string>();
	for (const page of state.read.values()) {
		for (const link of page.links) {
			if (spellingUrls.size >= SEO_LINK_SPELLINGS_PER_SITE) break;
			if (link.targetKey === null) continue;
			const fetched = state.known.get(link.targetKey)?.url ?? `https://${link.targetKey}`;
			const spelled = (link.href ?? `https://${link.targetKey}`).split("#")[0] ?? "";
			if (linkSpellingToCheck(spelled, fetched)) spellingUrls.add(spelled);
		}
	}
	for (const url of spellingUrls)
		targets.set(id({ url, kind: "spelling" }), { url, kind: "spelling" });
	const asked = [...targets.values()].filter((target) => robotsVerdict(target.url) !== false);
	const options = { delayMs: politeDelay(state.robots), siteHost: state.scope.host, onCheck };
	const checkedAt = deps.now();
	const readings = new Map<string, SeoResourceReading>();
	for (const reading of await readResources(asked, userAgent, deps, options))
		readings.set(id(reading), reading);
	const gone = [...readings.values()].filter(
		(reading) => isOutboundLink(reading.kind) && outboundFailure(reading) === "gone"
	);
	const confirmed = new Set<string>();
	if (gone.length > 0) {
		for (const reading of await readResources(gone, userAgent, deps, options))
			if (outboundFailure(reading) === "gone") confirmed.add(id(reading));
	}
	const resourceOf = (target: SeoResourceCheckTarget): AuditResource => {
		const reading = readings.get(id(target));
		const robotsAllowed = robotsVerdict(target.url);
		if (reading === undefined) {
			return {
				url: target.url,
				kind: target.kind,
				robotsAllowed,
				status: null,
				finalStatus: null,
				finalUrl: null,
				contentType: null,
				sizeBytes: null,
				error: null,
				checkedAt: null
			};
		}
		const outbound = isOutboundLink(target.kind);
		const failed = outbound && outboundFailure(reading) !== null;
		return {
			url: target.url,
			kind: target.kind,
			robotsAllowed,
			status: reading.status,
			finalStatus: reading.finalStatus,
			finalUrl: reading.finalUrl,
			contentType: reading.contentType,
			sizeBytes: reading.sizeBytes,
			width: reading.width ?? null,
			height: reading.height ?? null,
			title: reading.title ?? null,
			headers: outbound ? null : (reading.delivery ?? null),
			error: reading.error,
			checkedAt: checkedAt.toISOString(),
			failCount: failed ? (confirmed.has(id(target)) ? 2 : 1) : 0,
			failingSince: failed ? checkedAt.toISOString() : null
		};
	};
	const byPage = new Map<string, AuditResource[]>();
	for (const [pageKey, page] of state.read)
		if (page.resources.length > 0) byPage.set(pageKey, page.resources.map(resourceOf));
	const spellings = new Map<string, AuditLinkSpelling>();
	for (const url of spellingUrls) {
		const reading = readings.get(id({ url, kind: "spelling" }));
		if (reading !== undefined)
			spellings.set(url, {
				status: reading.status,
				finalUrl: reading.finalUrl,
				error: reading.error
			});
	}
	return { byPage, spellings };
}

/**
 * The host variants and plain-http answers of the site, and the language versions its pages name on
 * other domains, read once the pages are known (as the app's next plan reads them).
 *
 * @param state - The crawl.
 * @param robotsTxt - The robots.txt obeyed.
 * @param userAgent - The User-Agent.
 * @param deps - The transport, the clock, the pause and the host gate.
 * @returns The reads, or null.
 */
async function readHosts(
	state: CrawlState,
	robotsTxt: string,
	userAgent: string,
	deps: Required<Pick<SeoReadDeps, "fetch" | "now" | "sleep" | "hostGate">>
): Promise<SeoHostProbes | null> {
	const ok = [...state.read.values()]
		.filter((entry) => entry.page.status === 200 && entry.page.lastError === null)
		.sort(
			(left, right) =>
				(left.page.clickDepth ?? Number.MAX_SAFE_INTEGER) -
					(right.page.clickDepth ?? Number.MAX_SAFE_INTEGER) ||
				left.page.pageKey.localeCompare(right.page.pageKey)
		);
	const samplePageKeys = ok
		.map((entry) => entry.page.pageKey)
		.filter((key) => key !== state.homeKey)
		.slice(0, SEO_HTTP_SAMPLE_PAGES);
	const hreflangPages = ok
		.map((entry) => ({
			pageKey: entry.page.pageKey,
			alternates: [
				...(entry.page.facts?.hreflang ?? []),
				...(entry.page.facts?.headers.linkHreflang ?? [])
			] as SeoPageHreflang[]
		}))
		.filter((entry) => entry.alternates.length > 0)
		.slice(0, SEO_HREFLANG_SAMPLE_PAGES);
	const [probes, hreflang] = await Promise.all([
		readHostProbes(
			{
				siteUrl: `${state.scope.origin}/`,
				userAgent,
				robotsTxt,
				robotsAgent: SEO_CRAWLER_ROBOTS_AGENT,
				samplePageKeys
			},
			{ ...deps, httpProbe: httpProbeOver(deps.fetch) }
		),
		readHreflangReturns(
			{
				scope: state.scope,
				userAgent,
				robotsAgent: SEO_CRAWLER_ROBOTS_AGENT,
				pages: hreflangPages
			},
			deps
		)
	]);
	if (hreflang.length === 0) return probes;
	return {
		...(probes ?? { checkedAt: deps.now().toISOString(), variants: [], pages: [] }),
		hreflang
	};
}

/**
 * The report's findings: every finding but the crawl facts, issues before tips, the most serious
 * first.
 *
 * @param findings - The audit's findings.
 * @returns The report's issues.
 */
function reportIssues(findings: readonly AuditFinding[]): AuditReportIssue[] {
	const issues = findings
		.filter((finding) => !isSeoAuditCrawlFact(finding.ruleId))
		.map((finding): AuditReportIssue => {
			const rule = SEO_AUDIT_RULES[finding.ruleId];
			return {
				ruleId: finding.ruleId,
				severity: finding.severity,
				category: rule.category,
				kind: rule.insight ? "tip" : "issue",
				siteWide: rule.scope === "site",
				page: `https://${finding.pageKey}`,
				pageKey: finding.pageKey,
				evidence: finding.params
			};
		});
	const rank = (issue: AuditReportIssue): number =>
		(issue.kind === "tip" ? SEO_AUDIT_SEVERITIES.length : 0) +
		SEO_AUDIT_SEVERITIES.indexOf(issue.severity);
	return issues.sort(
		(left, right) =>
			rank(left) - rank(right) ||
			left.ruleId.localeCompare(right.ruleId) ||
			left.pageKey.localeCompare(right.pageKey)
	);
}

/**
 * CRAWLS A SITE in this process and audits it: robots.txt and the sitemaps, then every page found from
 * the home page and the sitemaps (up to the cap), what the pages load and link out to, the site's host
 * variants, and every rule that needs no paid data. Polite as the app's crawler: robots.txt obeyed,
 * its `Crawl-delay` kept (one second at least between two requests to a host), a 429 or 503 retried
 * only after a pause.
 *
 * @param options - The site, the caps and the progress hook.
 * @returns The report.
 * @throws When the URL names no http(s) site.
 */
export async function crawlSite(options: CrawlSiteOptions): Promise<AuditReport> {
	const scope = siteScope(options.url);
	const homeKey = normalizePageUrl(scope === null ? "" : `${scope.origin}/`);
	if (scope === null || homeKey === null) throw new Error(`Not a site URL: ${options.url}`);
	const now = options.now ?? (() => new Date());
	const deps = {
		fetch: options.fetch ?? createGuardedFetch({ allowPrivateHosts: options.allowPrivateHosts }),
		now,
		sleep:
			options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
		hostGate: memoryHostGate()
	};
	const startedAt = now();
	const userAgent = options.userAgent ?? defaultUserAgent();
	const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
	const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
	const progress: CrawlSiteProgress = {
		phase: "plan",
		pagesRead: 0,
		pagesFound: 0,
		currentUrl: null
	};
	const tell = (next: Partial<CrawlSiteProgress>): void => {
		Object.assign(progress, next);
		options.onProgress?.({ ...progress });
	};
	tell({});

	const settings = crawlSettingsOf(null);
	const context: SeoLinkContext = { scope, rules: compileUrlRules(settings) };
	const plan = await readSitePlan(
		{
			siteUrl: `${scope.origin}/`,
			userAgent,
			verified: false,
			robotsAgent: SEO_CRAWLER_ROBOTS_AGENT,
			probeSoft404: true,
			fallbackRobotsTxt: null
		},
		deps
	);
	const robotsTxt = plan?.robotsTxt ?? null;
	const state: CrawlState = {
		scope,
		context,
		robots: crawlerRobots(robotsTxt ?? UNREADABLE_ROBOTS, SEO_CRAWLER_ROBOTS_AGENT),
		homeKey,
		known: new Map(),
		queue: [],
		read: new Map(),
		variants: new Map(),
		maxPages,
		capped: false
	};
	learn(state, { key: homeKey, url: `https://${homeKey}`, follow: true }, "home");
	const sitemapKeys = new Set<string>();
	for (const url of plan?.sitemap.urls ?? []) {
		const key = crawlKeyOf(url, context.rules);
		if (key === null) continue;
		sitemapKeys.add(key);
		learn(state, { key, url, follow: true }, "sitemap");
	}
	for (const key of sitemapKeys) {
		const known = state.known.get(key);
		if (known !== undefined) known.inSitemap = true;
	}

	tell({ phase: "pages", pagesFound: state.known.size });
	const delayMs = politeDelay(state.robots);
	const lane = async (): Promise<void> => {
		for (let key = state.queue.shift(); key !== undefined; key = state.queue.shift()) {
			const known = state.known.get(key);
			if (known === undefined || known.read) continue;
			known.read = true;
			tell({ currentUrl: known.url });
			await paceRequest(deps, known.url, delayMs);
			const reading = await readSitePage(
				key,
				userAgent,
				{ ...deps, ...(options.render === undefined ? {} : { render: options.render }) },
				{ robots: state.robots }
			);
			commit(state, known, reading, now());
			tell({ pagesRead: state.read.size, pagesFound: state.known.size, currentUrl: null });
		}
	};
	let lanes: Promise<void>[] = [];
	do {
		lanes = Array.from({ length: Math.min(concurrency, state.queue.length) }, lane);
		await Promise.all(lanes);
	} while (state.queue.length > 0);

	tell({ phase: "resources", currentUrl: null });
	const { byPage, spellings } = await checkResources(state, userAgent, deps, (url) =>
		tell({ currentUrl: url })
	);
	const hostProbes = robotsTxt === null ? null : await readHosts(state, robotsTxt, userAgent, deps);

	tell({ phase: "audit", currentUrl: null });
	const resolve = (key: string): string => {
		let current = key;
		for (let hop = 0; hop < 10; hop += 1) {
			const next = state.variants.get(current);
			if (next === undefined || next === current) return current;
			current = next;
		}
		return current;
	};
	const links: (AuditLink & { nofollow: boolean })[] = [];
	const outlinks = new Map<string, AuditOutlink[]>();
	for (const [sourceKey, entry] of state.read) {
		const own: AuditOutlink[] = [];
		for (const link of entry.links) {
			own.push({
				targetKey: link.targetKey,
				href: link.href,
				anchor: link.anchor,
				placement: link.placement,
				nofollow: link.nofollow
			});
			if (link.targetKey !== null)
				links.push({
					sourceKey,
					targetKey: link.targetKey,
					nofollow: link.nofollow,
					href: link.href
				});
		}
		if (own.length > 0) outlinks.set(sourceKey, own);
	}
	const depths = clickDepths([homeKey], links, resolve);
	const scored = [...state.read.values()]
		.filter(
			(entry) =>
				entry.page.lastError === null &&
				entry.page.status !== null &&
				entry.page.status >= 200 &&
				entry.page.status < 300 &&
				resolve(entry.page.pageKey) === entry.page.pageKey
		)
		.map((entry) => entry.page.pageKey);
	const unfollowed = new Set(
		[...state.read.values()].filter((entry) => entry.unfollowed).map((entry) => entry.page.pageKey)
	);
	const scores = linkScores(scored, links, resolve, unfollowed);
	const templates = pageTemplates(
		[...state.read.values()].map((entry) => ({
			pageKey: entry.page.pageKey,
			skeleton: entry.page.facts?.markup?.skeleton ?? null
		}))
	);
	const pages: AuditPage[] = [...state.known.values()].map((known) => {
		const entry = state.read.get(known.pageKey);
		const base: AuditPage = entry?.page ?? {
			pageKey: known.pageKey,
			status: null,
			lastError: null,
			inSitemap: known.inSitemap,
			hasTraffic: false,
			snapshot: null,
			facts: null
		};
		return {
			...base,
			clickDepth: depths.get(known.pageKey) ?? null,
			linkScore: scores.get(known.pageKey) ?? null,
			templateId: templates.get(known.pageKey) ?? null
		};
	});
	const graph = linkGraphCoverage(
		[...state.known.values()].map((known) => ({
			pageKey: known.pageKey,
			read: known.read,
			blocked: known.blocked
		})),
		depths,
		state.capped
	);
	const site: AuditSite = {
		homeKey,
		robotsTxt,
		verified: false,
		sitemapRead: plan === null ? null : plan.sitemap.read,
		sitemapFiles: plan?.sitemap.files ?? null,
		soft404: plan?.soft404 ?? null,
		robotsFetch:
			plan?.robotsFetch == null ? null : robotsFetchFacts(plan.robotsFetch, null, startedAt),
		hostProbes,
		agentFiles: plan?.agentFiles ?? null,
		robotsBlocked: [...state.known.values()]
			.filter((known) => known.blocked)
			.map((known) => ({ pageKey: known.pageKey, inSitemap: known.inSitemap })),
		linkSpellings: spellings
	};
	const complete =
		!state.capped && [...state.known.values()].every((known) => known.read || known.blocked);
	const findings = await auditSiteWithResources(
		pages,
		links,
		{ complete, variants: state.variants, site, graph },
		async (keys) =>
			new Map(keys.flatMap((key) => (byPage.has(key) ? [[key, byPage.get(key) ?? []]] : []))),
		async (keys) =>
			new Map(keys.flatMap((key) => (outlinks.has(key) ? [[key, outlinks.get(key) ?? []]] : [])))
	);

	const issues = reportIssues(findings);
	const readAt = new Map([...state.known.values()].map((known) => [known.pageKey, known.read]));
	const summary = summarizeAudit(findings, {
		pages: scorePagesOf(
			pages.map((page) => ({
				pageKey: page.pageKey,
				lastCrawledAt: readAt.get(page.pageKey) === true ? startedAt : null,
				status: page.status,
				impressions90d: 0,
				linkScore: page.linkScore ?? null,
				clickDepth: page.clickDepth ?? null
			})),
			findings
		),
		homeKey
	});
	const issuesOn = new Map<string, number>();
	for (const issue of issues)
		if (issue.kind === "issue") issuesOn.set(issue.pageKey, (issuesOn.get(issue.pageKey) ?? 0) + 1);
	const reportPages: AuditReportPage[] = pages
		.filter((page) => readAt.get(page.pageKey) === true)
		.map((page) => ({
			url: state.known.get(page.pageKey)?.url ?? `https://${page.pageKey}`,
			pageKey: page.pageKey,
			status: page.status,
			error: page.lastError,
			title: page.snapshot?.title ?? null,
			clickDepth: page.clickDepth ?? null,
			wordCount: page.snapshot?.wordCount ?? null,
			issues: issuesOn.get(page.pageKey) ?? 0
		}));
	const byRule: Record<string, number> = {};
	for (const issue of issues) byRule[issue.ruleId] = (byRule[issue.ruleId] ?? 0) + 1;
	const bySeverity: Record<AuditReportSeverity, number> = { ...summary.counts };
	tell({ phase: "done", currentUrl: null });
	return {
		schemaVersion: AUDIT_REPORT_SCHEMA_VERSION,
		startUrl: options.url,
		startedAt: startedAt.toISOString(),
		finishedAt: now().toISOString(),
		complete,
		pages: reportPages,
		issues,
		summary: {
			pages: reportPages.length,
			issues: issues.filter((issue) => issue.kind === "issue").length,
			tips: issues.filter((issue) => issue.kind === "tip").length,
			bySeverity,
			byRule,
			pagesWithErrors: summary.pagesWithErrors,
			score: summary.healthScore
		}
	};
}
