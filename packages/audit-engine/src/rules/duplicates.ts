import { normalizePageUrl } from "../urls";

import { primaryLanguage, sameLanguage } from "../language";
import { decodeSignature, signatureSimilarity } from "../minhash";
import {
	containedPairs,
	languagesApart,
	NEAR_DUPLICATE_THRESHOLD,
	nearDuplicates
} from "./near-duplicates";
import type { ContainedPair, NearDuplicate } from "./near-duplicates";
import { AUDIT_EXAMPLES, finding, indexableSnapshot, thresholdsOf } from "./page-state";
import { firstPageKey } from "./pagination";
import type { AuditContext, AuditFinding, AuditSitePage, AuditSiteSnapshot } from "./types";
import type { SeoAuditRuleId } from "../catalog";

/**
 * THE DUPLICATION RULES: pages sharing a title, a description, an H1 or their main text, pages whose
 * main text is nearly the same (MinHash of the rendered page's main text, `./near-duplicates`),
 * descriptions stamped from one template, and language versions left untranslated.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - only pages search engines are asked to show are compared: a duplicate that points its canonical
 *   to the original, or is noindex, is already handled and never flagged;
 * - pages of one hreflang set (the same page in another language or region) may share a title and
 *   their text and are never each other's duplicates, nor are two pages declaring different languages
 *   for themselves in hreflang (a versioned or paged copy's language versions), nor two pages without
 *   hreflang that are written in different languages (`<html lang>` when the text reads in it, else
 *   the one language the text reads as: a docs site's translations sharing the title "Introduction",
 *   or the product name "SnBNB" as their H1 under a template that declares `en` everywhere); a set is
 *   "untranslated" only when two versions declared in DIFFERENT languages carry nearly the same text
 *   (an en-US and an en-GB page may rightly read alike);
 * - "same text" and "nearly the same text" need {@link DUPLICATE_BODY_MIN_WORDS} words, so short stubs
 *   are not compared, and a page is never the near-duplicate of a page with its very same text (that
 *   is the exact duplicate);
 * - a page whose text sits nearly whole inside a longer page's (the near-duplicate share of it, 90% by
 *   default) is a near-duplicate of it too, marked `contained`, only when both are content pages of
 *   at least {@link CONTAINED_MIN_WORDS} words: never the home page, a listing, an archive, a tag, a
 *   category, a collection, an author or a search page, a page of a paginated series, nor a page that
 *   holds two or more other pages whole or links to the page it holds (a page that shows posts is a
 *   listing whatever its address);
 * - a template needs {@link TEMPLATE_MIN_PAGES} pages;
 * - the pages of one paginated series (`?page=2`, `/page/2`, or linked by `rel=next/prev`) may share a
 *   title and a description: search engines read each page of a series on its own, and a missing
 *   "Page 2" in the title costs nothing.
 */

/** The words a page's main text needs before its text is compared with other pages'. */
export const DUPLICATE_BODY_MIN_WORDS = 100;

/** The words each of two pages needs before one is called contained in the other. */
export const CONTAINED_MIN_WORDS = 300;

/** A path segment that names a listing: tags, categories, collections, labels, archives, authors, search results. */
const LISTING_SEGMENT =
	/^(?:tags?|categor(?:y|ies)|collections?|labels?|archives?|authors?|search)$/i;

/** A query parameter that lists pages: a tag, a category, a label, an author, a search. */
const LISTING_PARAM = /[?&](?:tag|cat|category|label|author|s|q|search)=/i;

/** A date archive's path: a year, a month or a day, and nothing after it. */
const DATE_ARCHIVE = /^\/\d{4}(?:\/\d{1,2}){0,2}$/;

/** The structured data types of a page that lists other pages. */
const LISTING_TYPES: ReadonlySet<string> = new Set([
	"collectionpage",
	"searchresultspage",
	"itemlist",
	"blog"
]);

/** The pages one description template needs before it is filed. */
export const TEMPLATE_MIN_PAGES = 5;

/** One page entering the duplication rules. */
interface Candidate {
	page: AuditSitePage;
	snapshot: AuditSiteSnapshot;
	title: string;
	desc: string;
	h1: string;
	/** The text fingerprint and its stored form, when the page has enough text to compare. */
	signature: { values: Uint32Array; stored: string } | null;
	/**
	 * The language the page declares for itself in hreflang, else the language it is written in
	 * (`writtenLanguage`), or "".
	 */
	language: string;
}

