import { SEO_AUDIT_RULES, SEO_AUDIT_SUPERSEDED_BY } from "../catalog";
import { agentFileFindings } from "./agent-files";
import { analyticsFindings } from "./analytics";
import type { SeoAuditRuleId } from "../catalog";
import { aiAccessFindings } from "./ai-access";
import { linkGraphFindings } from "./architecture";
import { contentFindings } from "./content";
import { deliveryFindings } from "./delivery";
import { directiveFindings } from "./directives";
import { contentInsightFindings } from "./content-insights";
import { duplicateFindings } from "./duplicates";
import { documentFindings } from "./documents";
import { headFindings, oversizedResourceFindings } from "./head";
import { googlePageFindings, googleSiteFindings, trafficFindings } from "./google";
import { hostVariantFindings, internalHttpFindings } from "./hosts";
import { hreflangFindings, hreflangSiteFindings } from "./hreflang";
import { imageResourceFindings } from "./images";
import { externalLinkFindings } from "./external-links";
import { linkMarkupFindings } from "./link-markup";
import { outlinkFindings } from "./outlinks";
import { canonicalToHomeFindings, indexingFindings } from "./indexing";
import { labFindings } from "./lab";
import { linkFindings, markLayoutSchemeLinks } from "./links";
import { seriesFindings } from "./pagination";
import { foldSharedLayoutFindings, markSiteSettingFindings } from "./shared-layout";
import { pageCheckFindings } from "./page-checks";
import { foldFamilyFindings } from "./families";
import { judgesNoindexPage } from "./noindex-checks";
import { checkoutPage, PAGE_REDIRECT_RULES } from "./page-state";
import { performanceFindings } from "./performance";
import { presentationFindings } from "./presentation";
import { redirectFindings } from "./redirects";
import { renderedDomFindings } from "./rendered-dom";
import { renderedWeightFindings } from "./rendered-weight";
import { renderingFindings } from "./rendering";
import { robotsFileFindings, robotsReachFindings } from "./robots-file";
import { structuredDataFindings } from "./schema";
import { semanticFindings } from "./semantic";
import { spellingFindings } from "./spelling";
import {
	mixedContentFindings,
	securityHeaderFindings,
	tlsFindings,
	transportFindings
} from "./security";
import { socialFindings, socialResourceFindings } from "./social";
import { sitemapPageFindings, sitemapSiteFindings } from "./sitemap";
import { rateLimitFindings, soft404CatchAll, statusFindings } from "./status";
import { technicalDuplicateFindings, trapParameterFindings, urlFindings } from "./urls";
import type {
	AuditContext,
	AuditFinding,
	AuditGraph,
	AuditLink,
	AuditOutlink,
	AuditOutlinkRule,
	AuditPage,
	AuditResource,
	AuditResourceRule,
	AuditSite,
	AuditSitePage
} from "./types";
import { LinkGraph, linkGraphOf } from "../link-graph";

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
} from "./types";

/**
 * THE SITE AUDIT'S RULE RUNNER: builds the shared lookups once and runs every rule family over them.
 * Pure: the host's crawl hands it the stored rows (`../site` its own), the tests hand it pages built by hand.
 */

/** The most redirect or variant hops a key is followed through. */
const RESOLVE_HOPS = 10;

/** The per-page rule families, in the order their findings are listed. */
const PAGE_FAMILIES = [
	statusFindings,
	redirectFindings,
	urlFindings,
	headFindings,
	indexingFindings,
	directiveFindings,
	seriesFindings,
	sitemapPageFindings,
	contentFindings,
	contentInsightFindings,
	structuredDataFindings,
	hreflangFindings,
	performanceFindings,
	mixedContentFindings,
	transportFindings,
	presentationFindings,
	socialFindings,
	renderingFindings,
	renderedDomFindings,
	linkMarkupFindings,
	googlePageFindings,
	labFindings,
	pageCheckFindings
] as const;

/**
 * The rule families over what each page loads and links out to (the resource checks). They run while
 * the audit streams each batch of pages' resources ({@link resourceFindings}), never over a list of the
 * whole site's resources held at once.
 */
const RESOURCE_FAMILIES: readonly AuditResourceRule[] = [
	externalLinkFindings,
	oversizedResourceFindings,
	socialResourceFindings,
	renderedWeightFindings,
	imageResourceFindings,
	deliveryFindings,
	documentFindings
];

/**
 * The rule families over the links each page holds (anchors, nofollow, the scheme a link spells). They
 * run while the audit streams each batch of pages' links ({@link outlinkRuleFindings}).
 */
