import { crawlTrapOf } from "../discovery";
import { technicalKey } from "./duplicates";
import { linksFrom, linkSpelling, linksTo, robotsDisallowed } from "./lookups";
import { AUDIT_EXAMPLES, canonicalKey, crawlBlocked, finding, htmlSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage, AuditSitePage } from "./types";

/**
 * THE URL HYGIENE RULES: how the site spells its own URLs. The page key keeps the path's letter case,
 * its percent-encoding and the query (sorted, tracking parameters dropped); the spellings the key
 * hides (a doubled slash, a tracking parameter, an AJAX `#!`) are read from the URL the crawler fetched
 * and from the site's own links.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - uppercase, underscores, non-ASCII letters and parameters are INSIGHTS: valid URLs search engines
 *   read fine, listed so they can be filtered on;
 * - a repeated folder counts only when a run of folders repeats back to back and holds a word (a date
 *   such as `/2024/10/10/` is not a repeat);
 * - whitespace counts in the path only (a query's `+` is a space by design);
 * - tracking and session parameters count on the site's own links, never on a URL a search engine or
 *   an analytics tool reported;
 * - two URLs that differ only by letter case or by `www.` are duplicates only when both answer a page
 *   and they do not name one canonical;
 * - a site builder's default slug (`/new-page-3`, `/untitled`, `/copy-of-about`, `/page-2` at the
 *   root, where it is no pager's) is an INSIGHT, on a page that answers HTML: the address says nothing
 *   to readers or search engines;
 * - a URL with so many parameters the crawler leaves it as a crawl trap is never read, so its
 *   parameters are filed from the followed links that name it (with those pages), unless robots.txt
 *   already keeps search engines off it.
 */

/**
 * The rules that can file on a URL the crawler never reads (a crawl trap): every audit judges them
 * anew, so one stops being open as soon as it no longer fires.
 */
export const UNCRAWLED_URL_RULES: ReadonlySet<string> = new Set(["url_parameters"]);

/** Query parameters that carry a visitor's session. */
const SESSION_PARAMS = new Set([
	"sid",
	"sessionid",
	"session_id",
	"sessid",
	"phpsessid",
	"jsessionid",
	"aspsessionid",
	"cfid",
	"cftoken"
]);

/** Query parameters that only track a visit (`utm_*` and the named click ids). */
const TRACKING_PARAMS = new Set([
	"fbclid",
	"gclid",
	"gbraid",
	"wbraid",
	"dclid",
	"msclkid",
	"yclid",
	"twclid",
	"ttclid",
	"li_fat_id",
	"mc_cid",
	"mc_eid",
	"_ga",
	"_gl",
	"_hsenc",
	"_hsmi",
	"__hstc",
	"__hssc",
	"__hsfp",
	"igshid",
	"srsltid"
]);

/** Parameter names by the kind of page they make. */
const PARAMETER_KINDS: Record<string, readonly string[]> = {
	sort: ["sort", "sortby", "sort_by", "order", "orderby", "order_by", "dir", "direction"],
	filter: [
		"filter",
		"filters",
		"color",
		"colour",
		"size",
		"brand",
		"price",
		"min_price",
		"max_price"
	],
	search: ["q", "s", "search", "query", "keyword", "keywords", "searchterm", "search_query"],
	pagination: ["page", "p", "pg", "paged", "offset", "start"]
};

/** Parameters a URL may hold before it has "many". */
const MANY_PARAMETERS = 3;

/**
 * The path and the query of a page key.
 *
 * @param key - The key.
 * @returns Its path (from the first `/`) and its query (after `?`, empty when none).
 */
function partsOf(key: string): { path: string; query: string } {
	const slash = key.indexOf("/");
	const rest = slash === -1 ? "/" : key.slice(slash);
	const mark = rest.indexOf("?");
	return mark === -1
		? { path: rest, query: "" }
		: { path: rest.slice(0, mark), query: rest.slice(mark + 1) };
}

/**
 * A query's parameters, names lowercased and values decoded.
 *
 * @param query - The query, without `?`.
 * @returns The pairs.
 */
function paramsOf(query: string): [string, string][] {
	if (query === "") return [];
	return [...new URLSearchParams(query).entries()].map(([name, value]) => [
		name.toLowerCase(),
		value
	]);
}

/**
 * Whether a parameter only tracks a visit.
 *
 * @param name - The parameter name, lowercased.
 * @returns Whether it does.
 */
