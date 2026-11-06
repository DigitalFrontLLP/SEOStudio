import { jsonLdText } from "../audit-schema";
import { countWords, wordsOf } from "../main-text";
import { READABILITY_MIN_WORDS } from "../readability";
import { parseBoundedJson } from "../structured-json";
import { CONTENT_THRESHOLDS } from "./content";
import { AUDIT_EXAMPLES, finding, indexableSnapshot } from "./page-state";
import type { AuditContext, AuditFinding, AuditPage, AuditSnapshot } from "./types";

/**
 * THE CONTENT INSIGHTS: facts about a page's headings, text and articles that are worth a filter but
 * are not problems by themselves (the catalog files them as insights, never counted against the
 * health score): an H1 that is very long or very short (in characters for one written mostly in
 * Chinese or Japanese), H2 headings missing, repeated or long, text
 * that is hard to read, an article that states no date or names no author, and alt texts that say
 * little (a paragraph over {@link ALT_MAX_CHARS} characters, a file name, a word that only says
 * "image", or a list of repeated keywords). An empty alt text marks a decorative image and is right.
 *
 * Judged only on pages search engines are asked to show. "Article" means the page's structured data
 * or its Open Graph type says so; a page with no such markup is never asked for a date or an author.
 */

/** The thresholds the content insights use. */
export const CONTENT_INSIGHT_THRESHOLDS = {
	h1MaxChars: 70,
	h1MaxWords: 10,
	h1MinWords: 3,
	/** Characters (spaces aside) over which an H1 written mostly in Chinese or Japanese is long. */
	h1MaxCjkChars: 35,
	/** Characters under which an H1 written mostly in Chinese or Japanese is short. */
	h1MinCjkChars: 4,
	h2MaxChars: 70,
	/** Reading ease below this is difficult; below `veryDifficultBelow`, very difficult. */
	difficultBelow: 50,
	veryDifficultBelow: 30
} as const;

/** A Chinese or Japanese character: those scripts write no spaces between words. */
const CJK_CHAR = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]$/u;

/**
 * Whether a heading is written mostly in Chinese or Japanese: most of its words (each such character
 * counting as one) are such characters, so its length is judged in characters, not words.
 *
 * @param text - The heading.
 * @returns Whether it is.
 */
function mostlyCjk(text: string): boolean {
	const words = wordsOf(text);
	return words.filter((word) => CJK_CHAR.test(word)).length * 2 > words.length;
}

/**
 * Whether an H1 is very long or very short: by words, or by characters for one written mostly in
 * Chinese or Japanese (where each character would count as a word, so a normal heading read as long).
 *
 * @param h1 - The H1, trimmed.
 * @returns The params to file, or null when its length is ordinary.
 */
function h1LengthParams(h1: string): Record<string, unknown> | null {
	const t = CONTENT_INSIGHT_THRESHOLDS;
	if (mostlyCjk(h1)) {
		const chars = [...h1.replace(/\s+/g, "")].length;
		return chars > t.h1MaxCjkChars || chars < t.h1MinCjkChars
			? { length: h1.length, words: countWords(h1), chars, script: "cjk" }
			: null;
	}
	const words = countWords(h1);
	return h1.length > t.h1MaxChars || words > t.h1MaxWords || words < t.h1MinWords
		? { length: h1.length, words }
		: null;
}

/** The schema.org types of an article page. */
const ARTICLE_TYPES: ReadonlySet<string> = new Set([
	"Article",
	"BlogPosting",
	"NewsArticle",
	"TechArticle",
	"ScholarlyArticle",
	"Report",
	"AnalysisNewsArticle",
	"OpinionNewsArticle",
	"ReportageNewsArticle",
	"ReviewNewsArticle",
	"BackgroundNewsArticle",
	"LiveBlogPosting",
	"SocialMediaPosting"
]);

/**
 * An alt text longer than this many characters is a paragraph, not a label: well past the sentence or
 * two a describing alt text runs to.
 */
export const ALT_MAX_CHARS = 250;

/** The most characters of an alt text an example shows. */
const ALT_EXAMPLE_CHARS = 100;

/** A keyword list: a word said this many times or more, making up this share of the alt text's words. */
const ALT_STUFFING = { repeats: 3, share: 0.25, listSegments: 4, segmentWords: 3 } as const;

/** An alt text that is only a file name (`IMG_0042.jpg`, `hero-banner.webp`) or a camera's name. */
const ALT_FILE_NAME =
	/^(?:[\w.\- ]+\.(?:jpe?g|png|gif|webp|avif|svg|bmp|tiff?|heic)|(?:img|dsc|dscn|pxl|dcim)[_-]?\d+)$/i;

