import { schemaFindings, schemaTypesDeep } from "../audit-schema";
import { schemaAncestors } from "../schema-vocabulary";
import { AUDIT_EXAMPLES, finding, htmlSnapshot, indexableSnapshot, isHome } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage, AuditSnapshot } from "./types";

/**
 * THE STRUCTURED DATA RULES of one page: the JSON-LD, microdata and RDFa checks of `../audit-schema`
 * filed under the catalog's severities, a notice when an indexable page carries no structured data at
 * all, and a warning when the markup states a price or a rating the page does not show.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS: the JSON-LD checks run on every 2xx HTML page read from its HTML
 * (broken markup is broken wherever it is); "no structured data" is a notice and only on a page search
 * engines are asked to show, judged from the markup types the snapshot saw (microdata and RDFa count);
 * a price or rating is judged missing only on a page the browser rendered (a script may write it), and
 * only when none of the values stated (a price, a rating or its count) shows anywhere in its text or
 * its labels. A page's own Open Graph type names what it is: an `article` or a `product` page that
 * carries structured data, but none of that kind (any subtype counts), is an insight
 * (`schema_type_expected`); a page with none at all is `structured_data_missing` alone. A page that
 * sells one product ({@link sellsOneProduct}) and states no `Product` (any subtype counts) is a
 * warning (`product_schema_missing`), filed instead of both: product rich results and merchant
 * listings need it. The home page is never asked for one: a site's front page is no article or
 * product, whatever its `og:type` says. Nor is any page asked for an `Article` when `og:type=article`
 * is the site template's default ({@link articleTemplateDefault}): an SEO plugin or a site builder that
 * writes it on nearly every page, its category, about and contact pages included, says nothing about
 * what one page is.
 */

/**
 * The share of the site's read HTML pages carrying `og:type=article` from which it is the template's
 * default, once one of them names another kind of page in its own structured data.
 */
export const ARTICLE_TEMPLATE_SHARE = 0.8;

/** Each audit's answer to {@link articleTemplateDefault}. */
const articleDefaultCache = new WeakMap<AuditContext, boolean>();

/** The structured data types (any subtype counts) that name a kind of page no article is. */
const OTHER_PAGE_TYPES = [
	"CollectionPage",
	"AboutPage",
	"ContactPage",
	"ProfilePage",
	"SearchResultsPage",
	"CheckoutPage",
	"LocalBusiness"
] as const;

/**
 * Whether a stated type names a kind of page no article is: a collection, about, contact, profile,
 * search results or checkout page, or a local business (a restaurant's own page).
 *
 * @param type - The type.
 * @returns Whether it does.
 */
function namesOtherPage(type: string): boolean {
	const kinds = schemaAncestors(type);
	return OTHER_PAGE_TYPES.some((kind) => kinds.has(kind));
}

/**
 * Whether `og:type=article` is the site template's default: at least
 * {@link ARTICLE_TEMPLATE_SHARE} of the read HTML pages carry it, and one of them names another kind of
 * page in its own structured data (a `CollectionPage`, an `AboutPage`, a restaurant). Answered once per
 * audit.
 *
 * @param context - The audit.
 * @returns Whether it is.
 */
function articleTemplateDefault(context: AuditContext): boolean {
	const held = articleDefaultCache.get(context);
	if (held !== undefined) return held;
	let read = 0;
	let articles = 0;
	let otherPage = false;
	for (const page of context.pages) {
		const markup = page.facts?.markup;
		const snapshot = htmlSnapshot(page);
		if (markup == null || snapshot === null) continue;
		read += 1;
		if (!/^article$/i.test((markup.openGraphType ?? "").trim())) continue;
		articles += 1;
		if (!otherPage) otherPage = (snapshot.schemaTypes ?? []).some(namesOtherPage);
	}
	const answer = otherPage && articles >= read * ARTICLE_TEMPLATE_SHARE;
	articleDefaultCache.set(context, answer);
	return answer;
}

/**
 * The Open Graph types a store platform gives a page selling one product (Shopify, WooCommerce with an
 * SEO plugin, PrestaShop, Magento): `product.group` is a category, never one product.
 */
const PRODUCT_OPEN_GRAPH = /^product(?:\.item)?$/i;

/**
 * The paths a store platform reserves for its product pages, where the page then also shows a price
 * and a control that puts the product in the cart: Webflow writes no product Open Graph type, and
 * `/product/` is its product template's fixed path. Calibrated on live stores (2026-10-08): a price
 * and a cart button alone also show on listings (a featured product, a quick-add button), so they
 * never make a product page on their own.
 */
