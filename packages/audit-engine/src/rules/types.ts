import type {
	SeoAgentFilesFacts,
	SeoAiPagePrompt,
	SeoCustomCheck,
	SeoCustomScript,
	SeoHostProbes,
	SeoLabAudit,
	SeoPageAuditFacts,
	SeoPageCheckFacts,
	SeoPageFetchModeValue,
	SeoPageHeading,
	SeoPageHreflang,
	SeoPageIssueSeverityValue,
	SeoPageLinkPlacementValue,
	SeoPageMarkupFacts,
	SeoPageRedirectHop,
	SeoPageRenderFacts,
	SeoPageTextFacts,
	SeoResourceHeaders,
	SeoResourceKindValue,
	SeoRobotsFetchFacts,
	SeoSitemapFileFacts,
	SeoSoft404Probe,
	SeoTlsFacts
} from "../facts";

import type { SeoAuditRuleId } from "../catalog";
import type { LinkGraph } from "../link-graph";
import type { SeoAuditThresholdValues } from "../thresholds";

/**
 * WHAT THE SITE AUDIT'S RULES READ: one page's latest snapshot and fetch facts, the internal link
 * graph, and the site-wide facts of the last crawl plan. Plain data, built by the host's crawl from the stored
 * rows and by the tests by hand.
 */

/** The snapshot fields the rules read. */
export interface AuditSnapshot {
	/** How the snapshot was read: rendered in a browser, raw HTML, or the retired text-only read. */
	mode: SeoPageFetchModeValue;
	status: number;
	finalUrl: string | null;
	redirectChain: SeoPageRedirectHop[];
	contentType: string | null;
	xRobotsTag: string | null;
	title: string | null;
	metaDescription: string | null;
	h1: string | null;
	h1Count: number | null;
	canonical: string | null;
	metaRobots: string | null;
	lang: string | null;
	viewport: string | null;
	schemaTypes: string[] | null;
	hasOpenGraph: boolean | null;
	hasTwitterCard: boolean | null;
	images: number | null;
	imagesMissingAlt: number | null;
	wordCount: number | null;
	mainTextHash: string | null;
	responseMs: number | null;
	sizeBytes: number | null;
	/** The heading outline, when stored. */
	headings?: SeoPageHeading[] | null;
	/** The hreflang alternates, when stored. */
	hreflang?: SeoPageHreflang[] | null;
	/** The published and modified dates the page states (`YYYY-MM-DD`), when stored. */
	datePublished?: string | null;
	dateModified?: string | null;
	/** When the snapshot was read (ISO): what it says has been on the page since about then. */
	fetchedAt?: string | null;
}

/** How Google's results page showed a page for one tracked keyword, from the rank tracker. */
export interface AuditSerpTitle {
	keyword: string;
	/** The title the results page showed for the page. */
	title: string;
	/** The day the results page was read (`YYYY-MM-DD`). */
	day: string;
}

/** One page as the audit reads it. */
export interface AuditPage {
	pageKey: string;
	/** The confirmed status (0 when unreachable), or null before one. */
	status: number | null;
	/** The last fetch's failure kind, or null when it succeeded. */
	lastError: string | null;
	/** Failed fetches in a row on distinct days (2 confirms a failure). */
	failCount?: number;
	inSitemap: boolean;
	hasTraffic: boolean;
	/** Search impressions over 90 days. */
	impressions?: number;
	/** Whether Analytics counted visits landing on it over the traffic window. */
	inAnalytics?: boolean;
	/** Whether a held backlink list names it as a link target. */
	backlinked?: boolean;
	/** Clicks from the home page along followed links, or null when no such path reaches it. */
	clickDepth?: number | null;
	/** The page's internal PageRank, 0 to 100 (`../link-score`), or null when it was not scored. */
	linkScore?: number | null;
	/** The page's template (its URL pattern and layout skeleton), or null when it shares none. */
	templateId?: string | null;
	/** The titles Google's results page showed for it at the rank tracker's latest checks, when any. */
	serpTitles?: AuditSerpTitle[];
	/** How the last read was made: `browser` (rendered), `plain` (raw HTML), or the retired `rendered`. */
	fetchMode?: SeoPageFetchModeValue | null;
	snapshot: AuditSnapshot | null;
	/** What the latest fetch left for the audit, or null before a fetch that kept them. */
	facts?: SeoPageAuditFacts | null;
}

/**
 * The fetch facts the whole-site rules read of EVERY page at once: the small part of
 * {@link SeoPageAuditFacts} held for the whole site, while the per-page rules read each page's whole
 * facts one batch of pages at a time. A whole-site rule that needs another fact adds it here (and to
 * `siteFactsOf`), so the compiler shows every read.
 */