function tracking(name: string): boolean {
	return name.startsWith("utm_") || TRACKING_PARAMS.has(name);
}

/** The folders of a path the repetition check reads (its work grows with the cube of their count). */
const MAX_PATH_SEGMENTS = 64;

/**
 * Whether a path repeats a run of folders back to back (`/shop/shop`, `/a/b/a/b`), a run that holds
 * at least one word.
 *
 * @param path - The path.
 * @returns Whether it does.
 */
function repetitivePath(path: string): boolean {
	const segments = path
		.split("/")
		.filter((segment) => segment !== "")
		.slice(0, MAX_PATH_SEGMENTS);
	for (let size = 1; size * 2 <= segments.length; size += 1) {
		for (let start = 0; start + size * 2 <= segments.length; start += 1) {
			const run = segments.slice(start, start + size);
			if (!run.some((segment) => /[a-z]/i.test(segment))) continue;
			if (run.every((segment, at) => segments[start + size + at] === segment)) return true;
		}
	}
	return false;
}

/** A site builder's default slug at any depth: a new, untitled or copied page never renamed. */
const DEFAULT_SLUG = /^(?:new-page(?:-\d+)?|untitled(?:-page)?(?:-\d+)?|copy-of-[a-z0-9-]+)$/i;

/** A numbered page slug, a builder's default only at the root (deeper, it is often a pager's). */
const ROOT_NUMBERED_SLUG = /^page-\d+$/i;

/**
 * A site builder's default slug of a path: its last folder when it is one the builder gave a new
 * page (`new-page-3`, `untitled`, `copy-of-about`, `page-2` alone at the root).
 *
 * @param path - The path.
 * @returns The slug, or null when the path names its page.
 */
function defaultSlugOf(path: string): string | null {
	const segments = path.split("/").filter((segment) => segment !== "");
	const last = segments.at(-1);
	if (last === undefined) return null;
	if (DEFAULT_SLUG.test(last)) return last;
	return segments.length === 1 && ROOT_NUMBERED_SLUG.test(last) ? last : null;
}

/**
 * The kinds of parameter a query holds: sort, filter, search, pagination, many, a name repeated, a
 * second `?`, or other.
 *
 * @param params - The parameters.
 * @returns The kinds, in a fixed order.
 */
function parameterKinds(params: readonly [string, string][]): string[] {
	const names = params.map(([name]) => name);
	const kinds = new Set<string>();
	for (const [kind, list] of Object.entries(PARAMETER_KINDS)) {
		if (names.some((name) => list.includes(name))) kinds.add(kind);
	}
	if (names.length > MANY_PARAMETERS) kinds.add("many");
	if (new Set(names).size < names.length) kinds.add("repeated");
	if (params.some(([, value]) => value.includes("?"))) kinds.add("second_question_mark");
	if (kinds.size === 0) kinds.add("other");
	return [...kinds];
}

/**
 * The spellings the page was reached by: the URL the crawler fetched, and the URLs the site's links
 * wrote for it.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns The spellings.
 */
function spellingsOf(page: AuditPage, context: AuditContext): string[] {
	const first = page.facts?.redirectChain[0]?.url ?? page.snapshot?.redirectChain[0]?.url;
	const linked = (linksTo(context).get(context.resolve(page.pageKey)) ?? []).map(linkSpelling);
	return [...(first === undefined ? [] : [first]), ...linked];
}

/**
 * The path of a URL as written, or null when it is not one.
 *
 * @param url - The URL.
 * @returns The path.
 */
function writtenPath(url: string): string | null {
	const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url);
	return match === null ? null : (match[1] ?? "");
}

/**
 * The URL hygiene findings of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its findings.
 */
