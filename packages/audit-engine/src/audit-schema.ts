import type { SeoPageJsonLdBlock, SeoPageMarkupItem } from "./facts";

import type { SeoAuditRuleId } from "./catalog";
import { SEO_RETIRED_SCHEMA_TYPES } from "./rich-results-table";
import { richResultGaps } from "./schema-rich-results";
import { contextTerms, schemaVocabularyIssues } from "./schema-validate";
import type { SchemaVocabularyIssue } from "./schema-validate";
import { indexIds, isJsonObject, parseBoundedJson, spend, walkBudget } from "./structured-json";
import type { JsonObject, WalkBudget } from "./structured-json";

/**
 * THE STRUCTURED DATA RULES: a page's JSON-LD, microdata and RDFa, checked the way Google reads them.
 * Pure: it reads the blocks the crawl kept (`seo_pages.audit_facts.jsonLd`) and the microdata and RDFa
 * items of the markup facts (both read from the rendered page whenever the browser rendered it), and
 * returns findings. Bounded: every block is measured before it is parsed and every walk spends one page
 * budget (`./structured-json`); a block past a bound is reported as too large, never as broken.
 *
 * TUNED TO FLAG ONLY REAL PROBLEMS:
 * - a block is invalid only when it is not JSON once the comment and CDATA wrappers some CMSs add are
 *   stripped (Google strips them too); an empty block is ignored;
 * - `@context` and `@type` are required only of the items Google reads (top-level items and `@graph`
 *   members), never of nested values, and a bare `{"@id"}` reference needs neither;
 * - the schema.org vocabulary check judges only schema.org terms (`./schema-validate`);
 * - required and recommended properties are checked only for the types Google shows a rich result for,
 *   from Google's own tables (`./rich-results-table`); a missing recommended property is an insight;
 * - a retired type is a notice: the markup is harmless, it just earns no rich result any more.
 */

/** One structured data finding on a page. */
export interface SchemaFinding {
	ruleId: SeoAuditRuleId;
	params: Record<string, unknown>;
}

/** The properties whose values must be absolute URLs. */
const URL_PROPERTIES = new Set(["url", "image", "logo", "thumbnailUrl", "contentUrl", "sameAs"]);

/**
 * Values that are template text rather than content. Every pattern is linear on any text; the
 * bracketed tags (`{{name}}`, `${name}`, `[insert name]`), whose pattern would rescan the text from
 * every opening bracket, are found by {@link hasTemplateTag} instead.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
	/lorem ipsum/i,
	/%%[a-z_]+%%/i,
	/\bTODO\b/,
	/^https?:\/\/(?:www\.)?example\.(?:com|org|net)(?:[/?#]|$)/i,
	/^(?:undefined|null|nan|\[object object\])$/i,
	/^(?:your (?:company|business|brand)(?: name)?|company name|product name|business name)$/i
];

/** How deep the walk for placeholders and relative URLs goes. */
const MAX_DEPTH = 8;

/** How many examples one finding names. */
const EXAMPLES = 5;

/** The words that open a bracketed placeholder (`[insert name]`, `[your logo]`). */
const BRACKET_WORDS = ["insert", "your"] as const;

/**
 * Whether a character is a word character (`\w`).
 *
 * @param char - The character, or undefined past the end.
 * @returns Whether it is one.
 */
function wordChar(char: string | undefined): boolean {
	return char !== undefined && /\w/.test(char);
}

/**
 * Whether a text holds a template tag: `{{...}}` with no `}` inside, `${...}`, or `[insert ...]` /
 * `[your ...]` closed by a `]`. One pass: each opening bracket is looked at once, and whether a
 * closing bracket follows is read from where the last one sits.
 *
 * @param text - The text.
 * @returns Whether it holds one.
 */