export interface AuditSiteFacts {
	redirectChain: SeoPageAuditFacts["redirectChain"];
	responseMs: number;
	sizeBytes: number;
	htmlUnlabelled?: boolean;
	page: SeoPageAuditFacts["page"];
	headers: SeoPageAuditFacts["headers"];
	html: boolean;
	canonicals: string[];
	hreflang: SeoPageHreflang[];
	mixedContent: SeoPageAuditFacts["mixedContent"];
	markup?:
		| (Pick<
				SeoPageMarkupFacts,
				| "lang"
				| "canonicals"
				| "analytics"
				| "ajaxFragmentMeta"
				| "skeleton"
				| "pagination"
				| "amp"
				| "markdownAlternate"
				| "platform"
		  > & {
				bookmarks: AuditSiteBookmarks;
				/** The page's Open Graph type (`og:type`) as written, or null. */
				openGraphType?: string | null;
		  })
		| null;
	render?: Pick<SeoPageRenderFacts, "outcome"> | null;
	text?: Pick<SeoPageTextFacts, "minhash" | "languages"> | null;
	checks?: Pick<SeoPageCheckFacts, "spelling"> | null;
}

/**
 * The ids a page's links may jump to (`#fragment`), as the whole-site rules hold them: the page's
 * own list when it is read whole, or a 32-bit hash of each (`bookmarkHash`) when it is held for the
 * whole site, so thousands of ids a page are never kept as strings for every page at once.
 */
export interface AuditSiteBookmarks {
	idsTruncated: boolean;
	/** The ids, on a page read whole. */
	ids?: string[];
	/** The ids' hashes, sorted, on a page held for the whole site. */
	idHashes?: Uint32Array;
}

/** The snapshot fields the whole-site rules read of every page (the heading outline left out). */
export type AuditSiteSnapshot = Omit<AuditSnapshot, "headings">;

/**
 * One page as the WHOLE-SITE rules read it, beside every other page: its row, its snapshot without
 * the heading outline, and the small part of its facts ({@link AuditSiteFacts}). A whole page
 * ({@link AuditPage}) is one too, so a rule over the whole site reads either.
 */
export interface AuditSitePage extends Omit<AuditPage, "facts" | "snapshot"> {
	snapshot: AuditSiteSnapshot | null;
	facts?: AuditSiteFacts | null;
}

/**
 * One resource a page references, as the audit reads it. A page's resources are never held on its
 * {@link AuditPage}: the audit streams them page batch by page batch into the resource rules
 * ({@link AuditResourceRule}), so a site of any size stays within a bounded memory.
 */
export interface AuditResource {
	/** The absolute URL as the page wrote it. */
	url: string;
	/** How this page uses it: a file it loads, a failed render request (`other`), or an outbound `link`. */
	kind: SeoResourceKindValue;
	/** robots.txt's verdict on the site's own hosts (a forbidden URL is never fetched), null elsewhere or before a check. */
	robotsAllowed: boolean | null;
	/** The first hop's status (0 when nothing answered), or null before a check or when robots.txt forbids it. */
	status: number | null;
	/** The last hop's status, or null before a check. */
	finalStatus: number | null;
	/** Where it led, from this project's own check only; null before a check or when filed from the shared outbound-link table. */
	finalUrl: string | null;
	contentType: string | null;
	/** The body's size in bytes as served, or null when unknown. */
	sizeBytes: number | null;
	/** An image's pixel size from its file header, or null when it was not read. */
	width?: number | null;
	height?: number | null;
	/** A linked document's title from its metadata (`''` for none), or null when it was not read. */
	title?: string | null;
	/** The caching and compression headers of a file a page loads, or null when none were kept. */
	headers?: SeoResourceHeaders | null;
	/** Why nothing usable answered, or null. */
	error: string | null;
	/** When it was last checked (ISO), or null before a check. */
	checkedAt: string | null;
	/**
	 * Checks in a row, the latest included, that answered a definite failure (an outbound link's: a
	 * 4xx saying the page is gone, a 5xx, a host that does not exist); absent on older reads.
	 */
	failCount?: number;
	/** When that run of failures began (ISO), or null. */
	failingSince?: string | null;
}

/** One internal link as the audit reads it. */
export interface AuditLink {
	sourceKey: string;
	/** The key the link spells. */
	targetKey: string;
	/** The page that key lands on after known redirects and variants (the target itself when none). */
	resolvedKey?: string;
	/** Whether the link carries `rel="nofollow"`. */
	nofollow?: boolean;
	/**
	 * The URL exactly as the link spelled it (resolved), when that differs from `https://` plus its key
	 * (a scheme, a trailing slash, a letter case or a parameter the key hides); null or absent when not.
	 */
	href?: string | null;
}