export function urlFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	if (crawlBlocked(page)) return [];
	const key = page.pageKey;
	const found: AuditFinding[] = [];
	const { path, query } = partsOf(key);
	const params = paramsOf(query);
	const plainPath = path.replace(/%[0-9a-f]{2}/gi, "");

	const doubled = spellingsOf(page, context).find((url) => (writtenPath(url) ?? "").includes("//"));
	if (doubled !== undefined) found.push(finding(key, "url_multiple_slashes", { url: doubled }));
	if (/[A-Z]/.test(plainPath)) found.push(finding(key, "url_uppercase"));
	if (/%(?:20|09|0a|0d)/i.test(path)) found.push(finding(key, "url_whitespace"));
	if (/%[89a-f][0-9a-f]/i.test(path)) found.push(finding(key, "url_non_ascii"));
	if (plainPath.includes("_")) found.push(finding(key, "url_underscores"));
	if (repetitivePath(path)) found.push(finding(key, "url_repetitive_path"));
	const slug = htmlSnapshot(page) === null ? null : defaultSlugOf(path);
	if (slug !== null) found.push(finding(key, "url_default_slug", { slug }));
	const searching =
		params.some(([name]) => PARAMETER_KINDS.search?.includes(name) === true) ||
		(params.length > 0 && /(?:^|\/)search(?:\/|$)/i.test(path));
	const kinds = parameterKinds(params).filter((kind) => !searching || kind !== "search");
	if (params.length > 0 && kinds.length > 0)
		found.push(finding(key, "url_parameters", { kinds, count: params.length }));
	if (searching) found.push(finding(key, "url_internal_search"));
	if (page.facts?.markup?.ajaxFragmentMeta === true) {
		found.push(finding(key, "url_ajax_fragment", { kind: "meta" }));
	}

	const carried = (linksFrom(context).get(key) ?? []).map(linkSpelling).filter((url) => {
		const mark = url.indexOf("?");
		if (mark === -1) return /;jsessionid=/i.test(url);
		const names = paramsOf(url.slice(mark + 1).split("#")[0] ?? "").map(([name]) => name);
		return (
			/;jsessionid=/i.test(url) || names.some((name) => tracking(name) || SESSION_PARAMS.has(name))
		);
	});
	if (carried.length > 0) {
		found.push(
			finding(key, "url_session_or_tracking", {
				count: carried.length,
				urls: [...new Set(carried)].slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	if (page.facts?.markup?.ajaxFragmentMeta !== true) {
		const hashBang = (linksFrom(context).get(key) ?? [])
			.map(linkSpelling)
			.filter((url) => url.includes("#!"));
		if (hashBang.length > 0) {
			found.push(
				finding(key, "url_ajax_fragment", {
					kind: "links",
					count: hashBang.length,
					urls: [...new Set(hashBang)].slice(0, AUDIT_EXAMPLES)
				})
			);
		}
	}
	return found;
}

/**
 * The technical duplicates: two crawled URLs that differ only by letter case or by `www.`, both
 * answering a page, that do not name one canonical. Each is filed with the other.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function technicalDuplicateFindings(context: AuditContext): AuditFinding[] {
	const groups = new Map<string, AuditSitePage[]>();
	for (const page of context.pages) {
		if (htmlSnapshot(page) === null) continue;
		const folded = technicalKey(page.pageKey);
		const list = groups.get(folded) ?? [];
		list.push(page);
		groups.set(folded, list);
	}
	const found: AuditFinding[] = [];
	for (const members of groups.values()) {
		if (members.length < 2) continue;
		const targets = members.map(
			(member) => canonicalKey(member, context) ?? context.resolve(member.pageKey)
		);
		if (new Set(targets).size < targets.length) continue;
		for (const member of members) {
			found.push(
				finding(member.pageKey, "url_technical_duplicate", {
					duplicates: members
						.filter((other) => other !== member)
						.map((other) => other.pageKey)
						.slice(0, AUDIT_EXAMPLES)
				})
			);
		}
	}
	return found;
}

/**
 * The URLs the crawler left as crawl traps for their many parameters, each filed with its parameters
 * and the pages whose followed links name it. A URL robots.txt keeps search engines off, one the crawl
 * read after all, or one only nofollow links name is not filed.
 *
 * @param context - The audit.
 * @returns The findings, filed on the URLs never read.
 */
export function trapParameterFindings(context: AuditContext): AuditFinding[] {
	const sources = new Map<string, Set<string>>();
	for (const link of context.links) {
		const key = link.targetKey;
		if (link.nofollow === true || context.byKey.has(key) || context.resolve(key) !== key) continue;
		if (crawlTrapOf(key) !== "query_params") continue;
		const source = context.byKey.get(link.sourceKey);
		if (source === undefined || htmlSnapshot(source) === null) continue;
		sources.set(key, (sources.get(key) ?? new Set()).add(link.sourceKey));
	}
	const found: AuditFinding[] = [];
	for (const [key, pages] of sources) {
		if (robotsDisallowed(key, context)) continue;
		const params = paramsOf(partsOf(key).query);
		found.push(
			finding(key, "url_parameters", {
				kinds: parameterKinds(params),
				count: params.length,
				pages: [...pages].sort().slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	return found;
}