function hasTemplateTag(text: string): boolean {
	let open = text.indexOf("{{");
	while (open !== -1) {
		const close = text.indexOf("}", open + 2);
		if (close === -1) break;
		if (text[close + 1] === "}") return true;
		open = text.indexOf("{{", close + 1);
	}
	const dollar = text.indexOf("${");
	if (dollar !== -1 && text.includes("}", dollar + 2)) return true;
	const lastClose = text.lastIndexOf("]");
	let bracket = text.indexOf("[");
	while (bracket !== -1 && bracket < lastClose) {
		let start = bracket + 1;
		while (start < text.length && /\s/.test(text.charAt(start))) start += 1;
		for (const word of BRACKET_WORDS) {
			const end = start + word.length;
			if (text.slice(start, end).toLowerCase() === word && !wordChar(text[end]) && lastClose >= end)
				return true;
		}
		bracket = text.indexOf("[", bracket + 1);
	}
	return false;
}

/**
 * A block's text with the wrappers some CMSs put around JSON-LD removed (HTML comments, CDATA).
 *
 * @param text - The raw block.
 * @returns The JSON text.
 */
export function jsonLdText(text: string): string {
	return text
		.trim()
		.replace(/^(?:<!--|\/\*\s*<!\[CDATA\[\s*\*\/|\/\/\s*<!\[CDATA\[|<!\[CDATA\[)/, "")
		.replace(/(?:-->|\/\*\s*\]\]>\s*\*\/|\/\/\s*\]\]>|\]\]>)$/, "")
		.trim();
}

/** Whether a value is a JSON object. */
const isObject = isJsonObject;

/**
 * An item's types, the vocabulary prefix dropped (`schema:Product`, `https://schema.org/Product`).
 *
 * @param item - The item.
 * @returns Its type names.
 */