/**
 * One link a page holds, internal or outbound, as stored: the outlink rules read a page's own links,
 * streamed a batch of pages at a time like its resources, so the anchors of a whole site are never
 * held at once.
 */
export interface AuditOutlink {
	/** The page key it names on the site, or null for a link off the site. */
	targetKey: string | null;
	/** The URL as the link spelled it, when the key alone hides it (always for a link off the site). */
	href: string | null;
	/** The anchor text (an image's alt, or the link's accessible label, when it has no text). */
	anchor: string;
	placement: SeoPageLinkPlacementValue;
	nofollow: boolean;
}

/** What one link spelling answered when it was asked once, its redirect never followed. */
export interface AuditLinkSpelling {
	/** The status it answered (a redirect's own), 0 when nothing answered. */
	status: number;
	/** Where a redirect sends it, else the spelling itself; null when unknown. */
	finalUrl: string | null;
	/** Why nothing usable answered, or null. */
	error: string | null;
}

/** How much of the site's link graph the crawl has read, for the rules that judge what is ABSENT from it. */
export interface AuditGraph {
	/**
	 * Whether every page the crawl knows of was read and the crawl stopped short of its page cap, so no
	 * unread page can hold a link the graph is missing.
	 */
	complete: boolean;
	/**
	 * The fewest clicks from the home page of a page not read yet (null when none is reachable): every
	 * click depth up to it is exact, and a page deeper than it is truly deeper.
	 */
	shallowestUnread: number | null;
}

/** The site-wide facts of the last crawl plan. */
export interface AuditSite {
	/** The home page's key, or null when the project has no website. */
	homeKey: string | null;
	/** The robots.txt last read ("" when the site has none), or null before one was read. */
	robotsTxt: string | null;
	/** Whether the project holds a verified property (every site is crawled whole either way). */
	verified: boolean;
	/** Whether any sitemap could be read at the last plan, or null before a plan. */
	sitemapRead: boolean | null;
	/** Each sitemap file the last plan read. */
	sitemapFiles: SeoSitemapFileFacts[] | null;
	/**
	 * Whether the crawl keeps only a sample of each URL pattern's pages (`samplePerPattern`): the plan
	 * then drops most sitemap URLs, so a page found later by its links is not known to be listed.
	 */
	sitemapSampled?: boolean;
	/** The last soft-404 probe, or null before one. */
	soft404: SeoSoft404Probe | null;
	/** The site host's TLS certificate and handshake at the last plan, or null before one was read. */
	tls?: SeoTlsFacts | null;
	/** How robots.txt answered at the last plan, or absent or null before one was recorded. */
	robotsFetch?: SeoRobotsFetchFacts | null;
	/**
	 * The home page's host variants and a few pages over plain http at the last plan (the server's own
	 * reads), or absent or null before they were read.
	 */
	hostProbes?: SeoHostProbes | null;
	/** The pages the crawl found but robots.txt kept it from (never fetched), and whether a sitemap lists each. */
	robotsBlocked?: readonly { pageKey: string; inSitemap: boolean }[];
	/** What Google and Analytics hold about the site; absent or null when no source is connected. */
	google?: AuditGoogle | null;
	/** Each lab-tested page's latest tests by page key; absent or null when none is held. */
	lab?: ReadonlyMap<string, AuditLab> | null;
	/** The project's custom search and extraction patterns; absent when it has none. */
	customChecks?: readonly SeoCustomCheck[];
	/** The project's custom JavaScript snippets (run on a member's computer); absent when it has none. */
	customScripts?: readonly Pick<SeoCustomScript, "id" | "name">[];
	/** The project's AI prompts over each page; absent when it has none. */
	aiPrompts?: readonly SeoAiPagePrompt[];
	/**
	 * The thresholds the project changed (`../thresholds`), by key; absent or empty when it judges
	 * with the tuned defaults.
	 */
	thresholds?: Partial<SeoAuditThresholdValues>;
	/**
	 * What the AI prompts answered about each page, by page key, on the page's latest text; absent or
	 * null when the project has no prompts.
	 */
	aiAnswers?: ReadonlyMap<string, readonly { promptId: string; answer: string }[]> | null;
	/** The site's files for AI agents at the last plan; absent or null before they were read. */
	agentFiles?: SeoAgentFilesFacts | null;
	/** Each embedded page's meaning vector by page key; absent or null when semantic checks are off. */
	embeddings?: ReadonlyMap<string, Float32Array> | null;
	/**
	 * What each link spelling the resource checks asked about answered (a link's spelling of a page of
	 * the site that is not the URL the crawler reads it at), by the URL the link wrote; absent when none
	 * was asked.
	 */
	linkSpellings?: ReadonlyMap<string, AuditLinkSpelling> | null;
}