const PRODUCT_PATHS: ReadonlyMap<string, RegExp> = new Map([
	["webflow", /^\/product\/[^/]+\/?$/],
	["shopify", /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/products\/[^/]+\/?$/i]
]);

/**
 * Whether a page sells one product: its Open Graph type says so ({@link PRODUCT_OPEN_GRAPH}), or it
 * sits at its platform's product path and shows a price and an add-to-cart control.
 *
 * @param page - The page.
 * @returns Whether it does.
 */
function sellsOneProduct(page: AuditPage): boolean {
	const markup = page.facts?.markup;
	if (markup == null) return false;
	if (PRODUCT_OPEN_GRAPH.test((markup.openGraph.type ?? "").trim())) return true;
	const path = PRODUCT_PATHS.get(markup.platform ?? "");
	const commerce = markup.commerce;
	if (path === undefined || commerce === undefined) return false;
	const key = page.pageKey;
	const at = key.indexOf("/");
	const pathname = (at < 0 ? "/" : key.slice(at)).split("?")[0] ?? "/";
	return path.test(pathname) && commerce.cartButtons > 0 && commerce.price;
}

/** The structured data type each Open Graph type asks for. */
const EXPECTED_BY_OPEN_GRAPH: readonly (readonly [RegExp, string])[] = [
	[/^article$/i, "Article"],
	[/^product(?:\.|$)/i, "Product"]
];

/**
 * Every structured data type the page states, nested ones included, or null when its structured data
 * was not read whole.
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @returns The types, sorted, or null.
 */
function statedTypes(page: AuditPage, snapshot: AuditSnapshot): string[] | null {
	const blocks = page.facts?.jsonLd ?? [];
	const markup = page.facts?.markup;
	if (blocks.some((block) => block.text === null) || markup?.structuredTruncated === true)
		return null;
	return [
		...new Set([
			...(snapshot.schemaTypes ?? []),
			...schemaTypesDeep(blocks, markup?.structuredItems ?? [])
		])
	].sort();
}

/**
 * Whether one of the types is the given type or a kind of it.
 *
 * @param types - The types stated.
 * @param expected - The type asked for.
 * @returns Whether one is.
 */
function states(types: readonly string[], expected: string): boolean {
	return types.some((type) => schemaAncestors(type).has(expected));
}

/**
 * The structured data type the page's Open Graph type asks for and its markup lacks, or null.
 *
 * @param page - The page.
 * @param types - The types it states.
 * @returns The expected type and the types the page states, or null.
 */
function expectedType(
	page: AuditPage,
	types: readonly string[]
): { expected: string; types: string[] } | null {
	const ogType = (page.facts?.markup?.openGraph.type ?? "").trim();
	const expected = EXPECTED_BY_OPEN_GRAPH.find(([pattern]) => pattern.test(ogType))?.[1];
	if (expected === undefined || types.length === 0) return null;
	return states(types, expected) ? null : { expected, types: [...types] };
}

/**
 * The structured data findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function structuredDataFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const snapshot = htmlSnapshot(page);
	if (snapshot === null || snapshot.mode === "rendered") return [];
	const key = page.pageKey;
	const blocks = page.facts?.jsonLd ?? [];
	const markup = page.facts?.markup ?? null;
	const found = schemaFindings(blocks, {
		items: markup?.structuredItems ?? [],
		truncated: markup?.structuredTruncated === true
	}).map((entry) => finding(key, entry.ruleId, entry.params));
	const indexable = indexableSnapshot(page, context) !== null;
	if (indexable && blocks.length === 0 && (snapshot.schemaTypes ?? []).length === 0) {
		found.push(finding(key, "structured_data_missing"));
	}
	const judged = indexable && !isHome(page, context) ? statedTypes(page, snapshot) : null;
	const expected = judged === null ? null : expectedType(page, judged);
	if (expected !== null && !(expected.expected === "Article" && articleTemplateDefault(context)))
		found.push(finding(key, "schema_type_expected", expected));
	if (judged !== null && sellsOneProduct(page) && !states(judged, "Product"))
		found.push(finding(key, "product_schema_missing", { types: judged }));
	const hidden = (markup?.markedValues ?? []).filter((entry) => !entry.visible);
	if (indexable && (page.fetchMode ?? snapshot.mode) === "browser" && hidden.length > 0) {
		found.push(
			finding(key, "schema_content_mismatch", {
				count: hidden.length,
				items: hidden
					.slice(0, AUDIT_EXAMPLES)
					.map((entry) => ({ type: entry.type, property: entry.property, values: entry.values }))
			})
		);
	}
	return found;
}