const OUTLINK_FAMILIES: readonly AuditOutlinkRule[] = [outlinkFindings];

/** The link graph of an audit that was handed no coverage: nothing absent is judged from it. */
const UNKNOWN_GRAPH: AuditGraph = { complete: false, shallowestUnread: 0 };

/** The whole-site rule families. */
const SITE_FAMILIES = [
	linkFindings,
	linkGraphFindings,
	duplicateFindings,
	sitemapSiteFindings,
	soft404CatchAll,
	rateLimitFindings,
	securityHeaderFindings,
	aiAccessFindings,
	robotsFileFindings,
	robotsReachFindings,
	technicalDuplicateFindings,
	trapParameterFindings,
	hostVariantFindings,
	internalHttpFindings,
	canonicalToHomeFindings,
	tlsFindings,
	hreflangSiteFindings,
	googleSiteFindings,
	spellingFindings,
	agentFileFindings,
	semanticFindings,
	analyticsFindings
] as const;

/**
 * The families that join the findings filed so far with other data (a noindex page that still gets
 * clicks), so a state is judged by one rule and only joined here.
 */
const JOIN_FAMILIES = [trafficFindings] as const;

/**
 * The page a key lands on after the known variants and redirects, a few hops at most.
 *
 * @param variants - Each known variant or redirected key, mapped to the page key it lands on.
 * @returns The resolver.
 */
export function variantResolver(variants: ReadonlyMap<string, string>): (key: string) => string {
	return (key) => {
		let current = key;
		for (let hop = 0; hop < RESOLVE_HOPS; hop += 1) {
			const next = variants.get(current);
			if (next === undefined || next === current) return current;
			current = next;
		}
		return current;
	};
}

/**
 * The shared lookups every rule family reads.
 *
 * @param pages - The pages whose state is known, as the whole-site rules hold them.
 * @param links - The internal link graph: a graph built with the same variants, or a list of links.
 * @param variants - Each known variant or redirected key, mapped to the page key it lands on.
 * @param site - The site-wide facts.
 * @param complete - Whether the crawl covered every sitemap URL.
 * @param graph - How much of the link graph the crawl has read; unknown by default.
 * @returns The context.
 */
export function buildAuditContext(
	pages: readonly AuditSitePage[],
	links: LinkGraph | readonly AuditLink[],
	variants: ReadonlyMap<string, string>,
	site: AuditSite,
	complete: boolean,
	graph: AuditGraph = UNKNOWN_GRAPH
): AuditContext {
	const resolve = variantResolver(variants);
	return {
		pages,
		byKey: new Map(pages.map((page) => [page.pageKey, page])),
		links: links instanceof LinkGraph ? links : linkGraphOf(links, resolve),
		resolve,
		site,
		complete,
		graph,
		linksComplete: complete || graph.complete
	};
}

/**
 * Whether any rule reads the pages' resources, so the audit streams them only when one does.
 *
 * @returns Whether a resource rule family is registered.
 */
export function hasResourceRules(): boolean {
	return RESOURCE_FAMILIES.length > 0;
}

/**
 * Runs the resource rule families over one page's resources.
 *
 * @param page - The page.
 * @param resources - What it loads and links out to, with the site's latest check of each.
 * @param context - The audit, from {@link buildAuditContext}.
 * @returns The page's resource findings.
 */
export function resourceFindings(
	page: AuditPage,
	resources: readonly AuditResource[],
	context: AuditContext
): AuditFinding[] {
	return RESOURCE_FAMILIES.flatMap((family) => family(page, resources, context));
}

/**
 * Whether any rule reads the links each page holds, so the audit streams them only when one does.
 *
 * @returns Whether an outlink rule family is registered.
 */
export function hasOutlinkRules(): boolean {
	return OUTLINK_FAMILIES.length > 0;
}

/**
 * Runs the outlink rule families over the links one page holds.
 *
 * @param page - The page.
 * @param outlinks - Its links, internal and outbound.
 * @param context - The audit, from {@link buildAuditContext}.
 * @returns The page's outlink findings.
 */
export function outlinkRuleFindings(
	page: AuditPage,
	outlinks: readonly AuditOutlink[],
	context: AuditContext
): AuditFinding[] {
	return OUTLINK_FAMILIES.flatMap((family) => family(page, outlinks, context));
}

/**
 * Runs the whole-site families over a site and settles every finding.
 *
 * @param context - The audit, from {@link buildAuditContext}.
 * @param pageFound - The per-page, resource and outlink rules' findings, gathered page batch by page
 *   batch ({@link pageFindings}, {@link resourceFindings}, {@link outlinkRuleFindings}).
 * @returns Every finding, at most one per page and rule; a page that is an error page in disguise (a
 *   soft 404) is filed for that alone, never for its title or its text.
 */