/** Alt texts that only say the element is an image. */
const ALT_STOCK_WORDS: ReadonlySet<string> = new Set([
	"image",
	"img",
	"photo",
	"picture",
	"pic",
	"graphic",
	"photograph",
	"untitled",
	"placeholder"
]);

/** Why an alt text says little. */
type AltKind = "too_long" | "file_name" | "stock_word" | "keyword_list";

/**
 * Whether an alt text is a list of keywords rather than a description: one word repeated through it
 * ("red shoes, blue shoes, running shoes"), or a run of short comma-separated terms.
 *
 * @param text - The alt text.
 * @returns Whether it is.
 */
function keywordList(text: string): boolean {
	const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
		(word) => word.length >= 3
	);
	const counts = new Map<string, number>();
	for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
	for (const count of counts.values()) {
		if (count >= ALT_STUFFING.repeats && count / words.length >= ALT_STUFFING.share) return true;
	}
	const segments = text
		.split(/[,|;]/u)
		.map((segment) => segment.trim())
		.filter((segment) => segment !== "");
	return (
		segments.length >= ALT_STUFFING.listSegments &&
		segments.every((segment) => segment.split(/\s+/u).length <= ALT_STUFFING.segmentWords)
	);
}

/**
 * Why an image's alt text says little, or null when it is fine (or absent, or empty for a
 * decorative image: `images_missing_alt` and nothing are their checks).
 *
 * @param alt - The alt text as kept, or null.
 * @param length - Its full length.
 * @returns The reason, or null.
 */
function altProblem(alt: string | null, length: number): AltKind | null {
	const text = (alt ?? "").trim();
	if (text === "") return null;
	if (length > ALT_MAX_CHARS) return "too_long";
	if (ALT_FILE_NAME.test(text)) return "file_name";
	const word = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N} ]/gu, "")
		.trim();
	if (ALT_STOCK_WORDS.has(word)) return "stock_word";
	return keywordList(text) ? "keyword_list" : null;
}

/**
 * The page's images whose alt text says little: a paragraph, a file name, a stock word or a keyword
 * list.
 *
 * @param page - The page.
 * @returns The insight's params, or null when every alt text is fine.
 */
function altQuality(page: AuditPage): { count: number; kinds: AltKind[]; texts: string[] } | null {
	const kinds = new Set<AltKind>();
	const texts: string[] = [];
	let count = 0;
	for (const image of page.facts?.markup?.images ?? []) {
		const kind = altProblem(image.alt, image.altLength);
		if (kind === null) continue;
		count += 1;
		kinds.add(kind);
		if (texts.length < AUDIT_EXAMPLES)
			texts.push((image.alt ?? "").trim().slice(0, ALT_EXAMPLE_CHARS));
	}
	return count === 0 ? null : { count, kinds: [...kinds].sort(), texts };
}

/** The deepest a JSON-LD value is walked. */
const MAX_DEPTH = 12;

/**
 * How many article items the page states at its top level: each JSON-LD root item (or `@graph`
 * entry) and each microdata or RDFa item of an article type. A page that states several is a list of
 * articles (a blog's home, an archive, a tag page), not an article.
 *
 * @param page - The page.
 * @returns The count.
 */
function listedArticles(page: AuditPage): number {
	const roots: unknown[] = [];
	for (const block of page.facts?.jsonLd ?? []) {
		if (block.text === null) continue;
		const parsed = parseBoundedJson(jsonLdText(block.text));
		if (parsed.kind !== "value") continue;
		const top = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
		for (const item of top) {
			if (isRecord(item) && Array.isArray(item["@graph"])) roots.push(...item["@graph"]);
			else roots.push(item);
		}
	}
	for (const item of page.facts?.markup?.structuredItems ?? []) {
		const parsed = parseBoundedJson(item.json);
		if (parsed.kind === "value") roots.push(parsed.value);
	}
	return roots.filter(
		(item) => isRecord(item) && typesOf(item).some((type) => ARTICLE_TYPES.has(type))
	).length;
}

/**
 * Whether a page is an article, by its structured data types or its Open Graph type; a page listing
 * several articles is not one.
 *
 * @param page - The page.
 * @param snapshot - Its snapshot.
 * @returns Whether it is.
 */
function isArticle(page: AuditPage, snapshot: AuditSnapshot): boolean {
	if (listedArticles(page) > 1) return false;
	if ((snapshot.schemaTypes ?? []).some((type) => ARTICLE_TYPES.has(type))) return true;
	return (page.facts?.markup?.openGraph.type ?? "").trim().toLowerCase() === "article";
}

