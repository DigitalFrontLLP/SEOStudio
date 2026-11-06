import { LINK_THRESHOLDS } from "./rules/architecture";
import { CONTENT_THRESHOLDS } from "./rules/content";
import { CONTENT_INSIGHT_THRESHOLDS } from "./rules/content-insights";
import { DUPLICATE_BODY_MIN_WORDS } from "./rules/duplicates";
import { NEAR_DUPLICATE_THRESHOLD } from "./rules/near-duplicates";
import { GOOGLE_THRESHOLDS } from "./rules/google";
import { LAB_THRESHOLDS } from "./rules/lab";
import type { LinkGraph } from "./link-graph";
import {
	buildAuditContext,
	hasOutlinkRules,
	hasResourceRules,
	outlinkRuleFindings,
	pageFindings,
	resourceFindings,
	runAuditRules,
	runPageRules
} from "./rules/index";
import { sitePageOf } from "./rules/site-page";
import type {
	AuditContext,
	AuditFinding,
	AuditGraph,
	AuditLink,
	AuditOutlink,
	AuditPage,
	AuditResource,
	AuditSite,
	AuditSitePage
} from "./rules/index";
import { PERFORMANCE_THRESHOLDS } from "./rules/performance";
import { RENDERING_THRESHOLDS } from "./rules/rendering";
import { REDIRECT_CHAIN_HOPS, URL_MAX_LENGTH } from "./rules/status";

/**
 * THE SITE AUDIT: every rule family under `./rules` run over the stored snapshots, fetch facts and
 * link graph. Every finding is a STABLE rule id from `./catalog` with structured params -
 * never English - filed under the catalog's severity, so the screen words it in the reader's language
 * and the recommendations engine matches on the id.
 *
 * PURE: it reads what it is handed and returns findings; the store writes them.
 */

export type {
	AuditContext,
	AuditFinding,
	AuditGraph,
	AuditLab,
	AuditLabRun,
	AuditLink,
	AuditOutlink,
	AuditOutlinkRule,
	AuditPage,
	AuditResource,
	AuditResourceRule,
	AuditSerpTitle,
	AuditSite,
	AuditSiteFacts,
	AuditSitePage,
	AuditSnapshot
} from "./rules/index";

/** The thresholds the rules use, in one place for the docs and the agent tools. */
export const SEO_AUDIT_THRESHOLDS = {
	...CONTENT_THRESHOLDS,
	...LINK_THRESHOLDS,
	...CONTENT_INSIGHT_THRESHOLDS,
	duplicateMinWords: DUPLICATE_BODY_MIN_WORDS,
	nearDuplicateSimilarity: NEAR_DUPLICATE_THRESHOLD,
	...GOOGLE_THRESHOLDS,
	...PERFORMANCE_THRESHOLDS,
	...RENDERING_THRESHOLDS,
	...LAB_THRESHOLDS,
	redirectChainHops: REDIRECT_CHAIN_HOPS,
	urlMaxLength: URL_MAX_LENGTH
} as const;

/** The site facts of a project that has no crawl plan yet. */
const NO_SITE: AuditSite = {
	homeKey: null,
	robotsTxt: null,
	verified: false,
	sitemapRead: null,
	sitemapFiles: null,
	soft404: null
};

/** How a site is audited. */
export interface AuditSiteOptions {
	/** Whether the crawl covered every sitemap URL; orphans are judged only then. */
	complete: boolean;
	/** Each known variant or redirected key, mapped to the page it lands on. */
	variants?: ReadonlyMap<string, string>;
	/** The site-wide facts of the last crawl plan. */
	site?: AuditSite;
	/** How much of the link graph the crawl has read; unknown (nothing absent judged) by default. */
	graph?: AuditGraph;
}

/**
 * Hands over what some pages load and link out to, each with the site's latest check of it: the store
 * streams them a batch of pages at a time, so the whole site's resources are never held at once.
 */
export type AuditResourceSource = (
	pageKeys: readonly string[]
) => Promise<ReadonlyMap<string, readonly AuditResource[]>>;

/**
 * Hands over the links some pages hold, internal and outbound, a batch of pages at a time, so the
 * anchors of a whole site are never held at once.
 */
export type AuditOutlinkSource = (
	pageKeys: readonly string[]
) => Promise<ReadonlyMap<string, readonly AuditOutlink[]>>;

/**
 * Hands over some pages whole (their every fetch fact and their heading outline), a batch at a time,
 * so the whole site's facts are never held at once.
 */
export type AuditPageSource = (
	pageKeys: readonly string[]
) => Promise<ReadonlyMap<string, AuditPage>>;

/** Pages read whole, with their resources and links, at once. */
export const AUDIT_BATCH_PAGES = 200;

/**
 * The audit's shared lookups.
 *
 * @param pages - Every crawled page, as the whole-site rules hold it.
 * @param links - The internal link graph, or a list of links.
 * @param options - The crawl's completeness, the variants and the site facts.
 * @returns The context.
 */
function contextOf(
	pages: readonly AuditSitePage[],
	links: LinkGraph | readonly AuditLink[],
	options: AuditSiteOptions
): AuditContext {
	return buildAuditContext(
		pages,
		links,
		options.variants ?? new Map(),
		options.site ?? NO_SITE,
		options.complete,
		options.graph
	);
}

/** A source that hands over nothing. */
const NOTHING = (): Promise<ReadonlyMap<string, never[]>> => Promise.resolve(new Map());