export function runAuditRules(context: AuditContext, pageFound: AuditFinding[]): AuditFinding[] {
	return settleFindings(pageFound, context, true);
}

/**
 * Runs the per-page rule families alone: what each page shows on its own, without the link graph or
 * the whole-site checks.
 *
 * @param context - The audit, from {@link buildAuditContext}.
 * @param pages - The whole pages judged.
 * @returns The page-level findings, settled as {@link runAuditRules} settles them.
 */
export function runPageRules(context: AuditContext, pages: readonly AuditPage[]): AuditFinding[] {
	return settleFindings(
		pages.flatMap((page) => pageFindings(page, context)),
		context,
		false
	);
}

/**
 * A search engine's site-verification file, by its URL's last part: Google's `google` and Yandex's
 * `yandex_` followed by the 16-hex token the engine issued, with or without `.html`.
 */
const SITE_VERIFICATION_FILE = /^(?:google[0-9a-f]{16}|yandex_[0-9a-f]{16})(?:\.html?)?$/i;

/**
 * Whether a page is a search engine's site-verification file: a one-line token file the site owner
 * uploads for the engine, never a page for people, so no page check applies to it.
 *
 * @param pageKey - The page key (`host/path`).
 * @returns Whether it is one.
 */
export function isSiteVerificationFile(pageKey: string): boolean {
	const path = pageKey.split(/[?#]/u)[0] ?? "";
	return SITE_VERIFICATION_FILE.test(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * Every per-page family's findings on one whole page; none on a search engine's verification file
 * ({@link isSiteVerificationFile}).
 *
 * @param page - The page, with its whole facts.
 * @param context - The audit.
 * @returns The findings, in family order.
 */
export function pageFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	if (isSiteVerificationFile(page.pageKey)) return [];
	const findings: AuditFinding[] = [];
	for (const family of PAGE_FAMILIES)
		for (const entry of family(page, context)) findings.push(entry);
	return findings;
}

/** The checks of a page's words outside the content and metadata areas. */
const TEXT_CHECKS: ReadonlySet<string> = new Set([
	"translation_missing",
	"lang_missing",
	"unsupported_plugins"
]);

/**
 * Whether a check judges what a page says (its text, headings, title and description), which a soft
 * 404 makes moot.
 *
 * @param ruleId - The check.
 * @returns Whether it does.
 */
function judgesPageText(ruleId: SeoAuditRuleId): boolean {
	const { category } = SEO_AUDIT_RULES[ruleId];
	if (ruleId === "metadata_outside_head") return false;
	return category === "content" || category === "metadata" || TEXT_CHECKS.has(ruleId);
}

/**
 * The heading checks: a store's cart, checkout and order confirmation pages (`checkoutPage`) are never
 * judged by them, their headings are the platform's own.
 */
const HEADING_CHECKS: ReadonlySet<SeoAuditRuleId> = new Set<SeoAuditRuleId>([
	"h1_missing",
	"h1_multiple",
	"h1_duplicate",
	"h1_length",
	"h2_facts",
	"heading_skip",
	"a11y_empty_heading",
	"js_h1_changed"
]);

/** The page checks that still judge a URL whose page only sends its visitor on. */
const REDIRECT_PAGE_CHECKS: ReadonlySet<string> = new Set([
	"unreachable",
	"crawl_blocked",
	"robots_blocked_url"
]);

/**
 * Whether a check still judges a page that redirects from inside the page (a refresh or a script): what
 * a server redirect would be judged for (its status, its URL, the sitemap and search data naming it,
 * the redirect itself) and the whole-site checks filed on it. Its text, head, markup (its analytics
 * tag too), links and resources are a stand-in nobody reads, as a server redirect's body is.
 *
 * @param ruleId - The check.
 * @returns Whether it does.
 */
function judgesRedirectPage(ruleId: SeoAuditRuleId): boolean {
	const rule = SEO_AUDIT_RULES[ruleId];
	return (
		rule.scope === "site" ||
		rule.category === "redirects" ||
		(rule.category === "google" && ruleId !== "analytics_tags") ||
		REDIRECT_PAGE_CHECKS.has(ruleId) ||
		/^(?:status|url|sitemap)_/.test(ruleId)
	);
}

/** The image checks of our own that file what the lab's image delivery audit names. */
const IMAGE_WEIGHT_RULES: readonly SeoAuditRuleId[] = [
	"image_incorrectly_sized",
	"image_too_large"
];

/**
 * Whether the lab's image delivery finding names only images our own image checks already filed on
 * the page, so the same image is not filed twice.
 *
 * @param delivery - The lab finding.
 * @param rules - The page's findings, by rule.
 * @returns Whether the lab finding adds nothing.
 */
function deliveryCovered(
	delivery: AuditFinding,
	rules: ReadonlyMap<SeoAuditRuleId, AuditFinding>
): boolean {
	const own = IMAGE_WEIGHT_RULES.flatMap((ruleId) => rules.get(ruleId) ?? []);
	if (own.length === 0) return false;
	const urls = Array.isArray(delivery.params.urls) ? delivery.params.urls : [];
	const filed = new Set(
		own.flatMap((entry) => (Array.isArray(entry.params.urls) ? entry.params.urls : []))
	);
	const count = Number(delivery.params.urlCount ?? urls.length);
	const ownCount = own.reduce((sum, entry) => sum + Number(entry.params.count ?? 0), 0);
	return urls.length > 0 && count <= ownCount && urls.every((url) => filed.has(url));
}

/**
 * The findings left once each fact is filed once: a finding a more specific or joined check on the
 * same page stands for is dropped.
 *
 * @param findings - The findings.
 * @returns The findings, each fact once.
 */
function withoutSuperseded(findings: readonly AuditFinding[]): AuditFinding[] {
	const onPage = new Map<string, Map<SeoAuditRuleId, AuditFinding>>();
	for (const entry of findings) {
		const rules = onPage.get(entry.pageKey) ?? new Map<SeoAuditRuleId, AuditFinding>();
		if (!rules.has(entry.ruleId)) rules.set(entry.ruleId, entry);
		onPage.set(entry.pageKey, rules);
	}
	return findings.filter((entry) => {
		const rules = onPage.get(entry.pageKey);
		if (rules === undefined) return true;
		if (entry.ruleId === "lh_image_delivery") return !deliveryCovered(entry, rules);
		const by = SEO_AUDIT_SUPERSEDED_BY.get(entry.ruleId) ?? [];
		return !by.some((ruleId) => rules.has(ruleId));
	});
}

/**
 * Adds the whole-site families when asked and the joins over everything filed, then keeps at most one
 * finding per page and rule, a soft 404 filed for that alone, a noindex page judged only for being
 * found and indexed ({@link judgesNoindexPage}), no heading check on a store's cart or
 * checkout page, and each fact once (`SEO_AUDIT_SUPERSEDED_BY` in the catalog); with the whole site, a
 * menu link in http or a whole-site setting (nearly) every page carries is marked as one fix (`once`),
 * and a notice repeated across (nearly) every page of the site or of a template is filed once
 * (`./shared-layout`); a page check on pages of a noindex family is filed once per family
 * (`./families`).
 *
 * @param pageFindings - The per-page findings.
 * @param context - The audit.
 * @param withSite - Whether the whole-site families run.
 * @returns The findings.
 */
function settleFindings(
	pageFindings: AuditFinding[],
	context: AuditContext,
	withSite: boolean
): AuditFinding[] {
	const findings = pageFindings;
	if (withSite)
		for (const family of SITE_FAMILIES) for (const entry of family(context)) findings.push(entry);
	for (const family of JOIN_FAMILIES)
		for (const entry of family(context, [...findings])) findings.push(entry);
	const soft404 = new Set(
		findings.filter((entry) => entry.ruleId === "soft_404_page").map((entry) => entry.pageKey)
	);
	const redirecting = new Set(
		findings.filter((entry) => PAGE_REDIRECT_RULES.has(entry.ruleId)).map((entry) => entry.pageKey)
	);
	const noindexed = new Set(
		findings.filter((entry) => entry.ruleId === "noindex").map((entry) => entry.pageKey)
	);
	const seen = new Set<string>();
	const settled = withoutSuperseded(findings).filter((entry) => {
		const key = `${entry.pageKey}\u0000${entry.ruleId}`;
		if (seen.has(key)) return false;
		if (soft404.has(entry.pageKey) && judgesPageText(entry.ruleId)) return false;
		if (redirecting.has(entry.pageKey) && !judgesRedirectPage(entry.ruleId)) return false;
		if (noindexed.has(entry.pageKey) && !judgesNoindexPage(entry.ruleId)) return false;
		if (HEADING_CHECKS.has(entry.ruleId) && checkoutPage(entry.pageKey)) return false;
		seen.add(key);
		return true;
	});
	if (!withSite) return settled;
	const marked = markSiteSettingFindings(markLayoutSchemeLinks(settled, context), context);
	return foldSharedLayoutFindings(foldFamilyFindings(marked, context), context);
}