/**
 * Lowercased, whitespace-collapsed text.
 *
 * @param value - The text.
 * @returns The normalized text.
 */
function normalized(value: string | null | undefined): string {
	return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A page's hreflang alternates with the page each lands on.
 *
 * @param candidate - The page.
 * @param context - The audit.
 * @returns Each alternate's language and landing key.
 */
function alternateKeys(
	candidate: Candidate,
	context: AuditContext
): { lang: string; key: string }[] {
	const { page, snapshot } = candidate;
	return (page.facts?.hreflang ?? snapshot.hreflang ?? []).flatMap((entry) => {
		const key = normalizePageUrl(entry.url, page.pageKey.split("/")[0]);
		return key === null ? [] : [{ lang: entry.lang, key: context.resolve(key) }];
	});
}

/**
 * The language a page declares for itself in hreflang (its own entry, `x-default` aside), or "".
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @param context - The audit.
 * @returns The language code, or "".
 */
function ownHreflangLanguage(
	page: AuditSitePage,
	snapshot: AuditSiteSnapshot,
	context: AuditContext
): string {
	const own = context.resolve(page.pageKey);
	for (const entry of page.facts?.hreflang ?? snapshot.hreflang ?? []) {
		if (entry.lang.toLowerCase() === "x-default") continue;
		const key = normalizePageUrl(entry.url, page.pageKey.split("/")[0]);
		if (key !== null && context.resolve(key) === own) return entry.lang;
	}
	return "";
}

/**
 * The language a page is written in: its `<html lang>` when its main text reads in that language;
 * else, when the text rules the declared language out, the likeliest language the text reads as (a
 * translation whose template still declares the site's first language, `lang="en"` over French or
 * Italian text; an untranslated copy declaring `es` over English text reads as English, so it is
 * still compared with the English page); without a declared language, the one language the text
 * reads as when it reads as one alone; else "" (a text too short or too mixed to tell).
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @returns The language code, or "".
 */
export function writtenLanguage(page: AuditSitePage, snapshot: AuditSiteSnapshot): string {
	const declared = (page.facts?.markup?.lang.html ?? snapshot.lang ?? "").trim();
	const read = page.facts?.text?.languages ?? null;
	const likeliest = read?.[0];
	if (read === null || likeliest === undefined) return "";
	const declares = primaryLanguage(declared) !== "";
	if (declares && read.some((language) => sameLanguage(language, declared))) return declared;
	return declares || read.length === 1 ? likeliest : "";
}

/**
 * The pages each page is never compared with: its hreflang set (both directions) and its technical
 * twins (the same page under another letter case or `www.`).
 *
 * @param candidates - The pages.
 * @param context - The audit.
 * @returns Page key to the keys it must not be compared with.
 */
function alternatesOf(
	candidates: readonly Candidate[],
	context: AuditContext
): Map<string, Set<string>> {
	const sets = new Map<string, Set<string>>();
	const link = (left: string, right: string): void => {
		if (left === right) return;
		sets.set(left, (sets.get(left) ?? new Set()).add(right));
		sets.set(right, (sets.get(right) ?? new Set()).add(left));
	};
	const twins = new Map<string, string>();
	for (const candidate of candidates) {
		const key = candidate.page.pageKey;
		for (const alternate of alternateKeys(candidate, context)) link(key, alternate.key);
		const folded = technicalKey(key);
		const first = twins.get(folded);
		if (first === undefined) twins.set(folded, key);
		else link(first, key);
	}
	return sets;
}

/**
 * A page key with `www.` and letter case folded away: two pages sharing it are one page at two URLs,
 * filed once by `url_technical_duplicate` (`./urls`), never again as duplicates of each other.
 *
 * @param pageKey - The page key.
 * @returns The folded key.
 */
export function technicalKey(pageKey: string): string {
	return pageKey.replace(/^www\./i, "").toLowerCase();
}

/** A key whose path ends in a bare number (`/blog/2`), split into the listing's key and the number. */
const NUMBERED_PATH = /^([^?#]+\/[^/?#]+)\/(\d{1,4})\/?$/;

/**
 * The listing a page numbers, when its key ends in a bare page number (`/blog/2`, as Astro and other
 * generators paginate) and it carries the very title of the listing's own page (`/blog`): the key of
 * that listing, else null. A product or post id (`/product/123`) never shares its listing's title.
 *
 * @param key - The page key.
 * @param title - Its normalized title.
 * @param titles - Every candidate's normalized title by key.
 * @returns The listing's key, or null.
 */
function numberedListingOf(
	key: string,
	title: string,
	titles: ReadonlyMap<string, string>
): string | null {
	const match = NUMBERED_PATH.exec(key);
	if (match === null || title === "" || Number(match[2]) < 2) return null;
	const listing = match[1] ?? "";
	return titles.get(listing) === title ? listing : null;
}

/**
 * Which paginated series each page belongs to: pages whose keys differ only by their page number
 * (`?page=2`, `/page/2`, or a listing's `/blog/2` titled as the listing), joined with the pages their
 * `rel=next/prev` links name.
 *
 * @param candidates - The pages.
 * @param context - The audit.
 * @returns Whether two pages are of one series.
 */
function seriesOf(
	candidates: readonly Candidate[],
	context: AuditContext
): (left: string, right: string) => boolean {
	const parent = new Map<string, string>();
	const root = (key: string): string => {
		let at = key;
		for (let next = parent.get(at); next !== undefined && next !== at; next = parent.get(at)) {
			at = next;
		}
		parent.set(key, at);
		return at;
	};
	const join = (left: string, right: string): void => {
		const a = root(left);
		const b = root(right);
		if (a !== b) parent.set(a, b);
	};
	const titles = new Map(candidates.map((candidate) => [candidate.page.pageKey, candidate.title]));
	for (const { page, title } of candidates) {
		const key = page.pageKey;
		join(key, `series:${firstPageKey(key)}`);
		const listing = numberedListingOf(key, title, titles);
		if (listing !== null) join(key, `series:${firstPageKey(listing)}`);
		const pagination = page.facts?.markup?.pagination;
		for (const url of [...(pagination?.next ?? []), ...(pagination?.prev ?? [])]) {
			const target = normalizePageUrl(url, key.split("/")[0]);
			if (target !== null) join(key, `series:${firstPageKey(context.resolve(target))}`);
		}
	}
	return (left, right) => root(left) === root(right);
}

/**
 * Findings for pages sharing one exact value.
 *
 * @param candidates - The pages.
 * @param value - The value each page is grouped by ("" is never grouped).
 * @param ruleId - The rule.
 * @param apart - The pages each page is not compared with (pages declaring different hreflang
 *   languages for themselves are never compared either).
 * @param sameText - Whether two pages carry the same main text, or nearly: such pages are compared
 *   only by their text (a page served under two URLs is `duplicate_body` or `duplicate_content` once,
 *   never also a duplicate title, description or H1); for titles and descriptions, also whether they
 *   are pages of one paginated series.
 * @returns One finding per page in a group of two or more.
 */
function exactGroups(
	candidates: readonly Candidate[],
	value: (candidate: Candidate) => string,
	ruleId: SeoAuditRuleId,
	apart: Map<string, Set<string>>,
	sameText: (left: string, right: string) => boolean = () => false
): AuditFinding[] {
	const byValue = new Map<string, string[]>();
	const languageOf = new Map(candidates.map((c) => [c.page.pageKey, c.language]));
	for (const candidate of candidates) {
		const text = value(candidate);
		if (text === "") continue;
		const keys = byValue.get(text);
		if (keys === undefined) byValue.set(text, [candidate.page.pageKey]);
		else keys.push(candidate.page.pageKey);
	}
	const found: AuditFinding[] = [];
	for (const keys of byValue.values()) {
		if (keys.length < 2) continue;
		const sorted = [...keys].sort();
		for (const key of sorted) {
			const kept = apart.get(key) ?? new Set<string>();
			const others = sorted.filter(
				(other) =>
					other !== key &&
					!kept.has(other) &&
					!languagesApart(languageOf.get(key), languageOf.get(other)) &&
					!sameText(key, other)
			);
			if (others.length === 0) continue;
			found.push(
				finding(key, ruleId, { count: others.length, pages: others.slice(0, AUDIT_EXAMPLES) })
			);
		}
	}
	return found;
}

/**
 * The hash of a page's main text when it is long enough to be compared, else "".
 *
 * @param candidate - The page.
 * @returns The hash, or "".
 */
function bodyHash(candidate: Candidate): string {
	return (candidate.snapshot.wordCount ?? 0) >= DUPLICATE_BODY_MIN_WORDS
		? (candidate.snapshot.mainTextHash ?? "")
		: "";
}

/**
 * A description with the page's own title and H1 cut out, or "" when neither appears in it.
 *
 * @param candidate - The page.
 * @returns The template.
 */
function templateOf(candidate: Candidate): string {
	let text = candidate.desc;
	let swapped = false;
	for (const part of [candidate.title, candidate.h1]) {
		if (part.length < 3 || !text.includes(part)) continue;
		text = text.split(part).join("\u0000");
		swapped = true;
	}
	return swapped && text.replaceAll("\u0000", "").trim().length >= 20 ? text : "";
}

/**
 * A page's text fingerprint, when it has enough text to be compared.
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @returns The fingerprint, or null.
 */
function signatureOf(
	page: AuditSitePage,
	snapshot: AuditSiteSnapshot
): { values: Uint32Array; stored: string } | null {
	const stored = page.facts?.text?.minhash ?? null;
	if (stored === null || (snapshot.wordCount ?? 0) < DUPLICATE_BODY_MIN_WORDS) return null;
	const values = decodeSignature(stored);
	return values === null ? null : { values, stored };
}

/**
 * The pages whose main text is nearly another page's, with their near-duplicate group.
 *
 * @param candidates - The pages.
 * @param apart - The pages each page is not compared with.
 * @param similarity - The overlap from which two texts are near-duplicates.
 * @returns The near-duplicates.
 */
function nearDuplicatesOf(
	candidates: readonly Candidate[],
	apart: Map<string, Set<string>>,
	similarity: number
): NearDuplicate[] {
	return nearDuplicates(
		candidates.flatMap(({ page, snapshot, signature, language }) =>
			signature === null
				? []
				: [
						{
							pageKey: page.pageKey,
							signature: signature.values,
							stored: signature.stored,
							textHash: snapshot.mainTextHash ?? signature.stored,
							language
						}
					]
		),
		apart,
		similarity
	);
}

/**
 * The pages numbered under one path that share one title (`/podcast/episodes/2` and `/4`, both titled
 * as the podcast): the pages of a series, whatever names its first page.
 *
 * @param candidates - The pages.
 * @returns Their keys.
 */
function numberedSeriesPages(candidates: readonly Candidate[]): ReadonlySet<string> {
	const groups = new Map<string, string[]>();
	for (const { page, title } of candidates) {
		const match = NUMBERED_PATH.exec(page.pageKey);
		if (match === null || title === "") continue;
		const group = `${match[1] ?? ""}\u0000${title}`;
		groups.set(group, [...(groups.get(group) ?? []), page.pageKey]);
	}
	return new Set([...groups.values()].filter((keys) => keys.length > 1).flat());
}

/**
 * Whether a page lists other pages rather than being one: the home page, a page of a paginated series
 * or one that starts a series, a tag, category, collection, label, archive, author or search page by
 * its address, a date archive (`/2024/05`), or a page whose structured data says it is a collection
 * or a list.
 *
 * @param candidate - The page.
 * @param context - The audit.
 * @param numbered - The pages numbered under one path that share one title.
 * @returns Whether it does.
 */
function listingPage(
	candidate: Candidate,
	context: AuditContext,
	numbered: ReadonlySet<string>
): boolean {
	const key = candidate.page.pageKey;
	if (key === context.site.homeKey || firstPageKey(key) !== key || LISTING_PARAM.test(key))
		return true;
	if (numbered.has(key)) return true;
	const path = key.slice(Math.max(key.indexOf("/"), 0)).split("?")[0] ?? "";
	if (path === "/" || DATE_ARCHIVE.test(path)) return true;
	if (path.split("/").some((segment) => LISTING_SEGMENT.test(segment))) return true;
	const pagination = candidate.page.facts?.markup?.pagination;
	if ((pagination?.next.length ?? 0) > 0 || (pagination?.prev.length ?? 0) > 0) return true;
	return (candidate.snapshot.schemaTypes ?? []).some((type) =>
		LISTING_TYPES.has(type.toLowerCase())
	);
}

/**
 * The content pages whose text sits nearly whole inside another content page's, the pairs already
 * near-duplicates, of the very same text or never compared aside. A page that holds two or more
 * others whole, or links to the page it holds, shows them as a listing does (an excerpt and its
 * "read more"), so none of those pairs is kept.
 *
 * @param candidates - The pages.
 * @param context - The audit.
 * @param skip - Whether a pair is never compared.
 * @param share - The share of the shorter text from which it is contained.
 * @returns The pairs.
 */
function containedOf(
	candidates: readonly Candidate[],
	context: AuditContext,
	skip: (left: string, right: string) => boolean,
	share: number
): ContainedPair[] {
	const numbered = numberedSeriesPages(candidates);
	const pairs = containedPairs(
		candidates.flatMap((candidate) =>
			candidate.signature === null ||
			(candidate.snapshot.wordCount ?? 0) < CONTAINED_MIN_WORDS ||
			listingPage(candidate, context, numbered)
				? []
				: [
						{
							pageKey: candidate.page.pageKey,
							signature: candidate.signature.values,
							words: candidate.snapshot.wordCount ?? 0
						}
					]
		),
		skip,
		share
	);
	const held = new Map<string, number>();
	for (const pair of pairs) held.set(pair.outer, (held.get(pair.outer) ?? 0) + 1);
	return pairs.filter(
		(pair) =>
			(held.get(pair.outer) ?? 0) < 2 &&
			!(context.links.from(pair.outer) ?? []).some(
				(link) => link.targetKey === pair.inner || context.resolve(link.targetKey) === pair.inner
			)
	);
}

/**
 * The near-duplicate findings: pages whose main text is nearly another page's, or sits nearly whole
 * inside it (a partner marked `contained`, its score the share of the shorter page's text inside the
 * longer one).
 *
 * @param near - The near-duplicates.
 * @param contained - The contained pairs.
 * @returns The findings.
 */
function nearDuplicateFindings(
	near: readonly NearDuplicate[],
	contained: readonly ContainedPair[]
): AuditFinding[] {
	const rounded = (score: number): number => Math.round(score * 1000) / 1000;
	const inside = new Map<string, { pageKey: string; score: number }[]>();
	for (const pair of contained) {
		for (const [pageKey, other] of [
			[pair.inner, pair.outer],
			[pair.outer, pair.inner]
		] as const) {
			const list = inside.get(pageKey) ?? [];
			list.push({ pageKey: other, score: pair.share });
			inside.set(pageKey, list);
		}
	}
	const found: AuditFinding[] = [];
	for (const entry of near) {
		const extra = inside.get(entry.pageKey) ?? [];
		inside.delete(entry.pageKey);
		found.push(
			finding(entry.pageKey, "duplicate_content", {
				count: entry.count + extra.length,
				similar: [
					...entry.partners.map((partner) => ({
						pageKey: partner.pageKey,
						score: rounded(partner.score)
					})),
					...extra.map((partner) => ({
						pageKey: partner.pageKey,
						score: rounded(partner.score),
						contained: true
					}))
				].slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	for (const [pageKey, partners] of [...inside].sort(([left], [right]) =>
		left.localeCompare(right)
	)) {
		const sorted = [...partners].sort(
			(left, right) => right.score - left.score || left.pageKey.localeCompare(right.pageKey)
		);
		found.push(
			finding(pageKey, "duplicate_content", {
				count: sorted.length,
				similar: sorted.slice(0, AUDIT_EXAMPLES).map((partner) => ({
					pageKey: partner.pageKey,
					score: rounded(partner.score),
					contained: true
				}))
			})
		);
	}
	return found;
}

/**
 * The untranslated language versions: an hreflang alternate declared in another language whose main
 * text is nearly this page's.
 *
 * @param candidates - The pages.
 * @param context - The audit.
 * @returns The findings.
 */
function untranslatedFindings(
	candidates: readonly Candidate[],
	context: AuditContext
): AuditFinding[] {
	const byKey = new Map(candidates.map((candidate) => [candidate.page.pageKey, candidate]));
	const found: AuditFinding[] = [];
	for (const candidate of candidates) {
		if (candidate.signature === null) continue;
		const key = candidate.page.pageKey;
		const alternates = alternateKeys(candidate, context).filter(
			(entry) => entry.lang.toLowerCase() !== "x-default"
		);
		const own =
			alternates.find((entry) => entry.key === context.resolve(key))?.lang ??
			candidate.page.facts?.markup?.lang.html ??
			candidate.snapshot.lang ??
			"";
		if (primaryLanguage(own) === "") continue;
		const untranslated = new Set<string>();
		for (const entry of alternates) {
			const other = byKey.get(entry.key);
			if (other === undefined || entry.key === key || other.signature === null) continue;
			if (sameLanguage(entry.lang, own)) continue;
			const score = signatureSimilarity(candidate.signature.values, other.signature.values);
			if (score >= NEAR_DUPLICATE_THRESHOLD) untranslated.add(entry.key);
		}
		if (untranslated.size === 0) continue;
		const pages = [...untranslated].sort();
		found.push(
			finding(key, "translation_missing", {
				count: pages.length,
				pages: pages.slice(0, AUDIT_EXAMPLES)
			})
		);
	}
	return found;
}

/**
 * The duplication findings of the whole site.
 *
 * @param context - The audit.
 * @returns The findings.
 */
export function duplicateFindings(context: AuditContext): AuditFinding[] {
	const candidates: Candidate[] = context.pages.flatMap((page) => {
		const snapshot = indexableSnapshot(page, context);
		if (snapshot === null) return [];
		return [
			{
				page,
				snapshot,
				title: normalized(snapshot.title),
				desc: normalized(snapshot.metaDescription),
				h1: (page.facts?.page?.h1Count ?? snapshot.h1Count ?? 1) > 1 ? "" : normalized(snapshot.h1),
				signature: signatureOf(page, snapshot),
				language: ownHreflangLanguage(page, snapshot, context) || writtenLanguage(page, snapshot)
			}
		];
	});
	const apart = alternatesOf(candidates, context);
	const twins = new Map<string, string>();
	for (const candidate of candidates) {
		const hash = bodyHash(candidate);
		if (hash !== "") twins.set(candidate.page.pageKey, hash);
	}
	const similarity = thresholdsOf(context).nearDuplicatePercent / 100;
	const near = nearDuplicatesOf(candidates, apart, similarity);
	const cluster = new Map(near.map((entry) => [entry.pageKey, entry.cluster]));
	const nearlySame = (left: string, right: string): boolean => {
		const twin = twins.get(left);
		if (twin !== undefined && twin === twins.get(right)) return true;
		const group = cluster.get(left);
		return group !== undefined && group === cluster.get(right);
	};
	const languageOf = new Map(candidates.map((c) => [c.page.pageKey, c.language]));
	const contained = containedOf(
		candidates,
		context,
		(left, right) =>
			nearlySame(left, right) ||
			(apart.get(left)?.has(right) ?? false) ||
			languagesApart(languageOf.get(left), languageOf.get(right)),
		similarity
	);
	const containedWith = new Set(
		contained.flatMap((pair) => [
			`${pair.inner}\u0000${pair.outer}`,
			`${pair.outer}\u0000${pair.inner}`
		])
	);
	const sameText = (left: string, right: string): boolean =>
		nearlySame(left, right) || containedWith.has(`${left}\u0000${right}`);
	const sameSeries = seriesOf(candidates, context);
	const textOrSeries = (left: string, right: string): boolean =>
		sameText(left, right) || sameSeries(left, right);
	const found = [
		...exactGroups(candidates, (c) => c.title, "duplicate_title", apart, textOrSeries),
		...exactGroups(candidates, (c) => c.desc, "duplicate_meta_description", apart, textOrSeries),
		...exactGroups(candidates, (c) => c.h1, "h1_duplicate", apart, sameText),
		...exactGroups(candidates, bodyHash, "duplicate_body", apart),
		...nearDuplicateFindings(near, contained),
		...untranslatedFindings(candidates, context)
	];
	const descriptions = new Map<string, number>();
	for (const candidate of candidates)
		descriptions.set(candidate.desc, (descriptions.get(candidate.desc) ?? 0) + 1);
	const byTemplate = new Map<string, string[]>();
	for (const candidate of candidates) {
		const template = templateOf(candidate);
		if (template === "" || (descriptions.get(candidate.desc) ?? 0) > 1) continue;
		const keys = byTemplate.get(template);
		if (keys === undefined) byTemplate.set(template, [candidate.page.pageKey]);
		else keys.push(candidate.page.pageKey);
	}
	for (const keys of byTemplate.values()) {
		if (keys.length < TEMPLATE_MIN_PAGES) continue;
		for (const key of keys) found.push(finding(key, "metadata_templated", { count: keys.length }));
	}
	return found;
}