function typesOf(item: JsonObject): string[] {
	const raw = item["@type"];
	const list = Array.isArray(raw) ? raw : [raw];
	return list
		.filter((value): value is string => typeof value === "string" && value.trim() !== "")
		.map((value) => value.trim().replace(/^.*[/:#]/, ""));
}

/**
 * Whether a property holds a value.
 *
 * @param value - The property's value.
 * @returns Whether it is present and not empty.
 */
function present(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return value.trim() !== "";
	if (Array.isArray(value)) return value.length > 0;
	return true;
}

/**
 * Whether a JSON-LD `@context` names schema.org.
 *
 * @param context - The context value.
 * @returns Whether it does.
 */
function schemaOrgContext(context: unknown): boolean {
	if (typeof context === "string") return /schema\.org/i.test(context);
	if (Array.isArray(context)) return context.some(schemaOrgContext);
	if (isObject(context)) return Object.values(context).some(schemaOrgContext);
	return false;
}

/** What one walk collects. */
interface Walk {
	/** The first examples, and how many there are in all. */
	placeholders: { type: string; property: string; value: string }[];
	placeholderCount: number;
	relative: { type: string; property: string; value: string }[];
	relativeCount: number;
	/** The values the walk may still visit. */
	budget: WalkBudget;
}

/**
 * Walks an item for placeholder text and relative URLs.
 *
 * @param value - The value under the item.
 * @param type - The nearest enclosing type.
 * @param property - The property holding the value.
 * @param depth - How deep the walk is.
 * @param into - What it collects.
 */
function walk(value: unknown, type: string, property: string, depth: number, into: Walk): void {
	if (depth > MAX_DEPTH || !spend(into.budget)) return;
	if (Array.isArray(value)) {
		for (const entry of value) walk(entry, type, property, depth + 1, into);
		return;
	}
	if (isObject(value)) {
		const own = typesOf(value)[0] ?? type;
		for (const [key, entry] of Object.entries(value)) {
			if (key === "@context" || key === "@type" || key === "@id") continue;
			walk(entry, own, key, depth + 1, into);
		}
		return;
	}
	if (typeof value !== "string") return;
	const text = value.trim();
	if (text === "") return;
	if (hasTemplateTag(text) || PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) {
		into.placeholderCount += 1;
		if (into.placeholders.length < EXAMPLES)
			into.placeholders.push({ type, property, value: text.slice(0, 120) });
	}
	if (
		URL_PROPERTIES.has(property) &&
		!/^(?:https?:)?\/\//i.test(text) &&
		!/^(?:data|mailto|tel):/i.test(text) &&
		!text.startsWith("#")
	) {
		into.relativeCount += 1;
		if (into.relative.length < EXAMPLES)
			into.relative.push({ type, property, value: text.slice(0, 200) });
	}
}

/** One item the vocabulary and rich result checks read, with the terms its context defines itself. */
interface SchemaItem {
	item: JsonObject;
	ownTerms: ReadonlySet<string>;
}

/** What reading a page's JSON-LD blocks gave. */
interface JsonLdRead {
	invalid: number;
	noContext: number;
	noType: number;
	truncated: boolean;
	/** The items Google reads as schema.org (top-level items and `@graph` members). */
	items: SchemaItem[];
}

/**
 * Reads a page's JSON-LD blocks within the bounds.
 *
 * @param blocks - The blocks as kept.
 * @returns What they hold.
 */
function readJsonLd(blocks: readonly SeoPageJsonLdBlock[]): JsonLdRead {
	const read: JsonLdRead = { invalid: 0, noContext: 0, noType: 0, truncated: false, items: [] };
	for (const block of blocks) {
		if (block.text === null) {
			read.truncated = true;
			continue;
		}
		const text = jsonLdText(block.text);
		if (text === "") continue;
		const parsed = parseBoundedJson(text);
		if (parsed.kind === "invalid") read.invalid += 1;
		if (parsed.kind === "too_large") read.truncated = true;
		if (parsed.kind !== "value") continue;
		const roots = (Array.isArray(parsed.value) ? parsed.value : [parsed.value]).filter(isObject);
		for (const root of roots) {
			const graph = Array.isArray(root["@graph"]) ? root["@graph"].filter(isObject) : [];
			const items = graph.length > 0 ? graph : [root];
			const context = root["@context"];
			if (!present(context) && !items.every((item) => typesOf(item).length === 0))
				read.noContext += 1;
			if (present(context) && !schemaOrgContext(context)) continue;
			const ownTerms = contextTerms(context);
			for (const item of items) {
				const reference = Object.keys(item).every((key) => key === "@id" || key === "@context");
				if (typesOf(item).length === 0) {
					if (!reference) read.noType += 1;
					continue;
				}
				read.items.push({ item, ownTerms });
			}
		}
	}
	return read;
}

/**
 * The microdata and RDFa items a page's markup holds, parsed.
 *
 * @param markup - The items as kept.
 * @returns The items.
 */
function markupItems(markup: readonly SeoPageMarkupItem[]): SchemaItem[] {
	const items: SchemaItem[] = [];
	for (const entry of markup) {
		const parsed = parseBoundedJson(entry.json);
		if (parsed.kind === "value" && isObject(parsed.value))
			items.push({ item: parsed.value, ownTerms: new Set() });
	}
	return items;
}

/**
 * The retired types an item uses: its own types, and a `WebSite`'s sitelinks search box.
 *
 * @param item - The item.
 * @returns The retired type names.
 */
function retiredTypesOf(item: JsonObject): string[] {
	const names = typesOf(item);
	if (names.includes("WebSite")) {
		const actions = Array.isArray(item.potentialAction)
			? item.potentialAction
			: [item.potentialAction];
		if (actions.some((action) => isObject(action) && typesOf(action).includes("SearchAction")))
			names.push("SearchAction");
	}
	return names.filter((name) => Object.hasOwn(SEO_RETIRED_SCHEMA_TYPES, name));
}

/**
 * The structured data findings of one page.
 *
 * @param blocks - The page's JSON-LD blocks as kept.
 * @param markup - Its microdata and RDFa items, and whether their read was cut short.
 * @returns The findings, at most one per rule.
 */
export function schemaFindings(
	blocks: readonly SeoPageJsonLdBlock[],
	markup: { items?: readonly SeoPageMarkupItem[]; truncated?: boolean } = {}
): SchemaFinding[] {
	const jsonLd = readJsonLd(blocks);
	const items = [...jsonLd.items, ...markupItems(markup.items ?? [])];
	const budget = walkBudget();
	const ids = indexIds(
		items.map((entry) => entry.item),
		budget
	);
	const gaps = richResultGaps(
		items.map((entry) => entry.item),
		ids,
		budget
	);
	const retired = new Map<string, { type: string; since: string; reason: string }>();
	const vocabulary: SchemaVocabularyIssue[] = [];
	const vocabularyBudget = walkBudget();
	for (const entry of items) {
		for (const type of retiredTypesOf(entry.item)) {
			const gone = SEO_RETIRED_SCHEMA_TYPES[type];
			if (gone !== undefined) retired.set(type, { type, ...gone });
		}
		if (vocabulary.length < EXAMPLES * 10)
			vocabulary.push(...schemaVocabularyIssues(entry.item, entry.ownTerms, vocabularyBudget));
	}
	const collected: Walk = {
		placeholders: [],
		placeholderCount: 0,
		relative: [],
		relativeCount: 0,
		budget: walkBudget()
	};
	for (const entry of jsonLd.items)
		walk(entry.item, typesOf(entry.item)[0] ?? "", "", 0, collected);
	const found: SchemaFinding[] = [];
	if (jsonLd.invalid > 0)
		found.push({ ruleId: "schema_invalid_json", params: { count: jsonLd.invalid } });
	if (jsonLd.noContext > 0)
		found.push({ ruleId: "schema_missing_context", params: { count: jsonLd.noContext } });
	if (jsonLd.noType > 0)
		found.push({ ruleId: "schema_missing_type", params: { count: jsonLd.noType } });
	if (vocabulary.length > 0) {
		found.push({
			ruleId: "schema_vocabulary_invalid",
			params: { count: vocabulary.length, items: vocabulary.slice(0, EXAMPLES) }
		});
	}
	if (gaps.required.length > 0) {
		found.push({
			ruleId: "schema_missing_required",
			params: { count: gaps.required.length, items: gaps.required.slice(0, EXAMPLES) }
		});
	}
	if (gaps.recommended.length > 0) {
		found.push({
			ruleId: "schema_missing_recommended",
			params: { count: gaps.recommended.length, items: gaps.recommended.slice(0, EXAMPLES) }
		});
	}
	if (collected.placeholderCount > 0) {
		found.push({
			ruleId: "schema_placeholder",
			params: {
				count: collected.placeholderCount,
				items: collected.placeholders.slice(0, EXAMPLES)
			}
		});
	}
	if (collected.relativeCount > 0) {
		found.push({
			ruleId: "schema_relative_url",
			params: { count: collected.relativeCount, items: collected.relative.slice(0, EXAMPLES) }
		});
	}
	if (retired.size > 0) {
		found.push({ ruleId: "schema_retired_type", params: { types: [...retired.values()] } });
	}
	if (
		jsonLd.truncated ||
		markup.truncated === true ||
		budget.exhausted ||
		vocabularyBudget.exhausted ||
		collected.budget.exhausted
	) {
		found.push({ ruleId: "structured_data_truncated", params: {} });
	}
	return found;
}

/**
 * Every type a page's structured data names, at any depth (an `Article` held as a `WebPage`'s
 * `mainEntity` counts), within the walk's bounds.
 *
 * @param blocks - The page's JSON-LD blocks as kept.
 * @param markup - Its microdata and RDFa items.
 * @returns The type names, the vocabulary prefix dropped.
 */
export function schemaTypesDeep(
	blocks: readonly SeoPageJsonLdBlock[],
	markup: readonly SeoPageMarkupItem[] = []
): Set<string> {
	const types = new Set<string>();
	const budget = walkBudget();
	const visit = (value: unknown, depth: number): void => {
		if (depth > MAX_DEPTH || !spend(budget)) return;
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry, depth + 1);
			return;
		}
		if (!isObject(value)) return;
		for (const type of typesOf(value)) types.add(type);
		for (const [key, entry] of Object.entries(value)) {
			if (key !== "@context" && key !== "@type" && key !== "@id") visit(entry, depth + 1);
		}
	};
	for (const { item } of [...readJsonLd(blocks).items, ...markupItems(markup)]) visit(item, 0);
	return types;
}