/**
 * Runs every rule over a site held whole in memory, the resource and outlink rules included: each
 * batch of pages' resources and links is read, judged and let go before the next.
 *
 * @param pages - Every crawled page with its latest snapshot and fetch facts.
 * @param links - The internal link graph (source to target page keys).
 * @param options - The crawl's completeness, the variants and the site facts.
 * @param resources - Hands over a batch of pages' resources.
 * @param outlinks - Hands over a batch of pages' links; none by default.
 * @returns Every finding, at most one per page and rule.
 */
export async function auditSiteWithResources(
	pages: readonly AuditPage[],
	links: readonly AuditLink[],
	options: AuditSiteOptions,
	resources: AuditResourceSource,
	outlinks: AuditOutlinkSource = NOTHING
): Promise<AuditFinding[]> {
	const whole = new Map(pages.map((page) => [page.pageKey, page]));
	return auditStoredSite(pages.map(sitePageOf), links, options, {
		pages: (keys) =>
			Promise.resolve(
				new Map(
					keys.flatMap((key) => (whole.has(key) ? [[key, whole.get(key)]] : [])) as [
						string,
						AuditPage
					][]
				)
			),
		resources,
		outlinks
	});
}

/**
 * One page's own findings before the whole-site settling: the per-page rules', and the resource and
 * outlink rules'. What a re-check keeps of a page it does not read again.
 */
export interface AuditPageFindings {
	page: AuditFinding[];
	resource: AuditFinding[];
}

/** Where an audit reads the pages it holds only in part. */
export interface AuditSources {
	/** Hands over a batch of pages whole. */
	pages: AuditPageSource;
	/** Hands over a batch of pages' resources. */
	resources: AuditResourceSource;
	/** Hands over a batch of pages' links; none by default. */
	outlinks?: AuditOutlinkSource;
	/**
	 * Hands over the own findings the last audit kept for some pages (a re-check: the pages it did not
	 * read again, nor any page they depend on); a page it leaves out is judged anew.
	 */
	held?: (pageKeys: readonly string[]) => Promise<ReadonlyMap<string, AuditPageFindings>>;
	/** Takes each batch's pages judged anew with their own findings, to keep them for a re-check. */
	keep?: (judged: ReadonlyMap<string, AuditPageFindings>) => Promise<void>;
}

/**
 * Runs every rule over a site in BOUNDED MEMORY: the whole-site rules read every page as they hold it
 * (its row, its snapshot and the small part of its facts) and the link graph held as numbers, while
 * the per-page, resource and outlink rules read each batch of {@link AUDIT_BATCH_PAGES} pages whole,
 * judge it and let it go before the next. A site of any size holds one batch whole at a time.
 *
 * @param pages - Every crawled page as the whole-site rules hold it, in the order findings are listed.
 * @param links - The internal link graph, built with the same variants, or a list of links.
 * @param options - The crawl's completeness, the variants and the site facts.
 * @param sources - Hands over each batch whole, with its resources and links.
 * @returns Every finding, at most one per page and rule.
 */
export async function auditStoredSite(
	pages: readonly AuditSitePage[],
	links: LinkGraph | readonly AuditLink[],
	options: AuditSiteOptions,
	sources: AuditSources
): Promise<AuditFinding[]> {
	const context = contextOf(pages, links, options);
	const pageFound: AuditFinding[] = [];
	const resourceFound: AuditFinding[] = [];
	const withResources = hasResourceRules();
	const withOutlinks = hasOutlinkRules() && sources.outlinks !== undefined;
	const outlinks = sources.outlinks ?? NOTHING;
	for (let start = 0; start < pages.length; start += AUDIT_BATCH_PAGES) {
		const batch = pages.slice(start, start + AUDIT_BATCH_PAGES).map((page) => page.pageKey);
		const held = sources.held === undefined ? new Map() : await sources.held(batch);
		const keys = batch.filter((key) => !held.has(key));
		const [whole, byPage, linksByPage] =
			keys.length === 0
				? [new Map<string, AuditPage>(), new Map(), new Map()]
				: await Promise.all([
						sources.pages(keys),
						withResources ? sources.resources(keys) : NOTHING(),
						withOutlinks ? outlinks(keys) : NOTHING()
					]);
		const judged = new Map<string, AuditPageFindings>();
		for (const key of batch) {
			const kept = held.get(key);
			const page = whole.get(key);
			const own: AuditPageFindings =
				kept ??
				(page === undefined
					? { page: [], resource: [] }
					: {
							page: pageFindings(page, context),
							resource: [
								...(withResources ? resourceFindings(page, byPage.get(key) ?? [], context) : []),
								...((linksByPage.get(key)?.length ?? 0) > 0
									? outlinkRuleFindings(page, linksByPage.get(key) ?? [], context)
									: [])
							]
						});
			if (kept === undefined && page !== undefined) judged.set(key, own);
			for (const entry of own.page) pageFound.push(entry);
			for (const entry of own.resource) resourceFound.push(entry);
		}
		if (sources.keep !== undefined && judged.size > 0) await sources.keep(judged);
	}
	for (const entry of resourceFound) pageFound.push(entry);
	return runAuditRules(context, pageFound);
}

/**
 * Runs the per-page rules over some pages on their own (no link graph, no whole-site checks): the
 * running count of a crawl in progress.
 *
 * @param pages - The pages with their latest snapshot and fetch facts.
 * @param site - The site-wide facts of the last crawl plan.
 * @returns Their page-level findings.
 */
export function auditPages(pages: readonly AuditPage[], site: AuditSite = NO_SITE): AuditFinding[] {
	return runPageRules(buildAuditContext(pages.map(sitePageOf), [], new Map(), site, false), pages);
}