/** One lab test of a page (Lighthouse, run by PageSpeed Insights) as the `lh_*` rules read it. */
export interface AuditLabRun {
	/** The day it ran (ISO). */
	testedOn: string;
	/** Lighthouse's performance score, 0 to 100, or null. */
	performanceScore: number | null;
	/** The audits the rules read, by Lighthouse audit id. */
	audits: Readonly<Record<string, SeoLabAudit>>;
}

/** A page's latest lab tests: on a phone and on a desktop, each null when not held. */
export interface AuditLab {
	mobile: AuditLabRun | null;
	desktop: AuditLabRun | null;
}

/** One page's latest answer from Google's URL Inspection, as the audit reads it. */
export interface AuditInspection {
	/** Whether Google holds the page in its index. */
	indexed: boolean;
	/** The stable reason id Search Console's Pages report groups it under (`crawled_not_indexed`...). */
	reason: string;
	/** Google's verdict (`PASS`, `PARTIAL`, `FAIL`, `NEUTRAL`). */
	verdict: string;
	googleCanonical: string | null;
	userCanonical: string | null;
	/** Google's rich results verdict (`PASS`, `FAIL`...), or null when the page has none. */
	richResultsVerdict: string | null;
	richResultTypes: string[];
	/** Whole days Google has answered this way, up to the audit (its first answer of this state). */
	stateDays: number;
}

/** One weekly CrUX point: the 75th percentiles of a 28-day window. */
export interface AuditVitalsWeek {
	periodStart: string;
	periodEnd: string;
	lcpMs: number | null;
	inpMs: number | null;
	cls: number | null;
}

/** One CrUX reading the audit reads: the origin's, or a page's own (never a page answered by its origin). */
export interface AuditVitals {
	/** The page's key, or `""` for the origin. */
	pageKey: string;
	formFactor: "PHONE" | "DESKTOP";
	/** The 75th percentiles over CrUX's latest 28 days. */
	lcpMs: number | null;
	inpMs: number | null;
	cls: number | null;
	/** The weekly history, oldest first. */
	weeks: AuditVitalsWeek[];
}

/**
 * WHAT GOOGLE AND ANALYTICS HOLD ABOUT THE SITE, as the traffic and Google-view rules read it. Each
 * source is null (or false) when the project has not connected it, so its rules are absent rather than
 * failing.
 */
export interface AuditGoogle {
	/**
	 * Search Console's clicks and impressions over the last 90 days by page key, or null when Search
	 * Console is not connected or its page history is not whole yet. A page without a row had none.
	 */
	search: ReadonlyMap<string, { clicks: number; impressions: number }> | null;
	/** Whether Analytics is connected, so a page's `inAnalytics` counts as visits. */
	analytics: boolean;
	/** Each inspected page's latest URL Inspection by page key, or null when Search Console is not connected. */
	inspections: ReadonlyMap<string, AuditInspection> | null;
	/** The fresh CrUX readings (the origin and the busiest pages), or null when none is held. */
	vitals: readonly AuditVitals[] | null;
}

/**
 * A rule over the links one page holds: called once per crawled page that holds any, beside the page and
 * the whole audit's lookups.
 */
export type AuditOutlinkRule = (
	page: AuditPage,
	outlinks: readonly AuditOutlink[],
	context: AuditContext
) => AuditFinding[];

/** One finding. */
export interface AuditFinding {
	pageKey: string;
	ruleId: SeoAuditRuleId;
	severity: SeoPageIssueSeverityValue;
	params: Record<string, unknown>;
}

/** Everything one rule family reads, with the lookups the families share. */
/**
 * A rule over what one page loads and links out to, each with the site's latest check of it: called
 * once per crawled page that references anything, beside the page and the whole audit's lookups.
 */
export type AuditResourceRule = (
	page: AuditPage,
	resources: readonly AuditResource[],
	context: AuditContext
) => AuditFinding[];

export interface AuditContext {
	/** The pages whose state is known, in input order, as the whole-site rules read them. */
	pages: readonly AuditSitePage[];
	/** Every page by key, known or not. */
	byKey: ReadonlyMap<string, AuditSitePage>;
	/** The internal link graph, held in bounded memory (`../link-graph`). */
	links: LinkGraph;
	/** The key a URL or key lands on after the known variants and redirects. */
	resolve: (key: string) => string;
	site: AuditSite;
	/** Whether the crawl covered every sitemap URL (orphans are judged only then). */
	complete: boolean;
	/** How much of the link graph the crawl has read. */
	graph: AuditGraph;
	/**
	 * Whether the link graph is whole enough to say a page has NO link of some kind: the crawl covered
	 * every sitemap URL, or read every page it knows of.
	 */
	linksComplete: boolean;
}