/**
 * The `@type` names of a JSON-LD item.
 *
 * @param item - The item.
 * @returns Its types, the schema.org prefix cut.
 */
function typesOf(item: Record<string, unknown>): string[] {
	const raw = item["@type"];
	const list = Array.isArray(raw) ? raw : [raw];
	return list
		.filter((type): type is string => typeof type === "string")
		.map((type) => type.replace(/^(?:https?:\/\/)?schema\.org\//u, ""));
}

/**
 * Whether a JSON-LD value is an object (not a list).
 *
 * @param value - The value.
 * @returns Whether it is one.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a JSON-LD value names someone: a non-empty string, or an object or list holding one.
 *
 * @param value - The value.
 * @returns Whether it does.
 */
function names(value: unknown): boolean {
	if (typeof value === "string") return value.trim() !== "";
	if (Array.isArray(value)) return value.some(names);
	return isRecord(value) && Object.keys(value).length > 0;
}

/**
 * Whether the page's JSON-LD holds an article item without an author: true when it does, false when
 * every article item names one, null when no article item is in its JSON-LD.
 *
 * @param page - The page.
 * @returns The verdict.
 */
function articleWithoutAuthor(page: AuditPage): boolean | null {
	let articles = 0;
	let unnamed = 0;
	const walk = (value: unknown, depth: number): void => {
		if (depth > MAX_DEPTH) return;
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry, depth + 1);
			return;
		}
		if (!isRecord(value)) return;
		if (typesOf(value).some((type) => ARTICLE_TYPES.has(type))) {
			articles += 1;
			if (!names(value.author) && !names(value.creator)) unnamed += 1;
		}
		for (const entry of Object.values(value)) walk(entry, depth + 1);
	};
	for (const block of page.facts?.jsonLd ?? []) {
		if (block.text === null) continue;
		const parsed = parseBoundedJson(jsonLdText(block.text));
		if (parsed.kind === "value") walk(parsed.value, 0);
	}
	return articles === 0 ? null : unnamed > 0;
}

/**
 * The H2 facts of a heading outline: how many, how many repeat another, how many are long.
 *
 * @param snapshot - The page's snapshot.
 * @returns The counts.
 */
function h2Counts(snapshot: AuditSnapshot): { count: number; repeated: number; long: number } {
	const texts = (snapshot.headings ?? [])
		.filter((heading) => heading.level === 2)
		.map((heading) => heading.text.trim().toLowerCase())
		.filter((text) => text !== "");
	const seen = new Set<string>();
	let repeated = 0;
	for (const text of texts) {
		if (seen.has(text)) repeated += 1;
		seen.add(text);
	}
	const long = texts.filter((text) => text.length > CONTENT_INSIGHT_THRESHOLDS.h2MaxChars).length;
	return { count: texts.length, repeated, long };
}

/**
 * The content insights of one page.
 *
 * @param page - The page.
 * @param context - The audit.
 * @returns Its insights.
 */
export function contentInsightFindings(page: AuditPage, context: AuditContext): AuditFinding[] {
	const snapshot = indexableSnapshot(page, context);
	if (snapshot === null) return [];
	const key = page.pageKey;
	const t = CONTENT_INSIGHT_THRESHOLDS;
	const found: AuditFinding[] = [];

	const h1 = (snapshot.h1 ?? "").trim();
	const h1Length = h1 === "" ? null : h1LengthParams(h1);
	if (h1Length !== null) found.push(finding(key, "h1_length", h1Length));

	if (snapshot.headings != null) {
		const h2 = h2Counts(snapshot);
		const missing = h2.count === 0 && (snapshot.wordCount ?? 0) >= CONTENT_THRESHOLDS.thinWords;
		if (missing || h2.repeated > 0 || h2.long > 0) found.push(finding(key, "h2_facts", h2));
	}

	const readability = page.facts?.text?.readability ?? null;
	if (
		readability !== null &&
		readability.score < t.difficultBelow &&
		(snapshot.wordCount ?? 0) >= READABILITY_MIN_WORDS
	) {
		found.push(
			finding(key, "readability_difficult", {
				score: readability.score,
				band: readability.score < t.veryDifficultBelow ? "very_difficult" : "difficult",
				language: readability.language
			})
		);
	}

	if (isArticle(page, snapshot)) {
		if (snapshot.datePublished === null && snapshot.dateModified === null)
			found.push(finding(key, "content_date_missing"));
		if (articleWithoutAuthor(page) === true) found.push(finding(key, "eeat_signals"));
	}
	const alts = altQuality(page);
	if (alts !== null) found.push(finding(key, "image_alt_quality", alts));
	return found;
}
